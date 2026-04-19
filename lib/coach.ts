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

export class ClaudeCoach implements CoachLLM {
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

    const data: { result: CoachResponse } = await res.json();
    return data.result;
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
