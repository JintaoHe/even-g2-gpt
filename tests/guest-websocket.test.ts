import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { ConversationStore } from '../src/conversation-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { GuestRuntimePool } from '../src/guest-runtime.js';

const token = 'test-only-owner-key-'.repeat(4);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'guest-ws-'));
  let store = await ConversationStore.create(directory);
  const inputs: string[] = [];
  const makePool = () => new GuestRuntimePool(store, () => ({ model: {
    decide: async () => 'respond', plan: async () => ({ decision: 'respond' }),
    reply: async (history, _signal, delta) => { inputs.push(JSON.stringify(history)); delta('访客回答'); },
  }, generate: async () => { throw Error('not used'); } }));
  let pool = makePool();
  const makeApp = () => createConversationServer({ token, conversationStore: store, guestRuntimes: pool,
    model: { decide: async () => 'respond', reply: async (_h, _s, delta) => { delta('OWNER_PRIVATE'); } },
    transcriber: () => { throw Error('not used'); } });
  let app = makeApp();
  const clients: WebSocket[] = [];
  t.after(async () => { clients.forEach(c => c.terminate()); await app.close(); await store.close(); });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  let url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  async function restart() {
    await app.close(); await store.close();
    store = await ConversationStore.create(directory); pool = makePool(); app = makeApp();
    app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
    url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  }
  async function connect(clientId: string, credential: object) {
    const c = new WebSocket(url); clients.push(c); await once(c, 'open');
    const events: any[] = [];
    c.on('message', raw => events.push(JSON.parse(raw.toString())));
    const wait = async (type: string) => {
      const deadline = Date.now() + 3000;
      while (!events.some(e => e.type === type)) {
        if (Date.now() > deadline) throw Error(`Missing ${type}: ${JSON.stringify(events.map(e => [e.type,e.code]))}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return events.find(e => e.type === type);
    };
    const send = (value: { type: string; [key: string]: unknown }) => c.send(JSON.stringify({
      ...(value.type.startsWith('guest.') ? { command_id: randomUUID() } : {}), ...value }));
    c.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      credential_storage: 'browser_v1', client_capabilities: { location: false, guest_mode: true }, ...credential }));
    return { c, events, wait, send };
  }
  async function enter() {
    const clientId = randomUUID(), owner = await connect(clientId, { token });
    const ready = await owner.wait('ready');
    owner.send({ type: 'text.submit', text: '主人秘密', message_id: randomUUID() }); await owner.wait('answer.done');
    const closed = once(owner.c, 'close'); owner.send({ type: 'guest.enter' });
    assert.equal((await owner.wait('access.changed')).mode, 'guest'); await closed;
    const guest = await connect(clientId, { device_credential: ready.device_credential });
    const guestReady = await guest.wait('ready');
    return { clientId, owner, ready, guest, guestReady };
  }
  return { get store() { return store; }, get pool() { return pool; }, connect, enter, inputs, restart, directory };
}

test('actual WS transition isolates snapshots, private commands, and uses guest model only', { timeout: 10000 }, async t => {
  const f = await fixture(t), { guest, guestReady, ready } = await f.enter();
  assert.equal(guestReady.access_mode, 'guest'); assert.notEqual(guestReady.session_id, ready.session_id);
  assert.equal(JSON.stringify(guestReady).includes('OWNER_PRIVATE'), false);
  assert.equal(guestReady.capabilities.calendar, false); assert.equal(guestReady.capabilities.email, false);
  for (const type of ['jobs.list', 'calendar.list', 'jobs.export']) guest.send({ type });
  await guest.wait('notice');
  guest.send({ type: 'text.submit', text: '附近公园怎么选', message_id: randomUUID() });
  await guest.wait('answer.done');
  assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].includes('主人秘密'), false);
  assert.equal(guest.events.some(e => /^(jobs|calendar)\./.test(e.type)), false);
});

test('guest same-client live takeover resumes own snapshot and late close cannot revoke replacement', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guest, guestReady } = await f.enter();
  guest.send({ type: 'text.submit', text: 'guest-only question', message_id: randomUUID() }); await guest.wait('answer.done');
  const replacement = await f.connect(clientId, { resume_session_id: guestReady.session_id, resume_credential: guestReady.resume_credential });
  const ready = await replacement.wait('ready');
  assert.equal(ready.resumed, true); assert.equal(ready.access_mode, 'guest'); assert.equal(ready.snapshot.messages.length, 2);
  replacement.send({ type: 'text.submit', text: '接着聊', message_id: randomUUID() }); await replacement.wait('answer.done');
  assert.equal(f.pool.size, 1);
});

test('fresh-owner unlock ends guest session, releases runtime, requires a new master login', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guest, guestReady } = await f.enter();
  guest.send({ type: 'guest.unlock.begin' }); const challenge = await guest.wait('guest.unlock.challenge');
  const closed = once(guest.c, 'close');
  guest.send({ type: 'guest.unlock.confirm', challenge: challenge.challenge, owner_token: token });
  const changed = await guest.wait('access.changed'); await closed;
  assert.equal(changed.mode, 'reauthorize'); assert.equal(changed.reconnect, false);
  assert.equal(f.pool.size, 0); assert.equal(f.store.getSession(guestReady.session_id)?.status, 'ended');
  const denied = await f.connect(clientId, { device_credential: guestReady.device_credential });
  assert.equal((await denied.wait('error')).code, 'DEVICE_CREDENTIAL_INVALID');
  const owner = await f.connect(clientId, { token });
  assert.equal((await owner.wait('ready')).access_mode, 'owner');
});

test('guest expired binding reconnects under a fresh guest scope, never as owner', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guest, guestReady } = await f.enter();
  const closed = once(guest.c, 'close'); guest.c.close(); await closed;
  f.store.expireSession(guestReady.session_id, Date.now());
  const next = await f.connect(clientId, { device_credential: guestReady.device_credential });
  const ready = await next.wait('ready');
  assert.equal(ready.access_mode, 'guest'); assert.notEqual(ready.session_id, guestReady.session_id);
  assert.deepEqual(ready.snapshot.messages, []); assert.equal(f.pool.size, 1);
});

test('service restart retains guest identity and same-session history using scoped resume only', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guest, guestReady } = await f.enter();
  guest.send({ type: 'text.submit', text: '游客要逛植物园', message_id: randomUUID() }); await guest.wait('answer.done');
  await f.restart();
  const reopened = await f.connect(clientId, { resume_session_id: guestReady.session_id, resume_credential: guestReady.resume_credential });
  const ready = await reopened.wait('ready');
  assert.equal(ready.access_mode, 'guest'); assert.equal(ready.session_id, guestReady.session_id);
  assert.equal(ready.resumed, true); assert.equal(ready.snapshot.messages.length, 2);
  assert.equal(JSON.stringify(ready.snapshot).includes('主人秘密'), false);
});

test('restart outside recovery window uses device proof to rebind a new guest session', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guestReady } = await f.enter();
  await f.restart();
  // Public transitions deliberately preserve monotonic timestamps. Simulate
  // elapsed offline time in this disposable database, not by backdating an API.
  const db = new DatabaseSync(join(f.directory, 'assistant-memory.sqlite'));
  try { db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now() - 16 * 60_000, guestReady.session_id); }
  finally { db.close(); }
  const reopened = await f.connect(clientId, { device_credential: guestReady.device_credential });
  const ready = await reopened.wait('ready');
  assert.equal(ready.access_mode, 'guest'); assert.notEqual(ready.session_id, guestReady.session_id);
  assert.equal(f.store.getSession(guestReady.session_id)?.status, 'expired');
  assert.deepEqual(ready.snapshot.messages, []);
});

test('text guest command switches before model submission and no master secret enters history', { timeout: 10000 }, async t => {
  const f = await fixture(t), clientId = randomUUID();
  const owner = await f.connect(clientId, { token }); const ready = await owner.wait('ready');
  owner.send({ type: 'text.submit', text: '进入访客模式', message_id: randomUUID() });
  await owner.wait('access.changed');
  assert.deepEqual(f.store.listMessages(ready.session_id), []);
  assert.equal(f.inputs.length, 0);
});

test('wrong fresh unlock proof keeps lock and does not expose owner snapshot', { timeout: 10000 }, async t => {
  const f = await fixture(t), { clientId, guest, guestReady } = await f.enter();
  guest.send({ type: 'guest.unlock.begin' }); const challenge = await guest.wait('guest.unlock.challenge');
  guest.send({ type: 'guest.unlock.confirm', challenge: challenge.challenge, owner_token: 'wrong'.repeat(16) });
  await guest.wait('error');
  assert.equal(f.store.getDeviceGuestLock(clientId)?.sessionId, guestReady.session_id);
  assert.equal(guest.events.some(e => e.type === 'access.changed'), false);
  assert.equal(JSON.stringify(f.store.listMessages(guestReady.session_id)).includes(token), false);
});
