import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { removeForgettingFixture } from './history-index-fixture.js';
import { SessionSummaryService } from '../src/session-summary.js';

const owner = { mode: 'owner' as const, ownerScope: 'single-user' }, now = 20000;
const secret = '合成暗号紫砂壶';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi4-forgetting-'));
  const store = await ConversationStore.create(root), db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(async () => {
    try {
      db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); await store.close(); }
  });
  const session = (scope = owner.ownerScope) => {
    const id = randomUUID(); store.createSession({ id, ownerScope: scope, createdAt: now - 1000 }); return id;
  };
  const user = (sessionId: string, content = secret) => {
    const messageId = randomUUID();
    const n = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM messages WHERE session_id=?').get(sessionId) as any).n;
    db.prepare(`INSERT INTO messages(id,session_id,sequence,role,status,content,created_at,updated_at)
      VALUES(?,?,?,'user','committed',?,?,?)`).run(messageId, sessionId, n, content, now - 500, now - 500);
    db.prepare('UPDATE sessions SET latest_sequence=? WHERE id=?').run(n, sessionId);
    return { sessionId, messageId };
  };
  const save = (sessionId: string) => store.mutatePersonalMemory(owner, { source: user(sessionId),
    proposal: { action: 'save', kind: 'fact', content: secret } }, now);
  const forget = (sessionId: string, targetId: string) => store.mutatePersonalMemory(owner,
    { source: user(sessionId), targetId, proposal: { action: 'forget', target: '暗号', level: 'memory_only' } }, now);
  const summary = (sessionId: string) => {
    db.prepare(`INSERT INTO session_summaries(id,session_id,through_sequence,summary_json,model,created_at,source_losses_json)
      VALUES(?,?,1,?,'stub',?,'[]')`).run(randomUUID(), sessionId, JSON.stringify({ version: 1, throughSequence: 1,
        overview: secret, topics: [], confirmedDecisions: [], unresolvedItems: [] }), now - 100);
  };
  const integrity = () => {
    db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  };
  return { root, db, store, session, user, save, forget, summary, integrity };
}

test('forget atomically suppresses complete provenance sessions across FTS, LIKE, neighbours, prior and summaries', async t => {
  const f = await fixture(t), a = f.session(), b = f.session(), c = f.session();
  const first = f.save(a), anchor = f.user(a);
  const updated = f.store.mutatePersonalMemory(owner, { source: f.user(b), targetId: first.id,
    proposal: { action: 'update', target: '暗号', kind: 'fact', content: secret + '新版' } }, now);
  f.summary(a); f.summary(b);
  assert.ok(f.store.latestSummary(a)); assert.ok(f.store.searchMessages(owner, { query: '紫砂壶' }, now).messages.length);
  f.forget(c, updated.id);
  for (const session of [a, b, c]) {
    assert.equal(f.store.isSessionMemorySuppressed(session), true);
    assert.equal(f.store.latestSummary(session), undefined);
  }
  for (const query of ['紫砂壶', '暗号']) assert.equal(f.store.searchMessages(owner, { query }, now).messages.length, 0);
  assert.throws(() => f.store.messageContext(owner, { messageId: anchor.messageId }, now), /UNAVAILABLE/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM session_summaries').get() as any).n, 0);
  assert.ok((f.db.prepare('SELECT count(*) AS n FROM messages').get() as any).n >= 4);
  f.store.endSession(c, now, 'user_exit');
  const current = randomUUID(); f.store.createSession({ id: current, ownerScope: owner.ownerScope, createdAt: now + 1 });
  assert.equal(f.store.priorSessionContext({ ownerScope: owner.ownerScope, currentSessionId: current, before: now + 2 }), undefined);
  f.integrity();
  const markers = f.db.prepare('SELECT * FROM memory_forget_sources').all() as Record<string, unknown>[];
  assert.equal(markers.length, 3); assert.doesNotMatch(JSON.stringify(markers), /紫砂|暗号/);
  assert.deepEqual(Object.keys(markers[0]), ['owner_scope', 'session_id', 'lineage_id', 'created_at', 'through_sequence']);
});

test('markers persist beyond retention/restart and FTS rebuild never reimports blocked sources', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.forget(s, first.id);
  f.user(s, secret + ' 后续复述');
  f.db.exec("INSERT INTO history_search_fts(history_search_fts) VALUES('rebuild')"); f.integrity();
  assert.equal(f.store.searchMessages(owner, { query: '紫砂壶' }, now).messages.length, 0);
  f.store.purgePersonalMemories(owner, now + 90 * 86400000);
  assert.ok(f.store.isSessionMemorySuppressed(s));
  await f.store.close(); const again = await ConversationStore.create(f.root);
  try { assert.ok(again.isSessionMemorySuppressed(s)); assert.equal(again.searchMessages(owner, { query: '暗号' }, now).messages.length, 0); }
  finally { await again.close(); }
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(s);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM memory_forget_sources').get() as any).n, 1);
  assert.equal((f.db.prepare('SELECT through_sequence FROM memory_forget_sources').get() as any).through_sequence, 2);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('unrelated owner/session remains searchable, and a new explicit save does not unban historical sources', async t => {
  const f = await fixture(t), old = f.session(), unrelated = f.session();
  const other = { mode: 'owner' as const, ownerScope: 'second-owner' }, otherSession = f.session(other.ownerScope);
  f.user(otherSession); f.user(unrelated);
  const first = f.save(old); f.forget(old, first.id);
  assert.equal(f.store.searchMessages(other, { query: '紫砂壶' }, now).messages.length, 1);
  assert.deepEqual(f.store.searchMessages(owner, { query: '紫砂壶' }, now).messages.map(m => m.sessionId), [unrelated]);
  const fresh = f.session(), again = f.save(fresh);
  assert.notEqual(first.id, again.id); assert.equal(f.store.listPersonalMemories(owner).records.length, 1);
  assert.ok(f.store.isSessionMemorySuppressed(old)); assert.equal(f.store.isSessionMemorySuppressed(fresh), false);
  const guest = { mode: 'guest' as const, ownerScope: `guest:${randomUUID()}`, sessionId: randomUUID() };
  assert.throws(() => f.store.searchMessages(guest, { query: '紫砂壶' }, now), /DENIED/);
});

test('late summary completion cannot resurrect a forgotten source; new scheduling is blocked', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s);
  for (let i = 0; i < 7; i++) f.user(s);
  const job = f.store.enqueueSummaryJob({ sessionId: s, fromSequence: 1, throughSequence: 8, createdAt: now });
  assert.equal(f.store.claimNextSummaryJob(now)?.id, job.id);
  f.forget(s, first.id);
  assert.equal(f.store.listSummaryJobs(s)[0].errorCode, 'SUMMARY_FORGOTTEN');
  assert.throws(() => f.store.completeSummaryJob({ id: job.id, at: now, model: 'stub', summary: {
    version: 1, throughSequence: 8, overview: secret, topics: [], confirmedDecisions: [], unresolvedItems: [] } }));
  assert.throws(() => f.store.summaryBatch(s, 8), /SUMMARY_FORGOTTEN/);
  assert.throws(() => f.store.enqueueSummaryJob({ sessionId: s, fromSequence: 1, throughSequence: 8, createdAt: now }), /SUMMARY_FORGOTTEN/);
  assert.equal(f.store.scheduleActiveSummary(s, 6, 1, 200, now), undefined);
  f.store.endSession(s, now, 'exit'); f.store.recoverClosedSummaries(now + 86400000);
  assert.equal(f.store.claimNextSummaryJob(now + 86400000), undefined);
  assert.equal(f.store.latestSummary(s), undefined); assert.equal(f.store.getSession(s)?.summaryThroughSequence, 0);
});

test('audit failure rolls back markers, summary deletion, job cancellation, memory and FTS together', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.summary(s);
  const source = f.user(s);
  const job = f.store.enqueueSummaryJob({ sessionId: s, fromSequence: 1, throughSequence: 2, createdAt: now });
  f.db.exec("CREATE TRIGGER fail_forget_audit BEFORE INSERT ON personal_memory_changes WHEN NEW.action='forget' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  const input = { source, targetId: first.id, proposal: { action: 'forget', target: '暗号', level: 'memory_only' } };
  assert.throws(() => f.store.mutatePersonalMemory(owner, input, now), /audit failure/);
  assert.equal(f.store.isSessionMemorySuppressed(s), false); assert.ok(f.store.latestSummary(s));
  assert.equal(f.store.listSummaryJobs(s).find(j => j.id === job.id)?.status, 'queued');
  assert.equal(f.store.listPersonalMemories(owner).records.length, 1);
  assert.ok(f.store.searchMessages(owner, { query: '紫砂壶' }, now).messages.length); f.integrity();
  f.db.exec('DROP TRIGGER fail_forget_audit'); f.store.mutatePersonalMemory(owner, input, now);
  f.integrity(); assert.equal(f.store.isSessionMemorySuppressed(s), true);
});

test('v16 backfills v15 forgotten provenance atomically, including purged versions, and rejects v17', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.forget(s, first.id);
  f.store.purgePersonalMemories(owner, now + 90 * 86400000); await f.store.close();
  removeForgettingFixture(f.db); // Disposable v15-shaped fixture, not an old-code compatibility claim.
  const original = f.db.prepare('SELECT * FROM messages').all();
  f.db.exec("CREATE TRIGGER fail_v16 BEFORE INSERT ON schema_migrations WHEN NEW.version=16 BEGIN SELECT RAISE(ABORT,'v16 rollback'); END");
  assert.throws(() => (ConversationStore as any).migrate(f.db), /v16 rollback/);
  assert.equal((f.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 15);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='memory_forget_sources'").get(), undefined);
  f.db.exec('DROP TRIGGER fail_v16');
  for (let i = 0; i < 2; i++) (ConversationStore as any).migrate(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(), original);
  assert.equal((f.db.prepare('SELECT through_sequence FROM memory_forget_sources').get() as any).through_sequence,
    (f.db.prepare('SELECT latest_sequence FROM sessions WHERE id=?').get(s) as any).latest_sequence);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM memory_forget_sources').get() as any).n, 1);
  f.integrity();
  assert.throws(() => f.db.exec('DELETE FROM memory_forget_sources'), /IMMUTABLE/);
  assert.throws(() => f.db.exec('UPDATE memory_forget_sources SET created_at=0'), /IMMUTABLE/);
  f.db.exec("INSERT INTO schema_migrations VALUES(17,'future',0)");
  await assert.rejects(ConversationStore.create(f.root), /newer than/);
});

test('long live session restarts summaries after the next committed user, never reopens recall', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s);
  const assistant = (text: string) => {
    const msg = f.user(s, text); f.db.prepare("UPDATE messages SET role='assistant' WHERE id=?").run(msg.messageId);
  };
  for (let i = 0; i < 40; i++) { f.user(s, secret); assistant(secret); }
  f.summary(s); f.forget(s, first.id);
  assistant(`已经忘掉 ${secret}`);
  assert.equal(f.store.summaryFloor(s), undefined);
  const floor = f.store.getSession(s)!.latestSequence + 1;
  for (let i = 0; i < 30; i++) { f.user(s, `陶艺课程新话题 ${i}`); assistant('只讨论新的课程安排'); }
  const inputs: any[] = [];
  const service = new SessionSummaryService(f.store, { model: 'stub', generate: async input => {
    inputs.push(input); return { version: 1, throughSequence: input.throughSequence,
      overview: '新的课程安排', topics: [], confirmedDecisions: [], unresolvedItems: [] };
  } }, { now: () => now, onDiagnostic: () => {} });
  try {
    assert.equal(f.store.summaryFloor(s), floor);
    assert.equal(f.store.getSession(s)!.summaryThroughSequence, 0);
    service.consider(s); await service.waitForIdle();
    assert.ok(inputs.length);
    for (const input of inputs) {
      assert.ok(input.messages.every((m: any) => m.sequence >= floor));
      assert.doesNotMatch(JSON.stringify(input), /紫砂壶/);
      assert.equal(input.previousSummary, undefined);
    }
    const saved = f.store.latestSummary(s)!;
    assert.ok(saved); assert.ok(saved.sourceLosses.some(l => l.kind === 'forgotten' && l.sequence === floor - 1 && l.omittedBytes === 0));
    assert.equal(f.store.searchMessages(owner, { query: '课程' }, now).messages.length, 0);
    const count = f.store.listSummaryJobs(s).length;
    f.store.endSession(s, now, 'exit'); service.consider(s); await service.waitForIdle();
    assert.equal(f.store.listSummaryJobs(s).length, count);
    const current = randomUUID(); f.store.createSession({ id: current, ownerScope: owner.ownerScope, createdAt: now + 1 });
    assert.equal(f.store.priorSessionContext({ ownerScope: owner.ownerScope, currentSessionId: current, before: now + 2 }), undefined);
    f.integrity();
  } finally { await service.close(); }
});

test('second forgetting invalidates a post-floor running generation and excludes its late assistant', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s);
  f.forget(s, first.id);
  const next = f.save(s); // A different lineage after the first boundary.
  for (let i = 0; i < 7; i++) f.user(s, '新的讨论');
  const floor = f.store.summaryFloor(s)!;
  const completed = f.store.enqueueSummaryJob({ sessionId: s, fromSequence: floor,
    throughSequence: f.store.getSession(s)!.latestSequence, createdAt: now });
  assert.equal(f.store.claimNextSummaryJob(now)?.id, completed.id);
  f.store.completeSummaryJob({ id: completed.id, at: now, model: 'stub', summary: {
    version: 1, throughSequence: completed.throughSequence, overview: '第一次重启的摘要', topics: [], confirmedDecisions: [], unresolvedItems: [] } });
  assert.ok(f.store.latestSummary(s));
  for (let i = 0; i < 7; i++) f.user(s, '又一轮新讨论');
  const job = f.store.enqueueSummaryJob({ sessionId: s, fromSequence: completed.throughSequence + 1,
    throughSequence: f.store.getSession(s)!.latestSequence, createdAt: now });
  let release!: (v: unknown) => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  const service = new SessionSummaryService(f.store, { model: 'stub', generate: async () => {
    calls++; entered(); return pending;
  } }, { now: () => now, onDiagnostic: () => {} });
  try {
    await started;
    f.forget(f.session(), next.id);
    const late = f.user(s, secret); f.db.prepare("UPDATE messages SET role='assistant' WHERE id=?").run(late.messageId);
    const interrupted = f.user(s, secret); f.db.prepare("UPDATE messages SET status='interrupted' WHERE id=?").run(interrupted.messageId);
    assert.equal(f.store.summaryFloor(s), undefined);
    f.user(s, '完全新的运动计划');
    const newerFloor = f.store.summaryFloor(s)!;
    assert.ok(newerFloor > floor);
    release({ invalid: secret }); await service.waitForIdle();
    assert.equal(calls, 1); assert.equal(f.store.latestSummary(s), undefined);
    assert.throws(() => f.store.completeSummaryJob({ id: job.id, at: now, model: 'stub', summary: {
      version: 1, throughSequence: job.throughSequence, overview: secret, topics: [], confirmedDecisions: [], unresolvedItems: [] } }), /SUMMARY_FORGOTTEN/);
    const batch = f.store.summaryBatch(s, f.store.getSession(s)!.latestSequence);
    assert.deepEqual(batch.messages.map(m => m.sequence), [newerFloor]);
    assert.equal(batch.previousSummary, undefined); assert.deepEqual(batch.previousLosses, []);
    f.integrity();
  } finally { release(null); await service.close(); }
});

test('session ownership changes and mismatched marker owners cannot weaken suppression', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.summary(s); f.forget(s, first.id);
  f.db.prepare('UPDATE sessions SET owner_scope=? WHERE id=?').run('new-owner', s);
  assert.equal(f.store.isSessionMemorySuppressed(s), true); assert.equal(f.store.latestSummary(s), undefined);
  for (const ownerScope of ['single-user', 'new-owner']) {
    assert.equal(f.store.searchMessages({ mode: 'owner', ownerScope }, { query: '紫砂壶' }, now).messages.length, 0);
  }
  f.integrity();
  const other = f.session(); f.user(other); f.summary(other);
  f.db.prepare('INSERT INTO memory_forget_sources VALUES(?,?,?,?,?)').run('wrong-owner', other, randomUUID(), now, 1);
  assert.equal(f.store.isSessionMemorySuppressed(other), true); assert.equal(f.store.latestSummary(other), undefined);
  assert.equal(f.store.searchMessages(owner, { query: '紫砂壶' }, now).messages.length, 0);
  f.integrity();
});

test('all duplicate insert forms preserve the marker and newly restarted summary', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.forget(s, first.id);
  f.user(s, '新主题');
  const row = f.db.prepare('SELECT * FROM memory_forget_sources').get() as any;
  // A post-floor summary stands in for a successfully restarted worker.
  f.db.prepare(`INSERT INTO session_summaries(id,session_id,through_sequence,summary_json,model,created_at,source_losses_json)
    VALUES(?,?,3,?,'stub',?,'[]')`).run(randomUUID(), s, JSON.stringify({ version: 1, throughSequence: 3,
      overview: '新主题', topics: [], confirmedDecisions: [], unresolvedItems: [] }), now);
  for (const verb of ['INSERT OR REPLACE', 'REPLACE', 'INSERT', 'INSERT OR IGNORE']) {
    f.db.prepare(`${verb} INTO memory_forget_sources VALUES(?,?,?,?,?)`).run(row.owner_scope, s, row.lineage_id, 0, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM memory_forget_sources').get(), row);
    assert.ok(f.store.latestSummary(s)); f.integrity();
  }
  assert.throws(() => f.db.exec('UPDATE memory_forget_sources SET through_sequence=0'), /IMMUTABLE/);
  assert.throws(() => f.db.exec('DELETE FROM memory_forget_sources'), /IMMUTABLE/);
  f.integrity();
});

test('in-flight generator response after forgetting neither repairs nor saves the old context', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s);
  for (let i = 0; i < 7; i++) f.user(s);
  const job = f.store.enqueueSummaryJob({ sessionId: s, fromSequence: 1, throughSequence: 8, createdAt: now });
  let release!: (value: unknown) => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const result = new Promise<unknown>(resolve => { release = resolve; });
  const service = new SessionSummaryService(f.store, { model: 'stub', generate: async () => {
    calls++; entered(); return result;
  } }, { now: () => now });
  try {
    await started; f.forget(s, first.id);
    release({ invalid: secret }); // Would normally start schema repair.
    await service.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(f.store.latestSummary(s), undefined);
    assert.equal(f.store.listSummaryJobs(s).find(j => j.id === job.id)?.errorCode, 'SUMMARY_FORGOTTEN');
  } finally { release(null); await service.close(); }
});

test('closing a suppressed session terminates queued restarted summaries instead of stranding them', async t => {
  const f = await fixture(t);
  for (const end of ['endSession', 'expireSession'] as const) {
    const s = f.session(), first = f.save(s); f.forget(s, first.id);
    for (let i = 0; i < 8; i++) f.user(s, '新的合成内容');
    const job = f.store.scheduleActiveSummary(s, 6, 1, 200, now)!;
    assert.ok(job); f.store[end](s, now, 'exit');
    const stored = f.store.listSummaryJobs(s).find(j => j.id === job.id)!;
    assert.equal(stored.status, 'failed'); assert.equal(stored.errorCode, 'SUMMARY_FORGOTTEN');
    assert.equal(f.store.hasBlockingSummaryJob(s), false);
    assert.equal(f.store.claimNextSummaryJob(now), undefined);
  }
});

test('closing during post-forget generation remains SUMMARY_FORGOTTEN, never model failure or repair', async t => {
  const f = await fixture(t), s = f.session(), first = f.save(s); f.forget(s, first.id);
  for (let i = 0; i < 8; i++) f.user(s, '新的合成内容');
  const job = f.store.scheduleActiveSummary(s, 6, 1, 200, now)!;
  let release!: (value: unknown) => void, entered!: () => void, calls = 0;
  const ready = new Promise<void>(r => { entered = r; }), pending = new Promise<unknown>(r => { release = r; });
  const service = new SessionSummaryService(f.store, { model: 'stub', generate: async () => {
    calls++; entered(); return pending;
  } }, { now: () => now, onDiagnostic: () => {} });
  try {
    await ready; f.store.endSession(s, now, 'exit'); release({ invalid: true }); await service.waitForIdle();
    assert.equal(calls, 1); assert.equal(f.store.latestSummary(s), undefined);
    assert.equal(f.store.listSummaryJobs(s).find(j => j.id === job.id)?.errorCode, 'SUMMARY_FORGOTTEN');
    assert.equal(f.store.hasBlockingSummaryJob(s), false);
  } finally { release(null); await service.close(); }
});
