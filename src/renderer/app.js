/* Tela Amigos — renderer
 * Malha WebRTC: cada participante tem uma conexão direta com cada outro.
 * Cada conexão tem 1 transceiver de vídeo + 1 de áudio "sendonly" de cada lado,
 * criados desde o início; compartilhar/parar só troca a trilha (replaceTrack),
 * sem renegociar.
 */
const $ = (s) => document.querySelector(s);
let SIGNAL_PORT = 47800;
window.native.netInfo().then((i) => { SIGNAL_PORT = i.port; });
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  settings: {
    res: '1080', fps: 60, mode: 'motion', codec: 'H264', bitrate: 20, audio: 'all-except', engine: 'native',
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
  const lines = [];
  const s = state.share;
  lines.push(`nome=${state.myName} id=${state.myId} sala=${state.hostIp} anfitriao=${!!state.isHost} layout=${state.layout}`);
  lines.push(`config=${safeJson(state.settings)}`);
  lines.push(`transmitindo=${!!s}${s ? ` fonte="${s.sourceName}" nativo=${s.native} direto=${s.direct} ${s.width}x${s.height} encoder=${s.encoder} modoLeve=${!!state.lightMode}` : ''}`);
  if (state.nativeStats) lines.push(`helper=${safeJson(state.nativeStats)}`);
  lines.push(`jogando=${!!state.gaming} (${state.gamingExe || ''})`);
  for (const p of state.peers.values()) {
    lines.push('');
    lines.push(`--- ${p.name} (id ${p.id}) conn=${p.pc.connectionState} ice=${p.pc.iceConnectionState} sinal=${p.pc.signalingState} ` +
      `compartilhando=${p.sharing} rota=${p.route || '?'} qualidade=${p.quality ? p.quality.level + ' ' + p.quality.reason : '?'} ` +
      `saude=${safeJson(p.health || {})} quer=${p.theyWant} pedi=${p.iWant}`);
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
  try {
    const d = await window.Helper.diag();
    lines.push('', `placas/encoders: ${safeJson(d.info || d)}`);
  } catch {}
  lines.push('', '===== registro =====', ...appLog);
  const file = await window.native.saveDiagnostics(lines.join('\n'));
  toast(`Diagnóstico salvo na Área de Trabalho: ${file.split(/[\\/]/).pop()}. Mande esse arquivo.`);
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
    connect('127.0.0.1', true);
  };
  $('#btn-close-my-room').onclick = async () => {
    await window.native.hostStop();
    refreshMyRoom();
  };
  refreshMyRoom();
  renderRooms();
  discoverLoop();
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

function joinRoom(ip) {
  $('#host-ip').value = ip;
  $('#btn-join').click();
}

function renderRooms() {
  const ul = $('#rooms');
  ul.innerHTML = '';
  const seen = new Set();
  const row = (title, sub, ip, offline) => {
    const li = document.createElement('li');
    if (offline) li.classList.add('offline');
    const info = document.createElement('div');
    info.className = 'room-info';
    const t = document.createElement('span'); t.className = 'room-title'; t.textContent = title;
    const s = document.createElement('span'); s.className = 'room-sub'; s.textContent = sub;
    info.append(t, s);
    const b = document.createElement('button');
    b.className = offline ? 'ghost' : 'primary';
    b.textContent = 'Entrar';
    b.onclick = () => { if (checkName()) joinRoom(ip); };
    li.append(info, b);
    ul.appendChild(li);
  };
  for (const r of discovered) {
    seen.add(r.ip);
    const who = r.members ? `${r.members} na sala: ${r.names.join(', ')}` : 'ninguém na sala ainda';
    row(`Sala de ${r.hostName}`, `${who} · ${r.ip}`, r.ip, false);
  }
  for (const r of recentRooms()) {
    if (seen.has(r.ip)) continue;
    row(`Sala de ${r.hostName}`, `recente · não encontrada agora · ${r.ip}`, r.ip, true);
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

  $('#btn-join').onclick = () => {
    if (!checkName()) return;
    const ip = $('#host-ip').value.trim();
    if (!/^[\w.-]+$/.test(ip)) return showLobbyError('Digite o IP de quem está hospedando.');
    localStorage.setItem('hostIp', ip);
    state.hostIp = ip;
    connect(ip, false);
  };
  $('#host-ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
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
  showLobbyError('');
  $('#btn-join').disabled = $('#btn-host').disabled = true;
  state.resume = null;
  openSocket(ip, false);
}

let heartbeat = null;
function openSocket(ip, reconnecting) {
  const ws = new WebSocket(`ws://${ip}:${SIGNAL_PORT}`);
  state.ws = ws;
  let opened = false;
  let lastMsg = Date.now();
  const timeout = setTimeout(() => { if (!opened) ws.close(); }, 6000);

  ws.onopen = () => {
    opened = true;
    clearTimeout(timeout);
    ws.send(JSON.stringify({ type: 'join', name: state.myName, resume: state.resume }));
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
    onSignal(msg);
  };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (ws !== state.ws) return; // conexão antiga (saiu e entrou de novo)
    if (!opened && !reconnecting) {
      $('#btn-join').disabled = $('#btn-host').disabled = false;
      showLobbyError(`Não consegui conectar em ${ip}. Confira se o IP está certo, se a pessoa clicou em "Hospedar" e se o Radmin está conectado.`);
      return;
    }
    if (state.leaving) return;
    scheduleReconnect(ip);
  };
}

let reconnectTry = 0;
function scheduleReconnect(ip) {
  clearInterval(heartbeat);
  reconnectTry++;
  setReconnectBanner(true);
  const wait = Math.min(5000, 500 * 2 ** Math.min(reconnectTry, 4));
  setTimeout(() => {
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
      setReconnectBanner(false);
      state.resume = { id: msg.id, token: msg.token };
      if (wasInRoom) {
        if (!msg.resumed || msg.id !== state.myId) {
          // a sala reiniciou (ou o lugar expirou): recomeça as conexões com todo mundo
          for (const id of [...state.peers.keys()]) removePeer(id);
          state.myId = msg.id;
        } else {
          // retomou o mesmo lugar: tira quem saiu enquanto estávamos fora
          const ids = new Set(msg.peers.map((p) => p.id));
          for (const id of [...state.peers.keys()]) if (!ids.has(id)) removePeer(id);
        }
        for (const p of msg.peers) createPeer(p.id, p.name);
        for (const peer of state.peers.values()) sendState(peer.id);
        toast('Reconectado à sala.');
        break;
      }
      state.myId = msg.id;
      if (!state.isHost) {
        const d = discovered.find((r) => r.ip === state.hostIp);
        const prev = recentRooms().find((r) => r.ip === state.hostIp);
        rememberRoom(state.hostIp, d ? d.hostName : prev ? prev.hostName : state.hostIp);
      }
      enterRoom();
      for (const p of msg.peers) createPeer(p.id, p.name);
      break;
    }
    case 'peer-joined':
      createPeer(msg.id, msg.name);
      toast(`${msg.name} entrou na sala`);
      Sfx.play('join');
      break;
    case 'peer-left': {
      const p = state.peers.get(msg.id);
      if (p) { toast(`${p.name} saiu`); Sfx.play('leave'); }
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
    case 'error':
      showLobbyError(msg.message || 'Erro na sala');
      break;
  }
}

function onRelay(from, data) {
  const peer = state.peers.get(from);
  if (!peer) return;
  switch (data.kind) {
    // em fila por amigo: uma descrição/candidato nunca é processado no meio de outro
    case 'sdp': peer.sigChain = peer.sigChain.then(() => handleDescription(peer, data.description)); break;
    case 'ice': peer.sigChain = peer.sigChain.then(() => handleCandidate(peer, data.candidate)); break;
    case 'state':
      {
        const was = peer.sharing;
        peer.sharing = data.sharing;
        peer.hasAudio = data.audio;
        peer.sourceName = data.sourceName || '';
        const hadCam = peer.hasCam;
        peer.hasCam = !!data.cam;
        if (data.screenId) { peer.remoteScreenId = data.screenId; peer.remoteCamId = data.camId; resolveTracks(peer); }
        if (peer.hasCam && !hadCam && !data.sharing) toast(`${peer.name} ligou a câmera`);
        if ((data.sharing || peer.hasCam) && !state.order.includes(peer.id)) state.order.push(peer.id);
        if (data.sharing && !was) {
          toast(`${peer.name} começou a compartilhar`);
          Sfx.play('share');
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
      }
      break;
    case 'want':
      peer.theyWant = data.level;
      applySendParams(peer);
      break;
    case 'health':
      peer.health = { cpu: !!data.cpu };
      break;
    case 'chat':
      if (!String(data.text || '').trim()) break; // ignora mensagem vazia
      addChat(peer.name, String(data.text).slice(0, 300));
      if (!document.hasFocus()) Sfx.play('chat');
      break;
    case 'react':
      if (typeof data.emoji === 'string' && data.emoji.length <= 8) showReaction(String(data.target), data.emoji, peer.name);
      break;
    case 'point':
      if (Number.isFinite(data.x) && Number.isFinite(data.y)) showLaser(String(data.target), peer.id, peer.name, data.x, data.y, !!data.draw);
      break;
    case 'press':
      if (Number.isFinite(data.x) && Number.isFinite(data.y)) showPress(String(data.target), peer.id, peer.name, data.x, data.y);
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
  peer.camStream = new MediaStream();   // câmera recebida deste amigo
  peer.videoTracks = new Map();         // id do stream -> trilha de vídeo recebida
  setCodec(peer, state.share && state.share.direct ? 'native' : s.codec);
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
    if (candidate && !isIPv6Candidate(candidate)) sendRelay(id, { kind: 'ice', candidate: demoteVpnCandidate(candidate.toJSON()) });
  };
  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      const st = peer.remoteStream;
      for (const t of st.getAudioTracks()) st.removeTrack(t);
      st.addTrack(e.track);
    } else {
      // vídeo: tela ou câmera? decide em resolveTracks (o amigo informa os ids no "state")
      const sid = (e.streams && e.streams[0] && e.streams[0].id) || `sem-id-${peer.videoTracks.size}`;
      peer.videoTracks.set(sid, e.track);
    }
    resolveTracks(peer);
  };
  pc.onconnectionstatechange = () => {
    peer.conn = pc.connectionState;
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'connected') applySendParams(peer);
    renderPeople();
  };

  state.peers.set(id, peer);

  // Se eu já estou compartilhando, começa a mandar para o novo amigo
  applySendParams(peer);
  sendState(id);
  render();
}

function setCodec(peer, codec) {
  peer.codecMode = codec;
  const prefs = codec === 'native' ? window.Sdp.h264OnlyPreferences() : window.Sdp.codecPreferences(codec);
  try { if (prefs) peer.vT.setCodecPreferences(prefs); } catch (e) { console.warn('codec', e); }
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
    offer.sdp = window.Sdp.munge(offer.sdp, { videoKbps: state.settings.bitrate * 1000, native: !!(state.share && state.share.direct) });
    await pc.setLocalDescription(offer);
    sendRelay(peer.id, { kind: 'sdp', description: pc.localDescription });
  } catch (e) {
    console.error('negotiate', e);
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
    try {
      await pc.setRemoteDescription({
        type: description.type,
        sdp: window.Sdp.munge(description.sdp, {
          videoKbps: state.settings.bitrate * 1000,
          native: !!(state.share && state.share.direct),
        }),
      });
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
      answer.sdp = window.Sdp.munge(answer.sdp, { videoKbps: state.settings.bitrate * 1000, native: !!(state.share && state.share.direct) });
      await pc.setLocalDescription(answer);
      sendRelay(peer.id, { kind: 'sdp', description: pc.localDescription });
    }
  } catch (e) {
    console.error('sdp', e);
  }
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

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  window.NativeVideo.remove(id);
  closeOverlay(id);
  window.Clips.stop(id);
  if (peer.tile) peer.tile.el.remove();
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
    sourceName: state.share ? state.share.sourceName : '',
    cam: !!state.camera,
    // ids dos streams desta conexão: quem recebe separa tela de câmera
    screenId: peer ? peer.screenMS.id : null,
    camId: peer ? peer.camMS.id : null,
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
  const st = peer.remoteStream;
  if (screen && !st.getVideoTracks().includes(screen)) {
    for (const t of st.getVideoTracks()) st.removeTrack(t);
    st.addTrack(screen);
  }
  const cs = peer.camStream;
  if (cam && !cs.getVideoTracks().includes(cam)) {
    for (const t of cs.getVideoTracks()) cs.removeTrack(t);
    cs.addTrack(cam);
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

  const wantVideo = share && level !== 'off' ? share.video : null;
  const wantAudio = share && level !== 'off' ? share.audio || null : null;

  // modo nativo: o vídeo precisa sair em H.264 e passar pelo transform que injeta nossos quadros
  const native = !!(share && share.direct); // envio direto do H.264 nativo
  const codecMode = native ? 'native' : state.settings.codec;
  if (peer.codecMode !== codecMode) {
    setCodec(peer, codecMode);
    negotiate(peer);
  }
  // antes de trocar a trilha: assim o primeiro quadro já é tratado no modo certo
  window.NativeVideo.setMode(peer.id, native, !!wantVideo && peer.pc.connectionState === 'connected');
  if (vSender.track !== wantVideo) await vSender.replaceTrack(wantVideo).catch(() => {});
  if (aSender.track !== wantAudio) await aSender.replaceTrack(wantAudio).catch(() => {});
  // câmera (independe de estar compartilhando a tela)
  const wantCam = state.camera && level !== 'off' ? state.camera.track : null;
  if (peer.cT.sender.track !== wantCam) await peer.cT.sender.replaceTrack(wantCam).catch(() => {});
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
      enc.scaleResolutionDownBy = Math.max(1, height / 720);
      enc.maxBitrate = s.bitrate * 1e6;
      enc.maxFramerate = Math.min(30, Number(s.fps));
    } else {
      enc.scaleResolutionDownBy = 1;
      enc.maxBitrate = s.bitrate * 1e6;
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

// ------------------------------------------------------------------ compartilhar
const RES = { 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };
let sources = [];
let selectedSource = null;
let sourceTab = 'screen';

// esconde opções que não fazem efeito no tipo de captura escolhido
function updateEngineFields() {
  const direct = $('#opt-engine').value === 'native-direct';
  $('#opt-codec').closest('.field').classList.toggle('hidden', direct); // direto é sempre H.264
}

async function openShareModal() {
  $('#share-modal').classList.remove('hidden');
  const s = state.settings;
  $('#opt-engine').value = s.engine || 'native';
  updateEngineFields();
  $('#opt-res').value = s.res;
  $('#opt-fps').value = String(s.fps);
  $('#opt-mode').value = s.mode;
  $('#opt-codec').value = s.codec;
  $('#opt-bitrate').value = s.bitrate;
  $('#opt-bitrate-label').textContent = `${s.bitrate} Mbps`;
  $('#btn-start-share').textContent = state.share ? 'Trocar' : 'Compartilhar';
  selectedSource = null;
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
    };
    el.ondblclick = () => startShare();
    box.appendChild(el);
  }
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
  const res = await window.Helper.list();
  if (res.type === 'list') {
    for (const a of res.apps) {
      if (a.discord) continue;
      add(`app:${a.pid}`, `Só: ${a.name}`);
    }
  }
  const saved = state.settings.audio;
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : 'all-except';
  $('#share-note').textContent = 'O som deste app (telas dos amigos) nunca é enviado de volta.';
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

// overrides: ex. { engine: 'chromium' } quando a captura nativa caiu várias vezes
let shareBusy = false;
async function startShare(overrides) {
  if (shareBusy || !selectedSource) return; // evita dois inícios ao mesmo tempo (duplo clique)
  shareBusy = true;
  try {
    await startShareInner(overrides && !(overrides instanceof Event) ? overrides : null);
  } finally {
    shareBusy = false;
  }
}

async function startShareInner(overrides) {
  const settings = { ...readSettings(), ...(overrides || {}) };
  const src = selectedSource;
  $('#btn-start-share').disabled = true;

  let [maxW, maxH] = RES[settings.res] || [3840, 2160];
  if (settings.res === 'native' && src.size) { maxW = src.size.width; maxH = src.size.height; }

  // para a captura anterior antes de começar a nova (o helper só tem um encoder)
  const old = state.share;
  if (old && old.native) await window.NativeVideo.stop();

  // native        = captura nativa 60 fps + WebRTC recodifica e se adapta à rede (padrão)
  // native-direct = envia o H.264 nativo direto (máxima qualidade, só para rede perfeita)
  const direct = settings.engine === 'native-direct';
  let stream, video, preview, nativeInfo = null;
  if (settings.engine.startsWith('native') && (await window.native.audioAvailable())) {
    try {
      // direto: começa no máximo; adaptNativeBitrate só reduz se a rede reclamar
      // adaptativo: o encoder do helper só alimenta a decodificação local -> qualidade alta fixa
      state.nativeKbps = settings.bitrate * 1000;
      baseRtt = Infinity;
      lastCut = 0;
      nativeInfo = await window.NativeVideo.start({
        sourceId: src.id, displayId: src.displayId, inject: direct,
        fps: settings.fps, kbps: direct ? state.nativeKbps : 50000, maxWidth: maxW, maxHeight: maxH,
      });
      video = nativeInfo.track;
      if (!direct) video.contentHint = settings.mode; // "Prioridade" vale também no modo adaptativo
      preview = nativeInfo.preview;
      stream = new MediaStream([video]);
    } catch (e) {
      toast(`Captura nativa falhou (${e.message}). Usando a captura do Chromium.`, 'error');
    }
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

  let audio = null;
  if (settings.audio !== 'none') {
    try {
      if (state.share && state.share.audio) await window.HelperAudio.stop();
      const [mode, pid] = settings.audio.startsWith('app:')
        ? ['app', Number(settings.audio.slice(4))]
        : ['all-except', 0];
      audio = await window.HelperAudio.start(mode, pid);
    } catch (e) {
      toast(`Áudio indisponível: ${e.message}`, 'error');
    }
  } else if (state.share && state.share.audio) {
    await window.HelperAudio.stop();
  }

  state.share = {
    stream, video, audio, settings, preview,
    sourceName: src.name,
    source: src,                         // para reiniciar a mesma tela se a captura cair
    native: !!nativeInfo,                // captura feita pelo helper
    direct: !!nativeInfo && direct,      // H.264 do helper vai direto para a rede
    width: nativeInfo ? nativeInfo.width : 0,
    height: nativeInfo ? nativeInfo.height : 0,
    encoder: nativeInfo ? nativeInfo.encoder : '',
  };
  state.nativeStats = null;
  if (old && !old.native) old.video.stop();

  if (!nativeInfo) video.onended = () => stopShare(); // janela fechada, etc.

  if (!state.order.includes('me')) state.order.unshift('me');
  $('#share-modal').classList.add('hidden');
  $('#btn-share').textContent = 'Trocar tela';
  state.lastSource = src; // Ctrl+Shift+S volta a transmitir esta tela
  window.Helper.gameWatch(true).catch(() => {}); // esconder a prévia quando estiver jogando
  $('#btn-stop').classList.remove('hidden');
  $('#btn-adjust').classList.remove('hidden');

  for (const peer of state.peers.values()) {
    applySendParams(peer); // ajusta codec/renegocia se precisar
    sendState(peer.id);
  }
  render();
}

// ------------------------------------------------------------------ bitrate adaptativo (modo nativo)
// O encoder nativo é um só para todos os amigos: segue o pior caminho.
// Começa no máximo escolhido; só reduz quando a rede reclama:
//  - perda de pacotes > 2% ou atraso (RTT) 80 ms acima do normal: corta 25% (no máx. a cada 2 s)
//  - rede limpa: volta a subir ~6% por segundo até o máximo
// (A estimativa de banda do WebRTC é conservadora demais pelo Radmin: só serve de informação.)
state.netInfo = { avail: null, loss: 0, rtt: null, nack: 0, pli: 0 };
let lastCut = 0, baseRtt = Infinity;
async function adaptNativeBitrate() {
  const share = state.share;
  if (!share || !share.direct || !state.nativeKbps) return;
  const max = share.settings.bitrate * 1000;
  let avail = Infinity, loss = 0, rtt = 0, nack = 0, pli = 0, any = false;
  for (const peer of state.peers.values()) {
    if (!peer.vT.sender.track || peer.pc.connectionState !== 'connected') continue;
    let report;
    try { report = await peer.pc.getStats(); } catch { continue; }
    any = true;
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.availableOutgoingBitrate) {
        avail = Math.min(avail, r.availableOutgoingBitrate / 1000);
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        loss = Math.max(loss, r.fractionLost || 0);
        rtt = Math.max(rtt, r.roundTripTime || 0);
      }
      if (r.type === 'outbound-rtp' && r.kind === 'video') { nack += r.nackCount || 0; pli += r.pliCount || 0; }
    });
  }
  if (!any) return;
  state.netInfo = { avail: isFinite(avail) ? avail : null, loss, rtt, nack, pli };

  if (rtt > 0) baseRtt = Math.min(baseRtt, rtt);
  const congested = loss > 0.02 || (rtt > 0 && isFinite(baseRtt) && rtt > baseRtt + 0.08);
  let target = state.nativeKbps;
  const now = performance.now();
  if (congested) {
    if (now - lastCut > 2000) { target = state.nativeKbps * 0.75; lastCut = now; }
  } else if (loss < 0.005 && now - lastCut > 3000) {
    target = state.nativeKbps * 1.06 + 200;
  }
  target = Math.round(Math.max(1500, Math.min(max, target)));
  if (target !== state.nativeKbps && (Math.abs(target - state.nativeKbps) / state.nativeKbps > 0.05 || target === max)) {
    state.nativeKbps = target;
    window.Helper.videoBitrate(target);
  }
}
setInterval(adaptNativeBitrate, 1000);

// Pedidos de keyframe reais (PLI/FIR) vindos de quem assiste: lidos das estatísticas do envio.
async function watchKeyRequests() {
  if (!state.share || !state.share.direct) return;
  for (const peer of state.peers.values()) {
    const sender = peer.vT.sender;
    if (!sender.track) continue;
    let report;
    try { report = await sender.getStats(); } catch { continue; }
    report.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      const n = (r.pliCount || 0) + (r.firCount || 0);
      if (peer.keyReqs != null && n > peer.keyReqs) window.Helper.videoKey();
      peer.keyReqs = n;
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
  $('#adj-bitrate-label').textContent = `${s.bitrate} Mbps`;
  $('#adj-res').value = s.res;
  $('#adj-fps').value = String(s.fps);
  $('#adj-mode').value = s.mode;
  $('#adj-engine').value = s.engine || 'native';
  panel.classList.remove('hidden');
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
  if (!state.share) return;
  $('#opt-res').value = $('#adj-res').value;
  $('#opt-fps').value = $('#adj-fps').value;
  $('#opt-mode').value = $('#adj-mode').value;
  $('#opt-engine').value = $('#adj-engine').value;
  $('#opt-bitrate').value = $('#adj-bitrate').value;
  if (state.share.audio) $('#opt-audio').value = state.settings.audio; // mantém o áudio como estava
  $('#adjust-panel').classList.add('hidden');
  selectedSource = state.share.source;
  await startShare();
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
  if (!system) {
    const b = document.createElement('b');
    b.style.color = `hsl(${nameHue(name)}, 70%, 65%)`;
    b.textContent = name;
    div.appendChild(b);
  }
  div.appendChild(document.createTextNode(text));
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
  e.textContent = emoji;
  const s = document.createElement('small');
  s.textContent = from;
  e.appendChild(s);
  tile.el.appendChild(e);
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
  tile.el.appendChild(c);
  tile.trail = c;
  tile.trailLines = [];
  const draw = () => {
    if (!c.isConnected) return;
    const r = tile.el.getBoundingClientRect();
    if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) { c.width = Math.round(r.width); c.height = Math.round(r.height); }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const now = performance.now();
    tile.trailLines = tile.trailLines.filter((s) => now - s.t < 2500);
    const b = videoBox(tile);
    for (const s of tile.trailLines) {
      g.globalAlpha = Math.max(0, 1 - (now - s.t) / 2500);
      g.strokeStyle = s.color;
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(b.left - r.left + s.x1 * b.width, b.top - r.top + s.y1 * b.height);
      g.lineTo(b.left - r.left + s.x2 * b.width, b.top - r.top + s.y2 * b.height);
      g.stroke();
    }
    if (tile.trailLines.length) requestAnimationFrame(draw); else tile.trailAnimating = false;
  };
  tile.trailDraw = () => { if (!tile.trailAnimating) { tile.trailAnimating = true; requestAnimationFrame(draw); } };
  return c;
}

function sendToMyDesktop(target, fromId) {
  return target === state.myId && fromId !== 'me' && state.share && state.share.source &&
    state.share.source.type === 'screen' && localStorage.getItem('laserDesk') !== '0';
}

function showLaser(target, fromId, name, x, y, drawing = false) {
  const color = `hsl(${nameHue(name)}, 85%, 55%)`;
  const tile = tileByOwner(target);
  if (tile && tile.el.isConnected) {
    tile.lasers = tile.lasers || {};
    let l = tile.lasers[fromId];
    if (!l) {
      l = document.createElement('div');
      l.className = 'hand';
      l.innerHTML = HAND_SVG;
      const tag = document.createElement('span');
      tag.textContent = name;
      l.appendChild(tag);
      tile.el.appendChild(l);
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
    const b = videoBox(tile), er = tile.el.getBoundingClientRect();
    l.style.left = `${b.left - er.left + x * b.width}px`;
    l.style.top = `${b.top - er.top + y * b.height}px`;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => hideLaser(target, fromId), 1500);
  }
  // apontaram para a MINHA tela: mostra também no meu monitor, por cima do jogo
  if (sendToMyDesktop(target, fromId)) {
    window.native.pointer({ displayId: state.share.source.displayId, id: fromId, x, y, color, name, drawing });
  }
}

// "apertar": a mão faz o gesto e sai uma ondinha no ponto
function showPress(target, fromId, name, x, y) {
  const color = `hsl(${nameHue(name)}, 85%, 55%)`;
  showLaser(target, fromId, name, x, y);
  const tile = tileByOwner(target);
  if (tile && tile.el.isConnected) {
    const l = tile.lasers && tile.lasers[fromId];
    if (l) { l.classList.remove('pressing'); void l.offsetWidth; l.classList.add('pressing'); }
    const b = videoBox(tile), er = tile.el.getBoundingClientRect();
    const r = document.createElement('div');
    r.className = 'press-ripple';
    r.style.setProperty('--c', color);
    r.style.left = `${b.left - er.left + x * b.width}px`;
    r.style.top = `${b.top - er.top + y * b.height}px`;
    tile.el.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }
  if (sendToMyDesktop(target, fromId)) {
    window.native.pointer({ displayId: state.share.source.displayId, id: fromId, x, y, color, name, press: true });
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

// liga reações e laser numa tela (de um amigo ou a sua)
function attachInteractions(tile, id) {
  const bar = document.createElement('div');
  bar.className = 'react-bar';
  for (const emoji of ['😂', '🔥', '👍', '😮', '💀', '❤️']) {
    const b = document.createElement('button');
    b.textContent = emoji;
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
    };
    // áudio do PC inteiro (Discord, jogo...) misturado com o som da transmissão
    if (localStorage.getItem('clipSys') !== '0' && (await window.native.audioAvailable())) {
      try {
        const mix = await window.ClipAudio.mixFor(stream);
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

// ------------------------------------------------------------------ sobreposição (por cima do jogo)
// Abre uma janelinha sempre por cima com a tela do amigo. A janela é do mesmo app, então
// recebe o próprio stream (sem decodificar de novo nem gastar banda extra).
const overlayWins = new Map(); // id do amigo -> janela
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
  if (state.share && state.peers.size) {
    let cpu = false;
    for (const peer of state.peers.values()) {
      if (!peer.vT.sender.track) continue;
      try {
        (await peer.vT.sender.getStats()).forEach((r) => {
          if (r.type === 'outbound-rtp' && r.qualityLimitationReason === 'cpu') cpu = true;
        });
      } catch {}
    }
    const ns = state.nativeStats;
    if (ns && state.share.native && ns.dropped > 6) cpu = true; // encoder do helper não dá conta
    const now = Date.now();
    if (cpu) { cpuStrikes++; cpuSeenAt = now; } else cpuStrikes = 0;
    if (!state.lightMode && cpuStrikes >= 2) {
      state.lightMode = true;
      toast('Seu PC está no limite: modo leve ligado (30 fps, até 720p) para não travar.');
      for (const peer of state.peers.values()) applySendParams(peer);
    } else if (state.lightMode && now - cpuSeenAt > 20000) {
      state.lightMode = false;
      toast('Modo leve desligado: qualidade normal de volta.');
      for (const peer of state.peers.values()) applySendParams(peer);
    }
    sendRelay(null, { kind: 'health', cpu: state.lightMode || cpu });
  }

  for (const peer of state.peers.values()) {
    if (!peer.sharing || !peer.tile || state.hidden.has(peer.id)) continue;
    let v = null, rtt = null;
    try {
      (await peer.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && (!v || (r.bytesReceived || 0) > (v.bytesReceived || 0))) v = r;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = r.currentRoundTripTime;
      });
    } catch { continue; }
    if (!v) continue;
    const prev = peer.qprev;
    peer.qprev = { lost: v.packetsLost || 0, recv: v.packetsReceived || 0, fz: v.freezeCount || 0 };
    if (!prev) continue;
    const lostD = Math.max(0, peer.qprev.lost - prev.lost), recvD = Math.max(0, peer.qprev.recv - prev.recv);
    const loss = lostD + recvD ? lostD / (lostD + recvD) : 0;
    const freezes = peer.qprev.fz - prev.fz;
    const fps = v.framesPerSecond || 0;
    const thumb = peer.iWant === 'thumb';
    const lowFps = thumb ? 12 : 40, badFps = thumb ? 5 : 15;
    let level = 'good', reason = 'tudo certo';
    if (peer.health && peer.health.cpu) { level = 'warn'; reason = `PC de ${peer.name} no limite (modo leve)`; }
    if (loss > 0.01 || (rtt && rtt > 0.12) || fps < lowFps || freezes >= 1) {
      level = 'warn';
      reason = loss > 0.01 ? `rede perdendo pacotes (${(loss * 100).toFixed(1)}%)`
        : rtt && rtt > 0.12 ? `atraso alto (${Math.round(rtt * 1000)} ms)`
          : freezes ? 'travando' : `poucos quadros (${Math.round(fps)} fps)`;
      if (peer.health && peer.health.cpu) reason = `PC de ${peer.name} no limite`;
    }
    if (loss > 0.05 || fps < badFps || freezes >= 2) level = 'bad';
    peer.quality = { level, reason };
    const dot = peer.tile.qdot;
    if (dot) { dot.className = `qdot ${level}`; dot.title = `Qualidade: ${reason}`; }
  }
}
setInterval(() => { healthLoop().catch(() => {}); }, 2000);

// eventos do AudioHelper (estatísticas e fim da captura nativa)
function onHelperEvent(msg) {
  if (msg.type === 'video-stats') state.nativeStats = msg;
  else if (msg.type === 'video-ended' && state.share && state.share.native) {
    toast('A janela compartilhada foi fechada.');
    stopShare();
  } else if (msg.type === 'video-warn') {
    toast(msg.message);
  } else if (msg.type === 'game-state') {
    const was = state.gaming;
    state.gaming = !!msg.playing;
    state.gamingExe = msg.exe || '';
    if (state.gaming !== was && state.share && localStorage.getItem('gamehide') !== '0') {
      toast(state.gaming
        ? 'Jogo em tela cheia: sua prévia foi escondida para economizar (a transmissão continua).'
        : 'Sua prévia voltou.');
    }
    render();
  } else if ((msg.type === 'video-error' || msg.type === 'helper-exit') && state.share && state.share.native) {
    recoverShare(msg.type === 'video-error' ? msg.message : 'o auxiliar de captura fechou');
  }
}

// A captura nativa parou (placa de vídeo reiniciada, helper caiu...): reinicia a mesma tela
// sozinho. Se cair 3 vezes em 1 minuto, passa para a captura do Chromium.
const recoverTimes = [];
let recovering = false;
async function recoverShare(reason) {
  if (recovering || !state.share) return;
  recovering = true;
  const now = Date.now();
  while (recoverTimes.length && now - recoverTimes[0] > 60000) recoverTimes.shift();
  recoverTimes.push(now);
  const tooMany = recoverTimes.length > 3;
  toast(tooMany
    ? `A captura nativa caiu de novo (${reason}). Usando a captura do Chromium.`
    : `A captura parou (${reason}). Reiniciando...`, 'error');
  const src = state.share.source;
  try {
    await new Promise((r) => setTimeout(r, 800));
    if (!state.share || !src) return;
    selectedSource = src;
    await startShare(tooMany ? { engine: 'chromium' } : undefined);
  } finally {
    recovering = false;
  }
}

async function stopShare() {
  const share = state.share;
  if (!share) return;
  state.share = null;
  share.video.onended = null;
  if (share.native) await window.NativeVideo.stop();
  else share.stream.getTracks().forEach((t) => t.stop());
  if (share.audio) await window.HelperAudio.stop();
  for (const peer of state.peers.values()) {
    applySendParams(peer);
    sendState(peer.id);
  }
  $('#btn-share').textContent = 'Compartilhar tela';
  window.Helper.gameWatch(false).catch(() => {});
  state.gaming = false;
  state.lightMode = false;
  $('#btn-stop').classList.add('hidden');
  $('#btn-adjust').classList.add('hidden');
  $('#adjust-panel').classList.add('hidden');
  render();
}

// ------------------------------------------------------------------ sala / UI
function enterRoom() {
  $('#lobby').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#btn-copy-ip').textContent = `Sala: ${state.hostIp}  (copiar)`;
  $('#btn-close-room').classList.toggle('hidden', !state.isHost);
  render();
  // aquece o AudioHelper e a captura para o "Compartilhar" abrir rápido
  window.native.audioAvailable().then((ok) => ok && window.Helper.list()).catch(() => {});
}

async function leaveRoom() {
  state.leaving = true;
  await stopShare();
  if (state.camera) { state.camera.track.stop(); state.camera = null; $('#btn-camera').textContent = 'Câmera'; $('#btn-camera').classList.remove('active'); }
  for (const id of [...state.peers.keys()]) removePeer(id);
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
  $('#btn-join').disabled = $('#btn-host').disabled = false;
  refreshMyRoom();
}

async function closeRoomForEveryone() {
  if (!confirm('Fechar a sala para todos? Quem estiver nela vai sair.')) return;
  await window.native.hostStop();
  await leaveRoom();
}

const ICONS = {
  focus: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" class="fill"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.5 7.5C4.3 9 3 12 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" class="fill"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 7.5L20 18M8.5 16.5L20 6"/></svg>',
  overlay: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="14" height="12" rx="2"/><rect x="9" y="3" width="13" height="10" rx="2" class="fill"/></svg>',
  corner: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="5" width="8" height="6" rx="1" class="fill"/></svg>',
};

function iconButton(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
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

  const tile = { el, video, label, stats: document.createElement('div') };
  tile.stats.className = 'tile-stats';
  // bolha da câmera (estilo streamer), aparece quando a pessoa transmite tela + câmera
  tile.camBox = document.createElement('div');
  tile.camBox.className = 'cam-pip hidden';
  tile.camVideo = document.createElement('video');
  tile.camVideo.autoplay = true;
  tile.camVideo.playsInline = true;
  tile.camVideo.muted = true;
  tile.camBox.appendChild(tile.camVideo);
  tile.camBox.title = 'Arraste para mover · rodinha muda o tamanho · duplo clique volta ao canto';
  tile.camKey = `campos:${isMe ? state.myName : ((state.peers.get(id) || {}).name || id)}`;
  attachCamDrag(tile);

  if (!isMe) {
    // volume lembrado pelo NOME do amigo (o id muda a cada vez que ele entra);
    // a tela sempre abre mutada, mas já no volume de antes
    const peerName = (state.peers.get(id) || {}).name || id;
    const volKey = `vol:${peerName}`;
    const volWrap = document.createElement('div');
    volWrap.className = 'vol';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01;
    vol.value = localStorage.getItem(volKey) ?? 1;
    const pct = document.createElement('span');
    pct.className = 'vol-pct';
    video.volume = Number(vol.value);
    const muteBtn = iconButton('mute', 'Ativar/desativar som', () => {
      video.muted = !video.muted;
      refresh();
    });
    const refresh = () => {
      muteBtn.innerHTML = video.muted ? ICONS.mute : ICONS.vol;
      pct.textContent = video.muted ? 'mudo' : `${Math.round(video.volume * 100)}%`;
      vol.value = video.volume;
    };
    tile.setVolume = (v) => {
      video.volume = Math.max(0, Math.min(1, v));
      video.muted = false;
      localStorage.setItem(volKey, String(video.volume));
      refresh();
    };
    vol.oninput = () => tile.setVolume(Number(vol.value));
    vol.onclick = (e) => e.stopPropagation();
    vol.ondblclick = (e) => e.stopPropagation();
    volWrap.append(muteBtn, vol, pct);
    tile.vol = volWrap;
    actions.appendChild(volWrap);
    refresh();

    // rodinha do mouse sobre a tela: volume de 5 em 5%
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      tile.setVolume(video.volume + (e.deltaY < 0 ? 0.05 : -0.05));
      showVolumeOverlay(el, video.volume);
    }, { passive: false });
  }
  actions.append(
    iconButton('focus', 'Focar nesta tela / voltar para a grade', () => toggleFocus(id)),
    iconButton('pip', 'Picture-in-picture (janela flutuante)', () => togglePip(id)),
    ...(isMe ? [] : [iconButton('overlay', 'Sobreposição: janelinha por cima do jogo', () => openOverlay(id))]),
    iconButton('rec', 'Replay: guarda os últimos 30 s desta tela para salvar um clipe', (b) => toggleReplay(id, b)),
    iconButton('clip', 'Salvar clipe dos últimos 30 s (Ctrl+Shift+C)', () => saveClip(id)),
    iconButton('full', 'Tela cheia (Esc sai)', () => toggleFullscreen(el)),
  );
  if (!isMe) {
    // bolinha de qualidade (verde/amarelo/vermelho) com o motivo ao passar o mouse
    tile.qdot = document.createElement('span');
    tile.qdot.className = 'qdot';
    tile.qdot.title = 'Qualidade: medindo...';
    el.appendChild(tile.qdot);
  }
  if (isMe) actions.append(iconButton('corner', 'Minimizar para o canto / colocar na grade', () => {
    state.meMini = !state.meMini;
    localStorage.setItem('meMini', state.meMini ? '1' : '0');
    render();
  }));
  actions.append(iconButton('hide', isMe ? 'Ocultar minha prévia' : 'Ocultar esta tela (para de receber)', () => hideTile(id)));
  bar.append(grip, label, actions);
  el.append(video, tile.camBox, tile.stats, bar);
  attachInteractions(tile, id);

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
  return tile;
}

// nome da tela com avatar e bolinha "ao vivo" (só refaz se mudou)
function setTileLabel(tile, name, text) {
  const key = `${name}|${text}`;
  if (tile.labelKey === key) return;
  tile.labelKey = key;
  tile.label.innerHTML = '';
  const t = document.createElement('span');
  t.textContent = text;
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
  o.textContent = `Volume ${Math.round(v * 100)}%`;
  o.classList.add('show');
  clearTimeout(o.timer);
  o.timer = setTimeout(() => o.classList.remove('show'), 900);
}

function getTile(id) {
  if (id === 'me') {
    if (!meTile) meTile = makeTile('me');
    updateTileMedia('me');
    const what = state.share ? state.share.sourceName : 'Câmera';
    setTileLabel(meTile, state.myName, `Você — ${what}`);
    return meTile;
  }
  const peer = state.peers.get(id);
  if (!peer.tile) peer.tile = makeTile(id);
  updateTileMedia(id);
  const what = peer.sharing ? peer.sourceName : 'Câmera';
  setTileLabel(peer.tile, peer.name, peer.name + (what ? ` — ${what}` : ''));
  peer.tile.vol.style.display = peer.hasAudio ? '' : 'none';
  return peer.tile;
}

// Tela + câmera: a tela ocupa tudo e a câmera fica numa bolha no canto (estilo streamer).
// Só câmera: a câmera ocupa a tela toda.
function updateTileMedia(id) {
  let tile, screen, cam, sharing, hasCam;
  if (id === 'me') {
    tile = meTile;
    sharing = !!state.share; hasCam = !!state.camera;
    screen = sharing ? state.share.preview : null;
    cam = hasCam ? state.camera.stream : null;
  } else {
    const p = state.peers.get(id);
    if (!p) return;
    tile = p.tile;
    sharing = !!p.sharing; hasCam = !!p.hasCam;
    screen = p.remoteStream;
    cam = p.camStream;
  }
  if (!tile) return;
  const main = sharing ? screen : cam;
  if (main && tile.video.srcObject !== main) tile.video.srcObject = main;
  const showBubble = sharing && hasCam;
  tile.camBox.classList.toggle('hidden', !showBubble);
  if (showBubble && tile.camVideo.srcObject !== cam) tile.camVideo.srcObject = cam;
  if (showBubble && tile.camVideo.paused) tile.camVideo.play().catch(() => {});
  if (showBubble) placeCamBubble(tile);
}

// Posição da câmera dentro da IMAGEM (não do quadro, que tem faixas pretas), em frações:
// x/y = canto superior esquerdo, w = largura. Cada um arruma do seu jeito; fica salvo por amigo.
const CAM_DEFAULT = { x: 0.74, y: 0.70, w: 0.24 };
function camPos(tile) {
  if (!tile.camPos) {
    try { tile.camPos = JSON.parse(localStorage.getItem(tile.camKey)) || { ...CAM_DEFAULT }; } catch { tile.camPos = { ...CAM_DEFAULT }; }
  }
  return tile.camPos;
}
// mantém a câmera inteira dentro da imagem
function clampCam(tile, p, b) {
  const hFrac = (p.w * b.width * 9 / 16) / b.height;
  p.w = Math.max(0.1, Math.min(0.5, p.w));
  p.x = Math.max(0, Math.min(1 - p.w, p.x));
  p.y = Math.max(0, Math.min(1 - hFrac, p.y));
  return p;
}
function placeCamBubble(tile) {
  if (!tile || tile.camBox.classList.contains('hidden') || !tile.el.isConnected) return;
  const b = videoBox(tile), er = tile.el.getBoundingClientRect();
  if (!b.width) return;
  const p = clampCam(tile, camPos(tile), b);
  const w = b.width * p.w;
  tile.camBox.style.width = `${w}px`;
  tile.camBox.style.left = `${b.left - er.left + p.x * b.width}px`;
  tile.camBox.style.top = `${b.top - er.top + p.y * b.height}px`;
  tile.camBox.style.right = 'auto';
  tile.camBox.style.bottom = 'auto';
}

// arrastar (botão esquerdo), redimensionar (rodinha), duplo clique volta ao padrão
function attachCamDrag(tile) {
  const box = tile.camBox;
  let drag = null;
  const save = () => localStorage.setItem(tile.camKey, JSON.stringify(tile.camPos));
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
    const p = camPos(tile);
    p.x = (e.clientX - drag.dx - b.left) / b.width;
    p.y = (e.clientY - drag.dy - b.top) / b.height;
    clampCam(tile, p, b);
    placeCamBubble(tile);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    box.classList.remove('dragging');
    // encaixa no canto se soltar perto da borda
    const b = videoBox(tile);
    const p = camPos(tile);
    const hFrac = (p.w * b.width * 9 / 16) / b.height;
    const m = 0.02, snap = 0.06;
    if (p.x < snap) p.x = m;
    if (1 - p.w - p.x < snap) p.x = 1 - p.w - m;
    if (p.y < snap) p.y = m * 2;
    if (1 - hFrac - p.y < snap) p.y = 1 - hFrac - m * 2;
    clampCam(tile, p, b);
    placeCamBubble(tile);
    save();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation(); // não mexe no volume da tela
    const b = videoBox(tile);
    const p = camPos(tile);
    const oldW = p.w;
    p.w = Math.max(0.1, Math.min(0.5, p.w + (e.deltaY < 0 ? 0.02 : -0.02)));
    p.x -= (p.w - oldW) / 2; // cresce a partir do centro
    clampCam(tile, p, b);
    placeCamBubble(tile);
    save();
  }, { passive: false });
  box.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    tile.camPos = { ...CAM_DEFAULT };
    placeCamBubble(tile);
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
async function toggleCamera() {
  if (state.camera) {
    state.camera.track.stop();
    state.camera = null;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      state.camera = { stream, track: stream.getVideoTracks()[0] };
      state.camera.track.contentHint = 'motion';
    } catch (e) {
      toast(`Não consegui abrir a câmera: ${e.message}`, 'error');
      return;
    }
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

function render() {
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
  } else {
    visible.forEach((id, i) => {
      const t = getTile(id);
      t.el.classList.remove('thumb');
      if (main.children[i] !== t.el) main.insertBefore(t.el, main.children[i] || null);
    });
    const r = main.getBoundingClientRect();
    main.style.gridTemplateColumns = `repeat(${bestColumns(Math.max(1, visible.length), r.width || 1, r.height || 1)}, 1fr)`;
  }
  for (const id of visible) {
    const t = getTile(id);
    t.el.classList.toggle('focused', focusMode && id === focus);
    t.el.classList.toggle('in-pip', state.pipId === id);
    if (t.video.paused) t.video.play().catch(() => {});
  }

  document.querySelectorAll('.layout-switch .seg').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  $('#btn-stats').classList.toggle('active', state.showStats);

  // diz a cada amigo em que qualidade quero receber a tela dele
  for (const peer of state.peers.values()) {
    let level = 'full';
    if (!peer.sharing || state.hidden.has(peer.id)) level = 'off';
    else if (focusMode && peer.id !== focus && state.pipId !== peer.id) level = 'thumb';
    if (peer.iWant !== level) {
      peer.iWant = level;
      sendRelay(peer.id, { kind: 'want', level });
    }
  }
  renderPeople();

  // status no ícone da bandeja (só manda quando muda)
  const tray = { room: state.hostIp || '', people: [...state.peers.values()].map((p) => p.name), sharing: !!state.share };
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

function renderPeople() {
  const ul = $('#people');
  ul.innerHTML = '';
  const row = (name, status, extra, avatarName) => {
    const li = document.createElement('li');
    const av = avatar(avatarName || name);
    const st = document.createElement('span');
    st.className = `status ${status}`;
    av.appendChild(st);
    const n = document.createElement('span');
    n.className = 'person-name';
    n.textContent = name;
    li.append(av, n);
    if (extra) li.appendChild(extra);
    ul.appendChild(li);
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
  row(`${state.myName} (você)`, 'connected', meExtra, state.myName);

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
    row(p.name, status, extra);
  }
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
    const codecs = new Map();
    const cands = new Map();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inV = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') outV = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { rtt = r.currentRoundTripTime; pair = r; }
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      if (r.type === 'codec') codecs.set(r.id, r.mimeType.split('/')[1]);
    });
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
      const bps = dt && prev.inBytes != null ? ((inV.bytesReceived - prev.inBytes) * 8) / dt : 0;
      const lost = inV.packetsLost || 0;
      // atraso do buffer de recepção (ms) e travadas detectadas pelo próprio WebRTC
      const jb = prev.jbEmitted != null && inV.jitterBufferEmittedCount > prev.jbEmitted
        ? ((inV.jitterBufferDelay - prev.jbDelay) / (inV.jitterBufferEmittedCount - prev.jbEmitted)) * 1000 : null;
      peer.tile.stats.textContent =
        `${inV.frameWidth || 0}x${inV.frameHeight || 0} @ ${Math.round(inV.framesPerSecond || 0)}fps · ` +
        `${fmtMbps(bps)} · ${codecs.get(inV.codecId) || '?'} · ping ${rtt != null ? Math.round(rtt * 1000) : '?'}ms · ` +
        `buffer ${jb != null ? Math.round(jb) : '?'}ms · travadas ${inV.freezeCount || 0} · perdidos ${lost} · ` +
        `NACK ${inV.nackCount || 0} · PLI ${inV.pliCount || 0} · keyframes ${inV.keyFramesDecoded || 0} · ` +
        `descartados ${inV.framesDropped || 0}\nrota ${route}` +
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
  const routes = [...state.peers.values()].filter((p) => p.route).map((p) => `\nrota ${p.name}: ${p.route}`).join('');
  if (meTile && state.share && state.share.direct) {
    const n = state.nativeStats;
    meTile.stats.textContent = n
      ? `Nativo · ${n.width}x${n.height} · captura ${n.captureFps}fps · enviado ${n.fps}fps · ${fmtMbps(n.kbps * 1000)} ` +
        `· encode ${n.encodeMs}ms · descartados ${n.dropped} · ${state.share.encoder} · ` +
        `p/ ${out.count} amigo(s), total ${fmtMbps(out.bytes)}\n` +
        `alvo ${fmtMbps((state.nativeKbps || 0) * 1000)} · banda estimada ${state.netInfo.avail ? fmtMbps(state.netInfo.avail * 1000) : '?'} · ` +
        `perda ${(state.netInfo.loss * 100).toFixed(1)}% · rtt ${state.netInfo.rtt ? Math.round(state.netInfo.rtt * 1000) : '?'}ms · ` +
        `NACK ${state.netInfo.nack} · PLI ${state.netInfo.pli} · keyframes ${n.keys}` + routes
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
}
setInterval(updateStats, 1000);

// ------------------------------------------------------------------ eventos de UI
function initRoomUi() {
  window.Helper.onEvent(onHelperEvent);
  $('#btn-share').onclick = openShareModal;
  $('#btn-stop').onclick = stopShare;
  $('#btn-leave').onclick = leaveRoom;
  $('#btn-close-room').onclick = closeRoomForEveryone;
  $('#btn-adjust').onclick = openAdjust;
  $('#btn-camera').onclick = toggleCamera;
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('#opt-clipsys').checked = localStorage.getItem('clipSys') !== '0';
  $('#opt-clipsys').onchange = () => localStorage.setItem('clipSys', $('#opt-clipsys').checked ? '1' : '0');
  $('#opt-laserdesk').checked = localStorage.getItem('laserDesk') !== '0';
  $('#opt-laserdesk').onchange = () => localStorage.setItem('laserDesk', $('#opt-laserdesk').checked ? '1' : '0');
  $('#btn-diag').onclick = () => saveDiagnostics().catch((e) => toast(`Falha no diagnóstico: ${e.message}`, 'error'));
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
  // teclas globais (funcionam com o jogo em primeiro plano)
  window.native.onHotkey((action) => {
    if ($('#room').classList.contains('hidden')) return;
    if (action === 'share') {
      if (state.share) stopShare();
      else if (state.lastSource) { selectedSource = state.lastSource; startShare(); }
      else { window.native.focusWindow(); openShareModal(); }
    } else if (action === 'mute') {
      const tiles = [...state.peers.values()].map((p) => p.tile).filter(Boolean);
      const anyOn = tiles.some((t) => !t.video.muted);
      for (const t of tiles) { t.video.muted = anyOn; if (t.vol) t.vol.querySelector('.icon-btn').innerHTML = anyOn ? ICONS.mute : ICONS.vol; }
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
  $('#adj-bitrate').oninput = () => { $('#adj-bitrate-label').textContent = `${$('#adj-bitrate').value} Mbps`; };
  $('#adj-bitrate').onchange = () => applyLiveBitrate(Number($('#adj-bitrate').value));
  $('#adj-apply').onclick = applyAdjust;
  $('#modal-close').onclick = () => $('#share-modal').classList.add('hidden');
  $('#share-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'share-modal') $('#share-modal').classList.add('hidden'); });
  $('#btn-start-share').onclick = startShare;
  $('#opt-bitrate').oninput = () => { $('#opt-bitrate-label').textContent = `${$('#opt-bitrate').value} Mbps`; };
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
  $('#btn-copy-ip').onclick = () => { window.native.copy(state.hostIp); toast('IP copiado. Mande para os amigos.'); };

  window.addEventListener('resize', () => render());
  window.addEventListener('keydown', (e) => {
    // Esc: no Electron a tela cheia NÃO sai sozinha com Esc (no Chrome sai)
    if (e.key === 'Escape') {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      if (!$('#adjust-panel').classList.contains('hidden')) { $('#adjust-panel').classList.add('hidden'); return; }
      if ($('#share-modal').classList.contains('hidden') && state.layout === 'focus') { state.layout = 'grid'; render(); return; }
    }
    if (e.target.matches('input, select, textarea') || $('#room').classList.contains('hidden')) return;
    if (!$('#share-modal').classList.contains('hidden')) {
      if (e.key === 'Escape') $('#share-modal').classList.add('hidden');
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'g') { state.layout = 'grid'; render(); }
    if (k === 'f') { state.layout = 'focus'; render(); }
    if (k === 's') $('#btn-stats').click();
  });
}

// ------------------------------------------------------------------ atualização automática
function initUpdates() {
  window.native.appVersion().then((v) => { $('#app-version').textContent = `v${v}`; });
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

initLobby();
initRoomUi();
initUpdates();
