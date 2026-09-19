import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessOutdoor } from '../src/outdoor-decision.js';
import type { AirQualityEvidence, PollenEvidence, WeatherEvidence } from '../src/environment.js';

const weather: WeatherEvidence = { available: true, hourCount: 2, conditions: ['Sunny'], feelsLikeMinC: 20,
  feelsLikeMaxC: 23, precipitationMaxPercent: 10, thunderstormMaxPercent: 0, windMaxKph: 12, uvMax: 2 };
const air: AirQualityEvidence = { available: true, hourCount: 2, indexCode: 'usa_epa', aqiMax: 42, category: 'Good' };
const pollen: PollenEvidence = { available: true, date: '2026-09-18',
  tree: { indexAvailable: true, inSeason: true, value: 4, category: 'High' },
  grass: { indexAvailable: true, inSeason: false, value: 1, category: 'Very low' },
  weed: { indexAvailable: true, inSeason: true, value: 2, category: 'Low' },
  overallValue: 4, overallCategory: 'High', dominantType: 'tree' };

test('good weather still surfaces high pollen instead of acting like a data reporter or declaring perfect conditions', () => {
  const decision = assessOutdoor(weather, air, pollen);
  assert.equal(decision.suitability, 'caution'); assert.equal(decision.confidence, 'medium');
  assert.deepEqual(decision.issues, [{ code: 'pollen_high', severity: 'caution', value: 4 }]);
});
test('an explicit tree-pollen sensitivity changes the recommendation without making a medical diagnosis', () => {
  const decision = assessOutdoor(weather, air, pollen, { pollenSensitivity: ['tree'] });
  assert.equal(decision.suitability, 'poor');
  assert.ok(decision.issues.some(issue => issue.code === 'tree_pollen_high_for_sensitive_user' && issue.severity === 'block'));
});

test('missing evidence is unknown, never silently safe or zero', () => {
  const unavailablePollen: PollenEvidence = { available: false, date: '2026-09-18', tree: { indexAvailable: false },
    grass: { indexAvailable: false }, weed: { indexAvailable: false } };
  const decision = assessOutdoor(weather, { available: false, hourCount: 0 }, unavailablePollen,
    { pollenSensitivity: ['grass'] });
  assert.equal(decision.suitability, 'caution'); assert.equal(decision.confidence, 'low');
  assert.ok(decision.issues.some(issue => issue.code === 'air_quality_unavailable'));
  assert.ok(decision.issues.some(issue => issue.code === 'pollen_unavailable_for_sensitive_user'));
});

test('clear environmental hazards fail the outdoor gate even when other evidence looks good', () => {
  const decision = assessOutdoor({ ...weather, precipitationMaxPercent: 85, thunderstormMaxPercent: 45 }, air,
    { ...pollen, overallValue: 1, tree: { indexAvailable: true, value: 1 } });
  assert.equal(decision.suitability, 'poor');
  assert.deepEqual(decision.issues.filter(issue => issue.severity === 'block').map(issue => issue.code),
    ['thunderstorm_risk', 'heavy_precipitation_risk']);
});
