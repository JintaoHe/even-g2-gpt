import type { RouteTravelMode } from './conversation.js';
import type { EphemeralLocation } from './location.js';

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
};
export type CandidateQuality = { adjustedRating?: number; reliable: boolean; risk: boolean };
export type RouteCandidate = PlaceCandidate & {
  durationSeconds: number;
  staticDurationSeconds?: number;
  distanceMeters: number;
  quality: CandidateQuality;
};
export type RouteComparisonResult = {
  query: string;
  candidates: RouteCandidate[];
  recommendedPlaceId: string;
  recommendationBasis: 'fastest' | 'quality_risk' | 'balanced';
  mode: RouteTravelMode;
  trafficAware: boolean;
};
export type RouteRequest = {
  origin: RouteOrigin;
  destination: string;
  mode: RouteTravelMode;
  kind?: RouteRequestKind;
  /** Sanitized Place IDs from the immediately preceding comparison. Skips Places search. */
  candidates?: PlaceCandidate[];
};
export type RouteDiscovery = { query: string; candidates: PlaceCandidate[] };

export interface RouteProvider {
  discover?(request: RouteRequest, signal: AbortSignal): Promise<RouteDiscovery>;
  route(request: RouteRequest, signal: AbortSignal): Promise<RouteComparisonResult>;
}

export class RouteError extends Error {
  constructor(public code: 'ROUTE_DESTINATION_NOT_FOUND' | 'ROUTE_INVALID' | 'ROUTE_UNAVAILABLE', message = code,
    public stage?: 'places' | 'routes', public providerStatus?: number, public retryable = false,
    public providerReason?: string) { super(message); }
}

type Fetch = typeof fetch;
const MAX_CANDIDATES = 3;
const PLACE_SEARCH_CANDIDATES = 10;
const NEARBY_RADIUS_M = 20_000;
const MAX_TEXT_SEARCH_BIAS_RADIUS_M = 50_000;
const RATING_PRIOR = 4;
const RATING_PRIOR_WEIGHT = 50;

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
  return { placeId, name, ...(address ? { address } : {}), ...(rating === undefined ? {} : { rating }),
    ...(count === undefined ? {} : { userRatingCount: Math.round(count) }), ...(primaryType ? { primaryType } : {}),
    ...(types.length ? { types } : {}) };
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
    private routesEndpoint = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix') {
    if (!key.trim() || key.length > 500) throw new Error('Invalid Google Maps key');
    for (const endpoint of [placesEndpoint, routesEndpoint]) if (new URL(endpoint).protocol !== 'https:'
      && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(endpoint)) throw new Error('Invalid Maps endpoint');
  }

  private async post(stage: 'places' | 'routes', endpoint: string, body: object, fieldMask: string, signal: AbortSignal) {
    let lastError: RouteError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await this.fetcher(endpoint, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fieldMask }, body: JSON.stringify(body) });
        if (response.ok) return await response.json();
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

  private async findCandidates(request: RouteRequest, destination: string, signal: AbortSignal): Promise<PlaceCandidate[]> {
    if (request.candidates?.length) {
      return request.candidates.slice(0, MAX_CANDIDATES).map(sanitizeCandidate).filter((value): value is PlaceCandidate => !!value);
    }
    const nearby = request.kind === 'nearby';
    const textQuery = nearby && request.origin.kind === 'address' ? `${destination} near ${boundedText(request.origin.address, 240)}` : destination;
    const search = async (radius: number | undefined) => {
      const bias = radius !== undefined && request.origin.kind === 'coordinates' ? { locationBias: { circle: { center: {
        latitude: request.origin.location.latitude, longitude: request.origin.location.longitude
      }, radius } } } : {};
      const places = await this.post('places', this.placesEndpoint, { textQuery, pageSize: PLACE_SEARCH_CANDIDATES,
        ...(nearby ? { rankPreference: 'DISTANCE' } : {}), ...bias },
      'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryType,places.types', signal) as any;
      return (Array.isArray(places?.places) ? places.places : []).slice(0, PLACE_SEARCH_CANDIDATES)
        .map(sanitizeCandidate).filter((value: PlaceCandidate | undefined): value is PlaceCandidate => !!value);
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
    return candidates.slice(0, MAX_CANDIDATES);
  }

  async discover(request: RouteRequest, signal: AbortSignal): Promise<RouteDiscovery> {
    const destination = boundedText(request.destination, 300);
    if (!destination || !['drive', 'walk', 'bicycle'].includes(request.mode)) throw new RouteError('ROUTE_INVALID');
    const candidates = await this.findCandidates({ ...request, candidates: undefined }, destination, signal);
    if (!candidates.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
    return { query: destination, candidates };
  }

  async route(request: RouteRequest, signal: AbortSignal): Promise<RouteComparisonResult> {
    const destination = boundedText(request.destination, 300);
    if (!destination || !['drive', 'walk', 'bicycle'].includes(request.mode)) throw new RouteError('ROUTE_INVALID');
    const candidates = request.candidates?.length ? await this.findCandidates(request, destination, signal)
      : (await this.discover(request, signal)).candidates;
    if (!candidates.length) throw new RouteError('ROUTE_DESTINATION_NOT_FOUND');
    const originWaypoint = request.origin.kind === 'coordinates' ? { location: { latLng: {
      latitude: request.origin.location.latitude, longitude: request.origin.location.longitude
    } } } : { address: boundedText(request.origin.address, 300) };
    if ('address' in originWaypoint && !originWaypoint.address) throw new RouteError('ROUTE_INVALID');
    const modes: Record<RouteTravelMode, string> = { drive: 'DRIVE', walk: 'WALK', bicycle: 'BICYCLE' };
    const trafficAware = request.mode === 'drive';
    const matrix = await this.post('routes', this.routesEndpoint, {
      origins: [{ waypoint: originWaypoint }],
      destinations: candidates.map((candidate: PlaceCandidate) => ({ waypoint: { placeId: candidate.placeId } })),
      travelMode: modes[request.mode], ...(trafficAware ? { routingPreference: 'TRAFFIC_AWARE' } : {})
    }, 'originIndex,destinationIndex,status,condition,distanceMeters,duration,staticDuration', signal) as any;
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
      recommendationBasis: basis, mode: request.mode, trafficAware };
  }
}

export function createRouteProvider(env: NodeJS.ProcessEnv = process.env): RouteProvider | undefined {
  if (env.GOOGLE_MAPS_ENABLED !== 'true') return undefined;
  if (!env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_ENABLED requires GOOGLE_MAPS_API_KEY');
  return new GoogleRoutesProvider(env.GOOGLE_MAPS_API_KEY);
}
