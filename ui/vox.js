// ui/vox.js — playing the neural voice.
//
// piper.js streams raw 16-bit mono PCM as it is generated, in chunks that have
// nothing to do with sentence boundaries. This turns each chunk into an
// AudioBuffer and schedules it end-to-end against the audio clock, so the
// speech comes out as one continuous line rather than a series of clicks with
// gaps between them.
//
// Scheduling against ctx.currentTime rather than setTimeout is the whole point:
// a timer drifts by milliseconds and every drift is an audible seam.

const Vox = (() => {
  let ctx = null;
  let nextAt = 0;          // where on the audio clock the next chunk belongs
  let live = [];           // sources still scheduled, so stop() can cut them
  let onDone = null;
  let doneTimer = null;

  const waiting = [];       // chunks that arrived before the context was running
  let resuming = false;
  let played = 0;           // seconds of audio actually scheduled, for the self-test

  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  // Chromium starts an AudioContext suspended until the page has been
  // interacted with, and resume() is a promise. Scheduling against a clock that
  // is not running loses the audio, so anything that arrives early is held in
  // order and released together the moment the context is live.
  function whenRunning(fn) {
    const c = context();
    if (c.state === 'running') { fn(); return; }
    waiting.push(fn);
    if (resuming) return;
    resuming = true;
    c.resume().then(() => {
      resuming = false;
      const q = waiting.splice(0);
      for (const f of q) f();
    }).catch(() => { resuming = false; waiting.length = 0; });
  }

  // Fires once the last scheduled chunk has actually finished sounding — which
  // is much later than the last chunk arriving, because generating is about
  // thirteen times faster than speaking. The microphone must stay shut until
  // then or the agent transcribes its own voice back in as an instruction.
  function armDone() {
    clearTimeout(doneTimer);
    const left = Math.max(0, nextAt - context().currentTime);
    doneTimer = setTimeout(() => {
      live = [];
      if (onDone) onDone();
    }, left * 1000 + 120);
  }

  function play(b64, rate) {
    whenRunning(() => schedule(b64, rate));
  }

  function schedule(b64, rate) {
    const bin = atob(b64);
    const n = bin.length >> 1;                 // 16-bit samples
    if (!n) return;

    const c = context();
    const buf = c.createBuffer(1, n, rate || 22050);
    const out = buf.getChannelData(0);

    // Little-endian signed 16-bit to float. Reading the string directly beats
    // building an intermediate Uint8Array for something this hot.
    for (let i = 0; i < n; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      let v = (hi << 8) | lo;
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }

    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);

    // A chunk that arrives after everything queued has already played starts
    // now; otherwise it goes on the end of the queue.
    const at = Math.max(c.currentTime + 0.02, nextAt);
    src.start(at);
    nextAt = at + buf.duration;
    played += buf.duration;
    live.push(src);
    src.onended = () => { live = live.filter((s) => s !== src); };
    armDone();
  }

  function stop() {
    clearTimeout(doneTimer);
    for (const s of live) { try { s.stop(); } catch { /* already finished */ } }
    live = [];
    nextAt = ctx ? ctx.currentTime : 0;
  }

  return {
    play,
    stop,
    // For the panel's self-test: what the audio layer has actually done, so a
    // silent reply can be told apart from a reply that never arrived.
    stats: () => ({ state: ctx ? ctx.state : 'not started', seconds: played, queued: waiting.length }),
    resetStats: () => { played = 0; },
    setDoneListener: (cb) => { onDone = cb; },
    // How much is still queued to say, in seconds.
    remaining: () => (ctx ? Math.max(0, nextAt - ctx.currentTime) : 0),
    speaking: () => Boolean(live.length) || (ctx ? nextAt > ctx.currentTime : false),
  };
})();

window.Vox = Vox;
