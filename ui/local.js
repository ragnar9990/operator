/* ── Settings → Models: a model on this computer ──────────────────────
 * Ollama, LM Studio, llama.cpp's server. Main finds them (local.js); this
 * says what it found, and keeps an address for one somewhere else.
 *
 * Loaded after renderer.js, and borrows its esc().
 */

(() => {
  const box = document.getElementById('localProvider');
  if (!box) return;
  const $ = (id) => document.getElementById(id);

  function paint(st) {
    if (!st) return;
    const n = st.models.length;
    const on = st.servers.length > 0;
    box.classList.toggle('on', on);
    $('lcSub').textContent = on
      ? `${st.servers.map((s) => s.label).join(' and ')} · ${n} model${n === 1 ? '' : 's'}`
      : 'Nothing running';
    const list = $('lcModels');
    list.textContent = '';
    list.hidden = !n;
    for (const m of st.models) {
      const row = document.createElement('div');
      row.className = 'lc-model';
      const tags = m.tags.filter((t) => t !== 'on this PC').map((t) =>
        `<span class="tag${t === 'no tool calling' ? ' warn' : ''}">${esc(t)}</span>`).join('');
      row.innerHTML = `<b>${esc(m.name)}</b><small>${esc(m.note)}</small>${tags}`;
      list.appendChild(row);
    }
    if (document.activeElement !== $('lcUrl')) $('lcUrl').value = st.custom || '';
  }

  async function look(force) {
    if (force) $('lcSub').textContent = 'Looking…';
    try { paint(await window.operator.localStatus(force)); } catch { /* the card says what it last knew */ }
  }

  $('lcLook').addEventListener('click', () => look(true));
  $('lcSave').addEventListener('click', async () => {
    const out = $('lcStatus');
    out.textContent = 'Checking…';
    const r = await window.operator.localSetUrl($('lcUrl').value);
    out.textContent = r.ok ? (r.warning || ($('lcUrl').value.trim() ? 'Saved — it answered.' : 'Cleared.')) : r.error;
    paint(r.status);
  });
  $('lcUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('lcSave').click(); } });

  // Look whenever the Models tab is opened: a server started a minute ago
  // should be there.
  const tab = document.querySelector('#settingsTabs [data-tab="models"]');
  if (tab) tab.addEventListener('click', () => look(false));
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => look(false));
})();
