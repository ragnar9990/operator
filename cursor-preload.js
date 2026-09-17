const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('operatorCursor', {
  onMove: (cb) => ipcRenderer.on('cursor-move', (_e, p) => cb(p)),
  onHide: (cb) => ipcRenderer.on('cursor-hide', () => cb()),
});
