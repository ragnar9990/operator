// whisper.js — speech to text, locally, on the GPU.
//
// Runs whisper.cpp's server rather than its one-shot CLI, because large-v3 is a
// 3.1 GB model: loading it per utterance would cost several seconds every time.
// The server pays that once at startup and then each clip is a local HTTP POST.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Binaries and model live apart: the release zip extracts into Release\, and
// the model sits beside it. Both on D: — C: has under 2 GB free.
const DIR = process.env.OPERATOR_WHISPER_DIR || 'D:\\whisper\\Release';
const MODEL = process.env.OPERATOR_WHISPER_MODEL || 'D:\\whisper\\ggml-large-v3.bin';
const PORT = 8178;
const BASE = `http://127.0.0.1:${PORT}`;

let proc = null;
let starting = null;
let onState = null;

function setStateListener(cb) {
  onState = cb;
}

function state(status, detail) {
  if (onState) onState({ status, detail });
}

function serverExe() {
  for (const name of ['whisper-server.exe', 'server.exe']) {
    const p = path.join(DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function installed() {
  return Boolean(serverExe()) && fs.existsSync(MODEL);
}

function describeMissing() {
  if (!serverExe()) return `whisper-server.exe not found in ${DIR}`;
  if (!fs.existsSync(MODEL)) return `model not found at ${MODEL}`;
  return null;
}

async function alive() {
  try {
    const res = await fetch(BASE, { method: 'GET' });
    return res.status < 500;
  } catch (_) {
    return false;
  }
}

function launch() {
  const exe = serverExe();
  proc = spawn(exe, [
    '-m', MODEL,
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '-l', 'en',
    '-t', '8',
    '--no-timestamps',
    // Stops it emitting [BLANK_AUDIO] and friends as if they were words.
    '--suppress-nst',
  ], { cwd: DIR, windowsHide: true });

  let log = '';
  const note = (d) => {
    log += d;
    if (log.length > 4000) log = log.slice(-2000);
  };
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', note);
  proc.stderr.on('data', note);

  proc.on('exit', (code) => {
    proc = null;
    starting = null;
    state('stopped', `whisper server exited (code ${code})`);
  });
  proc.on('error', (err) => {
    proc = null;
    starting = null;
    state('error', err.message);
  });

  return () => log;
}

// Loading large-v3 onto the GPU takes a few seconds, so callers await this once
// and every later transcription is immediate.
async function ready(timeoutMs = 180000) {
  const missing = describeMissing();
  if (missing) throw new Error(missing);
  if (proc && (await alive())) return;
  if (starting) return starting;

  starting = (async () => {
    if (!proc) {
      state('loading', 'loading Whisper large-v3 onto the GPU…');
      launch();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!proc) throw new Error('whisper server stopped while starting');
      if (await alive()) {
        state('ready', 'Whisper ready');
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('whisper server did not come up in time');
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function transcribe(wav) {
  await ready();

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // Whisper will happily invent words for a clip that is only breathing; giving
  // it nothing to continue from makes that much less likely.
  form.append('no_context', 'true');

  const res = await fetch(`${BASE}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper returned ${res.status}`);

  const body = await res.json().catch(() => null);
  const raw = body && typeof body.text === 'string' ? body.text : '';
  return clean(raw);
}

// The model annotates non-speech rather than returning nothing, and those
// annotations would otherwise be handed to the agent as instructions.
const NOISE = /^[\s.,!?-]*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)[\s.,!?-]*$/i;

// Whisper does not return an empty string for silence — it returns whatever the
// language model finds most likely to follow nothing, which for the YouTube-heavy
// training data is a sign-off. Verified here: a second of digital silence comes
// back as "you". These are artefacts, never something the user said.
const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
  'thank you for watching', 'thanks for watching!', 'bye', 'bye bye', 'goodbye',
  'okay', 'ok', 'oh', 'um', 'uh', 'hmm', 'mm', 'mhm', 'yeah',
  'please subscribe', 'subscribe', 'the end', 'so', 'and', 'i', 'no',
]);

function clean(text) {
  const s = String(text || '')
    .replace(/\[(BLANK_AUDIO|INAUDIBLE|NOISE|SILENCE|MUSIC)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || NOISE.test(s)) return '';

  const bare = s.toLowerCase().replace(/[.,!?¡¿"'’—-]/g, '').replace(/\s+/g, ' ').trim();
  if (HALLUCINATIONS.has(bare)) return '';
  return s;
}

function stop() {
  if (!proc) return;
  try { proc.kill(); } catch (_) {}
  proc = null;
  starting = null;
}

module.exports = { setStateListener, installed, describeMissing, ready, transcribe, stop, clean, DIR, MODEL };
