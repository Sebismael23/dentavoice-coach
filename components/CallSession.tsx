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
  windowSeconds: number; // legacy prop — UI only; coach now gets the full call
  callContext: string;
  keyterms: string[];
  manualMode: boolean;
  onEnd: () => void;
}

/** Cap the transcript sent to the coach. Calls are short — full context wins.
 *  150 final segments ≈ a 15+ minute call; far under any token concern. */
const COACH_SEGMENT_CAP = 150;

/** Short prospect utterances that MUST still trigger coaching —
 *  decisions, prices, questions. "Yes." after the offer is the whole game. */
const SHORT_TRIGGER_RE =
  /^(yes|yeah|yep|sure|okay|ok|fine|no|nope|why|who|what|when|how much|sounds good|go ahead|that's right|not interested|maybe|hello|hi)\b|[?]\s*$/i;

function capForCoach(segments: TranscriptSegment[]): TranscriptSegment[] {
  const finals = segments.filter((s) => s.isFinal);
  return finals.slice(-COACH_SEGMENT_CAP);
}

export function CallSession({
  plays,
  pollIntervalMs,
  windowSeconds: _windowSeconds, // retained for prop compat; no longer trims coach context
  callContext,
  keyterms,
  manualMode,
  onEnd,
}: CallSessionProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [hint, setHint] = useState<RenderedHint | null>(null);
  const [isLoadingHint, setIsLoadingHint] = useState(false);
  const [hintCount, setHintCount] = useState(0);
  const [avgReactionMs, setAvgReactionMs] = useState<number | null>(null);
  const [deepgramState, setDeepgramState] = useState<
    'connecting' | 'open' | 'closed' | 'error'
  >('connecting');
  const [startedAt] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [isMicOnly, setIsMicOnly] = useState(false);
  const [hintHistory, setHintHistory] = useState<RenderedHint[]>([]);

  // --- Transfer state ---
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(null);

  const audioRef = useRef<CapturedAudio | null>(null);
  const dgRef = useRef<DeepgramConnection | null>(null);
  const coachRef = useRef(new ClaudeCoach());
  const streamingHintIdRef = useRef<string | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const lastCoachCallRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<(() => void) | null>(null);
  const isEndingRef = useRef(false);
  const bootedRef = useRef(false); // Prevent double-boot from strict mode

  const forceNextHintRef = useRef(false);
  const coachInFlightRef = useRef(false);
  const lastHintSayRef = useRef<string | null>(null);
  const lastHintRenderedAtRef = useRef<number>(0);
  const usedPlayIdsRef = useRef<number[]>([]);
  const consecutiveNullsRef = useRef<number>(0);
  const currentThreadRef = useRef<string>('unknown');
  const recentHintSaysRef = useRef<string[]>([]);
  // Seb's speaking state — suppress coaching while he's delivering
  const sebSpeakingRef = useRef(false);
  const sebLastFinalRef = useRef(0);
  // Reaction-time metrics: prospect-final → first words on screen
  const lastProspectFinalAtRef = useRef(0);
  const reactionSamplesRef = useRef<number[]>([]);
  const firstPaintDoneRef = useRef(false); // per coach call
  const transferTargetRef = useRef<TransferTarget | null>(null);
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

  /** Record one prospect-final → first-paint reaction sample. */
  const recordReaction = useCallback(() => {
    if (firstPaintDoneRef.current) return;
    firstPaintDoneRef.current = true;
    if (lastProspectFinalAtRef.current > 0) {
      const ms = Date.now() - lastProspectFinalAtRef.current;
      reactionSamplesRef.current = [...reactionSamplesRef.current.slice(-19), ms];
      const avg =
        reactionSamplesRef.current.reduce((a, b) => a + b, 0) /
        reactionSamplesRef.current.length;
      setAvgReactionMs(Math.round(avg));
      console.log(`[metrics] Reaction (prospect-final → first words): ${ms}ms`);
    }
  }, []);

  // Wire up streaming say callback — renders words as they arrive from Claude
  if (!coachRef.current.onSayProgress) {
    coachRef.current.onSayProgress = (say: string, complete: boolean) => {
      // Don't flash single characters; wait for a couple of words
      if (!complete && say.length < 8) return;
      // Dupe of the hint already on screen → ignore (full-response path handles it)
      if (lastHintSayRef.current === say && complete) return;

      const existingId = streamingHintIdRef.current;
      const id = existingId ?? `${Date.now()}-stream-${Math.random().toString(36).slice(2, 8)}`;
      if (!existingId) streamingHintIdRef.current = id;

      const partialHint: RenderedHint = {
        id,
        timestamp: Date.now(),
        say,
        move: '…',
        signal: '…',
        why: '…',
        source: 'coach',
        streaming: !complete,
      };

      setHint((prev) => {
        // First paint of this streaming hint: archive whatever was showing
        if (!existingId && prev && prev.id !== id) {
          setHintHistory((h) => [...h.slice(-9), prev]);
        }
        return partialHint;
      });

      if (!existingId) {
        lastHintRenderedAtRef.current = Date.now();
        recordReaction();
        console.log(`[coach] Streaming say started: "${say.slice(0, 50)}..."`);
      }
    };
  }

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
   * Handle mid-call transfer. KEEPS the gatekeeper transcript (the DM's name
   * and missed-call intel live there), inserts a marker, switches phase, and
   * forces an immediate coaching hint through the normal tick path.
   */
  const handleTransfer = useCallback((target: TransferTarget) => {
    const now = Date.now();
    const label = target === 'office_manager' ? 'Office Manager' : 'Dentist';

    setTransferTarget(target);
    transferTargetRef.current = target;
    callPhaseRef.current = 'dm';
    usedPlayIdsRef.current = [];
    consecutiveNullsRef.current = 0;
    currentThreadRef.current = 'unknown';

    // Insert marker — gatekeeper transcript stays for context mining
    const markerSegment: TranscriptSegment = {
      id: `transfer-${now}`,
      speaker: 'prospect',
      text: `[TRANSFERRED TO DECISION MAKER — ${label}]`,
      timestamp: now,
      isFinal: true,
    };
    setSegments((prev) => [...prev, markerSegment]);
    segmentsRef.current = [...segmentsRef.current, markerSegment];

    // Reset hint pacing and force an immediate warm-open hint
    lastHintAtRef.current = null;
    lastCoachCallRef.current = null;
    lastHintRenderedAtRef.current = 0;
    forceNextHintRef.current = true;
    tickRef.current?.();
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
        console.log(
          '[session] Audio captured — channels:', audio.channels,
          'micOnly:', audio.micOnly
        );

        const dg = startDeepgramStream({
          audio,
          keyterms,
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

            console.log(
              `[session] Segment [${seg.speaker}] ${seg.isFinal ? 'FINAL' : 'interim'}: "${seg.text}"`
            );

            // Track Seb's speaking state
            if (seg.speaker === 'me') {
              if (seg.isFinal) {
                sebLastFinalRef.current = Date.now();
                sebSpeakingRef.current = false;
              } else {
                sebSpeakingRef.current = true;
              }
            }

            // Only add final segments to state — keep the FULL call
            if (seg.isFinal) {
              setSegments((prev) => [...prev, seg]);
            }

            // Fire coach on prospect FINAL segments
            if (seg.isFinal && seg.speaker === 'prospect' && tickRef.current) {
              lastProspectFinalAtRef.current = seg.timestamp;

              const wordCount = seg.text.trim().split(/\s+/).length;
              const isShortTrigger = SHORT_TRIGGER_RE.test(seg.text.trim());
              if (wordCount < 3 && !isShortTrigger) {
                console.log(`[coach] Skipping short prospect segment (${wordCount} words): "${seg.text}"`);
                return;
              }
              if (sebSpeakingRef.current) {
                console.log('[coach] Suppressed — Seb is currently speaking');
                return;
              }

              // SUPERSEDE: a hint is showing and Seb hasn't delivered it yet,
              // but the prospect kept talking. If they said something
              // substantial, the hint is stale — refresh it instead of
              // freezing on outdated guidance.
              const hintShowing =
                lastHintRenderedAtRef.current > 0 &&
                sebLastFinalRef.current < lastHintRenderedAtRef.current;
              if (hintShowing) {
                const substantial = wordCount >= 4 || isShortTrigger;
                const hintAgeMs = Date.now() - lastHintRenderedAtRef.current;
                const sinceLastCall = Date.now() - (lastCoachCallRef.current ?? 0);
                if (substantial && hintAgeMs > 1500 && sinceLastCall > 1500) {
                  console.log('[coach] SUPERSEDE — prospect kept talking, refreshing stale hint');
                  forceNextHintRef.current = true;
                  tickRef.current();
                } else {
                  console.log('[coach] Suppressed — hint showing, prospect addition not substantial yet');
                }
                return;
              }

              const msSinceSebSpoke = Date.now() - sebLastFinalRef.current;
              if (sebLastFinalRef.current > 0 && msSinceSebSpoke < 2000) {
                console.log(`[coach] Suppressed — Seb spoke ${msSinceSebSpoke}ms ago`);
                return;
              }
              tickRef.current();
            }
          },
        });
        dgRef.current = dg;

        // If context says we're calling a DM directly, start in DM phase
        if (
          callContext.includes('EXPECTED FIRST CONTACT: Office Manager') ||
          callContext.includes('EXPECTED FIRST CONTACT: Dentist')
        ) {
          console.log('[session] Context says DM expected — starting in DM phase');
          callPhaseRef.current = 'dm';
        }

        const tick = async () => {
          // Store ref for event-driven calls from onSegment
          tickRef.current = tick;
          if (isEndingRef.current) return;
          if (coachInFlightRef.current) return; // prevent overlapping calls

          const coachTranscript = capForCoach(segmentsRef.current);
          const shouldForce = forceNextHintRef.current;

          // Allow the very first hint even with no transcript IF we have context —
          // Claude can prime on the context alone and suggest the right opener.
          const hasContext = callContext.length > 0;
          const hasFirstHintFired = lastHintAtRef.current !== null;
          const allowEarlyHint =
            hasContext && !hasFirstHintFired && lastCoachCallRef.current === null;

          if (
            !shouldForce &&
            !allowEarlyHint &&
            !shouldAskCoach({
              transcript: coachTranscript,
              lastCallAt: lastCoachCallRef.current,
              minIntervalMs: pollIntervalMs,
              forceNext: shouldForce,
            })
          ) {
            return;
          }

          // --- Post-hint cooldown: don't call Claude for 6s after rendering ---
          // (force/supersede bypasses this — staleness beats pacing)
          const HINT_COOLDOWN_MS = 6000;
          if (
            !shouldForce &&
            lastHintRenderedAtRef.current > 0 &&
            Date.now() - lastHintRenderedAtRef.current < HINT_COOLDOWN_MS
          ) {
            return;
          }

          // Clear force flag after consuming it
          if (shouldForce) {
            forceNextHintRef.current = false;
          }

          const tickStart = Date.now();
          lastCoachCallRef.current = tickStart;
          coachInFlightRef.current = true;
          streamingHintIdRef.current = null; // new streaming hint for this call
          firstPaintDoneRef.current = false;
          setIsLoadingHint(true);
          console.log('[coach] Calling Claude...', {
            segments: coachTranscript.length,
            force: shouldForce,
            phase: callPhaseRef.current,
          });
          try {
            const response = await coachRef.current.getHint({
              transcript: coachTranscript,
              lastHintAt: lastHintAtRef.current,
              callContext: callContext || undefined,
              transferredToDM: transferTargetRef.current || undefined,
              lastHintSay: lastHintSayRef.current || undefined,
              callPhase: callPhaseRef.current,
              usedPlayIds: usedPlayIdsRef.current.length > 0 ? usedPlayIdsRef.current : undefined,
              consecutiveNulls: consecutiveNullsRef.current,
              currentThread: currentThreadRef.current,
              recentHintSays:
                recentHintSaysRef.current.length > 0 ? recentHintSaysRef.current : undefined,
            });
            const apiMs = Date.now() - tickStart;
            console.log(
              `[coach] Claude responded in ${apiMs}ms`,
              response ? `move=${response.move}` : 'null'
            );
            if (response === null) {
              // If a streaming hint was painted but the final response is null, revert it
              if (streamingHintIdRef.current) {
                const staleId = streamingHintIdRef.current;
                setHint((prev) => (prev && prev.id === staleId ? null : prev));
                streamingHintIdRef.current = null;
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
              const isDupeText =
                lastHintSayRef.current && rendered.say === lastHintSayRef.current;
              if (isDupeText) {
                consecutiveNullsRef.current++;
                if (!recentHintSaysRef.current.includes(rendered.say)) {
                  recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                }
                // Revert a streaming paint that turned out to be a dupe
                if (streamingHintIdRef.current) {
                  const staleId = streamingHintIdRef.current;
                  setHint((prev) => (prev && prev.id === staleId ? null : prev));
                  streamingHintIdRef.current = null;
                }
                console.log('[coach] Skipping duplicate hint (text)');
              } else {
                consecutiveNullsRef.current = 0;
                lastHintSayRef.current = rendered.say;
                recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                if (rendered.playId != null && !usedPlayIdsRef.current.includes(rendered.playId)) {
                  usedPlayIdsRef.current = [...usedPlayIdsRef.current, rendered.playId];
                }

                // If the streaming hint already painted this say text, replace
                // it in-place with the full metadata (no re-animation churn).
                const streamId = streamingHintIdRef.current;
                setHint((prev) => {
                  if (prev && streamId && prev.id === streamId) {
                    return { ...rendered, id: streamId, streaming: false };
                  }
                  if (prev && prev.id !== streamId) {
                    setHintHistory((h) => [...h.slice(-9), prev]);
                  }
                  return rendered;
                });
                recordReaction(); // no-op if streaming already recorded first paint
                console.log(
                  `[coach] Hint complete — total latency: ${apiMs}ms — "${rendered.say.slice(0, 60)}..."`
                );
                setHintCount((n) => n + 1);
                lastHintAtRef.current = rendered.timestamp;
                lastHintRenderedAtRef.current = Date.now();
              }
            }
          } catch (err: any) {
            console.error('[coach] tick failed', err);
          } finally {
            coachInFlightRef.current = false;
            streamingHintIdRef.current = null;
            if (!isEndingRef.current) setIsLoadingHint(false);
          }
        };

        // Auto-detect transfer from transcript — if prospect says transfer phrases, switch phase
        // Also detect DM self-identification (prospect says "I'm the office manager")
        const autoDetectTransfer = () => {
          if (callPhaseRef.current === 'dm') return; // already in DM
          const finals = segmentsRef.current.filter((s) => s.isFinal && s.speaker === 'prospect');
          const recent = finals.slice(-3).map((s) => s.text.toLowerCase()).join(' ');

          // Transfer signals — someone is handing off to the DM
          const transferPhrases = [
            'let me transfer', "i'll transfer", 'let me get',
            "she's available", "he's available", "i'll put you through",
            'hold on let me', 'talk to the office manager',
            'talk to the doctor', 'let me connect you',
            "i'll get her", "i'll get him",
          ];

          // DM self-identification — prospect IS the decision maker
          const dmIdentityPhrases = [
            "i'm the office manager", 'i am the office manager',
            "i'm the practice manager", 'i am the practice manager',
            'this is the office manager', 'i run the office',
            'i run the front office', 'i handle all that',
            'i handle those decisions', 'i make those decisions',
            'that would be me', "you're talking to her",
            "i'm the one who", "i'm the owner",
            "i'm the dentist", 'i am the dentist',
            'this is dr ', "i'm dr ",
          ];

          if (transferPhrases.some((p) => recent.includes(p))) {
            console.log('[session] Auto-detected transfer to DM from transcript');
            callPhaseRef.current = 'dm';
            usedPlayIdsRef.current = [];
            consecutiveNullsRef.current = 0;
            currentThreadRef.current = 'unknown';
            forceNextHintRef.current = true;
          } else if (dmIdentityPhrases.some((p) => recent.includes(p))) {
            console.log('[session] Auto-detected DM self-identification — switching to DM phase');
            callPhaseRef.current = 'dm';
            // Don't clear usedPlayIds — we may have done useful gatekeeper work
            consecutiveNullsRef.current = 0;
            forceNextHintRef.current = true;
          }
        };

        pollTimerRef.current = setInterval(() => {
          autoDetectTransfer();
          tick();
        }, pollIntervalMs);
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

  return (
    <div className="min-h-screen flex flex-col">
      <StatusBar
        isLive={!isEndingRef.current && deepgramState === 'open'}
        startedAt={startedAt}
        deepgramState={deepgramState}
        hintCount={hintCount}
        avgReactionMs={avgReactionMs}
        onTransfer={handleTransfer}
        transferTarget={transferTarget}
      />

      {/* Mic-only fallback warning */}
      {isMicOnly && (
        <div className="px-6 py-2 border-b border-signal-warn/20 bg-signal-warn/5">
          <div className="text-[11px] text-signal-warn">
            ⚠ Mic-only mode — tab audio not captured. Speaker separation relies on
            diarization and may misattribute. For real calls, share the dialer tab with audio.
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
      />

      <div className="border-t border-border-subtle bg-bg-elevated h-48 shrink-0 flex flex-col">
        <div className="px-5 py-2.5 border-b border-border-subtle shrink-0">
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted font-medium">
            Live transcript
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <TranscriptView segments={segments} />
        </div>
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
