import { DROP_HISTORY_INDEX_SQL } from './history-index-fixture.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { GuestUnlock } from '../src/guest-unlock.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-guest-lock-'));
  const store = await ConversationStore.create(root), clientId = randomUUID();
  t.after(() => store.close());
  store.registerClient({ id: clientId, at: 100 });
  return { root, store, clientId };
}

test('access epoch survives unlock and restart, changes only in committed lock transactions', async t => {
  const { root, store, clientId } = await fixture(t);
  assert.equal(store.getDeviceAccessEpoch(clientId), 0);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  assert.equal(store.getDeviceAccessEpoch(clientId), 1);
  store.enterDeviceGuestMode({ clientId, at: 102 });
  assert.equal(store.getDeviceAccessEpoch(clientId), 1);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_unlock BEFORE DELETE ON device_guest_locks
    BEGIN SELECT RAISE(ABORT,'injected rollback'); END;`);
  assert.throws(() => store.releaseDeviceGuestLock({ clientId, expected: lock, at: 103 }), /injected rollback/);
  assert.equal(store.getDeviceAccessEpoch(clientId), 1);
  db.exec('DROP TRIGGER reject_unlock');
  store.releaseDeviceGuestLock({ clientId, expected: lock, at: 104 });
  assert.equal(store.getDeviceAccessEpoch(clientId), 2);
  await store.close();
  const reopened = await ConversationStore.create(root); t.after(() => reopened.close());
  assert.equal(reopened.getDeviceAccessEpoch(clientId), 2);
  reopened.registerClient({ id: clientId, at: 105 });
  assert.equal(reopened.getDeviceAccessEpoch(clientId), 2);
});

test('database triggers track external lock changes and remain device scoped', async t => {
  const { root, store, clientId } = await fixture(t);
  const other = randomUUID(); store.registerClient({ id: other, at: 100 });
  store.enterDeviceGuestMode({ clientId, at: 101 });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.prepare('UPDATE device_guest_locks SET created_at=? WHERE client_id=?').run(102, clientId);
  assert.equal(store.getDeviceAccessEpoch(clientId), 2);
  db.prepare('DELETE FROM device_guest_locks WHERE client_id=?').run(clientId);
  assert.equal(store.getDeviceAccessEpoch(clientId), 3);
  assert.equal(store.getDeviceAccessEpoch(other), 0);
});

test('v11 migration failure rolls back the epoch column and triggers', async t => {
  const { root, store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`DROP TRIGGER guest_lock_insert_epoch; DROP TRIGGER guest_lock_update_epoch; DROP TRIGGER guest_lock_delete_epoch;
    ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=11;
    CREATE TRIGGER fail_v11 BEFORE INSERT ON schema_migrations WHEN NEW.version=11
    BEGIN SELECT RAISE(ABORT,'v11 rollback'); END;`);
  await assert.rejects(ConversationStore.create(root), /v11 rollback/);
  assert.equal((db.prepare('PRAGMA table_info(clients)').all() as any[]).some(x => x.name === 'access_epoch'), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='guest_lock_insert_epoch'").get(), undefined);
  db.exec('DROP TRIGGER fail_v11');
  const reopened = await ConversationStore.create(root); t.after(() => reopened.close());
  assert.deepEqual(reopened.getDeviceGuestLock(clientId), lock);
  assert.equal(reopened.getDeviceAccessEpoch(clientId), 0);
  reopened.releaseDeviceGuestLock({ clientId, expected: lock, at: 200 });
  assert.equal(reopened.getDeviceAccessEpoch(clientId), 1);
});

test('closing or expiring populated guest sessions never queues closing summaries', async t => {
  const { store, clientId } = await fixture(t);
  for (const expire of [false, true]) {
    const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
    const sessionId = lock.sessionId, topicId = store.listTopics(sessionId)[0].id;
    for (let i = 0; i < 8; i++) {
      const turnId = randomUUID(), messageId = randomUUID(), at = 200 + i * 10;
      store.commitUserTurn({ sessionId, topicId, turnId, messageId: randomUUID(), content: '访客问题', createdAt: at });
      store.startAssistantAnswer({ sessionId, topicId, turnId, messageId, createdAt: at + 1 });
      store.commitAssistantAnswer({ messageId, content: '访客回答', updatedAt: at + 2 });
    }
    if (expire) store.expireSession(sessionId, 1000);
    else store.endSession(sessionId, 1000, 'user_exit');
    store.recoverClosedSummaries(1000 + 3600_000);
    assert.deepEqual(store.listSummaryJobs(sessionId), []);
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 0);
    store.releaseDeviceGuestLock({ clientId, expected: lock, at: 1100 });
  }
});

test('guest lock and independent guest session persist together across restart', async t => {
  const { root, store, clientId } = await fixture(t);
  assert.equal(store.getDeviceGuestLock(clientId), undefined);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  assert.equal(store.getSession(lock.sessionId)?.ownerScope, lock.guestScope);
  assert.deepEqual(store.enterDeviceGuestMode({ clientId, at: 102 }), lock);
  await store.close();
  const reopened = await ConversationStore.create(root);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getDeviceGuestLock(clientId), lock);
  assert.deepEqual(reopened.enterDeviceGuestMode({ clientId, at: 200 }), lock);
});

test('session end, expiry and retention never remove the device lock', async t => {
  const { root, store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  store.endSession(lock.sessionId, 102, 'user_exit');
  store.cleanupExpiredSessions({ retentionDays: 1, now: 200_000_000, dryRun: false, ownerScope: lock.guestScope });
  assert.equal(store.getSession(lock.sessionId), undefined);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => db.prepare('DELETE FROM clients WHERE id=?').run(clientId));
  assert.deepEqual(store.enterDeviceGuestMode({ clientId, at: 200_000_001 }), lock);
  const second = randomUUID(); store.registerClient({ id: second, at: 100 });
  const expired = store.enterDeviceGuestMode({ clientId: second, at: 101 });
  store.expireSession(expired.sessionId, 102);
  assert.deepEqual(store.getDeviceGuestLock(second), expired);
});

test('failed lock insert rolls back the new session, unknown clients cannot leave orphans', async t => {
  const { root, store, clientId } = await fixture(t);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  t.after(() => db.close());
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  const before = count();
  db.exec(`CREATE TRIGGER fail_lock BEFORE INSERT ON device_guest_locks
    BEGIN SELECT RAISE(ABORT,'injected lock failure'); END;`);
  assert.throws(() => store.enterDeviceGuestMode({ clientId, at: 101 }), /injected/);
  assert.equal(count(), before);
  assert.equal(store.getDeviceGuestLock(clientId), undefined);
  db.exec('DROP TRIGGER fail_lock');
  assert.throws(() => store.enterDeviceGuestMode({ clientId: randomUUID(), at: 101 }));
  assert.equal(count(), before);
  store.enterDeviceGuestMode({ clientId, at: 102 });
});

test('corrupt lock or database failure is never interpreted as unlocked', async t => {
  const { root, store, clientId } = await fixture(t);
  store.enterDeviceGuestMode({ clientId, at: 101 });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  t.after(() => db.close());
  db.prepare('UPDATE device_guest_locks SET guest_scope=? WHERE client_id=?').run('single-user', clientId);
  assert.throws(() => store.getDeviceGuestLock(clientId), /GUEST_ACCESS_DENIED/);
  assert.throws(() => store.enterDeviceGuestMode({ clientId, at: 102 }), /GUEST_ACCESS_DENIED/);
  db.exec('DROP TABLE device_guest_locks');
  assert.throws(() => store.getDeviceGuestLock(clientId));
  await store.close();
  assert.throws(() => store.getDeviceGuestLock(clientId), /closed/);
});

test('different devices receive different guest scopes and sessions', async t => {
  const { store, clientId } = await fixture(t);
  const other = randomUUID(); store.registerClient({ id: other, at: 100 });
  const a = store.enterDeviceGuestMode({ clientId, at: 101 });
  const b = store.enterDeviceGuestMode({ clientId: other, at: 101 });
  assert.notEqual(a.guestScope, b.guestScope);
  assert.notEqual(a.sessionId, b.sessionId);
});

test('v10 migration preserves v9 data and rolls back entirely on failure', async t => {
  const { root, store, clientId } = await fixture(t);
  const id = randomUUID(); store.createSession({ id, ownerScope: 'single-user', createdAt: 100 });
  await store.close();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  t.after(() => db.close());
  db.exec(DROP_HISTORY_INDEX_SQL);
  db.exec(`DROP TABLE device_guest_locks; ALTER TABLE clients DROP COLUMN access_epoch; DROP TABLE guest_drafts; DELETE FROM schema_migrations WHERE version>=10;
    CREATE TRIGGER fail_v10 BEFORE INSERT ON schema_migrations WHEN NEW.version=10
    BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;`);
  await assert.rejects(ConversationStore.create(root), /injected migration/);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v, 9);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='device_guest_locks'").get(), undefined);
  db.exec('DROP TRIGGER fail_v10');
  const reopened = await ConversationStore.create(root); t.after(() => reopened.close());
  assert.equal(reopened.health().schemaVersion, 16);
  assert.equal(reopened.getSession(id)?.ownerScope, 'single-user');
  reopened.enterDeviceGuestMode({ clientId, at: 101 });
});

test('unlock requires fresh owner secret plus a one-shot connection-bound challenge', async t => {
  const { store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  let now = 0;
  const service = new GuestUnlock(store, 'owner-test-secret', () => now);
  const attempt = (challenge: string, ownerToken: unknown, connectionId = 'new') =>
    service.confirm({ connectionId, clientId, challenge, ownerToken, at: 200 });
  const first = service.begin('new', clientId);
  assert.throws(() => attempt(first, 'owner-test-secret', 'old'), /GUEST_ACCESS_DENIED/);
  assert.throws(() => attempt(first, 'saved-device-secret'), /GUEST_ACCESS_DENIED/);
  assert.throws(() => attempt(first, 'owner-test-secret'), /GUEST_ACCESS_DENIED/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
  const expired = service.begin('new', clientId); now = 60_000;
  assert.throws(() => attempt(expired, 'owner-test-secret'), /GUEST_ACCESS_DENIED/);
  const cancelled = service.begin('new', clientId); service.cancel('new');
  assert.throws(() => attempt(cancelled, 'owner-test-secret'), /GUEST_ACCESS_DENIED/);
  const valid = service.begin('new', clientId);
  attempt(valid, 'owner-test-secret');
  assert.equal(store.getDeviceGuestLock(clientId), undefined);
  assert.throws(() => attempt(valid, 'owner-test-secret'), /GUEST_ACCESS_DENIED/);
});

test('unlock atomically revokes credentials and rolls back on database failure', async t => {
  const { root, store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  const credential = store.issueResumeCredential({ clientId, sessionId: lock.sessionId, createdAt: 102, expiresAt: 5000 });
  const device = store.issueDeviceCredential({ clientId, createdAt: 102, expiresAt: 5000, persistDeadlineAt: 1000 });
  const service = new GuestUnlock(store, 'owner-test-secret');
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_unlock BEFORE DELETE ON device_guest_locks
    BEGIN SELECT RAISE(ABORT,'injected unlock failure'); END;`);
  const confirm = () => service.confirm({ connectionId: 'new', clientId,
    challenge: service.begin('new', clientId), ownerToken: 'owner-test-secret', at: 200 });
  assert.throws(confirm, /injected unlock/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
  assert.equal(store.getSession(lock.sessionId)?.status, 'active');
  assert.equal(store.getSession(lock.sessionId)?.endedAt, undefined);
  const revoked = () => (db.prepare('SELECT revoked_at FROM resume_credentials WHERE id=?').get(credential.id) as { revoked_at: number | null }).revoked_at;
  assert.equal(revoked(), null);
  assert.equal((db.prepare('SELECT revoked_at FROM device_credentials WHERE id=?').get(device.id) as any).revoked_at, null);
  db.exec('DROP TRIGGER fail_unlock'); confirm();
  assert.equal(revoked(), 200);
  assert.equal((db.prepare('SELECT revoked_at FROM device_credentials WHERE id=?').get(device.id) as any).revoked_at, 200);
  assert.equal(store.getDeviceGuestLock(clientId), undefined);
  assert.equal(store.getSession(lock.sessionId)?.status, 'ended');
  assert.equal(store.getSession(lock.sessionId)?.endedAt, 200);
});

test('unlock ends active and idle guest sessions, then normal retention removes them', async t => {
  const { store, clientId } = await fixture(t);
  const owner = randomUUID(); store.createSession({ id: owner, ownerScope: 'single-user', createdAt: 100 });
  for (const idle of [false, true]) {
    const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
    if (idle) store.markSessionDetached(lock.sessionId, 102);
    store.releaseDeviceGuestLock({ clientId, expected: lock, at: 200 });
    assert.equal(store.getSession(lock.sessionId)?.endReason, 'guest_unlock');
    assert.deepEqual(store.listSummaryJobs(lock.sessionId), []);
    store.cleanupExpiredSessions({ retentionDays: 1, now: 200_000_000, dryRun: false, ownerScope: lock.guestScope });
    assert.equal(store.getSession(lock.sessionId), undefined);
  }
  assert.equal(store.getSession(owner)?.status, 'active');
});

test('unlock preserves terminal guest timestamps and tolerates already-retained sessions', async t => {
  const { store, clientId } = await fixture(t);
  for (const removed of [false, true]) {
    const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
    store.expireSession(lock.sessionId, 120);
    const before = store.getSession(lock.sessionId);
    if (removed) store.cleanupExpiredSessions({ retentionDays: 1, now: 200_000_000, dryRun: false, ownerScope: lock.guestScope });
    store.releaseDeviceGuestLock({ clientId, expected: lock, at: 200 });
    assert.deepEqual(store.getSession(lock.sessionId), removed ? undefined : before);
    assert.equal(store.getDeviceGuestLock(clientId), undefined);
  }
});

test('session-ending failure rolls back unlock without revoking credentials', async t => {
  const { root, store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  const credential = store.issueResumeCredential({ clientId, sessionId: lock.sessionId, createdAt: 102, expiresAt: 5000 });
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_guest_end BEFORE UPDATE OF status ON sessions
    WHEN NEW.end_reason='guest_unlock' BEGIN SELECT RAISE(ABORT,'injected guest end failure'); END;`);
  assert.throws(() => store.releaseDeviceGuestLock({ clientId, expected: lock, at: 200 }), /injected guest end/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
  assert.equal(store.getSession(lock.sessionId)?.status, 'active');
  assert.equal((db.prepare('SELECT revoked_at FROM resume_credentials WHERE id=?').get(credential.id) as any).revoked_at, null);
});

test('restarting unlock service invalidates challenges and a stale lock cannot unlock a new guest', async t => {
  const { store, clientId } = await fixture(t);
  const old = store.enterDeviceGuestMode({ clientId, at: 101 });
  const service = new GuestUnlock(store, 'owner-test-secret');
  const challenge = service.begin('new', clientId);
  const request = { connectionId: 'new', clientId, challenge, ownerToken: 'owner-test-secret', at: 200 };
  assert.throws(() => new GuestUnlock(store, 'owner-test-secret').confirm(request), /GUEST_ACCESS_DENIED/);
  store.releaseDeviceGuestLock({ clientId, expected: old, at: 150 });
  const current = store.enterDeviceGuestMode({ clientId, at: 151 });
  assert.throws(() => service.confirm(request), /GUEST_ACCESS_DENIED/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), current);
});

test('challenge client binding, time anomalies and bounded capacity fail closed', async t => {
  const { store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  let now = 100;
  const service = new GuestUnlock(store, 'owner-test-secret', () => now);
  const challenge = service.begin('connection', clientId);
  assert.throws(() => service.confirm({ connectionId: 'connection', clientId: randomUUID(),
    challenge, ownerToken: 'owner-test-secret', at: 200 }), /GUEST_ACCESS_DENIED/);
  const rollback = service.begin('connection', clientId); now = 99;
  assert.throws(() => service.confirm({ connectionId: 'connection', clientId,
    challenge: rollback, ownerToken: 'owner-test-secret', at: 200 }), /GUEST_ACCESS_DENIED/);
  now = 100;
  for (let i = 0; i < 4; i++) service.begin(`connection-${i}`, clientId);
  assert.throws(() => service.begin('overflow', clientId), /GUEST_ACCESS_DENIED/);
  const other = randomUUID(); store.registerClient({ id: other, at: 101 });
  store.enterDeviceGuestMode({ clientId: other, at: 102 });
  assert.equal(typeof service.begin('other-device', other), 'string');
  now += 60_000;
  assert.equal(typeof service.begin('overflow', clientId), 'string');
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
});

test('expired guest session is rebound atomically to a fresh scope and initial topic', async t => {
  const { store, clientId } = await fixture(t);
  const old = store.enterDeviceGuestMode({ clientId, at: 101 });
  assert.equal(store.listTopics(old.sessionId).length, 1);
  assert.deepEqual(store.ensureDeviceGuestSession({ clientId, at: 102 }), old);
  store.expireSession(old.sessionId, 103);
  const next = store.ensureDeviceGuestSession({ clientId, at: 104 });
  assert.notEqual(next.sessionId, old.sessionId);
  assert.notEqual(next.guestScope, old.guestScope);
  assert.equal(store.listTopics(next.sessionId).length, 1);
  assert.deepEqual(store.getDeviceGuestLock(clientId), next);
  assert.equal(store.getSession(old.sessionId)?.status, 'expired');
  assert.deepEqual(store.ensureDeviceGuestSession({ clientId, at: 105 }), next);
});

test('rebind failure rolls back new session and topic, preserving the old lock', async t => {
  const { root, store, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  store.endSession(lock.sessionId, 102, 'user_exit');
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  const counts = () => db.prepare('SELECT (SELECT COUNT(*) FROM sessions) AS s,(SELECT COUNT(*) FROM topics) AS t').get();
  const before = counts();
  db.exec(`CREATE TRIGGER fail_rebind BEFORE UPDATE ON device_guest_locks
    BEGIN SELECT RAISE(ABORT,'injected rebind failure'); END;`);
  assert.throws(() => store.ensureDeviceGuestSession({ clientId, at: 103 }), /injected rebind/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
  assert.deepEqual(counts(), before);
});

test('retained guest session can be replaced but absent or corrupt locks never create one', async t => {
  const { root, store, clientId } = await fixture(t);
  assert.throws(() => store.ensureDeviceGuestSession({ clientId, at: 101 }), /GUEST_ACCESS_DENIED/);
  const old = store.enterDeviceGuestMode({ clientId, at: 101 });
  store.endSession(old.sessionId, 102, 'user_exit');
  store.cleanupExpiredSessions({ retentionDays: 1, now: 200_000_000, dryRun: false, ownerScope: old.guestScope });
  const next = store.ensureDeviceGuestSession({ clientId, at: 200_000_001 });
  assert.notEqual(next.sessionId, old.sessionId);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.prepare('UPDATE sessions SET owner_scope=? WHERE id=?').run('single-user', next.sessionId);
  assert.throws(() => store.ensureDeviceGuestSession({ clientId, at: 200_000_002 }), /GUEST_ACCESS_DENIED/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), next);
});
