import type { RouteTravelMode } from './conversation.js';
import type { EphemeralLocation } from './location.js';
import type { CostLedger, GoogleSku } from './cost-ledger.js';
import type { ProviderMetricObserver, NearbyMetricObserver } from './runtime-metrics.js';
import { cuisineTypes, type NearbyPreferences } from './nearby-intent.js';
import { freshHours, parseGoogleHours, publicWebsite, secureWebsiteHint, type PlaceHours } from './place-availability.js';
import { resolveSearchArea, type SearchArea } from './search-area.js';

export type RouteOrigin = { kind: 'coordinates'; location: EphemeralLocation } | { kind: 'address'; address: string };
export type RouteRequestKind = 'destination' | 'nearby';
export type PlaceCandidate = {
  placeId: string;
  name: string;
  address?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  openNow?: boolean;
  hours?: PlaceHours;
  website?: string;
  timeZone?: string;
  priceLevel?: 'free' | 'inexpensive' | 'moderate' | 'expensive' | 'very_expensive';
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'FUTURE_OPENING';
};
export type CandidateQuality = { adjustedRating?: number; reliable: boolean; risk: boolean };
export type RouteCandidate = PlaceCandidate & {
  durationSeconds: number;
  staticDurationSeconds?: number;
  distanceMeters: number;
  quality: CandidateQuality;
};
export type RouteComparisonResult = {
  availabilityCheckedAt?: number;
  query: string;
  candidates: RouteCandidate[];
  recommendedPlaceId: string;
  recommendationBasis: 'fastest' | 'quality_risk' | 'balanced';
  mode: RouteTravelMode;
  trafficAware: boolean;
  nearbyPreferences?: NearbyPreferences;
  excluded?: NearbyExclusion[];
};
export type RouteRequest = {
  origin: RouteOrigin;
  destination: string;
  mode: RouteTravelMode;
  kind?: RouteRequestKind;
  /** Sanitized Place IDs from the immediately preceding comparison. Skips Places search. */
  candidates?: PlaceCandidate[];
  nearbyPreferences?: NearbyPreferences;
};
export type NearbyExclusion = { placeId: string; name: string; address?: string; reason: 'closed' | 'closing' | 'price' | 'type' | 'name' | 'cuisine' };
export type RouteDiscovery = { query: string; candidates: PlaceCandidate[]; excluded?: NearbyExclusion[] };

export interface RouteProvider {
  searchArea?(location: EphemeralLocation, signal: AbortSignal): Promise<SearchArea | undefined>;
  verifyPlace?(candidate: PlaceCandidate, signal: AbortSignal): Promise<PlaceCandidate>;
  discover?(request: RouteRequest, signal: AbortSignal): Promise<RouteDiscovery>;
  route(request: RouteRequest, signal: AbortSignal): Promise<RouteComparisonResult>;
}

export class RouteError extends Error {
  constructor(public code: 'ROUTE_DESTINATION_NOT_FOUND' | 'ROUTE_INVALID' | 'ROUTE_UNAVAILABLE' | 'ROUTE_NO_MATCHING_PLACES', message = code,
    public stage?: 'places' | 'routes', public providerStatus?: number, public retryable = false,
    public providerReason?: string, public excluded?: NearbyExclusion[]) { super(message); }
}

type Fetch = typeof fetch;
export const MAX_CANDIDATES = 5;
const PLACE_SEARCH_CANDIDATES = 10;
const NEARBY_RADIUS_M = 20_000;
const MAX_TEXT_SEARCH_BIAS_RADIUS_M = 50_000;
const RATING_PRIOR = 4;
const RATING_PRIOR_WEIGHT = 50;
const priceLevels = ['free', 'inexpensive', 'moderate', 'expensive', 'very_expensive'] as const;

const boundedText = (value: unknown, limit: number) => typeof value === 'string'
  ? value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, limit) : '';
const boundedNumber = (value: unknown, min: number, max: number) => typeof value === 'number'
  && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const durationSeconds = (value: unknown) => {
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)s$/.exec(value);
  const seconds = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 7 * 86400) throw new RouteError('ROUTE_INVALID');
  return Math.round(seconds);
};
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')); };
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});

function sanitizeCandidate(value: any): PlaceCandidate | undefined {
  const placeId = boundedText(value?.placeId ?? value?.id, 500);
  const name = boundedText(value?.name ?? value?.displayName?.text, 160);
  if (!placeId || !name) return undefined;
  const address = boundedText(value?.address ?? value?.formattedAddress, 240);
  const rating = boundedNumber(value?.rating, 1, 5);
  const count = boundedNumber(value?.userRatingCount, 0, 1_000_000_000);
  const primaryType = boundedText(value?.primaryType, 80);
  const types = Array.isArray(value?.types) ? value.types.slice(0, 20)
    .map((type: unknown) => boundedText(type, 80)).filter(Boolean) : [];
  const latitude = boundedNumber(value?.location?.latitude, -90, 90);
  const longitude = boundedNumber(value?.location?.longitude, -180, 180);
  const openNow = value?.openNow ?? value?.currentOpeningHours?.openNow;
  const price = typeof value?.priceLevel === 'string' ? value.priceLevel.replace(/^PRICE_LEVEL_/, '').toLowerCase() : '';
  const priceLevel = priceLevels.find(level => level === price);
  const businessStatus = ['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY', 'FUTURE_OPENING'].includes(value?.businessStatus)
    ? value.businessStatus as PlaceCandidate['businessStatus'] : undefined;
  return { placeId, name, ...(address ? { address } : {}), ...(rating === undefined ? {} : { rating }),
    ...(count === undefined ? {} : { userRatingCount: Math.round(count) }), ...(primaryType ? { primaryType } : {}),
    ...(types.length ? { types } : {}), ...(latitude === undefined || longitude === undefined ? {} : { location: { latitude, longitude } }),
    ...(typeof openNow === 'boolean' ? { openNow } : {}), ...(priceLevel ? { priceLevel } : {}),
    ...(value?.hours ? { hours: value.hours } : {}), ...(publicWebsite(value?.website) ? { website: publicWebsite(value.website) } : {}),
    ...(businessStatus ? { businessStatus } : {}) };
}

export function prefilterNearby(candidates: PlaceCandidate[], prefs: NearbyPreferences = {}) {
  const nameWords = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const excluded: NearbyExclusion[] = [], kept: PlaceCandidate[] = [];
  for (const candidate of candidates) {
    const reason: NearbyExclusion['reason'] | undefined = candidate.businessStatus === 'CLOSED_PERMANENTLY'
      || ((prefs.visitTime ?? 'now') === 'now' && (candidate.openNow === false
        || candidate.businessStatus === 'CLOSED_TEMPORARILY' || candidate.businessStatus === 'FUTURE_OPENING')) ? 'closed'
      : prefs.priceCeiling && candidate.priceLevel && priceLevels.indexOf(candidate.priceLevel) > priceLevels.indexOf(prefs.priceCeiling) ? 'price'
      : prefs.excludeNames?.some(name => (` ${nameWords(candidate.name)} `).includes(` ${nameWords(name)} `)) ? 'name'
      : [candidate.primaryType, ...(candidate.types ?? [])].some(type => type && prefs.excludeTypes?.includes(type)) ? 'type'
      : prefs.cuisineTypes?.length && ![candidate.primaryType, ...(candidate.types ?? [])].some(type => type && prefs.cuisineTypes!.includes(type)) ? 'cuisine' : undefined;
    if (reason) excluded.push({ placeId: candidate.placeId, name: candidate.name, ...(candidate.address ? { address: candidate.address } : {}), reason }); else kept.push(candidate);
  }
  return { candidates: kept, excluded };
}

/** Coarse relevance only: distance is never a substitute for a Routes duration. */
export function rankNearbyCoarse(candidates: PlaceCandidate[], prefs: NearbyPreferences, origin: RouteOrigin) {
  const distance = (candidate: PlaceCandidate): number | undefined => {
    if (origin.kind === 'coordinates' && candidate.location) {
      const rad = (degrees: number) => degrees * Math.PI / 180;
      const a = origin.location, b = candidate.location;
      const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
        + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
    }
    return undefined;
  };
  const knownDistances = candidates.map(distance).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  // Unknown distance is not zero: use a neutral pool median for coarse ranking only.
  const unknownDistance = knownDistances[Math.floor(knownDistances.length / 2)] ?? 0;
  const score = (candidate: PlaceCandidate) => {
    const distanceKm = distance(candidate) ?? unknownDistance;
    const quality = assessCandidate(candidate).adjustedRating;
    const types = [candidate.primaryType, ...(candidate.types ?? [])];
    const foodPrior = prefs.needsFood && types.some(type => type === 'restaurant' || type === 'bakery'
      || type === 'cafe' || type?.endsWith('_restaurant')) ? -0.5 : 0;
    const vibePrior = prefs.vibe === 'quiet' && types.some(type => ['wine_bar', 'cafe', 'coffee_shop'].includes(type ?? ''))
      || prefs.vibe === 'lively' && types.some(type => ['bar', 'sports_bar', 'night_club', 'pub'].includes(type ?? '')) ? -0.25 : 0;
    return distanceKm + (quality === undefined ? 0 : Math.max(0, 4.5 - quality) * 0.5) + foodPrior + vibePrior;
  };
  return candidates.map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.candidate);
}

export function assessCandidate(candidate: PlaceCandidate): CandidateQuality {
  const count = candidate.userRatingCount ?? 0;
  if (candidate.rating === undefined || count < 1) return { reliable: false, risk: false };
  const adjustedRating = (candidate.rating * count + RATING_PRIOR * RATING_PRIOR_WEIGHT) / (count + RATING_PRIOR_WEIGHT);
  return { adjustedRating, reliable: count >= 20, risk: count >= 50 && candidate.rating <= 2.5 };
}

function rankingScore(candidate: RouteCandidate) {
  const adjusted = candidate.quality.adjustedRating ?? RATING_PRIOR;
  const ratingPenaltyMinutes = Math.max(0, 4.5 - adjusted) * 8;
  const experienceRiskMinutes = candidate.quality.risk ? 20 : 0;
  return candidate.durationSeconds / 60 + ratingPenaltyMinutes + experienceRiskMinutes;
}

export function recommendCandidates(candidates: RouteCandidate[]) {
  if (!candidates.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
  const fastest = [...candidates].sort((a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters)[0];
  const recommended = [...candidates].sort((a, b) => rankingScore(a) - rankingScore(b)
    || a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters)[0];
  const basis: RouteComparisonResult['recommendationBasis'] = recommended.placeId === fastest.placeId
    ? 'fastest' : fastest.quality.risk ? 'quality_risk' : 'balanced';
  return { recommended, fastest, basis };
}

export class GoogleRoutesProvider implements RouteProvider {
  constructor(private key: string, private fetcher: Fetch = fetch,
    private placesEndpoint = 'https://places.googleapis.com/v1/places:searchText',
    private routesEndpoint = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    private costs?: CostLedger, private observe?: ProviderMetricObserver, private observeNearby?: NearbyMetricObserver) {
    if (!key.trim() || key.length > 500) throw new Error('Invalid Google Maps key');
    for (const endpoint of [placesEndpoint, routesEndpoint]) if (new URL(endpoint).protocol !== 'https:'
      && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(endpoint)) throw new Error('Invalid Maps endpoint');
  }

  private async post(stage: 'places' | 'routes', endpoint: string, body: object, fieldMask: string, signal: AbortSignal,
    sku: GoogleSku, expectedUnits = 1) {
    let lastError: RouteError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const reservation = await this.costs?.reserveGoogle(sku, expectedUnits);
      const startedAt = Date.now(); let observed = false;
      try {
        const response = await this.fetcher(endpoint, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fieldMask }, body: JSON.stringify(body) });
        if (response.ok) {
          const data = await response.json();
          await reservation?.settle(stage === 'routes' && Array.isArray(data) ? Math.min(expectedUnits, data.length) : 1);
          observed = true; this.observe?.('google', 'success', Date.now() - startedAt);
          return data;
        }
        observed = true; this.observe?.('google', 'failure', Date.now() - startedAt);
        await reservation?.settle(0);
        let providerReason: string | undefined;
        try {
          const raw = await response.text();
          if (raw.length <= 65_536) {
            const payload = JSON.parse(raw);
            const reason = payload?.error?.details?.find((detail: any) => typeof detail?.reason === 'string')?.reason;
            if (typeof reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(reason)) providerReason = reason;
          }
        } catch { /* Never expose or depend on provider error prose. */ }
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        const error = new RouteError(response.status === 400 ? 'ROUTE_INVALID' : 'ROUTE_UNAVAILABLE',
          response.status === 400 ? 'ROUTE_INVALID' : 'ROUTE_UNAVAILABLE', stage, response.status, retryable, providerReason);
        if (!retryable) throw error;
        lastError = error;
      } catch (error) {
        if (!observed) this.observe?.('google', signal.aborted || (error as Error)?.name === 'AbortError'
          ? 'cancelled' : 'failure', Date.now() - startedAt);
        signal.throwIfAborted();
        if (error instanceof RouteError) {
          if (!error.retryable) throw error;
          lastError = error;
        } else lastError = new RouteError('ROUTE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', stage, undefined, true);
        if (attempt === 2) throw lastError;
      }
      await delay(attempt ? 750 : 250, signal);
    }
    throw lastError ?? new RouteError('ROUTE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', stage);
  }

  searchArea(location: EphemeralLocation, signal: AbortSignal) {
    return resolveSearchArea(this.key, location, signal, this.fetcher, this.costs);
  }

  private async findCandidates(request: RouteRequest, destination: string, signal: AbortSignal): Promise<PlaceCandidate[]> {
    if (request.candidates?.length) {
      return request.candidates.slice(0, PLACE_SEARCH_CANDIDATES).map(sanitizeCandidate).filter((value): value is PlaceCandidate => !!value)
        .map(c => c.hours && !freshHours(c.hours, Date.now()) ? { ...c, openNow: undefined,
          businessStatus: c.businessStatus === 'CLOSED_PERMANENTLY' ? c.businessStatus : undefined } : c);
    }
    const nearby = request.kind === 'nearby';
    const cuisine = nearby && request.nearbyPreferences?.cuisineTypes?.length === 1
      ? request.nearbyPreferences.cuisineTypes[0] : undefined;
    const textQuery = nearby && request.origin.kind === 'address' ? `${destination} near ${boundedText(request.origin.address, 240)}` : destination;
    const search = async (radius: number | undefined) => {
      const bias = radius !== undefined && request.origin.kind === 'coordinates' ? { locationBias: { circle: { center: {
        latitude: request.origin.location.latitude, longitude: request.origin.location.longitude
      }, radius } } } : {};
      const places = await this.post('places', this.placesEndpoint, { textQuery, pageSize: PLACE_SEARCH_CANDIDATES,
        ...(cuisine && (cuisineTypes as readonly string[]).includes(cuisine) ? {includedType:cuisine,strictTypeFiltering:true} : {}),
        ...(nearby ? { rankPreference: 'DISTANCE' } : {}), ...bias },
      'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryType,places.types'
        + ',places.location,places.currentOpeningHours.openNow,places.currentOpeningHours.nextCloseTime,places.priceLevel,places.businessStatus', signal,
      'places-text-search-enterprise') as any;
      return (Array.isArray(places?.places) ? places.places : []).slice(0, PLACE_SEARCH_CANDIDATES)
        .map((raw: any) => { const c = sanitizeCandidate(raw); return c && { ...c, hours: parseGoogleHours(raw, Date.now()) }; })
        .filter((value: PlaceCandidate | undefined): value is PlaceCandidate => !!value);
    };
    // locationBias is a soft ranking hint, not a geographic restriction. Google
    // caps a Text Search circle at 50 km; explicit locality text can override it.
    let candidates = await search(request.origin.kind === 'coordinates'
      ? nearby ? NEARBY_RADIUS_M : MAX_TEXT_SEARCH_BIAS_RADIUS_M : undefined);
    if (!candidates.length && nearby && request.origin.kind === 'coordinates') {
      candidates = await search(MAX_TEXT_SEARCH_BIAS_RADIUS_M);
    }
    // Parking, transit stops, departments, pharmacies, and similarly specific
    // places can all be intentional destinations. Preserve them; the dialogue
    // model resolves semantic ambiguity with the user instead of deleting data.
    return candidates;
  }

  private prepareCandidates(request: RouteRequest, candidates: PlaceCandidate[]) {
    // A repeated Place ID must never spend two matrix elements or appear as two branches.
    candidates = candidates.filter((candidate, index) => candidates.findIndex(other => other.placeId === candidate.placeId) === index);
    if (request.kind !== 'nearby') return { candidates: candidates.slice(0, MAX_CANDIDATES), excluded: [] };
    const filtered = prefilterNearby(candidates, request.nearbyPreferences);
    this.observeNearby?.('prefiltered', filtered.excluded.length);
    if (!filtered.candidates.length && filtered.excluded.length) throw new RouteError('ROUTE_NO_MATCHING_PLACES',
      'ROUTE_NO_MATCHING_PLACES', 'places', undefined, false, undefined, filtered.excluded);
    return { candidates: (request.nearbyPreferences ? rankNearbyCoarse(filtered.candidates, request.nearbyPreferences, request.origin)
      : filtered.candidates).slice(0, MAX_CANDIDATES), excluded: filtered.excluded };
  }

  async discover(request: RouteRequest, signal: AbortSignal): Promise<RouteDiscovery> {
    const destination = boundedText(request.destination, 300);
    if (!destination || !['drive', 'walk', 'bicycle'].includes(request.mode)) throw new RouteError('ROUTE_INVALID');
    const found = await this.findCandidates({ ...request, candidates: undefined }, destination, signal);
    const { candidates, excluded } = this.prepareCandidates(request, found);
    if (!candidates.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
    return { query: destination, candidates, ...(excluded.length ? { excluded } : {}) };
  }

  /** One exact Place-ID read, no retry: caller owns the per-turn limit/deadline. */
  async verifyPlace(candidate: PlaceCandidate, signal: AbortSignal): Promise<PlaceCandidate> {
    signal.throwIfAborted();
    const reservation = await this.costs?.reserveGoogle('places-details-enterprise', 1);
    signal.throwIfAborted();
    const endpoint = new URL(this.placesEndpoint);
    endpoint.pathname = `/v1/places/${encodeURIComponent(candidate.placeId)}`; endpoint.search = '';
    const response = await this.fetcher(endpoint.href, { method: 'GET',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { 'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,primaryType,types,businessStatus,websiteUri,timeZone,currentOpeningHours,currentSecondaryOpeningHours' } });
    if (!response.ok) { await reservation?.settle(0); throw new RouteError('ROUTE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', 'places', response.status); }
    const raw: any = await response.json(); await reservation?.settle(1); signal.throwIfAborted();
    if (raw?.id !== candidate.placeId) throw new RouteError('ROUTE_INVALID');
    const updated = sanitizeCandidate(raw);
    if (!updated) throw new RouteError('ROUTE_INVALID');
    const hours = parseGoogleHours(raw, Date.now());
    return { ...candidate, ...updated, openNow: hours.openNow, hours, website: secureWebsiteHint(raw.websiteUri),
      ...(typeof raw.timeZone?.id === 'string' ? { timeZone: raw.timeZone.id } : {}) };
  }

  async route(request: RouteRequest, signal: AbortSignal): Promise<RouteComparisonResult> {
    const destination = boundedText(request.destination, 300);
    if (!destination || !['drive', 'walk', 'bicycle'].includes(request.mode)) throw new RouteError('ROUTE_INVALID');
    const found = await this.findCandidates(request, destination, signal);
    const { candidates, excluded } = this.prepareCandidates(request, found);
    if (!candidates.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
    const originWaypoint = request.origin.kind === 'coordinates' ? { location: { latLng: {
      latitude: request.origin.location.latitude, longitude: request.origin.location.longitude
    } } } : { address: boundedText(request.origin.address, 300) };
    if ('address' in originWaypoint && !originWaypoint.address) throw new RouteError('ROUTE_INVALID');
    const modes: Record<RouteTravelMode, string> = { drive: 'DRIVE', walk: 'WALK', bicycle: 'BICYCLE' };
    const trafficAware = request.mode === 'drive';
    if (request.kind === 'nearby') this.observeNearby?.('routed', candidates.length);
    const matrix = await this.post('routes', this.routesEndpoint, {
      origins: [{ waypoint: originWaypoint }],
      destinations: candidates.map((candidate: PlaceCandidate) => ({ waypoint: { placeId: candidate.placeId } })),
      travelMode: modes[request.mode], ...(trafficAware ? { routingPreference: 'TRAFFIC_AWARE' } : {})
    }, 'originIndex,destinationIndex,status,condition,distanceMeters,duration,staticDuration', signal,
    trafficAware ? 'route-matrix-pro' : 'route-matrix-essentials', candidates.length) as any;
    const elements = Array.isArray(matrix) ? matrix : [];
    const routes: RouteCandidate[] = [];
    for (const element of elements) {
      const index = Number.isInteger(element?.destinationIndex) ? element.destinationIndex : -1;
      const candidate = candidates[index];
      if (!candidate || element?.condition !== 'ROUTE_EXISTS' || element?.status?.code) continue;
      const distance = boundedNumber(element.distanceMeters, 0, 50_000_000);
      if (distance === undefined) continue;
      try {
        routes.push({ ...candidate, durationSeconds: durationSeconds(element.duration),
          ...(trafficAware && element.staticDuration !== undefined ? { staticDurationSeconds: durationSeconds(element.staticDuration) } : {}),
          distanceMeters: Math.round(distance), quality: assessCandidate(candidate) });
      } catch { /* A malformed matrix element must not discard other valid candidates. */ }
    }
    if (!routes.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
    const { recommended, basis } = recommendCandidates(routes);
    return { query: destination, candidates: routes, recommendedPlaceId: recommended.placeId,
      recommendationBasis: basis, mode: request.mode, trafficAware,
      ...(request.kind === 'nearby' ? { nearbyPreferences: request.nearbyPreferences ?? {}, excluded } : {}) };
  }
}

export function createRouteProvider(env: NodeJS.ProcessEnv = process.env, costs?: CostLedger,
  observe?: ProviderMetricObserver, observeNearby?: NearbyMetricObserver): RouteProvider | undefined {
  if (env.GOOGLE_MAPS_ENABLED !== 'true') return undefined;
  if (!env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_ENABLED requires GOOGLE_MAPS_API_KEY');
  return new GoogleRoutesProvider(env.GOOGLE_MAPS_API_KEY, fetch, undefined, undefined, costs, observe, observeNearby);
}
