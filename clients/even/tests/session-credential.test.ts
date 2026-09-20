import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCredentialStore, sessionCredentialStorageKeys } from '../src/session-credential.ts';

const clientId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const credential = { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 };

function hostStorage(initial: Record<string, string> = {}, acceptWrites = true) {
  const data = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  return {
    data, writes,
    getLocalStorage: async (key: string) => data.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => {
      writes.push([key, value]);
      if (acceptWrites) data.set(key, value);
      return acceptWrites;
    },
  };
}

function browserStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('persists only stable identity and scoped credential in native host storage', async () => {
  const host = hostStorage();
  const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  assert.equal(store.clientId(), clientId);
  assert.equal(await store.save(credential), true);
  assert.deepEqual([...host.data.keys()].sort(), [sessionCredentialStorageKeys.client, sessionCredentialStorageKeys.resume].sort());
  const serialized = JSON.stringify([...host.data.entries()]);
  assert.doesNotMatch(serialized, /access.?token|openai|google|soniox/i);
  assert.deepEqual(store.load(), credential);
});

test('migrates a valid legacy browser credential only after native writes succeed', async () => {
  const host = hostStorage();
  const legacy = browserStorage({
    [sessionCredentialStorageKeys.legacyClient]: clientId,
    [sessionCredentialStorageKeys.legacyResume]: JSON.stringify(credential),
  });
  const store = await SessionCredentialStore.open(host, legacy as any, () => 100, () => clientId);
  assert.deepEqual(store.load(), credential);
  assert.equal(host.data.get(sessionCredentialStorageKeys.client), clientId);
  assert.equal(host.data.get(sessionCredentialStorageKeys.resume), JSON.stringify(credential));
  assert.equal(legacy.data.size, 0);
});

test('failed native migration retains legacy values and continuity for this process', async () => {
  const host = hostStorage({}, false);
  const legacy = browserStorage({
    [sessionCredentialStorageKeys.legacyClient]: clientId,
    [sessionCredentialStorageKeys.legacyResume]: JSON.stringify(credential),
  });
  const store = await SessionCredentialStore.open(host, legacy as any, () => 100, () => clientId);
  assert.deepEqual(store.load(), credential);
  assert.equal(store.persistenceHealthy, false);
  assert.equal(legacy.data.get(sessionCredentialStorageKeys.legacyClient), clientId);
  assert.equal(legacy.data.get(sessionCredentialStorageKeys.legacyResume), JSON.stringify(credential));
});

test('valid native state wins and removes obsolete browser copies', async () => {
  const nativeCredential = { ...credential, secret: 'n'.repeat(32) };
  const host = hostStorage({
    [sessionCredentialStorageKeys.client]: clientId,
    [sessionCredentialStorageKeys.resume]: JSON.stringify(nativeCredential),
  });
  const legacy = browserStorage({
    [sessionCredentialStorageKeys.legacyClient]: clientId,
    [sessionCredentialStorageKeys.legacyResume]: JSON.stringify(credential),
  });
  const store = await SessionCredentialStore.open(host, legacy as any, () => 100, () => clientId);
  assert.deepEqual(store.load(), nativeCredential);
  assert.equal(legacy.data.size, 0);
});

test('expired, malformed and over-broad native credentials fail closed', async () => {
  const cases: unknown[] = [
    { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 100 },
    { clientId: 'bad', sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 },
    { clientId, sessionId, secret: 'short', expiresAt: 1_000 },
    { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000, token: 'must-not-be-stored' },
  ];
  for (const value of cases) {
    const host = hostStorage({
      [sessionCredentialStorageKeys.client]: clientId,
      [sessionCredentialStorageKeys.resume]: JSON.stringify(value),
    });
    const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
    assert.equal(store.load(), undefined);
    assert.equal(host.data.get(sessionCredentialStorageKeys.resume), '');
  }
});

test('explicit clear writes an empty native value and keeps stable identity', async () => {
  const host = hostStorage();
  const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  await store.save(credential);
  assert.equal(await store.clearSession(), true);
  assert.equal(store.load(), undefined);
  assert.equal(host.data.get(sessionCredentialStorageKeys.resume), '');
  assert.equal(host.data.get(sessionCredentialStorageKeys.client), clientId);
});

test('a false setLocalStorage result is treated as failure rather than success', async () => {
  const host = hostStorage({}, false);
  const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  assert.equal(await store.save(credential), false);
  assert.equal(store.persistenceHealthy, false);
  assert.equal(host.data.has(sessionCredentialStorageKeys.resume), false);
});

test('a later save persists identity first when native reads failed during startup', async () => {
  const data = new Map<string, string>();
  let readsFail = true;
  const host = {
    getLocalStorage: async (key: string) => {
      if (readsFail) throw new Error('host starting');
      return data.get(key) ?? '';
    },
    setLocalStorage: async (key: string, value: string) => { data.set(key, value); return true; },
  };
  const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  readsFail = false;
  assert.equal(await store.save(credential), true);
  assert.equal(data.get(sessionCredentialStorageKeys.client), clientId);
  assert.equal(data.get(sessionCredentialStorageKeys.resume), JSON.stringify(credential));
});

test('overlapping credential rotations are serialized so the newest value wins', async () => {
  const host = hostStorage();
  const store = await SessionCredentialStore.open(host, undefined, () => 100, () => clientId);
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  let resumeWrites = 0;
  host.setLocalStorage = async (key: string, value: string) => {
    if (key === sessionCredentialStorageKeys.resume && ++resumeWrites === 1) await firstBlocked;
    host.data.set(key, value);
    return true;
  };
  const oldCredential = { ...credential, secret: 'o'.repeat(32) };
  const newCredential = { ...credential, secret: 'n'.repeat(32) };
  const oldWrite = store.save(oldCredential);
  const newWrite = store.save(newCredential);
  await new Promise<void>(resolve => setImmediate(resolve));
  releaseFirst();
  assert.deepEqual(await Promise.all([oldWrite, newWrite]), [true, true]);
  assert.equal(host.data.get(sessionCredentialStorageKeys.resume), JSON.stringify(newCredential));
  assert.deepEqual(store.load(), newCredential);
});
