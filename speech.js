// speech.js — the agent talking back, via speech-helper.ps1.
//
// Voice IN lives in whisper.js and ui/mic.js; this half only speaks. Not
// request/response: a 'spoke' event arrives whenever a line finishes, so
// everything the helper says is pushed to a listener rather than awaited.

const path = require('path');
const { spawn } = require('child_process');

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

let proc = null;
let buf = '';
let onEvent = null;
let ready = false;

function setListener(cb) {
  onEvent = cb;
}

function emit(evt) {
  if (onEvent) onEvent(evt);
}

function start() {
  if (proc) return;

  proc = spawn(PS, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'speech-helper.ps1'),
  ], { windowsHide: true });

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.ev === 'ready') ready = true;
        emit(evt);
      } catch (_) {
        // The helper only ever writes JSON; anything else is PowerShell noise.
      }
    }
  });

  let errBuf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { errBuf += d; });

  const down = (why) => {
    proc = null;
    buf = '';
    ready = false;
    emit({ ev: 'error', error: why });
    emit({ ev: 'idle' });
  };

  proc.on('error', (err) => down(`could not start speech: ${err.message}`));
  proc.on('exit', (code) => down(
    `speech helper exited (code ${code})${errBuf ? ': ' + errBuf.trim().slice(0, 200) : ''}`));
}

function send(payload) {
  if (!proc) start();
  try {
    proc.stdin.write(JSON.stringify(payload) + '\n');
  } catch (_) {}
}

const hush = () => { if (proc) send({ cmd: 'hush' }); };
const setVoice = (name) => send({ cmd: 'voice', name });
const setRate = (rate) => send({ cmd: 'rate', rate });

// Markdown and code read terribly aloud, and a wall of text takes forever to
// get through — say the gist and let the transcript carry the detail.
function speakable(text, limit = 420) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/^\s*[-•]\s*/gm, ', ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > limit) {
    const cut = s.slice(0, limit);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut + '…';
  }
  return s;
}

function say(text) {
  const s = speakable(text);
  if (!s) return;
  start();
  send({ cmd: 'say', text: s });
}

function stop() {
  if (!proc) return;
  try {
    proc.stdin.end();
    proc.kill();
  } catch (_) {}
  proc = null;
  ready = false;
}

module.exports = { setListener, say, hush, setVoice, setRate, speakable, stop, isReady: () => ready };
