// Teste automático antes de publicar: abre duas cópias do app (perfis de teste, sem janela,
// sem áudio), conecta as duas numa sala local, uma transmite um vídeo sintético e a outra
// confere se recebe imagem, se o selo de status aparece e se o teste de conexão funciona.
// Uso: node scripts/smoke-test.js   (sai com código 1 se algo falhar)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 47911; // porta de teste (nunca a da sala de verdade)
const TIMEOUT_MS = 180000;
const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
const { createSignalingServer } = require(path.join(ROOT, 'src', 'signaling'));

// roda dentro de cada janela de teste; tudo que importa sai no console como "SMOKE ..."
const common = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('SMOKE ' + m);
window.addEventListener('error', (e) => log('ERRO ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('ERRO promessa ' + (e.reason && e.reason.message || e.reason)));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(250); }
  throw new Error('tempo esgotado: ' + what);
}
async function join(name) {
  // nunca captura o áudio do PC nos testes (process loopback mexe no serviço de áudio do Windows)
  localStorage.setItem('clipSys', '0');
  localStorage.setItem('mediactl', '0'); // nunca aperta tecla de mídia de verdade no teste
  localStorage.setItem('gamehide', '0'); // um jogo aberto no PC não pode esconder a prévia do teste
  await sleep(800);
  $('#name').value = name;
  checkName();
  joinRoom('127.0.0.1');
  await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala');
  await until(() => [...state.peers.values()].some((p) => p.pc.connectionState === 'connected'), 30000, 'conectar ao amigo');
  log('conectado');
}
`;

const scriptA = common + `
(async () => {
  try {
    await join('Teste A');
    // "tela" sintética: canvas animado (setInterval: funciona com a janela escondida)
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d'); let n = 0;
    setInterval(() => { n++; g.fillStyle = 'hsl(' + (n * 3 % 360) + ',60%,40%)'; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('quadro ' + n, 100, 360); }, 1000 / 30);
    const track = c.captureStream(30).getVideoTracks()[0];
    // áudio sintético BAIXO (tom de 440 Hz em ~-32 dB), só vai para a transmissão (não toca aqui)
    const ac = new AudioContext();
    const osc = ac.createOscillator(); const og = ac.createGain(); og.gain.value = 0.035;
    const dest = ac.createMediaStreamDestination();
    osc.connect(og); og.connect(dest); osc.start();
    const atrack = dest.stream.getAudioTracks()[0];
    state.share = { stream: new MediaStream([track]), video: track, audio: atrack, preview: new MediaStream([track]),
      settings: { ...state.settings, fps: 30 }, sourceName: 'Tela de teste', native: false, direct: false, width: 1280, height: 720 };
    if (!state.order.includes('me')) state.order.unshift('me');
    for (const p of state.peers.values()) { applySendParams(p); sendState(p.id); }
    render();
    log('transmitindo');
    // orçamento de upload: 80 Mb/s escolhidos, 1 amigo, orçamento padrão 60 -> 60 Mb/s para ele
    state.share.settings.bitrate = 80;
    for (const p of state.peers.values()) applySendParams(p);
    await sleep(1500);
    const pB = [...state.peers.values()][0];
    const enc = pB.vT.sender.getParameters().encodings[0];
    const expected = perPeerMbps(80, pB) * 1e6;
    if (enc.maxBitrate !== expected || expected > 80e6) throw new Error('orçamento de upload não aplicado: maxBitrate=' + enc.maxBitrate + ' esperado=' + expected);
    log('orçamento ok (' + enc.maxBitrate / 1e6 + ' Mb/s para 1 amigo; orçamento ' + uploadBudgetMbps() + ')');
    // responde "Pronto!" quando o B perguntar e avisa quando chegar pedido de play/pausa
    setInterval(() => { if (readyCheck && !readyCheck.ready.has(String(state.myId))) { markReady(); log('respondi pronto'); } }, 300);
    // "Nativa direta" em H.265: quadros HEVC (WebCodecs, placa) injetados pelo mesmo caminho do helper
    async function startSyntheticDirect() {
      const ni = await window.NativeVideo.start({ inject: true, synthetic: true, codec: 'hevc', width: 1280, height: 720 });
      const enc = new VideoEncoder({
        output: (chunk) => {
          const pkt = new Uint8Array(9 + chunk.byteLength);
          pkt[0] = chunk.type === 'key' ? 1 : 0;
          new DataView(pkt.buffer).setBigInt64(1, BigInt(chunk.timestamp), true);
          chunk.copyTo(pkt.subarray(9));
          ni.push(pkt);
        },
        error: (e) => log('ERRO encoder de teste ' + e.message),
      });
      enc.configure({ codec: 'hvc1.1.6.L120.90', width: 1280, height: 720, bitrate: 6e6, framerate: 30,
        hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', hevc: { format: 'annexb' } });
      let fn = 0;
      const t0 = performance.now();
      window.hevcIv = setInterval(() => {
        const vf = new VideoFrame(c, { timestamp: Math.round((performance.now() - t0) * 1000) });
        enc.encode(vf, { keyFrame: fn++ % 30 === 0 });
        vf.close();
      }, 1000 / 30);
      state.share.video = ni.track; state.share.preview = ni.preview; state.share.stream = new MediaStream([ni.track]);
      Object.assign(state.share, { native: true, direct: true, codec: 'hevc', width: 1280, height: 720 });
      for (const p of state.peers.values()) { applySendParams(p); sendState(p.id); }
    }
    // "Nativa direta" em AV1: quadros AV1 (WebCodecs) com o alinhamento de keyframes do app
    async function startSyntheticAv1() {
      clearInterval(window.hevcIv); // o gerador H.265 da fase anterior não pode misturar quadros
      let wantKey = true;
      const ni = await window.NativeVideo.start({ inject: true, synthetic: true, codec: 'av1', width: 1280, height: 720, onKey: () => { wantKey = true; } });
      const enc = new VideoEncoder({
        output: (chunk) => {
          const pkt = new Uint8Array(9 + chunk.byteLength);
          pkt[0] = chunk.type === 'key' ? 1 : 0;
          new DataView(pkt.buffer).setBigInt64(1, BigInt(chunk.timestamp), true);
          chunk.copyTo(pkt.subarray(9));
          ni.push(pkt);
        },
        error: (e) => log('ERRO encoder AV1 de teste ' + e.message),
      });
      enc.configure({ codec: 'av01.0.08M.08', width: 1280, height: 720, bitrate: 6e6, framerate: 30, latencyMode: 'realtime' });
      const t0 = performance.now();
      let fn = 0;
      window.av1Iv = setInterval(() => {
        const vf = new VideoFrame(c, { timestamp: Math.round((performance.now() - t0) * 1000) });
        enc.encode(vf, { keyFrame: wantKey || ++fn % 240 === 0 }); wantKey = false;
        vf.close();
      }, 1000 / 30);
      state.share.video = ni.track; state.share.preview = ni.preview; state.share.stream = new MediaStream([ni.track]);
      Object.assign(state.share, { native: true, direct: true, codec: 'av1', width: 1280, height: 720 });
      for (const p of state.peers.values()) { applySendParams(p); sendState(p.id); }
    }
    const av1Iv = setInterval(async () => {
      if (!/smoke-av1-pedido/.test($('#chat-log').textContent)) return;
      clearInterval(av1Iv);
      try { await startSyntheticAv1(); log('direta AV1 ligada'); sendRelay(null, { kind: 'chat', text: 'smoke-av1-ligada' }); }
      catch (e) { log('ERRO direta AV1: ' + e.message); }
    }, 300);
    // 2ª tela sintética (960x540)
    const s2Iv = setInterval(() => {
      if (!/smoke-s2-pedido/.test($('#chat-log').textContent)) return;
      clearInterval(s2Iv);
      const c2 = document.createElement('canvas'); c2.width = 960; c2.height = 540;
      const g2 = c2.getContext('2d'); let m = 0;
      setInterval(() => { m++; g2.fillStyle = '#204060'; g2.fillRect(0, 0, 960, 540); g2.fillStyle = '#fff'; g2.font = '60px sans-serif'; g2.fillText('tela 2 · ' + m, 60, 280); }, 1000 / 30);
      const t2 = c2.captureStream(30).getVideoTracks()[0];
      state.share2 = { stream: new MediaStream([t2]), video: t2, sourceName: 'Tela 2 de teste', source: { id: 'teste2' } };
      for (const p of state.peers.values()) { applySendParams(p); sendState(p.id); }
      render();
      log('2ª tela ligada');
    }, 300);
    const directIv = setInterval(async () => {
      if (!/smoke-direct-pedido/.test($('#chat-log').textContent)) return;
      clearInterval(directIv);
      try {
        await startSyntheticDirect(); log('direta H.265 ligada'); sendRelay(null, { kind: 'chat', text: 'smoke-direct-ligada' });
      }
      catch (e) { log('ERRO direta: ' + e.message); }
    }, 300);
    // desenho do B chegando na minha tela
    let inkSeen = false;
    setInterval(() => { if (!inkSeen && meTile && meTile.trailLines && meTile.trailLines.some((l) => l.life)) { inkSeen = true; log('recebi desenho da caneta'); } }, 200);
    window.inkCheck = () => inkSeen;
    setTimeout(async () => { for (const p of state.peers.values()) { let o = ''; (await p.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') o += JSON.stringify({ sent: r.framesSent, enc: r.framesEncoded, w: r.frameWidth, lim: r.qualityLimitationReason }); }); log('envio ' + o + ' trilha=' + p.vT.sender.track + ' estado=' + track.readyState); } }, 8000);
    // espera o B terminar (ele sai da sala) ou o tempo acabar
    await until(() => state.peers.size === 0, 165000, 'B terminar');
    if (!window.inkCheck()) throw new Error('o desenho da caneta do B não chegou');
    log('A OK');
  } catch (e) { log('FALHOU A: ' + e.message); }
  setTimeout(() => window.close(), 300);
})();
`;

const scriptB = common + `
(async () => {
  try {
    await join('Teste B');
    const peer = () => [...state.peers.values()][0];
    await until(() => peer().sharing && peer().tile, 20000, 'receber o aviso de transmissão');
    // imagem chegando e sendo decodificada
    let v = null;
    await until(async () => {
      // a maior das trilhas de vídeo recebidas (a outra é a da câmera, vazia)
      (await peer().pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video' && (!v || r.framesDecoded > v.framesDecoded)) v = r; });
      return v && v.framesDecoded > 60 && v.frameWidth > 0;
    }, 30000, 'decodificar vídeo');
    log('video ' + v.frameWidth + 'x' + v.frameHeight + ' decodificados=' + v.framesDecoded);
    // codec negociado: no "Automático" tem que ser H.265 quando a placa suporta
    let codec = '?';
    (await peer().pc.getStats()).forEach((r) => { if (r.type === 'codec' && r.id === v.codecId) codec = r.mimeType; });
    const h265 = RTCRtpReceiver.getCapabilities('video').codecs.some((c) => /h265/i.test(c.mimeType));
    if (h265 && !/h265/i.test(codec)) throw new Error('esperava H.265 no automático, veio ' + codec);
    log('codec ' + codec);
    // medição automática do upload (feita sozinha ao conectar)
    await until(() => peer().upMbps > 5, 25000, 'medição automática do upload');
    log('upload medido sozinho: ' + peer().upMbps + ' Mb/s; orçamento ' + state.settings.uploadMbps + '; teto ' + perPeerMbps(80, peer()));
    await until(() => peer().tile.video.videoWidth > 0, 10000, 'mostrar o vídeo na tela');
    // selo de status (fps/ping)
    await until(() => /fps/.test(peer().tile.qtext.textContent), 15000, 'selo de status');
    log('selo "' + peer().tile.qtext.textContent + '"');
    // som da tela: chega no Web Audio, continua mudo (nada sai nas caixas) e o nivelador reforça o tom baixo
    const ta = peer().tile.audio;
    await until(() => ta && ta.nodes && ta.boost > 1.8, 15000, 'nivelador reforçar o áudio baixo (boost=' + (ta && ta.boost) + ')');
    if (!peer().tile.isMuted() || ta.nodes.user.gain.value !== 0) throw new Error('a tela deveria continuar muda');
    log('nivelador: nível ' + ta.level.toFixed(1) + ' dB, reforço ' + ta.boost.toFixed(2) + 'x (mudo)');
    peer().tile.setVolume(2.5); peer().tile.setMuted(true); // volume acima de 100% sem tocar nada
    if (peer().tile.getVolume() !== 2.5) throw new Error('volume acima de 100% não aceito');
    // teste de conexão pelo canal de dados
    await runNetTest();
    const txt = $('#nettest-body').textContent;
    if (!/Sugestão/.test(txt)) throw new Error('teste de conexão sem resultado: ' + txt.slice(0, 200));
    log('teste de conexão: ' + txt.replace(/\\s+/g, ' ').slice(0, 220));
    // gravação longa da tela do A por ~4 s
    $('#nettest-modal').classList.add('hidden');
    await toggleRecording(peer().id);
    if (!window.Clips.isRecording(peer().id)) throw new Error('gravação não começou');
    await sleep(4000);
    const info = window.Clips.recInfo(peer().id);
    const rec = await window.Clips.stopRecording(peer().id);
    if (!rec || !rec.file || rec.bytes < 50000) throw new Error('gravação vazia: ' + JSON.stringify(rec || info));
    log('gravação ' + Math.round(rec.bytes / 1000) + ' KB em ' + rec.file);
    console.log('SMOKEFILE ' + rec.file);
    // assistir junto: "todo mundo pronto?" -> contagem 3-2-1 nos dois
    startReadyCheck();
    await until(() => $('#countdown').textContent === 'Já!', 15000, 'contagem do "todo mundo pronto?"');
    log('contagem ok');
    // play/pausa sem permissão: o A recusa (não aperta nada)
    const toasts = () => [...document.querySelectorAll('#toasts > *')].map((t) => t.textContent).join(' | ');
    requestMedia(peer().id);
    await until(() => /não liberou/.test(toasts()), 8000, 'resposta do pedido de play/pausa');
    log('play/pausa recusado corretamente');
    // caneta: desenha na tela do A (eventos de mouse simulados) e confere que chegou lá
    const t = peer().tile;
    t.penBtn.click();
    const r = t.video.getBoundingClientRect();
    const ev = (type, fx, fy, buttons) => t.video.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, buttons, pointerId: 1, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
    ev('pointerdown', 0.2, 0.2, 1);
    for (let i = 1; i <= 10; i++) ev('pointermove', 0.2 + i * 0.03, 0.2 + i * 0.02, 1);
    ev('pointerup', 0.5, 0.4, 0);
    if (!(t.trailLines && t.trailLines.length >= 5)) throw new Error('caneta não desenhou localmente');
    await sleep(1500);
    log('caneta desenhou ' + t.trailLines.length + ' traços');
    t.penBtn.click(); // desliga a caneta
    // zoom: Ctrl + rodinha no meio da tela do A
    const zr = t.el.getBoundingClientRect();
    for (let i = 0; i < 3; i++) t.el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: zr.left + zr.width / 2, clientY: zr.top + zr.height / 2 }));
    const zoomed = t.zoom.s;
    if (!(zoomed > 1.9) || !/scale/.test(t.video.style.transform) || t.el.querySelector('.zoom-badge').classList.contains('hidden')) throw new Error('zoom não aplicou: ' + zoomed);
    t.resetZoom();
    if (t.zoom.s !== 1 || t.video.style.transform) throw new Error('zoom não voltou');
    log('zoom ok (' + Math.round(zoomed * 100) + '% e voltou)');
    // atraso por amigo: automático -> mínimo -> lisa (buffer de 0,35 s no receptor)
    cycleLatency(peer().id); cycleLatency(peer().id);
    const jb = peer().pc.getReceivers().filter((r) => r.track && r.track.kind === 'video').map((r) => r.jitterBufferTarget);
    if (!jb.every((x) => x === 350)) throw new Error('modo "imagem lisa" não aplicou: ' + JSON.stringify(jb));
    cycleLatency(peer().id); // volta ao automático
    log('atraso por amigo ok');
    // diagnóstico do amigo com um clique
    requestDiag(peer());
    const toastsD = () => [...document.querySelectorAll('#toasts > *')].map((x) => x.textContent).join(' | ');
    await until(() => /Diagnóstico de Teste A salvo/.test(toastsD()), 30000, 'diagnóstico do amigo chegar');
    const f = /: (TelaAmigos-diagnostico-Teste A-[^ |]+\.txt)/.exec(toastsD());
    console.log('SMOKEDIAG ' + (f ? f[1] : '?'));
    log('diagnóstico do amigo chegou: ' + (f ? f[1] : '?'));
    // resolução escolhida por quem assiste: 480p só para mim
    setResMode(peer().id, '480');
    const inMain = async () => { let v2 = null; (await peer().pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video' && (!v2 || r.framesDecoded > v2.framesDecoded)) v2 = r; }); return v2; };
    await until(async () => { const x = await inMain(); return x && x.frameHeight > 0 && x.frameHeight <= 480; }, 15000, 'receber em 480p');
    log('resolução escolhida ok (' + (await inMain()).frameHeight + 'p)');
    setResMode(peer().id, 'auto');
    await until(async () => (await inMain()).frameHeight === 720, 15000, 'voltar ao original');
    // foto da tela
    const shot = await takeShot(peer().id);
    if (!shot) throw new Error('foto não salvou');
    console.log('SMOKESHOT ' + shot);
    log('foto salva');
    // histórico da qualidade
    await until(() => (state.hist.get('Teste A') || []).length >= 3, 15000, 'histórico juntar pontos');
    openHistory(peer().id);
    const hc = $('#hist-canvas');
    const hr = hc.getBoundingClientRect();
    hc.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: hr.right - 30, clientY: hr.top + 60 }));
    if (!/fps/.test($('#hist-summary').textContent) || $('#hist-tip').classList.contains('hidden') || !/fps/.test($('#hist-tip').textContent)) {
      throw new Error('histórico não desenhou: ' + $('#hist-summary').textContent + ' | ' + $('#hist-tip').textContent);
    }
    log('histórico: ' + $('#hist-summary').textContent);
    closeHistory();
    // 2ª tela: chega na bolha do canto; trocar põe ela grande (e o A passa a mandar em qualidade cheia)
    sendRelay(null, { kind: 'chat', text: 'smoke-s2-pedido' });
    await until(() => peer().share2 && peer().tile.s2.video.videoWidth > 0, 20000, 'receber a 2ª tela');
    if (peer().iWant2 !== 'thumb') throw new Error('2ª tela deveria vir como miniatura: ' + peer().iWant2);
    log('2ª tela chegou (' + peer().tile.s2.video.videoWidth + 'x' + peer().tile.s2.video.videoHeight + ') no canto');
    swapScreens(peer().id);
    if (peer().tile.video.srcObject !== peer().screen2Stream || peer().iWant2 !== 'full' || peer().iWant !== 'thumb') throw new Error('troca de telas não aplicou');
    await until(() => peer().tile.video.videoWidth === 960, 10000, 'mostrar a 2ª tela grande');
    swapScreens(peer().id);
    if (peer().tile.video.srcObject !== peer().remoteStream || peer().iWant !== 'full') throw new Error('não voltou para a 1ª tela');
    toggleS2Bubble(peer().id);
    if (peer().iWant2 !== 'off' || !peer().tile.s2.box.classList.contains('hidden')) throw new Error('esconder a 2ª tela não aplicou');
    toggleS2Bubble(peer().id);
    log('2ª tela: trocar e esconder ok');
    // "Nativa direta" em H.265
    sendRelay(null, { kind: 'chat', text: 'smoke-direct-pedido' });
    await until(() => /smoke-direct-ligada/.test($('#chat-log').textContent), 15000, 'A ligar a direta em H.265');
    const inV = async () => { let v2 = null; (await peer().pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video' && (!v2 || r.framesDecoded > v2.framesDecoded)) v2 = r; }); return v2; };
    await sleep(2500);
    const d0 = await inV();
    await sleep(3000);
    const d1 = await inV();
    let dcodec = '?';
    (await peer().pc.getStats()).forEach((r) => { if (r.type === 'codec' && r.id === d1.codecId) dcodec = r.mimeType; });
    const got = d1.framesDecoded - d0.framesDecoded;
    if (!/h265/i.test(dcodec) || d1.frameWidth !== 1280 || got < 40) {
      throw new Error('direta H.265 não chegou certo: ' + JSON.stringify({ codec: dcodec, w: d1.frameWidth, h: d1.frameHeight, quadros3s: got }));
    }
    log('direta H.265 ok: ' + d1.frameWidth + 'x' + d1.frameHeight + ', ' + got + ' quadros em 3 s, ' + dcodec);
    // "Nativa direta" em AV1 (nosso keyframe só vai em lugar de keyframe do Chromium)
    sendRelay(null, { kind: 'chat', text: 'smoke-av1-pedido' });
    await until(() => /smoke-av1-ligada/.test($('#chat-log').textContent), 15000, 'A ligar a direta em AV1');
    let acodec = '?', a0 = null;
    await until(async () => {
      const x = await inV();
      (await peer().pc.getStats()).forEach((r) => { if (x && r.type === 'codec' && r.id === x.codecId) acodec = r.mimeType; });
      if (/av1/i.test(acodec) && x.frameWidth === 1280) { a0 = x; return true; }
      return false;
    }, 15000, 'receber AV1 1280x720');
    await sleep(3000);
    const a1 = await inV();
    const gotA = a1.framesDecoded - a0.framesDecoded;
    if (gotA < 70) throw new Error('direta AV1 com poucos quadros: ' + gotA + ' em 3 s');
    log('direta AV1 ok: ' + a1.frameWidth + 'x' + a1.frameHeight + ', ' + gotA + ' quadros em 3 s, ' + acodec + ', dec ' + a1.decoderImplementation);
    // proteção: a interface "caiu" transmitindo em H.265 -> H.265 bloqueado só para enviar
    localStorage.setItem('sendingCodec', 'H265');
    if (!checkCodecCrash('crashed') || localStorage.getItem('codecBad:H265') !== '1') throw new Error('proteção de codec não marcou');
    const prefs = window.Sdp.codecPreferences('auto') || [];
    if (prefs.some((c) => /h265/i.test(c.mimeType)) || window.Sdp.h265OnlyPreferences() !== null) throw new Error('H.265 bloqueado ainda aparece');
    localStorage.removeItem('codecBad:H265');
    log('proteção contra codec que derruba o app ok');
    log('B OK');
  } catch (e) {
    const p = [...state.peers.values()][0];
    let info = '';
    try { (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') info += JSON.stringify({ rx: r.packetsReceived, fr: r.framesReceived, dec: r.framesDecoded, w: r.frameWidth, codec: r.codecId }); }); } catch {}
    log('FALHOU B: ' + e.message + ' | ' + info + ' sharing=' + (p && p.sharing) + ' track=' + (p && p.remoteStream.getVideoTracks().length));
  }
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 500);
})();
`;

function runInstance(name, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-smoke-'));
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, script);
  const env = {
    ...process.env, TELA_PROFILE: `smoke-${name}`, TELA_PORT: String(PORT),
    TELA_TEST_SCRIPT: file, TELA_TEST_HIDDEN: '1', ELECTRON_ENABLE_LOGGING: '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const files = [];
  const diags = [];
  let rest = '';
  child.stdout.on('data', (d) => {
    rest += d.toString();
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const l of parts) {
      const f = /SMOKEFILE (.*)$/.exec(l);
      if (f) { files.push(f[1].trim()); continue; }
      const sh = /SMOKESHOT (.*)$/.exec(l);
      if (sh) { files.push('shot:' + sh[1].trim()); continue; }
      const dg = /SMOKEDIAG (.*)$/.exec(l);
      if (dg) { diags.push(dg[1].trim()); continue; }
      const m = /SMOKE (.*)$/.exec(l);
      if (m) { lines.push(m[1]); console.log(`  [${name}] ${m[1]}`); }
    }
  });
  child.stderr.on('data', () => {});
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, lines, files, diags, done };
}

async function main() {
  console.log('Teste automático: duas cópias do app conectando e transmitindo...');
  const server = await createSignalingServer(PORT);
  const a = runInstance('a', scriptA);
  await new Promise((r) => setTimeout(r, 1500));
  const b = runInstance('b', scriptB);
  let timer;
  const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), TIMEOUT_MS); });
  const result = await Promise.race([Promise.all([a.done, b.done]), timedOut]);
  clearTimeout(timer);
  for (const x of [a, b]) if (x.child.exitCode == null) { try { x.child.kill(); } catch {} } // só as cópias de teste
  try { server.close(); } catch {}
  const all = [...a.lines, ...b.lines];
  const errors = all.filter((l) => /^ERRO|^FALHOU/.test(l));
  // a gravação precisa ser um MP4 de verdade (caixa "ftyp" no começo, "moof" = fragmentado)
  for (const f0 of b.files.filter((x) => x.startsWith('shot:'))) {
    const f = f0.slice(5);
    try {
      const buf = fs.readFileSync(f);
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (buf.readUInt32BE(0) !== 0x89504e47 || w !== 1280 || h !== 720) errors.push(`foto errada: ${w}x${h}`);
      else console.log(`  foto válida (${w}x${h}, ${Math.round(buf.length / 1000)} KB)`);
      fs.unlinkSync(f);
    } catch (e) { errors.push(`foto ilegível: ${e.message}`); }
  }
  for (const f of b.files.filter((x) => !x.startsWith('shot:'))) {
    try {
      const head = fs.readFileSync(f).subarray(0, 64 * 1024);
      if (head.toString('latin1', 4, 8) !== 'ftyp' || !head.includes('moof')) errors.push(`gravação não parece MP4: ${f}`);
      else {
        console.log(`  gravação válida (${Math.round(fs.statSync(f).size / 1000)} KB)`);
        // se o ffprobe estiver instalado, confere que o vídeo abre e tem a duração certa
        try {
          const dur = Number(require('child_process').execFileSync('ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
          if (!(dur > 2.5 && dur < 8)) errors.push(`gravação com duração estranha: ${dur}s`);
          else console.log(`  ffprobe: ${dur.toFixed(1)} s`);
        } catch (e) { if (e.code !== 'ENOENT') errors.push(`ffprobe não abriu a gravação: ${String(e.stderr || e.message).slice(0, 200)}`); }
      }
      fs.unlinkSync(f);
    } catch (e) { errors.push(`gravação ilegível: ${e.message}`); }
  }
  // diagnóstico que veio do A: completo (parte do app e do processo principal)
  for (const name of b.diags) {
    const f = path.join(process.env.APPDATA, 'Tela Amigos', 'smoke-b', name);
    try {
      const t = fs.readFileSync(f, 'utf8');
      if (!/Tela Amigos v\d/.test(t) || !/nome=Teste A/.test(t) || !/===== registro em arquivo/.test(t)) errors.push('diagnóstico do amigo incompleto');
      else console.log(`  diagnóstico do amigo completo (${Math.round(t.length / 1000)} KB)`);
      fs.unlinkSync(f);
    } catch (e) { errors.push(`diagnóstico do amigo ilegível: ${e.message}`); }
  }
  const ok = result !== 'timeout' && a.lines.includes('A OK') && b.lines.includes('B OK') && !errors.length;
  if (!ok) {
    console.error(`\nTESTE FALHOU${result === 'timeout' ? ' (tempo esgotado)' : ''}:\n  ${errors.join('\n  ') || 'sem mensagem de erro'}`);
    process.exit(1);
  }
  console.log('\nTeste automático passou.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
