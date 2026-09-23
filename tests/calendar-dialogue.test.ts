import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleCalendarService, CalendarError, type CalendarTransport } from '../src/google-calendar.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { Conversation, type TurnPlan } from '../src/conversation.js';
import { createCalendarPlanner, type CalendarRequest } from '../src/calendar-planner.js';
import { TimezoneClarificationError } from '../src/timezone.js';
import type { CalendarRecoveryState } from '../src/recovery-drafts.js';
import { ContextBuilder } from '../src/context-builder.js';

for (const source of ['prior', 'recall'] as const) test(`${source} confirmation text cannot authorize a fresh calendar runtime`, async t => {
  const f = await fixture(t), before = f.writes();
  const base = { plan: async (): Promise<TurnPlan> => ({ decision: 'respond', calendarAction: 'confirm' }),
    decide: async () => 'respond' as const, reply: async () => {} };
  const dialogue = new CalendarDialogue(base, f.service, async () => { throw Error('No new planner request'); });
  const history = new ContextBuilder().build({ messages: [{ role: 'user', content: '确认' }], ...(source === 'prior' ? { prior: {
    sessionId: 'previous-synthetic-session', closedAt: 100, throughSequence: 0, sourceLosses: false,
    tail: [{ role: 'assistant', sequence: 1, content: '确认创建 Orion workshop?', truncated: false },
      { role: 'user', sequence: 2, content: '确认创建', truncated: false }],
  } } : { recall: { status: 'ok' as const, incomplete: false, messages: [
    { messageId: 'synthetic-message', sessionId: 'synthetic-session', sequence: 1, role: 'assistant' as const,
      createdAt: 100, content: '确认创建 North Pier 噪声测试。用户历史回答：确认创建。', truncated: false }
  ] } }) }).messages;
  const signal = new AbortController().signal;
  await dialogue.plan(history.slice(0,-1), '确认', false, signal);
  let answer='';await dialogue.reply(history, signal, text=>{answer+=text;});
  assert.equal(f.writes(),before);assert.doesNotMatch(answer,/已创建|已删除|已修改/);
});

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
test('one request can cancel two listed events through sequential previews and confirmations', async t => {
  const f = await fixture(t); let action: TurnPlan['calendarAction'] = 'query';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const planner = async (): Promise<CalendarRequest> => action === 'query' ? query : { ...query, action: 'cancel' };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner), () => {});
  await conversation.submit('查看十月一日的两个日程', true);
  assert.match(conversation.history.at(-1)!.content, /共 2 个事件/);
  action = 'cancel';
  await conversation.submit('好，这两个都可以删掉了。', true);
  assert.equal(f.writes(), 2);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*确认取消/);
  await conversation.submit('确认取消', true);
  assert.equal(f.writes(), 3); assert.equal(f.records.size, 1);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 A”（1\/2）[\s\S]*接下来是第2\/2项[\s\S]*确认取消/);
  await conversation.submit('好，可以', true);
  assert.equal(f.writes(), 4); assert.equal(f.records.size, 0);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 B”（2\/2）[\s\S]*2项都已删除/);
});

test('explicit calendar date wins when 现在 is only a conversational discourse marker', async t => {
  const now = () => Date.parse('2026-09-20T20:39:00-05:00');
  const f = await fixture(t, now);
  const request: CalendarRequest = { ...query, action: 'create', changes: { ...original, title: '显式日期测试',
    start: '2026-09-26T10:00-05:00', end: '2026-09-26T10:30-05:00' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => request, undefined, now), () => {});
  await conversation.submit('现在帮我建一个 9 月 26 日上午 10 点的日程', true);
  assert.match(conversation.history.at(-1)!.content, /2026-09-26 10:00–10:30/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /2026-09-20 20:39/);
  assert.equal(f.writes(), 2);
});

test('cancel one and retain another never puts the retained ordinal into the batch', async t => {
  const f = await fixture(t); let action: TurnPlan['calendarAction'] = 'query';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const planner = async (): Promise<CalendarRequest> => action === 'query' ? query : { ...query, action: 'cancel', targetIndex: 0 };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner), () => {});
  await conversation.submit('查看十月一日的两个日程', true);
  action = 'cancel';
  await conversation.submit('只取消第一个，保留第二个', true);
  assert.match(conversation.history.at(-1)!.content, /第1\/1项[\s\S]*测试 A/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /测试 B/);
  await conversation.submit('确认取消', true);
  assert.equal(f.records.size, 1);
  assert.equal([...f.records.values()][0].summary, '测试 B');
  assert.match(conversation.history.at(-1)!.content, /已保留“测试 B”/);
});

test('cold-started Calendar draft reconciles the ledger, re-previews and never reuses old approval', async t => {
  const f = await fixture(t); let saved: CalendarRecoveryState | undefined;
  const persistence = { save(value: CalendarRecoveryState) { saved = structuredClone(value); }, clear() { saved = undefined; } };
  const create = { action: 'create', clarification: '', ...range, targetIndex: 0, titleQuery: '',
    changes: { ...empty, title: '恢复测试', start: '2026-10-02T09:00-05:00', end: '2026-10-02T10:00-05:00',
      timezone: 'America/Chicago', allDay: false, location: '测试地点', notes: '冷启动草稿' } } as CalendarRequest;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const first = new CalendarDialogue(base, f.service, async () => create, undefined, Date.now, undefined, undefined,
    undefined, persistence);
  const firstConversation = new Conversation(first, () => {});
  await firstConversation.submit('创建恢复测试日程', true);
  const oldOperation = saved?.draft.operationId;
  assert.ok(oldOperation); assert.equal(f.writes(), 2);
  first.invalidate(); firstConversation.close();

  const restarted = new CalendarDialogue(base, f.service, async () => { throw new Error('fresh preview must not re-plan'); },
    undefined, Date.now, undefined, undefined, undefined, persistence);
  await restarted.restoreRecovery(saved);
  const conversation = new Conversation(restarted, () => {});
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 2); assert.match(conversation.history.at(-1)!.content, /确认创建/);
  assert.notEqual(saved?.draft.operationId, oldOperation);
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 3); assert.ok([...f.records.values()].some(event => event.summary === '恢复测试'));
  assert.equal(saved, undefined);
  conversation.close();
});

test('cold-start reconciliation proves an uncertain Calendar write instead of replaying it', async t => {
  const f = await fixture(t); let saved: CalendarRecoveryState | undefined;
  const persistence = { save(value: CalendarRecoveryState) { saved = structuredClone(value); }, clear() { saved = undefined; } };
  const create = { action: 'create', clarification: '', ...range, targetIndex: 0, titleQuery: '',
    changes: { ...empty, title: '不确定写入测试', start: '2026-10-03T09:00-05:00', end: '2026-10-03T10:00-05:00',
      timezone: 'America/Chicago', allDay: false, location: '', notes: '' } } as CalendarRequest;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const first = new CalendarDialogue(base, f.service, async () => create, undefined, Date.now, undefined, undefined,
    undefined, persistence);
  const conversation = new Conversation(first, () => {});
  await conversation.submit('创建不确定写入测试', true);
  f.makeWriteUncertain();
  await conversation.submit('确认创建', true);
  assert.ok(saved?.draft.blocked); const writes = f.writes(); conversation.close();

  const restarted = new CalendarDialogue(base, f.service, async () => create, undefined, Date.now, undefined, undefined,
    undefined, persistence);
  await restarted.restoreRecovery(saved);
  assert.equal(f.writes(), writes);
  assert.equal(saved, undefined);
  assert.ok([...f.records.values()].some(event => event.summary === '不确定写入测试'));
});

test('disconnect-style invalidation retains a cancel batch but requires a fresh preview for each remaining write', async t => {
  const f = await fixture(t); let action: TurnPlan['calendarAction'] = 'query';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const planner = async (): Promise<CalendarRequest> => action === 'query' ? query : { ...query, action: 'cancel' };
  const dialog = new CalendarDialogue(base, f.service, planner);
  const conversation = new Conversation(dialog, () => {});
  await conversation.submit('查看十月一日的两个日程', true);
  action = 'cancel';
  await conversation.submit('两个都删除', true);
  dialog.invalidate();

  await conversation.submit('确认取消', true);
  assert.equal(f.records.size, 2);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*确认取消/);
  await conversation.submit('确认', true);
  assert.equal(f.records.size, 1);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 A”[\s\S]*第2\/2项/);

  dialog.invalidate();
  await conversation.submit('确认取消', true);
  assert.equal(f.records.size, 1);
  assert.match(conversation.history.at(-1)!.content, /第2\/2项[\s\S]*取消·芝加哥时间[\s\S]*测试 B/);
  await conversation.submit('确认取消', true);
  assert.equal(f.records.size, 0);
  assert.match(conversation.history.at(-1)!.content, /2项都已删除/);
});

test('praise after a completed calendar batch gets a warm acknowledgement, not another operation prompt', async t => {
  const f = await fixture(t); let plannerCalls = 0, baseReplies = 0;
  const base = {
    async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create', cognitiveMode: 'casual' }; },
    async decide() { return 'respond' as const; },
    async reply(_history: unknown, _signal: AbortSignal, delta: (text: string) => void) {
      baseReplies++; delta('不客气。今晚照顾好自己，之后需要我时再叫我。');
    }
  };
  const planner = async (): Promise<CalendarRequest> => { plannerCalls++; return query; };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner), () => {});
  conversation.history.push({ role: 'assistant', content: 'Google 已保存全部2项日程。已请求发送邀请，请确认是否收到。' });
  await conversation.submit('不是，我是说你真棒，你帮我创建了两个，一个提醒买票，一个是真正的 event，太贴心了。', true);
  assert.equal(conversation.history.at(-1)?.content,
    '谢谢你这么说！这两个日程已经创建好了。能帮你把安排真正落下来，我也很开心；之后想调整，随时告诉我。');
  assert.equal(plannerCalls, 0); assert.equal(baseReplies, 0); assert.equal(f.reads(), 0);
  await conversation.submit('目前没有什么事情了，谢谢你。', true);
  assert.equal(conversation.history.at(-1)?.content, '不客气。今晚照顾好自己，之后需要我时再叫我。');
  assert.equal(baseReplies, 1);
});

test('a retrospective calendar status question re-reads Google instead of receiving social acknowledgement', async t => {
  const f = await fixture(t); let plannerCalls = 0, baseReplies = 0;
  const base = {
    async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', cognitiveMode: 'casual' }; },
    async decide() { return 'respond' as const; },
    async reply(_history: unknown, _signal: AbortSignal, delta: (text: string) => void) { baseReplies++; delta('错误的普通回答'); }
  };
  const planner = async (): Promise<CalendarRequest> => { plannerCalls++; return query; };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner), () => {});
  conversation.history.push({ role: 'assistant', content: 'Google 已保存新日程。已请求Google发送邀请，请确认是否收到。' });
  await conversation.submit('刚才那个日程创建好了吗？', true);
  assert.equal(plannerCalls, 1); assert.equal(baseReplies, 0); assert.equal(f.reads(), 1);
  assert.match(conversation.history.at(-1)!.content, /共 2 个事件/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /谢谢你这么说/);
});

test('explicit closure immediately after calendar creation gets one warm close without another question', async t => {
  const f = await fixture(t); let plannerCalls = 0;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => { plannerCalls++; return query; }), () => {});
  conversation.history.push({ role: 'assistant', content: 'Google 已保存新日程。已请求Google发送邀请，请确认是否收到。' });
  await conversation.submit('目前没有什么事情了，谢谢你。', true);
  assert.equal(conversation.history.at(-1)?.content,
    '不客气，这个日程已经稳稳地安排好了。接下来按自己的节奏来就好；之后有变化，随时告诉我。');
  assert.doesNotMatch(conversation.history.at(-1)!.content, /需要我|吗[？?]?$/);
  assert.equal(plannerCalls, 0);
});
test('one request can cancel four listed events with one immutable confirmation at a time', async t => {
  const f = await fixture(t);
  for (const [title, hour] of [['测试 C', 20], ['测试 D', 21]] as const) {
    const event = { ...original, title, start: `2026-10-01T${hour}:00-05:00`, end: `2026-10-01T${hour + 1}:00-05:00` };
    const pending = await f.service.preview('create', event); await f.service.confirm(pending.id, pending.phrase);
  }
  let action: TurnPlan['calendarAction'] = 'query';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const planner = async (): Promise<CalendarRequest> => action === 'query' ? query : { ...query, action: 'cancel' };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner), () => {});
  await conversation.submit('查看十月一日的安排', true);
  assert.match(conversation.history.at(-1)!.content, /共 4 个事件/);
  action = 'cancel'; await conversation.submit('这四个都取消', true);
  for (let index = 1; index <= 4; index++) {
    assert.match(conversation.history.at(-1)!.content, new RegExp(`第${index}\\/4项[\\s\\S]*确认取消`));
    await conversation.submit(index === 1 ? '确认取消' : '好，可以', true);
  }
  assert.equal(f.records.size, 0);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 D”（4\/4）[\s\S]*4项都已删除/);
});
test('keep one and delete the other three creates a real batch and actively advances each confirmation', async t => {
  const f = await fixture(t);
  for (const [title, hour] of [['前往 Target（Mills Civic Pkwy）', 20], ['去 Cream Pan 和山城辣妹子', 21]] as const) {
    const event = { ...original, title, start: `2026-10-01T${hour}:00-05:00`, end: `2026-10-01T${hour + 1}:00-05:00` };
    const pending = await f.service.preview('create', event); await f.service.confirm(pending.id, pending.phrase);
  }
  let first = true; let baseReplies = 0;
  const base = {
    async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: first ? 'query' : 'none' }; },
    async decide() { return 'respond' as const; },
    async reply(_history: unknown, _signal: AbortSignal, delta: (text: string) => void) { baseReplies++; delta('普通模型回答'); }
  };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => query), () => {});
  await conversation.submit('查看十月一日的安排', true); first = false;
  assert.match(conversation.history.at(-1)!.content, /共 4 个事件/);
  await conversation.submit('帮我把除了“去 Target”那一个留下，其他的全都帮我删掉，谢谢。', true);
  assert.equal(baseReplies, 0); assert.equal(f.writes(), 4);
  assert.match(conversation.history.at(-1)!.content, /第1\/3项[\s\S]*确认取消/);
  await conversation.submit('确认删除', true);
  assert.equal(f.records.size, 3);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 A”（1\/3）[\s\S]*接下来是第2\/3项[\s\S]*确认取消/);
  await conversation.submit('确认删除三个', true);
  assert.equal(f.records.size, 3);
  assert.match(conversation.history.at(-1)!.content, /每次只确认一项[\s\S]*第2\/3项尚未提交/);
  await conversation.submit('确认', true);
  assert.equal(f.records.size, 2);
  assert.match(conversation.history.at(-1)!.content, /已删除“测试 B”（2\/3）[\s\S]*接下来是第3\/3项/);
  await conversation.submit('确定删除', true);
  assert.equal(f.records.size, 1);
  assert.equal([...f.records.values()][0].summary, '前往 Target（Mills Civic Pkwy）');
  assert.match(conversation.history.at(-1)!.content, /已删除“去 Cream Pan 和山城辣妹子”（3\/3）[\s\S]*3项都已删除[\s\S]*已保留“前往 Target（Mills Civic Pkwy）”/);
});
test('right-now creation uses the current location timezone and floors provider seconds', async t => {
  const now = Date.parse('2026-09-19T18:34:47Z');
  const f = await fixture(t, () => now); let plannerTimezone = '';
  const request: CalendarRequest = { action: 'create', clarification: '', rangeStart: '', rangeEnd: '', timezone: 'America/Chicago',
    targetIndex: 0, titleQuery: '', changes: { ...empty, title: '去小北京酒馆', start: '2026-09-19T13:00:37-05:00',
      end: '2026-09-19T15:00:37-05:00', timezone: 'America/Chicago', allDay: false, location: 'Peking Tavern', notes: '给陈总打电话' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const planner = async (_history: unknown, _context: unknown, _signal: AbortSignal, timezone?: string) => {
    plannerTimezone = timezone ?? ''; return structuredClone(request);
  };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner, undefined, () => now, undefined, undefined,
    async () => 'America/Los_Angeles'), () => {});
  await conversation.submit('从现在开始创建一个去小北京酒馆的日程，持续两个小时', true);
  assert.equal(plannerTimezone, 'America/Los_Angeles');
  const preview = conversation.history.at(-1)!.content;
  assert.match(preview, /洛杉矶时间/); assert.match(preview, /2026-09-19 11:34–13:34/);
  assert.doesNotMatch(preview, /芝加哥|:47|:37/);
  await conversation.submit('确认创建', true);
  const saved = [...f.records.values()].find(event => event.summary === '去小北京酒馆');
  assert.equal(saved.start.timeZone, 'America/Los_Angeles');
  assert.equal(saved.start.dateTime, '2026-09-19T11:34:00-07:00');
  assert.equal(saved.end.dateTime, '2026-09-19T13:34:00-07:00');
});
test('timezone fallback ambiguity asks one question with full session context and performs no write', async t => {
  const f = await fixture(t); let received: any[] = [], action: TurnPlan['calendarAction'] = 'none';
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: action }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => { throw new Error('planner must wait for timezone'); },
    undefined, Date.now, undefined, undefined, async history => {
      received = history; throw new TimezoneClarificationError('你现在在哪个城市或地区？');
    }), () => {});
  await conversation.submit('我之前在讨论周末行程', true);
  action = 'create';
  await conversation.submit('从现在开始创建一个两小时的日程', true);
  assert.match(conversation.history.at(-1)!.content, /你现在在哪个城市或地区？；尚未修改日历/);
  assert.ok(received.some(message => message.content.includes('周末行程')));
  assert.ok(received.some(message => message.content.includes('从现在开始')));
  assert.equal(f.writes(), 2);
});
test('explicit Calendar creation recovers from a model routing miss but still requires confirmation', async t => {
  const f = await fixture(t);
  const request: CalendarRequest = { action: 'create', clarification: '', rangeStart: '', rangeEnd: '', timezone: 'America/Chicago',
    targetIndex: 0, titleQuery: '', changes: { ...empty, title: 'Conference', start: '2026-10-02T15:00-05:00',
      end: '2026-10-02T16:00-05:00', timezone: 'America/Chicago', allDay: false, location: '测试会议室', notes: '' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', deliveryAction: 'none' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => request), () => {});
  await conversation.submit('帮我把周五下午三点的 conference 加到 calendar', true);
  assert.match(conversation.history.at(-1)!.content, /创建.*Conference|Conference.*确认创建/s);
  assert.equal(f.writes(), 2);
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 3);
  assert.match(conversation.history.at(-1)!.content, /Google 已保存新日程/);
});
test('a multi-stop itinerary is inferred once and previews each event for separate confirmation', async t => {
  const f = await fixture(t);
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', deliveryAction: 'none' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const events = [
    { title: '前往 Ames DMV', start: '2026-09-19T09:00-05:00', end: '2026-09-19T10:00-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Ames DMV', notes: '从当前位置出发；按已讨论车程安排。' },
    { title: '和朋友见面', start: '2026-09-19T10:10-05:00', end: '2026-09-19T11:10-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Ames DMV 附近', notes: '预留10分钟缓冲；默认停留1小时。' }
  ];
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => { throw new Error('single planner must not run'); },
    undefined, Date.now, undefined, async () => ({ action: 'plan', clarification: '', events })), () => {});
  await conversation.submit('明天9点出发，帮我把开车和见朋友分别创建成日历事件', true);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*前往 Ames DMV[\s\S]*确认创建/);
  assert.equal(f.writes(), 2);
  await conversation.submit('确认创建', true);
  assert.equal(f.writes(), 3);
  assert.match(conversation.history.at(-1)!.content, /已保存第1\/2项[\s\S]*第2\/2项[\s\S]*和朋友见面/);
  await conversation.submit('确认', true);
  assert.equal(f.writes(), 4);
  assert.match(conversation.history.at(-1)!.content, /已保存全部2项日程/);
  assert.deepEqual([...f.records.values()].map(event => event.summary).filter((title: string) => title.startsWith('前往') || title.startsWith('和朋友')).sort(),
    ['前往 Ames DMV', '和朋友见面'].sort());
});
test('the six-event itinerary limit remains sequential and requires six separate confirmations', async t => {
  const f = await fixture(t);
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', deliveryAction: 'none' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const events = Array.from({ length: 6 }, (_, index) => ({
    title: `行程 ${index + 1}`,
    start: `2026-10-01T${String(9 + index).padStart(2, '0')}:00-05:00`,
    end: `2026-10-01T${String(9 + index).padStart(2, '0')}:30-05:00`,
    timezone: 'America/Chicago', allDay: false, location: `地点 ${index + 1}`, notes: '',
  }));
  const conversation = new Conversation(new CalendarDialogue(base, f.service,
    async () => { throw new Error('single planner must not run'); }, undefined, Date.now, undefined,
    async () => ({ action: 'plan', clarification: '', events })), () => {});
  await conversation.submit('把出发、早餐、拜访朋友、公园、晚餐和返程这六段行程分别创建成日历事件', true);
  assert.match(conversation.history.at(-1)!.content, /第1\/6项[\s\S]*行程 1/);
  for (let index = 1; index <= 6; index++) {
    await conversation.submit(index === 1 ? '确认创建' : '确认', true);
    const reply = conversation.history.at(-1)!.content;
    if (index < 6) assert.match(reply, new RegExp(`已保存第${index}\\/6项[\\s\\S]*第${index + 1}\\/6项`));
    else assert.match(reply, /已保存全部6项日程/);
  }
  assert.equal(f.writes(), 8);
  for (const event of events) assert.ok([...f.records.values()].some(record => record.summary === event.title));
});
test('notes revise the current unsaved batch item and draft status never pretends it was created', async t => {
  const f = await fixture(t); let plannerCalls = 0;
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', deliveryAction: 'none' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const events = [
    { title: '前往 Connolly’s', start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:10-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Connolly’s', notes: '驾车并预留缓冲。' },
    { title: '在 Connolly’s 休息', start: '2026-10-01T18:10-05:00', end: '2026-10-01T20:10-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Connolly’s', notes: '' }
  ];
  const partial: CalendarRequest = { action: 'create', clarification: '', rangeStart: '', rangeEnd: '', timezone: 'America/Chicago',
    targetIndex: 0, titleQuery: '', changes: { ...empty, notes: 'Ask: Do you make a Black and Tan?' } };
  const planner = async (_history: unknown, context: any) => {
    plannerCalls++; assert.equal(context.draft.title, '前往 Connolly’s'); return partial;
  };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, planner, undefined, Date.now, undefined,
    async () => ({ action: 'plan', clarification: '', events })), () => {});
  await conversation.submit('把车程和喝酒分别创建成两个日历事件', true);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*前往 Connolly/);
  await conversation.submit('然后在 notes 里面加上那句，问他们能不能做 Black and Tan。', true);
  assert.equal(plannerCalls, 1);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*Black and Tan/);
  assert.equal(f.writes(), 2);
  await conversation.submit('不是，你刚刚不是已经创建过了吗？', true);
  assert.match(conversation.history.at(-1)!.content, /还没有写入 Google[\s\S]*待确认预览/);
  assert.equal(f.writes(), 2);
});
test('a finalized bullet itinerary handed to Calendar uses sequential previews instead of an oversized single event', async t => {
  const f = await fixture(t); let singleCalls = 0, itineraryCalls = 0;
  // Reproduce a classifier miss that incorrectly selected an ICS delivery.
  // The deterministic Calendar handoff must still choose real Calendar events.
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'none', deliveryAction: 'calendar' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const events = [
    { title: '环球影城', start: '2026-09-19T07:00-05:00', end: '2026-09-19T18:00-05:00', timezone: 'America/Chicago', allDay: false,
      location: 'Universal Studios Hollywood', notes: '临行前确认营业时间。' },
    { title: '前往尔湾朋友家', start: '2026-09-19T18:10-05:00', end: '2026-09-19T20:00-05:00', timezone: 'America/Chicago', allDay: false,
      location: '108 Wheatgrass Street, Irvine, CA 92618', notes: '预留10分钟离园缓冲。' }
  ];
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => { singleCalls++; return query; },
    undefined, Date.now, undefined, async () => { itineraryCalls++; return { action: 'plan', clarification: '', events }; }), () => {});
  conversation.history.push({ role: 'user', content: '帮我规划环球影城和尔湾行程。', topicId: 'trip' },
    { role: 'assistant', content: '行程：\n- 7:00 去环球影城\n- 18:00 去尔湾朋友家\n- 第二天9:00返程', topicId: 'trip' },
    { role: 'user', content: '看完以后我直接走回来。', topicId: 'trip' },
    { role: 'assistant', content: '好，回程安排步行回家。', topicId: 'trip' });
  await conversation.submit('好，我觉得可以。帮我安排一下，然后给我发个 Calendar reminder。', true);
  assert.equal(itineraryCalls, 1); assert.equal(singleCalls, 0);
  assert.match(conversation.history.at(-1)!.content, /第1\/2项[\s\S]*环球影城/);
  assert.doesNotMatch(conversation.history.at(-1)!.content, /超过两页|分次修改|缩短内容/);
  await conversation.submit('好，可以。', true);
  assert.equal(f.writes(), 3);
  assert.match(conversation.history.at(-1)!.content, /已保存第1\/2项[\s\S]*第2\/2项/);
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
  for (const phrase of ['确认', '好，可以。', '可以', '没问题', '不要确认按芝加哥时间修改日程', '他说“确认按芝加哥时间修改日程”', '确认按纽约时间修改日程']) {
    const conversation = new Conversation(dialog, () => {}); await conversation.submit(phrase, true);
  }
  assert.equal(f.writes(), 2);
});

test('calendar confirmation is bound to the exact immediately preceding preview', async t => {
  const f = await fixture(t);
  const request: CalendarRequest = { ...query, action: 'create', changes: { ...original, title: '预览绑定测试' } };
  const base = { async plan(): Promise<TurnPlan> { return { decision: 'respond', calendarAction: 'create' }; },
    async decide() { return 'respond' as const; }, async reply() {} };
  const conversation = new Conversation(new CalendarDialogue(base, f.service, async () => request), () => {});

  await conversation.submit('创建预览绑定测试', true);
  const pending = f.service.list().operations.find(operation => operation.state === 'pending');
  assert.ok(pending);
  conversation.history.push({ role: 'assistant', content: '这不是获批的日历预览。' });

  await conversation.submit('确认', true);
  assert.equal(f.writes(), 2, 'a confirmation after another assistant message must not write');
  const operations = f.service.list().operations;
  assert.equal(operations.find(operation => operation.id === pending.id)?.state, 'dismissed');
  assert.ok(operations.some(operation => operation.id !== pending.id && operation.state === 'pending'),
    'the retained draft must receive a new independently confirmable preview');
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
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...query, action: 'update', rangeStart: '2026-10-01T00:00:00-05:00', changes: { ...empty, start: '2026-10-01T18:45:00-05:00' } }) }] }] })); }) as typeof fetch;
  const planner = createCalendarPlanner({ OPENAI_API_KEY: 'fake', OPENAI_INTENT_MODEL: 'configured-model' }, request);
  const parsed = await planner([{ role: 'user', content: '今天几个event' }], { candidates: [] }, new AbortController().signal);
  assert.equal(parsed.rangeStart, range.rangeStart); assert.equal(parsed.changes.start, '2026-10-01T18:45-05:00');
  assert.equal(body.model, 'configured-model'); assert.equal(body.store, false); assert.equal(body.tools, undefined);
  assert.equal(body.text.format.strict, true); assert.equal(body.input[0].content.includes('fake'), false);
});
test('single-event planner feeds semantic validation failures back to Luna and repairs before preview', async () => {
  const bodies: any[] = []; let call = 0;
  const valid: CalendarRequest = { action: 'create', clarification: '', rangeStart: '', rangeEnd: '', timezone: 'America/Chicago',
    targetIndex: 0, titleQuery: '', scope: null, changes: { ...empty, title: '喝酒', start: '2026-10-01T18:00-05:00',
      end: '2026-10-01T20:00-05:00', timezone: 'America/Chicago', allDay: false, location: 'Connolly’s', notes: 'Ask about Black and Tan.', recurrence: null } };
  const request = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const output = call++ === 0 ? { ...valid, changes: { ...valid.changes, end: '2026-10-01T17:00-05:00' } } : valid;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(output) }
    ] }] }));
  }) as typeof fetch;
  const planner = createCalendarPlanner({ OPENAI_API_KEY: 'fake', OPENAI_INTENT_MODEL: 'configured-model' }, request,
    () => new Date('2026-09-19T18:00:00Z'));
  const result = await planner([{ role: 'user', content: '十月一日六点去喝酒，待两小时。' }], { candidates: [] }, new AbortController().signal);
  assert.equal(call, 2); assert.equal(result.changes.end, '2026-10-01T20:00-05:00');
  const retryInput = JSON.parse(bodies[1].input[0].content);
  assert.match(retryInput.repair_feedback, /valid title|start\/end|timezone/i);
  assert.doesNotMatch(retryInput.repair_feedback, /CALENDAR_/);
});
