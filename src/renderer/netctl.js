// Controle de bitrate da "Nativa direta" (um encoder da placa para todos os amigos).
//
// Antes: um número só para a sala inteira (o maior ping e a maior perda entre todos os amigos,
// comparados com o menor ping já visto) e a estimativa de banda do WebRTC ignorada. Dois defeitos:
//  1. Um pico de ping de UM amigo (Wi-Fi dele, o upload dele cheio, rota trocada) cortava o bitrate
//     de todos pela metade, várias vezes seguidas: nos registros dos amigos a transmissão passava a
//     tarde em 500 kb/s com 150 Mb/s de upload disponíveis.
//  2. O WebRTC só solta os pacotes de uma conexão no ritmo da estimativa de banda DELE (medido: até
//     ~1,03x a estimativa). O que passa disso fica numa fila no envio: o amigo vê a tela com atraso
//     (medido: até ~1,3 s) enquanto a estimativa não alcança o bitrate.
//     (Até a v1.0.57 era pior: essa fila era jogada fora várias vezes por segundo por um defeito da
//      trilha vazia, ver native-video.js, e a tela do amigo ficava em 0 fps "esperando imagem".)
//
// Agora:
//  - TETO: o bitrate nunca passa do que o WebRTC consegue soltar em cada conexão (s.pace, calculado por
//    quem chama a partir da estimativa dele). Vale sempre, na hora, em qualquer caminho.
//  - Cada caminho (cada amigo, e o servidor de vídeo) é avaliado sozinho, a cada segundo, com o ping
//    "normal" DELE (o menor dos últimos 60 s, não o menor da sala desde o início).
//  - Corta de verdade só com evidência de que a IDA está cheia: perda alta, ou duas testemunhas
//    juntas. Testemunhas: perda; atraso; a estimativa do WebRTC (que só mede a ida) abaixo do que
//    estou mandando; o amigo recebendo bem menos do que eu mando (ele avisa); envio ficando para trás.
//  - Só atraso, ou só perda moderada, sem mais nada: espera persistir e faz cortes de TESTE pequenos,
//    com um orçamento (no máximo até metade de onde estava). Se o orçamento acabar e o sinal
//    continuar igual, o problema não é o meu vídeo (volta do caminho, outro tráfego do amigo):
//    ignora esse sinal daquele amigo por um tempo e devolve o bitrate.
//  - Depois de um corte, volta rápido até perto de onde estava e só então sobe devagar.
//  - Se quem derrubou o bitrate foi só o teto (a estimativa do WebRTC recuou, sem mais nenhum sinal),
//    ele volta junto com a estimativa, na hora em que ela voltar.
//
// Sem DOM: as decisões são funções puras sobre o estado guardado em cada caminho (testadas com uma
// rede simulada em scripts/netctl-test.js).
(function (root) {
  'use strict';
  const WINDOW = 60; // amostras (1/s) de ping para achar o "normal" do caminho
  const RANK = { ok: 0, hold: 1, soft: 2, cong: 3, severe: 4 };

  // evidência fraca (só atraso / só perda moderada): run = segundos seguidos; ref = bitrate de
  // referência da janela de cortes de teste; ignoreUntil = até quando esse sinal não conta
  const soft = () => ({ run: 0, seenAt: 0, ref: 0, cutAt: 0, cuts: 0, ignoreUntil: 0, ignoreMs: 60000 });
  function newPath() {
    return { rtts: [], extras: [], base: 0, extra: 0, d: soft(), l: soft(), level: 'ok', why: '', factor: 1, softKind: '', softLimit: 0.5, pace: Infinity };
  }
  // a rota mudou (Radmin <-> internet, ICE reiniciado): o ping normal é outro
  function resetPath(st) {
    st.rtts.length = 0; st.extras.length = 0;
    st.d = soft(); st.l = soft();
    st.level = 'ok'; st.why = ''; st.factor = 1; st.softKind = ''; st.pace = Infinity;
  }
  // o sinal fraco sumiu: zera a contagem; 20 s sem ele = a janela de cortes de teste acabou
  function softIdle(k, now) { k.run = 0; if (k.ref && now - k.seenAt > 20000) { k.ref = 0; k.cuts = 0; } }

  // Quanto dá para mandar de vídeo por uma conexão sem formar fila no envio (= atraso): a estimativa
  // do WebRTC menos uma folga (cabeçalhos, áudio, reenvios) e menos o que a câmera/2ª tela já usam nela.
  function paceOf(bweKbps, othersKbps) {
    return bweKbps > 0 ? Math.max(300, bweKbps * 0.92 - (othersKbps || 0)) : Infinity;
  }

  // Um segundo de um caminho.
  //   s = { loss: fração perdida (0..1), rtt: ida e volta em s (0 = não sei), bwe: estimativa de banda
  //         do WebRTC em kb/s (0/null = não sei), bweFloor: piso combinado da estimativa (kb/s),
  //         pace: teto de envio desta conexão em kb/s (paceOf; 0 = não sei),
  //         rx: o que o amigo diz que recebe / o que eu mando (null = ele não avisa),
  //         flush: vezes que o envio ficou para trás, vpn: caminho por VPN (estimativa não confiável
  //         como testemunha: lá ela costuma ficar baixa sem a rede estar cheia) }
  //   R = bitrate que estou mandando (kb/s)
  // Guarda em st: level ('ok' | 'hold' | 'soft' | 'cong' | 'severe'), why, factor (corte sugerido).
  function classify(st, s, R, now) {
    const rtt = s.rtt > 0 ? s.rtt : 0;
    if (rtt > 0) { st.rtts.push(rtt); if (st.rtts.length > WINDOW) st.rtts.shift(); }
    const base = st.rtts.length ? Math.min.apply(null, st.rtts) : 0;
    const extra = rtt > 0 ? rtt - base : 0;
    st.extras.push(extra); if (st.extras.length > 4) st.extras.shift();
    const old = st.extras[0]; // ~3 s atrás
    st.base = base; st.extra = extra;
    st.pace = s.pace > 0 ? s.pace : Infinity;
    const loss = s.loss > 0 ? s.loss : 0;
    const L = loss > 0.02, LL = loss > 0.10;
    const D = extra > Math.max(0.08, base * 0.6);
    const DD = extra > Math.max(0.3, base * 2);
    const bwe = !s.vpn && s.bwe > 0 ? s.bwe : 0;
    const B = bwe > 0 && bwe < (R + 200) * 0.9;                 // o WebRTC acabou de recuar: acha que não cabe
    const free = bwe > 0 && !B && bwe > (s.bweFloor || 0) * 1.1; // estimativa folgada (e não presa no piso)
    const rx = typeof s.rx === 'number' ? s.rx : null;
    const short = rx != null && rx < 0.8;                       // o amigo recebe bem menos do que mando
    const fine = rx != null && rx >= 0.93;                      // ele recebe tudo o que mando
    const W = B || short;                                       // testemunha de que a IDA não dá conta
    const F = (s.flush || 0) > 0;
    const dTxt = `atraso +${Math.round(extra * 1000)} ms`, lTxt = `perda ${Math.round(loss * 100)}%`;
    const wTxt = B ? `banda estimada ${Math.round(bwe)} kb/s` : `ele recebe ${Math.round((rx || 0) * 100)}% do que mando`;
    let level = 'ok', why = '', factor = 1;
    st.softKind = '';
    if (LL) { level = 'severe'; why = lTxt; factor = Math.max(0.6, 1 - 1.5 * loss); }
    else if (F && (L || D || W)) { level = 'severe'; why = `envio ficou para trás (${L ? lTxt : D ? dTxt : wTxt})`; factor = 0.6; }
    else if (L && (D || W)) { level = 'cong'; why = `${lTxt} e ${D ? dTxt : wTxt}`; factor = 0.8; }
    else if (D && W) { level = DD ? 'severe' : 'cong'; why = `${dTxt} e ${wTxt}`; factor = DD ? 0.6 : 0.8; }
    else if (D) {
      const k = st.d;
      if (now < k.ignoreUntil) why = `${dTxt} (ignorado: não melhora cortando)`;
      else if (free) {
        // a estimativa do WebRTC (que mede só a IDA) está folgada: a fila está na volta do caminho
        // ou foi um soluço do amigo. Segura um pouco sem cortar; se continuar assim, nem segura.
        k.run++;
        if (k.run < 6) level = 'hold';
        why = `${dTxt} (ida livre)`;
      } else {
        k.run++; k.seenAt = now;
        st.softLimit = fine ? 0.7 : 0.5;
        const hist = st.extras.length >= 4;
        const grow = hist && extra - old > Math.max(0.03, old * 0.25);
        const shrink = hist && old - extra > Math.max(0.02, old * 0.15);
        if (k.run < (DD ? 2 : 3)) { level = 'hold'; why = dTxt; }
        else if (shrink) { level = 'hold'; why = `${dTxt}, caindo`; }                 // fila esvaziando: espera
        else { level = 'soft'; why = grow ? `${dTxt}, subindo` : dTxt; factor = DD || grow ? 0.8 : 0.85; st.softKind = 'd'; }
      }
    } else if (L) {
      const k = st.l;
      if (now < k.ignoreUntil) why = `${lTxt} (ignorada: não melhora cortando)`;
      else {
        k.run++; k.seenAt = now;
        st.softLimit = 0.6;
        if (k.run < 4) { level = 'hold'; why = lTxt; }
        else { level = 'soft'; why = `${lTxt} há ${k.run} s`; factor = 0.9; st.softKind = 'l'; }
      }
    } else if (F || short) { level = 'hold'; why = F ? 'envio ficou para trás' : wTxt; }
    // (só a estimativa do WebRTC abaixo do que mando, sem mais nada: o teto de envio em decide() já
    //  traz o bitrate para baixo dela; não precisa de corte nem de espera)
    if (!D) softIdle(st.d, now);
    if (!L || LL) softIdle(st.l, now);
    st.level = level; st.why = why; st.factor = factor; st.B = B; st.loss = loss; st.bwe = bwe;
    return level;
  }

  // paceFrom/paceAt = de onde o bitrate caiu só por causa do teto de envio (sem evidência de rede cheia)
  function newCtl() { return { lastCut: 0, recoverTo: 0, recoverAt: 0, ceil: 0, ceilAt: 0, troubleAt: 0, paceFrom: 0, paceAt: 0 }; }

  function markCut(ctl, R, now) {
    // para onde voltar rápido: perto de onde estava no 1º corte; cortou de novo no meio da volta = o teto é mais baixo
    ctl.recoverTo = !ctl.recoverTo || now - ctl.lastCut > 10000 ? R * 0.85 : Math.min(ctl.recoverTo, R * 0.85);
    ctl.recoverAt = now;
    ctl.ceil = R; ctl.ceilAt = now;
    ctl.lastCut = now;
  }

  // Junta os caminhos (já classificados neste segundo) numa decisão para o encoder único.
  //   paths = [{ name, st, s, stale }];  R = bitrate atual;  max/min = limites (kb/s)
  // Devolve { target, level, why, did ('' | 'severe' | 'cong' | 'soft' | 'pace'), notes: [mensagens para o registro],
  //           pace: teto de envio (kb/s) }.
  function decide(ctl, paths, R, max, min, now) {
    let worst = 'ok', lead = null, factor = 1, bweB = Infinity, pace = Infinity, paceBy = null;
    // stale = sem relatório novo de quem recebe desde a última decisão: a mesma evidência não corta
    // duas vezes (só segura)
    const levelOf = (p) => (p.stale && RANK[p.st.level] > RANK.hold ? 'hold' : p.st.level);
    for (const p of paths) {
      const st = p.st, lv = levelOf(p);
      if (RANK[lv] > RANK[worst] || (lv === worst && lead && st.factor < factor)) { worst = lv; lead = p; factor = st.factor; }
      if (st.B && st.bwe > 0 && RANK[lv] >= RANK.cong) bweB = Math.min(bweB, st.bwe);
      if (st.pace < pace) { pace = st.pace; paceBy = p; }
    }
    const notes = [];
    const rtt = lead && lead.s.rtt > 0 ? lead.s.rtt : 0;
    const gapOk = (ms) => now - ctl.lastCut >= ms;
    let target = R, did = '';
    if (worst === 'severe') {
      if (gapOk(Math.max(1000, Math.min(3000, rtt * 1000)))) { target = R * factor; did = 'severe'; }
    } else if (worst === 'cong') {
      // depois de um corte o atraso demora a baixar (a fila precisa esvaziar): espera antes do próximo
      if (gapOk(Math.min(3000, Math.max(2000, rtt * 2000)))) {
        target = R * factor;
        if (isFinite(bweB)) target = Math.max(R * 0.6, Math.min(R * 0.9, bweB * 0.92)); // direto para o que o WebRTC estima
        did = 'cong';
      }
    } else if (worst === 'soft') {
      let f = 1;
      const due = [];
      for (const p of paths) {
        const st = p.st;
        if (levelOf(p) !== 'soft') continue;
        const k = st[st.softKind];
        if (!k.ref) k.ref = R;
        if (R * st.factor < k.ref * st.softLimit) {
          // orçamento de cortes de teste esgotado e o sinal continua igual: não é o meu vídeo que
          // enche esse caminho. Ignora o sinal por um tempo e devolve o bitrate.
          if (now - k.cutAt >= 6000) {
            k.ignoreUntil = now + k.ignoreMs;
            notes.push(`${p.name}: ${st.softKind === 'd' ? 'o atraso' : 'a perda'} não melhora cortando o bitrate; ignorando por ${Math.round(k.ignoreMs / 1000)} s`);
            k.ignoreMs = Math.min(300000, k.ignoreMs * 2);
            if (k.ref > (ctl.recoverTo || 0)) ctl.recoverTo = k.ref;
            ctl.recoverAt = now;
            k.ref = 0; k.cuts = 0; k.run = 0;
          }
          continue;
        }
        if (now - k.cutAt >= 3000) { due.push(p); f = Math.min(f, st.factor); }
      }
      if (due.length && gapOk(2000)) {
        for (const p of due) { const k = p.st[p.st.softKind]; k.cuts++; k.cutAt = now; }
        target = R * f; did = 'soft';
        if (!lead || levelOf(lead) !== 'soft') lead = due[0];
      }
    }
    if (worst !== 'ok') ctl.troubleAt = now;
    if (did) { markCut(ctl, R, now); ctl.paceFrom = 0; } // corte com evidência: a volta é a normal, devagar
    else if (worst === 'ok' && gapOk(3000)) {
      // (a menos de 3% do ponto de volta já vale a subida normal: um passo minúsculo não chega a ser aplicado)
      if (ctl.recoverTo && R < ctl.recoverTo * 0.97 && now - ctl.recoverAt < 120000) target = Math.min(ctl.recoverTo, R * 1.15 + 150);
      else {
        ctl.recoverTo = 0;
        // em volta de onde a rede reclamou há pouco: devagar. Passou disso sem reclamação, ou está
        // tudo limpo há um bom tempo: mais rápido (a rede melhorou)
        const near = ctl.ceil && R > ctl.ceil * 0.85 && R < ctl.ceil * 1.15 && now - ctl.ceilAt < 120000;
        const clean = now - (ctl.troubleAt || 0) > 15000;
        target = R * (near ? 1.02 : clean ? 1.1 : 1.06) + 100;
      }
    }
    // Caiu só por causa do teto de envio (a estimativa do WebRTC recuou; nenhuma outra testemunha de
    // rede cheia): quando a estimativa volta, o bitrate volta com ela, sem esperar nem subir aos poucos
    // (o teto logo abaixo continua valendo a cada passo).
    // (não expira com o tempo: a tela pode ficar parada por minutos com a estimativa lá embaixo; um
    //  corte com evidência, acima, é o que cancela)
    if (ctl.paceFrom && !did && worst === 'ok') {
      if (R >= ctl.paceFrom * 0.97) ctl.paceFrom = 0;
      else target = Math.max(target, ctl.paceFrom);
    }
    // TETO de envio: nunca acima do que o WebRTC solta na conexão mais apertada (o que passa disso
    // vira fila no envio = atraso na tela daquele amigo). Vale em qualquer situação, sem esperar.
    let why = lead ? `${lead.name}: ${lead.st.why}` : '';
    if (target > pace) {
      target = pace;
      if (R > pace * 1.03 && !did) {
        // a estimativa caiu abaixo do que eu mandava: desce junto (e volta junto quando ela subir)
        did = 'pace';
        why = `${paceBy.name}: o WebRTC só solta ${Math.round(pace)} kb/s nessa conexão`;
        ctl.recoverTo = Math.max(ctl.recoverTo || 0, R * 0.85); ctl.recoverAt = now;
        ctl.paceFrom = Math.max(ctl.paceFrom || 0, R); ctl.paceAt = now;
      }
    }
    target = Math.round(Math.max(min, Math.min(max, target)));
    return { target, level: worst, why, did, notes, pace };
  }

  // corte pedido por fora (ex.: quem recebe pelo servidor de vídeo reclamou). É um corte com
  // evidência: esquece o "de onde caiu só pelo teto de envio" (senão a decisão seguinte voltava
  // direto para lá e desfazia o corte um segundo depois).
  function externalCut(ctl, R, f, now) { markCut(ctl, R, now); ctl.paceFrom = 0; return R * f; }

  const api = { newPath, resetPath, classify, newCtl, decide, externalCut, paceOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetCtl = api;
})(typeof window !== 'undefined' ? window : globalThis);
