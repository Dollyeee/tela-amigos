// Foto de perfil: cada um escolhe uma imagem que aparece no lugar da bolinha com a inicial (lista de pessoas, chat,
// telas, salas da tela de entrada). A foto é reduzida aqui mesmo (160x160, WebP, uns 6 KB) e vai para os amigos pela
// sala (mensagem 'photo' do app.js): uma vez quando a conexão começa e de novo quando muda.
// A minha fica em localStorage 'photo'; as dos amigos ficam lembradas pelo nome ('photos', as 40 mais recentes) para
// aparecerem também na lista de salas da tela de entrada.
// Cada avatar com foto ganha um <i class="av-photo"> por cima da inicial: a bolinha do tema continua lá (forma,
// borda, cor da pessoa) e os temas que desenham o avatar de outro jeito vestem a foto no fliperama.css, terminal.css...
// O <i> leva também --photo-px: a mesma foto em 12x12, para os temas de pixel (image-rendering: pixelated).
// E a linha da pessoa (#people li), a mensagem do chat e o nome da tela ganham --photo: os temas que não mostram a bolinha põem a
// foto em outro lugar do desenho deles (um ::before, o lugar do número...).
window.Foto = (() => {
  const SIZE = 160;
  const MAX = 48000; // o maior texto de foto (data URL) aceito de um amigo; a sala aceita mensagens de até 64 KB
  const OK = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
  const valid = (s) => typeof s === 'string' && s.length <= MAX && OK.test(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} };

  let mine = valid(read('photo')) ? read('photo') : '';
  let myName = () => '';
  const friends = new Map(); // nome -> foto que chegou nesta sessão ('' = o amigo tirou a foto)
  let saved = {};
  try { saved = JSON.parse(read('photos') || '{}') || {}; } catch { saved = {}; }
  const listeners = [];

  function remember(name, src) {
    if (src) saved[name] = { s: src, t: Date.now() }; else delete saved[name];
    const names = Object.keys(saved);
    if (names.length > 40) for (const n of names.sort((a, b) => saved[a].t - saved[b].t).slice(0, names.length - 40)) delete saved[n];
    write('photos', JSON.stringify(saved));
  }
  function of(name) {
    if (!name) return '';
    if (name === myName()) return mine;
    if (friends.has(name)) return friends.get(name);
    const s = saved[name] && saved[name].s;
    return valid(s) ? s : '';
  }

  // a foto em 12x12 (para os temas de pixel); fica pronta logo depois, então quem pede passa o que fazer com ela
  const px = new Map(); // foto -> versão pequena (texto) ou lista de quem está esperando
  function pixel(src, cb) {
    const v = px.get(src);
    if (typeof v === 'string') return v;
    if (v) { v.push(cb); return ''; }
    const waiting = [cb];
    px.set(src, waiting);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, 12, 12);
      const out = c.toDataURL('image/png');
      px.set(src, out);
      if (px.size > 80) px.delete(px.keys().next().value);
      for (const f of waiting) f(out);
    };
    im.onerror = () => px.delete(src);
    im.src = src;
    return '';
  }

  // põe (ou tira) a foto num avatar criado pelo app.js (src: para mostrar uma foto que não é a do nome, ex.: a
  // minha no botão da entrada antes de eu digitar o nome)
  function paint(av, name, src = of(name)) {
    av.dataset.who = name || '';
    let i = av.querySelector(':scope > .av-photo');
    // (a linha da lista ainda pode estar fora da página quando isto roda: vale quem está em volta da bolinha)
    const host = av.parentElement && av.parentElement.matches('li, .chat-msg, .tile-name') ? av.parentElement : null;
    if (!src) {
      if (i) i.remove();
      av.classList.remove('has-photo');
      if (host) host.style.removeProperty('--photo');
      return;
    }
    if (host) host.style.setProperty('--photo', `url("${src}")`);
    if (!i) {
      i = document.createElement('i');
      i.className = 'av-photo';
      i.setAttribute('aria-hidden', 'true');
      av.insertBefore(i, av.querySelector(':scope > .status')); // a bolinha de conexão fica por cima da foto
    }
    if (i.dataset.src !== src) {
      i.dataset.src = src;
      i.style.backgroundImage = `url("${src}")`;
      const small = pixel(src, (out) => { if (i.dataset.src === src) i.style.setProperty('--photo-px', `url("${out}")`); });
      if (small) i.style.setProperty('--photo-px', `url("${small}")`);
    }
    av.classList.add('has-photo');
  }
  function refresh(name) {
    for (const av of document.querySelectorAll('.avatar')) if (av.dataset.who === name) paint(av, name);
  }

  // uma imagem qualquer do PC -> quadrado de 160x160 em WebP (corta o meio; em foto em pé, um pouco mais para cima,
  // onde costuma estar o rosto)
  async function fromFile(file) {
    if (!file || !/^image\//.test(file.type || '')) throw new Error('Escolha uma imagem (JPG, PNG, WebP ou GIF).');
    if (file.size > 40 * 1024 * 1024) throw new Error('Essa imagem é grande demais.');
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error('Não consegui abrir essa imagem.'); }
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) * 0.35, s, s, 0, 0, SIZE, SIZE);
    bmp.close();
    for (const q of [0.86, 0.75, 0.6, 0.45]) {
      const out = c.toDataURL('image/webp', q);
      if (out.length <= 40000 && valid(out)) return out;
    }
    throw new Error('Não consegui reduzir essa imagem.');
  }
  // abre a janela do Windows para escolher a imagem (null se a pessoa cancelar)
  function pick() {
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
      inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) resolve(null); else fromFile(f).then(resolve, reject); };
      inp.oncancel = () => resolve(null);
      inp.click();
    });
  }

  function setMine(src) {
    const v = valid(src) ? src : '';
    if (v === mine) return false;
    mine = v;
    write('photo', mine);
    refresh(myName());
    for (const f of listeners) { try { f(mine); } catch (e) { console.warn('foto:', e); } }
    return true;
  }
  // chegou a foto de um amigo ('' = ele tirou a foto; outra coisa qualquer é ignorada). Devolve se mudou alguma coisa
  function setFriend(name, src) {
    if (!name || name === myName() || (src !== '' && !valid(src))) return false;
    const v = src;
    const before = of(name);
    friends.set(name, v);
    if (((saved[name] && saved[name].s) || '') !== v) remember(name, v);
    if (before === v) return false;
    refresh(name);
    return true;
  }

  return {
    of, paint, refresh, pick, fromFile, valid, setMine, setFriend, pixel,
    mine: () => mine,
    bindName: (fn) => { myName = fn; },
    onChange: (fn) => listeners.push(fn),
  };
})();
