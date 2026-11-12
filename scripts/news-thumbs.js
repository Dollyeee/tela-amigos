// Miniaturas dos temas para a tela de novidades (src/renderer/news/tema-<id>.jpg), feitas das capturas da sala
// de cada tema que o theme-shots grava (janela escondida, amigos de mentira):
//   node scripts/theme-shots.js --size=1040x650 --prefix=mini- --cenas=2-sala-foco
//   node_modules/electron/dist/electron.exe scripts/news-thumbs.js
// Rodar de novo quando um tema mudar de cara ou entrar um tema novo.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'design', 'capturas');
const OUT = path.join(ROOT, 'src', 'renderer', 'news');
const W = 480, H = 300; // o dobro do tamanho em que aparecem (telas de escala 150% e 200% continuam nítidas)

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'themes.js'), 'utf8');
  const ids = [...src.matchAll(/\bid: '([a-z0-9-]+)', name:/g)].map((m) => m[1]);
  fs.mkdirSync(OUT, { recursive: true });
  let missing = 0;
  for (const id of ids) {
    const file = path.join(SRC, `mini-${id}-2-sala-foco.png`);
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) { console.log(`FALTA a captura de ${id}: ${file}`); missing++; continue; }
    const jpg = img.resize({ width: W, height: H, quality: 'best' }).toJPEG(86);
    fs.writeFileSync(path.join(OUT, `tema-${id}.jpg`), jpg);
    console.log(`${id}: ${Math.round(jpg.length / 1024)} KB`);
  }
  console.log(missing ? `faltaram ${missing}` : `${ids.length} miniaturas em ${OUT}`);
  app.exit(missing ? 1 : 0);
});
