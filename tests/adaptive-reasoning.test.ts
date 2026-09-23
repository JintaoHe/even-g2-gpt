import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Conversation, type TurnPlan } from '../src/conversation.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { safeReasoning } from '../src/dialogue-model.js';

test('adaptive conversation uses one classification and one reply, validates levels and preserves rollback', async () => {
  const bodies: any[] = []; let classification: any = {};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (!body.stream) res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...classification, history_query: null }) }] }] }));
    else res.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    const { model } = createHybridDialogue('fake', {}, { endpoint, search: false });
    const events: any[] = [], conversation = new Conversation(model, e => events.push(e));
    for (const [value, expected, budget] of [['high', 'high', 16384], ['medium', 'medium', 8192], ['low', 'low', 4096], ['none', 'low', 4096], ['max', 'low', 4096], [undefined, 'low', 4096]] as const) {
      const assistantMode = expected === 'high' ? 'deep_reasoning' : expected === 'medium' ? 'planning' : 'casual';
      classification = { decision: 'respond', reasoning_effort: value, cognitive_mode: assistantMode,
        topic_action: 'continue', topic_target: null, topic_label: 'test' };
      const before = bodies.length;
      await conversation.submit('test');
      assert.equal(conversation.state, 'listening');
      assert.equal(bodies.length - before, 2);
      const [intent, reply] = bodies.slice(-2);
      assert.deepEqual(intent.reasoning, { effort: 'medium' });
      assert.deepEqual(intent.text.format.schema.required,
        ['decision', 'reasoning_effort', 'cognitive_mode', 'topic_action', 'topic_target', 'topic_label', 'history_query']);
      assert.match(intent.instructions, /Quoted, negated/);
      assert.match(intent.instructions, /exceptionally difficult multi-stage reasoning/);
      assert.match(reply.instructions, /warm, capable personal assistant/);
      assert.match(reply.instructions, /thanks, praises, or expresses satisfaction/);
      assert.match(reply.instructions, /Warm companionship is a conversation style/);
      assert.match(reply.instructions, /120–220 Chinese characters/);
      assert.deepEqual(reply.reasoning, { effort: expected });
      assert.equal(reply.max_output_tokens, budget);
      assert.equal(events.filter(e => e.type === 'answer.start').at(-1).reasoningEffort, expected);
      assert.equal(events.filter(e => e.type === 'answer.start').at(-1).assistantMode, assistantMode);
    }
    for (const decision of ['wait', 'clarify_exit', 'exit']) {
      const fresh = new Conversation(model, () => {}), before = bodies.length;
      classification = { decision, reasoning_effort: 'medium', cognitive_mode: 'casual',
        topic_action: 'continue', topic_target: null, topic_label: 'test' };
      await fresh.submit('test');
      assert.equal(bodies.length - before, 1); // No answer API for control decisions.
    }
    const rollback = createHybridDialogue('fake', { OPENAI_DIALOGUE_MODEL: 'gpt-4.1-mini' }, { endpoint, search: false });
    classification = { decision: 'respond' };
    await new Conversation(rollback.model, () => {}).submit('test');
    assert.equal(bodies.at(-1).reasoning, undefined);
    assert.deepEqual(bodies.at(-2).text.format.schema.required, ['decision', 'history_query']);
    assert.equal(safeReasoning(null), 'low');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('a late cancelled plan cannot leak its effort into the next turn', async () => {
  let resolve!: (plan: TurnPlan) => void;
  let count = 0; const efforts: unknown[] = [];
  const conversation = new Conversation({
    decide: async () => { throw new Error('Must reuse plan, not call decide again'); },
    plan: async () => ++count === 1 ? new Promise<TurnPlan>(r => { resolve = r; }) : { decision: 'respond', reasoningEffort: 'low' },
    reply: async (_h, _s, delta, _u, effort) => { efforts.push(effort); delta('ok'); }
  }, () => {});
  const old = conversation.submit('深入分析');
  conversation.interrupt();
  await conversation.submit('你好');
  resolve({ decision: 'respond', reasoningEffort: 'medium' }); await old;
  assert.deepEqual(efforts, ['low']);
});
