import type { PlaceCandidate, RouteCandidate } from './routes.js';
import { recommendCandidates, RouteError, type RouteComparisonResult, type RouteProvider } from './routes.js';
import type { DialogueModel } from './conversation.js';

export const PLACE_CHECK_LIMITS = Object.freeze({ details: 4, searches: 2, timeoutMs: 30_000, freshMs: 120_000 });
export type PlaceHours = {
  checkedAt: number; openNow?: boolean; closesAt?: number; foodOpenNow?: boolean; foodClosesAt?: number;
  source: 'google' | 'official_web'; sourceUrl?: string;
};
export type PlaceHoursLookup = { placeId: string; name: string; address: string; website: string; at: number };
export function freshHours(hours: PlaceHours | undefined, now: number) {
  return !!hours && hours.checkedAt <= now && now - hours.checkedAt < PLACE_CHECK_LIMITS.freshMs;
}
export function availability(candidate: PlaceCandidate, now: number, durationSeconds = 0, food = false) {
  if (candidate.businessStatus === 'CLOSED_PERMANENTLY') return 'closed';
  const h = candidate.hours;
  if (!freshHours(h, now)) return 'unknown';
  if (candidate.businessStatus === 'CLOSED_TEMPORARILY' || candidate.businessStatus === 'FUTURE_OPENING'
    || h!.openNow === false || (food && h!.foodOpenNow === false)) return 'closed';
  const arrival = now + durationSeconds * 1000;
  if ((h!.closesAt !== undefined && h!.closesAt <= arrival)
    || (food && h!.foodClosesAt !== undefined && h!.foodClosesAt <= arrival)) return 'closing';
  return h!.openNow === true ? 'open' : 'unknown';
}
export function prioritizedOpen(candidates: RouteCandidate[], now: number, food: boolean) {
  return candidates.filter(c => !['closed', 'closing'].includes(availability(c, now, c.durationSeconds, food)))
    .sort((a, b) => Number(availability(b, now, b.durationSeconds, food) === 'open')
      - Number(availability(a, now, a.durationSeconds, food) === 'open'));
}
/** Type evidence, not name substrings. A parking facility is valid only when requested. */
export function intendedFacilities(query: string, candidates: PlaceCandidate[]) {
  const rules: [RegExp, string[]][] = [
    [/parking|停车|停車/i, ['parking', 'parking_lot']],
    [/bus|transit|公交|巴士|车站|車站/i, ['bus_stop', 'transit_station']],
  ];
  const negatedFacility = /(?:不要|不是|不去|别找|not|no)[^，。!?]{0,30}(?:parking|停车|停車|bus|公交)/i.test(query);
  return candidates.filter(c => !rules.some(([explicit, types]) => (!explicit.test(query) || negatedFacility)
    && types.includes(c.primaryType ?? c.types?.[0] ?? '')));
}
export function parseGoogleHours(raw: any, at: number): PlaceHours {
  const stamp = (v: unknown) => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v)
    && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined;
  const h = raw?.currentOpeningHours;
  const kitchen = Array.isArray(raw?.currentSecondaryOpeningHours)
    ? raw.currentSecondaryOpeningHours.find((v: any) => v?.secondaryHoursType === 'KITCHEN') : undefined;
  return { checkedAt: at, source: 'google',
    ...(typeof h?.openNow === 'boolean' ? { openNow: h.openNow } : {}),
    ...(stamp(h?.nextCloseTime) === undefined ? {} : { closesAt: stamp(h.nextCloseTime) }),
    ...(typeof kitchen?.openNow === 'boolean' ? { foodOpenNow: kitchen.openNow } : {}),
    ...(stamp(kitchen?.nextCloseTime) === undefined ? {} : { foodClosesAt: stamp(kitchen.nextCloseTime) }) };
}
export function publicWebsite(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1500) return;
  try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.port
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname)) return;
    return u.href; } catch { return; }
}

/** Bound even a non-cooperative test adapter; late results never mutate the selected candidates. */
async function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try { return await Promise.race([run(), new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  })]); } finally { signal.removeEventListener('abort', abort); }
}
export async function verifyRecommendations(result: RouteComparisonResult, routes: RouteProvider,
  web: DialogueModel['verifyPlaceHours'], signal: AbortSignal, now = Date.now, timeoutMs: number = PLACE_CHECK_LIMITS.timeoutMs) {
  if (!routes.verifyPlace || (result.nearbyPreferences?.visitTime ?? 'now') !== 'now') return result;
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new Error('PLACE_CHECK_TIMEOUT')), timeoutMs);
  const combined = AbortSignal.any([signal, controller.signal]);
  const candidates = result.candidates.map(c => ({ ...c }));
  const ordered = [...candidates].sort((a, b) => Number(b.placeId === result.recommendedPlaceId) - Number(a.placeId === result.recommendedPlaceId));
  const food = result.nearbyPreferences?.needsFood === true || /restaurant|fast food|餐|吃饭|吃點|吃点/i.test(result.query);
  let details = 0, searches = 0, confirmed = 0;
  try {
    for (const c of ordered) {
      combined.throwIfAborted();
      if (availability(c, now(), c.durationSeconds, food) === 'closed') continue;
      const needsCheck = !freshHours(c.hours, now()) || c.hours?.openNow === undefined
        || (food && c.hours?.closesAt === undefined);
      if (needsCheck && details < PLACE_CHECK_LIMITS.details) {
        details++;
        try {
          const checked = await bounded(() => routes.verifyPlace!(c, combined), combined);
          combined.throwIfAborted();
          if (checked.placeId === c.placeId) Object.assign(c, checked);
        } catch { combined.throwIfAborted(); }
      }
      if (availability(c, now(), c.durationSeconds, food) === 'unknown' && web && c.website && c.address && searches < PLACE_CHECK_LIMITS.searches) {
        searches++;
        try {
          const h = await bounded(() => web({ placeId: c.placeId, name: c.name, address: c.address!, website: c.website!, at: now() }, combined), combined);
          combined.throwIfAborted();
          if (h && freshHours(h, now())) { c.hours = { ...c.hours, ...h }; c.openNow = h.openNow; }
        } catch { combined.throwIfAborted(); }
      }
      if (availability(c, now(), c.durationSeconds, food) === 'open' && ++confirmed >= 2) break;
    }
  } catch { signal.throwIfAborted(); /* Timeout is unknown, never proof of closure. */ }
  finally { clearTimeout(deadline); }
  signal.throwIfAborted();
  const kept = prioritizedOpen(candidates, now(), food);
  if (!kept.length) throw new RouteError('ROUTE_NO_MATCHING_PLACES', 'ROUTE_NO_MATCHING_PLACES', 'places', undefined, false,
    undefined, candidates.map(c => ({ placeId: c.placeId, name: c.name,
      reason: availability(c, now(), c.durationSeconds, food) === 'closing' ? 'closing' as const : 'closed' as const })));
  const open = kept.filter(c => availability(c, now(), c.durationSeconds, food) === 'open');
  const { recommended, basis } = recommendCandidates(open.length ? open : kept);
  const removed = candidates.filter(c => !kept.includes(c)).map(c => ({ placeId: c.placeId, name: c.name,
    reason: availability(c, now(), c.durationSeconds, food) === 'closing' ? 'closing' as const : 'closed' as const }));
  return { ...result, candidates: kept, recommendedPlaceId: recommended.placeId, recommendationBasis: basis,
    excluded: [...(result.excluded ?? []), ...removed], availabilityCheckedAt: now() };
}
