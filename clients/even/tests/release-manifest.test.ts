import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type Permission = { name: string; whitelist?: string[] };

test('release manifest keeps the reviewed identity, versions and least-privilege permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8')) as {
    package_id: string;
    name: string;
    version: string;
    min_sdk_version: string;
    entrypoint: string;
    permissions: Permission[];
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    dependencies: Record<string, string>;
  };

  assert.equal(manifest.package_id, 'com.eveng2assistant.glassassistant');
  assert.equal(manifest.name, 'Glass Assistant');
  assert.equal(manifest.entrypoint, 'index.html');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.min_sdk_version, packageJson.dependencies['@evenrealities/even_hub_sdk']);
  assert.deepEqual(manifest.permissions.map(permission => permission.name).sort(), [
    'g2-microphone',
    'location',
    'network'
  ]);

  const network = manifest.permissions.find(permission => permission.name === 'network');
  assert.deepEqual(network?.whitelist, [
    'https://calendar.eveng2assistant.com',
    'wss://calendar.eveng2assistant.com'
  ]);
  assert.equal(network?.whitelist?.some(value => value.includes('*') || value.includes('?') || value.includes('#')), false);
});
