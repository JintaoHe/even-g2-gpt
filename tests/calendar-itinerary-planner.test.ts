import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarItineraryPlanner, wantsSeparateItineraryCalendars } from '../src/calendar-itinerary-planner.js';

const reply = (value: unknown) => new Response(JSON.stringify({ status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('separate itinerary planner reuses context, exposes no tools and validates a bounded chronological plan', async () => {
  let body: any;
  const planner = createCalendarItineraryPlanner('test-key', 'test-model', 'http://127.0.0.1:8999/v1/responses',
    'America/Chicago', async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return reply({ action: 'plan', clarification: '', events: [
        { title: '前往 Ames DMV', start: '2026-09-19T09:00-05:00', end: '2026-09-19T10:00-05:00', timezone: 'America/Chicago', allDay: false,
          location: 'Ames DMV', notes: '从当前位置出发；按已讨论车程安排。' },
        { title: '和朋友见面', start: '2026-09-19T10:10-05:00', end: '2026-09-19T11:10-05:00', timezone: 'America/Chicago', allDay: false,
          location: 'Ames DMV 附近', notes: '预留10分钟缓冲；默认停留1小时。' }
      ] });
    }, () => Date.parse('2026-09-18T18:00:00Z'));
  const history = [{ role: 'user' as const, content: '9点从当前位置出发，分别创建每段日历。' }];
  assert.equal(wantsSeparateItineraryCalendars(history[0].content, history), true);
  assert.equal(wantsSeparateItineraryCalendars('我觉得可以，就这么安排，帮我发个 Calendar reminder。', [
    { role: 'assistant', content: '行程：\n- 7:00 去环球影城\n- 18:00 去尔湾朋友家\n- 第二天9:00返程' }
  ]), true);
  assert.equal(wantsSeparateItineraryCalendars('好，我觉得可以。帮我安排一下，给我发个 calendar reminder。', [
    { role: 'assistant', content: '安排：\n- 1:30–3:00 午睡\n- 3:30 出发去 Little Italy\n- 7:15 去 Union Square 看电影', topicId: 'trip' },
    { role: 'user', content: '看完以后走回来。', topicId: 'trip' },
    { role: 'assistant', content: '好，回程安排步行回家。', topicId: 'trip' }
  ]), true);
  assert.equal(wantsSeparateItineraryCalendars('帮我创建一个 Calendar，待两个小时。', [
    { role: 'assistant', content: '从当前位置，默认按驾车时间比较：\n1. Connolly\'s · 1分\n2. Jane Doe · 2分' }
  ]), false);
  const result = await planner(history, new AbortController().signal);
  assert.equal(result.action, 'plan'); assert.equal(result.events.length, 2);
  assert.equal(body.store, false); assert.equal(body.tools, undefined); assert.equal(body.model, 'test-model');
  assert.match(body.instructions, /exactly ONE short atomic question/); assert.match(body.instructions, /5–10 minute/);
  assert.doesNotMatch(JSON.stringify(body), /latitude|longitude/);
});

test('invalid itinerary is returned to Luna for bounded self-repair before reaching the user', async () => {
  const bodies: any[] = []; let call = 0;
  const valid = [
    { title: '前往酒吧', start: '2026-09-19T20:00-05:00', end: '2026-09-19T20:10-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Connolly’s', notes: '驾车并预留缓冲。' },
    { title: '在酒吧休息', start: '2026-09-19T20:10-05:00', end: '2026-09-19T22:10-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Connolly’s', notes: '询问是否可以做 Black and Tan。' }
  ];
  const planner = createCalendarItineraryPlanner('test-key', 'test-model', 'http://127.0.0.1:8999/v1/responses',
    'America/Chicago', async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(call++ === 0
        ? { action: 'plan', clarification: '', events: [{ ...valid[0], end: '2026-09-19T19:00-05:00' }, valid[1]] }
        : { action: 'plan', clarification: '', events: valid });
    }, () => Date.parse('2026-09-19T18:00:00Z'));
  const result = await planner([{ role: 'user', content: '现在出发，分别创建车程和酒吧两段日历。' }], new AbortController().signal);
  assert.equal(result.action, 'plan'); assert.equal(call, 2);
  const retryInput = JSON.parse(bodies[1].input[0].content);
  assert.match(retryInput.repair_feedback, /timestamps|timezone|chronological/i);
  assert.doesNotMatch(retryInput.repair_feedback, /CALENDAR_/);
});

test('itinerary clarification is one short question, never a numbered form', async () => {
  const planner = createCalendarItineraryPlanner('test-key', 'test-model', 'http://127.0.0.1:8999/v1/responses',
    'America/Chicago', async () => reply({ action: 'clarify', clarification: '你想几点出发', events: [] }),
    () => Date.parse('2026-09-18T18:00:00Z'));
  const result = await planner([{ role: 'user', content: '分别创建行程日历' }], new AbortController().signal);
  assert.deepEqual(result, { action: 'clarify', clarification: '你想几点出发？', events: [] });

  const invalid = createCalendarItineraryPlanner('test-key', 'test-model', 'http://127.0.0.1:8999/v1/responses',
    'America/Chicago', async () => reply({ action: 'clarify', clarification: '1. 几点？2. 去哪？', events: [] }),
    () => Date.parse('2026-09-18T18:00:00Z'));
  await assert.rejects(invalid([], new AbortController().signal), /CALENDAR_ITINERARY_INVALID/);

  const compound = createCalendarItineraryPlanner('test-key', 'test-model', 'http://127.0.0.1:8999/v1/responses',
    'America/Chicago', async () => reply({ action: 'clarify', clarification: '你从哪里出发，最后回哪里？', events: [] }),
    () => Date.parse('2026-09-18T18:00:00Z'));
  await assert.rejects(compound([], new AbortController().signal), /CALENDAR_ITINERARY_INVALID/);
});
