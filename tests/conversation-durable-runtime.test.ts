import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Conversation, type DialogueModel, type Event } from '../src/conversation.js';
import { StoreConversationPersistence } from '../src/conversation-persistence.js';
import { ConversationStore } from '../src/conversation-store.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-durable-runtime-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  return { store, sessionId, topicId };
}

test('conversation commits stable user and assistant identities before reporting completion', async () => {
  const { store, sessionId, topicId } = await fixture();
  const userMessageId = randomUUID(), turnId = randomUUID(), assistantMessageId = randomUUID();
  const ids = [turnId, assistantMessageId], events: Event[] = [];
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => { delta('durable '); delta('answer'); },
  };
  try {
    const persistence = new StoreConversationPersistence(store, sessionId, () => 200);
    const conversation = new Conversation(model, event => events.push(event), undefined, {
      sessionId, persistence, initialTopic: { id: topicId, label: 'General' },
      idFactory: () => ids.shift()!, now: () => 200,
    });
    await conversation.submit('durable question', false, { messageId: userMessageId });

    assert.deepEqual(store.listMessages(sessionId).map(message => ({
      id: message.id, turnId: message.turnId, sequence: message.sequence, role: message.role,
      status: message.status, content: message.content,
    })), [
      { id: userMessageId, turnId, sequence: 1, role: 'user', status: 'committed', content: 'durable question' },
      { id: assistantMessageId, turnId, sequence: 2, role: 'assistant', status: 'committed', content: 'durable answer' },
    ]);
    const done = events.find(event => event.type === 'answer.done')!;
    assert.equal(done.message_id, assistantMessageId);
    assert.equal(done.turn_id, turnId);
    assert.equal(done.sequence, 2);
  } finally { await store.close(); }
});
test('duplicate durable user message returns its original acknowledgement without a second model call', async () => {
  const { store, sessionId, topicId } = await fixture();
  const userMessageId = randomUUID(); let replies = 0;
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => { replies++; delta('once'); },
  };
  try {
    const make = () => new Conversation(model, () => {}, undefined, {
      sessionId, persistence: new StoreConversationPersistence(store, sessionId, () => 200),
      initialTopic: { id: topicId, label: 'General' }, idFactory: randomUUID, now: () => 200,
    });
    await make().submit('same question', false, { messageId: userMessageId });
    await make().submit('same question', false, { messageId: userMessageId });
    assert.equal(replies, 1);
    assert.equal(store.listMessages(sessionId).length, 2);
  } finally { await store.close(); }
});

test('disconnect interruption marks a streaming durable answer interrupted', async () => {
  const { store, sessionId, topicId } = await fixture();
  const gate = deferred<void>();
  const model: DialogueModel = {
    decide: async () => 'respond',
    reply: async (_history, _signal, delta) => { delta('partial'); await gate.promise; },
  };
  try {
    const conversation = new Conversation(model, () => {}, undefined, {
      sessionId, persistence: new StoreConversationPersistence(store, sessionId),
      initialTopic: { id: topicId, label: 'General' }, idFactory: randomUUID,
    });
    const pending = conversation.submit('question', false, { messageId: randomUUID() });
    await tick();
    conversation.interrupt();
    gate.resolve(); await pending;
    const messages = store.listMessages(sessionId);
    assert.equal(messages[1].status, 'interrupted');
    assert.equal(messages[1].content, 'partial');
    assert.equal(store.getTurn(messages[0].turnId!)?.status, 'interrupted');
  } finally { await store.close(); }
});
