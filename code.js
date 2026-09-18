// code.js — the coding side of Operator. Same engine as Claude Code: the Agent
// SDK with its full built-in toolset (Read, Write, Edit, Bash, Grep, Glob, …),
// pointed at a project folder. Where agent.js sandboxes the model to a browser
// and a screen, this hands it a real codebase.
//
// A model from NVIDIA NIM can code here too. It cannot borrow Claude Code's
// tools — it only has chat-completions — so it gets the same six tools rebuilt
// in plain Node (code-tools.js), under the same names, and runs through the
// same loop as the agent side. The transcript looks identical either way.

const path = require('path');
const nim = require('./nim');
const { buildCodeTools } = require('./code-tools');

const CODE_SYSTEM = `You are Operator's coding assistant. You work exactly like Claude Code: you have the user's real files, a shell, and search, all rooted at the current working folder. Be decisive and finish the task.

WHEN THE USER ASKS YOU TO BUILD SOMETHING NEW (e.g. "make Tetris", "build a landing page", "write a script that…"):
- Just build it. Do NOT search the disk for an existing folder or file by that name — it almost never exists, and hunting for it wastes turns and looks broken.
- Create a new sub-folder named for the project (e.g. "tetris") inside the current folder and put the project there. Scaffold a complete, working starting point — real files with real, finished content, not stubs or TODOs.
- For a browser game, tool, or web page, a single self-contained index.html with inline CSS and JS that runs just by opening it is usually best, unless the user asked for a specific stack.
- When it's built, say the exact path and how to run it (e.g. "open tetris/index.html in your browser").

WHEN THE USER ASKS YOU TO CHANGE EXISTING CODE:
- Read the relevant files first, match the surrounding style, and grep to confirm an API before you use it. Prefer editing existing files over adding new ones.

ALWAYS:
- Work in small, verified steps and keep going until the task is genuinely done — don't hand back half-finished work.
- Run the project's own tools (build, tests, the file in a browser) to check your work when you can.
- Explain what you did in a sentence or two. No walls of text, and never leave "// TODO: implement" where the real thing belongs.`;

// When one of the user's bots is attached to a code chat, it codes as that bot:
// its name, how the user wants it to work, and what it has learned all carry
// over, so a bot with house style or project knowledge writes in that voice.
function systemFor(bot) {
  if (!bot) return CODE_SYSTEM;
  let s = CODE_SYSTEM + `

YOU ARE "${bot.name}"${bot.title ? `, ${bot.title}` : ''}. Answer to that name while you code.`;
  if (bot.persona && bot.persona.trim()) s += `

HOW THIS USER WANTS YOU TO WORK:
${bot.persona.trim()}`;
  if (bot.memory && bot.memory.length) {
    const notes = bot.memory.slice(0, 60).map((m) => '- ' + m.text).join(String.fromCharCode(10));
    s += `

WHAT YOU ALREADY KNOW:
${notes}`;
  }
  return s;
}

// What a NIM model needs spelled out that Claude Code already knows: which
// tools exist, where it is, and that "the folder" is a real place on Windows.
function nimSystemFor(bot, cwd) {
  return `${systemFor(bot)}

YOUR TOOLS. You have exactly these, and they all work inside ${cwd}:
- LS(path?) — list a folder. Start here when you do not know what is in the project.
- Glob(pattern) — find files by name, e.g. "**/*.js".
- Grep(pattern, glob?) — search file contents, with line numbers.
- Read(file_path) — read a file. ALWAYS read a file before you edit it, so your old_string matches exactly.
- Write(file_path, content) — write a whole file, creating folders as needed.
- Edit(file_path, old_string, new_string) — replace an exact piece of text. The text must match the file character for character, indentation included.
- Bash(command) — run ${process.platform === 'win32' ? 'a PowerShell command (this is Windows — PowerShell syntax, not bash)' : 'a shell command'} in the project folder.

Paths are relative to the project folder. Do not try to reach outside it with the file tools.
Call tools rather than describing what you would do, and keep going until the task is finished. When you are done, say in one or two sentences what you changed and how to run it.`;
}

async function runCode(prompt, { cwd, onEvent, abortController, resume, model, bot }) {
  // A NIM model takes the same job through chat-completions, with the toolset
  // built here instead of borrowed from the SDK.
  if (nim.isNimModel(model)) {
    return nim.runTask({
      prompt,
      model,
      systemPrompt: nimSystemFor(bot, cwd),
      tools: buildCodeTools(cwd),
      onEvent: (evt) => onEvent(evt.type === 'tool' ? { ...evt, input: summarizeInput(evt.name, evt.input) } : evt),
      abortController,
      resume,
      maxTurns: 120,
    });
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const stream = query({
    prompt,
    options: {
      cwd,
      model: model || undefined,
      systemPrompt: systemFor(bot),
      // The whole Claude Code toolset — files, shell, search — in this folder.
      tools: { type: 'preset', preset: 'claude_code' },
      // Load the project's CLAUDE.md and settings, the way Claude Code does.
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      // Stream the reply token by token, so you watch it narrate what it is
      // doing the way Claude Code does, instead of the text landing in one lump.
      includePartialMessages: true,
      maxTurns: 200,
      resume,
      abortController,
    },
  });

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const said = new Set();
  let open = null;   // text of the reply block currently streaming

  for await (const message of stream) {
    if (abortController?.signal.aborted) break;

    if (message.session_id) onEvent({ type: 'session', id: message.session_id });

    // ── the narration, token by token ──
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) continue;
      const ev = message.event;
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'text') {
        open = '';
        onEvent({ type: 'say_start' });
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && open !== null) {
        open += ev.delta.text;
        onEvent({ type: 'say_delta', text: ev.delta.text });
      } else if (ev.type === 'content_block_stop' && open !== null) {
        const whole = open; open = null;
        if (norm(whole)) said.add(norm(whole));
        onEvent({ type: 'say_end', text: whole });
      }
      continue;
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          const key = norm(block.text);
          if (open !== null) { open = null; said.add(key); onEvent({ type: 'say_end', text: block.text }); continue; }
          if (said.has(key)) continue;
          said.add(key);
          onEvent({ type: 'assistant', text: block.text });
        } else if (block.type === 'tool_use') {
          onEvent({ type: 'tool', name: block.name, input: summarizeInput(block.name, block.input) });
        }
      }
    } else if (message.type === 'user') {
      // Tool results — surface errors, quietly ignore the rest.
      for (const block of message.message.content || []) {
        if (block.type === 'tool_result' && block.is_error) {
          const t = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : String(block.content || '');
          onEvent({ type: 'tool_error', text: t.slice(0, 300) });
        }
      }
    } else if (message.type === 'result') {
      const text = message.subtype === 'success' ? (message.result || '') : `Stopped: ${message.subtype}`;
      const repeat = message.subtype === 'success' && said.has(norm(text));
      onEvent({ type: 'done', text: repeat || !norm(text) ? null : text });
    }
  }
}

// Keep tool inputs small and readable for the UI — a path and a snippet, not a
// whole file's worth of new content.
function summarizeInput(name, input) {
  const i = input || {};
  const short = (s, n = 80) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  switch (name) {
    case 'Read': return { file: relish(i.file_path) };
    case 'Write': return { file: relish(i.file_path) };
    case 'Edit': return { file: relish(i.file_path), find: short(i.old_string, 40) };
    case 'Bash': return { command: short(i.command, 120) };
    case 'Grep': return { pattern: short(i.pattern, 60), path: relish(i.path) };
    case 'Glob': return { pattern: short(i.pattern, 60) };
    default: return typeof i === 'object' ? Object.fromEntries(Object.entries(i).slice(0, 3).map(([k, v]) => [k, short(v, 60)])) : {};
  }
}

function relish(p) {
  if (!p) return '';
  return path.basename(String(p));
}

module.exports = { runCode };
