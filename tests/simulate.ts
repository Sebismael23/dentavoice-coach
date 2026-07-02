// -----------------------------------------------------------------------------
// FULL-CONVERSATION SIMULATOR — tests/simulate.ts
// -----------------------------------------------------------------------------
// Simulates ENTIRE gatekeeper calls end-to-end so ladder discipline can be
// tested without burning real dials:
//
//   1. An AI persona plays the gatekeeper (personas cloned from Seb's REAL
//      failed calls: the confident claimer, the identity tester, the
//      new-system brush-off, ...).
//   2. The persona's line goes to the LIVE /api/coach route — the exact
//      production path: cached system prompt, gates injection, SSE streaming,
//      JSON parse.
//   3. "Seb" delivers the coach's hint VERBATIM as his next line.
//   4. Every turn is graded in code via lib/ladder: step-skips (DM ask before
//      gap), PD-1 praise, PD-2 volunteered identity, PD-4 exit w/o website.
//   5. Full conversation + per-call scorecard + aggregate table print to the
//      terminal.
//
// USAGE
//   npm run dev                    # in one terminal (server must be running)
//   npm run simulate               # all personas
//   npm run simulate -- --persona bonnie
//   npm run simulate -- --list
//   npm run simulate -- --max 8    # cap exchanges per call
//
// MODEL A/B (answers "do I need to switch to Sonnet?" with data):
//   COACH_MODEL=claude-sonnet-4-6 npm run dev   # restart server with override
//   npm run simulate                             # compare violation counts
// -----------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import {
  computeGates,
  validateStep,
  checkHintViolations,
  type LadderGates,
  type LadderLine,
} from '../lib/ladder';

// --- Load .env.local manually (tsx doesn't auto-load it) --------------------
try {
  const envPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';
const PERSONA_MODEL = 'claude-haiku-4-5-20251001';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- ANSI helpers ------------------------------------------------------------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m',
  green: '\x1b[32m', magenta: '\x1b[35m', gray: '\x1b[90m',
};
const prospect = (t: string) => `${C.cyan}PROSPECT ▸${C.reset} ${t}`;
const seb = (t: string) => `${C.yellow}SEB      ▸${C.reset} ${t}`;
const meta = (t: string) => `${C.gray}         ${t}${C.reset}`;
const bad = (t: string) => `${C.red}${C.bold}         ⛔ ${t}${C.reset}`;

// -----------------------------------------------------------------------------
// PERSONAS — each one is a documented real-call failure mode.
// -----------------------------------------------------------------------------

interface Persona {
  id: string;
  label: string;
  practice: string;
  greeting: string;
  system: string;
  /** If the gatekeeper transfers, this persona takes over as the DM. */
  dmSystem?: string;
  maxTurns: number;
}

const JSON_RULES = `
OUTPUT FORMAT — return ONLY a JSON object, no prose, no fences:
{"line": "<your next spoken line — short, natural phone speech>", "action": "continue" | "transfer" | "hangup"}
- "transfer" ONLY when you are actively putting the caller through to someone.
- "hangup" when you end the call (say your goodbye in "line").
- Speak like a real receptionist on a phone: short sentences, occasional "Mmhmm", natural fillers. Never narrate, never break character.
- React to what the caller ACTUALLY said. If they make a point you can't argue with, concede a little. If they pitch at you or sound scripted, get colder.`;

const PERSONAS: Persona[] = [
  {
    id: 'bonnie',
    label: 'Bonnie — the confident claimer (killed the real White House call)',
    practice: 'White House Dental',
    greeting: 'White House Dental, this is Bonnie.',
    maxTurns: 12,
    system: `You are Bonnie, a seasoned front-desk receptionist at White House Dental. 22 years on the job, unshakeable, polite but brisk.
BEHAVIOR BEATS:
- If asked the voicemail/busy diagnostic: answer honestly — calls go to voicemail when you're all busy.
- Your SHIELD: you are PROUD that "we call everyone back within thirty minutes." Deploy this claim confidently when asked about voicemail returns.
- CRITICAL: If the caller PRAISES your system ("that's great", "sounds like a good system"), the conversation is over for you — politely wind down and hang up within 2 more lines. They closed their own case.
- If instead the caller states the uncomfortable fact (patients in pain don't wait 30 minutes, they call the next office), pause, then concede: "I mean... yeah, I guess some probably do that." After conceding, if they ask who handles phone decisions, name Sarah the office manager, in today after 2 PM.
- If they ask for the decision-maker BEFORE any of that pain discussion, deflect flat: "We're all set with our phones, thank you" and hang up within 2 lines.
${JSON_RULES}`,
  },
  {
    id: 'chelsea',
    label: 'Chelsea — the identity tester (killed the real Pilling call)',
    practice: 'Pilling Family Dental',
    greeting: 'Pilling Family Dental, this is Chelsea, how can I help you?',
    maxTurns: 10,
    system: `You are Chelsea, a sharp, suspicious receptionist at Pilling Family Dental. You screen vendors hard.
BEHAVIOR BEATS:
- Whatever the caller opens with, your FIRST response is a test: "Who is this? What company are you with?" or "Is this a sales call?"
- If they answer directly and honestly in one breath (name + company + purpose) and pivot to a question about YOUR office, soften ~20% and answer ONE workflow question honestly (calls go to voicemail when slammed).
- If they hedge ("that's a totally fair question..."), stall, or launch a pitch, cut them off: "We're not interested" and hang up next line.
- Second test later: "What are you selling?" — if they answer "honestly, yes this is a sales call" style, respect it slightly, answer one more question, then push toward "just send an email" — the office email is frontdesk@pillingdental.com, address it to Chelsea.
- You NEVER transfer. Best case is the email.
${JSON_RULES}`,
  },
  {
    id: 'brooke',
    label: 'Brooke — the new-system brush-off (killed the real Draper call)',
    practice: 'Draper Dental',
    greeting: 'Draper Dental, this is Brooke.',
    maxTurns: 10,
    system: `You are Brooke at Draper Dental. Friendly but firmly NOT in the market.
BEHAVIOR BEATS:
- Answer the diagnostic: "We have a system that answers them." It books appointments too. You don't know its name.
- Your core position: "We just barely set this up a few weeks ago, so I think we're good for now." Repeat variations of this to any probe.
- If the caller gracefully accepts AND plants where to find them later, end warm: "Okay, no problem. Bye."
- If they keep pushing past two "we're good"s, get short and hang up.
- You will NOT give the manager's name or email. This call is near-unwinnable — the ONLY win available to the caller is a clean exit with their website mentioned.
${JSON_RULES}`,
  },
  {
    id: 'josie',
    label: 'Josie — deflect then transfer (the real Dental Care call)',
    practice: 'Gentle Dental Care',
    greeting: 'Thank you for calling Gentle Dental Care, this is Josie.',
    maxTurns: 14,
    system: `You are Josie, a slightly frazzled receptionist at Gentle Dental Care.
BEHAVIOR BEATS:
- First response to any unusual question: "I'm sorry, I can't quite understand — can you say that one more time?"
- Second: answer honestly — "No, we put them on hold and then answer."
- Third: get cautious: "Who are you needing to speak to? What is this in regards to?"
- If they identify cleanly and it sounds operational (phone coverage), say: "Okay... that would be something my manager handles. I can transfer you to her if you'd like." → action "transfer" when they accept.
- If they pitch products/prices at you, shut down: "We're not interested, thank you."
${JSON_RULES}`,
    dmSystem: `You are Julie, the office manager at Gentle Dental Care, just pulled off a task to take this call. Slightly impatient but fair.
BEHAVIOR BEATS:
- Open with: "This is Julie. What can I do for you?"
- If the caller references what the receptionist told them and asks about YOUR operations (busy times, missed calls), engage — mornings are chaos, you KNOW some voicemails get returned late.
- Objection you must raise before any agreement: "We already have an answering service." (It only takes messages; it does not book. Admit that if asked directly.)
- If they push a demo/meeting before understanding your situation, deflect: "Send me some information."
- If they make the cost of missed calls concrete AND the offer is genuinely zero-risk (free pilot, no contract, they set it up), you're open: "Okay... I'd be willing to look at that. What would you need from me?" That counts as pilot interest.
- Direct email if asked: julie@gentledentalcare.com.
${JSON_RULES}`,
  },
  {
    id: 'theresa',
    label: 'Theresa — email-giver with spelled-out address (the real Corner Cove call)',
    practice: 'Corner Canyon Family Dental',
    greeting: 'Corner Canyon Family Dental, this is Theresa. How may I help you?',
    maxTurns: 12,
    system: `You are Theresa at Corner Canyon Family Dental. Warm, helpful, but protective of the office manager's time.
BEHAVIOR BEATS:
- Diagnostic answer: "We have a company that it goes to." You're also mid-setup of a system where patients can book from the voicemail — "but we don't have it yet," and you don't know its name.
- You will NOT transfer. The office manager is best reached by email.
- When asked for the email, spell it with real phone-call artifacts across your line: "It's o m dot corner cove dental ... at gmail." (that's om.cornercovedental@gmail.com but NEVER say it cleanly).
- If asked who to address it to: "Kaylee."
- If the caller praises your in-progress system, agree happily and start wrapping up (they lost their leverage).
- End warm once the email is handed over.
${JSON_RULES}`,
  },
  {
    id: 'blocker',
    label: 'Hard block — "no sales calls" (tests the exit-with-website rule)',
    practice: 'Summit Peak Dental',
    greeting: 'Summit Peak Dental.',
    maxTurns: 6,
    system: `You are the head receptionist at Summit Peak Dental. Zero tolerance for vendors.
BEHAVIOR BEATS:
- The moment you sense a vendor (any question about your phones/workflow from a non-patient): "We don't take sales calls. Please take us off your list."
- Second vendor-ish line from them: "I'm hanging up now. Don't call again." → action hangup.
- The ONLY thing you tolerate is a graceful, short goodbye — let them finish one short closing sentence before the call ends.
${JSON_RULES}`,
  },
];

// -----------------------------------------------------------------------------
// Coach call — the exact production path (SSE from /api/coach)
// -----------------------------------------------------------------------------

interface CoachHint {
  say: string;
  move: string;
  signal: string;
  why: string;
  play_id: number | null;
  thread: string | null;
  step: string | null;
}

interface SimSegment { speaker: 'prospect' | 'me'; text: string }

async function callCoach(params: {
  transcript: SimSegment[];
  lastHintSay?: string;
  callPhase: 'gatekeeper' | 'dm';
  usedPlayIds: number[];
  consecutiveNulls: number;
  currentThread: string;
  currentStep?: string;
  recentHintSays: string[];
  transferredToDM?: 'office_manager' | 'dentist';
  gates: LadderGates;
}): Promise<{ hint: CoachHint | null; ms: number }> {
  const t0 = Date.now();
  const body = {
    transcript: params.transcript.map((s, i) => ({
      id: `sim-${i}`,
      speaker: s.speaker,
      text: s.text,
      timestamp: t0 - (params.transcript.length - i) * 4000,
      isFinal: true,
    })),
    lastHintAt: null,
    lastHintSay: params.lastHintSay,
    callPhase: params.callPhase,
    usedPlayIds: params.usedPlayIds.length ? params.usedPlayIds : undefined,
    consecutiveNulls: params.consecutiveNulls,
    currentThread: params.currentThread,
    currentStep: params.currentStep,
    recentHintSays: params.recentHintSays.length ? params.recentHintSays : undefined,
    transferredToDM: params.transferredToDM,
    gates: params.gates,
  };

  const res = await fetch(`${BASE_URL}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`coach API ${res.status}: ${await res.text()}`);

  // Consume the SSE stream, accumulate text tokens
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.t) accumulated += parsed.t;
      } catch {}
    }
  }
  const ms = Date.now() - t0;

  const cleaned = accumulated.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (cleaned === 'null' || cleaned === '') return { hint: null, ms };
  const first = cleaned.indexOf('{');
  if (first < 0) return { hint: null, ms };
  let depth = 0, end = -1;
  for (let i = first; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return { hint: null, ms };
  let parsed: any = null;
  const slice = cleaned.slice(first, end + 1);
  try { parsed = JSON.parse(slice); }
  catch { try { parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch { return { hint: null, ms }; } }
  if (!parsed || typeof parsed.say !== 'string' || !parsed.say.trim()) return { hint: null, ms };
  return {
    hint: {
      say: parsed.say,
      move: typeof parsed.move === 'string' ? parsed.move : '',
      signal: typeof parsed.signal === 'string' ? parsed.signal : '',
      why: typeof parsed.why === 'string' ? parsed.why : '',
      play_id: typeof parsed.play_id === 'number' ? parsed.play_id : null,
      thread: parsed.thread ?? null,
      step: typeof parsed.step === 'string' ? parsed.step : null,
    },
    ms,
  };
}

// -----------------------------------------------------------------------------
// Persona call — the AI gatekeeper's next line
// -----------------------------------------------------------------------------

async function callPersona(
  system: string,
  transcript: SimSegment[],
  sebSaidNothing: boolean
): Promise<{ line: string; action: 'continue' | 'transfer' | 'hangup' }> {
  const dialogue = transcript
    .map((s) => (s.speaker === 'me' ? `CALLER: ${s.text}` : `YOU: ${s.text}`))
    .join('\n');
  const nudge = sebSaidNothing
    ? '\n(The caller went quiet for a moment. React naturally — continue, prompt them, or wind down.)'
    : '';
  const msg = await anthropic.messages.create({
    model: PERSONA_MODEL,
    max_tokens: 200,
    temperature: 0.9,
    system,
    messages: [
      {
        role: 'user',
        content: `The call so far:\n\n${dialogue}${nudge}\n\nReturn the JSON for your NEXT line.`,
      },
    ],
  });
  const text = msg.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    const action = ['continue', 'transfer', 'hangup'].includes(parsed.action) ? parsed.action : 'continue';
    return { line: String(parsed.line ?? '...'), action };
  } catch {
    return { line: text.slice(0, 120) || 'Mmhmm.', action: 'continue' };
  }
}

// -----------------------------------------------------------------------------
// One full simulated call
// -----------------------------------------------------------------------------

interface CallResult {
  persona: string;
  turns: number;
  steps: string[];
  violations: string[];
  nulls: number;
  avgCoachMs: number;
  outcome: string;
  gates: LadderGates;
  transferred: boolean;
}

async function simulateCall(p: Persona, maxTurnsOverride?: number): Promise<CallResult> {
  const maxTurns = maxTurnsOverride ?? p.maxTurns;
  console.log(`\n${C.bold}${C.magenta}${'━'.repeat(74)}${C.reset}`);
  console.log(`${C.bold}${C.magenta}📞 ${p.label}${C.reset}`);
  console.log(`${C.magenta}${'━'.repeat(74)}${C.reset}\n`);

  const transcript: SimSegment[] = [{ speaker: 'prospect', text: p.greeting }];
  console.log(prospect(p.greeting));

  let phase: 'gatekeeper' | 'dm' = 'gatekeeper';
  let personaSystem = p.system;
  let transferredToDM: 'office_manager' | undefined;
  let lastHintSay: string | undefined;
  let currentStep: string | undefined;
  let currentThread = 'unknown';
  let usedPlayIds: number[] = [];
  let recentHintSays: string[] = [];
  let consecutiveNulls = 0;
  let nulls = 0;
  let transferred = false;
  const steps: string[] = [];
  const violations: string[] = [];
  const coachTimes: number[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // --- Coach turn (production path, with code-computed gates) ---
    const gates = computeGates(transcript as LadderLine[]);
    let hint: CoachHint | null = null;
    try {
      const r = await callCoach({
        transcript, lastHintSay, callPhase: phase, usedPlayIds,
        consecutiveNulls, currentThread, currentStep, recentHintSays,
        transferredToDM, gates,
      });
      hint = r.hint;
      coachTimes.push(r.ms);
    } catch (err: any) {
      console.log(bad(`coach call failed: ${err.message}`));
      break;
    }

    let sebSaidNothing = false;
    if (hint === null) {
      consecutiveNulls++; nulls++;
      sebSaidNothing = true;
      console.log(meta(`(coach: null — Seb holds)`));
    } else {
      consecutiveNulls = 0;
      // Grade BEFORE delivery, against pre-hint gates (mirrors the client)
      const stepCheck = validateStep(hint.step, gates, phase);
      const lastProspectLine = [...transcript].reverse().find((s) => s.speaker === 'prospect')?.text ?? null;
      const contentV = checkHintViolations(hint.say, lastProspectLine, gates);
      if (!stepCheck.ok && stepCheck.reason) violations.push(stepCheck.reason);
      violations.push(...contentV);

      if (hint.step) { steps.push(hint.step); currentStep = hint.step; }
      if (hint.thread) currentThread = hint.thread;
      if (hint.play_id != null && !usedPlayIds.includes(hint.play_id)) usedPlayIds.push(hint.play_id);
      lastHintSay = hint.say;
      recentHintSays = [...recentHintSays.slice(-4), hint.say];

      transcript.push({ speaker: 'me', text: hint.say });
      console.log(seb(hint.say));
      console.log(meta(`step=${hint.step ?? '?'} move=${hint.move} · ${coachTimes[coachTimes.length - 1]}ms · gates[gap=${gates.gap_asked ? '✓' : '✗'} pain=${gates.pain_conceded ? '✓' : '✗'} dm=${gates.dm_asked ? '✓' : '✗'} web=${gates.website_planted ? '✓' : '✗'}]`));
      if (!stepCheck.ok && stepCheck.reason) console.log(bad(stepCheck.reason));
      for (const cv of contentV) console.log(bad(cv));
    }

    // --- Persona turn ---
    let personaOut: { line: string; action: 'continue' | 'transfer' | 'hangup' };
    try {
      personaOut = await callPersona(personaSystem, transcript, sebSaidNothing);
    } catch (err: any) {
      console.log(bad(`persona call failed: ${err.message}`));
      break;
    }
    transcript.push({ speaker: 'prospect', text: personaOut.line });
    console.log(prospect(personaOut.line));

    if (personaOut.action === 'hangup') {
      console.log(meta('(prospect hung up)'));
      break;
    }
    if (personaOut.action === 'transfer' && p.dmSystem && !transferred) {
      transferred = true;
      transferredToDM = 'office_manager';
      phase = 'dm';
      personaSystem = p.dmSystem;
      usedPlayIds = [];
      consecutiveNulls = 0;
      currentThread = 'unknown';
      currentStep = undefined;
      transcript.push({ speaker: 'prospect', text: '[TRANSFERRED TO DECISION MAKER — Office Manager]' });
      console.log(`${C.green}${C.bold}         ⇪ TRANSFERRED TO DECISION MAKER${C.reset}`);
    }
  }

  const finalGates = computeGates(transcript as LadderLine[]);
  const outcome = transferred
    ? 'TRANSFER (A+)'
    : finalGates.asset_secured
    ? 'ASSET: email/callback (B+)'
    : finalGates.website_planted
    ? 'website planted (C)'
    : 'NOTHING (F)';
  const avgCoachMs = coachTimes.length
    ? Math.round(coachTimes.reduce((a, b) => a + b, 0) / coachTimes.length)
    : 0;

  console.log(`\n${C.bold}── SCORECARD: ${p.id} ${'─'.repeat(50 - p.id.length)}${C.reset}`);
  console.log(`  outcome:     ${outcome}`);
  console.log(`  steps taken: ${steps.join(' → ') || '(none)'}`);
  console.log(`  gates final: opener=${finalGates.opener_done ? '✓' : '✗'} gap=${finalGates.gap_asked ? '✓' : '✗'} pain=${finalGates.pain_conceded ? '✓' : '✗'} dm_asked=${finalGates.dm_asked ? '✓' : '✗'} asset=${finalGates.asset_secured ? '✓' : '✗'} website=${finalGates.website_planted ? '✓' : '✗'}`);
  console.log(`  coach nulls: ${nulls} · avg coach latency: ${avgCoachMs}ms`);
  if (violations.length) {
    console.log(`  ${C.red}${C.bold}violations (${violations.length}):${C.reset}`);
    violations.forEach((v) => console.log(`  ${C.red}  - ${v}${C.reset}`));
  } else {
    console.log(`  ${C.green}violations: none — ladder discipline held${C.reset}`);
  }

  return {
    persona: p.id,
    turns: transcript.length,
    steps,
    violations,
    nulls,
    avgCoachMs,
    outcome,
    gates: finalGates,
    transferred,
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log('Available personas:\n' + PERSONAS.map((p) => `  ${p.id.padEnd(10)} ${p.label}`).join('\n'));
    return;
  }
  const pFlag = args.indexOf('--persona');
  const mFlag = args.indexOf('--max');
  const maxTurns = mFlag >= 0 ? parseInt(args[mFlag + 1]) : undefined;
  const selected =
    pFlag >= 0
      ? PERSONAS.filter((p) => p.id === args[pFlag + 1])
      : PERSONAS;
  if (selected.length === 0) {
    console.error(`Unknown persona. Use --list to see options.`);
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing (checked env + .env.local)');
    process.exit(1);
  }

  // Server up?
  try {
    await fetch(`${BASE_URL}/api/health`);
  } catch {
    console.error(`Coach server not reachable at ${BASE_URL}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  console.log(`${C.bold}DentaVoice Full-Conversation Simulator${C.reset}`);
  console.log(`server=${BASE_URL} · personas=${selected.map((p) => p.id).join(', ')}${process.env.COACH_MODEL ? ` · COACH_MODEL(server env)=${process.env.COACH_MODEL}` : ''}\n`);

  const results: CallResult[] = [];
  for (const p of selected) {
    results.push(await simulateCall(p, maxTurns));
  }

  // Aggregate
  console.log(`\n${C.bold}${'═'.repeat(74)}${C.reset}`);
  console.log(`${C.bold}AGGREGATE — ${results.length} simulated call(s)${C.reset}`);
  console.log(`${'═'.repeat(74)}`);
  console.log(
    'persona'.padEnd(11) + 'outcome'.padEnd(28) + 'viol'.padEnd(6) + 'nulls'.padEnd(7) + 'avg ms'
  );
  for (const r of results) {
    const vColor = r.violations.length ? C.red : C.green;
    console.log(
      r.persona.padEnd(11) +
        r.outcome.padEnd(28) +
        `${vColor}${String(r.violations.length).padEnd(6)}${C.reset}` +
        String(r.nulls).padEnd(7) +
        `${r.avgCoachMs}`
    );
  }
  const totalV = results.reduce((a, r) => a + r.violations.length, 0);
  const skips = results.flatMap((r) => r.violations).filter((v) => v.startsWith('SKIP')).length;
  console.log(`\nTotal violations: ${totalV} (${skips} hard step-skips)`);
  console.log(
    skips === 0
      ? `${C.green}${C.bold}LADDER DISCIPLINE: HOLDING. No DM-ask-before-gap anywhere.${C.reset}`
      : `${C.red}${C.bold}LADDER DISCIPLINE: BROKEN ${skips}x. If this persists on Haiku across runs, flip COACH_MODEL=claude-sonnet-4-6 and re-run to compare.${C.reset}`
  );
  process.exit(skips > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
