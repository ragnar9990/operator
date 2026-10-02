/* ── computers: the spare PCs Operator can work on ────────────────────
 * Settings → Computer lists them, with whether each is answering; an agent
 * (its sheet) and a playbook (its page) can be set to run on one. Main does
 * the asking and the switching (machines:* in main.js); this only shows it.
 *
 * Loaded after renderer.js, and borrows its esc() and the agent it has open
 * (`bot`).
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('fleetList');
  if (!listEl) return;

  let machines = [];
  let target = { kind: 'local' };

  const ago = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };

  function stateOf(m) {
    if (m.busy) return { cls: 'busy', text: 'Working on it now' };
    if (m.online === true) return { cls: 'on', text: `Answering${m.lastSeen ? ' · checked ' + ago(m.lastSeen) : ''}` };
    if (m.online === false) return { cls: 'off', text: `Not answering${m.lastSeen ? ' · last seen ' + ago(m.lastSeen) : ''}` };
    return { cls: '', text: 'Checking…' };
  }

  async function load() {
    try { ({ machines, target } = await window.operator.machines()); } catch { machines = []; }
    paintList();
    paintBadge();
    paintAgentChoice();
    document.dispatchEvent(new CustomEvent('fleet:changed'));
  }

  function paintList() {
    listEl.textContent = '';
    if (!machines.length) {
      const p = document.createElement('p');
      p.className = 'set-hint';
      p.textContent = 'None yet.';
      listEl.appendChild(p);
      return;
    }
    for (const m of machines) {
      const st = stateOf(m);
      const row = document.createElement('div');
      row.className = 'fleet-row' + (m.inUse ? ' in-use' : '');
      row.innerHTML =
        `<span class="fleet-dot ${st.cls}" aria-hidden="true"></span>` +
        '<span class="fleet-text">' +
          `<b tabindex="0" title="Click to rename">${esc(m.name)}</b>` +
          `<small>${esc(st.text)} · ${esc(m.host ? m.host + ' · ' : '')}${esc(m.url)}</small>` +
          (m.online === false && m.error ? `<small class="fleet-err">${esc(m.error)}</small>` : '') +
        '</span>' +
        (m.inUse ? '<span class="fleet-tag">In use</span>' : '<button class="mini" type="button" data-act="use">Use now</button>') +
        '<button class="mini" type="button" data-act="remove">Remove</button>';

      const name = row.querySelector('b');
      name.addEventListener('click', () => {
        if (name.isContentEditable) return;
        name.contentEditable = 'true';
        name.focus();
        document.getSelection().selectAllChildren(name);
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        if (e.key === 'Escape') { name.textContent = m.name; name.blur(); }
      });
      name.addEventListener('blur', async () => {
        if (!name.isContentEditable) return;
        name.contentEditable = 'false';
        const next = name.textContent.trim();
        if (next && next !== m.name) await window.operator.machineRename(m.id, next);
        else name.textContent = m.name;
      });

      const use = row.querySelector('[data-act="use"]');
      if (use) use.addEventListener('click', async () => {
        use.disabled = true;
        const r = await window.operator.machineUse(m.id);
        if (!r || !r.ok) { use.disabled = false; $('fleetStatus').textContent = (r && r.error) || 'Could not switch.'; $('fleetStatus').className = 'remote-status bad'; }
        load();
      });
      row.querySelector('[data-act="remove"]').addEventListener('click', async (e) => {
        const b = e.currentTarget;
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.textContent = 'Sure?';
          setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove'; }, 2500);
          return;
        }
        await window.operator.machineRemove(m.id);
        load();
      });
      listEl.appendChild(row);
    }
  }

  // The badge in the top bar says which computer it is pointed at — by the
  // name it has here, when it has one.
  function paintBadge() {
    const badge = $('targetBadge');
    const text = $('targetBadgeText');
    if (!badge || !text) return;
    const remote = target && target.kind === 'remote';
    const m = remote && machines.find((x) => x.url === target.url);
    badge.classList.toggle('remote', Boolean(remote));
    if (remote) text.textContent = m ? m.name : (text.textContent || 'Remote computer');
    else text.textContent = 'This computer';
    const optLocal = $('targetLocal');
    const optRemote = $('targetRemote');
    if (optLocal) optLocal.classList.toggle('active', !remote);
    if (optRemote) optRemote.classList.toggle('active', Boolean(remote));
  }

  $('fleetAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('fleetStatus');
    out.textContent = 'Asking it…';
    out.className = 'remote-status';
    $('fleetAddBtn').disabled = true;
    const r = await window.operator.machineAdd({ name: $('fleetName').value.trim(), url: $('fleetUrl').value.trim(), token: $('fleetToken').value.trim() });
    $('fleetAddBtn').disabled = false;
    if (!r || !r.ok) { out.textContent = (r && r.error) || 'Could not add it.'; out.className = 'remote-status bad'; return; }
    out.textContent = `Added ${r.machine.name} — it answered.`;
    out.className = 'remote-status ok';
    $('fleetName').value = ''; $('fleetUrl').value = ''; $('fleetToken').value = '';
    load();
  });

  // A list of computers in a <select>: "" first (what that means is the
  // caller's to say), then each machine, marked when it is not answering.
  function fillSelect(sel, value, emptyLabel) {
    if (!sel) return;
    sel.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = emptyLabel;
    sel.appendChild(first);
    for (const m of machines) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name + (m.online === false ? ' — not answering' : '');
      sel.appendChild(o);
    }
    sel.value = value && machines.some((m) => m.id === value) ? value : '';
  }

  // The agent's sheet: which computer this agent works on.
  const fMachine = $('fMachine');
  function paintAgentChoice() {
    if (!fMachine || typeof bot === 'undefined' || !bot) return;
    fillSelect(fMachine, bot.machine, machines.length ? 'The one set in Settings → Computer' : 'This computer');
  }
  if (fMachine) {
    fMachine.addEventListener('change', async () => {
      if (typeof bot === 'undefined' || !bot) return;
      const machine = fMachine.value || null;
      await window.operator.updateBot(bot.id, { machine });
      bot.machine = machine;
    });
    const agentSheet = $('sheet');
    if (agentSheet) {
      new MutationObserver(() => { if (!agentSheet.hidden) paintAgentChoice(); })
        .observe(agentSheet, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  window.operator.onMachinesChanged(() => load());
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => load());
  const badge = $('targetBadge');
  if (badge) badge.addEventListener('click', () => load());

  window.__fleet = { fillSelect, list: () => machines, load };
  load();
})();
