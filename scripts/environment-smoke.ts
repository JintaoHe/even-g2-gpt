import 'dotenv/config';
import { EnvironmentError, GoogleEnvironmentProvider } from '../src/environment.js';

const key = process.env.GOOGLE_ENVIRONMENT_API_KEY?.trim() || process.env.GOOGLE_MAPS_API_KEY?.trim();
if (!key) throw new Error('Set GOOGLE_ENVIRONMENT_API_KEY or GOOGLE_MAPS_API_KEY in private .env');
const latitude = Number(process.argv[2] ?? 41.5868), longitude = Number(process.argv[3] ?? -93.6250);
if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
  throw new Error('Optional coordinates are invalid');
}
const now = Date.now(), start = new Date(now + 60 * 60_000).toISOString(), end = new Date(now + 3 * 60 * 60_000).toISOString();
const request = { location: { latitude, longitude }, start, end,
  timezone: process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', language: 'zh-CN' };
const provider = new GoogleEnvironmentProvider(key);
const controller = new AbortController();
const settled = await Promise.allSettled([
  provider.weather(request, controller.signal), provider.airQuality(request, controller.signal), provider.pollen(request, controller.signal)
]);
const names = ['weather', 'airQuality', 'pollen'] as const;
const evidence = Object.fromEntries(settled.map((result, index) => [names[index], result.status === 'fulfilled' ? result.value
  : result.reason instanceof EnvironmentError ? { available: false, error: result.reason.code, status: result.reason.providerStatus,
    reason: result.reason.providerReason } : { available: false, error: 'ENVIRONMENT_UNAVAILABLE' }]));
// Normalized decision evidence only. Never print the key, request URL, exact
// coordinates, provider payload, health prose, or user-specific preferences.
console.log(JSON.stringify({ interval: { start, end, timezone: request.timezone }, ...evidence }, null, 2));
if (settled.some(result => result.status === 'rejected')) process.exitCode = 1;
