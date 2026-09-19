// Small paid API smoke test; no web search, microphone or personal history.
import 'dotenv/config';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { Conversation, type ReasoningEffort, type Message } from '../src/conversation.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Missing OPENAI_API_KEY');
const { model } = createHybridDialogue(key, { OPENAI_INTENT_MODEL: 'gpt-5.6-luna', OPENAI_REPLY_MODEL: 'gpt-5.6-luna' }, { search: false });
const cases: { text: string; effort: ReasoningEffort; history?: Message[]; decision?: string }[] = [
  { text: 'Hi Even，你好！', effort: 'low' },
  { text: '帮我普通比较一下坐公交和骑车各有什么优缺点。', effort: 'low' },
  { text: '深入想一下，如果自由意志不存在，人为什么还应该承担道德责任？请简短回答。', effort: 'medium' },
  { text: '这是一个涉及安全、隐私、成本、延迟、故障恢复和多地区合规的多阶段系统设计。请用最高推理做严格的风险分析，找出相互依赖和可能的失效链。', effort: 'high' },
  { text: '把“深入想一下”翻译成英文，不要解释。', effort: 'low' },
  { text: '快速告诉我法国首都，不用深入分析。', effort: 'low' },
  { text: '你刚才忽略了隐私和离线可用性，深入重新权衡一下。', effort: 'medium', history: [{ role: 'user', content: '比较本地日历和云端日历的架构。' }, { role: 'assistant', content: '云端容易维护，本地响应快。' }] },
  { text: '退下吧', effort: 'low', decision: 'exit' }
];
let passed = 0;
for (const item of cases) {
  const start = Date.now();
  const plan = await model.plan(item.history ?? [], item.text, false, AbortSignal.timeout(90000));
  const ok = plan.decision === (item.decision ?? 'respond') && plan.reasoningEffort === item.effort;
  passed += Number(ok);
  console.log(JSON.stringify({ text: item.text, expected: item.effort, ...plan, ok, ms: Date.now() - start }));
}
console.log(`Routing: ${passed}/${cases.length}`);
// Real end-to-end Conversation path: classify once, stream one answer.
for (const item of cases.slice(0, 4)) {
  const start = Date.now(); let firstMs: number | undefined, effort: unknown, failed = false;
  const conversation = new Conversation(model, event => {
    if (event.type === 'answer.start') effort = event.reasoningEffort;
    if (event.type === 'answer.delta') firstMs ??= Date.now() - start;
    if (event.type === 'error') failed = true;
  });
  await conversation.submit(item.text);
  console.log(JSON.stringify({ smoke: true, effort, firstMs, totalMs: Date.now() - start, state: conversation.state, failed,
    answer: conversation.history.at(-1)?.content }));
  if (failed || firstMs === undefined) process.exitCode = 1;
}
if (passed !== cases.length) process.exitCode = 1;
