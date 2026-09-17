import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleCalendarService } from '../src/google-calendar.js';
import { suggestCalendarMatches, calendarChoice } from '../src/calendar-query.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation } from '../src/conversation.js';

const item = (id: string, title: string, recurringEventId?: string) => ({ id, title, recurringEventId, start: '2026-10-03T09:00:00-05:00', end: '2026-10-03T10:00:00-05:00', timezone: 'America/Chicago', location: 'Studio', editable: false });
test('candidate ranking groups series, tolerates transcription and never proposes unrelated events', () => {
  const a = item('abcde', 'HyReps Training', 'series1'), b = item('fghij', 'HyReps Training', 'series1');
  assert.deepEqual(suggestCalendarMatches([a, b, item('klmno', 'Lunch')], 'high reps training').map(e => e.id), ['abcde']);
  assert.equal(suggestCalendarMatches([a], 'dentist appointment').length, 0);
  assert.equal(calendarChoice('对，就是那个！', [a]), 0);
  assert.equal(calendarChoice('不是这个', [a]), 'reject');
  assert.equal(calendarChoice('都不是', [a]), 'reject');
  assert.equal(calendarChoice('第二个', [a, b]), 1);
  for (const text of ['对，就是那个，帮我取消', '确认创建', '如果我说对', '不是第一个', '对吗？']) assert.equal(calendarChoice(text, [a, b]), undefined);
  assert.equal(calendarChoice('对', [a, b]), undefined);
});

async function fixture(t: any, two = false) {
  const dir = await mkdtemp(join(tmpdir(), 'even-choice-')); let now = Date.parse('2026-09-17T01:00:00Z'), reads = 0;
  let records = [item('abcde', 'HyReps Training', 'series1'), item('fghij', 'HyReps Training', 'series1'), ...(two ? [item('klmno', 'High Rep Training', 'series2')] : [])];
  const service = await GoogleCalendarService.create(dir, 'dedicated', async (method, path) => {
    assert.equal(method, 'GET', 'read confirmations must NEVER write'); reads++;
    const p = new URL(path, 'https://example.com').searchParams;
    return { items: records.filter(e => Date.parse(e.start) >= Date.parse(p.get('timeMin')!) && Date.parse(e.start) < Date.parse(p.get('timeMax')!)).map(e => ({ id: e.id, summary: e.title, recurringEventId: e.recurringEventId, start: { dateTime: e.start, timeZone: e.timezone }, end: { dateTime: e.end, timeZone: e.timezone }, location: e.location })) };
  }, () => now);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  let plans = 0;
  const base = { async decide() { return 'respond' as const; }, async reply(_h: unknown, _s: unknown, delta: (s: string) => void) { delta('普通对话'); } };
  const dialogue = new CalendarDialogue(base, service, async history => { plans++; return { action: 'query', clarification: '', rangeStart: '', rangeEnd: '', timezone: 'America/Chicago', targetIndex: history.at(-1)?.content.includes('我说的就是') ? 1 : 0, titleQuery: 'high reps training', changes: { title: null, start: null, end: null, timezone: null, allDay: null, location: null, notes: null } }; }, undefined, () => now);
  const conversation = new Conversation(dialogue, () => {});
  return { dialogue, records, reads: () => reads, plans: () => plans, expire: () => { now += 6 * 60000; },
    ask: async (text: string) => { await conversation.submit(text, true); return conversation.history.at(-1)!.content; } };
}
test('proposes one real series, acknowledgement rereads its identity and gives updated time', async t => {
  const f = await fixture(t);
  const question = await f.ask('下一次 high reps training是什么时候');
  assert.match(question, /HyReps Training.*你说的是/); assert.doesNotMatch(question, /共 .*个|09:00/);
  f.records[0].start = '2026-10-04T11:00:00-05:00'; f.records[1].start = '2026-10-05T11:00:00-05:00';
  const reads = f.reads();
  const answer = await f.ask('对，就是那个');
  assert.ok(f.reads() > reads); assert.match(answer, /下一次·芝加哥时间/); assert.match(answer, /2026-10-04/);
  assert.equal(f.plans(), 1);
});
test('two candidates require a choice; rejection and expiry cannot silently select', async t => {
  const f = await fixture(t, true);
  const prompt = await f.ask('下一次 high reps training是什么时候');
  assert.match(prompt, /1\..*\n2\./);
  assert.equal(await f.ask('对'), prompt);
  const result = await f.ask('第二个'); assert.match(result, /下一次/);
  await f.ask('下一次 high reps training是什么时候');
  assert.match(await f.ask('都不是'), /其他名称/);
  await f.ask('下一次 high reps training是什么时候'); f.expire();
  assert.equal(await f.ask('对，就是那个'), '普通对话');
});
test('pause or unrelated conversation clears candidate confirmation', async t => {
  const f = await fixture(t);
  await f.ask('下一次 high reps training是什么时候'); f.dialogue.invalidate();
  assert.equal(await f.ask('对，就是那个'), '普通对话');
  await f.ask('下一次 high reps training是什么时候'); await f.ask('先聊别的');
  assert.equal(await f.ask('对，就是那个'), '普通对话');
});
test('longer natural references resolve semantically but remain read-only', async t => {
  const f = await fixture(t);
  await f.ask('下一次 high reps training是什么时候');
  const before = f.reads();
  assert.match(await f.ask('没错，我说的就是这家健身房的训练'), /下一次·芝加哥时间/);
  assert.ok(f.reads() > before); assert.equal(f.plans(), 2);
});
