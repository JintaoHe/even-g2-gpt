import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger } from '../src/cost-ledger.js';
import { GoogleRoutesProvider, RouteError, assessCandidate, recommendCandidates, prefilterNearby, rankNearbyCoarse, type RouteCandidate } from '../src/routes.js';

const fix = { latitude: 41.58, longitude: -93.62, accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() };

test('exclusions cover secondary types, never infer a type from a name', () => {
  const result = prefilterNearby([
    { placeId: 'hybrid', name: 'Dinner House', primaryType: 'restaurant', types: ['restaurant', 'bar'] },
    { placeId: 'quick', name: 'Quick Kitchen', primaryType: 'fast_food_restaurant' },
    { placeId: 'name-only', name: 'Bar None Bakery', primaryType: 'bakery' }
  ], { excludeTypes: ['bar', 'fast_food_restaurant'] });
  assert.deepEqual(result.candidates.map(c => c.placeId), ['name-only']);
  assert.deepEqual(result.excluded.map(c => c.reason), ['type', 'type']);
});
const places = [
  { id: 'near', displayName: { text: 'Waukee Target' }, formattedAddress: '100 Near St', rating: 4.5, userRatingCount: 1800 },
  { id: 'far', displayName: { text: 'West Des Moines Target' }, formattedAddress: '200 Far St', rating: 3.8, userRatingCount: 640 }
];
const matrix = [
  { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', status: {}, duration: '660s', staticDuration: '420s', distanceMeters: 8369 },
  { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', status: {}, duration: '780s', staticDuration: '780s', distanceMeters: 12_553 }
];

test('nearby filters ten before taking five and preserves unknown hours and prices', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `place-${i}`, displayName: { text: `Shop ${i}` },
    ...(i < 3 ? { currentOpeningHours: { openNow: false } } : {}) }));
  const result = await provider([{ places: ten }, Array.from({ length: 5 }, (_, i) => ({ ...matrix[0], destinationIndex: i }))], requests)
    .route({ origin: { kind: 'coordinates', location: fix }, destination: 'coffee', mode: 'drive', kind: 'nearby' }, new AbortController().signal);
  assert.deepEqual(result.candidates.map(c => c.placeId), ['place-3', 'place-4', 'place-5', 'place-6', 'place-7']);
  assert.equal(requests[1].body.destinations.length, 5);
  assert.equal(result.excluded?.length, 3);
  assert.equal(result.candidates[0].openNow, undefined);
  assert.match(requests[0].mask!, /places.currentOpeningHours.openNow/);
  assert.doesNotMatch(requests[0].mask!, /reviews|serves|dineIn/);
});

test('future visits ignore openNow but permanently closed places stay excluded', () => {
  const candidates = [
    { placeId: 'a', name: 'A', openNow: false },
    { placeId: 'b', name: 'B', businessStatus: 'CLOSED_PERMANENTLY' as const },
    { placeId: 'c', name: 'C' }
  ];
  assert.deepEqual(prefilterNearby(candidates, { visitTime: 'future' }).candidates.map(c => c.placeId), ['a', 'c']);
  assert.deepEqual(prefilterNearby(candidates).candidates.map(c => c.placeId), ['c']);
});

test('price enum mapping, invalid facts, duplicate IDs and all-excluded do not spend Routes calls', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const returned = [
    { id: 'pricey', displayName: { text: 'Pricey' }, priceLevel: 'PRICE_LEVEL_VERY_EXPENSIVE' },
    { id: 'unknown', displayName: { text: 'Unknown' }, priceLevel: 'invalid', currentOpeningHours: { openNow: 'false' } },
    { id: 'unknown', displayName: { text: 'Duplicate' } }
  ];
  const discovered = await provider([{ places: returned }], requests).discover({ origin: { kind: 'address', address: 'Test city' },
    destination: 'cafe', mode: 'walk', kind: 'nearby', nearbyPreferences: { priceCeiling: 'moderate' } }, new AbortController().signal);
  assert.equal(discovered.candidates.length, 1); assert.equal(discovered.candidates[0].priceLevel, undefined);
  assert.equal(discovered.candidates[0].openNow, undefined); assert.equal(discovered.excluded?.[0].reason, 'price');
  const noMatches = provider([{ places: returned.slice(0, 1) }], requests);
  await assert.rejects(noMatches.route({ origin: { kind: 'address', address: 'Test city' }, destination: 'cafe',
    mode: 'walk', kind: 'nearby', nearbyPreferences: { priceCeiling: 'moderate' } }, new AbortController().signal),
  (e: unknown) => e instanceof RouteError && e.code === 'ROUTE_NO_MATCHING_PLACES' && e.excluded?.[0].reason === 'price');
  assert.equal(requests.length, 2); assert.ok(requests.every(r => r.url.endsWith('/places')));
});

test('coarse ordering uses coordinates and food/type priors without inventing ETA or venue attributes', () => {
  const candidates = [
    { placeId: 'far', name: 'Far', location: { latitude: 42, longitude: -93.62 } },
    { placeId: 'close', name: 'Close', location: { latitude: 41.58, longitude: -93.62 } }
  ];
  const ranked = rankNearbyCoarse(candidates, {}, { kind: 'coordinates', location: fix });
  assert.equal(ranked[0].placeId, 'close'); assert.equal('durationSeconds' in ranked[0], false);
  const food = rankNearbyCoarse([{ placeId: 'bar', name: 'Bar', primaryType: 'bar' },
    { placeId: 'food', name: 'Food', primaryType: 'restaurant' }], { needsFood: true }, { kind: 'address', address: 'Test city' });
  assert.equal(food[0].placeId, 'food'); assert.equal('servesFood' in food[0], false);
});

test('five nearby destinations charge five matrix elements to the existing monthly ledger', async () => {
  const ledger = await CostLedger.create(join(await mkdtemp(join(tmpdir(), 'pi1-cost-')), 'ledger.json'), {});
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}`, displayName: { text: `Test ${i}` } }));
  const responses = [{ places: five }, five.map((_, destinationIndex) => ({ ...matrix[0], destinationIndex }))];
  const routes = new GoogleRoutesProvider('test-key', async () => new Response(JSON.stringify(responses.shift())),
    'http://127.0.0.1:3009/places', 'http://127.0.0.1:3009/routes', ledger);
  await routes.route({ origin: { kind: 'coordinates', location: fix }, kind: 'nearby', mode: 'drive', destination: 'cafe' },
    new AbortController().signal);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.googleUnits['places-text-search-enterprise'], 1);
  assert.equal(snapshot.googleUnits['route-matrix-pro'], 5);
});

function provider(responses: unknown[], requests: { url: string; body: any; mask: string | null }[]) {
  return new GoogleRoutesProvider('test-key', async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)), mask: new Headers(init?.headers).get('X-Goog-FieldMask') });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }, 'http://127.0.0.1:3009/places', 'http://127.0.0.1:3009/routes');
}

test('place discovery returns legal candidate types without spending a Routes call', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const returned = [
    { id: 'parking', displayName: { text: 'Target Parking' }, primaryType: 'parking_lot', types: ['parking_lot'] },
    { id: 'store', displayName: { text: 'Target' }, primaryType: 'department_store', types: ['department_store'] }
  ];
  const result = await provider([{ places: returned }], requests).discover({ origin: { kind: 'coordinates', location: fix },
    destination: 'Target', kind: 'nearby', mode: 'drive' }, new AbortController().signal);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /places/);
  assert.deepEqual(result.candidates.map(value => value.placeId), ['parking', 'store']);
});

test('nearby route comparison gets ratings in Places and batches candidates in one traffic-aware matrix', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const result = await provider([{ places }, matrix], requests).route({ origin: { kind: 'coordinates', location: fix },
    destination: 'nearby Target', kind: 'nearby', mode: 'drive' }, new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.pageSize, 10); assert.equal(requests[0].body.rankPreference, 'DISTANCE');
  assert.equal(requests[0].body.locationBias.circle.radius, 20_000);
  assert.match(requests[0].mask!, /places\.rating/); assert.match(requests[0].mask!, /places\.userRatingCount/);
  assert.match(requests[0].mask!, /places\.primaryType/); assert.match(requests[0].mask!, /places\.types/);
  assert.equal(requests[1].body.destinations.length, 2); assert.equal(requests[1].body.routingPreference, 'TRAFFIC_AWARE');
  assert.deepEqual(requests[1].body.destinations.map((value: any) => value.waypoint.placeId), ['near', 'far']);
  assert.equal(result.candidates.length, 2); assert.equal(result.recommendedPlaceId, 'near');
  assert.equal(result.candidates[0].staticDurationSeconds, 420); assert.equal(result.trafficAware, true);
  assert.ok(!JSON.stringify(result).includes('41.58'));
});

test('explicit or distant destination uses the legal 50 km soft bias without distance ranking', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const airport = [{ id: 'ord', displayName: { text: "O'Hare International Airport" },
    formattedAddress: '10000 W O’Hare Ave, Chicago, IL 60666, USA', primaryType: 'international_airport' }];
  await provider([{ places: airport }, [{ ...matrix[0], destinationIndex: 0 }]], requests).route({
    origin: { kind: 'coordinates', location: fix }, destination: "O'Hare International Airport, Chicago, Illinois",
    kind: 'destination', mode: 'drive'
  }, new AbortController().signal);
  assert.equal(requests[0].body.locationBias.circle.radius, 50_000);
  assert.equal(requests[0].body.rankPreference, undefined);
  assert.equal(requests[0].body.textQuery, "O'Hare International Airport, Chicago, Illinois");
});

test('nearby discovery widens once from 20 km to 50 km when the first search is empty', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const result = await provider([{ places: [] }, { places: [places[0]] }, [matrix[0]]], requests).route({
    origin: { kind: 'coordinates', location: fix }, destination: 'specialty store', kind: 'nearby', mode: 'drive'
  }, new AbortController().signal);
  assert.equal(result.candidates[0].placeId, 'near'); assert.equal(requests.length, 3);
  assert.equal(requests[0].body.locationBias.circle.radius, 20_000);
  assert.equal(requests[1].body.locationBias.circle.radius, 50_000);
});

test('manual-origin nearby discovery puts the public origin in the query instead of using server IP bias', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  await provider([{ places: [places[0]] }], requests).discover({ origin: { kind: 'address', address: 'Des Moines, Iowa' },
    destination: 'Target', kind: 'nearby', mode: 'drive' }, new AbortController().signal);
  assert.equal(requests[0].body.textQuery, 'Target near Des Moines, Iowa');
  assert.equal(requests[0].body.locationBias, undefined);
});

test('recomparison reuses bounded Place IDs and skips Places search', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const result = await provider([[{ ...matrix[0], staticDuration: undefined }]], requests).route({
    origin: { kind: 'coordinates', location: fix }, destination: 'Target', mode: 'walk', candidates: [
      { placeId: 'near', name: 'Waukee Target', rating: 4.5, userRatingCount: 1800 }
    ] }, new AbortController().signal);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /routes/);
  assert.equal(requests[0].body.travelMode, 'WALK'); assert.equal(requests[0].body.routingPreference, undefined);
  assert.equal(result.trafficAware, false); assert.equal(result.candidates[0].staticDurationSeconds, undefined);
});

test('matrix keeps valid candidates when another destination has an element error', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const broken = { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND', status: { code: 5 } };
  const result = await provider([{ places }, [broken, matrix[1]]], requests).route({ origin: { kind: 'coordinates', location: fix },
    destination: 'Target', mode: 'bicycle' }, new AbortController().signal);
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].placeId, 'far');
  assert.equal(requests[1].body.travelMode, 'BICYCLE'); assert.equal(requests[1].body.routingPreference, undefined);
});

test('parking and transit results remain valid destinations for later semantic clarification', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  const returned = [
    { id: 'parking', displayName: { text: 'TARGET PARKING LOT' }, primaryType: 'parking_lot', types: ['parking_lot', 'parking'] },
    { id: 'stop', displayName: { text: 'Southridge / Target' }, primaryType: 'bus_stop', types: ['bus_stop', 'transit_station'] },
    places[0]
  ];
  const allRoutes = [matrix[0], matrix[1], { ...matrix[1], destinationIndex: 2 }];
  const result = await provider([{ places: returned }, allRoutes], requests).route({ origin: { kind: 'coordinates', location: fix },
    destination: 'Target', kind: 'nearby', mode: 'drive' }, new AbortController().signal);
  assert.deepEqual(requests[1].body.destinations.map((value: any) => value.waypoint.placeId), ['parking', 'stop', 'near']);
  assert.deepEqual(result.candidates.map(value => value.placeId), ['parking', 'stop', 'near']);
});

test('confidence-adjusted rating does not let one five-star review dominate a well-reviewed option', () => {
  const tiny = assessCandidate({ placeId: 'tiny', name: 'Tiny', rating: 5, userRatingCount: 1 });
  const trusted = assessCandidate({ placeId: 'trusted', name: 'Trusted', rating: 4.4, userRatingCount: 1000 });
  assert.ok(tiny.adjustedRating! < trusted.adjustedRating!); assert.equal(tiny.reliable, false); assert.equal(trusted.reliable, true);
});

test('a very low well-established rating can outweigh a large ETA advantage', () => {
  const candidate = (placeId: string, durationSeconds: number, rating: number, count: number): RouteCandidate => {
    const base = { placeId, name: placeId, durationSeconds, distanceMeters: 1000, rating, userRatingCount: count };
    return { ...base, quality: assessCandidate(base) };
  };
  const bad = candidate('one-minute-but-bad', 60, 1, 640), good = candidate('thirty-minute-good', 1800, 4.5, 1800);
  const picked = recommendCandidates([bad, good]);
  assert.equal(picked.fastest.placeId, bad.placeId); assert.equal(picked.recommended.placeId, good.placeId);
  assert.equal(picked.basis, 'quality_risk');
});

test('Google route provider fails closed when no destination is found', async () => {
  const requests: { url: string; body: any; mask: string | null }[] = [];
  await assert.rejects(provider([{ places: [] }], requests).route({ origin: { kind: 'address', address: 'Des Moines' },
    destination: 'missing', mode: 'walk' }, new AbortController().signal),
  (error: unknown) => error instanceof RouteError && error.code === 'ROUTE_DESTINATION_NOT_FOUND');
});

test('permanent provider errors expose only safe stage/status metadata and are not retried', async () => {
  let calls = 0;
  const provider = new GoogleRoutesProvider('test-key', async () => { calls++; return new Response(JSON.stringify({ error: {
    message: 'secret project and IP prose', details: [{ reason: 'API_KEY_IP_ADDRESS_BLOCKED', metadata: { consumer: 'secret' } }]
  } }), { status: 403 }); },
    'http://127.0.0.1:3009/places', 'http://127.0.0.1:3009/routes');
  await assert.rejects(provider.route({ origin: { kind: 'address', address: 'Des Moines' }, destination: 'Target', mode: 'drive' },
    new AbortController().signal), (error: unknown) => error instanceof RouteError && error.code === 'ROUTE_UNAVAILABLE'
      && error.stage === 'places' && error.providerStatus === 403 && error.providerReason === 'API_KEY_IP_ADDRESS_BLOCKED'
      && !error.message.includes('secret'));
  assert.equal(calls, 1);
});
