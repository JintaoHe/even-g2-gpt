// Explicit opt-in only: npm run conversation:eval (uses paid OpenAI API).
import 'dotenv/config';
import assert from 'node:assert/strict';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { Conversation, type Decision } from '../src/conversation.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY required');
const model = new OpenAIDialogue(key, process.env.OPENAI_DIALOGUE_MODEL ?? 'gpt-4.1-mini', undefined, false);
const examples: [string, Decision[]][] = [
  ['退下吧', ['exit']], ['再见，结束这次对话', ['exit']], ['不要退出，我们继续', ['respond']],
  ['把备注改成再见', ['respond']], ['他说了再见，然后就走了', ['respond']],
  ['如果我说退下吧，你会怎么办？', ['respond']], ['帮我把 deployment date 改到', ['wait']],
  ['把 deployment date update 到 next Friday，不要删除原来的备注', ['respond']],
  ['Goodbye is the title of this document. 帮我解释一下这个标题。', ['respond']],
  ['等一下，只看下午的安排', ['respond']]
];
let failures = 0;
for (const [index, [input, expected]] of examples.entries()) {
  const started = performance.now();
  try {
    const actual = await model.decide([], input, false, new AbortController().signal);
    const ok = expected.includes(actual); if (!ok) failures++;
    console.log(`Intent ${index + 1}: ${ok ? 'PASS' : 'FAIL'} (${actual}, ${Math.round(performance.now() - started)}ms)`);
  } catch { failures++; console.log(`Intent ${index + 1}: API_ERROR`); break; }
}
if (!failures) {
  const errors: string[] = [];
  const c = new Conversation(model, e => { if (e.type === 'error') errors.push(String(e.code)); });
  await c.submit('我们在讨论一个虚构项目，代号是 Cedar。请用一句话确认。', true);
  await c.submit('刚才那个项目的代号是什么？只回复代号。', true);
  assert.deepEqual(errors, []); assert.match(c.history.at(-1)?.content ?? '', /Cedar/i);
  console.log('Two-turn context + streaming: PASS');
  const direct = await model.decide([{ role: 'assistant', content: '你是想结束这次对话，还是继续聊？' }], '是的，结束吧', false, new AbortController().signal);
  assert.equal(direct, 'exit'); console.log('Contextual exit confirmation: PASS');
}
if (failures) process.exitCode = 1;
