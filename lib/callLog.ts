// -----------------------------------------------------------------------------
// Call log — per-call persistence, asset extraction, export
// -----------------------------------------------------------------------------
// WHY THIS EXISTS: during the first real dial block, captured assets
// (rigbydentalsandy@gmail.com, "attention Mary") lived only in console
// scrollback and had to be dug out by hand. Every ended call is now saved to
// localStorage, assets are extracted automatically (regex instantly, then an
// AI summary enriches it), and everything is downloadable as text.
//
// Storage: localStorage key 'dv-call-log', newest first, capped at 50 records.
// This runs ONLY in the browser (all callers are client components).
// -----------------------------------------------------------------------------

export interface CallSummaryData {
  practice_name: string | null;
  contact_name: string | null;
  dm_name: string | null;
  dm_role: string | null;
  emails: string[];
  phone_numbers: string[];
  callback_time: string | null;
  outcome:
    | 'transfer'
    | 'pilot_agreed'
    | 'callback_locked'
    | 'email_captured'
    | 'website_planted'
    | 'nothing'
    | 'unknown';
  next_action: string | null;
  notes: string | null;
}

export interface CallLogSegment {
  speaker: 'prospect' | 'me';
  text: string;
}

export interface CallRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  segments: CallLogSegment[];
  /** Instant regex extraction — available immediately at call end. */
  emails: string[];
  phones: string[];
  /** AI-enriched summary — arrives async ~1-2s after call end, or null. */
  summary: CallSummaryData | null;
}

const STORAGE_KEY = 'dv-call-log';
const MAX_RECORDS = 50;
const MAX_SEGMENTS_PER_RECORD = 300;

/** Fired on window whenever the log changes, so open screens can refresh. */
export const CALL_LOG_EVENT = 'dv-calllog-updated';

// ---------------------------------------------------------------------------
// Asset extraction (instant, regex-based; the AI summary catches what these miss,
// e.g. emails spelled out letter-by-letter: "r i g b y d e n t a l ... at gmail")
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  return Array.from(new Set(found.map((e) => e.toLowerCase())));
}

export function extractPhones(text: string): string[] {
  const found = text.match(PHONE_RE) ?? [];
  return Array.from(new Set(found.map((p) => p.trim())));
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

export function buildRecordFromSegments(
  rawSegments: Array<{ speaker: 'prospect' | 'me'; text: string; isFinal?: boolean }>,
  startedAt: number
): CallRecord {
  const finals = rawSegments
    .filter((s) => s.isFinal !== false)
    .slice(-MAX_SEGMENTS_PER_RECORD)
    .map((s) => ({ speaker: s.speaker, text: s.text }));

  const fullText = finals.map((s) => s.text).join(' ');
  const endedAt = Date.now();

  return {
    id: `call-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    segments: finals,
    emails: extractEmails(fullText),
    phones: extractPhones(fullText),
    summary: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readLog(): CallRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(records: CallRecord[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
    window.dispatchEvent(new CustomEvent(CALL_LOG_EVENT));
  } catch (err) {
    // Quota or private-mode failure — never let logging break the call flow.
    console.warn('[callLog] failed to persist', err);
  }
}

export function getCallLog(): CallRecord[] {
  if (typeof window === 'undefined') return [];
  return readLog();
}

/** Save a record (newest first). Returns the record's id. */
export function saveCallRecord(record: CallRecord): string {
  const log = readLog();
  writeLog([record, ...log]);
  console.log(
    `[callLog] Saved call ${record.id} — ${record.segments.length} lines, ` +
      `${record.emails.length} email(s), ${Math.round(record.durationMs / 1000)}s`
  );
  return record.id;
}

/** Attach the async AI summary to an already-saved record. */
export function updateCallSummary(id: string, summary: CallSummaryData) {
  const log = readLog();
  const idx = log.findIndex((r) => r.id === id);
  if (idx === -1) return;
  // Merge AI-found assets with regex-found ones so nothing is lost.
  const merged: CallRecord = {
    ...log[idx],
    summary,
    emails: Array.from(new Set([...log[idx].emails, ...(summary.emails ?? [])])),
    phones: Array.from(new Set([...log[idx].phones, ...(summary.phone_numbers ?? [])])),
  };
  log[idx] = merged;
  writeLog(log);
  console.log(`[callLog] Summary attached to ${id} — outcome=${summary.outcome}`);
}

export function clearCallLog() {
  writeLog([]);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function recordToText(r: CallRecord): string {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`CALL — ${fmtTime(r.startedAt)} · ${Math.round(r.durationMs / 1000)}s`);
  if (r.summary) {
    const s = r.summary;
    lines.push(`Practice: ${s.practice_name ?? '—'} · Contact: ${s.contact_name ?? '—'}`);
    lines.push(`DM: ${s.dm_name ?? '—'} (${s.dm_role ?? '—'}) · Outcome: ${s.outcome}`);
    if (s.callback_time) lines.push(`Callback: ${s.callback_time}`);
    if (s.next_action) lines.push(`NEXT ACTION: ${s.next_action}`);
    if (s.notes) lines.push(`Coach note: ${s.notes}`);
  }
  if (r.emails.length) lines.push(`Emails: ${r.emails.join(', ')}`);
  if (r.phones.length) lines.push(`Phones: ${r.phones.join(', ')}`);
  lines.push('-'.repeat(60));
  for (const seg of r.segments) {
    lines.push(`${seg.speaker === 'me' ? 'SEB     ' : 'PROSPECT'} | ${seg.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function allCallsToText(records: CallRecord[]): string {
  const header = `DentaVoice Call Log — exported ${fmtTime(Date.now())} — ${records.length} call(s)\n\n`;
  return header + records.map(recordToText).join('\n');
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// AI summary fetch — fire-and-forget from the session; writes back to storage.
// ---------------------------------------------------------------------------

export async function requestCallSummary(record: CallRecord): Promise<void> {
  // Nothing meaningful to summarize
  if (record.segments.length < 2) return;
  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: record.segments }),
    });
    if (!res.ok) {
      console.warn('[callLog] summary request failed', res.status);
      return;
    }
    const data = await res.json();
    if (data && typeof data.outcome === 'string') {
      updateCallSummary(record.id, data as CallSummaryData);
    }
  } catch (err) {
    console.warn('[callLog] summary request error', err);
  }
}
