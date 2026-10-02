// playbooks.js — a finished run, compiled into steps that replay with no model.
//
// The first time Operator does a job, a model works out every click. The
// second time there is nothing left to work out: the same buttons, the same
// pages, the same order. So a run that worked can be saved as a playbook — the
// steps it actually took, each with a cheap check of where it should leave the
// screen — and replayed through the agent's own tools with no model attached.
// It costs nothing, takes seconds, and does the job the same way every time.
//
// When the world has moved (a button renamed, a page redesigned), the step
// that no longer lands is handed to a model on its own, with the goal and what
// went wrong. Whatever the model does to get past it replaces that step, and
// the run after that is free again. The repair is the feature; the recording
// is only how it starts.
//
// What it is not: a way to repeat judgement. A playbook does the same thing
// each time. A job that reads an email and decides what to say back is an
// agent's job, unless the parts that change are made into inputs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

let file = null;        // playbooks.json — the saved playbooks
let runsFile = null;    // recent-runs.json — finished runs that could become one
let books = [];
let recent = [];
const live = new Map(); // taskId → a run being recorded, in memory only

const MAX_RECENT = 25;
const MAX_STEPS = 300;

const sid = () => 's' + crypto.randomBytes(4).toString('hex');
const pid = () => 'p' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(userDataDir) {
  file = path.join(userDataDir, 'playbooks.json');
  runsFile = path.join(userDataDir, 'recent-runs.json');
  try { books = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { books = []; }
  try { recent = JSON.parse(fs.readFileSync(runsFile, 'utf8')); } catch { recent = []; }
  if (!Array.isArray(books)) books = [];
  if (!Array.isArray(recent)) recent = [];
}

function flush() {
  try { fs.writeFileSync(file, JSON.stringify(books)); } catch (err) { console.error('could not save playbooks:', err.message); }
}
function flushRecent() {
  try { fs.writeFileSync(runsFile, JSON.stringify(recent)); } catch { /* losing the list of recent runs costs nothing that matters */ }
}

/* ── what can be done again ─────────────────────────────────────────
 * Acting, not looking. A replay does not need to screenshot or read a page to
 * decide what to do next: that was decided the first time. Remembering,
 * scheduling and messaging other agents are about the conversation, not the
 * job, so they are left out too. */

const REPLAY = new Set([
  'screen_do', 'screen_click', 'screen_move', 'screen_drag', 'screen_scroll', 'screen_type', 'screen_key',
  'screen_click_text', 'focus_window', 'maximize_window', 'launch_app', 'run_command', 'wait',
  'use_my_screen', 'use_own_screen',
  'browser_navigate', 'browser_click_text', 'browser_type_into', 'browser_fill_form', 'browser_select',
  'browser_press_key', 'browser_scroll', 'browser_click_xy', 'browser_wait_for',
  'wait_for_user', 'get_verification_code', 'email_send',
]);

// The same promise the rest of the app makes: anything that spends, sends,
// publishes or deletes stops and asks — a playbook included. Each step can be
// switched to just do it, by the user, in the editor.
const RISKY = /\b(pay|buy|purchase|place order|checkout|transfer|delete|remove|publish|post|send)\b/i;

const isBrowser = (tool) => tool.startsWith('browser_');

function isRisky(tool, args, text) {
  if (tool === 'email_send') return true;
  if (tool === 'run_command' || tool === 'wait_for_user' || tool === 'get_verification_code') return false;
  return RISKY.test([text, args && args.text, args && args.target, args && args.name].filter(Boolean).join(' '));
}

// Clicking a place on the screen, rather than a thing with a name. It works
// while the window is where it was, and nowhere else — so it is shown as such.
function isBrittle(tool, args) {
  if (['screen_click', 'screen_drag', 'screen_move', 'screen_scroll', 'browser_click_xy'].includes(tool)) return true;
  if (tool === 'screen_do') {
    return (args.steps || []).some((s) => ['click', 'double_click', 'right_click', 'move', 'scroll'].includes(s.action));
  }
  return false;
}

/* ── secrets never go in ────────────────────────────────────────────
 * Masked by the same rules the audit log uses. A password typed while the run
 * was recorded becomes a {{secret:…}} the user types themselves on a replay —
 * it is never written into a playbook or into the list of recent runs. */

function labelFor(holder, key) {
  const h = holder && !Array.isArray(holder) ? holder : {};
  return String(h.target || h.label || h.field || h.name || key || 'value').replace(/[{}:]/g, '').slice(0, 40);
}

function sanitize(input) {
  const masked = audit.scrub(input, null, []);
  const walk = (orig, m, key, holder) => {
    if (typeof orig === 'string') {
      // A code fetched during the run is not a secret: it is fetched again.
      if (orig.includes('{{code}}')) return orig;
      if (typeof m === 'string' && m.startsWith('[redacted ')) return `{{secret:${labelFor(holder, key)}}}`;
      return orig;   // the whole value, where the audit log would cut it short
    }
    if (Array.isArray(orig)) return orig.map((v, i) => walk(v, Array.isArray(m) ? m[i] : undefined, key, orig));
    if (orig && typeof orig === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(orig)) out[k] = walk(v, m && typeof m === 'object' ? m[k] : undefined, k, orig);
      return out;
    }
    return orig;
  };
  return walk(input, masked, null, null);
}

// Every string in a step's arguments, changed by `fn`.
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function strings(value, out = []) {
  mapStrings(value, (s) => { out.push(s); return s; });
  return out;
}

/* ── recording ──────────────────────────────────────────────────────
 * main.js hands every finished step of every run here as it happens. Most
 * runs are never saved; the last few are kept so that one can be. */

function startRun(taskId, meta) {
  live.set(taskId, { ...meta, at: Date.now(), steps: [], codes: [], usedHelpers: false });
}

function recordStep(taskId, evt) {
  const r = live.get(taskId);
  if (!r) return;
  if (evt.helper) { r.usedHelpers = true; return; }
  if (evt.dryRun) return;
  if (r.steps.length >= MAX_STEPS) { r.truncated = true; return; }
  // A code the run fetched, typed in a later step, is linked back to the
  // fetch rather than kept: on a replay it is a different code.
  let input = clone(evt.input || {});
  for (const c of r.codes) input = mapStrings(input, (s) => s.split(c).join('{{code}}'));
  if (evt.after && evt.after.code && String(evt.after.code).length >= 4) r.codes.push(String(evt.after.code));
  r.steps.push({
    name: evt.name,
    input: sanitize(input),
    text: evt.text ? mapStrings(evt.text, (s) => r.codes.reduce((t, c) => t.split(c).join('{code}'), s)) : evt.name,
    ok: evt.ok !== false,
    after: evt.after ? { url: evt.after.url, window: evt.after.window } : undefined,
  });
}

const replayable = (steps) => steps.filter((s) => REPLAY.has(s.name) && s.ok !== false);

// The run is over. Keep it if there is anything in it a playbook could repeat.
function endRun(taskId, { ok } = {}) {
  const r = live.get(taskId);
  if (!r) return null;
  live.delete(taskId);
  const n = replayable(r.steps).length;
  if (!n || r.dryRun) return null;
  const keep = {
    taskId, prompt: r.prompt, botId: r.botId || null, botName: r.botName || null,
    model: r.model || null, machine: r.machine || null, at: r.at, ok: ok !== false,
    usedHelpers: r.usedHelpers, truncated: Boolean(r.truncated), steps: r.steps,
  };
  recent = [keep, ...recent.filter((x) => x.taskId !== taskId)].slice(0, MAX_RECENT);
  flushRecent();
  return { taskId, steps: n, usedHelpers: r.usedHelpers };
}

// A recording that is never kept — a repair's steps, taken straight into the
// playbook it was repairing.
function takeRun(taskId) {
  const r = live.get(taskId);
  live.delete(taskId);
  return r ? r.steps : [];
}

function listRecent() {
  return recent.map((r) => ({
    taskId: r.taskId, prompt: r.prompt, botName: r.botName, at: r.at, ok: r.ok,
    steps: replayable(r.steps).length, usedHelpers: r.usedHelpers,
    saved: books.some((b) => b.source && b.source.taskId === r.taskId),
  }));
}

/* ── dates ──────────────────────────────────────────────────────────
 * "Download yesterday's invoices" types a different date every day. A date
 * typed during the recording that was the day it was recorded, or the day
 * before, is saved as {{today:…}} / {{yesterday:…}} in the format it was typed
 * in, so a replay types the right one. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

function formatDate(d, fmt) {
  return String(fmt || 'YYYY-MM-DD').replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D/g, (t) => ({
    YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
    dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), DD: pad(d.getDate()), D: d.getDate(),
  })[t]);
}

function dayFor(name, base) {
  const d = new Date(base);
  d.setHours(12, 0, 0, 0);
  if (name === 'today') return d;
  if (name === 'yesterday') { d.setDate(d.getDate() - 1); return d; }
  if (name === 'tomorrow') { d.setDate(d.getDate() + 1); return d; }
  if (name === 'last_month') { d.setDate(1); d.setMonth(d.getMonth() - 1); return d; }
  if (name === 'this_month') { d.setDate(1); return d; }
  return null;
}

const DATE_WORDS = ['today', 'yesterday', 'tomorrow', 'last_month', 'this_month'];
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'D/M/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'D MMMM YYYY', 'D MMM YYYY', 'MMMM D, YYYY', 'MMM D, YYYY', 'YYYYMMDD'];
const MONTH_FORMATS = ['MMMM YYYY', 'MMM YYYY', 'YYYY-MM'];

// Literal → token, longest literals first so "30 September 2026" is not
// half-replaced by "September 2026".
function dateTokens(at) {
  const pairs = [];
  for (const word of ['today', 'yesterday']) {
    const d = dayFor(word, at);
    for (const f of DATE_FORMATS) pairs.push([formatDate(d, f), `{{${word}:${f}}}`]);
  }
  for (const word of ['this_month', 'last_month']) {
    const d = dayFor(word, at);
    for (const f of MONTH_FORMATS) pairs.push([formatDate(d, f), `{{${word}:${f}}}`]);
  }
  // A literal two formats agree on (1/1/2026) goes to the first, which is the
  // way round this part of the world writes it.
  const seen = new Set();
  return pairs.filter(([lit]) => lit.length >= 6 && !seen.has(lit) && seen.add(lit))
    .sort((a, b) => b[0].length - a[0].length);
}

function withDates(args, at) {
  const pairs = dateTokens(at);
  return mapStrings(args, (s) => {
    let out = s;
    for (const [lit, tok] of pairs) {
      if (!out.includes(lit)) continue;
      // Only where it stands on its own, not inside a longer number.
      out = out.replace(new RegExp(`(^|[^0-9])${lit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![0-9])`, 'g'), (_m, pre) => pre + tok);
    }
    return out;
  });
}

/* ── compiling ──────────────────────────────────────────────────── */

// Where a step should leave things, so a replay can tell it went wrong without
// a model. A page is checked by its site; a window by the app's part of its
// title ("… - Excel"), which survives the file name changing.
function checkOf(s) {
  if (!s.after) return null;
  if (isBrowser(s.name)) return s.after.url && /^https?:/.test(s.after.url) ? { url: s.after.url } : null;
  if (s.name === 'run_command' || s.name === 'get_verification_code' || s.name === 'email_send' || s.name === 'wait') return null;
  return s.after.window && s.after.window !== 'unknown' ? { window: s.after.window } : null;
}

function stepFrom(s, at) {
  const args = withDates(clone(s.input), at);
  return {
    id: sid(),
    tool: s.name,
    args,
    // Said the way it will happen: "type {yesterday} into Date".
    text: String(withDates(String(s.text || s.name), at)).replace(/\{\{([a-z_]+)(?::[^}]*)?\}\}/g, '{$1}').slice(0, 300),
    check: checkOf(s),
    brittle: isBrittle(s.name, args),
    confirm: isRisky(s.name, args, s.text),
  };
}

function compileSteps(raw, at) {
  return replayable(raw).map((s) => stepFrom(s, at || Date.now()));
}

function nameFrom(prompt) {
  const line = String(prompt || '').split('\n').map((l) => l.trim()).find(Boolean) || 'New playbook';
  const t = line.replace(/^\/\S+\s*/, '').replace(/\s+/g, ' ');
  const name = t.charAt(0).toUpperCase() + t.slice(1);
  if (name.length <= 60) return name;
  // Cut at a word, not through one: "…then note" rather than "…then no".
  const cut = name.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60).replace(/[\s,;:—-]+$/, '');
}

function fromTask(taskId) {
  const r = recent.find((x) => x.taskId === taskId);
  if (!r) return { ok: false, error: 'That run is no longer in the list of recent runs, so it cannot be saved now. Run the job again, then save it.' };
  if (r.usedHelpers) return { ok: false, error: 'That run handed work to helpers in several tabs at once, and a playbook replays one step at a time. Run the job without helpers, then save it.' };
  const steps = compileSteps(r.steps, r.at);
  if (!steps.length) return { ok: false, error: 'Nothing in that run can be repeated — it only looked and answered.' };
  const pb = {
    id: pid(),
    name: nameFrom(r.prompt),
    goal: String(r.prompt || '').slice(0, 2000),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: { taskId, botId: r.botId, botName: r.botName, at: r.at },
    model: r.model || null,
    machine: r.machine || null,
    steps,
    inputs: {},
    stats: { runs: 0, ok: 0, failed: 0, heals: 0, totalMs: 0, lastRun: null, lastOk: null, lastMs: null, lastError: null },
  };
  books.unshift(pb);
  flush();
  return { ok: true, playbook: view(pb) };
}

/* ── inputs ─────────────────────────────────────────────────────────
 * {{name}} anywhere in a step is filled in when it runs: from the playbook's
 * saved inputs, from whatever started it (a watcher's file or email), or from
 * a date word. */

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\s*\}\}/g;
const TRIGGER_VARS = ['file', 'file_name', 'folder', 'email_from', 'email_subject', 'email_uid'];
const BUILT_IN = new Set([...DATE_WORDS, 'now', 'code', 'secret', ...TRIGGER_VARS]);

function tokensIn(pb) {
  const names = new Set();
  for (const s of pb.steps) for (const str of strings(s.args)) {
    for (const m of str.matchAll(TOKEN)) names.add(m[1].toLowerCase());
  }
  return names;
}

function inputsOf(pb) {
  return [...tokensIn(pb)].filter((n) => !BUILT_IN.has(n)).map((n) => ({ name: n, value: (pb.inputs || {})[n] ?? '' }));
}

function fillString(s, vars, at, missing) {
  return s.replace(TOKEN, (whole, rawName, fmt) => {
    const name = rawName.toLowerCase();
    if (name === 'secret') return whole;
    if (name === 'now') return formatDate(new Date(at), fmt || 'HH:mm').replace('HH', pad(new Date(at).getHours())).replace('mm', pad(new Date(at).getMinutes()));
    const day = dayFor(name, at);
    if (day) return formatDate(day, fmt || (name.endsWith('month') ? 'MMMM YYYY' : 'YYYY-MM-DD'));
    const v = vars[name];
    if (v === undefined || v === null || v === '') { missing.add(name); return whole; }
    // An input's own value may be a date word: "{{last_month:MMMM}}".
    return String(v).replace(TOKEN, (w, n2, f2) => {
      const d2 = dayFor(n2.toLowerCase(), at);
      return d2 ? formatDate(d2, f2 || 'YYYY-MM-DD') : w;
    });
  });
}

const secretIn = (args) => {
  for (const s of strings(args)) {
    const m = s.match(/\{\{\s*secret:([^}]*)\}\}/i);
    if (m) return m[1].trim() || 'password';
  }
  return null;
};

/* ── editing ────────────────────────────────────────────────────── */

const find = (id) => books.find((b) => b.id === id) || null;

function update(id, patch = {}) {
  const pb = find(id);
  if (!pb) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) pb.name = patch.name.trim().slice(0, 80);
  if ('machine' in patch) pb.machine = patch.machine || null;
  if ('model' in patch) pb.model = patch.model || null;
  if (patch.inputs && typeof patch.inputs === 'object') {
    pb.inputs = { ...(pb.inputs || {}) };
    for (const [k, v] of Object.entries(patch.inputs)) pb.inputs[String(k).toLowerCase()] = String(v ?? '').slice(0, 2000);
  }
  // One step: ask first, removed, or one of its values changed.
  if (patch.step && patch.step.id) {
    const i = pb.steps.findIndex((s) => s.id === patch.step.id);
    if (i !== -1) {
      const s = pb.steps[i];
      if (patch.step.remove) pb.steps.splice(i, 1);
      if ('confirm' in patch.step) s.confirm = Boolean(patch.step.confirm);
      if (typeof patch.step.path === 'string' && typeof patch.step.value === 'string') setPath(s.args, patch.step.path, patch.step.value);
    }
  }
  pb.updatedAt = Date.now();
  flush();
  return view(pb);
}

function setPath(obj, p, value) {
  const keys = p.split('.');
  let at = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (at === null || typeof at !== 'object') return;
    at = at[keys[i]];
  }
  if (at && typeof at === 'object' && typeof at[keys[keys.length - 1]] === 'string') at[keys[keys.length - 1]] = value;
}

// Every editable value in a step, with where it lives, for the editor.
function fieldsOf(args, base = '', out = []) {
  if (Array.isArray(args)) args.forEach((v, i) => fieldsOf(v, base ? `${base}.${i}` : String(i), out));
  else if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) fieldsOf(v, base ? `${base}.${k}` : k, out);
  } else if (typeof args === 'string') out.push({ path: base, value: args });
  return out;
}

// Turn a value that changes from run to run into an input: every place it was
// typed becomes {{name}}, and what it was becomes the input's starting value.
function makeInput(id, value, name) {
  const pb = find(id);
  const lit = String(value || '');
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!pb || lit.length < 2 || !key || BUILT_IN.has(key)) return null;
  for (const s of pb.steps) {
    s.args = mapStrings(s.args, (str) => str.split(lit).join(`{{${key}}}`));
    s.text = s.text.split(lit).join(`{${key}}`);
  }
  pb.inputs = { ...(pb.inputs || {}), [key]: lit };
  pb.updatedAt = Date.now();
  flush();
  return view(pb);
}

function remove(id) {
  books = books.filter((b) => b.id !== id);
  flush();
  return { ok: true };
}

/* ── what the UI sees ───────────────────────────────────────────── */

function kindOf(tool) {
  if (isBrowser(tool)) return 'web';
  if (tool === 'run_command') return 'shell';
  if (tool.startsWith('email_') || tool === 'get_verification_code') return 'mail';
  if (tool === 'wait_for_user') return 'you';
  if (tool === 'wait') return 'wait';
  return 'screen';
}

function checkLabel(c) {
  if (!c) return '';
  if (c.url) { try { return new URL(c.url).hostname.replace(/^www\./, ''); } catch { return c.url; } }
  return appPart(c.window);
}

const stepView = (s) => ({
  id: s.id, tool: s.tool, text: s.text, kind: kindOf(s.tool), brittle: s.brittle, confirm: s.confirm,
  healed: Boolean(s.healed), check: checkLabel(s.check), fields: fieldsOf(s.args),
});

function view(pb) {
  if (!pb) return null;
  return {
    id: pb.id, name: pb.name, goal: pb.goal, createdAt: pb.createdAt, updatedAt: pb.updatedAt,
    source: pb.source, model: pb.model, machine: pb.machine,
    usesBrowser: pb.steps.some((s) => isBrowser(s.tool)),
    steps: pb.steps.map(stepView),
    inputs: inputsOf(pb),
    stats: pb.stats,
  };
}

const list = () => books.map((pb) => ({
  id: pb.id, name: pb.name, steps: pb.steps.length, stats: pb.stats, machine: pb.machine,
  usesBrowser: pb.steps.some((s) => isBrowser(s.tool)),
}));
const get = (id) => view(find(id));
const raw = (id) => find(id);

/* ── replaying ──────────────────────────────────────────────────── */

const textOf = (out) => (out && Array.isArray(out.content)
  ? out.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '');

// The tools answer "that did not work" in words rather than by throwing, so
// the agent can read why. A replay has to read them the same way.
function softFailure(tool, text) {
  const t = String(text || '');
  switch (tool) {
    case 'screen_do': { const m = t.match(/then stopped — (.+)/); return m ? m[1].trim() : null; }
    case 'screen_click_text': return /^Clicked /.test(t) ? null : t.split('\n')[0] || 'that control is not there';
    case 'browser_select': return /^Set "/.test(t) ? null : t.split('\n')[0];
    case 'browser_wait_for': return /^Waited /.test(t) ? null : t.split('\n')[0];
    case 'get_verification_code': return /^Code \S+/.test(t) ? null : t.split('\n')[0] || 'no code arrived';
    case 'run_command': return /^(Failed:|Timed out after)/.test(t) ? t.split('\n')[0] : null;
    case 'launch_app': return /Microsoft Store app/.test(t) ? t.split('\n')[0] : null;
    case 'use_my_screen': return /driving another machine/.test(t) ? t.split('\n')[0] : null;
    default: return null;
  }
}

// "Invoice 42.pdf - Adobe Acrobat" → "Adobe Acrobat". A window with no app
// part in its title (Explorer names itself after the folder) is checked whole.
function appPart(title) {
  const t = String(title || '').trim();
  const parts = t.split(/\s+[-—|]\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : t;
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function matches(check, now) {
  if (!check || !now) return true;
  if (check.url) return !host(check.url) || host(check.url) === host(now.url);
  if (check.window) return String(now.window || '').toLowerCase().includes(appPart(check.window).toLowerCase());
  return true;
}

/**
 * Run a playbook. Never throws; the result says how it went.
 *
 * hands   Map of tool name → tool, from agent.hands()
 * probe   (check) → { url, window } as things are now, for the checkpoints
 * ask     ({ what, kind }) → 'yes' when the user did it or allowed it, 'skip', or 'none'
 * heal    ({ step, index, steps, reason }) → { steps, reply } from a model, or null
 * emit    progress, for the window
 */
async function run(id, { hands, inputs = {}, trigger = {}, dryRun = false, signal = null, emit = () => {}, probe = null, ask = null, heal = null }) {
  const pb = find(id);
  if (!pb) return { ok: false, error: 'That playbook has been deleted.' };
  const started = Date.now();
  const at = started;
  const vars = {};
  for (const [k, v] of Object.entries({ ...(pb.inputs || {}), ...inputs, ...trigger })) vars[String(k).toLowerCase()] = v;
  const steps = pb.steps.map(clone);
  let healed = 0;
  let skipped = 0;

  const stepsView = () => steps.map(stepView);
  emit({ type: 'pb_start', id, name: pb.name, steps: stepsView(), dryRun });

  const finish = (ok, extra = {}) => {
    const ms = Date.now() - started;
    if (!dryRun) {
      const st = pb.stats || (pb.stats = {});
      st.runs = (st.runs || 0) + 1;
      st[ok ? 'ok' : 'failed'] = (st[ok ? 'ok' : 'failed'] || 0) + 1;
      st.heals = (st.heals || 0) + healed;
      if (ok) { st.totalMs = (st.totalMs || 0) + ms; st.lastOk = Date.now(); }
      st.lastRun = Date.now();
      st.lastMs = ms;
      st.lastError = ok ? null : (extra.error || 'failed');
      // What the repairs did is the new script: the next run is free again.
      if (healed) pb.steps = steps;
      pb.updatedAt = Date.now();
      flush();
    }
    const result = { ok, ms, healed, skipped, steps: steps.length, dryRun, ...extra };
    emit({ type: 'pb_end', id, ...result });
    return result;
  };

  // Settle onto the checkpoint: a replay runs as fast as the machine allows,
  // which is faster than a page loads or a window opens. Waiting for the place
  // a step should leave things is what keeps the next step from missing.
  const settle = async (check) => {
    if (dryRun || !check || !probe) return true;
    const until = Date.now() + 8000;
    for (;;) {
      const now = await probe(check).catch(() => null);
      if (matches(check, now)) return true;
      if (Date.now() > until || (signal && signal.aborted)) return false;
      await sleep(400);
    }
  };

  const exec = async (step, args) => {
    const t = hands.get(step.tool);
    if (!t) {
      return { ok: false, hard: true, error: isBrowser(step.tool)
        ? "this step uses Operator's own browser, which only runs on the computer Operator is open on"
        : step.tool === 'email_send' || step.tool === 'get_verification_code'
          ? 'this step needs an email account — connect one in Settings → Connectors'
          : `there is no ${step.tool} tool here` };
    }
    try {
      const out = await t.handler(args, { signal });
      const text = textOf(out);
      if (out && out.isError) return { ok: false, error: text || 'it failed' };
      // A rehearsed step answers "this did NOT happen", which is the point.
      if (dryRun) return { ok: true, text };
      const soft = softFailure(step.tool, text);
      if (soft) return { ok: false, error: soft };
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).split('\n')[0].slice(0, 300) };
    }
  };

  for (let i = 0; i < steps.length; i++) {
    if (signal && signal.aborted) return finish(false, { stopped: true, error: 'Stopped.' });
    const step = steps[i];
    emit({ type: 'pb_step', i, state: 'running' });

    // A password or other secret is never stored, so the user types it.
    const secret = secretIn(step.args);
    if (secret) {
      if (dryRun || !ask) { skipped++; emit({ type: 'pb_step', i, state: 'skipped', note: `you would type the ${secret}` }); continue; }
      const did = await ask({ what: `Type the ${secret} yourself — Operator does not keep passwords in a playbook. Press "I've done it" when it is in.`, kind: 'secret', browser: isBrowser(step.tool) });
      if (signal && signal.aborted) return finish(false, { stopped: true, error: 'Stopped.' });
      if (did !== 'yes') return finish(false, { failedAt: i, error: `The ${secret} was not typed in, so the run stopped at step ${i + 1}.` });
      emit({ type: 'pb_step', i, state: 'ok', note: 'you did this one' });
      continue;
    }

    // Anything that spends, sends, publishes or deletes asks first. Skip leaves
    // that one step out; no answer at all stops the run — an unattended run
    // fails closed rather than guessing.
    if (step.confirm && !dryRun && ask) {
      const go = await ask({ what: `Allow this step? ${step.text}. Press "I've done it" to let it go ahead, or Skip to leave it out.`, kind: 'confirm' });
      if (signal && signal.aborted) return finish(false, { stopped: true, error: 'Stopped.' });
      if (go === 'skip') { skipped++; emit({ type: 'pb_step', i, state: 'skipped', note: 'you said no' }); continue; }
      if (go !== 'yes') return finish(false, { failedAt: i, error: `Nobody allowed step ${i + 1} (${step.text}), so the run stopped there.` });
    }

    // A rehearsal does not sit waiting for a code that nothing has sent.
    if (dryRun && step.tool === 'get_verification_code') {
      vars.code = '(the code)';
      emit({ type: 'pb_step', i, state: 'ok', note: 'would wait for the code here' });
      continue;
    }

    const missing = new Set();
    const args = mapStrings(step.args, (s) => fillString(s, vars, at, missing));
    if (missing.size) {
      return finish(false, { failedAt: i, error: `Step ${i + 1} needs ${[...missing].map((m) => `{{${m}}}`).join(', ')}, and nothing gave a value for it. Set it under Inputs.` });
    }

    let res = await exec(step, args);
    let landed = res.ok && await settle(step.check);
    // Most misses on a replay are the world being slower than the recording:
    // one more go, a beat later, before anything is called broken.
    if (!landed && !res.hard && !dryRun) {
      await sleep(1200);
      if (!res.ok) res = await exec(step, args);
      landed = res.ok && await settle(step.check);
    }

    if (step.tool === 'get_verification_code' && res.ok) {
      const m = String(res.text || '').match(/^Code (\S+)/);
      if (m) vars.code = m[1];
    }

    if (landed) { emit({ type: 'pb_step', i, state: 'ok' }); continue; }

    const reason = res.ok
      ? (step.check && step.check.url ? `it did not end up on ${checkLabel(step.check)}` : `the window "${appPart(step.check && step.check.window)}" never came up`)
      : res.error;
    if (dryRun || res.hard || !heal) return finish(false, { failedAt: i, error: `Step ${i + 1} (${step.text}) did not work: ${reason}` });

    // The repair: a model gets this one step, does whatever it takes to get
    // past it, and what it did becomes the step.
    emit({ type: 'pb_step', i, state: 'healing', note: reason });
    const fix = await heal({ step, index: i, steps, reason, args });
    if (signal && signal.aborted) return finish(false, { stopped: true, error: 'Stopped.' });
    const fixed = fix && fix.ok ? compileSteps(fix.steps || [], Date.now()).map((s) => ({ ...s, healed: true })) : [];
    const cleared = fix && fix.ok && fixed.length && await settle(step.check);
    if (!cleared) {
      return finish(false, { failedAt: i, error: `Step ${i + 1} (${step.text}) did not work, and could not be repaired: ${(fix && fix.error) || reason}` });
    }
    steps.splice(i, 1, ...fixed);
    healed++;
    emit({ type: 'pb_healed', i, count: fixed.length, steps: stepsView() });
    i += fixed.length - 1;
  }

  return finish(true);
}

/* ── suggesting inputs ──────────────────────────────────────────────
 * Which typed values look like they will be different next time — a name, an
 * amount, a search term. A model is asked once, and only values that really
 * are in the steps come back. */

function suggestBrief(pb) {
  const lines = pb.steps.map((s, i) => {
    const vals = strings(s.args).filter((v) => v.length >= 2 && v.length <= 200 && !/^\{\{/.test(v));
    return `${i + 1}. ${s.text}${vals.length ? `  [values: ${vals.map((v) => JSON.stringify(v)).join(', ')}]` : ''}`;
  });
  return `The job: ${pb.goal}\n\nThe steps it took:\n${lines.join('\n')}`;
}

const SUGGEST_RULES = `You are looking at a recorded job that will be replayed on other days. Find the typed values that will probably be DIFFERENT next time — a customer or supplier name, an amount, an invoice number, a search term, a file name, an email address it wrote to. Not values that are part of how the job is done (a menu name, a site address, a button), and not dates (those are handled already).

Reply with JSON only, no prose: an array of at most 6 objects, each {"value": "<exactly as it appears in the values>", "name": "<short_snake_case_name>", "why": "<a few words>"}. An empty array if nothing should change.`;

function parseSuggestions(text, pb) {
  const all = new Set(pb.steps.flatMap((s) => strings(s.args)));
  const has = (v) => [...all].some((s) => s.includes(v));
  let arr = [];
  try { arr = JSON.parse((String(text).match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { arr = []; }
  return (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x.value === 'string' && x.value.length >= 2 && has(x.value))
    .map((x) => ({ value: x.value, name: String(x.name || 'value').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40), why: String(x.why || '').slice(0, 120) }))
    .slice(0, 6);
}

module.exports = {
  init, startRun, recordStep, endRun, takeRun, listRecent,
  fromTask, list, get, raw, update, remove, makeInput, run,
  suggestBrief, parseSuggestions, SUGGEST_RULES, TRIGGER_VARS,
  // for tests and the watchers
  formatDate, withDates, compileSteps, matches, appPart,
};
