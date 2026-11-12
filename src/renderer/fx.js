// O que os amigos põem em cima das telas tem um desenho por tema: os emotes, a mãozinha que aponta ("dedo")
// e o risco da caneta e do rastro. Este arquivo serve à janela principal e às janelas que ficam por cima do
// monitor de quem transmite (pointer.html e hand.html), por isso não depende do app.js nem do themes.js.
//
// O que viaja entre os amigos não muda (o emoji, a posição, os traços): cada um desenha do jeito do tema
// que escolheu. No visual clássico nada daqui é usado (emoji do Windows, mãozinha e risco de sempre).
(() => {
  // os seis emotes do app, pelo que significam
  const KIND = { '😂': 'laugh', '🔥': 'fire', '👍': 'like', '😮': 'wow', '💀': 'skull', '❤️': 'heart', '❤': 'heart' };

  // formas básicas numa área de 64 x 64
  const D = {
    circle: 'M32 6a26 26 0 1 0 0 52a26 26 0 1 0 0-52z',
    oct: 'M21 6h22l15 15v22l-15 15h-22l-15-15v-22z',
    eyeL: 'M17 28q5.5-8 11 0', eyeR: 'M36 28q5.5-8 11 0',            // olhos fechados de quem ri
    grin: 'M17 35h30a15 15 0 0 1-30 0z',
    tearL: 'M9 30q-5 8-1 12q5-3 1-12z', tearR: 'M55 30q5 8 1 12q-5-3-1-12z',
    browL: 'M17 17q6-5 12-2', browR: 'M35 15q6-3 12 2',
    oh: 'M32 35a6.5 8.5 0 1 0 0 17a6.5 8.5 0 1 0 0-17z',
    flame: 'M33 4c2 12 17 18 17 34a18 18 0 0 1-36 0c0-8 4-13 8-18c1 5 3 8 6 9c-2-9 0-17 5-25z',
    flameIn: 'M32 31c5 6 8 9 8 14a8 8 0 0 1-16 0c0-5 4-8 8-14z',
    cuff: 'M8 29h11v25h-11z',
    thumb: 'M22 29l8-17c2-4 8-3 8 2v10h12c4 0 6 3 5 6l-3 18c-1 4-3 6-7 6h-23z',
    skull: 'M32 6c-13 0-22 9-22 21c0 7 3 12 8 15v8c0 2 2 4 4 4h20c2 0 4-2 4-4v-8c5-3 8-8 8-15c0-12-9-21-22-21z',
    sockL: 'M17 28a6 6 0 1 0 12 0a6 6 0 1 0-12 0z', sockR: 'M35 28a6 6 0 1 0 12 0a6 6 0 1 0-12 0z',
    sockLq: 'M16 23h12l-2 10h-10z', sockRq: 'M36 23h12v10h-10z',     // órbitas de canto reto
    nose: 'M32 35l-3 6h6z',
    teeth: 'M26 46v8M32 46v8M38 46v8',
    heart: 'M32 56C12 42 6 30 6 21a13 13 0 0 1 26-5a13 13 0 0 1 26 5c0 9-6 21-26 35z',
    shine: 'M15 20a7 7 0 0 1 7-7',
  };
  const svg = (theme, body) => `<svg class="fx-emo fx-emo-${theme}" viewBox="-5 -5 74 74" aria-hidden="true">${body}</svg>`;

  // ---- Arena: adesivo de transmissão. Cores chapadas, contorno preto grosso, cantos retos, tudo inclinado.
  const arena = (k) => {
    const ink = '#0e0f12', red = '#ff3347', yl = '#ffe14d', wh = '#f3f4f6';
    const o = `stroke="${ink}" stroke-width="4" stroke-linejoin="miter"`;
    const line = (d, w = 4) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="square"/>`;
    const tear = (d) => `<path d="${d}" fill="#39b8ff" stroke="${ink}" stroke-width="2.5" stroke-linejoin="miter"/>`;
    const body = {
      laugh: `<path d="${D.oct}" fill="${yl}" ${o}/>${line(D.eyeL)}${line(D.eyeR)}<path d="${D.grin}" fill="${ink}"/><path d="M20 35h24v5h-24z" fill="${wh}"/>${tear(D.tearL)}${tear(D.tearR)}`,
      fire: `<path d="${D.flame}" fill="${red}" ${o}/><path d="${D.flameIn}" fill="${yl}" stroke="${ink}" stroke-width="3" stroke-linejoin="miter"/>`,
      like: `<path d="${D.cuff}" fill="${red}" ${o}/><path d="${D.thumb}" fill="${wh}" ${o}/>`,
      wow: `<path d="${D.oct}" fill="${yl}" ${o}/><circle cx="23" cy="27" r="4" fill="${ink}"/><circle cx="41" cy="27" r="4" fill="${ink}"/>${line(D.browL)}${line(D.browR)}<path d="${D.oh}" fill="${ink}"/>`,
      skull: `<path d="${D.skull}" fill="${wh}" ${o}/><path d="${D.sockLq}" fill="${ink}"/><path d="${D.sockRq}" fill="${ink}"/><path d="${D.nose}" fill="${ink}"/>${line(D.teeth, 3)}`,
      heart: `<path d="${D.heart}" fill="${red}" ${o}/><path d="${D.shine}" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="square"/>`,
    }[k];
    return svg('arena', `<g transform="translate(4 0) skewX(-7)">${body}</g>`);
  };

  // ---- Varanda: adesivo fofo. Cores de fruta, borda branca grossa, bochecha rosada.
  const varanda = (k) => {
    const ink = '#17362b', coral = '#ff6a55', butter = '#ffd166', leaf = '#2f9e6e', sky = '#8fd0f0', cream = '#fbfdf9', blush = '#ff9d8c';
    const st = (w = 7) => `stroke="#fff" stroke-width="${w}" stroke-linejoin="round" paint-order="stroke"`;
    const line = (d, w = 3.5) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const cheeks = `<circle cx="14" cy="39" r="4.5" fill="${blush}" opacity=".8"/><circle cx="50" cy="39" r="4.5" fill="${blush}" opacity=".8"/>`;
    const body = {
      laugh: `<path d="${D.circle}" fill="${butter}" ${st()}/>${cheeks}${line(D.eyeL)}${line(D.eyeR)}<path d="${D.grin}" fill="${ink}"/><path d="M24 46q8-6 16 0q-3 4-8 4t-8-4z" fill="${coral}"/><path d="${D.tearL}" fill="${sky}" ${st(4)}/><path d="${D.tearR}" fill="${sky}" ${st(4)}/>`,
      fire: `<path d="${D.flame}" fill="${coral}" ${st()}/><path d="${D.flameIn}" fill="${butter}"/>`,
      like: `<path d="${D.cuff}" fill="${leaf}" ${st()}/><path d="${D.thumb}" fill="${butter}" ${st()}/>`,
      wow: `<path d="${D.circle}" fill="${butter}" ${st()}/>${cheeks}<circle cx="23" cy="27" r="3.6" fill="${ink}"/><circle cx="41" cy="27" r="3.6" fill="${ink}"/>${line(D.browL, 3)}${line(D.browR, 3)}<path d="${D.oh}" fill="${ink}"/>`,
      skull: `<path d="${D.skull}" fill="${cream}" ${st()}/><path d="${D.skull}" fill="none" stroke="#b9cfc0" stroke-width="2"/><path d="${D.sockL}" fill="${ink}"/><path d="${D.sockR}" fill="${ink}"/><path d="${D.nose}" fill="${ink}"/>${line(D.teeth, 2.6)}`,
      heart: `<path d="${D.heart}" fill="${coral}" ${st()}/><path d="${D.shine}" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>`,
    }[k];
    return svg('varanda', body);
  };

  // ---- Neon: letreiro. Só o contorno, em tubo de luz, cada emote numa cor.
  const neon = (k) => {
    const pk = ['#ffd9ee', '#ff3ea5'], cy = ['#d9fdff', '#29e7ee'], yl = ['#fff8cf', '#ffe14a'], wh = ['#f4f0ff', '#a996ff'];
    const tube = (d, [c, g], w = 3) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 2px ${g}) drop-shadow(0 0 5px ${g})"/>`;
    const dot = (cx, cyy, col) => tube(`M${cx - 2.6} ${cyy}a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0z`, col, 2.6);
    const body = {
      laugh: tube(D.circle, yl) + tube(D.eyeL, yl) + tube(D.eyeR, yl) + tube(D.grin, pk) + tube(D.tearL, cy, 2.4) + tube(D.tearR, cy, 2.4),
      fire: tube(D.flame, pk) + tube(D.flameIn, yl),
      like: tube(D.cuff, cy) + tube(D.thumb, cy),
      wow: tube(D.circle, yl) + dot(23, 27, cy) + dot(41, 27, cy) + tube(D.oh, pk),
      skull: tube(D.skull, wh) + tube(D.sockL, cy, 2.6) + tube(D.sockR, cy, 2.6) + tube(D.teeth, wh, 2.4),
      heart: tube(D.heart, pk),
    }[k];
    return svg('neon', body);
  };

  // ---- Galeria: etiqueta de museu. Disco branco, traço fino a nanquim, vermelho só onde importa.
  const galeria = (k) => {
    const ink = '#121212', red = '#d42a20';
    const line = (d, w = 2.6, c = ink) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const disc = `<circle cx="32" cy="32" r="31" fill="#fff" stroke="${ink}" stroke-width="1.5"/>`;
    const small = (body) => `<g transform="translate(32 33) scale(.6) translate(-32 -32)">${body}</g>`;
    const body = {
      // nos rostos o próprio disco é o rosto
      laugh: line(D.eyeL) + line(D.eyeR) + line(D.grin),
      wow: `<circle cx="23" cy="27" r="3.2" fill="${ink}"/><circle cx="41" cy="27" r="3.2" fill="${ink}"/>` + line(D.browL, 2.2) + line(D.browR, 2.2) + line(D.oh),
      fire: small(line(D.flame, 4, red) + line(D.flameIn, 3.4, red)),
      like: small(line(D.cuff, 4) + line(D.thumb, 4)),
      skull: small(line(D.skull, 4) + `<path d="${D.sockL}" fill="${ink}"/><path d="${D.sockR}" fill="${ink}"/>` + line(D.teeth, 3.4)),
      heart: small(`<path d="${D.heart}" fill="${red}"/>`),
    }[k];
    return svg('galeria', disc + body);
  };

  // ---- Caderno: bilhetinhos. Cada emote é um rabisco de caneta num bilhete amarelo, um pouco torto.
  const caderno = (k) => {
    const ink = '#20379c', red = '#e23b3b', pencil = '#3d3d3d';
    const pen = (d, c = ink, w = 3.2) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const note = '<g transform="rotate(-4 32 32)"><rect x="1" y="1" width="62" height="62" fill="#fff3a1"/><path d="M2 63h61V2" fill="none" stroke="#000" stroke-opacity=".14" stroke-width="2"/></g>';
    const body = {
      laugh: pen(D.circle) + pen(D.eyeL) + pen(D.eyeR) + pen(D.grin),
      fire: pen(D.flame, red) + pen(D.flameIn, red, 2.8),
      like: pen(D.cuff) + pen(D.thumb),
      wow: pen(D.circle) + `<circle cx="23" cy="27" r="3.2" fill="${ink}"/><circle cx="41" cy="27" r="3.2" fill="${ink}"/>` + pen(D.oh),
      skull: pen(D.skull, pencil) + pen(D.sockL, pencil, 2.8) + pen(D.sockR, pencil, 2.8) + pen(D.teeth, pencil, 2.8),
      heart: `<path d="${D.heart}" fill="${red}" fill-opacity=".25" stroke="${red}" stroke-width="3.4" stroke-linejoin="round"/>`,
    }[k];
    return svg('caderno', `${note}<g transform="rotate(-4 32 32) translate(32 33) scale(.72) translate(-32 -32)">${body}</g>`);
  };

  // ---- Planta: balão de desenho técnico. Círculo com marcas de centro, traço branco, amarelo e salmão nos destaques.
  const planta = (k) => {
    const wh = '#f4f8ff', yl = '#ffe066', red = '#ffa093';
    const line = (d, c = wh, w = 2.8) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const bal = `<circle cx="32" cy="32" r="30.5" fill="#18439a" stroke="${wh}" stroke-width="1.8"/><path d="M32-4v8M32 60v8M-4 32h8M60 32h8" fill="none" stroke="${wh}" stroke-width="1.3"/>`;
    const small = (b) => `<g transform="translate(32 33) scale(.6) translate(-32 -32)">${b}</g>`;
    const body = {
      laugh: line(D.eyeL) + line(D.eyeR) + line(D.grin),
      wow: `<circle cx="23" cy="27" r="3.2" fill="${wh}"/><circle cx="41" cy="27" r="3.2" fill="${wh}"/>` + line(D.browL, wh, 2.2) + line(D.browR, wh, 2.2) + line(D.oh),
      fire: small(line(D.flame, yl, 4.4) + line(D.flameIn, yl, 3.6)),
      like: small(line(D.cuff, wh, 4.4) + line(D.thumb, wh, 4.4)),
      skull: small(line(D.skull, wh, 4.4) + line(D.sockL, wh, 3.6) + line(D.sockR, wh, 3.6) + line(D.teeth, wh, 3.6)),
      heart: small(line(D.heart, red, 4.8)),
    }[k];
    return svg('planta', bal + body);
  };

  // ---- Terminal: etiquetas de texto, como as do tema (BOM, AO VIVO). Risada "kkkk", fogo, +1, :O, x_x e <3.
  const terminal = (k) => {
    const [txt, bg, fg, line] = {
      laugh: ['kkkk', '#3fdc86', '#03140a', '#03140a'], fire: ['FOGO', '#ffc04a', '#201400', '#201400'], like: ['+1', '#3fdc86', '#03140a', '#03140a'],
      wow: [':O', '#3fdc86', '#03140a', '#03140a'], skull: ['x_x', '#050a07', '#a8ffcb', '#a8ffcb'], heart: ['<3', '#ff6258', '#1c0402', '#1c0402'],
    }[k];
    const w = txt.length * 18 + 20;
    return `<svg class="fx-emo fx-emo-terminal" viewBox="0 0 96 44" aria-hidden="true"><rect x="${(96 - w) / 2}" y="3" width="${w}" height="38" fill="${bg}" stroke="${line}" stroke-width="2"/>`
      + `<text x="48" y="33" text-anchor="middle" font-family="JetBrains Mono, Consolas, monospace" font-weight="800" font-size="30" fill="${fg}">${txt.replace('<', '&lt;')}</text></svg>`;
  };

  // ---- Sessão: medalhões de letreiro. Disco escuro com filete dourado e um losango em cima e embaixo; o desenho em
  // dourado, a caveira em marfim e o coração em vermelho.
  const sessao = (k) => {
    const gold = '#f3d9a0', g2 = '#d8b468', red = '#e5484d', iv = '#efe6d6', bk = '#15120d';
    const line = (d, c = gold, w = 3) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const disc = `<circle cx="32" cy="32" r="30.5" fill="${bk}" stroke="#8f7238" stroke-width="1.5"/><circle cx="32" cy="32" r="26.5" fill="none" stroke="#3b301d" stroke-width="1.2"/>`
      + `<path d="M32-3.4l4.4 4.4-4.4 4.4-4.4-4.4zM32 58.6l4.4 4.4-4.4 4.4-4.4-4.4z" fill="${g2}"/>`;
    const small = (b) => `<g transform="translate(32 33) scale(.58) translate(-32 -32)">${b}</g>`;
    const body = {
      laugh: line(D.eyeL) + line(D.eyeR) + `<path d="${D.grin}" fill="${gold}"/>`,
      wow: `<circle cx="23" cy="27" r="3.4" fill="${gold}"/><circle cx="41" cy="27" r="3.4" fill="${gold}"/>` + line(D.browL, gold, 2.4) + line(D.browR, gold, 2.4) + line(D.oh),
      fire: small(`<path d="${D.flame}" fill="${g2}"/><path d="${D.flameIn}" fill="${bk}"/>`),
      like: small(`<path d="${D.cuff}" fill="${g2}"/><path d="${D.thumb}" fill="${gold}"/>`),
      skull: small(`<path d="${D.skull}" fill="${iv}"/><path d="${D.sockL}" fill="${bk}"/><path d="${D.sockR}" fill="${bk}"/><path d="${D.nose}" fill="${bk}"/>` + line(D.teeth, bk, 3.4)),
      heart: small(`<path d="${D.heart}" fill="${red}"/>`),
    }[k];
    return svg('sessao', disc + body);
  };

  // ---- Fliperama: desenhos de pixel (12 x 12) com contorno escuro, como itens de um jogo de 16 bits.
  const fliperama = (k) => {
    const C = { k: '#08061c', y: '#ffd23f', w: '#f7f5ff', r: '#ff3d5e', c: '#35e0e0', o: '#ff8a3d' };
    const rows = {
      laugh: ['...kkkkkk...', '..kyyyyyyk..', '.kyyyyyyyyk.', 'kyykyyyykyyk', 'kykykyykykyk', 'cyyyyyyyyyyc', 'ckkkkkkkkkkc', 'kykwwwwwwkyk', 'kyykrrrrkyyk', '.kyykkkkyyk.', '..kyyyyyyk..', '...kkkkkk...'],
      wow: ['...kkkkkk...', '..kyyyyyyk..', '.kyyyyyyyyk.', 'kyykkyykkyyk', 'kyykkyykkyyk', 'kyyyyyyyyyyk', 'kyyyykkyyyyk', 'kyyykrrkyyyk', 'kyyykrrkyyyk', '.kyyykkyyyk.', '..kyyyyyyk..', '...kkkkkk...'],
      fire: ['.....k......', '....krk.k...', '....krrkrk..', '...krrrrrk..', '..krrorrrrk.', '..krroorrrk.', '.krrooyorrrk', '.krroyyoorrk', '.krroyyyoork', '.krrooyyoork', '..krroooork.', '...kkkkkkk..'],
      like: ['.....kk.....', '....kwwk....', '....kwwk....', '....kwwk....', 'kkkkkwwkkkk.', 'kcckwwwwwwwk', 'kcckwwwwwwwk', 'kcckwwwwwwwk', 'kcckwwwwwwwk', 'kcckwwwwwwk.', 'kkkkkkkkkk..', '............'],
      skull: ['..kkkkkkkk..', '.kwwwwwwwwk.', 'kwwwwwwwwwwk', 'kwkkwwwwkkwk', 'kwkkwwwwkkwk', 'kwwwwkkwwwwk', 'kwwwwwwwwwwk', '.kwwwwwwwwk.', '..kwkwwkwk..', '..kwkwwkwk..', '..kkkkkkkk..', '............'],
      heart: ['............', '..kkk..kkk..', '.krrrkkrrrk.', 'krwrrrrrrrrk', 'krrrrrrrrrrk', 'krrrrrrrrrrk', '.krrrrrrrrk.', '..krrrrrrk..', '...krrrrk...', '....krrk....', '.....kk.....', '............'],
    }[k];
    let r = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        let x2 = x;
        while (row[x2 + 1] === ch) x2++;
        r += `<rect x="${x}" y="${y}" width="${x2 - x + 1}" height="1" fill="${C[ch]}"/>`;
        x = x2;
      }
    });
    return `<svg class="fx-emo fx-emo-fliperama" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
  };

  // ---- Toca-fitas: disquinhos de vinil. Disco preto com sulcos e, no rótulo colorido do meio, o desenho a nanquim.
  const tocafitas = (k) => {
    const ink = '#2b1c13';
    const label = { laugh: '#e2a52b', wow: '#e2a52b', fire: '#f58f45', like: '#5fb3a8', skull: '#f9efd9', heart: '#f9efd9' }[k];
    const line = (d, c = ink, w = 4.2) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const disc = `<circle cx="32" cy="32" r="31" fill="#17100b" stroke="#4a3222" stroke-width="1.5"/><circle cx="32" cy="32" r="27" fill="none" stroke="#3a2a1d" stroke-width="1.2"/><circle cx="32" cy="32" r="23.5" fill="none" stroke="#3a2a1d" stroke-width="1.2"/>`
      + `<circle cx="32" cy="32" r="20" fill="${label}"/>`;
    const small = (b) => `<g transform="translate(32 32.5) scale(.5) translate(-32 -32)">${b}</g>`;
    const body = {
      laugh: small(line(D.eyeL) + line(D.eyeR) + `<path d="${D.grin}" fill="${ink}"/>`),
      wow: small(`<circle cx="23" cy="27" r="4.4" fill="${ink}"/><circle cx="41" cy="27" r="4.4" fill="${ink}"/><path d="${D.oh}" fill="${ink}"/>`),
      fire: small(`<path d="${D.flame}" fill="${ink}"/><path d="${D.flameIn}" fill="#f58f45"/>`),
      like: small(`<path d="${D.cuff}" fill="${ink}"/><path d="${D.thumb}" fill="${ink}"/>`),
      skull: small(`<path d="${D.skull}" fill="${ink}"/><path d="${D.sockL}" fill="#f9efd9"/><path d="${D.sockR}" fill="#f9efd9"/>` + line(D.teeth, '#f9efd9', 3.6)),
      heart: small(`<path d="${D.heart}" fill="#d93a2b"/>`),
    }[k];
    return svg('tocafitas', disc + body);
  };

  const EMOTES = { arena, varanda, neon, galeria, caderno, planta, terminal, sessao, fliperama, tocafitas };
  // uma versão do tema com as mesmas peças (ex.: "varanda-noite" usa as do "varanda")
  const base = (theme) => String(theme || '').split('-')[0];

  // ---- a mãozinha ("dedo"): desenho numa área de 32 x 32 e onde fica a ponta
  const HAND_PATH = 'M11 3.5c1.4 0 2.5 1.1 2.5 2.5v8.2l.6-.1c1.3-.2 2.4.6 2.7 1.8l.1.4.5-.1c1.3-.2 2.4.6 2.7 1.8l.1.3.4-.1c1.4-.2 2.6.8 2.7 2.2l.4 4.2c.2 2.6-1.1 5-3.4 6.2l-.8.4c-1.2.6-2.5.9-3.9.9h-1.2c-2.4 0-4.6-1.2-5.9-3.2l-4.3-6.6c-.7-1.1-.4-2.6.7-3.3 1-.6 2.3-.4 3.1.4L8.5 22V6c0-1.4 1.1-2.5 2.5-2.5z';
  const HANDS = {
    // dedo de espuma de torcida, de cantos retos
    arena: {
      tip: [13.5, 1.5],
      body: '<path d="M10 2h7v12h6l3 3v9l-4 4h-12l-4-4v-10l4-2z" fill="var(--c)" stroke="#0e0f12" stroke-width="2.4" stroke-linejoin="miter"/>'
        + '<path d="M12.6 5.5v7.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6"/><path d="M10.5 19h11" fill="none" stroke="#0e0f12" stroke-opacity=".4" stroke-width="1.6"/>',
    },
    // a mãozinha de sempre, com borda branca de adesivo
    varanda: { tip: [11, 3.5], body: `<path d="${HAND_PATH}" fill="var(--c)" stroke="#fff" stroke-width="3.6" stroke-linejoin="round" paint-order="stroke"/>` },
    // só o contorno aceso
    neon: {
      tip: [11, 3.5],
      body: `<path d="${HAND_PATH}" fill="var(--c)" fill-opacity=".16" stroke-width="2" stroke-linejoin="round" style="stroke:color-mix(in srgb, var(--c) 45%, #fff);filter:drop-shadow(0 0 2px var(--c)) drop-shadow(0 0 6px var(--c))"/>`,
    },
    // mão branca de traço fino, com uma pinta na cor de quem aponta
    galeria: { tip: [11, 3.5], body: `<path d="${HAND_PATH}" fill="#fff" stroke="#121212" stroke-width="1.5" stroke-linejoin="round"/><circle cx="14.5" cy="24" r="3.2" fill="var(--c)"/>` },
    // mão de papel contornada a caneta, com um risco na cor de quem aponta
    caderno: { tip: [11, 3.5], body: `<path d="${HAND_PATH}" fill="#fdfcf6" stroke="#20379c" stroke-width="1.8" stroke-linejoin="round"/><path d="M11.5 23c2.2 1.8 5 1.8 7.2 0" fill="none" stroke="var(--c)" stroke-width="2.4" stroke-linecap="round"/>` },
    // mão em azul de planta com contorno branco e uma pinta na cor de quem aponta
    planta: { tip: [11, 3.5], body: `<path d="${HAND_PATH}" fill="#18439a" stroke="#f4f8ff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="14.5" cy="24" r="3.2" fill="var(--c)"/>` },
    // mira de linha fina na cor de quem aponta: não tampa o que está sendo apontado
    terminal: {
      tip: [16, 16],
      body: '<path d="M16 3v9M16 20v9M3 16h9M20 16h9" fill="none" stroke="#050a07" stroke-width="4.4" stroke-linecap="square"/><rect x="13.5" y="13.5" width="5" height="5" fill="none" stroke="#050a07" stroke-width="3.6"/>'
        + '<path d="M16 3v9M16 20v9M3 16h9M20 16h9" fill="none" stroke="var(--c)" stroke-width="2" stroke-linecap="square"/><rect x="13.5" y="13.5" width="5" height="5" fill="none" stroke="var(--c)" stroke-width="1.5"/>',
    },
    // foco de luz: um aro dourado com um brilho quente por dentro e um losango na cor de quem aponta
    sessao: {
      tip: [16, 16],
      body: '<circle cx="16" cy="16" r="12.5" fill="#f3d9a0" fill-opacity=".2" stroke="#080706" stroke-width="3.2"/><circle cx="16" cy="16" r="12.5" fill="none" stroke="#f3d9a0" stroke-width="1.4"/>'
        + '<path d="M16 12.2l3.8 3.8-3.8 3.8-3.8-3.8z" fill="var(--c)" stroke="#080706" stroke-width="1"/>',
    },
    // luva de pixel, com o punho na cor de quem aponta
    fliperama: {
      tip: [11, 1],
      body: (() => {
        const rows = ['....kk..........', '...kwwk.........', '...kwwk.........', '...kwwk.........', '...kwwkkk.......', '...kwwkwwkk.....', 'kk.kwwkwwkwk....', 'kwkkwwwwwwwwk...', 'kwwkwwwwwwwwk...', '.kwwwwwwwwwwk...', '..kwwwwwwwwwk...', '..kwwwwwwwwk....', '...kwwwwwwwk....', '...kcccccck.....', '...kcccccck.....', '...kkkkkkkk.....'];
        const fill = { k: '#08061c', w: '#f7f5ff', c: 'var(--c)' };
        let r = '';
        rows.forEach((row, y) => {
          for (let x = 0; x < row.length; x++) {
            const ch = row[x];
            if (ch === '.') continue;
            let x2 = x;
            while (row[x2 + 1] === ch) x2++;
            r += `<rect x="${x * 2 + 3}" y="${y * 2}" width="${(x2 - x + 1) * 2}" height="2" fill="${fill[ch]}"/>`;
            x = x2;
          }
        });
        return `<g shape-rendering="crispEdges">${r}</g>`;
      })(),
    },
    // mão creme de contorno escuro, com o punho na cor de quem aponta
    tocafitas: { tip: [11, 3.5], body: `<path d="${HAND_PATH}" fill="#f9efd9" stroke="#2b1c13" stroke-width="1.7" stroke-linejoin="round"/><path d="M10.6 24.6c2.6 2.2 6.4 2.4 9.4 .4" fill="none" stroke="var(--c)" stroke-width="3" stroke-linecap="round"/>` },
  };

  // ---- o risco (caneta e rastro): camadas, da de baixo para a de cima. w multiplica a largura de sempre;
  // sem "color" a camada usa a cor de quem desenha ("light" clareia essa cor para o miolo do tubo).
  const LINES = {
    arena: [{ w: 2.2, color: '#0e0f12' }, { w: 1.15 }],                                // cor chapada com contorno preto, de telestrator
    varanda: [{ w: 2.3, color: '#ffffff' }, { w: 1.4 }],                               // giz de cera com borda branca
    neon: [{ w: 4, alpha: 0.13 }, { w: 2.3, alpha: 0.32 }, { w: 1.1 }, { w: 0.45, light: true }], // tubo aceso
    galeria: [{ w: 1.7, color: '#ffffff' }, { w: 0.8 }],                              // traço fino na cor de quem desenha, com filete branco
    caderno: [{ w: 2.6, alpha: 0.28 }, { w: 0.9 }],                                    // caneta por cima de um marca-texto da mesma cor
    planta: [{ w: 1.15 }, { w: 0.4, color: '#f4f8ff', dash: [9, 7] }],                  // linha na cor de quem desenha, com tracejado branco de linha de construção
    terminal: [{ w: 1.7, color: '#050a07' }, { w: 0.8, dash: [9, 5] }],                // tracejado na cor de quem desenha, sobre um fio escuro
    sessao: [{ w: 2.1, color: '#8f7238' }, { w: 1.55, color: '#080706' }, { w: 1.0 }],  // a cor de quem desenha dentro de um filete dourado, como a moldura da tela
    fliperama: [{ w: 2.6, color: '#08061c' }, { w: 1.5, dash: [6, 3] }],              // quadradinhos na cor de quem desenha, sobre um fio escuro grosso
    tocafitas: [{ w: 2.3, color: '#2b1c13' }, { w: 1.5 }, { w: 0.35, color: '#fbf5e4', alpha: 0.85 }], // fita: a cor de quem desenha com contorno escuro e um filete creme no meio
  };
  const light = (color) => { const m = /hsl\(\s*(\d+)/.exec(color || ''); return m ? `hsl(${m[1]}, 100%, 88%)` : '#ffffff'; };

  window.ThemeFx = {
    // desenho do emote no tema (texto de SVG), ou null para usar o emoji de sempre
    emote(theme, emoji) {
      const draw = EMOTES[base(theme)];
      const kind = KIND[emoji];
      return draw && kind ? draw(kind) : null;
    },
    // a mãozinha no tema: { html, tip: [x, y] em px }, ou null para usar a de sempre
    hand(theme, size) {
      const h = HANDS[base(theme)];
      if (!h) return null;
      const k = size / 32;
      return { html: `<svg viewBox="0 0 32 32" width="${size}" height="${size}" style="overflow:visible">${h.body}</svg>`, tip: [h.tip[0] * k, h.tip[1] * k] };
    },
    // Risca os traços vivos no jeito do tema. Devolve false se o tema usa o risco de sempre (aí quem chamou desenha).
    // segs: { x1, y1, x2, y2 (0..1), color, t, life? }; box: onde fica a imagem no canvas { x, y, w, h };
    // base: largura de sempre { pen, trail }. Traços da mesma cor e idade saem num risco só (sem emendas marcadas).
    drawLines(g, theme, segs, now, box, widths) {
      const layers = LINES[base(theme)];
      if (!layers) return false;
      const groups = new Map();
      for (const s of segs) {
        const age = now - s.t;
        const a = s.life ? Math.min(1, (s.life - age) / 1200) : 1 - age / 2500; // caneta só esmaece no fim; rastro vai sumindo
        const q = Math.ceil(Math.max(0, a) * 8);
        if (!q) continue;
        const key = `${s.color}|${s.life ? 1 : 0}|${q}`;
        let grp = groups.get(key);
        if (!grp) { grp = { color: s.color, pen: !!s.life, alpha: q / 8, segs: [] }; groups.set(key, grp); }
        grp.segs.push(s);
      }
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const L of layers) {
        for (const grp of groups.values()) {
          g.globalAlpha = grp.alpha * (L.alpha == null ? 1 : L.alpha);
          g.strokeStyle = L.color || (L.light ? light(grp.color) : grp.color);
          g.lineWidth = (grp.pen ? widths.pen : widths.trail) * L.w;
          g.setLineDash(L.dash || []); // camada tracejada (ex.: linha de construção do Planta)
          g.lineCap = L.dash ? 'butt' : 'round';
          g.beginPath();
          // pedaços emendados seguem no mesmo caminho: o tracejado continua em vez de recomeçar a cada pedacinho
          let px = null, py = null;
          for (const s of grp.segs) {
            const x1 = box.x + s.x1 * box.w, y1 = box.y + s.y1 * box.h, x2 = box.x + s.x2 * box.w, y2 = box.y + s.y2 * box.h;
            if (px !== x1 || py !== y1) g.moveTo(x1, y1);
            g.lineTo(x2, y2);
            px = x2; py = y2;
          }
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      g.setLineDash([]);
      return true;
    },
  };
})();
