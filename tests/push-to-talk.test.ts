import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';
import { TurnDetector } from '../src/vad.js';
import { ConversationStore } from '../src/conversation-store.js';

test('held capture includes quiet onset and does not end at a silence gap', () => {
  let starts = 0, ends = 0, bytes = 0;
  const d = new TurnDetector(() => starts++, p => { bytes += p.length; }, () => ends++);
  d.push(Buffer.alloc(640 * 100), true);
  assert.equal(starts, 1); assert.equal(ends, 0); assert.equal(bytes, 640 * 100);
  d.finish(); assert.equal(ends, 1);
});

test('WS held speech submits only on release; duplicate release and late PCM cannot re-submit', { timeout: 10000 }, async t => {
  let starts = 0, finishes = 0, replies = 0, received = 0;
  const store = await ConversationStore.create(await mkdtemp(join(tmpdir(), 'hold-speech-')));
  const app = createConversationServer({ token: 'synthetic-test-token-'.repeat(3), conversationStore: store,
    model: { decide: async () => 'respond', reply: async (_h, _s, delta) => { replies++; delta('合成答案'); } },
    transcriber: () => {
      starts++; let resolve!: (text: string) => void;
      const result = new Promise<string>(r => { resolve = r; });
      return { result, push: p => { received += p.length; },
        finish: () => { finishes++; resolve('合成问题'); }, cancel: () => {} };
    } });
  let ws: WebSocket;
  t.after(async () => { ws?.terminate(); await app.close(); await store.close(); });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  ws = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
  const events: any[] = []; ws.on('message', raw => events.push(JSON.parse(raw.toString())));
  const wait = async (type: string) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) { const e = events.find(e => e.type === type); if (e) return e; await new Promise(r => setTimeout(r, 5)); }
    throw Error('Missing ' + type);
  };
  const send = (type: string) => ws.send(JSON.stringify({ type, command_id: randomUUID() }));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(),
    token: 'synthetic-test-token-'.repeat(3), client_capabilities: { location: false }, credential_storage: 'browser_v1' }));
  assert.equal((await wait('ready')).capabilities.push_to_talk, true);
  send('turn.begin'); send('turn.begin');
  for (let i = 0; i < 20; i++) ws.send(Buffer.alloc(3200)); // two seconds of silence must not finish
  await wait('speech.started'); await new Promise(r => setTimeout(r, 30));
  assert.equal(starts, 1); assert.equal(finishes, 0); assert.equal(replies, 0); assert.equal(received, 64000);
  send('turn.submit'); await wait('answer.done');
  assert.equal(finishes, 1); assert.equal(replies, 1);
  send('turn.submit'); ws.send(Buffer.alloc(3200)); await new Promise(r => setTimeout(r, 30));
  assert.equal(starts, 1); assert.equal(replies, 1);
  send('turn.begin'); ws.send(Buffer.alloc(3200)); send('pause');
  await new Promise(r => setTimeout(r, 30)); assert.equal(finishes, 1); assert.equal(replies, 1);
});
