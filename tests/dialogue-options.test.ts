import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIDialogue } from '../src/dialogue-model.js';

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
    assert.match(bodies[3].instructions, /hard maximum of 120 Chinese characters or 60 English words/);
    assert.ok(bodies.every(b => b.tools === undefined));
    assert.throws(() => new OpenAIDialogue('fake', 'test', url, false, 1, 'America/Chicago', undefined, { intentTokens: -1 }));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
