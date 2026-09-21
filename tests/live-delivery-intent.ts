// Opt-in classifier-only eval: no reply generation, SMTP, Calendar, or production socket.
import 'dotenv/config';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import type { Message } from '../src/conversation.js';

const libraryRequest = '请帮我生成一份工程方案文档：社区图书馆借阅系统改造方案。要求六章，总长六千到八千字。项目代号 Cedar Lantern，工单 LIB-7042，负责人 Mira Chen，涉及 Orion Shelf 7 书架区。六章：背景与问题、现状分析、目标架构、实施计划、风险与回滚、验收标准，每章含具体技术细节和一段示例配置。';
const preview: Message[] = [{ role: 'assistant', content: '文件已生成：方案.md。发送到固定邮箱？说确认发送或取消发送。' }];
const cases: { id: string; text: string; expected: string; history?: Message[] }[] = [
  // Reconstructed from the owner's abbreviated first request, not claimed verbatim.
  { id: 'reported-preview-only', text: libraryRequest + '生成后先给我预览，不要直接发送邮件。', expected: 'document' },
  { id: 'positive-export-control', text: libraryRequest.replace('生成一份工程方案文档', '生成并导出一份 Markdown 工程方案文档'), expected: 'document' },
  // Comparison wording was not supplied verbatim; representative paired regression.
  { id: 'comparison-workload', text: '这台服务器偶尔生成长文档，比较 2GB 和 4GB，哪个适合我？', expected: 'none' },
  { id: 'comparison-explicit-artifact', text: '把 2GB 和 4GB 服务器的比较写成 Markdown 文档，先预览，不要发送。', expected: 'document' },
  { id: 'english-preview-only', text: 'Create a Markdown engineering plan for a library. Show me a preview first; do not email it yet.', expected: 'document' },
  { id: 'pending-cancel', history: preview, text: '不要发送邮件，取消发送。', expected: 'cancel' },
  { id: 'pending-revise-no-send', history: preview, text: '把方案的风险部分补充一下，先给我预览，不要发送。', expected: 'revise' },
  { id: 'negated-generation', text: '不要生成文档，只口头解释一下 2GB 和 4GB 的区别。', expected: 'none' }
];

async function main() {
  if (process.env.RUN_LIVE_DELIVERY_INTENT !== '1') throw Error('Opt-in required');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw Error('Missing key');
  const { model, models } = createHybridDialogue(key, {
    ...process.env, EVEN_DELIVERY_ROUTING: 'true', GOOGLE_CALENDAR_ENABLED: 'false',
    GOOGLE_MAPS_ENABLED: 'false', EVEN_EMAIL_ENABLED: 'false'
  }, { search: false });
  let failed = 0;
  try {
    for (const item of cases) {
      const start = Date.now();
      try {
        const plan = await model.plan!(item.history ?? [], item.text, true, AbortSignal.timeout(45000));
        const pass = plan.deliveryAction === item.expected && plan.decision === 'respond';
        if (!pass) failed++;
        console.log(JSON.stringify({ id: item.id, model: models.intent, expected: item.expected,
          actual: plan.deliveryAction, decision: plan.decision, pass, elapsedMs: Date.now() - start }));
      } catch {
        failed++;
        console.log(JSON.stringify({ id: item.id, pass: false, error: 'CLASSIFIER_REQUEST_FAILED' }));
      }
    }
  } finally { model.endSession?.(); }
  console.log(JSON.stringify({ cases: cases.length, failed, emails: 0, calendarWrites: 0, documents: 0 }));
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error('LIVE_DELIVERY_INTENT_SETUP_FAILED'); process.exitCode = 1; });
