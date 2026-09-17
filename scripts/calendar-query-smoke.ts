// Read-only live regression: no event writes or mail are possible through this transport.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { GoogleCalendarService, loadCalendarTransport } from '../src/google-calendar.js';
import { CalendarDialogue } from '../src/calendar-dialogue.js';
import { createCalendarPlanner } from '../src/calendar-planner.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { Conversation } from '../src/conversation.js';
import { createCalendarAnswerer } from '../src/calendar-answer.js';
async function main() {
  const root = resolve(process.env.EVEN_DATA_DIR || '.local'), dir = join(root, 'calendar-query-smoke');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const loaded = await loadCalendarTransport(root); let reads = 0;
  const service = await GoogleCalendarService.create(dir, loaded.calendarId, async (method, path, body, etag) => {
    assert.equal(method, 'GET', 'live regression is read-only'); if (path.startsWith('/events?')) reads++;
    return loaded.transport(method, path, body, etag);
  });
  const planner = createCalendarPlanner(); const requests: unknown[] = [];
  const base = new OpenAIDialogue(process.env.OPENAI_API_KEY!, process.env.OPENAI_INTENT_MODEL ?? 'gpt-5.6-luna', undefined, false, 1, 'America/Chicago', undefined, { calendarRouting: true, deliveryRouting: true, intentTokens: 512 });
  const dialog = new CalendarDialogue(base, service, async (...args) => { const result = await planner(...args); requests.push(result); return result; }, undefined, Date.now, createCalendarAnswerer());
  const conversation = new Conversation(dialog, () => {});
  try {
    for (const text of ['帮我查一下2026年十月二号的Even联动测试会议是什么时候，在哪里？', '我说的是十月二号周五有没有什么会议？', '你确定没有任何的会议吗？']) {
      const before = reads; await conversation.submit(text, true);
      const answer = conversation.history.at(-1)!.content;
      assert.ok(reads > before, 'each query must fetch Google');
      assert.match(answer, /2026-10-02/); assert.match(answer, /Even 联动测试/);
      assert.doesNotMatch(answer, /共 0 个|无法访问/);
      console.log('PASS live query: fresh Google read, correct date, expected event present');
    }
    const before = reads;
    await conversation.submit('这个会议calendar里面有什么补充信息吗？sales会到场吗？', true);
    const detail = conversation.history.at(-1)!.content;
    assert.ok(reads > before); assert.match(detail, /sales|销售/i); assert.match(detail, /无法|不能|未|不确定/); assert.doesNotMatch(detail, /共 \d+ 个事件/);
    console.log('PASS live details answer: fresh facts and uncertain sales attendance, not a list');
    const mailPlan = await base.plan([{ role: 'assistant', content: '文件已生成：测试议程.md。确认发送到固定邮箱吗？' }], '可以，发给我吧', true, new AbortController().signal);
    assert.equal(mailPlan.deliveryAction, 'confirm');
    console.log('PASS live natural mail approval classification; no mail sender invoked');
  } finally {
    await writeFile(join(dir, 'report.json'), JSON.stringify({ reads, requests, history: conversation.history }, null, 2), { mode: 0o600 });
    conversation.close(); dialog.endSession(); await service.close();
  }
}
main().catch(() => { console.error('READ_ONLY_QUERY_SMOKE_FAILED; inspect private report'); process.exitCode = 1; });
