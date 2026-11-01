// Cliente do AudioHelper: fala direto com o processo utilitário por um MessagePort
// (vídeo/áudio não passam pelo processo principal do app).
window.Helper = (() => {
  let port = null;
  let nextId = 1;
  const pending = new Map(); // id -> { expect, resolve, timer }
  const queue = [];          // comandos enviados antes do canal existir
  let onPcm = null, onVideo = null, onSys = null;
  const eventListeners = [];

  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__helperPort || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onMessage;
    for (const m of queue.splice(0)) port.postMessage(m);
  });

  function settle(id, msg) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  function onMessage(e) {
    const m = e.data;
    if (m.t === 'pcm') { if (onPcm) onPcm(m.d); return; }
    if (m.t === 'video') { if (onVideo) onVideo(m.d); return; }
    if (m.t === 'sys') { if (onSys) onSys(m.d); return; }
    if (m.t !== 'event') return;
    const msg = m.msg;
    if (msg.id != null && pending.has(msg.id)) settle(msg.id, msg);
    else if (msg.id == null) {
      // helper antigo (sem id): responde ao pedido mais antigo que espera este tipo
      for (const [id, p] of pending) {
        if (p.expect === msg.type || msg.type === 'error') { settle(id, msg); break; }
      }
    }
    if (msg.type === 'helper-exit' || msg.type === 'helper-error') {
      for (const id of [...pending.keys()]) settle(id, { type: 'error', message: 'o AudioHelper fechou' });
    }
    for (const f of eventListeners) { try { f(msg); } catch (err) { console.warn(err); } }
  }

  function send(cmd) {
    const m = { t: 'cmd', cmd };
    if (port) port.postMessage(m); else queue.push(m);
  }

  function request(cmd, expect, timeout = 10000) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ type: 'error', message: 'Sem resposta do AudioHelper' });
      }, timeout);
      pending.set(id, { expect, resolve, timer });
      send({ ...cmd, id });
    });
  }

  return {
    list: () => request({ cmd: 'list' }, 'list'),
    audioStart: (mode, pid) => request({ cmd: 'start', mode, pid }, 'started'),
    audioStop: () => request({ cmd: 'stop' }, 'stopped'),
    async videoStart(opts) {
      const target = await window.native.videoTarget({ sourceId: opts.sourceId, displayId: opts.displayId });
      return request({
        cmd: 'video-start', target, fps: opts.fps, kbps: opts.kbps, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight,
      }, 'video-started', 15000);
    },
    videoStop: () => request({ cmd: 'video-stop' }, 'video-stopped'),
    videoKey: () => send({ cmd: 'video-key' }),
    diag: () => request({ cmd: 'video-diag' }, 'video-diag', 8000),
    gameWatch: (on) => request({ cmd: 'game-watch', on }, 'game-watch'),
    videoBitrate: (kbps) => send({ cmd: 'video-bitrate', kbps }),
    sysStart: () => request({ cmd: 'sysaudio-start' }, 'sysaudio-started'),
    sysStop: () => request({ cmd: 'sysaudio-stop' }, 'sysaudio-stopped'),
    onSys: (cb) => { onSys = cb; },
    onPcm: (cb) => { onPcm = cb; },
    onVideo: (cb) => { onVideo = cb; },
    onEvent: (cb) => { eventListeners.push(cb); },
  };
})();
