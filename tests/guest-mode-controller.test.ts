import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { GuestModeController, type GuestTransitionConnection } from '../src/guest-mode-controller.js';
import { parseGuestModeCommand } from '../src/guest-mode-protocol.js';
import { GuestRuntimePool } from '../src/guest-runtime.js';
import { lockedDevicePrincipal, type AccessPrincipal } from '../src/guest-access.js';
import { Conversation, type Event } from '../src/conversation.js';

const token = 'test-only-owner-token-'.repeat(3);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-guest-transition-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const pool = new GuestRuntimePool(store, () => ({ model: { decide: async () => 'respond', reply: async () => {} },
    generate: async () => { throw new Error('not expected'); } })); t.after(() => pool.close());
  const diagnostics: object[] = [];
  const controller = new GuestModeController(store, token, pool, e => diagnostics.push(e)); t.after(() => controller.close());
  const clientId = randomUUID(); store.registerClient({ id: clientId, at: 100 });
  const attach = (client = clientId, principal: AccessPrincipal = { mode: 'owner', ownerScope: 'single-user' }) => {
    const events: any[] = [], actions: string[] = [];
    const connection: GuestTransitionConnection = { connectionId: randomUUID(), clientId: client, principal,
      cutOff: () => { actions.push('cut'); }, detach: async () => { actions.push('detach'); },
      notify: event => { assert.ok(actions.includes('cut')); events.push(event); actions.push('notify'); },
      close: () => { actions.push('close'); } };
    controller.registerAuthenticated(connection);
    return { connection, actions, events };
  };
  return { root, store, pool, controller, clientId, attach, diagnostics };
}

test('enter commits lock before notification, cuts all quiet device connections and releases without waiting for close', async t => {
  const { store, pool, controller, clientId, attach } = await fixture(t);
  const first = attach(), quiet = attach();
  const otherId = randomUUID(); store.registerClient({ id: otherId, at: 100 }); const other = attach(otherId);
  await controller.enter(first.connection.connectionId);
  assert.ok(store.getDeviceGuestLock(clientId)); assert.equal(store.getDeviceAccessEpoch(clientId), 1);
  assert.deepEqual(first.actions, ['cut', 'detach', 'notify', 'close']);
  assert.deepEqual(quiet.actions, ['cut', 'detach', 'close']); assert.deepEqual(other.actions, []);
  assert.deepEqual(first.events, [{ type: 'access.changed', mode: 'guest', clear_display: true, clear_resume: true, reconnect: true }]);
  await assert.rejects(controller.enter(first.connection.connectionId), /DENIED/);
  assert.equal(pool.size, 0);
});

test('failed lock write closes old connection without a success notice or orphaned guest session', async t => {
  const { store, root, controller, clientId, attach } = await fixture(t); const current = attach();
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite')); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_enter BEFORE INSERT ON device_guest_locks BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await assert.rejects(controller.enter(current.connection.connectionId), /injected/);
  assert.equal(store.getDeviceGuestLock(clientId), undefined); assert.equal(store.getDeviceAccessEpoch(clientId), 0);
  assert.deepEqual(current.events, []); assert.deepEqual(current.actions, ['cut', 'detach', 'close']);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE owner_scope LIKE 'guest:%'").get() as any).n, 0);
});

test('fresh-owner unlock closes guests, frees runtime, and never promotes an existing socket', async t => {
  const { store, pool, controller, clientId, attach } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 }), principal = lockedDevicePrincipal(lock, 'single-user');
  pool.acquireAuthenticated(clientId, principal);
  const a = attach(clientId, principal), b = attach(clientId, principal);
  const begin = await controller.handle(a.connection.connectionId, { type: 'guest.unlock.begin', command_id: randomUUID() });
  assert.equal(begin?.type, 'guest.unlock.challenge');
  await controller.handle(a.connection.connectionId, { type: 'guest.unlock.confirm', command_id: randomUUID(), challenge: begin!.challenge, owner_token: token });
  assert.equal(store.getDeviceGuestLock(clientId), undefined); assert.equal(store.getSession(lock.sessionId)?.status, 'ended');
  assert.equal(pool.size, 0); assert.ok(b.actions.includes('cut'));
  assert.deepEqual(a.events, [{ type: 'access.changed', mode: 'reauthorize', clear_display: true, clear_resume: true, reconnect: false }]);
  await assert.rejects(controller.confirmUnlock(a.connection.connectionId, begin!.challenge, token), /DENIED/);
});

test('wrong token consumes challenge, disconnect cancels challenge and unauthenticated calls cannot mutate', async t => {
  const { store, controller, clientId, attach } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 }), principal = lockedDevicePrincipal(lock, 'single-user');
  const a = attach(clientId, principal), id = a.connection.connectionId;
  const first = controller.beginUnlock(id);
  await assert.rejects(controller.confirmUnlock(id, first.challenge, 'wrong'), /DENIED/);
  await assert.rejects(controller.confirmUnlock(id, first.challenge, token), /DENIED/);
  const second = controller.beginUnlock(id); controller.unregister(id);
  await assert.rejects(controller.confirmUnlock(id, second.challenge, token), /DENIED/);
  await assert.rejects(controller.enter(randomUUID()), /DENIED/);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock); assert.deepEqual(a.events, []);
});

test('external rapid lock/unlock revokes old registered owner even though lock is absent', async t => {
  const { store, controller, clientId, attach } = await fixture(t); const a = attach();
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  store.releaseDeviceGuestLock({ clientId, expected: lock, at: 102 });
  await controller.sweepInvalid();
  assert.deepEqual(a.actions, ['cut', 'detach', 'close']);
  await assert.rejects(controller.enter(a.connection.connectionId), /DENIED/);
});

test('expiry and twenty rebinds do not accumulate stale runtimes; closed pool cannot reopen', async t => {
  const { store, pool, controller, clientId, attach } = await fixture(t);
  let lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  for (let i = 0; i < 20; i++) {
    const principal = lockedDevicePrincipal(lock, 'single-user');
    pool.acquireAuthenticated(clientId, principal); assert.equal(pool.size, 1);
    const connection = attach(clientId, principal);
    store.expireSession(lock.sessionId, 200 + i * 2);
    await controller.sweepInvalid(); assert.equal(pool.size, 0); assert.ok(connection.actions.includes('close'));
    lock = store.ensureDeviceGuestSession({ clientId, at: 201 + i * 2 });
  }
  pool.close(); assert.throws(() => pool.acquireAuthenticated(clientId, lockedDevicePrincipal(lock, 'single-user')), /DENIED/);
});

test('acquire evicts externally rebound runtime even if transport forgot explicit release', async t => {
  const { store, pool, clientId } = await fixture(t);
  const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
  const old = pool.acquireAuthenticated(clientId, lockedDevicePrincipal(lock, 'single-user'));
  store.expireSession(lock.sessionId, 102);
  const next = store.ensureDeviceGuestSession({ clientId, at: 103 });
  const fresh = pool.acquireAuthenticated(clientId, lockedDevicePrincipal(next, 'single-user'));
  assert.notEqual(fresh, old); assert.equal(pool.size, 1); assert.throws(() => old.assertAccess(), /DENIED/);
});

test('cleanup callback failure cannot suppress other disconnects or leak token in diagnostics', async t => {
  const { store, controller, clientId, diagnostics } = await fixture(t); const actions: string[] = [];
  const connectionId = randomUUID();
  controller.registerAuthenticated({ connectionId, clientId, principal: { mode: 'owner', ownerScope: 'single-user' },
    cutOff: () => { throw new Error(token); }, detach: async () => { throw new Error(token); },
    notify: () => { throw new Error(token); }, close: () => { actions.push('closed'); } });
  await controller.enter(connectionId);
  assert.ok(store.getDeviceGuestLock(clientId)); assert.deepEqual(actions, ['closed']);
  assert.equal(diagnostics.length, 3); assert.doesNotMatch(JSON.stringify(diagnostics), /test-only-owner/);
});

test('command parser rejects guest=false, extra credentials, accessors and malformed confirmation', () => {
  const id = randomUUID();
  assert.deepEqual(parseGuestModeCommand({ type: 'guest.enter', command_id: id }), { type: 'guest.enter', command_id: id });
  for (const value of [null, [], { type: 'guest.enter', command_id: id, guest: false },
    { type: 'guest.unlock.confirm', command_id: id, challenge: 'x'.repeat(43), owner_token: token, device_credential: token },
    { type: 'guest.unlock.confirm', command_id: id, challenge: 'short', owner_token: token },
    { type: 'guest.unlock.confirm', command_id: id, challenge: 'x'.repeat(43), owner_token: '' },
    { get type() { throw new Error('getter must not run'); }, command_id: id }]) {
    assert.throws(() => parseGuestModeCommand(value), /Invalid conversation protocol message/);
  }
});

test('busy reply produces a natural notice and does not automatically retry', async () => {
  const events: Event[] = []; let calls = 0;
  const conversation = new Conversation({ decide: async () => 'respond', reply: async () => { calls++; throw new Error('GUEST_RUNTIME_BUSY'); } },
    event => events.push(event));
  await conversation.submit('帮我整理这段', true);
  assert.equal(calls, 1); assert.equal(conversation.state, 'paused');
  const notice = events.find(e => e.type === 'notice' && e.code === 'GUEST_RUNTIME_BUSY');
  assert.match(String(notice?.text), /上一条请求仍在处理/);
  assert.equal(events.some(e => e.type === 'error'), false); conversation.close();
});
