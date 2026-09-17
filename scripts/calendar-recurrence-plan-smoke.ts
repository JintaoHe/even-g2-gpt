// Paid model-only check using synthetic data. Never connects to Google or sends mail.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createCalendarPlanner } from '../src/calendar-planner.js';
import { validateCalendar } from '../src/calendar.js';
import { boundRecurrenceRequest } from '../src/calendar-recurrence.js';
const planner = createCalendarPlanner(process.env, fetch, () => new Date('2026-09-16T15:00:00Z'));
const candidate = { id: 'abcde_20261001T140000Z', recurringEventId: 'abcde', title: '测试周会', start: '2026-10-01T09:00-05:00', end: '2026-10-01T09:30-05:00', timezone: 'America/Chicago', location: 'A', editable: true };
for (const [text, action, scope] of [
  ['从2026年10月1日起，每周四芝加哥上午9点到9点半开测试周会，共4次，地点A，没有备注，邀请我的固定邮箱。', 'create', null],
  ['把2026年10月1日这次测试周会地点改成B，只改这一次。', 'update', 'single'],
  ['把测试周会整个系列（包括过去）的地点改成B，其他不变。', 'update', 'series'],
  ['取消测试周会整个系列，包括过去的所有次数。', 'cancel', 'series']
] as const) {
  const result = await planner([{ role: 'user', content: text }], { candidates: action === 'create' ? [] : [candidate] }, new AbortController().signal);
  assert.equal(result.action, action);
  if (scope) assert.equal(result.scope, scope);
  if (action === 'create') assert.equal(result.changes.recurrence, 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4');
  else assert.equal(result.changes.recurrence, null);
  console.log(`PASS synthetic recurring planner: ${action} ${scope ?? 'new series'}`);
}
for (const ending of ['', '，不要设置结束日期']) {
  const result = await planner([{ role: 'user', content: `从2026年10月3日开始，每周六芝加哥上午9点到10点上私教课，地点健身房，备注带水${ending}。` }], { candidates: [] }, new AbortController().signal);
  assert.equal(result.action, 'create'); assert.equal(result.clarification, '');
  assert.equal(result.changes.recurrence, 'RRULE:FREQ=WEEKLY;INTERVAL=1');
  const bounded = validateCalendar(boundRecurrenceRequest(result.changes));
  assert.match(bounded.notes, /默认3个月，截至2027-01-02/);
  assert.match(bounded.notes, /带水/);
  assert.equal(bounded.recurrence, 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=14');
  console.log('PASS synthetic default ending: backend bounded to three months, notes preserved');
}
