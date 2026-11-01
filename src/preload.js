const { contextBridge, ipcRenderer } = require('electron');

// Canal direto com o AudioHelper (processo utilitário). O MessagePort não passa pelo
// contextBridge, então é entregue à página por window.postMessage.
ipcRenderer.on('helper:port', (e) => {
  window.postMessage({ __helperPort: true }, '*', e.ports);
});

contextBridge.exposeInMainWorld('native', {
  netInfo: () => ipcRenderer.invoke('net:info'),
  hostStart: (name) => ipcRenderer.invoke('host:start', name),
  discoverRooms: () => ipcRenderer.invoke('rooms:discover'),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  hostStatus: () => ipcRenderer.invoke('host:status'),
  captureSources: (type) => ipcRenderer.invoke('capture:sources', type),
  captureSelect: (id) => ipcRenderer.invoke('capture:select', id),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  appVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),

  saveDiagnostics: (text) => ipcRenderer.invoke('diag:save', text),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  trayStatus: (s) => ipcRenderer.send('tray:status', s),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),

  audioAvailable: () => ipcRenderer.invoke('audio:available'),
  videoTarget: (opts) => ipcRenderer.invoke('video:target', opts),
  onHelperRestarted: (cb) => ipcRenderer.on('helper:restarted', () => cb()),
});
