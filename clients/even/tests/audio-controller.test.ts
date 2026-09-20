import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioController } from '../src/audio-controller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('opens only when desired, backend, device and visibility are all available', async () => {
  const calls: boolean[] = [];
  const audio = new AudioController({ bridge: { audioControl: async value => { calls.push(value); return true; } }, retryDelay: async () => {} });
  await audio.setDesired(true); assert.equal(audio.state, 'off');
  await audio.setBackendAvailable(true); assert.equal(audio.state, 'streaming');
  await audio.setVisible(false); assert.equal(audio.state, 'off'); assert.equal(audio.desired, true);
  await audio.setVisible(true); assert.equal(audio.state, 'streaming');
  await audio.setDeviceAvailable(false); assert.equal(audio.state, 'off'); assert.equal(audio.desired, true);
  await audio.setDeviceAvailable(true); assert.equal(audio.state, 'streaming');
  assert.deepEqual(calls, [true, false, true, false, true]);
});

test('a native false is terminal for this plugin process and requires reopen without retry', async () => {
  let attempts = 0, reopen = 0;
  const audio = new AudioController({ bridge: { audioControl: async value => value ? (++attempts, false) : true },
    retryDelay: async () => {}, onRequiresReopen: () => { reopen++; } });
  await audio.setBackendAvailable(true); await audio.setDesired(true);
  assert.equal(attempts, 1); assert.equal(reopen, 1); assert.equal(audio.state, 'requires_reopen');
  assert.equal(audio.desired, false);
  await audio.setVisible(false); await audio.setDeviceAvailable(false); await audio.setBackendAvailable(false);
  assert.equal(audio.state, 'requires_reopen', 'lifecycle changes must not hide the terminal state');
  await audio.setDesired(true);
  assert.equal(attempts, 1); assert.equal(audio.state, 'requires_reopen'); assert.equal(audio.desired, false);
});

test('thrown transient failures still use the bounded retry path', async () => {
  let attempts = 0, unavailable = 0;
  const audio = new AudioController({ bridge: { audioControl: async value => {
    if (!value) return true; attempts++; throw new Error('temporary bridge error');
  } }, retryDelay: async () => {}, onUnavailable: () => { unavailable++; } });
  await audio.setBackendAvailable(true); await audio.setDesired(true);
  assert.equal(attempts, 3); assert.equal(unavailable, 1); assert.equal(audio.state, 'unavailable');
});

test('user cancellation invalidates a late successful open and closes it', async () => {
  const first = deferred<boolean>(), calls: boolean[] = [];
  const audio = new AudioController({ bridge: { audioControl: async value => { calls.push(value); return value ? first.promise : true; } }, retryDelay: async () => {} });
  await audio.setBackendAvailable(true); const opening = audio.setDesired(true);
  await Promise.resolve();
  const closing = audio.setDesired(false); first.resolve(true); await Promise.all([opening, closing]);
  assert.equal(audio.state, 'off'); assert.equal(audio.desired, false);
  assert.deepEqual(calls, [true, false]);
});

test('backend and device disconnect stop actual audio but preserve desired intent for recovery', async () => {
  const calls: boolean[] = [];
  const audio = new AudioController({ bridge: { audioControl: async value => { calls.push(value); return true; } }, retryDelay: async () => {} });
  await audio.setBackendAvailable(true); await audio.setDesired(true);
  await audio.setBackendAvailable(false); assert.equal(audio.desired, true); assert.equal(audio.state, 'off');
  await audio.setBackendAvailable(true); assert.equal(audio.state, 'streaming');
  await audio.setDeviceAvailable(false); await audio.setDeviceAvailable(true);
  assert.equal(audio.state, 'streaming'); assert.equal(audio.desired, true);
  assert.deepEqual(calls, [true, false, true, false, true]);
});

test('100 toggle/disconnect cycles serialize without leaving audio enabled after dispose', async () => {
  let actual = false, inFlight = 0, maxInFlight = 0;
  const audio = new AudioController({ bridge: { audioControl: async value => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); actual = value; inFlight--; return true;
  } }, retryDelay: async () => {} });
  await audio.setBackendAvailable(true);
  for (let i = 0; i < 100; i++) {
    await audio.setDesired(true); await audio.setBackendAvailable(false); await audio.setBackendAvailable(true); await audio.setDesired(false);
  }
  await audio.dispose();
  assert.equal(actual, false); assert.equal(audio.state, 'off'); assert.equal(maxInFlight, 1);
});
