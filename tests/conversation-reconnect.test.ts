import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { DialogueModel } from '../src/conversation.js';
import { createConversationServer } from '../src/conversation-server.js';
import { ConversationStore } from '../src/conversation-store.js';

const token = 'r'.repeat(64);
const unusedTranscriber = () => { throw new Error('audio not used'); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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

test('local session and storage test controls cannot be exposed by a configured public server', () => {
  const model: DialogueModel = { decide: async () => 'respond', reply: async () => {} };
  assert.throws(() => createConversationServer({ token, model, transcriber: unusedTranscriber,
    localTestControls: { read: true, write: true },
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

test('persisted device credential starts a new session without the master token and rotates with ACK', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-device-credential-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    deviceCredentialTtlMs: 10_000, deviceCredentialPersistWindowMs: 1_000,
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = new WebSocket(url); await once(first, 'open');
  const initialReady = waitFor(first, 'ready');
  first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token,
    credential_storage: 'even_host_v1' }));
  const initial = await initialReady;
  assert.match(initial.device_credential, /^[0-9a-f-]{36}\./);
  assert.match(initial.device_credential_id, /^[0-9a-f-]{36}$/);
  const initialAck = waitFor(first, 'credential.acknowledged');
  first.send(JSON.stringify({ type: 'credential.persisted', credential_id: initial.device_credential_id }));
  assert.equal((await initialAck).credential_id, initial.device_credential_id);
  first.close(); await once(first, 'close'); await new Promise(resolve => setImmediate(resolve));

  const resumedSocket = new WebSocket(url); await once(resumedSocket, 'open');
  const resumedReady = waitFor(resumedSocket, 'ready');
  resumedSocket.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
    credential_storage: 'even_host_v1', resume_session_id: initial.session_id,
    resume_credential: initial.resume_credential, last_seen_sequence: 0 }));
  const resumed = await resumedReady;
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.session_id, initial.session_id);
  assert.notEqual(resumed.device_credential, initial.device_credential, 'resume closes the first-write crash window');
  const resumedAck = waitFor(resumedSocket, 'credential.acknowledged');
  resumedSocket.send(JSON.stringify({ type: 'credential.persisted', credential_id: resumed.device_credential_id }));
  await resumedAck;
  resumedSocket.close(); await once(resumedSocket, 'close'); await new Promise(resolve => setImmediate(resolve));

  const second = new WebSocket(url); await once(second, 'open');
  const rotatedReady = waitFor(second, 'ready');
  second.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
    credential_storage: 'even_host_v1', device_credential: resumed.device_credential }));
  const rotated = await rotatedReady;
  assert.equal(rotated.resumed, false);
  assert.notEqual(rotated.session_id, initial.session_id);
  assert.notEqual(rotated.device_credential, resumed.device_credential);
  const rotatedAck = waitFor(second, 'credential.acknowledged');
  second.send(JSON.stringify({ type: 'credential.persisted', credential_id: rotated.device_credential_id }));
  await rotatedAck;
  second.close(); await once(second, 'close'); await new Promise(resolve => setImmediate(resolve));

  const replay = new WebSocket(url); await once(replay, 'open');
  try {
    const rejected = waitFor(replay, 'error');
    replay.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      credential_storage: 'even_host_v1', device_credential: initial.device_credential }));
    assert.equal((await rejected).code, 'DEVICE_CREDENTIAL_INVALID');
  } finally { replay.terminate(); await app.close(); await store.close(); }
});

test('clients that do not declare Even host storage are never issued a device credential', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-device-opt-in-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const server = await listen(store, model);
  const client = new WebSocket(server.url); await once(client, 'open');
  try {
    const ready = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    const event = await ready;
    assert.equal(event.device_credential, undefined);
    assert.equal(event.device_credential_id, undefined);
  } finally { client.terminate(); await server.app.close(); await store.close(); }
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

test('common short missed-answer phrases all use durable replay without another model call', { timeout: 10_000 }, async () => {
  for (const phrase of ['没看完，继续说', '继续说', '接着说', '刚才说到一半', '继续刚才的回答']) {
    const root = await mkdtemp(join(tmpdir(), 'even-reconnect-natural-'));
    const store = await ConversationStore.create(root); let replies = 0;
    const server = await listen(store, { decide: async () => 'respond',
      reply: async (_history, _signal, delta) => { replies++; delta('durable replay target'); } });
    const client = new WebSocket(server.url);
    try {
      await once(client, 'open'); const readyPromise = waitFor(client, 'ready');
      client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
      const ready = await readyPromise;
      let done = waitFor(client, 'answer.done');
      client.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '请解释这个概念' })); await done;
      done = waitFor(client, 'answer.done');
      client.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: phrase })); await done;
      assert.equal(replies, 1, phrase);
      assert.equal(store.latestRecoverableTurn(ready.session_id)?.output?.content, 'durable replay target', phrase);
    } finally { client.terminate(); await server.app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('a second live protocol v2 input client is rejected without stealing the first lease', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-lease-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const server = await listen(store, model);
  const first = new WebSocket(server.url);
  let second: WebSocket | undefined;
  await once(first, 'open');
  try {
    const firstReady = waitFor(first, 'ready');
    first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    await firstReady;

    // Establish the contender only after the first client visibly owns the
    // input lease. Opening both transports concurrently makes this an
    // upgrade-order test instead of the active-session invariant we intend to
    // verify, and produced a nondeterministic Linux CI failure.
    second = new WebSocket(server.url);
    await once(second, 'open');
    const error = waitFor(second, 'error');
    second.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    assert.equal((await error).code, 'BUSY');
  } finally {
    first.terminate(); second?.terminate(); await server.app.close(); await store.close();
  }
});

test('a valid same-client resume takes over a live lease and the replacement remains usable', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-takeover-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('replacement answer') };
  const server = await listen(store, model), clientId = randomUUID();
  const first = new WebSocket(server.url); await once(first, 'open');
  const firstReady = waitFor(first, 'ready');
  first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const initial = await firstReady;
  const firstClosed = once(first, 'close');
  const replacement = new WebSocket(server.url); await once(replacement, 'open');
  try {
    const replacementReady = waitFor(replacement, 'ready');
    replacement.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: initial.session_id, resume_credential: initial.resume_credential, last_seen_sequence: 0 }));
    const resumed = await replacementReady;
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session_id, initial.session_id);
    await firstClosed;

    const answer = waitFor(replacement, 'answer.done');
    replacement.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'still usable' }));
    await answer;
    assert.equal(store.latestRecoverableTurn(initial.session_id)?.output?.content, 'replacement answer');
  } finally { first.terminate(); replacement.terminate(); await server.app.close(); await store.close(); }
});

test('a replaced connection close cannot erase the new owner capture cancellation hook', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-capture-owner-'));
  const store = await ConversationStore.create(root);
  const jobs: Array<ReturnType<typeof deferred<string>>> = [];
  let cancelled = 0;
  const model: DialogueModel = { decide: async () => 'respond', reply: async () => {} };
  const app = createConversationServer({ token, model, conversationStore: store,
    transcriber: () => {
      const job = deferred<string>(); jobs.push(job);
      return { result: job.promise, push: () => {}, finish: () => {}, cancel: () => { cancelled++; } };
    }, capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: true } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = new WebSocket(url); await once(first, 'open');
  const initialReady = waitFor(first, 'ready');
  first.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const initial = await initialReady;
  const replacement = new WebSocket(url); await once(replacement, 'open');
  try {
    const replacementReady = waitFor(replacement, 'ready');
    replacement.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: initial.session_id, resume_credential: initial.resume_credential, last_seen_sequence: 0 }));
    await replacementReady;
    const started = waitFor(replacement, 'speech.started');
    const loud = Buffer.alloc(6400); for (let index = 0; index < loud.length; index += 2) loud.writeInt16LE(4000, index);
    replacement.send(loud); await started;
    assert.equal(jobs.length, 1);
    const paused = waitFor(replacement, 'state', event => event.state === 'paused');
    replacement.send(JSON.stringify({ type: 'pause', command_id: randomUUID() }));
    await paused;
    assert.equal(cancelled, 1);
  } finally { first.terminate(); replacement.terminate(); await app.close(); await store.close(); }
});

test('an invalid same-client credential cannot evict the current owner', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-takeover-invalid-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('owner answer') };
  const server = await listen(store, model), clientId = randomUUID();
  const owner = new WebSocket(server.url); await once(owner, 'open');
  const ownerReady = waitFor(owner, 'ready');
  owner.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const initial = await ownerReady;
  const forged = new WebSocket(server.url); await once(forged, 'open');
  try {
    const rejected = waitFor(forged, 'error');
    forged.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: initial.session_id, resume_credential: 'invalid'.repeat(8), last_seen_sequence: 0 }));
    assert.equal((await rejected).code, 'SESSION_UNAVAILABLE');
    const answer = waitFor(owner, 'answer.done');
    owner.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'owner remains' }));
    await answer;
    assert.equal(store.latestRecoverableTurn(initial.session_id)?.output?.content, 'owner answer');
  } finally { owner.terminate(); forged.terminate(); await server.app.close(); await store.close(); }
});

test('a foreign client id cannot attempt takeover with the owner genuine credential', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-takeover-foreign-client-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('owner retained') };
  const server = await listen(store, model), ownerClientId = randomUUID();
  const owner = new WebSocket(server.url); await once(owner, 'open');
  const ownerReady = waitFor(owner, 'ready');
  owner.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: ownerClientId, token }));
  const initial = await ownerReady;
  const foreign = new WebSocket(server.url); await once(foreign, 'open');
  try {
    const rejected = waitFor(foreign, 'error');
    foreign.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(),
      resume_session_id: initial.session_id, resume_credential: initial.resume_credential, last_seen_sequence: 0 }));
    assert.equal((await rejected).code, 'BUSY', 'the public client-id gate must reject before credential rotation');
    const answer = waitFor(owner, 'answer.done');
    owner.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'owner still owns input' }));
    await answer;
    assert.equal(store.latestRecoverableTurn(initial.session_id)?.output?.content, 'owner retained');
  } finally { owner.terminate(); foreign.terminate(); await server.app.close(); await store.close(); }
});

test('unauthenticated sockets are evicted to the fixed bound without blocking authentication', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-auth-capacity-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const server = await listen(store, model);
  const anonymous: WebSocket[] = [];
  try {
    for (let index = 0; index < 12; index++) {
      const socket = new WebSocket(server.url); anonymous.push(socket); await once(socket, 'open');
    }
    for (let attempt = 0; attempt < 100
      && anonymous.filter(socket => socket.readyState === WebSocket.OPEN).length > 4; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(anonymous.filter(socket => socket.readyState === WebSocket.OPEN).length, 4,
      'pre-auth eviction must bound otherwise-idle sockets');
    const owner = new WebSocket(server.url); await once(owner, 'open');
    anonymous.push(owner);
    const ready = waitFor(owner, 'ready');
    owner.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    assert.equal((await ready).resumed, false);
  } finally {
    for (const socket of anonymous) socket.terminate();
    await server.app.close(); await store.close();
  }
});

test('unauthenticated connection churn never evicts the authenticated owner', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-post-auth-capacity-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('owner retained') };
  const server = await listen(store, model);
  const owner = new WebSocket(server.url); await once(owner, 'open');
  const ready = waitFor(owner, 'ready');
  owner.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
  const session = await ready;
  const anonymous: WebSocket[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const socket = new WebSocket(server.url); anonymous.push(socket); await once(socket, 'open');
    }
    const answer = waitFor(owner, 'answer.done');
    owner.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: 'owner check' }));
    await answer;
    assert.equal(store.latestRecoverableTurn(session.session_id)?.output?.content, 'owner retained');
  } finally {
    owner.terminate(); for (const socket of anonymous) socket.terminate();
    await server.app.close(); await store.close();
  }
});

test('a valid same-client resume immediately replaces a raw half-open peer without waiting for heartbeat', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-heartbeat-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60,
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  const clientId = randomUUID();
  const silent = new WebSocket(url, { autoPong: false } as any); await once(silent, 'open');
  const readyPromise = waitFor(silent, 'ready');
  silent.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token }));
  const ready = await readyPromise;
  const silentClosed = once(silent, 'close');

  const replacement = new WebSocket(url); await once(replacement, 'open');
  try {
    const resumedPromise = waitFor(replacement, 'ready');
    replacement.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: ready.session_id, resume_credential: ready.resume_credential, last_seen_sequence: 0 }));
    const resumed = await resumedPromise;
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session_id, ready.session_id);
    await silentClosed;
  } finally { silent.terminate(); replacement.terminate(); await app.close(); await store.close(); }
});

test('a detached viewer does not abort an answer that can finish and commit without an event sink', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-interrupted-'));
  const store = await ConversationStore.create(root);
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => {
      calls++; delta('partial'); await blocked; delta(' complete');
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
  release();
  for (let attempt = 0; attempt < 100 && store.listMessages(ready.session_id).at(-1)?.status !== 'committed'; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const completed = store.latestRecoverableTurn(ready.session_id)!;
  assert.equal(completed.output?.status, 'committed');
  assert.equal(completed.output?.content, 'partial complete');

  const second = new WebSocket(server.url); await once(second, 'open');
  try {
    const resumedPromise = waitFor(second, 'ready');
    second.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      resume_session_id: ready.session_id, resume_credential: ready.resume_credential, last_seen_sequence: 0 }));
    const resumed = await resumedPromise;
    assert.equal(resumed.snapshot.interrupted_turn_id, undefined);
    assert.equal(resumed.snapshot.messages.at(-1)?.content, 'partial complete');
    assert.equal(calls, 1);
  } finally { second.terminate(); await server.app.close(); await store.close(); }
});

test('loopback-only test control detaches then expires the session immediately', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-expire-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    localTestControls: { read: true, write: true } });
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

test('read-only local test controls cannot invoke a database mutation', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-read-controls-'));
  const store = await ConversationStore.create(root);
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    localTestControls: { read: true, write: false } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
  await once(client, 'open');
  try {
    let response = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    await response;
    response = waitFor(client, 'test.storage.report');
    client.send(JSON.stringify({ type: 'test.storage.inspect', command_id: randomUUID() }));
    assert.equal((await response).action, 'inspect');
    const error = waitFor(client, 'error');
    client.send(JSON.stringify({ type: 'test.storage.seed_expired', command_id: randomUUID() }));
    assert.equal((await error).code, 'INVALID_MESSAGE');
  } finally { client.terminate(); await app.close(); await store.close(); }
});

test('loopback storage lab reports safe metadata and cleans only fixed retention fixtures', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-reconnect-storage-lab-'));
  const store = await ConversationStore.create(root);
  const oldRealId = randomUUID(), oldAt = Date.now() - 1095 * 24 * 60 * 60 * 1000 - 120_000;
  store.createSession({ id: oldRealId, ownerScope: 'single-user', createdAt: oldAt - 1 });
  store.endSession(oldRealId, oldAt, 'user_exit');
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('ok') };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: unusedTranscriber,
    localTestControls: { read: true, write: true } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  const client = new WebSocket(url); await once(client, 'open');
  try {
    const readyPromise = waitFor(client, 'ready');
    client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(), token }));
    await readyPromise;
    const command = async (type: string) => {
      const response = waitFor(client, 'test.storage.report');
      client.send(JSON.stringify({ type, command_id: randomUUID() }));
      return response;
    };
    const inspected = await command('test.storage.inspect');
    assert.equal(inspected.action, 'inspect');
    assert.equal(inspected.sqlite.schema_version, 5);
    assert.equal(inspected.retention.test_eligible_sessions, 0);
    assert.doesNotMatch(JSON.stringify(inspected), /content|transcript|database_path|session_id/i);

    const seeded = await command('test.storage.seed_expired');
    assert.equal(seeded.retention.test_eligible_sessions, 1);
    const seededAgain = await command('test.storage.seed_expired');
    assert.equal(seededAgain.retention.test_eligible_sessions, 1);
    const preview = await command('test.storage.cleanup_preview');
    assert.equal(preview.retention.test_eligible_sessions, 1);
    assert.equal(preview.retention.deleted_sessions, 0);
    const applied = await command('test.storage.cleanup_apply');
    assert.equal(applied.retention.deleted_sessions, 1);
    assert.equal(applied.retention.test_eligible_sessions, 1);
    assert.ok(store.getSession(oldRealId), 'real old history remains outside the fixed simulator scope');
  } finally { client.terminate(); await app.close(); await store.close(); }
});
