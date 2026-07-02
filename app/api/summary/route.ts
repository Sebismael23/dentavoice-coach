// -----------------------------------------------------------------------------
// /api/summary — end-of-call asset extraction
// -----------------------------------------------------------------------------
// One fast, cheap, non-streaming Haiku call per ended call. Turns the raw
// transcript into a CRM-ready row: practice, contact, DM, emails (INCLUDING
// ones spelled out letter-by-letter, which regex can't reassemble), callback
// windows, the outcome rung, and the single next action Seb must take.
//
// This is what turns 20 dials/day into a follow-up pipeline instead of
// console scrollback.
// -----------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `You extract structured sales data from a cold-call transcript between SEB (a founder selling DentaVoice, an AI phone receptionist for dental practices) and a PROSPECT (usually a dental-office receptionist, sometimes an office manager or dentist).

Return ONLY a single valid JSON object — no prose, no markdown fences — with EXACTLY these fields:

{
  "practice_name": string | null,        // the dental practice's name, if said
  "contact_name": string | null,         // the person Seb actually spoke with
  "dm_name": string | null,              // decision-maker named on the call (e.g. office manager's name)
  "dm_role": string | null,              // "office manager" | "dentist" | etc.
  "emails": string[],                    // ALL emails mentioned. CRITICAL: reassemble spelled-out emails. "r i g b y d e n t a l s a n d y at gmail" => "rigbydentalsandy@gmail.com". "o m dot corner cove dental at gmail" => "om.cornercovedental@gmail.com". Fix transcription artifacts (spaces, "dot", "at", stray commas).
  "phone_numbers": string[],             // any phone numbers mentioned
  "callback_time": string | null,        // any agreed or suggested callback window ("after 2pm", "tomorrow morning", "she's back Thursday")
  "outcome": "transfer" | "pilot_agreed" | "callback_locked" | "email_captured" | "website_planted" | "nothing" | "unknown",
  "next_action": string | null,          // ONE imperative sentence for Seb, with names/times ("Email the one-pager to rigbydentalsandy@gmail.com addressed to Mary today; call back Thursday AM for Christine.")
  "notes": string | null                 // ONE sentence of coaching-relevant context (e.g. "Gatekeeper said OM works multiple offices, no set schedule.")
}

Rules:
- outcome picks the HIGHEST rung achieved: transfer > pilot_agreed > callback_locked > email_captured > website_planted > nothing.
- "email_captured" requires an actual address; "website_planted" means Seb said dentavoice.co before the end.
- If the transcript is an IVR menu or too short to judge, outcome is "unknown" and other fields null/empty.
- next_action must be executable within 24 hours and reference concrete names/addresses from the call.
- Never invent data not present in the transcript.`;

interface SummaryRequestBody {
  transcript: Array<{ speaker: 'prospect' | 'me'; text: string }>;
}

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: SummaryRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
    return NextResponse.json({ error: 'transcript required' }, { status: 400 });
  }

  // Cap defensively — calls are short; 400 lines is far beyond any real call.
  const lines = body.transcript
    .slice(-400)
    .map((s) => `${s.speaker === 'me' ? 'SEB' : 'PROSPECT'}: ${s.text}`)
    .join('\n');

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Call transcript (oldest first):\n\n${lines}\n\nReturn the JSON object.`,
        },
      ],
    });

    const text = msg.content
      .map((b: any) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    // Isolate the first balanced JSON object; tolerate stray prose/fences.
    const cleaned = text.replace(/```json|```/g, '').trim();
    const first = cleaned.indexOf('{');
    let jsonStr = cleaned;
    if (first >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = first; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end > first) jsonStr = cleaned.slice(first, end + 1);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    }

    // Normalize shape so the client can trust the fields exist.
    const summary = {
      practice_name: typeof parsed.practice_name === 'string' ? parsed.practice_name : null,
      contact_name: typeof parsed.contact_name === 'string' ? parsed.contact_name : null,
      dm_name: typeof parsed.dm_name === 'string' ? parsed.dm_name : null,
      dm_role: typeof parsed.dm_role === 'string' ? parsed.dm_role : null,
      emails: Array.isArray(parsed.emails) ? parsed.emails.filter((e: any) => typeof e === 'string') : [],
      phone_numbers: Array.isArray(parsed.phone_numbers)
        ? parsed.phone_numbers.filter((p: any) => typeof p === 'string')
        : [],
      callback_time: typeof parsed.callback_time === 'string' ? parsed.callback_time : null,
      outcome:
        typeof parsed.outcome === 'string' &&
        ['transfer', 'pilot_agreed', 'callback_locked', 'email_captured', 'website_planted', 'nothing', 'unknown'].includes(
          parsed.outcome
        )
          ? parsed.outcome
          : 'unknown',
      next_action: typeof parsed.next_action === 'string' ? parsed.next_action : null,
      notes: typeof parsed.notes === 'string' ? parsed.notes : null,
    };

    const u = (msg as any).usage;
    if (u) {
      console.log(`[summary] model=${MODEL} in=${u.input_tokens} out=${u.output_tokens} outcome=${summary.outcome}`);
    }

    return NextResponse.json(summary);
  } catch (err: any) {
    console.error('[summary] failed', err?.message || err);
    return NextResponse.json({ error: 'summary failed' }, { status: 500 });
  }
}
