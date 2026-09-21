import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const deployDirectory = join(root, 'deploy');
const driftScript = await readFile(join(deployDirectory, 'even-agent-drift-check.sh'), 'utf8');

function mappings(): Array<{ installed: string; source: string }> {
  return [...driftScript.matchAll(/^\s*'([^|'\r\n]+)\|([^|'\r\n]+)'\s*$/gm)]
    .map(match => ({ installed: match[1], source: match[2] }));
}

test('every operational drift source exists and every installed target is unique', async () => {
  const entries = mappings();
  assert.equal(entries.length, 16);
  assert.equal(new Set(entries.map(entry => entry.installed)).size, entries.length);
  assert.equal(new Set(entries.map(entry => entry.source)).size, entries.length);

  for (const entry of entries) {
    assert.match(entry.installed, /^\/(?:usr\/local\/sbin|etc)\//);
    assert.match(entry.source, /^deploy\//);
    assert.equal((await stat(join(root, entry.source))).isFile(), true, entry.source);
  }
});

test('every installable top-level deploy artifact is governed by the drift map', async () => {
  const installable = (await readdir(deployDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name === 'Caddyfile' || /\.(?:sh|service|timer|conf)$/.test(name))
    .map(name => `deploy/${name}`)
    .sort();
  const governed = mappings().map(entry => entry.source).sort();

  assert.deepEqual(governed, installable);
});

test('drift checker distinguishes mismatch and missing release sources', () => {
  assert.match(driftScript, /printf 'DRIFT %s != %s\\n'/);
  assert.match(driftScript, /printf 'SOURCE_MISSING %s\\n'/);
  assert.match(driftScript, /source_missing[\s\S]*exit 2/);
  assert.match(driftScript, /drift_found[\s\S]*exit 1/);
  assert.match(driftScript, /cmp -s --/);
  assert.doesNotMatch(driftScript, /\b(?:cp|install|mv|rm|chmod|chown)\b/);
});

test('drift checker returns 0, 1 and 2 for match, drift and missing source', async t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const temporary = await mkdtemp(join(tmpdir(), 'even-agent-drift-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const currentRoot = join(temporary, 'current');
  const installedRoot = join(temporary, 'installed');
  const normalize = (value: string) => value.replaceAll('\\', '/');

  for (const entry of mappings()) {
    const source = join(currentRoot, entry.source);
    const installed = join(installedRoot, entry.installed.slice(1));
    await mkdir(dirname(source), { recursive: true });
    await mkdir(dirname(installed), { recursive: true });
    await writeFile(source, `${entry.source}\n`);
    await writeFile(installed, `${entry.source}\n`);
  }

  const run = () => spawnSync(bash, [normalize(join(deployDirectory, 'even-agent-drift-check.sh'))], {
    encoding: 'utf8',
    env: { ...process.env,
      EVEN_AGENT_DRIFT_CURRENT_ROOT: normalize(currentRoot),
      EVEN_AGENT_DRIFT_INSTALLED_ROOT: normalize(installedRoot) }
  });

  const matching = run();
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /OK 16 operational files match the current release/);

  const first = mappings()[0];
  await writeFile(join(installedRoot, first.installed.slice(1)), 'different\n');
  const drifted = run();
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /DRIFT .*even-agent-update != .*deploy\/even-agent-update\.sh/);

  await writeFile(join(installedRoot, first.installed.slice(1)), `${first.source}\n`);
  await unlink(join(currentRoot, first.source));
  const missing = run();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /SOURCE_MISSING .*deploy\/even-agent-update\.sh/);
});
