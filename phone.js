// phone.js — a small listener the user's phone can push texts to.
//
// Reading SMS off a phone properly means writing, signing and installing an app
// on every phone. Every phone already ships with automation that can make an
// HTTP request when a message arrives — Shortcuts on iOS, MacroDroid or Tasker
// on Android — so the phone does the pushing and Operator just listens. No app
// to build, and it works on iPhone, which nothing else here does.
//
// This opens a port on the local network, so it is off until switched on, and:
//   - every request must carry the pairing token, which is random per machine
//   - only two routes exist, and only one accepts data
//   - bodies over 4KB are refused before being read
//   - messages live in memory for a few minutes and are never written to disk
//   - a code is used once; asking for it again does not return it
//
// It is a letterbox, not a server: nothing here can read the phone, only accept
// what the phone chooses to send.

const http = require('http');
const crypto = require('crypto');

const PORT = 8392;
const TTL_MS = 10 * 60 * 1000;   // a code older than this is no use anyway
const MAX_KEPT = 20;
const MAX_BODY = 4096;

let server = null;
let token = null;
let inbox = [];                  // { at, from, text, used }
let lastSeen = null;             // when a phone last reached us, for the UI

function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  inbox = inbox.filter((m) => m.at >= cutoff).slice(-MAX_KEPT);
}

// Constant-time compare so the token cannot be guessed a character at a time.
function tokenOk(given) {
  if (!token || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Content-Length is a hint, not a guarantee, so the running total below is
    // what actually enforces the cap.
    const claimed = Number(req.headers['content-length'] || 0);
    if (claimed > MAX_BODY) return reject(new Error('too large'));

    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Stop buffering, but let the request finish rather than tearing the
      // socket down — a phone's automation should get a clear 413, not a
      // connection error it will report as "Operator is unreachable".
      if (size > MAX_BODY) { over = true; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function handle(req, res) {
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj || {}));
  };

  const url = (req.url || '').split('?')[0];
  const given = req.headers['x-operator-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!tokenOk(given)) return reply(401, { error: 'bad or missing token' });
  lastSeen = Date.now();

  // For checking the pairing works before trusting it with anything.
  if (url === '/ping') return reply(200, { ok: true });

  if (url === '/sms' && req.method === 'POST') {
    return readBody(req).then((raw) => {
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: 'expected JSON' }); }
      const text = String(body.text || body.message || '').slice(0, 1000);
      if (!text.trim()) return reply(400, { error: 'no text' });
      inbox.push({ at: Date.now(), from: String(body.from || 'a text').slice(0, 120), text, used: false });
      prune();
      // Deliberately does not echo the text back.
      return reply(200, { ok: true });
    }).catch(() => reply(413, { error: 'too large' }));
  }

  return reply(404, { error: 'no such route' });
}

function start() {
  if (server) return status();
  if (!token) token = newToken();
  server = http.createServer(handle);
  server.on('error', (err) => { console.error('phone listener:', err.message); stop(); });
  // 0.0.0.0 because the phone is on the network, not on this machine. The token
  // is what keeps it shut, not the binding.
  server.listen(PORT, '0.0.0.0');
  return status();
}

function stop() {
  if (server) { try { server.close(); } catch { /* already gone */ } }
  server = null;
  inbox = [];
  return status();
}

// Rotating the token is how you un-pair a phone you no longer have.
function rotate() {
  token = newToken();
  return status();
}

// The newest unused message, oldest-first scan so a queue drains in order.
// Marked used on the way out: a one-time code really is one-time, and handing
// the same one back twice is how a retry loop gets stuck.
function take({ from = null } = {}) {
  prune();
  const wanted = from ? String(from).toLowerCase() : null;
  for (let i = inbox.length - 1; i >= 0; i--) {
    const m = inbox[i];
    if (m.used) continue;
    if (wanted && !`${m.from} ${m.text}`.toLowerCase().includes(wanted)) continue;
    m.used = true;
    return { from: m.from, text: m.text, at: m.at };
  }
  return null;
}

function localAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function status() {
  prune();
  return {
    on: Boolean(server),
    port: PORT,
    token,
    addresses: localAddresses(),
    waiting: inbox.filter((m) => !m.used).length,
    lastSeen,
  };
}

module.exports = { start, stop, rotate, status, take, PORT };
