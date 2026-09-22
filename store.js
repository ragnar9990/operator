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

const MAX_BOTS = 50;        // the roster stops being scannable long before this
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

  if (!bots.length) bots = [adopt()];
  flush();
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
    return { id: k, connected: Boolean(v.connected), email: v.email || null, provider: v.provider || null };
  });
}

// The full config, password included — for the backend only, never sent to the UI.
/* ── appearance ──────────────────────────────────────────────────── */
// How the app should look. Kept here rather than in the renderer so it follows
// the profile; the renderer also mirrors it to localStorage so the theme is on
// screen before the first paint instead of flashing the default first.

// `verify` is on by default: an agent that reports work it did not do is worse
// than a slow one, and the check costs about a cent. See verify.js.
const PREF_DEFAULTS = { theme: 'warm', accent: 'blue', glow: 'full', motion: 'on', verify: true };

function getPrefs() {
  return { ...PREF_DEFAULTS, ...(settings.prefs || {}) };
}

function setPrefs(patch) {
  settings.prefs = { ...getPrefs(), ...(patch || {}) };
  flushSettings();
  return getPrefs();
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

const codeCard = (c) => ({ id: c.id, title: c.title, cwd: c.cwd, cwdName: c.cwdName, model: c.model, botId: c.botId || null, updatedAt: c.updatedAt });

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
  const bot = blank((name || 'New bot').slice(0, 40), (title || '').slice(0, 60));
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
  b.updatedAt = Date.now();
  flush();
  return card(b);
}

function deleteBot(botId) {
  bots = bots.filter((b) => b.id !== botId);
  if (!bots.length) bots = [blank('Operator', 'Runs this computer')];
  flush();
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

function addRoutine(botId, { name, prompt, every, at }) {
  const b = find(botId);
  if (!b || !String(prompt || '').trim()) return null;
  const routine = {
    id: id('r'),
    name: String(name || prompt).trim().slice(0, 60),
    prompt: String(prompt).trim().slice(0, 2000),
    every: ['min5', 'min15', 'min30', 'hour', 'day', 'weekday', 'week'].includes(every) ? every : 'day',
    at: /^\d{2}:\d{2}$/.test(at || '') ? at : '09:00',
    paused: false,
    lastRun: null,
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
  listBots, getBot, createBot, updateBot, deleteBot,
  remember, forget,
  listSkills, getSkill, getSkillByName, createSkill, updateSkill, deleteSkill,
  attachSkill, removeSkill, skillsForBot,
  addRoutine, updateRoutine, removeRoutine, allRoutines,
  listChats, getChat, createChat, saveChat, removeChat,
  sessionOf, setSession, forgetSession,
  getPrefs, setPrefs,
  listConnectors, getConnector, setConnector, removeConnector, getGoogle, setGoogle,
  getNvidia, setNvidia, setNvidiaUnavailable, nvidiaStatus,
  listCodeChats, getCodeChat, createCodeChat, saveCodeChat, removeCodeChat,
};
