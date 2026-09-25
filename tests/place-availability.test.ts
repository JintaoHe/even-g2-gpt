import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availability, intendedFacilities, parseGoogleHours, verifyRecommendations, PLACE_CHECK_LIMITS } from '../src/place-availability.js';
import { GoogleRoutesProvider, type RouteCandidate, type RouteComparisonResult, type RouteProvider } from '../src/routes.js';
import { CostLedger } from '../src/cost-ledger.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { routeText } from '../src/location-dialogue.js';

const at = Date.parse('2026-09-25T05:10:00Z'); // after midnight in a UTC-5 branch
const abort = () => new AbortController().signal;
const candidate = (id: string, extra: Partial<RouteCandidate> = {}): RouteCandidate => ({ placeId: id, name: id,
  address: '10 Synthetic Road, Test City', website: 'https://restaurant.example/branch',
  durationSeconds: 1200, distanceMeters: 1000, quality: { reliable: false, risk: false }, ...extra });
const result = (...candidates: RouteCandidate[]): RouteComparisonResult => ({ query: 'restaurant', candidates,
  recommendedPlaceId: candidates[0].placeId, recommendationBasis: 'fastest', mode: 'drive', trafficAware: true,
  nearbyPreferences: { needsFood: true } });
const open = { checkedAt: at, openNow: true, closesAt: at + 3600_000, source: 'google' as const };
const provider = (verifyPlace: NonNullable<RouteProvider['verifyPlace']>): RouteProvider => ({ verifyPlace, route: async () => { throw Error('unused'); } });

test('brand query rejects a lone parking result; explicit parking remains valid', () => {
  const p = candidate('parking', { primaryType: 'parking_lot' });
  assert.deepEqual(intendedFacilities('Target', [p]), []);
  assert.deepEqual(intendedFacilities('Target parking', [p]), [p]);
  assert.deepEqual(intendedFacilities('Target not parking', [p]), []);
  assert.deepEqual(intendedFacilities('Target', [p, candidate('store', { primaryType: 'department_store' })]).map(c => c.placeId), ['store']);
});
test('explicit timestamp handles midnight, arrival closure and kitchen separately', () => {
  const hours = parseGoogleHours({ currentOpeningHours: { openNow: true, nextCloseTime: '2026-09-25T00:20:00-05:00' },
    currentSecondaryOpeningHours: [{ secondaryHoursType: 'KITCHEN', openNow: false }] }, at);
  const c = candidate('a', { hours });
  assert.equal(availability(c, at, 1200), 'closing');
  assert.equal(availability(c, at, 0, true), 'closed');
  assert.equal(parseGoogleHours({ currentOpeningHours: { nextCloseTime: '2026-09-25T00:20:00' } }, at).closesAt, undefined);
});
test('two minute boundary and clock rollback invalidate evidence', () => {
  assert.equal(availability(candidate('a', { hours: open }), at + 119999), 'open');
  assert.equal(availability(candidate('a', { hours: open }), at + 120000), 'unknown');
  assert.equal(availability(candidate('a', { hours: open }), at - 1), 'unknown');
});
test('known closed never sent to fallback; open outranks unknown and no repeated read', async () => {
  let details = 0, web = 0;
  const r = await verifyRecommendations(result(candidate('closed', { hours: { ...open, openNow: false } }),
    candidate('unknown'), candidate('open', { hours: open })), provider(async c => { details++; return c; }),
  async () => { web++; return undefined; }, abort(), () => at);
  assert.equal(details, 1); assert.equal(web, 1); assert.equal(r.recommendedPlaceId, 'open');
  assert.deepEqual(r.candidates.map(c => c.placeId), ['open', 'unknown']);
  assert.match(routeText(r, 'America/Chicago', true), /尚未确认/);
});
test('relaxed limits: four exact details and two web calls, never unbounded', async () => {
  let details = 0, searches = 0;
  const r = await verifyRecommendations(result(...Array.from({ length: 5 }, (_, i) => candidate(`p${i}`))),
    provider(async c => { details++; return c; }), async () => { searches++; return undefined; }, abort(), () => at);
  assert.equal(details, 4); assert.equal(searches, 2); assert.equal(PLACE_CHECK_LIMITS.timeoutMs, 30000);
  assert.match(routeText(r, 'America/Chicago', true), /暂不推荐直接出发/);
});
test('stop early after two confirmed choices', async () => {
  let details = 0;
  await verifyRecommendations(result(...Array.from({ length: 5 }, (_, i) => candidate(`p${i}`))),
    provider(async c => { details++; return { ...c, hours: open }; }), undefined, abort(), () => at);
  assert.equal(details, 2);
});
test('deadline bounds noncooperative lookup, discards late result, preserves unknown', async () => {
  let complete!: (c: RouteCandidate) => void;
  const c = candidate('a');
  const r = await verifyRecommendations(result(c), provider(() => new Promise(resolve => { complete = resolve; })),
    undefined, abort(), () => at, 20);
  complete({ ...c, hours: open }); await Promise.resolve();
  assert.equal(r.candidates[0].hours, undefined);
  assert.match(routeText(r, 'America/Chicago', true), /尚未确认/);
});
test('user cancellation propagates, never delivers fallback', async () => {
  const controller = new AbortController();
  const promise = verifyRecommendations(result(candidate('a')), provider(async () => { controller.abort(Error('cancelled')); throw Error('late'); }),
    async () => { throw Error('must not search'); }, controller.signal, () => at);
  await assert.rejects(promise, /cancelled/);
});
test('arriving after closing excludes a candidate even with excellent rating', async () => {
  const r = await verifyRecommendations(result(candidate('near', { rating: 5, hours: { ...open, closesAt: at + 600000 } }),
    candidate('far', { rating: 3.8, hours: open })), provider(async c => c), undefined, abort(), () => at);
  assert.deepEqual(r.candidates.map(c => c.placeId), ['far']);
});
test('future requests do not pretend current hours prove future opening', async () => {
  const r = result(candidate('a')); r.nearbyPreferences = { visitTime: 'future' };
  assert.equal(await verifyRecommendations(r, provider(async () => { throw Error('unexpected'); }), undefined, abort()), r);
});
test('details uses exact ID, GET and a separate metered SKU; mismatched ID rejected', async () => {
  const ledger = await CostLedger.create(join(await mkdtemp(join(tmpdir(), 'hours-')), 'ledger.json'), {});
  let bad = false;
  const fetcher = (async (url, init) => {
    assert.equal(String(url), 'https://places.googleapis.com/v1/places/test%2Fid'); assert.equal(init?.method, 'GET');
    assert.match((init?.headers as any)['X-Goog-FieldMask'], /currentSecondaryOpeningHours/);
    return Response.json({ id: bad ? 'another' : 'test/id', displayName: { text: 'Test Diner' },
      currentOpeningHours: { openNow: true }, websiteUri: 'https://restaurant.example/branch' });
  }) as typeof fetch;
  const p = new GoogleRoutesProvider('fake', fetcher, undefined, undefined, ledger);
  assert.equal((await p.verifyPlace(candidate('test/id'), abort())).hours?.openNow, true);
  assert.equal((await ledger.snapshot()).googleUnits['places-details-enterprise'], 1);
  bad = true; await assert.rejects(p.verifyPlace(candidate('test/id'), abort()), /ROUTE_INVALID/);
});
test('details budget refusal prevents network and is preserved as unknown', async () => {
  let calls = 0;
  const ledger = { reserveGoogle: async () => { throw Error('COST_BUDGET_EXHAUSTED'); } } as unknown as CostLedger;
  const p = new GoogleRoutesProvider('fake', (async () => { calls++; return Response.json({}); }) as typeof fetch,
    undefined, undefined, ledger);
  await assert.rejects(p.verifyPlace(candidate('a'), abort()), /COST_BUDGET_EXHAUSTED/); assert.equal(calls, 0);
});

const lookup = { placeId: 'a', name: 'Test Diner', address: '10 Synthetic Road, Test City', website: 'https://restaurant.example/branch', at };
function webModel(payload: any, sources: string[], calls: any[], quota?: any, search = true) {
  return new OpenAIDialogue('fake', 'test', undefined, search, 2, 'America/Chicago', quota, { sessionSearchCalls: 2,
    fetcher: (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({ status: 'completed', output: [
      { type: 'web_search_call', action: { sources: sources.map(url => ({ url })) } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }
    ] }); }) as typeof fetch });
}
const supported = { status: 'open', branch_matches: true, source_url: lookup.website, closes_at: '2026-09-25T01:00:00-05:00' };
test('web verification requires an official retrieved source and exact-branch assertion', async () => {
  const calls: any[] = [];
  const m = webModel(supported, [lookup.website], calls);
  assert.equal((await m.verifyPlaceHours(lookup, abort()))?.openNow, true);
  assert.equal(calls[0].max_tool_calls, 1); assert.equal(calls[0].tool_choice, 'required');
  assert.deepEqual(calls[0].tools[0].filters.allowed_domains, ['restaurant.example']);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].input)).sort(), ['address', 'current_utc', 'name', 'website']);
  for (const [payload, sources] of [
    [{ ...supported, branch_matches: false }, [lookup.website]],
    [{ ...supported, branch_matches: 'true' }, [lookup.website]],
    [supported, []], [{ ...supported, source_url: 'https://reviews.example/a' }, ['https://reviews.example/a']],
    [{ ...supported, closes_at: null }, [lookup.website]],
    [{ ...supported, closes_at: '2026-09-25T01:00:00' }, [lookup.website]],
  ] as [any, string[]][]) assert.equal(await webModel(payload, sources, []).verifyPlaceHours(lookup, abort()), undefined);
});
test('web quota disabled/denied/failing prevents calls; session cap is preserved', async () => {
  const calls: any[] = [];
  for (const q of [{ reserve: async () => null }, { reserve: async () => { throw Error('ledger'); } }])
    assert.equal(await webModel(supported, [lookup.website], calls, q).verifyPlaceHours(lookup, abort()), undefined);
  await webModel(supported, [lookup.website], calls, undefined, false).verifyPlaceHours(lookup, abort());
  assert.equal(calls.length, 0);
  const m = webModel(supported, [lookup.website], calls);
  await m.verifyPlaceHours(lookup, abort()); await m.verifyPlaceHours(lookup, abort()); await m.verifyPlaceHours(lookup, abort());
  assert.equal(calls.length, 2);
});

test('failed lookup does not spend retries; quota reservation is conservative', async () => {
  let calls = 0, settled = 0;
  const m = new OpenAIDialogue('fake', 'test', undefined, true, 2, 'America/Chicago', {
    reserve: async n => { assert.equal(n, 1); return { limit: n, settle: async () => { settled++; } }; }
  }, { fetcher: (async () => { calls++; throw Error('provider failure'); }) as typeof fetch });
  assert.equal(await m.verifyPlaceHours(lookup, abort()), undefined);
  assert.equal(calls, 1); assert.equal(settled, 0);
});

test('empty/currently unknown hours never imply open and missing official website skips web', async () => {
  let searches = 0;
  const r = await verifyRecommendations(result(candidate('a', { website: undefined })), provider(async c => ({ ...c,
    hours: parseGoogleHours({}, at) })), async () => { searches++; return open; }, abort(), () => at);
  assert.equal(searches, 0); assert.equal(availability(r.candidates[0], at), 'unknown');
  const text = routeText(r, 'America/Chicago', true);
  assert.match(text, /尚未确认/); assert.doesNotMatch(text, /显示现在营业|预计到达早于/);
});
