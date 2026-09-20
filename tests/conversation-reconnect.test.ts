import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { DialogueModel } from '../src/conversation.js';
import { createConversationServer } from '../src/conversation-server.js';
import { ConversationStore } from '../src/conversation-store.js';

const token = 'r'.repeat(64);
const unusedTranscriber = () => { throw new Error('audio not used'); };

function waitFor(client: WebSocket, type: string, predicate: (event: any) => boolean = () => true) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 3_000);
    const message = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (event.type === type && predicate(event)) { cleanup(); resolve(event); }
      else if (event.type === 'error') { cleanup(); reject(new Error(`Server error waiting for ${type}: ${event.code}`)); }
    };
    const close = () => { cleanup(); reject(new Error(`Socket closed waiting for ${type}`)); };
    const cleanup = () => { clearTimeout(timeout); client.off('message', message); client.off('close', close); };
    client.on('message', message); client.on('close', close);
  });
}

async function listen(store: ConversationStore, model: DialogueModel) {
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  return { app, url: `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation` };
}

test('session expiry test control cannot be exposed by a configured public server', () => {
  const model: DialogueModel = { decide: async () => 'respond', reply: async () => {} };
  assert.throws(() => createConversationServer({ token, model, transcriber: unusedTranscriber,
    allowSessionExpiryTestControl: true,
    ingress: { publicHosts: ['calendar.eveng2assistant.com'], allowedOrigins: ['https://calendar.eveng2assistant.com'] },
  }), /loopback/i);
});

test('protocol v2 resumes after service restart, rotates credential and deduplicates replayed input', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-'));
  let store = await ConversationStore.create(root), replies = 0;
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => { replies++; delta('saved answer'); },
  };
  const clientId = randomUUID(), messageId = randomUUID();
  let firstServer = await listen(store, model);
  const first = new WebSocket(firstServer.url); await once(first, 'open');
  const ready1Promise = waitFor(first, 'ready');
  first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const ready1 = await ready1Promise;
  assert.equal(ready1.resumed, false);
  assert.equal(ready1.resume_window_minutes, 15);
  assert.match(ready1.resume_credential, /^[0-9a-f-]{36}\./);

  const donePromise = waitFor(first, 'answer.done');
  first.send(JSON.stringify({ type: 'text.submit', message_id: messageId, text: 'remember this' }));
  const done = await donePromise;
  assert.equal(done.sequence, 2);
  first.close(); await once(first, 'close');
  await firstServer.app.close(); await store.close();

  store = await ConversationStore.create(root);
  const secondServer = await listen(store, model);
  const second = new WebSocket(secondServer.url); await once(second, 'open');
  try {
    const ready2Promise = waitFor(second, 'ready');
    second.send(JSON.stringify({
      type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: ready1.session_id, resume_credential: ready1.resume_credential,
      last_seen_sequence: 0,
    }));
    const ready2 = await ready2Promise;
    assert.equal(ready2.resumed, true);
    assert.equal(ready2.session_id, ready1.session_id);
    assert.notEqual(ready2.resume_credential, ready1.resume_credential);
    assert.deepEqual(ready2.snapshot.messages.map((item: any) => [item.sequence, item.role, item.content]), [
      [1, 'user', 'remember this'], [2, 'assistant', 'saved answer'],
    ]);

    const replayPromise = waitFor(second, 'answer.done', event => event.replayed === true);
    second.send(JSON.stringify({ type: 'answer.retry', command_id: randomUUID() }));
    const replay = await replayPromise;
    assert.equal(replay.message_id, done.message_id);
    assert.equal(replay.sequence, 2);
    assert.equal(replies, 1);

    const duplicatePromise = waitFor(second, 'message.ack', event => event.message_id === messageId);
    second.send(JSON.stringify({ type: 'text.submit', message_id: messageId, text: 'remember this' }));
    assert.equal((await duplicatePromise).result, 'duplicate');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies, 1);
    assert.equal(store.listMessages(ready1.session_id).length, 2);
  } finally {
    second.terminate(); await secondServer.app.close(); await store.close();
  }
});

test('a long-lived connection receives a fresh short-lived resume credential', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-refresh-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    resumeWindowMs: 1_000, resumeCredentialRefreshMs: 20,
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  const client = new WebSocket(url); await once(client, 'open');
  try {
    const readyPromise = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    const ready = await readyPromise;
    const refreshed = await waitFor(client, 'resume.credential');
    assert.equal(refreshed.session_id, ready.session_id);
    assert.notEqual(refreshed.resume_credential, ready.resume_credential);
    assert.ok(refreshed.resume_expires_at > Date.now());
  } finally { client.terminate(); await app.close(); await store.close(); }
});

test('a natural missed-answer request replays committed SQLite content without another model call', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-natural-replay-'));
  const store = await ConversationStore.create(root);
  let replies = 0;
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => { replies++; delta('the durable answer'); },
  };
  const server = await listen(store, model);
  const client = new WebSocket(server.url); await once(client, 'open');
  try {
    const readyPromise = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    const ready = await readyPromise;
    const firstDone = waitFor(client, 'answer.done');
    client.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'original question' }));
    await firstDone;
    const original = store.latestRecoverableTurn(ready.session_id)!;

    const replayDone = waitFor(client, 'answer.done', event => event.turn_id !== original.turn.id);
    client.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '我刚才没有看到你的回答，请再说一次。' }));
    await replayDone;
    assert.equal(replies, 1);
    const replay = store.latestRecoverableTurn(ready.session_id)!;
    assert.equal(replay.turn.retryOfTurnId, original.turn.id);
    assert.equal(replay.output?.content, 'the durable answer');

    const ordinaryDone = waitFor(client, 'answer.done', event => event.turn_id !== replay.turn.id);
    client.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(),
      text: '不要再说刚才的回答，我们聊点别的。' }));
    await ordinaryDone;
    assert.equal(replies, 2);
    assert.equal(store.latestRecoverableTurn(ready.session_id)?.turn.retryOfTurnId, undefined);
  } finally { client.terminate(); await server.app.close(); await store.close(); }
});

test('a second live protocol v2 input client is rejected without stealing the first lease', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-lease-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const server = await listen(store, model);
  const first = new WebSocket(server.url), second = new WebSocket(server.url);
  await Promise.all([once(first, 'open'), once(second, 'open')]);
  try {
    const firstReady = waitFor(first, 'ready');
    first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    await firstReady;
    const error = waitFor(second, 'error');
    second.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    assert.equal((await error).code, 'BUSY');
  } finally {
    first.terminate(); second.terminate(); await server.app.close(); await store.close();
  }
});

test('an interrupted answer is regenerated only after explicit retry and links the new turn', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-interrupted-'));
  const store = await ConversationStore.create(root);
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => {
      if (++calls === 1) { delta('partial'); await blocked; return; }
      delta('recovered answer');
    },
  };
  const server = await listen(store, model), clientId = randomUUID();
  const first = new WebSocket(server.url); await once(first, 'open');
  const readyPromise = waitFor(first, 'ready');
  first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const ready = await readyPromise;
  const partial = waitFor(first, 'answer.delta');
  first.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'long question' }));
  await partial;
  first.terminate(); await once(first, 'close');
  for (let attempt = 0; attempt < 20 && store.listMessages(ready.session_id).at(-1)?.status !== 'interrupted'; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  release();
  const interrupted = store.latestRecoverableTurn(ready.session_id)!;
  assert.equal(interrupted.output?.status, 'interrupted');

  const second = new WebSocket(server.url); await once(second, 'open');
  try {
    const resumedPromise = waitFor(second, 'ready');
    second.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: ready.session_id, resume_credential: ready.resume_credential, last_seen_sequence: 0 }));
    const resumed = await resumedPromise;
    assert.equal(resumed.snapshot.interrupted_turn_id, interrupted.turn.id);
    const donePromise = waitFor(second, 'answer.done', event => !event.replayed);
    second.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(),
      text: '刚才的回答中断了，请重新回答。' }));
    await donePromise;
    assert.equal(calls, 2);
    const retried = store.latestRecoverableTurn(ready.session_id)!;
    assert.equal(retried.turn.retryOfTurnId, interrupted.turn.id);
    assert.equal(retried.output?.content, 'recovered answer');
  } finally { second.terminate(); await server.app.close(); await store.close(); }
});

test('loopback-only test control detaches then expires the session immediately', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-expire-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    allowSessionExpiryTestControl: true });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  const client = new WebSocket(url); await once(client, 'open');
  try {
    const readyPromise = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    const ready = await readyPromise;
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'test.session.expire', command_id: randomUUID() }));
    await closed;
    for (let attempt = 0; attempt < 20 && store.getSession(ready.session_id)?.status !== 'expired'; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(store.getSession(ready.session_id)?.status, 'expired');
  } finally { client.terminate(); await app.close(); await store.close(); }
});
