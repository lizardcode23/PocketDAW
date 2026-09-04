// Capture worklet: hands raw input blocks back to the main thread.
// Recording on the audio thread is what keeps takes sample-accurate; a
// ScriptProcessor on the main thread drops blocks whenever the UI is busy.

class PocketRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.recording = true;
      if (e.data === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recording && input && input.length && input[0] && input[0].length) {
      const copy = input.map((channel) => {
        const out = new Float32Array(channel.length);
        out.set(channel);
        return out;
      });
      this.port.postMessage(copy, copy.map((c) => c.buffer));
    }
    return true;
  }
}

registerProcessor('pocket-recorder', PocketRecorder);
