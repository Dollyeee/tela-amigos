// Vídeo nativo: o AudioHelper captura (WGC) e codifica (H.264 por hardware) a 60 fps fixos.
// Para usar o transporte do WebRTC do Chromium (reenvio de perdas, ritmo, jitter buffer),
// alimentamos o sender com uma trilha "vazia" (64x64) no mesmo ritmo e, num
// RTCRtpScriptTransform, trocamos o conteúdo de cada quadro pelo nosso H.264.
// Quem assiste recebe H.264 normal; nada muda do lado de lá.
//
// Duas camadas (desde a 1.0.64): a 0 é a tela cheia; a 1 é a versão leve (960x540, 30 fps) que o helper codifica num
// segundo encoder, para quem vê a tela em miniatura ou tem a rede fraca. Cada amigo está numa camada (setLayer) e cada
// camada tem a sua trilha vazia: o quadro-chave de uma (inclusive o "lugar de keyframe" do AV1) não mexe na outra.
window.NativeVideo = (() => {
  const WORKER = `
  // native=false: deixa os quadros do Chromium passarem como estão (captura Chromium / sem compartilhar)
  const peers = new Map(); // id -> { q, waitingKey, active, native, sentAny, layer }
  const lastKeyReq = [0, 0], keyTimer = [null, null]; // por camada
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
  // QUADRO-CHAVE DA TRILHA VAZIA (H.264/H.265): nunca leva um quadro nosso. Quando um quadro-chave
  // entra na fila de envio, o Chromium joga fora os pacotes do mesmo vídeo que ainda esperavam para
  // sair (para o quadro-chave chegar logo). Só que esse quadro-chave é o da trilha vazia, não o
  // nosso: o quadro nosso que estava saindo sumia pela metade, sem deixar buraco na numeração dos
  // pacotes (nada para reenviar), e quem assistia ficava até ~3 s com a imagem parada, até pedir
  // um keyframe. Esse lugar fica vazio e o app manda um quadro vazio extra logo em seguida para o
  // quadro nosso não ficar esperando (ver askExtra).
  // (No AV1 o nosso keyframe precisa do lugar de keyframe; lá o corte só pega quadros anteriores ao
  //  nosso keyframe, que não fazem falta.)
  let lagMs = [12.5, 25];   // por camada: um quadro nosso que esperou mais que isso na fila perdeu a "carona" dele
  let lastExtra = 0;
  // Pede ao app um quadro vazio a mais: tem quadro nosso na fila sem quadro vazio para levá-lo (lugar
  // de quadro-chave pulado, ou um quadro vazio descartado pelo Chromium). Sem isso o atraso de um
  // quadro ficava para sempre, a fila ia enchendo e acabava num keyframe forçado.
  function askExtra(p) {
    const now = performance.now();
    if (now - lastExtra < 5) return;
    lastExtra = now;
    p.ex = (p.ex || 0) + 1;
    postMessage({ type: 'extra', layer: p.layer });
  }
  let trace = null; // diagnóstico (testes): registro de cada quadro que passou pelo transform
  function note(frame, size, key) {
    if (!trace) return;
    let ts = null; try { ts = frame.getMetadata().rtpTimestamp; } catch (e) {}
    trace.push([Date.now() % 1000000, frame.type, ts, size, key ? 1 : 0]);
    if (trace.length > 8000) trace.shift();
  }
  function skip(frame, ctl) { if (hevc || av1) { frame.data = new ArrayBuffer(0); ctl.enqueue(frame); } }
  // no máximo 1 pedido a cada 500 ms por camada; pedidos dentro da janela são adiados (não perdidos)
  function reqKey(layer = 0) {
    const wait = 500 - (Date.now() - lastKeyReq[layer]);
    if (wait <= 0) { lastKeyReq[layer] = Date.now(); postMessage({ type: 'key', layer }); return; }
    if (!keyTimer[layer]) keyTimer[layer] = setTimeout(() => { keyTimer[layer] = null; reqKey(layer); }, wait);
  }
  // Um amigo com rede ruim fica para trás repetidamente. O keyframe vai para TODOS (um encoder só)
  // e é grande: pedir um a cada queda dele trava a rede de todo mundo. Quedas seguidas do mesmo
  // amigo esperam cada vez mais (até 8 s) antes do próximo pedido; os keyframes pedidos pelos
  // outros continuam destravando ele.
  function flushPeer(p, noBackoff) {
    const now = Date.now();
    p.q.length = 0; p.waitingKey = true; p.flush = (p.flush || 0) + 1;
    p.backoff = !noBackoff && p.lastFlush && now - p.lastFlush < 10000 ? Math.min(8000, Math.max(1000, (p.backoff || 0) * 2)) : 0;
    p.lastFlush = now;
    p.keyAt = now + p.backoff;
    if (!p.backoff) reqKey(p.layer);
  }
  // enquanto alguém estiver esperando o primeiro keyframe, insiste a cada segundo
  // (o encoder quase não gera keyframes sozinho; um pedido perdido deixaria a tela preta)
  setInterval(() => {
    const asked = [false, false];
    for (const p of peers.values()) if (p.active && p.waitingKey && Date.now() >= (p.keyAt || 0) && !asked[p.layer]) { asked[p.layer] = true; reqKey(p.layer); }
    // diagnóstico: quantos quadros foram enviados/pulados/descartados por amigo
    const s = {};
    for (const [id, p] of peers) { s[id] = { layer: p.layer, all: p.all || 0, sent: p.sent || 0, empty: p.empty || 0, flush: p.flush || 0, kd: p.kd || 0, ex: p.ex || 0, q: p.q.length, native: p.native, active: p.active, wk: p.waitingKey, backoff: p.backoff || 0 }; p.all = p.sent = p.empty = p.flush = p.kd = p.ex = 0; }
    postMessage({ type: 'stats', peers: s });
  }, 1000);

  function get(id) {
    let p = peers.get(id);
    if (!p) { p = { q: [], waitingKey: true, active: false, native: false, sentAny: false, layer: 0 }; peers.set(id, p); }
    return p;
  }
  onmessage = (e) => {
    const m = e.data;
    if (m.type === 'frame') {
      const layer = m.layer || 0;
      const list = [...peers.values()].filter((p) => p.active && p.layer === layer);
      list.forEach((p, i) => {
        if (p.waitingKey) { if (!m.key) return; p.waitingKey = false; }
        p.q.push({ key: m.key, at: performance.now(), data: i === list.length - 1 ? m.data : m.data.slice(0) });
        // o encoder do Chromium ficou para trás: descarta e recomeça num keyframe
        if (p.q.length > (av1 ? 12 : 4)) flushPeer(p);
      });
    } else if (m.type === 'mode') {
      const p = get(m.id);
      const active = m.native && m.active;
      if (active && !p.active) { p.q.length = 0; p.waitingKey = true; p.sentAny = false; reqKey(p.layer); }
      p.native = m.native;
      p.active = active;
    } else if (m.type === 'layer') {
      // trocou de camada: a fila da outra não serve; espera um keyframe da nova
      const p = get(m.id);
      const layer = m.layer === 1 ? 1 : 0;
      if (p.layer !== layer) { p.layer = layer; p.q.length = 0; p.waitingKey = true; p.sentAny = false; if (p.active) reqKey(layer); }
    } else if (m.type === 'codec') {
      hevc = m.codec === 'hevc';
      av1 = m.codec === 'av1';
      lagMs = [750 / (m.fps > 0 ? m.fps : 60), 750 / (m.fpsLight > 0 ? m.fpsLight : 30)];
    } else if (m.type === 'reset') {
      for (const p of peers.values()) { p.q.length = 0; p.waitingKey = true; }
    } else if (m.type === 'remove') {
      peers.delete(m.id);
    } else if (m.type === 'trace') {
      if (m.dump) postMessage({ type: 'trace', ring: trace || [] }); else trace = m.on ? [] : null;
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
      if (!slotAsk || Date.now() - slotAsk > 500) { slotAsk = Date.now(); postMessage({ type: 'keyslot', layer: p.layer }); }
    } else if (keySlot && !(item && item.key)) {
      // o Chromium fez um keyframe (pedido de quem assiste): o nosso vem logo em seguida
      p.q.length = 0; p.waitingKey = true; item = null; reqKey(p.layer);
    }
    // fila crescendo sem keyframe na frente (o envio ficou para trás): recomeça num keyframe.
    // (mesmo limite da entrada: os quadros que chegam enquanto o keyframe espera o lugar dele
    //  não podem disparar isso logo depois, senão vira um ciclo de keyframes)
    // (AV1 sem a espera crescente: aqui a fila cresce de propósito enquanto o keyframe espera o lugar)
    if (item && p.q.length > 12 && !item.key) { flushPeer(p, true); item = null; }
    if (!item) { p.empty = (p.empty || 0) + 1; skip(frame, ctl); return; }
    p.q.shift();
    if (p.q.length && !p.q[0].key && performance.now() - item.at > lagMs[p.layer]) askExtra(p);
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
        if (frame.type === 'key') p.kd = (p.kd || 0) + 1;
        if (av1) { av1Slot(p, frame, ctl); return; }
        // quadro-chave da trilha vazia: não leva nada (explicação lá em cima)
        if (frame.type === 'key') { note(frame, -2, 0); skip(frame, ctl); if (p.q.length) askExtra(p); return; }
        const item = p.q.shift();
        if (!item) { p.empty = (p.empty || 0) + 1; note(frame, -1, 0); skip(frame, ctl); return; } // ainda sem quadro nosso: não envia nada
        // este quadro esperou demais e ainda tem outro atrás dele: faltou um quadro vazio
        if (p.q.length && performance.now() - item.at > lagMs[p.layer]) askExtra(p);
        note(frame, item.data.byteLength, item.key);
        frame.data = item.data;
        p.sentAny = true;
        p.sent = (p.sent || 0) + 1;
        ctl.enqueue(frame);
      },
    })).pipeTo(t.writable).catch(() => {});
  };`;

  const dbg = { dummy: 0, writeErr: null }; // diagnóstico (quadros vazios entregues ao WebRTC)
  let worker = null;
  let previewGen = null, previewWriter = null;
  let decoder = null, decoderReady = false, previewOn = true, inject = false;
  let running = false;
  let codec = 'h264'; // 'h264', 'hevc' ou 'av1' (o que o helper está gerando)
  let pushKey = null;   // teste sintético: pedido de keyframe vai para o gerador do teste
  let pushKeyLight = null; // (o mesmo, da versão leve)
  let lightOn = false;  // a versão leve está saindo do helper
  let traceCb = null;
  // cada camada: a trilha vazia (o gerador e quem escreve nele) e o ritmo dela
  //   altSize: AV1, alterna o tamanho da trilha vazia para o Chromium gerar um keyframe
  const lane = () => ({ generator: null, writer: null, lastTs: -1, frameNo: 0, altSize: false, lastDummyAt: 0, extraTimer: null,
    period: 1000 / 60, dummyW: 0, dummyH: 0, dummy: null });
  const lanes = [lane(), lane()];
  // quadro "vazio" que o Chromium codifica e nós trocamos pelo nosso. No H.265 precisa ser maior:
  // os encoders HEVC de hardware recusam 64x64 (e o Chromium não tem HEVC por software)
  let DW = 64, DH = 64;
  function makeDummy() {
    [DW, DH] = codec === 'hevc' ? [256, 144] : [64, 64];
    for (const l of lanes) { l.dummy = new Uint8Array((96 * 96 * 3) / 2 + DW * DH * 2); l.dummyW = l.dummyH = 0; } // cabe também o tamanho alternativo
  }
  makeDummy();

  function ensureWorker() {
    if (worker) return worker;
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (e) => {
      if (e.data.type === 'key') key(e.data.layer);
      else if (e.data.type === 'keyslot') { const l = lanes[e.data.layer === 1 ? 1 : 0]; l.altSize = !l.altSize; } // AV1: próximo quadro vazio da camada muda de tamanho
      else if (e.data.type === 'stats') window.NativeVideo.lastStats = e.data.peers;
      else if (e.data.type === 'extra') extraDummy(lanes[e.data.layer === 1 ? 1 : 0]);
      else if (e.data.type === 'trace' && traceCb) { const cb = traceCb; traceCb = null; cb(e.data.ring); }
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

    worker.postMessage({ type: 'frame', layer: 0, key, data }, [data]);

    // quadro vazio no mesmo ritmo: cada um "carrega" um quadro nosso
    if (ts <= lanes[0].lastTs) return;
    writeDummy(lanes[0], ts);
  }

  // versão leve: só vai para quem está na camada 1 (não tem prévia local), na trilha vazia dela
  function onLightFrame(buf) {
    if (!running || !inject || !lightOn) return;
    const key = (buf[0] & 1) === 1;
    const ts = Number(new DataView(buf.buffer, buf.byteOffset + 1, 8).getBigInt64(0, true));
    const data = buf.buffer.slice(buf.byteOffset + 9, buf.byteOffset + buf.byteLength);
    worker.postMessage({ type: 'frame', layer: 1, key, data }, [data]);
    if (ts <= lanes[1].lastTs) return;
    writeDummy(lanes[1], ts);
  }

  // Quadro vazio: cinza parado, só um cantinho de 8x8 muda a cada quadro. Antes a imagem inteira
  // mudava a cada quadro e o encoder de software do Chromium via "troca de cena" o tempo todo:
  // gerava um quadro-chave a cada 17 quadros (~3,5 por segundo) e cada um deles podia cortar o
  // quadro nosso que estava saindo (ver o comentário no worker).
  function writeDummy(l, ts) {
    if (!l.writer) return;
    l.lastTs = ts;
    l.lastDummyAt = performance.now();
    l.frameNo++;
    const w = l.altSize ? DW + 16 : DW, h = l.altSize ? DH + 16 : DH;
    if (w !== l.dummyW || h !== l.dummyH) { l.dummy.fill(128, 0, (w * h * 3) / 2); l.dummyW = w; l.dummyH = h; }
    const v = (l.frameNo * 37) & 255;
    for (let y = 0; y < 8; y++) l.dummy.fill(v, y * w, y * w + 8);
    const vf = new VideoFrame(l.dummy.subarray(0, (w * h * 3) / 2), { format: 'I420', codedWidth: w, codedHeight: h, timestamp: ts });
    dbg.dummy++;
    l.writer.write(vf).catch((e) => { dbg.writeErr = String(e && e.message || e); vf.close(); });
  }

  // O worker ficou com um quadro nosso sem quadro vazio para levá-lo: manda um a mais, no meio do
  // intervalo (o Chromium descarta quadros colados um no outro; e se o próximo quadro normal já
  // está para chegar, ele mesmo leva e o worker pede de novo se ainda sobrar).
  function extraDummy(l) {
    if (!running || !inject || !l.writer || l.lastTs < 0) return;
    const since = performance.now() - l.lastDummyAt;
    if (since < 3) { if (!l.extraTimer) l.extraTimer = setTimeout(() => { l.extraTimer = null; extraDummy(l); }, 3 - since); return; }
    if (since > l.period - 3) return;
    dbg.extra = (dbg.extra || 0) + 1;
    writeDummy(l, l.lastTs + Math.round(since * 1000));
  }

  // opts.inject = true: envio direto do H.264 nativo (só rede perfeita)
  // opts.inject = false: o WebRTC recodifica a trilha decodificada (adaptativo, padrão)
  // opts.codec: 'hevc' (H.265) ou 'h264'. opts.synthetic: teste automático, os quadros vêm de
  // push() em vez do helper (mesmo formato: [key][timestamp 8 bytes][Annex-B])
  // opts.light: { maxWidth, maxHeight, fps, kbps } pede também a versão leve (só no envio direto); a resposta diz se ela
  // saiu (light, lightTrack: a trilha vazia da camada 1). No teste sintético os quadros dela vêm de pushLight()
  async function start(opts) {
    await stop();
    ensureWorker();
    worker.postMessage({ type: 'reset' });
    inject = !!opts.inject;
    codec = opts.codec === 'hevc' || opts.codec === 'av1' ? opts.codec : 'h264';
    const fps = Number(opts.fps) > 0 ? Number(opts.fps) : 60;
    const wantLight = inject && !!opts.light;
    const fpsLight = wantLight && Number(opts.light.fps) > 0 ? Number(opts.light.fps) : 30;
    lanes[0].period = 1000 / fps;
    lanes[1].period = 1000 / fpsLight;
    worker.postMessage({ type: 'codec', codec, fps, fpsLight });
    pushKey = opts.synthetic && opts.onKey ? opts.onKey : null;
    pushKeyLight = opts.synthetic && opts.onKeyLight ? opts.onKeyLight : null;
    makeDummy();
    for (const [i, l] of lanes.entries()) {
      Object.assign(l, { generator: null, writer: null, lastTs: -1, frameNo: 0, altSize: false, lastDummyAt: 0 });
      if (inject && (i === 0 || wantLight)) {
        l.generator = new MediaStreamTrackGenerator({ kind: 'video' });
        l.generator.contentHint = 'motion';
        l.writer = l.generator.writable.getWriter();
      }
    }
    lightOn = wantLight;
    previewGen = new MediaStreamTrackGenerator({ kind: 'video' });
    previewWriter = previewGen.writable.getWriter();
    makePreviewDecoder();
    running = true;
    const light = () => (lightOn ? { light: true, lightTrack: lanes[1].generator } : { light: false, lightTrack: null });
    if (opts.synthetic) {
      return { track: inject ? lanes[0].generator : previewGen, preview: new MediaStream([previewGen]), width: opts.width, height: opts.height,
        encoder: 'teste', codec, push: (u8) => onFrame(u8), pushLight: (u8) => onLightFrame(u8), ...light() };
    }
    window.Helper.onVideo((ab) => onFrame(new Uint8Array(ab)));
    window.Helper.onVideoLight((ab) => onLightFrame(new Uint8Array(ab)));
    const { inject: _i, ...helperOpts } = opts;
    if (!wantLight) delete helperOpts.light;
    const res = await window.Helper.videoStart(helperOpts);
    if (res.type !== 'video-started') {
      await stop();
      throw new Error(res.message || 'falha ao iniciar a captura nativa');
    }
    // a placa não abriu o segundo encoder (ou o helper é antigo): segue só com a camada cheia
    if (wantLight && !res.light) {
      lightOn = false;
      dbg.lightErr = res.lightError || 'sem resposta';
      try { lanes[1].writer.close(); } catch {}
      try { lanes[1].generator.stop(); } catch {}
      lanes[1].writer = lanes[1].generator = null;
    }
    if (!inject) previewGen.contentHint = 'motion';
    return {
      track: inject ? lanes[0].generator : previewGen,
      preview: new MediaStream([previewGen]),
      width: res.width, height: res.height, encoder: res.encoder, codec: res.codec || 'h264', minQp: res.minQp || 0,
      lightWidth: res.lightWidth || 0, lightHeight: res.lightHeight || 0, ...light(),
    };
  }

  async function stop() {
    const was = running;
    running = false;
    lightOn = false;
    // Em variáveis próprias, antes de esperar o helper: um start() novo pode criar as trilhas dele
    // enquanto esta parada ainda espera (parar e transmitir de novo em seguida). Antes, ao voltar da
    // espera, esta parada fechava as trilhas do start novo: "captura nativa falhou" sem motivo.
    const old = lanes.map((l) => { clearTimeout(l.extraTimer); const o = { w: l.writer, g: l.generator }; l.extraTimer = l.writer = l.generator = null; return o; });
    const pw = previewWriter, pg = previewGen, d = decoder;
    previewWriter = previewGen = decoder = null;
    decoderReady = false;
    if (worker) worker.postMessage({ type: 'reset' });
    if (was) { try { await window.Helper.videoStop(); } catch {} }
    for (const o of old) { try { o.w && o.w.close(); } catch {} try { o.g && o.g.stop(); } catch {} }
    try { pw && pw.close(); } catch {}
    try { pg && pg.stop(); } catch {}
    try { d && d.state !== 'closed' && d.close(); } catch {}
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
  // camada de quem recebe: 0 = cheia, 1 = leve (só existe com hasLight())
  function setLayer(peerId, layer) { ensureWorker().postMessage({ type: 'layer', id: peerId, layer: layer === 1 ? 1 : 0 }); }
  const hasLight = () => running && inject && lightOn;
  function setPreview(on) {
    if (on && !previewOn) { decoderReady = false; window.Helper.videoKey(); }
    previewOn = on;
  }

  // pedido de keyframe (no teste automático vai para o gerador do teste); layer 1: o da versão leve
  function key(layer) {
    if (layer === 1) { if (!lightOn) return; if (pushKeyLight) pushKeyLight(); else window.Helper.videoKey(true); return; }
    if (pushKey) pushKey(); else window.Helper.videoKey();
  }
  // diagnóstico (testes): liga o registro quadro a quadro do transform e devolve o que foi registrado
  function trace(on) { ensureWorker().postMessage({ type: 'trace', on }); }
  function traceDump() { return new Promise((r) => { traceCb = r; ensureWorker().postMessage({ type: 'trace', dump: true }); }); }
  return { start, stop, attach, setMode, remove, setLayer, hasLight, setPreview, key, isRunning: () => running, dbg, trace, traceDump };
})();
