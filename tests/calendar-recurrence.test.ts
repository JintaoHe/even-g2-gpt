import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCalendar, calendarAttachment, type CalendarEvent } from '../src/calendar.js';
import { recurrenceOccurrences, boundRecurrenceRequest, revisedRecurrenceNotes } from '../src/calendar-recurrence.js';
import { GoogleCalendarService, CalendarError, eventBody, type CalendarTransport } from '../src/google-calendar.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation, type TurnPlan } from '../src/conversation.js';
import type { CalendarRequest } from '../src/calendar-planner.js';
import { paginate } from '../clients/even/src/pager.js';

const event: CalendarEvent = { title: '团队周会', start: '2026-10-25T09:00-05:00', end: '2026-10-25T09:30-05:00', timezone: 'America/Chicago', allDay: false, location: 'A', notes: '', recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=3' };
const changes = { title: null, start: null, end: null, timezone: null, allDay: null, location: null, notes: null, recurrence: null };
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'even-recurring-'));
  const records = new Map<string, any>(), calls: { method: string; path: string; body: any }[] = [];
  let version = 0;
  const transport: CalendarTransport = async (method, path, body: any, etag) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/events?')) {
      const p = new URL(path, 'https://example.com').searchParams;
      assert.equal(p.get('singleEvents'), 'true');
      return { items: [...records.values()].filter(e => !e.recurrence?.length && e.status !== 'cancelled' && Date.parse(e.start.dateTime) < Date.parse(p.get('timeMax')!) && Date.parse(e.end.dateTime) > Date.parse(p.get('timeMin')!)).map(e => structuredClone(e)) };
    }
    const id = path.split('/')[2]?.split('?')[0];
    if (method === 'POST') {
      const saved = { ...body, etag: 'v' + ++version }; records.set(saved.id, saved); return structuredClone(saved);
    }
    const saved = records.get(id);
    if (!saved) throw new CalendarError('CALENDAR_HTTP_404', 404);
    if (method === 'GET') return structuredClone(saved);
    if (etag !== saved.etag) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
    if (method === 'DELETE') { saved.status = 'cancelled'; saved.etag = 'v' + ++version; return; }
    Object.assign(saved, body, { etag: 'v' + ++version }); return structuredClone(saved);
  };
  const service = await GoogleCalendarService.create(directory, 'dedicated', transport, undefined, 'receiver@example.com');
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const writes = () => calls.filter(c => c.method !== 'GET');
  function instances(id: string) {
    const parent = records.get(id);
    return recurrenceOccurrences(event).map((occurrence, i) => {
      const instanceId = `${id}_${i === 0 ? '20261025T140000Z' : i === 1 ? '20261101T150000Z' : '20261108T150000Z'}`;
      records.set(instanceId, { ...parent, ...eventBody(occurrence), recurrence: undefined, id: instanceId, recurringEventId: id });
      return instanceId;
    });
  }
  return { service, calls, records, writes, instances };
}

test('bounded recurrence preserves local start through DST and rejects ambiguous/nonexistent hours', () => {
  const occurrences = recurrenceOccurrences(validateCalendar(event));
  assert.deepEqual(occurrences.map(e => e.start), ['2026-10-25T09:00-05:00', '2026-11-01T09:00-06:00', '2026-11-08T09:00-06:00']);
  assert.deepEqual(recurrenceOccurrences({ ...event, recurrence: 'RRULE:COUNT=3;FREQ=WEEKLY' }).map(e => e.start), occurrences.map(e => e.start));
  for (const recurrence of ['RRULE:FREQ=MONTHLY;INTERVAL=1;COUNT=3', 'RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY;INTERVAL=12;COUNT=52', 'RRULE:FREQ=DAILY;INTERVAL=1;COUNT=999', 'RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3\nATTENDEE:bad']) assert.throws(() => validateCalendar({ ...event, recurrence }));
  assert.throws(() => validateCalendar({ ...event, start: '2026-10-25T01:30-05:00', end: '2026-10-25T02:00-05:00' }), /DST_AMBIGUOUS/);
  assert.throws(() => validateCalendar({ ...event, start: '2026-03-01T02:30-06:00', end: '2026-03-01T03:00-06:00' }), /DST_AMBIGUOUS/);
  assert.throws(() => calendarAttachment('00000000-0000-0000-0000-000000000000', event, '2026-01-01'), /ICS_UNSUPPORTED/);
});

test('one recurring parent is invited only after confirmation; all occurrences checked and replay blocked', async t => {
  const f = await fixture(t);
  const preview = await f.service.preview('create', event);
  assert.equal(f.writes().length, 0); assert.equal(f.calls.length, 1);
  assert.match(preview.preview, /每周，共3次/); assert.match(preview.preview, /将邀请/);
  assert.ok(paginate(preview.preview).length <= 2);
  assert.equal((await f.service.confirm(preview.id, '确认')).state, 'succeeded');
  assert.equal(f.writes().length, 1); assert.equal(f.calls.filter(c => c.method === 'GET').length, 2);
  assert.deepEqual(f.writes()[0].body.recurrence, [event.recurrence]);
  assert.equal(f.writes()[0].body.start.timeZone, 'America/Chicago');
  assert.equal(f.writes()[0].body.attendees[0].email, 'receiver@example.com');
  assert.match(f.writes()[0].path, /sendUpdates=all/);
  await assert.rejects(f.service.confirm(preview.id, '确认')); assert.equal(f.writes().length, 1);
});

test('unspecified ending defaults to three calendar months, preserving notes and never renewing itself', () => {
  const bounded = validateCalendar(boundRecurrenceRequest({ ...event, notes: '带水', recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1' }));
  assert.equal(bounded.recurrence, 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=14');
  assert.match(bounded.notes, /^带水 .*默认3个月，截至2027-01-24；延长需确认/);
  assert.deepEqual(boundRecurrenceRequest(bounded), bounded);
  assert.equal(recurrenceOccurrences(bounded).at(-1)!.start, '2027-01-24T09:00-06:00');
  const monthEnd = validateCalendar(boundRecurrenceRequest({ ...event, start: '2026-01-31T09:00-06:00', end: '2026-01-31T09:30-06:00', recurrence: 'RRULE:FREQ=DAILY;INTERVAL=1' }));
  assert.match(monthEnd.notes, /截至2026-04-29/); assert.equal(recurrenceOccurrences(monthEnd).length, 89);
  const explicit = validateCalendar(boundRecurrenceRequest({ ...event, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20261115' }));
  assert.equal(explicit.recurrence, 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4'); assert.doesNotMatch(explicit.notes, /默认/);
  assert.deepEqual(boundRecurrenceRequest(event), event);
  assert.throws(() => boundRecurrenceRequest({ ...event, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20260230' }));
  const extended = revisedRecurrenceNotes({ ...bounded, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=18' }, bounded);
  assert.match(extended.notes, /已调整，末次2027-02-21/); assert.doesNotMatch(extended.notes, /默认3个月|2027-01-24/);
});

test('default deadline appears in compact preview and saved Google notes, extension still needs approval', async t => {
  const f = await fixture(t);
  const preview = await f.service.preview('create', { ...event, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1' });
  assert.match(preview.preview, /默认3个月.*2027-01-24/); assert.ok(paginate(preview.preview).length <= 2);
  assert.equal(f.writes().length, 0);
  await f.service.confirm(preview.id, '确认');
  assert.deepEqual(f.writes()[0].body.recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=14']);
  assert.match(f.writes()[0].body.description, /默认3个月/);
  const before = await f.service.read(preview.eventId);
  const next = await f.service.preview('update', { ...before, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=18' }, preview.eventId, before, true, 'series');
  assert.ok(paginate(next.preview).length <= 2); assert.match(next.preview, /末次2027-02-21/);
  assert.equal(f.writes().length, 1);
  await f.service.confirm(next.id, '确认修改');
  assert.equal(f.writes().length, 2); assert.match(f.writes()[1].path, new RegExp(preview.eventId));
});

test('single occurrence and whole series update/cancel target original IDs and notify guests', async t => {
  const f = await fixture(t), create = await f.service.preview('create', event);
  await f.service.confirm(create.id, '确认'); const ids = f.instances(create.eventId);
  const instance = await f.service.scopedTarget(ids[1], 'single');
  const update = await f.service.preview('update', { ...instance.event, location: 'B' }, instance.id, instance.event, true, 'single');
  assert.match(update.preview, /仅这一次/);
  assert.equal((await f.service.confirm(update.id, '确认修改')).state, 'succeeded');
  assert.equal(f.records.get(ids[1]).location, 'B'); assert.equal(f.records.get(create.eventId).location, 'A');
  assert.equal(f.writes().at(-1)!.body.recurrence, undefined);
  const series = await f.service.scopedTarget(ids[1], 'series'); assert.equal(series.id, create.eventId);
  const seriesUpdate = await f.service.preview('update', { ...series.event, location: 'C' }, series.id, series.event, true, 'series');
  assert.match(seriesUpdate.preview, /整个系列/); assert.match(seriesUpdate.preview, /每周，共3次/);
  assert.equal((await f.service.confirm(seriesUpdate.id, '确认')).state, 'succeeded');
  assert.equal(f.records.get(create.eventId).location, 'C');
  const oneCancel = await f.service.preview('cancel', undefined, ids[0], undefined, false, 'single');
  assert.equal((await f.service.confirm(oneCancel.id, '确认取消')).state, 'succeeded');
  assert.equal(f.records.get(ids[0]).status, 'cancelled'); assert.notEqual(f.records.get(create.eventId).status, 'cancelled');
  const allCancel = await f.service.preview('cancel', undefined, create.eventId, undefined, false, 'series');
  assert.equal((await f.service.confirm(allCancel.id, '确认')).state, 'succeeded');
  assert.equal(f.records.get(create.eventId).status, 'cancelled');
  assert.ok(f.writes().every(c => c.path.endsWith('sendUpdates=all')));
});

test('later occurrence conflicts and changed parent invalidate authorization without writes', async t => {
  const f = await fixture(t), create = await f.service.preview('create', event);
  const later = recurrenceOccurrences(event)[2];
  f.records.set('busy123', { id: 'busy123', ...eventBody(later), summary: '其他会议' });
  assert.equal((await f.service.confirm(create.id, '确认')).state, 'conflict'); assert.equal(f.writes().length, 0);
  const retry = await f.service.preview('create', event); assert.match(retry.preview, /重叠/);
  await f.service.confirm(retry.id, '确认'); const ids = f.instances(retry.eventId);
  const preview = await f.service.preview('cancel', undefined, ids[0], undefined, false, 'single');
  f.records.get(retry.eventId).etag = 'external'; const before = f.writes().length;
  assert.equal((await f.service.confirm(preview.id, '确认')).state, 'conflict'); assert.equal(f.writes().length, before);
});

test('scope, ownership and recurrence preservation cannot be bypassed by direct calls', async t => {
  const f = await fixture(t), create = await f.service.preview('create', event);
  await f.service.confirm(create.id, '确认'); const ids = f.instances(create.eventId);
  const { recurrence: _rule, ...single } = event;
  await assert.rejects(f.service.preview('update', single, create.eventId, undefined, false, 'series'), /RECURRENCE_REQUIRED/);
  await assert.rejects(f.service.preview('cancel', undefined, create.eventId, undefined, false, 'single'), /INSTANCE_REQUIRED/);
  await assert.rejects(f.service.preview('cancel', undefined, create.eventId, undefined, false, 'following' as any), /SCOPE_REQUIRED/);
  await assert.rejects(f.service.preview('update', event, ids[0], undefined, false, 'single'), /INSTANCE_RECURRENCE_FORBIDDEN/);
  f.records.get(create.eventId).extendedProperties = {};
  await assert.rejects(f.service.preview('cancel', undefined, ids[0], undefined, false, 'single'), /UNSUPPORTED/);
  assert.equal(f.writes().length, 1);
});

test('long series checks multiple bounded windows, excludes gaps and catches the last occurrence', async t => {
  const f = await fixture(t), longer = { ...event, recurrence: 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8' };
  const occurrences = recurrenceOccurrences(longer), last = occurrences.at(-1)!;
  f.records.set('busy123', { id: 'busy123', ...eventBody(last), summary: '最后一次冲突' });
  f.records.set('gap123', { id: 'gap123', ...eventBody({ ...last, start: '2026-11-02T09:00-06:00', end: '2026-11-02T09:30-06:00' }), summary: '不重叠的间隔日' });
  const preview = await f.service.preview('create', longer);
  assert.match(preview.preview, /最后一次冲突/); assert.doesNotMatch(preview.preview, /不重叠|等2项/);
  assert.ok(f.calls.length > 1);
  for (const call of f.calls) {
    const params = new URL(call.path, 'https://example.com').searchParams;
    assert.ok(Date.parse(params.get('timeMax')!) - Date.parse(params.get('timeMin')!) <= 31 * 86400000);
  }
  assert.equal(f.writes().length, 0);
});

test('dialogue asks scope, retains recurring draft through misheard confirmation, then updates same series', async t => {
  const f = await fixture(t);
  let req: CalendarRequest = { action: 'create', clarification: '', rangeStart: '', rangeEnd: '', timezone: event.timezone, targetIndex: 0, titleQuery: '', changes: event };
  let action: TurnPlan['calendarAction'] = 'create';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => req), () => {});
  const ask = async (s: string) => { await conversation.submit(s, true); return conversation.history.at(-1)!.content; };
  assert.match(await ask('每周一次，共三次'), /每周，共3次/);
  assert.match(await ask('确认上线'), /尚未提交/); assert.equal(f.writes().length, 0);
  assert.match(await ask('确认创建'), /Google 已保存/);
  const parentId = f.writes()[0].body.id; f.instances(parentId);
  req = { action: 'update', clarification: '', rangeStart: '2026-11-01T00:00-05:00', rangeEnd: '2026-11-02T00:00-06:00', timezone: event.timezone, targetIndex: 0, titleQuery: '', changes: { ...changes, location: 'B' } };
  action = 'update'; assert.match(await ask('改到B'), /仅这一次.*整个系列/);
  req = { ...req, scope: 'series', targetIndex: 1 }; action = 'followup';
  assert.match(await ask('整个系列'), /范围：整个系列/);
  assert.match(await ask('确认修改'), /Google 已保存/);
  assert.equal(f.records.get(parentId).location, 'B'); assert.equal(f.writes().length, 2);
  req = { ...req, scope: 'following' }; assert.match(await ask('此次及以后'), /暂不支持/); assert.equal(f.writes().length, 2);
});
