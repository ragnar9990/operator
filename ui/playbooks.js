/* ── the Playbooks tab ─────────────────────────────────────────────────
 * A job that worked, saved as the steps it took, and replayed with no model
 * (playbooks.js in the main process does the replaying). This is where you
 * see them: what each one does, step by step, how its runs have gone, and a
 * run as it happens — which step it is on, which one it had to repair.
 *
 * Loaded after renderer.js, and borrows its helpers (esc, trim) rather than
 * keeping copies.
 */

(() => {
  const view = document.getElementById('pbView');
  if (!view) return;

  const $ = (id) => document.getElementById(id);
  const listEl = $('pbList');
  const emptyEl = $('pbEmpty');
  const desk = $('pbDesk');
  const stepsEl = $('pbSteps');
  const badge = $('pbBadge');
  const modeBtn = document.querySelector('.mode[data-mode="playbooks"]');

  const LAST = 'operator.playbook';
  let books = [];
  let current = null;     // the playbook on the desk, as playbooks.get() gives it
  let shown = false;
  let models = [];
  // The run going on now, if any: which playbook, and how each step went.
  let live = null;        // { playbookId, runId, dryRun, states: [], notes: [], steps }
  let lastResult = {};    // playbookId → the end of its last run this session

  const recall = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
  const keep = (id) => { try { localStorage.setItem(LAST, id); } catch { /* fine */ } };
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayOf = (ms) => new Date(ms).toDateString();
  const stamp = (ms) => (dayOf(ms) === dayOf(Date.now()) ? clock(ms)
    : new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));
  const secs = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + 's';
  // What kind of step, said the way the person using it would say it.
  const KIND = { web: 'Browser', screen: 'Screen', shell: 'Files & settings', mail: 'Email', you: 'Your turn', wait: 'Waits' };

  // {{month}}, {yesterday} and the rest, in a step's words, as tags that say
  // what will go there — and, for an input, what it is set to now.
  const SAID = {
    today: "today's date", yesterday: "yesterday's date", tomorrow: "tomorrow's date",
    last_month: 'last month', this_month: 'this month', now: 'the time',
    code: 'the code it fetches', file: 'the new file', file_name: "the new file's name", folder: 'the folder',
    email_from: 'who the email is from', email_subject: "the email's subject", email_uid: 'the email',
  };
  function withTags(text, pb) {
    const inputs = new Map(((pb && pb.inputs) || []).map((x) => [x.name, x.value]));
    return esc(text).replace(/\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\s*\}?\}/g, (_m, raw, fmt) => {
      const name = raw.toLowerCase();
      if (name === 'secret') return `<span class="pb-var you" title="Never kept — you type it">your ${esc(fmt || 'password')}</span>`;
      if (SAID[name]) return `<span class="pb-var auto" title="Filled in by itself on every run">${SAID[name]}</span>`;
      const v = inputs.get(name);
      return `<span class="pb-var" title="Changes each run — set it under “Changes each run”">${esc(name.replace(/_/g, ' '))}${v ? `: <i>${esc(v)}</i>` : ''}</span>`;
    });
  }

  /* ── how it works, played out ──────────────────────────────────────
   * One job, run three times, side by side: the first time an agent works
   * every step out (slow, and it uses the AI); every time after, the saved
   * steps run by themselves (seconds, free); and when a site has changed, only
   * the step that broke goes back to the AI, and the fix is kept. All three
   * are on screen at once, so the difference reads at a glance — the clocks
   * and the bars under them are on the same scale. The one playing is lit, and
   * a click plays any of them again. With motion off they hold still, finished. */

  const HOW_STEPS = ['Open the supplier site', 'Click “Invoices”', 'Click “Download all”', 'File the PDFs'];
  const HOW_FIXED = 'Click “Download PDFs”';
  const HOW_RUNS = [
    { k: 'ai', head: 'The first time', body: 'An agent works out every step.', secs: 72, chip: 'Uses AI' },
    { k: 'free', head: 'Every time after', body: 'The saved steps run by themselves.', secs: 4, chip: 'No AI · free' },
    { k: 'fix', head: 'When a site changes', body: 'Only the step that broke is worked out again.', secs: 9, chip: 'AI for one step' },
  ];
  const HOW_LONGEST = 72;
  const HOW_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6.5 18.5 12 13 17.5"/></svg>';

  const still = () => document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const took = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

  function howItWorks(box, { onClose } = {}) {
    box.innerHTML =
      (onClose ? '<div class="pb-how-top"><b>How a playbook works</b><button class="pb-how-close" type="button" aria-label="Hide how it works">×</button></div>' : '') +
      '<div class="pb-how-runs">' +
        HOW_RUNS.map((r, i) => (i ? `<span class="pb-how-arrow">${HOW_ARROW}</span>` : '') +
          `<div class="pb-run" data-k="${r.k}" role="button" tabindex="0" aria-label="${r.head}: ${r.body} Press to play it.">` +
            `<div class="pb-run-head"><b>${r.head}</b><span>${r.body}</span></div>` +
            '<ol class="pb-run-steps">' + HOW_STEPS.map((t) => `<li><span class="pb-run-dot"></span><span class="pb-run-text">${t}</span><span class="pb-run-note"></span></li>`).join('') + '</ol>' +
            `<div class="pb-run-foot"><div class="pb-run-time"><b class="pb-run-clock"></b><span class="pb-run-chip">${r.chip}</span></div><div class="pb-run-bar"><i></i></div></div>` +
          '</div>').join('') +
      '</div>' +
      '<p class="pb-how-note">Your passwords are never saved. A step that needs one stops, and you type it.</p>';

    const cards = [...box.querySelectorAll('.pb-run')];
    if (onClose) box.querySelector('.pb-how-close').addEventListener('click', onClose);

    let run = 0;            // bumped to cancel whatever is playing
    const wait = (ms, my) => new Promise((r) => setTimeout(r, ms)).then(() => {
      if (my !== run) throw new Error('cancelled');
    });
    // Off screen (another tab, a hidden page): hold, rather than play to nobody.
    const visible = () => !document.hidden && box.offsetParent !== null;

    const parts = (c) => ({ rows: [...c.querySelectorAll('li')], clock: c.querySelector('.pb-run-clock'), bar: c.querySelector('.pb-run-bar i') });
    const setRow = (row, state, note) => { row.className = state || ''; row.querySelector('.pb-run-note').textContent = note || ''; };
    const setTime = (p, s) => { p.clock.textContent = took(s); p.bar.style.width = s ? `${Math.max(2, (s / HOW_LONGEST) * 100)}%` : '0'; };
    const reset = (p, state) => p.rows.forEach((row, j) => { row.querySelector('.pb-run-text').textContent = HOW_STEPS[j]; setRow(row, state); });

    // A run as it ends — what a card shows while another one plays, and with motion off.
    function finish(i) {
      const p = parts(cards[i]);
      reset(p, 'done');
      if (i === 2) { p.rows[2].querySelector('.pb-run-text').textContent = HOW_FIXED; setRow(p.rows[2], 'done fixed', 'fixed'); }
      setTime(p, HOW_RUNS[i].secs);
    }

    // The clock runs while the steps do: from `a` to `b` seconds over `ms`.
    async function count(p, a, b, ms, my) {
      const n = Math.max(1, Math.round(ms / 90));
      for (let k = 1; k <= n; k++) { await wait(ms / n, my); setTime(p, Math.round(a + ((b - a) * k) / n)); }
    }

    const SCENES = [
      async (p, my) => {        // the first time: each step worked out, slowly
        for (let j = 0; j < 4; j++) {
          setRow(p.rows[j], 'active ai', 'thinking…');
          await count(p, j * 18, (j + 1) * 18, 1100, my);
          setRow(p.rows[j], 'done');
        }
      },
      async (p, my) => {        // every time after: nothing to work out
        for (let j = 0; j < 4; j++) { setRow(p.rows[j], 'active'); await count(p, j, j + 1, 260, my); setRow(p.rows[j], 'done'); }
      },
      async (p, my) => {        // a button moved: only that step goes back to the AI
        for (let j = 0; j < 2; j++) { setRow(p.rows[j], 'active'); await count(p, j, j + 1, 260, my); setRow(p.rows[j], 'done'); }
        setRow(p.rows[2], 'active'); await wait(400, my);
        setRow(p.rows[2], 'broken', 'not there'); await wait(1100, my);
        setRow(p.rows[2], 'active ai', 'fixing…'); await count(p, 2, 8, 1400, my);
        p.rows[2].querySelector('.pb-run-text').textContent = HOW_FIXED;
        setRow(p.rows[2], 'done fixed', 'fixed'); await wait(500, my);
        setRow(p.rows[3], 'active'); await count(p, 8, 9, 260, my); setRow(p.rows[3], 'done');
      },
    ];

    async function play(from) {
      const my = ++run;
      cards.forEach((_c, i) => finish(i));
      if (still()) { box.classList.remove('playing'); cards.forEach((c) => c.classList.remove('on')); return; }
      let i = from;
      try {
        for (;;) {
          while (!visible()) await wait(500, my);
          box.classList.add('playing');
          cards.forEach((c, j) => c.classList.toggle('on', j === i));
          const p = parts(cards[i]);
          reset(p, ''); setTime(p, 0);
          await wait(450, my);
          await SCENES[i](p, my);
          await wait(i === 2 ? 2600 : 1600, my);
          i = (i + 1) % SCENES.length;
        }
      } catch { /* a newer play() took over, or it was stopped */ }
    }

    cards.forEach((c, i) => {
      c.addEventListener('click', () => play(i));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(i); } });
    });
    play(0);
    return { stop: () => { run++; }, restart: () => play(0) };
  }

  // The empty page explains itself; a playbook's page does when asked.
  howItWorks($('pbHowEmpty'));
  const HOW_SEEN = 'operator.pbHowSeen';
  let deskHow = null;
  function toggleHow(open) {
    const box = $('pbHow');
    const btn = $('pbHowBtn');
    const show = open === undefined ? box.hidden : open;
    box.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    btn.classList.toggle('on', show);
    if (show) {
      if (!deskHow) deskHow = howItWorks(box, { onClose: () => toggleHow(false) });
      else deskHow.restart();
    } else if (deskHow) deskHow.stop();
    try { localStorage.setItem(HOW_SEEN, '1'); } catch { /* fine */ }
  }
  $('pbHowBtn').addEventListener('click', () => toggleHow());
  $('pbGoAgents').addEventListener('click', () => document.querySelector('.mode[data-mode="agents"]').click());

  /* ── the list ──────────────────────────────────────────────────── */

  function line(b) {
    if (live && live.playbookId === b.id) return { text: live.dryRun ? 'Test run now' : 'Running now', kind: 'busy' };
    const s = b.stats || {};
    const n = `${b.steps} step${b.steps === 1 ? '' : 's'}`;
    if (!s.runs) return { text: `${n} · not run yet`, kind: 'off' };
    if (s.lastError) return { text: `Stopped last time · ${stamp(s.lastRun)}`, kind: 'ask' };
    return { text: `${n} · worked ${stamp(s.lastRun)}`, kind: 'on' };
  }

  async function load() {
    try { books = await window.operator.playbooks(); } catch { books = []; }
    if (!shown) return;
    paintList();
    const want = (current && books.find((b) => b.id === current.id)) || books.find((b) => b.id === recall()) || books[0];
    if (want) await open(want.id, true); else showEmpty();
  }

  function paintList() {
    listEl.textContent = '';
    if (!books.length) {
      const p = document.createElement('p');
      p.className = 'staff-none';
      p.textContent = 'No playbooks yet.';
      listEl.appendChild(p);
      return;
    }
    for (const b of books) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'staff-row' + (current && current.id === b.id ? ' on' : '');
      const s = line(b);
      row.innerHTML = '<span class="pb-row-ic' + (s.kind === 'busy' ? ' busy' : '') + '" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 6.5h11M8 12h11M8 17.5h11"/><path d="m3.6 5 2.2 1.5-2.2 1.5Z"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/></svg></span>' +
        '<span class="staff-row-text"><b>' + esc(b.name) + '</b><small class="st-' + s.kind + '">' + esc(s.text) + '</small></span>';
      row.addEventListener('click', () => open(b.id));
      listEl.appendChild(row);
    }
  }

  function showEmpty() {
    current = null;
    emptyEl.hidden = false;
    desk.hidden = true;
  }

  /* ── one playbook ──────────────────────────────────────────────── */

  async function open(id, quiet) {
    // Opened from elsewhere (the Agents tab, a notification): come here first,
    // remembering which one so the tab opens on it.
    if (!shown && modeBtn && !quiet) { keep(id); modeBtn.click(); }
    let pb = null;
    try { pb = await window.operator.playbook(id); } catch { pb = null; }
    if (!pb) { if (!books.length) showEmpty(); return; }
    current = pb;
    keep(pb.id);
    emptyEl.hidden = true;
    desk.hidden = false;
    paintList();
    paint();
  }

  // A playbook that only opens pages: running it opens them and says nothing,
  // because the reading and the answer were the AI. Said plainly, with the
  // thing that does work for that kind of job — the agent, on a schedule.
  async function paintLookOnly() {
    const el = $('pbLookOnly');
    if (!el) return;
    if (!current || !current.lookOnly) { el.hidden = true; el.textContent = ''; return; }
    let bots = [];
    try { bots = (await window.operator.listBots()).filter((b) => !b.employee); } catch { bots = []; }
    const agent = bots.find((b) => current.source && b.id === current.source.botId) || bots[0];
    if (!agent) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      '<b>This one only opens web pages, so running it won’t show you anything.</b>' +
      `<p>For news or anything that changes, have ${esc(agent.name)} do it on a schedule instead — it looks again each time and tells you what it found.</p>` +
      '<div class="pb-lookonly-set">' +
        '<select class="ro-every" aria-label="How often"><option value="day">Every day</option><option value="weekday">Every weekday</option><option value="week">Every Monday</option></select>' +
        '<input class="ro-at" type="time" value="08:00" aria-label="At what time" />' +
        '<button class="pill solid sm" type="button" data-act="routine">Schedule it</button>' +
      '</div>';
    el.querySelector('[data-act="routine"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const every = el.querySelector('.ro-every').value;
      const at = el.querySelector('.ro-at').value || '08:00';
      btn.disabled = true;
      const r = await window.operator.addRoutine(agent.id, { name: current.name.slice(0, 50), prompt: current.goal || current.name, every, at, kind: 'task' });
      if (!r) { btn.disabled = false; return; }
      const when = { day: 'every day', weekday: 'every weekday', week: 'every Monday' }[every];
      el.innerHTML = `<b>Scheduled — ${esc(agent.name)} does this ${when} at ${esc(at)} and lets you know what it found.</b>` +
        '<p>You can delete this playbook now.</p>' +
        '<div class="pb-lookonly-set"><button class="pill sm" type="button" data-act="delete">Delete this playbook</button></div>';
      el.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        const id = current && current.id;
        if (!id) return;
        current = null;
        await window.operator.playbookDelete(id);
        await load();
      });
    });
  }

  // One line under the name: how many steps, and how its runs have gone.
  function paintSub() {
    const pb = current;
    if (!pb) return;
    const s = pb.stats || {};
    const n = pb.steps.length;
    const bits = [`${n} step${n === 1 ? '' : 's'}`];
    if (!s.runs) bits.push('not run yet');
    else {
      bits.push(`last ran ${stamp(s.lastRun)}${s.lastError ? ' — stopped' : ''}`);
      if (s.ok) bits.push(`takes about ${secs((s.totalMs || 0) / s.ok)}`);
      if (s.runs > 1) bits.push(`worked ${s.ok || 0} of ${s.runs} times`);
    }
    $('pbSub').textContent = bits.join(' · ');
  }

  // A model's name, for the summary and the repair picker.
  let defaultModel = null;
  function modelName(id) {
    const m = models.find((x) => x.id === (id || defaultModel));
    return m ? m.name : 'the AI';
  }

  function paint() {
    const pb = current;
    if (!pb) return;
    $('pbName').textContent = pb.name;
    paintSub();
    paintState();
    paintLookOnly();
    paintResult();
    paintSteps();
    paintInputs();
    paintModel();
    paintMachine();
    paintPlaybookWatches();
  }

  function paintState() {
    const running = live && current && live.playbookId === current.id;
    const busyElsewhere = live && !running;
    $('pbRun').hidden = Boolean(running);
    $('pbRehearse').hidden = Boolean(running);
    $('pbStop').hidden = !running;
    $('pbRun').disabled = Boolean(busyElsewhere);
    $('pbRehearse').disabled = Boolean(busyElsewhere);
    const st = $('pbState');
    if (running) {
      // Which step, and whether the AI is involved right now — the whole idea,
      // visible while it happens.
      const total = (live.steps || current.steps).length;
      const at = live.states.findIndex((x) => x === 'running' || x === 'healing');
      const fixing = at !== -1 && live.states[at] === 'healing';
      const where = at === -1 ? 'Starting' : `Step ${at + 1} of ${total}`;
      st.textContent = live.dryRun ? `Test run · ${where}`
        : fixing ? `${where} · fixing a step that changed` : where;
      st.className = 'staff-state ' + (fixing ? 'st-ask' : 'st-busy');
    }
    else if (busyElsewhere) { st.textContent = 'Another playbook is running'; st.className = 'staff-state st-off'; }
    else { st.textContent = ''; st.className = 'staff-state'; }
  }

  function paintResult() {
    const el = $('pbResult');
    const r = current && lastResult[current.id];
    if (!r || (live && live.playbookId === current.id)) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'pb-result ' + (r.ok ? 'good' : r.stopped ? 'off' : 'bad');
    if (r.ok) {
      el.innerHTML = r.dryRun
        ? '<b>✓ Test run passed</b> — nothing was changed.'
        : `<b>✓ Done in ${secs(r.ms)}</b>${r.healed ? ` — ${r.healed === 1 ? 'one step had' : `${r.healed} steps had`} changed and ${r.healed === 1 ? 'was' : 'were'} fixed` : ''}${r.skipped ? ` · ${r.skipped} skipped` : ''}` +
          // What it printed is the proof of what it did.
          (r.printed ? `<span class="pb-printed">${esc(r.printed)}</span>` : '');
    } else {
      el.innerHTML = `<b>${r.stopped ? 'Stopped' : '✕ Stopped'}</b>${r.error && !r.stopped ? ` — ${esc(r.error)}` : ''}`;
    }
  }

  function stepState(i) {
    if (!live || !current || live.playbookId !== current.id) return { state: '', note: '' };
    return { state: live.states[i] || '', note: live.notes[i] || '' };
  }

  function paintSteps() {
    const steps = (live && current && live.playbookId === current.id && live.steps) || current.steps;
    stepsEl.textContent = '';
    steps.forEach((s, i) => stepsEl.appendChild(stepRow(s, i)));
    paintLegend();
  }

  // What the coloured words in the steps mean — only the ones this playbook has.
  function paintLegend() {
    const has = (sel) => Boolean(stepsEl.querySelector(sel));
    const keys = [
      ['.pb-var:not(.auto):not(.you)', 'set', 'changes each run'],
      ['.pb-var.auto', 'auto', 'filled in by itself'],
      ['.pb-var.you, .k-you', 'you', 'you do this part'],
      ['.pb-mark-ask', 'ask', 'waits for your OK'],
    ].filter(([sel]) => has(sel));
    $('pbLegend').innerHTML = keys.map(([, cls, words]) => `<span class="pb-key ${cls}">${words}</span>`).join('');
  }

  // A step's words as a sentence: a capital to start, and a shell command
  // said for what it is, with the command itself shown as code.
  function stepWords(s) {
    let text = String(s.text || '');
    const cmd = s.kind === 'shell' && text.match(/^run:\s*([\s\S]*)$/i);
    if (cmd) return `Runs a Windows command <code class="pb-cmd" title="${esc(cmd[1])}">${withTags(cmd[1], current)}</code>`;
    // "fill 2 field(s) and submit" — say which boxes.
    if (s.tool === 'browser_fill_form') {
      const boxes = s.fields.filter((f) => /\.target$/.test(f.path)).map((f) => f.value);
      const secret = s.fields.some((f) => /\{\{\s*secret/i.test(f.value));
      if (boxes.length) text = `fill in ${boxes.join(', ').replace(/, ([^,]*)$/, ' and $1')}${/submit/.test(text) ? ', then submit' : ''}${secret ? ' (you type the password)' : ''}`;
    }
    // The icon already says it is the browser.
    text = text.replace(/ in the browser$/, '');
    // A tag in quotes is still just the tag.
    return withTags(text.charAt(0).toUpperCase() + text.slice(1), current)
      .replace(/&quot;(<span class="pb-var[^"]*"[^>]*>(?:(?!<\/span>).)*<\/span>)&quot;/g, '$1');
  }

  // A small picture of what kind of step it is, in place of a word for it.
  const KIND_ICON = {
    web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17Z"/>',
    screen: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    shell: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 3 2.5-3 2.5M12.5 15.5h4"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7.5 8 6 8-6"/>',
    you: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  };

  // The step whose editor is open, so a change that redraws the list leaves
  // it open.
  let openStep = null;

  // What each value in a step is, in words, for its box in the editor.
  const FIELD_SAID = {
    url: 'Web address', target: 'Box', text: 'Text', field: 'Box', option: 'Choice', command: 'Command',
    to: 'To', subject: 'Subject', body: 'Message', keys: 'Keys', key: 'Key', title: 'Window', name: 'Button',
    what: 'What you do', until_gone: 'Done when this goes', from: 'From', args: 'Options',
  };

  function stepRow(s, i) {
    const li = document.createElement('li');
    const { state, note } = stepState(i);
    li.className = `pb-step k-${s.kind}${state ? ' s-' + state : ''}`;
    li.dataset.id = s.id;
    const lock = live && current && live.playbookId === current.id;
    const marks = [];
    if (s.confirm) marks.push('<span class="pb-mark-ask" title="Stops and asks you before doing this">asks first</span>');
    if (note) marks.push(`<span class="pb-note">${esc(note)}</span>`);
    li.innerHTML =
      `<span class="pb-n">${i + 1}</span>` +
      `<span class="pb-kicon" title="${esc(KIND[s.kind] || 'Step')}"><svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICON[s.kind] || KIND_ICON.screen}</svg></span>` +
      '<div class="pb-step-main">' +
        `<div class="pb-step-text">${stepWords(s)}${marks.join('')}</div>` +
        '<div class="pb-edit" hidden></div>' +
      '</div>' +
      `<button class="mini pb-edit-btn" type="button"${lock ? ' disabled' : ''}>Edit</button>`;
    li.querySelector('.pb-edit-btn').addEventListener('click', () => toggleEdit(li, s));
    if (openStep === s.id && !lock) toggleEdit(li, s);
    return li;
  }

  // Everything you can change about one step, folded away until asked for:
  // what it types or opens, whether it asks first, and taking it out.
  function toggleEdit(li, s) {
    const box = li.querySelector('.pb-edit');
    const btn = li.querySelector('.pb-edit-btn');
    if (!box.hidden) {
      box.hidden = true; btn.textContent = 'Edit'; li.classList.remove('editing'); openStep = null;
      return;
    }
    openStep = s.id;
    btn.textContent = 'Done';
    li.classList.add('editing');
    box.textContent = '';
    for (const f of s.fields) {
      const row = document.createElement('label');
      row.className = 'pb-field';
      const name = f.path.split('.').filter((p) => !/^\d+$/.test(p)).pop() || f.path;
      row.innerHTML = `<span>${esc(FIELD_SAID[name] || name)}</span>`;
      const input = document.createElement(f.value.length > 60 ? 'textarea' : 'input');
      if (input.tagName === 'INPUT') input.type = 'text';
      input.value = f.value;
      input.spellcheck = false;
      input.addEventListener('change', () => change({ step: { id: s.id, path: f.path, value: input.value } }));
      row.appendChild(input);
      box.appendChild(row);
    }
    const facts = [];
    if (s.fields.length) facts.push('Put <code>{{name}}</code> where a word should change each run.');
    if (s.check) facts.push(s.kind === 'web' ? `Afterwards it checks it’s on ${esc(s.check)}.` : `Afterwards it checks ${esc(s.check)} is open.`);
    if (s.brittle) facts.push('It clicks a spot on the screen, so it may need fixing if the window moves.');
    if (s.healed) facts.push('This step was fixed automatically after something changed.');
    if (facts.length) {
      const p = document.createElement('p');
      p.className = 'pb-edit-facts';
      p.innerHTML = facts.join(' ');
      box.appendChild(p);
    }
    const row = document.createElement('div');
    row.className = 'pb-edit-row';
    row.innerHTML = `<label class="pb-ask"><input type="checkbox"${s.confirm ? ' checked' : ''} /> Ask me before this step</label>` +
      '<button class="mini" type="button" data-act="remove">Remove step</button>';
    row.querySelector('input').addEventListener('change', (e) => change({ step: { id: s.id, confirm: e.target.checked } }));
    row.querySelector('[data-act="remove"]').addEventListener('click', (e) => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Sure?';
        setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove step'; }, 2500);
        return;
      }
      openStep = null;
      change({ step: { id: s.id, remove: true } });
    });
    box.appendChild(row);
    box.hidden = false;
  }

  async function change(patch) {
    if (!current) return;
    const pb = await window.operator.playbookUpdate(current.id, patch);
    if (pb) { current = pb; paint(); load(); }
  }

  function paintInputs() {
    const box = $('pbInputs');
    box.textContent = '';
    // Only shown when there is something in it.
    $('pbInputsBlock').hidden = !current.inputs.length;
    for (const inp of current.inputs) {
      const row = document.createElement('label');
      row.className = 'field pb-input';
      row.innerHTML = `<span>${esc(inp.name.replace(/_/g, ' '))}</span>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = inp.value;
      input.spellcheck = false;
      input.placeholder = 'its value next time';
      input.addEventListener('change', () => change({ inputs: { [inp.name]: input.value } }));
      row.appendChild(input);
      box.appendChild(row);
    }
    $('pbSuggestions').textContent = '';
  }

  async function paintModel() {
    const sel = $('pbModel');
    if (!models.length) {
      try {
        const got = (await window.operator.listModels()) || {};
        models = got.models || [];
        defaultModel = got.current || null;
      } catch { models = []; }
    }
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = defaultModel ? `Default (${modelName(null)})` : 'Default';
    sel.appendChild(auto);
    let group = null;
    let holder = sel;
    for (const m of models) {
      if (m.tools === false) continue;
      if (m.providerName !== group) {
        group = m.providerName;
        holder = document.createElement('optgroup');
        holder.label = group;
        sel.appendChild(holder);
      }
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      holder.appendChild(o);
    }
    sel.value = current.model && models.some((m) => m.id === current.model) ? current.model : '';
  }

  $('pbModel').addEventListener('change', (e) => change({ model: e.target.value || null }));

  // Which computer it runs on (ui/fleet.js has the list). Operator's own
  // browser only exists on the computer Operator is open on, so a playbook
  // with web steps is told so rather than finding out at step one.
  function paintMachine() {
    const sel = $('pbMachine');
    if (!sel || !current || !window.__fleet) return;
    const fleet = window.__fleet.list();
    window.__fleet.fillSelect(sel, current.machine, fleet.length ? 'The one set in Settings → Computer' : 'This computer');
    // Said only when there is something to warn about.
    const note = $('pbMachineNote');
    const m = window.__fleet.list().find((x) => x.id === current.machine);
    note.textContent = m && current.usesBrowser ? 'Its web steps only work on this computer.'
      : m && m.online === false ? `${m.name} isn’t answering right now.` : '';
    note.hidden = !note.textContent;
  }
  $('pbMachine').addEventListener('change', (e) => change({ machine: e.target.value || null }));
  document.addEventListener('fleet:changed', () => { if (shown) paintMachine(); });

  // Rename in place.
  const nameEl = $('pbName');
  function rename() {
    if (!current || nameEl.isContentEditable) return;
    nameEl.contentEditable = 'true';
    nameEl.focus();
    document.getSelection().selectAllChildren(nameEl);
  }
  nameEl.addEventListener('click', rename);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !nameEl.isContentEditable) { e.preventDefault(); rename(); return; }
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = current.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', () => {
    if (!nameEl.isContentEditable) return;
    nameEl.contentEditable = 'false';
    const next = nameEl.textContent.trim();
    if (next && next !== current.name) change({ name: next });
    else nameEl.textContent = current.name;
  });

  /* ── running ───────────────────────────────────────────────────── */

  async function start(dryRun) {
    if (!current) return;
    const r = await window.operator.playbookRun(current.id, { dryRun });
    if (r && r.ok === false) {
      lastResult[current.id] = { ok: false, error: r.error };
      paintResult();
    }
  }
  $('pbRun').addEventListener('click', () => start(false));
  $('pbRehearse').addEventListener('click', () => start(true));
  $('pbStop').addEventListener('click', () => window.operator.playbookStop());

  $('pbSuggest').addEventListener('click', async () => {
    if (!current) return;
    const btn = $('pbSuggest');
    const box = $('pbSuggestions');
    btn.disabled = true;
    btn.textContent = 'Looking…';
    let r;
    try { r = await window.operator.playbookSuggest(current.id); } catch (err) { r = { ok: false, error: err.message }; }
    btn.disabled = false;
    btn.textContent = 'Suggest inputs';
    box.textContent = '';
    if (!r || !r.ok) { box.innerHTML = `<p class="pb-none">${esc((r && r.error) || 'Could not ask.')}</p>`; return; }
    if (!r.suggestions.length) { box.innerHTML = '<p class="pb-none">Nothing looks like it will change from run to run.</p>'; return; }
    for (const s of r.suggestions) {
      const row = document.createElement('div');
      row.className = 'pb-sug';
      row.innerHTML = `<span>“${esc(trim(s.value, 40))}” → <code>{{${esc(s.name)}}}</code>${s.why ? `<small>${esc(s.why)}</small>` : ''}</span>`;
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'mini';
      use.textContent = 'Use';
      use.addEventListener('click', async () => {
        const pb = await window.operator.playbookMakeInput(current.id, s.value, s.name);
        if (pb) { current = pb; paint(); }
      });
      row.appendChild(use);
      box.appendChild(row);
    }
  });

  // Delete, with a second click to mean it.
  $('pbDelete').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Click again to delete';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete playbook'; }, 3000);
      return;
    }
    b.classList.remove('armed');
    b.textContent = 'Delete playbook';
    const id = current && current.id;
    if (!id) return;
    current = null;
    await window.operator.playbookDelete(id);
    await load();
  });

  /* ── the user's turn, during a run ─────────────────────────────── */

  function showTurn(evt) {
    const el = $('pbTurn');
    el.hidden = false;
    el.dataset.id = evt.id;
    el.innerHTML = '<div class="pb-turn-head"><span class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></span><b>Your turn</b></div>' +
      `<p>${esc(evt.what)}</p>` +
      '<div class="pb-turn-acts">' +
        (evt.kind === 'secret' ? '<button class="pill sm" type="button" data-act="show">Show me</button>' : '') +
        '<button class="pill sm" type="button" data-act="skip">Skip</button>' +
        `<button class="pill solid sm" type="button" data-act="done">${evt.kind === 'confirm' ? 'Allow it' : "I've done it"}</button>` +
      '</div>';
    el.querySelector('[data-act="done"]').addEventListener('click', () => window.operator.handoverDone(evt.id, ''));
    el.querySelector('[data-act="skip"]').addEventListener('click', () => window.operator.handoverSkip(evt.id));
    const showBtn = el.querySelector('[data-act="show"]');
    if (showBtn) showBtn.addEventListener('click', () => window.operator.handoverShow(evt.id));
  }

  function hideTurn(id) {
    const el = $('pbTurn');
    if (!id || el.dataset.id === id) { el.hidden = true; el.textContent = ''; }
  }

  window.operator.onPlaybookEvent((evt) => {
    switch (evt.type) {
      case 'status':
        if (evt.text === 'running') {
          live = { playbookId: evt.playbookId, runId: evt.runId, dryRun: Boolean(evt.dryRun), states: [], notes: [], steps: null };
          badge.hidden = shown;
          badge.textContent = '•';
        } else if (live && live.runId === evt.runId) {
          live = null;
          badge.hidden = true;
          hideTurn();
          $('pbLive').hidden = true;
        }
        break;
      case 'pb_start':
        if (live) live.steps = evt.steps;
        break;
      case 'pb_step':
        if (live) { live.states[evt.i] = evt.state; live.notes[evt.i] = evt.note || ''; }
        break;
      case 'pb_heal_step':
        if (live) live.notes[evt.i] = 'fixing — something changed…';
        break;
      case 'pb_healed':
        // The repaired steps take the broken one's place; the ones before it
        // are done, the new ones are done too.
        if (live) {
          live.steps = evt.steps;
          const before = live.states.slice(0, evt.i);
          const fixed = Array.from({ length: evt.count }, () => 'ok');
          live.states = [...before, ...fixed];
          live.notes = [...live.notes.slice(0, evt.i), ...fixed.map(() => 'repaired just now')];
        }
        break;
      case 'pb_end':
        lastResult[evt.playbookId] = evt;
        break;
      case 'handover':
        showTurn(evt);
        break;
      case 'handover_end':
        hideTurn(evt.id);
        break;
    }
    if (!shown) return;
    if (current && evt.playbookId === current.id) {
      if (evt.type === 'status' || evt.type === 'pb_end') { load(); return; }
      if (evt.type !== 'handover' && evt.type !== 'handover_end') { paintState(); paintSteps(); }
    } else if (evt.type === 'status') {
      paintList();
      paintState();
    }
  });

  // The live screen, while one of these is running.
  window.operator.onEvent((evt) => {
    if (evt.type !== 'screenshot' || !live || !shown) return;
    if (!current || live.playbookId !== current.id) return;
    $('pbLive').hidden = false;
    $('pbFrame').src = 'data:' + (evt.mime || 'image/png') + ';base64,' + evt.b64;
  });

  window.operator.onPlaybooksChanged(() => { if (shown) load(); else window.operator.playbooks().then((b) => { books = b || []; }).catch(() => {}); });
  window.operator.onPlaybookOpen(({ id }) => { if (id) open(id); });

  /* ── saving a recent run ───────────────────────────────────────── */

  const sheet = $('pbSheet');
  function closeSheet() { sheet.hidden = true; }
  $('pbSheetClose').addEventListener('click', closeSheet);
  $('pbScrim').addEventListener('click', closeSheet);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  async function openSheet() {
    const box = $('pbRecent');
    box.textContent = '';
    sheet.hidden = false;
    let runs = [];
    try { runs = await window.operator.playbooksRecent(); } catch { runs = []; }
    if (!runs.length) {
      box.innerHTML = '<p class="pb-none">No jobs yet. Give an agent a job on the Agents tab — when it has done it, it can be saved from here, or straight from the chat.</p>';
      return;
    }
    for (const r of runs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pb-run-row';
      row.disabled = r.saved || r.usedHelpers || r.lookOnly;
      const why = r.saved ? 'already saved' : r.usedHelpers ? 'used helpers — cannot be replayed'
        : r.lookOnly ? 'only looked things up — schedule it as an agent job instead'
        : r.ok ? 'worked' : 'did not finish';
      row.innerHTML = `<b>${esc(trim(r.prompt || '(no words)', 90))}</b>` +
        `<small>${r.botName ? esc(r.botName) + ' · ' : ''}${stamp(r.at)} · ${r.steps} step${r.steps === 1 ? '' : 's'} · <span class="${r.saved || r.usedHelpers || r.lookOnly ? 'muted' : r.ok ? 'good' : 'bad'}">${why}</span></small>`;
      row.addEventListener('click', async () => {
        row.disabled = true;
        const res = await window.operator.playbookFromTask(r.taskId);
        if (!res || !res.ok) {
          row.disabled = false;
          row.querySelector('small').textContent = (res && res.error) || 'Could not save that.';
          return;
        }
        closeSheet();
        await load();
        open(res.playbook.id);
      });
      box.appendChild(row);
    }
  }
  $('pbNew').addEventListener('click', openSheet);
  $('pbNewBig').addEventListener('click', openSheet);

  /* ── watchers: what starts a playbook (or a job) by itself ─────── */

  let watches = [];
  const wtList = $('wtList');
  const wtSheet = $('wtSheet');
  let editing = null;     // the watcher in the sheet, or null for a new one

  function watchLine(w) {
    if (!w.enabled) return { text: w.errors >= 3 ? `Off — failed ${w.errors} times: ${w.lastError || ''}` : 'Off', kind: w.errors >= 3 ? 'ask' : 'off' };
    if (w.lastError) return { text: w.lastError, kind: 'ask' };
    const bits = [w.waiting ? `${w.waiting} waiting` : 'Watching'];
    if (w.fired) bits.push(`ran ${w.fired}×`);
    if (w.lastFired) bits.push(`last ${stamp(w.lastFired)}`);
    return { text: bits.join(' · '), kind: w.waiting ? 'busy' : 'on' };
  }

  const EYE = '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>';

  function watchRow(w) {
    const row = document.createElement('div');
    row.className = 'staff-row wt-row';
    row.tabIndex = 0;
    const s = watchLine(w);
    row.innerHTML = `<span class="pb-row-ic wt-ic${w.enabled ? '' : ' off'}" aria-hidden="true">${EYE}</span>` +
      `<span class="staff-row-text"><b>${esc(w.name)}</b><small class="st-${s.kind}">${esc(s.text)}</small></span>` +
      `<label class="switch wt-switch" title="${w.enabled ? 'Watching — click to switch off' : 'Off — click to switch on'}"><input type="checkbox"${w.enabled ? ' checked' : ''} /><span class="knob"></span></label>`;
    const sw = row.querySelector('input');
    sw.addEventListener('click', (e) => e.stopPropagation());
    sw.addEventListener('change', async () => { await window.operator.watcherUpdate(w.id, { enabled: sw.checked }); loadWatches(); });
    row.querySelector('.wt-switch').addEventListener('click', (e) => e.stopPropagation());
    row.addEventListener('click', () => openWatch(w));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openWatch(w); });
    return row;
  }

  async function loadWatches() {
    try { watches = await window.operator.watchers(); } catch { watches = []; }
    wtList.textContent = '';
    if (!watches.length) {
      const p = document.createElement('p');
      p.className = 'staff-none';
      p.textContent = 'None yet — run a playbook when a file lands in a folder or an email arrives.';
      wtList.appendChild(p);
    }
    for (const w of watches) wtList.appendChild(watchRow(w));
    paintPlaybookWatches();
  }

  // On a playbook's own page: the watchers that start it.
  function paintPlaybookWatches() {
    const box = $('pbWatches');
    if (!box || !current) return;
    box.textContent = '';
    const mine = watches.filter((w) => w.action && w.action.kind === 'playbook' && w.action.playbookId === current.id);
    if (!mine.length) {
      const p = document.createElement('p');
      p.className = 'pb-none';
      p.textContent = 'Only when you press Run.';
      box.appendChild(p);
    }
    for (const w of mine) box.appendChild(watchRow(w));
  }

  function showKind() {
    const email = $('wtKind').value === 'email';
    $('wtFolderBox').hidden = email;
    $('wtEmailBox').hidden = !email;
    const task = $('wtDo').value === 'task';
    $('wtPbRow').hidden = task;
    $('wtTaskRow').hidden = !task;
  }
  $('wtKind').addEventListener('change', showKind);
  $('wtDo').addEventListener('change', showKind);

  async function fillChoices(w) {
    const pbSel = $('wtPlaybook');
    pbSel.textContent = '';
    let all = [];
    try { all = await window.operator.playbooks(); } catch { all = []; }
    if (!all.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No playbooks yet — save a run first';
      pbSel.appendChild(o);
    }
    for (const b of all) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name;
      pbSel.appendChild(o);
    }
    const botSel = $('wtBot');
    botSel.textContent = '';
    let bots = [];
    try { bots = (await window.operator.listBots()).filter((b) => !b.employee); } catch { bots = []; }
    for (const b of bots) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name + (b.title ? ` — ${b.title}` : '');
      botSel.appendChild(o);
    }
    if (w && w.action) {
      if (w.action.playbookId) pbSel.value = w.action.playbookId;
      if (w.action.botId) botSel.value = w.action.botId;
    }
  }

  async function openWatch(w, preset) {
    editing = w || null;
    $('wtTitle').textContent = w ? 'Watcher' : 'New watcher';
    $('wtError').textContent = '';
    $('wtKind').value = w ? w.kind : 'folder';
    $('wtPath').value = w ? w.folder.path : '';
    $('wtPattern').value = w ? w.folder.pattern : '*.pdf';
    $('wtFrom').value = w ? w.email.from : '';
    $('wtSubject').value = w ? w.email.subject : '';
    $('wtDo').value = w ? w.action.kind : 'playbook';
    $('wtPrompt').value = w && w.action.kind === 'task' ? w.action.prompt : '';
    $('wtPerHour').value = w ? w.perHour : 12;
    $('wtCooldown').value = w ? w.cooldown : 30;
    $('wtName').value = w ? w.name : '';
    $('wtSave').textContent = w ? 'Save' : 'Start watching';
    $('wtDelete').hidden = !w;
    $('wtTest').hidden = !w;
    const st = $('wtStatus');
    if (w) {
      const s = watchLine(w);
      const last = w.lastResult ? ` Last run ${stamp(w.lastResult.at)}${w.lastResult.what ? ` on “${esc(w.lastResult.what)}”` : ''} — ${w.lastResult.ok ? '<i class="good">worked</i>' : '<i class="bad">' + esc(w.lastResult.error || 'stopped') + '</i>'}.` : '';
      st.innerHTML = `<b class="st-${s.kind}">${esc(s.text)}</b>${last}`;
      st.hidden = false;
    } else st.hidden = true;
    await fillChoices(w || (preset ? { action: preset } : null));
    showKind();
    wtSheet.hidden = false;
    $(w ? 'wtSave' : 'wtKind').focus();
  }

  function closeWatch() { wtSheet.hidden = true; editing = null; }
  $('wtClose').addEventListener('click', closeWatch);
  $('wtScrim').addEventListener('click', closeWatch);
  wtSheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWatch(); });
  $('wtNew').addEventListener('click', () => openWatch(null));
  $('pbAddWatch').addEventListener('click', () => openWatch(null, current ? { kind: 'playbook', playbookId: current.id } : null));

  $('wtBrowse').addEventListener('click', async () => {
    const r = await window.operator.fsPickFolder();
    if (r && r.ok) $('wtPath').value = r.path;
  });

  $('wtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const task = $('wtDo').value === 'task';
    const spec = {
      kind: $('wtKind').value,
      folder: { path: $('wtPath').value.trim(), pattern: $('wtPattern').value.trim() || '*' },
      email: { from: $('wtFrom').value.trim(), subject: $('wtSubject').value.trim() },
      action: task ? { kind: 'task', botId: $('wtBot').value || null, prompt: $('wtPrompt').value } : { kind: 'playbook', playbookId: $('wtPlaybook').value },
      perHour: Number($('wtPerHour').value),
      cooldown: Number($('wtCooldown').value),
      name: $('wtName').value.trim(),
    };
    const r = editing ? await window.operator.watcherUpdate(editing.id, spec) : await window.operator.watcherCreate(spec);
    if (!r || !r.ok) { $('wtError').textContent = (r && r.error) || 'Could not save that.'; return; }
    closeWatch();
    loadWatches();
  });

  $('wtTest').addEventListener('click', async () => {
    if (!editing) return;
    const r = await window.operator.watcherTest(editing.id);
    if (!r || !r.ok) { $('wtError').textContent = (r && r.error) || 'Could not run it.'; return; }
    closeWatch();
  });

  $('wtDelete').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Click again to delete';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 3000);
      return;
    }
    if (editing) await window.operator.watcherDelete(editing.id);
    closeWatch();
    loadWatches();
  });

  window.operator.onWatchersChanged(() => { if (shown) loadWatches(); });

  window.__playbooks = {
    shown(on) {
      shown = Boolean(on);
      if (shown) { badge.hidden = true; load(); loadWatches(); }
    },
    open: (id) => open(id),
  };
})();
