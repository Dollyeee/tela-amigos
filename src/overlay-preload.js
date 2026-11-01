const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  lock: (locked) => ipcRenderer.send('overlay:lock', locked),
  opacity: (v) => ipcRenderer.send('overlay:opacity', v),
  onLocked: (cb) => ipcRenderer.on('overlay:locked', (_e, locked) => cb(locked)),
});
