import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { mutateMemory } from '../src/memory-store.js';
import { removeForgettingFixture } from './history-index-fixture.js';

const owner = { mode: 'owner' as const, ownerScope: 'single-user' }, at = 10000;
const proposal = { action: 'save', kind: 'preference', content: '我更喜欢可调高度的桌子', key: 'desk:height' };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi4-memory-store-'));
  const store = await ConversationStore.create(root), db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(async () => { db.close(); await store.close(); });
  const session = (scope = owner.ownerScope) => {
    const id = randomUUID(); store.createSession({ id, ownerScope: scope, createdAt: 1 }); return id;
  };
  const user = (sessionId: string, role = 'user', status = 'committed') => {
    const messageId = randomUUID();
    const n = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM messages WHERE session_id=?').get(sessionId) as any).n;
    db.prepare(`INSERT INTO messages(id,session_id,sequence,role,status,content,created_at,updated_at)
      VALUES(?,?,?,?,?,'synthetic explicit request',100,100)`).run(messageId, sessionId, n, role, status);
    return { sessionId, messageId };
  };
  return { root, store, db, session, user };
}

test('save, replace and forget are atomic immutable versions; no product-context side effects', async t => {
  const f = await fixture(t), s = f.session();
  const first = f.store.mutatePersonalMemory(owner, { source: f.user(s), proposal }, at);
  const next = f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId: first.id,
    proposal: { ...proposal, action: 'update', target: '桌子高度', content: '改成固定高度书桌' } }, at + 1);
  assert.notEqual(next.id, first.id);
  const rows = f.db.prepare('SELECT * FROM personal_memories ORDER BY ordinal').all() as any[];
  assert.equal(rows[0].state, 'superseded'); assert.equal(rows[0].superseded_by, next.id);
  assert.equal(rows[0].content, proposal.content); assert.equal(rows[1].lineage_id, rows[0].lineage_id);
  assert.equal(f.store.listPersonalMemories(owner).records[0].content, '改成固定高度书桌');
  f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId: next.id,
    proposal: { action: 'forget', target: '桌子偏好', level: 'memory_only' } }, at + 2);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 3);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM summary_jobs').get() as any).n, 0);
  // Audit contains identifiers/actions only, not copies of retired content.
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM personal_memory_changes').all()), /桌子|书桌/);
});

test('runtime source is checked against real rows: foreign, absent, stale, assistant and inactive fail', async t => {
  const f = await fixture(t), s = f.session(), old = f.user(s), fresh = f.user(s);
  const other = f.user(f.session('other-owner'));
  for (const source of [old, other, { ...fresh, sessionId: randomUUID() },
    { ...fresh, messageId: randomUUID() }, f.user(s, 'assistant'), f.user(s, 'user', 'interrupted')])
    assert.throws(() => f.store.mutatePersonalMemory(owner, { source, proposal }, at));
  for (const state of ['idle', 'ended', 'expired']) {
    f.db.prepare('UPDATE sessions SET status=? WHERE id=?').run(state, s);
    assert.throws(() => f.store.mutatePersonalMemory(owner, { source: fresh, proposal }, at));
  }
  assert.equal(f.store.listPersonalMemories(owner).records.length, 0);
});

test('every storage entry rejects guests before querying and scopes reads, targets and purge', async t => {
  const f = await fixture(t), s = f.session(), source = f.user(s);
  const first = f.store.mutatePersonalMemory(owner, { source, proposal }, at);
  const second = { mode: 'owner' as const, ownerScope: 'guest_room:1' }, source2 = f.user(f.session(second.ownerScope));
  const guest = { mode: 'guest' as const, ownerScope: `guest:${randomUUID()}`, sessionId: randomUUID() };
  assert.throws(() => f.store.mutatePersonalMemory(guest, null as any, at), /GUEST_ACCESS_DENIED/);
  assert.throws(() => f.store.listPersonalMemories(guest, null as any), /GUEST_ACCESS_DENIED/);
  assert.throws(() => f.store.purgePersonalMemories(guest, NaN), /GUEST_ACCESS_DENIED/);
  assert.equal(f.store.listPersonalMemories(second).records.length, 0);
  assert.throws(() => f.store.mutatePersonalMemory(second, { source: source2, targetId: first.id,
    proposal: { action: 'forget', target: '桌子', level: 'memory_only' } }, at), /MEMORY_TARGET_UNAVAILABLE/);
  const own = f.store.mutatePersonalMemory(second, { source: source2, proposal }, at);
  assert.notEqual(own.id, first.id); // identical key is scoped, not globally unique
  assert.equal(f.store.purgePersonalMemories(second, at + 100 * 86400000), 0);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 1);
});

test('one mutation per source survives restart; key conflicts and stale IDs never silently insert', async t => {
  const f = await fixture(t), s = f.session(), source = f.user(s);
  const first = f.store.mutatePersonalMemory(owner, { source, proposal }, at);
  assert.throws(() => f.store.mutatePersonalMemory(owner, { source, proposal }, at), /MEMORY_SOURCE_USED/);
  const fresh = f.user(s);
  assert.throws(() => f.store.mutatePersonalMemory(owner, { source: fresh, proposal }, at), /MEMORY_KEY_CONFLICT/);
  assert.throws(() => f.store.mutatePersonalMemory(owner, { source: fresh, targetId: randomUUID(),
    proposal: { ...proposal, action: 'update', target: '旧桌子' } }, at), /MEMORY_TARGET_UNAVAILABLE/);
  f.store.mutatePersonalMemory(owner, { source: fresh, targetId: first.id,
    proposal: { ...proposal, action: 'update', target: '桌子', content: '换成橡木' } }, at);
  await f.store.close();
  const reopened = await ConversationStore.create(f.root);
  try {
    reopened.markSessionAttached(s, at + 1);
    assert.throws(() => reopened.mutatePersonalMemory(owner, { source: fresh, proposal }, at + 1), /MEMORY_SOURCE_USED/);
    assert.equal(reopened.listPersonalMemories(owner).records[0].content, '换成橡木');
  } finally { await reopened.close(); }
});

test('audit insertion failure rolls back replacement, links, state and source consumption', async t => {
  const f = await fixture(t), s = f.session();
  const first = f.store.mutatePersonalMemory(owner, { source: f.user(s), proposal }, at), fresh = f.user(s);
  const before = f.db.prepare('SELECT * FROM personal_memories').all();
  f.db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON personal_memory_changes BEGIN SELECT RAISE(ABORT,'memory rollback'); END");
  const input = { source: fresh, targetId: first.id, proposal: { ...proposal, action: 'update', target: '桌子', content: '竹桌' } };
  assert.throws(() => f.store.mutatePersonalMemory(owner, input, at + 1), /memory rollback/);
  assert.deepEqual(f.db.prepare('SELECT * FROM personal_memories').all(), before);
  f.db.exec('DROP TRIGGER fail_memory');
  assert.doesNotThrow(() => f.store.mutatePersonalMemory(owner, input, at + 1));
});

test('90-day cleanup is exact, bounded and retains minimal provenance without blocking replacement chains', async t => {
  const f = await fixture(t), s = f.session();
  const first = f.store.mutatePersonalMemory(owner, { source: f.user(s), proposal }, at);
  const second = f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId: first.id,
    proposal: { ...proposal, action: 'update', target: '桌子', content: '竹桌' } }, at + 1);
  f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId: second.id,
    proposal: { action: 'forget', target: '桌子', level: 'memory_only' } }, at + 2);
  const ninety = 90 * 86400000;
  assert.equal(f.store.purgePersonalMemories(owner, at + 30 * 86400000 + 2), 0);
  assert.equal(f.store.purgePersonalMemories(owner, at + ninety), 0);
  assert.equal(f.store.purgePersonalMemories(owner, at + ninety + 1, 1), 1);
  assert.equal(f.store.purgePersonalMemories(owner, at + ninety + 1), 0);
  assert.equal(f.store.purgePersonalMemories(owner, at + ninety + 2), 1);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM personal_memories').get() as any).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM personal_memory_changes').get() as any).n, 3);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('paginated list exceeds injection cap and high-water mark excludes later inserts', async t => {
  const f = await fixture(t), s = f.session();
  const put = (i: number) => f.store.mutatePersonalMemory(owner, { source: f.user(s),
    proposal: { action: 'save', kind: 'fact', content: `合成器材编号 ${i}` } }, at);
  for (let i = 0; i < 65; i++) put(i);
  let page = f.store.listPersonalMemories(owner); const records = [...page.records];
  assert.equal(records.length, 30); put(65);
  while (page.next) { page = f.store.listPersonalMemories(owner, page.next); records.push(...page.records); }
  assert.equal(records.length, 65); assert.equal(new Set(records.map(r => r.id)).size, 65);
  assert.equal(f.store.listPersonalMemories(owner, { limit: 100 }).records.length, 66);
  for (const input of [{ limit: 0 }, { limit: 101 }, { after: -1 }, { after: 10, through: 9 }, { limit: null }, { ownerScope: 'other' }])
    assert.throws(() => f.store.listPersonalMemories(owner, input as any));
});

test('source retention does not silently forget memory; corrupted content is not delivered', async t => {
  const f = await fixture(t), s = f.session();
  const first = f.store.mutatePersonalMemory(owner, { source: f.user(s), proposal }, at);
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(s);
  assert.equal(f.store.listPersonalMemories(owner).records[0].id, first.id);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  f.db.prepare('UPDATE personal_memories SET content=? WHERE id=?').run('\u3164', first.id);
  assert.throws(() => f.store.listPersonalMemories(owner), /MEMORY_REQUEST_INVALID/);
});

test('v15 migration is atomic and idempotent, preserves existing rows and rejects future DB', async t => {
  const f = await fixture(t), s = f.session(); f.user(s);
  await f.store.close();
  // Disposable fixture: remove ALL v15 artifacts, not just its version marker.
  removeForgettingFixture(f.db);
  f.db.exec('DROP TABLE personal_memory_changes; DROP TABLE personal_memories; DELETE FROM schema_migrations WHERE version=15');
  const before = f.db.prepare('SELECT * FROM messages').all(), sessions = f.db.prepare('SELECT * FROM sessions').all();
  f.db.exec("CREATE TRIGGER fail_v15 BEFORE INSERT ON schema_migrations WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'v15 rollback'); END");
  assert.throws(() => (ConversationStore as any).migrate(f.db), /v15 rollback/);
  assert.equal((f.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 14);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='personal_memories'").get(), undefined);
  assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(), before);
  f.db.exec('DROP TRIGGER fail_v15');
  for (let i = 0; i < 2; i++) (ConversationStore as any).migrate(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM sessions').all(), sessions);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=15').get() as any).n, 1);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  f.db.exec("INSERT INTO schema_migrations VALUES(17,'future',0)");
  await assert.rejects(ConversationStore.create(f.root), /newer than/);
});

test('separate database handles cannot reuse a consumed source or leave a failed forget half-applied', async t => {
  const f = await fixture(t), s = f.session(), source = f.user(s);
  const first = f.store.mutatePersonalMemory(owner, { source, proposal }, at);
  assert.throws(() => mutateMemory(f.db, owner, { source, proposal }, at), /MEMORY_SOURCE_USED/);
  const fresh = f.user(s), input = { source: fresh, targetId: first.id,
    proposal: { action: 'forget', target: '书桌高度', level: 'memory_only' } };
  f.db.exec("CREATE TRIGGER fail_forget BEFORE INSERT ON personal_memory_changes WHEN NEW.action='forget' BEGIN SELECT RAISE(ABORT,'forget rollback'); END");
  assert.throws(() => mutateMemory(f.db, owner, input, at), /forget rollback/);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 1);
  f.db.exec('DROP TRIGGER fail_forget');
  mutateMemory(f.db, owner, input, at);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 0);
});

test('storage rejects accessors, future provenance and malformed IDs but permits backward retirement', async t => {
  const f = await fixture(t), s = f.session(), source = f.user(s);
  let reads = 0;
  const accessor = { source, get proposal() { reads++; return proposal; } };
  assert.throws(() => f.store.mutatePersonalMemory(owner, accessor, at)); assert.equal(reads, 0);
  assert.throws(() => f.store.mutatePersonalMemory(owner, { source, proposal }, 99), /SOURCE_UNAVAILABLE/);
  const first = f.store.mutatePersonalMemory(owner, { source, proposal }, at), fresh = f.user(s);
  const input = { source: fresh, targetId: first.id, proposal: { action: 'forget', target: '书桌', level: 'memory_only' } };
  assert.throws(() => f.store.mutatePersonalMemory(owner, { ...input, targetId: first.id + '\n' }, at));
  assert.doesNotThrow(() => f.store.mutatePersonalMemory(owner, input, at - 1));
  assert.equal((f.db.prepare('SELECT retired_at FROM personal_memories WHERE id=?').get(first.id) as any).retired_at, at);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 0);
});

test('six-hour clock rollback never blocks forget or replace and keeps audit, lineage and cleanup monotonic', async t => {
  const f = await fixture(t), s = f.session(), T = at, F = T + 6 * 3600000, retention = 90 * 86400000;
  const save = () => f.store.mutatePersonalMemory(owner, { source: f.user(s),
    proposal: { action: 'save', kind: 'preference', content: '我偏好纸质地图' } }, F);
  const forget = (targetId: string, time: number) => f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId,
    proposal: { action: 'forget', target: '地图偏好', level: 'memory_only' } }, time);
  const row = (id: string) => f.db.prepare('SELECT * FROM personal_memories WHERE id=?').get(id) as any;

  const forgotten = save();
  forget(forgotten.id, T + 60000);
  assert.equal(row(forgotten.id).state, 'forgotten'); assert.equal(row(forgotten.id).retired_at, F);
  assert.equal(f.store.listPersonalMemories(owner).records.length, 0);
  assert.equal((f.db.prepare("SELECT created_at FROM personal_memory_changes WHERE subject_id=? AND action='forget'")
    .get(forgotten.id) as any).created_at, F);
  assert.equal(f.store.purgePersonalMemories(owner, F + retention - 1), 0);
  assert.equal(f.store.purgePersonalMemories(owner, F + retention), 1);

  const A = save();
  const B = f.store.mutatePersonalMemory(owner, { source: f.user(s), targetId: A.id,
    proposal: { action: 'update', target: '地图偏好', kind: 'preference', content: '改为离线电子地图' } }, T);
  assert.equal(row(A.id).retired_at, F); assert.equal(row(A.id).superseded_by, B.id);
  assert.equal(row(B.id).created_at, F); assert.equal(row(B.id).lineage_id, row(A.id).lineage_id);
  assert.equal(f.store.listPersonalMemories(owner).records[0].content, '改为离线电子地图');
  forget(B.id, T);
  assert.equal(row(B.id).retired_at, F);
  for (const change of f.db.prepare('SELECT created_at FROM personal_memory_changes WHERE lineage_id=?').all(A.id) as any[])
    assert.equal(change.created_at, F);
  assert.equal(f.store.purgePersonalMemories(owner, F + retention - 1, 1), 0);
  assert.equal(f.store.purgePersonalMemories(owner, F + retention, 1), 1);
  assert.equal(row(A.id), undefined); assert.ok(row(B.id));
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(f.store.purgePersonalMemories(owner, F + retention, 1), 1);
  assert.equal(row(B.id), undefined);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);

  // The source check still uses raw request time, not effectiveAt.
  const C = save(), futureSource = f.user(s);
  f.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(F, futureSource.messageId);
  assert.throws(() => f.store.mutatePersonalMemory(owner, { source: futureSource, targetId: C.id,
    proposal: { action: 'forget', target: '地图偏好', level: 'memory_only' } }, T), /MEMORY_SOURCE_UNAVAILABLE/);
  assert.equal(row(C.id).state, 'active');
});
