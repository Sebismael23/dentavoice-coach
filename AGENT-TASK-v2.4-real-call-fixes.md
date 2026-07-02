# Agent Task — DentaVoice Coach v2.4: Real-Call Bug Fixes

You are working on a Next.js + custom Node WebSocket app (`server.js`) that acts as
a live cold-call coach. It transcribes a two-channel call via Deepgram (channel 0 =
prospect, channel 1 = the user "Seb") and calls `/api/coach` (Anthropic streaming)
to produce one hint at a time. Key files: `components/CallSession.tsx`,
`lib/coach.ts`, `lib/deepgram.ts`, `app/api/coach/route.ts`, `lib/prompt.ts`.

This task fixes THREE real bugs observed in a live-dialing session, plus one metric
correction. **Do exactly these four items. Do not refactor anything else, do not add
features, do not touch the sales prompt content, the playbook, or the eval harness.**
After each fix, run `npx tsc --noEmit` and `npx next build`. Both must pass.

---

## FIX 1 (CRITICAL) — Swallow AbortError from superseded coach calls

### Symptom (from console)
```
Uncaught (in promise) AbortError: signal is aborted without reason
    at requestCoach (CallSession.tsx:469:29)
    at Object.onSegment (CallSession.tsx:544:15)
    at WebSocket.eval (deepgram.ts:209:12)
```
Also appears as bare `Uncaught (in promise)` at `CallSession.tsx:190` and `:435`.

### Root cause
`requestCoach` invokes `runCoachCall(...)` as fire-and-forget (no `await`, no
`.catch`). When a newer prospect utterance calls `abortRef.current?.abort()`, the
in-flight `fetch` in `lib/coach.ts` rejects with `AbortError`. That rejection is not
guaranteed to be caught (it can surface during the SSE streaming read, outside the
inner try/catch), so it becomes an unhandled promise rejection.

### Required changes

**1a. In `components/CallSession.tsx`** — every place that calls `runCoachCall(...)`
without `await` must attach a `.catch` that ignores AbortError and logs anything
else. There are ~3 sites inside `requestCoach` (the `transfer` branch, the
`interval` branch, and the debounced `setTimeout` restart). Wrap them via a single
helper. Add this helper immediately above `requestCoach`:

```ts
// Fire-and-forget a coach call without leaking AbortError rejections.
// runCoachCall already handles AbortError internally, but the SSE read can
// reject after abort() outside that scope — swallow it here as the last line
// of defense so it never becomes an unhandled rejection.
const fireCoachCall = (source: TriggerSource, triggerAt?: number) => {
  runCoachCall(source, triggerAt).catch((err: any) => {
    if (err?.name === 'AbortError') return; // expected on supersede
    console.error('[coach] uncaught call error', err);
  });
};
```

Then replace the direct fire-and-forget invocations inside `requestCoach`:
- `runCoachCall('transfer');`            → `fireCoachCall('transfer');`
- `runCoachCall('interval', ...);`       → `fireCoachCall('interval', ...);`
- inside the `setTimeout(...)`: `runCoachCall(source, triggerAt);` → `fireCoachCall(source, triggerAt);`

Leave any `await runCoachCall(...)` calls (if present) as-is.

**1b. In `lib/coach.ts`** — make `getHint` treat abort as a clean, non-throwing
null instead of propagating. Find the `fetch('/api/coach', { ... signal ... })`
call and the surrounding logic. Wrap the network + stream read so that an aborted
request returns `null` quietly:

```ts
try {
  // ...existing fetch + SSE read + parse, returning the parsed CoachResponse...
} catch (err: any) {
  if (err?.name === 'AbortError' || signal?.aborted) {
    return null; // superseded by fresher speech — expected, not an error
  }
  throw err;
}
```

Do not change the parsing logic itself here (that's Fix 3). Only add the
abort-aware guard around it.

**Verify:** during a session, superseding an in-flight hint logs
`[coach] Aborted in-flight call (superseded by fresher speech)` and produces NO
`Uncaught (in promise) AbortError` lines.

---

## FIX 2 (HIGH VALUE) — Detect IVR / recorded greetings and stop coaching them

### Symptom (from console)
When a dental office answers with an automated menu, the prospect channel emits long
recorded phrases and the coach streams nonsense, one call per phrase:
```
[session] Segment [prospect] FINAL: "...located at 317 West Cherry Lane. Press 2 for the Columbia Village office..."
[coach] Streaming say started: "Press 1 or..."
[coach] Streaming say started: "Press 3...."
```
Every phrase fires `source=supersede`, burning Anthropic calls and showing Seb
useless hints while a machine talks.

### Goal
When the prospect channel is clearly a recording/IVR (not a live human), SUPPRESS the
normal coach ladder and instead show a single, static, non-streaming HUD note telling
Seb how to reach a human. Do NOT call `/api/coach` while IVR is detected. Resume
normal coaching the moment a live human is detected (a real greeting like
"This is Julia, how can I help you?" or any prospect turn that is clearly
conversational).

### Implementation (all in `components/CallSession.tsx`, plus a tiny HUD tweak)

**2a. Add an IVR classifier** near the other module-scope helpers (next to
`SHORT_TRIGGER_RE`):

```ts
// Heuristic IVR / recorded-greeting detector. Runs on PROSPECT finals only.
// Returns true when the utterance looks like an automated menu or recorded intro.
const IVR_PATTERNS: RegExp[] = [
  /press\s+(?:\d|one|two|three|four|five|zero|pound|star)/i,
  /para\s+espa[nñ]ol/i,
  /this call may be recorded/i,
  /for quality (?:and|assurance|training)/i,
  /please (?:listen|select|stay on the line|hold)/i,
  /if you (?:are calling|know your party|have (?:a )?billing)/i,
  /(?:our (?:office|hours)|we are (?:open|located|not accepting))/i,
  /thank you for calling .+ (?:please|if|for|our)/i,
  /located at \d/i,
  /(?:main menu|dial by name|leave a (?:message|detailed message))/i,
];
function looksLikeIVR(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length >= 12 && /\bpress\b|\bpound\b|\bextension\b/i.test(t)) return true;
  let hits = 0;
  for (const re of IVR_PATTERNS) if (re.test(t)) hits++;
  return hits >= 1 && t.split(/\s+/).length >= 5; // one strong signal + not a tiny phrase
}
```

**2b. Add IVR state** with the other refs/state in the component:

```ts
const [ivrActive, setIvrActive] = useState(false);
const ivrActiveRef = useRef(false);
```

**2c. Gate coaching in the prospect-final handler.** In `onSegment`, in the block
that handles `seg.isFinal && seg.speaker === 'prospect'`, BEFORE the existing
"substantial / suppress / supersede" logic, insert:

```ts
// --- IVR gate ---
if (looksLikeIVR(seg.text)) {
  if (!ivrActiveRef.current) {
    ivrActiveRef.current = true;
    setIvrActive(true);
    // Cancel any in-flight/queued coach work — we're talking to a machine.
    abortRef.current?.abort();
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    console.log('[coach] IVR detected — suppressing hints until a human is heard');
  }
  return; // do NOT call the coach on IVR lines
}
// A clearly conversational prospect line clears IVR mode.
if (ivrActiveRef.current) {
  ivrActiveRef.current = false;
  setIvrActive(false);
  console.log('[coach] Live human detected — resuming coaching');
  // fall through to normal handling below
}
```

**2d. Also guard the interval timer** so it never fires during IVR. In the
`interval` branch of `requestCoach`, add near the top of that branch:

```ts
if (ivrActiveRef.current) return;
```

**2e. Show a static IVR note in the HUD.** Pass `ivrActive` into `<HUD .../>` and,
in `components/HUD.tsx`, when `ivrActive` is true and there is no fresher live hint,
render a fixed, non-streaming card (NOT a Claude call):

```tsx
{ivrActive && (
  <div className="text-center px-4">
    <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted mb-2">
      Automated menu detected
    </div>
    <div className="text-hint text-text-secondary leading-[1.15]">
      Navigate to a human — usually <span className="text-accent">0</span> or the
      &ldquo;front desk / all other calls&rdquo; option. Hints resume when a person answers.
    </div>
  </div>
)}
```
Add `ivrActive?: boolean` to `HUDProps` and render this block above/instead of the
normal hint when `ivrActive` is true and `hint` is stale. Keep it simple; do not
animate it.

**Verify:** replay an IVR (say "thank you for calling, press 1 for appointments,
press 0 for all other calls"). Expect `[coach] IVR detected` ONCE, zero
`Calling Claude` lines during the menu, the static HUD note visible, and
`[coach] Live human detected — resuming coaching` when a real greeting follows.

---

## FIX 3 (MEDIUM) — Harden coach JSON parsing

### Symptom (from console)
```
[coach] JSON parse failed SyntaxError: Unexpected non-whitespace character after JSON at position 6
    at parseCoachResponse (coach.ts:43:25)
[coach] unrecognized response shape Object   (coach.ts:53)
```
Haiku sometimes returns text after the JSON object, or a slightly off shape, which
currently yields a silent `null` (a missed hint).

### Required changes — in `lib/coach.ts`, function `parseCoachResponse`

The existing brace-matching extractor already isolates the first balanced `{...}`.
Make it more tolerant and add a single repair attempt:

1. Before parsing, strip markdown fences and leading/trailing prose (keep the
   balanced-brace slice you already compute).
2. If `JSON.parse` throws, attempt ONE repair: remove trailing commas
   (`/,\s*([}\]])/g → '$1'`) and re-parse the same balanced slice.
3. Accept the response if it has a string `say` OR the literal `null`. If `say`
   exists but `move`/`signal`/`why` are missing, fill them with `''` rather than
   rejecting the whole hint (a hint with just `say` is still useful to Seb).
4. Only log `unrecognized response shape` when there is genuinely no `say` and it
   is not `null`.

Snippet for the repair step (adapt to the existing code, do not duplicate the
extractor):

```ts
let parsed: any = null;
try {
  parsed = JSON.parse(jsonSlice);
} catch {
  try {
    parsed = JSON.parse(jsonSlice.replace(/,\s*([}\]])/g, '$1'));
  } catch (e) {
    console.warn('[coach] JSON parse failed after repair', { raw: jsonSlice.slice(0, 200) });
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
```

Keep the return type compatible with the existing `CoachResponse`/parse contract.

---

## FIX 4 (LOW / metric accuracy) — Don't record fake reaction times

### Symptom (from console)
Real turns read ~1.1–1.7s, but `interval`-sourced calls print inflated values like
`Reaction ... 13258ms` / `11759ms` because `triggerAt` points at a stale prospect
final.

### Required change — in `components/CallSession.tsx`, `recordReaction`

Only record a sample when the triggering prospect final is RECENT. Add a freshness
guard: if `Date.now() - triggerAt > 4000`, skip recording (still allow the paint,
just don't pollute the metric). Also prefer to only record for `source==='event'`
or `'supersede'`. Minimal change:

```ts
const recordReaction = useCallback(() => {
  if (firstPaintDoneRef.current) return;
  firstPaintDoneRef.current = true;
  const triggerAt = triggerAtRef.current;
  if (triggerAt != null && Date.now() - triggerAt <= 4000) {   // freshness guard
    const ms = Date.now() - triggerAt;
    reactionSamplesRef.current = [...reactionSamplesRef.current.slice(-19), ms];
    const avg = reactionSamplesRef.current.reduce((a, b) => a + b, 0) / reactionSamplesRef.current.length;
    setAvgReactionMs(Math.round(avg));
    console.log(`[metrics] Reaction (prospect-final → first words): ${ms}ms`);
  }
}, []);
```

---

## Acceptance checklist (run before declaring done)
- [ ] `npx tsc --noEmit` passes.
- [ ] `npx next build` passes.
- [ ] Superseding a hint logs the friendly abort line and produces ZERO
      `Uncaught (in promise) AbortError`.
- [ ] An IVR menu produces one `[coach] IVR detected`, zero `Calling Claude`
      during the menu, a static HUD note, and a clean resume on a human greeting.
- [ ] A response with trailing text after the JSON still yields a usable hint.
- [ ] Status-bar Reaction no longer shows >4s values.

## Explicitly OUT OF SCOPE (do not do)
- No changes to `lib/prompt.ts`, `data/plays.json`, `tests/`.
- No new dependencies.
- No model changes.
- No UI redesign beyond the small IVR note.
- Do not "improve" anything not listed above.
