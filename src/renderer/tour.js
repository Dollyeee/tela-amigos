// Tour da primeira vez: balõezinhos que mostram onde ficam as coisas, um de cada vez, com o resto da tela escurecido.
// Aparece sozinho uma vez na tela de entrada e uma vez na primeira sala, só em instalação nova (quem já usava o app
// antes não vê sozinho). Para rever: "Como usar", no rodapé da tela de entrada, e "Tour do app", nas Opções da sala.
// Cada passo procura o primeiro alvo visível da lista (os temas mudam peças de lugar e escondem outras); passo sem
// alvo visível é pulado. As cores vêm do tema (as var(--j-...) do tema-janelas.css, as mesmas das janelas pequenas).
window.Tour = (() => {
  const KEY = 'tour';
  const STEPS = {
    entrada: [
      { at: ['.lobby-card > .field'], title: 'Seu nome e sua foto', text: 'É assim que os amigos te veem. Clique na bolinha para escolher uma foto de perfil.' },
      { at: ['#btn-host'], title: 'Hospedar uma sala', text: 'Seu PC vira a sala. Quem está na mesma rede do Radmin VPN vê a sala aparecer na lista e entra com um clique.' },
      { at: ['#btn-host-online'], title: 'Sem Radmin?', text: 'Crie uma sala online: ela ganha um código de 6 letras para você mandar aos amigos.' },
      { at: ['#rooms', '#host-ip'], title: 'Entrar numa sala', text: 'As salas abertas aparecem aqui. Para entrar numa sala online, digite o código no campo de baixo e clique em Entrar.' },
      { at: ['#theme-pick'], title: 'Tema e tamanho', text: 'Clique para mudar a cara do app. O tamanho da interface fica na mesma janela. Vale só no seu PC: cada amigo escolhe o dele.' },
    ],
    sala: [
      { at: ['#btn-share'], title: 'Compartilhar tela', text: 'Escolha uma tela ou uma janela. Os amigos começam a ver na hora, com o som do PC (o do Discord fica de fora).' },
      { at: ['#stage'], title: 'As telas', text: 'Duplo clique numa tela foca nela. Com o mouse em cima aparecem os botões: caneta, emotes, clipe e volume. Segure o botão direito para apontar com a mãozinha.' },
      { at: ['#chat-input'], title: 'Chat', text: 'Mensagens para todo mundo da sala.' },
      { at: ['#btn-options', '#side-opts > summary'], title: 'Opções', text: 'Foto de perfil, tamanho da interface, sons e mais. Para ver este tour de novo: Opções → Tour do app.' },
    ],
  };
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const mark = (part) => { const s = read(); s[part] = 1; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const seen = (part) => !!read()[part];

  let root = null, spot = null, tip = null, steps = [], at = 0, part = '', target = null, done = null;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  };
  const find = (step) => {
    for (const sel of step.at) { const el = document.querySelector(sel); if (visible(el)) return el; }
    return null;
  };

  function build() {
    root = document.createElement('div');
    root.id = 'tour';
    root.className = 'tour';
    spot = document.createElement('div');
    spot.className = 'tour-spot';
    tip = document.createElement('div');
    tip.className = 'tour-tip';
    tip.setAttribute('role', 'dialog');
    tip.innerHTML = '<b class="tour-title"></b><p class="tour-text"></p>'
      + '<div class="tour-foot"><span class="tour-count"></span><button type="button" class="ghost tour-skip">Pular</button>'
      + '<button type="button" class="ghost tour-back">Voltar</button><button type="button" class="primary tour-next">Próximo</button></div>';
    root.append(spot, tip);
    tip.querySelector('.tour-skip').onclick = () => stop();
    tip.querySelector('.tour-back').onclick = () => go(at - 1, -1);
    tip.querySelector('.tour-next').onclick = () => go(at + 1, 1);
    // clique fora do balão não faz nada (nem chega no app): o tour só anda pelos botões
    root.addEventListener('mousedown', (e) => { if (!tip.contains(e.target)) e.preventDefault(); });
    document.body.appendChild(root);
  }

  // põe o destaque em volta do alvo e o balão do lado que tiver mais espaço
  function place() {
    if (!root || !target) return;
    const r = target.getBoundingClientRect();
    const pad = 6, gap = 12, m = 12;
    const box = { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad), r: Math.min(innerWidth - 4, r.right + pad), b: Math.min(innerHeight - 4, r.bottom + pad) };
    Object.assign(spot.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const room = { below: innerHeight - box.b, above: box.t, right: innerWidth - box.r, left: box.l };
    let x, y;
    if (room.below >= h + gap + m || (room.below >= room.above && room.below >= h + gap)) { y = box.b + gap; x = box.l + (box.r - box.l) / 2 - w / 2; }
    else if (room.above >= h + gap + m) { y = box.t - gap - h; x = box.l + (box.r - box.l) / 2 - w / 2; }
    else if (room.right >= w + gap + m) { x = box.r + gap; y = box.t + (box.b - box.t) / 2 - h / 2; }
    else if (room.left >= w + gap + m) { x = box.l - gap - w; y = box.t + (box.b - box.t) / 2 - h / 2; }
    else { x = innerWidth / 2 - w / 2; y = innerHeight - h - m; } // alvo do tamanho da tela (ex.: as telas): balão embaixo, por cima dele
    tip.style.left = `${Math.round(Math.max(m, Math.min(innerWidth - w - m, x)))}px`;
    tip.style.top = `${Math.round(Math.max(m, Math.min(innerHeight - h - m, y)))}px`;
  }

  function go(i, dir) {
    // pula os passos cujo alvo não aparece neste tema / nesta hora
    while (i >= 0 && i < steps.length && !find(steps[i])) i += dir || 1;
    if (i < 0) return;
    if (i >= steps.length) { stop(); return; }
    at = i;
    target = find(steps[i]);
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const shown = steps.filter((s) => find(s));
    const n = shown.indexOf(steps[i]) + 1;
    tip.querySelector('.tour-title').textContent = steps[i].title;
    tip.querySelector('.tour-text').textContent = steps[i].text;
    tip.querySelector('.tour-count').textContent = `${n} de ${shown.length}`;
    tip.querySelector('.tour-back').classList.toggle('hidden', n <= 1);
    tip.querySelector('.tour-skip').classList.toggle('hidden', n >= shown.length); // no último, "Entendi" já fecha
    tip.querySelector('.tour-next').textContent = n >= shown.length ? 'Entendi' : 'Próximo';
    place();
    tip.querySelector('.tour-next').focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stop(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); go(at + 1, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); go(at - 1, -1); }
    else if (e.key === 'Tab') { // o foco anda só entre os botões do balão
      e.preventDefault(); e.stopImmediatePropagation();
      const bs = [...tip.querySelectorAll('button:not(.hidden)')];
      const k = bs.indexOf(document.activeElement);
      bs[(k + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
    } else if (tip.contains(e.target) && (e.key === 'Enter' || e.key === ' ')) e.stopImmediatePropagation(); // o botão age; o app não vê a tecla
    else { e.preventDefault(); e.stopImmediatePropagation(); } // as teclas da sala (G, F, S...) esperam o tour acabar
  }
  const onResize = () => place();

  // começa o tour de uma parte ('entrada' ou 'sala'); devolve uma promessa que resolve quando ele fecha
  function start(which) {
    if (!STEPS[which]) return Promise.resolve();
    if (root) stop();
    part = which;
    steps = STEPS[which];
    build();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    mark(which);
    const p = new Promise((r) => { done = r; });
    go(0, 1);
    if (!target) stop(); // nada para mostrar
    return p;
  }
  function stop() {
    if (!root) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.remove();
    root = spot = tip = target = null;
    const d = done; done = null;
    if (d) d(part);
  }

  // sozinho, só uma vez e só em instalação nova (newUser: ainda não havia nome guardado quando o app abriu)
  function auto(which, newUser) {
    if (!newUser) { mark('entrada'); mark('sala'); return false; }
    if (seen(which) || root) return false;
    start(which);
    return true;
  }

  return { start, stop, auto, seen, isOpen: () => !!root, steps: STEPS, current: () => (root ? { part, at, target } : null) };
})();
