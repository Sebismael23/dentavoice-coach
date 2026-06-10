// -----------------------------------------------------------------------------
// PCM AudioWorklet processor
// -----------------------------------------------------------------------------
// Runs on the audio rendering thread. Converts Float32 audio frames into
// interleaved Int16 (linear16) PCM and posts fixed-size chunks to the main
// thread, which forwards them to Deepgram over the WebSocket proxy.
//
// Why this exists: MediaRecorder (webm/opus, 200ms timeslices) added
// ~300-500ms of container/encode buffering before audio even reached
// Deepgram. Raw linear16 at 16kHz with ~96ms chunks removes that buffering
// and gives Deepgram lossless audio (better accuracy than 32kbps opus).
//
// Channel layout (must match lib/audio.ts):
//   channels=2: ch0 = prospect (tab/BlackHole), ch1 = Seb (mic)
//   channels=1: mono mic (diarization mode)
// -----------------------------------------------------------------------------

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.channels = opts.channels === 1 ? 1 : 2;
    // 1536 frames @ 16kHz = 96ms per chunk (12 render quanta of 128 frames)
    this.chunkFrames = opts.chunkFrames || 1536;
    this._alloc();
  }

  _alloc() {
    this.buffer = new Int16Array(this.chunkFrames * this.channels);
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // keep processor alive

    const left = input[0];
    // If a stereo node momentarily delivers one channel, duplicate it so we
    // never emit half-frames (Deepgram requires consistent interleaving).
    const right = this.channels === 2 ? input[1] || input[0] : null;

    for (let i = 0; i < left.length; i++) {
      const base = this.frames * this.channels;

      let l = Math.max(-1, Math.min(1, left[i]));
      this.buffer[base] = l < 0 ? l * 0x8000 : l * 0x7fff;

      if (right) {
        let r = Math.max(-1, Math.min(1, right[i]));
        this.buffer[base + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
      }

      this.frames++;
      if (this.frames >= this.chunkFrames) {
        // Transfer ownership — zero-copy handoff to the main thread
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this._alloc();
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
