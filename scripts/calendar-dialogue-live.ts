// Explicit real-calendar smoke test. Only creates/edits two labelled synthetic events; no mail/guests.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GoogleCalendarService, loadCalendarTransport, eventBody, CalendarError } from '../src/google-calendar.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { createCalendarPlanner } from '../src/calendar-planner.js';
import { Conversation } from '../src/conversation.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { paginate } from '../clients/even/src/pager.js';

let phase = 'setup';
async function main() {
  if (!process.argv.includes('--real-google')) throw Error('EXPLICIT_REAL_TEST_REQUIRED');
  const root = resolve(process.env.EVEN_DATA_DIR || '.local'), directory = join(root, 'calendar-dialogue-smoke');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { transport, calendarId } = await loadCalendarTransport(root);
  const zone = 'America/Chicago';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'longOffset' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`, offset = parts.timeZoneName.replace('GMT', '') || '+00:00';
  const time = (hour: string) => `${day}T${hour}${offset}`;
  const ids = ['A', 'B'].map(label => createHash('sha256').update(`even-dialogue-test-v1-${day}-${label}`).digest('hex').slice(0, 32));
  const initial = ['A', 'B'].map((label, index) => ({ title: `Even 对话测试 ${label}—非真实安排`, start: time(index ? '18:30' : '18:00'),
    end: time(index ? '19:30' : '19:00'), timezone: zone, allDay: false, location: '测试地点', notes: '仅测试，保留原备注；无闹钟无受邀人。' }));
  phase = 'fixtures';
  for (let i = 0; i < 2; i++) {
    let existing: any;
    try { existing = await transport('GET', `/events/${ids[i]}`); }
    catch (error) { if (!(error instanceof CalendarError && error.status === 404)) throw error; }
    if (existing) {
      if (existing.extendedProperties?.private?.evenDialogSmoke !== day || existing.attendees?.length) throw Error('FIXTURE_MISMATCH');
      await transport('PATCH', `/events/${ids[i]}?sendUpdates=none`, eventBody(initial[i]), existing.etag);
    } else await transport('POST', '/events?sendUpdates=none', { id: ids[i], ...eventBody(initial[i]), reminders: { useDefault: false },
      extendedProperties: { private: { evenAssistant: '1', evenDialogSmoke: day } } });
  }
  const service = await GoogleCalendarService.create(directory, calendarId, transport);
  const model = process.env.OPENAI_INTENT_MODEL ?? 'gpt-5.6-luna';
  const base = new OpenAIDialogue(process.env.OPENAI_API_KEY!, model, undefined, false, 1, zone, undefined,
    { calendarRouting: true, deliveryRouting: true, intentTokens: 512 });
  const plan = createCalendarPlanner();
  const dialogue = new CalendarDialogue(base, service, async (history, context, signal) => {
    const result = await plan(history, context, signal);
    await writeFile(join(directory, 'last-request.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); return result;
  });
  const conversation = new Conversation(dialogue, () => {});
  const ask = async (text: string) => {
    await conversation.submit(text, true);
    await writeFile(join(directory, 'conversation.json'), JSON.stringify(conversation.history, null, 2), { mode: 0o600 });
    const last = conversation.history.at(-1); assert.equal(last?.role, 'assistant'); return last!.content;
  };
  const phrase = (answer: string) => { const match = /说“([^”]+)”/.exec(answer); assert.ok(match, 'confirmation preview required'); return match[1]; };
  try {
    phase = 'today-query';
    const today = await ask('我今天有多少 event？列出今天的日程。');
    assert.match(today, /共 \d+ 个事件/); assert.match(today, /Even 对话测试 A/); assert.match(today, /Even 对话测试 B/); assert.doesNotMatch(today, /不代表你的全部日历/);
    assert.match(today, /备注：/);
    console.log('PASS live natural-language today query with notes');
    phase = 'ambiguous-selection';
    const ambiguous = await ask('把今天晚上的 Even 对话测试 event 改到18:45，地点改成测试公园，持续时间不变。');
    assert.match(ambiguous, /(?:选择|哪一个|指定)/); assert.match(ambiguous, /\bA\b/); assert.match(ambiguous, /\bB\b/);
    assert.equal((await transport('GET', `/events/${ids[0]}`)).location, initial[0].location);
    console.log('PASS multiple matches ask for selection; no premature write');
    phase = 'overlap-preview';
    const overlapping = await ask('选测试 A，今天18:45开始，持续一小时，地点测试公园，其他内容不变。');
    assert.match(overlapping, /原 /); assert.match(overlapping, /新 /); assert.match(overlapping, /重叠/);
    assert.ok(paginate(overlapping).length <= 2);
    assert.match(overlapping, /芝加哥时间/); assert.doesNotMatch(overlapping, /洛杉矶|纽约/);
    assert.equal(phrase(overlapping), '确认修改');
    console.log(`PASS overlap preview ${paginate(overlapping).length} pages, Chicago only, short confirmation`);
    const old = await transport('GET', `/events/${ids[0]}`);
    await transport('PATCH', `/events/${ids[0]}?sendUpdates=none`, { description: '模拟手机端更新的备注，应当保留。' }, old.etag);
    phase = 'etag-conflict';
    const conflict = await ask(phrase(overlapping)); assert.match(conflict, /日程已被改动/);
    assert.equal((await transport('GET', `/events/${ids[0]}`)).location, initial[0].location);
    console.log('PASS live ETag conflict refuses overwrite');
    phase = 'fresh-query'; await ask('重新查询今天的 Even 对话测试事件。');
    phase = 'fresh-preview';
    const preview = await ask('把测试 A 改到今天20:00到21:00，地点测试公园，保留现在的备注。');
    assert.match(preview, /其余不变/); assert.doesNotMatch(preview, /模拟手机端更新的备注/);
    assert.equal(paginate(preview).length, 1);
    assert.match(preview, /地点：测试地点 → 测试公园/);
    assert.match(preview, /芝加哥时间/); assert.doesNotMatch(preview, /洛杉矶|纽约/);
    const beforeConfirm = await transport('GET', `/events/${ids[0]}`);
    assert.equal(beforeConfirm.location, initial[0].location);
    phase = 'save-update'; const saved = await ask('确认'); assert.match(saved, /Google 已保存修改/);
    assert.equal(paginate(saved).length, 1);
    const final = await transport('GET', `/events/${ids[0]}`);
    assert.equal(final.id, ids[0]); assert.equal(final.location, '测试公园'); assert.equal(Date.parse(final.start.dateTime), Date.parse(time('20:00')));
    assert.equal(final.description, '模拟手机端更新的备注，应当保留。');
    console.log('PASS real model + Google update kept event ID and latest notes; time/location changed');
    phase = 'second-short-confirmation';
    const secondPreview = await ask('把测试 A 的地点改成园区咖啡馆，时间和备注不变。');
    assert.match(secondPreview, /测试公园 → 园区咖啡馆/); assert.ok(paginate(secondPreview).length <= 2);
    const secondSaved = await ask('确定'); assert.match(secondSaved, /Google 已保存修改/);
    const secondFinal = await transport('GET', `/events/${ids[0]}`);
    assert.equal(secondFinal.id, ids[0]); assert.equal(secondFinal.location, '园区咖啡馆');
    assert.equal(Date.parse(secondFinal.start.dateTime), Date.parse(time('20:00')));
    assert.equal(secondFinal.description, final.description);
    console.log('PASS one-page edit/receipt, 确认 and 确定 save correctly, unchanged fields preserved');
    await writeFile(join(directory, 'report.json'), JSON.stringify({ date: day, zone, passed: ['today_query', 'ambiguity', 'overlap_preview', 'etag_conflict', 'confirmed_update', 'compact_pages', 'chicago_only', 'short_confirmations'], pages: { overlapping: paginate(overlapping).length, update: paginate(preview).length, receipt: paginate(saved).length }, fixtureIds: ids, fixtureTitles: initial.map(e => e.title), remaining: 2 }, null, 2), { mode: 0o600 });
    console.log('PASS two labelled test events retained for simulator; no guests or emails');
  } finally { conversation.close(); dialogue.invalidate(); await service.close(); }
}
main().catch(() => { console.error(`CALENDAR_LIVE_FAILED phase=${phase}; see private conversation/ledger, no automatic retry.`); process.exitCode = 1; });
