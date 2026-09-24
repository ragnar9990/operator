// handover.js — a step that is the user's to do, waited for rather than
// ending the task.
//
// A verification code nobody can fetch, a robot check, a password, a phone or
// identity check: the agent cannot do these, and ending the task to say so
// means the user comes back to a half-filled form that has usually timed out.
// So a hand-over is opened here, the window shows the user exactly what to do
// — with "Show me", a box to type an answer into, "I've done it" and "Skip" —
// and whoever opened it carries on the moment the page moves on or the user
// answers. Three places open one: the agent's own wait_for_user, a helper that
// finished saying NEEDS YOU, and a run whose goal is not met yet.

const pending = new Map();   // id → { resolve, page }
let n = 0;

function open(page) {
  const id = 'hv' + Date.now().toString(36) + (n++).toString(36);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  pending.set(id, { resolve, page: page || null });
  return { id, done };
}

// How it ended — 'user' (they pressed "I've done it" or sent an answer),
// 'skipped', or whatever the watcher saw — and anything they typed.
function finish(id, outcome, text) {
  const h = pending.get(id);
  if (!h) return false;
  pending.delete(id);
  h.resolve({ outcome, text: String(text || '').trim().slice(0, 2000) });
  return true;
}

// Bring the tab it is waiting on to the front of the agent's browser.
async function show(id) {
  const h = pending.get(id);
  if (!h || !h.page || h.page.isClosed()) return false;
  try { await h.page.bringToFront(); return true; } catch { return false; }
}

// Wait until the user has done it. Returns { outcome, text }:
//   'user'    they said so (with `text` if they typed an answer)
//   'moved'   the page's address changed — the step is behind it
//   'gone'    the text being waited on disappeared
//   'skipped' they chose to skip it
//   'timeout' the time ran out
//   'stopped' the run was stopped
// `getPage` is optional: a run waiting on an answer has no page to watch.
async function watch({ h, getPage = null, untilGone = '', minutes = 10, signal = null }) {
  const visible = async (p, text) => {
    try { return await p.getByText(text, { exact: false }).first().isVisible({ timeout: 500 }); }
    catch { return false; }
  };

  const first = getPage ? await getPage().catch(() => null) : null;
  const startUrl = first && !first.isClosed() ? first.url() : null;
  // "Gone" only counts if it was there to begin with — a guessed text that
  // never appeared must not end the wait at once.
  let sawText = untilGone && first ? await visible(first, untilGone) : false;

  const limit = Date.now() + minutes * 60 * 1000;
  let result = null;
  h.done.then((r) => { if (!result) result = r; });

  while (!result) {
    if (signal && signal.aborted) { result = { outcome: 'stopped', text: '' }; break; }
    if (Date.now() > limit) { result = { outcome: 'timeout', text: '' }; break; }
    await new Promise((r) => setTimeout(r, 1000));
    if (result || !getPage) continue;
    try {
      const p = await getPage();          // a helper's tab may have moved to a pop-up
      if (!p || p.isClosed()) continue;
      if (startUrl && p.url() !== startUrl) { result = { outcome: 'moved', text: '' }; break; }
      if (untilGone) {
        const there = await visible(p, untilGone);
        if (there) sawText = true;
        else if (sawText) { result = { outcome: 'gone', text: '' }; break; }
      }
    } catch { /* mid-navigation; look again next second */ }
  }

  finish(h.id, result.outcome, result.text);   // tidy up if it ended on the watcher's side
  return result;
}

// Anything that means the step is behind them and the work can carry on.
const carriedOn = (outcome) => outcome === 'user' || outcome === 'moved' || outcome === 'gone';

// What the agent is told when the user has answered.
function answerFor(r) {
  if (r.text) return `The user answered: "${r.text}"`;
  if (r.outcome === 'moved') return 'The page moved on — the user has done that step';
  if (r.outcome === 'gone') return 'That step has cleared on the page — the user has done it';
  return 'The user says they have done it';
}

module.exports = { open, finish, show, watch, carriedOn, answerFor };
