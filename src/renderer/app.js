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
  setTimeout(() => el.classList.add('out'), 3500);
  setTimeout(() => el.remove(), 4000);
}

function fmtMbps(bps) { return `${(bps / 1e6).toFixed(1)} Mb/s`; }

function saveSettings() {
  localStorage.setItem('settings', JSON.stringify(state.settings));
}
function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem('settings') || '{}')); } catch {}
}

// ------------------------------------------------------------------ lobby
async function initLobby() {
  loadSettings();
  $('#name').value = localStorage.getItem('name') || '';
  $('#host-ip').value = localStorage.getItem('hostIp') || '';

  $('#btn-host').onclick = async () => {
    if (!checkName()) return;
    const res = await window.native.hostStart();
    if (!res.ok) return showLobbyError(res.error);
    const info = await window.native.netInfo();
    const radmin = info.ips.find((x) => x.radmin) || info.ips[0];
    state.hostIp = radmin ? radmin.ip : '127.0.0.1';
    connect('127.0.0.1', true);
  };

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
function connect(ip, isHost) {
  showLobbyError('');
  $('#btn-join').disabled = $('#btn-host').disabled = true;
  const ws = new WebSocket(`ws://${ip}:${SIGNAL_PORT}`);
  state.ws = ws;
  let opened = false;
  const timeout = setTimeout(() => { if (!opened) ws.close(); }, 6000);

  ws.onopen = () => {
    opened = true;
    clearTimeout(timeout);
    ws.send(JSON.stringify({ type: 'join', name: state.myName }));
  };
  ws.onmessage = (e) => onSignal(JSON.parse(e.data));
  ws.onclose = () => {
    clearTimeout(timeout);
    $('#btn-join').disabled = $('#btn-host').disabled = false;
    if (!opened) {
      if (isHost) window.native.hostStop();
      showLobbyError(`Não consegui conectar em ${ip}. Confira se o IP está certo, se a pessoa clicou em "Hospedar" e se o Radmin está conectado.`);
      return;
    }
    if (!state.leaving) {
      toast('Conexão com a sala perdida.', 'error');
      leaveRoom();
    }
  };
}

function sendRelay(to, data) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'relay', to, data }));
}

function onSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.id;
      enterRoom();
      for (const p of msg.peers) createPeer(p.id, p.name);
      break;
    case 'peer-joined':
      createPeer(msg.id, msg.name);
      toast(`${msg.name} entrou na sala`);
      break;
    case 'peer-left': {
      const p = state.peers.get(msg.id);
      if (p) toast(`${p.name} saiu`);
      removePeer(msg.id);
      break;
    }
    case 'relay':
      onRelay(msg.from, msg.data);
      break;
  }
}

function onRelay(from, data) {
  const peer = state.peers.get(from);
  if (!peer) return;
  switch (data.kind) {
    case 'sdp': handleDescription(peer, data.description); break;
    case 'ice': handleCandidate(peer, data.candidate); break;
    case 'state':
      {
        const was = peer.sharing;
        peer.sharing = data.sharing;
        peer.hasAudio = data.audio;
        peer.sourceName = data.sourceName || '';
        if (data.sharing && !was) {
          toast(`${peer.name} começou a compartilhar`);
          if (!state.order.includes(peer.id)) state.order.push(peer.id);
        }
        render();
      }
      break;
    case 'want':
      peer.theyWant = data.level;
      applySendParams(peer);
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
  peer.vT = pc.addTransceiver('video', {
    direction: 'sendonly',
    sendEncodings: [{ maxBitrate: s.bitrate * 1e6, maxFramerate: Number(s.fps) }],
  });
  peer.aT = pc.addTransceiver('audio', { direction: 'sendonly' });
  setCodec(peer, state.share && state.share.native ? 'native' : s.codec);
  // transform ligado desde o início (antes de negociar); fica em "deixa passar" até o modo nativo
  window.NativeVideo.attach(peer.vT.sender, id);

  pc.onnegotiationneeded = () => negotiate(peer);
  pc.onicecandidate = ({ candidate }) => { if (candidate) sendRelay(id, { kind: 'ice', candidate }); };
  pc.ontrack = (e) => {
    const st = peer.remoteStream;
    for (const t of st.getTracks()) if (t.kind === e.track.kind) st.removeTrack(t);
    st.addTrack(e.track);
    if (peer.tile) peer.tile.video.srcObject = st;
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
  try {
    peer.makingOffer = true;
    const offer = await pc.createOffer();
    if (pc.signalingState !== 'stable') return;
    offer.sdp = window.Sdp.munge(offer.sdp, { videoKbps: state.settings.bitrate * 1000, native: !!(state.share && state.share.native) });
    await pc.setLocalDescription(offer);
    sendRelay(peer.id, { kind: 'sdp', description: pc.localDescription });
  } catch (e) {
    console.error('negotiate', e);
  } finally {
    peer.makingOffer = false;
  }
}

async function handleDescription(peer, description) {
  const pc = peer.pc;
  try {
    const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    // os limites de bitrate/est�reo que EU uso para enviar v�m da descri��o remota
    await pc.setRemoteDescription({
      type: description.type,
      sdp: window.Sdp.munge(description.sdp, {
        videoKbps: state.settings.bitrate * 1000,
        native: !!(state.share && state.share.native),
      }),
    });
    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      answer.sdp = window.Sdp.munge(answer.sdp, { videoKbps: state.settings.bitrate * 1000, native: !!(state.share && state.share.native) });
      await pc.setLocalDescription(answer);
      sendRelay(peer.id, { kind: 'sdp', description: pc.localDescription });
    }
  } catch (e) {
    console.error('sdp', e);
  }
}

async function handleCandidate(peer, candidate) {
  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (e) {
    if (!peer.ignoreOffer) console.warn('ice', e);
  }
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  window.NativeVideo.remove(id);
  if (peer.tile) peer.tile.el.remove();
  state.peers.delete(id);
  state.order = state.order.filter((x) => x !== id);
  state.hidden.delete(id);
  if (state.focusId === id) state.focusId = null;
  render();
}

function sendState(to) {
  sendRelay(to, {
    kind: 'state',
    sharing: !!state.share,
    audio: !!(state.share && state.share.audio),
    sourceName: state.share ? state.share.sourceName : '',
  });
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
  const native = !!(share && share.native);
  const codecMode = native ? 'native' : state.settings.codec;
  if (peer.codecMode !== codecMode) {
    setCodec(peer, codecMode);
    negotiate(peer);
  }
  // antes de trocar a trilha: assim o primeiro quadro já é tratado no modo certo
  window.NativeVideo.setMode(peer.id, native, !!wantVideo && peer.pc.connectionState === 'connected');
  if (vSender.track !== wantVideo) await vSender.replaceTrack(wantVideo).catch(() => {});
  if (aSender.track !== wantAudio) await aSender.replaceTrack(wantAudio).catch(() => {});
  if (!share) return;

  const s = share.settings;
  const height = native ? share.height : share.video.getSettings().height || 1080;
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

async function openShareModal() {
  $('#share-modal').classList.remove('hidden');
  const s = state.settings;
  $('#opt-engine').value = s.engine || 'native';
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
  await Promise.all([loadSources('screen'), loadSources('window'), loadAudioOptions()]);
}

let sourcesLoaded = { screen: false, window: false };
async function loadSources(type) {
  const list = await window.native.captureSources(type);
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
    const img = document.createElement('div');
    img.className = 'source-thumb';
    if (src.thumbnail) img.style.backgroundImage = `url("${src.thumbnail}")`;
    const label = document.createElement('div');
    label.className = 'source-name';
    if (src.icon) {
      const ic = document.createElement('img');
      ic.src = src.icon;
      label.appendChild(ic);
    }
    label.appendChild(document.createTextNode(src.name));
    el.append(img, label);
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
  const res = await window.native.audioList();
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

async function startShare() {
  if (!selectedSource) return;
  const settings = readSettings();
  const src = selectedSource;
  $('#btn-start-share').disabled = true;

  let [maxW, maxH] = RES[settings.res] || [3840, 2160];
  if (settings.res === 'native' && src.size) { maxW = src.size.width; maxH = src.size.height; }

  // para a captura anterior antes de começar a nova (o helper só tem um encoder)
  const old = state.share;
  if (old && old.native) await window.NativeVideo.stop();

  let stream, video, preview, nativeInfo = null;
  if (settings.engine === 'native' && (await window.native.audioAvailable())) {
    try {
      nativeInfo = await window.NativeVideo.start({
        sourceId: src.id, displayId: src.displayId,
        fps: settings.fps, kbps: settings.bitrate * 1000, maxWidth: maxW, maxHeight: maxH,
      });
      video = nativeInfo.track;
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
    native: !!nativeInfo,
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
  $('#btn-stop').classList.remove('hidden');

  for (const peer of state.peers.values()) {
    applySendParams(peer); // ajusta codec/renegocia se precisar
    sendState(peer.id);
  }
  render();
}

// eventos do AudioHelper (estatísticas e fim da captura nativa)
function onHelperEvent(msg) {
  if (msg.type === 'video-stats') state.nativeStats = msg;
  else if (msg.type === 'video-ended' && state.share && state.share.native) {
    toast('A janela compartilhada foi fechada.');
    stopShare();
  } else if (msg.type === 'video-error') {
    toast(`Erro na captura: ${msg.message}`, 'error');
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
  $('#btn-stop').classList.add('hidden');
  render();
}

// ------------------------------------------------------------------ sala / UI
function enterRoom() {
  $('#lobby').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#btn-copy-ip').textContent = `Sala: ${state.hostIp}  (copiar)`;
  render();
  // aquece o AudioHelper e a captura para o "Compartilhar" abrir rápido
  window.native.audioAvailable().then((ok) => ok && window.native.audioList()).catch(() => {});
  window.native.captureSources('window').catch(() => {});
}

async function leaveRoom() {
  state.leaving = true;
  await stopShare();
  for (const id of [...state.peers.keys()]) removePeer(id);
  if (state.ws) state.ws.close();
  await window.native.hostStop();
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
}

const ICONS = {
  focus: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" class="fill"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.5 7.5C4.3 9 3 12 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
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
  video.muted = isMe;

  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  bar.draggable = true;
  const label = document.createElement('span');
  label.className = 'tile-name';
  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  const tile = { el, video, label, stats: document.createElement('div') };
  tile.stats.className = 'tile-stats';

  if (!isMe) {
    const volWrap = document.createElement('div');
    volWrap.className = 'vol';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01;
    vol.value = localStorage.getItem(`vol:${id}`) ?? 1;
    video.volume = Number(vol.value);
    vol.oninput = () => { video.volume = Number(vol.value); video.muted = false; muteBtn.innerHTML = ICONS.vol; };
    vol.onclick = (e) => e.stopPropagation();
    const muteBtn = iconButton('vol', 'Mutar', () => {
      video.muted = !video.muted;
      muteBtn.innerHTML = video.muted ? ICONS.mute : ICONS.vol;
    });
    volWrap.append(muteBtn, vol);
    tile.vol = volWrap;
    actions.appendChild(volWrap);
  }
  actions.append(
    iconButton('focus', 'Focar nesta tela', () => setFocus(id)),
    iconButton('pip', 'Picture-in-picture (janela flutuante)', () => togglePip(id)),
    iconButton('full', 'Tela cheia', () => el.requestFullscreen().catch(() => {})),
    iconButton('hide', isMe ? 'Ocultar minha prévia' : 'Ocultar esta tela (para de receber)', () => hideTile(id)),
  );
  bar.append(label, actions);
  el.append(video, tile.stats, bar);

  el.ondblclick = () => {
    if (state.layout === 'focus' && state.focusId === id) el.requestFullscreen().catch(() => {});
    else setFocus(id);
  };
  el.onclick = () => {
    if (state.layout === 'focus' && state.focusId !== id) setFocus(id);
  };

  // arrastar para reorganizar
  bar.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tile', id);
    el.classList.add('dragging');
  });
  bar.addEventListener('dragend', () => el.classList.remove('dragging'));
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

function getTile(id) {
  if (id === 'me') {
    if (!meTile) meTile = makeTile('me');
    if (state.share && meTile.video.srcObject !== state.share.preview) meTile.video.srcObject = state.share.preview;
    meTile.label.textContent = `Você — ${state.share ? state.share.sourceName : ''}`;
    return meTile;
  }
  const peer = state.peers.get(id);
  if (!peer.tile) {
    peer.tile = makeTile(id);
    peer.tile.video.srcObject = peer.remoteStream;
  }
  peer.tile.label.textContent = peer.name + (peer.sourceName ? ` — ${peer.sourceName}` : '');
  peer.tile.vol.style.display = peer.hasAudio ? '' : 'none';
  return peer.tile;
}

function isSharing(id) {
  if (id === 'me') return !!state.share;
  const p = state.peers.get(id);
  return !!(p && p.sharing);
}

function setFocus(id) {
  state.layout = 'focus';
  state.focusId = id;
  render();
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

  const visible = state.order.filter((id) => isSharing(id) && !state.hidden.has(id));
  const stage = $('#stage');
  const main = $('#stage-main');
  const strip = $('#stage-strip');

  // tiles que não devem aparecer saem do DOM (exceto se estiverem em PiP)
  const all = [meTile, ...[...state.peers.values()].map((p) => p.tile)].filter(Boolean);
  for (const t of all) {
    const id = t.el.dataset.id;
    if (!visible.includes(id) && state.pipId !== id) t.el.remove();
  }

  $('#empty').style.display = visible.length ? 'none' : '';
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
}

function renderPeople() {
  const ul = $('#people');
  ul.innerHTML = '';
  const row = (name, status, extra) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${status}`;
    const n = document.createElement('span');
    n.className = 'person-name';
    n.textContent = name;
    li.append(dot, n);
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
  row(`${state.myName} (você)`, 'connected', meExtra);

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
    if (status !== 'connected') extra.appendChild(tag(status === 'failed' ? 'falhou' : 'conectando'));
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
    let inV = null, outV = null, rtt = null;
    const codecs = new Map();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inV = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') outV = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = r.currentRoundTripTime;
      if (r.type === 'codec') codecs.set(r.id, r.mimeType.split('/')[1]);
    });
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
        `buffer ${jb != null ? Math.round(jb) : '?'}ms · travadas ${inV.freezeCount || 0} · perdidos ${lost}` +
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
  if (meTile && state.share && state.share.native) {
    const n = state.nativeStats;
    meTile.stats.textContent = n
      ? `Nativo · ${n.width}x${n.height} · captura ${n.captureFps}fps · enviado ${n.fps}fps · ${fmtMbps(n.kbps * 1000)} ` +
        `· encode ${n.encodeMs}ms · descartados ${n.dropped} · ${state.share.encoder} · ` +
        `p/ ${out.count} amigo(s), total ${fmtMbps(out.bytes)}`
      : 'Iniciando captura nativa...';
  } else if (meTile && state.share) {
    const LIMIT = { bandwidth: 'internet', cpu: 'processador', other: 'outro' };
    meTile.stats.textContent = out.count
      ? `Enviando p/ ${out.count} · ${out.w}x${out.h} @ ${Math.round(out.fps)}fps · total ${fmtMbps(out.bytes)} · ` +
        `limitação: ${out.limit ? LIMIT[out.limit] || out.limit : 'nenhuma'} · ` +
        `encoder ${out.enc || '?'}${out.hw === true ? ' (placa de vídeo)' : out.hw === false ? ' (CPU)' : ''}`
      : 'Ninguém recebendo sua tela no momento';
  }
}
setInterval(updateStats, 1000);

// ------------------------------------------------------------------ eventos de UI
function initRoomUi() {
  window.native.onHelperEvent(onHelperEvent);
  $('#btn-share').onclick = openShareModal;
  $('#btn-stop').onclick = stopShare;
  $('#btn-leave').onclick = leaveRoom;
  $('#modal-close').onclick = () => $('#share-modal').classList.add('hidden');
  $('#share-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'share-modal') $('#share-modal').classList.add('hidden'); });
  $('#btn-start-share').onclick = startShare;
  $('#opt-bitrate').oninput = () => { $('#opt-bitrate-label').textContent = `${$('#opt-bitrate').value} Mbps`; };
  document.querySelectorAll('.tabs .seg').forEach((b) => {
    b.onclick = () => {
      sourceTab = b.dataset.tab;
      document.querySelectorAll('.tabs .seg').forEach((x) => x.classList.toggle('active', x === b));
      renderSources();
    };
  });
  document.querySelectorAll('.layout-switch .seg').forEach((b) => {
    b.onclick = () => { state.layout = b.dataset.layout; render(); };
  });
  $('#btn-stats').onclick = () => { state.showStats = !state.showStats; render(); updateStats(); };
  $('#btn-copy-ip').onclick = () => { window.native.copy(state.hostIp); toast('IP copiado. Mande para os amigos.'); };

  window.addEventListener('resize', () => render());
  window.addEventListener('keydown', (e) => {
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
