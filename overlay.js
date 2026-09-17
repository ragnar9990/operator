// overlay.js — the agent's purple cursor, drawn on top of everything.
//
// A transparent, click-through window stretched across every monitor. It draws
// where Operator is pointing so you can tell its movements from your own.
//
// Two details make it work rather than get in the way:
//   * setIgnoreMouseEvents — clicks pass straight through to whatever is under it.
//   * setContentProtection — Windows excludes the window from screen capture, so
//     the agent never photographs its own cursor and tries to click it.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

let win = null;
let origin = { x: 0, y: 0 };

// Same ordering the PowerShell helper uses — primary first, then left to right
// — so "display 2" means the same monitor on both sides.
function displays() {
  return screen.getAllDisplays().slice().sort((a, b) => {
    const primary = screen.getPrimaryDisplay().id;
    if (a.id === primary) return -1;
    if (b.id === primary) return 1;
    return a.bounds.x - b.bounds.x;
  });
}

function create() {
  if (win && !win.isDestroyed()) return win;

  // Cover the whole virtual desktop, which can start at a negative x when a
  // second monitor sits to the left of the primary.
  const all = displays();
  const left = Math.min(...all.map((d) => d.bounds.x));
  const top = Math.min(...all.map((d) => d.bounds.y));
  const right = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  origin = { x: left, y: top };

  win = new BrowserWindow({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: false,
    webPreferences: {
      preload: path.join(__dirname, 'cursor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: false });
  // Above full-screen apps and the taskbar, not just ordinary windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'ui', 'cursor.html'));

  win.on('closed', () => { win = null; });
  return win;
}

// Scaled display coordinates (what the agent sees and clicks) -> a pixel inside
// the overlay window. Mirrors ConvertTo-Physical in desktop-helper.ps1.
function toOverlay(x, y, index) {
  const all = displays();
  const d = all[Math.max(0, Math.min(all.length - 1, (index || 1) - 1))];
  if (!d) return null;

  const scale = d.bounds.width <= 1280 ? 1 : 1280 / d.bounds.width;
  return {
    x: Math.round(d.bounds.x + x / scale) - origin.x,
    y: Math.round(d.bounds.y + y / scale) - origin.y,
  };
}

function show(pointer) {
  const w = create();
  const at = toOverlay(pointer.x, pointer.y, pointer.display);
  if (!at || w.isDestroyed()) return;
  if (!w.isVisible()) w.showInactive();      // never steal focus
  w.webContents.send('cursor-move', { ...at, ms: pointer.ms, action: pointer.action });
}

function hide() {
  if (win && !win.isDestroyed()) win.webContents.send('cursor-hide');
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { create, show, hide, destroy };
