// -----------------------------------------------------------------------------
// Deepgram live transcription — raw linear16 PCM via AudioWorklet
// -----------------------------------------------------------------------------
// Opens a WebSocket to the local server proxy (server.js handles Deepgram
// auth server-side) and pipes in raw interleaved Int16 PCM @ 16kHz from an
// AudioWorklet. This replaces the old MediaRecorder/webm-opus pipeline:
//   - ~300-500ms lower latency (no encode/container buffering)
//   - lossless audio = better transcription accuracy
//   - exact channel control (no guessing what opus did with the channels)
//
// TWO MODES:
//   STEREO (full): multichannel=true, channels=2.
//     Channel 0 = prospect (tab/BlackHole), Channel 1 = Seb (mic).
//     Speaker attribution by channel index — reliable.
//
//   MONO (mic-only): channels=1, diarize=true.
//     Speaker 0 = first voice = prospect (they answer the phone).
//     Speaker 1 = Seb. Fragile — stereo mode is strongly preferred.
//
// KEYTERMS: nova-3 keyterm prompting boosts recognition of domain words.
// We always send the DentaVoice vocabulary and add the practice/contact
// names from call setup. This directly improves transcript accuracy on the
// words that matter most for coaching.
// -----------------------------------------------------------------------------

import type { TranscriptSegment } from './types';
import type { CapturedAudio } from './audio';

export interface DeepgramConnection {
  /** Gracefully close the socket and audio graph taps. */
  close: () => void;
  /** Current ready state for debugging. */
  getState: () => 'connecting' | 'open' | 'closed' | 'error';
}

export interface DeepgramOptions {
  audio: CapturedAudio;
  /** Extra keyterms (practice name, contact name) to boost recognition. */
  keyterms?: string[];
  onSegment: (segment: TranscriptSegment) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
  /** Fires when the socket closes for ANY reason (incl. Deepgram timeouts
   *  mid dial-block). Lets the session offer a reconnect without re-sharing. */
  onClose?: () => void;
}

/** Domain vocabulary always sent as keyterms (nova-3 keyterm prompting). */
const BASE_KEYTERMS = [
  'DentaVoice',
  'voicemail',
  'office manager',
  'front desk',
  'receptionist',
  'new patient',
  'phone coverage',
];

/**
 * Build the Deepgram streaming query params based on the audio mode.
 */
function buildDeepgramParams(channels: 1 | 2, keyterms: string[]): URLSearchParams {
  const params = new URLSearchParams();
  params.set('model', 'nova-3');
  params.set('language', 'en-US');
  params.set('smart_format', 'true');
  params.set('interim_results', 'true');
  params.set('endpointing', '300');       // ms of silence before finalizing — tuned for speed
  params.set('utterance_end_ms', '1000'); // minimum allowed by Deepgram

  // Raw PCM — must match the AudioWorklet output exactly
  params.set('encoding', 'linear16');
  params.set('sample_rate', '16000');
  params.set('channels', String(channels));

  if (channels === 1) {
    params.set('diarize', 'true');
  } else {
    params.set('multichannel', 'true');
  }

  // Keyterm prompting (nova-3): one param per term, dedupe, skip empties
  const seen = new Set<string>();
  for (const term of [...BASE_KEYTERMS, ...keyterms]) {
    const t = term.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    params.append('keyterm', t);
  }

  return params;
}

export function startDeepgramStream(opts: DeepgramOptions): DeepgramConnection {
  let state: 'connecting' | 'open' | 'closed' | 'error' = 'connecting';
  const { audio } = opts;
  const micOnly = audio.micOnly;

  console.log(
    `[deepgram] Connecting — mode: ${micOnly ? 'MONO+DIARIZE' : 'STEREO+MULTICHANNEL'} (linear16 @ 16kHz)`
  );

  const dgParams = buildDeepgramParams(audio.channels, opts.keyterms ?? []);
  const proxyUrl = `ws://${window.location.host}/api/deepgram-proxy?${dgParams.toString()}`;
  console.log('[deepgram] Proxy URL:', proxyUrl);

  const ws = new WebSocket(proxyUrl);
  ws.binaryType = 'arraybuffer';

  let workletNode: AudioWorkletNode | null = null;
  let silentSink: GainNode | null = null;
  let keepaliveId: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  /** Attach the PCM worklet to the audio graph and start streaming. */
  const startPcmPipeline = async () => {
    try {
      await audio.context.audioWorklet.addModule('/pcm-processor.js');
      if (closed) return;

      workletNode = new AudioWorkletNode(audio.context, 'pcm-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: audio.channels,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete', // never downmix L/R together
        processorOptions: { channels: audio.channels },
      });

      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      // Worklets only run when connected toward the destination.
      // Route through a zero-gain node so nothing is audible.
      silentSink = audio.context.createGain();
      silentSink.gain.value = 0;
      audio.sourceNode.connect(workletNode);
      workletNode.connect(silentSink);
      silentSink.connect(audio.context.destination);

      await audio.context.resume().catch(() => {});
      console.log('[deepgram] PCM pipeline started — 96ms chunks, linear16');
    } catch (err) {
      console.error('[deepgram] Failed to start PCM pipeline', err);
      opts.onError?.(new Error('Audio pipeline failed to start. Reload and try again.'));
    }
  };

  ws.addEventListener('open', () => {
    state = 'open';
    console.log('[deepgram] WebSocket connected to proxy');
    // Don't start streaming yet — wait for proxy_ready from server
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '{}');

      // Proxy signals Deepgram is connected
      if (msg.type === 'proxy_ready') {
        console.log('[deepgram] Deepgram connected via proxy');
        opts.onOpen?.();
        startPcmPipeline();

        // With continuous PCM Deepgram always receives audio (silence included),
        // but keep a KeepAlive as belt-and-suspenders for long holds.
        keepaliveId = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 8000);
        return;
      }

      if (msg.type !== 'Results') return;

      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript: string = alt.transcript.trim();
      if (transcript.length === 0) return;

      let speaker: 'prospect' | 'me';

      if (micOnly) {
        // Diarization mode: use word-level speaker IDs
        // Speaker 0 = first voice detected = prospect (they answer the phone)
        const words = alt.words as Array<{ speaker?: number }> | undefined;
        const firstWordSpeaker = words?.[0]?.speaker ?? 0;
        speaker = firstWordSpeaker === 0 ? 'prospect' : 'me';
      } else {
        // Multichannel mode: use channel index
        // channel_index is [channel, total]. 0 = left = prospect, 1 = right = me.
        const channelIdx: number = msg.channel_index?.[0] ?? 0;
        speaker = channelIdx === 0 ? 'prospect' : 'me';
      }

      const segment: TranscriptSegment = {
        id: `${msg.start ?? Date.now()}-${speaker}-${
          msg.is_final ? 'f' : 'i'
        }-${Math.random().toString(36).slice(2, 8)}`,
        speaker,
        text: transcript,
        timestamp: Date.now(),
        isFinal: Boolean(msg.is_final),
      };

      opts.onSegment(segment);
    } catch (err) {
      console.error('[deepgram] parse error', err);
    }
  });

  ws.addEventListener('error', (event) => {
    state = 'error';
    console.error('[deepgram] WebSocket error event', event);
    opts.onError?.(
      new Error('Deepgram socket error. Check the server logs and your API key.')
    );
  });

  ws.addEventListener('close', (event) => {
    state = 'closed';
    console.warn(
      '[deepgram] WebSocket closed — code:', event.code,
      'reason:', event.reason, 'wasClean:', event.wasClean
    );
    teardownAudioTaps();
    if (keepaliveId) {
      clearInterval(keepaliveId);
      keepaliveId = null;
    }
    opts.onClose?.();
  });

  const teardownAudioTaps = () => {
    try {
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
        workletNode = null;
      }
      if (silentSink) {
        silentSink.disconnect();
        silentSink = null;
      }
    } catch {}
  };

  const close = () => {
    closed = true;
    teardownAudioTaps();
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      ws.close();
    } catch {}
    if (keepaliveId) {
      clearInterval(keepaliveId);
      keepaliveId = null;
    }
    state = 'closed';
  };

  return { close, getState: () => state };
}
