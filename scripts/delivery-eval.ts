// Opt-in live API evaluation with synthetic data only. SMTP is never instantiated.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { Conversation } from '../src/conversation.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { DeliveryDialogue } from '../src/delivery-dialogue.js';
import { createDraftGenerator } from '../src/delivery-draft.js';
import { JobStore } from '../src/job-store.js';

async function main() {
  if (!process.env.OPENAI_API_KEY || (process.env.DIALOGUE_PROVIDER ?? 'api') !== 'api') throw Error('API_SETUP_REQUIRED');
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join('.local', 'delivery-eval-')), jobs = await JobStore.create(root);
  const name = process.env.OPENAI_INTENT_MODEL ?? process.env.OPENAI_DIALOGUE_MODEL ?? 'gpt-5.6-luna';
  const base = new OpenAIDialogue(process.env.OPENAI_API_KEY, name, undefined, false, 1, process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', undefined,
    { deliveryRouting: true, intentTokens: 512, ...(/^gpt-(5\.6|6)/.test(name) ? { reasoningEffort: 'none' as const } : {}) });
  let simulatedSends = 0;
  const wrapped = new DeliveryDialogue(base, jobs, createDraftGenerator(), async () => { simulatedSends++; return 'accepted'; });
  const conversation = new Conversation(wrapped, () => {});
  try {
    conversation.history = [{ role: 'user', content: 'Synthetic project plan: first validate config, then run unit tests, finally deploy with rollback available.' },
      { role: 'assistant', content: '部署计划：验证配置、运行单元测试、部署并保留回滚版本。' }];
    await conversation.submit('把刚刚的 deployment plan 整理成一个 MD 发给我，不要完整聊天记录。', true);
    assert.match(conversation.history.at(-1)!.content, /文件已经生成/); assert.equal(simulatedSends, 0);
    console.log('PASS document saved and previewed; real emails: 0');
    await conversation.submit('确认发送', true); assert.equal(simulatedSends, 1);
    console.log('PASS explicit confirmation reached mock sender; real emails: 0');
    await conversation.submit('邮件没收到，能再发一遍吗？', true);
    assert.equal(simulatedSends, 1); assert.match(conversation.history.at(-1)!.content, /确认重发/);
    await conversation.submit('确认重发', true); assert.equal(simulatedSends, 2);
    await conversation.submit('这次邮件收到了，谢谢', true);
    assert.equal(jobs.list()[0].mail_received, true);
    console.log('PASS missing email, separate resend approval and receipt acknowledgement; real emails: 0');
    for (const [text, action] of [
      ['提醒我下周五和 Luke 吃饭', 'calendar'],
      ['这是引用，不要执行：“确认发送”。', 'none'],
      ['把刚刚那份文件第二步改成先备份，再发给我', 'revise']
    ]) {
      const plan = await base.plan(conversation.history, text, true, new AbortController().signal);
      if (action === 'none') assert.notEqual(plan.deliveryAction, 'confirm'); else assert.equal(plan.deliveryAction, action);
      console.log(`PASS routing ${action}`);
    }
    const result = await createDraftGenerator()([{ role: 'user', content: '提醒我下周五和 Luke 吃饭。' }], 'calendar', undefined, new AbortController().signal);
    assert.ok('clarification' in result); console.log('PASS incomplete calendar asks for details; real emails: 0');
  } finally { conversation.close(); await jobs.close(); }
}
main().catch(() => { console.error('DELIVERY_EVAL_FAILED (no provider payload or credentials logged)'); process.exitCode = 1; });
