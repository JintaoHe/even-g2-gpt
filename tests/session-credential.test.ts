import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore, DeviceCredentialError, ResumeCredentialError } from '../src/conversation-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-session-credential-'));
  const store = await ConversationStore.create(root);
  const sessionId = randomUUID(), clientId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
    initialTopic: { id: topicId, label: 'General' } });
  store.registerClient({ id: clientId, at: 100, label: 'Even Hub' });
  return { root, store, sessionId, clientId };
}

test('resume credential is opaque, scoped and stored only as a SHA-256 hash', async () => {
  const { root, store, sessionId, clientId } = await fixture();
  try {
    const issued = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 910_000 });
    assert.match(issued.secret, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.clientId, clientId);
    assert.equal(issued.sessionId, sessionId);

    const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
    try {
      const row = db.prepare('SELECT id,secret_hash FROM resume_credentials WHERE id=?').get(issued.id) as any;
      assert.equal(row.id, issued.id);
      assert.notEqual(row.secret_hash, issued.secret);
      assert.equal(row.secret_hash, createHash('sha256').update(issued.secret).digest('hex'));
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM resume_credentials').all()).includes(issued.secret), false);
    } finally { db.close(); }
  } finally { await store.close(); }
});

test('successful resume rotates the credential and rejects replay of the previous secret', async () => {
  const { store, sessionId, clientId } = await fixture();
  try {
    const issued = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    const rotated = store.rotateResumeCredential({
      secret: issued.secret, clientId, sessionId, at: 200, expiresAt: 1_100,
    });
    assert.notEqual(rotated.secret, issued.secret);
    assert.equal(rotated.expiresAt, 1_100);
    assert.throws(() => store.rotateResumeCredential({
      secret: issued.secret, clientId, sessionId, at: 201, expiresAt: 1_101,
    }), ResumeCredentialError);
    const next = store.rotateResumeCredential({
      secret: rotated.secret, clientId, sessionId, at: 202, expiresAt: 1_102,
    });
    assert.notEqual(next.secret, rotated.secret);
  } finally { await store.close(); }
});

test('one successful resume revokes all refreshed sibling credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-session-credential-siblings-'));
  const store = await ConversationStore.create(root);
  const clientId = randomUUID(), sessionId = randomUUID(), topicId = randomUUID();
  try {
    store.registerClient({ id: clientId, at: 100 });
    store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100,
      initialTopic: { id: topicId, label: 'General' } });
    const first = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    const refreshed = store.issueResumeCredential({ clientId, sessionId, createdAt: 120, expiresAt: 1_010 });
    store.rotateResumeCredential({ secret: refreshed.secret, clientId, sessionId, at: 130, expiresAt: 1_020 });
    assert.throws(() => store.rotateResumeCredential({
      secret: first.secret, clientId, sessionId, at: 140, expiresAt: 1_030,
    }), ResumeCredentialError);
  } finally { await store.close(); }
});

test('wrong client, wrong session, expiry and explicit revocation all fail closed', async () => {
  const { store, sessionId, clientId } = await fixture();
  try {
    const otherClient = randomUUID(), otherSession = randomUUID(), otherTopic = randomUUID();
    store.registerClient({ id: otherClient, at: 100 });
    store.createSession({ id: otherSession, ownerScope: 'single-user', createdAt: 100,
      initialTopic: { id: otherTopic, label: 'Other' } });

    const wrongClient = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    assert.throws(() => store.rotateResumeCredential({
      secret: wrongClient.secret, clientId: otherClient, sessionId, at: 200, expiresAt: 1_100,
    }), ResumeCredentialError);

    const wrongSession = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    assert.throws(() => store.rotateResumeCredential({
      secret: wrongSession.secret, clientId, sessionId: otherSession, at: 200, expiresAt: 1_100,
    }), ResumeCredentialError);

    const expired = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 150 });
    assert.throws(() => store.rotateResumeCredential({
      secret: expired.secret, clientId, sessionId, at: 150, expiresAt: 1_100,
    }), ResumeCredentialError);

    const revoked = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    assert.equal(store.revokeSessionCredentials(sessionId, 120), 4);
    assert.throws(() => store.rotateResumeCredential({
      secret: revoked.secret, clientId, sessionId, at: 121, expiresAt: 1_100,
    }), ResumeCredentialError);
  } finally { await store.close(); }
});

test('terminal sessions cannot issue or rotate resume credentials', async () => {
  const { store, sessionId, clientId } = await fixture();
  try {
    const issued = store.issueResumeCredential({ clientId, sessionId, createdAt: 110, expiresAt: 1_000 });
    store.endSession(sessionId, 120, 'user_exit');
    assert.throws(() => store.issueResumeCredential({ clientId, sessionId, createdAt: 121, expiresAt: 1_001 }), ResumeCredentialError);
    assert.throws(() => store.rotateResumeCredential({
      secret: issued.secret, clientId, sessionId, at: 121, expiresAt: 1_001,
    }), ResumeCredentialError);
  } finally { await store.close(); }
});

test('device credential is client-scoped, opaque and stored only as a hash', async () => {
  const { root, store, clientId } = await fixture();
  try {
    const issued = store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 20_000, persistDeadlineAt: 500,
    });
    assert.match(issued.secret, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.clientId, clientId);
    assert.equal(issued.persistDeadlineAt, 500);

    const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
    try {
      const row = db.prepare('SELECT secret_hash,state,predecessor_id FROM device_credentials WHERE id=?')
        .get(issued.id) as any;
      assert.equal(row.state, 'pending');
      assert.equal(row.predecessor_id, null);
      assert.equal(row.secret_hash, createHash('sha256').update(issued.secret).digest('hex'));
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM device_credentials').all()).includes(issued.secret), false);
    } finally { db.close(); }
  } finally { await store.close(); }
});

test('persisted ACK makes the new device generation authoritative and revokes the predecessor', async () => {
  const { store, clientId } = await fixture();
  try {
    const first = store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 20_000, persistDeadlineAt: 500,
    });
    assert.equal(store.acknowledgeDeviceCredential({ id: first.id, clientId, at: 220 }), true);
    const second = store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 300, expiresAt: 30_000, persistDeadlineAt: 600,
    });
    assert.equal(store.acknowledgeDeviceCredential({ id: second.id, clientId, at: 320 }), true);
    assert.throws(() => store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 321, expiresAt: 30_001, persistDeadlineAt: 601,
    }), DeviceCredentialError);
    const third = store.rotateDeviceCredential({
      secret: second.secret, clientId, at: 330, expiresAt: 30_010, persistDeadlineAt: 630,
    });
    assert.notEqual(third.secret, second.secret);
  } finally { await store.close(); }
});

test('presenting a pending device generation proves persistence when its ACK was lost', async () => {
  const { store, clientId } = await fixture();
  try {
    const first = store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 20_000, persistDeadlineAt: 500,
    });
    const second = store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 250, expiresAt: 20_050, persistDeadlineAt: 500,
    });
    const third = store.rotateDeviceCredential({
      secret: second.secret, clientId, at: 300, expiresAt: 20_100, persistDeadlineAt: 600,
    });
    assert.notEqual(third.secret, second.secret);
    assert.throws(() => store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 301, expiresAt: 20_101, persistDeadlineAt: 601,
    }), DeviceCredentialError);
  } finally { await store.close(); }
});

test('unacknowledged overlap cannot be extended and the newest generation wins at the hard deadline', async () => {
  const { store, clientId } = await fixture();
  try {
    const first = store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 20_000, persistDeadlineAt: 500,
    });
    assert.equal(store.acknowledgeDeviceCredential({ id: first.id, clientId, at: 210 }), true);
    const second = store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 250, expiresAt: 20_050, persistDeadlineAt: 500,
    });
    const replacement = store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 300, expiresAt: 20_100, persistDeadlineAt: 700,
    });
    assert.equal(replacement.persistDeadlineAt, 500);
    assert.throws(() => store.rotateDeviceCredential({
      secret: second.secret, clientId, at: 400, expiresAt: 20_200, persistDeadlineAt: 700,
    }), DeviceCredentialError);
    assert.throws(() => store.rotateDeviceCredential({
      secret: first.secret, clientId, at: 500, expiresAt: 20_300, persistDeadlineAt: 800,
    }), DeviceCredentialError);
    const next = store.rotateDeviceCredential({
      secret: replacement.secret, clientId, at: 500, expiresAt: 20_300, persistDeadlineAt: 800,
    });
    assert.notEqual(next.secret, replacement.secret);
  } finally { await store.close(); }
});

test('device credentials reject wrong clients, excessive lifetimes and explicit revocation', async () => {
  const { store, clientId } = await fixture();
  try {
    const issued = store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 20_000, persistDeadlineAt: 500,
    });
    assert.throws(() => store.rotateDeviceCredential({
      secret: issued.secret, clientId: randomUUID(), at: 250, expiresAt: 20_050, persistDeadlineAt: 550,
    }), DeviceCredentialError);
    assert.throws(() => store.issueDeviceCredential({
      clientId, createdAt: 200, expiresAt: 400 * 24 * 60 * 60_000, persistDeadlineAt: 500,
    }), DeviceCredentialError);
    assert.equal(store.revokeDeviceCredentials(clientId, 260), 1);
    assert.throws(() => store.rotateDeviceCredential({
      secret: issued.secret, clientId, at: 270, expiresAt: 20_070, persistDeadlineAt: 570,
    }), DeviceCredentialError);
  } finally { await store.close(); }
});
