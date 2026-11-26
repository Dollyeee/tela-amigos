// Teste do "Testar a captura com jogo" no auxiliar (helper-bin/AudioHelper.exe), sem jogo e sem capturar a tela de quem
// roda: uma janelinha de teste (AudioHelper.exe --captest-fakegame) faz o papel do jogo, no canto da tela e sem pegar o
// foco; os passos "da tela" capturam só ela (TELA_CAPTEST_NOMONITOR=1) e as janelas por cima ficam só sobre ela. O passo
// DXGI "cai" de mentira (TELA_CAPTEST_CRASH=dxgi) para conferir que o teste continua e anota a queda. Nada de som.
// Também confere a leitura do registro de falhas do Windows com um XML de exemplo (--crash-info-parse).
//   node scripts/captest-test.js
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const exe = path.join(__dirname, '..', 'helper-bin', 'AudioHelper.exe');
if (!fs.existsSync(exe)) { console.error('falta helper-bin/AudioHelper.exe (npm run build:helper)'); process.exit(1); }
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FALHOU'} ${what}`); if (!ok) fails++; };

// ---------------------------------------------------------------- 1) registro de falhas do Windows
const ev1000 = (app, pid, mod) => `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID>1000</EventID>` +
  `<TimeCreated SystemTime='2026-11-26T20:28:18.1234567Z'/><Execution ProcessID='4321' ThreadID='1'/></System><EventData>` +
  `<Data Name='AppName'>${app}</Data><Data Name='AppVersion'>1.0.0.0</Data><Data Name='AppTimeStamp'>0</Data><Data Name='ModuleName'>${mod}</Data>` +
  `<Data Name='ModuleVersion'>32.0.16.2124</Data><Data Name='ModuleTimeStamp'>0</Data><Data Name='ExceptionCode'>c0000005</Data>` +
  `<Data Name='FaultingOffset'>00000000001a2b3c</Data><Data Name='ProcessId'>0x${pid.toString(16)}</Data><Data Name='ProcessCreationTime'>0</Data>` +
  `<Data Name='AppPath'>C:\\Users\\Doge\\AppData\\Local\\Programs\\tela-amigos\\resources\\AudioHelper.exe</Data>` +
  `<Data Name='ModulePath'>C:\\Windows\\System32\\DriverStore\\FileRepository\\nv\\${mod}</Data></EventData></Event>`;
const ev1026 = (pid) => `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='.NET Runtime'/><EventID>1026</EventID>` +
  `<TimeCreated SystemTime='2026-11-26T20:28:17.9Z'/><Execution ProcessID='${pid}' ThreadID='2'/></System><EventData><Data>Application: AudioHelper.exe\r\n` +
  `CoreCLR Version: 10.0.0\r\n.NET Version: 10.0.0\r\nDescription: The process was terminated due to an unhandled exception.\r\n` +
  `Exception Info: System.AccessViolationException: Attempted to read or write protected memory.\r\n` +
  `   at Vortice.DXGI.IDXGIOutputDuplication.AcquireNextFrame(UInt32, OutduplFrameInfo ByRef, IDXGIResource ByRef)\r\n` +
  `   at VideoStreamer.DdLoopInner(Int32 ByRef) in C:\\Users\\andre\\src\\VideoStreamer.cs:line 825\r\n</Data></EventData></Event>`;
const xml = ev1000('AudioHelper.exe', 7777, 'outro.dll') + ev1026(6699) + ev1000('jogo.exe', 6699, 'jogo.dll') + ev1000('AudioHelper.exe', 6699, 'nvwgf2umx.dll');
const pr = spawnSync(exe, ['--crash-info-parse', '6699'], { input: xml, encoding: 'utf8', windowsHide: true });
let info = null;
try { info = JSON.parse(pr.stdout.trim()); } catch {}
check(info && info.module === 'nvwgf2umx.dll', `queda: peça que falhou = ${info && info.module}`);
check(info && info.exception === '0xc0000005' && info.offset === '0x00000000001a2b3c', `queda: exceção ${info && info.exception}, deslocamento ${info && info.offset}`);
check(info && /AccessViolation/.test(info.dotnet || '') && /AcquireNextFrame/.test(info.dotnet || ''), 'queda: exceção e pilha do .NET');
check(info && !/Users\\andre|Users\\Doge/.test(JSON.stringify(info)), 'queda: sem pasta de usuário no relatório');
const none = spawnSync(exe, ['--crash-info-parse', '1234'], { input: xml, encoding: 'utf8', windowsHide: true });
check(none.stdout.trim() === 'null', 'queda: outro pid não confunde');

// ---------------------------------------------------------------- 2) o teste inteiro, com o jogo de mentira
(async () => {
  const fake = spawn(exe, ['--captest-fakegame', '90'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const hwnd = await new Promise((resolve, reject) => {
    let out = '';
    fake.stdout.on('data', (d) => { out += d; const m = /FAKEGAME (\d+)/.exec(out); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('a janela de teste não abriu')), 10000);
  });
  const helper = spawn(exe, [], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, TELA_CAPTEST_HWND: hwnd, TELA_CAPTEST_NOMONITOR: '1', TELA_CAPTEST_CRASH: 'dxgi' },
  });
  const msgs = [];
  let buf = Buffer.alloc(0);
  helper.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      if (buf[0] === 1) { try { msgs.push(JSON.parse(buf.subarray(5, 5 + len).toString('utf8'))); } catch {} }
      buf = buf.subarray(5 + len);
    }
  });
  const t0 = Date.now();
  helper.stdin.write(JSON.stringify({ id: 1, cmd: 'captest', secs: 3, selfPid: process.pid }) + '\n');
  let res = null;
  while (Date.now() - t0 < 120000) {
    res = msgs.find((m) => m.id === 1);
    if (res) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // ninguém é encerrado à força: fechar a entrada faz os dois saírem sozinhos
  helper.stdin.end();
  fake.stdin.end();
  check(res && res.type === 'captest', `resposta do teste (${res ? res.type : 'nenhuma'}${res && res.message ? ': ' + res.message : ''}) em ${Math.round((Date.now() - t0) / 1000)} s`);
  const rep = (res && res.report) || {};
  const steps = rep.steps || [];
  const by = Object.fromEntries(steps.map((s) => [s.method, s]));
  console.log('passos:', steps.map((s) => `${s.method}: ${s.crashed ? 'caiu ' + s.exitCode : s.error ? 'erro ' + s.error : `${s.changed}/${s.frames} quadros, maior parada ${s.maxGapMs} ms${s.overlay ? ', janela por cima ' + s.overlay : ''}`}`).join(' | '));
  check(rep.ok === true && rep.game && rep.game.exe === 'audiohelper.exe', `jogo = ${rep.game && rep.game.exe}`);
  check(steps.length === 5, `5 passos (${steps.length})`);
  for (const m of ['wgc-monitor', 'wgc-window', 'wgc-monitor+tiny', 'wgc-monitor+full']) {
    const s = by[m] || {};
    check(!s.error && !s.crashed && s.changed >= 30 && s.maxGapMs < 1500, `${m}: imagem andando (${s.changed} mudaram de ${s.frames}, maior parada ${s.maxGapMs} ms)`);
  }
  check(by['wgc-monitor+tiny'] && by['wgc-monitor+tiny'].overlay === 'ok' && by['wgc-monitor+full'] && by['wgc-monitor+full'].overlay === 'ok', 'janelas por cima abriram');
  const d = by.dxgi || {};
  check(d.crashed === true && d.exitCode === '0xC0000005', `dxgi "caiu" e o teste continuou (${d.exitCode})`);
  check(Array.isArray(d.stderr) && d.stderr.some((l) => /queda simulada/.test(l)), 'dxgi: últimas linhas do passo anotadas');
  check(rep.system && typeof rep.system.windows === 'string' && 'mpoOverlayTestMode' in rep.system && 'hagsHwSchMode' in rep.system, `configurações: ${rep.system && rep.system.windows}`);
  check(Array.isArray(rep.monitors) && rep.monitors.length >= 1 && rep.monitors.some((m) => m.hz > 0), `monitores: ${(rep.monitors || []).map((m) => `${m.width}x${m.height}@${m.hz}${m.mpo ? ' mpo' : ''}${m.hdr ? ' hdr' : ''}`).join(', ')}`);
  check(Array.isArray(rep.programs), `programas conhecidos abertos: ${(rep.programs || []).join(', ') || 'nenhum'}`);
  check(msgs.some((m) => m.type === 'captest-progress' && m.phase === 'step' && m.i === 5), 'andamento passo a passo');
  await new Promise((r) => setTimeout(r, 1500));
  check(helper.exitCode !== null && fake.exitCode !== null, 'auxiliar e janela de teste fecharam sozinhos');
  console.log(fails ? `\n${fails} FALHARAM` : '\nTESTE DE CAPTURA COM JOGO PASSOU');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
