// desktop.js — the agent's real computer: the whole Windows desktop.
//
// Talks to desktop-helper.ps1, kept alive as one process and driven over a
// newline-delimited JSON protocol. No native modules, so `npm run dist` never
// needs a node-gyp rebuild.
//
// Coordinates here are in the same scaled space as the screenshots the agent
// sees (each display capped at 1280 wide), so what it measures on a screenshot
// is what it can click. The helper converts back to physical pixels.

const path = require('path');
const { spawn, execFile } = require('child_process');

// Point Operator at another machine and every tool below drives that one
// instead: same JSON commands, same coordinate space, just sent over the LAN to
// remote-node.ps1 rather than to a helper spawned here. Nothing above this file
// needs to know which it is talking to.
let remote = null;   // { url, token, host }

function useRemote(cfg) {
  remote = cfg && cfg.url ? { url: String(cfg.url).replace(/\/+$/, ''), token: cfg.token || '' } : null;
  return remote;
}

function target() {
  return remote ? { kind: 'remote', url: remote.url } : { kind: 'local' };
}

async function remoteCall(payload, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(`${remote.url}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operator-Token': remote.token },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (res.status === 401) throw new Error('the remote machine rejected the token');
    if (!res.ok) throw new Error(`remote node returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`remote machine timed out on "${payload.cmd}"`);
    // A dead node is the common case here, and "fetch failed" helps nobody.
    if (err.cause || /fetch failed/i.test(err.message)) {
      throw new Error(`cannot reach the remote machine at ${remote.url} — is remote-node.ps1 still running?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ping(cfg) {
  const url = String(cfg.url).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`${url}/ping`, {
      headers: { 'X-Operator-Token': cfg.token || '' },
      signal: ctl.signal,
    });
    if (res.status === 401) throw new Error('the machine answered, but rejected the token');
    if (!res.ok) throw new Error(`node returned ${res.status}`);
    return await res.json();
  } catch (err) {
    // "fetch failed" tells nobody anything. The usual causes are a wrong
    // address, a firewall, or the node not running - say so.
    if (err.name === 'AbortError') throw new Error(`${url} did not answer in time`);
    if (/fetch failed/i.test(err.message) || err.cause) {
      throw new Error(
        `nothing answered at ${url}. Check the node window is still open on that machine, ` +
        `that the address matches its real network adapter (not a virtual one), ` +
        `and that its firewall allows the port.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run the helper on its own hidden Windows desktop instead of the one the user
// is looking at. On a private desktop the agent has its own cursor, its own
// keyboard queue and its own windows, so it can click and type while the user
// keeps working on the real desktop — the one thing a shared desktop can never
// do, because a shared desktop has a single physical keyboard focus. The
// launcher creates the desktop and pipes the same JSON protocol straight
// through, so nothing else in this file needs to know which it is talking to.
let privateDesktop = false;

function usePrivateDesktop(on) {
  on = Boolean(on);
  if (on === privateDesktop) return privateDesktop;
  privateDesktop = on;
  // Respawn on (or off) the private desktop the next time a command is sent.
  stop();
  return privateDesktop;
}

// Private only counts locally; a remote target is a whole other machine already.
const isPrivate = () => privateDesktop && !remote;

let proc = null;
let stdoutBuf = '';
const pending = [];      // FIFO: the helper answers one line per command, in order
let onFrame = null;      // callback(base64, label, mime) so the UI can show a live view
let onPointer = null;    // callback({x, y, display, ms, action}) so the overlay can draw the agent's cursor

function setFrameListener(cb) {
  onFrame = cb;
}

function setPointerListener(cb) {
  onPointer = cb;
}

// The glide happens inside the helper, so JS only learns the endpoints. Rather
// than stream positions back over the protocol, tell the overlay where we are
// heading and how long it will take, and let it run the same easing itself.
function glideMs(x, y, display) {
  const from = lastPointer;
  lastPointer = { x, y, display };
  if (!from || from.display !== display) return 160;
  const dist = Math.hypot(x - from.x, y - from.y);
  if (dist < 6) return 0;
  return Math.min(18, Math.max(6, dist / 45)) * 15.6;
}

let lastPointer = null;

function pointer(action, x, y, display) {
  if (!onPointer || typeof x !== 'number' || typeof y !== 'number') return;
  onPointer({ action, x, y, display, ms: glideMs(x, y, display) });
}

function start() {
  if (proc && !proc.killed) return;

  // The launcher creates a hidden desktop and runs the helper on it, piping the
  // same JSON protocol through; the bare helper drives the shared desktop.
  const script = privateDesktop ? 'desktop-launcher.ps1' : 'desktop-helper.ps1';
  proc = spawn(PS, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, script),
  ], { windowsHide: true });

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(JSON.parse(line));
      } catch (err) {
        waiter.reject(new Error(`bad reply from desktop helper: ${line.slice(0, 200)}`));
      }
    }
  });

  // The helper only writes to stderr when it is dying, so surface it to
  // whoever is waiting rather than letting the call hang to its timeout.
  let stderrBuf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderrBuf += d; });

  const fail = (why) => {
    proc = null;
    stdoutBuf = '';
    while (pending.length) {
      const w = pending.shift();
      clearTimeout(w.timer);
      w.reject(new Error(why));
    }
  };

  proc.on('error', (err) => fail(`could not start desktop helper: ${err.message}`));
  proc.on('exit', (code) => fail(
    `desktop helper exited (code ${code})${stderrBuf ? ': ' + stderrBuf.trim().slice(0, 300) : ''}`));
}

function send(payload, timeoutMs = 30000) {
  start();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = pending.findIndex((p) => p.timer === timer);
      if (i !== -1) pending.splice(i, 1);
      reject(new Error(`desktop helper timed out on "${payload.cmd}"`));
    }, timeoutMs);

    pending.push({ resolve, reject, timer });
    proc.stdin.write(JSON.stringify(payload) + '\n');
  });
}

// Every call goes through here so a helper-side failure reads as a normal
// tool error instead of a rejected promise the agent can't see.
async function call(payload, timeoutMs) {
  const res = remote ? await remoteCall(payload, timeoutMs) : await send(payload, timeoutMs);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'desktop command failed');
  return res;
}

// Reading a window and clicking by name answer "no" as a normal outcome: a
// control that is not there is something the agent needs to be TOLD, along with
// what is there instead, so it can correct itself on the same turn. Throwing
// would collapse that into a bare message and lose the rest of the reply.
async function callSoft(payload, timeoutMs) {
  try {
    const res = remote ? await remoteCall(payload, timeoutMs) : await send(payload, timeoutMs);
    return res || { ok: false, error: 'desktop command failed' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function info() {
  return call({ cmd: 'info' });
}

async function screenshot(display, opts) {
  // opts.w = max width (0 = native, no downscale); opts.q = JPEG quality.
  // Older helpers ignore these and return their default 1280 / q82.
  const payload = { cmd: 'screenshot', display };
  if (opts && opts.w !== undefined) payload.w = opts.w;
  if (opts && opts.q !== undefined) payload.q = opts.q;
  const res = await call(payload, 45000);
  if (onFrame) onFrame(res.image, `Display ${res.display}${res.foreground ? ' — ' + res.foreground : ''}`, res.mime);
  return res;
}

const move = (x, y, display) => { pointer('move', x, y, display); return call({ cmd: 'move', x, y, display }); };
const click = (x, y, button, clicks, display) => { pointer('click', x, y, display); return call({ cmd: 'click', x, y, button, clicks, display }); };
const drag = (x1, y1, x2, y2, display) => {
  pointer('move', x1, y1, display);
  setTimeout(() => pointer('drag', x2, y2, display), 120);
  return call({ cmd: 'drag', x1, y1, x2, y2, display }, 45000);
};
const scroll = (x, y, amount, horizontal, display) => { pointer('scroll', x, y, display); return call({ cmd: 'scroll', x, y, amount, horizontal, display }); };
const typeText = (text) => call({ cmd: 'type', text }, Math.max(30000, text.length * 120));
const pressKeys = (keys) => call({ cmd: 'key', keys });
const listWindows = () => call({ cmd: 'windows' });
// Read a window as text rather than as a picture. The desktop's answer to
// browser_read_text — see the helper for why this exists.
const readScreen = (title, depth, budget) => callSoft({ cmd: 'read', title, depth, budget }, 20000);
const clickText = (text, window) => callSoft({ cmd: 'clicktext', text, window }, 20000);
const focusWindow = (title) => call({ cmd: 'focus', title });
const launch = (target, args) => call({ cmd: 'launch', target, args }, 45000);
const setQuiet = (on) => call({ cmd: 'quiet', on: Boolean(on) });

// Shell work runs in its own short-lived process: a command that blocks or
// waits on input would otherwise wedge the helper's one-line-per-command
// protocol and take every later action down with it.
function runCommand(command, timeoutMs = 60000) {
  // On a remote target the shell has to be the remote one, or the agent would
  // be reading this machine's files while looking at the other machine's screen.
  if (remote) {
    return call({ cmd: 'shell', command }, timeoutMs)
      .then((r) => r.output || '(no output)')
      .catch((err) => `Failed: ${err.message}`);
  }
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter((s) => s && s.trim()).join('\n').trim();
      if (err && err.killed) return resolve(`Timed out after ${timeoutMs / 1000}s.\n${out}`);
      resolve(out || (err ? `Failed: ${err.message}` : '(no output)'));
    });
  });
}

function stop() {
  if (!proc) return;
  try {
    proc.stdin.end();
    proc.kill();
  } catch (_) {}
  proc = null;
}

module.exports = {
  setFrameListener,
  setPointerListener,
  useRemote,
  usePrivateDesktop,
  isPrivate,
  target,
  ping,
  info,
  screenshot,
  move,
  click,
  drag,
  scroll,
  typeText,
  pressKeys,
  listWindows,
  readScreen,
  clickText,
  focusWindow,
  launch,
  setQuiet,
  runCommand,
  stop,
};
