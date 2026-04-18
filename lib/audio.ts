// -----------------------------------------------------------------------------
// Audio capture
// -----------------------------------------------------------------------------
// Captures two sources and merges them into a single stereo MediaStream:
//   - Left channel (0): prospect's voice, from the browser tab running Quo
//   - Right channel (1): Seb's voice, from the laptop microphone
//
// Deepgram receives this stereo stream with multichannel=true and labels
// transcripts by channel index. This gives reliable speaker attribution
// without relying on diarization inference.
//
// FALLBACK: If the user cancels/denies screen share, we fall back to mic-only
// mode. The raw mic stream is sent as mono. Deepgram uses diarization to try
// to distinguish speakers. Works for phone-next-to-computer setups.
// -----------------------------------------------------------------------------

export interface CapturedAudio {
  /** The stream to send to Deepgram. Stereo in full mode, mono in mic-only. */
  stream: MediaStream;
  /** Call this to fully stop all tracks and release permissions. */
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

/**
 * Request tab-audio (screen share with audio) and microphone permissions,
 * then mix both into one stereo MediaStream ready for Deepgram.
 *
 * FALLBACK: If screen share is cancelled/denied, returns the raw mic stream
 * in mono. Deepgram will use diarization for speaker separation.
 */
export async function captureCallAudio(): Promise<CapturedAudio> {
  let tabStream: MediaStream | null = null;
  let micOnly = false;

  // 1. Tab audio — prospect's voice coming out of Quo
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
      console.warn('[audio] Tab shared but no audio track — falling back to mic-only');
      tabStream.getTracks().forEach((t) => t.stop());
      tabStream = null;
      micOnly = true;
    } else {
      console.log('[audio] Tab audio captured successfully');
    }
  } catch (err) {
    console.warn('[audio] Screen share cancelled/denied — falling back to mic-only mode');
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

  // ----- MIC-ONLY: return raw mono mic stream, no merge -----
  if (!tabStream) {
    const stop = () => {
      try {
        micStream.getTracks().forEach((t) => t.stop());
      } catch {}
    };
    console.log('[audio] Ready — mode: MIC-ONLY (mono, diarization will be used)');
    return { stream: micStream, stop, micOnly: true };
  }

  // ----- FULL MODE: merge into stereo. Left = prospect, Right = Seb -----
  const ctx = new AudioContext();
  const merger = ctx.createChannelMerger(2);

  const tabSource = ctx.createMediaStreamSource(tabStream);
  const micSource = ctx.createMediaStreamSource(micStream);

  tabSource.connect(merger, 0, 0); // prospect -> left
  micSource.connect(merger, 0, 1); // Seb     -> right

  const dest = ctx.createMediaStreamDestination();
  merger.connect(dest);

  const stop = () => {
    try {
      tabStream?.getTracks().forEach((t) => t.stop());
      micStream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    } catch {}
  };

  console.log('[audio] Ready — mode: STEREO (tab + mic)');
  return { stream: dest.stream, stop, micOnly: false };
}
