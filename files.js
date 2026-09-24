// files.js — the file system, for the editor panel in Code mode.
//
// The editor reads and writes the user's own files on their own machine, so it
// is not fenced to a project the way the model's file tools are. What it does
// get is sensible limits (no multi-megabyte blobs pushed into a textarea) and a
// Recycle Bin instead of unlink, so a mis-click in a file tree can be undone.

const fs = require('fs');
const path = require('path');
const { dialog, shell } = require('electron');

const TEXT_MAX = 2 * 1024 * 1024;
const IMAGE_MAX = 15 * 1024 * 1024;
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
// Clutter Windows leaves in every folder, and the one folder nobody edits by hand.
const HIDDEN = new Set(['.git', 'desktop.ini', 'Thumbs.db']);
// Changes under these fire constantly during an install or a build and mean
// nothing to someone reading the tree.
const NOISY = /[\\/](node_modules|\.git|\.next|dist|build|out|__pycache__|\.cache)([\\/]|$)/;
// Characters Windows will not have in a name.
const BAD_NAME = /[<>:"|?*\\/]/;

function register(ipcMain, { getWin, send }) {
  ipcMain.handle('fs:list', async (_e, dir) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return {
        ok: true,
        entries: entries
          .filter((e) => !HIDDEN.has(e.name))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
          .sort((a, b) => (a.dir === b.dir
            ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            : a.dir ? -1 : 1)),
      };
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'That folder is gone.' : err.message };
    }
  });

  ipcMain.handle('fs:stat', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      return { ok: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch (_) {
      return { ok: false };
    }
  });

  ipcMain.handle('fs:read', async (_e, file) => {
    try {
      const st = await fs.promises.stat(file);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
      if (mime) {
        if (st.size > IMAGE_MAX) return { ok: true, kind: 'big', size: st.size };
        const b = await fs.promises.readFile(file);
        return { ok: true, kind: 'image', url: `data:${mime};base64,${b.toString('base64')}`, size: st.size, mtime: st.mtimeMs };
      }
      if (st.size > TEXT_MAX) return { ok: true, kind: 'big', size: st.size };
      const b = await fs.promises.readFile(file);
      // A NUL in the first few KB is as good a test for "binary" as any.
      if (b.subarray(0, 8000).includes(0)) return { ok: true, kind: 'binary', size: st.size };
      return { ok: true, kind: 'text', text: b.toString('utf8'), size: st.size, mtime: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'That file is gone.' : err.message };
    }
  });

  ipcMain.handle('fs:write', async (_e, file, text) => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, String(text ?? ''), 'utf8');
      const st = await fs.promises.stat(file);
      return { ok: true, mtime: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:create', async (_e, dir, name, isDir) => {
    const clean = String(name || '').trim();
    // Slashes are allowed here, so "src/app.js" makes the folder on the way.
    if (!clean || /[<>:"|?*]/.test(clean)) return { ok: false, error: 'That is not a usable name.' };
    const full = path.join(dir, clean);
    if (fs.existsSync(full)) return { ok: false, error: 'Something with that name is already there.' };
    try {
      if (isDir) {
        await fs.promises.mkdir(full, { recursive: true });
      } else {
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, '', 'utf8');
      }
      return { ok: true, path: full };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:rename', async (_e, from, name) => {
    const clean = String(name || '').trim();
    if (!clean || BAD_NAME.test(clean)) return { ok: false, error: 'That is not a usable name.' };
    const to = path.join(path.dirname(from), clean);
    if (to !== from && fs.existsSync(to)) return { ok: false, error: 'Something with that name is already there.' };
    try {
      await fs.promises.rename(from, to);
      return { ok: true, path: to };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:trash', async (_e, p) => {
    try { await shell.trashItem(p); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('fs:reveal', async (_e, p) => { shell.showItemInFolder(p); return { ok: true }; });
  // Opens with whatever Windows opens it with — an .html file in the browser.
  ipcMain.handle('fs:openExternal', async (_e, p) => {
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // A link in a reply opens in the user's own browser — web links only, never
  // a file: or javascript: URL dressed up as one.
  ipcMain.handle('fs:openUrl', async (_e, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false };
    await shell.openExternal(String(url));
    return { ok: true };
  });

  ipcMain.handle('fs:pickFolder', async () => {
    const res = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths.length ? { ok: false } : { ok: true, path: res.filePaths[0] };
  });
  ipcMain.handle('fs:pickFiles', async () => {
    const res = await dialog.showOpenDialog(getWin(), { properties: ['openFile', 'multiSelections'] });
    return res.canceled || !res.filePaths.length ? { ok: false } : { ok: true, paths: res.filePaths };
  });

  // One watcher, on whatever folder the editor has open. Changes are batched
  // and sent as a set of paths, so the tree and any open file keep up with the
  // agent (or anything else) writing underneath them.
  let watcher = null;
  let pending = new Set();
  let timer = null;
  ipcMain.handle('fs:watch', async (_e, root) => {
    if (watcher) { try { watcher.close(); } catch (_) { /* already gone */ } watcher = null; }
    if (!root) return { ok: true };
    try {
      watcher = fs.watch(root, { recursive: true }, (_type, rel) => {
        if (!rel) return;
        const full = path.join(root, String(rel));
        if (NOISY.test(full)) return;
        pending.add(full);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = [...pending];
          pending = new Set();
          send('fs-changed', { root, paths });
        }, 180);
      });
      watcher.on('error', () => { /* the folder went away; the tree will say so */ });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { register };
