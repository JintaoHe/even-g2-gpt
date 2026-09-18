import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationWebSocketUrl } from '../src/backend-url.ts';

test('development build uses the current origin and production build uses configured WSS', () => {
  assert.equal(conversationWebSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }), 'ws://127.0.0.1:5173/ws/conversation');
  assert.equal(conversationWebSocketUrl({ protocol: 'https:', host: 'client.example' }), 'wss://client.example/ws/conversation');
  assert.equal(conversationWebSocketUrl({ protocol: 'file:', host: '' }, 'wss://calendar.eveng2assistant.com'),
    'wss://calendar.eveng2assistant.com/ws/conversation');
});

test('packaged backend must be a bare TLS WebSocket origin', () => {
  for (const value of ['ws://calendar.eveng2assistant.com', 'wss://user:pass@example.com',
    'wss://calendar.eveng2assistant.com/path', 'wss://calendar.eveng2assistant.com?x=1']) {
    assert.throws(() => conversationWebSocketUrl({ protocol: 'file:', host: '' }, value));
  }
  assert.throws(() => conversationWebSocketUrl({ protocol: 'file:', host: '' }));
});
