// Opt-in, synthetic conversation/location, temporary ledger; never starts the production server.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { LocationDialogue } from '../src/location-dialogue.js';
import { LocationRequestBroker } from '../src/location.js';
import { GoogleRoutesProvider } from '../src/routes.js';
import { CostLedger } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch, openAIPricing, requestMaximum } from '../src/metered-openai.js';
import type { Message } from '../src/conversation.js';

config({path:process.env.DOTENV_CONFIG_PATH ?? '.env'});
if(process.env.RUN_FOOD_FOLLOWUP!=='1'||!process.env.OPENAI_API_KEY||!process.env.GOOGLE_MAPS_API_KEY) throw Error('OPT_IN_AND_KEYS_REQUIRED');
const dir=await mkdtemp(join(tmpdir(),'food-followup-'));
const ledger=await CostLedger.create(join(dir,'cost-ledger.json'),process.env);
const budget=Number(process.env.TEST_MAX_USD ?? '3');
let reserved=Number(process.env.TEST_PRIOR_RESERVED_USD ?? '0'),openai=0,google=0,budgetBlocked=false;
assert.ok(Number.isFinite(budget)&&budget>0&&budget<=10&&Number.isFinite(reserved)&&reserved>=0&&reserved<budget);
const reserve=(amount:number)=>{if(reserved+amount>budget){budgetBlocked=true;throw Error('TEST_BUDGET');}reserved+=amount;};
const api:typeof fetch=async(url,init)=>{
  if(String(url)!=='https://api.openai.com/v1/responses')throw Error('ENDPOINT_DENIED');
  const body=JSON.parse(String(init?.body));
  reserve(requestMaximum(String(init?.body),openAIPricing(process.env,body.model)));openai++;
  assert.doesNotMatch(JSON.stringify(body.input),/41\.570|41\.57\b|-93\.711|41\.882|-87\.629/,'GPS reached OpenAI');
  try {
    const response=await fetch(url,init);
    if(!response.ok)console.log(JSON.stringify({event:'api_status',status:response.status}));
    if(process.argv.includes('--inspect')&&['food_alternative_candidates','branch_food_service'].includes(body.text?.format?.name)&&response.ok){
      const result:any=await response.clone().json();
      console.log(JSON.stringify({event:'synthetic_evidence',schema:body.text.format.name,status:result.status,
        sources:result.output?.filter((x:any)=>x.type==='web_search_call').map((x:any)=>({type:x.action?.type,url:x.action?.url,sources:x.action?.sources?.map((s:any)=>s.url)})),
        output:result.output?.filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content??[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text)}));
    }
    return response;
  }catch(error){
    const code=(error as any)?.cause?.code;
    console.log(JSON.stringify({event:'api_network',code:typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'unknown'}));
    throw error;
  }
};
const maps:typeof fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(!['places.googleapis.com','maps.googleapis.com','routes.googleapis.com'].includes(u.hostname)||u.protocol!=='https:')throw Error('ENDPOINT_DENIED');
  const body=JSON.parse(String(init?.body??'{}'));
  reserve(u.hostname==='routes.googleapis.com'?(body.origins?.length??1)*(body.destinations?.length??1)*0.01:0.05);google++;
  const response=await fetch(url,init);
  if(process.argv.includes('--inspect')&&u.hostname==='places.googleapis.com'&&response.ok){
    const data:any=await response.clone().json();
    console.log(JSON.stringify({event:'synthetic_places',query:body.textQuery,candidates:(data.places??[data]).slice(0,10).map((p:any)=>({name:p.displayName?.text,address:p.formattedAddress,types:p.types,open:p.currentOpeningHours?.openNow,website:p.websiteUri}))}));
  }
  return response;
};
const make=()=>{
  const {model:base}=createHybridDialogue(process.env.OPENAI_API_KEY!,{...process.env,EVEN_MODEL_PROFILE:'hybrid-luna',GOOGLE_MAPS_ENABLED:'true',
    EVEN_DATA_DIR:dir,GOOGLE_CALENDAR_ENABLED:'false',EVEN_DELIVERY_ROUTING:'false',EVEN_EMAIL_ENABLED:'false'},
    {search:true,fetcher:createMeteredOpenAIFetch(ledger,process.env,api)});
  const broker=new LocationRequestBroker(()=>{},()=>crypto.randomUUID());
  return {base,broker,model:new LocationDialogue(base,broker,new GoogleRoutesProvider(process.env.GOOGLE_MAPS_API_KEY!,maps,undefined,undefined,ledger),'America/Chicago',Date.now,base)};
};
const seed:Message[]=[{role:'user',content:'现在有点饿，附近哪里有什么吃的？'},
  {role:'assistant',content:'之前的候选是 IHOP。现在可以按你的偏好重新找。'}];
let failed=0;
try {
  if(process.argv.includes('--same-site')) {
    const {base}=make();
    for(let i=0;i<4&&!budgetBlocked;i++){
      const at=Date.now();
      const result=await base.verifyFoodService!({placeId:'synthetic-known-public-branch',name:'Sakura Sushi',
        address:'1960 Grand Ave Ste 11, West Des Moines, IA 50265, USA',website:'https://www.sakurasushiwdm.com/'},at,AbortSignal.timeout(60000));
      console.log(JSON.stringify({event:'same_site',index:i,verified:!!result,elapsedMs:Date.now()-at,result}));
    }
  } else {
  // Deliberately include multilingual, preference removal, unsupported requirements and topic changes.
  const matrix:[string,string,(p:any)=>boolean][]=[
    ['reject','我不喜欢IHOP，我想吃炸鸡、寿司或者中餐，帮我找现在开着、评价比较好的。',p=>p.locationAction==='nearby_search'&&p.nearby?.taskAction==='continue'&&p.nearby?.patch.excludeNames?.includes('IHOP')&&p.nearby?.patch.cuisineTypes?.length===3&&!p.nearby?.patch.unhandledExclusions],
    ['mixed','No IHOP please，sushi 或 steak 都可以，看看附近还开着哪家。',p=>p.locationAction==='nearby_search'&&p.nearby?.patch.excludeNames?.includes('IHOP')&&p.nearby?.patch.cuisineTypes?.includes('steak_house')],
    ['remove','IHOP也可以了，不限制菜系，重新找附近餐馆。',p=>p.nearby?.patch.excludeNames===null&&p.nearby?.patch.cuisineTypes===null],
    ['unrelated','算了不吃了，附近哪里有药店？',p=>p.nearby?.taskAction==='replace'&&!p.nearby?.patch.needsFood],
    ['ordinary','你知道寿司是怎么做的吗？',p=>!p.locationAction||p.locationAction==='none'],
    ['contradictory','我要纯素的真牛肉牛排，绝对不能有植物肉，也不能有动物成分，找附近一家。',p=>!p.locationAction||p.locationAction==='none'||p.nearby?.patch.unhandledExclusions===true],
    ['guarantee','给我找附近寿司，必须保证绝对没有花生交叉污染，别问我。',p=>!p.locationAction||p.locationAction==='none'||p.nearby?.patch.unhandledExclusions===true],
    ['future','明天晚上再去吃寿司，先找附近店，不是现在。',p=>p.nearby?.patch.visitTime==='future'],
    ['opinion','这两家评分一样但一家评论更多，详细比较一下。',p=>p.locationAction==='analyze_places'],
    ['cancel','不用找了，给我讲个关于猫的笑话。',p=>p.locationAction==='cancel'||p.locationAction==='none'],
  ];
  for(const [id,text,check]of (process.argv.includes('--full-only')?[]:process.argv.includes('--probe')?matrix.slice(0,1):matrix)){
    if(budgetBlocked)break;
    const {model}=make();const at=Date.now();
    try{const p=await model.plan(seed,text,true,AbortSignal.timeout(45000));const pass=!!check(p);if(!pass)failed++;
      console.log(JSON.stringify({event:'intent_case',id,pass,elapsedMs:Date.now()-at,action:p.locationAction,nearby:p.nearby}));
    }catch{failed++;console.log(JSON.stringify({event:'intent_case',id,pass:false,error:'CALL_FAILED'}));}
  }
  const {broker,model}=make();const history=[...seed];
  const varied=process.argv.includes('--varied');
  const full=varied ? [
    '现在有点饿，附近找开着的披萨店，不要IHOP，评分和评论数量都考虑。',
    'Changed my mind，不要披萨了，改吃泰国菜，其他要求不变。',
    '先别找店了，我对花生严重过敏，你必须保证绝对没有交叉污染，不能只是猜。',
    '取消餐厅任务，给我讲个短一点的猫的笑话。',
  ] : process.argv.includes('--switching') ? [
    '我不喜欢IHOP，附近找现在开着的寿司店，评分和评论都帮我比较。',
    'Wait，先不吃Sushi了，改找附近牛排，其他条件一样。',
    '又不想吃牛排了，还是回到Sushi，IHOP还是不要。',
    '必须纯素但又必须真牛肉，而且不要植物肉。帮我找。',
    '撤回刚才纯素和真牛肉的限制。现在找附近中餐，还是不要IHOP。',
    '不找餐厅了，为什么天空是蓝色的？',
  ] : [
    '我不喜欢IHOP，我想吃炸鸡、寿司或者中餐，帮我找现在开着、评价比较好的。',
    '那改成只看寿司，不要IHOP，帮我再找两家开着的。',
    '先不找店了。为什么天空是蓝色的？',
  ];
  for(const [index,text] of (process.argv.includes('--probe')?[]:full).entries()) {
    if(budgetBlocked){console.log(JSON.stringify({event:'live_turn',index,skipped:'TEST_BUDGET'}));break;}
    const at=Date.now(),before=google;
    broker.prime({location:{latitude:varied?41.882:41.570,longitude:varied?-87.629:-93.711,accuracyM:20,observedAt:at,receivedAt:at}} as any);
    try {
      const signal=AbortSignal.timeout(120000),plan=await model.plan(history,text,true,signal);
      history.push({role:'user',content:text});let answer='';
      await model.reply(history,signal,t=>answer+=t,undefined,plan.reasoningEffort,plan.assistantMode,plan.workflows);
      const switching=process.argv.includes('--switching'), ordinary=index===(varied?3:switching?5:2),contradiction=(switching&&index===3)||(varied&&index===2);
      const pass=!!answer.trim()&&!/哪个城市|哪个地区|无法从地图数据核实/.test(answer)&&((ordinary||contradiction)?google===before:google>before&&/以下候选按证据分别说明/.test(answer)&&!/IHOP/i.test(answer));
      if(!pass)failed++;
      console.log(JSON.stringify({event:'live_turn',index,pass,action:plan.locationAction,nearby:plan.nearby,googleCalls:google-before,elapsedMs:Date.now()-at,answer}));
      history.push({role:'assistant',content:answer});
    }catch{failed++;console.log(JSON.stringify({event:'live_turn',index,pass:false,error:budgetBlocked?'TEST_BUDGET':'CALL_FAILED',elapsedMs:Date.now()-at}));}
  }
  }
} finally {
  console.log(JSON.stringify({event:'summary',failed,budgetBlocked,openaiCalls:openai,googleCalls:google,reservedUpperUsd:reserved,ledger:await ledger.snapshot()}));
  if(failed)process.exitCode=1;
}
