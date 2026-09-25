import type { EphemeralLocation } from './location.js';
import type { CostLedger } from './cost-ledger.js';

/** Search scope, not proof of residence, venue suitability or route feasibility. */
export type SearchArea = { source: 'requested_area' | 'mapped_places' | 'google_locality'; labels: string[] };
export function searchArea(source: SearchArea['source'], values: unknown[]): SearchArea | undefined {
  const labels = [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0
    && v.length <= 240 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)).map(v => v.trim()))].slice(0, 3);
  return labels.length ? { source, labels } : undefined;
}

/** Coordinates/key stay within Google's request; only political components leave this function. */
export async function resolveSearchArea(key: string, location: EphemeralLocation, signal: AbortSignal,
  fetcher: typeof fetch, costs?: CostLedger): Promise<SearchArea | undefined> {
  signal.throwIfAborted();
  const ticket = await costs?.reserveGoogle('geocoding', 1);
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${location.latitude},${location.longitude}`);
  url.searchParams.set('result_type', 'locality|postal_town|administrative_area_level_2');
  url.searchParams.set('key', key);
  try {
    const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await ticket?.settle(0); await response.body?.cancel(); return undefined; }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 128 * 1024) return undefined;
    const data = JSON.parse(raw);
    await ticket?.settle(data.status === 'OK' || data.status === 'ZERO_RESULTS' ? 1 : 0);
    signal.throwIfAborted();
    if (data.status !== 'OK' || !Array.isArray(data.results)) return undefined;
    for (const result of data.results.slice(0, 10)) {
      const components = Array.isArray(result.address_components) ? result.address_components : [];
      const component = (type: string) => components.find((c: any) => Array.isArray(c.types) && c.types.includes(type))?.long_name;
      const city = component('locality') ?? component('postal_town') ?? component('administrative_area_level_2');
      const country = component('country');
      if (typeof city !== 'string' || typeof country !== 'string') continue;
      const parts = [city, component('administrative_area_level_1'), country].filter(v => typeof v === 'string');
      const area = searchArea('google_locality', [parts.join(', ')]);
      if (area) return area;
    }
    return undefined;
  } catch { signal.throwIfAborted(); return undefined; } // No raw provider error/URL may escape.
}
