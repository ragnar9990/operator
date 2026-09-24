/* Operator — the live demo.

   A replica of the app you can click around in. It is honest about being one:
   the runs are scripts, the "computer" is drawn in HTML, and nothing here can
   reach the visitor's machine. What it gets right is the shape of the thing —
   the rail, the composer, the steps folding up as they happen, the live screen,
   Rehearse, the check at the end, the voice panel and the themes.

   Built by hand, no framework: the page has one script already and this should
   not need a build step to change. */

(function () {
  const root = document.getElementById('demo');
  if (!root) return;

  /* ── little helpers ─────────────────────────────────────────────── */

  const $ = (sel, el = root) => el.querySelector(sel);
  const h = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Every run carries a token. Stop flips it, and the next sleep throws, so a
  // script never needs to check for cancellation itself.
  let run = null;
  class Stopped extends Error {}
  const sleep = (ms) => new Promise((res, rej) => {
    const token = run;
    setTimeout(() => (token && token.stopped ? rej(new Stopped()) : res()), reduced ? Math.min(ms, 60) : ms);
  });

  const I = {
    agents: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="13" rx="3"/><path d="M9.5 20.5h5"/><circle cx="14.2" cy="11.4" r="1.5"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 9.5h17M3.5 14.5h17M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M18 11a6 6 0 0 1-12 0M12 17v4"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.5 12 5.5l6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7.5" y="7.5" width="9" height="9" rx="1.6"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
    caret: '<svg class="caret" viewBox="0 0 24 24"><path d="m9.5 5.5 7 6.5-7 6.5"/></svg>',
    tick: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    rehearse: '<svg viewBox="0 0 24 24"><path d="M5 12.5 9 16.5 19 7"/><path d="M3 20h18"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    click: '<svg viewBox="0 0 24 24"><path d="m5 3.5 13 6.2-5.6 1.8-1.8 5.6Z"/></svg>',
    type: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
    term: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4"/></svg>',
    win: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.8-5"/></svg>',
    busy: '<svg viewBox="0 0 24 24"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>',
    monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/></svg>',
    laptop: '<svg viewBox="0 0 24 24"><rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/></svg>',
    palette: '<svg viewBox="0 0 24 24"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-.9-.6-1.5-.6-2.2 0-.8.6-1.4 1.5-1.4h1.5A4.3 4.3 0 0 0 20.5 11 8.5 8.5 0 0 0 12 3.5Z"/><circle cx="8" cy="11" r="1.1"/><circle cx="12" cy="8" r="1.1"/><circle cx="16" cy="11" r="1.1"/></svg>',
    cursor: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19Z"/></svg>',
  };

  const face = (hue) =>
    `<svg class="d-face" viewBox="0 0 32 32" style="--h:${hue}"><path class="b" d="M16 4 26 8v8c0 6.5-4.3 10.5-10 12C10.3 26.5 6 22.5 6 16V8Z"/><g class="e"><rect x="11" y="13.5" width="3" height="5" rx="1.5"/><rect x="18" y="13.5" width="3" height="5" rx="1.5"/></g></svg>`;

  /* ── the agents in the rail ─────────────────────────────────────── */

  const bots = [
    { id: 'op', name: 'Operator', title: 'Runs this computer', hue: 341, role: 'Main', pinned: true, turns: [] },
    {
      id: 'bk', name: 'Bookkeeper', title: 'Files receipts by month', hue: 152,
      turns: [
        { you: 'File this month’s receipts from my inbox' },
        { steps: [['eye', 'look at the screen'], ['term', 'read mail <span class="arg">"receipt" since:Sep 1</span>'], ['file', 'save 23 attachments'], ['term', 'run <span class="arg">Move-Item → Receipts\\2026-09</span>']], n: 7 },
        { says: 'Filed 23 receipts into <b>Receipts\\2026-09</b>. Two were photos I couldn’t read — they’re in a folder called <b>Check these</b>.' },
      ],
    },
    {
      id: 'ib', name: 'Inbox', title: 'Keeps the inbox at zero', hue: 199,
      turns: [
        { you: 'Anything that needs me today?' },
        { steps: [['term', 'read mail <span class="arg">unread</span>'], ['eye', 'look at the browser']], n: 4 },
        { says: 'Three things: the plumber wants a time for Thursday, your accountant sent the draft return to sign, and the car rego is due on the 30th. I archived 41 newsletters.' },
      ],
    },
  ];
  let current = bots[0];

  /* ── markup ─────────────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="d-modebar">
      <div class="d-modes">
        <button class="d-mode is-on" data-mode="agents" type="button">${I.agents}Agents</button>
        <button class="d-mode" data-mode="code" type="button">${I.code}Code</button>
      </div>
      <div class="d-winctl" aria-hidden="true">
        <i><svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg></i>
        <i><svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg></i>
        <i><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></i>
      </div>
    </div>

    <div class="d-shell" id="dAgents">
      <nav class="d-rail" aria-label="Agents">
        <div class="d-rail-top">
          <span class="d-mark">${I.agents}</span>
          <button class="d-ic" data-act="browser" type="button" title="The agent’s browser" aria-label="The agent’s browser">${I.globe}</button>
          <button class="d-ic" data-act="new" type="button" title="New agent" aria-label="New agent">${I.plus}</button>
          <button class="d-ic" data-act="settings" type="button" title="Settings" aria-label="Settings">${I.gear}</button>
        </div>
        <div class="d-head">Always on</div>
        <div id="dRoster"></div>
        <div class="d-head">Agents</div>
        <div id="dList"></div>
      </nav>

      <div class="d-main">
        <header class="d-top">
          <span class="d-who" id="dWho"></span>
          <button class="d-badge" data-act="computer" type="button"><i></i>This computer</button>
        </header>

        <div class="d-split">
          <section class="d-col" id="dCol">
            <div class="d-thread" id="dThread" aria-live="polite"></div>
            <div class="d-dock">
              <div class="d-menu" id="dMenu" hidden></div>
              <form class="d-composer" id="dForm">
                <textarea id="dInput" rows="1" placeholder="Give Operator a task" aria-label="Task" spellcheck="false"></textarea>
                <div class="d-controls">
                  <button type="button" class="d-round d-mic" id="dMic" title="Talk to Operator" aria-label="Talk to Operator">${I.mic}</button>
                  <span class="d-flex"></span>
                  <button type="button" class="d-dry" id="dDry" aria-pressed="false" title="Rehearse: plan every step without changing anything">${I.rehearse}<span>Rehearse</span></button>
                  <button type="button" class="d-picker" id="dPicker" aria-haspopup="listbox" aria-expanded="false"><span id="dModel">Sonnet 5</span>${I.chev}</button>
                  <button type="button" class="d-round d-halt" id="dStop" title="Stop" aria-label="Stop" hidden>${I.stop}</button>
                  <button type="submit" class="d-round d-send" id="dSend" title="Run" aria-label="Run">${I.up}</button>
                </div>
              </form>
              <div class="d-chips" id="dChips"></div>
            </div>
          </section>

          <aside class="d-computer" id="dComputer" hidden>
            <div class="d-comp-head">
              <span class="d-live" id="dLive"><i></i>Live</span>
              <span class="d-surface" id="dSurface">private desktop · display 1</span>
              <span class="d-count" id="dCount">0:00 · 0 actions</span>
            </div>
            <div class="d-screen">
              <div class="d-desk" id="dDesk">
                <div class="d-task"><i class="win"></i><i></i><i></i><i></i><i></i><span class="d-clock">9:41 AM</span></div>
                <span class="d-cursor" id="dCursor" style="left:60%;top:55%">${I.cursor}</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>

    <div class="d-codeview" id="dCode" hidden>
      <aside class="d-code-side">
        <button class="d-code-new" type="button" data-act="codenew">${I.plus}New chat</button>
        <div class="d-code-row is-on"><b>Tetris high score</b><small>tetris</small></div>
        <div class="d-code-row"><b>Landing page</b><small>site</small></div>
      </aside>
      <section class="d-code-main">
        <div class="d-col is-empty" id="dCodeCol" style="flex:1;min-height:0">
          <div class="d-thread" id="dCodeThread">
            <div class="d-intro"><h3>Code</h3><p>A coding assistant with your project’s files and terminal. Pick a folder, then say what to build or fix.</p></div>
          </div>
          <div class="d-dock">
            <form class="d-composer" id="dCodeForm">
              <textarea id="dCodeInput" rows="1" placeholder="Describe a change, a bug, or a feature" aria-label="Coding request" spellcheck="false"></textarea>
              <div class="d-controls">
                <span class="d-folder">${I.folder}tetris</span>
                <span class="d-flex"></span>
                <button type="button" class="d-picker" data-act="picker"><span>Sonnet 5</span>${I.chev}</button>
                <button type="submit" class="d-round d-send" aria-label="Run">${I.up}</button>
              </div>
            </form>
            <div class="d-chips"><button class="d-chip" type="button" data-code="Add a high score that survives a reload">Add a high score that survives a reload</button></div>
          </div>
        </div>
      </section>
    </div>

    <div class="d-vox" id="dVox" data-state="starting" hidden>
      <div class="d-vox-bar">
        <span class="d-orb"><i></i><b></b></span>
        <span class="d-vox-status"><b id="dVoxState">Starting</b><small id="dVoxHint">Asking for the microphone…</small></span>
        <button class="d-vox-x" id="dVoxClose" type="button" aria-label="Stop listening">${I.x}</button>
      </div>
      <div class="d-vox-log" id="dVoxLog"></div>
    </div>

    <div class="d-sheet" id="dSheet" hidden>
      <div class="d-scrim" data-act="close"></div>
      <section class="d-card" role="dialog" aria-modal="true" aria-label="Settings">
        <header class="d-card-top"><h4>Settings</h4><button class="d-vox-x" data-act="close" type="button" aria-label="Close">${I.x}</button></header>
        <div class="d-card-split">
          <nav class="d-tabs">
            <button class="d-tab is-on" data-tab="computer" type="button">${I.monitor}<span>Computer</span></button>
            <button class="d-tab" data-tab="look" type="button">${I.palette}<span>Appearance</span></button>
          </nav>
          <div class="d-panel" data-panel="computer">
            <div class="d-label">Which computer Operator uses</div>
            <button class="d-target is-on" data-target="local" type="button">${I.monitor}<span><b>This computer</b><small>The machine Operator is running on</small></span><em></em></button>
            <button class="d-target" data-target="remote" type="button">${I.laptop}<span><b>Another computer</b><small>Drive a spare laptop over your network</small></span><em></em></button>
            <label class="d-toggle"><span><b>Work on its own desktop</b><small>A hidden desktop with its own mouse and keyboard, so you can keep working.</small></span><span class="d-switch"><input type="checkbox" checked /><i></i></span></label>
          </div>
          <div class="d-panel" data-panel="look" hidden>
            <div class="d-label">Theme</div>
            <div class="d-swatches" data-set="theme">
              <button class="d-swatch" data-v="warm" aria-pressed="true" type="button"><i class="d-chip-theme" style="--a:#131211;--b:#0e0d0d;--c:#fcfcfc"></i>Warm black</button>
              <button class="d-swatch" data-v="cool" aria-pressed="false" type="button"><i class="d-chip-theme" style="--a:#0f1113;--b:#0a0c0d;--c:#f6f8fa"></i>Cool grey</button>
              <button class="d-swatch" data-v="midnight" aria-pressed="false" type="button"><i class="d-chip-theme" style="--a:#0c1020;--b:#080b17;--c:#eef1ff"></i>Midnight</button>
              <button class="d-swatch" data-v="light" aria-pressed="false" type="button"><i class="d-chip-theme" style="--a:#f7f7f6;--b:#ffffff;--c:#16181a"></i>Light</button>
            </div>
            <div class="d-label">Accent</div>
            <div class="d-swatches" data-set="accent">
              <button class="d-swatch" data-v="blue" aria-pressed="true" type="button"><i class="d-dot" style="--a:#299fff"></i>Blue</button>
              <button class="d-swatch" data-v="violet" aria-pressed="false" type="button"><i class="d-dot" style="--a:#8b5cff"></i>Violet</button>
              <button class="d-swatch" data-v="green" aria-pressed="false" type="button"><i class="d-dot" style="--a:#22c07a"></i>Green</button>
              <button class="d-swatch" data-v="pink" aria-pressed="false" type="button"><i class="d-dot" style="--a:#ff4ea8"></i>Pink</button>
              <button class="d-swatch" data-v="amber" aria-pressed="false" type="button"><i class="d-dot" style="--a:#f0a12e"></i>Amber</button>
            </div>
            <div class="d-label">Neon</div>
            <p class="d-hint">The coloured line around the task box.</p>
            <div class="d-seg" data-set="glow">
              <button data-v="full" aria-pressed="true" type="button">Full</button>
              <button data-v="subtle" aria-pressed="false" type="button">Subtle</button>
              <button data-v="off" aria-pressed="false" type="button">Off</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;

  const thread = $('#dThread');
  const col = $('#dCol');
  const input = $('#dInput');
  const chips = $('#dChips');
  const desk = $('#dDesk');
  const cursor = $('#dCursor');
  const computer = $('#dComputer');

  /* ── toasts: what a replica cannot do, said plainly ─────────────── */

  let toastTimer = null;
  function toast(text) {
    const old = $('.d-toast');
    if (old) old.remove();
    const t = h('div', 'd-toast', esc(text));
    root.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3600);
  }

  /* ── the rail ───────────────────────────────────────────────────── */

  function paintRail() {
    const row = (b) => {
      const el = h('button', 'd-bot' + (b === current ? ' is-on' : '') + (b.fresh ? ' is-new' : ''));
      el.type = 'button';
      el.innerHTML = face(b.hue) +
        `<span class="d-bot-text"><span class="d-bot-name">${esc(b.name)}${b.role ? `<span class="d-tag">${b.role}</span>` : ''}</span>` +
        `<span class="d-bot-line">${esc(b.line || b.title)}</span></span>` +
        (b.busy ? '<i class="d-busy"></i>' : '');
      el.title = b.name;
      el.addEventListener('click', () => openBot(b));
      b.fresh = false;
      return el;
    };
    const roster = $('#dRoster');
    const list = $('#dList');
    roster.textContent = '';
    list.textContent = '';
    bots.filter((b) => b.pinned).forEach((b) => roster.appendChild(row(b)));
    bots.filter((b) => !b.pinned).forEach((b) => list.appendChild(row(b)));
    $('#dWho').innerHTML = face(current.hue) + `<span class="d-who-text"><b>${esc(current.name)}</b><small>${esc(current.title)}</small></span>`;
    input.placeholder = 'Give ' + current.name + ' a task';
  }

  function openBot(b) {
    if (run && !run.done) { toast('Let this one finish first — or press stop.'); return; }
    current = b;
    paintRail();
    paintThread();
  }

  /* ── the thread ─────────────────────────────────────────────────── */

  const SUGGEST = [
    ['notepad', 'Open Notepad and write me a shopping list for a roast dinner'],
    ['tidy', 'Tidy my Downloads folder into images, installers and PDFs'],
    ['monitor', 'What is open on my second monitor?'],
  ];

  function paintChips() {
    chips.textContent = '';
    for (const [key, text] of SUGGEST) {
      const c = h('button', 'd-chip', esc(text));
      c.type = 'button';
      c.addEventListener('click', () => start(text, key));
      chips.appendChild(c);
    }
  }

  function paintThread() {
    thread.textContent = '';
    const empty = !current.turns.length;
    col.classList.toggle('is-empty', empty);
    chips.hidden = !empty && current !== bots[0];
    if (empty) {
      thread.appendChild(h('div', 'd-intro',
        `<h3>What should ${esc(current.name)} do?</h3><p>It drives this computer to get it done — your apps, your desktop and its own browser. Pick a job below, or type your own.</p>`));
      return;
    }
    for (const t of current.turns) {
      if (t.you) addYou(t.you, false);
      else if (t.steps) {
        const g = stepsGroup(false);
        t.steps.forEach(([ic, what], i) => g.add(ic, what, false, i));
        g.finish(t.n || t.steps.length);
      } else if (t.says) addSays(t.says);
    }
  }

  const scroll = () => { thread.scrollTop = thread.scrollHeight; };

  function turn(el) {
    const wrap = h('div', 'd-turn');
    wrap.appendChild(el);
    thread.appendChild(wrap);
    scroll();
    return wrap;
  }

  function addYou(text) {
    const d = h('div', 'd-you');
    d.appendChild(h('span', null, esc(text)));
    return turn(d);
  }

  function addSays(html) {
    return turn(h('div', 'd-says', html));
  }

  // Replies are streamed in word by word, like the real thing, with a caret
  // trailing while it is still being written.
  async function stream(text) {
    const d = h('div', 'd-says is-live');
    turn(d);
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      d.textContent = words.slice(0, i + 1).join(' ');
      scroll();
      await sleep(28 + Math.random() * 30);
    }
    d.classList.remove('is-live');
    return d;
  }

  function stepsGroup(open = true) {
    const g = h('div', 'd-steps' + (open ? ' is-open' : ''));
    const head = h('button', 'd-steps-head', `${I.caret}<span>Using the computer</span><i class="spin"></i>`);
    head.type = 'button';
    head.addEventListener('click', () => g.classList.toggle('is-open'));
    const body = h('div', 'd-steps-body');
    g.append(head, body);
    turn(g);
    let n = 0;
    const list = [];
    return {
      list,
      add(ic, what, live = true, at) {
        list.push([ic, what]);
        body.querySelectorAll('.is-now').forEach((s) => s.classList.remove('is-now'));
        n++;
        const secs = at != null ? at * 3 + 1 : Math.round((Date.now() - (run ? run.t0 : Date.now())) / 1000);
        const s = h('div', 'd-step' + (live ? ' is-now' : ''), `${I[ic] || I.click}<span class="what">${what}</span><span class="at">0:${String(secs).padStart(2, '0')}</span>`);
        body.appendChild(s);
        scroll();
        if (live) bump();
      },
      finish(total) {
        body.querySelectorAll('.is-now').forEach((s) => s.classList.remove('is-now'));
        head.innerHTML = `${I.caret}<span>Used the computer</span><span class="n">${total || n} steps</span>`;
        g.classList.remove('is-open');
      },
    };
  }

  /* ── the live screen ────────────────────────────────────────────── */

  let actions = 0;
  let clock = null;
  function bump() {
    actions++;
    paintCount();
    desk.classList.remove('is-flash');
    void desk.offsetWidth;
    desk.classList.add('is-flash');
  }
  function paintCount() {
    const s = run ? Math.floor((Date.now() - run.t0) / 1000) : 0;
    $('#dCount').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${actions} action${actions === 1 ? '' : 's'}`;
  }

  function resetDesk(label) {
    desk.querySelectorAll('.d-win, .d-save').forEach((w) => w.remove());
    desk.querySelectorAll('.d-task i').forEach((i) => i.classList.remove('is-on'));
    $('#dSurface').textContent = label || 'private desktop · display 1';
  }

  async function moveTo(x, y) {
    cursor.style.left = x + '%';
    cursor.style.top = y + '%';
    await sleep(600);
  }
  async function click() {
    cursor.classList.remove('is-click');
    void cursor.offsetWidth;
    cursor.classList.add('is-click');
    await sleep(260);
  }

  function win(title, x, y, w, hgt, body) {
    const el = h('div', 'd-win', `<div class="d-win-bar"><b>${esc(title)}</b><em></em></div><div class="d-win-body">${body || ''}</div>`);
    Object.assign(el.style, { left: x + '%', top: y + '%', width: w + '%', height: hgt + '%' });
    desk.insertBefore(el, cursor);
    return el;
  }

  async function typeInto(el, text, speed = 18) {
    let out = el.textContent;
    for (const ch of text) {
      out += ch;
      el.textContent = out;
      await sleep(ch === '\n' ? speed * 4 : speed);
    }
  }

  /* ── the scripted jobs ──────────────────────────────────────────── */

  const JOBS = {
    notepad: {
      intro: 'On it — opening Notepad and writing the list.',
      plan: [['Look at the screen'], ['Open Notepad from the Start menu'], ['Type a ten-item shopping list'], ['Save it to Documents as shopping-list.txt', 'writes a file']],
      async go(g) {
        g.add('eye', 'look at the screen');
        await sleep(700);
        await moveTo(34, 94); await click();
        desk.querySelectorAll('.d-task i')[1].classList.add('is-on');
        g.add('win', 'open <span class="arg">notepad</span>');
        const w = win('Untitled - Notepad', 16, 8, 62, 74, '<div class="d-np"></div>');
        await sleep(500);
        await moveTo(40, 40); await click();
        g.add('type', 'type <span class="arg">"Roast dinner — shopping list…"</span>');
        await typeInto(w.querySelector('.d-np'),
          'Roast dinner — shopping list\n\n- Beef topside, 1.5 kg\n- Potatoes, 2 kg\n- Carrots and parsnips\n- Green beans\n- Onions, garlic, rosemary\n- Flour, eggs, milk (Yorkshires)\n- Gravy granules\n- Horseradish', 16);
        g.add('type', 'press <span class="arg">ctrl+s</span>');
        const save = h('div', 'd-save', 'Save as<div></div><p><span>Save</span></p>');
        desk.insertBefore(save, cursor);
        await sleep(400);
        g.add('type', 'type <span class="arg">"shopping-list.txt"</span>');
        await typeInto(save.querySelector('div'), 'shopping-list.txt', 40);
        await moveTo(70, 48); await click();
        g.add('type', 'press <span class="arg">enter</span>');
        save.remove();
        w.querySelector('.d-win-bar b').textContent = 'shopping-list.txt - Notepad';
        await sleep(400);
        return {
          check: 'Notepad shows the list, and the title bar says it was saved as shopping-list.txt.',
          says: 'Done — a ten-item shopping list for a roast dinner is open in Notepad and saved to Documents as shopping-list.txt.',
        };
      },
    },

    tidy: {
      intro: 'Sorting your Downloads by kind.',
      plan: [['List what is in Downloads'], ['Make Images, Installers and PDFs folders'], ['Move 13 files into them', 'moves files'], ['Leave anything that fits none of them']],
      async go(g) {
        g.add('term', 'run <span class="arg">Get-ChildItem ~\\Downloads</span>');
        const files = [
          ['holiday-01.jpg', 'img'], ['IMG_4420.png', 'img'], ['setup-x64.exe', 'exe'], ['invoice-0921.pdf', 'pdf'], ['screenshot.png', 'img'],
          ['vlc-3.0.21.exe', 'exe'], ['notes.docx', 'doc'], ['bank-sept.pdf', 'pdf'], ['cat.jpg', 'img'], ['node-v22.msi', 'exe'],
          ['backup.zip', 'zip'], ['logo.png', 'img'], ['lease.pdf', 'pdf'], ['todo.txt', 'doc'], ['python-3.13.exe', 'exe'], ['header.jpg', 'img'],
        ];
        const colour = { img: '#5aa7f0', exe: '#8a8f99', pdf: '#e0584f', doc: '#4f7fe0', zip: '#c9a14a' };
        const w = win('Downloads', 8, 5, 84, 82, '<div class="d-files"></div>');
        const grid = w.querySelector('.d-files');
        const tile = (name, kind, folder) => {
          const t = h('div', 'd-file' + (folder ? ' is-folder is-new' : ''), `<i style="--c:${colour[kind] || '#9aa4b2'}"></i><span>${esc(name)}</span>`);
          t.dataset.kind = kind;
          return t;
        };
        files.forEach(([n, k]) => grid.appendChild(tile(n, k)));
        await sleep(900);
        g.add('term', 'run <span class="arg">New-Item Images, Installers, PDFs</span>');
        for (const f of ['Images', 'Installers', 'PDFs']) {
          grid.insertBefore(tile(f, 'folder', true), grid.firstChild);
          await sleep(180);
        }
        await sleep(500);
        for (const [kind, glob, dest] of [['img', '*.jpg,*.png', 'Images'], ['exe', '*.exe,*.msi', 'Installers'], ['pdf', '*.pdf', 'PDFs']]) {
          g.add('term', `run <span class="arg">Move-Item ${glob} → ${dest}</span>`);
          grid.querySelectorAll(`.d-file[data-kind="${kind}"]`).forEach((t) => t.classList.add('is-gone'));
          await sleep(700);
          grid.querySelectorAll('.is-gone').forEach((t) => t.remove());
        }
        await sleep(300);
        return {
          check: 'Downloads now holds the three folders plus three files that fit none of them.',
          says: 'Done — moved 13 files: 6 images, 4 installers and 3 PDFs. notes.docx, backup.zip and todo.txt didn’t fit any group, so I left them where they were.',
        };
      },
    },

    monitor: {
      plan: [['List the open windows'], ['Look at display 2']],
      async go(g) {
        g.add('win', 'see what is open');
        resetDesk('private desktop · display 2');
        const list = win('Windows on display 2', 30, 20, 40, 50,
          '<div class="d-list"><div><b>Budget.xlsx — Excel</b><span>max</span></div><div><b>Inbox — Outlook</b><span>4 unread</span></div><div><b>Music</b><span>paused</span></div></div>');
        await sleep(900);
        list.remove();
        g.add('eye', 'look at <span class="arg">display 2</span>');
        win('Budget.xlsx - Excel', 3, 4, 58, 84, '<div class="d-list"><div><span>Summary</span><span>$4,210</span></div><div><span>Groceries</span><span>$612</span></div><div><span>Fuel</span><span>$188</span></div><div><span>Power</span><span>$240</span></div></div>');
        win('Inbox - Outlook', 63, 4, 34, 50, '<div class="d-list"><div><b>Plumber</b><span>9:02</span></div><div><b>Accountant</b><span>8:47</span></div><div><b>Rego due</b><span>Mon</span></div></div>');
        win('Music', 63, 58, 34, 30, '<div class="d-list"><div><span>❚❚ Paused</span><span>2:14</span></div></div>');
        await sleep(900);
        return {
          says: 'Three windows on your second monitor: Budget.xlsx in Excel, open on the Summary sheet; Outlook with 4 unread; and a music player, paused.',
        };
      },
    },

    other: {
      plan: [['Look at the screen'], ['Work out the steps for this job']],
      async go(g, text) {
        g.add('eye', 'look at the screen');
        await sleep(800);
        return {
          says: `This is a replica, so it can only play a few scripted jobs. On your PC, Operator would go and actually do “${text}”. Try one of the suggestions to see a whole run.`,
        };
      },
    },
  };

  function guess(text) {
    const t = text.toLowerCase();
    if (/notepad|shopping|list/.test(t)) return 'notepad';
    if (/download|tidy|sort|folder/.test(t)) return 'tidy';
    if (/monitor|screen|open on|display/.test(t)) return 'monitor';
    return 'other';
  }

  /* ── running a job ──────────────────────────────────────────────── */

  const dry = $('#dDry');
  const stopBtn = $('#dStop');
  const sendBtn = $('#dSend');

  function setWorking(on) {
    root.classList.toggle('is-working', on);
    stopBtn.hidden = !on;
    sendBtn.hidden = on;
    if (on) chips.hidden = true;
    chips.querySelectorAll('.d-chip').forEach((c) => (c.disabled = on));
    $('#dLive').classList.toggle('is-on', on);
    current.busy = on;
    paintRail();
    if (on) clock = setInterval(paintCount, 500);
    else clearInterval(clock);
  }

  async function start(text, key) {
    text = String(text || '').trim();
    if (!text) { input.focus(); return; }
    if (run && !run.done) return;
    key = key || guess(text);
    input.value = '';
    fit();

    if (current.turns.length === 0) thread.textContent = '';
    col.classList.remove('is-empty');
    current.turns.push({ you: text });
    addYou(text);

    if (dry.getAttribute('aria-pressed') === 'true') return rehearse(text, key);
    return execute(text, key);
  }

  // Rehearse: the plan, with anything that changes something flagged, and a
  // choice. Nothing has happened yet.
  function rehearse(text, key) {
    const job = JOBS[key];
    const p = h('div', 'd-plan');
    p.innerHTML = `<div class="d-plan-head">${I.rehearse}Rehearsal — nothing was changed<span>${job.plan.length} steps</span></div>
      <ol>${job.plan.map(([s, risk]) => `<li>${esc(s)}${risk ? `<span class="d-risk">${esc(risk)}</span>` : ''}</li>`).join('')}</ol>
      <div class="d-plan-foot"><button class="d-btn" type="button" data-x="no">Cancel</button><button class="d-btn is-solid" type="button" data-x="go">Run it for real</button></div>`;
    turn(p);
    p.querySelector('[data-x="no"]').addEventListener('click', () => {
      p.querySelector('.d-plan-foot').innerHTML = '<span class="d-note">Cancelled. Nothing ran.</span>';
    });
    p.querySelector('[data-x="go"]').addEventListener('click', () => {
      p.querySelector('.d-plan-foot').remove();
      dry.setAttribute('aria-pressed', 'false');
      execute(text, key);
    });
  }

  async function execute(text, key) {
    run = { t0: Date.now(), stopped: false, done: false };
    actions = 0;
    paintCount();
    computer.hidden = false;
    resetDesk();
    setWorking(true);

    let g = null;
    try {
      if (JOBS[key].intro) await stream(JOBS[key].intro);
      g = stepsGroup(true);
      await sleep(350);
      const out = await JOBS[key].go(g, text);
      g.finish();
      if (out.check) {
        const c = turn(h('div', 'd-check is-busy', `${I.busy}<span><b>Checking the work…</b><i>A second model is looking at the goal, the steps and the screen.</i></span>`)).firstChild;
        await sleep(1300);
        c.className = 'd-check';
        c.innerHTML = `${I.check}<span><b>Checked — the goal was met</b><i>${esc(out.check)}</i></span>`;
      }
      await stream(out.says);
      current.turns.push({ steps: g.list.slice(), n: g.list.length }, { says: esc(out.says) });
      current.line = out.says;
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
      if (g) g.finish();
      addSays('<span style="color:var(--ink-3)">Stopped. Nothing else will happen.</span>');
    } finally {
      run.done = true;
      setWorking(false);
      paintRail();
      chips.hidden = current !== bots[0];
    }
  }

  stopBtn.addEventListener('click', () => { if (run) run.stopped = true; });
  dry.addEventListener('click', () => {
    const on = dry.getAttribute('aria-pressed') !== 'true';
    dry.setAttribute('aria-pressed', String(on));
    if (on) toast('Rehearse is on: the next job plans every step and changes nothing.');
  });

  $('#dForm').addEventListener('submit', (e) => { e.preventDefault(); start(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(input.value); }
  });
  const fit = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
  input.addEventListener('input', fit);

  /* ── the model picker ───────────────────────────────────────────── */

  const MODELS = [
    ['Claude', [['Fable 5.1', 'Most capable'], ['Opus 5.5', 'Deep work, long jobs'], ['Sonnet 5', 'Fast and careful — the default'], ['Haiku 4.5', 'Quickest, for small jobs']]],
    ['NVIDIA NIM', [['Llama 3.3 70B', 'Meta · tools'], ['Qwen3 235B', 'Alibaba · tools, reasoning'], ['DeepSeek V3.1', 'DeepSeek · tools']]],
  ];
  const menu = $('#dMenu');
  const picker = $('#dPicker');
  function paintMenu() {
    const now = $('#dModel').textContent;
    menu.innerHTML = MODELS.map(([group, list]) =>
      `<div class="d-menu-label">${group}</div>` +
      list.map(([n, note]) => `<button class="d-opt${n === now ? ' is-on' : ''}" type="button" data-m="${esc(n)}"><span><b>${esc(n)}</b><small>${esc(note)}</small></span>${I.tick}</button>`).join('')
    ).join('');
  }
  function showMenu(on) {
    menu.hidden = !on;
    picker.setAttribute('aria-expanded', String(on));
    if (on) paintMenu();
  }
  picker.addEventListener('click', (e) => { e.stopPropagation(); showMenu(menu.hidden); });
  menu.addEventListener('click', (e) => {
    const o = e.target.closest('[data-m]');
    if (!o) return;
    $('#dModel').textContent = o.dataset.m;
    showMenu(false);
  });
  root.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('#dMenu')) showMenu(false); });

  /* ── voice ──────────────────────────────────────────────────────── */

  const vox = $('#dVox');
  const vlog = $('#dVoxLog');
  const mic = $('#dMic');
  let voxRun = 0;
  let levelTimer = null;

  function voxState(word, hint) {
    vox.dataset.state = word.toLowerCase();
    $('#dVoxState').textContent = word;
    if (hint != null) $('#dVoxHint').textContent = hint;
  }
  function voxLine(kind, text) {
    const l = h('div', 'd-vl ' + kind, esc(text));
    vlog.appendChild(l);
    vlog.scrollTop = vlog.scrollHeight;
  }
  // A fake microphone: quiet room tone, and a voice when it is "your" turn.
  function level(talking) {
    clearInterval(levelTimer);
    levelTimer = setInterval(() => {
      const v = talking ? 0.35 + Math.random() * 0.6 : Math.random() * 0.08;
      vox.style.setProperty('--lvl', v.toFixed(2));
    }, 90);
  }

  async function voxScript(n) {
    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 50 : ms));
    const alive = () => voxRun === n && !vox.hidden;
    const receipts = bots.some((b) => b.id === 'rc');

    voxState('Starting', 'Asking for the microphone…'); level(false);
    await wait(700); if (!alive()) return;
    voxState('Listening', 'Microphone is working — just talk.');
    await wait(1100); if (!alive()) return;
    level(true); voxState('Hearing');
    await wait(1500); if (!alive()) return;
    level(false);

    if (!receipts) {
      voxLine('you', 'Make me an agent called Receipts that files my receipts by month');
      voxState('Thinking'); await wait(1000); if (!alive()) return;
      bots.push({ id: 'rc', name: 'Receipts', title: 'Files receipts by month', hue: 24, turns: [], fresh: true });
      paintRail();
      voxLine('did', 'made the agent “Receipts”');
      await wait(500); if (!alive()) return;
      voxState('Talking');
      voxLine('said', 'Done — Receipts is in your list. Want it in a workspace?');
    } else {
      voxLine('you', 'What did Bookkeeper say last?');
      voxState('Thinking'); await wait(900); if (!alive()) return;
      voxLine('did', 'read what Bookkeeper said');
      await wait(400); if (!alive()) return;
      voxState('Talking');
      voxLine('said', 'It filed 23 receipts into September, and put two it couldn’t read in a folder called Check these.');
    }
    await wait(2600); if (!alive()) return;
    voxState('Listening', 'Click the mic again to hear another.');
  }

  function voice(on) {
    vox.hidden = !on;
    mic.classList.toggle('is-on', on);
    voxRun++;
    clearInterval(levelTimer);
    if (on) { vlog.textContent = ''; voxScript(voxRun); }
  }
  mic.addEventListener('click', () => {
    if (vox.hidden) return voice(true);
    // Already open: run the next exchange rather than closing it.
    vlog.textContent = '';
    voxRun++;
    voxScript(voxRun);
  });
  $('#dVoxClose').addEventListener('click', () => voice(false));

  /* ── settings ───────────────────────────────────────────────────── */

  const sheet = $('#dSheet');
  function showSheet(on, tab) {
    sheet.hidden = !on;
    if (on && tab) pickTab(tab);
  }
  function pickTab(tab) {
    sheet.querySelectorAll('.d-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === tab));
    sheet.querySelectorAll('.d-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  }
  sheet.querySelectorAll('.d-tab').forEach((t) => t.addEventListener('click', () => pickTab(t.dataset.tab)));
  sheet.querySelectorAll('[data-set]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      group.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      root.dataset[group.dataset.set] = b.dataset.v;
    });
  });
  sheet.querySelectorAll('.d-target').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.target === 'remote') { toast('In the app you point it at a spare PC running the Operator node, and it works there instead.'); return; }
  }));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { showSheet(false); showMenu(false); } });

  /* ── everything else with a data-act ────────────────────────────── */

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    switch (a.dataset.act) {
      case 'settings': showSheet(true, 'look'); break;
      case 'computer': showSheet(true, 'computer'); break;
      case 'close': showSheet(false); break;
      case 'browser': toast('Opens the agent’s own browser. Sign in to a site there once and it stays signed in.'); break;
      case 'new': toast('Makes a new agent with its own memory, persona and model. Or just ask the voice to.'); break;
      case 'codenew': toast('Starts a fresh chat in a project folder you pick.'); break;
      case 'picker': toast('Same models as the Agents side — Claude, or anything on NVIDIA NIM.'); break;
    }
  });

  /* ── Agents / Code ──────────────────────────────────────────────── */

  root.querySelectorAll('.d-mode').forEach((m) => m.addEventListener('click', () => {
    const code = m.dataset.mode === 'code';
    root.querySelectorAll('.d-mode').forEach((x) => x.classList.toggle('is-on', x === m));
    $('#dAgents').hidden = code;
    $('#dCode').hidden = !code;
    if (code && !vox.hidden) voice(false);
  }));

  let codeBusy = false;
  async function codeRun(text) {
    text = String(text || '').trim();
    if (!text || codeBusy) return;
    codeBusy = true;
    const ct = $('#dCodeThread');
    const cc = $('#dCodeCol');
    const ci = $('#dCodeInput');
    ci.value = '';
    if (cc.classList.contains('is-empty')) { ct.textContent = ''; cc.classList.remove('is-empty'); }
    const add = (el) => { const w = h('div', 'd-turn'); w.appendChild(el); ct.appendChild(w); ct.scrollTop = ct.scrollHeight; return el; };
    const you = h('div', 'd-you'); you.appendChild(h('span', null, esc(text))); add(you);

    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 40 : ms));
    const g = add(h('div', 'd-steps is-open', `<button class="d-steps-head" type="button">${I.caret}<span>Working in tetris</span><i class="spin"></i></button><div class="d-steps-body"></div>`));
    g.firstChild.addEventListener('click', () => g.classList.toggle('is-open'));
    const body = g.querySelector('.d-steps-body');
    const steps = [
      ['file', 'Read <span class="arg">tetris.html</span>'],
      ['term', 'Grep <span class="arg">score</span>'],
      ['type', 'Edit <span class="arg">tetris.html</span> — save best score to localStorage'],
      ['type', 'Edit <span class="arg">tetris.html</span> — show “Best” beside the score'],
      ['term', 'Bash <span class="arg">npx html-validate tetris.html</span>'],
    ];
    for (const [ic, what] of steps) {
      body.querySelectorAll('.is-now').forEach((s) => s.classList.remove('is-now'));
      body.appendChild(h('div', 'd-step is-now', `${I[ic]}<span class="what">${what}</span>`));
      ct.scrollTop = ct.scrollHeight;
      await wait(750);
    }
    body.querySelectorAll('.is-now').forEach((s) => s.classList.remove('is-now'));
    g.firstChild.innerHTML = `${I.caret}<span>Worked in tetris</span><span class="n">${steps.length} steps</span>`;
    g.classList.remove('is-open');
    add(h('div', 'd-says', 'Added a best score. It’s saved to <code>localStorage</code> when a game ends, so it survives a reload, and shows as <b>Best</b> under the current score. The file validates clean.'));
    codeBusy = false;
  }
  $('#dCodeForm').addEventListener('submit', (e) => { e.preventDefault(); codeRun($('#dCodeInput').value); });
  $('#dCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); codeRun(e.target.value); }
  });
  root.querySelector('[data-code]').addEventListener('click', (e) => codeRun(e.currentTarget.dataset.code));

  /* ── go ─────────────────────────────────────────────────────────── */

  paintRail();
  paintThread();
  paintChips();
})();
