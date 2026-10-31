const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, shell, session } = require('electron');
const path = require('path');
const os = require('os');
const { createSignalingServer } = require('./signaling');
const { AudioBridge } = require('./audio-bridge');

const SIGNAL_PORT = Number(process.env.TELA_PORT) || 47800;

// Sem isso o WebRTC esconde o IP local atrás de nomes ".local" (mDNS), que não
// resolvem pela VPN do Radmin -> a conexão direta falharia.
app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', process.env.TELA_DISABLE].filter(Boolean).join(','));
// Captura WGC entregando textura de GPU (sem cópia para a CPU): ~2x mais FPS em telas 1440p+
app.commandLine.appendSwitch('enable-features', ['WebRtcAllowWgcUsingTexture', process.env.TELA_FEATURES].filter(Boolean).join(','));
// Não reduzir a captura/codificação quando a janela estiver minimizada ou atrás de outras.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Perfil separado (permite abrir 2 instâncias no mesmo PC para testar)
if (process.env.TELA_PROFILE) app.setPath('userData', path.join(app.getPath('userData'), process.env.TELA_PROFILE));

let win = null;
let signaling = null;

const toRenderer = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const audio = new AudioBridge({
  onPcm: (pcm) => toRenderer('audio:pcm', pcm),
  onVideo: (frame) => toRenderer('video:frame', frame),
  onEvent: (msg) => toRenderer('helper:event', msg),
});

function localIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, ip: a.address, radmin: a.address.startsWith('26.') || /radmin/i.test(name) });
      }
    }
  }
  return out.sort((a, b) => b.radmin - a.radmin);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0e0f13',
    title: 'Tela Amigos',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Teste automatizado (só com variável de ambiente): roda um script na página e mostra o console
  if (process.env.TELA_TEST_SCRIPT) {
    win.webContents.on('console-message', (e) => {
      console.log(`[page] ${e.message}`);
      const m = /^SHOT (.+)$/.exec(e.message); // o script de teste pede uma captura da janela
      if (m) win.webContents.capturePage().then((img) => require('fs').writeFileSync(m[1], img.toPNG()));
    });
    if (process.env.TELA_TEST_ONTOP) {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.env.TELA_TEST_SIZE) { const [w, h] = process.env.TELA_TEST_SIZE.split('x').map(Number); win.setContentSize(w, h); win.setPosition(0, 0); }
      else win.maximize();
      win.focus();
    }
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(require('fs').readFileSync(process.env.TELA_TEST_SCRIPT, 'utf8'));
    });
  }
  // F12 abre as ferramentas de desenvolvedor (útil para depurar)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

ipcMain.handle('net:info', () => ({ ips: localIPs(), port: SIGNAL_PORT, hosting: !!signaling }));

ipcMain.handle('host:start', async () => {
  if (signaling) return { ok: true };
  try {
    signaling = await createSignalingServer(SIGNAL_PORT);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === 'EADDRINUSE' ? 'A porta 47800 já está em uso (o app já está hospedando?)' : e.message };
  }
});

ipcMain.handle('host:stop', () => {
  if (signaling) signaling.close();
  signaling = null;
});

// getDisplayMedia: o renderer escolhe a fonte no nosso seletor e avisa aqui antes de chamar.
let pendingSourceId = null;
ipcMain.handle('capture:select', (_e, id) => { pendingSourceId = id; });
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const types = pendingSourceId && pendingSourceId.startsWith('window') ? ['window'] : ['screen'];
    const all = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
    const src = all.find((s) => s.id === pendingSourceId) || all[0];
    pendingSourceId = null;
    callback(src ? { video: src } : {});
  });
}

ipcMain.handle('capture:sources', async (_e, type) => {
  const sources = await desktopCapturer.getSources({
    types: [type === 'window' ? 'window' : 'screen'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  const displays = screen.getAllDisplays();
  return sources.map((s) => {
    const d = displays.find((x) => String(x.id) === s.display_id);
    return {
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen') ? 'screen' : 'window',
      displayId: s.display_id,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      // resolução física do monitor (para o modo "nativa")
      size: d ? { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) } : null,
    };
  });
});

// Captura nativa (AudioHelper): converte o id do Electron em janela (HWND) ou ponto do monitor
ipcMain.handle('video:start', (_e, { sourceId, displayId, fps, kbps, maxWidth, maxHeight }) => {
  let target;
  const m = /^window:(\d+):/.exec(sourceId);
  if (m) {
    target = { type: 'window', hwnd: Number(m[1]) };
  } else {
    const displays = screen.getAllDisplays();
    const d = displays.find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
    const center = { x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) };
    const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(center) : center;
    target = { type: 'monitor', x: Math.round(p.x), y: Math.round(p.y) };
  }
  return audio.videoStart({ target, fps, kbps, maxWidth, maxHeight });
});
ipcMain.handle('video:stop', () => audio.videoStop());
ipcMain.on('video:key', () => audio.videoKey());
ipcMain.on('video:bitrate', (_e, kbps) => audio.videoBitrate(kbps));

ipcMain.handle('audio:available', () => audio.available());
ipcMain.handle('audio:list', () => audio.list());
ipcMain.handle('audio:start', (_e, { mode, pid }) => audio.start(mode, pid));
ipcMain.handle('audio:stop', () => audio.stop());

ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---- atualização automática (GitHub Releases) ----
function setupAutoUpdate() {
  if (!app.isPackaged) return; // rodando pelo "npm start": sem atualização
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se não reiniciar, instala ao fechar
  autoUpdater.on('download-progress', (p) => toRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => toRenderer('update:status', { state: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => console.warn('update', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 30 * 60 * 1000);
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
}

ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  installDisplayMediaHandler();
  createWindow();
  setupAutoUpdate();
});

app.on('window-all-closed', () => {
  audio.kill();
  if (signaling) signaling.close();
  app.quit();
});
