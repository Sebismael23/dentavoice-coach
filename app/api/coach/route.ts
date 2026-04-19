// -----------------------------------------------------------------------------
// /api/coach — server-side endpoint that calls Anthropic
// -----------------------------------------------------------------------------
// Lives on the server so the ANTHROPIC_API_KEY never touches the browser.
// Uses prompt caching on the system prompt (with playbook) to cut input cost
// by ~90% on repeat calls within a session.
// -----------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { buildSystemPrompt } from '@/lib/prompt';
import type { CoachResponse, Play, TranscriptSegment, TransferTarget } from '@/lib/types';

// Load playbook once at module init. Next.js will reload on file change in dev.
const playsPath = path.join(process.cwd(), 'data', 'plays.json');
const playbookJson: string = fs.readFileSync(playsPath, 'utf-8');
const plays: Play[] = JSON.parse(playbookJson);

const SYSTEM_PROMPT = buildSystemPrompt(JSON.stringify(plays, null, 2));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MODEL_STRONG = 'claude-sonnet-4-6';

/**
 * Pick the right model. Haiku 4.5 for 80% of calls (fast path).
 * Sonnet for pitch stage, recovery, or when env override is set.
 */
function pickModel(body: { callPhase?: string; consecutiveNulls?: number; recentHintSays?: string[] }): string {
  if (process.env.COACH_MODEL) return process.env.COACH_MODEL;

  // Escalate to Sonnet when:
  // 1. We're stuck (3+ consecutive nulls = recovery mode)
  if ((body.consecutiveNulls ?? 0) >= 3) return MODEL_STRONG;

  // 2. Deep in the call (5+ hints given = likely pitch/close territory)
  if ((body.recentHintSays?.length ?? 0) >= 5) return MODEL_STRONG;

  // Default: Haiku for speed
  return MODEL_FAST;
}

/** Format transcript for the LLM in a compact, diff-friendly way. */
function formatTranscript(segments: TranscriptSegment[]): string {
  // Only show final segments — interim ones are too noisy for the coach
  const finals = segments.filter((s) => s.isFinal);
  if (finals.length === 0) return '(no speech yet)';

  return finals
    .map((s) => {
      const who = s.speaker === 'prospect' ? 'PROSPECT' : 'SEB';
      return `${who}: ${s.text}`;
    })
    .join('\n');
}

/**
 * Parse Claude's response text into a CoachResponse.
 * Claude is told to return pure JSON or the literal `null`.
 * Be defensive — occasionally a model will wrap in markdown or add prose.
 */
function parseCoachResponse(text: string): CoachResponse {
  const cleaned = text
    .trim()
    // strip markdown code fences if present
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (cleaned === 'null' || cleaned === '') return null;

  // Claude sometimes appends prose after the JSON. Extract the first valid JSON object.
  let jsonStr = cleaned;
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > firstBrace) jsonStr = cleaned.slice(firstBrace, end + 1);
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed === null) return null;

    if (
      typeof parsed.signal === 'string' &&
      typeof parsed.move === 'string' &&
      typeof parsed.say === 'string' &&
      typeof parsed.why === 'string'
    ) {
      return parsed as CoachResponse;
    }

    console.warn('[coach] unrecognized response shape', parsed);
    return null;
  } catch (err) {
    console.error('[coach] JSON parse failed', err, { text: cleaned });
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured. Copy .env.example to .env.local and fill it in.' },
      { status: 500 }
    );
  }

  let body: {
    transcript: TranscriptSegment[];
    lastHintAt: number | null;
    callContext?: string;
    transferredToDM?: TransferTarget;
    lastHintSay?: string;
    callPhase?: 'gatekeeper' | 'dm';
    usedPlayIds?: number[];
    consecutiveNulls?: number;
    currentThread?: string;
    recentHintSays?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const transcriptText = formatTranscript(body.transcript);
  const contextBlock = body.callContext?.trim()
    ? `\n\nCALL CONTEXT (provided by Seb before starting):\n${body.callContext.trim()}\n`
    : '';

  const transferLabel =
    body.transferredToDM === 'office_manager'
      ? 'Office Manager'
      : body.transferredToDM === 'dentist'
      ? 'Dentist'
      : null;

  const transferBlock = transferLabel
    ? `\n\n[TRANSFER EVENT] Seb was just transferred to the ${transferLabel}. The gatekeeper phase is over. The transcript has been cleared. Next speaker is the decision maker. Use a warm-open play (Play ${body.transferredToDM === 'office_manager' ? '11' : '12'}).\n`
    : '';

  const lastHintBlock = body.lastHintSay
    ? `\n\nLAST HINT GIVEN TO SEB (do NOT repeat this — pick a different play or say null):\n"${body.lastHintSay}"\n`
    : '';

  const phaseBlock = body.callPhase
    ? `\n\nCURRENT CALL PHASE: ${body.callPhase.toUpperCase()}\nYou MUST only select plays whose phase is "${body.callPhase}" or "both". Selecting a play with the wrong phase is a CRITICAL error.\n`
    : '';

  const usedPlaysBlock = body.usedPlayIds && body.usedPlayIds.length > 0
    ? `\n\nPLAYS ALREADY USED THIS CALL (do NOT repeat these — pick a DIFFERENT play or say null): [${body.usedPlayIds.join(', ')}]\n`
    : '';

  const urgencyBlock = (body.consecutiveNulls ?? 0) >= 3
    ? `\n\nURGENT: You have returned null ${body.consecutiveNulls} times in a row. Seb has NO guidance right now. You MUST pick a play or generate a hint. Do NOT return null. If the prospect gave a soft objection or deflection, suggest an objection-handling play. If stuck, use Play 33 (emergency recovery).\n`
    : '';

  const threadBlock = body.currentThread && body.currentThread !== 'unknown'
    ? `\n\nACTIVE DIAGNOSTIC THREAD: ${body.currentThread}\nStay on this thread unless the prospect clearly pivots.\n`
    : '';

  const hintHistoryBlock = body.recentHintSays && body.recentHintSays.length > 0
    ? `\n\nRECENT HINTS ALREADY GIVEN TO SEB (do NOT repeat these ideas or phrasings — advance the call FORWARD):\n${body.recentHintSays.map((h, i) => `${i + 1}. "${h.slice(0, 80)}"`).join('\n')}\n`
    : '';

  try {
    const encoder = new TextEncoder();
    const selectedModel = pickModel(body);
    const anthropicStream = client.messages.stream({
      model: selectedModel,
      max_tokens: 200,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `${contextBlock}${transferBlock}${phaseBlock}${threadBlock}${lastHintBlock}${hintHistoryBlock}${usedPlaysBlock}${urgencyBlock}Current rolling transcript (last ~60 seconds):\n\n${transcriptText}\n\nRespond with a coaching JSON object or the literal null.`,
        },
      ],
    });

    const readable = new ReadableStream({
      start(controller) {
        anthropicStream.on('text', (text: string) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: text })}\n\n`));
        });
        anthropicStream.on('end', () => {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        });
        anthropicStream.on('error', (err: any) => {
          console.error('[coach] Anthropic stream error', err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: err?.message || 'stream error' })}\n\n`)
          );
          controller.close();
        });
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    console.error('[coach] Anthropic call failed', err);
    return NextResponse.json(
      { error: err?.message || 'Coach request failed' },
      { status: 500 }
    );
  }
}
