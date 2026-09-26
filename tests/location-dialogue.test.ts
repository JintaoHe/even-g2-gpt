import { test } from 'node:test';
import assert from 'node:assert/strict';

test('place analysis receives displayed order and review evidence without requesting GPS or Maps again', async () => {
  let turn = 0, routes = 0, answerHistory: Message[] = [], answerWorkflows: any, selectedEffort: any;
  const events: any[] = [];
  const result = { ...comparison, candidates: [...comparison.candidates].reverse() };
  const base: DialogueModel = {
    plan: async () => turn++ === 0 ? { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'restaurant' }
      : { decision: 'respond', locationAction: 'analyze_places', searchAction: 'search', reasoningEffort: 'medium', cognitiveMode: 'decision_support' },
    decide: async () => 'respond', reply: async (history, _signal, delta, _update, effort, _mode, workflows) => {
      answerHistory = history; answerWorkflows = workflows; selectedEffort = effort; delta('我会结合评价数量和你的用途分析。');
    }
  };
  const dialogue = new LocationDialogue(base, automaticBroker(events), { route: async () => { routes++; return result; } });
  const first = new AbortController().signal; await dialogue.plan([], '附近餐厅', false, first);
  let initial = ''; await dialogue.reply([{ role: 'user', content: '附近餐厅' }], first, text => { initial += text; });
  const locationCalls = events.length;
  const history: Message[] = [{ role: 'assistant', content: initial }, { role: 'user', content: '第一家第二家，查资料再评价哪家更好。' }];
  const second = new AbortController().signal; await dialogue.plan(history.slice(0, -1), history.at(-1)!.content, false, second);
  await dialogue.reply(history, second, () => {}, undefined, 'medium', 'decision_support');
  assert.equal(routes, 1); assert.equal(events.length, locationCalls); assert.equal(selectedEffort, 'medium');
  const payload = JSON.parse(answerHistory.at(-1)!.content.split('\n').at(-1)!);
  const firstShown = payload.places.find((place: any) => place.displayedOrder === 1);
  assert.equal(firstShown.placeId, 'waukee'); assert.equal(firstShown.userRatingCount, 1800);
  assert.equal(firstShown.durationSeconds, comparison.candidates[0].durationSeconds);
  assert.deepEqual(firstShown.unverifiedAttributes, ['foodService', 'quietness', 'liveliness', 'price']);
  assert.ok(payload.evidenceAt); assert.doesNotMatch(JSON.stringify(payload), /latitude|longitude|41\.58/);
  assert.deepEqual(answerWorkflows, [{ kind: 'navigation', action: 'analyze_places' }, { kind: 'search', action: 'read' }]);
  dialogue.endSession(); const third = new AbortController().signal;
  await dialogue.plan([], '再比较那两家', false, third);
  let missing = ''; await dialogue.reply([{ role: 'user', content: '再比较那两家' }], third, text => { missing += text; });
  assert.match(missing, /店名/); assert.equal(routes, 1);
});

test('cancel plus a new question clears routing but still answers the current question', async () => {
  let replies = 0, requests = 0;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'cancel' }),
    decide: async () => 'respond', reply: async (history, _signal, delta) => {
      replies++; assert.match(history.at(-1)!.content, /设计/); delta('这个设计的风险是过度收集信息。');
    } };
  const dialogue = new LocationDialogue(base, automaticBroker([]), {
    discover: async () => { requests++; throw new Error('must not discover'); },
    route: async () => { requests++; throw new Error('must not route'); }
  });
  const text = '先停止找店，帮我分析这个设计的风险。', signal = new AbortController().signal;
  await dialogue.plan([], text, false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: text }], signal, value => { answer += value; });
  assert.equal(requests, 0); assert.equal(replies, 1); assert.match(answer, /过度收集/);
});

test('recommend clarifier failure compares candidates instead of asking an internal query question', async () => {
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search',
    routeDestination: 'coffee shop', nearby: { mode: 'recommend', taskAction: 'replace', delegated: false, patch: {} } }),
    decide: async () => 'respond', reply: async () => {},
    clarifyRoute: async () => { throw new Error('max_output_tokens'); } };
  const dialogue = new LocationDialogue(base, automaticBroker([]), { route: async () => ambiguous }, 'America/Chicago', Date.now, base);
  const signal = new AbortController().signal; await dialogue.plan([], '附近有什么店', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '附近有什么店' }], signal, value => { answer += value; });
  assert.match(answer, /我先按/); assert.doesNotMatch(answer, /哪一种|coffee shop|max_output_tokens/);
});
import { LocationDialogue, routeText } from '../src/location-dialogue.js';
import { LocationRequestBroker, parseLocationReport } from '../src/location.js';
import type { DialogueModel, Message, TurnPlan } from '../src/conversation.js';
import { RouteError, type RouteComparisonResult, type RouteProvider, type RouteRequest } from '../src/routes.js';

test('lone ancillary result cannot silently satisfy a brand request', async () => {
  let routed = 0;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target' }),
    decide: async () => 'respond', reply: async (_h, _s, delta, _u, _e, _m, workflows) => {
      assert.ok(workflows?.some(w => w.kind === 'search')); delta('没有找到匹配门店，改查可核实的备选。'); } };
  const d = new LocationDialogue(base, automaticBroker([]), { searchArea: async () => ({source:'google_locality', labels:['Test City, Iowa, USA']}), discover: async () => ({ query: 'Target',
    candidates: [{ placeId: 'parking', name: 'Target Parking', primaryType: 'parking_lot' }] }),
    route: async () => { routed++; return comparison; } });
  const signal = new AbortController().signal;
  await d.plan([], '最近的 Target 在哪里', false, signal);
  let output = ''; await d.reply([{ role: 'user', content: '最近的 Target 在哪里' }], signal, t => { output += t; });
  assert.equal(routed, 0); assert.doesNotMatch(output, /到Target Parking/); assert.match(output, /没有找到/);
});

test('whole recommendation follow-up overrides repeated search, but new content and mode do not', async () => {
  let routeCalls = 0, analyses = 0;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'restaurant' }),
    decide: async () => 'respond', reply: async (history, _signal, delta) => {
      analyses++; assert.match(history.at(-1)!.content, /displayedOrder/); delta('根据已有评分和车程，我会选第一家。');
    } };
  const d = new LocationDialogue(base, automaticBroker([]), { route: async () => { routeCalls++; return comparison; } });
  const turn = async (text: string) => { const signal = new AbortController().signal;
    const plan = await d.plan([], text, false, signal); await d.reply([{ role: 'user', content: text }], signal, () => {}); return plan; };
  await turn('找附近餐馆');
  assert.equal((await turn('给我一些推荐')).locationAction, 'analyze_places');
  assert.equal((await turn('which would you recommend?')).locationAction, 'analyze_places');
  assert.equal(routeCalls, 1); assert.equal(analyses, 2);
  assert.equal((await turn('再找附近咖啡店')).locationAction, 'nearby_search');
  assert.equal((await turn('推荐哪家，另外算一下步行时间')).locationAction, 'nearby_search');
});

test('basic restaurant search defers hours refresh until explicit opening follow-up', async () => {
  let checks = 0, at = Date.now(), plans = 0;
  const base: DialogueModel = { plan: async () => plans++ ? { decision: 'respond', locationAction: 'analyze_places' }
    : { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'restaurant' },
    decide: async () => 'respond', reply: async (history, _signal, delta) => {
      assert.match(history.at(-1)!.content, plans===1 ? /maps_results/ : /openingEvidence/); delta('营业资料已查询。');
    } };
  const d = new LocationDialogue(base, automaticBroker([]), { route: async () => ({...comparison,candidates:comparison.candidates.map(c=>({...c,address:'Test City, IA'}))}),
    verifyPlace: async c => { checks++; return { ...c, hours: { source: 'google', checkedAt: at, openNow: true, closesAt: at + 3600000 } }; } },
  'America/Chicago', () => at, base);
  for (const text of ['附近餐馆', '现在还开门吗']) {
    const signal = new AbortController().signal; await d.plan([], text, false, signal);
    let output = ''; await d.reply([{ role: 'user', content: text }], signal, t => { output += t; });
    assert.match(output, /营业/); at += 121000;
  }
  assert.equal(checks, 2);
});

const id = '123e4567-e89b-12d3-a456-426614174000';

test('recommend/specific/delegated enforce bounded clarification even when the model keeps asking', async () => {
  for (const [mode, delegated, allowed] of [['recommend', false, 1], ['specific', false, 2], ['recommend', true, 0]] as const) {
    const policies: boolean[] = []; let routed = 0;
    const base: DialogueModel = {
      plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'coffee',
        nearby: { mode, delegated, taskAction: 'continue', patch: {} } }),
      decide: async () => 'respond', reply: async () => {},
      clarifyRoute: async (_q, _c, _h, _s, policy) => { policies.push(policy!.allowAsk);
        return { action: 'ask', selectedIndices: [], question: '你想找哪种店？' }; }
    };
    const dialogue = new LocationDialogue(base, automaticBroker([]), {
      discover: async () => ({ query: 'coffee', candidates: ambiguous.candidates }),
      route: async () => { routed++; return ambiguous; }
    }, 'America/Chicago', Date.now, base);
    let history: Message[] = [];
    for (let i = 0; i <= allowed; i++) {
      const text = i ? '你来建议吧' : '附近咖啡'; const signal = new AbortController().signal;
      await dialogue.plan(history, text, false, signal);
      let answer = ''; await dialogue.reply([...history, { role: 'user', content: text }], signal, value => { answer += value; });
      assert.match(answer, i < allowed ? /你想找/ : /如果不对，请纠正我/);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    }
    assert.equal(routed, 1); assert.deepEqual(policies, [...Array(allowed).fill(true), false]);
  }
});

test('nearby preference changes are field-local; task replacement and session reset discard old preferences', async () => {
  const intents: NonNullable<TurnPlan['nearby']>[] = [
    { mode: 'recommend', taskAction: 'replace', delegated: false, patch: { vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' } },
    { mode: 'recommend', taskAction: 'continue', delegated: false, patch: { vibe: null } },
    { mode: 'recommend', taskAction: 'replace', delegated: false, patch: {} },
    { mode: 'recommend', taskAction: 'continue', delegated: false, patch: {} }
  ];
  const requests: RouteRequest[] = [];
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search',
    routeDestination: 'cafe', nearby: intents.shift() }), decide: async () => 'respond', reply: async () => {} };
  const dialogue = new LocationDialogue(base, automaticBroker([]), { route: async request => { requests.push(request); return single; } });
  for (let i = 0; i < 4; i++) {
    if (i === 3) dialogue.startSession();
    const signal = new AbortController().signal; await dialogue.plan([], 'query', false, signal);
    await dialogue.reply([{ role: 'user', content: 'query' }], signal, () => {});
  }
  assert.deepEqual(requests.map(r => r.nearbyPreferences), [
    { vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' }, { needsFood: true, priceCeiling: 'moderate' }, {}, {}
  ]);
});

test('invalid model indices fail safely and cannot bypass clarification limits', async () => {
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target',
    nearby: { mode: 'recommend', taskAction: 'replace', delegated: true, patch: {} } }),
    decide: async () => 'respond', reply: async () => {}, clarifyRoute: async () => ({ action: 'proceed', selectedIndices: [999] }) };
  const dialogue = new LocationDialogue(base, automaticBroker([]), { discover: async () => ({ query: 'Target', candidates: ambiguous.candidates }),
    route: async request => { assert.equal(request.candidates?.length, 2);
      assert.ok(request.candidates?.every(c => c.primaryType !== 'parking_lot')); return ambiguous; } },
  'America/Chicago', Date.now, base);
  const signal = new AbortController().signal; await dialogue.plan([], '你选吧', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '你选吧' }], signal, value => { answer += value; });
  assert.match(answer, /如果不对，请纠正我/); assert.doesNotMatch(answer, /999|无法/);
});

test('exclusions enter alternative research without relaxing or relabeling the reason', async () => {
  for (const reason of ['price', 'closed'] as const) {
    const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'cafe' }),
      decide: async () => 'respond', reply: async (history, _signal, delta, _update, _effort, _mode, workflows) => {
        const evidence = JSON.parse(history.at(-1)!.content.split('\n').at(-1)!);
        assert.equal(evidence.excluded[0].reason, reason);
        assert.equal(evidence.outcome, 'ROUTE_NO_MATCHING_PLACES');
        assert.ok(workflows?.[0].searchArea);
        assert.deepEqual(workflows?.map(({searchArea, ...w}) => w), [{ kind: 'navigation', action: 'fallback_search' }, { kind: 'search', action: 'read' }]);
        delta(reason === 'closed' ? '已关门，正在核实其他方案。' : '价位不符合，正在核实其他方案。');
      } };
    const dialogue = new LocationDialogue(base, automaticBroker([]), { route: async () => { throw new RouteError(
      'ROUTE_NO_MATCHING_PLACES', 'ROUTE_NO_MATCHING_PLACES', 'places', undefined, false, undefined,
      [{ placeId: 'test', name: 'Synthetic shop', address: '10 Example Street, Test City, Iowa', reason }]); } });
    const signal = new AbortController().signal; await dialogue.plan([], 'cafe', false, signal);
    let answer = ''; await dialogue.reply([], signal, value => { answer += value; });
    if (reason === 'price') assert.doesNotMatch(answer, /关门/); else assert.match(answer, /已关门/);
  }
});

test('nearby display shows unknown hours/price and does not claim weak atmosphere priors as fact', () => {
  const output = routeText({ ...single, nearbyPreferences: { vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' } }, 'America/Chicago', true);
  assert.match(output, /营业时间待确认/); assert.match(output, /价位待确认/); assert.match(output, /评分不能证明/);
  assert.doesNotMatch(output, /很安静|保证|4\.9★/);
});

test('comparison may suggest a store but never claims user selection or executed action', () => {
  const output = routeText(comparison, 'America/Chicago', true);
  assert.match(output, /时间比较/); assert.match(output, /Google Maps/);
  assert.match(output, /建议/);
  assert.doesNotMatch(output, /你已选择|已为你选定|已预订|已开始导航|你要去/);
});
const single: RouteComparisonResult = { query: 'West Des Moines Costco', recommendedPlaceId: 'costco', recommendationBasis: 'fastest',
  mode: 'drive', trafficAware: true, candidates: [{ placeId: 'costco', name: 'West Des Moines Costco', durationSeconds: 1200,
    address: '10 Example Street, Test City, Iowa', staticDurationSeconds: 1020, distanceMeters: 16093, rating: 4.4, userRatingCount: 800,
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
  const dialogue = new LocationDialogue(base, automaticBroker(events), {
    discover: async () => ({ query: 'Breakfast Club', candidates: result.candidates,
      excluded: [{ placeId: 'closed', name: 'Closed Cafe', reason: 'closed' }] }),
    route: async () => result
  }, 'America/Chicago', () => 123456789);
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
  assert.match(replyHistory.at(-1)!.content, /"evidenceAt":123456789/);
  assert.match(replyHistory.at(-1)!.content, /"name":"Closed Cafe","reason":"closed"/);
  assert.doesNotMatch(JSON.stringify(replyHistory), /41\.58|-93\.62/);
});

test('unsupported exclusions are disclosed and invalid-patch telemetry contains only a count', async () => {
  const metrics: unknown[] = [];
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search',
    routeDestination: 'restaurant', nearby: { mode: 'recommend', taskAction: 'replace', delegated: false,
      patch: { unhandledExclusions: true }, invalidPatchCount: 2 } }),
    decide: async () => 'respond', reply: async () => {} };
  const dialogue = new LocationDialogue(base, automaticBroker([]), {
    route: async request => ({ ...single, nearbyPreferences: request.nearbyPreferences })
  }, 'America/Chicago', Date.now, undefined, (event, count) => { metrics.push([event, count]); });
  const signal = new AbortController().signal; await dialogue.plan([], '附近餐馆', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '附近餐馆' }], signal, value => { answer += value; });
  assert.match(answer, /部分排除条件无法.*核实/); assert.deepEqual(metrics, [['invalid_patch', 2]]);
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

test('duplicate place names in the same city use street addresses in choices and recommendation', () => {
  const result: RouteComparisonResult = { ...comparison, candidates: [
    { ...comparison.candidates[0], name: 'Target', address: '5405 Mills Civic Pkwy, West Des Moines, IA 50266, USA' },
    { ...comparison.candidates[1], name: 'Target', address: '1800 Valley West Dr, West Des Moines, IA 50266, USA' }
  ] };
  const answer = routeText(result, 'America/Chicago', true);
  assert.match(answer, /Target · 5405 Mills Civic Pkwy, West Des Moines · 11分/);
  assert.match(answer, /Target · 1800 Valley West Dr, West Des Moines · 13分/);
  assert.match(answer, /建议 Target · 5405 Mills Civic Pkwy, West Des Moines/);
  assert.doesNotMatch(answer, /1\. Target · West Des Moines ·/);
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

test('mixed place purposes ask before Routes and clarify by selection without concatenating the reply', async () => {
  const events: any[] = []; const requests: RouteRequest[] = []; let planCall = 0, routeCalls = 0, discoverCalls = 0, clarifyCalls = 0;
  const base: DialogueModel = {
    plan: async () => planCall++ === 0
      ? { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'Target', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }
      : { decision: 'respond', locationAction: 'nearby_search', routeDestination: 'department store', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false },
    decide: async () => 'respond', reply: async () => {},
    clarifyRoute: async () => { clarifyCalls++; return clarifyCalls === 1
      ? { action: 'ask', selectedIndices: [], question: '你指 Target 门店、Target Mobile，还是 Target 停车场？' }
      : { action: 'proceed', selectedIndices: [0] }; }
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
  assert.equal(requests[0].destination, 'Target'); assert.match(answer, /Target/); assert.equal(routeCalls, 1);
  assert.equal(discoverCalls, 1); assert.equal(requests[0].candidates?.length, 1);
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
  const dialogue = new LocationDialogue(base, automaticBroker([]), { searchArea: async () => ({source:'google_locality', labels:['Test City, Iowa, USA']}), route: async () => {
    throw new RouteError('ROUTE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', 'places', 403, false, 'API_KEY_IP_ADDRESS_BLOCKED');
  } });
  const signal = new AbortController().signal; await dialogue.plan([], '去 Target 多久', false, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '去 Target 多久' }], signal, text => { answer += text; }, event => events.push(event));
  assert.match(answer, /不会冒充实时 ETA/);
  assert.ok(fallbackWorkflows?.[0].searchArea);
  assert.deepEqual(fallbackWorkflows?.map(({searchArea, ...w}) => w), [{ kind: 'navigation', action: 'fallback_search' }, { kind: 'search', action: 'read' }]);
  assert.deepEqual(events.find(event => event.status === 'failed'), { type: 'route.status', status: 'failed', stage: 'places',
    provider_status: 403, provider_reason: 'API_KEY_IP_ADDRESS_BLOCKED' });
  assert.ok(!JSON.stringify(events).includes('41.58'));
});

test('empty maps results research alternatives once, without raw GPS or write workflows', async () => {
  let calls = 0;
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', locationAction: 'nearby_search', routeDestination: 'late dinner' }),
    decide: async () => 'respond', reply: async (history, _signal, delta, _update, _effort, _mode, workflows) => {
      calls++; const content = history.at(-1)!.content;
      assert.match(content, /ROUTE_DESTINATION_NOT_FOUND/);assert.doesNotMatch(content, /41\.58|-93\.62|latitude|longitude/);
      assert.ok(workflows?.[0].searchArea);
      assert.deepEqual(workflows?.map(({searchArea, ...w}) => w), [{kind:'navigation',action:'fallback_search'},{kind:'search',action:'read'}]);delta('已查询备选。');
    } };
  const d = new LocationDialogue(base, automaticBroker([]), {searchArea:async()=>({source:'google_locality',labels:['Test City, Iowa, USA']}), route:async()=>{throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');}});
  const signal=new AbortController().signal;await d.plan([], '找晚餐',false,signal);
  await d.reply([{role:'user',content:'找晚餐'}],signal,()=>{},undefined,undefined,undefined,[{kind:'calendar',action:'create'}]);
  assert.equal(calls,1);
});

test('open alcohol shop still requires activity/local-rule verification; fallback failure is not retried', async () => {
  let calls=0;const now=Date.now();
  const base:DialogueModel={plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'beer'}),
    decide:async()=> 'respond',reply:async(history)=>{calls++;assert.match(history.at(-1)!.content,/suitability_unverified/);throw Error('research failed');}};
  const d=new LocationDialogue(base,automaticBroker([]),{route:async()=>({...single,query:'beer',candidates:[{...single.candidates[0],
    address:'10 Example Street, Test City',hours:{checkedAt:now,openNow:true,closesAt:now+3600000,source:'google'}}]}),verifyPlace:async c=>c});
  const signal=new AbortController().signal;await d.plan([], '买啤酒',false,signal);
  await assert.rejects(d.reply([{role:'user',content:'买啤酒'}],signal,()=>{}),/research failed/);assert.equal(calls,1);
});

test('unknown restaurant kitchen evidence is researched instead of asking user to check it', async()=>{
  let calls=0;const now=Date.now();
  const base:DialogueModel={plan:async()=>({decision:'respond',locationAction:'nearby_search',routeDestination:'restaurant'}),
    decide:async()=> 'respond',reply:async(_h,_s,delta)=>{calls++;delta('核验厨房与备选。');}};
  const d=new LocationDialogue(base,automaticBroker([]),{route:async()=>({...single,query:'restaurant',candidates:[{...single.candidates[0],
    hours:{checkedAt:now,openNow:true,closesAt:now+3600000,source:'google'}}]}),verifyPlace:async c=>c});
  const signal=new AbortController().signal;await d.plan([], '找餐馆',false,signal);let answer='';
  await d.reply([{role:'user',content:'找餐馆'}],signal,t=>answer+=t);assert.equal(calls,1);assert.doesNotMatch(answer,/向店家确认/);
});
