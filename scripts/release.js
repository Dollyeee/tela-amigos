// npm run release            -> sobe a versão (patch), compila e publica no GitHub
// npm run release -- minor   -> 1.2.3 -> 1.3.0
// Os apps dos amigos baixam a nova versão sozinhos.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, env) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

const bump = process.argv[2] || 'patch';
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
const skipBump = process.argv.includes('--no-bump');
if (!skipBump) {
  pkg.version = next;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`\n=== Publicando Tela Amigos v${pkg.version} ===\n`);

// o GitHub exige que a tag exista antes de publicar a release
run('git add -A');
run(`git commit -m "v${pkg.version}" --allow-empty`);
run(`git tag -f v${pkg.version}`);
run('git push origin HEAD');
run(`git push -f origin v${pkg.version}`);

const token = out('gh auth token');
run('npm run build:helper');
try {
  run('npx electron-builder --win nsis --publish always', { GH_TOKEN: token });
} catch (e) {
  console.warn('electron-builder reportou erro no envio; conferindo os arquivos da release...');
}

// o upload do instalador (~150 MB) às vezes falha em silêncio: confere e reenvia o que faltar
const tag = `v${pkg.version}`;
const need = ['latest.yml', `TelaAmigos-Setup-${pkg.version}.exe`, `TelaAmigos-Setup-${pkg.version}.exe.blockmap`];
const have = out(`gh release view ${tag} --json assets --jq "[.assets[].name] | join(\\",\\")"`).split(',');
const missing = need.filter((n) => !have.includes(n));
if (missing.length) {
  console.log(`Reenviando: ${missing.join(', ')}`);
  run(`gh release upload ${tag} ${missing.map((n) => `"dist/${n}"`).join(' ')} --clobber`);
}
const final = out(`gh release view ${tag} --json assets --jq "[.assets[].name] | join(\\",\\")"`).split(',');
const still = need.filter((n) => !final.includes(n));
if (still.length) throw new Error(`Release incompleta, faltando: ${still.join(', ')}`);
console.log(`\nPronto! v${pkg.version} publicada. Os amigos recebem a atualização ao abrir o app.\n`);
