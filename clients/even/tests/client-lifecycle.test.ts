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
async function fixture(startupResult = 0, initiallyHidden = false, savedSession = false, openResult = true) {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '' });
    return elements.get(id);
  };
  let locationCalls = 0;
  const sockets: any[] = [], audio: boolean[] = [], writes: string[] = [];
  const frames: any[] = [], layouts: any[] = [];
  const diagnostics: unknown[] = [];
  const nativeStorage = new Map<string, string>();
  if (savedSession) {
    nativeStorage.set('glass-assistant.client-id.v3', '11111111-1111-4111-8111-111111111111');
    nativeStorage.set('glass-assistant.resume-credential.v3', JSON.stringify({
      clientId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
      secret: 'r'.repeat(32), expiresAt: Date.now() + 60_000,
    }));
  }
  let creates = 0, exits = 0, tick!: () => Promise<void>, hub!: (event: any) => void, device!: (event: any) => void;
  let pagehideListener: (() => void) | undefined;
  let holdDeadline: (() => void) | undefined;
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; sent: any[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (event: any) => void;
    constructor() { sockets.push(this); }
    send(data: string | Uint8Array) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
    close() { this.readyState = 3; this.onclose?.(); }
    drop(code?: number) { this.readyState = 3; (this.onclose as any)?.({ code }); }
  }
  const bridge = {
    createStartUpPageContainer: async (value: any) => { layouts.push(value); creates++; return startupResult; },
    rebuildPageContainer: async (value: any) => { writes.push(value.textObject[0].content); return true; },
    shutDownPageContainer: async () => { exits++; return true; },
    textContainerUpgrade: async (value: any) => { frames.push(value); writes.push(value.content); return true; },
    audioControl: async (enabled: boolean) => { audio.push(enabled); return enabled ? openResult : true; },
    onLaunchSource: (callback: (source: string) => void) => { callback(initiallyHidden ? 'glassesMenu' : 'appMenu'); return () => {}; },
    getLocalStorage: async (key: string) => nativeStorage.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { nativeStorage.set(key, value); return true; },
    getAppLocation: async () => { locationCalls++; return null; },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    onAppLocationChanged: () => () => {},
    onDeviceStatusChanged: (handler: typeof device) => { device = handler; return () => {}; },
    onEvenHubEvent: (handler: typeof hub) => { hub = handler; }
  };
  class Property { constructor(value: object) { Object.assign(this, value); } }
  const events = { FOREGROUND_EXIT_EVENT: 1, FOREGROUND_ENTER_EVENT: 2,
    SYSTEM_EXIT_EVENT: 3, ABNORMAL_EXIT_EVENT: 4, DOUBLE_CLICK_EVENT: 5, CLICK_EVENT: 6, LONG_PRESS_EVENT: 9, LONG_PRESS_RELEASE_EVENT: 10 };
  const deviceTypes = { None: 'none', Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected', ConnectionFailed: 'connectionFailed' };
  const sdk = { waitForEvenAppBridge: async () => bridge, CreateStartUpPageContainer: Property, RebuildPageContainer: Property,
    TextContainerProperty: Property, TextContainerUpgrade: Property, OsEventTypeList: events, DeviceConnectType: deviceTypes };
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const storage = new Map<string, string>();
  let visibilityListener: (() => void) | undefined;
  const testDocument = {
    hidden: initiallyHidden,
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
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 60000) { holdDeadline = callback; return 987654; }
      return setTimeout(callback, ms);
    }, clearTimeout: (id: any) => { if (id === 987654) holdDeadline = undefined; else clearTimeout(id); },
    performance, console: { info(...args: unknown[]) { diagnostics.push(args); } }
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  async function connect(capabilities: Record<string, unknown> = { provider: 'api', speech: true, push_to_talk: true, location: true }) {
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
  return { element, connect, flush,
    firstAnswer: async () => { const ws = sockets.at(-1); ws.onmessage({ data: JSON.stringify({ type: 'answer.start', id: 'first' }) }); ws.onmessage({ data: JSON.stringify({ type: 'answer.done', id: 'first' }) }); await flush(); }, tick: () => tick(), audio, writes, frames, layouts, sockets, diagnostics,
    counts: () => ({ creates, exits }), locationCalls: () => locationCalls,
    holdTimeout: async () => { holdDeadline?.(); await flush(); },
    hold: async (system = false) => { hub({ [system ? 'sysEvent' : 'textEvent']: { eventType: events.LONG_PRESS_EVENT } }); await flush(); },
    release: async (system = false) => { hub({ [system ? 'sysEvent' : 'textEvent']: { eventType: events.LONG_PRESS_RELEASE_EVENT } }); await flush(); }, device: (connectType: string) => device({ connectType }),
    visibility: async (hidden: boolean) => { testDocument.hidden = hidden; visibilityListener?.(); await flush(); },
    backgroundExit: async () => { hub({ sysEvent: { eventType: events.FOREGROUND_EXIT_EVENT } }); await flush(); },
    foregroundEnter: async () => { hub({ sysEvent: { eventType: events.FOREGROUND_ENTER_EVENT } }); await flush(); },
    pagehide: async () => { pagehideListener?.(); await flush(); },
    pcm: () => hub({ audioEvent: { audioPcm: new Uint8Array([1, 2, 3, 4]) } }),
    tap: async () => { hub({ textEvent: { eventType: events.CLICK_EVENT } }); await flush(); },
    systemExit: () => { const ws = sockets.at(-1); hub({ sysEvent: { eventType: events.SYSTEM_EXIT_EVENT } }); ws?.close(); } };
}

test('actual renderer uses tall body; manual review is not redrawn by arriving chunks; reset clears both', async () => {
  const f = await fixture(); const ws = await f.connect();
  assert.equal(f.layouts[0].containerTotalNum, 2);
  assert.equal(f.layouts[0].textObject[0].height, 236);
  assert.equal(f.layouts[0].textObject[0].xPosition, 0);
  assert.equal(f.layouts[0].textObject[0].width, 576);
  const event = (e: any) => ws.onmessage({ data: JSON.stringify(e) });
  event({ type: 'answer.start', id: 99 });
  event({ type: 'answer.delta', id: 99, text: Array.from({ length: 30 }, (_, i) => `秘密行${i}`).join('\n') });
  f.element('latest').onclick(); // explicit skip-animation action for viewport geometry
  await f.tick(); assert.equal(f.frames.at(-1).containerID, 1);
  assert.equal(f.frames.at(-1).content.split('\n').length, 6);
  f.element('prev').onclick(); await f.tick();
  const bodies = f.frames.filter(x => x.containerID === 1).length;
  event({ type: 'answer.delta', id: 99, text: '\n新到达' }); await f.tick();
  assert.equal(f.frames.filter(x => x.containerID === 1).length, bodies);
  event({ type: 'notice', code: 'MEMORY_CONTEXT_RESET', text: '上下文已更新' }); await f.tick();
  for (const id of [1, 2]) assert.doesNotMatch(f.frames.filter(x => x.containerID === id).at(-1).content, /秘密/);
  assert.equal(f.frames.filter(x => x.containerID === 1).at(-1).content, '上下文已更新');
});

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



test('launch does not open audio when the backend lacks speech support', async () => {
  const f = await fixture();
  await f.connect({ provider: 'api', speech: false });
  assert.deepEqual(f.audio, []);
});

test('mode change clears owner pager, form, token, references and late frames before guest display', async () => {
  const f = await fixture(); const ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'answer.start', id: 7 }) });
  ws.onmessage({ data: JSON.stringify({ type: 'answer.delta', id: 7, text: 'OWNER_PRIVATE_VIEW' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'answer.done', id: 7 }) });
  f.element('latest').onclick(); // ensure full private view exists before testing removal
  await f.tick(); assert.match(f.element('preview').textContent, /OWNER_PRIVATE_VIEW/);
  f.element('text').value = 'private unsent'; f.element('token').value = 'private token';
  ws.onmessage({ data: JSON.stringify({ type: 'access.changed', mode: 'guest', clear_display: true, clear_resume: true, reconnect: true }) });
  ws.onmessage({ data: JSON.stringify({ type: 'answer.delta', id: 7, text: 'LATE_SECRET' }) });
  await f.flush(); await f.tick();
  assert.doesNotMatch(f.writes.at(-1)!, /OWNER_PRIVATE_VIEW|LATE_SECRET/);
  assert.equal(f.element('text').value, ''); assert.equal(f.element('token').value, '');
  assert.equal(f.element('connection-meta').textContent, '');
  assert.match(f.element('access-mode').textContent, /访客/);
  assert.equal(f.element('guest-unlock').disabled, true);
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

test('search quota exhaustion is explicit on glasses without exposing ledger details', async () => {
  const f = await fixture(); const ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'answer.start', id: 7 }) });
  ws.onmessage({ data: JSON.stringify({ type: 'search.status', id: 7, status: 'quota_exhausted',
    ledger_path: 'private/search-usage.json' }) });
  await f.flush(); await f.tick();
  assert.match(f.writes.at(-1)!, /联网额度已用完，仍可聊天/);
  assert.doesNotMatch(f.writes.at(-1)!, /search-usage|ledger/);
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
    assert.match(f.writes.slice(-2).join('\n'), /助手 OFF/);
    assert.match(f.element('status').textContent, /麦克风已暂停/);
  }
  assert.deepEqual(f.counts(), { creates: 3, exits: 2 });
  assert.equal(f.audio.filter(Boolean).length, 1, 'only the initial launch opens audio');
  assert.notEqual(f.audio.at(-1), true);
});

test('explicit cancel restores display and resumes the existing session without microphone', async () => {
  const f = await fixture(); const ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'exit_pending' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'exit.confirmation_required' }) });
  await f.flush(); await f.element('resume').onclick(); await f.tick();
  assert.ok(ws.sent.some((event: any) => event.type === 'exit.confirm' && event.confirm === false));
  assert.equal(f.sockets.length, 1); assert.equal(f.counts().creates, 2);
  assert.equal(f.audio.filter(Boolean).length, 1);
  assert.notEqual(f.audio.at(-1), true);
});



test('partial reply retry notice is visible without automatically restarting audio', async () => {
  const f = await fixture(); const ws = await f.connect();
  await f.firstAnswer();
  ws.onmessage({ data: JSON.stringify({ type: 'notice', code: 'PARTIAL_REPLY_RETRY_REQUIRED', text: '请说“用5.6重新回答”。' }) });
  await f.flush(); await f.tick();
  assert.match(f.writes.at(-1)!, /用5.6重新回答/);
  assert.equal(f.audio.filter(Boolean).length, 1);
  assert.notEqual(f.audio.at(-1), true);
});

test('exit cancellation notice is visible on the glasses and keeps capture paused', async () => {
  const f = await fixture(); const ws = await f.connect();
  await f.firstAnswer();
  ws.onmessage({ data: JSON.stringify({ type: 'notice', code: 'EXIT_CANCELLED',
    text: '退出已取消，麦克风仍暂停；点击一次继续。' }) });
  await f.flush(); await f.tick();
  assert.match(f.writes.at(-1)!, /退出已取消/);
  assert.match(f.writes.at(-1)!.replace(/\n/g, ''), /点击一次继续/);
  assert.equal(f.audio.filter(Boolean).length, 1);
  assert.notEqual(f.audio.at(-1), true);
});









test('SDK refusal remains visible after listening and diagnostics contain no credentials', async () => {
  const f = await fixture(0, true, false, false); const ws = await f.connect(); await f.hold();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) });
  await f.flush(); await f.tick();
  assert.match(f.element('status').textContent, /开麦失败/);
  assert.match(f.frames.filter(x => x.containerID === 2).at(-1).content, /开麦失败.*OFF/);
  assert.equal(f.audio.filter(Boolean).length, 1, 'do not blindly retry native false');
  const logs = JSON.stringify(f.diagnostics);
  assert.match(logs, /sdk_result/); assert.match(logs, /glassesMenu/);
  assert.doesNotMatch(logs, /synthetic-test-token|rrrrrrrr|resume_credential/);
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


for (const system of [false, true]) test(`hold/release through actual entry point, system surface=${system}`, async () => {
  const f = await fixture(0, true); const ws = await f.connect();
  assert.deepEqual(f.audio, [true], 'locked-phone first launch records automatically');
  await f.firstAnswer(); f.audio.length = 0;
  await f.tap(); assert.deepEqual(f.audio, [], 'single click cannot record');
  await f.hold(system); await f.hold(system);
  assert.deepEqual(f.audio, [true]); assert.equal(f.locationCalls(), 2);
  assert.equal(ws.sent.filter((e: any) => e.type === 'turn.begin').length, 1);
  f.pcm(); assert.ok(ws.sent.at(-1) instanceof Uint8Array);
  await f.release(system); await f.release(system); await f.tap();
  assert.deepEqual(f.audio, [true, false]);
  assert.equal(ws.sent.filter((e: any) => e.type === 'turn.submit').length, 1);
  const count = ws.sent.length; f.pcm(); assert.equal(ws.sent.length, count);
  await f.hold(system); assert.equal(f.locationCalls(), 3); await f.release(system);
});

test('legacy server cannot silently degrade push-to-talk to automatic submission', async () => {
  const f = await fixture(); await f.connect({ speech: true });
  await f.firstAnswer(); f.audio.length = 0;
  await f.hold(); assert.deepEqual(f.audio, []);
  assert.match(f.element('status').textContent, /更新后端/);
});

test('paused session resumes only on hold; release before resume never opens microphone', async () => {
  const f = await fixture(); const ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'paused' }) }); await f.flush();
  await f.hold(); assert.equal(ws.sent.at(-2).type, 'resume'); assert.equal(ws.sent.at(-1).type, 'turn.begin');
  await f.release();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) }); await f.flush();
  assert.deepEqual(f.audio, [true, false]);
});

test('locked/background hold forwards PCM; release stops without foregrounding phone', async () => {
  const f = await fixture(0, true); const ws = await f.connect(); await f.hold();
  await f.pagehide(); await f.backgroundExit(); f.pcm();
  assert.ok(ws.sent.at(-1) instanceof Uint8Array);
  await f.release(true); assert.equal(f.audio.at(-1), false);
});

test('device loss, memory reset, mode switch, and disconnect all cancel held capture', async () => {
  for (const reason of ['device', 'memory', 'mode', 'socket']) {
    const f = await fixture(); const ws = await f.connect(); await f.hold();
    if (reason === 'device') { f.device('disconnected'); f.device('connected'); }
    if (reason === 'memory') ws.onmessage({ data: JSON.stringify({ type: 'notice', code: 'MEMORY_CONTEXT_RESET', text: 'reset' }) });
    if (reason === 'mode') ws.onmessage({ data: JSON.stringify({ type: 'access.changed', mode: 'guest', reconnect: true }) });
    if (reason === 'socket') ws.drop();
    await f.flush(); assert.equal(f.audio.at(-1), false);
    const before = ws.sent.length; f.pcm(); await f.release(); assert.equal(ws.sent.length, before);
  }
});


test('cold saved paused launch resumes once; reconnect never re-arms first-turn capture', async () => {
  const f = await fixture(0, true, true);
  const ws = f.sockets[0]; ws.readyState = 1; ws.onopen();
  const ready = { type: 'ready', protocol_version: 2,
    connection_id: '33333333-3333-4333-8333-333333333333', session_id: '22222222-2222-4222-8222-222222222222',
    resumed: true, resume_credential: 'r'.repeat(32), resume_expires_at: Date.now() + 60000,
    snapshot: { state: 'paused', messages: [] }, capabilities: { speech: true, push_to_talk: true, location: true } };
  ws.onmessage({ data: JSON.stringify(ready) }); await f.flush();
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'paused' }) }); await f.flush();
  assert.equal(ws.sent.filter((e: any) => e.type === 'resume').length, 1);
  assert.deepEqual(f.audio, []);
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) }); await f.flush();
  assert.deepEqual(f.audio, [true]); assert.equal(f.locationCalls(), 1);
  await f.firstAnswer(); assert.deepEqual(f.audio, [true, false]);
  ws.drop(); await f.foregroundEnter();
  const next = f.sockets.at(-1); next.readyState = 1; next.onopen();
  next.onmessage({ data: JSON.stringify(ready) });
  next.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening' }) }); await f.flush();
  assert.deepEqual(f.audio, [true, false]); assert.equal(f.locationCalls(), 1);
});

test('missing release is bounded; deadline submits once and late release cannot resubmit', async () => {
  const f = await fixture(); const ws = await f.connect(); await f.firstAnswer();
  await f.hold(); await f.holdTimeout(); await f.release();
  assert.equal(f.audio.at(-1), false);
  assert.equal(ws.sent.filter((e: any) => e.type === 'turn.submit').length, 1);
  const count = ws.sent.length; f.pcm(); assert.equal(ws.sent.length, count);
});
