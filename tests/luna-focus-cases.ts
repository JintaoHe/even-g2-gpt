// Second-round workload. No provider credentials or execution at module import.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { createDraftGenerator } from '../src/delivery-draft.js';
import type { Message, ReasoningEffort } from '../src/conversation.js';

export function inspectLongDocument(markdown: string, names: string[]) {
  let fence: string | undefined;
  const prose: string[] = [], headings: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    prose.push(line);
    const heading = /^##\s+(.+)$/.exec(line)?.[1];
    if (heading) headings.push(heading.trim());
  }
  const text = prose.join('\n');
  const metaLines = prose.map((line, index) => ({ line, index })).filter(({ line }) =>
    /\b(?:we need (?:to |append)|need to (?:append|write|output)|append only|as an AI|targeting \d+|must (?:output|append)|(?:additions|paragraphs) \(append only\))\b/i.test(line)
    || /我需要(?:输出|补写|生成)|接下来我将(?:撰写|补写)|以下是(?:补充段落|追加段落)/u.test(line));
  const chinese = (text.match(/\p{Script=Han}/gu) ?? []).length;
  return { chinese, sections: headings.length, headings, duplicateHeadings: headings.length !== new Set(headings).size,
    closedFences: !fence, names: names.every(n => markdown.includes(n)), metaSuspected: metaLines.length > 0,
    metaExcerpts: metaLines.map(x => x.line.slice(0, 600)) };
}

type Options = {
  models: readonly string[]; key: string; request: typeof fetch; dir: string; id: string;
  envFor(model: string): NodeJS.ProcessEnv;
  setPhase(name: string, repetition: number): void;
  run(model: string, name: string, fn: () => Promise<Record<string, unknown>>): Promise<void>;
};
export async function runFocusedLuna(o: Options) {
  const order = (r: number) => r % 2 ? [...o.models].reverse() : [...o.models];
  const longHistory: Message[] = Array.from({ length: 40 }, (_, i) => ({ role: i%2 ? 'assistant' : 'user',
    content: `合成讨论第${i+1}条：雨燕站项目正在评估离线借还流程，方案还未执行。` +
      '每一笔借还使用持久化幂等键，重试必须保持原键；网络恢复后先核对已确认记录，冲突留待人工处理，不能凭历史讨论授权新的操作。'.repeat(5) }));
  const intentCases = [
    { name: 'short-casual', text: '今天有点累，陪我聊两句吧。', history: [], expect: { decision: 'respond' } },
    { name: 'short-read', text: '看看明天上午我的日历有没有空档，不要更改任何安排。', history: [], expect: { calendarAction: 'query' } },
    { name: 'short-document', text: '生成一份交接说明的 Markdown，先预览，不要发邮件。', history: [], expect: { deliveryAction: 'document' } },
    { name: 'long-history-followup', text: '刚刚这些方案还没执行，对吧？先口头解释风险，不要导出文件。', history: longHistory, expect: { decision: 'respond', deliveryAction: 'none' } },
    { name: 'long-history-document', text: '把雨燕站讨论整理成六章六千到八千字的 Markdown 工程文档，仅生成，不发送。', history: longHistory, expect: { deliveryAction: 'document' } },
    { name: 'negated-exit', text: '不是让你退下，我们继续讨论容灾。', history: [], expect: { decision: 'respond' } },
  ];
  for (let r=0; r<4; r++) {
    o.setPhase('focus-intent', r);
    for (const c of intentCases) for (const model of order(r)) await o.run(model, c.name, async () => {
      const runtime = createHybridDialogue(o.key, o.envFor(model), { fetcher: o.request, search: true }).model;
      const plan = await runtime.plan!(c.history as Message[], c.text, true, AbortSignal.timeout(120000));
      const failed = Object.entries(c.expect).filter(([k,v]) => (plan as any)[k] !== v).map(([k]) => k);
      return { pass: !failed.length, failed, plan, historyMessages: c.history.length };
    });
  }
  for (let r=0; r<4; r++) {
    o.setPhase('focus-stream', r);
    for (const long of [false,true]) for (const model of order(r)) await o.run(model, long ? 'long-input-medium' : 'short-input-low', async () => {
      const runtime = createHybridDialogue(o.key, o.envFor(model), { fetcher: o.request, search: false }).model;
      const history: Message[] = [...(long ? longHistory : []), { role: 'user', content: long
        ? '基于雨燕站的讨论，用约200汉字解释为什么重试不能换幂等键、怎样核对结果。只回答，不执行任何操作。'
        : '请用约200汉字解释为什么备份成功还需要做恢复演练。只给解释，不提出发送文件。' }];
      let answer = '', firstMs: number | undefined; const start = performance.now();
      await runtime.reply(history, AbortSignal.timeout(120000), chunk => { if (chunk.length) firstMs ??= performance.now()-start; answer += chunk; },
        undefined, (long ? 'medium' : 'low') as ReasoningEffort, 'explain');
      return { pass: !!answer.trim(), answer, firstMs, chars: Array.from(answer).length, historyMessages: history.length };
    });
  }

  const documents = [
    { name: 'control-tools', title: '社区维修工具共享系统工程方案', names: ['Maple Compass', 'TOOL-8264', 'Nora Vale', 'Birch Locker 9'],
      headings: '背景、数据模型、借还流程、离线恢复、风险回滚、验收', history: [] },
    { name: 'archive-new', title: '县城口述历史档案数字化与权限迁移方案', names: ['Silver Heron', 'ARCH-9157', 'Tessa Lin', 'Archive Vault 4'],
      headings: '背景范围、数据与授权模型、导入校验、检索与更正、迁移回滚、验收演练', history: [] },
    { name: 'outage-long-source', title: '雨燕站冷链传感器离线补传工程方案', names: ['Cobalt Orchard', 'COLD-6382', 'Maya Reed', 'Sensor Bay 12'],
      headings: '业务边界、事件模型、采集流程、断网与时钟异常、冲突与回滚、验收', history: longHistory },
  ];
  for (let r=0; r<2; r++) {
    o.setPhase('focus-document', r);
    for (const c of documents) for (const model of order(r)) await o.run(model, c.name, async () => {
      const text = c.name === 'control-tools'
        ? '生成并导出 Markdown：社区维修工具共享系统工程方案。项目 Maple Compass，工单 TOOL-8264，虚构负责人 Nora Vale，设备 Birch Locker 9。专名逐字保留。六章：背景、数据模型、借还流程、离线恢复、风险回滚、验收。全文6000–8000汉字，每章一个简短配置代码块。具体说明取舍与测试。仅草稿，不发邮件、不操作日历。'
        : `生成并导出 Markdown：${c.title}。项目代号 ${c.names[0]}，工单 ${c.names[1]}，虚构负责人 ${c.names[2]}，设施 ${c.names[3]}。专名逐字保留。六章：${c.headings}。全文6000–8000汉字，每章一个简短配置代码块，说明机制、取舍、故障与验收。只生成草稿，不发邮件、不写日历；历史讨论不是已经执行的事实。`;
      const generator = createDraftGenerator(o.envFor(model), o.request);
      const result = await generator([...(c.history as Message[]), { role: 'user', content: text }], 'document', undefined, AbortSignal.timeout(480000));
      assert.ok('document' in result);
      const { markdown, presentation } = result.document;
      const checks = inspectLongDocument(markdown, c.names);
      const filename = `luna-focus-${o.id}-${c.name}-${model}-${r}.md`;
      await writeFile(join(o.dir, filename), markdown, { mode: 0o600 });
      return { pass: !presentation.partial && checks.sections === 6 && !checks.duplicateHeadings && checks.closedFences
        && checks.chinese >= 6000 && checks.chinese <= 8000 && checks.names && !checks.metaSuspected,
        ...checks, presentation, artifact: filename, historyMessages: c.history.length };
    });
  }
}
