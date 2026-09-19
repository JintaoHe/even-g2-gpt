import 'dotenv/config';
import { GoogleTimezoneProvider } from '../src/timezone.js';

const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
if (!key) throw new Error('GOOGLE_MAPS_API_KEY is required');

// Public Los Angeles city-center fixture only. Never print the key, URL, or coordinates.
const now = Date.now();
const zone = await new GoogleTimezoneProvider(key).resolve({
  latitude: 34.0522, longitude: -118.2437, accuracyM: 15, observedAt: now, receivedAt: now
}, AbortSignal.timeout(15_000));
if (zone !== 'America/Los_Angeles') throw new Error('TIMEZONE_SMOKE_UNEXPECTED_RESULT');
console.log(JSON.stringify({ provider: 'google-timezone', status: 'ok', timezone: zone }));
