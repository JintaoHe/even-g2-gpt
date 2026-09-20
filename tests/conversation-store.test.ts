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
    journalMode: 'wal', synchronous: 2, foreignKeys: true, busyTimeoutMs: 5000, schemaVersion: 1,
  });
  await store.close();

  store = await ConversationStore.create(root);
  assert.equal(store.health().schemaVersion, 1);
  await store.close();

  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    assert.deepEqual((db.prepare('SELECT version,name FROM schema_migrations').all() as any[]).map(row => ({ ...row })),
      [{ version: 1, name: 'conversation-foundation' }]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
    for (const table of ['sessions', 'clients', 'resume_credentials', 'topics', 'turns', 'messages', 'session_summaries']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
  } finally { db.close(); }

  if (process.platform !== 'win32') {
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, 'assistant-memory.sqlite'))).mode & 0o777, 0o600);
  }
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
