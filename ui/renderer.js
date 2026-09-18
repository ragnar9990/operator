const thread = document.getElementById('thread');
const input = document.getElementById('input');
const composer = document.getElementById('composer');
const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const railState = document.getElementById('railState');
const elapsedEl = document.getElementById('elapsed');
const actionsEl = document.getElementById('actions');
const liveEl = document.getElementById('live');
const surfaceEl = document.getElementById('surface');
const computerEl = document.getElementById('computer');
const frame = document.getElementById('frame');

let busy = false;
let startedAt = 0;
let ticker = null;
let actionCount = 0;
let hasFrame = false;
let group = null; // the open run of tool steps in the thread

// Rehearsal state: the task being planned, and the open plan card.
let lastTask = '';
let plan = null;

/* ── helpers ─────────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

// A message that opens with a /command shows that command in blue, the way it
// looks in the composer's slash menu.
function youHtml(text) {
  const s = String(text);
  const m = s.match(/^(\/[a-z0-9][\w-]*)(\s[\s\S]*)?$/i);
  if (!m) return esc(s);
  return '<span class="cmd">' + esc(m[1]) + '</span>' + esc(m[2] || '');
}

function trim(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;

function turn(kind, html) {
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = 'turn ' + kind;
  el.innerHTML = html;
  thread.appendChild(el);
  if (stick) thread.scrollTop = thread.scrollHeight;
  return el;
}

/* ── status ──────────────────────────────────────────────────────── */

function setLive(word, on) {
  liveEl.innerHTML = '<i></i>' + word;
  liveEl.classList.toggle('on', on);
}

function startRun() {
  if (window.__applyHandsOff) window.__applyHandsOff();  // survive a helper restart
  stopBtn.classList.remove('stopping');
  busy = true;
  startedAt = Date.now();
  actionCount = 0;
  actionsEl.textContent = '0 actions';
  document.body.classList.add('started');
  runBtn.disabled = true;
  runBtn.hidden = true;
  stopBtn.hidden = false;
  railState.classList.add('on');
  railState.title = 'Running';
  setLive('Live', true);
  paintFaces();
  showDots();
  clearInterval(ticker);
  elapsedEl.textContent = '0:00';
  ticker = setInterval(() => { elapsedEl.textContent = clock(Date.now() - startedAt); }, 500);
}

function endRun() {
  busy = false;
  hideDots();
  if (live) { live.el.classList.remove('live'); live = null; }
  runBtn.disabled = false;
  runBtn.hidden = false;
  stopBtn.hidden = true;
  railState.classList.remove('on');
  railState.title = 'Idle';
  clearInterval(ticker);
  ticker = null;
  setLive(hasFrame ? 'Paused' : 'Idle', false);
  closeGroup();
  paintFaces();
}

/* ── the step list ───────────────────────────────────────────────── */

const ICON = {
  look: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/>',
  point: '<path d="M6 3.5 18.5 11 13 12.6 10.6 18 6 3.5Z"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M7 15h10"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  term: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 9.5 10 12l-3 2.5M12.5 15h4.5"/>',
  win: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M2.5 9h19"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>',
  move: '<path d="M12 4v16M12 4 8.5 7.5M12 4l3.5 3.5M12 20l-3.5-3.5M12 20l3.5-3.5"/>',
};

function iconFor(name) {
  if (/screenshot|read_text/.test(name)) return ICON.look;
  if (/click|drag/.test(name)) return ICON.point;
  if (/type|press|_key/.test(name)) return ICON.keys;
  if (/scroll|move/.test(name)) return ICON.move;
  if (name === 'browser_navigate') return ICON.web;
  if (name === 'run_command') return ICON.term;
  if (/window|launch_app/.test(name)) return ICON.win;
  if (name === 'wait') return ICON.wait;
  return ICON.point;
}

function describeAction(name, a) {
  const arg = (v, n = 40) => '<span class="arg">' + esc(trim(v, n)) + '</span>';
  const where = a.display ? ' on ' + arg('display ' + a.display, 12) : '';
  switch (name) {
    // the desktop
    case 'screen_screenshot': return 'look at the screen' + where;
    case 'screen_click': {
      const verb = a.clicks === 2 ? 'double-click' : a.button === 'right' ? 'right-click' : 'click';
      return verb + ' ' + arg(a.x + ', ' + a.y, 18) + where;
    }
    case 'screen_move': return 'move to ' + arg(a.x + ', ' + a.y, 18) + where;
    case 'screen_drag': return 'drag ' + arg(a.x1 + ',' + a.y1 + ' → ' + a.x2 + ',' + a.y2, 28);
    case 'screen_scroll': return 'scroll ' + arg(a.direction, 8) + where;
    case 'screen_type': return 'type ' + arg(a.text, 32);
    case 'screen_key': return 'press ' + arg(a.keys, 18);
    case 'list_windows': return 'see what is open';
    case 'focus_window': return 'switch to ' + arg(a.title, 28);
    case 'launch_app': return 'open ' + arg(a.target, 28);
    case 'run_command': return 'run ' + arg(a.command, 46);
    case 'message_bot': return 'ask ' + arg(a.bot, 18) + ' — ' + arg(a.message, 30);
    case 'wait': return 'wait ' + arg(a.seconds + 's', 8);

    // the browser
    case 'browser_navigate': return 'browse ' + arg((a.url || '').replace(/^https?:\/\//, ''));
    case 'browser_click_text': return 'click ' + arg(a.text) + ' in the browser';
    case 'browser_click_xy': return 'click ' + arg(a.x + ', ' + a.y, 18) + ' in the browser';
    case 'browser_type_into': return 'type ' + arg(a.text, 24) + ' into ' + arg(a.target, 18);
    case 'browser_press_key': return 'press ' + arg(a.key, 14) + ' in the browser';
    case 'browser_scroll': return 'scroll ' + arg(a.direction, 8) + ' in the browser';
    case 'browser_read_text': return 'read the page';
    case 'browser_screenshot': return 'look at the browser';

    default: return esc(name);
  }
}

const CARET = '<svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>';

function openGroup() {
  const el = turn('', '<div class="steps open">' +
    '<button class="steps-head" type="button" aria-expanded="true">' + CARET +
    '<span class="what">Using the computer</span><span class="n">0 steps</span></button>' +
    '<div class="steps-body"></div></div>');

  const box = el.querySelector('.steps');
  const head = el.querySelector('.steps-head');
  head.addEventListener('click', () => {
    box.dataset.touched = '1';
    const open = box.classList.toggle('open');
    head.setAttribute('aria-expanded', String(open));
  });

  group = { box, head, label: el.querySelector('.what'), count: el.querySelector('.n'), body: el.querySelector('.steps-body'), n: 0 };
  return group;
}

// Once it starts talking again the working is finished — fold it away, unless
// you opened or closed it yourself.
function closeGroup() {
  if (!group) return;
  group.label.textContent = 'Used the computer';
  if (!group.box.dataset.touched) {
    group.box.classList.remove('open');
    group.head.setAttribute('aria-expanded', 'false');
  }
  const last = group.body.querySelector('.step.now');
  if (last) last.classList.remove('now');
  group = null;
  stepsRec = null;
}

/* ── the rehearsal plan ──────────────────────────────────────────────
 * A dry run collects every step the agent WOULD have taken into one card,
 * calls out the ones that are hard to undo, and offers to do it for real.
 */

function openPlan() {
  const el = turn('', '<div class="plan">' +
    '<div class="plan-head">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9 16.5 19 7"/><path d="M3 20h18"/></svg>' +
    '<span class="plan-title">Rehearsal — nothing was changed</span>' +
    '<span class="plan-n">0 steps</span></div>' +
    '<ol class="plan-steps"></ol>' +
    '<div class="plan-foot"></div></div>');

  plan = {
    steps: el.querySelector('.plan-steps'),
    count: el.querySelector('.plan-n'),
    foot: el.querySelector('.plan-foot'),
    n: 0,
    risky: 0,
  };
  return plan;
}

function addPlanStep(evt) {
  const p = plan || openPlan();
  p.n += 1;
  if (evt.risk) p.risky += 1;

  const stick = nearBottom();
  const li = document.createElement('li');
  li.className = 'plan-step' + (evt.risk ? ' risky' : '');
  li.innerHTML = '<span class="plan-what">' + esc(evt.text || evt.name) + '</span>' +
    (evt.risk ? '<span class="plan-risk">' + esc(evt.risk) + '</span>' : '');
  p.steps.appendChild(li);
  p.count.textContent = p.n + (p.n === 1 ? ' step' : ' steps');
  if (stick) thread.scrollTop = thread.scrollHeight;
}

// Close the card and offer the real run. The task is replayed from what was
// asked, so the button does exactly what was rehearsed.
function finishPlan() {
  if (!plan) return;
  const p = plan;
  plan = null;

  if (p.risky) {
    const warn = document.createElement('div');
    warn.className = 'plan-warn';
    warn.textContent = p.risky + (p.risky === 1 ? ' step is' : ' steps are') +
      ' hard to undo — worth a read before you run it.';
    p.foot.appendChild(warn);
  }

  const task = lastTask;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'pill solid';
  go.textContent = 'Run it for real';
  go.addEventListener('click', () => {
    if (busy) return;
    if (dryRun && dryBtn) dryBtn.click();   // drop out of rehearsal first
    go.disabled = true;
    run(task);
  });
  p.foot.appendChild(go);
}

// Pure rendering, shared by a live run and by a chat read back from disk.
function addStepRow(g, name, a, at, current) {
  const prev = g.body.querySelector('.step.now');
  if (prev) prev.classList.remove('now');

  const row = document.createElement('div');
  row.className = 'step' + (current ? ' now' : '');
  row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + iconFor(name) + '</svg>' +
    '<span class="what">' + describeAction(name, a) + '</span>' +
    '<span class="at">' + esc(at) + '</span>';
  g.body.appendChild(row);

  g.n += 1;
  g.count.textContent = g.n + (g.n === 1 ? ' step' : ' steps');
}

function addStep(name, a) {
  const g = group || openGroup();
  const stick = nearBottom();
  const at = clock(Date.now() - startedAt);

  addStepRow(g, name, a, at, true);

  if (!stepsRec) { stepsRec = { k: 'steps', items: [] }; rec(stepsRec); }
  stepsRec.items.push({ name, input: a, at });
  save();

  if (stick) thread.scrollTop = thread.scrollHeight;
}

/* ── bots ────────────────────────────────────────────────────────── */

const rail = document.getElementById('rail');
const historyBtn = document.getElementById('historyBtn');
const newBotBtn = document.getElementById('newBotBtn');
const newChatBtn = document.getElementById('newChatBtn');
const rosterEl = document.getElementById('roster');
const chatsEl = document.getElementById('chats');
const chatsFor = document.getElementById('chatsFor');
const whoBtn = document.getElementById('whoBtn');
const whoFace = document.getElementById('whoFace');
const whoName = document.getElementById('whoName');
const whoTitle = document.getElementById('whoTitle');

let bots = [];
let bot = null;        // the bot you are talking to
let chat = null;       // its open chat, or null until you say something
let stepsRec = null;
let saveTimer = null;

const RAIL_OPEN = 'operator.rail';
const LAST_BOT = 'operator.bot';

const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* fine */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/* what the bot's face is doing */

function botState() {
  if (!busy) return 'idle';
  return live ? 'thinking' : 'working';
}

function paintFaces() {
  const state = botState();
  if (bot) {
    whoFace.innerHTML = '';
    whoFace.appendChild(Avatar.el(bot.face, 28, state));
    whoName.textContent = bot.name;
    whoTitle.textContent = bot.title || '';

    // you are talking to a particular bot, so say its name
    input.placeholder = 'Give ' + bot.name + ' a task';
    const h1 = document.querySelector('.intro h1');
    if (h1) h1.textContent = 'What should ' + bot.name + ' do?';
  }
  rosterEl.querySelectorAll('.bot-row').forEach((row) => {
    const av = row.querySelector('.av');
    if (!av) return;
    const mine = bot && row.dataset.id === bot.id;
    av.className = 'av ' + (mine ? state : 'idle');
  });
}

/* recording the open chat */

function rec(record) {
  if (!chat || chat.theirs) return;
  chat.turns.push(record);
  save();
}

function save() {
  if (!chat || !bot) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.operator.saveChat(bot.id, chat.id, { title: chat.title, turns: chat.turns });
    listChats();
    loadBots();
  }, 400);
}

async function ensureChat() {
  if (chat) return chat;
  const made = await window.operator.createChat(bot.id);
  chat = { id: made.id, title: made.title, turns: [] };
  return chat;
}

/* the roster */

async function loadBots(select) {
  bots = await window.operator.listBots();
  if (!bots.length) return;

  const wanted = select || (bot && bot.id) || recall(LAST_BOT);
  const found = bots.find((b) => b.id === wanted) || bots[0];
  if (!bot || bot.id !== found.id) bot = found;
  else Object.assign(bot, found);

  keep(LAST_BOT, bot.id);
  paintRoster();
  paintFaces();
}

function paintRoster() {
  rosterEl.textContent = '';
  for (const b of bots) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bot-row' + (bot && b.id === bot.id ? ' on' : '');
    row.dataset.id = b.id;

    row.appendChild(Avatar.el(b.face, 26, 'idle'));

    const text = document.createElement('span');
    text.className = 'bot-text';
    const name = document.createElement('span');
    name.className = 'bot-name';
    name.textContent = b.name;
    const line = document.createElement('span');
    line.className = 'bot-line';
    line.textContent = b.lastLine || b.title || 'Nothing yet';
    text.append(name, line);

    row.appendChild(text);
    row.addEventListener('click', () => switchBot(b.id));
    rosterEl.appendChild(row);
  }
}

async function switchBot(botId) {
  if (bot && bot.id === botId) return;
  if (busy) window.operator.stopTask();
  chat = null;
  clearThread();
  await loadBots(botId);
  await listChats();
  input.focus();
}

/* that bot's chats */

const BIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V5.5h5V7M6.5 7l.8 12h9.4l.8-12"/></svg>';

async function listChats() {
  if (!bot) return;
  chatsFor.textContent = 'Chats';
  const rows = await window.operator.listChats(bot.id);
  chatsEl.textContent = '';

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'chats-empty';
    p.textContent = 'Nothing yet.';
    chatsEl.appendChild(p);
    return;
  }

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (chat && chat.id === r.id ? ' on' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    open.textContent = r.title;
    open.title = r.title;
    open.addEventListener('click', () => openChat(r.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-del';
    del.title = 'Delete chat';
    del.setAttribute('aria-label', 'Delete ' + r.title);
    del.innerHTML = BIN;
    del.addEventListener('click', (e) => { e.stopPropagation(); removeChat(r.id); });

    row.append(open, del);
    chatsEl.appendChild(row);
  }
}

// Replays a stored transcript. Screenshots are not kept, so the computer pane
// stays shut until this chat looks at something again.
function replay(turns) {
  for (const t of turns) {
    if (t.k === 'you') turn('you', '<span>' + youHtml(t.text) + '</span>');
    else if (t.k === 'says') turn('says', nl2br(t.text));
    else if (t.k === 'error') turn('', '<div class="error"><b>Stopped</b><span>' + esc(t.text) + '</span></div>');
    else if (t.k === 'note') turn('', noteCard(t.text));
    else if (t.k === 'routine') turn('', routineCard(t.text));
    else if (t.k === 'steps') {
      const g = openGroup();
      for (const it of t.items) addStepRow(g, it.name, it.input || {}, it.at || '', false);
      closeGroup();
    }
  }
  thread.scrollTop = thread.scrollHeight;
}

function clearThread() {
  thread.querySelectorAll('.turn').forEach((el) => el.remove());
  group = null;
  stepsRec = null;
  live = null;
  hasFrame = false;
  frame.removeAttribute('src');
  surfaceEl.textContent = '';
  computerEl.hidden = true;
  document.body.classList.remove('started', 'has-screen');
}

// A routine's transcript is written by main. Once it finishes, load what was
// written so the renderer owns it again and a follow-up appends to it.
async function adopt(botId, chatId) {
  const full = await window.operator.getChat(botId || (bot && bot.id), chatId);
  if (!full || !chat || chat.id !== chatId) return;
  chat = { id: full.id, title: full.title, turns: full.turns || [] };
  listChats();
  loadBots();
}

async function openChat(id) {
  if (chat && chat.id === id) return;
  if (busy) window.operator.stopTask();

  const full = await window.operator.getChat(bot.id, id);
  if (!full) { listChats(); return; }

  clearThread();
  chat = { id: full.id, title: full.title, turns: full.turns || [] };
  if (chat.turns.length) document.body.classList.add('started');
  replay(chat.turns);
  listChats();
  input.focus();
}

async function removeChat(id) {
  await window.operator.deleteChat(bot.id, id);
  if (chat && chat.id === id) { chat = null; clearThread(); }
  listChats();
  loadBots();
}

function newChat() {
  if (busy) window.operator.stopTask();
  chat = null;
  clearThread();
  input.value = '';
  resize();
  listChats();
  input.focus();
}

newChatBtn.addEventListener('click', newChat);

newBotBtn.addEventListener('click', async () => {
  const made = await window.operator.createBot({ name: 'New bot', title: '' });
  if (!made) return;
  chat = null;
  clearThread();
  await loadBots(made.id);
  await listChats();
  openSheet(true);
});

/* the rail opens and closes */

function setRail(open) {
  rail.classList.toggle('open', open);
  historyBtn.setAttribute('aria-expanded', String(open));
  historyBtn.title = open ? 'Hide bots' : 'Show bots';
  keep(RAIL_OPEN, open ? '1' : '0');
}

historyBtn.addEventListener('click', () => setRail(!rail.classList.contains('open')));

// Opens the browser the agent uses, so you can log in to a site yourself once
// and have it stay logged in for every task after.
document.getElementById('browserBtn').addEventListener('click', async () => {
  const res = await window.operator.openBrowser();
  if (!res.ok) {
    turn('', '<div class="error"><b>Browser</b><span>' + esc(res.error) + '</span></div>');
    document.body.classList.add('started');
  }
});

/* ── the bot panel ───────────────────────────────────────────────── */

const sheet = document.getElementById('sheet');
const sheetFace = document.getElementById('sheetFace');
const sheetTitle = document.getElementById('sheetTitle');
const fName = document.getElementById('fName');
const fTitle = document.getElementById('fTitle');
const fPersona = document.getElementById('fPersona');
const fModel = document.getElementById('fModel');
const fFaces = document.getElementById('fFaces');
const fMemory = document.getElementById('fMemory');
const fRoutines = document.getElementById('fRoutines');
const botSkills = document.getElementById('botSkills');

const SHAPES = ['squircle', 'round', 'dome', 'shield'];
const ACCESSORIES = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
const HUES = [199, 262, 152, 24, 341, 44, 288, 174];

const EVERY = {
  min5: 'Every 5 minutes', min15: 'Every 15 minutes', min30: 'Every 30 minutes',
  hour: 'Every hour', day: 'Every day', weekday: 'Weekdays', week: 'Mondays',
};
// these repeat from the last run, so a time of day means nothing for them
const SPACED = new Set(['min5', 'min15', 'min30', 'hour']);

function noteCard(text) {
  return '<div class="event"><svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20l1-6L3.4 9.9l6-.9Z"/></svg>' +
    '<span>Remembered <b>' + esc(text) + '</b></span></div>';
}

function routineCard(name) {
  return '<div class="event"><svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.2 1.9"/></svg>' +
    '<span>Routine <b>' + esc(name) + '</b> started this</span></div>';
}

const when = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function dropBtn(onClick, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'drop';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = BIN;
  b.addEventListener('click', onClick);
  return b;
}

function emptyNote(el, text) {
  const p = document.createElement('p');
  p.className = 'notes-empty';
  p.textContent = text;
  el.appendChild(p);
}

async function paintSheet() {
  const full = await window.operator.getBot(bot.id);
  if (!full) return;

  sheetFace.innerHTML = '';
  sheetFace.appendChild(Avatar.el(full.face, 30, 'idle'));
  sheetTitle.textContent = full.name;
  fName.value = full.name;
  fTitle.value = full.title || '';
  fPersona.value = full.persona || '';

  // model: the app default, or one pinned to this bot
  fModel.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Whatever is picked in the bar';
  fModel.appendChild(auto);
  // Grouped by whose model it is — a flat list of a hundred is unusable.
  let group = null;
  let holder = fModel;
  for (const m of models) {
    if (m.providerName !== group) {
      group = m.providerName;
      holder = document.createElement('optgroup');
      holder.label = m.vendor !== 'nvidia' ? group
        : group === 'NVIDIA' ? 'NVIDIA NIM'
        : `${group} · NVIDIA NIM`;
      fModel.appendChild(holder);
    }
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    holder.appendChild(o);
  }
  fModel.value = full.model || '';

  // faces: one row of shapes, one of accessories, one of hues
  fFaces.textContent = '';
  const variants = [];
  for (const shape of SHAPES) variants.push({ ...full.face, shape });
  for (const accessory of ACCESSORIES) variants.push({ ...full.face, accessory });
  for (const hue of HUES) variants.push({ ...full.face, hue });

  for (const face of variants) {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'face-pick' +
      (face.shape === full.face.shape && face.accessory === full.face.accessory && face.hue === full.face.hue ? ' on' : '');
    pick.appendChild(Avatar.el(face, 26, 'idle'));
    pick.addEventListener('click', async () => {
      await window.operator.updateBot(bot.id, { face });
      await loadBots(bot.id);
      paintSheet();
    });
    fFaces.appendChild(pick);
  }

  // memory
  fMemory.textContent = '';
  if (!full.memory.length) emptyNote(fMemory, 'Nothing yet. It will keep things as you work, or you can tell it something.');
  for (const m of full.memory) {
    const row = document.createElement('div');
    row.className = 'note';
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = m.text;
    const stamp = document.createElement('span');
    stamp.className = 'when';
    stamp.textContent = when(m.at);
    body.appendChild(stamp);
    row.append(body, dropBtn(async () => {
      await window.operator.forgetNote(bot.id, m.id);
      paintSheet();
      loadBots();
    }, 'Forget this'));
    fMemory.appendChild(row);
  }

  // routines
  fRoutines.textContent = '';
  if (!full.routines.length) emptyNote(fRoutines, 'Nothing standing. Give it a job it should do without being asked.');
  for (const r of full.routines) {
    const row = document.createElement('div');
    row.className = 'note' + (r.paused ? ' off' : '');
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = r.name;
    const stamp = document.createElement('span');
    stamp.className = 'when';
    stamp.textContent = (EVERY[r.every] || r.every) + (SPACED.has(r.every) ? '' : ' at ' + r.at) +
      (r.paused ? ' · paused' : r.lastRun ? ' · last ran ' + when(r.lastRun) : ' · not yet run');
    body.appendChild(stamp);

    // Waiting until tomorrow morning is a poor way to find out it works.
    const now = document.createElement('button');
    now.type = 'button';
    now.className = 'mini';
    now.textContent = 'Run now';
    now.addEventListener('click', async () => {
      now.disabled = true;
      const res = await window.operator.runRoutine(bot.id, r.id);
      if (!res.ok) { now.textContent = res.error; setTimeout(() => { now.textContent = 'Run now'; now.disabled = false; }, 2200); return; }
      closeSheet();
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mini';
    toggle.textContent = r.paused ? 'Resume' : 'Pause';
    toggle.addEventListener('click', async () => {
      await window.operator.updateRoutine(bot.id, r.id, { paused: !r.paused });
      paintSheet();
      loadBots();
    });

    row.append(body, now, toggle, dropBtn(async () => {
      await window.operator.removeRoutine(bot.id, r.id);
      paintSheet();
      loadBots();
    }, 'Delete routine'));
    fRoutines.appendChild(row);
  }

  // always-on skills: which library skills are switched on for this bot
  renderBotSkills(full);
}

// A checklist of the skill library; ticking one keeps it always on for the bot.
async function renderBotSkills(full) {
  botSkills.textContent = '';
  let lib = [];
  try { lib = await window.operator.skillsList(); } catch (_) {}
  if (!lib.length) { emptyNote(botSkills, 'No skills yet — make one in Settings → Skills.'); return; }
  const on = new Set((full.skills || []).filter((x) => typeof x === 'string'));
  for (const s of lib) {
    const row = document.createElement('label');
    row.className = 'skill-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on.has(s.id);
    cb.addEventListener('change', async () => {
      if (cb.checked) await window.operator.attachSkill(bot.id, s.id);
      else await window.operator.detachSkill(bot.id, s.id);
      loadBots(bot.id);
    });
    const text = document.createElement('span');
    text.className = 'skill-toggle-text';
    text.innerHTML = '<span class="skt-name">/' + esc(s.name) + '</span>' +
      (s.title ? '<span class="skt-title">' + esc(s.title) + '</span>' : '');
    row.append(cb, text);
    botSkills.appendChild(row);
  }
}

const sheetDone = document.getElementById('sheetDone');

function openSheet(isNew) {
  sheet.hidden = false;
  sheetDone.textContent = isNew ? 'Create bot' : 'Done';
  paintSheet();
  setTimeout(() => fName.focus(), 40);
}

// Text still sitting in one of the add rows is something you meant to keep, so
// closing commits it rather than throwing it away. Losing a routine you had
// just typed was the single easiest mistake to make in this panel.
async function commitPending() {
  if (!bot) return;

  const memText = document.getElementById('memText');
  if (memText.value.trim()) {
    await window.operator.rememberNote(bot.id, memText.value.trim());
    memText.value = '';
  }

  const routText = document.getElementById('routText');
  if (routText.value.trim()) {
    await window.operator.addRoutine(bot.id, {
      name: routText.value.trim().slice(0, 50),
      prompt: routText.value.trim(),
      every: routEvery.value,
      at: routAt.value,
    });
    routText.value = '';
  }

  await pushField();
}

async function closeSheet() {
  await commitPending();
  sheet.hidden = true;
  loadBots();
}

whoBtn.addEventListener('click', () => openSheet(false));
sheetDone.addEventListener('click', closeSheet);
document.getElementById('sheetClose').addEventListener('click', closeSheet);
document.getElementById('sheetScrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

// The text fields save as you leave them rather than on every keystroke.
const pushField = async () => {
  if (!bot) return;
  await window.operator.updateBot(bot.id, {
    name: fName.value,
    title: fTitle.value,
    persona: fPersona.value,
    model: fModel.value || null,
  });
  await loadBots(bot.id);
  sheetTitle.textContent = fName.value.trim() || 'Bot';
};

[fName, fTitle, fPersona].forEach((el) => el.addEventListener('change', pushField));
fModel.addEventListener('change', pushField);

document.getElementById('memForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = document.getElementById('memText');
  if (!el.value.trim()) return;
  await window.operator.rememberNote(bot.id, el.value.trim());
  el.value = '';
  paintSheet();
  loadBots();
});


const routEvery = document.getElementById('routEvery');
const routAt = document.getElementById('routAt');
const paintRoutAt = () => { routAt.disabled = SPACED.has(routEvery.value); };
routEvery.addEventListener('change', paintRoutAt);
paintRoutAt();

document.getElementById('routForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = document.getElementById('routText');
  if (!el.value.trim()) return;
  await window.operator.addRoutine(bot.id, {
    name: el.value.trim().slice(0, 50),
    prompt: el.value.trim(),
    every: document.getElementById('routEvery').value,
    at: document.getElementById('routAt').value,
  });
  el.value = '';
  paintSheet();
  loadBots();
});

document.getElementById('deleteBot').addEventListener('click', async () => {
  if (!bot) return;
  await window.operator.deleteBot(bot.id);
  closeSheet();
  chat = null;
  clearThread();
  bot = null;
  await loadBots();
  await listChats();
});

// A routine that fired while you were elsewhere changes the roster under you.
window.operator.onBotsChanged(() => { loadBots(); listChats(); });


/* ── "it is working" dots ────────────────────────────────────────── */

const dots = document.createElement('div');
dots.className = 'turn dots-turn';
dots.innerHTML = '<div class="dots" role="status" aria-label="Operator is working"><i></i><i></i><i></i></div>';

function showDots() {
  if (!busy || dots.isConnected) return;
  const stick = nearBottom();
  thread.appendChild(dots);
  if (stick) thread.scrollTop = thread.scrollHeight;
}

function hideDots() {
  if (dots.isConnected) dots.remove();
}

/* ── events ──────────────────────────────────────────────────────── */

// The reply being typed right now, if any.
let live = null;

window.operator.onEvent((evt) => {
  // The machine runs one task at a time, but it may not be the one you are
  // reading. Status and the live screen are about the computer, so they always
  // apply; everything else belongs to a particular chat.
  const mine = !evt.chatId || (chat && evt.chatId === chat.id);

  if (evt.type === 'status') {
    if (evt.text === 'running') { if (!busy) startRun(); }
    else if (evt.text === 'idle') {
      if (busy) endRun();
      // pick the finished transcript back up so a follow-up carries on from it
      if (chat && chat.theirs && evt.chatId === chat.id) adopt(evt.botId, chat.id);
    }
    return;
  }

  // One bot messaging another — shown as a small aside in the transcript so the
  // hand-off is visible, not hidden inside a tool call.
  if (evt.type === 'teammate') {
    if (mine) turn('teammate', '<span class="tm-arrow">→</span> asked <b>' + esc(evt.to) + '</b>: ' + esc(trim(evt.message, 120)));
    return;
  }
  if (evt.type === 'teammate_reply') {
    if (mine) turn('teammate reply', '<span class="tm-arrow">←</span> <b>' + esc(evt.from) + '</b>: ' + esc(trim(evt.reply, 200)));
    return;
  }

  if (evt.type === 'screenshot') {
    hasFrame = true;
    document.body.classList.add('has-screen');
    computerEl.hidden = false;
    frame.src = 'data:' + (evt.mime || 'image/png') + ';base64,' + evt.b64;
    if (evt.label) surfaceEl.textContent = evt.label.replace(/^https?:\/\//, '');
    // Feed the same frame straight to the full-screen view when it is open, so
    // an agent action shows there instantly without waiting for the next poll.
    if (window.__watchOpen && window.__watchFrame) {
      window.__watchFrame.src = frame.src;
      if (evt.label && window.__watchLabel) window.__watchLabel.textContent = evt.label.replace(/^https?:\/\//, '');
    }
    return;
  }

  if (evt.type === 'routine') {
    if (bot && evt.botId === bot.id) {
      // follow the work rather than leaving you staring at an unchanged screen
      clearThread();
      // main writes this transcript, so the renderer only displays it
      chat = { id: evt.chatId, title: evt.name, turns: [], theirs: true };
      document.body.classList.add('started');
      turn('', routineCard(evt.name));
      listChats();
    } else {
      loadBots();
    }
    return;
  }

  if (!mine) return;

  switch (evt.type) {
    case 'remember':
      closeGroup();
      hideDots();
      turn('', noteCard(evt.text));
      rec({ k: 'note', text: evt.text });
      showDots();
      break;

    // ── streamed reply ──────────────────────────────────────────
    case 'say_start':
      closeGroup();
      hideDots();
      live = { raw: '', el: turn('says live', '') };
      break;

    case 'say_delta': {
      if (!live) break;
      const stick = nearBottom();
      live.raw += evt.text;
      // Append only the new token — rebuilding the whole innerHTML each token is
      // O(n²) and freezes the UI on a long reply.
      const parts = String(evt.text).split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) live.el.appendChild(document.createElement('br'));
        if (parts[i]) live.el.appendChild(document.createTextNode(parts[i]));
      }
      if (stick) thread.scrollTop = thread.scrollHeight;
      break;
    }

    case 'say_end':
      if (live) {
        // Deltas already rendered the text; only rebuild if the final text
        // differs (a one-off O(n) is fine — the per-token rebuild was the problem).
        if (evt.text && evt.text !== live.raw) live.el.innerHTML = nl2br(evt.text);
        live.el.classList.remove('live');
        live = null;
      }
      rec({ k: 'says', text: evt.text });
      speak(evt.text);
      showDots();
      break;

    // Whole-message fallback, for anything that did not arrive as deltas.
    case 'assistant':
      closeGroup();
      hideDots();
      turn('says', nl2br(evt.text));
      rec({ k: 'says', text: evt.text });
      speak(evt.text);
      showDots();
      break;

    case 'tool':
      actionCount += 1;
      actionsEl.textContent = actionCount + (actionCount === 1 ? ' action' : ' actions');
      hideDots();
      addStep(evt.name, evt.input || {});
      showDots();
      break;

    // a step it WOULD have taken — rehearsal only, nothing happened
    case 'plan_step':
      hideDots();
      addPlanStep(evt);
      showDots();
      break;

    // text is null when the result just repeats what was already said
    case 'done':
      closeGroup();
      if (evt.text) { turn('says', nl2br(evt.text)); rec({ k: 'says', text: evt.text }); speak(evt.text); }
      finishPlan();
      endRun();
      break;

    case 'error':
      closeGroup();
      turn('', '<div class="error"><b>Stopped</b><span>' + esc(evt.text) + '</span></div>');
      rec({ k: 'error', text: evt.text });
      finishPlan();
      endRun();
      break;
  }
});

/* ── input ───────────────────────────────────────────────────────── */

function resize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 168) + 'px';
}

// Rehearse: plan the whole task without letting it change anything. Kept on the
// composer rather than in settings because it is a per-task decision.
const dryBtn = document.getElementById('dryBtn');
let dryRun = false;
if (dryBtn) {
  dryBtn.addEventListener('click', () => {
    dryRun = !dryRun;
    dryBtn.classList.toggle('on', dryRun);
    dryBtn.setAttribute('aria-pressed', String(dryRun));
    document.body.classList.toggle('rehearsing', dryRun);
    input.focus();
  });
}

async function run(override) {
  const task = (override !== undefined ? override : input.value).trim();
  if (!task || busy) return;

  await ensureChat();
  turn('you', '<span>' + youHtml(task) + '</span>');
  // the first thing you ask becomes the chat's name
  if (!chat.turns.length) chat.title = task.replace(/\s+/g, ' ').slice(0, 70);
  rec({ k: 'you', text: task });

  // Remembered so the plan card's "Run it for real" can replay the same task.
  lastTask = task;
  plan = null;

  if (override === undefined) { input.value = ''; resize(); }
  startRun();
  await window.operator.runTask(task, chosenModel, bot.id, chat.id, dryRun);
}

composer.addEventListener('submit', (e) => { e.preventDefault(); run(); });
// Stop is instant here, not when the backend gets round to confirming it: a
// tool already running can take a while to unwind, and watching a dead Stop
// button for ten seconds is the thing that made it feel broken.
stopBtn.addEventListener('click', () => {
  if (stopBtn.classList.contains('stopping')) return;
  stopBtn.classList.add('stopping');
  window.operator.stopTask();
  endRun();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
});
input.addEventListener('input', resize);


document.querySelectorAll('.chip').forEach((b) => {
  b.addEventListener('click', () => {
    input.value = b.textContent.trim();
    input.focus();
    resize();
  });
});

/* ── model picker ────────────────────────────────────────────────── */

const picker = document.getElementById('picker');
const pickerBtn = document.getElementById('pickerBtn');
const pickerName = document.getElementById('pickerName');
const menu = document.getElementById('menu');
const menuList = document.getElementById('menuList');
const menuSearch = document.getElementById('menuSearch');

const TICK = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const REMEMBERED = 'operator.model';

let models = [];
let chosenModel = null;
let nvidia = { configured: false };
let filter = '';

// The choice is a per-viewer convenience, so browser storage is the right home
// for it — but it can throw or come back empty, and the app must still work.
function remembered() {
  try { return localStorage.getItem(REMEMBERED); } catch { return null; }
}
function remember(id) {
  try { localStorage.setItem(REMEMBERED, id); } catch { /* not worth surfacing */ }
}

// A NIM model with no key saved would fail the moment you ran it, so picking
// one sends you to Settings instead of pretending.
const locked = (m) => m.vendor === 'nvidia' && !nvidia.configured;

function paintPicker() {
  const m = models.find((x) => x.id === chosenModel);
  // A remembered NIM id before the catalog has loaded still has a readable
  // name in it — better than the button saying "Model" for a second.
  pickerName.textContent = m ? m.name
    : chosenModel && chosenModel.startsWith('nim:') ? chosenModel.split('/').pop()
    : 'Model';
  // The label is clipped when the name is long, so the full one lives here.
  pickerBtn.title = m ? `${m.providerName} · ${m.note}` : 'Which model runs the task';
  menuList.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.dataset.id === chosenModel));
}

function choose(id) {
  chosenModel = id;
  remember(id);
  paintPicker();
  closeMenu();
  pickerBtn.focus();
}

// Every word you type has to match something — name, model id, vendor or a
// tag — so "meta vision" and "llama 70b" both land where you expect.
function matches(m) {
  if (!filter) return true;
  const hay = [m.name, m.id, m.note, m.providerName, ...(m.tags || [])].join(' ').toLowerCase();
  return filter.split(/\s+/).every((w) => hay.includes(w));
}

function label(text, extra) {
  const el = document.createElement('div');
  el.className = 'menu-label' + (extra ? ' ' + extra : '');
  el.textContent = text;
  return el;
}

function option(m) {
  const opt = document.createElement('button');
  opt.type = 'button';
  opt.className = 'opt' + (locked(m) ? ' locked' : '');
  opt.dataset.id = m.id;
  opt.setAttribute('role', 'option');

  const tags = (m.tags || []).map((t) =>
    '<span class="tag' + (t === 'no tool calling' ? ' warn' : '') + '">' + esc(t) + '</span>').join('');

  opt.innerHTML = TICK +
    '<span class="body"><span class="name">' + esc(m.name) + '</span>' +
    '<span class="note">' + esc(m.note) + tags + '</span></span>';

  opt.addEventListener('click', () => {
    if (locked(m)) { closeMenu(); window.__openSettings && window.__openSettings('models'); return; }
    choose(m.id);
  });
  return opt;
}

function buildMenu() {
  menuList.textContent = '';
  const shown = models.filter(matches);

  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'menu-empty';
    none.textContent = 'No model matches that.';
    menuList.appendChild(none);
    return;
  }

  let group = null;      // the provider whose header is already on screen
  let seenOlder = false;
  let saidNim = false;

  for (const m of shown) {
    if (m.providerName !== group) {
      group = m.providerName;
      seenOlder = false;
      menuList.appendChild(label(group, m.vendor === 'nvidia' ? 'via-nim' : ''));

      // One line, once, explaining where this whole half of the list comes
      // from — and what to do about it if there is no key yet.
      if (m.vendor === 'nvidia' && !saidNim) {
        saidNim = true;
        if (!nvidia.configured) {
          const cta = document.createElement('button');
          cta.type = 'button';
          cta.className = 'menu-cta';
          cta.textContent = 'Add an NVIDIA API key to use these →';
          cta.addEventListener('click', () => { closeMenu(); window.__openSettings && window.__openSettings('models'); });
          menuList.appendChild(cta);
        }
      }
    }

    if (m.older && !seenOlder) {
      seenOlder = true;
      menuList.appendChild(label('Earlier models'));
    }

    menuList.appendChild(option(m));
  }
}

function openMenu() {
  menu.hidden = false;
  picker.classList.add('open');
  pickerBtn.setAttribute('aria-expanded', 'true');
  // It opens upward, so its ceiling is the room above the button — not a
  // fraction of the viewport, which overflows in a short window.
  menu.style.maxHeight = Math.max(200, pickerBtn.getBoundingClientRect().top - 20) + 'px';

  // Open on a clean list, with the cursor in the search box: with a hundred
  // models the fastest way to the one you want is to type three letters of it.
  filter = '';
  menuSearch.value = '';
  buildMenu();
  paintPicker();
  menuSearch.focus();
  const on = menuList.querySelector('.opt.on');
  if (on) on.scrollIntoView({ block: 'center' });
}

function closeMenu() {
  menu.hidden = true;
  picker.classList.remove('open');
  pickerBtn.setAttribute('aria-expanded', 'false');
}

pickerBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));

menuSearch.addEventListener('input', () => {
  filter = menuSearch.value.trim().toLowerCase();
  buildMenu();
  paintPicker();
});

// Enter takes the top match, so searching and choosing is one movement.
menuSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = menuList.querySelector('.opt');
  if (first) first.click();
});

// Arrow keys walk the list, and walk back up into the search box.
menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const opts = [...menuList.querySelectorAll('.opt')];
  if (!opts.length) return;
  if (document.activeElement === menuSearch) {
    (e.key === 'ArrowDown' ? opts[0] : opts[opts.length - 1]).focus();
    return;
  }
  const i = opts.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
  if (next < 0) { menuSearch.focus(); return; }
  opts[next % opts.length].focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) { closeMenu(); pickerBtn.focus(); }
});

document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !picker.contains(e.target)) closeMenu();
});

// The NIM catalog is fetched from NVIDIA in the background, so the list can
// arrive after the window does. Reloading it keeps the picker honest — and
// saving a key in Settings calls this straight away.
async function loadModels() {
  const res = await window.operator.listModels();
  models = res.models || [];
  nvidia = res.nvidia || { configured: false };
  const saved = remembered();
  if (!chosenModel) chosenModel = models.some((m) => m.id === saved) ? saved : res.current;
  if (!menu.hidden) buildMenu();
  paintPicker();
}
window.__reloadModels = loadModels;
loadModels();

/* ── voice ───────────────────────────────────────────────────────── */

const micBtn = document.getElementById('micBtn');
const heardEl = document.getElementById('heard');

let voiceOn = false;       // the user has the mic switched on
let speaking = false;
let heardTimer = null;

function showHeard(text, sticky) {
  clearTimeout(heardTimer);
  heardEl.textContent = text;
  heardEl.classList.toggle('show', Boolean(text));
  if (text && !sticky) heardTimer = setTimeout(() => heardEl.classList.remove('show'), 2600);
}

function paintMic() {
  micBtn.classList.toggle('on', voiceOn && !speaking);
  micBtn.classList.toggle('speaking', speaking);
  micBtn.setAttribute('aria-pressed', String(voiceOn));
  micBtn.title = voiceOn ? 'Listening — click to stop' : 'Talk to Operator';
}

function voiceProblem(what, detail) {
  turn('', '<div class="error"><b>' + esc(what) + '</b><span>' + esc(detail || '') + '</span></div>');
}

async function setVoice(on) {
  if (on) {
    showHeard('Starting Whisper…', true);
    const warm = await window.operator.whisperWarm();
    if (!warm.ok) {
      showHeard('');
      voiceProblem('Voice', warm.error);
      return;
    }
    try {
      await MicListener.start({ onUtterance: heardSomething, onState: micLevel });
    } catch (err) {
      showHeard('');
      voiceProblem('Microphone', err.message);
      return;
    }
    voiceOn = true;
    showHeard('Listening…', true);
  } else {
    voiceOn = false;
    MicListener.stop();
    window.operator.voiceHush();
    showHeard('');
  }
  paintMic();
}

micBtn.addEventListener('click', () => setVoice(!voiceOn));

function micLevel({ speaking: talking }) {
  micBtn.classList.toggle('hearing', Boolean(talking));
}

// A misfire here starts a real task on a real computer, so a stray word should
// never be enough to trigger one.
function worthRunning(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2;
}

async function heardSomething(wav) {
  if (!voiceOn) return;
  // Anything captured while Operator is talking is Operator talking.
  if (speaking) return;

  showHeard('…', true);
  const res = await window.operator.whisperTranscribe(wav);

  if (!res.ok) {
    showHeard('');
    voiceProblem('Voice', res.error);
    return;
  }

  const text = (res.text || '').trim();
  if (!text) { showHeard('Listening…', true); return; }

  if (busy) { showHeard('heard "' + text + '" — busy, finish this first'); return; }
  if (!worthRunning(text)) { showHeard('heard "' + text + '" — too short to act on'); return; }

  showHeard('');
  input.value = text;
  resize();
  run();
}

window.operator.onVoice((evt) => {
  switch (evt.ev) {
    case 'whisper':
      if (evt.status === 'loading') showHeard(evt.detail, true);
      else if (evt.status === 'ready' && voiceOn) showHeard('Listening…', true);
      else if (evt.status === 'error' || evt.status === 'stopped') {
        showHeard('');
        voiceProblem('Whisper', evt.detail);
      }
      break;

    case 'spoke':
      speaking = false;
      // Drop whatever the microphone caught of our own voice.
      MicListener.discard();
      paintMic();
      if (voiceOn) showHeard('Listening…', true);
      break;

    case 'error':
      voiceProblem('Voice', evt.error);
      break;
  }
});

// Say it out loud only when the user is actually in a voice conversation.
//
// The final result usually repeats the last thing the assistant said, so track
// what we just read out — otherwise it says everything twice.
let lastSpoken = '';

function speak(text) {
  if (!voiceOn) return;
  const key = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key || key === lastSpoken) return;
  lastSpoken = key;
  speaking = true;
  MicListener.discard();
  paintMic();
  window.operator.voiceSay(text);
}

input.focus();

/* ── start ───────────────────────────────────────────────────────── */

(async () => {
  setRail(recall(RAIL_OPEN) === '1');
  await loadBots();
  await listChats();
  input.focus();
})();

/* ── watch full screen ─────────────────────────────────────────────── */

(() => {
  const expand = document.getElementById('expand');
  const watch = document.getElementById('watch');
  const watchFrameEl = document.getElementById('watchFrame');
  const watchLabelEl = document.getElementById('watchLabel');
  const watchLive = document.getElementById('watchLive');
  const watchFps = document.getElementById('watchFps');
  const watchClose = document.getElementById('watchClose');
  if (!expand || !watch) return;

  // Shared with the screenshot handler above so agent frames appear instantly.
  window.__watchFrame = watchFrameEl;
  window.__watchLabel = watchLabelEl;

  let fpsTimer = null;
  let frames = 0;

  // Pipelined, not on a fixed timer: the next grab fires the instant the last
  // frame arrives, so the frame rate is simply as fast as the round trip
  // allows instead of being capped at one a second. An Image() preload swaps
  // the picture only once it has decoded, so you never see a half-drawn frame.
  async function loop() {
    while (window.__watchOpen) {
      const t0 = performance.now();
      try {
        const r = await window.operator.grabScreen({ full: true });
        if (!window.__watchOpen) break;
        if (r && r.ok) {
          const src = 'data:' + (r.mime || 'image/jpeg') + ';base64,' + r.image;
          await new Promise((res) => {
            const im = new Image();
            im.onload = im.onerror = res;
            im.src = src;
          });
          if (!window.__watchOpen) break;
          watchFrameEl.src = src;
          if (r.label) watchLabelEl.textContent = r.label.replace(/^https?:\/\//, '');
          watchLive.classList.add('on');
          frames++;
        } else if (r && !r.ok) {
          watchLabelEl.textContent = r.error || 'could not read the screen';
          watchLive.classList.remove('on');
          await new Promise((res) => setTimeout(res, 500)); // back off on errors
        }
      } catch (_) {
        watchLive.classList.remove('on');
        await new Promise((res) => setTimeout(res, 500));
      }
      // A tiny floor so a very fast local link doesn't spin the CPU flat out.
      const spent = performance.now() - t0;
      if (spent < 40) await new Promise((res) => setTimeout(res, 40 - spent));
    }
  }

  function open() {
    window.__watchOpen = true;
    watch.hidden = false;
    const cur = document.getElementById('frame').src;
    if (cur) watchFrameEl.src = cur;
    watchLive.classList.add('on');
    frames = 0;
    fpsTimer = setInterval(() => {
      watchFps.textContent = frames + ' fps';
      frames = 0;
    }, 1000);
    loop();
  }

  function close() {
    window.__watchOpen = false;
    watch.hidden = true;
    clearInterval(fpsTimer);
    fpsTimer = null;
  }

  expand.addEventListener('click', open);
  watchClose.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.__watchOpen) close();
  });

  // When Operator is driving another machine, reveal the live pane straight away
  // (even before any task) so you can watch that computer whenever you like.
  (async () => {
    try {
      const st = await window.operator.remoteStatus();
      if (st && st.kind === 'remote') {
        document.body.classList.add('has-screen');
        const comp = document.getElementById('computer');
        if (comp) comp.hidden = false;
        const surface = document.getElementById('surface');
        if (surface && !surface.textContent) {
          surface.textContent = st.host ? 'Remote — ' + st.host : 'Remote machine';
        }
        // Seed one frame so the pane isn't blank.
        const r = await window.operator.grabScreen();
        if (r && r.ok) document.getElementById('frame').src = 'data:' + (r.mime || 'image/png') + ';base64,' + r.image;
      }
    } catch (_) {}
  })();
})();

/* ── settings: which computer Operator uses ────────────────────────── */

(() => {
  const btn = document.getElementById('settingsBtn');
  const sheet = document.getElementById('settingsSheet');
  const scrim = document.getElementById('settingsScrim');
  const close = document.getElementById('settingsClose');
  const badge = document.getElementById('targetBadge');
  const badgeText = document.getElementById('targetBadgeText');
  const optLocal = document.getElementById('targetLocal');
  const optRemote = document.getElementById('targetRemote');
  const form = document.getElementById('remoteForm');
  const urlInput = document.getElementById('remoteUrl');
  const tokenInput = document.getElementById('remoteToken');
  const testBtn = document.getElementById('remoteTest');
  const statusText = document.getElementById('remoteStatusText');
  const remoteName = document.getElementById('remoteName');
  const remoteSub = document.getElementById('remoteSub');
  const handsOff = document.getElementById('handsOff');
  if (!btn || !sheet) return;

  // "Work on its own desktop" — remembered across launches. On by default: the
  // agent gets a hidden desktop of its own so it never fights the user for the
  // mouse or keyboard. Only an explicit '0' counts as off; unset means on.
  const HO = 'operator.ownDesktop';
  function ownDesktopOn() { try { return localStorage.getItem(HO) !== '0'; } catch (_) { return true; } }
  async function applyOwnDesktop(on) {
    try { localStorage.setItem(HO, on ? '1' : '0'); } catch (_) {}
    try { await window.operator.setOwnDesktop(on); } catch (_) {}
  }
  if (handsOff) {
    handsOff.checked = ownDesktopOn();
    applyOwnDesktop(handsOff.checked); // push current state to the main process on load
    handsOff.addEventListener('change', () => applyOwnDesktop(handsOff.checked));
  }
  // Re-assert the choice on task start, in case the helper was restarted.
  window.__applyHandsOff = () => applyOwnDesktop(ownDesktopOn());

  const SAVE = 'operator.remote'; // {url, token, host}

  function saved() {
    try { return JSON.parse(localStorage.getItem(SAVE) || 'null'); } catch (_) { return null; }
  }
  function save(v) {
    try { v ? localStorage.setItem(SAVE, JSON.stringify(v)) : localStorage.removeItem(SAVE); } catch (_) {}
  }

  // Reflect the live target (from main) into the whole UI.
  function paint(status) {
    const remote = status && status.kind === 'remote';
    badge.classList.toggle('remote', remote);
    badgeText.textContent = remote ? (status.host || 'Remote computer') : 'This computer';
    optLocal.classList.toggle('active', !remote);
    optRemote.classList.toggle('active', remote);
    const s = saved();
    if (s && s.host) { remoteName.textContent = s.host; remoteSub.textContent = s.url; }
    if (remote && status.host) { remoteName.textContent = status.host; }
  }

  async function refresh() {
    try { paint(await window.operator.remoteStatus()); } catch (_) {}
  }

  function openSheet() {
    const s = saved();
    if (s) { urlInput.value = s.url || ''; tokenInput.value = s.token || ''; }
    statusText.textContent = '';
    statusText.className = 'remote-status';
    form.hidden = !document.getElementById('targetRemote').classList.contains('active') && !s;
    refresh();
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; }

  btn.addEventListener('click', openSheet);
  badge.addEventListener('click', openSheet);

  // The rest of the UI sends you here when a setting is what you actually
  // need — the model picker does it when there is no NVIDIA key yet.
  window.__openSettings = (tab) => {
    openSheet();
    const t = tab && document.querySelector('#settingsTabs .tab[data-tab="' + tab + '"]');
    if (t) t.click();
  };

  close.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  // Show the address/token fields when you pick "another computer".
  optRemote.addEventListener('click', () => { form.hidden = false; urlInput.focus(); });

  // Switch to this computer immediately.
  optLocal.addEventListener('click', async () => {
    await window.operator.remoteDisconnect();
    statusText.textContent = '';
    form.hidden = true;
    await refresh();
  });

  // Connect to the remote machine, and only switch if it actually answers.
  testBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    if (!url) { statusText.textContent = 'enter the address first'; statusText.className = 'remote-status bad'; return; }
    testBtn.disabled = true;
    statusText.textContent = 'connecting…';
    statusText.className = 'remote-status';
    try {
      const r = await window.operator.remoteConnect(url, token);
      if (r && r.ok) {
        save({ url, token, host: r.host || null });
        statusText.textContent = 'connected to ' + (r.host || 'the machine');
        statusText.className = 'remote-status ok';
        await refresh();
      } else {
        statusText.textContent = (r && r.error) || 'could not connect';
        statusText.className = 'remote-status bad';
      }
    } catch (err) {
      statusText.textContent = err.message;
      statusText.className = 'remote-status bad';
    } finally {
      testBtn.disabled = false;
    }
  });

  refresh();
})();

/* ── settings tabs + email connector ───────────────────────────────── */

(() => {
  const sheet = document.getElementById('settingsSheet');
  if (!sheet) return;
  const tabs = sheet.querySelectorAll('.tab');
  const panels = sheet.querySelectorAll('.tab-panel');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    if (t.dataset.tab === 'connectors') refreshConnectors();
    if (t.dataset.tab === 'models') refreshNvidia();
  }));

  /* ── NVIDIA NIM: the key, and what it unlocks ─────────────────── */

  const nvBox = document.getElementById('nvidiaProvider');
  const nvSub = document.getElementById('nvSub');
  const nvKey = document.getElementById('nvKey');
  const nvSave = document.getElementById('nvSave');
  const nvStatus = document.getElementById('nvStatus');
  const nvRemove = document.getElementById('nvDisconnect');
  const nvCatalog = document.getElementById('nvCatalog');
  const nvCheck = document.getElementById('nvCheck');
  const nvCheckRow = document.getElementById('nvCheckRow');
  const nvCheckHint = document.getElementById('nvCheckHint');
  const nvCheckStatus = document.getElementById('nvCheckStatus');

  const nvSay = (text, kind) => {
    nvStatus.textContent = text || '';
    nvStatus.className = 'remote-status' + (kind ? ' ' + kind : '');
  };

  // What the key can actually reach, counted by vendor — the honest answer to
  // "which providers do I get?", straight from NVIDIA's own catalog.
  async function paintCatalog(configured) {
    if (!nvCatalog) return;
    if (!configured) { nvCatalog.hidden = true; return; }
    try {
      const info = await window.operator.listModels();
      const nim = ((info && info.models) || []).filter((m) => m.vendor === 'nvidia');
      if (!nim.length) { nvCatalog.hidden = true; return; }

      const byProvider = new Map();
      for (const m of nim) byProvider.set(m.providerName, (byProvider.get(m.providerName) || 0) + 1);

      nvCatalog.innerHTML =
        '<div class="nv-count">' + nim.length + ' models from ' + byProvider.size + ' providers</div>' +
        '<div class="nv-chips">' +
        [...byProvider].map(([name, n]) =>
          '<span class="nv-chip">' + esc(name) + '<i>' + n + '</i></span>').join('') +
        '</div>';
      nvCatalog.hidden = false;
    } catch (_) {
      nvCatalog.hidden = true;
    }
  }

  async function refreshNvidia() {
    try {
      const s = await window.operator.nvidiaStatus();
      apply(s);
      paintCatalog(s.configured);
    } catch (_) {}
  }

  function apply(s) {
    const on = Boolean(s && s.configured);
    nvBox.classList.toggle('on', on);
    nvSub.textContent = on ? `Connected · key ${s.hint}` : 'Not connected';
    nvRemove.hidden = !on;
    nvKey.value = '';
    nvKey.placeholder = on ? 'Saved — paste a new key to replace it' : 'nvapi-…';
    // Only worth offering once there is a key to check it with.
    if (nvCheckRow) nvCheckRow.hidden = !on;
    if (nvCheckHint) nvCheckHint.hidden = !on;
  }

  nvSave.addEventListener('click', async () => {
    const key = nvKey.value.trim();
    if (!key) { nvSay('Paste a key first.', 'bad'); return; }
    nvSave.disabled = true;
    nvSay('Checking with NVIDIA…');
    try {
      const r = await window.operator.nvidiaSetKey(key);
      if (!r || !r.ok) { nvSay((r && r.error) || 'That did not work.', 'bad'); return; }
      apply(r.status);
      // The key is saved either way; a warning means the test call did not get
      // through, which is worth reading but not worth throwing the key away over.
      if (r.warning) nvSay('Saved, but the test call failed — try running a task. ' + r.warning, 'warn');
      else nvSay(`Saved — ${r.models} models listed. Run the check below to see which of them your key can actually run.`, 'ok');
      if (nvCheckStatus) { nvCheckStatus.textContent = ''; nvCheckStatus.className = 'remote-status'; }
      await paintCatalog(true);
      // The picker is built from this list, so refresh it while it is closed.
      if (window.__reloadModels) window.__reloadModels();
    } catch (err) {
      nvSay(err.message, 'bad');
    } finally {
      nvSave.disabled = false;
    }
  });

  nvKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nvSave.click(); } });

  nvRemove.addEventListener('click', async () => {
    const r = await window.operator.nvidiaSetKey('');
    apply(r && r.status);
    nvSay('Key removed.');
    nvCatalog.hidden = true;
    if (window.__reloadModels) window.__reloadModels();
  });

  // Finding out what the key can actually run. Slow, so it reports as it goes.
  if (nvCheck && window.operator.onNvidiaProgress) {
    window.operator.onNvidiaProgress((p) => {
      if (!p || p.finished) return;
      nvCheckStatus.textContent = `Checking… ${p.done} of ${p.total}`;
      nvCheckStatus.className = 'remote-status';
    });

    nvCheck.addEventListener('click', async () => {
      nvCheck.disabled = true;
      nvCheckStatus.textContent = 'Checking…';
      try {
        const r = await window.operator.nvidiaSweep();
        if (!r || !r.ok) {
          nvCheckStatus.textContent = (r && r.error) || 'That did not work.';
          nvCheckStatus.className = 'remote-status bad';
          return;
        }
        nvCheckStatus.textContent = `${r.available} of ${r.checked} models run on your key. The rest are out of the picker.`;
        nvCheckStatus.className = 'remote-status ok';
        await paintCatalog(true);
        if (window.__reloadModels) window.__reloadModels();
      } finally {
        nvCheck.disabled = false;
      }
    });
  }

  const conn = document.getElementById('emailConnector');
  const sub = document.getElementById('emailSub');
  const disconnectBtn = document.getElementById('emailDisconnect');
  const signinBox = document.getElementById('emailSignin');
  const accountBox = document.getElementById('emailAccount');
  const acctAvatar = document.getElementById('acctAvatar');
  const acctEmail = document.getElementById('acctEmail');
  const acctMeta = document.getElementById('acctMeta');

  // Google
  const gBtn = document.getElementById('googleSignIn');
  const gStatus = document.getElementById('googleStatus');
  const gSetupToggle = document.getElementById('googleSetupToggle');
  const gSetup = document.getElementById('googleSetup');
  const gClientId = document.getElementById('gClientId');
  const gClientSecret = document.getElementById('gClientSecret');
  const gSave = document.getElementById('gCredsSave');
  const gSaveStatus = document.getElementById('gCredsStatus');

  // App password
  const altToggle = document.getElementById('emailAltToggle');
  const form = document.getElementById('emailForm');
  const addr = document.getElementById('emailAddr');
  const pass = document.getElementById('emailPass');
  const connectBtn = document.getElementById('emailConnect');
  const status = document.getElementById('emailStatus');

  const note = (el, text, kind) => {
    el.textContent = text || '';
    el.hidden = !text;
    el.className = 'conn-note' + (kind ? ' ' + kind : '');
  };

  function reveal(panel, btn, on) {
    const open = on === undefined ? panel.hidden : on;
    panel.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  async function refreshConnectors() {
    try {
      const list = await window.operator.connectorsList();
      const em = (list || []).find((c) => c.id === 'email');
      const connected = Boolean(em && em.connected);
      conn.classList.toggle('on', connected);
      disconnectBtn.hidden = !connected;
      accountBox.hidden = !connected;
      signinBox.hidden = connected;
      if (connected) {
        sub.textContent = em.provider ? em.provider : 'Connected';
        acctEmail.textContent = em.email || '';
        acctAvatar.textContent = (em.email || '@').trim().charAt(0).toUpperCase();
        acctMeta.textContent = (em.provider || 'Email') + ' · agents can read and send';
      } else {
        sub.textContent = 'Not connected';
        // Open the key setup by default when there are no Google keys yet.
        try {
          const creds = await window.operator.googleGetCreds();
          if (creds && creds.clientId) gClientId.value = creds.clientId;
          if (!(creds && creds.configured)) reveal(gSetup, gSetupToggle, true);
        } catch (_) {}
      }
    } catch (_) {}
  }

  disconnectBtn.addEventListener('click', async () => {
    await window.operator.disconnectConnector('email');
    note(gStatus, '');
    await refreshConnectors();
  });

  gBtn.addEventListener('click', async () => {
    gBtn.disabled = true;
    note(gStatus, 'Opening Google in your browser…');
    try {
      const r = await window.operator.googleSignIn();
      if (r && r.ok) {
        note(gStatus, 'Signed in as ' + r.email, 'ok');
        await refreshConnectors();
      } else if (r && r.needCreds) {
        note(gStatus, 'Add your Google API keys first.', 'bad');
        reveal(gSetup, gSetupToggle, true);
        gClientId.focus();
      } else {
        note(gStatus, (r && r.error) || 'Sign-in failed', 'bad');
      }
    } catch (err) {
      note(gStatus, err.message, 'bad');
    } finally {
      gBtn.disabled = false;
    }
  });

  gSetupToggle.addEventListener('click', () => reveal(gSetup, gSetupToggle));

  gSave.addEventListener('click', async () => {
    const clientId = gClientId.value.trim();
    const clientSecret = gClientSecret.value.trim();
    if (!clientId || !clientSecret) { gSaveStatus.textContent = 'paste both keys'; gSaveStatus.className = 'remote-status bad'; return; }
    gSave.disabled = true;
    try {
      await window.operator.googleSetCreds({ clientId, clientSecret });
      gSaveStatus.textContent = 'saved';
      gSaveStatus.className = 'remote-status ok';
      reveal(gSetup, gSetupToggle, false);
      note(gStatus, 'Keys saved — now sign in with Google.', 'ok');
    } catch (err) {
      gSaveStatus.textContent = err.message;
      gSaveStatus.className = 'remote-status bad';
    } finally {
      gSave.disabled = false;
    }
  });

  altToggle.addEventListener('click', () => {
    reveal(form, altToggle);
    if (!form.hidden) addr.focus();
  });

  connectBtn.addEventListener('click', async () => {
    const email = addr.value.trim();
    const password = pass.value;
    if (!email || !password) { status.textContent = 'enter your email and app password'; status.className = 'remote-status bad'; return; }
    connectBtn.disabled = true;
    status.textContent = 'connecting…';
    status.className = 'remote-status';
    try {
      const r = await window.operator.connectEmail({ email, password });
      if (r && r.ok) {
        status.textContent = 'connected';
        status.className = 'remote-status ok';
        pass.value = '';
        await refreshConnectors();
      } else {
        status.textContent = (r && r.error) || 'could not connect';
        status.className = 'remote-status bad';
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = 'remote-status bad';
    } finally {
      connectBtn.disabled = false;
    }
  });
})();

/* ── skills: the library (Settings → Skills) + the /command menu ────── */

(() => {
  let skillCache = [];
  async function loadSkills() {
    try { skillCache = await window.operator.skillsList(); } catch (_) { skillCache = []; }
    return skillCache;
  }

  /* the editor in Settings → Skills */
  const listEl = document.getElementById('skillsList');
  const form = document.getElementById('skillEditor');
  const head = document.getElementById('skillEditorHead');
  const nameEl = document.getElementById('skName');
  const promptEl = document.getElementById('skPrompt');
  const saveBtn = document.getElementById('skSave');
  const cancelBtn = document.getElementById('skCancel');
  const statusEl = document.getElementById('skStatus');
  let editingId = null;

  function resetEditor() {
    editingId = null;
    nameEl.value = '';
    promptEl.value = '';
    head.textContent = 'New skill';
    saveBtn.textContent = 'Add skill';
    cancelBtn.hidden = true;
    statusEl.textContent = '';
    statusEl.className = 'remote-status';
  }

  function editSkill(s) {
    editingId = s.id;
    nameEl.value = s.name;
    promptEl.value = s.prompt;
    head.textContent = 'Edit skill';
    saveBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    nameEl.focus();
  }

  async function refreshSkills() {
    await loadSkills();
    if (!listEl) return;
    listEl.textContent = '';
    if (!skillCache.length) {
      const p = document.createElement('p');
      p.className = 'set-hint';
      p.textContent = 'No skills yet. Add your first one below.';
      listEl.appendChild(p);
      return;
    }
    for (const s of skillCache) {
      const row = document.createElement('div');
      row.className = 'skill-item';
      const text = document.createElement('div');
      text.className = 'skill-item-text';
      text.innerHTML = '<span class="skill-item-name">/' + esc(s.name) + '</span>' +
        (s.title ? '<span class="skill-item-title">' + esc(s.title) + '</span>' : '') +
        '<span class="skill-item-body">' + esc(s.prompt.slice(0, 120)) + (s.prompt.length > 120 ? '…' : '') + '</span>';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'pill ghost sm'; edit.textContent = 'Edit';
      edit.addEventListener('click', () => editSkill(s));
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'pill ghost sm'; del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await window.operator.deleteSkill(s.id);
        if (editingId === s.id) resetEditor();
        refreshSkills();
      });
      const acts = document.createElement('div'); acts.className = 'skill-item-acts';
      acts.append(edit, del);
      row.append(text, acts);
      listEl.appendChild(row);
    }
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameEl.value.trim();
      const prompt = promptEl.value.trim();
      if (!prompt) { statusEl.textContent = 'add what the skill should do'; statusEl.className = 'remote-status bad'; return; }
      saveBtn.disabled = true;
      try {
        const r = editingId
          ? await window.operator.updateSkill(editingId, { name, prompt })
          : await window.operator.createSkill({ name, prompt });
        if (r && r.ok) { resetEditor(); await refreshSkills(); }
        else { statusEl.textContent = (r && r.error) || 'could not save'; statusEl.className = 'remote-status bad'; }
      } catch (err) {
        statusEl.textContent = err.message; statusEl.className = 'remote-status bad';
      } finally {
        saveBtn.disabled = false;
      }
    });
    cancelBtn.addEventListener('click', resetEditor);
  }

  // Populate when the Skills tab is opened.
  document.querySelectorAll('#settingsTabs .tab').forEach((t) => {
    if (t.dataset.tab === 'skills') t.addEventListener('click', refreshSkills);
  });
  loadSkills();

  /* the /command menu in the composer */
  const menu = document.getElementById('slashMenu');
  const input = document.getElementById('input');
  let sel = -1;
  let matches = [];

  const partialOf = (v) => {
    const m = String(v).match(/^\/([a-z0-9_-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  };

  function hideMenu() { menu.hidden = true; sel = -1; matches = []; }

  function showMenu() {
    const partial = partialOf(input.value);
    if (partial === null || !skillCache.length) { hideMenu(); return; }
    matches = skillCache.filter((s) => s.name.startsWith(partial)).slice(0, 6);
    if (!matches.length) { hideMenu(); return; }
    sel = 0;
    menu.textContent = '';
    matches.forEach((s, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'slash-item' + (i === 0 ? ' on' : '');
      item.innerHTML = '<span class="slash-item-name">/' + esc(s.name) + '</span>' +
        (s.title ? '<span class="slash-item-title">' + esc(s.title) + '</span>' : '');
      item.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      menu.appendChild(item);
    });
    menu.hidden = false;
  }

  function paintSel() {
    [...menu.children].forEach((c, i) => c.classList.toggle('on', i === sel));
  }

  function pick(i) {
    const s = matches[i];
    if (!s) return;
    input.value = '/' + s.name + ' ';
    hideMenu();
    input.focus();
    input.dispatchEvent(new Event('input'));
  }

  input.addEventListener('input', () => { if (!skillCache.length) loadSkills().then(showMenu); else showMenu(); });
  input.addEventListener('focus', showMenu);
  input.addEventListener('blur', () => setTimeout(hideMenu, 120));

  // Run before the composer's own Enter handler so a menu choice doesn't send.
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % matches.length; paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; paintSel(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); hideMenu(); }
  }, true);
})();

/* ── mode switch + code workspace (ChatGPT-style history) ──────────── */

(() => {
  const modes = document.querySelectorAll('.mode');
  const shell = document.querySelector('.shell');
  const codeView = document.getElementById('codeView');
  if (!codeView) return;

  modes.forEach((m) => m.addEventListener('click', () => {
    modes.forEach((x) => x.classList.toggle('active', x === m));
    const isCode = m.dataset.mode === 'code';
    shell.hidden = isCode;
    codeView.hidden = !isCode;
    // Ask what is still running before painting the list, so a chat that has
    // been building away while you were on the Agents side shows it.
    if (isCode) { syncRunning().then(loadHistory); loadModels(); loadBotChoices().then(paintBot); }
  }));

  const newBtn = document.getElementById('codeNewChat');
  const history = document.getElementById('codeHistory');
  const thread = document.getElementById('codeThread');
  const intro = document.getElementById('codeIntro');
  const composer = document.getElementById('codeComposer');
  const input = document.getElementById('codeInput');
  const runBtn = document.getElementById('codeRun');
  const stopBtn = document.getElementById('codeStop');
  const folderBtn = document.getElementById('codeFolderBtn');
  const cwdLabel = document.getElementById('codeCwd');
  const pickerBtn = document.getElementById('codePickerBtn');
  const pickerName = document.getElementById('codePickerName');
  const menu = document.getElementById('codeMenu');

  let chat = null;
  // Which chats are mid-run, not whether "the coding side" is busy — several
  // can be working at once and the buttons belong to whichever one you are
  // looking at.
  const running = new Set();
  let group = null;
  let models = [];

  const esc2 = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The main process is the authority on what is running; the window may have
  // been reloaded, or opened on the Agents side while a build carried on here.
  async function syncRunning() {
    try {
      const ids = (await window.operator.codeRunningChats()) || [];
      running.clear();
      ids.forEach((id) => running.add(id));
    } catch (_) { /* older preload; the events will fill it in */ }
    paintBusy();
  }

  async function loadHistory() {
    const list = await window.operator.codeChatsList();
    if (!list.length) { history.innerHTML = '<p class="code-history-empty">No chats yet.</p>'; return; }
    history.innerHTML = '';
    list.forEach((c) => {
      const row = document.createElement('div');
      const working = running.has(c.id);
      row.className = 'code-chat-row' + (chat && c.id === chat.id ? ' on' : '') + (working ? ' working' : '');
      row.innerHTML =
        '<button class="code-chat-open" type="button">' +
        '<span class="code-chat-title">' + esc2(c.title || 'New chat') + '</span>' +
        (c.cwdName ? '<span class="code-chat-folder">' + esc2(c.cwdName) + '</span>' : '') +
        '</button>' +
        // A chat working away in the background says so here, since its own
        // transcript is not on screen.
        (working ? '<span class="code-chat-spin" title="Working"></span>' : '') +
        '<button class="code-chat-del" type="button" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>';
      row.querySelector('.code-chat-open').addEventListener('click', () => openChat(c.id));
      row.querySelector('.code-chat-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.operator.codeChatDelete(c.id);
        if (chat && chat.id === c.id) { chat = null; clearThread(); }
        loadHistory();
      });
      history.appendChild(row);
    });
  }

  async function openChat(id) {
    chat = await window.operator.codeChatGet(id);
    if (!chat) return;
    paintFolder();
    paintModel();
    paintBot();
    renderChat();
    paintBusy();
    loadHistory();
  }

  newBtn.addEventListener('click', async () => {
    chat = await window.operator.codeChatCreate();
    clearThread();
    paintFolder();
    paintModel();
    paintBot();
    paintBusy();
    loadHistory();
    input.focus();
  });

  function paintFolder() {
    const name = chat && chat.cwdName;
    cwdLabel.textContent = name || 'Choose folder';
    folderBtn.classList.toggle('set', Boolean(name));
    folderBtn.title = chat && chat.cwd ? chat.cwd : 'Choose the project folder';
  }

  folderBtn.addEventListener('click', async () => {
    if (!chat) { chat = await window.operator.codeChatCreate(); loadHistory(); }
    const r = await window.operator.codePickFolder(chat.id);
    if (r && r.ok) { chat.cwd = r.cwd; chat.cwdName = r.name; paintFolder(); loadHistory(); }
  });

  // The same list the agent side offers — Claude through the Agent SDK, and
  // every NIM model through the toolset code.js builds for them. A model that
  // cannot call tools cannot edit files either, so it is flagged the same way.
  const codeList = document.getElementById('codeMenuList');
  const codeSearch = document.getElementById('codeMenuSearch');
  let codeFilter = '';

  async function loadModels() {
    if (models.length) return;
    try {
      const info = await window.operator.listModels();
      models = (info && info.models) || [];
      buildCodeMenu();
    } catch (_) {}
  }

  function buildCodeMenu() {
    const shown = models.filter((m) => {
      if (!codeFilter) return true;
      const hay = [m.name, m.id, m.note, m.providerName, ...(m.tags || [])].join(' ').toLowerCase();
      return codeFilter.split(/\s+/).every((w) => hay.includes(w));
    });

    if (!shown.length) {
      codeList.innerHTML = '<div class="menu-empty">No model matches that.</div>';
      return;
    }

    let group = null;
    let html = '';
    for (const m of shown) {
      if (m.providerName !== group) {
        group = m.providerName;
        html += '<div class="menu-label' + (m.vendor === 'nvidia' ? ' via-nim' : '') + '">' + esc2(group) + '</div>';
      }
      const tags = (m.tags || []).map((t) =>
        '<span class="tag' + (t === 'no tool calling' ? ' warn' : '') + '">' + esc2(t) + '</span>').join('');
      // Same markup as the agent picker, so the two menus share their styling
      // instead of drifting apart.
      html += '<button class="opt" type="button" role="option" data-id="' + m.id + '">' +
        '<span class="body"><span class="name">' + esc2(m.name) + '</span>' +
        '<span class="note">' + esc2(m.note || '') + tags + '</span></span></button>';
    }
    codeList.innerHTML = html;

    codeList.querySelectorAll('.opt').forEach((o) => o.addEventListener('click', async () => {
      const mid = o.dataset.id;
      if (chat) { chat.model = mid; await window.operator.codeSetModel(chat.id, mid); }
      paintModel();
      hideMenu();
    }));
  }

  if (codeSearch) {
    codeSearch.addEventListener('input', () => {
      codeFilter = codeSearch.value.trim().toLowerCase();
      buildCodeMenu();
    });
  }

  function paintModel() {
    const mid = (chat && chat.model) || (models[0] && models[0].id);
    const m = models.find((x) => x.id === mid) || models[0];
    if (m) pickerName.textContent = m.name;
  }

  /* ── code as one of your bots ── */

  const botBtn = document.getElementById('codeBotBtn');
  const botNameEl = document.getElementById('codeBotName');
  const botMenu = document.getElementById('codeBotMenu');
  let botList = [];

  async function loadBotChoices() {
    try {
      botList = (await window.operator.listBots()) || [];
    } catch (_) { botList = []; }
    const opts = [{ id: null, name: 'No bot', title: 'Plain coding assistant' }].concat(botList);
    botMenu.innerHTML = opts.map((b) =>
      '<button class="opt" type="button" role="option" data-id="' + (b.id || '') + '">' +
      '<span class="opt-name">' + esc2(b.name) + '</span>' +
      (b.title ? '<span class="opt-note">' + esc2(b.title) + '</span>' : '') + '</button>'
    ).join('');
    botMenu.querySelectorAll('.opt').forEach((o) => o.addEventListener('click', async () => {
      const id = o.dataset.id || null;
      if (chat) { chat.botId = id; await window.operator.codeSetBot(chat.id, id); }
      paintBot();
      botMenu.hidden = true;
      botBtn.setAttribute('aria-expanded', 'false');
    }));
  }

  function paintBot() {
    const b = chat && chat.botId ? botList.find((x) => x.id === chat.botId) : null;
    botNameEl.textContent = b ? b.name : 'No bot';
    botBtn.classList.toggle('set', Boolean(b));
  }

  botBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = botMenu.hidden;
    botMenu.hidden = !open;
    botBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!botMenu.hidden && !botMenu.contains(e.target) && e.target !== botBtn) {
      botMenu.hidden = true; botBtn.setAttribute('aria-expanded', 'false');
    }
  });

  function hideMenu() { menu.hidden = true; pickerBtn.setAttribute('aria-expanded', 'false'); }
  pickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    pickerBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      // It opens upward, so its ceiling is the room above the button.
      menu.style.maxHeight = Math.max(200, pickerBtn.getBoundingClientRect().top - 20) + 'px';
      if (codeSearch) {
        codeFilter = '';
        codeSearch.value = '';
        buildCodeMenu();
        codeSearch.focus();
      }
    }
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== pickerBtn) hideMenu(); });

  function clearThread() {
    thread.querySelectorAll('.turn, .csteps').forEach((n) => n.remove());
    if (intro) { if (!intro.isConnected) thread.appendChild(intro); intro.hidden = false; }
  }

  function renderChat() {
    // The old thread's nodes are about to go; anything still pointing into it
    // would append to a detached element.
    live = null;
    group = null;
    thread.querySelectorAll('.turn, .csteps').forEach((n) => n.remove());
    const turns = (chat && chat.turns) || [];
    if (!turns.length) { if (intro) { if (!intro.isConnected) thread.appendChild(intro); intro.hidden = false; } return; }
    if (intro) intro.hidden = true;
    turns.forEach((t) => {
      if (t.k === 'you') addTurn('you', esc2(t.text).replace(/\n/g, '<br>'));
      else if (t.k === 'says') addTurn('says', esc2(t.text).replace(/\n/g, '<br>'));
      else if (t.k === 'steps') { (t.items || []).forEach((s) => codeStep(s.name, s.input, s.err)); closeGroup(); }
    });
    thread.scrollTop = thread.scrollHeight;
  }

  const CARET_SVG = '<svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>';

  function codeIcon(name) {
    if (name === 'Read' || name === 'Grep' || name === 'Glob') return ICON.look;
    if (name === 'Write' || name === 'Edit') return ICON.keys;
    if (name === 'Bash' || name === 'run_command') return ICON.term;
    return ICON.point;
  }

  function addTurn(kind, html) {
    if (intro) intro.hidden = true;
    closeGroup();  // a message ends the current run of steps
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    const el = document.createElement('div');
    el.className = 'turn ' + kind;
    el.innerHTML = (kind === 'you') ? '<span>' + html + '</span>' : html;
    thread.appendChild(el);
    if (near) thread.scrollTop = thread.scrollHeight;
    return el;
  }

  // A collapsible "what it's doing" group — a one-line summary you can expand to
  // see every file it touched and command it ran, exactly like the Agents side.
  function openGroup() {
    if (intro) intro.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'turn';
    wrap.innerHTML =
      '<div class="steps open busy"><button class="steps-head" type="button" aria-expanded="true">' +
      CARET_SVG + '<span class="what">Working…</span><span class="n">0 steps</span><span class="spin"></span></button>' +
      '<div class="steps-body"></div></div>';
    thread.appendChild(wrap);
    const box = wrap.querySelector('.steps');
    const head = wrap.querySelector('.steps-head');
    head.addEventListener('click', () => {
      box.dataset.touched = '1';
      const open = box.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
    });
    group = { box, head, label: wrap.querySelector('.what'), count: wrap.querySelector('.n'), body: wrap.querySelector('.steps-body'), n: 0 };
    return group;
  }

  // When the reply resumes, the run is finished: name it and fold it away,
  // unless you opened or closed it yourself.
  function closeGroup() {
    if (!group) return;
    group.box.classList.remove('busy');
    group.label.textContent = 'Worked on ' + group.n + (group.n === 1 ? ' step' : ' steps');
    if (!group.box.dataset.touched) { group.box.classList.remove('open'); group.head.setAttribute('aria-expanded', 'false'); }
    const now = group.body.querySelector('.step.now');
    if (now) now.classList.remove('now');
    group = null;
  }

  function codeStep(name, inp, isErr) {
    if (!group) openGroup();
    const prev = group.body.querySelector('.step.now');
    if (prev) prev.classList.remove('now');
    const i = inp || {};
    // Present tense in the header (what it's doing now), past tense in the list.
    const nowVerb = isErr ? 'Error' : ({ Read: 'Reading', Write: 'Writing', Edit: 'Editing', Bash: 'Running', Grep: 'Searching', Glob: 'Finding' }[name] || name);
    const pastVerb = isErr ? 'error' : ({ Read: 'Read', Write: 'Wrote', Edit: 'Edited', Bash: 'Ran', Grep: 'Searched', Glob: 'Found' }[name] || name);
    const arg = i.file || i.command || i.pattern || i.find || '';

    // The header follows the current action, like Claude — "Editing index.html".
    group.label.textContent = arg ? nowVerb + ' ' + trim(arg, 46) : nowVerb;

    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    const row = document.createElement('div');
    row.className = 'step now' + (isErr ? ' err' : '');
    row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + codeIcon(name) + '</svg>' +
      '<span class="what">' + esc2(pastVerb) + ' <span class="arg">' + esc2(arg) + '</span></span>';
    group.body.appendChild(row);
    group.n += 1;
    group.count.textContent = group.n + (group.n === 1 ? ' step' : ' steps');
    if (near) thread.scrollTop = thread.scrollHeight;
    return row;
  }

  const isBusy = () => Boolean(chat && running.has(chat.id));

  // Run/stop always describe the chat on screen, so switching to one that is
  // working shows Stop, and switching away shows Run again.
  function paintBusy() {
    const on = isBusy();
    runBtn.hidden = on;
    stopBtn.hidden = !on;
    if (on) stopBtn.classList.remove('stopping');
  }

  let live = null;      // the reply bubble currently streaming

  // Append only the new token as text nodes. Rebuilding the whole innerHTML on
  // every token is O(n²) and freezes the UI once a reply gets long (e.g. loading
  // a skill), so never do that.
  function appendDelta(el, text) {
    const parts = String(text).split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) el.appendChild(document.createElement('br'));
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]));
    }
  }

  let lastScroll = 0;
  function scrollSoon() {
    // Coalesce scrolls to at most ~20/s so a fast stream doesn't thrash layout.
    const now = performance.now();
    if (now - lastScroll > 50) { thread.scrollTop = thread.scrollHeight; lastScroll = now; }
  }

  window.operator.onCode((evt) => {
    // Run state is tracked for every chat, including the ones you are not
    // looking at — that is the whole point of letting them run at once.
    if (evt.type === 'status' && evt.chatId) {
      if (evt.text === 'running') running.add(evt.chatId);
      else running.delete(evt.chatId);
      paintBusy();
      loadHistory();     // repaint the sidebar's working markers
      return;
    }

    // Everything else is transcript, and belongs to the chat on screen.
    if (chat && evt.chatId && evt.chatId !== chat.id) return;
    switch (evt.type) {
      // the narration, streamed like Claude Code
      case 'say_start':
        live = addTurn('says live', '');
        break;
      case 'say_delta':
        if (live) { appendDelta(live, evt.text); scrollSoon(); }
        break;
      case 'say_end':
        // Deltas already rendered the text; just drop the streaming cursor.
        if (live) { live.classList.remove('live'); live = null; }
        break;

      case 'assistant': addTurn('says', esc2(evt.text).replace(/\n/g, '<br>')); break;
      case 'tool':
        if (live) { live.classList.remove('live'); live = null; }  // finalise any open narration
        codeStep(evt.name, evt.input, false);
        break;
      case 'tool_error': codeStep('error', { command: evt.text }, true); break;
      case 'done':
        if (live) { live.classList.remove('live'); live = null; }
        closeGroup();
        if (evt.text) addTurn('says', esc2(evt.text).replace(/\n/g, '<br>'));
        if (evt.chatId) running.delete(evt.chatId);
        paintBusy();
        break;
      case 'error':
        if (live) { live.classList.remove('live'); live = null; }
        closeGroup();
        addTurn('says', '<span style="color:var(--fail)">' + esc2(evt.text) + '</span>');
        if (evt.chatId) running.delete(evt.chatId);
        paintBusy();
        break;
    }
  });

  async function run() {
    const task = input.value.trim();
    if (!task || isBusy()) return;
    if (!chat) { chat = await window.operator.codeChatCreate(); loadHistory(); }
    if (!chat.cwd) {
      const r = await window.operator.codePickFolder(chat.id);
      if (!r || !r.ok) { addTurn('says', '<span style="color:var(--fail)">Choose a project folder first.</span>'); return; }
      chat.cwd = r.cwd; chat.cwdName = r.name; paintFolder(); loadHistory();
    }
    addTurn('you', esc2(task).replace(/\n/g, '<br>'));
    input.value = ''; input.style.height = 'auto';

    // Optimistic: the button flips before the main process answers, and this
    // chat's id is what gets marked — not some global "busy".
    running.add(chat.id);
    paintBusy();
    loadHistory();

    const started = chat.id;
    const r = await window.operator.codeRun(started, task);
    if (r && r.ok === false) {
      running.delete(started);
      paintBusy();
      if (chat && chat.id === started) {
        addTurn('says', '<span style="color:var(--fail)">' + esc2(r.error) + '</span>');
      }
      loadHistory();
    }
  }

  composer.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  stopBtn.addEventListener('click', () => {
    if (!chat || stopBtn.classList.contains('stopping')) return;
    stopBtn.classList.add('stopping');
    window.operator.codeStop(chat.id);
    // Don't wait for the run to unwind to admit it is over.
    running.delete(chat.id);
    if (live) { live.classList.remove('live'); live = null; }
    closeGroup();
    paintBusy();
    loadHistory();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
})();
