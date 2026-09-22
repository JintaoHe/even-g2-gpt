import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionClient, browserReconnectDelay, isLoopbackHost } from '../web/session-client.js';

class Socket {
  static OPEN = 1; static CLOSING = 2; readyState = 0; sent: any[] = [];
  onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: any) => void;
  send(value: any) { this.sent.push(typeof value === 'string' ? JSON.parse(value) : value); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: any) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

test('browser reference client uses v2 resume, stable message ids and duplicate-submit testing', () => {
  const data = new Map<string, string>(), sockets: Socket[] = [], timers: (() => void)[] = [];
  let id = 0; const uuid = () => `${String(++id).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const client = new BrowserSessionClient({ url: 'ws://test', storage: { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } },
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket; }, onEvent() {}, uuid, random: () => 0.5,
    now: () => 100, setTimer: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimer() {} });
  assert.equal(client.connect('t'.repeat(32)), true); sockets[0].open(); assert.equal(sockets[0].sent[0].protocol_version, 2);
  assert.deepEqual(sockets[0].sent[0].client_capabilities, { location: false, guest_mode: true });
  sockets[0].message({ type: 'ready', protocol_version: 2, connection_id: uuid(), session_id: uuid(), resumed: false,
    latest_sequence: 0, resume_window_minutes: 15,
    resume_credential: 'r'.repeat(32), resume_expires_at: 1_000, snapshot: { messages: [] } });
  client.send({ type: 'text.submit', text: 'hello' }); const submitted = sockets[0].sent.at(-1);
  assert.match(submitted.message_id, /^[0-9a-f-]{36}$/); client.repeatLastSubmission();
  assert.deepEqual(sockets[0].sent.at(-1), submitted);
  assert.equal(client.storageTest('test.storage.inspect'), true);
  assert.match(sockets[0].sent.at(-1).command_id, /^[0-9a-f-]{36}$/);
  assert.equal(client.canSimulateColdStart(), true);
  assert.equal(client.simulateResume(), true);
  assert.equal(client.canSimulateColdStart(), false);
  assert.equal(timers.length, 1);
  timers[0](); sockets[1].open(); assert.equal(sockets[1].sent[0].resume_credential, 'r'.repeat(32));
});

test('browser dev controls and reconnect delay are tightly bounded', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true); assert.equal(isLoopbackHost('calendar.eveng2assistant.com'), false);
  assert.equal(browserReconnectDelay(0, () => 0), 400); assert.equal(browserReconnectDelay(99, () => 1), 30_000);
});

test('browser guest switching uses restricted device storage and fresh unlock never auto-reconnects as owner', () => {
  const data = new Map<string,string>(), sockets: Socket[] = [], events: any[] = [];
  let id = 0; const uuid = () => `${String(++id).padStart(8,'0')}-0000-4000-8000-000000000000`;
  const client = new BrowserSessionClient({ url: 'ws://test', storage: {
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string,value: string) => { data.set(key,value); },
    removeItem: (key: string) => { data.delete(key); } }, now: () => 100, uuid,
    socket: () => { const ws = new Socket(); sockets.push(ws); return ws; }, onEvent: (e: any) => events.push(e) });
  client.connect('private-master-'.repeat(4)); const first = sockets[0]; first.open();
  first.message({ type: 'ready', protocol_version: 2, session_id: uuid(), connection_id: uuid(),
    resume_credential: 'r'.repeat(32), resume_expires_at: 1000,
    device_credential_id: uuid(), device_credential: 'd'.repeat(32), device_expires_at: 2000 });
  assert.equal(first.sent.at(-1).type, 'credential.persisted');
  client.send({ type: 'text.submit', text: 'private unsent copy' });
  first.message({ type: 'access.changed', mode: 'guest', reconnect: true });
  first.message({ type: 'answer.delta', text: 'LATE_OWNER_DATA' });
  assert.equal(client.repeatLastSubmission(), false); assert.equal(client.credential(), undefined);
  const second = sockets[1]; second.open(); assert.equal(second.sent[0].device_credential, 'd'.repeat(32));
  assert.equal(second.sent[0].token, undefined); assert.equal(events.some(e => e.text === 'LATE_OWNER_DATA'), false);
  second.message({ type: 'access.changed', mode: 'reauthorize', reconnect: false });
  assert.equal(client.deviceCredential(), undefined); assert.equal(client.networkAvailable(), false);
  assert.equal(client.connect(), false); assert.equal(sockets.length, 2);
  assert.equal(JSON.stringify([...data]).includes('private-master'), false); client.dispose();
});
