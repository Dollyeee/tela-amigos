// Vídeo nativo: o AudioHelper captura (WGC) e codifica (H.264 por hardware) a 60 fps fixos.
// Para usar o transporte do WebRTC do Chromium (reenvio de perdas, ritmo, jitter buffer),
// alimentamos o sender com uma trilha "vazia" (64x64) no mesmo ritmo e, num
// RTCRtpScriptTransform, trocamos o conteúdo de cada quadro pelo nosso H.264.
// Quem assiste recebe H.264 normal; nada muda do lado de lá.
window.NativeVideo = (() => {
  const WORKER = `
  const peers = new Map(); // id -> { q, waitingKey, active, sentAny }
  let lastKeyReq = 0;
  function reqKey() {
    const now = Date.now();
    if (now - lastKeyReq > 250) { lastKeyReq = now; postMessage({ type: 'key' }); }
  }
  function get(id) {
    let p = peers.get(id);
    if (!p) { p = { q: [], waitingKey: true, active: false, sentAny: false }; peers.set(id, p); }
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
        if (p.q.length > 4) { p.q.length = 0; p.waitingKey = true; reqKey(); }
      });
    } else if (m.type === 'active') {
      const p = get(m.id);
      if (m.active && !p.active) { p.q.length = 0; p.waitingKey = true; reqKey(); }
      p.active = m.active;
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
        // keyframe da trilha vazia depois do início = alguém pediu (perda de pacotes / novo receptor)
        if (frame.type === 'key' && p.sentAny) reqKey();
        const data = p.q.shift();
        if (!data) return; // ainda sem quadro nosso: não envia nada
        frame.data = data;
        p.sentAny = true;
        ctl.enqueue(frame);
      },
    })).pipeTo(t.writable).catch(() => {});
  };`;

  let worker = null;
  let generator = null, writer = null;
  let previewGen = null, previewWriter = null;
  let decoder = null, decoderReady = false, previewOn = true;
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
    worker.onmessage = (e) => { if (e.data.type === 'key') window.native.videoKey(); };
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
      output: (f) => { if (previewWriter && previewOn) previewWriter.write(f).catch(() => f.close()); else f.close(); },
      error: (e) => { console.warn('prévia', e); decoderReady = false; },
    });
    decoderReady = false;
  }

  function onFrame(buf) {
    if (!running) return;
    const key = (buf[0] & 1) === 1;
    const ts = Number(new DataView(buf.buffer, buf.byteOffset + 1, 8).getBigInt64(0, true));
    const data = buf.buffer.slice(buf.byteOffset + 9, buf.byteOffset + buf.byteLength);

    // prévia local (decodifica nosso próprio stream)
    if (previewOn) {
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

    worker.postMessage({ type: 'frame', key, data }, [data]);

    // quadro vazio no mesmo ritmo: cada um "carrega" um quadro nosso
    if (ts <= lastTs) return;
    lastTs = ts;
    frameNo++;
    for (let i = 0; i < DW * DH; i++) dummy[i] = (i + frameNo * 7) & 255;
    const vf = new VideoFrame(dummy, { format: 'I420', codedWidth: DW, codedHeight: DH, timestamp: ts });
    writer.write(vf).catch(() => vf.close());
  }

  async function start(opts) {
    await stop();
    ensureWorker();
    worker.postMessage({ type: 'reset' });
    generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.contentHint = 'motion';
    writer = generator.writable.getWriter();
    previewGen = new MediaStreamTrackGenerator({ kind: 'video' });
    previewWriter = previewGen.writable.getWriter();
    makePreviewDecoder();
    lastTs = -1;
    running = true;
    window.native.onVideoFrame(onFrame);
    const res = await window.native.videoStart(opts);
    if (res.type !== 'video-started') {
      await stop();
      throw new Error(res.message || 'falha ao iniciar a captura nativa');
    }
    return { track: generator, preview: new MediaStream([previewGen]), width: res.width, height: res.height, encoder: res.encoder };
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

  function attach(sender, peerId) {
    ensureWorker();
    if (sender.__nativeTransform === peerId) return;
    sender.transform = new RTCRtpScriptTransform(worker, { id: peerId });
    sender.__nativeTransform = peerId;
  }

  function setActive(peerId, active) { if (worker) worker.postMessage({ type: 'active', id: peerId, active }); }
  function remove(peerId) { if (worker) worker.postMessage({ type: 'remove', id: peerId }); }
  function setPreview(on) {
    if (on && !previewOn) { decoderReady = false; window.native.videoKey(); }
    previewOn = on;
  }

  return { start, stop, attach, setActive, remove, setPreview, isRunning: () => running };
})();
