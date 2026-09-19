import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleRoutesProvider, RouteError, assessCandidate, recommendCandidates, type RouteCandidate } from '../src/routes.js';

const fix = { latitude: 41.58, longitude: -93.62, accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() };
const places = [
  { id: 'near', displayName: { text: 'Waukee Target' }, formattedAddress: '100 Near St', rating: 4.5, userRatingCount: 1800 },
  { id: 'far', displayName: { text: 'West Des Moines Target' }, formattedAddress: '200 Far St', rating: 3.8, userRatingCount: 640 }
];
const matrix = [
  { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', status: {}, duration: '660s', staticDuration: '420s', distanceMeters: 8369 },
  { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', status: {}, duration: '780s', staticDuration: '780s', distanceMeters: 12_553 }
];

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
