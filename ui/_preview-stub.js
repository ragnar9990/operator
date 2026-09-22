// Dev-only harness: fakes the Electron preload and the microphone so the front
// end can be driven in an ordinary browser. Mirrors store.js closely enough to
// exercise the real code paths. Excluded from the packaged app.

(function () {
  const listeners = { agent: [], voice: [], bots: [] };
  const emit = (e) => listeners.agent.forEach((cb) => cb(e));
  window.emit = emit;

  const KEY = 'preview.bots';
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);

  const SHAPES = ['squircle', 'round', 'dome', 'shield'];
  const ACCESSORIES = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
  const HUES = [199, 262, 152, 24, 341, 44, 288, 174];

  function faceFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return { hue: HUES[h % HUES.length], shape: SHAPES[(h >> 3) % SHAPES.length], accessory: ACCESSORIES[(h >> 6) % ACCESSORIES.length] };
  }

  function blank(name, title) {
    const id = uid('b');
    return { id, name, title: title || '', face: faceFor(id + name), persona: '', model: null, memory: [], skills: [], routines: [], chats: [], updatedAt: Date.now() };
  }

  function load() {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY));
      if (Array.isArray(v) && v.length) return v;
    } catch { /* fall through */ }
    return [blank('Operator', 'Runs this computer')];
  }
  function put(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* fine */ } }

  // Whether the fake NVIDIA key is saved, for the Models settings tab.
  let NVIDIA = { configured: false, hint: '' };
  const NVIDIA_PROGRESS = [];

  // Code chats, and which of them are mid-run — a Set, because more than one
  // can be, which is the thing worth exercising.
  let CODE = [
    { id: 'cc1', title: 'Tetris', cwd: 'C:/demo/tetris', cwdName: 'tetris', model: null, botId: null, turns: [] },
    { id: 'cc2', title: 'Landing page', cwd: 'C:/demo/site', cwdName: 'site', model: null, botId: null, turns: [] },
  ];
  const CODE_RUNS = new Set();
  const CODE_LISTENERS = [];

  let BOTS = load();
  put(BOTS);

  const find = (id) => BOTS.find((b) => b.id === id);
  const lastLine = (b) => {
    const c = b.chats[0];
    if (!c || !c.turns.length) return '';
    for (let i = c.turns.length - 1; i >= 0; i--) {
      const t = c.turns[i];
      if (t.k === 'says' || t.k === 'you') return String(t.text).replace(/\s+/g, ' ').slice(0, 90);
    }
    return '';
  };
  const card = (b) => ({
    id: b.id, name: b.name, title: b.title, face: b.face, model: b.model, persona: b.persona,
    memoryCount: b.memory.length, routineCount: b.routines.filter((r) => !r.paused).length,
    skillCount: b.skills.length, updatedAt: b.updatedAt, lastLine: lastLine(b),
  });
  const sync = () => put(BOTS);


/* A week of agent history for the Audit panel. Values here are already redacted,
   the same way the real log stores them. */
const AUDIT = (() => {
  const steps = [
    ['browser_fill_form', 'fill 2 field(s) and submit', true, 412, null, false, 'agent'],
    ['browser_type_into', 'type "[redacted]" into "Password"', true, 90, null, false, 'agent'],
    ['browser_navigate', 'go to portal.supplier.com', true, 1340, null, false, 'agent'],
    ['run_command', 'run: Get-ChildItem "D:/Invoices" -Filter *.pdf', true, 88, null, false, 'agent'],
    ['email_send', 'email accounts@supplier.com — "Invoice 4471 query"', false, 1500, 'SMTP server refused the connection', false, 'agent'],
    ['screen_click', 'click "Save" at (812, 460)', true, 30, null, true, 'agent'],
    ['launch_app', 'open Excel', true, 2210, null, false, 'agent'],
    ['browser_read_text', 'read the page', true, 260, null, false, 'agent'],
    ['screen_type', 'type "Q3 reconciliation"', true, 140, null, false, 'agent'],
    ['remember', 'remember "supplier portal logs out after 10 min"', true, 4, null, false, 'agent'],
    ['Edit', 'Edit', null, null, null, false, 'code'],
    ['Bash', 'Bash', null, null, null, false, 'code'],
  ];
  const out = [];
  for (let i = 0; i < 46; i++) {
    const [tool, text, ok, ms, error, dryRun, mode] = steps[i % steps.length];
    const bot = i % 3 === 0 ? ['b2', 'Ops'] : ['b1', 'Nim'];
    out.push({
      t: new Date(Date.now() - i * 37 * 60 * 1000).toISOString(),
      botId: bot[0], botName: bot[1], chatId: 'c1', taskId: '2f1c44de-9a01-4f2b-8c30-71ab',
      mode, tool, text,
      args: tool === 'browser_type_into'
        ? { target: 'Password', text: '[redacted 11 chars sha256:08ca0d4a]' }
        : { note: 'sample arguments' },
      ok, error: error || null, ms,
      computer: i % 5 === 0 ? 'remote http://100.66.223.8:8391' : 'private desktop',
      model: 'claude-opus-5', dryRun,
    });
  }
  return out;
})();

const PHONE = { on: false, port: 8392, token: 'Qx7pL2mNv8RtYw3z',
                addresses: ['192.168.20.2', '100.123.254.56'], waiting: 0, lastSeen: null };

  window.operator = {
    runTask: async (prompt, model, botId, chatId) => { scriptReply(prompt, botId, chatId); return { ok: true }; },
    stopTask: async () => ({ ok: true }),
    onEvent: (cb) => listeners.agent.push(cb),
    onBotsChanged: (cb) => listeners.bots.push(cb),

    openBrowser: async () => ({ ok: true, chrome: true }),

    // A snapshot of a real NIM catalog, so the picker's grouping, search and
    // locked rows can be exercised without a key. NVIDIA_KEY below flips
    // between the connected and not-connected states.
    listModels: async () => ({
      current: 'claude-sonnet-5',
      nvidia: NVIDIA,
      models: [
        { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'The most capable, and the slowest' , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-opus-5', name: 'Opus 5', note: 'Deep reasoning, for work that needs care' , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5', note: 'Quick enough to drive a screen', best: true , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', note: 'Fastest, for short repetitive jobs' , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-fable-5', name: 'Fable 5', note: 'Previous generation', older: true , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-opus-4-8', name: 'Opus 4.8', note: 'Previous generation', older: true , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-opus-4-7', name: 'Opus 4.7', note: 'Previous generation', older: true , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-opus-4-6', name: 'Opus 4.6', note: 'Previous generation', older: true , providerName: 'Claude', vendor: 'claude' },
        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', note: 'Previous generation', older: true , providerName: 'Claude', vendor: 'claude' },
        {"id":"nim:nvidia/cosmos-reason2-8b","name":"Cosmos Reason2 8B","note":"nvidia/cosmos-reason2-8b","tags":["sees the screen"],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/ising-calibration-1.5-31b","name":"Ising Calibration 1.5 31B","note":"nvidia/ising-calibration-1.5-31b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/llama3-chatqa-1.5-70b","name":"Llama 3 ChatQA 1.5 70B","note":"nvidia/llama3-chatqa-1.5-70b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/llama-3.1-nemotron-51b-instruct","name":"Llama 3.1 Nemotron 51B Instruct","note":"nvidia/llama-3.1-nemotron-51b-instruct","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/llama-3.1-nemotron-70b-instruct","name":"Llama 3.1 Nemotron 70B Instruct","note":"nvidia/llama-3.1-nemotron-70b-instruct","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/llama-3.1-nemotron-ultra-253b-v1","name":"Llama 3.1 Nemotron Ultra 253B v1","note":"nvidia/llama-3.1-nemotron-ultra-253b-v1","tags":["reasoning"],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/mistral-nemo-minitron-8b-8k-instruct","name":"Mistral Nemo Minitron 8B 8k Instruct","note":"nvidia/mistral-nemo-minitron-8b-8k-instruct","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","name":"Nemotron 3 Nano Omni 30B A3B Reasoning","note":"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","tags":["sees the screen","reasoning"],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-3-super-120b-a12b","name":"Nemotron 3 Super 120B A12B","note":"nvidia/nemotron-3-super-120b-a12b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-3-ultra-550b-a55b","name":"Nemotron 3 Ultra 550B A55B","note":"nvidia/nemotron-3-ultra-550b-a55b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-3.5-lightning-30b-a3b","name":"Nemotron 3.5 Lightning 30B A3B","note":"nvidia/nemotron-3.5-lightning-30b-a3b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-4-340b-instruct","name":"Nemotron 4 340B Instruct","note":"nvidia/nemotron-4-340b-instruct","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/nemotron-nano-3-30b-a3b","name":"Nemotron Nano 3 30B A3B","note":"nvidia/nemotron-nano-3-30b-a3b","tags":[],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/neva-22b","name":"NeVA 22B","note":"nvidia/neva-22b","tags":["sees the screen","no tool calling"],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:nvidia/vila","name":"VILA","note":"nvidia/vila","tags":["sees the screen","no tool calling"],"providerName":"NVIDIA","vendor":"nvidia"},
        {"id":"nim:meta/codellama-70b","name":"Code Llama 70B","note":"meta/codellama-70b","tags":["code","no tool calling"],"providerName":"Meta","vendor":"nvidia"},
        {"id":"nim:meta/llama2-70b","name":"Llama 2 70B","note":"meta/llama2-70b","tags":["no tool calling"],"providerName":"Meta","vendor":"nvidia"},
        {"id":"nim:meta/llama-3.2-11b-vision-instruct","name":"Llama 3.2 11B Vision Instruct","note":"meta/llama-3.2-11b-vision-instruct","tags":["sees the screen"],"providerName":"Meta","vendor":"nvidia"},
        {"id":"nim:meta/llama-3.2-90b-vision-instruct","name":"Llama 3.2 90B Vision Instruct","note":"meta/llama-3.2-90b-vision-instruct","tags":["sees the screen"],"providerName":"Meta","vendor":"nvidia"},
        {"id":"nim:meta/muse-glimmer-30b","name":"Muse Glimmer 30B","note":"meta/muse-glimmer-30b","tags":[],"providerName":"Meta","vendor":"nvidia"},
        {"id":"nim:openai/gpt-oss-20b","name":"GPT OSS 20B","note":"openai/gpt-oss-20b","tags":[],"providerName":"OpenAI","vendor":"nvidia"},
        {"id":"nim:google/codegemma-1.1-7b","name":"CodeGemma 1.1 7B","note":"google/codegemma-1.1-7b","tags":["code","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/codegemma-7b","name":"CodeGemma 7B","note":"google/codegemma-7b","tags":["code","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/deplot","name":"DePlot","note":"google/deplot","tags":["sees the screen","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/gemma-2b","name":"Gemma 2B","note":"google/gemma-2b","tags":["no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/gemma-3-12b-it","name":"Gemma 3 12B IT","note":"google/gemma-3-12b-it","tags":["sees the screen","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/gemma-3-4b-it","name":"Gemma 3 4B IT","note":"google/gemma-3-4b-it","tags":["sees the screen","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/gemma-4-31b-it","name":"Gemma 4 31B IT","note":"google/gemma-4-31b-it","tags":["sees the screen","no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:google/recurrentgemma-2b","name":"RecurrentGemma 2B","note":"google/recurrentgemma-2b","tags":["no tool calling"],"providerName":"Google","vendor":"nvidia"},
        {"id":"nim:deepseek-ai/deepseek-coder-6.7b-instruct","name":"DeepSeek Coder 6.7B Instruct","note":"deepseek-ai/deepseek-coder-6.7b-instruct","tags":["code"],"providerName":"DeepSeek","vendor":"nvidia"},
        {"id":"nim:deepseek-ai/deepseek-v4-flash-0731","name":"DeepSeek v4 Flash 0731","note":"deepseek-ai/deepseek-v4-flash-0731","tags":[],"providerName":"DeepSeek","vendor":"nvidia"},
        {"id":"nim:mistralai/codestral-22b-instruct-v0.1","name":"Codestral 22B Instruct v0.1","note":"mistralai/codestral-22b-instruct-v0.1","tags":["code"],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:mistralai/mistral-7b-instruct-v0.3","name":"Mistral 7B Instruct v0.3","note":"mistralai/mistral-7b-instruct-v0.3","tags":[],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:mistralai/mistral-large","name":"Mistral Large","note":"mistralai/mistral-large","tags":[],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:mistralai/mistral-large-2-instruct","name":"Mistral Large 2 Instruct","note":"mistralai/mistral-large-2-instruct","tags":[],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:mistralai/mistral-nemotron","name":"Mistral Nemotron","note":"mistralai/mistral-nemotron","tags":[],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:mistralai/mixtral-8x22b-v0.1","name":"Mixtral 8x22B v0.1","note":"mistralai/mixtral-8x22b-v0.1","tags":[],"providerName":"Mistral AI","vendor":"nvidia"},
        {"id":"nim:nv-mistralai/mistral-nemo-12b-instruct","name":"Mistral Nemo 12B Instruct","note":"nv-mistralai/mistral-nemo-12b-instruct","tags":[],"providerName":"NVIDIA × Mistral","vendor":"nvidia"},
        {"id":"nim:moonshotai/kimi-k2.6","name":"Kimi K2.6","note":"moonshotai/kimi-k2.6","tags":[],"providerName":"Moonshot AI","vendor":"nvidia"},
        {"id":"nim:moonshotai/kimi-k3","name":"Kimi K3","note":"moonshotai/kimi-k3","tags":[],"providerName":"Moonshot AI","vendor":"nvidia"},
        {"id":"nim:z-ai/glm-5.3","name":"GLM 5.3","note":"z-ai/glm-5.3","tags":[],"providerName":"Z.ai","vendor":"nvidia"},
        {"id":"nim:z-ai/glm-5.3-flash","name":"GLM 5.3 Flash","note":"z-ai/glm-5.3-flash","tags":[],"providerName":"Z.ai","vendor":"nvidia"},
        {"id":"nim:microsoft/kosmos-2","name":"Kosmos 2","note":"microsoft/kosmos-2","tags":["sees the screen","no tool calling"],"providerName":"Microsoft","vendor":"nvidia"},
        {"id":"nim:microsoft/phi-3-vision-128k-instruct","name":"Phi 3 Vision 128k Instruct","note":"microsoft/phi-3-vision-128k-instruct","tags":["sees the screen","no tool calling"],"providerName":"Microsoft","vendor":"nvidia"},
        {"id":"nim:microsoft/phi-3.5-moe-instruct","name":"Phi 3.5 MoE Instruct","note":"microsoft/phi-3.5-moe-instruct","tags":["no tool calling"],"providerName":"Microsoft","vendor":"nvidia"},
        {"id":"nim:ibm/granite-3.0-3b-a800m-instruct","name":"Granite 3.0 3B A800M Instruct","note":"ibm/granite-3.0-3b-a800m-instruct","tags":[],"providerName":"IBM","vendor":"nvidia"},
        {"id":"nim:ibm/granite-3.0-8b-instruct","name":"Granite 3.0 8B Instruct","note":"ibm/granite-3.0-8b-instruct","tags":[],"providerName":"IBM","vendor":"nvidia"},
        {"id":"nim:ibm/granite-34b-code-instruct","name":"Granite 34B Code Instruct","note":"ibm/granite-34b-code-instruct","tags":["code"],"providerName":"IBM","vendor":"nvidia"},
        {"id":"nim:ibm/granite-8b-code-instruct","name":"Granite 8B Code Instruct","note":"ibm/granite-8b-code-instruct","tags":["code"],"providerName":"IBM","vendor":"nvidia"},
        {"id":"nim:writer/palmyra-creative-122b","name":"Palmyra Creative 122B","note":"writer/palmyra-creative-122b","tags":["no tool calling"],"providerName":"Writer","vendor":"nvidia"},
        {"id":"nim:writer/palmyra-fin-70b-32k","name":"Palmyra Fin 70B 32k","note":"writer/palmyra-fin-70b-32k","tags":["no tool calling"],"providerName":"Writer","vendor":"nvidia"},
        {"id":"nim:writer/palmyra-med-70b","name":"Palmyra Med 70B","note":"writer/palmyra-med-70b","tags":["no tool calling"],"providerName":"Writer","vendor":"nvidia"},
        {"id":"nim:writer/palmyra-med-70b-32k","name":"Palmyra Med 70B 32k","note":"writer/palmyra-med-70b-32k","tags":["no tool calling"],"providerName":"Writer","vendor":"nvidia"},
        {"id":"nim:01-ai/yi-large","name":"Yi Large","note":"01-ai/yi-large","tags":["no tool calling"],"providerName":"01.AI","vendor":"nvidia"},
        {"id":"nim:adept/fuyu-8b","name":"Fuyu 8B","note":"adept/fuyu-8b","tags":["sees the screen","no tool calling"],"providerName":"Adept","vendor":"nvidia"},
        {"id":"nim:aisingapore/sea-lion-7b-instruct","name":"Sea Lion 7B Instruct","note":"aisingapore/sea-lion-7b-instruct","tags":["no tool calling"],"providerName":"AI Singapore","vendor":"nvidia"},
        {"id":"nim:ai21labs/jamba-1.5-large-instruct","name":"Jamba 1.5 Large Instruct","note":"ai21labs/jamba-1.5-large-instruct","tags":[],"providerName":"AI21 Labs","vendor":"nvidia"},
        {"id":"nim:bigcode/starcoder2-15b","name":"StarCoder2 15B","note":"bigcode/starcoder2-15b","tags":["code","no tool calling"],"providerName":"BigCode","vendor":"nvidia"},
        {"id":"nim:databricks/dbrx-instruct","name":"DBRX Instruct","note":"databricks/dbrx-instruct","tags":["no tool calling"],"providerName":"Databricks","vendor":"nvidia"},
        {"id":"nim:poolside/laguna-xs-2.1","name":"Laguna XS 2.1","note":"poolside/laguna-xs-2.1","tags":["code"],"providerName":"Poolside","vendor":"nvidia"},
        {"id":"nim:zyphra/zamba2-7b-instruct","name":"Zamba2 7B Instruct","note":"zyphra/zamba2-7b-instruct","tags":["no tool calling"],"providerName":"Zyphra","vendor":"nvidia"},
      ],
    }),

    /* ── the coding side ──────────────────────────────────────────
       Enough of it to exercise the real renderer: several chats, each able
       to run at the same time, each emitting the same events main.js does. */
    codeChatsList: async () => CODE.map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, cwdName: c.cwdName, model: c.model, botId: c.botId })),
    codeChatGet: async (id) => CODE.find((c) => c.id === id) || null,
    codeChatCreate: async () => {
      const c = { id: uid('cc'), title: 'New chat', cwd: 'C:/demo', cwdName: 'demo', model: null, botId: null, turns: [] };
      CODE.unshift(c);
      return c;
    },
    codeChatDelete: async (id) => { CODE = CODE.filter((c) => c.id !== id); CODE_RUNS.delete(id); return { ok: true }; },
    codeSetModel: async (id, model) => { const c = CODE.find((x) => x.id === id); if (c) c.model = model; return c; },
    codeSetBot: async (id, botId) => { const c = CODE.find((x) => x.id === id); if (c) c.botId = botId; return c; },
    codePickFolder: async () => ({ ok: true, cwd: 'C:/demo', name: 'demo' }),
    codeRunningChats: async () => [...CODE_RUNS],

    codeRun: async (chatId, prompt) => {
      if (CODE_RUNS.has(chatId)) return { ok: false, error: 'This chat is already working on something.' };
      CODE_RUNS.add(chatId);
      const say = (e) => CODE_LISTENERS.forEach((cb) => cb({ ...e, chatId }));
      say({ type: 'status', text: 'running' });

      // A slow run, so two of them can visibly overlap.
      (async () => {
        const step = (ms) => new Promise((r) => setTimeout(r, ms));
        await step(500);
        if (!CODE_RUNS.has(chatId)) return;
        say({ type: 'tool', name: 'LS', input: {} });
        await step(900);
        if (!CODE_RUNS.has(chatId)) return;
        say({ type: 'tool', name: 'Read', input: { file: 'app.js' } });
        await step(900);
        if (!CODE_RUNS.has(chatId)) return;
        say({ type: 'say_start' });
        for (const word of ('Finished: ' + prompt).split(' ')) {
          await step(90);
          if (!CODE_RUNS.has(chatId)) return;
          say({ type: 'say_delta', text: word + ' ' });
        }
        say({ type: 'say_end', text: 'Finished: ' + prompt });
        say({ type: 'done', text: null });
        CODE_RUNS.delete(chatId);
        say({ type: 'status', text: 'idle' });
      })();

      return { ok: true };
    },

    codeStop: async (chatId) => {
      const ids = chatId ? [chatId] : [...CODE_RUNS];
      ids.forEach((id) => {
        CODE_RUNS.delete(id);
        CODE_LISTENERS.forEach((cb) => cb({ type: 'status', text: 'idle', chatId: id }));
      });
      return { ok: true };
    },
    onCode: (cb) => CODE_LISTENERS.push(cb),

    nvidiaStatus: async () => NVIDIA,
    // The sweep that finds out which models a key can actually run. Here it
    // just pretends a third of them are not served, after a short delay.
    nvidiaSweep: async () => {
      const total = 61;
      for (let done = 1; done <= total; done += 7) {
        NVIDIA_PROGRESS.forEach((cb) => cb({ done, total }));
        await new Promise((r) => setTimeout(r, 60));
      }
      NVIDIA_PROGRESS.forEach((cb) => cb({ done: 0, total: 0, finished: true }));
      return { ok: true, checked: total, available: 40, unavailable: 21 };
    },
    onNvidiaProgress: (cb) => NVIDIA_PROGRESS.push(cb),
    // The real handler saves the key whatever the test call says, because a
    // 403 from NVIDIA may be about the model, not the key. Type a key
    // containing "bad" here to see that warning path.
    nvidiaSetKey: async (key) => {
      if (!key) { NVIDIA = { configured: false, hint: '' }; return { ok: true, status: NVIDIA, models: 0 }; }
      NVIDIA = { configured: true, hint: '…' + key.slice(-4) };
      const warning = /bad/.test(key)
        ? 'NVIDIA would not accept that key on any of 4 models. Last answer: meta/llama-3.2-11b-vision-instruct → 403 {"status":403,"title":"Forbidden","detail":"Authorization failed"}'
        : null;
      return { ok: true, status: NVIDIA, models: 61, warning };
    },

    /* a connected Gmail account, so the provider mark can be seen */
    connectorsList: async () => ([{ id: 'email', connected: true, email: 'ronnie@gmail.com', provider: 'Gmail' }]),
    googleGetCreds: async () => ({ clientId: 'preview', hasSecret: true, configured: true }),
    disconnectConnector: async () => ({ ok: true }),

    /* the phone letterbox, so the pairing panel can be seen */
    phoneStatus: async () => PHONE,
    phoneStart: async () => { PHONE.on = true; return PHONE; },
    phoneStop: async () => { PHONE.on = false; return PHONE; },
    phoneRotate: async () => { PHONE.token = 'k' + Math.random().toString(36).slice(2, 18); return PHONE; },

    /* audit trail — a week of plausible history, so the panel can be seen full */
    auditQuery: async (f = {}) => {
      let r = AUDIT.slice();
      if (f.botId) r = r.filter((x) => x.botId === f.botId);
      if (f.tool) r = r.filter((x) => x.tool === f.tool);
      if (f.outcome === 'ok') r = r.filter((x) => x.ok && !x.dryRun);
      if (f.outcome === 'error') r = r.filter((x) => x.ok === false);
      if (f.outcome === 'dry') r = r.filter((x) => x.dryRun);
      if (f.from) r = r.filter((x) => x.t >= f.from);
      if (f.q) r = r.filter((x) => JSON.stringify(x).toLowerCase().includes(f.q.toLowerCase()));
      return { rows: r.slice(0, f.limit || 100), total: r.length, lastError: null };
    },
    auditFacets: async () => ({
      bots: [...new Map(AUDIT.map((r) => [r.botId, r.botName])).entries()].map(([id, name]) => ({ id, name })),
      tools: [...new Set(AUDIT.map((r) => r.tool))].sort(),
      count: AUDIT.length,
    }),
    auditExport: async (_fmt, f) => ({ ok: true, count: (await window.operator.auditQuery({ ...f, limit: 1e9 })).rows.length }),

    /* appearance — kept in memory so the preview can exercise the panel */
    prefsGet: async () => JSON.parse(localStorage.getItem('prefs') || '{}'),
    prefsSet: async (patch) => {
      const now = { ...JSON.parse(localStorage.getItem('prefs') || '{}'), ...patch };
      localStorage.setItem('prefs', JSON.stringify(now));
      return now;
    },

    /* fire a humanised failure into the transcript, to see the card */
    __demoError: () => emit({ type: 'error',
      title: 'Operator has no brain to use yet',
      fix: 'Sign in to Claude by running "claude login" in a terminal, or add a free NVIDIA key in Settings → Models and pick one of its models.',
      text: 'Claude Code process exited with code 1. stderr: Invalid API key · Please run /login' }),

    listBots: async () => BOTS.map(card),
    getBot: async (id) => find(id) || null,
    createBot: async (spec) => { const b = blank((spec && spec.name) || 'New bot', spec && spec.title); BOTS.unshift(b); sync(); return card(b); },
    updateBot: async (id, patch) => {
      const b = find(id); if (!b) return null;
      if (patch.name != null && String(patch.name).trim()) b.name = String(patch.name).trim();
      if (patch.title != null) b.title = String(patch.title);
      if (patch.persona != null) b.persona = String(patch.persona);
      if ('model' in patch) b.model = patch.model || null;
      if (patch.face) b.face = patch.face;
      b.updatedAt = Date.now(); sync(); return card(b);
    },
    deleteBot: async (id) => { BOTS = BOTS.filter((b) => b.id !== id); if (!BOTS.length) BOTS = [blank('Operator', 'Runs this computer')]; sync(); return { ok: true }; },
    rememberNote: async (id, text) => { const b = find(id); if (!b) return null; const n = { id: uid('m'), text, at: Date.now() }; b.memory.unshift(n); sync(); return n; },
    forgetNote: async (id, noteId) => { const b = find(id); if (b) b.memory = b.memory.filter((m) => m.id !== noteId); sync(); return { ok: true }; },

    addSkill: async (id, spec) => { const b = find(id); if (!b) return null; const s = { id: uid('s'), name: spec.name, prompt: spec.prompt }; b.skills.push(s); sync(); return s; },
    removeSkill: async (id, sid) => { const b = find(id); if (b) b.skills = b.skills.filter((s) => s.id !== sid); sync(); return { ok: true }; },

    addRoutine: async (id, spec) => {
      const b = find(id); if (!b) return null;
      const r = { id: uid('r'), name: spec.name, prompt: spec.prompt, every: spec.every, at: spec.at, paused: false, lastRun: null };
      b.routines.push(r); sync(); return r;
    },
    updateRoutine: async (id, rid, patch) => { const b = find(id); if (!b) return null; const r = b.routines.find((x) => x.id === rid); if (!r) return null; Object.assign(r, patch); sync(); return r; },
    removeRoutine: async (id, rid) => { const b = find(id); if (b) b.routines = b.routines.filter((r) => r.id !== rid); sync(); return { ok: true }; },
    runRoutine: async (id, rid) => {
      const b = find(id); const r = b && b.routines.find((x) => x.id === rid);
      if (!r) return { ok: false, error: 'That routine is gone.' };
      r.lastRun = Date.now(); sync();
      const c = { id: uid('c'), title: r.name, turns: [], updatedAt: Date.now() };
      b.chats.unshift(c); sync();
      emit({ type: 'routine', name: r.name, botId: id, chatId: c.id });
      scriptReply(r.prompt, id, c.id);
      return { ok: true };
    },

    listChats: async (botId) => { const b = find(botId); return b ? b.chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })) : []; },
    getChat: async (botId, id) => { const b = find(botId); return b ? b.chats.find((c) => c.id === id) || null : null; },
    createChat: async (botId) => { const b = find(botId); if (!b) return null; const c = { id: uid('c'), title: 'New chat', turns: [], updatedAt: Date.now() }; b.chats.unshift(c); sync(); return c; },
    saveChat: async (botId, id, patch) => {
      const b = find(botId); if (!b) return null;
      const c = b.chats.find((x) => x.id === id); if (!c) return null;
      if (patch.title) c.title = patch.title;
      if (patch.turns) c.turns = patch.turns;
      c.updatedAt = Date.now();
      b.chats = [c, ...b.chats.filter((x) => x.id !== id)];
      b.updatedAt = Date.now(); sync();
      return { id: c.id, title: c.title, updatedAt: c.updatedAt };
    },
    deleteChat: async (botId, id) => { const b = find(botId); if (b) b.chats = b.chats.filter((c) => c.id !== id); sync(); return { ok: true }; },

    voiceSay: async () => ({ ok: true }),
    whisperWarm: async () => ({ ok: true }),
    whisperTranscribe: async () => ({ ok: true, text: '' }),
    voiceHush: async () => ({ ok: true }),
    onVoice: (cb) => listeners.voice.push(cb),
  };

  window.MicListener = { start: async () => {}, stop: () => {}, discard: () => {} };

  /* a scripted turn that emits exactly what agent.js emits */

  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeShot() {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#1b2733'; x.fillRect(0, 0, 1280, 800);
    x.fillStyle = '#0f1720'; x.fillRect(0, 0, 1280, 64);
    x.fillStyle = '#2b3b4c'; x.fillRect(180, 140, 920, 520);
    x.fillStyle = '#7e8c9b'; x.font = '28px sans-serif';
    x.fillText('a window on the real screen', 300, 400);
    return c.toDataURL('image/png').split(',')[1];
  }

  async function scriptReply(prompt, botId, chatId) {
    // main.js writes a kept note to the store before forwarding it; mirror that
    // here or the harness would show a note the real app would have saved.
    const at = (e) => {
      if (e.type === 'remember' && botId) {
        const b = find(botId);
        if (b) { b.memory.unshift({ id: uid('m'), text: e.text, at: Date.now() }); sync(); }
      }
      emit({ ...e, botId, chatId });
    };
    const say = async (text) => {
      at({ type: 'say_start' });
      for (const word of text.split(/(?<=\s)/)) { at({ type: 'say_delta', text: word }); await nap(18); }
      at({ type: 'say_end', text });
    };

    await nap(500);
    await say('On it — "' + prompt.slice(0, 36) + '". Looking at the screen first.');
    await nap(350);
    at({ type: 'tool', name: 'list_windows', input: {} });
    await nap(400);
    at({ type: 'tool', name: 'screen_screenshot', input: { display: 1 } });
    at({ type: 'screenshot', b64: fakeShot(), label: 'display 1', mime: 'image/png' });
    await nap(400);
    at({ type: 'remember', text: 'Prefers the Downloads folder sorted by kind, not by date' });
    await nap(400);
    await say('Done — that is handled.');
    at({ type: 'done', text: null });
    at({ type: 'status', text: 'idle' });
  }

})();
