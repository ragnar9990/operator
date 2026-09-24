// boot.js — loaded in <head> as a plain blocking script, so it still runs before
// anything paints. It used to be inline; it lives here so the Content Security
// Policy can allow scripts from this folder and nothing else.

// Runs before anything paints. The real preferences live in the profile,
// but reading those is async — long enough for the default theme to flash
// up first. The renderer mirrors them here, so this reads the mirror.
try {
  var p = JSON.parse(localStorage.getItem('prefs') || '{}');
  var d = document.documentElement.dataset;
  d.theme = p.theme || 'warm';
  d.accent = p.accent || 'blue';
  d.glow = p.glow || 'full';
  d.edge = p.edge || 'accent';
  d.motion = p.motion || 'on';
} catch (e) { /* first run, or storage blocked */ }
