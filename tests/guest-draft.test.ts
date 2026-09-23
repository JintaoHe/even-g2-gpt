import { DROP_HISTORY_INDEX_SQL } from './history-index-fixture.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { GuestDraftRuntime } from '../src/guest-draft-runtime.js';
import { lockedDevicePrincipal } from '../src/guest-access.js';
import { presentation } from '../src/document-presentation.js';

const document = { markdown: '# Guest note\nOnly this session', presentation: presentation('Guest note', 'A note', 'summary') };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-guest-draft-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const guest = () => {
    const clientId = randomUUID(); store.registerClient({ id: clientId, at: 100 });
    const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
    return { clientId, lock, principal: lockedDevicePrincipal(lock, 'single-user') };
  };
  return { root, store, guest };
}

test('guest drafts survive restart but cannot be read by owner or another guest', async t => {
  const { store, root, guest } = await fixture(t); const a = guest(), b = guest();
  const saved = store.saveGuestDraft(a.principal, document, 102);
  assert.equal(store.readGuestDraft(b.principal, saved.id), undefined);
  assert.throws(() => store.readGuestDraft({ mode: 'owner', ownerScope: 'single-user' }, saved.id), /DENIED/);
  await store.close();
  const reopened = await ConversationStore.create(root); t.after(() => reopened.close());
  assert.deepEqual(reopened.readGuestDraft(a.principal, saved.id), saved);
});

test('guest draft limits bound UTF-8 storage and generated filenames', async t => {
  const { store, guest } = await fixture(t); const a = guest();
  assert.throws(() => store.saveGuestDraft(a.principal, { ...document, markdown: '汉'.repeat(90_000) }, 102), /LIMIT/);
  const unsafe = { ...document, presentation: { ...document.presentation, filename: '../../owner.env' } };
  assert.equal(store.saveGuestDraft(a.principal, unsafe, 102).document.presentation.filename, 'Guest note.md');
  for (let i = 0; i < 7; i++) store.saveGuestDraft(a.principal, document, 103 + i);
  assert.throws(() => store.saveGuestDraft(a.principal, document, 110), /LIMIT/);
});

test('unlock denies draft access and retention cascades guest draft rows', async t => {
  const { store, root, guest } = await fixture(t); const a = guest();
  const saved = store.saveGuestDraft(a.principal, document, 102);
  store.releaseDeviceGuestLock({ clientId: a.clientId, expected: a.lock, at: 103 });
  assert.throws(() => store.readGuestDraft(a.principal, saved.id), /DENIED/);
  assert.throws(() => store.saveGuestDraft(a.principal, document, 104), /DENIED/);
  store.cleanupExpiredSessions({ retentionDays: 1, now: 200_000_000, dryRun: false, ownerScope: a.lock.guestScope });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM guest_drafts').get() as any).n, 0);
});

test('draft runtime uses only bound guest history and own previous draft', async t => {
  const { store, guest } = await fixture(t); const a = guest(), b = guest();
  for (const [g, content] of [[a, 'Visitor A request'], [b, 'SECRET B']] as const) {
    const topicId = store.listTopics(g.lock.sessionId)[0].id;
    store.commitUserTurn({ sessionId: g.lock.sessionId, topicId, turnId: randomUUID(), messageId: randomUUID(), content, createdAt: 102 });
  }
  let calls = 0;
  const runtime = new GuestDraftRuntime(store, a.clientId, a.principal, async (history, kind, previous) => {
    calls++;
    assert.equal(history.length, 1); assert.equal(history[0].content, 'Visitor A request');
    assert.equal(previous?.document.markdown, kind === 'revise' ? document.markdown : undefined);
    return { document };
  });
  await runtime.create('document', new AbortController().signal);
  await runtime.create('revise', new AbortController().signal);
  assert.equal(calls, 2);
  await assert.rejects(runtime.create('calendar' as any, new AbortController().signal), /DENIED/);
  assert.equal(calls, 2);
  assert.throws(() => new GuestDraftRuntime(store, b.clientId, a.principal, async () => ({ document })), /DENIED/);
});

test('unlock while generating rejects late result and concurrent generation is bounded', async t => {
  const { store, guest } = await fixture(t); const a = guest();
  let resolve!: (value: { document: typeof document }) => void;
  const runtime = new GuestDraftRuntime(store, a.clientId, a.principal,
    () => new Promise(r => { resolve = r; }));
  const pending = runtime.create('document', new AbortController().signal);
  await assert.rejects(runtime.create('document', new AbortController().signal), /BUSY/);
  store.releaseDeviceGuestLock({ clientId: a.clientId, expected: a.lock, at: 103 });
  resolve({ document });
  await assert.rejects(pending, /DENIED/);
  assert.throws(() => runtime.read(), /DENIED/);
});

test('v12 migration preserves existing locks and rolls back atomically on failure', async t => {
  const { store, root, guest } = await fixture(t); const a = guest(); await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version=12;
    CREATE TRIGGER fail_v12 BEFORE INSERT ON schema_migrations WHEN NEW.version=12
    BEGIN SELECT RAISE(ABORT,'v12 rollback'); END;`);
  await assert.rejects(ConversationStore.create(root), /v12 rollback/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='guest_drafts'").get(), undefined);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 11);
  db.exec('DROP TRIGGER fail_v12');
  const reopened = await ConversationStore.create(root); t.after(() => reopened.close());
  assert.deepEqual(reopened.getDeviceGuestLock(a.clientId), a.lock);
  assert.equal(reopened.getDeviceAccessEpoch(a.clientId), 1);
  assert.equal(reopened.readGuestDraft(a.principal), undefined);
});

test('corrupt draft fails closed and never falls back to a different guest', async t => {
  const { store, root, guest } = await fixture(t); const a = guest(), b = guest();
  const saved = store.saveGuestDraft(a.principal, document, 102);
  store.saveGuestDraft(b.principal, document, 102);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  for (const bad of ['not json', '{}', JSON.stringify({ ...document, presentation: { ...document.presentation, partial: 'false' } })]) {
    db.prepare('UPDATE guest_drafts SET document_json=? WHERE id=?').run(bad, saved.id);
    assert.throws(() => store.readGuestDraft(a.principal), /INVALID/);
    assert.equal(store.readGuestDraft(b.principal)!.document.markdown, document.markdown);
  }
});

test('expired guest runtime stays revoked after rebind and rejects empty revisions', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  const runtime = new GuestDraftRuntime(store, a.clientId, a.principal, async () => { calls++; return { document }; });
  await assert.rejects(runtime.create('revise', new AbortController().signal), /NOT_FOUND/);
  store.expireSession(a.lock.sessionId, 103);
  store.ensureDeviceGuestSession({ clientId: a.clientId, at: 104 });
  await assert.rejects(runtime.create('document', new AbortController().signal), /DENIED/);
  assert.equal(calls, 0);
});

test('capacity and aborted requests are rejected before generation; partial metadata survives', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  const runtime = new GuestDraftRuntime(store, a.clientId, a.principal, async () => { calls++; return { document }; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.create('document', controller.signal));
  const partial = { ...document, presentation: { ...document.presentation, partial: true,
    incompleteSections: [2, 4], compressedSections: [1] } };
  const saved = store.saveGuestDraft(a.principal, partial, 102);
  assert.deepEqual(store.readGuestDraft(a.principal, saved.id)!.document.presentation, partial.presentation);
  for (let i = 0; i < 7; i++) store.saveGuestDraft(a.principal, document, 103 + i);
  await assert.rejects(runtime.create('document', new AbortController().signal), /LIMIT/);
  assert.equal(calls, 0);
});

test('generator errors release single-flight and a calendar result is never persisted', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  const runtime = new GuestDraftRuntime(store, a.clientId, a.principal, async () => {
    if (++calls === 1) throw new Error('test failure');
    if (calls === 2) return { document, calendar: {} as any };
    return { clarification: 'Which topic?' };
  });
  await assert.rejects(runtime.create('document', new AbortController().signal), /test failure/);
  await assert.rejects(runtime.create('document', new AbortController().signal), /DENIED/);
  assert.deepEqual(await runtime.create('document', new AbortController().signal), { clarification: 'Which topic?' });
  assert.equal(runtime.read(), undefined);
});
