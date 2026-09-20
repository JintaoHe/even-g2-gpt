import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger } from '../src/cost-ledger.js';
import { GoogleRoutesProvider } from '../src/routes.js';
import { GoogleEnvironmentProvider } from '../src/environment.js';
import { GoogleTimezoneProvider } from '../src/timezone.js';

const env = { COST_TOTAL_MONTHLY_USD: '80', COST_OPENAI_MONTHLY_USD: '50',
  COST_SONIOX_MONTHLY_USD: '20', COST_GOOGLE_MONTHLY_USD: '10' } as NodeJS.ProcessEnv;
const fix = { latitude: 41.5868, longitude: -93.625, accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() };
const candidates = [
  { id: 'one', displayName: { text: 'Store One' }, formattedAddress: '1 Main St', rating: 4.4, userRatingCount: 100 },
  { id: 'two', displayName: { text: 'Store Two' }, formattedAddress: '2 Main St', rating: 4.2, userRatingCount: 80 }
];
const matrix = candidates.map((_, index) => ({ originIndex: 0, destinationIndex: index, condition: 'ROUTE_EXISTS', status: {},
  duration: `${600 + index * 60}s`, staticDuration: `${570 + index * 60}s`, distanceMeters: 5_000 + index * 1_000 }));

test('production Google adapters meter every active billable SKU with route elements, not HTTP calls', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'even-google-meter-')), 'ledger.json');
  const costs = await CostLedger.create(file, env, undefined, { now: () => new Date('2026-09-19T17:00:00Z') });
  const mapsFetch: typeof fetch = async input => new Response(JSON.stringify(String(input).includes('/places') ? { places: candidates } : matrix), { status: 200 });
  const routes = new GoogleRoutesProvider('key', mapsFetch, 'http://127.0.0.1:3011/places', 'http://127.0.0.1:3011/routes', costs);
  const discovered = await routes.discover!({ origin: { kind: 'coordinates', location: fix }, destination: 'store', kind: 'nearby', mode: 'drive' }, new AbortController().signal);
  await routes.route({ origin: { kind: 'coordinates', location: fix }, destination: 'store', mode: 'drive', candidates: discovered.candidates }, new AbortController().signal);
  await routes.route({ origin: { kind: 'coordinates', location: fix }, destination: 'store', mode: 'walk', candidates: discovered.candidates }, new AbortController().signal);

  const now = Date.parse('2026-09-19T17:00:00Z');
  const endpoints = { weather: 'http://127.0.0.1:3012/weather', airQuality: 'http://127.0.0.1:3012/air', pollen: 'http://127.0.0.1:3012/pollen' };
  const environment = new GoogleEnvironmentProvider('key', async input => {
    const url = String(input);
    return new Response(JSON.stringify(url.includes('/weather') ? { forecastHours: [] }
      : url.includes('/air') ? { hourlyForecasts: [] } : { dailyInfo: [] }), { status: 200 });
  }, () => now, endpoints, costs);
  const request = { location: fix, start: '2026-09-19T18:00:00Z', end: '2026-09-19T20:00:00Z', timezone: 'America/Chicago' };
  await environment.weather(request, new AbortController().signal);
  await environment.airQuality(request, new AbortController().signal);
  await environment.pollen(request, new AbortController().signal);

  const timezone = new GoogleTimezoneProvider('key', async () => new Response(JSON.stringify({ status: 'OK', timeZoneId: 'America/Chicago' }), { status: 200 }),
    'http://127.0.0.1:3013/timezone', () => now, costs);
  assert.equal(await timezone.resolve(fix, new AbortController().signal), 'America/Chicago');
  const snapshot = await costs.snapshot();
  assert.deepEqual(snapshot.googleUnits, {
    'places-text-search-enterprise': 1,
    'route-matrix-pro': 2,
    'route-matrix-essentials': 2,
    weather: 1,
    'air-quality': 1,
    pollen: 1,
    'time-zone': 1
  });
  assert.equal(snapshot.providerUsd.google, 0, 'all calls remain inside independent free allowances');
});

test('known unsuccessful Google response releases its reservation', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'even-google-meter-')), 'ledger.json');
  const costs = await CostLedger.create(file, env);
  const timezone = new GoogleTimezoneProvider('key', async () => new Response(JSON.stringify({ status: 'REQUEST_DENIED' }), { status: 200 }),
    'http://127.0.0.1:3013/timezone', Date.now, costs);
  await assert.rejects(timezone.resolve(fix, new AbortController().signal));
  assert.equal((await costs.snapshot()).googleUnits['time-zone'], 0);
});
