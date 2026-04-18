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
  }: {
    transcript: TranscriptSegment[];
    lastHintAt: number | null;
    callContext?: string;
    transferredToDM?: TransferTarget;
    lastHintSay?: string;
    callPhase?: 'gatekeeper' | 'dm';
  }): Promise<CoachResponse> {
    const res = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, lastHintAt, callContext, transferredToDM, lastHintSay, callPhase }),
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
 * Resolve a CoachResponse into a fully-rendered hint by looking up the play
 * in the playbook and substituting personalization slots.
 *
 * This is the bridge between "LLM picked a number" and "words on screen".
 */
export function resolveHint(
  response: CoachResponse,
  plays: Play[]
): RenderedHint | null {
  if (response === null) return null;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (response.action === 'generate') {
    return {
      id,
      timestamp: Date.now(),
      say: response.say,
      move: response.move,
      signal: response.signal,
      source: 'generate',
    };
  }

  // Play action — look up the play and render it
  const play = plays.find((p) => p.id === response.play_id);
  if (!play) {
    // LLM hallucinated a play_id. Skip gracefully.
    console.warn('[coach] unknown play_id', response.play_id);
    return null;
  }

  let say = play.say;
  const p = response.personalize;

  // Substitute personalization slots. Unfilled slots get sensible defaults.
  say = say.replace(/\{their_name\}/g, p.their_name?.trim() || 'there');
  say = say.replace(/\{mirror_word\}/g, p.mirror_word?.trim() || '');
  say = say.replace(/\{specific_pain\}/g, p.specific_pain?.trim() || '');

  // Clean up any double spaces from empty substitutions
  say = say.replace(/\s+/g, ' ').trim();

  return {
    id,
    timestamp: Date.now(),
    say,
    move: play.tactic,
    signal: response.signal,
    source: 'play',
    playId: play.id,
    confidence: response.confidence,
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

  return true;
}
