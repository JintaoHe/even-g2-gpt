import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleCalendarService, CalendarError, type CalendarTransport } from '../src/google-calendar.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation, type TurnPlan } from '../src/conversation.js';
import { createCalendarPlanner, type CalendarRequest } from '../src/calendar-planner.js';

const original = { title: '测试 A', start: '2026-10-01T18:00-05:00', end: '2026-10-01T19:00-05:00', timezone: 'America/Chicago', allDay: false, location: '原地点', notes: '原备注' };
const empty = { title: null, start: null, end: null, timezone: null, allDay: null, location: null, notes: null };
const range = { rangeStart: '2026-10-01T00:00-05:00', rangeEnd: '2026-10-02T00:00-05:00', timezone: 'America/Chicago' };
const query: CalendarRequest = { action: 'query', clarification: '', ...range, targetIndex: 0, titleQuery: '', changes: empty };
async function fixture(t: any, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'even-cal-dialogue-'));
  const records = new Map<string, any>(); let writes = 0, reads = 0, uncertainWrite = false;
  const transport: CalendarTransport = async (method, path, body: any, etag) => {
    if (method === 'GET' && path.startsWith('/events?')) {
      reads++;
      const url = new URL(path, 'https://example.com'); const min = Date.parse(url.searchParams.get('timeMin')!), max = Date.parse(url.searchParams.get('timeMax')!);
      return { items: [...records.values()].filter(e => Date.parse(e.start.dateTime) < max && Date.parse(e.end.dateTime) > min).map(e => structuredClone(e)) };
    }
    const id = path.split('/')[2]?.split('?')[0];
    if (method === 'GET') { if (!records.has(id)) throw new CalendarError('NOT_FOUND', 404); return structuredClone(records.get(id)); }
    if (method === 'POST') { writes++; const e = { ...body, etag: '"' + writes + '"' }; records.set(e.id, e); if (uncertainWrite) throw new CalendarError('CALENDAR_NETWORK_UNKNOWN'); return e; }
    if (records.get(id)?.etag !== etag) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
    writes++;
    if (method === 'DELETE') { records.delete(id); return; }
    const e = { ...records.get(id), ...body, etag: '"' + writes + '"' }; records.set(id, e); return e;
  };
  const service = await GoogleCalendarService.create(directory, 'dedicated', transport, now);
  const a = await service.preview('create', original); await service.confirm(a.id, a.phrase);
  const b = await service.preview('create', { ...original, title: '测试 B', start: '2026-10-01T18:30-05:00', end: '2026-10-01T19:30-05:00' }); await service.confirm(b.id, b.phrase);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, records, a, b, writes: () => writes, reads: () => reads, makeWriteUncertain: () => { uncertainWrite = true; } };
}
test('query counts Google results, ambiguous edit requires selection, update preserves notes and ID', async t => {
  const f = await fixture(t); let next = query;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: next.action === 'query' ? 'query' : 'update' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => next), conversation = new Conversation(dialog, () => {});
  await conversation.submit('今天有多少event', true);
  assert.match(conversation.history.at(-1)!.content, /共 2 个事件/); assert.doesNotMatch(conversation.history.at(-1)!.content, /不代表你的全部日历/);
  assert.match(conversation.history.at(-1)!.content, /备注：原备注/);
  assert.match(conversation.history.at(-1)!.content, /2026-10-01 下午6:00–7:00/);
  assert.match(conversation.history.at(-1)!.content, /时间重叠：第1和2项/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /T18:|America\/Chicago|:00:00/);
  next = { ...query, action: 'update', changes: { ...empty, location: '新地点' } };
  await conversation.submit('把晚上的event改个地点', true);
  assert.match(conversation.history.at(-1)!.content, /请明确选择事件/); assert.equal(f.writes(), 2);
  next = { ...next, targetIndex: 1 };
  await conversation.submit('第一个', true);
  const preview = conversation.history.at(-1)!.content;
  assert.match(preview, /原地点 → 新地点/); assert.match(preview, /重叠/);
  const phrase = '确认';
  await conversation.submit(phrase, true);
  assert.match(conversation.history.at(-1)!.content, /Google 已保存修改/);
  assert.equal(f.records.size, 2); assert.equal(f.records.get(f.a.eventId).location, '新地点'); assert.equal(f.records.get(f.a.eventId).description, '原备注');
});
test('stale ETag refuses overwrite and new overlapping event invalidates approval', async t => {
  const f = await fixture(t);
  const edit = await f.service.preview('update', { ...original, location: '新地点' }, f.a.eventId, original, true);
  f.records.get(f.a.eventId).etag = 'changed-outside';
  assert.equal((await f.service.confirm(edit.id, edit.phrase)).state, 'conflict');
  assert.equal(f.records.get(f.a.eventId).location, '原地点');
  const another = await f.service.preview('update', { ...original, location: '新地点' }, f.a.eventId, original, true);
  f.records.set('extra123', { ...f.records.get(f.b.eventId), id: 'extra123' });
  assert.equal((await f.service.confirm(another.id, another.phrase)).state, 'conflict');
});
test('create checks calendar before writing, suggests a verified gap, selection needs fresh confirmation', async t => {
  const f = await fixture(t);
  // Unmanaged/read-only events still occupy time.
  f.records.get(f.b.eventId).extendedProperties = {};
  let request: CalendarRequest = { ...query, action: 'create', changes: { ...original, title: '新测试' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request), conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建18点到19点的新测试', true);
  const preview = conversation.history.at(-1)!.content;
  assert.match(preview, /重叠/); assert.match(preview, /本日历可选：2026-10-01 下午7:30–8:30/);
  assert.equal(f.writes(), 2);
  request = { ...request, changes: { ...empty, start: '2026-10-01T19:30-05:00', end: '2026-10-01T20:30-05:00' } };
  await conversation.submit('改到建议的19点半', true);
  assert.match(conversation.history.at(-1)!.content, /19:30–20:30/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /重叠/); assert.equal(f.writes(), 2);
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 3);
  const saved = [...f.records.values()].find(e => e.summary === '新测试');
  assert.equal(Date.parse(saved.start.dateTime), Date.parse('2026-10-01T19:30-05:00'));
});
test('confirmation without a pending preview cannot write', async t => {
  const f = await fixture(t);
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'confirm' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => query);
  for (const phrase of ['确认', '不要确认按芝加哥时间修改日程', '他说“确认按芝加哥时间修改日程”', '确认按纽约时间修改日程']) {
    const conversation = new Conversation(dialog, () => {}); await conversation.submit(phrase, true);
  }
  assert.equal(f.writes(), 2);
});

test('pending preview rejects misleading confirmations and invalidation blocks short confirmation', async t => {
  const f = await fixture(t);
  for (const phrase of ['不要确认', '他说确认', '确认？', '确认，但改成十点', '确认取消', '确认']) {
    let action: TurnPlan['calendarAction'] = 'query';
    let request = query;
    const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; }, async decide() { return 'respond' as const; }, async reply() {} };
    const dialog = new CalendarDialogue(base, f.service, async () => request);
    const conversation = new Conversation(dialog, () => {});
    await conversation.submit('查询', true);
    action = 'update'; request = { ...query, action: 'update', targetIndex: 1, changes: { ...empty, location: '新地点' } };
    await conversation.submit('改地点', true);
    assert.match(conversation.history.at(-1)!.content, /说“确认修改”/);
    if (phrase === '确认') dialog.invalidate();
    action = 'confirm';
    await conversation.submit(phrase, true);
    assert.equal(f.writes(), 2);
  }
});
test('misheard approval retains revised creation draft, exact retry saves once and replay cannot save', async t => {
  const f = await fixture(t);
  let request: CalendarRequest = { ...query, action: 'create', changes: { ...original, title: 'UI测试', start: '2026-10-01T22:00-05:00', end: '2026-10-01T23:00-05:00' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request);
  const conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建UI测试', true);
  request = { ...request, changes: { ...empty, notes: '邀请 sales，进行 TypeScript code review' } };
  await conversation.submit('加备注', true);
  for (const text of ['可以，确认上线。', '确认上线']) {
    await conversation.submit(text, true);
    assert.match(conversation.history.at(-1)!.content, /草稿保留/);
    assert.equal(f.writes(), 2);
  }
  await conversation.submit('确认创建', true);
  assert.match(conversation.history.at(-1)!.content, /Google 已保存新日程/);
  assert.equal(f.writes(), 3);
  const created = [...f.records.values()].find(e => e.summary === 'UI测试');
  assert.equal(created.description, '邀请 sales，进行 TypeScript code review');
  assert.equal(Date.parse(created.start.dateTime), Date.parse('2026-10-01T22:00-05:00'));
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 3);
});
test('expiry retains draft, rechecks and issues new preview instead of saving; next confirmation saves', async t => {
  let now = Date.now(); const f = await fixture(t, () => now);
  const request: CalendarRequest = { ...query, action: 'create', changes: original };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request, undefined, () => now);
  const conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建', true); await conversation.submit('确认上线', true);
  now += 6 * 60000;
  await conversation.submit('确认创建', true);
  assert.match(conversation.history.at(-1)!.content, /创建·芝加哥时间/); assert.equal(f.writes(), 2);
  assert.ok(f.service.list().operations.some(o => o.state === 'dismissed'));
  await conversation.submit('确认创建', true); assert.equal(f.writes(), 3);
});
test('noise/chat/query and context expiry retain draft; generic yes cannot submit it, resume rechecks', async t => {
  let now = Date.now(); const f = await fixture(t, () => now);
  let action: TurnPlan['calendarAction'] = 'create';
  let request: CalendarRequest = { ...query, action: 'create', changes: { ...original, title: '保留的草稿', notes: 'sales和TypeScript' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; }, async decide() { return 'respond' as const; }, async reply(_h: unknown, _s: unknown, delta: (s: string) => void) { delta('闲聊回答'); } };
  const dialog = new CalendarDialogue(base, f.service, async () => request, undefined, () => now), conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建', true);
  action = 'none'; await conversation.submit('一段无法辨别的杂音', true); await conversation.submit('确认', true);
  assert.equal(f.writes(), 2);
  action = 'query'; request = query; await conversation.submit('今天日程', true);
  now += 11 * 60000;
  await conversation.submit('继续刚才的日历草稿', true);
  assert.match(conversation.history.at(-1)!.content, /sales和TypeScript/); assert.equal(f.writes(), 2);
  await conversation.submit('确认创建', true); assert.equal(f.writes(), 3);
});
test('pause only revokes authorization; explicit discard and session end remove draft', async t => {
  const f = await fixture(t);
  let action: TurnPlan['calendarAction'] = 'create';
  const request: CalendarRequest = { ...query, action: 'create', changes: original };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request), conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建', true); dialog.invalidate();
  await conversation.submit('确认创建', true);
  assert.match(conversation.history.at(-1)!.content, /创建·/); assert.equal(f.writes(), 2);
  action = 'dismiss'; await conversation.submit('不要这个草稿', true);
  action = 'confirm'; await conversation.submit('确认创建', true);
  assert.match(conversation.history.at(-1)!.content, /没有有效/); assert.equal(f.writes(), 2);
  action = 'create'; await conversation.submit('重新创建', true); dialog.endSession();
  action = 'confirm'; await conversation.submit('确认创建', true);
  assert.match(conversation.history.at(-1)!.content, /没有有效/); assert.equal(f.writes(), 2);
});
test('resuming update reads latest original and preserves outside edits to unchanged fields', async t => {
  let now = Date.now(); const f = await fixture(t, () => now);
  let request = query;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: request.action === 'query' ? 'query' : 'update' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request, undefined, () => now), conversation = new Conversation(dialog, () => {});
  await conversation.submit('查询', true);
  request = { ...query, action: 'update', targetIndex: 1, changes: { ...empty, location: '新地点' } };
  await conversation.submit('改地点', true);
  f.records.get(f.a.eventId).description = '手机端最新备注'; f.records.get(f.a.eventId).etag = 'new-version';
  now += 6 * 60000;
  await conversation.submit('确认修改', true); assert.equal(f.writes(), 2);
  await conversation.submit('确认修改', true); assert.equal(f.writes(), 3);
  assert.equal(f.records.get(f.a.eventId).description, '手机端最新备注');
  assert.equal(f.records.get(f.a.eventId).location, '新地点');
});
test('uncertain write retains blocked draft and never refreshes into a duplicate create', async t => {
  const f = await fixture(t);
  const request: CalendarRequest = { ...query, action: 'create', changes: original };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; }, async decide() { return 'respond' as const; }, async reply() {} };
  const dialog = new CalendarDialogue(base, f.service, async () => request), conversation = new Conversation(dialog, () => {});
  await conversation.submit('创建', true); f.makeWriteUncertain();
  await conversation.submit('确认创建', true); assert.equal(f.writes(), 3);
  await conversation.submit('继续日历草稿', true); assert.match(conversation.history.at(-1)!.content, /结果不确定/);
  await conversation.submit('确认创建', true); assert.equal(f.writes(), 3);
});
test('misrouted read and stale selected query fetch API afresh; failed title match never means empty calendar', async t => {
  const f = await fixture(t); let request = { ...query, titleQuery: '不存在的会议名' };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none' }; }, async decide() { return 'respond' as const; }, async reply() { assert.fail('calendar read must not use ordinary reply'); } };
  const dialog = new CalendarDialogue(base, f.service, async () => request), conversation = new Conversation(dialog, () => {});
  await conversation.submit('十月一号有没有会议', true);
  assert.match(conversation.history.at(-1)!.content, /筛选未匹配/); assert.match(conversation.history.at(-1)!.content, /共 2 个事件/);
  const reads = f.reads(); f.records.delete(f.b.eventId);
  request = { ...query, targetIndex: 1 };
  await conversation.submit('你确定有会议吗', true);
  assert.ok(f.reads() > reads); assert.match(conversation.history.at(-1)!.content, /共 1 个事件/); assert.equal(f.writes(), 2);
});
test('detail question reads latest notes and attendee RSVP, including read-only events, without writes', async t => {
  const f = await fixture(t); let request = query, received: any;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'query' }; }, async decide() { return 'respond' as const; }, async reply() { assert.fail('no generic answer'); } };
  const dialog = new CalendarDialogue(base, f.service, async () => request, undefined, Date.now, async (_q, facts) => {
    received = facts; return '备注计划邀请sales，不代表已经接受。建议先向组织者确认。';
  });
  const conversation = new Conversation(dialog, () => {}); await conversation.submit('查会议', true);
  const event = f.records.get(f.a.eventId); event.extendedProperties = {};
  event.description = '最新备注：计划邀请sales，进行TypeScript审查';
  event.attendees = [{ displayName: 'Luke', email: 'luke@example.com', responseStatus: 'accepted' }];
  request = { ...query, targetIndex: 1 };
  await conversation.submit('第一个会议有什么补充信息，sales会参加吗', true);
  assert.equal(received.notes, event.description); assert.equal(received.attendees[0].status, 'accepted');
  assert.match(conversation.history.at(-1)!.content, /建议/); assert.doesNotMatch(conversation.history.at(-1)!.content, /共 \d+ 个事件/);
  assert.equal(f.writes(), 2);
});
test('Google query failure cannot be reported as zero events or ordinary model answer', async t => {
  const f = await fixture(t); f.service.query = async () => { throw new CalendarError('CALENDAR_NETWORK_UNKNOWN'); };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'query' }; }, async decide() { return 'respond' as const; }, async reply() { assert.fail('no model fallback'); } };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => query), () => {});
  await conversation.submit('今天有没有会议', true);
  assert.match(conversation.history.at(-1)!.content, /未完成/); assert.doesNotMatch(conversation.history.at(-1)!.content, /共 0|没有会议/);
});
test('planner sends bounded structured data, no tools or credentials in user input; validates selected index', async () => {
  let body: any;
  const request = (async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...query, rangeStart: '2026-10-01T00:00:00-05:00', changes: { ...empty, start: '2026-10-01T18:45:00-05:00' } }) }] }] })); }) as typeof fetch;
  const planner = createCalendarPlanner({ OPENAI_API_KEY: 'fake', OPENAI_INTENT_MODEL: 'configured-model' }, request);
  const parsed = await planner([{ role: 'user', content: '今天几个event' }], { candidates: [] }, new AbortController().signal);
  assert.equal(parsed.rangeStart, range.rangeStart); assert.equal(parsed.changes.start, '2026-10-01T18:45-05:00');
  assert.equal(body.model, 'configured-model'); assert.equal(body.store, false); assert.equal(body.tools, undefined);
  assert.equal(body.text.format.strict, true); assert.equal(body.input[0].content.includes('fake'), false);
});
