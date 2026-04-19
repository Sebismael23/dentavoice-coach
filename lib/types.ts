// -----------------------------------------------------------------------------
// Core types for the DentaVoice Coach
// -----------------------------------------------------------------------------
// This file is the contract between all layers:
//   Audio capture → Deepgram → Transcript buffer → Coach LLM → HUD
// Every interface here is crossed by real data at runtime.
// -----------------------------------------------------------------------------

/** A single transcript segment from Deepgram. */
export interface TranscriptSegment {
  /** Unique id so React can key properly and we can dedupe. */
  id: string;
  /** Who spoke. channel 0 = prospect (tab audio), channel 1 = Seb (mic). */
  speaker: 'prospect' | 'me';
  /** What they said. */
  text: string;
  /** Epoch ms when the segment was finalized. */
  timestamp: number;
  /** Is this a final (committed) segment or an interim (may change)? */
  isFinal: boolean;
}

/** A single play in the playbook. Static reference data. */
export interface Play {
  id: number;
  name: string;
  stage: 'opening' | 'diagnostic' | 'pitch' | 'objection' | 'close';
  tactic: string;
  /** Phrases in prospect's speech that hint this play applies. */
  triggers: string[];
  /** The exact words Seb should say. Never rewritten by the LLM. */
  say: string;
  /** Placeholders in `say` the LLM can fill. e.g. "{their_name}" */
  personalization_slots: string[];
  /** Plays that often come next. For Seb's reference, not used by app logic. */
  followup_play_hints: number[];
  notes?: string;
}

/**
 * Diagnostic thread the prospect has opened, if detected.
 * Persists across coaching requests so the coach stays in-thread.
 */
export type DiagnosticThread =
  | 'people'
  | 'money'
  | 'chaos'
  | 'doctor'
  | 'revenue'
  | 'unknown';

/** What the LLM returns. A coaching response with analysis, or silence. */
export type CoachResponse =
  | {
      /** What the prospect just revealed or signaled. */
      signal: string;
      /** The tactic/strategy being used (e.g. "mirror", "label", "gap question"). */
      move: string;
      /** The exact words Seb should say — contextual, adapted to THIS conversation. */
      say: string;
      /** Which playbook play inspired this (if any). For tracking only. */
      play_id?: number | null;
      /** Brief coaching note — WHY this move, what to watch for. */
      why: string;
      /** The active diagnostic thread. */
      thread?: DiagnosticThread | null;
    }
  | null;

/** Resolved hint ready to render on the HUD. */
export interface RenderedHint {
  /** Unique id per hint instance — for animation keys. */
  id: string;
  /** When the hint was generated. */
  timestamp: number;
  /** The exact words to speak. Main HUD display. */
  say: string;
  /** Tactic name — small metadata line. */
  move: string;
  /** What the LLM noticed — even smaller metadata line. */
  signal: string;
  /** Coaching reasoning — why this move, what to watch for. */
  why: string;
  /** For styling. */
  source: 'coach';
  /** Which play inspired this, if any. */
  playId?: number;
}

/**
 * User-provided context about the call, entered before the session starts.
 * This dramatically improves the LLM's early-call coaching since there's no
 * transcript to infer from yet.
 *
 * Example values: "Gatekeeper at Sunny Smiles Dental", "Office Manager Sarah,
 * scheduled callback from last Thursday", "Dr. Johnson direct, voicemail likely".
 */
export type CallContext = string;

/** Who Seb got transferred to mid-call. */
export type TransferTarget = 'office_manager' | 'dentist';

/** Contract for any coaching model backend. Claude today, others later. */
export interface CoachLLM {
  /**
   * Ask the coach for a hint based on the current rolling transcript.
   * Returns null if the coach thinks silence is the right response.
   */
  getHint(params: {
    transcript: TranscriptSegment[];
    lastHintAt: number | null;
    callContext?: CallContext;
    transferredToDM?: TransferTarget;
  }): Promise<CoachResponse>;
}

/** State of the live call session. */
export type SessionState =
  | { status: 'idle' }
  | { status: 'setting_up' }
  | { status: 'active'; startedAt: number }
  | { status: 'ended'; startedAt: number; endedAt: number }
  | { status: 'error'; message: string };
