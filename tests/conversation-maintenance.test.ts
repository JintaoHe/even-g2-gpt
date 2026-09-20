import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConversationMaintenanceConfig, runConversationMaintenance } from '../src/conversation-maintenance.js';
import { ConversationStore } from '../src/conversation-store.js';

test('maintenance config defaults to three years and validates operator overrides', () => {
  assert.deepEqual(readConversationMaintenanceConfig({}), {
    retentionDays: 1095, databaseWarningBytes: 1024 * 1024 * 1024,
    diskFreeWarningBytes: 2048 * 1024 * 1024,
  });
  assert.equal(readConversationMaintenanceConfig({ SESSION_RETENTION_DAYS: '0' }).retentionDays, 0);
  assert.throws(() => readConversationMaintenanceConfig({ SESSION_RETENTION_DAYS: '-1' }), /SESSION_RETENTION_DAYS/);
  assert.throws(() => readConversationMaintenanceConfig({ SESSION_DATABASE_WARNING_MB: '1.5' }), /SESSION_DATABASE_WARNING_MB/);
});

test('maintenance applies retention and emits metadata-only health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-maintenance-'));
  const store = await ConversationStore.create(root);
  const now = 2_000_000_000_000, sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 1,
    initialTopic: { id: topicId, label: 'General' } });
  store.commitUserTurn({ sessionId, topicId, messageId: randomUUID(), turnId: randomUUID(),
    content: 'must never enter maintenance output', createdAt: 2 });
  store.endSession(sessionId, 3, 'user_exit');
  try {
    const preview = await runConversationMaintenance(store, {
      retentionDays: 1095, databaseWarningBytes: Number.MAX_SAFE_INTEGER,
      diskFreeWarningBytes: 1,
    }, now, true);
    assert.equal(preview.retention.eligibleSessions, 1);
    assert.equal(preview.retention.deletedSessions, 0);
    assert.ok(store.getSession(sessionId));
    const result = await runConversationMaintenance(store, {
      retentionDays: 1095, databaseWarningBytes: Number.MAX_SAFE_INTEGER,
      diskFreeWarningBytes: 1,
    }, now, false);
    assert.equal(result.retention.deletedSessions, 1);
    assert.equal(result.storage.sessions, 0);
    assert.doesNotMatch(JSON.stringify(result), /must never enter maintenance output/);
  } finally { await store.close(); }
});
