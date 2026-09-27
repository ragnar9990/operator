// crash.js — catch a crash, write it down, and offer to send it.
//
// A $49 app that dies with no trace is a refund nobody can debug. errors.js
// turns a handled failure into a sentence for the user; this is the other end —
// the failures nobody handled: an uncaught exception in the main process, a
// promise that rejected into the void, the renderer or a child process going
// down. Each one is written to an append-only log, the same shape and the same
// redaction rules as audit.js, so a bug can be found from the report instead of
// from a one-star review.
//
// Nothing leaves this computer on its own. A report is saved locally; sending it
// is the user's choice (Settings, or the notice on next launch). If the owner
// ever stands up a collector, OPERATOR_CRASH_URL turns on an opt-in upload —
// off by default, and never without that variable set.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let dir = null;           // <userData>/crashes
let file = null;          // crashes.jsonl
let prev = null;          // the one rotated generation we still read
let handled = null;       // crashes-handled.json — ids the user has sent or dismissed
let onFatalCb = null;     // main.js decides what a fatal main-process error does
let appInfo = {};         // version / electron / platform, captured once

const MAX_BYTES = 5 * 1024 * 1024;   // crashes are rare and small; a smaller cap than the audit log
const MAX_STACK = 6000;              // enough of a stack to place the fault, not the whole world

/* ── redaction ───────────────────────────────────────────────────────
   A stack or an error message can carry a key that was in scope when it
   threw. Same rule as audit.js: a log that leaks a credential is worse than
   no log. These match the value shapes; the message/stack are free text, so
   there is no key name to go on — shape is all we have. */

const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                        // OpenAI-style keys
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,                     // NVIDIA NIM
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,   // JWT
  /\b(?:\d[ -]?){13,19}\b/g,                         // card number
];

function redact(str) {
  if (!str) return '';
  let out = String(str);
  for (const re of SECRET_VALUE) out = out.replace(re, '[redacted]');
  return out;
}

/* ── writing ─────────────────────────────────────────────────────────── */

function rotate() {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }   // nothing written yet
  if (size < MAX_BYTES) return;
  try {
    fs.rmSync(prev, { force: true });
    fs.renameSync(file, prev);
  } catch { /* keep appending rather than losing the write */ }
}

// The single choke point. `kind` says which safety net caught it; `err` is
// whatever was thrown (an Error, a string, anything); `extra` is small
// structured context, scrubbed the same way.
function record(kind, err, extra) {
  if (!file) return null;
  const e = err instanceof Error ? err : null;
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    t: new Date().toISOString(),
    kind,
    reason: redact(e ? (e.message || String(e)) : String(err || 'unknown')).slice(0, 500),
    stack: e && e.stack ? redact(e.stack).slice(0, MAX_STACK) : '',
    ...appInfo,
    extra: scrubExtra(extra),
    sent: false,
  };
  try {
    rotate();
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* a crash while logging a crash is not worth a second crash */ }
  return rec;
}

// Small, best-effort scrub of a plain context object. Reuses audit.js's deeper
// scrubber when it is loadable, and falls back to string redaction otherwise —
// crash.js must never fail to log because a sibling module would not require.
function scrubExtra(extra) {
  if (!extra) return undefined;
  try {
    return require('./audit').scrub(extra, null, null);
  } catch {
    try { return JSON.parse(redact(JSON.stringify(extra))); } catch { return undefined; }
  }
}

/* ── reading ─────────────────────────────────────────────────────────── */

function* lines() {
  for (const f of [file, prev]) {
    if (!f) continue;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rows = text.split('\n');
    for (let i = rows.length - 1; i >= 0; i--) {
      const line = rows[i].trim();
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* skip a half-written line */ }
    }
  }
}

function loadHandled() {
  try { return new Set(JSON.parse(fs.readFileSync(handled, 'utf8'))); } catch { return new Set(); }
}
function saveHandled(set) {
  try { fs.writeFileSync(handled, JSON.stringify([...set].slice(-200))); } catch { /* nothing to do */ }
}

// Crashes the user has not yet sent or dismissed — what a next-launch notice
// asks about. Newest first, capped: a boot loop must not surface a hundred.
function pending(limit = 20) {
  const done = loadHandled();
  const out = [];
  for (const r of lines()) {
    if (done.has(r.id)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function all(limit = 100) {
  const out = [];
  for (const r of lines()) { out.push(r); if (out.length >= limit) break; }
  return out;
}

// Mark one, several, or (with no argument) every pending crash as dealt with,
// so it stops being offered.
function markHandled(ids) {
  const set = loadHandled();
  const list = ids == null ? pending(1000).map((r) => r.id) : (Array.isArray(ids) ? ids : [ids]);
  for (const id of list) set.add(id);
  saveHandled(set);
}

/* ── the shareable report ─────────────────────────────────────────────
   Plain text a person can paste into a support email. No key, no personal
   file contents — the stack is already redacted on the way in. */

function reportText(ids) {
  const want = ids ? (Array.isArray(ids) ? ids : [ids]) : null;
  const rows = all(1000).filter((r) => !want || want.includes(r.id));
  if (!rows.length) return 'No crash reports.';
  const head = [
    `Operator crash report`,
    `Version: ${appInfo.v || '?'}  Electron: ${appInfo.electron || '?'}  ${appInfo.platform || ''} ${appInfo.arch || ''}`,
    `Generated: ${new Date().toISOString()}`,
    `Crashes: ${rows.length}`,
    ``,
  ].join('\n');
  const body = rows.map((r, i) => [
    `── ${i + 1}. ${r.kind} at ${r.t} ─────────────────`,
    r.reason,
    r.stack || '(no stack)',
    r.extra ? `context: ${JSON.stringify(r.extra)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return head + body + '\n';
}

/* ── optional upload ──────────────────────────────────────────────────
   Off unless OPERATOR_CRASH_URL is set. Even then it is the caller (a user
   action) that triggers it — this never phones home by itself. */

async function upload(ids) {
  const url = process.env.OPERATOR_CRASH_URL;
  if (!url) return { ok: false, error: 'No crash endpoint configured.' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: reportText(ids),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    markHandled(ids);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ── setup ────────────────────────────────────────────────────────────
   Installs the process-level nets and, where Electron is present, its native
   crash collector for the renderer/GPU crashes JavaScript cannot see. */

function init(userDataDir, opts = {}) {
  dir = path.join(userDataDir, 'crashes');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fall through; writes will just fail quietly */ }
  file = path.join(dir, 'crashes.jsonl');
  prev = path.join(dir, 'crashes.1.jsonl');
  handled = path.join(dir, 'crashes-handled.json');
  onFatalCb = typeof opts.onFatal === 'function' ? opts.onFatal : null;

  let electron = null;
  try { electron = require('electron'); } catch { /* running under node --check or a test */ }
  appInfo = {
    v: (electron && electron.app && electron.app.getVersion && electron.app.getVersion()) || process.env.npm_package_version || '',
    electron: process.versions.electron || '',
    platform: process.platform,
    arch: process.arch,
  };

  // Electron's own collector catches native (C++) crashes in the renderer and
  // GPU processes — the ones no JS handler ever sees. Kept local: uploadToServer
  // is false unless a collector URL is set, and the minidumps sit in the app's
  // crashDumps folder for a bug report to attach later.
  try {
    if (electron && electron.crashReporter) {
      electron.crashReporter.start({
        submitURL: process.env.OPERATOR_CRASH_URL || '',
        uploadToServer: Boolean(process.env.OPERATOR_CRASH_URL),
        compress: true,
      });
    }
  } catch { /* a crash reporter that will not start is not a reason to fail launch */ }

  // The JavaScript safety nets. A rejected promise nobody caught is logged and
  // left — the app usually carries on fine. An uncaught exception in the main
  // process means state may now be inconsistent, so it is logged and handed to
  // onFatal, which decides whether to warn and quit.
  process.on('unhandledRejection', (reason) => {
    try { record('unhandledRejection', reason); } catch { /* never re-throw from here */ }
  });
  process.on('uncaughtException', (err) => {
    let rec = null;
    try { rec = record('uncaughtException', err); } catch { /* as above */ }
    try { if (onFatalCb) onFatalCb(rec, err); } catch { /* the handler itself must not loop us */ }
  });

  return file;
}

module.exports = {
  init, record, pending, all, markHandled, reportText, upload,
  dir: () => dir, filePath: () => file,
};
