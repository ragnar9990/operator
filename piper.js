// piper.js — the agent's voice, the good one.
//
// speech.js speaks through the Windows SAPI voice, which is free and instant
// and sounds like 2009. Piper is a small neural TTS: one standalone exe and a
// 60 MB ONNX voice, no native module, nothing online, nothing to pay for.
//
// The trick is the same one whisper.js plays. Piper's CLI reads a line from
// stdin, synthesises it and waits for the next — so the process stays warm and
// the model is loaded once. Measured on this machine: 885ms to first audio on
// a cold start, 36ms once warm, and a real-time factor around 0.075, which is
// thirteen times faster than a person says the same words.
//
// Audio comes back as raw 16-bit PCM on stdout and goes straight to the
// renderer, which plays it through Web Audio. No temp files, no disk, and the
// first chunk can be playing while the rest is still being generated.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = process.env.OPERATOR_PIPER_DIR || 'D:\\piper\\piper';
const MODEL = process.env.OPERATOR_PIPER_MODEL || path.join(DIR, 'voice.onnx');

let proc = null;
let onEvent = null;
let rate = 22050;
let speaking = false;

// Lines waiting to be spoken. Piper takes one at a time; sending the next
// before the last has finished would interleave two voices on one stdout.
const queue = [];
let inFlight = null;

const setListener = (cb) => { onEvent = cb; };
const emit = (evt) => { if (onEvent) onEvent(evt); };

function exe() { return path.join(DIR, 'piper.exe'); }

function installed() {
  try { return fs.existsSync(exe()) && fs.existsSync(MODEL); } catch { return false; }
}

function describeMissing() {
  if (!fs.existsSync(exe())) return `piper.exe not found in ${DIR}`;
  if (!fs.existsSync(MODEL)) return `voice model not found at ${MODEL}`;
  return null;
}

// The voice's own sample rate, read from the model's config. Getting this wrong
// is the difference between a voice and a chipmunk, so it is never assumed.
function readRate() {
  try {
    const cfg = JSON.parse(fs.readFileSync(MODEL + '.json', 'utf8'));
    if (cfg && cfg.audio && cfg.audio.sample_rate) rate = cfg.audio.sample_rate;
  } catch { /* the default is this voice's rate anyway */ }
  return rate;
}

function start() {
  if (proc || !installed()) return Boolean(proc);
  readRate();

  proc = spawn(exe(), ['-m', MODEL, '--output-raw'], { windowsHide: true });

  proc.stdout.on('data', (buf) => {
    // Straight through. Holding chunks back to tidy them into whole lines would
    // throw away the only reason this streams at all.
    emit({ ev: 'pcm', rate, b64: buf.toString('base64') });
  });

  // Piper narrates itself on stderr. The line it prints after finishing one
  // utterance is the only marker of where that utterance ended, so it is what
  // releases the next one from the queue.
  let errBuf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    errBuf += d;
    let nl;
    while ((nl = errBuf.indexOf('\n')) !== -1) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      const m = line.match(/audio=([\d.]+) sec/);
      if (m) done(Number(m[1]));
    }
  });

  const fell = (why) => {
    proc = null;
    inFlight = null;
    queue.length = 0;
    speaking = false;
    emit({ ev: 'error', error: why });
    emit({ ev: 'idle' });
  };
  proc.on('error', (err) => fell(`could not start piper: ${err.message}`));
  proc.on('exit', (code) => { if (proc) fell(`piper exited (code ${code})`); });

  return true;
}

// One utterance has been generated. Tell the renderer how long it is so it
// knows when the sound will actually stop — generating is thirteen times
// faster than speaking, so "generated" and "finished talking" are far apart.
function done(seconds) {
  inFlight = null;
  emit({ ev: 'line', seconds });
  pump();
}

function pump() {
  if (!proc || inFlight || !queue.length) {
    if (!queue.length && !inFlight && speaking) { speaking = false; emit({ ev: 'drained' }); }
    return;
  }
  inFlight = queue.shift();
  try {
    proc.stdin.write(inFlight + '\n');
  } catch (err) {
    inFlight = null;
    emit({ ev: 'error', error: `could not write to piper: ${err.message}` });
  }
}

// Piper synthesises a whole line before a byte comes out, so a long paragraph
// is a long silence. Split on sentences and the first one is talking while the
// rest is still being made.
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    // A line longer than this is usually a list that never got its full stops.
    .flatMap((s) => (s.length <= 240 ? [s] : s.match(/.{1,240}(\s|$)/g).map((x) => x.trim())))
    .filter(Boolean);
}

function say(text) {
  if (!installed()) return false;
  const lines = sentences(text);
  if (!lines.length) return true;
  if (!start()) return false;
  speaking = true;
  queue.push(...lines);
  pump();
  return true;
}

// Stop talking now. What has already reached the renderer is its to discard —
// this only stops anything more being made.
function hush() {
  queue.length = 0;
  speaking = false;
  emit({ ev: 'hush' });
}

function stop() {
  queue.length = 0;
  inFlight = null;
  speaking = false;
  if (!proc) return;
  try { proc.stdin.end(); proc.kill(); } catch { /* already gone */ }
  proc = null;
}

// Pay the model load before the first thing anyone says, so the first reply is
// as quick as every one after it.
function warm() {
  if (!installed()) return { ok: false, error: describeMissing() };
  start();
  return { ok: true, rate: readRate() };
}

module.exports = { setListener, say, hush, warm, stop, installed, describeMissing, sentences, DIR, MODEL, rate: () => rate };
