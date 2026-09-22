import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ConversationStore } from '../src/conversation-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import type { DialogueModel } from '../src/conversation.js';

const token = 'test-only-owner-token-'.repeat(4);

test('legacy and unknown-version hellos cannot bypass a locked client or touch storage', { timeout: 10000 }, async t => {
  const { store, denied } = await fixture(t);
  const clientId = randomUUID();
  store.registerClient({ id: clientId, at: Date.now() });
  store.enterDeviceGuestMode({ clientId, at: Date.now() });
  let reads = 0, creates = 0;
  store.getDeviceGuestLock = () => { reads++; throw Error('must reject before storage'); };
  store.createSession = () => { creates++; throw Error('must not create owner'); };
  for (const protocol_version of [undefined, null, 1, 3, '2']) {
    await denied({ protocol_version, client_id: clientId, token, client_capabilities: { guest_mode: true } }, 'INVALID_MESSAGE');
  }
  assert.equal(reads, 0); assert.equal(creates, 0);
});
async function fixture(t: TestContext, model: DialogueModel = {
  decide: async () => 'respond', reply: async () => { throw new Error('must not reach model'); },
}, transcriber: Parameters<typeof createConversationServer>[0]['transcriber'] = () => { throw new Error('must not reach audio'); }) {
  const store = await ConversationStore.create(await mkdtemp(join(tmpdir(), 'even-guest-boundary-')));
  const app = createConversationServer({ token, conversationStore: store,
    model,
    transcriber });
  const clients: WebSocket[] = [];
  t.after(async () => { for (const c of clients) c.terminate(); await app.close(); await store.close(); });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  async function denied(hello: object, code = 'SESSION_UNAVAILABLE') {
    const c = new WebSocket(url); clients.push(c); await once(c, 'open');
    const events: any[] = []; c.on('message', data => events.push(JSON.parse(data.toString())));
    const closed = once(c, 'close'); c.send(JSON.stringify({ type: 'hello', protocol_version: 2, ...hello }));
    await closed;
    assert.deepEqual(events, [{ type: 'error', code }]);
  }
  async function openOwner() {
    const clientId = randomUUID(), c = new WebSocket(url); clients.push(c); await once(c, 'open');
    const events: any[] = [];
    const ready = new Promise<any>(resolve => c.on('message', data => {
      const event = JSON.parse(data.toString()); events.push(event);
      if (event.type === 'ready') resolve(event);
    }));
    c.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
    return { c, clientId, events, ready: await ready };
  }
  return { store, denied, openOwner };
}

test('locked device cannot hydrate owner history or create owner runtime with any credential', { timeout: 10_000 }, async t => {
  const { store, denied } = await fixture(t);
  const clientId = randomUUID(), ownerId = randomUUID(), now = Date.now();
  store.registerClient({ id: clientId, at: now });
  store.createSession({ id: ownerId, ownerScope: 'single-user', createdAt: now,
    initialTopic: { id: randomUUID(), label: 'Private owner topic' } });
  store.markSessionDetached(ownerId, now);
  const resume = store.issueResumeCredential({ clientId, sessionId: ownerId, createdAt: now, expiresAt: now + 60_000 });
  const device = store.issueDeviceCredential({ clientId, createdAt: now, expiresAt: now + 120_000, persistDeadlineAt: now + 60_000 });
  const lock = store.enterDeviceGuestMode({ clientId, at: now });
  let historyReads = 0, creates = 0;
  store.listRecentMessages = () => { historyReads++; throw new Error('private history read'); };
  store.createSession = () => { creates++; throw new Error('owner runtime created'); };
  await denied({ client_id: clientId, token });
  await denied({ client_id: clientId, device_credential: device.secret, credential_storage: 'even_host_v1' }, 'DEVICE_CREDENTIAL_INVALID');
  await denied({ client_id: clientId, resume_session_id: ownerId, resume_credential: resume.secret });
  assert.equal(historyReads, 0); assert.equal(creates, 0);
  assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
});

test('unlocked owner cannot resume a guest resource even with genuine matching credentials', { timeout: 10_000 }, async t => {
  const { store, denied } = await fixture(t);
  const ownerClient = randomUUID(), guestClient = randomUUID(), now = Date.now();
  for (const id of [ownerClient, guestClient]) store.registerClient({ id, at: now });
  const lock = store.enterDeviceGuestMode({ clientId: guestClient, at: now });
  const resume = store.issueResumeCredential({ clientId: ownerClient, sessionId: lock.sessionId,
    createdAt: now, expiresAt: now + 60_000 });
  let reads = 0;
  store.listRecentMessages = () => { reads++; throw new Error('guest history read'); };
  await denied({ client_id: ownerClient, resume_session_id: lock.sessionId, resume_credential: resume.secret });
  assert.equal(reads, 0);
});

test('database lock lookup failure refuses authentication without creating a runtime', { timeout: 10_000 }, async t => {
  const { store, denied } = await fixture(t);
  store.getDeviceGuestLock = () => { throw new Error('injected database read failure'); };
  let creates = 0; store.createSession = () => { creates++; throw new Error('unexpected create'); };
  await denied({ client_id: randomUUID(), token }, 'INVALID_MESSAGE');
  assert.equal(creates, 0);
});

test('wrong master tokens cannot probe guest locks and never read lock state', { timeout: 10_000 }, async t => {
  const { store, denied } = await fixture(t);
  const locked = randomUUID(), unlocked = randomUUID(), at = Date.now();
  for (const id of [locked, unlocked]) store.registerClient({ id, at });
  store.enterDeviceGuestMode({ clientId: locked, at });
  let reads = 0;
  const read = store.getDeviceGuestLock.bind(store);
  store.getDeviceGuestLock = id => { reads++; return read(id); };
  for (const clientId of [locked, unlocked]) {
    await denied({ client_id: clientId, token: 'wrong-token-'.repeat(8) }, 'INVALID_MESSAGE');
  }
  assert.equal(reads, 0);
});

test('forged device credentials have identical rejection codes for locked and unlocked devices', { timeout: 10_000 }, async t => {
  const { store, denied } = await fixture(t);
  const locked = randomUUID(), unlocked = randomUUID(), at = Date.now();
  for (const id of [locked, unlocked]) store.registerClient({ id, at });
  store.enterDeviceGuestMode({ clientId: locked, at });
  for (const clientId of [locked, unlocked]) await denied({ client_id: clientId,
    device_credential: `${randomUUID()}.${'x'.repeat(43)}`, credential_storage: 'even_host_v1' }, 'DEVICE_CREDENTIAL_INVALID');
});

test('locking an authenticated device blocks every old input before tool or model handling', { timeout: 15_000 }, async t => {
  for (const type of ['jobs.list', 'calendar.list', 'jobs.export', 'jobs.email', 'text.submit', 'audio']) {
    await t.test(type, async child => {
      let calls = 0;
      const { store, openOwner } = await fixture(child, {
        decide: async () => { calls++; return 'respond'; }, reply: async () => { calls++; },
      });
      const { c, clientId, events, ready } = await openOwner();
      const lock = store.enterDeviceGuestMode({ clientId, at: Date.now() });
      const closed = once(c, 'close');
      if (type === 'audio') c.send(Buffer.alloc(640));
      else c.send(JSON.stringify({ type, message_id: randomUUID(), text: '读取主人的日历' }));
      const [code] = await closed;
      assert.equal(code, 4003);
      assert.equal(calls, 0);
      assert.equal(store.listMessages(ready.session_id).length, 0);
      assert.deepEqual(store.getDeviceGuestLock(clientId), lock);
      assert.equal(events.some(e => /^(jobs\.|job\.|answer\.|transcript\.|calendar\.)/.test(e.type)), false);
    });
  }
});

test('a late owner reply is not delivered after device lock, while its work stays in the owner session', { timeout: 10_000 }, async t => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const { store, openOwner } = await fixture(t, { decide: async () => 'respond',
    reply: async (_h, _s, delta) => { started(); await pending; delta('private owner result'); } });
  const { c, clientId, events, ready } = await openOwner();
  c.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'owner request' }));
  await began;
  const lock = store.enterDeviceGuestMode({ clientId, at: Date.now() });
  const closed = once(c, 'close'); release(); await closed;
  assert.equal(events.some(e => JSON.stringify(e).includes('private owner result')), false);
  assert.equal(store.listMessages(lock.sessionId).length, 0);
  assert.equal(store.getSession(ready.session_id)?.ownerScope, 'single-user');
});

test('lock storage failure after authentication closes the old connection without data', { timeout: 10_000 }, async t => {
  const { store, openOwner } = await fixture(t);
  const { c, events } = await openOwner();
  store.getDeviceGuestLock = () => { throw new Error('injected storage failure'); };
  const closed = once(c, 'close'); c.send(JSON.stringify({ type: 'jobs.list' }));
  const [code] = await closed;
  assert.equal(code, 4003);
  assert.equal(events.some(e => e.type === 'jobs.list'), false);
});

test('silent owner connection is revoked after lock then unlock without any intervening traffic', { timeout: 10_000 }, async t => {
  let calls = 0;
  const { store, openOwner } = await fixture(t, { decide: async () => { calls++; return 'respond'; }, reply: async () => {} });
  const { c, clientId, ready } = await openOwner();
  const closed = once(c, 'close');
  const lock = store.enterDeviceGuestMode({ clientId, at: Date.now() });
  store.releaseDeviceGuestLock({ clientId, expected: lock, at: Date.now() });
  assert.equal(store.getDeviceGuestLock(clientId), undefined);
  const [code] = await closed; // No inbound message or model output triggers this.
  assert.equal(code, 4003);
  assert.equal(calls, 0);
  assert.equal(store.listMessages(ready.session_id).length, 0);
  const replacement = await openOwner(); // Idle old connection no longer owns the lease.
  assert.ok(replacement.ready.session_id);
});

test('lock-unlock is also rejected synchronously before the next input, without waiting for sweep', { timeout: 10_000 }, async t => {
  let calls = 0;
  const { store, openOwner } = await fixture(t, { decide: async () => { calls++; return 'respond'; }, reply: async () => {} });
  const { c, clientId } = await openOwner();
  const closed = once(c, 'close');
  const lock = store.enterDeviceGuestMode({ clientId, at: Date.now() });
  store.releaseDeviceGuestLock({ clientId, expected: lock, at: Date.now() });
  c.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'old connection must stay revoked' }));
  const [code] = await closed;
  assert.equal(code, 4003);
  assert.equal(calls, 0);
});

test('late transcription after locking is cancelled and never submitted as a new turn', { timeout: 10_000 }, async t => {
  let resolveText!: (text: string) => void, started!: () => void, cancelled = 0, calls = 0;
  const result = new Promise<string>(resolve => { resolveText = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const { store, openOwner } = await fixture(t, {
    decide: async () => { calls++; return 'respond'; }, reply: async () => { calls++; },
  }, () => { started(); return { result, push() {}, finish() {}, cancel() { cancelled++; } }; });
  const { c, clientId, events, ready } = await openOwner();
  const loud = Buffer.alloc(6400);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(4000, i);
  c.send(loud); await began;
  store.enterDeviceGuestMode({ clientId, at: Date.now() });
  const closed = once(c, 'close'); resolveText('private old audio'); await closed;
  assert.ok(cancelled >= 1);
  assert.equal(calls, 0);
  assert.equal(store.listMessages(ready.session_id).length, 0);
  assert.equal(events.some(e => JSON.stringify(e).includes('private old audio')), false);
});
