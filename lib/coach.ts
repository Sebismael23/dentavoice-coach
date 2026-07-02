// -----------------------------------------------------------------------------
// Coach client — browser-side wrapper around the /api/coach server route
// -----------------------------------------------------------------------------
// Implements the CoachLLM interface. Currently ClaudeCoach is the only impl,
// but the interface lets us swap in GPT/Gemini later without touching UI code.
// -----------------------------------------------------------------------------

import type { LadderGates } from './ladder';
import type {
  CoachLLM,
  CoachResponse,
  Play,
  RenderedHint,
  TranscriptSegment,
  TransferTarget,
} from './types';

/**
 * Parse Claude's raw text into a CoachResponse.
 * Handles markdown fences, trailing prose, etc.
 */
function parseCoachResponse(text: string): CoachResponse {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (cleaned === 'null' || cleaned === '') return null;

  let jsonStr = cleaned;
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > firstBrace) jsonStr = cleaned.slice(firstBrace, end + 1);
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      parsed = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    } catch (e) {
      console.warn('[coach] JSON parse failed after repair', { raw: jsonStr.slice(0, 200) });
      return null;
    }
  }
  if (parsed === null) return null;
  if (typeof parsed.say === 'string' && parsed.say.trim().length > 0) {
    return {
      say: parsed.say,
      move: typeof parsed.move === 'string' ? parsed.move : '',
      signal: typeof parsed.signal === 'string' ? parsed.signal : '',
      why: typeof parsed.why === 'string' ? parsed.why : '',
      play_id: typeof parsed.play_id === 'number' ? parsed.play_id : null,
      thread: parsed.thread ?? null,
      step: parsed.step ?? null,
    };
  }
  console.warn('[coach] unrecognized response shape', parsed);
  return null;
}

/**
 * Extract the `say` value from a partial JSON stream — PROGRESSIVELY.
 * Since we prompt Claude to output `say` as the FIRST field, we can render it
 * word-by-word as it streams, long before the full JSON is complete.
 * Returns the text seen so far and whether the closing quote has arrived.
 */
export function extractSayProgress(
  partial: string
): { text: string; complete: boolean } | null {
  // Match: "say": "<value-so-far> — handles escaped quotes inside the value
  const m = partial.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  const text = m[1].replace(/\\(.)/g, '$1');
  const rest = partial.slice((m.index ?? 0) + m[0].length);
  return { text, complete: rest.startsWith('"') };
}

export class ClaudeCoach implements CoachLLM {
  /** Optional callback: fires REPEATEDLY as the `say` field streams in,
   *  word by word, BEFORE the rest of the JSON (move/signal/why) arrives.
   *  `complete` flips true once the closing quote is seen.
   *  This puts the first words on screen ~1-2s earlier than waiting for
   *  the full response. */
  onSayProgress?: (say: string, complete: boolean) => void;

  async getHint({
    transcript,
    lastHintAt,
    callContext,
    transferredToDM,
    lastHintSay,
    callPhase,
    usedPlayIds,
    consecutiveNulls,
    currentThread,
    currentStep,
    recentHintSays,
    gates,
    signal,
  }: {
    transcript: TranscriptSegment[];
    lastHintAt: number | null;
    callContext?: string;
    transferredToDM?: TransferTarget;
    lastHintSay?: string;
    callPhase?: 'gatekeeper' | 'dm';
    usedPlayIds?: number[];
    consecutiveNulls?: number;
    currentThread?: string;
    currentStep?: string;
    recentHintSays?: string[];
    /** Deterministic ladder gates — computed in code, injected as hard constraints. */
    gates?: LadderGates;
    /** Abort an in-flight request when fresher prospect speech supersedes it. */
    signal?: AbortSignal;
  }): Promise<CoachResponse> {
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ transcript, lastHintAt, callContext, transferredToDM, lastHintSay, callPhase, usedPlayIds, consecutiveNulls, currentThread, currentStep, recentHintSays, gates }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Coach API ${res.status}: ${body || res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        const data = await res.json();
        return data.result;
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let lastEmittedSay = '';
      let sayComplete = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]' || !payload) continue;
          try {
            const msg = JSON.parse(payload);
            if (msg.error) throw new Error(msg.error);
            if (msg.t) accumulated += msg.t;
          } catch {}
        }

        // Stream the `say` field progressively — fire on every growth
        if (this.onSayProgress && !sayComplete) {
          const progress = extractSayProgress(accumulated);
          if (progress && (progress.text !== lastEmittedSay || progress.complete)) {
            lastEmittedSay = progress.text;
            if (progress.complete) sayComplete = true;
            this.onSayProgress(progress.text, progress.complete);
          }
        }
      }

      return parseCoachResponse(accumulated);
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return null; // superseded by fresher speech — expected, not an error
      }
      throw err;
    }
  }
}

/**
 * Resolve a CoachResponse into a fully-rendered hint.
 * Now Claude generates the actual words — we just pass them through.
 */
export function resolveHint(
  response: CoachResponse,
  plays: Play[]
): RenderedHint | null {
  if (response === null) return null;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    timestamp: Date.now(),
    say: response.say,
    move: response.move,
    signal: response.signal,
    why: response.why,
    source: 'coach',
    playId: response.play_id ?? undefined,
  };
}

/**
 * Decide whether it's worth calling the coach API right now.
 * Debouncing logic kept here (not in the server) so we don't waste API calls.
 */
export function shouldAskCoach(params: {
  transcript: TranscriptSegment[];
  lastCallAt: number | null;
  minIntervalMs: number;
  forceNext?: boolean;
}): boolean {
  const { transcript, lastCallAt, minIntervalMs, forceNext } = params;

  // Force flag bypasses all debouncing (used after transfer)
  if (forceNext) return true;

  const now = Date.now();

  // Always wait min interval since last call
  if (lastCallAt && now - lastCallAt < minIntervalMs) return false;

  // Require at least one final segment from anyone
  const finalSegs = transcript.filter((s) => s.isFinal);
  if (finalSegs.length === 0) return false;

  // Someone must have spoken recently (30s window — covers pauses, hold music, etc.)
  const mostRecent = finalSegs[finalSegs.length - 1];
  if (!mostRecent) return false;
  if (now - mostRecent.timestamp > 30_000) return false; // stale

  // Don't coach while Seb is talking — wait for prospect's turn
  const lastProspect = [...finalSegs].reverse().find((s) => s.speaker === 'prospect');
  if (!lastProspect) return false; // prospect hasn't spoken yet
  if (now - lastProspect.timestamp > 15_000) return false; // prospect speech is stale

  // If Seb spoke AFTER the last prospect segment, he's delivering a hint.
  // Wait for the prospect to respond before firing another hint.
  const lastMe = [...finalSegs].reverse().find((s) => s.speaker === 'me');
  if (lastMe && lastMe.timestamp > lastProspect.timestamp) {
    return false; // Seb is talking — wait for prospect's next turn
  }

  return true;
}
