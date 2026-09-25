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
  document.body.classList.add('working');   // lights the composer
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

// The check at the end of a run lands after the reply, and what it finds can
// send the agent back to work. So the run is not over yet: put the UI back to
// working without restarting the clock or zeroing the actions it already did.
function resumeRun() {
  if (busy) return;
  busy = true;
  document.body.classList.add('working');
  runBtn.disabled = true;
  runBtn.hidden = true;
  stopBtn.hidden = false;
  railState.classList.add('on');
  railState.title = 'Running';
  setLive('Live', true);
  if (!ticker) ticker = setInterval(() => { elapsedEl.textContent = clock(Date.now() - startedAt); }, 500);
  showDots();
}

function endRun() {
  busy = false;
  document.body.classList.remove('working');
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
  settleHelpers();
}

// The run is over, so no helper of it is still working. After Stop their own
// last words are dropped on purpose (main.js), so the card is told here.
function settleHelpers() {
  // The main agent's turn cards too: their own ending is dropped after Stop.
  for (const [id, h] of handovers) { handovers.delete(id); endHandoverCard(h, 'stopped'); }
  if (openTurns.length) { openTurns.length = 0; paintTurns(); }
  if (!helpers) return;
  let changed = false;
  for (const lane of helpers.lanes.values()) {
    if (lane.data.state !== 'working' && lane.data.state !== 'waiting') continue;
    lane.data.state = 'stopped';
    paintLane(lane.el, lane.data);
    changed = true;
  }
  if (!changed) return;
  paintHelpersHead(helpers.card, helpers.record.lanes);
  save();
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
const spacesEl = document.getElementById('spaces');
const newWsBtn = document.getElementById('newWsBtn');
const agentsHead = document.getElementById('agentsHead');
const chatsFor = document.getElementById('chatsFor');
const whoBtn = document.getElementById('whoBtn');
const whoFace = document.getElementById('whoFace');
const whoName = document.getElementById('whoName');
const whoTitle = document.getElementById('whoTitle');

let bots = [];
let bot = null;        // the bot you are talking to
let chat = null;       // its open chat, or null until you say something
// On the start screen: the next message begins a new conversation instead of
// carrying on whichever one this agent had last.
let fresh = false;
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

    // you are talking to a particular bot, so say its name — unless it is
    // waiting on you, when the box is for your answer (paintTurns)
    input.placeholder = openTurns.length
      ? 'Operator is waiting for you — type what it asked for and press Enter'
      : 'Give ' + bot.name + ' a task';
    const h1 = document.querySelector('#intro h1');
    if (h1) h1.textContent = 'What should ' + bot.name + ' do?';
    // The start screen shows who you are about to talk to.
    const introFace = document.getElementById('introFace');
    if (introFace && introFace.dataset.for !== bot.id + JSON.stringify(bot.face)) {
      introFace.innerHTML = '';
      introFace.appendChild(Avatar.el(bot.face, 44, 'idle'));
      introFace.dataset.for = bot.id + JSON.stringify(bot.face);
    }
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

// Which conversation the pending save is for, taken when it was asked for.
// Reading `bot` and `chat` when the timer fired instead meant switching or
// deleting inside those 400ms either threw (both null) or wrote the wrong
// conversation — and the one you had just left lost its last lines.
let saveFor = null;

function save() {
  if (!chat || !bot) return;
  // One still pending for another conversation goes now rather than never.
  if (saveFor && (saveFor.botId !== bot.id || saveFor.chat.id !== chat.id)) flushSave();
  clearTimeout(saveTimer);
  saveFor = { botId: bot.id, chat };
  saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const s = saveFor;
  saveFor = null;
  if (!s) return;
  await window.operator.saveChat(s.botId, s.chat.id, { title: s.chat.title, turns: s.chat.turns });
  // The rail is painted from the roster now, not from a separate fetch, so
  // it has to be reloaded before repainting — otherwise an agent keeps the
  // name it had before the first thing you asked it.
  await loadBots();
  await paintRail();
}

// An agent is its thread, so asking for the agent is asking for the thread.
// It is made on demand rather than at creation, which is what keeps a freshly
// made agent out of the way until you actually say something to it.
async function ensureChat() {
  if (chat) return chat;
  const made = fresh ? await window.operator.createChat(bot.id) : await window.operator.agentThread(bot.id);
  fresh = false;
  chat = { id: made.id, title: made.title, turns: [] };
  return chat;
}

// The start screen, the way a chat app opens: the agent's name, the box and
// some suggestions, with no conversation behind it yet. The first message
// makes one, and it lands at the top of the rail.
async function startFresh(botId) {
  if (busy) window.operator.stopTask();
  chat = null;
  fresh = true;
  clearThread();
  await loadBots(botId || (bot && bot.id));
  await paintRail();
  input.value = '';
  resize();
  input.focus();
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
  if (window.__refreshModelUI) window.__refreshModelUI();   // its pinned model, if it has one
}

/* ── what a row in the rail is ───────────────────────────────────────
 * One conversation: an agent, and the thread it is. Normally that is one row
 * per agent. A routine writes each run into a thread of its own, so an agent
 * can pick up extras — those show up in the list below as conversations in
 * their own right rather than vanishing underneath the agent that owns them.
 */

const pinnedAgents = () => bots.filter((b) => b.pinned);

// Sorted by the thread, not the agent: the rail reads as a history of
// conversations, so the one you touched last belongs at the top.
function rowsOf(list) {
  const rows = [];
  for (const b of list) {
    if (b.pinned) for (const t of b.threads.slice(1)) rows.push({ bot: b, thread: t });
    else if (!b.threads.length) rows.push({ bot: b, thread: null });
    else for (const t of b.threads) rows.push({ bot: b, thread: t });
  }
  return rows.sort((a, z) => ((z.thread && z.thread.updatedAt) || 0) - ((a.thread && a.thread.updatedAt) || 0));
}

// The main list is what is left over: not filed in a workspace, plus any extra
// threads a pinned agent has collected from its routines.
const looseRows = () => rowsOf(bots.filter((b) => !b.workspaceId));
const rowsIn = (wsId) => rowsOf(bots.filter((b) => b.workspaceId === wsId));

// Nothing is highlighted on the start screen: no conversation is open yet.
const isOpen = (row) =>
  Boolean(bot && row.bot.id === bot.id &&
    ((chat && row.thread && chat.id === row.thread.id) || (!chat && !row.thread && !fresh)));

// All three lists in one call. Which row is highlighted depends on the open
// thread, so painting one without the others leaves a stale selection behind.
const paintRail = () => { paintRoster(); paintSpaces(); return listChats(); };

function paintRoster() {
  rosterEl.textContent = '';
  const rows = pinnedAgents().map((b) => ({ bot: b, thread: b.threads[0] || null }));

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'chats-empty';
    p.textContent = 'None pinned.';
    rosterEl.appendChild(p);
    return;
  }

  for (const r of rows) {
    const b = r.bot;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bot-row' + (isOpen(r) ? ' on' : '');
    row.dataset.id = b.id;

    row.appendChild(Avatar.el(b.face, 26, 'idle'));

    const text = document.createElement('span');
    text.className = 'bot-text';
    const name = document.createElement('span');
    name.className = 'bot-name';
    const label = document.createElement('span');
    label.className = 'bot-label';
    label.textContent = b.name;
    name.appendChild(label);
    if (b.role) {
      const tag = document.createElement('span');
      tag.className = 'role-tag is-' + b.role;
      tag.textContent = b.role === 'coordinator' ? 'coord' : 'main';
      name.appendChild(tag);
    }
    const line = document.createElement('span');
    line.className = 'bot-line';
    line.textContent = b.lastLine || b.title || 'Nothing yet';
    text.append(name, line);

    row.appendChild(text);
    row.addEventListener('click', () => openAgent(b.id, r.thread && r.thread.id));
    rosterEl.appendChild(withBin(row, 'bot-item', b));
  }
}

// Open a conversation: which agent is talking, and which of its threads.
async function openAgent(botId, threadId) {
  if (bot && bot.id === botId && chat && chat.id === threadId) return;
  if (busy) window.operator.stopTask();

  chat = null;
  fresh = false;
  clearThread();
  await loadBots(botId);

  if (threadId) {
    const full = await window.operator.getChat(botId, threadId);
    if (full) {
      chat = { id: full.id, title: full.title, turns: full.turns || [] };
      if (chat.turns.length) document.body.classList.add('started');
      replay(chat.turns);
    }
  }

  await paintRail();
  input.focus();
}

/* that bot's chats */

const BIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V5.5h5V7M6.5 7l.8 12h9.4l.8-12"/></svg>';

/* ── workspaces ──────────────────────────────────────────────────────
 * Named folders of agents. Filing, not scope: a workspace groups rows in the
 * rail and nothing else — it does not wall an agent off from the machine, the
 * connectors or the other agents, and the panel says so rather than implying a
 * boundary that is not there.
 *
 * You file an agent by dragging its row onto a workspace, or from its own
 * panel. Dropping one on the Agents heading takes it back out.
 */

// Its own chevron: the steps-group CARET carries rotation styles tied to that
// widget's aria-expanded, which is not how a workspace opens.
const SPACE_CARET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

let spaces = [];

async function loadSpaces() {
  spaces = await window.operator.listWorkspaces();
  return spaces;
}

function paintSpaces() {
  if (!spacesEl) return;
  spacesEl.textContent = '';

  if (!spaces.length) {
    const p = document.createElement('p');
    p.className = 'chats-empty';
    p.textContent = 'None yet — New makes one.';
    spacesEl.appendChild(p);
    return;
  }

  for (const w of spaces) {
    const wrap = document.createElement('div');
    wrap.className = 'space' + (w.collapsed ? ' shut' : '');

    const head = document.createElement('div');
    head.className = 'space-head';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'space-open';
    toggle.innerHTML = SPACE_CARET;
    const name = document.createElement('span');
    name.className = 'space-name';
    name.textContent = w.name;
    const count = document.createElement('span');
    count.className = 'space-count';
    count.textContent = w.count;
    toggle.append(name, count);
    toggle.title = w.name + ' — double-click to rename';
    toggle.addEventListener('click', () => setCollapsed(w, !w.collapsed));
    toggle.addEventListener('dblclick', (e) => { e.preventDefault(); renameSpace(w, name); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-del';
    del.title = 'Delete workspace — the agents in it stay';
    del.setAttribute('aria-label', 'Delete workspace ' + w.name);
    del.innerHTML = BIN;
    del.addEventListener('click', (e) => { e.stopPropagation(); removeSpace(w); });

    head.append(toggle, del);
    dropInto(head, w.id);
    wrap.appendChild(head);

    if (!w.collapsed) {
      const body = document.createElement('div');
      body.className = 'space-body';
      const rows = rowsIn(w.id);
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'chats-empty space-empty';
        empty.textContent = 'Drag an agent in.';
        body.appendChild(empty);
      } else {
        for (const r of rows) body.appendChild(agentRow(r));
      }
      wrap.appendChild(body);
    }

    spacesEl.appendChild(wrap);
  }
}

async function setCollapsed(w, collapsed) {
  w.collapsed = collapsed;               // paint now, persist behind it
  paintSpaces();
  await window.operator.updateWorkspace(w.id, { collapsed });
  await loadSpaces();
}

// Swaps the name for an input in place. Enter or clicking away keeps it,
// Escape puts it back — nothing is written until one of those happens.
function renameSpace(w, nameEl) {
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'space-rename';
  box.value = w.name;
  box.maxLength = 40;
  nameEl.replaceWith(box);
  box.focus();
  box.select();

  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    const next = box.value.trim();
    if (keep && next && next !== w.name) await window.operator.updateWorkspace(w.id, { name: next });
    await loadSpaces();
    paintSpaces();
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  box.addEventListener('blur', () => finish(true));
  // The caret sits inside the toggle button, so a click in the box would
  // collapse the workspace underneath the thing being typed into.
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('dblclick', (e) => e.stopPropagation());
}

// The folder goes; what was in it drops back into the list below, which is the
// feedback — no dialog, because nothing was destroyed.
async function removeSpace(w) {
  await window.operator.deleteWorkspace(w.id);
  await loadSpaces();
  await loadBots(bot && bot.id);
  await paintRail();
}

/* dragging an agent into a folder */

let dragging = null;   // the agent id in flight

function dropInto(el, wsId) {
  el.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drop');
    const id = dragging || e.dataTransfer.getData('text/plain');
    dragging = null;
    if (!id) return;
    await window.operator.fileAgent(id, wsId);
    await loadSpaces();
    await loadBots(bot && bot.id);
    await paintRail();
  });
}

// One agent row, used by the main list and inside a workspace.
function agentRow(r) {
  const label = (r.thread && r.thread.title !== 'New chat' ? r.thread.title : r.bot.name) || 'New agent';

  const row = document.createElement('div');
  row.className = 'chat-row' + (isOpen(r) ? ' on' : '');
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragging = r.bot.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', r.bot.id);
    row.classList.add('lifting');
  });
  row.addEventListener('dragend', () => { dragging = null; row.classList.remove('lifting'); });

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'chat-open';
  open.appendChild(Avatar.el(r.bot.face, 18, 'idle'));
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = label;
  open.appendChild(name);
  open.title = label;
  open.addEventListener('click', () => openAgent(r.bot.id, r.thread && r.thread.id));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'chat-del';
  del.title = 'Delete agent';
  del.setAttribute('aria-label', 'Delete ' + label);
  del.innerHTML = BIN;
  del.addEventListener('click', (e) => { e.stopPropagation(); removeRow(r); });

  row.append(open, del);
  return row;
}

// The agents that are not pinned. Reads like a history — each row is one
// conversation, most recent at the top — which is why it is painted from the
// whole roster rather than from whichever agent happens to be selected.
async function listChats() {
  chatsFor.textContent = 'Agents';
  const rows = looseRows();
  chatsEl.textContent = '';

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'chats-empty';
    p.textContent = 'Nothing yet.';
    chatsEl.appendChild(p);
    return;
  }

  for (const r of rows) chatsEl.appendChild(agentRow(r));
}

// Replays a stored transcript. Screenshots are not kept, so the computer pane
// stays shut until this chat looks at something again.
function replay(turns) {
  for (const t of turns) {
    if (t.k === 'you') turn('you', '<span>' + youHtml(t.text) + '</span>');
    else if (t.k === 'says') turn('says', nl2br(t.text));
    else if (t.k === 'error') turn('', errorCard(t.title, t.fix, t.text));
    else if (t.k === 'note') turn('', noteCard(t.text));
    else if (t.k === 'check') turn('', checkCard(t));
    else if (t.k === 'routine') turn('', routineCard(t.text));
    else if (t.k === 'screen') turn('', screenCard(t));
    else if (t.k === 'helpers') turn('', '').appendChild(helpersCard(t));
    else if (t.k === 'handover') turn('', handoverCard(t.what, t.outcome || 'stopped', true, t.answer));
    else if (t.k === 'steps') {
      const g = openGroup();
      for (const it of t.items) addStepRow(g, it.name, it.input || {}, it.at || '', false);
      closeGroup();
    }
  }
  thread.scrollTop = thread.scrollHeight;
}

// A failure the user can act on: what went wrong, then the one thing that
// fixes it, with the technical detail folded away rather than thrown out.
function errorCard(title, fix, detail) {
  const head = '<b>' + esc(title || 'Stopped') + '</b>';
  const body = fix ? '<span>' + esc(fix) + '</span>' : '<span>' + esc(detail || '') + '</span>';
  const more = fix && detail && detail !== title
    ? '<details class="error-more"><summary>Details</summary><p>' + esc(detail) + '</p></details>'
    : '';
  return '<div class="error">' + head + '<div class="error-body">' + body + more + '</div></div>';
}

function clearThread() {
  thread.querySelectorAll('.turn').forEach((el) => el.remove());
  helpers = null;
  handovers.clear();
  if (openTurns.length) { openTurns.length = 0; document.body.classList.remove('your-turn'); }
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

/* ── undo, for deletes ───────────────────────────────────────────────
 * A delete happens at once — close the app a second later and it stays gone —
 * but for a few seconds a note at the bottom offers it back. The agent is
 * copied just before it goes, and Undo puts that copy back where it was.
 */

const undoEl = document.getElementById('undo');
const UNDO_MS = 7000;
let undoing = null;   // { restore, timer }

function offerUndo(text, restore) {
  if (undoing) clearTimeout(undoing.timer);
  document.getElementById('undoText').textContent = text;
  undoEl.hidden = false;
  // Restart the countdown bar, which a second delete in a row would not do.
  undoEl.classList.remove('run');
  void undoEl.offsetWidth;
  undoEl.classList.add('run');
  undoing = { restore, timer: setTimeout(() => { undoEl.hidden = true; undoing = null; }, UNDO_MS) };
}

document.getElementById('undoBtn').addEventListener('click', async () => {
  if (!undoing) return;
  const { restore, timer } = undoing;
  clearTimeout(timer);
  undoing = null;
  undoEl.hidden = true;
  await restore();
});

// The agent as it stands, and where it sits in the list, taken before a delete.
async function snapshot(botId) {
  const full = await window.operator.getBot(botId);
  return full ? { full, index: bots.findIndex((b) => b.id === botId) } : null;
}

// Puts it back. If it was the conversation on screen, it comes back on screen —
// unless something is running, since opening a conversation stops a task.
async function putBack(snap, threadId) {
  const back = await window.operator.restoreBot(snap.full, snap.index);
  if (!back) return;
  if (threadId !== undefined && !busy && !launchOpen()) {
    await openAgent(back.id, threadId || (back.threads[0] && back.threads[0].id) || null);
    return;
  }
  await loadBots(bot && bot.id);
  await paintRail();
  if (launchOpen()) paintLaunch(true);
}

// Deleting a row deletes the conversation it stands for. For an ordinary agent
// that is the agent itself; for a routine's run sitting under a pinned agent it
// is only that thread, because the agent it belongs to is one you chose to keep.
async function removeRow(r) {
  const mine = isOpen(r);
  const snap = await snapshot(r.bot.id);
  if (r.bot.pinned && r.thread) await window.operator.deleteChat(r.bot.id, r.thread.id);
  else await window.operator.deleteBot(r.bot.id);
  if (snap) {
    offerUndo(r.bot.pinned && r.thread ? 'Deleted a conversation from ' + r.bot.name : 'Deleted ' + r.bot.name,
      () => putBack(snap, mine ? (r.thread && r.thread.id) || null : undefined));
  }

  if (!mine) {
    await loadBots(bot && bot.id);
    await paintRail();
    return;
  }

  // The one you were reading has gone. Land on another rather than leaving the
  // composer pointed at an agent that no longer exists.
  chat = null;
  clearThread();
  await loadBots();
  const next = pinnedAgents().map((b) => ({ bot: b, thread: b.threads[0] || null }))[0] || looseRows()[0];
  if (next) await openAgent(next.bot.id, next.thread && next.thread.id);
  else await paintRail();
}

// A bin for a row that is a button itself, since one button cannot hold
// another: the two share a wrapper, and the bin sits over the row's right end.
function withBin(row, cls, b) {
  const item = document.createElement('div');
  item.className = cls;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'chat-del';
  del.title = 'Delete agent';
  del.setAttribute('aria-label', 'Delete ' + b.name);
  del.innerHTML = BIN;
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteAgent(b); });
  item.append(row, del);
  return item;
}

// The whole agent, from its bin in the pinned list or on the start screen:
// every conversation with it goes too, and Undo brings it all back.
async function deleteAgent(b) {
  const mine = Boolean(bot && bot.id === b.id);
  if (mine && busy) window.operator.stopTask();
  // What Undo reopens: the conversation on screen, if this was it.
  const shown = mine && !launchOpen() ? (chat && chat.id) || null : undefined;
  const snap = await snapshot(b.id);
  await window.operator.deleteBot(b.id);
  if (snap) offerUndo('Deleted ' + b.name, () => putBack(snap, shown));

  if (mine) {
    // It was the one on screen (or waiting under the start screen), so carry
    // on with a fresh chat with the main agent instead.
    const rest = bots.filter((x) => x.id !== b.id);
    const home = rest.find((x) => x.pinned && x.role === 'main') || rest.find((x) => x.pinned) || rest[0];
    bot = null;
    await startFresh(home && home.id);
  } else {
    await loadBots(bot && bot.id);
    await paintRail();
  }
  if (launchOpen()) { paintLaunch(true); launchSearch.focus(); }
}

// New agent: its own persona, its own memory, its own thread. This is the one
// that used to be "New chat", and the difference is the point — a conversation
// here is a thing you can give a name, a face and standing instructions.
// A new agent arrives with its thread already on it, so it has to be opened
// through openAgent — selecting the agent alone would leave the rail with
// nothing highlighted and the composer pointing at a thread it never loaded.
async function makeAgent(spec) {
  if (busy) window.operator.stopTask();
  const made = await window.operator.createAgent(spec);
  if (!made) return null;
  input.value = '';
  resize();
  await openAgent(made.id, made.threads.length ? made.threads[0].id : null);
  return made;
}

const newChat = () => makeAgent({ name: 'New agent', title: '' });

newChatBtn.addEventListener('click', newChat);

// A workspace is born named and immediately editable — being made to find the
// rename afterwards is how folders end up called "New workspace" forever.
if (newWsBtn) {
  newWsBtn.addEventListener('click', async () => {
    const made = await window.operator.createWorkspace('New workspace');
    await loadSpaces();
    paintSpaces();
    const row = [...spacesEl.querySelectorAll('.space')].find((el, i) => spaces[i] && spaces[i].id === made.id);
    const w = spaces.find((x) => x.id === made.id);
    const nameEl = row && row.querySelector('.space-name');
    if (w && nameEl) renameSpace(w, nameEl);
  });
}

// Dropping an agent on the Agents heading takes it back out of its folder.
if (agentsHead) dropInto(agentsHead, null);

// The + above the rail makes one that stays: pinned to the top, badged main
// until you say otherwise in its panel.
newBotBtn.addEventListener('click', async () => {
  const made = await makeAgent({ name: 'New agent', title: '', pinned: true, role: 'main' });
  if (made) openSheet(true);
});

/* the rail opens and closes */

function setRail(open) {
  rail.classList.toggle('open', open);
  historyBtn.setAttribute('aria-expanded', String(open));
  historyBtn.title = open ? 'Hide agents' : 'Show agents';
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
const fRole = document.getElementById('fRole');
const fWorkspace = document.getElementById('fWorkspace');
const fFaces = document.getElementById('fFaces');
const fMemory = document.getElementById('fMemory');
const fRoutines = document.getElementById('fRoutines');
const botSkills = document.getElementById('botSkills');

const SHAPES = ['squircle', 'round', 'dome', 'shield'];
const ACCESSORIES = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
const HUES = [199, 262, 152, 24, 341, 44, 288, 174];

const EVERY = {
  once: 'Once',
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

// The verdict of the second pass. A pass is deliberately quiet — one line you
// can skim past. A fail is the whole reason the feature exists, so it is loud,
// and it sits above whatever the agent does next to fix it.
function checkCard(v) {
  const state = v.ok === true ? 'pass' : v.ok === false ? 'fail' : 'unsure';
  const head = v.ok === true ? 'Checked — the goal was met'
    : v.ok === false ? 'Checked — the goal was not met'
    : 'Checked — could not tell';
  const icon = v.ok === true ? '<path d="m5 12.4 4.6 4.6L19 7"/>'
    : v.ok === false ? '<path d="M12 3.2 2.4 20.4h19.2Z"/><path d="M12 9.4v4.6"/><circle cx="12" cy="17.3" r="1"/>'
    : '<circle cx="12" cy="12" r="9"/><path d="M9.7 9.5a2.4 2.4 0 1 1 2.9 3.1v1.3"/><circle cx="12.4" cy="17.2" r="1"/>';
  return '<div class="check ' + state + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + icon + '</svg>' +
    '<span class="check-text"><b>' + head + '</b>' +
    (v.why ? '<i>' + esc(v.why) + '</i>' : '') + '</span></div>';
}

function screenCard(v) {
  const icon = v.mine
    ? '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 20.5h8"/>'
    : '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 20.5h8M7 10.5l3 3 5-5"/>';
  const text = v.mine
    ? 'Working on <b>your</b> screen' + (v.reason ? ' — ' + esc(v.reason) : '')
    : (v.auto ? 'Finished — your screen is yours again' : 'Gave your screen back');
  return '<div class="event screen"><svg viewBox="0 0 24 24" aria-hidden="true">' + icon + '</svg><span>' + text + '</span></div>';
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
  // Unpinned agents have no role, so the empty option is "in the list".
  fRole.value = full.pinned ? (full.role || 'main') : '';

  // The same filing you get by dragging the row, for when dragging is awkward.
  fWorkspace.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None — in the main list';
  fWorkspace.appendChild(none);
  for (const w of spaces) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = w.name;
    fWorkspace.appendChild(o);
  }
  fWorkspace.value = full.workspaceId || '';

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
    stamp.textContent = (r.kind === 'remind' ? 'Reminder · ' : '') + (EVERY[r.every] || r.every) +
      (r.every === 'once' ? ', ' + new Date(r.when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : SPACED.has(r.every) ? '' : ' at ' + r.at) +
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
  sheetDone.textContent = isNew ? 'Create agent' : 'Done';
  paintSheet();
  // A new one's name is a placeholder, so typing should replace it.
  setTimeout(() => { fName.focus(); if (isNew) fName.select(); }, 40);
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

// `discard` (strictly true — as a click handler this gets the event) skips
// saving: Delete closes it on an agent that is already gone, and saving the
// fields back to that is what used to throw and leave the panel stuck open.
async function closeSheet(discard) {
  if (sheet.hidden || sheet.classList.contains('closing')) return;
  if (discard !== true) await commitPending();
  // Opened from the start screen: that screen leaves as this closes, together.
  if (launchOpen()) settleLaunch();
  // Out the way it came in — a short fade and settle rather than a blink.
  if (!stillMotion()) {
    sheet.classList.add('closing');
    await new Promise((r) => setTimeout(r, 180));
    sheet.classList.remove('closing');
  }
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
    pinned: Boolean(fRole.value),
    role: fRole.value || null,
    workspaceId: fWorkspace.value || null,
  });
  await loadBots(bot.id);
  // Pinning moves it between the two lists, so both have to be repainted.
  await paintRail();
  sheetTitle.textContent = fName.value.trim() || 'Agent';
};

[fName, fTitle, fPersona].forEach((el) => el.addEventListener('change', pushField));
fModel.addEventListener('change', pushField);
fRole.addEventListener('change', pushField);
fWorkspace.addEventListener('change', pushField);

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
  const snap = await snapshot(bot.id);
  // From the start screen's Create, it was never on screen to go back to.
  const shown = launchOpen() ? undefined : (chat && chat.id) || null;
  await window.operator.deleteBot(bot.id);
  closeSheet(true);
  chat = null;
  clearThread();
  bot = null;
  await loadBots();
  await paintRail();
  if (snap) offerUndo('Deleted ' + snap.full.name, () => putBack(snap, shown));
});

// A routine that fired while you were elsewhere changes the roster under you.
window.operator.onBotsChanged(() => { loadBots().then(paintRail); });


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

/* ── helpers: several web jobs at once ─────────────────────────────
 * run_helpers hands separate web jobs to helper agents that work at the same
 * time, each in its own browser tab. They get one card: a lane each, with a
 * small live picture of its tab, what it is doing and how it ended. The card
 * is saved with the chat (without the pictures) and replayed like the rest.
 */

const HELPER_STATE = { working: 'Working', waiting: 'Your turn', done: 'Done', needs: 'Needs you', failed: 'Failed', stopped: 'Stopped' };

/* ── the user's turn ──────────────────────────────────────────────────
 * A step only the user can do — a code, a robot check, a password — handed
 * over without ending the task (wait_for_user, handover.js). A card says what
 * to do, with "Show me" (brings that tab up in the agent's browser), "I've
 * done it" and "Skip"; the agent carries on the moment it is done. A helper's
 * turn shows in its own lane instead.
 */

const HANDOVER_END = { user: 'Done — carrying on', moved: 'Done — carrying on', gone: 'Done — carrying on', skipped: 'Skipped', timeout: 'Timed out — nothing more was done', stopped: 'Stopped' };
const handovers = new Map();   // the main agent's open turns: id → { el, record }
const openTurns = [];          // every open turn, oldest first — the task box answers the newest

// Three bouncing dots: it is waiting, not stuck.
const WAIT_DOTS = '<span class="hv-wait" aria-hidden="true"><i></i><i></i><i></i></span>';

// `page`: whether there is a tab to show. A run waiting on an answer has none.
// `answer`: what the user typed, shown once it is over.
function handoverCard(what, outcome, page, answer) {
  const over = outcome !== null && outcome !== undefined;
  return '<div class="handover' + (over ? ' is-over' : '') + '">' +
    '<div class="handover-top"><span class="hv-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span>' +
      '<b>' + (over ? 'Your turn' : 'Operator needs you to keep going') + '</b>' +
      '<span class="handover-state">' + (over ? esc(HANDOVER_END[outcome] || outcome) : WAIT_DOTS + 'Waiting for you') + '</span></div>' +
    '<p class="handover-what">' + esc(what) + '</p>' +
    (over && answer ? '<p class="handover-answer">You answered: <b>' + esc(answer) + '</b></p>' : '') +
    (over ? '' :
      '<form class="hv-reply">' +
        '<input type="text" placeholder="Type what it asked for — a code, a number, an answer — or just do it on the page" autocomplete="off" spellcheck="false" />' +
        '<button type="submit" class="pill solid sm">Send</button>' +
      '</form>' +
      '<div class="handover-actions">' +
        (page === false ? '' : '<button type="button" class="pill ghost sm hv-show">Show me</button>') +
        '<button type="button" class="pill ghost sm hv-done">I\'ve done it</button>' +
        '<button type="button" class="hv-skip">Skip this step</button>' +
      '</div>') +
  '</div>';
}

// The controls, for a card or a helper's lane. `id` is read when clicked: a
// lane is handed a new one for each turn.
function bindHandover(root, getId) {
  const act = (fn) => (e) => { if (e) e.preventDefault(); const id = getId(); if (id) fn(id); };
  const show = root.querySelector('.hv-show');
  if (show) show.addEventListener('click', act((id) => window.operator.handoverShow(id)));
  root.querySelector('.hv-done').addEventListener('click', act((id) => window.operator.handoverDone(id, '')));
  root.querySelector('.hv-skip').addEventListener('click', act((id) => window.operator.handoverSkip(id)));
  const form = root.querySelector('.hv-reply');
  if (form) {
    form.addEventListener('submit', act((id) => {
      const box = form.querySelector('input');
      window.operator.handoverDone(id, box.value);
      box.value = '';
    }));
  }
}

// While anything is waiting on the user: the task box glows amber and its
// placeholder says so, and pressing Enter in it answers the newest turn.
function paintTurns() {
  const waiting = openTurns.length > 0;
  document.body.classList.toggle('your-turn', waiting);
  if (waiting) input.placeholder = 'Operator is waiting for you — type what it asked for and press Enter';
  else paintFaces();
}
function turnOpened(id) {
  openTurns.push(id);
  if (!busy) resumeRun();     // the reply that said "needs you" had ended it visually
  hideDots();
  paintTurns();
}
function turnClosed(id) {
  const i = openTurns.indexOf(id);
  if (i >= 0) openTurns.splice(i, 1);
  paintTurns();
}
// The task box, while it is the user's turn: an answer, not a new task.
function answerTurn(text) {
  const id = openTurns[openTurns.length - 1];
  if (!id) return false;
  window.operator.handoverDone(id, text);
  return true;
}

function onHandover(evt) {
  if (evt.type === 'handover') {
    closeGroup();
    const record = { k: 'handover', what: evt.what, outcome: null };
    const el = turn('', handoverCard(evt.what, null, !evt.reply));
    bindHandover(el, () => (handovers.has(evt.id) ? evt.id : null));
    handovers.set(evt.id, { el, record });
    rec(record);
    turnOpened(evt.id);
    const box = el.querySelector('.hv-reply input');
    if (box) box.focus();
    return;
  }
  const h = handovers.get(evt.id);
  turnClosed(evt.id);
  if (!h) return;
  handovers.delete(evt.id);
  endHandoverCard(h, evt.outcome, evt.answer);
  if (evt.outcome !== 'stopped') showDots();
}

function endHandoverCard(h, outcome, answer) {
  h.record.outcome = outcome;
  if (answer) h.record.answer = answer;
  h.el.innerHTML = handoverCard(h.record.what, outcome, true, h.record.answer);
  save();
}
let helpers = null;   // the card being filled right now: { el, record, lanes: Map }

function helperLane(data) {
  const el = document.createElement('div');
  el.className = 'helper is-' + data.state;
  el.innerHTML =
    '<div class="helper-shot"><img alt="" hidden><span class="helper-initial"></span></div>' +
    '<div class="helper-body">' +
      '<div class="helper-top"><i class="helper-dot"></i><b class="helper-name"></b><span class="helper-state"></span></div>' +
      '<div class="helper-step"></div>' +
      '<div class="helper-actions" hidden>' +
        '<form class="hv-reply">' +
          '<input type="text" placeholder="Type what it asked for…" autocomplete="off" spellcheck="false" />' +
          '<button type="submit" class="pill solid sm">Send</button>' +
        '</form>' +
        '<div class="handover-actions">' +
          '<button type="button" class="pill ghost sm hv-show">Show me</button>' +
          '<button type="button" class="pill ghost sm hv-done">I\'ve done it</button>' +
          '<button type="button" class="hv-skip">Skip</button>' +
        '</div>' +
      '</div>' +
      '<div class="helper-report" hidden></div>' +
    '</div>';
  el.querySelector('.helper-initial').textContent = (data.name || '?').trim().charAt(0).toUpperCase();
  el.querySelector('.helper-name').textContent = data.name;
  el.title = data.task || '';
  bindHandover(el, () => (data.state === 'waiting' ? data.hv : null));
  paintLane(el, data);
  return el;
}

function paintLane(el, data) {
  el.className = 'helper is-' + data.state;
  el.querySelector('.helper-state').innerHTML = (data.state === 'waiting' ? WAIT_DOTS : '') + esc(HELPER_STATE[data.state] || data.state);
  el.querySelector('.helper-step').textContent = data.state === 'working'
    ? (data.step || 'Opening its tab…')
    : data.state === 'waiting' ? data.what
    : data.steps + (data.steps === 1 ? ' step' : ' steps');
  el.querySelector('.helper-actions').hidden = data.state !== 'waiting';
  const report = el.querySelector('.helper-report');
  // The report opens with DONE / NEEDS YOU, which the badge already says.
  const text = String(data.report || '').replace(/^\s*(DONE|NEEDS YOU)\s*[:—–-]?\s*/i, '');
  report.textContent = text;
  report.hidden = !text;
}

function paintHelpersHead(card, lanes) {
  const all = [...lanes];
  const waiting = all.filter((l) => l.state === 'waiting').length;
  const working = all.filter((l) => l.state === 'working').length + waiting;
  const needs = all.filter((l) => l.state === 'needs').length;
  const sum = card.querySelector('.helpers-sum');
  const turn = waiting ? ' — ' + waiting + ' waiting for you' : '';
  if (working === all.length) sum.textContent = all.length + ' working at once' + turn;
  else if (working) sum.textContent = (all.length - working) + ' of ' + all.length + ' finished' + turn;
  else sum.textContent = 'All ' + all.length + ' finished' + (needs ? ' — ' + needs + ' need' + (needs === 1 ? 's' : '') + ' you' : '');
  card.classList.toggle('is-working', working > 0);
}

// The card, from a saved record or a new one.
function helpersCard(record) {
  const card = document.createElement('div');
  card.className = 'helpers';
  card.innerHTML =
    '<div class="helpers-head">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5"/></svg>' +
      '<b>Helpers</b><span class="helpers-sum"></span>' +
    '</div>' +
    '<div class="helpers-grid"></div>';
  const grid = card.querySelector('.helpers-grid');
  for (const l of record.lanes) {
    // A card replayed from history cannot still be working: whatever did not
    // report back was cut off when the run ended.
    if (!helpers || helpers.record !== record) { if (l.state === 'working' || l.state === 'waiting') l.state = 'stopped'; }
    const el = helperLane(l);
    el.dataset.id = l.id;
    grid.appendChild(el);
  }
  paintHelpersHead(card, record.lanes);
  return card;
}

function onHelperEvent(evt) {
  if (evt.type === 'helper_start') {
    // A new batch starts a new card; lanes of the same batch join it.
    if (!helpers || ![...helpers.lanes.values()].some((l) => l.data.state === 'working')) {
      closeGroup();
      hideDots();
      const record = { k: 'helpers', lanes: [] };
      helpers = { record, lanes: new Map(), card: null };
      helpers.card = helpersCard(record);
      turn('', '').appendChild(helpers.card);
      rec(record);
      showDots();
    }
    const data = { id: evt.helper, name: evt.helperName, task: evt.task, state: 'working', step: '', steps: 0, report: '' };
    helpers.record.lanes.push(data);
    const el = helperLane(data);
    el.dataset.id = data.id;
    helpers.card.querySelector('.helpers-grid').appendChild(el);
    helpers.lanes.set(data.id, { data, el });
    paintHelpersHead(helpers.card, helpers.record.lanes);
    save();
    return;
  }

  const lane = helpers && helpers.lanes.get(evt.helper);
  if (!lane) return;

  if (evt.type === 'helper_frame') {
    const img = lane.el.querySelector('.helper-shot img');
    img.src = 'data:image/jpeg;base64,' + evt.b64;
    img.hidden = false;
    return;
  }
  if (evt.type === 'handover') {
    lane.data.state = 'waiting';
    lane.data.what = evt.what;
    lane.data.hv = evt.id;
    turnOpened(evt.id);
  } else if (evt.type === 'handover_end') {
    turnClosed(evt.id);
    if (lane.data.state === 'waiting') lane.data.state = 'working';
    lane.data.hv = null;
    lane.data.step = evt.outcome === 'skipped' ? 'Skipped that step' : evt.outcome === 'timeout' ? 'Stopped waiting' : 'Carrying on';
  } else if (evt.type === 'helper_step') {
    lane.data.step = evt.text || evt.name;
    lane.data.steps += 1;
    actionCount += 1;
    actionsEl.textContent = actionCount + (actionCount === 1 ? ' action' : ' actions');
  } else if (evt.type === 'helper_done') {
    lane.data.state = evt.state;
    lane.data.report = evt.report || '';
    save();
  }
  paintLane(lane.el, lane.data);
  paintHelpersHead(helpers.card, helpers.record.lanes);
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

  // The agent stepping onto the user's own screen is the one action that moves
  // their real mouse, so it is called out rather than buried in the step list.
  if (evt.type === 'desktop') {
    if (mine) {
      turn('', screenCard(evt));
      rec({ k: 'screen', mine: evt.mine, reason: evt.reason, auto: evt.auto });
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

  // A reminder is the Windows notification main shows; nothing to draw here.
  if (evt.type === 'reminder') return;

  if (!mine) return;

  if (evt.type === 'helper_start' || evt.type === 'helper_step' || evt.type === 'helper_frame' || evt.type === 'helper_done') {
    onHelperEvent(evt);
    return;
  }
  // A helper's turn shows in its lane; the main agent's gets a card of its own.
  if (evt.type === 'handover' || evt.type === 'handover_end') {
    if (evt.helper) onHelperEvent(evt);
    else onHandover(evt);
    return;
  }

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

    // ── the check on the work ───────────────────────────────────
    // `done` has already ended the run visually by the time this arrives, so
    // the UI goes back to work while the second pass looks at what happened.
    case 'verify_start':
      closeGroup();
      resumeRun();
      break;

    case 'verify':
      closeGroup();
      hideDots();
      turn('', checkCard(evt));
      rec({ k: 'check', ok: evt.ok, why: evt.why });
      // A failed check sends the agent back for another go; anything else is
      // the end of the run, and `status: idle` is about to close it properly.
      if (evt.ok === false) showDots();
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
      turn('', errorCard(evt.title, evt.fix, evt.text));
      rec({ k: 'error', text: evt.text, title: evt.title, fix: evt.fix });
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
  // It is waiting on the user: what they type is the answer it asked for, and
  // the same task carries on with it — not a new task.
  if (task && override === undefined && answerTurn(task)) {
    input.value = '';
    resize();
    return;
  }
  if (!task || busy) return;

  await ensureChat();
  turn('you', '<span>' + youHtml(task) + '</span>');
  // The first thing you ask becomes its name. An agent is its conversation, so
  // that names both — but only while the agent is still called what it was born
  // called, or a task would rename an agent you had deliberately named yourself.
  if (!chat.turns.length) {
    chat.title = task.replace(/\s+/g, ' ').slice(0, 70);
    if (bot.name === 'New agent' || bot.name === 'New bot') {
      await window.operator.updateBot(bot.id, { name: chat.title.slice(0, 40) });
      bot.name = chat.title.slice(0, 40);
      paintFaces();
    }
  }
  rec({ k: 'you', text: task });

  // Remembered so the plan card's "Run it for real" can replay the same task.
  lastTask = task;
  plan = null;

  if (override === undefined) { input.value = ''; resize(); }
  startRun();
  await window.operator.runTask(task, runModel(), bot.id, chat.id, dryRun);
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

/* ── the dial beside a model picker ──────────────────────────────────
 * Effort, thinking, temperature — whichever of them the chosen model actually
 * has, remembered per model and per side. main.js owns the rules
 * (model-options.js); this only draws them and saves what you pick. One
 * instance beside each picker, Agents and Code.
 */

function makeTuner({ root, mode, current, nameOf }) {
  const btn = root.querySelector('.tuner-btn');
  const labelEl = root.querySelector('.tuner-label');
  const pop = root.querySelector('.tuner-pop');
  let id = null;
  let state = null;

  async function refresh() {
    id = current();
    if (!id) { root.hidden = true; return; }
    const asked = id;
    const s = await window.operator.modelOptions(mode, asked);
    if (asked !== id) return;               // the model changed while this was on its way
    state = s;
    root.hidden = !state.spec.length;
    labelEl.textContent = state.summary;
    btn.title = nameOf(id) + ' settings — ' + state.spec.map((o) => o.label.toLowerCase()).join(', ');
    if (!pop.hidden) paint();
  }

  function row(spec) {
    const wrap = document.createElement('div');
    wrap.className = 'tuner-row';
    const head = document.createElement('div');
    head.className = 'tuner-row-head';
    const name = document.createElement('span');
    name.className = 'tuner-name';
    name.textContent = spec.label;
    head.appendChild(name);
    wrap.appendChild(head);
    const value = state.values[spec.key];

    if (spec.type === 'choice') {
      const seg = document.createElement('div');
      seg.className = 'seg tuner-seg';
      for (const c of spec.choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn';
        b.textContent = c.label;
        b.setAttribute('aria-pressed', String(c.v === value));
        b.addEventListener('click', () => set(spec.key, c.v));
        seg.appendChild(b);
      }
      wrap.appendChild(seg);
    } else if (spec.type === 'toggle') {
      const sw = document.createElement('label');
      sw.className = 'switch';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(value);
      box.setAttribute('aria-label', spec.label);
      box.addEventListener('change', () => set(spec.key, box.checked));
      const knob = document.createElement('span');
      knob.className = 'knob';
      sw.append(box, knob);
      head.appendChild(sw);
    } else if (spec.type === 'range') {
      const out = document.createElement('span');
      out.className = 'tuner-value';
      out.textContent = Number(value).toFixed(1);
      head.appendChild(out);
      const r = document.createElement('input');
      r.type = 'range';
      r.className = 'tuner-range';
      r.min = spec.min; r.max = spec.max; r.step = spec.step;
      r.value = value;
      r.setAttribute('aria-label', spec.label);
      r.addEventListener('input', () => { out.textContent = Number(r.value).toFixed(1); });
      r.addEventListener('change', () => set(spec.key, Number(r.value)));
      wrap.appendChild(r);
    }

    const hint = document.createElement('p');
    hint.className = 'tuner-hint';
    hint.textContent = spec.hint;
    wrap.appendChild(hint);
    return wrap;
  }

  function paint() {
    pop.textContent = '';
    const top = document.createElement('div');
    top.className = 'tuner-top';
    const title = document.createElement('b');
    title.textContent = nameOf(id);
    const side = document.createElement('span');
    side.textContent = mode === 'code' ? 'in Code' : 'in Agents';
    top.append(title, side);
    pop.appendChild(top);
    for (const s of state.spec) pop.appendChild(row(s));
    const note = document.createElement('p');
    note.className = 'tuner-foot';
    note.textContent = 'Kept for this model. Applies from the next message.';
    pop.appendChild(note);
  }

  async function set(key, value) {
    state = await window.operator.setModelOptions(mode, id, { [key]: value });
    labelEl.textContent = state.summary;
    paint();
  }

  function open() {
    if (!state) return;
    paint();
    pop.hidden = false;
    root.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function close() {
    pop.hidden = true;
    root.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !root.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });

  return { refresh, close };
}

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

// The agent's own model when one is pinned in its panel — that is what runs,
// so it is what the picker shows and edits. Pinning used to change nothing:
// the picker's choice was always sent instead.
const pinnedModel = () => (bot && bot.model && models.some((m) => m.id === bot.model) ? bot.model : null);
const runModel = () => pinnedModel() || chosenModel;

function paintPicker() {
  const shown = runModel();
  const m = models.find((x) => x.id === shown);
  // A remembered NIM id before the catalog has loaded still has a readable
  // name in it — better than the button saying "Model" for a second.
  pickerName.textContent = m ? m.name
    : shown && shown.startsWith('nim:') ? shown.split('/').pop()
    : 'Model';
  // The label is clipped when the name is long, so the full one lives here.
  pickerBtn.title = m
    ? `${m.providerName} · ${m.note}` + (pinnedModel() ? ` — pinned to ${bot.name} in its settings` : '')
    : 'Which model runs the task';
  menuList.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.dataset.id === shown));
}

async function choose(id) {
  if (pinnedModel()) {
    // Changing the model on an agent that has its own changes its own.
    await window.operator.updateBot(bot.id, { model: id });
    bot.model = id;
  } else {
    chosenModel = id;
    remember(id);
  }
  paintPicker();
  tuner.refresh();
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
  tuner.refresh();
}

const tuner = makeTuner({
  root: document.getElementById('tuner'),
  mode: 'agents',
  current: runModel,
  nameOf: (id) => (models.find((m) => m.id === id) || { name: 'This model' }).name,
});
// Another agent, or its pinned model changed in its panel: repaint both.
window.__refreshModelUI = () => { paintPicker(); tuner.refresh(); };

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

/* ── hands-free ──────────────────────────────────────────────────────
 * The microphone button no longer dictates a task into the box. It opens a
 * conversation with Operator itself: a voice that makes agents, names them,
 * files them into workspaces, reads back what one of them said, and hands real
 * work to whichever agent should do it. See voice.js for the brain and the
 * tools, piper.js for the voice, ui/vox.js for playing it.
 *
 * It keeps listening the whole time. The only thing that stops it hearing its
 * own reply is that the microphone is ignored until the audio has finished
 * sounding — which Vox reports, because generating speech finishes long before
 * saying it does.
 */

const voxEl = document.getElementById('vox');
const voxLog = document.getElementById('voxLog');
const voxState = document.getElementById('voxState');
const voxVoiceEl = document.getElementById('voxVoice');
const voxBar = document.getElementById('voxBar');
const voxFill = document.getElementById('voxFill');
const voxMark = document.getElementById('voxMark');
const voxHint = document.getElementById('voxHint');
const voxDevice = document.getElementById('voxDevice');
const voxSetup = document.getElementById('voxSetup');
const voxGear = document.getElementById('voxGear');

// The microphone picker, the exact meter and the speaker test are for when
// something is wrong, so they stay folded away until asked for — or until
// something is wrong.
function voxShowSetup(open) {
  if (!voxSetup) return;
  voxSetup.hidden = !open;
  voxGear.setAttribute('aria-expanded', String(open));
  voxGear.classList.toggle('on', open);
  if (!voxEl.hidden) placeVox();
}
if (voxGear) voxGear.addEventListener('click', () => voxShowSetup(voxSetup.hidden));

const VOX_POS = 'operator.voxPos';
const VOX_MIC = 'operator.voxMic';

/* dragging the panel around */

// Parked where it was left, but never off the edge — a window that is smaller
// than it was last time would otherwise strand it somewhere unreachable.
function placeVox() {
  let at = null;
  try { at = JSON.parse(localStorage.getItem(VOX_POS) || 'null'); } catch { /* fine */ }
  const w = voxEl.offsetWidth || 320;
  const h = voxEl.offsetHeight || 260;
  const x = at ? Math.min(Math.max(8, at.x), window.innerWidth - w - 8) : window.innerWidth - w - 24;
  const y = at ? Math.min(Math.max(8, at.y), window.innerHeight - h - 8) : window.innerHeight - h - 136;
  voxEl.style.left = x + 'px';
  voxEl.style.top = y + 'px';
}

if (voxBar) {
  voxBar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vox-x')) return;      // the close button is not a handle
    const box = voxEl.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    voxEl.classList.add('lifted');
    voxBar.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const x = Math.min(Math.max(4, ev.clientX - dx), window.innerWidth - box.width - 4);
      const y = Math.min(Math.max(4, ev.clientY - dy), window.innerHeight - box.height - 4);
      voxEl.style.left = x + 'px';
      voxEl.style.top = y + 'px';
    };
    const up = () => {
      voxBar.removeEventListener('pointermove', move);
      voxBar.removeEventListener('pointerup', up);
      voxEl.classList.remove('lifted');
      try { localStorage.setItem(VOX_POS, JSON.stringify({ x: parseInt(voxEl.style.left, 10), y: parseInt(voxEl.style.top, 10) })); } catch { /* fine */ }
    };
    voxBar.addEventListener('pointermove', move);
    voxBar.addEventListener('pointerup', up);
  });
}
window.addEventListener('resize', () => { if (!voxEl.hidden) placeVox(); });

/* the level meter: proof the microphone is hearing you */

// RMS is tiny and bunched near zero, so a straight mapping leaves the bar
// twitching in the first pixel. The square root spreads quiet speech across
// most of the bar, which is where the useful signal is.
const voxScale = (v) => Math.min(1, Math.sqrt(Math.max(0, v) / 0.25));

let voxSeen = 0;      // loudest thing heard since the panel opened

function voxLevel({ level, threshold, speaking: talking }) {
  if (voxEl.hidden) return;
  voxFill.style.width = (voxScale(level) * 100).toFixed(1) + '%';
  voxMark.style.left = (voxScale(threshold) * 100).toFixed(1) + '%';
  voxEl.style.setProperty('--lvl', voxScale(level).toFixed(3));
  voxEl.classList.toggle('loud', Boolean(talking));
  if (level > voxSeen) voxSeen = level;
  micBtn.classList.toggle('hearing', Boolean(talking));
}

// If nothing has moved the bar at all after a few seconds, say so plainly
// rather than leaving someone talking at a dead microphone.
let voxWatch = null;
function watchForSilence() {
  clearInterval(voxWatch);
  voxSeen = 0;
  const started = Date.now();
  voxWatch = setInterval(() => {
    if (voxEl.hidden) return;
    if (voxSeen > 0.004) {
      voxHint.textContent = 'Microphone is working — just talk.';
      voxHint.classList.remove('bad');
      clearInterval(voxWatch);
    } else if (Date.now() - started > 6000) {
      voxHint.textContent = 'Nothing coming in. Try another microphone below, or check Windows sound settings.';
      voxHint.classList.add('bad');
      if (voxSetup.hidden) voxShowSetup(true);
    }
  }, 700);
}

/* which microphone */

async function fillDevices() {
  if (!voxDevice) return;
  const list = await MicListener.devices();
  const picked = (() => { try { return localStorage.getItem(VOX_MIC) || ''; } catch { return ''; } })();
  voxDevice.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default microphone';
  voxDevice.appendChild(auto);
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.label;
    voxDevice.appendChild(o);
  }
  const now = MicListener.current();
  voxDevice.value = picked && list.some((d) => d.id === picked) ? picked : (now && list.some((d) => d.id === now.id) ? now.id : '');
}

if (voxDevice) {
  voxDevice.addEventListener('change', async () => {
    try { localStorage.setItem(VOX_MIC, voxDevice.value); } catch { /* fine */ }
    // Swapping input means re-opening the stream; the conversation is untouched.
    MicListener.stop();
    voxHint.textContent = 'Switching…';
    voxHint.classList.remove('bad');
    try {
      await MicListener.start({ onUtterance: heardSomething, onState: voxLevel, deviceId: voxDevice.value || undefined });
      voxHint.textContent = 'Say something — the ring should move.';
      watchForSilence();
    } catch (err) {
      voxHint.textContent = 'Could not open that microphone: ' + err.message;
      voxHint.classList.add('bad');
    }
  });
}

function voxSay(kind, text) {
  if (!voxLog) return;
  const line = document.createElement('div');
  line.className = 'vox-line ' + kind;
  line.textContent = text;
  voxLog.appendChild(line);
  while (voxLog.children.length > 8) voxLog.firstChild.remove();
  voxLog.scrollTop = voxLog.scrollHeight;
  // The panel grows as the log fills; re-placing keeps it clear of the window
  // edge (and, when it has never been moved, clear of the composer).
  placeVox();
  return line;
}

// What it just did, in the words a person would use. The tool names are for
// the model; this row is for the human watching.
function voxToolLine(name, a) {
  switch (name) {
    case 'make_agent': return 'made the agent "' + (a.name || '') + '"';
    case 'configure_agent': return 'changed ' + (a.name || 'an agent');
    case 'delete_agent': return 'deleted ' + (a.name || 'an agent');
    case 'open_agent': return 'opened ' + (a.name || 'an agent');
    case 'remember_for_agent': return (a.name || 'an agent') + ' will remember that';
    case 'make_workspace': return 'made the workspace "' + (a.name || '') + '"';
    case 'rename_workspace': return 'renamed "' + (a.name || '') + '" to "' + (a.newName || '') + '"';
    case 'delete_workspace': return 'deleted the workspace "' + (a.name || '') + '"';
    case 'file_agent': return 'filed ' + (a.name || '') + ' into ' + (a.workspace || 'the list');
    case 'send_to_agent': return 'sent ' + (a.name || 'an agent') + ': ' + String(a.task || '').slice(0, 70);
    case 'read_agent': return 'read what ' + (a.name || 'an agent') + ' said';
    case 'list_agents': return 'looked at the agents';
    case 'list_workspaces': return 'looked at the workspaces';
    default: return name.replace(/_/g, ' ');
  }
}

function voxStatus(word) {
  if (voxState) voxState.textContent = word;
  if (voxEl) voxEl.dataset.state = word.toLowerCase();
}

// Anything that goes wrong is said IN the panel. Hiding it and dropping a card
// into the transcript is how the first version managed to look like a button
// that did nothing at all.
function voxFail(what) {
  voxStatus('Stopped');
  voxHint.textContent = what;
  voxHint.classList.add('bad');
}

async function setVoice(on) {
  if (on) {
    showHeard('');
    voxEl.hidden = false;
    placeVox();
    voxLog.textContent = '';
    voxVoiceEl.textContent = '';
    voxHint.classList.remove('bad');
    voxShowSetup(false);
    voxStatus('Starting');

    // The microphone comes FIRST. It is the part that actually fails — a denied
    // permission, a device in use, no input at all — and asking for it first
    // means the panel can say so in a second rather than after Whisper has
    // spent ten of them loading a 3 GB model for nothing.
    voxHint.textContent = 'Asking for the microphone…';
    try {
      const pick = (() => { try { return localStorage.getItem(VOX_MIC) || ''; } catch { return ''; } })();
      await MicListener.start({ onUtterance: heardSomething, onState: voxLevel, deviceId: pick || undefined });
    } catch (err) {
      voxFail(err && err.name === 'NotAllowedError'
        ? 'Windows or Electron blocked the microphone. Check Settings → Privacy → Microphone.'
        : 'Could not open the microphone: ' + (err && err.message ? err.message : err));
      voxShowSetup(true);
      paintMic();
      return;
    }

    voiceOn = true;
    paintMic();
    await fillDevices();
    voxHint.textContent = 'Say something — the ring should move.';
    watchForSilence();
    voxStatus('Listening');

    // Now the slow parts, with the meter already live so there is something to
    // look at — and something to tell you the microphone is fine even while
    // the model is still loading.
    const warm = await window.operator.whisperWarm();
    if (!warm.ok) { voxFail('Whisper: ' + warm.error); return; }

    const v = await window.operator.voiceWarm();
    voxVoiceEl.textContent = v.tts === 'piper' ? 'Neural voice · Whisper large-v3' : 'Windows voice · Whisper large-v3';
    if (v.ttsError) voxVoiceEl.textContent += ' (no neural voice: ' + v.ttsError + ')';
    voxRate = v.rate || 22050;
  } else {
    voiceOn = false;
    clearInterval(voxWatch);
    MicListener.stop();
    Vox.stop();
    window.operator.voiceQuiet();
    window.operator.voiceEnd();
    voxEl.hidden = true;
    showHeard('');
  }
  paintMic();
}

let voxRate = 22050;
let voxBusy = false;   // a turn is in flight

if (document.getElementById('voxStop')) {
  document.getElementById('voxStop').addEventListener('click', () => setVoice(false));
}

// Proof the speaking half reaches your speakers, without having to hold a
// conversation to find out. It reports what the audio layer actually did, so
// "nothing was generated" and "it played and you did not hear it" are told
// apart — which is the difference between a bug here and the wrong output
// device in Windows.
if (document.getElementById('voxTest')) {
  document.getElementById('voxTest').addEventListener('click', async () => {
    Vox.resetStats();
    const before = Vox.stats();
    voxHint.textContent = 'Saying a test line…';
    voxHint.classList.remove('bad');
    const r = await window.operator.voiceTest();
    setTimeout(() => {
      const st = Vox.stats();
      if (st.seconds > 0.2) {
        voxHint.textContent = `Played ${st.seconds.toFixed(1)}s through ${r.via === 'piper' ? 'the neural voice' : 'the Windows voice'}. If you heard nothing, check the output device in Windows.`;
        voxHint.classList.remove('bad');
      } else {
        voxHint.textContent = `No audio came back (audio ${st.state}${st.queued ? ', ' + st.queued + ' chunks stuck waiting' : ''}).` + (r.note ? ' ' + r.note : '');
        voxHint.classList.add('bad');
      }
    }, 2500);
  });
}

// Audio arriving from piper.js, chunk by chunk.
window.operator.onVoiceAudio((evt) => {
  if (!voiceOn) return;
  if (evt.ev === 'pcm') {
    if (!speaking) { speaking = true; voxStatus('Talking'); paintMic(); }
    Vox.play(evt.b64, evt.rate || voxRate);
  } else if (evt.ev === 'hush') {
    Vox.stop();
  }
});

// Only once the sound has actually stopped is it safe to listen again.
Vox.setDoneListener(() => {
  speaking = false;
  MicListener.discard();
  paintMic();
  if (voiceOn) voxStatus('Listening');
});

// The voice changed something in the rail underneath us.
window.operator.onVoiceChanged(async () => {
  await loadSpaces();
  await loadBots(bot && bot.id);
  await paintRail();
});

// …or put a different agent on screen.
window.operator.onVoiceOpen(async ({ botId }) => {
  const b = (await window.operator.listBots()).find((x) => x.id === botId);
  if (b) await openAgent(b.id, b.threads.length ? b.threads[0].id : null);
});

micBtn.addEventListener('click', () => setVoice(!voiceOn));

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

  voxStatus('Hearing');
  const res = await window.operator.whisperTranscribe(wav);

  if (!res.ok) {
    voxStatus('Listening');
    voiceProblem('Voice', res.error);
    return;
  }

  const text = (res.text || '').trim();
  if (!text) { voxStatus('Listening'); return; }

  if (!worthRunning(text)) { voxStatus('Listening'); return; }
  // A turn already in flight. Starting another on top of it is how a reply gets
  // talked over by the next question — and with background noise producing a
  // steady drip of near-misses, it happens constantly.
  if (voxBusy) { voxStatus('Listening'); return; }

  showHeard('');
  voxSay('you', text);
  voxStatus('Thinking');
  voxBusy = true;

  let said;
  try {
    said = await window.operator.voiceHeard(text, bot && bot.name);
  } finally {
    voxBusy = false;
  }
  if (!said.ok) { voxStatus('Listening'); voiceProblem('Voice', said.error); }
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

    // the hands-free voice: what it is saying and what it is doing
    case 'voice':
      if (evt.type === 'say') voxSay('said', evt.text);
      else if (evt.type === 'tool') voxSay('did', voxToolLine(evt.name, evt.input || {}));
      else if (evt.type === 'done' && !Vox.speaking()) voxStatus('Listening');
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
  // In hands-free mode the assistant is the one talking. Reading an agent's
  // reply out at the same time puts two voices over each other; ask it what the
  // agent said instead and it will tell you.
  if (!voiceOn) return;
  if (voxEl && !voxEl.hidden) return;
  const key = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key || key === lastSpoken) return;
  lastSpoken = key;
  speaking = true;
  MicListener.discard();
  paintMic();
  window.operator.voiceSay(text);
}

input.focus();

/* ── the start screen ────────────────────────────────────────────────
 * What the app opens on: make a new agent, or search the ones you already
 * have and open one. The main agent's fresh chat is set up underneath before
 * this shows, so skipping it (Esc) is instant.
 */

const launchEl = document.getElementById('launch');
const launchSearch = document.getElementById('launchSearch');
const launchList = document.getElementById('launchList');
const launchCount = document.getElementById('launchCount');
const launchNewLabel = document.getElementById('launchNewLabel');
let launchPick = 0;   // the highlighted row, for the arrow keys

// On its way out counts as gone, so a key pressed mid-exit is the chat's.
const launchOpen = () => !launchEl.hidden && !launchEl.classList.contains('leaving');

// Most recent conversation first — the same order the rail reads in.
const lastTouched = (b) => Math.max(b.updatedAt || 0, ...b.threads.map((t) => t.updatedAt || 0));

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (!ms || s < 0) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return when(ms);
}

// Every word typed has to turn up somewhere: the name, what it does, what it
// last said, its workspace or the title of one of its conversations.
function launchMatches() {
  const words = launchSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = bots.slice().sort((a, z) => lastTouched(z) - lastTouched(a));
  if (!words.length) return list;
  return list.filter((b) => {
    const ws = spaces.find((w) => w.id === b.workspaceId);
    const hay = [b.name, b.title, b.lastLine, b.role, ws && ws.name, ...b.threads.map((t) => t.title)]
      .filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function markPick() {
  launchList.querySelectorAll('.launch-row').forEach((row, i) => {
    row.classList.toggle('on', i === launchPick);
    row.setAttribute('aria-selected', String(i === launchPick));
    if (i === launchPick) row.scrollIntoView({ block: 'nearest' });
  });
}

// `typed`: repainted by the search, so the rows get a quick fade of their own.
// It is a class on the rows rather than taking `arriving` off the screen, because
// swapping that restarts every row's animation — they all blinked on exit.
function paintLaunch(typed) {
  const q = launchSearch.value.trim();
  const found = launchMatches();
  launchPick = Math.min(launchPick, Math.max(0, found.length - 1));
  // Searching for something that is not there is usually the name of the
  // agent you were about to make, so the button offers exactly that.
  launchNewLabel.textContent = q && !found.length ? 'Create "' + trim(q, 40) + '"' : 'Create a new agent';
  launchCount.textContent = q ? found.length + ' of ' + bots.length : bots.length + (bots.length === 1 ? ' agent' : ' agents');
  launchList.textContent = '';

  if (!found.length) {
    const p = document.createElement('p');
    p.className = 'launch-empty' + (typed ? ' typed' : '');
    p.textContent = 'No agent matches "' + q + '". Press Enter to make one called that.';
    launchList.appendChild(p);
    return;
  }

  found.forEach((b, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'launch-row' + (i === launchPick ? ' on' : '') + (typed ? ' typed' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === launchPick));
    row.style.setProperty('--i', Math.min(i, 10));   // its place in the rise-in; the tail arrives together
    row.appendChild(Avatar.el(b.face, 32, 'idle'));

    const text = document.createElement('span');
    text.className = 'launch-text';
    const name = document.createElement('span');
    name.className = 'launch-name';
    const label = document.createElement('b');
    label.textContent = b.name;
    name.appendChild(label);
    if (b.role) {
      const tag = document.createElement('span');
      tag.className = 'role-tag is-' + b.role;
      tag.textContent = b.role === 'coordinator' ? 'coord' : 'main';
      name.appendChild(tag);
    }
    const line = document.createElement('small');
    line.textContent = b.lastLine || b.title || 'Nothing yet';
    text.append(name, line);

    const meta = document.createElement('span');
    meta.className = 'launch-meta';
    const ws = spaces.find((w) => w.id === b.workspaceId);
    if (ws) {
      const chip = document.createElement('span');
      chip.className = 'launch-ws';
      chip.textContent = ws.name;
      meta.appendChild(chip);
    }
    const at = document.createElement('span');
    at.textContent = ago(lastTouched(b));
    meta.appendChild(at);
    // Shown on the highlighted row only: Enter opens this one.
    meta.insertAdjacentHTML('beforeend', '<svg class="launch-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v4.5a2 2 0 0 0 2 2h8M15.5 10l3.5 3.5-3.5 3.5"/></svg>');

    row.append(text, meta);
    row.addEventListener('click', () => launchInto(b));
    row.addEventListener('mousemove', () => { if (launchPick !== i) { launchPick = i; markPick(); } });
    launchList.appendChild(withBin(row, 'launch-item', b));
  });
}

let launchTimer = null;
let launchBusy = false;   // a choice is loading underneath; ignore a second one

const EXIT_MS = 240;      // matches .launch.leaving in styles.css
const stillMotion = () =>
  document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
// Two frames: the first lets the new content be laid out, the second paints it.
// A hidden or minimised window gets no frames at all, so never wait past 100ms.
const painted = () => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 100); });

// `quick`: opened again as a switcher (Ctrl+K), not as the welcome. It fades
// in without the staggered entrance, and the highlight starts on the agent
// before the one you are in — Alt+Tab, so Enter alone swaps back.
function showLaunch(quick) {
  clearTimeout(launchTimer);
  launchBusy = false;
  launchSearch.value = '';
  launchPick = 0;
  // Opening an agent does not make it recent — talking to it does — so look
  // for it rather than assuming it is at the top.
  if (quick === true && bot) launchPick = Math.max(0, launchMatches().findIndex((b) => b.id !== bot.id));
  paintLaunch();
  document.getElementById('launchTitle').textContent = quick === true ? 'Your agents' : 'Welcome to Operator';
  document.getElementById('launchSkipText').textContent = quick === true ? 'Back to where you were' : 'Skip — just start a chat';
  launchEl.classList.remove('leaving');
  launchEl.classList.toggle('arriving', quick !== true);
  launchEl.hidden = false;
  launchSearch.focus();
}

// Lifts away over whatever was chosen. Resolves once it has gone, for the one
// caller that has to wait (the new agent's panel). `now` skips the animation:
// motion off, or a switch to Code where the whole view changes underneath.
function hideLaunch(now) {
  if (!launchOpen()) return Promise.resolve();
  clearTimeout(launchTimer);
  return new Promise((done) => {
    const gone = () => {
      launchEl.hidden = true;
      launchEl.classList.remove('leaving', 'arriving', 'behind', 'pointer');
      input.focus();
      done();
    };
    if (now === true || stillMotion()) return gone();
    launchEl.classList.add('leaving');
    launchTimer = setTimeout(gone, EXIT_MS);
  });
}

// Opens the conversation the agent had last, the same one its rail row opens.
// The chat is built under the start screen first and only then does the
// screen lift off it — building it mid-exit is what made the exit stutter.
async function launchInto(b) {
  if (launchBusy || !launchOpen()) return;
  launchBusy = true;
  await openAgent(b.id, b.threads[0] ? b.threads[0].id : null);
  await painted();
  hideLaunch();
}

let launchMade = null;   // the agent Create made, while its panel is up

// The panel grows out of the Create button, over the start screen, in the same
// frame as the click — the agent is made while it moves, rather than the
// screen leaving first and the panel turning up a beat later.
// The card is animated from the button's box to its own by transform alone.
function growSheet(from, name) {
  const card = sheet.querySelector('.sheet-card');
  // What can be shown before the agent exists, so the card is never blank or
  // still showing whichever agent was open last.
  sheetFace.textContent = '';
  sheetTitle.textContent = name;
  fName.value = name;
  fTitle.value = '';
  fPersona.value = '';
  sheetDone.textContent = 'Create agent';
  sheet.classList.add('grow');
  sheet.hidden = false;
  setTimeout(() => sheet.classList.remove('grow'), 1100);   // after the fields have risen in
  if (stillMotion()) return Promise.resolve();

  const to = card.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return card.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})` },
    { transform: 'none' },
  ], { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }).finished.catch(() => {});
}

// Made the way the rail's New makes one, then into its panel so it gets a real
// name and a job rather than staying "New agent". The start screen stays put
// behind the panel and only leaves once the panel is done with.
async function launchCreate() {
  if (launchBusy || !launchOpen()) return;
  launchBusy = true;
  const q = launchSearch.value.trim();
  const name = q && !launchMatches().length ? q.slice(0, 40) : 'New agent';

  launchEl.classList.add('behind');
  const grown = growSheet(document.getElementById('launchNew').getBoundingClientRect(), name);
  const made = await makeAgent({ name, title: '' });
  if (!made) {                      // at the limit: nothing was made, so put it all back
    sheet.hidden = true;
    launchEl.classList.remove('behind');
    launchBusy = false;
    return;
  }
  launchMade = made.id;
  openSheet(true);                  // fills in the card that is already on screen
  await grown;
}

// Its panel has closed. If the agent is still there, the start screen has done
// its job and lifts off that agent's chat; if it was deleted from the panel,
// stay here, with the list as it now is.
async function settleLaunch() {
  const id = launchMade;
  launchMade = null;
  if (id && await window.operator.getBot(id)) return hideLaunch();
  launchEl.classList.remove('behind');
  launchBusy = false;
  await loadBots();
  paintLaunch(true);
  launchSearch.focus();
}

document.getElementById('launchNew').addEventListener('click', launchCreate);
document.getElementById('launchSkip').addEventListener('click', () => hideLaunch());
launchSearch.addEventListener('input', () => { launchPick = 0; paintLaunch(true); });
launchSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = launchMatches().length;
    if (!n) return;
    launchPick = (launchPick + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    markPick();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const found = launchMatches();
    if (found.length) launchInto(found[launchPick]);
    else launchCreate();
  }
});

// Esc clears the search first, then leaves. Ctrl+N here means a new agent,
// not the new-chat it means everywhere else, so the later handler never sees it.
document.addEventListener('keydown', (e) => {
  if (!launchOpen() || !sheet.hidden) return;   // a panel over it takes the keys
  if (e.key === 'Escape') {
    e.preventDefault();
    if (launchSearch.value) { launchSearch.value = ''; launchPick = 0; paintLaunch(true); }
    else hideLaunch();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    e.stopImmediatePropagation();
    launchCreate();
  }
});

// Switching to Code is also a way out — at once, since the whole view is
// being swapped underneath anyway.
document.querySelectorAll('.mode').forEach((m) => m.addEventListener('click', () => hideLaunch(true)));

// An agent made or renamed by voice or a routine shows up while you look.
window.operator.onBotsChanged(() => { if (launchOpen()) loadBots().then(() => paintLaunch(true)); });

// Ctrl+K, or the magnifier in the rail: the start screen again, as a way to
// jump to any agent. Works from Code mode too — it brings you back to Agents.
// Pressed again it closes. Not over a panel or the full-screen view.
function findAgent() {
  if (!sheet.hidden || !document.getElementById('settingsSheet').hidden || window.__watchOpen) return;
  if (launchOpen()) { hideLaunch(); return; }
  const shell = document.querySelector('.shell');
  if (shell && shell.hidden) document.querySelector('.mode[data-mode="agents"]').click();
  showLaunch(true);
}
document.getElementById('findBtn').addEventListener('click', findAgent);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
  e.preventDefault();
  findAgent();
});

/* the moving background: colour drifting behind, motes rising through it, and
   a glow that trails the pointer. Everything moves by transform alone, so it
   is the GPU's work and the page never repaints for it. */

const launchBg = document.getElementById('launchBg');
const launchSpot = document.getElementById('launchSpot');

// Motes: scattered once, each on its own slow loop, started part-way through
// (negative delays) so they never rise in step.
for (let i = 0; i < 12; i++) {
  const m = document.createElement('i');
  m.style.left = (Math.random() * 100).toFixed(1) + '%';
  m.style.top = (15 + Math.random() * 85).toFixed(1) + '%';
  m.style.setProperty('--s', (1 + Math.random()).toFixed(1) + 'px');
  m.style.animationDuration = (18 + Math.random() * 14).toFixed(1) + 's';
  m.style.animationDelay = (-Math.random() * 32).toFixed(1) + 's';
  document.getElementById('launchMotes').appendChild(m);
}

// The glow eases after the pointer and the colour behind shifts a little the
// other way, which is what gives it depth. Two transforms a frame, and only
// while the glow is still catching up — nothing runs once it has arrived.
let spot = null;      // where the glow is
let aim = null;       // where it is heading
let spotFrame = 0;

function spotStep() {
  spot.x += (aim.x - spot.x) * 0.12;
  spot.y += (aim.y - spot.y) * 0.12;
  launchSpot.style.transform = `translate3d(${spot.x}px, ${spot.y}px, 0)`;
  launchBg.style.transform = `translate3d(${(spot.x / innerWidth - 0.5) * -12}px, ${(spot.y / innerHeight - 0.5) * -8}px, 0)`;
  const moving = Math.abs(aim.x - spot.x) + Math.abs(aim.y - spot.y) > 0.4;
  spotFrame = moving && launchOpen() ? requestAnimationFrame(spotStep) : 0;
}

launchEl.addEventListener('pointermove', (e) => {
  if (stillMotion()) return;
  aim = { x: e.clientX, y: e.clientY - launchEl.offsetTop };   // the screen starts under the mode bar
  if (!spot) spot = { ...aim };
  launchEl.classList.add('pointer');
  if (!spotFrame) spotFrame = requestAnimationFrame(spotStep);
});
launchEl.addEventListener('pointerleave', () => launchEl.classList.remove('pointer'));

/* ── start ───────────────────────────────────────────────────────── */

(async () => {
  setRail(recall(RAIL_OPEN) === '1');
  await loadSpaces();
  await loadBots();
  // Opening the app opens a new chat, the way a chat app does: the main agent,
  // an empty box and suggestions. Everything from before is one click away in
  // the rail, and nothing is created until the first message is sent.
  const home = bots.find((b) => b.pinned && b.role === 'main') || bots.find((b) => b.pinned) || bot;
  await startFresh(home && home.id);
  // …with the start screen over the top, so the first choice is which agent.
  showLaunch();
})();

// New chat: back to the start screen with whoever you are talking to now.
const newThreadBtn = document.getElementById('newThreadBtn');
if (newThreadBtn) newThreadBtn.addEventListener('click', () => startFresh(bot && bot.id));
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'n') return;
  if (!document.querySelector('.shell') || document.querySelector('.shell').hidden) return;  // Code mode has its own
  e.preventDefault();
  startFresh(bot && bot.id);
});

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
      // Still saved, but Google has ended the sign-in: say so, and put the
      // way back in right there, instead of "connected" over a dead inbox.
      const expired = Boolean(connected && em.expired);
      conn.classList.toggle('on', connected && !expired);
      conn.classList.toggle('expired', expired);
      disconnectBtn.hidden = !connected;
      accountBox.hidden = !connected;
      signinBox.hidden = connected && !expired;
      // Drives which provider mark the header shows. Unknown providers fall
      // back to the generic envelope rather than guessing at a logo.
      conn.dataset.provider = connected && em.provider ? em.provider.toLowerCase() : '';
      if (connected) {
        sub.textContent = expired ? 'Sign-in expired — sign in again' : em.provider ? em.provider : 'Connected';
        acctEmail.textContent = em.email || '';
        acctAvatar.textContent = (em.email || '@').trim().charAt(0).toUpperCase();
        acctMeta.textContent = expired
          ? 'Google ended this sign-in, so agents cannot read codes from it. Sign in again below — or use an app password, which never expires.'
          : (em.provider || 'Email') + ' · agents can read and send';
        if (expired) reveal(form, altToggle, true);   // the app password: never expires
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
  const codeMain = document.getElementById('codeMain');
  const titleEl = document.getElementById('codeTitle');
  const pathEl = document.getElementById('codePath');
  const edBtn = document.getElementById('codeEditorBtn');
  const refsEl = document.getElementById('codeRefs');
  const dropEl = document.getElementById('codeDrop');
  const attachBtn = document.getElementById('codeAttachBtn');
  const attachMenu = document.getElementById('codeAttachMenu');
  const edEl = document.getElementById('editor');
  const edResize = document.getElementById('edResize');

  let chat = null;
  let lastList = [];            // the sidebar's chats, newest first
  let refs = [];                // what is attached to the message being written
  const manualRoot = new Map(); // chat id -> a folder opened in the editor by hand

  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  // C:\Users\name\… reads as ~\… — the part that is the same on every path.
  const tilde = (p) => String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');

  /* ── the editor panel ── */

  // The folder the editor should show for a chat: whatever it built, or where
  // it works — unless you opened something else in the editor yourself.
  const chatRoot = (c) => (c ? (c.project || c.cwd || null) : null);
  function syncEditorRoot() {
    const fallback = lastList[0] ? chatRoot(lastList[0]) : null;
    const want = (chat && manualRoot.get(chat.id)) || chatRoot(chat) || fallback;
    if (want) editor.setRoot(want);
  }

  const editor = window.CodeEditor.mount(edEl, {
    onReference: (r) => addRefs([r]),
    onUseFolder: async (dir) => {
      await ensureChat();
      const r = await window.operator.codeSetFolder(chat.id, dir);
      if (!r || !r.ok) return;
      chat.cwd = r.cwd; chat.cwdName = r.name; chat.project = null;
      manualRoot.delete(chat.id);
      paintFolder();
      loadHistory();
    },
    onRootPicked: (p) => { if (chat) manualRoot.set(chat.id, p); },
    onToggle: (on) => {
      edResize.hidden = !on;
      edBtn.setAttribute('aria-pressed', String(on));
      edBtn.title = on ? 'Hide the editor (Ctrl+E)' : 'Show the editor (Ctrl+E)';
    },
  });

  function openEditor() {
    syncEditorRoot();
    editor.show();
  }
  edBtn.addEventListener('click', () => (editor.isOpen() ? editor.hide() : openEditor()));
  pathEl.addEventListener('click', () => {
    if (chat) manualRoot.delete(chat.id);
    openEditor();
  });

  // Ctrl+E, from anywhere in Code mode.
  document.addEventListener('keydown', (e) => {
    if (codeView.hidden) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (editor.isOpen()) editor.hide(); else openEditor();
    }
  });

  // Coming back to Code mode puts the editor back the way you left it.
  modes.forEach((m) => m.addEventListener('click', () => {
    if (m.dataset.mode === 'code' && editor.wasOpen() && !editor.isOpen()) {
      window.operator.codeChatsList().then((list) => { lastList = list || []; openEditor(); });
    }
  }));

  // The split between the chat and the editor, dragged by the line between.
  (function resizer() {
    const KEY = 'operator.editor.width';
    try { const w = localStorage.getItem(KEY); if (w) codeView.style.setProperty('--ed-w', w); } catch (_) { /* fine */ }
    edResize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      edResize.setPointerCapture(e.pointerId);
      edResize.classList.add('dragging');
      document.body.classList.add('ed-dragging');
      const box = codeView.getBoundingClientRect();
      const move = (ev) => {
        const w = Math.min(Math.max(380, box.right - ev.clientX), box.width * 0.78);
        codeView.style.setProperty('--ed-w', Math.round(w) + 'px');
      };
      const up = () => {
        edResize.removeEventListener('pointermove', move);
        edResize.removeEventListener('pointerup', up);
        edResize.classList.remove('dragging');
        document.body.classList.remove('ed-dragging');
        try { localStorage.setItem(KEY, codeView.style.getPropertyValue('--ed-w')); } catch (_) { /* fine */ }
      };
      edResize.addEventListener('pointermove', move);
      edResize.addEventListener('pointerup', up);
    });
  })();

  /* ── references: folders and files attached to a message ── */

  const REF_ICON = {
    dir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  const refChip = (r, extra = '') =>
    '<span class="code-ref' + (r.dir ? ' dir' : '') + '" title="' + esc2(r.path) + '" data-p="' + esc2(r.path) + '" data-dir="' + (r.dir ? 1 : '') + '">' +
    (r.dir ? REF_ICON.dir : REF_ICON.file) + '<span>' + esc2(baseName(r.path)) + '</span>' + extra + '</span>';

  function paintRefs() {
    refsEl.hidden = !refs.length;
    refsEl.innerHTML = refs.map((r, i) => refChip(r, '<button type="button" data-i="' + i + '" aria-label="Remove">' + REF_ICON.x + '</button>')).join('');
  }
  function addRefs(list) {
    for (const r of list || []) {
      if (!r || !r.path || refs.some((x) => samePath(x.path, r.path))) continue;
      refs.push({ path: r.path, dir: Boolean(r.dir) });
    }
    paintRefs();
    input.focus();
  }
  refsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    refs.splice(Number(b.dataset.i), 1);
    paintRefs();
  });

  // A reference under a sent message opens in the editor: a folder as the
  // tree, a file as a tab.
  thread.addEventListener('click', (e) => {
    const chip = e.target.closest('.you-refs .code-ref');
    if (!chip) return;
    if (chip.dataset.dir) { if (chat) manualRoot.set(chat.id, chip.dataset.p); editor.setRoot(chip.dataset.p); editor.show(); }
    else editor.openFile(chip.dataset.p);
  });

  // Anything dropped on the chat — from Explorer, or out of the editor's tree.
  let dragDepth = 0;
  const droppable = (e) => {
    const types = [...((e.dataTransfer && e.dataTransfer.types) || [])];
    return types.includes('Files') || types.includes('application/x-operator-ref');
  };
  codeMain.addEventListener('dragenter', (e) => {
    if (!droppable(e)) return;
    e.preventDefault();
    dragDepth++;
    dropEl.hidden = false;
  });
  codeMain.addEventListener('dragover', (e) => {
    if (!droppable(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  codeMain.addEventListener('dragleave', (e) => {
    if (!droppable(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropEl.hidden = true;
  });
  codeMain.addEventListener('drop', async (e) => {
    if (!droppable(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    // Read everything off the event before the first await; it is emptied
    // as soon as this handler yields.
    const internal = e.dataTransfer.getData('application/x-operator-ref');
    const dropped = [...e.dataTransfer.files].map((f) => window.operator.pathForFile(f)).filter(Boolean);
    const got = [];
    if (internal) { try { got.push(JSON.parse(internal)); } catch (_) { /* not ours after all */ } }
    for (const p of dropped) {
      const st = await window.operator.fsStat(p);
      got.push({ path: p, dir: Boolean(st && st.ok && st.dir) });
    }
    addRefs(got);
  });

  // A file dropped anywhere else must not replace the app with itself.
  ['dragover', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  }));

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenu.hidden = !attachMenu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!attachMenu.hidden && !attachMenu.contains(e.target)) attachMenu.hidden = true;
  });
  attachMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    attachMenu.hidden = true;
    if (b.dataset.pick === 'files') {
      const r = await window.operator.fsPickFiles();
      if (r && r.ok) addRefs(r.paths.map((p) => ({ path: p, dir: false })));
    } else {
      const r = await window.operator.fsPickFolder();
      if (r && r.ok) addRefs([{ path: r.path, dir: true }]);
    }
  });
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
    lastList = list || [];
    // The sidebar is where a new title or project shows up first; keep the
    // chat on screen in step with it.
    const mine = chat && list.find((c) => c.id === chat.id);
    if (mine) { chat.title = mine.title; chat.project = mine.project; chat.cwd = mine.cwd; chat.cwdName = mine.cwdName; paintFolder(); }
    paintHistory();
    paintRecent();
  }

  // Titles written before they were cleaned up at the source: no markdown,
  // and not in capitals.
  function niceTitle(t) {
    let s = String(t || '').replace(/^[#>*\-+\s]+/, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (letters.length > 6 && letters === letters.toUpperCase()) s = s.charAt(0) + s.slice(1).toLowerCase();
    return s || 'New chat';
  }

  // Where a chat's work lives, when it is somewhere worth naming — the
  // default workspace is where everything starts, so saying so says nothing.
  const placeOf = (c) => (c.project ? baseName(c.project) : c.cwdName && c.cwdName !== 'Operator Projects' ? c.cwdName : '');

  function whenOf(ts) {
    const d = new Date(ts);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (ts >= start - 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function bucketOf(ts) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return 'Today';
    if (ts >= start - 864e5) return 'Yesterday';
    if (ts >= start - 6 * 864e5) return 'Previous 7 days';
    if (ts >= start - 29 * 864e5) return 'Previous 30 days';
    return 'Older';
  }

  const findInput = document.getElementById('codeFind');
  findInput.addEventListener('input', paintHistory);

  function paintHistory() {
    const q = findInput.value.trim().toLowerCase();
    // A chat nobody ever typed into is not history. The one on screen stays,
    // so it does not vanish from under you.
    const shown = lastList.filter((c) => (c.turns !== 0 || (chat && c.id === chat.id)) &&
      (!q || (niceTitle(c.title) + ' ' + placeOf(c)).toLowerCase().includes(q)));
    if (!shown.length) {
      history.innerHTML = '<p class="code-history-empty">' + (q ? 'No chats match that.' : 'Your chats will show up here.') + '</p>';
      return;
    }
    history.innerHTML = '';
    let bucket = null;
    shown.forEach((c) => {
      const b = bucketOf(c.updatedAt || 0);
      if (b !== bucket) {
        bucket = b;
        const h = document.createElement('div');
        h.className = 'code-history-head';
        h.textContent = b;
        history.appendChild(h);
      }
      const row = document.createElement('div');
      const working = running.has(c.id);
      const place = placeOf(c);
      row.className = 'code-chat-row' + (chat && c.id === chat.id ? ' on' : '') + (working ? ' working' : '');
      row.innerHTML =
        '<button class="code-chat-open" type="button" title="' + esc2(niceTitle(c.title)) + '">' +
        '<span class="code-chat-title">' + esc2(niceTitle(c.title)) + '</span>' +
        (place ? '<span class="code-chat-folder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>' + esc2(place) + '</span>' : '') +
        '</button>' +
        // A chat working away in the background says so here, since its own
        // transcript is not on screen.
        (working ? '<span class="code-chat-spin" title="Working"></span>' : '<span class="code-chat-when">' + esc2(whenOf(c.updatedAt || 0)) + '</span>') +
        '<button class="code-chat-del" type="button" aria-label="Delete" title="Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>';
      row.querySelector('.code-chat-open').addEventListener('click', () => openChat(c.id));
      row.querySelector('.code-chat-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.operator.codeChatDelete(c.id);
        if (chat && chat.id === c.id) { chat = null; clearThread(); paintFolder(); }
        loadHistory();
      });
      history.appendChild(row);
    });
  }

  // On an empty chat: the projects you were last working on, one click back in.
  function paintRecent() {
    const box = document.getElementById('codeRecent');
    const listEl = document.getElementById('codeRecentList');
    const seen = new Set();
    const recent = lastList.filter((c) => {
      if (!c.project || c.turns === 0) return false;
      const k = c.project.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 4);
    box.hidden = !recent.length;
    listEl.innerHTML = recent.map((c) =>
      '<button class="starter-project" type="button" data-id="' + c.id + '" title="' + esc2(c.project) + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>' +
      '<span><b>' + esc2(baseName(c.project)) + '</b><small>' + esc2(niceTitle(c.title)) + '</small></span></button>'
    ).join('');
  }
  document.getElementById('codeRecentList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openChat(b.dataset.id);
  });

  // The starter cards fill the box rather than sending: they are a start,
  // and the details are yours to change.
  document.getElementById('codeStarters').addEventListener('click', async (e) => {
    const card = e.target.closest('.starter');
    if (!card) return;
    if (card.dataset.pickFolder) {
      const r = await window.operator.fsPickFolder();
      if (!r || !r.ok) return;
      addRefs([{ path: r.path, dir: true }]);
      input.value = card.dataset.pickFolder;
    } else {
      input.value = card.dataset.prompt;
    }
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  async function openChat(id) {
    chat = await window.operator.codeChatGet(id);
    if (!chat) return;
    paintFolder();
    paintModel();
    paintBot();
    renderChat();
    paintBusy();
    loadHistory();
    syncEditorRoot();
  }

  // A new chat is a blank page, not a row in the sidebar: it becomes a real
  // chat when the first message is sent. Clicking New five times used to
  // leave five empty "New chat"s behind.
  const draft = { model: null, botId: null };
  async function ensureChat() {
    if (chat) return chat;
    chat = await window.operator.codeChatCreate();
    if (draft.model) { chat.model = draft.model; await window.operator.codeSetModel(chat.id, draft.model); }
    if (draft.botId) { chat.botId = draft.botId; await window.operator.codeSetBot(chat.id, draft.botId); }
    draft.model = null;
    draft.botId = null;
    return chat;
  }

  newBtn.addEventListener('click', async () => {
    // A chat that is still working carries on in the background.
    chat = null;
    refs = [];
    paintRefs();
    clearThread();
    paintFolder();
    paintModel();
    paintBot();
    paintBusy();
    loadHistory();
    syncEditorRoot();
    input.focus();
  });

  // The chip says where it starts; the top bar says where the work is.
  function paintFolder() {
    const name = chat && chat.cwdName;
    cwdLabel.textContent = name || 'Operator Projects';
    folderBtn.classList.toggle('set', Boolean(name));
    folderBtn.title = (chat && chat.cwd ? chat.cwd + '\n' : '') + 'Where it starts. It can still build anywhere you ask — click to change.';
    titleEl.textContent = niceTitle(chat && chat.title);
    const where = chatRoot(chat);
    pathEl.hidden = !where;
    pathEl.textContent = where ? tilde(where) : '';
    pathEl.title = where ? where + ' — open in the editor' : '';
  }

  folderBtn.addEventListener('click', async () => {
    await ensureChat();
    const r = await window.operator.codePickFolder(chat.id);
    if (r && r.ok) {
      chat.cwd = r.cwd; chat.cwdName = r.name; chat.project = null;
      manualRoot.delete(chat.id);
      paintFolder();
      loadHistory();
      syncEditorRoot();
    }
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
      codeDefault = (info && info.current) || null;
      buildCodeMenu();
      paintModel();
    } catch (_) {}
  }

  // What a chat with no model of its own runs on — main.js passes the same one.
  let codeDefault = null;
  const codeModel = () => (chat ? chat.model : draft.model) || codeDefault || (models[0] && models[0].id) || null;
  const codeTuner = makeTuner({
    root: document.getElementById('codeTuner'),
    mode: 'code',
    current: codeModel,
    nameOf: (id) => (models.find((m) => m.id === id) || { name: 'This model' }).name,
  });

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
      else draft.model = mid;
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
    const mid = codeModel();
    const m = models.find((x) => x.id === mid) || models[0];
    if (m) pickerName.textContent = m.name;
    codeTuner.refresh();
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
    const opts = [{ id: null, name: 'No agent', title: 'Plain coding assistant' }].concat(botList);
    botMenu.innerHTML = opts.map((b) =>
      '<button class="opt" type="button" role="option" data-id="' + (b.id || '') + '">' +
      '<span class="opt-name">' + esc2(b.name) + '</span>' +
      (b.title ? '<span class="opt-note">' + esc2(b.title) + '</span>' : '') + '</button>'
    ).join('');
    botMenu.querySelectorAll('.opt').forEach((o) => o.addEventListener('click', async () => {
      const id = o.dataset.id || null;
      if (chat) { chat.botId = id; await window.operator.codeSetBot(chat.id, id); }
      else draft.botId = id;
      paintBot();
      botMenu.hidden = true;
      botBtn.setAttribute('aria-expanded', 'false');
    }));
  }

  function paintBot() {
    const want = chat ? chat.botId : draft.botId;
    const b = want ? botList.find((x) => x.id === want) : null;
    botNameEl.textContent = b ? b.name : 'No agent';
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
    // Each exchange ends with the card of files it changed, the same card a
    // live run leaves behind.
    const files = new Map();
    const flush = () => { filesCard(files); files.clear(); };
    turns.forEach((t, k) => {
      if (t.k === 'you') { if (k) flush(); youTurn(t.text, t.refs); }
      else if (t.k === 'says') addTurn('says md', md(t.text));
      else if (t.k === 'steps') {
        (t.items || []).forEach((s) => {
          codeStep(s.name, s.input, s.err);
          noteFile(files, s.name, s.input);
        });
        closeGroup();
      }
    });
    flush();
    thread.scrollTop = thread.scrollHeight;
  }

  /* ── replies, formatted ── */

  const md = (text) => (window.Markdown ? window.Markdown.render(text) : esc2(text).replace(/\n/g, '<br>'));

  // What a turn wrote, by path. A file both written and then edited was
  // written, as far as anyone reading the card cares.
  const runFiles = new Map();
  function noteFile(map, name, inp) {
    if ((name !== 'Write' && name !== 'Edit') || !inp || !inp.abs) return;
    if (map.get(inp.abs) !== 'Write') map.set(inp.abs, name);
  }

  const FILE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/></svg>';

  function filesCard(map) {
    if (!map.size) return;
    const root = chatRoot(chat) || '';
    const inRoot = (p) => root && p.toLowerCase().startsWith(root.toLowerCase() + (root.includes('\\') ? '\\' : '/'));
    const rows = [...map].map(([p, verb]) => {
      const rel = inRoot(p) ? p.slice(root.length + 1) : tilde(p);
      const dir = rel.replace(/[^\\/]*$/, '');
      return '<button class="code-file" type="button" data-p="' + esc2(p) + '" title="' + esc2(p) + '">' + FILE_SVG +
        '<span class="nm">' + esc2(baseName(p)) + '</span><span class="dir">' + esc2(dir) + '</span>' +
        '<span class="verb ' + (verb === 'Write' ? 'new' : '') + '">' + (verb === 'Write' ? 'Written' : 'Edited') + '</span></button>';
    }).join('');
    const page = [...map.keys()].find((p) => /index\.html?$/i.test(p)) || [...map.keys()].find((p) => /\.html?$/i.test(p));
    const n = map.size;
    addTurn('files',
      '<div class="code-files">' +
        '<div class="code-files-head">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4M9.5 13.5l2 2 3.5-4"/></svg>' +
          '<b>' + n + (n === 1 ? ' file changed' : ' files changed') + '</b>' +
          (chat && chat.project ? '<span class="where">in ' + esc2(baseName(chat.project)) + '</span>' : '') +
          '<span class="grow"></span>' +
          (page ? '<button class="code-files-btn" type="button" data-open="' + esc2(page) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.5v13l11-6.5Z"/></svg>Open ' + esc2(baseName(page)) + '</button>' : '') +
          '<button class="code-files-btn" type="button" data-show="1">Show in editor</button>' +
        '</div>' +
        '<div class="code-files-list">' + rows + '</div>' +
      '</div>');
  }

  // A file name in a reply opens in the editor, resolved against the project
  // and then the working folder.
  async function openPathRef(text) {
    const t = String(text || '').trim();
    const tries = [];
    if (/^[A-Za-z]:[\\/]/.test(t)) tries.push(t);
    else {
      for (const base of [chatRoot(chat), chat && chat.cwd]) {
        if (!base) continue;
        const sep = base.includes('\\') ? '\\' : '/';
        tries.push(base + sep + t.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep));
      }
    }
    for (const p of tries) {
      const st = await window.operator.fsStat(p);
      if (!st || !st.ok) continue;
      if (st.dir) { if (chat) manualRoot.set(chat.id, p); editor.setRoot(p); editor.show(); }
      else editor.openFile(p);
      return;
    }
  }

  thread.addEventListener('click', async (e) => {
    const copy = e.target.closest('.md-copy');
    if (copy) {
      const code = copy.closest('.md-code').querySelector('pre').innerText;
      try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch (_) { copy.textContent = 'Could not copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      return;
    }
    const link = e.target.closest('a[data-url]');
    if (link) { e.preventDefault(); window.operator.openUrl(link.dataset.url); return; }
    const pathCode = e.target.closest('.md-path');
    if (pathCode) { openPathRef(pathCode.textContent); return; }
    const file = e.target.closest('.code-file');
    if (file) { editor.openFile(file.dataset.p); return; }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { window.operator.fsOpenExternal(openBtn.dataset.open); return; }
    if (e.target.closest('[data-show]')) {
      if (chat) manualRoot.delete(chat.id);
      openEditor();
    }
  });

  // The streaming reply is plain text while it arrives, and becomes formatted
  // the moment it is complete — formatting half a code fence only flickers.
  let liveText = '';
  function finishLive(text) {
    if (!live) return;
    live.classList.remove('live');
    live.classList.add('md');
    live.innerHTML = md(text != null ? text : liveText);
    live = null;
    liveText = '';
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

  // What you sent, with whatever you attached shown under it as chips.
  function youTurn(text, attached) {
    const el = addTurn('you', esc2(text).replace(/\n/g, '<br>'));
    if (attached && attached.length) {
      const row = document.createElement('div');
      row.className = 'you-refs';
      row.innerHTML = attached.map((r) => refChip(r)).join('');
      el.appendChild(row);
    }
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
    // A file it touched is a link: click it and it opens in the editor.
    if (i.abs && !isErr) {
      row.classList.add('linkable');
      row.title = i.abs;
      row.querySelector('.arg').addEventListener('click', () => editor.openFile(i.abs));
    }
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
      // It built somewhere: the chat — and the editor — follow it there.
      case 'project':
        if (chat) {
          chat.project = evt.path;
          if (!manualRoot.has(chat.id)) editor.setRoot(evt.path);
          paintFolder();
          loadHistory();
        }
        break;
      // the narration, streamed like Claude Code
      case 'say_start':
        finishLive();
        liveText = '';
        live = addTurn('says live', '');
        break;
      case 'say_delta':
        if (live) { liveText += evt.text; appendDelta(live, evt.text); scrollSoon(); }
        break;
      case 'say_end':
        finishLive(evt.text);
        break;

      case 'assistant': addTurn('says md', md(evt.text)); break;
      case 'tool':
        finishLive();  // finalise any open narration
        codeStep(evt.name, evt.input, false);
        noteFile(runFiles, evt.name, evt.input);
        if (evt.input && evt.input.abs) editor.touched(evt.input.abs, evt.name);
        break;
      case 'tool_error': codeStep('error', { command: evt.text }, true); break;
      case 'done':
        finishLive();
        closeGroup();
        if (evt.text) addTurn('says md', md(evt.text));
        filesCard(runFiles);
        runFiles.clear();
        if (evt.chatId) running.delete(evt.chatId);
        paintBusy();
        break;
      case 'error':
        finishLive();
        closeGroup();
        filesCard(runFiles);
        runFiles.clear();
        addTurn('says', '<span style="color:var(--fail)">' + esc2(evt.text) + '</span>');
        if (evt.chatId) running.delete(evt.chatId);
        paintBusy();
        break;
    }
  });

  async function run() {
    // Dropping a folder in and pressing Enter is a fair question on its own.
    const task = input.value.trim() || (refs.length ? 'Have a look at this.' : '');
    if (!task || isBusy()) return;
    // No folder to choose first: a new chat starts in the projects workspace
    // and goes wherever the work is.
    if (!chat) { await ensureChat(); paintFolder(); syncEditorRoot(); }
    runFiles.clear();
    const sent = refs.slice();
    refs = [];
    paintRefs();
    youTurn(task, sent);
    input.value = ''; input.style.height = 'auto';

    // Optimistic: the button flips before the main process answers, and this
    // chat's id is what gets marked — not some global "busy".
    running.add(chat.id);
    paintBusy();
    loadHistory();

    const started = chat.id;
    const r = await window.operator.codeRun(started, task, sent);
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
    finishLive();
    closeGroup();
    filesCard(runFiles);
    runFiles.clear();
    paintBusy();
    loadHistory();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
})();

/* ── Settings → Audit: what the agent actually did ─────────────────── */

(() => {
  const list = document.getElementById('adList');
  if (!list) return;

  const botSel = document.getElementById('adBot');
  const toolSel = document.getElementById('adTool');
  const outSel = document.getElementById('adOutcome');
  const fromIn = document.getElementById('adFrom');
  const search = document.getElementById('adSearch');
  const countEl = document.getElementById('adCount');
  const moreBtn = document.getElementById('adMore');

  const PAGE = 100;
  let shown = PAGE;
  let loaded = false;

  const filter = () => ({
    botId: botSel.value || undefined,
    tool: toolSel.value || undefined,
    outcome: outSel.value || undefined,
    // A date input gives a local day; the log stores UTC instants. Take the
    // whole day from its first moment so "from today" includes this morning.
    from: fromIn.value ? new Date(fromIn.value + 'T00:00:00').toISOString() : undefined,
    q: search.value.trim() || undefined,
  });

  const clock = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    // 24-hour, because "01:38:25 AM" does not fit the column and a log is read
    // by scanning the times down the page, where AM/PM is just noise.
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  };

  const took = (ms) => (ms === null || ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  // Which dot: a failure is the only thing worth colouring.
  const state = (r) => (r.dryRun ? 'dry' : r.ok === false ? 'err' : r.ok === true ? 'ok' : 'unknown');

  // Older rows predate the one-line summary, and code mode never had one.
  const summary = (r) => r.text || `${r.tool}${r.args && Object.keys(r.args).length ? ' ' + JSON.stringify(r.args).slice(0, 90) : ''}`;

  function detail(r) {
    const lines = [
      `when      ${new Date(r.t).toLocaleString()}`,
      `tool      ${r.tool}${r.mode === 'code' ? '  (code mode)' : ''}`,
      `bot       ${r.botName || '—'}`,
      `computer  ${r.computer || '—'}`,
      `model     ${r.model || '—'}`,
      `outcome   ${r.dryRun ? 'dry run — nothing happened'
        : r.ok === false ? `failed — ${r.error || 'no message'}`
        : r.ok === true ? 'worked' : 'unknown (requested, outcome not observed)'}`,
      `took      ${took(r.ms) || '—'}`,
      `task      ${r.taskId || '—'}`,
      '',
      JSON.stringify(r.args || {}, null, 2),
    ];
    return lines.join('\n');
  }

  function render(res) {
    const { rows, total, lastError } = res;
    list.innerHTML = '';

    if (lastError) {
      const warn = document.createElement('div');
      warn.className = 'audit-warn';
      warn.textContent = `The last record could not be written: ${lastError}`;
      list.appendChild(warn);
    }

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'audit-empty';
      empty.textContent = total === 0 && !search.value && !botSel.value && !toolSel.value && !outSel.value && !fromIn.value
        ? 'Nothing here yet. Every action an agent takes will be recorded.'
        : 'No actions match those filters.';
      list.appendChild(empty);
      countEl.textContent = '';
      moreBtn.hidden = true;
      return;
    }

    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'audit-row';

      const t = document.createElement('span');
      t.className = 'audit-time';
      t.textContent = clock(r.t);

      const dot = document.createElement('span');
      dot.className = 'audit-dot ' + state(r);

      const what = document.createElement('span');
      what.className = 'audit-what';
      what.textContent = summary(r);

      const tool = document.createElement('span');
      tool.className = 'audit-tool';
      tool.textContent = r.tool;

      const ms = document.createElement('span');
      ms.className = 'audit-ms';
      ms.textContent = took(r.ms);

      row.append(t, dot, what, tool, ms);

      // The full record opens under the row it belongs to, so a long log does
      // not need a second panel to read one line of it.
      const open = document.createElement('div');
      open.className = 'audit-detail';
      open.textContent = detail(r);
      open.hidden = true;

      row.addEventListener('click', () => {
        open.hidden = !open.hidden;
        row.classList.toggle('open', !open.hidden);
      });

      list.append(row, open);
    }

    countEl.textContent = `${rows.length} of ${total} action${total === 1 ? '' : 's'}`;
    moreBtn.hidden = rows.length >= total;
  }

  async function refreshAudit({ keepPage } = {}) {
    if (!keepPage) shown = PAGE;
    const [res, facets] = await Promise.all([
      window.operator.auditQuery({ ...filter(), limit: shown }),
      loaded ? null : window.operator.auditFacets(),
    ]);

    // The dropdowns only offer what the log actually contains, so a tool that
    // has never run does not clutter the list. Built once per sheet opening.
    if (facets) {
      for (const b of facets.bots) botSel.add(new Option(b.name, b.id));
      for (const t of facets.tools) toolSel.add(new Option(t, t));
      loaded = true;
    }

    render(res);
  }

  const rerun = () => refreshAudit();
  [botSel, toolSel, outSel, fromIn].forEach((el) => el.addEventListener('change', rerun));

  let typing = null;
  search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(rerun, 200); });

  document.getElementById('adRefresh').addEventListener('click', () => { loaded = false; botSel.length = 1; toolSel.length = 1; refreshAudit(); });
  moreBtn.addEventListener('click', () => { shown += PAGE; refreshAudit({ keepPage: true }); });

  const exportAs = async (format, btn) => {
    const was = btn.textContent;
    btn.disabled = true;
    const res = await window.operator.auditExport(format, filter());
    btn.textContent = res.ok ? `Saved ${res.count}` : res.error ? 'Failed' : was;
    btn.disabled = false;
    if (res.ok || res.error) setTimeout(() => { btn.textContent = was; }, 2200);
  };
  document.getElementById('adCsv').addEventListener('click', (e) => exportAs('csv', e.currentTarget));
  document.getElementById('adJsonl').addEventListener('click', (e) => exportAs('jsonl', e.currentTarget));

  // Read it when the tab is opened, not on boot — the file can be large and
  // most sessions never look at it.
  document.querySelectorAll('#settingsTabs .tab').forEach((t) => {
    if (t.dataset.tab === 'audit') t.addEventListener('click', () => refreshAudit());
  });

  // The check on the work lives in the same panel, because it is the same
  // question: what did it actually do? Kept in prefs rather than localStorage
  // so it follows the profile — main.js reads it at the end of every run.
  const verifyOn = document.getElementById('verifyOn');
  if (verifyOn && window.operator.prefsGet) {
    window.operator.prefsGet()
      .then((p) => { verifyOn.checked = !p || p.verify !== false; })
      .catch(() => { verifyOn.checked = true; });
    verifyOn.addEventListener('change', () => {
      window.operator.prefsSet({ verify: verifyOn.checked }).catch(() => {});
    });
  }
})();



/* ── window buttons ────────────────────────────────────────────────── */

(() => {
  const min = document.getElementById('winMin');
  if (!min || !window.operator || !window.operator.windowMinimize) return;
  const max = document.getElementById('winMax');
  const close = document.getElementById('winClose');
  const icon = document.getElementById('winMaxIcon');

  min.addEventListener('click', () => window.operator.windowMinimize());
  close.addEventListener('click', () => window.operator.windowClose());
  max.addEventListener('click', async () => paintMax(await window.operator.windowMaximize()));

  // Restore shows two overlapping squares, the way Windows does it, so the
  // button says which way it will go.
  function paintMax(maximized) {
    icon.innerHTML = maximized
      ? '<rect x="2" y="4" width="6" height="6" rx="1"/><path d="M4 4V2.8A0.8 0.8 0 0 1 4.8 2H9.2A0.8 0.8 0 0 1 10 2.8V7.2A0.8 0.8 0 0 1 9.2 8H8"/>'
      : '<rect x="2.5" y="2.5" width="7" height="7" rx="1"/>';
    max.setAttribute('aria-label', maximized ? 'Restore' : 'Maximise');
  }

  if (window.operator.onWindowState) {
    window.operator.onWindowState(({ maximized }) => paintMax(Boolean(maximized)));
  }
})();

/* ── Settings → Appearance ─────────────────────────────────────────── */

(() => {
  const groups = {
    theme: document.getElementById('apTheme'),
    accent: document.getElementById('apAccent'),
    glow: document.getElementById('apGlow'),
    edge: document.getElementById('apEdge'),
    motion: document.getElementById('apMotion'),
  };
  if (!groups.theme || !window.operator || !window.operator.prefsGet) return;

  const DEFAULTS = { theme: 'warm', accent: 'blue', glow: 'full', edge: 'accent', motion: 'on' };
  let prefs = { ...DEFAULTS };

  // The <head> script already read the mirror; this keeps it honest afterwards.
  function apply() {
    const d = document.documentElement.dataset;
    d.theme = prefs.theme;
    d.accent = prefs.accent;
    d.glow = prefs.glow;
    d.edge = prefs.edge;
    d.motion = prefs.motion;
    try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* fine */ }
    for (const [key, box] of Object.entries(groups)) {
      box.querySelectorAll('[data-value]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.value === prefs[key]));
      });
    }
  }

  for (const [key, box] of Object.entries(groups)) {
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      prefs = { ...prefs, [key]: btn.dataset.value };
      apply();
      // The profile is the source of truth; the mirror above is only for speed.
      window.operator.prefsSet({ [key]: btn.dataset.value }).catch(() => {});
    });
  }

  window.operator.prefsGet()
    .then((saved) => { prefs = { ...DEFAULTS, ...(saved || {}) }; apply(); })
    .catch(() => apply());
})();

/* ── Settings → Connectors: the phone letterbox ────────────────────── */

(() => {
  const toggle = document.getElementById('phoneToggle');
  if (!toggle || !window.operator || !window.operator.phoneStatus) return;

  const sub = document.getElementById('phoneSub');
  const body = document.getElementById('phoneBody');
  const urlBox = document.getElementById('phoneUrl');
  const tokenBox = document.getElementById('phoneToken');
  const note = document.getElementById('phoneStatus');
  const conn = document.getElementById('phoneConnector');

  function paint(st) {
    const on = Boolean(st && st.on);
    conn.classList.toggle('on', on);
    body.hidden = !on;
    toggle.textContent = on ? 'Turn off' : 'Turn on';
    if (!on) { sub.textContent = 'Off'; return; }

    // The first non-internal address is the one a phone on the same wifi can
    // reach; the rest are shown too because VPNs make the right one ambiguous.
    const addrs = st.addresses || [];
    urlBox.value = addrs.length ? `http://${addrs[0]}:${st.port}/sms` : `(no network address — port ${st.port})`;
    tokenBox.value = st.token || '';
    sub.textContent = st.lastSeen
      ? `Paired · ${st.waiting} waiting`
      : 'On · waiting for your phone';
    if (addrs.length > 1) note.textContent = `Other addresses: ${addrs.slice(1).join(', ')}`;
  }

  toggle.addEventListener('click', async () => {
    const st = await window.operator.phoneStatus();
    paint(st.on ? await window.operator.phoneStop() : await window.operator.phoneStart());
  });

  document.getElementById('phoneRotate').addEventListener('click', async () => {
    paint(await window.operator.phoneRotate());
    note.textContent = 'New token. Any phone using the old one will need updating.';
  });

  document.querySelectorAll('#settingsTabs .tab').forEach((t) => {
    if (t.dataset.tab === 'connectors') {
      t.addEventListener('click', async () => paint(await window.operator.phoneStatus()));
    }
  });
})();
