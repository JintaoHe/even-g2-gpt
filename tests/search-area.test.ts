import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchArea, resolveSearchArea } from '../src/search-area.js';
import { LocationDialogue } from '../src/location-dialogue.js';
import { LocationRequestBroker } from '../src/location.js';
import { RouteError, type RouteProvider, type RouteRequest } from '../src/routes.js';
import type { DialogueModel, Message } from '../src/conversation.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { unverifiedAlternativeText } from '../src/alternative-policy.js';

const fix = () => ({ latitude: 42.12, longitude: -93.45, accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() });
const broker = () => { const b = new LocationRequestBroker(() => {}, () => 'unused'); b.prime({mode:'once',location:fix()}); return b; };
const signal = () => new AbortController().signal;
const geo = {status:'OK', results:[{formatted_address:'PRIVATE STREET', address_components:[
  {long_name:'PRIVATE STREET',types:['route']}, {long_name:'Example City',types:['locality']},
  {long_name:'Iowa',types:['administrative_area_level_1']}, {long_name:'United States',types:['country']}
]}]};

test('reverse geocoding returns political components only and reserves once', async()=>{
  const settled:number[]=[]; let calls=0;
  const costs:any={reserveGoogle:async(sku:string,n:number)=>{assert.equal(sku,'geocoding');assert.equal(n,1);return {settle:async(n:number)=>settled.push(n)};}};
  const area=await resolveSearchArea('synthetic-key',fix(),signal(),async(url,init)=>{
    calls++;const u=new URL(String(url));assert.equal(u.hostname,'maps.googleapis.com');assert.equal(u.searchParams.get('result_type'),'locality|postal_town|administrative_area_level_2');assert.ok(init?.signal);
    return Response.json(geo);
  },costs);
  assert.deepEqual(area,{source:'google_locality',labels:['Example City, Iowa, United States']});
  assert.equal(calls,1);assert.deepEqual(settled,[1]);assert.doesNotMatch(JSON.stringify(area),/PRIVATE|42\.12|-93\.45|synthetic-key/);
});

test('reverse geocoding denial, malformed responses and network failures never leak errors or invent a city', async()=>{
  for(const payload of [{status:'REQUEST_DENIED',error_message:'secret'}, {status:'ZERO_RESULTS'}, {status:'OK',results:[{address_components:[]}]}]) {
    assert.equal(await resolveSearchArea('key',fix(),signal(),async()=>Response.json(payload)),undefined);
  }
  assert.equal(await resolveSearchArea('key',fix(),signal(),async()=>{throw Error('secret url and key');}),undefined);
  const abort=new AbortController();abort.abort(Error('cancelled'));
  await assert.rejects(resolveSearchArea('key',fix(),abort.signal,async()=>{throw Error('must not call');}),/cancelled/);
  assert.equal(searchArea('mapped_places',['', 'a\u202eb', null]),undefined);
  assert.equal(searchArea('mapped_places',['A','A','B','C','D'])?.labels.length,3);
});

test('known branch search anchors survive all-closed fallback without reverse geocoding',async()=>{
  let replies=0;
  const base:DialogueModel={plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'food'}),decide:async()=> 'respond',
    reply:async(h,_s,delta,_u,_e,_m,w)=>{
      replies++;assert.deepEqual(w?.[0].searchArea,{source:'mapped_places',labels:['12 Public Ave, Cedar Rapids, Iowa']});
      assert.doesNotMatch(h.at(-1)!.content,/42\.12|-93\.45|latitude|longitude/);delta('searched');
    }};
  const routes:RouteProvider={searchArea:async()=>{throw Error('unnecessary geocode');},route:async()=>{throw new RouteError('ROUTE_NO_MATCHING_PLACES',undefined,'places',undefined,false,undefined,[{placeId:'closed',name:'Public Cafe',address:'12 Public Ave, Cedar Rapids, Iowa',reason:'closed'}]);}};
  const d=new LocationDialogue(base,broker(),routes);const s=signal();await d.plan([],'food',false,s);await d.reply([{role:'user',content:'food'}],s,()=>{});assert.equal(replies,1);
});

test('zero candidates resolve coarse area once; cancellation cannot deliver late research',async()=>{
  for(const cancel of [false,true]){
    const a=new AbortController();let resolveCalls=0,replies=0;
    const base:DialogueModel={plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'food'}),decide:async()=> 'respond',reply:async(_h,_s,d)=>{replies++;d('ok');}};
    const d=new LocationDialogue(base,broker(),{route:async()=>{throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');},searchArea:async()=>{resolveCalls++;if(cancel)a.abort(Error('cancelled'));return {source:'google_locality',labels:['Ames, Iowa, USA']};}});
    await d.plan([],'food',false,a.signal);
    if(cancel)await assert.rejects(d.reply([{role:'user',content:'food'}],a.signal,()=>{}),/cancelled/);
    else await d.reply([{role:'user',content:'food'}],a.signal,()=>{});
    assert.equal(resolveCalls,1);assert.equal(replies,cancel?0:1);
  }
});

test('missing area asks without model call; bare city continues original task and session reset clears it',async()=>{
  let turns=0,replies=0;const requests:RouteRequest[]=[];
  const base:DialogueModel={plan:async()=> turns++===0?{decision:'respond',locationAction:'nearby_search',routeDestination:'vegetarian dinner',routeMode:'walk',routeModeExplicit:true}:{decision:'respond',locationAction:'none'},decide:async()=> 'respond',
    reply:async(_h,_s,d,_u,_e,_m,w)=>{replies++;assert.deepEqual(w?.[0].searchArea,{source:'requested_area',labels:['Ames, Iowa']});d('researched');}};
  const d=new LocationDialogue(base,broker(),{route:async r=>{requests.push(r);throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');}});
  let s=signal();await d.plan([],'vegetarian dinner',false,s);let question='';await d.reply([{role:'user',content:'vegetarian dinner'}],s,t=>question+=t);
  assert.equal(replies,0);assert.match(question,/城市或地区/);
  const h:Message[]=[{role:'user',content:'vegetarian dinner'},{role:'assistant',content:question}];
  s=signal();const p=await d.plan(h,'Ames, Iowa',false,s);assert.equal(p.routeDestination,'vegetarian dinner');
  await d.reply([...h,{role:'user',content:'Ames, Iowa'}],s,()=>{});assert.equal(replies,1);
  assert.deepEqual(requests[1].origin,{kind:'address',address:'Ames, Iowa'});
  assert.equal(requests[1].mode,'walk');
  d.endSession();s=signal();assert.equal((await d.plan(h,'Ames, Iowa',false,s)).locationAction,'none');
});

test('known area removes city question from instructions and closed-set delivery escape',async()=>{
  const question='你想在哪个城市或地区找？';
  const model=new OpenAIDialogue('fake','test','https://example.invalid',true,1,'America/Chicago',undefined,{fetcher:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.match(body.instructions,/Search this area NOW/);
    assert.match(body.instructions,/Cedar Rapids/);
    return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:question,annotations:[]}]}]}})}\n\n`);
  }});
  let answer='';await model.reply([{role:'user',content:'hungry'}],signal(),s=>answer+=s,undefined,'medium','decision_support',[
    {kind:'navigation',action:'fallback_search',searchArea:{source:'mapped_places',labels:['Cedar Rapids, Iowa']}},{kind:'search',action:'read'}]);
  assert.equal(answer,unverifiedAlternativeText);
});
