import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeMetrics } from '../src/runtime-metrics.js';

test('runtime metrics retain metadata-only turn and provider distributions', async () => {
  let now = 1_000;
  const metrics = new RuntimeMetrics(() => now);
  metrics.beginTurn('session-a');
  now += 25; metrics.observeConversationEvent('session-a', { type: 'answer.delta', text: 'private answer' });
  now += 75; metrics.observeConversationEvent('session-a', { type: 'answer.done' });
  metrics.beginTurn('session-b');
  now += 10; metrics.observeConversationEvent('session-b', { type: 'error', code: 'MODEL_FAILED', detail: 'private provider prose' });
  metrics.observeProvider('openai', 'success', 40);
  metrics.observeProvider('openai', 'failure', 60);
  metrics.observeProvider('soniox', 'cancelled', 5);
  metrics.observeDocument('success', 120);
  metrics.observeDocument('failure', 180, true);

  const snapshot = await metrics.snapshot({
    connections: { authenticated: 1, unauthenticated: 2, total: 3 },
    costs: async () => ({ period: '2026-09', providerUsd: { openai: 1, soniox: 2, google: 3 }, totalUsd: 6,
      limitsUsd: { openai: 50, soniox: 20, google: 10, total: 80 }, googleUnits: {} }),
  });
  assert.deepEqual(snapshot.turns.first_visible, { count: 1, p50_ms: 25, p95_ms: 25, max_ms: 25 });
  assert.deepEqual(snapshot.turns.complete, { count: 1, p50_ms: 100, p95_ms: 100, max_ms: 100 });
  assert.equal(snapshot.turns.failed, 1);
  assert.equal(snapshot.providers.openai.error_rate, 0.5);
  assert.deepEqual(snapshot.documents, { attempts: 2, completed: 1, failed: 1, retry_failed: 1,
    latency: { count: 2, p50_ms: 120, p95_ms: 180, max_ms: 180 } });
  assert.deepEqual(snapshot.connections, { authenticated: 1, unauthenticated: 2, total: 3 });
  assert.equal(snapshot.costs?.totalUsd, 6);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private answer|private provider prose|session-a|session-b/);
});

test('duplicate turn starts and irrelevant errors do not corrupt counters', async () => {
  let now = 5_000;
  const metrics = new RuntimeMetrics(() => now);
  metrics.beginTurn('same'); metrics.beginTurn('same');
  metrics.observeConversationEvent('same', { type: 'error', code: 'TRANSCRIPTION_FAILED' });
  now += 30; metrics.observeConversationEvent('same', { type: 'answer.citations', text: 'hidden', citations: [] });
  now += 20; metrics.observeConversationEvent('same', { type: 'answer.cancelled' });
  const snapshot = await metrics.snapshot({ connections: { authenticated: 0, unauthenticated: 0, total: 0 } });
  assert.equal(snapshot.turns.started, 1);
  assert.equal(snapshot.turns.cancelled, 1);
  assert.equal(snapshot.turns.first_visible.p50_ms, 30);
  assert.equal(snapshot.turns.complete.count, 0);
});
