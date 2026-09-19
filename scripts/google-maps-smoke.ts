import 'dotenv/config';
import { createRouteProvider, RouteError, type RouteOrigin } from '../src/routes.js';

const originArgument = process.argv[2]?.trim();
const query = process.argv[3]?.trim() || 'grocery store';
const kind = process.argv[4]?.trim() || 'nearby';
if (!originArgument || originArgument.length > 300 || query.length > 300 || !['nearby', 'destination'].includes(kind)) {
  throw new Error('Usage: npm run maps:check -- "City, State" "place query" [nearby|destination] (or "@latitude,longitude" locally)');
}

function routeOrigin(value: string): RouteOrigin {
  const match = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return { kind: 'address', address: value };
  const latitude = Number(match[1]), longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Smoke-test coordinates are out of range');
  }
  return { kind: 'coordinates', location: { latitude, longitude, accuracy: 15, timestamp: Date.now() } };
}

const provider = createRouteProvider();
if (!provider) throw new Error('Maps is disabled. Set GOOGLE_MAPS_ENABLED=true in the private .env.');

async function main() {
  try {
    const result = await provider!.route({ origin: routeOrigin(originArgument!), destination: query,
      kind: kind as 'nearby' | 'destination', mode: 'drive' }, AbortSignal.timeout(30_000));
    // Deliberately print only bounded business/route results—never the API key or a
    // device coordinate. Use a broad city for smoke tests, not a home address.
    console.log(JSON.stringify({ mode: result.mode, trafficAware: result.trafficAware,
      recommendationBasis: result.recommendationBasis, candidates: result.candidates.map(candidate => ({
        name: candidate.name, minutes: Math.max(1, Math.round(candidate.durationSeconds / 60)),
        miles: Number((candidate.distanceMeters / 1609.344).toFixed(1)), rating: candidate.rating,
        ratingCount: candidate.userRatingCount
      })) }, null, 2));
  } catch (error) {
    if (error instanceof RouteError) {
      console.error(`Maps smoke failed: stage=${error.stage ?? 'unknown'} code=${error.code} http=${error.providerStatus ?? 'network'} reason=${error.providerReason ?? 'unknown'}`);
      process.exitCode = 1; return;
    }
    throw error;
  }
}
await main();
