// web.js — looking things up without a browser: a web search and a page read,
// both plain HTTP requests from this process. Employees work with these
// instead of the screen and the browser (agent.js), so a check-in never takes
// over anything you can see, and never touches your own browser.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 15000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}
const strip = (html) => decode(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function get(url, accept) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en', accept: accept || 'text/html,*/*' } });
  } finally {
    clearTimeout(timer);
  }
}

// DuckDuckGo's plain-HTML results page: no key, no browser. Ads are dropped.
async function search(query, count = 8) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Say what to search for.');
  const res = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
  if (!res.ok) throw new Error(`The search did not answer (${res.status}). Try again in a moment.`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < Math.min(20, Math.max(1, count))) {
    let url = decode(m[1]);
    const real = url.match(/[?&]uddg=([^&]+)/);
    if (real) url = decodeURIComponent(real[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js|[?&]ad_domain=/.test(url)) continue;   // an ad
    const snip = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: strip(m[2]), url, snippet: snip ? strip(snip[1]) : '' });
  }
  return out;
}

// Somewhere on this machine or its network is not the web — a page could
// otherwise talk an employee into poking at the router or a local service.
function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('That is not a web address. Give the full link, starting https://'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https pages can be read.');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || (/^f[cd]/.test(h) && h.includes(':'))) {
    throw new Error('That address is on this computer or its local network, not the web.');
  }
  return u;
}

// A page as text: its title, the words, and the links on it (so the next
// page can be read the same way).
async function read(raw, max = 12000) {
  const u = publicUrl(raw);
  const res = await get(u.href);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`The page answered ${res.status}${res.statusText ? ' ' + res.statusText : ''}.`);
  const final = res.url || u.href;
  const body = await res.text();
  if (!/html|xml/i.test(type)) {
    if (/json|text|csv/i.test(type) || !type) return { url: final, title: '', text: body.slice(0, max), links: [] };
    return { url: final, title: '', text: `This is a ${type.split(';')[0]} file, not a page with text to read.`, links: [] };
  }
  const title = strip((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const links = [];
  const seen = new Set();
  const lre = /<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = lre.exec(body)) && links.length < 40) {
    let href;
    try { href = new URL(decode(m[1]), final).href; } catch { continue; }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    const text = strip(m[2]);
    if (!text) continue;
    seen.add(href);
    links.push({ text: text.slice(0, 80), href });
  }
  const text = decode(body
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
  return { url: final, title, text: text.length > max ? text.slice(0, max) + '\n… (cut short)' : text, links };
}

module.exports = { search, read };
