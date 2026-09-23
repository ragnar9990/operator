// voice.js — the brain behind hands-free mode.
//
// This is NOT the agent in agent.js. That one drives the computer — mouse,
// keyboard, browser, shell. This one drives *Operator itself*: it makes
// agents, names them, writes their personas, files them into workspaces, reads
// back what one of them said, and hands real work to whichever agent should do
// it. You talk, it arranges things, and the agents do the work.
//
// Two rules shape everything below:
//
//   FAST. A voice assistant that thinks for seven seconds is not one. The SDK
//   pays ~7s of subprocess start per query, so the session is opened once and
//   messages are pushed into it — the same trick agent.js plays — which makes
//   every turn after the first cost about ten milliseconds to reach the model.
//   The reply is streamed, and each finished sentence is handed to the voice
//   the moment it lands rather than at the end of the turn.
//
//   SMALL ANSWERS. Every word it says has to be listened to in real time. A
//   paragraph that reads fine on screen is unbearable out loud, so the prompt
//   is blunt about length and the tools return short summaries, not dumps.

const { z } = require('zod');

// Haiku, and not as a compromise. This is routing and short decisions over a
// list of names — the work a bigger model would do better is not the work being
// asked for here, and every extra second is dead air.
const VOICE_MODEL = 'claude-haiku-4-5';

const PROMPT = `You are Operator's voice. The user is TALKING to you, hands-free, and hearing your reply read aloud.

YOU RUN THE APP, NOT THE COMPUTER. Operator holds a set of agents. Each agent is one conversation with its own name, face, persona and memory, and each can drive this Windows PC. You do not touch the computer yourself — you arrange the agents and hand work to them.

HOW TO TALK:
- ONE OR TWO SENTENCES. This is speech. Nobody can skim it.
- Say what you did, not what you are about to do: "Made it" beats "I'll go ahead and create that for you now". Do not open with "Right" or "On it" — the app has already said that out loud by the time you answer.
- No lists, no markdown, no headings, no emoji, no file paths, no ids. If you must name several things, say at most three and then "and four others".
- Never read a transcript out word for word. Say what it amounts to.
- Don't ask permission for things you can simply do. Do it, then say it is done.
- If you genuinely could not tell what was said, ask for the one missing thing in a short question.

WHICH AGENT THEY MEAN:
- Each turn tells you which agent is on screen. When the user says "it", "this one", "remember that", or gives no name at all, they mean that one. Use it; do not guess at several and do not ask which.
- When they do name one, match it loosely — people say "the invoices one", not the exact name.

WHAT YOU CAN DO:
- Make agents, rename them, give them a title, a persona, a model, or pin them to the top of the rail.
- Make workspaces, rename them, and file agents into them. A workspace is a folder in the list — it does not wall anything off, so never say it does.
- Read back what an agent said with read_agent, and say what it amounts to. Any question about what an agent SAID, FOUND, or DID is read_agent — list_agents only tells you which agents exist, and answering from its one-line preview gets you half the story.
- Hand a task to an agent with send_to_agent. That agent then really does it on this computer, in the background. Say you have set it going; do not pretend to wait for it or invent a result. The user can ask you later what it said.

PASSING WORK BETWEEN AGENTS — this is what copy and paste is for:
- When one agent has written something another one needs, do NOT retype it from memory and do NOT summarise it. Call copy_from_agent on the one that wrote it, then send_to_agent on the one that needs it with paste set to true. That hands over the exact words.
- "Make another agent and give it that prompt" means: make the agent, copy_from_agent from the one that wrote the prompt, then send_to_agent with paste true. Three calls, no paraphrasing.
- It goes on the real Windows clipboard too, so "copy that" alone is a perfectly good request and Ctrl+V will work anywhere afterwards.

CHOOSING WHO DOES THE WORK:
- If the user asks for something to be DONE on the computer — open an app, tidy files, look something up, write an email — that is send_to_agent, not something you refuse. Pick the agent whose name or persona fits. If none fits, make one with a fitting name and send the task to that.
- If the user says "you" and means the app ("make me a workspace"), that is yours to do directly.

DELETING IS THE ONE THING YOU CHECK FIRST. Before deleting an agent or a workspace, say what you are about to delete and wait for a yes. Speech gets misheard, and there is no undo. Everything else, just do it.

Be brief, be warm, and get on with it.`;

/* ── the message queue that keeps one session alive ─────────────────
   Identical in shape to the one in agent.js, and for the same reason: pushing
   a message into an open query costs milliseconds, opening a new one costs
   seconds. */
function makeInbox() {
  const queue = [];
  let wake = null;
  let closed = false;
  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };

  const iterator = (async function* () {
    while (!closed) {
      if (!queue.length) { await new Promise((r) => { wake = r; }); continue; }
      yield { type: 'user', message: { role: 'user', content: queue.shift() }, parent_tool_use_id: null, session_id: '' };
    }
  })();

  return { iterator, push: (c) => { queue.push(c); nudge(); }, close: () => { closed = true; nudge(); } };
}

// Everything that actually touches the app is handed in by main.js, so this
// file never reaches for Electron or the store and can be reasoned about on
// its own. See `app` in main.js's voice wiring for the other half.
let live = null;

async function openSession(app) {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

  const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });

  const tools = [
    tool('list_agents', 'Every agent, with its role, workspace and the last thing it said. Use this before acting on an agent by name so you use the real name.',
      {}, async () => text(await app.listAgents())),

    tool('read_agent', 'What an agent has been saying: the last few turns of its conversation. Summarise it out loud — never read it back word for word.',
      { name: z.string().describe('the agent, by name'), turns: z.number().optional().describe('how many recent turns, default 6') },
      async ({ name, turns }) => text(await app.readAgent(name, turns || 6))),

    tool('make_agent', 'Create a new agent. It gets its own conversation, persona and memory.',
      {
        name: z.string().describe('short, what it is for — "Invoices", "Holiday research"'),
        title: z.string().optional().describe('one line on what it does'),
        persona: z.string().optional().describe('how it should always work — tone, rules, accounts, what never to touch'),
        workspace: z.string().optional().describe('file it into this workspace by name'),
        pinned: z.boolean().optional().describe('pin it to the top of the rail'),
        role: z.enum(['coordinator', 'main']).optional().describe('the badge a pinned agent wears; a label only'),
      },
      async (a) => text(await app.makeAgent(a))),

    tool('configure_agent', 'Change an existing agent: its name, title, persona, model, whether it is pinned, or which workspace it sits in. Only pass what is changing.',
      {
        name: z.string().describe('the agent to change, by its current name'),
        newName: z.string().optional(),
        title: z.string().optional(),
        persona: z.string().optional(),
        model: z.string().optional().describe('a model name the user asked for, e.g. "opus" or "haiku"'),
        pinned: z.boolean().optional(),
        role: z.enum(['coordinator', 'main']).optional(),
        workspace: z.string().optional().describe('workspace name, or "none" to take it out of one'),
      },
      async (a) => text(await app.configureAgent(a))),

    tool('remember_for_agent', 'Give an agent a note it keeps for good — a preference, an account, a rule.',
      { name: z.string(), note: z.string() },
      async ({ name, note }) => text(await app.rememberFor(name, note))),

    tool('delete_agent', 'Delete an agent and its conversation. There is no undo — say what you are deleting and get a yes before calling this.',
      { name: z.string() },
      async ({ name }) => text(await app.deleteAgent(name))),

    tool('open_agent', 'Put an agent on screen, so the user is looking at the conversation being discussed.',
      { name: z.string() },
      async ({ name }) => text(await app.openAgent(name))),

    tool('list_workspaces', 'The workspaces and how many agents are in each.',
      {}, async () => text(await app.listWorkspaces())),

    tool('make_workspace', 'Create a workspace — a named folder agents can be filed into.',
      { name: z.string() },
      async ({ name }) => text(await app.makeWorkspace(name))),

    tool('rename_workspace', 'Rename a workspace.',
      { name: z.string().describe('its current name'), newName: z.string() },
      async ({ name, newName }) => text(await app.renameWorkspace(name, newName))),

    tool('delete_workspace', 'Delete a workspace. The agents in it are kept and go back to the main list. Get a yes first.',
      { name: z.string() },
      async ({ name }) => text(await app.deleteWorkspace(name))),

    tool('file_agent', 'Put an agent into a workspace, or take it out.',
      { name: z.string().describe('the agent'), workspace: z.string().describe('the workspace, or "none" to take it out') },
      async ({ name, workspace }) => text(await app.fileAgent(name, workspace))),

    tool('send_to_agent', 'Hand a real task to an agent. It starts doing it on this computer straight away, in the background. This returns as soon as it has started — it does not wait for the work to finish, so never report a result you have not read back.',
      {
        name: z.string().describe('which agent does it'),
        task: z.string().describe('the task in plain English, as you would type it to that agent'),
        paste: z.boolean().optional().describe('append whatever was last copied to the end of the task, word for word — use this to give one agent what another wrote'),
      },
      async ({ name, task, paste }) => text(await app.sendToAgent(name, task, paste))),

    tool('copy_from_agent', "Copy an agent's last reply, in full and word for word, onto the clipboard. Use this when one agent has written something — a prompt, a draft, a list — that another agent needs, or that the user wants to paste somewhere themselves. It goes on the real Windows clipboard, so Ctrl+V works anywhere.",
      { name: z.string().describe('the agent whose last reply to copy') },
      async ({ name }) => text(await app.copyFromAgent(name))),

    tool('copy_text', 'Put some text on the Windows clipboard yourself, so the user can paste it anywhere.',
      { content: z.string() },
      async ({ content }) => text(await app.copyText(content))),

    tool('read_clipboard', 'What is on the clipboard right now. Say what it is, not the whole of it.',
      {}, async () => text(await app.readClipboard())),
  ];

  const server = createSdkMcpServer({ name: 'app', version: '1.0.0', tools });
  const inbox = makeInbox();
  let dead = false;

  const stream = query({
    prompt: inbox.iterator,
    options: {
      model: VOICE_MODEL,
      systemPrompt: PROMPT,
      mcpServers: { app: server },
      tools: [],
      allowedTools: tools.map((t) => `mcp__app__${t.name}`),
      includePartialMessages: true,
      settingSources: [],
      skills: [],
      // Minimal thinking. This is "which agent, which tool, what do I say" —
      // deliberation here is pure latency, and latency is the whole game.
      effort: 'low',
      permissionMode: 'bypassPermissions',
      maxTurns: 24,
    },
  });

  const it = stream[Symbol.asyncIterator]();

  // One thing said. Streams the reply, and pushes each finished SENTENCE out as
  // soon as it lands so the voice starts talking while the rest is still being
  // written. Waiting for the whole turn would add a second or two of silence to
  // every single answer.
  async function ask(said, onEvent, context) {
    // The agent on screen rides along with each turn rather than sitting in the
    // system prompt, because it changes between one utterance and the next.
    inbox.push(context ? `[${context}]
${said}` : said);

    let pending = '';
    let whole = '';
    let spoke = false;

    // A sentence ends at .?! — followed by a space, OR straight into the next
    // capital. That second case is not pedantry: text resumed after a tool call
    // often arrives with no leading space, and splitting on whitespace alone
    // glues "…first." and "Done." into a single breathless line.
    const flush = (force) => {
      const parts = pending.split(/(?<=[.!?…])(?=\s|["'“‘(]?[A-Z])/);
      const tail = force ? '' : parts.pop();
      for (const p of parts) {
        const s = p.trim();
        if (s) { onEvent({ type: 'say', text: s }); spoke = true; }
      }
      pending = force ? '' : tail;
      if (force && pending.trim()) { onEvent({ type: 'say', text: pending.trim() }); spoke = true; }
    };

    while (true) {
      const next = await it.next();
      if (next.done) { dead = true; break; }
      const m = next.value;

      if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          pending += ev.delta.text;
          whole += ev.delta.text;
          onEvent({ type: 'delta', text: ev.delta.text });
          flush(false);
        }
        continue;
      }

      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') onEvent({ type: 'tool', name: String(b.name).replace('mcp__app__', ''), input: b.input });
          // Text that never arrived as deltas still has to be said.
          else if (b.type === 'text' && b.text && !whole.trim()) { whole = b.text; pending = b.text; }
        }
      } else if (m.type === 'result') {
        if (!whole.trim() && m.result) { whole = m.result; pending = m.result; }
        flush(true);
        onEvent({ type: 'done', text: whole.trim(), cost: m.total_cost_usd || 0 });
        break;
      }
    }

    // A turn that said nothing at all leaves the user listening to silence.
    if (!spoke && !whole.trim()) onEvent({ type: 'say', text: 'Done.' });
    return whole.trim();
  }

  return { ask, get dead() { return dead; }, close() { inbox.close(); try { stream.interrupt && stream.interrupt(); } catch { /* gone */ } } };
}

// Opening the session is the slow part, so it happens once and survives between
// utterances. Turning voice mode on warms it before the first word.
async function warm(app) {
  if (live && !live.dead) return live;
  live = await openSession(app);
  return live;
}

async function heard(text, app, onEvent, context) {
  const s = await warm(app);
  try {
    return await s.ask(text, onEvent, context);
  } catch (err) {
    // A broken session must not be handed the next utterance.
    close();
    throw err;
  }
}

function close() {
  if (!live) return;
  try { live.close(); } catch { /* already gone */ }
  live = null;
}

module.exports = { heard, warm, close, VOICE_MODEL, PROMPT };
