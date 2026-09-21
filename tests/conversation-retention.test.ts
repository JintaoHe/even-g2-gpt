import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';

const DAY = 24 * 60 * 60 * 1000;

async function directory() { return mkdtemp(join(tmpdir(), 'even-retention-')); }

function createSession(store: ConversationStore, createdAt: number, status: 'active' | 'ended' | 'expired' = 'ended',
  ownerScope = 'single-user') {
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope, createdAt,
    initialTopic: { id: topicId, label: 'General' } });
  store.commitUserTurn({ sessionId, topicId, messageId: randomUUID(), turnId: randomUUID(),
    content: 'private transcript marker', createdAt: createdAt + 1 });
  if (status === 'ended') store.endSession(sessionId, createdAt + 2, 'user_exit');
  if (status === 'expired') store.expireSession(sessionId, createdAt + 2);
  return { sessionId, topicId };
}

test('retention is dry-run capable, disabled by zero, and deletes only safely eligible sessions', async () => {
  const root = await directory(), store = await ConversationStore.create(root);
  const now = Date.parse('2026-11-01T07:30:00.000Z'), retentionDays = 1095;
  const cutoff = now - retentionDays * DAY;
  const old = createSession(store, cutoff - 10_000, 'ended');
  const expired = createSession(store, cutoff - 9_000, 'expired');
  const boundary = createSession(store, cutoff - 2, 'ended'); // ended_at is exactly cutoff
  const active = createSession(store, cutoff - 8_000, 'active');
  const blocked = createSession(store, cutoff - 7_000, 'ended');
  store.enqueueSummaryJob({ sessionId: blocked.sessionId, fromSequence: 1, throughSequence: 1, createdAt: cutoff - 6_000 });
  store.claimNextSummaryJob(cutoff - 5_000);

  try {
    const disabled = store.cleanupExpiredSessions({ retentionDays: 0, now, dryRun: false });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.deletedSessions, 0);

    const preview = store.cleanupExpiredSessions({ retentionDays, now, dryRun: true });
    assert.equal(preview.enabled, true);
    assert.equal(preview.cutoffAt, cutoff);
    assert.equal(preview.eligibleSessions, 2);
    assert.equal(preview.eligibleMessages, 2);
    assert.equal(preview.deletedSessions, 0);
    assert.equal(preview.before.sessions, 5);
    assert.equal(preview.after.sessions, 5);
    assert.ok(store.getSession(old.sessionId));

    const applied = store.cleanupExpiredSessions({ retentionDays, now, dryRun: false });
    assert.equal(applied.deletedSessions, 2);
    assert.equal(applied.deletedMessages, 2);
    assert.equal(store.getSession(old.sessionId), undefined);
    assert.equal(store.getSession(expired.sessionId), undefined);
    assert.ok(store.getSession(boundary.sessionId));
    assert.ok(store.getSession(active.sessionId));
    assert.ok(store.getSession(blocked.sessionId));
    assert.equal(applied.after.sessions, 3);
    assert.equal(applied.after.messages, 3);
  } finally { await store.close(); }
});

test('retention uses Unix time across DST and remains valid after service restart', async () => {
  const root = await directory();
  const now = Date.parse('2026-03-08T08:05:00.000Z'); // US DST transition day
  const cutoff = now - 1095 * DAY;
  let store = await ConversationStore.create(root);
  const old = createSession(store, cutoff - 3, 'ended'); // ended_at is cutoff - 1 ms
  const recent = createSession(store, cutoff - 1, 'ended'); // ended_at is cutoff + 1 ms
  await store.close();

  store = await ConversationStore.create(root);
  try {
    const applied = store.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: false });
    assert.equal(applied.deletedSessions, 1);
    assert.equal(store.getSession(old.sessionId), undefined);
    assert.ok(store.getSession(recent.sessionId));
  } finally { await store.close(); }
});

test('retention can be scoped to synthetic simulator records without deleting real history', async () => {
  const root = await directory(), store = await ConversationStore.create(root);
  const now = Date.parse('2026-11-01T07:30:00.000Z'), cutoff = now - 1095 * DAY;
  const real = createSession(store, cutoff - 10_000, 'ended');
  const fixture = createSession(store, cutoff - 9_000, 'ended', 'local-retention-test');
  try {
    const preview = store.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: true,
      ownerScope: 'local-retention-test' });
    assert.equal(preview.eligibleSessions, 1);
    assert.equal(preview.eligibleMessages, 1);

    const applied = store.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: false,
      ownerScope: 'local-retention-test' });
    assert.equal(applied.deletedSessions, 1);
    assert.ok(store.getSession(real.sessionId));
    assert.equal(store.getSession(fixture.sessionId), undefined);
  } finally { await store.close(); }
});

test('storage health reports only counts and capacity warnings, never transcript content', async () => {
  const root = await directory(), store = await ConversationStore.create(root);
  createSession(store, 1_700_000_000_000, 'ended');
  try {
    const health = await store.storageHealth({ databaseWarningBytes: 1, diskFreeWarningBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(health.sessions, 1);
    assert.equal(health.messages, 1);
    assert.ok(health.databaseBytes > 0);
    assert.ok(health.availableDiskBytes >= 0);
    assert.deepEqual(health.warnings.sort(), ['database_size', 'low_disk_space']);
    assert.doesNotMatch(JSON.stringify(health), /private transcript marker/);
  } finally { await store.close(); }
});
