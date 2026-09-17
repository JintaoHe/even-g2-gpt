import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleCalendarService } from '../src/google-calendar.js';
import { validateCalendar } from '../src/calendar.js';
import { isNextCalendarQuery, needsCalendarRead } from '../src/calendar-query.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation } from '../src/conversation.js';

test('query accepts RFC3339 instants with seconds/UTC without relaxing write validation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'even-query-time-')); let calls = 0;
  const service = await GoogleCalendarService.create(dir, 'dedicated', async method => { assert.equal(method, 'GET'); calls++; return { items: [] }; });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.query('2026-09-17T01:33:47.123Z', '2026-09-18T01:33:47.123Z', 'America/Chicago');
  await service.query('2026-09-16T20:33:47-05:00', '2026-09-17T20:33:47-05:00', 'America/Chicago');
  for (const start of ['2026-02-30T09:00Z', '2026-09-16T25:00Z', '2026-09-16', 'bad']) await assert.rejects(service.query(start, '2026-09-18T01:33Z', 'America/Chicago'), /QUERY_INVALID/);
  await assert.rejects(service.query('2026-09-17T01:33Z', '2026-09-18T01:33Z', 'bad'), /QUERY_INVALID/);
  assert.equal(calls, 2);
  assert.throws(() => validateCalendar({ title: 'test', start: '2026-09-17T01:33:47.123Z', end: '2026-09-18T01:33:47.123Z', timezone: 'America/Chicago', allDay: false, location: '', notes: '' }));
});

test('next query searches beyond first window, excludes ongoing/unrelated events and ignores planner dates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'even-next-')), now = Date.parse('2026-09-17T01:33:47.123Z');
  let calls = 0, mode: 'found' | 'empty' | 'error' = 'found';
  const raw = (id: string, title: string, start: number, end: number) => ({ id, summary: title, start: { dateTime: new Date(start).toISOString(), timeZone: 'America/Chicago' }, end: { dateTime: new Date(end).toISOString(), timeZone: 'America/Chicago' } });
  const service = await GoogleCalendarService.create(dir, 'dedicated', async (method, path) => {
    assert.equal(method, 'GET'); calls++;
    if (mode === 'error') throw Error('offline');
    const p = new URL(path, 'https://example.com').searchParams;
    const start = Date.parse(p.get('timeMin')!);
    assert.equal(p.get('singleEvents'), 'true');
    if (mode === 'empty') return { items: [] };
    return { items: start === now ? [raw('abcde', 'High Reps Training', now - 3600000, now + 3600000), raw('fghij', 'Unrelated', now + 3600000, now + 7200000)]
      : [raw('klmno', 'High Reps Training', start + 7200000, start + 10800000), raw('pqrst', 'High Reps Training', start + 3600000, start + 7200000)] };
  }, () => now);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const text = '可以帮我看一下我下一次 high reps trainin g是什么时候';
  assert.equal(needsCalendarRead(text, []), true); assert.equal(isNextCalendarQuery('把下一次training改到周日'), false);
  assert.equal(isNextCalendarQuery('下个月下一次training是什么时候'), false);
  const next = await service.next('high reps trainin g', 'America/Chicago');
  assert.equal(calls, 2); assert.deepEqual(next.items.map(e => e.id), ['pqrst']);
  const base = { async decide() { return 'respond' as const; }, async reply() { assert.fail('must query Google'); } };
  const dialogue = new CalendarDialogue(base, service, async () => ({ action: 'query', clarification: '', rangeStart: 'bad', rangeEnd: 'bad', timezone: 'America/Chicago', targetIndex: 0, titleQuery: 'high reps trainin g', changes: { title: null, start: null, end: null, timezone: null, allDay: null, location: null, notes: null } }), undefined, () => now);
  const conversation = new Conversation(dialogue, () => {});
  await conversation.submit(text, true);
  assert.match(conversation.history.at(-1)!.content, /下一次·芝加哥时间/); assert.doesNotMatch(conversation.history.at(-1)!.content, /INVALID|Unrelated/);
  mode = 'empty'; calls = 0; await conversation.submit(text, true);
  assert.equal(calls, 3); assert.match(conversation.history.at(-1)!.content, /未来93天内未查到/);
  mode = 'error'; await conversation.submit(text, true);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /未来93天内未查到/);
});
