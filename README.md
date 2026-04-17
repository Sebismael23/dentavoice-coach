# DentaVoice Coach

A personal live-call coach that listens to your DentaVoice sales calls, transcribes them in real time, and whispers the right Voss/Hormozi move in your ear — pulled from a pre-written playbook you control.

**This is a personal tool, not a product.** 30-day deal: use it, log what worked, don't touch it as a business until May 16, 2026.

---

## What it does

1. Captures your call audio (prospect from browser tab + you from mic) as a stereo stream
2. Streams it to Deepgram for live transcription with speaker separation
3. Every ~4 seconds, asks Claude which play from your playbook fits what the prospect just said
4. Renders the exact words you should say, big and center

Your only job: glance at the screen and speak.

---

## Prerequisites

- **Node.js 20+** and npm
- **Anthropic API key** — https://console.anthropic.com/settings/keys
- **Deepgram API key** — https://console.deepgram.com (free tier: $200 credit)
- **A browser softphone** — Quo is recommended ($15/mo, 7-day free trial). Google Voice also works but is less reliable.
- **Chrome, Edge, or Arc** — Firefox's `getDisplayMedia` audio support is patchy

---

## Setup (first time, ~10 minutes)

```bash
# 1. Install
cd dentavoice-coach
npm install

# 2. Configure
cp .env.example .env.local
# Open .env.local in your editor and paste both API keys

# 3. Run
npm run dev
```

Visit `http://localhost:3000`.

---

## Daily use

See [USAGE.md](./USAGE.md) for the exact pre-call checklist. Short version:

1. `npm run dev` in the project folder
2. Open Quo in a **different tab** from the coach
3. Click **Start session** on the coach, pick the Quo tab, tick **Share tab audio**
4. Make your call
5. Glance at the HUD when the prospect pauses

---

## The playbook

All 34 plays live in `data/plays.json`. They're mapped from Seb's 5 playbook documents (DM playbook, call flow, follow-the-thread, gatekeeper mastery, sales mastery) with exact wording preserved where possible.

**Coverage:**
- 12 opening plays (pattern interrupt, identity reveal, gatekeeper bridges, transfer, callback lock)
- 9 diagnostic plays (all 5 threads + gap question + mirror + venting)
- 4 pitch plays (pain math for each thread, label+summary, Grand Slam)
- 7 objection plays (covers all major objections from the playbook)
- 2 close plays (book onboarding, graceful exit)

Edit this file whenever you want to add, reword, or remove a play. The change takes effect on the next session (or hot-reload if `npm run dev` is running).

When the coach fires a **fallback** (status bar shows orange count), that means no play matched and Claude generated one. After the call, check the fallback and consider promoting it to a real play in `plays.json` if it landed well.

## Call context — the priming field

Before clicking Start, you can type a one-line context hint: *"OM Sarah at Harmony Dental, scheduled callback from last Thursday"* or *"Cold call, gatekeeper probable."* This gets fed to the LLM before the first transcript exists, so the coach knows whether to suggest a gatekeeper play or a warm-open play on hint #1. There are preset shortcuts on the setup screen for common scenarios.

The context is optional — leaving it blank just means the coach waits for the transcript to infer context, which is slightly slower.

---

## Architecture

```
Browser
├── getDisplayMedia (tab audio)   ─┐
├── getUserMedia (mic)             ├─► AudioContext stereo merger ─► Deepgram WS
                                   │                                      │
                                   │                                      ▼
                                   │                              TranscriptSegment[]
                                   │                                      │
                                   │                                      ▼
                                   │                        every 4s: /api/coach ─► Anthropic
                                   │                                      │
                                   │                                      ▼
                                   │                                 CoachResponse
                                   │                                      │
                                   │                                      ▼
                                   │                        resolveHint(response, plays)
                                   │                                      │
                                   │                                      ▼
                                   └──────────────────────────────── HUD renders
```

- **Anthropic key** stays server-side (used in `/api/coach`)
- **Deepgram key** goes to browser via `NEXT_PUBLIC_` prefix — fine for local personal use, do NOT deploy this publicly
- **Prompt caching** enabled on the system prompt (which contains the full playbook) — cuts input cost ~90%
- **Session state** is in-memory only. No database. Close the tab, everything's gone.

---

## Cost estimates

At 20 calls/day, ~5 min/call, with Sonnet 4.6 + caching:

- Anthropic: ~$15–25/month
- Deepgram: ~$15–20/month
- Quo: $15/month

Under $60/month total.

To cut Anthropic cost ~80%, set `COACH_MODEL=claude-haiku-4-5-20251001` in `.env.local`. Play selection is classification — Haiku is usually good enough.

---

## Troubleshooting

**"Screen share was cancelled or denied"**
You closed the share picker. Click Start session again and pick the Quo tab.

**"You shared the tab but audio sharing was not enabled"**
In the share picker, look at the bottom — there's a "Share tab audio" checkbox that's often unchecked by default. Tick it.

**"Microphone permission was denied"**
Browser blocked mic access. Click the 🔒 icon in the address bar → allow microphone → reload.

**Deepgram state stuck on "connecting"**
Check your `NEXT_PUBLIC_DEEPGRAM_API_KEY` in `.env.local`. Restart `npm run dev` after changing env vars.

**Transcript shows up but no hints appear**
Check the browser console (F12) for `/api/coach` errors. Most common cause: `ANTHROPIC_API_KEY` missing or wrong.

**Hints appear but play IDs seem wrong**
The LLM occasionally mis-classifies. Edit the `triggers` array in `data/plays.json` to include the exact phrases you're hearing.

**Audio quality is bad / words are missing**
Make sure Quo is running in a browser tab (not a desktop app — Chrome can't capture desktop app audio). Check your mic isn't being suppressed by Zoom or Meet holding it open.

---

## Known limitations (shipped as-is for MVP)

- No call history — transcripts disappear when you close the tab. Save manually if you want them.
- No Electron/always-on-top. Pin the browser window to a corner manually or use a second monitor.
- No multi-provider yet. `ClaudeCoach` implements `CoachLLM` — adding GPT/Gemini is ~50 lines when you actually need it.
- Firefox not officially supported. Use Chrome, Edge, or Arc.

---

## The 30-day deal

You promised: **20 DentaVoice outreach calls per day**, coach running, for 30 days starting ~April 16, 2026.

No feature additions to this app during those 30 days unless a real call reveals a must-have. Log each session's coach hits and misses. **May 16, 2026** is the earliest you're allowed to revisit whether this becomes a product.

Now go call.
