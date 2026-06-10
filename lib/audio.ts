// -----------------------------------------------------------------------------
// Audio capture
// -----------------------------------------------------------------------------
// Captures two sources and merges them inside ONE AudioContext running at
// 16kHz (Deepgram's native rate for linear16):
//   - Channel 0 (left):  prospect's voice, from the browser tab running the dialer
//   - Channel 1 (right): Seb's voice, from the laptop microphone
//
// The context + merged node are handed to lib/deepgram.ts, which attaches an
// AudioWorklet that streams raw interleaved Int16 PCM. No MediaRecorder, no
// opus encoding, no container buffering — this is the low-latency path.
//
// FALLBACK CHAIN if tab share is cancelled/denied:
//   1. BlackHole virtual device as prospect channel (stereo, reliable)
//   2. Mic-only mono — Deepgram diarization separates speakers (fragile)
// -----------------------------------------------------------------------------

export interface CapturedAudio {
  /** The 16kHz AudioContext owning the graph. deepgram.ts attaches its worklet here. */
  context: AudioContext;
  /** Merged output node. 2 channels in stereo mode, 1 channel in mic-only. */
  sourceNode: AudioNode;
  /** Channel count of sourceNode — drives Deepgram URL params. */
  channels: 1 | 2;
  /** Call this to fully stop all tracks, close the context, release permissions. */
  stop: () => void;
  /** Whether we're running in mic-only fallback mode (no tab audio). */
  micOnly: boolean;
}

export class AudioCaptureError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AudioCaptureError';
  }
}

const TARGET_SAMPLE_RATE = 16000;

/**
 * Request tab-audio (screen share with audio) and microphone permissions,
 * then merge both into one stereo graph ready for PCM extraction.
 */
export async function captureCallAudio(): Promise<CapturedAudio> {
  let tabStream: MediaStream | null = null;
  let micOnly = false;

  // 1. Tab audio — prospect's voice coming out of the dialer tab
  try {
    tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints,
    });

    // Stop the video track immediately — we only need audio
    tabStream.getVideoTracks().forEach((t) => t.stop());

    if (tabStream.getAudioTracks().length === 0) {
      console.warn('[audio] Tab shared but no audio track — falling back');
      tabStream.getTracks().forEach((t) => t.stop());
      tabStream = null;
      micOnly = true;
    } else {
      console.log('[audio] Tab audio captured successfully');
    }
  } catch (err) {
    console.warn('[audio] Screen share cancelled/denied — falling back');
    tabStream = null;
    micOnly = true;
  }

  // 2. Mic — Seb's voice
  // echoCancellation OFF — Chrome's AEC causes prospect voice to leak into
  // the "me" channel when speakers play tab audio. User MUST wear headphones.
  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    console.log('[audio] Microphone captured successfully (AEC disabled)');
  } catch (err) {
    tabStream?.getTracks().forEach((t) => t.stop());
    throw new AudioCaptureError(
      'Microphone permission was denied. Allow microphone access and try again.',
      'MIC_DENIED'
    );
  }

  // One context at 16kHz — Chrome resamples all MediaStream sources into it.
  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  // Contexts created outside a strict user-gesture chain can start suspended.
  await ctx.resume().catch(() => {});

  const buildStereo = (
    prospectStream: MediaStream,
    label: string
  ): CapturedAudio => {
    const merger = ctx.createChannelMerger(2);
    const prospectSource = ctx.createMediaStreamSource(prospectStream);
    const micSource = ctx.createMediaStreamSource(micStream);
    prospectSource.connect(merger, 0, 0); // prospect -> left  (ch 0)
    micSource.connect(merger, 0, 1);      // Seb      -> right (ch 1)

    const stop = () => {
      try {
        prospectStream.getTracks().forEach((t) => t.stop());
        micStream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      } catch {}
    };
    console.log(`[audio] Ready — mode: STEREO (${label}) @ ${ctx.sampleRate}Hz`);
    return { context: ctx, sourceNode: merger, channels: 2, stop, micOnly: false };
  };

  // ----- NO TAB AUDIO: try BlackHole as prospect channel, else mic-only -----
  if (!tabStream) {
    let blackholeStream: MediaStream | null = null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const blackhole = devices.find(
        (d) => d.kind === 'audioinput' && d.label.toLowerCase().includes('blackhole')
      );
      if (blackhole) {
        blackholeStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: blackhole.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        console.log('[audio] BlackHole captured as prospect channel');
      } else {
        console.warn('[audio] BlackHole not found in audio inputs');
      }
    } catch (err) {
      console.warn('[audio] Failed to capture BlackHole:', err);
    }

    if (blackholeStream) {
      return buildStereo(blackholeStream, 'BlackHole + mic');
    }

    // True mic-only fallback (no BlackHole available)
    const micSource = ctx.createMediaStreamSource(micStream);
    const stop = () => {
      try {
        micStream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      } catch {}
    };
    console.log(`[audio] Ready — mode: MIC-ONLY (mono, diarization) @ ${ctx.sampleRate}Hz`);
    return { context: ctx, sourceNode: micSource, channels: 1, stop, micOnly: true };
  }

  // ----- FULL MODE: tab + mic stereo -----
  return buildStereo(tabStream, 'tab + mic');
}
