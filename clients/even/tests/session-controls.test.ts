import assert from 'node:assert/strict';
import test from 'node:test';
import { installSessionControls, isLoopbackWebSocket, storageReportText } from '../dev/session-controls.ts';

class FakeElement {
  readonly tagName: string;
  id = '';
  type = '';
  textContent = '';
  disabled = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  onclick?: () => void | Promise<void>;
  constructor(tagName: string) { this.tagName = tagName; }
  append(...children: FakeElement[]) { this.children.push(...children); }
}

function find(root: FakeElement, id: string): FakeElement | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = find(child, id);
    if (match) return match;
  }
  return undefined;
}

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

test('loopback development panel exposes an awaited forced cold-start control', async () => {
  const body = new FakeElement('body');
  const root = { body, createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  let coldStarts = 0;
  const installed = installSessionControls({
    backendUrl: 'ws://127.0.0.1:3001/ws/conversation',
    resume: () => true,
    expire: () => true,
    coldStart: async () => { coldStarts++; return true; },
    command: () => true,
  }, root);
  assert.ok(installed);
  const button = find(body, 'force-cold-start-now');
  assert.ok(button?.onclick);
  await button.onclick();
  assert.equal(coldStarts, 1);
  assert.equal(button.disabled, false);
  assert.match(find(body, 'session-storage-controls')?.children.at(-1)?.textContent ?? '', /保留原生恢复凭证/);
});

test('forced cold-start control remains absent for non-loopback backends', () => {
  const body = new FakeElement('body');
  const root = { body, createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  const installed = installSessionControls({
    backendUrl: 'wss://calendar.eveng2assistant.com/ws/conversation',
    resume: () => true,
    expire: () => true,
    coldStart: () => true,
    command: () => true,
  }, root);
  assert.equal(installed, undefined);
  assert.equal(body.children.length, 0);
});
