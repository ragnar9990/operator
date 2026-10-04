// main.js — Electron main process. Wires the UI to the agent + its browser.

// Every Claude brain here — the agent, the checker, Code, the voice — is a
// Claude Code subprocess, and each one inherits this environment. By default
// that subprocess checks for updates and reports telemetry before it answers,
// and writes a turn summary after: measured on this machine, 6.1s from start
// to first answer with it and 2.3s without, and about a second off the end of
// every turn. Only set when the user has not chosen for themselves.
if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
}

// An ANTHROPIC_API_KEY the user set for themselves, kept so removing the key
// saved in Settings falls back to it rather than to nothing.
const ENV_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Notification, Tray, Menu } = require('electron');
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
const modelOptions = require('./model-options');
const handover = require('./handover');
const employees = require('./employees');
const errors = require('./errors');
const crash = require('./crash');
const phone = require('./phone');
const email = require('./email');
const code = require('./code');
const googleOAuth = require('./google-oauth');
const files = require('./files');
const playbooks = require('./playbooks');
const watchers = require('./watchers');
const local = require('./local');

let win = null;
let running = null; // { abortController }

// Automated tests drive the real app from outside. With this set — and only
// then — they can reach the agent's browser to play the user's part, such as
// typing a password at their turn.
if (process.env.OPERATOR_TEST_HOOKS === '1') global.__operatorTest = { browser };
let tray = null;
let quitting = false;   // a real quit, not the window closing into the tray
// Started by Windows at sign-in: come up in the tray, not in your face.
const startHidden = process.argv.includes('--hidden');

// One Operator at a time. With the window hidden in the tray, opening it again
// from the Start menu means "show me" — not a second copy fighting the first
// over the mouse and the same files.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: !(startHidden && store.getPrefs().tray),
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

  // A file dropped anywhere the page did not catch it would otherwise replace
  // the whole app with that file. This is a single page; it never navigates.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  // A thrown error in the renderer is otherwise invisible unless devtools are
  // open, which they never are on someone else's machine. Warnings and errors
  // come through to whoever started the app.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 2) return;
    const where = source ? ' (' + String(source).split(/[\/]/).pop() + ':' + line + ')' : '';
    console.error('[ui]' + where + ' ' + message);
  });

  // The renderer going down (a crash, an out-of-memory kill) is the one failure
  // the user sees as a blank window with no idea why. Log it so the report has
  // it; a killed/crashed renderer also gets reloaded so the app is not a corpse.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason === 'clean-exit') return;
    crash.record('renderer-gone', new Error(`renderer ${details.reason} (exit ${details.exitCode})`), details);
    if ((details.reason === 'crashed' || details.reason === 'oom') && win && !win.isDestroyed()) {
      try { win.webContents.reload(); } catch { /* nothing more to try */ }
    }
  });

  // With the tray on, closing the window only hides it: reminders, routines
  // and employees all run in this process, so they carry on. Quit is in the
  // tray. No tray icon (it failed, or it is switched off) means close is quit.
  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
    hintTray();
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Once the window is actually up, offer to send anything that crashed before.
  win.webContents.once('did-finish-load', () => setTimeout(surfacePendingCrashes, 1200));

  // Live view: whichever surface the agent last looked at, browser or desktop.
  browser.setFrameListener((b64, url) => send('agent-event', { type: 'screenshot', b64, label: url, mime: 'image/png', employee: Boolean(running && running.employee) }));
  desktop.setFrameListener((b64, label, mime) => send('agent-event', { type: 'screenshot', b64, label, mime, employee: Boolean(running && running.employee) }));

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
  // First, before anything else can throw: catch what nothing else catches.
  // An uncaught error in the main process leaves state unknown, so it is logged
  // and the app comes back up clean rather than limping on — unless it fell over
  // almost at once, which would just loop a relaunch.
  crash.init(app.getPath('userData'), {
    onFatal: (rec) => {
      try {
        dialog.showErrorBox('Operator needs to restart',
          'Operator hit an unexpected error and has to restart.\n\n' +
          (rec && rec.reason ? rec.reason + '\n\n' : '') +
          'A crash report was saved on this computer — you can send it to get the bug fixed.');
      } catch { /* a dialog that will not show is not a reason to hang */ }
      try { if (process.uptime() > 8) app.relaunch(); } catch { /* relaunch is best-effort */ }
      app.exit(1);
    },
  });

  store.init(app.getPath('userData'));
  audit.init(app.getPath('userData'));
  playbooks.init(app.getPath('userData'));
  watchers.init(app.getPath('userData'), watcherHooks);
  setTimeout(() => { checkMachines().catch(() => {}); }, 3000);
  checkEmailSoon();

  // The NVIDIA NIM key, if there is one, and the live list of what that key
  // can reach. Both are cheap and neither blocks the window. A key saved before
  // the paste-cleaning existed — "Bearer nvapi-…" straight out of NVIDIA's code
  // sample — is repaired here rather than failing every task until it is typed
  // in again.
  const { key: saved, unavailable } = store.getNvidia();
  const clean = agent.nim.cleanKey(saved);
  if (clean !== saved) { store.setNvidia(clean); store.setNvidiaUnavailable(unavailable); }
  agent.nim.setKey(clean);
  applyAnthropicKey();

  // What NVIDIA would not serve last time stays out of the picker, and a model
  // that 404s during a task joins it.
  agent.nim.setUnavailable(unavailable);
  agent.nim.onUnavailableChange((ids) => store.setNvidiaUnavailable(ids));
  agent.nim.refresh().catch(() => {});

  // A model server on this computer, if one is running — found now, so a
  // saved choice of a local model is ready before the first task.
  local.setCustom(store.getLocal().url);
  local.refresh().catch(() => {});

  // Hand Operator another machine at launch:
  //   set OPERATOR_REMOTE_URL=http://192.168.1.50:8391
  //   set OPERATOR_REMOTE_TOKEN=...
  // The UI can also connect at runtime via the remote:* handlers below.
  if (process.env.OPERATOR_REMOTE_URL) {
    desktop.useRemote({ url: process.env.OPERATOR_REMOTE_URL, token: process.env.OPERATOR_REMOTE_TOKEN || '' });
  }

  createWindow();
  syncTray();
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

// Signing out or shutting down is a real quit, not a close into the tray.
app.on('session-end', () => { quitting = true; });

// The helper is a separate process; a hard quit would otherwise orphan it.
app.on('before-quit', () => { quitting = true; tray?.destroy(); tray = null; phone.stop(); agent.closeSession(); voice.close(); desktop.stop(); speech.stop(); piper.stop(); whisper.stop(); overlay.destroy(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// A GPU, utility or Chromium child process that dies takes something with it —
// the live view, a browser tab — without throwing anywhere JS can see. Log it so
// the pattern shows up in a report, but do not quit: the app usually recovers.
app.on('child-process-gone', (_e, details) => {
  if (details && details.reason === 'clean-exit') return;
  crash.record('child-gone', new Error(`${details.type} ${details.reason} (exit ${details.exitCode})`), details);
});

// The saved crashes the user has not yet sent or dismissed. Offered once, when
// the window is up, as a plain choice — nothing is sent without the click.
function surfacePendingCrashes() {
  let rows = [];
  try { rows = crash.pending(); } catch { return; }
  if (!rows.length || !win || win.isDestroyed()) return;
  // Started hidden at sign-in: ask when the window is first opened, not then.
  if (!win.isVisible()) { win.once('show', () => setTimeout(surfacePendingCrashes, 800)); return; }
  let choice = 2;
  try {
    choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Operator closed unexpectedly',
      message: rows.length === 1 ? 'Operator hit a problem recently.' : `Operator hit ${rows.length} problems recently.`,
      detail: 'A crash report was saved on this computer. Sending it helps get the bug fixed — nothing else leaves your machine.',
      buttons: ['Copy report', 'Show the file', 'Not now'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
  } catch { return; }
  // The report is the crashes being offered, not every one ever logged.
  const ids = rows.map((r) => r.id);
  try {
    if (choice === 0) { clipboard.writeText(crash.reportText(ids)); crash.markHandled(ids); }
    else if (choice === 1) { shell.openPath(crash.dir()); crash.markHandled(ids); }
    // "Not now" leaves them pending, to be offered again next launch.
  } catch { /* the offer failing is not worth a crash of its own */ }
}

// Settings → Audit: the same crashes, any time. A report is the ones not yet
// sent, or the latest few if all of them have been; copying or sending it is
// what marks them dealt with.
const crashIds = () => { const rows = crash.pending(); return (rows.length ? rows : crash.all(20)).map((r) => r.id); };
ipcMain.handle('crash:summary', () => {
  const rows = crash.all();
  return { count: rows.length, pending: crash.pending().length, last: rows[0] ? rows[0].t : null, canSend: Boolean(process.env.OPERATOR_CRASH_URL) };
});
ipcMain.handle('crash:copy', () => {
  const ids = crashIds();
  if (!ids.length) return { ok: false, error: 'No crash reports.' };
  clipboard.writeText(crash.reportText(ids));
  crash.markHandled(ids);
  return { ok: true, count: ids.length };
});
ipcMain.handle('crash:open', async () => {
  const err = await shell.openPath(crash.dir());
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('crash:send', () => crash.upload(crashIds()));

const profileDir = () => path.join(app.getPath('userData'), 'agent-profile');

// Where a step actually happened. Read per event rather than per task, because a
// remote machine can be paired or dropped while a task is still running.
function computerLabel() {
  const t = desktop.target();
  if (t.kind === 'remote') {
    const m = store.listMachines().find((x) => x.url === t.url);
    return m ? `${m.name} (${t.url})` : `remote ${t.url}`;
  }
  return desktop.isPrivate() ? 'private desktop' : 'this desktop';
}

// Everything the picker can offer: the Claude models the subscription covers,
// plus every model NVIDIA NIM is serving right now. The catalog is refreshed
// in the background, so opening the picker never waits on the network.
ipcMain.handle('list-models', async () => {
  agent.nim.refresh().catch(() => {});
  // Quick when nothing is running locally (a refused connection comes back at
  // once), and cached for a minute — so it is waited for, and a server started
  // a moment ago is in the menu the next time it opens.
  await local.refresh().catch(() => {});
  return {
    models: agent.listModels(),
    current: agent.DEFAULT_MODEL,
    nvidia: nvidiaStatus(),
    anthropic: anthropicStatus(),
  };
});

// The dial beside the picker: which controls a model has, and what they are
// set to on this side (Agents or Code). Setting returns the new state so the
// window never has to guess what was kept.
const modelOptionsState = (mode, id) => {
  const saved = store.getModelOptions(mode)[id];
  return {
    spec: modelOptions.specFor(id),
    values: modelOptions.resolve(mode, id, saved),
    summary: modelOptions.summary(mode, id, saved),
  };
};
ipcMain.handle('model-options:get', async (_e, mode, id) => modelOptionsState(mode, id));

// The user's turn (handover.js): their answers from the card in the chat.
ipcMain.handle('handover:done', async (_e, id, text) => handover.finish(id, 'user', text));
ipcMain.handle('handover:skip', async (_e, id) => handover.finish(id, 'skipped'));
ipcMain.handle('handover:show', async (_e, id) => handover.show(id));

// Said where they will see it even with Operator in the background: a Windows
// notification (clicking it brings Operator up) and a flashing taskbar button.
function tellUserItIsTheirTurn(evt) {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  if (process.env.OPERATOR_NO_NOTIFY === '1') return;   // automated tests
  try { win.flashFrame(true); } catch (_) {}
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: evt.helperName ? `${evt.helperName} needs you` : 'Operator needs you',
      body: String(evt.what || 'Your turn.').slice(0, 200),
    });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch (_) { /* a missing notification is not worth failing a task over */ }
}
ipcMain.handle('model-options:set', async (_e, mode, id, patch) => {
  store.setModelOptions(mode, id, patch);
  return modelOptionsState(mode, id);
});

/* ── Anthropic API key ───────────────────────────────────────────── */

// Anthropic does not let a product built on the Agent SDK run on a customer's
// claude.ai login, so an installed copy runs Claude on the customer's own API
// key or not at all. Run from source (npm start) it is the developer's own
// machine, where their own login is fine. Every Claude brain here is a
// subprocess that inherits this environment, so setting it once covers the
// agent, the check, Code, the voice and the helpers.
function applyAnthropicKey() {
  const key = store.getAnthropic() || ENV_ANTHROPIC_KEY;
  if (key) process.env.ANTHROPIC_API_KEY = key;
  else delete process.env.ANTHROPIC_API_KEY;
}

// OPERATOR_AS_INSTALLED=1 makes a run from source behave like an installed
// copy, so the no-key path can be tested without building an installer.
const installed = () => app.isPackaged || process.env.OPERATOR_AS_INSTALLED === '1';
const claudeReady = () => Boolean(process.env.ANTHROPIC_API_KEY) || !installed();

// Thrown before any Claude subprocess starts; errors.js says what to do.
function needClaudeKey(model) {
  if (agent.nim.isNimModel(model) || claudeReady()) return;
  throw new Error('no_anthropic_key');
}

const anthropicStatus = () => {
  const saved = store.anthropicStatus();
  return {
    configured: saved.configured || Boolean(ENV_ANTHROPIC_KEY),
    hint: saved.hint || (ENV_ANTHROPIC_KEY ? 'from the environment' : ''),
    // From source with no key: runs on this PC's own Claude login.
    devLogin: !installed() && !process.env.ANTHROPIC_API_KEY,
    ready: claudeReady(),
  };
};

ipcMain.handle('anthropic:status', async () => anthropicStatus());

// Whatever was pasted — a bare key, ANTHROPIC_API_KEY=…, quotes — find the key
// in it, and refuse text that cannot be one rather than overwrite a real key.
// An empty key clears it.
ipcMain.handle('anthropic:set', async (_e, raw) => {
  const text = String(raw || '').trim();
  if (text) {
    const key = (text.match(/sk-ant-[A-Za-z0-9_-]{20,}/) || [])[0];
    if (!key) return { ok: false, error: 'That is not an Anthropic API key — they start with sk-ant-.', status: anthropicStatus() };
    store.setAnthropic(key);
  } else {
    store.setAnthropic('');
  }
  applyAnthropicKey();
  // Warm sessions were started with the old environment.
  agent.closeSession();
  voice.close();
  return { ok: true, status: anthropicStatus() };
});

/* ── a model on this computer ────────────────────────────────────── */

ipcMain.handle('local:status', async (_e, force) => {
  await local.refresh({ force: Boolean(force) }).catch(() => {});
  return local.status();
});

// A server somewhere other than the usual ports. Empty clears it. Checked by
// looking, but kept either way: it may simply not be running yet.
ipcMain.handle('local:set', async (_e, raw) => {
  const text = String(raw || '').trim();
  const url = text ? local.cleanUrl(text) : '';
  if (text && !url) return { ok: false, error: 'That does not look like an address — something like http://127.0.0.1:11434.', status: local.status() };
  store.setLocal(url);
  local.setCustom(url);
  await local.refresh({ force: true }).catch(() => {});
  const st = local.status();
  const found = !url || st.servers.some((s) => s.base === url);
  return { ok: true, status: st, warning: found ? null : `Nothing answered at ${url} yet. It is saved, and will be used once it is running.` };
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

// A screen_do batch for the check at the end, part by part: "type "i love your
// content" → click (702, 567)", not "type → click". Masked the way the audit
// log masks it.
function screenParts(input) {
  const steps = (audit.scrub(input || {}, null, []).steps) || [];
  return steps.map((s) => {
    switch (s.action) {
      case 'type': return `type "${String(s.text || '').slice(0, 300)}"`;
      case 'key': return `press ${s.keys}`;
      case 'click_text': return `click "${s.name || s.text}"`;
      case 'focus': return `switch to "${s.title}"`;
      case 'scroll': return `scroll ${s.direction}`;
      case 'wait': return `wait ${s.seconds || 1}s`;
      default: return s.x !== undefined ? `${String(s.action).replace('_', '-')} at (${s.x}, ${s.y})` : String(s.action);
    }
  }).join(' → ') || '(nothing)';
}

// `employee`: an employee's run (employees.js) — its hands for message_boss and
// its to-do list. `noCheck`: skip the check at the end (a check-in has no goal
// it could judge).
async function runOne({ prompt, model, botId, chatId, silent, record, dryRun, employee, noCheck }) {
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
  running = { abortController, botId, chatId, token, employee: Boolean(employee) };
  send('agent-event', { type: 'status', text: 'running', botId, chatId, silent: Boolean(silent), dryRun: Boolean(dryRun), employee: Boolean(employee) });

  // Every run is recorded as it goes, so one that worked can be saved as a
  // playbook afterwards (playbooks.js). An employee has no hands to replay.
  if (!employee) playbooks.startRun(taskId, { prompt, botId, botName: bot && bot.name, model: model || (bot && bot.model) || agent.DEFAULT_MODEL, dryRun });

  // Whether the agent got far enough to touch anything. If it did not, a retry
  // is free; if it did, a retry would do the same work to the machine twice.
  let progressed = false;

  // What the check at the end gets to look at: everything the agent actually
  // did, the last thing it said about it, and which hands it used — so the
  // check only asks for evidence this run already paid for.
  const acts = [];
  const runStarted = Date.now();   // the check only trusts a frame of the user's screen taken since
  let tookTheScreen = false;
  let lastReply = null;
  let usedScreen = false;
  let usedBrowser = false;
  let leftForUser = false;   // a step handed to the user that they did not finish

  const onEvent = (evt) => {
    // A finished tool call. Recorded before the stop check below, and on
    // purpose: a tool already running when Stop was pressed still did its
    // work to the machine, and an action missing from the log because the
    // user cut the run short is the one you would most want to find.
    // Bookkeeping only — the transcript drew this step when it was asked for.
    if (evt.type === 'tool_done') {
      // Handing out helpers is listed where it STARTED (the `tool` event
      // below): it only finishes after every helper has, and listed there it
      // read to the check as "did the work, then handed it out".
      // A shell command goes in whole, with what it printed: its first line
      // alone read to the check as "made folders, moved nothing".
      if (evt.name === 'run_command') {
        acts.push({ text: `run: ${String((evt.input || {}).command || '').slice(0, 800)}${evt.output ? `\n   it printed: ${evt.output}` : ''}`, long: true, ok: evt.ok !== false, error: evt.error || null });
      } else if (evt.output) {
        acts.push({ text: `${evt.text || evt.name} → ${evt.output}`, long: true, ok: evt.ok !== false, error: evt.error || null });
      } else if (evt.name === 'screen_do') {
        // Each part of the batch with what it typed, pressed and clicked. "on
        // screen: click → wait → type → wait" told the check nothing, and it
        // failed a YouTube comment that had been posted.
        acts.push({ text: `on screen: ${screenParts(evt.input)}`, long: true, ok: evt.ok !== false, error: evt.error || null });
      } else if (evt.name !== 'run_helpers') acts.push({ text: evt.text || evt.name, ok: evt.ok !== false, error: evt.error || null });
      if (/^(screen_|launch_app|focus_window|list_windows)/.test(evt.name)) usedScreen = true;
      if (evt.name.startsWith('browser_')) usedBrowser = true;
      playbooks.recordStep(taskId, evt);
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
    // The agent has stepped onto (or off) the user's own screen. Worth seeing in
    // the transcript: it is the one thing that moves their real mouse.
    if (evt.type === 'desktop') {
      if (evt.mine) tookTheScreen = true;
      send('agent-event', { ...evt, botId, chatId });
      return;
    }
    // The user's turn: make sure they notice, and remember a step they did not
    // finish — sending the agent back to redo the work cannot fix that one.
    if (evt.type === 'handover') tellUserItIsTheirTurn(evt);
    // What was asked of the user and what they answered, for the check at the
    // end: it sees only this list, and without it an answer the user gave
    // looked like a step the agent had skipped — and the user was asked again.
    if (evt.type === 'handover_end' && evt.what) {
      const who = evt.helperName ? `[${evt.helperName}] ` : '';
      const did = evt.answer ? `the user answered "${String(evt.answer).slice(0, 200)}"`
        : evt.outcome === 'skipped' ? 'the user skipped it'
        : evt.outcome === 'timeout' ? 'the user did not do it in time'
        : evt.outcome === 'stopped' ? 'stopped'
        : 'the user did it';
      acts.push({ text: `${who}asked the user: ${String(evt.what).slice(0, 200)} — ${did}`, ok: handover.carriedOn(evt.outcome) });
    }
    if (evt.type === 'handover_end' && (evt.outcome === 'timeout' || evt.outcome === 'skipped')) leftForUser = true;
    if (evt.type === 'helper_done' && evt.state === 'needs') leftForUser = true;
    if (evt.type === 'tool' && evt.name === 'run_helpers') {
      const names = ((evt.input && evt.input.tasks) || []).map((t) => t.name);
      acts.push({ text: `handed ${names.length} jobs to helpers working at the same time, each in its own browser tab: ${names.join(', ')} — their steps follow, marked with their names`, ok: true });
    }
    // What each helper said it did, for the check at the end — the steps alone
    // do not say whether a helper got to the end of its job.
    if (evt.type === 'helper_done') {
      acts.push({ text: `[${evt.helperName}] ${evt.state === 'needs' ? 'stopped for the user' : evt.state}: ${String(evt.report || '').slice(0, 300)}`, ok: evt.state !== 'failed' });
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

  const emailApi = connectedEmail();

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
  const go = (resume, again) => {
    needClaudeKey(model || (bot && bot.model) || agent.DEFAULT_MODEL);
    return agent.runTask(again || prompt, {
      userDataDir: profileDir(),
      abortController,
      model: model || (bot && bot.model) || undefined,
      // Effort, thinking and the rest, as set on the dial for this side.
      modelOptions: store.getModelOptions('agents'),
      resume,
      bot,
      // Part of the session key: a session IS the conversation, so a different
      // chat must not be handed the one that is already open.
      chatId,
      teammates,
      messageBot,
      codeChats,
      email: emailApi,
      schedule: botId ? scheduleFor(botId) : null,
      employee: employee || null,
      alwaysSkills,
      activeSkill: again ? null : activeSkill,
      skillIndex,
      dryRun,
      onEvent,
    });
  };

  // The run does not get to mark its own homework. Once it thinks it is
  // finished, a second cheap model (verify.js) looks at the goal, what was
  // actually done and the screen as it is now, and says whether the goal was
  // met. On "no" the critique goes straight back into the same session as a
  // follow-up turn — bounded, so a stubborn task cannot loop the machine.
  const VERIFY_RETRIES = 1;

  // Returns the last verdict, or null when nothing was checked.
  async function checkTheWork() {
    if (noCheck) return null;
    // A run that did nothing has nothing to check — which is also how ordinary
    // conversation avoids paying for this at all.
    if (store.getPrefs().verify === false) return null;
    if (!acts.length || abortController.signal.aborted) return null;

    for (let tries = 0; ; tries++) {
      onEvent({ type: 'verify_start' });
      const v = await verify.check({
        goal: prompt, actions: acts, reply: lastReply, model,
        dryRun, usedScreen, usedBrowser, onTheirScreen: tookTheScreen, since: runStarted, abortController,
      });
      if (abortController.signal.aborted) return null;

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
      if (v.ok !== false) return v;
      if (tries >= VERIFY_RETRIES) return v;    // out of retries; the verdict stands
      // What is missing is the user's part (a step they skipped or did not
      // finish, or the agent saying it needs them). Redoing the agent's part
      // cannot finish theirs — the run waits for them instead (below).
      if (leftForUser || needsYou(lastReply)) return v;

      // Same conversation, not a new one: the agent has to see its own work to
      // fix it. Read the session back rather than reusing the one this task
      // started with — the run may have been handed a fresh one along the way.
      await go(botId && chatId ? store.sessionOf(botId, chatId) : null, verify.critique(v.why));
      if (abortController.signal.aborted) return null;
    }
  }

  // The run does not end with the goal unmet. Whatever is left — the agent's
  // "NEEDS YOU:", or else what the check says is missing — is put to the user
  // as their turn, and their answer goes back into this same conversation.
  // Round after round until the goal is met, they skip, stop, or 30 minutes
  // pass with no answer. Not for rehearsals, and not for routines running with
  // nobody there.
  const USER_ROUNDS = 8;
  const needsYou = (s) => /\bNEEDS YOU\b/i.test(String(s || ''));
  function needsOf(reply, verdict) {
    const m = String(reply || '').match(/\bNEEDS YOU\b[\s:—–-]*([\s\S]+)$/i);
    if (m && m[1].trim()) return m[1].trim().slice(0, 700);
    if (verdict && verdict.why) return `It is not finished yet: ${verdict.why} Tell it what to do next, or do that step yourself and press "I've done it".`;
    return 'Tell Operator how to carry on.';
  }
  async function waitForTheUser(what) {
    const h = handover.open(null);
    onEvent({ type: 'handover', id: h.id, what, reply: true });
    const r = await handover.watch({ h, minutes: 30, signal: abortController.signal });
    onEvent({ type: 'handover_end', id: h.id, outcome: r.outcome, what, answer: r.text });
    return r;
  }

  // Whether the run ended well enough to offer saving it as a playbook.
  let finalVerdict = null;
  let failed = false;
  let machine = null;   // the computer this agent is set to work on, for this run

  try {
    machine = await onMachine(bot && bot.machine);
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
    let verdict = await checkTheWork();

    for (let round = 0; round < USER_ROUNDS && !silent && !dryRun; round++) {
      if (abortController.signal.aborted) break;
      // They skipped a step, or let one time out: that means move on, so it
      // is not put straight back to them.
      if (leftForUser) break;
      // The agent saying it needs them always waits — it asked for something,
      // whatever the check thinks. Otherwise, a check that says it is not met.
      const unmet = needsYou(lastReply) || Boolean(verdict && verdict.ok === false);
      if (!unmet) break;
      const r = await waitForTheUser(needsOf(lastReply, verdict));
      if (!handover.carriedOn(r.outcome)) break;
      leftForUser = false;
      await go(botId && chatId ? store.sessionOf(botId, chatId) : null,
        `${handover.answerFor(r)}. Carry on towards the goal from where you stopped, until it is met. ` +
        'If you need something else only they can do or tell you, call wait_for_user, or end with NEEDS YOU: and what you need.');
      verdict = await checkTheWork();
    }
    finalVerdict = verdict;
  } catch (err) {
    failed = true;
    // Raw SDK and Node failures mean nothing to someone who has just installed
    // this. errors.js turns the common ones into a sentence plus the fix, and
    // keeps the original so a bug report still has it.
    const e = err.friendly ? { ...err.friendly, detail: err.message } : errors.explain(err);
    if (!e.stopped) onEvent({ type: 'error', title: e.title, fix: e.fix, text: e.detail || e.title });
  } finally {
    if (machine) machine.restore();
    // A job that worked, and did something a playbook can repeat, is offered
    // as one: next time it runs with no model at all. Only to someone watching.
    const worked = !failed && !abortController.signal.aborted && !(finalVerdict && finalVerdict.ok === false);
    const kept = employee ? null : playbooks.endRun(taskId, { ok: worked });
    if (kept && worked && !kept.usedHelpers && !dryRun && !silent && kept.steps >= 2) {
      // A job that only looked things up needs the AI every time — the
      // reading and the answer were the work — so it is offered as something
      // the agent does again on a schedule, not as a playbook.
      if (kept.lookOnly) onEvent({ type: 'routine_offer', prompt: kept.prompt });
      else onEvent({ type: 'playbook_offer', taskId, steps: kept.steps });
    }
    // Hand the screen back. A follow-up that needs it again can simply ask for
    // it; leaving the agent holding the user's mouse after the job is done is
    // the thing the private desktop exists to prevent.
    if (tookTheScreen && ownDesktopPref && desktop.target().kind !== 'remote') {
      try { desktop.usePrivateDesktop(true); } catch (_) {}
      onEvent({ type: 'desktop', mine: false, auto: true });
    }
    overlay.hide();          // the agent has stopped pointing at things
    // If Stop already cleared this — or a newer task has started since — leave
    // it alone. Saying "idle" over the top of a live run would blank the UI.
    if (running && running.token === token) {
      running = null;
      send('agent-event', { type: 'status', text: 'idle', botId, chatId, employee: Boolean(employee) });
    }
  }
  return { ok: true };
}

// Email connector: hand the agent a facade bound to the stored account, if one
// is connected. Credentials stay here — the agent only ever calls these. For a
// Google (OAuth) account we refresh the access token on demand, since a task
// can outlast the token's hour, and pass the fresh one into email.js.
function connectedEmail() {
  const emailConnected = store.getConnector('email');
  // An expired sign-in is not handed over: the agent would be told it can read
  // codes and then fail at every one.
  return emailConnected && emailConnected.connected && !emailConnected.expired ? {
    // Which inbox this is, so the agent signs up with it — codes sent to any
    // other address are ones it can never fetch.
    address: emailConnected.email || null,
    list: async (o) => email.list({ cfg: await freshEmailCfg(), ...o }),
    read: async (o) => email.read({ cfg: await freshEmailCfg(), ...o }),
    send: async (o) => email.send({ cfg: await freshEmailCfg(), ...o }),
    mailboxes: async () => email.mailboxes({ cfg: await freshEmailCfg() }),
  } : null;
}

// Your own work comes first: an employee's check-in or reply stops for it and
// is picked up again later (employees.js).
function yieldEmployee() {
  if (!running || !running.employee) return;
  const { abortController, botId, chatId } = running;
  employees.markCutShort(botId);
  running = null;
  abortController.abort();
  overlay.hide();
  send('agent-event', { type: 'status', text: 'idle', botId, chatId, employee: true });
}

ipcMain.handle('run-task', async (_e, prompt, model, botId, chatId, dryRun) => {
  yieldEmployee();
  return runOne({ prompt, model, botId, chatId, dryRun });
});

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
// What the user chose in Settings. The agent can step onto their screen for a
// job that is explicitly about their own windows, but this is what it goes back
// to afterwards — the choice is theirs, not the agent's to keep.
let ownDesktopPref = true;

ipcMain.handle('input:ownDesktop', async (_e, on) => {
  if (running) return { ok: false, error: 'Finish or stop the current task first.' };
  try {
    ownDesktopPref = Boolean(on);
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
    // Remembered in the list of computers, so next time it is one click.
    store.saveMachine({ url, token, host: remoteHost });
    send('machines-changed', {});
    return { ok: true, host: remoteHost };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:disconnect', async () => {
  desktop.useRemote(null);
  remoteHost = null;
  send('machines-changed', {});
  return { ok: true };
});

/* ── computers: a fleet of machines to work on ───────────────────── */

// Each saved machine is asked "are you there?" every half minute, so the list
// can say which are up — and a run on one that is not fails with a sentence,
// not a stack trace, before anything has been done.
const machineHealth = new Map();   // id → { online, lastSeen, host, error }

async function checkMachines() {
  let changed = false;
  await Promise.all(store.listMachines().map(async ({ id }) => {
    const m = store.getMachine(id);
    if (!m) return;
    const prev = machineHealth.get(id) || {};
    let next;
    try {
      const pong = await desktop.ping({ url: m.url, token: m.token });
      next = { online: true, lastSeen: Date.now(), host: (pong && pong.host) || prev.host || m.host || null, error: null };
    } catch (err) {
      next = { online: false, lastSeen: prev.lastSeen || null, host: prev.host || m.host || null, error: err.message };
    }
    if (prev.online !== next.online || prev.error !== next.error) changed = true;
    machineHealth.set(id, next);
  }));
  if (changed) send('machines-changed', {});
}
setInterval(() => { checkMachines().catch(() => {}); }, 30000);

function machineView(m) {
  const h = machineHealth.get(m.id) || {};
  const t = desktop.target();
  return {
    ...m, host: h.host || m.host, online: h.online === undefined ? null : h.online, lastSeen: h.lastSeen || null, error: h.error || null,
    inUse: t.kind === 'remote' && t.url === m.url,
    busy: Boolean(running && running.machine === m.id),
  };
}

// What the node prints, pasted whole, is enough: the address and the token
// are taken out of it.
function machineFrom(spec = {}) {
  const text = [spec.url, spec.token, spec.paste].filter(Boolean).join('\n');
  const url = (String(spec.url || '').match(/https?:\/\/[^\s"'`]+/) || text.match(/https?:\/\/[^\s"'`]+/) || [])[0]
    || (spec.url ? 'http://' + String(spec.url).trim() : '');
  const token = (spec.token && String(spec.token).trim()) || (text.match(/token\s*[:=]?\s+([A-Za-z0-9._~+/=-]{4,})/i) || [])[1] || '';
  return { url: url.replace(/\/+$/, ''), token };
}

ipcMain.handle('machines:list', () => ({ machines: store.listMachines().map(machineView), target: desktop.target() }));

ipcMain.handle('machines:add', async (_e, spec) => {
  const { url, token } = machineFrom(spec || {});
  if (!url) return { ok: false, error: 'Give its address — the node prints it, like http://192.168.1.50:8391.' };
  try {
    const pong = await desktop.ping({ url, token });
    const m = store.saveMachine({ name: spec && spec.name, url, token, host: pong && pong.host });
    machineHealth.set(m.id, { online: true, lastSeen: Date.now(), host: (pong && pong.host) || null, error: null });
    send('machines-changed', {});
    return { ok: true, machine: machineView(m) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('machines:rename', (_e, id, name) => { const m = store.renameMachine(id, name); send('machines-changed', {}); return m; });

ipcMain.handle('machines:remove', (_e, id) => {
  const m = store.getMachine(id);
  if (m && desktop.target().url === m.url) { desktop.useRemote(null); remoteHost = null; }
  machineHealth.delete(id);
  const r = store.removeMachine(id);
  send('machines-changed', {});
  send('bots-changed', {});
  return r;
});

// Point Operator at one of them from now on (null: this computer) — the same
// as connecting in the form above, without typing it all again.
ipcMain.handle('machines:use', async (_e, id) => {
  if (running) return { ok: false, error: 'Finish or stop what is running first.' };
  if (!id) { desktop.useRemote(null); remoteHost = null; send('machines-changed', {}); return { ok: true }; }
  const m = store.getMachine(id);
  if (!m) return { ok: false, error: 'That computer has been removed.' };
  try {
    const pong = await desktop.ping({ url: m.url, token: m.token });
    desktop.useRemote({ url: m.url, token: m.token });
    remoteHost = (pong && pong.host) || m.host || null;
    overlay.hide();
    send('machines-changed', {});
    return { ok: true, host: remoteHost, name: m.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// A run on a particular machine: its tools point there for the run, then back
// to whatever Settings says. One run at a time, so swapping the target for the
// length of one is safe. Returns null when there is nothing to swap.
async function onMachine(machineId) {
  if (!machineId) return null;
  const m = store.getMachine(machineId);
  const fail = (title, fix) => Object.assign(new Error(title), { friendly: { title, fix } });
  if (!m) throw fail('The computer this was set to run on has been removed', 'Choose another one for it, or "This computer".');
  try {
    await desktop.ping({ url: m.url, token: m.token });
  } catch (err) {
    const h = machineHealth.get(m.id) || {};
    machineHealth.set(m.id, { ...h, online: false, error: err.message });
    send('machines-changed', {});
    throw fail(`${m.name} is not answering, so nothing was done on it`,
      `${err.message}${h.lastSeen ? ` It was last seen ${new Date(h.lastSeen).toLocaleString()}.` : ''}`);
  }
  const prev = desktop.currentRemote();
  desktop.useRemote({ url: m.url, token: m.token });
  if (running) running.machine = m.id;
  return { name: m.name, restore: () => desktop.useRemote(prev) };
}

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
  if (id) store.saveCodeChat(id, { cwd, cwdName: name, project: null, title: store.getCodeChat(id).title === 'New chat' ? name : undefined });
  return { ok: true, cwd, name };
});

// Attach one of the user's bots to a code chat, so the coding assistant works
// with that bot's persona and memory.
ipcMain.handle('codeChats:setBot', async (_e, id, botId) => store.saveCodeChat(id, { botId: botId || null }));

// One place that actually runs a coding turn, so both the UI and a bot asking
// via message_code_chat drive the same machinery and land in the same history.
// A sidebar title from the first message: its first line, without the
// markdown, and not shouting — a prompt pasted in capitals should not sit in
// the sidebar in capitals.
function chatTitle(prompt) {
  let t = String(prompt || '').split('\n').map((l) => l.trim()).find(Boolean) || 'New chat';
  t = t.replace(/^[#>*\-+\s]+/, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 6 && letters === letters.toUpperCase()) t = t.charAt(0) + t.slice(1).toLowerCase();
  if (t.length > 60) t = t.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  return t || 'New chat';
}

// The usual places, by the names people use for them.
function codePlaces() {
  const get = (k) => { try { return app.getPath(k); } catch (_) { return null; } };
  return {
    'Home folder': get('home'),
    Desktop: get('desktop'),
    Documents: get('documents'),
    Downloads: get('downloads'),
    'Projects workspace (the default working folder)': path.join(get('home') || '', 'Operator Projects'),
  };
}

// Which folder a turn actually built in, from the files it wrote. A build in
// the projects workspace lands in its own sub-folder, and that sub-folder is
// the project; a build somewhere else entirely is wherever its files share.
function projectFrom(cwd, written) {
  if (!written.length) return null;
  const split = (p) => path.resolve(p).split(path.sep);
  let common = split(path.dirname(written[0]));
  for (const f of written.slice(1)) {
    const parts = split(path.dirname(f));
    let i = 0;
    while (i < common.length && i < parts.length && common[i].toLowerCase() === parts[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  const dir = common.join(path.sep);
  if (!dir) return null;
  const rel = path.relative(path.resolve(cwd), dir);
  if (!rel) return null;                                   // right in the working folder
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(cwd, rel.split(path.sep)[0]);
  // Outside it: fine, unless "the project" would be the whole desktop or home.
  const broad = Object.values(codePlaces()).filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  return broad.includes(path.resolve(dir).toLowerCase()) ? null : dir;
}

async function runCodeTask(chatId, prompt, refs = []) {
  // Only this chat has to be free. Another chat working away is none of its
  // business.
  if (codeRuns.has(chatId)) return { ok: false, error: 'This chat is already working on something.' };
  let chat = store.getCodeChat(chatId);
  if (!chat) return { ok: false, error: 'No such code chat.' };
  // Nobody has to pick a folder first. A chat without one works in the
  // projects workspace, the way a fresh Claude Code session works where it is.
  if (!chat.cwd) {
    const d = defaultCwd();
    store.saveCodeChat(chatId, { cwd: d.cwd, cwdName: d.name });
    chat = store.getCodeChat(chatId);
  }

  // Whatever was dragged into the message: listed for the model, and opened up
  // to its file tools. Only things that still exist make it through.
  refs = (Array.isArray(refs) ? refs : [])
    .filter((r) => r && typeof r.path === 'string' && fs.existsSync(r.path))
    .map((r) => ({ path: r.path, dir: Boolean(r.dir), name: path.basename(r.path) }))
    .slice(0, 20);
  const reach = [...new Set([
    app.getPath('home'),
    ...refs.map((r) => (r.dir ? r.path : path.dirname(r.path))),
    chat.project,
  ].filter(Boolean))];
  const modelPrompt = refs.length
    ? prompt + '\n\nReferenced (the user dragged these into the message):\n' +
      refs.map((r) => '- ' + r.path + (r.dir ? ' (folder)' : '')).join('\n')
    : prompt;

  const abortController = new AbortController();
  const run = { abortController };
  const codeTaskId = crypto.randomUUID();
  codeRuns.set(chatId, run);
  send('code-event', { type: 'status', text: 'running', chatId });

  // Record the conversation as it happens so the sidebar history is real.
  const turns = chat.turns || [];
  turns.push(refs.length ? { k: 'you', text: prompt, refs } : { k: 'you', text: prompt });
  const written = [];
  let steps = null;
  const title = chat.title === 'New chat' ? chatTitle(prompt) : chat.title;
  store.saveCodeChat(chatId, { turns, title });

  let reply = '';
  try {
    needClaudeKey(chat.model || agent.DEFAULT_MODEL);
    await code.runCode(modelPrompt, {
      cwd: chat.cwd,
      reach,
      places: codePlaces(),
      // Named, never left to the SDK: the picker has to show what actually runs.
      // Unset used to mean "Claude Code's default" (Sonnet 5 here) while the
      // picker showed the top of its list instead.
      model: chat.model || agent.DEFAULT_MODEL,
      saved: store.getModelOptions('code')[chat.model || agent.DEFAULT_MODEL],
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
          if ((evt.name === 'Write' || evt.name === 'Edit') && evt.input && evt.input.abs) written.push(evt.input.abs);
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
    // The chat follows what it built: the editor opens on that folder, and
    // the sidebar names it.
    const project = projectFrom(chat.cwd, written);
    if (project && project !== chat.project) {
      store.saveCodeChat(chatId, { project });
      send('code-event', { type: 'project', path: project, chatId });
    }
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

ipcMain.handle('code:run', async (_e, chatId, prompt, refs) => runCodeTask(chatId, prompt, refs));

// Point a chat at a folder without a dialog — from the editor's tree, or a
// folder dropped on the chat.
ipcMain.handle('code:setFolder', async (_e, id, dir) => {
  try { if (!fs.statSync(dir).isDirectory()) return { ok: false }; } catch (_) { return { ok: false }; }
  const c = store.getCodeChat(id);
  if (!c) return { ok: false };
  const name = path.basename(dir);
  store.saveCodeChat(id, { cwd: dir, cwdName: name, project: null, title: c.title === 'New chat' ? name : undefined });
  return { ok: true, cwd: dir, name };
});

// The editor panel's view of the disk — see files.js.
files.register(ipcMain, { getWin: () => win, send });

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
  let t;
  try {
    t = await googleOAuth.refresh({
      clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken: cfg.refreshToken,
    });
  } catch (err) {
    // Google ends the sign-in — after 7 days while the Google Cloud app is in
    // "Testing", or when it is revoked. Say so where the user will look, not
    // just "connected" over a mailbox nobody can open.
    if ((err && err.code === 'invalid_grant') || /expired|revoked|invalid_grant/i.test(String(err && err.message))) {
      store.markConnector('email', { expired: true });
      throw new Error('The Gmail sign-in has expired, so Operator cannot read that inbox. Sign in again in Settings → Connectors (an app password there never expires).');
    }
    throw err;
  }
  store.setConnector('email', { ...cfg, accessToken: t.accessToken, expiry: t.expiry, expired: false });
  return store.getConnector('email');
}

// Find out now, not in the middle of a task, whether the email sign-in still
// works — so Settings says "expired" instead of "connected".
function checkEmailSoon() {
  setTimeout(() => {
    const cfg = store.getConnector('email');
    if (cfg && cfg.connected && cfg.auth === 'oauth') freshEmailCfg().catch(() => {});
  }, 5000);
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
ipcMain.handle('bots:restore', async (_e, snap, index) => store.restoreBot(snap, index));
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

/* ── the tray, and starting with Windows ─────────────────────────── */

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The first time closing only hides it, say where it went — once.
function hintTray() {
  if (store.getPrefs().trayHinted) return;
  store.setPrefs({ trayHinted: true });
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'Operator is still running', body: 'It is in the tray by the clock, so reminders and employees keep going. Right-click the icon to quit.' });
    n.on('click', showWindow);
    n.show();
  } catch (_) { /* the hint is a nicety */ }
}

// Start with Windows: the same entry Windows' own Startup apps list shows,
// opening hidden in the tray. A dev run registers electron.exe with this
// folder, so the entry still starts this code.
const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });
function startsWithWindows() {
  try { return app.getLoginItemSettings(loginItem()).openAtLogin; } catch { return false; }
}
const backgroundState = () => ({ tray: Boolean(store.getPrefs().tray), boot: startsWithWindows() });
function setStartWithWindows(on) {
  try { app.setLoginItemSettings({ ...loginItem(), openAtLogin: Boolean(on) }); } catch (_) { /* left as it was */ }
  syncTray();
  send('background-changed', backgroundState());
}

function syncTray() {
  if (!store.getPrefs().tray) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    try { tray = new Tray(path.join(__dirname, 'build', 'icon.ico')); } catch (_) { tray = null; return; }
    tray.setToolTip('Operator');
    tray.on('click', showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Operator', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (item) => setStartWithWindows(item.checked) },
    { type: 'separator' },
    { label: 'Quit Operator', click: () => { quitting = true; app.quit(); } },
  ]));
}

ipcMain.handle('background:get', () => backgroundState());
ipcMain.handle('background:set', (_e, patch = {}) => {
  if ('tray' in patch) { store.setPrefs({ tray: Boolean(patch.tray) }); syncTray(); }
  if ('boot' in patch) setStartWithWindows(patch.boot);
  return backgroundState();
});

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
  if (r.every === 'once') return !r.lastRun && now >= (r.when || 0);
  // Never run yet: count from when it was made (see store.addRoutine).
  const last = Math.max(r.lastRun || 0, r.createdAt || 0);

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

// A reminder is only words at a time: a notification and no agent run, so it
// never waits for the desk to be free or spends a model turn on one line.
function remindNow(botId, routine) {
  if (routine.every === 'once') store.removeRoutine(botId, routine.id);
  else store.updateRoutine(botId, routine.id, { lastRun: Date.now() });
  send('agent-event', { type: 'reminder', text: routine.prompt, botId });
  send('bots-changed', { botId });
  if (process.env.OPERATOR_NO_NOTIFY === '1') return;   // automated tests
  try { if (win && !win.isDestroyed()) win.flashFrame(true); } catch (_) {}
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'Reminder', body: String(routine.prompt).slice(0, 200) });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch (_) { /* nothing else to do with a reminder that cannot show */ }
}

// The agent's hands on the scheduler: the reminders and routines of the bot it
// is running as, the same list that bot's panel shows.
function scheduleFor(botId) {
  return {
    add: (spec) => {
      const r = store.addRoutine(botId, spec);
      if (r) { send('bots-changed', { botId }); tick().catch(() => {}); }
      return r;
    },
    list: () => ((store.getBot(botId) || {}).routines || []),
    remove: (routineId) => {
      const had = ((store.getBot(botId) || {}).routines || []).some((r) => r.id === routineId);
      store.removeRoutine(botId, routineId);
      if (had) send('bots-changed', { botId });
      return had;
    },
  };
}

async function fireRoutine(botId, routine) {
  if (routine.kind === 'remind') { remindNow(botId, routine); return; }
  store.updateRoutine(botId, routine.id, { lastRun: Date.now() });
  const chat = store.createChat(botId);
  store.saveChat(botId, chat.id, { title: routine.name });

  send('agent-event', { type: 'routine', name: routine.name, botId, chatId: chat.id });
  // What it found is the point of most routines ("the AI news every
  // morning"), so the answer comes to you, not just into a chat you would
  // have to go looking for.
  const record = makeRecorder(botId, chat.id, routine.prompt);
  let answer = '';
  let failedWith = null;
  await runOne({
    prompt: routine.prompt,
    botId,
    chatId: chat.id,
    silent: true,
    record: (evt) => {
      if ((evt.type === 'say_end' || evt.type === 'assistant' || evt.type === 'done') && String(evt.text || '').trim()) answer = evt.text;
      if (evt.type === 'error') failedWith = evt.text;
      record(evt);
    },
  });
  if (routine.every === 'once') store.removeRoutine(botId, routine.id);
  send('bots-changed', { botId });
  const bot = store.getBot(botId);
  notifyRoutine(failedWith ? `${routine.name} — it stopped` : `${(bot && bot.name) || 'Operator'}: ${routine.name}`,
    failedWith || plainText(answer) || 'Done.', botId, chat.id);
}

// A notification for a finished routine; clicking it opens the conversation.
function notifyRoutine(title, text, botId, chatId) {
  if (process.env.OPERATOR_NO_NOTIFY === '1') return;   // automated tests
  try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch (_) {}
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title).slice(0, 80), body: String(text).slice(0, 220) });
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      win.show(); win.focus();
      send('routine-open', { botId, chatId });
    });
    n.show();
  } catch (_) { /* a missing notification is not worth failing anything over */ }
}

// Markdown read out as a notification is noise: keep the words.
const plainText = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

// One physical desktop, one mouse: routines queue behind whatever is running
// rather than fighting it for the screen. Reminders touch neither, so they
// go off on time whatever is running.
async function tick() {
  const now = Date.now();
  for (const { botId, routine } of store.allRoutines()) {
    if (routine.kind === 'remind' && dueNow(routine, now)) remindNow(botId, routine);
  }
  if (running) return;

  for (const { botId, routine } of store.allRoutines()) {
    if (routine.kind === 'remind' || !dueNow(routine, now)) continue;
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

/* ── playbooks: a job that worked, replayed with no model ────────── */

// A playbook run holds the computer the way a task does — one mouse, one at a
// time — but nothing in it asks a model anything unless a step stops landing.
// Its steps go through the agent's own tools (agent.hands), so they are timed,
// audited and rehearsed exactly like the agent's.
async function runPlaybook(id, { inputs = {}, trigger = {}, dryRun = false, silent = false } = {}) {
  const pb = playbooks.raw(id);
  if (!pb) return { ok: false, error: 'That playbook has been deleted.' };
  if (running) return { ok: false, busy: true, error: 'Something is already running.' };

  const abortController = new AbortController();
  const token = {};
  const runId = crypto.randomUUID();
  running = { abortController, botId: null, chatId: null, token, playbook: id };
  const say = (e) => send('playbook-event', { ...e, playbookId: id, runId });
  say({ type: 'status', text: 'running', dryRun: Boolean(dryRun) });

  let tookTheScreen = false;
  const onEvent = (evt) => {
    if (evt.type === 'tool_done') {
      audit.write({
        botId: null, botName: `Playbook · ${pb.name}`, chatId: null, taskId: runId, mode: 'playbook',
        tool: evt.name, text: evt.text, args: evt.input, ok: evt.ok !== false, error: evt.error || null,
        ms: evt.ms, computer: computerLabel(), model: null, dryRun: Boolean(evt.dryRun),
      });
      return;
    }
    if (abortController.signal.aborted) return;
    if (evt.type === 'desktop') { if (evt.mine) tookTheScreen = true; return; }
    if (evt.type === 'handover') tellUserItIsTheirTurn(evt);
    if (evt.type === 'handover' || evt.type === 'handover_end') say(evt);
  };

  const email = connectedEmail();
  let result;
  let machine = null;   // the computer this playbook is set to run on
  try {
    machine = await onMachine(pb.machine);
    // Built after the switch: on another computer there is no browser here
    // to hand it, and a browser step says so plainly.
    const hands = await agent.hands({ userDataDir: profileDir(), email, dryRun, onEvent, abortController });
    result = await playbooks.run(id, {
      hands, inputs, trigger, dryRun,
      signal: abortController.signal,
      emit: (e) => { if (!abortController.signal.aborted || e.type === 'pb_end') say(e); },
      // Where things are now, for a step's checkpoint. The browser is never
      // started just to be looked at.
      probe: async (check) => {
        if (check.url) { const p = browser.getPage(); return p && !p.isClosed() ? { url: p.url() } : null; }
        return { window: (await desktop.listWindows()).foreground };
      },
      // The user's turn: a password it does not keep, or a step that asks first.
      ask: async ({ what, kind, browser: inBrowser }) => {
        const page = inBrowser ? await browser.ensureBrowser(profileDir()).then(() => browser.getPage()).catch(() => null) : null;
        const h = handover.open(page);
        onEvent({ type: 'handover', id: h.id, what, kind });
        if (page) page.bringToFront().catch(() => {});
        const r = await handover.watch({ h, getPage: page ? async () => browser.getPage() : null, minutes: 30, signal: abortController.signal });
        onEvent({ type: 'handover_end', id: h.id, outcome: r.outcome, what });
        return handover.carriedOn(r.outcome) ? 'yes' : r.outcome === 'skipped' ? 'skip' : 'none';
      },
      heal: (job) => healStep(pb, job, { email, abortController, onEvent, say }),
    });
  } catch (err) {
    const e = err.friendly || errors.explain(err);
    result = { ok: false, error: e.fix ? `${e.title} — ${e.fix}` : e.title };
    say({ type: 'pb_end', ok: false, error: result.error });
  } finally {
    if (machine) machine.restore();
    // Hand the screen back, as a task does.
    if (tookTheScreen && ownDesktopPref && desktop.target().kind !== 'remote') {
      try { desktop.usePrivateDesktop(true); } catch (_) {}
    }
    overlay.hide();
    if (running && running.token === token) running = null;
    say({ type: 'status', text: 'idle' });
    send('playbooks-changed', { id });
  }

  audit.write({
    botId: null, botName: `Playbook · ${pb.name}`, chatId: null, taskId: runId, mode: 'playbook', tool: 'playbook',
    text: result.ok
      ? `Ran "${pb.name}" — it worked${result.healed ? `, after repairing ${result.healed} step${result.healed === 1 ? '' : 's'}` : ''}`
      : `Ran "${pb.name}" — it stopped: ${result.error}`,
    args: { playbook: id, trigger, inputs }, ok: Boolean(result.ok), error: result.ok ? null : result.error || null,
    ms: result.ms || null, computer: computerLabel(), model: null, dryRun: Boolean(dryRun),
  });
  // Nobody watching: say so where they will see it.
  if (!result.ok && silent && !result.stopped) notifyPlaybook(`Playbook stopped: ${pb.name}`, result.error || 'It did not finish.', id);
  return result;
}

function notifyPlaybook(title, text, id) {
  if (process.env.OPERATOR_NO_NOTIFY === '1') return;   // automated tests
  try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch (_) {}
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: String(text).slice(0, 200) });
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      win.show(); win.focus();
      send('playbook-open', { id });
    });
    n.show();
  } catch (_) { /* a missing notification is not worth failing anything over */ }
}

// One step that no longer lands, handed to a model on its own. It sees the
// job, what has already run, the step and why it failed — and what it does to
// get past it becomes that step (playbooks.js).
async function healStep(pb, { step, index, steps, reason }, { email, abortController, onEvent, say }) {
  const model = pb.model || agent.DEFAULT_MODEL;
  try { needClaudeKey(model); } catch {
    return { ok: false, error: 'repairing a step needs a model, and Claude has no API key here — add one in Settings → Models, or choose another model for this playbook' };
  }
  const healId = 'heal-' + crypto.randomUUID();
  playbooks.startRun(healId, { prompt: pb.goal });
  const done = steps.slice(0, index).map((s, i) => `${i + 1}. ${s.text}`).join('\n') || '(nothing yet — this is the first step)';
  const want = !step.check ? ''
    : step.check.url ? `\nWhen it has worked, the browser is on ${step.check.url}.`
    : `\nWhen it has worked, the window in front is "${step.check.window}".`;
  const prompt = `You are repairing ONE step of a saved playbook — a recorded job that normally replays with no model at all. The steps before this one have already run.

The whole job: ${pb.goal}

Already done this run:
${done}

The step that did not work: ${step.text}
(It was ${step.tool} with ${JSON.stringify(step.args).slice(0, 600)}.)
Why: ${reason}${want}

Look at the screen first. Then do ONLY what that one step was meant to achieve, in the fewest actions — not the steps after it, and not the ones before. When it is done, reply DONE in one line. If it cannot be done, reply CANNOT and one line saying why.`;

  let reply = '';
  try {
    await agent.runTask(prompt, {
      userDataDir: profileDir(), abortController, model,
      modelOptions: store.getModelOptions('agents'),
      chatId: healId, email, dryRun: false,
      onEvent: (evt) => {
        if (evt.type === 'tool_done') { playbooks.recordStep(healId, evt); onEvent(evt); return; }
        if (evt.type === 'tool') say({ type: 'pb_heal_step', i: index, name: evt.name });
        if ((evt.type === 'say_end' || evt.type === 'assistant' || evt.type === 'done') && evt.text) reply = evt.text;
        if (evt.type === 'handover' || evt.type === 'handover_end' || evt.type === 'desktop') onEvent(evt);
      },
    });
  } catch (err) {
    playbooks.takeRun(healId);
    return { ok: false, error: errors.explain(err).title };
  }
  const fixed = playbooks.takeRun(healId);
  if (/\bCANNOT\b|\bNEEDS YOU\b/.test(reply)) {
    return { ok: false, error: reply.replace(/^[\s\S]*?\b(CANNOT|NEEDS YOU)\b[\s:—–-]*/, '').trim().slice(0, 300) || 'the model could not do it' };
  }
  return { ok: true, steps: fixed, reply };
}

ipcMain.handle('playbooks:list', () => playbooks.list());
ipcMain.handle('playbooks:get', (_e, id) => playbooks.get(id));
ipcMain.handle('playbooks:recent', () => playbooks.listRecent());
ipcMain.handle('playbooks:fromTask', (_e, taskId) => {
  const r = playbooks.fromTask(taskId);
  if (r.ok) send('playbooks-changed', { id: r.playbook.id });
  return r;
});
ipcMain.handle('playbooks:update', (_e, id, patch) => playbooks.update(id, patch || {}));
ipcMain.handle('playbooks:makeInput', (_e, id, value, name) => playbooks.makeInput(id, value, name));
ipcMain.handle('playbooks:delete', (_e, id) => { const r = playbooks.remove(id); watchers.forgetPlaybook(id); send('playbooks-changed', {}); return r; });

// Started, not awaited: the window follows it through playbook-event.
ipcMain.handle('playbooks:run', (_e, id, opts) => {
  yieldEmployee();
  if (running) return { ok: false, error: 'Something else is running on this computer. Wait for it to finish, or stop it.' };
  runPlaybook(id, opts || {});
  return { ok: true };
});

ipcMain.handle('playbooks:stop', () => {
  if (!running || !running.playbook) return { ok: true };
  const { abortController } = running;
  running = null;
  abortController.abort();
  overlay.hide();
  return { ok: true };
});

// Which typed values look like they change from run to run — one cheap
// question, on the playbook's own kind of model.
ipcMain.handle('playbooks:suggest', async (_e, id) => {
  const pb = playbooks.raw(id);
  if (!pb) return { ok: false, error: 'That playbook has been deleted.' };
  const model = pb.model || agent.DEFAULT_MODEL;
  try { needClaudeKey(model); } catch {
    return { ok: false, error: 'Suggesting inputs needs a model — add your Anthropic key in Settings → Models.' };
  }
  try {
    const r = await verify.askOnce({ system: playbooks.SUGGEST_RULES, body: playbooks.suggestBrief(pb), model });
    return { ok: true, suggestions: playbooks.parseSuggestions(r.text, pb) };
  } catch (err) {
    return { ok: false, error: errors.explain(err).title };
  }
});

/* ── watchers: work that starts when something happens ───────────── */

// A watcher (watchers.js) saw a file land or an email arrive. It runs a
// playbook with what it saw handed in, or gives an agent the job the way a
// routine does — in a conversation of its own, written down for later.
async function fireWatcher(w, detail) {
  if (w.action.kind === 'playbook') return runPlaybook(w.action.playbookId, { trigger: detail, silent: true });

  const bot = (w.action.botId && store.getBot(w.action.botId)) || store.listBots().find((b) => !b.employee);
  if (!bot) return { ok: false, error: 'the agent it was meant for has been deleted' };
  if (running) return { ok: false, busy: true };
  const prompt = watchers.fillPrompt(w.action.prompt, detail);
  const chat = store.createChat(bot.id);
  store.saveChat(bot.id, chat.id, { title: w.name.slice(0, 60) });
  send('agent-event', { type: 'routine', name: w.name, botId: bot.id, chatId: chat.id });
  let failedWith = null;
  const record = makeRecorder(bot.id, chat.id, prompt);
  const r = await runOne({
    prompt, botId: bot.id, chatId: chat.id, silent: true,
    record: (evt) => { if (evt.type === 'error') failedWith = evt.text; record(evt); },
  });
  send('bots-changed', { botId: bot.id });
  if (r && r.ok === false) return { ok: false, busy: true, error: r.error };
  return failedWith ? { ok: false, error: failedWith } : { ok: true };
}

// Handed to watchers.init once the app is ready (see whenReady).
const watcherHooks = {
  fire: fireWatcher,
  isBusy: () => Boolean(running),
  email: () => connectedEmail(),
  notify: (title, text) => notifyPlaybook(title, text, null),
  changed: () => send('watchers-changed', {}),
};
setInterval(() => { watchers.tick().catch(() => {}); }, 5000);

ipcMain.handle('watchers:list', () => watchers.list());
ipcMain.handle('watchers:create', (_e, spec) => watchers.create(spec || {}));
ipcMain.handle('watchers:update', (_e, id, spec) => watchers.update(id, spec || {}));
ipcMain.handle('watchers:delete', (_e, id) => watchers.remove(id));
ipcMain.handle('watchers:test', (_e, id) => watchers.test(id));

/* ── employees: agents that work on a loop (employees.js) ────────── */

// Said where they will see it: a Windows notification that opens the
// Employees tab on that employee, and a flashing taskbar button.
function notifyFromEmployee(name, text, botId) {
  if (process.env.OPERATOR_NO_NOTIFY === '1') return;   // automated tests
  try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch (_) {}
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: name, body: String(text).slice(0, 200) });
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      win.show(); win.focus();
      send('employee-open', { botId });
    });
    n.show();
  } catch (_) { /* a missing notification is not worth failing the loop over */ }
}

employees.init({ runOne, isBusy: () => Boolean(running), send, notify: notifyFromEmployee });
setInterval(() => { employees.tick().catch(() => {}); }, 15000);

const employeeView = (botId) => {
  const e = store.getEmployee(botId);
  if (!e) return null;
  const chat = e.threads[0] && store.getChat(botId, e.threads[0].id);
  return { ...e, working: employees.isWorking(botId), turns: ((chat && chat.turns) || []).slice(-200) };
};

ipcMain.handle('employees:list', async () => store.listEmployees().map((e) => ({ ...e, working: employees.isWorking(e.id) })));
ipcMain.handle('employees:get', async (_e, botId) => employeeView(botId));
ipcMain.handle('employees:hire', async (_e, spec) => {
  const e = store.hireEmployee(spec || {});
  if (e) setTimeout(() => employees.tick().catch(() => {}), 500);
  return e;
});
ipcMain.handle('employees:update', async (_e, botId, patch) => {
  const e = store.updateEmployee(botId, patch || {});
  if (e && 'onShift' in (patch || {})) setTimeout(() => employees.tick().catch(() => {}), 500);
  return e;
});
ipcMain.handle('employees:say', async (_e, botId, text) => ({ ok: employees.say(botId, text) }));
ipcMain.handle('employees:checkin', async (_e, botId) => employees.checkInNow(botId));
ipcMain.handle('employees:read', async (_e, botId) => store.updateEmployee(botId, { unread: 0 }));
ipcMain.handle('employees:task-add', async (_e, botId, text) => store.addEmployeeTask(botId, text, 'you'));
ipcMain.handle('employees:task-update', async (_e, botId, taskId, patch) => store.updateEmployeeTask(botId, taskId, patch || {}));
ipcMain.handle('employees:task-remove', async (_e, botId, taskId) => { store.removeEmployeeTask(botId, taskId); return { ok: true }; });
ipcMain.handle('employees:fire', async (_e, botId) => {
  if (running && running.botId === botId) {
    const { abortController } = running;
    running = null;
    abortController.abort();
    send('agent-event', { type: 'status', text: 'idle', botId, employee: true });
  }
  store.deleteBot(botId);
  return { ok: true };
});

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

  // Nothing else could stop a run by voice, which made "stop" the one thing you
  // had to reach for the keyboard to do — the exact opposite of the point.
  stopTask: async () => {
    if (!running) return 'Nothing is running.';
    try { running.abortController.abort(); } catch (_) {}
    const who = running.botId ? (store.getBot(running.botId) || {}).name : null;
    running = null;
    send('agent-event', { type: 'status', text: 'idle' });
    voiceChanged();
    return who ? `Stopped ${who}.` : 'Stopped it.';
  },

  addRoutine: async ({ name, task, every, at }) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    const r = store.addRoutine(b.id, {
      name: String(task).slice(0, 50),
      prompt: task,
      every: every || 'day',
      at: at || '09:00',
    });
    if (!r) return 'Could not add that routine.';
    voiceChanged();
    return `${b.name} will do that ${every === 'weekday' ? 'on weekdays' : every === 'week' ? 'on Mondays' : every && every.startsWith('min') ? 'every ' + every.slice(3) + ' minutes' : every === 'hour' ? 'every hour' : 'every day'}${(every || 'day') === 'day' || every === 'weekday' || every === 'week' ? ' at ' + (at || '09:00') : ''}.`;
  },

  // Handing one agent's words to another. Kept on the real Windows clipboard
  // rather than in a variable, so "copy that" is also useful outside the app —
  // Ctrl+V works in Word, in a browser, anywhere.
  copyFromAgent: async (name) => {
    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    const full = store.getBot(b.id);
    const chat = full && full.chats && full.chats[0];
    const turns = (chat && chat.turns) || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].k === 'says' && String(turns[i].text || '').trim()) {
        const t = String(turns[i].text).trim();
        clipboard.writeText(t);
        const words = t.split(/\s+/).length;
        return `Copied ${words} words from ${b.name}. It starts "${t.slice(0, 70)}…". Use send_to_agent with paste true to hand it over word for word.`;
      }
    }
    return `${b.name} has not said anything to copy yet.`;
  },

  copyText: async (content) => {
    clipboard.writeText(String(content || ''));
    return `Copied ${String(content || '').split(/\s+/).filter(Boolean).length} words to the clipboard.`;
  },

  readClipboard: async () => {
    const t = clipboard.readText() || '';
    if (!t.trim()) return 'The clipboard is empty.';
    return `The clipboard holds ${t.split(/\s+/).length} words, starting "${t.slice(0, 200)}".`;
  },

  // Real work on the real machine. This deliberately does NOT wait: a task can
  // run for minutes, and holding the voice turn open would leave the user
  // listening to nothing. It starts the run and returns, and everything it does
  // goes through the same runOne as a typed task — same policy, same audit,
  // same check at the end.
  sendToAgent: async (name, task, paste) => {
    // The voice rewrites what it heard into a task, and "my" is the first
    // word a paraphrase drops — "in my window" becomes "in the browser
    // window", which is a different browser the user cannot see. Whether
    // they said it is not a judgement call, so it is not left to one.
    if (MEANS_MY_SCREEN.test(lastHeard)) {
      task = "ON THE USER'S OWN SCREEN, in the windows they already have open — " +
             "call use_my_screen first and do not open your own browser. " + task;
    }

    const b = findAgent(name);
    if (!b) return `There is no agent called "${name}".`;
    if (running) return `${b.name} cannot start — something else is using the computer right now.`;

    // The whole point of paste: the other agent's words go across untouched,
    // rather than being remembered and retyped slightly differently.
    let prompt = task;
    if (paste) {
      const held = clipboard.readText() || '';
      if (!held.trim()) return 'There is nothing copied to paste. Use copy_from_agent first.';
      prompt = `${task}

${held}`;
    }

    const thread = store.threadOf(b.id);
    send('voice-open', { botId: b.id });

    yieldEmployee();
    runOne({
      prompt,
      botId: b.id,
      chatId: thread.id,
      record: makeRecorder(b.id, thread.id, prompt),
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
  if (claudeReady()) voice.warm(voiceApp).catch(() => {});
  return out;
});

// What the voice needs to know before it can answer almost anything: which
// agents exist, and which one is on screen. Handing it over with the utterance
// saves a whole round trip to list_agents on most turns, and a round trip is
// about a second and a half of someone sitting in silence.
// Every turn's context stays in the conversation for the rest of the session,
// so a roster repeated on all of them piles up: forty names re-sent twenty
// times is thousands of tokens of the same thing, paid for on every later turn.
// It goes out in full only when it has actually changed.
let voiceRoster = '';

function voiceContext(onScreen) {
  const spaces = new Map(store.listWorkspaces().map((w) => [w.id, w.name]));
  const names = store.listBots().slice(0, 40).map((b) => {
    const where = b.pinned ? ' (pinned)' : b.workspaceId ? ` (${spaces.get(b.workspaceId) || 'filed'})` : '';
    return b.name + where;
  });
  const ws = store.listWorkspaces().map((w) => `${w.name} (${w.count})`);
  const roster = [
    names.length ? `Agents: ${names.join(', ')}.` : 'There are no agents yet.',
    ws.length ? `Workspaces: ${ws.join(', ')}.` : 'There are no workspaces yet.',
  ].join(' ');

  const fresh = roster !== voiceRoster;
  voiceRoster = roster;

  return [
    'CONTEXT, not something the user said aloud — never read this out:',
    onScreen ? `On screen: "${onScreen}".` : null,
    fresh ? roster : 'Agents and workspaces are unchanged since the last message.',
    fresh ? 'Names above are exact. Use them without calling list_agents first.' : null,
  ].filter(Boolean).join(' ');
}

// Measured: the model reaches for a tool at about 2.3 seconds and does not say
// a word until about 4.1. That gap is the whole reason hands-free felt slow —
// it had understood and was already acting, in silence. The tool call is proof
// enough to answer on, so the acknowledgement is spoken here rather than waited
// for. Only when the model has not already said something itself.
const ACKS = ['Right.', 'On it.', 'One sec.', 'Okay.', 'Sure.'];
let ackAt = 0;

// Said about their own screen, as opposed to merely containing the word
// "my" — "tidy my downloads folder" is a file job and must not hijack their
// desktop.
const MEANS_MY_SCREEN = /\bmy\s+(window|windows|browser|screen|chrome|edge|firefox|tab|tabs|desktop)\b|\bon\s+my\s+(screen|monitor|display)\b|\b(window|tab|browser)\s+(i|I)\s+(have|had|already\s+have)\s+open\b/i;

// The last thing actually said out loud, before the model paraphrased it.
let lastHeard = '';

ipcMain.handle('voice:heard', async (_e, said, onScreen) => {
  lastHeard = String(said || '');
  const here = voiceContext(onScreen);
  let spoke = false;
  let acked = false;
  try {
    // The voice always thinks with Claude.
    if (!claudeReady()) return { ok: false, error: 'Add your Anthropic API key in Settings → Models to use the voice.' };
    await voice.heard(said, voiceApp, (evt) => {
      if (evt.type === 'say') {
        spoke = true;
        speakOut(evt.text);
      } else if (evt.type === 'tool' && !spoke && !acked) {
        acked = true;
        speakOut(ACKS[ackAt++ % ACKS.length]);
      }
      send('voice-event', { ev: 'voice', ...evt });
    }, here);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// The voice, on demand. Being able to prove the sound reaches the speakers
// without first having to hold a conversation is the difference between "it is
// broken" and "my output device is wrong".
ipcMain.handle('voice:test', async () => {
  const line = 'Voice check. If you can hear this, the speaking half is working.';
  if (piper.installed()) { piper.say(line); return { ok: true, via: 'piper' }; }
  speech.say(line);
  return { ok: true, via: 'sapi', note: piper.describeMissing() };
});

ipcMain.handle('voice:hush', async () => { piper.hush(); speech.hush(); return { ok: true }; });
ipcMain.handle('voice:end', async () => { voice.close(); piper.hush(); voiceRoster = ''; return { ok: true }; });

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

// The words most likely to be said, handed to Whisper before it decodes. Names
// are the part it gets wrong — ordinary English it already knows.
function heardVocabulary() {
  const names = store.listBots().slice(0, 30).map((b) => b.name);
  const ws = store.listWorkspaces().map((w) => w.name);
  return [
    'Operator voice commands.',
    names.length ? `Agents: ${names.join(', ')}.` : '',
    ws.length ? `Workspaces: ${ws.join(', ')}.` : '',
    'Commands: make an agent, make a workspace, file it, pin it, copy that, paste it, send it, what did it say, stop, delete it.',
  ].filter(Boolean).join(' ');
}

ipcMain.handle('whisper-transcribe', async (_e, wav) => {
  try {
    const text = await whisper.transcribe(Buffer.from(wav), heardVocabulary());
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
