import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentError, GoogleEnvironmentProvider, type EnvironmentRequest } from '../src/environment.js';

const now = Date.parse('2026-09-18T18:00:00Z');
const request: EnvironmentRequest = { location: { latitude: 41.5868, longitude: -93.625 },
  start: '2026-09-18T21:30:00Z', end: '2026-09-18T23:30:00Z', timezone: 'America/Chicago', language: 'zh-CN' };
const endpoints = { weather: 'http://127.0.0.1:3010/weather', airQuality: 'http://127.0.0.1:3010/air', pollen: 'http://127.0.0.1:3010/pollen' };

test('weather requests enough hours, selects the activity interval and returns bounded decision evidence', async () => {
  let captured = '';
  const provider = new GoogleEnvironmentProvider('private-test-key', async input => {
    captured = String(input);
    return new Response(JSON.stringify({ forecastHours: [
      { interval: { startTime: '2026-09-18T20:00:00Z', endTime: '2026-09-18T21:00:00Z' }, temperature: { degrees: 30 } },
      { interval: { startTime: '2026-09-18T21:00:00Z', endTime: '2026-09-18T22:00:00Z' }, weatherCondition: { description: { text: 'Sunny' } },
        temperature: { degrees: 22 }, feelsLikeTemperature: { degrees: 21 }, precipitation: { probability: { percent: 10 } },
        thunderstormProbability: 5, uvIndex: 2, wind: { speed: { value: 10, unit: 'KILOMETERS_PER_HOUR' } } },
      { interval: { startTime: '2026-09-18T22:00:00Z', endTime: '2026-09-18T23:00:00Z' }, weatherCondition: { description: { text: 'Partly cloudy' } },
        temperature: { degrees: 20 }, feelsLikeTemperature: { degrees: 19 }, precipitation: { probability: { percent: 25 } },
        thunderstormProbability: 10, uvIndex: 1, wind: { speed: { value: 12, unit: 'MILES_PER_HOUR' } } },
      { interval: { startTime: '2026-09-18T23:00:00Z', endTime: '2026-09-19T00:00:00Z' }, weatherCondition: { description: { text: 'Cloudy' } }, temperature: { degrees: 18 } }
    ] }), { status: 200 });
  }, () => now, endpoints);
  const result = await provider.weather(request, new AbortController().signal), url = new URL(captured);
  assert.equal(url.searchParams.get('hours'), '7'); assert.equal(url.searchParams.get('languageCode'), 'zh-CN');
  assert.equal(result.hourCount, 3); assert.deepEqual(result.conditions, ['Sunny', 'Partly cloudy', 'Cloudy']);
  assert.equal(result.temperatureMinC, 18); assert.equal(result.temperatureMaxC, 22);
  assert.equal(result.precipitationMaxPercent, 25); assert.equal(result.thunderstormMaxPercent, 10);
  assert.ok(Math.abs(result.windMaxKph! - 19.312128) < 0.0001);
  assert.equal(JSON.stringify(result).includes('41.5868'), false);
});

test('air quality sends a bounded interval and selects the worst preferred local AQI', async () => {
  let captured: any;
  const provider = new GoogleEnvironmentProvider('key', async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ hourlyForecasts: [
      { dateTime: '2026-09-18T22:00:00Z', indexes: [{ code: 'uaqi', aqi: 40, category: 'Good' },
        { code: 'usa_epa', aqi: 52, category: 'Moderate', dominantPollutant: 'pm25' }] },
      { dateTime: '2026-09-18T23:00:00Z', indexes: [{ code: 'usa_epa', aqi: 61, category: 'Moderate', dominantPollutant: 'o3' }] }
    ] }), { status: 200 });
  }, () => now, endpoints);
  const result = await provider.airQuality(request, new AbortController().signal);
  assert.deepEqual(captured.period, { startTime: new Date(request.start).toISOString(), endTime: new Date(request.end).toISOString() });
  assert.deepEqual(captured.extraComputations, ['LOCAL_AQI']);
  assert.deepEqual(result, { available: true, hourCount: 2, indexCode: 'usa_epa', aqiMax: 61,
    category: 'Moderate', dominantPollutant: 'o3' });
});

test('pollen preserves missing indexes as unknown instead of converting them to zero', async () => {
  let captured = '';
  const provider = new GoogleEnvironmentProvider('key', async input => {
    captured = String(input);
    return new Response(JSON.stringify({ dailyInfo: [{ date: { year: 2026, month: 9, day: 18 }, pollenTypeInfo: [
      { code: 'TREE', inSeason: true, indexInfo: { value: 4, category: 'High' } },
      { code: 'GRASS', inSeason: false }, { code: 'WEED', inSeason: true, indexInfo: { value: 2, category: 'Low' } }
    ] }] }), { status: 200 });
  }, () => now, endpoints);
  const result = await provider.pollen(request, new AbortController().signal), url = new URL(captured);
  assert.equal(url.searchParams.get('plantsDescription'), 'false'); assert.equal(url.searchParams.get('days'), '1');
  assert.deepEqual(result.tree, { inSeason: true, indexAvailable: true, value: 4, category: 'High' });
  assert.deepEqual(result.grass, { inSeason: false, indexAvailable: false });
  assert.equal(result.overallValue, 4); assert.equal(result.dominantType, 'tree');
});

test('provider errors and malformed data are sanitized; invalid requests fail before network', async () => {
  let calls = 0;
  const provider = new GoogleEnvironmentProvider('secret-key', async () => { calls++; return new Response(JSON.stringify({ error: {
    message: 'secret key and project prose', details: [{ reason: 'API_KEY_IP_ADDRESS_BLOCKED', metadata: { key: 'secret-key' } }]
  } }), { status: 403 }); }, () => now, endpoints);
  await assert.rejects(provider.weather(request, new AbortController().signal), (error: unknown) => error instanceof EnvironmentError
    && error.code === 'ENVIRONMENT_UNAVAILABLE' && error.service === 'weather' && error.providerStatus === 403
    && error.providerReason === 'API_KEY_IP_ADDRESS_BLOCKED' && !error.message.includes('secret'));
  await assert.rejects(provider.weather({ ...request, location: { latitude: 200, longitude: 0 } }, new AbortController().signal),
    (error: unknown) => error instanceof EnvironmentError && error.code === 'ENVIRONMENT_INVALID');
  assert.equal(calls, 1);
});
