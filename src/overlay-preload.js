const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  lock: (locked) => ipcRenderer.send('overlay:lock', locked),
  opacity: (v) => ipcRenderer.send('overlay:opacity', v),
  hoverUnlock: (over) => ipcRenderer.send('overlay:hover-unlock', over),
  onLocked: (cb) => ipcRenderer.on('overlay:locked', (_e, locked, key) => cb(locked, key)),
});
