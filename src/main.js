const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, shell, session,
  utilityProcess, MessageChannelMain, Tray, Menu, globalShortcut, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

// registro do processo principal: na memória (diagnóstico) e em arquivo, para sobreviver a
// um fechamento inesperado (userData/logs/tela-amigos.log, com rodízio em ~1 MB)
const mainLog = [];
let logFile = null;
let logWrites = 0;
function writeLogLine(line) {
  mainLog.push(line);
  if (mainLog.length > 400) mainLog.shift();
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'tela-amigos.log');
      try { if (fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, `${logFile}.1`); } catch {}
    }
    fs.appendFileSync(logFile, line + '\n');
    if (++logWrites % 500 === 0 && fs.statSync(logFile).size > 2_000_000) { fs.renameSync(logFile, `${logFile}.1`); }
  } catch {}
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    writeLogLine(`${new Date().toISOString()} [${level}] ${args.map((a) => (a && a.stack) || String(a)).join(' ')}`);
    orig(...args);
  };
}
process.on('uncaughtException', (e) => console.error('erro não tratado no processo principal:', e));
process.on('unhandledRejection', (e) => console.error('promessa rejeitada no processo principal:', e));

const SIGNAL_PORT = Number(process.env.TELA_PORT) || 47800;
// aberto junto com o Windows: começa só no ícone da bandeja
const STARTED_HIDDEN = process.argv.includes('--hidden');

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

// envio protegido: durante uma recarga/queda da página o send lança erro
const safeSend = (wc, ...args) => { try { if (wc && !wc.isDestroyed()) wc.send(...args); } catch {} };
const toRenderer = (channel, data) => { if (win && !win.isDestroyed()) safeSend(win.webContents, channel, data); };

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
let updateReady = false; // atualização baixada (instala ao fechar)
let recoveredFrom = null; // motivo da última queda da interface (mostrado depois de recarregar)

// processos auxiliares do Chromium (placa de vídeo, áudio...) que caem também ficam registrados
app.on('child-process-gone', (_e, d) => {
  if (d.reason !== 'clean-exit') console.error(`processo "${d.type}" caiu: ${d.reason} (código ${d.exitCode})${d.name ? ' ' + d.name : ''}`);
});
ipcMain.handle('app:recovered', () => { const r = recoveredFrom; recoveredFrom = null; return r; });
function readLogTail(n) {
  try {
    let text = fs.readFileSync(logFile, 'utf8');
    if (text.split('\n').length < n) { try { text = fs.readFileSync(`${logFile}.1`, 'utf8') + text; } catch {} }
    return text.split('\n').slice(-n).join('\n');
  } catch { return mainLog.join('\n'); }
}

// AudioHelper.exe: o instalador da atualização fecha À FORÇA tudo o que roda da pasta do app, e
// matar o helper no meio de uma captura de áudio derruba o serviço de áudio do Windows. Antes de
// instalar, confere pelo pid que ele terminou.
let audioHelperPid = 0;
function audioHelperAlive() {
  if (!audioHelperPid) return false;
  try { process.kill(audioHelperPid, 0); return true; } catch { return false; }
}
async function waitAudioHelperGone(ms) {
  const end = Date.now() + ms;
  while (audioHelperAlive() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return !audioHelperAlive();
}
function waitHelperHostExit(ms) {
  if (!helperHost) return Promise.resolve();
  return new Promise((resolve) => {
    helperHost.once('exit', resolve);
    helperHost.postMessage({ type: 'quit' });
    setTimeout(resolve, ms);
  });
}

function startHelperHost() {
  helperHost = utilityProcess.fork(path.join(__dirname, 'helper-host.js'), [], { serviceName: 'Tela Amigos Helper' });
  helperHost.postMessage({ type: 'config', exe: helperPath(), selfPid: process.pid });
  helperHost.on('message', (m) => {
    if (m && m.type === 'helper-pid') audioHelperPid = m.pid || 0;
    if (m && m.type === 'boost-result') console.log(`prioridade de GPU (4=alta, 3=acima do normal, -1=falhou): ${JSON.stringify(m.result)}`);
  });
  helperHost.on('exit', (code) => {
    helperHost = null;
    if (quitting) return;
    console.error(`processo do helper caiu (código ${code}); reiniciando`);
    boostedKey = ''; // o helper novo precisa reaplicar a prioridade de GPU
    // caiu: sobe de novo e reconecta a interface
    setTimeout(() => { if (quitting) return; startHelperHost(); connectRendererToHelper(); }, 500);
    toRenderer('helper:restarted', null);
  });
}

// ---------------------------------------------------------------- prioridade (jogo pesado aberto)
// Com um jogo usando a placa de vídeo/CPU ao máximo, o Windows deixa o app por último e as
// telas dos amigos engasgam. Sobe a prioridade de CPU (acima do normal) dos processos do app e
// pede ao helper para subir a prioridade de GPU deles. Refeito quando surgem processos novos.
let boostedKey = '';
function applyPriority() {
  try {
    const procs = app.getAppMetrics().filter((m) => ['Browser', 'GPU', 'Tab', 'Utility'].includes(m.type));
    const pids = procs.map((m) => m.pid);
    const key = pids.slice().sort().join(',');
    if (key === boostedKey) return;
    boostedKey = key;
    for (const pid of pids) { try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {} }
    if (helperHost) helperHost.postMessage({ type: 'boost', pids });
    console.log(`prioridade elevada: ${procs.map((m) => `${m.type}${m.serviceName ? '/' + m.serviceName : ''}=${m.pid}`).join(' ')}`);
  } catch (e) { console.warn('prioridade:', e.message); }
}

function connectRendererToHelper() {
  if (!helperHost || !win || win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  // a página pode estar no meio de uma recarga: aí o did-finish-load reconecta depois
  try {
    win.webContents.postMessage('helper:port', null, [port2]);
    helperHost.postMessage({ type: 'port' }, [port1]);
  } catch (e) { console.warn('canal com o helper fica para depois da recarga:', e.message); }
}

// Tema escolhido na interface (ver renderer/themes.js): a barra de título, que é do Windows, acompanha
// a cor do tema. Fica guardado para a janela já abrir na cor certa da próxima vez.
const themeFile = () => path.join(app.getPath('userData'), 'tema.json');
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
// altura da faixa dos botões da janela: a de sempre, ou a que o tema pedir (o topo de alguns é mais baixo)
const barHeight = (h) => (Number.isInteger(h) && h >= 28 && h <= 64 ? h : 56);
function savedTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(themeFile(), 'utf8'));
    if (isColor(t.color) && isColor(t.symbol)) return t;
  } catch {}
  return { color: '#0e0f13', symbol: '#c9cdd8' };
}
// tema em uso: as janelas por cima do monitor (mãozinha, desenhos, emotes) desenham no jeito dele
let fxTheme = String(savedTheme().id || 'classico');
ipcMain.on('theme:set', (_e, t) => {
  if (!t || !isColor(t.color) || !isColor(t.symbol)) return;
  fxTheme = String(t.id || 'classico').slice(0, 30);
  try {
    if (win && !win.isDestroyed()) {
      win.setTitleBarOverlay({ color: t.color, symbolColor: t.symbol, height: barHeight(t.height) });
      win.setBackgroundColor(t.color);
    }
  } catch (e) { console.warn('tema da janela:', e.message); }
  const cur = savedTheme();
  if (cur.color !== t.color || cur.symbol !== t.symbol || cur.id !== fxTheme || barHeight(cur.height) !== barHeight(t.height)) {
    try { fs.writeFileSync(themeFile(), JSON.stringify({ id: fxTheme, color: t.color, symbol: t.symbol, height: barHeight(t.height) })); } catch {}
  }
});

// Captura da janela pedida pelo script de teste. Com a janela escondida a página só é redesenhada
// quando alguém pede uma captura, então a primeira depois de uma mudança ainda mostra a tela de antes:
// repete até vir duas iguais seguidas (ou cinco tentativas) e grava a última.
async function testShot(file) {
  let last = null;
  let img = null;
  for (let i = 0; i < 5; i++) {
    img = await win.webContents.capturePage();
    const bmp = img.toBitmap();
    if (last && Buffer.compare(last, bmp) === 0) break;
    last = bmp;
    await new Promise((r) => setTimeout(r, 120));
  }
  fs.writeFileSync(file, img.toPNG());
}

function createWindow() {
  const theme = savedTheme();
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: theme.color,
    title: 'Tela Amigos',
    show: !process.env.TELA_TEST_HIDDEN && !STARTED_HIDDEN, // teste sem janela; com o Windows: só na bandeja
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    // barra de título integrada: o topo do app vira a área de arrastar e os botões do Windows
    // (minimizar/maximizar/fechar) ficam no canto, na cor do app
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.color, symbolColor: theme.symbol, height: barHeight(theme.height) },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.on('closed', () => {
    for (const w of [...overlays]) { try { w.destroy(); } catch {} }
    for (const id of [...handWins.keys()]) destroyHand(id);
    if (trailWin && !trailWin.isDestroyed()) trailWin.destroy();
    if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
  });
  // a cada carregamento (inclusive recarga) a página ganha um canal novo com o helper
  win.webContents.on('did-finish-load', connectRendererToHelper);
  // a interface travou/fechou (falta de memória, placa de vídeo reiniciada...): registra e
  // recarrega sozinha em vez de deixar a janela branca/fechada
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`interface caiu: ${details.reason} (código ${details.exitCode})`);
    if (details.reason === 'clean-exit') return;
    recoveredFrom = details.reason;
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.webContents.on('unresponsive', () => console.warn('interface sem responder'));
  win.webContents.on('responsive', () => console.warn('interface voltou a responder'));
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
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setAlwaysOnTop(true, 'screen-saver'); // por cima de jogo em tela cheia sem bordas
    child.setAspectRatio(16 / 9);
    child.locked = false;
    overlays.add(child);
    child.on('closed', () => overlays.delete(child));
  });
  // avisos/erros da interface também vão para o arquivo de registro (sobrevivem se ela cair)
  if (!process.env.TELA_TEST_SCRIPT) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') writeLogLine(`${new Date().toISOString()} [interface ${e.level}] ${String(e.message).slice(0, 2000)}`);
    });
  }
  // Teste automatizado (só com variável de ambiente): roda um script na página e mostra o console
  if (process.env.TELA_TEST_SCRIPT) {
    win.webContents.on('console-message', (e) => {
      console.log(`[page] ${e.message}`);
      const m = /^SHOT (.+)$/.exec(e.message); // o script de teste pede uma captura da janela
      if (m) testShot(m[1]).catch((err) => console.log(`[page] SHOTS ERRO captura: ${err.message}`));
    });
    if (process.env.TELA_TEST_ONTOP) {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.env.TELA_TEST_SIZE) { const [w, h] = process.env.TELA_TEST_SIZE.split('x').map(Number); win.setContentSize(w, h); win.setPosition(0, 0); }
      else win.maximize();
      win.focus();
    } else if (process.env.TELA_TEST_SIZE) {
      const [w, h] = process.env.TELA_TEST_SIZE.split('x').map(Number);
      win.setContentSize(w, h);
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

// O instalador de atualização fecha À FORÇA tudo que roda da pasta do app, inclusive o servidor
// da sala. Antes de instalar, anota que a sala estava aberta; ao abrir de novo, ela é reaberta
// sozinha (os amigos, que ficam tentando reconectar, voltam sozinhos).
const roomFile = () => path.join(app.getPath('userData'), 'sala-aberta.json');
let lastHostName = 'Sala';
async function rememberRoomForUpdate() {
  try {
    if ((await roomStatus()).running) fs.writeFileSync(roomFile(), JSON.stringify({ hostName: lastHostName, at: Date.now() }));
  } catch {}
}
async function restoreRoomAfterUpdate() {
  try {
    const j = JSON.parse(fs.readFileSync(roomFile(), 'utf8'));
    fs.unlinkSync(roomFile());
    if (Date.now() - j.at > 30 * 60 * 1000) return; // só logo depois da atualização
    const r = await startRoomServer(j.hostName);
    console.log(`sala reaberta depois da atualização: ${JSON.stringify(r)}`);
  } catch {}
}

ipcMain.handle('host:start', (_e, hostName) => startRoomServer(hostName));
async function startRoomServer(hostName) {
  lastHostName = String(hostName || 'Sala').slice(0, 30);
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'sala-nome.txt'), lastHostName); } catch {}
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
}

// Fecha a sala para todos (o "Sair" normal não fecha mais)
ipcMain.handle('host:stop', () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: SIGNAL_PORT, path: '/shutdown', timeout: 1500, headers: { 'X-Tela-Amigos': '1' } },
    (res) => { res.resume(); resolve(true); });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
}));

// getDisplayMedia: o renderer escolhe a fonte no nosso seletor e avisa aqui antes de chamar.
let pendingSourceId = null;
ipcMain.handle('capture:select', (_e, id) => { pendingSourceId = id; });
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const types = pendingSourceId && pendingSourceId.startsWith('window') ? ['window'] : ['screen'];
      const all = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
      const src = all.find((s) => s.id === pendingSourceId) || all[0];
      callback(src ? { video: src } : {});
    } catch (e) {
      console.warn('getDisplayMedia:', e.message);
      callback({}); // sem resposta a captura ficaria esperando para sempre
    } finally {
      pendingSourceId = null;
    }
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

// Escolher uma área da tela: janela transparente sobre o monitor inteiro; a pessoa arrasta um
// retângulo. Devolve a área em frações do monitor (0..1), ou null se cancelar.
let regionWin = null;
ipcMain.handle('region:pick', (_e, displayId) => new Promise((resolve) => {
  if (regionWin && !regionWin.isDestroyed()) regionWin.destroy(); // a anterior resolve como "cancelou"
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  const b = d.bounds;
  // a janela do app sai da frente se estiver nesse monitor (para ver o que tem embaixo)
  const appOnIt = win && !win.isDestroyed() && !win.isMinimized() &&
    screen.getDisplayMatching(win.getBounds()).id === d.id;
  if (appOnIt) win.minimize();
  let result = null;
  const w = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: true, resizable: false,
    movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'region-preload.js'), contextIsolation: true, sandbox: true },
  });
  regionWin = w;
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setBounds(b); // garante o monitor inteiro mesmo com escalas diferentes
  w.loadFile(path.join(__dirname, 'renderer', 'region.html'), { query: { tema: fxTheme } }); // nas cores do tema escolhido
  w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
  const onDone = (ev, rect) => {
    if (w.isDestroyed() || ev.sender !== w.webContents) return; // resposta de outra janela
    const ok = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0.02 && rect.h > 0.02;
    result = ok ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), w: Math.min(1, rect.w), h: Math.min(1, rect.h) } : null;
    w.close();
  };
  ipcMain.on('region:done', onDone);
  w.on('closed', () => {
    ipcMain.removeListener('region:done', onDone);
    if (regionWin === w) regionWin = null;
    if (appOnIt && win && !win.isDestroyed()) { win.restore(); win.focus(); }
    resolve(result);
  });
}));

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
  autoUpdater.on('update-available', (info) => {
    if (info.version !== ready) toRenderer('update:status', { state: 'downloading', percent: 0, version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    if (manual && !ready) toRenderer('update:status', { state: 'latest', version: app.getVersion() });
    manual = false;
  });
  autoUpdater.on('download-progress', (p) => toRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version;
    updateReady = true;
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
  ipcMain.handle('update:install', async () => {
    if (quitting) return;
    quitting = true;
    // só instala depois que o helper parar a captura com calma (o instalador fecha à força o que
    // ainda estiver rodando da pasta do app)
    await waitHelperHostExit(13000);
    if (!(await waitAudioHelperGone(3000))) {
      // não terminou: NÃO roda o instalador agora (fica para a próxima vez que fechar o app)
      console.warn(`AudioHelper (pid ${audioHelperPid}) não terminou: atualização adiada`);
      autoUpdater.autoInstallOnAppQuit = false;
      quitting = false;
      if (!helperHost) { startHelperHost(); connectRendererToHelper(); }
      toRenderer('update:status', { state: 'error', message: 'o auxiliar de captura ainda estava fechando. Tente "Reiniciar e atualizar" de novo em alguns segundos' });
      return;
    }
    await rememberRoomForUpdate();
    quitPrepared = true; // helper já parado e sala anotada: a saída não precisa esperar de novo
    forceExitSoon(10000);
    autoUpdater.quitAndInstall(true, true);
  });
  updaterRef = autoUpdater;
}

ipcMain.handle('app:version', () => app.getVersion());
// cópia aberta por um script de teste: a tela de novidades não abre sozinha por cima do que o teste confere
ipcMain.handle('app:testing', () => !!process.env.TELA_TEST_SCRIPT);
// a codificação de vídeo pela placa está ligada no Chromium do app? ("enabled"; "disabled_software" quando ele a
// desliga, por exemplo depois de a placa travar) — vale para todas as transmissões, mesmo sem o nome do encoder
ipcMain.handle('gpu:status', () => {
  const st = app.getGPUFeatureStatus();
  return { video_encode: st.video_encode, video_decode: st.video_decode };
});
ipcMain.handle('app:autostart', (_e, on) => {
  if (!app.isPackaged) return false; // rodando pelo npm start: não mexe no Windows
  if (typeof on === 'boolean') app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
});
ipcMain.handle('app:started-hidden', () => STARTED_HIDDEN);

// ---- diagnóstico: junta tudo num .txt na Área de Trabalho e mostra o arquivo ----
async function buildDiag(rendererText) {
  let gpu = '';
  try { gpu = JSON.stringify(await app.getGPUInfo('basic'), null, 1).slice(0, 4000); } catch {}
  return [
    `Tela Amigos v${app.getVersion()} — diagnóstico ${new Date().toLocaleString('pt-BR')}`,
    `Windows ${os.release()} · ${os.cpus()[0] && os.cpus()[0].model} · ${os.cpus().length} núcleos · RAM ${Math.round(os.totalmem() / 1e9)} GB`,
    `Redes: ${JSON.stringify(localIPs())}`,
    `Sala neste PC: ${JSON.stringify(await roomStatus())}`,
    '', '===== interface =====', rendererText,
    '', '===== registro em arquivo (inclui sessões anteriores) =====', readLogTail(400),
    '', '===== placa de vídeo =====', gpu,
  ].join('\n');
}
ipcMain.handle('diag:build', (_e, rendererText) => buildDiag(String(rendererText || '')));
// opts.raw: texto pronto (diagnóstico que veio de um amigo); opts.name: nome dele no arquivo
ipcMain.handle('diag:save', async (_e, rendererText, opts = {}) => {
  const text = opts.raw ? String(rendererText).slice(0, 5_000_000) : await buildDiag(rendererText);
  const stamp = localIso().replace(/[:T]/g, '-').slice(0, 16);
  const who = opts.name ? '-' + String(opts.name).replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30) : '';
  const file = path.join(TEST_HIDDEN ? app.getPath('userData') : app.getPath('desktop'), `TelaAmigos-diagnostico${who}-${stamp}.txt`);
  fs.writeFileSync(file, '﻿' + text, 'utf8'); // com BOM: acentos certos em qualquer editor
  if (!TEST_HIDDEN) shell.showItemInFolder(file);
  return file;
});

// ---- clipes: salva o MP4 em Vídeos\Tela Amigos ----
ipcMain.handle('clip:save', (_e, name, buffer) => {
  const dir = videosDir();
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'tela').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30) || 'tela';
  const stamp = fileStamp();
  const file = path.join(dir, `clipe-${safe}-${stamp}.mp4`);
  fs.writeFileSync(file, Buffer.from(buffer));
  if (!TEST_HIDDEN) shell.showItemInFolder(file);
  return file;
});

// Data e hora DO PC para os nomes de arquivo. (Antes ia em UTC: no Brasil, um clipe salvo depois
// das 21h saía com a data do dia seguinte.)
function localIso() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString(); }
// com milissegundos: dois arquivos no mesmo segundo não se sobrescrevem
function fileStamp() { return localIso().replace(/[:T.]/g, '-').slice(0, 23); }
// clipes e gravações: Vídeos\Tela Amigos (no teste automático, dentro do perfil de teste)
const TEST_HIDDEN = !!process.env.TELA_TEST_HIDDEN;
function videosDir() {
  return TEST_HIDDEN ? path.join(app.getPath('userData'), 'videos') : path.join(app.getPath('videos'), 'Tela Amigos');
}

// ---- foto da tela: PNG em Imagens\Tela Amigos e copiada para colar (Discord etc.) ----
ipcMain.handle('shot:save', (_e, buffer, name) => {
  const buf = Buffer.from(buffer);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('imagem inválida');
  const dir = TEST_HIDDEN ? path.join(app.getPath('userData'), 'fotos') : path.join(app.getPath('pictures'), 'Tela Amigos');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'tela').replace(/[^\p{L}\p{N} _()-]/gu, '').slice(0, 40) || 'tela';
  const stamp = fileStamp();
  const file = path.join(dir, `foto-${safe}-${stamp}.png`);
  fs.writeFileSync(file, buf);
  // no teste automático não mexe na área de transferência de quem está usando o PC
  if (!TEST_HIDDEN) { try { clipboard.writeImage(nativeImage.createFromBuffer(buf)); } catch (e) { console.warn('copiar foto:', e.message); } }
  return file;
});

// Gravação longa: a interface manda pedaços do MP4 conforme codifica; vão direto para o disco
const recFiles = new Map(); // handle -> { fd, file }
let recSeq = 0;
ipcMain.handle('rec:open', (_e, name) => {
  const dir = videosDir();
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'tela').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30) || 'tela';
  const stamp = fileStamp();
  const file = path.join(dir, `gravacao-${safe}-${stamp}.mp4`);
  const handle = ++recSeq;
  recFiles.set(handle, { fd: fs.openSync(file, 'wx'), file }); // 'wx': nunca apaga uma gravação existente
  console.log(`gravação iniciada: ${file}`);
  return handle;
});
ipcMain.on('rec:write', (_e, handle, data, position) => {
  const r = recFiles.get(handle);
  if (!r) return;
  try {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    fs.writeSync(r.fd, buf, 0, buf.length, position);
  } catch (e) {
    console.error('gravação: falha ao escrever', e.message);
    toRenderer('rec:error', { handle, message: e.code === 'ENOSPC' ? 'disco cheio' : e.message });
  }
});
ipcMain.handle('rec:close', (_e, handle, empty) => {
  const r = recFiles.get(handle);
  if (!r) return null;
  recFiles.delete(handle);
  try { fs.closeSync(r.fd); } catch {}
  if (empty) { try { fs.unlinkSync(r.file); } catch {} return null; }
  console.log(`gravação salva: ${r.file}`);
  if (!TEST_HIDDEN) shell.showItemInFolder(r.file);
  return r.file;
});
app.on('will-quit', () => { for (const r of recFiles.values()) { try { fs.closeSync(r.fd); } catch {} } });

ipcMain.handle('window:focus', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// ---- janelas de sobreposição ----
const overlays = new Set();
let overlayKey = 'Ctrl+Shift+O'; // atalho que de fato ficou registrado (pode cair no plano B)
function setOverlayLock(w, locked) {
  if (!w || w.isDestroyed()) return;
  w.locked = locked;
  w.setIgnoreMouseEvents(locked, { forward: true }); // travada: cliques atravessam para o jogo
  safeSend(w.webContents, 'overlay:locked', locked, overlayKey);
}
ipcMain.on('overlay:lock', (e, locked) => setOverlayLock(BrowserWindow.fromWebContents(e.sender), !!locked));
// cadeado da janela travada: só enquanto o mouse está em cima dele a janela aceita clique
ipcMain.on('overlay:hover-unlock', (e, over) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed() || !w.locked) return;
  w.setIgnoreMouseEvents(!over, { forward: true });
});
function unlockAllOverlays() { for (const w of overlays) setOverlayLock(w, false); }
ipcMain.on('overlay:unlock-all', unlockAllOverlays);
ipcMain.on('overlay:opacity', (e, v) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setOpacity(Math.max(0.25, Math.min(1, Number(v) || 1)));
});
function toggleOverlayLocks() {
  if (!overlays.size) return;
  const anyUnlocked = [...overlays].some((w) => !w.locked);
  for (const w of overlays) setOverlayLock(w, anyUnlocked);
}

// ---- mãozinha no monitor de quem transmite ----
// Cada mão é uma JANELINHA pequena que acompanha o ponteiro (antes era uma janela do tamanho do
// monitor, que conflitava com mods do Windows como o Windhawk). Ela é DESTRUÍDA ao parar de
// apontar (escondida e mostrada de novo, o Windows exibia a imagem antiga: "fantasmas").
// Todas ficam por cima de tudo, não recebem cliques e ficam FORA da captura de tela.
const HAND_TIP = { x: 60, y: 50 };              // onde fica a ponta do dedo na janelinha
const handWins = new Map();                     // id de quem aponta -> { win, timer }
let trailWin = null, trailDisplay = null, trailTimer = null;

function displayById(displayId) {
  return screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
}
function overlayWindow(opts, file) {
  const w = new BrowserWindow({
    transparent: true, frame: false, skipTaskbar: true, focusable: false, resizable: false, movable: false,
    hasShadow: false, show: false, alwaysOnTop: true, thickFrame: false,
    webPreferences: { preload: path.join(__dirname, 'pointer-preload.js') },
    ...opts,
  });
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setContentProtection(true); // fora da captura: não aparece na transmissão
  w.loadFile(path.join(__dirname, 'renderer', file));
  return w;
}
function sendWhenReady(w, channel, data, show) {
  const go = () => {
    if (w.isDestroyed()) return;
    safeSend(w.webContents, channel, data);
    if (show && !w.isVisible()) w.showInactive();
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
}
function destroyHand(id) {
  const h = handWins.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  if (!h.win.isDestroyed()) h.win.destroy();
  handWins.delete(id);
}

ipcMain.on('pointer:show', (_e, p) => {
  if (!p || typeof p !== 'object') return;
  const d = displayById(p.displayId);
  // a posição vem do amigo (fração 0..1 da tela transmitida): fora disso a mãozinha iria parar em
  // outro monitor, e um número absurdo fazia a criação da janela lançar erro a cada movimento
  const frac = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  p = { ...p, x: frac(p.x), y: frac(p.y) };
  const px = Math.round(d.bounds.x + p.x * d.bounds.width - HAND_TIP.x);
  const py = Math.round(d.bounds.y + p.y * d.bounds.height - HAND_TIP.y);
  // noHand: a pessoa escondeu as mãozinhas mas quer ver os desenhos
  if (!p.noHand) {
    let h = handWins.get(p.id);
    if (!h || h.win.isDestroyed()) {
      h = { win: overlayWindow({ x: px, y: py, width: 240, height: 120 }, 'hand.html'), timer: null };
      handWins.set(p.id, h);
    } else {
      h.win.setPosition(px, py);
    }
    sendWhenReady(h.win, 'pointer', { ...p, theme: fxTheme }, true);
    clearTimeout(h.timer);
    h.timer = setTimeout(() => destroyHand(p.id), 1500);
  } else destroyHand(p.id);

  // rastro (Shift): só aí usa uma janela do tamanho do monitor, destruída logo depois
  if (p.drawing) {
    if (!trailWin || trailWin.isDestroyed() || trailDisplay !== d.id) {
      if (trailWin && !trailWin.isDestroyed()) trailWin.destroy();
      trailWin = overlayWindow({ ...d.bounds }, 'pointer.html');
      trailDisplay = d.id;
    }
    sendWhenReady(trailWin, 'pointer', { ...p, trailOnly: true, theme: fxTheme }, true);
    clearTimeout(trailTimer);
    // não fecha antes de os traços da caneta apagarem
    trailTimer = setTimeout(() => { if (trailWin && !trailWin.isDestroyed()) trailWin.destroy(); trailWin = null; },
      Math.max(3000, trailDeadline - Date.now()));
  } else if (trailWin && !trailWin.isDestroyed()) {
    sendWhenReady(trailWin, 'pointer', { ...p, trailOnly: true, drawing: false, theme: fxTheme }, false);
  }
});
ipcMain.on('pointer:hide', (_e, id) => destroyHand(id));

// Emote na minha tela: sobe no meu monitor (mesma janela transparente do rastro/caneta)
ipcMain.on('react:show', (_e, p) => {
  const d = displayById(p.displayId);
  if (!trailWin || trailWin.isDestroyed() || trailDisplay !== d.id) {
    if (trailWin && !trailWin.isDestroyed()) trailWin.destroy();
    trailWin = overlayWindow({ ...d.bounds }, 'pointer.html');
    trailDisplay = d.id;
    trailDeadline = 0;
  }
  sendWhenReady(trailWin, 'pointer', { react: String(p.emoji).slice(0, 8), name: String(p.name || '').slice(0, 30), color: p.color, theme: fxTheme }, true);
  trailDeadline = Math.max(trailDeadline, Date.now() + 3000);
  clearTimeout(trailTimer);
  trailTimer = setTimeout(() => { if (trailWin && !trailWin.isDestroyed()) trailWin.destroy(); trailWin = null; }, trailDeadline - Date.now());
});

// Caneta: traços que ficam alguns segundos no meu monitor (mesma janela do rastro, mantida
// aberta até o último traço apagar)
let trailDeadline = 0;
ipcMain.on('ink:show', (_e, p) => {
  const d = displayById(p.displayId);
  if (p.clear) {
    if (trailWin && !trailWin.isDestroyed()) sendWhenReady(trailWin, 'pointer', { inkClear: true, id: p.id }, false);
    return;
  }
  if (!trailWin || trailWin.isDestroyed() || trailDisplay !== d.id) {
    if (trailWin && !trailWin.isDestroyed()) trailWin.destroy();
    trailWin = overlayWindow({ ...d.bounds }, 'pointer.html');
    trailDisplay = d.id;
    trailDeadline = 0;
  }
  sendWhenReady(trailWin, 'pointer', { inkSegs: p.segs, color: p.color, life: p.life, id: p.id, theme: fxTheme }, true);
  trailDeadline = Math.max(trailDeadline, Date.now() + (Number(p.life) || 8000) + 500);
  clearTimeout(trailTimer);
  trailTimer = setTimeout(() => { if (trailWin && !trailWin.isDestroyed()) trailWin.destroy(); trailWin = null; }, trailDeadline - Date.now());
});

// ---- ícone na bandeja: status da sala e atalhos ----
let tray = null;
let trayStatus = { room: '', people: [], sharing: false };
// ícone com bolinha: vermelha = você ao vivo, verde = algum amigo ao vivo
const trayIcons = {};
function trayIcon(kind) {
  if (trayIcons[kind]) return trayIcons[kind];
  const base = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png'));
  let img = base.resize({ width: 32, height: 32, quality: 'best' });
  if (kind !== 'none') {
    const bmp = Buffer.from(img.toBitmap()); // BGRA
    const [r, g, b] = kind === 'me' ? [0xd0, 0x3b, 0x3b] : [0x0c, 0xc3, 0x0c];
    const cx = 24.5, cy = 24.5, rad = 7.5;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > rad + 0.5) continue;
        const i = (y * 32 + x) * 4;
        const ring = d > rad - 2; // anel escuro: a bolinha aparece em barra clara ou escura
        const a = Math.max(0, Math.min(1, rad + 0.5 - d));
        const [cr, cg, cb] = ring ? [0x16, 0x18, 0x1f] : [r, g, b];
        bmp[i] = Math.round(cb * a + bmp[i] * (1 - a));
        bmp[i + 1] = Math.round(cg * a + bmp[i + 1] * (1 - a));
        bmp[i + 2] = Math.round(cr * a + bmp[i + 2] * (1 - a));
        bmp[i + 3] = Math.max(bmp[i + 3], Math.round(255 * a));
      }
    }
    img = nativeImage.createFromBitmap(bmp, { width: 32, height: 32 });
  }
  trayIcons[kind] = img.resize({ width: 16, height: 16, quality: 'best' });
  trayIcons[kind].addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: img.toPNG() });
  return trayIcons[kind];
}
function updateTray() {
  if (!tray) return;
  const s = trayStatus;
  const people = (s.people || []).map((p) => (typeof p === 'string' ? { name: p, live: false } : p));
  const live = people.filter((p) => p.live);
  const kind = s.sharing ? 'me' : live.length ? 'friend' : 'none';
  try { tray.setImage(trayIcon(kind)); } catch (e) { console.warn('ícone da bandeja:', e.message); }
  tray.setToolTip(s.room
    ? (`Tela Amigos — sala ${s.room}${people.length ? `: ${people.map((p) => p.name).join(', ')}` : ''}` +
      `${s.sharing ? ' · você está ao vivo' : ''}${live.length ? ` · ao vivo: ${live.map((p) => p.name).join(', ')}` : ''}`).slice(0, 127)
    : 'Tela Amigos');
  const roomItems = s.room ? [
    { label: `Sala ${s.room}${s.sharing ? ' · você está ao vivo' : ''}`, enabled: false },
    ...(people.length
      ? people.map((p) => ({
          label: `${p.live ? '🟢' : '⚪'} ${p.name}${p.live ? ' — ao vivo (clique para assistir)' : ''}`,
          enabled: p.live,
          click: () => { ipcMain.emit('window:show'); toRenderer('hotkey', `focus:${p.name}`); },
        }))
      : [{ label: 'Ninguém mais na sala', enabled: false }]),
    { type: 'separator' },
  ] : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    ...roomItems,
    { label: 'Abrir Tela Amigos', click: () => ipcMain.emit('window:show') },
    { type: 'separator' },
    { label: s.sharing ? 'Parar de transmitir (Ctrl+Shift+S)' : 'Transmitir (Ctrl+Shift+S)', click: () => toRenderer('hotkey', 'share') },
    { label: 'Mutar/desmutar todos (Ctrl+Shift+M)', click: () => toRenderer('hotkey', 'mute') },
    { label: `Destravar sobreposições (${overlayKey})`, click: unlockAllOverlays },
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
ipcMain.on('tray:status', (_e, s) => { trayStatus = s && typeof s === 'object' ? s : trayStatus; updateTray(); });

function setupTray() {
  tray = new Tray(trayIcon('none'));
  tray.on('click', () => ipcMain.emit('window:show'));
  updateTray();
}

// ---- teclas de atalho globais (funcionam com o jogo em primeiro plano) ----
// Se outro programa já usa a tecla, o registro falha em silêncio: tenta um plano B e avisa
// a interface quais atalhos ficaram valendo.
const hotkeyResult = {};
function setupHotkeys() {
  const keys = {
    share: ['Control+Shift+S', 'Control+Alt+S'],
    mute: ['Control+Shift+M', 'Control+Alt+M'],
    'overlay-lock': ['Control+Shift+O', 'Control+Alt+O'],
    clip: ['Control+Shift+C', 'Control+Alt+C'],
  };
  for (const [action, options] of Object.entries(keys)) {
    const fn = action === 'overlay-lock' ? toggleOverlayLocks : () => toRenderer('hotkey', action);
    hotkeyResult[action] = null;
    for (const accel of options) {
      let ok = false;
      try { ok = globalShortcut.register(accel, fn); } catch {}
      if (ok) { hotkeyResult[action] = accel.replace('Control', 'Ctrl'); break; }
    }
    if (!hotkeyResult[action]) console.warn(`atalho de "${action}" ocupado por outro programa: ${options.join(' / ')}`);
  }
  overlayKey = hotkeyResult['overlay-lock'] || 'o cadeado';
  updateTray();
}
ipcMain.handle('hotkeys:get', () => hotkeyResult);
app.on('will-quit', () => { if (app.isReady()) globalShortcut.unregisterAll(); });

// Ao fechar, o processo TEM que terminar: se algo travar o encerramento (atualização, helper,
// janela perdida), sai à força depois de alguns segundos. Um processo "zumbi" sem janela
// segurava a trava de cópia única e o app parecia não abrir mais.
let exitWatchdog = null;
function forceExitSoon(ms = 6000) {
  if (exitWatchdog) return;
  exitWatchdog = setTimeout(() => { console.warn('encerramento travado: saindo à força'); app.exit(0); }, ms);
}
app.on('before-quit', () => forceExitSoon(20000));

// Uma cópia só: abrir de novo traz a janela existente para frente (duas cópias disputariam a
// sala, a captura e o áudio). Perfis de teste (TELA_PROFILE) têm a própria trava.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0); // sai na hora (app.quit aqui disparava eventos antes de o app estar pronto)
} else {
  app.on('second-instance', () => {
    // esta cópia ficou sem janela (fechamento travado ou janela perdida): abre de novo
    if (!win || win.isDestroyed()) {
      console.warn('abriram o app de novo e esta cópia estava sem janela: recriando');
      if (exitWatchdog) { clearTimeout(exitWatchdog); exitWatchdog = null; }
      quitting = false;
      quitPrepared = false;
      quitGen++;
      if (!helperHost) startHelperHost();
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Uma atualização às vezes deixava o atalho do Menu Iniciar apontando para a pasta temporária
// do instalador (que some): clicar nele não fazia nada. Ao abrir, confere e conserta os atalhos.
// Também põe o ícone dos atalhos num .ico próprio (pasta de dados do app): com o ícone dentro do
// .exe, o Windows às vezes guardava um ícone vazio do momento em que a atualização trocava o .exe,
// e a barra de tarefas ficava com uma folha em branco. Esse .ico nunca é trocado numa atualização.
function appIconFile() {
  const file = path.join(app.getPath('userData'), 'icone.ico');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
    const base = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png'));
    const imgs = [256, 64, 48, 32, 16].map((n) => ({ n, png: base.resize({ width: n, height: n, quality: 'best' }).toPNG() }));
    const head = Buffer.alloc(6 + 16 * imgs.length);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
    let offset = head.length;
    imgs.forEach((im, i) => {
      const o = 6 + 16 * i;
      head.writeUInt8(im.n >= 256 ? 0 : im.n, o); head.writeUInt8(im.n >= 256 ? 0 : im.n, o + 1);
      head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
      head.writeUInt32LE(im.png.length, o + 8); head.writeUInt32LE(offset, o + 12);
      offset += im.png.length;
    });
    fs.writeFileSync(file, Buffer.concat([head, ...imgs.map((im) => im.png)]));
    return file;
  } catch (e) { console.warn('ícone .ico:', e.message); return null; }
}

function repairShortcuts() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const exe = process.execPath;
  const ico = appIconFile();
  const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const places = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Tela Amigos.lnk'),
    path.join(app.getPath('desktop'), 'Tela Amigos.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Tela Amigos.lnk'),
  ];
  let changed = false;
  for (const lnk of places) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const cur = shell.readShortcutLink(lnk);
      const okTarget = same(cur.target, exe);
      if (okTarget && (!ico || same(cur.icon, ico))) continue;
      shell.writeShortcutLink(lnk, 'update', { target: exe, cwd: path.dirname(exe), icon: ico || exe, iconIndex: 0 });
      changed = true;
      if (!okTarget) console.warn(`atalho consertado: ${lnk} (apontava para ${cur.target})`);
    } catch (e) { console.warn('atalho:', e.message); }
  }
  if (changed) refreshIcons();
}

// Depois de uma atualização o Windows às vezes mostra o atalho/a barra de tarefas sem ícone (o
// cache de ícones ficou com o .exe antigo). Na 1ª abertura de cada versão, pede para recarregar.
function refreshIconsAfterUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const mark = path.join(app.getPath('userData'), 'icone-versao.txt');
  let last = '';
  try { last = fs.readFileSync(mark, 'utf8').trim(); } catch {}
  if (last === app.getVersion()) return;
  try { fs.writeFileSync(mark, app.getVersion()); } catch {}
  refreshIcons();
}
function refreshIcons() {
  try {
    const p = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe'), ['-show'], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => {});
  } catch {}
}

if (gotLock) app.whenReady().then(() => {
  installDisplayMediaHandler();
  setTimeout(repairShortcuts, 5000);
  setTimeout(refreshIconsAfterUpdate, 8000);
  if (!process.env.TELA_PROFILE) restoreRoomAfterUpdate();
  console.log(`Tela Amigos v${app.getVersion()} iniciando (Windows ${os.release()})`);
  // relatórios de travamento ficam só neste PC (nada é enviado)
  try { require('electron').crashReporter.start({ uploadToServer: false }); } catch {}
  startHelperHost();
  createWindow();
  setTimeout(applyPriority, 3000);
  setInterval(applyPriority, 15000);
  // cópias de teste (perfil próprio) não pegam atalhos globais nem a bandeja do app de verdade
  if (!process.env.TELA_PROFILE) {
    setupTray();
    setupHotkeys();
  }
  setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());

// Saída (por qualquer caminho: fechar a janela, "Sair" na bandeja, atualização ao fechar):
// antes, lembra a sala se uma atualização vai ser instalada e espera o helper encerrar a captura
// com calma. Só depois o app termina de verdade (forceExitSoon garante que não trava).
let quitPrepared = false;
let quitGen = 0; // abrir o app de novo durante o fechamento cancela o fechamento pendente
let updaterRef = null;
app.on('before-quit', (e) => {
  quitting = true;
  if (quitPrepared) return;
  quitPrepared = true;
  e.preventDefault();
  const gen = ++quitGen;
  (async () => {
    if (updateReady) await rememberRoomForUpdate();
    await waitHelperHostExit(13000);
    // atualização pronta mas o AudioHelper não terminou: não deixa o instalador matá-lo
    if (updateReady && !(await waitAudioHelperGone(3000)) && updaterRef) {
      console.warn(`AudioHelper (pid ${audioHelperPid}) não terminou: atualização fica para a próxima`);
      updaterRef.autoInstallOnAppQuit = false;
    }
  })().finally(() => {
    if (gen !== quitGen) return; // reabriram o app no meio: continua aberto
    app.quit();
  });
});
