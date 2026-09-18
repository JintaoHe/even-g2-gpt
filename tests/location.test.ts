import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationStatus, parseLocationReport } from '../src/location.js';
import { createConversationServer } from '../src/conversation-server.js';
import { once } from 'node:events';
import WebSocket from 'ws';

const now = Date.parse('2026-09-18T15:00:00.000Z');

test('location reports accept bounded one-shot and continuous fixes without model-safe coordinates', () => {
  const one = parseLocationReport({ type: 'location.report', mode: 'once', location: {
    latitude: 41.5868, longitude: -93.625, accuracy: 12.4, timestamp: now
  } }, now + 1000);
  assert.equal(one.mode, 'once');
  assert.equal(one.location.latitude, 41.5868);
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
  assert.throws(() => parseLocationReport({ ...base, location: { ...base.location, timestamp: now - 121_000 } }, now), /LOCATION_STALE/);
});

test('authenticated WSS accepts ephemeral fixes, returns no coordinates and stays open on a rejected fix', async () => {
  const token = 'location-test-token-'.repeat(3);
  const app = createConversationServer({ token,
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
