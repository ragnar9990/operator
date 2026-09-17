// Dev-only harness: fakes the Electron preload and the microphone so the front
// end can be driven in an ordinary browser. Mirrors store.js closely enough to
// exercise the real code paths. Excluded from the packaged app.

(function () {
  const listeners = { agent: [], voice: [], bots: [] };
  const emit = (e) => listeners.agent.forEach((cb) => cb(e));
  window.emit = emit;

  const KEY = 'preview.bots';
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);

  const SHAPES = ['squircle', 'round', 'dome', 'shield'];
  const ACCESSORIES = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
  const HUES = [199, 262, 152, 24, 341, 44, 288, 174];

  function faceFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return { hue: HUES[h % HUES.length], shape: SHAPES[(h >> 3) % SHAPES.length], accessory: ACCESSORIES[(h >> 6) % ACCESSORIES.length] };
  }

  function blank(name, title) {
    const id = uid('b');
    return { id, name, title: title || '', face: faceFor(id + name), persona: '', model: null, memory: [], skills: [], routines: [], chats: [], updatedAt: Date.now() };
  }

  function load() {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY));
      if (Array.isArray(v) && v.length) return v;
    } catch { /* fall through */ }
    return [blank('Operator', 'Runs this computer')];
  }
  function put(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* fine */ } }

  let BOTS = load();
  put(BOTS);

  const find = (id) => BOTS.find((b) => b.id === id);
  const lastLine = (b) => {
    const c = b.chats[0];
    if (!c || !c.turns.length) return '';
    for (let i = c.turns.length - 1; i >= 0; i--) {
      const t = c.turns[i];
      if (t.k === 'says' || t.k === 'you') return String(t.text).replace(/\s+/g, ' ').slice(0, 90);
    }
    return '';
  };
  const card = (b) => ({
    id: b.id, name: b.name, title: b.title, face: b.face, model: b.model, persona: b.persona,
    memoryCount: b.memory.length, routineCount: b.routines.filter((r) => !r.paused).length,
    skillCount: b.skills.length, updatedAt: b.updatedAt, lastLine: lastLine(b),
  });
  const sync = () => put(BOTS);

  window.operator = {
    runTask: async (prompt, model, botId, chatId) => { scriptReply(prompt, botId, chatId); return { ok: true }; },
    stopTask: async () => ({ ok: true }),
    onEvent: (cb) => listeners.agent.push(cb),
    onBotsChanged: (cb) => listeners.bots.push(cb),

    openBrowser: async () => ({ ok: true, chrome: true }),

    listModels: async () => ({
      current: 'claude-sonnet-5',
      models: [
        { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'The most capable, and the slowest' },
        { id: 'claude-opus-5', name: 'Opus 5', note: 'Deep reasoning, for work that needs care' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5', note: 'Quick enough to drive a screen', best: true },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', note: 'Fastest, for short repetitive jobs' },
        { id: 'claude-fable-5', name: 'Fable 5', note: 'Previous generation', older: true },
        { id: 'claude-opus-4-8', name: 'Opus 4.8', note: 'Previous generation', older: true },
        { id: 'claude-opus-4-7', name: 'Opus 4.7', note: 'Previous generation', older: true },
        { id: 'claude-opus-4-6', name: 'Opus 4.6', note: 'Previous generation', older: true },
        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', note: 'Previous generation', older: true },
      ],
    }),

    listBots: async () => BOTS.map(card),
    getBot: async (id) => find(id) || null,
    createBot: async (spec) => { const b = blank((spec && spec.name) || 'New bot', spec && spec.title); BOTS.unshift(b); sync(); return card(b); },
    updateBot: async (id, patch) => {
      const b = find(id); if (!b) return null;
      if (patch.name != null && String(patch.name).trim()) b.name = String(patch.name).trim();
      if (patch.title != null) b.title = String(patch.title);
      if (patch.persona != null) b.persona = String(patch.persona);
      if ('model' in patch) b.model = patch.model || null;
      if (patch.face) b.face = patch.face;
      b.updatedAt = Date.now(); sync(); return card(b);
    },
    deleteBot: async (id) => { BOTS = BOTS.filter((b) => b.id !== id); if (!BOTS.length) BOTS = [blank('Operator', 'Runs this computer')]; sync(); return { ok: true }; },
    rememberNote: async (id, text) => { const b = find(id); if (!b) return null; const n = { id: uid('m'), text, at: Date.now() }; b.memory.unshift(n); sync(); return n; },
    forgetNote: async (id, noteId) => { const b = find(id); if (b) b.memory = b.memory.filter((m) => m.id !== noteId); sync(); return { ok: true }; },

    addSkill: async (id, spec) => { const b = find(id); if (!b) return null; const s = { id: uid('s'), name: spec.name, prompt: spec.prompt }; b.skills.push(s); sync(); return s; },
    removeSkill: async (id, sid) => { const b = find(id); if (b) b.skills = b.skills.filter((s) => s.id !== sid); sync(); return { ok: true }; },

    addRoutine: async (id, spec) => {
      const b = find(id); if (!b) return null;
      const r = { id: uid('r'), name: spec.name, prompt: spec.prompt, every: spec.every, at: spec.at, paused: false, lastRun: null };
      b.routines.push(r); sync(); return r;
    },
    updateRoutine: async (id, rid, patch) => { const b = find(id); if (!b) return null; const r = b.routines.find((x) => x.id === rid); if (!r) return null; Object.assign(r, patch); sync(); return r; },
    removeRoutine: async (id, rid) => { const b = find(id); if (b) b.routines = b.routines.filter((r) => r.id !== rid); sync(); return { ok: true }; },
    runRoutine: async (id, rid) => {
      const b = find(id); const r = b && b.routines.find((x) => x.id === rid);
      if (!r) return { ok: false, error: 'That routine is gone.' };
      r.lastRun = Date.now(); sync();
      const c = { id: uid('c'), title: r.name, turns: [], updatedAt: Date.now() };
      b.chats.unshift(c); sync();
      emit({ type: 'routine', name: r.name, botId: id, chatId: c.id });
      scriptReply(r.prompt, id, c.id);
      return { ok: true };
    },

    listChats: async (botId) => { const b = find(botId); return b ? b.chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })) : []; },
    getChat: async (botId, id) => { const b = find(botId); return b ? b.chats.find((c) => c.id === id) || null : null; },
    createChat: async (botId) => { const b = find(botId); if (!b) return null; const c = { id: uid('c'), title: 'New chat', turns: [], updatedAt: Date.now() }; b.chats.unshift(c); sync(); return c; },
    saveChat: async (botId, id, patch) => {
      const b = find(botId); if (!b) return null;
      const c = b.chats.find((x) => x.id === id); if (!c) return null;
      if (patch.title) c.title = patch.title;
      if (patch.turns) c.turns = patch.turns;
      c.updatedAt = Date.now();
      b.chats = [c, ...b.chats.filter((x) => x.id !== id)];
      b.updatedAt = Date.now(); sync();
      return { id: c.id, title: c.title, updatedAt: c.updatedAt };
    },
    deleteChat: async (botId, id) => { const b = find(botId); if (b) b.chats = b.chats.filter((c) => c.id !== id); sync(); return { ok: true }; },

    voiceSay: async () => ({ ok: true }),
    whisperWarm: async () => ({ ok: true }),
    whisperTranscribe: async () => ({ ok: true, text: '' }),
    voiceHush: async () => ({ ok: true }),
    onVoice: (cb) => listeners.voice.push(cb),
  };

  window.MicListener = { start: async () => {}, stop: () => {}, discard: () => {} };

  /* a scripted turn that emits exactly what agent.js emits */

  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeShot() {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#1b2733'; x.fillRect(0, 0, 1280, 800);
    x.fillStyle = '#0f1720'; x.fillRect(0, 0, 1280, 64);
    x.fillStyle = '#2b3b4c'; x.fillRect(180, 140, 920, 520);
    x.fillStyle = '#7e8c9b'; x.font = '28px sans-serif';
    x.fillText('a window on the real screen', 300, 400);
    return c.toDataURL('image/png').split(',')[1];
  }

  async function scriptReply(prompt, botId, chatId) {
    // main.js writes a kept note to the store before forwarding it; mirror that
    // here or the harness would show a note the real app would have saved.
    const at = (e) => {
      if (e.type === 'remember' && botId) {
        const b = find(botId);
        if (b) { b.memory.unshift({ id: uid('m'), text: e.text, at: Date.now() }); sync(); }
      }
      emit({ ...e, botId, chatId });
    };
    const say = async (text) => {
      at({ type: 'say_start' });
      for (const word of text.split(/(?<=\s)/)) { at({ type: 'say_delta', text: word }); await nap(18); }
      at({ type: 'say_end', text });
    };

    await nap(500);
    await say('On it — "' + prompt.slice(0, 36) + '". Looking at the screen first.');
    await nap(350);
    at({ type: 'tool', name: 'list_windows', input: {} });
    await nap(400);
    at({ type: 'tool', name: 'screen_screenshot', input: { display: 1 } });
    at({ type: 'screenshot', b64: fakeShot(), label: 'display 1', mime: 'image/png' });
    await nap(400);
    at({ type: 'remember', text: 'Prefers the Downloads folder sorted by kind, not by date' });
    await nap(400);
    await say('Done — that is handled.');
    at({ type: 'done', text: null });
    at({ type: 'status', text: 'idle' });
  }

})();
