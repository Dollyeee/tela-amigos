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
  recovered: () => ipcRenderer.invoke('app:recovered'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),

  saveDiagnostics: (text) => ipcRenderer.invoke('diag:save', text),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  trayStatus: (s) => ipcRenderer.send('tray:status', s),
  saveClip: (name, buffer) => ipcRenderer.invoke('clip:save', name, buffer),
  recOpen: (name) => ipcRenderer.invoke('rec:open', name),
  recWrite: (handle, data, position) => ipcRenderer.send('rec:write', handle, data, position),
  recClose: (handle, empty) => ipcRenderer.invoke('rec:close', handle, empty),
  onRecError: (cb) => ipcRenderer.on('rec:error', (_e, info) => cb(info)),
  pointer: (p) => ipcRenderer.send('pointer:show', p),
  pointerHide: (id) => ipcRenderer.send('pointer:hide', id),
  ink: (p) => ipcRenderer.send('ink:show', p),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  unlockOverlays: () => ipcRenderer.send('overlay:unlock-all'),

  audioAvailable: () => ipcRenderer.invoke('audio:available'),
  videoTarget: (opts) => ipcRenderer.invoke('video:target', opts),
  pickRegion: (displayId) => ipcRenderer.invoke('region:pick', displayId),
  onHelperRestarted: (cb) => ipcRenderer.on('helper:restarted', () => cb()),
});
