const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pointerApi', {
  onPointer: (cb) => ipcRenderer.on('pointer', (_e, p) => cb(p)),
  onHide: (cb) => ipcRenderer.on('pointer-hide', (_e, id) => cb(id)),
});
