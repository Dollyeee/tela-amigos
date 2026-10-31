const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  netInfo: () => ipcRenderer.invoke('net:info'),
  hostStart: () => ipcRenderer.invoke('host:start'),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  captureSources: (type) => ipcRenderer.invoke('capture:sources', type),
  captureSelect: (id) => ipcRenderer.invoke('capture:select', id),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  appVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),

  audioAvailable: () => ipcRenderer.invoke('audio:available'),
  audioList: () => ipcRenderer.invoke('audio:list'),
  audioStart: (mode, pid) => ipcRenderer.invoke('audio:start', { mode, pid }),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  onAudioPcm: (cb) => {
    ipcRenderer.removeAllListeners('audio:pcm');
    ipcRenderer.on('audio:pcm', (_e, buf) => cb(buf));
  },

  // vídeo nativo (captura WGC + H.264 por hardware no AudioHelper)
  videoStart: (opts) => ipcRenderer.invoke('video:start', opts),
  videoStop: () => ipcRenderer.invoke('video:stop'),
  videoKey: () => ipcRenderer.send('video:key'),
  videoBitrate: (kbps) => ipcRenderer.send('video:bitrate', kbps),
  onVideoFrame: (cb) => {
    ipcRenderer.removeAllListeners('video:frame');
    ipcRenderer.on('video:frame', (_e, buf) => cb(buf));
  },
  onHelperEvent: (cb) => {
    ipcRenderer.removeAllListeners('helper:event');
    ipcRenderer.on('helper:event', (_e, msg) => cb(msg));
  },
});
