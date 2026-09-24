import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createConversationServer, isEvenLoopbackOrigin } from '../src/conversation-server.js';
import { ConversationStore } from '../src/conversation-store.js';

test('Even loopback Origin accepts only canonical HTTP IPv4 loopback with explicit non-default ports', () => {
  for (const port of [1, 65535, 65126, 19327, 42819, 51003]) {
    assert.equal(isEvenLoopbackOrigin(`http://127.0.0.1:${port}`), true);
  }
  for (const origin of ['http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:080', 'http://127.0.0.1:80', 'http://127.0.0.1:0001',
    'https://127.0.0.1:65126', 'http://localhost:65126', 'http://127.0.0.2:65126',
    'http://[::1]:65126', 'http://127.0.0.1.evil.com:65126', 'http://evil.com:65126',
    'http://127.0.0.1:65126/path', 'http://user@127.0.0.1:65126', 'null', '*', '',
    'HTTP://127.0.0.1:65126', 'http://127.1:65126', 'http://2130706433:65126',
    'http://127.0.0.1:65126/', 'http://127.0.0.1:65126?x', ' http://127.0.0.1:65126']) {
    assert.equal(isEvenLoopbackOrigin(origin), false, origin);
  }
});

for (const allowLoopbackOrigin of [undefined, false, true]) {
  test(`WS loopback opt-in=${allowLoopbackOrigin}: Host and authentication remain required`, { timeout: 10000 }, async t => {
    const data = await mkdtemp(join(tmpdir(), 'even-loopback-'));
    const store = await ConversationStore.create(data);
    const token = 'synthetic-test-token-'.repeat(4), host = 'assistant.example';
    let modelCalls = 0;
    const logs: unknown[][] = [];
    t.mock.method(console, 'info', (...args: unknown[]) => { logs.push(args); });
    const app = createConversationServer({ token, conversationStore: store,
      model: { decide: async () => { modelCalls++; return 'respond'; }, reply: async () => { modelCalls++; } },
      transcriber: () => { throw Error('no audio'); },
      ingress: { publicHosts: [host], allowedOrigins: [`https://${host}`], allowLoopbackOrigin } });
    const clients: WebSocket[] = [];
    t.after(async () => {
      for (const client of clients) client.terminate();
      await app.close(); await store.close(); await rm(data, { recursive: true, force: true });
    });
    app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
    const port = (app.http.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}/ws/conversation`;
    async function rejected(origin: string, requestHost = host) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: '/ws/conversation', headers: {
          Host: requestHost, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('upgrade', (_res, socket) => { socket.destroy(); reject(Error('unexpected upgrade')); });
        req.on('error', reject); req.end();
      });
      assert.equal(status, 403);
    }
    async function connect(origin: string, authenticate: boolean) {
      const client = new WebSocket(url, { origin, headers: { Host: host } }); clients.push(client);
      await once(client, 'open');
      const message = once(client, 'message');
      client.send(JSON.stringify({ type: 'hello', protocol_version: 2, client_id: randomUUID(),
        ...(authenticate ? { token } : {}) }));
      const event = JSON.parse((await message)[0].toString());
      assert.equal(event.type, authenticate ? 'ready' : 'error');
      if (!authenticate) assert.equal(event.code, 'INVALID_MESSAGE');
      const closed = once(client, 'close'); client.close(); await closed;
    }
    for (const origin of ['http://127.0.0.1:65126', 'http://127.0.0.1:42819']) {
      if (allowLoopbackOrigin) { await connect(origin, false); await connect(origin, true); }
      else await rejected(origin);
    }
    await rejected('http://127.0.0.1:65126', 'evil.example');
    await rejected('http://127.0.0.1.evil.com:65126');
    await connect(`https://${host}`, true);
    assert.equal(modelCalls, 0);
    const accepted = logs.flat().filter((entry): entry is string => typeof entry === 'string')
      .map(entry => { try { return JSON.parse(entry); } catch { return undefined; } })
      .filter(entry => entry?.event === 'origin_accepted');
    assert.deepEqual(accepted, allowLoopbackOrigin ? [65126, 65126, 42819, 42819]
      .map(port => ({ event: 'origin_accepted', kind: 'loopback', port })) : []);
  });
}
