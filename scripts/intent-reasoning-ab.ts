// Paid live evaluation: synthetic prompts only, no web search, Maps, Calendar writes, mail, microphone, or production ledgers.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import type { Message, ReasoningEffort, TurnPlan } from '../src/conversation.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Missing OPENAI_API_KEY');
const modelName = process.env.OPENAI_INTENT_MODEL ?? 'gpt-5.6-luna';
const common = { adaptiveReasoning: true, deliveryRouting: true, calendarRouting: true, locationRouting: true };
const models = {
  low: new OpenAIDialogue(key, modelName, undefined, false, 10, 'America/Chicago', undefined,
    { ...common, reasoningEffort: 'low', intentTokens: 256 }),
  medium: new OpenAIDialogue(key, modelName, undefined, false, 10, 'America/Chicago', undefined,
    { ...common, reasoningEffort: 'medium', intentTokens: 1024 })
};

type Case = {
  name: string;
  text: string;
  history?: Message[];
  check: (plan: TurnPlan) => boolean;
};
const target = (plan: TurnPlan) => /\btarget\b/i.test(plan.routeDestination ?? '')
  && !/traffic|rating|score|minute|drive|compare|nearby|\u62e5\u5835|\u8bc4\u5206|\u8f66\u7a0b|\u9644\u8fd1|\u6bd4较/i.test(plan.routeDestination ?? '');
const cases: Case[] = [
  {
    name: 'route-clean-target', text: '帮我比较从当前位置去附近两个 Target，默认开车，告诉我车程、拥堵和评分。',
    check: plan => plan.decision === 'respond' && plan.locationAction === 'nearby_search' && target(plan)
      && plan.routeMode === 'drive'
  },
  {
    name: 'route-noisy-target', text: 'On我比较从当前位置去附近两个 target默认开车，然后告诉我车程拥堵和评分，谢谢。',
    check: plan => plan.decision === 'respond' && plan.locationAction === 'nearby_search' && target(plan)
      && plan.routeMode === 'drive'
  },
  {
    name: 'route-code-switch-costco', text: '我现在在 Waukee downtown，帮我 check 去 West Des Moines Costco drive 要多久。',
    check: plan => plan.locationAction === 'route_eta' && /costco/i.test(plan.routeDestination ?? '')
      && /waukee/i.test(plan.routeOrigin ?? '') && plan.routeMode === 'drive' && plan.routeModeExplicit === true
  },
  {
    name: 'route-ambiguous-reference', text: '带我去刚才那个', history: [
      { role: 'user', content: '附近有哪几家 Target' },
      { role: 'assistant', content: '1. Waukee Target\n2. West Des Moines Target' }
    ], check: plan => plan.decision === 'respond' && plan.locationAction === 'none' && plan.routeDestination === null
  },
  {
    name: 'route-explicit-ordinal', text: '那就看第二家，开车多久', history: [
      { role: 'user', content: '附近有哪几家 Target' },
      { role: 'assistant', content: '1. Waukee Target\n2. West Des Moines Target' }
    ], check: plan => plan.decision === 'respond' && plan.locationAction === 'route_eta'
      && /second|2|\u7b2c二|west des moines/i.test(plan.routeDestination ?? '') && plan.routeMode === 'drive'
  },
  {
    name: 'route-purpose-followup', text: '普通 Target 超市，不是 Target Optical。', history: [
      { role: 'user', content: '帮我比较从当前位置去附近两个 Target，默认开车。' },
      { role: 'assistant', content: '你要比较两家 Target 百货店，还是也包括 Target Optical？' }
    ], check: plan => plan.decision === 'respond' && plan.locationAction === 'nearby_search'
      && /target/i.test(plan.routeDestination ?? '') && /store|department|\u8d85市|\u767e货/i.test(plan.routeDestination ?? '')
  },
  {
    name: 'calendar-query', text: '帮我看一下明天有什么活动，备注也告诉我。',
    check: plan => plan.decision === 'respond' && plan.calendarAction === 'query' && plan.deliveryAction === 'none'
  },
  {
    name: 'calendar-recurring-create', text: '从下周六开始，每周六上午九点到十点安排私教课，先按默认三个月处理。',
    check: plan => plan.decision === 'respond' && plan.calendarAction === 'create' && plan.deliveryAction === 'none'
  },
  {
    name: 'calendar-detail', text: '这个会议的备注是什么？sales 会到场吗？', history: [
      { role: 'assistant', content: 'Even 联动测试·2026-10-02 19:00–19:30·测试会议室B' }
    ], check: plan => plan.decision === 'respond' && plan.calendarAction === 'query'
  },
  {
    name: 'calendar-noisy-next-event', text: '可以帮我看一下我下一次 high reps trainin g是什么时候',
    check: plan => plan.decision === 'respond' && plan.calendarAction === 'query'
  },
  {
    name: 'calendar-misheard-confirm', text: '可以，确认上线。', history: [
      { role: 'assistant', content: '创建·芝加哥时间：UI测试\n2026-09-16 22:00–23:00\n地点：园区测试机房\n说“确认创建”' }
    ], check: plan => plan.decision === 'respond' && plan.calendarAction === 'confirm'
  },
  {
    name: 'delivery-document', text: '把我们刚才的路线比较整理成一个 Markdown 文件，生成后先让我确认。',
    check: plan => plan.decision === 'respond' && plan.deliveryAction === 'document'
  },
  {
    name: 'delivery-natural-confirm', text: '好，就把这份发到我的邮箱吧。', history: [
      { role: 'assistant', content: '文件已生成：Target 路线比较.md。确认发送吗？' }
    ], check: plan => plan.decision === 'respond' && plan.deliveryAction === 'confirm'
  },
  {
    name: 'reported-farewell', text: '他刚才跟我说“谢谢拜拜”，这句话听起来礼貌吗？',
    check: plan => plan.decision === 'respond'
  },
  {
    name: 'negated-exit', text: '不要退出，我还要继续问路线。',
    check: plan => plan.decision === 'respond'
  },
  {
    name: 'direct-exit', text: '好的，谢谢，退下吧。',
    check: plan => plan.decision === 'exit' && plan.deliveryAction === 'none'
  },
  {
    name: 'unfinished-calendar', text: '帮我把那个会议改到',
    check: plan => plan.decision === 'wait' && plan.deliveryAction === 'none'
  }
];

type Row = { repeat: number; case: string; effort: 'low' | 'medium'; ok: boolean; ms: number; error?: string; plan?: TurnPlan };
const rows: Row[] = [];
async function run(effort: 'low' | 'medium', sample: Case, repeat: number): Promise<Row> {
  const start = performance.now();
  try {
    const plan = await models[effort].plan(sample.history ?? [], sample.text, false, AbortSignal.timeout(30_000));
    return { repeat, case: sample.name, effort, ok: sample.check(plan), ms: Math.round(performance.now() - start), plan };
  } catch (error) {
    return { repeat, case: sample.name, effort, ok: false, ms: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' };
  }
}

for (let repeat = 1; repeat <= 2; repeat++) {
  for (const sample of cases) {
    const pair = await Promise.all([run('low', sample, repeat), run('medium', sample, repeat)]);
    rows.push(...pair);
    console.log(JSON.stringify(pair.map(({ plan, ...row }) => row)));
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = Object.fromEntries((['low', 'medium'] as const).map(effort => {
  const selected = rows.filter(row => row.effort === effort);
  return [effort, { passed: selected.filter(row => row.ok).length, total: selected.length,
    successRate: selected.filter(row => row.ok).length / selected.length,
    medianMs: median(selected.map(row => row.ms)), p90Ms: percentile(selected.map(row => row.ms), 0.9) }];
}));
const result = { date: new Date().toISOString(), model: modelName, repeats: 2, cases: cases.length,
  configurations: { low: { effort: 'low', maxOutputTokens: 256 }, medium: { effort: 'medium', maxOutputTokens: 1024 } },
  summary, rows };
await mkdir('.local/evals', { recursive: true });
await writeFile('.local/evals/intent-reasoning-ab-latest.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ summary }, null, 2));
if (Object.values(summary).some(item => item.passed !== item.total)) process.exitCode = 1;
