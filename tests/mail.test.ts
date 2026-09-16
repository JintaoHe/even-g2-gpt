import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailConfig, mailPayload, type MailSender } from '../src/mail.js';
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
async function completed(store: JobStore, calendar?: unknown) {
  const job = store.enqueue([{ role: 'user', content: 'Synthetic test' }], calendar);
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

test('one explicit retry persists, retains original calendar bytes, gets a new delivery id and rejects replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-retry-')); let store = await JobStore.create(root);
  const deliveries: { id: string | undefined; bytes: string[] }[] = [];
  const sender: MailSender = async (id, md, metadata, calendar, created, deliveryId) => {
    deliveries.push({ id: deliveryId, bytes: mailPayload(id, md, metadata, calendar, created).attachments.map(a => a.content.toString()) });
    return deliveries.length === 1 ? 'unknown' : 'accepted';
  };
  try {
    const calendar = { title: 'Synthetic meeting', start: '2026-10-01', end: '2026-10-02', timezone: '', allDay: true, location: '', notes: '' };
    const job = store.enqueue([{ role: 'user', content: 'Synthetic event' }], calendar);
    for (let n = 0; n < 200 && store.get(job.id)?.state !== 'completed'; n++) await new Promise(r => setTimeout(r, 5));
    await store.email(job.id, sender); assert.equal(store.mailAttempts(job.id), 1);
    await store.close(); store = await JobStore.create(root);
    await store.email(job.id, sender); assert.equal(deliveries.length, 1); // Restart never retries automatically.
    await Promise.allSettled([store.retryEmail(job.id, sender, 1), store.retryEmail(job.id, sender, 1)]);
    assert.equal(deliveries.length, 2); assert.notEqual(deliveries[0].id, deliveries[1].id); assert.deepEqual(deliveries[0].bytes, deliveries[1].bytes);
    await store.close(); store = await JobStore.create(root);
    assert.equal(store.mailAttempts(job.id), 2); await assert.rejects(store.retryEmail(job.id, sender, 1));
    store.acknowledgeReceipt(job.id); await store.close(); store = await JobStore.create(root);
    assert.equal(store.mailReceived(job.id), true); assert.equal(store.canRetryEmail(job.id), false);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed retries consume daily quota and receipt suppresses a first retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-retry-quota-')); let store = await JobStore.create(root);
  try {
    const id = await completed(store); await store.email(id, async () => 'accepted');
    store.acknowledgeReceipt(id); await assert.rejects(store.retryEmail(id, async () => { assert.fail('already received'); }, 1));
    const second = await completed(store); await store.email(second, async () => 'failed'); await store.close();
    const db = new DatabaseSync(join(root, 'jobs.sqlite'));
    for (let i = 0; i < 17; i++) db.prepare('INSERT INTO mail_deliveries VALUES (?,?,?)').run(`quota-${i}`, 'accepted', new Date().toISOString());
    db.close(); store = await JobStore.create(root);
    assert.equal(await store.retryEmail(second, async () => 'accepted', 1), 'accepted'); // Twentieth attempt.
    const third = await completed(store);
    await assert.rejects(store.email(third, async () => { assert.fail('over quota'); }), /MAIL_DAILY_LIMIT/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('mail endpoint requires authentication, rejects recipient overrides and sends a saved artifact', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-mail-ws-')), store = await JobStore.create(root);
  const id = await completed(store, { title: 'Synthetic meeting', start: '2026-09-20T14:00-05:00', end: '2026-09-20T15:00-05:00', timezone: 'America/Chicago', allDay: false, location: '', notes: '' }); let sends = 0;
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
    const denied = waitFor(client, 'notice'); client.send(JSON.stringify({ type: 'jobs.email', id }));
    assert.match((await denied).text, /确认已失效/); assert.equal(sends, 0);
    const preview = waitFor(client, 'mail.confirmation_required'); client.send(JSON.stringify({ type: 'jobs.email.prepare', id }));
    let approval = await preview; assert.equal(sends, 0); assert.match(approval.preview, /Synthetic test/);
    assert.match(approval.preview, /美国芝加哥/); assert.match(approval.preview, /美国洛杉矶/); assert.match(approval.preview, /美国纽约/);
    const noZone = waitFor(client, 'notice'); client.send(JSON.stringify({ type: 'jobs.email', id, confirmation: approval.confirmation }));
    assert.match((await noZone).text, /主时区未明确确认/); assert.equal(sends, 0);
    const previewAgain = waitFor(client, 'mail.confirmation_required'); client.send(JSON.stringify({ type: 'jobs.email.prepare', id })); approval = await previewAgain;
    const result = waitFor(client, 'jobs.list'); client.send(JSON.stringify({ type: 'jobs.email', id, confirmation: approval.confirmation, calendar_confirmation: '确认按芝加哥时间发送' }));
    const jobs = (await result).jobs;
    assert.equal(jobs[0].mail_state, 'accepted'); assert.equal(sends, 1);
    const replay = waitFor(client, 'notice'); client.send(JSON.stringify({ type: 'jobs.email', id, confirmation: approval.confirmation }));
    assert.match((await replay).text, /确认已失效/); assert.equal(sends, 1);
    const retryPreview = waitFor(client, 'mail.confirmation_required'); client.send(JSON.stringify({ type: 'jobs.email.prepare', id, retry: true }));
    const retryApproval = await retryPreview; assert.match(retryApproval.preview, /重发同一份/); assert.equal(sends, 1);
    const retried = waitFor(client, 'jobs.list'); client.send(JSON.stringify({ type: 'jobs.email', id, confirmation: retryApproval.confirmation, calendar_confirmation: '确认按芝加哥时间重发' }));
    assert.equal((await retried).jobs[0].mail_attempts, 2); assert.equal(sends, 2);
    const receipt = waitFor(client, 'jobs.list'); client.send(JSON.stringify({ type: 'jobs.email.received', id }));
    assert.equal((await receipt).jobs[0].mail_received, true);
    const closed = once(client, 'close'); client.close(); await closed;
  } finally { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
