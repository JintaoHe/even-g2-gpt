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
});

test('one-shot and continuous controls are explicit and stoppable', async () => {
  const reports: unknown[] = []; let listener: ((value: any) => void) | undefined, stopped = 0;
  const bridge = {
    getAppLocation: async () => ({ latitude: 41, longitude: -93, accuracy: 10 }),
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => { stopped++; return true; },
    onAppLocationChanged: (callback: (value: any) => void) => { listener = callback; return () => { listener = undefined; }; }
  };
  const controller = new LocationController(bridge, report => reports.push(report));
  assert.equal(await controller.once(), true);
  assert.equal(await controller.start(), true);
  listener?.({ latitude: 42, longitude: -94, accuracy: 15 });
  assert.equal(reports.length, 2);
  assert.equal(await controller.stop(), true);
  assert.equal(stopped, 1);
  assert.equal(listener, undefined);
});
