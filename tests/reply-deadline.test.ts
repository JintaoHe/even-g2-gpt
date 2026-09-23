import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueModel } from '../src/conversation.js';
import { createReplyFallback, type ReplyDiagnostic } from '../src/reply-fallback.js';
import { hybridFirstOutputMs } from '../src/model-profile.js';
import { readConversationStartupConfig } from '../src/conversation-startup-config.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { CostLedger, CostBudgetExceeded } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch } from '../src/metered-openai.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const stub = (reply: DialogueModel['reply']): DialogueModel => ({ decide: async () => 'respond', reply });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const signal = () => new AbortController().signal;
const pending = () => new Promise<void>(() => {});
test('deadline aborts primary, discards even synchronous abort-time output, and retries once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, aborted = false, text = '';
  let late!: () => void; const events: ReplyDiagnostic[] = [];
  const reply = createReplyFallback(stub(async (_h, s, delta, update) => {
    late = () => { delta('late private primary'); update?.({ type: 'answer.citations', text: 'late', citations: [] }); };
    s.addEventListener('abort', () => { aborted = true; late(); });
    await pending(); // Intentionally ignores abort; race must not await this completion.
  }), stub(async (_h, _s, delta) => { calls++; delta('baseline'); }), event => events.push(event), 1000);
  const run = reply([], signal(), s => text += s, undefined, 'low', 'casual', []);
  await flush(); t.mock.timers.tick(999); await flush(); assert.equal(calls, 0);
  t.mock.timers.tick(1); await run;
  assert.equal(aborted, true); assert.equal(calls, 1); assert.equal(text, 'baseline');
  late(); assert.equal(text, 'baseline');
  assert.equal(events.at(-1)?.reason, 'timeout'); assert.equal(typeof events.at(-1)?.elapsedMs, 'number');
});
test('first output atomically disarms deadline; slow primary stream is not cut off', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const statusFirst of [false, true]) {
    let calls = 0, finish!: () => void, first!: () => void, primarySignal!: AbortSignal;
    const reply = createReplyFallback(stub((_h, s, delta, update) => {
      primarySignal = s;
      first = () => statusFirst ? update?.({ type: 'search.status', status: 'working' }) : delta('first');
      return new Promise<void>(resolve => { finish = () => { delta('last'); resolve(); }; });
    }), stub(async () => { calls++; }), undefined, 1000);
    const run = reply([], signal(), () => {}, () => {}, 'low', 'casual', []);
    await flush(); t.mock.timers.tick(999); first(); t.mock.timers.tick(20000); await flush();
    assert.equal(primarySignal.aborted, false); finish(); await run; assert.equal(calls, 0);
  }
});
test('user cancellation wins and suppresses late output even for an abort-ignoring primary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, late!: () => void, text = ''; const controller = new AbortController();
  const reply = createReplyFallback(stub(async (_h, _s, delta) => { late = () => delta('late'); await pending(); }),
    stub(async () => { calls++; }), undefined, 1000);
  const run = reply([], controller.signal, s => text += s, undefined, 'low', 'casual', []);
  const rejected = assert.rejects(run); await flush(); t.mock.timers.tick(999); controller.abort();
  await rejected; t.mock.timers.tick(10000); late(); assert.equal(calls, 0); assert.equal(text, '');
});
test('fallback is outside short deadline and can finish later; failure still has no third attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, finish!: () => void, fallbackSignal!: AbortSignal;
  const reply = createReplyFallback(stub(pending), stub((_h, s, delta) => {
    calls++; fallbackSignal = s; return new Promise<void>(resolve => { finish = () => { delta('done'); resolve(); }; });
  }), undefined, 1000);
  const run = reply([], signal(), () => {}, undefined, 'low', 'casual', []);
  await flush(); t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(10000);
  assert.equal(fallbackSignal.aborted, false); finish(); await run; assert.equal(calls, 1);
});
test('hybrid deadline config defaults and validates before initialization; other profiles ignore it', () => {
  const env = { EVEN_MODEL_PROFILE: 'hybrid-luna' };
  assert.equal(hybridFirstOutputMs(env), 5000);
  for (const value of ['1000', '5000', '20000']) {
    assert.equal(hybridFirstOutputMs({ ...env, EVEN_HYBRID_FIRST_OUTPUT_MS: value }), Number(value));
    assert.doesNotThrow(() => readConversationStartupConfig({ ...env, EVEN_HYBRID_FIRST_OUTPUT_MS: value }));
  }
  for (const value of ['0', '-1', '999', '20001', 'NaN', 'Infinity', '', '1.5', 'abc']) {
    assert.throws(() => readConversationStartupConfig({ ...env, EVEN_HYBRID_FIRST_OUTPUT_MS: value }), /EVEN_HYBRID_FIRST_OUTPUT_MS/);
    assert.throws(() => createHybridDialogue('fake', { ...env, EVEN_HYBRID_FIRST_OUTPUT_MS: value }), /EVEN_HYBRID_FIRST_OUTPUT_MS/);
  }
  for (const profile of ['configured', 'all-5.6']) assert.equal(hybridFirstOutputMs({ EVEN_MODEL_PROFILE: profile, EVEN_HYBRID_FIRST_OUTPUT_MS: 'bad' }), undefined);
});

test('real deadline reaches the second ledger reservation; insufficient budget blocks fallback network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deadline-ledger-'));
  const ledger = await CostLedger.create(join(directory, 'cost.json'), { COST_OPENAI_MONTHLY_USD: '0.004' });
  let calls = 0, primarySignal: AbortSignal | null | undefined;
  const metered = createMeteredOpenAIFetch(ledger, {}, async (_u, init) => {
    calls++; primarySignal = init?.signal; return new Promise<Response>(() => {});
  });
  const events: ReplyDiagnostic[] = [];
  const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: 'hybrid-luna', EVEN_HYBRID_FIRST_OUTPUT_MS: '1000' },
    { fetcher: metered, onReplyDiagnostic: e => events.push(e) });
  const start = performance.now();
  await assert.rejects(model.reply([], signal(), () => {}, undefined, 'low', 'casual', []), CostBudgetExceeded);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 900 && elapsed < 4000, `elapsed=${elapsed}`);
  assert.equal(calls, 1); assert.equal(primarySignal?.aborted, true);
  assert.ok(events.some(e => e.event === 'reply_fallback' && e.reason === 'timeout' && e.elapsedMs! >= 900));
  assert.ok((await ledger.snapshot()).totalUsd <= 0.004);
});

test('configured and all-5.6 keep waiting beyond a configured short deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const profile of ['configured', 'all-5.6']) {
    let finish!: () => void, calls = 0, requestSignal: AbortSignal | null | undefined, text = '';
    const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: profile, EVEN_HYBRID_FIRST_OUTPUT_MS: '1000',
      OPENAI_REPLY_MODEL: 'gpt-6-luna' }, { search: false, fetcher: async (_u, init) => {
      calls++; requestSignal = init?.signal;
      await new Promise<void>(resolve => { finish = resolve; });
      return new Response('data: {"type":"response.output_text.delta","delta":"done"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
    } });
    const run = model.reply([], signal(), s => text += s, undefined, 'low', 'casual', []);
    await flush(); t.mock.timers.tick(20000); await flush();
    assert.equal(requestSignal?.aborted, false); finish(); await run;
    assert.equal(calls, 1); assert.equal(text, 'done');
  }
});
