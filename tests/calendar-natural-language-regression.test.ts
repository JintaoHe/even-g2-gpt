import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation, type TurnPlan } from '../src/conversation.js';
import { GoogleCalendarService, CalendarError, type CalendarTransport } from '../src/google-calendar.js';
import type { CalendarRequest } from '../src/calendar-planner.js';

const empty = { title: null, start: null, end: null, timezone: null, allDay: null, location: null, notes: null, recurrence: null };
const window = { rangeStart: '2026-10-04T00:00-05:00', rangeEnd: '2026-10-05T00:00-05:00', timezone: 'America/Chicago' };

async function naturalFixture(t: any, count = 0, now = () => Date.parse('2026-09-20T19:15:00-05:00')) {
  const root = await mkdtemp(join(tmpdir(), 'even-calendar-natural-'));
  const records = new Map<string, any>(); let writes = 0;
  const transport: CalendarTransport = async (method, path, body: any, etag) => {
    if (method === 'GET' && path.startsWith('/events?')) return { items: [...records.values()].map(event => structuredClone(event)) };
    const id = path.split('/')[2]?.split('?')[0];
    if (method === 'GET') { if (!records.has(id)) throw new CalendarError('NOT_FOUND', 404); return structuredClone(records.get(id)); }
    if (method === 'POST') { writes++; const event = { ...body, etag: `"${writes}"` }; records.set(event.id, event); return event; }
    if (records.get(id)?.etag !== etag) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
    writes++;
    if (method === 'DELETE') { records.delete(id); return; }
    const event = { ...records.get(id), ...body, etag: `"${writes}"` }; records.set(id, event); return event;
  };
  const service = await GoogleCalendarService.create(root, 'natural-dialogue', transport, now);
  for (let index = 0; index < count; index++) {
    const start = 9 + index;
    const preview = await service.preview('create', {
      title: ['晨间游泳', '牙医复诊', '项目评审', '给妈妈打电话'][index],
      start: `2026-10-04T${String(start).padStart(2, '0')}:00-05:00`,
      end: `2026-10-04T${String(start).padStart(2, '0')}:30-05:00`, timezone: 'America/Chicago', allDay: false,
      location: index === 1 ? 'West Des Moines 诊所' : '', notes: '', recurrence: ''
    });
    await service.confirm(preview.id, preview.phrase);
  }
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, records, writes: () => writes, now };
}

test('fresh conversational markers never override a later explicit calendar date and clock', async t => {
  const examples = [
    { text: '现在麻烦你安排 10 月 4 日上午 8 点到 8 点半的牙医提醒。', start: '2026-10-04T08:00-05:00', end: '2026-10-04T08:30-05:00' },
    { text: '马上帮我创建明天下午 2 点的半小时复盘。', start: '2026-09-21T14:00-05:00', end: '2026-09-21T14:30-05:00' },
    { text: 'Right now, add an appointment for October 6 at 11:00 AM.', start: '2026-10-06T11:00-05:00', end: '2026-10-06T11:30-05:00' },
  ];
  for (const [index, example] of examples.entries()) {
    const f = await naturalFixture(t, 0);
    const request: CalendarRequest = { action: 'create', clarification: '', ...window, targetIndex: 0, titleQuery: '', scope: null,
      changes: { ...empty, title: `新口语日期 ${index + 1}`, start: example.start, end: example.end,
        timezone: 'America/Chicago', allDay: false, location: '', notes: '', recurrence: '' } };
    const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
      async decide() { return 'respond' as const; }, async reply() {} };
    const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => request, undefined, f.now), () => {});
    await conversation.submit(example.text, true);
    assert.match(conversation.history.at(-1)!.content, new RegExp(example.start.slice(0, 10)));
    assert.doesNotMatch(conversation.history.at(-1)!.content, /2026-09-20 19:15/);
    conversation.close();
  }
});

test('an explicit start-now phrase still anchors a duration to the current local minute', async t => {
  const f = await naturalFixture(t, 0);
  const request: CalendarRequest = { action: 'create', clarification: '', ...window, targetIndex: 0, titleQuery: '', scope: null,
    changes: { ...empty, title: '即时专注', start: '2026-09-20T18:00-05:00', end: '2026-09-20T18:45-05:00',
      timezone: 'America/Chicago', allDay: false, location: '', notes: '', recurrence: '' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => request, undefined, f.now,
    undefined, undefined, async () => 'America/Chicago'), () => {});
  await conversation.submit('从现在开始给我留出四十五分钟做专注工作。', true);
  assert.match(conversation.history.at(-1)!.content, /2026-09-20 19:15–20:00/);
  conversation.close();
});

test('fresh mixed retain/delete wording selects only cancellation targets and keeps every protected item', async t => {
  const cases = [
    { text: '删掉第一项和第三项，第二项保留。', cancelled: ['晨间游泳', '项目评审'], kept: ['牙医复诊', '给妈妈打电话'] },
    { text: '第二项保留，帮我删掉第一项和第三项。', cancelled: ['晨间游泳', '项目评审'], kept: ['牙医复诊', '给妈妈打电话'] },
    { text: '第二个不要删，其他三个都取消。', cancelled: ['晨间游泳', '项目评审', '给妈妈打电话'], kept: ['牙医复诊'] },
  ];
  for (const example of cases) {
    const f = await naturalFixture(t, 4); let action: TurnPlan['calendarAction'] = 'query';
    const query: CalendarRequest = { action: 'query', clarification: '', ...window, targetIndex: 0, titleQuery: '', scope: null, changes: empty };
    const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
      async decide() { return 'respond' as const; }, async reply() {} };
    const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => query, undefined, f.now), () => {});
    await conversation.submit('把十月四号的四项安排念给我。', true); action = 'cancel';
    await conversation.submit(example.text, true);
    for (const title of example.cancelled) {
      assert.match(conversation.history.at(-1)!.content, new RegExp(title));
      await conversation.submit('确认取消', true);
    }
    const remaining = [...f.records.values()].map(event => event.summary).sort();
    assert.deepEqual(remaining, example.kept.sort());
    conversation.close();
  }
});
