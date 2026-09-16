// Paid, opt-in. Stop the lab before running: shared search ledger is single-process.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { OpenAIDialogue, type DialogueOptions } from '../src/dialogue-model.js';
import { Conversation, type Decision, type Event, type Message, type ReplyUpdate } from '../src/conversation.js';
import { SearchQuota } from '../src/search-quota.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY required');
const options: DialogueOptions = { reasoningEffort: 'low', intentTokens: 2048, replyTokens: 3072,
  extraInstructions: 'Your name is Even, not the user\'s name. Preserve Even, G2, R1 and project names as proper nouns; never translate the assistant name Even as 甚至. Follow explicit requested output language.' };
const timezone = process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago';
const hybrid = process.argv.includes('--hybrid');
const luna = process.argv.includes('--luna'), baseline = process.argv.includes('--baseline');
const routed = hybrid || luna || baseline;
const profile = luna ? 'luna' : baseline ? 'baseline' : hybrid ? 'hybrid' : 'nano';
const hybridEnv = { ...process.env, OPENAI_INTENT_MODEL: luna ? 'gpt-5.6-luna' : 'gpt-4.1-mini',
  OPENAI_REPLY_MODEL: luna ? 'gpt-5.6-luna' : baseline ? 'gpt-4.1-mini' : 'gpt-5-nano', OPENAI_MAX_SEARCH_CALLS: '1' };
const model = routed ? createHybridDialogue(key, hybridEnv, { search: false }).model
  : new OpenAIDialogue(key, 'gpt-5-nano', undefined, false, 1, timezone, undefined, options);
const report: any = { at: new Date().toISOString(), model: routed ? `${hybridEnv.OPENAI_INTENT_MODEL} intent / ${hybridEnv.OPENAI_REPLY_MODEL} reply` : 'gpt-5-nano',
  options: luna ? { intentTokens: 128, replyTokens: 1400, reasoning: 'none' }
    : baseline ? { intentTokens: 128, replyTokens: 1400 } : hybrid ? { intentTokens: 128, replyTokens: 3072, replyReasoning: 'low' } : options, cases: [] };
// Fail early if the explicitly selected model is unavailable, before paid suites/search reservations.
await model.decide([], '你好', false, new AbortController().signal);
const signal = () => new AbortController().signal;
async function check(id: string, run: () => Promise<object>) {
  const start = performance.now();
  try {
    const row = { id, ...await run(), totalMs: Math.round(performance.now() - start) };
    report.cases.push(row); console.log(JSON.stringify(row));
  } catch (e) {
    const row = { id, pass: false, error: e instanceof Error ? e.message : 'Unknown error' };
    report.cases.push(row); console.log(JSON.stringify(row));
  }
}
const cases: { text: string; expected: Decision; history?: Message[]; forced?: boolean }[] = [
  { text: '退下吧', expected: 'exit' },
  { text: 'Goodbye Even，结束这次对话。', expected: 'exit' },
  { text: '不要退出，我们继续', expected: 'respond' },
  { text: '把备注改成再见', expected: 'respond' },
  { text: '他说了再见，然后就走了', expected: 'respond' },
  { text: '如果我说退下吧，你会怎么办？', expected: 'respond' },
  { text: '帮我把 deployment date 改到', expected: 'wait' },
  { text: '帮我把 deployment date 改到\n下周五，不要删除原备注', expected: 'respond' },
  { text: 'Goodbye is the title of this document. 帮我解释一下这个标题。', expected: 'respond' },
  { text: '是的，结束吧', expected: 'exit', history: [{ role: 'assistant', content: '你是想结束这次对话，还是继续聊？' }] },
  { text: '不是，继续聊', expected: 'respond', history: [{ role: 'assistant', content: '你是想结束这次对话，还是继续聊？' }] },
  { text: '帮我把日期改到', expected: 'respond', forced: true }
];
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const [i, c] of cases.entries()) await check(`intent-${i + 1}-run-${repeat}`, async () => {
    const actual = await model.decide(c.history ?? [], c.text, c.forced ?? false, signal());
    return { pass: actual === c.expected, input: c.text, expected: c.expected, actual };
  });
}
const events: Event[] = [];
const conversation = new Conversation(model, event => events.push(event));
const turns: [string, RegExp][] = [
  ['我们讨论虚构项目 Cedar，负责人是 Ian，deployment date 是 2026-09-18。只在这次聊天里记住。请简短确认，不要执行任何外部操作。', /Cedar/],
  ['更正一下，负责人改成 Mei，日期改成 2026-09-21，项目代号不变。请复述这三个字段，不要执行操作。', /Mei/],
  ['现在只回复项目代号、负责人和日期，不要带旧值。', /Cedar.*Mei.*2026-09-21/s],
  ['把这句话翻译成中文，Even 是助手名字，要保留原文：Even, add oat milk to my shopping list。只是翻译，不要执行。', /Even/]
];
for (const [i, [input, expected]] of turns.entries()) await check(`conversation-${i + 1}`, async () => {
  events.length = 0; const start = performance.now(); let firstTextMs: number | null = null;
  // Event arrival measurement includes the app's intent call before its reply call.
  const originalPush = events.push.bind(events);
  events.push = (...items) => { if (firstTextMs === null && items.some(e => e.type === 'answer.delta')) firstTextMs = Math.round(performance.now() - start); return originalPush(...items); };
  try { await conversation.submit(input); } finally { events.push = originalPush; }
  const answer = conversation.history.at(-1)?.content ?? '';
  const pass = !events.some(e => e.type === 'error') && conversation.state === 'listening' && expected.test(answer)
    && (i !== 2 || !/Ian|2026-09-18/.test(answer)) && (i !== 3 || !/甚至/.test(answer));
  return { pass, input, answer, firstTextMs };
});
await check('semantic-exit-and-confirm', async () => {
  events.length = 0; await conversation.submit('好了 Even，退下吧。');
  const pending = conversation.state === 'exit_pending' && !conversation.acceptsInput
    && events.some(e => e.type === 'exit.confirmation_required') && !events.some(e => e.type === 'answer.delta');
  conversation.confirmExit(true);
  return { pass: pending && String(conversation.state) === 'closed', state: conversation.state };
});
await check('interrupt-stream', async () => {
  const seen: Event[] = []; let interrupted = false, late = 0;
  const c = new Conversation(model, e => {
    seen.push(e);
    if (e.type === 'answer.delta') {
      if (interrupted) late++;
      else { interrupted = true; c.interrupt(); }
    }
  });
  await c.submit('用中文详细解释什么是缓存，给三个例子。', true);
  return { pass: interrupted && late === 0 && c.state === 'listening' && seen.some(e => e.type === 'answer.cancelled')
    && !seen.some(e => e.type === 'answer.done' || e.type === 'error'), interrupted, late, state: c.state };
});
const ledger = new SearchQuota(undefined, timezone);
const diagnosticQuota = { reserve: async (n: number) => {
  const ticket = await ledger.reserve(n);
  return ticket && { limit: ticket.limit, settle: async (actual: number) => {
    report.searchAccounting ??= []; report.searchAccounting.push({ reserved: ticket.limit, actual });
    try { await ticket.settle(actual); }
    catch (error) { report.searchAccounting.at(-1).error = error instanceof Error ? error.message : 'Unknown error'; throw error; }
  } };
} };
const searching = routed ? createHybridDialogue(key, hybridEnv, { search: true, quota: diagnosticQuota }).model
  : new OpenAIDialogue(key, 'gpt-5-nano', undefined, true, 1, timezone, new SearchQuota(undefined, timezone), options);
for (const [id, input, expectSearch] of [
  ['greeting', '你好 Even，请用中文简短打个招呼。', false],
  ['no-browse', '不要联网。解释什么是股票市值，不要给实时价格。', false],
  ['current-news', '请联网查询 NVIDIA 最近公布的季度财报，注明财季、营收和来源。', true]
] as const) await check(`auto-search-${id}`, async () => {
  let answer = '', firstTextMs: number | null = null; const updates: ReplyUpdate[] = [], start = performance.now();
  await searching.reply([{ role: 'user', content: input }], signal(), text => {
    firstTextMs ??= Math.round(performance.now() - start); answer += text;
  }, e => updates.push(e));
  const searched = updates.some(e => e.type === 'search.status' && ['in_progress', 'searching', 'completed'].includes(e.status));
  const unavailable = updates.some(e => e.type === 'search.status' && e.status.startsWith('quota_'));
  const citations = updates.find(e => e.type === 'answer.citations');
  return { pass: !unavailable && searched === expectSearch && answer.length > 0
    && (!expectSearch || (citations?.type === 'answer.citations' && citations.citations.length > 0)),
    input, searched, unavailable, answer, firstTextMs, citations: citations?.type === 'answer.citations' ? citations.citations : [] };
});
await mkdir('.local/evals', { recursive: true });
await writeFile(`.local/evals/${profile}-conversation-latest.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`RESULT ${report.cases.filter((c: any) => c.pass).length}/${report.cases.length}`);
if (report.cases.some((c: any) => !c.pass)) process.exitCode = 1;
