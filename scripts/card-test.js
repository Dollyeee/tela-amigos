// Teste da "Placa de captura" (console/outro PC: para o Windows a placa é uma câmera). Duas cópias escondidas do
// app numa sala de teste; a placa e a entrada de som dela são as de MENTIRA do Chromium (TELA_TEST_FAKECAM):
// nenhuma câmera, microfone, tela ou som do PC é aberto, e as duas cópias ficam mudas (--mute-audio).
//  - A: a aba "Placa de captura" lista a placa, a lista de som tem as entradas, transmite pelo Chromium (mesmo com
//    "Nativa" escolhida) com o som da entrada; reiniciar em 1080p troca o formato da placa; parar solta tudo.
//  - B: recebe a imagem (no tamanho pedido) e o som.
//   node scripts/card-test.js        (-v mostra o console das cópias)
// Rodar depois de mexer na aba "Placa de captura", no startShare/stopShare ou no som de entrada.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 47911; // porta de teste (nunca a da sala de verdade)
const VERBOSE = process.argv.includes('-v');
const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
const { createSignalingServer } = require(path.join(ROOT, 'src', 'signaling'));

/* eslint-disable no-undef */
// ---- roda dentro das páginas (vai como texto; os nomes soltos são do app.js) ----
function pageCommon() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (m) => console.log('CARD ' + m);
  window.addEventListener('error', (e) => log('ERRO ' + e.message));
  window.addEventListener('unhandledrejection', (e) => log('ERRO promessa: ' + ((e.reason && e.reason.message) || e.reason)));
  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(150); }
    throw new Error('tempo esgotado: ' + what);
  }
  const check = (name, ok, extra) => log('CHECK ' + (ok ? 'ok' : 'FALHOU') + ' ' + name + (extra ? ' [' + extra + ']' : ''));
  async function join(name) {
    for (const k of ['clipSys', 'mediactl', 'gamehide', 'autoMeasure', 'autoJoin']) localStorage.setItem(k, '0');
    Sfx.play = () => {}; // sem sons do app (chat, entrar na sala)
    window.Notification = class { close() {} static requestPermission() { return Promise.resolve('denied'); } };
    await sleep(800);
    $('#name').value = name; checkName();
    joinRoom('127.0.0.1');
    await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala');
    await until(() => [...state.peers.values()].some((p) => p.pc.connectionState === 'connected'), 30000, 'conectar ao amigo');
  }
  const chatHas = (t) => $('#chat-log').textContent.includes(t);
  const say = (t) => sendRelay(null, { kind: 'chat', text: t });
  window.T = { sleep, log, until, check, join, chatHas, say };
}

async function pageA() {
  const { sleep, log, until, check, join, chatHas, say } = window.T;
  // nada do PC de verdade: nem a captura nativa (tela), nem o som do PC (loopback)
  let natives = 0, helperAudio = 0;
  window.NativeVideo.start = async () => { natives++; throw new Error('teste: captura nativa proibida'); };
  window.HelperAudio.start = async () => { helperAudio++; throw new Error('teste: som do PC proibido'); };
  try {
    await join('Placa A');
    log('conectado');
    await openShareModal();
    document.querySelector('#share-modal .tabs [data-tab="device"]').click();
    await until(() => sourcesLoaded.device && sources.some((s) => s.type === 'device'), 8000, 'listar as placas');
    const cards = sources.filter((s) => s.type === 'device');
    check('aba "Placa de captura" lista a placa', cards.length >= 1 && document.querySelectorAll('#sources .source').length === cards.length, cards.map((c) => c.name).join(', '));
    await until(() => [...$('#opt-audio').options].some((o) => o.value.startsWith('in:')), 8000, 'entradas de som na lista');
    const ins = [...$('#opt-audio').options].filter((o) => o.value.startsWith('in:'));
    check('a lista de som tem as entradas (sem os apelidos "Padrão"/"Comunicação")', ins.length >= 1 && !ins.some((o) => /in:(default|communications)$/.test(o.value)), ins.map((o) => o.textContent).join(', '));
    document.querySelector('#sources .source').click();
    check('clicar na placa escolhe a placa', selectedSource && selectedSource.type === 'device' && !$('#btn-start-share').disabled);
    check('com a placa escolhida, o aviso fala do OBS e do som da placa', /OBS/.test($('#share-note').textContent), $('#share-note').textContent);
    // a placa de mentira não diz qual entrada é dela: escolhe a primeira (nunca o som do PC)
    $('#opt-audio').value = ins[0].value;
    $('#opt-engine').value = 'native'; $('#opt-res').value = '720'; $('#opt-fps').value = '30';
    startFromModal();
    await until(() => state.share && state.share.video && state.share.video.readyState === 'live', 10000, 'transmitir a placa');
    await sleep(800);
    const vs = state.share.video.getSettings(), as = state.share.audio ? state.share.audio.getSettings() : {};
    check('transmite pelo Chromium, sem a captura nativa nem o som do PC', !state.share.native && natives === 0 && helperAudio === 0, 'nativas=' + natives + ' somDoPC=' + helperAudio);
    check('a placa abriu em 1280x720 até 30 fps', vs.width === 1280 && vs.height === 720 && vs.frameRate <= 30.5, cardMode(state.share.video));
    check('o som é a entrada escolhida, sem cancelar eco/ruído nem nivelar', state.share.audioIn && state.share.audio.readyState === 'live' &&
      as.echoCancellation === false && as.noiseSuppression === false && as.autoGainControl === false, JSON.stringify({ label: state.share.audio && state.share.audio.label, ...as }));
    const diag = await buildRendererDiag();
    check('o diagnóstico diz que é a placa e em que formato', /placa de captura 1280x720/.test(diag) && /entrada de som, sem o auxiliar/.test(diag),
      (diag.match(/fonte=[^\n]*/) || [''])[0].slice(0, 160));
    say('placa-no-ar');
    await until(() => chatHas('placa-recebida'), 30000, 'o B receber a placa');
    // reiniciar a mesma transmissão em 1080p (como "Ajustes > Aplicar"): a placa é solta e reaberta no formato novo
    const old = state.share;
    await startShare({ keep: true, res: '1080' });
    const v2 = state.share.video.getSettings();
    check('reiniciar em 1080p: a placa reabre no formato novo e a de antes é solta', state.share !== old && v2.width === 1920 && v2.height === 1080 &&
      old.video.readyState === 'ended' && old.audio.readyState === 'ended' && state.share.audio.readyState === 'live', cardMode(state.share.video));
    say('placa-1080');
    await until(() => chatHas('placa-1080-recebida'), 30000, 'o B receber em 1080p');
    const sh = state.share;
    await stopShare();
    check('parar solta a placa e a entrada de som', !state.share && sh.video.readyState === 'ended' && sh.audio.readyState === 'ended');
    say('placa-parou');
    await until(() => chatHas('placa-fim'), 15000, 'o B terminar');
    log('A OK');
  } catch (e) { log('FALHOU A: ' + e.message); }
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 500);
}

async function pageB() {
  const { sleep, log, until, check, join, chatHas, say } = window.T;
  try {
    await join('Placa B');
    log('conectado');
    const peer = () => [...state.peers.values()][0];
    const inbound = async (kind) => { let x = null; (await peer().pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === kind && (!x || (r.bytesReceived || 0) > (x.bytesReceived || 0))) x = r; }); return x; };
    await until(() => chatHas('placa-no-ar'), 40000, 'o A transmitir a placa');
    await until(async () => { const v = await inbound('video'); return v && v.framesDecoded > 30 && v.frameWidth === 1280; }, 20000, 'receber imagem 1280x720');
    const v0 = await inbound('video'); await sleep(2000); const v1 = await inbound('video');
    const fps = (v1.framesDecoded - v0.framesDecoded) / 2;
    check('B recebe a imagem da placa (1280x720) andando', v1.frameWidth === 1280 && v1.frameHeight === 720 && fps >= 12, `${v1.frameWidth}x${v1.frameHeight} ~${fps.toFixed(0)} fps, ${v1.decoderImplementation}`);
    await until(async () => { const a = await inbound('audio'); return a && a.packetsReceived > 50; }, 15000, 'receber som');
    const a = await inbound('audio');
    check('B recebe o som da entrada da placa', a.packetsReceived > 50 && (a.totalSamplesReceived || 0) > 0, `pacotes=${a.packetsReceived} amostras=${a.totalSamplesReceived}`);
    say('placa-recebida');
    await until(() => chatHas('placa-1080'), 30000, 'o A reiniciar em 1080p');
    await until(async () => { const v = await inbound('video'); return v && v.frameWidth === 1920; }, 20000, 'receber 1920x1080');
    const w0 = await inbound('video'); await sleep(2000); const w1 = await inbound('video');
    check('B recebe a placa em 1920x1080 depois do reinício', w1.frameWidth === 1920 && w1.frameHeight === 1080 && w1.framesDecoded - w0.framesDecoded >= 24, `${w1.frameWidth}x${w1.frameHeight} ${w1.framesDecoded - w0.framesDecoded} quadros em 2 s`);
    say('placa-1080-recebida');
    await until(() => chatHas('placa-parou'), 30000, 'o A parar');
    await until(() => !peer().sharing, 10000, 'o A sair do ar').catch(() => {});
    check('o A saiu do ar para o B', !peer().sharing);
    say('placa-fim');
    log('B OK');
  } catch (e) { log('FALHOU B: ' + e.message); }
  await sleep(1500);
  await leaveRoom().catch(() => {});
  setTimeout(() => window.close(), 500);
}

function run(name, fn, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-placa-'));
  const file = path.join(dir, name + '.js');
  fs.writeFileSync(file, `(${pageCommon})();\n(${fn})();\n`);
  const env = { ...process.env, TELA_PROFILE: 'smoke-' + name, TELA_PORT: String(PORT), TELA_TEST_SCRIPT: file, TELA_TEST_HIDDEN: '1', ELECTRON_ENABLE_LOGGING: '', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  // --mute-audio: o som recebido (e qualquer outro) nunca sai nas caixas de quem roda o teste
  const child = spawn(electronPath, ['.', '--mute-audio'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let rest = '';
  child.stderr.on('data', () => {});
  child.stdout.on('data', (d) => {
    rest += d.toString();
    const parts = rest.split(/\r?\n/); rest = parts.pop();
    for (const l of parts) {
      const m = /CARD (.*)$/.exec(l);
      if (!m) { if (VERBOSE && /\[page\]|console/.test(l)) console.log(`  [${name}] ${l.slice(0, 300)}`); continue; }
      lines.push(m[1]);
      console.log(`  [${name}] ${m[1]}`);
    }
  });
  return { child, lines, done: new Promise((r) => child.on('exit', r)) };
}

(async () => {
  const server = await createSignalingServer(PORT);
  // A: placa e entrada de som de mentira (60 fps, para conferir que o app pede só os 30 escolhidos); o helper, se
  // alguém pedir a captura nativa, desenha o padrão de teste em vez da tela
  const a = run('placaA', pageA, { TELA_TEST_FAKECAM: 'fps=60', TELA_TEST_PATTERN: '20' });
  await new Promise((r) => setTimeout(r, 2000));
  const b = run('placaB', pageB, {});
  const t = setTimeout(() => { console.log('TEMPO ESGOTADO'); a.child.kill(); b.child.kill(); }, 150000); // só as cópias de teste
  await Promise.all([a.done, b.done]);
  clearTimeout(t);
  try { server.close(); } catch {}
  const all = [...a.lines, ...b.lines];
  const checks = all.filter((l) => l.startsWith('CHECK '));
  const failed = checks.filter((l) => l.startsWith('CHECK FALHOU'));
  const fails = [...failed.map((l) => l.slice(13)), ...all.filter((l) => l.startsWith('ERRO ') || l.startsWith('FALHOU '))];
  if (!a.lines.includes('A OK')) fails.push('a cópia A não chegou ao fim');
  if (!b.lines.includes('B OK')) fails.push('a cópia B não chegou ao fim');
  console.log(`\n${checks.length - failed.length} conferências passaram, ${failed.length} falharam`);
  console.log(fails.length ? `TESTE DA PLACA DE CAPTURA FALHOU:\n  - ${fails.join('\n  - ')}` : 'TESTE DA PLACA DE CAPTURA PASSOU');
  process.exit(fails.length ? 1 : 0);
})();
