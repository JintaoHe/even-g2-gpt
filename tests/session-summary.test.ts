import { DROP_HISTORY_INDEX_SQL } from './history-index-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore, SUMMARY_RETRY_POLICY as RETRY } from '../src/conversation-store.js';
import { CostBudgetExceeded } from '../src/cost-ledger.js';
import { summaryBody, SummaryInputLimit } from '../src/summary-request.js';
import {
  OpenAISessionSummaryGenerator,
  SessionSummaryService,
  MAX_SUMMARY_REQUEST_BYTES,
  type SessionSummaryGenerationRequest,
} from '../src/session-summary.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('repair budget denial cannot refund an already consumed model attempt', async () => {
  const { store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  let now = 1000, calls = 0;
  const service = new SessionSummaryService(store, { model: 'test', generate: async r => {
    if (r.attempt === 'repair') throw new CostBudgetExceeded('openai');
    calls++; return {};
  } }, { now: () => now });
  try {
    await service.waitForIdle();
    for (let i = 0; i < 2; i++) { now += RETRY.budgetDelayMs; service.consider(sessionId); await service.waitForIdle(); }
    assert.equal(calls, 3);
    assert.equal(store.listSummaryJobs(sessionId)[0].attempts, 3);
    assert.equal(store.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_GAVE_UP');
  } finally { await service.close(); await store.close(); }
});

test('v9 recovery-clock migration rolls back, preserves tasks and reopens idempotently', async () => {
  const { root, store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const before = store.listSummaryJobs(sessionId);
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE summary_recovery_clocks; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=9;
    CREATE TRIGGER fail_v9 BEFORE INSERT ON schema_migrations WHEN NEW.version=9
    BEGIN SELECT RAISE(ABORT,'injected v9 failure'); END;`);
  try {
    await assert.rejects(ConversationStore.create(root), /injected v9 failure/);
    assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 8);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='summary_recovery_clocks'").get(), undefined);
    db.exec('DROP TRIGGER fail_v9');
  } finally { db.close(); }
  for (let i = 0; i < 2; i++) {
    const reopened = await ConversationStore.create(root);
    try { assert.deepEqual(reopened.listSummaryJobs(sessionId), before); assert.equal(reopened.health().schemaVersion, 13); }
    finally { await reopened.close(); }
  }
});

test('closed session recovers from transient terminal failure by timer alone after one hour', async () => {
  const { store, sessionId } = await fixture(30);
  let now = 1000, calls = 0;
  store.endSession(sessionId, now, 'user_exit');
  const old = store.claimNextSummaryJob(now)!;
  store.failSummaryJob(old.id, 'SUMMARY_GAVE_UP', now);
  const service = new SessionSummaryService(store, { model: 'test', generate: async r => {
    calls++; assert.notEqual(r.jobId, old.id); return validSummary(r.throughSequence);
  } }, { now: () => now, sweepIntervalMs: 10 });
  try {
    await service.waitForIdle(); assert.equal(calls, 0);
    now += 3600_000 - 1;
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(calls, 0);
    now++;
    await until(() => calls === 1); await service.waitForIdle();
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 60);
    assert.equal(store.listSummaryJobs(sessionId).find(x => x.id === old.id)?.errorCode, 'SUMMARY_GAVE_UP');
  } finally { await service.close(); await store.close(); }
});

test('closed budget recovery waits for funds; input limits stay terminal and total generations are bounded to three', async () => {
  for (const code of ['SUMMARY_BUDGET_GAVE_UP', 'SUMMARY_INPUT_LIMIT', 'SUMMARY_GAVE_UP']) {
    const { store, sessionId } = await fixture(3);
    let now = 1000;
    const sweep = () => { store.recoverClosedSummaries(now); store.recoverClosedSummaries(now); };
    store.endSession(sessionId, now, 'user_exit');
    let old = store.claimNextSummaryJob(now)!;
    store.failSummaryJob(old.id, code, now);
    try {
      now += 32 * 86400_000;
      if (code === 'SUMMARY_BUDGET_GAVE_UP') {
        store.configureSummaryRecoveryBudget(() => false); sweep();
        assert.equal(store.listSummaryJobs(sessionId).length, 1);
        store.configureSummaryRecoveryBudget(() => true);
      }
      sweep();
      if (code === 'SUMMARY_INPUT_LIMIT') { assert.equal(store.listSummaryJobs(sessionId).length, 1); continue; }
      for (let generation = 1; generation <= 2; generation++) {
        old = store.claimNextSummaryJob(now)!; assert.ok(old);
        store.failSummaryJob(old.id, code, now);
        now += 3600_000; sweep();
      }
      assert.equal(store.listSummaryJobs(sessionId).length, 3);
      assert.equal(store.claimNextSummaryJob(now), undefined);
    } finally { await store.close(); }
  }
});

test('closed recovery reanchors poisoned clocks durably without changing terminal audit data', async () => {
  const { root, store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const old = store.claimNextSummaryJob(1000)!;
  store.failSummaryJob(old.id, 'SUMMARY_GAVE_UP', 365 * 86400_000);
  store.recoverClosedSummaries(2000);
  const audit = store.listSummaryJobs(sessionId)[0];
  await store.close();
  const reopened = await ConversationStore.create(root);
  try {
    reopened.recoverClosedSummaries(2000 + 3600_000 - 1);
    assert.equal(reopened.listSummaryJobs(sessionId).length, 1);
    reopened.recoverClosedSummaries(2000 + 3600_000);
    reopened.recoverClosedSummaries(2000 + 3600_000);
    assert.equal(reopened.listSummaryJobs(sessionId).length, 2);
    assert.deepEqual(reopened.listSummaryJobs(sessionId).find(j => j.id === old.id), audit);
  } finally { await reopened.close(); }
});

test('v8 migration preserves v7 tasks, anchors terminal baseline, rolls back atomically and is idempotent', async () => {
  const { root, store, sessionId } = await fixture(40);
  const job = store.scheduleActiveSummary(sessionId, 60, 24, 20, 1000)!;
  store.claimNextSummaryJob(1001); store.failSummaryJob(job.id, 'SUMMARY_GAVE_UP', 1002);
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`CREATE TABLE jobs_v7 (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    error_code TEXT, budget_deferrals INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id,from_sequence,through_sequence)) STRICT;
    INSERT INTO jobs_v7 SELECT id,session_id,from_sequence,through_sequence,status,attempts,created_at,updated_at,error_code,budget_deferrals FROM summary_jobs;
    DROP TABLE summary_jobs; ALTER TABLE jobs_v7 RENAME TO summary_jobs;
    CREATE INDEX summary_jobs_status_idx ON summary_jobs(status,created_at);
    DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE summary_recovery_clocks; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=8;
    CREATE TRIGGER fail_v8 BEFORE INSERT ON schema_migrations WHEN NEW.version=8
    BEGIN SELECT RAISE(ABORT,'injected v8 failure'); END;`);
  try {
    await assert.rejects(ConversationStore.create(root), /injected v8 failure/);
    assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 7);
    assert.equal((db.prepare('PRAGMA table_info(summary_jobs)').all() as any[]).some(x => x.name === 'generation'), false);
    assert.equal((db.prepare('SELECT error_code FROM summary_jobs WHERE id=?').get(job.id) as any).error_code, 'SUMMARY_GAVE_UP');
    db.exec('DROP TRIGGER fail_v8');
  } finally { db.close(); }
  for (let i = 0; i < 2; i++) {
    const reopened = await ConversationStore.create(root);
    try {
      assert.deepEqual(reopened.listSummaryJobs(sessionId), [{ ...job, status: 'failed', attempts: 1, updatedAt: 1002, errorCode: 'SUMMARY_GAVE_UP' }]);
      assert.equal(reopened.scheduleActiveSummary(sessionId, 60, 24, 20, 3000), undefined);
      assert.equal(reopened.health().schemaVersion, 13);
    } finally { await reopened.close(); }
  }
});

test('same-range recovery needs 60 new committed messages, survives restart and never revives old tasks', async () => {
  const { root, store, sessionId, topicId, append } = await fixture(100);
  const first = store.scheduleActiveSummary(sessionId, 60, 24, 20, 1000)!;
  store.claimNextSummaryJob(1001); store.failSummaryJob(first.id, 'SUMMARY_GAVE_UP', 1002);
  for (let i = 100; i < 129; i++) append(i);
  const turnId = randomUUID(), answerId = randomUUID();
  store.commitUserTurn({ sessionId, topicId, turnId, messageId: randomUUID(), content: '第59条', createdAt: 2000 });
  assert.equal(store.scheduleActiveSummary(sessionId, 60, 24, 20, 2001), undefined);
  store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: answerId, createdAt: 2002 });
  store.commitAssistantAnswer({ messageId: answerId, content: '第60条', updatedAt: 2003 });
  await store.close();
  const reopened = await ConversationStore.create(root);
  try {
    const next = reopened.scheduleActiveSummary(sessionId, 60, 24, 20, 3000)!;
    assert.notEqual(next.id, first.id);
    assert.equal(next.throughSequence, first.throughSequence);
    assert.equal(reopened.scheduleActiveSummary(sessionId, 60, 24, 20, 3001), undefined);
    assert.equal(reopened.listSummaryJobs(sessionId).find(j => j.id === first.id)?.errorCode, 'SUMMARY_GAVE_UP');
    reopened.claimNextSummaryJob(3002); reopened.failSummaryJob(next.id, 'SUMMARY_GAVE_UP', 3003);
    assert.equal(reopened.scheduleActiveSummary(sessionId, 60, 24, 20, 3004), undefined);
  } finally { await reopened.close(); }
});

test('budget recovery requires new messages and a fail-closed budget check', async () => {
  const { store, sessionId, append } = await fixture(40);
  const first = store.scheduleActiveSummary(sessionId, 60, 24, 20, 1000)!;
  store.claimNextSummaryJob(1001); store.failSummaryJob(first.id, 'SUMMARY_BUDGET_GAVE_UP', 1002);
  try {
    store.configureSummaryRecoveryBudget(() => true);
    assert.equal(store.scheduleActiveSummary(sessionId, 60, 24, 20, 1003), undefined);
    for (let i = 40; i < 70; i++) append(i);
    store.configureSummaryRecoveryBudget(() => false);
    assert.equal(store.scheduleActiveSummary(sessionId, 60, 24, 20, 2000), undefined);
    store.configureSummaryRecoveryBudget(() => { throw new Error('ledger unavailable'); });
    assert.equal(store.scheduleActiveSummary(sessionId, 60, 24, 20, 2001), undefined);
    store.configureSummaryRecoveryBudget(() => true);
    assert.notEqual(store.scheduleActiveSummary(sessionId, 60, 24, 20, 2002)?.id, first.id);
  } finally { await store.close(); }
});

test('invalid summary JSON and schema degrade without resetting coverage or preventing closure', async () => {
  for (const body of ['not json', '{}', 'null', JSON.stringify({ ...validSummary(6), topics: [null] })]) {
    const { root, store, sessionId } = await fixture(10);
    const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
    store.claimNextSummaryJob(1001);
    store.completeSummaryJob({ id: job.id, summary: validSummary(6), model: 'test', at: 1002 });
    const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
    db.prepare('UPDATE session_summaries SET summary_json=? WHERE session_id=?').run(body, sessionId); db.close();
    try {
      const summary = store.latestSummary(sessionId)!;
      assert.equal(summary.sourceLosses[0].kind, 'metadata_unknown');
      assert.deepEqual(summary.confirmedDecisions, []);
      assert.equal(summary.throughSequence, 6);
      store.endSession(sessionId, 2000, 'user_exit');
      assert.equal(store.getSession(sessionId)?.status, 'ended');
      assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 6);
    } finally { await store.close(); }
  }
});

test('corrupt loss metadata does not prevent end or expiry and remains visibly unknown', async () => {
  for (const corrupt of ['not json', '{}', '[{"kind":"message","sequence":1,"omittedBytes":-1}]']) {
    for (const ending of ['end', 'expire']) {
      const { root, store, sessionId } = await fixture(10);
      const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
      store.claimNextSummaryJob(1001);
      store.completeSummaryJob({ id: job.id, summary: validSummary(6), model: 'test', at: 1002 });
      const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
      db.prepare('UPDATE session_summaries SET source_losses_json=? WHERE session_id=?').run(corrupt, sessionId);
      db.close();
      try {
        assert.equal(store.latestSummary(sessionId)?.sourceLosses[0].kind, 'metadata_unknown');
        if (ending === 'end') store.endSession(sessionId, 2000, 'user_exit');
        else store.expireSession(sessionId, 2000);
        assert.equal(store.getSession(sessionId)?.status, ending === 'end' ? 'ended' : 'expired');
        const next = store.claimNextSummaryJob(2001)!;
        store.completeSummaryJob({ id: next.id, summary: validSummary(next.throughSequence), model: 'test', at: 2002 });
        assert.equal(store.latestSummary(sessionId)?.sourceLosses[0].kind, 'metadata_unknown');
      } finally { await store.close(); }
    }
  }
});

test('exhausted summary start skips byte planning on every later turn and close', async t => {
  const { root, store, sessionId } = await fixture(100);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare('UPDATE messages SET content=? WHERE session_id=?').run('x'.repeat(1024), sessionId); db.close();
  const start = performance.now();
  const job = store.scheduleActiveSummary(sessionId, 60, 24, 200, 1000)!;
  t.diagnostic(`200-message scheduling including SQLite=${(performance.now() - start).toFixed(2)}ms`);
  store.claimNextSummaryJob(1000);
  store.failSummaryJob(job.id, 'SUMMARY_INPUT_LIMIT', 1000);
  const original = store.summaryBatch;
  store.summaryBatch = () => { throw new Error('must not replan terminal range'); };
  try {
    const skippedStart = performance.now();
    for (let i = 0; i < 10; i++) assert.equal(store.scheduleActiveSummary(sessionId, 60, 24, 200, 2000 + i), undefined);
    t.diagnostic(`terminal range scheduling average=${((performance.now() - skippedStart) / 10).toFixed(2)}ms`);
    store.endSession(sessionId, 3000, 'user_exit');
  } finally { store.summaryBatch = original; await store.close(); }
});

test('store quarantine diagnostics use the worker diagnostic sink', async () => {
  const { root, store, sessionId } = await fixture(3);
  const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare('UPDATE summary_jobs SET from_sequence=2 WHERE id=?').run(job.id); db.close();
  const events: Record<string, string | number>[] = [];
  const service = new SessionSummaryService(store, { model: 'test', generate: async () => { throw new Error('must not call'); } },
    { onDiagnostic: event => events.push(event) });
  try {
    await service.waitForIdle();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'SUMMARY_RANGE_INVALID');
    assert.equal(events[0].jobId, job.id);
  } finally { await service.close(); await store.close(); }
});

test('legacy queued 200-message range is replaced without mutating its range or sending oversized input', async () => {
  const { root, store, sessionId } = await fixture(100);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare("UPDATE messages SET content=? WHERE session_id=? AND role='assistant'").run('中'.repeat(2000), sessionId);
  db.close();
  const old = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 200, createdAt: 4000 });
  store.endSession(sessionId, 5000, 'user_exit');
  let calls = 0;
  const service = new SessionSummaryService(store, { model: 'test-model', generate: async request => {
    calls++;
    assert.notEqual(request.jobId, old.id);
    assert.ok(summaryBody('test-model', request).bytes <= 154000);
    return validSummary(request.throughSequence);
  } });
  try {
    await service.waitForIdle();
    const jobs = store.listSummaryJobs(sessionId);
    const original = jobs.find(j => j.id === old.id)!;
    assert.equal(original.errorCode, 'SUMMARY_REBATCHED');
    assert.equal(original.fromSequence, 1);
    assert.equal(original.throughSequence, 200);
    assert.ok(calls > 1);
    assert.ok(store.getSession(sessionId)!.summaryThroughSequence >= 195);
    assert.equal(new Set(jobs.map(j => j.id)).size, jobs.length);
  } finally { await service.close(); await store.close(); }
});

test('terminal input-limit diagnostic retains byte count but no message content', async () => {
  const { store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const events: Record<string, string | number>[] = [];
  const service = new SessionSummaryService(store, { model: 'test-model', generate: async () => {
    throw new SummaryInputLimit(180001);
  } }, { onDiagnostic: e => events.push(e) });
  try {
    await service.waitForIdle();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'summary_failed');
    assert.equal(events[0].bytes, 180001);
    assert.equal(events[0].code, 'SUMMARY_INPUT_LIMIT');
    assert.deepEqual(Object.keys(events[0]).sort(), ['bytes', 'code', 'event', 'fromSequence', 'jobId', 'sessionId', 'throughSequence']);
    assert.equal(store.getSession(sessionId)!.summaryThroughSequence, 0);
  } finally { await service.close(); await store.close(); }
});

test('100 long turns summarize with byte-selected ranges instead of terminal input-limit failure', async () => {
  const { root, store, sessionId } = await fixture(100);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare("UPDATE messages SET content=? WHERE session_id=? AND role='assistant'").run('中'.repeat(2000), sessionId);
  db.close(); store.endSession(sessionId, 5000, 'user_exit');
  let calls = 0;
  const service = new SessionSummaryService(store, { model: 'test-model', generate: async request => {
    calls++; assert.ok(summaryBody('test-model', request).bytes < MAX_SUMMARY_REQUEST_BYTES - 24000);
    return validSummary(request.throughSequence);
  } });
  try {
    await service.waitForIdle();
    assert.ok(calls > 1);
    assert.ok(store.getSession(sessionId)!.summaryThroughSequence >= 195);
    assert.ok(store.listSummaryJobs(sessionId).every(j => j.status === 'completed'));
  } finally { await service.close(); await store.close(); }
});

test('sub-six byte batches enqueue, excerpts survive to the third summary, and bodies survive restart', async () => {
  const { root, store, sessionId } = await fixture(10);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare('UPDATE messages SET content=? WHERE session_id=? AND sequence=2').run('中😀'.repeat(40_000), sessionId);
  db.close(); store.configureSummaryModel('test-model'); store.endSession(sessionId, 5000, 'user_exit');
  assert.equal(store.listSummaryJobs(sessionId)[0].throughSequence, 1, 'threshold counts pending messages before byte selection');
  const before = store.summaryBatch(sessionId, 1).body;
  await store.close();
  const reopened = await ConversationStore.create(root); reopened.configureSummaryModel('test-model');
  assert.equal(reopened.summaryBatch(sessionId, 1).body, before);
  const reports: Record<string, string | number>[] = [];
  let calls = 0;
  const service = new SessionSummaryService(reopened, { model: 'test-model', generate: async request => {
    calls++;
    if (calls === 2) {
      assert.equal(request.messages.length, 1);
      assert.ok(request.messages[0].excerpt!.omittedBytes > 0);
      assert.doesNotMatch(request.messages[0].content, /[\uD800-\uDFFF]/u);
    }
    if (calls === 3) assert.ok(request.previousLosses?.some(x => x.sequence === 2));
    return validSummary(request.throughSequence);
  } }, { onDiagnostic: e => reports.push(e) });
  try {
    await service.waitForIdle(); assert.equal(calls, 3);
    assert.equal(reopened.latestSummary(sessionId)?.sourceLosses[0].sequence, 2);
    assert.equal(reopened.getSession(sessionId)?.summaryThroughSequence, 20);
    assert.ok(reports.some(e => e.event === 'summary_excerpt'));
    assert.doesNotMatch(JSON.stringify(reports), /中|😀|content|overview/);
  } finally { await service.close(); await reopened.close(); }
  const final = await ConversationStore.create(root);
  try { assert.equal(final.latestSummary(sessionId)?.sourceLosses[0].sequence, 2); }
  finally { await final.close(); }
});

test('v7 loss metadata migration rolls back atomically and preserves old summaries', async () => {
  const { root, store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const job = store.claimNextSummaryJob(1001)!;
  store.completeSummaryJob({ id: job.id, summary: validSummary(6), model: 'test', at: 1002 });
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`ALTER TABLE session_summaries DROP COLUMN source_losses_json;
    DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE summary_recovery_clocks; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=7;
    CREATE TRIGGER fail_v7 BEFORE INSERT ON schema_migrations WHEN NEW.version=7
    BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;`);
  try {
    await assert.rejects(ConversationStore.create(root), /injected migration failure/);
    assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 6);
    assert.equal((db.prepare('PRAGMA table_info(session_summaries)').all() as any[]).some(c => c.name === 'source_losses_json'), false);
    db.exec('DROP TRIGGER fail_v7');
  } finally { db.close(); }
  const migrated = await ConversationStore.create(root);
  try {
    assert.equal(migrated.health().schemaVersion, 13);
    assert.equal(migrated.latestSummary(sessionId)?.throughSequence, 6);
    assert.deepEqual(migrated.latestSummary(sessionId)?.sourceLosses, []);
  } finally { await migrated.close(); }
});

test('serialized request boundary is inclusive and enforced before the metered fetch', async () => {
  const { store, sessionId } = await fixture(3);
  let calls = 0, bytes = 0;
  const generator = new OpenAISessionSummaryGenerator('test-key', 'test-model', undefined, async (_url, init) => {
    calls++; bytes = Buffer.byteLength(String(init?.body));
    return new Response(JSON.stringify({ output_text: JSON.stringify(validSummary(6)) }));
  });
  const request: SessionSummaryGenerationRequest = { jobId: randomUUID(), sessionId, fromSequence: 1, throughSequence: 6,
    messages: store.listCommittedMessages(sessionId, 0, 6, 500), attempt: 'summarize' };
  try {
    await generator.generate(request, new AbortController().signal);
    request.messages[0].content += 'x'.repeat(MAX_SUMMARY_REQUEST_BYTES - bytes);
    await generator.generate(request, new AbortController().signal);
    assert.equal(bytes, MAX_SUMMARY_REQUEST_BYTES);
    request.messages[0].content += 'x';
    await assert.rejects(generator.generate(request, new AbortController().signal), /SUMMARY_INPUT_LIMIT/);
    assert.equal(calls, 2);
  } finally { await store.close(); }
});

test('schema v5 migration preserves existing summary jobs and initializes durable budget counts once', async () => {
  const { root, store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const id = store.listSummaryJobs(sessionId)[0].id;
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec('DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; ALTER TABLE summary_jobs DROP COLUMN budget_deferrals; ALTER TABLE session_summaries DROP COLUMN source_losses_json; DROP TABLE summary_recovery_clocks; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=6;');
  db.close();
  const migrated = await ConversationStore.create(root);
  try {
    assert.equal(migrated.health().schemaVersion, 13);
    assert.equal(migrated.listSummaryJobs(sessionId)[0].id, id);
    assert.equal(migrated.listMessages(sessionId).length, 6);
    migrated.claimNextSummaryJob(1001); migrated.deferSummaryJob(id, 1002, 'budget');
  } finally { await migrated.close(); }
  const reopened = await ConversationStore.create(root);
  const inspection = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    assert.equal((inspection.prepare('SELECT budget_deferrals FROM summary_jobs WHERE id=?').get(id) as any).budget_deferrals, 1);
  } finally { inspection.close(); await reopened.close(); }
});

test('summary input limit rejects raw oversized history while prior and repair data are byte bounded', async () => {
  const { store, sessionId } = await fixture(3);
  let calls = 0;
  const generator = new OpenAISessionSummaryGenerator('test-key', 'test-model', undefined, async () => {
    calls++; return new Response(JSON.stringify({ output_text: JSON.stringify(validSummary(6)) }));
  });
  const messages = store.listCommittedMessages(sessionId, 0, 6, 500);
  try {
    for (const source of ['history', 'previous', 'repair'] as const) {
      const request: SessionSummaryGenerationRequest = {
        jobId: randomUUID(), sessionId, fromSequence: 1, throughSequence: 6,
        messages: source === 'history' ? messages.map(m => ({ ...m, content: '中'.repeat(20_000) })) : messages,
        attempt: source === 'repair' ? 'repair' : 'summarize',
        ...(source === 'previous' ? { previousSummary: { ...validSummary(1), overview: '中'.repeat(65_000) } } : {}),
        ...(source === 'repair' ? { invalidOutput: '\u0000'.repeat(24_000),
          previousSummary: { ...validSummary(1), overview: '中'.repeat(50_000) } } : {}),
      };
      if (source === 'history') await assert.rejects(generator.generate(request, new AbortController().signal), /SUMMARY_INPUT_LIMIT/);
      else await generator.generate(request, new AbortController().signal);
    }
    assert.equal(calls, 2);
  } finally { await store.close(); }
});

test('large source messages use smaller batches before metering instead of failing the entire range', async () => {
  const { root, store, sessionId } = await fixture(3);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  db.prepare("UPDATE messages SET content=? WHERE session_id=? AND role='assistant'").run('a'.repeat(120_000), sessionId);
  db.close();
  store.endSession(sessionId, 1000, 'user_exit');
  let calls = 0;
  const generator = new OpenAISessionSummaryGenerator('test-key', 'test-model', undefined, async (_url, init) => {
    calls++; assert.ok(Buffer.byteLength(String(init?.body)) <= MAX_SUMMARY_REQUEST_BYTES);
    const through = Number(JSON.parse(String(init?.body)).input.match(/through sequence (\d+)/)[1]);
    return new Response(JSON.stringify({ output_text: JSON.stringify(validSummary(through)) }));
  });
  const service = new SessionSummaryService(store, generator, { now: () => 2000 });
  try {
    await service.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(store.listSummaryJobs(sessionId)[0].status, 'completed');
    assert.equal(store.hasBlockingSummaryJob(sessionId), false);
    assert.ok(store.getSession(sessionId)!.summaryThroughSequence > 0);
    assert.equal(store.claimNextSummaryJob(10_000_000), undefined);
  } finally { await service.close(); await store.close(); }
});

test('budget deferrals are durable and terminate after 24 denials without resetting model failures', async () => {
  const { root, store, sessionId } = await fixture(3);
  let current = store, now = 1000;
  current.endSession(sessionId, now, 'user_exit');
  const job = current.claimNextSummaryJob(now)!;
  current.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', now);
  now += RETRY.firstDelayMs;
  try {
    for (let denial = 1; denial <= 24; denial++) {
      assert.equal(current.claimNextSummaryJob(now)?.id, job.id);
      current.deferSummaryJob(job.id, now, 'budget');
      assert.equal(current.listSummaryJobs(sessionId)[0].attempts, 1);
      if (denial === 12) { await current.close(); current = await ConversationStore.create(root); }
      now += RETRY.budgetDelayMs;
    }
    assert.equal(current.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_BUDGET_GAVE_UP');
    assert.equal(current.hasBlockingSummaryJob(sessionId), false);
    assert.equal(current.claimNextSummaryJob(now), undefined);
  } finally { await current.close(); }
});

test('future clock repair has an exact 15-minute threshold and respects the original delay below it', async () => {
  for (const skew of [RETRY.budgetDelayMs - 1, RETRY.budgetDelayMs, RETRY.budgetDelayMs + 1]) {
    const { store, sessionId } = await fixture(3);
    try {
      const now = 2_000_000;
      store.endSession(sessionId, now, 'user_exit');
      const job = store.claimNextSummaryJob(now)!;
      store.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', now + skew);
      assert.equal(store.claimNextSummaryJob(now), undefined);
      const anchor = skew > RETRY.budgetDelayMs ? now : now + skew;
      assert.equal(store.listSummaryJobs(sessionId)[0].updatedAt, anchor);
      assert.equal(store.claimNextSummaryJob(anchor + RETRY.firstDelayMs - 1), undefined);
      assert.equal(store.claimNextSummaryJob(anchor + RETRY.firstDelayMs)?.id, job.id);
    } finally { await store.close(); }
  }
});

test('repaired future retry clock survives reopening the database without changing its deadline', async () => {
  const { root, store, sessionId } = await fixture(3);
  const now = Date.now();
  store.endSession(sessionId, now, 'user_exit');
  const job = store.claimNextSummaryJob(now)!;
  store.deferSummaryJob(job.id, now + 365 * 86400_000, 'budget');
  assert.equal(store.claimNextSummaryJob(now), undefined);
  await store.close();
  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.listSummaryJobs(sessionId)[0].updatedAt, now);
    assert.equal(reopened.claimNextSummaryJob(now + RETRY.budgetDelayMs - 1), undefined);
    assert.equal(reopened.claimNextSummaryJob(now + RETRY.budgetDelayMs)?.id, job.id);
  } finally { await reopened.close(); }
});

test('future clock repair never touches a running claim or resurrects a terminal failure', async () => {
  const { store, sessionId } = await fixture(3);
  try {
    const now = 2_000_000, future = now + 365 * 86400_000;
    store.endSession(sessionId, now, 'user_exit');
    const job = store.claimNextSummaryJob(future)!;
    assert.equal(store.claimNextSummaryJob(now), undefined);
    assert.equal(store.listSummaryJobs(sessionId)[0].updatedAt, future);
    store.failSummaryJob(job.id, 'SUMMARY_GAVE_UP', future);
    for (let i = 0; i < 20; i++) assert.equal(store.claimNextSummaryJob(now + i), undefined);
    assert.equal(store.listSummaryJobs(sessionId)[0].updatedAt, future);
    assert.equal(store.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_GAVE_UP');
  } finally { await store.close(); }
});

test('future-poisoned retry clocks recover after a full delay rather than immediately or a year later', async () => {
  for (const reason of ['first', 'second', 'budget', 'shutdown'] as const) {
    const { store, sessionId } = await fixture(3);
    try {
      let now = 2_000_000;
      store.endSession(sessionId, now, 'user_exit');
      const job = store.claimNextSummaryJob(now)!;
      if (reason === 'second') {
        store.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', now);
        now += RETRY.firstDelayMs;
        store.claimNextSummaryJob(now);
      }
      const future = now + 365 * 86400_000;
      if (reason === 'budget' || reason === 'shutdown') store.deferSummaryJob(job.id, future, reason);
      else store.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', future);
      const before = store.listSummaryJobs(sessionId)[0];
      assert.equal(store.claimNextSummaryJob(now), undefined, 'clock repair does not authorize immediate retry');
      const repaired = store.listSummaryJobs(sessionId)[0];
      assert.equal(repaired.updatedAt, now);
      assert.equal(repaired.attempts, before.attempts);
      assert.equal(repaired.errorCode, before.errorCode);
      const delay = reason === 'budget' ? RETRY.budgetDelayMs : reason === 'shutdown' ? RETRY.unknownDelayMs
        : reason === 'second' ? RETRY.secondDelayMs : RETRY.firstDelayMs;
      for (let i = 0; i < 20; i++) assert.equal(store.claimNextSummaryJob(now + delay - 1), undefined);
      assert.equal(store.listSummaryJobs(sessionId)[0].updatedAt, now, 'scans do not slide the repaired deadline');
      assert.equal(store.claimNextSummaryJob(now + delay)?.id, job.id);
    } finally { await store.close(); }
  }
});

test('backdated failures and deferrals cannot shorten deadlines or move the job clock backwards', async () => {
  for (const reason of ['failure', 'budget', 'shutdown'] as const) {
    const { store, sessionId } = await fixture(3);
    try {
      const claimedAt = 2_000_000;
      store.endSession(sessionId, claimedAt, 'user_exit');
      const job = store.claimNextSummaryJob(claimedAt)!;
      if (reason === 'failure') store.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', 1);
      else store.deferSummaryJob(job.id, 1, reason);
      const delay = reason === 'failure' ? RETRY.firstDelayMs
        : reason === 'budget' ? RETRY.budgetDelayMs : RETRY.unknownDelayMs;
      assert.equal(store.listSummaryJobs(sessionId)[0].updatedAt, claimedAt);
      assert.equal(store.claimNextSummaryJob(claimedAt + delay - 1), undefined);
      assert.equal(store.claimNextSummaryJob(claimedAt + delay)?.id, job.id);
    } finally { await store.close(); }
  }
});

test('an old oversized range is replaced without mutating its identity or silently advancing coverage', async () => {
  const { store, sessionId } = await fixture(260);
  store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 520, createdAt: 5000 });
  store.endSession(sessionId, 6000, 'user_exit');
  let calls = 0;
  const service = new SessionSummaryService(store, { model: 'test', generate: async request => {
    calls++; return validSummary(request.throughSequence);
  } });
  try {
    await service.waitForIdle();
    assert.equal(calls, 3);
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 520);
    assert.equal(store.listSummaryJobs(sessionId)[0].throughSequence, 520);
    assert.equal(store.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_REBATCHED');
    assert.equal(store.hasBlockingSummaryJob(sessionId), false);
  } finally { await service.close(); await store.close(); }
});

test('a misaligned queued range becomes terminal without blocking a valid replacement', async () => {
  const { root, store, sessionId } = await fixture(4);
  const original = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    db.prepare('UPDATE summary_jobs SET from_sequence=2 WHERE id=?').run(original.id);
    assert.equal(store.claimNextSummaryJob(2000), undefined);
    assert.equal(store.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_RANGE_INVALID');
    assert.equal(store.hasBlockingSummaryJob(sessionId), false);
    const replacement = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 8, createdAt: 2001 });
    assert.equal(store.claimNextSummaryJob(2001)?.id, replacement.id);
  } finally { db.close(); await store.close(); }
});

test('completion rejects coverage drift during generation without writing any summary', async () => {
  const { root, store, sessionId } = await fixture(4);
  const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
  store.claimNextSummaryJob(1001);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    db.prepare('UPDATE sessions SET summary_through_sequence=2 WHERE id=?').run(sessionId);
    assert.throws(() => store.completeSummaryJob({ id: job.id, summary: validSummary(6), model: 'test', at: 1002 }), /range/i);
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 2);
    assert.equal(store.latestSummary(sessionId), undefined);
  } finally { db.close(); await store.close(); }
});

test('500 committed messages are accepted, and sparse sequence gaps are not mistaken for missing input', async () => {
  for (const sparse of [false, true]) {
    const { root, store, sessionId } = await fixture(sparse ? 260 : 250);
    const throughSequence = sparse ? 520 : 500;
    if (sparse) {
      const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
      db.prepare("UPDATE messages SET status='interrupted' WHERE session_id=? AND role='assistant' AND sequence<=80").run(sessionId);
      db.close();
    }
    store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence, createdAt: 5000 });
    store.endSession(sessionId, 6000, 'user_exit');
    let seen = 0;
    const service = new SessionSummaryService(store, { model: 'test', generate: async request => {
      seen += request.messages.length; return validSummary(request.throughSequence);
    } });
    try {
      await service.waitForIdle();
      assert.equal(seen, sparse ? 480 : 500);
      assert.equal(store.getSession(sessionId)?.summaryThroughSequence, throughSequence);
    } finally { await service.close(); await store.close(); }
  }
});

test('misaligned retry and unknown ranges are quarantined without reviving terminal failures', async () => {
  for (const state of ['failed', 'unknown', 'terminal'] as const) {
    const { root, store, sessionId } = await fixture(4);
    const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 1000 });
    store.claimNextSummaryJob(1001);
    if (state === 'unknown') store.deferSummaryJob(job.id, 1002, 'shutdown');
    else store.failSummaryJob(job.id, state === 'terminal' ? 'SUMMARY_GAVE_UP' : 'SUMMARY_MODEL_FAILED', 1002);
    const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
    try {
      db.prepare('UPDATE summary_jobs SET from_sequence=2 WHERE id=?').run(job.id);
      assert.equal(store.claimNextSummaryJob(2_000_000), undefined);
      assert.equal(store.listSummaryJobs(sessionId)[0].errorCode,
        state === 'terminal' ? 'SUMMARY_GAVE_UP' : 'SUMMARY_RANGE_INVALID');
      assert.equal(store.hasBlockingSummaryJob(sessionId), false);
      assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 0);
    } finally { db.close(); await store.close(); }
  }
});

test('a queued claim also preserves the job clock when the wall clock moves backwards', async () => {
  const { store, sessionId } = await fixture(3);
  try {
    store.endSession(sessionId, 2_000_000, 'user_exit');
    const job = store.claimNextSummaryJob(1)!;
    assert.equal(job.updatedAt, 2_000_000);
    store.failSummaryJob(job.id, 'SUMMARY_MODEL_FAILED', 2);
    assert.equal(store.claimNextSummaryJob(2_000_000 + RETRY.firstDelayMs - 1), undefined);
  } finally { await store.close(); }
});
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for scheduled work');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(turns = 6) {
  const root = await mkdtemp(join(tmpdir(), 'even-summary-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  const append = (index: number) => {
    const turnId = randomUUID(), inputId = randomUUID(), outputId = randomUUID(), at = 200 + index * 10;
    store.commitUserTurn({ sessionId, topicId, turnId, messageId: inputId,
      content: `问题 ${index}`, createdAt: at });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: outputId, createdAt: at + 1 });
    store.commitAssistantAnswer({ messageId: outputId, content: `回答 ${index}`, updatedAt: at + 2 });
  };
  for (let index = 0; index < turns; index++) append(index);
  return { root, store, sessionId, topicId, append };
}

function validSummary(throughSequence: number) {
  return {
    version: 1 as const,
    throughSequence,
    overview: '讨论了行程和产品设计。',
    topics: [{ id: 'topic', label: '产品设计', summary: '决定继续实现可靠会话。' }],
    confirmedDecisions: ['历史保留三年。'],
    unresolvedItems: ['等待真机测试。'],
  };
}

test('closing or expiring a session atomically queues six committed messages, not four', async () => {
  for (const close of ['end', 'expire'] as const) {
    for (const turns of [2, 3]) {
      const { store, sessionId } = await fixture(turns);
      try {
        if (close === 'end') store.endSession(sessionId, 500, 'user_exit');
        else store.expireSession(sessionId, 500);
        const jobs = store.listSummaryJobs(sessionId);
        assert.equal(jobs.length, turns === 3 ? 1 : 0);
        if (jobs.length) {
          assert.equal(jobs[0].fromSequence, 1);
          assert.equal(jobs[0].throughSequence, 6);
          assert.equal(jobs[0].status, 'queued');
        }
      } finally { await store.close(); }
    }
  }
});

test('summary enqueue failure rolls back closing the session', async () => {
  const { root, store, sessionId } = await fixture(3);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_summary BEFORE INSERT ON summary_jobs
      BEGIN SELECT RAISE(ABORT, 'injected enqueue failure'); END`);
    assert.throws(() => store.endSession(sessionId, 500, 'user_exit'), /injected enqueue failure/);
    assert.equal(store.getSession(sessionId)?.status, 'active');
    assert.equal(store.getSession(sessionId)?.endedAt, undefined);
    assert.deepEqual(store.listSummaryJobs(sessionId), []);
    db.exec('DROP TRIGGER reject_summary');
    store.endSession(sessionId, 501, 'user_exit');
    assert.equal(store.getSession(sessionId)?.status, 'ended');
    assert.equal(store.listSummaryJobs(sessionId).length, 1);
  } finally { db.close(); await store.close(); }
});

test('closing during generation preserves its range and completion queues the uncovered tail', async () => {
  const { store, sessionId, append } = await fixture(6);
  try {
    const first = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: 400 });
    assert.equal(store.claimNextSummaryJob(401)?.id, first.id);
    append(30);
    store.endSession(sessionId, 600, 'user_exit');
    assert.equal(store.listSummaryJobs(sessionId).length, 1);
    store.completeSummaryJob({ id: first.id, summary: validSummary(6), model: 'test', at: 601 });
    const jobs = store.listSummaryJobs(sessionId);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].fromSequence, 7);
    assert.equal(jobs[1].throughSequence, 14);
    assert.equal(jobs[1].status, 'queued');
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 6);
  } finally { await store.close(); }
});

test('closed session backlog drains in bounded batches after process restart', async () => {
  const { root, store, sessionId } = await fixture(205);
  store.endSession(sessionId, 5000, 'user_exit');
  assert.equal(store.listSummaryJobs(sessionId)[0].throughSequence, 200);
  await store.close();
  const reopened = await ConversationStore.create(root);
  const ranges: number[][] = [];
  const service = new SessionSummaryService(reopened, { model: 'test', generate: async request => {
    ranges.push([request.fromSequence, request.throughSequence]);
    return validSummary(request.throughSequence);
  } });
  try {
    await service.waitForIdle();
    assert.deepEqual(ranges, [[1, 200], [201, 400], [401, 410]]);
    assert.equal(reopened.getSession(sessionId)?.summaryThroughSequence, 410);
    assert.equal(reopened.listSummaryJobs(sessionId).every(job => job.status === 'completed'), true);
  } finally { await service.close(); await reopened.close(); }
});

test('closing wakes an already idle summary service without another user turn', async () => {
  const { store, sessionId } = await fixture(3);
  const service = new SessionSummaryService(store, { model: 'test', generate: async request => validSummary(request.throughSequence) });
  try {
    await service.waitForIdle();
    assert.equal(store.listSummaryJobs(sessionId).length, 0);
    store.endSession(sessionId, 500, 'user_exit');
    service.consider(sessionId);
    await service.waitForIdle();
    assert.equal(store.latestSummary(sessionId)?.throughSequence, 6);
  } finally { await service.close(); await store.close(); }
});

test('retention deletes expired queued and restart-unknown summaries without invoking a model', async () => {
  for (const claimed of [false, true]) {
    const { root, store, sessionId } = await fixture(3);
    store.endSession(sessionId, 500, 'user_exit');
    if (claimed) store.claimNextSummaryJob(501);
    await store.close();
    const reopened = await ConversationStore.create(root);
    try {
      assert.equal(reopened.listSummaryJobs(sessionId)[0].status, claimed ? 'unknown' : 'queued');
      const now = 1096 * 86400_000;
      assert.equal(reopened.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: true }).eligibleSessions, 1);
      assert.equal(reopened.listSummaryJobs(sessionId).length, 1, 'dry-run does not mutate jobs');
      assert.equal(reopened.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: false }).deletedSessions, 1);
      assert.equal(reopened.listSummaryJobs(sessionId).length, 0);
    } finally { await reopened.close(); }
  }
});

test('invalid summary schema is repaired once and saved at the fixed message boundary', async () => {
  const { store, sessionId } = await fixture();
  const attempts: string[] = [];
  const service = new SessionSummaryService(store, {
    model: 'summary-test',
    generate: async request => {
      attempts.push(request.attempt);
      return request.attempt === 'summarize' ? { overview: 7 } : validSummary(request.throughSequence);
    },
  }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    service.consider(sessionId);
    await service.waitForIdle();
    assert.deepEqual(attempts, ['summarize', 'repair']);
    const saved = store.latestSummary(sessionId);
    assert.equal(saved?.throughSequence, 10);
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 10);
    assert.equal(store.listSummaryJobs(sessionId)[0].status, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('two invalid schemas or a model failure do not block and fail the durable job', async () => {
  for (const generator of [
    async (_request: SessionSummaryGenerationRequest) => ({ wrong: true }),
    async (_request: SessionSummaryGenerationRequest) => { throw new Error('provider down'); },
  ]) {
    const { store, sessionId } = await fixture();
    const service = new SessionSummaryService(store, { model: 'summary-test', generate: generator },
      { messageThreshold: 8, keepRecentMessages: 2 });
    try {
      assert.doesNotThrow(() => service.consider(sessionId));
      await service.waitForIdle();
      assert.equal(store.latestSummary(sessionId), undefined);
      assert.equal(store.listSummaryJobs(sessionId)[0].status, 'failed');
    } finally { await service.close(); await store.close(); }
  }
});

test('same summary range is idempotent and a running job becomes unknown after restart', async () => {
  const { root, store, sessionId } = await fixture();
  const first = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 10, createdAt: 500 });
  const duplicate = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 10, createdAt: 501 });
  assert.equal(first.id, duplicate.id);
  assert.equal(store.claimNextSummaryJob(502)?.id, first.id);
  await store.close();

  const reopened = await ConversationStore.create(root); let calls = 0;
  const service = new SessionSummaryService(reopened, { model: 'summary-test', generate: async request => {
    calls++; return validSummary(request.throughSequence);
  } }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    assert.equal(reopened.listSummaryJobs(sessionId)[0].status, 'unknown');
    service.consider(sessionId);
    await service.waitForIdle();
    assert.equal(calls, 0, 'an uncertain provider outcome must not be billed twice');
  } finally { await service.close(); await reopened.close(); }
});

test('messages added while generation is running remain outside the immutable summary range', async () => {
  const { store, sessionId, append } = await fixture();
  const gate = deferred<unknown>(); let request!: SessionSummaryGenerationRequest;
  const service = new SessionSummaryService(store, { model: 'summary-test', generate: async input => {
    request = input; return gate.promise;
  } }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    service.consider(sessionId);
    while (!request) await tick();
    append(99);
    gate.resolve(validSummary(request.throughSequence));
    await service.waitForIdle();
    assert.equal(store.latestSummary(sessionId)?.throughSequence, 10);
    assert.equal(store.getSession(sessionId)?.latestSequence, 14);
    assert.deepEqual(request.messages.map(message => message.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { await service.close(); await store.close(); }
});

test('OpenAI summary generation uses the supplied metered fetch and exposes no tools', async () => {
  let meteredCalls = 0; let body: any; let idempotency = '';
  const meteredFetch: typeof fetch = async (_input, init) => {
    meteredCalls++;
    body = JSON.parse(String(init?.body));
    idempotency = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify(validSummary(8)) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const generator = new OpenAISessionSummaryGenerator('secret', 'summary-model',
    'https://api.openai.com/v1/responses', meteredFetch);
  const result = await generator.generate({
    jobId: randomUUID(), sessionId: randomUUID(), fromSequence: 1, throughSequence: 8,
    messages: [], attempt: 'summarize',
  }, new AbortController().signal);

  assert.equal(meteredCalls, 1);
  assert.equal(body.store, false);
  assert.equal('tools' in body, false);
  assert.equal(body.text.format.strict, true);
  assert.match(idempotency, /^session-summary-/);
  assert.deepEqual(result, validSummary(8));
});

test('production threshold keeps 58 messages raw and schedules exactly at 60', async () => {
  const { store, sessionId, append } = await fixture(29);
  const service = new SessionSummaryService(store, { model: 'summary-test', generate: async request => validSummary(request.throughSequence) });
  try {
    assert.equal(service.consider(sessionId), undefined);
    assert.equal(store.latestSummary(sessionId), undefined);
    append(30);
    const job = service.consider(sessionId);
    assert.ok(job); assert.equal(job?.throughSequence, 36, 'default policy keeps the latest 24 of 60 messages raw');
    await service.waitForIdle();
    assert.equal(store.latestSummary(sessionId)?.throughSequence, 36);
  } finally { await service.close(); await store.close(); }
});

test('timer retries one generation at bounded deadlines then observes the closed recovery cooldown', async () => {
  const { store, sessionId } = await fixture(3);
  let now = 1000, calls = 0;
  store.endSession(sessionId, now, 'user_exit');
  const original = store.listSummaryJobs(sessionId)[0];
  const service = new SessionSummaryService(store, { model: 'test', generate: async request => {
    calls++; assert.equal(request.jobId, original.id); throw new Error('synthetic failure');
  } }, { now: () => now, sweepIntervalMs: 10 });
  try {
    await service.waitForIdle();
    assert.equal(calls, 1);
    now += RETRY.firstDelayMs - 1;
    service.consider(sessionId); await service.waitForIdle();
    assert.equal(calls, 1);
    now++;
    await until(() => calls === 2); await service.waitForIdle();
    now += RETRY.secondDelayMs - 1;
    service.consider(sessionId); await service.waitForIdle();
    assert.equal(calls, 2);
    now++;
    await until(() => calls === 3); await service.waitForIdle();
    const job = store.listSummaryJobs(sessionId)[0];
    assert.equal(job.attempts, 3); assert.equal(job.errorCode, 'SUMMARY_GAVE_UP');
    assert.equal(job.fromSequence, 1); assert.equal(job.throughSequence, 6);
    now += 3600_000 - 1;
    for (let i = 0; i < 10; i++) service.consider(sessionId);
    await service.waitForIdle();
    assert.equal(calls, 3); assert.equal(store.listSummaryJobs(sessionId).length, 1);
  } finally { await service.close(); await store.close(); }
});

test('budget deferral survives restart, preserves attempts and recovers without user interaction', async () => {
  const { root, store, sessionId } = await fixture(3);
  let now = 1000;
  store.endSession(sessionId, now, 'user_exit');
  const service = new SessionSummaryService(store, { model: 'test', generate: async () => { throw new CostBudgetExceeded('openai'); } },
    { now: () => now });
  await service.waitForIdle(); await service.close();
  const deferredJob = store.listSummaryJobs(sessionId)[0];
  assert.equal(deferredJob.attempts, 0);
  assert.equal(deferredJob.errorCode, 'SUMMARY_BUDGET_DEFERRED');
  await store.close();
  const reopened = await ConversationStore.create(root); let calls = 0;
  now += RETRY.budgetDelayMs - 1;
  const resumed = new SessionSummaryService(reopened, { model: 'test', generate: async request => {
    calls++; return validSummary(request.throughSequence);
  } }, { now: () => now, sweepIntervalMs: 10 });
  try {
    await resumed.waitForIdle(); assert.equal(calls, 0);
    now++;
    await until(() => calls === 1); await resumed.waitForIdle();
    const finished = reopened.listSummaryJobs(sessionId)[0];
    assert.equal(finished.id, deferredJob.id); assert.equal(finished.attempts, 1);
    assert.equal(finished.status, 'completed');
  } finally { await resumed.close(); await reopened.close(); }
});

test('restart unknown waits five minutes then recovers the same job within the ten-minute target', async () => {
  const { root, store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  const original = store.claimNextSummaryJob(1001)!;
  await store.close();
  const reopened = await ConversationStore.create(root);
  let now = reopened.listSummaryJobs(sessionId)[0].updatedAt + RETRY.unknownDelayMs - 1, calls = 0;
  const service = new SessionSummaryService(reopened, { model: 'test', generate: async request => {
    calls++; assert.equal(request.jobId, original.id); return validSummary(request.throughSequence);
  } }, { now: () => now, sweepIntervalMs: 10 });
  try {
    await service.waitForIdle(); assert.equal(calls, 0);
    now++;
    await until(() => calls === 1); await service.waitForIdle();
    assert.equal(reopened.listSummaryJobs(sessionId)[0].status, 'completed');
    assert.equal(reopened.listSummaryJobs(sessionId)[0].attempts, 2);
  } finally { await service.close(); await reopened.close(); }
});

test('running claim protects retention and repeated timer ticks cannot start another worker', async () => {
  const { store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  let calls = 0; const gate = deferred<unknown>();
  const now = 1096 * 86400_000;
  const service = new SessionSummaryService(store, { model: 'test', generate: async () => { calls++; return gate.promise; } },
    { now: () => now, sweepIntervalMs: 10 });
  try {
    await until(() => calls === 1);
    for (let i = 0; i < 20; i++) service.consider(sessionId);
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(calls, 1); assert.equal(store.claimNextSummaryJob(now), undefined);
    assert.equal(store.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: false }).deletedSessions, 0);
    gate.resolve(validSummary(6)); await service.waitForIdle();
    assert.equal(store.cleanupExpiredSessions({ retentionDays: 1095, now, dryRun: false }).deletedSessions, 1);
  } finally { gate.resolve(validSummary(6)); await service.close(); await store.close(); }
});

test('shutdown aborts generation, rejects a late success and cancels future timer work', async () => {
  const { store, sessionId } = await fixture(3);
  store.endSession(sessionId, 1000, 'user_exit');
  let calls = 0, signal!: AbortSignal; const gate = deferred<unknown>();
  const service = new SessionSummaryService(store, { model: 'test', generate: async (_request, inputSignal) => {
    calls++; signal = inputSignal; return gate.promise;
  } }, { now: () => 2000, sweepIntervalMs: 10 });
  try {
    await until(() => calls === 1);
    const closing = service.close(); assert.equal(signal.aborted, true);
    gate.resolve(validSummary(6)); await closing;
    assert.equal(store.latestSummary(sessionId), undefined);
    assert.equal(store.listSummaryJobs(sessionId)[0].status, 'unknown');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 1);
  } finally { gate.resolve(validSummary(6)); await service.close(); await store.close(); }
});

test('budget waits between model failures neither erase failures nor exhaust remaining attempts', async () => {
  const { store, sessionId } = await fixture(3);
  let now = 1000, calls = 0;
  store.endSession(sessionId, now, 'user_exit');
  const service = new SessionSummaryService(store, { model: 'test', generate: async () => {
    calls++;
    if (calls === 2 || calls === 3) throw new CostBudgetExceeded('openai');
    throw new Error('model failure');
  } }, { now: () => now });
  try {
    await service.waitForIdle();
    for (const delay of [RETRY.firstDelayMs, RETRY.budgetDelayMs]) {
      now += delay; service.consider(sessionId); await service.waitForIdle();
      assert.equal(store.listSummaryJobs(sessionId)[0].attempts, 1);
    }
    now += RETRY.budgetDelayMs; service.consider(sessionId); await service.waitForIdle();
    assert.equal(store.listSummaryJobs(sessionId)[0].attempts, 2);
    now += RETRY.secondDelayMs; service.consider(sessionId); await service.waitForIdle();
    assert.equal(calls, 5);
    assert.equal(store.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_GAVE_UP');
  } finally { await service.close(); await store.close(); }
});

test('third-attempt process loss becomes terminal on restart rather than a fourth model call', async () => {
  const { root, store, sessionId } = await fixture(3);
  let now = 1000;
  store.endSession(sessionId, now, 'user_exit');
  const first = store.claimNextSummaryJob(now)!;
  store.failSummaryJob(first.id, 'SUMMARY_MODEL_FAILED', now);
  now += RETRY.firstDelayMs;
  assert.equal(store.claimNextSummaryJob(now)?.id, first.id);
  store.failSummaryJob(first.id, 'SUMMARY_MODEL_FAILED', now);
  now += RETRY.secondDelayMs;
  assert.equal(store.claimNextSummaryJob(now)?.attempts, 3);
  await store.close();
  const reopened = await ConversationStore.create(root);
  let calls = 0;
  const service = new SessionSummaryService(reopened, { model: 'test', generate: async () => { calls++; return validSummary(6); } });
  try {
    await service.waitForIdle();
    assert.equal(calls, 0);
    assert.equal(reopened.listSummaryJobs(sessionId)[0].errorCode, 'SUMMARY_GAVE_UP');
    assert.equal(reopened.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: Date.now() }).id, first.id);
    assert.equal(reopened.listSummaryJobs(sessionId)[0].status, 'failed');
  } finally { await service.close(); await reopened.close(); }
});

test('closed summaries leave only sub-threshold committed tails for the future prior-context reader', async () => {
  for (const tail of [0, 2, 4, 6]) {
    const { store, sessionId } = await fixture(100 + tail / 2);
    store.endSession(sessionId, 5000, 'user_exit');
    const service = new SessionSummaryService(store, { model: 'test', generate: async request => validSummary(request.throughSequence) });
    try {
      await service.waitForIdle();
      const session = store.getSession(sessionId)!;
      const remaining = store.listCommittedMessages(sessionId, session.summaryThroughSequence, session.latestSequence + 1, 12);
      assert.equal(remaining.length, tail < 6 ? tail : 0);
      assert.ok(remaining.length < 6 && remaining.length <= 12);
    } finally { await service.close(); await store.close(); }
  }
});

test('deferred range blocks overlapping new work and a second service cannot steal a running claim', async () => {
  const { store, sessionId } = await fixture(4);
  let now = 1000;
  const original = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 6, createdAt: now });
  store.claimNextSummaryJob(now);
  store.failSummaryJob(original.id, 'SUMMARY_MODEL_FAILED', now);
  assert.throws(() => store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 8, createdAt: now }), /already active/);
  now += RETRY.firstDelayMs;
  const gate = deferred<unknown>(); let calls = 0;
  const generator = { model: 'test', generate: async () => { calls++; return gate.promise; } };
  const first = new SessionSummaryService(store, generator, { now: () => now, sweepIntervalMs: 10 });
  const second = new SessionSummaryService(store, generator, { now: () => now, sweepIntervalMs: 10 });
  try {
    await until(() => calls === 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 1);
    gate.resolve(validSummary(6));
    await first.waitForIdle(); await second.waitForIdle();
    assert.equal(store.listSummaryJobs(sessionId).length, 1);
  } finally { gate.resolve(validSummary(6)); await first.close(); await second.close(); await store.close(); }
});
