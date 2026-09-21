import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftGenerator, safePartialBody } from '../src/delivery-draft.js';
import { mailPresentation } from '../src/document-presentation.js';

const output = (text: string, status = 'completed') => ({ status, incomplete_details: { reason: 'max_output_tokens' },
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const plan = { clarification: '', title: 'Cedar Lantern', summary: '建议方案，未经实施。', calendar: null,
  length: { unit: 'characters', minimum: 6000, maximum: 8000 },
  sections: Array.from({ length: 6 }, (_, i) => ({ heading: `章节${i+1}`, brief: '保留 LIB-7042；说明实施与风险。', targetUnits: 1100 })) };

test('six sections receive explicit allocations and share first/closing token budget', async () => {
  const calls: any[] = [];
  const generate = createDraftGenerator({ OPENAI_API_KEY: 'fake' }, async (_url, init) => {
    const b = JSON.parse(init!.body as string); calls.push(b);
    return Response.json(calls.length === 1 ? output(JSON.stringify(plan)) : /Continue ONLY/.test(b.instructions) ? output('结束。') : output('开始。', 'incomplete'));
  });
  await generate([{role:'user',content:'六千至八千字。'}], 'document', undefined, new AbortController().signal);
  const first = calls.filter(b => /Write only the complete/.test(b.instructions));
  const closing = calls.filter(b => /Continue ONLY/.test(b.instructions));
  assert.equal(first.length,6); assert.equal(closing.length,6);
  assert.equal(first[0].max_output_tokens + closing[0].max_output_tokens,3500);
  assert.match(first[0].instructions,/targeting 1100/);
  assert.equal(first[0].text.verbosity,'high');
  assert.match(closing[0].instructions,/Do not open a new subsection or code block/);
});

test('plan rejects allocations outside total length before generating any section', async () => {
  let calls=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async()=> { calls++; return Response.json(output(JSON.stringify({...plan,sections:plan.sections.map(s=>({...s,targetUnits:3000}))}))); });
  await assert.rejects(generate([], 'document', undefined,new AbortController().signal),/DRAFT_INVALID/);
  assert.equal(calls,1);
});

test('short complete prose is retained verbatim and extended once, not rewritten', async () => {
  const original = '原始决定不可改变。'.repeat(10);
  const additional = '补充验收条件。'.repeat(10);
  let calls=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async(_url,init)=> {
    const b=JSON.parse(init!.body as string); calls++;
    if(calls===1) return Response.json(output(JSON.stringify({...plan,
      length:{unit:'characters',minimum:120,maximum:180},sections:[{...plan.sections[0],targetUnits:150}]})));
    if(calls===2) return Response.json(output(original));
    assert.match(b.instructions,/Append ONLY/);
    return Response.json(output(additional));
  });
  const result=await generate([], 'document', undefined,new AbortController().signal);
  assert.ok('document' in result);
  assert.equal(calls,3); assert.notEqual(result.document.presentation.partial,true);
  assert.ok(result.document.markdown.includes(original+'\n\n'+additional));
});

test('complete sections may trade allocation while the total range remains binding', async () => {
  let calls=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async(_url,init)=> {
    const b=JSON.parse(init!.body as string); calls++;
    if(calls===1) return Response.json(output(JSON.stringify({...plan,
      length:{unit:'characters',minimum:120,maximum:180},
      sections:[{heading:'一',brief:'第一章',targetUnits:75},{heading:'二',brief:'第二章',targetUnits:75}]})));
    const context=JSON.parse(b.input[0].content);
    if(/Append ONLY/.test(b.instructions)) return Response.json(output('补'.repeat(20)+'。'));
    return Response.json(output('文'.repeat(context.currentSection.index===1?30:80)+'。'));
  });
  const result=await generate([], 'document', undefined,new AbortController().signal);
  assert.ok('document' in result); assert.notEqual(result.document.presentation.partial,true);
  assert.ok(result.document.markdown.includes('补'.repeat(20)));
});

test('a completed but still short repair remains saved and visibly partial, without more calls', async () => {
  let calls=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async()=> {
    calls++;
    return Response.json(calls===1?output(JSON.stringify({...plan,length:{unit:'characters',minimum:120,maximum:180},
      sections:[{...plan.sections[0],targetUnits:150}]})):output('保留完整内容。'));
  });
  const result=await generate([], 'document', undefined,new AbortController().signal);
  assert.ok('document' in result); assert.equal(calls,3);
  assert.equal(result.document.presentation.partial,true); assert.match(result.document.markdown,/未完成草稿/);
});

test('double truncation and failed rewrite save visibly partial text, with no raw unfinished code', async () => {
  let calls=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async(_url,init)=> {
    const b=JSON.parse(init!.body as string); calls++;
    if(calls===1) return Response.json(output(JSON.stringify({...plan,sections:[{...plan.sections[0],targetUnits:6500}]})));
    if(/Rewrite ONLY/.test(b.instructions)) return new Response('',{status:503});
    return Response.json(output('LIB-7042 的既定要求。\n\n```sql\nDROP unfinished', 'incomplete'));
  });
  const result=await generate([], 'document',undefined,new AbortController().signal);
  assert.ok('document' in result); assert.equal(calls,4);
  assert.equal(result.document.presentation.partial,true);
  assert.deepEqual(result.document.presentation.incompleteSections,[1]);
  assert.match(result.document.markdown,/未完成草稿/); assert.match(result.document.markdown,/LIB-7042/);
  assert.doesNotMatch(result.document.markdown,/DROP unfinished|```/);
  const mail=mailPresentation(result.document.presentation);
  assert.match(mail.subject,/未完成草稿/); assert.match(mail.text,/第 1 章不完整/); assert.match(mail.html,/第 1 章不完整/);
});

test('cancellation during rewrite never becomes a partial artifact', async () => {
  const controller=new AbortController(); let n=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async(_u,init)=> {
    if(++n===1) return Response.json(output(JSON.stringify({...plan,sections:[{...plan.sections[0],targetUnits:6500}]})));
    if(/Rewrite ONLY/.test(JSON.parse(init!.body as string).instructions)) { controller.abort(); throw Error('cancel'); }
    return Response.json(output('完整段落。','incomplete'));
  });
  await assert.rejects(generate([], 'document',undefined,controller.signal),{name:'AbortError'});
});

test('partial salvage removes tilde code fences and trailing incomplete paragraphs within byte cap',()=> {
  const body=safePartialBody('完整句子。\n\n~~~js\nsecret code\n~~~\n\n半句话',100);
  assert.equal(body,'完整句子。'); assert.ok(Buffer.byteLength(body)<=100);
});

test('Calendar-bearing draft never downgrades a failed rewrite to a sendable partial artifact',async()=> {
  let n=0;
  const generate=createDraftGenerator({OPENAI_API_KEY:'fake'},async(_u,init)=> {
    if(++n===1) return Response.json(output(JSON.stringify({...plan,sections:[{...plan.sections[0],targetUnits:6500}],calendar:{title:'Synthetic',start:'2026-10-07T09:00-05:00',end:'2026-10-07T09:30-05:00',timezone:'America/Chicago',allDay:false,location:'',notes:''}})));
    if(/Rewrite ONLY/.test(JSON.parse(init!.body as string).instructions)) return new Response('',{status:503});
    return Response.json(output('完整段落。','incomplete'));
  });
  await assert.rejects(generate([], 'calendar',undefined,new AbortController().signal),/DRAFT_PROVIDER_FAILED/);
});
