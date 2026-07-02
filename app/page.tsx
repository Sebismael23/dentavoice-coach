'use client';

import { useCallback, useEffect, useState } from 'react';
import { SetupScreen } from '@/components/SetupScreen';
import { CallSession } from '@/components/CallSession';
import {
  CALL_LOG_EVENT,
  allCallsToText,
  downloadText,
  getCallLog,
  recordToText,
  type CallRecord,
} from '@/lib/callLog';
import type { Play } from '@/lib/types';
import playsData from '@/data/plays.json';

const plays = playsData as Play[];

const OUTCOME_LABEL: Record<string, { label: string; tone: string }> = {
  transfer:         { label: 'Transferred to DM',  tone: 'text-signal-ok border-signal-ok/40 bg-signal-ok/10' },
  pilot_agreed:     { label: 'PILOT AGREED 🎉',    tone: 'text-signal-ok border-signal-ok/40 bg-signal-ok/10' },
  callback_locked:  { label: 'Callback locked',    tone: 'text-accent border-accent/40 bg-accent/10' },
  email_captured:   { label: 'Email captured',     tone: 'text-accent border-accent/40 bg-accent/10' },
  website_planted:  { label: 'Website planted',    tone: 'text-text-secondary border-border bg-bg-card' },
  nothing:          { label: 'No asset',           tone: 'text-signal-warn border-signal-warn/40 bg-signal-warn/10' },
  unknown:          { label: 'Processing…',        tone: 'text-text-muted border-border bg-bg-card' },
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One saved call row on the debrief screen. */
function CallRow({ record, expanded }: { record: CallRecord; expanded: boolean }) {
  const s = record.summary;
  const outcome = OUTCOME_LABEL[s?.outcome ?? 'unknown'] ?? OUTCOME_LABEL.unknown;
  const emails = record.emails;
  const title = s?.practice_name || (record.segments[0]?.text.slice(0, 42) ?? 'Call');

  return (
    <div className="text-left rounded-xl border border-border-subtle bg-bg-elevated p-4">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="text-sm font-medium text-text-primary truncate">{title}</div>
        <span
          className={`shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${outcome.tone}`}
        >
          {outcome.label}
        </span>
      </div>
      <div className="text-[11px] text-text-muted mb-2">
        {fmtClock(record.startedAt)} · {fmtDuration(record.durationMs)}
        {s?.contact_name ? ` · spoke with ${s.contact_name}` : ''}
        {s?.dm_name ? ` · DM: ${s.dm_name}${s.dm_role ? ` (${s.dm_role})` : ''}` : ''}
      </div>

      {(emails.length > 0 || record.phones.length > 0 || s?.callback_time) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {emails.map((e) => (
            <span
              key={e}
              className="text-[11px] font-mono px-2 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent select-all"
            >
              {e}
            </span>
          ))}
          {record.phones.map((p) => (
            <span
              key={p}
              className="text-[11px] font-mono px-2 py-0.5 rounded bg-bg-card border border-border text-text-secondary select-all"
            >
              {p}
            </span>
          ))}
          {s?.callback_time && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-bg-card border border-border text-text-secondary">
              ⏰ {s.callback_time}
            </span>
          )}
        </div>
      )}

      {expanded && s?.next_action && (
        <div className="mt-2 text-[12px] leading-relaxed text-text-primary bg-bg-card border border-border-subtle rounded-lg px-3 py-2">
          <span className="text-[10px] uppercase tracking-wider text-accent font-semibold mr-2">
            Next action
          </span>
          {s.next_action}
        </div>
      )}
      {expanded && s?.notes && (
        <div className="mt-1.5 text-[11px] text-text-muted italic">{s.notes}</div>
      )}
    </div>
  );
}

export default function Page() {
  const [state, setState] = useState<'setup' | 'session' | 'ended'>('setup');
  const [serverKeys, setServerKeys] = useState<{ anthropic: boolean; deepgram: boolean } | null>(null);
  const [callContext, setCallContext] = useState('');
  const [keyterms, setKeyterms] = useState<string[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [callLog, setCallLog] = useState<CallRecord[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState<number>(0);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => setServerKeys({ anthropic: Boolean(data.anthropic), deepgram: Boolean(data.deepgram) }))
      .catch(() => setServerKeys(null));
  }, []);

  const refreshLog = useCallback(() => {
    setCallLog(getCallLog());
  }, []);

  // Refresh the debrief when async AI summaries land (they arrive ~1-2s after
  // each call is saved, possibly after we've navigated to this screen).
  useEffect(() => {
    if (state !== 'ended') return;
    refreshLog();
    const handler = () => refreshLog();
    window.addEventListener(CALL_LOG_EVENT, handler);
    return () => window.removeEventListener(CALL_LOG_EVENT, handler);
  }, [state, refreshLog]);

  if (state === 'session') {
    return (
      <CallSession
        plays={plays}
        pollIntervalMs={
          Number(process.env.NEXT_PUBLIC_COACH_POLL_INTERVAL_MS) || 4000
        }
        windowSeconds={
          Number(process.env.NEXT_PUBLIC_COACH_WINDOW_SECONDS) || 60
        }
        callContext={callContext}
        keyterms={keyterms}
        manualMode={manualMode}
        onEnd={() => setState('ended')}
      />
    );
  }

  if (state === 'ended') {
    // Calls from THIS session (started after the session began), newest first.
    const sessionCalls = callLog.filter((r) => r.startedAt >= sessionStartedAt);
    const shown = sessionCalls.length > 0 ? sessionCalls : callLog.slice(0, 1);
    const emailsCaptured = new Set(shown.flatMap((r) => r.emails)).size;
    const withOutcome = shown.filter(
      (r) => r.summary && !['nothing', 'unknown'].includes(r.summary.outcome)
    ).length;

    return (
      <div className="min-h-screen flex items-start justify-center px-6 py-12 overflow-y-auto">
        <div className="w-full max-w-xl">
          <div className="text-center mb-8">
            <div className="text-[11px] uppercase tracking-[0.2em] text-text-muted mb-3">
              Session debrief
            </div>
            <h1 className="text-2xl font-semibold mb-2">
              {shown.length} call{shown.length === 1 ? '' : 's'} · {emailsCaptured} email
              {emailsCaptured === 1 ? '' : 's'} captured · {withOutcome} with an asset
            </h1>
            <p className="text-sm text-text-secondary">
              Every asset below decays by the hour. Send the follow-ups NOW, then log
              callbacks in your calendar. Then dial the next block.
            </p>
          </div>

          {shown.length === 0 ? (
            <div className="text-center text-sm text-text-muted mb-8">
              No calls were saved this session (calls need at least a couple of
              exchanges to be recorded).
            </div>
          ) : (
            <div className="space-y-3 mb-8">
              {shown.map((r, i) => (
                <CallRow key={r.id} record={r} expanded={i < 3} />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-3">
            {shown.length > 0 && (
              <>
                <button
                  onClick={() =>
                    downloadText(
                      `dentavoice-call-${new Date(shown[0].startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`,
                      recordToText(shown[0])
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-bg-card border border-border text-text-primary text-sm font-medium hover:bg-border transition"
                >
                  Download last call
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      `dentavoice-call-log-${new Date().toISOString().slice(0, 10)}.txt`,
                      allCallsToText(getCallLog())
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-bg-card border border-border text-text-primary text-sm font-medium hover:bg-border transition"
                >
                  Download all calls
                </button>
              </>
            )}
            <button
              onClick={() => {
                setCallContext('');
                setState('setup');
              }}
              className="px-6 py-2 rounded-lg bg-accent text-bg font-semibold text-sm hover:bg-accent/90 transition"
            >
              New session
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SetupScreen
      onStart={(ctx, manual, terms) => {
        setCallContext(ctx);
        setManualMode(manual);
        setKeyterms(terms);
        setSessionStartedAt(Date.now());
        setState('session');
      }}
      serverKeys={serverKeys}
      error={null}
    />
  );
}
