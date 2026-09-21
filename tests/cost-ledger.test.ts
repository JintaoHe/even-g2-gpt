import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostBudgetExceeded, CostLedger, type CostAlert } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch } from '../src/metered-openai.js';

const path = async () => join(await mkdtemp(join(tmpdir(), 'even-cost-')), 'cost-ledger.json');

test('recovery affordability is read-only and still enforced by the real reservation', async () => {
  const file = await path(), ledger = await CostLedger.create(file, env());
  const before = await readFile(file, 'utf8');
  assert.equal(ledger.canReserve('openai', 1), true);
  assert.equal(ledger.canReserve('openai', 51), false);
  assert.equal(ledger.canReserve('openai', NaN), false);
  assert.equal(await readFile(file, 'utf8'), before);
  const ticket = await ledger.reserve('openai', 50);
  assert.equal(ledger.canReserve('openai', 0.01), false);
  await assert.rejects(ledger.reserve('openai', 0.01), CostBudgetExceeded);
  await ticket.settle(0);
  assert.equal(ledger.canReserve('openai', 0.01), true);
  (ledger as any).persistenceFailed = true;
  assert.equal(ledger.canReserve('openai', 0.01), false);
});

test('a failed durable write prevents this and subsequent provider calls until restart', async () => {
  const file = await path(), ledger = await CostLedger.create(file, env());
  const before = await readFile(file, 'utf8');
  // Inject at the durable boundary, not at the provider, to exercise fail-closed queuing.
  (ledger as any).persist = async () => { throw Object.assign(new Error(), { code: 'EPERM' }); };
  let calls = 0;
  const fetcher = createMeteredOpenAIFetch(ledger, env(), async () => { calls++; return new Response('{}'); });
  const request = { method: 'POST', body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'test', max_output_tokens: 100 }) };
  await assert.rejects(fetcher('https://api.openai.com/v1/responses', request), /COST_LEDGER_UNAVAILABLE/);
  await assert.rejects(ledger.reserve('google', 0.01), /COST_LEDGER_UNAVAILABLE/);
  assert.equal(calls, 0); assert.equal(await readFile(file, 'utf8'), before);
});
const env = (values: Record<string, string> = {}) => ({
  COST_TOTAL_MONTHLY_USD: '80', COST_OPENAI_MONTHLY_USD: '50', COST_SONIOX_MONTHLY_USD: '20', COST_GOOGLE_MONTHLY_USD: '10', ...values
}) as NodeJS.ProcessEnv;
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 50 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(condition(), true);
};

test('cross-provider monthly hard caps persist reservations and use a shared total', async () => {
  const file = await path();
  const ledger = await CostLedger.create(file, env({ COST_TOTAL_MONTHLY_USD: '1', COST_OPENAI_MONTHLY_USD: '0.5',
    COST_SONIOX_MONTHLY_USD: '0.3', COST_GOOGLE_MONTHLY_USD: '0.2' }), undefined,
    { now: () => new Date('2026-09-15T12:00:00Z') });
  const openai = await ledger.reserve('openai', 0.5), soniox = await ledger.reserve('soniox', 0.3);
  await assert.rejects(ledger.reserve('soniox', 0.01), error => error instanceof CostBudgetExceeded && error.provider === 'soniox');
  await openai.settle(0.25);
  const google = await ledger.reserve('google', 0.2);
  await assert.rejects(ledger.reserve('openai', 0.26), error => error instanceof CostBudgetExceeded && error.provider === 'openai');
  await soniox.settle(0.1); await google.settle(0.05);
  const restarted = await CostLedger.create(file, env({ COST_TOTAL_MONTHLY_USD: '1', COST_OPENAI_MONTHLY_USD: '0.5',
    COST_SONIOX_MONTHLY_USD: '0.3', COST_GOOGLE_MONTHLY_USD: '0.2' }), undefined,
    { now: () => new Date('2026-09-15T12:00:00Z') });
  const snapshot = await restarted.snapshot();
  assert.deepEqual(snapshot.providerUsd, { openai: 0.25, soniox: 0.1, google: 0.05 });
  assert.equal(snapshot.totalUsd, 0.4);
  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /api[_-]?key|latitude|transcript/i);
});

test('Google free-SKU alerts are durable, one-shot and reset at Pacific month boundary', async () => {
  const file = await path(), alerts: CostAlert[] = [];
  let now = new Date('2026-10-01T06:59:59Z'); // September 30, 23:59:59 PDT.
  const ledger = await CostLedger.create(file, env(), async alert => { alerts.push(alert); return 'accepted'; }, { now: () => now });
  const first = await ledger.reserveGoogle('places-text-search-enterprise', 500); await first.settle(500);
  await until(() => alerts.length === 1);
  assert.deepEqual(alerts.map(value => [value.period, value.threshold]), [['2026-09', 50]]);
  const second = await ledger.reserveGoogle('places-text-search-enterprise', 450); await second.settle(450);
  await until(() => alerts.length === 2);
  assert.deepEqual(alerts.map(value => value.threshold), [50, 95]);
  const weather = await ledger.reserveGoogle('weather', 5_000); await weather.settle(5_000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alerts.length, 2, 'other SKUs do not notify at 50%');
  now = new Date('2026-10-01T07:00:00Z');
  const october = await ledger.reserveGoogle('places-text-search-enterprise', 500); await october.settle(500);
  await until(() => alerts.length === 3);
  assert.deepEqual(alerts[2] && [alerts[2].period, alerts[2].threshold], ['2026-10', 50]);
});

test('metered OpenAI fetch settles Responses usage and search calls without storing content', async () => {
  const file = await path();
  const ledger = await CostLedger.create(file, env(), undefined, { now: () => new Date('2026-09-15T12:00:00Z') });
  const metered = createMeteredOpenAIFetch(ledger, env(), async () => new Response(JSON.stringify({
    usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500 },
    output: [{ type: 'web_search_call' }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await metered('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({
    model: 'gpt-5.6-luna', input: 'private words must not persist', max_output_tokens: 1_000,
    tools: [{ type: 'web_search' }], max_tool_calls: 2
  }) });
  let snapshot = await ledger.snapshot();
  for (let i = 0; i < 50 && snapshot.providerUsd.openai > 0.011; i++) {
    await new Promise(resolve => setTimeout(resolve, 5)); snapshot = await ledger.snapshot();
  }
  assert.ok(Math.abs(snapshot.providerUsd.openai - 0.010764) < 0.00000001);
  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /private words|gpt-5\.6-luna|web_search/);
});

test('metered OpenAI fetch emits metadata-only provider outcomes', async () => {
  const ledger = await CostLedger.create(await path(), env());
  const observations: unknown[][] = [];
  const metered = createMeteredOpenAIFetch(ledger, env(),
    async () => new Response('{"private":"provider prose"}', { status: 503 }),
    (...args) => { observations.push(args); });
  const response = await metered('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0], 'openai');
  assert.equal(observations[0][1], 'failure');
  assert.equal(typeof observations[0][2], 'number');
  assert.doesNotMatch(JSON.stringify(observations), /provider prose/);
});
