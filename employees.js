// employees.js — the loop that makes an employee work without being asked.
//
// An employee (store.js) is an agent with a job, a shift and a to-do list.
// While it is on shift, this wakes it for a check-in every so often; it does
// the next useful piece of its job and tells its boss what matters with
// message_boss (agent.js). The boss can message it at any time, and it answers
// as soon as the computer is free.
//
// Three rules shape it:
//   ONE AT A TIME. There is one mouse, so employees queue behind whatever is
//   running and behind each other — and a task the user starts always wins
//   (main.js stops a check-in for it).
//   CHEAP. A check-in is a model run, so each employee has a daily limit and
//   working hours, and a check-in that finds nothing to do ends quietly.
//   NEVER STUCK. Nobody watches a check-in, so it never waits on the user
//   mid-task: it asks by message and carries on (agent.js, wait_for_user).

const store = require('./store');

let deps = null;               // { runOne, isBusy, send, notify } from main.js
const working = new Set();     // employees running right now (one at most)
const cutShort = new Set();    // runs a task of the user's stopped
let busy = false;

function init(d) { deps = d; }

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const usedToday = (e, now) => (e.today && e.today.day === dayOf(now) ? e.today.count : 0);

// Inside its working hours? No hours means any time. A shift that runs past
// midnight ("22:00" to "06:00") works too.
function inHours(e, now) {
  if (!e.hours) return true;
  const d = new Date(now);
  if (e.hours.days === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const at = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const from = at(e.hours.from);
  const to = at(e.hours.to);
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

const changed = (botId, extra) => deps && deps.send('employee-event', { botId, ...(extra || {}) });

// It speaks first: into the conversation, onto the unread count, and out as a
// Windows notification.
function messageBoss(botId, text, needsReply) {
  const body = String(text || '').trim();
  if (!body) return;
  store.addTurn(botId, { k: 'says', text: body, proactive: true, needsReply: Boolean(needsReply) });
  const e = store.getEmployee(botId);
  if (!e) return;
  store.updateEmployee(botId, { unread: (e.unread || 0) + 1, waiting: e.waiting || Boolean(needsReply) });
  deps.notify(e.name, body, botId);
  changed(botId, { message: true });
}

// What agent.js reaches through as ctx.employee.
function hands(botId, kind) {
  return {
    kind,
    message: (text, needsReply) => messageBoss(botId, text, needsReply),
    tasks: () => ((store.getEmployee(botId) || {}).tasks || []),
    addTask: (text) => { const t = store.addEmployeeTask(botId, text, 'them'); changed(botId); return t; },
    completeTask: (taskId, note) => { const t = store.updateEmployeeTask(botId, taskId, { done: true, note }); changed(botId); return t; },
  };
}

// A run is written up once it ends: the steps folded into one entry, and for
// a reply, its last words as the answer.
function recorder() {
  const steps = [];
  const said = [];
  let error = null;
  return {
    record(evt) {
      if (evt.type === 'tool') steps.push({ name: evt.name, input: evt.input || {} });
      else if ((evt.type === 'say_end' || evt.type === 'assistant' || (evt.type === 'done' && evt.text)) && String(evt.text || '').trim()) {
        const t = String(evt.text).trim();
        if (said[said.length - 1] !== t) said.push(t);
      } else if (evt.type === 'error') error = evt.title ? `${evt.title}${evt.fix ? ' — ' + evt.fix : ''}` : String(evt.text || 'Something went wrong');
    },
    steps,
    said,
    get error() { return error; },
  };
}

function checkInPrompt(e, now, left) {
  const when = new Date(now).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
  const open = (e.tasks || []).filter((t) => !t.done);
  return [
    `[Check-in — ${when}. This is Operator's clock, not your boss.]`,
    open.length
      ? `Your to-do list:\n${open.map((t) => `- ${t.id}: ${t.text}${t.by === 'you' ? ' (from your boss)' : ''}`).join('\n')}`
      : 'Your to-do list is empty.',
    e.waiting ? 'You have asked your boss something and not had an answer yet. Do not ask again — work on something else.' : '',
    `Check-ins left today after this one: ${left}.`,
    'Do the most useful next piece of your job now, then stop. Tell your boss with message_boss only if there is something worth telling them.',
  ].filter(Boolean).join('\n\n');
}

// Everything the boss has said since it last answered, oldest first.
function unanswered(botId) {
  const e = store.getEmployee(botId);
  const chat = e && e.threads[0] && store.getChat(botId, e.threads[0].id);
  const turns = (chat && chat.turns) || [];
  const out = [];
  for (let i = turns.length - 1; i >= 0 && turns[i].k === 'you'; i--) out.unshift(turns[i].text);
  return out;
}

async function run(botId, kind) {
  const e = store.getEmployee(botId);
  if (!e) return;
  const chatId = e.threads[0] && e.threads[0].id;
  const now = Date.now();
  let prompt;

  if (kind === 'reply') {
    const said = unanswered(botId);
    store.updateEmployee(botId, { pending: false, waiting: false });
    if (!said.length) return;
    prompt = said.join('\n\n');
  } else {
    const used = usedToday(e, now);
    store.updateEmployee(botId, { lastAt: now, nextAt: now + e.every * 60 * 1000, today: { day: dayOf(now), count: used + 1 } });
    prompt = checkInPrompt(e, now, Math.max(0, e.cap - used - 1));
  }

  busy = true;
  working.add(botId);
  changed(botId);
  const rec = recorder();
  const started = Date.now();
  let result = null;
  try {
    result = await deps.runOne({
      prompt, botId, chatId, silent: true, record: rec.record,
      employee: hands(botId, kind),
      // A check-in has no goal the check could judge; a reply does.
      noCheck: kind === 'check-in',
    });
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }

  const interrupted = cutShort.delete(botId);
  // The desk was taken before it started: nothing ran, so try again shortly.
  if (result && result.ok === false) {
    if (kind === 'reply') store.updateEmployee(botId, { pending: true });
    else store.updateEmployee(botId, { nextAt: Date.now() + 2 * 60 * 1000, today: { day: dayOf(now), count: usedToday(e, now) } });
  } else {
    const last = rec.said[rec.said.length - 1] || '';
    if (kind === 'reply') {
      if (rec.steps.length || rec.said.length > 1) store.addTurn(botId, { k: 'work', items: rec.steps, notes: rec.said.slice(0, -1), interrupted });
      if (last) store.addTurn(botId, { k: 'says', text: last });
    } else {
      store.addTurn(botId, { k: 'shift', items: rec.steps, text: last, interrupted });
    }
    if (rec.error) store.addTurn(botId, { k: 'error', text: rec.error });
    store.logEmployee(botId, {
      kind,
      summary: interrupted ? 'Stopped for a task of yours' : (rec.error ? rec.error : last).slice(0, 240),
      steps: rec.steps.length,
      ms: Date.now() - started,
    });
  }

  working.delete(botId);
  busy = false;
  changed(botId);
  // Whatever queued up behind this one.
  setTimeout(() => tick().catch(() => {}), 1500);
}

// Called every few seconds by main.js. Answers come before check-ins: someone
// waiting on a reply is waiting now.
async function tick() {
  if (!deps || busy || deps.isBusy()) return;
  const now = Date.now();
  const all = store.listEmployees();

  const asked = all.find((e) => e.pending);
  if (asked) return run(asked.id, 'reply');

  for (const e of all) {
    if (!e.onShift || !e.nextAt || now < e.nextAt) continue;
    if (!inHours(e, now) || usedToday(e, now) >= e.cap) {
      // Not now: look again one interval on, without spending anything.
      store.updateEmployee(e.id, { nextAt: now + e.every * 60 * 1000 });
      changed(e.id);
      continue;
    }
    return run(e.id, 'check-in');
  }
}

// The boss said something: it goes into the conversation now, and gets an
// answer as soon as the computer is free.
function say(botId, text) {
  const body = String(text || '').trim();
  if (!body || !store.getEmployee(botId)) return false;
  store.addTurn(botId, { k: 'you', text: body });
  store.updateEmployee(botId, { pending: true, unread: 0 });
  changed(botId);
  setTimeout(() => tick().catch(() => {}), 50);
  return true;
}

// "Check in now": due immediately, still subject to the desk being free.
function checkInNow(botId) {
  const e = store.getEmployee(botId);
  if (!e) return { ok: false, error: 'That employee is gone.' };
  if (usedToday(e, Date.now()) >= e.cap) return { ok: false, error: `It has used all ${e.cap} check-ins for today.` };
  // Out of hours or off shift, a check-in asked for by hand still happens once.
  store.updateEmployee(botId, { nextAt: Date.now() });
  const e2 = store.getEmployee(botId);
  if (!e2.onShift || !inHours(e2, Date.now())) {
    if (busy || deps.isBusy()) return { ok: false, error: 'The computer is busy — try again when it is free.' };
    run(botId, 'check-in').catch(() => {});
    return { ok: true };
  }
  setTimeout(() => tick().catch(() => {}), 50);
  return { ok: true, queued: busy || deps.isBusy() };
}

const isWorking = (botId) => working.has(botId);
const markCutShort = (botId) => { if (botId) cutShort.add(botId); };

module.exports = { init, tick, say, checkInNow, isWorking, markCutShort, inHours, usedToday };
