// Capturas das janelas que ficam por cima do monitor de quem transmite (mãozinha, desenhos e emotes dos amigos),
// no desenho de cada tema, SEM mostrar nada na tela: as páginas abrem em janelas escondidas, recebem as mesmas
// mensagens que o app manda e são fotografadas. Não abre o app, não usa som, rede nem a placa de vídeo.
//   node_modules/electron/dist/electron.exe scripts/fx-shots.js [tema ...]      (sem nome: classico arena varanda neon)
// Saída: design/capturas/<tema>-15-no-monitor.png e <tema>-16-maozinha-no-monitor.png
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'design', 'capturas');
const themes = process.argv.slice(2).filter((a) => !a.startsWith('-'));
app.setPath('userData', path.join(os.tmpdir(), 'tela-amigos-fx-perfil'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // as janelas abrem e fecham uma a uma: o teste só termina no fim
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(file, w, h) {
  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true, frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'pointer-preload.js'), offscreen: true },
  });
  win.webContents.on('console-message', (e) => { if (/error/i.test(e.message)) console.log('[page]', e.message); });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', file));
  // fundo de "jogo" só para dar para ver (a janela de verdade é transparente) e tudo parado para a foto
  await win.webContents.insertCSS('html { background: linear-gradient(135deg, #1b3644, #0f1c26) !important; } *, *::before, *::after { animation: none !important; transition: none !important; }');
  return win;
}
const snap = async (win, name) => {
  await sleep(350);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('  captura', name);
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = themes.length ? themes : ['classico', 'arena', 'varanda', 'neon'];
  const color = (h) => `hsl(${h}, 85%, 55%)`;
  for (const theme of list) {
    // a janela do tamanho do monitor: riscos da caneta, rastro e emotes
    const big = await page('pointer.html', 960, 540);
    const send = (p) => big.webContents.send('pointer', { ...p, theme });
    const wave = (y) => Array.from({ length: 44 }, (_, i) => [0.08 + i * 0.011, y + Math.sin(i / 3) * 0.06, 0.08 + (i + 1) * 0.011, y + Math.sin((i + 1) / 3) * 0.06]);
    send({ inkSegs: wave(0.3), color: color(300), life: 60000, id: 'a' });
    send({ inkSegs: [[0.66, 0.2, 0.84, 0.2], [0.84, 0.2, 0.84, 0.46], [0.84, 0.46, 0.66, 0.46], [0.66, 0.46, 0.66, 0.2]], color: color(160), life: 60000, id: 'b' });
    for (let i = 0; i < 26; i++) send({ trailOnly: true, drawing: true, id: 'c', x: 0.2 + i * 0.012, y: 0.72 - Math.sin(i / 4) * 0.08, color: color(40), name: 'Léo' });
    for (const [i, e] of ['😂', '🔥', '👍', '😮', '💀', '❤️'].entries()) send({ react: e, name: i % 2 ? 'Léo' : 'Rafa', color: color(i % 2 ? 250 : 300) });
    await sleep(150);
    // na janela de verdade os emotes sobem pelo canto direito, um por cima do outro: lado a lado só para a foto
    await big.webContents.executeJavaScript("document.querySelectorAll('.emote').forEach((el, i) => { el.style.right = (3 + (5 - i) * 15.5) + '%'; }); 0");
    await snap(big, `${theme}-15-no-monitor.png`);
    big.destroy();

    // a janelinha que acompanha a mão
    const small = await page('hand.html', 240, 120);
    small.webContents.send('pointer', { id: 'a', x: 0.5, y: 0.5, color: color(300), name: 'Rafa', press: true, theme });
    await snap(small, `${theme}-16-maozinha-no-monitor.png`);
    small.destroy();
  }
  console.log('capturas em', OUT);
  app.quit();
}).catch((e) => { console.error('ERRO', e); app.exit(1); });
