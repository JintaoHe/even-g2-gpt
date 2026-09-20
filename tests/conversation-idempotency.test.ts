import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore, ConversationStoreConflictError } from '../src/conversation-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-conversation-idempotency-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({
    id: sessionId, ownerScope: 'single-user', createdAt: 1_700_000_000_000,
    initialTopic: { id: topicId, label: 'conversation' },
  });
  return { root, store, sessionId, topicId };
}

test('user message, turn and monotonic sequence commit atomically and survive reopen', async () => {
  const { root, store, sessionId, topicId } = await fixture();
  const messageId = randomUUID(), turnId = randomUUID();
  const result = store.commitUserTurn({
    sessionId, topicId, messageId, turnId, content: 'Hi Even，中英混合', createdAt: 1_700_000_000_001,
    cognitiveMode: 'casual', reasoningEffort: 'low',
  });
  assert.deepEqual(result, { result: 'committed', sessionId, messageId, turnId, sequence: 1 });
  assert.equal(store.getSession(sessionId)?.latestSequence, 1);
  assert.deepEqual(store.getMessage(messageId), {
    id: messageId, sessionId, turnId, topicId, sequence: 1, role: 'user', status: 'committed',
    content: 'Hi Even，中英混合', createdAt: 1_700_000_000_001, updatedAt: 1_700_000_000_001,
  });
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getSession(sessionId)?.latestSequence, 1);
    assert.equal(reopened.getMessage(messageId)?.content, 'Hi Even，中英混合');
    assert.equal(reopened.getTurn(turnId)?.status, 'interrupted');
    assert.equal(reopened.getTurn(turnId)?.errorCode, 'SERVICE_RESTARTED');
  } finally { await reopened.close(); }
});

test('same message id and content returns the original acknowledgement without another turn', async () => {
  const { store, sessionId, topicId } = await fixture();
  const messageId = randomUUID(), originalTurnId = randomUUID();
  try {
    const input = { sessionId, topicId, messageId, turnId: originalTurnId, content: 'same message', createdAt: 10 };
    assert.equal(store.commitUserTurn(input).result, 'committed');
    const duplicates = await Promise.all(Array.from({ length: 20 }, (_, n) => Promise.resolve().then(() =>
      store.commitUserTurn({ ...input, turnId: randomUUID(), createdAt: 20 + n }))));
    for (const duplicate of duplicates) assert.deepEqual(duplicate,
      { result: 'duplicate', sessionId, messageId, turnId: originalTurnId, sequence: 1 });
    assert.equal(store.getSession(sessionId)?.latestSequence, 1);
    assert.equal(store.listMessages(sessionId).length, 1);
  } finally { await store.close(); }
});

test('same message id with different content is a conflict and cannot advance sequence', async () => {
  const { store, sessionId, topicId } = await fixture();
  const messageId = randomUUID();
  try {
    store.commitUserTurn({ sessionId, topicId, messageId, turnId: randomUUID(), content: 'original', createdAt: 10 });
    assert.throws(() => store.commitUserTurn({
      sessionId, topicId, messageId, turnId: randomUUID(), content: 'changed', createdAt: 11,
    }), ConversationStoreConflictError);
    assert.equal(store.getSession(sessionId)?.latestSequence, 1);
    assert.equal(store.getMessage(messageId)?.content, 'original');
  } finally { await store.close(); }
});

test('a late turn constraint failure rolls back the session sequence and message insert', async () => {
  const { store, sessionId, topicId } = await fixture();
  const turnId = randomUUID(), firstMessage = randomUUID(), failedMessage = randomUUID();
  try {
    store.commitUserTurn({ sessionId, topicId, messageId: firstMessage, turnId, content: 'first', createdAt: 10 });
    assert.throws(() => store.commitUserTurn({
      sessionId, topicId, messageId: failedMessage, turnId, content: 'must roll back', createdAt: 11,
    }));
    assert.equal(store.getSession(sessionId)?.latestSequence, 1);
    assert.equal(store.getMessage(failedMessage), undefined);
    assert.equal(store.listMessages(sessionId).length, 1);
    const next = store.commitUserTurn({
      sessionId, topicId, messageId: randomUUID(), turnId: randomUUID(), content: 'second', createdAt: 12,
    });
    assert.equal(next.sequence, 2);
  } finally { await store.close(); }
});

test('invalid IDs, timestamps, topics and bounded content fail before durable changes', async () => {
  const { store, sessionId, topicId } = await fixture();
  const base = { sessionId, topicId, messageId: randomUUID(), turnId: randomUUID(), content: 'valid', createdAt: 10 };
  try {
    for (const input of [
      { ...base, messageId: 'bad' },
      { ...base, turnId: 'bad' },
      { ...base, topicId: randomUUID() },
      { ...base, content: ' ' },
      { ...base, content: 'x'.repeat(6001) },
      { ...base, createdAt: -1 },
    ]) assert.throws(() => store.commitUserTurn(input));
    assert.equal(store.getSession(sessionId)?.latestSequence, 0);
    assert.equal(store.listMessages(sessionId).length, 0);
  } finally { await store.close(); }
});
