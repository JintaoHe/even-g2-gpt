// Explicit opt-in paid smoke: npm run scene:eval
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import type { AssistantMode, Message } from '../src/conversation.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Set OPENAI_API_KEY in .env');

const { model } = createHybridDialogue(key, {
  ...process.env,
  EVEN_DELIVERY_ROUTING: 'false',
  GOOGLE_CALENDAR_ENABLED: 'false',
  GOOGLE_MAPS_ENABLED: 'false'
}, { search: true });

const cases: { text: string; mode: AssistantMode | AssistantMode[]; search: 'none' | 'search' | Array<'none' | 'search'>; topic: 'same' | 'switch' | 'continue-or-switch' | 'resume-route' }[] = [
  { text: '先帮我规划从 Des Moines 去 Chicago 的路线和出发时间。', mode: 'planning', search: 'search', topic: 'same' },
  { text: '等一下，先 hold 住路线。我有一个 retail business idea，帮我深入分析一下商业逻辑、关键假设和反方风险。', mode: 'deep_reasoning', search: 'none', topic: 'switch' },
  { text: '这个 business idea 先到这里。回到刚才 Chicago 路线的 topic。', mode: ['casual', 'planning'], search: ['none', 'search'], topic: 'resume-route' },
  { text: '路线先暂停。我们深入讨论一下意识是否能还原成物理过程，并考虑反方观点。', mode: 'deep_reasoning', search: 'none', topic: 'switch' },
  { text: '谢谢，深度讨论先结束，我们随便聊两句。', mode: 'casual', search: 'none', topic: 'continue-or-switch' }
];

let history: Message[] = [], current: { id: string; label: string } | undefined, counter = 0;
let routeTopic = '';
for (const item of cases) {
  const plan = await model.plan!(history, item.text, true, new AbortController().signal);
  assert.ok((Array.isArray(item.mode) ? item.mode : [item.mode]).includes(plan.assistantMode!), `${item.text}: unexpected scene ${plan.assistantMode}`);
  assert.ok((Array.isArray(item.search) ? item.search : [item.search]).includes(plan.searchAction!), `${item.text}: unexpected search workflow ${plan.searchAction}`);
  const topics = new Map(history.filter(message => message.topicId && message.topicLabel)
    .map(message => [message.topicId!, { id: message.topicId!, label: message.topicLabel! }]));
  if (plan.topicAction === 'resume' && plan.topicTarget && topics.has(plan.topicTarget)) current = topics.get(plan.topicTarget);
  else if (plan.topicAction === 'switch' || !current) current = { id: `topic-${++counter}`, label: plan.topicLabel || String(item.mode) };
  if (!current) throw new Error('Scene router did not resolve a topic');
  const active = current;
  if (!routeTopic) routeTopic = active.id;
  if (item.topic === 'switch') assert.equal(plan.topicAction, 'switch', `${item.text}: should switch topic`);
  if (item.topic === 'continue-or-switch') assert.ok(['continue', 'switch'].includes(plan.topicAction ?? ''), `${item.text}: unexpected topic action`);
  if (item.topic === 'resume-route') {
    assert.equal(plan.topicAction, 'resume');
    assert.equal(active.id, routeTopic);
  }
  history.push({ role: 'user', content: item.text, topicId: active.id, topicLabel: active.label, assistantMode: plan.assistantMode },
    { role: 'assistant', content: '已记录当前主题。', topicId: active.id, topicLabel: active.label, assistantMode: plan.assistantMode });
  console.log(JSON.stringify({ mode: plan.assistantMode, effort: plan.reasoningEffort, searchAction: plan.searchAction,
    topicAction: plan.topicAction, topicId: active.id, topicLabel: active.label }));
}

model.endSession?.();

// Cross-check the Calendar boundary with the real intent model. Informal itinerary
// planning must stay conversational; explicit personal Calendar actions must route.
const { model: calendarModel } = createHybridDialogue(key, {
  ...process.env,
  EVEN_DELIVERY_ROUTING: 'false',
  GOOGLE_CALENDAR_ENABLED: 'true',
  GOOGLE_MAPS_ENABLED: 'false'
}, { search: true });
const calendarCases = [
  { text: 'conference 在 Spectrum Center，朋友住 Wheatgrass，我该怎么安排住宿和拜访行程？', mode: 'planning', calendar: 'none' },
  { text: '帮我把周五下午三点的 conference 加到 calendar', calendar: ['none', 'create'] },
  { text: '帮我看一下我明天的安排', calendar: 'query' }
] as const;
for (const item of calendarCases) {
  const plan = await calendarModel.plan!([], item.text, true, new AbortController().signal);
  if ('mode' in item) assert.equal(plan.assistantMode, item.mode, `${item.text}: unexpected Calendar-boundary scene`);
  assert.ok((Array.isArray(item.calendar) ? item.calendar : [item.calendar]).includes(plan.calendarAction as any), `${item.text}: unexpected Calendar action`);
  console.log(JSON.stringify({ mode: plan.assistantMode, calendarAction: plan.calendarAction }));
}
calendarModel.endSession?.();

// The retired conditional flag cannot revive the old single-purpose planner.
// Outdoor turns remain flexible planning/research and may select web evidence.
const { model: taskModel } = createHybridDialogue(key, {
  ...process.env,
  EVEN_DELIVERY_ROUTING: 'false',
  GOOGLE_CALENDAR_ENABLED: 'false',
  GOOGLE_MAPS_ENABLED: 'true',
  EVEN_CONDITIONAL_TASKS_ENABLED: 'true'
}, { search: true });
const taskHistory: Message[] = [
  { role: 'user', content: '明天下午六点半带孩子去公园。', topicId: 'topic-park', topicLabel: '公园安排', assistantMode: 'planning' },
  { role: 'assistant', content: '建议 Triangle Park，天气适合，没有创建日程。', topicId: 'topic-park', topicLabel: '公园安排', assistantMode: 'planning' }
];
const taskCases = [
  { text: '为什么推荐这个公园？里面有什么好玩的？', mode: 'research', search: 'search', location: 'none' },
  { text: '等一下，我有一个 retail business idea，帮我分析商业模式。', mode: ['planning', 'deep_reasoning'] as AssistantMode[], search: 'none', location: 'none' },
  { text: '先不聊 business。意识能不能还原成物理过程？请分析正反观点。', mode: 'deep_reasoning', search: 'none', location: 'none' },
  { text: '从我现在的位置开车去 Triangle Park 要多久？', mode: 'explain', search: 'none', location: 'route_eta' },
  { text: '把公园活动换到晚上八点，重新检查天气并帮我安排。', mode: 'planning', search: 'search', location: 'none' }
] as const;
for (const item of taskCases) {
  const plan = await taskModel.plan!(taskHistory, item.text, true, new AbortController().signal);
  assert.ok((Array.isArray(item.mode) ? item.mode : [item.mode]).includes(plan.assistantMode!), `${item.text}: unexpected mode ${plan.assistantMode}`);
  assert.equal(plan.searchAction, item.search, `${item.text}: unexpected search workflow`);
  assert.equal(plan.taskAction, undefined, `${item.text}: retired conditional task must stay disabled`);
  assert.equal(plan.locationAction, item.location, `${item.text}: unexpected location action`);
  console.log(JSON.stringify({ mode: plan.assistantMode, searchAction: plan.searchAction, locationAction: plan.locationAction }));
}
const itineraryHistory: Message[] = [
  { role: 'user', content: '明天九点出发，先去 Ames 取包裹，再去 downtown brunch，最后去公园一小时。', topicId: 'topic-itinerary', topicLabel: 'Ames 行程', assistantMode: 'planning' },
  { role: 'assistant', content: '请确认取包裹的公共地点。', topicId: 'topic-itinerary', topicLabel: 'Ames 行程', assistantMode: 'planning' }
];
const itinerary = await taskModel.plan!(itineraryHistory, '我不记得具体地点了，就以 Ames 的 DMV 为标准吧。', true,
  new AbortController().signal);
assert.equal(itinerary.assistantMode, 'planning');
assert.equal(itinerary.searchAction, 'search');
assert.equal(itinerary.taskAction, undefined);
assert.equal(itinerary.locationAction, 'none');
console.log(JSON.stringify({ case: 'multi-stop itinerary', mode: itinerary.assistantMode,
  searchAction: itinerary.searchAction, taskAction: itinerary.taskAction, locationAction: itinerary.locationAction }));
const cityRecommendation = await taskModel.plan!([], '我明天去 Ames，那里有什么 brunch 推荐吗？', true,
  new AbortController().signal);
assert.equal(cityRecommendation.locationAction, 'none');
assert.equal(cityRecommendation.searchAction, 'search');
const routeOriginHistory: Message[] = [
  { role: 'user', content: 'Ames 我们去 Provisions Lot F 吃 brunch。' },
  { role: 'assistant', content: '好，已选 Provisions Lot F。' }
];
const contextualOrigin = await taskModel.plan!(routeOriginHistory,
  '从餐厅出发到 Ada Hayden Heritage Park 开车多久？', true, new AbortController().signal);
assert.equal(contextualOrigin.locationAction, 'route_eta');
assert.match(contextualOrigin.routeOrigin ?? '', /Provisions Lot F/i);
assert.match(contextualOrigin.routeDestination ?? '', /Ada Hayden Heritage Park/i);
console.log(JSON.stringify({ case: 'contextual route origin', origin: contextualOrigin.routeOrigin,
  destination: contextualOrigin.routeDestination }));
taskModel.endSession?.();
console.log(JSON.stringify({ smoke: true, cases: cases.length + calendarCases.length + taskCases.length + 3 }));
