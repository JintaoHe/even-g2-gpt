import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCATION_PRESETS, pickLocationPreset } from '../dev/location-presets.ts';

test('development location presets are bounded, unique public test points', () => {
  assert.equal(LOCATION_PRESETS.length, 6);
  assert.equal(new Set(LOCATION_PRESETS.map(value => value.id)).size, LOCATION_PRESETS.length);
  assert.equal(new Set(LOCATION_PRESETS.map(value => `${value.latitude},${value.longitude}`)).size, LOCATION_PRESETS.length);
  for (const value of LOCATION_PRESETS) {
    assert.ok(value.latitude >= -90 && value.latitude <= 90);
    assert.ok(value.longitude >= -180 && value.longitude <= 180);
    assert.ok(value.accuracy > 0 && value.accuracy <= 100);
    assert.equal(new Intl.DateTimeFormat('en', { timeZone: value.timezone }).resolvedOptions().timeZone, value.timezone);
  }
});

test('random preset selection covers the first and last bounded entries', () => {
  assert.equal(pickLocationPreset(() => 0), LOCATION_PRESETS[0]);
  assert.equal(pickLocationPreset(() => 0.999999), LOCATION_PRESETS.at(-1));
  assert.equal(pickLocationPreset(() => Number.NaN), LOCATION_PRESETS[0]);
});
