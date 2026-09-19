import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocationDialogue, routeText } from '../src/location-dialogue.js';
import { LocationRequestBroker, parseLocationReport } from '../src/location.js';
import type { DialogueModel, Message, TurnPlan } from '../src/conversation.js';
import { RouteError, type RouteComparisonResult, type RouteProvider, type RouteRequest } from '../src/routes.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const single: RouteComparisonResult = { query: 'West Des Moines Costco', recommendedPlaceId: 'costco', recommendationBasis: 'fastest',
  mode: 'drive', trafficAware: true, candidates: [{ placeId: 'costco', name: 'West Des Moines Costco', durationSeconds: 1200,
    staticDurationSeconds: 1020, distanceMeters: 16093, rating: 4.4, userRatingCount: 800,
    quality: { adjustedRating: 4.38, reliable: true, risk: false } }] };
const comparison: RouteComparisonResult = { query: 'Target', recommendedPlaceId: 'waukee', recommendationBasis: 'fastest',
  mode: 'drive', trafficAware: true, candidates: [
    { placeId: 'waukee', name: 'Waukee Target', durationSeconds: 660, staticDurationSeconds: 420, distanceMeters: 8369,
      rating: 4.5, userRatingCount: 1800, quality: { adjustedRating: 4.49, reliable: true, risk: false } },
    { placeId: 'west', name: 'West Des Moines Target', durationSeconds: 780, staticDurationSeconds: 780, distanceMeters: 12_553,
      rating: 3.8, userRatingCount: 640, quality: { adjustedRating: 3.81, reliable: true, risk: false } }
  ] };
const ambiguous: RouteComparisonResult = { query: 'Target', recommendedPlaceId: 'store', recommendationBasis: 'fastest',
  mode: 'drive', trafficAware: true, candidates: [
    { placeId: 'store', name: 'Target', primaryType: 'department_store', types: ['department_store'],
      durationSeconds: 600, staticDurationSeconds: 600, distanceMeters: 5000, quality: { reliable: false, risk: false } },
    { placeId: 'mobile', name: 'Target Mobile', primaryType: 'cell_phone_store', types: ['cell_phone_store'],
      durationSeconds: 540, staticDurationSeconds: 540, distanceMeters: 4800, quality: { reliable: false, risk: false } },
    { placeId: 'parking', name: 'Target Parking', primaryType: 'parking_lot', types: ['parking_lot'],
      durationSeconds: 570, staticDurationSeconds: 570, distanceMeters: 4900, quality: { reliable: false, risk: false } }
  ] };

function automaticBroker(events: any[]) {
  let broker!: LocationRequestBroker;
  broker = new LocationRequestBroker(event => {
    events.push(event);
    if (event.type === 'location.request') setImmediate(() => broker.accept(parseLocationReport({ type: 'location.report', mode: 'once',
      request_id: event.request_id, location: { latitude: 41.58, longitude: -93.62, accuracy: 18, timestamp: Date.now() } })));
  }, () => id, 1000);
  return broker;
}

test('route dialogue keeps a fresh fix for the session and clears it only at session end', async () => {
  const events: any[] = []; let routed: RouteRequest | undefined;
  const plan: TurnPlan = { decision: 'respond', locationAction: 'route_eta', routeDestination: 'West Des Moines Costco',
    routeOrigin: null, routeMode: 'drive', routeModeExplicit: false };
  const base: DialogueModel = { plan: async () => plan, decide: async () => 'respond', reply: async () => { throw new Error('unused'); } };
  const routes: RouteProvider = { route: async request => { routed = request; return single; } };
  const dialogue = new LocationDialogue(base, automaticBroker(events), routes);
  const signal = new AbortController().signal; await dialogue.plan([], 'how long', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: 'how long' }], signal, text => { answer += text; });
  assert.equal(routed?.origin.kind, 'coordinates'); assert.match(answer, /20分钟/); assert.match(answer, /10\.0英里（16\.1公里）/); assert.match(answer, /拥堵/);
  assert.match(answer, /^从当前位置驾车到/);
  assert.match(answer, /Google Maps/); assert.ok(events.some(event => event.type === 'location.request'));
  assert.equal(events.some(event => event.state === 'cleared'), false); assert.ok(!answer.includes('41.58')); assert.ok(!JSON.stringify(events).includes('41.58'));
  dialogue.endSession(); assert.equal(events.at(-1).state, 'cleared');
});

test('nearby search renders two compact choices, rating evidence and a recommendation without navigation prompt', async () => {
  const events: any[] = []; let routed: RouteRequest | undefined;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target',
    routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }), decide: async () => 'respond', reply: async () => {} };
  const dialogue = new LocationDialogue(base, automaticBroker(events), { route: async request => { routed = request; return comparison; } });
  const signal = new AbortController().signal; await dialogue.plan([], '附近有几个 Target', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '附近有几个 Target' }], signal, value => { answer += value; });
  assert.equal(routed?.kind, 'nearby'); assert.match(answer, /默认按驾车时间比较/); assert.match(answer, /4\.5★（1800）/);
  assert.match(answer, /建议 Waukee Target/); assert.match(answer, /评分来源：Google Maps/);
  assert.doesNotMatch(answer, /你想去哪|要选|导航/);
});

test('later ordinary questions receive recent place facts for the whole session without raw coordinates', async () => {
  const events: any[] = []; let turn = 0; let replyHistory: Message[] = [];
  const result: RouteComparisonResult = { ...single, query: 'Breakfast Club', recommendedPlaceId: 'breakfast', candidates: [{
    ...single.candidates[0], placeId: 'breakfast', name: 'The Breakfast Club',
    address: '123 Main Street, Ames, IA 50010, USA', primaryType: 'breakfast_restaurant'
  }] };
  const base: DialogueModel = {
    plan: async () => turn++ === 0
      ? { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'breakfast', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }
      : { decision: 'respond', locationAction: 'none' },
    decide: async () => 'respond',
    reply: async (history, _signal, delta) => { replyHistory = history; delta('可以继续介绍菜单。'); }
  };
  const dialogue = new LocationDialogue(base, automaticBroker(events), { route: async () => result });
  const firstSignal = new AbortController().signal;
  await dialogue.plan([], '附近有什么早餐', false, firstSignal);
  await dialogue.reply([{ role: 'user', content: '附近有什么早餐' }], firstSignal, () => {});
  const history: Message[] = [
    { role: 'user', content: '附近有什么早餐', topicId: 'topic-1' },
    { role: 'assistant', content: '建议 The Breakfast Club。', topicId: 'topic-1' },
    { role: 'user', content: '明天把早餐加到日历', topicId: 'topic-2' },
    { role: 'assistant', content: '已保存日程。', topicId: 'topic-2' },
    { role: 'user', content: '你刚刚推荐的那家有什么好吃的？', topicId: 'topic-2' }
  ];
  const secondSignal = new AbortController().signal;
  await dialogue.plan(history.slice(0, -1), history.at(-1)!.content, false, secondSignal);
  await dialogue.reply(history, secondSignal, () => {});
  assert.match(replyHistory.at(-1)!.content, /Application-provided read-only place context/);
  assert.match(replyHistory.at(-1)!.content, /123 Main Street, Ames/);
  assert.doesNotMatch(JSON.stringify(replyHistory), /41\.58|-93\.62/);
});

test('duplicate place names use a compact city label in choices and recommendation', () => {
  const result: RouteComparisonResult = { ...comparison, candidates: [
    { ...comparison.candidates[0], name: 'Target', address: '5901 Mills Civic Pkwy, West Des Moines, IA 50266, USA' },
    { ...comparison.candidates[1], name: 'Target', address: '900 E Hickman Rd, Waukee, IA 50263, USA' }
  ] };
  const answer = routeText(result, 'America/Chicago', true);
  assert.match(answer, /Target · West Des Moines · 11分 · 5\.2英里（8\.4公里）/);
  assert.match(answer, /Target · Waukee · 13分 · 7\.8英里（12\.6公里）/);
  assert.match(answer, /建议 Target · West Des Moines/);
});

test('long routes use hours and always display both miles and kilometres', () => {
  const long: RouteComparisonResult = { query: 'ORD', recommendedPlaceId: 'ord', recommendationBasis: 'fastest',
    mode: 'drive', trafficAware: true, candidates: [{ placeId: 'ord', name: "Chicago O'Hare International Airport",
      durationSeconds: 288 * 60, staticDurationSeconds: 284 * 60, distanceMeters: 329.3 * 1609.344,
      quality: { reliable: false, risk: false } }] };
  const us = routeText(long, 'America/Chicago', false);
  const metric = routeText(long, 'Europe/London', false);
  assert.match(us, /4小时48分钟/); assert.match(us, /329\.3英里（530公里）/);
  assert.match(metric, /530公里（329\.3英里）/); assert.doesNotMatch(us, /288分钟/);
});

test('temporary event falls back to one public web resolution and revalidates the venue in Places', async () => {
  const events: any[] = []; const discoveries: string[] = []; let resolvedQuery = '';
  const base: DialogueModel = {
    plan: async () => ({ decision: 'respond', locationAction: 'route_eta',
      routeDestination: 'Hot Rods for Heroes car show, Ankeny', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }),
    decide: async () => 'respond', reply: async () => {},
    resolveRoute: async (query, history) => {
      resolvedQuery = query;
      assert.equal(history.at(-1)?.content, '从这里去刚才的车展多久？');
      return { action: 'resolved', destination: 'DMACC Ankeny Campus, Ankeny, Iowa' };
    }
  };
  const venue = { placeId: 'dmacc', name: 'DMACC Ankeny Campus', address: '2006 S Ankeny Blvd, Ankeny, IA 50023, USA' };
  const routes: RouteProvider = {
    discover: async request => {
      discoveries.push(request.destination);
      if (discoveries.length === 1) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
      return { query: request.destination, candidates: [venue] };
    },
    route: async request => ({ ...single, query: request.destination, candidates: [{ ...single.candidates[0],
      placeId: venue.placeId, name: venue.name, address: venue.address }], recommendedPlaceId: venue.placeId })
  };
  const dialogue = new LocationDialogue(base, automaticBroker(events), routes, 'America/Chicago', Date.now, base);
  const history: Message[] = [{ role: 'assistant', content: '车展在 DMACC Ankeny 校区。' }];
  const signal = new AbortController().signal; await dialogue.plan(history, '从这里去刚才的车展多久？', false, signal);
  let answer = ''; await dialogue.reply([...history, { role: 'user', content: '从这里去刚才的车展多久？' }], signal, text => { answer += text; });
  assert.equal(resolvedQuery, 'Hot Rods for Heroes car show, Ankeny');
  assert.deepEqual(discoveries, ['Hot Rods for Heroes car show, Ankeny', 'DMACC Ankeny Campus, Ankeny, Iowa']);
  assert.match(answer, /DMACC Ankeny Campus/);
});

test('mixed place purposes ask Luna before Routes and the reply resumes with a self-contained destination', async () => {
  const events: any[] = []; const requests: RouteRequest[] = []; let planCall = 0, routeCalls = 0, discoverCalls = 0, clarifyCalls = 0;
  const base: DialogueModel = {
    plan: async () => planCall++ === 0
      ? { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }
      : { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'department store', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false },
    decide: async () => 'respond', reply: async () => {},
    clarifyRoute: async () => { clarifyCalls++; return { action: 'ask', selectedIndices: [], question: '你指 Target 门店、Target Mobile，还是 Target 停车场？' }; }
  };
  const routes: RouteProvider = {
    discover: async request => ({ query: request.destination, candidates: discoverCalls++ === 0
      ? ambiguous.candidates.map(({ durationSeconds, staticDurationSeconds, distanceMeters, quality, ...candidate }) => candidate)
      : comparison.candidates.map(({ durationSeconds, staticDurationSeconds, distanceMeters, quality, ...candidate }) => candidate) }),
    route: async request => { routeCalls++; requests.push(request); return comparison; }
  };
  const dialogue = new LocationDialogue(base, automaticBroker(events), routes, 'America/Chicago', Date.now, base);
  let history: Message[] = [], signal = new AbortController().signal;
  await dialogue.plan(history, '去 Target 要多久', false, signal);
  let question = ''; await dialogue.reply([{ role: 'user', content: '去 Target 要多久' }], signal, value => { question += value; });
  assert.equal(question, '你指 Target 门店、Target Mobile，还是 Target 停车场？'); assert.equal(clarifyCalls, 1);
  assert.equal(routeCalls, 0);
  assert.equal(events.some(event => event.state === 'cleared'), false);
  history = [{ role: 'user', content: '去 Target 要多久' }, { role: 'assistant', content: question }];
  signal = new AbortController().signal; await dialogue.plan(history, '普通的超市', false, signal);
  let answer = ''; await dialogue.reply([...history, { role: 'user', content: '普通的超市' }], signal, value => { answer += value; });
  assert.equal(requests[0].destination, 'Target department store'); assert.match(answer, /Target/); assert.equal(routeCalls, 1);
  assert.equal(events.filter(event => event.type === 'location.request').length, 1);
});

test('an explicit parking intent lets Luna select the parking candidate without asking', async () => {
  const events: any[] = []; let clarifyingStatus = false;
  const base: DialogueModel = {
    plan: async () => ({ decision: 'respond', locationAction: 'route_eta', routeDestination: 'Target parking lot',
      routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }),
    decide: async () => 'respond', reply: async () => {},
    clarifyRoute: async () => ({ action: 'proceed', selectedIndices: [2] })
  };
  const dialogue = new LocationDialogue(base, automaticBroker(events), { route: async () => ambiguous },
    'America/Chicago', Date.now, base);
  const signal = new AbortController().signal; await dialogue.plan([], '去 Target 停车场', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '去 Target 停车场' }], signal, value => { answer += value; },
    event => { if (event.type === 'route.status' && event.status === 'clarifying') clarifyingStatus = true; });
  assert.equal(clarifyingStatus, true); assert.match(answer, /Target Parking/); assert.doesNotMatch(answer, /你指|Mobile/);
});

test('spoken follow-up mode reuses recent Place IDs but does not leak into an unrelated route', async () => {
  const events: any[] = []; const requests: RouteRequest[] = []; let calls = 0;
  const plans: TurnPlan[] = [
    { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false },
    { decision: 'respond', locationAction: 'recompare', routeDestination: null, routeOrigin: null, routeMode: 'walk', routeModeExplicit: true },
    { decision: 'respond', locationAction: 'route_eta', routeDestination: 'Library', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }
  ];
  const base: DialogueModel = { plan: async () => plans[calls++], decide: async () => 'respond', reply: async () => {} };
  const routes: RouteProvider = { route: async request => {
    requests.push(request);
    if (requests.length === 1) return comparison;
    return { ...comparison, query: request.destination, mode: request.mode, trafficAware: false,
      candidates: comparison.candidates.map(candidate => ({ ...candidate, staticDurationSeconds: undefined })) };
  } };
  const dialogue = new LocationDialogue(base, automaticBroker(events), routes);
  let history: Message[] = [];
  for (const text of ['附近 Target', '那走路呢', '去图书馆多久']) {
    const signal = new AbortController().signal; const plan = await dialogue.plan(history, text, false, signal);
    let answer = ''; await dialogue.reply([...history, { role: 'user', content: text }], signal, value => { answer += value; });
    history = [...history, { role: 'user', content: text }, { role: 'assistant', content: answer }];
    if (text === '那走路呢') { assert.equal(plan.routeMode, 'walk'); assert.match(answer, /按步行时间比较/); assert.doesNotMatch(answer, /拥堵|实时路况/); }
  }
  assert.equal(requests[1].mode, 'walk'); assert.deepEqual(requests[1].candidates?.map(value => value.placeId), ['waukee', 'west']);
  assert.equal(requests[2].mode, 'drive'); assert.equal(events.filter(event => event.type === 'location.request').length, 1);
});

test('manual mode selection changes the session preference without model inference', async () => {
  const events: any[] = []; let routed: RouteRequest | undefined;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'route_eta', routeDestination: 'Costco',
    routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }), decide: async () => 'respond', reply: async () => {} };
  const dialogue = new LocationDialogue(base, automaticBroker(events), { route: async request => { routed = request; return { ...single, mode: request.mode, trafficAware: false }; } });
  dialogue.setPreferredMode('bicycle');
  const signal = new AbortController().signal; await dialogue.plan([], '去 Costco', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '去 Costco' }], signal, value => { answer += value; });
  assert.equal(routed?.mode, 'bicycle'); assert.match(answer, /骑车到/);
});

test('after three client attempts fail, spoken or typed origin resumes the pending route', async () => {
  const events: any[] = []; let broker!: LocationRequestBroker, calls = 0, routed: RouteRequest | undefined;
  broker = new LocationRequestBroker(event => {
    events.push(event);
    if (event.type === 'location.request') setImmediate(() => broker.fail({ type: 'location.failed', request_id: event.request_id, reason: 'unavailable' }));
  }, () => id, 1000);
  const base: DialogueModel = {
    plan: async () => calls++ === 0
      ? { decision: 'respond', locationAction: 'route_eta', routeDestination: 'Costco', routeOrigin: null, routeMode: 'walk', routeModeExplicit: true }
      : { decision: 'respond', locationAction: 'none' },
    decide: async () => 'respond', reply: async () => { throw new Error('unused'); }
  };
  const routes: RouteProvider = { route: async request => { routed = request; return { ...single, query: 'Costco', candidates: [{ ...single.candidates[0], name: 'Costco' }] }; } };
  const dialogue = new LocationDialogue(base, broker, routes);
  let signal = new AbortController().signal; await dialogue.plan([], 'Costco多久', false, signal);
  let prompt = ''; await dialogue.reply([{ role: 'user', content: 'Costco多久' }], signal, text => { prompt += text; });
  assert.match(prompt, /输入出发地址/);
  const history: Message[] = [{ role: 'user', content: 'Costco多久' }, { role: 'assistant', content: prompt }];
  signal = new AbortController().signal; await dialogue.plan(history, 'Des Moines, Iowa', false, signal);
  let answer = ''; await dialogue.reply([...history, { role: 'user', content: 'Des Moines, Iowa' }], signal, text => { answer += text; });
  assert.deepEqual(routed?.origin, { kind: 'address', address: 'Des Moines, Iowa' }); assert.equal(routed?.mode, 'walk');
  assert.match(answer, /^从Des Moines, Iowa.+到Costco/);
});

test('route failure reports safe diagnostics and falls back to Luna web research without GPS', async () => {
  const events: any[] = []; let fallbackWorkflows: any[] | undefined;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'route_eta', routeDestination: 'Target',
    routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }), decide: async () => 'respond',
    reply: async (_history, _signal, delta, _update, _effort, _mode, workflows) => {
      fallbackWorkflows = workflows; delta('Google 路线暂不可核实；我可以查公共地点信息，但不会冒充实时 ETA。');
    } };
  const dialogue = new LocationDialogue(base, automaticBroker([]), { route: async () => {
    throw new RouteError('ROUTE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', 'places', 403, false, 'API_KEY_IP_ADDRESS_BLOCKED');
  } });
  const signal = new AbortController().signal; await dialogue.plan([], '去 Target 多久', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '去 Target 多久' }], signal, text => { answer += text; }, event => events.push(event));
  assert.match(answer, /不会冒充实时 ETA/);
  assert.deepEqual(fallbackWorkflows, [{ kind: 'navigation', action: 'fallback_search' }, { kind: 'search', action: 'read' }]);
  assert.deepEqual(events.find(event => event.status === 'failed'), { type: 'route.status', status: 'failed', stage: 'places',
    provider_status: 403, provider_reason: 'API_KEY_IP_ADDRESS_BLOCKED' });
  assert.ok(!JSON.stringify(events).includes('41.58'));
});
