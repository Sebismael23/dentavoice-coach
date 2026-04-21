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
  manualMode: boolean;
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
  manualMode,
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
  const earlyHintRef = useRef<RenderedHint | null>(null);
  const coachRef = useRef(new ClaudeCoach());
  // Wire up early-say callback for streaming partial rendering
  if (!coachRef.current.onEarlySay) {
    coachRef.current.onEarlySay = (say: string) => {
      console.log(`[coach] Early say arrived: "${say.slice(0, 60)}..."`);
      // Create a partial hint with just the say text — metadata will be filled in later
      const partialHint: RenderedHint = {
        id: `${Date.now()}-early-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        say,
        move: '…',
        signal: '…',
        why: '…',
        source: 'coach',
      };
      // Only render if this isn't a dupe of the current hint
      if (lastHintSayRef.current !== say) {
        earlyHintRef.current = partialHint;
        setHint((prev) => {
          if (prev) setHintHistory((h) => [...h.slice(-9), prev]);
          return partialHint;
        });
        lastHintRenderedAtRef.current = Date.now();
        console.log(`[coach] Early hint rendered (say only) — "${say.slice(0, 60)}..."`);
      }
    };
  }
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const lastCoachCallRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<(() => void) | null>(null);
  const isEndingRef = useRef(false);
  const bootedRef = useRef(false); // Prevent double-boot from strict mode

  // Track whether we need to force the next hint (after transfer)
  const forceNextHintRef = useRef(false);
  const coachInFlightRef = useRef(false);
  const lastHintSayRef = useRef<string | null>(null);
  const lastHintPlayIdRef = useRef<number | null>(null);
  const lastHintRenderedAtRef = useRef<number>(0);
  const usedPlayIdsRef = useRef<number[]>([]);
  const consecutiveNullsRef = useRef<number>(0);
  const currentThreadRef = useRef<string>('unknown');
  const recentHintSaysRef = useRef<string[]>([]);
  // Track Seb's speaking state to suppress coaching while he's delivering
  const sebSpeakingRef = useRef(false);
  const sebLastFinalRef = useRef(0);
  // Track transfer target for the tick function (refs avoid stale closures)
  const transferTargetRef = useRef<TransferTarget | null>(null);
  // Explicit phase tracking — don't rely on Claude to infer it
  const callPhaseRef = useRef<'gatekeeper' | 'dm'>('gatekeeper');
  // Manual mode: track active speaker via keyboard
  const [activeSpeaker, setActiveSpeaker] = useState<'prospect' | 'me'>('prospect');
  const activeSpeakerRef = useRef<'prospect' | 'me'>('prospect');

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    transferTargetRef.current = transferTarget;
  }, [transferTarget]);

  // Manual mode keydown listener — P = prospect, M = me
  useEffect(() => {
    if (!manualMode) return;
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'p') {
        activeSpeakerRef.current = 'prospect';
        setActiveSpeaker('prospect');
        console.log('[manual] Speaker → prospect (P)');
      } else if (key === 'm') {
        activeSpeakerRef.current = 'me';
        setActiveSpeaker('me');
        console.log('[manual] Speaker → me (M)');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [manualMode]);

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
    usedPlayIdsRef.current = [];
    consecutiveNullsRef.current = 0;
    lastHintPlayIdRef.current = null;
    currentThreadRef.current = 'unknown';

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
            // Manual mode: override speaker based on last key pressed
            if (manualMode) {
              seg = { ...seg, speaker: activeSpeakerRef.current };
            }

            console.log(`[session] Segment [${seg.speaker}] ${seg.isFinal ? 'FINAL' : 'interim'}: "${seg.text}"`);

            // Track Seb's speaking state
            if (seg.speaker === 'me') {
              if (seg.isFinal) {
                sebLastFinalRef.current = Date.now();
                sebSpeakingRef.current = false;
              } else {
                sebSpeakingRef.current = true;
              }
            }

            // Only add final segments to state
            if (seg.isFinal) {
              setSegments((prev) => {
                const next = [...prev, seg];
                return trimTranscript(next, windowSeconds * 3);
              });
            }

            // Fire coach only on prospect FINAL segments with enough substance
            if (seg.isFinal && seg.speaker === 'prospect' && tickRef.current) {
              const wordCount = seg.text.trim().split(/\s+/).length;
              if (wordCount < 3) {
                console.log(`[coach] Skipping short prospect segment (${wordCount} words): "${seg.text}"`);
                return;
              }
              if (sebSpeakingRef.current) {
                console.log('[coach] Suppressed — Seb is currently speaking');
                return;
              }
              // If a hint is showing but Seb hasn't spoken yet, he's still reading it — don't fire
              if (lastHintRenderedAtRef.current > 0 && sebLastFinalRef.current < lastHintRenderedAtRef.current) {
                console.log('[coach] Suppressed — hint showing, Seb hasn\'t delivered it yet');
                return;
              }
              const msSinceSebSpoke = Date.now() - sebLastFinalRef.current;
              if (msSinceSebSpoke < 2000) {
                console.log(`[coach] Suppressed — Seb spoke ${msSinceSebSpoke}ms ago`);
                return;
              }
              tickRef.current();
            }
          },
        });
        dgRef.current = dg;

        // If context says we're calling a DM directly, start in DM phase
        if (callContext.includes('EXPECTED FIRST CONTACT: Office Manager') || callContext.includes('EXPECTED FIRST CONTACT: Dentist')) {
          console.log('[session] Context says DM expected — starting in DM phase');
          callPhaseRef.current = 'dm';
        }

        const tick = async () => {
          // Store ref for event-driven calls from onSegment
          tickRef.current = tick;
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

          // --- Post-hint cooldown: don't call Claude for 6s after rendering ---
          const HINT_COOLDOWN_MS = 6000;
          if (
            !shouldForce &&
            lastHintRenderedAtRef.current > 0 &&
            Date.now() - lastHintRenderedAtRef.current < HINT_COOLDOWN_MS
          ) {
            return;
          }

          const tickStart = Date.now();
          lastCoachCallRef.current = tickStart;
          coachInFlightRef.current = true;
          earlyHintRef.current = null; // Reset early hint for this tick
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
              usedPlayIds: usedPlayIdsRef.current.length > 0 ? usedPlayIdsRef.current : undefined,
              consecutiveNulls: consecutiveNullsRef.current,
              currentThread: currentThreadRef.current,
              recentHintSays: recentHintSaysRef.current.length > 0 ? recentHintSaysRef.current : undefined,
            });
            const apiMs = Date.now() - tickStart;
            console.log(`[coach] Claude responded in ${apiMs}ms`, response ? `move=${response.move}` : 'null');
            if (response === null) {
              // If an early hint was rendered but full response is null, revert it
              if (earlyHintRef.current) {
                setHint(null);
                earlyHintRef.current = null;
              }
              consecutiveNullsRef.current++;
            } else if (response.thread) {
              currentThreadRef.current = response.thread;
              console.log('[coach] Thread updated:', response.thread);
            }
            if (isEndingRef.current) return;

            const rendered = resolveHint(response, plays);
            if (rendered) {
              // Deduplicate — skip only if exact same text as current hint
              const isDupeText = lastHintSayRef.current && rendered.say === lastHintSayRef.current;
              if (isDupeText) {
                consecutiveNullsRef.current++;
                if (!recentHintSaysRef.current.includes(rendered.say)) {
                  recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                }
                console.log('[coach] Skipping duplicate hint (text)');
              } else {
                consecutiveNullsRef.current = 0;
                lastHintSayRef.current = rendered.say;
                lastHintPlayIdRef.current = rendered.playId ?? null;
                recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                if (rendered.playId != null && !usedPlayIdsRef.current.includes(rendered.playId)) {
                  usedPlayIdsRef.current = [...usedPlayIdsRef.current, rendered.playId];
                }
                // If early hint already rendered the say text, just update metadata in-place
                const earlyHint = earlyHintRef.current as RenderedHint | null;
                if (earlyHint && earlyHint.say === rendered.say) {
                  setHint(rendered); // Replace partial with full (adds move/signal/why)
                  console.log(`[coach] Metadata merged — total latency: ${apiMs}ms — "${rendered.say.slice(0, 60)}..."`);
                } else {
                  setHint((prev) => {
                    if (prev && prev !== earlyHintRef.current) setHintHistory((h) => [...h.slice(-9), prev]);
                    return rendered;
                  });
                  console.log(`[coach] Hint rendered — total latency: ${apiMs}ms — "${rendered.say.slice(0, 60)}..."`);
                }
                setHintCount((n) => n + 1);
                lastHintAtRef.current = rendered.timestamp;
                lastHintRenderedAtRef.current = Date.now();
              }
            }
          } catch (err: any) {
            console.error('[coach] tick failed', err);
          } finally {
            coachInFlightRef.current = false;
            if (!isEndingRef.current) setIsLoadingHint(false);
          }
        };

        // Auto-detect transfer from transcript — if prospect says transfer phrases, switch phase
        // Also detect DM self-identification (prospect says "I'm the office manager")
        const autoDetectTransfer = () => {
          if (callPhaseRef.current === 'dm') return; // already in DM
          const finals = segmentsRef.current.filter(s => s.isFinal && s.speaker === 'prospect');
          const recent = finals.slice(-3).map(s => s.text.toLowerCase()).join(' ');

          // Transfer signals — someone is handing off to the DM
          const transferPhrases = [
            'let me transfer', 'i\'ll transfer', 'let me get',
            'she\'s available', 'he\'s available', 'i\'ll put you through',
            'hold on let me', 'talk to the office manager',
            'talk to the doctor', 'let me connect you',
            'i\'ll get her', 'i\'ll get him',
          ];

          // DM self-identification — prospect IS the decision maker
          const dmIdentityPhrases = [
            'i\'m the office manager', 'i am the office manager',
            'i\'m the practice manager', 'i am the practice manager',
            'this is the office manager', 'i run the office',
            'i run the front office', 'i handle all that',
            'i handle those decisions', 'i make those decisions',
            'that would be me', 'you\'re talking to her',
            'i\'m the one who', 'i\'m the owner',
            'i\'m the dentist', 'i am the dentist',
            'this is dr ', 'i\'m dr ',
          ];

          if (transferPhrases.some(p => recent.includes(p))) {
            console.log('[session] Auto-detected transfer to DM from transcript');
            callPhaseRef.current = 'dm';
            usedPlayIdsRef.current = [];
            consecutiveNullsRef.current = 0;
            lastHintPlayIdRef.current = null;
            currentThreadRef.current = 'unknown';
            forceNextHintRef.current = true;
          } else if (dmIdentityPhrases.some(p => recent.includes(p))) {
            console.log('[session] Auto-detected DM self-identification — switching to DM phase');
            callPhaseRef.current = 'dm';
            // Don't clear usedPlayIds — we may have done useful gatekeeper work
            consecutiveNullsRef.current = 0;
            forceNextHintRef.current = true;
          }
        };

        pollTimerRef.current = setInterval(() => { autoDetectTransfer(); tick(); }, pollIntervalMs);
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
          hintHistory={hintHistory}
          manualMode={manualMode}
          activeSpeaker={activeSpeaker}
        />      <div className="border-t border-border-subtle bg-bg-elevated h-48 shrink-0">
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
