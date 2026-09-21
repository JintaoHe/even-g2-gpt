/** A deliberately bounded subset of official Places types, not a vocabulary of user phrases.
 * https://developers.google.com/maps/documentation/places/web-service/place-types */
export const nearbyExcludedTypes = ['bar', 'wine_bar', 'sports_bar', 'pub', 'night_club', 'restaurant', 'fast_food_restaurant',
  'cafe', 'coffee_shop', 'bakery', 'supermarket', 'grocery_store', 'department_store', 'shopping_mall',
  'cell_phone_store', 'pharmacy', 'parking', 'bus_stop', 'transit_station', 'gas_station'] as const;
export type NearbyPreferences = {
  vibe?: 'quiet' | 'lively' | 'any'; needsFood?: boolean;
  priceCeiling?: 'inexpensive' | 'moderate' | 'expensive'; excludeTypes?: string[];
  visitTime?: 'now' | 'future' | 'unknown';
  unhandledExclusions?: boolean;
};
export type NearbyIntent = {
  mode: 'specific' | 'recommend'; taskAction: 'continue' | 'replace' | 'clear'; delegated: boolean;
  patch: { [K in keyof NearbyPreferences]?: NearbyPreferences[K] | null };
  invalidPatchCount?: number;
};

const patchSchema = (value: object) => ({ type: 'object', properties: {
  operation: { type: 'string', enum: ['keep', 'set', 'clear'] }, value
}, required: ['operation', 'value'], additionalProperties: false });
const enumValue = (values: string[]) => ({ type: ['string', 'null'], enum: [null, ...values] });
export const nearbyIntentSchema = { anyOf: [{ type: 'null' }, { type: 'object', properties: {
  mode: { type: 'string', enum: ['specific', 'recommend'] },
  task_action: { type: 'string', enum: ['continue', 'replace', 'clear'] }, delegated: { type: 'boolean' },
  patch: { type: 'object', properties: {
    vibe: patchSchema(enumValue(['quiet', 'lively', 'any'])),
    needs_food: patchSchema({ type: ['boolean', 'null'] }),
    price_ceiling: patchSchema(enumValue(['inexpensive', 'moderate', 'expensive'])),
    exclude_types: patchSchema({ anyOf: [{ type: 'null' }, { type: 'array', items: {
      type: 'string', enum: [...nearbyExcludedTypes] }, maxItems: 6 }] }),
    visit_time: patchSchema(enumValue(['now', 'future', 'unknown'])),
    unhandled_exclusions: patchSchema({ type: ['boolean', 'null'] })
  }, required: ['vibe', 'needs_food', 'price_ceiling', 'exclude_types', 'visit_time', 'unhandled_exclusions'], additionalProperties: false }
}, required: ['mode', 'task_action', 'delegated', 'patch'], additionalProperties: false }] };

/** Invalid values are ignored, never interpreted as a request to clear a preference. */
export function parseNearbyIntent(raw: any): NearbyIntent | undefined {
  if (!raw || !['specific', 'recommend'].includes(raw.mode)
    || !['continue', 'replace', 'clear'].includes(raw.task_action) || typeof raw.delegated !== 'boolean'
    || !raw.patch || typeof raw.patch !== 'object' || Array.isArray(raw.patch)) return undefined;
  const patch: NearbyIntent['patch'] = {};
  let invalidPatchCount = 0;
  const read = (key: string, valid: (value: any) => boolean): any => {
    const entry = raw.patch[key];
    if (entry === undefined || entry?.operation === 'keep' && entry.value === null) return undefined;
    if (entry?.operation === 'clear' && entry.value === null) return null;
    if (entry?.operation === 'set' && valid(entry.value)) return entry.value;
    invalidPatchCount++; return undefined;
  };
  const vibe = read('vibe', v => ['quiet', 'lively', 'any'].includes(v));
  const food = read('needs_food', v => typeof v === 'boolean');
  const price = read('price_ceiling', v => ['inexpensive', 'moderate', 'expensive'].includes(v));
  const visit = read('visit_time', v => ['now', 'future', 'unknown'].includes(v));
  const unhandled = read('unhandled_exclusions', v => typeof v === 'boolean');
  const types = read('exclude_types', v => Array.isArray(v) && v.length <= 6
    && v.every(t => typeof t === 'string' && (nearbyExcludedTypes as readonly string[]).includes(t)));
  if (vibe !== undefined) patch.vibe = vibe;
  if (food !== undefined) patch.needsFood = food;
  if (price !== undefined) patch.priceCeiling = price;
  if (visit !== undefined) patch.visitTime = visit;
  if (unhandled !== undefined) patch.unhandledExclusions = unhandled;
  if (raw.patch.exclude_types?.operation === 'set' && types === undefined) patch.unhandledExclusions = true;
  if (types !== undefined) patch.excludeTypes = types === null ? null : [...new Set<string>(types)];
  return { mode: raw.delegated ? 'recommend' : raw.mode, taskAction: raw.task_action, delegated: raw.delegated, patch,
    ...(invalidPatchCount ? { invalidPatchCount } : {}) };
}

export function applyNearbyIntent(previous: NearbyPreferences, intent: NearbyIntent): NearbyPreferences {
  if (intent.taskAction === 'clear') return {};
  const result: NearbyPreferences = intent.taskAction === 'replace' ? {} : { ...previous };
  for (const key of ['vibe', 'needsFood', 'priceCeiling', 'excludeTypes', 'visitTime', 'unhandledExclusions'] as const) {
    const value = intent.patch[key];
    if (value === null) delete result[key];
    else if (value !== undefined) Object.assign(result, { [key]: Array.isArray(value) ? [...value] : value });
  }
  return result;
}
