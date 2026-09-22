import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationStore } from '../src/conversation-store.js';
import { GuestRuntimePool, createGuestRuntimePool } from '../src/guest-runtime.js';
import { lockedDevicePrincipal } from '../src/guest-access.js';
import { presentation } from '../src/document-presentation.js';
import type { DialogueModel, Message, TurnPlan } from '../src/conversation.js';
import type { RouteComparisonResult } from '../src/routes.js';

const document = { markdown: '# Visitor note', presentation: presentation('Visitor note', 'Only this session', 'summary') };
const signal = () => new AbortController().signal;
const model = (plan: TurnPlan = { decision: 'respond' }): DialogueModel => ({
  decide: async () => 'respond', plan: async () => plan, reply: async (_h, _s, delta) => { delta('Hello guest'); },
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-guest-runtime-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const guest = () => {
    const clientId = randomUUID(); store.registerClient({ id: clientId, at: 100 });
    const lock = store.enterDeviceGuestMode({ clientId, at: 101 });
    return { clientId, lock, principal: lockedDevicePrincipal(lock, 'single-user') };
  };
  const commit = (sessionId: string, content: string) => store.commitUserTurn({ sessionId,
    topicId: store.listTopics(sessionId)[0].id, turnId: randomUUID(), messageId: randomUUID(), content, createdAt: Date.now() });
  return { store, root, guest, commit };
}

test('pool reuses one model/runtime per guest and rejects owner and mismatched device before construction', async t => {
  const { store, guest } = await fixture(t); const a = guest(), b = guest(); let created = 0, started = 0;
  const pool = new GuestRuntimePool(store, () => { created++; return {
    model: { ...model(), startSession: () => { started++; } }, generate: async () => ({ document }),
  }; }); t.after(() => pool.close());
  const runtime = pool.acquireAuthenticated(a.clientId, a.principal);
  assert.equal(pool.acquireAuthenticated(a.clientId, a.principal), runtime);
  runtime.model.startSession?.(); runtime.model.startSession?.();
  assert.equal(started, 1); assert.equal(created, 1);
  assert.throws(() => pool.acquireAuthenticated(b.clientId, a.principal), /DENIED/);
  assert.throws(() => pool.acquireAuthenticated(a.clientId, { mode: 'owner', ownerScope: 'single-user' }), /DENIED/);
  assert.notEqual(pool.acquireAuthenticated(b.clientId, b.principal), runtime);
  assert.equal(created, 2);
});

test('model input ignores supplied owner history and reads only bound guest session', async t => {
  const { store, guest, commit } = await fixture(t); const a = guest(), b = guest();
  commit(a.lock.sessionId, 'A public question'); commit(b.lock.sessionId, 'B_PRIVATE');
  const seen: Message[][] = [];
  const pool = new GuestRuntimePool(store, () => ({ model: { ...model(),
    plan: async history => { seen.push(history); return { decision: 'respond' }; },
    reply: async (history, _s, delta) => { seen.push(history); delta('Answer A'); },
  }, generate: async () => ({ document }) })); t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal), s = signal();
  const malicious: Message[] = [{ role: 'assistant', content: 'OWNER_PRIVATE' }];
  await r.model.plan!(malicious, 'Another A question', false, s);
  let output = ''; await r.model.reply(malicious, s, text => { output += text; });
  assert.equal(output, 'Answer A'); assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen), /A public question/); assert.doesNotMatch(JSON.stringify(seen), /PRIVATE/);
});

test('private model plans are denied before Maps, reply or document generation', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  const forbidden: Partial<TurnPlan>[] = [
    { calendarAction: 'query' }, { calendarAction: 'create' }, { deliveryAction: 'calendar' },
    { deliveryAction: 'confirm' }, { deliveryAction: 'not_received' }, { taskAction: 'conditional_task' },
    { workflows: [{ kind: 'memory', action: 'read' }] }, { workflows: [{ kind: 'list', action: 'all' }] },
    { workflows: [{ kind: 'email', action: 'send' }] },
  ];
  for (const privatePlan of forbidden) {
    const pool = new GuestRuntimePool(store, () => ({ model: { ...model({ decision: 'respond',
      locationAction: 'route_eta', routeDestination: 'Museum', routeOrigin: 'Test origin', ...privatePlan }),
      reply: async () => { calls++; } }, generate: async () => { calls++; return { document }; },
      routes: { route: async () => { calls++; throw new Error('must not route'); } } }));
    const runtime = pool.acquireAuthenticated(a.clientId, a.principal), s = signal();
    const plan = await runtime.model.plan!([], 'private request', false, s);
    assert.equal(plan.calendarAction, 'none'); assert.equal(plan.deliveryAction, 'none'); assert.equal(plan.locationAction, 'none');
    let output = ''; await runtime.model.reply([], s, text => { output += text; });
    assert.match(output, /访客模式/); pool.close();
  }
  assert.equal(calls, 0);
});

test('documents preview without send offer and full capacity yields clear feedback without generation', async t => {
  const { store, guest, commit } = await fixture(t); const a = guest(); commit(a.lock.sessionId, '整理访客笔记'); let calls = 0;
  const pool = new GuestRuntimePool(store, () => ({ model: model({ decision: 'respond', deliveryAction: 'document' }),
    generate: async () => { calls++; return { document }; } })); t.after(() => pool.close());
  const runtime = pool.acquireAuthenticated(a.clientId, a.principal);
  const run = async () => { const s = signal(); await runtime.model.plan!([], '整理访客笔记', false, s);
    let output = ''; await runtime.model.reply([], s, text => { output += text; }); return output; };
  const first = await run(); assert.match(first, /已保存本次访客草稿/); assert.doesNotMatch(first, /确认发送|发送到固定/);
  for (let i = 0; i < 7; i++) store.saveGuestDraft(a.principal, document, 102 + i);
  assert.match(await run(), /上限/); assert.equal(calls, 1);
});

test('two reconnect consumers share single-flight before any second generator call', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  let resolve!: (result: { document: typeof document }) => void;
  const pool = new GuestRuntimePool(store, () => ({ model: model({ decision: 'respond', deliveryAction: 'document' }),
    generate: () => { calls++; return new Promise(r => { resolve = r; }); } })); t.after(() => pool.close());
  const one = pool.acquireAuthenticated(a.clientId, a.principal), two = pool.acquireAuthenticated(a.clientId, a.principal);
  const first = signal(), second = signal(); await one.model.plan!([], 'write', false, first); await two.model.plan!([], 'write', false, second);
  const pending = one.model.reply([], first, () => {});
  await assert.rejects(two.model.reply([], second, () => {}), /BUSY/);
  assert.equal(calls, 1); resolve({ document }); await pending;
});

test('unlock stops late answer callbacks and further access, while another guest still works', async t => {
  const { store, guest } = await fixture(t); const a = guest(), b = guest();
  let finish!: () => void, emit!: (s: string) => void;
  const pool = new GuestRuntimePool(store, () => ({ model: { ...model(),
    reply: async (_h, _s, delta) => { emit = delta; await new Promise<void>(r => { finish = r; }); },
  }, generate: async () => ({ document }) })); t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal), s = signal(); await r.model.plan!([], 'hello', false, s);
  let output = ''; const pending = r.model.reply([], s, text => { output += text; });
  store.releaseDeviceGuestLock({ clientId: a.clientId, expected: a.lock, at: Date.now() });
  assert.throws(() => emit('late private result'), /DENIED/); finish(); await assert.rejects(pending, /DENIED/);
  assert.equal(output, ''); assert.throws(() => pool.acquireAuthenticated(a.clientId, a.principal), /DENIED/);
  pool.acquireAuthenticated(b.clientId, b.principal).assertAccess();
});

test('public routes work and one guest location cache is not reused for another guest', async t => {
  const { store, guest } = await fixture(t); const a = guest(), b = guest(); let calls = 0;
  const result: RouteComparisonResult = { query: 'Print shop', candidates: [{ placeId: 'p', name: 'Print shop',
    address: '100 Example St', durationSeconds: 120, distanceMeters: 300, quality: { reliable: false, risk: false } }],
    recommendedPlaceId: 'p', recommendationBasis: 'fastest', mode: 'walk', trafficAware: false };
  const pool = new GuestRuntimePool(store, () => ({ model: model({ decision: 'respond', locationAction: 'route_eta',
    routeDestination: 'Print shop', routeMode: 'walk' }), generate: async () => ({ document }),
    routes: { route: async request => { calls++; assert.equal(request.origin.kind, 'coordinates'); return result; } } }));
  t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal);
  r.acceptLocation({ type: 'location.report', mode: 'continuous', location: { latitude: 40, longitude: -105, accuracy: 10, timestamp: Date.now() } });
  const s = signal(); await r.model.plan!([], 'walk to printer', false, s);
  let output = ''; await r.model.reply([], s, text => { output += text; }); assert.match(output, /Print shop/); assert.equal(calls, 1);
  const other = pool.acquireAuthenticated(b.clientId, b.principal); other.setLocationAvailable(false);
  const second = signal(); await other.model.plan!([], 'walk to printer', false, second);
  let fallback = ''; await other.model.reply([], second, text => { fallback += text; });
  assert.match(fallback, /出发地址/); assert.equal(calls, 1);
});

test('production assembly is API-only, uses supplied fetch, exposes only public search and guest instructions', async t => {
  const { store, root, guest, commit } = await fixture(t); const a = guest(); commit(a.lock.sessionId, '公共博物馆开放日');
  const bodies: any[] = [];
  const request: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (body.stream) return new Response('data: {"type":"response.output_text.delta","delta":"Public answer"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      decision: 'respond', cognitive_mode: 'research', reasoning_effort: 'medium', topic_action: 'continue', topic_target: null,
      topic_label: null, delivery_action: 'none', search_action: 'search',
    }) }] }] });
  };
  const pool = createGuestRuntimePool(store, { OPENAI_API_KEY: 'test-only', DIALOGUE_PROVIDER: 'codex-cli',
    CODEX_CLI_PATH: 'must-never-execute', EVEN_DATA_DIR: root, GOOGLE_CALENDAR_ENABLED: 'true', EVEN_EMAIL_ENABLED: 'true' }, request);
  t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal), s = signal(); r.model.startSession?.();
  const plan = await r.model.plan!([], '查公共博物馆开放日', false, s);
  await r.model.reply([], s, () => {}, undefined, plan.reasoningEffort, plan.cognitiveMode, [{ kind: 'search', action: 'read' }]);
  assert.equal(bodies.length, 2); assert.equal(bodies[0].tools, undefined);
  assert.match(bodies[1].instructions, /You are in guest mode/);
  assert.match(bodies[1].instructions, /Email sending: disabled/);
  assert.match(bodies[1].instructions, /Google Calendar read\/create\/update\/cancel: disabled/);
  assert.ok(bodies[1].tools.length > 0); assert.ok(bodies[1].tools.every((tool: any) => tool.type.startsWith('web_search')));
  assert.ok(bodies.every(body => body.store === false));
  pool.close(); await assert.rejects(r.model.plan!([], 'again', false, signal()), /DENIED/); assert.equal(bodies.length, 2);
});

test('late plan after unlock is rejected; absent API configuration never falls back to CLI', async t => {
  const { store, guest } = await fixture(t); const a = guest();
  assert.throws(() => createGuestRuntimePool(store, { DIALOGUE_PROVIDER: 'codex-cli' }, fetch), /GUEST_API_REQUIRED/);
  assert.throws(() => createGuestRuntimePool(store, { OPENAI_API_KEY: 'test-only' }, undefined as any), /GUEST_API_REQUIRED/);
  let finish!: (plan: TurnPlan) => void;
  const pool = new GuestRuntimePool(store, () => ({ model: { ...model(), plan: () => new Promise(r => { finish = r; }) },
    generate: async () => ({ document }) })); t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal);
  const pending = r.model.plan!([], 'hello', false, signal());
  store.releaseDeviceGuestLock({ clientId: a.clientId, expected: a.lock, at: Date.now() });
  finish({ decision: 'respond' }); await assert.rejects(pending, /DENIED/);
});

test('closing while waiting for GPS cancels the request and never calls Maps', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0; const events: any[] = [];
  const pool = new GuestRuntimePool(store, () => ({ model: model({ decision: 'respond', locationAction: 'route_eta', routeDestination: 'Public library' }),
    generate: async () => ({ document }), routes: { route: async () => { calls++; throw new Error('must not run'); } } }));
  t.after(() => pool.close()); const r = pool.acquireAuthenticated(a.clientId, a.principal); r.setSink(event => events.push(event));
  const s = signal(); await r.model.plan!([], 'library', false, s);
  let output = ''; const pending = r.model.reply([], s, text => { output += text; });
  assert.ok(events.some(e => e.type === 'location.request'));
  pool.release(a.lock.sessionId); await assert.rejects(pending);
  assert.equal(output, ''); assert.equal(calls, 0);
  assert.throws(() => r.acceptLocation({}), /DENIED/);
});

test('public route completing after unlock cannot emit route facts', async t => {
  const { store, guest } = await fixture(t); const a = guest();
  let finish!: (result: RouteComparisonResult) => void;
  const pool = new GuestRuntimePool(store, () => ({ model: model({ decision: 'respond', locationAction: 'route_eta',
    routeDestination: 'Library', routeOrigin: '123 Example Rd' }), generate: async () => ({ document }),
    routes: { route: () => new Promise(r => { finish = r; }) } })); t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal), s = signal(); await r.model.plan!([], 'library', false, s);
  let output = ''; const pending = r.model.reply([], s, text => { output += text; });
  store.releaseDeviceGuestLock({ clientId: a.clientId, expected: a.lock, at: Date.now() });
  finish({ query: 'Library', candidates: [], recommendedPlaceId: '', recommendationBasis: 'fastest', mode: 'walk', trafficAware: false });
  await assert.rejects(pending, /DENIED/); assert.equal(output, '');
});

test('missing plan fails closed and failed model reply does not permanently hold single-flight', async t => {
  const { store, guest } = await fixture(t); const a = guest(); let calls = 0;
  const pool = new GuestRuntimePool(store, () => ({ model: { ...model(), reply: async (_h, _s, delta) => {
    if (++calls === 1) throw new Error('model offline'); delta('Recovered');
  } }, generate: async () => ({ document }) })); t.after(() => pool.close());
  const r = pool.acquireAuthenticated(a.clientId, a.principal);
  await assert.rejects(r.model.reply([], signal(), () => {}), /PLAN_REQUIRED/); assert.equal(calls, 0);
  const first = signal(); await r.model.plan!([], 'hello', false, first);
  await assert.rejects(r.model.reply([], first, () => {}), /model offline/);
  const second = signal(); await r.model.plan!([], 'hello', false, second);
  let output = ''; await r.model.reply([], second, text => { output += text; }); assert.equal(output, 'Recovered');
});
