// model-options.js — what each model lets you turn, and what turning it does.
//
// The picker chooses the brain; this is the dial beside it. Every model says
// which knobs it has (a model that ignores effort does not get an effort
// control), the choices are remembered per model and per side — Agents wants
// quick steps, Code usually wants careful ones — and they become Agent SDK
// options for Claude or request fields for NVIDIA.
//
// Capabilities follow Anthropic's model docs: effort is low…max on current
// models, without xhigh on the 4.6 pair, and not at all on Haiku 4.5; thinking
// is always on for Fable and Opus 5 (turning it off there is refused or
// misbehaves, and lower effort is the supported way to make them quicker),
// switchable on Sonnet 5 and the Opus/Sonnet 4.x models, and a fixed budget on
// Haiku 4.5, where it is off unless asked for.
//
// Fast mode is deliberately absent: it only exists on Opus 5 and 4.8, and on
// this account it reports "on" while every request still runs at standard
// speed — a switch that does nothing would be worse than no switch.

const E5 = ['low', 'medium', 'high', 'xhigh', 'max'];
const E4 = ['low', 'medium', 'high', 'max'];

const CLAUDE = {
  'claude-fable-5-1': { efforts: E5, thinking: 'always' },
  'claude-fable-5': { efforts: E5, thinking: 'always' },
  'claude-opus-5': { efforts: E5, thinking: 'always' },
  'claude-sonnet-5': { efforts: E5, thinking: 'toggle' },
  'claude-opus-4-8': { efforts: E5, thinking: 'toggle' },
  'claude-opus-4-7': { efforts: E5, thinking: 'toggle' },
  'claude-opus-4-6': { efforts: E4, thinking: 'toggle' },
  'claude-sonnet-4-6': { efforts: E4, thinking: 'toggle' },
  'claude-haiku-4-5': { efforts: null, thinking: 'budget' },
};

const EFFORT_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

// Haiku's thinking is a fixed budget rather than adaptive. Enough to plan a
// step properly without turning the fastest model into a slow one.
const HAIKU_BUDGET = 6000;

const LENGTHS = [
  { v: 1024, label: 'Short' },
  { v: 4096, label: 'Normal' },
  { v: 8192, label: 'Long' },
];

// The controls a model has, in the shape the window draws them. `default` is
// per side because the two sides want different things from the same model.
function specFor(model) {
  const id = typeof model === 'string' ? model : model && model.id;
  const claude = CLAUDE[id];
  const out = [];

  if (claude) {
    if (claude.efforts) {
      out.push({
        key: 'effort',
        label: 'Effort',
        type: 'choice',
        choices: ['auto', ...claude.efforts].map((v) => ({ v, label: EFFORT_LABEL[v] })),
        default: { agents: 'low', code: 'auto' },
        hint: 'How hard it thinks before each step. Lower is faster and uses less of your plan; higher is more careful. Auto leaves it to the model.',
      });
    }
    if (claude.thinking === 'toggle') {
      out.push({
        key: 'thinking',
        label: 'Thinking',
        type: 'toggle',
        default: { agents: true, code: true },
        hint: 'Off answers a touch sooner. On is steadier on anything that needs a plan.',
      });
    } else if (claude.thinking === 'budget') {
      out.push({
        key: 'thinking',
        label: 'Thinking',
        type: 'toggle',
        default: { agents: false, code: false },
        hint: 'Lets it think before it acts. Slower, but better at jobs with several steps.',
      });
    }
    return out;
  }

  // Everything else runs through NVIDIA's OpenAI-style endpoint, where these
  // two are standard on every model.
  if (String(id || '').startsWith('nim:')) {
    out.push({
      key: 'temperature',
      label: 'Temperature',
      type: 'range',
      min: 0,
      max: 1.5,
      step: 0.1,
      default: { agents: 0.2, code: 0.2 },
      hint: 'Low sticks to the likeliest answer, which is what driving a computer wants. Higher is more varied.',
    });
    out.push({
      key: 'maxTokens',
      label: 'Reply length',
      type: 'choice',
      choices: LENGTHS,
      default: { agents: 4096, code: 4096 },
      hint: 'The most it may write in one go. If a model refuses a long setting, pick a shorter one.',
    });
  }
  return out;
}

// Saved values with the defaults filled in and anything invalid dropped — the
// file is edited by hand sometimes, and a model's knobs can change.
function resolve(mode, id, saved) {
  const side = mode === 'code' ? 'code' : 'agents';
  const values = {};
  for (const s of specFor(id)) {
    const v = saved ? saved[s.key] : undefined;
    values[s.key] = valid(s, v) ? v : s.default[side];
  }
  return values;
}

function valid(spec, v) {
  if (v === undefined || v === null) return false;
  if (spec.type === 'toggle') return typeof v === 'boolean';
  if (spec.type === 'range') return typeof v === 'number' && v >= spec.min && v <= spec.max;
  if (spec.type === 'choice') return spec.choices.some((c) => c.v === v);
  return false;
}

// Only the keys this model has, and only valid values — what the store keeps.
function clean(id, patch) {
  const out = {};
  for (const s of specFor(id)) if (patch && valid(s, patch[s.key])) out[s.key] = patch[s.key];
  return out;
}

// The Agent SDK options for a Claude model. Nothing is sent for "auto", so the
// model's own default applies exactly as if this file did not exist.
function sdkOptions(mode, id, saved) {
  const claude = CLAUDE[id];
  if (!claude) return {};
  const v = resolve(mode, id, saved);
  const out = {};
  if (claude.efforts && v.effort && v.effort !== 'auto') out.effort = v.effort;
  if (claude.thinking === 'toggle' && v.thinking === false) out.thinking = { type: 'disabled' };
  if (claude.thinking === 'budget' && v.thinking === true) out.thinking = { type: 'enabled', budgetTokens: HAIKU_BUDGET };
  return out;
}

// Request fields for an NVIDIA model.
function nimParams(mode, id, saved) {
  if (!String(id || '').startsWith('nim:')) return {};
  const v = resolve(mode, id, saved);
  return { temperature: v.temperature, max_tokens: v.maxTokens };
}

// A few words for the button beside the picker: the setting you would most
// want to see without opening it.
function summary(mode, id, saved) {
  const v = resolve(mode, id, saved);
  const spec = specFor(id);
  if (spec.some((s) => s.key === 'effort')) return v.effort === 'auto' ? 'Auto' : EFFORT_LABEL[v.effort];
  if (spec.some((s) => s.key === 'temperature')) return 'Temp ' + Number(v.temperature).toFixed(1);
  if (spec.some((s) => s.key === 'thinking')) return v.thinking ? 'Thinking' : 'Quick';
  return '';
}

module.exports = { specFor, resolve, clean, sdkOptions, nimParams, summary, CLAUDE };
