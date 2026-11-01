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
const TIMEOUT_MS = 120000;
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
    state.share = { stream: new MediaStream([track]), video: track, audio: null, preview: new MediaStream([track]),
      settings: { ...state.settings, fps: 30 }, sourceName: 'Tela de teste', native: false, direct: false, width: 1280, height: 720 };
    if (!state.order.includes('me')) state.order.unshift('me');
    for (const p of state.peers.values()) { applySendParams(p); sendState(p.id); }
    render();
    log('transmitindo');
    // responde "Pronto!" quando o B perguntar e avisa quando chegar pedido de play/pausa
    setInterval(() => { if (readyCheck && !readyCheck.ready.has(String(state.myId))) { markReady(); log('respondi pronto'); } }, 300);
    // desenho do B chegando na minha tela
    let inkSeen = false;
    setInterval(() => { if (!inkSeen && meTile && meTile.trailLines && meTile.trailLines.some((l) => l.life)) { inkSeen = true; log('recebi desenho da caneta'); } }, 200);
    window.inkCheck = () => inkSeen;
    setTimeout(async () => { for (const p of state.peers.values()) { let o = ''; (await p.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') o += JSON.stringify({ sent: r.framesSent, enc: r.framesEncoded, w: r.frameWidth, lim: r.qualityLimitationReason }); }); log('envio ' + o + ' trilha=' + p.vT.sender.track + ' estado=' + track.readyState); } }, 8000);
    // espera o B terminar (ele sai da sala) ou o tempo acabar
    await until(() => state.peers.size === 0, 100000, 'B terminar');
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
    await until(() => peer().tile.video.videoWidth > 0, 10000, 'mostrar o vídeo na tela');
    // selo de status (fps/ping)
    await until(() => /fps/.test(peer().tile.qtext.textContent), 15000, 'selo de status');
    log('selo "' + peer().tile.qtext.textContent + '"');
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
  let rest = '';
  child.stdout.on('data', (d) => {
    rest += d.toString();
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const l of parts) {
      const f = /SMOKEFILE (.*)$/.exec(l);
      if (f) { files.push(f[1].trim()); continue; }
      const m = /SMOKE (.*)$/.exec(l);
      if (m) { lines.push(m[1]); console.log(`  [${name}] ${m[1]}`); }
    }
  });
  child.stderr.on('data', () => {});
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, lines, files, done };
}

async function main() {
  console.log('Teste automático: duas cópias do app conectando e transmitindo...');
  const server = createSignalingServer(PORT);
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
  for (const f of b.files) {
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
  const ok = result !== 'timeout' && a.lines.includes('A OK') && b.lines.includes('B OK') && !errors.length;
  if (!ok) {
    console.error(`\nTESTE FALHOU${result === 'timeout' ? ' (tempo esgotado)' : ''}:\n  ${errors.join('\n  ') || 'sem mensagem de erro'}`);
    process.exit(1);
  }
  console.log('\nTeste automático passou.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
