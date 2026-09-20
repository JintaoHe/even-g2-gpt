import assert from 'node:assert/strict';
import test from 'node:test';
import { readConversationStartupConfig } from '../src/conversation-startup-config.js';

test('startup configuration is fail-closed and defaults test controls off', () => {
  const value = readConversationStartupConfig({});
  assert.equal(value.resumeWindowMs, 15 * 60_000);
  assert.deepEqual(value.localTestControls, { read: false, write: false });
  assert.equal(value.maintenance.retentionDays, 1095);
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
