import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionController, reconnectDelay, type SocketLike } from '../src/connection-controller.ts';
import { SessionCredentialStore } from '../src/session-credential.ts';

const clientId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
let uuidCounter = 0;
const uuid = () => `${String(++uuidCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;

class FakeSocket implements SocketLike {
  readyState = 0; bufferedAmount = 0; sent: any[] = [];
  onopen: null | (() => void) = null; onclose: null | (() => void) = null;
  onerror: null | (() => void) = null; onmessage: null | ((event: { data: unknown }) => void) = null;
  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

async function fixture(onEvent?: (event: any) => unknown) {
  const data = new Map<string, string>();
  const host = { getLocalStorage: async (key: string) => data.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { data.set(key, value); return true; } };
  const credentials = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  const sockets: FakeSocket[] = [], statuses: any[] = [], events: any[] = [], timers = new Map<number, () => void>();
  let timerId = 0;
  const controller = new ConnectionController({ url: () => 'ws://test', socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; },
    credentials, onEvent: event => { events.push(event); return onEvent?.(event); }, onStatus: status => statuses.push(status), random: () => 0.5,
    uuid, setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id as any; },
    clearTimer: id => { timers.delete(id as any); } });
  const ready = (ws: FakeSocket, resumed = false) => ws.message({ type: 'ready', protocol_version: 2,
    connection_id: uuid(), session_id: sessionId, resumed, latest_sequence: 4,
    resume_credential: 's'.repeat(32), resume_expires_at: 1_000, snapshot: { state: 'listening', messages: [] } });
  return { controller, credentials, sockets, statuses, events, timers, ready };
}

test('jitter stays within 80-120 percent and backoff caps at 30 seconds', () => {
  assert.equal(reconnectDelay(0, () => 0), 400);
  assert.equal(reconnectDelay(0, () => 1), 600);
  assert.equal(reconnectDelay(99, () => 0.5), 30_000);
});

test('guest switch clears owner resume and token, drops late events, and reconnects with device proof only', async () => {
  const f = await fixture();
  await f.credentials.saveDevice({ clientId, id: '33333333-3333-4333-8333-333333333333', secret: 'd'.repeat(32), expiresAt: 2000 });
  f.controller.connect('t'.repeat(32)); const old = f.sockets[0]; old.open(); f.ready(old);
  old.message({ type: 'access.changed', mode: 'guest', clear_display: true, clear_resume: true, reconnect: true });
  old.message({ type: 'answer.delta', text: 'OWNER_SECRET' });
  await f.credentials.whenSettled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.credentials.load(), undefined); assert.equal(f.sockets.length, 2);
  f.sockets[1].open(); assert.equal(f.sockets[1].sent[0].device_credential, 'd'.repeat(32));
  assert.equal(f.sockets[1].sent[0].token, undefined); assert.equal(f.sockets[1].sent[0].resume_session_id, undefined);
  assert.equal(f.events.some(e => e.text === 'OWNER_SECRET'), false);
  f.sockets[1].message({ type: 'access.changed', mode: 'reauthorize', clear_display: true, clear_resume: true, reconnect: false });
  await f.credentials.whenSettled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.credentials.loadDevice(), undefined); assert.equal(f.timers.size, 0);
  assert.equal(f.controller.networkAvailable(), false); assert.equal(f.controller.connect(), false);
  f.controller.dispose();
});

test('unannounced access revocation cannot silently fall back to the cached owner token', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  (ws as SocketLike).onclose?.({ code: 4003 });
  await f.credentials.whenSettled();
  assert.equal(f.timers.size, 0); assert.equal(f.controller.networkAvailable(), false);
  assert.equal(f.events.at(-1).type, 'transport.cleared');
  f.controller.dispose();
});

test('guest reconnect waits for the physical display barrier and fails closed on a rejected clear', async () => {
  let reject!: (error: Error) => void;
  const barrier = new Promise<void>((_resolve, no) => { reject = no; });
  const f = await fixture(event => event.type === 'access.changed' ? barrier : undefined);
  await f.credentials.saveDevice({ clientId, id: '33333333-3333-4333-8333-333333333333', secret: 'd'.repeat(32), expiresAt: 2000 });
  f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  ws.message({ type: 'access.changed', mode: 'guest', reconnect: true });
  await f.credentials.whenSettled(); assert.equal(f.sockets.length, 1);
  reject(Error('SDK failed')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sockets.length, 1); assert.equal(f.controller.networkAvailable(), false);
  assert.equal(f.events.some(e => e.type === 'notice' && /清屏未确认/.test(e.text)), true);
  f.controller.dispose();
});

test('Even client advertises location support on every authentication path', async () => {
  const f = await fixture();
  // Use a dedicated socket because the fixture controller is intentionally
  // configured without capabilities to preserve backwards-compatibility tests.
  const socket = new FakeSocket();
  const capable = new ConnectionController({ url: () => 'ws://test', socket: () => socket,
    credentials: f.credentials, onEvent: () => {}, clientCapabilities: { location: true }, uuid });
  assert.equal(capable.connect('t'.repeat(32)), true); socket.open();
  assert.deepEqual(socket.sent[0].client_capabilities, { location: true, guest_mode: true });
  capable.dispose();
});

test('initial auth uses protocol v2 and reconnect resumes with the saved scoped credential', async () => {
  const f = await fixture(); assert.equal(f.controller.connect('t'.repeat(32)), true);
  const first = f.sockets[0]; first.open();
  assert.deepEqual(first.sent[0], { type: 'hello', protocol_version: 2, client_id: clientId,
    credential_storage: 'even_host_v1', client_capabilities: { location: false, guest_mode: true }, token: 't'.repeat(32) });
  f.ready(first); first.drop();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open();
  assert.deepEqual(second.sent[0], { type: 'hello', protocol_version: 2, client_id: clientId,
    credential_storage: 'even_host_v1', client_capabilities: { location: false, guest_mode: true }, resume_session_id: sessionId,
    resume_credential: 's'.repeat(32), last_seen_sequence: 0 });
  f.ready(second, true);
  assert.equal(f.controller.status.reason, 'resumed');
});

test('network restoration cancels the pending timer and reconnects immediately', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); f.sockets[0].open(); f.ready(f.sockets[0]); f.sockets[0].drop();
  assert.equal(f.timers.size, 1); assert.equal(f.controller.networkAvailable(), true);
  assert.equal(f.timers.size, 0); assert.equal(f.sockets.length, 2);
});

test('only one retry timer exists and stale socket events are ignored', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first); first.drop(); first.drop();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open(); const count = f.events.length;
  first.message({ type: 'notice', text: 'stale' });
  assert.equal(f.events.length, count);
});

test('expired resume credential fails closed then uses only the in-memory access token for a fresh session', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first); first.drop();
  [...f.timers.values()][0](); const resumed = f.sockets[1]; resumed.open();
  resumed.message({ type: 'error', code: 'SESSION_UNAVAILABLE' }); resumed.drop();
  [...f.timers.values()][0](); const fresh = f.sockets[2]; fresh.open();
  assert.equal(fresh.sent[0].token, 't'.repeat(32));
  assert.equal('resume_credential' in fresh.sent[0], false);
  assert.equal(f.statuses.some(status => status.reason === 'credential_expired'), true);
});

test('send assigns stable idempotency identifiers and credential refresh replaces the stored secret', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.send({ type: 'text.submit', text: 'hello' }), true);
  assert.match(ws.sent.at(-1).message_id, /^[0-9a-f-]{36}$/i);
  assert.equal(f.controller.send({ type: 'pause' }), true);
  assert.match(ws.sent.at(-1).command_id, /^[0-9a-f-]{36}$/i);
  ws.message({ type: 'resume.credential', session_id: sessionId, resume_credential: 'n'.repeat(32), resume_expires_at: 2_000 });
  assert.equal(f.credentials.load()?.secret, 'n'.repeat(32));
});

test('device credential is ACKed only after native host storage returns true', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open();
  const deviceId = '33333333-3333-4333-8333-333333333333';
  ws.message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
    resumed: false, latest_sequence: 0, resume_credential: 's'.repeat(32), resume_expires_at: 1_000,
    device_credential_id: deviceId, device_credential: 'd'.repeat(32), device_expires_at: 2_000,
    device_persist_deadline_at: 500, snapshot: { messages: [] } });
  await f.credentials.whenSettled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.credentials.loadDevice()?.id, deviceId);
  assert.deepEqual(ws.sent.at(-1), { type: 'credential.persisted', credential_id: deviceId });
});

test('cold start uses the scoped device credential without persisting or requiring the master token', async () => {
  const f = await fixture();
  await f.credentials.saveDevice({ clientId, id: '33333333-3333-4333-8333-333333333333',
    secret: 'd'.repeat(32), expiresAt: 2_000 });
  assert.equal(f.controller.resumeIfAvailable(), true);
  const ws = f.sockets[0]; ws.open();
  assert.deepEqual(ws.sent[0], { type: 'hello', protocol_version: 2, client_id: clientId,
    credential_storage: 'even_host_v1', client_capabilities: { location: false, guest_mode: true }, device_credential: 'd'.repeat(32) });
  assert.equal(JSON.stringify(ws.sent[0]).includes('token'), false);
});

test('a false native device write never emits persisted ACK', async () => {
  const data = new Map<string, string>();
  const host = { getLocalStorage: async (key: string) => data.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => {
      if (key.includes('device-credential')) return false;
      data.set(key, value); return true;
    } };
  const credentials = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  const sockets: FakeSocket[] = [], events: any[] = [];
  const controller = new ConnectionController({ url: () => 'ws://test',
    socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; }, credentials,
    onEvent: event => events.push(event), uuid });
  controller.connect('t'.repeat(32)); const ws = sockets[0]; ws.open();
  ws.message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
    resumed: false, latest_sequence: 0, resume_credential: 's'.repeat(32), resume_expires_at: 1_000,
    device_credential_id: '33333333-3333-4333-8333-333333333333', device_credential: 'd'.repeat(32),
    device_expires_at: 2_000, device_persist_deadline_at: 500, snapshot: { messages: [] } });
  await credentials.whenSettled(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ws.sent.some(item => item.type === 'credential.persisted'), false);
  assert.equal(events.some(item => item.type === 'notice' && /未保存/.test(item.text)), true);
});

test('explicit exit clears resume authority and dispose prevents all reconnects', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.confirmExit(true), true); assert.equal(f.credentials.load(), undefined);
  ws.drop(); assert.equal(f.timers.size, 0);
  const g = await fixture(); g.controller.connect('t'.repeat(32)); g.sockets[0].open(); g.ready(g.sockets[0]); g.controller.dispose();
  assert.equal(g.timers.size, 0); assert.equal(g.controller.networkAvailable(), false);
});

test('development expiry requires a connected socket and retained in-memory access token', async () => {
  const f = await fixture(); assert.equal(f.controller.forgetResumeCredential(), false);
  f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.forgetResumeCredential(), true);
  assert.equal(f.controller.send({ type: 'test.session.expire' }), true);
  assert.equal(ws.sent.at(-1).type, 'test.session.expire');
  assert.equal(f.credentials.load(), undefined);
});

test('development resume closes one connected socket and reconnects with its saved credential', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first);
  assert.equal(f.controller.reconnectNow(), true);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open();
  assert.equal(second.sent[0].resume_session_id, sessionId);
  assert.equal(second.sent[0].resume_credential, 's'.repeat(32));
});

test('storage lab commands receive command ids before transport', async () => {
  const f = await fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  for (const type of ['test.storage.inspect', 'test.storage.seed_expired', 'test.storage.cleanup_preview',
    'test.storage.cleanup_apply']) {
    assert.equal(f.controller.send({ type }), true);
    assert.equal(ws.sent.at(-1).type, type);
    assert.match(ws.sent.at(-1).command_id, /^[0-9a-f-]{36}$/i);
  }
});

test('ten page-style controller recreations resume one session with the rotated credential', async () => {
  const data = new Map<string, string>();
  const host = { getLocalStorage: async (key: string) => data.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { data.set(key, value); return true; } };
  let expectedSecret = 'a'.repeat(32);
  const create = async () => {
    const sockets: FakeSocket[] = [];
    const credentials = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
    const controller = new ConnectionController({ url: () => 'ws://test',
      socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      credentials, onEvent() {}, uuid, random: () => 0.5 });
    return { controller, sockets, credentials };
  };

  let current = await create();
  assert.equal(current.controller.connect('t'.repeat(32)), true);
  current.sockets[0].open();
  current.sockets[0].message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
    resumed: false, latest_sequence: 0, resume_credential: expectedSecret, resume_expires_at: 1_000,
    snapshot: { messages: [] } });
  await current.credentials.whenSettled();
  current.controller.dispose();

  for (let refresh = 1; refresh <= 10; refresh++) {
    current = await create();
    assert.equal(current.controller.resumeIfAvailable(), true);
    const socket = current.sockets[0]; socket.open();
    assert.equal(socket.sent[0].resume_session_id, sessionId);
    assert.equal(socket.sent[0].resume_credential, expectedSecret);
    expectedSecret = String.fromCharCode(97 + refresh).repeat(32);
    socket.message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
      resumed: true, latest_sequence: refresh, resume_credential: expectedSecret, resume_expires_at: 1_000,
      snapshot: { messages: [] } });
    await current.credentials.whenSettled();
    assert.equal(current.controller.status.sessionId, sessionId);
    assert.equal(current.controller.status.reason, 'resumed');
    current.controller.dispose();
  }
});
