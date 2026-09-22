// email.js — the email connector. Gives the agents a real inbox: list and read
// messages over IMAP, send over SMTP. Credentials come from the settings store
// and never leave this machine.
//
// Providers are matched by the address domain so the user only types their email
// and an app password; the server details are filled in for them.

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

const PROVIDERS = {
  'gmail.com':      { imap: 'imap.gmail.com',        smtp: 'smtp.gmail.com',        label: 'Gmail', appPassword: true },
  'googlemail.com': { imap: 'imap.gmail.com',        smtp: 'smtp.gmail.com',        label: 'Gmail', appPassword: true },
  'outlook.com':    { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',     label: 'Outlook' },
  'hotmail.com':    { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',     label: 'Outlook' },
  'live.com':       { imap: 'outlook.office365.com', smtp: 'smtp.office365.com',     label: 'Outlook' },
  'yahoo.com':      { imap: 'imap.mail.yahoo.com',   smtp: 'smtp.mail.yahoo.com',    label: 'Yahoo', appPassword: true },
  'icloud.com':     { imap: 'imap.mail.me.com',      smtp: 'smtp.mail.me.com',       label: 'iCloud', appPassword: true },
  'me.com':         { imap: 'imap.mail.me.com',      smtp: 'smtp.mail.me.com',       label: 'iCloud', appPassword: true },
};

function providerFor(email) {
  const domain = String(email || '').split('@')[1] || '';
  return PROVIDERS[domain.toLowerCase()] || null;
}

// Fill in server details from the address when the user didn't give them.
function resolve(cfg) {
  const p = providerFor(cfg.email);
  return {
    email: cfg.email,
    password: cfg.password,
    // When the account was connected with "Sign in with Google", we authenticate
    // over IMAP/SMTP with an OAuth access token (XOAUTH2) rather than a password.
    oauth: Boolean(cfg.oauth),
    accessToken: cfg.accessToken,
    imapHost: cfg.imapHost || (p && p.imap),
    imapPort: cfg.imapPort || 993,
    smtpHost: cfg.smtpHost || (p && p.smtp),
    smtpPort: cfg.smtpPort || 465,
    name: cfg.name || cfg.email,
  };
}

// user/pass, or user/accessToken for an OAuth account — the shape imapflow and
// nodemailer both accept for XOAUTH2.
function authFor(c) {
  return c.oauth ? { user: c.email, accessToken: c.accessToken } : { user: c.email, pass: c.password };
}

async function withImap(cfg, fn) {
  const c = resolve(cfg);
  if (!c.imapHost) throw new Error('unknown email provider — set the IMAP server manually');
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: true,
    auth: authFor(c),
    logger: false,
    emitLogs: false,
    // Fail fast: a wrong password, wrong server or blocked port must not leave
    // the connect hanging — the UI is waiting on it.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
  // ImapFlow emits 'error' on the client; with no listener Node turns that into
  // an uncaught exception that takes the whole app down. Swallow it — the
  // connect()/command promises already reject with the same failure.
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Prove the credentials work, and report which provider we matched.
async function test(cfg) {
  const c = resolve(cfg);
  if (!c.imapHost) return { ok: false, error: 'unknown email provider — could not guess the server from the address' };
  try {
    await withImap(cfg, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      lock.release();
    });
    // SMTP too, so "connected" means it can actually send, not just read.
    const t = nodemailer.createTransport({
      host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465,
      auth: { user: c.email, pass: c.password },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    await t.verify();
    const p = providerFor(cfg.email);
    return { ok: true, provider: (p && p.label) || 'email', email: c.email };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

function friendly(err) {
  const parts = [
    err && err.message, err && err.responseText, err && err.response,
    err && err.serverResponseCode, err && err.authenticationFailed ? 'authentication failed' : '',
  ].filter(Boolean).map(String).join(' ');
  const m = parts || String(err);
  if ((err && err.authenticationFailed) || /invalid credentials|authentication failed|AUTHENTICATIONFAILED|535|BadCredentials|Command failed/i.test(m)) {
    return 'the email or password was rejected. For Gmail, Yahoo and iCloud you must use an app password (made with 2-step verification on), not your normal password.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(m)) return 'could not reach the mail server — check the address and your connection.';
  if (/tim(e|ed) ?out|ETIMEDOUT/i.test(m)) return 'the mail server did not respond — check the server address and that the port is not blocked.';
  return m;
}

// The newest messages in a mailbox, envelopes only (fast, no bodies).
// Gmail's tabs are labels, not folders — IMAP's INBOX holds all of them mixed
// together, which is why "the latest email" from IMAP often isn't the one at the
// top of what the user is actually looking at.
const TABS = {
  primary: 'CATEGORY_PERSONAL',
  social: 'CATEGORY_SOCIAL',
  promotions: 'CATEGORY_PROMOTIONS',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
};

// Only claim a tab we can actually prove from the labels — guessing "primary"
// for anything uncategorised is what made the listing lie about where mail sat.
function tabOf(labels) {
  if (!labels) return null;
  const has = (l) => (labels.has ? labels.has(l) : Array.isArray(labels) && labels.includes(l));
  for (const [name, label] of Object.entries(TABS)) if (has(label)) return name;
  return null;
}

async function list({ cfg, mailbox = 'INBOX', limit = 15, unreadOnly = false, tab = undefined }) {
  const isGmail = (providerFor(cfg.email) || {}).label === 'Gmail';

  // On Gmail, "my inbox" means the Primary tab — that is the list the user is
  // looking at. Defaulting to the raw IMAP INBOX surfaces promotions and social
  // as "latest", which is never what they meant. Pass tab:"all" for everything.
  let wanted = tab === undefined ? (isGmail && mailbox === 'INBOX' ? 'primary' : 'all') : String(tab).toLowerCase().trim();
  if (wanted === 'all' || wanted === 'any' || !TABS[wanted]) wanted = TABS[wanted] ? wanted : null;

  return withImap(cfg, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const out = [];

      // Ask Gmail directly for a tab when one is in play — far more accurate than
      // filtering after the fact, and it searches the whole mailbox.
      let search;
      if (wanted && TABS[wanted]) {
        search = { gmraw: `category:${wanted}${unreadOnly ? ' is:unread' : ''}` };
      } else {
        search = unreadOnly ? { seen: false } : { all: true };
      }

      let uids = [];
      try {
        uids = (await client.search(search, { uid: true })) || [];
      } catch (_) {
        // Server without Gmail extensions: fall back to the plain search.
        uids = (await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true })) || [];
      }

      // Take a generous slice by UID (arrival order) then sort properly by date,
      // because the two disagree often enough to put the wrong mail on top.
      uids.sort((a, b) => a - b);
      uids = uids.slice(-Math.max(limit * 3, 40));
      if (!uids.length) return [];

      for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true, labels: true }, { uid: true })) {
        const e = msg.envelope || {};
        out.push({
          uid: msg.uid,
          from: (e.from && e.from[0] && (e.from[0].name || e.from[0].address)) || '(unknown)',
          fromAddress: (e.from && e.from[0] && e.from[0].address) || '',
          subject: e.subject || '(no subject)',
          date: e.date ? new Date(e.date).toISOString() : null,
          unread: !(msg.flags && msg.flags.has('\\Seen')),
          tab: tabOf(msg.labels),
        });
      }

      // Newest first by the date the user sees, falling back to UID.
      out.sort((a, b) => {
        const da = a.date ? Date.parse(a.date) : 0;
        const db = b.date ? Date.parse(b.date) : 0;
        return db - da || b.uid - a.uid;
      });
      return out.slice(0, limit);
    } finally {
      lock.release();
    }
  });
}

// The folders on the account, so the agent can look somewhere other than INBOX.
async function mailboxes({ cfg }) {
  return withImap(cfg, async (client) => {
    const list = await client.list();
    return (list || [])
      .filter((b) => !b.flags || !b.flags.has('\\Noselect'))
      .map((b) => ({ path: b.path, name: b.name, special: b.specialUse || null }));
  });
}

// One message's text body, by UID.
async function read({ cfg, uid, mailbox = 'INBOX' }) {
  return withImap(cfg, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, source: false, bodyParts: ['text'] }, { uid: true });
      if (!msg) throw new Error('message not found');
      let text = '';
      const dl = await client.download(String(uid), 'text', { uid: true });
      if (dl && dl.content) {
        for await (const chunk of dl.content) text += chunk.toString('utf8');
      }
      const e = msg.envelope || {};
      return {
        uid,
        from: (e.from && e.from[0] && (e.from[0].name || e.from[0].address)) || '(unknown)',
        to: (e.to || []).map((t) => t.address).join(', '),
        subject: e.subject || '(no subject)',
        date: e.date ? new Date(e.date).toISOString() : null,
        body: text.slice(0, 8000).trim() || '(no readable text body)',
      };
    } finally {
      lock.release();
    }
  });
}

async function send({ cfg, to, subject, body }) {
  const c = resolve(cfg);
  if (!c.smtpHost) throw new Error('unknown email provider — set the SMTP server manually');
  const t = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465,
    auth: c.oauth
      ? { type: 'OAuth2', user: c.email, accessToken: c.accessToken }
      : { user: c.email, pass: c.password },
  });
  const info = await t.sendMail({ from: `${c.name} <${c.email}>`, to, subject, text: body });
  return { ok: true, id: info.messageId, to };
}

module.exports = { test, list, read, send, mailboxes, providerFor };
