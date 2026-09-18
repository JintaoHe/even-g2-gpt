import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const updateScript = await readFile(new URL('../deploy/even-agent-update.sh', import.meta.url), 'utf8');
const updateService = await readFile(new URL('../deploy/even-agent-update.service', import.meta.url), 'utf8');
const updateTimer = await readFile(new URL('../deploy/even-agent-update.timer', import.meta.url), 'utf8');
const runtimeService = await readFile(new URL('../deploy/even-agent.service', import.meta.url), 'utf8');

test('automatic updater follows only protected main and builds without service secrets', () => {
  assert.match(updateScript, /readonly UPDATE_BRANCH='main'/);
  assert.match(updateScript, /runuser -u "\$\{UPDATE_USER\}" -- env -i/);
  assert.match(updateScript, /npm --prefix "\$\{build_dir\}" test/);
  assert.match(updateScript, /run audit:public -- --worktree/);
  assert.match(updateScript, /ci --ignore-scripts/);
  assert.doesNotMatch(updateScript, /\/etc\/even-agent\.env/);
});

test('automatic updater uses an atomic release link and rollback health gate', () => {
  assert.match(runtimeService, /WorkingDirectory=\/opt\/even-agent\/current/);
  assert.match(runtimeService, /\/opt\/even-agent\/current\/src\/conversation-server\.js/);
  assert.match(updateScript, /mv -Tf "\$\{temporary_link\}" "\$\{CURRENT_LINK\}"/);
  assert.match(updateScript, /curl .*127\.0\.0\.1:3001/);
  assert.match(updateScript, /rolled back to/);
});

test('automatic updater is periodic, persistent, serialized, and filesystem constrained', () => {
  assert.match(updateTimer, /OnUnitActiveSec=6h/);
  assert.match(updateTimer, /RandomizedDelaySec=30min/);
  assert.match(updateTimer, /Persistent=true/);
  assert.match(updateScript, /flock -n 9/);
  assert.match(updateService, /ProtectSystem=strict/);
  assert.match(updateService, /ReadWritePaths=\/opt\/even-agent \/var\/lib\/even-agent-updater \/run\/lock/);
});
