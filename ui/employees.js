/* ── the Employees tab ─────────────────────────────────────────────────
 * Agents with a job that work on a loop and message you first. The loop
 * itself is employees.js in the main process; this is the desk you watch it
 * from: who you have hired, what each one is doing, its conversation with you,
 * its to-do list and its work log.
 *
 * Loaded after renderer.js, and borrows its helpers (esc, trim, Avatar,
 * Markdown) rather than keeping copies.
 */

(() => {
  const view = document.getElementById('staffView');
  if (!view) return;

  const $ = (id) => document.getElementById(id);
  const listEl = $('staffList');
  const emptyEl = $('staffEmpty');
  const desk = $('staffDesk');
  const threadEl = $('sdThread');
  const input = $('sdInput');
  const badge = $('staffBadge');
  const modeBtn = document.querySelector('.mode[data-mode="employees"]');

  const LAST = 'operator.employee';
  let people = [];
  let current = null;     // the employee on the desk, with its turns
  let shown = false;      // the tab is the one on screen

  // In the Agent Verse (agentverse.js) the desk is a computer screen you open
  // by clicking it, so it only counts as read while that screen is up.
  const looking = () => shown && (!view.classList.contains('verse-on') || view.classList.contains('screen-open'));

  const recall = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
  const keep = (id) => { try { localStorage.setItem(LAST, id); } catch { /* fine */ } };
  const md = (t) => (window.Markdown ? window.Markdown.render(t) : nl2br(t));
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const stamp = (ms) => (dayOf(ms) === dayOf(Date.now()) ? clock(ms)
    : new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));
  const EVERY = { 15: 'Every 15 minutes', 30: 'Every 30 minutes', 60: 'Every hour', 120: 'Every 2 hours', 240: 'Every 4 hours' };

  // The same test the loop uses (employees.js), so the desk never promises a
  // check-in the loop will not make.
  function inHours(e, now) {
    if (!e.hours) return true;
    const d = new Date(now);
    if (e.hours.days === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    const at = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const from = at(e.hours.from);
    const to = at(e.hours.to);
    return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
  }
  const usedToday = (e) => (e.today && e.today.day === dayOf(Date.now()) ? e.today.count : 0);

  // One line: what it is doing, or when it next will.
  function status(e) {
    if (e.working) return { text: 'Working now', kind: 'busy' };
    if (e.pending) return { text: 'Will answer as soon as the computer is free', kind: 'busy' };
    const waiting = e.waiting ? ' · waiting on you' : '';
    if (!e.onShift) return { text: 'Off shift' + waiting, kind: e.waiting ? 'ask' : 'off' };
    if (usedToday(e) >= e.cap) return { text: `Done for today (${e.cap} check-ins)` + waiting, kind: 'off' };
    if (!inHours(e, Date.now())) return { text: `Off hours — back at ${e.hours.from}` + waiting, kind: 'off' };
    const next = e.nextAt ? (e.nextAt <= Date.now() + 30 * 1000 ? 'any moment' : clock(e.nextAt)) : 'soon';
    return { text: `On shift · next check-in ${next}` + waiting, kind: e.waiting ? 'ask' : 'on' };
  }

  /* ── the list ──────────────────────────────────────────────────── */

  async function load() {
    try { people = await window.operator.employees(); } catch { people = []; }
    paintBadge();
    if (!shown) return;
    paintList();
    const want = (current && people.find((p) => p.id === current.id)) || people.find((p) => p.id === recall()) || people[0];
    if (want) await open(want.id); else showEmpty();
  }

  function paintBadge() {
    const n = people.reduce((s, p) => s + (p.unread || 0), 0);
    badge.hidden = !n;
    badge.textContent = n > 9 ? '9+' : String(n);
    // The Agent Verse draws from the same list.
    view.dispatchEvent(new CustomEvent('staff:people', { detail: people }));
  }

  function paintList() {
    listEl.textContent = '';
    if (!people.length) {
      const p = document.createElement('p');
      p.className = 'staff-none';
      p.textContent = 'Nobody hired yet.';
      listEl.appendChild(p);
      return;
    }
    for (const e of people) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'staff-row' + (current && current.id === e.id ? ' on' : '');
      row.appendChild(Avatar.el(e.face, 30, e.working ? 'working' : e.waiting ? 'waiting' : 'idle'));
      const s = status(e);
      const text = document.createElement('span');
      text.className = 'staff-row-text';
      text.innerHTML = '<b>' + esc(e.name) + '</b><small class="st-' + s.kind + '">' + esc(s.text) + '</small>';
      row.appendChild(text);
      if (e.unread) {
        const dot = document.createElement('span');
        dot.className = 'staff-unread';
        dot.textContent = e.unread > 9 ? '9+' : String(e.unread);
        row.appendChild(dot);
      }
      row.addEventListener('click', () => open(e.id));
      listEl.appendChild(row);
    }
  }

  function showEmpty() {
    current = null;
    emptyEl.hidden = false;
    desk.hidden = true;
  }

  /* ── the desk ──────────────────────────────────────────────────── */

  async function open(id) {
    const e = await window.operator.employee(id);
    if (!e) { current = null; return load(); }
    const first = !current || current.id !== id;
    current = e;
    keep(id);
    emptyEl.hidden = true;
    desk.hidden = false;
    paintDesk(first);
    paintList();
    // Reading it is what clears the count.
    if (looking() && e.unread) {
      await window.operator.employeeRead(id);
      const p = people.find((x) => x.id === id);
      if (p) p.unread = 0;
      paintBadge();
      paintList();
    }
  }

  function paintDesk(scrollDown) {
    const e = current;
    const face = $('sdFace');
    face.textContent = '';
    face.appendChild(Avatar.el(e.face, 38, e.working ? 'working' : e.waiting ? 'waiting' : 'idle'));
    $('sdName').textContent = e.name;
    $('sdRole').textContent = e.role || 'Employee';
    const s = status(e);
    const st = $('sdState');
    st.textContent = s.text;
    st.className = 'staff-state st-' + s.kind;
    $('sdShift').textContent = e.onShift ? 'Pause shift' : 'Start shift';
    $('sdShift').classList.toggle('on', e.onShift);
    $('sdCheck').disabled = Boolean(e.working);
    input.placeholder = 'Message ' + e.name;

    paintThread(scrollDown);
    paintTasks();
    paintShift();
    paintLog();
  }

  // A tool call, in a few words.
  function step(it) {
    const a = it.input || {};
    const name = String(it.name || '').replace(/^mcp__computer__/, '');
    const what = a.url || a.text || a.command || a.target || a.what || a.query || a.name || '';
    return name.replace(/_/g, ' ') + (what ? ' — ' + trim(String(what), 70) : '');
  }

  function stepsBlock(items, summary) {
    const d = document.createElement('details');
    d.className = 'sd-steps';
    const sum = document.createElement('summary');
    sum.textContent = summary;
    d.appendChild(sum);
    const ol = document.createElement('ol');
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = step(it);
      ol.appendChild(li);
    }
    d.appendChild(ol);
    return d;
  }

  function paintThread(scrollDown) {
    const e = current;
    const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
    threadEl.textContent = '';
    const turns = e.turns || [];

    if (!turns.length) {
      const p = document.createElement('div');
      p.className = 'sd-hello';
      p.innerHTML = '<b>' + esc(e.name) + ' is ready.</b> ' +
        (e.onShift ? 'Its first check-in is about a minute away. ' : 'Start its shift and it gets going by itself. ') +
        'You can also just tell it what to do.';
      threadEl.appendChild(p);
    }

    for (const t of turns) {
      if (t.k === 'you') {
        const b = document.createElement('div');
        b.className = 'sd-msg you';
        b.innerHTML = '<div class="sd-bubble">' + nl2br(t.text) + '</div><time>' + (t.at ? stamp(t.at) : '') + '</time>';
        threadEl.appendChild(b);
      } else if (t.k === 'says') {
        const b = document.createElement('div');
        b.className = 'sd-msg them' + (t.proactive ? ' first' : '') + (t.needsReply ? ' ask' : '');
        const tag = t.needsReply ? '<span class="sd-tag ask">Needs your answer</span>' : t.proactive ? '<span class="sd-tag">Messaged you</span>' : '';
        b.innerHTML = '<div class="sd-bubble">' + md(t.text) + '</div><time>' + tag + (t.at ? stamp(t.at) : '') + '</time>';
        threadEl.appendChild(b);
      } else if (t.k === 'shift') {
        const row = document.createElement('div');
        row.className = 'sd-shift' + (t.interrupted ? ' cut' : '');
        const head = document.createElement('div');
        head.className = 'sd-shift-head';
        head.innerHTML = '<span class="sd-dot"></span><b>Checked in</b> <time>' + (t.at ? stamp(t.at) : '') + '</time>' +
          (t.interrupted ? ' <i>— stepped aside for a task of yours</i>' : '');
        row.appendChild(head);
        if (t.text) {
          const p = document.createElement('div');
          p.className = 'sd-shift-text';
          p.innerHTML = md(t.text);
          row.appendChild(p);
        }
        if (t.items && t.items.length) row.appendChild(stepsBlock(t.items, t.items.length + (t.items.length === 1 ? ' step' : ' steps')));
        threadEl.appendChild(row);
      } else if (t.k === 'work' && t.items && t.items.length) {
        const row = document.createElement('div');
        row.className = 'sd-work';
        row.appendChild(stepsBlock(t.items, 'Worked on it — ' + t.items.length + (t.items.length === 1 ? ' step' : ' steps')));
        threadEl.appendChild(row);
      } else if (t.k === 'error') {
        const row = document.createElement('div');
        row.className = 'sd-error';
        row.textContent = t.text;
        threadEl.appendChild(row);
      }
    }

    if (e.working || e.pending) {
      const w = document.createElement('div');
      w.className = 'sd-working';
      w.innerHTML = '<span class="hv-wait"><i></i><i></i><i></i></span> ' +
        esc(e.working ? e.name + ' is working' : 'Your message is queued — ' + e.name + ' answers as soon as the computer is free');
      threadEl.appendChild(w);
    }

    if (scrollDown || nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
  }

  function paintTasks() {
    const ul = $('sdTasks');
    ul.textContent = '';
    const tasks = current.tasks || [];
    const open = tasks.filter((t) => !t.done);
    const done = tasks.filter((t) => t.done).slice(-5).reverse();
    if (!open.length) {
      const li = document.createElement('li');
      li.className = 'sp-none';
      li.textContent = 'Nothing on the list.';
      ul.appendChild(li);
    }
    for (const t of [...open, ...done]) {
      const li = document.createElement('li');
      li.className = 'sp-task' + (t.done ? ' done' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = t.done;
      box.addEventListener('change', async () => {
        await window.operator.employeeTaskUpdate(current.id, t.id, { done: box.checked });
        refresh();
      });
      const text = document.createElement('span');
      text.className = 'sp-task-text';
      text.innerHTML = esc(t.text) + (t.by === 'them' ? ' <em>added by ' + esc(current.name) + '</em>' : '') +
        (t.note ? '<small>' + esc(t.note) + '</small>' : '');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sp-del';
      del.title = 'Remove';
      del.setAttribute('aria-label', 'Remove ' + t.text);
      del.textContent = '×';
      del.addEventListener('click', async () => { await window.operator.employeeTaskRemove(current.id, t.id); refresh(); });
      li.append(box, text, del);
      ul.appendChild(li);
    }
  }

  function paintShift() {
    const e = current;
    const hours = e.hours ? `${e.hours.from}–${e.hours.to}, ${e.hours.days === 'weekdays' ? 'weekdays' : 'every day'}` : 'Any time';
    $('sdShiftInfo').innerHTML =
      '<div>' + esc(EVERY[e.every] || `Every ${e.every} minutes`) + '</div>' +
      '<div>' + esc(hours) + '</div>' +
      '<div>' + usedToday(e) + ' of ' + e.cap + ' check-ins used today</div>' +
      (e.lastAt ? '<div>Last check-in ' + esc(stamp(e.lastAt)) + '</div>' : '');
  }

  function paintLog() {
    const ul = $('sdLog');
    ul.textContent = '';
    const log = (current.log || []).slice(-12).reverse();
    if (!log.length) {
      const li = document.createElement('li');
      li.className = 'sp-none';
      li.textContent = 'No work yet.';
      ul.appendChild(li);
    }
    for (const l of log) {
      const li = document.createElement('li');
      li.innerHTML = '<time>' + esc(stamp(l.at)) + '</time> <b>' + (l.kind === 'reply' ? 'Answered you' : 'Check-in') + '</b>' +
        (l.summary ? '<span>' + esc(trim(l.summary, 140)) + '</span>' : '');
      ul.appendChild(li);
    }
  }

  async function refresh() {
    if (!current) return load();
    try { people = await window.operator.employees(); } catch { /* keep what we have */ }
    paintBadge();
    const e = await window.operator.employee(current.id);
    if (!e) { current = null; return load(); }
    current = e;
    // A message that lands while you are looking at it has been read.
    if (looking() && e.unread && document.hasFocus()) {
      await window.operator.employeeRead(e.id);
      e.unread = 0;
      const p = people.find((x) => x.id === e.id);
      if (p) p.unread = 0;
      paintBadge();
    }
    if (shown) { paintDesk(false); paintList(); }
  }

  /* ── talking to it ─────────────────────────────────────────────── */

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('sdCompose').requestSubmit(); }
  });
  $('sdCompose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    grow();
    await window.operator.sayToEmployee(current.id, text);
    await refresh();
    threadEl.scrollTop = threadEl.scrollHeight;
  });

  $('sdTaskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('sdTaskInput');
    const text = box.value.trim();
    if (!text || !current) return;
    box.value = '';
    await window.operator.employeeTaskAdd(current.id, text);
    refresh();
  });

  $('sdShift').addEventListener('click', async () => {
    if (!current) return;
    await window.operator.updateEmployee(current.id, { onShift: !current.onShift });
    refresh();
  });

  $('sdCheck').addEventListener('click', async () => {
    if (!current) return;
    const btn = $('sdCheck');
    const r = await window.operator.employeeCheckIn(current.id);
    if (r && !r.ok) {
      btn.textContent = r.error;
      setTimeout(() => { btn.textContent = 'Check in now'; }, 2600);
    } else if (r && r.queued) {
      btn.textContent = 'Queued';
      setTimeout(() => { btn.textContent = 'Check in now'; }, 2600);
    }
    refresh();
  });

  /* ── hiring, and the job panel ─────────────────────────────────── */

  const sheet = $('staffSheet');
  const PRESETS = [
    { label: 'Inbox helper', name: 'Ivy', role: 'Inbox helper', section: 'Inbox', every: 60, cap: 10,
      job: 'Check my connected email inbox. Tell me about anything important or anything that needs a reply from me, and draft the reply for me to approve — never send one without asking. Keep a short list of what is waiting on me.' },
    { label: 'Lead finder', name: 'Leo', role: 'Lead finder', section: 'Sales', every: 120, cap: 6,
      job: 'Find small businesses in Brisbane that have no website or a poor one. Add each good one to your to-do list with their name, what they do and how to contact them. Aim for three good ones a day, and message me a short summary when you have them.' },
    { label: 'Price watcher', name: 'Penny', role: 'Price watcher', section: 'Watchers', every: 240, cap: 6,
      job: 'Watch the prices of the things on your to-do list (I will add them). Check each one and message me as soon as one drops, with the price and the link. Do not buy anything.' },
    { label: 'News scout', name: 'Nova', role: 'News scout', section: 'Research', every: 240, cap: 2,
      job: 'Keep me up to date on AI agents and desktop automation. Once a day, message me the three most important stories, each with a link and one line on why it matters.' },
  ];
  let editing = null;   // the employee whose job is open, or null when hiring
  let fireArmed = false;
  let face = null;      // the look picked for them

  // A few faces to choose from, from the same parts store.js deals out.
  const SHAPES = ['squircle', 'round', 'dome', 'shield'];
  const EXTRAS = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
  const HUES = [199, 262, 152, 24, 341, 44, 288, 174];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function paintLooks(keepFirst) {
    const box = $('ssLooks');
    box.textContent = '';
    const faces = keepFirst && face ? [face] : [];
    while (faces.length < 8) faces.push({ hue: pick(HUES), shape: pick(SHAPES), accessory: pick(EXTRAS) });
    if (!face) face = faces[0];
    for (const f of faces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-look' + (f === face ? ' on' : '');
      b.appendChild(Avatar.el(f, 30, 'idle'));
      b.addEventListener('click', () => { face = f; box.querySelectorAll('.ss-look').forEach((x) => x.classList.toggle('on', x === b)); });
      box.appendChild(b);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ss-look ss-shuffle';
    more.title = 'More faces';
    more.textContent = '↻';
    more.addEventListener('click', () => { face = null; paintLooks(false); });
    box.appendChild(more);
  }

  function paintPresets() {
    const box = $('ssPresets');
    box.textContent = '';
    if (editing) return;
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-preset';
      b.textContent = p.label;
      b.addEventListener('click', () => {
        $('ssName').value = p.name;
        $('ssRole').value = p.role;
        $('ssSection').value = p.section;
        $('ssJob').value = p.job;
        $('ssEvery').value = String(p.every);
        $('ssCap').value = String(p.cap);
        box.querySelectorAll('.ss-preset').forEach((x) => x.classList.toggle('on', x === b));
      });
      box.appendChild(b);
    }
  }

  const syncHours = () => sheet.querySelectorAll('.ss-when').forEach((el) => { el.hidden = $('ssHours').value !== 'set'; });
  $('ssHours').addEventListener('change', syncHours);

  // `at`: the section of the empty desk it was hired from, in the Agent Verse.
  function openSheet(e, at) {
    editing = e || null;
    fireArmed = false;
    face = e ? e.face : null;
    $('ssTitle').textContent = e ? `${e.name}'s job` : 'Hire an employee';
    $('ssDone').textContent = e ? 'Save' : 'Hire';
    $('ssFire').hidden = !e;
    $('ssFire').textContent = 'Fire';
    $('ssStartRow').hidden = Boolean(e);
    $('ssError').textContent = '';
    $('ssName').value = e ? e.name : '';
    $('ssRole').value = e ? (e.role || '') : '';
    $('ssSection').value = e ? (e.section || '') : (at || '');
    $('ssSections').innerHTML = [...new Set(people.map((p) => p.section).filter(Boolean))].map((s) => '<option value="' + esc(s) + '">').join('');
    $('ssJob').value = e ? e.job : '';
    $('ssEvery').value = String(e ? e.every : 60);
    $('ssCap').value = String(e ? e.cap : 12);
    $('ssHours').value = e && e.hours ? 'set' : 'any';
    $('ssFrom').value = (e && e.hours && e.hours.from) || '09:00';
    $('ssTo').value = (e && e.hours && e.hours.to) || '17:00';
    $('ssDays').value = (e && e.hours && e.hours.days) || 'every';
    $('ssStart').checked = true;
    syncHours();
    paintPresets();
    paintLooks(true);
    sheet.hidden = false;
    setTimeout(() => $(e ? 'ssJob' : 'ssName').focus(), 30);
  }
  const closeSheet = () => { sheet.hidden = true; editing = null; };

  $('staffHire').addEventListener('click', () => openSheet(null));
  $('staffHireBig').addEventListener('click', () => openSheet(null));
  $('sdEdit').addEventListener('click', () => current && openSheet(current));
  $('ssClose').addEventListener('click', closeSheet);
  $('ssScrim').addEventListener('click', closeSheet);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });

  $('ssForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const job = $('ssJob').value.trim();
    if (!job) { $('ssError').textContent = 'Say what their job is — that is what they work from.'; $('ssJob').focus(); return; }
    const spec = {
      name: $('ssName').value.trim() || 'New employee',
      role: $('ssRole').value.trim(),
      section: $('ssSection').value.trim(),
      face,
      job,
      every: Number($('ssEvery').value),
      cap: Number($('ssCap').value) || 12,
      hours: $('ssHours').value === 'set' ? { from: $('ssFrom').value, to: $('ssTo').value, days: $('ssDays').value } : null,
    };
    if (editing) {
      await window.operator.updateEmployee(editing.id, spec);
      closeSheet();
      return refresh();
    }
    const made = await window.operator.hireEmployee({ ...spec, onShift: $('ssStart').checked });
    if (!made) { $('ssError').textContent = 'Could not hire — too many agents already.'; return; }
    closeSheet();
    current = null;
    keep(made.id);
    await load();
  });

  $('ssFire').addEventListener('click', async () => {
    if (!editing) return;
    if (!fireArmed) { fireArmed = true; $('ssFire').textContent = `Fire ${editing.name}? Click again`; return; }
    const id = editing.id;
    closeSheet();
    await window.operator.fireEmployee(id);
    current = null;
    await load();
  });

  /* ── keeping up ────────────────────────────────────────────────── */

  window.operator.onEmployeeEvent((p) => {
    if (shown && current && p && p.botId === current.id) refresh();
    else load();
  });

  // A notification clicked: straight to that employee.
  window.operator.onEmployeeOpen(async (p) => {
    if (modeBtn && !modeBtn.classList.contains('active')) modeBtn.click();
    if (p && p.botId) { keep(p.botId); await open(p.botId); }
  });

  // Countdowns ("next check-in 2:30 pm", "any moment") go stale by themselves.
  setInterval(() => { if (shown && current) { paintList(); paintDesk(false); } }, 30000);

  // Tab visibility, from the mode switch in renderer.js.
  const watch = new MutationObserver(() => {
    const was = shown;
    shown = !view.hidden;
    if (shown && !was) load();
  });
  watch.observe(view, { attributes: true, attributeFilter: ['hidden'] });

  window.__employees = {
    show: () => { shown = true; load(); },
    // For the Agent Verse: sit at an employee's computer, or hire at an empty desk.
    open: (id) => open(id),
    hire: (section) => openSheet(null, section),
    edit: () => current && openSheet(current),
    status,
  };
  load();
})();
