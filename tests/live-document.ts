// Opt-in real API evaluation, synthetic source only. No SMTP, Calendar or production store.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDraftGenerator, draftFailureDetails } from '../src/delivery-draft.js';

async function main() {
  if (process.env.RUN_LIVE_DOCUMENT !== '1') throw Error('Set RUN_LIVE_DOCUMENT=1 to authorize paid API calls');
  const observations: { phase: string; status?: string; elapsedMs: number; inputTokens?: number; outputTokens?: number }[] = [];
  const request: typeof fetch = async (url, init) => {
    const body=JSON.parse(init!.body as string), started=Date.now();
    assert.equal(body.tools,undefined); assert.equal(body.store,false);
    const phase=body.text?.format?.type==='json_schema'?'plan':/Rewrite ONLY|Append ONLY/.test(body.instructions)?'compression':/Continue ONLY/.test(body.instructions)?'continuation':'section';
    const response=await fetch(url,init);
    const data=await response.clone().json() as any;
    if (phase==='plan' && data.status==='completed') {
      const text=(data.output??[]).flatMap((o:any)=>o.content??[]).filter((p:any)=>p.type==='output_text').map((p:any)=>p.text).join('');
      const p=JSON.parse(text); console.log(JSON.stringify({plannedLength:p.length,targets:p.sections?.map((s:any)=>s.targetUnits)}));
    }
    observations.push({phase,status:data.status,elapsedMs:Date.now()-started,inputTokens:data.usage?.input_tokens,outputTokens:data.usage?.output_tokens});
    console.log(JSON.stringify(observations.at(-1))); return response;
  };
  const started=Date.now();
  const runId=new Date(started).toISOString().replace(/[:.]/g,'-');
  const generator=createDraftGenerator(process.env,request);
  await mkdir('.local/evals',{recursive:true});
  try {
    const result=await generator([{role:'user',content:'生成一份社区图书借阅系统工程 Markdown 方案。项目代号“Cedar Lantern”，工单 LIB-7042，虚构负责人“Mira Chen”，设备“Orion Shelf 7”。名称逐字保留。恰好六章：需求与不变量、数据模型与迁移、离线同步与冲突、安全与隐私、测试与故障演练、发布与回滚。整份正文（不含代码）6000–8000个中文字符，不是每章6000字。每章具体说明实施细节、取舍和验收标准；代码示例简短。所有内容是建议，不声称已实施。只生成文件，不发送邮件、不调用日历、不搜索。'}],
      'document',undefined,AbortSignal.timeout(480000));
    assert.ok('document' in result);
    const {markdown,presentation}=result.document;
    await writeFile('.local/evals/live-document.md',markdown,{mode:0o600});
    await writeFile(`.local/evals/live-document-${runId}.md`,markdown,{mode:0o600});
    const prose=markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,'');
    const chinese=(prose.match(/\p{Script=Han}/gu)||[]).length;
    const report={elapsedMs:Date.now()-started,chinese,bytes:Buffer.byteLength(markdown),partial:!!presentation.partial,
      headings:(markdown.match(/^## /gm)||[]).length,compressedSections:presentation.compressedSections,observations};
    await writeFile('.local/evals/live-document.json',JSON.stringify(report,null,2),{mode:0o600});
    await writeFile(`.local/evals/live-document-${runId}.json`,JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify(report));
    assert.notEqual(presentation.partial,true); assert.equal(report.headings,6);
    assert.ok(chinese>=6000 && chinese<=8000,'Requested Chinese length not met');
    for(const entity of ['Cedar Lantern','LIB-7042','Mira Chen','Orion Shelf 7']) assert.ok(markdown.includes(entity),`Missing synthetic entity: ${entity}`);
    assert.ok(observations.filter(o=>o.phase==='continuation').length<=1,'Quality gate: more than one continuation');
    console.log('PASS live document; emails=0 calendar writes=0');
  } catch(error) {
    console.error(JSON.stringify({result:'FAIL',failure:error instanceof assert.AssertionError
      ? {code:'LIVE_DOCUMENT_QUALITY_GATE_FAILED'}:draftFailureDetails(error),observations}));
    process.exitCode=1;
  }
}
main().catch(()=>{console.error('LIVE_DOCUMENT_SETUP_FAILED');process.exitCode=1;});
