// store.js — bots on disk.
//
// The main object is a bot, not a conversation. A bot has a name, a face, a way
// of working, things it remembers, standing jobs, and its own chats. Chats come
// and go underneath it; the bot is what you come back to.
//
// Screenshots are never written here — they are megabytes of base64 each, and
// the live view is live.

const fs = require('fs');
const path = require('path');

// An agent is a bot with exactly one thread, so the ceiling that used to be
// "how many personas can you keep track of" is now "how many conversations do
// you keep", which is a much bigger number. The rail scrolls; 50 did not.
const MAX_BOTS = 500;
const MAX_CHATS_PER_BOT = 80;

let file = null;
let legacyFile = null;
let bots = [];

/* ── identity ────────────────────────────────────────────────────── */

const SHAPES = ['squircle', 'round', 'dome', 'shield'];
const ACCESSORIES = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];

// Muted enough to sit inside a near-black interface, separated enough to tell
// apart out of the corner of your eye.
const HUES = [199, 262, 152, 24, 341, 44, 288, 174];

const id = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function faceFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return {
    hue: HUES[h % HUES.length],
    shape: SHAPES[(h >> 3) % SHAPES.length],
    accessory: ACCESSORIES[(h >> 6) % ACCESSORIES.length],
  };
}

/* ── loading ─────────────────────────────────────────────────────── */

function init(userDataDir) {
  file = path.join(userDataDir, 'bots.json');
  legacyFile = path.join(userDataDir, 'chats.json');
  settingsFile = path.join(userDataDir, 'settings.json');

  try {
    bots = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(bots)) bots = [];
  } catch {
    bots = [];
  }

  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
  } catch {
    settings = {};
  }
  if (!settings.connectors) settings.connectors = {};
  if (!Array.isArray(settings.codeChats)) settings.codeChats = [];
  if (!Array.isArray(settings.workspaces)) settings.workspaces = [];

  if (!bots.length) bots = [adopt()];
  toAgents();
  flush();
}

// One-time: turn "bots, each owning a pile of chats" into "agents, each being
// one conversation". Every bot that existed was something you kept, so it stays
// pinned at the top; every chat underneath it becomes an agent of its own,
// wearing that bot's face and persona. Nothing is thrown away, and it runs once
// — the flag is what stops a later chat being split off again.
function toAgents() {
  if (settings.agentsMigrated) return;

  const made = [];
  for (const b of bots) {
    if (b.pinned === undefined) b.pinned = true;
    if (b.role === undefined) b.role = b.pinned ? 'main' : null;

    // chats[0] is the newest — the bot keeps that one and hands over the rest.
    const rest = b.chats.slice(1);
    b.chats = b.chats.slice(0, 1);

    for (const c of rest) {
      const agent = blank(b.name, b.title);
      agent.face = b.face;
      agent.persona = b.persona;
      agent.model = b.model;
      agent.name = (c.title && c.title !== 'New chat' ? c.title : b.name).slice(0, 40);
      agent.title = '';
      agent.chats = [c];
      agent.updatedAt = c.updatedAt || Date.now();
      // Memory and routines stay with the pinned agent they were set up on:
      // copying them would fire the same routine once per split-off thread.
      made.push(agent);
    }
  }

  bots.push(...made);
  settings.agentsMigrated = true;
  flushSettings();
}

/* ── connectors (email, and more later) ──────────────────────────── */

let settings = { connectors: {} };
let settingsFile = null;

function flushSettings() {
  if (!settingsFile) return;
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); }
  catch (err) { console.error('could not save settings:', err.message); }
}

// A safe view of what is connected — never includes the password.
function listConnectors() {
  const c = settings.connectors || {};
  return Object.keys(c).map((k) => {
    const v = c[k] || {};
    return { id: k, connected: Boolean(v.connected), expired: Boolean(v.expired), email: v.email || null, provider: v.provider || null };
  });
}

// Note something about a connector without reconnecting it — that its Google
// sign-in has expired, say — keeping everything else as it was.
function markConnector(id, patch) {
  const c = (settings.connectors || {})[id];
  if (!c) return null;
  Object.assign(c, patch || {});
  flushSettings();
  return c;
}

// The full config, password included — for the backend only, never sent to the UI.
/* ── appearance ──────────────────────────────────────────────────── */
// How the app should look. Kept here rather than in the renderer so it follows
// the profile; the renderer also mirrors it to localStorage so the theme is on
// screen before the first paint instead of flashing the default first.

// `verify` is on by default: an agent that reports work it did not do is worse
// than a slow one, and the check costs about a cent. See verify.js.
const PREF_DEFAULTS = { theme: 'warm', accent: 'blue', glow: 'full', edge: 'accent', motion: 'on', verify: true };

function getPrefs() {
  return { ...PREF_DEFAULTS, ...(settings.prefs || {}) };
}

function setPrefs(patch) {
  settings.prefs = { ...getPrefs(), ...(patch || {}) };
  flushSettings();
  return getPrefs();
}

/* ── per-model settings ─────────────────────────────────────────────
   Effort, thinking, temperature and so on, per model and per side (Agents or
   Code). Only what model-options.js recognises for that model is kept. */

const modelOptions = require('./model-options');

function getModelOptions(mode) {
  const all = settings.modelOptions || {};
  return { ...(all[mode === 'code' ? 'code' : 'agents'] || {}) };
}

function setModelOptions(mode, modelId, patch) {
  const side = mode === 'code' ? 'code' : 'agents';
  if (!settings.modelOptions) settings.modelOptions = {};
  if (!settings.modelOptions[side]) settings.modelOptions[side] = {};
  const next = modelOptions.clean(modelId, { ...(settings.modelOptions[side][modelId] || {}), ...(patch || {}) });
  settings.modelOptions[side][modelId] = next;
  flushSettings();
  return next;
}

function getConnector(id) { return (settings.connectors || {})[id] || null; }

function setConnector(id, cfg) {
  settings.connectors[id] = { ...cfg, connected: true, at: Date.now() };
  flushSettings();
  return { ok: true };
}

function removeConnector(id) {
  delete settings.connectors[id];
  flushSettings();
  return { ok: true };
}

/* ── code chats (the coding side's history, ChatGPT-style) ────────── */

// `turns` is only a count here: the sidebar needs to know a chat is empty
// (and hide it), not what was said.
const codeCard = (c) => ({ id: c.id, title: c.title, cwd: c.cwd, cwdName: c.cwdName, project: c.project || null, model: c.model, botId: c.botId || null, turns: (c.turns || []).length, updatedAt: c.updatedAt });

function listCodeChats() {
  return (settings.codeChats || []).slice().sort((a, b) => b.updatedAt - a.updatedAt).map(codeCard);
}
function getCodeChat(cid) { return (settings.codeChats || []).find((c) => c.id === cid) || null; }

function createCodeChat({ cwd, cwdName, model } = {}) {
  const chat = {
    id: id('cc'), title: 'New chat',
    cwd: cwd || null, cwdName: cwdName || null, model: model || null,
    sessionId: null, turns: [], updatedAt: Date.now(),
  };
  settings.codeChats.unshift(chat);
  if (settings.codeChats.length > 200) settings.codeChats.length = 200;
  flushSettings();
  return chat;
}

function saveCodeChat(cid, patch = {}) {
  const c = getCodeChat(cid);
  if (!c) return null;
  if (typeof patch.title === 'string' && patch.title.trim()) c.title = patch.title.trim().slice(0, 80);
  if ('cwd' in patch) { c.cwd = patch.cwd; c.cwdName = patch.cwdName || null; }
  if ('model' in patch) c.model = patch.model;
  if ('botId' in patch) c.botId = patch.botId || null;
  // The folder a build actually landed in, which the editor opens on.
  if ('project' in patch) c.project = patch.project || null;
  if ('sessionId' in patch) c.sessionId = patch.sessionId;
  if (Array.isArray(patch.turns)) c.turns = patch.turns;
  c.updatedAt = Date.now();
  flushSettings();
  return codeCard(c);
}

function removeCodeChat(cid) {
  settings.codeChats = (settings.codeChats || []).filter((c) => c.id !== cid);
  flushSettings();
  return { ok: true };
}

// The Google OAuth client (ID + secret) the user made in their Google Cloud
// project. Stored once and reused for every sign-in and token refresh. A desktop
// client secret is not a real secret, so keeping it locally is fine.
function getGoogle() {
  const g = settings.google || {};
  return { clientId: g.clientId || '', clientSecret: g.clientSecret || '' };
}

function setGoogle({ clientId, clientSecret }) {
  settings.google = { clientId: String(clientId || '').trim(), clientSecret: String(clientSecret || '').trim() };
  flushSettings();
  return { ok: true, configured: Boolean(settings.google.clientId && settings.google.clientSecret) };
}

/* ── NVIDIA NIM ──────────────────────────────────────────────────────
   One key unlocks every model NVIDIA hosts — Meta, Google, Mistral,
   DeepSeek, Qwen, NVIDIA's own Nemotron family and the rest. It is a real
   secret, so it stays on this machine and the UI only ever sees the last
   four characters of it. */

function getNvidia() {
  const n = settings.nvidia || {};
  return { key: n.key || '', unavailable: n.unavailable || [] };
}

// Which models NVIDIA will not serve this key — found by trying them, and
// worth keeping so the picker is honest from the moment the app opens.
function setNvidiaUnavailable(ids) {
  if (!settings.nvidia) return { ok: false };
  settings.nvidia.unavailable = Array.isArray(ids) ? ids : [];
  flushSettings();
  return { ok: true };
}

// What the settings panel is allowed to know: that there is a key, and just
// enough of it to recognise which one.
function nvidiaStatus() {
  const key = (settings.nvidia && settings.nvidia.key) || '';
  return { configured: Boolean(key), hint: key ? `…${key.slice(-4)}` : '' };
}

function setNvidia(key) {
  const k = String(key || '').trim();
  // A new key may reach a different set of models, so what the last one could
  // not run says nothing about this one.
  if (k) settings.nvidia = { key: k, at: Date.now(), unavailable: [] };
  else delete settings.nvidia;
  flushSettings();
  return nvidiaStatus();
}

/* ── Anthropic API key ───────────────────────────────────────────────
   What an installed copy runs Claude on. Anthropic does not let a product
   built on the Agent SDK run on someone's Claude subscription login, so the
   customer brings their own key and pays Anthropic for what they use. Same
   rules as the NVIDIA key: it stays here, and the UI sees the last four. */

function getAnthropic() {
  return ((settings.anthropic || {}).key) || '';
}

function anthropicStatus() {
  const key = getAnthropic();
  return { configured: Boolean(key), hint: key ? `…${key.slice(-4)}` : '' };
}

function setAnthropic(key) {
  const k = String(key || '').trim();
  if (k) settings.anthropic = { key: k, at: Date.now() };
  else delete settings.anthropic;
  flushSettings();
  return anthropicStatus();
}

// Chats written before bots existed become the first bot's chats, so nobody
// loses a transcript to the upgrade.
function adopt() {
  let chats = [];
  try {
    const old = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    if (Array.isArray(old)) chats = old;
  } catch { /* nothing to adopt */ }

  const bot = blank('Operator', 'Runs this computer');
  bot.chats = chats.map((c) => ({
    id: c.id,
    title: c.title,
    sessionId: c.sessionId || null,
    turns: c.turns || [],
    updatedAt: c.updatedAt || Date.now(),
  }));
  return bot;
}

function blank(name, title) {
  const botId = id('b');
  return {
    id: botId,
    name,
    title,
    face: faceFor(botId + name),
    persona: '',
    model: null,       // null means "whatever the app default is"
    memory: [],
    skills: [],
    routines: [],
    chats: [],
    // Where it sits in the rail. A pinned agent is one you keep — it stays at
    // the top whatever else you start. `role` is what the badge says; it is a
    // label, not behaviour, and nothing in the agent loop reads it.
    pinned: false,
    role: null,        // 'coordinator' | 'main' | null
    workspaceId: null, // which folder it is filed in, if any
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function flush() {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(bots));
  } catch (err) {
    console.error('could not save bots:', err.message);
  }
}

/* ── agents ──────────────────────────────────────────────────────────
 * An agent is a bot with exactly one thread. It used to be that a bot owned a
 * list of chats and you picked one; now the thing in the rail IS the
 * conversation, the way it is in ChatGPT, and the persona, memory and routines
 * ride along with it. The storage shape did not change — a bot still has a
 * `chats` array — it just never has more than one entry in it any more. That
 * keeps every function below, and the session code, working untouched.
 */

const ROLES = ['coordinator', 'main'];

/* ── workspaces ──────────────────────────────────────────────────────
 * A named folder of agents. Membership lives on the agent as a single
 * `workspaceId` rather than as a list of ids on the workspace, so there is
 * only ever one copy of the truth — a list on both sides is a sync bug
 * waiting for the first delete.
 *
 * A workspace is filing, not scope. It does not isolate anything: agents in
 * one can still message agents in another, and the UI must not suggest
 * otherwise. Pinned agents stay in "Always on" whatever folder they are in,
 * and get their folder back when unpinned.
 */

const wsCard = (w) => ({
  id: w.id,
  name: w.name,
  collapsed: Boolean(w.collapsed),
  count: bots.filter((b) => b.workspaceId === w.id).length,
});

function listWorkspaces() { return (settings.workspaces || []).map(wsCard); }

function createWorkspace(name) {
  const w = { id: id('w'), name: String(name || 'New workspace').trim().slice(0, 40) || 'New workspace', collapsed: false, createdAt: Date.now() };
  settings.workspaces.push(w);
  flushSettings();
  return wsCard(w);
}

function updateWorkspace(wsId, patch = {}) {
  const w = (settings.workspaces || []).find((x) => x.id === wsId);
  if (!w) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) w.name = patch.name.trim().slice(0, 40);
  if ('collapsed' in patch) w.collapsed = Boolean(patch.collapsed);
  flushSettings();
  return wsCard(w);
}

// Deleting the folder must never delete what is filed in it. The agents come
// back out to the main list; only the folder goes.
function deleteWorkspace(wsId) {
  settings.workspaces = (settings.workspaces || []).filter((w) => w.id !== wsId);
  let moved = 0;
  for (const b of bots) if (b.workspaceId === wsId) { b.workspaceId = null; moved++; }
  flushSettings();
  if (moved) flush();
  return { ok: true, freed: moved };
}

// null takes an agent back out to the main list.
function setAgentWorkspace(botId, wsId) {
  const b = find(botId);
  if (!b) return null;
  const real = wsId && (settings.workspaces || []).some((w) => w.id === wsId);
  b.workspaceId = real ? wsId : null;
  b.updatedAt = Date.now();
  flush();
  return card(b);
}

// The agent's one thread, made on demand. An agent that has never been spoken
// to has no thread yet, which is what keeps a freshly made one out of the way
// until it is actually used.
function threadOf(botId) {
  const b = find(botId);
  if (!b) return null;
  if (!b.chats.length) return createChat(botId);
  return b.chats[0];
}

// A new agent, thread and all. Two calls collapsed into one because from here
// on you cannot have the one without the other.
function createAgent(spec = {}) {
  const made = createBot(spec);
  if (!made) return null;
  const thread = createChat(made.id);
  if (spec.pinned) updateBot(made.id, { pinned: true, role: spec.role || 'main' });
  return { ...card(find(made.id)), threadId: thread.id };
}

/* ── bots ────────────────────────────────────────────────────────── */

// What the roster needs, without dragging every transcript along with it.
const card = (b) => ({
  id: b.id,
  name: b.name,
  title: b.title,
  face: b.face,
  model: b.model,
  persona: b.persona,
  memoryCount: b.memory.length,
  routineCount: b.routines.filter((r) => !r.paused).length,
  skillCount: b.skills.length,
  updatedAt: b.updatedAt,
  lastLine: lastLine(b),
  pinned: Boolean(b.pinned),
  role: b.role || null,
  workspaceId: b.workspaceId || null,
  // Employees live in their own tab; the rail and the start screen skip them.
  employee: Boolean(b.employee),
  // An agent is one thread, so this is normally a list of one — enough for the
  // rail to open it without a second round trip, and null until it has been
  // spoken to (threadOf makes it on demand). It can still run to more than one:
  // a routine writes its run into a thread of its own, and the rail shows those
  // as agents in their own right rather than hiding them.
  threads: b.chats.map(chatCard),
});

function lastLine(b) {
  const chat = b.chats[0];
  if (!chat || !chat.turns.length) return '';
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    const t = chat.turns[i];
    if (t.k === 'says' || t.k === 'you') return String(t.text).replace(/\s+/g, ' ').slice(0, 90);
  }
  return '';
}

const find = (botId) => bots.find((b) => b.id === botId) || null;

function listBots() { return bots.map(card); }

function getBot(botId) { return find(botId); }

function createBot({ name, title, persona, model } = {}) {
  if (bots.length >= MAX_BOTS) return null;
  const bot = blank((name || 'New agent').slice(0, 40), (title || '').slice(0, 60));
  if (persona) bot.persona = String(persona).slice(0, 4000);
  if (model) bot.model = model;
  bots.unshift(bot);
  flush();
  return card(bot);
}

function updateBot(botId, patch = {}) {
  const b = find(botId);
  if (!b) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) b.name = patch.name.trim().slice(0, 40);
  if (typeof patch.title === 'string') b.title = patch.title.trim().slice(0, 60);
  if (typeof patch.persona === 'string') b.persona = patch.persona.slice(0, 4000);
  if ('model' in patch) b.model = patch.model || null;
  if (patch.face) b.face = patch.face;
  if ('pinned' in patch) b.pinned = Boolean(patch.pinned);
  // Only a pinned agent wears a badge, so unpinning takes the role with it
  // rather than leaving a coordinator hidden down the list.
  if ('role' in patch) b.role = ROLES.includes(patch.role) ? patch.role : null;
  if (!b.pinned) b.role = null;
  if ('workspaceId' in patch) {
    const real = patch.workspaceId && (settings.workspaces || []).some((w) => w.id === patch.workspaceId);
    b.workspaceId = real ? patch.workspaceId : null;
  }
  b.updatedAt = Date.now();
  flush();
  return card(b);
}

function deleteBot(botId) {
  bots = bots.filter((b) => b.id !== botId);
  if (!bots.length) bots = [blank('Operator', 'Runs this computer')];
  flush();
}

// Undo, for the few seconds after a delete: `snap` is the bot as getBot gave
// it just before. A bot deleteBot took goes back where it was; for one that is
// still here, only the threads removeChat took come back — anything that has
// changed on it since is kept.
function restoreBot(snap, index) {
  if (!snap || !snap.id || !Array.isArray(snap.chats)) return null;
  const live = find(snap.id);
  if (live) {
    const have = new Set(live.chats.map((c) => c.id));
    snap.chats.forEach((c, i) => { if (!have.has(c.id)) live.chats.splice(Math.min(i, live.chats.length), 0, c); });
  } else {
    if (bots.length >= MAX_BOTS) return null;
    // Filed in a workspace that has gone since: back into the main list.
    if (snap.workspaceId && !(settings.workspaces || []).some((w) => w.id === snap.workspaceId)) snap.workspaceId = null;
    bots.splice(Number.isInteger(index) ? Math.max(0, Math.min(index, bots.length)) : 0, 0, snap);
  }
  flush();
  return card(find(snap.id));
}

/* ── what a bot remembers ────────────────────────────────────────── */

// Memory belongs to the bot, not the account: a bot that books travel and a bot
// that fixes bugs should not have to read each other's notes.
function remember(botId, text) {
  const b = find(botId);
  if (!b || !String(text || '').trim()) return null;
  const note = { id: id('m'), text: String(text).trim().slice(0, 400), at: Date.now() };
  b.memory.unshift(note);
  if (b.memory.length > 120) b.memory.length = 120;
  b.updatedAt = Date.now();
  flush();
  return note;
}

function forget(botId, noteId) {
  const b = find(botId);
  if (!b) return;
  b.memory = b.memory.filter((m) => m.id !== noteId);
  flush();
}

/* ── skills: a named, reusable instruction ───────────────────────────
 *
 * Skills live in one account-wide library (settings.skills). A skill can be
 * turned on for a bot so it is ALWAYS in that bot's instructions, or invoked in
 * a single message by typing /its-name. A bot's `skills` array holds the ids of
 * the skills that are always on for it.
 */

function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'skill';
}

function listSkills() {
  return (settings.skills || []).map((s) => ({ id: s.id, name: s.name, title: s.title || '', prompt: s.prompt }));
}

function getSkill(skillId) {
  return (settings.skills || []).find((s) => s.id === skillId) || null;
}

// Match the /name typed in a chat, case-insensitively, against the slug.
function getSkillByName(name) {
  const slug = slugify(name);
  return (settings.skills || []).find((s) => s.name === slug) || null;
}

function uniqueSlug(base, exceptId) {
  let slug = base;
  let n = 2;
  while ((settings.skills || []).some((s) => s.name === slug && s.id !== exceptId)) slug = `${base}-${n++}`;
  return slug;
}

function createSkill({ name, title, prompt } = {}) {
  if (!String(prompt || '').trim()) return { ok: false, error: 'a skill needs some instructions' };
  if (!settings.skills) settings.skills = [];
  const skill = {
    id: id('sk'),
    name: uniqueSlug(slugify(name || title || prompt)),
    title: String(title || name || '').trim().slice(0, 60),
    prompt: String(prompt).trim().slice(0, 4000),
    at: Date.now(),
  };
  settings.skills.push(skill);
  flushSettings();
  return { ok: true, skill };
}

function updateSkill(skillId, patch = {}) {
  const s = (settings.skills || []).find((x) => x.id === skillId);
  if (!s) return { ok: false, error: 'that skill is gone' };
  if (typeof patch.name === 'string' && patch.name.trim()) s.name = uniqueSlug(slugify(patch.name), skillId);
  if (typeof patch.title === 'string') s.title = patch.title.trim().slice(0, 60);
  if (typeof patch.prompt === 'string') s.prompt = patch.prompt.trim().slice(0, 4000);
  flushSettings();
  return { ok: true, skill: s };
}

function deleteSkill(skillId) {
  settings.skills = (settings.skills || []).filter((s) => s.id !== skillId);
  // Drop it from every bot that had it switched on.
  for (const b of bots) if (Array.isArray(b.skills)) b.skills = b.skills.filter((x) => x !== skillId);
  flushSettings();
  flush();
  return { ok: true };
}

// Turn a library skill on/off for a bot (always-on membership).
function attachSkill(botId, skillId) {
  const b = find(botId);
  if (!b || !getSkill(skillId)) return { ok: false };
  if (!b.skills.includes(skillId)) b.skills.push(skillId);
  b.updatedAt = Date.now();
  flush();
  return { ok: true };
}

function removeSkill(botId, skillId) {
  const b = find(botId);
  if (!b) return { ok: false };
  // Tolerate both the new id strings and any legacy inline {id,...} entries.
  b.skills = b.skills.filter((s) => (typeof s === 'string' ? s : s && s.id) !== skillId);
  b.updatedAt = Date.now();
  flush();
  return { ok: true };
}

// The always-on skills for a bot, resolved to {name,title,prompt}. Handles both
// the id references and any older inline skill objects still on disk.
function skillsForBot(botId) {
  const b = find(botId);
  if (!b || !Array.isArray(b.skills)) return [];
  const out = [];
  for (const entry of b.skills) {
    if (typeof entry === 'string') { const s = getSkill(entry); if (s) out.push({ name: s.name, title: s.title, prompt: s.prompt }); }
    else if (entry && entry.prompt) out.push({ name: entry.name, title: entry.name, prompt: entry.prompt });
  }
  return out;
}

/* ── routines: work that starts without you ──────────────────────── */

function addRoutine(botId, { name, prompt, every, at, kind, when }) {
  const b = find(botId);
  if (!b || !String(prompt || '').trim()) return null;
  // "once" needs the moment it is due, as ms since the epoch.
  if (every === 'once' && !(Number(when) > 0)) return null;
  const routine = {
    id: id('r'),
    name: String(name || prompt).trim().slice(0, 60),
    prompt: String(prompt).trim().slice(0, 2000),
    // "remind" only shows the user the words at that time; "task" runs the
    // agent on them.
    kind: kind === 'remind' ? 'remind' : 'task',
    every: ['once', 'min5', 'min15', 'min30', 'hour', 'day', 'weekday', 'week'].includes(every) ? every : 'day',
    when: every === 'once' ? Number(when) : null,
    at: /^\d{2}:\d{2}$/.test(at || '') ? at : '09:00',
    paused: false,
    lastRun: null,
    // The scheduler counts from here until it has run once, so a routine is
    // not due the moment it is made — "every day at 09:00" added at five in
    // the afternoon first runs tomorrow at nine, not straight away.
    createdAt: Date.now(),
  };
  b.routines.push(routine);
  flush();
  return routine;
}

function updateRoutine(botId, routineId, patch = {}) {
  const b = find(botId);
  if (!b) return null;
  const r = b.routines.find((x) => x.id === routineId);
  if (!r) return null;
  if ('paused' in patch) r.paused = Boolean(patch.paused);
  if ('lastRun' in patch) r.lastRun = patch.lastRun;
  flush();
  return r;
}

function removeRoutine(botId, routineId) {
  const b = find(botId);
  if (!b) return;
  b.routines = b.routines.filter((r) => r.id !== routineId);
  flush();
}

// Every routine on every bot, flattened for the scheduler.
function allRoutines() {
  const out = [];
  for (const b of bots) for (const r of b.routines) out.push({ botId: b.id, botName: b.name, routine: r });
  return out;
}

/* ── chats, which live under a bot ───────────────────────────────── */

const chatCard = (c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt });

function listChats(botId) {
  const b = find(botId);
  return b ? b.chats.map(chatCard) : [];
}

function getChat(botId, chatId) {
  const b = find(botId);
  return b ? b.chats.find((c) => c.id === chatId) || null : null;
}

function createChat(botId) {
  const b = find(botId);
  if (!b) return null;
  const chat = { id: id('c'), title: 'New chat', sessionId: null, turns: [], updatedAt: Date.now() };
  b.chats.unshift(chat);
  if (b.chats.length > MAX_CHATS_PER_BOT) b.chats.length = MAX_CHATS_PER_BOT;
  b.updatedAt = Date.now();
  flush();
  return chat;
}

function saveChat(botId, chatId, { title, turns }) {
  const b = find(botId);
  if (!b) return null;
  const chat = b.chats.find((c) => c.id === chatId);
  if (!chat) return null;
  if (typeof title === 'string' && title.trim()) chat.title = title.trim().slice(0, 80);
  if (Array.isArray(turns)) chat.turns = turns;
  chat.updatedAt = Date.now();
  b.chats = [chat, ...b.chats.filter((c) => c.id !== chatId)];
  b.updatedAt = Date.now();
  flush();
  return chatCard(chat);
}

function removeChat(botId, chatId) {
  const b = find(botId);
  if (!b) return;
  b.chats = b.chats.filter((c) => c.id !== chatId);
  flush();
}

/* ── employees ───────────────────────────────────────────────────────
 * An agent with a job, a shift and a to-do list, that works on a loop and
 * messages the user first (employees.js runs the loop). It is an ordinary bot
 * underneath — persona, memory, routines and one conversation — with its
 * working state kept on `employee`. The conversation is chats[0]: your
 * messages, its messages to you, and a compact entry for each check-in.
 */

const EVERY_MIN = [15, 30, 60, 120, 240];
const clampEvery = (n) => (EVERY_MIN.includes(Number(n)) ? Number(n) : 60);
const cleanHours = (h) => (h && /^\d{2}:\d{2}$/.test(h.from || '') && /^\d{2}:\d{2}$/.test(h.to || '')
  ? { from: h.from, to: h.to, days: h.days === 'weekdays' ? 'weekdays' : 'every' } : null);
// Where it sits in the Agent Verse (ui/agentverse.js), and the face picked for it at hiring.
const cleanSection = (s) => String(s || '').trim().slice(0, 40);
const cleanFace = (f) => (f && SHAPES.includes(f.shape) && ACCESSORIES.includes(f.accessory) && Number.isFinite(Number(f.hue))
  ? { hue: Math.round(Number(f.hue)) % 360, shape: f.shape, accessory: f.accessory } : null);

function employeeCard(b) {
  const e = b.employee;
  return {
    ...card(b),
    role: b.title,
    job: e.job,
    section: e.section || '',
    every: e.every,
    hours: e.hours,
    cap: e.cap,
    onShift: e.onShift,
    nextAt: e.nextAt,
    lastAt: e.lastAt,
    today: e.today,
    tasks: e.tasks,
    unread: e.unread,
    waiting: e.waiting,
    pending: e.pending,
    log: e.log.slice(-30),
  };
}

function hireEmployee({ name, role, job, every, hours, cap, onShift, section, face } = {}) {
  if (bots.length >= MAX_BOTS || !String(job || '').trim()) return null;
  const b = blank(String(name || 'New employee').trim().slice(0, 40), String(role || '').trim().slice(0, 60));
  if (cleanFace(face)) b.face = cleanFace(face);
  b.employee = {
    job: String(job).trim().slice(0, 4000),
    section: cleanSection(section),
    every: clampEvery(every),
    hours: cleanHours(hours),
    cap: Math.max(1, Math.min(96, Number(cap) || 12)),
    onShift: Boolean(onShift),
    // The first check-in comes a minute after the hire, not a whole interval.
    nextAt: onShift ? Date.now() + 60 * 1000 : null,
    lastAt: null,
    today: { day: '', count: 0 },
    tasks: [],
    unread: 0,
    waiting: false,   // it asked you something and wants an answer
    pending: false,   // you said something it has not answered yet
    log: [],
  };
  b.chats = [{ id: id('c'), title: b.name, sessionId: null, turns: [], updatedAt: Date.now() }];
  bots.unshift(b);
  flush();
  return employeeCard(b);
}

function listEmployees() { return bots.filter((b) => b.employee).map(employeeCard); }

function getEmployee(botId) {
  const b = find(botId);
  return b && b.employee ? employeeCard(b) : null;
}

// What the job panel, the shift buttons and the loop itself change.
function updateEmployee(botId, patch = {}) {
  const b = find(botId);
  if (!b || !b.employee) return null;
  const e = b.employee;
  if (typeof patch.name === 'string' && patch.name.trim()) b.name = patch.name.trim().slice(0, 40);
  if (typeof patch.role === 'string') b.title = patch.role.trim().slice(0, 60);
  if (typeof patch.job === 'string' && patch.job.trim()) e.job = patch.job.trim().slice(0, 4000);
  if ('section' in patch) e.section = cleanSection(patch.section);
  if (cleanFace(patch.face)) b.face = cleanFace(patch.face);
  if ('every' in patch) e.every = clampEvery(patch.every);
  if ('hours' in patch) e.hours = cleanHours(patch.hours);
  if ('cap' in patch) e.cap = Math.max(1, Math.min(96, Number(patch.cap) || 12));
  if ('onShift' in patch) {
    e.onShift = Boolean(patch.onShift);
    e.nextAt = e.onShift ? Date.now() + 60 * 1000 : null;
  }
  for (const k of ['nextAt', 'lastAt', 'today', 'unread', 'waiting', 'pending']) if (k in patch) e[k] = patch[k];
  b.updatedAt = Date.now();
  flush();
  return employeeCard(b);
}

function addEmployeeTask(botId, text, by) {
  const b = find(botId);
  if (!b || !b.employee || !String(text || '').trim()) return null;
  const t = { id: id('t'), text: String(text).trim().slice(0, 400), by: by === 'them' ? 'them' : 'you', done: false, at: Date.now(), doneAt: null, note: '' };
  b.employee.tasks.push(t);
  if (b.employee.tasks.length > 200) b.employee.tasks = b.employee.tasks.filter((x) => !x.done).slice(-200);
  flush();
  return t;
}

function updateEmployeeTask(botId, taskId, patch = {}) {
  const b = find(botId);
  const t = b && b.employee && b.employee.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  if ('done' in patch) { t.done = Boolean(patch.done); t.doneAt = t.done ? Date.now() : null; }
  if (typeof patch.note === 'string') t.note = patch.note.slice(0, 400);
  if (typeof patch.text === 'string' && patch.text.trim()) t.text = patch.text.trim().slice(0, 400);
  flush();
  return t;
}

function removeEmployeeTask(botId, taskId) {
  const b = find(botId);
  if (!b || !b.employee) return;
  b.employee.tasks = b.employee.tasks.filter((x) => x.id !== taskId);
  flush();
}

// One line per check-in or reply, for the work log.
function logEmployee(botId, entry) {
  const b = find(botId);
  if (!b || !b.employee) return;
  b.employee.log.push({ at: Date.now(), ...entry });
  if (b.employee.log.length > 100) b.employee.log = b.employee.log.slice(-100);
  flush();
}

// Add to the conversation without the caller holding the whole transcript.
function addTurn(botId, turn) {
  const b = find(botId);
  const chat = b && b.chats[0];
  if (!chat) return;
  chat.turns.push({ at: Date.now(), ...turn });
  if (chat.turns.length > 600) chat.turns = chat.turns.slice(-600);
  chat.updatedAt = Date.now();
  b.updatedAt = Date.now();
  flush();
}

/* ── the SDK session behind a chat ───────────────────────────────── */

function sessionOf(botId, chatId) {
  const chat = getChat(botId, chatId);
  return chat ? chat.sessionId : null;
}

function setSession(botId, chatId, sessionId) {
  const chat = getChat(botId, chatId);
  if (!chat || !sessionId || chat.sessionId === sessionId) return;
  chat.sessionId = sessionId;
  flush();
}

// A session the SDK no longer holds cannot be resumed. Dropping it costs the
// chat its memory of itself, not its contents.
function forgetSession(botId, chatId) {
  const chat = getChat(botId, chatId);
  if (!chat) return;
  chat.sessionId = null;
  flush();
}

module.exports = {
  init, faceFor,
  listBots, getBot, createBot, updateBot, deleteBot, restoreBot,
  createAgent, threadOf,
  listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setAgentWorkspace,
  remember, forget,
  listSkills, getSkill, getSkillByName, createSkill, updateSkill, deleteSkill,
  attachSkill, removeSkill, skillsForBot,
  addRoutine, updateRoutine, removeRoutine, allRoutines,
  listChats, getChat, createChat, saveChat, removeChat,
  sessionOf, setSession, forgetSession,
  getPrefs, setPrefs, getModelOptions, setModelOptions,
  listConnectors, getConnector, setConnector, markConnector, removeConnector, getGoogle, setGoogle,
  getNvidia, setNvidia, setNvidiaUnavailable, nvidiaStatus,
  getAnthropic, setAnthropic, anthropicStatus,
  hireEmployee, listEmployees, getEmployee, updateEmployee,
  addEmployeeTask, updateEmployeeTask, removeEmployeeTask, logEmployee, addTurn,
  listCodeChats, getCodeChat, createCodeChat, saveCodeChat, removeCodeChat,
};
