// Processo utilitário (fora do processo principal): roda o AudioHelper.exe e repassa
// vídeo/áudio/eventos direto para a interface por um MessagePort.
// Assim, quando o processo principal trava (ex.: gerando miniaturas no seletor de telas),
// a transmissão não engasga.
const { spawn } = require('child_process');

let port = null;
let proc = null;
let exe = null;
let selfPid = 0;
let buf = Buffer.alloc(0);

let lastBoost = null;
function sendBoost() { proc.stdin.write(JSON.stringify({ cmd: 'boost', pids: lastBoost, on: true }) + '\n'); }

function post(msg) { if (port) port.postMessage(msg); }

function ensure() {
  if (proc) return true;
  if (!exe) return false;
  let p;
  try { p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
  catch (e) { post({ t: 'event', msg: { type: 'helper-error', message: e.message } }); return false; }
  proc = p;
  buf = Buffer.alloc(0);
  p.on('error', (e) => {
    // nem chegou a abrir (bloqueado por antivírus, arquivo sumiu): o Node não avisa "exit" nesse
    // caso, e sem isto "proc" ficava apontando para um processo que não existe (todo pedido
    // seguinte só esperava até estourar o tempo, sem nunca tentar abrir de novo)
    if (proc === p && !p.pid) proc = null;
    post({ t: 'event', msg: { type: 'helper-error', message: e.message } });
  });
  p.stdin.on('error', () => {});
  p.stdout.on('data', parse);
  if (lastBoost) sendBoost(); // helper novo: reaplica a prioridade de GPU
  // o processo principal acompanha o pid: só instala atualização depois que ele sumir de verdade
  process.parentPort.postMessage({ type: 'helper-pid', pid: p.pid || 0 });
  p.on('exit', (code) => {
    if (proc === p) proc = null;
    process.parentPort.postMessage({ type: 'helper-pid', pid: 0 });
    post({ t: 'event', msg: { type: 'helper-exit', code } });
  });
  return true;
}

// A página da interface foi trocada (recarregou depois de cair, ou a janela foi recriada): o que a
// anterior deixou ligado no helper (captura da tela, som, vigia de jogo) ficou sem ninguém para
// receber e seguia rodando (placa de vídeo codificando à toa) até a próxima transmissão ou até
// fechar o app. O id -1 não é de nenhum pedido da página nova: as respostas são ignoradas.
function stopCaptures() {
  if (!proc) return;
  try {
    for (const c of [{ cmd: 'video-stop' }, { cmd: 'stop' }, { cmd: 'sysaudio-stop' }, { cmd: 'game-watch', on: false }]) {
      proc.stdin.write(JSON.stringify({ ...c, id: -1 }) + '\n');
    }
  } catch {}
}

function parse(chunk) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= 5) {
    const len = buf.readUInt32LE(1);
    if (buf.length < 5 + len) break;
    const type = buf[0];
    // cópia própria do pacote (o Buffer pode apontar para um bloco maior)
    const payload = buf.buffer.slice(buf.byteOffset + 5, buf.byteOffset + 5 + len);
    buf = buf.subarray(5 + len);
    if (type === 2) post({ t: 'pcm', d: payload });
    else if (type === 3) post({ t: 'video', d: payload });
    else if (type === 4) post({ t: 'sys', d: payload }); // áudio do PC inteiro (para os clipes)
    else if (type === 1) {
      try {
        const msg = JSON.parse(Buffer.from(payload).toString('utf8'));
        if (msg.type === 'boost') process.parentPort.postMessage({ type: 'boost-result', result: msg.result });
        post({ t: 'event', msg });
      } catch {}
    }
  }
}

function onPortMessage(e) {
  const m = e.data;
  if (m && m.t === 'cmd') {
    if (!ensure()) {
      post({ t: 'event', msg: { id: m.cmd.id, type: 'error', message: 'AudioHelper.exe não encontrado' } });
      return;
    }
    proc.stdin.write(JSON.stringify({ ...m.cmd, selfPid }) + '\n');
  }
}

process.parentPort.on('message', (e) => {
  const m = e.data;
  if (m.type === 'config') {
    exe = m.exe;
    selfPid = m.selfPid;
  } else if (m.type === 'port') {
    // nova janela/recarga: troca o canal com a interface
    if (port) { try { port.close(); } catch {} stopCaptures(); }
    port = e.ports[0];
    port.on('message', onPortMessage);
    port.start();
  } else if (m.type === 'boost') {
    // prioridade de GPU dos processos do app (pedido pelo processo principal)
    lastBoost = m.pids;
    if (proc) sendBoost(); else ensure(); // ao subir, o ensure já envia
  } else if (m.type === 'quit') {
    // NUNCA encerrar o helper à força com a captura de áudio ligada: matar um processo no meio
    // de uma captura "process loopback" derruba o serviço de áudio do Windows (som e microfone
    // somem até o Windows reiniciá-lo). Pede para parar e fecha o stdin: ele encerra sozinho.
    if (!proc) process.exit(0);
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'video-stop' }) + '\n');
      proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
      proc.stdin.end();
    } catch {}
    proc.once('exit', () => process.exit(0));
    // sai mesmo assim depois de um tempo (o helper termina sozinho ao ver o stdin fechado);
    // o processo principal confere pelo pid antes de deixar o instalador rodar
    setTimeout(() => process.exit(0), 12000);
  }
});
