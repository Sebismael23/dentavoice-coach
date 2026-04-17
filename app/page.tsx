'use client';

import { useEffect, useState } from 'react';
import { SetupScreen } from '@/components/SetupScreen';
import { CallSession } from '@/components/CallSession';
import type { Play } from '@/lib/types';
import playsData from '@/data/plays.json';

const plays = playsData as Play[];

export default function Page() {
  const [state, setState] = useState<'setup' | 'session' | 'ended'>('setup');
  const [deepgramKeyPresent, setDeepgramKeyPresent] = useState(false);
  const [callContext, setCallContext] = useState('');

  useEffect(() => {
    setDeepgramKeyPresent(Boolean(process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY));
  }, []);

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
        onEnd={() => setState('ended')}
      />
    );
  }

  if (state === 'ended') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="text-[11px] uppercase tracking-[0.2em] text-text-muted mb-3">
            Session ended
          </div>
          <h1 className="text-2xl font-semibold mb-6">Nice work.</h1>
          <p className="text-sm text-text-secondary mb-8">
            Jot one note about what the coach got right and what it missed. That&apos;s
            your Friday iteration input.
          </p>
          <button
            onClick={() => {
              setCallContext('');
              setState('setup');
            }}
            className="px-6 py-2.5 rounded-lg bg-accent text-bg font-medium text-sm hover:bg-accent/90 transition"
          >
            New session
          </button>
        </div>
      </div>
    );
  }

  return (
    <SetupScreen
      onStart={(ctx) => {
        setCallContext(ctx);
        setState('session');
      }}
      deepgramKeyPresent={deepgramKeyPresent}
      error={null}
    />
  );
}
