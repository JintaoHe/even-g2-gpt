import type { CostLedger, GoogleSku } from './cost-ledger.js';

export type GeoPoint = { latitude: number; longitude: number };
export type EnvironmentRequest = { location: GeoPoint; start: string; end: string; timezone: string; language?: string };
export type WeatherEvidence = { available: boolean; hourCount: number; conditions: string[];
  temperatureMinC?: number; temperatureMaxC?: number; feelsLikeMinC?: number; feelsLikeMaxC?: number;
  precipitationMaxPercent?: number; thunderstormMaxPercent?: number; windMaxKph?: number; uvMax?: number };
export type AirQualityEvidence = { available: boolean; hourCount: number; indexCode?: string; aqiMax?: number;
  category?: string; dominantPollutant?: string };
export type PollenTypeEvidence = { inSeason?: boolean; indexAvailable: boolean; value?: number; category?: string };
export type PollenEvidence = { available: boolean; date: string; tree: PollenTypeEvidence; grass: PollenTypeEvidence;
  weed: PollenTypeEvidence; overallValue?: number; overallCategory?: string; dominantType?: 'tree' | 'grass' | 'weed' };

export interface EnvironmentProvider {
  weather(request: EnvironmentRequest, signal: AbortSignal): Promise<WeatherEvidence>;
  airQuality(request: EnvironmentRequest, signal: AbortSignal): Promise<AirQualityEvidence>;
  pollen(request: EnvironmentRequest, signal: AbortSignal): Promise<PollenEvidence>;
}

export class EnvironmentError extends Error {
  constructor(public code: 'ENVIRONMENT_INVALID' | 'ENVIRONMENT_UNAVAILABLE',
    public service?: 'weather' | 'air_quality' | 'pollen', public providerStatus?: number, public retryable = false,
    public providerReason?: string) { super(code); }
}

type Fetch = typeof fetch;
type ParsedRequest = EnvironmentRequest & { startMs: number; endMs: number; language: string };
const RESPONSE_LIMIT = 512 * 1024;

const boundedNumber = (value: unknown, min: number, max: number) => typeof value === 'number'
  && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const boundedText = (value: unknown, limit: number) => typeof value === 'string'
  ? value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, limit) : '';
const max = (values: Array<number | undefined>) => {
  const present = values.filter((value): value is number => value !== undefined); return present.length ? Math.max(...present) : undefined;
};
const min = (values: Array<number | undefined>) => {
  const present = values.filter((value): value is number => value !== undefined); return present.length ? Math.min(...present) : undefined;
};
const endpointAllowed = (value: string) => {
  const url = new URL(value);
  return url.protocol === 'https:' || /^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url.href);
};
const language = (value: unknown) => typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value) ? value : 'en';

function parseRequest(request: EnvironmentRequest, now: number): ParsedRequest {
  const latitude = boundedNumber(request?.location?.latitude, -90, 90);
  const longitude = boundedNumber(request?.location?.longitude, -180, 180);
  const startMs = Date.parse(request?.start), endMs = Date.parse(request?.end);
  try { new Intl.DateTimeFormat('en', { timeZone: request?.timezone }).format(); } catch { throw new EnvironmentError('ENVIRONMENT_INVALID'); }
  if (latitude === undefined || longitude === undefined || !Number.isFinite(startMs) || !Number.isFinite(endMs)
    || startMs >= endMs || endMs - startMs > 24 * 3600_000 || startMs < now - 3600_000
    || endMs > now + 5 * 86400_000) throw new EnvironmentError('ENVIRONMENT_INVALID');
  return { location: { latitude, longitude }, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    timezone: request.timezone, language: language(request.language), startMs, endMs };
}

function localDate(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(timestamp);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export class GoogleEnvironmentProvider implements EnvironmentProvider {
  constructor(private key: string, private fetcher: Fetch = fetch, private now = Date.now,
    private endpoints = {
      weather: 'https://weather.googleapis.com/v1/forecast/hours:lookup',
      airQuality: 'https://airquality.googleapis.com/v1/forecast:lookup',
      pollen: 'https://pollen.googleapis.com/v1/forecast:lookup'
    }, private costs?: CostLedger) {
    if (!key.trim() || key.length > 500) throw new Error('Invalid Google environment key');
    for (const endpoint of Object.values(endpoints)) if (!endpointAllowed(endpoint)) throw new Error('Invalid environment endpoint');
  }

  private async json(service: EnvironmentError['service'], url: URL, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    // Google documents API-key query authentication for these endpoints. The
    // complete URL is never logged or included in thrown errors.
    url.searchParams.set('key', this.key);
    const sku: GoogleSku = service === 'air_quality' ? 'air-quality' : service as GoogleSku;
    const reservation = await this.costs?.reserveGoogle(sku, 1);
    let response: Response;
    try { response = await this.fetcher(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }); }
    catch { signal.throwIfAborted(); throw new EnvironmentError('ENVIRONMENT_UNAVAILABLE', service, undefined, true); }
    if (!response.ok) {
      await reservation?.settle(0);
      let providerReason: string | undefined;
      try {
        const raw = await response.text();
        if (Buffer.byteLength(raw) <= 65_536) {
          const payload = JSON.parse(raw), reason = payload?.error?.details?.find((item: any) => typeof item?.reason === 'string')?.reason;
          if (typeof reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(reason)) providerReason = reason;
        }
      } catch { /* Provider prose and secrets are intentionally discarded. */ }
      throw new EnvironmentError(response.status === 400 ? 'ENVIRONMENT_INVALID' : 'ENVIRONMENT_UNAVAILABLE', service,
        response.status, [429, 500, 502, 503, 504].includes(response.status), providerReason);
    }
    const raw = await response.text();
    await reservation?.settle(1);
    if (Buffer.byteLength(raw) > RESPONSE_LIMIT) throw new EnvironmentError('ENVIRONMENT_UNAVAILABLE', service);
    try { return JSON.parse(raw); } catch { throw new EnvironmentError('ENVIRONMENT_UNAVAILABLE', service); }
  }

  async weather(request: EnvironmentRequest, signal: AbortSignal): Promise<WeatherEvidence> {
    const parsed = parseRequest(request, this.now()), hours = Math.min(240, Math.max(1, Math.ceil((parsed.endMs - this.now()) / 3600_000) + 1));
    const url = new URL(this.endpoints.weather);
    url.searchParams.set('location.latitude', String(parsed.location.latitude)); url.searchParams.set('location.longitude', String(parsed.location.longitude));
    url.searchParams.set('hours', String(hours)); url.searchParams.set('pageSize', String(Math.min(hours, 240))); url.searchParams.set('languageCode', parsed.language);
    const data = await this.json('weather', url, { method: 'GET' }, signal) as any;
    const selected = (Array.isArray(data?.forecastHours) ? data.forecastHours : []).filter((hour: any) => {
      const start = Date.parse(hour?.interval?.startTime), end = Date.parse(hour?.interval?.endTime);
      return Number.isFinite(start) && Number.isFinite(end) && start < parsed.endMs && end > parsed.startMs;
    }).slice(0, 25);
    if (!selected.length) return { available: false, hourCount: 0, conditions: [] };
    const conditions = [...new Set<string>((selected as any[]).map(hour => boundedText(hour?.weatherCondition?.description?.text, 80))
      .filter((value): value is string => !!value))].slice(0, 3);
    const windKph = (hour: any) => {
      const value = boundedNumber(hour?.wind?.speed?.value, 0, 500), unit = hour?.wind?.speed?.unit;
      return value === undefined ? undefined : unit === 'MILES_PER_HOUR' ? value * 1.609344 : unit === 'KILOMETERS_PER_HOUR' ? value : undefined;
    };
    return { available: true, hourCount: selected.length, conditions,
      temperatureMinC: min(selected.map((hour: any) => boundedNumber(hour?.temperature?.degrees, -100, 70))),
      temperatureMaxC: max(selected.map((hour: any) => boundedNumber(hour?.temperature?.degrees, -100, 70))),
      feelsLikeMinC: min(selected.map((hour: any) => boundedNumber(hour?.feelsLikeTemperature?.degrees, -120, 90))),
      feelsLikeMaxC: max(selected.map((hour: any) => boundedNumber(hour?.feelsLikeTemperature?.degrees, -120, 90))),
      precipitationMaxPercent: max(selected.map((hour: any) => boundedNumber(hour?.precipitation?.probability?.percent, 0, 100))),
      thunderstormMaxPercent: max(selected.map((hour: any) => boundedNumber(hour?.thunderstormProbability, 0, 100))),
      windMaxKph: max(selected.map(windKph)), uvMax: max(selected.map((hour: any) => boundedNumber(hour?.uvIndex, 0, 30))) };
  }

  async airQuality(request: EnvironmentRequest, signal: AbortSignal): Promise<AirQualityEvidence> {
    const parsed = parseRequest(request, this.now()), url = new URL(this.endpoints.airQuality);
    const body = { location: parsed.location, period: { startTime: parsed.start, endTime: parsed.end },
      universalAqi: true, languageCode: parsed.language, extraComputations: ['LOCAL_AQI'] };
    const data = await this.json('air_quality', url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal) as any;
    const hours = (Array.isArray(data?.hourlyForecasts) ? data.hourlyForecasts : []).slice(0, 25);
    const allIndexes = hours.flatMap((hour: any) => Array.isArray(hour?.indexes) ? hour.indexes : []);
    const preferred = ['usa_epa', 'uaqi'].find(code => allIndexes.some((index: any) => index?.code === code))
      ?? boundedText(allIndexes[0]?.code, 40);
    const indexes = allIndexes.filter((index: any) => index?.code === preferred && boundedNumber(index?.aqi, 0, 1000) !== undefined);
    if (!hours.length || !indexes.length) return { available: false, hourCount: hours.length };
    const worst = [...indexes].sort((a, b) => Number(b.aqi) - Number(a.aqi))[0];
    return { available: true, hourCount: hours.length, indexCode: preferred, aqiMax: Math.round(worst.aqi),
      ...(boundedText(worst.category, 120) ? { category: boundedText(worst.category, 120) } : {}),
      ...(boundedText(worst.dominantPollutant, 40) ? { dominantPollutant: boundedText(worst.dominantPollutant, 40) } : {}) };
  }

  async pollen(request: EnvironmentRequest, signal: AbortSignal): Promise<PollenEvidence> {
    const parsed = parseRequest(request, this.now()), targetDate = localDate(parsed.startMs, parsed.timezone), today = localDate(this.now(), parsed.timezone);
    const utcDay = (date: string) => Date.parse(`${date}T00:00:00Z`);
    const days = Math.round((utcDay(targetDate) - utcDay(today)) / 86400_000) + 1;
    if (days < 1 || days > 5) throw new EnvironmentError('ENVIRONMENT_INVALID', 'pollen');
    const url = new URL(this.endpoints.pollen);
    url.searchParams.set('location.latitude', String(parsed.location.latitude)); url.searchParams.set('location.longitude', String(parsed.location.longitude));
    url.searchParams.set('days', String(days)); url.searchParams.set('pageSize', String(days));
    url.searchParams.set('languageCode', parsed.language); url.searchParams.set('plantsDescription', 'false');
    const data = await this.json('pollen', url, { method: 'GET' }, signal) as any;
    const day = (Array.isArray(data?.dailyInfo) ? data.dailyInfo : []).find((item: any) => {
      const date = item?.date; return `${date?.year}-${String(date?.month).padStart(2, '0')}-${String(date?.day).padStart(2, '0')}` === targetDate;
    });
    const empty = (): PollenTypeEvidence => ({ indexAvailable: false });
    if (!day) return { available: false, date: targetDate, tree: empty(), grass: empty(), weed: empty() };
    const types = Array.isArray(day.pollenTypeInfo) ? day.pollenTypeInfo : [];
    const parseType = (code: string): PollenTypeEvidence => {
      const item = types.find((value: any) => value?.code === code), value = boundedNumber(item?.indexInfo?.value, 0, 5);
      return { ...(typeof item?.inSeason === 'boolean' ? { inSeason: item.inSeason } : {}), indexAvailable: value !== undefined,
        ...(value === undefined ? {} : { value: Math.round(value) }),
        ...(boundedText(item?.indexInfo?.category, 80) ? { category: boundedText(item.indexInfo.category, 80) } : {}) };
    };
    const tree = parseType('TREE'), grass = parseType('GRASS'), weed = parseType('WEED');
    const ranked = ([['tree', tree], ['grass', grass], ['weed', weed]] as const).filter((item): item is typeof item & [any, PollenTypeEvidence & { value: number }] => item[1].value !== undefined)
      .sort((a, b) => b[1].value - a[1].value);
    return { available: true, date: targetDate, tree, grass, weed,
      ...(ranked.length ? { overallValue: ranked[0][1].value, overallCategory: ranked[0][1].category,
        dominantType: ranked[0][0] } : {}) };
  }
}

export function createEnvironmentProvider(env: NodeJS.ProcessEnv = process.env, costs?: CostLedger): EnvironmentProvider | undefined {
  if (env.GOOGLE_ENVIRONMENT_ENABLED !== 'true') return undefined;
  const key = env.GOOGLE_ENVIRONMENT_API_KEY?.trim() || env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new Error('GOOGLE_ENVIRONMENT_ENABLED requires a restricted server-side Google API key');
  return new GoogleEnvironmentProvider(key, fetch, Date.now, undefined, costs);
}
