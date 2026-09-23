import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

test('hybrid routes intent without tools to mini and reply/search to nano; rollback is explicit', async () => {
  const bodies: any[] = []; let settled: number | undefined;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (!body.stream) {
      const adaptive = Boolean(body.text?.format?.schema?.properties?.cognitive_mode);
      const classification = adaptive
        ? { decision: 'respond', reasoning_effort: 'low', cognitive_mode: 'research', search_action: 'search',
          topic_action: 'continue', topic_target: null, topic_label: 'test' }
        : { decision: 'respond', search_action: 'search' };
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...classification, history_query: null }) }] }] }));
    }
    else res.end('data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    const quota = { reserve: async () => ({ limit: 1, settle: async (n: number) => { settled = n; } }) };
    const { model, models } = createHybridDialogue('fake', { OPENAI_INTENT_MODEL: 'gpt-4.1-mini', OPENAI_REPLY_MODEL: 'gpt-5-nano' }, { endpoint, quota });
    assert.deepEqual(models, { intent: 'gpt-4.1-mini', reply: 'gpt-5-nano' });
    assert.deepEqual(createHybridDialogue('fake', {}, { endpoint, quota }).models,
      { intent: 'gpt-5.6-luna', reply: 'gpt-5.6-luna' });
    const history = [{ role: 'user' as const, content: 'hello' }], signal = new AbortController().signal;
    await model.decide(history, 'hello', false, signal);
    let answer = ''; await model.reply(history, signal, text => { answer += text; });
    assert.equal(answer, 'hello'); assert.equal(settled, 0);
    assert.equal(bodies[0].model, 'gpt-4.1-mini'); assert.equal(bodies[0].tools, undefined);
    assert.equal(bodies[0].reasoning, undefined); assert.equal(bodies[0].max_output_tokens, 512);
    assert.equal(bodies[1].model, 'gpt-5-nano'); assert.deepEqual(bodies[1].reasoning, { effort: 'low' });
    assert.equal(bodies[1].max_output_tokens, 3072); assert.equal(bodies[1].max_tool_calls, 1);
    assert.equal(bodies[1].tool_choice, 'auto'); assert.match(bodies[1].instructions, /Your name is Even/);
    const rollback = createHybridDialogue('fake', { OPENAI_REPLY_MODEL: 'gpt-4.1-mini' }, { endpoint, search: false, quota });
    await rollback.model.reply([], signal, () => {});
    assert.equal(bodies[2].model, 'gpt-4.1-mini'); assert.equal(bodies[2].reasoning, undefined);
    assert.equal(bodies[2].tools, undefined); assert.equal(bodies[2].max_output_tokens, 1400);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(model.reply([], aborted.signal, () => {})); assert.equal(bodies.length, 3);
    const luna = createHybridDialogue('fake', { OPENAI_INTENT_MODEL: 'gpt-5.6-luna', OPENAI_REPLY_MODEL: 'gpt-5.6-luna' }, { endpoint, quota });
    await luna.model.decide([], 'hello', false, signal); await luna.model.reply([], signal, () => {});
    assert.equal(bodies[3].model, 'gpt-5.6-luna'); assert.equal(bodies[3].max_output_tokens, 1024);
    assert.deepEqual(bodies[3].reasoning, { effort: 'medium' }); assert.equal(bodies[3].tools, undefined);
    assert.equal(bodies[4].model, 'gpt-5.6-luna'); assert.equal(bodies[4].max_output_tokens, 4096);
    assert.deepEqual(bodies[4].reasoning, { effort: 'low' }); assert.equal(bodies[4].max_tool_calls, 1);
    const capable = createHybridDialogue('fake', { OPENAI_WEB_SEARCH: 'false', GOOGLE_CALENDAR_ENABLED: 'true',
      GOOGLE_MAPS_ENABLED: 'true', EVEN_DELIVERY_ROUTING: 'true', EVEN_EMAIL_ENABLED: 'true' }, { endpoint, quota });
    await capable.model.reply([], signal, () => {});
    assert.match(bodies[5].instructions, /Google Calendar read\/create\/update\/cancel: enabled/);
    assert.match(bodies[5].instructions, /Markdown\/document drafting: enabled/);
    assert.match(bodies[5].instructions, /do NOT stream the long-form body onto the glasses/);
    assert.match(bodies[5].instructions, /需要我把完整内容整理成 Markdown 文件吗/);
    assert.match(bodies[5].instructions, /Email sending: enabled/);
    assert.match(bodies[5].instructions, /Current-location and route tools: enabled/);
    assert.doesNotMatch(bodies[5].instructions, /NO calendar/);
    const retiredConditional = createHybridDialogue('fake', { EVEN_CONDITIONAL_TASKS_ENABLED: 'true' }, { endpoint, search: false, quota });
    await retiredConditional.model.plan!([], '明天规划一个户外活动', true, signal);
    assert.equal(bodies[6].text.format.schema.properties.task_action, undefined);
    assert.doesNotMatch(bodies[6].instructions, /classify supported multi-step conditional assistant tasks/);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
