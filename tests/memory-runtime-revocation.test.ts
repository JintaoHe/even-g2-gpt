import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Conversation, type DialogueModel, type Event } from '../src/conversation.js';
import { ConversationStore } from '../src/conversation-store.js';
import { StoreConversationPersistence } from '../src/conversation-persistence.js';

const owner = { mode: 'owner' as const, ownerScope: 'single-user' };
const secret = '合成偏好：松木色收纳盒';

test('reset notification uses exactly the successful boundary read, without another lookup', async t => {
  const f = await setup(t);
  let reads = 0;
  const events: Event[] = [];
  const conversation = new Conversation({ decide: async () => { throw Error('Must not call model'); }, reply: async () => {} },
    event => events.push(event), undefined, {
      sessionId: f.s, persistence: new StoreConversationPersistence(f.store, f.s),
      memoryBoundary: () => ({ version: `${reads++}:0`, floor: 1 }),
    });
  await conversation.submit('合成问题');
  assert.equal(reads, 2); // constructor + refresh only
  const notices = events.filter(e => e.type === 'notice' && e.code === 'MEMORY_CONTEXT_RESET');
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.type === 'notice'); assert.equal(notices[0].memory_boundary, '1:0');
  conversation.close();
});

test('post-forget interrupted assistant keeps its sequence and remains in the next context', async t => {
  const f = await setup(t); f.forget();
  let entered!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const histories: string[] = [];
  const { conversation } = f.runtime({ decide: async h => { histories.push(JSON.stringify(h)); return 'respond'; },
    reply: async (_h, _s, delta) => { calls++; delta('新的骑行路线第一段'); if (calls === 1) { entered(); await gate; } } });
  const pending = conversation.submit('聊新的骑行路线'); await ready;
  conversation.interrupt(); release(); await pending;
  const partial = conversation.history.find(m => m.status === 'interrupted');
  assert.ok(partial && Number.isSafeInteger(partial.sequence));
  await conversation.submit('继续刚才的路线');
  assert.match(histories.at(-1)!, /新的骑行路线第一段/);
});
async function setup(t: TestContext) {
  const store = await ConversationStore.create(await mkdtemp(join(tmpdir(), 'pi4-runtime-revoke-')));
  const sessions = () => { const id = randomUUID(); store.createSession({ id, ownerScope: owner.ownerScope, createdAt: 1 }); return id; };
  const s = sessions(), sourceSession = sessions();
  const user = (sessionId: string, content: string) => {
    const topicId = randomUUID(), messageId = randomUUID();
    store.ensureTopic({ sessionId, id: topicId, label: '合成主题', at: 2 });
    const ack = store.commitUserTurn({ sessionId, topicId, messageId, turnId: randomUUID(), content, createdAt: 2 });
    return { sessionId, messageId, sequence: ack.sequence };
  };
  const source = user(s, secret);
  const memory = store.mutatePersonalMemory(owner, { source: { sessionId: s, messageId: source.messageId },
    proposal: { action: 'save', kind: 'preference', content: secret } }, 3);
  const forget = () => {
    const source = user(sourceSession, '忘掉收纳盒偏好');
    return store.mutatePersonalMemory(owner, { source: { sessionId: sourceSession, messageId: source.messageId }, targetId: memory.id,
      proposal: { action: 'forget', target: '收纳盒偏好', level: 'memory_only' } }, 4);
  };
  const conversations: Conversation[] = [];
  const runtime = (model: DialogueModel, subscribe = true) => {
    const events: Event[] = [];
    const conversation = new Conversation(model, event => events.push(event), undefined, {
      sessionId: s, persistence: new StoreConversationPersistence(store, s), now: () => 5,
      memoryBoundary: () => store.memoryContextBoundary(s),
      ...(subscribe ? { subscribeMemorySuppression: (listener: () => void) => store.onMemorySuppression(listener) } : {}),
    });
    conversation.restoreHistory([{ role: 'user', content: secret, messageId: source.messageId, sequence: source.sequence, status: 'committed' }]);
    conversations.push(conversation); return { conversation, events };
  };
  t.after(async () => { conversations.forEach(c => c.close()); await store.close(); });
  return { store, s, source, forget, runtime, memory, user, sessions };
}

test('committed forgetting immediately clears idle runtime history; next plan and reply use only new turns', async t => {
  const f = await setup(t), inputs: string[] = [];
  const { conversation, events } = f.runtime({ decide: async (h) => { inputs.push(JSON.stringify(h)); return 'respond'; },
    reply: async (h, _s, delta) => { inputs.push(JSON.stringify(h)); delta('新话题回答'); } });
  f.forget(); assert.equal(conversation.history.length, 0);
  const notice = events.find(e => e.type === 'notice' && e.code === 'MEMORY_CONTEXT_RESET');
  assert.ok(notice && notice.type === 'notice');
  assert.equal(notice.memory_boundary, f.store.memoryContextBoundary(f.s).version);
  await conversation.submit('讨论周末骑行');
  assert.equal(inputs.length, 2); inputs.forEach(input => assert.ok(!input.includes(secret)));
  assert.equal(conversation.history.at(-1)?.content, '新话题回答');
  assert.ok(f.store.listCommittedMessages(f.s, 0, 100, 100).some(m => m.content === secret));
});

test('failed memory mutation sends no invalidation and an unreadable boundary fails closed', async t => {
  const f = await setup(t);
  const { conversation, events } = f.runtime({ decide: async () => 'respond', reply: async (_h, _s, delta) => { delta(secret); } });
  const before = JSON.stringify(conversation.history);
  assert.throws(() => f.store.mutatePersonalMemory(owner, {
    source: { sessionId: f.s, messageId: f.source.messageId }, targetId: f.memory.id,
    proposal: { action: 'forget', target: '收纳盒', level: 'memory_only' },
  }, 5), /MEMORY_SOURCE_USED/);
  assert.equal(JSON.stringify(conversation.history), before);
  const boundary = f.store.memoryContextBoundary.bind(f.store);
  let reads = 0;
  f.store.memoryContextBoundary = () => { reads++; throw new Error('unreadable'); };
  await conversation.submit('不应交付');
  assert.equal(conversation.history.length, 0);
  assert.equal(events.some(e => e.type === 'answer.delta'), false);
  const notices = events.filter(e => e.type === 'notice' && e.code === 'MEMORY_CONTEXT_RESET');
  assert.equal(reads, 1); assert.equal(notices.length, 1);
  assert.equal(Object.hasOwn(notices[0]!, 'memory_boundary'), false);
  f.store.memoryContextBoundary = boundary;
});

test('forgetting aborts in-flight replies; ignored abort and late citations cannot deliver or commit', async t => {
  const f = await setup(t);
  let release!: () => void, entered!: () => void, signal!: AbortSignal;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const { conversation, events } = f.runtime({ decide: async () => 'respond', reply: async (_h, s, delta, update) => {
    signal = s; entered(); await gate; delta(secret); update?.({ type: 'answer.citations', text: secret, citations: [] });
  } });
  const pending = conversation.submit('谈谈收纳');
  await ready; f.forget(); assert.ok(signal.aborted); release(); await pending;
  assert.deepEqual(conversation.history, []);
  assert.equal(events.some(e => ['answer.delta', 'answer.citations', 'answer.committed'].includes(e.type)), false);
  assert.equal(f.store.listCommittedMessages(f.s, 0, 100, 100).filter(m => m.role === 'assistant').length, 0);
});

test('callback-boundary recheck revokes stale in-flight plans even without a notification subscription', async t => {
  const f = await setup(t); let release!: () => void, entered!: () => void, replies = 0;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const { conversation } = f.runtime({ decide: async () => { entered(); await gate; return 'respond'; },
    reply: async () => { replies++; } }, false);
  const pending = conversation.submit('旧上下文问题'); await ready; f.forget(); release(); await pending;
  assert.equal(replies, 0); assert.deepEqual(conversation.history, []);
});

test('rehydration filters old durable messages, unrelated mutations do not revoke, close unsubscribes', async t => {
  const f = await setup(t); f.forget();
  const { conversation } = f.runtime({ decide: async () => 'respond', reply: async (_h, _s, delta) => { delta('新回答'); } });
  assert.deepEqual(conversation.history, []); await conversation.submit('新的请求');
  const before = JSON.stringify(conversation.history);
  const other = f.sessions(), src = f.user(other, '记住蓝色杯子');
  f.store.mutatePersonalMemory(owner, { source: { sessionId: other, messageId: src.messageId },
    proposal: { action: 'save', kind: 'fact', content: '蓝色杯子' } }, 6);
  assert.equal(JSON.stringify(conversation.history), before);
  conversation.close(); assert.equal((f.store as any).memorySuppressionListeners.size, 0);
});
