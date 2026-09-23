// main.js — Electron main process. Wires the UI to the agent + its browser.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const browser = require('./browser');
const desktop = require('./desktop');
const speech = require('./speech');
const piper = require('./piper');
const voice = require('./voice');
const whisper = require('./whisper');
const overlay = require('./overlay');
const agent = require('./agent');
const store = require('./store');
const audit = require('./audit');
const verify = require('./verify');
const errors = require('./errors');
const phone = require('./phone');
const email = require('./email');
const code = require('./code');
const googleOAuth = require('./google-oauth');

let win = null;
let running = null; // { abortController }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131211',
    titleBarStyle: 'hidden',
    // No titleBarOverlay: the OS paints that strip itself, over the top of the
    // page, which broke the lit edge across the whole top-right corner. The
    // window buttons are ours now — see .winctl in the UI.

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The page asks for the microphone itself. Grant media explicitly rather than
  // relying on Electron's default, and refuse everything else — a local page
  // has no business asking for geolocation or notifications.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === 'media' || permission === 'audioCapture');
  });

  // Windows maximises by overhanging the screen ~8px on every side, so an edge
  // drawn at inset:0 ends up off-screen. Tell the page which state it is in and
  // let the CSS pull the line in — and square its corners, which is what the OS
  // does to the window itself when maximised.
  const sendWindowState = () => send('window-state', { maximized: win.isMaximized() });
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.webContents.on('did-finish-load', sendWindowState);

  // A thrown error in the renderer is otherwise invisible unless devtools are
  // open, which they never are on someone else's machine. Warnings and errors
  // come through to whoever started the app.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 2) return;
    const where = source ? ' (' + String(source).split(/[\/]/).pop() + ':' + line + ')' : '';
    console.error('[ui]' + where + ' ' + message);
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Live view: whichever surface the agent last looked at, browser or desktop.
  browser.setFrameListener((b64, url) => send('agent-event', { type: 'screenshot', b64, label: url, mime: 'image/png' }));
  desktop.setFrameListener((b64, label, mime) => send('agent-event', { type: 'screenshot', b64, label, mime }));

  // Operator's own purple cursor, so its movements are never mistaken for yours.
  // Pointless when it is driving another machine — the pointer is over there.
  // The purple cursor only makes sense on the desktop the user is watching. When
  // the agent has its own hidden desktop (or a remote one), it points at things
  // over there, so don't draw a phantom cursor on the real screen.
  desktop.setPointerListener((p) => { if (desktop.target().kind === 'local' && !desktop.isPrivate()) overlay.show(p); });

  // Voice events (heard speech, listening state) go straight to the renderer,
  // which decides whether a transcript should become a task.
  speech.setListener((evt) => send('voice-event', evt));

  // The neural voice streams raw PCM; the renderer plays it through Web Audio.
  // Sent as it arrives so the first words are already sounding while the rest
  // of the sentence is still being generated.
  piper.setListener((evt) => send('voice-audio', evt));
  whisper.setStateListener((evt) => send('voice-event', { ev: 'whisper', ...evt }));
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  audit.init(app.getPath('userData'));

  // The NVIDIA NIM key, if there is one, and the live list of what that key
  // can reach. Both are cheap and neither blocks the window. A key saved before
  // the paste-cleaning existed — "Bearer nvapi-…" straight out of NVIDIA's code
  // sample — is repaired here rather than failing every task until it is typed
  // in again.
  const { key: saved, unavailable } = store.getNvidia();
  const clean = agent.nim.cleanKey(saved);
  if (clean !== saved) { store.setNvidia(clean); store.setNvidiaUnavailable(unavailable); }
  agent.nim.setKey(clean);

  // What NVIDIA would not serve last time stays out of the picker, and a model
  // that 404s during a task joins it.
  agent.nim.setUnavailable(unavailable);
  agent.nim.onUnavailableChange((ids) => store.setNvidiaUnavailable(ids));
  agent.nim.refresh().catch(() => {});

  // Hand Operator another machine at launch:
  //   set OPERATOR_REMOTE_URL=http://192.168.1.50:8391
  //   set OPERATOR_REMOTE_TOKEN=...
  // The UI can also connect at runtime via the remote:* handlers below.
  if (process.env.OPERATOR_REMOTE_URL) {
    desktop.useRemote({ url: process.env.OPERATOR_REMOTE_URL, token: process.env.OPERATOR_REMOTE_TOKEN || '' });
  }

  createWindow();
});

app.on('window-all-closed', async () => {
  await browser.closeBrowser();
  agent.closeSession();   // the live SDK session holds a subprocess of its own
  voice.close();          // hands-free mode holds one of its own
  piper.stop();
  phone.stop();           // never leave a port listening after the app is gone
  desktop.stop();
  speech.stop();
  whisper.stop();
  overlay.destroy();
  if (process.platform !== 'darwin') app.quit();
});

// The helper is a separate process; a hard quit would otherwise orphan it.
app.on('before-quit', () => { phone.stop(); agent.closeSession(); voice.close(); desktop.stop(); speech.stop(); piper.stop(); whisper.stop(); overlay.destroy(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const profileDir = () => path.join(app.getPath('userData'), 'agent-profile');

// Where a step actually happened. Read per event rather than per task, because a
// remote machine can be paired or dropped while a task is still running.
function computerLabel() {
  const t = desktop.target();
  if (t.kind === 'remote') return `remote ${t.url}`;
  return desktop.isPrivate() ? 'private desktop' : 'this desktop';
}

// Everything the picker can offer: the Claude models the subscription covers,
// plus every model NVIDIA NIM is serving right now. The catalog is refreshed
// in the background, so opening the picker never waits on the network.
ipcMain.handle('list-models', async () => {
  agent.nim.refresh().catch(() => {});
  return {
    models: agent.listModels(),
    current: agent.DEFAULT_MODEL,
    nvidia: nvidiaStatus(),
  };
});

/* ── NVIDIA NIM key ──────────────────────────────────────────────── */

// A key can also arrive as NVIDIA_API_KEY in the environment, which the store
// knows nothing about — so "is there a key?" is the agent's question to answer.
const nvidiaStatus = () => {
  const saved = store.nvidiaStatus();
  return { configured: saved.configured || agent.nim.hasKey(), hint: saved.hint || (agent.nim.hasKey() ? 'from the environment' : '') };
};

ipcMain.handle('nvidia:status', async () => nvidiaStatus());

// Saving a key tries it, but never refuses to save it. NVIDIA's 403 means
// "authorization failed" for a wrong key and for a model you simply have no
// access to, so a failed probe is a warning, not a verdict — the key is the
// user's and they can go and run a task with it. An empty key clears it.
ipcMain.handle('nvidia:set', async (_e, key) => {
  if (!String(key || '').trim()) {
    store.setNvidia('');
    agent.nim.setKey('');
    return { ok: true, status: nvidiaStatus(), models: 0 };
  }

  // Whatever they pasted, find the key in it — then check its SHAPE before
  // writing anything. Whether NVIDIA likes a key is a judgement call worth
  // overriding, but text that cannot be a key at all must never be allowed to
  // overwrite one that is: that loses the real key with no way back.
  const clean = agent.nim.cleanKey(key);
  const problem = agent.nim.keyProblem(clean);
  if (problem) return { ok: false, error: problem, status: nvidiaStatus() };

  store.setNvidia(clean);
  agent.nim.setKey(store.getNvidia().key);
  await agent.nim.refresh({ force: true });

  const check = await agent.nim.testKey();
  return {
    ok: true,
    status: nvidiaStatus(),
    models: agent.nim.listModels().length,
    warning: check.ok ? null : check.error,
  };
});

// NVIDIA's published catalog is not a list of what your key can run — most of
// it answers "not found for account". This tries every one of them, a token at
// a time, so the picker can stop offering models that cannot work. It takes a
// minute or two, hence the progress.
let sweeping = null;
ipcMain.handle('nvidia:sweep', async () => {
  if (sweeping) return { ok: false, error: 'Already checking.' };
  sweeping = new AbortController();
  try {
    const r = await agent.nim.sweep({
      signal: sweeping.signal,
      onProgress: (p) => send('nvidia-progress', p),
    });
    return r;
  } finally {
    sweeping = null;
    send('nvidia-progress', { done: 0, total: 0, finished: true });
  }
});

async function runOne({ prompt, model, botId, chatId, silent, record, dryRun }) {
  if (running) return { ok: false, error: 'A task is already running.' };

  const bot = botId ? store.getBot(botId) : null;

  // A message that opens with /name runs that library skill for this turn. Strip
  // the command; whatever follows is the actual task (or the skill alone if the
  // line is just the command).
  let activeSkill = null;
  const slash = String(prompt || '').match(/^\/([a-z0-9][a-z0-9_-]*)\b[ \t]*([\s\S]*)$/i);
  if (slash) {
    const sk = store.getSkillByName(slash[1]);
    if (sk) {
      activeSkill = { name: sk.name, title: sk.title, prompt: sk.prompt };
      // Whatever follows the command is the task; if nothing does, the skill
      // itself is the instruction, so give the model a short nudge to run it.
      prompt = slash[2].trim() || `Run the "${sk.title || sk.name}" skill now.`;
    }
  }

  // The skills this bot always has on, plus a one-off /skill if one was used.
  const alwaysSkills = botId ? store.skillsForBot(botId) : [];
  // Names of every skill in the library, so the agent knows what /commands exist
  // and doesn't invent skills that aren't there.
  const skillIndex = store.listSkills().map((s) => ({ name: s.name, title: s.title }));

  const abortController = new AbortController();
  // A stopped run may still be unwinding when the next one starts, so each run
  // carries a token and only ever tidies up after itself.
  const token = {};
  // Ties every audited step back to the one task that produced it.
  const taskId = crypto.randomUUID();
  running = { abortController, botId, chatId, token };
  send('agent-event', { type: 'status', text: 'running', botId, chatId, silent: Boolean(silent), dryRun: Boolean(dryRun) });

  // Whether the agent got far enough to touch anything. If it did not, a retry
  // is free; if it did, a retry would do the same work to the machine twice.
  let progressed = false;

  // What the check at the end gets to look at: everything the agent actually
  // did, the last thing it said about it, and which hands it used — so the
  // check only asks for evidence this run already paid for.
  const acts = [];
  let lastReply = null;
  let usedScreen = false;
  let usedBrowser = false;

  const onEvent = (evt) => {
    // A finished tool call. Recorded before the stop check below, and on
    // purpose: a tool already running when Stop was pressed still did its
    // work to the machine, and an action missing from the log because the
    // user cut the run short is the one you would most want to find.
    // Bookkeeping only — the transcript drew this step when it was asked for.
    if (evt.type === 'tool_done') {
      acts.push({ text: evt.text || evt.name, ok: evt.ok !== false, error: evt.error || null });
      if (/^(screen_|launch_app|focus_window|list_windows)/.test(evt.name)) usedScreen = true;
      if (evt.name.startsWith('browser_')) usedBrowser = true;
      audit.write({
        botId: botId || null,
        botName: (bot && bot.name) || null,
        chatId: chatId || null,
        taskId,
        mode: 'agent',
        tool: evt.name,
        text: evt.text,
        args: evt.input,
        ok: evt.ok !== false,
        error: evt.error || null,
        ms: evt.ms,
        computer: computerLabel(),
        model: model || null,
        dryRun: Boolean(evt.dryRun),
      });
      return;
    }

    // Once stopped, this run is over as far as the user is concerned. Whatever
    // it emits while winding down goes nowhere.
    if (abortController.signal.aborted) return;
    if (evt.type === 'session') {
      if (botId && chatId) store.setSession(botId, chatId, evt.id);
      return; // internal bookkeeping, not something the UI shows
    }
    // A note the bot decided to keep. Written here so it survives even if the
    // window is closed before the turn ends.
    if (evt.type === 'remember') {
      if (botId) store.remember(botId, evt.text);
      send('agent-event', { ...evt, botId, chatId });
      return;
    }
    if (evt.type === 'tool' || evt.type === 'say_start' || evt.type === 'assistant') progressed = true;
    // The claim the check is testing. `done` repeats the closing line as null
    // when it has already been said, so the last non-empty one is the right one.
    if (evt.text && (evt.type === 'say_end' || evt.type === 'assistant' || evt.type === 'done')) lastReply = evt.text;
    if (record) record(evt);
    send('agent-event', { ...evt, botId, chatId });
  };

  // Everyone else the active bot can message. Left out of its own roster.
  const teammates = store.listBots()
    .filter((b) => b.id !== botId)
    .map((b) => ({ name: b.name, title: b.title }));

  // Deliver a message from the active bot to a named teammate and return the
  // teammate's reply. The exchange is shown in the transcript so it is not a
  // black box — you can see who asked whom for what.
  const messageBot = async (name, message) => {
    const target = store.listBots().find((b) => b.name.toLowerCase() === String(name).toLowerCase().trim());
    if (!target) {
      return `There is no bot called "${name}". Teammates you can message: ${teammates.map((t) => t.name).join(', ') || '(none yet)'}.`;
    }
    const from = (bot && bot.name) || 'Operator';
    onEvent({ type: 'teammate', from, to: target.name, message });
    let reply;
    try {
      reply = await agent.askBot({ bot: store.getBot(target.id), message, model });
    } catch (err) {
      reply = `(could not reach ${target.name}: ${err.message})`;
    }
    onEvent({ type: 'teammate_reply', from: target.name, to: from, reply });

    // Make it a real, visible conversation: record the exchange in a chat on the
    // bot that was messaged, so you can open that bot and read what it was asked
    // and what it answered. One rolling chat per sender keeps it tidy.
    try {
      const title = 'Messages · ' + from;
      const existing = store.listChats(target.id).find((c) => c.title === title);
      const cid = existing ? existing.id : store.createChat(target.id).id;
      const chat = store.getChat(target.id, cid);
      const turns = (chat && chat.turns) || [];
      turns.push({ k: 'you', text: message });
      turns.push({ k: 'says', text: reply });
      store.saveChat(target.id, cid, { title, turns });
      // Nudge the UI to refresh the bot list / chats if it is showing this bot.
      send('agent-event', { type: 'teammate_saved', botId: target.id, chatId: cid });
    } catch (_) {}

    return reply;
  };

  // Email connector: hand the agent a facade bound to the stored account, if one
  // is connected. Credentials stay here — the agent only ever calls these. For a
  // Google (OAuth) account we refresh the access token on demand, since a task
  // can outlast the token's hour, and pass the fresh one into email.js.
  const emailConnected = store.getConnector('email');
  const emailApi = emailConnected && emailConnected.connected ? {
    list: async (o) => email.list({ cfg: await freshEmailCfg(), ...o }),
    read: async (o) => email.read({ cfg: await freshEmailCfg(), ...o }),
    send: async (o) => email.send({ cfg: await freshEmailCfg(), ...o }),
    mailboxes: async () => email.mailboxes({ cfg: await freshEmailCfg() }),
  } : null;

  // What a bot can do with the coding side: see the conversations, read one for
  // context, and send it a task. Reading is free; messaging actually runs the
  // coding assistant in that chat's folder and hands back what it said.
  const codeChats = {
    list: () => store.listCodeChats().map((c) => ({ id: c.id, title: c.title, folder: c.cwdName, updatedAt: c.updatedAt })),
    read: (ref) => {
      const c = findCodeChat(ref);
      if (!c) return null;
      const turns = (c.turns || []).slice(-40).map((t) => {
        if (t.k === 'you') return 'User: ' + t.text;
        if (t.k === 'says') return 'Assistant: ' + t.text;
        if (t.k === 'steps') return '[did: ' + (t.items || []).map((s) => `${s.name} ${(s.input && (s.input.file || s.input.command || s.input.pattern)) || ''}`.trim()).join('; ') + ']';
        return '';
      }).filter(Boolean).join('\n');
      return { title: c.title, folder: c.cwd, transcript: turns || '(empty)' };
    },
    message: async (ref, message) => {
      const c = findCodeChat(ref);
      if (!c) return { ok: false, error: 'no such code chat' };
      onEvent({ type: 'teammate', from: (bot && bot.name) || 'Operator', to: 'Code · ' + c.title, message });
      const r = await runCodeTask(c.id, message);
      onEvent({ type: 'teammate_reply', from: 'Code · ' + c.title, to: (bot && bot.name) || 'Operator', reply: r.ok ? (r.reply || 'Done.') : r.error });
      return r;
    },
  };

  // `again` is a follow-up turn on the same session — the check sending the run
  // back to fix something. It is not the user's message, so the /skill that was
  // invoked for this turn does not apply to it.
  const go = (resume, again) =>
    agent.runTask(again || prompt, {
      userDataDir: profileDir(),
      abortController,
      model: model || (bot && bot.model) || undefined,
      resume,
      bot,
      // Part of the session key: a session IS the conversation, so a different
      // chat must not be handed the one that is already open.
      chatId,
      teammates,
      messageBot,
      codeChats,
      email: emailApi,
      alwaysSkills,
      activeSkill: again ? null : activeSkill,
      skillIndex,
      dryRun,
      onEvent,
    });

  // The run does not get to mark its own homework. Once it thinks it is
  // finished, a second cheap model (verify.js) looks at the goal, what was
  // actually done and the screen as it is now, and says whether the goal was
  // met. On "no" the critique goes straight back into the same session as a
  // follow-up turn — bounded, so a stubborn task cannot loop the machine.
  const VERIFY_RETRIES = 1;

  async function checkTheWork() {
    // A run that did nothing has nothing to check — which is also how ordinary
    // conversation avoids paying for this at all.
    if (store.getPrefs().verify === false) return;
    if (!acts.length || abortController.signal.aborted) return;

    for (let tries = 0; ; tries++) {
      onEvent({ type: 'verify_start' });
      const v = await verify.check({
        goal: prompt, actions: acts, reply: lastReply, model,
        dryRun, usedScreen, usedBrowser, abortController,
      });
      if (abortController.signal.aborted) return;

      audit.write({
        botId: botId || null,
        botName: (bot && bot.name) || null,
        chatId: chatId || null,
        taskId,
        mode: 'agent',
        tool: 'verify',
        text: v.ok === true ? `Checked: the goal was met — ${v.why}`
          : v.ok === false ? 'Checked: the goal was NOT met'
          : 'Checked: could not tell',
        args: { goal: prompt, steps: acts.length, retry: tries },
        ok: v.ok === true,
        error: v.ok === true ? null : v.why,
        ms: v.ms,
        computer: computerLabel(),
        model: v.model,
        dryRun: Boolean(dryRun),
      });
      onEvent({ type: 'verify', ok: v.ok, why: v.why, model: v.model, ms: v.ms, cost: v.cost });

      // Met, or no honest verdict either way — either way, stop here. An
      // "unsure" must never send the agent back to redo work that was fine.
      if (v.ok !== false) return;
      if (tries >= VERIFY_RETRIES) return;      // out of retries; the verdict stands

      // Same conversation, not a new one: the agent has to see its own work to
      // fix it. Read the session back rather than reusing the one this task
      // started with — the run may have been handed a fresh one along the way.
      await go(botId && chatId ? store.sessionOf(botId, chatId) : null, verify.critique(v.why));
      if (abortController.signal.aborted) return;
    }
  }

  try {
    const resume = botId && chatId ? store.sessionOf(botId, chatId) : null;
    try {
      await go(resume);
    } catch (err) {
      // The SDK drops old session transcripts eventually. When resuming one it
      // no longer holds, start a fresh session instead of failing the task —
      // but only while nothing has happened yet.
      if (!resume || progressed || abortController.signal.aborted) throw err;
      store.forgetSession(botId, chatId);
      await go(null);
    }
    await checkTheWork();
  } catch (err) {
    // Raw SDK and Node failures mean nothing to someone who has just installed
    // this. errors.js turns the common ones into a sentence plus the fix, and
    // keeps the original so a bug report still has it.
    const e = errors.explain(err);
    if (!e.stopped) onEvent({ type: 'error', title: e.title, fix: e.fix, text: e.detail || e.title });
  } finally {
    overlay.hide();          // the agent has stopped pointing at things
    // If Stop already cleared this — or a newer task has started since — leave
    // it alone. Saying "idle" over the top of a live run would blank the UI.
    if (running && running.token === token) {
      running = null;
      send('agent-event', { type: 'status', text: 'idle', botId, chatId });
    }
  }
  return { ok: true };
}

ipcMain.handle('run-task', async (_e, prompt, model, botId, chatId, dryRun) =>
  runOne({ prompt, model, botId, chatId, dryRun }));

/* ── which computer Operator is driving ──────────────────────────── */

// A screenshot on demand, for the live "watch" view — independent of any task,
// so you can watch the (remote) screen even when the agent is idle.
ipcMain.handle('screen:grab', async (_e, opts) => {
  try {
    // The watch view asks for `full`: native resolution and higher JPEG quality,
    // so a fullscreen picture is crisp rather than an upscaled thumbnail.
    const grab = (opts && opts.full) ? { w: 0, q: 88 } : undefined;
    const s = await desktop.screenshot(undefined, grab);
    const t = desktop.target();
    return { ok: true, image: s.image, mime: s.mime, width: s.width, height: s.height,
             label: (t.kind === 'remote' ? 'Remote — ' : '') + (s.foreground || 'screen') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('input:quiet', async (_e, on) => {
  try { await desktop.setQuiet(on); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Give the agent its own hidden desktop, or take it back. Switching restarts the
// helper, so refuse mid-task rather than pull the desktop out from under a run.
ipcMain.handle('input:ownDesktop', async (_e, on) => {
  if (running) return { ok: false, error: 'Finish or stop the current task first.' };
  try {
    const isOn = desktop.usePrivateDesktop(on);
    overlay.hide();
    return { ok: true, on: isOn };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:status', async () => {
  const t = desktop.target();
  return { ...t, host: remoteHost };
});

let remoteHost = null;

ipcMain.handle('remote:connect', async (_e, url, token) => {
  try {
    // Prove it answers and the token is right BEFORE switching over, so a typo
    // doesn't leave the agent pointed at a machine that isn't listening.
    const pong = await desktop.ping({ url, token });
    desktop.useRemote({ url, token });
    remoteHost = (pong && pong.host) || null;
    overlay.hide();
    return { ok: true, host: remoteHost };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:disconnect', async () => {
  desktop.useRemote(null);
  remoteHost = null;
  return { ok: true };
});

/* ── code mode: ChatGPT-style history of coding conversations ─────── */

// One run per chat, not one run for the whole app. Two coding chats point at
// two different folders and have nothing to do with each other, so making one
// wait for the other only ever gets in the way — start a build in one, carry on
// in another, come back when it is done.
//
// The agent side stays deliberately single-file: there is one mouse, one
// keyboard and one screen over there, and two agents grabbing at them at once
// would fight. Files are not like that.
const codeRuns = new Map();   // chatId -> { abortController }

ipcMain.handle('codeChats:list', async () => store.listCodeChats());
ipcMain.handle('codeChats:get', async (_e, id) => store.getCodeChat(id));
// New chats default to a clean, dedicated projects workspace — never the whole
// home directory, which is huge and makes "make X" ambiguous (it goes hunting
// for an existing folder). New builds land in their own sub-folder here. The
// folder chip still lets you point a chat at any existing project instead.
function defaultCwd() {
  const chats = store.listCodeChats();
  const last = chats.find((c) => c.cwd);
  if (last && last.cwd) { try { if (fs.existsSync(last.cwd)) return { cwd: last.cwd, name: last.cwdName || path.basename(last.cwd) }; } catch (_) {} }
  const ws = path.join(app.getPath('home'), 'Operator Projects');
  try { fs.mkdirSync(ws, { recursive: true }); } catch (_) {}
  return { cwd: ws, name: 'Operator Projects' };
}

ipcMain.handle('codeChats:create', async () => {
  const d = defaultCwd();
  return store.createCodeChat({ model: agent.DEFAULT_MODEL, cwd: d.cwd, cwdName: d.name });
});
ipcMain.handle('codeChats:delete', async (_e, id) => { store.removeCodeChat(id); return { ok: true }; });
// --- audit trail -----------------------------------------------------------
// Read-only from the UI's side: the log is appended by the run, never edited by
// the person reading it, which is the only reason it is worth anything.

ipcMain.handle('audit:query', (_e, filter) => audit.query(filter || {}));
ipcMain.handle('audit:facets', () => audit.facets());

ipcMain.handle('audit:export', async (_e, format, filter) => {
  const ext = format === 'csv' ? 'csv' : 'jsonl';
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `operator-audit-${stamp}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };

  // Export what the filter is showing, not just the page on screen.
  const { rows } = audit.query({ ...(filter || {}), limit: Infinity, offset: 0 });
  const text = ext === 'csv' ? audit.toCSV(rows) : audit.toJSONL(rows);
  try {
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath, count: rows.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('codeChats:setModel', async (_e, id, model) => store.saveCodeChat(id, { model }));

// A chat is tied to a project folder. Pick one for this chat.
ipcMain.handle('code:pickFolder', async (_e, id) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const cwd = res.filePaths[0];
  const name = path.basename(cwd);
  if (id) store.saveCodeChat(id, { cwd, cwdName: name, title: store.getCodeChat(id).title === 'New chat' ? name : undefined });
  return { ok: true, cwd, name };
});

// Attach one of the user's bots to a code chat, so the coding assistant works
// with that bot's persona and memory.
ipcMain.handle('codeChats:setBot', async (_e, id, botId) => store.saveCodeChat(id, { botId: botId || null }));

// One place that actually runs a coding turn, so both the UI and a bot asking
// via message_code_chat drive the same machinery and land in the same history.
async function runCodeTask(chatId, prompt) {
  // Only this chat has to be free. Another chat working away is none of its
  // business.
  if (codeRuns.has(chatId)) return { ok: false, error: 'This chat is already working on something.' };
  const chat = store.getCodeChat(chatId);
  if (!chat) return { ok: false, error: 'No such code chat.' };
  if (!chat.cwd) return { ok: false, error: 'That code chat has no project folder yet.' };

  const abortController = new AbortController();
  const run = { abortController };
  const codeTaskId = crypto.randomUUID();
  codeRuns.set(chatId, run);
  send('code-event', { type: 'status', text: 'running', chatId });

  // Record the conversation as it happens so the sidebar history is real.
  const turns = chat.turns || [];
  turns.push({ k: 'you', text: prompt });
  let steps = null;
  const title = chat.title === 'New chat' ? prompt.slice(0, 60) : chat.title;
  store.saveCodeChat(chatId, { turns, title });

  let reply = '';
  try {
    await code.runCode(prompt, {
      cwd: chat.cwd,
      model: chat.model || undefined,
      resume: chat.sessionId || undefined,
      bot: chat.botId ? store.getBot(chat.botId) : null,
      abortController,
      onEvent: (evt) => {
        // Stopped means stopped: nothing from a run on its way out reaches the
        // transcript or the screen.
        if (abortController.signal.aborted) return;
        if (evt.type === 'session') { store.saveCodeChat(chatId, { sessionId: evt.id }); return; }
        if (evt.type === 'assistant' || evt.type === 'say_end' || (evt.type === 'done' && evt.text)) {
          if (String(evt.text || '').trim()) { turns.push({ k: 'says', text: evt.text }); reply = evt.text; steps = null; }
        } else if (evt.type === 'tool') {
          if (!steps) { steps = { k: 'steps', items: [] }; turns.push(steps); }
          steps.items.push({ name: evt.name, input: evt.input });
          // Code mode runs on the SDK's own file tools, so unlike the computer
          // tools there is no wrapper to time or catch them: all we honestly
          // know here is that the step was asked for. `ok: null` says so rather
          // than claiming a success we did not observe.
          audit.write({
            botId: chat.botId || null, chatId, taskId: codeTaskId, mode: 'code',
            tool: evt.name, text: null, args: evt.input, ok: null, ms: null,
            computer: `project ${chat.cwdName || chat.cwd}`, model: chat.model || null, dryRun: false,
          });
        } else if (evt.type === 'tool_error') {
          if (!steps) { steps = { k: 'steps', items: [] }; turns.push(steps); }
          steps.items.push({ name: 'error', input: { command: evt.text }, err: true });
          audit.write({
            botId: chat.botId || null, chatId, taskId: codeTaskId, mode: 'code',
            tool: 'error', text: null, args: {}, ok: false, error: evt.text, ms: null,
            computer: `project ${chat.cwdName || chat.cwd}`, model: chat.model || null, dryRun: false,
          });
        }
        if (evt.type !== 'say_delta' && evt.type !== 'say_start') store.saveCodeChat(chatId, { turns });
        send('code-event', { ...evt, chatId });
      },
    });
  } catch (err) {
    const msg = errors.explainLine(err);
    send('code-event', { type: 'error', text: msg, chatId });
    return { ok: false, error: msg };
  } finally {
    // However this turn ended, this chat is free again — and only this one.
    // Unless Stop already freed it and a new turn is under way, in which case
    // this run has no business declaring anything.
    if (codeRuns.get(chatId) === run) {
      codeRuns.delete(chatId);
      send('code-event', { type: 'status', text: 'idle', chatId });
    }
  }
  return { ok: true, reply };
}

ipcMain.handle('code:run', async (_e, chatId, prompt) => runCodeTask(chatId, prompt));

// Bots name a code chat by title (or id); match loosely so "tetris" finds it.
function findCodeChat(ref) {
  const want = String(ref || '').toLowerCase().trim();
  if (!want) return null;
  const all = store.listCodeChats();
  const hit = all.find((c) => c.id === ref)
    || all.find((c) => (c.title || '').toLowerCase() === want)
    || all.find((c) => (c.title || '').toLowerCase().includes(want))
    || all.find((c) => (c.cwdName || '').toLowerCase().includes(want));
  return hit ? store.getCodeChat(hit.id) : null;
}

// Stop one chat's run. Without an id it stops all of them, which is what
// quitting or a panic button wants.
ipcMain.handle('code:stop', async (_e, chatId) => {
  // Free the chat and call it idle straight away rather than waiting for a
  // command or a model call already in flight to finish. The run keeps
  // unwinding in the background with its events muted.
  const halt = (id) => {
    const run = codeRuns.get(id);
    if (!run) return;
    codeRuns.delete(id);
    run.abortController.abort();
    send('code-event', { type: 'status', text: 'idle', chatId: id });
  };
  if (chatId) halt(chatId);
  else [...codeRuns.keys()].forEach(halt);
  return { ok: true };
});

// Which chats are mid-run — so the window can paint the right state when you
// switch between them, or after a reload.
ipcMain.handle('code:running', async () => [...codeRuns.keys()]);

/* ── connectors ──────────────────────────────────────────────────── */

// The email config with a usable access token. For OAuth accounts, refresh and
// persist the token when it is missing or within a minute of expiring.
async function freshEmailCfg() {
  const cfg = store.getConnector('email');
  if (!cfg || cfg.auth !== 'oauth') return cfg;
  if (cfg.accessToken && Date.now() < (cfg.expiry || 0) - 60000) return cfg;
  const creds = store.getGoogle();
  const t = await googleOAuth.refresh({
    clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken: cfg.refreshToken,
  });
  store.setConnector('email', { ...cfg, accessToken: t.accessToken, expiry: t.expiry });
  return store.getConnector('email');
}

ipcMain.handle('connectors:list', async () => store.listConnectors());

// The Google OAuth client the user set up. The secret is never sent back to the
// UI — only whether one is saved, plus the client ID so the field can prefill.
ipcMain.handle('connectors:googleGetCreds', async () => {
  const g = store.getGoogle();
  return { clientId: g.clientId, hasSecret: Boolean(g.clientSecret), configured: Boolean(g.clientId && g.clientSecret) };
});

ipcMain.handle('connectors:googleSetCreds', async (_e, creds) => {
  return store.setGoogle(creds || {});
});

// Run "Sign in with Google", then store the account as the email connector.
ipcMain.handle('connectors:googleSignIn', async () => {
  const creds = store.getGoogle();
  if (!creds.clientId || !creds.clientSecret) return { ok: false, needCreds: true, error: 'Add your Google client ID and secret first.' };
  try {
    const res = await googleOAuth.signIn(creds);
    // Prove the token actually opens the mailbox before calling it connected.
    const cfg = {
      provider: 'Gmail', auth: 'oauth', email: res.email, name: res.email,
      imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com',
      refreshToken: res.refreshToken, accessToken: res.accessToken, expiry: res.expiry, oauth: true,
    };
    await email.list({ cfg, limit: 1 });
    store.setConnector('email', cfg);
    return { ok: true, email: res.email };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Verify the email account works, then save it. The password is stored locally
// (settings.json) and never returned to the UI.
ipcMain.handle('connectors:connectEmail', async (_e, cfg) => {
  try {
    const res = await email.test(cfg || {});
    if (!res.ok) return res;
    store.setConnector('email', {
      email: cfg.email,
      password: cfg.password,
      name: cfg.name || cfg.email,
      imapHost: cfg.imapHost || null,
      smtpHost: cfg.smtpHost || null,
      provider: res.provider,
    });
    return { ok: true, provider: res.provider, email: cfg.email };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('connectors:disconnect', async (_e, id) => {
  store.removeConnector(id);
  return { ok: true };
});

/* ── bots ────────────────────────────────────────────────────────── */

ipcMain.handle('bots:list', async () => store.listBots());
ipcMain.handle('bots:get', async (_e, id) => store.getBot(id));
ipcMain.handle('bots:create', async (_e, spec) => store.createBot(spec || {}));
// An agent is a bot and its one thread, so the rail never has to make the two
// separately and risk ending up with a bot that has nothing to open.
ipcMain.handle('agents:create', async (_e, spec) => store.createAgent(spec || {}));
ipcMain.handle('agents:thread', async (_e, id) => store.threadOf(id));

// Workspaces — named folders of agents. Filing only: nothing here scopes what
// an agent can reach, and the UI must not imply that it does.
ipcMain.handle('workspaces:list', async () => store.listWorkspaces());
ipcMain.handle('workspaces:create', async (_e, name) => store.createWorkspace(name));
ipcMain.handle('workspaces:update', async (_e, id, patch) => store.updateWorkspace(id, patch || {}));
ipcMain.handle('workspaces:delete', async (_e, id) => store.deleteWorkspace(id));
ipcMain.handle('workspaces:file', async (_e, botId, wsId) => store.setAgentWorkspace(botId, wsId));
ipcMain.handle('bots:update', async (_e, id, patch) => store.updateBot(id, patch || {}));
ipcMain.handle('bots:delete', async (_e, id) => { store.deleteBot(id); return { ok: true }; });
ipcMain.handle('bots:forget', async (_e, id, noteId) => { store.forget(id, noteId); return { ok: true }; });
ipcMain.handle('bots:remember', async (_e, id, text) => store.remember(id, text));

// The account-wide skill library (created and edited in Settings → Skills).
ipcMain.handle('skills:list', async () => store.listSkills());
ipcMain.handle('skills:create', async (_e, spec) => store.createSkill(spec || {}));
ipcMain.handle('skills:update', async (_e, skillId, patch) => store.updateSkill(skillId, patch || {}));
ipcMain.handle('skills:delete', async (_e, skillId) => store.deleteSkill(skillId));

// Turning a library skill on/off for a bot (always-on for that bot).
ipcMain.handle('bots:attachSkill', async (_e, botId, skillId) => store.attachSkill(botId, skillId));
ipcMain.handle('bots:detachSkill', async (_e, botId, skillId) => store.removeSkill(botId, skillId));

ipcMain.handle('routines:add', async (_e, id, spec) => { const r = store.addRoutine(id, spec || {}); tick(); return r; });
ipcMain.handle('routines:update', async (_e, id, rid, patch) => store.updateRoutine(id, rid, patch || {}));
ipcMain.handle('routines:remove', async (_e, id, rid) => { store.removeRoutine(id, rid); return { ok: true }; });

/* ── chats, which live under a bot ───────────────────────────────── */

// The phone letterbox. Off unless the user turns it on, and the token is what
// keeps it shut — see phone.js.
ipcMain.handle('phone:status', () => phone.status());
ipcMain.handle('phone:start', () => { const st = phone.start(); store.setPrefs({ phoneOn: true }); return st; });
ipcMain.handle('phone:stop', () => { const st = phone.stop(); store.setPrefs({ phoneOn: false }); return st; });
ipcMain.handle('phone:rotate', () => phone.rotate());

ipcMain.handle('prefs:get', () => store.getPrefs());
ipcMain.handle('prefs:set', (_e, patch) => store.setPrefs(patch));

// Window buttons. Ours to draw now that the native overlay is gone, so they
// have to be ours to operate too.
ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window:maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => { if (win) win.close(); });

ipcMain.handle('chats:list', async (_e, botId) => store.listChats(botId));
ipcMain.handle('chats:get', async (_e, botId, id) => store.getChat(botId, id));
ipcMain.handle('chats:create', async (_e, botId) => store.createChat(botId));

ipcMain.handle('chats:save', async (_e, botId, id, patch) => store.saveChat(botId, id, patch || {}));
ipcMain.handle('chats:delete', async (_e, botId, id) => { store.removeChat(botId, id); return { ok: true }; });


/* ── routines: work that starts without you ──────────────────────── */

// The renderer records the chat you are watching. A routine fires into a chat
// nobody has open, so its transcript is written here instead.
function makeRecorder(botId, chatId, prompt) {
  const turns = [{ k: 'you', text: prompt }];
  let steps = null;
  const put = () => store.saveChat(botId, chatId, { turns });
  put();

  return (evt) => {
    if (evt.type === 'say_end' || evt.type === 'assistant' || (evt.type === 'done' && evt.text)) {
      if (!String(evt.text || '').trim()) return;
      steps = null;
      turns.push({ k: 'says', text: evt.text });
      put();
    } else if (evt.type === 'tool') {
      if (!steps) { steps = { k: 'steps', items: [] }; turns.push(steps); }
      steps.items.push({ name: evt.name, input: evt.input || {}, at: '' });
      put();
    } else if (evt.type === 'error') {
      steps = null;
      turns.push({ k: 'error', text: evt.text });
      put();
    }
  };
}

const SPAN = { min5: 5, min15: 15, min30: 30, hour: 60 };

function dueNow(r, now) {
  if (r.paused) return false;
  const last = r.lastRun || 0;

  // Anything under a day repeats from its last run rather than a clock slot.
  if (SPAN[r.every]) return now - last >= SPAN[r.every] * 60 * 1000;

  const parts = String(r.at || '09:00').split(':');
  const slot = new Date(now);
  slot.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);

  if (now < slot.getTime()) return false;    // the hour has not come round yet
  if (last >= slot.getTime()) return false;  // already ran for this slot

  const day = slot.getDay(); // 0 Sunday
  if (r.every === 'weekday' && (day === 0 || day === 6)) return false;
  if (r.every === 'week' && day !== 1) return false;
  return true;
}

async function fireRoutine(botId, routine) {
  store.updateRoutine(botId, routine.id, { lastRun: Date.now() });
  const chat = store.createChat(botId);
  store.saveChat(botId, chat.id, { title: routine.name });

  send('agent-event', { type: 'routine', name: routine.name, botId, chatId: chat.id });
  await runOne({
    prompt: routine.prompt,
    botId,
    chatId: chat.id,
    silent: true,
    record: makeRecorder(botId, chat.id, routine.prompt),
  });
  send('bots-changed', { botId });
}

// One physical desktop, one mouse: routines queue behind whatever is running
// rather than fighting it for the screen.
async function tick() {
  if (running) return;
  const now = Date.now();

  for (const { botId, routine } of store.allRoutines()) {
    if (!dueNow(routine, now)) continue;
    await fireRoutine(botId, routine);
    return; // one per tick; the next is picked up 30s later
  }
}

// Start one by hand, so a routine can be proved without waiting for its hour.
ipcMain.handle('routines:run', async (_e, botId, routineId) => {
  if (running) return { ok: false, error: 'Something is already running.' };
  const b = store.getBot(botId);
  const r = b && b.routines.find((x) => x.id === routineId);
  if (!r) return { ok: false, error: 'That routine is gone.' };
  fireRoutine(botId, r); // not awaited: the panel should not sit and wait
  return { ok: true };
});

setInterval(() => { tick().catch(() => {}); }, 30000);

// Sign in to a site once by hand and the agent's browser keeps it. This is the
// cheapest fix for every "it could not log in" failure.
ipcMain.handle('browser:open', async (_e, url) => {
  try {
    const page = await browser.ensureBrowser(profileDir());
    await page.goto(url || 'https://myaccount.google.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return { ok: true, chrome: browser.isRealChrome() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// Stop means stop NOW. Aborting on its own is not enough: a tool already in
// flight — a PowerShell command, a page load, a model that has not started
// answering — keeps going until it finishes, and the old code waited for all of
// that before admitting the task was over. So free the slot and say "idle" here,
// and let the run unwind quietly in the background. Its events are dropped from
// the moment it is aborted, so nothing it does on the way out reaches the
// screen or the transcript.
ipcMain.handle('stop-task', async () => {
  if (!running) return { ok: true };
  const { abortController, botId, chatId } = running;
  running = null;
  abortController.abort();
  overlay.hide();
  send('agent-event', { type: 'status', text: 'idle', botId, chatId });
  return { ok: true };
});

/* ── hands-free voice mode ───────────────────────────────────────────
 * voice.js holds the brain and the tool schemas; this is the other half —
 * what those tools actually do to the app. Kept here because it is all store
 * and window work, which voice.js deliberately knows nothing about.
 *
 * Speaking goes through piper.js when the neural voice is installed and falls
 * back to the Windows SAPI voice in speech.js when it is not, so hands-free
 * mode works out of the box and simply sounds better once Piper is there.
 */

// Voice names things the way a person does — "the invoices one", "Kimi" — so
// matching is deliberately loose: exact first, then start-of-name, then
// contains, then the closest by shared words.
function findAgent(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const all = store.listBots();
  return all.find((b) => b.name.toLowerCase() === want)
    || all.find((b) => b.name.toLowerCase().startsWith(want))
    || all.find((b) => b.name.toLowerCase().includes(want))
    || all.find((b) => want.includes(b.name.toLowerCase()))
    || all.find((b) => {
      const words = want.split(/\s+/).filter((w) => w.length > 3);
      return words.some((w) => b.name.toLowerCase().includes(w));
    })
    || null;
}

function findSpace(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want || want === 'none' || want === 'no workspace') return null;
  const all = store.listWorkspaces();
  return all.find((w) => w.name.toLowerCase() === want)
    || all.find((w) => w.name.toLowerCase().startsWith(want))
    || all.find((w) => w.name.toLowerCase().includes(want))
    || null;
}

// "opus", "haiku", "sonnet 5" — spoken, never an exact model id.
function findModel(said) {
  const want = String(said || '').trim().toLowerCase();
  if (!want) return null;
  const all = agent.listModels();
  return (all.find((m) => m.id.toLowerCase() === want)
    || all.find((m) => m.name.toLowerCase() === want)
    || all.find((m) => m.name.toLowerCase().includes(want))
    || all.find((m) => m.id.toLowerCase().includes(want.replace(/\s+/g, '-')))
    || null);
}

// The rail and the open conversation are the renderer's; tell it to catch up
// whenever the voice has changed something underneath it.
const voiceChanged = () => send('voice-changed', {});

const voiceApp = {
  listAgents: async () => {
    const all = store.listBots();
    if (!all.length) return 'There are no agents yet.';
    const spaces = new Map(store.listWorkspaces().map((w) => [w.id, w.name]));
    return all.slice(0, 60).map((b) => {
      const where = b.pinned ? `pinned (${b.role || 'main'})` : b.workspaceId ? `in ${spaces.get(b.workspaceId) || 'a workspace'}` : 'in the list';
      return `${b.name} — ${where}${b.title ? `; ${b.title}` : ''}${b.lastLine ? `; last said: ${b.lastLine.slice(0, 80)}` : ''}`;
    }).join('\n');
  },

  readAgent: async (name, turns) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    const full = store.getBot(b.id);
    const chat = full && full.chats && full.chats[0];
    if (!chat || !chat.turns || !chat.turns.length) return `${b.name} has not said anything yet.`;
    const recent = chat.turns.slice(-Math.max(2, Math.min(20, turns || 6)));
    const lines = recent.map((t) => {
      if (t.k === 'you') return `User: ${t.text}`;
      if (t.k === 'says') return `${b.name}: ${t.text}`;
      if (t.k === 'error') return `${b.name} hit an error: ${t.text}`;
      if (t.k === 'check') return `A check on its work said the goal was ${t.ok === true ? 'met' : t.ok === false ? 'NOT met' : 'unclear'}: ${t.why || ''}`;
      if (t.k === 'steps') return `[it did: ${(t.items || []).map((s) => s.name).slice(0, 8).join(', ')}]`;
      return '';
    }).filter(Boolean);
    return `The last ${recent.length} turns of ${b.name}:\n${lines.join('\n').slice(0, 2500)}`;
  },

  makeAgent: async ({ name, title, persona, workspace, pinned, role }) => {
    const made = store.createAgent({
      name: String(name || 'New agent').slice(0, 40),
      title: title || '',
      persona: persona || '',
      pinned: Boolean(pinned),
      role: role || (pinned ? 'main' : null),
    });
    if (!made) return 'Could not make it — there are too many agents already.';
    const ws = findSpace(workspace);
    if (ws) store.setAgentWorkspace(made.id, ws.id);
    voiceChanged();
    return `Made "${made.name}"${ws ? ` in ${ws.name}` : ''}${pinned ? ', pinned to the top' : ''}.`;
  },

  configureAgent: async ({ name, newName, title, persona, model, pinned, role, workspace }) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    const patch = {};
    const did = [];
    if (newName) { patch.name = newName; did.push(`renamed it to ${newName}`); }
    if (title !== undefined) { patch.title = title; did.push('set what it does'); }
    if (persona !== undefined) { patch.persona = persona; did.push('set how it works'); }
    if (pinned !== undefined) { patch.pinned = pinned; patch.role = pinned ? (role || 'main') : null; did.push(pinned ? 'pinned it' : 'unpinned it'); }
    else if (role) { patch.pinned = true; patch.role = role; did.push(`badged it ${role}`); }
    if (model) {
      const m = findModel(model);
      if (!m) return `I do not have a model called "${model}".`;
      patch.model = m.id;
      did.push(`put it on ${m.name}`);
    }
    if (Object.keys(patch).length) store.updateBot(b.id, patch);
    if (workspace !== undefined) {
      const ws = findSpace(workspace);
      store.setAgentWorkspace(b.id, ws ? ws.id : null);
      did.push(ws ? `filed it in ${ws.name}` : 'took it out of its workspace');
    }
    voiceChanged();
    return did.length ? `${b.name}: ${did.join(', ')}.` : 'Nothing to change.';
  },

  rememberFor: async (name, note) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    store.remember(b.id, String(note).slice(0, 200));
    voiceChanged();
    return `${b.name} will remember that.`;
  },

  deleteAgent: async (name) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    store.deleteBot(b.id);
    voiceChanged();
    return `Deleted ${b.name}.`;
  },

  openAgent: async (name) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    send('voice-open', { botId: b.id });
    return `${b.name} is on screen.`;
  },

  listWorkspaces: async () => {
    const all = store.listWorkspaces();
    if (!all.length) return 'There are no workspaces yet.';
    return all.map((w) => `${w.name} — ${w.count} agent${w.count === 1 ? '' : 's'}`).join('\n');
  },

  makeWorkspace: async (name) => {
    const w = store.createWorkspace(name);
    voiceChanged();
    return `Made the workspace "${w.name}".`;
  },

  renameWorkspace: async (name, newName) => {
    const w = findSpace(name);
    if (!w) return `There is no workspace called "${name}".`;
    const out = store.updateWorkspace(w.id, { name: newName });
    voiceChanged();
    return `Renamed it to "${out.name}".`;
  },

  deleteWorkspace: async (name) => {
    const w = findSpace(name);
    if (!w) return `There is no workspace called "${name}".`;
    const r = store.deleteWorkspace(w.id);
    voiceChanged();
    return `Deleted "${w.name}"${r.freed ? `; its ${r.freed} agent${r.freed === 1 ? '' : 's'} went back to the list` : ''}.`;
  },

  fileAgent: async (name, workspace) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    const ws = findSpace(workspace);
    store.setAgentWorkspace(b.id, ws ? ws.id : null);
    voiceChanged();
    return ws ? `${b.name} is now in ${ws.name}.` : `${b.name} is back in the main list.`;
  },

  // Real work on the real machine. This deliberately does NOT wait: a task can
  // run for minutes, and holding the voice turn open would leave the user
  // listening to nothing. It starts the run and returns, and everything it does
  // goes through the same runOne as a typed task — same policy, same audit,
  // same check at the end.
  sendToAgent: async (name, task) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    if (running) return `${b.name} cannot start — something else is using the computer right now.`;

    const thread = store.threadOf(b.id);
    send('voice-open', { botId: b.id });

    runOne({
      prompt: task,
      botId: b.id,
      chatId: thread.id,
      record: makeRecorder(b.id, thread.id, task),
    }).then(() => { voiceChanged(); send('bots-changed', { botId: b.id }); });

    return `Started. ${b.name} is doing it now, in the background. Do not report a result — say it has been set going.`;
  },
};

/* what the renderer calls */

ipcMain.handle('voice:warm', async () => {
  const out = { ok: true, tts: 'sapi', rate: 22050 };
  if (piper.installed()) {
    const w = piper.warm();
    if (w.ok) { out.tts = 'piper'; out.rate = w.rate; }
    else out.ttsError = w.error;
  } else {
    out.ttsError = piper.describeMissing();
  }
  // Opening the SDK session is the slow part — pay it before the first word.
  voice.warm(voiceApp).catch(() => {});
  return out;
});

// What the voice needs to know before it can answer almost anything: which
// agents exist, and which one is on screen. Handing it over with the utterance
// saves a whole round trip to list_agents on most turns, and a round trip is
// about a second and a half of someone sitting in silence.
function voiceContext(onScreen) {
  const spaces = new Map(store.listWorkspaces().map((w) => [w.id, w.name]));
  const names = store.listBots().slice(0, 40).map((b) => {
    const where = b.pinned ? 'pinned' : b.workspaceId ? (spaces.get(b.workspaceId) || 'a workspace') : 'list';
    return `${b.name} (${where})`;
  });
  const ws = store.listWorkspaces().map((w) => `${w.name} (${w.count})`);
  return [
    'CONTEXT, not something the user said aloud — never read this out:',
    onScreen ? `On screen: "${onScreen}".` : null,
    names.length ? `Agents: ${names.join(', ')}.` : 'There are no agents yet.',
    ws.length ? `Workspaces: ${ws.join(', ')}.` : 'There are no workspaces yet.',
    'Names above are exact. Use them without calling list_agents first.',
  ].filter(Boolean).join(' ');
}

ipcMain.handle('voice:heard', async (_e, said, onScreen) => {
  const here = voiceContext(onScreen);
  try {
    await voice.heard(said, voiceApp, (evt) => {
      if (evt.type === 'say') speakOut(evt.text);
      send('voice-event', { ev: 'voice', ...evt });
    }, here);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('voice:hush', async () => { piper.hush(); speech.hush(); return { ok: true }; });
ipcMain.handle('voice:end', async () => { voice.close(); piper.hush(); return { ok: true }; });

// One way out for everything spoken, so the fallback is decided in a single
// place rather than at each call site.
function speakOut(text) {
  if (piper.installed()) piper.say(text);
  else speech.say(text);
}

ipcMain.handle('voice-say', async (_e, text) => { speech.say(text); return { ok: true }; });
ipcMain.handle('voice-hush', async () => { speech.hush(); return { ok: true }; });

// Warm the model up when the mic goes on, so the first thing you say isn't the
// one that waits several seconds for large-v3 to reach the GPU.
ipcMain.handle('whisper-warm', async () => {
  const missing = whisper.describeMissing();
  if (missing) return { ok: false, error: missing };
  try {
    await whisper.ready();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('whisper-transcribe', async (_e, wav) => {
  try {
    const text = await whisper.transcribe(Buffer.from(wav));
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
