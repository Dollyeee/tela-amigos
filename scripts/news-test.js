// Confere a tela de novidades sem abrir o app: os textos de cada versão (src/renderer/changelog.js) e a regra de
// "abre uma vez depois de cada atualização" (src/renderer/news.js). Roda em menos de um segundo.
//   node scripts/news-test.js                 confere tudo
//   node scripts/news-test.js --para=1.0.61   e ainda exige que a entrada do topo seja a dessa versão
//                                             (é o que o `npm run release` usa antes de publicar)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const LOG = require(path.join(root, 'src', 'renderer', 'changelog.js'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// o news.js é da página: aqui roda com uma "janela" de mentira só com o que ele usa ao carregar
const win = { CHANGELOG: LOG };
vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'renderer', 'news.js'), 'utf8'), { window: win, document: {}, console });
const { pending, cmp } = win.News;

let failed = 0;
const check = (name, ok, extra) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok    ' : 'FALHOU'} ${name}${extra ? ` [${extra}]` : ''}`);
};
const vs = (list) => list.map((e) => e.v).join(',');

// ---------------------------------------------------------------- os textos
check('há pelo menos uma versão registrada', Array.isArray(LOG) && LOG.length > 0);
const bad = [];
LOG.forEach((e, i) => {
  const where = `entrada ${i + 1} (${e && e.v})`;
  if (!e || !/^\d+\.\d+\.\d+$/.test(e.v || '')) bad.push(`${where}: versão fora do formato 1.2.3`);
  if (!e || typeof e.title !== 'string' || !e.title.trim()) bad.push(`${where}: sem título`);
  if (e && e.items !== undefined && (!Array.isArray(e.items) || e.items.some((s) => typeof s !== 'string' || !s.trim()))) bad.push(`${where}: "items" tem de ser uma lista de frases`);
  if (e && !e.text && !(e.items && e.items.length) && !e.themes) bad.push(`${where}: só o título, sem contar o que mudou`);
  for (const s of [e && e.title, e && e.text, ...((e && Array.isArray(e.items) && e.items) || [])]) {
    if (typeof s === 'string' && (s.split('**').length - 1) % 2) bad.push(`${where}: negrito aberto e não fechado em "${s.slice(0, 40)}..."`);
  }
  if (i > 0 && cmp(LOG[i - 1].v, e.v) <= 0) bad.push(`${where}: fora de ordem (a mais nova vem primeiro, sem repetir)`);
});
check('cada entrada tem versão, título e conteúdo, da mais nova para a mais antiga', !bad.length, bad.join(' | '));
// entre uma publicação e outra o topo é a versão que vem (ou a atual, logo depois de publicar): nunca uma mais antiga
check(`o topo (${LOG[0].v}) não é mais antigo que a versão do app (${pkg.version})`, cmp(LOG[0].v, pkg.version) >= 0);
for (const f of ['changelog.js', 'news.js']) {
  check(`${f} está na página`, fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8').includes(`<script src="${f}"></script>`));
}
// a galeria mostra uma miniatura por tema
const themes = [...fs.readFileSync(path.join(root, 'src', 'renderer', 'themes.js'), 'utf8').matchAll(/\bid: '([a-z0-9-]+)', name:/g)].map((m) => m[1]);
const noThumb = themes.filter((id) => !fs.existsSync(path.join(root, 'src', 'renderer', 'news', `tema-${id}.jpg`)));
check(`miniatura de cada um dos ${themes.length} temas (scripts/news-thumbs.js)`, themes.length > 1 && !noThumb.length, noThumb.join(', '));

// ---------------------------------------------------------------- a regra
const L = [{ v: '1.0.10' }, { v: '1.0.9' }, { v: '1.0.8' }];
check('compara versões pelos números (1.0.10 é mais nova que 1.0.9)', cmp('1.0.10', '1.0.9') > 0 && cmp('1.0.9', '1.0.10') < 0 && cmp('2.0.0', '1.9.9') > 0 && cmp('1.0.9', '1.0.9') === 0);
check('instalação nova: não mostra nada', vs(pending(L, '', '1.0.10', false)) === '');
check('quem já usava o app e nunca viu esta tela: mostra tudo', vs(pending(L, '', '1.0.10', true)) === '1.0.10,1.0.9,1.0.8');
check('mesma versão já vista: não mostra de novo', vs(pending(L, '1.0.10', '1.0.10', true)) === '');
check('atualizou uma versão: só a nova', vs(pending(L, '1.0.9', '1.0.10', true)) === '1.0.10');
check('pulou versões: todas as que não viu, a mais nova primeiro', vs(pending(L, '1.0.7', '1.0.10', true)) === '1.0.10,1.0.9,1.0.8');
check('nunca a novidade de uma versão mais nova que o app', vs(pending(L, '1.0.8', '1.0.9', true)) === '1.0.9' && vs(pending(L, '', '1.0.9', true)) === '1.0.9,1.0.8');
check('versão sem entrada própria: não reabre as antigas', vs(pending(L, '1.0.10', '1.0.11', true)) === '');
check('voltou para uma versão antiga: não mostra nada', vs(pending(L, '1.0.10', '1.0.8', true)) === '');

// ---------------------------------------------------------------- antes de publicar
const para = (process.argv.find((a) => a.startsWith('--para=')) || '').slice(7);
if (para) check(`a entrada do topo é a da versão que vai ser publicada (${para})`, LOG[0].v === para, `topo: ${LOG[0].v}`);

console.log(failed ? `\n${failed} conferência(s) falharam` : '\nnovidades: tudo certo');
process.exit(failed ? 1 : 0);
