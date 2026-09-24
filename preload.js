const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('operator', {
  runTask: (prompt, model, botId, chatId, dryRun) => ipcRenderer.invoke('run-task', prompt, model, botId, chatId, dryRun),
  stopTask: () => ipcRenderer.invoke('stop-task'),
  listModels: () => ipcRenderer.invoke('list-models'),
  // The dial beside the picker: { spec, values, summary } for a model, per side.
  modelOptions: (mode, id) => ipcRenderer.invoke('model-options:get', mode, id),
  setModelOptions: (mode, id, patch) => ipcRenderer.invoke('model-options:set', mode, id, patch),

  // NVIDIA NIM — one key, every vendor's models
  nvidiaStatus: () => ipcRenderer.invoke('nvidia:status'),
  nvidiaSetKey: (key) => ipcRenderer.invoke('nvidia:set', key),
  nvidiaSweep: () => ipcRenderer.invoke('nvidia:sweep'),
  onNvidiaProgress: (cb) => ipcRenderer.on('nvidia-progress', (_e, p) => cb(p)),

  openBrowser: (url) => ipcRenderer.invoke('browser:open', url),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, payload) => cb(payload)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, payload) => cb(payload)),
  phoneStatus: () => ipcRenderer.invoke('phone:status'),
  phoneStart: () => ipcRenderer.invoke('phone:start'),
  phoneStop: () => ipcRenderer.invoke('phone:stop'),
  phoneRotate: () => ipcRenderer.invoke('phone:rotate'),

  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.invoke('prefs:set', patch),

  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  onBotsChanged: (cb) => ipcRenderer.on('bots-changed', (_e, payload) => cb(payload)),

  // bots
  listBots: () => ipcRenderer.invoke('bots:list'),
  getBot: (id) => ipcRenderer.invoke('bots:get', id),
  createBot: (spec) => ipcRenderer.invoke('bots:create', spec),
  // an agent: a bot and the one thread it is
  createAgent: (spec) => ipcRenderer.invoke('agents:create', spec),
  agentThread: (id) => ipcRenderer.invoke('agents:thread', id),

  // workspaces: named folders you file agents into
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (name) => ipcRenderer.invoke('workspaces:create', name),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('workspaces:update', id, patch),
  deleteWorkspace: (id) => ipcRenderer.invoke('workspaces:delete', id),
  fileAgent: (botId, wsId) => ipcRenderer.invoke('workspaces:file', botId, wsId),
  updateBot: (id, patch) => ipcRenderer.invoke('bots:update', id, patch),
  deleteBot: (id) => ipcRenderer.invoke('bots:delete', id),
  restoreBot: (snap, index) => ipcRenderer.invoke('bots:restore', snap, index),
  forgetNote: (id, noteId) => ipcRenderer.invoke('bots:forget', id, noteId),
  rememberNote: (id, text) => ipcRenderer.invoke('bots:remember', id, text),

  // skills library (Settings → Skills)
  skillsList: () => ipcRenderer.invoke('skills:list'),
  createSkill: (spec) => ipcRenderer.invoke('skills:create', spec),
  updateSkill: (skillId, patch) => ipcRenderer.invoke('skills:update', skillId, patch),
  deleteSkill: (skillId) => ipcRenderer.invoke('skills:delete', skillId),
  // always-on membership on a bot
  attachSkill: (botId, skillId) => ipcRenderer.invoke('bots:attachSkill', botId, skillId),
  detachSkill: (botId, skillId) => ipcRenderer.invoke('bots:detachSkill', botId, skillId),

  addRoutine: (id, spec) => ipcRenderer.invoke('routines:add', id, spec),
  updateRoutine: (id, rid, patch) => ipcRenderer.invoke('routines:update', id, rid, patch),
  removeRoutine: (id, rid) => ipcRenderer.invoke('routines:remove', id, rid),
  runRoutine: (id, rid) => ipcRenderer.invoke('routines:run', id, rid),

  // chats, which live under a bot
  listChats: (botId) => ipcRenderer.invoke('chats:list', botId),
  getChat: (botId, id) => ipcRenderer.invoke('chats:get', botId, id),
  createChat: (botId) => ipcRenderer.invoke('chats:create', botId),
  saveChat: (botId, id, patch) => ipcRenderer.invoke('chats:save', botId, id, patch),
  deleteChat: (botId, id) => ipcRenderer.invoke('chats:delete', botId, id),

  voiceSay: (text) => ipcRenderer.invoke('voice-say', text),

  // hands-free mode: the voice that runs the app
  voiceWarm: () => ipcRenderer.invoke('voice:warm'),
  voiceHeard: (said, onScreen) => ipcRenderer.invoke('voice:heard', said, onScreen),
  voiceTest: () => ipcRenderer.invoke('voice:test'),
  voiceQuiet: () => ipcRenderer.invoke('voice:hush'),
  voiceEnd: () => ipcRenderer.invoke('voice:end'),
  onVoiceAudio: (cb) => ipcRenderer.on('voice-audio', (_e, p) => cb(p)),
  onVoiceChanged: (cb) => ipcRenderer.on('voice-changed', () => cb()),
  onVoiceOpen: (cb) => ipcRenderer.on('voice-open', (_e, p) => cb(p)),
  grabScreen: (opts) => ipcRenderer.invoke('screen:grab', opts),
  setQuiet: (on) => ipcRenderer.invoke('input:quiet', on),
  setOwnDesktop: (on) => ipcRenderer.invoke('input:ownDesktop', on),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remoteConnect: (url, token) => ipcRenderer.invoke('remote:connect', url, token),
  remoteDisconnect: () => ipcRenderer.invoke('remote:disconnect'),

  codeChatsList: () => ipcRenderer.invoke('codeChats:list'),
  codeChatGet: (id) => ipcRenderer.invoke('codeChats:get', id),
  codeChatCreate: () => ipcRenderer.invoke('codeChats:create'),
  codeChatDelete: (id) => ipcRenderer.invoke('codeChats:delete', id),
  codeSetModel: (id, model) => ipcRenderer.invoke('codeChats:setModel', id, model),
  codeSetBot: (id, botId) => ipcRenderer.invoke('codeChats:setBot', id, botId),
  codePickFolder: (id) => ipcRenderer.invoke('code:pickFolder', id),
  codeRun: (chatId, prompt, refs) => ipcRenderer.invoke('code:run', chatId, prompt, refs),
  codeSetFolder: (id, dir) => ipcRenderer.invoke('code:setFolder', id, dir),

  // the editor panel's view of the disk (files.js)
  fsList: (dir) => ipcRenderer.invoke('fs:list', dir),
  fsStat: (p) => ipcRenderer.invoke('fs:stat', p),
  fsRead: (file) => ipcRenderer.invoke('fs:read', file),
  fsWrite: (file, text) => ipcRenderer.invoke('fs:write', file, text),
  fsCreate: (dir, name, isDir) => ipcRenderer.invoke('fs:create', dir, name, isDir),
  fsRename: (from, name) => ipcRenderer.invoke('fs:rename', from, name),
  fsTrash: (p) => ipcRenderer.invoke('fs:trash', p),
  fsReveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  fsOpenExternal: (p) => ipcRenderer.invoke('fs:openExternal', p),
  openUrl: (url) => ipcRenderer.invoke('fs:openUrl', url),
  fsPickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  fsPickFiles: () => ipcRenderer.invoke('fs:pickFiles'),
  fsWatch: (root) => ipcRenderer.invoke('fs:watch', root),
  onFsChanged: (cb) => ipcRenderer.on('fs-changed', (_e, payload) => cb(payload)),
  // Electron 32 took File.path away; this is how a dropped file says where it is.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; } },
  codeStop: (chatId) => ipcRenderer.invoke('code:stop', chatId),
  codeRunningChats: () => ipcRenderer.invoke('code:running'),
  onCode: (cb) => ipcRenderer.on('code-event', (_e, payload) => cb(payload)),

  // audit trail (Settings → Audit) — query and export only; nothing here writes
  auditQuery: (filter) => ipcRenderer.invoke('audit:query', filter),
  auditFacets: () => ipcRenderer.invoke('audit:facets'),
  auditExport: (format, filter) => ipcRenderer.invoke('audit:export', format, filter),

  connectorsList: () => ipcRenderer.invoke('connectors:list'),
  connectEmail: (cfg) => ipcRenderer.invoke('connectors:connectEmail', cfg),
  disconnectConnector: (id) => ipcRenderer.invoke('connectors:disconnect', id),
  googleGetCreds: () => ipcRenderer.invoke('connectors:googleGetCreds'),
  googleSetCreds: (creds) => ipcRenderer.invoke('connectors:googleSetCreds', creds),
  googleSignIn: () => ipcRenderer.invoke('connectors:googleSignIn'),
  whisperWarm: () => ipcRenderer.invoke('whisper-warm'),
  whisperTranscribe: (wav) => ipcRenderer.invoke('whisper-transcribe', wav),
  voiceHush: () => ipcRenderer.invoke('voice-hush'),
  onVoice: (cb) => ipcRenderer.on('voice-event', (_e, payload) => cb(payload)),
});
