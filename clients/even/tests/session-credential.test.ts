import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCredentialStore, sessionCredentialStorageKeys } from '../src/session-credential.ts';

const clientId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('persists only stable client identity and a scoped short-lived resume credential', () => {
  const local = storage();
  const store = new SessionCredentialStore(local as any, () => 100, () => clientId);
  assert.equal(store.clientId(), clientId);
  store.save({ clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 });
  assert.deepEqual([...local.data.keys()].sort(), [sessionCredentialStorageKeys.client, sessionCredentialStorageKeys.resume].sort());
  const serialized = JSON.stringify([...local.data.entries()]);
  assert.doesNotMatch(serialized, /token|openai|google|soniox/i);
  assert.deepEqual(store.load(), { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 });
});

test('expired, malformed and over-broad credential records fail closed and are removed', () => {
  const cases: unknown[] = [
    { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 100 },
    { clientId: 'bad', sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 },
    { clientId, sessionId, secret: 'short', expiresAt: 1_000 },
    { clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000, token: 'must-not-be-stored' },
  ];
  for (const value of cases) {
    const local = storage();
    local.data.set(sessionCredentialStorageKeys.resume, JSON.stringify(value));
    assert.equal(new SessionCredentialStore(local as any, () => 100, () => clientId).load(), undefined);
    assert.equal(local.data.has(sessionCredentialStorageKeys.resume), false);
  }
});

test('explicit clear removes the session secret but keeps the stable client identity', () => {
  const local = storage();
  const store = new SessionCredentialStore(local as any, () => 100, () => clientId);
  store.clientId();
  store.save({ clientId, sessionId, secret: 'r'.repeat(32), expiresAt: 1_000 });
  store.clearSession();
  assert.equal(local.data.has(sessionCredentialStorageKeys.resume), false);
  assert.equal(local.data.get(sessionCredentialStorageKeys.client), clientId);
});
