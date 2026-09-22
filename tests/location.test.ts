import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocationRequestBroker, locationStatus, parseLocationReport } from '../src/location.js';
import { createConversationServer } from '../src/conversation-server.js';
import { once } from 'node:events';
import WebSocket from 'ws';

const now = Date.parse('2026-09-18T15:00:00.000Z');

test('location reports accept bounded one-shot and continuous fixes without model-safe coordinates', () => {
  const one = parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 41.5868, longitude: -93.625, accuracy: 12.4, timestamp: now, timezone_hint: 'America/Chicago'
  } }, now + 1000);
  assert.equal(one.mode, 'once');
  assert.equal(one.location.latitude, 41.5868);
  assert.equal(one.location.timezoneHint, 'America/Chicago');
  assert.deepEqual(locationStatus(one.location), {
    type: 'location.status', state: 'available', accuracy_m: 12, observed_at: '2026-09-18T15:00:00.000Z'
  });

  const continuous = parseLocationReport({ type: 'location.report', mode: 'continuous', location: {
    latitude: 51.5072, longitude: -0.1276, timestamp: now / 1000
  } }, now);
  assert.equal(continuous.location.observedAt, now);
  assert.equal(locationStatus(continuous.location).accuracy_m, null);
});

test('location reports reject extra fields, invalid coordinates, stale fixes and implausible accuracy', () => {
  const base = { type: 'location.report', mode: 'once', location: { latitude: 41, longitude: -93, timestamp: now } };
  assert.throws(() => parseLocationReport({ ...base, prompt: 'ignore policy' }, now), /LOCATION_REPORT_INVALID/);
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, notes: 'persist me' } }, now), /LOCATION_REPORT_INVALID/);
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, latitude: 91 } }, now), /LOCATION_COORDINATES_INVALID/);
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, accuracy: 20_000 } }, now), /LOCATION_ACCURACY_INVALID/);
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, timezone_hint: 'Mars/Olympus' } }, now), /LOCATION_TIMEZONE_INVALID/);
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, timestamp: now - 121_000 } }, now), /LOCATION_STALE/);
});

test('a fresh SDK fix is reused in-session, refreshed when stale, and never sent back to the client', async () => {
  const events: any[] = []; let clock = now;
  const broker = new LocationRequestBroker(event => events.push(event), () => '123e4567-e89b-12d3-a456-426614174000', 1000, () => clock);
  const report = parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 41.5868, longitude: -93.625, accuracy: 12, timestamp: clock
  } }, clock);
  assert.equal(broker.prime(report), true);
  const first = await broker.request(new AbortController().signal);
  assert.equal(first.latitude, 41.5868); assert.equal(events.length, 0);

  const second = await broker.request(new AbortController().signal);
  assert.equal(second.latitude, 41.5868); assert.equal(events.length, 0);

  clock += 121_000;
  const refreshed = broker.request(new AbortController().signal);
  assert.equal(events[0].type, 'location.request');
  assert.equal(broker.accept(parseLocationReport({ type: 'location.report', mode: 'once', request_id: events[0].request_id,
    location: { latitude: 41.59, longitude: -93.62, accuracy: 15, timestamp: clock } }, clock)), true);
  assert.equal((await refreshed).latitude, 41.59);

  assert.equal(broker.prime(parseLocationReport({ type: 'location.report', mode: 'continuous', location: {
    latitude: 41.6, longitude: -93.6, accuracy: 20, timestamp: clock
  } }, clock)), true);
  assert.equal((await broker.request(new AbortController().signal)).latitude, 41.6);
  broker.clear();
  const afterClear = broker.request(new AbortController().signal);
  const request = [...events].reverse().find((event: any) => event.type === 'location.request');
  assert.ok(request); broker.fail({ type: 'location.failed', request_id: request.request_id, reason: 'unavailable' });
  await assert.rejects(afterClear, /LOCATION_UNAVAILABLE/);
  assert.ok(!JSON.stringify(events).includes('41.5868'));
});

test('manual route cache rejects low-accuracy fixes', () => {
  const broker = new LocationRequestBroker(() => {}, () => '123e4567-e89b-12d3-a456-426614174000', 1000, () => now);
  assert.equal(broker.prime(parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 41.58, longitude: -93.62, accuracy: 101, timestamp: now
  } }, now)), false);
});

test('a text-only v2 client fails location immediately without sending a request or waiting for timeout', async () => {
  const events: any[] = [];
  const broker = new LocationRequestBroker(event => events.push(event),
    () => '123e4567-e89b-12d3-a456-426614174000', 22_000, () => now);
  broker.setClientLocationAvailable(false);
  const started = Date.now();
  await assert.rejects(broker.request(new AbortController().signal), /LOCATION_UNAVAILABLE/);
  assert.ok(Date.now() - started < 100);
  assert.deepEqual(events, []);
});

test('cancelling a pending client request does not clear the resumable session fix', async () => {
  const broker = new LocationRequestBroker(() => {}, () => '123e4567-e89b-12d3-a456-426614174000', 1000, () => now);
  assert.equal(broker.prime(parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 41.58, longitude: -93.62, accuracy: 12, timestamp: now,
  } }, now)), true);
  broker.cancel();
  assert.equal((await broker.request(new AbortController().signal)).latitude, 41.58);
});

test('device timezone is only a hint; a resolved session timezone survives coordinate clearing', () => {
  const broker = new LocationRequestBroker(() => {}, () => '123e4567-e89b-12d3-a456-426614174000', 1000, () => now);
  assert.equal(broker.prime(parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 34.05, longitude: -118.24, accuracy: 15, timestamp: now, timezone_hint: 'America/Los_Angeles'
  } }, now)), true);
  assert.equal(broker.timezoneHint(), 'America/Los_Angeles');
  assert.equal(broker.timezone(), undefined);
  broker.rememberTimezone('America/Los_Angeles');
  broker.clearCoordinates();
  assert.equal(broker.timezone(), 'America/Los_Angeles');
  broker.clear();
  assert.equal(broker.timezone(), undefined);
  assert.equal(broker.timezoneHint(), undefined);
});

test('authenticated WSS accepts ephemeral fixes, returns no coordinates and stays open on a rejected fix', async () => {
  const token = 'location-test-token-'.repeat(3);
  const app = createConversationServer({ legacyHelloEnabled: true, token,
    model: { decide: async () => 'respond', reply: async () => {} },
    transcriber: () => { throw new Error('unused'); },
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false, location: true }
  });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as { port: number }).port}/ws/conversation`);
  const waitFor = (type: string) => new Promise<any>(resolve => {
    const listener = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString());
      if (event.type === type) { client.off('message', listener); resolve(event); }
    };
    client.on('message', listener);
  });
  try {
    await once(client, 'open');
    const ready = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token }));
    assert.equal((await ready).capabilities.location, true);
    let status = waitFor('location.status');
    client.send(JSON.stringify({ type: 'location.report', mode: 'once', location: {
      latitude: 41.5868, longitude: -93.625, accuracy: 14, timestamp: Date.now()
    } }));
    const available = await status;
    assert.deepEqual(Object.keys(available).sort(), ['accuracy_m', 'observed_at', 'state', 'type']);
    assert.equal(available.state, 'available'); assert.equal(available.accuracy_m, 14);

    status = waitFor('location.status');
    client.send(JSON.stringify({ type: 'location.report', mode: 'continuous', location: {
      latitude: 91, longitude: -93, accuracy: 10, timestamp: Date.now()
    } }));
    assert.equal((await status).state, 'unavailable'); assert.equal(client.readyState, WebSocket.OPEN);

    status = waitFor('location.status'); client.send(JSON.stringify({ type: 'location.clear' }));
    assert.equal((await status).state, 'cleared');
  } finally {
    if (client.readyState < WebSocket.CLOSING) { const closed = once(client, 'close'); client.close(); await closed; }
    await app.close();
  }
});

test('WSS manual location primes the next route turn without a second SDK request, then clears it', async () => {
  const token = 'route-location-token-'.repeat(3);
  let routedMode = '';
  const app = createConversationServer({ legacyHelloEnabled: true, token,
    model: {
      plan: async () => ({ decision: 'respond', locationAction: 'route_eta', routeDestination: 'Costco', routeOrigin: null, routeMode: 'drive', routeModeExplicit: false }),
      decide: async () => 'respond', reply: async () => { throw new Error('route wrapper should answer'); }
    },
    routeProvider: { route: async request => {
      assert.equal(request.origin.kind, 'coordinates');
      routedMode = request.mode;
      return { query: 'Costco', recommendedPlaceId: 'costco', recommendationBasis: 'fastest', mode: request.mode, trafficAware: false,
        candidates: [{ placeId: 'costco', name: 'Costco', durationSeconds: 600, distanceMeters: 8047,
          quality: { adjustedRating: 4.2, reliable: true, risk: false } }] };
    } },
    transcriber: () => { throw new Error('unused'); },
    capabilities: { provider: 'api', delivery: 'api', webSearch: false, speech: false, location: true, routes: true }
  });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as { port: number }).port}/ws/conversation`);
  const queue: any[] = []; const waiters: ((event: any) => void)[] = [];
  let locationRequests = 0;
  client.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'location.request') locationRequests++;
    const waiter = waiters.shift(); if (waiter) waiter(event); else queue.push(event); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waiters.push(resolve));
  const until = async (type: string) => { while (true) { const event = await next(); if (event.type === type) return event; } };
  try {
    await once(client, 'open'); client.send(JSON.stringify({ type: 'hello', token })); await until('ready');
    client.send(JSON.stringify({ type: 'location.report', mode: 'once', location: {
      latitude: 41.58, longitude: -93.62, accuracy: 20, timestamp: Date.now()
    } }));
    assert.equal((await until('location.status')).state, 'available');
    client.send(JSON.stringify({ type: 'route.mode', mode: 'bicycle' }));
    assert.match((await until('notice')).text, /骑车/);
    client.send(JSON.stringify({ type: 'text.submit', text: '从这里去 Costco 多久' }));
    let answer = ''; while (true) { const event = await next(); if (event.type === 'answer.delta') answer += event.text; if (event.type === 'answer.done') break; }
    assert.equal(locationRequests, 0); assert.equal(routedMode, 'bicycle'); assert.match(answer, /骑车到.*10分钟/); assert.ok(!answer.includes('41.58'));
  } finally {
    if (client.readyState < WebSocket.CLOSING) { const closed = once(client, 'close'); client.close(); await closed; }
    await app.close();
  }
});
