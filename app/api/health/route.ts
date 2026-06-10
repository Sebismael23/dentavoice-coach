// -----------------------------------------------------------------------------
// /api/health — tells the browser which server-side keys are configured.
// The browser no longer needs ANY API keys (Deepgram auth happens in the
// server.js proxy; Anthropic auth happens in /api/coach). This endpoint lets
// the SetupScreen show accurate readiness without exposing secrets.
// -----------------------------------------------------------------------------

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    deepgram: Boolean(process.env.DEEPGRAM_API_KEY),
  });
}
