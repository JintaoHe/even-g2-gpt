import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';
import {
  OpenAISessionSummaryGenerator,
  SessionSummaryService,
  type SessionSummaryGenerationRequest,
} from '../src/session-summary.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(turns = 6) {
  const root = await mkdtemp(join(tmpdir(), 'even-summary-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  const append = (index: number) => {
    const turnId = randomUUID(), inputId = randomUUID(), outputId = randomUUID(), at = 200 + index * 10;
    store.commitUserTurn({ sessionId, topicId, turnId, messageId: inputId,
      content: `问题 ${index}`, createdAt: at });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: outputId, createdAt: at + 1 });
    store.commitAssistantAnswer({ messageId: outputId, content: `回答 ${index}`, updatedAt: at + 2 });
  };
  for (let index = 0; index < turns; index++) append(index);
  return { root, store, sessionId, topicId, append };
}

function validSummary(throughSequence: number) {
  return {
    version: 1 as const,
    throughSequence,
    overview: '讨论了行程和产品设计。',
    topics: [{ id: 'topic', label: '产品设计', summary: '决定继续实现可靠会话。' }],
    confirmedDecisions: ['历史保留三年。'],
    unresolvedItems: ['等待真机测试。'],
  };
}

test('invalid summary schema is repaired once and saved at the fixed message boundary', async () => {
  const { store, sessionId } = await fixture();
  const attempts: string[] = [];
  const service = new SessionSummaryService(store, {
    model: 'summary-test',
    generate: async request => {
      attempts.push(request.attempt);
      return request.attempt === 'summarize' ? { overview: 7 } : validSummary(request.throughSequence);
    },
  }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    service.consider(sessionId);
    await service.waitForIdle();
    assert.deepEqual(attempts, ['summarize', 'repair']);
    const saved = store.latestSummary(sessionId);
    assert.equal(saved?.throughSequence, 10);
    assert.equal(store.getSession(sessionId)?.summaryThroughSequence, 10);
    assert.equal(store.listSummaryJobs(sessionId)[0].status, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('two invalid schemas or a model failure do not block and fail the durable job', async () => {
  for (const generator of [
    async (_request: SessionSummaryGenerationRequest) => ({ wrong: true }),
    async (_request: SessionSummaryGenerationRequest) => { throw new Error('provider down'); },
  ]) {
    const { store, sessionId } = await fixture();
    const service = new SessionSummaryService(store, { model: 'summary-test', generate: generator },
      { messageThreshold: 8, keepRecentMessages: 2 });
    try {
      assert.doesNotThrow(() => service.consider(sessionId));
      await service.waitForIdle();
      assert.equal(store.latestSummary(sessionId), undefined);
      assert.equal(store.listSummaryJobs(sessionId)[0].status, 'failed');
    } finally { await service.close(); await store.close(); }
  }
});

test('same summary range is idempotent and a running job becomes unknown after restart', async () => {
  const { root, store, sessionId } = await fixture();
  const first = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 10, createdAt: 500 });
  const duplicate = store.enqueueSummaryJob({ sessionId, fromSequence: 1, throughSequence: 10, createdAt: 501 });
  assert.equal(first.id, duplicate.id);
  assert.equal(store.claimNextSummaryJob(502)?.id, first.id);
  await store.close();

  const reopened = await ConversationStore.create(root); let calls = 0;
  const service = new SessionSummaryService(reopened, { model: 'summary-test', generate: async request => {
    calls++; return validSummary(request.throughSequence);
  } }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    assert.equal(reopened.listSummaryJobs(sessionId)[0].status, 'unknown');
    service.consider(sessionId);
    await service.waitForIdle();
    assert.equal(calls, 0, 'an uncertain provider outcome must not be billed twice');
  } finally { await service.close(); await reopened.close(); }
});

test('messages added while generation is running remain outside the immutable summary range', async () => {
  const { store, sessionId, append } = await fixture();
  const gate = deferred<unknown>(); let request!: SessionSummaryGenerationRequest;
  const service = new SessionSummaryService(store, { model: 'summary-test', generate: async input => {
    request = input; return gate.promise;
  } }, { messageThreshold: 8, keepRecentMessages: 2 });
  try {
    service.consider(sessionId);
    while (!request) await tick();
    append(99);
    gate.resolve(validSummary(request.throughSequence));
    await service.waitForIdle();
    assert.equal(store.latestSummary(sessionId)?.throughSequence, 10);
    assert.equal(store.getSession(sessionId)?.latestSequence, 14);
    assert.deepEqual(request.messages.map(message => message.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { await service.close(); await store.close(); }
});

test('OpenAI summary generation uses the supplied metered fetch and exposes no tools', async () => {
  let meteredCalls = 0; let body: any; let idempotency = '';
  const meteredFetch: typeof fetch = async (_input, init) => {
    meteredCalls++;
    body = JSON.parse(String(init?.body));
    idempotency = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify(validSummary(8)) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const generator = new OpenAISessionSummaryGenerator('secret', 'summary-model',
    'https://api.openai.com/v1/responses', meteredFetch);
  const result = await generator.generate({
    jobId: randomUUID(), sessionId: randomUUID(), fromSequence: 1, throughSequence: 8,
    messages: [], attempt: 'summarize',
  }, new AbortController().signal);

  assert.equal(meteredCalls, 1);
  assert.equal(body.store, false);
  assert.equal('tools' in body, false);
  assert.equal(body.text.format.strict, true);
  assert.match(idempotency, /^session-summary-/);
  assert.deepEqual(result, validSummary(8));
});

test('production threshold keeps 58 messages raw and schedules exactly at 60', async () => {
  const { store, sessionId, append } = await fixture(29);
  const service = new SessionSummaryService(store, { model: 'summary-test', generate: async request => validSummary(request.throughSequence) });
  try {
    assert.equal(service.consider(sessionId), undefined);
    assert.equal(store.latestSummary(sessionId), undefined);
    append(30);
    const job = service.consider(sessionId);
    assert.ok(job); assert.equal(job?.throughSequence, 36, 'default policy keeps the latest 24 of 60 messages raw');
    await service.waitForIdle();
    assert.equal(store.latestSummary(sessionId)?.throughSequence, 36);
  } finally { await service.close(); await store.close(); }
});
