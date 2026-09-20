import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ReadingHistory } from '../src/reading-history.ts';
import { DisplaySession } from '../src/display-session.ts';
import { conversationWebSocketUrl } from '../src/backend-url.ts';
import { LocationController } from '../src/location.ts';
import { AudioController } from '../src/audio-controller.ts';
import { ConnectionController } from '../src/connection-controller.ts';
import { SessionCredentialStore } from '../src/session-credential.ts';

// Run the actual browser entry point against deterministic SDK/DOM/socket doubles.
// No network, credentials, microphone or simulator process is used by these tests.
async function fixture(startupResult = 0) {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '' });
    return elements.get(id);
  };
  const sockets: any[] = [], audio: boolean[] = [], writes: string[] = [];
  const nativeStorage = new Map<string, string>();
  let creates = 0, exits = 0, tick!: () => Promise<void>, hub!: (event: any) => void, device!: (event: any) => void;
  let pagehideListener: (() => void) | undefined;
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; sent: any[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: any) => void;
    constructor() { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
  }
  const bridge = {
    createStartUpPageContainer: async () => { creates++; return startupResult; },
    shutDownPageContainer: async () => { exits++; return true; },
    textContainerUpgrade: async (value: any) => { writes.push(value.content); return true; },
    audioControl: async (enabled: boolean) => { audio.push(enabled); return true; },
    getLocalStorage: async (key: string) => nativeStorage.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { nativeStorage.set(key, value); return true; },
    getAppLocation: async () => null,
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    onAppLocationChanged: () => () => {},
    onDeviceStatusChanged: (handler: typeof device) => { device = handler; return () => {}; },
    onEvenHubEvent: (handler: typeof hub) => { hub = handler; }
  };
  class Property { constructor(value: object) { Object.assign(this, value); } }
  const events = { FOREGROUND_EXIT_EVENT: 1, FOREGROUND_ENTER_EVENT: 2,
    SYSTEM_EXIT_EVENT: 3, ABNORMAL_EXIT_EVENT: 4, DOUBLE_CLICK_EVENT: 5 };
  const deviceTypes = { None: 'none', Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected', ConnectionFailed: 'connectionFailed' };
  const sdk = { waitForEvenAppBridge: async () => bridge, CreateStartUpPageContainer: Property,
    TextContainerProperty: Property, TextContainerUpgrade: Property, OsEventTypeList: events, DeviceConnectType: deviceTypes };
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const storage = new Map<string, string>();
  let visibilityListener: (() => void) | undefined;
  const testDocument = {
    hidden: false,
    getElementById: element,
    addEventListener(type: string, handler: () => void) { if (type === 'visibilitychange') visibilityListener = handler; },
  };
  runInNewContext(js, {
    exports: {}, require: (name: string) => name === './reading-history' ? { ReadingHistory }
      : name === './display-session' ? { DisplaySession }
      : name === './backend-url' ? { conversationWebSocketUrl }
      : name === './location' ? { LocationController }
      : name === './audio-controller' ? { AudioController }
      : name === './connection-controller' ? { ConnectionController }
      : name === './session-credential' ? { SessionCredentialStore } : sdk,
    document: testDocument, window: { addEventListener(type: string, handler: () => void) {
      if (type === 'pagehide') pagehideListener = handler;
    } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    __EVEN_BACKEND_ORIGIN__: '', __EVEN_CONNECTION_LABEL__: '本地后端 · 127.0.0.1:3001 · WS',
    location: { protocol: 'http:', host: 'localhost' }, WebSocket: Socket,
    setInterval: (callback: typeof tick) => { tick = callback; return 1; }, clearInterval() {},
    setTimeout, clearTimeout, console: { info() {} }
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  async function connect(capabilities: Record<string, unknown> = { provider: 'api', speech: true }) {
    element('token').value = 'synthetic-test-token-not-a-secret-12345';
    await element('connect').onclick();
    const ws = sockets.at(-1); ws.readyState = 1; ws.onopen();
    assert.equal(ws.sent[0].token, 'synthetic-test-token-not-a-secret-12345');
    ws.onmessage({ data: JSON.stringify({ type: 'ready', protocol_version: 2,
      connection_id: '33333333-3333-4333-8333-333333333333', session_id: '22222222-2222-4222-8222-222222222222',
      resumed: false, latest_sequence: 0, resume_window_minutes: 15,
      resume_credential: 'r'.repeat(32), resume_expires_at: Date.now() + 60_000,
      snapshot: { state: 'listening', messages: [] }, capabilities }) });
    ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) });
    await flush(); await tick(); return ws;
  }
  return { element, connect, flush, tick: () => tick(), audio, writes, sockets,
    counts: () => ({ creates, exits }), device: (connectType: string) => device({ connectType }),
    visibility: async (hidden: boolean) => { testDocument.hidden = hidden; visibilityListener?.(); await flush(); },
    backgroundExit: async () => { hub({ sysEvent: { eventType: events.FOREGROUND_EXIT_EVENT } }); await flush(); },
    foregroundEnter: async () => { hub({ sysEvent: { eventType: events.FOREGROUND_ENTER_EVENT } }); await flush(); },
    pagehide: async () => { pagehideListener?.(); await flush(); },
    systemExit: () => { const ws = sockets.at(-1); hub({ sysEvent: { eventType: events.SYSTEM_EXIT_EVENT } }); ws?.close(); } };
}

test('hot reload adopts an existing glasses container instead of splitting the displays', async () => {
  const f = await fixture(1);
  assert.deepEqual(f.counts(), { creates: 1, exits: 0 });
  assert.match(f.writes[0], /请在伴随页面连接后端/);
  assert.equal(f.element('bridge').textContent, 'Even SDK 已连接 · 576 × 288 显示');
  assert.equal(f.element('backend-target').textContent, '连接目标：本地后端 · 127.0.0.1:3001 · WS');
  assert.equal(f.element('recovery-window').textContent, '会话恢复窗口：连接后由服务器确认');
});

test('server-confirmed recovery window is visible after connection', async () => {
  const f = await fixture(); await f.connect();
  assert.equal(f.element('recovery-window').textContent, '会话恢复窗口：15 分钟');
});

test('cold start reconciles side effects and renders uncertain server state on glasses', async () => {
  const f = await fixture();
  const ws = await f.connect({ provider: 'api', speech: true, email: true, calendar: true });
  assert.ok(ws.sent.some((event: any) => event.type === 'jobs.list'));
  assert.ok(ws.sent.some((event: any) => event.type === 'calendar.list'));

  ws.onmessage({ data: JSON.stringify({ type: 'jobs.list', jobs: [{ id: 'secret-job', mail_state: 'unknown' }] }) });
  ws.onmessage({ data: JSON.stringify({ type: 'calendar.list', events: [], operations: [{ id: 'secret-op', state: 'sending' }] }) });
  await f.flush(); await f.tick();
  assert.match(f.writes.at(-1)!, /邮件待核实：1/);
  assert.match(f.writes.at(-1)!, /日历待核实：1/);
  assert.doesNotMatch(f.writes.at(-1)!, /secret-job|secret-op/);
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

test('microphone intent survives temporary device loss and hidden companion UI', async () => {
  const f = await fixture(); await f.connect();
  f.element('audio').onclick(); await f.flush();
  assert.equal(f.audio.at(-1), true);

  f.device('disconnected'); await f.flush();
  assert.equal(f.audio.at(-1), false);
  f.device('connected'); await f.flush();
  assert.equal(f.audio.at(-1), true);

  await f.visibility(true);
  assert.equal(f.audio.at(-1), false);
  await f.visibility(false);
  assert.equal(f.audio.at(-1), true);
});

test('Even foreground exit and enter suspend then restore microphone intent without a new tap', async () => {
  const f = await fixture(); await f.connect();
  f.element('audio').onclick(); await f.flush();
  assert.equal(f.audio.at(-1), true);
  await f.backgroundExit(); assert.equal(f.audio.at(-1), false);
  await f.foregroundEnter(); assert.equal(f.audio.at(-1), true);
});

test('pagehide is non-destructive and native foreground entry reconnects a dropped transport', async () => {
  const f = await fixture(); const first = await f.connect();
  await f.pagehide();
  assert.equal(first.readyState, 1, 'pagehide must not dispose the resumable socket');
  first.drop(); await f.foregroundEnter();
  assert.equal(f.sockets.length, 2, 'foreground entry should bypass the pending backoff');
  const second = f.sockets[1]; second.readyState = 1; second.onopen();
  assert.equal(second.sent[0].resume_session_id, '22222222-2222-4222-8222-222222222222');
});
