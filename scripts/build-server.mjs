// Build only the server entry point and its imports. Never copy the repository.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
// Unique output prevents stale simulator/test files surviving a previous build.
const output = await mkdtemp(join(root, 'dist', 'server-'));
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
  '-p', join(root, 'tsconfig.server.json'), '--outDir', join(output, 'src')],
  { cwd: root, stdio: 'inherit', shell: false });
if (result.error || result.status !== 0) throw new Error('Server compilation failed; do not deploy this incomplete directory');
for (const path of ['src/codex-instructions.md', 'src/codex-intent.schema.json', 'package-lock.json',
  'deploy/even-agent.service', 'deploy/even-agent-update.sh', 'deploy/even-agent-update.service', 'deploy/even-agent-update.timer',
  'deploy/even-agent-healthcheck.sh', 'deploy/even-agent-healthcheck.service', 'deploy/even-agent-healthcheck.timer',
  'deploy/even-agent-health-failure@.service', 'deploy/even-agent-backup.sh', 'deploy/even-agent-backup.service',
  'deploy/even-agent-backup.timer', 'deploy/even-agent-restore-check.sh', 'deploy/even-agent-journald.conf',
  'deploy/verify-backup.mjs', 'deploy/Caddyfile', 'deploy/site/calendar/index.html', 'deploy/site/calendar/privacy.html']) {
  await mkdir(dirname(join(output, path)), { recursive: true });
  await copyFile(join(root, path), join(output, path));
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// Keep dependency metadata aligned with the lockfile; install with --omit=dev.
manifest.scripts = { start: 'node src/conversation-server.js' };
await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
async function list(directory) {
  const paths = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Symlink in server build');
    if (item.isDirectory()) paths.push(...await list(path));
    else paths.push(relative(output, path).replaceAll('\\', '/'));
  }
  return paths.sort();
}
const paths = await list(output);
for (const path of paths) {
  if (!/^(src\/[a-z0-9-]+\.js|src\/codex-instructions\.md|src\/codex-intent\.schema\.json|package(?:-lock)?\.json|deploy\/(even-agent(?:-update|-healthcheck|-backup)?\.(?:sh|service|timer)|even-agent-health-failure@\.service|even-agent-restore-check\.sh|even-agent-journald\.conf|verify-backup\.mjs|Caddyfile|site\/calendar\/(index|privacy)\.html))$/.test(path)) {
    throw new Error(`Unexpected deploy file: ${path}`);
  }
}
await writeFile(join(output, 'BUILD-MANIFEST.json'), JSON.stringify({ files: paths }, null, 2) + '\n');
console.log(`Server-only build: ${output}\nDeploy only this directory. Run npm ci --omit=dev on Linux. No browser lab, SDK, simulator, tests, credentials or local data included.`);
