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
    for (const [id, p] of peers) { s[id] = { sent: p.sent || 0, empty: p.empty || 0, flush: p.flush || 0, q: p.q.length }; p.sent = p.empty = p.flush = 0; }
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
        p.q.push(i === list.length - 1 ? m.data : m.data.slice(0));
        // o encoder do Chromium ficou para trás: descarta e recomeça num keyframe
        if (p.q.length > 4) { p.q.length = 0; p.waitingKey = true; p.flush = (p.flush || 0) + 1; reqKey(); }
      });
    } else if (m.type === 'mode') {
      const p = get(m.id);
      const active = m.native && m.active;
      if (active && !p.active) { p.q.length = 0; p.waitingKey = true; p.sentAny = false; reqKey(); }
      p.native = m.native;
      p.active = active;
    } else if (m.type === 'reset') {
      for (const p of peers.values()) { p.q.length = 0; p.waitingKey = true; }
    } else if (m.type === 'remove') {
      peers.delete(m.id);
    }
  };
  onrtctransform = (e) => {
    const t = e.transformer;
    const p = get(t.options.id);
    p.q.length = 0; p.waitingKey = true;
    t.readable.pipeThrough(new TransformStream({
      transform(frame, ctl) {
        if (!p.native) { ctl.enqueue(frame); return; } // modo Chromium: não mexe
        // (keyframes da trilha vazia NÃO são usados como pedido: o Chromium gera vários quando a
        //  estimativa de banda muda. Os pedidos reais (PLI/FIR) são lidos das estatísticas no app.)
        const data = p.q.shift();
        if (!data) { p.empty = (p.empty || 0) + 1; return; } // ainda sem quadro nosso: não envia nada
        frame.data = data;
        p.sentAny = true;
        p.sent = (p.sent || 0) + 1;
        ctl.enqueue(frame);
      },
    })).pipeTo(t.writable).catch(() => {});
  };`;

  let worker = null;
  let generator = null, writer = null;
  let previewGen = null, previewWriter = null;
  let decoder = null, decoderReady = false, previewOn = true, inject = false;
  let running = false;
  let lastTs = -1;
  let frameNo = 0;
  const DW = 64, DH = 64;
  const dummy = new Uint8Array((DW * DH * 3) / 2);
  dummy.fill(128, DW * DH);

  function ensureWorker() {
    if (worker) return worker;
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (e) => {
      if (e.data.type === 'key') window.native.videoKey();
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

  function makePreviewDecoder() {
    decoder = new VideoDecoder({
      output: (f) => { if (previewWriter && (previewOn || !inject)) previewWriter.write(f).catch(() => f.close()); else f.close(); },
      error: (e) => { console.warn('decodificação', e); decoderReady = false; window.native.videoKey(); },
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
        const codec = codecFromSps(new Uint8Array(data));
        if (codec) {
          decoder.configure({ codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
          decoderReady = true;
        }
      }
      if (decoderReady) {
        if (decoder.decodeQueueSize > 8) { decoder.reset(); decoderReady = false; window.native.videoKey(); }
        else decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }));
      }
    }

    if (!inject) return; // modo adaptativo: o WebRTC recodifica a trilha decodificada

    worker.postMessage({ type: 'frame', key, data }, [data]);

    // quadro vazio no mesmo ritmo: cada um "carrega" um quadro nosso
    if (ts <= lastTs) return;
    lastTs = ts;
    frameNo++;
    for (let i = 0; i < DW * DH; i++) dummy[i] = (i + frameNo * 7) & 255;
    const vf = new VideoFrame(dummy, { format: 'I420', codedWidth: DW, codedHeight: DH, timestamp: ts });
    writer.write(vf).catch(() => vf.close());
  }

  // opts.inject = true: envio direto do H.264 nativo (só rede perfeita)
  // opts.inject = false: o WebRTC recodifica a trilha decodificada (adaptativo, padrão)
  async function start(opts) {
    await stop();
    ensureWorker();
    worker.postMessage({ type: 'reset' });
    inject = !!opts.inject;
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
    window.native.onVideoFrame(onFrame);
    const { inject: _i, ...helperOpts } = opts;
    const res = await window.native.videoStart(helperOpts);
    if (res.type !== 'video-started') {
      await stop();
      throw new Error(res.message || 'falha ao iniciar a captura nativa');
    }
    if (!inject) previewGen.contentHint = 'motion';
    return {
      track: inject ? generator : previewGen,
      preview: new MediaStream([previewGen]),
      width: res.width, height: res.height, encoder: res.encoder,
    };
  }

  async function stop() {
    const was = running;
    running = false;
    if (was) { try { await window.native.videoStop(); } catch {} }
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
    if (on && !previewOn) { decoderReady = false; window.native.videoKey(); }
    previewOn = on;
  }

  return { start, stop, attach, setMode, remove, setPreview, isRunning: () => running };
})();
