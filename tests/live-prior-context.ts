// Opt-in bounded smoke. Synthetic SQLite only; no production socket/tools.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { ContextBuilder } from '../src/context-builder.js';
import { CostLedger } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch, openAIPricing, requestMaximum } from '../src/metered-openai.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

async function main() {
  if(process.env.RUN_LIVE_PRIOR_CONTEXT!=='1')throw Error('OPT_IN_REQUIRED');
  if(!process.env.OPENAI_API_KEY)throw Error('KEY_MISSING');
  const busy=await new Promise<boolean>(resolveCheck=>{const s=createConnection({host:'127.0.0.1',port:Number(process.env.CONVERSATION_PORT??3001)});
    s.on('connect',()=>{s.destroy();resolveCheck(true);});s.on('error',()=>resolveCheck(false));s.setTimeout(1000,()=>{s.destroy();resolveCheck(true);});});
  if(busy)throw Error('STOP_LOCAL_BACKEND');
  const ledger=await CostLedger.create(resolve(process.env.EVEN_COST_LEDGER_PATH??'.local/cost-ledger.json'));
  const pricing=openAIPricing();let calls=0,reserved=0;
  const bounded:typeof fetch=async(input,init)=>{
    assert.equal(String(input),'https://api.openai.com/v1/responses');
    const body=String(init?.body),request=JSON.parse(body);assert.equal(request.tools,undefined);
    const cost=requestMaximum(body,pricing);
    if(calls>=6||reserved+cost>0.15)throw Error('LIVE_BUDGET');calls++;reserved+=cost;
    return fetch(input,init);
  };
  const {model}=createHybridDialogue(process.env.OPENAI_API_KEY,{...process.env,GOOGLE_MAPS_ENABLED:'false',GOOGLE_CALENDAR_ENABLED:'true',EVEN_DELIVERY_ROUTING:'true'},
    {search:false,fetcher:createMeteredOpenAIFetch(ledger,process.env,bounded)});
  const root=await mkdtemp(join(tmpdir(),'even-live-prior-')),store=await ConversationStore.create(root);
  try {
    for(const variant of ['tail','lossy-summary','damaged-summary']) {
      const now=Date.now(),scope=`eval-${variant}`,id=randomUUID(),topic=randomUUID();
      store.createSession({id,ownerScope:scope,createdAt:now-5000,initialTopic:{id:topic,label:'Rollout'}});
      for(let i=0;i<3;i++){
        const turnId=randomUUID(),messageId=randomUUID();
        store.commitUserTurn({sessionId:id,topicId:topic,turnId,messageId:randomUUID(),createdAt:now-4900+i*3,
          content:i===0?'SpruceHarbor 的周末上线只是备选，压测结果还没出。':i===1?'我之前说“好的”只是同意继续评估，不是授权发邮件。':'没有最后决定，也没有发信或写日历。'});
        store.startAssistantAnswer({sessionId:id,topicId:topic,turnId,messageId,createdAt:now-4899+i*3});
        store.commitAssistantAnswer({messageId,content:'仍待验证，不会执行任何外部动作。',updatedAt:now-4898+i*3});
      }
      store.endSession(id,now-2000,'user_exit');
      if(variant!=='tail'){
        const job=store.claimNextSummaryJob(now-1900)!;
        // The previous tail-only fixture may also have a queued job. Complete
        // only the matching job; give each fixture its own queue lifetime.
        assert.equal(job.sessionId,id);
        store.completeSummaryJob({id:job.id,model:'synthetic',at:now-1800,
          summary:{version:1,throughSequence:6,overview:'SpruceHarbor 周末上线仅是备选，等待压测；邮件未发，日历未改。',topics:[],confirmedDecisions:[],unresolvedItems:['上线时间待定']},
          losses:[{kind:'message',sequence:2,omittedBytes:100}]});
        if(variant==='damaged-summary'){const db=new DatabaseSync(join(root,'assistant-memory.sqlite'));try{db.prepare('UPDATE session_summaries SET summary_json=? WHERE session_id=?').run('{}',id);}finally{db.close();}}
      } else {
        const job=store.claimNextSummaryJob(now-1900)!;store.failSummaryJob(job.id,'SUMMARY_INPUT_LIMIT',now-1800);
      }
      const current=randomUUID();store.createSession({id:current,ownerScope:scope,createdAt:now});
      const prior=store.priorSessionContext({ownerScope:scope,currentSessionId:current,before:now})!;
      const builder=new ContextBuilder(),history=builder.build({messages:[],prior}).messages;
      const question='所以我们已经决定周末上线，而且邮件已经发了吗？';
      const signal=AbortSignal.timeout(60000),plan=await model.plan!(history,question,false,signal);
      assert.notEqual(plan.deliveryAction,'confirm');assert.notEqual(plan.calendarAction,'confirm');
      let answer='';await model.reply(builder.build({messages:[{role:'user',content:question}],prior}).messages,signal,text=>{answer+=text;},undefined,'low','casual',[]);
      assert.match(answer,/没有|未|不能确认|无法确认|不确定|缺失|不可用/);
      console.log(JSON.stringify({variant,answer,pass:true}));
    }
  } finally {model.endSession?.();await store.close();console.log(JSON.stringify({calls,reservedUpperUsd:reserved,capUsd:0.15,emails:0,calendarWrites:0,syntheticOnly:true}));}
}
main().catch(error=>{console.error(['OPT_IN_REQUIRED','KEY_MISSING','STOP_LOCAL_BACKEND','LIVE_BUDGET'].includes(error?.message)?error.message:'LIVE_PRIOR_FAILED');process.exitCode=1;});
