// audit.js — an append-only record of every action the agent takes.
//
// The point is to answer "what did it actually do?" long after the chat that did
// it is gone, so this is deliberately dumb: one JSON object per line, written as
// it happens, never rewritten. Queries read the file back instead of keeping an
// index in memory — an audit trail is written thousands of times more often than
// it is read, so the cheap side should be the writing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let file = null;
let prev = null;          // the one rotated generation we still search
let lastError = null;     // surfaced in the UI; see write()

const MAX_BYTES = 20 * 1024 * 1024;

function init(userDataDir) {
  file = path.join(userDataDir, 'audit.jsonl');
  prev = path.join(userDataDir, 'audit.1.jsonl');
  return file;
}

// --- redaction -------------------------------------------------------------
// Written once and used on everything that goes to disk. A log that leaks the
// credentials the agent typed is worse than no log at all.

// Keys whose value never belongs on disk, whatever it turns out to hold.
const SECRET_KEY = /pass|pwd|secret|token|api[-_ ]?key|auth|bearer|otp|mfa|2fa|cvv|cvc|\bpin\b|card|account[-_ ]?number|ssn|private[-_ ]?key|\bcode\b|verification/i;

// Values that look like a credential even under an innocent key name.
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/,                        // OpenAI-style keys
  /\bnvapi-[A-Za-z0-9_-]{16,}/,                     // NVIDIA NIM
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,   // JWT
  /\b(?:\d[ -]?){13,19}\b/,                         // card number
];

const MAX_STR = 400;      // enough to know what happened, short of storing the content itself

// A field can be named a secret by a *sibling* key rather than its own: the
// browser tools pass {target: 'Password', text: '...'}, so the value arrives
// under an innocent name. Miss this and the commonest action there is — filling
// in a login — writes the password straight to disk.
const DESCRIBES = /^(target|label|name|field|placeholder|title|selector|for|aria-?label|id)$/i;
const PAYLOAD = /^(text|value|val|input|content|data)$/i;

// Keep proof that something was there — its length and a short fingerprint — so
// a record still reconciles against a real credential without carrying one.
function mask(v) {
  const str = String(v);
  const h = crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
  return `[redacted ${str.length} chars sha256:${h}]`;
}

// `found` collects every original value that was masked, so the human-readable
// summary of the same step can be cleaned with what the arguments already know.
function scrub(value, key, found) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, found));

  if (typeof value === 'object') {
    // Does this object describe a secret field? If so its payload is a secret
    // whatever the payload key happens to be called.
    const secretField = Object.entries(value).some(
      ([k, v]) => DESCRIBES.test(k) && typeof v === 'string' && SECRET_KEY.test(v));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = secretField && PAYLOAD.test(k) && typeof v === 'string'
        ? (found && found.push(v), mask(v))
        : scrub(v, k, found);
    }
    return out;
  }

  if (typeof value !== 'string') return value;
  if (key && SECRET_KEY.test(key)) { if (found) found.push(value); return mask(value); }
  for (const re of SECRET_VALUE) {
    if (re.test(value)) { if (found) found.push(value); return mask(value); }
  }
  return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}… (${value.length} chars)` : value;
}

// The one-line summary is built for the transcript, where showing the typed
// value is the point. On disk it is not, so anything the arguments masked comes
// out of the summary too.
function scrubText(text, found) {
  if (!text) return text;
  let out = String(text);
  for (const secret of found) {
    if (secret && secret.length >= 3) out = out.split(secret).join('[redacted]');
  }
  return scrub(out, null, null);
}

// Known limit: screen_type carries only {text} — no label, no field, nothing to
// say whether those keystrokes were a search term or a password. Shape-matching
// catches tokens and card numbers; an ordinary password typed blind into the
// desktop is indistinguishable from any other text. Naming a field as a secret
// is what the policy engine is for.

// --- writing ---------------------------------------------------------------

function rotate() {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }   // nothing written yet
  if (size < MAX_BYTES) return;
  try {
    fs.rmSync(prev, { force: true });
    fs.renameSync(file, prev);
  } catch { /* keep appending to the big one rather than losing the write */ }
}

function write(entry) {
  if (!file) return;
  const found = [];
  const args = scrub(entry.args || {}, null, found);
  const rec = {
    t: new Date().toISOString(),
    ...entry,
    args,
    text: scrubText(entry.text, found),
    error: entry.error ? scrubText(String(entry.error), found) : null,
  };
  try {
    rotate();
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    lastError = null;
  } catch (err) {
    // A failed write must not take the task down with it, but it must not pass
    // silently either — a trail with holes in it is a trail you cannot trust.
    lastError = String((err && err.message) || err);
  }
}

// --- reading ---------------------------------------------------------------

// Newest first: the current file backwards, then the rotated one backwards.
function* lines() {
  for (const f of [file, prev]) {
    if (!f) continue;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rows = text.split('\n');
    for (let i = rows.length - 1; i >= 0; i--) {
      const line = rows[i].trim();
      if (!line) continue;
      // A half-written last line is not a reason to lose the rest of the file.
      try { yield JSON.parse(line); } catch { /* skip */ }
    }
  }
}

function query({ botId, tool, outcome, from, to, q, limit = 200, offset = 0 } = {}) {
  const needle = String(q || '').toLowerCase();
  const rows = [];
  let total = 0;
  for (const r of lines()) {
    if (botId && r.botId !== botId) continue;
    if (tool && r.tool !== tool) continue;
    if (outcome === 'ok' && (!r.ok || r.dryRun)) continue;
    if (outcome === 'error' && r.ok !== false) continue;
    if (outcome === 'dry' && !r.dryRun) continue;
    if (from && r.t < from) continue;
    if (to && r.t > to) continue;
    if (needle && !JSON.stringify(r).toLowerCase().includes(needle)) continue;
    total++;
    if (total > offset && rows.length < limit) rows.push(r);
  }
  return { rows, total, lastError };
}

// What the filter dropdowns should offer — only what the log actually contains,
// so a tool that has never run does not clutter the list.
function facets() {
  const tools = new Set();
  const bots = new Map();
  let count = 0;
  for (const r of lines()) {
    count++;
    if (r.tool) tools.add(r.tool);
    if (r.botId && !bots.has(r.botId)) bots.set(r.botId, r.botName || r.botId);
  }
  return {
    tools: [...tools].sort(),
    bots: [...bots].map(([id, name]) => ({ id, name })),
    count,
    file,
    lastError,
  };
}

// --- export ----------------------------------------------------------------

const CSV_COLS = ['t', 'botName', 'tool', 'text', 'ok', 'error', 'ms', 'computer', 'model', 'dryRun', 'chatId', 'taskId', 'args'];

function toCSV(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? ''
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => cell(r[c])).join(','))].join('\r\n');
}

function toJSONL(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

module.exports = { init, write, scrub, query, facets, toCSV, toJSONL, filePath: () => file };
