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

function fixture() {
  const data = new Map<string, string>();
  const local = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const credentials = new SessionCredentialStore(local as any, () => 100, () => clientId);
  const sockets: FakeSocket[] = [], statuses: any[] = [], events: any[] = [], timers = new Map<number, () => void>();
  let timerId = 0;
  const controller = new ConnectionController({ url: () => 'ws://test', socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; },
    credentials, onEvent: event => events.push(event), onStatus: status => statuses.push(status), random: () => 0.5,
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

test('initial auth uses protocol v2 and reconnect resumes with the saved scoped credential', () => {
  const f = fixture(); assert.equal(f.controller.connect('t'.repeat(32)), true);
  const first = f.sockets[0]; first.open();
  assert.deepEqual(first.sent[0], { type: 'hello', protocol_version: 2, client_id: clientId, token: 't'.repeat(32) });
  f.ready(first); first.drop();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open();
  assert.deepEqual(second.sent[0], { type: 'hello', protocol_version: 2, client_id: clientId,
    resume_session_id: sessionId, resume_credential: 's'.repeat(32), last_seen_sequence: 4 });
  f.ready(second, true);
  assert.equal(f.controller.status.reason, 'resumed');
});

test('network restoration cancels the pending timer and reconnects immediately', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); f.sockets[0].open(); f.ready(f.sockets[0]); f.sockets[0].drop();
  assert.equal(f.timers.size, 1); assert.equal(f.controller.networkAvailable(), true);
  assert.equal(f.timers.size, 0); assert.equal(f.sockets.length, 2);
});

test('only one retry timer exists and stale socket events are ignored', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first); first.drop(); first.drop();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open(); const count = f.events.length;
  first.message({ type: 'notice', text: 'stale' });
  assert.equal(f.events.length, count);
});

test('expired resume credential fails closed then uses only the in-memory access token for a fresh session', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first); first.drop();
  [...f.timers.values()][0](); const resumed = f.sockets[1]; resumed.open();
  resumed.message({ type: 'error', code: 'SESSION_UNAVAILABLE' }); resumed.drop();
  [...f.timers.values()][0](); const fresh = f.sockets[2]; fresh.open();
  assert.equal(fresh.sent[0].token, 't'.repeat(32));
  assert.equal('resume_credential' in fresh.sent[0], false);
  assert.equal(f.statuses.some(status => status.reason === 'credential_expired'), true);
});

test('send assigns stable idempotency identifiers and credential refresh replaces the stored secret', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.send({ type: 'text.submit', text: 'hello' }), true);
  assert.match(ws.sent.at(-1).message_id, /^[0-9a-f-]{36}$/i);
  assert.equal(f.controller.send({ type: 'pause' }), true);
  assert.match(ws.sent.at(-1).command_id, /^[0-9a-f-]{36}$/i);
  ws.message({ type: 'resume.credential', session_id: sessionId, resume_credential: 'n'.repeat(32), resume_expires_at: 2_000 });
  assert.equal(f.credentials.load()?.secret, 'n'.repeat(32));
});

test('explicit exit clears resume authority and dispose prevents all reconnects', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.confirmExit(true), true); assert.equal(f.credentials.load(), undefined);
  ws.drop(); assert.equal(f.timers.size, 0);
  const g = fixture(); g.controller.connect('t'.repeat(32)); g.sockets[0].open(); g.ready(g.sockets[0]); g.controller.dispose();
  assert.equal(g.timers.size, 0); assert.equal(g.controller.networkAvailable(), false);
});

test('development expiry requires a connected socket and retained in-memory access token', () => {
  const f = fixture(); assert.equal(f.controller.forgetResumeCredential(), false);
  f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  assert.equal(f.controller.forgetResumeCredential(), true);
  assert.equal(f.controller.send({ type: 'test.session.expire' }), true);
  assert.equal(ws.sent.at(-1).type, 'test.session.expire');
  assert.equal(f.credentials.load(), undefined);
});

test('development resume closes one connected socket and reconnects with its saved credential', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const first = f.sockets[0]; first.open(); f.ready(first);
  assert.equal(f.controller.reconnectNow(), true);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  const second = f.sockets[1]; second.open();
  assert.equal(second.sent[0].resume_session_id, sessionId);
  assert.equal(second.sent[0].resume_credential, 's'.repeat(32));
});

test('storage lab commands receive command ids before transport', () => {
  const f = fixture(); f.controller.connect('t'.repeat(32)); const ws = f.sockets[0]; ws.open(); f.ready(ws);
  for (const type of ['test.storage.inspect', 'test.storage.seed_expired', 'test.storage.cleanup_preview',
    'test.storage.cleanup_apply']) {
    assert.equal(f.controller.send({ type }), true);
    assert.equal(ws.sent.at(-1).type, type);
    assert.match(ws.sent.at(-1).command_id, /^[0-9a-f-]{36}$/i);
  }
});

test('ten page-style controller recreations resume one session with the rotated credential', () => {
  const data = new Map<string, string>();
  const local = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  let expectedSecret = 'a'.repeat(32);
  const create = () => {
    const sockets: FakeSocket[] = [];
    const credentials = new SessionCredentialStore(local as any, () => 100, () => clientId);
    const controller = new ConnectionController({ url: () => 'ws://test',
      socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      credentials, onEvent() {}, uuid, random: () => 0.5 });
    return { controller, sockets };
  };

  let current = create();
  assert.equal(current.controller.connect('t'.repeat(32)), true);
  current.sockets[0].open();
  current.sockets[0].message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
    resumed: false, latest_sequence: 0, resume_credential: expectedSecret, resume_expires_at: 1_000,
    snapshot: { messages: [] } });
  current.controller.dispose();

  for (let refresh = 1; refresh <= 10; refresh++) {
    current = create();
    assert.equal(current.controller.resumeIfAvailable(), true);
    const socket = current.sockets[0]; socket.open();
    assert.equal(socket.sent[0].resume_session_id, sessionId);
    assert.equal(socket.sent[0].resume_credential, expectedSecret);
    expectedSecret = String.fromCharCode(97 + refresh).repeat(32);
    socket.message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: sessionId,
      resumed: true, latest_sequence: refresh, resume_credential: expectedSecret, resume_expires_at: 1_000,
      snapshot: { messages: [] } });
    assert.equal(current.controller.status.sessionId, sessionId);
    assert.equal(current.controller.status.reason, 'resumed');
    current.controller.dispose();
  }
});
