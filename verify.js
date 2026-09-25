// verify.js — the second pair of eyes on a finished run.
//
// The commonest failure of every computer-use agent is not that it cannot do
// the job. It is that it says it did the job when it did not: the click missed,
// the page never loaded, the file went to the wrong folder, and the closing
// sentence is confident anyway. The agent cannot catch this itself — it would
// be marking its own homework with the same context that made the mistake.
//
// So a second, cheap model gets the goal, the list of what actually happened
// and the screen as it is now, and answers one question. It has no tools, no
// history and no stake in the answer.

const desktop = require('./desktop');
const browser = require('./browser');
const nim = require('./nim');
const errors = require('./errors');

// Cheap on purpose. This runs at the end of every task that did anything, so it
// has to cost close to nothing or people turn it off and we are back to taking
// the agent's word for it. Measured: ~0.2c on the action list alone, ~1c once a
// screenshot is attached. The slow part is not the model — it is the ~7s the
// SDK spends starting a subprocess, the same toll askBot pays.
const CHECKER = 'claude-haiku-4-5';

// Smaller and grainier than the screenshots the agent itself works from. The
// question here is "is the invoice folder open", not "what does that icon look
// like", and a 900px frame is half the tokens of the agent's 1280px one.
const SHOT = { w: 900, q: 55 };

const RULES = `You are the check on another agent's work.

That agent has just finished a task on the user's real Windows PC and is about to tell them it is done. Your only job is to say whether the goal was actually met. You have no tools and you cannot fix anything — you give a verdict, nothing else.

How to judge:
- Judge the GOAL, not the effort. "It tried hard" is a FAIL.
- The agent's own summary is the thing you are checking, not evidence for it. Believe the actions and the screen over the story.
- Half a goal is a FAIL. Say which half is missing.
- An action list full of errors that still ends in the right place is a PASS — how it got there is not your problem.
- If the request was vague or conversational and what happened is a fair reading of it, that is a PASS. Do not invent requirements the user never asked for.
- If the evidence genuinely does not show you either way, say UNSURE rather than guessing. UNSURE is not a polite FAIL.
- A reminder or repeating job set with the schedule tool is done the moment it is set: it cannot have gone off yet. That it goes off while Operator is open is how Operator works, not something missing. A "task" job is carried out at that time by this same agent with all its tools, so judge only that it is set for the right time and that its instruction asks for the right thing.

Reply with ONE line, in exactly this shape, and nothing else — no preamble, no markdown:
PASS — <one sentence>
FAIL — <one sentence naming exactly what is missing or wrong>
UNSURE — <one sentence saying what you would have needed to see>`;

// Same job, different evidence: a rehearsal changed nothing, so there is no
// "after" to look at. The plan is all there is, and the question is whether it
// would have worked.
const RULES_DRY = `${RULES}

This was a REHEARSAL. Nothing in the list below actually happened — it is the plan the agent would have carried out. Judge the plan: would those steps, in that order, have met the goal? A plan that stops short, skips a step or acts on the wrong thing is a FAIL even though nothing was done.`;

// Long runs make long lists. Keep both ends — the opening says what it went
// after, the closing says where it left the machine — and drop the middle.
function actionList(actions) {
  const line = (a, i) => {
    const what = String(a.text || a.name || 'something').slice(0, a.long ? 2500 : 160);
    const how = a.ok === false ? ` — FAILED${a.error ? ': ' + String(a.error).slice(0, 120) : ''}` : '';
    return `${i + 1}. ${what}${how}`;
  };
  if (actions.length <= 60) return actions.map(line).join('\n');
  const head = actions.slice(0, 20).map(line);
  const tail = actions.slice(-40).map((a, i) => line(a, actions.length - 40 + i));
  return [...head, `… ${actions.length - 60} more steps …`, ...tail].join('\n');
}

// What the world looks like now. This only ever asks for evidence the run
// already paid for: a task that never touched the desktop must not boot the
// desktop helper just to be checked, and a task that never opened the browser
// has no page to read.
async function evidence({ usedScreen, usedBrowser, canSee, onTheirScreen }) {
  const parts = [];
  let image = null;

  if (usedBrowser) {
    // Every tab with something in it, not just the main agent's: helpers work
    // in tabs of their own, and a blank main tab read as "nothing happened".
    // The newest five: helpers leave their tabs open, so older runs' pile up.
    const tabs = browser.openTabs().filter((p) => p.url() && p.url() !== 'about:blank').slice(-5);
    const each = tabs.length > 1 ? 600 : 1800;
    const seen = [];
    for (const p of tabs) {
      try {
        const text = (await p.innerText('body')).slice(0, each);
        seen.push(`${p.url()}\n${text}`);
      } catch { /* the page moved on or closed — say nothing rather than guess */ }
    }
    if (seen.length === 1) parts.push(`THE BROWSER PAGE NOW:\n${seen[0]}`);
    else if (seen.length) parts.push(`THE BROWSER TABS NOW:\n\n${seen.map((s, i) => `Tab ${i + 1}: ${s}`).join('\n\n')}`);
  }

  if (usedScreen && canSee) {
    try {
      const shot = await desktop.screenshot(1, SHOT);
      image = { mime: shot.mime || 'image/jpeg', b64: shot.image };
      parts.push(`THE SCREEN NOW: attached, display ${shot.display} of ${shot.displays}. Foreground window: ${shot.foreground || 'unknown'}.`);
      // It stepped back onto its own hidden desktop when it finished, so the
      // shot cannot show what it did on theirs (Calculator failed on this).
      if (onTheirScreen) parts.push('NOTE: part of this was done on the USER\'S OWN screen (use_my_screen), and the agent then stepped back to its own hidden desktop — which is what this screenshot shows. What it did on their screen will not be in it; judge that part on the actions.');
    } catch { /* the helper went with the task; judge on the actions alone */ }
  } else if (usedScreen && !canSee) {
    parts.push('(The screen cannot be shown to you — the model running this check has no vision. Judge on the actions alone, and say UNSURE if that is not enough.)');
  }

  return { text: parts.join('\n\n'), image };
}

function brief({ goal, actions, reply, dry, ev }) {
  return [
    `THE GOAL — what the user asked for:\n${String(goal || '').slice(0, 2000)}`,
    `WHAT THE AGENT ${dry ? 'PLANNED TO DO' : 'DID'}, in order:\n${actions.length ? actionList(actions) : '(nothing)'}`,
    reply ? `WHAT THE AGENT SAYS ABOUT IT:\n${String(reply).slice(0, 1200)}` : null,
    ev.text || null,
  ].filter(Boolean).join('\n\n');
}

// PASS / FAIL / UNSURE, however it decides to punctuate it. Anything that does
// not parse is read as "could not tell" — a checker that rambles must never be
// read as a failure, or the agent gets sent back to redo work that was fine.
function verdict(raw) {
  const clean = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const m = clean.match(/\b(PASS|FAIL|UNSURE)\b[\s.:—–-]*([\s\S]*)/i);
  if (!m) return { ok: null, why: clean.slice(0, 300) || 'the check gave no verdict' };
  const word = m[1].toUpperCase();
  const why = m[2].trim().split('\n')[0].slice(0, 300);
  return { ok: word === 'PASS' ? true : word === 'FAIL' ? false : null, why };
}

// One turn on the Agent SDK: no tools, no session, no memory of the last check.
// This pays the SDK's subprocess start every time, exactly as askBot does —
// about 2–3s now that main.js switches off Claude Code's non-essential traffic
// (it was ~6s). Pre-starting it with the SDK's startup() was tried and dropped:
// in 0.3.251 a pre-started session sometimes ignored this system prompt and ran
// slower than a cold one, and the check has to follow its rules every time.
async function askClaude({ system, body, image, abortController }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const content = image
    ? [{ type: 'text', text: body }, { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.b64 } }]
    : body;

  // An image has to travel as a content block, which means the streaming-input
  // form of the prompt — and that stream has to stay open until the result
  // lands, or the SDK tears the transport down mid-answer.
  let finished = false;
  async function* once() {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
    while (!finished) await new Promise((r) => setTimeout(r, 40));
  }

  const stream = query({
    prompt: once(),
    options: {
      model: CHECKER, systemPrompt: system, tools: [], allowedTools: [], settingSources: [], maxTurns: 1,
      // Claude Code switches Haiku's thinking on unless told otherwise, and on a
      // check with thin evidence it would deliberate for 40s+. Off entirely it
      // is fast but wrong — it failed work that was done. A small budget kept
      // every verdict right and every check at 3–5s.
      thinking: { type: 'enabled', budgetTokens: 1024 },
    },
  });

  let text = '';
  let cost = 0;
  try {
    for await (const m of stream) {
      if (abortController?.signal.aborted) break;
      if (errors.keyRefused(m)) throw new Error(errors.KEY_REFUSED);
      if (m.type === 'assistant') {
        for (const b of m.message.content) if (b.type === 'text') text += b.text;
      } else if (m.type === 'result') {
        cost = m.total_cost_usd || 0;
        if (!text) text = m.result || '';
        break;
      }
    }
  } finally {
    finished = true;                 // let the generator end, closing the stream
  }
  return { text, cost, model: CHECKER };
}

// A NIM run is checked by its own model. Reaching for Claude here would mean a
// task the user deliberately put on NVIDIA quietly phoning Anthropic at the end.
async function askNim({ system, body, image, model, abortController }) {
  const info = nim.describe(nim.bareId(model));
  const message = image && info.vision
    ? [{ type: 'text', text: body }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.b64}` } }]
    : body;
  const text = await nim.ask({ model, system, message, abortController });
  return { text, cost: 0, model };
}

/**
 * Check a finished run. Never throws: a check that cannot run reports that it
 * could not run. Failing a task over a failed check would be worse than not
 * checking at all.
 *
 * ok === true  the goal was met
 * ok === false it was not, and `why` says what is missing
 * ok === null  could not tell — no verdict, and nothing is re-run on it
 */
async function check({ goal, actions = [], reply, model, dryRun, usedScreen, usedBrowser, onTheirScreen, abortController }) {
  const started = Date.now();
  const onNim = nim.isNimModel(model);
  const canSee = onNim ? Boolean(nim.describe(nim.bareId(model)).vision) : true;

  try {
    const ev = await evidence({ usedScreen: usedScreen && !dryRun, usedBrowser: usedBrowser && !dryRun, canSee, onTheirScreen });
    const body = brief({ goal, actions, reply, dry: dryRun, ev });
    const system = dryRun ? RULES_DRY : RULES;

    const r = onNim
      ? await askNim({ system, body, image: ev.image, model, abortController })
      : await askClaude({ system, body, image: ev.image, abortController });

    return { ...verdict(r.text), model: r.model, ms: Date.now() - started, cost: r.cost };
  } catch (err) {
    return {
      ok: null,
      why: `the check could not run — ${String((err && err.message) || err).slice(0, 200)}`,
      model: onNim ? model : CHECKER,
      ms: Date.now() - started,
      cost: 0,
    };
  }
}

// What goes back to the agent when the check says no. Deliberately not a
// question: the run is being told it is not finished, not invited to debate it.
function critique(why) {
  return `STOP — your work has been checked against the original goal and it did not pass.

The check says: ${why}

That check saw the goal, every action you took and the screen as it is now. Do not argue with it, and do not send the same summary again. Either finish the job properly, or — if it genuinely cannot be done on this machine — say plainly what you could not do and why, and stop claiming it is done.`;
}

module.exports = { check, critique, CHECKER };
