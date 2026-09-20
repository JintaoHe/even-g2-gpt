import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackWebSocket, storageReportText } from '../dev/session-controls.ts';

test('development expiry control accepts only unencrypted loopback websocket targets', () => {
  for (const value of ['ws://127.0.0.1:3001/ws/conversation', 'ws://localhost:3001/ws/conversation', 'ws://[::1]:3001/ws/conversation']) {
    assert.equal(isLoopbackWebSocket(value), true);
  }
  for (const value of ['wss://calendar.eveng2assistant.com/ws/conversation', 'ws://192.168.1.3:3001/ws/conversation', 'https://localhost']) {
    assert.equal(isLoopbackWebSocket(value), false);
  }
});

test('storage lab report is concise and never needs transcript content', () => {
  const text = storageReportText({ type: 'test.storage.report', action: 'cleanup_apply',
    sqlite: { schema_version: 3, journal_mode: 'wal', foreign_keys: true },
    storage: { sessions: 4, messages: 12, database_bytes: 1048576, available_disk_bytes: 10485760, warnings: [] },
    current_session: { status: 'active', latest_sequence: 8 },
    retention: { test_eligible_sessions: 1, test_eligible_messages: 0, deleted_sessions: 1, deleted_messages: 0 } });
  assert.match(text, /Schema v3/);
  assert.match(text, /本次删除 1 个会话/);
  assert.match(text, /未读取或显示对话正文/);
  assert.doesNotMatch(text, /session_id|database_path|content/);
});
