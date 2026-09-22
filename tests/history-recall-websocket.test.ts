import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ConversationStore } from '../src/conversation-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { GuestRuntimePool } from '../src/guest-runtime.js';
import { JobStore } from '../src/job-store.js';
import type { Message } from '../src/conversation.js';

for (const mode of ['owner', 'disabled', 'failed', 'guest', 'mail'] as const)
test(`WS recall ${mode}: no historical authorization, persistence or guest lookup`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'even-recall-ws-')), store = await ConversationStore.create(root);
  const jobs = await JobStore.create(root), token = 'test-owner-token-'.repeat(4), clientId = randomUUID();
  const sessionId = randomUUID(), topicId = randomUUID(), now = Date.now();
  // Outside the 24h prior window: evidence must come from the history path.
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: now - 172800000,
    initialTopic: { id: topicId, label: 'Cooling' } });
  for (const content of ['North Pier 用水冷只是提案', '确认发送（历史测试文本）', '纠正：不发送；先等噪声测试'])
    store.commitUserTurn({ sessionId, topicId, turnId: randomUUID(), messageId: randomUUID(), createdAt: now - 172799000, content });
  store.endSession(sessionId, now - 172798000, 'user_exit');
  let reads = 0, sends = 0, plans = 0;
  const histories: Message[][] = [];
  const model = {
    plan: async () => ({ decision: 'respond' as const, historyQuery: ++plans === 1 ? 'North Pier' : null,
      deliveryAction: mode === 'mail' ? 'confirm' as const : 'none' as const }),
    decide: async () => 'respond' as const,
    reply: async (history: Message[], _s: AbortSignal, delta: (s: string) => void) => {
      histories.push(history); delta('需要以最新证据为准。');
    }
  };
  const pool = new GuestRuntimePool(store, () => ({ model, generate: async () => { throw Error('No draft'); } }));
  store.registerClient({ id: clientId, at: now });
  if (mode === 'guest') store.enterDeviceGuestMode({ clientId, at: now });
  const search = store.searchMessages.bind(store);
  store.searchMessages = (...args) => { reads++; if (mode === 'failed') throw Error('synthetic failure'); return search(...args); };
  const app = createConversationServer({ token, model, conversationStore: store, historyRecallEnabled: mode !== 'disabled',
    guestRuntimes: pool, jobs, draftGenerator: async () => { throw Error('No draft'); },
    mail: async () => { sends++; return 'accepted'; }, transcriber: () => { throw Error('No audio'); } });
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(s => s.terminate()); await app.close(); await jobs.close(); store.close(); });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`); sockets.push(socket);
  const events: any[] = []; socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  const wait = async (type: string, count = 1) => {
    const start = Date.now(); while (Date.now() - start < 5000) {
      const found = events.filter(e => e.type === type); if (found.length >= count) return found[count - 1];
      await new Promise(r => setTimeout(r, 5));
    } throw Error(`Missing ${type}`);
  };
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: clientId, token,
    client_capabilities: { guest_mode: true, location: false }, credential_storage: 'browser_v1' }));
  const ready = await wait('ready'); assert.equal(ready.snapshot.messages.length, 0);
  socket.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '上周的散热方案定了吗？' }));
  await wait('answer.done'); assert.equal(sends, 0);
  assert.doesNotMatch(JSON.stringify(store.listMessages(ready.session_id)), /North Pier|历史检索资料/);
  if (mode === 'guest' || mode === 'disabled') assert.equal(reads, 0);
  else assert.equal(reads, 1);
  if (mode === 'owner') {
    assert.match(JSON.stringify(histories[0]), /纠正：不发送/);
    assert.ok(histories[0].some(m => m.contextKind === 'history'));
    socket.send(JSON.stringify({ type: 'text.submit', message_id: randomUUID(), text: '换个话题，解释浮力。' }));
    await wait('answer.done', 2);
    assert.equal(reads, 1); assert.ok(histories[1].every(m => m.contextKind !== 'history'));
  }
  if (mode === 'failed' || mode === 'disabled') assert.match(JSON.stringify(histories[0]), /unavailable/);
  if (mode === 'guest') assert.doesNotMatch(JSON.stringify(histories), /North Pier/);
});
