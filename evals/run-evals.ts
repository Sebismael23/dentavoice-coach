#!/usr/bin/env node
/**
 * DentaVoice Coach — Eval Harness
 * ================================
 *
 * Replays scripted prospect dialogues against the live /api/coach endpoint.
 * For each scenario, feeds transcript turns progressively (simulating real-time
 * streaming), collects hints, and scores them against expected behavior.
 *
 * USAGE:
 *   # 1. Start your dev server in another terminal:
 *   npm run dev
 *
 *   # 2. Run all scenarios:
 *   npx tsx evals/run-evals.ts
 *
 *   # 3. Run a single scenario:
 *   npx tsx evals/run-evals.ts --only money-thread-1
 *
 *   # 4. Verbose mode (full transcripts + raw LLM responses):
 *   npx tsx evals/run-evals.ts --verbose
 *
 *   # 5. Save results for Claude to analyze:
 *   npx tsx evals/run-evals.ts > evals/results/run-$(date +%Y%m%d-%H%M%S).txt
 *
 * OUTPUT:
 *   - Per-scenario pass/fail with specific mismatches
 *   - Aggregate scorecard by play category, thread, and stage
 *   - Cost estimate (approximate tokens used)
 *   - Paste full stdout to Claude for deep analysis
 */

import fs from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ScenarioTurn {
  speaker: 'prospect' | 'me';
  text: string;
  /** After this turn fires, optional expected coach behavior. */
  expectCoach?: {
    /** Must fire one of these play IDs. */
    anyOf?: number[];
    /** Must NOT fire any of these. */
    noneOf?: number[];
    /** Must set thread to this value (after Bug 3 fix lands). */
    thread?: string;
    /** Must be null (silence expected). */
    silence?: boolean;
    /** Free-form description of ideal behavior — for Claude to interpret. */
    idealBehavior?: string;
  };
}

interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Realistic call context Seb would type. */
  callContext: string;
  /** Primary skill being tested. */
  category:
    | 'gatekeeper-opening'
    | 'gatekeeper-test'
    | 'diagnostic-thread-detection'
    | 'diagnostic-follow-through'
    | 'objection-handling'
    | 'pitch-progression'
    | 'close'
    | 'recovery'
    | 'edge-case';
  /** The conversation script. */
  turns: ScenarioTurn[];
}

interface CoachHint {
  turnIndex: number;
  prospectContext: string;
  seSaid: string | null;
  response: any;
  latencyMs: number;
  renderedSay: string | null;
  renderedPlayId: number | null;
  thread: string | null;
}

interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  hints: CoachHint[];
  checks: Array<{
    turnIndex: number;
    check: string;
    passed: boolean;
    detail: string;
  }>;
  errors: string[];
  totalLatencyMs: number;
  approxCostUsd: number;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const API_URL = process.env.COACH_API_URL || 'http://localhost:3000/api/coach';
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const VERBOSE = process.argv.includes('--verbose');
const ONLY_ARG_IDX = process.argv.indexOf('--only');
const ONLY_SCENARIO =
  ONLY_ARG_IDX >= 0 ? process.argv[ONLY_ARG_IDX + 1] : null;

// Rough cost estimate: Sonnet 4.6 with caching
// Cached input ~$0.30/MTok, output ~$15/MTok
// Each call: ~2500 cached tokens + ~150 output tokens
const APPROX_COST_PER_CALL_USD = (2500 * 0.3 + 150 * 15) / 1_000_000;

// -----------------------------------------------------------------------------
// Load playbook for display
// -----------------------------------------------------------------------------

const playsPath = path.join(
  __dirname,
  '..',
  'data',
  'plays.json'
);
const plays: Array<{ id: number; name: string; stage: string }> = JSON.parse(
  fs.readFileSync(playsPath, 'utf-8')
);
const playNameById = new Map(plays.map((p) => [p.id, p.name]));
const playStageById = new Map(plays.map((p) => [p.id, p.stage]));

function formatPlayRef(id: number | null): string {
  if (id === null) return 'none';
  const name = playNameById.get(id) || '?';
  return `#${id} (${name})`;
}

// -----------------------------------------------------------------------------
// Build transcript segments in the shape the real app sends
// -----------------------------------------------------------------------------

interface TranscriptSegment {
  id: string;
  speaker: 'prospect' | 'me';
  text: string;
  timestamp: number;
  isFinal: boolean;
}

function buildSegmentsFromTurns(
  turns: ScenarioTurn[],
  upToIndex: number
): TranscriptSegment[] {
  // Simulate real-time timestamps: each turn ~3 seconds apart.
  // Keep the last 60 seconds worth (matching windowSeconds default).
  const now = Date.now();
  const segments: TranscriptSegment[] = [];
  const SPACING_MS = 3000;

  for (let i = 0; i <= upToIndex; i++) {
    const turn = turns[i];
    // Timestamp: older turns get older timestamps.
    const turnAge = (upToIndex - i) * SPACING_MS;
    const timestamp = now - turnAge;

    segments.push({
      id: `s${i}-${Math.random().toString(36).slice(2, 8)}`,
      speaker: turn.speaker,
      text: turn.text,
      timestamp,
      isFinal: true,
    });
  }

  // Trim to last 60 seconds (matching the real app's trimTranscript)
  const cutoff = now - 60_000;
  return segments.filter((s) => s.timestamp >= cutoff);
}

// -----------------------------------------------------------------------------
// Run one scenario
// -----------------------------------------------------------------------------

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    hints: [],
    checks: [],
    errors: [],
    totalLatencyMs: 0,
    approxCostUsd: 0,
  };

  // Session-persistent state, mirroring the real CallSession
  const hintHistory: Array<{
    timestamp: number;
    playId: number | null;
    preview: string;
  }> = [];
  let currentThread = 'unknown';
  let lastHintAt: number | null = null;

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];

    // Only call the coach after prospect turns (matching shouldAskCoach logic).
    // Seb's own turns are added to the transcript but don't trigger a coach call.
    if (turn.speaker !== 'prospect') continue;

    const segments = buildSegmentsFromTurns(scenario.turns, i);

    let response: any = null;
    let latencyMs = 0;
    const t0 = Date.now();

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: segments,
          lastHintAt,
          callContext: scenario.callContext,
          hintHistory,
          currentThread,
        }),
      });
      latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text();
        result.errors.push(
          `Turn ${i} HTTP ${res.status}: ${body.slice(0, 200)}`
        );
        continue;
      }

      const data = await res.json();
      response = data.result;
      result.approxCostUsd += APPROX_COST_PER_CALL_USD;
    } catch (err: any) {
      result.errors.push(`Turn ${i} network error: ${err.message}`);
      continue;
    }

    result.totalLatencyMs += latencyMs;

    // Parse rendered hint
    let renderedSay: string | null = null;
    let renderedPlayId: number | null = null;
    let threadReturned: string | null = null;

    if (response && response.action === 'play') {
      renderedPlayId = response.play_id;
      const play = plays.find((p) => p.id === response.play_id);
      renderedSay = play
        ? play.name // we don't re-run personalization here, just name
        : '<unknown play>';
      threadReturned = response.thread || null;

      hintHistory.push({
        timestamp: Date.now(),
        playId: response.play_id,
        preview: renderedSay.slice(0, 60),
      });
      if (hintHistory.length > 8) hintHistory.shift();
      lastHintAt = Date.now();
    } else if (response && response.action === 'generate') {
      renderedSay = response.say || null;
      threadReturned = response.thread || null;

      hintHistory.push({
        timestamp: Date.now(),
        playId: null,
        preview: (response.say || '').slice(0, 60),
      });
      if (hintHistory.length > 8) hintHistory.shift();
      lastHintAt = Date.now();
    }

    if (threadReturned) currentThread = threadReturned;

    const hint: CoachHint = {
      turnIndex: i,
      prospectContext: turn.text,
      seSaid: i > 0 ? scenario.turns[i - 1]?.text || null : null,
      response,
      latencyMs,
      renderedSay,
      renderedPlayId,
      thread: threadReturned,
    };
    result.hints.push(hint);

    // Run assertions from expectCoach
    if (turn.expectCoach) {
      const exp = turn.expectCoach;

      if (exp.silence) {
        const passed = response === null;
        result.checks.push({
          turnIndex: i,
          check: 'silence expected',
          passed,
          detail: passed
            ? 'ok'
            : `expected null, got ${formatPlayRef(renderedPlayId)}`,
        });
      }

      if (exp.anyOf && exp.anyOf.length > 0) {
        const passed =
          renderedPlayId !== null && exp.anyOf.includes(renderedPlayId);
        result.checks.push({
          turnIndex: i,
          check: `play must be one of [${exp.anyOf.join(', ')}]`,
          passed,
          detail: passed
            ? `got ${formatPlayRef(renderedPlayId)}`
            : `got ${formatPlayRef(renderedPlayId)}, expected one of [${exp.anyOf.map((id) => `#${id}`).join(', ')}]`,
        });
      }

      if (exp.noneOf && exp.noneOf.length > 0) {
        const passed =
          renderedPlayId === null || !exp.noneOf.includes(renderedPlayId);
        result.checks.push({
          turnIndex: i,
          check: `play must NOT be any of [${exp.noneOf.join(', ')}]`,
          passed,
          detail: passed
            ? `ok (got ${formatPlayRef(renderedPlayId)})`
            : `got ${formatPlayRef(renderedPlayId)} — forbidden`,
        });
      }

      if (exp.thread) {
        const passed = threadReturned === exp.thread;
        result.checks.push({
          turnIndex: i,
          check: `thread must be "${exp.thread}"`,
          passed,
          detail: passed ? 'ok' : `got "${threadReturned || 'null'}"`,
        });
      }
    }

    if (VERBOSE) {
      console.log(
        `  turn ${i} prospect: "${turn.text.slice(0, 60)}" -> ${formatPlayRef(renderedPlayId)} (${latencyMs}ms, thread=${threadReturned || '-'})`
      );
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Load scenarios
// -----------------------------------------------------------------------------

function loadScenarios(): Scenario[] {
  const files = fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((f) => {
    const content = fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf-8');
    return JSON.parse(content) as Scenario;
  });
}

// -----------------------------------------------------------------------------
// Format results
// -----------------------------------------------------------------------------

function formatResults(results: ScenarioResult[]) {
  console.log('\n');
  console.log('='.repeat(80));
  console.log('DENTAVOICE COACH — EVAL RESULTS');
  console.log('='.repeat(80));
  console.log(`Ran at: ${new Date().toISOString()}`);
  console.log(`API:    ${API_URL}`);
  console.log(`Scenarios: ${results.length}`);
  console.log('');

  // Per-scenario
  for (const r of results) {
    const passCount = r.checks.filter((c) => c.passed).length;
    const totalChecks = r.checks.length;
    const passRate = totalChecks === 0 ? 'n/a' : `${passCount}/${totalChecks}`;
    const status =
      r.errors.length > 0
        ? 'ERROR'
        : totalChecks === 0
          ? 'RAN'
          : passCount === totalChecks
            ? 'PASS'
            : 'FAIL';

    console.log(
      `[${status}] ${r.scenarioId.padEnd(30)} ${passRate.padEnd(8)} ${r.category}`
    );
    console.log(`         ${r.scenarioName}`);

    if (r.errors.length > 0) {
      for (const e of r.errors) console.log(`  ERROR: ${e}`);
    }

    for (const c of r.checks) {
      if (!c.passed) {
        console.log(`  FAIL turn ${c.turnIndex}: ${c.check}`);
        console.log(`       ${c.detail}`);
      }
    }
    console.log('');
  }

  // Hint traces for failed/partial scenarios
  const needsTrace = results.filter(
    (r) =>
      r.errors.length > 0 ||
      r.checks.some((c) => !c.passed)
  );

  if (needsTrace.length > 0) {
    console.log('='.repeat(80));
    console.log('HINT TRACES FOR FAILING SCENARIOS');
    console.log('='.repeat(80));
    for (const r of needsTrace) {
      console.log(`\n--- ${r.scenarioId} ---`);
      for (const h of r.hints) {
        console.log(
          `  [turn ${h.turnIndex}] prospect: "${h.prospectContext.slice(0, 70)}"`
        );
        console.log(
          `             coach: ${formatPlayRef(h.renderedPlayId)} thread=${h.thread || '-'} latency=${h.latencyMs}ms`
        );
      }
    }
  }

  // Aggregate
  console.log('');
  console.log('='.repeat(80));
  console.log('AGGREGATE');
  console.log('='.repeat(80));

  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const c = byCategory.get(r.category) || { pass: 0, total: 0 };
    c.pass += r.checks.filter((x) => x.passed).length;
    c.total += r.checks.length;
    byCategory.set(r.category, c);
  }

  for (const [cat, stats] of byCategory) {
    const pct =
      stats.total === 0
        ? 'n/a'
        : `${Math.round((100 * stats.pass) / stats.total)}%`;
    console.log(
      `  ${cat.padEnd(35)} ${stats.pass}/${stats.total} (${pct})`
    );
  }

  const totalHints = results.reduce((s, r) => s + r.hints.length, 0);
  const totalLatency = results.reduce((s, r) => s + r.totalLatencyMs, 0);
  const avgLatency = totalHints > 0 ? Math.round(totalLatency / totalHints) : 0;
  const totalCost = results.reduce((s, r) => s + r.approxCostUsd, 0);
  const totalChecks = results.reduce((s, r) => s + r.checks.length, 0);
  const totalPassed = results.reduce(
    (s, r) => s + r.checks.filter((c) => c.passed).length,
    0
  );
  const overallPct =
    totalChecks === 0
      ? 0
      : Math.round((100 * totalPassed) / totalChecks);

  console.log('');
  console.log(`  Total scenarios:  ${results.length}`);
  console.log(`  Total hints:      ${totalHints}`);
  console.log(`  Total checks:     ${totalChecks}`);
  console.log(`  Passed:           ${totalPassed} (${overallPct}%)`);
  console.log(`  Avg latency:      ${avgLatency}ms`);
  console.log(`  Approx cost:      $${totalCost.toFixed(4)}`);
  console.log('='.repeat(80));
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const allScenarios = loadScenarios();
  const scenarios = ONLY_SCENARIO
    ? allScenarios.filter((s) => s.id === ONLY_SCENARIO)
    : allScenarios;

  if (scenarios.length === 0) {
    console.error(
      ONLY_SCENARIO
        ? `No scenario found with id "${ONLY_SCENARIO}"`
        : 'No scenarios found in evals/scenarios/'
    );
    process.exit(1);
  }

  console.log(
    `Running ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} against ${API_URL}\n`
  );

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    if (!VERBOSE) process.stdout.write(`  ${s.id}...`);
    try {
      const r = await runScenario(s);
      results.push(r);
      if (!VERBOSE) {
        const failed = r.checks.filter((c) => !c.passed).length;
        const errors = r.errors.length;
        const status =
          errors > 0 ? 'ERROR' : failed === 0 ? 'ok' : `${failed} failed`;
        console.log(` ${status}`);
      }
    } catch (err: any) {
      console.error(`\nSCENARIO CRASHED: ${s.id}: ${err.message}`);
      results.push({
        scenarioId: s.id,
        scenarioName: s.name,
        category: s.category,
        hints: [],
        checks: [],
        errors: [`crashed: ${err.message}`],
        totalLatencyMs: 0,
        approxCostUsd: 0,
      });
    }
  }

  formatResults(results);

  const anyFail =
    results.some((r) => r.errors.length > 0) ||
    results.some((r) => r.checks.some((c) => !c.passed));
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
