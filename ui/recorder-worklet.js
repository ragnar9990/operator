// recorder-worklet.js — runs on the audio thread.
//
// Ships every render quantum back to the page as raw Float32, plus its RMS so
// the main thread can do voice activity detection without touching the samples.
// Kept deliberately dumb: no buffering or decisions here, because anything that
// blocks this thread is an audible glitch.

class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const ch = input[0];
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];

    this.port.postMessage({
      pcm: new Float32Array(ch),        // copy: the buffer is reused next quantum
      rms: Math.sqrt(sum / ch.length),
    });
    return true;
  }
}

registerProcessor('recorder', Recorder);
