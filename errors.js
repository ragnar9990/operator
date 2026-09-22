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
    // No usable login. The commonest first-run failure by a distance: the app
    // is installed, nothing is signed in, and nothing explains that.
    test: /signed[_ ]?out|not authenticated|unauthorized|\b401\b|invalid[_ ]api[_ ]key|authentication[_ ]error|refresh[_ ]failed|identity[_ ]changed|oauth/i,
    title: 'Operator has no brain to use yet',
    fix: 'Sign in to Claude by running "claude login" in a terminal, or add a free NVIDIA key in Settings → Models and pick one of its models.',
  },
  {
    // Claude Code itself is missing, so the SDK cannot start.
    test: /executable not found|native binary not found|failed to spawn|ENOENT.*claude|spawn_failed/i,
    title: 'Claude Code is not installed on this machine',
    fix: 'Install it from claude.com/claude-code, then restart Operator. Or add an NVIDIA key in Settings → Models to run without it.',
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
    fix: 'Start a new chat. The bot keeps what it remembered; only the transcript is dropped.',
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

module.exports = { explain, explainLine };
