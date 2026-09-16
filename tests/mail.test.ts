import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailConfig } from '../src/mail.js';
import { JobStore } from '../src/job-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { once } from 'node:events';
import WebSocket from 'ws';

const env = { EVEN_EMAIL_ENABLED: 'true', SMTP_USER: 'sender@example.com', SMTP_PASS: 'abcd efgh ijkl mnop', EMAIL_TO: 'recipient@example.com' };
test('mail is opt-in; Gmail TLS and one fixed address are required; errors are redacted', () => {
  assert.equal(mailConfig({}), undefined);
  assert.equal(mailConfig({ ...env, EVEN_EMAIL_ENABLED: 'false' }), undefined);
  assert.equal(mailConfig(env)?.password, 'abcdefghijklmnop');
  assert.equal(mailConfig({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'false' })?.port, 587);
  for (const overrides of [{ EMAIL_TO: 'one@example.com,two@example.com' }, { EMAIL_TO: 'one@example.com\r\nBcc: two@example.com' },
    { SMTP_HOST: 'other.example.com' }, { SMTP_SECURE: 'false' }, { SMTP_PORT: '25' }, { EMAIL_FROM: 'other@example.com' }, { SMTP_PASS: 'secret' }]) {
    assert.throws(() => mailConfig({ ...env, ...overrides }), { message: 'MAIL_CONFIG_INVALID' });
  }
});
async function completed(store: JobStore) {
  const job = store.enqueue([{ role: 'user', content: 'Synthetic test' }]);
  for (let i = 0; i < 200 && store.get(job.id)?.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(store.get(job.id)?.state, 'completed'); return job.id;
}
test('one send per artifact persists across restart; concurrent clicks cannot duplicate; failures retain MD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-test-'));
  let store = await JobStore.create(root);
  try {
    const id = await completed(store); let sends = 0;
    const sender = async (_id: string, bytes: Buffer) => { sends++; assert.match(bytes.toString(), /Synthetic test/); return 'accepted' as const; };
    await Promise.allSettled([store.email(id, sender), store.email(id, sender)]);
    assert.equal(sends, 1); assert.equal(store.mailState(id), 'accepted');
    await store.close(); store = await JobStore.create(root);
    assert.equal(await store.email(id, sender), 'accepted'); assert.equal(sends, 1);
    const second = await completed(store);
    assert.equal(await store.email(second, async () => { throw Error('private SMTP response'); }), 'unknown');
    assert.equal(await store.email(second, sender), 'unknown'); assert.equal(sends, 1);
    assert.ok((await store.download(second)).length);
    assert.equal(store.list().find(job => job.id === second)?.mail_state, 'unknown');
    await assert.rejects(store.email('../../private', sender));
    assert.equal(sends, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
test('crash recovery never replays uncertain delivery; persistent UTC quota counts attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-quota-'));
  let store = await JobStore.create(root);
  try {
    const id = await completed(store); await store.close();
    const db = new DatabaseSync(join(root, 'jobs.sqlite'));
    db.prepare('INSERT INTO mail_deliveries VALUES (?,?,?)').run(id, 'sending', new Date().toISOString());
    for (let i = 0; i < 19; i++) db.prepare('INSERT INTO mail_deliveries VALUES (?,?,?)').run(`test-${i}`, 'failed', new Date().toISOString());
    db.close(); store = await JobStore.create(root);
    assert.equal(store.mailState(id), 'unknown');
    const second = await completed(store);
    await assert.rejects(store.email(second, async () => { assert.fail('must not send'); }), { message: 'MAIL_DAILY_LIMIT' });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('mail endpoint requires authentication, rejects recipient overrides and sends a saved artifact', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-ws-')), store = await JobStore.create(root);
  const id = await completed(store); let sends = 0;
  const token = 'test-token-'.repeat(5);
  const app = createConversationServer({ token, jobs: store, mail: async () => { sends++; return 'accepted'; },
    model: { decide: async () => 'respond', reply: async () => {} }, transcriber: () => { throw Error('Unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as { port: number }).port}/ws/conversation`;
  const waitFor = (client: WebSocket, type: string) => new Promise<any>(resolve => {
    const listener = (data: WebSocket.RawData) => { const event = JSON.parse(data.toString()); if (event.type === type) { client.off('message', listener); resolve(event); } };
    client.on('message', listener);
  });
  try {
    for (const authenticated of [false, true]) {
      const client = new WebSocket(url); await once(client, 'open');
      if (authenticated) { const ready = waitFor(client, 'ready'); client.send(JSON.stringify({ type: 'hello', token })); assert.equal((await ready).capabilities.email, true); }
      const closed = once(client, 'close');
      client.send(JSON.stringify({ type: 'jobs.email', id, to: 'override@example.com' }));
      await closed; assert.equal(sends, 0);
    }
    const client = new WebSocket(url); await once(client, 'open');
    const ready = waitFor(client, 'ready'); client.send(JSON.stringify({ type: 'hello', token })); await ready;
    const result = waitFor(client, 'jobs.list'); client.send(JSON.stringify({ type: 'jobs.email', id }));
    const jobs = (await result).jobs;
    assert.equal(jobs[0].mail_state, 'accepted'); assert.equal(sends, 1);
    const closed = once(client, 'close'); client.close(); await closed;
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
