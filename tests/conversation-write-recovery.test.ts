import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';
import { ConversationStore } from '../src/conversation-store.js';
import { JobStore } from '../src/job-store.js';
import type { MailResult } from '../src/mail.js';

const token = 'w'.repeat(64);
const model = { decide: async () => 'respond' as const, reply: async () => {} };

function waitFor(client: WebSocket, type: string) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout: ${type}`)); }, 3_000);
    const listener = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (event.type === type) { cleanup(); resolve(event); }
    };
    const cleanup = () => { clearTimeout(timer); client.off('message', listener); };
    client.on('message', listener);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function connect(url: string, hello: Record<string, unknown>) {
  const client = new WebSocket(url); await once(client, 'open');
  const ready = waitFor(client, 'ready'); client.send(JSON.stringify({ type: 'hello', protocol_version: 2, ...hello }));
  return { client, ready: await ready };
}

test('disconnect invalidates an Email approval and old confirmation cannot send after resume', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-write-recovery-email-'));
  const jobs = await JobStore.create(root), store = await ConversationStore.create(join(root, 'conversation'));
  const job = jobs.enqueue([{ role: 'user', content: 'private test document' }]);
  for (let attempt = 0; attempt < 200 && jobs.get(job.id)?.state !== 'completed'; attempt++) await new Promise(r => setTimeout(r, 5));
  let sends = 0;
  const app = createConversationServer({ token, jobs, conversationStore: store, mail: async () => { sends++; return 'accepted'; },
    model, transcriber: () => { throw new Error('unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = await connect(url, { client_id: clientId, token });
  const previewPromise = waitFor(first.client, 'mail.confirmation_required');
  first.client.send(JSON.stringify({ type: 'jobs.email.prepare', id: job.id }));
  const preview = await previewPromise;
  first.client.terminate(); await once(first.client, 'close');

  const second = await connect(url, { client_id: clientId, resume_session_id: first.ready.session_id,
    resume_credential: first.ready.resume_credential, last_seen_sequence: 0 });
  try {
    const refreshed = waitFor(second.client, 'mail.confirmation_required');
    second.client.send(JSON.stringify({ type: 'jobs.email', id: job.id, confirmation: preview.confirmation }));
    const next = await refreshed;
    assert.notEqual(next.confirmation, preview.confirmation);
    assert.equal(sends, 0);
  } finally {
    second.client.terminate(); await app.close(); await Promise.all([jobs.close(), store.close()]);
  }
});

test('disconnect dismisses a Calendar preview and old confirmation cannot write after resume', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-write-recovery-calendar-'));
  const store = await ConversationStore.create(root), previewId = randomUUID();
  let confirms = 0, dismisses = 0;
  const calendar = {
    health: () => ({ state: 'healthy' }),
    subscribeHealth: () => () => {},
    preview: async () => ({ id: previewId, kind: 'create', phrase: '确认创建', event: {} }),
    dismiss: (id: string) => { if (id === previewId) dismisses++; },
    confirm: async () => { confirms++; return { id: 'event', state: 'saved' }; },
    list: () => ({ events: [] }),
  } as any;
  const app = createConversationServer({ token, conversationStore: store, calendar, model,
    transcriber: () => { throw new Error('unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = await connect(url, { client_id: clientId, token });
  const previewPromise = waitFor(first.client, 'calendar.preview');
  first.client.send(JSON.stringify({ type: 'calendar.preview', kind: 'create', event: {} }));
  await previewPromise;
  first.client.terminate(); await once(first.client, 'close');

  const second = await connect(url, { client_id: clientId, resume_session_id: first.ready.session_id,
    resume_credential: first.ready.resume_credential, last_seen_sequence: 0 });
  try {
    const rejected = waitFor(second.client, 'calendar.error');
    second.client.send(JSON.stringify({ type: 'calendar.confirm', id: previewId, phrase: '确认创建' }));
    await rejected;
    assert.equal(confirms, 0);
    assert.ok(dismisses >= 1);
  } finally { second.client.terminate(); await app.close(); await store.close(); }
});

test('Email accepted after the socket drops is recorded once and the old approval cannot resend it', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-write-recovery-email-ack-'));
  const jobs = await JobStore.create(root), store = await ConversationStore.create(join(root, 'conversation'));
  const job = jobs.enqueue([{ role: 'user', content: 'provider acknowledgement test' }]);
  for (let attempt = 0; attempt < 200 && jobs.get(job.id)?.state !== 'completed'; attempt++) await new Promise(r => setTimeout(r, 5));
  const provider = deferred<MailResult>();
  let sends = 0, started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  const app = createConversationServer({ token, jobs, conversationStore: store,
    mail: async () => { sends++; started(); return provider.promise; }, model,
    transcriber: () => { throw new Error('unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = await connect(url, { client_id: clientId, token });
  const previewPromise = waitFor(first.client, 'mail.confirmation_required');
  first.client.send(JSON.stringify({ type: 'jobs.email.prepare', id: job.id }));
  const preview = await previewPromise;
  first.client.send(JSON.stringify({ type: 'jobs.email', id: job.id, confirmation: preview.confirmation }));
  await providerStarted;
  first.client.terminate(); await once(first.client, 'close');
  provider.resolve('accepted');
  for (let attempt = 0; attempt < 100 && jobs.mailState(job.id) !== 'accepted'; attempt++) await new Promise(r => setTimeout(r, 5));

  const second = await connect(url, { client_id: clientId, resume_session_id: first.ready.session_id,
    resume_credential: first.ready.resume_credential, last_seen_sequence: 0 });
  try {
    const rejected = waitFor(second.client, 'notice');
    second.client.send(JSON.stringify({ type: 'jobs.email', id: job.id, confirmation: preview.confirmation }));
    assert.match((await rejected).text, /邮件服务器已接受|确认是否收到/);
    assert.equal(jobs.mailState(job.id), 'accepted');
    assert.equal(sends, 1);
  } finally {
    second.client.terminate(); await app.close(); await Promise.all([jobs.close(), store.close()]);
  }
});

test('Calendar success after the socket drops is not replayed by an old confirmation', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-write-recovery-calendar-ack-'));
  const store = await ConversationStore.create(root), previewId = randomUUID();
  const provider = deferred<{ id: string; state: string }>();
  let confirms = 0, started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  const calendar = {
    health: () => ({ state: 'healthy' }), subscribeHealth: () => () => {},
    preview: async () => ({ id: previewId, kind: 'create', phrase: '确认创建', event: {} }),
    dismiss: () => {},
    confirm: async () => { confirms++; started(); return provider.promise; },
    reconcile: async () => ({ id: previewId, eventId: 'saved-event', kind: 'create', state: 'succeeded' }),
    list: () => ({ events: [] }),
  } as any;
  const app = createConversationServer({ token, conversationStore: store, calendar, model,
    transcriber: () => { throw new Error('unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`, clientId = randomUUID();
  const first = await connect(url, { client_id: clientId, token });
  const previewPromise = waitFor(first.client, 'calendar.preview');
  first.client.send(JSON.stringify({ type: 'calendar.preview', kind: 'create', event: {} }));
  await previewPromise;
  first.client.send(JSON.stringify({ type: 'calendar.confirm', id: previewId, phrase: '确认创建' }));
  await providerStarted;
  first.client.terminate(); await once(first.client, 'close');
  provider.resolve({ id: 'saved-event', state: 'saved' });

  const second = await connect(url, { client_id: clientId, resume_session_id: first.ready.session_id,
    resume_credential: first.ready.resume_credential, last_seen_sequence: 0 });
  try {
    const recovered = waitFor(second.client, 'calendar.result');
    second.client.send(JSON.stringify({ type: 'calendar.confirm', id: previewId, phrase: '确认创建' }));
    assert.equal((await recovered).recovered, true);
    assert.equal(confirms, 1);
  } finally { second.client.terminate(); await app.close(); await store.close(); }
});
