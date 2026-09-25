// Opt-in reproduction: synthetic location, temporary ledger, no business database.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { LocationDialogue } from '../src/location-dialogue.js';
import { LocationRequestBroker } from '../src/location.js';
import { GoogleRoutesProvider, RouteError } from '../src/routes.js';
import { CostLedger } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch, openAIPricing, requestMaximum } from '../src/metered-openai.js';
import type { Message } from '../src/conversation.js';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env' });
if (process.env.RUN_ALTERNATIVES_REPRO !== '1' || !process.env.OPENAI_API_KEY) throw new Error('OPT_IN_OR_KEY_MISSING');
const dir = await mkdtemp(join(tmpdir(), 'alternatives-repro-'));
const ledger = await CostLedger.create(join(dir, 'cost-ledger.json'), process.env);
let reserved = 0, calls = 0;
const bounded: typeof fetch = async (url, init) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('ENDPOINT_DENIED');
  const body = JSON.parse(String(init?.body));
  const max = requestMaximum(String(init?.body), openAIPricing(process.env, body.model));
  if (reserved + max > 1 || calls >= 16) throw new Error('TEST_BUDGET');
  reserved += max; calls++;
  const input = JSON.stringify(body.input);
  assert.ok(!input.includes('41.57') && !input.includes('-93.711'), 'exact GPS must never reach OpenAI');
  console.log(JSON.stringify({ event: 'request', model: body.model, tools: body.tools?.map((t: any) => t.type),
    hasSyntheticCoordinates: input.includes('41.570') || input.includes('-93.711'),
    hasSyntheticCity: input.includes('West Des Moines'), hasAlternativeEvidence: input.includes('alternative evidence') }));
  const response = await fetch(url, init);
  if (process.argv.includes('--inspect-final') && !body.stream && ['food_alternative_candidates', 'branch_food_service'].includes(body.text?.format?.name)) {
    const result: any = await response.clone().json();
    console.log(JSON.stringify({event:'synthetic_structured_evidence',schema:body.text.format.name,status:result.status,
      output:result.output?.filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content??[]),
      sources:result.output?.filter((x:any)=>x.type==='web_search_call').flatMap((x:any)=>x.action?.sources??[])}));
  }
  if (process.argv.includes('--inspect-final') && body.stream) {
    const raw = await response.clone().text();
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: {')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type !== 'response.completed') continue;
      console.log(JSON.stringify({event:'synthetic_provider_result', output:event.response?.output?.filter((item:any)=>['message','web_search_call'].includes(item.type)).map((item:any)=>item.type==='message'
        ? {type:item.type,content:item.content} : {type:item.type,status:item.status,sources:item.action?.sources})}));
    }
  }
  return response;
};
const { model: base } = createHybridDialogue(process.env.OPENAI_API_KEY, { ...process.env,
  EVEN_MODEL_PROFILE: 'hybrid-luna', GOOGLE_MAPS_ENABLED: 'true', EVEN_DATA_DIR: dir,
  GOOGLE_CALENDAR_ENABLED: 'false', EVEN_DELIVERY_ROUTING: 'false', EVEN_EMAIL_ENABLED: 'false',
  OPENAI_MAX_SEARCH_CALLS: process.env.OPENAI_MAX_SEARCH_CALLS ?? '10' },
  { search: true, fetcher: createMeteredOpenAIFetch(ledger, process.env, bounded) });
const broker = new LocationRequestBroker(() => {}, () => crypto.randomUUID());
let routeCalls = 0;
const routes = { route: async (request: any) => {
  routeCalls++;
  console.log(JSON.stringify({ event: 'route', originKind: request.origin.kind, hasLocation: !!request.origin.location }));
  throw new RouteError('ROUTE_NO_MATCHING_PLACES');
} };
const realMaps = process.argv.includes('--real-maps'), emptyMaps = process.argv.includes('--empty-maps');
let googleCalls = 0;
const googleFetch: typeof fetch = async (url, init) => {
  const address = String(url);
  if (!address.startsWith('https://places.googleapis.com/v1/places') && !address.startsWith('https://maps.googleapis.com/maps/api/geocode/json?') && address !== 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix') throw new Error('GOOGLE_ENDPOINT_DENIED');
  const body = JSON.parse(String(init?.body ?? '{}'));
  const max = address.includes('distanceMatrix') ? (body.origins?.length ?? 1) * (body.destinations?.length ?? 1) * 0.01 : 0.05;
  if (reserved + max > 1 || googleCalls >= 20) throw new Error('GOOGLE_TEST_BUDGET');
  reserved += max; googleCalls++;
  const response = await fetch(url, init);
  const geocoding = address.includes('/geocode/');
  const status = geocoding ? (await response.clone().json() as any).status : undefined;
  console.log(JSON.stringify({ event: 'google_response', status: response.status, kind: geocoding ? 'geocoding' : address.includes('distanceMatrix') ? 'routes' : 'places',
    ...(geocoding ? {geocodingStatus: ['OK','ZERO_RESULTS','REQUEST_DENIED','OVER_QUERY_LIMIT','INVALID_REQUEST','UNKNOWN_ERROR'].includes(status) ? status : 'unknown'} : {}) }));
  return response;
};
if ((realMaps || emptyMaps) && !process.env.GOOGLE_MAPS_API_KEY) throw new Error('MAPS_KEY_MISSING');
const google = new GoogleRoutesProvider(process.env.GOOGLE_MAPS_API_KEY!, googleFetch, undefined, undefined, ledger);
const provider = realMaps ? google : emptyMaps ? {...routes, searchArea: google.searchArea.bind(google)} : routes;
const model = new LocationDialogue(base, broker, provider, 'America/Chicago', Date.now, base);
const history: Message[] = [];
const cases = realMaps ? ['现在有点饿，附近哪里有什么吃的？', '现在附近能买点热的吃吗？'] : ['现在有点饿，附近哪里有什么吃的？', 'West Des Moines, Iowa'];
for (const text of (process.argv.includes('--one') ? cases.slice(0,1) : cases)) {
  const now = Date.now();
  broker.prime({ location: { latitude: 41.570, longitude: -93.711, accuracyM: 20, observedAt: now, receivedAt: now } } as any);
  const signal = AbortSignal.timeout(120000);
  const started = Date.now();
  const plan = await model.plan(history, text, true, signal);
  console.log(JSON.stringify({ event: 'plan', text, locationAction: plan.locationAction, destination: plan.routeDestination }));
  history.push({ role: 'user', content: text });
  let answer = '';
  await model.reply(history, signal, s => answer += s, undefined, 'medium', 'decision_support', plan.workflows);
  console.log(JSON.stringify({ event: 'answer', text: answer, elapsedMs: Date.now() - started }));
  assert.ok(answer.trim(), 'empty answer');
  if (realMaps || (text === 'West Des Moines, Iowa')) assert.doesNotMatch(answer, /哪个城市|哪个地区|在哪.*找|which city|which area/i);
  history.push({ role: 'assistant', content: answer });
}
console.log(JSON.stringify({ event: 'cost', calls, googleCalls, routeCalls, reservedUpperUsd: reserved, ledger: await ledger.snapshot() }));
