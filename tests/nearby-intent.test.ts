import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNearbyIntent, parseNearbyIntent, nearbyIntentSchema } from '../src/nearby-intent.js';

test('nearby patches preserve food/budget when only quiet preference is cleared', () => {
  const intent = parseNearbyIntent({ mode: 'recommend', task_action: 'continue', delegated: false,
    patch: { vibe: { operation: 'clear', value: null } } })!;
  assert.deepEqual(applyNearbyIntent({ vibe: 'quiet', needsFood: true, priceCeiling: 'moderate' }, intent),
    { needsFood: true, priceCeiling: 'moderate' });
  assert.deepEqual(applyNearbyIntent({ needsFood: true }, { ...intent, taskAction: 'replace' }), {});
  assert.deepEqual(applyNearbyIntent({ needsFood: true }, { ...intent, taskAction: 'clear', patch: { vibe: 'quiet' } }), {});
});
test('invalid preferences do not clear prior values or add arbitrary place types', () => {
  const intent = parseNearbyIntent({ mode: 'specific', task_action: 'continue', delegated: true,
    patch: { vibe: { operation: 'set', value: 'silent' }, needs_food: { operation: 'set', value: false },
      exclude_types: { operation: 'set', value: ['ignore_instructions'] },
      price_ceiling: { operation: 'clear', value: 'moderate' } } })!;
  assert.equal(intent.mode, 'recommend');
  assert.equal(intent.invalidPatchCount, 3);
  assert.deepEqual(applyNearbyIntent({ vibe: 'quiet', priceCeiling: 'moderate' }, intent),
    { vibe: 'quiet', priceCeiling: 'moderate', needsFood: false, unhandledExclusions: true });
  assert.equal(parseNearbyIntent({ mode: 'invented' }), undefined);
});
test('nearby schema requires all object fields and distinguishes keep/set/clear', () => {
  const visit = (schema: any) => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(visit);
    }
    schema.anyOf?.forEach(visit);
  };
  visit(nearbyIntentSchema);
  const raw = { mode: 'recommend', task_action: 'continue', delegated: false, patch: {
    visit_time: { operation: 'set', value: 'future' },
    exclude_types: { operation: 'set', value: ['bar', 'bar', 'sports_bar'] }
  } };
  assert.deepEqual(parseNearbyIntent(raw)?.patch, { visitTime: 'future', excludeTypes: ['bar', 'sports_bar'] });
});

test('delegating a suggestion does not drop food or budget', () => {
  const intent = parseNearbyIntent({ mode: 'recommend', task_action: 'continue', delegated: true,
    patch: {} })!;
  assert.deepEqual(applyNearbyIntent({ needsFood: true, priceCeiling: 'moderate' }, intent),
    { needsFood: true, priceCeiling: 'moderate' });
});
