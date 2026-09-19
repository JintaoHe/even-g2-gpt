import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPlanningEvidenceSelector, PlanningEvidenceDialogue } from '../src/planning-evidence-dialogue.js';
import { EnvironmentError, type EnvironmentProvider } from '../src/environment.js';
import { LocationRequestBroker, parseLocationReport } from '../src/location.js';
import type { DialogueModel, Message, WorkflowSelection } from '../src/conversation.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
function broker() {
  let value!: LocationRequestBroker;
  value = new LocationRequestBroker(event => {
    if (event.type === 'location.request') setImmediate(() => value.accept(parseLocationReport({ type: 'location.report', mode: 'once',
      request_id: event.request_id, location: { latitude: 41.58, longitude: -93.62, accuracy: 15, timestamp: Date.now() } })));
  }, () => id, 1000);
  return value;
}

test('planning evidence selector exposes one read-only function with no coordinates or write tools', async () => {
  let body: any;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    body = JSON.parse(raw);
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'read_outdoor_environment',
      arguments: JSON.stringify({ start: '2026-09-19T21:30:00Z', end: '2026-09-19T23:00:00Z', timezone: 'America/Chicago' }) }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const select = createPlanningEvidenceSelector('private-key', 'gpt-test',
      `http://127.0.0.1:${(server.address() as any).port}/v1/responses`, 'America/Chicago', fetch,
      () => Date.parse('2026-09-18T18:00:00Z'));
    const result = await select([], '明天下午带孩子去公园', new AbortController().signal);
    assert.deepEqual(result, { start: '2026-09-19T21:30:00.000Z', end: '2026-09-19T23:00:00.000Z', timezone: 'America/Chicago' });
    assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.tools.map((tool: any) => tool.name), ['read_outdoor_environment']);
    assert.doesNotMatch(JSON.stringify(body.tools), /latitude|longitude|calendar|email/i);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('general Luna planning receives concurrent structured environment evidence without GPS', async () => {
  let active = 0, maxActive = 0, seenHistory: Message[] = [], seenWorkflows: WorkflowSelection[] | undefined;
  const read = async <T>(value: T) => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setImmediate(resolve)); active--; return value; };
  const environment: EnvironmentProvider = {
    weather: async () => read({ available: true, hourCount: 2, conditions: ['晴'], temperatureMinC: 20, temperatureMaxC: 23, precipitationMaxPercent: 5 }),
    airQuality: async () => read({ available: true, hourCount: 2, indexCode: 'usa_epa', aqiMax: 42, category: 'Good' }),
    pollen: async () => read({ available: true, date: '2026-09-19', tree: { indexAvailable: true, value: 1 },
      grass: { indexAvailable: true, value: 2 }, weed: { indexAvailable: true, value: 1 }, overallValue: 2, dominantType: 'grass' })
  };
  const base: DialogueModel = {
    plan: async () => ({ decision: 'respond', cognitiveMode: 'planning', reasoningEffort: 'medium', searchAction: 'search' }),
    decide: async () => 'respond',
    reply: async (history, _signal, delta, _update, _effort, _mode, workflows) => {
      seenHistory = history; seenWorkflows = workflows; delta('综合建议');
    }
  };
  const dialogue = new PlanningEvidenceDialogue(base, async () => ({ start: '2026-09-19T16:30-05:00',
    end: '2026-09-19T18:00-05:00', timezone: 'America/Chicago' }), broker(), environment);
  const signal = new AbortController().signal;
  await dialogue.plan([], '明天下午带孩子去公园', true, signal);
  let answer = ''; await dialogue.reply([{ role: 'user', content: '明天下午带孩子去公园' }], signal, text => { answer += text; }, undefined,
    'medium', 'planning', [{ kind: 'search', action: 'read' }]);
  assert.equal(answer, '综合建议'); assert.equal(maxActive, 3);
  const envelope = seenHistory.at(-1)?.content ?? '';
  assert.match(envelope, /air_quality/); assert.match(envelope, /pollen/); assert.match(envelope, /precipitationMaxPercent/);
  assert.doesNotMatch(envelope, /41\.58|-93\.62|latitude|longitude/);
  assert.deepEqual(seenWorkflows, [{ kind: 'search', action: 'read' }]);
});

test('environment provider failure retries once then activates bounded Luna research fallback', async () => {
  let weatherCalls = 0, seenWorkflows: WorkflowSelection[] | undefined, seenHistory: Message[] = [];
  const environment: EnvironmentProvider = {
    weather: async () => { weatherCalls++; throw new EnvironmentError('ENVIRONMENT_UNAVAILABLE', 'weather', 503, true, 'BACKEND_ERROR'); },
    airQuality: async () => ({ available: true, hourCount: 1, aqiMax: 50 }),
    pollen: async () => ({ available: false, date: '2026-09-19', tree: { indexAvailable: false }, grass: { indexAvailable: false }, weed: { indexAvailable: false } })
  };
  const base: DialogueModel = {
    plan: async () => ({ decision: 'respond', cognitiveMode: 'planning', reasoningEffort: 'medium', searchAction: 'none' }),
    decide: async () => 'respond',
    reply: async (history, _signal, delta, _update, _effort, _mode, workflows) => {
      seenHistory = history; seenWorkflows = workflows; delta('带不确定性建议');
    }
  };
  const dialogue = new PlanningEvidenceDialogue(base, async () => ({ start: '2026-09-19T16:30-05:00',
    end: '2026-09-19T18:00-05:00', timezone: 'America/Chicago' }), broker(), environment);
  const signal = new AbortController().signal;
  await dialogue.plan([], '明天下午去公园', true, signal);
  await dialogue.reply([{ role: 'user', content: '明天下午去公园' }], signal, () => {}, undefined, 'medium', 'planning', []);
  assert.equal(weatherCalls, 2);
  assert.deepEqual(seenWorkflows, [{ kind: 'search', action: 'read' }, { kind: 'environment', action: 'fallback_search' }]);
  assert.match(seenHistory.at(-1)?.content ?? '', /ENVIRONMENT_UNAVAILABLE/);
  assert.doesNotMatch(JSON.stringify(seenHistory), /41\.58|-93\.62/);
});
