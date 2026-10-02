// watchers.js — work that starts when something happens, not at a time.
//
// Routines run on a clock. Real office work does not: it starts when the
// invoice lands, when the supplier emails, when the scan appears in the
// folder. A watcher waits for one of those and then runs a playbook, or gives
// an agent a job, with what it saw (the file, the email) handed in.
//
// Two kinds to start with — a file appearing in a folder, and an email
// arriving — because those are where office work starts.
//
// Everything here is built not to run away with the machine: a file is only
// taken once it has finished copying, each watcher has a gap it waits between
// runs and a most-per-hour, one that fails three times in a row switches
// itself off and says so, and nothing that was seen is dropped quietly — what
// is waiting is kept on disk and run when the computer is free.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let file = null;
let state = { watchers: [], queue: [] };
let hooks = null;   // { fire(w, detail), isBusy(), email(), notify(title, text), changed() }
let draining = false;

const sizes = new Map();          // watcher id → Map(file name → size last seen): copies still landing
const MAX_QUEUE = 50;
const KNOWN_CAP = 5000;
const FOLDER_EVERY = 5000;
const EMAIL_EVERY = 2 * 60 * 1000;
const FAILS_TO_STOP = 3;

// Half-written files: Office's lock files, browser downloads in progress,
// copy temporaries. A watcher that fired on these would fire twice.
const SKIP = /^~\$|^\.|\.(tmp|temp|crdownload|part|partial|download|!ut|lock|lck)$/i;

const wid = () => 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

function init(userDataDir, h) {
  file = path.join(userDataDir, 'watchers.json');
  hooks = h;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  if (!Array.isArray(state.watchers)) state.watchers = [];
  if (!Array.isArray(state.queue)) state.queue = [];
}

function save() {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch (err) { console.error('could not save watchers:', err.message); }
}

const find = (id) => state.watchers.find((w) => w.id === id) || null;
const changed = () => { if (hooks && hooks.changed) hooks.changed(); };

/* ── what each one is waiting for ──────────────────────────────── */

function globRe(pattern) {
  const parts = String(pattern || '*').split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  const one = (p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^(?:${(parts.length ? parts : ['*']).map(one).join('|')})$`, 'i');
}

function nameFor(w) {
  if (w.kind === 'folder') {
    const what = !w.folder.pattern || w.folder.pattern === '*' ? 'a file' : w.folder.pattern;
    return `When ${what} lands in ${path.basename(w.folder.path) || w.folder.path}`;
  }
  const bits = [w.email.from && `from ${w.email.from}`, w.email.subject && `about "${w.email.subject}"`].filter(Boolean);
  return `When an email arrives${bits.length ? ' ' + bits.join(' ') : ''}`;
}

function clean(spec, old = {}) {
  const kind = spec.kind === 'email' ? 'email' : spec.kind === 'folder' ? 'folder' : old.kind;
  const out = {
    kind,
    folder: { path: String((spec.folder && spec.folder.path) ?? (old.folder && old.folder.path) ?? '').trim(),
              pattern: String((spec.folder && spec.folder.pattern) ?? (old.folder && old.folder.pattern) ?? '*').trim() || '*' },
    email: { from: String((spec.email && spec.email.from) ?? (old.email && old.email.from) ?? '').trim().slice(0, 120),
             subject: String((spec.email && spec.email.subject) ?? (old.email && old.email.subject) ?? '').trim().slice(0, 120) },
    action: spec.action || old.action || null,
    cooldown: Math.max(0, Math.min(86400, Number(spec.cooldown ?? old.cooldown ?? 30) || 0)),
    perHour: Math.max(1, Math.min(120, Number(spec.perHour ?? old.perHour ?? 12) || 12)),
  };
  if (kind === 'folder') {
    if (!out.folder.path) return { error: 'Choose the folder to watch.' };
    let st = null;
    try { st = fs.statSync(out.folder.path); } catch { /* checked below */ }
    if (!st || !st.isDirectory()) return { error: `There is no folder at ${out.folder.path}.` };
  }
  const a = out.action;
  if (!a || (a.kind !== 'playbook' && a.kind !== 'task')) return { error: 'Choose what it should do.' };
  if (a.kind === 'playbook' && !a.playbookId) return { error: 'Choose the playbook to run.' };
  if (a.kind === 'task' && !String(a.prompt || '').trim()) return { error: 'Say what the agent should do.' };
  out.action = a.kind === 'playbook'
    ? { kind: 'playbook', playbookId: String(a.playbookId) }
    : { kind: 'task', botId: a.botId || null, prompt: String(a.prompt).trim().slice(0, 2000) };
  return { value: out };
}

/* ── managing them ─────────────────────────────────────────────── */

function create(spec = {}) {
  const c = clean(spec);
  if (c.error) return { ok: false, error: c.error };
  const w = {
    id: wid(), enabled: true, createdAt: Date.now(), ...c.value,
    name: String(spec.name || '').trim().slice(0, 80) || null,
    fired: 0, firedTimes: [], errors: 0, lastFired: null, lastError: null, lastResult: null,
    known: null, lastUid: null, lastScan: 0,
  };
  if (!w.name) w.name = nameFor(w);
  // What is already there when it is made is not news: only what arrives after.
  if (w.kind === 'folder') w.known = listFolder(w).names || [];
  state.watchers.unshift(w);
  save();
  if (w.kind === 'email') scanEmail(w).catch(() => {});   // the starting point, now rather than in two minutes
  changed();
  return { ok: true, watcher: view(w) };
}

function update(id, spec = {}) {
  const w = find(id);
  if (!w) return { ok: false, error: 'That watcher has gone.' };
  if ('enabled' in spec && Object.keys(spec).length === 1) {
    w.enabled = Boolean(spec.enabled);
    // Switching one back on is a fresh start, not three strikes and out again.
    if (w.enabled) { w.errors = 0; w.lastError = null; }
    else state.queue = state.queue.filter((q) => q.watcherId !== id);
    save(); changed();
    return { ok: true, watcher: view(w) };
  }
  const c = clean(spec, w);
  if (c.error) return { ok: false, error: c.error };
  const moved = c.value.kind !== w.kind || c.value.folder.path !== w.folder.path || c.value.folder.pattern !== w.folder.pattern;
  const autoName = w.name === nameFor(w);
  Object.assign(w, c.value);
  if (typeof spec.name === 'string' && spec.name.trim()) w.name = spec.name.trim().slice(0, 80);
  else if (autoName) w.name = nameFor(w);
  if (moved && w.kind === 'folder') { w.known = listFolder(w).names || []; sizes.delete(w.id); }
  if (c.value.kind === 'email' && w.lastUid === undefined) w.lastUid = null;
  save(); changed();
  return { ok: true, watcher: view(w) };
}

function remove(id) {
  state.watchers = state.watchers.filter((w) => w.id !== id);
  state.queue = state.queue.filter((q) => q.watcherId !== id);
  sizes.delete(id);
  save(); changed();
  return { ok: true };
}

// A playbook that has gone takes its watchers with it, rather than leaving
// them to fail three times first.
function forgetPlaybook(playbookId) {
  const gone = state.watchers.filter((w) => w.action && w.action.kind === 'playbook' && w.action.playbookId === playbookId);
  for (const w of gone) remove(w.id);
}

const view = (w) => ({
  id: w.id, name: w.name, enabled: w.enabled, kind: w.kind, folder: w.folder, email: w.email, action: w.action,
  cooldown: w.cooldown, perHour: w.perHour, fired: w.fired, lastFired: w.lastFired,
  errors: w.errors, lastError: w.lastError, lastResult: w.lastResult,
  waiting: state.queue.filter((q) => q.watcherId === w.id).length,
});

const list = () => state.watchers.map(view);

/* ── looking ───────────────────────────────────────────────────── */

function listFolder(w) {
  let entries;
  try { entries = fs.readdirSync(w.folder.path, { withFileTypes: true }); }
  catch (err) { return { error: `cannot read ${w.folder.path} (${err.code || err.message})` }; }
  const re = globRe(w.folder.pattern);
  return { names: entries.filter((e) => e.isFile() && !SKIP.test(e.name) && re.test(e.name)).map((e) => e.name) };
}

function problem(w, why) {
  if (w.lastError === why) return;
  w.lastError = why;
  save(); changed();
}

// New is "not here last time". Kept by name, not by date: a file copied or
// moved in keeps its old dates, and would be missed by anything that looks at
// when it was made.
function scanFolder(w) {
  const got = listFolder(w);
  if (got.error) return problem(w, got.error);
  if (w.lastError && /^cannot read/.test(w.lastError)) { w.lastError = null; changed(); }
  const here = new Set(got.names);
  const known = new Set(w.known || []);
  const landing = sizes.get(w.id) || new Map();
  const ready = [];
  for (const n of got.names) {
    if (known.has(n)) continue;
    let size = -1;
    try { size = fs.statSync(path.join(w.folder.path, n)).size; } catch { continue; }
    // Only once it has stopped growing: a copy or a download still landing is
    // not the file yet.
    if (size > 0 && landing.get(n) === size) { ready.push(n); landing.delete(n); }
    else landing.set(n, size);
  }
  for (const n of [...landing.keys()]) if (!here.has(n)) landing.delete(n);
  sizes.set(w.id, landing);

  const kept = (w.known || []).filter((n) => here.has(n));
  const next = [...kept, ...ready].slice(-KNOWN_CAP);
  const gone = kept.length !== (w.known || []).length;
  w.known = next;
  for (const n of ready) enqueue(w, { file: path.join(w.folder.path, n), file_name: n, folder: w.folder.path });
  if (ready.length || gone) save();
}

const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
const mailMatches = (w, m) => (has(m.from, w.email.from) || has(m.fromAddress, w.email.from)) && has(m.subject, w.email.subject);

async function scanEmail(w) {
  const api = hooks && hooks.email();
  if (!api) return problem(w, 'no email account is connected — connect one in Settings → Connectors');
  let rows;
  try { rows = await api.list({ limit: 25, tab: 'all' }); }
  catch (err) { return problem(w, `could not read the inbox (${String(err.message || err).slice(0, 120)})`); }
  if (w.lastError && /inbox|email account/.test(w.lastError)) { w.lastError = null; changed(); }
  const top = rows.reduce((m, r) => Math.max(m, Number(r.uid) || 0), 0);
  // The first look only sets where "new" starts.
  if (w.lastUid === null || w.lastUid === undefined) { w.lastUid = top; save(); return; }
  const fresh = rows.filter((r) => Number(r.uid) > w.lastUid).sort((a, b) => a.uid - b.uid);
  for (const m of fresh) {
    if (mailMatches(w, m)) enqueue(w, { email_uid: String(m.uid), email_from: m.fromAddress || m.from, email_subject: m.subject });
  }
  if (top > w.lastUid) { w.lastUid = top; save(); }
}

/* ── the queue ─────────────────────────────────────────────────── */

function enqueue(w, detail) {
  if (state.queue.length >= MAX_QUEUE) {
    // Never dropped quietly: say it is full, and leave the rest for the next look.
    problem(w, `${MAX_QUEUE} jobs are already waiting — nothing more is taken until those have run`);
    return false;
  }
  state.queue.push({ id: wid(), watcherId: w.id, detail, at: Date.now() });
  save(); changed();
  return true;
}

function eligible(w, now) {
  if (!w || !w.enabled) return false;
  if (w.lastFired && now - w.lastFired < w.cooldown * 1000) return false;
  return (w.firedTimes || []).filter((t) => now - t < 3600e3).length < w.perHour;
}

async function drain() {
  if (draining || !hooks || hooks.isBusy()) return;
  const now = Date.now();
  // Jobs for a watcher that has been switched off or deleted go with it.
  state.queue = state.queue.filter((q) => { const w = find(q.watcherId); return w && w.enabled; });
  const i = state.queue.findIndex((q) => eligible(find(q.watcherId), now));
  if (i === -1) return;

  draining = true;
  const job = state.queue.splice(i, 1)[0];
  const w = find(job.watcherId);
  w.lastFired = now;
  w.firedTimes = [...(w.firedTimes || []).filter((t) => now - t < 3600e3), now];
  w.fired = (w.fired || 0) + 1;
  save(); changed();

  let r;
  try { r = await hooks.fire(w, job.detail); } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
  r = r || { ok: false, error: 'no result' };

  // Something else took the computer first: it waits its turn again.
  if (r.busy) {
    state.queue.unshift(job);
    w.fired -= 1;
    w.firedTimes.pop();
    w.lastFired = null;
  } else {
    w.lastResult = { at: Date.now(), ok: Boolean(r.ok), error: r.ok ? null : (r.error || 'it did not finish'), what: job.detail.file_name || job.detail.email_subject || '' };
    if (r.ok) { w.errors = 0; w.lastError = null; }
    else if (!r.stopped) {
      w.errors = (w.errors || 0) + 1;
      w.lastError = w.lastResult.error;
      if (w.errors >= FAILS_TO_STOP) {
        w.enabled = false;
        state.queue = state.queue.filter((q) => q.watcherId !== w.id);
        if (hooks.notify) hooks.notify(`Watcher switched off: ${w.name}`, `It failed ${FAILS_TO_STOP} times in a row. The last time: ${w.lastError}`);
      }
    }
  }
  draining = false;
  save(); changed();
}

// Called every few seconds by main.js.
async function tick() {
  const now = Date.now();
  for (const w of state.watchers) {
    if (!w.enabled) continue;
    const every = w.kind === 'email' ? EMAIL_EVERY : FOLDER_EVERY;
    if (now - (w.lastScan || 0) < every) continue;
    w.lastScan = now;
    try {
      if (w.kind === 'folder') scanFolder(w);
      else await scanEmail(w);
    } catch (err) { problem(w, String((err && err.message) || err)); }
  }
  await drain();
}

// "Try it": run it now on the newest thing it would have fired on.
async function test(id) {
  const w = find(id);
  if (!w) return { ok: false, error: 'That watcher has gone.' };
  let detail = null;
  if (w.kind === 'folder') {
    const got = listFolder(w);
    if (got.error) return { ok: false, error: got.error };
    const newest = got.names
      .map((n) => { try { return { n, t: fs.statSync(path.join(w.folder.path, n)).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.t - a.t)[0];
    if (!newest) return { ok: false, error: 'There is nothing in that folder it would pick up yet.' };
    detail = { file: path.join(w.folder.path, newest.n), file_name: newest.n, folder: w.folder.path };
  } else {
    const api = hooks.email();
    if (!api) return { ok: false, error: 'No email account is connected.' };
    const rows = await api.list({ limit: 25, tab: 'all' });
    const m = rows.find((x) => mailMatches(w, x));
    if (!m) return { ok: false, error: 'None of the latest 25 emails match it.' };
    detail = { email_uid: String(m.uid), email_from: m.fromAddress || m.from, email_subject: m.subject };
  }
  // A test goes to the front and does not wait out the gap between runs.
  state.queue.unshift({ id: wid(), watcherId: w.id, detail, at: Date.now() });
  const keep = w.lastFired;
  w.lastFired = null;
  save(); changed();
  drain().catch(() => {});
  if (keep && !w.lastFired) w.lastFired = keep;
  return { ok: true, what: detail.file_name || detail.email_subject };
}

// What a job given to an agent is told about what set it off. {{file}} and the
// rest work in its words; if none are used, the details go on the end.
function fillPrompt(prompt, detail) {
  let used = false;
  const out = String(prompt).replace(/\{\{\s*(file|file_name|folder|email_from|email_subject|email_uid)\s*\}\}/gi, (_m, k) => {
    used = true;
    return detail[k.toLowerCase()] ?? '';
  });
  if (used) return out;
  const what = detail.file ? `a new file arrived: ${detail.file}`
    : detail.email_uid ? `a new email arrived — from ${detail.email_from}, subject "${detail.email_subject}" (#${detail.email_uid} in the inbox)` : '';
  return what ? `${out}\n\n(What set this off: ${what}.)` : out;
}

module.exports = { init, list, create, update, remove, forgetPlaybook, tick, test, fillPrompt, globRe };
