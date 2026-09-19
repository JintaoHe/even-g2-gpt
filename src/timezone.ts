import type { EphemeralLocation } from './location.js';
import type { Message } from './conversation.js';

type Fetch = typeof fetch;

export interface TimezoneProvider {
  resolve(location: EphemeralLocation, signal: AbortSignal): Promise<string>;
}

export type TimezoneFallbackResult = { action: 'use'; timezone: string } | { action: 'ask'; clarification: string };
export interface TimezoneFallback {
  resolve(history: Message[], timezoneHint: string | undefined, signal: AbortSignal): Promise<TimezoneFallbackResult>;
}

export class TimezoneError extends Error {
  constructor(public code: 'TIMEZONE_INVALID' | 'TIMEZONE_UNAVAILABLE') { super(code); }
}

export class TimezoneClarificationError extends Error {
  constructor(public clarification: string) { super('TIMEZONE_CLARIFICATION_REQUIRED'); }
}

export function canonicalTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 3 || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return undefined; }
}

function safeClarification(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
  return text && text.length <= 120 && (text.match(/[?？]/g)?.length ?? 0) <= 1 ? text : undefined;
}

/** Google is authoritative. Luna sees only dialogue plus an untrusted device-zone hint, never coordinates. */
export async function resolveLocationTimezone(location: EphemeralLocation, history: Message[], provider: TimezoneProvider | undefined,
  fallback: TimezoneFallback | undefined, signal: AbortSignal, onFallback?: () => void) {
  if (provider) {
    try { return await provider.resolve(location, signal); }
    catch { signal.throwIfAborted(); onFallback?.(); }
  }
  if (!fallback) throw new TimezoneError('TIMEZONE_UNAVAILABLE');
  const result = await fallback.resolve(history, location.timezoneHint, signal); signal.throwIfAborted();
  if (result.action === 'use') {
    const timezone = canonicalTimezone(result.timezone);
    if (!timezone) throw new TimezoneError('TIMEZONE_INVALID');
    return timezone;
  }
  const clarification = safeClarification(result.clarification);
  if (!clarification) throw new TimezoneError('TIMEZONE_INVALID');
  throw new TimezoneClarificationError(/[?？]$/.test(clarification) ? clarification : `${clarification}？`);
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')); };
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});

/** Resolves coordinates to an IANA zone without retaining or logging the coordinates. */
export class GoogleTimezoneProvider implements TimezoneProvider {
  constructor(private key: string, private fetcher: Fetch = fetch,
    private endpoint = 'https://maps.googleapis.com/maps/api/timezone/json', private now = Date.now) {
    if (!key.trim() || key.length > 500) throw new Error('Invalid Google Maps key');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url.href)) throw new Error('Invalid Time Zone endpoint');
  }

  async resolve(location: EphemeralLocation, signal: AbortSignal) {
    let last: TimezoneError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const url = new URL(this.endpoint);
      url.searchParams.set('location', `${location.latitude},${location.longitude}`);
      url.searchParams.set('timestamp', String(Math.floor(this.now() / 1000)));
      url.searchParams.set('key', this.key);
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        const retryable = [429, 500, 502, 503, 504].includes(response.status);
        if (!response.ok) {
          await response.body?.cancel();
          if (!retryable) throw new TimezoneError('TIMEZONE_UNAVAILABLE');
          last = new TimezoneError('TIMEZONE_UNAVAILABLE');
        } else {
          const raw = await response.text();
          if (Buffer.byteLength(raw) > 64 * 1024) throw new TimezoneError('TIMEZONE_INVALID');
          const result = JSON.parse(raw) as { status?: unknown; timeZoneId?: unknown };
          const zone = result.status === 'OK' ? canonicalTimezone(result.timeZoneId) : undefined;
          if (zone) return zone;
          if (!['UNKNOWN_ERROR', 'OVER_QUERY_LIMIT'].includes(String(result.status))) throw new TimezoneError('TIMEZONE_UNAVAILABLE');
          last = new TimezoneError('TIMEZONE_UNAVAILABLE');
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof TimezoneError && !last) throw error;
        last = error instanceof TimezoneError ? error : new TimezoneError('TIMEZONE_UNAVAILABLE');
      }
      if (attempt < 2) await pause(attempt ? 750 : 250, signal);
    }
    throw last ?? new TimezoneError('TIMEZONE_UNAVAILABLE');
  }
}

export function createTimezoneProvider(env: NodeJS.ProcessEnv = process.env): TimezoneProvider | undefined {
  if (env.GOOGLE_MAPS_ENABLED !== 'true') return undefined;
  if (!env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_ENABLED requires GOOGLE_MAPS_API_KEY');
  return new GoogleTimezoneProvider(env.GOOGLE_MAPS_API_KEY);
}
