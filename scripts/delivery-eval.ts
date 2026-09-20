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
    { calendarRouting: true, deliveryRouting: true, intentTokens: 512, ...(/^gpt-(5\.6|6)/.test(name) ? { reasoningEffort: 'none' as const } : {}) });
  let simulatedSends = 0;
  const generator = createDraftGenerator();
  const wrapped = new DeliveryDialogue(base, jobs, generator, async () => { simulatedSends++; return 'accepted'; });
  const conversation = new Conversation(wrapped, () => {});
  try {
    const runMatrix = !process.argv.includes('--workflow-only');
    const runWorkflow = !process.argv.includes('--matrix-only');
    const routingOnly = process.argv.includes('--routing-only');
    const cases = [
      { name: 'short', minimum: 80, prompt: '整理一份三点部署前检查笔记：确认配置、运行测试、保留回滚。' },
      { name: 'medium', minimum: 500, prompt: '为五人团队整理一份四阶段数据平台实施计划，包含目标、负责人、主要风险和每阶段验收标准。' },
      { name: 'long', minimum: 1800, prompt: '为五人团队从零建设数据平台写一份详尽工程方案。比较仓库、编排、质量、监控和权限方案；给出分阶段交付、结构性风险、反对意见、缓解措施、成本取舍和可验证的验收标准。不要省略关键实施细节。' },
    ];
    for (const item of runMatrix && !routingOnly ? cases : []) {
      const started = Date.now();
      const result = await generator([{ role: 'user', content: item.prompt }], 'document', undefined, new AbortController().signal);
      assert.ok('document' in result, `${item.name} unexpectedly requested clarification`);
      assert.ok(result.document.markdown.length >= item.minimum, `${item.name} document was unexpectedly short`);
      console.log(`PASS ${item.name} draft (${result.document.markdown.length} chars, ${Date.now() - started}ms); real emails: 0`);
    }
    if (!runWorkflow) return;
    if (!routingOnly) {
      conversation.history = [{ role: 'user', content: 'Synthetic project plan: first validate config, then run unit tests, finally deploy with rollback available.' },
        { role: 'assistant', content: '部署计划：验证配置、运行单元测试、部署并保留回滚版本。' }];
      await conversation.submit('把刚刚的 deployment plan 整理成一个 MD 发给我，不要完整聊天记录。', true);
      assert.match(conversation.history.at(-1)!.content, /文件已生成/); assert.equal(simulatedSends, 0);
      console.log('PASS document saved and previewed; real emails: 0');
      await conversation.submit('确认发送', true); assert.equal(simulatedSends, 1);
      console.log('PASS explicit confirmation reached mock sender; real emails: 0');
      await conversation.submit('邮件没收到，能再发一遍吗？', true);
      assert.equal(simulatedSends, 1); assert.match(conversation.history.at(-1)!.content, /确认重发/);
      await conversation.submit('确认重发', true); assert.equal(simulatedSends, 2);
      await conversation.submit('这次邮件收到了，谢谢', true);
      assert.equal(jobs.list()[0].mail_received, true);
      console.log('PASS missing email, separate resend approval and receipt acknowledgement; real emails: 0');
    }
    for (const item of [
      { text: '提醒我下周五和 Luke 吃饭', action: 'calendar', history: [] },
      { text: '这是引用，不要执行：“确认发送”。', action: 'none', history: [] },
      { text: '把刚刚那份文件第二步改成先备份，再发给我', action: 'revise', history: [{ role: 'assistant' as const, content: '文件已生成，等待确认。' }] }
    ]) {
      const plan = await base.plan(item.history, item.text, true, new AbortController().signal);
      if (item.action === 'calendar') assert.equal(plan.calendarAction, 'create');
      else if (item.action === 'none') assert.notEqual(plan.deliveryAction, 'confirm');
      else assert.equal(plan.deliveryAction, item.action);
      console.log(`PASS routing ${item.action}`);
    }
    const result = await generator([{ role: 'user', content: '提醒我下周五和 Luke 吃饭。' }], 'calendar', undefined, new AbortController().signal);
    assert.ok('clarification' in result); console.log('PASS incomplete calendar asks for details; real emails: 0');
  } finally { conversation.close(); await jobs.close(); }
}
main().catch(() => { console.error('DELIVERY_EVAL_FAILED (no provider payload or credentials logged)'); process.exitCode = 1; });
