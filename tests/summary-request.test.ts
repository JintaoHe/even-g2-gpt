import assert from 'node:assert/strict';
import test from 'node:test';
import { summaryBody, selectSummaryBatch, MAX_SUMMARY_REQUEST_BYTES, SUMMARY_PLANNED_BYTES } from '../src/summary-request.js';
import { OpenAISessionSummaryGenerator } from '../src/session-summary.js';
const summary = { version: 1 as const, throughSequence: 1, overview: '未确认', topics: [], confirmedDecisions: [], unresolvedItems: [] };
const message = (content: string, sequence = 2) => ({ sequence, role: 'assistant', status: 'committed', topicId: 'synthetic-topic', content });

test('seeded mixed Unicode and JSON escaping uses identical estimated and transmitted bodies', async () => {
  let seed = 98231;
  const chars = ['中', 'a', '😀', '\n', '"', '\\', '\u0000', '\t', '𠮷'];
  for (let round = 0; round < 40; round++) {
    let text = '';
    for (let i = 0; i < 300; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; text += chars[seed % chars.length]; }
    const request = { jobId: 'synthetic-job', sessionId: 'synthetic-session', fromSequence: 2,
      throughSequence: 2, messages: [message(text)], previousSummary: summary,
      attempt: round % 2 ? 'repair' as const : 'summarize' as const, invalidOutput: text.repeat(50) };
    const expected = summaryBody('test-model', request);
    const generator = new OpenAISessionSummaryGenerator('synthetic-key', 'test-model', undefined, async (_url, init) => {
      assert.equal(init?.body, expected.body);
      assert.equal(Buffer.byteLength(String(init?.body)), expected.bytes);
      return new Response(JSON.stringify({ output_text: JSON.stringify(summary) }));
    });
    await generator.generate(request, new AbortController().signal);
  }
});

test('emoji cut points remain well formed and excerpts are deterministic, structured and isolated', () => {
  const raw = message('😀中"\n\u0000'.repeat(24_000));
  const first = selectSummaryBatch('test-model', [raw, message('next', 3)], summary);
  const again = selectSummaryBatch('test-model', [raw, message('next', 3)], summary);
  assert.equal(first.body, again.body);
  assert.equal(first.messages.length, 1);
  assert.doesNotMatch(first.messages[0].content, /[\uD800-\uDFFF]/u);
  assert.ok(first.messages[0].excerpt!.omittedBytes > 0);
  const points = Array.from(first.messages[0].content);
  const head = first.messages[0].excerpt!.headChars;
  assert.equal(head, Math.ceil(points.length / 2));
  assert.equal(points.slice(0, head).join(''), Array.from(raw.content).slice(0, head).join(''));
  assert.equal(points.slice(head).join(''), Array.from(raw.content).slice(-(points.length - head)).join(''));
  assert.equal(first.messages[0].excerpt!.omittedBytes, Buffer.byteLength(raw.content) - Buffer.byteLength(first.messages[0].content));
  assert.ok(first.bytes <= SUMMARY_PLANNED_BYTES);
  const repair = summaryBody('test-model', { messages: first.messages, throughSequence: 2,
    previousSummary: summary, attempt: 'repair', invalidOutput: '中😀\u0000"'.repeat(30_000) });
  assert.ok(repair.bytes <= MAX_SUMMARY_REQUEST_BYTES);
});

test('linear byte accounting handles sequence digit transitions and 200 one-KB messages', t => {
  const source = Array.from({ length: 200 }, (_, i) => message('x'.repeat(1024), i + 90));
  const durations: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const batch = selectSummaryBatch('test-model', source);
    durations.push(performance.now() - start);
    assert.ok(batch.messages.length > 100);
    assert.equal(batch.bytes, Buffer.byteLength(batch.body));
    assert.equal(batch.body, summaryBody('test-model', { messages: batch.messages,
      throughSequence: batch.messages.at(-1)!.sequence, attempt: 'summarize', previousLosses: [] }).body);
  }
  durations.sort((a, b) => a - b);
  t.diagnostic(`200-message byte selection median=${durations[10].toFixed(2)}ms; max=${durations.at(-1)!.toFixed(2)}ms (informational, no flaky timing gate)`);
});

test('near-limit previous summary plus a full stream stays bounded and stops reading at the byte boundary', () => {
  const large = { ...summary, overview: '中'.repeat(8000),
    topics: Array.from({ length: 24 }, (_, i) => ({ id: String(i), label: '主题', summary: '中'.repeat(3000) })) };
  let read = 0;
  function* stream() { for (let i = 2; i < 202; i++) { read++; yield message('中文'.repeat(2000), i); } }
  const batch = selectSummaryBatch('test-model', stream(), large);
  assert.ok(read < 200);
  assert.equal(read, batch.messages.length + 1);
  assert.ok(batch.losses.some(x => x.kind === 'prior_summary'));
  const repair = summaryBody('test-model', { throughSequence: batch.messages.at(-1)!.sequence,
    messages: batch.messages, previousSummary: large, attempt: 'repair', invalidOutput: '\u0000中😀'.repeat(30_000) });
  assert.ok(repair.bytes <= MAX_SUMMARY_REQUEST_BYTES);
});
