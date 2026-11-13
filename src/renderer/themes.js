// Temas do app. Cada tema é uma folha de estilo em themes/<id>.css cujas regras só valem quando o
// <html> está com data-theme="<id>". A escolha fica no localStorage deste PC: cada amigo tem a sua e
// o tema de um não muda nada para os outros. "classico" é o visual de sempre (só o style.css).
//
// Este arquivo é carregado no <head>, antes das folhas de estilo, para o tema já valer no primeiro
// desenho da janela (sem piscar o visual antigo).
(() => {
  // bar: cor de fundo e dos símbolos dos botões da janela (minimizar/maximizar/fechar), que são do Windows
  // barH: altura da faixa desses botões, quando o topo do tema não tem os 56 px de sempre
  // barLobby / barLobbyH: o mesmo só para a tela de entrada, quando ela tem outro fundo que a sala
  // place: peças que mudam de lugar (seletor -> seletor de destino); voltam para casa nos outros temas
  // tile: como cada tela é arrumada por dentro (ver tileSetup)
  // text: rótulos com outro nome no tema (seletor -> texto); só títulos e legendas, nunca botões.
  //       "seletor@atributo" troca um atributo (ex.: o texto de exemplo de um campo)
  // Varanda tem duas versões (dia e noite) com o mesmo desenho: só as cores mudam (ver themes/varanda.css)
  const VARANDA = {
    place: { '.top-actions': '#stage', '#btn-options': '.side-links' },
    tile: { frame: [20, 20] },
    text: {
      '.sidebar h3 .h3-t': 'Na varanda',
      '.lobby-head p': 'Bora juntar a turma? A tela vai em 60 fps, direto de PC para PC.',
      '.lobby-actions .lobby-box:first-child h2': 'Abrir a minha sala',
      '.lobby-actions .lobby-box:last-child h2': 'Entrar numa sala',
      '.settings .field:has(#opt-fps) > span': 'Quadros',
      '.settings .field:has(#opt-audio) > span': 'Som',
    },
  };
  // a Galeria e a versão dela com a parede escura (galeria-noite) arrumam as peças do mesmo jeito
  const GALERIA = {
    tile: { badgeInBar: true, frame: [26, 70] },
    text: { '#my-slot span': 'a compartilhar' },
  };
  const THEMES = [
    { id: 'classico', name: 'Clássico', bar: ['#0e0f13', '#c9cdd8'] },
    {
      id: 'arena', name: 'Arena', bar: ['#0e0f12', '#c8ccd6'],
      place: { '.top-actions': '#dock' },
      tile: { badgeInBar: true },
      text: { '.sidebar h3 .h3-t': 'Escalação', '.lobby-card > .field > span': 'Jogador', '.lobby-head p': '60 fps · direto de PC para PC' },
    },
    { id: 'varanda', name: 'Varanda', bar: ['#dfeee2', '#17362b'], ...VARANDA },
    { id: 'varanda-noite', name: 'Varanda (noite)', bar: ['#10261e', '#e9f5ec'], ...VARANDA },
    {
      id: 'neon', name: 'Neon', bar: ['#0b0a13', '#f4f0ff'],
      place: { '.top-actions': '#dock' },
      tile: { frame: [10, 10] },
      text: { '.lobby-head p': 'FPS', '#my-slot span': 'acende aqui quando você compartilhar' },
    },
    { id: 'galeria', name: 'Galeria', bar: ['#ffffff', '#121212'], ...GALERIA },
    { id: 'galeria-noite', name: 'Galeria (noite)', bar: ['#131312', '#ecebe6'], ...GALERIA },
    {
      id: 'caderno', name: 'Caderno', bar: ['#fdfcf6', '#3d3d3d'],
      place: { '.top-actions': '#stage' },
      tile: { badgeInBar: true, frame: [24, 54] },
      text: {
        '.lobby-head p': 'a tela dos amigos em 60 fps, direto de PC para PC',
        '.lobby-card > .field > span': 'Nome:',
        '.lobby-box .field > span': 'IP ou código:',
      },
    },
    {
      id: 'planta', name: 'Planta', bar: ['#1d4fb0', '#f4f8ff'],
      place: { '.top-actions': '.sidebar' },
      tile: { badgeInBar: true, frame: [30, 62] },
      text: {
        '.people-head span:nth-child(1)': 'Nº',
        '.people-head span:nth-child(2)': 'Nome',
        '.lobby-head p': '60 fps · direto de PC para PC',
        '.lobby-card > .field > span': 'Nome',
        '.lobby-box .field > span': 'IP do Radmin ou código da sala',
        '#my-slot span': 'a compartilhar',
      },
    },
    {
      id: 'terminal', name: 'Terminal', bar: ['#050a07', '#3fdc86'], barH: 36,
      place: { '#btn-options': '#side-opts' },
      tile: { frame: [22, 56] },
      text: {
        '.people-head span:nth-child(1)': '',
        '.people-head span:nth-child(2)': 'nome',
        '.people-head span:nth-child(3)': 'fps',
        '.people-head span:nth-child(4)': 'ping',
        '.lobby-card > .field > span': 'nome >',
        '#chat-input@placeholder': 'mensagem para a sala',
      },
    },
    {
      id: 'sessao', name: 'Sessão', bar: ['#080706', '#b9ad97'], barH: 40,
      place: { '.top-actions': '#stage' },
      tile: { badgeInBar: true, frame: [20, 64] },
      text: {
        '.sidebar h3 .h3-t': 'Plateia',
        '.rooms-head > span:first-child': 'Hoje em cartaz',
        '.lobby-actions .lobby-box:first-child h2': 'Abrir uma sala',
        '.lobby-box .field > span': 'IP do Radmin ou código',
      },
    },
    {
      id: 'fliperama', name: 'Fliperama', bar: ['#15123a', '#f7f5ff'],
      // os botões da sala ficam ao lado da tela; compartilhar (e, no ar, trocar, parar, 2ª tela e ajustes) mora no
      // "lugar da sua tela", na fileira de baixo; a contagem de pessoas sobe para o placar
      place: { '.top-actions': '#stage', '#btn-share': '#my-slot', '#btn-stop': '#my-slot', '#btn-share2': '#my-slot', '#btn-adjust': '#my-slot', '#people-count': '.topbar > .room-info' },
      tile: { badgeInBar: true, frame: [36, 86] },
      text: {
        '.sidebar h3 .h3-t': 'Jogadores',
        '.lobby-head p': 'Compartilhe a tela em 60 fps · de PC para PC',
        '.lobby-card > .field > span': 'Jogador',
        '.lobby-actions .lobby-box:last-child h2': 'Salas abertas',
        '.lobby-box .field > span': 'IP do Radmin ou código da sala',
        '#chat-input@placeholder': 'Mensagem para a sala',
      },
    },
    {
      id: 'tocafitas', name: 'Toca-fitas', bar: ['#efe1c4', '#2b1c13'], barH: 64, barLobby: ['#2b1c13', '#efe1c4'], barLobbyH: 40,
      tile: { badgeInBar: true, frame: [20, 86] },
      text: {
        '.lobby-head p': 'lado A · C-60 · a tela dos amigos em 60 fps',
        '.lobby-card > .field > span': 'nome:',
        '.lobby-box .field > span': 'IP do Radmin ou código da sala',
        '#my-slot span': 'entra aqui quando você compartilhar',
        '#chat-input@placeholder': 'Mensagem para a sala',
      },
    },
    {
      id: 'cyberpunk', name: 'Cyberpunk', bar: ['#07080e', '#c8ff1e'],
      tile: { frame: [12, 12] },
      text: {
        '.sidebar h3 .h3-t': 'Conectados',
        '#chat-input@placeholder': '> mensagem para a sala_',
      },
    },
    {
      id: 'gibi', name: 'Gibi', bar: ['#ffffff', '#141414'],
      tile: { frame: [6, 6] },
      text: {
        '.sidebar h3 .h3-t': 'A turma',
        '#chat-input@placeholder': 'Fala aí...',
      },
    },
    {
      id: 'taverna', name: 'Taverna', bar: ['#2e1d10', '#f0c76a'],
      tile: { frame: [14, 14] },
      text: {
        '.sidebar h3 .h3-t': 'O grupo',
        '#chat-input@placeholder': 'Diga algo ao grupo...',
        '.lobby-head p': 'Reúna o grupo: a tela de cada um em 60 fps, direto de PC para PC.',
      },
    },
    {
      id: 'disquete', name: 'Disquete', bar: ['#c0c0c0', '#000000'],
      tile: { frame: [8, 29] },
      text: {
        '.sidebar h3 .h3-t': 'Usuários conectados',
        '#chat-input@placeholder': 'Digite uma mensagem',
      },
    },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id);
  const stored = () => {
    let id = 'classico';
    try { id = localStorage.getItem('theme') || 'classico'; } catch {}
    return byId(id) ? id : 'classico';
  };
  let current = stored();
  const listeners = [];
  document.documentElement.dataset.theme = current;

  let screen = 'lobby'; // em que tela o app está (o app avisa ao entrar e ao sair de uma sala)
  function tellMain() {
    const t = byId(current);
    const lobby = screen === 'lobby';
    const bar = (lobby && t.barLobby) || t.bar;
    const height = (lobby && t.barLobbyH) || t.barH || 56;
    try { window.native.theme({ id: t.id, color: bar[0], symbol: bar[1], height }); } catch {}
  }

  // ---- peças que mudam de lugar ----
  const homes = new Map();
  function place() {
    const want = byId(current).place || {};
    const known = new Set();
    for (const t of THEMES) for (const sel of Object.keys(t.place || {})) known.add(sel);
    // Primeiro guarda a casa de TODAS as peças, com os irmãos ainda no lugar; só depois move. (A ordem dos irmãos
    // fica guardada porque várias peças podem sair do mesmo lugar e voltar em qualquer ordem. Guardando uma a uma
    // enquanto movia, quem abria o app num tema que tira várias peças do mesmo lugar ficava com a ordem delas
    // errada ao trocar de tema: "Parar" antes de "+ 2ª tela" e "Ajustes".)
    for (const sel of known) {
      const el = document.querySelector(sel);
      if (el && !homes.has(el)) homes.set(el, { parent: el.parentNode, order: [...el.parentNode.children] });
    }
    for (const sel of known) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const dest = want[sel] ? document.querySelector(want[sel]) : null;
      if (dest) {
        if (el.parentNode !== dest) dest.appendChild(el);
      } else {
        const h = homes.get(el);
        if (el.parentNode !== h.parent) {
          let ref = null;
          for (let i = h.order.indexOf(el) + 1; i < h.order.length; i++) {
            if (h.order[i].parentNode === h.parent) { ref = h.order[i]; break; }
          }
          h.parent.insertBefore(el, ref);
        }
      }
    }
    const dock = document.getElementById('dock');
    if (dock) dock.classList.toggle('hidden', !dock.children.length);
  }

  // ---- rótulos com outro nome no tema: guarda o texto de casa e devolve nos outros temas ----
  const texts = new Map();
  const homeText = (el, attr) => {
    let m = texts.get(el);
    if (!m) { m = {}; texts.set(el, m); }
    const k = attr || '';
    if (!(k in m)) m[k] = attr ? (el.getAttribute(attr) || '') : el.textContent;
    return m[k];
  };
  function relabel() {
    const want = byId(current).text || {};
    const known = new Set();
    for (const t of THEMES) for (const key of Object.keys(t.text || {})) known.add(key);
    for (const key of known) {
      const [sel, attr] = key.split('@');
      const el = document.querySelector(sel);
      if (!el) continue;
      const home = homeText(el, attr);
      const txt = want[key] != null ? want[key] : home;
      if (attr) { if (el.getAttribute(attr) !== txt) el.setAttribute(attr, txt); }
      else if (el.textContent !== txt) el.textContent = txt;
    }
  }

  // ---- cada tela (tile): o selo de qualidade pode morar na barra, ao lado do nome ----
  function tileSetup(tile) {
    if (!tile || !tile.el) return;
    const o = byId(current).tile || {};
    if (tile.qbadge) {
      if (o.badgeInBar) { if (tile.qbadge.previousElementSibling !== tile.label) tile.label.after(tile.qbadge); }
      else if (tile.qbadge.parentNode !== tile.el) tile.el.appendChild(tile.qbadge);
    }
  }

  // ---- listas de escolha (select) também como botões lado a lado e como "setinhas" ----
  // O <select> continua sendo a verdade; as duas versões só mostram e mudam o valor dele.
  // Cada tema decide no CSS qual das três aparece.
  function enhance(select) {
    if (select.dataset.enh) return;
    select.dataset.enh = '1';
    const seg = document.createElement('div');
    seg.className = 'enh-seg';
    seg.dataset.for = select.id;
    const step = document.createElement('div');
    step.className = 'enh-step';
    step.dataset.for = select.id;
    const prev = document.createElement('button');
    const next = document.createElement('button');
    const val = document.createElement('span');
    prev.type = next.type = 'button';
    prev.className = 'prev'; next.className = 'next'; val.className = 'val';
    prev.title = 'Anterior'; next.title = 'Próximo';
    step.append(prev, val, next);
    select.after(seg, step);
    const usable = () => [...select.options].filter((o) => !o.disabled && !o.hidden);
    const pick = (v) => {
      if (select.disabled || select.value === v) return;
      select.value = v;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    };
    const move = (d) => {
      const opts = usable();
      const i = opts.findIndex((o) => o.value === select.value);
      if (opts.length) pick(opts[(i + d + opts.length) % opts.length].value);
    };
    function sync() {
      const opts = usable();
      seg.textContent = '';
      for (const o of opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o.dataset.short || o.textContent;
        b.title = o.textContent;
        if (o.value === select.value) b.className = 'on';
        b.onclick = () => pick(o.value);
        seg.appendChild(b);
      }
      seg.style.setProperty('--n', opts.length);
      seg.style.setProperty('--i', Math.max(0, opts.findIndex((o) => o.value === select.value)));
      const sel = select.selectedOptions[0];
      val.textContent = sel ? (sel.dataset.short || sel.textContent) : '';
      seg.classList.toggle('off', select.disabled);
      step.classList.toggle('off', select.disabled);
    }
    prev.onclick = () => move(-1);
    next.onclick = () => move(1);
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label'] });
    select._enhSync = sync;
    sync();
  }
  const syncSelects = () => document.querySelectorAll('select[data-enh]').forEach((s) => s._enhSync());

  // ---- controles deslizantes: a parte "cheia" (--p) para os temas que desenham a trilha ----
  const paint = (el) => {
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 100;
    const f = Math.max(0, Math.min(1, (Number(el.value) - min) / (max - min || 1)));
    el.style.setProperty('--p', `${f * 100}%`);
    // a mesma fração sem unidade, no controle e no pai dele (para os temas que giram um botão ou um ponteiro)
    el.style.setProperty('--f', f.toFixed(4));
    if (el.parentNode && el.parentNode.style) el.parentNode.style.setProperty('--f', f.toFixed(4));
  };
  const paintRanges = () => document.querySelectorAll('input[type=range]').forEach(paint);
  document.addEventListener('input', (e) => { if (e.target && e.target.type === 'range') paint(e.target); }, true);

  // troca o tema na hora (sem animação): a cor da faixa dos botões da janela vai junto, a não ser que bar=false
  function apply(id, bar = true) {
    if (!byId(id) || id === current) return false;
    current = id;
    try { localStorage.setItem('theme', id); } catch {}
    document.documentElement.dataset.theme = id;
    if (bar) tellMain();
    place();
    relabel();
    syncPickers();
    paintRanges();
    for (const cb of listeners) { try { cb(id); } catch (e) { console.warn('tema:', e); } }
    return true;
  }
  const set = (id) => { apply(id); };

  // ---- troca escolhida pela pessoa: o tema novo "se instala" com uma animação no estilo dele ----
  // Usa a transição de tela do Chromium (View Transitions): ela fotografa o visual de antes, troca o tema por baixo
  // e anima a passagem (tema-instala.css diz como, para cada tema). O visual novo fica "ao vivo" durante a animação
  // (as telas dos amigos continuam tocando). Sem animação: com as animações do Windows desligadas, nas cópias abertas
  // pelos testes (a não ser com force) e se o Chromium não tiver o recurso.
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let testing = true; // até o processo principal responder (é rápido): na dúvida, sem animação
  try { window.native.testing().then((t) => { testing = !!t; }, () => { testing = false; }); } catch { testing = false; }
  // o que aparece na plaquinha de "instalando"; o tema mostra só o que quiser (o estilo fica no tema-instala.css)
  const KICKER = {
    classico: 'Instalando', arena: 'Instalando', varanda: 'Montando a', 'varanda-noite': 'Montando a', neon: 'Ligando',
    galeria: 'Nova exposição', 'galeria-noite': 'Nova exposição', caderno: 'virando a página…', planta: 'Folha', terminal: '$ tela-amigos --tema terminal',
    sessao: 'A sessão vai começar', fliperama: 'Loading', tocafitas: 'lado A',
    cyberpunk: '// conectando', gibi: 'Edição especial', taverna: 'Uma nova aventura:', disquete: 'Instalando...',
  };
  const LOG = ['baixando as cores', 'trocando as letras', 'arrumando a sala', 'pronto'];
  let active = null; // transição em andamento
  let seq = 0;
  // quadros da dissolução de pixels (Fliperama): blocos que acendem em ordem sorteada, 24 x 15, em 12 passos
  function pixelFrames() {
    const root = document.documentElement;
    if (root.style.getPropertyValue('--vt-px0')) return;
    const W = 24, H = 15, N = 12, cells = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells.push([x, y]);
    let s = 7; // sorteio sempre igual (a mesma animação toda vez)
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    for (let f = 0; f <= N; f++) {
      const upto = Math.round((cells.length * f) / N);
      let d = '';
      for (let i = 0; i < upto; i++) d += `M${cells[i][0]} ${cells[i][1]}h1v1h-1z`;
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none' shape-rendering='crispEdges'><path d='${d || 'M0 0'}' fill='${d ? '#000' : 'none'}'/></svg>`;
      root.style.setProperty(`--vt-px${f}`, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    }
  }
  function hud(id) {
    const t = byId(id);
    const el = document.getElementById('vt-hud');
    if (!el) return;
    el.querySelector('.vt-k').textContent = KICKER[id] || 'Instalando';
    el.querySelector('.vt-name').textContent = t.name;
    el.querySelectorAll('.vt-log > span').forEach((s, i) => { s.textContent = LOG[i] || ''; });
  }
  async function pick(id, opts = {}) {
    if (!byId(id) || id === current) return;
    const root = document.documentElement;
    const animate = !!document.startViewTransition && !reduceMotion.matches && (!testing || opts.force);
    if (!animate) { apply(id); return; }
    const my = ++seq;
    if (active) { try { active.skipTransition(); } catch {} try { await active.finished; } catch {} }
    if (my !== seq) return; // outra troca pediu a vez enquanto esta esperava
    const from = current;
    if (id === 'fliperama') pixelFrames();
    // de onde a animação parte (o controle que a pessoa usou), para os temas que abrem a partir de um ponto
    const x = opts.x != null ? opts.x : innerWidth / 2, y = opts.y != null ? opts.y : innerHeight / 2;
    root.style.setProperty('--vt-x', `${Math.round(x)}px`);
    root.style.setProperty('--vt-y', `${Math.round(y)}px`);
    root.dataset.vt = id;
    root.dataset.vtFrom = from;
    hud(id);
    const vt = document.startViewTransition(async () => {
      apply(id, false);
      root.classList.add('vt-on');
      // letras do tema novo carregadas antes da foto do visual novo (sem isso o texto sairia invisível)
      void document.body.offsetHeight;
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    });
    active = vt;
    const done = () => {
      if (active !== vt) return;
      active = null;
      root.classList.remove('vt-on', 'vt-run');
      delete root.dataset.vt;
      delete root.dataset.vtFrom;
    };
    vt.ready.then(() => {
      root.classList.add('vt-run');
      // a faixa dos botões da janela (do Windows) muda de cor no meio da animação
      setTimeout(() => { if (current === id) tellMain(); }, 500);
    }, () => { tellMain(); });
    try { await vt.finished; } catch {} finally { done(); if (current === id) tellMain(); }
    return vt;
  }

  // as duas listas de tema (rodapé e Opções) mostram sempre o mesmo valor
  const pickers = () => [document.getElementById('theme-pick'), document.getElementById('opt-theme')].filter(Boolean);
  function syncPickers() { for (const p of pickers()) p.value = current; }
  function ready() {
    for (const p of pickers()) {
      p.textContent = '';
      for (const t of THEMES) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; p.appendChild(o); }
      // a animação parte da lista de tema que a pessoa usou
      p.onchange = () => { const r = p.getBoundingClientRect(); pick(p.value, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); };
    }
    // com um tema só não há o que escolher
    for (const el of document.querySelectorAll('.theme-row')) el.classList.toggle('hidden', THEMES.length < 2);
    syncPickers();
    document.querySelectorAll('select[data-seg]').forEach(enhance);
    // valores postos pelo app ao abrir a janela de compartilhar / os ajustes não disparam "change"
    for (const id of ['share-modal', 'adjust-panel']) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(() => { syncSelects(); paintRanges(); setTimeout(() => { syncSelects(); paintRanges(); }, 300); }).observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    place();
    relabel();
    paintRanges();
    tellMain();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.Themes = {
    list: THEMES,
    get current() { return current; },
    set, // na hora, sem animação (testes, capturas, o app trocando sozinho)
    pick, // escolhida pela pessoa: com a animação de instalação (opts: x, y = de onde parte; force = mesmo nos testes)
    get transition() { return active; }, // a animação em andamento (para as capturas de prévia)
    onChange: (cb) => listeners.push(cb),
    tileSetup,
    // quanto o tema soma à imagem de cada tela: [largura, altura] em px (moldura, legenda fora da imagem...)
    tileFrame: () => (byId(current).tile || {}).frame || [0, 0],
    // o app avisa em que tela está: a faixa dos botões da janela pode mudar de cor entre a entrada e a sala
    screen: (name) => { if (name !== screen) { screen = name; tellMain(); } },
    syncSelects,
    paintRanges,
    paintRange: paint, // um controle só (ex.: o volume de uma tela que acabou de nascer e ainda não está na página)
  };
})();
