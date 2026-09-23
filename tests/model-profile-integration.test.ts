import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { CostLedger, CostBudgetExceeded } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch } from '../src/metered-openai.js';
import { PartialReplyError } from '../src/reply-fallback.js';
import { Conversation, normalizeTurnPlan } from '../src/conversation.js';

const history = [{ role: 'user' as const, content: '为什么彩虹会弯曲？' }];
const completed = (text = '观察角度形成了圆弧。') => new Response(
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
  + 'data: {"type":"response.completed","response":{"output":[]}}\n\n');
function setup(fetcher: typeof fetch, profile = 'hybrid-luna') {
  return createHybridDialogue('fake', { EVEN_MODEL_PROFILE: profile, OPENAI_REPLY_MODEL: 'ignored', OPENAI_INTENT_MODEL: 'ignored' },
    { fetcher, onReplyDiagnostic: () => {}, quota: { reserve: async () => ({ limit: 1, settle: async () => {} }) } });
}
test('hybrid uses 6 only for classified ordinary replies; rollback uses 5.6 with identical capabilities', async () => {
  const bodies: any[] = [];
  const fetcher: typeof fetch = async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return completed(); };
  const hybrid = setup(fetcher), signal = new AbortController().signal;
  await hybrid.model.reply(history, signal, () => {}, undefined, 'low', 'explain', []);
  await hybrid.model.reply(history, signal, () => {}, undefined, 'high', 'deep_reasoning', []);
  await hybrid.model.reply(history, signal, () => {}, undefined, 'low', 'research', [{ kind: 'search', action: 'read' }]);
  await setup(fetcher, 'all-5.6').model.reply(history, signal, () => {}, undefined, 'low', 'casual', []);
  assert.deepEqual(bodies.map(b => b.model), ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna']);
  assert.equal(bodies[0].tools, undefined); assert.equal(bodies[2].tools[0].type, 'web_search');
  assert.deepEqual(hybrid.models, { intent: 'gpt-5.6-luna', reply: 'gpt-5.6-luna' });
});
test('transient HTTP/empty/malformed response retries exactly once, no tools or replanning', async () => {
  for (const response of [() => new Response('', { status: 503 }), () => completed(''), () => new Response('data: INVALID\n\n')]) {
    const bodies: any[] = []; let result = '';
    const { model } = setup(async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? response() : completed(); });
    await model.reply(history, new AbortController().signal, t => result += t, undefined, 'low', 'explain', []);
    assert.deepEqual(bodies.map(b => b.model), ['gpt-6-luna', 'gpt-5.6-luna']);
    assert.equal(result, '观察角度形成了圆弧。');
    assert.ok(bodies.every(b => !b.tools && b.stream)); assert.deepEqual(bodies[0].input, bodies[1].input);
  }
});
test('authentication, policy refusal and caller cancellation do not trigger fallback', async () => {
  for (const kind of ['auth', 'refusal', 'cancel']) {
    let calls = 0; const controller = new AbortController();
    const { model } = setup(async () => { calls++;
      if (kind === 'auth') return new Response('', { status: 401 });
      if (kind === 'cancel') { controller.abort(); throw new TypeError('fetch failed'); }
      return new Response('data: {"type":"response.completed","response":{"output":[{"content":[{"type":"refusal","refusal":"No"}]}]}}\n\n');
    });
    await assert.rejects(model.reply(history, controller.signal, () => {}, undefined, 'low', 'casual', []));
    assert.equal(calls, 1);
  }
});
test('partial stream offers retry without another provider call; explicit retry never creates tool plan', async () => {
  let calls = 0;
  const { model } = setup(async () => { calls++; return new Response('data: {"type":"response.output_text.delta","delta":"部分"}\n\n'); });
  await assert.rejects(model.reply(history, new AbortController().signal, () => {}, undefined, 'low', 'casual', []), PartialReplyError);
  assert.equal(calls, 1);
  const plan = normalizeTurnPlan(await model.plan!(history, '请用5.6重新回答', true, new AbortController().signal));
  assert.deepEqual(plan.workflows, []); assert.equal(calls, 1);
});
test('fallback goes through the real ledger: budget denial prevents the second network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-budget-'));
  // Enough for one 6 request, not for the 5.6 fallback maximum.
  const ledger = await CostLedger.create(join(root, 'ledger.json'), { COST_OPENAI_MONTHLY_USD: '0.004' });
  let calls = 0;
  const metered = createMeteredOpenAIFetch(ledger, {}, async () => { calls++; return new Response('', { status: 503 }); });
  const { model } = setup(metered);
  await assert.rejects(model.reply(history, new AbortController().signal, () => {}, undefined, 'low', 'casual', []), CostBudgetExceeded);
  assert.equal(calls, 1);
  assert.ok((await ledger.snapshot()).totalUsd <= 0.004);
});

test('unknown provider exception retries through metering, but unknown local guard failure does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-unknown-'));
  const ledger = await CostLedger.create(join(root, 'ledger.json'), {});
  let calls = 0;
  const metered = createMeteredOpenAIFetch(ledger, {}, async () => {
    if (++calls === 1) throw new Error('unclassified transport failure');
    return completed();
  });
  let text = '';
  await setup(metered).model.reply(history, new AbortController().signal, t => text += t, undefined, 'low', 'casual', []);
  assert.equal(calls, 2); assert.ok(text);
  assert.ok((await ledger.snapshot()).totalUsd > 0); // Both attempts reserved, unknown usage retained.
  const guarded: typeof fetch = async () => { throw Error('unclassified local database failure'); };
  await assert.rejects(setup(guarded).model.reply(history, new AbortController().signal, () => {}, undefined, 'low', 'casual', []), /database/);
  assert.equal(calls, 2);
});

test('unknown remote errors retry, explicit remote policy/quota refusals do not', async () => {
  for (const code of ['unrecognized_provider_failure', 'invalid_prompt', 'content_policy_violation', 'insufficient_quota']) {
    let calls = 0;
    const { model } = setup(async () => ++calls === 1 ? Response.json({ error: { code } }, { status: 400 }) : completed());
    const run = model.reply(history, new AbortController().signal, () => {}, undefined, 'low', 'explain', []);
    if (code === 'content_policy_violation' || code === 'insufficient_quota') {
      await assert.rejects(run); assert.equal(calls, 1);
    } else { await run; assert.equal(calls, 2); }
  }
});

test('guest guard runs again before fallback and prevents a second network call after revocation', async () => {
  let authorized = true, network = 0, guards = 0;
  const { model } = setup(async () => {
    guards++;
    if (!authorized) throw new Error('GUEST_ACCESS_DENIED');
    network++; authorized = false; return new Response('', { status: 503 });
  });
  await assert.rejects(model.reply(history, new AbortController().signal, () => {}, undefined, 'low', 'casual', []), /GUEST_ACCESS_DENIED/);
  assert.equal(guards, 2); assert.equal(network, 1);
});

test('partial failure pauses without committing an answer, explicit 5.6 retry sees original question', async () => {
  const seen: any[] = [], events: any[] = [];
  const { model } = setup(async (_u, init) => {
    const body = JSON.parse(String(init?.body)); seen.push(body);
    if (!body.stream) return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      decision: 'respond', reasoning_effort: 'low', cognitive_mode: 'explain', topic_action: 'continue', topic_target: null,
      topic_label: null, search_action: 'none', history_query: null }) }] }] });
    return body.model === 'gpt-6-luna'
      ? new Response('data: {"type":"response.output_text.delta","delta":"部分答案"}\n\n') : completed();
  });
  const conversation = new Conversation(model, event => events.push(event));
  await conversation.submit(history[0].content, true);
  assert.equal(conversation.state, 'paused');
  assert.ok(events.some(e => e.type === 'notice' && e.code === 'PARTIAL_REPLY_RETRY_REQUIRED'));
  assert.equal(events.some(e => e.type === 'answer.done'), false);
  conversation.resume();
  await conversation.submit('用5.6重新回答', true);
  assert.equal(conversation.state, 'listening');
  assert.equal(seen.at(-1).model, 'gpt-5.6-luna'); assert.equal(seen.at(-1).tools, undefined);
  assert.match(JSON.stringify(seen.at(-1).input), /为什么彩虹/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1).input), /用5\.6重新回答|部分答案/);
  assert.match(seen.at(-1).input.at(-1).content, /为什么彩虹会弯曲？$/);
  assert.ok(events.some(e => e.type === 'answer.done'));
});
