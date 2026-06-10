#!/usr/bin/env npx tsx
// -----------------------------------------------------------------------------
// Automated coaching test runner
// -----------------------------------------------------------------------------
// Replays transcript scenarios against /api/coach and grades responses.
// No Deepgram, no audio, no browser — pure API testing.
//
// Usage:
//   npx tsx tests/run.ts                  # run all scenarios
//   npx tsx tests/run.ts --scenario 3     # run scenario #3 only
//   npx tsx tests/run.ts --verbose        # show every API response
// -----------------------------------------------------------------------------

import { SCENARIOS, type TestScenario, type ExpectedOutcome } from './scenarios';
import type { TranscriptSegment } from '../lib/types';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';
const VERBOSE = process.argv.includes('--verbose');
const scenarioFilter = process.argv.find(a => a.startsWith('--scenario'));
const scenarioIndex = scenarioFilter ? parseInt(process.argv[process.argv.indexOf(scenarioFilter) + 1]) - 1 : null;

// ANSI colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

interface CoachAPIResponse {
  result: any;
  raw: string;
}

async function callCoach(body: Record<string, any>): Promise<CoachAPIResponse> {
  const res = await fetch(`${BASE_URL}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }

  // API now returns SSE stream — consume it and parse the accumulated JSON
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.t) accumulated += parsed.t;
      } catch { /* skip */ }
    }
  }

  // Parse accumulated text as coach response
  const cleaned = accumulated.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let result: any = null;
  if (cleaned && cleaned !== 'null') {
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace >= 0) {
      let depth = 0, end = -1;
      for (let i = firstBrace; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > firstBrace) {
        try { result = JSON.parse(cleaned.slice(firstBrace, end + 1)); } catch {}
      }
    }
  }

  return { result, raw: accumulated };
}

function buildSegments(
  scenario: TestScenario,
  upToIndex: number
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const baseTime = Date.now() - 60000; // start 60s ago so they're in the window

  for (let i = 0; i <= upToIndex && i < scenario.segments.length; i++) {
    const s = scenario.segments[i];
    segments.push({
      id: `test-${i}`,
      speaker: s.speaker,
      text: s.text,
      timestamp: baseTime + i * 3000, // 3s apart
      isFinal: true,
    });
  }
  return segments;
}

interface CheckResult {
  passed: boolean;
  message: string;
  details?: string;
}

function checkExpectation(
  expectation: ExpectedOutcome,
  result: any,
  _phase: string,
): CheckResult {
  const checks: string[] = [];
  const failures: string[] = [];

  // Check action.
  // FORMAT NOTE: the April adaptive rewrite removed the old { action: 'play' }
  // shape. A hint is now { say, move, signal, why, play_id, thread, step }.
  // expectation.action === 'play'/'generate' therefore means: "a non-null
  // coaching hint with speakable words was returned".
  const isHint = result !== null && typeof result?.say === 'string' && result.say.length > 0;
  if (expectation.action !== undefined) {
    if (expectation.action === null) {
      if (result !== null) {
        failures.push(`Expected null but got hint: play=${result?.play_id} step=${result?.step} say="${String(result?.say).slice(0, 50)}"`);
      } else {
        checks.push('✓ null (silence)');
      }
    } else {
      if (!isHint) {
        failures.push(`Expected a coaching hint but got ${result === null ? 'null' : 'malformed response'}`);
      } else {
        checks.push(`✓ hint (move=${result.move}${result.step ? `, step=${result.step}` : ''})`);
      }
    }
  }

  // Check play_id
  if (expectation.playId !== undefined && isHint) {
    const acceptable = [expectation.playId, ...(expectation.acceptablePlayIds || [])];
    if (result.play_id == null) {
      failures.push(`Expected play ${acceptable.join('|')} but hint cited no play (move=${result.move}, step=${result.step}, say="${String(result.say).slice(0, 50)}")`);
    } else if (!acceptable.includes(result.play_id)) {
      failures.push(`Expected play ${acceptable.join('|')} but got play ${result.play_id} (move=${result.move}, step=${result.step})`);
    } else {
      checks.push(`✓ play_id=${result.play_id}`);
    }
  } else if (expectation.acceptablePlayIds && isHint) {
    if (result.play_id == null || !expectation.acceptablePlayIds.includes(result.play_id)) {
      failures.push(`Expected play ${expectation.acceptablePlayIds.join('|')} but got play ${result.play_id ?? 'none'} (move=${result.move}, step=${result.step})`);
    } else {
      checks.push(`✓ play_id=${result.play_id} (in acceptable set)`);
    }
  }

  // Check forbidden plays
  if (expectation.forbiddenPlayIds && isHint && result.play_id != null) {
    if (expectation.forbiddenPlayIds.includes(result.play_id)) {
      failures.push(`FORBIDDEN play ${result.play_id} was selected!`);
    } else {
      checks.push(`✓ not forbidden`);
    }
  }

  // Check thread
  if (expectation.thread && result?.thread) {
    if (result.thread !== expectation.thread) {
      failures.push(`Expected thread=${expectation.thread} but got ${result.thread}`);
    } else {
      checks.push(`✓ thread=${result.thread}`);
    }
  } else if (expectation.thread && result && !result.thread) {
    failures.push(`Expected thread=${expectation.thread} but no thread in response`);
  }

  return {
    passed: failures.length === 0,
    message: failures.length === 0
      ? checks.join(', ')
      : failures.join('; '),
    details: VERBOSE ? JSON.stringify(result, null, 2) : undefined,
  };
}

async function runScenario(scenario: TestScenario, index: number): Promise<{ passed: number; failed: number; total: number }> {
  console.log(`\n${BOLD}━━━ Scenario ${index + 1}: ${scenario.name}${RESET}`);

  let passed = 0;
  let failed = 0;

  // Track state across turns (like the real app does)
  let currentThread = 'unknown';
  let usedPlayIds: number[] = [...(scenario.initialUsedPlayIds || [])];
  let lastHintSay: string | null = null;
  let consecutiveNulls = 0;
  let phase: 'gatekeeper' | 'dm' = scenario.initialPhase || 'gatekeeper';

  // Group expectations by afterProspectTurn
  const expectationsByTurn = new Map<number, ExpectedOutcome[]>();
  for (const exp of scenario.expectations) {
    const list = expectationsByTurn.get(exp.afterProspectTurn) || [];
    list.push(exp);
    expectationsByTurn.set(exp.afterProspectTurn, list);
  }

  // Walk through segments, fire API at each prospect turn
  let prospectTurnIndex = 0;
  for (let i = 0; i < scenario.segments.length; i++) {
    const seg = scenario.segments[i];

    if (seg.speaker === 'prospect') {
      // Check if we have expectations for this turn
      const expectations = expectationsByTurn.get(prospectTurnIndex);

      if (expectations) {
        const transcript = buildSegments(scenario, i);

        const body: Record<string, any> = {
          transcript,
          lastHintAt: null,
          callContext: scenario.callContext || '',
          callPhase: phase,
          currentThread,
          usedPlayIds: usedPlayIds.length > 0 ? usedPlayIds : undefined,
          consecutiveNulls,
          lastHintSay: lastHintSay || undefined,
        };

        try {
          const { result } = await callCoach(body);

          // Update state from response
          if (result === null) {
            consecutiveNulls++;
          } else {
            consecutiveNulls = 0;
            if (result.thread) currentThread = result.thread;
            if (result.play_id) {
              usedPlayIds.push(result.play_id);
              lastHintSay = typeof result.say === 'string' ? result.say : `(play ${result.play_id})`;
            } else if (result.action === 'generate') {
              lastHintSay = result.say;
            }
          }

          for (const exp of expectations) {
            const check = checkExpectation(exp, result, phase);
            if (check.passed) {
              console.log(`  ${GREEN}PASS${RESET} ${exp.description}`);
              if (check.message) console.log(`       ${DIM}${check.message}${RESET}`);
              passed++;
            } else {
              console.log(`  ${RED}FAIL${RESET} ${exp.description}`);
              console.log(`       ${RED}${check.message}${RESET}`);
              if (result) {
                console.log(`       ${DIM}Got: action=${result.action} play=${result.play_id} thread=${result.thread}${RESET}`);
              } else {
                console.log(`       ${DIM}Got: null${RESET}`);
              }
              failed++;
            }
            if (check.details) console.log(`       ${DIM}${check.details}${RESET}`);
          }
        } catch (err: any) {
          console.log(`  ${RED}ERROR${RESET} ${err.message}`);
          failed += expectations.length;
        }
      }

      prospectTurnIndex++;
    }
  }

  return { passed, failed, total: passed + failed };
}

async function main() {
  console.log(`${BOLD}DentaVoice Coach — Automated Test Runner${RESET}`);
  console.log(`${DIM}Target: ${BASE_URL}${RESET}`);

  // Verify server is up
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    console.error(`${RED}Server not reachable at ${BASE_URL}. Start it first.${RESET}`);
    process.exit(1);
  }

  const scenarios = scenarioIndex !== null
    ? [SCENARIOS[scenarioIndex]]
    : SCENARIOS;

  let totalPassed = 0;
  let totalFailed = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const actualIndex = scenarioIndex !== null ? scenarioIndex : i;
    const { passed, failed } = await runScenario(scenarios[i], actualIndex);
    totalPassed += passed;
    totalFailed += failed;
  }

  console.log(`\n${BOLD}━━━ Results ━━━${RESET}`);
  console.log(`  ${GREEN}${totalPassed} passed${RESET}  ${totalFailed > 0 ? `${RED}${totalFailed} failed${RESET}` : ''}`);
  console.log(`  ${totalPassed + totalFailed} total checks across ${scenarios.length} scenarios`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
