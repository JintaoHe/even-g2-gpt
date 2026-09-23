import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readConversationStartupConfig } from '../src/conversation-startup-config.js';

test('startup configuration is fail-closed and defaults test controls off', () => {
  const value = readConversationStartupConfig({});
  assert.equal(value.resumeWindowMs, 15 * 60_000);
  assert.deepEqual(value.localTestControls, { read: false, write: false });
  assert.equal(value.maintenance.retentionDays, 1095);
  assert.equal(value.historyRecallEnabled, true);
});

test('production owner recall requires explicit acceptance, including default-on and old systemd units', () => {
  for (const deployment of [{ NODE_ENV: 'production' }, { NODE_ENV: ' Production ' },
    { INVOCATION_ID: 'systemd-invocation' }, { INVOCATION_ID: '' },
    { NODE_ENV: 'development', INVOCATION_ID: 'systemd-invocation' }]) {
    for (const flag of [undefined, 'true']) {
      for (const acceptance of [undefined, '', 'false', 'TRUE', ' true ', '1', 'yes']) {
        assert.throws(() => readConversationStartupConfig({ ...deployment,
          EVEN_HISTORY_RECALL_ENABLED: flag, EVEN_HISTORY_RECALL_LATENCY_ACCEPTED: acceptance }),
        /HISTORY_RECALL_PRODUCTION_GATE.*EVEN_HISTORY_RECALL_ENABLED=false/);
      }
      assert.equal(readConversationStartupConfig({ ...deployment,
        EVEN_HISTORY_RECALL_ENABLED: flag, EVEN_HISTORY_RECALL_LATENCY_ACCEPTED: 'true' }).historyRecallEnabled, true);
    }
    assert.equal(readConversationStartupConfig({ ...deployment,
      EVEN_HISTORY_RECALL_ENABLED: 'false' }).historyRecallEnabled, false);
  }
});

test('acceptance cannot override disabled recall; local defaults are unchanged', () => {
  for (const flag of ['false', '', 'garbage', 'TRUE']) {
    assert.equal(readConversationStartupConfig({ NODE_ENV: 'production',
      EVEN_HISTORY_RECALL_ENABLED: flag, EVEN_HISTORY_RECALL_LATENCY_ACCEPTED: 'true' }).historyRecallEnabled, false);
  }
  assert.equal(readConversationStartupConfig({ NODE_ENV: 'development' }).historyRecallEnabled, true);
});

test('deployment marks production and startup validates before any persistent store or provider setup', async () => {
  const unit = await readFile(new URL('../deploy/even-agent.service', import.meta.url), 'utf8');
  assert.match(unit, /^Environment=NODE_ENV=production$/m);
  const source = await readFile(new URL('../src/conversation-server.ts', import.meta.url), 'utf8');
  const entry = source.slice(source.indexOf('if (process.argv[1]'));
  const gate = entry.indexOf('readConversationStartupConfig(process.env)');
  assert.ok(gate >= 0);
  for (const operation of ['createMailSender()', 'CostLedger.create(', 'createDialogueProvider(',
    'createSttProvider(', 'JobStore.create(', 'ConversationStore.create(']) {
    assert.ok(entry.indexOf(operation) > gate, operation);
  }
  assert.match(entry, /historyRecallEnabled: startup.historyRecallEnabled/);
});

test('write test controls require an explicit read-control opt-in', () => {
  assert.throws(() => readConversationStartupConfig({ EVEN_LOCAL_TEST_WRITE_CONTROLS: 'true' }), /requires/i);
  assert.throws(() => readConversationStartupConfig({ EVEN_LOCAL_TEST_CONTROLS: 'yes' }), /true or false/i);
  assert.deepEqual(readConversationStartupConfig({
    EVEN_LOCAL_TEST_CONTROLS: 'true', EVEN_LOCAL_TEST_WRITE_CONTROLS: 'true',
  }).localTestControls, { read: true, write: true });
});

test('all migration-sensitive maintenance values are parsed together', () => {
  assert.throws(() => readConversationStartupConfig({ SESSION_RETENTION_DAYS: 'bad' }), /SESSION_RETENTION_DAYS/);
  assert.throws(() => readConversationStartupConfig({ SESSION_DATABASE_WARNING_MB: '1.5' }), /SESSION_DATABASE_WARNING_MB/);
  assert.throws(() => readConversationStartupConfig({ SESSION_DISK_FREE_WARNING_MB: '0' }), /SESSION_DISK_FREE_WARNING_MB/);
  assert.throws(() => readConversationStartupConfig({ SESSION_RESUME_WINDOW_MINUTES: '16' }), /SESSION_RESUME_WINDOW_MINUTES/);
});
