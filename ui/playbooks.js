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
  const KIND = { web: 'Web', screen: 'Screen', shell: 'Shell', mail: 'Email', you: 'You', wait: 'Wait' };

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
  }

  function paint() {
    const pb = current;
    if (!pb) return;
    $('pbName').textContent = pb.name;
    const from = pb.source && pb.source.at ? ` · saved from ${pb.source.botName ? esc(pb.source.botName) + "'s" : 'a'} run on ${new Date(pb.source.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
    $('pbSub').innerHTML = esc(trim(pb.goal || '', 110)) + from;
    paintState();
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
    if (running) { st.textContent = live.dryRun ? 'Rehearsing — nothing is being changed' : 'Running'; st.className = 'staff-state st-busy'; }
    else if (busyElsewhere) { st.textContent = 'Another playbook is running'; st.className = 'staff-state st-off'; }
    else { st.textContent = ''; st.className = 'staff-state'; }
  }

  function paintStats() {
    const s = (current && current.stats) || {};
    const el = $('pbStats');
    const bits = ['<span class="pb-free">Runs with no AI</span>'];
    if (!s.runs) {
      bits.push('<span>Not run yet. <b>Rehearse</b> goes through it without changing anything.</span>');
    } else {
      bits.push(`<span>Ran <b>${s.runs}</b> time${s.runs === 1 ? '' : 's'} · <b>${s.ok || 0}</b> worked</span>`);
      if (s.ok) bits.push(`<span>Usually takes <b>${secs((s.totalMs || 0) / s.ok)}</b></span>`);
      if (s.heals) bits.push(`<span><b>${s.heals}</b> step${s.heals === 1 ? '' : 's'} repaired along the way</span>`);
      bits.push(`<span>Last run ${stamp(s.lastRun)} — ${s.lastError ? '<i class="bad">stopped</i>' : '<i class="good">worked</i>'}</span>`);
    }
    el.innerHTML = bits.join('');
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
    $('pbStepsNote').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}` +
      (steps.some((s) => s.brittle) ? ' · some click a place on the screen rather than a named button' : '');
    stepsEl.textContent = '';
    steps.forEach((s, i) => stepsEl.appendChild(stepRow(s, i)));
  }

  function stepRow(s, i) {
    const li = document.createElement('li');
    const { state, note } = stepState(i);
    li.className = `pb-step k-${s.kind}${state ? ' s-' + state : ''}`;
    li.dataset.id = s.id;
    const tags = [];
    if (s.check) tags.push(`<span class="pb-then">then: ${esc(s.check)}</span>`);
    if (s.brittle) tags.push('<span class="pb-tag warn" title="It clicks a position, not a named button — if the window moves or changes, this is the step that will need repairing">clicks a position</span>');
    if (s.healed) tags.push('<span class="pb-tag" title="This step was worked out again by the AI when the screen changed">repaired</span>');
    if (note) tags.push(`<span class="pb-note">${esc(note)}</span>`);
    const lock = live && current && live.playbookId === current.id;
    li.innerHTML =
      `<span class="pb-n">${i + 1}</span>` +
      '<span class="pb-dot" aria-hidden="true"></span>' +
      '<div class="pb-step-main">' +
        `<div class="pb-step-text">${esc(s.text)}</div>` +
        `<div class="pb-step-meta"><span class="pb-kind">${KIND[s.kind] || 'Step'}</span>${tags.join('')}</div>` +
        '<div class="pb-fields" hidden></div>' +
      '</div>' +
      '<div class="pb-step-acts">' +
        `<label class="pb-ask" title="Stop and ask before doing this step"><input type="checkbox"${s.confirm ? ' checked' : ''}${lock ? ' disabled' : ''} /> Ask first</label>` +
        (s.fields.length ? `<button class="mini" type="button" data-act="edit"${lock ? ' disabled' : ''}>Edit</button>` : '') +
        `<button class="mini" type="button" data-act="remove"${lock ? ' disabled' : ''}>Remove</button>` +
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
      p.textContent = 'None — it types the same thing every time.';
      box.appendChild(p);
    }
    for (const inp of current.inputs) {
      const row = document.createElement('label');
      row.className = 'field pb-input';
      row.innerHTML = `<span><code>{{${esc(inp.name)}}}</code></span>`;
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
      try { models = ((await window.operator.listModels()) || {}).models || []; } catch { models = []; }
    }
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = "Operator's default";
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
    window.__fleet.fillSelect(sel, current.machine, 'Wherever Operator is pointed');
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
      row.disabled = r.saved || r.usedHelpers;
      const why = r.saved ? 'already saved' : r.usedHelpers ? 'used helpers — cannot be replayed' : r.ok ? 'worked' : 'did not finish';
      row.innerHTML = `<b>${esc(trim(r.prompt || '(no words)', 90))}</b>` +
        `<small>${r.botName ? esc(r.botName) + ' · ' : ''}${stamp(r.at)} · ${r.steps} step${r.steps === 1 ? '' : 's'} · <span class="${r.ok ? 'good' : 'bad'}">${why}</span></small>`;
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
