// Teste do controle de bitrate da "Nativa direta" (src/renderer/netctl.js) numa rede simulada.
// Cada cenário roda o controle novo (e o antigo, só para comparar) segundo a segundo e confere
// limites: não cortar por pico de ping, não afundar por atraso que não é do vídeo, achar o tamanho
// real de um caminho apertado, voltar rápido quando a rede melhora e NUNCA mandar acima do que o
// WebRTC solta numa conexão (o excesso vira fila no envio: a tela do amigo atrasa; até a v1.0.57
// essa fila ainda era jogada fora por um defeito da trilha vazia e a tela dele congelava).
//   node scripts/netctl-test.js        (sai com código 1 se algum cenário falhar; -v mostra tudo)
const path = require('path');
const NetCtl = require(path.join(__dirname, '..', 'src', 'renderer', 'netctl.js'));

// ---------------------------------------------------------------- rede simulada
// cap(t): kb/s que cabem na IDA; rev(t): atraso extra na VOLTA (s); rand(t): perda aleatória;
// bufMs: tamanho da fila do gargalo; vpn: a estimativa de banda não serve de testemunha;
// floor/bweMax: piso e teto da estimativa de banda do WebRTC; rx: false = amigo em versão antiga
// (não avisa quanto recebe).
// O WebRTC de quem envia entra no modelo: ele só solta ~1,1x a estimativa dele; o que passa disso
// fica numa fila aqui. Com mais de ~0,35 s de dados nela o segundo conta como ruim ("frozen": tela
// atrasada; nas versões antigas, congelada).
function makePath(o) {
  const p = { name: o.name, q: 0, pq: 0, bwe: o.bweStart || 12000, from: o.from || 0, to: o.to == null ? Infinity : o.to, st: NetCtl.newPath(), vpn: !!o.vpn };
  const cap = o.cap || (() => 50000), rev = o.rev || (() => 0), rand = o.rand || (() => 0), bweCap = o.bweCap || (() => Infinity);
  // (o app combina um piso para a estimativa: 60% do nominal, 7,2 Mb/s para os 12 Mb/s dos cenários)
  const base = o.base || 0.03, bufMs = o.bufMs || 400, floor = o.floor == null ? 7200 : o.floor, bweMax = o.bweMax || 30000;
  let seed = (o.seed || 1) * 7919;
  const rxOn = o.rx !== false;
  let prev = null;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 0.006; };
  p.bwe = Math.max(floor, Math.min(bweMax, p.bwe));
  p.step = (R, t) => {
    const C = cap(t);
    // fila de envio do WebRTC
    const paceRate = 1.1 * p.bwe;
    const out = Math.min(R + p.pq, paceRate);
    p.pq = Math.max(0, p.pq + R - paceRate);
    let frozen = 0, flush = 0;
    if (p.pq > p.bwe * 0.35) { p.pq = p.bwe * 0.35; frozen = 1; flush = 1; }
    // gargalo na rede
    const q0 = p.q;
    p.q = Math.max(0, p.q + (out - C));
    const qMax = (C * bufMs) / 1000;
    let lost = 0;
    if (p.q > qMax) { lost = p.q - qMax; p.q = qMax; }
    const loss = Math.min(1, lost / Math.max(1, out) + rand(t));
    const delivered = Math.min(out + q0, C) * (1 - rand(t)); // o que chega no amigo neste segundo
    const rtt = base + p.q / C + rev(t) + noise();
    // estimativa de banda do WebRTC (só mede a ida): cai quando a fila da rede cresce ou a perda é alta
    if ((p.q - q0) / C > 0.005) p.bwe = 0.85 * Math.min(out, C);
    else if (loss > 0.1) p.bwe *= 1 - 0.5 * loss;
    else p.bwe = Math.min(p.bwe * 1.08, Math.max(p.bwe, 1.5 * Math.min(out, C) + 10));
    p.bwe = Math.max(floor, Math.min(bweMax, bweCap(t), p.bwe));
    p.last = { loss, rtt, bwe: p.bwe, pace: NetCtl.paceOf(p.bwe, 0), bweFloor: floor, flush, vpn: p.vpn, frozen,
      delay: p.q / C + p.pq / Math.max(1, paceRate), rx: rxOn && prev ? prev.delivered / prev.R : null };
    prev = { delivered, R };
    return p.last;
  };
  return p;
}

// controle antigo (até a v1.0.57): um número só para a sala, estimativa de banda ignorada
function oldController() {
  let lastCut = -1e9, baseRtt = Infinity, ceil = 0, ceilAt = 0;
  return (samples, R, max, now) => {
    let loss = 0, rtt = 0, flushes = 0;
    for (const s of samples) { loss = Math.max(loss, s.loss); rtt = Math.max(rtt, s.rtt); flushes += s.flush; }
    if (rtt > 0) baseRtt = Math.min(baseRtt, rtt);
    const extra = rtt > 0 && isFinite(baseRtt) ? rtt - baseRtt : 0;
    const severe = loss > 0.08 || extra > 0.3;
    const congested = severe || loss > 0.02 || extra > 0.08 || flushes > 0;
    let target = R;
    const gap = Math.min(3000, Math.max(severe ? 1000 : 2000, rtt * 1000));
    if (congested) { if (now - lastCut > gap) { target = R * (severe ? 0.5 : 0.75); lastCut = now; ceil = R; ceilAt = now; } }
    else if (extra > 0.04) { /* segura */ }
    else if (loss < 0.005 && now - lastCut > 6000) { const near = ceil && R > ceil * 0.85 && now - ceilAt < 120000; target = R * (near ? 1.01 : 1.04) + 100; }
    target = Math.round(Math.max(1000, Math.min(max, target)));
    return target !== R && (Math.abs(target - R) / R > 0.05 || target === max) ? target : R;
  };
}

function run(sc, useOld) {
  const paths = sc.paths.map((o, i) => makePath({ ...o, seed: i + 1 }));
  const ctl = NetCtl.newCtl();
  const old = oldController();
  const max = sc.max || 12000, min = 1000;
  let R = sc.start || max;
  const log = [];
  for (let t = 0; t < sc.secs; t++) {
    const now = 100000 + t * 1000;
    const live = paths.filter((p) => t >= p.from && t < p.to);
    const samples = live.map((p) => p.step(R, t));
    let why = '';
    if (useOld) R = old(samples, R, max, now);
    else {
      live.forEach((p, i) => NetCtl.classify(p.st, samples[i], R, now));
      const d = NetCtl.decide(ctl, live.map((p, i) => ({ name: p.name, st: p.st, s: samples[i] })), R, max, min, now);
      why = d.did ? `${d.did} (${d.why})` : d.level !== 'ok' ? `${d.level} (${d.why})` : '';
      if (d.notes.length) why += ' | ' + d.notes.join('; ');
      R = d.target;
    }
    log.push({ t, R, why, delay: Math.max(0, ...live.map((p) => p.last.delay)), loss: Math.max(0, ...live.map((p) => p.last.loss)), frozen: Math.max(0, ...live.map((p) => p.last.frozen)) });
  }
  return log;
}
const avg = (log, a, b, k = 'R') => { const x = log.filter((r) => r.t >= a && r.t < b); return x.reduce((s, r) => s + r[k], 0) / Math.max(1, x.length); };
const minR = (log, a, b) => Math.min(...log.filter((r) => r.t >= a && r.t < b).map((r) => r.R));
const maxR = (log, a, b) => Math.max(...log.filter((r) => r.t >= a && r.t < b).map((r) => r.R));
const frozen = (log) => log.reduce((s, r) => s + r.frozen, 0);

const ok3 = [{ name: 'Ana' }, { name: 'Bia' }, { name: 'Caio' }];
// pelo Radmin a estimativa do WebRTC costuma ficar baixa sem a rede estar cheia: o app combina um
// piso alto para ela nesses caminhos (7,2 Mb/s para 12 Mb/s de qualidade) e o teto de envio vira ~6,6 Mb/s
const radmin = (o) => ({ vpn: true, bweMax: 7200, ...o });
const RAD = Math.round(NetCtl.paceOf(7200, 0)); // 6624
const osc = (t) => (t >= 30 && t < 210 ? 0.3 + 1.7 * Math.abs(Math.sin(t * 1.7)) * (t % 7 < 4 ? 1 : 0.2) : 0);
const tight = (t) => (t >= 30 && t < 120 ? 4000 : 50000);
const scenarios = [
  {
    name: 'rede limpa (3 amigos)', secs: 60, paths: ok3, start: 6000,
    check: (l) => [avg(l, 30, 60) > 11500, `média final ${Math.round(avg(l, 30, 60))} kb/s (esperado ~12000)`],
  },
  {
    name: 'pico de ping de um amigo (+900 ms por 1 s)', secs: 80,
    paths: [...ok3.slice(0, 2), { name: 'Caio', rev: (t) => (t === 40 ? 0.9 : 0) }],
    check: (l) => [minR(l, 35, 80) >= 11900, `mínimo depois do pico ${minR(l, 35, 80)} kb/s (não pode cortar)`],
  },
  {
    name: 'ping alto e parado de um amigo por 60 s, internet direta (fila na volta do caminho)', secs: 140,
    paths: [...ok3.slice(0, 2), { name: 'Caio', rev: (t) => (t >= 40 && t < 100 ? 0.6 : 0) }],
    check: (l) => [minR(l, 35, 140) >= 11900, `mínimo ${minR(l, 35, 140)} kb/s (a ida está livre: não pode cortar)`],
  },
  {
    name: 'ping alto e parado por 60 s, pelo Radmin (o amigo avisa que recebe tudo)', secs: 160,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', rev: (t) => (t >= 40 && t < 100 ? 0.6 : 0) })],
    check: (l) => [minR(l, 35, 160) >= RAD * 0.7 && avg(l, 40, 100) > RAD * 0.9 && avg(l, 110, 160) > RAD * 0.97,
      `teto ${RAD}; mínimo ${minR(l, 35, 160)} (≥${Math.round(RAD * 0.7)}), média no episódio ${Math.round(avg(l, 40, 100))} (>${Math.round(RAD * 0.9)}), depois ${Math.round(avg(l, 110, 160))}`],
  },
  {
    name: 'o mesmo com o amigo em versão antiga (não avisa quanto recebe)', secs: 160,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', rx: false, rev: (t) => (t >= 40 && t < 100 ? 0.6 : 0) })],
    check: (l) => [minR(l, 35, 160) >= RAD * 0.5 && avg(l, 40, 100) > RAD * 0.8 && avg(l, 110, 160) > RAD * 0.97,
      `teto ${RAD}; mínimo ${minR(l, 35, 160)} (≥${Math.round(RAD * 0.5)}), média no episódio ${Math.round(avg(l, 40, 100))} (>${Math.round(RAD * 0.8)}), depois ${Math.round(avg(l, 110, 160))}`],
  },
  {
    name: 'ping subindo e descendo sem parar num amigo (+300 a +2000 ms, perda 0%), como nos registros', secs: 240,
    paths: [...ok3, { name: 'Dani' }, { name: 'Edu', rev: osc }],
    check: (l) => [avg(l, 30, 210) > 11500, `média durante o episódio ${Math.round(avg(l, 30, 210))} kb/s (>11500)`],
  },
  {
    name: 'o mesmo, pelo Radmin', secs: 240,
    paths: [...ok3, { name: 'Dani' }, radmin({ name: 'Edu', rev: osc })],
    check: (l) => [minR(l, 0, 240) >= RAD * 0.7 && avg(l, 30, 210) > RAD * 0.9, `teto ${RAD}; mínimo ${minR(l, 0, 240)} (≥${Math.round(RAD * 0.7)}), média durante o episódio ${Math.round(avg(l, 30, 210))} kb/s (>${Math.round(RAD * 0.9)})`],
  },
  {
    name: 'o mesmo, pelo Radmin, amigo em versão antiga', secs: 240,
    paths: [...ok3, { name: 'Dani' }, radmin({ name: 'Edu', rx: false, rev: osc })],
    check: (l) => [minR(l, 0, 240) >= RAD * 0.5 && avg(l, 30, 210) > RAD * 0.8, `teto ${RAD}; mínimo ${minR(l, 0, 240)} (≥${Math.round(RAD * 0.5)}), média durante o episódio ${Math.round(avg(l, 30, 210))} kb/s (>${Math.round(RAD * 0.8)})`],
  },
  {
    name: 'amigo com rede de 4 Mb/s a partir dos 30 s (internet direta); volta ao normal aos 120 s', secs: 200,
    paths: [...ok3.slice(0, 2), { name: 'Caio', cap: tight }],
    check: (l) => [avg(l, 50, 120) > 2800 && avg(l, 50, 120) < 4300 && avg(l, 60, 120, 'delay') < 0.15 && avg(l, 60, 120, 'loss') < 0.02 && avg(l, 160, 200) > 11000,
      `média no aperto ${Math.round(avg(l, 50, 120))} kb/s (2800–4300), atraso ${Math.round(avg(l, 60, 120, 'delay') * 1000)} ms (<150), perda ${(avg(l, 60, 120, 'loss') * 100).toFixed(1)}% (<2), depois ${Math.round(avg(l, 160, 200))} (>11000)`],
  },
  {
    name: 'amigo com rede de 4 Mb/s pelo Radmin, fila funda (2 s)', secs: 200,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', bufMs: 2000, cap: tight })],
    check: (l) => [avg(l, 60, 120) > 2400 && avg(l, 60, 120) < 4300 && avg(l, 70, 120, 'delay') < 0.35 && avg(l, 165, 200) > RAD * 0.95,
      `média no aperto ${Math.round(avg(l, 60, 120))} kb/s (2400–4300), atraso ${Math.round(avg(l, 70, 120, 'delay') * 1000)} ms (<350), depois ${Math.round(avg(l, 165, 200))} (>${Math.round(RAD * 0.95)})`],
  },
  {
    name: 'amigo com rede de 4 Mb/s pelo Radmin, fila rasa (60 ms): só perda', secs: 200,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', bufMs: 60, cap: tight })],
    check: (l) => [avg(l, 60, 120) > 2400 && avg(l, 60, 120) < 4500 && avg(l, 70, 120, 'loss') < 0.05 && avg(l, 165, 200) > RAD * 0.95,
      `média no aperto ${Math.round(avg(l, 60, 120))} kb/s (2400–4500), perda ${(avg(l, 70, 120, 'loss') * 100).toFixed(1)}% (<5), depois ${Math.round(avg(l, 165, 200))} (>${Math.round(RAD * 0.95)})`],
  },
  {
    name: 'amigo com rede de 4 Mb/s pelo Radmin, fila funda, versão antiga (pior caso: sem testemunha)', secs: 200,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', rx: false, bufMs: 2000, cap: tight })],
    check: (l) => [avg(l, 70, 120) < 5200 && avg(l, 80, 120, 'loss') < 0.08 && avg(l, 165, 200) > RAD * 0.95,
      `média no aperto ${Math.round(avg(l, 70, 120))} kb/s (<5200), perda ${(avg(l, 80, 120, 'loss') * 100).toFixed(1)}% (<8), atraso ${Math.round(avg(l, 80, 120, 'delay') * 1000)} ms, depois ${Math.round(avg(l, 165, 200))} (>${Math.round(RAD * 0.95)})`],
  },
  {
    name: 'amigo onde cabem 5,5 Mb/s pelo Radmin, fila funda (aperto leve), versão antiga', secs: 160,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', rx: false, bufMs: 2000, cap: () => 5500 })],
    check: (l) => [avg(l, 30, 160) > 4100 && avg(l, 30, 160) < 5700 && avg(l, 30, 160, 'delay') < 0.3,
      `média ${Math.round(avg(l, 30, 160))} kb/s (4100–5700), atraso ${Math.round(avg(l, 30, 160, 'delay') * 1000)} ms (<300)`],
  },
  {
    name: 'o mesmo com o amigo avisando quanto recebe', secs: 160,
    paths: [...ok3.slice(0, 2), radmin({ name: 'Caio', bufMs: 2000, cap: () => 5500 })],
    check: (l) => [avg(l, 30, 160) > 4100 && avg(l, 30, 160) < 5700 && avg(l, 30, 160, 'delay') < 0.3,
      `média ${Math.round(avg(l, 30, 160))} kb/s (4100–5700), atraso ${Math.round(avg(l, 30, 160, 'delay') * 1000)} ms (<300)`],
  },
  {
    name: 'estimativa de banda do WebRTC baixa num caminho bom (presa em 5 Mb/s): fica logo abaixo dela, sem congelar', secs: 90, start: 4000,
    paths: [...ok3.slice(0, 2), { name: 'Caio', floor: 0, bweMax: 5000 }],
    check: (l) => [minR(l, 20, 90) >= 4500 && maxR(l, 20, 90) <= 4700, `mínimo ${minR(l, 20, 90)}, máximo ${maxR(l, 20, 90)} (4500–4700: o que o WebRTC solta nessa conexão)`],
  },
  {
    name: 'o caminho de um amigo cai de repente para 3,3 Mb/s com o bitrate em 12', secs: 90,
    paths: [...ok3.slice(0, 2), { name: 'Caio', bweMax: 30000, cap: (t) => (t >= 30 && t < 60 ? 3300 : 50000), bufMs: 150 }],
    check: (l) => [avg(l, 36, 60) < 3300 && avg(l, 75, 90) > 9000, `média no aperto ${Math.round(avg(l, 36, 60))} kb/s (<3300), depois ${Math.round(avg(l, 75, 90))} (>9000)`],
  },
  {
    name: 'a estimativa do WebRTC de um amigo cai de repente para 3 Mb/s com o bitrate em 12 (com o controle antigo a tela dele atrasava e, pelo defeito da trilha vazia, congelava)', secs: 90,
    paths: [...ok3.slice(0, 2), { name: 'Caio', floor: 0, bweCap: (t) => (t >= 30 && t < 60 ? 3000 : Infinity) }],
    check: (l) => [maxR(l, 32, 60) <= 2800 && avg(l, 75, 90) > 9000, `máximo no aperto ${maxR(l, 32, 60)} kb/s (≤2800: abaixo da estimativa), depois ${Math.round(avg(l, 75, 90))} (>9000)`],
  },
  {
    name: 'amigo com ping normal de 180 ms entra aos 20 s', secs: 90,
    paths: [...ok3.slice(0, 2), { name: 'Longe', base: 0.18, from: 20 }],
    check: (l) => [minR(l, 15, 90) >= 11900, `mínimo ${minR(l, 15, 90)} kb/s (não pode cortar)`],
  },
  {
    name: 'perda aleatória de 3% constante num amigo (Wi-Fi)', secs: 240,
    paths: [...ok3.slice(0, 2), { name: 'WiFi', rand: () => 0.03 }],
    check: (l) => [minR(l, 0, 240) >= 7000 && avg(l, 120, 240) > 11000, `mínimo ${minR(l, 0, 240)} (≥7000), média no fim ${Math.round(avg(l, 120, 240))} (>11000)`],
  },
  {
    name: 'meu upload cheio: todos os caminhos em 3 Mb/s (internet direta)', secs: 120, start: 12000,
    paths: ok3.map((p) => ({ ...p, cap: () => 3000 })),
    check: (l) => [avg(l, 30, 120) > 2000 && avg(l, 30, 120) < 3300 && avg(l, 40, 120, 'delay') < 0.15,
      `média ${Math.round(avg(l, 30, 120))} kb/s (2000–3300), atraso ${Math.round(avg(l, 40, 120, 'delay') * 1000)} ms (<150)`],
  },
  {
    name: 'estimativa de banda presa no piso de 4 Mb/s e o caminho só leva 2 Mb/s (internet direta)', secs: 120,
    paths: [...ok3.slice(0, 2), { name: 'Caio', floor: 4000, cap: (t) => (t >= 20 ? 2000 : 50000) }],
    check: (l) => [avg(l, 50, 120) < 2600 && avg(l, 60, 120, 'delay') < 0.25 && avg(l, 60, 120, 'loss') < 0.03,
      `média ${Math.round(avg(l, 50, 120))} kb/s (<2600), atraso ${Math.round(avg(l, 60, 120, 'delay') * 1000)} ms (<250), perda ${(avg(l, 60, 120, 'loss') * 100).toFixed(1)}% (<3)`],
  },
];

const verbose = process.argv.includes('-v');
let failed = 0;
for (const sc of scenarios) {
  const l = run(sc, false), lo = run(sc, true);
  let [ok, msg] = sc.check(l);
  // em nenhum cenário o controle novo pode deixar fila no envio do WebRTC por mais que um instante
  const fz = frozen(l);
  if (fz > 2) { ok = false; msg += ` · FILA NO ENVIO por ${fz} s (acima do que o WebRTC solta)`; }
  if (!ok) failed++;
  console.log(`${ok ? 'ok    ' : 'FALHOU'} ${sc.name}`);
  console.log(`         ${msg}`);
  console.log(`         média: novo ${Math.round(avg(l, 0, sc.secs))} kb/s (fila no envio ${fz} s) · antigo ${Math.round(avg(lo, 0, sc.secs))} kb/s (fila no envio ${frozen(lo)} s)`);
  if (verbose || !ok) for (const r of l) if (r.why || verbose) console.log(`           t=${r.t} R=${r.R} atraso=${Math.round(r.delay * 1000)}ms perda=${(r.loss * 100).toFixed(1)}%${r.frozen ? ' FILA' : ''} ${r.why}`);
}
// Corte pedido por fora (quem recebe pelo servidor de vídeo reclamou) com o bitrate já seguro pelo
// teto de envio: a decisão seguinte não pode voltar direto para onde estava (desfaria o corte).
{
  const p = makePath({ name: 'Servidor', floor: 0, bweCap: () => 8000, seed: 9 });
  const ctl = NetCtl.newCtl();
  let R = 12000, t = 0;
  const tick = () => {
    const now = 100000 + t * 1000;
    const s = p.step(R, t);
    NetCtl.classify(p.st, s, R, now);
    R = NetCtl.decide(ctl, [{ name: p.name, st: p.st, s }], R, 12000, 1000, now).target;
    t++;
  };
  for (let i = 0; i < 20; i++) tick(); // o teto de envio (~7,4 Mb/s) segura o bitrate
  const before = R;
  R = Math.round(NetCtl.externalCut(ctl, R, 0.8, 100000 + t * 1000));
  const cut = R;
  tick();
  const ok = before > 7000 && cut < before * 0.85 && R <= cut * 1.1;
  if (!ok) failed++;
  console.log(`${ok ? 'ok    ' : 'FALHOU'} corte pedido por quem assiste, com o bitrate já no teto de envio`);
  console.log(`         ${before} kb/s -> corte para ${cut} -> um segundo depois ${R} (não pode voltar para ${before})`);
}

console.log(failed ? `\n${failed} cenário(s) falharam` : '\ntodos os cenários passaram');
process.exit(failed ? 1 : 0);
