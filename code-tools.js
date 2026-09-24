// code-tools.js — a codebase in the shape of tools, for models that do not
// come with one.
//
// The Claude side of the coding assistant gets Claude Code's own built-in
// Read/Write/Edit/Bash/Grep/Glob for free, because it runs on the Agent SDK.
// A model on NVIDIA NIM gets nothing but chat-completions, so the same six
// tools are built here in plain Node and handed to it instead. Same names,
// same arguments, so the transcript in the UI reads identically whichever
// model did the work.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { z } = require('zod');

const MAX_READ = 60000;        // characters handed back from one file
const MAX_OUTPUT = 20000;      // characters from a command or a search
const MAX_MATCHES = 200;
const COMMAND_MS = 120000;

// Folders nobody means when they say "search the project".
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'venv', '__pycache__', '.venv']);

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });

/* ── staying inside the project ──────────────────────────────────────
   Every path is resolved against the chat's folder, and anything that
   escapes it is refused. The shell can still go anywhere — that is what a
   shell is — but the file tools should not wander off by accident. */

function inside(cwd, p) {
  const root = path.resolve(cwd);
  const full = path.resolve(root, String(p || ''));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

// Relative when it is in the project, absolute when it is somewhere the user
// pointed it at — "../../Desktop/x" helps nobody.
const show = (cwd, full) => {
  const rel = path.relative(path.resolve(cwd), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return full;
  return rel.replace(/\\/g, '/') || '.';
};

/* ── globbing, without a dependency ───────────────────────────────── */

// "src/**/*.{ts,tsx}" -> a regex. Enough of glob to be useful: ** across
// folders, * within a name, ? for one character, {a,b} alternatives.
function globToRegExp(pattern) {
  let out = '';
  const src = String(pattern).replace(/\\/g, '/');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') { out += '.*'; i++; if (src[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'i');
}

async function walk(root, onFile, { limit = 20000 } = {}) {
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (++seen > limit) return;
        if ((await onFile(full)) === false) return;
      }
    }
  }
}

// A file worth grepping: text, and not enormous.
async function readable(full) {
  try {
    const st = await fsp.stat(full);
    if (st.size > 2_000_000) return null;
    const buf = await fsp.readFile(full);
    if (buf.includes(0)) return null;          // binary
    return buf.toString('utf8');
  } catch { return null; }
}

/* ── the shell ───────────────────────────────────────────────────── */

function runCommand(command, cwd, signal) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true })
      : spawn('/bin/sh', ['-c', command], { cwd });

    let out = '';
    let killed = false;
    let stopped = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, COMMAND_MS);

    // Pressing Stop should end a five-minute build, not wait politely for it.
    // On Windows the child spawns its own tree, so take the tree with it.
    const onStop = () => {
      stopped = true;
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch (_) { try { child.kill(); } catch (__) {} }
    };
    if (signal) {
      if (signal.aborted) onStop();
      else signal.addEventListener('abort', onStop, { once: true });
    }

    const take = (buf) => { if (out.length < MAX_OUTPUT) out += buf.toString(); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const cleanUp = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onStop);
    };

    child.on('error', (err) => { cleanUp(); resolve(`Could not run that: ${err.message}`); });
    child.on('close', (code) => {
      cleanUp();
      if (stopped) return resolve('Stopped.');
      const body = out.slice(0, MAX_OUTPUT) + (out.length > MAX_OUTPUT ? '\n… (output truncated)' : '');
      if (killed) return resolve(`Timed out after ${COMMAND_MS / 1000}s.\n${body}`);
      resolve(body.trim() ? `${body}${code ? `\n(exit code ${code})` : ''}` : (code ? `(no output, exit code ${code})` : '(no output)'));
    });
  });
}

/* ── the toolset ─────────────────────────────────────────────────── */

// `reach` is every other folder the file tools may touch: the ones the user
// dragged into the chat, and their home folder, so "put it on my desktop"
// works the way it does for Claude. Relative paths still mean the project.
function buildCodeTools(cwd, reach = []) {
  const root = path.resolve(cwd);
  const roots = [root, ...reach.filter(Boolean).map((r) => path.resolve(r))];
  // Shadows the module-level check: inside the project OR any reachable root.
  const inside = (_root, p) => {
    const full = path.resolve(root, String(p || ''));
    for (const r of roots) {
      const rel = path.relative(r, full);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return full;
    }
    return null;
  };

  const refuse = (p) => text(`"${p}" is outside the folders this chat can reach. Work inside ${root}, or ask the user to drag the folder into the chat.`);

  return [
    {
      name: 'Read',
      description: 'Read a file from the project. Returns its contents with line numbers. Always read a file before editing it.',
      inputSchema: {
        file_path: z.string().describe('Path to the file, relative to the project folder.'),
        offset: z.number().int().optional().describe('First line to read (1-based).'),
        limit: z.number().int().optional().describe('How many lines to read.'),
      },
      handler: async ({ file_path, offset, limit }) => {
        const full = inside(root, file_path);
        if (!full) return refuse(file_path);
        let body;
        try { body = await fsp.readFile(full, 'utf8'); }
        catch (err) { return text(err.code === 'ENOENT' ? `There is no file at ${file_path}.` : `Could not read ${file_path}: ${err.message}`); }

        const lines = body.split('\n');
        const from = Math.max(1, offset || 1);
        const to = Math.min(lines.length, from + (limit || 2000) - 1);
        const numbered = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n');
        const head = `${show(root, full)} — ${lines.length} lines${to < lines.length || from > 1 ? `, showing ${from}-${to}` : ''}`;
        return text(`${head}\n${numbered.slice(0, MAX_READ)}${numbered.length > MAX_READ ? '\n… (truncated)' : ''}`);
      },
    },

    {
      name: 'Write',
      description: 'Write a whole file, creating it and any folders it needs. Overwrites what is there — use Edit to change part of an existing file.',
      inputSchema: {
        file_path: z.string().describe('Path to the file, relative to the project folder.'),
        content: z.string().describe('The complete contents of the file.'),
      },
      handler: async ({ file_path, content }) => {
        const full = inside(root, file_path);
        if (!full) return refuse(file_path);
        try {
          await fsp.mkdir(path.dirname(full), { recursive: true });
          const existed = fs.existsSync(full);
          await fsp.writeFile(full, content ?? '', 'utf8');
          const n = String(content || '').split('\n').length;
          return text(`${existed ? 'Rewrote' : 'Created'} ${show(root, full)} (${n} lines).`);
        } catch (err) {
          return text(`Could not write ${file_path}: ${err.message}`);
        }
      },
    },

    {
      name: 'Edit',
      description: 'Replace an exact piece of text in a file. The text to find must appear exactly once unless replace_all is set. Read the file first so the text matches.',
      inputSchema: {
        file_path: z.string(),
        old_string: z.string().describe('The exact text to find, including its indentation.'),
        new_string: z.string().describe('What to put in its place.'),
        replace_all: z.boolean().optional(),
      },
      handler: async ({ file_path, old_string, new_string, replace_all }) => {
        const full = inside(root, file_path);
        if (!full) return refuse(file_path);
        let body;
        try { body = await fsp.readFile(full, 'utf8'); }
        catch (err) { return text(`Could not read ${file_path}: ${err.message}`); }

        if (old_string === new_string) return text('The old and new text are identical — nothing to do.');

        const count = body.split(old_string).length - 1;
        if (count === 0) {
          return text(`That text is not in ${show(root, full)}. Read the file again and copy the exact text, including indentation.`);
        }
        if (count > 1 && !replace_all) {
          return text(`That text appears ${count} times in ${show(root, full)}. Include more surrounding lines to make it unique, or set replace_all.`);
        }
        const next = replace_all ? body.split(old_string).join(new_string) : body.replace(old_string, new_string);
        try { await fsp.writeFile(full, next, 'utf8'); }
        catch (err) { return text(`Could not write ${file_path}: ${err.message}`); }
        return text(`Edited ${show(root, full)}${count > 1 ? ` (${count} places)` : ''}.`);
      },
    },

    {
      name: 'Bash',
      description: process.platform === 'win32'
        ? 'Run a PowerShell command in the project folder and get its output. This is Windows: use PowerShell syntax, not bash.'
        : 'Run a shell command in the project folder and get its output.',
      inputSchema: {
        command: z.string().describe('The command to run.'),
        description: z.string().optional().describe('A few words on what it is for.'),
      },
      handler: async ({ command }, extra) => text(await runCommand(command, root, extra && extra.signal)),
    },

    {
      name: 'Grep',
      description: 'Search the project for a regular expression and get the matching lines with their files and line numbers.',
      inputSchema: {
        pattern: z.string().describe('A regular expression.'),
        path: z.string().optional().describe('A sub-folder to search in.'),
        glob: z.string().optional().describe('Only search files matching this, e.g. "*.js".'),
        '-i': z.boolean().optional().describe('Ignore case.'),
      },
      handler: async (args) => {
        const where = args.path ? inside(root, args.path) : root;
        if (!where) return refuse(args.path);

        let re;
        try { re = new RegExp(args.pattern, args['-i'] ? 'i' : ''); }
        catch (err) { return text(`That is not a valid regular expression: ${err.message}`); }

        const only = args.glob ? globToRegExp(args.glob.includes('/') ? args.glob : `**/${args.glob}`) : null;
        const hits = [];

        await walk(where, async (full) => {
          const rel = show(root, full);
          if (only && !only.test(rel) && !only.test(path.basename(full))) return;
          const body = await readable(full);
          if (body === null) return;
          const lines = body.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= MAX_MATCHES) return false;
          }
        });

        if (!hits.length) return text(`Nothing matches /${args.pattern}/${args.glob ? ` in ${args.glob}` : ''}.`);
        return text(`${hits.length}${hits.length >= MAX_MATCHES ? '+' : ''} matches:\n${hits.join('\n').slice(0, MAX_OUTPUT)}`);
      },
    },

    {
      name: 'Glob',
      description: 'Find files by name pattern, e.g. "**/*.ts" or "src/**/index.*". Use this to see what is in the project before reading.',
      inputSchema: {
        pattern: z.string().describe('A glob pattern, relative to the project folder.'),
        path: z.string().optional().describe('A sub-folder to look in.'),
      },
      handler: async ({ pattern, path: sub }) => {
        const where = sub ? inside(root, sub) : root;
        if (!where) return refuse(sub);
        const re = globToRegExp(pattern);
        const found = [];
        await walk(where, async (full) => {
          const rel = show(root, full);
          if (re.test(rel) || re.test(path.basename(full))) found.push(rel);
          if (found.length >= 400) return false;
        });
        if (!found.length) return text(`No files match ${pattern}.`);
        return text(`${found.length} file${found.length === 1 ? '' : 's'}:\n${found.sort().join('\n').slice(0, MAX_OUTPUT)}`);
      },
    },

    {
      name: 'LS',
      description: 'List what is in a folder — the fastest way to get your bearings in an unfamiliar project.',
      inputSchema: { path: z.string().optional().describe('The folder, relative to the project. Defaults to the project root.') },
      handler: async ({ path: sub }) => {
        const where = inside(root, sub || '.');
        if (!where) return refuse(sub);
        let entries;
        try { entries = await fsp.readdir(where, { withFileTypes: true }); }
        catch (err) { return text(`Could not list ${sub || '.'}: ${err.message}`); }
        if (!entries.length) return text(`${show(root, where)} is empty.`);
        const rows = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => (a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1));
        return text(`${show(root, where)}:\n${rows.join('\n').slice(0, MAX_OUTPUT)}`);
      },
    },
  ];
}

module.exports = { buildCodeTools, globToRegExp };
