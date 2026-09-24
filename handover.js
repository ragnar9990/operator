// handover.js — a step that is the user's to do, waited for rather than
// ending the task.
//
// A verification code nobody can fetch, a robot check, a password, a phone or
// identity check: the agent cannot do these, and ending the task to say so
// means the user comes back to a half-filled form that has usually timed out.
// So the agent (wait_for_user in agent.js) opens a hand-over here, the window
// shows the user what to do with "Show me" and "I've done it", and the agent
// carries on the moment either the page moves on or the user says so.

const pending = new Map();   // id → { resolve, page }
let n = 0;

function open(page) {
  const id = 'hv' + Date.now().toString(36) + (n++).toString(36);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  pending.set(id, { resolve, page });
  return { id, done };
}

// How it ended: 'user' (they pressed "I've done it"), 'skipped', or whatever
// the watcher saw. False if it had already ended.
function finish(id, outcome) {
  const h = pending.get(id);
  if (!h) return false;
  pending.delete(id);
  h.resolve(outcome);
  return true;
}

// Bring the tab it is waiting on to the front of the agent's browser.
async function show(id) {
  const h = pending.get(id);
  if (!h || !h.page || h.page.isClosed()) return false;
  try { await h.page.bringToFront(); return true; } catch { return false; }
}

module.exports = { open, finish, show };
