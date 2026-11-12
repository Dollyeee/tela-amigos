// Teste da "Nativa direta" com o helper de VERDADE (captura da tela 1 + encoder da placa), de ponta a
// ponta: duas cópias escondidas do app; A transmite e B assiste. Sem áudio (o teste nunca liga som).
//   node scripts/direct-test.js [H264|HEVC|AV1] [segundos]      (-v mostra a linha do tempo inteira)
//
// O teste automático (smoke-test.js) usa quadros sintéticos por poucos segundos e não pega o que este
// pega. Confere, a cada 250 ms dos dois lados:
//  - quem assiste recebe ~60 quadros/s sem ficar parado (3 janelas seguidas quase vazias = falha);
//  - TODO quadro que saiu do transform chegou montado no receptor (cruzado pelo timestamp RTP). Foi
//    assim que apareceu o defeito corrigido na v1.0.58: um quadro-chave da trilha vazia fazia o
//    Chromium jogar fora o quadro da placa que estava saindo, sem perda de pacote aparente;
//  - a trilha vazia quase não gera quadros-chave sozinha (se voltar a gerar vários por segundo, uma
//    versão nova do Chromium mudou alguma coisa: ver native-video.js);
//  - no fim, a versão leve (2ª qualidade, o segundo encoder do helper): B passa a ver a tela de A em miniatura e
//    tem de receber a leve (até 540 linhas, ~30 quadros/s); depois volta para a cheia.
// Rodar depois de trocar a versão do Electron ou de mexer no native-video.js / no helper.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
const { createSignalingServer } = require(path.join(ROOT, 'src', 'signaling'));
const PORT = 47911;
const args = process.argv.slice(2).filter((a) => a !== '-v');
const VERBOSE = process.argv.includes('-v');
const CODEC = (args[0] || 'H264').toUpperCase();
const SECS = Number(args[1]) || 14;

const common = `
const SECS = ${SECS};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => ((Date.now() % 1000000) / 1000).toFixed(2);
const log = (m) => console.log('SMOKE ' + clock() + ' ' + m);
window.addEventListener('error', (e) => log('ERRO ' + e.message));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(100); }
  throw new Error('tempo esgotado: ' + what);
}
async function join(name) {
  localStorage.setItem('clipSys', '0'); localStorage.setItem('mediactl', '0'); localStorage.setItem('gamehide', '0'); localStorage.setItem('autoMeasure', '0');
  await sleep(800);
  $('#name').value = name; checkName();
  joinRoom('127.0.0.1');
  await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala');
  await until(() => [...state.peers.values()].some((p) => p.pc.connectionState === 'connected'), 30000, 'conectar ao amigo');
  log('conectado');
}
`;

const scriptA = common + `
(async () => {
  try {
    await join('DIRETA A');
    await sleep(1500);
    await loadSources('screen');
    selectedSource = sources.find((x) => x.type === 'screen');
    if (!selectedSource) throw new Error('nenhuma tela para capturar');
    $('#opt-engine').value = 'native-direct'; $('#opt-res').value = '1080'; $('#opt-fps').value = '60'; $('#opt-mode').value = 'motion';
    if (${JSON.stringify(CODEC)} === 'HEVC') localStorage.setItem('av1', '0'); else localStorage.removeItem('av1'); // sem AV1 = a direta cai no H.265
    $('#opt-codec').value = ${JSON.stringify(CODEC === 'HEVC' ? 'H265' : CODEC)}; $('#opt-bitrate').value = 12;
    $('#opt-audio').innerHTML = '<option value="none">Sem áudio</option>'; $('#opt-audio').value = 'none'; // nunca captura som no teste
    // entre duas cópias no mesmo PC a estimativa de banda do WebRTC às vezes desaba no começo; a
    // "resolução inteligente" então reiniciava a captura em 720p no meio da medição (o helper passa
    // por 0 quadros/s e o teste acusava falha sem haver defeito)
    localStorage.setItem('smartRes', '0');
    window.NativeVideo.trace(true);
    await startShare();
    if (!state.share) throw new Error('não começou a transmitir');
    if (!state.share.direct) throw new Error('não ficou na nativa direta (nativo=' + state.share.native + ')');
    if (state.share.audio) throw new Error('o teste ligou o áudio');
    log('transmitindo: ' + state.share.width + 'x' + state.share.height + ' ' + state.share.codec + ' · ' + state.share.encoder + ' · piso de QP ' + (state.share.minQp || 'sem') + ' · começo ' + state.nativeKbps + ' kb/s');
    log('versão leve: ' + (state.share.videoLight ? 'ligada ' + state.share.lightKbps + ' kb/s' : 'desligada (' + (window.NativeVideo.dbg.lightErr || '?') + ')'));
    const peer = () => [...state.peers.values()][0];
    const pid = peer().id;
    let po = null, stop = false, lastW = null;
    const sum = { secs: 0, kd: 0, ex: 0, flush: 0, empty: 0, late: 0, dropped: 0, fpsMin: 999 };
    const t0 = Date.now();
    (async () => { await until(() => /fim-b/.test($('#chat-log').textContent), (SECS + 60) * 1000, 'B terminar').catch(() => {}); stop = true; })();
    while (!stop) {
      await sleep(250);
      let o = null; (await peer().pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video' && String(r.mid) === String(peer().vT.mid)) o = r; });
      if (!o) continue;
      const ns = state.nativeStats || {};
      const w = (window.NativeVideo.lastStats || {})[pid] || {};
      // as estatísticas do worker saem 1 vez por segundo: soma cada uma só uma vez, depois dos 3 s do começo
      if (window.NativeVideo.lastStats !== lastW) {
        lastW = window.NativeVideo.lastStats;
        if (Date.now() - t0 > 3000) { sum.secs++; sum.kd += w.kd || 0; sum.ex += w.ex || 0; sum.flush += w.flush || 0; sum.empty += w.empty || 0; sum.late += ns.late || 0; sum.dropped += ns.dropped || 0; sum.fpsMin = Math.min(sum.fpsMin, ns.fps || 0); }
      }
      if (po) {
        const d = (k) => (o[k] || 0) - (po[k] || 0);
        if (d('framesSent') < 11 || d('framesSent') > 19 || d('pliCount') || d('nackCount') || (w.flush || 0))
          log('  A env+' + d('framesSent') + ' pac+' + d('packetsSent') + ' kB+' + Math.round(d('bytesSent') / 1000) + ' pli+' + d('pliCount') + ' nack+' + d('nackCount') + ' | helper fps=' + ns.fps + ' cap=' + ns.captureFps + ' late=' + ns.late + ' drop=' + ns.dropped + ' | worker ' + JSON.stringify(w) + ' | alvo=' + state.nativeKbps + ' estimativa=' + Math.round(state.netInfo.avail || 0));
      }
      po = o;
    }
    const ring = await window.NativeVideo.traceDump();
    for (const f of ring) log('S ' + f[2] + ' ' + f[1] + ' ' + f[3] + ' ' + f[4] + ' ' + (f[0] / 1000).toFixed(3));
    log('RESUMO-A ' + JSON.stringify({ ...sum, codec: state.share.codec, alvo: state.nativeKbps, bwe: Math.round(state.netInfo.avail || 0), rede: state.netInfo.level }));
    log('A OK');
  } catch (e) { log('FALHOU A: ' + e.message); }
  await sleep(500);
  await stopShare().catch(() => {});
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 800);
})();`;

const scriptB = common + `
(async () => {
  try {
    const peer = () => [...state.peers.values()][0];
    // transform de recepção só para registrar o timestamp RTP de cada quadro MONTADO (ligado no evento
    // "track": depois que o receptor está configurado o Chromium não entrega mais nada a ele)
    const wsrc = [
      'let n = 0; const ring = [];',
      'onrtctransform = (e) => { const t = e.transformer; t.readable.pipeThrough(new TransformStream({ transform(frame, ctl) { n++; let ts = null; try { ts = frame.getMetadata().rtpTimestamp; } catch (err) {} ring.push(ts); if (ring.length > 20000) ring.shift(); ctl.enqueue(frame); } })).pipeTo(t.writable).catch(() => {}); };',
      'onmessage = (e) => { if (e.data === "dump") postMessage({ n, ring }); };',
    ].join(' ');
    const rxw = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'text/javascript' })));
    const dump = () => new Promise((r) => { rxw.onmessage = (e) => r(e.data); rxw.postMessage('dump'); });
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new OrigPC(...a);
      pc.addEventListener('track', (e) => { if (e.track.kind === 'video' && !pc.__rx) { pc.__rx = true; e.receiver.transform = new RTCRtpScriptTransform(rxw, {}); } });
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
    await join('DIRETA B');
    await until(() => peer().sharing && peer().tile, 40000, 'ver a tela de A');
    const st = async () => { let v = null, c = '?'; const rep = await peer().pc.getStats(); rep.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video' && (!v || (x.framesDecoded || 0) > (v.framesDecoded || 0))) v = x; }); if (v && v.codecId && rep.get(v.codecId)) c = rep.get(v.codecId).mimeType; if (v) v.mime = c; return v; };
    await until(async () => { const s = await st(); return s && s.framesDecoded > 0; }, 40000, 'decodificar');
    await sleep(1500); // os primeiros quadros-chave do começo da transmissão
    let prev = await st(); const first = prev; let holes = 0, worst = 0, run = 0;
    const end = Date.now() + SECS * 1000;
    while (Date.now() < end) {
      await sleep(250);
      const cur = await st(); if (!cur) continue;
      const d = (k) => (cur[k] || 0) - (prev[k] || 0);
      const low = d('framesReceived') < 10;
      if (low) { holes++; run++; worst = Math.max(worst, run); } else run = 0;
      if (low || d('pliCount') || d('nackCount') || d('freezeCount') || d('framesDropped'))
        log('  B rec+' + d('framesReceived') + ' dec+' + d('framesDecoded') + ' key+' + d('keyFramesDecoded') + ' pac+' + d('packetsReceived') + ' perd+' + d('packetsLost') + ' pli+' + d('pliCount') + ' nack+' + d('nackCount') + ' trav+' + d('freezeCount') + ' desc+' + d('framesDropped'));
      prev = cur;
    }
    const dd = (k) => (prev[k] || 0) - (first[k] || 0);
    const dp = await dump();
    for (let i = 0; i < dp.ring.length; i += 400) log('Q ' + dp.ring.slice(i, i + 400).join(','));
    log('RESUMO-B ' + JSON.stringify({ secs: SECS, w: prev.frameWidth, h: prev.frameHeight, mime: prev.mime, fps: +(dd('framesDecoded') / SECS).toFixed(1), rec: dd('framesReceived'), kbps: Math.round(dd('bytesReceived') * 8 / SECS / 1000),
      keys: dd('keyFramesDecoded'), pli: dd('pliCount'), nack: dd('nackCount'), lost: dd('packetsLost'), freezes: dd('freezeCount'), frozen: +((prev.totalFreezesDuration || 0) - (first.totalFreezesDuration || 0)).toFixed(2), holes, worst, buffer: dd('jitterBufferEmittedCount') ? Math.round(dd('jitterBufferDelay') / dd('jitterBufferEmittedCount') * 1000) : null }));
    // versão leve: vendo a tela de A em miniatura, chega a leve do segundo encoder do helper; depois, a cheia de volta
    sendRelay(peer().id, { kind: 'want', level: 'thumb', maxH: 0 });
    try {
      let l1 = null;
      await until(async () => { const s = await st(); if (s && s.frameHeight > 0 && s.frameHeight <= 540) { l1 = s; return true; } return false; }, 15000, 'receber a versão leve');
      await sleep(3000);
      const l2 = await st();
      log('LEVE ' + JSON.stringify({ w: l2.frameWidth, h: l2.frameHeight, fps: +((l2.framesDecoded - l1.framesDecoded) / 3).toFixed(1) }));
    } catch (e) { log('LEVE falhou: ' + e.message); }
    sendRelay(peer().id, { kind: 'want', level: 'full', maxH: 0 });
    await until(async () => { const s = await st(); return s && s.frameHeight > 540; }, 15000, 'voltar para a cheia').then(() => log('CHEIA de volta')).catch((e) => log('CHEIA falhou: ' + e.message));
    sendRelay(null, { kind: 'chat', text: 'fim-b' });
    log('B OK');
  } catch (e) { log('FALHOU B: ' + e.message); try { sendRelay(null, { kind: 'chat', text: 'fim-b' }); } catch {} }
  await sleep(500);
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 500);
})();`;

function run(name, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-direta-'));
  const file = path.join(dir, name + '.js');
  fs.writeFileSync(file, script);
  const env = { ...process.env, TELA_PROFILE: 'smoke-' + name, TELA_PORT: String(PORT), TELA_TEST_SCRIPT: file, TELA_TEST_HIDDEN: '1', ELECTRON_ENABLE_LOGGING: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let rest = '';
  child.stderr.on('data', () => {});
  child.stdout.on('data', (d) => {
    rest += d.toString();
    const parts = rest.split(/\r?\n/); rest = parts.pop();
    for (const l of parts) {
      const m = /SMOKE [0-9.]+ (.*)$/.exec(l);
      if (!m) continue;
      lines.push(m[1]);
      // os registros quadro a quadro (S/Q) e os resumos são tratados aqui embaixo, não na tela
      if (/^(S|Q|RESUMO-[AB]) /.test(m[1])) continue;
      if (VERBOSE || !/^ {2}[AB] /.test(m[1])) console.log(`  [${name}] ${m[1]}`);
    }
  });
  return { child, lines, done: new Promise((r) => child.on('exit', r)) };
}

(async () => {
  const server = await createSignalingServer(PORT);
  const a = run('diretaA', scriptA);
  await new Promise((r) => setTimeout(r, 2000));
  const b = run('diretaB', scriptB);
  const t = setTimeout(() => { console.log('TEMPO ESGOTADO'); a.child.kill(); b.child.kill(); }, (SECS + 120) * 1000);
  await Promise.all([a.done, b.done]);
  clearTimeout(t);
  try { server.close(); } catch {}

  const fails = [];
  if (!a.lines.includes('A OK')) fails.push('quem transmite não terminou bem');
  if (!b.lines.includes('B OK')) fails.push('quem assiste não terminou bem');
  const json = (lines, tag) => { const l = lines.find((x) => x.startsWith(tag + ' ')); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return null; } };
  const ra = json(a.lines, 'RESUMO-A'), rb = json(b.lines, 'RESUMO-B');

  if (rb) {
    console.log(`\nquem assiste: ${rb.w}x${rb.h} ${rb.mime}, ${rb.fps} quadros/s, ${rb.kbps} kb/s, buffer ${rb.buffer} ms, quadros-chave ${rb.keys}, ` +
      `pedidos de quadro-chave ${rb.pli}, reenvios pedidos ${rb.nack}, pacotes perdidos ${rb.lost}, travadas ${rb.freezes} (${rb.frozen} s), maior parada ${(rb.worst * 0.25).toFixed(2)} s`);
    if (rb.fps < 55) fails.push(`só ${rb.fps} quadros/s chegando`);
    if (rb.worst >= 3) fails.push(`a imagem ficou parada por ${(rb.worst * 0.25).toFixed(2)} s`);
  }
  if (ra) {
    const perSec = ra.secs ? ra.kd / ra.secs : 0;
    console.log(`quem transmite: ${ra.codec}, alvo ${ra.alvo} kb/s, estimativa do WebRTC ${ra.bwe} kb/s, rede ${ra.rede}; helper mín ${ra.fpsMin} quadros/s, atrasados ${ra.late}, descartados ${ra.dropped}; ` +
      `trilha vazia em ${ra.secs} s: ${ra.kd} quadros-chave, ${ra.ex} quadros extras pedidos, ${ra.empty} sem quadro nosso, fila descartada ${ra.flush} vez(es)`);
    if (perSec > 1) fails.push(`a trilha vazia gerou ${perSec.toFixed(1)} quadros-chave por segundo (devia ser quase nenhum)`);
    if (ra.flush > 1) fails.push(`o envio ficou para trás ${ra.flush} vezes`);
    if (ra.fpsMin < 55) fails.push(`o helper caiu para ${ra.fpsMin} quadros/s`);
  }

  // cruza o que saiu do transform (S: timestamp RTP, tipo do quadro vazio, bytes, é keyframe nosso) com
  // o que o receptor montou (Q). No AV1 o transform não registra quadro a quadro: só os resumos valem.
  const sent = a.lines.filter((l) => l.startsWith('S ')).map((l) => { const p = l.split(' '); return { ts: Number(p[1]), slot: p[2], size: Number(p[3]), key: p[4] === '1', at: p[5] }; }).filter((f) => Number.isFinite(f.ts));
  const got = new Set();
  for (const l of b.lines) if (l.startsWith('Q ')) for (const v of l.slice(2).split(',')) if (v && v !== 'null') got.add(Number(v));
  if (sent.length && got.size) {
    let lo = Infinity, hi = -Infinity;
    for (const v of got) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const inRange = sent.filter((f) => f.ts >= lo && f.ts <= hi && f.size >= 0);
    const gone = inRange.filter((f) => !got.has(f.ts));
    console.log(`quadro a quadro: ${inRange.length} saíram do transform no trecho comum, ${gone.length} não foram montados no receptor`);
    for (const f of gone.slice(0, 8)) {
      const i = sent.indexOf(f), nx = sent[i + 1];
      console.log(`   sumiu: ${f.at} s, ${f.size} B${f.key ? ' (keyframe nosso)' : ''}; o quadro seguinte foi num quadro vazio do tipo ${nx ? nx.slot : '?'}`);
    }
    if (gone.length) fails.push(`${gone.length} quadro(s) saíram e não chegaram montados`);
  } else if (CODEC !== 'AV1') fails.push('sem registro quadro a quadro para cruzar');

  // a versão leve (o segundo encoder do helper)
  const leve = json(b.lines, 'LEVE');
  if (a.lines.some((l) => /^versão leve: desligada/.test(l))) fails.push('a versão leve não abriu (' + a.lines.find((l) => /^versão leve:/.test(l)) + ')');
  else if (!leve) fails.push('a versão leve não chegou a quem via em miniatura' + (b.lines.find((l) => /^LEVE falhou/.test(l)) ? ` (${b.lines.find((l) => /^LEVE falhou/.test(l))})` : ''));
  else {
    console.log(`versão leve: ${leve.w}x${leve.h}, ${leve.fps} quadros/s`);
    if (leve.h > 540 || leve.fps < 25) fails.push(`versão leve errada: ${leve.w}x${leve.h} a ${leve.fps} quadros/s`);
  }
  if (!b.lines.includes('CHEIA de volta')) fails.push('não voltou para a cheia depois da miniatura');

  console.log(fails.length ? `\nTESTE DA NATIVA DIRETA FALHOU: ${fails.join('; ')}` : '\nTESTE DA NATIVA DIRETA PASSOU');
  process.exit(fails.length ? 1 : 0);
})();
