// Paid live evaluation: two continuous conversations, each repeated twice.
// Only synthetic prompts; no web tools, microphone or production ledger writes.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { Conversation, type ReasoningEffort } from '../src/conversation.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Missing OPENAI_API_KEY');
type Case = { text: string; expected: ReasoningEffort };
const scenarios: { name: string; turns: Case[] }[] = [
  { name: 'difficulty-without-mode-commands', turns: [
    { text: 'Hi Even，法国首都是哪里？', expected: 'low' },
    { text: '为什么城市公共交通通常比每个人自己开车更节能？', expected: 'low' },
    { text: '假设一个城市预算固定，扩大公交覆盖会减少班次频率，提高频率又会排除郊区居民。低收入者更依赖公交，但中心区客流更大。应如何同时考虑公平、总出行时间、碳排放和财政可持续性来决定方案？哪些情况下你的选择应该反转？', expected: 'medium' },
    { text: '换个话题，2加3等于几？', expected: 'low' },
    { text: '普通比较一下骑车和走路上班各自的优缺点。', expected: 'low' },
    { text: '谢谢你！', expected: 'low' }
  ] },
  { name: 'philosophy-context-and-overrides', turns: [
    { text: '把自由意志翻译成英文，只给词组。', expected: 'low' },
    { text: '用通俗的话解释一下它是什么意思。', expected: 'low' },
    { text: '如果我们的选择都是由既往原因决定，责备别人似乎不公平；但如果完全不追究责任，又可能鼓励伤害。如何让责任制度既不依赖人本可以作出不同选择，又能保护无辜者且不把人仅当作威慑工具？', expected: 'medium' },
    { text: 'Translate “深入想一下” into English. 只给翻译。', expected: 'low' },
    { text: '回到刚才的责任问题，深入想一下：你的方案能否避免为了威慑而惩罚无辜者？请简短回答。', expected: 'medium' },
    { text: '不用深入分析，快速告诉我一周有几天。', expected: 'low' }
  ] }
];
// Audit actual outgoing request parameters, without retaining headers or keys.
const nativeFetch = globalThis.fetch;
const requests: { stream: boolean; effort: unknown; tools: boolean; maxTokens: unknown }[] = [];
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body));
  requests.push({ stream: !!body.stream, effort: body.reasoning?.effort, tools: !!body.tools, maxTokens: body.max_output_tokens });
  return nativeFetch(input, init);
};
const rows: any[] = [];
try {
  for (let repeat = 1; repeat <= 2; repeat++) for (const scenario of scenarios) {
    const { model } = createHybridDialogue(key, { OPENAI_INTENT_MODEL: 'gpt-5.6-luna', OPENAI_REPLY_MODEL: 'gpt-5.6-luna' }, { search: false });
    let events: any[] = [], start = 0, firstMs: number | undefined;
    const conversation = new Conversation(model, event => {
      events.push(event);
      if (event.type === 'answer.delta') firstMs ??= Date.now() - start;
    });
    for (const [index, item] of scenario.turns.entries()) {
      events = []; firstMs = undefined; start = Date.now(); const before = requests.length;
      await conversation.submit(item.text);
      const calls = requests.slice(before), selected = events.find(e => e.type === 'answer.start')?.reasoningEffort;
      const ok = selected === item.expected && calls.length === 2 && calls[0].effort === 'medium'
        && calls[1].stream && calls[1].effort === selected && calls.every(c => !c.tools)
        && events.some(e => e.type === 'answer.done') && !events.some(e => e.type === 'error');
      const row = { repeat, scenario: scenario.name, turn: index + 1, ...item, selected, ok, firstMs,
        totalMs: Date.now() - start, calls, state: conversation.state, answer: conversation.history.at(-1)?.content };
      rows.push(row);
      console.log(JSON.stringify({ ...row, answer: undefined, calls: undefined }));
      if (conversation.state !== 'listening') break;
    }
  }
} finally {
  globalThis.fetch = nativeFetch;
  await mkdir('.local/evals', { recursive: true });
  const summary = { date: new Date().toISOString(), passed: rows.filter(r => r.ok).length, total: rows.length,
    planned: 24, apiCalls: requests.length, rows };
  await writeFile('.local/evals/dynamic-reasoning-latest.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }));
}
if (rows.length !== 24 || rows.some(r => !r.ok)) process.exitCode = 1;
