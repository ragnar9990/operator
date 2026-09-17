// Dev-only. Serves ui/ over http so the front end can be opened and
// screenshotted in an ordinary browser, with the Electron preload and the
// microphone faked out by ui/_preview-stub.js.
//
//   node ui-preview.js     →  http://localhost:4321
//
// index.html is rewritten on the way out, so this never goes stale when the
// real page changes. Excluded from the packaged app via package.json build.files.

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'ui');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function page() {
  return fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<script src="mic.js"></script>', '<script src="_preview-stub.js"></script>');
}

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);

  if (rel === '/' || rel === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(page());
  }

  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('no'); }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(4321, () => console.log('UI preview on http://localhost:4321'));
