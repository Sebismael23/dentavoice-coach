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

const MODEL = process.env.COACH_MODEL || 'claude-sonnet-4-6';

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

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed === null) return null;

    if (
      parsed.action === 'play' &&
      typeof parsed.play_id === 'number' &&
      typeof parsed.signal === 'string' &&
      parsed.personalize &&
      typeof parsed.confidence === 'string'
    ) {
      return parsed as CoachResponse;
    }

    if (
      parsed.action === 'generate' &&
      typeof parsed.say === 'string' &&
      typeof parsed.move === 'string' &&
      typeof parsed.signal === 'string'
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

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 180, // Small JSON response — keep tight for speed
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // Prompt caching — the playbook + framework text doesn't change per call,
          // so cache it. Saves ~90% on input tokens for the repeat calls.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `${contextBlock}${transferBlock}Current rolling transcript (last ~60 seconds):\n\n${transcriptText}\n\nRespond with a coaching JSON object or the literal null.`,
        },
      ],
    });

    // Extract text from the first content block
    const firstBlock = msg.content[0];
    const rawText =
      firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';

    const result = parseCoachResponse(rawText);

    return NextResponse.json({ result, raw: rawText });
  } catch (err: any) {
    console.error('[coach] Anthropic call failed', err);
    return NextResponse.json(
      { error: err?.message || 'Coach request failed' },
      { status: 500 }
    );
  }
}
