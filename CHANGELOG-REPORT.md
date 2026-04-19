# DentaVoice Coach — Development Report

**Date:** April 17–18, 2026
**Developer:** Seb (with AI pair-programming)
**Starting Point:** Baseline codebase (`686cd48`) — a Next.js app with Deepgram STT + Anthropic Claude coaching, non-functional in its initial state

---

## Executive Summary

Over a ~24-hour development sprint, the DentaVoice Coach app went from a broken prototype to a fully functional real-time sales coaching tool — and then underwent a **complete architectural rewrite** after live testing revealed the original design was fundamentally flawed. The app now features adaptive, context-aware coaching that generates unique responses for every conversation moment, rather than fetching canned scripts.

**Final state:** 74 files changed, 10,347 lines added, 371 lines removed across 18 commits.

---

## Phase 1: Infrastructure Fixes (Commits 1–5)

### Problem: The app wouldn't even connect to Deepgram

The baseline app tried to connect directly from the browser to Deepgram's WebSocket API, but browser extensions (likely ad blockers or privacy tools) were stripping the `Authorization` header, causing connection failures.

### Fixes:

| Commit | What Changed | Why |
|--------|-------------|-----|
| `5f3fb5b` | Created `server.js` — a custom Node.js server that proxies the Deepgram WebSocket connection | Browser → our server (no auth header needed) → Deepgram (auth added server-side). This completely bypasses the browser extension issue. |
| `e0bd94e` | Changed `utterance_end_ms` from 800 → 1000 | Deepgram's minimum is 1000ms. The 800ms value was being silently rejected. |
| `02b3ed3` | Fixed binary audio forwarding through the proxy + Next.js HMR WebSocket passthrough | The proxy was converting binary audio frames to text. Also, Next.js's hot-reload WebSocket was being intercepted by the proxy. Both fixed. |
| `d9f9e5a` | Auto-increment port on `EADDRINUSE` | If port 3001 is busy (e.g., from a crashed process), the server now tries 3002, 3003, etc. instead of crashing. |

**Result:** Deepgram connection stable. Audio streaming working. Transcription flowing.

---

## Phase 2: Coaching Quality — Play Selection Engine (Commits 6–13)

### Problem: Claude was giving bad/repeated/mistimed coaching

Even with the connection working, the coaching was unreliable: overlapping API calls, repeated hints, wrong plays for the call phase, no thread awareness, and coaching firing while Seb was mid-sentence.

### Fixes (chronological):

#### Commit `36a7eab` — Coaching Quality Foundation
- **In-flight lock:** Added `coachInFlightRef` so only one Claude API call runs at a time. Before, 3-4 calls would fire simultaneously and return conflicting hints.
- **Hint dedup:** Track `lastHintSay` text. If Claude suggests the same text, skip it.
- **Send last hint to Claude:** Added `lastHintSay` to the API payload so Claude knows what was already suggested and doesn't repeat it.
- **Poll interval:** Set to 5 seconds between coaching ticks.

#### Commit `5f267d3` — Gatekeeper/DM Phase Separation
- **Phase-aware play selection:** Added `callPhase` field (`gatekeeper` | `dm`). Plays in `plays.json` are tagged with their phase. Claude is told: "You MUST only select plays whose phase matches the current call phase."
- **Never-null on prospect question:** If the prospect asks a question ("what is this about?", "who are you?"), Claude is forbidden from returning `null`. Seb needs help NOW.

#### Commit `2509fb2` — Phase Tracking + Cooldown
- **Explicit phase tracking:** `callPhaseRef` persists across coaching ticks. Starts as `gatekeeper`, transitions to `dm` on transfer.
- **Post-hint cooldown:** 8-second cooldown after rendering a hint. Prevents rapid-fire hints that Seb can't keep up with.

#### Commit `185ac66` — Transfer Button Only
- Removed auto-detect phase switching (was unreliable). Phase only changes when Seb clicks the "Transferred to DM" button.
- Cooldown reduced from 8s → 5s (8s felt too slow in testing).

#### Commit `4599a02` — Used Play Tracking + Null Recovery
- **Used play tracking:** `usedPlayIdsRef` accumulates every play_id used during the call. Sent to Claude with instruction "do NOT repeat these."
- **Dedup by play_id:** If Claude returns a play_id already shown, skip it (even if the text differs).
- **Consecutive null recovery:** Track how many times in a row Claude returned `null`. After 3 consecutive nulls, send an URGENT block telling Claude "Seb has NO guidance right now. You MUST pick a play."

#### Commit `01f7464` — Audio Fix + Thread Tracking
- **Disabled AEC (Acoustic Echo Cancellation):** Chrome's built-in AEC was leaking prospect audio into the microphone channel, causing channel misattribution. Fix: disable `echoCancellation` in `getUserMedia`. Trade-off: Seb MUST use headphones (warning added to setup screen).
- **Diagnostic thread tracking:** Claude now detects and reports which diagnostic thread is active (`people` / `money` / `chaos` / `doctor` / `revenue`). The thread persists across API calls via `currentThreadRef`. Claude is told: "Stay on this thread unless the prospect clearly pivots."

#### Commit `05f2fa9` — Suppress While Speaking + Hint History
- **Suppress coaching while Seb speaks:** `shouldAskCoach()` now checks if Seb's last final segment is newer than the prospect's. If Seb is still delivering a hint, don't fire another coaching request.
- **Auto-detect transfer:** Parse prospect phrases like "she's available", "let me transfer you" to auto-switch phase to DM.
- **Hint history:** Send last 5 hint texts to Claude as `recentHintSays`. This gives Claude a running memory of what's been suggested.
- **Early thread detection:** Prompt updated to detect thread from signals (e.g., "answering service" or "voicemail" → people thread) rather than waiting for explicit pain statements.

#### Commit `1684a1f` — Structured Call Context (Setup Screen Redesign)
- **Before:** A single free-text box where Seb typed notes about the call.
- **After:** A structured form with:
  - **Call type selector:** Cold call / Callback / Referral (drives opener strategy)
  - **Expected contact picker:** Unknown / Receptionist / Office Manager / Dentist (sets initial phase)
  - **Practice name + contact name fields** (for personalization in coaching)
  - **Practice size buttons:** 1-2 chairs / 3-5 chairs / 5+ chairs (for pain math framing)
  - **Prior history field** (conditional, shows for callback/referral)
- The form output builds a `COACHING DIRECTIVE` block that tells Claude exactly how to open the call.

#### Commit `6b79e77` — Event-Driven Coaching
- **Before:** Polling every 5 seconds on a timer.
- **After:** Event-driven — coaching tick fires immediately when a prospect FINAL segment arrives. Cooldown reduced to 3 seconds.
- **Impact:** Coaching now arrives ~1-3s after the prospect stops speaking instead of up to 5s.

---

## Phase 3: Automated Eval Suite (Commits 14–16)

### Why: Need repeatable quality measurement

Manual testing by calling real numbers is slow and non-reproducible. Built an automated test harness that feeds simulated conversations to the `/api/coach` endpoint and checks Claude's responses against expected outcomes.

#### Commit `6b20009` — Test Harness v1
- **`tests/scenarios.ts`:** 7 multi-turn conversation scenarios (happy path, gatekeeper brush-off, warm callback, money thread, prospect confusion, Seb-only transcript, chaos thread)
- **`tests/run.ts`:** Runner that feeds transcripts to `/api/coach`, grades responses against expected plays/threads/phases/forbidden plays
- **21 checks total**, all passing
- Fixed: JSON parser now extracts first JSON object from Claude's response (handles Claude occasionally appending prose after the JSON)

#### Commit `96dbbbb` — Test Suite Expansion
- **19 scenarios, 54 checks** — added edge cases: one-word answers, thread switching, long convo with pre-used plays, competitor mention, impatient prospect, referral
- Prompt hardening: stronger stage-order enforcement (can't skip diagnostic → pitch), doctor-objection rule (use Play 30/31 instead of pitching harder)
- Increased `max_tokens` 180 → 250 to prevent JSON truncation

#### Commit `c0809ba` — Mentor Eval Merge (109/109, 100%)
- Merged mentor's 25 eval scenarios + 6 new edge cases = **31 scenarios, 109 checks**
- Located in `evals/scenarios/` (separate from `tests/`)
- **Prompt fixes to reach 100%:**
  - Play 13 (pattern interrupt) restricted to zero-thread-signal contexts only (was over-firing)
  - Objection plays (26–31) restricted to objection stage only
  - Thread pivot detection rule added
- **Stability:** 3 consecutive runs all 109/109 (100%)
- `evals/scoring-rubric.md` documents the grading criteria

**⚠️ Note:** The eval suite tests the OLD play-selection architecture. After the Phase 4 rewrite, these evals will NOT pass as-is because the response format changed. They would need updating to test the new adaptive format.

---

## Phase 4: The Architecture Rewrite (Commit 17) — MOST IMPORTANT

### The Problem: Live Testing Revealed a Fundamental Flaw

Seb tested the app on a real call (Script 1 — Friendly Gatekeeper). The conversation went well initially, but critical failures emerged:

1. **The app was a "glorified lookup table."** Claude picked a play number → the app looked up `play.say` from `plays.json` → displayed the static text verbatim. Same phrases every single call, regardless of context.

2. **Not adaptive AT ALL.** Seb's exact words: *"the ai is not ADAPTIVE AT ALL... it's giving me the exact same phrases for every single call, it's not dynamic at all... the whole point of the app is to analyze the whole conversation flow, have access to my whole playbook and analyze what to say next even if it is not exactly hardcoded."*

3. **Strategic failures:**
   - Gatekeeper said "that would be the office manager, Megan" → coach should have immediately said "Is Megan available right now?" but instead jumped to scheduling a callback.
   - Prospect called out scripted language ("you've inferred that I thought you were trying to sell something") → the old app had no way to recover from this because it could only output pre-written phrases.

4. **Hint freezing:** Due to play_id dedup, once a play was suggested, ANY future suggestion referencing that same play (even with completely different wording) was blocked. The coach would get stuck showing nothing.

### The Solution: Complete Architecture Rewrite

**Before (Play Selector):**
```
Transcript → Claude picks play_id → App looks up plays.json[play_id].say → Display static text
```

**After (Adaptive Coach):**
```
Transcript → Claude ANALYZES conversation + consults playbook → Claude GENERATES contextual words → Display Claude's words
```

### What Changed in Each File:

#### `lib/prompt.ts` — COMPLETELY REWRITTEN
- **Old:** "You are a play selector. Return the play number that best matches."
- **New:** "You are Seb's real-time sales coach. You ANALYZE the live conversation and tell Seb exactly what to say next — adapted to what's actually happening on THIS call."
- Playbook is now injected as "strategic toolkit — study the tactics, triggers, and flow — but adapt the phrasing to fit the moment. Never copy them verbatim."
- Added 7 Adaptive Coaching Rules:
  1. Never give the same phrasing twice in one call
  2. React to what JUST happened (don't ignore prospect's question)
  3. Match their energy (rushed = short; chatty = let them talk)
  4. Read between the lines ("we're good" = "convince me")
  5. When gatekeeper gives DM name → ask if available NOW (live transfer first)
  6. If prospect calls out scripted language → STOP, acknowledge, recover naturally
  7. Track what Seb has already said
- Embedded Chris Voss (Never Split the Difference) and Alex Hormozi (value equation) frameworks
- Clear phase/stage/thread documentation inline

#### `lib/types.ts` — Unified Response Type
- **Removed:** `play/generate` action split, `confidence` field, `personalize` slots
- **Added:** `why` field (coaching reasoning), `move` field (tactic name)
- `CoachResponse` is now a single shape: `{ signal, move, say, play_id?, why, thread? } | null`
- `RenderedHint` simplified: `source` is always `'coach'` (no more `'play'` vs `'generate'`), added `why` field

#### `lib/coach.ts` — Simplified Resolution
- **Old:** `resolveHint()` looked up `plays[play_id]`, swapped personalization slots (`{their_name}` → actual name), fell back to `generateContextualHint()`
- **New:** `resolveHint()` passes through Claude's generated text directly. No play lookup, no slot substitution. Claude is now responsible for generating speakable words.

#### `app/api/coach/route.ts` — Simplified Parser
- Response parser now validates `signal`, `move`, `say`, `why` (instead of checking for `action: "play"` vs `action: "generate"`)
- `max_tokens` increased to 300 (Claude needs room for `say` + `why` + JSON structure)
- All state blocks still sent: phase, thread, usedPlayIds, consecutiveNulls, recentHintSays, etc.

#### `components/HUD.tsx` — Coach's Thinking Panel
- **Removed:** `plays` prop, `currentPlay` lookup, `confidence` percentage, `StageBadge`, fallback badge
- **Added:** "Coach's Thinking" panel showing the `why` field (explains why Claude suggested this move)
- "Signal Detected" shows what Claude noticed in the prospect's words

#### `components/StatusBar.tsx` — Cleaned Up
- Removed `fallbackCount` prop and display (no longer relevant)

#### `components/CallSession.tsx` — Simplified Tracking
- Removed `fallbackCount` tracking
- Removed `source === 'generate'` checks
- Removed `plays` prop from HUD
- Updated response logging from `action=play` to `move=X`

---

## Phase 5: Post-Rewrite Fixes (Latest, uncommitted)

After the first live test with the new adaptive architecture, two issues were identified:

### Issue 1: Hint Freezing (play_id dedup still blocking)
- **Problem:** The old dedup logic blocked hints by `play_id`. With the new architecture, Claude might reference the same playbook play (e.g., Play 8 — callback time lock) with completely different words, but all would get blocked because `play_id === 8` was already used.
- **Fix:** Removed play_id dedup entirely. Now only dedup by **exact text match**. When a dupe IS blocked, `consecutiveNulls` increments so Claude gets pushed to try something new.

### Issue 2: Response Latency
- **Problem:** 3–7 second response times from Claude.
- **Fix:** Reduced `max_tokens` from 300 → 180. The `say` field is ~30 words + short `why`. This should cut response time by ~30-40%.

---

## Practice Testing Materials

Created **18 practice scripts** (`practice-scripts/`) for Seb to test the app without calling real numbers. A partner reads the prospect lines while Seb uses the app:

| # | Script | Difficulty | Tests |
|---|--------|-----------|-------|
| 01 | Friendly Gatekeeper | Easy | Name extraction, live transfer ask |
| 02 | Suspicious Gatekeeper | Medium | Identity test, "who is this?" |
| 03 | Hostile Gatekeeper | Hard | Hard block, "we're not interested" |
| 04 | DM — Curious | Easy | Full diagnostic → pitch |
| 05 | DM — Budget Hawk | Medium | Money thread, price objection |
| 06 | DM — Staffing Pain | Easy | People thread, easy conversion |
| 07 | DM — Doctor Controls | Medium | Doctor thread, decision deferral |
| 08 | DM — Chaos Office | Medium | Chaos thread, multiple pain points |
| 09 | DM — Not Interested | Hard | Objection handling, "not interested" |
| 10 | DM — Competitor | Hard | Competitive positioning |
| 11 | DM — Send Email | Hard | Email brushoff recovery |
| 12 | DM — Full Journey Yes | Medium | Complete call → close |
| 13 | DM — Rambler | Medium | Prospect control, redirect |
| 14 | DM — One Word | Hard | Minimal responses, engagement |
| 15 | GK → DM Transfer | Medium | Full gatekeeper → DM handoff |
| 16 | DM — "We're Happy" | Hard | Status quo objection |
| 17 | DM — Impatient | Hard | Time pressure, quick pitch |
| 18 | DM — Cold Feet | Medium | Late-stage objection, close |

---

## Current Tech Stack

| Component | Technology | Details |
|-----------|-----------|---------|
| Framework | Next.js 14.2.15 | Custom `server.js` for WebSocket proxy |
| Port | 3001 | Auto-increments on EADDRINUSE |
| STT | Deepgram Nova-3 | Multichannel (2 channels), `utterance_end_ms=1000`, `endpointing=400` |
| LLM | Anthropic Claude claude-sonnet-4-6 | `max_tokens=180`, prompt caching enabled |
| Audio | Browser MediaRecorder | `audio/webm;codecs=opus`, AEC disabled (headphones required) |
| Playbook | 34 plays in `data/plays.json` | Covers gatekeeper, diagnostic, pitch, objection, close stages |
| Channel Mapping | Ch 0 = Prospect (tab audio), Ch 1 = Seb (mic) | Stereo mode |

---

## Architecture Diagram

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Browser Tab  │────▶│  server.js   │────▶│   Deepgram   │
│  (audio out)  │     │  (WS proxy)  │◀────│   Nova-3     │
│  + Mic input  │◀────│  port 3001   │     │   STT        │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │                                         │
       │ Transcript segments (final)             │
       ▼                                         │
┌──────────────┐                                 │
│ CallSession  │◀────────────────────────────────┘
│  .tsx        │
│              │     ┌──────────────┐     ┌──────────────┐
│  on prospect │────▶│ /api/coach   │────▶│  Anthropic   │
│  final seg   │     │  route.ts    │◀────│  Claude      │
│              │◀────│              │     │  Sonnet 4    │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       │ RenderedHint
       ▼
┌──────────────┐
│   HUD.tsx    │  Shows: say, move, signal, why
│              │  + Coach's Thinking panel
└──────────────┘
```

---

## Key Metrics

- **Total commits:** 18 (baseline + 17 changes)
- **Files changed:** 74
- **Lines added:** 10,347
- **Lines removed:** 371
- **Eval suite (pre-rewrite):** 31 scenarios, 109 checks, 100% pass rate, 3/3 stability
- **Practice scripts:** 18 (3 easy, 8 medium, 7 hard)
- **Live tests completed:** 2 (one pre-rewrite, one post-rewrite)

---

## Known Issues / Next Steps

1. **Eval suite needs updating** — the `evals/` directory tests the old play-selection format (`action: "play"`, exact `play_id` matching). Needs rewrite for new adaptive format.
2. **Latency still 1-5s** — Claude's response time varies. Could explore streaming responses or using a faster model for simple cases.
3. **`max_tokens=180` may truncate** — if Claude's response is long (especially the `say` + `why` fields), the JSON might get cut off. The parser handles this gracefully (returns null), but coaching is lost. Monitor for JSON parse failures in the server logs.
4. **Thread tracking accuracy** — Claude sometimes returns `"unknown"` even when a thread is clearly active. The `currentThread` persistence helps but isn't perfect.
5. **Prospect detection** — Deepgram's channel assignment occasionally swaps (prospect voice on mic channel). Headphones mitigate but don't eliminate.
