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
