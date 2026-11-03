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
  // "Nativa direta" pelo servidor (como o Discord): a placa de vídeo comprime UMA vez e o servidor
  // repassa a mesma imagem para todos. A trilha é a "vazia" da nativa direta; o transform troca
  // cada quadro pelo da placa. Sem simulcast (não dá para dividir o que a placa já comprimiu).
  function nativeEncodings(kbps) {
    return [{ maxBitrate: Math.round(kbps * 1500), maxFramerate: 240, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' }];
  }
  function nativeCodecPrefs(codec) {
    const S = window.Sdp;
    return codec === 'hevc' ? S.h265OnlyPreferences() : codec === 'av1' ? S.av1OnlyPreferences() : S.h264OnlyPreferences();
  }
  // som estéreo de música e bitrate inicial alto (igual à conexão direta); vale para o que EU envio
  function mungeAnswer(desc, kbps, native) {
    try { return { type: desc.type, sdp: window.Sdp.munge(desc.sdp, { videoKbps: kbps, native }) }; } catch { return desc; }
  }

  // publica (ou troca) a minha transmissão; devolve { s, v, a, n } para os amigos puxarem
  // native = null (encoder do Chromium, 3 qualidades) ou { codec, attach(sender) } (placa de vídeo)
  function publish({ video, audio, kbps, fps, native = null }) {
    return serial(async () => {
      await ensure();
      const mode = native ? `native:${native.codec}` : 'simulcast';
      // mesma forma (com/sem áudio, mesmo modo): só troca as trilhas
      if (pub && !!pub.aT === !!audio && pub.mode === mode) {
        if (pub.vT.sender.track !== video) await pub.vT.sender.replaceTrack(video);
        if (pub.aT && pub.aT.sender.track !== audio) await pub.aT.sender.replaceTrack(audio);
        await setQualityInner(kbps, fps);
        return pub.info;
      }
      if (pub) await unpublishInner();
      const vT = pc.addTransceiver(video, { direction: 'sendonly', sendEncodings: native ? nativeEncodings(kbps) : encodings(kbps, fps) });
      if (native) {
        native.attach(vT.sender); // antes da negociação: depois o Chromium ignora o transform
        const prefs = nativeCodecPrefs(native.codec);
        if (!prefs) throw new Error(`codec ${native.codec} indisponível`);
        vT.setCodecPreferences(prefs);
      } else h264First(vT);
      const aT = audio ? pc.addTransceiver(audio, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 256000, priority: 'high' }] }) : null;
      await pc.setLocalDescription(await pc.createOffer());
      const names = { v: name('v'), a: aT ? name('a') : null };
      const tracks = [{ location: 'local', mid: vT.mid, trackName: names.v }];
      if (aT) tracks.push({ location: 'local', mid: aT.mid, trackName: names.a });
      const r = await call('tracks', { sid, body: { sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks } });
      for (const t of r.tracks || []) if (t.errorCode) throw new Error(t.errorDescription || t.errorCode);
      // simulcast: o teto do Chromium vale para a soma das 3 qualidades
      const total = native ? kbps : kbps + Math.min(kbps * 0.35, 3000) + 600;
      await pc.setRemoteDescription(mungeAnswer(r.sessionDescription, total, !!native));
      try {
        const p = vT.sender.getParameters();
        // nativa: a trilha vazia nunca pode ser descartada; Chromium: sem isso, com a "Imagem lisa"
        // ele só baixa a resolução quando aperta (fica lisa mas borrada)
        p.degradationPreference = native ? 'maintain-framerate' : 'balanced';
        await vT.sender.setParameters(p);
      } catch {}
      pub = { vT, aT, mode, info: { s: sid, v: names.v, a: names.a, n: native ? 1 : 3 } };
      return pub.info;
    });
  }

  async function setQualityInner(kbps, fps) {
    if (!pub) return;
    try {
      const p = pub.vT.sender.getParameters();
      const want = pub.mode === 'simulcast' ? encodings(kbps, fps) : nativeEncodings(kbps);
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

  // O servidor manda a qualidade pedida. Com priorityOrdering 'asciibetical' ele mesmo descia de
  // qualidade e subia muito devagar (pedia a cheia e chegava 640x360 por vários segundos): quem desce
  // agora é o app, pela perda/travadas medidas aqui (sfuRxFeedback no app.js). Se quem transmite
  // parar de mandar a qualidade pedida, o servidor usa a próxima disponível.
  const simulcastOpts = (rid) => ({ preferredRid: rid, priorityOrdering: 'none', ridNotAvailable: 'asciibetical' });

  // puxa a transmissão de um amigo; rid = 'f' (cheia), 'h' ou 'q' (o servidor desce sozinho se precisar)
  function pull(key, info, rid = 'f') {
    return serial(async () => {
      await ensure();
      const one = info.n === 1; // transmissão da placa de vídeo: uma qualidade só
      const simulcast = simulcastOpts(rid);
      const tracks = [{ location: 'remote', sessionId: info.s, trackName: info.v, ...(one ? {} : { simulcast }) }];
      if (info.a) tracks.push({ location: 'remote', sessionId: info.s, trackName: info.a });
      const r = await call('tracks', { sid, body: { tracks } });
      for (const t of r.tracks || []) if (t.errorCode) throw new Error(t.errorDescription || t.errorCode);
      if (r.requiresImmediateRenegotiation) {
        await pc.setRemoteDescription(r.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        await call('renegotiate', { sid, body: { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } } });
      }
      const res = { mids: [], video: null, audio: null, videoRecv: null, audioRecv: null, videoMid: null, info, rid: one ? null : rid };
      for (const t of r.tracks || []) {
        const tr = pc.getTransceivers().find((x) => x.mid === String(t.mid));
        if (!tr) continue;
        res.mids.push(String(t.mid));
        if (tr.receiver.track.kind === 'video') { res.video = tr.receiver.track; res.videoRecv = tr.receiver; res.videoMid = String(t.mid); }
        else { res.audio = tr.receiver.track; res.audioRecv = tr.receiver; }
      }
      if (!res.video) throw new Error('o servidor não mandou o vídeo');
      pulls.set(key, res);
      return res;
    });
  }

  function setRid(key, rid) {
    return serial(async () => {
      const p = pulls.get(key);
      if (!p || p.rid === rid || !p.rid || !sid) return; // (sem rid: uma qualidade só)
      await call('update', { sid, body: { tracks: [{ location: 'remote', mid: p.videoMid, sessionId: p.info.s, trackName: p.info.v,
        simulcast: simulcastOpts(rid) }] } });
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

  // para o diagnóstico: o que sai para o servidor (cada camada) e o que chega dele
  async function stats() {
    const out = [];
    if (!pc) return out;
    const rep = await pc.getStats();
    const mids = new Map();
    for (const [k, p] of pulls) if (p.videoMid != null) mids.set(p.videoMid, `${k} pedi=${p.rid}`);
    rep.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
        out.push(`conexão: ping=${Math.round((r.currentRoundTripTime || 0) * 1000)}ms saídaDisponível=${r.availableOutgoingBitrate ? (r.availableOutgoingBitrate / 1e6).toFixed(1) + 'Mb/s' : '?'}`);
      } else if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const what = pub && pub.mode !== 'simulcast' ? `imagem da placa (${pub.mode.slice(7)}; tamanho real no "helper")` : `camada ${r.rid || '?'}: ${r.frameWidth || 0}x${r.frameHeight || 0}`;
        out.push(`enviando ${what} ${Math.round(r.framesPerSecond || 0)}fps ` +
          `alvo=${r.targetBitrate ? (r.targetBitrate / 1e6).toFixed(1) + 'Mb/s' : '?'} ativa=${r.active !== false} limite=${r.qualityLimitationReason || '-'} ` +
          `encoder=${r.encoderImplementation || '?'} enviado=${((r.bytesSent || 0) / 1e6).toFixed(0)}MB`);
      } else if (r.type === 'inbound-rtp' && r.kind === 'video') {
        out.push(`recebendo (${mids.get(String(r.mid)) || r.mid}): ${r.frameWidth || 0}x${r.frameHeight || 0} ${Math.round(r.framesPerSecond || 0)}fps ` +
          `decoder=${r.decoderImplementation || '?'} perdidos=${r.packetsLost || 0} travadas=${r.freezeCount || 0} recebido=${((r.bytesReceived || 0) / 1e6).toFixed(0)}MB`);
      }
    });
    return out;
  }

  return {
    setSender, onMessage, publish, unpublish, setQuality, pull, unpull, setRid, reset, stats,
    published: () => (pub ? pub.info : null),
    pubSender: () => (pub ? pub.vT.sender : null),
    pc: () => pc,
    state: () => (pc ? pc.connectionState : 'sem conexão'),
    onState: null,
  };
})();
