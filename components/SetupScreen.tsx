'use client';

import { useState } from 'react';

interface SetupScreenProps {
  onStart: (callContext: string, manualMode: boolean) => void;
  deepgramKeyPresent: boolean;
  error: string | null;
}

type CallType = 'cold' | 'callback' | 'referral';
type ExpectedPicker = 'unknown' | 'receptionist' | 'office_manager' | 'dentist';

export function SetupScreen({ onStart, deepgramKeyPresent, error }: SetupScreenProps) {
  const [callType, setCallType] = useState<CallType>('cold');
  const [expectedPicker, setExpectedPicker] = useState<ExpectedPicker>('unknown');
  const [practiceName, setPracticeName] = useState('');
  const [contactName, setContactName] = useState('');
  const [practiceSize, setPracticeSize] = useState('');
  const [priorHistory, setPriorHistory] = useState('');
  const [manualMode, setManualMode] = useState(false);

  function buildContext(): string {
    const lines: string[] = [];
    lines.push(`CALL TYPE: ${callType === 'cold' ? 'Cold call (first contact)' : callType === 'callback' ? 'Scheduled callback (already warm)' : 'Referral / warm intro'}`);
    lines.push(`EXPECTED FIRST CONTACT: ${expectedPicker === 'unknown' ? 'Unknown — probably receptionist' : expectedPicker === 'receptionist' ? 'Receptionist / front desk' : expectedPicker === 'office_manager' ? 'Office Manager (decision maker)' : 'Dentist / Owner (decision maker)'}`);
    if (practiceName.trim()) lines.push(`PRACTICE: ${practiceName.trim()}`);
    if (contactName.trim()) lines.push(`CONTACT NAME: ${contactName.trim()}`);
    if (practiceSize.trim()) lines.push(`PRACTICE SIZE: ${practiceSize.trim()}`);
    if (priorHistory.trim()) lines.push(`PRIOR HISTORY: ${priorHistory.trim()}`);

    // Coaching directives based on call type
    if (callType === 'callback') {
      lines.push('COACHING DIRECTIVE: This is a warm callback. Skip the cold opener (Play 1). Open with a reference to the previous conversation. Get straight to diagnostic or offer.');
    } else if (callType === 'referral') {
      lines.push('COACHING DIRECTIVE: This is a warm referral. Lead with who referred them. Skip pattern interrupt.');
    }
    if (expectedPicker === 'office_manager') {
      lines.push('COACHING DIRECTIVE: Expected to reach OM directly. If confirmed, skip gatekeeper plays — start with Play 11 (warm OM open) or jump to diagnostic.');
    } else if (expectedPicker === 'dentist') {
      lines.push('COACHING DIRECTIVE: Expected to reach dentist directly. If confirmed, skip gatekeeper — use Play 12 (warm dentist open) and focus on revenue/ROI thread.');
    }
    return lines.join('\n');
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="max-w-xl w-full">
        {/* Brand */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2.5 mb-3">
            <div className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-text-muted font-medium">
              DentaVoice Coach
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
            Personal live call coach
          </h1>
          <p className="mt-3 text-sm text-text-secondary">
            Voss + Hormozi playbook. Live transcription. Real-time hints.
          </p>
        </div>

        {/* Structured call context */}
        <div className="bg-bg-card border border-border-subtle rounded-xl p-5 mb-5 space-y-4">
          <h2 className="text-xs uppercase tracking-[0.15em] text-text-muted font-medium">
            Call setup
          </h2>

          {/* Row 1: Call type + Expected picker */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-text-muted mb-1.5">Call type</label>
              <div className="flex gap-1.5">
                {([['cold', 'Cold'], ['callback', 'Callback'], ['referral', 'Referral']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setCallType(val)}
                    className={`text-[11px] px-2.5 py-1.5 rounded-md border transition ${callType === val ? 'bg-accent/20 border-accent text-accent' : 'bg-bg-elevated border-border text-text-secondary hover:text-text-primary'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-text-muted mb-1.5">Who picks up?</label>
              <select
                value={expectedPicker}
                onChange={(e) => setExpectedPicker(e.target.value as ExpectedPicker)}
                className="w-full bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent/50"
              >
                <option value="unknown">Don't know</option>
                <option value="receptionist">Receptionist</option>
                <option value="office_manager">Office Manager</option>
                <option value="dentist">Dentist / Owner</option>
              </select>
            </div>
          </div>

          {/* Row 2: Practice name + Contact name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-text-muted mb-1.5">Practice name</label>
              <input
                type="text"
                value={practiceName}
                onChange={(e) => setPracticeName(e.target.value)}
                placeholder="Peach Dental"
                className="w-full bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-muted mb-1.5">Contact name</label>
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Sarah"
                className="w-full bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent/50"
              />
            </div>
          </div>

          {/* Row 3: Practice size */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Practice size <span className="text-text-dim">(optional)</span></label>
            <div className="flex gap-1.5">
              {['1-2 chairs', '3-5 chairs', '5+ chairs', ''].map((s) => (
                <button
                  key={s || 'clear'}
                  type="button"
                  onClick={() => setPracticeSize(s)}
                  className={`text-[11px] px-2.5 py-1.5 rounded-md border transition ${practiceSize === s ? 'bg-accent/20 border-accent text-accent' : 'bg-bg-elevated border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {s || 'Skip'}
                </button>
              ))}
            </div>
          </div>

          {/* Row 4: Prior history / notes */}
          {(callType === 'callback' || callType === 'referral') && (
            <div>
              <label className="block text-[11px] text-text-muted mb-1.5">
                {callType === 'callback' ? 'What happened last time?' : 'Who referred you?'}
              </label>
              <input
                type="text"
                value={priorHistory}
                onChange={(e) => setPriorHistory(e.target.value)}
                placeholder={callType === 'callback' ? 'She asked about pricing, said to call back Friday' : 'Dr. Miller from Smile Clinic recommended them'}
                className="w-full bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent/50"
              />
            </div>
          )}
        </div>

        {/* Pre-flight checklist */}
        <div className="bg-bg-card border border-border-subtle rounded-xl p-5 mb-5">
          <h2 className="text-xs uppercase tracking-[0.15em] text-text-muted font-medium mb-3">
            Before you start
          </h2>
          <ul className="space-y-2.5 text-sm">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 text-accent font-semibold">!</span>
              <span className="text-text-secondary">
                <span className="text-accent font-medium">Wear headphones.</span>{' '}
                Critical — laptop speakers leak into your mic and break speaker separation.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 text-text-muted">01</span>
              <span className="text-text-secondary">
                Open Quo in a{' '}
                <span className="text-text-primary font-medium">separate browser tab</span>.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 text-text-muted">02</span>
              <span className="text-text-secondary">
                On the share picker,{' '}
                <span className="text-accent font-medium">tick &ldquo;Share tab audio&rdquo;</span>.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 text-text-muted">03</span>
              <span className="text-text-secondary">Grant microphone access when asked.</span>
            </li>
          </ul>
        </div>

        {/* API key warning */}
        {!deepgramKeyPresent && (
          <div className="bg-signal-warn/10 border border-signal-warn/30 text-signal-warn text-sm rounded-lg px-4 py-3 mb-5">
            <strong>Deepgram key not set.</strong> Add{' '}
            <code className="text-xs bg-bg-elevated px-1 py-0.5 rounded">
              NEXT_PUBLIC_DEEPGRAM_API_KEY
            </code>{' '}
            to <code>.env.local</code> and restart the dev server.
          </div>
        )}

        {error && (
          <div className="bg-signal-live/10 border border-signal-live/30 text-signal-live text-sm rounded-lg px-4 py-3 mb-5">
            {error}
          </div>
        )}

        {/* Manual speaker mode toggle */}
        <div
          className={`flex items-center justify-between px-4 py-3 rounded-xl border mb-3 cursor-pointer transition ${
            manualMode ? 'bg-accent/10 border-accent/40' : 'bg-bg-card border-border-subtle'
          }`}
          onClick={() => setManualMode((v) => !v)}
        >
          <div>
            <div className="text-sm font-medium text-text-primary">
              Manual speaker mode
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              Press <kbd className="bg-bg-elevated border border-border rounded px-1 py-0.5 text-[10px]">P</kbd> = prospect talking &nbsp;·&nbsp; <kbd className="bg-bg-elevated border border-border rounded px-1 py-0.5 text-[10px]">M</kbd> = you talking
            </div>
          </div>
          <div className={`w-9 h-5 rounded-full transition-colors relative ${
            manualMode ? 'bg-accent' : 'bg-bg-elevated border border-border'
          }`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
              manualMode ? 'left-4' : 'left-0.5'
            }`} />
          </div>
        </div>

        <button
          onClick={() => onStart(buildContext(), manualMode)}
          disabled={!deepgramKeyPresent}
          className="w-full py-4 rounded-xl bg-accent text-bg font-semibold text-base hover:bg-accent/90 disabled:bg-bg-card disabled:text-text-dim disabled:cursor-not-allowed transition"
        >
          Start session
        </button>

        <p className="mt-6 text-center text-xs text-text-dim">
          Runs locally · No data leaves your machine except to Deepgram &amp; Anthropic
        </p>
      </div>
    </div>
  );
}
