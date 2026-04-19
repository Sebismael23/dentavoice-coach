// -----------------------------------------------------------------------------
// Coach client — browser-side wrapper around the /api/coach server route
// -----------------------------------------------------------------------------
// Implements the CoachLLM interface. Currently ClaudeCoach is the only impl,
// but the interface lets us swap in GPT/Gemini later without touching UI code.
// -----------------------------------------------------------------------------

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

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed === null) return null;
    if (
      typeof parsed.signal === 'string' &&
      typeof parsed.move === 'string' &&
      typeof parsed.say === 'string' &&
      typeof parsed.why === 'string'
    ) {
      return parsed as CoachResponse;
    }
    console.warn('[coach] unrecognized response shape', parsed);
    return null;
  } catch (err) {
    console.error('[coach] JSON parse failed', err, { text: cleaned });
    return null;
  }
}

/**
 * Extract the `say` value from a partial JSON stream.
 * Since we prompt Claude to output `say` as the FIRST field, we can grab it
 * before the full JSON is complete. Looks for: {"say": "..."
 * Returns the say value as soon as the closing quote is found.
 */
function extractPartialSay(partial: string): string | null {
  // Match: "say": "<value>" — handles escaped quotes inside the value
  const match = partial.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

export class ClaudeCoach implements CoachLLM {
  /** Optional callback: fires as soon as the `say` field is fully streamed,
   *  BEFORE the rest of the JSON (move/signal/why) is complete.
   *  This lets CallSession render the hint ~1s earlier. */
  onEarlySay?: (say: string) => void;

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
    recentHintSays,
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
    recentHintSays?: string[];
  }): Promise<CoachResponse> {
    const res = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, lastHintAt, callContext, transferredToDM, lastHintSay, callPhase, usedPlayIds, consecutiveNulls, currentThread, recentHintSays }),
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
    let earlySayFired = false;

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

      // Try to extract `say` early — fires callback as soon as the say field is complete
      if (!earlySayFired && this.onEarlySay) {
        const earlySay = extractPartialSay(accumulated);
        if (earlySay) {
          earlySayFired = true;
          this.onEarlySay(earlySay);
        }
      }
    }

    return parseCoachResponse(accumulated);
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
