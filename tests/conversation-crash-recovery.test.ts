import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-conversation-crash-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({
    id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'conversation' },
  });
  return { root, store, sessionId, topicId };
}

test('crash before user commit leaves no message, turn or sequence allocation', async () => {
  const { root, store, sessionId } = await fixture();
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getSession(sessionId)?.latestSequence, 0);
    assert.deepEqual(reopened.listMessages(sessionId), []);
  } finally { await reopened.close(); }
});

test('crash after user commit preserves the input and marks its unfinished turn interrupted', async () => {
  const { root, store, sessionId, topicId } = await fixture();
  const messageId = randomUUID(), turnId = randomUUID();
  store.commitUserTurn({ sessionId, topicId, messageId, turnId, content: 'durable question', createdAt: 101 });
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getMessage(messageId)?.status, 'committed');
    assert.equal(reopened.getTurn(turnId)?.status, 'interrupted');
    assert.equal(reopened.getTurn(turnId)?.errorCode, 'SERVICE_RESTARTED');
    assert.equal(reopened.getSession(sessionId)?.latestSequence, 1);
  } finally { await reopened.close(); }
});

test('crash after a streamed checkpoint retains only an explicitly interrupted partial', async () => {
  const { root, store, sessionId, topicId } = await fixture();
  const turnId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  store.commitUserTurn({ sessionId, topicId, messageId: userMessageId, turnId, content: 'question', createdAt: 101 });
  store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: assistantMessageId, createdAt: 102 });
  store.checkpointAssistantAnswer({ messageId: assistantMessageId, content: 'partial checkpoint', updatedAt: 103 });
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    const message = reopened.getMessage(assistantMessageId)!;
    assert.equal(message.status, 'interrupted');
    assert.equal(message.content, 'partial checkpoint');
    assert.equal(reopened.getTurn(turnId)?.status, 'interrupted');
    assert.equal(reopened.getSession(sessionId)?.latestSequence, 2);
  } finally { await reopened.close(); }
});

test('failed final transaction never exposes committed state', async () => {
  const { store, sessionId, topicId } = await fixture();
  const turnId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const circular: unknown[] = []; circular.push(circular);
  try {
    store.commitUserTurn({ sessionId, topicId, messageId: userMessageId, turnId, content: 'question', createdAt: 101 });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: assistantMessageId, createdAt: 102 });
    store.checkpointAssistantAnswer({ messageId: assistantMessageId, content: 'last safe checkpoint', updatedAt: 103 });
    assert.throws(() => store.commitAssistantAnswer({
      messageId: assistantMessageId, content: 'final answer', citations: circular, updatedAt: 104,
    }));
    assert.equal(store.getMessage(assistantMessageId)?.status, 'streaming');
    assert.equal(store.getMessage(assistantMessageId)?.content, 'last safe checkpoint');
    assert.equal(store.getTurn(turnId)?.status, 'answering');
  } finally { await store.close(); }
});

test('crash after final commit keeps the answer committed for sequence replay', async () => {
  const { root, store, sessionId, topicId } = await fixture();
  const turnId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  store.commitUserTurn({ sessionId, topicId, messageId: userMessageId, turnId, content: 'question', createdAt: 101 });
  store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: assistantMessageId, createdAt: 102 });
  store.commitAssistantAnswer({ messageId: assistantMessageId, content: 'committed answer', updatedAt: 103 });
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getMessage(assistantMessageId)?.status, 'committed');
    assert.equal(reopened.getMessage(assistantMessageId)?.content, 'committed answer');
    assert.equal(reopened.getTurn(turnId)?.status, 'committed');
    assert.deepEqual(reopened.listMessages(sessionId).map(message => message.sequence), [1, 2]);
  } finally { await reopened.close(); }
});
