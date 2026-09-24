/* The editor panel in Code mode — Operator's own, no library.
 *
 * A file tree on the left, tabs and a code view on the right. The code view is
 * the usual trick: a transparent textarea laid exactly over a highlighted
 * <pre>, so typing, selection, undo and IME are all the browser's own, and the
 * colour is ours. Both sit in one scroller, so they can never drift apart.
 *
 * It keeps up with the agent: the folder is watched, a file the agent writes
 * is reloaded under you (unless you have unsaved changes, in which case it
 * asks), and with "follow" on, the file being written is opened as it happens.
 * Anything in the tree can be dragged into the chat to reference it.
 */

(function () {
  const LH = 20;          // line height, px — the whole layout is built on it
  const PAD_Y = 10;
  const PAD_X = 14;
  const HL_MAX = 200000;  // characters; past this, plain text is kinder than colour
  const IS_WIN = /win/i.test(navigator.platform);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  // Windows paths arrive with either slash and in any case; compare them the
  // way Windows does.
  const norm = (p) => (IS_WIN ? String(p).replace(/\//g, '\\').toLowerCase() : String(p));
  const same = (a, b) => norm(a) === norm(b);
  const under = (parent, child) => norm(child).startsWith(norm(parent).replace(/[\\/]+$/, '') + (IS_WIN ? '\\' : '/'));
  const rel = (root, p) => (root && under(root, p) ? p.slice(root.replace(/[\\/]+$/, '').length + 1) : p);

  const SVG = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
  const I = {
    folder: SVG('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/>'),
    folderOpen: SVG('<path d="M3 17.5V6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v1"/><path d="M3 17.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13a1 1 0 0 1 .95 1.3L19.3 17.9a1.5 1.5 0 0 1-1.4 1.1H4.5A1.5 1.5 0 0 1 3 17.5Z"/>'),
    file: SVG('<path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/>'),
    chev: SVG('<path d="m9.5 6 6 6-6 6"/>'),
    down: SVG('<path d="m7 10 5 5 5-5"/>'),
    newFile: SVG('<path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M12 11v6M9 14h6"/>'),
    newFolder: SVG('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M11 10.5v5M8.5 13h5"/>'),
    refresh: SVG('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    eye: SVG('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
    sidebar: SVG('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15"/>'),
    x: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
    up: SVG('<path d="m6 14 6-6 6 6"/>'),
    dn: SVG('<path d="m6 10 6 6 6-6"/>'),
    play: SVG('<path d="M7 5.5v13l11-6.5Z"/>'),
    search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
  };

  /* ── what kind of file is it ───────────────────────────────────── */

  const EXT_LANG = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', xaml: 'html',
    css: 'css', scss: 'css', less: 'css',
    py: 'py', pyw: 'py',
    md: 'md', markdown: 'md', mdx: 'md',
    sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', psm1: 'sh', psd1: 'sh', bat: 'sh', cmd: 'sh',
    c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'c', java: 'c', go: 'c', rs: 'c', php: 'c',
    rb: 'c', swift: 'c', kt: 'c', kts: 'c', dart: 'c', lua: 'c', scala: 'c', sql: 'c',
    yml: 'conf', yaml: 'conf', toml: 'conf', ini: 'conf', cfg: 'conf', conf: 'conf', env: 'conf', properties: 'conf', gitignore: 'conf',
  };
  const LANG_NAME = { js: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS', py: 'Python', md: 'Markdown', sh: 'Shell', c: 'Code', conf: 'Config', text: 'Plain text' };
  const COMMENT = { js: '//', c: '//', py: '#', sh: '#', conf: '#' };
  const ext = (p) => {
    const b = base(p).toLowerCase();
    if (b.startsWith('.env')) return 'env';
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1) : (i === 0 ? b.slice(1) : '');
  };
  const langOf = (p) => {
    const e = ext(p);
    if (/\.(ts|tsx|mts|cts)$/i.test(p)) return 'js';
    if (/(^|[\\/])(dockerfile|makefile)$/i.test(p)) return 'sh';
    return EXT_LANG[e] || 'text';
  };
  // A colour per kind of file, so a tree of them can be read at a glance.
  const TINT = {
    js: '#e8c547', mjs: '#e8c547', cjs: '#e8c547', jsx: '#5ccfe6', ts: '#4d8fe8', tsx: '#4d8fe8',
    json: '#e5a13a', html: '#e8683f', htm: '#e8683f', css: '#4ba3e8', scss: '#d66fa4', less: '#4ba3e8',
    py: '#5a9fd6', md: '#9aa4b2', svg: '#e6a13a', png: '#b98cf0', jpg: '#b98cf0', jpeg: '#b98cf0',
    gif: '#b98cf0', webp: '#b98cf0', ico: '#b98cf0', sh: '#5fd38d', ps1: '#5a8ee8', bat: '#5fd38d',
    cmd: '#5fd38d', yml: '#e06c75', yaml: '#e06c75', toml: '#e06c75', env: '#e5c07b', txt: '#9aa4b2',
    go: '#5ccfe6', rs: '#e8905a', java: '#e8683f', cs: '#9b6ce8', c: '#6f93d6', cpp: '#6f93d6', php: '#8892bf',
  };

  /* ── the highlighter ───────────────────────────────────────────────
     One regex per language, each alternative a named group; whichever group
     matched is the class. Not a parser — it never has to be right about
     nesting, only about what a person expects to see coloured. "End of input"
     is written (?![\s\S]) rather than $, because $ means end of line here. */

  const EOI = '(?![\\s\\S])';
  const alt = (parts) => new RegExp(
    Object.entries(parts).map(([k, re]) => `(?<${k}>${typeof re === 'string' ? re : re.source})`).join('|'), 'gm');

  const STR_D = /"(?:\\.|[^\\"\n])*"?/.source;
  const STR_S = /'(?:\\.|[^\\'\n])*'?/.source;
  const NUM = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[nLlFfDdUu]?)\b/.source;
  const BLOCK = '\\/\\*[\\s\\S]*?(?:\\*\\/|' + EOI + ')';

  const LANGS = {
    js: alt({
      com: '\\/\\/[^\\n]*|' + BLOCK,
      str: '`(?:\\\\[\\s\\S]|[^\\\\`])*`?|' + STR_D + '|' + STR_S,
      num: NUM,
      kw: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|delete|void|static|get|set|interface|type|enum|implements|public|private|protected|readonly|as|declare|namespace|keyof|abstract|satisfies)\b/,
      lit: /\b(?:true|false|null|undefined|NaN|Infinity)\b/,
      type: /\b[A-Z][A-Za-z0-9_]*\b/,
      fn: /\b[a-zA-Z_$][\w$]*(?=\s*\()/,
    }),
    json: alt({
      key: /"(?:\\.|[^\\"\n])*"(?=\s*:)/,
      str: STR_D,
      num: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,
      lit: /\b(?:true|false|null)\b/,
      com: '\\/\\/[^\\n]*|' + BLOCK,
    }),
    html: alt({
      com: '<!--[\\s\\S]*?(?:-->|' + EOI + ')',
      tag: /<\/?[A-Za-z][\w:.-]*|\/?>/,
      attr: /\b[\w:@.-]+(?=\s*=)/,
      str: /"[^"]*"|'[^']*'/,
      ent: /&#?\w+;/,
    }),
    css: alt({
      com: BLOCK,
      str: STR_D + '|' + STR_S,
      at: /@[\w-]+/,
      color: /#[\da-fA-F]{3,8}\b/,
      prop: /--[\w-]+(?=\s*:)|\b[a-z-]+(?=\s*:\s*[^;{}]*[;}])/,
      num: /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|dpi)?\b/,
      fn: /\b[a-z-]+(?=\()/,
    }),
    py: alt({
      com: /#[^\n]*/,
      str: '[rRbBuUfF]{0,2}(?:"""[\\s\\S]*?(?:"""|' + EOI + ")|'''[\\s\\S]*?(?:'''|" + EOI + '))|[rRbBuUfF]{0,2}' + STR_D + '|[rRbBuUfF]{0,2}' + STR_S,
      dec: /@[\w.]+/,
      kw: /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|async|await|match|case|self)\b/,
      lit: /\b(?:True|False|None)\b/,
      num: NUM,
      type: /\b[A-Z][A-Za-z0-9_]*\b/,
      fn: /\b[a-zA-Z_]\w*(?=\s*\()/,
    }),
    sh: alt({
      com: /<#[\s\S]*?#>|(?:^|(?<=\s))#[^\n]*|^\s*(?:rem|REM|::)\b[^\n]*/,
      str: STR_D + '|' + STR_S,
      var: /\$\{[^}\n]*\}|\$[\w:]+|%\w+%/,
      kw: /\b(?:if|then|else|elif|fi|for|foreach|in|do|done|while|until|case|esac|function|return|param|begin|process|end|try|catch|finally|throw|switch|break|continue|exit|echo|export|local|set|call|goto|not|exist)\b/,
      fn: /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/,
      flag: /(?<=\s)-{1,2}[A-Za-z][\w-]*/,
      num: NUM,
    }),
    md: alt({
      code: '```[\\s\\S]*?(?:```|' + EOI + ')|`[^`\\n]*`',
      head: /^#{1,6}\s[^\n]*/,
      quote: /^>[^\n]*/,
      list: /^\s*(?:[-*+]|\d+\.)(?=\s)/,
      bold: /\*\*[^*\n]+\*\*|__[^_\n]+__/,
      em: /(?<![*\w])\*[^*\n]+\*(?!\*)|(?<![_\w])_[^_\n]+_(?![_\w])/,
      link: /!?\[[^\]\n]*\]\([^)\n]*\)/,
    }),
    c: alt({
      com: '\\/\\/[^\\n]*|' + BLOCK + '|^\\s*#(?!include|define|if|endif|pragma|else|elif|undef)[^\\n]*(?=\\n)',
      pre: /^\s*#\s*(?:include|define|if|ifdef|ifndef|endif|pragma|else|elif|undef)\b[^\n]*/,
      str: STR_D + '|' + STR_S,
      num: NUM,
      kw: /\b(?:int|float|double|char|void|bool|long|short|unsigned|signed|auto|struct|union|typedef|return|if|else|for|while|do|switch|case|break|continue|default|goto|class|public|private|protected|internal|static|const|final|virtual|override|new|delete|namespace|using|package|import|func|go|defer|chan|select|range|var|let|fn|impl|pub|mut|match|use|mod|trait|self|Self|enum|interface|extends|implements|throws|try|catch|finally|throw|async|await|def|end|module|require|elif|lambda|val|when|object|record|extern|sizeof|string|echo|function|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|INTO|VALUES|CREATE|TABLE|JOIN|ON|AND|OR|NOT|ORDER|BY|GROUP|LIMIT|AS|select|from|where|insert|update|into|values|create|table|join|and|or|not|order|by|group|limit|as)\b/,
      lit: /\b(?:true|false|null|nil|None|nullptr|undefined)\b/,
      type: /\b[A-Z][A-Za-z0-9_]*\b/,
      fn: /\b[a-zA-Z_]\w*(?=\s*\()/,
    }),
    conf: alt({
      com: /^\s*[#;][^\n]*|(?<=\s)#[^\n]*/,
      sec: /^\s*\[[^\]\n]*\]/,
      key: /^\s*[\w.$-]+(?=\s*[:=])/,
      str: STR_D + '|' + STR_S,
      lit: /\b(?:true|false|null|yes|no|on|off)\b/,
      num: NUM,
    }),
  };

  function highlight(src, lang) {
    const re = LANGS[lang];
    if (!re || src.length > HL_MAX) return esc(src);
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      let k = 'x';
      for (const g in m.groups) if (m.groups[g] !== undefined) { k = g; break; }
      out += `<span class="t-${k}">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  /* ── the panel ─────────────────────────────────────────────────── */

  function mount(el, hooks = {}) {
    const api = window.operator;
    const store = {
      get: (k, d) => { try { const v = localStorage.getItem('operator.editor.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
      set: (k, v) => { try { localStorage.setItem('operator.editor.' + k, JSON.stringify(v)); } catch (_) { /* fine */ } },
    };

    el.innerHTML = `
      <div class="ed-head">
        <button class="ed-root" type="button" title="Open another folder">${I.folder}<span class="ed-root-name">No folder</span>${I.down}</button>
        <span class="ed-flex"></span>
        <button class="ed-ic" data-a="newFile" type="button" title="New file">${I.newFile}</button>
        <button class="ed-ic" data-a="newFolder" type="button" title="New folder">${I.newFolder}</button>
        <button class="ed-ic" data-a="refresh" type="button" title="Refresh">${I.refresh}</button>
        <button class="ed-ic" data-a="follow" type="button" title="Follow the agent — open files as it writes them">${I.eye}</button>
        <button class="ed-ic" data-a="tree" type="button" title="Show or hide the file tree">${I.sidebar}</button>
        <button class="ed-ic" data-a="close" type="button" title="Close the editor (Ctrl+E)">${I.x}</button>
      </div>
      <div class="ed-body">
        <nav class="ed-tree" tabindex="-1" aria-label="Files"></nav>
        <section class="ed-pane">
          <div class="ed-tabs" role="tablist"></div>
          <div class="ed-find" hidden>
            ${I.search}<input type="text" placeholder="Find in file" spellcheck="false" aria-label="Find in file" />
            <span class="ed-find-n"></span>
            <button class="ed-ic" data-f="prev" type="button" title="Previous (Shift+Enter)">${I.up}</button>
            <button class="ed-ic" data-f="next" type="button" title="Next (Enter)">${I.dn}</button>
            <button class="ed-ic" data-f="close" type="button" title="Close (Esc)">${I.x}</button>
          </div>
          <div class="ed-view">
            <div class="ed-empty"></div>
            <div class="ed-scroll" hidden>
              <div class="ed-lines">
                <div class="ed-gutter" aria-hidden="true"></div>
                <div class="ed-layer">
                  <div class="ed-cur" aria-hidden="true"></div>
                  <div class="ed-marks" aria-hidden="true"></div>
                  <pre class="ed-hl" aria-hidden="true"><code></code></pre>
                  <textarea class="ed-ta" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" aria-label="File contents"></textarea>
                </div>
              </div>
            </div>
            <div class="ed-media" hidden></div>
          </div>
          <div class="ed-status">
            <span class="ed-st-path"></span>
            <span class="ed-st-msg"></span>
            <span class="ed-flex"></span>
            <button class="ed-st-run" type="button" hidden>${I.play}Open in browser</button>
            <span class="ed-st-pos"></span>
            <span class="ed-st-lang"></span>
          </div>
        </section>
      </div>
      <div class="ed-menu" hidden></div>
    `;

    const $ = (s) => el.querySelector(s);
    const tree = $('.ed-tree');
    const tabsEl = $('.ed-tabs');
    const emptyEl = $('.ed-empty');
    const scroller = $('.ed-scroll');
    const gutter = $('.ed-gutter');
    const layer = $('.ed-layer');
    const code = $('.ed-hl code');
    const ta = $('.ed-ta');
    const cur = $('.ed-cur');
    const marks = $('.ed-marks');
    const media = $('.ed-media');
    const menu = $('.ed-menu');
    const findBar = $('.ed-find');
    const findIn = findBar.querySelector('input');
    const findN = $('.ed-find-n');
    const stPath = $('.ed-st-path');
    const stMsg = $('.ed-st-msg');
    const stPos = $('.ed-st-pos');
    const stLang = $('.ed-st-lang');
    const stRun = $('.ed-st-run');

    let root = null;
    let open = false;
    const cache = new Map();       // dir -> entries
    const expandedByRoot = new Map();
    let expanded = new Set();
    const hot = new Map();         // path -> when the agent last wrote it
    let tabs = [];
    let active = null;             // the tab on screen
    let follow = store.get('follow', true);
    let treeShown = store.get('tree', true);
    let wantFollow = null;         // a file the agent is about to write
    let lineCount = 0;
    let cw = 7.5;                  // the width of one character, measured

    /* ── sizing the monospace grid ── */

    function measure() {
      const probe = document.createElement('span');
      probe.className = 'ed-probe';
      probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
      layer.appendChild(probe);
      cw = probe.getBoundingClientRect().width / 20 || cw;
      probe.remove();
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); paintCaret(); });

    /* ── the folder ── */

    async function load(dir) {
      const r = await api.fsList(dir);
      cache.set(dir, r && r.ok ? r.entries : []);
      return cache.get(dir);
    }

    function paintHead() {
      $('.ed-root-name').textContent = root ? base(root) : 'No folder';
      $('.ed-root').title = root ? root + ' — click to open another folder' : 'Open a folder';
      el.querySelector('[data-a="follow"]').classList.toggle('on', follow);
      el.querySelector('[data-a="tree"]').classList.toggle('on', treeShown);
      el.classList.toggle('no-tree', !treeShown);
    }

    async function setRoot(p) {
      if (p && root && same(p, root)) return;
      if (root) expandedByRoot.set(root, expanded);
      root = p || null;
      cache.clear();
      expanded = (root && expandedByRoot.get(root)) || new Set();
      paintHead();
      if (!open) return;
      if (root) {
        await load(root);
        await Promise.all([...expanded].map(load));
      }
      api.fsWatch(root);
      renderTree();
    }

    function tintOf(p) { return TINT[ext(p)] || 'var(--ink-4)'; }

    function rowHtml(e, depth) {
      const isOpen = e.dir && expanded.has(e.path);
      const cls = ['ed-row'];
      if (e.dir) cls.push('dir');
      if (isOpen) cls.push('open');
      if (active && same(active.path, e.path)) cls.push('active');
      if (tabs.some((t) => same(t.path, e.path))) cls.push('opened');
      if (hot.has(e.path) && Date.now() - hot.get(e.path) < 4000) cls.push('hot');
      if (/^(node_modules|\.|dist$|build$|out$|__pycache__)/.test(e.name)) cls.push('dim');
      return `<div class="${cls.join(' ')}" data-p="${esc(e.path)}" data-dir="${e.dir ? 1 : ''}" style="--d:${depth}" draggable="true" title="${esc(e.path)}">` +
        `<span class="ed-twist">${e.dir ? I.chev : ''}</span>` +
        `<span class="ed-fi" style="--c:${e.dir ? 'var(--ink-3)' : tintOf(e.path)}">${e.dir ? (isOpen ? I.folderOpen : I.folder) : I.file}</span>` +
        `<span class="ed-name">${esc(e.name)}</span></div>`;
    }

    function renderTree() {
      if (!root) {
        tree.innerHTML = `<div class="ed-tree-empty"><p>No folder open.</p><button class="ed-btn" data-a="pick" type="button">Open a folder</button></div>`;
        return;
      }
      const rows = [];
      const walk = (dir, depth) => {
        const list = cache.get(dir);
        if (!list) { rows.push(`<div class="ed-row ed-none" style="--d:${depth}">Loading…</div>`); return; }
        if (!list.length) rows.push(`<div class="ed-row ed-none" style="--d:${depth}">${depth ? 'Empty' : 'This folder is empty'}</div>`);
        for (const e of list) {
          rows.push(rowHtml(e, depth));
          if (e.dir && expanded.has(e.path)) walk(e.path, depth + 1);
        }
      };
      walk(root, 0);
      const keep = tree.scrollTop;
      tree.innerHTML = rows.join('');
      tree.scrollTop = keep;
    }

    async function toggleDir(p, force) {
      const want = force !== undefined ? force : !expanded.has(p);
      if (want) {
        expanded.add(p);
        if (!cache.has(p)) { renderTree(); await load(p); }
      } else expanded.delete(p);
      renderTree();
    }

    // Open every folder between the root and this path, so it can be seen.
    async function reveal(p) {
      if (!root || !under(root, p)) return;
      let d = dirname(p);
      const chain = [];
      while (d && under(root, d)) { chain.unshift(d); d = dirname(d); }
      for (const dir of chain) { expanded.add(dir); if (!cache.has(dir)) await load(dir); }
      renderTree();
      const row = tree.querySelector(`.ed-row[data-p="${CSS.escape(p)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    /* ── tabs ── */

    function tabHtml(t) {
      const cls = ['ed-tab'];
      if (t === active) cls.push('on');
      if (t.dirty) cls.push('dirty');
      if (t.preview) cls.push('preview');
      return `<div class="${cls.join(' ')}" data-p="${esc(t.path)}" role="tab" title="${esc(t.path)}">` +
        `<span class="ed-fi" style="--c:${tintOf(t.path)}">${I.file}</span>` +
        `<span class="ed-tab-name">${esc(base(t.path))}</span>` +
        `<button class="ed-tab-x" type="button" aria-label="Close">${I.x}</button></div>`;
    }

    function renderTabs() {
      tabsEl.innerHTML = tabs.map(tabHtml).join('');
      const on = tabsEl.querySelector('.ed-tab.on');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function stash() {
      if (!active || active.kind !== 'text') return;
      active.sel = [ta.selectionStart, ta.selectionEnd];
      active.scroll = [scroller.scrollTop, scroller.scrollLeft];
    }

    async function openFile(p, { preview = false, quiet = false } = {}) {
      if (!open) show();
      let t = tabs.find((x) => same(x.path, p));
      if (t) {
        if (!preview && t.preview) t.preview = false;
        activate(t);
        return t;
      }
      const r = await api.fsRead(p);
      if (!r || !r.ok) {
        if (!quiet) flash(r && r.error ? r.error : 'Could not open that file.', true);
        return null;
      }
      t = {
        path: p, kind: r.kind, lang: langOf(p), preview,
        text: r.text || '', saved: r.text || '', url: r.url || null, size: r.size,
        dirty: false, stale: false, sel: [0, 0], scroll: [0, 0],
      };
      // One preview tab at a time: opening another replaces it, the way a
      // single click in VS Code's explorer does.
      const old = preview ? tabs.findIndex((x) => x.preview && !x.dirty) : -1;
      if (old >= 0) tabs.splice(old, 1, t);
      else {
        const at = active ? tabs.indexOf(active) + 1 : tabs.length;
        tabs.splice(at, 0, t);
      }
      activate(t);
      reveal(p);
      return t;
    }

    function activate(t) {
      stash();
      active = t;
      renderTabs();
      renderTree();
      paintView();
      store.set('last:' + (root || ''), t ? t.path : null);
    }

    function closeTab(t) {
      if (t.dirty && !confirm(`${base(t.path)} has changes that are not saved. Close it anyway?`)) return;
      const i = tabs.indexOf(t);
      tabs.splice(i, 1);
      if (active === t) { active = null; activate(tabs[i] || tabs[i - 1] || null); }
      else { renderTabs(); renderTree(); }
    }

    /* ── the code view ── */

    function paintView() {
      closeFind(true);
      const t = active;
      stRun.hidden = !(t && /\.html?$/i.test(t.path));
      if (!t) {
        scroller.hidden = true;
        media.hidden = true;
        emptyEl.hidden = false;
        emptyEl.innerHTML = root
          ? `<div class="ed-hint"><b>Pick a file to open it.</b><p>Drag anything in the tree into the chat to reference it.</p>
             <dl><dt>Ctrl S</dt><dd>Save</dd><dt>Ctrl F</dt><dd>Find</dd><dt>Ctrl /</dt><dd>Comment</dd><dt>Ctrl E</dt><dd>Hide the editor</dd></dl></div>`
          : `<div class="ed-hint"><b>No folder open.</b><p>Open a project, or ask the chat to build one — the editor follows it.</p><button class="ed-btn" data-a="pick" type="button">Open a folder</button></div>`;
        stPath.textContent = ''; stPos.textContent = ''; stLang.textContent = ''; stMsg.textContent = '';
        return;
      }
      emptyEl.hidden = true;
      stPath.textContent = rel(root, t.path);
      stPath.title = t.path;
      stLang.textContent = t.kind === 'text' ? LANG_NAME[t.lang] : t.kind === 'image' ? 'Image' : '';
      paintMsg();

      if (t.kind !== 'text') {
        scroller.hidden = true;
        media.hidden = false;
        stPos.textContent = '';
        const kb = Math.round((t.size || 0) / 1024);
        media.innerHTML = t.kind === 'image'
          ? `<div class="ed-img"><img src="${t.url}" alt="${esc(base(t.path))}" /><span>${kb} KB</span></div>`
          : `<div class="ed-hint"><b>${t.kind === 'big' ? 'Too big to edit here' : 'Not a text file'}</b><p>${esc(base(t.path))} · ${kb.toLocaleString()} KB</p><button class="ed-btn" data-a="external" type="button">Open with its usual app</button></div>`;
        return;
      }

      media.hidden = true;
      scroller.hidden = false;
      measure();
      ta.value = t.text;
      lineCount = 0;
      paint();
      ta.setSelectionRange(t.sel[0], t.sel[1]);
      scroller.scrollTop = t.scroll[0];
      scroller.scrollLeft = t.scroll[1];
      paintCaret();
      if (open) ta.focus({ preventScroll: true });
    }

    function paint() {
      const t = active;
      if (!t) return;
      // The trailing space keeps a final empty line a line tall.
      code.innerHTML = highlight(t.text, t.lang) + '\n ';
      const n = t.text.split('\n').length;
      if (n !== lineCount) {
        lineCount = n;
        let s = '';
        for (let i = 1; i <= n; i++) s += i + '\n';
        gutter.textContent = s;
        el.style.setProperty('--gutter-ch', String(Math.max(3, String(n).length + 1)));
      }
      // The textarea never scrolls itself; the scroller does.
      ta.scrollTop = 0; ta.scrollLeft = 0;
      if (!findBar.hidden) paintMarks();
    }

    function lineCol(pos) {
      const before = ta.value.slice(0, pos);
      const line = before.split('\n').length - 1;
      const col = pos - before.lastIndexOf('\n') - 1;
      return { line, col };
    }

    // Column in screen cells: a tab is two.
    const cells = (lineText, col) => lineText.slice(0, col).replace(/\t/g, '  ').length;

    function paintCaret() {
      if (!active || active.kind !== 'text') return;
      const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
      const { line, col } = lineCol(pos);
      cur.style.transform = `translateY(${PAD_Y + line * LH}px)`;
      const sel = ta.selectionEnd - ta.selectionStart;
      stPos.textContent = `Ln ${line + 1}, Col ${col + 1}${sel ? ` (${sel} selected)` : ''}`;
      // Keep the caret on screen — the textarea cannot, it never scrolls.
      const lineText = ta.value.split('\n')[line] || '';
      const y = PAD_Y + line * LH;
      const x = PAD_X + cells(lineText, col) * cw;
      const gw = gutter.offsetWidth;
      if (y < scroller.scrollTop) scroller.scrollTop = y - LH;
      else if (y + LH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + LH * 2 - scroller.clientHeight;
      if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40);
      else if (x + gw + 20 > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x + gw + 60 - scroller.clientWidth;
    }

    function paintMsg() {
      const t = active;
      if (!t) { stMsg.innerHTML = ''; return; }
      if (t.gone) stMsg.innerHTML = '<span class="bad">Deleted on disk</span>';
      else if (t.stale) stMsg.innerHTML = '<span class="warn">Changed on disk</span> <button type="button" data-a="reload">Reload</button> <button type="button" data-a="keep">Keep mine</button>';
      else if (t.dirty) stMsg.innerHTML = '<span>Unsaved</span>';
      else stMsg.innerHTML = '';
    }

    let flashTimer = null;
    function flash(text, bad) {
      stMsg.innerHTML = `<span class="${bad ? 'bad' : 'ok'}">${esc(text)}</span>`;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(paintMsg, 2200);
    }

    function changed() {
      const t = active;
      t.text = ta.value;
      const was = t.dirty;
      const wasPreview = t.preview;
      t.dirty = t.text !== t.saved;
      t.preview = false;
      if (t.text.length < 100000) paint();
      else requestAnimationFrame(paint);
      paintCaret();
      if (was !== t.dirty || wasPreview) { renderTabs(); paintMsg(); }
    }

    async function save(t = active) {
      if (!t || t.kind !== 'text') return;
      const r = await api.fsWrite(t.path, t.text);
      if (!r || !r.ok) { flash('Could not save: ' + ((r && r.error) || 'unknown error'), true); return; }
      t.saved = t.text;
      t.dirty = false;
      t.stale = false;
      t.gone = false;
      t.preview = false;
      renderTabs();
      flash('Saved');
    }

    // The disk moved under an open file. Take the new copy unless there is
    // work here that would be lost — then ask.
    async function fromDisk(t) {
      const r = await api.fsRead(t.path);
      if (!r || !r.ok) { t.gone = true; if (t === active) paintMsg(); return; }
      t.gone = false;
      if (r.kind !== 'text') return;
      if (r.text === t.saved) return;
      if (t.dirty) { t.stale = r.text; if (t === active) paintMsg(); return; }
      t.text = t.saved = r.text;
      if (t === active) {
        const sel = [ta.selectionStart, ta.selectionEnd];
        const sc = [scroller.scrollTop, scroller.scrollLeft];
        ta.value = t.text;
        paint();
        ta.setSelectionRange(Math.min(sel[0], t.text.length), Math.min(sel[1], t.text.length));
        scroller.scrollTop = sc[0];
        scroller.scrollLeft = sc[1];
      }
    }

    /* ── editing keys ── */

    const insert = (text) => {
      // execCommand keeps the browser's own undo stack intact; setting .value
      // would wipe it.
      if (!document.execCommand('insertText', false, text)) {
        const s = ta.selectionStart;
        ta.setRangeText(text, s, ta.selectionEnd, 'end');
        changed();
      }
    };

    // Replace whole lines from the selection's first to last, then reselect.
    function editLines(fn) {
      const v = ta.value;
      const selS = ta.selectionStart;
      let selE = ta.selectionEnd;
      // A selection ending just past a newline does not include the next line.
      if (selE > selS && v[selE - 1] === '\n') selE--;
      const s = v.lastIndexOf('\n', selS - 1) + 1;
      let e = v.indexOf('\n', selE);
      if (e < 0) e = v.length;
      const lines = v.slice(s, e).split('\n');
      const next = fn(lines).join('\n');
      ta.setSelectionRange(s, e);
      insert(next);
      ta.setSelectionRange(s, s + next.length);
    }

    function toggleComment() {
      const mark = COMMENT[active.lang];
      if (!mark) return;
      editLines((lines) => {
        const real = lines.filter((l) => l.trim());
        const all = real.length && real.every((l) => l.trimStart().startsWith(mark));
        const pad = Math.min(...real.map((l) => l.match(/^\s*/)[0].length));
        return lines.map((l) => {
          if (!l.trim()) return l;
          if (all) return l.replace(new RegExp('^(\\s*)' + mark.replace(/[/]/g, '\\/') + ' ?'), '$1');
          return l.slice(0, pad) + mark + ' ' + l.slice(pad);
        });
      });
    }

    ta.addEventListener('input', changed);
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
      if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
      if (e.key === 'Escape' && !findBar.hidden) { e.preventDefault(); closeFind(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
        if (e.shiftKey) editLines((ls) => ls.map((l) => l.replace(/^( {1,2}|\t)/, '')));
        else if (multi) editLines((ls) => ls.map((l) => (l.trim() ? '  ' + l : l)));
        else insert('  ');
        return;
      }
      if (e.key === 'Enter' && !mod && !e.altKey) {
        e.preventDefault();
        const v = ta.value;
        const s = ta.selectionStart;
        const lineStart = v.lastIndexOf('\n', s - 1) + 1;
        const indent = v.slice(lineStart, s).match(/^[ \t]*/)[0];
        const prev = v.slice(lineStart, s).trimEnd().slice(-1);
        const opens = '{[('.includes(prev) || (prev === ':' && active.lang === 'py');
        const closes = opens && '}])'.includes(v[s] || '');
        if (closes) {
          insert('\n' + indent + '  ' + '\n' + indent);
          const at = s + 1 + indent.length + 2;
          ta.setSelectionRange(at, at);
          paintCaret();
        } else insert('\n' + indent + (opens ? '  ' : ''));
      }
    });
    ['keyup', 'click', 'select', 'focus'].forEach((ev) => ta.addEventListener(ev, paintCaret));
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta) paintCaret(); });

    /* ── find ── */

    let hits = [];
    let hitAt = -1;

    function openFind() {
      if (!active || active.kind !== 'text') return;
      findBar.hidden = false;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) findIn.value = sel;
      findIn.focus();
      findIn.select();
      runFind();
    }
    function closeFind(quiet) {
      findBar.hidden = true;
      marks.innerHTML = '';
      hits = [];
      if (!quiet && active) ta.focus();
    }
    function runFind() {
      const q = findIn.value;
      hits = [];
      if (q) {
        const hay = ta.value.toLowerCase();
        const n = q.toLowerCase();
        let i = hay.indexOf(n);
        while (i !== -1 && hits.length < 5000) { hits.push(i); i = hay.indexOf(n, i + n.length); }
      }
      hitAt = hits.length ? Math.max(0, hits.findIndex((h) => h >= ta.selectionStart)) : -1;
      paintMarks();
    }
    function paintMarks() {
      const q = findIn.value;
      findN.textContent = q ? (hits.length ? `${hitAt + 1} of ${hits.length}${hits.length >= 5000 ? '+' : ''}` : 'No results') : '';
      findN.classList.toggle('none', Boolean(q) && !hits.length);
      if (!hits.length) { marks.innerHTML = ''; return; }
      const lines = ta.value.split('\n');
      const starts = [];
      let acc = 0;
      for (const l of lines) { starts.push(acc); acc += l.length + 1; }
      let li = 0;
      let html = '';
      hits.slice(0, 800).forEach((h, k) => {
        while (li + 1 < starts.length && starts[li + 1] <= h) li++;
        const x = PAD_X + cells(lines[li], h - starts[li]) * cw;
        html += `<i class="${k === hitAt ? 'now' : ''}" style="left:${x}px;top:${PAD_Y + li * LH}px;width:${q.length * cw}px"></i>`;
      });
      marks.innerHTML = html;
    }
    function step(dir) {
      if (!hits.length) return;
      hitAt = (hitAt + dir + hits.length) % hits.length;
      const h = hits[hitAt];
      ta.setSelectionRange(h, h + findIn.value.length);
      paintMarks();
      paintCaret();
    }
    findIn.addEventListener('input', runFind);
    findIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    findBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      if (b.dataset.f === 'close') closeFind();
      else step(b.dataset.f === 'next' ? 1 : -1);
    });

    /* ── naming things, in place ── */

    // Electron has no window.prompt, and a dialog for a file name is a lot of
    // ceremony anyway: the name is typed where the file will appear.
    function askName({ dir, depth, after, initial = '', isDir, onDone }) {
      const row = document.createElement('div');
      row.className = 'ed-row ed-naming';
      row.style.setProperty('--d', depth);
      row.innerHTML = `<span class="ed-twist"></span><span class="ed-fi" style="--c:var(--ink-3)">${isDir ? I.folder : I.file}</span><input type="text" spellcheck="false" />`;
      if (after) after.after(row); else tree.prepend(row);
      const input = row.querySelector('input');
      input.value = initial;
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        row.remove();
        if (commit && name && name !== initial) await onDone(name);
        else renderTree();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    async function create(dir, isDir) {
      if (!dir) return;
      if (!same(dir, root)) await toggleDir(dir, true);
      const at = tree.querySelector(`.ed-row[data-p="${CSS.escape(dir)}"]`);
      const depth = at ? Number(at.style.getPropertyValue('--d')) + 1 : 0;
      askName({
        dir, depth, after: at, isDir,
        onDone: async (name) => {
          const r = await api.fsCreate(dir, name, isDir);
          if (!r || !r.ok) { flash((r && r.error) || 'Could not create that.', true); renderTree(); return; }
          await load(dir);
          renderTree();
          if (!isDir) openFile(r.path);
        },
      });
    }

    async function rename(p) {
      const row = tree.querySelector(`.ed-row[data-p="${CSS.escape(p)}"]`);
      if (!row) return;
      const depth = Number(row.style.getPropertyValue('--d'));
      row.hidden = true;
      askName({
        dir: dirname(p), depth, after: row, initial: base(p), isDir: row.dataset.dir === '1',
        onDone: async (name) => {
          const r = await api.fsRename(p, name);
          if (!r || !r.ok) { flash((r && r.error) || 'Could not rename that.', true); renderTree(); return; }
          tabs.forEach((t) => { if (same(t.path, p)) t.path = r.path; else if (under(p, t.path)) t.path = r.path + t.path.slice(p.length); });
          await load(dirname(p));
          renderTabs();
          renderTree();
        },
      });
    }

    async function trash(p) {
      if (!confirm(`Move ${base(p)} to the Recycle Bin?`)) return;
      const r = await api.fsTrash(p);
      if (!r || !r.ok) { flash((r && r.error) || 'Could not delete that.', true); return; }
      tabs.filter((t) => same(t.path, p) || under(p, t.path)).forEach((t) => { t.dirty = false; closeTab(t); });
      await load(dirname(p));
      renderTree();
    }

    /* ── the right-click menu ── */

    function showMenu(x, y, items) {
      menu.innerHTML = items.map((it) => (it === '-' ? '<hr />' : `<button type="button" data-m="${it[0]}"${it[2] ? ' class="danger"' : ''}>${esc(it[1])}</button>`)).join('');
      menu.hidden = false;
      const box = el.getBoundingClientRect();
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      menu.style.left = Math.min(x - box.left, box.width - w - 6) + 'px';
      menu.style.top = Math.min(y - box.top, box.height - h - 6) + 'px';
    }
    const hideMenu = () => { menu.hidden = true; };
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); });

    let menuFor = null;
    tree.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = e.target.closest('.ed-row[data-p]');
      const p = row ? row.dataset.p : root;
      if (!p) return;
      const isDir = row ? row.dataset.dir === '1' : true;
      menuFor = { p, isDir };
      const items = isDir
        ? [['newFile', 'New file'], ['newFolder', 'New folder'], '-', ['ref', 'Reference in chat'], ['work', 'Work in this folder'], '-', ['reveal', 'Show in Explorer'], ['path', 'Copy path']]
        : [['open', 'Open'], ['ref', 'Reference in chat'], ...(/\.html?$/i.test(p) ? [['external', 'Open in browser']] : [['external', 'Open with its usual app']]), '-', ['reveal', 'Show in Explorer'], ['path', 'Copy path']];
      if (row) items.push('-', ['rename', 'Rename'], ['trash', 'Delete', true]);
      showMenu(e.clientX, e.clientY, items);
    });

    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-m]');
      if (!b || !menuFor) return;
      hideMenu();
      const { p, isDir } = menuFor;
      switch (b.dataset.m) {
        case 'open': openFile(p); break;
        case 'newFile': create(isDir ? p : dirname(p), false); break;
        case 'newFolder': create(isDir ? p : dirname(p), true); break;
        case 'ref': if (hooks.onReference) hooks.onReference({ path: p, dir: isDir }); break;
        case 'work': if (hooks.onUseFolder) hooks.onUseFolder(p); break;
        case 'reveal': api.fsReveal(p); break;
        case 'external': api.fsOpenExternal(p); break;
        case 'path': try { await navigator.clipboard.writeText(p); flash('Path copied'); } catch (_) { flash('Could not copy', true); } break;
        case 'rename': rename(p); break;
        case 'trash': trash(p); break;
      }
    });

    /* ── clicks ── */

    tree.addEventListener('click', (e) => {
      const row = e.target.closest('.ed-row[data-p]');
      if (!row) return;
      if (row.dataset.dir === '1') toggleDir(row.dataset.p);
      else openFile(row.dataset.p, { preview: true });
    });
    tree.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.ed-row[data-p]');
      if (row && row.dataset.dir !== '1') openFile(row.dataset.p);
    });

    // Anything in the tree can be dragged out into the chat.
    tree.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.ed-row[data-p]');
      if (!row) return;
      e.dataTransfer.setData('application/x-operator-ref', JSON.stringify({ path: row.dataset.p, dir: row.dataset.dir === '1' }));
      e.dataTransfer.setData('text/plain', row.dataset.p);
      e.dataTransfer.effectAllowed = 'copy';
    });

    tabsEl.addEventListener('click', (e) => {
      const tab = e.target.closest('.ed-tab');
      if (!tab) return;
      const t = tabs.find((x) => x.path === tab.dataset.p);
      if (!t) return;
      if (e.target.closest('.ed-tab-x')) closeTab(t);
      else if (t !== active) activate(t);
    });
    tabsEl.addEventListener('dblclick', (e) => {
      const tab = e.target.closest('.ed-tab');
      const t = tab && tabs.find((x) => x.path === tab.dataset.p);
      if (t && t.preview) { t.preview = false; renderTabs(); }
    });
    tabsEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const tab = e.target.closest('.ed-tab');
      const t = tab && tabs.find((x) => x.path === tab.dataset.p);
      if (t) closeTab(t);
    });

    async function pickRoot() {
      const r = await api.fsPickFolder();
      if (!r || !r.ok) return;
      await setRoot(r.path);
      if (hooks.onRootPicked) hooks.onRootPicked(r.path);
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('.ed-root')) { pickRoot(); return; }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      switch (a.dataset.a) {
        case 'pick': pickRoot(); break;
        case 'newFile': create(active && under(root, active.path) ? dirname(active.path) : root, false); break;
        case 'newFolder': create(root, true); break;
        case 'refresh': refresh(); break;
        case 'follow': follow = !follow; store.set('follow', follow); paintHead(); flash(follow ? 'Following the agent' : 'Not following the agent'); break;
        case 'tree': treeShown = !treeShown; store.set('tree', treeShown); paintHead(); break;
        case 'close': hide(); break;
        case 'external': if (active) api.fsOpenExternal(active.path); break;
        case 'reload': if (active && typeof active.stale === 'string') { active.saved = active.stale; active.text = active.stale; active.dirty = false; active.stale = false; paintView(); renderTabs(); } break;
        case 'keep': if (active) { active.stale = false; paintMsg(); } break;
      }
    });
    stRun.addEventListener('click', async () => {
      if (!active) return;
      if (active.dirty) await save();
      api.fsOpenExternal(active.path);
    });

    async function refresh() {
      if (!root) return;
      await load(root);
      await Promise.all([...expanded].map(load));
      renderTree();
      for (const t of tabs) fromDisk(t);
    }

    /* ── dropping things on the editor opens them ── */

    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', async (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop');
      for (const f of [...e.dataTransfer.files]) {
        const p = api.pathForFile(f);
        if (!p) continue;
        const st = await api.fsStat(p);
        if (st && st.ok && st.dir) { await setRoot(p); if (hooks.onRootPicked) hooks.onRootPicked(p); }
        else openFile(p);
      }
    });

    /* ── keeping up with the disk ── */

    api.onFsChanged(async ({ root: r, paths }) => {
      if (!root || !same(r, root)) return;
      const dirs = new Set();
      for (const p of paths) {
        const d = dirname(p);
        if (cache.has(d)) dirs.add(d);
        if (cache.has(p)) dirs.add(p);
      }
      await Promise.all([...dirs].map(load));
      if (dirs.size) renderTree();
      for (const p of paths) {
        const t = tabs.find((x) => same(x.path, p));
        if (t) fromDisk(t);
        else if (wantFollow && same(wantFollow, p) && follow && open) { wantFollow = null; openFile(p, { preview: true, quiet: true }); }
      }
    });

    // The agent just asked to write or edit a file. The tool has not run yet —
    // this arrives as it is requested — so the watcher is what brings the new
    // contents; this just marks the row and, when following, opens the file.
    function touched(p, name) {
      if (!p || (name !== 'Write' && name !== 'Edit')) return;
      hot.set(p, Date.now());
      setTimeout(() => { if (open) renderTree(); }, 4200);
      if (!open || !follow) return;
      if (root && !under(root, p)) return;
      wantFollow = p;
      setTimeout(async () => {
        const t = await openFile(p, { preview: true, quiet: true });
        if (t) wantFollow = null;
      }, 700);
    }

    /* ── showing and hiding ── */

    function show() {
      if (open) return;
      open = true;
      el.hidden = false;
      if (hooks.onToggle) hooks.onToggle(true);
      store.set('open', true);
      const r = root;
      if (r) expandedByRoot.set(r, expanded);
      root = null;
      setRoot(r).then(() => { if (!active) paintView(); });
      measure();
    }
    function hide() {
      if (!open) return;
      stash();
      open = false;
      el.hidden = true;
      api.fsWatch(null);
      if (hooks.onToggle) hooks.onToggle(false);
      store.set('open', false);
    }

    paintHead();
    renderTree();
    paintView();

    return {
      show, hide,
      toggle: () => (open ? hide() : show()),
      isOpen: () => open,
      setRoot,
      root: () => root,
      openFile,
      touched,
      dirty: () => tabs.some((t) => t.dirty),
      wasOpen: () => store.get('open', false),
    };
  }

  window.CodeEditor = { mount, highlight };
})();
