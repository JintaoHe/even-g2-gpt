// Opt-in, public synthetic locations only. No SMTP/Calendar, production socket, or GPS capture.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { CostLedger, GOOGLE_SKUS } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch, openAIPricing } from '../src/metered-openai.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { GoogleRoutesProvider, RouteError } from '../src/routes.js';
import { applyNearbyIntent } from '../src/nearby-intent.js';
import type { Message } from '../src/conversation.js';
import type { TurnPlan } from '../src/conversation.js';

const previousCafe: Message[] = [
  { role: 'user', content: '找附近安静的咖啡馆，同事要吃午饭，价位适中。' },
  { role: 'assistant', content: '我会按咖啡馆、安静、需要供餐、价位适中这些条件比较。' }
];
// Held-out wording: invented independently of the three implementation examples.
const novelCases: { id: string; text: string; history?: Message[]; check: (plan: TurnPlan) => void }[] = [
  { id: 'bilingual-food-for-companion', text: 'Find a coffee shop nearby，姐姐还没吃午饭，我只想喝杯拿铁，找能照顾她的。', check: p => {
    assert.equal(p.locationAction, 'nearby_search'); assert.equal(p.nearby?.patch.needsFood, true);
  } },
  { id: 'remove-price-only', history: previousCafe, text: '预算先不用管，安静和吃饭这两条还要保留。', check: p => {
    assert.equal(p.nearby?.taskAction, 'continue'); assert.equal(p.nearby?.patch.priceCeiling, null);
    assert.deepEqual(applyNearbyIntent({ vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' }, p.nearby!),
      { vibe: 'quiet', needsFood: true });
  } },
  { id: 'switch-task-not-string', history: previousCafe, text: 'Forget the cafe for now，我要去附近买打印纸，帮我比较几个办公用品店。', check: p => {
    assert.equal(p.locationAction, 'nearby_search'); assert.equal(p.nearby?.taskAction, 'replace');
    const prefs = applyNearbyIntent({ vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' }, p.nearby!);
    assert.equal(prefs.vibe, undefined); assert.equal(prefs.needsFood, undefined);
  } },
  { id: 'future-opening-not-now', text: '下周二早上去附近的面包店，比较一下骑车时间，现在没开门也没关系。', check: p => {
    assert.equal(p.locationAction, 'nearby_search'); assert.equal(p.nearby?.patch.visitTime, 'future');
    assert.equal(p.routeMode, 'bicycle'); assert.equal(p.routeModeExplicit, true);
  } },
  { id: 'delegation-with-constraints', history: previousCafe, text: 'You choose，但仍然要能吃东西，价位适中别变。', check: p => {
    assert.equal(p.nearby?.delegated, true); assert.equal(p.nearby?.mode, 'recommend');
    const prefs = applyNearbyIntent({ needsFood: true, priceCeiling: 'moderate' }, p.nearby!);
    assert.equal(prefs.needsFood, true); assert.equal(prefs.priceCeiling, 'moderate');
  } },
  { id: 'negated-delegation', text: 'Compare nearby grocery stores，但先别替我选，我自己看时间和评价再决定。', check: p => {
    assert.equal(p.locationAction, 'nearby_search'); assert.equal(p.nearby?.delegated, false);
  } },
  { id: 'explicit-parking-not-store', text: '去附近 Target 的停车场，不是进去逛商店，走过去要多久？', check: p => {
    assert.ok(['route_eta', 'nearby_search'].includes(p.locationAction!)); assert.equal(p.routeMode, 'walk');
    assert.match(p.routeDestination!, /parking|停车/i);
  } },
  { id: 'quoted-route-is-not-intent', history: previousCafe,
    text: '先暂停找店。我在写一个哲学随笔：一个人说“帮我选附近餐厅”，是不是在让渡自主权？请分析，不要找餐厅。', check: p => {
      assert.ok(['none', 'cancel'].includes(p.locationAction!)); assert.equal(p.nearby, undefined);
    } }
];

async function main() {
  if (process.env.RUN_LIVE_NEARBY !== '1') throw new Error('OPT_IN_REQUIRED');
  if (!process.env.OPENAI_API_KEY || !process.env.GOOGLE_MAPS_API_KEY) throw new Error('KEYS_MISSING');
  // CostLedger is a single-writer store. Never compete with the local backend.
  const listening = await new Promise<boolean>(resolveCheck => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.CONVERSATION_PORT ?? 3001) });
    socket.once('connect', () => { socket.destroy(); resolveCheck(true); });
    socket.once('error', () => resolveCheck(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolveCheck(true); });
  });
  if (listening) throw new Error('STOP_LOCAL_BACKEND_BEFORE_LIVE_EVAL');
  const ledger = await CostLedger.create(resolve(process.env.EVEN_DATA_DIR ?? '.local', 'cost-ledger.json'), process.env);
  const pricing = openAIPricing();
  let reservedUpperUsd = 0, calls = 0;
  const boundedFetch: typeof fetch = async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body ?? '{}'));
    let maximum: number;
    if (url === 'https://api.openai.com/v1/responses') {
      if (body.tools !== undefined) {
        assert.ok(process.argv.includes('--analysis-search')); assert.deepEqual(body.tools, [{ type: 'web_search', search_context_size: 'low' }]);
        assert.equal(body.max_tool_calls, 1);
      }
      maximum = (Buffer.byteLength(String(init?.body)) * Math.max(pricing.inputPerMillion, pricing.cacheWritePerMillion)
        + Number(body.max_output_tokens) * pricing.outputPerMillion) / 1_000_000
        + (body.tools ? Math.max(0.02, pricing.webSearchPerCall) : 0);
    } else if (url === 'https://places.googleapis.com/v1/places:searchText') {
      maximum = GOOGLE_SKUS['places-text-search-enterprise'].usdPerThousand / 1000;
    } else if (url === 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix') {
      maximum = body.origins.length * body.destinations.length * GOOGLE_SKUS['route-matrix-pro'].usdPerThousand / 1000;
    } else throw new Error('UNEXPECTED_ENDPOINT');
    if (!Number.isFinite(maximum) || maximum < 0 || reservedUpperUsd + maximum > 0.50 || calls >= 18) throw new Error('LIVE_RUN_BUDGET');
    reservedUpperUsd += maximum; calls++;
    const response = await fetch(input, init);
    if (!response.ok) console.log(JSON.stringify({ event: 'live_provider_status', status: response.status }));
    if (body.text?.format?.name === 'route_place_clarification') {
      const result = await response.clone().json() as any;
      console.log(JSON.stringify({ event: 'clarification_response', status: result.status,
        outputTokens: result.usage?.output_tokens,
        reasoningTokens: result.usage?.output_tokens_details?.reasoning_tokens }));
    }
    return response;
  };
  const { model } = createHybridDialogue(process.env.OPENAI_API_KEY, { ...process.env, GOOGLE_MAPS_ENABLED: 'true',
    ...(process.argv.includes('--analysis-search') ? { OPENAI_MAX_SEARCH_CALLS: '1' } : {}),
    GOOGLE_CALENDAR_ENABLED: 'false', EVEN_DELIVERY_ROUTING: 'false', EVEN_EMAIL_ENABLED: 'false' },
  { search: process.argv.includes('--analysis-regressions') || process.argv.includes('--analysis-search'), fetcher: createMeteredOpenAIFetch(ledger, process.env, boundedFetch) });
  const routes = new GoogleRoutesProvider(process.env.GOOGLE_MAPS_API_KEY, boundedFetch, undefined, undefined, ledger);
  const origin = { kind: 'coordinates' as const, location: { latitude: 41.570, longitude: -93.711,
    accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() } }; // Public synthetic Valley Junction vicinity.
  let failed = 0;
  try {
    if (process.argv.includes('--evidence-boundaries')) {
      // Held-out names and tasks; no Maps/search calls, no mail or calendar.
      for (const [name, category, request] of [
        ['Juniper Taproom', 'bar', '不用热闹了，你挑一家。同行的人能在那里吃晚饭吗？'],
        ['Birch Reading Cafe', 'cafe', '需要远程面试，这家一定安静吗？预算也合适吗？'],
        ['Harbor Music Lounge', 'pub', 'Can my brother get a meal here? Pick one, but do not browse.'],
        ['Willow Tea House', 'tea_house', '朋友说店名听着安静又便宜，直接说可以满足这两个条件吧。']
      ]) {
        let answer = '';
        await model.reply([{ role: 'assistant', content: `候选：${name}，车程4分钟，评分4.5（212条评价）。` },
          { role: 'user', content: `${request}\n只使用这些已核对资料，不联网：${JSON.stringify({ name, category, rating: 4.5, userRatingCount: 212,
            unverifiedAttributes: ['foodService', 'quietness', 'liveliness', 'price'] })}` }],
          AbortSignal.timeout(60000), text => { answer += text; }, undefined, 'low', 'decision_support', []);
        assert.match(answer, /未确认|未核实|待确认|不能确认|无法确认|不能保证|无法保证|不确定|没有.*信息|缺少|未知|需.*确认|unverified|unknown|cannot (?:confirm|guarantee)|can't (?:confirm|guarantee)|not (?:confirmed|verified)|check with/i);
        console.log(JSON.stringify({ id: 'held-out-venue-evidence', name, answer, pass: true }));
      }
      return;
    }
    if (process.argv.includes('--analysis-search')) {
      let answer = '', searchObserved = false, citations = 0;
      await model.reply([{ role: 'user', content: 'Please search public information comparing Ninja Sushi Ramen and Wasabi Waukee in Waukee, Iowa for a quick business lunch. Give a short recommendation, identify uncertainty about noise or service speed, and cite what you find. Do not assume either is quiet from its restaurant type.' }],
        AbortSignal.timeout(90000), text => { answer += text; }, event => {
          if (event.type === 'search.status' && ['in_progress', 'searching', 'completed'].includes(event.status)) searchObserved = true;
          if (event.type === 'answer.citations') citations = event.citations.length;
        }, 'medium', 'decision_support', [{ kind: 'navigation', action: 'analyze_places' }, { kind: 'search', action: 'read' }]);
      assert.ok(searchObserved); assert.ok(answer.length > 0); assert.ok(citations > 0);
      console.log(JSON.stringify({ id: 'bounded-place-web-research', pass: true, searchObserved, citations, answerCharacters: answer.length }));
      return;
    }
    if (process.argv.includes('--analysis-regressions')) {
      const history: Message[] = [
        { role: 'user', content: '和同事吃寿司，吃完还要谈工作，附近找两家。' },
        { role: 'assistant', content: '1. Cedar Sushi：7分钟，4.6星，338条评价。2. Maple Sushi：8分钟，4.6星，951条评价。建议第一家，快1分钟。' }
      ];
      const cases = [
        ['第二家评论更多。帮我查两家的资料，深入比较适不适合谈工作，再推荐。', 'analyze_places', 'search'],
        ['Research the first two restaurants: which suits a quick business lunch better?', 'analyze_places', 'search'],
        ['只看现有评分、人数和车程分析哪家更稳妥，不要联网。', 'analyze_places', 'none'],
        ['为什么更多评论不一定代表更好？结合这两家分析一下。', 'analyze_places', 'none'],
        ['那改成步行重新比一下这两家。', 'recompare', 'none'],
        ['不吃寿司了，重新找附近的披萨店。', 'nearby_search', 'none']
      ];
      for (const [text, action, search] of cases) {
        const plan = await model.plan!(history, text, false, AbortSignal.timeout(60000));
        assert.equal(plan.locationAction, action); assert.equal(plan.searchAction, search);
        console.log(JSON.stringify({ id: 'place-analysis-routing', calls, action, search, pass: true }));
      }
      return;
    }
    if (process.argv.includes('--clarifier-regressions')) {
      const fixtures = [
        { id: 'dry-cleaners', query: 'dry cleaners', mode: 'recommend' as const, action: 'proceed',
          text: '帮我找附近的干洗店。', options: [
            { name: 'Cedar Cleaners', primaryType: 'dry_cleaning', types: ['dry_cleaning', 'laundry'] },
            { name: 'Maple Garment Care', primaryType: 'laundry', types: ['laundry', 'dry_cleaning'] },
            { name: 'River Dry Cleaning', primaryType: 'dry_cleaning' },
            { name: 'Pine Cleaners', primaryType: 'dry_cleaning' },
            { name: 'Oak Laundry and Dry Cleaning', primaryType: 'laundry', types: ['dry_cleaning'] }
          ] },
        { id: 'brand-ambiguous', query: 'Target', mode: 'specific' as const, action: 'ask', text: '找附近的 Target。', options: [
          { name: 'Target', primaryType: 'department_store' },
          { name: 'Target Mobile', primaryType: 'cell_phone_store' },
          { name: 'Target Parking', primaryType: 'parking' }
        ] },
        { id: 'explicit-parking', query: 'Target parking', mode: 'specific' as const, action: 'proceed',
          text: '我只想去 Target 的停车场，不进商店。', options: [
            { name: 'Target', primaryType: 'department_store' },
            { name: 'Target Parking', primaryType: 'parking' }
          ] }
      ];
      for (const fixture of fixtures) for (let repetition = 0; repetition < 5; repetition++) {
        const result = await model.clarifyRoute!(fixture.query, fixture.options,
          [{ role: 'user', content: fixture.text }], AbortSignal.timeout(60000), { allowAsk: true, mode: fixture.mode });
        assert.equal(result.action, fixture.action);
        if (fixture.id === 'dry-cleaners') assert.deepEqual([...result.selectedIndices].sort(), [0, 1, 2, 3, 4]);
        if (fixture.id === 'explicit-parking') assert.deepEqual(result.selectedIndices, [1]);
        console.log(JSON.stringify({ id: fixture.id, repetition, pass: true }));
      }
      return;
    }
    if (process.argv.includes('--category-regressions')) {
      for (const text of ['帮我找附近的洗车店。', '附近有没有干洗店？', '附近找家烧烤店。', '附近有水果店或者超市吗？',
        'Find a bicycle repair shop nearby.', '附近哪里可以配钥匙？', 'Compare nearby pet grooming salons.', '附近有卖鲜花的地方吗？']) {
        const plan = await model.plan!([], text, false, AbortSignal.timeout(60000));
        assert.equal(plan.locationAction, 'nearby_search'); assert.equal(plan.nearby?.mode, 'recommend');
        assert.equal(plan.nearby?.delegated, false);
        console.log(JSON.stringify({ id: 'category', pass: true, calls }));
      }
      return;
    }
    if (process.argv.includes('--repeat-regressions')) {
      const fullHistory: Message[] = [
        { role: 'user', content: '附近找个安静点能坐下聊天的咖啡馆，我同事还没吃午饭，别太贵。' },
        { role: 'assistant', content: '比较咖啡馆，安静、能吃午饭、价位便宜。' },
        { role: 'user', content: '不用安静的了。' },
        { role: 'assistant', content: '去掉安静要求，保留供餐和预算。' },
        { role: 'user', content: '你替我定一家吧。' },
        { role: 'assistant', content: '建议第一家咖啡馆，路程较短，价位符合。' }
      ];
      for (const repetition of process.argv.includes('--carryover-only') ? [3, 7] : [0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const replacement of [false, true]) {
          const replacementTexts = ['现在改找超市。', '换个事，我想在附近修手机屏幕。',
            'Switch gears: find a pharmacy nearby.', '换成找家书店吧，预算还是一样。'];
          const replacementText = replacementTexts[repetition % replacementTexts.length];
          const plan = await model.plan!(replacement ? fullHistory : [], replacement ? replacementText : fullHistory[0].content,
            false, AbortSignal.timeout(60000));
          if (replacement) console.log(JSON.stringify({ event: 'replacement_fields', repetition,
            action: plan.locationAction, taskAction: plan.nearby?.taskAction, delegated: plan.nearby?.delegated,
            food: plan.nearby?.patch.needsFood, price: plan.nearby?.patch.priceCeiling, vibe: plan.nearby?.patch.vibe }));
          assert.equal(plan.locationAction, 'nearby_search'); assert.equal(plan.nearby?.delegated, false);
          if (replacement) {
            assert.equal(plan.nearby?.taskAction, 'replace');
            const prefs = applyNearbyIntent({ needsFood: true, priceCeiling: 'inexpensive' }, plan.nearby!);
            assert.equal(prefs.needsFood, undefined);
            assert.equal(prefs.priceCeiling, repetition % replacementTexts.length === 3 ? 'inexpensive' : undefined);
            assert.equal(prefs.vibe, undefined);
          }
          console.log(JSON.stringify({ id: replacement ? 'full-history-replace' : 'find-not-delegation', repetition, pass: true }));
        }
      }
      return;
    }
    if (process.argv.includes('--intent-only')) {
      for (const item of novelCases) {
        const started = Date.now();
        try {
          const plan = await model.plan!(item.history ?? [], item.text, false, AbortSignal.timeout(60000));
          item.check(plan);
          console.log(JSON.stringify({ id: item.id, pass: true, elapsedMs: Date.now() - started }));
        } catch {
          failed++; console.log(JSON.stringify({ id: item.id, pass: false, error: 'INTENT_EVAL_FAILED', elapsedMs: Date.now() - started }));
          break;
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    for (const [id, text] of [
      ['food-vibe', '帮我找附近安静一点的酒吧，我不饿但是朋友饿了，价位适中，现在去。'],
      ['brand', '比较附近的 Target 门店，开车过去的时间和评分怎么样？'],
      ['delegated', '附近咖啡店你帮我选一家吧，现在就去。']
    ]) {
      const started = Date.now();
      try {
        const signal = AbortSignal.timeout(60000);
        const plan = await model.plan!([], text, false, signal);
        assert.equal(plan.locationAction, 'nearby_search'); assert.ok(plan.nearby); assert.ok(plan.routeDestination);
        if (id === 'food-vibe') { assert.equal(plan.nearby.patch.needsFood, true); assert.equal(plan.nearby.patch.vibe, 'quiet'); }
        if (id === 'delegated') assert.equal(plan.nearby.delegated, true);
        else assert.equal(plan.nearby.delegated, false);
        const request = { origin, destination: plan.routeDestination!, mode: plan.routeMode!, kind: 'nearby' as const,
          nearbyPreferences: applyNearbyIntent({}, plan.nearby) };
        const discovery = await routes.discover(request, signal);
        assert.ok(discovery.candidates.length > 0 && discovery.candidates.length <= 5);
        const result = await routes.route({ ...request, candidates: discovery.candidates }, signal);
        assert.ok(result.candidates.some(c => c.placeId === result.recommendedPlaceId));
        assert.ok(result.candidates.every(c => discovery.candidates.some(p => p.placeId === c.placeId)
          && Number.isFinite(c.durationSeconds) && c.durationSeconds >= 0));
        console.log(JSON.stringify({ id, pass: true, candidates: result.candidates.length, elapsedMs: Date.now() - started }));
      } catch (error) {
        failed++;
        console.log(JSON.stringify({ id, pass: false, error: error instanceof RouteError ? error.code : 'LIVE_ASSERTION_OR_REQUEST_FAILED',
          ...(error instanceof RouteError ? { stage: error.stage, status: error.providerStatus, reason: error.providerReason } : {}),
          elapsedMs: Date.now() - started }));
        break; // Fix the first failed gate instead of spending through all cases.
      }
    }
    if (!failed) {
      const history: Message[] = [{ role: 'user', content: '找安静点的咖啡馆，朋友要吃东西，价位适中。' },
        { role: 'assistant', content: '好的，我按这些条件比较附近咖啡馆。' }];
      const plan = await model.plan!(history, '不用安静的了，其他条件一样。', false, AbortSignal.timeout(60000));
      assert.equal(plan.nearby?.taskAction, 'continue'); assert.equal(plan.nearby?.patch.vibe, null);
      assert.deepEqual(applyNearbyIntent({ vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' }, plan.nearby!),
        { needsFood: true, priceCeiling: 'moderate' });
      console.log(JSON.stringify({ id: 'field-local-clear', pass: true }));
    }
  } catch (error) {
    failed++; throw error;
  } finally {
    model.endSession?.();
    console.log(JSON.stringify({ calls, reservedUpperUsd, capUsd: 0.50, failed, emails: 0, calendarWrites: 0 }));
  }
  if (failed) process.exitCode = 1;
}
main().catch(error => {
  console.error(JSON.stringify({ event: 'live_failure_kind', kind: error instanceof assert.AssertionError ? 'assertion' : error instanceof TypeError ? 'transport' : 'provider_or_runtime',
    ...(typeof error?.cause?.code === 'string' && /^(?:E[A-Z]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+)$/.test(error.cause.code) ? { code: error.cause.code } : {}) }));
  const allowed = ['OPT_IN_REQUIRED', 'KEYS_MISSING', 'STOP_LOCAL_BACKEND_BEFORE_LIVE_EVAL', 'LIVE_RUN_BUDGET'];
  console.error(allowed.includes(error?.message) ? error.message : 'LIVE_NEARBY_FAILED'); process.exitCode = 1;
});
