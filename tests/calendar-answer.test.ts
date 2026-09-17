import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarAnswerer, detailsFallback, wantsCalendarDetails } from '../src/calendar-answer.js';
const facts = { title: '测试', notes: '计划邀请sales；进行TypeScript code review。', attendees: [{ name: 'Luke', email: 'luke@example.com', status: 'accepted' }], incomplete: false };
test('details answer is bounded and grounded in fresh facts, no tool access or prior conversation invention', async () => {
  let body: any;
  const answer = createCalendarAnswerer({ OPENAI_API_KEY: 'fake', OPENAI_INTENT_MODEL: 'configured' }, (async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answer: '备注计划邀请sales，但无法确认是否参加。建议向组织者核实。' }) }] }] }));
  }) as typeof fetch);
  assert.match(await answer('sales会到场吗', facts, new AbortController().signal), /无法确认/);
  assert.equal(body.model, 'configured'); assert.equal(body.store, false); assert.equal(body.tools, undefined);
  assert.deepEqual(JSON.parse(body.input[0].content).googleEvent, facts);
  assert.match(body.instructions, /untrusted/); assert.match(body.instructions, /Never infer department/);
});
test('details mode recognizes attendance questions; API failure gives a labelled cautious fallback', async () => {
  assert.ok(wantsCalendarDetails('这个会议calendar里面有什么补充信息吗？sales会到场吗？'));
  const answer = createCalendarAnswerer({}, (async () => { throw Error('unexpected'); }) as typeof fetch);
  assert.equal(await answer('谁参加', facts, new AbortController().signal), detailsFallback(facts));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(answer('谁参加', facts, abort.signal));
});
