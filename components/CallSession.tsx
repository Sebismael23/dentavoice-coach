'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureCallAudio, AudioCaptureError, type CapturedAudio } from '@/lib/audio';
import { startDeepgramStream, type DeepgramConnection } from '@/lib/deepgram';
import { ClaudeCoach, resolveHint } from '@/lib/coach';
import type { Play, RenderedHint, TranscriptSegment, TransferTarget } from '@/lib/types';
import { HUD } from './HUD';
import { StatusBar } from './StatusBar';
import { TranscriptView } from './TranscriptView';

interface CallSessionProps {
  plays: Play[];
  pollIntervalMs: number;
  windowSeconds: number; // legacy prop — no longer used for coach context
  callContext: string;
  keyterms: string[];
  manualMode: boolean;
  onEnd: () => void;
}

/** Cap the transcript sent to the coach. Calls are short — full context wins. */
const COACH_SEGMENT_CAP = 150;

/** Short prospect utterances that MUST still trigger coaching —
 *  decisions, prices, questions. "Yes." after the offer is the whole game. */
const SHORT_TRIGGER_RE =
  /^(yes|yeah|yep|sure|okay|ok|fine|no|nope|why|who|what|when|how much|sounds good|go ahead|that's right|not interested|maybe|hello|hi)\b|[?]\s*$/i;

/** Coalesce window: when prospect finals arrive in quick succession (they're
 *  mid-thought), wait this long for the next one before (re)calling Claude. */
const RESTART_DEBOUNCE_MS = 350;

type TriggerSource = 'event' | 'supersede' | 'interval' | 'transfer';

function capForCoach(segments: TranscriptSegment[]): TranscriptSegment[] {
  const finals = segments.filter((s) => s.isFinal);
  return finals.slice(-COACH_SEGMENT_CAP);
}

/** Token-overlap similarity for fuzzy hint dedupe.
 *  "Who handles decisions about phone systems or front desk tools?" vs
 *  "Who usually handles decisions about phone coverage?" → high overlap → dupe. */
function hintSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });
  return inter / Math.min(A.size, B.size);
}

export function CallSession({
  plays,
  pollIntervalMs,
  windowSeconds: _windowSeconds,
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
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(null);

  const audioRef = useRef<CapturedAudio | null>(null);
  const dgRef = useRef<DeepgramConnection | null>(null);
  const coachRef = useRef(new ClaudeCoach());
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEndingRef = useRef(false);
  const bootedRef = useRef(false);

  // --- Coach request lifecycle ---
  const abortRef = useRef<AbortController | null>(null);
  const coachInFlightRef = useRef(false);
  const lastCallStartRef = useRef<number>(0);
  const requestCoachRef = useRef<((source: TriggerSource, triggerAt?: number) => void) | null>(null);

  // --- Hint state ---
  const streamingHintIdRef = useRef<string | null>(null);
  const lastHintSayRef = useRef<string | null>(null);
  const lastHintMoveRef = useRef<string | null>(null);
  const lastHintPlayIdRef = useRef<number | null>(null);
  const lastHintAtRef = useRef<number | null>(null);
  /** Set at FIRST PAINT of each hint. Interval ticks require prospect speech newer than this. */
  const lastHintPaintAtRef = useRef<number>(0);
  const usedPlayIdsRef = useRef<number[]>([]);
  const consecutiveNullsRef = useRef<number>(0);
  const currentThreadRef = useRef<string>('unknown');
  const currentStepRef = useRef<string | null>(null);
  const recentHintSaysRef = useRef<string[]>([]);
  /** Prospect-final timestamp at the moment of the last null response —
   *  stops the interval timer from re-asking about speech Claude already
   *  declined to coach on (the null-loop during Seb's monologues). */
  const lastNullProspectTsRef = useRef<number>(-1);

  // --- Conversation state ---
  const sebSpeakingRef = useRef(false);
  const sebLastFinalRef = useRef(0);
  const lastProspectFinalAtRef = useRef(0);
  const transferTargetRef = useRef<TransferTarget | null>(null);
  const callPhaseRef = useRef<'gatekeeper' | 'dm'>('gatekeeper');

  // --- Metrics ---
  const triggerAtRef = useRef<number | null>(null); // prospect-final ts that triggered the in-flight call
  const reactionSamplesRef = useRef<number[]>([]);
  const firstPaintDoneRef = useRef(false);

  // Manual mode
  const [activeSpeaker, setActiveSpeaker] = useState<'prospect' | 'me'>('prospect');
  const activeSpeakerRef = useRef<'prospect' | 'me'>('prospect');

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    transferTargetRef.current = transferTarget;
  }, [transferTarget]);

  /** Record one prospect-final → first-paint reaction sample.
   *  Only counts event/supersede-triggered calls — interval follow-ups would
   *  pollute the metric with multi-second non-reactions. */
  const recordReaction = useCallback(() => {
    if (firstPaintDoneRef.current) return;
    firstPaintDoneRef.current = true;
    const triggerAt = triggerAtRef.current;
    if (triggerAt != null) {
      const ms = Date.now() - triggerAt;
      reactionSamplesRef.current = [...reactionSamplesRef.current.slice(-19), ms];
      const avg =
        reactionSamplesRef.current.reduce((a, b) => a + b, 0) /
        reactionSamplesRef.current.length;
      setAvgReactionMs(Math.round(avg));
      console.log(`[metrics] Reaction (prospect-final → first words): ${ms}ms`);
    }
  }, []);

  // Streaming say callback — paints words as they arrive from Claude
  if (!coachRef.current.onSayProgress) {
    coachRef.current.onSayProgress = (say: string, complete: boolean) => {
      if (!complete && say.length < 8) return;
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
        if (!existingId && prev && prev.id !== id) {
          setHintHistory((h) => [...h.slice(-9), prev]);
        }
        return partialHint;
      });

      if (!existingId) {
        lastHintPaintAtRef.current = Date.now();
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
      } else if (key === 'm') {
        activeSpeakerRef.current = 'me';
        setActiveSpeaker('me');
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
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    try {
      abortRef.current?.abort();
    } catch {}
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
   * Mid-call transfer. KEEPS the gatekeeper transcript (the DM's name and
   * missed-call intel live there), inserts a marker, switches phase, and
   * fires an immediate coaching hint.
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
    currentStepRef.current = null;

    const markerSegment: TranscriptSegment = {
      id: `transfer-${now}`,
      speaker: 'prospect',
      text: `[TRANSFERRED TO DECISION MAKER — ${label}]`,
      timestamp: now,
      isFinal: true,
    };
    setSegments((prev) => [...prev, markerSegment]);
    segmentsRef.current = [...segmentsRef.current, markerSegment];

    lastHintPaintAtRef.current = 0;
    requestCoachRef.current?.('transfer');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
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
        if (audio.micOnly) setIsMicOnly(true);
        console.log('[session] Audio captured — channels:', audio.channels, 'micOnly:', audio.micOnly);

        // ===================================================================
        // THE COACH CALL — one code path for every trigger source.
        // ===================================================================
        const runCoachCall = async (source: TriggerSource, triggerAt?: number) => {
          if (isEndingRef.current) return;

          const prospectTsAtCall = lastProspectFinalAtRef.current;
          const coachTranscript = capForCoach(segmentsRef.current);
          const controller = new AbortController();
          abortRef.current = controller;
          coachInFlightRef.current = true;
          lastCallStartRef.current = Date.now();
          streamingHintIdRef.current = null;
          firstPaintDoneRef.current = false;
          triggerAtRef.current = triggerAt ?? null;
          setIsLoadingHint(true);
          console.log(
            `[coach] Calling Claude — source=${source} segments=${coachTranscript.length} phase=${callPhaseRef.current}`
          );

          const tickStart = Date.now();
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
              currentStep: currentStepRef.current || undefined,
              recentHintSays:
                recentHintSaysRef.current.length > 0 ? recentHintSaysRef.current : undefined,
              signal: controller.signal,
            });
            const apiMs = Date.now() - tickStart;
            console.log(`[coach] Claude responded in ${apiMs}ms`, response ? `move=${response.move}` : 'null');

            if (response === null) {
              if (streamingHintIdRef.current) {
                const staleId = streamingHintIdRef.current;
                setHint((prev) => (prev && prev.id === staleId ? null : prev));
                streamingHintIdRef.current = null;
              }
              consecutiveNullsRef.current++;
              lastNullProspectTsRef.current = prospectTsAtCall;
            } else {
              if (response.thread) currentThreadRef.current = response.thread;
              if (response.step) currentStepRef.current = response.step;
            }
            if (isEndingRef.current) return;

            const rendered = resolveHint(response, plays);
            if (rendered) {
              // FUZZY dedupe — near-identical rewordings of the last hints are
              // dupes too ("Who handles decisions about phone systems..." x3).
              const simToLast = lastHintSayRef.current
                ? hintSimilarity(rendered.say, lastHintSayRef.current)
                : 0;
              const simToRecent = Math.max(
                0,
                ...recentHintSaysRef.current.map((h) => hintSimilarity(rendered.say, h))
              );
              // Second dedupe signal: same tactical move + play while the
              // previous hint is still undelivered (Seb hasn't spoken since
              // it painted) = a reworded repeat, not new guidance.
              const sameMoveUndelivered =
                lastHintMoveRef.current != null &&
                rendered.move === lastHintMoveRef.current &&
                (rendered.playId ?? null) === lastHintPlayIdRef.current &&
                lastHintPaintAtRef.current > 0 &&
                sebLastFinalRef.current < lastHintPaintAtRef.current;
              const isDupe = simToLast > 0.8 || simToRecent > 0.9 || sameMoveUndelivered;

              if (isDupe) {
                consecutiveNullsRef.current++;
                if (!recentHintSaysRef.current.includes(rendered.say)) {
                  recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                }
                if (streamingHintIdRef.current) {
                  const staleId = streamingHintIdRef.current;
                  // The streamed text is equivalent guidance — keep it visible,
                  // just stop the caret. Don't count it as a new hint.
                  setHint((prev) =>
                    prev && prev.id === staleId ? { ...prev, streaming: false } : prev
                  );
                  streamingHintIdRef.current = null;
                }
                console.log(
                  `[coach] Skipping near-duplicate hint (sim=${Math.max(simToLast, simToRecent).toFixed(2)}${sameMoveUndelivered ? ', same move undelivered' : ''})`
                );
              } else {
                consecutiveNullsRef.current = 0;
                lastHintSayRef.current = rendered.say;
                lastHintMoveRef.current = rendered.move;
                lastHintPlayIdRef.current = rendered.playId ?? null;
                recentHintSaysRef.current = [...recentHintSaysRef.current.slice(-4), rendered.say];
                if (rendered.playId != null && !usedPlayIdsRef.current.includes(rendered.playId)) {
                  usedPlayIdsRef.current = [...usedPlayIdsRef.current, rendered.playId];
                }

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
                if (!firstPaintDoneRef.current) {
                  lastHintPaintAtRef.current = Date.now();
                  recordReaction();
                }
                console.log(
                  `[coach] Hint complete — total latency: ${apiMs}ms — "${rendered.say.slice(0, 60)}..."`
                );
                setHintCount((n) => n + 1);
                lastHintAtRef.current = rendered.timestamp;
              }
            }
          } catch (err: any) {
            if (err?.name === 'AbortError' || controller.signal.aborted) {
              console.log(`[coach] Aborted in-flight call (superseded by fresher speech)`);
              // Remove any partial paint from the aborted stream
              if (streamingHintIdRef.current) {
                const staleId = streamingHintIdRef.current;
                setHint((prev) => (prev && prev.id === staleId ? null : prev));
                streamingHintIdRef.current = null;
              }
            } else {
              console.error('[coach] call failed', err);
            }
          } finally {
            if (abortRef.current === controller) {
              coachInFlightRef.current = false;
              abortRef.current = null;
              if (!isEndingRef.current) setIsLoadingHint(false);
            }
          }
        };

        /**
         * TRIGGER ENGINE — single entry point for all coach requests.
         *
         * event/supersede: prospect just finished a turn. If a call is in
         *   flight it's now stale — ABORT it and restart with the fresh
         *   transcript after a short debounce (coalesces rapid finals from
         *   a prospect speaking in bursts).
         * interval: safety-net only — fires when there's prospect speech the
         *   current hint hasn't seen and nothing is in flight.
         * transfer: immediate, unconditional.
         */
        const requestCoach = (source: TriggerSource, triggerAt?: number) => {
          if (isEndingRef.current) return;

          if (source === 'transfer') {
            abortRef.current?.abort();
            if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
            runCoachCall('transfer');
            return;
          }

          if (source === 'interval') {
            if (coachInFlightRef.current) return;
            if (restartTimerRef.current) return; // a debounced restart is pending
            if (Date.now() - lastCallStartRef.current < pollIntervalMs) return;
            if (sebSpeakingRef.current) return;
            // Require prospect speech the current hint hasn't reacted to
            const unseenProspect =
              lastProspectFinalAtRef.current > lastHintPaintAtRef.current;
            const firstEver = lastCallStartRef.current === 0 && callContext.length > 0;
            if (!unseenProspect && !firstEver) return;
            // Claude already said null for this exact prospect state — don't re-ask
            if (lastProspectFinalAtRef.current === lastNullProspectTsRef.current) return;
            runCoachCall('interval', unseenProspect ? lastProspectFinalAtRef.current : undefined);
            return;
          }

          // event / supersede — abort stale work, debounce the restart
          abortRef.current?.abort();
          if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
          restartTimerRef.current = setTimeout(() => {
            restartTimerRef.current = null;
            if (sebSpeakingRef.current) return; // Seb started talking during debounce
            runCoachCall(source, triggerAt);
          }, RESTART_DEBOUNCE_MS);
        };
        requestCoachRef.current = requestCoach;

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
            if (manualMode) {
              seg = { ...seg, speaker: activeSpeakerRef.current };
            }

            console.log(
              `[session] Segment [${seg.speaker}] ${seg.isFinal ? 'FINAL' : 'interim'}: "${seg.text}"`
            );

            if (seg.speaker === 'me') {
              if (seg.isFinal) {
                sebLastFinalRef.current = Date.now();
                sebSpeakingRef.current = false;
              } else {
                sebSpeakingRef.current = true;
              }
            }

            if (seg.isFinal) {
              setSegments((prev) => [...prev, seg]);
            }

            // ---- Coach triggering on prospect finals ----
            if (seg.isFinal && seg.speaker === 'prospect') {
              lastProspectFinalAtRef.current = seg.timestamp;

              const text = seg.text.trim();
              const wordCount = text.split(/\s+/).length;
              const isShortTrigger = SHORT_TRIGGER_RE.test(text);
              const substantial = wordCount >= 3 || isShortTrigger;

              if (!substantial) {
                console.log(`[coach] Skipping filler prospect segment: "${text}"`);
                return;
              }
              // Only suppress while Seb is ACTIVELY mid-sentence (interims
              // flowing). "He spoke 2s ago" is normal turn-taking — that's
              // exactly when coaching must fire.
              if (sebSpeakingRef.current) {
                console.log('[coach] Suppressed — Seb is actively speaking');
                return;
              }

              // Mid-flight, restart pending, or a hint is on screen that Seb
              // hasn't delivered yet — the prospect kept talking, so whatever
              // we were computing/showing is stale → supersede.
              const hintAwaitingDelivery =
                lastHintPaintAtRef.current > 0 &&
                sebLastFinalRef.current < lastHintPaintAtRef.current;
              const supersede =
                coachInFlightRef.current ||
                restartTimerRef.current != null ||
                hintAwaitingDelivery;
              requestCoach(supersede ? 'supersede' : 'event', seg.timestamp);
            }
          },
        });
        dgRef.current = dg;

        if (
          callContext.includes('EXPECTED FIRST CONTACT: Office Manager') ||
          callContext.includes('EXPECTED FIRST CONTACT: Dentist')
        ) {
          console.log('[session] Context says DM expected — starting in DM phase');
          callPhaseRef.current = 'dm';
        }

        // Auto-detect transfer / DM self-identification from transcript
        const autoDetectTransfer = () => {
          if (callPhaseRef.current === 'dm') return;
          const finals = segmentsRef.current.filter((s) => s.isFinal && s.speaker === 'prospect');
          const recent = finals.slice(-3).map((s) => s.text.toLowerCase()).join(' ');

          const transferPhrases = [
            'let me transfer', "i'll transfer", 'let me get',
            "she's available", "he's available", "i'll put you through",
            'hold on let me', 'talk to the office manager',
            'talk to the doctor', 'let me connect you',
            "i'll get her", "i'll get him",
          ];
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
            requestCoach('supersede', Date.now());
          } else if (dmIdentityPhrases.some((p) => recent.includes(p))) {
            console.log('[session] Auto-detected DM self-identification — switching to DM phase');
            callPhaseRef.current = 'dm';
            consecutiveNullsRef.current = 0;
            requestCoach('supersede', Date.now());
          }
        };

        pollTimerRef.current = setInterval(() => {
          autoDetectTransfer();
          requestCoach('interval');
        }, pollIntervalMs);
        // Prime the opener hint quickly (also warms the prompt cache)
        setTimeout(() => requestCoach('interval'), 300);
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
