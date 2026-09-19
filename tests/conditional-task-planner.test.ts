import test from 'node:test';
import assert from 'node:assert/strict';
import { createConditionalTaskPlanner } from '../src/conditional-task-planner.js';

const now = Date.parse('2026-09-18T14:00:00Z');
const executePayload = {
  action: 'execute', clarification: null,
  calendar_start: '2026-09-18T12:00:00-05:00', calendar_end: '2026-09-18T18:00:00-05:00',
  activity_start: '2026-09-18T16:30:00-05:00', activity_end: '2026-09-18T17:30:00-05:00',
  timezone: 'America/Chicago', place_query: 'family-friendly park', event_title: '带孩子去公园', event_notes: '下班后户外活动',
  schedule_requested: true, calendar_check_requested: true, stop_on_calendar_conflict: false,
  travel_mode: 'drive', pollen_sensitivities: []
};

test('conditional planner is schema-only, store:false and returns a bounded validated task spec', async () => {
  let request: any;
  const planner = createConditionalTaskPlanner('private-key', 'gpt-test', 'http://127.0.0.1:9090/v1/responses',
    'America/Chicago', async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(executePayload) }
      ] }] }), { status: 200 });
    }, () => now);
  const result = await planner([], '如果下午没有安排，天气不错就带孩子去公园并帮我安排。', new AbortController().signal);
  assert.equal(result.action, 'execute');
  if (result.action === 'execute') {
    assert.equal(result.spec.activityStart, '2026-09-18T16:30-05:00');
    assert.equal(result.spec.stopOnCalendarConflict, false);
  }
  assert.equal(request.store, false);
  assert.equal(request.tools, undefined);
  assert.equal(request.reasoning.effort, 'medium');
  assert.equal(request.text.format.type, 'json_schema');
});

test('an explicit do-not-reschedule instruction preserves a hard Calendar stop', async () => {
  const payload = { ...executePayload, stop_on_calendar_conflict: true };
  const planner = createConditionalTaskPlanner('key', 'model', 'https://example.com/v1/responses', 'America/Chicago',
    async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }), () => now);
  const result = await planner([], '如果那个时间冲突就不要安排，也不要换时间。', new AbortController().signal);
  assert.equal(result.action, 'execute');
  if (result.action === 'execute') assert.equal(result.spec.stopOnCalendarConflict, true);
});

test('backend refuses a model-invented hard stop for an ordinary if-free request', async () => {
  const payload = { ...executePayload, stop_on_calendar_conflict: true };
  const planner = createConditionalTaskPlanner('key', 'model', 'https://example.com/v1/responses', 'America/Chicago',
    async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }), () => now);
  const result = await planner([], '如果下午没有安排，天气不错就带孩子去公园并帮我安排。', new AbortController().signal);
  assert.equal(result.action, 'execute');
  if (result.action === 'execute') assert.equal(result.spec.stopOnCalendarConflict, false);
});

test('conditional planner asks one clarification and rejects unsafe time horizons', async () => {
  const response = (payload: unknown) => async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: JSON.stringify(payload) }
  ] }] }), { status: 200 });
  const clarify = createConditionalTaskPlanner('key', 'model', 'http://127.0.0.1:9090/v1/responses', 'America/Chicago',
    response({ action: 'clarify', clarification: '你想安排哪一天、哪个时间段？', calendar_start: null, calendar_end: null,
      activity_start: null, activity_end: null, timezone: null, place_query: null, event_title: null, event_notes: null,
      schedule_requested: null, calendar_check_requested: null, stop_on_calendar_conflict: null,
      travel_mode: null, pollen_sensitivities: null }) as typeof fetch, () => now);
  assert.deepEqual(await clarify([], '帮我安排户外活动', new AbortController().signal),
    { action: 'clarify', question: '你想安排哪一天、哪个时间段？' });

  const tooFar = { ...executePayload, calendar_start: '2026-10-01T12:00:00-05:00', calendar_end: '2026-10-01T18:00:00-05:00',
    activity_start: '2026-10-01T16:30:00-05:00', activity_end: '2026-10-01T17:30:00-05:00' };
  const invalid = createConditionalTaskPlanner('key', 'model', 'http://127.0.0.1:9090/v1/responses', 'America/Chicago',
    response(tooFar) as typeof fetch, () => now);
  await assert.rejects(invalid([], '下个月', new AbortController().signal), /TASK_PLANNER_INVALID/);
});

test('execute plans normalize nullable optional pollen sensitivity to an empty preference', async () => {
  const payload = {
    action: 'execute', clarification: null,
    calendar_start: '2026-09-19T12:00:00-05:00', calendar_end: '2026-09-19T18:00:00-05:00',
    activity_start: '2026-09-19T16:30:00-05:00', activity_end: '2026-09-19T17:30:00-05:00',
    timezone: 'America/Chicago', place_query: 'family-friendly park', event_title: '公园活动', event_notes: '',
    schedule_requested: true, calendar_check_requested: true, stop_on_calendar_conflict: false,
    travel_mode: 'drive', pollen_sensitivities: null
  };
  const planner = createConditionalTaskPlanner('key', 'model', 'https://example.com/v1/responses', 'America/Chicago',
    async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }), () => now);
  const result = await planner([], '安排公园活动', new AbortController().signal);
  assert.equal(result.action, 'execute');
  if (result.action === 'execute') assert.deepEqual(result.spec.pollenSensitivity, []);
});

test('ordinary outdoor advice does not infer a private Calendar read', async () => {
  const payload = { ...executePayload, event_title: null, event_notes: null,
    schedule_requested: false, calendar_check_requested: false, stop_on_calendar_conflict: false };
  const planner = createConditionalTaskPlanner('key', 'model', 'https://example.com/v1/responses', 'America/Chicago',
    async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }), () => now);
  const result = await planner([], '明天下午想带孩子去公园散步，帮我看看去哪儿合适。', new AbortController().signal);
  assert.equal(result.action, 'execute');
  if (result.action === 'execute') {
    assert.equal(result.spec.calendarCheckRequested, false);
    assert.equal(result.spec.stopOnCalendarConflict, false);
    assert.equal(result.spec.eventTitle, '户外活动');
  }
});
