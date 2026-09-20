import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-turn-recovery-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  return { store, sessionId, topicId };
}

test('latest recoverable turn returns the committed answer verbatim for replay', async () => {
  const { store, sessionId, topicId } = await fixture();
  try {
    const turnId = randomUUID(), userId = randomUUID(), answerId = randomUUID();
    store.commitUserTurn({ sessionId, topicId, turnId, messageId: userId, content: 'question', createdAt: 101 });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: answerId, createdAt: 102 });
    store.commitAssistantAnswer({ messageId: answerId, content: 'stored answer', citations: [
      { start: 0, end: 6, url: 'https://example.com', title: 'Example' },
    ], updatedAt: 103 });
    const recovered = store.latestRecoverableTurn(sessionId)!;
    assert.equal(recovered.turn.id, turnId);
    assert.equal(recovered.input.content, 'question');
    assert.equal(recovered.output?.status, 'committed');
    assert.equal(recovered.output?.content, 'stored answer');
  } finally { await store.close(); }
});
test('latest recoverable turn preserves interrupted status and partial separately', async () => {
  const { store, sessionId, topicId } = await fixture();
  try {
    const turnId = randomUUID(), userId = randomUUID(), answerId = randomUUID();
    store.commitUserTurn({ sessionId, topicId, turnId, messageId: userId, content: 'question', createdAt: 101 });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: answerId, createdAt: 102 });
    store.checkpointAssistantAnswer({ messageId: answerId, content: 'partial', updatedAt: 103 });
    store.interruptAssistantAnswer({ turnId, updatedAt: 104, reason: 'CONNECTION_INTERRUPTED' });
    const recovered = store.latestRecoverableTurn(sessionId)!;
    assert.equal(recovered.turn.status, 'interrupted');
    assert.equal(recovered.output?.status, 'interrupted');
    assert.equal(recovered.output?.content, 'partial');
  } finally { await store.close(); }
});
