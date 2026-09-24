// agent.js — the brain. Runs the Claude Agent SDK (your Claude subscription /
// Claude Code auth) with two sets of hands:
//
//   screen_* / window / app / shell tools  -> the whole Windows desktop (desktop.js)
//   browser_* tools                        -> a dedicated Chromium (browser.js)
//
// The browser tools stay because they are strictly better for web work: they
// can name a button instead of guessing a pixel, and read a page as text.
//
// There are two brains, not one. Claude runs on the subscription through the
// Agent SDK; anything else runs on NVIDIA NIM (nim.js), which puts Meta,
// Google, Mistral, DeepSeek, Qwen, OpenAI's open weights, NVIDIA's own
// Nemotron models and the rest behind a single API key. The tools and the
// system prompt below are built once and handed to whichever one is driving,
// so the two halves cannot drift apart.

const { z } = require('zod');
const browser = require('./browser');
const desktop = require('./desktop');
const nim = require('./nim');
const modelOptions = require('./model-options');
const codes = require('./codes');
const phone = require('./phone');

// Driving a GUI is mostly perception plus a short decision, repeated — the kind
// of loop where a faster model is worth more than a deeper one, because every
// turn costs a round trip. That is why Sonnet 5, not Opus, is the default; the
// picker in the command bar overrides it per task.
//
// These run on the Claude subscription — no API key, nothing to set up.
const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'The most capable, and the slowest' },
  { id: 'claude-opus-5', name: 'Opus 5', note: 'Deep reasoning, for work that needs care' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', note: 'Quick enough to drive a screen', best: true },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', note: 'Fastest, for short repetitive jobs' },

  { id: 'claude-fable-5', name: 'Fable 5', note: 'Previous generation', older: true },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', note: 'Previous generation', older: true },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', note: 'Previous generation', older: true },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', note: 'Previous generation', older: true },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', note: 'Previous generation', older: true },
].map((m) => ({ ...m, provider: 'anthropic', providerName: 'Claude', vendor: 'claude', vision: true, tools: true }));

// The old export name, still Claude-only — the coding side uses it and only
// ever runs on the Agent SDK.
const MODELS = CLAUDE_MODELS;

const DEFAULT_MODEL = 'claude-sonnet-5';

// Everything the picker can offer: Claude first, then every model NVIDIA NIM
// is serving, grouped by whose model it is.
const listModels = () => [...CLAUDE_MODELS, ...nim.listModels()];

const isClaudeModel = (id) => CLAUDE_MODELS.some((m) => m.id === id);
const isModel = (id) => isClaudeModel(id) || nim.isNimModel(id);

// The paragraphs that exist only because the text path exists. Kept as their
// own constant so a benchmark can run the agent with and against them and get
// a straight answer about whether any of this actually made it quicker.
const TEXT_PATH_PROMPT = `- LOOK WITH TEXT FIRST. screen_read gives you a window as a list of named controls with the coordinates to click them — a button, a box, a label, each with a position. It costs a fraction of a screenshot and it tells you what things are CALLED, so you are not squinting at pixels guessing where a button is. For an ordinary app — Explorer, Notepad, Settings, Office, a dialog — screen_read then screen_click_text is the fast path, and you should take it by default.
- screen_click_text clicks a control by its name, and hands you back the window as text afterwards, so one call both acts and shows you the result.
- BUT ONE CALL STILL BEATS TWO. A screen_do step can be {"action":"click_text","name":"Advanced view"}, so batch named clicks the way you batch everything else: one screen_do doing click_text, click_text, type, click_text beats four separate calls every time. Use screen_click_text alone only for a single click you could not predict. screen_do hands back the window as text too, so you still see what happened.
- If screen_read comes back empty or says the window draws itself — games, canvases, video, some Electron apps, anything custom-drawn — THEN take a screenshot and work from pixels. Also screenshot when you genuinely need to see what something looks like rather than what it is.
- screen_screenshot is still there and still correct; it is just the expensive way to look. Never click coordinates you have not just seen on a screenshot or in a screen_read.
`;

const SYSTEM_PROMPT = `You are Operator. You run on the user's own Windows PC and you can actually use it — the whole machine, not just a browser.

FIRST, decide what kind of message this is:
- If the user is just talking — a greeting, small talk, a thank-you, or a question you can answer from your own knowledge — reply in plain text. Do NOT take a screenshot or call any tools.
- Only start acting when they ask you to DO something. If you are unsure what they want, ask one short clarifying question first.

WHEN YOU ACT, pick the right set of hands:

0. WHOSE SCREEN IS IT? Decide this BEFORE anything else.
   - If the user says "my" — my browser, my window, my Chrome, my screen, my tab, "the one I have open", "the video on my screen" — they mean THEIR windows, not yours. Call use_my_screen, then list_windows, then focus_window, and work it with screen_* tools. Do NOT open your own browser; it is a different browser with different tabs and they will not see anything happen.
   - You normally run on a hidden desktop of your own, which is why their windows are not in list_windows until you call use_my_screen. "I can't see your window" is never the answer — calling use_my_screen is.
   - Once you are on their screen you are moving their real mouse. Do only what was asked, and call use_own_screen when you are done.
   - If they did not say "my", it is your own browser and your own desktop as usual.
   - ONCE YOU ARE ON THEIR SCREEN, STAY THERE for the rest of that job. Every follow-up — "now click the second one", "scroll down", "play it" — is still about the window in front of them. Reaching for browser_* halfway through opens a different browser they cannot see, and the work silently stops being visible to them.

WORKING IN THEIR BROWSER — the address bar will betray you:
   - Type the WHOLE url, "https://www.youtube.com", never a bare word like "youtube". Chrome inline-autocompletes from their history, so "youtube" plus Enter opens the last video they watched rather than the site. This is not hypothetical; it is exactly what happened.
   - After typing a url and BEFORE Enter, press Delete. That clears the greyed-out completion Chrome has appended to what you typed. Then press Enter.
   - When you are already in THEIR browser and it has focus, open the tab from the keyboard: ctrl+t, type the full url, Delete, Enter. Do NOT use launch_app for a url here. launch_app goes through the Windows shell, which hands the browser a "show normal" and can drop their maximised window back to a small one — the helper puts it back, but not opening the wound is better than closing it.
   - launch_app with a full url is still the right call when no browser is open yet, or when it does not matter whose browser it lands in.
   - If a tab for that site is already open, switch to it instead of opening another.

LEAVE THEIR WINDOWS AS YOU FOUND THEM:
   - list_windows marks a window MAXIMISED. If one was maximised when you found it and is not by the time you are done, call maximize_window to put it back. Opening a tab is enough to drop Chrome out of full screen, so check before you finish.
   - Do not move, resize or close their windows unless that is the actual task.

1. Anything on the web that is YOURS to do — searching, a site, a form, a video, an account, where it does not matter whose browser it happens in — use the browser_* tools. They drive a dedicated Chromium window and are far more reliable than clicking pixels: browser_click_text and browser_type_into name the element. Reach for these first for web work the user did not attach to their own screen.
   SPEED — this matters a lot:
   - Every browser action already returns the page as text, so you can read results, field names and links without a separate step. Do NOT call browser_read_text or browser_screenshot after an action just to "see" — you already have the page. Only screenshot when you genuinely need to see pixels (a canvas, an image, an odd layout).
   - Fill forms with ONE browser_fill_form call listing every field, not one browser_type_into per field. Set submit:true to send it in the same call.
   - WHEN A STEP IS NOT YOURS TO DO — the user has to scan a QR, tap an approval, type a code on their phone, or an upload or payment is still going — do NOT end your turn to tell them. Say in one line what they need to do, then call browser_wait_for and continue the moment the page moves on. Ending the turn means they have to come back and start you again, by which time the page has usually timed out.
   - DROPDOWNS: always browser_select. Never click a dropdown open and try to find the option by eye — a real <select> draws its list outside the page, so it is not in the screenshot and cannot be clicked or scrolled at coordinates. That is why long lists like a year of birth get stuck.
   - Chain: navigate, then fill_form with submit — a whole "go to the site and fill it in" is often just two calls.

2. Anything else on the computer — desktop apps, Explorer, settings, games, installers, local files, or a browser the user already has open — use the screen_* tools. This is a real mouse and keyboard on a real desktop.

USING THE SCREEN:
- LOOK WITH TEXT FIRST. screen_read gives you a window as a list of named controls with the coordinates to click them — a button, a box, a label, each with a position. It costs a fraction of a screenshot and it tells you what things are CALLED, so you are not squinting at pixels guessing where a button is. For an ordinary app — Explorer, Notepad, Settings, Office, a dialog — screen_read then screen_click_text is the fast path, and you should take it by default.
- screen_click_text clicks a control by its name, and hands you back the window as text afterwards, so one call both acts and shows you the result.
- BUT ONE CALL STILL BEATS TWO. A screen_do step can be {"action":"click_text","name":"Advanced view"}, so batch named clicks the way you batch everything else: one screen_do doing click_text, click_text, type, click_text beats four separate calls every time. Use screen_click_text alone only for a single click you could not predict. screen_do hands back the window as text too, so you still see what happened.
- If screen_read comes back empty or says the window draws itself — games, canvases, video, some Electron apps, anything custom-drawn — THEN take a screenshot and work from pixels. Also screenshot when you genuinely need to see what something looks like rather than what it is.
- screen_screenshot is still there and still correct; it is just the expensive way to look. Never click coordinates you have not just seen on a screenshot or in a screen_read.
- Screenshots come back per display, scaled: display 1 is the primary monitor. Every shot reports which display it is and how many exist — don't ask for one outside that range. The image dimensions are reported too, and click/move/drag coordinates use that exact same space, so a button at (300, 480) in the image is clicked at (300, 480). Pass the same "display" number you took the shot from.
- list_windows is usually the fastest way to find something: it tells you every open window, which monitor's coordinates it sits at, and what has focus. Use it before screenshotting every monitor in turn. focus_window brings one to the front — always focus a window before sending it keystrokes.
- Clicks, drags, scrolls and key presses return a fresh screenshot — look at it before the next step. Typing and plain mouse moves do not, to save time; screenshot yourself if you need to check them.
- SPEED MATTERS MORE THAN ANYTHING ELSE HERE. Every separate tool call costs the user seconds of waiting, while the actions themselves take milliseconds. The waiting is almost entirely you, not the computer.
- So plan as far ahead as you reasonably can and send it as ONE screen_do (up to 20 steps). Clicking a field, typing into it and pressing Enter is one screen_do with three steps, not three calls. Opening a menu and picking an item is one screen_do. Filling a whole form is one screen_do. Only fall back to single tools when you genuinely cannot predict the next step without looking.
- Measured on this machine: a click costs about 2ms, reading a window as text about 130ms, and a screenshot about 160ms — but the screenshot then costs roughly six times as much to look at as the text does, on that turn and on every turn after it. Your own turn costs seconds. So the question is never "is this action cheap?" - it is "can I avoid another round trip?". Two extra steps in one screen_do are free; one extra look is not.
- Don't re-look at a screen you have already seen and have not changed, and don't screenshot every monitor when list_windows would tell you where something is.
- Prefer run_command outright when the job is really a file or settings job. Moving twenty files is one command; it is twenty minutes of clicking.
- launch_app opens a program by name ("notepad", "calc", "explorer"), a file path, or a URL.
- run_command runs PowerShell and gives you its output. Use it when the shell is genuinely faster or more reliable than clicking — reading a folder, checking a setting, moving files, finding an install path. Prefer it over hunting through GUI dialogs.

SIGNING IN:
- Your browser keeps its profile, so a site you log into once stays logged in. Check whether you are already signed in before assuming you are not.
- If a sign-in page refuses you, shows "this browser or app may not be secure", loops back to the login form, or demands a code from a phone you do not have, STOP trying to force it in your own browser. Two better moves, in order:
  1. The user almost certainly has that account open in their own browser already. Use list_windows and the screen_* tools to work in their real Chrome or Edge window instead of yours. It is signed in, it is trusted by the site, and it is the same thing they would do.
  2. If neither browser is signed in, ask the user to log in themselves rather than handling their password. Say which site and why. Never type a password you were not explicitly handed for that purpose.
- CODES. If a step sends a one-time code, say in one short line that you are waiting for it, then call get_verification_code. It BLOCKS until the code arrives — up to two minutes by default — so when it returns you have the code and should type it in and carry straight on. Do not end your turn to ask the user for a code; only ask if the tool comes back saying it waited and nothing arrived. Check the sender matches the service before typing the code anywhere.
- SIGNING UP. You can fill in a sign-up form when the user asks you to — a trial, a forum, a tool they want an account on. Two things to hold to. Do not attempt one that needs phone or identity verification: you cannot receive the code, and a signup a service gates that way is one it does not want automated. And say plainly, once, that an account a program made can be closed later for it — that is the service's rule, not a fault you can work around, so the user should decide knowing it.
- Once signed in, carry on with whichever browser worked. Do not switch back and forth mid-task.

GENERAL:
- Keep going until the goal is met, then stop and give a one-line summary. Don't hand work back to the user that you could do yourself.
- If you hit a captcha or an "I'm not a robot" checkbox, click it like a person would and carry on.
- One exception to just doing it: if a step is destructive and hard to undo — permanently deleting files, spending money, sending a message or posting something publicly, changing security settings — say what you are about to do and wait for the user to confirm. Everything else, just do it.`;

// A teammate answering a message. It replies from its own persona and memory —
// a single reasoning turn, no computer tools, because two agents driving the
// same machine at once would collide. This is how one bot gets what another
// knows (an account login, a preference, a status).
async function askBot({ bot, message, model }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  let sys = `You are "${bot.name}"${bot.title ? `, ${bot.title}` : ''}, one of the user's Operator bots. Another of the user's bots is messaging you to ask for something. Reply directly and briefly with exactly what they need. If it is an account login or similar that you hold, give it. If you do not know, say so plainly in one line.`;
  if (bot.persona && bot.persona.trim()) sys += `\n\nWho you are:\n${bot.persona.trim()}`;
  if (bot.memory && bot.memory.length) {
    sys += `\n\nWhat you know (your saved notes):\n${bot.memory.slice(0, 80).map((m) => '- ' + m.text).join('\n')}`;
  }

  // A teammate on a NIM model answers through NVIDIA, not the SDK.
  if (nim.isNimModel(model)) {
    try {
      return (await nim.ask({ model, system: sys, message })) || '(no reply)';
    } catch (err) {
      return `(could not reach ${bot.name}: ${err.message})`;
    }
  }

  let reply = '';
  const stream = query({
    prompt: message,
    options: { model: isClaudeModel(model) ? model : DEFAULT_MODEL, systemPrompt: sys, tools: [], allowedTools: [], settingSources: [], maxTurns: 1 },
  });
  for await (const m of stream) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'text') reply += b.text;
    } else if (m.type === 'result' && !reply && m.result) {
      reply = m.result;
    }
  }
  return reply.trim() || '(no reply)';
}

// Everything about a task that changes from one task to the next. The tools
// read it through this object rather than closing over the arguments, because
// the tools now outlive the task: they belong to a session that stays open.
// See openSession() for why that is worth the indirection.
// A one-off skill the user invoked for THIS message with /name. It used to be
// appended to the system prompt, which only worked while every task built its
// own. A session outlives the task, so what is per-message travels with the
// message instead.
function withActiveSkill(text, activeSkill) {
  if (!activeSkill || !activeSkill.prompt) return text;
  return `You invoked the "${activeSkill.title || activeSkill.name}" skill (/${activeSkill.name}) for this message. Follow it now, applying it to what I wrote:

${activeSkill.prompt}

What I wrote: ${text}`;
}

function makeCtx({ onEvent, abortController, dryRun }) {
  return { onEvent: onEvent || (() => {}), abortController, dryRun: Boolean(dryRun) };
}

// Build a session: the tools, the system prompt and one live SDK query that
// stays open between tasks.
//
// This used to be runTask, creating everything per task. Measured, that cost
// ~3.2s of subprocess start before the model saw a single token — about a fifth
// of a short task, paid again every time. Pushing a message into a session that
// is already open costs ~10ms. So the session outlives the task, and everything
// that varies per task moved into `ctx` (see makeCtx) or into the message
// itself (see withActiveSkill).
// textPath defaults OFF. Reading a window as text costs a fraction of a
// screenshot in tokens, which is why it looked like a win — but tokens are
// cheap and turns are not. Measured four times on a real task it took ~1.6 more
// turns and 12-40% longer every time, because a screenshot plus one batched
// screen_do does the same job in one round trip. The tools are still here and
// still correct; pass textPath:true to use them.
async function createSession({ userDataDir, model, resume, bot, teammates, messageBot, codeChats, email, alwaysSkills, skillIndex, dryRun, textPath = false,
                               tuning = {},
                               hasMessageBot = Boolean(messageBot), hasCodeChats = Boolean(codeChats), hasEmail = Boolean(email) }) {
  const ctx = makeCtx({ dryRun });
  ctx.messageBot = messageBot; ctx.codeChats = codeChats; ctx.email = email;
  const { query, tool: sdkTool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

  /* ── dry run ──────────────────────────────────────────────────────────
   * A rehearsal. The agent works the task against the real screen and the
   * real pages, but nothing it does can change anything: looking still
   * happens for real, so the plan is grounded in what is actually there,
   * while every action that would touch the world is intercepted here and
   * recorded as a plan step instead.
   *
   * Enforced in code rather than asked for in the system prompt, on purpose —
   * a rehearsal the model can be talked out of is not a rehearsal.
   */

  // Anything that sends input, opens something, spends, writes or sends.
  const WRITES = new Set([
    'screen_do', 'screen_click', 'screen_move', 'screen_drag', 'screen_scroll',
    'screen_type', 'screen_key', 'launch_app', 'focus_window', 'run_command',
    'browser_click_text', 'browser_type_into', 'browser_fill_form', 'browser_select',
    'browser_click_xy', 'browser_press_key', 'browser_scroll',
    'email_send', 'remember', 'message_bot', 'screen_click_text',
    // Stepping onto the user's screen moves their real mouse, so a rehearsal
    // describes it rather than doing it.
    'use_my_screen', 'use_own_screen',
  ]);

  // A shell command only counts as looking if it matches a conservative
  // allowlist AND carries nothing that could write, install or redirect.
  const READS_ONLY = /^\s*(get-\w+|test-path|resolve-path|select-string|measure-object|where-object|sort-object|select-object|format-\w+|out-string|convertto-json|ls|dir|cat|type|echo|whoami|hostname|systeminfo|findstr|tree|pwd)\b/i;
  const MUTATES = /(\bremove-|\bset-|\bnew-|\bmove-|\bcopy-|\brename-|\bstop-|\bstart-|\brestart-|\binstall|\buninstall|\bout-file|\badd-content|\bset-content|\bclear-|\binvoke-webrequest|\binvoke-expression|\biex\b|\bdel\b|\brm\b|\brmdir\b|\bmkdir\b|\bcurl\b|\bwget\b|\breg\s+add|\bschtasks\b|\bnet\s+user|>|\|\s*out-)/i;
  const readOnlyCommand = (c) => READS_ONLY.test(String(c || '')) && !MUTATES.test(String(c || ''));

  // Flag steps that would be hard to take back, so the plan says so out loud.
  const RISKY = /\b(buy|pay|purchase|checkout|order|delete|remove|erase|send|submit|confirm|post|publish|transfer|subscribe|unsubscribe|cancel)\b/i;
  function riskOf(name, a) {
    if (name === 'email_send') return `sends an email to ${a.to}`;
    if (name === 'run_command') return 'runs a shell command';
    if (name === 'message_bot') return `messages ${a.bot}`;
    const words = [a.text, a.keys, a.target, a.title].filter(Boolean).join(' ');
    return RISKY.test(words) ? 'looks hard to undo' : null;
  }

  function describeStep(name, a) {
    switch (name) {
      case 'screen_do': return `on screen: ${(a.steps || []).map((s) => s.action).join(' → ')}`;
      case 'screen_click': return `click (${a.x}, ${a.y})`;
      case 'screen_move': return `move the mouse to (${a.x}, ${a.y})`;
      case 'screen_drag': return `drag (${a.x1}, ${a.y1}) to (${a.x2}, ${a.y2})`;
      case 'screen_scroll': return `scroll ${a.direction}`;
      case 'screen_type': return `type "${String(a.text || '').slice(0, 60)}"`;
      case 'screen_key': return `press ${a.keys}`;
      case 'launch_app': return `open ${a.target}`;
      case 'focus_window': return `switch to "${a.title}"`;
      case 'run_command': return `run: ${String(a.command || '').slice(0, 140)}`;
      case 'screen_click_text': return `click "${a.text}"${a.window ? ` in ${a.window}` : ''}`;
      case 'use_my_screen': return `take over your screen${a.reason ? ' to ' + a.reason : ''}`;
      case 'use_own_screen': return 'give your screen back';
      case 'maximize_window': return `put "${a.title}" back to full size`;
      case 'screen_read': return `read ${a.title || 'the window in front'} as text`;
      case 'browser_click_text': return `click "${a.text}" in the browser`;
      case 'browser_click_xy': return `click (${a.x}, ${a.y}) in the browser`;
      case 'browser_type_into': return `type "${String(a.text || '').slice(0, 50)}" into "${a.target}"`;
      case 'browser_wait_for': return `wait until ${a.until === 'gone' ? `"${a.text}" is gone` : a.until === 'appears' ? `"${a.text}" appears` : a.until === 'url' ? 'the page moves on' : 'the page changes'}`;
      case 'browser_select': return `set "${a.field}" to "${a.option}"`;
      case 'browser_fill_form': return `fill ${(a.fields || []).length} field(s)${a.submit ? ' and submit' : ''}`;
      case 'browser_press_key': return `press ${a.key} in the browser`;
      case 'browser_scroll': return `scroll ${a.direction} in the browser`;
      case 'get_verification_code': return `wait for the code${a.from ? ` from ${a.from}` : ''}`;
      case 'email_send': return `email ${a.to} — "${a.subject}"`;
      case 'remember': return `remember "${String(a.note || '').slice(0, 60)}"`;
      case 'message_bot': return `ask ${a.bot}: "${String(a.message || '').slice(0, 60)}"`;
      default: return name;
    }
  }

  // Every tool is registered through this wrapper, so a tool added later is
  // guarded by default instead of relying on someone remembering.
  let planNo = 0;
  const tool = (name, description, schema, handler) =>
    sdkTool(name, description, schema, async (...call) => {
      const args = call[0] || {};
      const writes = WRITES.has(name) && !(name === 'run_command' && readOnlyCommand(args.command));
      const text = describeStep(name, args);

      if (ctx.dryRun && writes) {
        ctx.onEvent({ type: 'plan_step', n: ++planNo, name, input: args, text, risk: riskOf(name, args) });
        ctx.onEvent({ type: 'tool_done', name, input: args, text, ok: true, ms: 0, dryRun: true });
        return { content: [{ type: 'text', text:
          `DRY RUN — this did NOT happen. Recorded as step ${planNo} of the plan: ${text}. ` +
          `Assume it worked and carry on planning the rest of the task.` }] };
      }

      // Everything the agent does passes through here, so this is where the run
      // gets timed and its outcome recorded. The `tool` event above fires when
      // the model *asks* for a tool; only this side knows whether it worked.
      const started = Date.now();
      try {
        const out = await handler(...call);
        const failed = Boolean(out && out.isError);
        ctx.onEvent({ type: 'tool_done', name, input: args, text, ok: !failed, ms: Date.now() - started });
        return out;
      } catch (err) {
        ctx.onEvent({ type: 'tool_done', name, input: args, text, ok: false, ms: Date.now() - started,
                  error: String((err && err.message) || err) });
        throw err;
      }
    });

  // Chromium starts on first use, not on every task — asking Operator to open
  // Notepad should not pop a browser window.
  const page = async () => {
    await browser.ensureBrowser(userDataDir);
    return browser.getPage();
  };

  const img = (b64, mime) => ({ type: 'image', data: b64, mimeType: mime || 'image/png' });

  // After a web action, hand the model the page as TEXT, not a screenshot. Text
  // is a fraction of the size and processing time of a 1280px image, and it is
  // exactly what the name-the-element browser tools need — so this both speeds
  // up every turn and saves a separate browser_read_text call. We still take a
  // screenshot for the live view (so the user can watch), just don't send that
  // image to the model. Reach for browser_screenshot only when pixels matter.
  const afterWeb = async (text) => {
    await browser.settle();
    browser.snap().catch(() => {});        // refresh the live view, don't block on it
    const p = browser.getPage();
    let seen = '';
    try { seen = (await p.innerText('body')).slice(0, 2500); } catch (_) {}
    const body = seen ? `${text}\nURL: ${p.url()}\n\n${seen}` : text;
    return { content: [{ type: 'text', text: body }] };
  };

  // Always restate where this image came from and how many monitors exist —
  // otherwise the agent goes hunting for displays that aren't there.
  const shotCaption = (shot) =>
    `Display ${shot.display} of ${shot.displays}, ${shot.width}x${shot.height}. ` +
    `Foreground window: ${shot.foreground || 'unknown'}`;

  // Reading the desktop as text, the way the browser tools read a page. A
  // look this way is a few hundred tokens instead of a ~1,200-token picture,
  // and it names what is on screen rather than leaving the model to find it
  // by eye — which is most of what makes desktop work feel slow.
  const controlLines = (res) => {
    const multi = new Set(res.controls.map((c) => c.d)).size > 1;
    return res.controls
      .map((c) => `${c.type} "${c.name}" @${c.x},${c.y}${multi ? ` d${c.d}` : ''}`)
      .join('\n');
  };

  const readOut = (res, lead) => {
    const body = controlLines(res);
    const note = res.truncated ? '\n(list cut short — narrow it with a window title or a smaller depth)' : '';
    return { content: [{ type: 'text', text:
      `${lead}${res.title}\n\n${body || '(nothing readable — this window draws itself, so use screen_screenshot)'}${note}` }] };
  };

  const afterScreen = async (text, display) => {
    const shot = await desktop.screenshot(display);
    return { content: [{ type: 'text', text: `${text}\n${shotCaption(shot)}` }, img(shot.image, shot.mime)] };
  };

  const display = z.number().int().optional()
    .describe('Monitor number; 1 is the primary. Defaults to the last one you looked at.');

  /* ── the desktop ─────────────────────────────────────────────── */

  const desktopTools = [
    // The single biggest speed win available. Each tool call is a round trip to
    // the model — a few seconds — while the actions themselves cost milliseconds.
    // Clicking a field, typing into it and pressing Enter as three calls costs
    // three round trips; as one screen_do it costs one.
    tool('screen_do',
      'Do several screen actions in one go, in order, and get one screenshot at the end. Use this whenever you already know the next few steps — it is many times faster than calling the tools one at a time.',
      {
        steps: z.array(z.object({
          action: z.enum(textPath
            ? ['click', 'click_text', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'wait', 'focus']
            : ['click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'wait', 'focus']),
          x: z.number().optional(),
          y: z.number().optional(),
          text: z.string().optional().describe('For type.'),
          keys: z.string().optional().describe('For key, e.g. "ctrl+a", "enter".'),
          direction: z.enum(['up', 'down', 'left', 'right']).optional(),
          amount: z.number().optional(),
          seconds: z.number().optional().describe('For wait.'),
          title: z.string().optional().describe('For focus: part of a window title.'),
          name: z.string().optional().describe('For click_text: the visible name of the control, e.g. "Save".'),
        })).min(1).max(20),
        display,
      },
      async ({ steps, display: d }) => {
        const done = [];
        for (const s of steps) {
          switch (s.action) {
            case 'click':        await desktop.click(s.x, s.y, 'left', 1, d); done.push(`click ${s.x},${s.y}`); break;
            case 'double_click': await desktop.click(s.x, s.y, 'left', 2, d); done.push(`double-click ${s.x},${s.y}`); break;
            case 'right_click':  await desktop.click(s.x, s.y, 'right', 1, d); done.push(`right-click ${s.x},${s.y}`); break;
            case 'move':         await desktop.move(s.x, s.y, d); done.push(`move ${s.x},${s.y}`); break;
            case 'type':         await desktop.typeText(s.text || ''); done.push(`type "${s.text}"`); break;
            case 'key':          await desktop.pressKeys(s.keys || ''); done.push(`key ${s.keys}`); break;
            case 'focus':        await desktop.focusWindow(s.title || ''); done.push(`focus "${s.title}"`); break;
            case 'click_text': {
              const hit = await desktop.clickText(s.name || s.text || '');
              if (!hit.ok) {
                // Stop here rather than carrying on: the rest of the batch was
                // written expecting this click to have landed. Hand back what
                // did happen and what is actually on screen, so the retry is
                // informed instead of another guess.
                const near = hit.nearby ? ` What is there: ${hit.nearby}` : '';
                return { content: [{ type: 'text', text:
                  `Did: ${done.join(' → ') || '(nothing)'}, then stopped — ${hit.error}.${near}` }] };
              }
              done.push(`click "${hit.clicked}"`);
              break;
            }
            case 'scroll': {
              const horiz = s.direction === 'left' || s.direction === 'right';
              const sign = (s.direction === 'down' || s.direction === 'left') ? -1 : 1;
              await desktop.scroll(s.x, s.y, sign * (s.amount || 3) * 120, horiz, d);
              done.push(`scroll ${s.direction}`);
              break;
            }
            case 'wait':
              await new Promise((r) => setTimeout(r, Math.min(s.seconds || 1, 20) * 1000));
              done.push(`wait ${s.seconds}s`);
              break;
          }
        }
        const lead = `Did: ${done.join(' → ')}`;
        if (textPath) {
          await new Promise((r) => setTimeout(r, 150));
          const after = await desktop.readScreen();
          if (after.ok && after.controls.filter((c) => c.act).length >= 3) {
            return readOut(after, `${lead}. Now showing `);
          }
        }
        return afterScreen(lead, d);
      }),

    tool('screen_screenshot', 'Look at a monitor. Returns the screen image plus its dimensions; click coordinates use the same space.',
      { display }, async ({ display: d }) => {
        const shot = await desktop.screenshot(d);
        return { content: [{ type: 'text', text: shotCaption(shot) }, img(shot.image, shot.mime)] };
      }),

    tool('screen_click', 'Click somewhere on the screen, at coordinates taken from a screenshot.',
      {
        x: z.number(), y: z.number(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        clicks: z.number().int().min(1).max(3).optional().describe('2 for a double-click.'),
        display,
      },
      async ({ x, y, button, clicks, display: d }) => {
        await desktop.click(x, y, button || 'left', clicks || 1, d);
        const what = clicks === 2 ? 'Double-clicked' : `${button === 'right' ? 'Right-c' : button === 'middle' ? 'Middle-c' : 'C'}licked`;
        return afterScreen(`${what} (${x}, ${y})`, d);
      }),

    tool('screen_move', 'Move the mouse without clicking — use it to reveal a hover menu or tooltip.',
      { x: z.number(), y: z.number(), display },
      async ({ x, y, display: d }) => {
        await desktop.move(x, y, d);
        return { content: [{ type: 'text', text: `Moved the mouse to (${x}, ${y}). Screenshot if you need to see what it revealed.` }] };
      }),

    tool('screen_drag', 'Press the left button at one point, drag to another, and release.',
      { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), display },
      async ({ x1, y1, x2, y2, display: d }) => {
        await desktop.drag(x1, y1, x2, y2, d);
        return afterScreen(`Dragged (${x1}, ${y1}) to (${x2}, ${y2})`, d);
      }),

    tool('screen_scroll', 'Scroll the window under the given point.',
      {
        x: z.number(), y: z.number(),
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().optional().describe('Wheel notches; 3 is about one screen.'),
        display,
      },
      async ({ x, y, direction, amount, display: d }) => {
        const notches = (amount || 3) * 120;
        const horizontal = direction === 'left' || direction === 'right';
        const sign = (direction === 'down' || direction === 'left') ? -1 : 1;
        await desktop.scroll(x, y, sign * notches, horizontal, d);
        return afterScreen(`Scrolled ${direction}`, d);
      }),

    tool('screen_type', 'Type text into whatever currently has keyboard focus. Click the field first.',
      { text: z.string(), enter: z.boolean().optional(), display },
      async ({ text, enter, display: d }) => {
        await desktop.typeText(text);
        if (enter) await desktop.pressKeys('enter');
        const what = text.length > 60 ? text.slice(0, 57) + '…' : text;
        return { content: [{ type: 'text', text: `Typed "${what}"${enter ? ' and pressed Enter' : ''}. Screenshot if you need to check it landed.` }] };
      }),

    tool('screen_key', 'Press a key or a combination, e.g. "enter", "escape", "ctrl+c", "alt+tab", "win+r", "ctrl+shift+esc".',
      { keys: z.string(), display },
      async ({ keys, display: d }) => {
        await desktop.pressKeys(keys);
        return afterScreen(`Pressed ${keys}`, d);
      }),

    tool('screen_read',
      'Read a desktop window as TEXT — every button, box and label with the coordinates to click it. Far faster and cheaper than a screenshot, and it names things instead of making you find them by eye. Use this FIRST for any normal app; only screenshot when you need to see actual pixels.',
      { title: z.string().optional().describe('part of a window title; omit for the window in front'),
        depth: z.number().int().min(3).max(14).optional().describe('how deep to look; 8 is plenty') },
      async ({ title, depth }) => {
        const res = await desktop.readScreen(title, depth).catch((e) => ({ ok: false, error: e.message }));
        // Not every window can be read: games and anything custom-drawn expose
        // nothing, and Windows suspends a background Store app so its tree is
        // empty until it is in front. Falling back to a picture HERE rather
        // than reporting failure is the point — otherwise the cheap look costs
        // a whole extra round trip on exactly the windows it cannot help with,
        // and the agent ends up slower than if it had never tried.
        const thin = res.ok && res.controls.filter((c) => c.act).length < 3;
        if (!res.ok || thin) {
          const why = res.ok
            ? `"${res.title}" draws its own interface, so there is nothing to read`
            : res.error;
          return afterScreen(`${why} — here is a screenshot instead.`);
        }
        return readOut(res, 'Reading ');
      }),

    tool('screen_click_text',
      'Click a control on the desktop by its NAME, e.g. "Save", "File", "OK". No coordinates and no screenshot needed — this is the desktop version of browser_click_text and is the most reliable way to click. Returns the window as text afterwards, so you can see what changed without another call.',
      { text: z.string().describe('the visible name of the button, menu item or box'),
        window: z.string().optional().describe('part of a window title; omit for the window in front') },
      async ({ text, window: win }) => {
        const res = await desktop.clickText(text, win);
        if (!res.ok) {
          const near = res.nearby ? `\n\nWhat is there: ${res.nearby}` : '';
          return { content: [{ type: 'text', text: `${res.error}.${near}` }] };
        }
        // Let the click land before looking again, then hand back the new state
        // as text — the same "every action returns the page" trick that makes
        // the browser tools quick.
        await new Promise((r) => setTimeout(r, 180));
        const after = await desktop.readScreen().catch(() => ({ ok: false }));
        // Same reasoning as screen_read: if what is in front now cannot be read,
        // show it rather than leaving the agent to spend a turn asking.
        if (!after.ok || after.controls.filter((c) => c.act).length < 3) {
          return afterScreen(`Clicked "${res.clicked}".`);
        }
        return readOut(after, `Clicked "${res.clicked}". Now showing `);
      }),

    tool('list_windows', 'List the open windows with their titles, positions and sizes, and say which one has focus.',
      {}, async () => {
        const res = await desktop.listWindows();
        const rows = res.windows
          .map((w) => `• ${w.title}  [${w.width}x${w.height} at ${w.left},${w.top}${w.max ? ', MAXIMISED' : ''}]`)
          .join('\n');
        return { content: [{ type: 'text', text: `Foreground: ${res.foreground}\n\nOpen windows:\n${rows}` }] };
      }),

    tool('use_my_screen', "Move onto the USER'S OWN screen, so you can see and drive the windows they already have open — their Chrome, their Explorer, whatever they are looking at. Call this the moment they say 'my' anything: my browser, my window, my screen, the tab I have open. Until you do you are on a hidden desktop of your own, where their windows do not exist — which is why list_windows cannot find them and opening your own browser is the wrong answer.",
      { reason: z.string().describe('what you need their screen for, in a few words') },
      async ({ reason }) => {
        if (desktop.target().kind === 'remote') {
          return { content: [{ type: 'text', text: 'You are driving another machine, so the user\'s own windows are not reachable from here. Say so rather than opening anything.' }] };
        }
        const already = !desktop.isPrivate();
        if (!already) {
          desktop.usePrivateDesktop(false);
          ctx.onEvent({ type: 'desktop', mine: true, reason });
        }
        const res = await desktop.listWindows();
        const rows = res.windows.map((w) => `• ${w.title}  [${w.width}x${w.height} at ${w.left},${w.top}]`).join('\n');
        const head = already
          ? 'You were already on the user\'s screen.'
          : 'You are now on the user\'s own desktop, sharing their real mouse and keyboard. Move deliberately, do not click anything you were not asked to, and call use_own_screen the moment you are finished.';
        return { content: [{ type: 'text', text: `${head}\n\nForeground: ${res.foreground}\n\nTheir open windows:\n${rows}` }] };
      }),

    tool('use_own_screen', 'Go back to your own hidden desktop and give the user their mouse and keyboard back. Do this as soon as you have finished with their screen.',
      {}, async () => {
        if (desktop.isPrivate()) return { content: [{ type: 'text', text: 'You are already on your own desktop.' }] };
        desktop.usePrivateDesktop(true);
        ctx.onEvent({ type: 'desktop', mine: false });
        return { content: [{ type: 'text', text: 'Back on your own desktop. The user has their screen to themselves again.' }] };
      }),
    tool('focus_window', 'Bring a window to the front by a fragment of its title. Do this before typing into an app.',
      { title: z.string() }, async ({ title }) => {
        const res = await desktop.focusWindow(title);
        return afterScreen(`Focused "${res.title}"`);
      }),

    tool('maximize_window', "Put a window back to maximised. Opening a tab drops Chrome out of full screen, so if a window was MAXIMISED when you found it and is not any more, put it back before you finish.",
      { title: z.string().describe('a fragment of the window title') },
      async ({ title }) => {
        const res = await desktop.maximizeWindow(title);
        return afterScreen(`Maximised "${res.title}"`);
      }),

    tool('launch_app', 'Start a program by name ("notepad", "calc", "explorer"), open a file path, or open a URL.',
      { target: z.string(), args: z.string().optional() },
      async ({ target, args }) => {
        await desktop.launch(target, args);
        return afterScreen(`Launched ${target}`);
      }),

    tool('run_command', 'Run a PowerShell command and get its output. Faster and more reliable than the GUI for files, settings and lookups.',
      { command: z.string() },
      async ({ command }) => {
        const out = await desktop.runCommand(command);
        return { content: [{ type: 'text', text: out.length > 8000 ? out.slice(0, 8000) + '\n…(truncated)' : out }] };
      }),

    tool('wait', 'Wait a number of seconds for something to load or finish.',
      { seconds: z.number(), display },
      async ({ seconds, display: d }) => {
        await new Promise((r) => setTimeout(r, Math.min(seconds, 30) * 1000));
        return afterScreen(`Waited ${seconds}s`, d);
      }),
  ];

  /* ── the browser ─────────────────────────────────────────────── */

  const browserTools = [
    tool('browser_navigate', 'Open a URL in the agent browser.', { url: z.string() }, async ({ url }) => {
      const p = await page();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return afterWeb(`Navigated to ${url}`);
    }),

    tool('browser_screenshot', 'Screenshot the agent browser viewport (1280x800).', {}, async () => {
      await page();
      const b64 = await browser.snap();
      return { content: [img(b64)] };
    }),

    tool('browser_click_text', 'Click the first visible element in the page containing this text.',
      { text: z.string() }, async ({ text }) => {
        const p = await page();
        await p.getByText(text, { exact: false }).first().click({ timeout: 8000 });
        return afterWeb(`Clicked element with text "${text}"`);
      }),

    tool('browser_type_into', 'Click a field described by its placeholder/label/nearby text, then type.',
      { target: z.string(), text: z.string(), enter: z.boolean().optional() },
      async ({ target, text, enter }) => {
        const p = await page();
        const field = p.getByPlaceholder(target, { exact: false })
          .or(p.getByLabel(target, { exact: false }))
          .or(p.getByRole('textbox', { name: target }))
          .first();
        await field.click({ timeout: 8000 });
        await field.fill(text);
        if (enter) await p.keyboard.press('Enter');
        return afterWeb(`Typed into "${target}"${enter ? ' and pressed Enter' : ''}`);
      }),

    tool('browser_fill_form',
      'Fill a whole form in ONE call — much faster than one field at a time. Give each field by its placeholder/label/nearby text and the value. Set submit to press Enter at the end. Use this whenever you have two or more fields to fill.',
      {
        fields: z.array(z.object({
          target: z.string().describe('placeholder, label or nearby text of the field'),
          text: z.string(),
        })).min(1).max(20),
        submit: z.boolean().optional().describe('press Enter after the last field'),
      },
      async ({ fields, submit }) => {
        const p = await page();
        const filled = [];
        for (const f of fields) {
          const field = p.getByPlaceholder(f.target, { exact: false })
            .or(p.getByLabel(f.target, { exact: false }))
            .or(p.getByRole('textbox', { name: f.target }))
            .first();
          await field.click({ timeout: 8000 });
          await field.fill(f.text);
          filled.push(f.target);
        }
        if (submit) await p.keyboard.press('Enter');
        return afterWeb(`Filled ${filled.length} field(s): ${filled.join(', ')}${submit ? ' and submitted' : ''}`);
      }),

    tool('browser_wait_for',
      'Wait for the page to move on, then carry on. Use this whenever a step is not yours to do — a code the user types on their phone, a QR they scan, an approval they tap, a slow upload or payment. ' +
      'Say in one line what you are waiting for, call this, and continue when it returns. Do NOT end your turn to report that something needs doing; wait for it.',
      {
        until: z.enum(['gone', 'appears', 'url', 'change']).describe('gone: the text disappears. appears: the text shows up. url: the address changes. change: anything changes.'),
        text: z.string().optional().describe('the text to watch, for gone/appears — e.g. "Verify it is you"'),
        seconds: z.number().int().min(3).max(300).optional().describe('how long to wait; 120 by default'),
      },
      async ({ until, text, seconds }) => {
        const res = await browser.waitForChange({ until, text, seconds });
        if (!res.ok) return { content: [{ type: 'text', text: `${res.error} Look at the page and decide what to do.` }] };
        return afterWeb(`Waited ${res.waited}s — ${res.why}`);
      }),

    tool('browser_select',
      'Choose a value from a dropdown — USE THIS FOR EVERY DROPDOWN, never click one open and hunt for the option. ' +
      'A real <select> is drawn by the browser outside the page, so its open list cannot be seen in a screenshot or clicked at coordinates; ' +
      'this sets the value directly instead. For a custom dropdown it opens the list, scrolls the option into view and clicks it. ' +
      'Works no matter how long the list is — years of birth, countries, timezones.',
      {
        field: z.string().describe('the dropdown, by its label, name or nearby text — e.g. "Year", "Country"'),
        option: z.string().describe('the value you want, as shown — e.g. "1994", "Australia"'),
      },
      async ({ field, option }) => {
        const res = await browser.pickOption(field, option);
        if (!res.ok) return { content: [{ type: 'text', text: `${res.error}. Read the page to see what the choices actually are.` }] };
        return afterWeb(`Set "${field}" to "${res.value}"`);
      }),

    tool('browser_click_xy', 'Click pixel coordinates in the browser viewport (0-1280, 0-800). Only for canvas or visual targets the text tools cannot reach.',
      { x: z.number(), y: z.number() }, async ({ x, y }) => {
        const p = await page();
        await p.mouse.click(x, y);
        return afterWeb(`Clicked (${x}, ${y}) in the browser`);
      }),

    tool('browser_read_text', 'Get the visible text of the current page — for reading results, comments, articles.',
      {}, async () => {
        const p = await page();
        const text = (await p.innerText('body')).slice(0, 6000);
        return { content: [{ type: 'text', text: `URL: ${p.url()}\n\n${text}` }] };
      }),

    tool('browser_press_key', 'Press a key in the browser (Enter, Escape, ArrowDown, PageDown…).',
      { key: z.string() }, async ({ key }) => {
        const p = await page();
        await p.keyboard.press(key);
        return afterWeb(`Pressed ${key} in the browser`);
      }),

    tool('browser_scroll', 'Scroll the browser page up or down.',
      { direction: z.enum(['up', 'down']), amount: z.number().optional() },
      async ({ direction, amount }) => {
        const p = await page();
        await p.mouse.wheel(0, (direction === 'down' ? 1 : -1) * (amount || 600));
        return afterWeb(`Scrolled ${direction} in the browser`);
      }),
  ];

  /* ── what it keeps ───────────────────────────────────────────── */

  // Only exists when a bot is running the task — memory is a property of the
  // bot, so there is nowhere to put a note without one.
  const memoryTools = bot ? [
    tool('remember',
      'Keep something you have learned about this user or how they want work done, so you still know it in later chats. For durable facts and preferences only, not details of the task in front of you.',
      { note: z.string().describe('One short sentence, written so it still makes sense months from now.') },
      async ({ note }) => {
        ctx.onEvent({ type: 'remember', text: note });
        return { content: [{ type: 'text', text: `Noted, and you will have it next time: "${note}"` }] };
      }),
  ] : [];

  // Talk to another of the user's bots. The active bot names a teammate and a
  // message; the teammate answers from its own persona and memory, and its
  // reply comes straight back as the tool result to act on.
  const roster = teammates || [];
  // The coding side of the app. A bot can see what coding conversations exist,
  // read one for context, and send one a task — the hand-off between the agent
  // half of Operator and the Claude-Code half.
  const codeTools = hasCodeChats ? [
    tool('list_code_chats', 'List the coding conversations on the Code side, with their project folders.',
      {}, async () => {
        const rows = ctx.codeChats.list();
        if (!rows.length) return { content: [{ type: 'text', text: 'There are no code chats yet.' }] };
        return { content: [{ type: 'text', text: rows.map((c) => `• ${c.title}${c.folder ? '  [' + c.folder + ']' : ''}`).join('\n') }] };
      }),

    tool('read_code_chat', "Read a coding conversation to see what was built or discussed — the user's messages, what the assistant said, and the files and commands it touched.",
      { chat: z.string().describe('The code chat, by title (a fragment is fine) or project folder.') },
      async ({ chat }) => {
        const c = ctx.codeChats.read(chat);
        if (!c) return { content: [{ type: 'text', text: `No code chat matching "${chat}". Use list_code_chats to see them.` }] };
        return { content: [{ type: 'text', text: `Code chat "${c.title}" (${c.folder})\n\n${c.transcript}` }] };
      }),

    tool('message_code_chat', 'Send a task to a coding conversation. The coding assistant does the work in that project folder and its reply comes back to you. Use this to get code written or fixed.',
      { chat: z.string().describe('The code chat, by title or folder.'), message: z.string().describe('What you want it to do.') },
      async ({ chat, message }) => {
        const r = await ctx.codeChats.message(chat, message);
        if (!r || !r.ok) return { content: [{ type: 'text', text: `Could not do that: ${(r && r.error) || 'unknown error'}` }] };
        return { content: [{ type: 'text', text: r.reply || 'Done.' }] };
      }),
  ] : [];

  const teamTools = hasMessageBot ? [
    tool('message_bot',
      "Message another of the user's bots and get its reply. Use it to ask a teammate for something only they hold — an account login, a preference, a status — then carry on with what you were doing.",
      { bot: z.string().describe('The teammate bot to message, by name.'), message: z.string().describe('What to ask them.') },
      async ({ bot: name, message }) => {
        const reply = await ctx.messageBot(name, message);
        return { content: [{ type: 'text', text: `${name} replied:\n${reply}` }] };
      }),
  ] : [];

  // Email connector: real inbox access when the user has connected an account.
  // Reading is free; sending waits for the user to confirm, since a sent mail
  // can't be recalled.
  const emailTools = hasEmail ? [
    tool('get_verification_code',
      'Get the one-time code a service just sent, when signing the user in to an account they already have. ' +
      'Reads a text pushed from their paired phone, or the connected mailbox (see PHONE.md). ' +
      'It WAITS for the code to arrive rather than reporting there is not one yet, so call it straight after the step that triggers the code and carry on when it returns. ' +
      'Do not stop and ask the user for the code — that is what this is for.',
      {
        from: z.string().optional().describe('narrow to a sender or subject, e.g. "google" or "northgate"'),
        within: z.number().int().min(1).max(30).optional().describe('how many minutes back to look; 10 by default'),
        wait: z.number().int().min(0).max(300).optional().describe('seconds to wait for it to arrive; 120 by default, 0 to look once and return'),
      },
      async ({ from, within, wait }) => {
        const seconds = wait === undefined ? 120 : wait;
        const res = seconds > 0
          ? await codes.waitForCode({ email: ctx.email, phone, from, within, timeout: seconds, abortController: ctx.abortController })
          : await codes.findCode({ email: ctx.email, phone, from, within });
        if (!res.ok) return { content: [{ type: 'text', text: res.error }] };
        // The sender is reported so the agent can check the code came from the
        // service it is actually signing in to, rather than typing whatever
        // number turned up.
        return { content: [{ type: 'text', text:
          `Code ${res.code} — ${res.via === 'phone' ? 'texted by' : 'emailed by'} ${res.from}` +
          (res.via === 'email' ? `, "${res.subject}"` : '') +
          (res.age !== null ? `, ${res.age}s ago.` : '.') +
          ' Check that sender is the service you are signing in to before using it.' }] };
      }),

    tool('email_list',
      "List the user's emails, NEWEST FIRST by the date shown — item 1 IS the most recent, so for 'my latest email' read that one.\n" +
      "On Gmail this defaults to the PRIMARY tab, which is what the user means by their inbox. The raw mailbox also holds Promotions and Social (adverts, notifications), which are usually NOT what they are asking about.\n" +
      "Set tab to 'promotions', 'social', 'updates' or 'forums' to look in one of those, or 'all' to see every tab mixed together. Use mailbox to look in another folder (see email_mailboxes).",
      {
        limit: z.number().int().min(1).max(40).optional(),
        unreadOnly: z.boolean().optional(),
        tab: z.enum(['primary', 'promotions', 'social', 'updates', 'forums', 'all']).optional()
          .describe("Gmail tab. Defaults to primary — the user's actual inbox view."),
        mailbox: z.string().optional().describe('Folder to read, e.g. INBOX or [Gmail]/Sent Mail. Defaults to INBOX.'),
      },
      async ({ limit, unreadOnly, tab, mailbox }) => {
        const rows = await ctx.email.list({
          limit: limit || 15, unreadOnly: Boolean(unreadOnly),
          ...(tab ? { tab } : {}), ...(mailbox ? { mailbox } : {}),
        });
        const where = mailbox ? mailbox : (tab && tab !== 'all' ? `the ${tab} tab` : tab === 'all' ? 'every tab' : 'the primary tab');
        if (!rows.length) return { content: [{ type: 'text', text: `No messages in ${where}.` }] };
        const text = rows.map((m, i) =>
          `${i + 1}. ${i === 0 ? '(latest) ' : ''}#${m.uid}  ${m.unread ? '● unread  ' : ''}${m.from}\n   ${m.subject}\n   ${m.date ? new Date(m.date).toLocaleString() : ''}${m.tab ? '   [' + m.tab + ']' : ''}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Newest first, from ${where}:\n\n${text}` }] };
      }),

    tool('email_mailboxes', 'List the folders on the email account (Inbox, Sent, Spam, and any labels), so you can read somewhere other than the inbox.',
      {}, async () => {
        const boxes = await ctx.email.mailboxes({});
        return { content: [{ type: 'text', text: boxes.map((b) => `• ${b.path}${b.special ? '  (' + b.special + ')' : ''}`).join('\n') || '(none)' }] };
      }),

    tool('email_read', 'Read the full text of one email by its number (the #uid from email_list).',
      { uid: z.number().int(), mailbox: z.string().optional() },
      async ({ uid, mailbox }) => {
        const m = await ctx.email.read({ uid, ...(mailbox ? { mailbox } : {}) });
        return { content: [{ type: 'text', text: `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date ? new Date(m.date).toLocaleString() : ''}\n\n${m.body}` }] };
      }),

    tool('email_send',
      "Send an email from the user's connected account. Because a sent email cannot be unsent, tell the user what you are about to send and get their go-ahead first unless they already told you to send it.",
      { to: z.string(), subject: z.string(), body: z.string() },
      async ({ to, subject, body }) => {
        const r = await ctx.email.send({ to, subject, body });
        return { content: [{ type: 'text', text: `Sent to ${r.to}.` }] };
      }),
  ] : [];

  // The local Chromium (browser_* tools) runs on THIS machine. When Operator is
  // driving another computer, that is exactly the wrong place — "open Google"
  // should open on the remote machine. So drop the browser tools entirely in
  // remote mode and let the agent open the remote machine's own browser.
  const where = desktop.target();
  const remote = where.kind === 'remote';
  let tools = remote
    ? [...desktopTools, ...memoryTools, ...teamTools, ...codeTools, ...emailTools]
    : [...desktopTools, ...browserTools, ...memoryTools, ...teamTools, ...codeTools, ...emailTools];

  // A bot is the shared instructions plus who it is and what it has learned.
  let systemPrompt = SYSTEM_PROMPT;

  // textPath:false takes the text way of looking back out — both the tools and
  // the paragraphs that tell the agent to reach for them — so bench.js can run
  // the same task with and without it and time the difference. Nothing else
  // sets this; the app always runs with the text path on.
  if (!textPath) {
    const without = systemPrompt.replace(TEXT_PATH_PROMPT.trimEnd(), '');
    if (without === systemPrompt) throw new Error('textPath:false could not strip TEXT_PATH_PROMPT — the two have drifted apart');
    systemPrompt = without;
  }

  if (roster.length && hasMessageBot) {
    systemPrompt += `

YOUR TEAMMATES — other bots the user has, which you can message with message_bot when you need something only they would hold (an account login, a preference, a status). Message the right one, use the reply, and carry on:
${roster.map((t) => `- ${t.name}${t.title ? ' — ' + t.title : ''}`).join('\n')}`;
  }

  if (hasCodeChats) {
    systemPrompt += `

THE CODE SIDE — this app also has a coding half (a Claude Code style assistant working in real project folders), and you can reach it:
- list_code_chats to see the coding conversations, read_code_chat to catch up on what one of them built or discussed before you answer about it.
- message_code_chat to hand it actual coding work: it does the job in that project's folder and its reply comes back to you. Use it rather than trying to write code through the screen.`;
  }

  if (remote) {
    systemPrompt += `

YOU ARE DRIVING A DIFFERENT COMPUTER — everything happens on it, nothing on the machine running this app.
- Every tool you have (screen_*, screen_do, list_windows, focus_window, launch_app, run_command) acts on that remote machine. The screenshots are its screen; run_command sees its files.
- There is no separate browser tool here. To open a website, use launch_app with the full URL, e.g. launch_app("https://google.com") — it opens in the remote machine's own default browser, on its screen. Then drive it with screen_* like any other window: screenshot, click, type.
- Every action is a network round trip, so plan ahead and batch steps with screen_do.`;
  }

  if (bot) {
    systemPrompt += `

YOU ARE "${bot.name}"${bot.title ? `, ${bot.title}` : ''}. Answer to that name.`;
    if (bot.persona && bot.persona.trim()) {
      systemPrompt += `

HOW THIS USER WANTS YOU TO WORK:
${bot.persona.trim()}`;
    }
    if (bot.memory && bot.memory.length) {
      const notes = bot.memory.slice(0, 60).map((m) => `- ${m.text}`).join(String.fromCharCode(10));
      systemPrompt += `

WHAT YOU HAVE LEARNED SO FAR (yours alone — other bots do not see it):
${notes}`;
    }
    systemPrompt += `

When you learn something durable about this user or how they want work done — a preference, a name, a path, a rule, a correction — call remember to keep it. Do not use it for one-off details from the task at hand.`;
  }

  // Always-on skills: reusable instructions the user switched on for this bot.
  // They apply to every message until switched off.
  if (Array.isArray(alwaysSkills) && alwaysSkills.length) {
    const blocks = alwaysSkills
      .map((s) => `### ${s.title || s.name} (/${s.name})\n${s.prompt}`)
      .join(String.fromCharCode(10, 10));
    systemPrompt += `

SKILLS THAT ARE ALWAYS ON — follow these on every task:

${blocks}`;
  }

  // A short index of the user's own skills, so the agent knows which /commands
  // exist and never claims a skill is missing or lists unrelated ones.
  if (Array.isArray(skillIndex) && skillIndex.length) {
    const lines = skillIndex.map((s) => `- /${s.name}${s.title ? ` — ${s.title}` : ''}`).join(String.fromCharCode(10));
    systemPrompt += `

THE USER'S SKILLS (their own; invoked by typing /name in the chat, or switched on per bot). These are the ONLY skills that exist here — do not mention any others:
${lines}`;
  }

  // Rehearsal mode. The interception above is what actually makes this safe;
  // this only tells the agent what it is seeing so it plans the whole job
  // instead of stopping at the first step that "failed".
  if (dryRun) {
    systemPrompt += `

YOU ARE REHEARSING (DRY RUN). Nothing you do can change anything. Looking is real — screenshots, page text, listing windows and reading email all work normally — but every action that would click, type, run a command, open an app, remember something or send a message is intercepted and recorded as a plan step instead.
- Work through the WHOLE task in order, exactly as you would for real, so the plan is complete.
- When a step comes back marked DRY RUN, that is expected. Treat it as having succeeded and move straight on to the next step.
- Keep grounding yourself as you go: look before each step, as usual.
- Finish with a short plain-English summary of what you WOULD have done, and name anything you would need from the user to do it for real. Never claim you actually did it.`;
  }


  // Has to happen before the MCP server is built below and before the NIM
  // branch: allowedTools alone does not do it, because bypassPermissions means
  // the model may call anything the server actually registered.
  if (!textPath) {
    const n = tools.length;
    tools = tools.filter((t) => t.name !== 'screen_read' && t.name !== 'screen_click_text');
    if (tools.length !== n - 2) throw new Error('textPath:false expected to remove exactly 2 tools');
  }

  // An unknown id from the renderer falls back rather than failing the task.
  const chosen = isModel(model) ? model : DEFAULT_MODEL;

  // A model from NVIDIA NIM takes the same tools and the same prompt through
  // plain chat-completions, and emits the same events — everything above this
  // line is shared, so the two brains always have identical hands.
  if (nim.isNimModel(chosen)) {
    return {
      nim: true,
      run: (text, task) => {
        ctx.onEvent = task.onEvent || (() => {});
        ctx.abortController = task.abortController;
        ctx.dryRun = Boolean(task.dryRun);
        return nim.runTask({
          prompt: text, model: chosen, systemPrompt, tools,
          onEvent: ctx.onEvent, abortController: ctx.abortController, resume,
          params: tuning,
        });
      },
      close() {},
    };
  }

  const computerServer = createSdkMcpServer({ name: 'computer', version: '2.0.0', tools });
  const allowedTools = tools.map((t) => `mcp__computer__${t.name}`);

  // Messages are pushed in rather than passed once, which is what keeps the
  // session — and its already-started subprocess — alive between tasks.
  const inbox = makeInbox();

  let dead = false;
  const stream = query({
    prompt: inbox.iterator,
    options: {
      model: chosen,
      systemPrompt,
      mcpServers: { computer: computerServer },
      // Only our own tools exist — no Bash/Read/Edit/ToolSearch from the SDK.
      // This keeps them directly available (never deferred behind ToolSearch,
      // which is what made the packaged app stall after one step) and means
      // everything the agent does to the machine goes through this file.
      tools: [],
      allowedTools,
      // Stream the reply as it is written instead of waiting for the whole turn.
      includePartialMessages: true,
      // Carry on the chat's existing session so it remembers what was said.
      ...(resume ? { resume } : {}),
      settingSources: [],
      // Turn OFF every filesystem skill. Omitting this is NOT "skills off" — the
      // SDK would otherwise surface the user's Claude Code skills (~/.claude/skills
      // like findify, align…) inside Operator, which confused the agent into
      // talking about skills that have nothing to do with it. Operator's own
      // skills are injected into the system prompt above, not through the SDK.
      skills: [],
      // Effort and thinking, as set with the dial beside the model picker
      // (model-options.js). Effort defaults to 'low' on this side, and that is
      // the single biggest thing that makes driving a screen feel slow or not:
      // the model's own default is 'high' — deep reasoning — and it runs before
      // EVERY click, keystroke and screenshot, in a loop that is perception plus
      // a short decision, repeated. Turn it up when a task genuinely needs care.
      ...tuning,
      permissionMode: 'bypassPermissions',
      maxTurns: 150,
    },
  });

  const it = stream[Symbol.asyncIterator]();

  // Pulling the stream before a message has been pushed does NOT pre-start the
  // subprocess — tried, and the SDK hangs then dies with "ProcessTransport is
  // not ready for writing". The boot happens on the first real message and
  // cannot be moved off it, which is why there is no warm-up call here: the
  // saving comes from not throwing the session away afterwards.

  // The SDK says the same sentence up to three times: once as deltas, once as
  // the finished assistant message, and once more in the result. Remember what
  // has already reached the screen and let only the first copy through.
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  // One task. Swaps in this task's context, pushes the message, and reads the
  // session until that task's result comes back — then stops, leaving the
  // session open for the next one.
  async function run(text, task) {
    ctx.onEvent = task.onEvent || (() => {});
    ctx.abortController = task.abortController;
    ctx.dryRun = Boolean(task.dryRun);
    if (task.messageBot) ctx.messageBot = task.messageBot;
    if (task.codeChats) ctx.codeChats = task.codeChats;
    if (task.email) ctx.email = task.email;
    const onEvent = ctx.onEvent;
    const abortController = ctx.abortController;

    // Sentence de-duplication is per task: the SDK repeats a closing line, but
    // only within the turn that produced it.
    const said = new Set();
    let open = null;
    let reported = false;

    inbox.push(text);

    // Stepped by hand, not with `for await`: breaking out of a for-await calls
    // .return() on the iterator, which closes the stream — and closing it is
    // exactly what this session exists to avoid. Pulling messages one at a time
    // lets a task stop at its own result and leave the session running.
    while (true) {
      const next = await it.next();
      if (next.done) { dead = true; break; }
      const message = next.value;

      if (abortController?.signal.aborted) break;
      if (process.env.OPERATOR_TRACE) {
        const ev = message.type === 'stream_event'
          ? '/' + message.event?.type + (message.event?.content_block ? ':' + message.event.content_block.type : '')
          : '';
        let extra = '';
        if (message.type === 'assistant') extra = JSON.stringify(message.message.content.map((b) => b.type + (b.type === 'text' ? ':' + b.text.slice(0, 30) : '')));
        if (message.type === 'result') extra = JSON.stringify(String(message.result || '').slice(0, 40));
        require('fs').appendFileSync(process.env.OPERATOR_TRACE, `[sdk] ${message.type}${ev} ${message.subtype || ''} ${extra}
  `);
      }

      // Every frame carries it; the first one is enough.
      if (message.session_id && !reported) {
        reported = true;
        onEvent({ type: 'session', id: message.session_id });
      }

      // ── the reply, token by token ──────────────────────────────────
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id) continue; // a subagent, not the main reply
        const ev = message.event;

        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'text') {
          open = '';
          onEvent({ type: 'say_start' });
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && open !== null) {
          open += ev.delta.text;
          onEvent({ type: 'say_delta', text: ev.delta.text });
        } else if (ev.type === 'content_block_stop' && open !== null) {
          const whole = open;
          open = null;
          if (norm(whole)) said.add(norm(whole));
          onEvent({ type: 'say_end', text: whole });
        }
        continue;
      }

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            const key = norm(block.text);

            // This message routinely overtakes the stream's own content_block_stop,
            // so "have I said this already?" is not enough — a block still open is
            // this same text mid-flight. Close that bubble with the finished text
            // rather than starting a second one under it.
            if (open !== null) {
              open = null;
              said.add(key);
              onEvent({ type: 'say_end', text: block.text });
              continue;
            }

            if (said.has(key)) continue;
            said.add(key);
            onEvent({ type: 'assistant', text: block.text });
          } else if (block.type === 'tool_use') {
            onEvent({ type: 'tool', name: block.name.replace('mcp__computer__', ''), input: block.input });
          }
        }
      } else if (message.type === 'result') {
        const text = message.subtype === 'success'
          ? (message.result || '')
          : `Stopped: ${message.subtype}`;

        // What the turn actually cost. Reported so bench.js can attack the right
        // thing, and so a cost meter has something real to show later.
        const u = message.usage || {};
        onEvent({ type: 'usage',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cost: message.total_cost_usd || 0,
          turns: message.num_turns || 0,
          apiMs: message.duration_api_ms || 0 });

        // On success this repeats the closing sentence — end the run silently.
        const repeat = message.subtype === 'success' && said.has(norm(text));
        onEvent({ type: 'done', text: repeat || !norm(text) ? null : text });
      }
  
      if (message.type === 'result') break;
    }
  }

  return {
    run,
    get dead() { return dead; },
    close() {
      inbox.close();
      try { stream.interrupt && stream.interrupt(); } catch { /* already gone */ }
    },
  };
}



// A queue the SDK reads from. Pushing into it is how a task reaches a session
// that is already open, instead of starting a new one.
function makeInbox() {
  const queue = [];
  let wake = null;
  let closed = false;
  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };

  const iterator = (async function* () {
    while (!closed) {
      if (!queue.length) { await new Promise((r) => { wake = r; }); continue; }
      const content = queue.shift();
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
    }
  })();

  return {
    iterator,
    push: (content) => { queue.push(content); nudge(); },
    close: () => { closed = true; nudge(); },
  };
}

// The one session currently open. Everything baked into it at creation — the
// model, the tools, the system prompt, the conversation it belongs to — is in
// the key, so a task that needs anything different gets a fresh one.
let live = null;

function sessionKey(o) {
  return JSON.stringify([
    o.model || DEFAULT_MODEL,
    o.bot ? o.bot.id : null,
    o.chatId || null,
    Boolean(o.dryRun),
    Boolean(o.textPath),
    // Which tools exist is baked in at build time, so a session warmed without
    // them must not be handed to a task that needs them.
    o.hasMessageBot !== undefined ? o.hasMessageBot : Boolean(o.messageBot),
    o.hasCodeChats !== undefined ? o.hasCodeChats : Boolean(o.codeChats),
    o.hasEmail !== undefined ? o.hasEmail : Boolean(o.email),
    desktop.target().kind,
    (o.alwaysSkills || []).map((s) => s.id || s.name),
    (o.teammates || []).map((t) => t.name),
    (o.skillIndex || []).map((s) => s.name),
    // Effort and thinking are fixed when a session starts, so changing them on
    // the dial has to start a new one.
    o.tuning || {},
  ]);
}

// Close the open session, if any. Safe to call when there isn't one.
function closeSession() {
  if (!live) return;
  try { live.session.close(); } catch { /* already gone */ }
  live = null;
}

async function runTask(prompt, opts) {
  // The dial's settings for the model that will actually run — the same
  // fallback createSession applies — as SDK options or NVIDIA request fields.
  // `opts.modelOptions` is this side's saved map, model id → values.
  const chosen = isModel(opts.model) ? opts.model : DEFAULT_MODEL;
  const saved = (opts.modelOptions || {})[chosen];
  opts.tuning = nim.isNimModel(chosen)
    ? modelOptions.nimParams('agents', chosen, saved)
    : modelOptions.sdkOptions('agents', chosen, saved);

  const key = sessionKey(opts);

  // Reuse the open session when nothing that shaped it has changed. This is
  // the whole point: it skips ~3.2s of subprocess start.
  if (!live || live.key !== key || live.session.dead) {
    closeSession();
    live = { key, session: await createSession(opts) };
  }

  // Stopping a task has to stop the session with it: a per-task AbortController
  // cannot be handed to a query that was created before the task existed.
  const onAbort = () => closeSession();
  opts.abortController?.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await live.session.run(withActiveSkill(prompt, opts.activeSkill), {
      onEvent: opts.onEvent,
      abortController: opts.abortController,
      dryRun: opts.dryRun,
      // The session may have been warmed before these existed; hand it this
      // task's own, so the tools it already registered call the right things.
      messageBot: opts.messageBot,
      codeChats: opts.codeChats,
      email: opts.email,
    });
  } catch (err) {
    // A broken session must not be handed to the next task.
    closeSession();
    throw err;
  } finally {
    opts.abortController?.signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { runTask, askBot, closeSession, MODELS, CLAUDE_MODELS, listModels, DEFAULT_MODEL, isClaudeModel, nim };
