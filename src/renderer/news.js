// Novidades: a tela que conta o que mudou em cada versão (os textos ficam em changelog.js).
// - Abre sozinha UMA vez depois de cada atualização: o app guarda a última versão cujas novidades a pessoa já
//   fechou e, ao abrir, mostra só as entradas mais novas que ela.
// - Instalação nova não abre nada: para quem acabou de chegar não há "o que mudou".
// - Fica sempre à mão em "Novidades", no rodapé da tela de entrada (aí mostra todas as versões).
(() => {
  const KEY = 'newsSeen'; // última versão cujas novidades a pessoa já fechou
  const LOG = window.CHANGELOG || [];
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const modal = () => document.getElementById('news-modal');
  const body = () => document.getElementById('news-body');

  // compara "1.0.9" com "1.0.10" pelos números, não pelas letras
  const cmp = (a, b) => {
    const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  };

  // O que mostrar ao abrir o app.
  //   seen: a última versão vista (vazio = este PC nunca fechou a tela de novidades)
  //   known: a pessoa já usava o app antes (tem nome guardado); sem isso é instalação nova
  function pending(log, seen, current, known) {
    const have = log.filter((e) => cmp(e.v, current) <= 0); // nunca a novidade de uma versão mais nova que o app
    if (!seen) return known ? have : [];
    return have.filter((e) => cmp(e.v, seen) > 0);
  }

  // texto simples; "**assim**" vira negrito
  function fill(el, str) {
    String(str).split('**').forEach((part, i) => {
      if (!part) return;
      if (i % 2) { const b = document.createElement('b'); b.textContent = part; el.appendChild(b); }
      else el.appendChild(document.createTextNode(part));
    });
    return el;
  }
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) fill(el, text);
    return el;
  };

  // galeria de temas: a miniatura de cada um (news/tema-<id>.jpg); clicar troca o tema na hora
  function gallery() {
    const T = window.Themes;
    const box = make('div', 'news-themes');
    for (const t of T.list) {
      // (não é <button>: cada tema veste os botões do seu jeito, e aqui o desenho é o da miniatura)
      const card = make('div', 'news-theme');
      card.dataset.id = t.id;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.title = `Usar o tema ${t.name}`;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.onerror = () => img.remove(); // tema sem miniatura: fica só o nome
      img.src = `news/tema-${t.id}.jpg`;
      const name = make('span', 'nt-name');
      const label = make('span', 'nt-label');
      label.textContent = t.name;
      name.append(label, make('i', 'nt-on', 'em uso'));
      card.append(img, name);
      const pick = () => T.set(t.id);
      card.onclick = pick;
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      box.appendChild(card);
    }
    return box;
  }
  function markTheme() {
    const b = body();
    if (!b || !window.Themes) return;
    const cur = window.Themes.current;
    b.querySelectorAll('.news-theme').forEach((c) => {
      const on = c.dataset.id === cur;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function entry(e) {
    const s = make('section', 'news-entry');
    s.appendChild(make('p', 'news-kicker', `Versão ${e.v}`));
    s.appendChild(make('h3', 'news-title', e.title));
    if (e.text) s.appendChild(make('p', 'news-text', e.text));
    if (e.themes && window.Themes && window.Themes.list.length > 1) s.appendChild(gallery());
    if (e.items && e.items.length) {
      const ul = make('ul', 'news-list');
      for (const it of e.items) ul.appendChild(make('li', '', it));
      s.appendChild(ul);
    }
    return s;
  }

  let version = '';        // versão do app (o init pergunta ao processo principal)
  let markOnClose = false; // aberta sozinha depois de atualizar: ao fechar, fica como vista
  const isOpen = () => { const m = modal(); return !!m && !m.classList.contains('hidden'); };

  // list: as entradas a mostrar (sem nada: todas). auto: aberta sozinha depois de uma atualização
  function open({ list = LOG, auto = false } = {}) {
    const m = modal();
    const b = body();
    if (!m || !b) return;
    b.textContent = '';
    if (!list.length) b.appendChild(make('p', 'news-text', 'Nenhuma novidade registrada ainda.'));
    for (const e of list) b.appendChild(entry(e));
    markTheme();
    markOnClose = auto;
    m.classList.remove('hidden');
    b.scrollTop = 0;
    const ok = document.getElementById('news-ok');
    if (ok) ok.focus({ preventScroll: true }); // Enter fecha
  }
  function close() {
    if (!isOpen()) return;
    modal().classList.add('hidden');
    if (markOnClose && version) write(KEY, version);
    markOnClose = false;
  }

  // Ao abrir o app: mostra o que há de novo desde a última vez (ou só anota a versão, se não há nada a mostrar).
  // Devolve as entradas mostradas.
  function check({ known, current = version } = {}) {
    version = current;
    if (!version) return [];
    const seen = read(KEY);
    const list = pending(LOG, seen, version, known);
    if (list.length) open({ list, auto: true });
    else if (seen !== version) write(KEY, version);
    return list;
  }

  async function init() {
    const m = modal();
    if (!m) return;
    const known = !!read('name'); // lido antes de qualquer espera: quem nunca entrou numa sala é instalação nova
    const ok = document.getElementById('news-ok');
    if (ok) ok.onclick = close;
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    const link = document.getElementById('btn-news');
    if (link) link.onclick = () => open();
    if (window.Themes) window.Themes.onChange(markTheme);
    let testing = false;
    try {
      [version, testing] = await Promise.all([window.native.appVersion(), window.native.testing()]);
    } catch (e) { console.warn('novidades:', e && e.message); return; }
    // cópia aberta por um script de teste: nada de abrir sozinha por cima do que o teste confere
    if (!testing) check({ known });
  }

  window.News = { init, open, close, isOpen, check, pending, cmp, KEY };
})();
