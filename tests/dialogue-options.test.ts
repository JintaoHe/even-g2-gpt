import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIDialogue } from '../src/dialogue-model.js';

test('venue evidence rules reach ordinary, analysis and fallback replies without censoring qualified statements', async () => {
  for (const workflows of [[], [{ kind: 'navigation' as const, action: 'analyze_places' }],
    [{ kind: 'navigation' as const, action: 'fallback_search' }]]) {
    const text = '建议 Juniper，车程短；供餐及安静程度未确认。';
    const model = new OpenAIDialogue('fake', 'test', 'https://example.invalid', false, 1, 'America/Chicago', undefined, {
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.match(body.instructions, /follow-ups, comparisons and search fallbacks/);
        assert.match(body.instructions, /explicit retrieved source support them/);
        assert.match(body.instructions, /Missing food\/atmosphere evidence means unverified, not false/);
        return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`);
      }
    });
    let answer = '';
    await model.reply([{ role: 'user', content: '只用已有资料，替同事选一家面试前能坐的地方。' }], new AbortController().signal,
      value => { answer += value; }, undefined, 'low', 'decision_support', workflows);
    assert.equal(answer, text);
  }
});

test('opt-in reasoning profile adjusts budgets without changing default requests', async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (!body.stream) res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"decision":"respond"}' }] }] }));
    else res.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`, signal = new AbortController().signal;
    for (const options of [undefined, { reasoningEffort: 'low' as const, intentTokens: 2048, replyTokens: 3072, extraInstructions: 'Keep Even unchanged.' }]) {
      const model = new OpenAIDialogue('fake', 'test', url, false, 1, 'America/Chicago', undefined, options);
      await model.decide([], 'hello', false, signal); await model.reply([], signal, () => {});
    }
    assert.equal(bodies[0].reasoning, undefined); assert.equal(bodies[0].max_output_tokens, 128);
    assert.equal(bodies[1].max_output_tokens, 1400); assert.equal(bodies[1].reasoning, undefined);
    assert.deepEqual(bodies[2].reasoning, { effort: 'low' }); assert.equal(bodies[2].max_output_tokens, 2048);
    assert.equal(bodies[3].max_output_tokens, 3072); assert.match(bodies[3].instructions, /Keep Even unchanged/);
    assert.match(bodies[3].instructions, /five-line glasses display/);
    assert.match(bodies[3].instructions, /user preferences are requirements, not verified venue facts/);
    assert.match(bodies[3].instructions, /Missing priceLevel means price is unknown/);
    assert.match(bodies[3].instructions, /hard maximum of 120 Chinese characters or 60 English words/);
    assert.ok(bodies.every(b => b.tools === undefined));
    assert.throws(() => new OpenAIDialogue('fake', 'test', url, false, 1, 'America/Chicago', undefined, { intentTokens: -1 }));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
