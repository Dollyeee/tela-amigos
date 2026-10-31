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

const tag = `v${pkg.version}`;
run('npm run build:helper');
// só compila; o envio é feito pelo gh (o envio do electron-builder falhava/corria em paralelo)
run('npx electron-builder --win nsis --publish never');

// o latest.yml é o que o atualizador lê: gerado aqui a partir do instalador desta versão
const { writeLatestYml } = require('./latest-yml');
writeLatestYml(root, pkg.version);
const files = ['latest.yml', `TelaAmigos-Setup-${pkg.version}.exe`, `TelaAmigos-Setup-${pkg.version}.exe.blockmap`];

let exists = true;
try { out(`gh release view ${tag} --json name`); } catch { exists = false; }
if (!exists) run(`gh release create ${tag} --title ${pkg.version} --notes "Tela Amigos ${pkg.version}" --latest`);
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    run(`gh release upload ${tag} ${files.map((n) => `"dist/${n}"`).join(' ')} --clobber`);
    break;
  } catch (e) {
    if (attempt === 3) throw e;
    console.warn(`Falha no envio (tentativa ${attempt}), tentando de novo...`);
  }
}

// confere: arquivos presentes e latest.yml apontando para esta versão
const have = out(`gh release view ${tag} --json assets --jq "[.assets[].name] | join(\\",\\")"`).split(',');
const missing = files.filter((n) => !have.includes(n));
if (missing.length) throw new Error(`Release incompleta, faltando: ${missing.join(', ')}`);
const remoteYml = out(`gh release download ${tag} -p latest.yml -O -`);
if (!remoteYml.startsWith(`version: ${pkg.version}`)) throw new Error(`latest.yml no GitHub não é da ${pkg.version}`);
console.log(`\nPronto! v${pkg.version} publicada. Os amigos recebem a atualização ao abrir o app.\n`);
