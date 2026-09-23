import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger } from '../src/cost-ledger.js';
import { openAIPricing, createMeteredOpenAIFetch, requestMaximum } from '../src/metered-openai.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

test('both Luna models receive identical adaptive budgets and reasoning configuration', async () => {
  const seen: any[][] = [];
  for (const model of ['gpt-5.6-luna', 'gpt-6-luna']) {
    const requests: any[] = []; seen.push(requests);
    const base = createHybridDialogue('fake', { OPENAI_DIALOGUE_MODEL: model }, { search: false,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (body.stream) return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
        return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
          decision: 'respond', reasoning_effort: 'high', cognitive_mode: 'deep_reasoning', topic_action: 'continue',
          topic_target: null, topic_label: null, history_query: null }) }] }] });
      } });
    const signal = AbortSignal.timeout(1000);
    const plan = await base.model.plan!([], '分析风险', true, signal);
    assert.equal(plan.reasoningEffort, 'high');
    await base.model.reply([], signal, () => {}, undefined, plan.reasoningEffort, plan.cognitiveMode);
    assert.equal(requests[0].max_output_tokens, 1024);
    assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
    assert.equal(requests[1].max_output_tokens, 16384);
    assert.deepEqual(requests[1].reasoning, { effort: 'high' });
  }
  const normalize = (items: any[]) => items.map(({ model, ...rest }) => ({ ...rest,
    instructions: rest.instructions.replace(/Current UTC time: [^\n]+/g, 'Current time: fixed') }));
  assert.deepEqual(normalize(seen[0]), normalize(seen[1]));
});

test('per-model prices, explicit overrides and long-context reserves are respected', async () => {
  assert.equal(openAIPricing({}, 'gpt-5.6-luna').outputPerMillion, 1.2);
  assert.equal(openAIPricing({}, 'gpt-6-luna').outputPerMillion, 0.5);
  assert.equal(openAIPricing({ OPENAI_OUTPUT_USD_PER_M: '2' }, 'gpt-6-luna').outputPerMillion, 2);
  const root = await mkdtemp(join(tmpdir(), 'luna-pricing-'));
  const ledger = await CostLedger.create(join(root, 'ledger.json'), {});
  const metered = createMeteredOpenAIFetch(ledger, {}, async (_url, init) => Response.json({
    model: JSON.parse(String(init?.body)).model, usage: { input_tokens: 100, output_tokens: 10 }, output: [] }));
  for (const model of ['gpt-5.6-luna', 'gpt-6-luna']) {
    await metered('https://api.openai.com/v1/responses', { body: JSON.stringify({ model, input: 'x'.repeat(100), max_output_tokens: 100 }) });
  }
  for (let n = 0; n < 100; n++) {
    const value = (await ledger.snapshot()).providerUsd.openai;
    if (Math.abs(value - 0.000047) < 1e-9) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(Math.abs((await ledger.snapshot()).providerUsd.openai - 0.000047) < 1e-9);
  const raw = JSON.stringify({ model: 'gpt-6-luna', input: 'a'.repeat(273000), max_output_tokens: 100 });
  assert.equal(requestMaximum(raw, openAIPricing({}, 'gpt-6-luna')), Buffer.byteLength(raw) * 0.2 / 1e6 + 100 * 0.75 / 1e6);
});
