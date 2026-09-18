export type LocationMode = 'once' | 'continuous';

export type EphemeralLocation = {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  observedAt: number;
  receivedAt: number;
};

const MAX_LOCATION_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_ACCURACY_M = 10_000;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeTimestamp(value: unknown, receivedAt: number) {
  if (value === undefined) return receivedAt;
  if (!finiteNumber(value) || value <= 0) throw new Error('LOCATION_TIMESTAMP_INVALID');
  // Hosts have historically exposed both Unix seconds and JavaScript milliseconds.
  return value < 100_000_000_000 ? value * 1000 : value;
}

/**
 * Validates a location report at the WSS boundary. The returned value is meant
 * for short-lived in-memory use only; it must not be added to conversation
 * history, logs, analytics, artifacts, or model input.
 */
export function parseLocationReport(message: unknown, receivedAt = Date.now()): { mode: LocationMode; location: EphemeralLocation } {
  if (!message || typeof message !== 'object') throw new Error('LOCATION_REPORT_INVALID');
  const report = message as Record<string, unknown>;
  if (report.mode !== 'once' && report.mode !== 'continuous') throw new Error('LOCATION_MODE_INVALID');
  if (!report.location || typeof report.location !== 'object') throw new Error('LOCATION_REPORT_INVALID');
  if (Object.keys(report).some(key => !['type', 'mode', 'location'].includes(key))) throw new Error('LOCATION_REPORT_INVALID');

  const raw = report.location as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['latitude', 'longitude', 'accuracy', 'timestamp'].includes(key))) throw new Error('LOCATION_REPORT_INVALID');
  if (!finiteNumber(raw.latitude) || raw.latitude < -90 || raw.latitude > 90
    || !finiteNumber(raw.longitude) || raw.longitude < -180 || raw.longitude > 180) throw new Error('LOCATION_COORDINATES_INVALID');
  if (raw.accuracy !== undefined && (!finiteNumber(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > MAX_ACCURACY_M)) {
    throw new Error('LOCATION_ACCURACY_INVALID');
  }
  const observedAt = normalizeTimestamp(raw.timestamp, receivedAt);
  if (observedAt < receivedAt - MAX_LOCATION_AGE_MS || observedAt > receivedAt + MAX_FUTURE_SKEW_MS) throw new Error('LOCATION_STALE');
  return {
    mode: report.mode,
    location: {
      latitude: raw.latitude,
      longitude: raw.longitude,
      ...(raw.accuracy === undefined ? {} : { accuracyM: raw.accuracy }),
      observedAt,
      receivedAt
    }
  };
}

export function locationStatus(location: EphemeralLocation) {
  return {
    type: 'location.status',
    state: 'available',
    accuracy_m: location.accuracyM === undefined ? null : Math.round(location.accuracyM),
    observed_at: new Date(location.observedAt).toISOString()
  };
}
