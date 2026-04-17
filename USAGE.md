# USAGE — how to actually run this during a DentaVoice call

Print this. Tape it to your monitor for the first week.

---

## 60 seconds before the call

1. **Open terminal**, `cd dentavoice-coach`, run `npm run dev`. Wait until it says `Ready on http://localhost:3000`.
2. **Open two browser windows** (not tabs — separate windows):
   - Window A: `http://localhost:3000` — the coach
   - Window B: Quo web app
3. **Position Window A** in the upper-right quadrant of your main monitor. Shrink it to roughly 500px wide. The HUD is designed for this size.
4. **Position Window B** (Quo) wherever — the coach doesn't need to see it, just hear it.
5. **Close everything else making noise** — Spotify, Slack notifications, YouTube tabs. They'll poison the transcript.

---

## Starting the session

1. Click **Start session** on the coach (Window A).
2. The browser shows a screen-share picker.
   - Click the **Chrome Tab** tab at the top.
   - Select your **Quo tab**.
   - ⚠️ **Tick "Share tab audio"** — it's a small checkbox at the bottom. If you miss this, the coach can't hear the prospect.
   - Click **Share**.
3. The browser asks for microphone access. Click **Allow**.
4. Coach window now shows status bar with a red "Live" dot and "Transcription · connecting", then "open".

**If you see an error:** read it. Most errors tell you exactly what went wrong. Stop the session, fix it, start again.

---

## Making the call

1. Switch to Quo. Dial the prospect. Talk normally.
2. Glance at the coach window when **the prospect just finished speaking** and you're about to respond.
3. The hint appears roughly 2–3 seconds after they stop. Read the big amber text, say it (or something close to it), move on.

**Important discipline:**
- **Do not read word-for-word if it breaks your natural flow.** The hint is a prompt, not a script. Use its tactic; adapt the words.
- **Don't wait for a hint if you know what to say.** The coach is training wheels. Sometimes you're already ahead of it.
- **Ignore bad hints.** If the hint doesn't fit, just ignore it and keep talking. Log it afterward.

---

## Ending the session

1. Hang up in Quo.
2. Click **End session** in the coach.
3. Take 30 seconds to write ONE line in a notebook or a spreadsheet:

```
Call #  | DM role | Outcome           | Best hint            | Missed hint
-------- -------- ------------------ --------------------- -----------------
Tue 001 | OM      | Set Thu demo      | #11 front-desk ref   | None
Tue 002 | Owner   | Send info         | —                    | No play for "let me think"
```

This log is your iteration input. Friday evening you'll use it.

---

## Friday review (weekly, ~20 min)

1. Open `data/plays.json`.
2. For each "Missed hint" from the week: either add a new play, or add trigger phrases to an existing play.
3. For each "Bad hint fired": tighten the trigger phrases on that play so it fires less often.
4. Commit. Reload the coach. Done.

Keep the playbook under 25 plays. If it grows past that, you're over-fitting. Consolidate.

---

## If something breaks mid-call

- **Hint stops updating:** the coach API call failed. Check the browser console (F12). Don't panic — you've still got the transcript and your own brain. Finish the call manually. Debug after.
- **Transcript stops updating:** Deepgram disconnected. Same deal — finish manually.
- **Audio is gone entirely:** screen share was revoked (most common cause: Chrome auto-reclaims the stream if you switched tabs). Finish the call. Next time, don't switch tabs mid-call.

**The coach failing silently is acceptable. You still have your playbook in your head.** That's why you studied the scripts.

---

## Weekly rhythm

| Day       | Action                                                                  |
| --------- | ----------------------------------------------------------------------- |
| Mon–Fri   | 20 outreach calls. Coach running. Log one line per call.               |
| Fri PM    | 20-min review. Update `plays.json`. Note 1 pattern you saw this week.  |
| Sat       | Off the coach. Scripts + Voss/Hormozi study 30 min max.                |
| Sun       | Off entirely. You work 20 hrs/week — respect the other 148.           |

---

## The rule you're going to be tempted to break

You will want to add features to this app. Don't. The deal is 30 days untouched. The only edits allowed before May 16, 2026:

- Adding/editing plays in `data/plays.json`
- Tweaking the system prompt in `lib/prompt.ts` (minor wording only)
- Fixing bugs that block calls

Not allowed:
- New screens, new UI
- Multi-provider LLM support
- Call history/recording features
- Productizing anything

Fight that urge. Call instead.
