# DentaVoice Coach — Eval Harness

Offline evaluation system for the live coach. Replays 25 scripted prospect scenarios against your `/api/coach` endpoint and scores the responses against expected behavior.

## Why this exists

Real calls take 10+ minutes each, cost phone credits, burn warm prospects, and produce inconsistent data. Evals run in seconds, cost pennies, and produce repeatable results.

**Rule of thumb:** if you changed `plays.json`, `prompt.ts`, the model, or any coaching logic — run the evals before calling a real dentist.

## One-time setup

From the project root:

```bash
npm install --save-dev tsx
```

(Already have `tsx`? Skip this.)

Confirm the eval folder exists at the project root:

```
dentavoice-coach/
├── app/
├── components/
├── data/
├── evals/              ← this folder
│   ├── scenarios/      (25 *.json files)
│   ├── run-evals.ts
│   ├── README.md
│   └── scoring-rubric.md
├── lib/
└── ...
```

## Running evals

### 1. Start your dev server

In terminal 1:
```bash
npm run dev
```

Wait for `Ready on http://localhost:3000`.

### 2. Run all scenarios

In terminal 2:
```bash
npx tsx evals/run-evals.ts
```

Typical run: ~60 seconds total for 25 scenarios, ~$0.05 in API costs.

### 3. Save output for Claude to analyze

```bash
mkdir -p evals/results
npx tsx evals/run-evals.ts > evals/results/run-$(date +%Y%m%d-%H%M%S).txt 2>&1
```

Paste the full file contents into a Claude conversation for analysis.

### 4. Single scenario debugging

```bash
npx tsx evals/run-evals.ts --only thread-02-money
```

Run this to isolate a specific failure while iterating.

### 5. Verbose mode (full traces)

```bash
npx tsx evals/run-evals.ts --verbose
```

Shows every turn + hint + latency inline. Useful for deep debugging a single failing scenario.

## How it works

1. Each scenario is a JSON file defining a prospect dialogue and expected coach responses
2. The harness feeds turns one-at-a-time to your live `/api/coach` endpoint, mimicking real streaming
3. After each prospect turn, the harness calls `/api/coach` and checks the response against the scenario's `expectCoach` assertions
4. Hint history and diagnostic thread state persist across turns within a scenario (matching real `CallSession` behavior)
5. Results are aggregated by category (gatekeeper, thread detection, objection handling, pitch progression, close, recovery, edge cases)

## Scenario categories

| Category | Count | Tests |
|----------|-------|-------|
| `gatekeeper-opening` | 1 | Clean opener flow |
| `gatekeeper-test` | 4 | Identity questions, hard blocks, send-email, answering-service |
| `diagnostic-thread-detection` | 5 | All 5 threads (people, money, chaos, doctor, revenue) |
| `objection-handling` | 7 | All major objections from playbook |
| `pitch-progression` | 2 | Full pitch flow, no-skip-stages discipline |
| `close` | 2 | Yes-close and graceful exit |
| `recovery` | 1 | Emergency recovery |
| `edge-case` | 3 | Voicemail, rambler, duplicate suppression |

**25 scenarios total.**

## What passing means

Each assertion is one of:
- `anyOf: [ids]` — coach must pick one of these plays
- `noneOf: [ids]` — coach must NOT pick any of these
- `thread: "name"` — coach must set diagnostic thread to this value
- `silence: true` — coach must return `null`

A scenario **passes** when all its `expectCoach` assertions are satisfied.

## Baseline expectations

Before Bug 1-4 fixes: expect ~40-60% pass rate. The eval exposes exactly the same bugs seen in live testing.

After Bug 1-4 fixes: target 80%+ pass rate. Some scenarios (edge cases, recovery) allow broader `anyOf` ranges because multiple plays are genuinely valid.

**Do not chase 100%.** Past ~85%, you're overfitting to the eval instead of to real calls. The goal is a reliable signal that coaching behavior is in the right neighborhood, not perfect play selection.

## Adding scenarios

When you hit a real call failure you want to regression-test, capture it as a scenario:

1. Create `evals/scenarios/NN-category-name.json`
2. Follow the structure of existing scenarios
3. Include `expectCoach` only on the specific turn where coaching matters
4. Use `noneOf` liberally — documenting what's wrong is often more valuable than declaring what's right
5. Re-run `npx tsx evals/run-evals.ts` to confirm it's picked up

## Interpreting results

See `scoring-rubric.md` for the framework Claude uses when analyzing eval output.

Short version:
- **Category pass rates** reveal which coaching skills are weak (e.g., "thread detection at 40%" = system prompt needs sharpening)
- **Which plays are over-fired** reveals coach bias (e.g., Play 13 firing in money contexts = thread detection broken)
- **Latency distribution** reveals when to tune poll intervals or max_tokens
- **Error logs** reveal real bugs (malformed JSON, play_id hallucinations)

## Cost notes

Each scenario makes 2-8 API calls depending on turn count. At Sonnet 4.6 with prompt caching:
- Single scenario: ~$0.002
- Full eval run (25 scenarios): ~$0.05
- 10 full runs while iterating: ~$0.50

Orders of magnitude cheaper than live testing, and repeatable.

## Known limitations

- Does NOT test Deepgram audio accuracy
- Does NOT test real-time streaming behavior
- Does NOT test UI rendering
- Does NOT simulate imperfect transcripts (stutters, mishears, echo leak)

For those, you still need live self-calls. But use evals first to catch the 80% of bugs that are in your prompting and play selection.
