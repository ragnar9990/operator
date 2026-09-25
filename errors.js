// errors.js — turn a failure into something the person can act on.
//
// Everything underneath Operator reports failure in its own vocabulary: the
// Agent SDK talks about processes and exit codes, Node talks about ENOTFOUND,
// the model's API talks about rate limits. None of that tells someone who just
// installed this what to DO. Left untranslated, "Claude Code process exited
// with code 1" is a refund.
//
// The rule here: say what went wrong in a sentence, then the one thing that
// fixes it. Never throw the original away — it is kept as `detail` so a bug
// report still has something to go on.

const RULES = [
  {
    // An installed copy with no Anthropic key (main.js needClaudeKey). The
    // commonest first-run failure by a distance: nothing explains it otherwise.
    test: /no_anthropic_key/,
    title: 'Operator needs a key to use Claude',
    fix: 'Paste your Anthropic API key in Settings → Models (get one at console.anthropic.com → API keys). Or add a free NVIDIA key there and pick one of its models.',
  },
  {
    // A key or login that was refused.
    test: /signed[_ ]?out|not authenticated|unauthorized|\b401\b|invalid[_ ]api[_ ]key|authentication[_ ]error|refresh[_ ]failed|identity[_ ]changed|oauth/i,
    title: 'Claude refused the key',
    fix: 'Check your Anthropic API key in Settings → Models — copy it again from console.anthropic.com → API keys. Or add a free NVIDIA key there and pick one of its models.',
  },
  {
    // The model runner that ships inside Operator is missing, so it cannot start.
    test: /executable not found|native binary not found|failed to spawn|ENOENT.*claude|spawn_failed/i,
    title: 'Part of Operator is missing',
    fix: 'Reinstall Operator, then restart it. Or add an NVIDIA key in Settings → Models to run without it.',
  },
  {
    test: /rate[ _-]?limit|\b429\b|usage limit|quota|too many requests/i,
    title: 'The model is rate limiting you',
    fix: 'Wait a few minutes, or switch to a different model in the picker next to the send button.',
  },
  {
    test: /credit balance|billing|payment required|\b402\b|insufficient/i,
    title: 'The model account is out of credit',
    fix: 'Top up the account, or switch to a different model in the picker next to the send button.',
  },
  {
    test: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network|socket hang up/i,
    title: 'Could not reach the model',
    fix: 'Check this machine is online. If it is, a VPN or firewall may be blocking the connection.',
  },
  {
    test: /overloaded|\b529\b|\b503\b|service unavailable/i,
    title: 'The model is overloaded right now',
    fix: 'Try again in a moment, or switch to a different model in the picker.',
  },
  {
    // The desktop helper is a separate PowerShell process and can be killed by
    // antivirus, which looks like the app is broken for no reason.
    test: /remote node returned|cannot reach the remote machine|desktop helper|helper (exited|died)/i,
    title: 'Lost the connection to the computer it was driving',
    fix: 'If this is a remote machine, check remote-node.ps1 is still running on it. On this machine, antivirus sometimes stops the helper — a folder exclusion for Operator fixes it.',
  },
  {
    test: /context (length|window)|too long|maximum.*tokens/i,
    title: 'The conversation got too long for the model',
    fix: 'Start a new chat. The agent keeps what it remembered; only the transcript is dropped.',
  },
];

// A stop is not a failure — the person asked for it — so it never reads as one.
const ABORTED = /abort|operation cancell?ed|user cancell?ed/i;

function explain(err) {
  const raw = String((err && err.message) || err || '').trim();
  if (!raw) return { title: 'Something went wrong', fix: 'Try that again.', detail: '' };
  if (ABORTED.test(raw)) return { title: 'Stopped', fix: '', detail: '', stopped: true };

  for (const rule of RULES) {
    if (rule.test.test(raw)) return { title: rule.title, fix: rule.fix, detail: raw };
  }
  // Unrecognised: show the real thing rather than a vague apology that hides it.
  return { title: 'Something went wrong', fix: '', detail: raw };
}

// One line, for places that only have room for one.
function explainLine(err) {
  const e = explain(err);
  return e.fix ? `${e.title}. ${e.fix}` : (e.detail || e.title);
}

// The SDK retries a refused key ten times over about two minutes before it
// gives up, which looks exactly like a hang. Its retry notice says why, and a
// 401 does not get better by waiting — so every loop reading the SDK throws
// this at the first one, and the rule at the top of RULES explains it.
function keyRefused(m) {
  return Boolean(m && m.type === 'system' && m.subtype === 'api_retry' &&
    (m.error_status === 401 || m.error === 'authentication_failed'));
}
const KEY_REFUSED = 'invalid_api_key (401): Anthropic refused the key';

module.exports = { explain, explainLine, keyRefused, KEY_REFUSED };
