// nim.js — NVIDIA NIM as a second brain for Operator.
//
// NIM (build.nvidia.com / integrate.api.nvidia.com) hosts every model vendor's
// weights behind one OpenAI-compatible endpoint and one API key: Meta, Google,
// Mistral, DeepSeek, Qwen, Microsoft, IBM, Moonshot, Z.ai, OpenAI's open
// weights, NVIDIA's own Nemotron family, and the rest. So supporting NIM is
// supporting all of them at once — the catalog below is fetched live, not
// hand-maintained, which is why a model NVIDIA added this morning shows up in
// the picker without a code change.
//
// The Claude side of Operator runs on the Agent SDK (agent.js). This file is
// the other half: the same tools, the same events, driven through plain
// chat-completions with function calling.

const BASE = (process.env.OPERATOR_NIM_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');

// Every NIM model id in the picker wears this prefix, so one string can say
// both "who runs it" and "which model" — `nim:meta/llama-3.3-70b-instruct`.
const PREFIX = 'nim:';

const isNimModel = (id) => typeof id === 'string' && id.startsWith(PREFIX);
const bareId = (id) => (isNimModel(id) ? id.slice(PREFIX.length) : id);

/* ── who publishes what ──────────────────────────────────────────────
   NIM names a model "<publisher>/<model>", and the publisher is the actual
   AI provider. This map only supplies the human spelling; an unknown
   publisher still appears, title-cased, rather than being dropped. */

const PROVIDERS = {
  '01-ai': '01.AI',
  abacusai: 'Abacus.AI',
  adept: 'Adept',
  ai21labs: 'AI21 Labs',
  aisingapore: 'AI Singapore',
  baai: 'BAAI',
  'baichuan-inc': 'Baichuan',
  bigcode: 'BigCode',
  bytedance: 'ByteDance',
  cohere: 'Cohere',
  databricks: 'Databricks',
  'deepseek-ai': 'DeepSeek',
  google: 'Google',
  ibm: 'IBM',
  igenius: 'iGenius',
  'institute-of-science-tokyo': 'Institute of Science Tokyo',
  marin: 'Marin',
  mediatek: 'MediaTek',
  meta: 'Meta',
  microsoft: 'Microsoft',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  'nv-mistralai': 'NVIDIA × Mistral',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  poolside: 'Poolside',
  qwen: 'Qwen',
  rakuten: 'Rakuten',
  servicenow: 'ServiceNow',
  snowflake: 'Snowflake',
  speakleash: 'SpeakLeash',
  stabilityai: 'Stability AI',
  thudm: 'Zhipu AI',
  tiiuae: 'TII',
  tokyotech: 'Institute of Science Tokyo',
  upstage: 'Upstage',
  'utter-project': 'Utter Project',
  writer: 'Writer',
  xai: 'xAI',
  yentinglin: 'Yen-Ting Lin',
  'z-ai': 'Z.ai',
  zyphra: 'Zyphra',
};

// NVIDIA's own models come first — it is their endpoint and their key — then
// the labs whose frontier models people actually reach for, then the rest
// alphabetically. Order only decides where a group sits in the dropdown.
const PROVIDER_ORDER = [
  'nvidia', 'meta', 'openai', 'google', 'deepseek-ai', 'qwen', 'mistralai',
  'nv-mistralai', 'moonshotai', 'z-ai', 'thudm', 'microsoft', 'ibm', 'writer',
];

/* ── the catalog ─────────────────────────────────────────────────────
   Fetched from GET /v1/models, which needs no key. The list below is only
   the fallback for a machine that is offline the first time it looks — the
   picker should never be empty. */

const FALLBACK = [
  '01-ai/yi-large', 'ai21labs/jamba-1.5-large-instruct', 'databricks/dbrx-instruct',
  'deepseek-ai/deepseek-coder-6.7b-instruct', 'deepseek-ai/deepseek-v4-flash-0731',
  'google/gemma-3-12b-it', 'google/gemma-3-4b-it', 'google/gemma-4-31b-it',
  'ibm/granite-3.0-8b-instruct', 'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct', 'microsoft/phi-3.5-moe-instruct',
  'mistralai/mistral-large-2-instruct', 'mistralai/mistral-nemotron',
  'moonshotai/kimi-k2.6', 'moonshotai/kimi-k3', 'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-nano-3-30b-a3b',
  'openai/gpt-oss-20b', 'writer/palmyra-creative-122b', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash',
];

// Endpoints that are not chat at all. Picking one as the brain would 404 or
// return a vector, so they never reach the dropdown.
const NOT_CHAT = /(^|[-/])(embed|embedqa|embedding|rerank|reranking|retriever|reward|nvclip|clip|parse|ocr|detector|tts|asr|diffusion|sdxl|stable-|flux|riva-)/i;

// Classifiers, not assistants: they answer "is this safe?" about a transcript.
const GUARD = /(guard|content-safety|topic-control|safety)/i;

// Models that can actually look at a screenshot.
const VISION = /(vision|vlm|-vl-|-vl$|omni|neva|vila|kosmos|fuyu|deplot|cosmos-reason|gemma-3|gemma-4|llama-4|internvl|nemoretriever)/i;

// Tool calling is what lets a model drive the computer, and not every open
// model has it. This is a family-level judgement — worth being conservative
// about, because a model that silently cannot call tools just narrates.
const TOOLS_YES = /(llama-3\.[123]|llama-3\.3|llama-4|nemotron|mistral-large|mistral-small|mistral-medium|mistral-nemo|mixtral-8x22b-instruct|codestral|deepseek-v[34]|deepseek-r1|qwen2\.5|qwen3|qwq|glm-[45]|kimi|gpt-oss|granite-3|jamba-1\.5|phi-4|command-r|magistral|devstral|apriel)/i;
const TOOLS_NO = /(gemma|starcoder|yi-large|dbrx|llama2|codellama|phi-3|sea-lion|zamba|fuyu|kosmos|neva|vila|deplot|recurrentgemma|palmyra|arctic)/i;

const CODE = /(coder|code|codestral|starcoder|codegemma|codellama|devstral|laguna|poolside)/i;
const REASON = /(reasoning|-r1|thinking|nemotron-ultra|qwq|magistral)/i;

const ACRONYMS = {
  ai: 'AI', vl: 'VL', vlm: 'VLM', llm: 'LLM', moe: 'MoE', it: 'IT', qa: 'QA', xs: 'XS',
  gpt: 'GPT', oss: 'OSS', glm: 'GLM', dbrx: 'DBRX', nvlm: 'NVLM', nv: 'NV',
  chatqa: 'ChatQA', vila: 'VILA', neva: 'NeVA', llama: 'Llama', llama2: 'Llama 2',
  llama3: 'Llama 3', llama4: 'Llama 4', qwen: 'Qwen', qwq: 'QwQ', kimi: 'Kimi', phi: 'Phi',
  seallm: 'SeaLLM', minitron: 'Minitron', nemo: 'Nemo', nemotron: 'Nemotron',
  deepseek: 'DeepSeek', codellama: 'Code Llama', codegemma: 'CodeGemma',
  recurrentgemma: 'RecurrentGemma', diffusiongemma: 'DiffusionGemma',
  starcoder: 'StarCoder', starcoder2: 'StarCoder2', deplot: 'DePlot', kosmos: 'Kosmos',
  v1: 'v1', v2: 'v2', v3: 'v3', instruct: 'Instruct', chat: 'Chat', base: 'Base',
};

// "meta/llama-3.3-70b-instruct" -> "Llama 3.3 70B Instruct". Derived rather
// than tabulated, so a model NVIDIA adds tomorrow still reads properly.
function prettify(bare) {
  const tail = bare.includes('/') ? bare.slice(bare.indexOf('/') + 1) : bare;
  return tail.split('-').map((w) => {
    const low = w.toLowerCase();
    if (ACRONYMS[low]) return ACRONYMS[low];
    // Parameter counts: 70b -> 70B, a3b -> A3B, 8x22b -> 8x22B, a800m -> A800M,
    // and context lengths stay lower case: 32k, 128k.
    const size = w.match(/^(a?)(\d+(?:\.\d+)?(?:x\d+)?)([bmk])$/i);
    if (size) return (size[1] ? 'A' : '') + size[2] + (size[3].toLowerCase() === 'k' ? 'k' : size[3].toUpperCase());
    if (/^v\d/i.test(w)) return w.toLowerCase();                          // v0.1
    if (/^\d/.test(w)) return w;                                          // 3.1, 2024
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

const providerName = (owner) =>
  PROVIDERS[owner] || owner.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// One catalog row, from an id alone.
function describe(bare) {
  const owner = bare.includes('/') ? bare.slice(0, bare.indexOf('/')) : 'nvidia';
  const vision = VISION.test(bare);
  const tools = TOOLS_NO.test(bare) ? false : TOOLS_YES.test(bare) ? true : null;

  const tags = [];
  if (vision) tags.push('sees the screen');
  if (REASON.test(bare)) tags.push('reasoning');
  if (CODE.test(bare)) tags.push('code');
  if (tools === false) tags.push('no tool calling');

  return {
    id: PREFIX + bare,
    modelId: bare,
    name: prettify(bare),
    note: bare,
    tags,
    provider: owner,
    providerName: providerName(owner),
    vendor: 'nvidia',
    vision,
    // null means "not in either family list" — try it and see.
    tools: tools !== false,
  };
}

function sortModels(rows) {
  const rank = (p) => {
    const i = PROVIDER_ORDER.indexOf(p);
    return i === -1 ? PROVIDER_ORDER.length : i;
  };
  return rows.sort((a, b) =>
    rank(a.provider) - rank(b.provider) ||
    a.providerName.localeCompare(b.providerName) ||
    a.name.localeCompare(b.name));
}

let catalog = sortModels(FALLBACK.map(describe));
let fetchedAt = 0;

// The live list. Cheap, public, and cached for the session — refresh() forces
// it (the Settings panel does that when you save a key).
async function refresh({ force = false } = {}) {
  if (!force && fetchedAt && Date.now() - fetchedAt < 30 * 60 * 1000) return catalog;
  try {
    const res = await fetch(`${BASE}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id).filter(Boolean);
    const usable = ids.filter((id) => !NOT_CHAT.test(id) && !GUARD.test(id));
    if (usable.length) {
      catalog = sortModels(usable.map(describe));
      fetchedAt = Date.now();
    }
  } catch (_) {
    // Offline, or NVIDIA is having a moment. The fallback list still works.
  }
  return catalog;
}

const listModels = () => catalog;

/* ── the key ─────────────────────────────────────────────────────────
   Held in memory for the process; store.js owns the copy on disk. */

let apiKey = process.env.NVIDIA_API_KEY || process.env.OPERATOR_NIM_KEY || '';

const setKey = (k) => { apiKey = String(k || '').trim(); };
const hasKey = () => Boolean(apiKey);

// Prove a key works by spending one token on the smallest model going, rather
// than by its shape — nvapi- keys and NGC keys both exist, and only the server
// knows which are live.
async function testKey(key) {
  const k = String(key || apiKey || '').trim();
  if (!k) return { ok: false, error: 'No API key yet.' };

  await refresh({ force: true });
  const small = catalog.find((m) => /nano|mini|small|8b|7b|4b|flash|lite/i.test(m.modelId)) || catalog[0];
  if (!small) return { ok: false, error: 'Could not reach the NVIDIA model catalog.' };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: small.modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'NVIDIA rejected that key.' };
    if (!res.ok && res.status !== 400 && res.status !== 429) {
      return { ok: false, error: `NVIDIA said ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    // 400 here means the key is fine and that one model was fussy; 429 means
    // the key is fine and busy. Either way it authenticated.
    return { ok: true, models: catalog.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ── tools, in OpenAI's shape ────────────────────────────────────── */

let z = null;
const zod = () => (z || (z = require('zod')));

// The SDK's tool() keeps its input schema as a raw zod shape; chat-completions
// wants JSON Schema. Zod 4 converts, and we tidy the output: the $schema line
// and the int64 bounds zod emits for z.number().int() are noise in a prompt
// that every turn has to carry.
function jsonSchema(shape) {
  try {
    const out = zod().toJSONSchema(zod().object(shape || {}), { target: 'draft-7', io: 'input' });
    delete out.$schema;
    const scrub = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'integer' && node.minimum === Number.MIN_SAFE_INTEGER) { delete node.minimum; delete node.maximum; }
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(scrub); else scrub(v);
      }
    };
    scrub(out);
    if (!out.properties) { out.properties = {}; out.type = 'object'; }
    return out;
  } catch (_) {
    return { type: 'object', properties: {} };
  }
}

const toOpenAITools = (tools) => tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: jsonSchema(t.inputSchema) },
}));

/* ── images ──────────────────────────────────────────────────────────
   NVIDIA takes an inline image up to ~180KB; a 1280px PNG screenshot is
   several times that. Electron can re-encode it without a native module, so
   shrink to something a VLM can still read and the endpoint will still take. */

const MAX_IMAGE = 170 * 1024;

function shrink(b64, mime) {
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return null; }
  if (buf.length <= MAX_IMAGE && /jpe?g/.test(mime || '')) return { b64, mime };

  let nativeImage;
  try { ({ nativeImage } = require('electron')); } catch (_) { nativeImage = null; }
  if (!nativeImage) return buf.length <= MAX_IMAGE ? { b64, mime: mime || 'image/png' } : null;

  try {
    let img = nativeImage.createFromBuffer(buf);
    for (const [width, quality] of [[1024, 70], [800, 60], [640, 45], [512, 35]]) {
      const out = img.resize({ width, quality: 'good' }).toJPEG(quality);
      if (out.length <= MAX_IMAGE) return { b64: out.toString('base64'), mime: 'image/jpeg' };
    }
    const last = img.resize({ width: 420, quality: 'good' }).toJPEG(30);
    return last.length <= MAX_IMAGE ? { b64: last.toString('base64'), mime: 'image/jpeg' } : null;
  } catch (_) {
    return null;
  }
}

/* ── streaming a turn ────────────────────────────────────────────── */

// Server-sent events, line by line, off the fetch body.
async function* sse(res) {
  const reader = res.body.getReader();
  const decode = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decode.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try { yield JSON.parse(payload); } catch (_) { /* keep-alive or partial */ }
    }
  }
}

async function post(body, signal) {
  if (!apiKey) throw new Error('No NVIDIA API key. Add one in Settings → Models.');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch (_) {}
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'NVIDIA rejected the API key. Check it in Settings → Models.'
        : `NVIDIA NIM error ${res.status}: ${detail || res.statusText}`
    );
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res;
}

// Reasoning models narrate inside <think>…</think>. That is working-out, not a
// reply, so it never reaches the transcript or the voice.
function thinkFilter() {
  let inside = false;
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let out = '';
    while (pending) {
      if (!inside) {
        const open = pending.indexOf('<think>');
        if (open === -1) {
          // Hold back anything that could be the start of a tag.
          const keep = Math.max(0, pending.length - 7);
          out += pending.slice(0, keep);
          pending = pending.slice(keep);
          if (!/[<]/.test(pending)) { out += pending; pending = ''; }
          break;
        }
        out += pending.slice(0, open);
        pending = pending.slice(open + 7);
        inside = true;
      } else {
        const close = pending.indexOf('</think>');
        if (close === -1) { pending = pending.slice(-8); break; }
        pending = pending.slice(close + 8);
        inside = false;
      }
    }
    return out;
  };
}

/* ── conversations ───────────────────────────────────────────────────
   There is no session on NVIDIA's side — chat-completions is stateless — so
   Operator keeps the thread here, keyed by the id it hands back to main.js.
   It lives for as long as the app does, which is the same deal the Claude SDK
   gives us: resume works until it doesn't, and then the turn starts fresh. */

const threads = new Map();
const MAX_HISTORY = 60;
const newSessionId = () => 'nim-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ── the loop ────────────────────────────────────────────────────────
   Same contract as agent.js runTask: it takes the built tools and system
   prompt, and emits the same events, so the UI cannot tell which brain is
   driving. */

async function runTask({ prompt, model, systemPrompt, tools, onEvent, abortController, resume, maxTurns = 40 }) {
  const info = describe(bareId(model));
  const spec = toOpenAITools(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const sessionId = (resume && threads.has(resume)) ? resume : newSessionId();
  const history = threads.get(sessionId) || [];
  threads.set(sessionId, history);
  onEvent({ type: 'session', id: sessionId });

  let sys = systemPrompt;
  if (!info.vision) {
    sys += `

YOU CANNOT SEE IMAGES. This model has no vision, so screenshots come back to you as a note, not a picture. Work by what you can read instead: browser_read_text and the text every browser action returns, list_windows for what is open and where, and run_command (PowerShell) for files, settings and lookups. Do not ask for a screenshot and do not click bare coordinates you have not been told about — say plainly that you cannot see the screen if a task truly needs eyes.`;
  }

  if (!history.length) history.push({ role: 'system', content: sys });
  else history[0] = { role: 'system', content: sys };
  history.push({ role: 'user', content: prompt });

  let said = '';
  let turns = 0;

  // Some open models on NIM have no function calling at all. One says so up
  // front rather than letting the user watch it narrate what it would have
  // done; one only found out when NVIDIA rejects the request drops the tools
  // and carries on as a plain chat.
  let toolsOff = !info.tools;
  if (toolsOff) {
    onEvent({ type: 'assistant', text: `${info.name} has no tool calling, so it can talk but it cannot touch the computer. Pick another model to have work done.` });
  }

  const send = async () => {
    const body = {
      model: info.modelId,
      messages: history.slice(-MAX_HISTORY),
      temperature: 0.2,
      max_tokens: 4096,
      stream: true,
    };
    if (!toolsOff && spec.length) { body.tools = spec; body.tool_choice = 'auto'; }
    try {
      return await post(body, abortController?.signal);
    } catch (err) {
      if (toolsOff || !body.tools || err.status !== 400 || !/tool|function/i.test(err.detail || '')) throw err;
      toolsOff = true;
      onEvent({ type: 'assistant', text: `${info.name} will not take tools, so it cannot drive the computer — answering as a plain chat instead.` });
      delete body.tools; delete body.tool_choice;
      return post(body, abortController?.signal);
    }
  };

  while (turns++ < maxTurns) {
    if (abortController?.signal.aborted) return;

    const res = await send();

    let text = '';
    let open = false;
    const calls = [];
    let finish = null;
    const clean = thinkFilter();

    for await (const frame of sse(res)) {
      if (abortController?.signal.aborted) return;
      const choice = (frame.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        const visible = clean(delta.content);
        if (visible) {
          if (!open) { open = true; onEvent({ type: 'say_start' }); }
          text += visible;
          onEvent({ type: 'say_delta', text: visible });
        }
      }

      for (const tc of delta.tool_calls || []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        const slot = calls[i] || (calls[i] = { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }

      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (open) { onEvent({ type: 'say_end', text }); said = text; }

    const wanted = calls.filter(Boolean).filter((c) => c.name);

    if (!wanted.length) {
      history.push({ role: 'assistant', content: text });
      trim(history);
      onEvent({ type: 'done', text: open || !text.trim() ? null : text });
      return;
    }

    history.push({
      role: 'assistant',
      content: text || null,
      tool_calls: wanted.map((c, i) => ({
        id: c.id || `call_${turns}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });

    // Run them in order, and hand each result back on its own tool message.
    const images = [];
    for (const [i, call] of wanted.entries()) {
      if (abortController?.signal.aborted) return;

      let args = {};
      try { args = call.args ? JSON.parse(call.args) : {}; } catch (_) { args = {}; }

      const t = byName.get(call.name);
      const callId = call.id || `call_${turns}_${i}`;

      if (!t) {
        history.push({ role: 'tool', tool_call_id: callId, content: `There is no tool called "${call.name}".` });
        continue;
      }

      onEvent({ type: 'tool', name: call.name, input: args });

      let result;
      try {
        result = await t.handler(args, {});
      } catch (err) {
        history.push({ role: 'tool', tool_call_id: callId, content: `That failed: ${err && err.message ? err.message : err}` });
        continue;
      }

      const parts = (result && result.content) || [];
      let body = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

      for (const p of parts) {
        if (p.type !== 'image') continue;
        if (!info.vision) { body += '\n(A screenshot was taken, but this model cannot see images.)'; continue; }
        const small = shrink(p.data, p.mimeType);
        if (small) images.push(small);
        else body += '\n(The screenshot was too large to send to this model.)';
      }

      history.push({ role: 'tool', tool_call_id: callId, content: body.slice(0, 20000) || 'Done.' });
    }

    // Tool messages carry text only, so a screenshot rides in as the user's
    // next message — which is how the OpenAI-shaped vision APIs expect it.
    if (images.length) {
      history.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the screen after that:' },
          ...images.slice(0, 2).map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } })),
        ],
      });
    }

    trim(history);
    if (finish === 'length') {
      onEvent({ type: 'done', text: 'Stopped: the model hit its output limit.' });
      return;
    }
  }

  onEvent({ type: 'done', text: said ? null : `Stopped after ${maxTurns} turns without finishing.` });
}

// Keep the system prompt and the recent thread; drop the middle. Cutting at a
// tool message would orphan it from its assistant turn, so cut past those.
function trim(history) {
  if (history.length <= MAX_HISTORY) return;
  let cut = history.length - MAX_HISTORY + 1;
  while (cut < history.length && history[cut].role === 'tool') cut++;
  history.splice(1, cut - 1);
}

/* ── one-shot ────────────────────────────────────────────────────────
   For a teammate bot answering a message: one turn, no tools. */

async function ask({ model, system, message, abortController }) {
  const info = describe(bareId(model));
  const res = await post({
    model: info.modelId,
    messages: [{ role: 'system', content: system }, { role: 'user', content: message }],
    temperature: 0.3,
    max_tokens: 1024,
    stream: false,
  }, abortController?.signal);
  const body = await res.json();
  const raw = body.choices?.[0]?.message?.content || '';
  return String(raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

module.exports = {
  PREFIX, BASE, PROVIDERS, PROVIDER_ORDER,
  isNimModel, bareId, describe, listModels, refresh,
  setKey, hasKey, testKey, runTask, ask,
};
