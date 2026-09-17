// mic.js — listens, decides when a sentence has finished, hands over a WAV.
//
// Whisper transcribes a finished clip rather than a live stream, so the job here
// is to work out where one utterance ends: capture continuously, watch the
// level, and cut when the talking stops.

const MicListener = (() => {
  const TARGET_RATE = 16000;   // what Whisper wants; anything else it resamples badly
  const SILENCE_MS = 700;      // quiet this long ends an utterance
  const MIN_SPEECH_MS = 320;   // shorter than this is a cough, a click, a door
  const MAX_UTTERANCE_MS = 28000;
  const PREROLL_MS = 300;      // kept before speech starts, or the first word clips
  const FLOOR_FRAMES = 40;     // ~100ms of room tone to calibrate against

  let ctx = null;
  let stream = null;
  let node = null;
  let source = null;
  let running = false;

  let rate = 48000;
  let onUtterance = null;
  let onState = null;

  let preroll = [];            // Float32Array chunks, trimmed to PREROLL_MS
  let prerollLen = 0;
  let speech = [];
  let speechLen = 0;
  let speaking = false;
  let quietFor = 0;
  let loudFor = 0;

  let floorSamples = [];
  let threshold = 0.012;

  const msToSamples = (ms) => Math.round((ms / 1000) * rate);

  function reset() {
    preroll = []; prerollLen = 0;
    speech = []; speechLen = 0;
    speaking = false; quietFor = 0; loudFor = 0;
  }

  // Room tone varies wildly between a quiet room and a PC with fans, so the
  // threshold is calibrated from the first moment of audio rather than fixed.
  function calibrate(rms) {
    floorSamples.push(rms);
    if (floorSamples.length < FLOOR_FRAMES) return false;
    const sorted = floorSamples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    threshold = Math.max(median * 4, 0.008);
    return true;
  }

  function onFrame({ pcm, rms }) {
    if (!running) return;
    if (floorSamples.length < FLOOR_FRAMES) {
      calibrate(rms);
      return;
    }

    const frameMs = (pcm.length / rate) * 1000;
    if (onState) onState({ level: rms, threshold, speaking });

    if (!speaking) {
      preroll.push(pcm);
      prerollLen += pcm.length;
      const cap = msToSamples(PREROLL_MS);
      while (prerollLen > cap && preroll.length > 1) {
        prerollLen -= preroll.shift().length;
      }

      if (rms > threshold) {
        loudFor += frameMs;
        // Require a sustained sound, so a single spike doesn't open a recording.
        if (loudFor >= 60) {
          speaking = true;
          quietFor = 0;
          speech = preroll.slice();
          speechLen = prerollLen;
          preroll = []; prerollLen = 0;
          if (onState) onState({ level: rms, threshold, speaking: true });
        }
      } else {
        loudFor = 0;
      }
      return;
    }

    speech.push(pcm);
    speechLen += pcm.length;
    quietFor = rms > threshold ? 0 : quietFor + frameMs;

    const lengthMs = (speechLen / rate) * 1000;
    if (quietFor >= SILENCE_MS || lengthMs >= MAX_UTTERANCE_MS) {
      const spokenMs = lengthMs - quietFor;
      const captured = speech;
      reset();
      if (spokenMs >= MIN_SPEECH_MS && onUtterance) {
        onUtterance(encodeWav(flatten(captured)));
      }
    }
  }

  function flatten(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  // Straight averaging decimation. The mic runs at 48k and Whisper wants 16k,
  // which is a clean 3:1 — averaging the group is both the resample and a
  // cheap anti-alias filter.
  function downsample(input) {
    if (rate === TARGET_RATE) return input;
    const ratio = rate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(float32) {
    const pcm = downsample(float32);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    str(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, pcm.length * 2, true);

    let at = 44;
    for (let i = 0; i < pcm.length; i++, at += 2) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  async function start(handlers) {
    if (running) return;
    onUtterance = handlers.onUtterance;
    onState = handlers.onState;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,     // stops it hearing its own spoken replies
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    ctx = new AudioContext();
    rate = ctx.sampleRate;
    source = ctx.createMediaStreamSource(stream);

    try {
      await ctx.audioWorklet.addModule('recorder-worklet.js');
      node = new AudioWorkletNode(ctx, 'recorder');
      node.port.onmessage = (e) => onFrame(e.data);
    } catch (err) {
      // Worklets need a module fetch, which can fail under file://. Fall back
      // to the deprecated node rather than losing voice entirely.
      node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        onFrame({ pcm: new Float32Array(ch), rms: Math.sqrt(sum / ch.length) });
      };
    }

    source.connect(node);
    // ScriptProcessor only fires while connected to a destination; a zeroed
    // gain node keeps it running without playing the microphone back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);

    floorSamples = [];
    reset();
    running = true;
  }

  function stop() {
    running = false;
    reset();
    floorSamples = [];
    try { if (node) node.disconnect(); } catch (_) {}
    try { if (source) source.disconnect(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (ctx) ctx.close(); } catch (_) {}
    node = source = stream = ctx = null;
  }

  return {
    start,
    stop,
    isRunning: () => running,
    // Throws away whatever is part-captured — used when Operator starts talking,
    // so a spoken reply never lands as a new instruction.
    discard: () => reset(),
  };
})();

window.MicListener = MicListener;
