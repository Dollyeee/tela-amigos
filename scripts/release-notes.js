// Texto de cada versão na página de releases do GitHub, tirado das Novidades (src/renderer/changelog.js): o mesmo
// que os amigos leem no app. O scripts/release.js usa ao publicar.
//   node scripts/release-notes.js 1.0.70        mostra o texto da 1.0.70
//   node scripts/release-notes.js --atualizar   reescreve no GitHub o texto de todas as versões que têm Novidades
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = require('../src/renderer/changelog.js');

function notesFor(v) {
  const e = LOG.find((x) => x.v === v);
  const install = `**Para instalar:** baixe o \`TelaAmigos-Setup-${v}.exe\` aqui embaixo, em *Assets*, e abra. Quem já tem o app recebe esta versão sozinho.`;
  if (!e) return `Tela Amigos ${v}\n\n---\n${install}\n`;
  const out = [`## ${e.title}`, ''];
  if (e.text) out.push(e.text, '');
  // as Novidades com a galeria de temas falam "aqui embaixo": no GitHub vai a imagem da tela de temas
  if (e.themes) out.push('![A tela de escolher tema](https://raw.githubusercontent.com/Dollyeee/tela-amigos/main/docs/img/temas.png)', '');
  for (const it of e.items || []) out.push(`- ${it}`);
  if ((e.items || []).length) out.push('');
  out.push('---', install, '');
  return out.join('\n');
}

// grava num arquivo temporário (o texto tem aspas e quebras de linha: vai por --notes-file)
function notesFile(v) {
  const f = path.join(os.tmpdir(), `tela-amigos-notas-${v}.md`);
  fs.writeFileSync(f, notesFor(v));
  return f;
}

module.exports = { notesFor, notesFile };

if (require.main === module) {
  if (process.argv.includes('--atualizar')) {
    for (const e of LOG) {
      try {
        execFileSync('gh', ['release', 'edit', `v${e.v}`, '--notes-file', notesFile(e.v)], { stdio: ['ignore', 'ignore', 'pipe'] });
        console.log(`v${e.v}: ok`);
      } catch (err) {
        console.log(`v${e.v}: não deu (${String(err.stderr || err.message).trim().split('\n')[0]})`);
      }
    }
  } else {
    const v = process.argv[2] || require('../package.json').version;
    process.stdout.write(notesFor(v));
  }
}
