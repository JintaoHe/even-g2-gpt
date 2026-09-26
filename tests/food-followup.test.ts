import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNearbyIntent, applyNearbyIntent } from '../src/nearby-intent.js';
import { prefilterNearby, RouteError, type RouteProvider } from '../src/routes.js';
import { LocationDialogue } from '../src/location-dialogue.js';
import { LocationRequestBroker } from '../src/location.js';
import type { DialogueModel, Message, TurnPlan } from '../src/conversation.js';
import { foodAlternativeText, verifiedFoodAlternatives, type FoodVerificationReport } from '../src/verified-food-alternatives.js';
import { secureWebsiteHint } from '../src/place-availability.js';

test('legacy restaurant website hints only upgrade to HTTPS, never weaken transport',()=>{
  assert.equal(secureWebsiteHint('http://restaurant.example/menu'),'https://restaurant.example/menu');
  assert.equal(secureWebsiteHint('https://restaurant.example/menu'),'https://restaurant.example/menu');
  for(const url of ['http://user@restaurant.example/','http://restaurant.example:81/','http://127.0.0.1/',
    'http://localhost/','http://a.internal/','ftp://restaurant.example/']) assert.equal(secureWebsiteHint(url),undefined);
});

test('restaurant rejection and OR cuisines survive follow-ups but not a new task', () => {
  const intent = parseNearbyIntent({mode:'recommend',task_action:'continue',delegated:false,patch:{
    exclude_names:{operation:'set',value:['IHOP']},
    cuisine_types:{operation:'set',value:['chicken_restaurant','sushi_restaurant','chinese_restaurant']}}})!;
  const prefs = applyNearbyIntent({needsFood:true,priceCeiling:'moderate'},intent);
  assert.equal(prefs.unhandledExclusions,undefined);
  assert.deepEqual(applyNearbyIntent(prefs,{...intent,patch:{cuisineTypes:['sushi_restaurant']}}),
    {...prefs,cuisineTypes:['sushi_restaurant']});
  assert.deepEqual(applyNearbyIntent(prefs,{...intent,taskAction:'replace',patch:{}}),{});
  assert.deepEqual(applyNearbyIntent(prefs,{...intent,patch:{excludeNames:null}}).excludeNames,undefined);
  for(const value of [['\nIHOP'],[''],Array(7).fill('IHOP')]) {
    const invalid=parseNearbyIntent({mode:'recommend',task_action:'continue',delegated:false,patch:{exclude_names:{operation:'set',value}}})!;
    assert.equal(invalid.patch.unhandledExclusions,true);
  }
});

test('name exclusions match whole normalized names/brands, cuisine filters are OR and fail closed on missing type',()=>{
  const rows=[{placeId:'ihop',name:'ＩＨＯＰ - Downtown',types:['chicken_restaurant']},
    {placeId:'similar',name:'IHOPPER Sushi',types:['sushi_restaurant']},
    {placeId:'chicken',name:'Chicken House',primaryType:'chicken_restaurant'},
    {placeId:'unknown',name:'Sushi maybe'}, {placeId:'other',name:'Pizza',types:['pizza_restaurant']}];
  const result=prefilterNearby(rows,{excludeNames:['ihop'],cuisineTypes:['sushi_restaurant','chicken_restaurant']});
  assert.deepEqual(result.candidates.map(c=>c.placeId),['similar','chicken']);
  assert.deepEqual(result.excluded.map(c=>c.reason),['name','cuisine','cuisine']);
});

test('follow-up performs three bounded cuisine searches, preserves location and rejected brand',async()=>{
  const at=Date.now(), calls:any[]=[];
  const plans:TurnPlan[]=[{decision:'respond',locationAction:'nearby_search',routeDestination:'restaurants',nearby:{mode:'recommend',taskAction:'continue',delegated:false,patch:{needsFood:true}}},
    {decision:'respond',locationAction:'nearby_search',routeDestination:'fried chicken sushi Chinese food',nearby:{mode:'recommend',taskAction:'continue',delegated:false,patch:{excludeNames:['IHOP'],cuisineTypes:['chicken_restaurant','sushi_restaurant','chinese_restaurant']}}},
    {decision:'respond',locationAction:'nearby_search',routeDestination:'sushi',nearby:{mode:'recommend',taskAction:'continue',delegated:false,patch:{cuisineTypes:['sushi_restaurant']}}}];
  let turn=0;
  const base:DialogueModel={decide:async()=> 'respond',plan:async()=>plans[turn++],reply:async(_h,_s,delta,_u,_e,_m,workflows)=>{
    assert.ok(workflows?.some(w=>w.action==='restaurant_search')); delta('餐馆查询结果'); }};
  const provider:RouteProvider={discover:async request=>{
    calls.push(request);
    const type=request.nearbyPreferences?.cuisineTypes?.[0] ?? 'restaurant';
    return {query:request.destination,candidates:[{placeId:type,name:type==='restaurant'?'IHOP':type,primaryType:type,address:'Test City, IA'}]};
  },route:async request=>({query:request.destination,candidates:request.candidates!.map(c=>({...c,durationSeconds:60,distanceMeters:100,quality:{reliable:false,risk:false}})),
    recommendedPlaceId:request.candidates![0].placeId,recommendationBasis:'fastest',mode:request.mode,trafficAware:false})};
  const broker=new LocationRequestBroker(()=>{},()=>crypto.randomUUID());
  const d=new LocationDialogue(base,broker,provider),history:Message[]=[];
  for(const text of ['附近吃什么','不要IHOP，炸鸡寿司中餐都行','那只看寿司']) {
    broker.prime({location:{latitude:41.57,longitude:-93.711,accuracyM:10,observedAt:at,receivedAt:at}} as any);
    const s=new AbortController().signal; await d.plan(history,text,true,s);
    history.push({role:'user',content:text});let answer='';await d.reply(history,s,t=>answer+=t);
    assert.ok(answer); if(turn>1) assert.doesNotMatch(answer,/IHOP|哪个城市/);
    history.push({role:'assistant',content:answer});
  }
  assert.deepEqual(calls.map(c=>c.destination),['restaurants','fried chicken restaurant','sushi restaurant','chinese restaurant','sushi']);
  assert.ok(calls.every(c=>c.origin.kind==='coordinates'));
  assert.deepEqual(calls.at(-1).nearbyPreferences.excludeNames,['IHOP']);
});

test('AYCE query reaches Maps; brand switch drops cuisine; missing kitchen/closing does not block web reply',async()=>{
  const calls:any[]=[], evidence:any[]=[]; let turn=0, verifies=0;
  const base:DialogueModel={decide:async()=> 'respond',plan:async()=>({decision:'respond',locationAction:'nearby_search',
    routeDestination:turn++===0?'all you can eat sushi':"McDonald's",nearby:{mode:'recommend',taskAction:turn===1?'continue':'replace',delegated:false,
      patch:turn===1?{needsFood:true,cuisineTypes:['sushi_restaurant'],unhandledExclusions:false}:{needsFood:true}}}),
    reply:async(h,_s,delta,_u,_e,_m,w)=>{
      assert.ok(w?.some(x=>x.action==='restaurant_search'));
      assert.doesNotMatch(h.at(-1)!.content,/41\.57|-93\.711/);
      evidence.push(JSON.parse(h.at(-1)!.content.split('\n').at(-1)!));delta('地图评分已查；AYCE 另查菜单。'); }};
  const routes:RouteProvider={discover:async r=>{calls.push(r);return {query:r.destination,candidates:[{
    placeId:'branch',name:r.destination,address:'Test City, IA',rating:4.3,userRatingCount:230,
    hours:{openNow:true,checkedAt:Date.now(),source:'google'},primaryType:turn===1?'sushi_restaurant':'fast_food_restaurant'}]};},
    verifyPlace:async c=>{verifies++;return c;},route:async r=>({query:r.destination,candidates:r.candidates!.map(c=>({...c,
      durationSeconds:120,distanceMeters:800,quality:{reliable:true,risk:false}})),recommendedPlaceId:'branch',mode:r.mode,trafficAware:false,recommendationBasis:'fastest'})};
  const broker=new LocationRequestBroker(()=>{},()=>crypto.randomUUID()),d=new LocationDialogue(base,broker,routes);
  for(const text of ['附近 all you can eat 寿司','不吃寿司了，吃麦当劳']) {
    const at=Date.now();broker.prime({location:{latitude:41.57,longitude:-93.711,accuracyM:10,observedAt:at,receivedAt:at}} as any);
    const s=new AbortController().signal;await d.plan([],text,true,s);let answer='';await d.reply([{role:'user',content:text}],s,t=>answer+=t);assert.ok(answer);
  }
  assert.deepEqual(calls.map(c=>c.destination),['all you can eat sushi',"McDonald's"]);
  assert.equal(calls[1].nearbyPreferences.cuisineTypes,undefined);assert.equal(verifies,0);
  assert.equal(evidence[1].places[0].rating,4.3);assert.equal(evidence[1].places[0].hours.openNow,true);
  assert.equal(evidence[1].places[0].hours.closesAt,undefined);
});

test('unsupported, unavailable and empty evidence have distinct truthful responses',async()=>{
  const area={source:'requested_area' as const,labels:['Test City']};
  const base:DialogueModel={decide:async()=> 'respond',reply:async()=>{},findFoodAlternatives:async()=>[],verifyFoodService:async()=>undefined};
  const routes:RouteProvider={route:async()=>{throw Error('unused');},discover:async()=>{throw new RouteError('ROUTE_UNAVAILABLE');},verifyPlace:async c=>c};
  const report:FoodVerificationReport={outcome:'unverified',candidates:0,checked:0,failures:{}};
  await verifiedFoodAlternatives('food',area,{kind:'address',address:'Test City'},'drive',{unhandledExclusions:true},base,routes,new AbortController().signal,Date.now,report);
  assert.equal(report.outcome,'unsupported_constraints');assert.equal(report.candidates,0);
  assert.match(foodAlternativeText([],area,'drive',report),/没有完成/);
  await verifiedFoodAlternatives('food',area,{kind:'address',address:'Test City'},'drive',{},base,routes,new AbortController().signal,Date.now,report);
  assert.equal(report.outcome,'no_candidates');assert.match(foodAlternativeText([],area,'drive',report),/不能据此说/);
  await verifiedFoodAlternatives('food',area,{kind:'address',address:'Test City'},'drive',{}, {...base,findFoodAlternatives:async()=>{throw Error('network');}},routes,new AbortController().signal,Date.now,report);
  assert.equal(report.outcome,'unavailable');assert.match(foodAlternativeText([],area,'drive',report),/查询服务暂时不可用/);
});

test('unrepresentable hard constraints ask before spending on Maps, not a silent empty recommendation',async()=>{
  let calls=0;
  const base:DialogueModel={decide:async()=> 'respond',plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'restaurants',
    nearby:{mode:'recommend',taskAction:'continue',delegated:false,patch:{unhandledExclusions:true}}}),reply:async()=>{calls++;}};
  const broker=new LocationRequestBroker(()=>{calls++;},()=>crypto.randomUUID());
  const d=new LocationDialogue(base,broker,{route:async()=>{calls++;throw Error('unexpected');}}),s=new AbortController().signal;
  await d.plan([],'要纯素的真牛肉又不能有动物成分',true,s);
  let answer='';await d.reply([{role:'user',content:'要纯素的真牛肉又不能有动物成分'}],s,t=>answer+=t);
  assert.equal(calls,0);assert.match(answer,/还没有开始/);assert.match(answer,/澄清/);
});
