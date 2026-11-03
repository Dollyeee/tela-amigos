// Servidor de vídeo (Cloudflare Realtime SFU), beta, só na sala online.
// Quem transmite manda UMA vez (em 3 qualidades: f = cheia, h = metade, q = um quarto) e o servidor
// repassa para cada amigo a qualidade que a conexão dele aguenta. Uma conexão WebRTC só com o
// servidor (separada das conexões diretas com os amigos). Cada operação da API vai pela sala
// online (o servidor da sala guarda a chave e confere que só se puxa transmissão de quem está nela).
window.Sfu = (() => {
  let sendFn = null;
  const pending = new Map(); // req -> { resolve, reject, timer }
  let nextReq = 1;
  let pc = null, sid = null;
  let queue = Promise.resolve();
  let pub = null;            // { vT, aT, info }
  const pulls = new Map();   // chave -> { mids, video, audio, videoRecv, videoMid, info }
  let lastBytes = 0;

  function setSender(fn) { sendFn = fn; }

  // respostas da sala ("sfu-res"); devolve true se a mensagem era daqui
  function onMessage(msg) {
    if (!msg || msg.type !== 'sfu-res') return false;
    const p = pending.get(msg.req);
    if (!p) return true;
    pending.delete(msg.req);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data || {}); else p.reject(new Error(msg.error || 'erro no servidor de vídeo'));
    return true;
  }

  function call(op, extra = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (!sendFn) { reject(new Error('fora da sala online')); return; }
      const req = nextReq++;
      const timer = setTimeout(() => { pending.delete(req); reject(new Error('servidor de vídeo não respondeu')); }, timeout);
      pending.set(req, { resolve, reject, timer });
      try { sendFn({ type: 'sfu', req, op, ...extra }); } catch (e) { clearTimeout(timer); pending.delete(req); reject(e); }
    });
  }

  // uma operação por vez (todas mexem na mesma conexão)
  function serial(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  function reset() {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('servidor de vídeo encerrado')); }
    pending.clear();
    try { pc && pc.close(); } catch {}
    pc = null; sid = null; pub = null; pulls.clear(); lastBytes = 0;
  }

  async function ensure() {
    if (pc && sid && !['failed', 'closed'].includes(pc.connectionState)) return;
    reset();
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    pc.onconnectionstatechange = () => {
      if (pc && pc.connectionState === 'failed') console.warn('servidor de vídeo: conexão falhou');
      if (window.Sfu.onState) window.Sfu.onState(pc ? pc.connectionState : 'closed');
    };
    const r = await call('new');
    sid = r.sessionId;
    if (r.usedGb != null) console.log(`servidor de vídeo: sessão nova (${r.usedGb} GB usados no mês)`);
  }

  const name = (k) => `${k}-${Math.random().toString(36).slice(2, 10)}`;

  function h264First(transceiver) {
    try {
      const caps = RTCRtpSender.getCapabilities('video').codecs;
      const h264 = caps.filter((c) => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || ''));
      const rest = caps.filter((c) => !h264.includes(c) && !/h265|av1/i.test(c.mimeType));
      if (h264.length) transceiver.setCodecPreferences([...h264, ...rest]);
    } catch (e) { console.warn('servidor de vídeo: codec', e); }
  }

  function encodings(kbps, fps) {
    return [
      { rid: 'f', maxBitrate: Math.round(kbps * 1000), maxFramerate: fps },
      { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: Math.round(Math.min(kbps * 0.35, 3000) * 1000), maxFramerate: fps },
      { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 600000, maxFramerate: Math.min(30, fps) },
    ];
  }

  // publica (ou troca) a minha transmissão; devolve { s, v, a } para os amigos puxarem
  function publish({ video, audio, kbps, fps }) {
    return serial(async () => {
      await ensure();
      // mesma forma (com/sem áudio): só troca as trilhas
      if (pub && !!pub.aT === !!audio) {
        await pub.vT.sender.replaceTrack(video);
        if (pub.aT) await pub.aT.sender.replaceTrack(audio);
        await setQualityInner(kbps, fps);
        return pub.info;
      }
      if (pub) await unpublishInner();
      const vT = pc.addTransceiver(video, { direction: 'sendonly', sendEncodings: encodings(kbps, fps) });
      h264First(vT);
      const aT = audio ? pc.addTransceiver(audio, { direction: 'sendonly' }) : null;
      await pc.setLocalDescription(await pc.createOffer());
      const names = { v: name('v'), a: aT ? name('a') : null };
      const tracks = [{ location: 'local', mid: vT.mid, trackName: names.v }];
      if (aT) tracks.push({ location: 'local', mid: aT.mid, trackName: names.a });
      const r = await call('tracks', { sid, body: { sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks } });
      for (const t of r.tracks || []) if (t.errorCode) throw new Error(t.errorDescription || t.errorCode);
      await pc.setRemoteDescription(r.sessionDescription);
      pub = { vT, aT, info: { s: sid, v: names.v, a: names.a } };
      return pub.info;
    });
  }

  async function setQualityInner(kbps, fps) {
    if (!pub) return;
    try {
      const p = pub.vT.sender.getParameters();
      const want = encodings(kbps, fps);
      (p.encodings || []).forEach((e, i) => { if (want[i]) { e.maxBitrate = want[i].maxBitrate; e.maxFramerate = want[i].maxFramerate; } });
      await pub.vT.sender.setParameters(p);
    } catch (e) { console.warn('servidor de vídeo: qualidade', e); }
  }
  function setQuality(kbps, fps) { return serial(() => setQualityInner(kbps, fps)); }

  async function unpublishInner() {
    if (!pub) return;
    const mids = [pub.vT.mid, pub.aT && pub.aT.mid].filter((m) => m != null);
    const old = pub;
    pub = null;
    try { if (mids.length && sid) await call('close', { sid, body: { tracks: mids.map((mid) => ({ mid })), force: true } }); } catch (e) { console.warn('servidor de vídeo: fechar', e.message); }
    try { old.vT.sender.replaceTrack(null); old.vT.stop(); } catch {}
    try { if (old.aT) { old.aT.sender.replaceTrack(null); old.aT.stop(); } } catch {}
  }
  function unpublish() { return serial(unpublishInner); }

  // puxa a transmissão de um amigo; rid = 'f' (cheia), 'h' ou 'q' (o servidor desce sozinho se precisar)
  function pull(key, info, rid = 'f') {
    return serial(async () => {
      await ensure();
      const simulcast = { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' };
      const tracks = [{ location: 'remote', sessionId: info.s, trackName: info.v, simulcast }];
      if (info.a) tracks.push({ location: 'remote', sessionId: info.s, trackName: info.a });
      const r = await call('tracks', { sid, body: { tracks } });
      for (const t of r.tracks || []) if (t.errorCode) throw new Error(t.errorDescription || t.errorCode);
      if (r.requiresImmediateRenegotiation) {
        await pc.setRemoteDescription(r.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        await call('renegotiate', { sid, body: { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } } });
      }
      const res = { mids: [], video: null, audio: null, videoRecv: null, videoMid: null, info, rid };
      for (const t of r.tracks || []) {
        const tr = pc.getTransceivers().find((x) => x.mid === String(t.mid));
        if (!tr) continue;
        res.mids.push(String(t.mid));
        if (tr.receiver.track.kind === 'video') { res.video = tr.receiver.track; res.videoRecv = tr.receiver; res.videoMid = String(t.mid); }
        else res.audio = tr.receiver.track;
      }
      if (!res.video) throw new Error('o servidor não mandou o vídeo');
      pulls.set(key, res);
      return res;
    });
  }

  function setRid(key, rid) {
    return serial(async () => {
      const p = pulls.get(key);
      if (!p || p.rid === rid || !sid) return;
      await call('update', { sid, body: { tracks: [{ location: 'remote', mid: p.videoMid, sessionId: p.info.s, trackName: p.info.v,
        simulcast: { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } }] } });
      p.rid = rid;
    });
  }

  function unpull(key) {
    return serial(async () => {
      const p = pulls.get(key);
      if (!p) return;
      pulls.delete(key);
      try { if (sid && p.mids.length) await call('close', { sid, body: { tracks: p.mids.map((mid) => ({ mid })), force: true } }); } catch (e) { console.warn('servidor de vídeo: parar de puxar', e.message); }
    });
  }

  // GB recebidos do servidor (o servidor da sala soma e respeita o limite grátis do mês)
  async function reportUsage() {
    if (!pc || !sendFn) return;
    let total = 0;
    try { (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') total += r.bytesReceived || 0; }); } catch { return; }
    const d = total - lastBytes;
    lastBytes = total;
    if (d > 0) { try { sendFn({ type: 'sfu-usage', bytes: d }); } catch {} }
  }
  setInterval(() => { reportUsage().catch(() => {}); }, 60000);

  return {
    setSender, onMessage, publish, unpublish, setQuality, pull, unpull, setRid, reset,
    published: () => (pub ? pub.info : null),
    state: () => (pc ? pc.connectionState : 'sem conexão'),
    onState: null,
  };
})();
