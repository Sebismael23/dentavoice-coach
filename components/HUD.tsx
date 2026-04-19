'use client';

import { useEffect, useState } from 'react';
import type { RenderedHint, TransferTarget } from '@/lib/types';

interface HUDProps {
  hint: RenderedHint | null;
  isLoading: boolean;
  callContext: string;
  transferTarget: TransferTarget | null;
  hintHistory: RenderedHint[];
}

export function HUD({
  hint,
  isLoading,
  callContext,
  transferTarget,
  hintHistory,
}: HUDProps) {
  // Age the hint for subtle visual decay after 15s
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const transferLabel =
    transferTarget === 'office_manager'
      ? 'Office Manager'
      : transferTarget === 'dentist'
      ? 'Dentist'
      : null;

  // --- EMPTY STATE (no hint yet) ---
  if (!hint) {
    return (
      <div className="flex-1 flex">
        {/* Main panel — waiting state */}
        <div className="flex-[7] flex items-center justify-center px-8 border-r border-border-subtle">
          <div className="max-w-2xl w-full text-center">
            <div className="text-sm uppercase tracking-[0.2em] text-text-muted mb-4">
              Waiting for prospect to speak
            </div>
            {isLoading && (
              <div className="flex items-center justify-center gap-1.5 mt-6">
                <div className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
                <div
                  className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse"
                  style={{ animationDelay: '0.2s' }}
                />
                <div
                  className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse"
                  style={{ animationDelay: '0.4s' }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Sidebar — context only */}
        <div className="flex-[3] bg-bg-elevated overflow-y-auto scrollbar-thin">
          <SidebarContent
            callContext={callContext}
            transferLabel={transferLabel}
            signal={null}
            why={null}
            playId={null}
            hintHistory={[]}
            now={now}
          />
        </div>
      </div>
    );
  }

  const ageSec = (now - hint.timestamp) / 1000;
  const opacity = ageSec > 15 ? 0.45 : 1;

  return (
    <div className="flex-1 flex">
      {/* ============ MAIN PANEL — "SAY THIS" ============ */}
      <div className="flex-[7] flex items-center justify-center px-8 py-8 bg-gradient-surface border-r border-border-subtle">
        <div
          key={hint.id}
          className="max-w-2xl w-full animate-slide-up"
          style={{ opacity, transition: 'opacity 0.6s' }}
        >
          {/* Tiny metadata bar */}
          <div className="flex items-center gap-3 mb-5 justify-center">
            <span className="text-[11px] uppercase tracking-[0.18em] font-medium text-text-muted">
              Say this
            </span>
            <span className="h-px w-8 bg-border" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-accent-dim">
              {hint.move}
            </span>

          </div>

          {/* The main hint text */}
          <div className="text-hint text-accent text-center px-4 leading-[1.15]">
            &ldquo;{hint.say}&rdquo;
          </div>
        </div>
      </div>

      {/* ============ SIDEBAR — CONTEXT & TIPS ============ */}
      <div className="flex-[3] bg-bg-elevated overflow-y-auto scrollbar-thin">
        <SidebarContent
          callContext={callContext}
          transferLabel={transferLabel}
          signal={hint.signal}
          why={hint.why}
          playId={hint.playId ?? null}
          hintHistory={hintHistory}
          now={now}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — separated into its own component for clarity
// ---------------------------------------------------------------------------

interface SidebarContentProps {
  callContext: string;
  transferLabel: string | null;
  signal: string | null;
  why: string | null;
  playId: number | null;
  hintHistory: RenderedHint[];
  now: number;
}

function SidebarContent({
  callContext,
  transferLabel,
  signal,
  why,
  playId,
  hintHistory,
  now,
}: SidebarContentProps) {
  return (
    <div className="p-4 space-y-4">
      {/* Coaching insight — WHY this move */}
      {why && (
        <SidebarCard label="Coach's Thinking" accent>
          <p className="text-sm text-text-secondary leading-relaxed">
            {why}
          </p>
        </SidebarCard>
      )}

      {/* Signal — what the coach noticed */}
      {signal && (
        <SidebarCard label="Signal Detected">
          <p className="text-xs text-text-secondary italic leading-relaxed">
            &ldquo;{signal}&rdquo;
          </p>
          {playId && (
            <p className="text-[10px] text-text-dim mt-1">
              Strategy from Play #{playId}
            </p>
          )}
        </SidebarCard>
      )}

      {/* Call context */}
      {callContext && (
        <SidebarCard label="Call context">
          <p className="text-xs text-text-secondary italic leading-relaxed">
            {callContext}
          </p>
        </SidebarCard>
      )}

      {/* Transfer status */}
      {transferLabel && (
        <SidebarCard label="Transfer">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-signal-ok" />
            <span className="text-xs text-signal-ok font-medium">
              Transferred to {transferLabel}
            </span>
          </div>
        </SidebarCard>
      )}

      {/* Hint history — last 3 */}
      {hintHistory.length > 0 && (
        <SidebarCard label="Recent hints">
          <div className="space-y-2">
            {hintHistory.slice(-3).reverse().map((h) => {
              const ageMs = now - h.timestamp;
              const ageSec = Math.floor(ageMs / 1000);
              const ageLabel =
                ageSec < 60
                  ? `${ageSec}s ago`
                  : `${Math.floor(ageSec / 60)}m ago`;

              return (
                <div key={h.id} className="text-xs opacity-60">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-accent-dim">
                      {h.move}
                    </span>
                    <span className="text-text-dim">{ageLabel}</span>
                  </div>
                  <p className="text-text-secondary truncate leading-relaxed">
                    &ldquo;{h.say}&rdquo;
                  </p>
                </div>
              );
            })}
          </div>
        </SidebarCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function SidebarCard({
  label,
  accent,
  children,
}: {
  label: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg p-3 ${
        accent
          ? 'bg-accent/5 border border-accent/15'
          : 'bg-bg-card border border-border-subtle'
      }`}
    >
      <div
        className={`text-[10px] uppercase tracking-[0.15em] font-medium mb-2 ${
          accent ? 'text-accent-dim' : 'text-text-muted'
        }`}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const colors: Record<string, string> = {
    opening: 'bg-signal-info/15 text-signal-info border-signal-info/20',
    diagnostic: 'bg-accent/10 text-accent border-accent/20',
    pitch: 'bg-signal-ok/15 text-signal-ok border-signal-ok/20',
    objection: 'bg-signal-warn/15 text-signal-warn border-signal-warn/20',
    close: 'bg-signal-live/15 text-signal-live border-signal-live/20',
  };

  return (
    <span
      className={`text-[10px] uppercase tracking-[0.12em] font-medium px-2 py-0.5 rounded border ${
        colors[stage] || 'bg-bg-elevated text-text-muted border-border'
      }`}
    >
      {stage}
    </span>
  );
}
