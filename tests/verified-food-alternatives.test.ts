import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceCovers, parseAlternativeBranches, parseFoodService, sameBranch, verifiedFoodAlternatives, foodAlternativeText } from '../src/verified-food-alternatives.js';
import type { DialogueModel } from '../src/conversation.js';
import type { RouteProvider, RouteCandidate } from '../src/routes.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { LocationDialogue } from '../src/location-dialogue.js';
import { LocationRequestBroker } from '../src/location.js';
import { RouteError } from '../src/routes.js';

const at = Date.parse('2026-09-25T01:00:00-05:00'), signal = () => new AbortController().signal;
const url = 'https://food.example/branch', area = {source:'requested_area' as const, labels:['Test City, IA']};
const branch = {name:'Test Kitchen',address:'10 Test Street, Test City, IA 12345',sourceUrl:url};
const service = {kind:'takeout' as const,sourceUrl:url,periods:[{day:4,openMinute:600,closeMinute:1680}]};
const place: RouteCandidate = {placeId:'one',name:branch.name,address:branch.address,website:url,timeZone:'America/Chicago',
  durationSeconds:600,distanceMeters:2000,quality:{reliable:false,risk:false},hours:{checkedAt:at,source:'google',openNow:true,closesAt:at+3600000}};
const model: DialogueModel = {decide:async()=> 'respond',reply:async()=>{},findFoodAlternatives:async()=>[branch],verifyFoodService:async()=>service};
const routes: RouteProvider = {discover:async()=>({query:'food',candidates:[place]}),verifyPlace:async c=>c,
  route:async()=>({query:'food',candidates:[place],recommendedPlaceId:'one',recommendationBasis:'fastest',mode:'drive',trafficAware:true})};
const run = (m=model,r=routes,s=signal(),mode:'drive'|'walk'='drive') => verifiedFoodAlternatives('food',area,{kind:'address',address:'Test City, IA'},mode,{},m,r,s,()=>at);

test('overnight hours use previous START weekday, not tonight; Sunday wraps correctly',()=>{
  assert.equal(serviceCovers([{day:5,openMinute:1320,closeMinute:1620}],'America/Chicago',at,at+1200000),false);
  assert.equal(serviceCovers(service.periods,'America/Chicago',at,at+1200000),true);
  assert.equal(serviceCovers([{day:6,openMinute:1320,closeMinute:1620}],'America/Chicago',Date.parse('2026-09-27T01:00:00-05:00'),Date.parse('2026-09-27T01:30:00-05:00')),true);
  assert.equal(serviceCovers(service.periods,'Bad/Zone',at,at+1200000),false);
  assert.equal(serviceCovers(service.periods,'America/Chicago',at,at+3*3600000),false);
});
test('closing is exclusive and DST clock changes are not guessed',()=>{
  assert.equal(serviceCovers([{day:5,openMinute:0,closeMinute:90}],'America/Chicago',at,at+1800000),false);
  assert.equal(serviceCovers([{day:0,openMinute:0,closeMinute:1440}],'America/Chicago',Date.parse('2026-11-01T01:45:00-05:00'),Date.parse('2026-11-01T01:15:00-06:00')),false);
});
test('structured evidence must cite retrieved official source, exact branch and explicit service periods',()=>{
  assert.deepEqual(parseAlternativeBranches({branches:[{name:branch.name,address:branch.address,source_url:url}]},[]),[]);
  const raw={branch_matches:true,exceptions_conflict:false,source_url:url,kind:'takeout',periods:[{day:4,open_minute:600,close_minute:1680}]};
  assert.deepEqual(parseFoodService(raw,[url],url),service);
  for(const change of [{branch_matches:false},{exceptions_conflict:true},{kind:'store'},{periods:[]},{periods:[{day:7,open_minute:0,close_minute:20}]},
    {periods:[{day:4,open_minute:1320,close_minute:180}]},{source_url:'https://other.example/a'}])
    assert.equal(parseFoodService({...raw,...change},[url],url),undefined);
});
test('branch matching requires street, city, state and name, not just chain',()=>{
  assert.equal(sameBranch(branch,{...place,address:'10 Test St, Test City, IA 12345, USA'}),true);
  assert.equal(sameBranch({...branch,name:'Test Kitchen — 10 Test Street'},place),true);
  assert.equal(sameBranch({...branch,name:'Test Kitchen — 11 Test Street'},place),false);
  for(const change of [{address:'11 Test Street, Test City, IA 12345'},{address:'10 Test Street, Other City, IA 12345'},
    {address:'10 Test Street, Test City, IL 12345'},{name:'Other Kitchen'}]) assert.equal(sameBranch(branch,{...place,...change}),false);
});
test('verified alternative requires Google hours, measured arrival and independent service schedule',async()=>{
  const result=await run(); assert.equal(result.length,1); assert.match(foodAlternativeText(result,area,'drive'),/驾车约10分钟/);
  assert.doesNotMatch(foodAlternativeText(result,area,'drive'),/凌晨.*关门|保证有/);
});
test('missing hours, closed, wrong identity, unknown service and insufficient arrival margin all exclude',async()=>{
  for(const change of [{hours:undefined},{hours:{...place.hours!,source:'official_web' as const}},{hours:{...place.hours!,openNow:false}},
    {hours:{...place.hours!,closesAt:at+1000000}},{hours:{...place.hours!,checkedAt:at-120000}},
    {hours:{...place.hours!,foodOpenNow:false}},{timeZone:undefined},{placeId:'other'},{businessStatus:'CLOSED_PERMANENTLY' as const}])
    assert.equal((await run(model,{...routes,verifyPlace:async()=>({...place,...change})})).length,0);
  assert.equal((await run({...model,verifyFoodService:async()=>undefined})).length,0);
  assert.equal((await run({...model,verifyFoodService:async()=>({...service,kind:'drive_through'})},routes,signal(),'walk')).length,0);
});
test('two candidate cap, duplicates and user cancellation never leak late data',async()=>{
  let details=0;
  assert.equal((await run({...model,findFoodAlternatives:async()=>[branch,branch,branch]}, {...routes,verifyPlace:async c=>{details++;return c;}})).length,1);
  assert.equal(details,1);
  const controller=new AbortController();
  await assert.rejects(run({...model,findFoodAlternatives:async()=>{controller.abort();return [branch];}},routes,controller.signal));
});
test('food extraction uses structured search, no conversation, returns only validated evidence',async()=>{
  const calls:any[]=[];
  const raw={branch_matches:true,exceptions_conflict:false,kind:'takeout',source_url:url,periods:[{day:4,open_minute:600,close_minute:1680}]};
  const m=new OpenAIDialogue('fake','test',undefined,true,2,'America/Chicago',undefined,{fetcher:(async(_url,init)=>{
    calls.push(JSON.parse(String(init?.body)));return Response.json({status:'completed',output:[
      {type:'web_search_call',action:{sources:[{url}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(raw)}]}]});}) as typeof fetch});
  assert.deepEqual(await m.verifyFoodService(place,at,signal()),service);
  assert.equal(calls[0].tool_choice,'required'); assert.equal(calls[0].max_tool_calls,2);
  assert.equal(calls[0].text.format.strict,true);
  assert.deepEqual(calls[0].tools[0].filters.allowed_domains,['food.example']);
  assert.doesNotMatch(calls[0].input,/latitude|longitude|history|placeId/);
});

test('partial search quota limits the actual request; disabled/failed quota sends nothing',async()=>{
  let calls=0;
  const fetcher=(async(_url:any,init:any)=>{calls++;assert.equal(JSON.parse(String(init.body)).max_tool_calls,1);
    return Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:[]}},
      {type:'message',content:[{type:'output_text',text:'{"branches":[]}'}]}]});}) as typeof fetch;
  const quota={reserve:async()=>({limit:1,settle:async(n:number)=>{assert.equal(n,1);}})};
  await new OpenAIDialogue('fake','test',undefined,true,2,'UTC',quota,{fetcher}).findFoodAlternatives('food',area,{},at,signal());
  assert.equal(calls,1);
  for(const q of [{reserve:async()=>null},{reserve:async()=>{throw Error('busy');}}])
    assert.deepEqual(await new OpenAIDialogue('fake','test',undefined,true,2,'UTC',q,{fetcher}).findFoodAlternatives('food',area,{},at,signal()),[]);
  assert.equal(calls,1);
});
test('explicit restrictions never become a verified option without corresponding evidence',async()=>{
  for(const prefs of [{unhandledExclusions:true},{vibe:'quiet' as const},{priceCeiling:'inexpensive' as const},{excludeTypes:['restaurant']}]) {
    const r={...routes,verifyPlace:async()=>({...place,primaryType:'restaurant'})};
    assert.equal((await verifiedFoodAlternatives('food',area,{kind:'address',address:'Test City'},'drive',prefs,model,r,signal(),()=>at)).length,0);
  }
});
test('LocationDialogue delivers only code-formatted verified options, not raw web recommendations',async()=>{
  let finds=0, searches=0, freeReplies=0; const updates:any[]=[];
  const base:DialogueModel={...model,plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'restaurants',routeOrigin:'Test City, IA'}),
    reply:async()=>{freeReplies++;throw Error('must not use raw fallback answer');},
    findFoodAlternatives:async(q,a)=>{finds++;assert.match(q,/restaurants/);assert.deepEqual(a.labels,['Test City, IA']);return [branch];}};
  const provider:RouteProvider={...routes,discover:async()=>{if(searches++===0)throw new RouteError('ROUTE_NO_MATCHING_PLACES');return {query:'food',candidates:[place]};}};
  const broker=new LocationRequestBroker(()=>{},()=>crypto.randomUUID());
  const d=new LocationDialogue(base,broker,provider,'America/Chicago',()=>at,base), s=signal();
  await d.plan([],'现在附近有吃的吗？',true,s); let text='';
  await d.reply([{role:'user',content:'现在附近有吃的吗？'}],s,t=>text+=t,e=>updates.push(e));
  assert.equal(finds,1);assert.equal(freeReplies,0);assert.match(text,/Test Kitchen/);assert.doesNotMatch(text,/哪个城市|几点关门/);
  assert.equal(updates.find(e=>e.type==='answer.citations').citations[0].url,url);
});
test('failed candidate triggers one bounded different-candidate search, never an endless retry',async()=>{
  const bad={...branch,name:'Unavailable Kitchen'}; let finds=0;
  const m={...model,findFoodAlternatives:async(_q:any,_a:any,_p:any,_at:any,_s:any,excluded:any)=>{
    finds++; if(finds===1)return [bad]; assert.deepEqual(excluded,[bad]); return [branch]; }};
  assert.equal((await run(m)).length,1); assert.equal(finds,2);
  finds=0;
  assert.equal((await run({...model,findFoodAlternatives:async()=>{finds++;return [bad];}})).length,0);
  assert.equal(finds,2);
});
