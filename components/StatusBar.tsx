'use client';

import { useEffect, useState } from 'react';
import type { TransferTarget } from '@/lib/types';

interface StatusBarProps {
  isLive: boolean;
  startedAt: number | null;
  deepgramState: 'connecting' | 'open' | 'closed' | 'error';
  hintCount: number;
  fallbackCount: number;
  onTransfer: (target: TransferTarget) => void;
  transferTarget: TransferTarget | null;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function StatusBar({
  isLive,
  startedAt,
  deepgramState,
  hintCount,
  fallbackCount,
  onTransfer,
  transferTarget,
}: StatusBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const duration = startedAt ? now - startedAt : 0;

  const dgColor =
    deepgramState === 'open'
      ? 'bg-signal-ok'
      : deepgramState === 'connecting'
      ? 'bg-signal-warn'
      : deepgramState === 'error'
      ? 'bg-signal-live'
      : 'bg-text-dim';

  const transferLabel =
    transferTarget === 'office_manager'
      ? 'Office Manager'
      : transferTarget === 'dentist'
      ? 'Dentist'
      : null;

  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-6">
        {/* Live indicator */}
        <div className="flex items-center gap-2.5">
          {isLive ? (
            <div className="recording-dot w-2 h-2 rounded-full bg-signal-live" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-text-dim" />
          )}
          <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            {isLive ? 'Live' : 'Idle'}
          </span>
        </div>

        {/* Timer */}
        <div className="text-sm font-mono tabular-nums text-text-secondary">
          {formatDuration(duration)}
        </div>
      </div>

      <div className="flex items-center gap-5 text-xs">
        {/* Transfer buttons or confirmation */}
        {isLive && !transferTarget && (
          <div className="flex items-center gap-1.5">
            <span className="text-text-dim mr-1 text-[10px] uppercase tracking-[0.12em]">
              Transferred →
            </span>
            <button
              id="transfer-om-btn"
              onClick={() => onTransfer('office_manager')}
              className="px-2.5 py-1 rounded bg-accent/15 text-accent text-[11px] font-medium hover:bg-accent/25 transition-colors border border-accent/20 hover:border-accent/40"
            >
              OM
            </button>
            <button
              id="transfer-dentist-btn"
              onClick={() => onTransfer('dentist')}
              className="px-2.5 py-1 rounded bg-accent/15 text-accent text-[11px] font-medium hover:bg-accent/25 transition-colors border border-accent/20 hover:border-accent/40"
            >
              Dentist
            </button>
          </div>
        )}
        {transferTarget && (
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-signal-ok" />
            <span className="text-signal-ok text-[11px] font-medium">
              ✓ Transferred to {transferLabel}
            </span>
          </div>
        )}

        {/* Deepgram connection */}
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${dgColor}`} />
          <span className="text-text-muted">
            Transcription · <span className="text-text-secondary">{deepgramState}</span>
          </span>
        </div>

        {/* Hint counters */}
        <div className="text-text-muted">
          Hints · <span className="text-text-secondary">{hintCount}</span>
          {fallbackCount > 0 && (
            <>
              {' '}· Fallbacks ·{' '}
              <span className="text-signal-warn">{fallbackCount}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
