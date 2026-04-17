'use client';

import { useState } from 'react';

interface SetupScreenProps {
  onStart: (callContext: string) => void;
  deepgramKeyPresent: boolean;
  error: string | null;
}

const CONTEXT_PRESETS = [
  'Cold call, gatekeeper probable',
  'Office Manager, first contact',
  'Dentist direct, first contact',
  'Scheduled callback — already warm',
  'Voicemail drop expected',
];

export function SetupScreen({ onStart, deepgramKeyPresent, error }: SetupScreenProps) {
  const [callContext, setCallContext] = useState('');

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

        {/* Call context — the priming field */}
        <div className="bg-bg-card border border-border-subtle rounded-xl p-5 mb-5">
          <label className="block text-xs uppercase tracking-[0.15em] text-text-muted font-medium mb-3">
            Who are you calling? <span className="text-text-dim normal-case tracking-normal">(optional but recommended)</span>
          </label>
          <textarea
            value={callContext}
            onChange={(e) => setCallContext(e.target.value)}
            placeholder="e.g., OM Sarah at Harmony Dental — scheduled callback, she asked about phone coverage last week"
            rows={2}
            className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent/50 resize-none"
          />
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {CONTEXT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCallContext(preset)}
                className="text-[11px] px-2.5 py-1 rounded-md bg-bg-elevated border border-border text-text-secondary hover:text-text-primary hover:border-border transition"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Pre-flight checklist */}
        <div className="bg-bg-card border border-border-subtle rounded-xl p-5 mb-5">
          <h2 className="text-xs uppercase tracking-[0.15em] text-text-muted font-medium mb-3">
            Before you start
          </h2>
          <ul className="space-y-2.5 text-sm">
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

        <button
          onClick={() => onStart(callContext.trim())}
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
