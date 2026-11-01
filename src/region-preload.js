const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionApi', {
  done: (rect) => ipcRenderer.send('region:done', rect), // null = cancelou
});
