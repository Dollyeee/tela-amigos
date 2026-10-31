// Gera dist/latest.yml (o arquivo que o atualizador lê) a partir do instalador da versão atual.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeLatestYml(root, version) {
  const name = `TelaAmigos-Setup-${version}.exe`;
  const file = path.join(root, 'dist', name);
  const data = fs.readFileSync(file);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const yml =
    `version: ${version}\n` +
    `files:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${data.length}\n` +
    `path: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
  fs.writeFileSync(path.join(root, 'dist', 'latest.yml'), yml);
  return { sha512, size: data.length };
}

module.exports = { writeLatestYml };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const version = process.argv[2] || require(path.join(root, 'package.json')).version;
  console.log(writeLatestYml(root, version));
}
