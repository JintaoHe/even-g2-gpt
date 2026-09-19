export type LocationMode = 'once' | 'continuous';
export type LocationEventSender = (event: { type: string; [key: string]: unknown }) => void;

export type EphemeralLocation = {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  /** Untrusted phone/browser IANA hint. Google or Luna must validate it against context before Calendar use. */
  timezoneHint?: string;
  observedAt: number;
  receivedAt: number;
};

const MAX_LOCATION_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_ACCURACY_M = 10_000;
const MAX_ROUTE_ACCURACY_M = 100;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeTimestamp(value: unknown, receivedAt: number) {
  if (value === undefined) return receivedAt;
  if (!finiteNumber(value) || value <= 0) throw new Error('LOCATION_TIMESTAMP_INVALID');
  // Hosts have historically exposed both Unix seconds and JavaScript milliseconds.
  return value < 100_000_000_000 ? value * 1000 : value;
}

function normalizeTimezone(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 3 || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('LOCATION_TIMEZONE_INVALID');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('LOCATION_TIMEZONE_INVALID'); }
}

/**
 * Validates a location report at the WSS boundary. The returned value is meant
 * for short-lived in-memory use only; it must not be added to conversation
 * history, logs, analytics, artifacts, or model input.
 */
export function parseLocationReport(message: unknown, receivedAt = Date.now()): { mode: LocationMode; requestId?: string; location: EphemeralLocation } {
  if (!message || typeof message !== 'object') throw new Error('LOCATION_REPORT_INVALID');
  const report = message as Record<string, unknown>;
  if (report.mode !== 'once' && report.mode !== 'continuous') throw new Error('LOCATION_MODE_INVALID');
  if (!report.location || typeof report.location !== 'object') throw new Error('LOCATION_REPORT_INVALID');
  if (Object.keys(report).some(key => !['type', 'mode', 'request_id', 'location'].includes(key))) throw new Error('LOCATION_REPORT_INVALID');
  if (report.request_id !== undefined && (typeof report.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(report.request_id))) throw new Error('LOCATION_REQUEST_INVALID');

  const raw = report.location as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['latitude', 'longitude', 'accuracy', 'timestamp', 'timezone_hint'].includes(key))) throw new Error('LOCATION_REPORT_INVALID');
  if (!finiteNumber(raw.latitude) || raw.latitude < -90 || raw.latitude > 90
    || !finiteNumber(raw.longitude) || raw.longitude < -180 || raw.longitude > 180) throw new Error('LOCATION_COORDINATES_INVALID');
  if (raw.accuracy !== undefined && (!finiteNumber(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > MAX_ACCURACY_M)) {
    throw new Error('LOCATION_ACCURACY_INVALID');
  }
  const observedAt = normalizeTimestamp(raw.timestamp, receivedAt);
  const timezoneHint = normalizeTimezone(raw.timezone_hint);
  if (observedAt < receivedAt - MAX_LOCATION_AGE_MS || observedAt > receivedAt + MAX_FUTURE_SKEW_MS) throw new Error('LOCATION_STALE');
  return {
    mode: report.mode,
    ...(report.request_id === undefined ? {} : { requestId: report.request_id }),
    location: {
      latitude: raw.latitude,
      longitude: raw.longitude,
      ...(raw.accuracy === undefined ? {} : { accuracyM: raw.accuracy }),
      ...(timezoneHint === undefined ? {} : { timezoneHint }),
      observedAt,
      receivedAt
    }
  };
}

export class LocationUnavailableError extends Error {
  constructor(public reason: 'unavailable' | 'low_accuracy' | 'timeout' = 'unavailable') { super(`LOCATION_${reason.toUpperCase()}`); }
}

export class LocationRequestBroker {
  private pending?: { id: string; resolve: (value: EphemeralLocation) => void; reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>; signal: AbortSignal; abort: () => void };
  // Session-only sensitive state. It is never serialized or exposed to a model.
  // A fresh-enough fix can be reused across turns; stale fixes remain in memory
  // until session end but are never treated as the user's current position.
  private sessionLocation?: EphemeralLocation;
  private sessionTimezone?: string;
  private sessionTimezoneHint?: string;
  constructor(private send: LocationEventSender, private id: () => string, private timeoutMs = 22_000, private now = Date.now) {}
  request(signal: AbortSignal): Promise<EphemeralLocation> {
    signal.throwIfAborted();
    const primed = this.currentLocation();
    this.cancelPending();
    if (primed) return Promise.resolve(primed);
    const id = this.id();
    return new Promise<EphemeralLocation>((resolve, reject) => {
      const abort = () => { this.finish(); this.send({ type: 'location.cancel', request_id: id }); reject(signal.reason ?? new Error('Cancelled')); };
      const timer = setTimeout(() => { this.finish(); this.send({ type: 'location.cancel', request_id: id }); reject(new LocationUnavailableError('timeout')); }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer, signal, abort };
      signal.addEventListener('abort', abort, { once: true });
      this.send({ type: 'location.request', request_id: id, mode: 'once', attempts: [
        { accuracy: 'high', timeout_ms: 7000 }, { accuracy: 'high', timeout_ms: 5000 }, { accuracy: 'medium', timeout_ms: 3000 }
      ], maximum_accuracy_m: 100 });
    });
  }
  private finish() {
    const pending = this.pending; this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort);
  }
  accept(report: ReturnType<typeof parseLocationReport>) {
    if (!report.requestId || report.requestId !== this.pending?.id) return false;
    const pending = this.pending; this.finish();
    this.sessionTimezone = undefined;
    if (report.location.timezoneHint) this.sessionTimezoneHint = report.location.timezoneHint;
    this.sessionLocation = report.location;
    pending.resolve(report.location); return true;
  }
  /**
   * Makes an explicit one-shot/continuous SDK fix available to this in-memory
   * session. It is never persisted outside the live session.
   */
  prime(report: ReturnType<typeof parseLocationReport>) {
    if (report.requestId || !this.usable(report.location)) return false;
    this.sessionTimezone = undefined;
    if (report.location.timezoneHint) this.sessionTimezoneHint = report.location.timezoneHint;
    this.sessionLocation = report.location; return true;
  }
  timezone() { return this.sessionTimezone; }
  timezoneHint() { return this.sessionTimezoneHint; }
  rememberTimezone(value: string) {
    this.sessionTimezone = normalizeTimezone(value);
    return this.sessionTimezone;
  }
  private usable(location: EphemeralLocation) {
    const now = this.now();
    return location.observedAt >= now - MAX_LOCATION_AGE_MS
      && location.observedAt <= now + MAX_FUTURE_SKEW_MS
      && (location.accuracyM === undefined || location.accuracyM <= MAX_ROUTE_ACCURACY_M);
  }
  private currentLocation() {
    const location = this.sessionLocation;
    return location && this.usable(location) ? location : undefined;
  }
  fail(message: unknown) {
    if (!message || typeof message !== 'object') throw new Error('LOCATION_FAILURE_INVALID');
    const value = message as Record<string, unknown>;
    if (Object.keys(value).some(key => !['type', 'request_id', 'reason'].includes(key))
      || typeof value.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.request_id)
      || !['unavailable', 'low_accuracy'].includes(String(value.reason))) throw new Error('LOCATION_FAILURE_INVALID');
    if (value.request_id !== this.pending?.id) return false;
    const pending = this.pending; this.finish(); pending.reject(new LocationUnavailableError(value.reason as 'unavailable' | 'low_accuracy')); return true;
  }
  cancel() {
    this.cancelPending();
  }
  private cancelPending() {
    const pending = this.pending;
    if (!pending) return;
    this.finish(); this.send({ type: 'location.cancel', request_id: pending.id }); pending.reject(new Error('Cancelled'));
  }
  clearCoordinates() { this.sessionLocation = undefined; this.send({ type: 'location.status', state: 'cleared' }); }
  clear() { this.sessionTimezone = undefined; this.sessionTimezoneHint = undefined; this.clearCoordinates(); }
}

export function locationStatus(location: EphemeralLocation) {
  return {
    type: 'location.status',
    state: 'available',
    accuracy_m: location.accuracyM === undefined ? null : Math.round(location.accuracyM),
    observed_at: new Date(location.observedAt).toISOString()
  };
}
