import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';
import { JobStore } from '../src/job-store.js';
// The production verifier stays dependency-free JavaScript so it can run from
// /usr/local/lib without the source checkout.
// @ts-expect-error deploy verifier intentionally has no TypeScript declaration
import { verifyBackupRoot } from '../deploy/verify-backup.mjs';

async function restoredFixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-backup-verify-'));
  const sessionId = randomUUID(), topicId = randomUUID();
  const store = await ConversationStore.create(root);
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'Restore drill' } });
  const turnId = randomUUID(), inputId = randomUUID(), outputId = randomUUID();
  store.commitUserTurn({ sessionId, topicId, turnId, messageId: inputId, content: 'private test message', createdAt: 110 });
  store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: outputId, createdAt: 111 });
  store.commitAssistantAnswer({ messageId: outputId, content: 'private test answer', updatedAt: 112 });
  const job = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 2, createdAt: 113 });
  store.claimNextSummaryJob(114);
  store.completeSummaryJob({ id: job.id, model: 'test-summary', at: 115, summary: {
    version: 1, throughSequence: 2, overview: 'private summary', topics: [],
    confirmedDecisions: [], unresolvedItems: [],
  } });
  store.endSession(sessionId, 120, 'user_exit');
  await store.close();
  const jobs = await JobStore.create(root);
  await jobs.close();
  return { root, sessionId };
}

test('backup verifier checks conversation integrity and the restored store can reopen', async () => {
  const { root, sessionId } = await restoredFixture();
  const report = await verifyBackupRoot(root, { expectedRoot: root });
  assert.equal(report.foundJobs, true);
  assert.equal(report.foundConversation, true);
  assert.equal(report.conversation.sessions, 1);
  assert.equal(report.conversation.messages, 2);
  assert.equal(report.conversation.latestSequence, 2);
  assert.equal(report.conversation.summaryThroughSequence, 2);

  const reopened = await ConversationStore.create(root);
  try {
    assert.equal(reopened.getSession(sessionId)?.status, 'ended');
    assert.equal(reopened.listMessages(sessionId, 0, 10).length, 2);
  } finally { await reopened.close(); }
});

test('backup verifier rejects foreign-key damage without echoing transcript content', async () => {
  const { root } = await restoredFixture();
  const database = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare('UPDATE messages SET session_id=? WHERE sequence=1').run(randomUUID());
  } finally { database.close(); }

  await assert.rejects(verifyBackupRoot(root, { expectedRoot: root }), error => {
    assert.doesNotMatch(String(error), /private test message|private test answer|private summary/);
    return /foreign key/i.test(String(error));
  });
});

test('backup verifier rejects inconsistent session sequence metadata', async () => {
  const { root } = await restoredFixture();
  const database = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try { database.exec('PRAGMA foreign_keys=ON'); database.prepare('UPDATE sessions SET latest_sequence=99').run(); }
  finally { database.close(); }
  await assert.rejects(verifyBackupRoot(root, { expectedRoot: root }), /latest sequence/i);
});
