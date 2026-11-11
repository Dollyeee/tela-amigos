// Teste do "ciclo de vida" da transmissão: o que acontece quando as coisas se atropelam. Duas cópias
// escondidas do app numa sala de teste; a captura é FALSA (quadros gerados aqui mesmo, sem placa de
// vídeo e sem som), então o que se mede é só a lógica do app:
//  - "Parar" ou "Sair" enquanto a captura ainda abria: a transmissão não pode entrar no ar depois;
//  - área da tela escolhida + captura nativa falhando: não pode cair para a tela inteira;
//  - reinício automático mantém as configurações do que está no ar (não as do modal);
//  - troca de codec pedida com outro reinício em andamento: espera, não trava a interface;
//  - replay/clipe seguem a tela quando a trilha troca; câmera com dois cliques; atraso do som.
//   node scripts/lifecycle-test.js        (-v mostra tudo)
// Rodar depois de mexer em startShare/stopShare/leaveRoom, em clips.js ou no native-video.js.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
const { createSignalingServer } = require(path.join(ROOT, 'src', 'signaling'));
const PORT = 47911;
const VERBOSE = process.argv.includes('-v');

/* eslint-disable no-undef */
// ---- o que roda dentro das páginas (vai como texto; os nomes soltos são do app.js) ----
function pageCommon() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clock = () => ((Date.now() % 1000000) / 1000).toFixed(2);
  const log = (m) => console.log('SMOKE ' + clock() + ' ' + m);
  window.addEventListener('error', (e) => log('ERRO ' + e.message));
  window.addEventListener('unhandledrejection', (e) => log('ERRO promessa: ' + ((e.reason && e.reason.message) || e.reason)));
  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(100); }
    throw new Error('tempo esgotado: ' + what);
  }
  const check = (name, ok, extra) => log('CHECK ' + (ok ? 'ok' : 'FALHOU') + ' ' + name + (extra ? ' [' + extra + ']' : ''));
  async function join(name) {
    for (const k of ['clipSys', 'mediactl', 'gamehide', 'autoMeasure']) localStorage.setItem(k, '0');
    await sleep(800);
    $('#name').value = name; checkName();
    joinRoom('127.0.0.1');
    await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala');
  }
  // vídeo e som gerados aqui (nenhum dispositivo: nem tela, nem placa de som)
  function fakeVideo(color) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const w = gen.writable.getWriter();
    const c = new OffscreenCanvas(640, 360);
    const g = c.getContext('2d');
    let n = 0;
    const timer = setInterval(() => {
      g.fillStyle = color; g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff'; g.fillRect((n * 7) % 600, 100, 40, 40);
      const f = new VideoFrame(c, { timestamp: n * 33333 }); // cada trilha com o relógio dela, do zero
      n++;
      w.write(f).catch(() => f.close());
    }, 33);
    return { track: gen, stop() { clearInterval(timer); try { w.close().catch(() => {}); } catch {} try { gen.stop(); } catch {} } };
  }
  function fakeAudio() {
    const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
    const w = gen.writable.getWriter();
    let n = 0;
    const timer = setInterval(() => {
      const frames = 480, data = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) { const v = Math.sin(((n * frames + i) * 2 * Math.PI * 440) / 48000) * 0.1; data[i] = v; data[frames + i] = v; }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2, timestamp: n * 10000, data });
      n++;
      w.write(ad).catch(() => ad.close());
    }, 10);
    return { track: gen, stop() { clearInterval(timer); try { w.close().catch(() => {}); } catch {} try { gen.stop(); } catch {} } };
  }
  window.T = { sleep, log, until, check, join, fakeVideo, fakeAudio };
}

async function pageA() {
  const { sleep, log, until, check, join, fakeVideo, fakeAudio } = window.T;
  const fakes = [];
  try {
    for (const k of ['codecBad:H265', 'codecBad:AV1']) localStorage.removeItem(k);
    localStorage.setItem('av1', '0'); localStorage.setItem('autoJoin', '0'); localStorage.setItem('autoDirect', '0'); localStorage.setItem('smartRes', '0');
    await join('VIDA A');
    const peer = () => [...state.peers.values()][0];
    await until(() => peer() && peer().pc.connectionState === 'connected' && peer().h265 !== undefined, 30000, 'conectar ao amigo');
    log('conectado');

    const src = { id: 'screen:9999:0', name: 'Tela de teste', type: 'screen', displayId: '0', size: { width: 1280, height: 720 } };
    $('#opt-audio').innerHTML = '<option value="none">Sem áudio</option>'; $('#opt-audio').value = 'none'; // nunca captura som
    const setOpts = (engine, res, fps) => { $('#opt-engine').value = engine; $('#opt-res').value = res; $('#opt-fps').value = String(fps); $('#opt-mode').value = 'motion'; $('#opt-codec').value = 'auto'; $('#opt-bitrate').value = 9; };
    let delay = 0, failNative = false, onNative = null;
    const nativeCalls = [];
    window.__testNative = async (o) => {
      nativeCalls.push(o.codec);
      if (onNative) { const f = onNative; onNative = null; f(o); }
      await sleep(delay);
      if (failNative) throw new Error('falha de teste');
      const v = fakeVideo('#246'); fakes.push(v);
      return { track: v.track, preview: new MediaStream([v.track]), width: 1280, height: 720, encoder: 'teste', codec: o.codec, minQp: 0 };
    };
    let gum = 0, gumDelay = 0;
    const gumStreams = [];
    navigator.mediaDevices.getUserMedia = async () => { gum++; await sleep(gumDelay); const v = fakeVideo('#642'); fakes.push(v); const s = new MediaStream([v.track]); gumStreams.push(s); return s; };
    const toasts = () => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent);
    const clearToasts = () => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    // "a interface não travou": um contador de 50 em 50 ms tem que continuar andando
    let beats = 0;
    setInterval(() => { beats++; }, 50);

    // ---------------------------------------------------------------- 1) Parar durante o início
    setOpts('native', '720', 30);
    selectedSource = src; delay = 700;
    let p = startShare();
    await sleep(200);
    await stopShare();
    await p; await sleep(300);
    check('parar enquanto a captura abria: não entra no ar', state.share === null && $('#btn-stop').classList.contains('hidden'), 'share=' + !!state.share);
    check('parar enquanto a captura abria: o botão de transmitir volta', $('#btn-start-share').disabled === false);

    // ---------------------------------------------------------------- 2) Sair durante o início
    selectedSource = src; delay = 700;
    p = startShare();
    await sleep(200);
    await leaveRoom();
    await p; await sleep(300);
    check('sair da sala enquanto a captura abria: nada fica transmitindo no lobby', state.share === null && !$('#lobby').classList.contains('hidden'));
    selectedSource = src; delay = 0;
    await startShare();
    check('fora de uma sala o pedido de transmitir é recusado', state.share === null);
    check('sair da sala fecha o modal de compartilhar', $('#share-modal').classList.contains('hidden'));
    joinRoom('127.0.0.1');
    await until(() => !$('#room').classList.contains('hidden') && peer() && peer().pc.connectionState === 'connected' && peer().h265 !== undefined, 30000, 'voltar para a sala');

    // ---------------------------------------------------------------- 3) Área da tela + nativa falhando
    gum = 0; failNative = true; delay = 0;
    selectedSource = { ...src, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
    clearToasts();
    await startShare();
    check('área escolhida e captura nativa falhando: NÃO transmite a tela inteira', state.share === null && gum === 0, 'capturas do Chromium=' + gum);
    check('área escolhida e captura nativa falhando: avisa', toasts().some((t) => /só a área escolhida/.test(t)));
    selectedSource = src;
    await startShare();
    check('tela inteira e captura nativa falhando: cai para a captura do Chromium (como antes)', !!state.share && !state.share.native && gum === 1, 'capturas=' + gum);
    await stopShare();
    failNative = false;

    // ---------------------------------------------------------------- 4) Reinício automático x modal
    setOpts('native', '720', 30);
    selectedSource = src;
    await startShare();
    check('transmissão de teste começou (adaptativa)', !!state.share && state.share.native && !state.share.direct && state.share.settings.res === '720');
    const first = state.share;
    setOpts('native', '1440', 60); // a pessoa abriu o modal, mexeu e não confirmou
    await recoverShare('teste');
    check('reinício automático: mantém as configurações do que está no ar', !!state.share && state.share !== first && state.share.settings.res === '720' && state.share.settings.fps === 30 && state.share.settings.audio === 'none',
      state.share ? state.share.settings.res + '/' + state.share.settings.fps + '/' + state.share.settings.audio : 'sem transmissão');
    check('reinício automático: não grava o que estava no modal como preferência', state.settings.res === '720', state.settings.res);
    // "Aplicar" nos Ajustes: vale o que foi ajustado; o som continua o da transmissão
    $('#opt-audio').innerHTML = '<option value="none">Sem áudio</option><option value="all-except">Todo o som</option>'; $('#opt-audio').value = 'all-except';
    $('#adj-res').value = '1080'; $('#adj-fps').value = '60'; $('#adj-mode').value = 'detail'; $('#adj-engine').value = 'native'; $('#adj-bitrate').value = 12;
    await applyAdjust();
    check('Ajustes > Aplicar: vale o que foi ajustado e o som não muda', !!state.share && state.share.settings.res === '1080' && state.share.settings.fps === 60 && state.share.settings.mode === 'detail' &&
      state.share.settings.bitrate === 12 && state.share.settings.audio === 'none' && !state.share.audio, state.share ? JSON.stringify(state.share.settings) : 'sem transmissão');
    check('Ajustes > Aplicar: fica guardado para a próxima', state.settings.res === '1080' && state.settings.fps === 60 && $('#opt-res').value === '1080');
    $('#opt-audio').innerHTML = '<option value="none">Sem áudio</option>'; $('#opt-audio').value = 'none';

    // ---------------------------------------------------------------- 5) caneta depois de a tela sair da página
    if (meTile && meTile.el.isConnected) {
      // a janela escondida do teste não desenha quadros: o desenho do app passa a andar por temporizador
      const realRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
      let raf = 0; requestAnimationFrame(() => { raf++; });
      await sleep(300);
      if (!raf) log('CHECK pulado caneta (a janela escondida não desenha quadros)');
      else {
        // (autor 'me': o traço fica só dentro da janela escondida; o de um amigo apareceria também no
        //  monitor de quem está rodando o teste)
        showInk(state.myId, 'me', 'Fulano', [[0.1, 0.1, 0.2, 0.2]]);
        const parent = meTile.el.parentNode;
        meTile.el.remove();
        await sleep(300);
        check('caneta: a tela saiu da página com um traço vivo e a marca de "desenhando" foi liberada', meTile.trailAnimating === false);
        parent.appendChild(meTile.el);
        showInk(state.myId, 'me', 'Fulano', [[0.3, 0.3, 0.4, 0.4]]);
        await sleep(300);
        check('caneta: volta a desenhar quando a tela reaparece', meTile.trailAnimating === true && meTile.trailLines.length >= 1);
        // teto de traços
        const many = []; for (let i = 0; i < 200; i++) many.push([0.1, 0.1, 0.2, 0.2]);
        for (let i = 0; i < 40; i++) showInk(state.myId, 'me', 'Fulano', many);
        check('caneta: traços demais não acumulam sem limite', meTile.trailLines.length <= 2500, String(meTile.trailLines.length));
        meTile.trailLines.length = 0;
      }
      window.requestAnimationFrame = realRaf;
    } else log('CHECK pulado caneta (sem a minha tela na página)');
    {
      // um amigo mandando traços e mãozinhas sem parar: só passa o ritmo de quem desenha de verdade
      // (o alvo é uma tela que não existe: nada é desenhado, nem aqui nem no monitor)
      const many = []; for (let i = 0; i < 200; i++) many.push([0.1, 0.1, 0.2, 0.2]);
      let segs = 0, points = 0;
      const realInk = window.showInk, realLaser = window.showLaser;
      window.showInk = (_t, _f, _n, s) => { segs += s.length; };
      window.showLaser = () => { points++; };
      for (let i = 0; i < 30; i++) onRelay(peer().id, { kind: 'ink', target: 'ninguem', segs: many });
      for (let i = 0; i < 3000; i++) onRelay(peer().id, { kind: 'point', target: 'ninguem', x: 0.5, y: 0.5 });
      window.showInk = realInk; window.showLaser = realLaser;
      check('enxurrada de traços/mãozinhas de um amigo: só passa o ritmo normal', segs > 0 && segs <= 600 && points > 0 && points <= 400, 'traços=' + segs + ' de 6000, mãozinhas=' + points + ' de 3000');
    }

    // ---------------------------------------------------------------- 6) atraso do som volta ao normal
    {
      const pr = peer();
      const audioRecvs = pr.pc.getReceivers().filter((r) => r.track && r.track.kind === 'audio');
      localStorage.setItem('lat:' + pr.name, 'smooth'); applyPlayoutBuffer();
      const at350 = audioRecvs.length > 0 && audioRecvs.every((r) => r.jitterBufferTarget === 350);
      localStorage.setItem('lat:' + pr.name, 'low'); applyPlayoutBuffer();
      const back = audioRecvs.every((r) => r.jitterBufferTarget == null);
      localStorage.removeItem('lat:' + pr.name); applyPlayoutBuffer();
      check('"Imagem lisa" põe o som em 350 ms e sair dela devolve ao normal', at350 && back, 'em lisa=' + at350 + ' depois=' + audioRecvs.map((r) => r.jitterBufferTarget).join(','));
    }

    // ---------------------------------------------------------------- 7) troca de codec com reinício em andamento
    await stopShare();
    if (!window.Sdp.hasH265() || !peer().h265) log('CHECK pulado troca de codec (este PC não tem H.265)');
    else {
      setOpts('native-direct', '720', 60);
      selectedSource = src; delay = 0; nativeCalls.length = 0;
      await startShare();
      const okStart = !!state.share && state.share.direct && state.share.codec === 'hevc';
      check('direta de teste começou em H.265', okStart, state.share ? state.share.codec : 'sem transmissão');
      if (okStart) {
        clearToasts();
        // um reinício qualquer em andamento; no meio dele o amigo "avisa" que não decodifica H.265
        delay = 900; nativeCalls.length = 0;
        const b0 = beats;
        onNative = () => { peer().h265 = false; restartDirectCodec(peer().name, 'hevc'); };
        await startShare({ keep: true });
        await until(() => state.share && state.share.codec === 'h264' && !restartingCodec, 15000, 'a transmissão passar para H.264');
        await sleep(300);
        const warn = toasts().filter((t) => /não decodifica H\.265/.test(t)).length;
        check('troca de codec pedida no meio de outro reinício: espera e troca (sem travar a interface)', state.share.codec === 'h264' && beats - b0 >= 15,
          'codec=' + state.share.codec + ' batidas=' + (beats - b0) + ' pedidos=' + nativeCalls.join('>'));
        check('troca de codec: um aviso só', warn === 1, 'avisos=' + warn);
        peer().h265 = true;
      }
      await stopShare();
    }

    // ---------------------------------------------------------------- 8) clipe segue a tela quando a trilha troca
    {
      const v1 = fakeVideo('#135'), a1 = fakeAudio(); fakes.push(v1, a1);
      let cur = new MediaStream([v1.track, a1.track]);
      const on = window.Clips.toggle('teste', cur, 'teste', { source: () => cur });
      await sleep(2500);
      const before = window.Clips.build('teste');
      // a tela "reinicia": trilhas novas (relógio do zero), as antigas acabam
      const v2 = fakeVideo('#531'), a2 = fakeAudio(); fakes.push(v2, a2);
      cur = new MediaStream([v2.track, a2.track]);
      v1.stop(); a1.stop();
      await sleep(3000);
      let after = null, err = '';
      try { after = window.Clips.build('teste'); } catch (e) { err = e.message; }
      const txt = after ? new TextDecoder('latin1').decode(new Uint8Array(after.buffer)) : '';
      check('replay ligado e gravando', on === true && !!before && before.seconds > 1.2, before ? before.seconds.toFixed(1) + ' s' : 'vazio');
      check('replay continua depois de a trilha da tela trocar', !!after && after.seconds > (before ? before.seconds : 0) + 1.5, after ? after.seconds.toFixed(1) + ' s' : 'erro: ' + err);
      check('clipe montado com imagem e som (horários emendados sem erro)', !!after && /avc1/.test(txt) && /Opus/.test(txt), after ? Math.round(after.buffer.byteLength / 1000) + ' kB' : err);
      window.Clips.stop('teste');
    }

    // ---------------------------------------------------------------- 9) câmera: dois cliques
    gum = 0; gumDelay = 500; gumStreams.length = 0;
    toggleCamera(); toggleCamera();
    await sleep(1000);
    check('câmera com dois cliques seguidos: abre uma vez só', gum === 1 && !!state.camera, 'aberturas=' + gum);
    await toggleCamera();
    check('câmera desligada: a trilha para', !state.camera && gumStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));

    // ---------------------------------------------------------------- 10) opção "abrir com o Windows" fora do app instalado
    clearToasts();
    $('#opt-autostart').checked = true;
    await $('#opt-autostart').onchange();
    check('"abrir com o Windows" rodando sem instalar: desmarca e avisa', $('#opt-autostart').checked === false && toasts().some((t) => /Só funciona no app instalado/.test(t)));

    // ---------------------------------------------------------------- 11) câmera abrindo e a pessoa sai da sala
    gum = 0; gumDelay = 500; gumStreams.length = 0;
    toggleCamera();
    await sleep(100);
    sendRelay(null, { kind: 'chat', text: 'fim-a' });
    await sleep(200);
    await leaveRoom();
    await sleep(700);
    check('sair da sala com a câmera ainda abrindo: ela não fica ligada', !state.camera && gumStreams.length === 1 && gumStreams[0].getTracks().every((t) => t.readyState === 'ended'));
    check('a interface seguiu respondendo o teste inteiro', beats > 100, String(beats));
    log('A OK');
  } catch (e) { log('FALHOU A: ' + ((e && e.stack) || e)); try { sendRelay(null, { kind: 'chat', text: 'fim-a' }); } catch {} }
  for (const f of fakes) f.stop();
  await sleep(300);
  await stopShare().catch(() => {});
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 800);
}

async function pageB() {
  const { sleep, log, until, check } = window.T;
  try {
    for (const k of ['clipSys', 'mediactl', 'gamehide', 'autoMeasure']) localStorage.setItem(k, '0');
    await sleep(800);
    // "Entrar sozinho na última sala": com a opção ligada, o app tem que entrar sem ninguém clicar
    const already = !$('#room').classList.contains('hidden'); // (rodada anterior deixou ligado: entrou ao abrir)
    if (!already) {
      localStorage.setItem('autoJoin', '1'); localStorage.setItem('name', 'VIDA B'); localStorage.setItem('hostIp', '127.0.0.1'); localStorage.setItem('lastRole', 'guest');
      $('#host-ip').value = '127.0.0.1';
      autoJoinOnStart();
    }
    let joined = true;
    await until(() => !$('#room').classList.contains('hidden'), 8000, 'entrar sozinho').catch(() => { joined = false; });
    check('"entrar sozinho na última sala" entra sem clique' + (already ? ' (já ao abrir o app)' : ''), joined);
    localStorage.setItem('autoJoin', '0');
    if (!joined) { $('#name').value = 'VIDA B'; checkName(); joinRoom('127.0.0.1'); await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala'); }
    await until(() => /fim-a/.test($('#chat-log').textContent), 170000, 'A terminar');
    log('B OK');
  } catch (e) { log('FALHOU B: ' + ((e && e.stack) || e)); }
  await sleep(300);
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 500);
}
/* eslint-enable no-undef */

function run(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-vida-'));
  const file = path.join(dir, name + '.js');
  fs.writeFileSync(file, `(${pageCommon})();\n(${fn})();\n`);
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
      if (!m) { if (VERBOSE && /\[page\]/.test(l)) console.log(`  [${name}] ${l.slice(0, 300)}`); continue; }
      lines.push(m[1]);
      console.log(`  [${name}] ${m[1]}`);
    }
  });
  return { child, lines, done: new Promise((r) => child.on('exit', r)) };
}

(async () => {
  const server = await createSignalingServer(PORT);
  const a = run('vidaA', pageA);
  await new Promise((r) => setTimeout(r, 2000));
  const b = run('vidaB', pageB);
  const t = setTimeout(() => { console.log('TEMPO ESGOTADO'); a.child.kill(); b.child.kill(); }, 200000); // só as cópias de teste
  await Promise.all([a.done, b.done]);
  clearTimeout(t);
  try { server.close(); } catch {}

  const all = [...a.lines, ...b.lines];
  const checks = all.filter((l) => l.startsWith('CHECK '));
  const failed = checks.filter((l) => l.startsWith('CHECK FALHOU'));
  const skipped = checks.filter((l) => l.startsWith('CHECK pulado'));
  const errors = all.filter((l) => l.startsWith('ERRO ') || l.startsWith('FALHOU '));
  const fails = [...failed.map((l) => l.slice(13)), ...errors];
  if (!a.lines.includes('A OK')) fails.push('a cópia A não chegou ao fim');
  if (!b.lines.includes('B OK')) fails.push('a cópia B não chegou ao fim');
  console.log(`\n${checks.length - failed.length - skipped.length} conferências passaram, ${failed.length} falharam, ${skipped.length} puladas`);
  console.log(fails.length ? `TESTE DO CICLO DA TRANSMISSÃO FALHOU:\n  - ${fails.join('\n  - ')}` : 'TESTE DO CICLO DA TRANSMISSÃO PASSOU');
  process.exit(fails.length ? 1 : 0);
})();
