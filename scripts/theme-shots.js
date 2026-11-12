// Capturas dos temas no app de verdade, com a janela escondida.
// Uma cópia do app entra numa sala de teste e ganha três "amigos" de mentira: as telas deles são
// desenhos parados (os do catálogo, se a pasta design/ existir) em vez de vídeo de rede. Nada aqui usa
// a placa de vídeo, o som, o microfone, as telas de verdade nem a sala em uso: só a aparência.
//   node scripts/theme-shots.js [tema ...]     sem nome: todos os temas
//   --app=<pasta>     abre o app que está em outra pasta (ex.: uma cópia da versão publicada, para comparar)
//   --prefix=<texto>  começo do nome dos arquivos (ex.: antes-)
//   --size=LxA        tamanho da janela (padrão 1280x800; o menor que o app aceita é 900x560)
//   --eval=<arquivo>  para medir: roda o arquivo na página depois das capturas da entrada (ou, com --eval-sala, com a
//                     sala montada no primeiro tema), mostra o que ele devolver e termina
// Saída: design/capturas/<tema>-<n>-<cena>.png (janela de 1280 x 800).
// Rodar depois de mexer em src/renderer/themes/*.css, no themes.js ou no style.css.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
const { createSignalingServer } = require(path.join(ROOT, 'src', 'signaling'));
const PORT = 47911;
const OUT = path.join(ROOT, 'design', 'capturas');
const VERBOSE = process.argv.includes('-v');
const THEMES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const opt = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
const APP = opt('app') ? path.resolve(opt('app')) : ROOT;
const PREFIX = opt('prefix');
const SIZE = /^[0-9]+x[0-9]+$/.test(opt('size')) ? opt('size') : '1280x800';

// desenhos do catálogo para servir de "tela" dos amigos (sem eles, cores lisas)
function scenes() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'design', 'catalogo-temas', 'lib.js'), 'utf8');
    const w = {};
    new Function('window', src)(w); // eslint-disable-line no-new-func
    const out = {};
    for (const n of ['tatico', 'corrida', 'aventura', 'codigo']) {
      out[n] = w.L.scene(n).replace('<svg class="scene"', '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"');
    }
    return out;
  } catch { return null; }
}

/* eslint-disable no-undef */
// ---- roda dentro da página do app (vai como texto; os nomes soltos são do app.js) ----
async function page(CFG) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (m) => console.log('SHOTS ' + m);
  // na cena "você transmitindo" a transmissão é de mentira: quem espera uma captura de verdade pode reclamar (vira AVISO)
  let tolerate = false;
  window.addEventListener('error', (e) => log((tolerate ? 'AVISO ' : 'ERRO ') + e.message));
  window.addEventListener('unhandledrejection', (e) => log((tolerate ? 'AVISO promessa: ' : 'ERRO promessa: ') + ((e.reason && e.reason.message) || e.reason)));
  const until = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(100); }
    throw new Error('tempo esgotado: ' + what);
  };
  // a captura é pedida ao processo principal por uma linha no console (ver main.js)
  const shot = async (name) => { await sleep(450); console.log('SHOT ' + CFG.out + '/' + CFG.prefix + name + '.png'); await sleep(1300); log('captura ' + CFG.prefix + name); };
  // um app de antes dos temas não tem estes ganchos: aí só existe o visual de sempre
  const T = window.Themes || { list: [{ id: 'classico' }], set() {}, syncSelects() {} };
  const setQ = typeof setQText === 'function' ? setQText
    : (el, fps, ms, short) => { el.textContent = fps + ' fps · ' + ms + ' ms' + (short ? ' · ' + short : ''); };
  const paintQ = typeof paintPersonQuality === 'function' ? paintPersonQuality : () => {};
  try {
    for (const k of ['clipSys', 'mediactl', 'gamehide', 'autoMeasure', 'autoJoin', 'sideOpts']) localStorage.setItem(k, '0');
    // sem animações: a mesma tela dá sempre a mesma captura (dá para comparar duas versões ponto a ponto)
    const still = document.createElement('style');
    still.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
    document.head.appendChild(still);
    await sleep(1200);
    const themes = CFG.themes.length ? CFG.themes : T.list.map((t) => t.id);
    const bad = themes.filter((t) => !T.list.some((x) => x.id === t));
    if (bad.length) throw new Error('tema desconhecido: ' + bad.join(', '));

    // "telas" de mentira: um desenho parado virando trilha de vídeo (sem captura nem placa de vídeo)
    const canvasOf = async (name, color) => {
      const c = document.createElement('canvas');
      c.width = 1920; c.height = 1080;
      const g = c.getContext('2d');
      g.fillStyle = color; g.fillRect(0, 0, 1920, 1080);
      if (CFG.scenes && CFG.scenes[name]) {
        const im = new Image();
        im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(CFG.scenes[name]);
        try { await im.decode(); g.drawImage(im, 0, 0, 1920, 1080); } catch (e) { log('desenho ' + name + ' não abriu: ' + e.message); }
      }
      return c;
    };
    const trackOf = (canvas) => {
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      const w = gen.writable.getWriter();
      let n = 0;
      const push = () => { const f = new VideoFrame(canvas, { timestamp: n++ * 250000 }); w.write(f).catch(() => f.close()); };
      push();
      setInterval(push, 250);
      return gen;
    };
    const cv = { tatico: await canvasOf('tatico', '#123'), corrida: await canvasOf('corrida', '#234'), aventura: await canvasOf('aventura', '#312'), codigo: await canvasOf('codigo', '#222') };

    // ---------------------------------------------------------------- entrada
    const rooms = () => {
      discovered = [
        { ip: '26.87.140.12', hostName: 'Bia', members: 3, names: ['Bia', 'Rafa', 'Léo'] },
        { ip: '26.44.9.130', hostName: 'Léo', members: 2, names: ['Léo', 'Tuca'] },
      ];
      renderRooms();
      $('#rooms-searching').textContent = '';
    };
    $('#name').value = 'Tuca';
    if (window.paintMyName) window.paintMyName(); // alguns temas dão oi pelo nome
    // nada guardado de outra vez que este teste rodou (a sala de teste ficava na lista de recentes)
    localStorage.removeItem('recentRooms');
    localStorage.removeItem('hostIp');
    $('#host-ip').value = '';
    for (const t of themes) {
      T.set(t);
      await sleep(350);
      rooms();
      // primeiro como no catálogo (sem sala própria aberta); depois com o aviso de que a sala deste PC está aberta
      const open = !$('#my-room').classList.contains('hidden'), hostText = $('#btn-host').textContent;
      $('#my-room').classList.add('hidden');
      $('#btn-host').textContent = 'Hospedar sala';
      await shot(`${t}-1-entrada`);
      if (open) { $('#my-room').classList.remove('hidden'); $('#btn-host').textContent = hostText; await shot(`${t}-1b-entrada-sala-aberta`); }
    }

    if (CFG.evalCode && !CFG.evalRoom) { log('EVAL ' + JSON.stringify(await window.__shotsEval())); log('FIM'); setTimeout(() => window.close(), 300); return; }
    // ---------------------------------------------------------------- sala com três amigos de mentira
    checkName();
    joinRoom('127.0.0.1');
    await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala');
    healthLoop = async () => {};          // os números de qualidade são postos à mão, abaixo
    loadSources = async () => {};         // nada de capturar miniaturas das telas de verdade
    loadAudioOptions = async () => {};    // nem de olhar os programas que tocam som
    refreshMixer = async () => {};
    const Q = { 901: { fps: 60, ms: 14, level: 'good', short: '', mb: 16.4 }, 902: { fps: 58, ms: 23, level: 'warn', short: 'rede', mb: 9.8 }, 903: { fps: 60, ms: 31, level: 'good', short: '', mb: 12.1 } };
    for (const q of Object.values(Q)) { q.res = 1080; q.mbps = q.mb; }
    // histórico de qualidade de mentira (sempre os mesmos números)
    const fakeHist = (dipAt) => {
      const now = Date.now();
      return Array.from({ length: 300 }, (_, i) => {
        const dip = dipAt && i > dipAt && i < dipAt + 14;
        return {
          t: now - (300 - i) * 2000, fps: dip ? 34 + (i % 5) * 3 : 58 + (i % 3), mbps: dip ? 6 + (i % 4) : 12 + ((i * 7) % 5) * 0.6,
          rtt: dip ? 90 + (i % 6) * 9 : 14 + (i % 5), loss: dip ? 0.03 : 0, fz: dip && i === dipAt + 7 ? 1 : 0,
          level: dip ? (i === dipAt + 7 ? 'bad' : 'warn') : 'good', short: dip ? 'rede' : '', reason: dip ? 'rede instável' : 'tudo certo', h: 1080, thumb: false,
        };
      });
    };
    const STATS_TXT = '1920x1080 @ 60fps · 12.4 Mb/s · H265 · ping 14ms · buffer 38ms · travadas 0 · perdidos 0 · NACK 0 · PLI 0 · keyframes 3 · descartados 0\nrota direta (Radmin) · dec D3D11';
    const friend = (id, name, canvas, source) => {
      createPeer(id, name);
      const p = state.peers.get(id);
      Object.assign(p, { sharing: true, hasAudio: true, sourceName: source, conn: 'connected', q: Q[id], h265: true, av1: false });
      p.remoteStream.addTrack(trackOf(canvas));
    };
    friend('901', 'Bia', cv.tatico, 'Jogo');
    friend('902', 'Rafa', cv.corrida, 'Corrida');
    friend('903', 'Léo', cv.aventura, 'Aventura');
    addChat('', 'Léo entrou na sala', true);
    addChat('Bia', 'olha essa jogada kkkk');
    addChat('Rafa', 'salva o clipe!!');
    addChat('Tuca', 'salvei, tá na pasta');
    addChat('', 'clipe salvo (30 s)', true);
    addChat('Léo', 'bora mais uma?');
    const quality = () => {
      for (const p of state.peers.values()) {
        const q = Q[p.id];
        if (!p.tile || !p.tile.qtext) continue;
        setQ(p.tile.qtext, q.fps, q.ms, q.short, 1080, q.mb, 'H.265');
        p.tile.qbadge.className = 'qbadge ' + q.level;
        p.tile.qdot.className = 'qdot ' + q.level;
        paintQ(p);
      }
    };
    const focus = async () => { state.layout = 'focus'; state.focusId = '901'; render(); quality(); await sleep(500); };
    await focus();
    await sleep(1500);
    // a tela da Bia com o som ligado em 70% (as telas de teste não têm som nenhum: é só o desenho do volume)
    const tBia = state.peers.get('901').tile;
    if (tBia && tBia.setVolume) tBia.setVolume(0.7);
    // os atalhos gerais são do Windows: com o app de verdade aberto esta cópia de teste fica sem eles. Na captura
    // vale o caso normal (um app só), com os nomes de sempre
    document.querySelectorAll('#keys-bar .hidden').forEach((el) => el.classList.remove('hidden'));

    const force = document.createElement('style');
    document.head.appendChild(force);
    const src = [
      { id: 'screen:1:0', name: 'Tela 1', type: 'screen', thumbnail: cv.tatico.toDataURL('image/jpeg', 0.8), size: { width: 2560, height: 1440 } },
      { id: 'screen:2:0', name: 'Tela 2', type: 'screen', thumbnail: cv.codigo.toDataURL('image/jpeg', 0.8), size: { width: 1920, height: 1080 } },
      { id: 'window:1:0', name: 'Corrida - Volta 2 de 8', type: 'window', thumbnail: cv.corrida.toDataURL('image/jpeg', 0.8) },
      { id: 'window:2:0', name: 'Editor de código', type: 'window', thumbnail: cv.codigo.toDataURL('image/jpeg', 0.8) },
      { id: 'window:3:0', name: 'Aventura', type: 'window', thumbnail: cv.aventura.toDataURL('image/jpeg', 0.8) },
    ];
    const myTrack = trackOf(cv.codigo);
    const HOVER = '.tile .tile-bar > .tile-grip, .tile:not(.thumb) .tile-actions, .tile:not(.thumb) .react-bar { opacity: 1 !important; }';
    for (const t of themes) {
      T.set(t);
      await focus();
      if (CFG.evalCode) { log('EVAL ' + JSON.stringify(await window.__shotsEval())); log('FIM'); setTimeout(() => window.close(), 300); return; }
      await shot(`${t}-2-sala-foco`);
      // o mesmo com as estatísticas abertas
      state.hist.set('Bia', fakeHist(190)); state.hist.set('Rafa', fakeHist(90)); state.hist.set('Léo', fakeHist(0));
      state.showStats = true; render(); quality();
      for (const p of state.peers.values()) p.tile.stats.textContent = STATS_TXT;
      if (typeof paintStatsPane === 'function') paintStatsPane();
      await shot(`${t}-2b-sala-estatisticas`);
      state.showStats = false;
      for (const p of state.peers.values()) p.tile.stats.textContent = '';
      state.hist.clear();
      render(); quality();
      // com o mouse em cima da tela (os botões dela só aparecem assim em vários temas) e o volume aberto
      force.textContent = HOVER + ' .vol::before, .tile-actions .vol input, .tile-actions .vol-pct { opacity: 1 !important; }';
      await shot(`${t}-3-sala-botoes`);
      force.textContent = '';
      // emotes, mãozinha, toque e riscos dos amigos em cima da tela da Bia. Nunca na "minha" tela: isso abriria
      // as janelas por cima do monitor de verdade (para elas existe o scripts/fx-shots.js, que não mostra nada)
      if (typeof showInk === 'function') {
        const tb = state.peers.get('901').tile;
        const wave = (y) => Array.from({ length: 44 }, (_, i) => [0.1 + i * 0.011, y + Math.sin(i / 3) * 0.05, 0.1 + (i + 1) * 0.011, y + Math.sin((i + 1) / 3) * 0.05]);
        showInk('901', '902', 'Rafa', wave(0.3));                                                     // caneta do Rafa
        showInk('901', '903', 'Léo', [[0.68, 0.22, 0.84, 0.22], [0.84, 0.22, 0.84, 0.44], [0.84, 0.44, 0.68, 0.44], [0.68, 0.44, 0.68, 0.22]]); // caneta do Léo
        for (let i = 0; i < 26; i++) showLaser('901', '903', 'Léo', 0.46 + i * 0.009, 0.64 - Math.sin(i / 4) * 0.07, true); // rastro do Léo
        ['😂', '🔥', '👍', '😮', '💀', '❤️'].forEach((e, i) => showReaction('901', e, i % 2 ? 'Léo' : 'Rafa'));
        tb.el.querySelectorAll('.float-emoji').forEach((el, i) => { el.style.left = `${6 + i * 11}%`; });
        showPress('901', '902', 'Rafa', 0.3, 0.55);                                                    // mãozinha do Rafa apertando
        for (const l of Object.values(tb.lasers || {})) clearTimeout(l.timer);
        await sleep(120);
        console.log('SHOT ' + CFG.out + '/' + CFG.prefix + `${t}-3b-emotes-e-riscos` + '.png');
        await sleep(1500);
        log('captura ' + CFG.prefix + `${t}-3b-emotes-e-riscos`);
        hideLaser('901', '902'); hideLaser('901', '903');
        tb.trailLines = []; if (tb.trailDraw) tb.trailDraw();
        tb.el.querySelectorAll('.float-emoji, .press-ripple').forEach((el) => el.remove());
        await sleep(200);
      }
      state.layout = 'grid'; render(); quality();
      await shot(`${t}-4-sala-grade`);
      await focus();
      // opções: painel próprio nos temas sem barra lateral; na barra lateral nos outros
      const bo = $('#btn-options');
      if (bo && bo.offsetParent) bo.click(); else $('#side-opts').open = true;
      await shot(`${t}-5-opcoes`);
      $('#room').classList.remove('opts-open');
      $('#side-opts').open = false;
      // janela de compartilhar, com duas telas de mentira
      await openShareModal();
      sources = src; sourcesLoaded = { screen: true, window: true }; selectedSource = src[0];
      renderSources();
      updateRegionUi(); // o que aparece no rodapé quando a fonte escolhida é uma tela
      $('#btn-start-share').disabled = false;
      $('#opt-audio').innerHTML = '<option value="none">Sem áudio</option><option value="all-except" selected>Todo o som do PC, exceto Discord</option>';
      T.syncSelects();
      await shot(`${t}-6-compartilhar`);
      document.querySelector('#share-modal .tabs [data-tab="window"]').click();
      await sleep(200);
      sources = src; selectedSource = src[2];
      renderSources();
      $('#btn-start-share').disabled = false;
      await shot(`${t}-6b-compartilhar-janelas`);
      document.querySelector('#share-modal .tabs [data-tab="screen"]').click();
      $('#share-modal').classList.add('hidden');
      openAdjust();
      await shot(`${t}-7-ajustes`);
      $('#adjust-panel').classList.add('hidden');
      toast('Clipe salvo em Vídeos\\Tela Amigos');
      toast('A gravação parou: disco cheio. O que já foi gravado ficou salvo.', 'error');
      await shot(`${t}-8-avisos`);
      document.querySelectorAll('#toasts .toast').forEach((x) => x.remove());

      // sala sem ninguém transmitindo
      for (const p of state.peers.values()) p.sharing = false;
      render();
      await shot(`${t}-9-sala-vazia`);
      for (const p of state.peers.values()) p.sharing = true;
      await focus();

      // você transmitindo (de mentira: um desenho parado no lugar da captura), na fila e depois no canto
      tolerate = true;
      const mini0 = state.meMini;
      const mine = new MediaStream([myTrack]);
      state.share = { preview: mine, stream: mine, video: myTrack, sourceName: 'Tela 2', native: false };
      $('#btn-share').textContent = 'Trocar tela';
      // o caso com mais botões na sala: você hospeda e transmite
      for (const id of ['btn-stop', 'btn-adjust', 'btn-share2', 'btn-close-room']) $('#' + id).classList.remove('hidden');
      state.meMini = false;
      await focus();
      await shot(`${t}-10-transmitindo`);
      state.meMini = true; render(); quality();
      await shot(`${t}-11-previa-no-canto`);
      state.meMini = mini0;
      state.share = null;
      state.order = state.order.filter((id) => id !== 'me');
      $('#btn-share').textContent = 'Compartilhar tela';
      for (const id of ['btn-stop', 'btn-adjust', 'btn-share2', 'btn-close-room']) $('#' + id).classList.add('hidden');
      await focus();
      await sleep(300);
      tolerate = false;

      // grade com estatísticas, o menu "⋯" aberto e os avisos de reconexão, atualização e "todo mundo pronto"
      state.layout = 'grid'; state.showStats = true; render(); quality();
      $('#reconnect-banner').classList.remove('hidden');
      $('#update-text').textContent = 'Versão nova baixada. Reinicie para atualizar.';
      $('#btn-update').classList.remove('hidden');
      $('#update-bar').classList.remove('hidden');
      $('#ready-text').textContent = 'Bia perguntou: todo mundo pronto?';
      $('#ready-list').textContent = ' Prontos: Bia, Rafa';
      $('#ready-banner').classList.remove('hidden');
      const bia = state.peers.get('901').tile.el;
      openMoreMenu(bia.querySelector('.tile-actions'), bia.querySelector('.more-btn'));
      force.textContent = HOVER;
      for (const p of state.peers.values()) {
        p.tile.stats.textContent = STATS_TXT;
      }
      await shot(`${t}-12-menus-e-avisos`);
      closeMenus();
      force.textContent = '';
      for (const id of ['reconnect-banner', 'update-bar', 'btn-update', 'ready-banner']) $('#' + id).classList.add('hidden');
      state.showStats = false;
      await focus();

      // histórico de qualidade com números de mentira (sempre os mesmos)
      state.hist.set('Bia', fakeHist(190));
      openHistory('901');
      await shot(`${t}-13-historico`);
      closeHistory();

      // teste de conexão: tabela de mentira no mesmo formato da de verdade
      $('#nettest-body').innerHTML = '<table class="nettest-table"><tr><th>Amigo</th><th>Ping</th><th>Variação</th><th>Você → ele</th><th>Ele → você</th></tr>'
        + '<tr><td>Bia</td><td class="good">14 ms</td><td class="good">3 ms</td><td class="good">48.2 Mb/s</td><td class="good">61.0 Mb/s</td></tr>'
        + '<tr><td>Rafa</td><td class="warn">78 ms</td><td class="warn">31 ms</td><td class="warn">18.4 Mb/s</td><td class="good">35.7 Mb/s</td></tr>'
        + '<tr><td>Léo</td><td class="good">31 ms</td><td class="good">6 ms</td><td class="bad">7.9 Mb/s</td><td class="good">40.1 Mb/s</td></tr></table>'
        + '<p class="muted">Sugestão: 1080p 60 fps, 12 Mb/s por amigo (upload total até 36 Mb/s). Medido pelo Radmin; é um mínimo, a velocidade real pode ser maior.</p>';
      $('#nettest-apply').classList.remove('hidden');
      $('#nettest-modal').classList.remove('hidden');
      await shot(`${t}-14-teste-de-conexao`);
      $('#nettest-modal').classList.add('hidden');
      $('#nettest-apply').classList.add('hidden');
    }
    log('FIM');
  } catch (e) {
    log('ERRO ' + ((e && e.stack) || e));
  }
  setTimeout(() => window.close(), 600);
}
/* eslint-enable no-undef */

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-temas-'));
  const file = path.join(dir, 'pagina.js');
  const cfg = { themes: THEMES, out: OUT.replace(/\\/g, '/'), scenes: scenes(), prefix: PREFIX,
    evalCode: opt('eval') ? fs.readFileSync(path.resolve(opt('eval')), 'utf8') : '', evalRoom: process.argv.includes('--eval-sala') };
  const evalFn = cfg.evalCode ? `window.__shotsEval = async () => (${cfg.evalCode}\n);\n` : '';
  fs.writeFileSync(file, `${evalFn}(${page})(${JSON.stringify(cfg)});\n`);
  const server = await createSignalingServer(PORT);
  const env = { ...process.env, TELA_PROFILE: 'temas', TELA_PORT: String(PORT), TELA_TEST_SCRIPT: file, TELA_TEST_HIDDEN: '1', TELA_TEST_SIZE: SIZE, ELECTRON_ENABLE_LOGGING: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let rest = '';
  let erros = 0;
  let fim = false;
  child.stderr.on('data', () => {});
  child.stdout.on('data', (d) => {
    rest += d.toString();
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const l of parts) {
      const m = /SHOTS (.*)$/.exec(l);
      if (!m) { if (VERBOSE && /\[page\]/.test(l)) console.log('  ' + l.slice(0, 300)); continue; }
      if (m[1].startsWith('ERRO')) erros++;
      if (m[1] === 'FIM') fim = true;
      console.log('  ' + m[1]);
    }
  });
  const t = setTimeout(() => { console.log("TEMPO ESGOTADO"); child.kill(); }, 120000 + 60000 * (THEMES.length || 12)); // só a cópia de teste
  await new Promise((r) => child.on('exit', r));
  clearTimeout(t);
  try { server.close(); } catch {}
  console.log(fim && !erros ? `capturas em ${OUT}` : 'NÃO TERMINOU DIREITO');
  process.exit(fim && !erros ? 0 : 1);
})();
