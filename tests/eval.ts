#!/usr/bin/env npx tsx
// -----------------------------------------------------------------------------
// DentaVoice Coach — Quality Eval System (LLM-as-Judge)
// -----------------------------------------------------------------------------
// Unlike run.ts (pass/fail gate), this evaluates QUALITY of coaching responses.
// Uses Claude as a judge to score each response on 6 dimensions (1–5).
// Saves timestamped results so you can track improvement over time.
//
// Usage:
//   npx tsx tests/eval.ts                    # full eval, save results
//   npx tsx tests/eval.ts --scenario 3       # eval scenario #3 only
//   npx tsx tests/eval.ts --compare          # compare last 2 runs
//   npx tsx tests/eval.ts --history          # show score trend over time
// -----------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { SCENARIOS, type TestScenario } from './scenarios';
import type { TranscriptSegment } from '../lib/types';

// Load .env.local so we get ANTHROPIC_API_KEY outside of Next.js
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';
const RESULTS_DIR = path.join(__dirname, 'eval-results');

// ANSI
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const scenarioFilter = process.argv.find(a => a.startsWith('--scenario'));
const scenarioIndex = scenarioFilter ? parseInt(process.argv[process.argv.indexOf(scenarioFilter) + 1]) - 1 : null;
const compareMode = process.argv.includes('--compare');
const historyMode = process.argv.includes('--history');

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface DimensionScore {
  score: number;       // 1–5
  feedback: string;    // specific, actionable
}

interface TurnEval {
  scenarioIndex: number;
  scenarioName: string;
  prospectTurn: number;
  prospectSaid: string;
  coachResponse: any;          // raw response from API
  latencyMs: number;
  scores: {
    relevance: DimensionScore;     // Does it address what just happened?
    naturalness: DimensionScore;   // Would this sound natural spoken aloud?
    advancement: DimensionScore;   // Does it move the call forward?
    conciseness: DimensionScore;   // Appropriate brevity for live call?
    tactical: DimensionScore;      // Is the chosen move/play correct for this moment?
    energy: DimensionScore;        // Does tone match the prospect's energy?
  };
  avgScore: number;
  improvement: string;           // specific suggestion from judge
}

interface EvalRun {
  timestamp: string;
  model: string;
  totalTurns: number;
  avgLatencyMs: number;
  overallAvg: number;
  dimensionAvgs: Record<string, number>;
  turns: TurnEval[];
  worstTurns: TurnEval[];        // bottom 5 by avgScore
  improvements: string[];        // deduplicated suggestions
}

// ---------------------------------------------------------------------------
// SSE CONSUMER — reads the streaming API response
// ---------------------------------------------------------------------------

async function callCoachSSE(body: Record<string, any>): Promise<{ result: any; latencyMs: number; raw: string }> {
  const start = Date.now();

  const res = await fetch(`${BASE_URL}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }

  // Consume SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let firstTokenMs: number | null = null;

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
        if (parsed.t) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - start;
          accumulated += parsed.t;
        }
      } catch { /* skip malformed */ }
    }
  }

  const latencyMs = Date.now() - start;

  // Parse the accumulated text as coach response
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

  return { result, latencyMs, raw: accumulated };
}

// ---------------------------------------------------------------------------
// JUDGE — Claude evaluates quality of each coaching response
// ---------------------------------------------------------------------------

const judgeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JUDGE_PROMPT = `You are an expert sales coaching evaluator. You evaluate AI-generated real-time coaching hints for cold calls to dental practices.

CONTEXT: A salesperson ("Seb") is calling dental practices to sell DentaVoice (AI phone receptionist, $297/mo, free 14-day trial). An AI coach watches the live transcript and tells Seb what to say. You judge the QUALITY of each coaching response.

SCORING DIMENSIONS (1–5 each):

1. RELEVANCE — Does the coaching directly address what the prospect just said/asked?
   5 = Perfectly addresses the prospect's words, energy, and subtext
   3 = Somewhat related but misses the key point or ignores something important
   1 = Completely off-topic or addresses something the prospect never said

2. NATURALNESS — Would this sound natural if spoken aloud on a phone call?
   5 = Sounds like a real human conversation, flows naturally
   3 = Sounds somewhat scripted but passable
   1 = Robotic, stilted, or clearly AI-generated phrasing

3. ADVANCEMENT — Does it move the call toward the next logical stage?
   5 = Clearly advances to the right next step (e.g., diagnostic → pitch → close)
   3 = Maintains position but doesn't advance
   1 = Goes backward, repeats a completed stage, or derails the conversation

4. CONCISENESS — Is it appropriately brief for a live call? (Target: ≤30 words in "say")
   5 = Tight, punchy, perfect length for live coaching
   3 = A bit wordy but usable
   1 = Way too long, Seb would lose track mid-sentence

5. TACTICAL ACCURACY — Is the chosen move/play appropriate for this call phase and moment?
   5 = Perfect tactic choice (right phase, right stage, right thread)
   3 = Acceptable tactic but not the best option
   1 = Wrong phase (e.g., pitching a gatekeeper), wrong stage (e.g., closing before diagnosing)

6. ENERGY MATCH — Does the coaching match the prospect's energy/mood?
   5 = Perfectly mirrors their tempo, formality, and emotional state
   3 = Neutral tone that doesn't clash but doesn't match either
   1 = Completely mismatched (e.g., bubbly response to angry prospect, long response to rushed one)

RESPONSE FORMAT (strict JSON):
{
  "relevance": { "score": <1-5>, "feedback": "<specific observation>" },
  "naturalness": { "score": <1-5>, "feedback": "<specific observation>" },
  "advancement": { "score": <1-5>, "feedback": "<specific observation>" },
  "conciseness": { "score": <1-5>, "feedback": "<specific observation>" },
  "tactical": { "score": <1-5>, "feedback": "<specific observation>" },
  "energy": { "score": <1-5>, "feedback": "<specific observation>" },
  "improvement": "<ONE specific, actionable thing to change to make this response better — be concrete>"
}

Return ONLY the JSON. No markdown fences, no explanation.`;

async function judgeResponse(
  context: {
    scenarioName: string;
    callContext: string;
    phase: string;
    thread: string;
    transcriptSoFar: string;
    prospectJustSaid: string;
    coachResponse: any;
  }
): Promise<{ scores: TurnEval['scores']; improvement: string }> {
  const coachText = context.coachResponse
    ? JSON.stringify(context.coachResponse, null, 2)
    : 'null (silence — coach chose not to respond)';

  const msg = await judgeClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: JUDGE_PROMPT,
    messages: [{
      role: 'user',
      content: `SCENARIO: ${context.scenarioName}
CALL PHASE: ${context.phase}
ACTIVE THREAD: ${context.thread}
CALL CONTEXT: ${context.callContext || '(none)'}

TRANSCRIPT SO FAR:
${context.transcriptSoFar}

PROSPECT JUST SAID: "${context.prospectJustSaid}"

COACH RESPONSE:
${coachText}

Judge this coaching response.`,
    }],
  });

  const text = (msg.content[0] as any).text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    // Extract first JSON object from the response
    let jsonStr = text;
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
      let depth = 0, end = -1;
      for (let i = firstBrace; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > firstBrace) jsonStr = text.slice(firstBrace, end + 1);
    }
    const parsed = JSON.parse(jsonStr);

    return {
      scores: {
        relevance: parsed.relevance,
        naturalness: parsed.naturalness,
        advancement: parsed.advancement,
        conciseness: parsed.conciseness,
        tactical: parsed.tactical,
        energy: parsed.energy,
      },
      improvement: parsed.improvement || '',
    };
  } catch {
    const fallback: DimensionScore = { score: 3, feedback: 'Judge parse error' };
    return {
      scores: {
        relevance: fallback, naturalness: fallback, advancement: fallback,
        conciseness: fallback, tactical: fallback, energy: fallback,
      },
      improvement: 'Judge response was malformed — re-run eval',
    };
  }
}

// ---------------------------------------------------------------------------
// SCENARIO RUNNER
// ---------------------------------------------------------------------------

function buildSegments(scenario: TestScenario, upToIndex: number): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const baseTime = Date.now() - 60000;
  for (let i = 0; i <= upToIndex && i < scenario.segments.length; i++) {
    const s = scenario.segments[i];
    segments.push({
      id: `eval-${i}`,
      speaker: s.speaker,
      text: s.text,
      timestamp: baseTime + i * 3000,
      isFinal: true,
    });
  }
  return segments;
}

function buildTranscriptText(scenario: TestScenario, upToIndex: number): string {
  return scenario.segments
    .slice(0, upToIndex + 1)
    .map(s => `${s.speaker === 'prospect' ? 'PROSPECT' : 'SEB'}: ${s.text}`)
    .join('\n');
}

async function evalScenario(scenario: TestScenario, sIdx: number): Promise<TurnEval[]> {
  console.log(`\n${BOLD}━━━ Scenario ${sIdx + 1}: ${scenario.name}${RESET}`);

  const turns: TurnEval[] = [];
  let currentThread = 'unknown';
  let usedPlayIds: number[] = [...(scenario.initialUsedPlayIds || [])];
  let lastHintSay: string | null = null;
  let consecutiveNulls = 0;
  let phase: 'gatekeeper' | 'dm' = scenario.initialPhase || 'gatekeeper';

  let prospectTurnIndex = 0;
  for (let i = 0; i < scenario.segments.length; i++) {
    const seg = scenario.segments[i];
    if (seg.speaker !== 'prospect') continue;

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
      const { result, latencyMs, raw } = await callCoachSSE(body);

      // Update state
      if (result === null) {
        consecutiveNulls++;
      } else {
        consecutiveNulls = 0;
        if (result.thread) currentThread = result.thread;
        if (result.play_id) {
          usedPlayIds.push(result.play_id);
          lastHintSay = result.say || `(play ${result.play_id})`;
        } else if (result.say) {
          lastHintSay = result.say;
        }
      }

      // Judge this response
      const { scores, improvement } = await judgeResponse({
        scenarioName: scenario.name,
        callContext: scenario.callContext || '',
        phase,
        thread: currentThread,
        transcriptSoFar: buildTranscriptText(scenario, i),
        prospectJustSaid: seg.text,
        coachResponse: result,
      });

      const dims = Object.values(scores);
      const avgScore = dims.reduce((s, d) => s + d.score, 0) / dims.length;

      const turn: TurnEval = {
        scenarioIndex: sIdx,
        scenarioName: scenario.name,
        prospectTurn: prospectTurnIndex,
        prospectSaid: seg.text,
        coachResponse: result,
        latencyMs,
        scores,
        avgScore,
        improvement,
      };
      turns.push(turn);

      // Print inline
      const scoreColor = avgScore >= 4 ? GREEN : avgScore >= 3 ? YELLOW : RED;
      const sayPreview = result?.say?.slice(0, 50) || '(null)';
      console.log(`  ${scoreColor}${avgScore.toFixed(1)}${RESET} ${DIM}${latencyMs}ms${RESET} P:"${seg.text.slice(0, 40)}…" → "${sayPreview}…"`);

      // Show low-scoring dimensions
      for (const [dim, d] of Object.entries(scores)) {
        if ((d as DimensionScore).score <= 2) {
          console.log(`       ${RED}↓ ${dim}: ${(d as DimensionScore).score}/5 — ${(d as DimensionScore).feedback}${RESET}`);
        }
      }

    } catch (err: any) {
      console.log(`  ${RED}ERROR${RESET} ${err.message}`);
    }

    prospectTurnIndex++;
  }

  return turns;
}

// ---------------------------------------------------------------------------
// REPORT GENERATION
// ---------------------------------------------------------------------------

function generateReport(run: EvalRun): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  lines.push(`${BOLD}${CYAN}  DENTAVOICE COACH — QUALITY EVAL REPORT${RESET}`);
  lines.push(`${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  lines.push(`${DIM}${run.timestamp}  |  ${run.totalTurns} turns evaluated${RESET}`);
  lines.push('');

  // Overall score
  const overallColor = run.overallAvg >= 4 ? GREEN : run.overallAvg >= 3 ? YELLOW : RED;
  lines.push(`${BOLD}  OVERALL SCORE: ${overallColor}${run.overallAvg.toFixed(2)} / 5.00${RESET}`);
  lines.push(`${BOLD}  AVG LATENCY:   ${run.avgLatencyMs < 2000 ? GREEN : run.avgLatencyMs < 3000 ? YELLOW : RED}${run.avgLatencyMs}ms${RESET}`);
  lines.push('');

  // Dimension breakdown
  lines.push(`${BOLD}  DIMENSION SCORES:${RESET}`);
  const dimOrder = ['relevance', 'naturalness', 'advancement', 'conciseness', 'tactical', 'energy'];
  for (const dim of dimOrder) {
    const val = run.dimensionAvgs[dim];
    const bar = '█'.repeat(Math.round(val)) + '░'.repeat(5 - Math.round(val));
    const color = val >= 4 ? GREEN : val >= 3 ? YELLOW : RED;
    lines.push(`    ${dim.padEnd(14)} ${color}${bar} ${val.toFixed(2)}${RESET}`);
  }
  lines.push('');

  // Weakest dimension
  const weakest = dimOrder.reduce((a, b) => run.dimensionAvgs[a] < run.dimensionAvgs[b] ? a : b);
  lines.push(`${BOLD}  🎯 WEAKEST AREA: ${RED}${weakest.toUpperCase()} (${run.dimensionAvgs[weakest].toFixed(2)})${RESET}`);
  lines.push(`     Focus your next prompt/system improvement here.`);
  lines.push('');

  // Bottom 5 turns
  lines.push(`${BOLD}  WORST 5 RESPONSES:${RESET}`);
  for (const t of run.worstTurns.slice(0, 5)) {
    const say = t.coachResponse?.say?.slice(0, 50) || '(null)';
    lines.push(`    ${RED}${t.avgScore.toFixed(1)}${RESET} S${t.scenarioIndex + 1}T${t.prospectTurn} "${t.prospectSaid.slice(0, 35)}…"`);
    lines.push(`         → "${say}…"`);
    lines.push(`         ${DIM}Fix: ${t.improvement}${RESET}`);
  }
  lines.push('');

  // Improvement suggestions (deduplicated)
  lines.push(`${BOLD}  TOP IMPROVEMENT ACTIONS:${RESET}`);
  for (let i = 0; i < Math.min(run.improvements.length, 7); i++) {
    lines.push(`    ${YELLOW}${i + 1}.${RESET} ${run.improvements[i]}`);
  }
  lines.push('');

  // Latency distribution
  const latencies = run.turns.map(t => t.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  lines.push(`${BOLD}  LATENCY DISTRIBUTION:${RESET}`);
  lines.push(`    p50: ${p50 < 2000 ? GREEN : YELLOW}${p50}ms${RESET}   p90: ${p90 < 3000 ? GREEN : YELLOW}${p90}ms${RESET}   p99: ${p99 < 4000 ? GREEN : RED}${p99}ms${RESET}`);
  lines.push('');
  lines.push(`${CYAN}═══════════════════════════════════════════════════════════${RESET}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// COMPARISON MODE — diff last 2 runs
// ---------------------------------------------------------------------------

function compareRuns() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.log(`${RED}No eval results found. Run an eval first.${RESET}`);
    process.exit(1);
  }

  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-2);

  if (files.length < 2) {
    console.log(`${RED}Need at least 2 eval runs to compare. Run more evals.${RESET}`);
    process.exit(1);
  }

  const prev: EvalRun = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[0]), 'utf-8'));
  const curr: EvalRun = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[1]), 'utf-8'));

  console.log(`\n${BOLD}${CYAN}═══ EVAL COMPARISON ═══${RESET}`);
  console.log(`${DIM}Prev: ${files[0]}${RESET}`);
  console.log(`${DIM}Curr: ${files[1]}${RESET}\n`);

  const delta = curr.overallAvg - prev.overallAvg;
  const arrow = delta > 0 ? `${GREEN}▲ +${delta.toFixed(2)}` : delta < 0 ? `${RED}▼ ${delta.toFixed(2)}` : `${YELLOW}= 0.00`;
  console.log(`  Overall: ${prev.overallAvg.toFixed(2)} → ${curr.overallAvg.toFixed(2)}  ${arrow}${RESET}`);

  const latDelta = curr.avgLatencyMs - prev.avgLatencyMs;
  const latArrow = latDelta < 0 ? `${GREEN}▲ ${latDelta}ms (faster)` : latDelta > 0 ? `${RED}▼ +${latDelta}ms (slower)` : `${YELLOW}= same`;
  console.log(`  Latency: ${prev.avgLatencyMs}ms → ${curr.avgLatencyMs}ms  ${latArrow}${RESET}`);

  console.log(`\n  ${BOLD}Per dimension:${RESET}`);
  for (const dim of ['relevance', 'naturalness', 'advancement', 'conciseness', 'tactical', 'energy']) {
    const p = prev.dimensionAvgs[dim] || 0;
    const c = curr.dimensionAvgs[dim] || 0;
    const d = c - p;
    const a = d > 0 ? GREEN + '▲' : d < 0 ? RED + '▼' : YELLOW + '=';
    console.log(`    ${dim.padEnd(14)} ${p.toFixed(2)} → ${c.toFixed(2)}  ${a} ${d > 0 ? '+' : ''}${d.toFixed(2)}${RESET}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// HISTORY MODE — show trend
// ---------------------------------------------------------------------------

function showHistory() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.log(`${RED}No eval results found.${RESET}`);
    process.exit(1);
  }

  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log(`${RED}No eval results found.${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}═══ EVAL HISTORY (${files.length} runs) ═══${RESET}\n`);
  console.log(`  ${'Date'.padEnd(22)} ${'Score'.padEnd(8)} ${'Latency'.padEnd(10)} ${'Weakest'.padEnd(14)} Turns`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(5)}`);

  for (const file of files) {
    const run: EvalRun = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf-8'));
    if (!run.overallAvg && run.overallAvg !== 0) continue; // skip malformed
    const weakest = Object.entries(run.dimensionAvgs).reduce((a, b) => a[1] < b[1] ? a : b);
    const scoreColor = run.overallAvg >= 4 ? GREEN : run.overallAvg >= 3 ? YELLOW : RED;
    console.log(`  ${run.timestamp.slice(0, 19).padEnd(22)} ${scoreColor}${run.overallAvg.toFixed(2).padEnd(8)}${RESET} ${String(run.avgLatencyMs + 'ms').padEnd(10)} ${RED}${weakest[0].padEnd(14)}${RESET} ${run.totalTurns}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  if (compareMode) { compareRuns(); return; }
  if (historyMode) { showHistory(); return; }

  console.log(`${BOLD}DentaVoice Coach — Quality Eval${RESET}`);
  console.log(`${DIM}Target: ${BASE_URL}${RESET}`);
  console.log(`${DIM}This takes a few minutes — every response gets judged by Claude.${RESET}`);

  // Verify server
  try { await fetch(`${BASE_URL}/`); } catch {
    console.error(`${RED}Server not reachable at ${BASE_URL}. Start it first.${RESET}`);
    process.exit(1);
  }

  const scenarios = scenarioIndex !== null ? [SCENARIOS[scenarioIndex]] : SCENARIOS;
  const allTurns: TurnEval[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const actualIdx = scenarioIndex !== null ? scenarioIndex : i;
    const turns = await evalScenario(scenarios[i], actualIdx);
    allTurns.push(...turns);
  }

  // Build run summary
  const dimKeys = ['relevance', 'naturalness', 'advancement', 'conciseness', 'tactical', 'energy'] as const;
  const dimensionAvgs: Record<string, number> = {};
  for (const dim of dimKeys) {
    dimensionAvgs[dim] = allTurns.reduce((s, t) => s + t.scores[dim].score, 0) / allTurns.length;
  }

  const overallAvg = allTurns.reduce((s, t) => s + t.avgScore, 0) / allTurns.length;
  const avgLatencyMs = Math.round(allTurns.reduce((s, t) => s + t.latencyMs, 0) / allTurns.length);

  // Deduplicate improvements by similarity
  const improvementCounts = new Map<string, number>();
  for (const t of allTurns) {
    if (t.improvement) {
      // Rough dedup: lowercase first 40 chars
      const key = t.improvement.toLowerCase().slice(0, 40);
      improvementCounts.set(key, (improvementCounts.get(key) || 0) + 1);
    }
  }
  // Get unique improvements sorted by frequency
  const seenKeys = new Set<string>();
  const improvements: string[] = [];
  for (const t of [...allTurns].sort((a, b) => a.avgScore - b.avgScore)) {
    const key = t.improvement.toLowerCase().slice(0, 40);
    if (!seenKeys.has(key) && t.improvement) {
      seenKeys.add(key);
      improvements.push(t.improvement);
    }
  }

  const worstTurns = [...allTurns].sort((a, b) => a.avgScore - b.avgScore).slice(0, 5);

  const run: EvalRun = {
    timestamp: new Date().toISOString(),
    model: process.env.COACH_MODEL || 'auto (haiku/sonnet)',
    totalTurns: allTurns.length,
    avgLatencyMs,
    overallAvg,
    dimensionAvgs,
    turns: allTurns,
    worstTurns,
    improvements: improvements.slice(0, 10),
  };

  // Print report
  console.log(generateReport(run));

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(run, null, 2));
  console.log(`${DIM}Results saved: tests/eval-results/${filename}${RESET}`);
  console.log(`${DIM}Run \`npx tsx tests/eval.ts --compare\` after your next change to see diff.${RESET}`);
}

main();
