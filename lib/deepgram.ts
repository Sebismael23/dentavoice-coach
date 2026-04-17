// -----------------------------------------------------------------------------
// Deepgram live transcription
// -----------------------------------------------------------------------------
// Opens a WebSocket to Deepgram's streaming endpoint and pipes in audio.
//
// TWO MODES:
//   STEREO (full): multichannel=true, channels=2.
//     Channel 0 = prospect (tab audio), Channel 1 = Seb (mic).
//     Speaker attribution by channel index — reliable.
//
//   MONO (mic-only): multichannel=false, diarize=true.
//     Single mic captures both voices. Deepgram separates speakers via
//     diarization. Speaker 0 = first voice detected (usually Seb).
// -----------------------------------------------------------------------------

import type { TranscriptSegment } from './types';

export interface DeepgramConnection {
  /** Gracefully close the socket and recorder. */
  close: () => void;
  /** Current ready state for debugging. */
  getState: () => 'connecting' | 'open' | 'closed' | 'error';
}

export interface DeepgramOptions {
  apiKey: string;
  stream: MediaStream;
  micOnly: boolean;
  onSegment: (segment: TranscriptSegment) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
}

/**
 * Build the Deepgram streaming URL based on the audio mode.
 */
function buildDeepgramUrl(micOnly: boolean): string {
  const params: Record<string, string> = {
    model: 'nova-3',
    language: 'en-US',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '400',        // slightly faster endpointing
    utterance_end_ms: '800',   // faster utterance detection
  };

  if (micOnly) {
    // Mono mic: use diarization for speaker separation
    params.diarize = 'true';
    // Don't set multichannel — single channel with diarization
  } else {
    // Stereo: use multichannel for reliable speaker attribution
    params.multichannel = 'true';
    params.channels = '2';
  }

  return `wss://api.deepgram.com/v1/listen?${new URLSearchParams(params).toString()}`;
}

export function startDeepgramStream(opts: DeepgramOptions): DeepgramConnection {
  let state: 'connecting' | 'open' | 'closed' | 'error' = 'connecting';
  const { micOnly } = opts;

  console.log(`[deepgram] Connecting — mode: ${micOnly ? 'MONO+DIARIZE' : 'STEREO+MULTICHANNEL'}`);
  const ws = new WebSocket(buildDeepgramUrl(micOnly), ['token', opts.apiKey]);
  const mediaRecorder = new MediaRecorder(opts.stream, {
    mimeType: 'audio/webm;codecs=opus',
  });

  let keepaliveId: ReturnType<typeof setInterval> | null = null;

  ws.addEventListener('open', () => {
    state = 'open';
    console.log('[deepgram] WebSocket connected');
    opts.onOpen?.();

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then((buf) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(buf);
          }
        });
      }
    });

    mediaRecorder.start(200); // 200ms chunks — lower latency
    console.log('[deepgram] MediaRecorder started, mimeType:', mediaRecorder.mimeType);

    // Deepgram closes idle sockets after ~10s. Keep warm during quiet stretches.
    keepaliveId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== 'Results') return;

      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      const transcript: string = alt.transcript.trim();
      if (transcript.length === 0) return;

      let speaker: 'prospect' | 'me';

      if (micOnly) {
        // Diarization mode: use word-level speaker IDs
        // Speaker 0 = first voice detected (typically Seb, closest to mic)
        // Speaker 1+ = other voices (prospect from phone speaker)
        const words = alt.words as Array<{ speaker?: number }> | undefined;
        const firstWordSpeaker = words?.[0]?.speaker ?? 0;
        speaker = firstWordSpeaker === 0 ? 'me' : 'prospect';
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
      new Error('Deepgram socket error. Check your API key and network.')
    );
  });

  ws.addEventListener('close', (event) => {
    state = 'closed';
    console.warn('[deepgram] WebSocket closed — code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
    if (keepaliveId) {
      clearInterval(keepaliveId);
      keepaliveId = null;
    }
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {
      // ignore
    }
  });

  const close = () => {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {
      // ignore
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      ws.close();
    } catch {
      // ignore
    }
    if (keepaliveId) {
      clearInterval(keepaliveId);
      keepaliveId = null;
    }
    state = 'closed';
  };

  return { close, getState: () => state };
}
