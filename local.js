// local.js — a brain on this computer: Ollama, LM Studio, llama.cpp's server.
//
// All three speak the same chat-completions as NVIDIA's endpoint, so the
// tool-calling loop in nim.js drives them unchanged; only the address differs,
// and there is no key. This file finds them and says what they have.
//
// Why it matters: with a model here, nothing about a job leaves the building —
// not the screen, not the page, not the file. It works with the network
// unplugged, and it costs nothing per run. A small model on a laptop is much
// weaker than Claude at driving a computer, and the picker says so; where it
// shines is running and repairing playbooks, which only ask it for one step.

const PREFIX = 'local:';

// Where each one listens out of the box. A server somewhere else (another port,
// another machine on the network) is added in Settings → Models.
const KNOWN = [
  { kind: 'ollama', label: 'Ollama', base: 'http://127.0.0.1:11434/v1' },
  { kind: 'lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
  { kind: 'llamacpp', label: 'llama.cpp', base: 'http://127.0.0.1:8080/v1' },
];

let custom = '';                    // a server the user added, if any
let servers = [];                   // [{ kind, label, base, models: [...] }] — the last look
let lookedAt = 0;
let looking = null;

const isLocalModel = (id) => typeof id === 'string' && id.startsWith(PREFIX);
const bareId = (id) => (isLocalModel(id) ? id.slice(PREFIX.length) : id);

// Whatever was typed — "localhost:11434", "http://box:1234/v1/", a whole curl
// line — down to a base the chat-completions calls hang off.
function cleanUrl(raw) {
  let u = String(raw || '').trim();
  const found = u.match(/https?:\/\/[^\s"'`]+/i);
  if (found) u = found[0];
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '');
  if (!/\/v1$/i.test(u)) u += '/v1';
  try { new URL(u); } catch { return ''; }
  return u;
}

function setCustom(url) { custom = cleanUrl(url); lookedAt = 0; return custom; }

async function getJson(url, opts = {}, ms = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// Family-level guesses, the same way nim.js makes them, for servers that do
// not say. Ollama does say (/api/show), and its answer wins.
const VISION = /(vision|-vl\b|vl:|llava|bakllava|minicpm-v|moondream|qwen2\.5vl|qwen2-vl|qwen3-vl|gemma3|gemma-3|llama3\.2-vision|llama4|granite3\.2-vision|mistral-small3\.[12]|pixtral)/i;
const TOOLS = /(qwen2\.5|qwen3|qwq|llama3\.[123]|llama4|mistral|mixtral|command-r|firefunction|hermes|granite3|nemotron|phi4|gpt-oss|deepseek-v3|devstral|smollm2|cogito|athene)/i;
const NO_TOOLS = /(gemma2|gemma:|codellama|llama2|phi3|tinyllama|starcoder|embed|nomic|bge|mxbai)/i;

async function ollamaCaps(root, name) {
  const info = await getJson(`${root}/api/show`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }),
  }, 2500);
  return info && Array.isArray(info.capabilities) ? info.capabilities : null;
}

const pretty = (name) => {
  const [base, tag] = String(name).split(':');
  const nice = base.split('/').pop().replace(/[-_]/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return tag && tag !== 'latest' ? `${nice} ${tag.toUpperCase()}` : nice;
};

async function lookAt(srv) {
  const body = await getJson(`${srv.base}/models`);
  if (!body || !Array.isArray(body.data)) return null;
  const root = srv.base.replace(/\/v1$/, '');
  const rows = [];
  for (const m of body.data) {
    const name = m && m.id;
    if (!name || /embed|nomic-bert|bge-|rerank/i.test(name)) continue;
    let vision = VISION.test(name);
    let tools = !NO_TOOLS.test(name) && (TOOLS.test(name) ? true : null);
    if (srv.kind === 'ollama' || srv.kind === 'custom') {
      const caps = await ollamaCaps(root, name);
      if (caps) { vision = caps.includes('vision'); tools = caps.includes('tools'); }
    }
    const tags = ['on this PC'];
    if (vision) tags.push('sees the screen');
    if (tools === false) tags.push('no tool calling');
    rows.push({
      id: PREFIX + name,
      modelId: name,
      name: pretty(name),
      note: `${srv.label} · ${name}`,
      tags,
      provider: 'local',
      providerName: 'On this computer',
      vendor: 'local',
      vision,
      tools: tools !== false,
      base: srv.base,
      server: srv.label,
    });
  }
  return { ...srv, models: rows };
}

// Look for servers. Cheap — a refused connection comes back at once — but
// cached for a minute so opening the model menu never waits on it.
async function refresh({ force = false } = {}) {
  if (!force && lookedAt && Date.now() - lookedAt < 60000) return servers;
  if (looking) return looking;
  const candidates = [...KNOWN];
  if (custom && !KNOWN.some((k) => k.base === custom)) candidates.unshift({ kind: 'custom', label: 'Your server', base: custom });
  looking = Promise.all(candidates.map(lookAt)).then((found) => {
    servers = found.filter(Boolean);
    lookedAt = Date.now();
    looking = null;
    return servers;
  });
  return looking;
}

const listModels = () => servers.flatMap((s) => s.models);

// What runs a local id: the model as last seen, or — before the first look has
// come back — a best guess at the usual address, so a saved choice still works.
function describe(name) {
  const known = listModels().find((m) => m.modelId === name);
  if (known) return known;
  const base = custom || (servers[0] && servers[0].base) || KNOWN[0].base;
  return {
    id: PREFIX + name, modelId: name, name: pretty(name), note: name, tags: ['on this PC'],
    provider: 'local', providerName: 'On this computer', vendor: 'local',
    vision: VISION.test(name), tools: !NO_TOOLS.test(name), base, server: 'this computer',
  };
}

function status() {
  return {
    custom,
    servers: servers.map((s) => ({ label: s.label, base: s.base, models: s.models.length })),
    models: listModels().map((m) => ({ id: m.id, name: m.name, note: m.note, tags: m.tags, tools: m.tools, vision: m.vision })),
    lookedAt,
  };
}

module.exports = { PREFIX, isLocalModel, bareId, cleanUrl, setCustom, refresh, listModels, describe, status };
