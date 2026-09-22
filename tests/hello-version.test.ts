import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';
import { readConversationStartupConfig } from '../src/conversation-startup-config.js';

test('hello versions fail closed by default; opt-in admits only absent legacy version', { timeout: 15000 }, async t => {
  for (const legacyHelloEnabled of [undefined, true]) {
    const app = createConversationServer({ token: 'x'.repeat(40), legacyHelloEnabled,
      model: { decide: async () => 'respond', reply: async () => { throw Error('unused'); } },
      transcriber: () => { throw Error('unused'); } });
    const clients: WebSocket[] = [];
    t.after(async () => { clients.forEach(c => c.terminate()); await app.close(); });
    app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
    for (const version of [undefined, null, 0, 1, 3, '2', false]) {
      const socket = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
      clients.push(socket); await once(socket, 'open');
      const response = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(40), protocol_version: version }));
      const event = JSON.parse(String((await response)[0]));
      assert.equal(event.type, legacyHelloEnabled && version === undefined ? 'ready' : 'error');
      const closed = once(socket, 'close'); socket.close(); await closed;
    }
  }
});

test('production legacy configuration is explicit and validated', () => {
  assert.equal(readConversationStartupConfig({}).legacyHelloEnabled, false);
  assert.equal(readConversationStartupConfig({ CONVERSATION_LEGACY_HELLO_ENABLED: 'true' }).legacyHelloEnabled, true);
  assert.throws(() => readConversationStartupConfig({ CONVERSATION_LEGACY_HELLO_ENABLED: 'yes' }));
});
