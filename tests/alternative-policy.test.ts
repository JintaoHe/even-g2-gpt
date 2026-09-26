import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { alternativeGuidance, needsLocalVerification, unverifiedAlternativeText } from '../src/alternative-policy.js';
import type { ReplyUpdate, WorkflowSelection } from '../src/conversation.js';

const workflows: WorkflowSelection[] = [{ kind: 'navigation', action: 'fallback_search' }, { kind: 'search', action: 'read' }];
const url = 'https://shop.example/hours';
function fixture(options: { text?: string; source?: string; calls?: boolean; citation?: boolean; complete?: boolean; search?: boolean; quota?: any } = {}) {
  const requests: any[] = [];
  const answer = options.text ?? 'A 店官方资料支持此时提供服务；你可以选它，也可以继续讨论其他时间。';
  const output = [ ...(options.calls === false ? [] : [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: options.source ?? url }] } }]),
    { type: 'message', content: [{ type: 'output_text', text: answer, annotations: options.citation === false ? []
      : [{ type: 'url_citation', url, title: 'Hours', start_index: 0, end_index: 3 }] }] } ];
  const events = [{ type: 'response.output_text.delta', delta: 'UNVERIFIED_STREAM_MUST_NOT_ESCAPE' },
    ...(options.complete === false ? [] : [{ type: 'response.completed', response: { output } }])];
  const model = new OpenAIDialogue('fake', 'test', undefined, options.search ?? true, 2, 'America/Chicago', options.quota,
    { fetcher: (async (_url, init) => { requests.push(JSON.parse(String(init?.body)));
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')); }) as typeof fetch });
  return { model, requests, answer };
}
test('alternative research requires tools and receipt-backed citations before releasing text', async () => {
  const {model,requests,answer}=fixture();let text='';const events:ReplyUpdate[]=[];
  await model.reply([{role:'user',content:'找一家今晚提供晚餐的店'}],new AbortController().signal,t=>text+=t,e=>events.push(e),undefined,undefined,workflows);
  assert.equal(text,answer);assert.equal(requests.length,1);assert.equal(requests[0].tool_choice,'required');
  assert.equal(requests[0].max_tool_calls,2);assert.deepEqual(requests[0].include,['web_search_call.action.sources']);
  assert.match(requests[0].instructions,/official government\/regulator/);assert.match(requests[0].instructions,/Do not delegate verification/);
  assert.ok(events.some(e=>e.type==='answer.citations'));
});

test('simple restaurant reply searches basic facts without strict feasibility policy',async()=>{
  const {model,requests,answer}=fixture();let text='';
  await model.reply([{role:'user',content:'all you can eat sushi'}],new AbortController().signal,t=>text+=t,undefined,undefined,undefined,
    [{kind:'navigation',action:'restaurant_search',searchArea:{source:'requested_area',labels:['Test City']}},{kind:'search',action:'read'}]);
  assert.equal(text,answer);assert.equal(requests[0].tool_choice,'required');
  assert.match(requests[0].instructions,/missing kitchen schedules or exact arrival margins do NOT block/i);
  assert.doesNotMatch(requests[0].instructions,/If the day\/overnight interpretation or kitchen service cannot be established/);
  assert.doesNotMatch(requests[0].instructions,/Present only evidence-supported feasible options/);
  assert.match(requests[0].instructions,/AYCE must have menu\/site evidence/);
});
test('no tool receipt, no citations, or forged citation source cannot become a verified alternative', async () => {
  for(const options of [{calls:false},{citation:false},{source:'https://unrelated.example/'}]){
    const {model}=fixture(options);let text='';const events:ReplyUpdate[]=[];
    await model.reply([],new AbortController().signal,t=>text+=t,e=>events.push(e),undefined,undefined,workflows);
    assert.equal(text,unverifiedAlternativeText);assert.ok(!events.some(e=>e.type==='answer.citations'));
  }
});
test('disabled, quota-denied and opt-out fallback never calls a model or claims verification', async () => {
  for(const [options,query] of [[{search:false},'晚餐'],[{quota:{reserve:async()=>null}},'晚餐'],[{},'不要联网，找附近餐馆']] as const){
    const {model,requests}=fixture(options);let text='';
    await model.reply([{role:'user',content:query}],new AbortController().signal,t=>text+=t,undefined,undefined,undefined,workflows);
    assert.equal(requests.length,0);assert.equal(text,unverifiedAlternativeText);
  }
});
test('incomplete stream and cancellation never deliver buffered alternative claims',async()=>{
  const {model}=fixture({complete:false});let text='';
  await assert.rejects(model.reply([],new AbortController().signal,t=>text+=t,undefined,undefined,undefined,workflows));
  assert.equal(text,'');
  const controller=new AbortController();controller.abort();
  await assert.rejects(model.reply([],controller.signal,t=>text+=t,undefined,undefined,undefined,workflows));assert.equal(text,'');
});
test('shared policy covers reasoning and local feasibility without hardcoded local laws',()=>{
  assert.match(alternativeGuidance,/reasoning plan/);assert.match(alternativeGuidance,/never say "I checked"/);
  assert.match(alternativeGuidance,/Do not hardcode/);assert.match(alternativeGuidance,/timezone is NOT/);
  assert.equal(needsLocalVerification('买啤酒'),true);assert.equal(needsLocalVerification('a liquor store'),true);
  assert.equal(needsLocalVerification('coffee shop'),false);
});

test('only a closed-set clarification may be delivered without supporting sources',async()=>{
  for(const text of ['你想在哪个城市或地区找？','你想在哪个城市或地区找？加油站肯定营业。']){
    const {model}=fixture({text,calls:false,citation:false});let answer='';
    await model.reply([],new AbortController().signal,t=>answer+=t,undefined,undefined,undefined,workflows);
    assert.equal(answer,text.includes('加油站')?unverifiedAlternativeText:text);
  }
});

test('environment fallback uses the same receipt gate and does not undo known hazards',async()=>{
  const {model,requests}=fixture({citation:false});let text='';
  await model.reply([],new AbortController().signal,t=>text+=t,undefined,'medium','planning',
    [{kind:'search',action:'read'},{kind:'environment',action:'fallback_search'}]);
  assert.equal(text,unverifiedAlternativeText);assert.equal(requests[0].tool_choice,'required');
  assert.match(requests[0].instructions,/do not override an unsafe assessment/i);
});
