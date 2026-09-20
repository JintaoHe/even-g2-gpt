import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ActiveInputLeaseError,
  SessionRegistry,
  SessionUnavailableError,
  type ManagedSessionRuntime,
} from '../src/session-registry.js';

type TestEvent = { text: string };

function runtime(id: string) {
  let sink: ((event: TestEvent) => void) | undefined;
  const calls: string[] = [];
  const value: ManagedSessionRuntime<TestEvent> & { emit(text: string): void; calls: string[] } = {
    id,
    calls,
    replaceEventSink(next) { sink = next; calls.push(next ? 'attach' : 'detach'); },
    async detach(reason) { calls.push(`detach-runtime:${reason}`); },
    async interrupt(reason) { calls.push(`interrupt:${reason}`); },
    async dispose(reason) { calls.push(`dispose:${reason}`); },
    emit(text) { sink?.({ text }); },
  };
  return value;
}

test('detach keeps a logical session resumable and replaces the old event sink', async () => {
  let now = 1_000;
  const sessionId = randomUUID(), first = randomUUID(), second = randomUUID();
  const created = runtime(sessionId), oldEvents: TestEvent[] = [], newEvents: TestEvent[] = [];
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 15 * 60_000,
    now: () => now,
    create: async id => { assert.equal(id, sessionId); return created; },
  });

  const initial = await registry.create(first, event => oldEvents.push(event), sessionId);
  assert.equal(initial.resumed, false);
  created.emit('before');
  await registry.detach(first);
  created.emit('lost');
  now += 14 * 60_000;
  const resumed = await registry.resume(sessionId, second, event => newEvents.push(event));
  assert.equal(resumed.resumed, true);
  created.emit('after');

  assert.deepEqual(oldEvents, [{ text: 'before' }]);
  assert.deepEqual(newEvents, [{ text: 'after' }]);
  assert.deepEqual(created.calls, ['attach', 'detach', 'detach-runtime:connection_detached', 'attach']);
  assert.equal(registry.connectionFor(sessionId), second);
});

test('second live input client is rejected without stealing the active session', async () => {
  const sessionId = randomUUID(), first = randomUUID(), second = randomUUID();
  const created = runtime(sessionId);
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 900_000,
    create: async () => created,
  });
  await registry.create(first, () => {}, sessionId);
  await assert.rejects(() => registry.resume(sessionId, second, () => {}), ActiveInputLeaseError);
  assert.equal(registry.connectionFor(sessionId), first);
  assert.deepEqual(created.calls, ['attach']);
});

test('detached session expires at the injected-clock boundary and cannot resume', async () => {
  let now = 10_000;
  const sessionId = randomUUID(), first = randomUUID(), second = randomUUID();
  const created = runtime(sessionId);
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 900_000,
    now: () => now,
    create: async () => created,
  });
  await registry.create(first, () => {}, sessionId);
  await registry.detach(first);
  now += 900_000;
  assert.deepEqual(await registry.sweepExpired(), [sessionId]);
  await assert.rejects(() => registry.resume(sessionId, second, () => {}), SessionUnavailableError);
  assert.deepEqual(created.calls, [
    'attach', 'detach', 'detach-runtime:connection_detached', 'dispose:expired',
  ]);
});

test('missing in-memory session is hydrated after restart and bound to the new connection', async () => {
  let hydrated = 0;
  const sessionId = randomUUID(), connectionId = randomUUID(), restored = runtime(sessionId);
  const events: TestEvent[] = [];
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 900_000,
    now: () => 50_000,
    create: async id => runtime(id),
    hydrate: async id => {
      hydrated++;
      return id === sessionId ? { runtime: restored, lastDetachedAt: 45_000 } : undefined;
    },
  });

  const result = await registry.resume(sessionId, connectionId, event => events.push(event));
  restored.emit('restored');
  assert.equal(result.resumed, true);
  assert.equal(hydrated, 1);
  assert.deepEqual(events, [{ text: 'restored' }]);
});

test('expired persisted session is disposed but never attached', async () => {
  const sessionId = randomUUID(), connectionId = randomUUID(), restored = runtime(sessionId);
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 900_000,
    now: () => 1_000_000,
    create: async id => runtime(id),
    hydrate: async () => ({ runtime: restored, lastDetachedAt: 100_000 }),
  });
  await assert.rejects(() => registry.resume(sessionId, connectionId, () => {}), SessionUnavailableError);
  assert.deepEqual(restored.calls, ['dispose:expired']);
});

test('development expiry refuses an attached session and expires it immediately after detach', async () => {
  const sessionId = randomUUID(), connectionId = randomUUID(), created = runtime(sessionId);
  const registry = new SessionRegistry<TestEvent>({ resumeWindowMs: 900_000, create: async () => created });
  await registry.create(connectionId, () => {}, sessionId);
  await assert.rejects(() => registry.expireDetached(sessionId), /detach/i);
  await registry.detach(connectionId);
  assert.equal(await registry.expireDetached(sessionId), true);
  assert.equal(registry.has(sessionId), false);
  assert.deepEqual(created.calls, ['attach', 'detach', 'detach-runtime:connection_detached', 'dispose:expired']);
});

test('explicit end disposes immediately while shutdown does not mislabel sessions expired', async () => {
  const firstId = randomUUID(), secondId = randomUUID();
  const runtimes = new Map<string, ReturnType<typeof runtime>>();
  const registry = new SessionRegistry<TestEvent>({
    resumeWindowMs: 900_000,
    create: async id => {
      const value = runtime(id); runtimes.set(id, value); return value;
    },
  });
  const firstConnection = randomUUID();
  await registry.create(firstConnection, () => {}, firstId);
  await registry.end(firstId);
  await registry.create(randomUUID(), () => {}, secondId);
  await registry.shutdown();

  assert.deepEqual(runtimes.get(firstId)?.calls, ['attach', 'detach', 'dispose:ended']);
  assert.deepEqual(runtimes.get(secondId)?.calls, ['attach', 'detach', 'interrupt:service_shutdown', 'dispose:shutdown']);
});

test('50 concurrent reconnect races always grant exactly one active input lease', async () => {
  for (let round = 0; round < 50; round++) {
    const sessionId = randomUUID(), initialConnection = randomUUID(), restored = runtime(sessionId);
    const registry = new SessionRegistry<TestEvent>({
      resumeWindowMs: 900_000,
      create: async () => restored,
    });
    await registry.create(initialConnection, () => {}, sessionId);
    await registry.detach(initialConnection);
    const contenders = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(contenders.map(connectionId =>
      registry.resume(sessionId, connectionId, () => {})));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, `round ${round}`);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ActiveInputLeaseError, `round ${round}`);
    const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
    await registry.detach(winner.value.connectionId);
    await registry.shutdown();
  }
});
