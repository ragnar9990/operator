// google-oauth.js — "Sign in with Google" for the email connector.
//
// The installed-app OAuth flow: we open the user's real browser to Google's
// consent page (so THEY choose the account and type their own password — this
// app never sees it), catch the redirect on a localhost loopback, and swap the
// one-time code for a refresh token we can keep. PKCE + a random state guard the
// exchange. No SDK: Node's http + global fetch + Electron's shell are enough.
//
// Scope is https://mail.google.com/, which is what Gmail's IMAP/SMTP need for
// XOAUTH2 — that lets the existing email.js read and send with a token instead
// of an app password. We also ask for openid/email just to learn which address
// was chosen.

const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = ['https://mail.google.com/', 'openid', 'email'];

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The account email is carried in the id_token (a JWT); read its payload rather
// than making a second round trip to the userinfo endpoint.
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json.email || null;
  } catch (_) {
    return null;
  }
}

// A tiny page shown in the browser tab once the redirect lands.
function closePage(title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#131211;color:#fcfcfc;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><div style="font-size:15px;font-weight:600">${title}</div>` +
    `<div style="color:#9e9e9e;margin-top:6px;font-size:13px">You can close this tab and return to Operator.</div></div>`;
}

// Open Google, wait for the redirect, return { email, refreshToken, accessToken, expiry }.
function signIn({ clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    if (!clientId || !clientSecret) {
      reject(new Error('Add your Google client ID and secret first.'));
      return;
    }

    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    let port = 0;
    let timer = null;
    const cleanup = () => { if (timer) clearTimeout(timer); try { server.close(); } catch (_) {} };

    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { res.end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (!code && !error) { res.end(); return; } // favicon and the like

      const finish = (title) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(closePage(title)); };

      if (error) { finish('Sign-in cancelled'); cleanup(); reject(new Error('sign-in was cancelled')); return; }
      if (url.searchParams.get('state') !== state) { finish('Sign-in failed'); cleanup(); reject(new Error('sign-in could not be verified (state mismatch)')); return; }

      try {
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}`,
        });
        const r = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const tok = await r.json();
        if (!r.ok) { finish('Sign-in failed'); cleanup(); reject(new Error(tok.error_description || tok.error || 'token exchange failed')); return; }
        if (!tok.refresh_token) {
          finish('Sign-in failed');
          cleanup();
          reject(new Error('Google did not return a refresh token — remove Operator at myaccount.google.com/permissions and try again.'));
          return;
        }
        finish('Signed in');
        cleanup();
        resolve({
          email: emailFromIdToken(tok.id_token),
          refreshToken: tok.refresh_token,
          accessToken: tok.access_token,
          expiry: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
        });
      } catch (err) {
        try { res.end(); } catch (_) {}
        cleanup();
        reject(err);
      }
    });

    server.on('error', (err) => { cleanup(); reject(err); });

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // select_account shows the chooser every time; consent forces a fresh
        // refresh token even if the user has approved before.
        prompt: 'select_account consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      shell.openExternal(`${AUTH_URL}?${params.toString()}`);
      timer = setTimeout(() => { cleanup(); reject(new Error('sign-in timed out — no response after 5 minutes')); }, 5 * 60 * 1000);
    });
  });
}

// Trade the long-lived refresh token for a fresh access token.
async function refresh({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tok = await r.json();
  if (!r.ok) throw new Error(tok.error_description || tok.error || 'token refresh failed');
  return { accessToken: tok.access_token, expiry: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
}

module.exports = { signIn, refresh, SCOPES };
