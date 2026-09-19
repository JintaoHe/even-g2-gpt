import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocationController, locationReport } from '../src/location.ts';

test('location report keeps only the bounded route fields', () => {
  assert.deepEqual(locationReport('once', {
    latitude: 41.5868, longitude: -93.625, accuracy: 8.2, altitude: 300, heading: 90, speed: 10, timestamp: 1_789_741_200_000
  }), { type: 'location.report', mode: 'once', location: {
    latitude: 41.5868, longitude: -93.625, accuracy: 8.2, timestamp: 1_789_741_200_000
  } });
  assert.equal(locationReport('once', { latitude: 200, longitude: 0 }), undefined);
  assert.equal(locationReport('once', { latitude: 34.05, longitude: -118.24 }, undefined, 'Mars/Olympus'), undefined);
  assert.equal(locationReport('once', { latitude: 34.05, longitude: -118.24 }, undefined, 'America/Los_Angeles')?.location.timezone_hint,
    'America/Los_Angeles');
});

test('one-shot and continuous controls are explicit, 10-second session updates and stoppable', async () => {
  const reports: unknown[] = []; let listener: ((value: any) => void) | undefined, stopped = 0, continuousOptions: any, clock = 100_000;
  const bridge = {
    getAppLocation: async () => ({ latitude: 41, longitude: -93, accuracy: 10 }),
    startAppLocationUpdates: async (options: any) => { continuousOptions = options; return true; },
    stopAppLocationUpdates: async () => { stopped++; return true; },
    onAppLocationChanged: (callback: (value: any) => void) => { listener = callback; return () => { listener = undefined; }; }
  };
  const controller = new LocationController(bridge, report => reports.push(report), async () => {}, () => 'America/Chicago', () => clock);
  assert.equal(await controller.once(), true);
  assert.equal(await controller.start(), true);
  listener?.({ latitude: 42, longitude: -94, accuracy: 15 });
  clock += 5_000; listener?.({ latitude: 43, longitude: -95, accuracy: 15 });
  clock += 5_000; listener?.({ latitude: 44, longitude: -96, accuracy: 15 });
  assert.equal(reports.length, 3);
  assert.equal(continuousOptions.intervalMs, 10_000);
  assert.equal(continuousOptions.distanceFilter, undefined);
  assert.equal((reports[0] as any).location.timezone_hint, 'America/Chicago');
  assert.equal((reports[1] as any).location.latitude, 42);
  assert.equal((reports[2] as any).location.latitude, 44);
  assert.equal((reports[2] as any).location.timezone_hint, 'America/Chicago');
  assert.equal(await controller.stop(), true);
  assert.equal(stopped, 1);
  assert.equal(listener, undefined);
});

test('automatic location retries high, high, then medium and reports only an acceptable fix', async () => {
  const reports: any[] = [], options: any[] = [];
  const values = [null, { latitude: 41, longitude: -93, accuracy: 180 }, { latitude: 41.5, longitude: -93.6, accuracy: 24 }];
  const bridge = {
    getAppLocation: async (value: any) => { options.push(value); return values.shift() ?? null; },
    startAppLocationUpdates: async () => true, stopAppLocationUpdates: async () => true,
    onAppLocationChanged: () => () => {}
  };
  const controller = new LocationController(bridge, report => reports.push(report), async () => {});
  const request = '123e4567-e89b-12d3-a456-426614174000', attempts = [
    { accuracy: 'high' as const, timeout_ms: 7000 }, { accuracy: 'high' as const, timeout_ms: 5000 },
    { accuracy: 'medium' as const, timeout_ms: 3000 }
  ];
  const progress: number[] = [];
  assert.deepEqual(await controller.automatic(request, attempts, 100, value => progress.push(value)), { ok: true });
  assert.deepEqual(progress, [1, 2, 3]); assert.deepEqual(options.map(item => item.timeoutMs), [7000, 5000, 3000]);
  assert.equal(reports.length, 1); assert.equal(reports[0].request_id, request); assert.equal(reports[0].location.accuracy, 24);
});

test('automatic location reports low accuracy after three attempts and ignores a cancelled late result', async () => {
  const reports: any[] = [];
  let release!: (value: any) => void;
  const bridge = {
    getAppLocation: async () => new Promise<any>(resolve => { release = resolve; }),
    startAppLocationUpdates: async () => true, stopAppLocationUpdates: async () => true,
    onAppLocationChanged: () => () => {}
  };
  const controller = new LocationController(bridge, report => reports.push(report), async () => {});
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const task = controller.automatic(id, [{ accuracy: 'high', timeout_ms: 1000 }], 100, () => {});
  controller.cancelAutomatic(id); release({ latitude: 41, longitude: -93, accuracy: 5 });
  assert.deepEqual(await task, { ok: false, reason: 'cancelled' }); assert.equal(reports.length, 0);

  const lowBridge = { ...bridge, getAppLocation: async () => ({ latitude: 41, longitude: -93, accuracy: 150 }) };
  const low = new LocationController(lowBridge, report => reports.push(report), async () => {});
  assert.deepEqual(await low.automatic(id, [{ accuracy: 'high', timeout_ms: 1000 }], 100, () => {}), { ok: false, reason: 'low_accuracy' });
  assert.equal(reports.length, 0);
});
