// Servidor de vídeo (Cloudflare Realtime SFU), beta, só na sala online.
// Quem transmite manda UMA vez (em 3 qualidades: f = cheia, h = metade, q = um quarto) e o servidor
// repassa para cada amigo a qualidade que a conexão dele aguenta. Cada operação da API vai pela sala
// online (o servidor da sala guarda a chave e confere que só se puxa transmissão de quem está nela).
//
// DUAS conexões WebRTC com o servidor (separadas das conexões diretas com os amigos): uma só para o
// que eu PUBLICO e outra só para o que eu PUXO. Antes era uma só para as duas coisas, e quem
// transmitia e assistia ao mesmo tempo esbarrava numa colisão de numeração do SDP: na conexão em que
// EU fiz a primeira oferta o número 116 era um perfil do H.264; nas ofertas do servidor o 116 é o
// H.265. Resultado: "The subscriber's SDP is missing the published track's codec" ao puxar H.265, e
// "Failed to set remote video description send parameters" ao publicar H.265 depois de puxar. Com uma
// conexão para cada sentido, cada uma tem um lado só fazendo as ofertas e os números nunca colidem
// (H.265 e AV1 voltam a funcionar pelo servidor).
window.Sfu = (() => {
  let sendFn = null;
  const pending = new Map(); // req -> { resolve, reject, timer }
  let nextReq = 1;
  const mk = (kind) => ({ kind, pc: null, sid: null, queue: Promise.resolve(), downTimer: null });
  const P = mk('envio');     // o que eu publico
  const S = mk('recepção');  // o que eu puxo
  let pub = null;            // { vT, aT, info }
  const pulls = new Map();   // chave -> { mids, video, audio, videoRecv, videoMid, info }
  let lastBytes = 0;

  function setSender(fn) { sendFn = fn; }

  // Uma das conexões com o servidor morreu (caiu, ou ficou num estado que o servidor não aceita mais:
  // "Session appears to be disconnected", negociação pela metade). Antes ela ficava assim para
  // sempre e todo mundo via a tela preta até sair e entrar na sala. Agora: joga as sessões fora e
  // avisa o app (window.Sfu.onLost), que volta para a conexão direta e refaz tudo em sessões novas.
  const DEAD = /Session appears to be disconnected|sessão desconhecida|signaling state|out-of-order|session.*not found/i;
  function lost(why) {
    if (!P.pc && !P.sid && !S.pc && !S.sid) return;
    console.warn(`servidor de vídeo: conexão perdida (${why})`);
    reset();
    const cb = window.Sfu && window.Sfu.onLost;
    if (cb) setTimeout(() => { try { cb(why); } catch (e) { console.warn('servidor de vídeo: recuperar', e); } }, 0);
  }
  function lostErr(e) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.sfuLost = true;
    lost(err.message);
    return err;
  }

  // respostas da sala ("sfu-res"); devolve true se a mensagem era daqui
  function onMessage(msg) {
    if (!msg || msg.type !== 'sfu-res') return false;
    const p = pending.get(msg.req);
    if (!p) return true;
    pending.delete(msg.req);
    clearTimeout(p.timer);
    if (msg.ok) { p.resolve(msg.data || {}); return true; }
    const err = new Error(msg.error || 'erro no servidor de vídeo');
    if (DEAD.test(err.message)) err.sfuDead = true;
    p.reject(err);
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

  // uma operação por vez em cada conexão
  function serial(c, fn) {
    const p = c.queue.then(fn, fn);
    c.queue = p.catch(() => {});
    return p;
  }

  function reset() {
    for (const c of [P, S]) { clearTimeout(c.downTimer); c.downTimer = null; }
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('servidor de vídeo encerrado')); }
    pending.clear();
    for (const c of [P, S]) { try { c.pc && c.pc.close(); } catch {} c.pc = null; c.sid = null; }
    pub = null; pulls.clear(); lastBytes = 0;
  }

  async function ensure(c) {
    if (c.pc && c.sid && !['failed', 'closed'].includes(c.pc.connectionState)) return;
    if (c.pc || c.sid) throw lostErr(new Error(`conexão de ${c.kind} fechou`));
    const me = c.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    me.onconnectionstatechange = () => {
      if (c.pc !== me) return; // sessão antiga
      const st = me.connectionState;
      if (st === 'failed' || st === 'closed') { lost(`conexão de ${c.kind} falhou`); return; }
      // caiu: o navegador às vezes volta sozinho em poucos segundos; se não voltar em 5 s, refaz
      if (st === 'disconnected') {
        clearTimeout(c.downTimer);
        c.downTimer = setTimeout(() => { if (c.pc === me && me.connectionState !== 'connected') lost(`conexão de ${c.kind} caiu`); }, 5000);
      } else if (st === 'connected') { clearTimeout(c.downTimer); c.downTimer = null; }
      if (window.Sfu.onState) window.Sfu.onState(st);
    };
    let r;
    try { r = await call('new'); } catch (e) {
      // sem sessão (ex.: limite do mês atingido): desfaz só esta conexão; não é "conexão perdida"
      if (c.pc === me) { c.pc = null; try { me.close(); } catch {} }
      throw e;
    }
    if (c.pc !== me) throw lostErr(new Error('sessão refeita no meio'));
    c.sid = r.sessionId;
    if (r.usedGb != null) {
      console.log(`servidor de vídeo: sessão nova de ${c.kind} (${r.usedGb} GB usados no mês)`);
      window.Sfu.usage = { used: r.usedGb, limit: r.limitGb || 0 };
      if (window.Sfu.onUsage) { try { window.Sfu.onUsage(window.Sfu.usage); } catch {} }
    }
  }

  const name = (k) => `${k}-${Math.random().toString(36).slice(2, 10)}`;

  async function connected(c) {
    if (!c.pc || !c.pc.remoteDescription) return; // sessão nova: ainda não negociou nada
    const end = Date.now() + 10000;
    while (c.pc && c.pc.connectionState !== 'connected') {
      if (Date.now() > end || ['failed', 'closed'].includes(c.pc.connectionState)) throw lostErr(new Error('conexão com o servidor não ficou pronta'));
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // erro no meio de uma negociação: a sessão fica num estado que o servidor não aceita mais
  function fail(c, e, midNegotiation) {
    if (e && e.sfuLost) return e;
    if ((e && e.sfuDead) || midNegotiation || (c.pc && c.pc.signalingState !== 'stable')) return lostErr(e);
    return e;
  }

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
    const S2 = window.Sdp;
    return codec === 'hevc' ? S2.h265OnlyPreferences() : codec === 'av1' ? S2.av1OnlyPreferences() : S2.h264OnlyPreferences();
  }
  // som estéreo de música e bitrate inicial alto (igual à conexão direta); vale para o que EU envio.
  // Na nativa o teto da estimativa de banda fica acima do que a placa manda (o controle de bitrate lê
  // essa estimativa para saber se o caminho até o servidor está cheio)
  function mungeAnswer(desc, kbps, native) {
    try { return { type: desc.type, sdp: window.Sdp.munge(desc.sdp, { videoKbps: kbps, native, maxKbps: native ? kbps * 1.5 : 0, minKbps: native ? Math.min(kbps * 0.6, 8000) : 0 }) }; } catch { return desc; }
  }

  // publica (ou troca) a minha transmissão; devolve { s, v, a, n } para os amigos puxarem
  // native = null (encoder do Chromium, 3 qualidades) ou { codec, attach(sender) } (placa de vídeo)
  function publish(opts) {
    return serial(P, async () => {
      try { return await publishInner(opts); } catch (e) { throw fail(P, e, false); }
    });
  }
  async function publishInner({ video, audio, kbps, fps, native = null }) {
    await ensure(P);
    await connected(P);
    const pc = P.pc, sid = P.sid;
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
  function setQuality(kbps, fps) { return serial(P, () => setQualityInner(kbps, fps)); }

  async function unpublishInner() {
    if (!pub) return;
    const mids = [pub.vT.mid, pub.aT && pub.aT.mid].filter((m) => m != null);
    const old = pub;
    pub = null;
    try { if (mids.length && P.sid) await call('close', { sid: P.sid, body: { tracks: mids.map((mid) => ({ mid })), force: true } }); } catch (e) { console.warn('servidor de vídeo: fechar', e.message); }
    try { old.vT.sender.replaceTrack(null); old.vT.stop(); } catch {}
    try { if (old.aT) { old.aT.sender.replaceTrack(null); old.aT.stop(); } } catch {}
  }
  function unpublish() { return serial(P, unpublishInner); }

  // O servidor manda a qualidade pedida. Com priorityOrdering 'asciibetical' ele mesmo descia de
  // qualidade e subia muito devagar (pedia a cheia e chegava 640x360 por vários segundos): quem desce
  // agora é o app, pela perda/travadas medidas aqui (sfuRxFeedback no app.js). Se quem transmite
  // parar de mandar a qualidade pedida, o servidor usa a próxima disponível.
  const simulcastOpts = (rid) => ({ preferredRid: rid, priorityOrdering: 'none', ridNotAvailable: 'asciibetical' });

  // puxa a transmissão de um amigo; rid = 'f' (cheia), 'h' ou 'q' (o servidor desce sozinho se precisar)
  function pull(key, info, rid = 'f') {
    return serial(S, async () => {
      let mid = false;
      try {
        await ensure(S);
        await connected(S);
        const pc = S.pc, sid = S.sid;
        const one = info.n === 1; // transmissão da placa de vídeo: uma qualidade só
        const simulcast = simulcastOpts(rid);
        const tracks = [{ location: 'remote', sessionId: info.s, trackName: info.v, ...(one ? {} : { simulcast }) }];
        if (info.a) tracks.push({ location: 'remote', sessionId: info.s, trackName: info.a });
        const r = await call('tracks', { sid, body: { tracks } });
        // uma trilha falhou (ex.: quem transmite ainda conectando): o servidor pode ter mandado a
        // negociação das outras mesmo assim. Sem responder, a sessão ficava travada esperando a
        // resposta e tudo depois falhava ("expecting a remote answer"). Responde, fecha e só então desiste.
        const bad = (r.tracks || []).find((t) => t.errorCode);
        if (r.requiresImmediateRenegotiation && r.sessionDescription) {
          mid = true;
          await pc.setRemoteDescription(r.sessionDescription);
          await pc.setLocalDescription(await pc.createAnswer());
          await call('renegotiate', { sid, body: { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } } });
          mid = false;
        }
        if (bad) {
          const okMids = (r.tracks || []).filter((t) => !t.errorCode && t.mid != null).map((t) => ({ mid: String(t.mid) }));
          if (okMids.length) await call('close', { sid, body: { tracks: okMids, force: true } }).catch(() => {});
          throw new Error(bad.errorDescription || bad.errorCode);
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
      } catch (e) { throw fail(S, e, mid); }
    });
  }

  function setRid(key, rid) {
    return serial(S, async () => {
      const p = pulls.get(key);
      if (!p || p.rid === rid || !p.rid || !S.sid) return; // (sem rid: uma qualidade só)
      await call('update', { sid: S.sid, body: { tracks: [{ location: 'remote', mid: p.videoMid, sessionId: p.info.s, trackName: p.info.v,
        simulcast: simulcastOpts(rid) }] } }).catch((e) => { throw e.sfuDead ? lostErr(e) : e; });
      p.rid = rid;
    });
  }

  function unpull(key) {
    return serial(S, async () => {
      const p = pulls.get(key);
      if (!p) return;
      pulls.delete(key);
      try { if (S.sid && p.mids.length) await call('close', { sid: S.sid, body: { tracks: p.mids.map((mid) => ({ mid })), force: true } }); } catch (e) { console.warn('servidor de vídeo: parar de puxar', e.message); }
    });
  }

  // GB recebidos do servidor (o servidor da sala soma e respeita o limite grátis do mês)
  async function reportUsage() {
    if (!S.pc || !sendFn) return;
    let total = 0;
    try { (await S.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') total += r.bytesReceived || 0; }); } catch { return; }
    const d = total - lastBytes;
    lastBytes = total;
    if (d > 0) { try { sendFn({ type: 'sfu-usage', bytes: d }); } catch {} }
  }
  setInterval(() => { reportUsage().catch(() => {}); }, 60000);

  // para o diagnóstico: o que sai para o servidor (cada camada) e o que chega dele
  async function stats() {
    const out = [];
    const mids = new Map();
    for (const [k, p] of pulls) if (p.videoMid != null) mids.set(p.videoMid, `${k} pedi=${p.rid}`);
    for (const c of [P, S]) {
      if (!c.pc) continue;
      const rep = await c.pc.getStats();
      rep.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          out.push(`conexão de ${c.kind}: ping=${Math.round((r.currentRoundTripTime || 0) * 1000)}ms` +
            (c === P ? ` saídaDisponível=${r.availableOutgoingBitrate ? (r.availableOutgoingBitrate / 1e6).toFixed(1) + 'Mb/s' : '?'}` : ''));
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
    }
    return out;
  }

  return {
    setSender, onMessage, publish, unpublish, setQuality, pull, unpull, setRid, reset, stats,
    published: () => (pub ? pub.info : null),
    pubSender: () => (pub ? pub.vT.sender : null),
    pc: () => P.pc,       // conexão do que eu publico
    subPc: () => S.pc,    // conexão do que eu puxo
    state: () => (!P.pc && !S.pc ? 'sem conexão' : `envio=${P.pc ? P.pc.connectionState : '-'} recepção=${S.pc ? S.pc.connectionState : '-'}`),
    onState: null,
    onLost: null, // (motivo) as sessões foram jogadas fora: o app refaz transmissão e recepção
    usage: null,  // { used, limit } em GB no mês (o que a sala informou por último)
    onUsage: null,
  };
})();
