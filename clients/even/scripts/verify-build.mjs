import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const rootPath = fileURLToPath(root);
const distPath = fileURLToPath(dist);
const allowedExtensions = new Set(['.css', '.gif', '.html', '.ico', '.jpeg', '.jpg', '.js', '.json', '.png', '.svg', '.webp', '.woff', '.woff2']);
const forbiddenNames = /(^|\/)(\.env|dev|tests?|node_modules)(\/|$)|\.(map|pem|key|p12|pfx|sqlite|db)$/i;
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bG2_CLIENT_TOKEN\s*=/,
  /\b(?:OPENAI|GOOGLE|EMAIL)_[A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN)\s*=/
];
const developmentOnlyPatterns = [
  /开发测试\s*·\s*模拟定位/,
  /Des Moines\s*·\s*Downtown/,
  /41\.5868/,
  /developmentLocationPanel/,
  /test\.storage\.(?:seed_expired|cleanup_apply)/,
  /test\.session\.expire/
];

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else output.push(path);
  }
  return output;
}

const manifest = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
if (manifest.entrypoint !== 'index.html') throw new Error('Unexpected manifest entrypoint');
const builtFiles = await files(distPath);
if (!builtFiles.length) throw new Error('Client build is empty');
if (!(await stat(new URL('../dist/index.html', import.meta.url))).isFile()) throw new Error('Client entrypoint is missing');

for (const path of builtFiles) {
  const name = relative(rootPath, path).replaceAll('\\', '/');
  if (forbiddenNames.test(name) || !allowedExtensions.has(extname(path).toLowerCase())) {
    throw new Error(`Unexpected release file: ${name}`);
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new Error(`Possible credential in release file: ${name}`);
  }
  for (const pattern of developmentOnlyPatterns) {
    if (pattern.test(text)) throw new Error(`Development-only location fixture in release file: ${name}`);
  }
}

console.log(`Verified ${builtFiles.length} release files: no debug fixtures, source maps, private keys, or obvious credentials.`);
