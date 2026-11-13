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

    // ---------------------------------------------------------------- 0) Novidades: uma vez depois de cada atualização
    {
      await sleep(600);
      const N = window.News, K = N.KEY, LOG = window.CHANGELOG;
      const keep = { seen: localStorage.getItem(K), theme: window.Themes.current };
      const open = () => !$('#news-modal').classList.contains('hidden');
      const entries = () => document.querySelectorAll('#news-body .news-entry').length;
      check('novidades: numa cópia de teste não abre sozinha', !open());
      localStorage.removeItem(K);
      check('novidades: instalação nova não abre nada e já fica em dia', N.check({ known: false, current: '9.9.9' }).length === 0 && !open() && localStorage.getItem(K) === '9.9.9');
      localStorage.removeItem(K);
      const first = N.check({ known: true, current: '9.9.9' });
      check('novidades: quem já usava o app vê tudo na primeira vez', first.length === LOG.length && open() && entries() === LOG.length, 'entradas=' + entries());
      check('novidades: só conta como vista depois de fechar', localStorage.getItem(K) === null);
      const cards = [...document.querySelectorAll('#news-body .news-theme')];
      const on = () => cards.filter((c) => c.classList.contains('on')).map((c) => c.dataset.id).join(',');
      check('novidades: galeria com todos os temas e o atual marcado', cards.length === window.Themes.list.length && on() === window.Themes.current, cards.length + ' cartões; marcado=' + on());
      await Promise.all(cards.map((c) => c.querySelector('img')).filter(Boolean).map((im) => im.decode().catch(() => {})));
      const noImg = cards.filter((c) => { const im = c.querySelector('img'); return !im || !im.naturalWidth; }).map((c) => c.dataset.id);
      check('novidades: a miniatura de cada tema carregou', noImg.length === 0, noImg.join(','));
      const other = cards.find((c) => !c.classList.contains('on'));
      other.click();
      check('novidades: clicar num tema troca na hora e marca o novo', window.Themes.current === other.dataset.id && on() === other.dataset.id && document.documentElement.dataset.theme === other.dataset.id);
      window.Themes.set(keep.theme);
      check('novidades: trocar o tema por fora também acerta a marca', on() === keep.theme);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      check('novidades: Esc fecha e a versão fica como vista', !open() && localStorage.getItem(K) === '9.9.9');
      check('novidades: não abre de novo na mesma versão', N.check({ known: true, current: '9.9.9' }).length === 0 && !open());
      localStorage.setItem(K, '0.0.1');
      check('novidades: versão nova mostra o que veio depois da última vista', N.check({ known: true, current: '9.9.9' }).length === LOG.length && open());
      $('#news-ok').click();
      check('novidades: "Entendi" fecha e marca', !open() && localStorage.getItem(K) === '9.9.9');
      localStorage.setItem(K, '0.0.1');
      $('#btn-news').click();
      check('novidades: o link do rodapé abre todas as versões', open() && entries() === LOG.length);
      $('#news-modal').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      check('novidades: clicar fora fecha; aberta pelo rodapé não mexe no que já foi visto', !open() && localStorage.getItem(K) === '0.0.1');
      // volta ao que estava: a versão de verdade e o que este perfil de teste tinha guardado
      const real = await window.native.appVersion();
      localStorage.setItem(K, real);
      N.check({ known: true, current: real });
      if (keep.seen === null) localStorage.removeItem(K); else localStorage.setItem(K, keep.seen);
    }

    // ---------------------------------------------------------------- 0b) Troca de tema com a animação de instalação
    {
      const T = window.Themes, root = document.documentElement;
      const keepTheme = T.current;
      const clean = () => !root.classList.contains('vt-on') && !root.classList.contains('vt-run') && !root.dataset.vt && !T.transition
        && getComputedStyle($('#vt-hud')).display === 'none' && getComputedStyle($('#vt-fx')).display === 'none';
      T.set('classico');
      await T.pick('arena');
      check('troca de tema numa cópia de teste: na hora, sem animação', T.current === 'arena' && root.dataset.theme === 'arena' && clean());
      if (document.startViewTransition) {
        const p = T.pick('neon', { force: true });
        let vt = null;
        for (let i = 0; i < 200 && !(vt = T.transition); i++) await sleep(5);
        if (vt) await vt.ready;
        check('troca com animação: a plaquinha e os efeitos aparecem enquanto o tema se instala', !!vt && root.classList.contains('vt-on') && root.dataset.vt === 'neon'
          && getComputedStyle($('#vt-hud')).display !== 'none' && $('#vt-hud .vt-name').textContent === 'Neon');
        const t0 = performance.now();
        await p;
        const dur = performance.now() - t0;
        check('troca com animação: termina no tema novo, sem nada sobrando na tela', T.current === 'neon' && root.dataset.theme === 'neon' && clean(), Math.round(dur) + ' ms');
        // duas trocas seguidas: a segunda corta a primeira e vale a última
        const p1 = T.pick('fliperama', { force: true });
        await sleep(120);
        const p2 = T.pick('tocafitas', { force: true });
        await Promise.all([p1, p2]);
        check('duas trocas seguidas: vale a última, sem restos', T.current === 'tocafitas' && root.dataset.theme === 'tocafitas' && clean());
        check('dissolução do Fliperama: os quadros foram montados', !!root.style.getPropertyValue('--vt-px12'));
      } else log('CHECK pulado troca com animação (sem transição de tela neste Chromium)');
      T.set(keepTheme);
    }

    await join('VIDA A');
    const peer = () => [...state.peers.values()][0];
    await until(() => peer() && peer().pc.connectionState === 'connected' && peer().h265 !== undefined, 30000, 'conectar ao amigo');
    log('conectado');

    // ---------------------------------------------------------------- 0c) Vida dos temas (vida.js): as marcas no uso
    // Uma pessoa de mentira (o servidor da sala ignora recados para ela) entra, entra no ar, manda mensagem e sai, pelos
    // mesmos caminhos das mensagens de verdade. Sem som e sem notificação do Windows ("fulano começou a compartilhar",
    // que aparece com a janela sem foco): os dois ficam desligados durante este trecho.
    {
      const V = window.Vida, root = document.documentElement;
      const sfx = Sfx.play, Notif = window.Notification;
      Sfx.play = () => {};
      window.Notification = function () { return {}; };
      await sleep(2600); // passa o tempo de "acabou de entrar na sala" (quem já estava não ganha festa)
      const liOf = (id) => { const p = state.peers.get(id); return p && p.personEl; };
      check('vida: numa cópia de teste fica tudo parado', !root.classList.contains('vivo') && !root.classList.contains('foco'));
      onSignal({ type: 'peer-joined', id: '7771', name: 'Vida Teste' });
      check('vida: parada, quem entra não ganha marca', !liOf('7771').dataset.ev && !$('#room').dataset.ev && !$('#anuncio').dataset.ev);
      onSignal({ type: 'peer-left', id: '7771' });
      // a regra (a janela desta cópia está escondida: confere a regra e se ela lê o estado do app)
      const base = { testing: false, hidden: false, motion: false, gaming: false, light: false };
      check('vida: a regra anima no uso normal e para com jogo, modo leve, janela escondida e sem animações do Windows',
        V.regra(base) && !V.regra({ ...base, gaming: true }) && !V.regra({ ...base, light: true }) && !V.regra({ ...base, hidden: true }) && !V.regra({ ...base, motion: true }) && !V.regra({ ...base, testing: true }));
      const g0 = state.gaming, l0 = state.lightMode;
      state.gaming = true; state.lightMode = false;
      const a1 = V.agora();
      state.gaming = false; state.lightMode = true;
      const a2 = V.agora();
      state.gaming = g0; state.lightMode = l0;
      check('vida: a regra enxerga o jogo em tela cheia e o modo leve do app', a1.gaming === true && a1.light === false && a2.gaming === false && a2.light === true && a1.testing === true);
      V.force(true);
      check('vida: ligada, as marcas de animar e de janela em uso aparecem', root.classList.contains('vivo') && root.classList.contains('foco'));
      const n0 = $('#people').children.length;
      onSignal({ type: 'peer-joined', id: '7772', name: 'Vida Teste' });
      const li = liOf('7772');
      check('vida: quem entra chega marcado na lista, com o número dele no aviso', !!li && li.dataset.ev === 'entrou' && $('#room').dataset.ev === 'entrou'
        && $('#anuncio').dataset.ev === 'entrou' && $('#anuncio').dataset.n === li.dataset.n && $('#anuncio').dataset.nome === 'Vida Teste', li && li.dataset.n);
      check('vida: a contagem de pessoas ganha a marca de "mais um"', $('#people').children.length === n0 + 1 && $('#people-count').dataset.ev === 'mais');
      render(); // a lista é refeita: a marca continua, com o tempo andando
      const li2 = liOf('7772');
      check('vida: a lista refeita mantém a marca e o tempo dela', li2 !== li && li2.dataset.ev === 'entrou' && parseFloat(li2.style.getPropertyValue('--ev-t')) <= 0, li2.style.getPropertyValue('--ev-t'));
      onRelay('7772', { kind: 'state', sharing: true, audio: false, sourceName: 'Jogo' });
      const t7 = state.peers.get('7772').tile;
      check('vida: quem entra no ar ganha a marca na lista e na tela', liOf('7772').dataset.ev === 'aovivo' && !!t7 && t7.el.dataset.ev === 'aovivo' && $('#room').dataset.ev === 'aovivo');
      addChat('Vida Teste', 'oi, cheguei');
      const msg = $('#chat-log').lastElementChild;
      check('vida: mensagem nova chega marcada, com o tamanho para "digitar"', msg.dataset.ev === 'novo' && msg.style.getPropertyValue('--len') === String('Vida Teste oi, cheguei'.length));
      await sleep(V.EV_MS + 300);
      check('vida: alguns segundos depois as marcas somem sozinhas', !liOf('7772').dataset.ev && !t7.el.dataset.ev && !$('#room').dataset.ev && !$('#anuncio').dataset.ev && !msg.dataset.ev && !$('#people-count').dataset.ev);
      const nLeft = liOf('7772').dataset.n;
      onSignal({ type: 'peer-left', id: '7772' });
      check('vida: quem sai aparece no aviso e a contagem ganha a marca de "menos um"', $('#anuncio').dataset.ev === 'saiu' && $('#anuncio').dataset.n === nLeft && $('#people-count').dataset.ev === 'menos');
      V.force(false);
      check('vida: parar no meio limpa tudo na hora (nada fica marcado para recomeçar depois)', !root.classList.contains('vivo') && !document.querySelector('[data-ev]'));
      V.force(null);
      $('#chat-log').lastElementChild.remove();
      Sfx.play = sfx;
      window.Notification = Notif;
    }

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

    // ---------------------------------------------------------------- 4b) quem codifica a transmissão adaptativa, medido de verdade
    // Normal: a placa de vídeo, sem aviso. Com TELA_TEST_ARGS=--disable-accelerated-video-encode (o Chromium sem a
    // placa, como no PC do Toddy no diagnóstico de 2026-11-12): percebe, avisa e conta para o amigo (conferido no B).
    {
      const sw = !!window.SW_MODE;
      // (na Nativa adaptativa o Chromium não diz o nome do encoder: vale o estado da placa no Chromium; espera 3 medidas)
      await until(() => state.share && state.share.encSeen && state.share.gpuEnc && (!sw || state.share.soft), 20000, 'medida de quem codifica').catch(() => {});
      if (!sw) await sleep(5000);
      const sh = state.share;
      const got = sh ? `${sh.soft || 'sem aviso'} · placa no Chromium: ${sh.gpuEnc} · ${sh.encSeen || 'sem medida'}` : 'sem transmissão';
      if (sw) check('placa sem codificar (Chromium sem a placa): percebe e avisa', !!sh && sh.soft === 'placa' && toasts().some((x) => /placa de vídeo parou de codificar/.test(x)), got);
      else check('quem codifica a transmissão adaptativa: placa ligada no Chromium, sem aviso', !!sh && sh.gpuEnc === 'enabled' && !sh.soft, got);
    }

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

    // ---------------------------------------------------------------- 7b) servidor de vídeo só quando precisa
    // A sala de teste não é online, e o servidor de verdade gastaria o limite do mês: a opção fica "ligada" de mentira
    // e o servidor é trocado por um que só conta os pedidos. Confere a decisão (sfuDecide, com amigos de mentira), a
    // medida do upload (uploadShort) e que a transmissão só vai para o servidor quando a decisão manda.
    {
      const realWanted = sfuWanted;
      const S = window.Sfu, real = { publish: S.publish, unpublish: S.unpublish, published: S.published };
      let pubs = 0, unpubs = 0, isPub = false;
      sfuWanted = () => true;
      S.publish = async () => { pubs++; isPub = true; return { s: 'teste', v: 'v1', a: null, n: 1 }; };
      S.unpublish = async () => { unpubs++; isPub = false; };
      S.published = () => isPub;
      try {
        setOpts('native-direct', '720', 60);
        selectedSource = src; delay = 0;
        await startShare();
        await sfuSync();
        const sh = state.share;
        check('servidor quando precisar: a transmissão começa direto (não publica no servidor)', !!sh && pubs === 0 && !sh.sfu && !sfuInUse(), 'publicações=' + pubs);
        const v = (name, st, want = 'full') => ({ name, theyWant: want, pc: { connectionState: st } });
        const t0 = Date.now();
        const two = [v('A', 'connected'), v('B', 'connected')];
        const a = {};
        let d = null;
        for (let i = 0; i < 4; i++) d = sfuDecide(a, two, true, t0 + i * 2000);
        const before = d;
        d = sfuDecide(a, two, true, t0 + 8000);
        check('servidor quando precisar: upload apertado por 10 s seguidos com 2 amigos manda para o servidor (antes não)', before === null && !!d && d.use && !!a.sfuAuto, JSON.stringify(d));
        const b = {};
        sfuDecide(b, two, true, t0); sfuDecide(b, two, false, t0 + 2000);
        for (let i = 2; i < 6; i++) d = sfuDecide(b, two, true, t0 + i * 2000);
        check('servidor quando precisar: uma medida boa no meio recomeça a contagem', d === null && !b.sfuAuto);
        for (const st of ['failed', 'disconnected', 'connecting', 'new']) {
          const e = {}, list = [v('A', 'connected'), v('Léo', st)];
          const d1 = sfuDecide(e, list, false, t0), d2 = sfuDecide(e, list, false, t0 + 9000);
          check(`servidor quando precisar: quem assiste há mais de 8 s sem conexão direta (${st}) manda para o servidor`, d1 === null && !!d2 && d2.use && d2.lost === 'Léo');
        }
        const reco = {}, lista = [v('A', 'connected'), v('Léo', 'connecting')];
        sfuDecide(reco, lista, false, t0);
        lista[1].pc.connectionState = 'connected';
        check('servidor quando precisar: a conexão fechou antes dos 8 s, nada muda', sfuDecide(reco, lista, false, t0 + 9000) === null && !reco.sfuAuto);
        const cpuS = {};
        for (let i = 0; i < 4; i++) sfuDecide(cpuS, two, 'pc', t0 + i * 2000);
        d = sfuDecide(cpuS, two, 'pc', t0 + 8000);
        check('servidor quando precisar: PC sem dar conta de uma cópia para cada amigo (10 s) manda para o servidor', !!d && d.use && d.pc === true, JSON.stringify(d));
        const one = [v('A', 'connected')];
        const f = { sfuAuto: { at: t0, why: 'x' } };
        const f1 = sfuDecide(f, one, false, t0), f2 = sfuDecide(f, one, false, t0 + 20000), f3 = sfuDecide(f, one, false, t0 + 31000);
        check('servidor quando precisar: no servidor, volta ao direto só com um amigo assistindo por 30 s', f1 === null && f2 === null && !!f3 && f3.use === false && !f.sfuAuto);
        const g = { sfuAuto: { at: t0, why: 'x' } };
        sfuDecide(g, one, false, t0);
        const g2 = sfuDecide(g, two, false, t0 + 31000);
        check('servidor quando precisar: com dois ou mais assistindo, fica no servidor', g2 === null && !!g.sfuAuto);
        const h = { sfuAuto: { at: t0, why: 'x' } }, semDireta = [v('Nuke', 'connecting')];
        sfuDecide(h, semDireta, false, t0);
        const h2 = sfuDecide(h, semDireta, false, t0 + 31000);
        check('servidor quando precisar: o único que assiste está sem conexão direta: fica no servidor', h2 === null && !!h.sfuAuto);
        // a medida do upload na nativa direta: bitrate abaixo do que o servidor daria E dois caminhos reclamando
        const k0 = state.nativeKbps;
        const tight = [{ net: { st: { level: 'cong' } } }, { net: { st: { level: 'soft' } } }];
        const oneBad = [{ net: { st: { level: 'cong' } } }, { net: { st: { level: 'ok' } } }];
        state.nativeKbps = 1500;
        const u1 = await uploadShort({ direct: true, settings: { bitrate: 20 } }, tight);
        const u2 = await uploadShort({ direct: true, settings: { bitrate: 20 } }, oneBad);
        state.nativeKbps = 12000;
        const u3 = await uploadShort({ direct: true, settings: { bitrate: 20 } }, tight);
        state.nativeKbps = k0;
        check('servidor quando precisar: upload apertado = bitrate baixo e dois caminhos reclamando (um só, ou bitrate bom, não)', u1 === true && u2 === false && u3 === false, [u1, u2, u3].join(','));
        // a transmissão vai para o servidor e volta conforme a decisão
        sh.sfuAuto = { at: Date.now(), why: 'teste' };
        await sfuSync();
        check('servidor quando precisar: decidido, a transmissão passa a ir pelo servidor', pubs === 1 && !!sh.sfu && sfuInUse(), 'publicações=' + pubs);
        sh.sfuAuto = null;
        await sfuSync();
        check('servidor quando precisar: de volta ao direto, sai do servidor', unpubs === 1 && !sh.sfu && !sfuInUse(), 'saídas=' + unpubs);
      } finally {
        await stopShare();
        sfuWanted = realWanted;
        Object.assign(S, real);
      }
    }

    // ---------------------------------------------------------------- 7c) versão leve da direta: quem vai para ela
    // (o caminho dos quadros é conferido no smoke-test e, com o helper de verdade, no direct-test; aqui só as regras)
    {
      check('versão leve: miniatura e 540p ou menos recebem a leve; tela cheia sem pedir nada, não',
        wantsLight({ theyWant: 'thumb' }) && wantsLight({ theyWant: 'full', theyWantH: 480 }) && !wantsLight({ theyWant: 'full', theyWantH: 720 }) && !wantsLight({ theyWant: 'full' }));
      const fake = { name: 'Rede Fraca', sendQueue: Promise.resolve() };
      const t0 = Date.now();
      clearToasts();
      markWeak(fake, t0);
      const first = fake.weakUntil - t0, ok1 = wantsLight({ theyWant: 'full', weakUntil: fake.weakUntil });
      markWeak(fake, fake.weakEnd + 30000); // caiu de novo logo depois de voltar para a cheia
      const second = fake.weakMs;
      check('versão leve: rede fraca vai para a leve por 1 min; caindo de novo logo depois de voltar, espera o dobro', first === 60000 && ok1 && second === 120000, first + ' / ' + second);
      check('versão leve: avisa quem transmite uma vez (não a cada queda)', toasts().filter((t) => /Rede Fraca/.test(t)).length === 1);
      clearToasts();
      const sentKb = [];
      const vb = window.Helper.videoBitrate;
      window.Helper.videoBitrate = (kb, light) => { if (light) sentKb.push(kb); };
      const sh = { videoLight: {}, lightKbps: 1800, codec: 'h264', lightAt: 0 };
      lightBitrate(sh, 1000);         // a pior rede da leve aguenta ~1 Mb/s: 85% disso
      const a = sh.lightKbps;
      lightBitrate(sh, 1050);         // mudança pequena e logo em seguida: não mexe
      sh.lightAt = 0;
      lightBitrate(sh, Infinity);     // ninguém reclamando: volta ao teto
      window.Helper.videoBitrate = vb;
      check('versão leve: o bitrate acompanha a pior rede dela e volta ao teto (sem ficar mexendo à toa)', a === 850 && sentKb.join(',') === '850,1800' && sh.lightKbps === 1800, sentKb.join(','));
    }

    // ---------------------------------------------------------------- 7d) a placa de vídeo está codificando?
    // (nomes e tamanhos medidos neste Electron; o caso real é o do diagnóstico de 2026-11-12)
    {
      const nv = 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)';
      const S = (w, h, enc, hw, mime = 'video/H264') => ({ w, h, enc, hw, mime });
      check('placa codificando: tudo na placa, nada a avisar', softEncode([S(1280, 720, nv, true), S(1920, 1080, nv, true)]) === null);
      check('placa codificando: OpenH264 pequeno (320x180) é normal', softEncode([S(320, 180, 'OpenH264', false), S(1280, 720, nv, true)]) === null);
      check('placa codificando: tudo grande no OpenH264 (placa travada) = "placa"', softEncode([S(1280, 720, 'OpenH264', false), S(1280, 720, 'OpenH264', false)]) === 'placa');
      check('placa codificando: sem o powerEfficientEncoder, pelo nome', softEncode([S(1280, 720, 'OpenH264')]) === 'placa' && softEncode([S(1280, 720, nv)]) === null);
      check('placa codificando: parte na placa e parte no processador = "limite"', softEncode([S(1280, 720, nv, true), S(1280, 720, 'OpenH264', false)]) === 'limite');
      check('placa codificando: AV1 no libaom = "codec"', softEncode([S(1280, 720, 'libaom', false, 'video/AV1')]) === 'codec');
      check('placa codificando: servidor com camadas (adaptador com placa e OpenH264) não avisa',
        softEncode([S(1280, 720, `SimulcastEncoderAdapter (OpenH264, ${nv})`, true), S(320, 180, `SimulcastEncoderAdapter (OpenH264, ${nv})`, true)]) === null);
      // o aviso só depois de 3 medidas seguidas, uma vez; e some quando a placa volta
      const sh = {}, bad = [S(1280, 720, 'OpenH264', false)];
      for (const k of Object.keys(softWarned)) delete softWarned[k]; // (um aviso de verdade antes, no teste, não conta)
      const realToast = toast;
      let toasts = 0;
      toast = () => { toasts++; };
      try {
        softCheck(sh, bad); softCheck(sh, bad);
        const before = sh.soft;
        softCheck(sh, bad);
        const at3 = sh.soft;
        softCheck(sh, bad);
        softCheck(sh, [S(1280, 720, nv, true)]);
        check('placa codificando: com a codificação pela placa desligada no Chromium, avisa mesmo sem o nome do encoder',
        softEncode([S(1280, 720, '', undefined)], true) === 'placa' && softEncode([S(1280, 720, '', undefined)], false) === null && softEncode([S(320, 180, '', undefined)], true) === null);
      check('placa codificando: avisa na 3ª medida seguida, uma vez só, e limpa quando a placa volta',
          !before && at3 === 'placa' && toasts === 1 && sh.soft === null && /placa/.test(sh.encSeen || ''), `${before} ${at3} toasts=${toasts} ${sh.encSeen}`);
      } finally { toast = realToast; }
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
    // o codificador do replay para no meio (a placa travou): o replay começa outro e volta a guardar
    {
      const Real = window.VideoEncoder;
      let made = 0, killed = false;
      window.VideoEncoder = class extends Real {
        constructor(init) { super(init); this.n = 0; this.first = made++ === 0; }
        encode(f, o) { if (this.first && ++this.n === 30) { killed = true; this.close(); return; } return super.encode(f, o); }
      };
      window.VideoEncoder.isConfigSupported = (c) => Real.isConfigSupported(c);
      const v = fakeVideo('#246'), a = fakeAudio(); fakes.push(v, a);
      const cur = new MediaStream([v.track, a.track]);
      try {
        window.Clips.toggle('teste2', cur, 'teste2', { source: () => cur });
        await until(() => killed, 8000, 'o codificador parar').catch(() => {});
        await sleep(4500);
        let clip = null, err = '';
        try { clip = window.Clips.build('teste2'); } catch (e) { err = e.message; }
        check('replay: o codificador parou no meio e o replay voltou sozinho', killed && made >= 2 && !!clip && clip.seconds > 1.2,
          `parou=${killed} codificadores=${made} ${clip ? clip.seconds.toFixed(1) + ' s' : 'vazio ' + err}`);
      } finally { window.Clips.stop('teste2'); window.VideoEncoder = Real; v.stop(); a.stop(); }
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
    // Esta cópia abre JÁ no Fliperama (guardado pela rodada anterior, no fim deste roteiro): é o tema que tira quatro
    // botões da barra de cima. Trocar de tema tem de devolver todos na ordem da página (na v1.0.60 "Parar" voltava
    // antes de "+ 2ª tela" e "Ajustes", até reabrir o app).
    {
      const HOME = 'btn-stats,btn-camera,btn-share,btn-share2,btn-adjust,btn-stop,btn-options,btn-leave,btn-close-room';
      const top = () => [...document.querySelector('.top-actions').children].map((e) => e.id).join(',');
      const bootTheme = window.Themes.current;
      window.Themes.set('classico');
      if (bootTheme === 'fliperama') check('abrir o app no Fliperama e trocar de tema: botões de cima na ordem certa', top() === HOME, top());
      else log('CHECK pulado abrir o app no Fliperama e trocar de tema (vale a partir da segunda rodada: o tema fica guardado agora)');
      localStorage.setItem('theme', 'fliperama'); // só para a próxima abertura desta cópia de teste; agora segue no Clássico
    }
    // "Entrar sozinho na última sala": com a opção ligada, o app tem que entrar sem ninguém clicar
    const already = !$('#room').classList.contains('hidden'); // (rodada anterior deixou ligado: entrou ao abrir)
    if (!already) {
      localStorage.setItem('autoJoin', '1'); localStorage.setItem('name', 'VIDA B'); localStorage.setItem('hostIp', '127.0.0.1'); localStorage.setItem('lastRole', 'guest');
      $('#host-ip').value = '127.0.0.1';
      autoJoinOnStart();
    }
    let joined = true;
    // o motivo que o A manda quando a placa dele não codifica (só no modo TELA_TEST_ARGS=--disable-accelerated-video-encode)
    let sawSw = null;
    setInterval(() => { for (const p of state.peers.values()) if (p.health && p.health.sw) sawSw = p.health.sw; }, 500);
    await until(() => !$('#room').classList.contains('hidden'), 8000, 'entrar sozinho').catch(() => { joined = false; });
    check('"entrar sozinho na última sala" entra sem clique' + (already ? ' (já ao abrir o app)' : ''), joined);
    localStorage.setItem('autoJoin', '0');
    if (!joined) { $('#name').value = 'VIDA B'; checkName(); joinRoom('127.0.0.1'); await until(() => !$('#room').classList.contains('hidden'), 15000, 'entrar na sala'); }
    await until(() => /fim-a/.test($('#chat-log').textContent), 170000, 'A terminar');
    if (window.SW_MODE) check('placa sem codificar: o amigo recebe o motivo (para o indicador dele)', sawSw === 'placa', String(sawSw));
    else check('placa codificando: o amigo não recebe aviso de processador', sawSw === null, String(sawSw));
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
  // TELA_TEST_ARGS: chaves a mais para o Chromium das cópias (ex.: --disable-accelerated-video-encode)
  const extra = (process.env.TELA_TEST_ARGS || '').split(/\s+/).filter(Boolean);
  const swMode = extra.includes('--disable-accelerated-video-encode');
  fs.writeFileSync(file, `${swMode ? 'window.SW_MODE = true;\n' : ''}(${pageCommon})();\n(${fn})();\n`);
  const env = { ...process.env, TELA_PROFILE: 'smoke-' + name, TELA_PORT: String(PORT), TELA_TEST_SCRIPT: file, TELA_TEST_HIDDEN: '1', ELECTRON_ENABLE_LOGGING: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.', ...extra], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
