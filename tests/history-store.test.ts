import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { DROP_HISTORY_INDEX_SQL } from './history-index-fixture.js';
const owner = { mode: 'owner' as const, ownerScope: 'single-user' }, now = 2_000_000_000_000;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-history-store-'));
  const store = await ConversationStore.create(root), db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  t.after(async () => { db.close(); await store.close(); });
  const session = (scope = owner.ownerScope) => {
    const id = randomUUID(); store.createSession({ id, ownerScope: scope, createdAt: now - 1000 }); return id;
  };
  const put = (id: string, sequence: number, content: string, at = now - 100, status = 'committed', role = 'user') => {
    const messageId = randomUUID();
    db.prepare('INSERT INTO messages(id,session_id,sequence,role,status,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(messageId, id, sequence, role, status, content, at, at); return messageId;
  };
  return { root, store, db, session, put };
}

test('store search enforces scope, status, time, short Chinese and literal wildcard boundaries', async t => {
  const f = await fixture(t), s = f.session();
  f.put(s, 1, '生日讨论 100% a_b'); f.put(s, 2, 'birthday proposal');
  f.put(s, 3, '生日未提交', now - 100, 'streaming');
  f.put(s, 4, '生日未来', now + 1); f.put(s, 5, '生日太旧', now - 91 * 86400000);
  f.put(f.session('second-owner'), 1, '生日私密'); f.put(f.session(`guest:${randomUUID()}`), 1, '生日访客');
  for (const query of ['生日', '%', '_', '100%', 'a_b']) {
    const result = f.store.searchMessages(owner, { query }, now); assert.equal(result.messages.length, 1, JSON.stringify({ query, result }));
    assert.equal(result.messages[0].sessionId, s); assert.equal(result.incomplete, false);
  }
  assert.equal(f.store.searchMessages(owner, { query: 'birthday' }, now).messages.length, 1);
  assert.throws(() => f.store.searchMessages({ mode: 'guest', ownerScope: `guest:${randomUUID()}`, sessionId: s }, { query: '生日' }, now), /DENIED/);
});

test('context independently rejects foreign or missing IDs and returns only committed bounded neighbours', async t => {
  const f = await fixture(t), s = f.session();
  const ids = Array.from({ length: 10 }, (_, i) => f.put(s, i + 1, `note ${i}`, now - 100 + i, i === 4 ? 'interrupted' : 'committed'));
  const rows = f.store.messageContext(owner, { messageId: ids[5] }, now);
  assert.deepEqual(rows.map(x => x.sequence), [2, 3, 4, 6, 7, 8, 9]);
  const foreign = f.put(f.session('different-owner'), 1, 'foreign');
  for (const id of [foreign, randomUUID(), ids[4]]) assert.throws(() => f.store.messageContext(owner, { messageId: id }, now), /UNAVAILABLE/);
  assert.throws(() => f.store.messageContext({ mode: 'guest', ownerScope: `guest:${randomUUID()}`, sessionId: s }, { messageId: ids[5] }, now), /DENIED/);
});

test('search exposes caps instead of silently claiming complete results and bounds excerpts', async t => {
  const f = await fixture(t), s = f.session();
  f.db.exec('BEGIN');
  for (let i = 1; i <= 2001; i++) f.put(s, i, 'short message', now - i);
  f.db.exec('COMMIT');
  const capped = f.store.searchMessages(owner, { query: 'absent' }, now);
  assert.equal(capped.scanned, 2000); assert.equal(capped.incomplete, true); assert.equal(capped.messages.length, 0);
  f.put(s, 2002, '长'.repeat(120000), now);
  const hit = f.store.searchMessages(owner, { query: '长长长', limit: 1 }, now);
  assert.equal(hit.messages[0].content.length, 1200); assert.equal(hit.messages[0].truncated, true);
  for (let i = 0; i < 13; i++) f.put(s, 2003 + i, '大'.repeat(120000), now);
  const byteCap = f.store.searchMessages(owner, { query: 'absent' }, now);
  assert.ok(byteCap.scannedBytes <= 4 * 1024 * 1024); assert.equal(byteCap.incomplete, true);
});

test('search returns at most three session groups, and marks omitted matches', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.put(f.session(), 1, 'orchard meeting', now - i);
  const result = f.store.searchMessages(owner, { query: 'orchard' }, now);
  assert.equal(new Set(result.messages.map(x => x.sessionId)).size, 3); assert.equal(result.incomplete, true);
});

test('v12 migration is atomic, backfills only eligible messages and reopens idempotently', async t => {
  const f = await fixture(t), s = f.session(); f.put(s, 1, 'cedar scheduling');
  f.put(f.session(`guest:${randomUUID()}`), 1, 'cedar private');
  await f.store.close(); f.db.exec(DROP_HISTORY_INDEX_SQL);
  f.db.exec("CREATE TRIGGER fail_v13 BEFORE INSERT ON schema_migrations WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'v13 rollback'); END");
  await assert.rejects(ConversationStore.create(f.root), /v13 rollback/);
  assert.equal((f.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 12);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='history_search_fts'").get(), undefined);
  f.db.exec('DROP TRIGGER fail_v13');
  for (let i = 0; i < 2; i++) {
    const reopened = await ConversationStore.create(f.root);
    try { assert.equal(reopened.health().schemaVersion, 16); assert.equal(reopened.searchMessages(owner, { query: 'cedar' }, now).messages.length, 1); }
    finally { await reopened.close(); }
  }
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 2);
  f.db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
  f.db.exec("INSERT INTO schema_migrations VALUES(17,'future',0)");
  await assert.rejects(ConversationStore.create(f.root), /newer than/);
});
