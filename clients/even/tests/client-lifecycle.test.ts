import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ReadingHistory } from '../src/reading-history.ts';
import { DisplaySession } from '../src/display-session.ts';
import { conversationWebSocketUrl } from '../src/backend-url.ts';

// Run the actual browser entry point against deterministic SDK/DOM/socket doubles.
// No network, credentials, microphone or simulator process is used by these tests.
async function fixture(startupResult = 0) {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '' });
    return elements.get(id);
  };
  const sockets: any[] = [], audio: boolean[] = [], writes: string[] = [];
  let creates = 0, exits = 0, tick!: () => Promise<void>, hub!: (event: any) => void;
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; sent: any[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: any) => void;
    constructor() { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const bridge = {
    createStartUpPageContainer: async () => { creates++; return startupResult; },
    shutDownPageContainer: async () => { exits++; return true; },
    textContainerUpgrade: async (value: any) => { writes.push(value.content); return true; },
    audioControl: async (enabled: boolean) => { audio.push(enabled); return true; },
    onEvenHubEvent: (handler: typeof hub) => { hub = handler; }
  };
  class Property { constructor(value: object) { Object.assign(this, value); } }
  const events = { FOREGROUND_EXIT_EVENT: 1, SYSTEM_EXIT_EVENT: 2, ABNORMAL_EXIT_EVENT: 3, DOUBLE_CLICK_EVENT: 4 };
  const sdk = { waitForEvenAppBridge: async () => bridge, CreateStartUpPageContainer: Property,
    TextContainerProperty: Property, TextContainerUpgrade: Property, OsEventTypeList: events };
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    exports: {}, require: (name: string) => name === './reading-history' ? { ReadingHistory }
      : name === './display-session' ? { DisplaySession }
      : name === './backend-url' ? { conversationWebSocketUrl } : sdk,
    document: { getElementById: element, addEventListener() {} }, window: { addEventListener() {} },
    location: { protocol: 'http:', host: 'localhost' }, WebSocket: Socket,
    setInterval: (callback: typeof tick) => { tick = callback; return 1; }, clearInterval() {}, console: { info() {} }
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  async function connect() {
    element('token').value = 'synthetic-test-token-not-a-secret-12345';
    await element('connect').onclick();
    const ws = sockets.at(-1); ws.readyState = 1; ws.onopen();
    assert.equal(ws.sent[0].token, 'synthetic-test-token-not-a-secret-12345');
    ws.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { provider: 'api', speech: true } }) });
    ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) });
    await flush(); await tick(); return ws;
  }
  return { element, connect, flush, tick: () => tick(), audio, writes, sockets,
    counts: () => ({ creates, exits }), systemExit: () => hub({ sysEvent: { eventType: events.SYSTEM_EXIT_EVENT } }) };
}

test('hot reload adopts an existing glasses container instead of splitting the displays', async () => {
  const f = await fixture(1);
  assert.deepEqual(f.counts(), { creates: 1, exits: 0 });
  assert.match(f.writes[0], /请在伴随页面连接后端/);
  assert.equal(f.element('bridge').textContent, 'Even SDK 已连接 · 576 × 288 显示');
});

for (const systemEvent of [false, true]) test(`exit then reconnect redraws with system exit event=${systemEvent}`, async () => {
  const f = await fixture();
  let ws = await f.connect();
  for (let i = 0; i < 2; i++) {
    ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'exit_pending' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'exit.confirmation_required' }) });
    await f.flush();
    if (systemEvent) f.systemExit();
    const before = f.writes.length;
    ws = await f.connect();
    assert.ok(f.writes.length > before, 'render timer resumes and cached frame is invalidated');
    assert.match(f.writes.at(-1)!, /API.*等待说话/);
  }
  assert.deepEqual(f.counts(), { creates: 3, exits: 2 });
  assert.equal(f.audio.includes(true), false);
});

test('explicit cancel restores display and resumes the existing session without microphone', async () => {
  const f = await fixture(); const ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'exit_pending' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'exit.confirmation_required' }) });
  await f.flush(); await f.element('resume').onclick(); await f.tick();
  assert.ok(ws.sent.some((event: any) => event.type === 'exit.confirm' && event.confirm === false));
  assert.equal(f.sockets.length, 1); assert.equal(f.counts().creates, 2);
  assert.equal(f.audio.includes(true), false);
});
