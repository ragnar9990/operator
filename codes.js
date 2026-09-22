// codes.js — find the one-time code a service just sent you.
//
// Signing in to something you own is the commonest place the agent gets stuck:
// it reaches the second step, a code arrives somewhere it cannot see, and the
// task stalls until a human reads it out. This looks in the mailbox that is
// already connected and pulls the code out.
//
// SMS works through the same path, because a phone can put SMS there. See
// PHONE.md for the two ways to do that. Nothing here talks to a phone network
// directly; it reads the user's own mailbox, and nothing else.
//
// Deliberate limits:
//   - only messages from the last few minutes, because a stale code is worse
//     than none: it fails silently and looks like the wrong password
//   - the sender and subject come back with the code, so the agent can check it
//     came from the service it is actually signing in to
//   - codes are never written to the log; audit.js redacts them, and the tool
//     that uses this returns the code to the model, not to disk

const DEFAULT_WINDOW_MINUTES = 10;

// Ordered by how sure we are. A number sitting next to the word "code" is a
// code; a bare six-digit run might be an order number, a year or a total, so it
// is only trusted when nothing better is there.
const PATTERNS = [
  // "your code is 123456", "verification code: 123-456"
  // 3 digits allowed in the first run so a split code like "219-483" matches;
  // the length check below still rejects a bare 3-digit number.
  /(?:verification|security|one[- ]time|login|sign[- ]?in|auth(?:entication)?|confirmation|access)\s*code\s*(?:is|:)?\s*([0-9]{3,8}(?:[- ][0-9]{3,4})?)/i,
  // "code: 123456" / "code 123456"
  /\bcode\s*(?:is|:)?\s*([0-9]{4,8})\b/i,
  // "123456 is your ... code"
  /\b([0-9]{4,8})\s+is\s+your\b[^.\n]{0,40}\bcode\b/i,
  // "G-123456" — Google's shape, and a few others copy it
  /\b[A-Z]-([0-9]{4,8})\b/,
  // last resort: a lone run of digits on its own line
  /^\s*([0-9]{6,8})\s*$/m,
];

// Anything with these in the body is talking ABOUT codes rather than carrying
// one — security notices, help articles, marketing about 2FA.
const NOT_A_CODE = /unsubscribe|did not request|didn['’]t request|was not you|password was changed|help\.|support article/i;

function extract(text) {
  const body = String(text || '');
  for (const re of PATTERNS) {
    const m = body.match(re);
    if (m && m[1]) {
      const code = m[1].replace(/[- ]/g, '');
      // Four to eight digits. Longer is a phone number or an order reference.
      if (code.length >= 4 && code.length <= 8) return code;
    }
  }
  return null;
}

// The phone on its own. In memory, so checking costs nothing and it can be
// polled often while waiting.
function fromPhone(phone, from) {
  if (!phone || !phone.status || !phone.status().on) return null;
  const msg = phone.take({ from });
  if (!msg) return null;
  const code = extract(msg.text);
  if (!code) return null;
  return {
    ok: true, code, from: msg.from, subject: '(text message)',
    date: new Date(msg.at).toISOString(),
    age: Math.round((Date.now() - msg.at) / 1000),
    via: 'phone',
  };
}

// Look through the newest messages for one carrying a code.
//
// `email` is the same object agent.js already holds — { list, read } — so this
// does not open its own connection or need the password.
async function findCode({ email, phone, within = DEFAULT_WINDOW_MINUTES, from = null, scan = 8 }) {
  const texted = fromPhone(phone, from);
  if (texted) return texted;

  if (!email || !email.list) {
    return { ok: false, error: 'No code has arrived from your phone, and no mailbox is connected. Pair a phone or connect email in Settings → Connectors.' };
  }

  let rows;
  try {
    // tab:'all' because a code lands in Updates on Gmail far more often than in
    // Primary, and the default view would never show it.
    rows = await email.list({ limit: scan, tab: 'all' });
  } catch (err) {
    return { ok: false, error: `Could not read the mailbox: ${(err && err.message) || err}` };
  }

  const cutoff = Date.now() - within * 60 * 1000;
  const wanted = from ? String(from).toLowerCase() : null;

  for (const row of rows || []) {
    const when = row.date ? Date.parse(row.date) : NaN;
    if (Number.isFinite(when) && when < cutoff) continue;      // too old to be live

    const sender = `${row.from || ''} ${row.subject || ''}`.toLowerCase();
    if (wanted && !sender.includes(wanted)) continue;

    let full;
    try {
      full = await email.read({ uid: row.uid });
    } catch {
      continue;
    }

    const haystack = `${full.subject || ''}\n${full.body || ''}`;
    if (NOT_A_CODE.test(haystack) && !/\bcode\b/i.test(full.subject || '')) continue;

    const code = extract(haystack);
    if (code) {
      return {
        ok: true,
        code,
        from: full.from,
        subject: full.subject,
        date: full.date,
        // so the agent can say where it came from before using it
        age: Number.isFinite(when) ? Math.round((Date.now() - when) / 1000) : null,
        via: 'email',
      };
    }
  }

  return {
    ok: false,
    error: `No code has arrived in the last ${within} minutes${wanted ? ` from anything matching "${from}"` : ''}. It may not have been sent yet — wait a few seconds and look again.`,
  };
}


// Wait for a code instead of reporting there isn't one yet.
//
// A code arrives seconds after the step that triggers it, so coming back with
// "no code yet" just hands the problem to the user and stops the task. This
// holds the tool call open until one turns up.
//
// The two sources are polled at different rates on purpose: the phone is an
// in-memory buffer so it is cheap to check constantly, while each email check
// is an IMAP round trip and hammering it is both slow and rude to the server.
async function waitForCode({ email, phone, from = null, within = DEFAULT_WINDOW_MINUTES,
                             timeout = 120, abortController = null }) {
  const PHONE_EVERY = 1500;
  const EMAIL_EVERY = 8000;
  const deadline = Date.now() + Math.max(5, Math.min(timeout, 300)) * 1000;

  const haveEmail = Boolean(email && email.list);
  const havePhone = Boolean(phone && phone.status && phone.status().on);
  if (!haveEmail && !havePhone) {
    return { ok: false, error: 'Nowhere to read a code from. Pair a phone or connect email in Settings → Connectors.' };
  }

  let nextEmail = 0;   // check email immediately on the first pass

  while (Date.now() < deadline) {
    if (abortController && abortController.signal.aborted) {
      return { ok: false, error: 'Stopped while waiting for the code.' };
    }

    const texted = fromPhone(phone, from);
    if (texted) return texted;

    if (haveEmail && Date.now() >= nextEmail) {
      nextEmail = Date.now() + EMAIL_EVERY;
      try {
        const found = await findCode({ email, phone: null, within, from });
        if (found.ok) return found;
      } catch { /* a blip on one poll is not a failure; try again */ }
    }

    await new Promise((r) => setTimeout(r, PHONE_EVERY));
  }

  const waited = Math.round(Math.max(5, Math.min(timeout, 300)));
  return {
    ok: false,
    error: `Waited ${waited}s and no code arrived${from ? ` from anything matching "${from}"` : ''}. ` +
      (havePhone ? 'Check the text actually reached Operator — Settings → Connectors should say Paired. ' : '') +
      'It may have gone somewhere Operator cannot see, in which case ask the user to read it out.',
  };
}

module.exports = { findCode, waitForCode, extract };
