// Explicit opt-in. Two real Responses calls; search call cap is two per reply.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { SearchQuota } from '../src/search-quota.js';
import type { ReplyUpdate } from '../src/conversation.js';
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY required');
const model = new OpenAIDialogue(key, process.env.OPENAI_DIALOGUE_MODEL ?? 'gpt-4.1-mini', undefined, true, 2,
  process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', new SearchQuota(undefined, process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago'));
for (const [index, text] of ['你好，回复一句问候即可。', '请联网查询 NVIDIA（NVDA）最近一个交易日的股价表现。注明日期、数据时间和来源；不要猜测实时价格。'].entries()) {
  const updates: ReplyUpdate[] = []; let result = ''; const began = performance.now();
  await model.reply([{ role: 'user', content: text }], new AbortController().signal, s => { result += s; }, e => updates.push(e));
  const searched = updates.some(e => e.type === 'search.status' && e.status === 'searching');
  const cited = updates.find(e => e.type === 'answer.citations');
  assert.ok(result.length > 0);
  if (index === 0) assert.equal(searched, false);
  else { assert.equal(searched, true); assert.ok(cited?.type === 'answer.citations' && cited.citations.length > 0); }
  console.log(`${index === 0 ? 'Greeting without search' : 'Live search with URL citations'}: PASS (${Math.round(performance.now() - began)}ms)`);
}
