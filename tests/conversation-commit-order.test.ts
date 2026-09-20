import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore, ConversationStoreConflictError } from '../src/conversation-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-conversation-answer-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID(), turnId = randomUUID(), userMessageId = randomUUID();
  store.createSession({
    id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'conversation' },
  });
  store.commitUserTurn({ sessionId, topicId, turnId, messageId: userMessageId, content: 'question', createdAt: 101 });
  return { root, store, sessionId, topicId, turnId };
}

test('assistant stream has a durable placeholder and commits final content before returning', async () => {
  const { store, sessionId, topicId, turnId } = await fixture();
  const messageId = randomUUID();
  try {
    assert.deepEqual(store.startAssistantAnswer({ sessionId, topicId, turnId, messageId, createdAt: 102 }),
      { result: 'started', sessionId, messageId, turnId, sequence: 2 });
    assert.equal(store.getMessage(messageId)?.status, 'streaming');
    assert.equal(store.getTurn(turnId)?.status, 'answering');

    store.checkpointAssistantAnswer({ messageId, content: 'partial', updatedAt: 103 });
    assert.equal(store.getMessage(messageId)?.content, 'partial');

    const citations = [{ start: 0, end: 5, url: 'https://example.com/source', title: 'Source' }];
    assert.deepEqual(store.commitAssistantAnswer({ messageId, content: 'final answer', citations, updatedAt: 104 }),
      { result: 'committed', sessionId, messageId, turnId, sequence: 2 });
    const saved = store.getMessage(messageId)!;
    assert.equal(saved.status, 'committed');
    assert.equal(saved.content, 'final answer');
    assert.deepEqual(saved.citations, citations);
    assert.equal(store.getTurn(turnId)?.status, 'committed');
    assert.equal(store.getTurn(turnId)?.outputMessageId, messageId);
    assert.equal(store.getSession(sessionId)?.latestSequence, 2);

    assert.deepEqual(store.commitAssistantAnswer({ messageId, content: 'final answer', citations, updatedAt: 105 }),
      { result: 'duplicate', sessionId, messageId, turnId, sequence: 2 });
    assert.throws(() => store.commitAssistantAnswer({ messageId, content: 'different answer', citations, updatedAt: 106 }),
      ConversationStoreConflictError);
    assert.throws(() => store.checkpointAssistantAnswer({ messageId, content: 'late partial', updatedAt: 107 }));
  } finally { await store.close(); }
});

test('explicit interruption preserves bounded partial content without pretending it is complete', async () => {
  const { store, sessionId, topicId, turnId } = await fixture();
  const messageId = randomUUID();
  try {
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId, createdAt: 102 });
    store.checkpointAssistantAnswer({ messageId, content: 'useful partial', updatedAt: 103 });
    assert.deepEqual(store.interruptAssistantAnswer({ turnId, updatedAt: 104, reason: 'CLIENT_DISCONNECTED' }),
      { result: 'interrupted', sessionId, messageId, turnId, sequence: 2 });
    assert.equal(store.getMessage(messageId)?.status, 'interrupted');
    assert.equal(store.getMessage(messageId)?.content, 'useful partial');
    assert.equal(store.getTurn(turnId)?.status, 'interrupted');
    assert.equal(store.getTurn(turnId)?.errorCode, 'CLIENT_DISCONNECTED');
    assert.deepEqual(store.interruptAssistantAnswer({ turnId, updatedAt: 105, reason: 'CLIENT_DISCONNECTED' }),
      { result: 'duplicate', sessionId, messageId, turnId, sequence: 2 });
  } finally { await store.close(); }
});

test('service reopen marks unfinished answer and turn interrupted, then idles the session', async () => {
  const { root, store, sessionId, topicId, turnId } = await fixture();
  const messageId = randomUUID();
  store.startAssistantAnswer({ sessionId, topicId, turnId, messageId, createdAt: 102 });
  store.checkpointAssistantAnswer({ messageId, content: 'checkpoint before crash', updatedAt: 103 });
  await store.close();

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getMessage(messageId)?.status, 'interrupted');
    assert.equal(reopened.getMessage(messageId)?.content, 'checkpoint before crash');
    assert.equal(reopened.getTurn(turnId)?.status, 'interrupted');
    assert.equal(reopened.getTurn(turnId)?.errorCode, 'SERVICE_RESTARTED');
    assert.equal(reopened.getSession(sessionId)?.status, 'idle');
    assert.throws(() => reopened.commitAssistantAnswer({ messageId, content: 'must not commit later', updatedAt: 200 }));
  } finally { await reopened.close(); }
});

test('invalid final serialization leaves the answer streaming and sequence unchanged', async () => {
  const { store, sessionId, topicId, turnId } = await fixture();
  const messageId = randomUUID(), circular: any[] = [];
  circular.push(circular);
  try {
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId, createdAt: 102 });
    assert.throws(() => store.commitAssistantAnswer({ messageId, content: 'answer', citations: circular, updatedAt: 103 }));
    assert.equal(store.getMessage(messageId)?.status, 'streaming');
    assert.equal(store.getTurn(turnId)?.status, 'answering');
    assert.equal(store.getSession(sessionId)?.latestSequence, 2);
  } finally { await store.close(); }
});
