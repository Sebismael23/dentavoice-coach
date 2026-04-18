'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureCallAudio, AudioCaptureError, type CapturedAudio } from '@/lib/audio';
import { startDeepgramStream, type DeepgramConnection } from '@/lib/deepgram';
import { ClaudeCoach, resolveHint, shouldAskCoach } from '@/lib/coach';
import type { Play, RenderedHint, TranscriptSegment, TransferTarget } from '@/lib/types';
import { HUD } from './HUD';
import { StatusBar } from './StatusBar';
import { TranscriptView } from './TranscriptView';

interface CallSessionProps {
  plays: Play[];
  pollIntervalMs: number;
  windowSeconds: number;
  callContext: string;
  onEnd: () => void;
}

/**
 * Trim the transcript to only segments within the rolling window.
 * Keeps memory bounded on long calls and keeps the LLM context focused.
 */
function trimTranscript(
  segments: TranscriptSegment[],
  windowSeconds: number
): TranscriptSegment[] {
  const cutoff = Date.now() - windowSeconds * 1000;
  return segments.filter((s) => s.timestamp >= cutoff);
}

export function CallSession({
  plays,
  pollIntervalMs,
  windowSeconds,
  callContext,
  onEnd,
}: CallSessionProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [hint, setHint] = useState<RenderedHint | null>(null);
  const [isLoadingHint, setIsLoadingHint] = useState(false);
  const [hintCount, setHintCount] = useState(0);
  const [fallbackCount, setFallbackCount] = useState(0);
  const [deepgramState, setDeepgramState] = useState<
    'connecting' | 'open' | 'closed' | 'error'
  >('connecting');
  const [startedAt] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [isMicOnly, setIsMicOnly] = useState(false);
  const [hintHistory, setHintHistory] = useState<RenderedHint[]>([]);

  // --- Transfer state ---
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(null);
  const [transferredAt, setTransferredAt] = useState<number | null>(null);

  const audioRef = useRef<CapturedAudio | null>(null);
  const dgRef = useRef<DeepgramConnection | null>(null);
  const coachRef = useRef(new ClaudeCoach());
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const lastCoachCallRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isEndingRef = useRef(false);
  const bootedRef = useRef(false); // Prevent double-boot from strict mode

  // Track whether we need to force the next hint (after transfer)
  const forceNextHintRef = useRef(false);
  const coachInFlightRef = useRef(false);
  const lastHintSayRef = useRef<string | null>(null);
  const lastHintRenderedAtRef = useRef<number>(0);
  // Track transfer target for the tick function (refs avoid stale closures)
  const transferTargetRef = useRef<TransferTarget | null>(null);
  // Explicit phase tracking — don't rely on Claude to infer it
  const callPhaseRef = useRef<'gatekeeper' | 'dm'>('gatekeeper');

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    transferTargetRef.current = transferTarget;
  }, [transferTarget]);

  const cleanup = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    try {
      dgRef.current?.close();
    } catch {}
    dgRef.current = null;
    try {
      audioRef.current?.stop();
    } catch {}
    audioRef.current = null;
  }, []);

  const handleEnd = useCallback(() => {
    if (isEndingRef.current) return;
    isEndingRef.current = true;
    cleanup();
    onEnd();
  }, [cleanup, onEnd]);

  /**
   * Handle mid-call transfer. Clears gatekeeper memory, injects marker,
   * and forces an immediate coaching hint.
   */
  const handleTransfer = useCallback((target: TransferTarget) => {
    const now = Date.now();
    const label = target === 'office_manager' ? 'Office Manager' : 'Dentist';

    // 1. Set transfer state
    setTransferTarget(target);
    setTransferredAt(now);
    transferTargetRef.current = target;
    callPhaseRef.current = 'dm';

    // 2. Clear gatekeeper transcript and inject marker segment
    const markerSegment: TranscriptSegment = {
      id: `transfer-${now}`,
      speaker: 'prospect',
      text: `[TRANSFERRED TO DECISION MAKER — ${label}]`,
      timestamp: now,
      isFinal: true,
    };
    setSegments([markerSegment]);
    segmentsRef.current = [markerSegment];

    // 3. Reset hint state for fresh DM coaching
    setHint(null);
    lastHintAtRef.current = null;
    lastCoachCallRef.current = null;

    // 4. Force immediate hint on next tick
    forceNextHintRef.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      // Guard against double-boot (React strict mode or fast re-renders)
      if (bootedRef.current) return;
      bootedRef.current = true;

      try {
        console.log('[session] Booting — requesting audio capture...');
        const audio = await captureCallAudio();
        if (cancelled) {
          audio.stop();
          return;
        }
        audioRef.current = audio;
        if (audio.micOnly) {
          setIsMicOnly(true);
        }
        console.log('[session] Audio captured — tracks:', audio.stream.getAudioTracks().length, 'micOnly:', audio.micOnly);

        const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
        if (!apiKey) {
          setError('Deepgram API key missing. Check .env.local.');
          return;
        }
        console.log('[session] Deepgram key present, connecting...');

        const dg = startDeepgramStream({
          apiKey,
          stream: audio.stream,
          micOnly: audio.micOnly,
          onOpen: () => {
            console.log('[session] Deepgram connected — transcription starting');
            setDeepgramState('open');
          },
          onError: (err) => {
            console.error('[session] Deepgram error:', err.message);
            setDeepgramState('error');
            setError(err.message);
          },
          onSegment: (seg) => {
            console.log(`[session] Segment [${seg.speaker}] ${seg.isFinal ? 'FINAL' : 'interim'}: "${seg.text}"`);
            setSegments((prev) => {
              const next = [...prev, seg];
              return trimTranscript(next, windowSeconds * 3);
            });
          },
        });
        dgRef.current = dg;

        const tick = async () => {
          if (isEndingRef.current) return;
          if (coachInFlightRef.current) return; // prevent overlapping calls

          const windowed = trimTranscript(segmentsRef.current, windowSeconds);
          const shouldForce = forceNextHintRef.current;

          // Allow the very first hint even with no transcript IF we have context —
          // Claude can prime on the context alone and suggest the right opener.
          const hasContext = callContext.length > 0;
          const hasFirstHintFired = lastHintAtRef.current !== null;
          const allowEarlyHint = hasContext && !hasFirstHintFired && lastCoachCallRef.current === null;

          if (
            !shouldForce &&
            !allowEarlyHint &&
            !shouldAskCoach({
              transcript: windowed,
              lastCallAt: lastCoachCallRef.current,
              minIntervalMs: pollIntervalMs,
              forceNext: shouldForce,
            })
          ) {
            return;
          }

          // Clear force flag after consuming it
          if (shouldForce) {
            forceNextHintRef.current = false;
          }

          // --- Post-hint cooldown: don't call Claude for 8s after rendering ---
          const HINT_COOLDOWN_MS = 8000;
          if (
            !shouldForce &&
            lastHintRenderedAtRef.current > 0 &&
            Date.now() - lastHintRenderedAtRef.current < HINT_COOLDOWN_MS
          ) {
            return;
          }

          // --- Auto-detect phase switch from prospect speech ---
          if (callPhaseRef.current === 'gatekeeper') {
            const prospectText = windowed
              .filter(s => s.speaker === 'prospect' && s.isFinal)
              .map(s => s.text.toLowerCase()).join(' ');
            if (/\b(office manager|practice manager|i'm the (owner|doctor|dentist)|i am the (owner|doctor|dentist))\b/.test(prospectText)) {
              callPhaseRef.current = 'dm';
              console.log('[session] Phase switched to DM (detected from transcript)');
            }
          }

          const tickStart = Date.now();
          lastCoachCallRef.current = tickStart;
          coachInFlightRef.current = true;
          setIsLoadingHint(true);
          console.log('[coach] Calling Claude...', { segments: windowed.length, force: shouldForce });
          try {
            const response = await coachRef.current.getHint({
              transcript: windowed,
              lastHintAt: lastHintAtRef.current,
              callContext: callContext || undefined,
              transferredToDM: transferTargetRef.current || undefined,
              lastHintSay: lastHintSayRef.current || undefined,
              callPhase: callPhaseRef.current,
            });
            const apiMs = Date.now() - tickStart;
            console.log(`[coach] Claude responded in ${apiMs}ms`, response ? `action=${(response as any).action}` : 'null');
            if (isEndingRef.current) return;

            const rendered = resolveHint(response, plays);
            if (rendered) {
              // Deduplicate — don't re-render if same text as current hint
              if (lastHintSayRef.current && rendered.say === lastHintSayRef.current) {
                console.log('[coach] Skipping duplicate hint');
              } else {
                lastHintSayRef.current = rendered.say;
                setHint((prev) => {
                  if (prev) setHintHistory((h) => [...h.slice(-9), prev]);
                  return rendered;
                });
                setHintCount((n) => n + 1);
                if (rendered.source === 'generate') {
                  setFallbackCount((n) => n + 1);
                }
                lastHintAtRef.current = rendered.timestamp;
                lastHintRenderedAtRef.current = Date.now();
                console.log(`[coach] Hint rendered — total latency: ${Date.now() - tickStart}ms — "${rendered.say.slice(0, 60)}..."`);
              }
            }
          } catch (err: any) {
            console.error('[coach] tick failed', err);
          } finally {
            coachInFlightRef.current = false;
            if (!isEndingRef.current) setIsLoadingHint(false);
          }
        };

        pollTimerRef.current = setInterval(tick, pollIntervalMs);
        // Fire first tick quickly — don't wait for the full poll interval
        setTimeout(tick, 300);
      } catch (err) {
        if (err instanceof AudioCaptureError) {
          setError(err.message);
        } else {
          setError((err as Error)?.message || 'Failed to start session');
        }
      }
    };

    boot();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When forceNextHintRef is set (transfer), trigger an immediate tick
  // by firing the tick function outside the interval cycle
  useEffect(() => {
    if (transferredAt && forceNextHintRef.current && pollTimerRef.current) {
      // The tick function is inside the boot closure, so we trigger by
      // clearing and re-setting the interval isn't clean. Instead, we
      // manually call the API here for the transfer hint.
      const fireTransferHint = async () => {
        if (isEndingRef.current) return;
        forceNextHintRef.current = false;
        lastCoachCallRef.current = Date.now();
        setIsLoadingHint(true);
        try {
          const windowed = trimTranscript(segmentsRef.current, windowSeconds);
          const response = await coachRef.current.getHint({
            transcript: windowed,
            lastHintAt: null,
            callContext: callContext || undefined,
            transferredToDM: transferTargetRef.current || undefined,
          });
          if (isEndingRef.current) return;

          const rendered = resolveHint(response, plays);
          if (rendered) {
            setHint((prev) => {
              if (prev) setHintHistory((h) => [...h.slice(-9), prev]);
              return rendered;
            });
            setHintCount((n) => n + 1);
            if (rendered.source === 'generate') {
              setFallbackCount((n) => n + 1);
            }
            lastHintAtRef.current = rendered.timestamp;
          }
        } catch (err: any) {
          console.error('[coach] transfer hint failed', err);
        } finally {
          if (!isEndingRef.current) setIsLoadingHint(false);
        }
      };

      fireTransferHint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferredAt]);

  return (
    <div className="min-h-screen flex flex-col">
      <StatusBar
        isLive={!isEndingRef.current && deepgramState === 'open'}
        startedAt={startedAt}
        deepgramState={deepgramState}
        hintCount={hintCount}
        fallbackCount={fallbackCount}
        onTransfer={handleTransfer}
        transferTarget={transferTarget}
      />

      {/* Mic-only fallback warning */}
      {isMicOnly && (
        <div className="px-6 py-2 border-b border-signal-warn/20 bg-signal-warn/5">
          <div className="text-[11px] text-signal-warn">
            ⚠ Mic-only mode — tab audio not captured. Your voice will appear as &quot;PROSPECT&quot;. For real calls, share the Quo tab with audio.
          </div>
        </div>
      )}

      <HUD
        hint={hint}
        isLoading={isLoadingHint}
        callContext={callContext}
        transferTarget={transferTarget}
        plays={plays}
        hintHistory={hintHistory}
      />

      <div className="border-t border-border-subtle bg-bg-elevated h-48 shrink-0">
        <div className="px-5 py-2.5 border-b border-border-subtle">
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted font-medium">
            Live transcript
          </span>
        </div>
        <TranscriptView segments={segments} />
      </div>

      <div className="px-6 py-4 border-t border-border-subtle bg-bg flex items-center justify-between">
        {error ? (
          <div className="text-sm text-signal-live flex-1 mr-4">{error}</div>
        ) : (
          <div className="text-xs text-text-dim">
            Pin this window to the side of your screen · Glance, don&apos;t stare
          </div>
        )}
        <button
          onClick={handleEnd}
          className="px-5 py-2 rounded-lg bg-bg-card border border-border text-text-primary text-sm font-medium hover:bg-border transition"
        >
          End session
        </button>
      </div>
    </div>
  );
}
