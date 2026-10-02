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
  const KIND_TIP = {
    web: "Done in Operator's own browser",
    screen: 'Done on the screen, with the mouse and keyboard',
    shell: 'A Windows command (PowerShell): moving files, reading folders, changing settings',
    mail: 'Done with the email account connected in Settings → Connectors',
    you: 'Something only you can do. Operator stops and waits for you, then carries on',
    wait: 'Waits for something to finish before the next step',
  };

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
   * Four stages beside a small playbook that acts them out: the first time
   * the AI works every step out (slow, and paid for); the run is saved; the
   * next time it replays with no AI (seconds); and when a button has moved,
   * only that step goes back to the AI, and the fix is kept. Each stage can be
   * clicked. With motion off it holds still on whichever stage is chosen. */

  const HOW_STAGES = [
    { key: 'learn', head: 'Do the job once', body: 'Give an agent a job. The AI works out every click and every word, the way a person would — that first time takes a while, and uses the AI.' },
    { key: 'save', head: 'Save it as a playbook', body: 'When the job worked, its steps are kept: what it opened, clicked and typed, and where each one should end up. Never your passwords.' },
    { key: 'replay', head: 'Run it again — no AI', body: 'Next time the same steps replay straight through. Nothing to pay, done in seconds, the same way every time. Press Run, or let a watcher start it when a file or an email arrives.' },
    { key: 'repair', head: 'It fixes itself', body: 'If a screen has changed — a button renamed — only that one step goes back to the AI. Its fix is kept, so the run after that is free again.' },
  ];

  const DEMO_STEPS = ['Open the supplier portal', 'Click “Invoices”', 'Click “Download all”', 'Move the PDFs into Invoices\\September'];
  const DEMO_FIXED = 'Click “Download PDFs”';

  const still = () => document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;

  function howItWorks(box, { onClose } = {}) {
    box.innerHTML =
      '<div class="pb-how-stages" role="tablist" aria-label="How a playbook works">' +
        HOW_STAGES.map((s, i) => `<button class="pb-how-stage" type="button" role="tab" data-i="${i}">` +
          `<span class="pb-how-n">${i + 1}</span><span class="pb-how-words"><b>${s.head}</b><span>${s.body}</span></span></button>`).join('') +
      '</div>' +
      '<div class="pb-demo" aria-hidden="true">' +
        '<div class="pb-demo-top"><b>Download last month\'s invoices</b><span class="pb-demo-badge"></span></div>' +
        '<ol class="pb-demo-steps">' + DEMO_STEPS.map((t) => `<li><span class="pb-demo-dot"></span><span class="pb-demo-text">${t}</span><span class="pb-demo-note"></span></li>`).join('') + '</ol>' +
        '<div class="pb-demo-foot"><span class="pb-demo-saved">Saved as a playbook</span><span class="pb-demo-clock"></span></div>' +
      '</div>' +
      (onClose ? '<button class="pb-how-close" type="button" aria-label="Hide how it works">×</button>' : '') +
      '<p class="pb-how-caption" aria-live="polite"></p>';

    const stages = [...box.querySelectorAll('.pb-how-stage')];
    const demo = box.querySelector('.pb-demo');
    const rows = [...demo.querySelectorAll('li')];
    const badge = demo.querySelector('.pb-demo-badge');
    const clockEl = demo.querySelector('.pb-demo-clock');
    const caption = box.querySelector('.pb-how-caption');
    if (onClose) box.querySelector('.pb-how-close').addEventListener('click', onClose);

    let stage = 0;
    let run = 0;            // bumped to cancel whatever scene is playing
    const wait = (ms, my) => new Promise((r) => setTimeout(r, ms)).then(() => {
      if (my !== run) throw new Error('cancelled');
    });
    // Off screen (another tab, a hidden page): hold, rather than play to nobody.
    const visible = () => !document.hidden && box.offsetParent !== null;

    const setRow = (i, state, note) => {
      rows[i].className = state || '';
      rows[i].querySelector('.pb-demo-note').textContent = note || '';
    };
    const setBadge = (text, cls) => { badge.textContent = text; badge.className = 'pb-demo-badge ' + (cls || ''); };
    const reset = () => {
      rows.forEach((_r, i) => { setRow(i, ''); rows[i].querySelector('.pb-demo-text').textContent = DEMO_STEPS[i]; });
      demo.classList.remove('saved');
      clockEl.textContent = '';
    };

    function show(i) {
      stage = i;
      stages.forEach((s, j) => { s.classList.toggle('on', j === i); s.setAttribute('aria-selected', String(j === i)); });
      demo.dataset.stage = HOW_STAGES[i].key;
      caption.textContent = HOW_STAGES[i].body;
    }

    // Each scene, played. `my` is the run it belongs to.
    const SCENES = [
      async (my) => {           // the AI works it out, one step at a time
        reset(); setBadge('AI working it out', 'ai');
        let secs = 0;
        for (let i = 0; i < rows.length; i++) {
          setRow(i, 'active ai', 'thinking…');
          for (let t = 0; t < 4; t++) { await wait(260, my); secs += 3; clockEl.textContent = `${secs}s so far`; }
          setRow(i, 'done', '');
        }
        clockEl.textContent = `took ${secs}s, with the AI`;
        await wait(1400, my);
      },
      async (my) => {           // kept
        rows.forEach((_r, i) => setRow(i, 'done', ''));
        setBadge('Worked', 'ok');
        await wait(500, my);
        demo.classList.add('saved');
        clockEl.textContent = '';
        await wait(2600, my);
      },
      async (my) => {           // replayed with no AI
        reset(); demo.classList.add('saved'); setBadge('No AI', 'free');
        for (let i = 0; i < rows.length; i++) { setRow(i, 'active', ''); await wait(330, my); setRow(i, 'done', ''); }
        clockEl.textContent = 'took 4s, no AI';
        await wait(2400, my);
      },
      async (my) => {           // one step changed; only it is repaired
        reset(); demo.classList.add('saved'); setBadge('No AI', 'free');
        for (let i = 0; i < 2; i++) { setRow(i, 'active', ''); await wait(330, my); setRow(i, 'done', ''); }
        setRow(2, 'active', ''); await wait(500, my);
        setRow(2, 'broken', 'not there any more'); setBadge('One step changed', 'warn');
        await wait(1300, my);
        setRow(2, 'active ai', 'the AI fixes just this step…'); setBadge('AI: this step only', 'ai');
        await wait(1700, my);
        rows[2].querySelector('.pb-demo-text').textContent = DEMO_FIXED;
        setRow(2, 'done fixed', 'fixed — kept for next time'); setBadge('No AI', 'free');
        await wait(600, my);
        setRow(3, 'active', ''); await wait(330, my); setRow(3, 'done', '');
        clockEl.textContent = 'next run: no AI again';
        await wait(2600, my);
      },
    ];

    // The final picture of a stage, for when nothing moves.
    function settle(i) {
      reset();
      if (i === 0) { rows.forEach((_r, j) => setRow(j, 'done', '')); rows[1].className = 'active ai'; setBadge('AI working it out', 'ai'); clockEl.textContent = 'the first time takes a while'; }
      if (i === 1) { rows.forEach((_r, j) => setRow(j, 'done', '')); demo.classList.add('saved'); setBadge('Worked', 'ok'); }
      if (i === 2) { rows.forEach((_r, j) => setRow(j, 'done', '')); demo.classList.add('saved'); setBadge('No AI', 'free'); clockEl.textContent = 'took 4s, no AI'; }
      if (i === 3) {
        rows.forEach((_r, j) => setRow(j, 'done', '')); demo.classList.add('saved');
        rows[2].querySelector('.pb-demo-text').textContent = DEMO_FIXED;
        setRow(2, 'done fixed', 'fixed by the AI — kept for next time'); setBadge('No AI', 'free');
      }
    }

    async function play(from) {
      const my = ++run;
      let i = from;
      try {
        for (;;) {
          show(i);
          if (still()) { settle(i); return; }
          while (!visible()) await wait(500, my);
          await SCENES[i](my);
          i = (i + 1) % SCENES.length;
        }
      } catch { /* a newer play() took over */ }
    }

    stages.forEach((s, i) => s.addEventListener('click', () => play(i)));
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
    if (live && live.playbookId === b.id) return { text: live.dryRun ? 'Rehearsing now' : 'Running now', kind: 'busy' };
    const s = b.stats || {};
    if (!s.runs) return { text: `${b.steps} steps · not run yet`, kind: 'off' };
    if (s.lastError) return { text: `Stopped last time · ${stamp(s.lastRun)}`, kind: 'ask' };
    return { text: `${b.steps} steps · worked ${stamp(s.lastRun)}`, kind: 'on' };
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
    // The first playbook anyone opens explains itself once; after that it is
    // behind "How it works".
    let seen = true;
    try { seen = Boolean(localStorage.getItem(HOW_SEEN)); } catch { /* fine */ }
    if (!seen) toggleHow(true);
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
      '<b>This playbook only opens web pages — so running it shows you nothing.</b>' +
      `<p>When ${esc(agent.name)} did this job, the useful part was reading those pages and writing down what it found. That was the AI, and a playbook replays the clicks without the AI. For news, prices, or anything that changes, let ${esc(agent.name)} do the job on a schedule instead: it reads everything fresh each time and sends you what it found.</p>` +
      '<div class="pb-lookonly-set">' +
        '<select class="ro-every" aria-label="How often"><option value="day">Every day</option><option value="weekday">Every weekday</option><option value="week">Every Monday</option></select>' +
        '<input class="ro-at" type="time" value="08:00" aria-label="At what time" />' +
        `<button class="pill solid sm" type="button" data-act="routine">Make it a routine for ${esc(agent.name)}</button>` +
      '</div>';
    el.querySelector('[data-act="routine"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const every = el.querySelector('.ro-every').value;
      const at = el.querySelector('.ro-at').value || '08:00';
      btn.disabled = true;
      const r = await window.operator.addRoutine(agent.id, { name: current.name.slice(0, 50), prompt: current.goal || current.name, every, at, kind: 'task' });
      if (!r) { btn.disabled = false; return; }
      const when = { day: 'every day', weekday: 'every weekday', week: 'every Monday' }[every];
      el.innerHTML = `<b>Done — ${esc(agent.name)} will do this ${when} at ${esc(at)}, and send you what it finds.</b>` +
        `<p>You can change or stop it in ${esc(agent.name)}'s settings, under Routines. This playbook is no use for this job any more.</p>` +
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

  // What will happen when it runs, in a few sentences — read off the steps,
  // the watchers that start it, where it runs and what fixes it.
  function paintSummary() {
    const pb = current;
    const el = $('pbSummary');
    if (!pb || !el) return;
    const n = pb.steps.length;
    const starts = watches
      .filter((w) => w.enabled && w.action && w.action.kind === 'playbook' && w.action.playbookId === pb.id)
      .map((w) => (/^when\b/i.test(w.name) ? esc(w.name.replace(/^When/, 'when')) : `when its watcher “${esc(w.name)}” goes off`));
    const fleet = window.__fleet ? window.__fleet.list() : [];
    const machine = fleet.find((m) => m.id === pb.machine);
    const kinds = new Set(pb.steps.map((s) => s.kind));
    const how = [kinds.has('web') && 'in its own browser', kinds.has('screen') && 'on the screen', kinds.has('shell') && 'with Windows commands', kinds.has('mail') && 'with your email']
      .filter(Boolean);
    const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    const nums = (pred) => pb.steps.map((s, i) => (pred(s) ? i + 1 : 0)).filter(Boolean);
    const yours = nums((s) => s.kind === 'you' || /\{\{?\s*secret/i.test(s.text) || s.fields.some((f) => /\{\{\s*secret/i.test(f.value)));
    const asks = nums((s) => s.confirm);
    const fixer = modelName(pb.model);

    const lines = [];
    lines.push(`<b>When you press Run</b>${starts.length ? `, or ${starts.join(', or ')},` : ','} Operator does these ${n} step${n === 1 ? '' : 's'} by itself, in order` +
      `${machine ? ` on <b>${esc(machine.name)}</b>` : ''}${how.length ? ` — ${list(how)}` : ''}.`);
    lines.push(`<b>No AI is used.</b> Only if a step stops working because a screen has changed does ${esc(fixer)} work out that one step again, and its fix is kept.`);
    const stops = [];
    if (yours.length) stops.push(`for you at step ${list(yours.map(String))}`);
    if (asks.length) stops.push(`to ask before step${asks.length === 1 ? '' : 's'} ${list(asks.map(String))}`);
    if (stops.length) lines.push(`<b>It stops</b> ${stops.join(', and ')}.`);
    if (pb.inputs.length) {
      lines.push(`<b>Changes each run:</b> ${pb.inputs.map((x) => `<span class="pb-var">${esc(x.name.replace(/_/g, ' '))}${x.value ? `: <i>${esc(x.value)}</i>` : ''}</span>`).join(' ')}`);
    }
    el.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
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
    const from = pb.source && pb.source.at ? ` · saved from ${pb.source.botName ? esc(pb.source.botName) + "'s" : 'a'} run on ${new Date(pb.source.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
    $('pbSub').innerHTML = esc(trim(pb.goal || '', 110)) + from;
    paintState();
    paintLookOnly();
    paintSummary();
    paintStats();
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
      st.textContent = live.dryRun ? `Rehearsing · ${where} · nothing is being changed`
        : fixing ? `${where} · the AI is fixing this step` : `${where} · no AI`;
      st.className = 'staff-state ' + (fixing ? 'st-ask' : 'st-busy');
    }
    else if (busyElsewhere) { st.textContent = 'Another playbook is running'; st.className = 'staff-state st-off'; }
    else { st.textContent = ''; st.className = 'staff-state'; }
  }

  function paintStats() {
    const s = (current && current.stats) || {};
    const el = $('pbStats');
    // One card per number, so they line up rather than wrap as a sentence.
    const card = (value, label, cls) => `<div class="pb-stat${cls ? ' ' + cls : ''}"><b>${value}</b><span>${label}</span></div>`;
    const head = '<div class="pb-stats-top"><span class="pb-free">Runs with no AI</span>' +
      (s.runs ? '' : '<span class="pb-stats-note">Not run yet. <b>Rehearse</b> goes through it without changing anything.</span>') + '</div>';
    if (!s.runs) { el.innerHTML = head; paintResult(); return; }
    const cards = [
      card(s.runs, s.runs === 1 ? 'run' : 'runs'),
      card(`${s.ok || 0}<small>/${s.runs}</small>`, 'worked', s.ok === s.runs ? 'good' : ''),
      s.ok ? card(secs((s.totalMs || 0) / s.ok), 'usually takes') : '',
      s.heals ? card(s.heals, s.heals === 1 ? 'step repaired' : 'steps repaired', 'warn') : '',
      // Today a time, before today just the day — a card is not wide enough for both.
      card(dayOf(s.lastRun) === dayOf(Date.now()) ? clock(s.lastRun) : new Date(s.lastRun).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        'last run', s.lastError ? 'stopped' : 'ok'),
    ];
    el.innerHTML = head + '<div class="pb-stat-grid">' + cards.join('') + '</div>';
    paintResult();
  }

  function paintResult() {
    const el = $('pbResult');
    const r = current && lastResult[current.id];
    if (!r || (live && live.playbookId === current.id)) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'pb-result ' + (r.ok ? 'good' : r.stopped ? 'off' : 'bad');
    if (r.ok) {
      el.innerHTML = r.dryRun
        ? `<b>Rehearsed — nothing was changed.</b> All ${r.steps} steps went through. Run it for real when you are ready.`
        : `<b>Done in ${secs(r.ms)}.</b> ${r.healed ? `${r.healed} step${r.healed === 1 ? ' had' : 's had'} changed and ${r.healed === 1 ? 'was' : 'were'} repaired by the AI — the repair is saved, so next time is free again.` : 'No AI was used.'}${r.skipped ? ` ${r.skipped} step${r.skipped === 1 ? ' was' : 's were'} left out.` : ''}`;
    } else {
      el.innerHTML = `<b>${r.stopped ? 'Stopped.' : 'It stopped.'}</b> ${esc(r.error || '')}`;
    }
  }

  function stepState(i) {
    if (!live || !current || live.playbookId !== current.id) return { state: '', note: '' };
    return { state: live.states[i] || '', note: live.notes[i] || '' };
  }

  function paintSteps() {
    const steps = (live && current && live.playbookId === current.id && live.steps) || current.steps;
    $('pbStepsNote').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}, done in this order every time · point at a label to see what it means`;
    stepsEl.textContent = '';
    steps.forEach((s, i) => stepsEl.appendChild(stepRow(s, i)));
  }

  // A step's words as a sentence: a capital to start, and a shell command
  // said for what it is, with the command itself shown as code.
  function stepWords(s) {
    const text = String(s.text || '');
    const cmd = s.kind === 'shell' && text.match(/^run:\s*([\s\S]*)$/i);
    if (cmd) return `Runs a Windows command: <code class="pb-cmd">${withTags(cmd[1], current)}</code>`;
    return withTags(text.charAt(0).toUpperCase() + text.slice(1), current);
  }

  function stepRow(s, i) {
    const li = document.createElement('li');
    const { state, note } = stepState(i);
    li.className = `pb-step k-${s.kind}${state ? ' s-' + state : ''}`;
    li.dataset.id = s.id;
    const tags = [];
    if (s.check) {
      const said = s.kind === 'web' ? `checks it is on ${esc(s.check)}` : `checks ${esc(s.check)} is in front`;
      tags.push(`<span class="pb-then" title="After this step Operator checks this, without the AI. If it is not so, it waits, tries once more, and only then asks the AI to fix this one step.">✓ ${said}</span>`);
    }
    if (s.brittle) tags.push('<span class="pb-tag warn" title="It clicks a spot on the screen, not a button by its name — if the window moves or changes, this is the step most likely to need the AI to fix it">clicks a spot on screen</span>');
    if (s.healed) tags.push('<span class="pb-tag fixed" title="A screen had changed, so the AI worked this step out again. The fix is saved — it runs with no AI now">fixed by the AI</span>');
    if (note) tags.push(`<span class="pb-note">${esc(note)}</span>`);
    const lock = live && current && live.playbookId === current.id;
    li.innerHTML =
      `<span class="pb-n">${i + 1}</span>` +
      '<div class="pb-step-main">' +
        `<div class="pb-step-text">${stepWords(s)}</div>` +
        // What kind of step and how it went on the left, what you can do to it
        // on the right — under the words, so they keep the whole width.
        '<div class="pb-step-foot">' +
          `<div class="pb-step-meta"><span class="pb-kind" title="${esc(KIND_TIP[s.kind] || '')}">${KIND[s.kind] || 'Step'}</span>${tags.join('')}</div>` +
          '<div class="pb-step-acts">' +
            `<label class="pb-ask" title="Stop and ask you before doing this step — on for anything that sends, pays, posts or deletes"><input type="checkbox"${s.confirm ? ' checked' : ''}${lock ? ' disabled' : ''} /> Ask me first</label>` +
            (s.fields.length ? `<button class="mini" type="button" data-act="edit"${lock ? ' disabled' : ''}>Edit</button>` : '') +
            `<button class="mini" type="button" data-act="remove"${lock ? ' disabled' : ''}>Remove</button>` +
          '</div>' +
        '</div>' +
        '<div class="pb-fields" hidden></div>' +
      '</div>';

    li.querySelector('.pb-ask input').addEventListener('change', (e) => change({ step: { id: s.id, confirm: e.target.checked } }));
    const edit = li.querySelector('[data-act="edit"]');
    if (edit) edit.addEventListener('click', () => toggleFields(li, s));
    li.querySelector('[data-act="remove"]').addEventListener('click', (e) => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Sure?';
        setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove'; }, 2500);
        return;
      }
      change({ step: { id: s.id, remove: true } });
    });
    return li;
  }

  // The values a step types, sends or opens — editable, so a one-off value can
  // become {{an_input}}.
  function toggleFields(li, s) {
    const box = li.querySelector('.pb-fields');
    if (!box.hidden) { box.hidden = true; return; }
    box.textContent = '';
    for (const f of s.fields) {
      const row = document.createElement('label');
      row.className = 'pb-field';
      const name = f.path.split('.').filter((p) => !/^\d+$/.test(p)).pop() || f.path;
      row.innerHTML = `<span>${esc(name)}</span>`;
      const input = document.createElement(f.value.length > 60 ? 'textarea' : 'input');
      if (input.tagName === 'INPUT') input.type = 'text';
      input.value = f.value;
      input.spellcheck = false;
      input.addEventListener('change', () => change({ step: { id: s.id, path: f.path, value: input.value } }));
      row.appendChild(input);
      box.appendChild(row);
    }
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
    if (!current.inputs.length) {
      const p = document.createElement('p');
      p.className = 'pb-none';
      p.textContent = 'Nothing — it types the same things every time.';
      box.appendChild(p);
    }
    for (const inp of current.inputs) {
      const row = document.createElement('label');
      row.className = 'field pb-input';
      row.innerHTML = `<span>${esc(inp.name.replace(/_/g, ' '))} <code>{{${esc(inp.name)}}}</code></span>`;
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
    auto.textContent = defaultModel ? `Operator's default — ${modelName(null)}` : "Operator's default";
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
    paintSummary();   // it names the model, which was not known until now
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
    const note = $('pbMachineNote');
    const m = window.__fleet.list().find((x) => x.id === current.machine);
    note.textContent = !window.__fleet.list().length ? 'Add spare PCs in Settings → Computer, and this one can run there instead.'
      : m && current.usesBrowser ? "Its web steps use Operator's own browser, which is only on this computer — they will stop there."
      : m ? `Runs on ${m.name}${m.online === false ? ', which is not answering right now' : ''}, so this computer stays free.`
      : 'Settings → Computer decides.';
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
        if (live) live.notes[evt.i] = 'the AI is working this step out again…';
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
        : r.lookOnly ? 'only looked things up — the AI did the reading, so make it a routine instead'
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
    paintSummary();   // "or when a PDF lands in Downloads"
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
