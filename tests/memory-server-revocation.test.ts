import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ConversationStore } from '../src/conversation-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { HybridDialogue } from '../src/hybrid-dialogue.js';
import { Conversation, type Message } from '../src/conversation.js';

for (const scenario of ['boundary', 'text', 'continue', 'retry'] as const) {
  test(`turn rejection containment: ${scenario}`, { timeout: 15000 }, async t => {
    const store = scenario === 'continue' ? undefined : await ConversationStore.create(await mkdtemp(join(tmpdir(), 'turn-failure-')));
    const token = 'synthetic-turn-token-'.repeat(5);
    let calls = 0;
    const app = createConversationServer({ token, conversationStore: store, legacyHelloEnabled: scenario === 'continue',
      model: { decide: async () => { calls++; return 'respond'; },
        reply: async (_h, _s, delta) => { calls++; delta('合成正常回答'); } },
      transcriber: () => { throw Error('No audio'); } });
    const original = Conversation.prototype.submit;
    const boundary = store?.memoryContextBoundary.bind(store);
    const unhandled: unknown[] = [], onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let socket: WebSocket;
    t.after(async () => {
      Conversation.prototype.submit = original;
      if (store && boundary) store.memoryContextBoundary = boundary;
      socket?.terminate(); await app.close(); await store?.close();
      process.off('unhandledRejection', onUnhandled);
    });
    app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
    socket = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
    const events: any[] = [];
    socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    const wait = async (type: string) => {
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        const event = events.find(e => e.type === type); if (event) return event;
        await new Promise(r => setTimeout(r, 5));
      }
      throw Error(`Missing ${type}`);
    };
    const text = () => socket.send(JSON.stringify({ type: 'text.submit', text: '合成新问题', message_id: randomUUID() }));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', ...(store ? { protocol_version: 2 } : {}), token, client_id: randomUUID(),
      client_capabilities: { location: false }, credential_storage: 'browser_v1' }));
    const ready = await wait('ready'); text(); await wait('answer.done'); events.length = 0; calls = 0;
    if (scenario === 'boundary') {
      store!.memoryContextBoundary = () => { throw Error('SQLITE_BUSY'); };
      text(); const notice = await wait('notice');
      assert.equal(notice.code, 'MEMORY_CONTEXT_RESET');
      assert.equal(Object.hasOwn(notice, 'memory_boundary'), false);
      assert.equal(calls, 0); assert.equal(events.some(e => e.type === 'answer.delta'), false);
      store!.memoryContextBoundary = boundary!;
    } else {
      if (scenario === 'retry') {
        const topicId = store!.listTopics(ready.session_id).at(-1)!.id, turnId = randomUUID();
        store!.commitUserTurn({ sessionId: ready.session_id, topicId, turnId, messageId: randomUUID(), content: '合成被中断问题', createdAt: Date.now() });
        store!.startAssistantAnswer({ sessionId: ready.session_id, topicId, turnId, messageId: randomUUID(), createdAt: Date.now() });
        store!.interruptAssistantAnswer({ turnId, updatedAt: Date.now(), reason: 'TEST_INTERRUPTED' });
      }
      Conversation.prototype.submit = async function () { this.state = 'thinking'; throw Error('synthetic private details'); };
      if (scenario === 'text') text(); else socket.send(JSON.stringify({ type: 'answer.retry', command_id: randomUUID() }));
      assert.deepEqual(await wait('error'), { type: 'error', code: 'TURN_FAILED' });
      Conversation.prototype.submit = original;
    }
    assert.equal(socket.readyState, WebSocket.OPEN);
    events.length = 0; text(); await wait('answer.done');
    assert.ok(calls > 0); assert.deepEqual(unhandled, []);
  });
}

test('WS source forgetting aborts output, clears wrapper/recovery state and bounds reconnect snapshots', { timeout: 15000 }, async t => {
  const store = await ConversationStore.create(await mkdtemp(join(tmpdir(), 'memory-ws-')));
  const token = 'synthetic-owner-'.repeat(5), clientId = randomUUID(), secret = '合成暗号黄铜燕子';
  const inputs: Message[][] = []; let calls = 0, resets = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const model = { revokeMemoryContext: () => { resets++; }, decide: async (h: Message[]) => { inputs.push(h); return 'respond' as const; },
    reply: async (h: Message[], _s: AbortSignal, delta: (s: string) => void) => {
      inputs.push(h); calls++; if (calls === 2) { await gate; delta(secret); } else delta('合成回答');
    } };
  const app = createConversationServer({ token, model, conversationStore: store, transcriber: () => { throw Error('No audio'); } });
  const sockets: WebSocket[] = [];
  t.after(async () => { release(); sockets.forEach(s => s.terminate()); await app.close(); await store.close(); });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const connect = async (resume?: any) => {
    const socket = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`); sockets.push(socket);
    const events: any[] = []; socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    const wait = async (type: string) => {
      const until = Date.now() + 4000;
      while (Date.now() < until) { const e = events.find(e => e.type === type); if (e) return e; await new Promise(r => setTimeout(r, 5)); }
      throw Error('Missing ' + type);
    };
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      ...(resume ? { resume_session_id: resume.session_id, resume_credential: resume.resume_credential } : { token }),
      client_capabilities: { location: false }, credential_storage: 'browser_v1' }));
    return { socket, events, wait, ready: await wait('ready') };
  };
  const c = await connect(), sid = c.ready.session_id, firstId = randomUUID();
  c.socket.send(JSON.stringify({ type: 'text.submit', message_id: firstId, text: secret })); await c.wait('answer.done');
  const principal = { mode: 'owner' as const, ownerScope: 'single-user' };
  const memory = store.mutatePersonalMemory(principal, { source: { sessionId: sid, messageId: firstId },
    proposal: { action: 'save', kind: 'fact', content: secret } });
  store.putRecoveryDraft({ sessionId: sid, kind: 'delivery', payload: { version: 1, jobId: randomUUID() }, at: Date.now() });
  c.events.length = 0;
  c.socket.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '再解释一下' })); await c.wait('answer.start');
  const other = randomUUID(), topicId = randomUUID(), messageId = randomUUID();
  store.createSession({ id: other, ownerScope: 'single-user', createdAt: Date.now(), initialTopic: { id: topicId, label: '测试' } });
  store.commitUserTurn({ sessionId: other, topicId, messageId, turnId: randomUUID(), content: '忘掉暗号', createdAt: Date.now() });
  store.mutatePersonalMemory(principal, { source: { sessionId: other, messageId }, targetId: memory.id,
    proposal: { action: 'forget', target: '暗号', level: 'memory_only' } });
  const notice = await c.wait('notice'); assert.ok(resets > 0); assert.equal(store.getRecoveryDraft(sid, 'delivery'), undefined);
  assert.equal(notice.memory_boundary, store.memoryContextBoundary(sid).version);
  release(); await new Promise(r => setTimeout(r, 30));
  assert.equal(c.events.some(e => ['answer.delta', 'answer.citations', 'answer.committed'].includes(e.type)), false);
  const d = await connect(c.ready); assert.equal(d.ready.snapshot.messages.length, 0);
  assert.equal(d.ready.memory_boundary, notice.memory_boundary);
  inputs.length = 0; d.socket.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '聊聊天文' }));
  await d.wait('answer.done'); assert.doesNotMatch(JSON.stringify(inputs), /黄铜燕子/);
});

for (const lastSeen of [0, 2]) test(`offline forgetting survives reconnect and server restart (lastSeen=${lastSeen})`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-boundary-ws-'));
  let store = await ConversationStore.create(root);
  const token = 'synthetic-token-'.repeat(5), clientId = randomUUID(), secret = '合成秘密银杏书签';
  const model = { decide: async () => 'respond' as const, reply: async (_h: Message[], _s: AbortSignal, delta: (s: string) => void) => { delta(secret); } };
  const start = async () => {
    const app = createConversationServer({ token, model, conversationStore: store, transcriber: () => { throw Error('No audio'); } });
    app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening'); return app;
  };
  let app = await start(); const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(s => s.terminate()); await app.close(); await store.close(); });
  const connect = async (resume?: any) => {
    const socket = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`); sockets.push(socket);
    const events: any[] = []; socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    const wait = async (type: string) => {
      const until = Date.now() + 4000;
      while (Date.now() < until) { const e = events.find(e => e.type === type); if (e) return e; await new Promise(r => setTimeout(r, 5)); }
      throw Error('Missing ' + type);
    };
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId,
      ...(resume ? { resume_session_id: resume.session_id, resume_credential: resume.resume_credential, last_seen_sequence: lastSeen } : { token }),
      client_capabilities: { location: false }, credential_storage: 'browser_v1' }));
    return { socket, wait, ready: await wait('ready') };
  };
  const first = await connect(), s = first.ready.session_id, id = randomUUID();
  first.socket.send(JSON.stringify({ type: 'text.submit', message_id: id, text: secret })); await first.wait('answer.done');
  const owner = { mode: 'owner' as const, ownerScope: 'single-user' };
  const memory = store.mutatePersonalMemory(owner, { source: { sessionId: s, messageId: id }, proposal: { action: 'save', kind: 'fact', content: secret } });
  first.socket.close(); await once(first.socket, 'close');
  const other = randomUUID(), topicId = randomUUID(), messageId = randomUUID();
  store.createSession({ id: other, ownerScope: owner.ownerScope, createdAt: Date.now(), initialTopic: { id: topicId, label: '合成' } });
  store.commitUserTurn({ sessionId: other, topicId, messageId, turnId: randomUUID(), content: '忘掉书签', createdAt: Date.now() });
  store.mutatePersonalMemory(owner, { source: { sessionId: other, messageId }, targetId: memory.id,
    proposal: { action: 'forget', target: '书签', level: 'memory_only' } });
  const freshTopic = randomUUID(); store.ensureTopic({ sessionId: s, id: freshTopic, label: '新内容', at: Date.now() });
  store.commitUserTurn({ sessionId: s, topicId: freshTopic, messageId: randomUUID(), turnId: randomUUID(), content: '遗忘之后新话题', createdAt: Date.now() });
  const second = await connect(first.ready);
  assert.equal(second.ready.resumed, true); assert.notEqual(second.ready.memory_boundary, first.ready.memory_boundary);
  assert.equal(second.ready.snapshot.messages.length, 1);
  assert.equal(second.ready.snapshot.messages[0].content, '遗忘之后新话题');
  assert.doesNotMatch(JSON.stringify(second.ready.snapshot), /银杏书签/);
  second.socket.close(); await once(second.socket, 'close'); await app.close(); await store.close();
  store = await ConversationStore.create(root); app = await start();
  const third = await connect(second.ready);
  assert.equal(third.ready.memory_boundary, second.ready.memory_boundary);
  assert.doesNotMatch(JSON.stringify(third.ready.snapshot), /银杏书签/);
});

test('hybrid revocation drops cached original and pending retries, including nested ordinary model', async () => {
  let nested = 0; const base = { decide: async () => 'respond' as const, reply: async () => {} };
  const hybrid = new HybridDialogue(base, base, async () => {}, undefined, undefined,
    [{ ...base, revokeMemoryContext: () => { nested++; } }]);
  const controller = new AbortController();
  await hybrid.reply([{ role: 'user', content: 'synthetic secret', messageId: randomUUID() }], controller.signal, () => {});
  await hybrid.plan([{ role: 'user', content: 'synthetic secret' }], '重新回答', false, controller.signal);
  hybrid.revokeMemoryContext();
  assert.equal((hybrid as any).original, undefined); assert.equal((hybrid as any).retries.get(controller.signal), undefined);
  assert.equal(nested, 1);
});
