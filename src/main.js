const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, shell, session,
  utilityProcess, MessageChannelMain, Tray, Menu, globalShortcut, nativeImage,
} = require('electron');

// registro do processo principal (vai no diagnóstico)
const mainLog = [];
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    mainLog.push(`${new Date().toISOString()} [${level}] ${args.map((a) => (a && a.stack) || String(a)).join(' ')}`);
    if (mainLog.length > 400) mainLog.shift();
    orig(...args);
  };
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

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

const toRenderer = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

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

// ---------------------------------------------------------------- AudioHelper (fora do processo principal)
// O helper roda dentro de um processo utilitário que fala direto com a interface por um
// MessagePort. O processo principal só cria o canal; vídeo/áudio nunca passam por ele.
function helperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'AudioHelper.exe'),
    path.join(app.getAppPath(), 'helper-bin', 'AudioHelper.exe'),
    path.join(__dirname, '..', 'helper-bin', 'AudioHelper.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

let helperHost = null;
let quitting = false;

function startHelperHost() {
  helperHost = utilityProcess.fork(path.join(__dirname, 'helper-host.js'), [], { serviceName: 'Tela Amigos Helper' });
  helperHost.postMessage({ type: 'config', exe: helperPath(), selfPid: process.pid });
  helperHost.on('exit', () => {
    helperHost = null;
    if (quitting) return;
    // caiu: sobe de novo e reconecta a interface
    setTimeout(() => { startHelperHost(); connectRendererToHelper(); }, 500);
    toRenderer('helper:restarted', null);
  });
}

function connectRendererToHelper() {
  if (!helperHost || !win || win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  helperHost.postMessage({ type: 'port' }, [port1]);
  win.webContents.postMessage('helper:port', null, [port2]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0e0f13',
    title: 'Tela Amigos',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    // barra de título integrada: o topo do app vira a área de arrastar e os botões do Windows
    // (minimizar/maximizar/fechar) ficam no canto, na cor do app
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f13', symbolColor: '#c9cdd8', height: 56 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  // a cada carregamento (inclusive recarga) a página ganha um canal novo com o helper
  win.webContents.on('did-finish-load', connectRendererToHelper);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    // janela de sobreposição (tela de um amigo por cima do jogo)
    if (url.startsWith('file:') && url.includes('overlay.html')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480, height: 270, minWidth: 200, minHeight: 113, frame: false, alwaysOnTop: true,
          backgroundColor: '#000000', title: 'Tela Amigos - sobreposição', icon: path.join(__dirname, 'renderer', 'icon.png'),
          webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), backgroundThrottling: false },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setAlwaysOnTop(true, 'screen-saver'); // por cima de jogo em tela cheia sem bordas
    child.setAspectRatio(16 / 9);
    child.locked = false;
    overlays.add(child);
    child.on('closed', () => overlays.delete(child));
  });
  // Teste automatizado (só com variável de ambiente): roda um script na página e mostra o console
  if (process.env.TELA_TEST_SCRIPT) {
    win.webContents.on('console-message', (e) => {
      console.log(`[page] ${e.message}`);
      const m = /^SHOT (.+)$/.exec(e.message); // o script de teste pede uma captura da janela
      if (m) win.webContents.capturePage().then((img) => fs.writeFileSync(m[1], img.toPNG()));
    });
    if (process.env.TELA_TEST_ONTOP) {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.env.TELA_TEST_SIZE) { const [w, h] = process.env.TELA_TEST_SIZE.split('x').map(Number); win.setContentSize(w, h); win.setPosition(0, 0); }
      else win.maximize();
      win.focus();
    }
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(fs.readFileSync(process.env.TELA_TEST_SCRIPT, 'utf8'));
    });
  }
  // F12 abre as ferramentas de desenvolvedor (útil para depurar)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

ipcMain.handle('net:info', () => ({ ips: localIPs(), port: SIGNAL_PORT }));

// ---------------------------------------------------------------- sala em segundo plano
// O servidor da sala roda num processo próprio (Tela Amigos.exe como Node, sem janela) que
// NÃO fecha junto com o app: dá para reiniciar/atualizar o app sem derrubar a sala.
function roomStatus(timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: SIGNAL_PORT, path: '/', timeout }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.app === 'tela-amigos' ? { running: true, members: j.members, names: j.names } : { running: false, busy: true });
        } catch { resolve({ running: false, busy: true }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
    req.on('error', () => resolve({ running: false }));
  });
}

function unpackedPath(p) {
  // dentro do instalador os arquivos ficam em app.asar; o servidor roda da cópia "unpacked"
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

ipcMain.handle('host:status', () => roomStatus());

// Procura salas abertas: broadcast em cada rede (Radmin 26.255.255.255, rede local...) e
// junta as respostas por ~1,2 s. A resposta chega como "unicast" para a porta que perguntou,
// o que o firewall do Windows permite sem regra extra.
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

ipcMain.handle('rooms:discover', () => new Promise((resolve) => {
  const dgram = require('dgram');
  const found = new Map();
  const mine = new Set(localIPs().map((x) => x.ip));
  const sock = dgram.createSocket('udp4');
  sock.on('error', () => { try { sock.close(); } catch {} resolve([]); });
  sock.on('message', (msg, rinfo) => {
    try {
      const j = JSON.parse(msg.toString());
      if (j.app !== 'tela-amigos' || mine.has(rinfo.address)) return; // ignora a própria sala
      found.set(rinfo.address, { ip: rinfo.address, port: j.port, hostName: j.hostName, members: j.members, names: j.names || [] });
    } catch {}
  });
  sock.bind(0, () => {
    sock.setBroadcast(true);
    const probe = Buffer.from('TELA_AMIGOS_DISCOVER');
    for (const addr of broadcastAddresses()) sock.send(probe, SIGNAL_PORT + 1, addr, () => {});
  });
  setTimeout(() => {
    try { sock.close(); } catch {}
    resolve([...found.values()]);
  }, 1200);
}));

ipcMain.handle('host:start', async (_e, hostName) => {
  const st = await roomStatus();
  if (st.running) return { ok: true, reused: true };
  if (st.busy) return { ok: false, error: `A porta ${SIGNAL_PORT} está sendo usada por outro programa.` };
  const script = unpackedPath(path.join(__dirname, 'room-server.js'));
  const child = spawn(process.execPath, [script, String(SIGNAL_PORT), String(hostName || 'Sala').slice(0, 30)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  for (let i = 0; i < 30; i++) {           // espera até ~3 s a sala responder
    await new Promise((r) => setTimeout(r, 100));
    if ((await roomStatus(300)).running) return { ok: true };
  }
  return { ok: false, error: 'Não consegui abrir a sala (o firewall pode estar bloqueando).' };
});

// Fecha a sala para todos (o "Sair" normal não fecha mais)
ipcMain.handle('host:stop', () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: SIGNAL_PORT, path: '/shutdown', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
}));

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

// Miniaturas do seletor: pequenas e em JPEG (PNG travava o processo principal ~0,7 s),
// com cache curto para abrir/trocar de aba sem refazer tudo.
const sourcesCache = new Map(); // type -> { at, list }
ipcMain.handle('capture:sources', async (_e, type) => {
  const kind = type === 'window' ? 'window' : 'screen';
  const cached = sourcesCache.get(kind);
  if (cached && Date.now() - cached.at < 4000) return cached.list;
  // Janelas: sem miniatura (capturar uma imagem de cada janela disputa a placa de vídeo com a
  // transmissão e levava vários segundos); só ícone e nome. Telas (poucas) mantêm miniatura.
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: kind === 'window' ? { width: 0, height: 0 } : { width: 320, height: 180 },
    fetchWindowIcons: kind === 'window',
  });
  const displays = screen.getAllDisplays();
  const list = sources
    .filter((s) => kind === 'screen' || (s.name && s.name.trim()))
    .map((s) => {
      const d = displays.find((x) => String(x.id) === s.display_id);
      const thumb = s.thumbnail.isEmpty() ? null : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`;
      return {
        id: s.id,
        name: s.name,
        type: kind,
        displayId: s.display_id,
        thumbnail: thumb,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32, height: 32 }).toDataURL() : null,
        // resolução física do monitor (para o modo "nativa")
        size: d ? { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) } : null,
      };
    });
  sourcesCache.set(kind, { at: Date.now(), list });
  return list;
});

// Captura nativa: converte o id do Electron em janela (HWND) ou ponto do monitor
ipcMain.handle('video:target', (_e, { sourceId, displayId }) => {
  const m = /^window:(\d+):/.exec(sourceId);
  if (m) return { type: 'window', hwnd: Number(m[1]) };
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  const center = { x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) };
  const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(center) : center;
  return { type: 'monitor', x: Math.round(p.x), y: Math.round(p.y) };
});

ipcMain.handle('audio:available', () => !!helperPath());

ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---- atualização automática (GitHub Releases) ----
function setupAutoUpdate() {
  if (!app.isPackaged) {
    // rodando pelo "npm start": sem atualização
    ipcMain.handle('update:check', () => { toRenderer('update:status', { state: 'dev' }); });
    return;
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se não reiniciar, instala ao fechar

  let ready = null;      // versão já baixada
  let lastCheck = 0;
  let manual = false;    // o usuário clicou em "procurar": mostra também "já está atualizado"
  autoUpdater.on('checking-for-update', () => { if (manual) toRenderer('update:status', { state: 'checking' }); });
  autoUpdater.on('update-available', (info) => toRenderer('update:status', { state: 'downloading', percent: 0, version: info.version }));
  autoUpdater.on('update-not-available', () => {
    if (manual && !ready) toRenderer('update:status', { state: 'latest', version: app.getVersion() });
    manual = false;
  });
  autoUpdater.on('download-progress', (p) => toRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version;
    manual = false;
    toRenderer('update:status', { state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (e) => {
    if (manual) toRenderer('update:status', { state: 'error', message: (e && e.message) || 'erro' });
    manual = false;
  });

  // Continua procurando mesmo com uma versão já baixada: se saiu outra mais nova nesse meio
  // tempo, baixa a mais nova (antes instalava a baixada e só depois achava a seguinte,
  // indo de uma em uma).
  const check = (isManual = false) => {
    if (ready && isManual) toRenderer('update:status', { state: 'ready', version: ready });
    if (isManual) manual = true;
    lastCheck = Date.now();
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 1000);                     // logo ao abrir
  setInterval(check, 5 * 60 * 1000);           // a cada 5 min
  app.on('browser-window-focus', () => {       // ao voltar para o app (no máx. a cada 2 min)
    if (Date.now() - lastCheck > 2 * 60 * 1000) check();
  });
  ipcMain.handle('update:check', () => check(true));
  ipcMain.handle('update:install', () => {
    quitting = true;
    if (helperHost) helperHost.postMessage({ type: 'quit' }); // para a captura com calma
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500);
  });
}

ipcMain.handle('app:version', () => app.getVersion());

// ---- diagnóstico: junta tudo num .txt na Área de Trabalho e mostra o arquivo ----
ipcMain.handle('diag:save', async (_e, rendererText) => {
  let gpu = '';
  try { gpu = JSON.stringify(await app.getGPUInfo('basic'), null, 1).slice(0, 4000); } catch {}
  const text = [
    `Tela Amigos v${app.getVersion()} — diagnóstico ${new Date().toLocaleString('pt-BR')}`,
    `Windows ${os.release()} · ${os.cpus()[0] && os.cpus()[0].model} · ${os.cpus().length} núcleos · RAM ${Math.round(os.totalmem() / 1e9)} GB`,
    `Redes: ${JSON.stringify(localIPs())}`,
    `Sala neste PC: ${JSON.stringify(await roomStatus())}`,
    '', '===== interface =====', rendererText,
    '', '===== processo principal =====', mainLog.join('\n'),
    '', '===== placa de vídeo =====', gpu,
  ].join('\n');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(app.getPath('desktop'), `TelaAmigos-diagnostico-${stamp}.txt`);
  fs.writeFileSync(file, '﻿' + text, 'utf8'); // com BOM: acentos certos em qualquer editor
  shell.showItemInFolder(file);
  return file;
});

ipcMain.handle('window:focus', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// ---- janelas de sobreposição ----
const overlays = new Set();
function setOverlayLock(w, locked) {
  if (!w || w.isDestroyed()) return;
  w.locked = locked;
  w.setIgnoreMouseEvents(locked, { forward: true }); // travada: cliques atravessam para o jogo
  w.webContents.send('overlay:locked', locked);
}
ipcMain.on('overlay:lock', (e, locked) => setOverlayLock(BrowserWindow.fromWebContents(e.sender), !!locked));
ipcMain.on('overlay:opacity', (e, v) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setOpacity(Math.max(0.25, Math.min(1, Number(v) || 1)));
});
function toggleOverlayLocks() {
  if (!overlays.size) return;
  const anyUnlocked = [...overlays].some((w) => !w.locked);
  for (const w of overlays) setOverlayLock(w, anyUnlocked);
}

// ---- laser no monitor de quem transmite ----
// Janela transparente por cima de tudo, que não recebe cliques e fica FORA da captura
// (não aparece na transmissão). Só fica visível enquanto alguém está apontando.
let pointerWin = null, pointerDisplay = null, pointerHideTimer = null;
function ensurePointerWin(displayId) {
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  if (pointerWin && !pointerWin.isDestroyed() && pointerDisplay === d.id) return pointerWin;
  if (pointerWin && !pointerWin.isDestroyed()) pointerWin.destroy();
  pointerWin = new BrowserWindow({
    ...d.bounds, transparent: true, frame: false, skipTaskbar: true, focusable: false, resizable: false,
    movable: false, hasShadow: false, show: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'pointer-preload.js') },
  });
  pointerWin.setIgnoreMouseEvents(true);
  pointerWin.setAlwaysOnTop(true, 'screen-saver');
  pointerWin.setContentProtection(true); // fora da captura de tela
  pointerWin.loadFile(path.join(__dirname, 'renderer', 'pointer.html'));
  pointerDisplay = d.id;
  return pointerWin;
}
ipcMain.on('pointer:show', (_e, p) => {
  const w = ensurePointerWin(p.displayId);
  const send = () => { if (!w.isDestroyed()) { w.webContents.send('pointer', p); if (!w.isVisible()) w.showInactive(); } };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
  clearTimeout(pointerHideTimer);
  pointerHideTimer = setTimeout(() => { if (pointerWin && !pointerWin.isDestroyed()) pointerWin.hide(); }, 2000);
});
ipcMain.on('pointer:hide', (_e, id) => {
  if (pointerWin && !pointerWin.isDestroyed()) pointerWin.webContents.send('pointer-hide', id);
});

// ---- ícone na bandeja: status da sala e atalhos ----
let tray = null;
let trayStatus = { room: '', people: [], sharing: false };
function updateTray() {
  if (!tray) return;
  const s = trayStatus;
  tray.setToolTip(s.room
    ? `Tela Amigos — sala ${s.room}${s.people.length ? `: ${s.people.join(', ')}` : ''}${s.sharing ? ' · você está ao vivo' : ''}`
    : 'Tela Amigos');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Tela Amigos', click: () => ipcMain.emit('window:show') },
    { type: 'separator' },
    { label: s.sharing ? 'Parar de transmitir (Ctrl+Shift+S)' : 'Transmitir (Ctrl+Shift+S)', click: () => toRenderer('hotkey', 'share') },
    { label: 'Mutar/desmutar todos (Ctrl+Shift+M)', click: () => toRenderer('hotkey', 'mute') },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.quit(); } },
  ]));
}
ipcMain.on('window:show', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
ipcMain.on('tray:status', (_e, s) => { trayStatus = s; updateTray(); });

function setupTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', () => ipcMain.emit('window:show'));
  updateTray();
}

// ---- teclas de atalho globais (funcionam com o jogo em primeiro plano) ----
function setupHotkeys() {
  const keys = { 'Control+Shift+S': 'share', 'Control+Shift+M': 'mute', 'Control+Shift+O': 'overlay-lock' };
  for (const [accel, action] of Object.entries(keys)) {
    const fn = action === 'overlay-lock' ? toggleOverlayLocks : () => toRenderer('hotkey', action);
    try { globalShortcut.register(accel, fn); } catch {}
  }
}
app.on('will-quit', () => globalShortcut.unregisterAll());

// Uma cópia só: abrir de novo traz a janela existente para frente (duas cópias disputariam a
// sala, a captura e o áudio). Perfis de teste (TELA_PROFILE) têm a própria trava.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

if (gotLock) app.whenReady().then(() => {
  installDisplayMediaHandler();
  startHelperHost();
  createWindow();
  setupTray();
  setupHotkeys();
  setupAutoUpdate();
});

app.on('window-all-closed', () => {
  quitting = true;
  if (helperHost) helperHost.postMessage({ type: 'quit' });
  app.quit();
});
