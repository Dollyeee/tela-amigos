// "Escolher tema": a janela com a miniatura de cada tema (a mesma galeria que as Novidades mostram).
// Os temas com duas versões (ex.: "varanda" e "varanda-noite") ficam num cartão só, com "dia | noite" no canto da
// miniatura: são 15 cartões, 3 linhas de 5. Clicar troca na hora (com a animação de instalação do tema) e a janela
// fica aberta para experimentar outro; "Pronto", Esc ou clique fora fecham.
// O <select> de tema (rodapé da entrada e Opções) continua mostrando o tema em uso (cada tema já o veste), mas
// clicar nele (ou Enter/espaço/setas) abre esta janela em vez da lista.
window.ThemePicker = (() => {
  const T = () => window.Themes;
  const modal = () => document.getElementById('theme-modal');
  const body = () => document.getElementById('theme-body');
  // uma versão do tema com as mesmas peças: "varanda-noite" é do grupo "varanda" (como no fx.js)
  const base = (id) => String(id || '').split('-')[0];
  // "Varanda (noite)" -> "noite"; sem parênteses: "dia"
  const variantLabel = (t) => { const m = /\(([^)]+)\)\s*$/.exec(t.name); return m ? m[1] : 'dia'; };
  const groupName = (g) => g.items[0].name.replace(/\s*\([^)]*\)\s*$/, '');

  function groups() {
    const out = [];
    for (const t of T().list) {
      const b = base(t.id);
      let g = out.find((x) => x.base === b);
      if (!g) out.push((g = { base: b, items: [] }));
      g.items.push(t);
    }
    return out;
  }

  // o tema se instala com a animação dele, partindo do cartão clicado
  function pick(card, id) {
    const r = card.getBoundingClientRect();
    T().pick(id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  function gallery() {
    const box = document.createElement('div');
    box.className = 'news-themes';
    for (const g of groups()) {
      // (não é <button>: cada tema veste os botões do seu jeito, e aqui o desenho é o da miniatura)
      const card = document.createElement('div');
      card.className = 'news-theme';
      card.dataset.group = g.base;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.onerror = () => { img.style.visibility = 'hidden'; }; // tema sem miniatura: fica só o nome
      const name = document.createElement('span');
      name.className = 'nt-name';
      const label = document.createElement('span');
      label.className = 'nt-label';
      label.textContent = groupName(g);
      const on = document.createElement('i');
      on.className = 'nt-on';
      on.textContent = 'em uso';
      name.append(label, on);
      card.append(img, name);
      let vars = null;
      // mostra uma versão do grupo (miniatura, dica e qual fica marcada em "dia | noite")
      const show = (id) => {
        const t = g.items.find((x) => x.id === id) || g.items[0];
        card.dataset.id = t.id;
        card.title = `Usar o tema ${t.name}`;
        const src = `news/tema-${t.id}.jpg`;
        if (img.getAttribute('src') !== src) { img.style.visibility = ''; img.src = src; }
        if (vars) vars.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('sel', b.dataset.v === t.id));
      };
      if (g.items.length > 1) {
        vars = document.createElement('span');
        vars.className = 'nt-vars';
        for (const t of g.items) {
          const b = document.createElement('b');
          b.dataset.v = t.id;
          b.textContent = variantLabel(t);
          b.title = `Usar o tema ${t.name}`;
          b.onmouseenter = () => show(t.id);
          b.onclick = (e) => { e.stopPropagation(); show(t.id); pick(card, t.id); };
          vars.appendChild(b);
        }
        card.appendChild(vars);
        // saiu do cartão sem escolher: volta a mostrar a versão em uso (ou a de dia)
        card.onmouseleave = () => show(g.items.some((x) => x.id === T().current) ? T().current : g.items[0].id);
      }
      card.onclick = () => pick(card, card.dataset.id);
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(card, card.dataset.id); } };
      card.show = show;
      show(g.items.some((x) => x.id === T().current) ? T().current : g.items[0].id);
      box.appendChild(card);
    }
    return box;
  }

  // marca o cartão do tema em uso (e a versão dele) em qualquer galeria aberta
  function mark(root = document) {
    if (!T()) return;
    const cur = T().current;
    root.querySelectorAll('.news-theme').forEach((c) => {
      const on = c.dataset.group === base(cur);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && c.show) c.show(cur);
    });
  }

  const isOpen = () => { const m = modal(); return !!m && !m.classList.contains('hidden'); };
  function open() {
    const m = modal(), b = body();
    if (!m || !b || !T()) return;
    b.textContent = '';
    b.appendChild(gallery());
    mark(b);
    m.classList.remove('hidden');
    const cur = b.querySelector('.news-theme.on') || b.querySelector('.news-theme');
    if (cur) cur.focus({ preventScroll: true });
  }
  function close() {
    const m = modal();
    if (m) m.classList.add('hidden');
  }

  function init() {
    const m = modal();
    if (!m) return;
    const ok = document.getElementById('theme-ok');
    if (ok) ok.onclick = close;
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    if (T()) T().onChange(() => mark());
    // o <select> de tema abre a janela em vez da lista
    for (const sel of [document.getElementById('theme-pick'), document.getElementById('opt-theme')]) {
      if (!sel) continue;
      sel.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); sel.focus({ preventScroll: true }); open(); });
      sel.addEventListener('keydown', (e) => {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) { e.preventDefault(); open(); }
      });
    }
  }

  return { init, open, close, isOpen, gallery, groups, mark };
})();
