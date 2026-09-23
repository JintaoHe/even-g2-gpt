import { DROP_HISTORY_INDEX_SQL } from './history-index-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';

async function directory(prefix = 'even-conversation-store-') {
  return mkdtemp(join(tmpdir(), prefix));
}

test('conversation store creates a private WAL database with idempotent migrations', async () => {
  const root = await directory();
  let store = await ConversationStore.create(root);
  const health = store.health();
  assert.deepEqual(health, {
    journalMode: 'wal', synchronous: 2, foreignKeys: true, busyTimeoutMs: 5000, schemaVersion: 14,
  });
  await store.close();

  // Simulate a production database created by PR1 before summary jobs existed.
  const legacy = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  legacy.exec(DROP_HISTORY_INDEX_SQL);
  legacy.exec('DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE summary_recovery_clocks; DROP TABLE summary_jobs; DROP TABLE legacy_session_imports; DROP TABLE device_credentials; DROP TABLE recovery_drafts; ALTER TABLE session_summaries DROP COLUMN source_losses_json; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=2;');
  legacy.close();

  store = await ConversationStore.create(root);
  assert.equal(store.health().schemaVersion, 14);
  await store.close();

  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    assert.deepEqual((db.prepare('SELECT version,name FROM schema_migrations').all() as any[]).map(row => ({ ...row })),
      [{ version: 1, name: 'conversation-foundation' },
        { version: 2, name: 'durable-session-summary-jobs' },
        { version: 3, name: 'legacy-session-import-ledger' },
        { version: 4, name: 'scoped-device-credentials' },
        { version: 5, name: 'durable-recovery-drafts' },
        { version: 6, name: 'bounded-summary-budget-deferrals' },
        { version: 7, name: 'summary-source-losses' },
        { version: 8, name: 'summary-recovery-generations' },
        { version: 9, name: 'closed-summary-recovery-clocks' },
        { version: 10, name: 'durable-device-guest-locks' },
        { version: 11, name: 'durable-device-access-epoch' },
        { version: 12, name: 'session-scoped-guest-drafts' },
        { version: 13, name: 'filtered-history-search' },
        { version: 14, name: 'exact-owner-history-scope' }]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
    for (const table of ['sessions', 'clients', 'resume_credentials', 'topics', 'turns', 'messages', 'session_summaries',
      'summary_jobs', 'legacy_session_imports', 'device_credentials', 'recovery_drafts']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
  } finally { db.close(); }

  if (process.platform !== 'win32') {
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, 'assistant-memory.sqlite'))).mode & 0o777, 0o600);
  }
});

test('recovery drafts are durable, bounded and removed only with a terminal session', async () => {
  const root = await directory(), sessionId = randomUUID(), topicId = randomUUID();
  let store = await ConversationStore.create(root);
  const jobId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  assert.deepEqual(store.putRecoveryDraft({ sessionId, kind: 'delivery', payload: { version: 1, jobId }, at: 110 }), {
    sessionId, kind: 'delivery', payload: { version: 1, jobId }, createdAt: 110, updatedAt: 110,
  });
  const first = store.getRecoveryDraft(sessionId, 'delivery')!;
  store.markSessionDetached(sessionId, 120);
  await store.close();

  store = await ConversationStore.create(root);
  try {
    assert.deepEqual(store.getRecoveryDraft(sessionId, 'delivery'), first);
    store.putRecoveryDraft({ sessionId, kind: 'calendar', payload: { version: 1, draft: { kind: 'create', event: {
      title: 'Recovery test', start: '2026-10-01T09:00-05:00', end: '2026-10-01T10:00-05:00',
      timezone: 'America/Chicago', allDay: false, location: '', notes: '',
    } } }, at: 130 });
    assert.deepEqual(store.listRecoveryDrafts(sessionId).map(item => item.kind), ['calendar', 'delivery']);
    assert.throws(() => store.putRecoveryDraft({ sessionId, kind: 'delivery',
      payload: { version: 1, jobId, approvalToken: 'must-not-persist' }, at: 135 }), /invalid recovery draft/i);
    assert.throws(() => store.putRecoveryDraft({ sessionId, kind: 'delivery',
      payload: { value: 'x'.repeat(300_000) }, at: 140 }), /invalid recovery draft|too large/i);
    store.endSession(sessionId, 150, 'user_exit');
    assert.deepEqual(store.listRecoveryDrafts(sessionId), []);
    assert.throws(() => store.putRecoveryDraft({ sessionId, kind: 'delivery', payload: { version: 1, jobId }, at: 160 }), /unavailable/i);
  } finally { await store.close(); }
});

test('conversation store enforces one live owner and releases ownership on close', async () => {
  const root = await directory();
  const first = await ConversationStore.create(root);
  await assert.rejects(ConversationStore.create(root), /already owned/i);
  await first.close();
  const reopened = await ConversationStore.create(root);
  await reopened.close();
  await reopened.close();
  assert.throws(() => reopened.health(), /closed/i);
});

test('session plus initial topic is atomic and foreign keys remain enabled', async () => {
  const root = await directory(), store = await ConversationStore.create(root);
  const firstSession = randomUUID(), duplicateTopic = randomUUID();
  try {
    const created = store.createSession({
      id: firstSession, ownerScope: 'single-user', createdAt: 1_700_000_000_000,
      initialTopic: { id: duplicateTopic, label: 'first topic' },
    });
    assert.equal(created.id, firstSession);
    assert.equal(store.getSession(firstSession)?.latestSequence, 0);

    const rolledBackSession = randomUUID();
    assert.throws(() => store.createSession({
      id: rolledBackSession, ownerScope: 'single-user', createdAt: 1_700_000_000_001,
      initialTopic: { id: duplicateTopic, label: 'duplicate topic id' },
    }));
    assert.equal(store.getSession(rolledBackSession), undefined);

    const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
    try {
      assert.throws(() => db.prepare("INSERT INTO topics(id,session_id,label,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)")
        .run(randomUUID(), randomUUID(), 'orphan', 1, 1));
    } finally { db.close(); }
  } finally { await store.close(); }
});

test('session lifecycle and topics are durable, monotonic and fail closed after a terminal state', async () => {
  const root = await directory(), store = await ConversationStore.create(root);
  const sessionId = randomUUID(), firstTopic = randomUUID(), secondTopic = randomUUID();
  try {
    store.createSession({
      id: sessionId, ownerScope: 'single-user', createdAt: 100,
      initialTopic: { id: firstTopic, label: 'General' },
    });
    store.ensureTopic({ sessionId, id: secondTopic, label: 'Trip plan', at: 110 });
    store.ensureTopic({ sessionId, id: secondTopic, label: 'Trip plan', at: 111 });
    assert.deepEqual(store.listTopics(sessionId), [
      { id: firstTopic, sessionId, label: 'General', status: 'active', createdAt: 100, updatedAt: 100 },
      { id: secondTopic, sessionId, label: 'Trip plan', status: 'active', createdAt: 110, updatedAt: 111 },
    ]);

    store.markSessionDetached(sessionId, 120);
    assert.deepEqual(store.getSession(sessionId), {
      id: sessionId, ownerScope: 'single-user', status: 'idle', createdAt: 100,
      updatedAt: 120, lastActivityAt: 100, latestSequence: 0, summaryThroughSequence: 0,
    });
    store.markSessionAttached(sessionId, 130);
    assert.equal(store.getSession(sessionId)?.status, 'active');
    assert.equal(store.getSession(sessionId)?.updatedAt, 130);

    store.endSession(sessionId, 140, 'user_exit');
    assert.deepEqual(store.getSession(sessionId), {
      id: sessionId, ownerScope: 'single-user', status: 'ended', createdAt: 100,
      updatedAt: 140, lastActivityAt: 100, endedAt: 140, endReason: 'user_exit',
      latestSequence: 0, summaryThroughSequence: 0,
    });
    assert.throws(() => store.markSessionAttached(sessionId, 150), /unavailable/i);
    assert.throws(() => store.markSessionDetached(sessionId, 150), /unavailable/i);
    assert.throws(() => store.endSession(sessionId, 150, 'again'), /unavailable/i);
  } finally { await store.close(); }
});

test('conversation store rejects a symlinked data root', async t => {
  const target = await directory('even-conversation-target-');
  const parent = await directory('even-conversation-link-');
  const link = join(parent, 'linked-data');
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error: any) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip('symlink creation is unavailable'); return; }
    throw error;
  }
  await assert.rejects(ConversationStore.create(link), /symlink/i);
});

test('conversation store rejects a symlinked database file', async t => {
  const root = await directory('even-conversation-db-link-');
  const target = join(root, 'elsewhere.sqlite');
  const link = join(root, 'assistant-memory.sqlite');
  await writeFile(target, 'not a database');
  try { await symlink(target, link, 'file'); }
  catch (error: any) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip('file symlink creation is unavailable'); return; }
    throw error;
  }
  await assert.rejects(ConversationStore.create(root), /symlink/i);
});
