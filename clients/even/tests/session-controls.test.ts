import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackWebSocket } from '../dev/session-controls.ts';

test('development expiry control accepts only unencrypted loopback websocket targets', () => {
  for (const value of ['ws://127.0.0.1:3001/ws/conversation', 'ws://localhost:3001/ws/conversation', 'ws://[::1]:3001/ws/conversation']) {
    assert.equal(isLoopbackWebSocket(value), true);
  }
  for (const value of ['wss://calendar.eveng2assistant.com/ws/conversation', 'ws://192.168.1.3:3001/ws/conversation', 'https://localhost']) {
    assert.equal(isLoopbackWebSocket(value), false);
  }
});
