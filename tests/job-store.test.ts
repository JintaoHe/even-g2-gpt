import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { JobStore } from '../src/job-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { WorkSupervisor } from '../src/work-supervisor.js';
import WebSocket from 'ws';

const snapshot = [{ role: 'user' as const, content: 'Hi Even，中英混合' }, { role: 'assistant' as const, content: '收到' }];
async function waitJob(store: JobStore, id: string, state: string) {
  for (let n = 0; n < 200; n++) {
    if (store.get(id)?.state === state) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`Job did not become ${state}`);
}
test('jobs persist completed artifacts and queued snapshots across reopen; duplicate workers rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-jobs-test-'));
  let store = await JobStore.create(directory);
  try {
    await assert.rejects(JobStore.create(directory), /Another service/);
    const first = store.enqueue(snapshot); await waitJob(store, first.id, 'completed');
    assert.match((await store.download(first.id)).toString(), /中英混合/);
    const queued = store.enqueue(snapshot); await store.close();
    store = await JobStore.create(directory); await waitJob(store, queued.id, 'completed');
    assert.equal(store.get(first.id)?.state, 'completed');
    await assert.rejects(store.download('../escape'));
    assert.throws(() => store.enqueue([]));
  } finally { await store.close(); }
});
test('selected exports may exceed 100 messages but remain bounded by immutable byte limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-jobs-long-selection-'));
  const store = await JobStore.create(directory);
  try {
    const selected = Array.from({ length: 160 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `选定主题消息 ${index}`,
    }));
    const job = store.enqueue(selected);
    await waitJob(store, job.id, 'completed');
    const markdown = (await store.download(job.id)).toString();
    assert.match(markdown, /选定主题消息 0/);
    assert.match(markdown, /选定主题消息 159/);

    assert.throws(() => store.enqueue([{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }]), /too large/i);
  } finally { await store.close(); }
});
test('shutdown interrupts running jobs; cancelled jobs are not published; interrupted jobs are not replayed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-jobs-stop-'));
  const renderer = async (_h: unknown, signal: AbortSignal): Promise<string> => new Promise((_r, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  let store = await JobStore.create(directory, renderer);
  const cancelled = store.enqueue(snapshot); await waitJob(store, cancelled.id, 'running'); store.cancel(cancelled.id);
  await waitJob(store, cancelled.id, 'cancelled');
  const interrupted = store.enqueue(snapshot); await waitJob(store, interrupted.id, 'running'); await store.close();
  store = await JobStore.create(directory);
  assert.equal(store.get(interrupted.id)?.state, 'interrupted');
  await assert.rejects(store.download(cancelled.id)); await store.close();
  // Emulate a persisted running row left by abrupt process death, without any live owner.
  const db = new DatabaseSync(join(directory, 'jobs.sqlite'));
  db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(interrupted.id); db.close();
  store = await JobStore.create(directory);
  assert.equal(store.get(interrupted.id)?.error, 'SERVICE_RESTARTED'); await store.close();
});
test('artifact HTTP downloads require credentials and do not expose paths or inline HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-jobs-http-')), store = await JobStore.create(directory);
  const job = store.enqueue(snapshot); await waitJob(store, job.id, 'completed');
  const token = 't'.repeat(64);
  const app = createConversationServer({ legacyHelloEnabled: true, token, jobs: store, model: { decide: async () => 'respond', reply: async () => {} }, transcriber: () => { throw new Error('not used'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const base = `http://127.0.0.1:${(app.http.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/artifacts/${job.id}`)).status, 401);
    const response = await fetch(`${base}/artifacts/${job.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /attachment/);
    assert.match(await response.text(), /Hi Even/);
    assert.equal((await fetch(`${base}/artifacts/unknown`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  } finally { await app.close(); await store.close(); }
});
test('supervisor aborts all work, waits for cleanup and rejects new runs', async () => {
  const supervisor = new WorkSupervisor(); let cleaned = false;
  const pending = supervisor.run(new AbortController().signal, signal => new Promise<void>(resolve => {
    if (signal.aborted) { cleaned = true; resolve(); }
    else signal.addEventListener('abort', () => { cleaned = true; resolve(); }, { once: true });
  }));
  await supervisor.close(); await pending; assert.equal(cleaned, true);
  await assert.rejects(supervisor.run(new AbortController().signal, async () => {}), /stopping/);
});

test('WebSocket-export job survives client disconnect and remains listable after reconnect', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-jobs-disconnect-'));
  let finish!: () => void;
  const gate = new Promise<void>(r => { finish = r; });
  const store = await JobStore.create(directory, async () => { await gate; return '# saved'; });
  const token = 'x'.repeat(40), app = createConversationServer({ legacyHelloEnabled: true, token, jobs: store,
    model: { decide: async () => 'respond', reply: async (_h, _s, delta) => delta('hello') }, transcriber: () => { throw new Error('not used'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  let client = new WebSocket(url);
  const waitFor = (type: string) => new Promise<any>(resolve => {
    const socket = client;
    const listener = (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()); if (event.type === type) { socket.off('message', listener); resolve(event); } };
    socket.on('message', listener);
  });
  try {
    await once(client, 'open'); let wait = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token })); await wait;
    wait = waitFor('answer.done'); client.send(JSON.stringify({ type: 'text.submit', text: 'hi' })); await wait;
    wait = waitFor('job.created'); client.send(JSON.stringify({ type: 'jobs.export' })); const { job } = await wait;
    const closed = once(client, 'close'); client.close(); await closed;
    finish(); await waitJob(store, job.id, 'completed');
    client = new WebSocket(url); await once(client, 'open'); wait = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token })); await wait;
    wait = waitFor('jobs.list'); client.send(JSON.stringify({ type: 'jobs.list' }));
    assert.equal((await wait).jobs.find((j: any) => j.id === job.id).state, 'completed');
  } finally { finish(); client.terminate(); await app.close(); await store.close(); }
});
