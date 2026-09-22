// bench.js — time a real task, with and without the text way of looking.
//
// Dev-only; excluded from the packaged app. The point is to answer one question
// with a number instead of an argument: does screen_read/screen_click_text
// actually make a task finish sooner, or does it just make the token counts
// look better? It runs the SAME prompt through the SAME agent twice, changing
// only whether the text path exists, and reports wall clock and turn count.
//
//   node bench.js                     the default task, 2 runs each way
//   node bench.js --runs 3
//   node bench.js --task "open Character Map and copy the degree symbol"
//   node bench.js --arm text          only one arm
//   node bench.js --visible           use the real desktop, not the private one
//
// A run on the private desktop does not touch the user's mouse or foreground.

const os = require('os');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');
const desktop = require('./desktop');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const RUNS = Number(flag('runs', 2));
const ARM = flag('arm', 'both');
const VISIBLE = Boolean(flag('visible', false));
const MODEL = flag('model', undefined);
const TASK = flag('task',
  'Open Character Map. Turn on the Advanced view checkbox, type the word heart into the "Search for" box and press the Search button. ' +
  'Then tell me the U+ code of the first character in the results. Do not copy anything and do not close the window.');

// Every run has to start from the same place or the numbers mean nothing: the
// first run leaves the app open and searched, and the next one just reads the
// answer off the screen without doing any of the work.
// A second message in the same chat — the case the warm session is for. The
// app's old behaviour is simulated with --cold, which throws the session away
// between messages exactly as building one per task used to.
const TASK2 = flag('task2',
  'Now tell me which font is selected in that same window.');
const CONVO = Boolean(flag('convo', false));
const COLD = Boolean(flag('cold', false));

const RESET = flag('reset', 'Get-Process charmap -ErrorAction SilentlyContinue | Stop-Process -Force');

// Tools that hand the model a picture. Counting these is the whole point: an
// image is ~1,229 tokens against ~100-300 for a window read as text.
const IMAGE_TOOLS = new Set([
  'screen_screenshot', 'screen_click', 'screen_do', 'screen_drag', 'screen_scroll',
  'screen_key', 'screen_move', 'focus_window', 'launch_app', 'browser_screenshot',
]);
const TEXT_LOOK = new Set(['screen_read', 'screen_click_text']);

function summarise(events, ms, reply, marks) {
  const tools = events.filter((e) => e.type === 'tool_done');
  const byName = {};
  for (const t of tools) byName[t.name] = (byName[t.name] || 0) + 1;
  const images = tools.filter((t) => IMAGE_TOOLS.has(t.name)).length;
  const reads = tools.filter((t) => TEXT_LOOK.has(t.name)).length;
  const failures = tools.filter((t) => t.ok === false);
  const failed = failures.length;
  return {
    ms, reply,
    calls: tools.length, images, reads, failed, byName,
    failedNames: [...new Set(failures.map((f) => f.name))],
    bootMs: marks.anyEvent ? marks.anyEvent - marks.start : null,
    firstMs: marks.first ? marks.first - marks.start : null,
    lastGapMs: marks.last ? (marks.end - marks.last) : null,
    toolMs: tools.reduce((a, t) => a + (t.ms || 0), 0),
  };
}

async function resetState() {
  if (!RESET || RESET === 'none') return;
  await new Promise((done) => {
    require('child_process').execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', String(RESET)],
      () => done());
  });
  await new Promise((r) => setTimeout(r, 900));
}

// One conversation: a first message, then a follow-up in the same chat.
async function conversation(textPath) {
  await resetState();
  const first = await once(textPath, { reset: false, chatId: 'bench-convo', label: 'msg 1' });
  if (COLD) agent.closeSession();           // what building a session per task cost
  const second = await once(textPath, { reset: false, chatId: 'bench-convo', label: 'msg 2' });
  return { first, second };
}

async function once(textPath, o = {}) {
  if (o.reset !== false) await resetState();
  const events = [];
  const abortController = new AbortController();
  const userDataDir = path.join(os.tmpdir(), 'operator-bench-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  let reply = '';
  let usage = null;
  const marks = { start: 0, anyEvent: null, first: null, last: null, end: 0 };
  const started = Date.now();
  marks.start = started;
  await agent.runTask(o.label === 'msg 2' ? TASK2 : TASK, {
    userDataDir,
    chatId: o.chatId || `bench-${Math.random().toString(36).slice(2)}`,
    abortController,
    textPath,
    model: MODEL || undefined,
    bot: null,
    teammates: [],
    messageBot: async () => '(no teammates in a benchmark)',
    codeChats: [],
    email: null,
    alwaysSkills: [],
    activeSkill: null,
    skillIndex: [],
    onEvent: (e) => {
      events.push(e);
      if (marks.anyEvent === null) marks.anyEvent = Date.now();
      // The finished sentence arrives as say_end or assistant depending on
      // whether it streamed; 'done' repeats it or is null. Take the last of any.
      if ((e.type === 'say_end' || e.type === 'assistant' || e.type === 'done') && e.text) reply = e.text;
      if (e.type === 'usage') usage = e;
      if (e.type === 'tool_done') {
        if (marks.first === null) marks.first = Date.now();
        marks.last = Date.now();
        process.stdout.write(e.ok === false ? '!' : '.');
      }
      if (e.type === 'error') console.log('\n  error:', e.text);
    },
  });
  marks.end = Date.now();
  const r = summarise(events, marks.end - started, reply, marks);
  r.usage = usage;
  return r;
}

const ms = (n) => (n / 1000).toFixed(1) + 's';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function arm(label, textPath) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  ${label} run ${i + 1}/${RUNS}  `);
    try {
      if (CONVO) {
        const { first, second } = await conversation(textPath);
        console.log(`
      msg1 ${ms(first.ms)} (boot ${ms(first.bootMs)})   msg2 ${ms(second.ms)} (boot ${ms(second.bootMs)}, first action ${ms(second.firstMs)})`);
        runs.push(second);           // the follow-up is what this measures
        continue;
      }
      const r = await once(textPath);
      runs.push(r);
      const machine = r.toolMs, model = r.ms - r.toolMs;
      const u = r.usage;
      console.log(`  ${ms(r.ms)}  ${r.calls} calls (${r.images} pic, ${r.reads} text${r.failed ? `, ${r.failed} failed` : ''})` +
        `  | boot ${ms(r.bootMs)}, first ${ms(r.firstMs)}, tail ${ms(r.lastGapMs)}, machine ${ms(machine)}` +
        (u ? `
      tokens: in ${u.input} out ${u.output} cacheRead ${u.cacheRead} cacheWrite ${u.cacheWrite} | api ${ms(u.apiMs)} | $${(u.cost||0).toFixed(4)}` : ''));
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
    }
  }
  return runs;
}

(async () => {
  if (!VISIBLE) desktop.usePrivateDesktop(true);
  console.log(`task  : ${TASK}`);
  console.log(`runs  : ${RUNS} each arm on ${VISIBLE ? 'the real desktop' : 'a private desktop'}\n`);

  const out = {};
  if (ARM === 'both' || ARM === 'text') out.text = await arm('text path ON ', true);
  if (ARM === 'both' || ARM === 'shots') out.shots = await arm('text path OFF', false);

  console.log('\n' + '='.repeat(64));
  const row = (label, runs) => {
    if (!runs || !runs.length) return;
    console.log(`${label.padEnd(16)} ${ms(mean(runs.map((r) => r.ms))).padStart(8)}   ` +
      `${mean(runs.map((r) => r.calls)).toFixed(1).padStart(5)} calls   ` +
      `${mean(runs.map((r) => r.images)).toFixed(1).padStart(5)} pictures   ` +
      `${mean(runs.map((r) => r.reads)).toFixed(1).padStart(5)} text looks`);
  };
  console.log('arm'.padEnd(16) + '    wall     turns       images         reads');
  console.log('-'.repeat(64));
  row('text path ON', out.text);
  row('text path OFF', out.shots);

  // The first version of this benchmark compared two identical arms for six
  // runs and reported a confident 5% — the switch was being applied after the
  // tools had already been registered. If the OFF arm touches a text tool, the
  // comparison is meaningless, so say so instead of printing a number.
  const leaked = (out.shots || []).reduce((n, r) => n + r.reads, 0);
  if (leaked > 0) {
    console.log('-'.repeat(64));
    console.log(`INVALID: the OFF arm used text tools ${leaked} time(s), so both arms ran the same code.`);
    console.log('No comparison printed. Fix the textPath switch before trusting anything here.');
  } else if (out.text && out.shots && out.text.length && out.shots.length) {
    const a = mean(out.text.map((r) => r.ms));
    const b = mean(out.shots.map((r) => r.ms));
    const pct = ((b - a) / b) * 100;
    console.log('-'.repeat(64));
    console.log(pct > 0
      ? `text path is ${pct.toFixed(0)}% quicker  (${ms(b)} -> ${ms(a)})`
      : `text path is ${Math.abs(pct).toFixed(0)}% SLOWER  (${ms(b)} -> ${ms(a)})`);
    console.log(`with ${RUNS} runs each this is indicative, not conclusive — the spread between runs matters as much as the gap.`);
    console.log(`spread: ON ${out.text.map((r) => ms(r.ms)).join(', ')}   OFF ${out.shots.map((r) => ms(r.ms)).join(', ')}`);
  }

  console.log('\nlast answers:');
  if (out.text && out.text.length) console.log(`  ON : ${String(out.text[out.text.length-1].reply).slice(0, 160)}`);
  if (out.shots && out.shots.length) console.log(`  OFF: ${String(out.shots[out.shots.length-1].reply).slice(0, 160)}`);
  console.log('\nCheck those answers are actually right — a wrong answer arrived at quickly is not a win.');
  process.exit(0);
})();
