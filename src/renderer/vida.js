// Vida dos temas: no uso do dia a dia cada tema reage quando alguém entra, sai, entra no ar ou manda mensagem, e alguns
// têm detalhes que se mexem sozinhos (estrelas, bobinas, folhas, lâmpadas). O desenho fica todo no tema-vida.css; aqui
// só ficam as marcas que ele usa:
//   html.vivo   pode animar: janela à vista, sem jogo em tela cheia, sem o modo leve e com as animações do Windows ligadas
//   html.foco   e a janela está em uso: só assim rodam os detalhes que ficam se mexendo sem parar
//   data-ev     "acabou de acontecer", por alguns segundos: na pessoa da lista e na tela dela ("entrou", "aovivo"), na
//               mensagem nova do chat ("novo"), na contagem de pessoas ("mais", "menos"), na sala e no #anuncio
//               ("entrou", "saiu", "aovivo")
//   --ev-t      há quanto tempo foi, negativo (vai no animation-delay): a lista de pessoas é refeita a cada mudança e a
//               animação continua de onde estava em vez de recomeçar
//   --fase      o mesmo para o que se mexe sem parar na lista (com períodos que dividem 12 s, fica sempre no compasso)
//   --nivel     o som de cada tela agora, de 0 a 1, nos temas que pedem (--vida-nivel: 1; o ponteiro do Toca-fitas)
// Nas cópias de teste fica tudo parado (as capturas saem sempre iguais), a não ser com Vida.force(true).
window.Vida = (() => {
  const EV_MS = 2800;
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const marks = new Map(); // id da pessoa ('me' é você; 'conta' é a contagem) -> { tipo, t }
  let forced = null;
  let hold = false;   // prévias: o que aconteceu fica marcado até a próxima chamada de force (ver force)
  let testing = true; // até o processo principal responder, como cópia de teste (parado)
  let get = { gaming: () => false, light: () => false, tiles: () => [] };
  let salaTimer = 0;
  let nivelTimer = 0;

  const fase = () => `${-Math.round(performance.now() % 12000)}ms`;
  const on = () => root.classList.contains('vivo');

  // a regra: anima só fora das cópias de teste, com a janela à vista, as animações do Windows ligadas, sem jogo em tela
  // cheia e sem o modo leve
  const regra = (s) => !s.testing && !s.hidden && !s.motion && !s.gaming && !s.light;
  const agora = () => ({ testing, hidden: document.hidden, motion: motion.matches, gaming: !!get.gaming(), light: !!get.light() });

  // theme: o tema mudou (o medidor de som é coisa de alguns temas)
  function update(theme = false) {
    const vivo = forced != null ? forced : regra(agora());
    const foco = vivo && (forced != null || document.hasFocus());
    const wasVivo = root.classList.contains('vivo');
    const wasFoco = root.classList.contains('foco');
    if (wasVivo !== vivo) {
      root.classList.toggle('vivo', vivo);
      // parou: o que estava acontecendo não recomeça depois, fora de hora
      if (!vivo) { marks.clear(); for (const el of document.querySelectorAll('[data-ev]')) el.removeAttribute('data-ev'); }
    }
    if (wasFoco !== foco) {
      root.classList.toggle('foco', foco);
      // os detalhes da lista voltam a se mexer agora: no compasso dos que forem criados depois
      if (foco) for (const li of document.querySelectorAll('#people li')) li.style.setProperty('--fase', fase());
    }
    if (theme === true || wasFoco !== foco) nivelLoop();
  }

  // a peça que mostra a pessoa (ou a contagem): recebe a marca, se ainda vale. Para peças refeitas a cada mudança
  // (as da lista): o --ev-t novo faz a animação seguir de onde estava. `once`: peças que ficam (as telas), marcadas uma
  // vez só por acontecimento (mudar o atraso de uma animação em andamento faria ela pular)
  function paint(el, id, once = false) {
    if (!el) return;
    el.dataset.vid = id;
    if (!once) el.style.setProperty('--fase', fase());
    const m = marks.get(id);
    if (!m || !on()) { if (el.dataset.ev) el.removeAttribute('data-ev'); return; }
    if (once && el._vida === m) return;
    el._vida = m;
    el.style.setProperty('--ev-t', `${-Math.round(performance.now() - m.t)}ms`);
    el.dataset.ev = m.tipo;
  }

  // você acabou de entrar numa sala: quem já estava (e já transmitia) aparece de uma vez, sem festa para cada um
  let quietUntil = 0;
  const entrei = () => { quietUntil = performance.now() + 2500; };
  const quiet = () => performance.now() < quietUntil;

  // aconteceu com uma pessoa: 'entrou' ou 'aovivo' (a lista e a tela dela pegam a marca no próximo desenho)
  function mark(id, tipo) {
    if (!on() || quiet()) return;
    const m = { tipo, t: performance.now() };
    marks.set(id, m);
    setTimeout(() => {
      if (hold || marks.get(id) !== m) return;
      marks.delete(id);
      for (const el of document.querySelectorAll(`[data-vid="${CSS.escape(String(id))}"][data-ev]`)) el.removeAttribute('data-ev');
    }, EV_MS);
  }

  // recomeça a animação de uma peça que já estava marcada (dois acontecimentos seguidos)
  function restart(el, tipo) {
    if (el.dataset.ev) { el.removeAttribute('data-ev'); void el.offsetWidth; }
    el.dataset.ev = tipo;
  }

  // aconteceu na sala: 'entrou', 'saiu' ou 'aovivo'. n: o número da pessoa na lista; nome: o nome dela
  function sala(tipo, n, nome) {
    if (!on() || quiet()) return;
    const room = document.getElementById('room');
    const an = document.getElementById('anuncio');
    if (an) { an.dataset.n = n || ''; an.dataset.nome = nome || ''; restart(an, tipo); }
    if (room) restart(room, tipo);
    // a contagem: quem entrou já está na lista (marca agora); quem saiu ainda não saiu dela (a marca vale no próximo desenho)
    if (tipo === 'entrou' || tipo === 'saiu') {
      mark('conta', tipo === 'entrou' ? 'mais' : 'menos');
      if (tipo === 'entrou') paint(document.getElementById('people-count'), 'conta');
    }
    clearTimeout(salaTimer);
    salaTimer = setTimeout(() => { if (!hold) for (const el of [room, an]) if (el) el.removeAttribute('data-ev'); }, EV_MS);
  }

  // mensagem nova no chat (len: quantas letras, para os temas que "digitam")
  function chat(div, len) {
    if (!on()) return;
    div.style.setProperty('--len', Math.max(1, Math.min(90, len | 0)));
    div.dataset.ev = 'novo';
    setTimeout(() => { if (!hold) div.removeAttribute('data-ev'); }, EV_MS);
  }

  // ---- o som de cada tela, para os temas que desenham um medidor (10 vezes por segundo, só com a janela em uso) ----
  function nivelLoop() {
    const want = root.classList.contains('foco') && getComputedStyle(root).getPropertyValue('--vida-nivel').trim() === '1';
    if (want && !nivelTimer) nivelTimer = setInterval(nivelTick, 100);
    if (!want && nivelTimer) {
      clearInterval(nivelTimer);
      nivelTimer = 0;
      for (const el of document.querySelectorAll('[data-nivel]')) { el.removeAttribute('data-nivel'); el.style.removeProperty('--nivel'); }
    }
  }
  function nivelTick() {
    for (const t of get.tiles()) {
      const host = t && t.el && t.el.isConnected && t.el.querySelector('.vol');
      if (!host) continue;
      const v = t.audio && t.audio.meter ? t.audio.meter() : null;
      if (v == null) {
        t.vu = 0;
        if (host.dataset.nivel) { host.removeAttribute('data-nivel'); host.style.removeProperty('--nivel'); }
        continue;
      }
      // sobe rápido e desce devagar, como o ponteiro de verdade
      t.vu = v > (t.vu || 0) ? t.vu * 0.35 + v * 0.65 : t.vu * 0.75 + v * 0.25;
      host.style.setProperty('--nivel', t.vu.toFixed(3));
      if (!host.dataset.nivel) host.dataset.nivel = '1';
    }
  }

  function init(getters) {
    get = { ...get, ...getters };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    motion.addEventListener('change', update);
    if (window.Themes) window.Themes.onChange(() => update(true));
    setInterval(update, 1000); // jogo em tela cheia e modo leve mudam em vários lugares do app: confere sempre
    const asked = window.native && window.native.testing ? window.native.testing() : Promise.resolve(false);
    Promise.resolve(asked).then((t) => { testing = !!t; update(true); }, () => { testing = false; update(true); });
    update(true);
  }

  return {
    init, update, paint, mark, sala, chat, entrei, regra, agora, EV_MS,
    // força ligado (true), desligado (false) ou volta ao normal (null): prévias e testes. segura: o que acontecer fica
    // marcado até a próxima chamada (para fotografar quadro a quadro com as animações paradas)
    force(v, segura = false) {
      forced = v == null ? null : !!v;
      if (hold && !segura) { marks.clear(); for (const el of document.querySelectorAll('[data-ev]')) el.removeAttribute('data-ev'); }
      hold = !!segura;
      update(true);
    },
  };
})();
