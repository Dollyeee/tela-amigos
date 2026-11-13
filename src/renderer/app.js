/* Tela Amigos — renderer
 * Malha WebRTC: cada participante tem uma conexão direta com cada outro.
 * Cada conexão tem 1 transceiver de vídeo + 1 de áudio "sendonly" de cada lado,
 * criados desde o início; compartilhar/parar só troca a trilha (replaceTrack),
 * sem renegociar.
 */
const $ = (s) => document.querySelector(s);
let SIGNAL_PORT = 47800;
window.native.netInfo().then((i) => { SIGNAL_PORT = i.port; });
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // a sala online manda os dela (STUN + TURN)

// Sala online (sem Radmin): sinalização num servidor na internet (online-server/, Cloudflare).
// Entra-se com um código de 6 letras/números em vez do IP do Radmin.
const ONLINE_SERVER_DEFAULT = 'wss://tela-amigos.telaamigos-dolle.workers.dev';
function onlineServer() { return (localStorage.getItem('onlineServer') || ONLINE_SERVER_DEFAULT).replace(/\/+$/, ''); }
const ONLINE_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
function isOnlineCode(s) { return ONLINE_CODE_RE.test(String(s || '').toUpperCase()); }
function newOnlineCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((x) => A[x % A.length]).join('');
}

const state = {
  myId: null,
  myName: '',
  hostIp: '',
  ws: null,
  peers: new Map(),      // id -> Peer
  layout: 'grid',        // 'grid' | 'focus'
  focusId: null,
  order: [],             // ordem das telas ('me' ou id do peer)
  hidden: new Set(),     // telas ocultadas por mim
  showStats: false,
  pipId: null,
  meMini: localStorage.getItem('meMini') !== '0', // sua prévia no canto (padrão)
  leaving: false,
  share: null,           // { stream, video, audio, settings, sourceName }
  share2: null,          // 2ª tela (captura do Chromium): { stream, video, sourceName, source }
  hist: new Map(),       // nome do amigo -> histórico de qualidade (últimos 10 min)
  settings: {
    res: '1080', fps: 60, mode: 'motion', codec: 'auto', bitrate: 20, audio: 'all-except', engine: 'native',
  },
};

// ------------------------------------------------------------------ utilidades
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  const ms = kind === 'error' ? 12000 : 3500; // erros ficam mais tempo (dá para ler/tirar print)
  el.onclick = () => el.remove();
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

function fmtMbps(bps) { return `${(bps / 1e6).toFixed(1)} Mb/s`; }

function saveSettings() {
  localStorage.setItem('settings', JSON.stringify(state.settings));
}
function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem('settings') || '{}')); } catch {}
  // v1.0.27: o codec padrão virou "Automático" (H.265 quando os dois lados têm, senão H.264)
  if (localStorage.getItem('codecMigrated') !== '1') {
    if (state.settings.codec === 'H264') state.settings.codec = 'auto';
    localStorage.setItem('codecMigrated', '1');
    saveSettings();
  }
}

// ------------------------------------------------------------------ registro (vai no diagnóstico)
const appLog = [];
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    appLog.push(`${new Date().toISOString()} [${level}] ${args.map((a) => (a && a.stack) || (typeof a === 'object' ? safeJson(a) : String(a))).join(' ')}`);
    if (appLog.length > 600) appLog.shift();
    orig(...args);
  };
}
window.addEventListener('error', (e) => console.error('erro:', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('promessa rejeitada:', e.reason));
function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }

// Junta tudo o que ajuda a achar um problema e salva na Área de Trabalho
async function saveDiagnostics() {
  const file = await window.native.saveDiagnostics(await buildRendererDiag());
  toast(`Diagnóstico salvo na Área de Trabalho: ${file.split(/[\\/]/).pop()}. Mande esse arquivo.`);
}

async function buildRendererDiag() {
  const lines = [];
  const s = state.share;
  lines.push(`nome=${state.myName} id=${state.myId} sala=${state.hostIp} anfitriao=${!!state.isHost} layout=${state.layout}`);
  lines.push(`servidor de vídeo: sala=${state.sfuServer ? 'tem' : 'não tem'} opção=${localStorage.getItem('sfu') === '1' ? 'ligada' : 'desligada'} ` +
    `minhaTransmissão=${state.share && state.share.sfu ? 'pelo servidor' : '-'} motivo=${(state.share && state.share.sfuAuto && state.share.sfuAuto.why) || '-'} ` +
    `conexão=${window.Sfu.state()} últimoErro=${state.sfuLastErr || '-'}`);
  try { for (const l of await window.Sfu.stats()) lines.push(`  ${l}`); } catch {}
  lines.push(`config=${safeJson(state.settings)}`);
  try { const g = await window.native.gpuStatus(); lines.push(`placa no Chromium: codificar=${g.video_encode} decodificar=${g.video_decode}`); } catch {}
  lines.push(`transmitindo=${!!s}${s ? ` fonte="${s.sourceName}" nativo=${s.native} direto=${s.direct} ${s.width}x${s.height} encoder=${s.encoder} pisoQP=${s.minQp || 'sem'} modoLeve=${!!state.lightMode}` +
    ` codificacao=${s.direct ? 'helper' : s.encSeen || '?'}${s.soft ? ` NO PROCESSADOR (${s.soft})` : ''}` : ''}`);
  if (s && s.direct) {
    lines.push(`versão leve: ${s.videoLight ? `ligada ${s.lightKbps} kb/s; recebem: ${[...state.peers.values()].filter((p) => p.sendLayer === 1).map((p) => `${p.name}${Date.now() < (p.weakUntil || 0) ? ' (rede fraca)' : ''}`).join(', ') || 'ninguém'}`
      : `desligada${window.NativeVideo.dbg.lightErr ? ` (${window.NativeVideo.dbg.lightErr})` : ''}`}`);
  }
  if (state.nativeStats) lines.push(`helper=${safeJson(state.nativeStats)}`);
  if (s && s.direct) {
    lines.push(`bitrate da direta: alvo=${state.nativeKbps} kb/s rede=${state.netInfo.level}${state.netInfo.why ? ` (${state.netInfo.why})` : ''} ` +
      `bandaEstimadaMín=${state.netInfo.avail ? Math.round(state.netInfo.avail) : '?'} kb/s`);
    lines.push(`envio por amigo (último segundo)=${safeJson(window.NativeVideo.lastStats || {})}`);
  }
  lines.push(`jogando=${!!state.gaming} (${state.gamingExe || ''})`);
  if (state.share2) lines.push(`segundaTela="${state.share2.sourceName}"`);
  for (const p of state.peers.values()) {
    lines.push('');
    lines.push(`--- ${p.name} (id ${p.id}) conn=${p.pc.connectionState} ice=${p.pc.iceConnectionState} sinal=${p.pc.signalingState} ` +
      `compartilhando=${p.sharing} servidor=${p.sfuIn ? 'recebendo' : p.sfuPub ? 'disponível' : '-'}${p.sfuPulling ? ' (ele recebe minha tela pelo servidor)' : ''} rota=${p.route || '?'} caminho=${p.routePath || '?'} rotaUso=${p.routeUse || '-'} rotaPref=${p.routePref || '-'} qualidade=${p.quality ? p.quality.level + ' ' + p.quality.reason : '?'} ` +
      `saude=${safeJson(p.health || {})} quer=${p.theyWant} pedi=${p.iWant} uploadMedido=${p.upMbps || '?'}Mb/s ` +
      `teto=${state.share ? perPeerMbps(state.share.settings.bitrate, p) : '-'}Mb/s h265=${p.h265} av1=${p.av1} codecDireta=${state.share ? state.share.codec : '-'} ` +
      `resolucaoPedida=${wantedMaxH(p) || 'original'} eleQuer=${p.theyWantH || 'original'} tela2=${p.share2 ? p.share2Name : '-'} quer2=${p.theyWant2 || 'off'} resInteligente=${p.smartH || 'cheia'}` +
      (p.net ? ` rede=${p.net.st.level}${p.net.st.why ? ` (${p.net.st.why})` : ''} pingNormal=${Math.round((p.net.st.base || 0) * 1000)}ms` +
        ` eleRecebe=${p.rxRep && performance.now() - p.rxRep.at < 5000 ? `${p.rxRep.kb}kb/s` : '?'}` : ''));
    const h = state.hist.get(p.name);
    if (h && h.length) {
      lines.push(`  histórico (${h.length} pontos, 2 s cada; t fps Mb/s ping perda% travadas causa):`);
      for (const x of h.slice(-150)) lines.push(`    ${new Date(x.t).toLocaleTimeString()} ${x.fps} ${x.mbps.toFixed(1)} ${x.rtt ?? '?'} ${(x.loss * 100).toFixed(1)} ${x.fz} ${x.level}${x.short ? ' ' + x.short : ''}`);
    }
    try {
      const rep = await p.pc.getStats();
      rep.forEach((r) => {
        if (r.type === 'inbound-rtp' || r.type === 'outbound-rtp' || r.type === 'remote-inbound-rtp' ||
            (r.type === 'candidate-pair' && r.nominated)) {
          const keep = ['kind', 'framesPerSecond', 'frameWidth', 'frameHeight', 'packetsLost', 'packetsReceived', 'packetsSent',
            'nackCount', 'pliCount', 'freezeCount', 'framesDropped', 'keyFramesDecoded', 'qualityLimitationReason',
            'encoderImplementation', 'decoderImplementation', 'currentRoundTripTime', 'availableOutgoingBitrate',
            'fractionLost', 'roundTripTime', 'jitter', 'bytesReceived', 'bytesSent', 'state'];
          const o = {};
          for (const k of keep) if (r[k] !== undefined) o[k] = r[k];
          lines.push(`  ${r.type}: ${safeJson(o)}`);
        }
      });
    } catch {}
  }
  // áudio: o que o helper vê tocando e o que está capturando (ex.: som do jogo não chega)
  try {
    const t0 = performance.now();
    const l = await window.Helper.list();
    const ms = Math.round(performance.now() - t0);
    lines.push('', '===== áudio =====');
    if (l.type === 'error') lines.push(`helper NÃO respondeu à lista de programas (${l.message})`);
    else {
      lines.push(`helper respondeu em ${ms} ms · opção de som="${state.settings.audio}" · enviando som=${!!(state.share && state.share.audio)}`);
      lines.push(`programas com som aberto: ${(l.apps || []).map((a) => `${a.name} [${a.exe} pid ${a.pid}${a.discord ? ' DISCORD' : ''}]`).join(' · ') || 'nenhum'}`);
      lines.push(`saídas de som: ${(l.devices || []).map((d) => `${d.name}${d.isDefault ? ' (padrão)' : ''}${d.self ? ' [o app toca aqui]' : ''}`).join(' · ') || '?'}`);
    }
    if (state.share && state.share.audio) {
      const m = await window.Helper.mixerApps();
      lines.push(`capturando agora: ${m.type === 'error' ? 'sem resposta' : (m.apps || []).map((a) => `${a.name} [${a.exe} pid ${a.pid}]`).join(' · ') || 'nada'}`);
    }
  } catch {}
  try {
    const d = await window.Helper.diag();
    lines.push('', `placas/encoders: ${safeJson(d.info || d)}`);
  } catch {}
  lines.push('', '===== registro =====', ...appLog);
  return lines.join('\n');
}

// ------------------------------------------------------------------ diagnóstico dos amigos
// "Pedir diagnóstico": o amigo monta o diagnóstico completo dele e manda pelo canal de dados
// (em pedaços); chega aqui salvo na Área de Trabalho com o nome dele.
const diagIn = new Map(); // id do amigo -> { parts, n, timer }
function requestDiag(peer) {
  if (!peer.dc || peer.dc.readyState !== 'open') { toast(`Sem conexão direta com ${peer.name} agora.`, 'error'); return; }
  if (diagIn.has(peer.id)) return;
  try { dcSend(peer, { t: 'diag-req' }); } catch (e) { toast(e.message, 'error'); return; }
  const timer = setTimeout(() => {
    diagIn.delete(peer.id);
    toast(`${peer.name} não respondeu ao pedido de diagnóstico (ele precisa estar na versão nova).`, 'error');
  }, 45000);
  diagIn.set(peer.id, { parts: [], n: 0, timer });
  toast(`Pedindo o diagnóstico de ${peer.name}...`);
}
// viaRelay: o pedido veio pela sala (a conexão direta com quem pediu pode ser justamente o problema)
async function sendMyDiag(peer, viaRelay) {
  toast(`${peer.name} pediu o seu diagnóstico (para achar problemas). Enviando...`);
  const text = await window.native.buildDiagnostics(await buildRendererDiag());
  // pela sala cada mensagem tem limite (64 KB): pedaços menores e sem pressa
  const CH = viaRelay ? 15000 : 60000, n = Math.max(1, Math.ceil(text.length / CH));
  for (let i = 0; i < n; i++) {
    const part = { i, n, data: text.slice(i * CH, (i + 1) * CH) };
    if (viaRelay) { sendRelay(peer.id, { kind: 'diag-part', ...part }); await new Promise((r) => setTimeout(r, 60)); continue; }
    dcSend(peer, { t: 'diag-part', ...part });
    while (peer.dc.bufferedAmount > (1 << 20)) await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- Diagnóstico da sala: o meu e o de todos os amigos num arquivo só, com um resumo dos erros
// de cada um no começo. Pede pela conexão direta e, se ela estiver fechada, pela sala.
let roomDiag = null; // { pending: Set(id), parts: Map(id -> []), got: Map(id -> texto), done() }
async function requestRoomDiag() {
  if (roomDiag) { toast('Já estou juntando o diagnóstico da sala...'); return; }
  const peers = [...state.peers.values()];
  toast(peers.length ? `Juntando o diagnóstico de todos (${peers.length + 1} pessoas, até 1 min)...` : 'Juntando o diagnóstico...');
  const rd = roomDiag = { pending: new Set(peers.map((p) => p.id)), parts: new Map(), got: new Map(), names: new Map(peers.map((p) => [p.id, p.name])) };
  try {
    const finished = new Promise((resolve) => { rd.done = resolve; });
    for (const p of peers) {
      let direct = false;
      try { if (p.dc && p.dc.readyState === 'open') { dcSend(p, { t: 'diag-req' }); direct = true; } } catch {}
      if (!direct) sendRelay(p.id, { kind: 'diag-req' });
    }
    const mine = await window.native.buildDiagnostics(await buildRendererDiag());
    if (rd.pending.size) await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
    const people = [{ name: `${state.myName} (eu)`, text: mine }];
    for (const [id, name] of rd.names) people.push({ name, text: rd.got.get(id) || null });
    const head = (t) => (t ? t.split('\n', 1)[0] : '');
    const problems = (t) => t.split('\n').filter((l) => !/prioridade|\[page\] SMOKE/.test(l) && /\[(interface)?(warning|error)\]|FALHOU|falhou|caiu|travou|parada|perdida/.test(l)).slice(-40);
    const out = [
      `Diagnóstico da sala ${state.hostIp || ''} — ${new Date().toLocaleString('pt-BR')}`,
      `Pessoas: ${people.map((p) => `${p.name}: ${p.text ? head(p.text).replace(/ — diagnóstico.*/, '') : 'NÃO RESPONDEU'}`).join(' · ')}`,
      '', '===== RESUMO: avisos e erros recentes de cada um =====',
    ];
    for (const p of people) {
      out.push('', `--- ${p.name} ---`);
      if (!p.text) { out.push('  não respondeu (versão antiga, sem conexão ou app fechado)'); continue; }
      const pr = problems(p.text);
      out.push(...(pr.length ? pr.map((l) => '  ' + l) : ['  nenhum aviso']));
    }
    for (const p of people) if (p.text) out.push('', '', `##################### ${p.name} #####################`, p.text);
    const file = await window.native.saveDiagnostics(out.join('\n'), { raw: true, name: 'sala' });
    const missing = people.filter((p) => !p.text).map((p) => p.name);
    toast(`Diagnóstico da sala salvo na Área de Trabalho: ${file.split(/[\\/]/).pop()}` + (missing.length ? ` (sem resposta de ${missing.join(', ')})` : ''));
  } finally { roomDiag = null; }
}

async function onDiagPart(peer, m) {
  // parte do diagnóstico da sala
  const rd = roomDiag;
  if (rd && rd.pending.has(peer.id)) {
    if (!Number.isInteger(m.i) || !Number.isInteger(m.n) || m.n > 400 || m.i < 0 || m.i >= m.n) return;
    const parts = rd.parts.get(peer.id) || [];
    rd.parts.set(peer.id, parts);
    parts[m.i] = String(m.data || '');
    if (parts.filter((x) => x != null).length < m.n) return;
    rd.got.set(peer.id, parts.join(''));
    rd.pending.delete(peer.id);
    if (!rd.pending.size && rd.done) rd.done();
    return;
  }
  const d = diagIn.get(peer.id);
  if (!d || !Number.isInteger(m.i) || !Number.isInteger(m.n) || m.n > 200 || m.i < 0 || m.i >= m.n) return;
  d.parts[m.i] = String(m.data || '');
  d.n = m.n;
  if (d.parts.filter((x) => x != null).length < m.n) return;
  clearTimeout(d.timer);
  diagIn.delete(peer.id);
  const file = await window.native.saveDiagnostics(d.parts.join(''), { raw: true, name: peer.name });
  toast(`Diagnóstico de ${peer.name} salvo na Área de Trabalho: ${file.split(/[\\/]/).pop()}`);
}

// ------------------------------------------------------------------ sons de aviso
// Tons curtos gerados na hora (sem arquivos). Volume baixo para não atrapalhar o jogo/voz.
const Sfx = (() => {
  let ctx = null;
  const tones = { join: [660, 880], leave: [700, 470], share: [523, 659, 784], chat: [990] };
  return {
    play(kind) {
      if (localStorage.getItem('sounds') === '0') return;
      try {
        ctx = ctx || new AudioContext();
        const notes = tones[kind] || [];
        notes.forEach((f, i) => {
          const t = ctx.currentTime + i * 0.09;
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.05, t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          osc.connect(g).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.18);
        });
      } catch {}
    },
  };
})();

// ------------------------------------------------------------------ lobby
async function initLobby() {
  loadSettings();
  $('#name').value = localStorage.getItem('name') || '';
  const paintMyName = () => {
    const n = $('#name').value.trim();
    document.documentElement.style.setProperty('--me-name', `"${n.replace(/[\\"]/g, '\\$&')}"`);
    document.documentElement.classList.toggle('has-name', !!n);
  };
  $('#name').addEventListener('input', paintMyName);
  paintMyName();
  window.paintMyName = paintMyName;
  $('#host-ip').value = localStorage.getItem('hostIp') || '';

  $('#btn-host').onclick = async () => {
    if (!checkName()) return;
    $('#btn-host').disabled = true;
    const res = await window.native.hostStart(state.myName); // reaproveita a sala se já estiver aberta
    $('#btn-host').disabled = false;
    if (!res.ok) return showLobbyError(res.error);
    const info = await window.native.netInfo();
    const radmin = info.ips.find((x) => x.radmin) || info.ips[0];
    state.hostIp = radmin ? radmin.ip : '127.0.0.1';
    state.isHost = true;
    localStorage.setItem('lastRole', 'host');
    connect('127.0.0.1', true);
  };
  $('#btn-host-online').onclick = () => {
    if (!checkName()) return;
    if (!onlineServer()) return showLobbyError('Sala online ainda não está disponível nesta versão.');
    const code = newOnlineCode();
    $('#host-ip').value = code;
    localStorage.setItem('hostIp', code);
    localStorage.setItem('lastRole', 'guest');
    state.hostIp = code;
    state.isHost = false;
    connect(code, false);
  };
  $('#btn-close-my-room').onclick = async () => {
    await window.native.hostStop();
    refreshMyRoom();
  };
  // (ligados aqui, uma vez só: antes ficavam dentro de refreshMyRoom, depois de uma espera, e o
  // "entrar sozinho" clicava no botão antes de ele ter o que fazer)
  $('#btn-join').onclick = () => {
    if (!checkName()) return;
    let ip = $('#host-ip').value.trim();
    if (isOnlineCode(ip)) {
      ip = ip.toUpperCase();
      if (!onlineServer()) return showLobbyError('Sala online ainda não está disponível nesta versão.');
    }
    if (!/^[\w.-]+$/.test(ip)) return showLobbyError('Digite o IP do Radmin de quem hospeda ou o código da sala online.');
    localStorage.setItem('hostIp', ip);
    localStorage.setItem('lastRole', 'guest');
    state.hostIp = ip;
    connect(ip, false);
  };
  $('#host-ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  refreshMyRoom();
  renderRooms();
  discoverLoop();
  autoJoinOnStart();
}

// Entrar sozinho na última sala ao abrir (opção). Quem hospedava reabre a própria sala; quem
// entrava tenta a sala de antes até ela aparecer (o PC de quem hospeda pode ligar depois).
async function autoJoinOnStart() {
  if (localStorage.getItem('autoJoin') !== '1') return;
  const name = (localStorage.getItem('name') || '').trim();
  if (!name) return;
  const role = localStorage.getItem('lastRole');
  const ip = localStorage.getItem('hostIp');
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    // para quando já entrou numa sala (o lobby some). A condição estava invertida desde a v1.0.30:
    // como o lobby começa visível, saía na primeira volta e a opção nunca fazia nada.
    if ($('#lobby').classList.contains('hidden') || Date.now() > deadline || localStorage.getItem('autoJoin') !== '1') return;
    // a pessoa começou a digitar outra sala: não fica voltando para a de antes
    if (role !== 'host' && ip && $('#host-ip').value.trim() && $('#host-ip').value.trim() !== ip) return;
    if (!$('#btn-join').disabled) {
      $('#name').value = name;
      if (role === 'host') { $('#btn-host').click(); }
      else if (ip) { joinRoom(ip); }
      else return;
    }
    await new Promise((r) => setTimeout(r, 20000));
    if (role === 'host') return; // a própria sala: uma tentativa basta
  }
}

// ------------------------------------------------------------------ salas abertas / recentes
let discovered = [];
function recentRooms() {
  try { return JSON.parse(localStorage.getItem('recentRooms') || '[]'); } catch { return []; }
}
function rememberRoom(ip, hostName) {
  const list = recentRooms().filter((r) => r.ip !== ip);
  list.unshift({ ip, hostName: hostName || ip, at: Date.now() });
  localStorage.setItem('recentRooms', JSON.stringify(list.slice(0, 5)));
}

// tira uma sala da lista (sala online aberta sem querer: ela fecha sozinha quando fica vazia)
function forgetRoom(ip) {
  localStorage.setItem('recentRooms', JSON.stringify(recentRooms().filter((r) => r.ip !== ip)));
  if (localStorage.getItem('hostIp') === ip) { localStorage.removeItem('hostIp'); if ($('#host-ip').value === ip) $('#host-ip').value = ''; }
  renderRooms();
}

function joinRoom(ip) {
  $('#host-ip').value = ip;
  $('#btn-join').click();
}

function renderRooms() {
  const ul = $('#rooms');
  ul.innerHTML = '';
  const seen = new Set();
  const row = (title, sub, ip, offline, closeLabel, names) => {
    const li = document.createElement('li');
    if (offline) li.classList.add('offline');
    const pile = document.createElement('span');
    pile.className = 'room-pile theme-only';
    li.style.setProperty('--h', nameHue((names && names[0]) || title));
    li.dataset.k = nameHue((names && names[0]) || title) % 4;
    li.dataset.f = Math.floor(nameHue((names && names[0]) || title) / 45); // e um de 0 a 7
    for (const n of (names || []).slice(0, 3)) pile.appendChild(avatar(n));
    li.appendChild(pile);
    const info = document.createElement('div');
    info.className = 'room-info';
    const t = document.createElement('span'); t.className = 'room-title'; t.textContent = title;
    // quem está na sala e o endereço em pedaços separados (alguns temas põem o endereço na frente); o texto é o de sempre
    const s = document.createElement('span'); s.className = 'room-sub';
    const sw = document.createElement('span'); sw.className = 'rs-who'; sw.textContent = sub[0];
    const ss = document.createElement('span'); ss.className = 'rs-sep'; ss.textContent = ' · ';
    const sa = document.createElement('span'); sa.className = 'rs-addr'; sa.textContent = sub[1];
    s.append(sw, ss, sa);
    info.append(t, s);
    const b = document.createElement('button');
    b.className = offline ? 'ghost' : 'primary';
    b.textContent = 'Entrar';
    b.onclick = () => { if (checkName()) joinRoom(ip); };
    li.append(info, b);
    if (closeLabel) {
      const x = document.createElement('button');
      x.className = 'link-btn danger-text room-close';
      x.textContent = closeLabel;
      x.title = isOnlineCode(ip) ? 'Tira a sala da lista. A sala online fecha sozinha quando não tem ninguém nela.' : 'Tira a sala da lista';
      x.onclick = () => forgetRoom(ip);
      li.appendChild(x);
    }
    ul.appendChild(li);
  };
  for (const r of discovered) {
    seen.add(r.ip);
    const who = r.members ? `${r.members} na sala: ${r.names.join(', ')}` : 'ninguém na sala ainda';
    row(`Sala de ${r.hostName}`, [who, r.ip], r.ip, false, '', r.names && r.names.length ? r.names : [r.hostName]);
  }
  for (const r of recentRooms()) {
    if (seen.has(r.ip)) continue;
    if (isOnlineCode(r.ip)) row(`Sala online de ${r.hostName}`, ['recente', `código ${r.ip}`], r.ip, false, 'Fechar');
    else row(`Sala de ${r.hostName}`, ['recente · não encontrada agora', r.ip], r.ip, true, 'Remover');
  }
  if (!ul.children.length) {
    const li = document.createElement('li');
    li.className = 'empty-rooms';
    li.textContent = 'Nenhuma sala encontrada na rede. Peça para alguém clicar em "Hospedar".';
    ul.appendChild(li);
  }
}

async function discoverLoop() {
  for (;;) {
    if (!$('#lobby').classList.contains('hidden')) {
      $('#rooms-searching').textContent = 'procurando...';
      discovered = await window.native.discoverRooms().catch(() => []);
      $('#rooms-searching').textContent = discovered.length ? `${discovered.length} encontrada(s)` : '';
      renderRooms();
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// Mostra no lobby se a sala deste PC continua aberta (ela não fecha junto com o app)
async function refreshMyRoom() {
  const st = await window.native.hostStatus().catch(() => ({ running: false }));
  const box = $('#my-room');
  box.classList.toggle('hidden', !st.running);
  $('#btn-host').textContent = st.running ? 'Entrar na minha sala' : 'Hospedar sala';
  if (st.running) {
    $('#my-room-text').textContent = st.members
      ? `Sua sala está aberta: ${st.names.join(', ')}`
      : 'Sua sala está aberta (vazia)';
  }
}

function checkName() {
  const name = $('#name').value.trim();
  if (!name) { showLobbyError('Digite seu nome.'); $('#name').focus(); return false; }
  state.myName = name;
  localStorage.setItem('name', name);
  return true;
}

function showLobbyError(msg) { $('#lobby-error').textContent = msg || ''; }

// ------------------------------------------------------------------ sinalização
// Conexão com a sala. Se cair depois de entrar, reconecta sozinho retomando o mesmo lugar
// (o vídeo, que vai direto entre os PCs, continua enquanto isso).
function connect(ip, isHost) {
  clearTimeout(reconnectTimer); // tentativa antiga de reconectar (outra sala) não pode voltar
  reconnectTimer = null;
  showLobbyError('');
  $('#btn-join').disabled = $('#btn-host').disabled = true;
  state.resume = null;
  openSocket(ip, false);
}

let heartbeat = null;
function openSocket(ip, reconnecting) {
  const online = isOnlineCode(ip);
  let ws;
  try {
    ws = new WebSocket(online ? `${onlineServer()}/sala/${ip.toUpperCase()}` : `ws://${ip}:${SIGNAL_PORT}`);
  } catch (e) {
    $('#btn-join').disabled = $('#btn-host').disabled = false;
    showLobbyError(`Endereço inválido (${e.message}).`);
    return;
  }
  state.ws = ws;
  let opened = false;
  let lastMsg = Date.now();
  const timeout = setTimeout(() => { if (!opened) ws.close(); }, 6000);

  ws.onopen = () => {
    opened = true;
    clearTimeout(timeout);
    ws.send(JSON.stringify({ type: 'join', name: state.myName, resume: state.resume }));
    window.Sfu.setSender((m) => { if (state.ws === ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else throw new Error('sala desconectada'); });
    // sinal de vida: se a sala ficar 15 s sem responder (PC de quem hospeda caiu, Radmin travou),
    // considera a conexão perdida e reconecta
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws !== state.ws) return;
      if (Date.now() - lastMsg > 15000) { ws.close(); return; }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 5000);
  };
  ws.onmessage = (e) => {
    lastMsg = Date.now();
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (window.Sfu.onMessage(msg)) return;
    onSignal(msg);
  };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (ws !== state.ws) return; // conexão antiga (saiu e entrou de novo)
    if (!opened && !reconnecting) {
      $('#btn-join').disabled = $('#btn-host').disabled = false;
      showLobbyError(online
        ? `Não consegui conectar na sala online ${ip.toUpperCase()}. Confira sua internet e tente de novo.`
        : `Não consegui conectar em ${ip}. Confira se o IP está certo, se a pessoa clicou em "Hospedar" e se o Radmin está conectado.`);
      return;
    }
    if (state.leaving) return;
    // fechou antes de entrar na sala (ex.: "Sala cheia"): volta ao lobby normal, sem reconectar
    if ($('#room').classList.contains('hidden')) {
      $('#btn-join').disabled = $('#btn-host').disabled = false;
      setReconnectBanner(false);
      return;
    }
    scheduleReconnect(ip);
  };
}

let reconnectTry = 0;
let reconnectTimer = null;
function scheduleReconnect(ip) {
  clearInterval(heartbeat);
  reconnectTry++;
  setReconnectBanner(true);
  const wait = Math.min(5000, 500 * 2 ** Math.min(reconnectTry, 4));
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.leaving || $('#room').classList.contains('hidden')) return;
    openSocket(ip, true);
  }, wait);
}

function setReconnectBanner(on) {
  $('#reconnect-banner').classList.toggle('hidden', !on);
  if (!on) reconnectTry = 0;
}

function sendRelay(to, data) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'relay', to, data }));
}

function onSignal(msg) {
  switch (msg.type) {
    case 'welcome': {
      const wasInRoom = !$('#room').classList.contains('hidden');
      if (Array.isArray(msg.ice) && msg.ice.length) ICE_SERVERS = msg.ice.slice(0, 6);
      state.sfuServer = !!msg.sfu; // a sala online tem servidor de vídeo configurado
      setReconnectBanner(false);
      state.resume = { id: msg.id, token: msg.token };
      if (wasInRoom) {
        if (!msg.resumed || msg.id !== state.myId) {
          // a sala reiniciou (ou o lugar expirou): recomeça as conexões com todo mundo
          for (const id of [...state.peers.keys()]) removePeer(id);
          state.myId = msg.id;
          window.Sfu.reset();
          sfuRecover('a sala reiniciou', false);
        } else {
          // retomou o mesmo lugar: tira quem saiu enquanto estávamos fora
          const ids = new Set(msg.peers.map((p) => p.id));
          for (const id of [...state.peers.keys()]) if (!ids.has(id)) removePeer(id);
          // mesmo número, outra pessoa: conexão velha de quem já saiu
          for (const p of msg.peers) { const ex = state.peers.get(p.id); if (ex && ex.name !== p.name) removePeer(p.id); }
        }
        for (const p of msg.peers) createPeer(p.id, p.name);
        for (const peer of state.peers.values()) {
          sendState(peer.id);
          // o que eles mandaram enquanto eu estava fora se perdeu: pede o estado de novo
          sendRelay(peer.id, { kind: 'state-req' });
          unstickNegotiation(peer);
          // e o que EU mandei enquanto a sala estava fora também se perdeu (trocar o foco ou esconder
          // uma tela nesse meio tempo: o amigo seguia mandando a qualidade de antes): manda de novo
          peer.iWant = null;
          peer.iWant2 = null;
          if (peer.sfuPub) sendRelay(peer.id, { kind: 'sfu-pull', on: !!peer.sfuIn });
        }
        render(); // refaz os pedidos de qualidade ("want") de cada tela
        toast('Reconectado à sala.');
        break;
      }
      state.myId = msg.id;
      if (!state.isHost) {
        const d = discovered.find((r) => r.ip === state.hostIp);
        const prev = recentRooms().find((r) => r.ip === state.hostIp);
        const onlineName = isOnlineCode(state.hostIp) && !prev ? (msg.peers[0] ? msg.peers[0].name : state.myName) : null;
        rememberRoom(state.hostIp, onlineName || (d ? d.hostName : prev ? prev.hostName : state.hostIp));
      }
      enterRoom();
      for (const p of msg.peers) createPeer(p.id, p.name);
      break;
    }
    case 'peer-joined':
      // um número que eu já conheço entrando "de novo" é outra conexão (ex.: a sala reiniciou e
      // recomeçou a numeração): a conexão antiga com esse número não serve mais
      if (state.peers.has(msg.id)) removePeer(msg.id);
      window.Vida.mark(msg.id, 'entrou'); // antes de criar: a pessoa já aparece na lista chegando
      createPeer(msg.id, msg.name);
      toast(`${msg.name} entrou na sala`);
      Sfx.play('join');
      { const p = state.peers.get(msg.id); window.Vida.sala('entrou', p && p.personEl ? p.personEl.dataset.n : '', msg.name); }
      break;
    case 'peer-left': {
      const p = state.peers.get(msg.id);
      if (p) { toast(`${p.name} saiu`); Sfx.play('leave'); window.Vida.sala('saiu', p.personEl ? p.personEl.dataset.n : '', p.name); }
      removePeer(msg.id);
      break;
    }
    case 'relay':
      onRelay(msg.from, msg.data);
      break;
    case 'room-closed':
      toast('Quem hospeda fechou a sala.');
      leaveRoom();
      break;
    case 'sfu-limit': {
      // o limite grátis do mês do servidor de vídeo acabou com transmissões em andamento: todo mundo
      // sai dele e segue pela conexão direta (antes só as sessões NOVAS eram recusadas)
      const first = !state.sfuLimitAt || Date.now() - state.sfuLimitAt > 3600000;
      state.sfuLimitAt = Date.now();
      state.sfuPauseUntil = Date.now() + 6 * 3600000;
      window.Sfu.usage = { used: Number(msg.usedGb) || 0, limit: Number(msg.limitGb) || 0 };
      showSfuUsage(window.Sfu.usage);
      if (first) toast(`O limite do mês do servidor de vídeo acabou (${Math.round(msg.usedGb)} GB): as telas seguem pela conexão direta entre vocês.`, 'error');
      window.Sfu.reset();
      sfuRecover('limite do mês atingido', false);
      break;
    }
    case 'error':
      showLobbyError(msg.message || 'Erro na sala');
      break;
  }
}

// Uma oferta enviada durante uma queda da sala se perdeu: a conexão ficaria presa em
// "have-local-offer" e nunca mais renegociaria. Desfaz e negocia de novo.
function unstickNegotiation(peer) {
  if (peer.pc.signalingState !== 'have-local-offer') return;
  peer.sigChain = peer.sigChain
    .then(() => peer.pc.signalingState === 'have-local-offer' && peer.pc.setLocalDescription({ type: 'rollback' }))
    .then(() => { peer.makingOffer = false; negotiate(peer); })
    .catch((e) => console.warn('desfazer negociação', e));
}

function onRelay(from, data) {
  const peer = state.peers.get(from);
  if (!peer) return;
  switch (data.kind) {
    case 'route': // o amigo trocou a rota entre nós (ele reinicia o ICE)
      if (data.use === 'net' || data.use === 'any') {
        if (data.use === 'net') peer.netTriedAt = performance.now();
        if (data.failed && peer.routeUse === 'net') {
          // o amigo viu antes de mim que a internet direta não fechou: vale como falha minha também
          // (senão a minha preferência salva "internet direta" puxava de volta na hora e ficava sem imagem)
          peer.netFailedAt = performance.now();
          if (peer.routePref === 'net') { peer.routePref = 'auto'; localStorage.removeItem(`route:${peer.name}`); }
          toast(`Não deu para conectar com ${peer.name} direto pela internet. Voltando para o Radmin.`, 'error');
        }
        setRouteUse(peer, data.use, `pedido de ${peer.name}`, false);
      }
      break;
    case 'state-req': // o amigo reconectou à sala: reenvia meu estado e destrava a negociação
      sendState(from);
      unstickNegotiation(peer);
      // os meus pedidos que chegaram enquanto ele estava fora também se perderam
      if (peer.iWant) sendRelay(from, { kind: 'want', level: peer.iWant, maxH: peer.iWantH });
      if (peer.iWant2) sendRelay(from, { kind: 'want2', level: peer.iWant2 });
      if (peer.sfuPub) sendRelay(from, { kind: 'sfu-pull', on: !!peer.sfuIn });
      break;
    // em fila por amigo: uma descrição/candidato nunca é processado no meio de outro
    case 'sdp': peer.sigChain = peer.sigChain.then(() => handleDescription(peer, data.description)); break;
    case 'ice': peer.sigChain = peer.sigChain.then(() => handleCandidate(peer, data.candidate)); break;
    case 'state':
      {
        const was = peer.sharing;
        peer.sharing = data.sharing;
        peer.canRebuild = !!data.rb;
        peer.sfu2 = !!data.sfu2; // puxa H.265/AV1 pelo servidor de vídeo (conexão separada para receber)
        peer.hasAudio = data.audio;
        peer.audioWhy = String(data.audioWhy || '').slice(0, 200);
        peer.h265 = !!data.h265;
        peer.av1 = !!data.av1;
        // "Nativa direta" em AV1/H.265 e entrou alguém que não decodifica: troca de codec
        const dc = state.share && state.share.direct ? state.share.codec : null;
        if ((dc === 'hevc' && !peer.h265) || (dc === 'av1' && !peer.av1)) restartDirectCodec(peer.name, dc);
        // pelo servidor de vídeo em H.265/AV1 e entrou alguém numa versão antiga (não puxa esses codecs de lá)
        else if (dc && dc !== 'h264' && sfuInUse() && !peer.sfu2) restartDirectCodec(peer.name, 'hevc', 'sfu');
        // 2ª tela
        const had2 = peer.share2;
        peer.share2 = !!data.share2 && !!data.sharing;
        peer.share2Name = String(data.share2Name || '').slice(0, 120);
        if (data.s2Id) peer.remoteS2Id = data.s2Id;
        if (peer.share2 && !had2 && peer.tile) peer.tile.s2Hidden = false;
        if (peer.share2 && !had2) toast(`${peer.name} adicionou uma 2ª tela (aparece no canto da tela dele; ⇄ troca)`);
        if (!peer.share2 && peer.tile) peer.tile.swapped = false;
        peer.sourceName = data.sourceName || '';
        // transmissão pelo servidor de vídeo: puxa de lá (ids conferidos pelo servidor da sala)
        const sp = data.sfu && typeof data.sfu === 'object' && typeof data.sfu.s === 'string' && typeof data.sfu.v === 'string'
          ? { s: data.sfu.s.slice(0, 64), v: data.sfu.v.slice(0, 64), a: typeof data.sfu.a === 'string' ? data.sfu.a.slice(0, 64) : null, n: data.sfu.n === 1 ? 1 : 3 } : null;
        if (!sp) peer.sfuFail = null;
        peer.sfuPub = sp;
        sfuPullSync(peer);
        const hadCam = peer.hasCam;
        peer.hasCam = !!data.cam;
        if (data.screenId) { peer.remoteScreenId = data.screenId; peer.remoteCamId = data.camId; resolveTracks(peer); }
        if (peer.hasCam && !hadCam && !data.sharing) toast(`${peer.name} ligou a câmera`);
        if ((data.sharing || peer.hasCam) && !state.order.includes(peer.id)) state.order.push(peer.id);
        if (data.sharing && !was) {
          toast(`${peer.name} começou a compartilhar`);
          Sfx.play('share');
          window.Vida.mark(peer.id, 'aovivo');
          // app em segundo plano (ex.: jogando): notificação do Windows
          if (!document.hasFocus()) {
            try {
              const n = new Notification('Tela Amigos', { body: `${peer.name} começou a compartilhar a tela`, silent: true, icon: 'icon.png' });
              n.onclick = () => window.native.focusWindow();
            } catch {}
          }
          if (!state.order.includes(peer.id)) state.order.push(peer.id);
        }
        render();
        if (data.sharing && !was) window.Vida.sala('aovivo', peer.personEl ? peer.personEl.dataset.n : '', peer.name);
      }
      break;
    case 'want':
      peer.theyWant = data.level;
      peer.theyWantH = Number(data.maxH) > 0 ? Number(data.maxH) : 0; // resolução que ele escolheu (0 = original)
      applySendParams(peer);
      refreshBudget();
      break;
    case 'sfu-pull': // o amigo está recebendo minha tela pelo servidor: paro de mandar direto
      peer.sfuPulling = !!data.on;
      applySendParams(peer);
      // nativa pelo servidor: quem acabou de entrar precisa de um quadro completo logo
      if (peer.sfuPulling && state.share && state.share.direct && state.share.sfu) {
        for (const ms of [0, 700, 1800]) setTimeout(() => { if (state.share && state.share.direct) window.NativeVideo.key(); }, ms);
      }
      break;
    case 'diag-req': // diagnóstico pedido pela sala (sem conexão direta com quem pediu)
      sendMyDiag(peer, true).catch((e) => console.warn('enviar diagnóstico', e));
      break;
    case 'diag-part':
      onDiagPart(peer, data).catch((e) => console.warn('receber diagnóstico', e));
      break;
    case 'need-key': // a minha tela parou no amigo: manda um quadro completo
      sendKeyFrame(peer);
      break;
    case 'rebuild': // o amigo vai refazer a conexão entre nós (tela travada): refaço a minha também
      rebuildPeer(from, false);
      return;
    case 'sfu-rx': // quem recebe pelo servidor está perdendo pacotes/travando (a imagem é uma só para todos)
      if (data.bad) peer.sfuRxBad = [...(peer.sfuRxBad || []).filter((t) => Date.now() - t < 10000), Date.now()];
      break;
    case 'want2':
      peer.theyWant2 = ['off', 'thumb', 'full'].includes(data.level) ? data.level : 'off';
      applySendParams(peer);
      break;
    case 'health':
      peer.health = {
        direct: !!data.direct,
        cpu: !!data.cpu, gaming: !!data.gaming,
        cap: Number.isFinite(data.cap) ? data.cap : null, target: Number.isFinite(data.target) ? data.target : null,
        out: Number.isFinite(data.out) ? data.out : null, // quadros/s que ele está mandando
        sw: ['placa', 'limite', 'codec'].includes(data.sw) ? data.sw : null, // a placa dele não está codificando
      };
      break;
    case 'media': onMediaRequest(peer); break;
    case 'media-denied': toast(`${peer.name} não liberou o controle de play/pausa (opção na barra lateral dele).`); break;
    case 'media-done': addChat('', String(data.text || '').slice(0, 200), true); break;
    case 'ready-check':
      onReadyCheck({ id: String(data.id), from: from, fromName: peer.name, target: data.target ? String(data.target) : null });
      break;
    case 'ready': onReady(from, String(data.id)); break;
    case 'ink':
      if (Array.isArray(data.segs)) {
        const segs = data.segs.slice(0, drawBudget(peer, 'ink', 200, 600)).filter((sg) => Array.isArray(sg) && sg.length === 4 && sg.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
        if (segs.length) showInk(data.target, from, peer.name, segs);
      }
      break;
    case 'ink-clear': clearInk(data.target, from); break;
    case 'ready-cancel':
      if (readyCheck && readyCheck.id === String(data.id)) endReadyCheck(`${peer.name} cancelou`);
      break;
    case 'chat':
      if (!String(data.text || '').trim()) break; // ignora mensagem vazia
      addChat(peer.name, String(data.text).slice(0, 300));
      if (!document.hasFocus()) Sfx.play('chat');
      break;
    case 'react':
      if (typeof data.emoji === 'string' && data.emoji.length <= 8) {
        showReaction(String(data.target), data.emoji, peer.name);
        // emote na MINHA tela: sobe também no meu monitor
        if (sendToMyDesktop(String(data.target), from, 'react')) {
          deskSend('react', { displayId: state.share.source.displayId, emoji: data.emoji, name: peer.name, color: `hsl(${nameHue(peer.name)}, 85%, 55%)` });
        }
      }
      break;
    case 'point':
      if (Number.isFinite(data.x) && Number.isFinite(data.y) && drawBudget(peer, 'point', 1, 400)) showLaser(String(data.target), peer.id, peer.name, data.x, data.y, !!data.draw);
      break;
    case 'press':
      if (Number.isFinite(data.x) && Number.isFinite(data.y) && drawBudget(peer, 'point', 1, 400)) showPress(String(data.target), peer.id, peer.name, data.x, data.y);
      break;
    case 'point-end':
      hideLaser(String(data.target), peer.id);
      break;
  }
}

// ------------------------------------------------------------------ WebRTC
function createPeer(id, name) {
  if (state.peers.has(id)) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
  const s = state.settings;
  const peer = {
    id, name, pc,
    polite: Number(state.myId) > Number(id),
    makingOffer: false,
    ignoreOffer: false,
    sharing: false,
    hasAudio: false,
    sourceName: '',
    theyWant: 'full',   // o que esse amigo quer receber de mim
    iWant: null,        // o que eu pedi para ele
    remoteStream: new MediaStream(),
    conn: 'new',
    tile: null,
    statsPrev: null,
    stats: null,
    routePref: loadRoutePref(name), // 'auto' | 'any' (Radmin/VPN) | 'net' (internet direta)
    // 'net' = candidatos da VPN ignorados. Na sala online começa pela internet (se os dois têm
    // Radmin, o ICE escolheria o Radmin); se não conectar em 15 s, routeWatch libera o Radmin.
    routeUse: isOnlineCode(state.hostIp) && loadRoutePref(name) !== 'any' ? 'net' : 'any',
    routePath: '?',
    routeSince: performance.now(),
  };
  // cada trilha num "stream" identificado: quem recebe sabe o que é tela e o que é câmera
  peer.screenMS = new MediaStream();
  peer.camMS = new MediaStream();
  peer.vT = pc.addTransceiver('video', {
    direction: 'sendonly',
    streams: [peer.screenMS],
    sendEncodings: [{ maxBitrate: s.bitrate * 1e6, maxFramerate: Number(s.fps) }],
  });
  peer.aT = pc.addTransceiver('audio', { direction: 'sendonly', streams: [peer.screenMS] });
  // câmera: canal criado desde já (vazio); ligar a câmera só preenche, sem renegociar
  peer.cT = pc.addTransceiver('video', {
    direction: 'sendonly',
    streams: [peer.camMS],
    sendEncodings: [{ maxBitrate: 2_500_000, maxFramerate: 30 }],
  });
  // 2ª tela: também criada desde já (vazia); quem tem versão antiga simplesmente ignora
  peer.s2MS = new MediaStream();
  peer.s2T = pc.addTransceiver('video', {
    direction: 'sendonly',
    streams: [peer.s2MS],
    sendEncodings: [{ maxBitrate: 8_000_000, maxFramerate: 30 }],
  });
  peer.screen2Stream = new MediaStream(); // 2ª tela recebida deste amigo
  peer.theyWant2 = 'off';
  // canal de dados (combinado dos dois lados, id fixo): teste de conexão e "assistir junto"
  try {
    peer.dc = pc.createDataChannel('tela', { negotiated: true, id: 7 });
    peer.dc.binaryType = 'arraybuffer';
    peer.dc.onmessage = (e) => onDataMessage(peer, e.data);
    peer.dc.onopen = () => scheduleAutoMeasure(peer); // mede o upload para este amigo
  } catch (e) { console.warn('canal de dados:', e.message); }
  peer.camStream = new MediaStream();   // câmera recebida deste amigo
  peer.videoTracks = new Map();         // id do stream -> trilha de vídeo recebida
  setCodec(peer, state.share && state.share.direct ? directCodecMode(state.share.codec) : s.codec);
  // transform ligado desde o início (antes de negociar); fica em "deixa passar" até o modo nativo
  window.NativeVideo.attach(peer.vT.sender, id);

  peer.sigChain = Promise.resolve();
  pc.onnegotiationneeded = () => negotiate(peer);
  // renegociação pedida no meio de outra: faz assim que a conexão voltar a ficar estável
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'stable' && peer.pendingNegotiation) {
      peer.pendingNegotiation = false;
      negotiate(peer);
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && !isIPv6Candidate(candidate) && !(peer.routeUse === 'net' && isVpnCandidate(candidate))) {
      sendRelay(id, { kind: 'ice', candidate: demoteVpnCandidate(candidate.toJSON()) });
    }
  };
  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      peer.p2pAudio = e.track; // resolveTracks escolhe entre este e o do servidor de vídeo
    } else {
      // vídeo: tela ou câmera? decide em resolveTracks (o amigo informa os ids no "state")
      const sid = (e.streams && e.streams[0] && e.streams[0].id) || `sem-id-${peer.videoTracks.size}`;
      peer.videoTracks.set(sid, e.track);
      // (sempre: o atraso escolhido para este amigo, "Imagem lisa"/"Atraso mínimo", vale por conexão
      // e antes só era reaplicado numa conexão nova se houvesse um jogo aberto)
      applyPlayoutBuffer();
    }
    resolveTracks(peer);
  };
  pc.onconnectionstatechange = () => {
    peer.conn = pc.connectionState;
    clearTimeout(peer.downTimer);
    if (pc.connectionState === 'disconnected' && !peer.polite) {
      peer.downTimer = setTimeout(() => {
        if (state.peers.get(id) !== peer || pc.connectionState !== 'disconnected') return;
        console.warn(`conexão com ${peer.name} caiu: reiniciando`);
        try { pc.restartIce(); } catch (e) { console.warn('reiniciar ICE', e); }
      }, 6000);
    }
    if (pc.connectionState === 'failed') {
      // pela internet não deu: volta a aceitar o Radmin (setRouteUse já reinicia o ICE)
      if (peer.routeUse === 'net' && peer.hadVpn) { peer.netFailedAt = performance.now(); setRouteUse(peer, 'any', 'conexão pela internet caiu'); }
      else pc.restartIce();
    }
    if (pc.connectionState === 'connected') applySendParams(peer);
    renderPeople();
  };

  state.peers.set(id, peer);

  // Se eu já estou compartilhando, começa a mandar para o novo amigo
  applySendParams(peer);
  sendState(id);
  render();
}

function directCodecMode(codec) { return codec === 'av1' ? 'native-av1' : codec === 'hevc' ? 'native-h265' : 'native'; }
function setCodec(peer, codec) {
  peer.codecMode = codec;
  const prefs = codec === 'native' ? window.Sdp.h264OnlyPreferences()
    : codec === 'native-h265' ? window.Sdp.h265OnlyPreferences()
      : codec === 'native-av1' ? window.Sdp.av1OnlyPreferences()
        : window.Sdp.codecPreferences(codec);
  try { if (prefs) peer.vT.setCodecPreferences(prefs); } catch (e) { console.warn('codec', e); }
}

// Limites de banda combinados com cada amigo (linhas x-google-* do SDP). Início e piso seguem o que a
// rede até ele aguenta; na "Nativa direta" o teto fica acima de qualquer bitrate que a placa possa
// usar (1,5x a qualidade escolhida), senão a estimativa de banda do WebRTC ficava presa num teto baixo
// e o controle de bitrate lia isso como rede apertada.
function rateOpts(peer) {
  const sh = state.share;
  const native = !!(sh && sh.direct);
  const videoKbps = perPeerMbps(state.settings.bitrate, peer) * 1000;
  const setK = ((sh && sh.settings && Number(sh.settings.bitrate)) || Number(state.settings.bitrate) || 20) * 1000;
  // Piso da estimativa de banda. O bitrate da placa fica sempre abaixo da estimativa (netctl.js), e
  // ela tem um vício: com a tela parada (pouco tráfego) qualquer recuo a deixa lá embaixo, e ela só
  // sobe ~8% por segundo quando o movimento volta (nos registros dos amigos ela vivia encostada no
  // piso antigo, 4 Mb/s). O piso é, na prática, o bitrate disponível NA HORA em que a ação começa:
  // 60% do nominal (até 8 Mb/s). Num caminho que não aguenta isso a estimativa deixa de avisar, mas
  // o controle de bitrate tem as outras testemunhas (perda, atraso, o amigo avisando quanto recebe).
  const minKbps = native ? Math.min(videoKbps * 0.6, 8000) : 0;
  return { videoKbps, native, minKbps, maxKbps: native ? setK * 1.5 : 0 };
}
// o que ficou valendo para o MEU envio (os limites vêm da descrição remota)
function noteRates(peer, ro) {
  peer.sdpNative = ro.native;
  peer.sdpFloor = ro.native ? ro.minKbps : Math.min(ro.videoKbps * 0.4, 4000);
  peer.sdpMax = ro.native ? Math.max(ro.videoKbps * 1.3, ro.maxKbps) : ro.videoKbps * 1.25;
}

async function negotiate(peer) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  if (pc.signalingState !== 'stable' || peer.makingOffer) {
    peer.pendingNegotiation = true; // refaz quando ficar estável (onsignalingstatechange)
    return;
  }
  try {
    peer.makingOffer = true;
    const offer = await pc.createOffer();
    if (pc.signalingState !== 'stable') { peer.pendingNegotiation = true; return; }
    offer.sdp = window.Sdp.munge(offer.sdp, rateOpts(peer));
    await pc.setLocalDescription(offer);
    sendRelay(peer.id, { kind: 'sdp', description: outDesc(peer, pc.localDescription) });
  } catch (e) {
    console.error('negotiate', e);
    if (peerDesynced(peer, e)) return;
    peer.pendingNegotiation = true;
  } finally {
    peer.makingOffer = false;
  }
  // falhou com a conexão já estável: nenhuma mudança de estado vai disparar de novo, então tenta já
  if (peer.pendingNegotiation && pc.signalingState === 'stable') {
    setTimeout(() => {
      if (peer.pendingNegotiation && pc.signalingState === 'stable') { peer.pendingNegotiation = false; negotiate(peer); }
    }, 300 + Math.random() * 400);
  }
}

async function handleDescription(peer, description) {
  const pc = peer.pc;
  try {
    // padrão "perfect negotiation" completo: uma resposta sendo aplicada não conta como colisão
    const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    // os limites de bitrate/estéreo que EU uso para enviar vêm da descrição remota
    peer.settingAnswer = description.type === 'answer';
    const ro = rateOpts(peer);
    try {
      await pc.setRemoteDescription({ type: description.type, sdp: window.Sdp.munge(routeIn(peer, description.sdp), ro) });
      noteRates(peer, ro);
    } finally {
      peer.settingAnswer = false;
    }
    // candidatos que chegaram cedo demais
    if (peer.pendingCands && peer.pendingCands.length) {
      const list = peer.pendingCands.splice(0);
      for (const c of list) await handleCandidate(peer, c);
    }
    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      answer.sdp = window.Sdp.munge(answer.sdp, rateOpts(peer));
      await pc.setLocalDescription(answer);
      sendRelay(peer.id, { kind: 'sdp', description: outDesc(peer, pc.localDescription) });
    }
  } catch (e) {
    console.error('sdp', e);
    peerDesynced(peer, e);
  }
}

// "The order of m-lines ... doesn't match": um dos lados refez a conexão e o outro não ficou sabendo
// (o aviso "rebuild" foi mandado com a sala fora do ar, ex.: PC voltando da suspensão). Essas duas
// conexões nunca mais se entendem: antes a tela ficava preta até alguém sair e entrar. Refaz dos dois
// lados (o "rebuild" avisa o amigo). Se acabou de refazer com ele, tenta de novo quando o limite liberar.
function peerDesynced(peer, e) {
  if (!/m-lines/i.test(String((e && e.message) || e))) return false;
  if (state.peers.get(peer.id) !== peer || peer.desyncTimer) return true;
  console.warn(`conexão com ${peer.name} dessincronizada: refazendo dos dois lados`);
  const tryNow = () => {
    peer.desyncTimer = null;
    if (state.peers.get(peer.id) !== peer) return; // já foi refeita (pedido dele)
    if (rebuildPeer(peer.id, true)) return;
    const wait = 45000 - (Date.now() - (rebuiltAt.get(peer.name) || 0));
    peer.desyncTimer = setTimeout(tryNow, Math.max(1000, wait + 200));
  };
  // os dois lados costumam ver o erro: quem age é o "impolite"; o outro só se nada acontecer em 8 s
  // (refazer dos dois lados ao mesmo tempo embaralharia de novo)
  peer.desyncTimer = setTimeout(tryNow, peer.polite ? 8000 : 300);
  return true;
}

// Só IPv4: pelo IPv6 do Radmin (fdfd::) os pacotes grandes de vídeo são descartados
// (túnel com MTU menor e IPv6 não fragmenta no caminho) -> milhares de perdas, vídeo a 0 fps.
function isIPv6Candidate(c) {
  const addr = c.address || (String(c.candidate || '').split(' ')[4] || '');
  return addr.includes(':');
}

// A v1.0.5 rebaixava os candidatos da VPN (Radmin/Hamachi) para preferir a internet direta,
// mas na prática as conexões pararam de fechar. Agora a VPN volta a ser o caminho preferido;
// e candidatos rebaixados vindos de quem ainda está na 1.0.5 são restaurados aqui.
function demoteVpnCandidate(c) {
  if (!c || !c.candidate) return c;
  const parts = String(c.candidate).split(' ');
  if (!/^(26|25)\./.test(parts[4] || '') || parts[7] !== 'host') return c;
  if (Number(parts[3]) >= 1e9) return c; // prioridade normal: nada a fazer
  parts[3] = '2122260223'; // prioridade típica de candidato "host" do Chromium
  return { candidate: parts.join(' '), sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment };
}

async function handleCandidate(peer, candidate) {
  if (candidate && candidate.candidate && isIPv6Candidate(candidate)) return; // amigo com versão antiga
  if (candidate && candidate.candidate && peer.routeUse === 'net' && isVpnCandidate(candidate)) return; // rota pela internet
  // chegou antes de existir uma descrição remota (ex.: a oferta dele foi descartada numa
  // colisão): guarda e aplica depois. Antes eram jogados fora e a conexão às vezes nunca fechava.
  if (!peer.pc.remoteDescription) {
    (peer.pendingCands = peer.pendingCands || []).push(candidate);
    return;
  }
  try {
    await peer.pc.addIceCandidate(demoteVpnCandidate(candidate));
  } catch (e) {
    if (!peer.ignoreOffer) console.warn('ice', e);
  }
}

// ------------------------------------------------------------------ rota: Radmin x internet direta
// Pelo Radmin os pacotes às vezes ficam presos numa fila (canal TCP/relay: ping de 1 a 20 s) e a
// tela trava por segundos. A rota de cada amigo pode passar para a internet direta (STUN, UDP):
// em "net" os candidatos da VPN são ignorados nos dois sentidos (os meus não saem, os dele não
// entram) e o ICE reinicia. Basta um lado filtrar, então funciona até com amigo em versão antiga.
// Se não conectar em 15 s, volta para o Radmin.
const VPN_ADDR = /^(26|25)\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const ROUTE_LABELS = { auto: 'Automática', any: 'Pelo Radmin/VPN', net: 'Internet direta' };
function candidateAddr(c) { return (c && (c.address || String(c.candidate || '').split(' ')[4])) || ''; }
function isVpnAddr(a) { return !!window.__routeBlockAll || VPN_ADDR.test(a); } // __routeBlockAll: teste de falha
function isVpnCandidate(c) { return isVpnAddr(candidateAddr(c)); }
function stripVpnSdp(sdp) {
  return String(sdp).split('\r\n').filter((l) => !(l.startsWith('a=candidate:') && isVpnAddr(l.split(' ')[4] || ''))).join('\r\n');
}
function outDesc(peer, d) { return d && peer.routeUse === 'net' ? { type: d.type, sdp: stripVpnSdp(d.sdp) } : d; }
function routeIn(peer, sdp) { return peer.routeUse === 'net' ? stripVpnSdp(sdp) : sdp; }
function loadRoutePref(name) { const v = localStorage.getItem(`route:${name}`); return v === 'any' || v === 'net' ? v : 'auto'; }

function setRouteUse(peer, use, why, tell = true) {
  if (peer.routeUse === use) return;
  peer.routeUse = use;
  peer.routeSince = performance.now();
  peer.routeBad = [];
  peer.netOkShown = false;
  console.log(`rota com ${peer.name}: ${use === 'net' ? 'internet direta' : 'Radmin/VPN liberado'} (${why})`);
  if (!tell) return; // quem pediu reinicia o ICE; a oferta dele chega em seguida
  sendRelay(peer.id, { kind: 'route', use, failed: use === 'any' && /não conectou/.test(why) });
  try { peer.pc.restartIce(); } catch (e) { console.warn('reiniciar ICE', e); }
}

function setRoutePref(id, pref) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.routePref = pref;
  if (pref === 'auto') localStorage.removeItem(`route:${peer.name}`); else localStorage.setItem(`route:${peer.name}`, pref);
  peer.netFailedAt = 0;
  if (pref === 'net') { peer.netTriedAt = performance.now(); setRouteUse(peer, 'net', 'escolhido por você'); toast(`Conectando com ${peer.name} direto pela internet...`); }
  else if (pref === 'any') setRouteUse(peer, 'any', 'escolhido por você');
}

async function routeWatch() {
  const now = performance.now();
  for (const peer of state.peers.values()) {
    const pc = peer.pc;
    if (pc.connectionState === 'closed') continue;
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    let pairId = null, rin = 0, lost = 0, recv = 0;
    const pairs = new Map(), cands = new Map();
    report.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      else if (r.type === 'candidate-pair') pairs.set(r.id, r);
      else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') rin = Math.max(rin, r.roundTripTime || 0);
      else if (r.type === 'inbound-rtp' && r.kind === 'video') { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
    });
    const pair = pairs.get(pairId);
    let path = '?';
    if (pair && pc.connectionState === 'connected') {
      const l = cands.get(pair.localCandidateId), r = cands.get(pair.remoteCandidateId);
      if (l && r) {
        path = l.candidateType === 'relay' || r.candidateType === 'relay' ? 'relay'
          : VPN_ADDR.test(l.address || '') || VPN_ADDR.test(r.address || '') ? 'vpn' : 'net';
        // depois de reiniciar o ICE o Chromium continua no par antigo até o novo funcionar:
        // par de uma rodada anterior não conta como "conectou pela rota nova"
        const ufrag = (/a=ice-ufrag:(\S+)/.exec((pc.localDescription && pc.localDescription.sdp) || '') || [])[1];
        if (ufrag && l.usernameFragment && l.usernameFragment !== ufrag) path = 'antigo';
      }
    }
    peer.routePath = path;
    if (path === 'vpn') peer.hadVpn = true;
    // amostra ruim: ping do caminho alto ou perdendo pacotes
    const rtt = Math.max((pair && pair.currentRoundTripTime) || 0, rin);
    const dl = lost - (peer.routeLost != null ? peer.routeLost : lost), dr = recv - (peer.routeRecv != null ? peer.routeRecv : recv);
    peer.routeLost = lost; peer.routeRecv = recv;
    const loss = dl + dr > 50 ? Math.max(0, dl) / (Math.max(0, dl) + Math.max(0, dr)) : 0;
    const bad = rtt > 0.35 || loss > 0.05;
    peer.routeBad = peer.routeBad || [];
    peer.routeBad.push(bad);
    if (peer.routeBad.length > 15) peer.routeBad.shift();
    const badN = peer.routeBad.filter(Boolean).length;
    const since = now - (peer.routeSince || 0);

    if (peer.routeUse === 'net') {
      if (path === 'net' || path === 'relay') {
        if (!peer.netOkShown) { peer.netOkShown = true; toast(`${peer.name}: conectado direto pela internet${path === 'relay' ? ' (por servidor)' : ''}.`); }
        // a internet direta também ficou ruim por um bom tempo e o Radmin existe: tenta voltar
        if (peer.routePref === 'auto' && peer.hadVpn && since > 60000 && peer.routeBad.length >= 15 && badN >= 10) {
          peer.netTriedAt = now;
          setRouteUse(peer, 'any', 'internet direta também ruim');
        }
      } else if (since > 15000) {
        // não fechou pela internet: volta para o Radmin (e não tenta de novo tão cedo)
        peer.netFailedAt = now;
        setRouteUse(peer, 'any', 'internet direta não conectou');
        toast(`Não deu para conectar com ${peer.name} direto pela internet. Voltando para o Radmin.`, 'error');
        if (peer.routePref === 'net') { peer.routePref = 'auto'; localStorage.removeItem(`route:${peer.name}`); }
      }
      continue;
    }
    if (pc.connectionState !== 'connected') continue;
    // escolhido "Internet direta" para este amigo (vale também depois de reconectar)
    if (peer.routePref === 'net' && !peer.netFailedAt) { peer.netTriedAt = now; setRouteUse(peer, 'net', 'preferência salva'); continue; }
    // automático: Radmin ruim por ~30 s -> tenta a internet (no máx. a cada 10 min)
    if (peer.routePref === 'auto' && path === 'vpn' && localStorage.getItem('autoRoute') !== '0' &&
        peer.routeBad.length >= 15 && badN >= 8 && since > 30000 &&
        (!peer.netTriedAt || now - peer.netTriedAt > 600000)) {
      peer.netTriedAt = now;
      setRouteUse(peer, 'net', `Radmin ruim (ping ${Math.round(rtt * 1000)} ms, perda ${Math.round(loss * 100)}%)`);
      toast(`A conexão com ${peer.name} pelo Radmin está ruim: tentando direto pela internet...`);
    }
  }
}
setInterval(() => { routeWatch().catch((e) => console.warn('rota', e)); }, 2000);

// ------------------------------------------------------------------ servidor de vídeo (beta)
// Na sala online, com a opção ligada, quem transmite pode mandar a tela UMA vez para o servidor de vídeo
// (sfu.js) e cada amigo puxa de lá a qualidade que aguenta. Quem puxou avisa ("sfu-pull") e eu paro
// de mandar direto para ele. Qualquer falha: volta para a conexão direta.
// Só quando precisa (desde a 1.0.64): a transmissão começa direto para os amigos (não gasta o limite grátis do
// mês, e direto a qualidade pode passar do teto do servidor) e vai para o servidor quando o meu upload não dá
// conta de mandar uma cópia para cada um, ou quando a conexão direta com alguém que assiste caiu (sfuNeedWatch).
function sfuWanted() { return isOnlineCode(state.hostIp) && !!state.sfuServer && localStorage.getItem('sfu') === '1'; }
// a transmissão está (ou deve estar) indo pelo servidor agora
function sfuInUse(share = state.share) { return !!(share && share.sfuAuto && sfuWanted() && !sfuPaused()); }
// uso do mês ao lado da opção (o limite grátis é por mês e vale para a sala toda)
function showSfuUsage(u) {
  const sp = $('#opt-sfu') && $('#opt-sfu').parentElement.querySelector('span');
  if (sp) sp.textContent = 'Servidor de vídeo quando precisar (beta)' + (u && u.limit ? ` · ${Math.round(u.used)} de ${u.limit} GB do mês` : u ? ` · ${Math.round(u.used)} GB no mês` : '');
}
window.Sfu.onUsage = showSfuUsage;
function sfuPaused() { return Date.now() < (state.sfuPauseUntil || 0); }
function sfuKbps(s) { return Math.min(Number(s.bitrate) || 8, Number(localStorage.getItem('sfuMaxMbps')) || 8) * 1000; } // limite: GB do mês

let sfuSyncing = Promise.resolve();
function sfuSync() {
  sfuSyncing = sfuSyncing.then(sfuSyncInner).catch((e) => console.warn('servidor de vídeo', e));
  return sfuSyncing;
}
async function sfuSyncInner() {
  const share = state.share;
  const want = sfuInUse(share);
  if (want) {
    try {
      const s = share.settings;
      // (só conta quem já mandou o estado dele: um amigo que acabou de entrar ainda não disse nada, e
      // tratá-lo como "versão antiga" rebaixava a transmissão para H.264 à toa, com um aviso falso)
      const old = [...state.peers.values()].find((p) => p.h265 !== undefined && !p.sfu2);
      if (share.direct && share.codec && share.codec !== 'h264' && old) {
        // H.265/AV1 pelo servidor só quando todos na sala puxam esses codecs de lá (versão nova, com
        // a conexão de receber separada); senão passa para H.264 e publica depois
        console.warn(`servidor de vídeo: transmissão em ${share.codec} e ${old.name} está numa versão antiga; trocando para H.264`);
        restartDirectCodec(old.name, 'hevc', 'sfu');
        return;
      }
      const native = share.direct ? { codec: share.codec || 'h264', attach: (sender) => window.NativeVideo.attach(sender, 'sfu') } : null;
      const info = await window.Sfu.publish({ video: share.video, audio: share.audio || null, kbps: sfuKbps(s), fps: Number(s.fps) || 60, native });
      // a placa de vídeo manda os quadros para o servidor também (pelo transform da trilha vazia)
      window.NativeVideo.setMode('sfu', !!native, !!native && state.share === share);
      if (native) window.NativeVideo.key();
      if (state.share !== share) return; // trocou de tela no meio: a próxima sincronização cuida
      const changed = !share.sfu || share.sfu.s !== info.s || share.sfu.v !== info.v || share.sfu.a !== info.a;
      share.sfu = info;
      if (changed) {
        console.log('servidor de vídeo: transmitindo pelo servidor');
        for (const peer of state.peers.values()) sendState(peer.id);
      }
    } catch (e) {
      share.sfu = null;
      window.NativeVideo.setMode('sfu', false, false);
      console.warn(`servidor de vídeo: não deu para transmitir por ele: ${e.message}`);
      state.sfuLastErr = `transmitir: ${e.message}`;
      if (e.sfuLost) return; // a sessão foi refeita: sfuRecover tenta de novo sozinho
      toast(`Servidor de vídeo indisponível (${e.message}). Transmitindo direto para os amigos.`, 'error');
      for (const peer of state.peers.values()) { peer.sfuPulling = false; applySendParams(peer); sendState(peer.id); }
    }
  } else if (window.Sfu.published()) {
    if (share) share.sfu = null;
    window.NativeVideo.setMode('sfu', false, false);
    await window.Sfu.unpublish();
    for (const peer of state.peers.values()) { peer.sfuPulling = false; applySendParams(peer); sendState(peer.id); }
  }
}

// Vigia do "só quando precisa" (a cada 2 s, transmitindo, com a opção ligada na sala online):
//  - alguém que assiste está há mais de 8 s sem a conexão direta comigo (falhou, caiu, ou nunca fechou: na sala
//    online, quem tem a rede fechada fica preso em "conectando" com quase todo mundo; o diagnóstico de 2026-11-12
//    mostrou 4 de 6 amigos sem a tela do Nuke por isso): vai para o servidor;
//  - o meu upload não dá conta: com 2+ amigos vendo em tamanho cheio, a qualidade por amigo ficou abaixo de 70% do
//    que o servidor entregaria e a rede reclamou em dois caminhos ao mesmo tempo, por 10 s seguidos (um amigo só
//    com rede ruim não conta: o servidor não melhora a chegada até ele);
//  - o meu PC não dá conta (captura adaptativa: o WebRTC codifica uma cópia para CADA amigo): PC no limite (modo
//    leve) ou o encoder limitado pelo processador em dois amigos, por 10 s. Pelo servidor a tela é codificada uma vez;
//  - no servidor fica até o fim desta transmissão (trocar de caminho interrompe a imagem de todo mundo); volta para
//    o direto só se sobrar um amigo (ou nenhum) assistindo por 30 s, com conexão direta: aí o servidor não economiza nada.
async function sfuNeedWatch() {
  const sh = state.share;
  if (!sh || !sfuWanted() || sfuPaused()) return;
  const viewers = [...state.peers.values()].filter((p) => p.theyWant && p.theyWant !== 'off' && p.pc.connectionState !== 'closed');
  const full = viewers.filter((p) => p.theyWant !== 'thumb' && p.pc.connectionState === 'connected');
  const short = !sh.sfuAuto && full.length >= 2 && (await uploadShort(sh, full));
  if (state.share !== sh) return;
  const d = sfuDecide(sh, viewers, short, Date.now());
  if (!d) return;
  if (d.use) {
    console.log(`servidor de vídeo: ${d.why}; passando a transmitir pelo servidor`);
    toast(d.lost ? `A conexão direta com ${d.lost} não está funcionando: sua tela passa a ir pelo servidor de vídeo.`
      : d.pc ? 'Seu PC não está dando conta de codificar a tela para cada amigo: ela passa a ir uma vez só pelo servidor de vídeo.'
        : 'Seu upload não está dando conta de mandar a tela para todos: ela passa a ir uma vez só pelo servidor de vídeo.');
  } else console.log('servidor de vídeo: só um amigo assistindo, voltando a mandar direto');
  sfuSync();
}
// a decisão em si, sem rede (os testes chamam direto): marca sh.sfuAuto e devolve { use, why, lost } quando muda,
// null quando fica como está. viewers: amigos assistindo; short: nesta medida não deu conta ('pc' = o PC; outro valor
// verdadeiro = o upload)
function sfuDecide(sh, viewers, short, now) {
  // desde quando cada um está sem a conexão direta comigo (qualquer estado que não seja "connected")
  for (const p of viewers) p.sfuDiscAt = p.pc.connectionState !== 'connected' ? (p.sfuDiscAt || now) : 0;
  const lost = viewers.find((p) => p.sfuDiscAt && now - p.sfuDiscAt > 8000);
  if (sh.sfuAuto) {
    if (viewers.length > 1 || lost) { sh.sfuFew = 0; return null; }
    sh.sfuFew = sh.sfuFew || now;
    if (now - sh.sfuFew < 30000) return null;
    sh.sfuAuto = null; sh.sfuFew = 0; sh.sfuShortN = 0;
    return { use: false };
  }
  sh.sfuShortN = short && !lost ? (sh.sfuShortN || 0) + 1 : 0;
  if (!lost && sh.sfuShortN < 5) return null;
  const pc = !lost && short === 'pc';
  const why = lost ? `sem conexão direta com ${lost.name}` : pc ? 'o PC não dá conta de codificar uma cópia para cada amigo'
    : 'upload não dá conta de uma cópia para cada amigo';
  sh.sfuAuto = { at: now, why };
  return { use: true, why, lost: lost ? lost.name : null, pc };
}
setInterval(() => { sfuNeedWatch().catch((e) => console.warn('servidor de vídeo (vigia)', e)); }, 2000);

// a qualidade que chega aos amigos pela conexão direta ficou abaixo do que o servidor entregaria, por falta de upload
// (true) ou, na captura adaptativa, porque o PC não dá conta de uma cópia para cada amigo ('pc'); false se está bem
async function uploadShort(sh, full) {
  const want = Math.min((Number(sh.settings.bitrate) || 20) * 1000, sfuKbps(sh.settings)); // kb/s
  const now = Date.now();
  if (sh.direct) {
    // nativa direta: a mesma imagem para todos, no bitrate que o controle de rede decidiu (adaptNativeBitrate)
    const tight = full.filter((p) => p.net && p.net.st && ['soft', 'cong', 'severe'].includes(p.net.st.level)).length;
    if (tight >= 2) sh.multiTightAt = now;
    return (state.nativeKbps || 0) < want * 0.7 && now - (sh.multiTightAt || 0) < 15000;
  }
  // adaptativa: cada amigo tem o seu encoder; conta quem está limitado pela banda abaixo do que o servidor daria, e
  // quem está limitado pelo processador (com o PC no limite, o modo leve já ligou: vale direto)
  if (state.lightMode) return 'pc';
  let n = 0, cpu = 0;
  for (const p of full) {
    try {
      (await p.pc.getStats()).forEach((r) => {
        if (r.type !== 'outbound-rtp' || r.kind !== 'video' || (p.vT && p.vT.mid != null && String(r.mid) !== String(p.vT.mid))) return;
        if (r.qualityLimitationReason === 'cpu') cpu++;
        else if (r.qualityLimitationReason === 'bandwidth' && r.targetBitrate && r.targetBitrate / 1000 < want * 0.7) n++;
      });
    } catch {}
  }
  return cpu >= 2 ? 'pc' : n >= 2;
}

// lado de quem assiste: puxa do servidor quando o amigo transmite por lá (e eu estou vendo)
function sfuPullSync(peer) {
  peer.sfuChain = (peer.sfuChain || Promise.resolve()).then(() => sfuPullInner(peer)).catch((e) => console.warn('servidor de vídeo (receber)', e));
}
async function sfuPullInner(peer) {
  // (o objeto, não só o número: depois de refazer a conexão com um amigo o número é o mesmo, e uma
  // tentativa agendada para a conexão antiga puxava a mesma transmissão de novo, em dobro, até o fim)
  if (state.peers.get(peer.id) !== peer) return;
  const pub = peer.sharing ? peer.sfuPub : null;
  const level = peer.iWant || 'full';
  const key = pub ? `${pub.s}/${pub.v}` : null;
  // falhou há pouco com esta transmissão: espera (10 s, 20 s, 30 s) e desiste depois de 3 tentativas
  const f = peer.sfuFail && peer.sfuFail.key === key ? peer.sfuFail : null;
  const blocked = !!f && (f.n >= 3 || Date.now() - f.at < 10000 * f.n);
  const want = !!pub && level !== 'off' && isOnlineCode(state.hostIp) && !blocked && !sfuPaused();
  let rid = level === 'thumb' ? 'q' : peer.iWantH && peer.iWantH <= 540 ? 'h' : 'f';
  // a rede até mim não está dando conta da qualidade cheia: média por um tempo (sfuRxFeedback)
  if (rid === 'f' && Date.now() < (peer.sfuCapUntil || 0)) rid = 'h';
  if (peer.sfuIn && (!want || peer.sfuIn.key !== key)) {
    const old = peer.sfuIn;
    peer.sfuIn = null;
    resolveTracks(peer);
    sendRelay(peer.id, { kind: 'sfu-pull', on: false });
    await window.Sfu.unpull(old.key, old.pull);
  }
  if (!want) return;
  if (peer.sfuIn) { await window.Sfu.setRid(key, rid).catch((e) => console.warn('servidor de vídeo: qualidade', e.message)); return; }
  try {
    const res = await window.Sfu.pull(key, pub, rid);
    // a conexão com o amigo foi refeita (ou ele trocou de transmissão) enquanto puxava: fecha
    // exatamente o que ESTA tentativa abriu (a conexão nova pode já ter puxado a mesma de novo)
    if (state.peers.get(peer.id) !== peer || !peer.sfuPub || `${peer.sfuPub.s}/${peer.sfuPub.v}` !== key) { await window.Sfu.unpull(key, res); return; }
    peer.sfuIn = { key, pull: res, video: res.video, audio: res.audio, videoRecv: res.videoRecv, audioRecv: res.audioRecv, one: pub.n === 1 };
    resolveTracks(peer);
    applyPlayoutBuffer();
    sendRelay(peer.id, { kind: 'sfu-pull', on: true });
    console.log(`servidor de vídeo: recebendo ${peer.name} pelo servidor`);
  } catch (e) {
    if (e.sfuLost) return; // a sessão foi refeita: sfuRecover puxa de novo
    // continua pela conexão direta; tenta de novo daqui a pouco (no máx. 3 vezes por transmissão)
    const n = peer.sfuFail && peer.sfuFail.key === key ? peer.sfuFail.n + 1 : 1;
    peer.sfuFail = { key, n, at: Date.now() };
    state.sfuLastErr = `receber ${peer.name}: ${e.message}`;
    console.warn(`servidor de vídeo: não deu para receber ${peer.name} (tentativa ${n}): ${e.message}`);
    if (n < 3) setTimeout(() => sfuPullSync(peer), 10000 * n + 500);
    else toast(`Não deu para receber ${peer.name} pelo servidor de vídeo (${e.message}). Continuando direto.`, 'error');
  }
}

// Recebendo pelo servidor com a rede até mim reclamando:
//  - avisa quem transmite (na nativa pelo servidor a imagem é uma só e ele baixa o bitrate);
//  - com 3 qualidades: 2 medições ruins seguidas -> qualidade média por 30 s (60 s, 120 s... se
//    voltar a reclamar logo depois de subir), depois tenta a cheia de novo.
function sfuRxFeedback(peer, bad) {
  if (bad) sendRelay(peer.id, { kind: 'sfu-rx', bad: true });
  if (peer.sfuIn.one) return;
  peer.sfuBadN = bad ? (peer.sfuBadN || 0) + 1 : 0;
  if (peer.sfuBadN < 2 || Date.now() < (peer.sfuCapUntil || 0)) return;
  peer.sfuBadN = 0;
  const again = peer.sfuCapEnd && Date.now() - peer.sfuCapEnd < 60000;
  peer.sfuCapMs = again ? Math.min(240000, (peer.sfuCapMs || 30000) * 2) : 30000;
  peer.sfuCapUntil = Date.now() + peer.sfuCapMs;
  peer.sfuCapEnd = peer.sfuCapUntil;
  console.log(`servidor de vídeo: rede até mim apertada, recebendo ${peer.name} na qualidade média por ${peer.sfuCapMs / 1000} s`);
  sfuPullSync(peer);
  setTimeout(() => sfuPullSync(peer), peer.sfuCapMs + 200);
}

// A conexão com o servidor de vídeo caiu/travou (sfu.js já jogou a sessão fora). Antes: tela preta
// para todo mundo até sair e entrar na sala. Agora: na hora volta para a conexão direta (quem assiste
// avisa quem transmite, que volta a mandar direto) e em 1,5 s refaz tudo numa sessão nova. Caiu 3
// vezes em 3 min: servidor instável, fica 5 min só na conexão direta.
window.Sfu.onLost = (why) => sfuRecover(why, true);
function sfuRecover(why, count) {
  const now = Date.now();
  state.sfuLastErr = `conexão perdida: ${why}`;
  let pause = false;
  if (count) {
    state.sfuLosses = (state.sfuLosses || []).filter((t) => now - t < 180000);
    state.sfuLosses.push(now);
    if (state.sfuLosses.length >= 3) {
      pause = true;
      state.sfuLosses = [];
      state.sfuPauseUntil = now + 300000;
      toast('O servidor de vídeo está instável: usando a conexão direta pelos próximos 5 minutos.', 'error');
    } else if (state.share && state.share.sfu) toast('Conexão com o servidor de vídeo caiu: reconectando...');
  }
  for (const peer of state.peers.values()) {
    peer.sfuFail = null;
    peer.sfuStall = null;
    if (peer.sfuIn) { peer.sfuIn = null; resolveTracks(peer); sendRelay(peer.id, { kind: 'sfu-pull', on: false }); }
  }
  if (state.share && state.share.sfu) {
    state.share.sfu = null;
    window.NativeVideo.setMode('sfu', false, false);
    for (const peer of state.peers.values()) { peer.sfuPulling = false; applySendParams(peer); sendState(peer.id); }
  }
  const again = () => {
    if (state.leaving || $('#room').classList.contains('hidden')) return;
    sfuSync();
    for (const peer of state.peers.values()) sfuPullSync(peer);
  };
  setTimeout(again, pause ? 300500 : 1500);
}

// Recebendo pelo servidor e nada chega há 6 s (com quem transmite capturando normalmente): recebe
// direto na hora e tenta o servidor de novo em 10 s (3 vezes por transmissão, depois fica direto).
async function sfuStallWatch() {
  const now = Date.now();
  for (const peer of state.peers.values()) {
    const sin = peer.sfuIn;
    if (!sin || !sin.videoRecv || !peer.sharing) { peer.sfuStall = null; continue; }
    let bytes = 0;
    try { (await sin.videoRecv.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') bytes = r.bytesReceived || 0; }); } catch { continue; }
    if (peer.sfuIn !== sin) continue;
    const s = peer.sfuStall;
    if (!s || s.key !== sin.key || s.bytes !== bytes) { peer.sfuStall = { key: sin.key, bytes, at: now }; continue; }
    const h = peer.health || {};
    if (now - s.at < 6000 || (h.cap != null && h.cap < 5)) continue; // tela parada de verdade: não é queda
    console.warn(`servidor de vídeo: nada chega de ${peer.name} há ${Math.round((now - s.at) / 1000)} s; recebendo direto`);
    sfuFallback(peer);
  }
}
function sfuFallback(peer) {
  const sin = peer.sfuIn;
  if (!sin) return;
  const prevN = peer.sfuFail && peer.sfuFail.key === sin.key ? peer.sfuFail.n : 0;
  peer.sfuFail = { key: sin.key, n: prevN + 1, at: Date.now() };
  peer.sfuStall = null;
  peer.sfuIn = null;
  resolveTracks(peer);
  sendRelay(peer.id, { kind: 'sfu-pull', on: false });
  window.Sfu.unpull(sin.key, sin.pull).catch(() => {});
  if (prevN + 1 < 3) setTimeout(() => sfuPullSync(peer), 10000 * (prevN + 1) + 500);
}

// ---- tela do amigo parada em 0 fps (nenhum quadro novo) com ele transmitindo normalmente.
// Antes só voltava saindo e entrando na sala. Agora, em degraus, até a imagem voltar:
//  3 s: pede um quadro completo para quem transmite (quadros-chave agora são raros: 30 s);
//  9 s: refaz o caminho do vídeo (servidor -> direto; direto -> reinicia a conexão de rede);
//  20 s: refaz a conexão inteira com esse amigo (o mesmo que sair e entrar, só com ele).
function freezeWatch(peer, decodedD) {
  if (window.__fakeFreeze === peer.name) decodedD = 0; // teste automático
  const h = peer.health || {};
  // a tela dele está parada de verdade (nada para mandar): não é travamento
  const idle = (h.out != null && h.out < 2) || (h.cap != null && h.cap < 5);
  if (decodedD !== 0 || idle || peer.iWant === 'off' || peer.conn === 'new') {
    if (peer.frozen && peer.frozen.step && decodedD > 0) console.log(`tela de ${peer.name} voltou`);
    if (decodedD !== 0 || idle) peer.frozen = null;
    return;
  }
  // trocando de rota agora (Radmin <-> internet): a imagem parar um pouco é normal; espera
  if (performance.now() - (peer.routeSince || 0) < 15000) return;
  const now = Date.now();
  const f = peer.frozen || (peer.frozen = { since: now, step: 0 });
  const t = now - f.since;
  if (f.step < 1 && t >= 3000) {
    f.step = 1;
    console.warn(`tela de ${peer.name} parada: pedindo um quadro completo`);
    sendRelay(peer.id, { kind: 'need-key' });
  } else if (f.step < 2 && t >= 9000) {
    f.step = 2;
    console.warn(`tela de ${peer.name} parada há 9 s: refazendo o caminho do vídeo`);
    sendRelay(peer.id, { kind: 'need-key' });
    if (peer.sfuIn) sfuFallback(peer);
    else { try { peer.pc.restartIce(); } catch (e) { console.warn('reiniciar ICE', e); } }
  } else if (f.step < 3 && t >= 20000) {
    f.step = 3;
    if (peer.canRebuild && rebuildPeer(peer.id, true)) toast(`A tela de ${peer.name} travou: refazendo a conexão com ${peer.name}...`);
  } else if (f.step >= 3 && t >= 60000) peer.frozen = null; // começa os degraus de novo
}

// Quem transmite: um quadro completo agora (a imagem parou em alguém)
function sendKeyFrame(peer) {
  const sh = state.share;
  if (!sh) return;
  if (sh.direct) { window.NativeVideo.key(peer.sendLayer === 1 ? 1 : 0); return; }
  const senders = [peer.vT.sender];
  if (sh.sfu && window.Sfu.pubSender()) senders.push(window.Sfu.pubSender());
  for (const s of senders) { try { if (s.track && s.generateKeyFrame) s.generateKeyFrame().catch(() => {}); } catch {} }
}

// Refaz a conexão com um amigo do zero (os dois lados). tell = fui eu que pedi.
const rebuiltAt = new Map(); // nome -> quando pedi por último
function rebuildPeer(id, tell) {
  const peer = state.peers.get(id);
  if (!peer) return false;
  if (tell) {
    const last = rebuiltAt.get(peer.name) || 0;
    if (Date.now() - last < 45000) return false;
    rebuiltAt.set(peer.name, Date.now());
    sendRelay(id, { kind: 'rebuild' }); // chega antes da oferta da conexão nova (mesma fila)
  }
  console.warn(`refazendo a conexão com ${peer.name}${tell ? '' : ' (pedido dele)'}`);
  const name = peer.name;
  removePeer(id);
  createPeer(id, name);
  return true;
}
setInterval(() => { sfuStallWatch().catch(() => {}); }, 2000);

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  if (peer.sfuIn) { window.Sfu.unpull(peer.sfuIn.key, peer.sfuIn.pull).catch(() => {}); peer.sfuIn = null; }
  if (histOpen === id) closeHistory();
  closeMenus();
  peer.pc.close();
  window.NativeVideo.remove(id);
  closeOverlay(id);
  window.Clips.stop(id);
  if (window.Clips.isRecording(id)) toggleRecording(id); // saiu da sala: salva o que foi gravado
  if (readyCheck) setTimeout(() => {               // "todo mundo pronto?": quem saiu não conta mais
    if (!readyCheck) return;
    renderReady();
    if (memberIds().every((m) => readyCheck.ready.has(m))) countdown();
  }, 0);
  if (peer.tile) { peer.tile.el.remove(); if (peer.tile.audio) peer.tile.audio.destroy(); }
  state.peers.delete(id);
  state.order = state.order.filter((x) => x !== id);
  state.hidden.delete(id);
  if (state.focusId === id) state.focusId = null;
  render();
}

function sendState(to) {
  const peer = state.peers.get(to);
  sendRelay(to, {
    kind: 'state',
    sharing: !!state.share,
    audio: !!(state.share && state.share.audio),
    audioWhy: state.share ? state.share.audioWhy || '' : '',
    sourceName: state.share ? state.share.sourceName : '',
    cam: !!state.camera,
    // ids dos streams desta conexão: quem recebe separa tela de câmera
    screenId: peer ? peer.screenMS.id : null,
    camId: peer ? peer.camMS.id : null,
    h265: window.Sdp.hasH265(), // decodifico H.265? (decide o codec da "Nativa direta")
    av1: window.Sdp.hasAV1Hw(), // decodifico AV1 pela placa?
    share2: !!state.share2,
    share2Name: state.share2 ? state.share2.sourceName : '',
    s2Id: peer ? peer.s2MS.id : null,
    sfu: state.share && state.share.sfu ? state.share.sfu : null, // transmitindo pelo servidor de vídeo
    rb: 1, // sei refazer a conexão a pedido ("rebuild")
    sfu2: 1, // puxo H.265/AV1 pelo servidor de vídeo (conexão de receber separada da de publicar)
  });
}

// Decide qual trilha de vídeo recebida é a tela e qual é a câmera
function resolveTracks(peer) {
  let screen = null, cam = null;
  if (peer.remoteScreenId || peer.remoteCamId) {
    screen = peer.videoTracks.get(peer.remoteScreenId) || null;
    cam = peer.videoTracks.get(peer.remoteCamId) || null;
  } else if (peer.videoTracks.size) {
    screen = [...peer.videoTracks.values()][0]; // amigo em versão antiga: só tela
  }
  if (peer.sfuIn && peer.sfuIn.video) screen = peer.sfuIn.video; // vindo pelo servidor de vídeo
  const st = peer.remoteStream;
  // som: o do servidor quando a tela vem por lá; senão o da conexão direta
  const wantA = (peer.sfuIn && peer.sfuIn.audio) || peer.p2pAudio || null;
  if (wantA && !st.getAudioTracks().includes(wantA)) {
    for (const t of st.getAudioTracks()) st.removeTrack(t);
    st.addTrack(wantA);
  }
  if (screen && !st.getVideoTracks().includes(screen)) {
    for (const t of st.getVideoTracks()) st.removeTrack(t);
    st.addTrack(screen);
  }
  const cs = peer.camStream;
  if (cam && !cs.getVideoTracks().includes(cam)) {
    for (const t of cs.getVideoTracks()) cs.removeTrack(t);
    cs.addTrack(cam);
  }
  const s2 = peer.remoteS2Id ? peer.videoTracks.get(peer.remoteS2Id) : null;
  const ss = peer.screen2Stream;
  if (s2 && !ss.getVideoTracks().includes(s2)) {
    for (const t of ss.getVideoTracks()) ss.removeTrack(t);
    ss.addTrack(s2);
  }
  if (peer.tile) updateTileMedia(peer.id);
}

// Ajusta o que eu envio para cada amigo conforme o que ele está vendo:
//  full  = tela em destaque/grade -> qualidade total
//  thumb = miniatura             -> resolução e bitrate baixos
//  off   = ocultou minha tela    -> não envia nada (economiza banda)
function applySendParams(peer) {
  // em fila: chamadas simultâneas se atropelavam no replaceTrack
  peer.sendQueue = (peer.sendQueue || Promise.resolve()).then(() => doApplySendParams(peer)).catch((e) => console.warn(e));
  return peer.sendQueue;
}

async function doApplySendParams(peer) {
  if (peer.pc.signalingState === 'closed') return;
  const share = state.share;
  const level = peer.theyWant;
  const vSender = peer.vT.sender;
  const aSender = peer.aT.sender;

  const viaSfu = !!(share && share.sfu && peer.sfuPulling); // recebe pelo servidor de vídeo
  const wantVideo = share && level !== 'off' && !viaSfu ? share.video : null;
  const wantAudio = share && level !== 'off' && !viaSfu ? share.audio || null : null;

  // modo nativo: o vídeo precisa sair em H.264 e passar pelo transform que injeta nossos quadros
  const native = !!(share && share.direct); // envio direto do H.264 nativo
  const codecMode = native ? directCodecMode(share.codec) : state.settings.codec;
  if (peer.codecMode !== codecMode) {
    setCodec(peer, codecMode);
    negotiate(peer);
    // o 1º keyframe pode sair ainda no codec antigo (renegociação em andamento) e quem assiste
    // ficaria esperando outro: pede mais alguns logo depois da troca
    if (native) for (const ms of [800, 1800, 3500]) setTimeout(() => { if (state.share && state.share.direct) window.NativeVideo.key(peer.sendLayer === 1 ? 1 : 0); }, ms);
  } else if (native && wantVideo && peer.pc.connectionState === 'connected' && performance.now() - (peer.rateNegAt || 0) > 8000) {
    // os limites de banda combinados com este amigo são de antes desta transmissão (ou de uma
    // qualidade menor): renegocia para o teto da estimativa de banda ficar acima do que a placa manda
    const ro = rateOpts(peer);
    if (!peer.sdpNative || (peer.sdpMax || 0) < ro.maxKbps * 0.95) { peer.rateNegAt = performance.now(); negotiate(peer); }
  }
  // "Nativa direta" com a versão leve: quem vê em miniatura, escolheu 540p ou menos ou está com a rede fraca recebe a
  // leve (cada camada tem a sua trilha vazia; trocar de trilha recomeça o envio dele num keyframe da camada nova)
  const layer = native && share.videoLight && wantVideo && wantsLight(peer) ? 1 : 0;
  if (native && wantVideo && (peer.sendLayer || 0) !== layer) console.log(`versão leve: ${peer.name} passa a receber a ${layer ? 'leve' : 'cheia'}`);
  peer.sendLayer = wantVideo ? layer : 0;
  const sendVideo = layer === 1 ? share.videoLight : wantVideo;
  // antes de trocar a trilha: assim o primeiro quadro já é tratado no modo certo
  if (native) window.NativeVideo.setLayer(peer.id, layer);
  window.NativeVideo.setMode(peer.id, native, !!wantVideo && peer.pc.connectionState === 'connected');
  if (vSender.track !== sendVideo) await vSender.replaceTrack(sendVideo).catch(() => {});
  if (aSender.track !== wantAudio) await aSender.replaceTrack(wantAudio).catch(() => {});
  // câmera (independe de estar compartilhando a tela)
  const wantCam = state.camera && level !== 'off' ? state.camera.track : null;
  if (peer.cT.sender.track !== wantCam) await peer.cT.sender.replaceTrack(wantCam).catch(() => {});
  // 2ª tela: só para quem pediu (miniatura no canto ou trocada para a principal)
  const s2 = state.share2;
  const want2 = s2 && share && level !== 'off' ? peer.theyWant2 || 'off' : 'off';
  const wantS2 = want2 !== 'off' ? s2.video : null;
  if (peer.s2T.sender.track !== wantS2) await peer.s2T.sender.replaceTrack(wantS2).catch(() => {});
  if (wantS2) {
    try {
      const p2 = peer.s2T.sender.getParameters();
      if (!p2.encodings || !p2.encodings.length) p2.encodings = [{}];
      const h2 = s2.video.getSettings().height || 1080;
      const e2 = p2.encodings[0];
      if (want2 === 'thumb') { e2.scaleResolutionDownBy = Math.max(1, h2 / 540); e2.maxBitrate = 1_500_000; }
      else { e2.scaleResolutionDownBy = 1; e2.maxBitrate = Math.round(Math.min(12, Math.max(4, perPeerMbps(share.settings.bitrate, peer) * 0.5)) * 1e6); }
      e2.maxFramerate = 30;
      p2.degradationPreference = 'maintain-resolution';
      await peer.s2T.sender.setParameters(p2);
    } catch (e) { console.warn('2ª tela setParameters', e); }
  }
  if (!share) return;

  const s = share.settings;
  const height = share.height || share.video.getSettings().height || 1080;
  try {
    const params = vSender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    if (native) {
      // a trilha vazia nunca pode ser descartada pelo limitador de FPS do Chromium
      enc.scaleResolutionDownBy = 1;
      enc.maxBitrate = Math.round(s.bitrate * 1.5e6);
      enc.maxFramerate = 240;
    } else if (level === 'thumb') {
      enc.scaleResolutionDownBy = Math.max(1, height / 360);
      enc.maxBitrate = 1_000_000;
      enc.maxFramerate = 30;
    } else if (state.lightMode) {
      // PC no limite: 30 fps e no máximo 720p para não engasgar
      enc.scaleResolutionDownBy = Math.max(1, height / Math.min(720, peer.theyWantH || 720, peer.smartH || 720));
      enc.maxBitrate = capBitrateForHeight(perPeerMbps(s.bitrate, peer), peer.theyWantH) * 1e6;
      enc.maxFramerate = Math.min(30, Number(s.fps));
    } else {
      // quem assiste pode escolher uma resolução menor (PC fraco, economizar): só para ele
      // e a rede até ele pode estar apertada (resolução inteligente)
      const capH = Math.min(peer.theyWantH || Infinity, peer.smartH || Infinity);
      enc.scaleResolutionDownBy = isFinite(capH) ? Math.max(1, height / capH) : 1;
      enc.maxBitrate = capBitrateForHeight(perPeerMbps(s.bitrate, peer), peer.theyWantH) * 1e6;
      enc.maxFramerate = Number(s.fps);
    }
    enc.priority = 'high';
    enc.networkPriority = 'high';
    params.degradationPreference = native || s.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    await vSender.setParameters(params);
  } catch (e) {
    console.warn('setParameters', e);
  }
  try {
    const ap = aSender.getParameters();
    if (ap.encodings && ap.encodings.length) {
      ap.encodings[0].maxBitrate = 256_000;
      ap.encodings[0].priority = 'high';
      await aSender.setParameters(ap);
    }
  } catch {}
}

// ------------------------------------------------------------------ versão leve da "Nativa direta" (2ª qualidade)
// Na direta a imagem é uma só para todos: quem via em miniatura levava uma cópia cheia do upload, e um amigo de rede
// fraca puxava o bitrate de todo mundo para baixo. O helper codifica também uma versão leve (960x540, 30 fps, num
// segundo encoder) e cada amigo recebe uma das duas (doApplySendParams). O controle de bitrate (adaptNativeBitrate)
// decide a cheia só por quem está nela; a leve acompanha a pior rede entre quem está nela.
const LIGHT = { maxWidth: 960, maxHeight: 540, fps: 30 };
function lightKbps(codec) { return codec === 'h264' ? 1800 : 1300; } // teto da leve (o encoder começa nele)
function lightLayerOn() { return localStorage.getItem('lightLayer') !== '0'; }
// recebe a leve: vê a minha tela em miniatura, escolheu 540p ou menos, ou está com a rede fraca (markWeak)
function wantsLight(peer) {
  return peer.theyWant === 'thumb' || (peer.theyWantH > 0 && peer.theyWantH <= 540) || Date.now() < (peer.weakUntil || 0);
}
// a rede até este amigo não dá conta da cheia enquanto a dos outros dá: ele vai para a leve por um tempo e depois tenta
// a cheia de novo (1, 2, 4 e até 8 min se cair de novo logo depois de voltar)
function markWeak(peer, now = Date.now()) {
  const again = peer.weakEnd && now - peer.weakEnd < 120000;
  peer.weakMs = again ? Math.min(480000, (peer.weakMs || 60000) * 2) : 60000;
  peer.weakUntil = now + peer.weakMs;
  peer.weakEnd = peer.weakUntil;
  peer.weakN = 0;
  console.log(`versão leve: a rede até ${peer.name} não dá conta da tela cheia; ele recebe a leve por ${peer.weakMs / 1000} s`);
  if (!peer.weakToastAt || now - peer.weakToastAt > 600000) {
    peer.weakToastAt = now;
    toast(`A rede até ${peer.name} está fraca: ele passa a receber uma versão mais leve da sua tela, e os outros continuam no máximo.`);
  }
  applySendParams(peer);
  setTimeout(() => applySendParams(peer), peer.weakMs + 200);
}

// ------------------------------------------------------------------ orçamento de upload
// Na malha, cada amigo assistindo recebe uma cópia: 80 Mb/s escolhidos com 3 amigos viravam 240 Mb/s
// e entupiam o upload/Radmin (atraso de segundos, imagem caindo para 180p). O total fica dentro do
// orçamento (medido no "Testar conexão"; padrão 60 Mb/s) e é dividido entre quem assiste em tela cheia.
const DEFAULT_UPLOAD_MBPS = 60;
function uploadBudgetMbps() { return Number(state.settings.uploadMbps) || DEFAULT_UPLOAD_MBPS; }
function fullViewers() {
  return [...state.peers.values()].filter((p) => p.theyWant !== 'off' && p.theyWant !== 'thumb' && p.pc.connectionState !== 'closed').length;
}
// bitrate (Mb/s) que cada amigo recebe agora. Com "peer": também respeita o que foi medido
// até ele (às vezes a rede de um amigo é pior que a dos outros)
function perPeerMbps(settingMbps, peer) {
  const want = Number(settingMbps) || 20;
  const share = Math.max(1, fullViewers());
  let v = Math.min(want, Math.floor(uploadBudgetMbps() / share));
  // a medição pelo canal de dados costuma sair ABAIXO do real (é um piso): só limita quando ela
  // mostra uma ligação claramente fraca com esse amigo
  if (peer && peer.upMbps && peer.upMbps < 30) v = Math.min(v, Math.floor(peer.upMbps * 0.75 * (peer.measBoost || 1)));
  return Math.max(3, v);
}

// A medição do upload até um amigo deu pouco e virou o teto dele, mas ela costuma sair ABAIXO do
// real (nos registros: 3,2 Mb/s medidos num caminho que levava bem mais, e a tela ficava presa em
// 3 Mb/s). Quando o envio está encostado nesse teto, sem perda, e o próprio WebRTC estima folga acima
// dele por ~10 s, o teto sobe 30% (e renegocia os limites de banda). Se a rede reclamar, desce.
// Só na captura adaptativa/Chromium: na "Nativa direta" a medição define só o começo.
async function liftMeasuredCaps() {
  const share = state.share;
  if (!share || share.direct) return;
  const cap = perPeerMbps(share.settings.bitrate); // sem a medição
  for (const peer of state.peers.values()) {
    if (!peer.upMbps || peer.upMbps >= 30 || !peer.vT.sender.track || peer.pc.connectionState !== 'connected' || peer.theyWant !== 'full' || peer.theyWantH) continue;
    const limit = perPeerMbps(share.settings.bitrate, peer);
    if (limit >= cap && (peer.measBoost || 1) === 1) continue;
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    let avail = 0, out = null, loss = 0;
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.availableOutgoingBitrate) avail = r.availableOutgoingBitrate / 1000;
      if (r.type === 'outbound-rtp' && r.kind === 'video' && String(r.mid) === String(peer.vT.mid)) out = r;
    });
    if (!out) continue;
    report.forEach((r) => { if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && r.localId === out.id) loss = r.fractionLost || 0; });
    const now = performance.now(), prev = peer.liftTx;
    peer.liftTx = { t: now, b: out.bytesSent || 0 };
    if (!prev || now - prev.t > 6000) continue;
    const sent = ((peer.liftTx.b - prev.b) * 8) / (now - prev.t); // kb/s
    const full = limit < cap && sent >= limit * 800 && avail >= limit * 1150 && loss < 0.02 && out.qualityLimitationReason !== 'bandwidth';
    peer.liftOk = full ? (peer.liftOk || 0) + 1 : 0;
    peer.liftBad = loss > 0.05 ? (peer.liftBad || 0) + 1 : 0;
    if (peer.liftOk >= 5) {
      peer.liftOk = 0;
      peer.measBoost = (peer.measBoost || 1) * 1.3;
      console.log(`teto de ${peer.name}: ${limit} -> ${perPeerMbps(share.settings.bitrate, peer)} Mb/s (a rede até ele aguenta mais do que a medição de ${peer.upMbps} Mb/s indicou)`);
      applySendParams(peer);
      negotiate(peer); // o teto da estimativa de banda (x-google-max-bitrate) acompanha
      renderBudgetInfo();
    } else if (peer.liftBad >= 2 && (peer.measBoost || 1) > 1) {
      peer.liftBad = 0;
      peer.measBoost = Math.max(1, peer.measBoost / 1.3);
      applySendParams(peer);
    }
  }
}
setInterval(() => { liftMeasuredCaps().catch(() => {}); }, 2000);
// resolução menor pedida por quem assiste: não precisa de tantos bits (sobra upload para os outros)
function capBitrateForHeight(mbps, h) {
  if (!h) return mbps;
  return Math.min(mbps, h <= 480 ? 6 : h <= 720 ? 12 : h <= 1080 ? 30 : mbps);
}
// "Nativa direta": o mesmo vídeo vai para todos -> o menor teto entre quem assiste
function directMbps(settingMbps) {
  const viewers = [...state.peers.values()].filter((p) => p.theyWant !== 'off' && p.theyWant !== 'thumb');
  return viewers.length ? Math.min(...viewers.map((p) => perPeerMbps(settingMbps, p))) : perPeerMbps(settingMbps);
}

// ------------------------------------------------------------------ medição automática do upload
// Ao conectar com cada amigo, mede o envio até ele pelo canal de dados (~3 s) e ajusta sozinho o
// orçamento de upload e o teto daquele amigo. Resultado lembrado por 30 min (por nome).
const autoMeasured = new Map(); // nome -> { up (Mb/s), at }
let measureChain = Promise.resolve();
function scheduleAutoMeasure(peer) {
  if (localStorage.getItem('autoMeasure') === '0') return;
  // um lado mede antes do outro (não disputam o mesmo caminho ao mesmo tempo)
  // (espera a conexão assentar: logo no começo o vídeo está subindo e a medida sai baixa)
  const delay = (peer.polite ? 6000 : 16000) + Math.random() * 1500;
  setTimeout(() => { measureChain = measureChain.then(() => autoMeasure(peer)).catch(() => {}); }, delay);
}
async function outboundBytes(peer) {
  let b = 0;
  try { (await peer.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp') b += r.bytesSent || 0; }); } catch {}
  return b;
}
async function autoMeasure(peer) {
  if (!state.peers.has(peer.id) || !peer.dc || peer.dc.readyState !== 'open') return;
  // "Testar conexão" rodando: usa o mesmo canal; tenta de novo depois
  if (state.netTesting) { setTimeout(() => scheduleAutoMeasure(peer), 15000); return; }
  const prev = autoMeasured.get(peer.name);
  if (prev && Date.now() - prev.at < 30 * 60 * 1000) { peer.upMbps = prev.up; updateAutoBudget(); return; }
  state.autoMeasuring = true;
  try {
    // duas medidas curtas; vale a maior (a 1ª às vezes pega a conexão ainda acelerando)
    let best = 0;
    for (let i = 0; i < 2; i++) {
      const before = await outboundBytes(peer);
      const t0 = performance.now();
      const res = dcWait(peer, 'st-res', 12000);
      await stBlast(peer, 2000);
      const up = await res;
      const sec = (performance.now() - t0) / 1000;
      // o vídeo/áudio que já estava indo para ele também usa o upload: soma
      const media = (((await outboundBytes(peer)) - before) * 8) / sec;
      if (up) best = Math.max(best, up + media);
      if (!state.peers.has(peer.id)) return;
    }
    if (!best) return;
    peer.upMbps = Math.round((best / 1e6) * 10) / 10;
    autoMeasured.set(peer.name, { up: peer.upMbps, at: Date.now() });
    console.log(`upload medido até ${peer.name}: ${peer.upMbps} Mb/s`);
    updateAutoBudget();
  } catch (e) {
    console.warn(`medição automática com ${peer.name}: ${e.message}`);
  } finally {
    state.autoMeasuring = false;
  }
}
function updateAutoBudget() {
  const ups = [...state.peers.values()].map((p) => p.upMbps).filter(Boolean);
  if (ups.length) {
    // nunca abaixo do padrão: medir pouco não prova que a rede é fraca (o teste é um piso)
    state.settings.uploadMbps = Math.round(Math.min(150, Math.max(DEFAULT_UPLOAD_MBPS, Math.max(...ups) * 0.8)));
    saveSettings();
  }
  lastBudgetKey = ''; // reaplica os limites de todos
  refreshBudget();
  renderBudgetInfo();
}
function renderBudgetInfo() {
  const el = $('#adj-budget');
  if (!el) return;
  const measured = [...state.peers.values()].filter((p) => p.upMbps);
  const s = state.share ? state.share.settings : state.settings;
  el.textContent = measured.length
    ? `Upload medido: ${measured.map((p) => `${p.name} ${Math.round(p.upMbps)}`).join(' · ')} Mb/s → ` +
      `${measured.map((p) => `${p.name} até ${perPeerMbps(s.bitrate, p)}`).join(' · ')} Mb/s (automático)`
    : `Orçamento de upload: ${uploadBudgetMbps()} Mb/s (medindo com os amigos...)`;
}
let lastBudgetKey = '';
function refreshBudget() {
  // mudou quem assiste: reaplica os limites de todos (sem renegociar)
  const key = `${fullViewers()}|${uploadBudgetMbps()}`;
  if (key === lastBudgetKey) return;
  lastBudgetKey = key;
  for (const peer of state.peers.values()) applySendParams(peer);
}
setInterval(refreshBudget, 3000);

// ------------------------------------------------------------------ compartilhar
const RES = { 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };
let sources = [];
let selectedSource = null;
let sourceTab = 'screen';

// esconde opções que não fazem efeito no tipo de captura escolhido
function updateEngineFields() {
  const direct = $('#opt-engine').value === 'native-direct';
  $('#opt-codec').closest('.field').classList.toggle('hidden', direct); // direta escolhe sozinha (AV1 > H.265 > H.264)
}

async function openShareModal(second = false) {
  state.pickSecond = second === true;
  $('#share-modal').classList.toggle('second', state.pickSecond);
  $('#share-title').textContent = state.pickSecond ? 'Escolha a 2ª tela' : 'O que compartilhar';
  $('#share-note').textContent = state.pickSecond
    ? 'A 2ª tela vai a 30 fps e aparece no canto da sua tela principal para os amigos (cada um pode trocar).' : '';
  $('#share-modal').classList.remove('hidden');
  const s = state.settings;
  $('#opt-engine').value = s.engine || 'native';
  updateEngineFields();
  $('#opt-res').value = s.res;
  $('#opt-fps').value = String(s.fps);
  $('#opt-mode').value = s.mode;
  $('#opt-codec').value = s.codec;
  $('#opt-bitrate').value = s.bitrate;
  setMbps($('#opt-bitrate-label'), s.bitrate);
  window.Themes.syncSelects();
  window.Themes.paintRanges();
  $('#btn-start-share').textContent = state.pickSecond ? 'Transmitir como 2ª tela' : state.share ? 'Trocar' : 'Compartilhar';
  selectedSource = null;
  updateRegionUi();
  $('#btn-start-share').disabled = true;
  sourcesLoaded = { screen: false, window: false };
  renderSources();
  // janelas só quando a aba "Janelas" for aberta (gerar as miniaturas delas é o mais pesado)
  await Promise.all([loadSources(sourceTab), loadAudioOptions()]);
}

let sourcesLoaded = { screen: false, window: false };
const sourcesLoading = {};
async function loadSources(type) {
  if (sourcesLoading[type]) return sourcesLoading[type];
  sourcesLoading[type] = window.native.captureSources(type);
  let list;
  try { list = await sourcesLoading[type]; } finally { sourcesLoading[type] = null; }
  sources = [...sources.filter((x) => x.type !== type), ...list];
  sourcesLoaded[type] = true;
  renderSources();
}

function renderSources() {
  const box = $('#sources');
  box.innerHTML = '';
  const list = sources.filter((x) => x.type === sourceTab);
  if (!sourcesLoaded[sourceTab] && !list.length) box.innerHTML = '<p class="muted pad">Carregando...</p>';
  else if (!list.length) box.innerHTML = '<p class="muted pad">Nada encontrado.</p>';
  for (const src of list) {
    const el = document.createElement('button');
    el.className = 'source';
    if (selectedSource && selectedSource.id === src.id) el.classList.add('selected');
    const label = document.createElement('div');
    label.className = 'source-name';
    if (src.icon) {
      const ic = document.createElement('img');
      ic.src = src.icon;
      label.appendChild(ic);
    }
    const text = document.createElement('span');
    text.textContent = src.name;
    label.appendChild(text);
    if (src.size && src.size.width) { // só alguns temas mostram
      el.style.setProperty('--sw', src.size.width);
      el.style.setProperty('--sh', src.size.height);
      el.style.setProperty('--sw-t', `"${src.size.width}"`);
      el.style.setProperty('--sh-t', `"${src.size.height}"`);
      const sz = document.createElement('span');
      sz.className = 'source-size theme-only';
      sz.textContent = `${src.size.width} × ${src.size.height}`;
      label.appendChild(sz);
    }
    if (src.type === 'window') {
      // janelas: só ícone + nome (sem miniatura = rápido e não pesa na transmissão)
      el.classList.add('window');
      if (!src.icon) {
        const ph = document.createElement('div');
        ph.className = 'source-icon-ph';
        ph.textContent = (src.name || '?').trim().charAt(0).toUpperCase();
        label.prepend(ph);
      }
      el.append(label);
    } else {
      const img = document.createElement('div');
      img.className = 'source-thumb';
      if (src.thumbnail) img.style.backgroundImage = `url("${src.thumbnail}")`;
      el.append(img, label);
    }
    el.onclick = () => {
      selectedSource = src;
      $('#btn-start-share').disabled = false;
      renderSources();
      updateRegionUi();
    };
    el.ondblclick = () => startFromModal();
    box.appendChild(el);
  }
  paintShareSum();
}

// área da tela (só telas inteiras, captura nativa): fica guardada na fonte escolhida
function updateRegionUi() {
  const src = selectedSource;
  const isScreen = !!(src && src.type === 'screen');
  $('#btn-region').classList.toggle('hidden', !isScreen);
  $('#btn-region-clear').classList.toggle('hidden', !(isScreen && src.crop));
  $('#btn-region').textContent = isScreen && src.crop ? 'Trocar área...' : 'Escolher área...';
  if (!state.pickSecond) $('#share-note').textContent = isScreen && src.crop
    ? `Só uma área: ${Math.round(src.crop.w * 100)}% × ${Math.round(src.crop.h * 100)}% da tela`
    : '';
  paintShareSum();
}

async function pickRegion() {
  const src = selectedSource;
  if (!src || src.type !== 'screen') return;
  const rect = await window.native.pickRegion(src.displayId);
  if (rect) {
    src.crop = rect;
    if ($('#opt-engine').value === 'chromium') { $('#opt-engine').value = 'native'; updateEngineFields(); }
  }
  updateRegionUi();
}

async function loadAudioOptions() {
  const sel = $('#opt-audio');
  const available = await window.native.audioAvailable();
  sel.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };
  add('none', 'Sem áudio');
  if (!available) {
    $('#share-note').textContent = 'AudioHelper.exe não encontrado: compartilhamento de áudio indisponível.';
    sel.value = 'none';
    return;
  }
  add('all-except', 'Todo o som do PC, exceto Discord');
  // já deixa o valor certo (a lista de apps demora; compartilhar antes não pode virar "sem áudio")
  sel.value = state.settings.audio === 'none' ? 'none' : 'all-except';
  const res = await window.Helper.list().catch(() => ({}));
  state.audioDevices = [];
  if (res.type === 'list') {
    for (const a of res.apps) {
      if (a.discord) continue;
      add(`app:${a.pid}`, `Só: ${a.name}`);
    }
    // saídas de som inteiras: Sonar/Voicemeeter têm um canal só do jogo (ex.: "Sonar - Gaming")
    state.audioDevices = res.devices || [];
    for (const d of state.audioDevices) add(`dev:${d.id}`, `Saída: ${d.name}${d.isDefault ? ' (padrão)' : ''}`);
  }
  const saved = state.settings.audio;
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : 'all-except';
  sel.onchange = updateAudioNote;
  updateAudioNote();
  paintShareSum();
}

// aviso embaixo das opções: capturar uma saída onde o próprio app toca = amigos ouvem eco
function updateAudioNote() {
  if (state.pickSecond) return;
  const v = $('#opt-audio').value;
  const dev = v.startsWith('dev:') ? (state.audioDevices || []).find((d) => `dev:${d.id}` === v) : null;
  const note = $('#share-note');
  if (dev && (dev.self || dev.isDefault)) {
    note.textContent = `Atenção: o som deste app (telas dos amigos) ${dev.self ? 'toca' : 'pode tocar'} em "${dev.name}" e voltaria para eles como eco. ` +
      'No Sonar/Voicemeeter, mande o Tela Amigos para outro canal (ex.: Chat ou Media) e deixe só o jogo nessa saída.';
  } else if (dev) {
    note.textContent = `Vai todo o som que toca em "${dev.name}" (ex.: o canal de jogo do Sonar/Voicemeeter).`;
  } else {
    note.textContent = 'O som deste app (telas dos amigos) nunca é enviado de volta.';
  }
}

function readSettings() {
  const s = state.settings;
  s.engine = $('#opt-engine').value;
  s.res = $('#opt-res').value;
  s.fps = Number($('#opt-fps').value);
  s.mode = $('#opt-mode').value;
  s.codec = $('#opt-codec').value;
  s.bitrate = Number($('#opt-bitrate').value);
  s.audio = $('#opt-audio').value;
  saveSettings();
  return { ...s };
}

// botão/duplo clique do modal: tela principal ou 2ª tela (conforme o modal foi aberto)
function startFromModal() {
  if (!selectedSource) return;
  if (state.pickSecond) startSecond(selectedSource);
  else startShare();
}

// overrides: ex. { engine: 'chromium' } quando a captura nativa caiu várias vezes
// overrides.keep: reinício automático da transmissão que está no ar (parte das configurações dela)
let shareBusy = false;
// Muda a cada "Parar"/"Sair". Um início que ainda estava abrindo a captura confere e desiste: antes
// ele terminava depois e a transmissão voltava sozinha (ou ficava ligada, escondida, fora da sala, e
// ia ao ar na próxima sala em que a pessoa entrasse).
let shareGen = 0;
async function startShare(overrides) {
  if (shareBusy || !selectedSource) return; // evita dois inícios ao mesmo tempo (duplo clique)
  // fora de uma sala não há para quem transmitir (o modal de escolher a tela pode ter ficado aberto)
  if ($('#room').classList.contains('hidden')) return;

  shareBusy = true;
  try {
    await startShareInner(overrides && !(overrides instanceof Event) ? overrides : null);
  } finally {
    shareBusy = false;
  }
}

// O início foi cancelado no meio ("Parar"/"Sair"): fecha o que já tinha sido aberto. Para o helper o
// pedido de parar vai direto, de novo: se o "Parar" chegou entre o pedido e o começo de fato da
// captura, o parar foi na frente e a captura ficaria ligada sem ninguém para receber.
async function cancelStart(tried, stream) {
  if (tried.native) {
    try { await window.NativeVideo.stop(); } catch {}
    try { await window.Helper.videoStop(); } catch {}
  }
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
  if (tried.audio) {
    try { await window.HelperAudio.stop(); } catch {}
    try { await window.Helper.audioStop(); } catch {}
  }
  $('#btn-start-share').disabled = false;
}

async function startShareInner(overrides) {
  const gen = shareGen;
  // Reinício automático (troca de codec, resolução pela rede, captura que caiu...): parte do que
  // está no ar. Antes relia os campos do modal de compartilhar, e o que a pessoa tivesse deixado
  // marcado lá sem confirmar passava a valer (até o som: "só o jogo" virava "todo o som do PC" se
  // o programa não estivesse mais na lista).
  let base;
  if (overrides && overrides.keep && state.share) {
    base = { ...state.share.settings };
    delete base.startKbps; // só vale para o reinício que o pediu
  } else base = readSettings();
  const settings = { ...base, ...(overrides || {}) };
  delete settings.keep;
  const src = selectedSource;
  $('#btn-start-share').disabled = true;
  // área da tela só existe na captura nativa
  if (src.crop && settings.engine === 'chromium') settings.engine = 'native';

  let [maxW, maxH] = RES[settings.res] || [3840, 2160];
  if (settings.res === 'native' && src.size) { maxW = src.size.width; maxH = src.size.height; }
  // resolução inteligente (direta): rede apertada -> menos pixels, imagem mais limpa
  if (settings.smartH && settings.fullH > settings.smartH) {
    maxW = Math.round(settings.fullW * settings.smartH / settings.fullH / 2) * 2;
    maxH = settings.smartH;
  }

  // para a captura anterior antes de começar a nova (o helper só tem um encoder)
  const old = state.share;
  if (old && old.native) await window.NativeVideo.stop();

  // native        = captura nativa 60 fps + WebRTC recodifica e se adapta à rede (padrão)
  // native-direct = envia o H.264 nativo direto (máxima qualidade, só para rede perfeita)
  // pelo servidor de vídeo: a nativa direta manda a imagem da placa UMA vez para o servidor (como o
  // Discord); a adaptativa manda 3 qualidades feitas pelo Chromium
  const direct = settings.engine === 'native-direct';
  let stream, video, preview, nativeInfo = null;
  const tried = { native: false, audio: false }; // o que este início chegou a pedir ao helper
  if (settings.engine.startsWith('native') && state.nativeStuck) {
    toast(`A placa de vídeo travou na captura nativa (${state.nativeStuck}). Usando a captura do Chromium até reiniciar o app.`, 'error');
  } else if (settings.engine.startsWith('native') && (await window.native.audioAvailable())) {
    try {
      tried.native = true;
      // direto: começa no máximo; adaptNativeBitrate só reduz se a rede reclamar
      // adaptativo: o encoder do helper só alimenta a decodificação local -> qualidade alta fixa
      state.nativeKbps = directMbps(settings.bitrate) * 1000; // começa no valor por amigo (orçamento de upload)
      // pelo servidor: uma cópia só, teto do mês (a transmissão nova começa direto; um reinício continua onde estava)
      if (direct && sfuInUse(old)) state.nativeKbps = sfuKbps(settings);
      // troca de resolução pela rede: continua de onde estava (começar no máximo entupiria de novo)
      if (settings.startKbps) state.nativeKbps = Math.min(state.nativeKbps, settings.startKbps);
      // transmissão nova: o controle de bitrate começa do zero; reinício da mesma (troca de resolução
      // ou de codec): mantém o que já aprendeu de cada caminho, só não sobe nos primeiros segundos
      if (!old || !old.direct) netReset(); else netCtl.lastCut = performance.now();
      // direta: AV1 se eu e TODOS os amigos temos placa que decodifica AV1 (e a minha codifica);
      // senão H.265 se todos decodificam; senão H.264
      const peersNow = [...state.peers.values()];
      // pelo servidor de vídeo a imagem da placa é a mesma para o servidor e para os amigos: H.265/AV1
      // só quando todos na sala puxam esses codecs de lá (versão com a conexão de receber separada;
      // as antigas davam "subscriber's SDP is missing the published track's codec")
      const viaSfu = direct && sfuInUse(old) && !peersNow.every((p) => p.sfu2);
      const wantAv1 = direct && !viaSfu && settings.codec !== 'H264' && !settings.forceH264 && !settings.noAv1 && !window.Sdp.sendBad('AV1') &&
        !state.noAv1Encoder && localStorage.getItem('av1') !== '0' && window.Sdp.hasAV1Hw() && peersNow.every((p) => p.av1);
      const wantHevc = direct && !viaSfu && settings.codec !== 'H264' && !settings.forceH264 && !window.Sdp.sendBad('H265') && window.Sdp.hasH265() &&
        peersNow.every((p) => p.h265);
      const codecs = [wantAv1 && 'av1', wantHevc && 'hevc', 'h264'].filter(Boolean);
      const opts = {
        sourceId: src.id, displayId: src.displayId, inject: direct, crop: src.crop || null,
        fps: settings.fps, kbps: direct ? state.nativeKbps : 50000, maxWidth: maxW, maxHeight: maxH,
      };
      for (let i = 0; i < codecs.length && !nativeInfo && gen === shareGen; i++) {
        try {
          const o = { ...opts, codec: codecs[i], light: direct && lightLayerOn() ? { ...LIGHT, kbps: lightKbps(codecs[i]) } : null };
          nativeInfo = window.__testNative ? await window.__testNative(o) : await window.NativeVideo.start(o);
        } catch (e) {
          if (gen !== shareGen) break; // pararam no meio: não tenta o codec seguinte
          if (i === codecs.length - 1) throw e;
          if (codecs[i] === 'av1') state.noAv1Encoder = /Nenhum encoder/.test(e.message); // placa sem AV1: não tenta de novo
          console.warn(`${codecs[i]} nativo falhou, tentando ${codecs[i + 1]}:`, e.message);
        }
      }
      if (gen === shareGen) {
        video = nativeInfo.track;
        if (!direct) video.contentHint = settings.mode; // "Prioridade" vale também no modo adaptativo
        preview = nativeInfo.preview;
        stream = new MediaStream([video]);
      }
    } catch (e) {
      if (/placa de vídeo travou/.test(e.message)) state.nativeStuck = e.message.slice(0, 160);
      if (gen === shareGen) toast(`Captura nativa falhou (${e.message})${src.crop ? '' : '. Usando a captura do Chromium'}.`, 'error');
    }
  }
  if (gen !== shareGen) { await cancelStart(tried, stream); return; }
  // Só uma ÁREA da tela foi escolhida e a captura nativa não está funcionando: a do Chromium só sabe
  // capturar a tela INTEIRA, e era isso que ia para os amigos (ainda com o nome "(área)").
  if (!video && src.crop) {
    toast('Não deu para transmitir só a área escolhida (a captura nativa não está funcionando agora). Nada foi transmitido: tente de novo ou escolha a tela inteira.', 'error');
    $('#btn-start-share').disabled = false;
    if (state.share) await stopShare(); // a captura anterior já foi parada
    return;
  }
  if (!video) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: maxW,
            maxHeight: maxH,
            maxFrameRate: settings.fps,
          },
        },
      });
    } catch (e) {
      toast(`Não foi possível capturar: ${e.message}`, 'error');
      $('#btn-start-share').disabled = false;
      // a captura anterior já foi parada: não deixa um "ao vivo" com imagem congelada
      if (state.share) await stopShare();
      return;
    }
    video = stream.getVideoTracks()[0];
    video.contentHint = settings.mode;
    preview = stream;
  }
  if (gen !== shareGen) { await cancelStart(tried, stream); return; }

  let audio = null, audioErr = '';
  if (settings.audio !== 'none') {
    try {
      tried.audio = true;
      if (state.share && state.share.audio) await window.HelperAudio.stop();
      const [mode, pid, device] = settings.audio.startsWith('app:')
        ? ['app', Number(settings.audio.slice(4)), undefined]
        : settings.audio.startsWith('dev:') ? ['device', 0, settings.audio.slice(4)]
        : ['all-except', 0, undefined];
      audio = await window.HelperAudio.start(mode, pid, device);
      sendStoredGains(); // volumes do mixer guardados
    } catch (e) {
      console.warn('áudio da transmissão:', e.message);
      audioErr = e.message;
      toast(`Áudio indisponível: ${e.message}`, 'error');
    }
  } else if (state.share && state.share.audio) {
    await window.HelperAudio.stop();
  }
  // "Parar"/"Sair" enquanto a captura abria: desfaz em vez de entrar no ar
  if (gen !== shareGen) { await cancelStart(tried, stream); return; }

  state.share = {
    stream, video, audio, settings, preview,
    // a versão leve da direta (2ª qualidade): a trilha vazia da camada 1, quando o helper abriu o segundo encoder
    videoLight: nativeInfo && direct && nativeInfo.light ? nativeInfo.lightTrack : null,
    lightKbps: nativeInfo && direct && nativeInfo.light ? lightKbps(nativeInfo.codec) : 0,
    sourceName: src.crop ? `${src.name} (área)` : src.name,
    source: src,                         // para reiniciar a mesma tela se a captura cair
    native: !!nativeInfo,                // captura feita pelo helper
    direct: !!nativeInfo && direct,      // H.264 do helper vai direto para a rede
    width: nativeInfo ? nativeInfo.width : 0,
    height: nativeInfo ? nativeInfo.height : 0,
    encoder: nativeInfo ? nativeInfo.encoder : '',
    minQp: nativeInfo ? nativeInfo.minQp || 0 : 0, // piso de qualidade aceito pelo encoder (0 = sem)
    codec: nativeInfo && direct ? nativeInfo.codec : null, // 'hevc' / 'h264' na "Nativa direta"
    autoDirect: !!settings.autoDirect, // trocada sozinha para direta (não troca de novo)
    sfuAuto: (old && old.sfuAuto) || null, // indo pelo servidor de vídeo porque precisou (reinício continua nele)
    sfuShortN: (old && old.sfuShortN) || 0, multiTightAt: (old && old.multiTightAt) || 0, // (e o que o vigia já viu)
    smartH: settings.smartH || 0,        // resolução reduzida pela rede (0 = cheia)
    // por que não vai som (quem assiste vê no lugar do volume): 'none' = escolheu "Sem áudio"
    audioWhy: settings.audio === 'none' ? 'none' : audio ? '' : (audioErr || 'não ligou'),
  };
  // resolução cheia (antes da redução pela rede): para saber até onde pode voltar
  state.share.fullW = settings.smartH ? settings.fullW : state.share.width;
  state.share.fullH = settings.smartH ? settings.fullH : state.share.height;
  smartDirect.low = smartDirect.high = 0;
  state.nativeStats = null;
  if (old && !old.native) old.video.stop();
  // codec que deve sair (as estatísticas confirmam depois): protege contra queda logo no início
  markSendingCodec(state.share.direct ? (state.share.codec === 'hevc' ? 'h265' : state.share.codec)
    : settings.codec === 'auto' ? (window.Sdp.hasH265() && !window.Sdp.sendBad('H265') ? 'h265' : 'h264') : String(settings.codec));

  if (!nativeInfo) video.onended = () => stopShare(); // janela fechada, etc.

  if (!state.order.includes('me')) state.order.unshift('me');
  $('#share-modal').classList.add('hidden');
  $('#btn-share').textContent = 'Trocar tela';
  $('#btn-share').title = 'Trocar a tela que você está transmitindo'; // (alguns temas mostram só o ícone)
  state.lastSource = src; // Ctrl+Shift+S volta a transmitir esta tela
  window.Helper.gameWatch(true).catch(() => {}); // esconder a prévia quando estiver jogando
  $('#btn-stop').classList.remove('hidden');
  $('#btn-adjust').classList.remove('hidden');
  $('#btn-share2').classList.remove('hidden');
  updateShare2Button();

  for (const peer of state.peers.values()) {
    applySendParams(peer); // ajusta codec/renegocia se precisar
    sendState(peer.id);
  }
  if (!old) window.Vida.mark('me', 'aovivo'); // entrou no ar agora (trocar de tela não conta)
  render();
  if (!old) window.Vida.sala('aovivo', '1', state.myName);
  sfuSync();
  // alguém que não decodifica este codec disse isso enquanto a captura abria (aí ainda não havia
  // transmissão para trocar, e ele ficava sem imagem): confere agora
  if (state.share.direct && state.share.codec !== 'h264') {
    setTimeout(() => { const p = directCodecProblem(); if (p) restartDirectCodec(p.who, p.from, p.why); }, 0);
  }
}

// ------------------------------------------------------------------ teste de conexão
// Mede, com cada amigo, a velocidade real pelo caminho que o vídeo usa (Radmin): ping, variação
// e quantos Mb/s passam em cada sentido. Depois sugere a qualidade de transmissão.
const ST_MS = 4000, ST_CHUNK = 64 * 1024;
const stRx = new Map();     // id do amigo -> { bytes, t0 } (recebendo um teste)
const stWait = new Map();   // "id:chave" -> resolve (esperando resposta)

function dcSend(peer, obj) {
  if (!peer.dc || peer.dc.readyState !== 'open') throw new Error('canal de dados fechado');
  peer.dc.send(JSON.stringify(obj));
}
function dcWait(peer, key, ms) {
  return new Promise((resolve, reject) => {
    const k = `${peer.id}:${key}`;
    const step = { pong: 'ping', 'st-res': 'seu envio', 'st-in': 'envio dele' }[key] || key;
    const timer = setTimeout(() => { stWait.delete(k); reject(new Error(`sem resposta no teste de ${step} (rede muito ocupada? tente de novo)`)); }, ms);
    stWait.set(k, (v) => { clearTimeout(timer); stWait.delete(k); resolve(v); });
  });
}
function dcResolve(peer, key, v) { const f = stWait.get(`${peer.id}:${key}`); if (f) f(v); }

// manda dados o mais rápido possível por ST_MS (sem estourar o buffer do canal)
async function stBlast(peer, ms = ST_MS) {
  const chunk = new ArrayBuffer(ST_CHUNK);
  const dc = peer.dc;
  // fila curta: com até 8 MB parados na fila, num Radmin com ~5 Mb/s livres as respostas (pong,
  // fim do teste) ficavam presas atrás dela por mais de 12 s e o teste dava "sem resposta".
  // Com fila pequena, o que sai é o que a rede de fato entrega.
  dc.bufferedAmountLowThreshold = 256 << 10;
  dcSend(peer, { t: 'st-go' });
  const end = performance.now() + ms;
  while (performance.now() < end && dc.readyState === 'open') {
    if (dc.bufferedAmount > (1 << 20)) {
      // espera a fila baixar (evento) ou no máximo 10 ms (o evento não vem se ela já baixou)
      await new Promise((r) => {
        const done = () => { dc.removeEventListener('bufferedamountlow', done); clearTimeout(t); r(); };
        const t = setTimeout(done, 10);
        dc.addEventListener('bufferedamountlow', done);
      });
      continue;
    }
    dc.send(chunk);
  }
  dcSend(peer, { t: 'st-end' });
}

function onDataMessage(peer, data) {
  if (data instanceof ArrayBuffer) {
    const rx = stRx.get(peer.id);
    if (rx) { if (!rx.t0) rx.t0 = performance.now(); rx.bytes += data.byteLength; }
    return;
  }
  let m;
  try { m = JSON.parse(data); } catch { return; }
  switch (m.t) {
    case 'ping': try { dcSend(peer, { t: 'pong', ts: m.ts }); } catch {} break;
    case 'pong': dcResolve(peer, 'pong', performance.now() - m.ts); break;
    case 'st-go': stRx.set(peer.id, { bytes: 0, t0: 0 }); break;
    case 'st-end': {
      const rx = stRx.get(peer.id);
      stRx.delete(peer.id);
      const ms = rx && rx.t0 ? performance.now() - rx.t0 : 0;
      try { dcSend(peer, { t: 'st-res', bytes: rx ? rx.bytes : 0, ms }); } catch {}
      dcResolve(peer, 'st-in', rx && ms ? (rx.bytes * 8) / (ms / 1000) : 0); // teste vindo dele = meu download
      break;
    }
    case 'st-res': dcResolve(peer, 'st-res', m.ms ? (m.bytes * 8) / (m.ms / 1000) : 0); break;
    case 'st-rev': stBlast(peer).catch(() => {}); break; // ele pediu para medir o sentido contrário
    // quanto o amigo recebeu da minha tela nos últimos 2 s (o controle de bitrate da "Nativa direta"
    // compara com o que mandei: recebendo bem menos = a ida até ele está cheia)
    case 'rx': if (Number.isFinite(m.kb)) peer.rxRep = { kb: Math.max(0, m.kb), at: performance.now() }; break;
    case 'diag-req': sendMyDiag(peer).catch((e) => console.warn('enviar diagnóstico', e)); break;
    case 'diag-part': onDiagPart(peer, m).catch((e) => console.warn('receber diagnóstico', e)); break;
    default: break;
  }
}

async function testPeer(peer, onStep) {
  const r = { name: peer.name };
  // ping pelo canal de dados (10 vezes): média e variação
  const pings = [];
  for (let i = 0; i < 10; i++) {
    const wait = dcWait(peer, 'pong', 6000);
    dcSend(peer, { t: 'ping', ts: performance.now() });
    pings.push(await wait);
    await new Promise((res) => setTimeout(res, 60));
  }
  r.ping = pings.reduce((a, b) => a + b, 0) / pings.length;
  r.jitter = Math.max(...pings) - Math.min(...pings);
  onStep(`${peer.name}: medindo o seu envio...`);
  const resUp = dcWait(peer, 'st-res', ST_MS + 8000);
  await stBlast(peer);
  r.up = await resUp;
  onStep(`${peer.name}: medindo o envio dele para você...`);
  const resDown = dcWait(peer, 'st-in', ST_MS + 8000);
  dcSend(peer, { t: 'st-rev' });
  r.down = await resDown;
  return r;
}

// Sugestão: o vídeo usa ~60% do que passou (sobra para áudio, câmera e variações).
// Na malha cada amigo recebe uma cópia: o seu upload é dividido entre eles.
function suggestQuality(results) {
  const ok = results.filter((r) => r.up > 0);
  if (!ok.length) return null;
  const minUp = Math.min(...ok.map((r) => r.up)) / 1e6;
  const totalUp = Math.max(...ok.map((r) => r.up)) / 1e6; // um teste de cada vez: o maior ≈ seu upload
  const perPeer = Math.min(minUp * 0.6, (totalUp * 0.6) / Math.max(1, state.peers.size));
  const bitrate = Math.max(3, Math.min(50, Math.floor(perPeer)));
  const worstPing = Math.max(...ok.map((r) => r.ping));
  // com folga (20+ Mb/s) mantém a resolução escolhida (nativa/1440p); senão, 1080p ou menos
  let res = bitrate >= 20 ? state.settings.res : '1080', fps = 60;
  if (bitrate < 6) { res = '720'; fps = 30; } else if (bitrate < 10) res = '720';
  // orçamento total de upload: ~70% do maior envio medido
  const uploadMbps = Math.max(10, Math.round(totalUp * 0.7));
  return { bitrate, res, fps, worstPing, uploadMbps };
}

async function runNetTest() {
  const modal = $('#nettest-modal'), body = $('#nettest-body'), apply = $('#nettest-apply');
  modal.classList.remove('hidden');
  if (state.netTesting) return;
  state.netTesting = true; // marca já: a medição automática não começa no meio
  if (state.autoMeasuring) { body.innerHTML = '<p class="muted">Terminando a medição automática...</p>'; }
  await measureChain.catch(() => {});
  apply.classList.add('hidden');
  const peers = [...state.peers.values()].filter((p) => p.dc && p.dc.readyState === 'open');
  if (!peers.length) {
    body.innerHTML = '<p class="muted">Ninguém conectado para testar (ou os amigos ainda estão numa versão antiga).</p>';
    state.netTesting = false;
    return;
  }
  const results = [];
  const grade = (v, warn, bad, lower) => (lower ? (v < bad ? 'bad' : v < warn ? 'warn' : 'good') : (v > bad ? 'bad' : v > warn ? 'warn' : 'good'));
  const draw = (status) => {
    body.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'nettest-table';
    table.innerHTML = '<tr><th>Amigo</th><th>Ping</th><th>Variação</th><th>Você → ele</th><th>Ele → você</th></tr>';
    for (const r of results) {
      const tr = document.createElement('tr');
      const cell = (t, cls = '', span = 1) => { const td = document.createElement('td'); td.textContent = t; td.className = cls; td.colSpan = span; tr.appendChild(td); };
      cell(r.name);
      if (r.error) cell(r.error, 'bad', 4);
      else {
        cell(`${Math.round(r.ping)} ms`, grade(r.ping, 60, 120));
        cell(`${Math.round(r.jitter)} ms`, grade(r.jitter, 25, 60));
        cell(fmtMbps(r.up), grade(r.up, 25e6, 10e6, true));
        cell(fmtMbps(r.down), grade(r.down, 25e6, 10e6, true));
      }
      table.appendChild(tr);
    }
    body.appendChild(table);
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = status;
    body.appendChild(p);
  };
  try {
    for (const peer of peers) {
      draw(`Testando com ${peer.name}...`);
      try {
        const r = await testPeer(peer, (t) => draw(t));
        results.push(r);
        if (r.up) { peer.upMbps = Math.round((r.up / 1e6) * 10) / 10; autoMeasured.set(peer.name, { up: peer.upMbps, at: Date.now() }); }
      } catch (e) { results.push({ name: peer.name, error: e.message }); }
    }
    console.log(`teste de conexão: ${safeJson(results.map((r) => ({ ...r, up: r.up && +(r.up / 1e6).toFixed(1), down: r.down && +(r.down / 1e6).toFixed(1) })))}`);
    const sug = suggestQuality(results);
    if (!sug) { draw('Não deu para medir. Tente de novo.'); return; }
    draw(`Sugestão: ${sug.res}p ${sug.fps} fps, ${sug.bitrate} Mb/s por amigo (upload total até ${sug.uploadMbps} Mb/s).` +
      (sug.worstPing > 120 ? ' Ping alto: prefira "Fluidez".' : '') +
      ' Medido pelo Radmin; é um mínimo, a velocidade real pode ser maior.');
    apply.classList.remove('hidden');
    apply.onclick = () => {
      Object.assign(state.settings, { bitrate: sug.bitrate, res: sug.res, fps: sug.fps, uploadMbps: sug.uploadMbps });
      saveSettings();
      if (state.share) applyLiveBitrate(sug.bitrate);
      toast(`Qualidade: ${sug.res}p ${sug.fps} fps, ${sug.bitrate} Mb/s.${state.share ? ' Resolução e FPS valem ao reiniciar a transmissão (ou em Ajustes).' : ''}`);
      modal.classList.add('hidden');
    };
  } finally { state.netTesting = false; }
}

// ------------------------------------------------------------------ bitrate adaptativo (modo nativo)
// O encoder nativo é um só para todos os amigos. Quem decide o bitrate é o NetCtl (netctl.js):
// cada caminho (cada amigo que recebe direto, e o servidor de vídeo) é avaliado sozinho, com o ping
// normal DELE, e só corta com evidência de que a IDA daquele caminho está cheia. Antes era um número
// só para a sala (maior ping, maior perda): um pico de ping de um amigo derrubava a transmissão de
// todos para 500 kb/s.
state.netInfo = { avail: null, loss: 0, rtt: null, nack: 0, pli: 0, level: 'ok', why: '' };
const newNet = () => ({ st: window.NetCtl.newPath(), tx: [], rrTs: 0, rrAt: 0, route: 0 });
let netCtl = window.NetCtl.newCtl();
let sfuNet = newNet(); // caminho até o servidor de vídeo
function netReset() {
  netCtl = window.NetCtl.newCtl();
  sfuNet = newNet();
  for (const p of state.peers.values()) p.net = null;
}

// kb/s enviados entre dois instantes (pelos totais guardados a cada segundo)
function txKbps(n, t1, t2) {
  const h = n.tx;
  if (h.length < 2 || t2 <= t1) return 0;
  const at = (t) => {
    if (t <= h[0].t) return h[0].b;
    for (let i = 1; i < h.length; i++) {
      if (t <= h[i].t) { const a = h[i - 1], b = h[i]; return a.b + ((b.b - a.b) * (t - a.t)) / Math.max(1, b.t - a.t); }
    }
    return h[h.length - 1].b;
  };
  const a = Math.max(t1, h[0].t), b = Math.min(t2, h[h.length - 1].t);
  return b - a < 500 ? 0 : ((at(b) - at(a)) * 8) / (b - a); // bytes*8/ms = kb/s
}

// Como vai o envio da tela principal por uma conexão, segundo o WebRTC.
//   n = estado do caminho (newNet); out = a estatística "outbound-rtp" da tela principal
function netSample(n, report, out, now) {
  let loss = 0, rtt = 0, bwe = 0, rrTs = 0, pairRtt = 0, oth = 0;
  report.forEach((r) => {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      if (r.availableOutgoingBitrate) bwe = r.availableOutgoingBitrate / 1000;
      pairRtt = r.currentRoundTripTime || 0;
    } else if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && (!out || r.localId === out.id)) {
      loss = Math.max(loss, r.fractionLost || 0);
      rtt = Math.max(rtt, r.roundTripTime || 0);
      rrTs = Math.max(rrTs, r.timestamp || 0);
    } else if (r.type === 'outbound-rtp' && out && r.id !== out.id) oth += r.bytesSent || 0; // câmera, 2ª tela, som
  });
  if (out) { n.tx.push({ t: now, b: out.bytesSent || 0 }); if (n.tx.length > 8) n.tx.shift(); }
  // o que mais sai por esta conexão (kb/s): divide com a tela o que o WebRTC solta nela
  if (n.oth && now - n.oth.t > 400) n.othKbps = Math.max(0, ((oth - n.oth.b) * 8) / (now - n.oth.t));
  if (!n.oth || now - n.oth.t > 400) n.oth = { t: now, b: oth };
  // o relatório de quem recebe chega ~1 vez por segundo: o mesmo relatório não conta duas vezes
  const fresh = rrTs !== n.rrTs || now - n.rrAt > 2500;
  if (fresh) { n.rrTs = rrTs; n.rrAt = now; }
  return { loss, rtt: rtt || pairRtt, bwe, fresh, pace: window.NetCtl.paceOf(bwe, n.othKbps || 0) };
}

async function adaptNativeBitrate() {
  const share = state.share;
  if (!share || !share.direct || !state.nativeKbps) return;
  const peers = [...state.peers.values()];
  const viaSfu = !!share.sfu && peers.some((p) => p.sfuPulling);
  const direct = peers.filter((p) => p.vT.sender.track && p.pc.connectionState === 'connected');
  // teto: a qualidade escolhida dentro do orçamento de upload (a medição do upload até cada amigo só
  // define o COMEÇO; daqui para cima quem manda é a rede de verdade)
  const capK = perPeerMbps(share.settings.bitrate) * 1000;
  // pelo servidor sai uma cópia só (teto do mês); quem ainda recebe direto divide o upload
  const max = viaSfu ? Math.min(sfuKbps(share.settings), direct.length ? capK : Infinity) : capK;
  const now = performance.now();
  const R = state.nativeKbps;
  const ns = window.NativeVideo.lastStats || {};
  const paths = [];
  let nack = 0, pli = 0;
  if (viaSfu && window.Sfu.pc() && window.Sfu.pubSender()) {
    try {
      const report = await window.Sfu.pc().getStats();
      let out = null;
      report.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
      if (out) {
        const m = netSample(sfuNet, report, out, now);
        nack += out.nackCount || 0; pli += out.pliCount || 0;
        const w = ns.sfu;
        paths.push({ name: 'servidor de vídeo', n: sfuNet, stale: !m.fresh,
          s: { loss: m.loss, rtt: m.rtt, bwe: m.bwe, pace: m.pace, bweFloor: Math.min(sfuKbps(share.settings) * 0.6, 8000), flush: (w && w.active && w.flush) || 0, vpn: false, rx: null } });
      }
    } catch {}
  }
  let lightBwe = Infinity;
  for (const peer of direct) {
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    // só a trilha da tela principal (câmera/2ª tela têm pouco tráfego e distorciam perda/ping)
    let out = null;
    report.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video' && (peer.vT.mid == null || String(r.mid) === String(peer.vT.mid))) out = r; });
    const n = peer.net || (peer.net = newNet());
    // a rota mudou (Radmin <-> internet): o ping normal desse caminho é outro
    if (n.route !== peer.routeSince) { n.route = peer.routeSince; window.NetCtl.resetPath(n.st); n.tx.length = 0; }
    const m = netSample(n, report, out, now);
    if (out) { nack += out.nackCount || 0; pli += out.pliCount || 0; }
    // o amigo avisa quanto recebeu nos últimos 2 s: comparo com o que mandei nesse mesmo trecho
    const rep = peer.rxRep;
    let rx = null;
    if (rep && now - rep.at < 5000) {
      const sent = txKbps(n, rep.at - 2100, rep.at);
      if (sent > 400) rx = Math.min(2, rep.kb / sent);
    }
    const w = ns[peer.id]; // amigo cujo envio ficou para trás (quadros descartados à espera de keyframe)
    // na versão leve: não entra na decisão da cheia; a estimativa dele decide o bitrate da leve
    if (peer.sendLayer === 1) { if (m.bwe > 0 && m.fresh) lightBwe = Math.min(lightBwe, m.bwe); continue; }
    paths.push({ peer, name: peer.name, n, stale: !m.fresh,
      s: { loss: m.loss, rtt: m.rtt, bwe: m.bwe, pace: m.pace, bweFloor: peer.sdpFloor || 0, flush: (w && w.active && w.flush) || 0, vpn: peer.routePath === 'vpn', rx } });
  }
  if (state.share !== share) return;
  lightBitrate(share, lightBwe);
  if (!paths.length) return;
  if (state.nativeKbps !== R) return; // mudou no meio (o teto de envio agiu): decide no próximo segundo
  let lossMax = 0, rttMax = 0, bweMin = Infinity;
  for (const p of paths) {
    const t = window.__testNet && window.__testNet(p.name); // teste automático: rede simulada por caminho
    if (t) { Object.assign(p.s, t); if (t.bwe != null && t.pace == null) p.s.pace = window.NetCtl.paceOf(t.bwe, 0); p.stale = false; }
    p.st = p.n.st;
    if (!p.stale) window.NetCtl.classify(p.st, p.s, R, now);
    else p.st.pace = p.s.pace > 0 ? p.s.pace : Infinity; // o teto de envio vale mesmo sem relatório novo
    lossMax = Math.max(lossMax, p.s.loss || 0);
    rttMax = Math.max(rttMax, p.s.rtt || 0);
    if (p.s.bwe > 0) bweMin = Math.min(bweMin, p.s.bwe);
  }
  // um amigo reclama (congestionado) enquanto outro está tranquilo: a rede dele é que não dá conta da cheia. Ele vai para a
  // leve (4 s seguidos assim) e o bitrate da cheia deixa de seguir ele. Todos reclamando juntos é o meu upload: não
  // adianta separar ninguém (aí o servidor de vídeo, se ligado, ajuda: sfuNeedWatch)
  if (share.videoLight && paths.length >= 2) {
    const calm = paths.some((p) => !p.stale && p.st.level === 'ok');
    for (const p of paths) {
      const bad = !p.stale && (p.st.level === 'cong' || p.st.level === 'severe');
      p.peer.weakN = bad && calm ? (p.peer.weakN || 0) + 1 : 0;
      if (p.peer.weakN >= 4) markWeak(p.peer);
    }
  }
  const d = window.NetCtl.decide(netCtl, paths, R, max, 1000, now);
  let target = d.target, did = d.did, why = d.why;
  for (const note of d.notes) console.log(`bitrate da direta: ${note}`);
  // Alguém recebendo pelo servidor reclamou (a imagem é uma só: segue o mais fraco, como o Discord),
  // mas sem afundar todo mundo por causa de um só: no máx. até 40% do teto. Uma reclamação isolada
  // só segura a subida; duas seguidas do mesmo amigo cortam.
  if (viaSfu && !did) {
    const t = Date.now();
    const bad = peers.filter((p) => p.sfuPulling && (p.sfuRxBad || []).some((x) => t - x < 2600));
    const twice = bad.find((p) => p.sfuRxBad.filter((x) => t - x < 6600).length >= 2);
    if (twice && R > max * 0.4 && now - netCtl.lastCut >= 2000) {
      target = Math.round(Math.max(max * 0.4, window.NetCtl.externalCut(netCtl, R, 0.8, now)));
      did = 'cong'; why = `${twice.name}: recebendo mal pelo servidor`;
    } else if (bad.length) target = Math.min(target, R);
  }
  state.netInfo = { avail: isFinite(bweMin) ? bweMin : null, loss: lossMax, rtt: rttMax, nack, pli, level: d.level, why: d.level === 'ok' ? (did === 'pace' ? why : '') : d.why, pace: isFinite(d.pace) ? d.pace : null };
  if (did) logCut(did, why, target);
  // (antes só aplicava mudanças acima de 5%: os passos de subida perto do teto, e qualquer subida
  //  acima de ~10 Mb/s, eram menores que isso e nunca eram aplicados: o bitrate ficava parado)
  if (target !== R && (Math.abs(target - R) / R >= 0.01 || target === max || target === 1000)) {
    state.nativeKbps = target;
    window.Helper.videoBitrate(target);
  }
}
setInterval(() => { adaptNativeBitrate().catch((e) => console.warn('bitrate da direta', e)); }, 1000);

// bitrate da versão leve: 85% da pior estimativa de banda entre quem está nela (entre 500 kb/s e o teto), mudando no
// máximo a cada 3 s e só quando a diferença passa de 15%
function lightBitrate(share, bwe) {
  if (!share.videoLight || !share.lightKbps) return;
  const top = lightKbps(share.codec || 'h264');
  const want = isFinite(bwe) ? Math.round(Math.max(500, Math.min(top, bwe * 0.85))) : top;
  const now = performance.now();
  if (Math.abs(want - share.lightKbps) / share.lightKbps < 0.15 || now - (share.lightAt || 0) < 3000) return;
  share.lightKbps = want;
  share.lightAt = now;
  window.Helper.videoBitrate(want, true);
}

// registro dos cortes (o do teto de envio no máximo a cada 5 s: ele acompanha a estimativa o tempo todo)
let paceLogAt = 0;
function logCut(did, why, target) {
  if (did === 'pace') { if (performance.now() - paceLogAt < 5000) return; paceLogAt = performance.now(); }
  const what = { severe: 'freio forte', soft: 'corte de teste', pace: 'teto de envio' }[did] || 'freio';
  console.log(`bitrate da direta: ${what} (${why}) -> ${target} kb/s`);
}

// O TETO DE ENVIO, conferido 2x por segundo. O WebRTC só solta os pacotes de cada conexão no ritmo da
// estimativa de banda dele; o que a placa manda a mais fica numa fila no envio e a tela daquele amigo
// atrasa (medido: até ~1,3 s). Ela pode cair bastante em um segundo, então não espera a avaliação
// completa.
async function paceGuard() {
  const share = state.share;
  if (!share || !share.direct || !state.nativeKbps) return;
  const peers = [...state.peers.values()];
  // (só quem está na cheia: o ritmo de quem recebe a leve é o da leve)
  const jobs = peers.filter((p) => p.vT.sender.track && p.pc.connectionState === 'connected' && p.sendLayer !== 1).map((p) => [p.pc, p.net, p.name]);
  if (share.sfu && peers.some((p) => p.sfuPulling) && window.Sfu.pc() && window.Sfu.pubSender()) jobs.push([window.Sfu.pc(), sfuNet, 'servidor de vídeo']);
  let pace = Infinity, who = '';
  await Promise.all(jobs.map(async ([pc, n, name]) => {
    let bwe = 0;
    try { (await pc.getStats()).forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.availableOutgoingBitrate) bwe = r.availableOutgoingBitrate / 1000; }); } catch { return; }
    const t = window.__testNet && window.__testNet(name);
    if (t && t.bwe != null) bwe = t.bwe;
    const p = t && t.pace != null ? t.pace : window.NetCtl.paceOf(bwe, (n && n.othKbps) || 0);
    if (p < pace) { pace = p; who = name; }
  }));
  if (state.share !== share || !isFinite(pace)) return;
  const R = state.nativeKbps, target = Math.max(1000, Math.round(pace));
  if (R <= pace * 1.03 || target >= R) return;
  // desce junto com a estimativa (e o controle volta rápido quando ela subir)
  netCtl.recoverTo = Math.max(netCtl.recoverTo || 0, R * 0.85); netCtl.recoverAt = performance.now();
  netCtl.paceFrom = Math.max(netCtl.paceFrom || 0, R); netCtl.paceAt = performance.now();
  logCut('pace', `${who}: o WebRTC só solta ${target} kb/s nessa conexão`, target);
  state.nativeKbps = target;
  window.Helper.videoBitrate(target);
}
setInterval(() => { paceGuard().catch(() => {}); }, 500);

// ------------------------------------------------------------------ resolução inteligente
// Pouca banda + resolução alta = imagem toda quadriculada (ex.: 1080p60 de jogo em 5 Mb/s pelo
// Radmin). Com a mesma banda, um 720p fica bem mais limpo: desce um degrau quando a rede não dá
// bits suficientes para a resolução atual e volta quando sobra (com folga, para não ficar trocando).
// Só no modo "Movimento" (no "Detalhe" o Chromium já mantém a resolução e baixa o FPS).
const SMART_STEPS = [2160, 1440, 1080, 720, 540];
const SMART_BPP = { h264: 0.065, hevc: 0.045, h265: 0.045, av1: 0.04, vp9: 0.045, vp8: 0.07 }; // bits por pixel por quadro
function smartNeedKbps(h, fps, codec) { return (h * h * 16 / 9) * Math.min(60, fps || 30) * (SMART_BPP[codec] || 0.065) / 1000; }
function smartEnabled(share) { return localStorage.getItem('smartRes') !== '0' && share && share.settings.mode === 'motion'; }
function smartDown(h) { return SMART_STEPS.find((x) => x < h - 8) || h; }
function smartUp(h, top) { const up = [...SMART_STEPS].reverse().find((x) => x > h + 8); return up && up < top - 8 ? up : top; }
// decide o degrau: 'down' / 'up' / null (conta segundos seguidos antes de trocar)
function smartStep(st, cur, top, kbps, fps, codec, downSecs, upSecs) {
  if (cur > 540 && kbps < smartNeedKbps(cur, fps, codec) * 0.75) { st.high = 0; if (++st.low >= downSecs) { st.low = 0; return 'down'; } return null; }
  st.low = Math.max(0, st.low - 1);
  if (cur < top - 8 && performance.now() > (st.upBlock || 0) && kbps >= smartNeedKbps(smartUp(cur, top), fps, codec)) {
    if (++st.high >= upSecs) { st.high = 0; return 'up'; }
  } else st.high = Math.max(0, st.high - 2);
  return null;
}
// depois de subir, se cair de novo logo: espera bem mais para tentar outra vez
function smartAfter(st, dir, waitMs) {
  const now = performance.now();
  if (dir === 'up') st.lastUp = now;
  else st.upBlock = now + (st.lastUp && now - st.lastUp < 90000 ? waitMs * 10 : waitMs);
}

// adaptativo (encoder do Chromium, um por amigo): só muda a escala do envio, sem reiniciar nada
async function smartResAdaptive() {
  const share = state.share;
  if (!share || share.direct) return;
  const top = share.height || share.video.getSettings().height || 1080;
  const fps = Number(share.settings.fps) || 30;
  for (const peer of state.peers.values()) {
    if (!smartEnabled(share) || state.lightMode || peer.theyWant === 'off' || peer.theyWant === 'thumb' || peer.pc.connectionState !== 'connected') {
      if (peer.smartH) { peer.smartH = 0; applySendParams(peer); }
      continue;
    }
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    let avail = 0, out = null, codec = 'h264';
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.availableOutgoingBitrate) avail = r.availableOutgoingBitrate / 1000;
      if (r.type === 'outbound-rtp' && r.kind === 'video' && String(r.mid) === String(peer.vT.mid)) out = r;
    });
    if (!avail || !out) continue;
    const c = out.codecId && report.get(out.codecId);
    if (c && c.mimeType) codec = c.mimeType.split('/')[1].toLowerCase();
    const base = Math.min(top, peer.theyWantH || top);
    const cur = Math.min(base, peer.smartH || base);
    const kbps = window.__smartKbps || Math.min(avail, perPeerMbps(share.settings.bitrate, peer) * 1000); // (__smartKbps: teste automático)
    const st = peer.smartSt || (peer.smartSt = { low: 0, high: 0 });
    const dir = smartStep(st, cur, base, kbps, fps, codec, 4, 10);
    if (!dir) continue;
    const next = dir === 'down' ? smartDown(cur) : smartUp(cur, base);
    peer.smartH = next >= base ? 0 : next;
    smartAfter(st, dir, 15000); // aqui subir é barato (sem reiniciar nada)
    console.log(`resolução inteligente com ${peer.name}: ${cur}p -> ${next}p (rede ~${Math.round(kbps / 100) / 10} Mb/s, ${codec})`);
    applySendParams(peer);
  }
}
setInterval(smartResAdaptive, 1000);

// direta (um encoder só para todos): segue o bitrate da rede e reinicia a captura no novo tamanho
const smartDirect = { low: 0, high: 0 };
let smartRestarting = false;
async function smartResDirect() {
  const share = state.share;
  if (!share || !share.direct || !smartEnabled(share) || !state.nativeKbps || shareBusy || restartingCodec || smartRestarting) return;
  const top = share.fullH || share.height;
  const cur = share.height;
  if (!top || !cur) return;
  const dir = smartStep(smartDirect, cur, top, state.nativeKbps, Number(share.settings.fps), share.codec, 10, 30);
  if (!dir) return;
  const next = dir === 'down' ? smartDown(cur) : smartUp(cur, top);
  smartAfter(smartDirect, dir, 60000); // aqui cada troca reinicia a captura
  console.log(`resolução inteligente (direta): ${cur}p -> ${next}p (rede ~${Math.round(state.nativeKbps / 100) / 10} Mb/s, ${share.codec})`);
  toast(dir === 'down'
    ? `Rede apertada (~${Math.round(state.nativeKbps / 1000)} Mb/s): transmitindo em ${next}p para a imagem ficar nítida. Volta sozinho quando a rede melhorar.`
    : `A rede melhorou: voltando para ${next}p.`);
  smartRestarting = true;
  try {
    selectedSource = share.source;
    const s = share.settings;
    await startShare({ keep: true, engine: 'native-direct', autoDirect: share.autoDirect, noAv1: s.noAv1, forceH264: s.forceH264,
      smartH: next >= top - 8 ? 0 : next, fullW: share.fullW, fullH: share.fullH, startKbps: state.nativeKbps });
  } finally { smartRestarting = false; }
}
setInterval(smartResDirect, 1000);

// Pedidos de keyframe reais (PLI/FIR) vindos de quem assiste: lidos das estatísticas do envio.
const sfuKeyReqs = { keyReqs: null };
async function watchKeyRequests() {
  if (!state.share || !state.share.direct) return;
  const senders = [...state.peers.values()].map((peer) => [peer, peer.vT.sender]);
  const ss = state.share.sfu && window.Sfu.pubSender();
  if (ss) senders.push([sfuKeyReqs, ss]); // o servidor pede quando alguém entra ou perde a imagem
  for (const [who, sender] of senders) {
    if (!sender.track) continue;
    let report;
    try { report = await sender.getStats(); } catch { continue; }
    report.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      const n = (r.pliCount || 0) + (r.firCount || 0);
      if (who.keyReqs != null && n > who.keyReqs) window.NativeVideo.key(who.sendLayer === 1 ? 1 : 0);
      who.keyReqs = n;
    });
  }
}
setInterval(watchKeyRequests, 250);

// ------------------------------------------------------------------ ajustes durante a transmissão
function openAdjust() {
  const panel = $('#adjust-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const s = state.share ? state.share.settings : state.settings;
  $('#adj-bitrate').value = s.bitrate;
  setMbps($('#adj-bitrate-label'), s.bitrate);
  $('#adj-res').value = s.res;
  $('#adj-fps').value = String(s.fps);
  $('#adj-mode').value = s.mode;
  $('#adj-engine').value = s.engine || 'native';
  window.Themes.syncSelects();
  window.Themes.paintRanges();
  panel.classList.remove('hidden');
  renderBudgetInfo();
  refreshMixer();
}

// ------------------------------------------------------------------ mixer (áudio transmitido)
// Volume de cada app no som que os amigos ouvem (ex.: música mais baixa que o jogo).
// Guardado pelo nome do programa: vale de novo nas próximas transmissões.
function storedGains() { try { return JSON.parse(localStorage.getItem('gains')) || {}; } catch { return {}; } }
function sendStoredGains() {
  for (const [exe, g] of Object.entries(storedGains())) window.Helper.audioGain(exe, g);
}
let mixerTimer = null;
async function refreshMixer() {
  clearTimeout(mixerTimer);
  const panel = $('#adjust-panel'), box = $('#mixer'), list = $('#mixer-list');
  if (panel.classList.contains('hidden')) return;
  const sharingAudio = !!(state.share && state.share.audio);
  box.classList.toggle('hidden', !sharingAudio);
  if (!sharingAudio) return;
  let apps = [];
  try { apps = (await window.Helper.mixerApps()).apps || []; } catch {}
  // não refaz os controles enquanto a pessoa arrasta um deles
  if (!list.contains(document.activeElement) || list.dataset.key !== apps.map((a) => a.exe).join('|')) {
    list.dataset.key = apps.map((a) => a.exe).join('|');
    list.innerHTML = '';
    if (!apps.length) list.innerHTML = '<p class="muted">Nenhum app tocando som agora.</p>';
    const gains = storedGains();
    for (const a of apps) {
      const row = document.createElement('label');
      row.className = 'mixer-row';
      const name = document.createElement('span');
      name.className = 'mixer-name';
      name.textContent = a.name;
      name.title = a.exe;
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 1.5; r.step = 0.05;
      r.value = gains[a.exe] ?? a.gain ?? 1;
      const pct = document.createElement('span');
      pct.className = 'mixer-pct';
      const show = () => { pct.textContent = Number(r.value) === 0 ? 'mudo' : `${Math.round(r.value * 100)}%`; };
      show();
      r.oninput = () => {
        show();
        const g = storedGains();
        if (Number(r.value) === 1) delete g[a.exe]; else g[a.exe] = Number(r.value);
        localStorage.setItem('gains', JSON.stringify(g));
        window.Helper.audioGain(a.exe, Number(r.value));
      };
      r.ondblclick = () => { r.value = 1; r.oninput(); };
      row.append(name, r, pct);
      list.appendChild(row);
    }
  }
  mixerTimer = setTimeout(refreshMixer, 3000); // apps começam/param de tocar
}

// Qualidade: aplica sem reiniciar nada (limites do encoder + renegociação dos limites de banda)
function applyLiveBitrate(mbps) {
  state.settings.bitrate = mbps;
  saveSettings();
  $('#opt-bitrate').value = mbps;
  const share = state.share;
  if (!share) return;
  share.settings.bitrate = mbps;
  if (share.direct) {
    state.nativeKbps = mbps * 1000;
    window.Helper.videoBitrate(state.nativeKbps);
  }
  for (const peer of state.peers.values()) {
    applySendParams(peer);
    negotiate(peer); // atualiza os limites de banda combinados (x-google-*)
  }
  toast(`Qualidade: ${mbps} Mbps`);
}

// Resolução/FPS/prioridade/captura: reinicia só a captura da mesma tela
async function applyAdjust() {
  const sh = state.share;
  if (!sh) return;
  const adj = {
    res: $('#adj-res').value, fps: Number($('#adj-fps').value), mode: $('#adj-mode').value,
    engine: $('#adj-engine').value, bitrate: Number($('#adj-bitrate').value),
  };
  // ficam valendo também para a próxima transmissão (e aparecem assim no modal de compartilhar)
  Object.assign(state.settings, adj);
  saveSettings();
  $('#opt-res').value = adj.res;
  $('#opt-fps').value = String(adj.fps);
  $('#opt-mode').value = adj.mode;
  $('#opt-engine').value = adj.engine;
  $('#opt-bitrate').value = adj.bitrate;
  $('#adjust-panel').classList.add('hidden');
  selectedSource = sh.source;
  // O resto (som, codec) continua como está no ar. Antes o som era relido do campo do modal de
  // compartilhar, e se o programa escolhido não estivesse mais naquela lista o campo ficava vazio:
  // "só o jogo" virava "todo o som do PC" sem aviso. O que foi decidido sozinho durante a transmissão
  // (codec rebaixado, resolução reduzida pela rede, troca para a direta) é reavaliado do zero.
  await startShare({ keep: true, ...adj, smartH: 0, autoDirect: false, noAv1: false, forceH264: false });
}

// ------------------------------------------------------------------ chat, reações e laser
function nameHue(name) {
  let h = 0;
  for (const ch of String(name || '?').trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
const ownerKey = (id) => (id === 'me' ? state.myId : id); // id da pessoa dona da tela (na sala)
const tileByOwner = (target) => (target === state.myId ? meTile : (state.peers.get(target) || {}).tile);

function addChat(name, text, system = false) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = `chat-msg${system ? ' system' : ''}`;
  div.dataset.t = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); // a hora, para os temas que mostram
  if (!system) {
    if (name === state.myName) div.classList.add('me');
    div.style.setProperty('--h', nameHue(name));
    div.dataset.k = nameHue(name) % 4;
    div.dataset.f = Math.floor(nameHue(name) / 45); // e um de 0 a 7
    const who = name === state.myName ? null : [...state.peers.values()].find((p) => p.name === name);
    div.dataset.n = name === state.myName ? '1' : ((who && who.personEl && who.personEl.dataset.n) || '');
    div.style.setProperty('--n-t', `"${div.dataset.n}"`);
    const av = avatar(name);
    av.classList.add('chat-av', 'theme-only');
    const body = document.createElement('span');
    body.className = 'chat-body';
    const b = document.createElement('b');
    b.style.color = `hsl(${nameHue(name)}, 70%, 65%)`;
    b.textContent = name;
    body.append(b, document.createTextNode(text));
    div.append(av, body);
  } else div.appendChild(document.createTextNode(text));
  window.Vida.chat(div, String(system ? text : `${name} ${text}`).length);
  log.appendChild(div);
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim().slice(0, 300);
  if (!text) return;
  input.value = '';
  sendRelay(null, { kind: 'chat', text });
  addChat(state.myName, text);
}

function showReaction(target, emoji, from) {
  const tile = tileByOwner(target);
  if (!tile || !tile.el.isConnected) return;
  const e = document.createElement('div');
  e.className = 'float-emoji';
  e.style.left = `${15 + Math.random() * 70}%`;
  const art = window.ThemeFx.emote(window.Themes.current, emoji); // desenho do tema; sem ele, o emoji de sempre
  if (art) e.innerHTML = art; else e.textContent = emoji;
  const s = document.createElement('small');
  s.textContent = from;
  e.appendChild(s);
  tile.screen.appendChild(e);
  setTimeout(() => e.remove(), 2300);
}

// posição do vídeo de verdade dentro da tela (descontando as faixas pretas)
function videoBox(tile) {
  const v = tile.video;
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, h = vh * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

// mãozinha apontando (a ponta do dedo fica exatamente no ponto)
const HAND_SVG = '<svg viewBox="0 0 32 32" width="34" height="34"><path d="M11 3.5c1.4 0 2.5 1.1 2.5 2.5v8.2l.6-.1c1.3-.2 2.4.6 2.7 1.8l.1.4.5-.1c1.3-.2 2.4.6 2.7 1.8l.1.3.4-.1c1.4-.2 2.6.8 2.7 2.2l.4 4.2c.2 2.6-1.1 5-3.4 6.2l-.8.4c-1.2.6-2.5.9-3.9.9h-1.2c-2.4 0-4.6-1.2-5.9-3.2l-4.3-6.6c-.7-1.1-.4-2.6.7-3.3 1-.6 2.3-.4 3.1.4L8.5 22V6c0-1.4 1.1-2.5 2.5-2.5z" fill="var(--c)" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';

// rastro (Shift + botão direito): uma camada de desenho por tela, que apaga sozinha
function trailLayer(tile) {
  if (tile.trail && tile.trail.isConnected) return tile.trail;
  const c = document.createElement('canvas');
  c.className = 'trail-layer';
  tile.screen.appendChild(c);
  tile.trail = c;
  tile.trailLines = [];
  const draw = () => {
    // a tela saiu da página com um traço ainda vivo (o amigo parou de transmitir, tela oculta...):
    // sem liberar a marca aqui, quando ela voltava a caneta e o rastro nunca mais desenhavam nela
    if (!c.isConnected) { tile.trailAnimating = false; return; }
    const r = tile.screen.getBoundingClientRect();
    if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) { c.width = Math.round(r.width); c.height = Math.round(r.height); }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const now = performance.now();
    // rastro some em 2,5 s; caneta fica INK_LIFE e só esmaece no final
    tile.trailLines = tile.trailLines.filter((s) => now - s.t < (s.life || 2500));
    const b = videoBox(tile);
    // o tema pode ter o seu jeito de riscar (ver fx.js); sem isso, o risco de sempre
    const themed = window.ThemeFx.drawLines(g, window.Themes.current, tile.trailLines, now,
      { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height }, { pen: 4, trail: 5 });
    for (const s of themed ? [] : tile.trailLines) {
      const age = now - s.t;
      g.globalAlpha = s.life ? Math.max(0, Math.min(1, (s.life - age) / 1200)) : Math.max(0, 1 - age / 2500);
      g.strokeStyle = s.color;
      g.lineWidth = s.life ? 4 : 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(b.left - r.left + s.x1 * b.width, b.top - r.top + s.y1 * b.height);
      g.lineTo(b.left - r.left + s.x2 * b.width, b.top - r.top + s.y2 * b.height);
      g.stroke();
    }
    if (tile.trailLines.length) requestAnimationFrame(draw); else tile.trailAnimating = false;
  };
  tile.trailDraw = () => {
    // (teto: um amigo com defeito ou mal-intencionado mandando traços sem parar travaria o desenho)
    if (tile.trailLines.length > TRAIL_MAX) tile.trailLines.splice(0, tile.trailLines.length - TRAIL_MAX);
    if (!tile.trailAnimating) { tile.trailAnimating = true; requestAnimationFrame(draw); }
  };
  return c;
}
const TRAIL_MAX = 2500; // traços vivos por tela (desenhando sem parar, uma pessoa fica em ~1000)
// Ritmo do que um amigo manda para desenhar na tela (traços, mãozinha): desenhando rápido, uma pessoa
// fica bem abaixo disto. Um app com defeito (ou alguém de má-fé) mandando sem parar enchia o desenho
// de todos e a janela por cima do monitor de quem transmite, a ponto de atrasar a placa de vídeo.
function drawBudget(peer, kind, n, perSec) {
  const now = performance.now();
  const all = peer.drawB || (peer.drawB = {});
  const b = all[kind] || (all[kind] = { at: 0, n: 0 });
  if (now - b.at > 1000) { b.at = now; b.n = 0; }
  const ok = Math.max(0, Math.min(n, perSec - b.n));
  b.n += ok;
  return ok;
}

// ------------------------------------------------------------------ caneta (desenho que fica)
// Botão de caneta numa tela: arrastar com o botão esquerdo desenha; os traços ficam INK_LIFE
// para todos (e no monitor de quem transmite) e depois somem. "Apagar" tira os seus na hora.
const INK_LIFE = 8000;
function showInk(target, fromId, name, segs) {
  const color = `hsl(${nameHue(name)}, 85%, 55%)`;
  const tile = tileByOwner(target);
  if (tile && tile.el.isConnected && !tile.swapped) { // trocada: a imagem grande é a 2ª tela
    trailLayer(tile);
    const t = performance.now();
    for (const [x1, y1, x2, y2] of segs) tile.trailLines.push({ x1, y1, x2, y2, color, t, life: INK_LIFE, from: fromId });
    tile.trailDraw();
  }
  if (sendToMyDesktop(target, fromId, 'ink')) {
    deskSend('ink', { displayId: state.share.source.displayId, id: fromId, segs, color, life: INK_LIFE });
  }
}
function clearInk(target, fromId) {
  const tile = tileByOwner(target);
  if (tile && tile.trailLines) { tile.trailLines = tile.trailLines.filter((s) => s.from !== fromId); tile.trailDraw && tile.trailDraw(); }
  if (target === state.myId) deskSend('ink', { clear: true, id: fromId });
}

function setPen(tile, id, on) {
  tile.pen = on;
  tile.el.classList.toggle('pen-on', on);
  if (tile.penBtn) tile.penBtn.classList.toggle('active', on);
  if (on && !tile.penTools) {
    const tools = document.createElement('div');
    tools.className = 'pen-tools';
    const label = document.createElement('span');
    label.textContent = '✏️ Caneta: arraste para desenhar';
    const clear = document.createElement('button');
    clear.textContent = 'Apagar';
    clear.onclick = (e) => { e.stopPropagation(); const target = ownerKey(id); sendRelay(null, { kind: 'ink-clear', target }); clearInk(target, 'me'); };
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Desligar a caneta (Esc)';
    close.onclick = (e) => { e.stopPropagation(); setPen(tile, id, false); };
    for (const b of [clear, close]) { b.ondblclick = (e) => e.stopPropagation(); b.onpointerdown = (e) => e.stopPropagation(); }
    tools.append(label, clear, close);
    tile.el.appendChild(tools);
    tile.penTools = tools;
  }
  if (tile.penTools) tile.penTools.classList.toggle('hidden', !on);
}

// liga a caneta numa tela: desenha com o botão esquerdo, manda os traços em lotes (~20/s)
function attachPen(tile, id) {
  let drawing = false, last = null, batch = [], flushTimer = null;
  const pos = (e) => {
    const b = videoBox(tile);
    return [Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), Math.max(0, Math.min(1, (e.clientY - b.top) / b.height))];
  };
  const flush = () => {
    flushTimer = null;
    if (!batch.length) return;
    const segs = batch.map((sg) => sg.map((v) => Math.round(v * 10000) / 10000));
    batch = [];
    sendRelay(null, { kind: 'ink', target: ownerKey(id), segs });
  };
  tile.el.addEventListener('pointerdown', (e) => {
    if (!tile.pen || e.button !== 0 || e.target.closest('.tile-bar, .react-bar, .pen-tools, .cam-pip')) return;
    if (tile.swapped) { swappedHint(); return; }
    e.preventDefault();
    e.stopPropagation();
    drawing = true;
    last = pos(e);
    try { tile.el.setPointerCapture(e.pointerId); } catch {}
  }, true);
  tile.el.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002) return;
    const seg = [last[0], last[1], p[0], p[1]];
    last = p;
    showInk(ownerKey(id), 'me', state.myName, [seg]);
    batch.push(seg);
    if (!flushTimer) flushTimer = setTimeout(flush, 50);
  });
  const end = () => { if (!drawing) return; drawing = false; flush(); };
  tile.el.addEventListener('pointerup', end);
  tile.el.addEventListener('pointercancel', end);
  // com a caneta ligada, clique/duplo clique não trocam o foco nem a tela cheia
  tile.el.addEventListener('click', (e) => { if (tile.pen && !e.target.closest('.tile-bar, .react-bar, .pen-tools')) e.stopPropagation(); }, true);
  tile.el.addEventListener('dblclick', (e) => { if (tile.pen && !e.target.closest('.tile-bar')) e.stopPropagation(); }, true);
}

// algo que um amigo fez na MINHA tela aparece também no meu monitor (por cima do jogo, fora da
// transmissão). Cada tipo tem sua opção: 'hand' mãozinha, 'ink' desenhos, 'react' emotes.
// envio para as janelas por cima do meu monitor (um ponto só: fácil de simular no teste)
function deskSend(method, p) { window.native[method](p); }
const DESK_KEYS = { hand: 'laserDesk', ink: 'inkDesk', react: 'reactDesk' };
function sendToMyDesktop(target, fromId, kind = 'hand') {
  return String(target) === String(state.myId) && fromId !== 'me' && state.share && state.share.source &&
    state.share.source.type === 'screen' && localStorage.getItem(DESK_KEYS[kind]) !== '0';
}

const frac01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
function showLaser(target, fromId, name, x, y, drawing = false) {
  // posição dentro da imagem (0..1); o que vem de um amigo pode ser qualquer número
  x = frac01(x); y = frac01(y);
  const color = `hsl(${nameHue(name)}, 85%, 55%)`;
  const tile = tileByOwner(target);
  if (tile && tile.el.isConnected && !tile.swapped) {
    tile.lasers = tile.lasers || {};
    let l = tile.lasers[fromId];
    if (!l) {
      l = document.createElement('div');
      l.className = 'hand';
      const art = window.ThemeFx.hand(window.Themes.current, 34); // a mãozinha do tema; a ponta do dedo continua no ponto
      l.innerHTML = art ? art.html : HAND_SVG;
      if (art) { l.style.margin = `${-art.tip[1]}px 0 0 ${-art.tip[0]}px`; l.style.transformOrigin = `${art.tip[0]}px ${art.tip[1]}px`; }
      const tag = document.createElement('span');
      tag.textContent = name;
      l.appendChild(tag);
      tile.screen.appendChild(l);
      tile.lasers[fromId] = l;
    }
    l.style.setProperty('--c', color);
    // rastro: liga o ponto anterior a este
    if (drawing && l.lastX != null) {
      trailLayer(tile);
      tile.trailLines.push({ x1: l.lastX, y1: l.lastY, x2: x, y2: y, color, t: performance.now() });
      tile.trailDraw();
    }
    l.lastX = drawing ? x : null;
    l.lastY = drawing ? y : null;
    const b = videoBox(tile), er = tile.screen.getBoundingClientRect();
    l.style.left = `${b.left - er.left + x * b.width}px`;
    l.style.top = `${b.top - er.top + y * b.height}px`;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => hideLaser(target, fromId), 1500);
  }
  // apontaram para a MINHA tela: mostra também no meu monitor, por cima do jogo
  // mão e rastro (Shift) obedecem opções separadas
  const handOk = sendToMyDesktop(target, fromId, 'hand');
  const inkOk = drawing && sendToMyDesktop(target, fromId, 'ink');
  if (handOk || inkOk) {
    deskSend('pointer', { displayId: state.share.source.displayId, id: fromId, x, y, color, name, drawing: inkOk, noHand: !handOk });
  }
}

// "apertar": a mão faz o gesto e sai uma ondinha no ponto
function showPress(target, fromId, name, x, y) {
  x = frac01(x); y = frac01(y);
  const color = `hsl(${nameHue(name)}, 85%, 55%)`;
  showLaser(target, fromId, name, x, y);
  const tile = tileByOwner(target);
  if (tile && tile.el.isConnected && !tile.swapped) {
    const l = tile.lasers && tile.lasers[fromId];
    if (l) { l.classList.remove('pressing'); void l.offsetWidth; l.classList.add('pressing'); }
    const b = videoBox(tile), er = tile.screen.getBoundingClientRect();
    const r = document.createElement('div');
    r.className = 'press-ripple';
    r.style.setProperty('--c', color);
    r.style.left = `${b.left - er.left + x * b.width}px`;
    r.style.top = `${b.top - er.top + y * b.height}px`;
    tile.screen.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }
  if (sendToMyDesktop(target, fromId)) {
    deskSend('pointer', { displayId: state.share.source.displayId, id: fromId, x, y, color, name, press: true });
  }
}

function hideLaser(target, fromId) {
  const tile = tileByOwner(target);
  if (tile && tile.lasers && tile.lasers[fromId]) {
    tile.lasers[fromId].remove();
    delete tile.lasers[fromId];
  }
  if (target === state.myId) window.native.pointerHide(fromId);
}

// o emote de um botão no desenho do tema em uso (ou o emoji de sempre)
function paintEmote(b) {
  const art = window.ThemeFx.emote(window.Themes.current, b.dataset.emoji);
  if (art) b.innerHTML = art; else b.textContent = b.dataset.emoji;
}

// liga reações e laser numa tela (de um amigo ou a sua)
function attachInteractions(tile, id) {
  const bar = document.createElement('div');
  bar.className = 'react-bar';
  for (const emoji of ['😂', '🔥', '👍', '😮', '💀', '❤️']) {
    const b = document.createElement('button');
    b.dataset.emoji = emoji;
    paintEmote(b);
    b.title = 'Reagir';
    b.onclick = (e) => {
      e.stopPropagation();
      const target = ownerKey(id);
      sendRelay(null, { kind: 'react', target, emoji });
      showReaction(target, emoji, state.myName);
    };
    b.ondblclick = (e) => e.stopPropagation();
    bar.appendChild(b);
  }
  tile.el.appendChild(bar);
  attachPen(tile, id);

  if (id === 'me') return; // mãozinha só na tela dos outros
  // Mãozinha: segure o botão DIREITO sobre a tela do amigo e mova.
  //  - clique esquerdo (com o direito segurado) ou clique rápido com o direito = "apertar"
  //  - Shift + mover = desenhar um rastro que some sozinho
  let on = false, moved = false, last = 0, downAt = null, suppressClick = false;
  const pos = (e) => {
    const b = videoBox(tile);
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  };
  const point = (e, force = false) => {
    const now = performance.now();
    if (!force && now - last < 33) return; // ~30 por segundo
    last = now;
    const { x, y } = pos(e);
    const target = ownerKey(id);
    const drawing = e.shiftKey;
    sendRelay(null, { kind: 'point', target, x, y, draw: drawing });
    showLaser(target, 'me', state.myName, x, y, drawing);
  };
  const press = (e) => {
    const { x, y } = pos(e);
    const target = ownerKey(id);
    sendRelay(null, { kind: 'press', target, x, y });
    showPress(target, 'me', state.myName, x, y);
  };
  tile.el.addEventListener('contextmenu', (e) => e.preventDefault());
  tile.el.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && (tile.swapped || e.target.closest('.cam-pip'))) { if (tile.swapped) swappedHint(); return; }
    if (e.button === 2) {
      on = true; moved = false;
      downAt = { x: e.clientX, y: e.clientY };
      tile.el.setPointerCapture(e.pointerId);
      point(e, true);
    } else if (e.button === 0 && on) {
      // apertar com o esquerdo enquanto aponta (sem trocar o foco da tela)
      e.preventDefault();
      e.stopPropagation();
      suppressClick = true;
      press(e);
    }
  });
  tile.el.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; e.stopPropagation(); } }, true);
  tile.el.addEventListener('pointermove', (e) => {
    if (!on) return;
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) moved = true;
    point(e);
  });
  const end = (e) => {
    if (!on || (e.type === 'pointerup' && e.button !== 2)) return;
    on = false;
    const target = ownerKey(id);
    if (!moved && e.type === 'pointerup') press(e); // clique rápido com o direito = apertar
    setTimeout(() => {
      sendRelay(null, { kind: 'point-end', target });
      hideLaser(target, 'me');
    }, moved ? 0 : 600); // deixa ver o "apertar" antes de sumir
  };
  tile.el.addEventListener('pointerup', end);
  tile.el.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ clipes (replay de 30 s)
function tileStream(id) {
  if (id === 'me') return state.share ? state.share.preview : state.camera ? state.camera.stream : null;
  const p = state.peers.get(id);
  return p ? (p.sharing ? p.remoteStream : p.camStream) : null;
}
function tileName(id) { return id === 'me' ? state.myName : (state.peers.get(id) || {}).name || 'tela'; }

async function toggleReplay(id) {
  const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
  let on;
  if (window.Clips.isOn(id)) {
    on = window.Clips.toggle(id); // desliga
  } else {
    const stream = tileStream(id);
    const opts = {
      // câmera do amigo entra no clipe na posição em que ela está na tela
      compose: () => (tile && !tile.camBox.classList.contains('hidden')) ? { video: tile.camVideo, pos: camPos(tile) } : null,
      // a trilha desta tela pode trocar com o replay ligado (ver Clips): sempre a atual
      source: () => tileStream(id),
    };
    // áudio do PC inteiro (Discord, jogo...) misturado com o som da transmissão
    if (localStorage.getItem('clipSys') !== '0' && (await window.native.audioAvailable())) {
      try {
        const mix = await window.ClipAudio.mixFor(() => tileStream(id));
        opts.audioTrack = mix.track;
        opts.release = mix.release;
      } catch (e) { console.warn('áudio do PC no clipe', e); }
    }
    on = window.Clips.toggle(id, stream, tileName(id), opts);
  }
  if (tile) tile.el.classList.toggle('replaying', on);
  toast(on
    ? `Replay ligado na tela de ${tileName(id)}: a partir de agora dá para salvar os últimos 30 s (Ctrl+Shift+C).`
    : `Replay desligado na tela de ${tileName(id)}.`);
}

async function saveClip(id) {
  if (!window.Clips.isOn(id)) {
    toggleReplay(id);
    return;
  }
  try {
    const r = await window.Clips.save(id);
    if (!r) { toast('Ainda não há imagem suficiente para o clipe. Espere alguns segundos.', 'error'); return; }
    toast(`Clipe de ${Math.round(r.seconds)} s salvo em Vídeos\\Tela Amigos.`);
  } catch (e) {
    toast(`Não consegui salvar o clipe: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ assistir junto
// ⏯ na tela de um amigo: pede play/pausa no PC dele (tecla de mídia do Windows: vale para
// YouTube no navegador, Spotify, VLC...), só se ele permitir. "Todo mundo pronto?": cada um
// confirma; com todos prontos vem a contagem 3-2-1 e, se a contagem foi pedida para o vídeo de
// alguém, o vídeo dele começa sozinho no "já".
function mediaAllowed() { return localStorage.getItem('mediactl') === '1'; }

function requestMedia(id) {
  const peer = state.peers.get(id);
  if (!peer || !peer.sharing) return;
  sendRelay(id, { kind: 'media', action: 'playpause' });
}

function pressMedia(byName) {
  window.Helper.mediaKey('playpause');
  const text = `⏯ ${byName} deu play/pausa no vídeo de ${state.myName}`;
  addChat('', text, true);
  sendRelay(null, { kind: 'media-done', text });
}

function onMediaRequest(peer) {
  if (!state.share) return;
  if (!mediaAllowed()) {
    toast(`${peer.name} quer dar play/pausa no seu vídeo. Para deixar, ligue "Amigos controlam play/pausa" na barra lateral.`);
    sendRelay(peer.id, { kind: 'media-denied' });
    return;
  }
  pressMedia(peer.name);
}

let readyCheck = null; // { id, from, fromName, target, ready: Set, timer }
function memberIds() { return [state.myId, ...state.peers.keys()].map(String); }

function startReadyCheck() {
  if (readyCheck) return;
  // alvo: quem está em foco (ou o único) transmitindo, para o play automático no "já"
  const sharing = [...state.peers.values()].filter((p) => p.sharing);
  const focused = state.focusId && state.peers.get(state.focusId);
  const target = focused && focused.sharing ? focused.id : sharing.length === 1 ? sharing[0].id : (state.share ? state.myId : null);
  const check = { id: `${state.myId}-${Date.now()}`, from: state.myId, fromName: state.myName, target: target ? String(target) : null };
  sendRelay(null, { kind: 'ready-check', ...check });
  onReadyCheck(check);
  markReady();
}

function onReadyCheck(c) {
  if (readyCheck) clearTimeout(readyCheck.timer);
  readyCheck = { ...c, ready: new Set() };
  readyCheck.timer = setTimeout(() => endReadyCheck('ninguém respondeu a tempo'), 60000);
  if (String(c.from) !== String(state.myId)) { Sfx.play('chat'); if (!document.hasFocus()) window.native.focusWindow(); }
  renderReady();
}

function markReady() {
  if (!readyCheck) return;
  sendRelay(null, { kind: 'ready', id: readyCheck.id });
  onReady(state.myId, readyCheck.id);
}

function onReady(who, id) {
  if (!readyCheck || readyCheck.id !== id) return;
  readyCheck.ready.add(String(who));
  renderReady();
  if (memberIds().every((m) => readyCheck.ready.has(m))) countdown();
}

function endReadyCheck(reason) {
  if (!readyCheck) return;
  clearTimeout(readyCheck.timer);
  readyCheck = null;
  $('#ready-banner').classList.add('hidden');
  if (reason) toast(`"Todo mundo pronto?" cancelado: ${reason}.`);
}

function renderReady() {
  const b = $('#ready-banner');
  if (!readyCheck) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const names = memberIds().map((m) => {
    const name = m === String(state.myId) ? state.myName : (state.peers.get(m) || state.peers.get(Number(m)) || {}).name || '?';
    return `${readyCheck.ready.has(m) ? '✅' : '⏳'} ${name}`;
  });
  const targetName = readyCheck.target
    ? (String(readyCheck.target) === String(state.myId) ? 'seu vídeo' : `o vídeo de ${(state.peers.get(readyCheck.target) || state.peers.get(Number(readyCheck.target)) || {}).name || '?'}`)
    : null;
  $('#ready-text').textContent = `${readyCheck.fromName} perguntou: todo mundo pronto?${targetName ? ` (no "já", ${targetName} começa)` : ''}`;
  $('#ready-list').textContent = names.join('   ');
  $('#ready-ok').classList.toggle('hidden', readyCheck.ready.has(String(state.myId)));
}

function countdown() {
  const check = readyCheck;
  clearTimeout(check.timer);
  readyCheck = null;
  $('#ready-banner').classList.add('hidden');
  const el = $('#countdown');
  let n = 3;
  const step = () => {
    el.classList.remove('hidden', 'pop');
    void el.offsetWidth; // reinicia a animação
    el.classList.add('pop');
    el.textContent = n > 0 ? String(n) : 'Já!';
    Sfx.play(n > 0 ? 'chat' : 'share');
    if (n === 0) {
      // quem transmite o vídeo-alvo dá o play (sem pedir permissão: todos confirmaram, inclusive ele)
      if (check.target && String(check.target) === String(state.myId) && state.share) pressMedia('a contagem');
      setTimeout(() => el.classList.add('hidden'), 900);
      return;
    }
    n--;
    setTimeout(step, 1000);
  };
  step();
}

// ------------------------------------------------------------------ gravação longa
// Grava a tela (com a câmera por cima e o mesmo áudio dos clipes) direto num MP4 em
// Vídeos\Tela Amigos, sem limite de tempo. Clique de novo para parar.
async function toggleRecording(id) {
  const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
  if (window.Clips.isRecording(id)) {
    const r = await window.Clips.stopRecording(id).catch((e) => { toast(`Falha ao salvar a gravação: ${e.message}`, 'error'); return null; });
    if (tile) { tile.el.classList.remove('recording'); tile.recBadge && tile.recBadge.remove(); tile.recBadge = null; }
    if (r) toast(`Gravação salva (${fmtDuration(r.seconds)}, ${fmtSize(r.bytes)}) em Vídeos\\Tela Amigos.`);
    else toast('A gravação terminou sem imagem (nada foi salvo).', 'error');
    return;
  }
  const stream = tileStream(id);
  if (!stream || !stream.getVideoTracks().length) { toast('Essa tela não está transmitindo nada para gravar.', 'error'); return; }
  const opts = {
    compose: () => (tile && !tile.camBox.classList.contains('hidden')) ? { video: tile.camVideo, pos: camPos(tile) } : null,
    source: () => tileStream(id), // a trilha pode trocar no meio da gravação: sempre a atual
  };
  if (localStorage.getItem('clipSys') !== '0' && (await window.native.audioAvailable())) {
    try {
      const mix = await window.ClipAudio.mixFor(() => tileStream(id));
      opts.audioTrack = mix.track;
      opts.release = mix.release;
    } catch (e) { console.warn('áudio do PC na gravação', e); }
  }
  if (!window.Clips.startRecording(id, stream, tileName(id), opts)) { toast('Não deu para começar a gravação.', 'error'); return; }
  const openErr = await window.Clips.recReady(id);
  if (openErr) {
    await window.Clips.stopRecording(id).catch(() => {});
    toast(`Não deu para criar o arquivo da gravação: ${openErr.message || openErr}`, 'error');
    return;
  }
  if (tile) {
    tile.el.classList.add('recording');
    tile.recBadge = document.createElement('div');
    tile.recBadge.className = 'rec-badge';
    tile.recBadge.title = 'Gravando · clique no botão de gravar de novo para parar';
    tile.el.appendChild(tile.recBadge);
  }
  updateRecBadges();
  toast(`Gravando a tela de ${tileName(id)}. Clique de novo no botão de gravar para parar e salvar.`);
}
function fmtDuration(sec) {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
function fmtSize(b) { return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`; }
function updateRecBadges() {
  for (const id of window.Clips.recordingIds()) {
    const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
    const info = window.Clips.recInfo(id);
    if (tile && tile.recBadge && info) tile.recBadge.textContent = `● REC ${fmtDuration(info.seconds)} · ${fmtSize(info.bytes)}`;
  }
}
setInterval(updateRecBadges, 1000);

// ------------------------------------------------------------------ sobreposição (por cima do jogo)
// Abre uma janelinha sempre por cima com a tela do amigo. A janela é do mesmo app, então
// recebe o próprio stream (sem decodificar de novo nem gastar banda extra).
const overlayWins = new Map(); // id do amigo -> janela
// trocou de tema: as sobreposições abertas trocam junto
window.Themes.onChange((id) => {
  for (const w of overlayWins.values()) { try { if (!w.closed && w.setTheme) w.setTheme(id); } catch {} }
});
function openOverlay(id) {
  const old = overlayWins.get(id);
  if (old && !old.closed) {
    // já aberta: clicar de novo destrava (se estiver travada) e traz para frente
    window.native.unlockOverlays();
    old.focus();
    toast('Sobreposição destravada.');
    return;
  }
  const p = state.peers.get(id);
  if (!p) return;
  const w = window.open('overlay.html', `overlay-${id}`);
  if (!w) { toast('Não consegui abrir a sobreposição.', 'error'); return; }
  overlayWins.set(id, w);
  const feed = () => {
    if (w.closed) return;
    if (typeof w.setup !== 'function') { setTimeout(feed, 100); return; }
    w.setup({
      stream: p.sharing ? p.remoteStream : p.camStream,
      cam: p.sharing && p.hasCam ? p.camStream : null,
      name: p.name,
      theme: window.Themes.current, // a janelinha usa as cores e as letras do tema (tema-janelas.css)
    });
  };
  feed();
  toast('Sobreposição aberta. "Travar" deixa o mouse atravessar; para destravar: o cadeado no canto dela, ' +
    'o botão de sobreposição de novo ou o ícone da bandeja.');
}
function closeOverlay(id) {
  const w = overlayWins.get(id);
  if (w && !w.closed) w.close();
  overlayWins.delete(id);
}

// ------------------------------------------------------------------ saúde da transmissão
// A cada 2 s:
//  - quem transmite: detecta o PC no limite e liga o "modo leve" (30 fps, até 720p) sozinho;
//    avisa os amigos para o indicador deles mostrar a causa certa
//  - quem assiste: calcula a qualidade de cada tela (verde/amarelo/vermelho + motivo)
state.lightMode = false;
let cpuStrikes = 0, cpuSeenAt = 0;
async function healthLoop() {
  if (state.share && state.peers.size) { try { await healthSender(state.share); } catch {} }
  await healthViewer();
}
// (sh = a transmissão no começo da volta: se ela parar ou for reiniciada durante as esperas, esta
// volta termina aqui. Antes dava erro no meio e a parte de quem assiste era pulada nessa volta.)
async function healthSender(sh) {
  {
    let cpu = false;
    let sendMime = '';
    let outFps = 0; // quadros por segundo que estou mandando (quem recebe distingue tela parada de travada)
    // as saídas de vídeo desta medida: quem codifica cada uma (placa ou processador) e o tamanho que ela DEVERIA ter (o da
    // tela, menos a redução que o app pediu para miniatura/camada). Não o que saiu: no processador, com banda ou CPU
    // apertados, o Chromium encolhe a imagem (1920x1080 saindo 640x360), e o aviso sumiria justo no pior caso.
    const encs = [];
    const look = (rep, r, sender) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      let e = null;
      try { const all = sender.getParameters().encodings || []; e = (r.rid && all.find((x) => x.rid === r.rid)) || all[0] || null; } catch {}
      if (e && e.active === false) return;
      const c = r.codecId && rep.get(r.codecId), src = r.mediaSourceId && rep.get(r.mediaSourceId);
      const div = (e && e.scaleResolutionDownBy) || 1;
      const w = src && src.width ? Math.round(src.width / div) : r.frameWidth || 0;
      const h = src && src.height ? Math.round(src.height / div) : r.frameHeight || 0;
      encs.push({ w, h, sent: `${r.frameWidth || 0}x${r.frameHeight || 0}`, enc: r.encoderImplementation || '', hw: r.powerEfficientEncoder, mime: (c && c.mimeType) || '' });
    };
    const sfuS = sh.sfu && window.Sfu.pubSender();
    if (sfuS) {
      try {
        const rep = await sfuS.getStats();
        rep.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') outFps = Math.max(outFps, r.framesPerSecond || 0); look(rep, r, sfuS); });
      } catch {}
    }
    for (const peer of state.peers.values()) {
      if (!peer.vT.sender.track) continue;
      try {
        const rep = await peer.vT.sender.getStats();
        rep.forEach((r) => {
          look(rep, r, peer.vT.sender);
          if (r.type === 'outbound-rtp' && r.kind === 'video') outFps = Math.max(outFps, r.framesPerSecond || 0);
          if (r.type === 'outbound-rtp' && r.qualityLimitationReason === 'cpu') cpu = true;
          if (r.type === 'outbound-rtp' && r.codecId && rep.get(r.codecId)) {
            const m = rep.get(r.codecId).mimeType || '';
            if (/h265|av1/i.test(m) || !sendMime) sendMime = m;
          }
        });
      } catch {}
    }
    // a codificação pela placa está ligada no Chromium? (só importa na captura adaptativa)
    let gpuEnc = null;
    if (!sh.direct) { try { gpuEnc = (await window.native.gpuStatus()).video_encode || null; } catch {} }
    if (state.share !== sh) return; // parou ou reiniciou durante as esperas
    if (sendMime) markSendingCodec(sendMime);
    // a placa de vídeo está codificando? (só na captura adaptativa: na "Nativa direta" quem codifica é o helper,
    // sempre na placa, e o Chromium só embrulha uns quadros pequenos de mentira)
    sh.gpuEnc = gpuEnc;
    softCheck(sh, sh.direct ? [] : encs, !!gpuEnc && !/^enabled/.test(gpuEnc));
    const ns = state.nativeStats;
    // encoder do helper não dá conta: quadros descartados, ou boa parte deles saindo atrasada (o
    // helper agora espera o encoder liberar em vez de descartar)
    const nsFps = (sh.settings && Number(sh.settings.fps)) || 60;
    if (ns && sh.native && (ns.dropped > 6 || (ns.late || 0) > nsFps * 0.4)) cpu = true;
    const now = Date.now();
    if (cpu) { cpuStrikes++; cpuSeenAt = now; } else cpuStrikes = 0;
    if (cpuStrikes >= 2 && sh.native && !sh.direct && !sh.autoDirect && localStorage.getItem('autoDirect') !== '0') {
      // Captura nativa adaptativa: o WebRTC recodifica a tela uma vez POR AMIGO e, com um jogo
      // pesado disputando a placa, cada quadro chegava a levar 200+ ms. A "Nativa direta" manda o
      // vídeo que o helper já codifica (prioridade alta na placa) para todos: bem mais leve.
      cpuStrikes = 0;
      switchToDirect();
    } else if (!state.lightMode && cpuStrikes >= 2) {
      state.lightMode = true;
      // (na "Nativa direta" não há o que reduzir por amigo: a placa manda os quadros que consegue)
      toast(sh.direct
        ? 'Seu PC está no limite (jogo pesado): a transmissão sai com os quadros que a placa consegue. Limitar o FPS do jogo um pouco abaixo da taxa do monitor costuma resolver.'
        : 'Seu PC está no limite: modo leve ligado (30 fps, até 720p) para não travar.');
      for (const peer of state.peers.values()) applySendParams(peer);
    } else if (state.lightMode && now - cpuSeenAt > 20000) {
      state.lightMode = false;
      toast(sh.direct ? 'Seu PC voltou a dar conta da transmissão.' : 'Modo leve desligado: qualidade normal de volta.');
      for (const peer of state.peers.values()) applySendParams(peer);
    }
    // a causa certa para o indicador dos amigos: PC no limite, captura abaixo do alvo, jogando
    // (gaming = um jogo desenhando o tempo todo; navegador/player em tela cheia não conta: lá,
    //  nenhum quadro novo é só vídeo pausado ou página parada)
    const capFps = ns && sh.native ? ns.captureFps : null;
    sendRelay(null, { kind: 'health', direct: !!sh.direct, cpu: state.lightMode || cpu, cap: capFps, target: (state.lightMode ? 30 : (sh.settings && sh.settings.fps) || 60), gaming: gameDrawing(), out: Math.round(outFps), sw: sh.soft || null });
  }
}

// ---- a placa de vídeo está codificando a minha transmissão?
// Na captura adaptativa quem codifica é o Chromium, uma cópia por amigo (e uma para o servidor): na placa de vídeo
// ("MediaFoundation... NVIDIA/AMD/Intel") ou, quando ela não está disponível, no processador (OpenH264, libvpx,
// libaom), que com um jogo aberto não dá conta. Foi o que aconteceu no diagnóstico de 2026-11-12: a placa do Toddy
// travou com o RDR2, a captura nativa caiu e o Chromium passou a codificar em 720p no processador, sem ninguém saber.
// Medido neste Electron (placa NVIDIA): H.264 e H.265 a partir de 640x360 vão para a placa; até 480x270 o Chromium
// usa o processador de propósito (custa pouco: não conta aqui); VP8, VP9 e AV1 vão sempre para o processador. Uma
// miniatura que vira tela cheia volta para a placa (conferido), e o tamanho que vale é o pedido (ver look()).
// Dois sinais: o nome do encoder de cada saída (o Chromium só diz com uma captura dele ou câmera ativa: na captura do
// Chromium sim, como no caso do Toddy; na Nativa adaptativa, não) e a codificação pela placa ligada ou não no Chromium
// do app (vale sempre; "disabled_software" quando ele desliga a placa, por exemplo depois de ela travar).
const SOFT_MIN_PX = 640 * 360;
function isSoftEnc(s) {
  if (s.hw === true) return false;
  if (s.hw === false) return true;
  const n = s.enc || ''; // sem o powerEfficientEncoder: pelo nome
  return /openh264|libvpx|libaom|svt/i.test(n) && !/mediafoundation|accelerator|external|nvidia|amd|intel|qsv/i.test(n);
}
// streams: [{ w, h, enc, hw, mime }] das saídas de vídeo. null = tudo o que é grande está na placa; senão o motivo:
// 'codec' (um codec que aqui só o processador faz: AV1, VP9, VP8), 'limite' (parte na placa e parte no processador: a
// placa não abriu mais uma cópia) ou 'placa' (nada na placa: travou, ou o driver não está deixando)
// (encOff: a codificação pela placa está desligada no Chromium: tudo sai do processador)
function softEncode(streams, encOff = false) {
  const big = streams.filter((s) => s.w * s.h >= SOFT_MIN_PX);
  if (encOff && big.length) return 'placa';
  const soft = big.filter(isSoftEnc);
  if (!soft.length) return null;
  if (soft.some((s) => /av1|vp8|vp9/i.test(s.mime || ''))) return 'codec';
  return soft.length < big.length ? 'limite' : 'placa';
}
const SOFT_TEXT = {
  placa: 'Sua placa de vídeo parou de codificar a transmissão: agora é o processador que faz isso, e com jogo aberto a sua tela ' +
    'engasga para os amigos. Feche e abra o Tela Amigos; se continuar, reinicie o PC e atualize o driver da placa de vídeo.',
  limite: 'Sua placa de vídeo não está dando conta de uma cópia da tela para cada amigo: parte delas está saindo pelo processador. ' +
    'Em Ajustes, troque a Captura para "Nativa direta" (uma cópia só, para todos).',
  codec: 'O codec escolhido (AV1, VP9 ou VP8) sai pelo processador nesta captura, e isso pesa muito com jogo aberto. ' +
    'Em "Trocar tela", ponha o Codec em "Automático": a placa de vídeo faz H.265 e H.264.',
};
// a notificação do Windows (quem está jogando em tela cheia não vê o aviso dentro do app)
const SOFT_NOTE = {
  placa: 'Sua placa de vídeo parou de codificar a transmissão, e a sua tela está engasgando para os amigos. Clique para ver o que fazer.',
  limite: 'Sua placa de vídeo não está dando conta de uma cópia da tela para cada amigo. Clique para ver o que fazer.',
  codec: 'O codec escolhido está pesando no processador. Clique para ver o que fazer.',
};
// o motivo que os amigos veem no indicador da tela de quem transmite
const SOFT_WHY = {
  placa: (n) => `a placa de vídeo de ${n} parou de codificar: quem codifica agora é o processador`,
  limite: (n) => `a placa de vídeo de ${n} não dá conta de uma cópia para cada amigo: parte sai pelo processador`,
  codec: (n) => `${n} está transmitindo num codec que sai pelo processador (AV1, VP9 ou VP8)`,
};
const softWarned = {}; // último aviso de cada motivo (no máximo um a cada 10 min)
let softFocusAt = 0;
let underTest = true; // nas cópias abertas pelos testes, sem notificação do Windows (até o main responder: na dúvida, sem)
try { window.native.testing().then((t) => { underTest = !!t; }, () => { underTest = false; }); } catch { underTest = false; }
// quem codifica esta saída, para o diagnóstico ("não informado": o Chromium não disse o nome nem se é da placa)
function encWho(s, encOff) {
  if (encOff) return 'processador: codificação pela placa desligada no Chromium';
  if (isSoftEnc(s)) return 'processador';
  return s.hw === true || /mediafoundation|accelerator|external|nvidia|amd|intel|qsv/i.test(s.enc || '') ? 'placa' : 'não informado';
}
function softCheck(sh, encs, encOff = false) {
  const kind = softEncode(encs, encOff);
  const big = encs.filter((s) => s.w * s.h >= SOFT_MIN_PX).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (big) sh.encSeen = `${big.enc || '?'} ${big.sent || big.w + 'x' + big.h} de ${big.w}x${big.h} ${String(big.mime).replace(/^video\//i, '')} (${encWho(big, encOff)})`;
  // o mesmo motivo em 3 medidas seguidas (4 a 6 s): uma troca de tamanho ou de encoder no meio não avisa
  sh.softN = kind ? (kind === sh.softKind ? (sh.softN || 0) + 1 : 1) : 0;
  sh.softKind = kind;
  if (!kind) {
    if (sh.soft) console.log('codificação de volta na placa de vídeo');
    sh.soft = null;
    return;
  }
  if (sh.softN < 3 || sh.soft === kind) return;
  sh.soft = kind;
  console.warn(`codificação no processador (${kind})${encOff ? ' — codificação pela placa desligada no Chromium' : ''}: ` +
    encs.filter((s) => s.w * s.h >= SOFT_MIN_PX && (encOff || isSoftEnc(s))).map((s) => `${s.enc || '?'} ${s.sent || ''} de ${s.w}x${s.h}`).join(' · '));
  const now = Date.now();
  if (now - (softWarned[kind] || 0) < 600000) return;
  softWarned[kind] = now;
  softFocusAt = now;
  toast(SOFT_TEXT[kind], 'error');
  if (!document.hasFocus() && !underTest) {
    try {
      const n = new Notification('Tela Amigos', { body: SOFT_NOTE[kind], silent: true, icon: 'icon.png' });
      n.onclick = () => window.native.focusWindow();
    } catch {}
  }
}
// voltou para o app (ex.: saiu do jogo) e a placa continua sem codificar: o aviso de novo (no máximo 1 por minuto)
window.addEventListener('focus', () => {
  const sh = state.share;
  if (!sh || !sh.soft || Date.now() - softFocusAt < 60000) return;
  softFocusAt = Date.now();
  toast(SOFT_TEXT[sh.soft], 'error');
});

async function healthViewer() {
  for (const peer of state.peers.values()) {
    if (!peer.sharing || !peer.tile || state.hidden.has(peer.id)) continue;
    let v = null, rtt = null, vRep = null, vCodec = '';
    // a tela principal dele (mesmo se aqui ela estiver no canto, trocada com a 2ª)
    const mainTrack = peer.remoteStream.getVideoTracks()[0];
    const mainId = mainTrack ? mainTrack.id : null;
    try {
      const reports = [await peer.pc.getStats()];
      if (peer.sfuIn && peer.sfuIn.videoRecv) reports.push(await peer.sfuIn.videoRecv.getStats());
      for (const rep of reports) rep.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        if (mainId && r.trackIdentifier) { if (r.trackIdentifier === mainId) { v = r; vRep = rep; } return; }
        if (!v || (r.bytesReceived || 0) > (v.bytesReceived || 0)) { v = r; vRep = rep; }
      });
      const vc = v && v.codecId && vRep ? vRep.get(v.codecId) : null;
      if (vc && vc.mimeType) vCodec = vc.mimeType.split('/')[1] || '';
      (await peer.pc.getStats()).forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = r.currentRoundTripTime;
      });
    } catch { continue; }
    if (!v) continue;
    const shownVideo = peer.tile.swapped ? peer.tile.s2.video : peer.tile.video; // onde a 1ª tela está aparecendo
    const pq = shownVideo.getVideoPlaybackQuality ? shownVideo.getVideoPlaybackQuality() : null;
    const prev = peer.qprev;
    peer.qprev = {
      t: performance.now(), lost: v.packetsLost || 0, recv: v.packetsReceived || 0, fz: v.freezeCount || 0,
      fRecv: v.framesReceived || 0, fDec: v.framesDecoded || 0, decT: v.totalDecodeTime || 0,
      shown: pq ? pq.totalVideoFrames : 0, pdrop: pq ? pq.droppedVideoFrames : 0, bytes: v.bytesReceived || 0,
    };
    if (!prev) continue;
    const q = peer.qprev, dt = (q.t - prev.t) / 1000 || 2;
    const lostD = Math.max(0, q.lost - prev.lost), recvD = Math.max(0, q.recv - prev.recv);
    const loss = lostD + recvD ? lostD / (lostD + recvD) : 0;
    const freezes = q.fz - prev.fz;
    const fps = v.framesPerSecond || 0;
    const recvFps = (q.fRecv - prev.fRecv) / dt;                   // quadros que chegaram
    const decMs = q.fDec > prev.fDec ? ((q.decT - prev.decT) / (q.fDec - prev.fDec)) * 1000 : 0;
    const shownD = q.shown - prev.shown, pdropD = q.pdrop - prev.pdrop;
    const renderDrop = shownD > 0 ? pdropD / shownD : 0;            // quadros que o SEU PC não desenhou
    const thumb = peer.iWant === 'thumb';
    const h = peer.health || {};
    // "poucos quadros" é relativo ao que o amigo escolheu (30 ou 60 fps)
    const lowFps = thumb ? 12 : Math.min(40, (h.target || 60) * 0.75), badFps = thumb ? 5 : 15;
    // a captura dele parou com um jogo aberto (o app dele tenta reiniciar sozinho)
    const capStopped = !!h.gaming && h.cap === 0;
    // "PC dele no limite" = o app DELE avisou (encoder atrasado/descartando). Antes contava também
    // "capturando menos quadros que o alvo", mas a captura só conta quadros NOVOS: tela parada ou um
    // filme a 24/30 fps acusavam "PC no limite" para todo mundo, com a imagem perfeita.
    // (codificando no processador só conta quando a imagem mostra: com quadros sobrando, nada a dizer)
    const senderSlow = !!h.cpu || capStopped || (!!h.sw && (fps < lowFps || freezes >= 1));
    const netBad = loss > 0.01 || (rtt && rtt > 0.12) || (freezes >= 1 && lostD > 0);
    const kbpsIn = ((q.bytes - prev.bytes) * 8) / dt / 1000;
    // "Nativa direta" dele vindo direto para mim: aviso quanto recebi nestes 2 s. O app dele compara
    // com o que mandou e sabe se a ida até mim está cheia (em vez de adivinhar pelo ping, que também
    // sobe quando o problema é na volta ou no meu próprio upload)
    if (h.direct && !peer.sfuIn && dt > 1 && dt < 4) { try { dcSend(peer, { t: 'rx', kb: Math.round(kbpsIn) }); } catch {} }
    // dados chegando e nada aparecendo: quadros sem o quadro-chave de antes (não é o seu PC)
    const noPicture = fps < badFps && kbpsIn > 300 && renderDrop <= 0.1 && decMs <= 25;
    const mineBad = !noPicture && (renderDrop > 0.1 || decMs > 25 || (recvFps > fps + 10));
    let level = 'good', reason = 'tudo certo', short = '';
    if (fps < lowFps || freezes >= 1 || netBad || senderSlow || mineBad) {
      level = 'warn';
      if (senderSlow) {
        reason = `PC de ${peer.name} no limite${h.cap != null ? ` (capturando ${Math.round(h.cap)} fps)` : ''}${h.gaming ? ' — jogo pesado' : ''}`;
        short = `PC de ${peer.name}`;
        if (h.sw) reason = SOFT_WHY[h.sw](peer.name);
        if (capStopped) { // não é rede nem o meu PC: a captura dele travou com o jogo
          reason = `a captura de ${peer.name} parou (0 fps com o jogo aberto); o app dele tenta reiniciar sozinho`;
          short = 'captura dele parou';
        }
      } else if (netBad) {
        reason = loss > 0.01 ? `rede entre vocês perdendo pacotes (${(loss * 100).toFixed(1)}%)`
          : rtt && rtt > 0.12 ? `rede com atraso alto (${Math.round(rtt * 1000)} ms)` : 'rede instável';
        short = 'rede';
      } else if (mineBad) {
        reason = `seu PC está ocupado (${renderDrop > 0.1 ? `${Math.round(renderDrop * 100)}% dos quadros não desenhados` : `decodificação lenta ${Math.round(decMs)} ms`})`;
        short = 'seu PC';
      } else if (noPicture) {
        reason = `chegando ${Math.round(kbpsIn / 100) / 10} Mb/s mas sem imagem (esperando quadro-chave)`;
        short = 'esperando imagem';
      } else if (freezes >= 1) { reason = 'travou um pouco'; short = 'travou'; }
      else { reason = `poucos quadros (${Math.round(fps)} fps) — a tela pode estar parada`; short = 'tela parada?'; }
    }
    if (loss > 0.05 || fps < badFps || freezes >= 2) level = 'bad';
    peer.quality = { level, reason };
    if (peer.sfuIn) sfuRxFeedback(peer, !mineBad && !senderSlow && !thumb && (loss > 0.03 || (freezes >= 1 && lostD > 0)));
    // histórico (gráfico de qualidade): um ponto a cada ~2 s, últimos 10 min, guardado pelo nome
    let hist = state.hist.get(peer.name);
    if (!hist) { hist = []; state.hist.set(peer.name, hist); }
    hist.push({
      t: Date.now(), fps: Math.round(fps), mbps: Math.max(0, ((q.bytes - prev.bytes) * 8) / dt / 1e6),
      rtt: rtt != null ? Math.round(rtt * 1000) : null, loss, fz: Math.max(0, freezes), level, short, reason,
      h: v.frameHeight || 0, thumb,
    });
    if (hist.length > 300) hist.splice(0, hist.length - 300);
    if (histOpen === peer.id) drawHistory();
    autoResolution(peer, mineBad && !thumb, level === 'good', v.frameHeight || 0);
    freezeWatch(peer, q.fDec < prev.fDec ? -1 : q.fDec - prev.fDec);
    const t = peer.tile;
    if (t.qdot) {
      t.qdot.className = `qdot ${level}`;
      t.qbadge.className = `qbadge ${level}`;
      t.qbadge.title = `Qualidade: ${reason}`;
      const ms = rtt != null ? Math.round(rtt * 1000) : null;
      setQText(t.qtext, Math.round(fps), ms, short, v.frameHeight || 0, kbpsIn / 1000, codecLabel(vCodec));
      peer.q = { fps: Math.round(fps), ms, level, res: v.frameHeight || 0, mbps: kbpsIn / 1000 };
      paintPersonQuality(peer);
    }
  }
  paintStatsPane();
}
setInterval(() => { healthLoop().catch(() => {}); }, 2000);

// eventos do AudioHelper (estatísticas e fim da captura nativa)
function onHelperEvent(msg) {
  if (msg.type === 'video-stats') { state.nativeStats = msg; captureStallWatch(msg); }
  else if (msg.type === 'video-ended' && state.share && state.share.native) {
    toast('A janela compartilhada foi fechada.');
    stopShare();
  } else if (msg.type === 'video-warn') {
    toast(msg.message);
  } else if (msg.type === 'game-state') {
    const was = state.gaming;
    state.gaming = !!msg.playing;
    state.gamingExe = msg.exe || '';
    if (state.gaming !== was) applyPlayoutBuffer();
    if (state.gaming !== was && state.share && localStorage.getItem('gamehide') !== '0') {
      toast(state.gaming
        ? 'Jogo em tela cheia: sua prévia foi escondida para economizar (a transmissão continua).'
        : 'Sua prévia voltou.');
    }
    render();
  }
  if (msg.type === 'boost') console.log(`prioridade de GPU (pid: nível 4=alta, 3=acima do normal): ${safeJson(msg.result)}`);
  if (msg.type === 'helper-exit') console.warn(`AudioHelper fechou (código ${msg.code})`);
  if (msg.type === 'warn') {
    console.warn(`AudioHelper: ${msg.message}`); // ex.: falha ao capturar o som de um jogo
    if (/saída de som escolhida/.test(msg.message) && state.share && state.share.audio) toast(`Som: ${msg.message}`, 'error');
  }
  if (msg.type === 'helper-exit') state.nativeStuck = ''; // helper novo: a placa pode funcionar de novo
  if (msg.type === 'video-stuck') {
    // chamada da placa presa no helper (driver/notebook com duas placas): o som segue funcionando,
    // a imagem passa para a captura do Chromium
    console.warn(`AudioHelper: ${msg.message}`);
    state.nativeStuck = String(msg.message || '').slice(0, 160);
    if (state.share && state.share.native) recoverShare('a placa de vídeo travou');
  }
  if ((msg.type === 'video-error' || msg.type === 'helper-exit') && state.share && state.share.native) {
    recoverShare(msg.type === 'video-error' ? msg.message : 'o auxiliar de captura fechou');
  } else if (msg.type === 'helper-exit' && state.share && state.share.audio) {
    // Captura do Chromium com o som pelo auxiliar: o som acabou junto com ele. Antes ficava mudo sem
    // aviso, e os amigos continuavam vendo o controle de volume como se houvesse som.
    const sh = state.share;
    sh.audio = null;
    sh.audioWhy = 'o auxiliar de captura fechou';
    window.HelperAudio.stop().catch(() => {});
    toast('O som da transmissão parou (o auxiliar de captura fechou). Pare e transmita de novo para o som voltar.', 'error');
    for (const peer of state.peers.values()) { applySendParams(peer); sendState(peer.id); }
    sfuSync();
  }
}

// Jogo pesado aberto: o PC demora mais (e de forma irregular) para decodificar/desenhar, e as
// telas dos amigos engasgam. Um pequeno buffer de reprodução (~150 ms a mais de atraso) absorve
// essas variações; sem jogo, volta ao mínimo (menor atraso possível).
const GAME_BUFFER_MS = 150;
// Atraso de cada amigo (guardado pelo nome):
//  auto   = mínimo; com jogo pesado aberto ganha +0,15 s para não engasgar
//  low    = sempre o mínimo possível (jogar junto, dar dica na hora)
//  smooth = +0,35 s de buffer: absorve as variações da rede (Radmin ruim, Wi-Fi)
const LATENCY_MODES = { auto: 'Automático', low: 'Atraso mínimo', smooth: 'Imagem lisa (+0,35 s)' };
function latencyMode(peer) { return localStorage.getItem(`lat:${peer.name}`) || 'auto'; }
function applyPlayoutBuffer() {
  const gameBuf = state.gaming && localStorage.getItem('gamebuffer') !== '0' ? GAME_BUFFER_MS : null;
  for (const peer of state.peers.values()) {
    const mode = latencyMode(peer);
    const target = mode === 'low' ? null : mode === 'smooth' ? 350 : gameBuf;
    const recvs = [...peer.pc.getReceivers()];
    // pelo servidor de vídeo a imagem e o som chegam por outra conexão (antes a "Imagem lisa" não valia lá)
    if (peer.sfuIn) recvs.push(...[peer.sfuIn.videoRecv, peer.sfuIn.audioRecv].filter(Boolean));
    for (const r of recvs) {
      if (!r.track) continue;
      // som: só a "Imagem lisa" mexe nele, e fora dela ele VOLTA ao normal. Antes ficava nos 350 ms
      // para sempre depois de passar pela "Imagem lisa", e a imagem (sincronizada com o som)
      // continuava atrasada mesmo em "Atraso mínimo".
      const t = r.track.kind === 'video' ? target : (mode === 'smooth' ? 350 : null);
      try { r.jitterBufferTarget = t; } catch {}
    }
    if (peer.tile && peer.tile.latBtn) {
      peer.tile.latBtn.classList.toggle('active', mode !== 'auto');
      peer.tile.latBtn.title = `Atraso: ${LATENCY_MODES[mode]} (clique para trocar)`;
      peer.tile.latBtn.dataset.v = { auto: 'auto', low: 'mínimo', smooth: 'liso' }[mode] || mode; // em poucas letras, para os temas que escrevem os botões
    }
  }
}
function cycleLatency(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  const order = ['auto', 'low', 'smooth'];
  const next = order[(order.indexOf(latencyMode(peer)) + 1) % order.length];
  localStorage.setItem(`lat:${peer.name}`, next);
  applyPlayoutBuffer();
  toast(`Tela de ${peer.name}: ${LATENCY_MODES[next]}.`);
}

// Entrou alguém sem H.265 durante a "Nativa direta" em H.265: reinicia em H.264 (o vídeo direto
// é o mesmo para todos, então precisa ser um codec que todos decodificam)
// O que a "Nativa direta" em H.265/AV1 tem de errado com quem está na sala agora (ou null): alguém
// que não decodifica o codec, ou (pelo servidor de vídeo) alguém numa versão antiga do app. Só conta
// quem já mandou o estado dele: quem acabou de entrar ainda não disse o que decodifica, e quando
// disser o tratamento do "state" confere de novo.
function directCodecProblem() {
  const sh = state.share;
  if (!sh || !sh.direct || !sh.codec || sh.codec === 'h264') return null;
  const known = [...state.peers.values()].filter((p) => p.h265 !== undefined);
  const bad = known.find((p) => (sh.codec === 'hevc' && !p.h265) || (sh.codec === 'av1' && !p.av1));
  if (bad) return { who: bad.name, from: sh.codec, why: '' };
  const old = sfuInUse() ? known.find((p) => !p.sfu2) : null;
  return old ? { who: old.name, from: 'hevc', why: 'sfu' } : null;
}

let restartingCodec = false;
async function restartDirectCodec(who, from = 'hevc', why = '') {
  if (restartingCodec || !state.share) return;
  restartingCodec = true;
  let before = null;
  try {
    if (shareBusy) {
      // Outro (re)início em andamento (troca de tela, Ajustes, resolução pela rede, captura que
      // caiu): o startShare ignoraria este pedido. Antes a função voltava na mesma hora, achava o
      // mesmo amigo sem suporte e chamava a si mesma de novo, sem nunca dar vez ao resto do app: a
      // interface travava de vez (e, depois de recarregar, o H.265/AV1 ficava bloqueado neste PC).
      // Agora espera o outro terminar e confere se ainda precisa.
      for (let i = 0; shareBusy && i < 300; i++) await new Promise((r) => setTimeout(r, 100));
      const p = shareBusy ? null : directCodecProblem();
      if (!p) return;
      ({ who, from, why } = p);
    }
    before = state.share;
    if (!before) return;
    toast(why === 'sfu'
      ? `${who} está numa versão antiga do app: pelo servidor de vídeo a sua transmissão passou para H.264 (com todos atualizados, a próxima já sai em H.265).`
      : from === 'av1'
        ? `${who} não tem placa que decodifica AV1: a sua transmissão trocou de codec.`
        : `${who} não decodifica H.265: a sua transmissão passou para H.264.`);
    selectedSource = before.source;
    await startShare({
      keep: true, engine: 'native-direct', noAv1: true, forceH264: from === 'hevc' || !!before.settings.forceH264,
      autoDirect: before.autoDirect, startKbps: state.nativeKbps,
    });
  } finally { restartingCodec = false; }
  // Alguém sem suporte entrou durante a troca: confere de novo. Em outra volta do laço de eventos, e
  // só se a transmissão mudou mesmo (um reinício que não aconteceu nunca pode virar repetição).
  if (state.share && state.share !== before) {
    setTimeout(() => { const p = directCodecProblem(); if (p) restartDirectCodec(p.who, p.from, p.why); }, 0);
  }
}

let switchingDirect = false;
async function switchToDirect() {
  // (com outro início em andamento o startShare ignoraria o pedido, e o aviso dizia que trocou sem
  //  trocar; se o PC continuar no limite, o healthLoop pede de novo em alguns segundos)
  if (switchingDirect || shareBusy || !state.share) return;
  switchingDirect = true;
  try {
    toast('Seu PC está ocupado (jogo pesado): troquei para "Nativa direta", que pesa bem menos. Dá para voltar em Ajustes.');
    console.warn('PC no limite na captura adaptativa: trocando para nativa direta');
    selectedSource = state.share.source;
    await startShare({ keep: true, engine: 'native-direct', autoDirect: true, smartH: 0 });
  } finally { switchingDirect = false; }
}

// A captura nativa parou (placa de vídeo reiniciada, helper caiu...): reinicia a mesma tela
// sozinho. Se cair 3 vezes em 1 minuto, passa para a captura do Chromium.
const recoverTimes = [];
let recovering = false;
async function recoverShare(reason, forceChromium = false) {
  if (recovering || !state.share) return;
  recovering = true;
  const now = Date.now();
  while (recoverTimes.length && now - recoverTimes[0] > 60000) recoverTimes.shift();
  recoverTimes.push(now);
  const tooMany = forceChromium || recoverTimes.length > 3;
  toast(forceChromium
    ? `A captura travou de novo com o jogo aberto (${reason}). Mudei para a captura do Chromium. Se a tela continuar parada, ` +
      'coloque o jogo em "Tela cheia sem bordas" (ou "Janela sem bordas") nas opções de vídeo dele.'
    : tooMany ? `A captura nativa caiu de novo (${reason}). Usando a captura do Chromium.`
    : `A captura parou (${reason}). Reiniciando...`, 'error');
  const src = state.share.source;
  try {
    await new Promise((r) => setTimeout(r, 800));
    if (!state.share || !src) return;
    selectedSource = src;
    // (a mesma transmissão, com as configurações dela; na "direta" continua no bitrate em que estava)
    await startShare(tooMany ? { keep: true, engine: 'chromium', smartH: 0 }
      : { keep: true, startKbps: state.share.direct ? state.nativeKbps : 0 });
  } finally {
    recovering = false;
  }
}

// Captura nativa em 0 fps com um jogo aberto: o jogo desenha o tempo todo, então 0 quadros é
// captura travada (placa de vídeo reiniciou, jogo em tela cheia exclusiva...). Antes a tela ficava
// parada para todo mundo até parar e transmitir de novo. 6 s assim: reinicia a captura; travou de
// novo em até 3 min: passa para a captura do Chromium (outro método do Windows) e sugere sem bordas.
// (Sem jogo aberto, 0 fps pode ser só a tela parada: aí não faz nada.)
let capZero = null; // { share, since }
const capStalls = [];
// "Jogando", para o helper, é qualquer janela em primeiro plano cobrindo o monitor inteiro. Navegador
// e player de vídeo em tela cheia também cobrem, mas NÃO desenham o tempo todo: vídeo pausado ou
// página parada = nenhum quadro novo, sem nada estar travado. Antes, pausar um filme em tela cheia
// por 6 s reiniciava a captura, e pausar de novo em até 3 min jogava a transmissão para a captura
// do Chromium (com aviso de erro) pelo resto dela.
const NOT_A_GAME = /^(chrome|msedge|firefox|opera|brave|vivaldi|arc|zen|librewolf|waterfox|thorium|chromium|browser|iexplore|vlc|mpc-hc|mpc-hc64|mpc-be|mpc-be64|mpv|mpvnet|potplayer|potplayer64|potplayermini|potplayermini64|wmplayer|stremio|kodi|plex|discord|spotify)\.exe$/i;
function gameDrawing() { return !!state.gaming && !NOT_A_GAME.test(state.gamingExe || ''); }
function captureStallWatch(st) {
  const sh = state.share;
  if (!sh || !sh.native || !gameDrawing() || recovering || (st.captureFps || 0) > 0) { capZero = null; return; }
  const now = Date.now();
  if (!capZero || capZero.share !== sh) { capZero = { share: sh, since: now }; return; }
  if (now - capZero.since < 6000) return;
  capZero = null;
  captureFail(`0 fps com o jogo aberto (${state.gamingExe || '?'})`);
}
// 1ª falha: reinicia a captura nativa; 2ª em até 3 min: captura do Chromium
function captureFail(reason) {
  const now = Date.now();
  while (capStalls.length && now - capStalls[0] > 180000) capStalls.shift();
  capStalls.push(now);
  const again = capStalls.length > 1;
  console.warn(`captura travada: ${reason}; ${again ? 'trocando para a captura do Chromium' : 'reiniciando a captura'}`);
  if (again) capStalls.length = 0;
  recoverShare(reason.replace(/ \(.*\)$/, ''), again);
}
// A captura nativa começou mas nunca entregou nenhuma imagem (o som vai, o vídeo não: tela preta
// para todo mundo). 10 s sem nenhum quadro: trata como captura travada.
function shareStartWatch() {
  const sh = state.share;
  if (!sh || !sh.native || recovering || sh.firstFrameOk) return;
  if (!sh.watchT0) { sh.watchT0 = Date.now(); return; }
  const ns = state.nativeStats;
  if (ns && ((ns.captureFps || 0) > 0 || (ns.fps || 0) > 0)) { sh.firstFrameOk = true; return; }
  if (Date.now() - sh.watchT0 < 10000) return;
  sh.firstFrameOk = true; // uma vez por transmissão
  captureFail('a captura não mandou nenhuma imagem');
}
setInterval(shareStartWatch, 1000);

async function stopShare() {
  shareGen++; // um início que ainda esteja abrindo a captura desiste (ver startShareInner)
  const share = state.share;
  if (!share) return;
  state.share = null;
  markSendingCodec('');
  if (window.Clips.isRecording('me')) toggleRecording('me'); // parou de transmitir: salva a gravação
  if (window.Clips.isOn('me')) { // replay da minha tela ficaria preso na trilha encerrada
    window.Clips.stop('me');
    if (meTile) meTile.el.classList.remove('replaying');
  }
  share.video.onended = null;
  stopSecond(true);
  if (state.pickSecond) { state.pickSecond = false; $('#share-modal').classList.add('hidden'); $('#share-modal').classList.remove('second'); }
  if (share.native) await window.NativeVideo.stop();
  else share.stream.getTracks().forEach((t) => t.stop());
  if (share.audio) await window.HelperAudio.stop();
  sfuSync();
  for (const peer of state.peers.values()) {
    peer.sfuPulling = false;
    applySendParams(peer);
    sendState(peer.id);
  }
  $('#btn-share').textContent = 'Compartilhar tela';
  $('#btn-share').title = '';
  // a detecção de jogo continua enquanto estiver na sala (ajusta a reprodução das telas dos amigos)
  if (state.leaving) { window.Helper.gameWatch(false).catch(() => {}); state.gaming = false; applyPlayoutBuffer(); }
  state.lightMode = false;
  $('#btn-stop').classList.add('hidden');
  $('#btn-adjust').classList.add('hidden');
  $('#btn-share2').classList.add('hidden');
  $('#adjust-panel').classList.add('hidden');
  render();
}

// ------------------------------------------------------------------ sala / UI
function enterRoom() {
  window.Vida.entrei(); // quem já estava na sala aparece sem a animação de "chegou"
  $('#lobby').classList.add('hidden');
  $('#room').classList.remove('hidden');
  window.Themes.screen('room');
  // o endereço vai num pedaço à parte (alguns temas destacam só ele); o texto é o mesmo de sempre
  const chip = $('#btn-copy-ip'), chipText = document.createElement('span'), chipK = document.createElement('span'), chipV = document.createElement('span');
  chipK.className = 'chip-k';
  chipK.textContent = isOnlineCode(state.hostIp) ? 'Sala online · ' : 'Sala · ';
  chipV.className = 'chip-v';
  chipV.textContent = state.hostIp;
  chipText.append(chipK, chipV);
  chip.textContent = '';
  chip.appendChild(chipText);
  chip.dataset.kind = isOnlineCode(state.hostIp) ? 'online' : 'radmin';
  $('#btn-copy-ip').title = isOnlineCode(state.hostIp) ? 'Copiar o código da sala para mandar aos amigos' : 'Copiar o IP da sala';
  $('#btn-close-room').classList.toggle('hidden', !state.isHost);
  render();
  // detecta jogo em tela cheia: com jogo pesado, as telas dos amigos ganham um respiro (buffer)
  window.Helper.gameWatch(true).catch(() => {});
  // aquece o AudioHelper e a captura para o "Compartilhar" abrir rápido
  window.native.audioAvailable().then((ok) => ok && window.Helper.list()).catch(() => {});
}

async function leaveRoom() {
  state.leaving = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  endReadyCheck(null);
  await stopShare();
  window.Helper.gameWatch(false).catch(() => {});
  state.gaming = false;
  // replay/gravação da câmera (minha tela sem compartilhar) também param
  if (window.Clips.isRecording('me')) await toggleRecording('me');
  if (window.Clips.isOn('me')) window.Clips.stop('me');
  if (state.camera) { state.camera.track.stop(); state.camera = null; $('#btn-camera').textContent = 'Câmera'; $('#btn-camera').classList.remove('active'); }
  for (const id of [...state.peers.keys()]) removePeer(id);
  window.Sfu.reset();
  state.sfuServer = false;
  // "Sair" não fecha mais a sala de quem hospeda (ela fica aberta em segundo plano)
  clearInterval(heartbeat);
  setReconnectBanner(false);
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onclose = null;
    try { ws.send(JSON.stringify({ type: 'leave' })); } catch {} // saída de propósito: avisa na hora
    setTimeout(() => ws.close(), 200);
  }
  state.isHost = false;
  closeHistory();
  closeMenus();
  // estes dois ficam fora da área da sala e continuavam abertos por cima do lobby (dava até para
  // clicar em "Compartilhar" sem estar em sala nenhuma)
  state.pickSecond = false;
  $('#share-modal').classList.add('hidden');
  $('#share-modal').classList.remove('second');
  $('#nettest-modal').classList.add('hidden');
  state.hostIp = '';
  lastTrayKey = '';
  window.native.trayStatus({ room: '', people: [], sharing: false });
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  state.ws = null;
  state.order = [];
  state.hidden.clear();
  state.focusId = null;
  state.leaving = false;
  $('#me-tile')?.remove();
  meTile = null;
  $('#room').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  window.Themes.screen('lobby');
  $('#btn-join').disabled = $('#btn-host').disabled = false;
  refreshMyRoom();
}

async function closeRoomForEveryone() {
  if (!confirm('Fechar a sala para todos? Quem estiver nela vai sair.')) return;
  await window.native.hostStop();
  await leaveRoom();
}

const ICONS = {
  focus: '<svg viewBox="0 0 24 24"><rect x="3" y="3.5" width="18" height="12" rx="1.5"/><path d="M4.5 20h4M10 20h4M15.5 20h4"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" class="fill"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.5 7.5C4.3 9 3 12 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  latency: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
  shot: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  res: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l3 3 3-3v6M16 9v6"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 4v16h16"/><path d="M7 15l4-5 3 3 5-6"/></svg>',
  screen2: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="13" height="10" rx="1.5"/><rect x="9" y="10" width="13" height="10" rx="1.5" class="fill"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>',
  playpause: '<svg viewBox="0 0 24 24"><path d="M4 5l8 7-8 7z" class="fill"/><path d="M15 5v14M20 5v14"/></svg>',
  record: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/><circle cx="9.5" cy="12" r="2.5" class="fill"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" class="fill"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 7.5L20 18M8.5 16.5L20 6"/></svg>',
  overlay: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="14" height="12" rx="2"/><rect x="9" y="3" width="13" height="10" rx="2" class="fill"/></svg>',
  corner: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="5" width="8" height="6" rx="1" class="fill"/></svg>',
};

// nome curto e grupo de cada botão da barra da tela, para o menu "⋯" (a dica do mouse continua com a explicação longa)
const ICON_MENU = {
  focus: ['Focar nesta tela / voltar para a grade', 'Assistir'], full: ['Tela cheia', 'Assistir'],
  playpause: ['Play/pausa no vídeo dele', 'Assistir'], pip: ['Janela flutuante (picture-in-picture)', 'Assistir'],
  overlay: ['Sobreposição por cima do jogo', 'Assistir'], screen2: ['2ª tela', 'Assistir'], corner: ['Minimizar para o canto', 'Assistir'],
  latency: ['Atraso', 'Assistir'], res: ['Resolução que você recebe', 'Assistir'],
  rec: ['Replay: guardar os últimos 30 s', 'Gravar e salvar'], clip: ['Salvar clipe (Ctrl+Shift+C)', 'Gravar e salvar'],
  record: ['Gravar esta tela', 'Gravar e salvar'], shot: ['Foto desta tela', 'Gravar e salvar'],
  pen: ['Caneta', 'Mais'], chart: ['Histórico da qualidade', 'Mais'], hide: ['Ocultar esta tela', 'Mais'],
};
function iconButton(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.dataset.icon = icon;
  b.innerHTML = ICONS[icon];
  b.onclick = (e) => { e.stopPropagation(); onClick(b); };
  return b;
}

let meTile = null;

function makeTile(id) {
  const isMe = id === 'me';
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = id;
  if (isMe) el.id = 'me-tile';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // telas sempre abrem mutadas; desmuta no botão de volume

  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  // arrastar para reorganizar só pela alça (antes a barra inteira arrastava e atrapalhava o volume)
  const grip = document.createElement('span');
  grip.className = 'tile-grip';
  grip.title = 'Arraste para reorganizar';
  grip.textContent = '⋮⋮';
  grip.draggable = true;
  const label = document.createElement('span');
  label.className = 'tile-name';
  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  // área da imagem: o vídeo e o que acompanha a imagem (bolhas, mãozinhas, desenhos, emotes). No visual
  // clássico é a tela inteira; um tema pode pôr moldura nela ou tirar o nome e os botões de cima da imagem
  const screen = document.createElement('div');
  screen.className = 'tile-screen';
  const paintSize = () => {
    if (!video.videoWidth) return;
    el.style.setProperty('--vw-t', `"${video.videoWidth}"`);
    el.style.setProperty('--vh-t', `"${video.videoHeight}"`);
    el.style.setProperty('--vs-t', `"${video.videoWidth}x${video.videoHeight}"`);
  };
  video.addEventListener('loadedmetadata', paintSize);
  video.addEventListener('resize', paintSize);
  const tile = { el, video, label, screen, stats: document.createElement('div') };
  tile.stats.className = 'tile-stats';
  // bolha da câmera (estilo streamer), aparece quando a pessoa transmite tela + câmera
  const ownerName = isMe ? state.myName : ((state.peers.get(id) || {}).name || id);
  tile.cam = makeBubble(tile, 'cam', `campos:${ownerName}`, CAM_DEFAULT, 'Arraste para mover · rodinha muda o tamanho · duplo clique volta ao canto');
  tile.camBox = tile.cam.box;
  tile.camVideo = tile.cam.video;
  // bolha da 2ª tela: ⇄ troca com a principal, ✕ esconde (para de receber)
  tile.s2 = makeBubble(tile, 's2', `s2pos:${ownerName}`, S2_DEFAULT, 'Arraste para mover · rodinha muda o tamanho · duplo clique troca com a tela principal');
  {
    const tag = document.createElement('div');
    tag.className = 'pip-tools';
    const lbl = document.createElement('span');
    tile.s2Label = lbl;
    const swap = document.createElement('button');
    swap.textContent = '⇄';
    swap.title = 'Trocar com a tela principal';
    swap.onclick = (e) => { e.stopPropagation(); swapScreens(id); };
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Esconder a 2ª tela (botão na barra mostra de novo)';
    close.onclick = (e) => { e.stopPropagation(); toggleS2Bubble(id); };
    for (const b of [swap, close]) { b.onpointerdown = (e) => e.stopPropagation(); b.ondblclick = (e) => e.stopPropagation(); }
    tag.append(lbl, swap, close);
    tile.s2.box.appendChild(tag);
    tile.s2.onDouble = () => swapScreens(id);
  }

  if (!isMe) {
    // volume lembrado pelo NOME do amigo (o id muda a cada vez que ele entra);
    // a tela sempre abre mutada, mas já no volume de antes
    const peerName = (state.peers.get(id) || {}).name || id;
    const volKey = `vol:${peerName}`;
    const volWrap = document.createElement('div');
    volWrap.className = 'vol';
    // volume de 0 a 300%: acima de 100% o som passa pelo Web Audio (TileAudio), com limitador
    const MAXV = 3;
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = MAXV; vol.step = 0.05;
    const pct = document.createElement('span');
    pct.className = 'vol-pct';
    tile.audio = new window.TileAudio();
    let volume = Math.max(0, Math.min(MAXV, Number(localStorage.getItem(volKey) ?? 1) || 0));
    let muted = true; // telas sempre abrem mutadas
    // aplica no Web Audio; se ele falhar, volta para o volume do próprio vídeo (até 100%)
    const apply = () => {
      if (tile.audio && !tile.audio.failed) {
        video.muted = true;
        tile.audio.set(volume, muted);
      } else {
        video.muted = muted;
        video.volume = Math.min(1, volume);
      }
    };
    tile.isMuted = () => muted;
    tile.setMuted = (m) => { muted = m; apply(); refresh(); };
    const muteBtn = iconButton('mute', 'Ativar/desativar som', () => tile.setMuted(!muted));
    const refresh = () => {
      muteBtn.innerHTML = muted ? ICONS.mute : ICONS.vol;
      pct.textContent = muted ? 'mudo' : `${Math.round(volume * 100)}%`;
      volWrap.classList.toggle('boost', !muted && volume > 1);
      volWrap.classList.toggle('muted', muted); // para os temas que desenham o volume de outro jeito quando está mudo
      vol.value = volume;
      vol.title = 'Volume (até 300%; acima de 100% é reforço)';
      window.Themes.paintRange(vol);
    };
    tile.getVolume = () => volume;
    tile.setVolume = (v) => {
      volume = Math.max(0, Math.min(MAXV, Math.round(v * 100) / 100));
      muted = false;
      localStorage.setItem(volKey, String(volume));
      apply();
      refresh();
    };
    vol.oninput = () => tile.setVolume(Number(vol.value));
    vol.onclick = (e) => e.stopPropagation();
    vol.ondblclick = (e) => { e.stopPropagation(); tile.setVolume(1); }; // duplo clique: volta a 100%
    volWrap.append(muteBtn, vol, pct);
    tile.vol = volWrap;
    // transmitindo sem som: em vez de o volume sumir, um aviso dizendo o porquê
    tile.noAudio = iconButton('mute', '', () => toast(tile.noAudio.title));
    tile.noAudio.classList.add('no-audio');
    tile.noAudio.style.display = 'none';
    actions.append(tile.noAudio, volWrap);
    apply();
    refresh();

    // rodinha do mouse sobre a tela: volume de 5 em 5% (até 300%)
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      tile.setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05));
      showVolumeOverlay(el, volume);
    }, { passive: false });
  }
  actions.append(
    iconButton('focus', 'Focar nesta tela / voltar para a grade', () => toggleFocus(id)),
    ...(isMe ? [] : [iconButton('playpause', 'Play/pausa no vídeo do amigo (se ele permitir)', () => requestMedia(id))]),
    iconButton('pip', 'Picture-in-picture (janela flutuante)', () => togglePip(id)),
    ...(isMe ? [] : [iconButton('overlay', 'Sobreposição: janelinha por cima do jogo', () => openOverlay(id))]),
    iconButton('rec', 'Replay: guarda os últimos 30 s desta tela para salvar um clipe', (b) => toggleReplay(id, b)),
    iconButton('clip', 'Salvar clipe dos últimos 30 s (Ctrl+Shift+C)', () => saveClip(id)),
    iconButton('record', 'Gravar esta tela (sem limite de tempo) / parar e salvar', () => toggleRecording(id)),
    ...(isMe ? [] : [(tile.latBtn = iconButton('latency', 'Atraso: Automático (clique para trocar)', () => cycleLatency(id)))]),
    ...(isMe ? [] : [(tile.resBtn = iconButton('res', 'Resolução que você recebe: Automático', (b) => openResMenu(id, b)))]),
    ...(isMe ? [] : [iconButton('chart', 'Histórico da qualidade (últimos 10 min)', () => openHistory(id))]),
    (tile.s2Btn = iconButton('screen2', 'Mostrar/esconder a 2ª tela', () => toggleS2Bubble(id))),
    iconButton('shot', 'Foto desta tela (salva em Imagens\\Tela Amigos e copia para colar)', () => takeShot(id)),
    (tile.penBtn = iconButton('pen', 'Caneta: desenhar nesta tela (os traços ficam alguns segundos para todos)', () => setPen(tile, id, !tile.pen))),
    iconButton('full', 'Tela cheia (Esc sai)', () => toggleFullscreen(el)),
  );
  if (!isMe) {
    // bolinha de qualidade (verde/amarelo/vermelho) com o motivo ao passar o mouse
    // + selo com fps/ping e, quando piora, de quem é o problema (rede, PC dele, seu PC)
    tile.qbadge = document.createElement('div');
    tile.qbadge.className = 'qbadge';
    tile.qdot = document.createElement('span');
    tile.qdot.className = 'qdot';
    tile.qtext = document.createElement('span');
    tile.qtext.className = 'qtext';
    tile.qbadge.title = 'Qualidade: medindo...';
    tile.qbadge.append(tile.qdot, tile.qtext);
    el.appendChild(tile.qbadge);
  }
  if (isMe) actions.append(iconButton('corner', 'Minimizar para o canto / colocar na grade', () => {
    state.meMini = !state.meMini;
    localStorage.setItem('meMini', state.meMini ? '1' : '0');
    render();
  }));
  // tela estreita (várias na grade): os botões menos usados vão para o "⋯"
  // muito estreita: só volume, tela cheia e o "⋯" ficam na barra (o resto também vai para o menu)
  for (const b of actions.querySelectorAll('.icon-btn')) {
    if (OPT_ICONS.has(b.dataset.icon)) b.classList.add('opt');
    else if (!['mute', 'full'].includes(b.dataset.icon)) b.classList.add('opt2');
  }
  const more = document.createElement('button');
  more.className = 'icon-btn more-btn';
  more.title = 'Mais opções';
  more.textContent = '⋯';
  more.onclick = (e) => { e.stopPropagation(); openMoreMenu(actions, more); };
  // o "fechar ao clicar fora" não pode pegar o próprio botão (senão o clique reabre o menu)
  more.onpointerdown = (e) => e.stopPropagation();
  if (tile.resBtn) tile.resBtn.onpointerdown = (e) => e.stopPropagation();
  actions.append(more);
  const hideBtn = iconButton('hide', isMe ? 'Ocultar minha prévia' : 'Ocultar esta tela (para de receber)', () => hideTile(id));
  hideBtn.classList.add('opt'); // (depois do "⋯": mora nele)
  actions.append(hideBtn);
  bar.append(grip, label, actions);
  screen.append(video, tile.s2.box, tile.camBox);
  el.append(screen, tile.stats, bar);
  // enfeite que só alguns temas mostram (ver themes/*.css)
  const liveTag = document.createElement('span');
  liveTag.className = 'tile-live theme-only';
  liveTag.textContent = 'ao vivo';
  el.appendChild(liveTag);
  attachInteractions(tile, id);
  attachZoom(tile);

  // duplo clique: em tela cheia sai dela; na tela em foco volta para a grade; senão foca
  el.ondblclick = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (el.parentNode && el.parentNode.id === 'me-mini') { state.meMini = false; localStorage.setItem('meMini', '0'); render(); return; }
    toggleFocus(id);
  };
  el.onclick = () => {
    if (state.layout === 'focus' && state.focusId !== id) setFocus(id);
  };

  // arrastar para reorganizar (pela alça)
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tile', id);
    el.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop');
    const from = e.dataTransfer.getData('text/tile');
    if (!from || from === id) return;
    const o = state.order;
    const a = o.indexOf(from), b = o.indexOf(id);
    if (a < 0 || b < 0) return;
    [o[a], o[b]] = [o[b], o[a]];
    render();
  });

  video.addEventListener('enterpictureinpicture', () => { state.pipId = id; render(); });
  video.addEventListener('leavepictureinpicture', () => { if (state.pipId === id) state.pipId = null; render(); });
  window.Themes.tileSetup(tile); // o tema escolhido pode querer o selo de qualidade ao lado do nome
  return tile;
}

// ------------------------------------------------------------------ zoom na tela
// Ctrl + rodinha aproxima no ponto do mouse (até 6x); arrastar com o botão esquerdo move.
// O selo "🔍 300% ✕" mostra o zoom; ✕ (ou Ctrl+0) volta ao normal. Mãozinhas e desenhos seguem
// o zoom (as posições são calculadas pela área do vídeo na tela).
function attachZoom(tile) {
  const el = tile.el, v = tile.video;
  tile.zoom = { s: 1, x: 0, y: 0 };
  const badge = document.createElement('div');
  badge.className = 'zoom-badge hidden';
  const label = document.createElement('span');
  const reset = document.createElement('button');
  reset.textContent = '✕';
  reset.title = 'Voltar ao normal (Ctrl+0)';
  badge.append(label, reset);
  el.appendChild(badge);
  const apply = () => {
    const z = tile.zoom, W = el.clientWidth, H = el.clientHeight;
    // limita pela IMAGEM (sem as faixas pretas): ela cobre a tela quando dá; senão fica centralizada
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const k = Math.min(W / vw, H / vh), cw = vw * k, ch = vh * k, cl = (W - cw) / 2, ct = (H - ch) / 2;
    const clampAxis = (t, size, start, len) => (z.s * len <= size
      ? (size - z.s * len) / 2 - z.s * start
      : Math.min(-z.s * start, Math.max(size - z.s * (start + len), t)));
    z.x = z.s > 1 ? clampAxis(z.x, W, cl, cw) : 0;
    z.y = z.s > 1 ? clampAxis(z.y, H, ct, ch) : 0;
    v.style.transformOrigin = '0 0';
    v.style.transform = z.s > 1 ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : '';
    el.classList.toggle('zoomed', z.s > 1);
    badge.classList.toggle('hidden', z.s <= 1);
    label.textContent = `🔍 ${Math.round(z.s * 100)}%`;
    if (tile.camBox) placeCamBubble(tile);
  };
  tile.resetZoom = () => { tile.zoom = { s: 1, x: 0, y: 0 }; apply(); };
  reset.onclick = (e) => { e.stopPropagation(); tile.resetZoom(); };
  reset.ondblclick = (e) => e.stopPropagation();
  // Ctrl + rodinha: zoom no ponto do mouse (antes do volume, que usa a rodinha sem Ctrl)
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = tile.screen.getBoundingClientRect(), z = tile.zoom;
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const s2 = Math.max(1, Math.min(6, z.s * (e.deltaY < 0 ? 1.25 : 0.8)));
    z.x = px - ((px - z.x) * s2) / z.s;
    z.y = py - ((py - z.y) * s2) / z.s;
    z.s = s2;
    if (s2 === 1) { z.x = 0; z.y = 0; }
    apply();
  }, { passive: false, capture: true });
  // arrastar para mover (com zoom, sem caneta, botão esquerdo)
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (tile.zoom.s <= 1 || tile.pen || e.button !== 0 || e.target.closest('.tile-bar, .react-bar, .pen-tools, .cam-pip, .zoom-badge')) return;
    drag = { x: e.clientX, y: e.clientY, zx: tile.zoom.x, zy: tile.zoom.y, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    tile.zoom.x = drag.zx + (e.clientX - drag.x);
    tile.zoom.y = drag.zy + (e.clientY - drag.y);
    apply();
  });
  const end = () => { if (drag && drag.moved) tile.suppressClick = true; drag = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // arrastar não pode virar "clique" (trocaria o foco da tela)
  el.addEventListener('click', (e) => { if (tile.suppressClick) { tile.suppressClick = false; e.stopPropagation(); } }, true);
  new ResizeObserver(() => { if (tile.zoom.s > 1) apply(); }).observe(el);
}

// nome da tela com avatar e bolinha "ao vivo" (só refaz se mudou)
function setTileLabel(tile, name, text) {
  const key = `${name}|${text}`;
  if (tile.labelKey === key) return;
  tile.labelKey = key;
  tile.el.style.setProperty('--h', nameHue(name)); // matiz de quem transmite, para os temas que pintam a tela na cor da pessoa
  tile.el.dataset.k = nameHue(name) % 4;        // e um número de 0 a 3 por pessoa, para os temas variarem um desenho
  tile.el.dataset.f = Math.floor(nameHue(name) / 45); // e um de 0 a 7
  tile.label.innerHTML = '';
  const t = document.createElement('span');
  const cut = text.indexOf(' — ');
  if (cut > 0) {
    const who = document.createElement('span');
    who.className = 'tn-who';
    who.textContent = text.slice(0, cut);
    const what = document.createElement('span');
    what.className = 'tn-what';
    what.textContent = text.slice(cut);
    what.dataset.what = text.slice(cut + 3); // sem o travessão, para os temas que escrevem de outro jeito
    t.append(who, what);
  } else t.textContent = text;
  const live = document.createElement('span');
  live.className = 'live-dot';
  live.title = 'ao vivo';
  tile.label.append(avatar(name), t, live);
}

function showVolumeOverlay(el, v) {
  let o = el.querySelector('.vol-overlay');
  if (!o) {
    o = document.createElement('div');
    o.className = 'vol-overlay';
    el.appendChild(o);
  }
  o.textContent = `Volume ${Math.round(v * 100)}%${v > 1 ? ' (reforço)' : ''}`;
  o.classList.add('show');
  clearTimeout(o.timer);
  o.timer = setTimeout(() => o.classList.remove('show'), 900);
}

function getTile(id) {
  if (id === 'me') {
    if (!meTile) meTile = makeTile('me');
    updateTileMedia('me');
    const what = state.share ? (meTile.swapped && state.share2 ? `2ª tela: ${state.share2.sourceName}` : state.share.sourceName) : 'Câmera';
    setTileLabel(meTile, state.myName, `Você — ${what}`);
    return meTile;
  }
  const peer = state.peers.get(id);
  if (!peer.tile) { peer.tile = makeTile(id); applyPlayoutBuffer(); } // (o botão de atraso nasce no modo guardado)
  updateTileMedia(id);
  const what = peer.sharing ? (peer.tile.swapped ? `2ª tela: ${peer.share2Name}` : peer.sourceName) : 'Câmera';
  setTileLabel(peer.tile, peer.name, peer.name + (what ? ` — ${what}` : ''));
  updateResButton(peer);
  peer.tile.vol.style.display = peer.hasAudio ? '' : 'none';
  const noAudio = peer.sharing && !peer.hasAudio;
  peer.tile.noAudio.style.display = noAudio ? '' : 'none';
  if (noAudio) {
    peer.tile.noAudio.title = peer.audioWhy === 'none'
      ? `${peer.name} está transmitindo sem som (escolheu "Sem áudio").`
      : peer.audioWhy
        ? `O som de ${peer.name} não ligou (${peer.audioWhy}). Peça para ele parar e transmitir de novo; se continuar, reiniciar o app.`
        : `${peer.name} não está mandando som.`;
  }
  return peer.tile;
}

// Tela + câmera: a tela ocupa tudo e a câmera fica numa bolha no canto (estilo streamer).
// Só câmera: a câmera ocupa a tela toda.
function updateTileMedia(id) {
  let tile, screen, cam, sharing, hasCam, screen2 = null, name2 = '';
  if (id === 'me') {
    tile = meTile;
    sharing = !!state.share; hasCam = !!state.camera;
    screen = sharing ? state.share.preview : null;
    cam = hasCam ? state.camera.stream : null;
    if (sharing && state.share2) { screen2 = state.share2.stream; name2 = state.share2.sourceName; }
  } else {
    const p = state.peers.get(id);
    if (!p) return;
    tile = p.tile;
    sharing = !!p.sharing; hasCam = !!p.hasCam;
    screen = p.remoteStream;
    cam = p.camStream;
    if (sharing && p.share2) { screen2 = p.screen2Stream; name2 = p.share2Name; }
  }
  if (!tile) return;
  if (!screen2) tile.swapped = false;
  const swapped = !!tile.swapped;
  const main = sharing ? (swapped ? screen2 : screen) : cam;
  if (main && tile.video.srcObject !== main) tile.video.srcObject = main;
  if (tile.audio) tile.audio.setStream(sharing ? screen : null); // som da tela (com reforço/nivelador)
  const showBubble = sharing && hasCam;
  tile.camBox.classList.toggle('hidden', !showBubble);
  if (showBubble && tile.camVideo.srcObject !== cam) tile.camVideo.srcObject = cam;
  if (showBubble && tile.camVideo.paused) tile.camVideo.play().catch(() => {});
  // 2ª tela no canto (ou a 1ª, se trocou)
  const show2 = !!screen2 && !tile.s2Hidden;
  const other = swapped ? screen : screen2;
  tile.s2.box.classList.toggle('hidden', !show2);
  tile.s2Btn.classList.toggle('hidden', !screen2);
  tile.s2Btn.classList.toggle('active', show2);
  tile.el.classList.toggle('swapped', swapped);
  if (show2 && tile.s2.video.srcObject !== other) tile.s2.video.srcObject = other;
  if (show2 && tile.s2.video.paused) tile.s2.video.play().catch(() => {});
  if (tile.s2Label) tile.s2Label.textContent = swapped ? '1ª tela' : `2ª tela${name2 ? ` · ${name2}` : ''}`;
  placeCamBubble(tile);
}

// Bolhas no canto da tela (câmera e 2ª tela). Posição dentro da IMAGEM (não do quadro, que tem
// faixas pretas), em frações: x/y = canto superior esquerdo, w = largura. Cada um arruma do seu
// jeito; fica salvo por amigo.
const CAM_DEFAULT = { x: 0.74, y: 0.70, w: 0.24 };
const S2_DEFAULT = { x: 0.02, y: 0.05, w: 0.26 };
function makeBubble(tile, kind, key, def, title) {
  const box = document.createElement('div');
  box.className = `cam-pip ${kind}-pip hidden`;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  box.appendChild(video);
  box.title = title;
  const bub = { box, video, key, def, pos: null, onDouble: null };
  attachBubbleDrag(tile, bub);
  return bub;
}
function camPos(tile) { return bubblePos(tile.cam); } // clipes/gravação desenham a câmera junto
function bubblePos(bub) {
  if (!bub.pos) {
    try { bub.pos = JSON.parse(localStorage.getItem(bub.key)) || { ...bub.def }; } catch { bub.pos = { ...bub.def }; }
  }
  return bub.pos;
}
// mantém a bolha inteira dentro da imagem
function clampCam(tile, p, b) {
  const hFrac = (p.w * b.width * 9 / 16) / b.height;
  p.w = Math.max(0.1, Math.min(0.5, p.w));
  p.x = Math.max(0, Math.min(1 - p.w, p.x));
  p.y = Math.max(0, Math.min(1 - hFrac, p.y));
  return p;
}
function placeBubble(tile, bub) {
  if (!tile || !bub || bub.box.classList.contains('hidden') || !tile.el.isConnected) return;
  const b = videoBox(tile), er = tile.screen.getBoundingClientRect();
  if (!b.width) return;
  const p = clampCam(tile, bubblePos(bub), b);
  const w = b.width * p.w;
  bub.box.style.width = `${w}px`;
  bub.box.style.left = `${b.left - er.left + p.x * b.width}px`;
  bub.box.style.top = `${b.top - er.top + p.y * b.height}px`;
  bub.box.style.right = 'auto';
  bub.box.style.bottom = 'auto';
}
function placeCamBubble(tile) {
  if (!tile) return;
  placeBubble(tile, tile.cam);
  placeBubble(tile, tile.s2);
}

// arrastar (botão esquerdo), redimensionar (rodinha), duplo clique (volta ao padrão ou ação da bolha)
function attachBubbleDrag(tile, bub) {
  const box = bub.box;
  let drag = null;
  const save = () => localStorage.setItem(bub.key, JSON.stringify(bub.pos));
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const r = box.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const b = videoBox(tile);
    const p = bubblePos(bub);
    p.x = (e.clientX - drag.dx - b.left) / b.width;
    p.y = (e.clientY - drag.dy - b.top) / b.height;
    clampCam(tile, p, b);
    placeBubble(tile, bub);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    box.classList.remove('dragging');
    // encaixa no canto se soltar perto da borda
    const b = videoBox(tile);
    const p = bubblePos(bub);
    const hFrac = (p.w * b.width * 9 / 16) / b.height;
    const m = 0.02, snap = 0.06;
    if (p.x < snap) p.x = m;
    if (1 - p.w - p.x < snap) p.x = 1 - p.w - m;
    if (p.y < snap) p.y = m * 2;
    if (1 - hFrac - p.y < snap) p.y = 1 - hFrac - m * 2;
    clampCam(tile, p, b);
    placeBubble(tile, bub);
    save();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation(); // não mexe no volume da tela
    const b = videoBox(tile);
    const p = bubblePos(bub);
    const oldW = p.w;
    p.w = Math.max(0.1, Math.min(0.5, p.w + (e.deltaY < 0 ? 0.02 : -0.02)));
    p.x -= (p.w - oldW) / 2; // cresce a partir do centro
    clampCam(tile, p, b);
    placeBubble(tile, bub);
    save();
  }, { passive: false });
  box.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (bub.onDouble) { bub.onDouble(); return; }
    bub.pos = { ...bub.def };
    placeBubble(tile, bub);
    save();
  });
}
function placeAllCamBubbles() {
  if (meTile) placeCamBubble(meTile);
  for (const p of state.peers.values()) placeCamBubble(p.tile);
}
window.addEventListener('resize', () => requestAnimationFrame(placeAllCamBubbles));
setInterval(placeAllCamBubbles, 1000); // a imagem pode mudar de tamanho (troca de resolução)

function isSharing(id) {
  if (id === 'me') return !!state.share || !!state.camera;
  const p = state.peers.get(id);
  return !!(p && (p.sharing || p.hasCam));
}

// ------------------------------------------------------------------ câmera
let cameraBusy = false;
async function toggleCamera() {
  // um 2º clique enquanto a câmera ainda abria pedia outra: a primeira ficava ligada (luz acesa)
  // sem ninguém para desligar
  if (cameraBusy) return;
  if (state.camera) {
    state.camera.track.stop();
    state.camera = null;
  } else {
    cameraBusy = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      // saiu da sala enquanto a câmera abria: não deixa ligada no lobby
      if ($('#room').classList.contains('hidden')) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.camera = { stream, track: stream.getVideoTracks()[0] };
      state.camera.track.contentHint = 'motion';
    } catch (e) {
      toast(`Não consegui abrir a câmera: ${e.message}`, 'error');
      return;
    } finally { cameraBusy = false; }
  }
  if (state.camera && !state.order.includes('me')) state.order.unshift('me');
  $('#btn-camera').classList.toggle('active', !!state.camera);
  $('#btn-camera').textContent = state.camera ? 'Desligar câmera' : 'Câmera';
  for (const peer of state.peers.values()) { applySendParams(peer); sendState(peer.id); }
  render();
}

function setFocus(id) {
  state.layout = 'focus';
  state.focusId = id;
  render();
}

// foca a tela; se ela já está em foco, volta para a grade
function toggleFocus(id) {
  if (state.layout === 'focus' && state.focusId === id) { state.layout = 'grid'; render(); }
  else setFocus(id);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
}

function hideTile(id) {
  state.hidden.add(id);
  if (id === 'me') window.NativeVideo.setPreview(false); // não gasta decodificando a prévia
  if (state.focusId === id) state.focusId = null;
  if (state.pipId === id && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  render();
}

function showTile(id) {
  state.hidden.delete(id);
  if (id === 'me') window.NativeVideo.setPreview(true);
  render();
}

async function togglePip(id) {
  const tile = id === 'me' ? meTile : state.peers.get(id)?.tile;
  if (!tile) return;
  try {
    if (document.pictureInPictureElement === tile.video) await document.exitPictureInPicture();
    else await tile.video.requestPictureInPicture();
  } catch (e) {
    toast(`Picture-in-picture indisponível: ${e.message}`, 'error');
  }
}

// Calcula quantas colunas deixam as telas (16:9) maiores possíveis
function bestColumns(n, W, H) {
  let best = 1, bestArea = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min(W / cols, ((H / rows) * 16) / 9);
    if (w * w > bestArea) { bestArea = w * w; best = cols; }
  }
  return best;
}

// Grade: cada tela no formato 16:9 (sem faixas pretas enormes dos lados), do maior tamanho que
// cabe, centralizadas. Refeita quando o palco muda de tamanho.
let gridN = 0;
function fitGrid(n) {
  gridN = n;
  const main = $('#stage-main');
  if (!main || !$('#stage').classList.contains('grid')) return;
  const r = main.getBoundingClientRect();
  const W = r.width || 1, H = r.height || 1;
  const cnt = Math.max(1, n);
  const cols = bestColumns(cnt, W, H), rows = Math.ceil(cnt / cols);
  const cs = getComputedStyle(main);
  const gap = parseFloat(cs.columnGap) || 0;
  const gapY = parseFloat(cs.rowGap) || gap; // alguns temas separam mais as linhas do que as colunas
  const [fx, fy] = window.Themes.tileFrame(); // quanto o tema soma à largura e à altura da imagem
  const w = Math.floor(Math.max(120, Math.min((W - gap * (cols - 1)) / cols, ((H - gapY * (rows - 1)) / rows - fy) * 16 / 9 + fx)));
  main.style.gridTemplateColumns = `repeat(${cols}, ${w}px)`;
  main.style.gridAutoRows = `${Math.floor((w - fx) * 9 / 16 + fy)}px`;
  main.style.justifyContent = 'center';
}
let gridRO = null;
function watchGridSize() {
  if (gridRO || !window.ResizeObserver) return;
  gridRO = new ResizeObserver(() => { if (gridN) fitGrid(gridN); });
  gridRO.observe($('#stage-main'));
}

function render() {
  watchGridSize();
  for (const id of state.peers.keys()) {
    if (!state.order.includes(id) && isSharing(id)) state.order.push(id);
  }
  if (state.share && !state.order.includes('me')) state.order.unshift('me');

  // jogando em tela cheia: a sua prévia some (economiza decodificação/desenho na placa)
  const hideMeForGame = !!(state.gaming && state.share && localStorage.getItem('gamehide') !== '0');
  if (state.share && state.share.native) window.NativeVideo.setPreview(!hideMeForGame && !state.hidden.has('me'));
  const allVisible = state.order.filter((id) => isSharing(id) && !state.hidden.has(id) && !(id === 'me' && hideMeForGame));
  // sua prévia vira uma janelinha no canto quando há telas de amigos para ver
  const meMini = state.meMini && allVisible.includes('me') && allVisible.some((id) => id !== 'me');
  const visible = meMini ? allVisible.filter((id) => id !== 'me') : allVisible;
  const stage = $('#stage');
  const main = $('#stage-main');
  const strip = $('#stage-strip');

  // tiles que não devem aparecer saem do DOM (exceto se estiverem em PiP)
  const all = [meTile, ...[...state.peers.values()].map((p) => p.tile)].filter(Boolean);
  for (const t of all) {
    const id = t.el.dataset.id;
    if (!allVisible.includes(id) && state.pipId !== id) t.el.remove();
  }
  const mini = $('#me-mini');
  mini.classList.toggle('hidden', !meMini);
  if (meMini) {
    const t = getTile('me');
    t.el.classList.remove('thumb', 'focused');
    if (t.el.parentNode !== mini) mini.appendChild(t.el);
    if (t.video.paused) t.video.play().catch(() => {});
  }

  $('#empty').style.display = allVisible.length ? 'none' : '';
  let focus = state.focusId;
  if (state.layout === 'focus' && (!focus || !visible.includes(focus))) {
    focus = visible.find((id) => id !== 'me') || visible[0] || null;
    state.focusId = focus;
  }
  const focusMode = state.layout === 'focus' && visible.length > 1;
  stage.classList.toggle('grid', !focusMode);
  stage.classList.toggle('focus', focusMode);
  stage.classList.toggle('stats-on', state.showStats);

  if (focusMode) {
    const t = getTile(focus);
    if (t.el.parentNode !== main) main.appendChild(t.el);
    t.el.classList.remove('thumb');
    let i = 0;
    for (const id of visible) {
      if (id === focus) continue;
      const tt = getTile(id);
      tt.el.classList.add('thumb');
      if (strip.children[i] !== tt.el) strip.insertBefore(tt.el, strip.children[i] || null);
      i++;
    }
    main.style.gridTemplateColumns = '';
    main.style.gridAutoRows = '';
    main.style.justifyContent = '';
  } else {
    visible.forEach((id, i) => {
      const t = getTile(id);
      t.el.classList.remove('thumb');
      if (main.children[i] !== t.el) main.insertBefore(t.el, main.children[i] || null);
    });
    fitGrid(visible.length);
  }
  for (const id of visible) {
    const t = getTile(id);
    t.el.classList.toggle('focused', focusMode && id === focus);
    t.el.classList.toggle('in-pip', state.pipId === id);
    if (t.video.paused) t.video.play().catch(() => {});
    window.Vida.paint(t.el, id, true); // tela que acabou de entrar no ar: o tema anima a chegada
  }

  document.querySelectorAll('.layout-switch .seg').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  $('#btn-stats').classList.toggle('active', state.showStats);

  // diz a cada amigo em que qualidade quero receber a tela dele (e a 2ª tela, se houver)
  for (const peer of state.peers.values()) {
    let level = 'full';
    // só câmera também precisa ser recebida (antes cortava a câmera de quem não compartilhava a tela)
    if ((!peer.sharing && !peer.hasCam) || state.hidden.has(peer.id)) level = 'off';
    else if (focusMode && peer.id !== focus && state.pipId !== peer.id) level = 'thumb';
    const t = peer.tile;
    let level2 = 'off';
    if (peer.share2 && level !== 'off' && t && !t.s2Hidden) {
      if (t.swapped) { level2 = level; level = 'thumb'; } // a 2ª tela está grande; a 1ª vai para o canto
      else level2 = 'thumb';
    }
    const maxH = wantedMaxH(peer);
    if (peer.iWant !== level || peer.iWantH !== maxH) {
      peer.iWant = level;
      peer.iWantH = maxH;
      sendRelay(peer.id, { kind: 'want', level, maxH });
      if (peer.sfuPub || peer.sfuIn) sfuPullSync(peer);
    }
    if (peer.iWant2 !== level2) {
      peer.iWant2 = level2;
      sendRelay(peer.id, { kind: 'want2', level: level2 });
    }
  }
  renderPeople();
  paintStatsPane();
  const liveN = [...state.peers.values()].filter((p) => p.sharing).length + (state.share ? 1 : 0);
  $('#live-count').textContent = liveN ? `${liveN} ${liveN === 1 ? 'tela' : 'telas'} ao vivo` : '';

  // status no ícone da bandeja (só manda quando muda)
  const tray = { room: state.hostIp || '', people: [...state.peers.values()].map((p) => ({ name: p.name, live: !!p.sharing })), sharing: !!state.share };
  const key = safeJson(tray);
  if (key !== lastTrayKey) { lastTrayKey = key; window.native.trayStatus(tray); }
}
let lastTrayKey = '';

// avatar com a inicial e uma cor fixa calculada a partir do nome
function avatar(name) {
  const s = String(name || '?').trim();
  let h = 0;
  for (const ch of s.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = `hsl(${h % 360}, 55%, 46%)`;
  el.textContent = (s[0] || '?').toUpperCase();
  return el;
}

// selo de qualidade: os números vão em <span class="n"> para os temas poderem destacá-los
// res: altura da imagem que está chegando (ex.: 1080), mbps e codec: só alguns temas mostram
function setQText(el, fps, ms, short, res, mbps, codec) {
  const part = (cls, ...kids) => { const sp = document.createElement('span'); sp.className = cls; sp.append(...kids); return sp; };
  el.textContent = '';
  el.append(part('q-fps', part('n', String(fps)), ' fps'), part('q-sep', ' · '), part('q-ms', part('n', ms != null ? String(ms) : '?'), ' ms'));
  if (res) el.append(part('q-res', part('q-sep', ' · '), `${res}p`));
  if (mbps > 0) el.append(part('q-mbps', part('q-sep', ' · '), `${mbps.toFixed(1).replace('.', ',')} Mb/s`));
  if (codec) el.append(part('q-codec', part('q-sep', ' · '), codec));
  if (short) el.append(part('q-why', ` · ${short}`));
  el.dataset.why = short || ''; // a causa sozinha, para os temas que a mostram como etiqueta
}
const codecLabel = (c) => ({ H265: 'H.265', H264: 'H.264' }[String(c || '').toUpperCase()] || String(c || ''));
// "20 Mbps" com o número marcado (alguns temas mostram o número grande)
function setMbps(el, v) {
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = v;
  el.textContent = '';
  el.append(n, ' Mbps');
}
// fps e ping de quem transmite, na lista de pessoas (só alguns temas mostram)
function paintPersonQuality(peer) {
  const li = peer.personEl;
  if (!li || !li.isConnected) return;
  const q = peer.sharing ? peer.q : null;
  li.dataset.q = q ? q.level : '';
  li.querySelector('.p-fps').textContent = q ? q.fps : '--';
  li.querySelector('.p-ms').textContent = q && q.ms != null ? q.ms : '--';
}

function renderPeople() {
  const ul = $('#people');
  ul.innerHTML = '';
  const row = (name, status, extra, avatarName, peer) => {
    const li = document.createElement('li');
    const av = avatar(avatarName || name);
    li.style.setProperty('--c', av.style.background); // a cor da pessoa, para os temas
    li.style.setProperty('--h', nameHue(avatarName || name));
    li.dataset.k = nameHue(avatarName || name) % 4;
    li.dataset.f = Math.floor(nameHue(avatarName || name) / 45); // e um de 0 a 7
    li.dataset.n = ul.children.length + 1;
    li.style.setProperty('--n-t', `"${li.dataset.n}"`);
    const st = document.createElement('span');
    st.className = `status ${status}`;
    av.appendChild(st);
    const n = document.createElement('span');
    n.className = 'person-name';
    n.textContent = name;
    if (!peer) { // "(você)" separado do nome: alguns temas mostram como etiqueta
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = ' (você)';
      n.appendChild(you);
      li.dataset.me = '1';
    }
    const q = document.createElement('span');
    q.className = 'p-q theme-only';
    const f = document.createElement('span');
    f.className = 'p-fps';
    f.textContent = '--';
    const m = document.createElement('span');
    m.className = 'p-ms';
    m.textContent = '--';
    q.append(f, m);
    li.append(av, n, q);
    if (extra) li.appendChild(extra);
    ul.appendChild(li);
    if (peer) { peer.personEl = li; paintPersonQuality(peer); }
    window.Vida.paint(li, peer ? peer.id : 'me'); // acabou de entrar / de entrar no ar: o tema anima
    return li;
  };
  const tag = (text, cls = '') => {
    const s = document.createElement('span');
    s.className = `tag ${cls}`;
    s.textContent = text;
    return s;
  };
  const meExtra = document.createElement('span');
  if (state.share) meExtra.appendChild(tag('ao vivo', 'live'));
  if (state.share && state.hidden.has('me')) {
    const b = document.createElement('button');
    b.className = 'tag-btn'; b.textContent = 'mostrar prévia';
    b.onclick = () => showTile('me');
    meExtra.appendChild(b);
  }
  const meLi = row(state.myName, 'connected', meExtra, state.myName, null);
  if (state.share) meLi.dataset.live = '1';
  // de quem é a tela em destaque no modo Foco (alguns temas escrevem isso na lista)
  const mainId = state.layout === 'focus' && $('#stage').classList.contains('focus') ? state.focusId : null;
  if (mainId === 'me') meLi.dataset.main = '1';

  for (const p of state.peers.values()) {
    const extra = document.createElement('span');
    if (p.sharing) extra.appendChild(tag('ao vivo', 'live'));
    if (p.sharing && state.hidden.has(p.id)) {
      const b = document.createElement('button');
      b.className = 'tag-btn'; b.textContent = 'mostrar';
      b.onclick = () => showTile(p.id);
      extra.appendChild(b);
    }
    const status = p.conn === 'connected' ? 'connected' : p.conn === 'failed' ? 'failed' : 'connecting';
    // "conectando" já aparece na bolinha do avatar (amarela); só a falha merece etiqueta
    if (status === 'failed') extra.appendChild(tag('falhou'));
    const db = document.createElement('button');
    db.className = 'tag-btn person-diag';
    db.textContent = '🩺';
    db.title = `Pedir o diagnóstico de ${p.name} (chega na sua Área de Trabalho)`;
    db.onclick = () => requestDiag(p);
    extra.appendChild(db);
    const li = row(p.name, status, extra, undefined, p);
    if (p.sharing) li.dataset.live = '1';
    if (mainId === p.id) li.dataset.main = '1';
  }
  const numberTile = (t, n) => { if (t) { t.el.dataset.n = n; t.el.style.setProperty('--n-t', `"${n}"`); } };
  numberTile(meTile, '1');
  for (const p of state.peers.values()) if (p.personEl) numberTile(p.tile, p.personEl.dataset.n);
  const count = $('#people-count');
  count.textContent = '';
  const cn = document.createElement('span');
  cn.className = 'n';
  cn.textContent = ul.children.length;
  const ct = document.createElement('span');
  ct.className = 't';
  ct.textContent = ' na sala';
  count.append(cn, ct);
  window.Vida.paint(count, 'conta');
}

// ------------------------------------------------------------------ quadro de estatísticas (só alguns temas mostram)
// Uma linha por tela ao vivo (resolução, fps, Mb/s e ping), o fps dos últimos 10 min de uma delas em barrinhas e,
// embaixo, os outros números dela (os mesmos do texto de estatísticas de cada tela). A tela mostrada é a que está
// em foco; clicar numa linha escolhe outra (clicar de novo volta a seguir o foco).
function paintStatsPane() {
  const box = $('#stats-pane');
  if (!box || !state.showStats || !box.offsetParent) return; // o tema em uso não mostra o quadro
  const rows = [];
  if (state.share) {
    const n = state.share.direct ? state.nativeStats : null;
    const o = state.myOut || {};
    rows.push({ id: 'me', name: 'você', level: '', res: n ? n.height : o.h, fps: n ? n.fps : Math.round(o.fps || 0), mbps: n ? n.kbps / 1000 : (o.bytes || 0) / 1e6, ms: null, tile: meTile });
  }
  for (const p of state.peers.values()) {
    if (!p.sharing || state.hidden.has(p.id)) continue;
    const q = p.q || {};
    rows.push({ id: p.id, name: p.name, level: q.level || '', res: q.res, fps: q.fps, mbps: q.mbps, ms: q.ms, tile: p.tile, hist: state.hist.get(p.name) });
  }
  const sel = rows.find((r) => r.id === state.statsSel) || rows.find((r) => state.layout === 'focus' && r.id === state.focusId)
    || rows.find((r) => r.id !== 'me') || rows[0] || null;
  const cell = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '--' : String(v));
  const table = $('#sp-table');
  table.textContent = '';
  const head = document.createElement('div');
  head.className = 'sp-row sp-headrow';
  head.append(cell('tela'), cell('res'), cell('fps'), cell('Mb/s'), cell('ping'));
  table.appendChild(head);
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = `sp-row${r === sel ? ' sel' : ''}`;
    d.dataset.q = r.level;
    d.title = 'Clique para ver o histórico e os outros números desta tela';
    d.append(cell(r.name, 'sp-name'), cell(r.res ? `${r.res}p` : '--'), cell(num(r.fps)), cell(r.mbps > 0 ? r.mbps.toFixed(1).replace('.', ',') : '--'), cell(num(r.ms)));
    d.onclick = () => { state.statsSel = state.statsSel === r.id ? null : r.id; paintStatsPane(); };
    table.appendChild(d);
  }
  if (!rows.length) table.appendChild(cell('ninguém transmitindo', 'sp-none'));
  // fps dos últimos 10 min em 36 barrinhas: o menor fps de cada pedaço, na cor do pior momento dele
  const spark = $('#sp-spark');
  spark.textContent = '';
  const h = (sel && sel.hist) || [];
  $('#sp-label').textContent = !sel ? '' : sel.id === 'me' ? 'você · o histórico é só das telas dos amigos' : `${sel.name} · fps · 10 min`;
  if (h.length) {
    const N = 36, end = h[h.length - 1].t, t0 = end - 600000, top = Math.max(30, ...h.map((p) => p.fps));
    const rank = { good: 0, warn: 1, bad: 2 };
    const parts = Array.from({ length: N }, () => null);
    for (const p of h) {
      if (p.t <= t0) continue;
      const i = Math.min(N - 1, Math.floor(((p.t - t0) / 600000) * N));
      const b = parts[i] || (parts[i] = { fps: p.fps, level: p.level });
      b.fps = Math.min(b.fps, p.fps);
      if ((rank[p.level] || 0) > (rank[b.level] || 0)) b.level = p.level;
    }
    for (const b of parts) {
      const bar = document.createElement('i');
      if (b) { bar.style.height = `${Math.max(2, Math.round((b.fps / top) * 100))}%`; bar.className = b.level || 'good'; }
      spark.appendChild(bar);
    }
  }
  // os outros números da tela escolhida (os que a tabela já mostra ficam de fora)
  const txt = sel && sel.tile ? sel.tile.stats.textContent : '';
  const cut = sel && sel.id !== 'me' ? txt.indexOf('buffer ') : -1;
  $('#sp-detail').textContent = cut > 0 ? txt.slice(cut) : txt;
}

// ------------------------------------------------------------------ resumo "vai ao ar" (só alguns temas mostram)
// O que os amigos vão receber com a fonte e as opções escolhidas na janela de compartilhar.
function paintShareSum() {
  const box = $('#share-sum');
  if (!box || !box.offsetParent) return; // o tema em uso não mostra o resumo
  const src = selectedSource;
  const optText = (id) => { const o = $(id).selectedOptions[0]; return o ? (o.dataset.short || o.textContent) : ''; };
  // tamanho que sai: a fonte (ou a área escolhida dela) cabendo na resolução pedida, sem aumentar
  const lim = RES[$('#opt-res').value];
  let size;
  if (src && src.size && src.size.width) {
    const w = src.size.width * (src.crop ? src.crop.w : 1), h = src.size.height * (src.crop ? src.crop.h : 1);
    const k = lim ? Math.min(1, lim[0] / w, lim[1] / h) : 1;
    size = `${Math.round((w * k) / 2) * 2}x${Math.round((h * k) / 2) * 2}`;
  } else size = lim ? `até ${lim[0]}x${lim[1]}` : 'tamanho da janela';
  // codec: o que o "Automático" deve escolher com quem está na sala agora
  const peers = [...state.peers.values()].filter((p) => p.h265 !== undefined);
  const direct = $('#opt-engine').value === 'native-direct';
  let codec = optText('#opt-codec'), codecNote = '';
  if (direct || $('#opt-codec').value === 'auto') {
    const mine = window.Sdp.hasH265() && !window.Sdp.sendBad('H265');
    const without = peers.filter((p) => !p.h265).map((p) => p.name);
    if (!mine) { codec = 'H.264'; codecNote = 'este PC não envia H.265'; }
    else if (!without.length) { codec = 'H.265'; codecNote = peers.length ? 'todos têm' : ''; }
    else if (direct) { codec = 'H.264'; codecNote = `${without.join(', ')} sem H.265`; }
    else { codec = 'H.265'; codecNote = `H.264 para ${without.join(', ')}`; }
    if (direct && mine && !without.length && !state.noAv1Encoder && localStorage.getItem('av1') !== '0' && !window.Sdp.sendBad('AV1') && window.Sdp.hasAV1Hw() && peers.length && peers.every((p) => p.av1)) {
      codec = 'AV1'; codecNote = 'todos têm';
    }
  }
  const row = (k, v, note) => {
    const p = document.createElement('p');
    const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
    const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
    if (note) { const em = document.createElement('em'); em.textContent = ` (${note})`; b.appendChild(em); }
    p.append(a, b);
    return p;
  };
  const head = document.createElement('b');
  head.className = 'ss-head';
  head.textContent = 'Vai ao ar';
  box.textContent = '';
  box.append(
    head,
    row('fonte', src ? src.name : 'escolha ao lado'),
    row('sai em', `${size} · ${$('#opt-fps').value} fps`),
    row('codec', codec, codecNote),
    row('som', $('#opt-audio').value === 'all-except' ? 'PC inteiro, sem Discord' : optText('#opt-audio') || 'sem áudio'),
    row('área', !src ? '--' : src.type !== 'screen' ? 'só a janela' : src.crop ? `${Math.round(src.crop.w * 100)}% × ${Math.round(src.crop.h * 100)}% da tela` : 'tela inteira'),
  );
}

// ------------------------------------------------------------------ 2ª tela
// Quem transmite pode mandar mais uma tela/janela (captura do Chromium, até 1080p30). Ela aparece
// no canto da tela principal; cada um que assiste pode trocar (⇄) ou esconder (só recebe se mostrar).
async function startSecond(src) {
  state.pickSecond = false;
  $('#share-modal').classList.remove('second');
  if (!state.share) { toast('Comece a transmitir a tela principal antes da 2ª.', 'error'); return; }
  if (state.share.source && state.share.source.id === src.id && !state.share.source.crop) {
    toast('Essa já é a sua tela principal: escolha outra tela ou janela.', 'error');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
    });
  } catch (e) {
    toast(`Não foi possível capturar a 2ª tela: ${e.message}`, 'error');
    return;
  }
  if (!state.share) { stream.getTracks().forEach((t) => t.stop()); return; } // parou enquanto abria
  stopSecond(true);
  const video = stream.getVideoTracks()[0];
  video.contentHint = 'detail';
  state.share2 = { stream, video, sourceName: src.name, source: src };
  video.onended = () => stopSecond();
  $('#share-modal').classList.add('hidden');
  updateShare2Button();
  for (const peer of state.peers.values()) { applySendParams(peer); sendState(peer.id); }
  render();
  toast('2ª tela no ar: aparece no canto da sua tela para os amigos.');
}
function stopSecond(silent = false) {
  const s2 = state.share2;
  if (!s2) return;
  state.share2 = null;
  s2.video.onended = null;
  s2.stream.getTracks().forEach((t) => t.stop());
  if (meTile) meTile.swapped = false;
  updateShare2Button();
  if (!silent) {
    for (const peer of state.peers.values()) { applySendParams(peer); sendState(peer.id); }
    render();
  }
}
function updateShare2Button() {
  const b = $('#btn-share2');
  b.textContent = state.share2 ? 'Parar 2ª tela' : '+ 2ª tela';
  b.classList.toggle('active', !!state.share2);
}
function swapScreens(id) {
  const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
  if (!tile) return;
  tile.swapped = !tile.swapped;
  tile.s2Hidden = false;
  if (tile.resetZoom) tile.resetZoom();
  render();
  updateTileMedia(id);
}
function toggleS2Bubble(id) {
  const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
  if (!tile) return;
  if (tile.swapped) { tile.swapped = false; tile.s2Hidden = false; } // volta a 1ª para o lugar
  else tile.s2Hidden = !tile.s2Hidden;
  render();
  updateTileMedia(id);
}
let swappedHintAt = 0;
function swappedHint() {
  if (Date.now() - swappedHintAt < 4000) return;
  swappedHintAt = Date.now();
  toast('A mãozinha e a caneta funcionam na tela principal (⇄ no canto para voltar).');
}

// ------------------------------------------------------------------ foto da tela
// Pega o quadro atual na resolução que está chegando (sem a compressão de um print da janela),
// salva em Imagens\Tela Amigos e copia para colar no Discord.
async function takeShot(id) {
  const tile = id === 'me' ? meTile : (state.peers.get(id) || {}).tile;
  const v = tile && tile.video;
  if (!v || !v.videoWidth) { toast('Essa tela ainda não tem imagem.', 'error'); return; }
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) { toast('Não consegui gerar a foto.', 'error'); return; }
  tile.el.classList.remove('flash');
  void tile.el.offsetWidth;
  tile.el.classList.add('flash');
  try {
    const file = await window.native.saveShot(await blob.arrayBuffer(), tileName(id) + (tile.swapped ? ' (2a tela)' : ''));
    toast(`Foto ${c.width}x${c.height} salva em Imagens\\Tela Amigos e copiada (Ctrl+V para colar).`);
    console.log('foto salva', file);
    return file;
  } catch (e) {
    toast(`Falha ao salvar a foto: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ resolução que eu recebo
// Por amigo (guardado pelo nome): Automático (original; cai para 720p sozinho se o MEU PC não
// der conta de decodificar/desenhar), Original, 1080p, 720p ou 480p. Quem transmite reduz só
// para mim (na "Nativa direta" o vídeo é um só para todos, então vale a resolução dele).
const RES_MODES = { auto: 'Automático', orig: 'Original', 1080: '1080p', 720: '720p', 480: '480p' };
function resMode(peer) { const m = localStorage.getItem(`res:${peer.name}`); return m in RES_MODES ? m : 'auto'; }
function wantedMaxH(peer) {
  const m = resMode(peer);
  if (m === 'auto') return peer.autoResCap || 0;
  return m === 'orig' ? 0 : Number(m);
}
function updateResButton(peer) {
  const t = peer.tile;
  if (!t || !t.resBtn) return;
  const m = resMode(peer);
  t.resBtn.classList.toggle('active', m !== 'auto' || !!peer.autoResCap);
  t.resBtn.title = `Resolução que você recebe: ${RES_MODES[m]}${m === 'auto' && peer.autoResCap ? ` (agora ${peer.autoResCap}p: seu PC estava ocupado)` : ''}`;
  t.resBtn.dataset.v = m === 'auto' ? (peer.autoResCap ? `${peer.autoResCap}p` : 'auto') : m === 'orig' ? 'orig.' : `${m}p`;
}
function setResMode(id, mode) {
  const peer = state.peers.get(id);
  if (!peer) return;
  localStorage.setItem(`res:${peer.name}`, mode);
  peer.autoResCap = 0;
  peer.resStrikes = 0;
  updateResButton(peer);
  render();
  const direct = peer.health && peer.health.direct;
  toast(direct && mode !== 'auto' && mode !== 'orig'
    ? `${peer.name} está na "Nativa direta": a resolução é a mesma para todos (a escolha vale quando ele sair dela).`
    : `Tela de ${peer.name}: ${RES_MODES[mode]}.`);
}
// automático: seu PC não está dando conta (quadros não desenhados, decodificação lenta) por ~6 s
// -> pede 720p; depois de ~2 min tudo bem, volta ao original
function autoResolution(peer, mineBad, good, frameH) {
  if (resMode(peer) !== 'auto' || (peer.health && peer.health.direct)) return;
  if (!peer.autoResCap) {
    peer.resStrikes = mineBad ? (peer.resStrikes || 0) + 1 : 0;
    if (peer.resStrikes >= 3 && frameH > 760) {
      peer.autoResCap = 720;
      peer.resGood = 0;
      toast(`Seu PC está ocupado: recebendo a tela de ${peer.name} em 720p para não travar (botão de resolução na tela dele).`);
      updateResButton(peer);
      render();
    }
  } else {
    peer.resGood = good ? (peer.resGood || 0) + 1 : 0;
    if (peer.resGood >= 60) { peer.autoResCap = 0; peer.resStrikes = 0; updateResButton(peer); render(); }
  }
}
// vão para o "⋯" em qualquer largura (na barra ficam volume, caneta, clipe, focar, tela cheia, 2ª tela e o canto)
const OPT_ICONS = new Set(['playpause', 'overlay', 'rec', 'record', 'latency', 'res', 'chart', 'shot', 'pip', 'hide']);
function openMoreMenu(actions, btn) {
  const was = document.querySelector('.menu-pop');
  closeMenus();
  if (was && was.dataset.for === 'more') return;
  const m = document.createElement('div');
  m.className = 'menu-pop';
  m.dataset.for = 'more';
  // o menu mostra o que a largura da tela (ou o tema) escondeu da barra, em grupos e com nomes curtos
  const groups = new Map([['Assistir', []], ['Gravar e salvar', []], ['Mais', []]]);
  for (const b of actions.querySelectorAll('.icon-btn:not(.more-btn)')) {
    if (b.classList.contains('hidden') || b.style.display === 'none' || getComputedStyle(b).display !== 'none') continue;
    const meta = ICON_MENU[b.dataset.icon] || [b.title, 'Mais'];
    // atraso e resolução mostram o valor atual (que está na dica: "Atraso: Automático (clique...)")
    let label = meta[0];
    if (b.dataset.icon === 'latency' || b.dataset.icon === 'res') label = `${meta[0]}: ${(b.title.split(': ')[1] || '').replace(/ \(.*$/, '')}`;
    if (b.dataset.icon === 'hide' && b.title.startsWith('Ocultar minha')) label = 'Ocultar minha prévia';
    const it = document.createElement('button');
    const on = b.classList.contains('active');
    it.className = 'menu-icon' + (on ? ' on' : '');
    it.title = b.title;
    it.innerHTML = b.innerHTML;
    const t = document.createElement('span');
    t.textContent = label + (on ? ' · ligado' : '');
    it.appendChild(t);
    it.onclick = (e) => { e.stopPropagation(); closeMenus(); b.click(); };
    (groups.get(meta[1]) || groups.get('Mais')).push(it);
  }
  for (const [name, items] of groups) {
    if (!items.length) continue;
    const head = document.createElement('div');
    head.className = 'menu-head';
    head.textContent = name;
    m.append(head, ...items);
  }
  m.onpointerdown = (e) => e.stopPropagation();
  m.ondblclick = (e) => e.stopPropagation();
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeMenus, { once: true }), 0);
}
function closeMenus() { document.querySelectorAll('.menu-pop').forEach((m) => m.remove()); }
function openResMenu(id, btn) {
  const peer = state.peers.get(id);
  if (!peer) return;
  const was = document.querySelector('.menu-pop');
  closeMenus();
  if (was && was.dataset.for === `res:${id}`) return;
  const m = document.createElement('div');
  m.className = 'menu-pop';
  m.dataset.for = `res:${id}`;
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = `Receber a tela de ${peer.name} em:`;
  m.appendChild(head);
  const cur = resMode(peer);
  for (const k of ['auto', 'orig', '1080', '720', '480']) { // (Object.entries poria os números primeiro)
    const label = RES_MODES[k];
    const b = document.createElement('button');
    b.className = k === cur ? 'on' : '';
    b.textContent = (k === cur ? '✓ ' : '') + label + (k === 'auto' ? ' (cai para 720p se seu PC apertar)' : k === 'orig' ? ' (o que ele mandar)' : '');
    b.onclick = (e) => { e.stopPropagation(); closeMenus(); setResMode(id, k); };
    m.appendChild(b);
  }
  const head2 = document.createElement('div');
  head2.className = 'menu-head';
  const pathTxt = { vpn: 'agora pelo Radmin/VPN', net: 'agora direto pela internet', relay: 'agora por servidor' }[peer.routePath] || 'conectando';
  head2.textContent = `Conexão com ${peer.name} (${pathTxt}):`;
  m.appendChild(head2);
  for (const k of ['auto', 'any', 'net']) {
    const b = document.createElement('button');
    b.className = k === peer.routePref ? 'on' : '';
    b.textContent = (k === peer.routePref ? '✓ ' : '') + ROUTE_LABELS[k] +
      (k === 'auto' ? ' (troca para a internet se o Radmin travar)' : k === 'net' ? ' (sem Radmin; volta se não conectar)' : '');
    b.onclick = (e) => { e.stopPropagation(); closeMenus(); setRoutePref(id, k); };
    m.appendChild(b);
  }
  m.onpointerdown = (e) => e.stopPropagation();
  m.ondblclick = (e) => e.stopPropagation();
  document.body.appendChild(m);
  // botão escondido no "⋯" (tela estreita): abre junto do "⋯"
  const anchor = btn.offsetWidth ? btn : (btn.parentNode && btn.parentNode.querySelector('.more-btn')) || btn;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeMenus, { once: true }), 0);
}

// ------------------------------------------------------------------ histórico da qualidade
// Gráfico dos últimos 10 min de cada amigo: três painéis com o mesmo eixo de tempo (fps, Mb/s
// e ping, cada um na sua escala), faixa de status em cima e marcas nas travadas. Passar o mouse
// mostra os valores e a causa daquele momento.
let histOpen = null, histHover = null;
// cores do gráfico: as do tema (var(--hist-...) em tema-janelas.css), com as de sempre de reserva
const HIST_COLORS = { line: '#3987e5', good: '#0ca30c', warn: '#fab219', bad: '#d03b3b', grid: 'rgba(255,255,255,0.07)', axis: '#8a90a2', text: '#e8eaf0',
  guide: 'rgba(232,234,240,0.5)', ring: '#16181f', font: '11px system-ui, sans-serif', glow: '0' };
function histColors(el) {
  const cs = getComputedStyle(el);
  const o = {};
  for (const k of Object.keys(HIST_COLORS)) o[k] = cs.getPropertyValue(`--hist-${k}`).trim() || HIST_COLORS[k];
  o.glow = Number(o.glow) || 0; // brilho em volta das linhas (o Neon acende)
  return o;
}
function openHistory(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  histOpen = id;
  histHover = null;
  $('#hist-title').textContent = `Qualidade da tela de ${peer.name} — últimos 10 min`;
  $('#hist-modal').classList.remove('hidden');
  drawHistory();
}
function closeHistory() { histOpen = null; $('#hist-modal').classList.add('hidden'); }
function histSummary(h) {
  if (!h.length) return 'Ainda sem dados: o histórico começa quando a tela dele está visível.';
  const n = h.length, mins = Math.max(1, Math.round((h[n - 1].t - h[0].t) / 60000));
  const fz = h.reduce((a, x) => a + x.fz, 0);
  const bad = h.filter((x) => x.level !== 'good');
  const causes = {};
  for (const x of bad) if (x.short) causes[x.short] = (causes[x.short] || 0) + 1;
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  const avg = (k) => h.reduce((a, x) => a + (x[k] || 0), 0) / n;
  return `${mins} min · média ${Math.round(avg('fps'))} fps, ${avg('mbps').toFixed(1)} Mb/s · ${fz} travada${fz === 1 ? '' : 's'} · ` +
    (bad.length ? `${Math.round((bad.length / n) * 100)}% do tempo com problema${top ? ` (mais: ${top[0]})` : ''}` : 'sem problemas');
}
function drawHistory() {
  const peer = state.peers.get(histOpen);
  if (!peer) { closeHistory(); return; }
  const h = state.hist.get(peer.name) || [];
  $('#hist-summary').textContent = histSummary(h);
  const c = $('#hist-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext('2d');
  const C = histColors(c);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = 44, R = 12, T = 6, STRIP = 8, GAP = 26;
  const now = h.length ? h[h.length - 1].t : Date.now();
  const t0 = now - 600000;
  const x = (t) => L + ((t - t0) / 600000) * (W - L - R);
  // faixa de status (bom / atenção / ruim)
  for (let i = 0; i < h.length; i++) {
    const a = x(h[i].t - 2000), b = x(h[i].t);
    g.fillStyle = C[h[i].level] || C.good;
    g.fillRect(Math.max(L, a), T, Math.max(1, b - a - 0.5), STRIP);
  }
  const panels = [
    { key: 'fps', label: 'fps', max: Math.max(30, ...h.map((p) => p.fps)) },
    { key: 'mbps', label: 'Mb/s', max: Math.max(5, ...h.map((p) => p.mbps)) },
    { key: 'rtt', label: 'ping ms', max: Math.max(50, ...h.map((p) => p.rtt || 0)) },
  ];
  const top0 = T + STRIP + GAP, ph = (H - top0 - 22 - GAP * 2) / 3;
  g.font = C.font;
  panels.forEach((pn, i) => {
    const y0 = top0 + i * (ph + GAP), y = (v) => y0 + ph - (v / pn.max) * ph;
    pn.y = y; pn.y0 = y0;
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (const f of [0, 0.5, 1]) { g.beginPath(); g.moveTo(L, Math.round(y0 + ph * f) + 0.5); g.lineTo(W - R, Math.round(y0 + ph * f) + 0.5); g.stroke(); }
    g.fillStyle = C.axis; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(String(Math.round(pn.max)), L - 6, y0 + 2);
    g.fillText('0', L - 6, y0 + ph);
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = C.text;
    g.fillText(pn.label, L + 4, y0 + 2);
    g.strokeStyle = C.line; g.lineWidth = 2; g.lineJoin = 'round';
    if (C.glow) { g.shadowColor = C.line; g.shadowBlur = C.glow; }
    g.beginPath();
    let started = false;
    for (const p of h) {
      const v = p[pn.key];
      if (v == null) { started = false; continue; }
      if (!started) { g.moveTo(x(p.t), y(v)); started = true; } else g.lineTo(x(p.t), y(v));
    }
    g.stroke();
    g.shadowBlur = 0;
  });
  // travadas: marca vermelha atravessando os painéis
  for (const p of h) {
    if (!p.fz) continue;
    const xx = Math.round(x(p.t)) + 0.5;
    g.strokeStyle = C.bad; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xx, top0); g.lineTo(xx, top0 + 3 * ph + 2 * GAP); g.stroke();
    g.setLineDash([]);
    g.fillStyle = C.bad;
    g.beginPath(); g.arc(xx, panels[0].y(p.fps), 4, 0, Math.PI * 2); g.fill();
  }
  // eixo de tempo
  g.fillStyle = C.axis; g.textBaseline = 'alphabetic';
  for (let m = 10; m >= 0; m -= 2) {
    const xx = x(now - m * 60000);
    g.textAlign = m === 10 ? 'left' : m === 0 ? 'right' : 'center';
    g.fillText(m ? `-${m} min` : 'agora', xx, H - 4);
  }
  // linha-guia + caixinha com os valores do ponto mais próximo do mouse
  const tip = $('#hist-tip');
  if (histHover != null && h.length) {
    let best = h[0];
    for (const p of h) if (Math.abs(x(p.t) - histHover) < Math.abs(x(best.t) - histHover)) best = p;
    const xx = Math.round(x(best.t)) + 0.5;
    g.strokeStyle = C.guide; g.lineWidth = 1;
    g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, top0 + 3 * ph + 2 * GAP); g.stroke();
    for (const pn of panels) {
      const v = best[pn.key];
      if (v == null) continue;
      g.fillStyle = C.line; g.strokeStyle = C.ring; g.lineWidth = 2;
      g.beginPath(); g.arc(xx, pn.y(v), 4, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const lvl = { good: '● bom', warn: '▲ atenção', bad: '■ ruim' }[best.level] || best.level;
    tip.innerHTML = '';
    const lines = [
      new Date(best.t).toLocaleTimeString(),
      `${best.fps} fps · ${best.mbps.toFixed(1)} Mb/s · ping ${best.rtt ?? '?'} ms`,
      `perda ${(best.loss * 100).toFixed(1)}%${best.h ? ` · ${best.h}p` : ''}${best.thumb ? ' · miniatura' : ''}${best.fz ? ` · ${best.fz} travada(s)` : ''}`,
      `${lvl}: ${best.reason}`,
    ];
    lines.forEach((t, i) => { const d = document.createElement('div'); d.textContent = t; if (i === 0) d.className = 'muted'; tip.appendChild(d); });
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth;
    tip.style.left = `${xx + 12 + tw > W ? xx - tw - 12 : xx + 12}px`;
    tip.style.top = `${top0}px`;
  } else tip.classList.add('hidden');
}

// ------------------------------------------------------------------ proteção contra codec que derruba o app
// Em algumas placas (ex.: RX 7600) o H.265 pela placa faz o Chromium abortar a interface no meio
// da transmissão. O codec em uso fica anotado; se a interface cair transmitindo com ele, ele é
// bloqueado para ENVIAR neste PC (o "Automático" passa a usar o próximo) e o app avisa.
function markSendingCodec(mime) {
  const name = /h265/i.test(mime) ? 'H265' : /av1/i.test(mime) ? 'AV1' : /h264/i.test(mime) ? 'H264' : mime ? 'outro' : '';
  if (name) localStorage.setItem('sendingCodec', name); else localStorage.removeItem('sendingCodec');
}
function checkCodecCrash(why) {
  const c = localStorage.getItem('sendingCodec');
  localStorage.removeItem('sendingCodec');
  // Só quando a interface CAIU de verdade (o codec derrubou o Chromium). Falta de memória ('oom') ou
  // o processo encerrado por fora ('killed') não são culpa do codec, e este bloqueio é para sempre.
  if (!why || !/^(crashed|abnormal-exit)$/.test(why) || (c !== 'H265' && c !== 'AV1')) return false;
  localStorage.setItem(`codecBad:${c}`, '1');
  const label = c === 'H265' ? 'H.265' : 'AV1';
  console.error(`interface caiu (${why}) transmitindo em ${label}: ${label} bloqueado para enviar neste PC`);
  toast(`O app caiu enquanto transmitia em ${label} (a placa de vídeo não se deu bem com ele). ` +
    `Neste PC a transmissão passa a usar H.264 — o "Automático" já cuida disso.`, 'error');
  return true;
}

// ------------------------------------------------------------------ estatísticas
let statsBusy = false;
let statsLast = 0;
async function updateStats() {
  // chamadas muito próximas dariam deltas sem sentido (bitrate 0, buffer ?)
  if (!state.showStats || statsBusy || performance.now() - statsLast < 700) return;
  statsLast = performance.now();
  statsBusy = true;
  try { await collectStats(); } finally { statsBusy = false; }
}

async function collectStats() {
  let out = { bytes: 0, fps: 0, w: 0, h: 0, limit: '', enc: '', hw: null, count: 0 };
  for (const peer of state.peers.values()) {
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    const now = performance.now();
    let inV = null, outV = null, rtt = null, pair = null;
    const mainTrack = peer.remoteStream.getVideoTracks()[0];
    const mainId = mainTrack ? mainTrack.id : null;
    const codecs = new Map();
    const cands = new Map();
    report.forEach((r) => {
      // com tela + câmera + 2ª tela há várias trilhas de vídeo: usa só a da tela principal
      // (antes pegava a última da lista, que podia ser a 2ª tela vazia -> "0x0 @ 0fps")
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        if (mainId && r.trackIdentifier) { if (r.trackIdentifier === mainId) inV = r; }
        else if (!inV || (r.bytesReceived || 0) > (inV.bytesReceived || 0)) inV = r;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        if (peer.vT.mid != null && r.mid != null) { if (String(r.mid) === String(peer.vT.mid)) outV = r; }
        else if (!outV || (r.bytesSent || 0) > (outV.bytesSent || 0)) outV = r;
      }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { rtt = r.currentRoundTripTime; pair = r; }
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      if (r.type === 'codec') codecs.set(r.id, r.mimeType.split('/')[1]);
    });
    // tela recebida pelo servidor de vídeo: os números dela estão na conexão com o servidor (antes a
    // linha de estatísticas dessa tela ficava em branco ou parada)
    let sfuCodec = null;
    const sin = peer.sfuIn;
    if (sin && sin.videoRecv) {
      try {
        const rep = await sin.videoRecv.getStats();
        rep.forEach((r) => {
          if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
          inV = r;
          const c = r.codecId && rep.get(r.codecId);
          sfuCodec = (c && c.mimeType ? c.mimeType.split('/')[1] : null) || '?';
        });
      } catch {}
    }
    // rota usada: IP local -> IP remoto (tipo). Pelo Radmin deve ser 26.x -> 26.x (host)
    let route = '?';
    if (pair) {
      const l = cands.get(pair.localCandidateId), r = cands.get(pair.remoteCandidateId);
      if (l && r) route = `${l.address || '?'}→${r.address || '?'} ${r.candidateType}/${l.protocol}`;
    }
    peer.route = route;
    const prev = peer.statsPrev || {};
    const dt = prev.t ? (now - prev.t) / 1000 : 0;
    // recebendo
    if (inV && peer.tile) {
      const bps = dt && prev.inBytes != null ? Math.max(0, ((inV.bytesReceived - prev.inBytes) * 8) / dt) : 0;
      const lost = inV.packetsLost || 0;
      // atraso do buffer de recepção (ms) e travadas detectadas pelo próprio WebRTC
      const jb = prev.jbEmitted != null && inV.jitterBufferEmittedCount > prev.jbEmitted
        ? ((inV.jitterBufferDelay - prev.jbDelay) / (inV.jitterBufferEmittedCount - prev.jbEmitted)) * 1000 : null;
      peer.tile.stats.textContent =
        `${inV.frameWidth || 0}x${inV.frameHeight || 0} @ ${Math.round(inV.framesPerSecond || 0)}fps · ` +
        `${fmtMbps(bps)} · ${sfuCodec || codecs.get(inV.codecId) || '?'} · ping ${rtt != null ? Math.round(rtt * 1000) : '?'}ms · ` +
        `buffer ${jb != null ? Math.round(jb) : '?'}ms · travadas ${inV.freezeCount || 0} · perdidos ${lost} · ` +
        `NACK ${inV.nackCount || 0} · PLI ${inV.pliCount || 0} · keyframes ${inV.keyFramesDecoded || 0} · ` +
        `descartados ${inV.framesDropped || 0}\nrota ${route}${sfuCodec ? ' · imagem pelo servidor de vídeo' : ''}` +
        (inV.decoderImplementation ? ` · dec ${inV.decoderImplementation}` : '');
      peer.jb = { jbDelay: inV.jitterBufferDelay, jbEmitted: inV.jitterBufferEmittedCount };
    }
    // enviando (agrega para a minha prévia)
    if (outV && state.share) {
      const bps = dt && prev.outBytes != null ? ((outV.bytesSent - prev.outBytes) * 8) / dt : 0;
      out.bytes += bps;
      if (peer.vT.sender.track) {
        out.count++;
        out.fps = Math.max(out.fps, outV.framesPerSecond || 0);
        out.w = Math.max(out.w, outV.frameWidth || 0);
        out.h = Math.max(out.h, outV.frameHeight || 0);
        if (outV.qualityLimitationReason && outV.qualityLimitationReason !== 'none') out.limit = outV.qualityLimitationReason;
        out.enc = outV.encoderImplementation || out.enc;
        if (outV.powerEfficientEncoder != null) out.hw = outV.powerEfficientEncoder;
      }
    }
    peer.statsPrev = { t: now, inBytes: inV ? inV.bytesReceived : null, outBytes: outV ? outV.bytesSent : null, ...(peer.jb || {}) };
  }
  state.myOut = out;
  const routes = [...state.peers.values()].filter((p) => p.route).map((p) => `\nrota ${p.name}: ${p.route}`).join('');
  if (meTile && state.share && state.share.direct) {
    const n = state.nativeStats;
    meTile.stats.textContent = n
      ? `Nativo · ${n.width}x${n.height} · captura ${n.captureFps}fps · enviado ${n.fps}fps · ${fmtMbps(n.kbps * 1000)} ` +
        `· encode ${n.encodeMs}ms · descartados ${n.dropped}${n.late ? ` · atrasados ${n.late}` : ''} · ${state.share.encoder} · ` +
        `p/ ${out.count} amigo(s), total ${fmtMbps(out.bytes)}\n` +
        `alvo ${fmtMbps((state.nativeKbps || 0) * 1000)} · banda estimada ${state.netInfo.avail ? fmtMbps(state.netInfo.avail * 1000) : '?'}` +
        `${state.netInfo.pace ? ` (teto de envio ${fmtMbps(state.netInfo.pace * 1000)})` : ''} · ` +
        `perda ${(state.netInfo.loss * 100).toFixed(1)}% · rtt ${state.netInfo.rtt ? Math.round(state.netInfo.rtt * 1000) : '?'}ms · ` +
        `NACK ${state.netInfo.nack} · PLI ${state.netInfo.pli} · keyframes ${n.keys}` +
        (state.netInfo.why ? `\nrede: ${state.netInfo.why}` : '') + routes
      : 'Iniciando captura nativa...';
  } else if (meTile && state.share) {
    const LIMIT = { bandwidth: 'internet', cpu: 'processador', other: 'outro' };
    const n = state.share.native && state.nativeStats;
    const cap = n ? `Captura nativa ${n.width}x${n.height} @ ${n.captureFps}fps (enviado ao WebRTC ${n.fps}fps)\n` : '';
    meTile.stats.textContent = cap + (out.count
      ? `Enviando p/ ${out.count} · ${out.w}x${out.h} @ ${Math.round(out.fps)}fps · total ${fmtMbps(out.bytes)} · ` +
        `limitação: ${out.limit ? LIMIT[out.limit] || out.limit : 'nenhuma'} · ` +
        `encoder ${out.enc || '?'}${out.hw === true ? ' (placa de vídeo)' : out.hw === false ? ' (CPU)' : ''}` + routes
      : 'Ninguém recebendo sua tela no momento');
  }
  paintStatsPane();
}
setInterval(updateStats, 1000);

// ------------------------------------------------------------------ eventos de UI
function initRoomUi() {
  window.Helper.onEvent(onHelperEvent);
  $('#btn-share').onclick = () => openShareModal();
  $('#btn-share2').onclick = () => { if (state.share2) stopSecond(); else openShareModal(true); };
  $('#hist-close').onclick = closeHistory;
  $('#hist-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'hist-modal') closeHistory(); });
  $('#btn-stop').onclick = stopShare;
  $('#btn-leave').onclick = leaveRoom;
  $('#btn-close-room').onclick = closeRoomForEveryone;
  $('#btn-adjust').onclick = openAdjust;
  $('#btn-camera').onclick = toggleCamera;
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('#chat-send').onclick = sendChat;
  $('#share-more').onclick = () => $('#share-modal .settings').classList.toggle('more-open');
  $('#share-modal .settings').addEventListener('change', () => paintShareSum()); // resumo "vai ao ar" (só alguns temas mostram)
  // quantas opções existem e os atalhos que ficaram valendo, para os temas que escrevem isso na tela
  $('#btn-options').dataset.n = document.querySelectorAll('#side-opts .sound-toggle.switch').length;
  window.native.getHotkeys().then((k) => {
    for (const el of document.querySelectorAll('#keys-bar kbd[data-hk]')) {
      const key = k[el.dataset.hk];
      if (key) el.textContent = key; else el.parentNode.classList.add('hidden'); // outro programa ficou com o atalho
    }
  }).catch(() => {});
  // temas em que as opções abrem num painel (o botão "Opções" só existe neles)
  $('#btn-options').onclick = () => {
    if ($('#room').classList.toggle('opts-open')) $('#side-opts').open = true;
  };
  document.addEventListener('mousedown', (e) => {
    if ($('#room').classList.contains('opts-open') && !e.target.closest('#side-opts, .side-links, #btn-options')) $('#room').classList.remove('opts-open');
  });
  // trocou o tema: cada tela se arruma do jeito do tema novo e a sala é redesenhada
  window.Themes.onChange(() => {
    for (const t of [meTile, ...[...state.peers.values()].map((p) => p.tile)]) {
      window.Themes.tileSetup(t);
      if (t && t.el) t.el.querySelectorAll('.react-bar button[data-emoji]').forEach(paintEmote);
    }
    $('#room').classList.remove('opts-open');
    $('#side-opts').open = localStorage.getItem('sideOpts') === '1'; // o painel do tema anterior pode ter deixado a lista aberta
    if (!$('#room').classList.contains('hidden')) render();
    paintShareSum();
    $('#chat-log').scrollTop = $('#chat-log').scrollHeight; // o chat muda de tamanho com o tema: continua no fim
  });
  $('#opt-clipsys').checked = localStorage.getItem('clipSys') !== '0';
  $('#opt-clipsys').onchange = () => localStorage.setItem('clipSys', $('#opt-clipsys').checked ? '1' : '0');
  $('#opt-laserdesk').checked = localStorage.getItem('laserDesk') !== '0';
  $('#opt-laserdesk').onchange = () => localStorage.setItem('laserDesk', $('#opt-laserdesk').checked ? '1' : '0');
  $('#opt-inkdesk').checked = localStorage.getItem('inkDesk') !== '0';
  $('#opt-inkdesk').onchange = () => localStorage.setItem('inkDesk', $('#opt-inkdesk').checked ? '1' : '0');
  $('#opt-reactdesk').checked = localStorage.getItem('reactDesk') !== '0';
  $('#opt-reactdesk').onchange = () => localStorage.setItem('reactDesk', $('#opt-reactdesk').checked ? '1' : '0');
  $('#btn-region').onclick = () => pickRegion().catch((e) => toast(`Falha ao escolher a área: ${e.message}`, 'error'));
  $('#btn-region-clear').onclick = () => { if (selectedSource) delete selectedSource.crop; updateRegionUi(); };
  $('#opt-leveler').checked = localStorage.getItem('leveler') !== '0';
  $('#opt-leveler').onchange = () => localStorage.setItem('leveler', $('#opt-leveler').checked ? '1' : '0');
  // abrir com o Windows (na bandeja) e entrar sozinho na última sala
  window.native.autostart().then((on) => { $('#opt-autostart').checked = !!on; }).catch(() => {});
  $('#opt-autostart').onchange = async () => {
    const want = $('#opt-autostart').checked;
    const on = !!(await window.native.autostart(want));
    $('#opt-autostart').checked = on;
    if (want && !on) toast('Só funciona no app instalado.', 'error'); // (a comparação antiga nunca dava verdadeiro)
  };
  $('#opt-autojoin').checked = localStorage.getItem('autoJoin') === '1';
  $('#opt-autojoin').onchange = () => localStorage.setItem('autoJoin', $('#opt-autojoin').checked ? '1' : '0');
  $('#side-opts').open = localStorage.getItem('sideOpts') === '1';
  $('#side-opts').ontoggle = () => {
    if (!$('#room').classList.contains('opts-open')) localStorage.setItem('sideOpts', $('#side-opts').open ? '1' : '0');
  };
  // falha ao gravar no disco (disco cheio...): para a gravação em vez de fingir que salvou
  window.native.onRecError(({ handle, message }) => {
    const id = window.Clips.recByHandle(handle);
    if (id == null) return;
    toast(`A gravação parou: ${message}. O que já foi gravado ficou salvo.`, 'error');
    toggleRecording(id);
  });
  $('#btn-ready').onclick = () => startReadyCheck();
  $('#ready-ok').onclick = () => markReady();
  $('#ready-cancel').onclick = () => {
    if (!readyCheck) return;
    sendRelay(null, { kind: 'ready-cancel', id: readyCheck.id });
    endReadyCheck(null);
  };
  $('#opt-mediactl').checked = mediaAllowed();
  $('#opt-mediactl').onchange = () => localStorage.setItem('mediactl', $('#opt-mediactl').checked ? '1' : '0');
  $('#btn-nettest').onclick = () => runNetTest().catch((e) => toast(`Falha no teste: ${e.message}`, 'error'));
  $('#nettest-again').onclick = () => runNetTest().catch((e) => toast(`Falha no teste: ${e.message}`, 'error'));
  $('#nettest-close').onclick = () => $('#nettest-modal').classList.add('hidden');
  $('#btn-diag').onclick = () => saveDiagnostics().catch((e) => toast(`Falha no diagnóstico: ${e.message}`, 'error'));
  $('#btn-diag-room').onclick = () => requestRoomDiag().catch((e) => toast(`Falha no diagnóstico da sala: ${e.message}`, 'error'));
  // mostra os atalhos que de fato ficaram valendo (outro programa pode ter "pegado" algum)
  window.native.getHotkeys().then((k) => {
    const names = { share: 'transmitir/parar', mute: 'mutar todos', 'overlay-lock': 'destravar sobreposição', clip: 'salvar clipe' };
    const lines = Object.entries(names).map(([a, n]) => `${k[a] || '(ocupado por outro programa)'}: ${n}`);
    const el = document.querySelector('.side-links span');
    if (el) { el.textContent = 'Atalhos (passe o mouse)'; el.title = lines.join('\n'); }
    const taken = Object.entries(k).filter(([, v]) => !v || v.includes('Alt'));
    if (taken.length) console.warn('atalhos trocados/ocupados:', JSON.stringify(k));
  }).catch(() => {});
  $('#opt-gamehide').checked = localStorage.getItem('gamehide') !== '0';
  $('#opt-gamehide').onchange = () => { localStorage.setItem('gamehide', $('#opt-gamehide').checked ? '1' : '0'); render(); };
  $('#opt-status').checked = localStorage.getItem('status') !== '0';
  $('#stage').classList.toggle('nostatus', !$('#opt-status').checked);
  $('#opt-status').onchange = () => { localStorage.setItem('status', $('#opt-status').checked ? '1' : '0'); $('#stage').classList.toggle('nostatus', !$('#opt-status').checked); };
  $('#opt-sfu').checked = localStorage.getItem('sfu') === '1';
  $('#opt-sfu').onchange = () => {
    localStorage.setItem('sfu', $('#opt-sfu').checked ? '1' : '0');
    if ($('#opt-sfu').checked && !sfuWanted()) toast(isOnlineCode(state.hostIp) && !state.sfuServer ? 'Esta sala online ainda não tem servidor de vídeo configurado.' : 'Vale só na sala online (sem Radmin).');
    sfuSync();
  };
  $('#opt-gamebuffer').checked = localStorage.getItem('gamebuffer') !== '0';
  $('#opt-gamebuffer').onchange = () => { localStorage.setItem('gamebuffer', $('#opt-gamebuffer').checked ? '1' : '0'); applyPlayoutBuffer(); };
  // teclas globais (funcionam com o jogo em primeiro plano)
  window.native.onHotkey((action) => {
    if ($('#room').classList.contains('hidden')) return;
    if (action === 'share') {
      if (state.share) stopShare();
      else if (state.lastSource) { selectedSource = state.lastSource; startShare(); }
      else { window.native.focusWindow(); openShareModal(); }
    } else if (action.startsWith('focus:')) { // clique no nome de um amigo no menu da bandeja
      const p = [...state.peers.values()].find((x) => x.name === action.slice(6));
      if (p && isSharing(p.id)) { state.hidden.delete(p.id); setFocus(p.id); }
    } else if (action === 'mute') {
      const tiles = [...state.peers.values()].map((p) => p.tile).filter(Boolean);
      const anyOn = tiles.some((t) => t.isMuted && !t.isMuted());
      for (const t of tiles) if (t.setMuted) t.setMuted(anyOn);
      toast(anyOn ? 'Todas as telas mutadas.' : 'Som das telas de volta.');
    } else if (action === 'clip') {
      // salva clipe de todas as telas com replay ligado (ou da tela em foco, ligando o replay)
      const ids = window.Clips.ids();
      if (ids.length) ids.forEach((id) => saveClip(id));
      else if (state.layout === 'focus' && state.focusId) saveClip(state.focusId);
      else toast('Ligue o replay numa tela (botão de gravar) para poder salvar clipes.');
    }
  });
  $('#opt-engine').onchange = updateEngineFields;
  $('#opt-sounds').checked = localStorage.getItem('sounds') !== '0';
  $('#opt-sounds').onchange = () => {
    localStorage.setItem('sounds', $('#opt-sounds').checked ? '1' : '0');
    if ($('#opt-sounds').checked) Sfx.play('join');
  };
  $('#adj-bitrate').oninput = () => setMbps($('#adj-bitrate-label'), $('#adj-bitrate').value);
  $('#adj-bitrate').onchange = () => applyLiveBitrate(Number($('#adj-bitrate').value));
  $('#adj-apply').onclick = applyAdjust;
  $('#modal-close').onclick = () => $('#share-modal').classList.add('hidden');
  $('#share-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'share-modal') $('#share-modal').classList.add('hidden'); });
  $('#btn-start-share').onclick = startFromModal;
  $('#opt-bitrate').oninput = () => setMbps($('#opt-bitrate-label'), $('#opt-bitrate').value);
  document.querySelectorAll('.tabs .seg').forEach((b) => {
    b.onclick = () => {
      sourceTab = b.dataset.tab;
      document.querySelectorAll('.tabs .seg').forEach((x) => x.classList.toggle('active', x === b));
      renderSources();
      if (!sourcesLoaded[sourceTab]) loadSources(sourceTab);
    };
  });
  document.querySelectorAll('.layout-switch .seg').forEach((b) => {
    b.onclick = () => { state.layout = b.dataset.layout; render(); };
  });
  $('#btn-stats').onclick = () => { state.showStats = !state.showStats; render(); updateStats(); };
  $('#btn-copy-ip').onclick = () => {
    window.native.copy(state.hostIp);
    toast(isOnlineCode(state.hostIp) ? 'Código copiado. Os amigos entram com ele (não precisa de Radmin).' : 'IP copiado. Mande para os amigos.');
  };

  window.addEventListener('resize', () => render());
  window.addEventListener('keydown', (e) => {
    // Esc: no Electron a tela cheia NÃO sai sozinha com Esc (no Chrome sai)
    if (e.key === 'Escape') {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      if (window.News.isOpen()) { window.News.close(); return; }
      if (window.ThemePicker.isOpen()) { window.ThemePicker.close(); return; }
      if (!$('#adjust-panel').classList.contains('hidden')) { $('#adjust-panel').classList.add('hidden'); return; }
      if ($('#room').classList.contains('opts-open')) { $('#room').classList.remove('opts-open'); return; }
      if (!$('#hist-modal').classList.contains('hidden')) { closeHistory(); return; }
      if (document.querySelector('.menu-pop')) { closeMenus(); return; }
      // caneta ligada em alguma tela: Esc desliga
      const penTiles = [meTile, ...[...state.peers.values()].map((p) => p.tile)].filter((t) => t && t.pen);
      if (penTiles.length) { for (const t of penTiles) setPen(t, t.el.dataset.id, false); return; }
      if ($('#share-modal').classList.contains('hidden') && state.layout === 'focus') { state.layout = 'grid'; render(); return; }
    }
    if (e.target.matches('input, select, textarea') || $('#room').classList.contains('hidden')) return;
    if (window.News.isOpen() || window.ThemePicker.isOpen()) return; // com as novidades (ou os temas) na frente, as teclas da sala (G, F, S, P...) esperam
    if (e.ctrlKey && e.key === '0') { // Ctrl+0: tira o zoom de todas as telas
      for (const t of [meTile, ...[...state.peers.values()].map((p) => p.tile)]) if (t && t.resetZoom) t.resetZoom();
      e.preventDefault();
      return;
    }
    if (!$('#share-modal').classList.contains('hidden')) {
      if (e.key === 'Escape') $('#share-modal').classList.add('hidden');
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'g') { state.layout = 'grid'; render(); }
    if (k === 'f') { state.layout = 'focus'; render(); }
    if (k === 's') $('#btn-stats').click();
    if (k === 'p') { // foto da tela em foco (ou da única tela de amigo)
      const ids = [...state.peers.keys()].filter((i) => isSharing(i) && !state.hidden.has(i));
      const id = state.layout === 'focus' && state.focusId ? state.focusId : ids.length === 1 ? ids[0] : null;
      if (id != null) takeShot(id); else toast('Foque numa tela (duplo clique) para tirar a foto com P.');
    }
  });
}

// ------------------------------------------------------------------ atualização automática
function initUpdates() {
  window.native.appVersion().then((v) => { $('#app-version').textContent = `v${v}`; });
  // a interface caiu e foi recarregada sozinha: avisa (o motivo fica no registro/diagnóstico)
  window.native.recovered().then((why) => {
    if (checkCodecCrash(why)) return;
    if (why) toast(`O app teve um problema (${why}) e foi recarregado. Se repetir, clique em "Enviar diagnóstico".`, 'error');
  }).catch(() => {});
  const bar = $('#update-bar');
  const checkBtn = $('#btn-check-update');
  let hideTimer = null;
  const show = (text, { button = false, autoHide = 0 } = {}) => {
    clearTimeout(hideTimer);
    bar.classList.remove('hidden');
    $('#update-text').textContent = text;
    $('#btn-update').classList.toggle('hidden', !button);
    if (autoHide) hideTimer = setTimeout(() => bar.classList.add('hidden'), autoHide);
  };
  window.native.onUpdateStatus((s) => {
    checkBtn.disabled = s.state === 'checking' || s.state === 'downloading';
    if (s.state === 'checking') show('Procurando atualização...');
    else if (s.state === 'latest') show(`Você já está na versão mais recente (v${s.version}).`, { autoHide: 4000 });
    else if (s.state === 'downloading') show(`Baixando atualização${s.version ? ` v${s.version}` : ''}... ${s.percent}%`);
    else if (s.state === 'ready') {
      show(`Versão ${s.version} pronta. Instala sozinha ao fechar o app.`, { button: true });
      checkBtn.textContent = 'Reiniciar e atualizar';
      checkBtn.onclick = () => $('#btn-update').click();
    } else if (s.state === 'error') show(`Não deu para procurar atualização: ${s.message}`, { autoHide: 8000 });
    else if (s.state === 'dev') show('Modo desenvolvimento: atualização desativada.', { autoHide: 3000 });
  });
  checkBtn.onclick = () => window.native.checkUpdate();
  $('#btn-update-close').onclick = () => bar.classList.add('hidden');
  $('#btn-update').onclick = async () => {
    if (state.share) await stopShare();
    window.native.installUpdate();
  };
}

// histórico: passar o mouse mostra os valores
{
  const c = $('#hist-canvas');
  c.addEventListener('pointermove', (e) => { histHover = e.clientX - c.getBoundingClientRect().left; drawHistory(); });
  c.addEventListener('pointerleave', () => { histHover = null; drawHistory(); });
  new ResizeObserver(() => { if (histOpen != null) drawHistory(); }).observe(c);
}

window.Sdp.av1Ready.then(() => { if (window.Sdp.hasAV1Hw()) for (const p of state.peers.values()) sendState(p.id); });

initLobby();
initRoomUi();
initUpdates();
window.ThemePicker.init(); // "Escolher tema": a lista de tema abre a galeria
window.News.init(); // novidades da versão: abre sozinha uma vez depois de cada atualização
// o tema se mexe no uso (vida.js): para com jogo em tela cheia e no modo leve; o medidor de som lê as telas dos amigos
window.Vida.init({
  gaming: () => !!state.gaming,
  light: () => !!state.lightMode,
  tiles: () => [...state.peers.values()].map((p) => p.tile).filter(Boolean),
});
