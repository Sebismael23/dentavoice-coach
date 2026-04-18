# Scoring Rubric — How Claude Analyzes Eval Results

When Seb pastes eval output into a conversation, Claude walks through this rubric to produce actionable feedback. This document exists so the analysis is consistent across runs and so Seb knows what to expect.

## Analysis structure

Every eval analysis produces 5 outputs, in this order:

### 1. Headline verdict (1 sentence)

One of:
- **"Shipped" / Ready to call:** overall ≥ 80%, no category below 60%, no recent regressions
- **"One more pass":** overall 65-80%, specific category gaps identified
- **"Not ready":** overall < 65% OR a critical regression (thread detection broken, money scenario failing)
- **"Broken build":** HTTP errors, malformed JSON, crashes — fix infrastructure before iterating on coaching

### 2. Category scorecard

A per-category pass rate with color-coded interpretation:

| Category | Target | Below target = |
|----------|--------|----------------|
| `gatekeeper-opening` | 90%+ | Opener play disambiguation weak |
| `gatekeeper-test` | 85%+ | Identity reveal (Play 2) not firing on tests |
| `diagnostic-thread-detection` | 80%+ | Thread state not being set/persisted |
| `objection-handling` | 75%+ | Objection triggers too broad — misfires |
| `pitch-progression` | 70%+ | No-skip-stages discipline weak |
| `close` | 90%+ | Close plays should be simple, easy wins |
| `recovery` | 60%+ | Inherently fuzzy — broad `anyOf` expected |
| `edge-case` | 70%+ | Edge coverage indicates robustness |

### 3. Regression diff vs. previous run

If Seb pastes two runs (before-fix / after-fix, or last-week / today):
- New failures → highlighted as regressions (highest priority to fix)
- Previously-failing now-passing → celebrated as wins
- Unchanged failures → re-surfaced as persistent issues

### 4. Top 3 specific fixes

Each fix is structured as:
- **Symptom:** which scenarios failed and how
- **Root cause hypothesis:** which file/prompt/play is likely responsible
- **Concrete fix:** exact change to make, with file path
- **Expected impact:** which scenarios should flip from fail to pass

### 5. "Do NOT fix" list

Cases where Claude recommends accepting the failure:
- Overfitting risk: the fix would harm generalization
- Edge case not worth gaming: scenario is outside the realistic use case
- Real call data needed: can't tell from eval alone whether it's actually wrong

## Specific failure patterns Claude watches for

### Pattern: Play 13 overfiring

**Symptom:** Play 13 (universal diagnostic opener) shows up in thread detection scenarios 07-10 when a specific thread play (14-18) was expected.

**Diagnosis:** Thread detection from prompt is weak. Claude is defaulting to the universal opener instead of committing to a thread signal.

**Fix candidates:**
- Strengthen thread trigger phrases in `plays.json`
- Add more explicit examples in system prompt's "THREAD TRACKING" section
- Increase confidence threshold for Play 13 selection

### Pattern: Same play fires across multiple turns

**Symptom:** Same play_id shows up 2+ times in the same scenario's hint trace.

**Diagnosis:** Hint history not being sent correctly, OR Claude ignoring it.

**Fix candidates:**
- Verify `hintHistory` is populated in API request body (add console.log in `coach.ts`)
- Strengthen "do NOT re-suggest" language in system prompt's hint-history block
- Check if hint history is being cleared prematurely

### Pattern: Play 25 (Grand Slam Offer) fires too early

**Symptom:** Pitch-02-no-skip-stages fails; Play 25 fires in objection or diagnostic scenarios.

**Diagnosis:** Stage discipline weak. Claude is jumping to offer whenever it sees a pain keyword, violating the "no-skip-stages" rule.

**Fix candidates:**
- Add stage-gating logic to system prompt: "Only fire Play 25 after a 'that's right' or explicit engagement signal"
- Add `requires_prior_play` metadata to plays.json (Play 25 requires Play 22/23/24 first)
- Explicit examples in prompt of when NOT to fire Play 25

### Pattern: `action=generate` fires too often

**Symptom:** Fallback count is high; Claude is generating custom responses instead of picking plays.

**Diagnosis:** Playbook coverage gap OR Claude's "confidence threshold" for play selection too high.

**Fix candidates:**
- Review which scenarios generated fallbacks — are those real gaps in the playbook?
- If yes: add new plays covering those situations
- If no (play exists but Claude missed it): strengthen the play's `triggers` list

### Pattern: Latency > 3.5s average

**Symptom:** Average latency in aggregate block exceeds 3500ms.

**Diagnosis:** Model struggling with prompt size OR network slow.

**Fix candidates:**
- Reduce playbook size (consolidate plays)
- Cut `max_tokens` from 180 to 120
- Verify prompt caching is actually working (check usage metrics in Anthropic console)
- Consider Haiku 4.5 for play-selection (keep Sonnet for generation only)

### Pattern: Null responses when a hint was expected

**Symptom:** Many turns return null when `expectCoach.anyOf` was specified.

**Diagnosis:** Claude is being too conservative about silence, OR `shouldAskCoach` gating logic too strict.

**Fix candidates:**
- Soften silence-preference language in system prompt
- Verify test harness is actually sending prospect-final segments
- Check `shouldAskCoach` time thresholds aren't filtering test scenarios

## What Claude will NOT do

- Suggest rewriting the whole prompt from scratch (too destructive)
- Suggest changing the model without usage-based evidence
- Suggest adding new features unrelated to the failures
- Claim a single fix will make everything pass (usually 2-3 iterations)

## Recommended cadence

| When | Run |
|------|-----|
| Changed `plays.json` | Full eval (all 25) |
| Changed `prompt.ts` | Full eval (all 25) |
| Changed routing/state in `CallSession.tsx` | Edge cases + one pitch scenario |
| Changed model string | Full eval + compare latency |
| Just fixing a UI bug | Skip evals |
| Before first real call each day | Single `pitch-01-full-progression` as smoke test |

## Output format when Seb pastes a run

When pasting eval output, tell Claude one of:
- `"Analyze this"` — default 5-output analysis
- `"Compare to [previous run]"` — diff mode
- `"Just show me the top fix"` — abbreviated mode for when time is short

Claude will respect brevity requests. Default is full rubric.
