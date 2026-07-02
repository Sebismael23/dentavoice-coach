// -----------------------------------------------------------------------------
// LADDER — deterministic gate engine (the real anti-skip mechanism)
// -----------------------------------------------------------------------------
// WHY: the coach model was told "G4 before G5" in the prompt, but it SELF-
// REPORTED its ladder position and nothing verified it. Self-report drifts —
// that's the documented "it skips steps" failure. This module computes gate
// states from the transcript with regexes (ground truth, in code), so we can:
//   1. INJECT the true state + allowed steps into every coach request
//   2. VALIDATE the step the model picked and log violations
//   3. GRADE full simulated conversations in tests/simulate.ts
//
// Pure functions only — safe to import from client, route, and test scripts.
// -----------------------------------------------------------------------------

export interface LadderLine {
  speaker: 'prospect' | 'me';
  text: string;
}

export interface LadderGates {
  /** G1 — the voicemail-or-keep-ringing diagnostic was delivered */
  opener_done: boolean;
  /** G3 — asked whether voicemails get returned same day / stack up */
  return_probe_done: boolean;
  /** G4 — THE hard gate: booked-somewhere-else-by-then (or an alternate gap) was asked */
  gap_asked: boolean;
  /** Prospect conceded some form of slippage / uncertainty after the gap or state-the-fact */
  pain_conceded: boolean;
  /** G5 — Seb asked who handles phone-coverage decisions */
  dm_asked: boolean;
  /** Gatekeeper actually named/identified the decision-maker */
  dm_named: boolean;
  /** An asset exists: email captured, transfer offered, or callback agreed */
  asset_secured: boolean;
  /** dentavoice.co was spoken by Seb (transcription artifacts included) */
  website_planted: boolean;
}

// --- Pattern banks (tuned against the real dial-block transcripts) ----------

const OPENER_RE = /voice\s?mail/i;
const OPENER_RE2 = /(keep ringing|keeps ringing|already busy|busy helping)/i;

const RETURN_PROBE_RE =
  /(returned (the )?(exact )?same day|get returned.{0,20}same day|stack up|some slip|returned right away)/i;

const GAP_RE =
  /((booked|book(ed)?)\s+(somewhere|somebody|someone|elsewhere)|already booked|book(ed)? (somewhere|some place) else)/i;
const GAP_ALT_RE =
  /(what happens to (the )?calls.{0,30}(busiest|during|come in)|after hours.{0,30}(what happens|that call)|(both|all|everyone).{0,25}with patients.{0,20}(at once|same time))/i;

const STATE_FACT_RE =
  /(don'?t wait|doesn'?t wait|call(s)? the next (office|place)|next (office|place) on (google|their list)|never (even )?know|someone else'?s patient)/i;

const PAIN_CONCEDE_RE =
  /\b(yeah|yes|i guess|probably|sometimes|true|good (point|question)|that happens|some (do|might|have|probably)|i (don'?t|do not) (actually |really )?know|you'?re right|that'?s right|exactly|huh|i mean)\b/i;

const DM_ASK_RE =
  /(office manager|who (usually )?(handles|is|would be)|best person to (talk|speak)|is that the (doctor|dentist))/i;

const DM_NAMED_RE =
  /((that|it) would be (our |the |probably (our |the )?)?(office manager|manager|doctor|dr\b)|(her|his) name is|i'?m the (office |practice )?manager|that would be me|you'?re talking to her)/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_SPOKEN_RE = /\bat g\s?mail\b|\bat gmail\b/i;
const TRANSFER_OFFER_RE =
  /(transfer you|put you through|send you over|let me get (her|him)|one moment|connect you)/i;
const CALLBACK_AGREED_RE =
  /(try back|call (back|her|him))\s.{0,25}\b(around|at|tomorrow|this afternoon|later)\b\s/i;

// Transcription artifacts: "dental voice dot co", "dentavoice dot co", real form
const WEBSITE_RE = /(denta\s?voice\s*(\.|dot)\s*co|dental\s?voice\s*(\.|dot)\s*co)/i;

// -----------------------------------------------------------------------------

export function computeGates(lines: LadderLine[]): LadderGates {
  const gates: LadderGates = {
    opener_done: false,
    return_probe_done: false,
    gap_asked: false,
    pain_conceded: false,
    dm_asked: false,
    dm_named: false,
    asset_secured: false,
    website_planted: false,
  };

  let gapAskedAtIndex = -1;

  lines.forEach((l, i) => {
    const t = l.text;
    if (l.speaker === 'me') {
      if (!gates.opener_done && OPENER_RE.test(t) && OPENER_RE2.test(t)) gates.opener_done = true;
      if (!gates.return_probe_done && RETURN_PROBE_RE.test(t)) gates.return_probe_done = true;
      if (!gates.gap_asked && (GAP_RE.test(t) || GAP_ALT_RE.test(t) || STATE_FACT_RE.test(t))) {
        gates.gap_asked = true;
        gapAskedAtIndex = i;
      }
      if (!gates.dm_asked && DM_ASK_RE.test(t)) gates.dm_asked = true;
      if (!gates.website_planted && WEBSITE_RE.test(t)) gates.website_planted = true;
    } else {
      if (
        !gates.pain_conceded &&
        gates.gap_asked &&
        i > gapAskedAtIndex &&
        PAIN_CONCEDE_RE.test(t)
      ) {
        gates.pain_conceded = true;
      }
      if (!gates.dm_named && DM_NAMED_RE.test(t)) gates.dm_named = true;
      if (!gates.asset_secured && (EMAIL_RE.test(t) || EMAIL_SPOKEN_RE.test(t) || TRANSFER_OFFER_RE.test(t))) {
        gates.asset_secured = true;
      }
    }
    if (!gates.asset_secured && l.speaker === 'me' && CALLBACK_AGREED_RE.test(t)) {
      gates.asset_secured = true;
    }
  });

  return gates;
}

// -----------------------------------------------------------------------------
// Step gating — which ladder rungs are legal RIGHT NOW.
// The single hard rule (from the real failure log): NO DM ask before the gap.
// -----------------------------------------------------------------------------

export function allowedSteps(gates: LadderGates, phase: 'gatekeeper' | 'dm'): string[] {
  if (phase === 'dm') {
    // DM phase gating stays advisory — pain signals there are too fuzzy for
    // regex ground truth. The prompt's D-ladder rules govern.
    return ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'INT'];
  }
  const allowed = ['G1', 'G2', 'G3', 'G4', 'INT', 'G8'];
  if (gates.gap_asked) allowed.push('G5', 'G6', 'G7');
  return allowed;
}

export interface StepValidation {
  ok: boolean;
  reason: string | null;
}

export function validateStep(
  step: string | null | undefined,
  gates: LadderGates,
  phase: 'gatekeeper' | 'dm'
): StepValidation {
  if (!step) return { ok: true, reason: null }; // no step claimed — nothing to validate
  let s = step.toUpperCase().trim();
  if (s === 'G4B') s = 'G4'; // quantify is a G4 sub-step, same gate
  const allowed = allowedSteps(gates, phase);
  if (allowed.includes(s)) return { ok: true, reason: null };
  if (phase === 'gatekeeper' && ['G5', 'G6', 'G7'].includes(s) && !gates.gap_asked) {
    return {
      ok: false,
      reason: `SKIP: ${s} (DM ask/capture) before G4 gap question — the #1 documented call-killer`,
    };
  }
  return { ok: false, reason: `step ${s} not in allowed set [${allowed.join(', ')}]` };
}

// -----------------------------------------------------------------------------
// Content-level violation checks (prompt directives, verified in code).
// Used by the client (logging) and the simulator (grading).
// -----------------------------------------------------------------------------

const PRAISE_RE =
  /(that'?s (great|awesome|perfect)|sounds like (a|you'?ve got a) (good|great) system|really on top of (it|things)|good system|great system)/i;
const CALLBACK_CLAIM_RE =
  /(call(ed)? (them |people )?(right )?back|same day|within (the next )?(five|5|ten|10|thirty|30)|timely manner|right away|respond within|enough staff|we have a (company|system|service))/i;
const IDENTITY_RE = /(seb|sebastian) with dentavoice/i;
const IDENTITY_TEST_RE =
  /(who is this|who'?s calling|who am i speaking|what company|what'?s this (regarding|about)|what is this (in regards to|about|for)|sales call|are you (selling|a patient)|calling from|why are you asking)/i;
const EXIT_RE = /(have a (great|good) (day|one)|totally fair.{0,40}$)/i;

export function checkHintViolations(
  hintSay: string,
  lastProspectLine: string | null,
  gates: LadderGates
): string[] {
  const v: string[] = [];
  const prospect = lastProspectLine ?? '';

  // PD-1: praising the current system after a confident callback claim
  if (PRAISE_RE.test(hintSay) && CALLBACK_CLAIM_RE.test(prospect)) {
    v.push('PD-1 PRAISE: validated the status quo after a callback-speed claim (should be state_the_fact)');
  }
  // PD-2: volunteering identity when not tested
  if (IDENTITY_RE.test(hintSay) && !IDENTITY_TEST_RE.test(prospect)) {
    v.push('PD-2 IDENTITY: volunteered the identity line without being tested');
  }
  // PD-4: exit line without the website
  if (EXIT_RE.test(hintSay) && !WEBSITE_RE.test(hintSay) && !gates.website_planted) {
    v.push('PD-4 EXIT: exit-style line without dentavoice.co planted');
  }
  return v;
}

// -----------------------------------------------------------------------------
// Prompt injection block — the dynamic, per-request hard constraint.
// Goes in the USER message (system prompt stays cached).
// -----------------------------------------------------------------------------

export function gatesToPromptBlock(gates: LadderGates, phase: 'gatekeeper' | 'dm'): string {
  const allowed = allowedSteps(gates, phase);
  const flag = (b: boolean) => (b ? 'TRUE' : 'false');
  if (phase === 'dm') {
    return `\n\nLADDER STATE (computed in code from the transcript — ground truth, do NOT re-infer):\nphase=DM. gap_asked=${flag(gates.gap_asked)} pain_conceded=${flag(gates.pain_conceded)} asset_secured=${flag(gates.asset_secured)} website_planted=${flag(gates.website_planted)}\nFollow the D-ladder rules: no offer (D6) before a confirmed summary (D5 / "that's right").\n`;
  }
  return `\n\nLADDER STATE (computed in code from the transcript — this is ground truth, do NOT re-infer it yourself):\n- opener_done: ${flag(gates.opener_done)}\n- return_probe_done: ${flag(gates.return_probe_done)}\n- gap_asked: ${flag(gates.gap_asked)}  ${gates.gap_asked ? '' : '← THE HARD GATE IS STILL OPEN'}\n- pain_conceded: ${flag(gates.pain_conceded)}\n- dm_asked: ${flag(gates.dm_asked)} · dm_named: ${flag(gates.dm_named)} · asset_secured: ${flag(gates.asset_secured)} · website_planted: ${flag(gates.website_planted)}\n\nALLOWED STEPS RIGHT NOW: [${allowed.join(', ')}]\nHARD RULE: your "step" field MUST be one of the allowed steps. ${gates.gap_asked ? '' : 'gap_asked=false means ANY decision-maker ask (G5/G6/G7) is FORBIDDEN this turn — if you were about to ask for the DM, output the G4 gap question (or state_the_fact if she just made a callback-speed claim) instead.'}${gates.gap_asked && !gates.dm_asked ? ' The gap is asked — advance toward G5 (DM identify) rather than re-digging.' : ''}\n`;
}
