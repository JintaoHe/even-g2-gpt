import test from 'node:test';
import assert from 'node:assert/strict';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { Conversation } from '../src/conversation.js';

const completed = () => new Response('data: {"type":"response.output_text.delta","delta":"baseline"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
const quotaCodes = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'];
test('429 quota code wins regardless of type; transient and unclassified 429/503 still retry once', async () => {
  const cases: { status: number; type?: string; code?: string; retry: boolean }[] = [
    ...quotaCodes.flatMap(code => ['rate_limit_error', 'insufficient_quota', undefined].map(type => ({ status: 429, type, code, retry: false }))),
    { status: 429, type: 'insufficient_quota', retry: false },
    ...['rate_limit_exceeded', 'slow_down', 'unclassified'].map(code => ({ status: 429, type: 'rate_limit_error', code, retry: true })),
    { status: 429, retry: true }, { status: 503, type: 'service_unavailable_error', code: 'server_is_overloaded', retry: true },
    { status: 401, retry: false }, { status: 403, retry: false },
    { status: 404, code: 'model_not_found', retry: true }, { status: 400, code: 'content_policy_violation', retry: false },
  ];
  for (const row of cases) {
    const models: string[] = [];
    const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: 'hybrid-luna' }, { onReplyDiagnostic: () => {}, fetcher: async (_u, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return models.length === 1 ? Response.json({ error: { type: row.type, code: row.code } }, { status: row.status }) : completed();
    } });
    const run = model.reply([], new AbortController().signal, () => {}, undefined, 'low', 'casual', []);
    if (row.retry) await run; else await assert.rejects(run);
    assert.deepEqual(models, row.retry ? ['gpt-6-luna', 'gpt-5.6-luna'] : ['gpt-6-luna'], JSON.stringify(row));
  }
});
test('fallback receiving quota failure ends with MODEL_FAILED and never makes a third reply request', async () => {
  let replyCalls = 0; const events: any[] = [];
  const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: 'hybrid-luna' }, { onReplyDiagnostic: () => {}, fetcher: async (_u, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      decision: 'respond', cognitive_mode: 'casual', reasoning_effort: 'low', search_action: 'none',
      topic_action: 'continue', topic_target: null, topic_label: null, history_query: null }) }] }] });
    replyCalls++;
    return Response.json({ error: { type: 'rate_limit_error', code: replyCalls === 1 ? 'slow_down' : 'project_spend_limit_exceeded' } }, { status: 429 });
  } });
  const conversation = new Conversation(model, event => events.push(event));
  await conversation.submit('嗨，今天精神不错。', true);
  assert.equal(replyCalls, 2); assert.equal(conversation.state, 'paused');
  assert.ok(events.some(e => e.type === 'error' && e.code === 'MODEL_FAILED'));
});
