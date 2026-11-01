// Vídeo nativo: o AudioHelper captura (WGC) e codifica (H.264 por hardware) a 60 fps fixos.
// Para usar o transporte do WebRTC do Chromium (reenvio de perdas, ritmo, jitter buffer),
// alimentamos o sender com uma trilha "vazia" (64x64) no mesmo ritmo e, num
// RTCRtpScriptTransform, trocamos o conteúdo de cada quadro pelo nosso H.264.
// Quem assiste recebe H.264 normal; nada muda do lado de lá.
window.NativeVideo = (() => {
  const WORKER = `
  // native=false: deixa os quadros do Chromium passarem como estão (captura Chromium / sem compartilhar)
  const peers = new Map(); // id -> { q, waitingKey, active, native, sentAny }
  let lastKeyReq = 0, keyTimer = null;
  // H.265: o encoder HEVC de hardware do Chromium TRAVA se um quadro codificado for descartado
  // aqui (para de devolver buffers). Então, sem quadro nosso, devolve o quadro com dados vazios
  // (nada vai para a rede). No H.264 (encoder de software para o 64x64) descartar é o normal.
  let hevc = false;
  // AV1: o tipo do quadro (key/delta) vai no cabeçalho RTP e vem do quadro do Chromium, não do
  // nosso. Então nosso keyframe só pode ir num quadro que o Chromium marcou como keyframe (e vice-
  // versa). Para ganhar um "lugar de keyframe" na hora, o app muda o tamanho da trilha vazia (o
  // encoder reinicia = keyframe). Sem quadro nosso, também devolve dados vazios.
  let av1 = false;
  let slotAsk = 0;
  function skip(frame, ctl) { if (hevc || av1) { frame.data = new ArrayBuffer(0); ctl.enqueue(frame); } }
  // no máximo 1 pedido a cada 500 ms; pedidos dentro da janela são adiados (não perdidos)
  function reqKey() {
    const wait = 500 - (Date.now() - lastKeyReq);
    if (wait <= 0) { lastKeyReq = Date.now(); postMessage({ type: 'key' }); return; }
    if (!keyTimer) keyTimer = setTimeout(() => { keyTimer = null; reqKey(); }, wait);
  }
  // enquanto alguém estiver esperando o primeiro keyframe, insiste a cada segundo
  // (o encoder quase não gera keyframes sozinho; um pedido perdido deixaria a tela preta)
  setInterval(() => {
    for (const p of peers.values()) if (p.active && p.waitingKey) { reqKey(); break; }
    // diagnóstico: quantos quadros foram enviados/pulados/descartados por amigo
    const s = {};
    for (const [id, p] of peers) { s[id] = { all: p.all || 0, sent: p.sent || 0, empty: p.empty || 0, flush: p.flush || 0, q: p.q.length, native: p.native, active: p.active, wk: p.waitingKey }; p.all = p.sent = p.empty = p.flush = 0; }
    postMessage({ type: 'stats', peers: s });
  }, 1000);

  function get(id) {
    let p = peers.get(id);
    if (!p) { p = { q: [], waitingKey: true, active: false, native: false, sentAny: false }; peers.set(id, p); }
    return p;
  }
  onmessage = (e) => {
    const m = e.data;
    if (m.type === 'frame') {
      const list = [...peers.values()].filter((p) => p.active);
      list.forEach((p, i) => {
        if (p.waitingKey) { if (!m.key) return; p.waitingKey = false; }
        p.q.push({ key: m.key, data: i === list.length - 1 ? m.data : m.data.slice(0) });
        // o encoder do Chromium ficou para trás: descarta e recomeça num keyframe
        if (p.q.length > (av1 ? 12 : 4)) { p.q.length = 0; p.waitingKey = true; p.flush = (p.flush || 0) + 1; reqKey(); }
      });
    } else if (m.type === 'mode') {
      const p = get(m.id);
      const active = m.native && m.active;
      if (active && !p.active) { p.q.length = 0; p.waitingKey = true; p.sentAny = false; reqKey(); }
      p.native = m.native;
      p.active = active;
    } else if (m.type === 'codec') {
      hevc = m.codec === 'hevc';
      av1 = m.codec === 'av1';
    } else if (m.type === 'reset') {
      for (const p of peers.values()) { p.q.length = 0; p.waitingKey = true; }
    } else if (m.type === 'remove') {
      peers.delete(m.id);
    }
  };
  function av1Slot(p, frame, ctl) {
    const keySlot = frame.type === 'key';
    if (keySlot) slotAsk = 0;
    // lugar de keyframe e há um keyframe nosso na fila: pula direto para ele (menos atraso)
    if (keySlot) { for (let i = p.q.length - 1; i > 0; i--) if (p.q[i].key) { p.q.splice(0, i); break; } }
    let item = p.q[0];
    if (item && item.key && !keySlot) {
      item = null; // nosso keyframe espera um lugar de keyframe
      if (!slotAsk || Date.now() - slotAsk > 500) { slotAsk = Date.now(); postMessage({ type: 'keyslot' }); }
    } else if (keySlot && !(item && item.key)) {
      // o Chromium fez um keyframe (pedido de quem assiste): o nosso vem logo em seguida
      p.q.length = 0; p.waitingKey = true; item = null; reqKey();
    }
    // fila crescendo sem keyframe na frente (o envio ficou para trás): recomeça num keyframe
    if (item && p.q.length > 4 && !item.key) { p.q.length = 0; p.waitingKey = true; p.flush = (p.flush || 0) + 1; item = null; reqKey(); }
    if (!item) { p.empty = (p.empty || 0) + 1; skip(frame, ctl); return; }
    p.q.shift();
    frame.data = item.data;
    p.sentAny = true;
    p.sent = (p.sent || 0) + 1;
    ctl.enqueue(frame);
  }
  onrtctransform = (e) => {
    const t = e.transformer;
    const p = get(t.options.id);
    p.q.length = 0; p.waitingKey = true;
    t.readable.pipeThrough(new TransformStream({
      transform(frame, ctl) {
        p.all = (p.all || 0) + 1;
        if (!p.native) { ctl.enqueue(frame); return; } // modo Chromium: não mexe
        // (keyframes da trilha vazia NÃO são usados como pedido: o Chromium gera vários quando a
        //  estimativa de banda muda. Os pedidos reais (PLI/FIR) são lidos das estatísticas no app.)
        if (av1) { av1Slot(p, frame, ctl); return; }
        const item = p.q.shift();
        if (!item) { p.empty = (p.empty || 0) + 1; skip(frame, ctl); return; } // ainda sem quadro nosso: não envia nada
        frame.data = item.data;
        p.sentAny = true;
        p.sent = (p.sent || 0) + 1;
        ctl.enqueue(frame);
      },
    })).pipeTo(t.writable).catch(() => {});
  };`;

  const dbg = { dummy: 0, writeErr: null }; // diagnóstico (quadros vazios entregues ao WebRTC)
  let worker = null;
  let generator = null, writer = null;
  let previewGen = null, previewWriter = null;
  let decoder = null, decoderReady = false, previewOn = true, inject = false;
  let running = false;
  let lastTs = -1;
  let frameNo = 0;
  let codec = 'h264'; // 'h264', 'hevc' ou 'av1' (o que o helper está gerando)
  let altSize = false;  // AV1: alterna o tamanho da trilha vazia para o Chromium gerar um keyframe
  let pushKey = null;   // teste sintético: pedido de keyframe vai para o gerador do teste
  // quadro "vazio" que o Chromium codifica e nós trocamos pelo nosso. No H.265 precisa ser maior:
  // os encoders HEVC de hardware recusam 64x64 (e o Chromium não tem HEVC por software)
  let DW = 64, DH = 64;
  let dummy = null;
  function makeDummy() {
    [DW, DH] = codec === 'hevc' ? [256, 144] : [64, 64];
    dummy = new Uint8Array((96 * 96 * 3) / 2 + DW * DH * 2); // cabe também o tamanho alternativo
  }
  makeDummy();

  function ensureWorker() {
    if (worker) return worker;
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (e) => {
      if (e.data.type === 'key') { if (pushKey) pushKey(); else window.Helper.videoKey(); }
      else if (e.data.type === 'keyslot') altSize = !altSize; // AV1: próximo quadro vazio muda de tamanho
      else if (e.data.type === 'stats') window.NativeVideo.lastStats = e.data.peers;
    };
    return worker;
  }

  function codecFromSps(d) {
    for (let i = 0; i + 6 < d.length; i++) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] & 0x1f) === 7) {
        const h = (x) => x.toString(16).padStart(2, '0');
        return `avc1.${h(d[i + 4])}${h(d[i + 5])}${h(d[i + 6])}`;
      }
    }
    return null;
  }

  let lastKeyAsk = 0;
  function requestKey() {
    if (Date.now() - lastKeyAsk < 1000) return;
    lastKeyAsk = Date.now();
    if (pushKey) pushKey(); else window.Helper.videoKey();
  }
  function makePreviewDecoder() {
    decoder = new VideoDecoder({
      output: (f) => { if (previewWriter && (previewOn || !inject)) previewWriter.write(f).catch(() => f.close()); else f.close(); },
      error: (e) => { console.warn('decodificação', e); decoderReady = false; requestKey(); },
    });
    decoderReady = false;
  }

  function onFrame(buf) {
    if (!running) return;
    const key = (buf[0] & 1) === 1;
    const ts = Number(new DataView(buf.buffer, buf.byteOffset + 1, 8).getBigInt64(0, true));
    const data = buf.buffer.slice(buf.byteOffset + 9, buf.byteOffset + buf.byteLength);

    // decodifica nosso próprio stream: vira a prévia local e, no modo adaptativo,
    // também a trilha que o WebRTC recodifica para cada amigo (então nunca pode parar)
    if (previewOn || !inject) {
      if (!decoder || decoder.state === 'closed') makePreviewDecoder();
      if (!decoderReady && key) {
        // H.265: perfil Main, nível 5.1 (cobre até 4K60); AV1: Main, nível 5.1; H.264: lido do SPS
        const cfg = codec === 'hevc' ? 'hvc1.1.6.L153.B0' : codec === 'av1' ? 'av01.0.13M.08' : codecFromSps(new Uint8Array(data));
        if (cfg) {
          decoder.configure({ codec: cfg, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
          decoderReady = true;
        }
      }
      if (decoderReady) {
        // a prévia nunca pode atrapalhar o envio: erro aqui só reinicia a prévia no próximo keyframe
        try {
          if (decoder.decodeQueueSize > 8) { decoder.reset(); decoderReady = false; requestKey(); }
          else decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }));
        } catch (e) {
          dbg.previewErr = String(e && e.message || e);
          dbg.previewErrs = (dbg.previewErrs || 0) + 1;
          try { decoder.reset(); } catch {}
          decoderReady = false;
          if (!key) requestKey();
        }
      }
    }

    if (!inject) return; // modo adaptativo: o WebRTC recodifica a trilha decodificada

    worker.postMessage({ type: 'frame', key, data }, [data]);

    // quadro vazio no mesmo ritmo: cada um "carrega" um quadro nosso
    if (ts <= lastTs) return;
    lastTs = ts;
    frameNo++;
    const w = altSize ? DW + 16 : DW, h = altSize ? DH + 16 : DH;
    for (let i = 0; i < w * h; i++) dummy[i] = (i + frameNo * 7) & 255;
    dummy.fill(128, w * h, (w * h * 3) / 2);
    const vf = new VideoFrame(dummy.subarray(0, (w * h * 3) / 2), { format: 'I420', codedWidth: w, codedHeight: h, timestamp: ts });
    dbg.dummy++;
    writer.write(vf).catch((e) => { dbg.writeErr = String(e && e.message || e); vf.close(); });
  }

  // opts.inject = true: envio direto do H.264 nativo (só rede perfeita)
  // opts.inject = false: o WebRTC recodifica a trilha decodificada (adaptativo, padrão)
  // opts.codec: 'hevc' (H.265) ou 'h264'. opts.synthetic: teste automático, os quadros vêm de
  // push() em vez do helper (mesmo formato: [key][timestamp 8 bytes][Annex-B])
  async function start(opts) {
    await stop();
    ensureWorker();
    worker.postMessage({ type: 'reset' });
    inject = !!opts.inject;
    codec = opts.codec === 'hevc' || opts.codec === 'av1' ? opts.codec : 'h264';
    worker.postMessage({ type: 'codec', codec });
    altSize = false;
    pushKey = opts.synthetic && opts.onKey ? opts.onKey : null;
    makeDummy();
    generator = null;
    writer = null;
    if (inject) {
      generator = new MediaStreamTrackGenerator({ kind: 'video' });
      generator.contentHint = 'motion';
      writer = generator.writable.getWriter();
    }
    previewGen = new MediaStreamTrackGenerator({ kind: 'video' });
    previewWriter = previewGen.writable.getWriter();
    makePreviewDecoder();
    lastTs = -1;
    running = true;
    if (opts.synthetic) {
      return { track: inject ? generator : previewGen, preview: new MediaStream([previewGen]), width: opts.width, height: opts.height,
        encoder: 'teste', codec, push: (u8) => onFrame(u8) };
    }
    window.Helper.onVideo((ab) => onFrame(new Uint8Array(ab)));
    const { inject: _i, ...helperOpts } = opts;
    const res = await window.Helper.videoStart(helperOpts);
    if (res.type !== 'video-started') {
      await stop();
      throw new Error(res.message || 'falha ao iniciar a captura nativa');
    }
    if (!inject) previewGen.contentHint = 'motion';
    return {
      track: inject ? generator : previewGen,
      preview: new MediaStream([previewGen]),
      width: res.width, height: res.height, encoder: res.encoder, codec: res.codec || 'h264',
    };
  }

  async function stop() {
    const was = running;
    running = false;
    if (was) { try { await window.Helper.videoStop(); } catch {} }
    try { writer && writer.close(); } catch {}
    try { previewWriter && previewWriter.close(); } catch {}
    try { generator && generator.stop(); } catch {}
    try { previewGen && previewGen.stop(); } catch {}
    try { decoder && decoder.state !== 'closed' && decoder.close(); } catch {}
    writer = previewWriter = generator = previewGen = decoder = null;
    decoderReady = false;
    if (worker) worker.postMessage({ type: 'reset' });
  }

  // Precisa ser chamado ANTES da primeira negociação da conexão: o Chromium ignora
  // um transform ligado depois que o envio já foi configurado.
  function attach(sender, peerId) {
    ensureWorker();
    sender.transform = new RTCRtpScriptTransform(worker, { id: peerId });
  }

  function setMode(peerId, native, active) {
    if (worker) worker.postMessage({ type: 'mode', id: peerId, native, active });
  }
  function remove(peerId) { if (worker) worker.postMessage({ type: 'remove', id: peerId }); }
  function setPreview(on) {
    if (on && !previewOn) { decoderReady = false; window.Helper.videoKey(); }
    previewOn = on;
  }

  return { start, stop, attach, setMode, remove, setPreview, isRunning: () => running, dbg };
})();
