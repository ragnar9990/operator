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

const SYSTEM_PROMPT = `You are Operator. You run on the user's own Windows PC and you can actually use it — the whole machine, not just a browser.

FIRST, decide what kind of message this is:
- If the user is just talking — a greeting, small talk, a thank-you, or a question you can answer from your own knowledge — reply in plain text. Do NOT take a screenshot or call any tools.
- Only start acting when they ask you to DO something. If you are unsure what they want, ask one short clarifying question first.

WHEN YOU ACT, pick the right set of hands:

1. Anything on the web — searching, a site, a form, a video, an account — use the browser_* tools. They drive a dedicated Chromium window and are far more reliable than clicking pixels: browser_click_text and browser_type_into name the element. Reach for these first for web work.
   SPEED — this matters a lot:
   - Every browser action already returns the page as text, so you can read results, field names and links without a separate step. Do NOT call browser_read_text or browser_screenshot after an action just to "see" — you already have the page. Only screenshot when you genuinely need to see pixels (a canvas, an image, an odd layout).
   - Fill forms with ONE browser_fill_form call listing every field, not one browser_type_into per field. Set submit:true to send it in the same call.
   - Chain: navigate, then fill_form with submit — a whole "go to the site and fill it in" is often just two calls.

2. Anything else on the computer — desktop apps, Explorer, settings, games, installers, local files, or a browser the user already has open — use the screen_* tools. This is real mouse and keyboard on the real desktop.

USING THE SCREEN:
- Start with screen_screenshot to see what is there. Never click coordinates you have not just seen on a screenshot.
- Screenshots come back per display, scaled: display 1 is the primary monitor. Every shot reports which display it is and how many exist — don't ask for one outside that range. The image dimensions are reported too, and click/move/drag coordinates use that exact same space, so a button at (300, 480) in the image is clicked at (300, 480). Pass the same "display" number you took the shot from.
- list_windows is usually the fastest way to find something: it tells you every open window, which monitor's coordinates it sits at, and what has focus. Use it before screenshotting every monitor in turn. focus_window brings one to the front — always focus a window before sending it keystrokes.
- Clicks, drags, scrolls and key presses return a fresh screenshot — look at it before the next step. Typing and plain mouse moves do not, to save time; screenshot yourself if you need to check them.
- SPEED MATTERS MORE THAN ANYTHING ELSE HERE. Every separate tool call costs the user seconds of waiting, while the actions themselves take milliseconds. The waiting is almost entirely you, not the computer.
- So plan two or three moves ahead and send them as ONE screen_do. Clicking a field, typing into it and pressing Enter is one screen_do with three steps, not three calls. Opening a menu and picking an item is one screen_do. Only fall back to single tools when you genuinely cannot predict the next step without looking.
- Don't re-look at a screen you have already seen and have not changed, and don't screenshot every monitor when list_windows would tell you where something is.
- Prefer run_command outright when the job is really a file or settings job. Moving twenty files is one command; it is twenty minutes of clicking.
- launch_app opens a program by name ("notepad", "calc", "explorer"), a file path, or a URL.
- run_command runs PowerShell and gives you its output. Use it when the shell is genuinely faster or more reliable than clicking — reading a folder, checking a setting, moving files, finding an install path. Prefer it over hunting through GUI dialogs.

SIGNING IN:
- Your browser keeps its profile, so a site you log into once stays logged in. Check whether you are already signed in before assuming you are not.
- If a sign-in page refuses you, shows "this browser or app may not be secure", loops back to the login form, or demands a code from a phone you do not have, STOP trying to force it in your own browser. Two better moves, in order:
  1. The user almost certainly has that account open in their own browser already. Use list_windows and the screen_* tools to work in their real Chrome or Edge window instead of yours. It is signed in, it is trusted by the site, and it is the same thing they would do.
  2. If neither browser is signed in, ask the user to log in themselves rather than handling their password. Say which site and why. Never type a password you were not explicitly handed for that purpose, and never try to create an account that needs phone or identity verification.
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

async function runTask(prompt, { userDataDir, onEvent, abortController, model, resume, bot, teammates, messageBot, codeChats, email, alwaysSkills, activeSkill, skillIndex }) {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

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
          action: z.enum(['click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'wait', 'focus']),
          x: z.number().optional(),
          y: z.number().optional(),
          text: z.string().optional().describe('For type.'),
          keys: z.string().optional().describe('For key, e.g. "ctrl+a", "enter".'),
          direction: z.enum(['up', 'down', 'left', 'right']).optional(),
          amount: z.number().optional(),
          seconds: z.number().optional().describe('For wait.'),
          title: z.string().optional().describe('For focus: part of a window title.'),
        })).min(1).max(12),
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
        return afterScreen(`Did: ${done.join(' → ')}`, d);
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

    tool('list_windows', 'List the open windows with their titles, positions and sizes, and say which one has focus.',
      {}, async () => {
        const res = await desktop.listWindows();
        const rows = res.windows
          .map((w) => `• ${w.title}  [${w.width}x${w.height} at ${w.left},${w.top}]`)
          .join('\n');
        return { content: [{ type: 'text', text: `Foreground: ${res.foreground}\n\nOpen windows:\n${rows}` }] };
      }),

    tool('focus_window', 'Bring a window to the front by a fragment of its title. Do this before typing into an app.',
      { title: z.string() }, async ({ title }) => {
        const res = await desktop.focusWindow(title);
        return afterScreen(`Focused "${res.title}"`);
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
        onEvent({ type: 'remember', text: note });
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
  const codeTools = codeChats ? [
    tool('list_code_chats', 'List the coding conversations on the Code side, with their project folders.',
      {}, async () => {
        const rows = codeChats.list();
        if (!rows.length) return { content: [{ type: 'text', text: 'There are no code chats yet.' }] };
        return { content: [{ type: 'text', text: rows.map((c) => `• ${c.title}${c.folder ? '  [' + c.folder + ']' : ''}`).join('\n') }] };
      }),

    tool('read_code_chat', "Read a coding conversation to see what was built or discussed — the user's messages, what the assistant said, and the files and commands it touched.",
      { chat: z.string().describe('The code chat, by title (a fragment is fine) or project folder.') },
      async ({ chat }) => {
        const c = codeChats.read(chat);
        if (!c) return { content: [{ type: 'text', text: `No code chat matching "${chat}". Use list_code_chats to see them.` }] };
        return { content: [{ type: 'text', text: `Code chat "${c.title}" (${c.folder})\n\n${c.transcript}` }] };
      }),

    tool('message_code_chat', 'Send a task to a coding conversation. The coding assistant does the work in that project folder and its reply comes back to you. Use this to get code written or fixed.',
      { chat: z.string().describe('The code chat, by title or folder.'), message: z.string().describe('What you want it to do.') },
      async ({ chat, message }) => {
        const r = await codeChats.message(chat, message);
        if (!r || !r.ok) return { content: [{ type: 'text', text: `Could not do that: ${(r && r.error) || 'unknown error'}` }] };
        return { content: [{ type: 'text', text: r.reply || 'Done.' }] };
      }),
  ] : [];

  const teamTools = messageBot ? [
    tool('message_bot',
      "Message another of the user's bots and get its reply. Use it to ask a teammate for something only they hold — an account login, a preference, a status — then carry on with what you were doing.",
      { bot: z.string().describe('The teammate bot to message, by name.'), message: z.string().describe('What to ask them.') },
      async ({ bot: name, message }) => {
        const reply = await messageBot(name, message);
        return { content: [{ type: 'text', text: `${name} replied:\n${reply}` }] };
      }),
  ] : [];

  // Email connector: real inbox access when the user has connected an account.
  // Reading is free; sending waits for the user to confirm, since a sent mail
  // can't be recalled.
  const emailTools = email ? [
    tool('email_list',
      "List recent emails from the user's connected inbox, NEWEST FIRST — the first item is the most recent email, so for 'the latest email' use that one. Use unreadOnly to see only unread.",
      { limit: z.number().int().min(1).max(40).optional(), unreadOnly: z.boolean().optional() },
      async ({ limit, unreadOnly }) => {
        const rows = await email.list({ limit: limit || 15, unreadOnly: Boolean(unreadOnly) });
        if (!rows.length) return { content: [{ type: 'text', text: 'No messages found.' }] };
        const text = rows.map((m, i) =>
          `${i + 1}. ${i === 0 ? '(latest) ' : ''}#${m.uid}  ${m.unread ? '● unread  ' : ''}${m.from}\n   ${m.subject}\n   ${m.date ? new Date(m.date).toLocaleString() : ''}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Newest first:\n\n${text}` }] };
      }),

    tool('email_read', 'Read the full text of one email by its number (uid from email_list).',
      { uid: z.number().int() },
      async ({ uid }) => {
        const m = await email.read({ uid });
        return { content: [{ type: 'text', text: `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date ? new Date(m.date).toLocaleString() : ''}\n\n${m.body}` }] };
      }),

    tool('email_send',
      "Send an email from the user's connected account. Because a sent email cannot be unsent, tell the user what you are about to send and get their go-ahead first unless they already told you to send it.",
      { to: z.string(), subject: z.string(), body: z.string() },
      async ({ to, subject, body }) => {
        const r = await email.send({ to, subject, body });
        return { content: [{ type: 'text', text: `Sent to ${r.to}.` }] };
      }),
  ] : [];

  // The local Chromium (browser_* tools) runs on THIS machine. When Operator is
  // driving another computer, that is exactly the wrong place — "open Google"
  // should open on the remote machine. So drop the browser tools entirely in
  // remote mode and let the agent open the remote machine's own browser.
  const where = desktop.target();
  const remote = where.kind === 'remote';
  const tools = remote
    ? [...desktopTools, ...memoryTools, ...teamTools, ...codeTools, ...emailTools]
    : [...desktopTools, ...browserTools, ...memoryTools, ...teamTools, ...codeTools, ...emailTools];

  // A bot is the shared instructions plus who it is and what it has learned.
  let systemPrompt = SYSTEM_PROMPT;

  if (roster.length && messageBot) {
    systemPrompt += `

YOUR TEAMMATES — other bots the user has, which you can message with message_bot when you need something only they would hold (an account login, a preference, a status). Message the right one, use the reply, and carry on:
${roster.map((t) => `- ${t.name}${t.title ? ' — ' + t.title : ''}`).join('\n')}`;
  }

  if (codeChats) {
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

  // A one-off skill the user invoked for THIS message with /name. It takes
  // priority: it is what they are asking you to do right now.
  if (activeSkill && activeSkill.prompt) {
    systemPrompt += `

THE USER INVOKED THE "${activeSkill.title || activeSkill.name}" SKILL (/${activeSkill.name}) FOR THIS MESSAGE. Follow it now, applying it to what they wrote:

${activeSkill.prompt}`;
  }

  // An unknown id from the renderer falls back rather than failing the task.
  const chosen = isModel(model) ? model : DEFAULT_MODEL;

  // A model from NVIDIA NIM takes the same tools and the same prompt through
  // plain chat-completions, and emits the same events — everything above this
  // line is shared, so the two brains always have identical hands.
  if (nim.isNimModel(chosen)) {
    return nim.runTask({
      prompt, model: chosen, systemPrompt, tools, onEvent, abortController, resume,
    });
  }

  const computerServer = createSdkMcpServer({ name: 'computer', version: '2.0.0', tools });
  const allowedTools = tools.map((t) => `mcp__computer__${t.name}`);

  const stream = query({
    prompt,
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
      permissionMode: 'bypassPermissions',
      maxTurns: 150,
      abortController,
    },
  });

  // The SDK says the same sentence up to three times: once as deltas, once as
  // the finished assistant message, and once more in the result. Remember what
  // has already reached the screen and let only the first copy through.
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const said = new Set();
  let open = null; // the text block currently streaming
  let reported = false;

  for await (const message of stream) {
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

      // On success this repeats the closing sentence — end the run silently.
      const repeat = message.subtype === 'success' && said.has(norm(text));
      onEvent({ type: 'done', text: repeat || !norm(text) ? null : text });
    }
  }
}

module.exports = { runTask, askBot, MODELS, CLAUDE_MODELS, listModels, DEFAULT_MODEL, isClaudeModel, nim };
