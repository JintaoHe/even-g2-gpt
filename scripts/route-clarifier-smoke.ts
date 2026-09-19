import 'dotenv/config';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import type { Message, RoutePlaceOption } from '../src/conversation.js';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is required');
const venueResolution = process.argv.includes('--venue-resolution');
const dialogue = createHybridDialogue(key, { ...process.env, OPENAI_WEB_SEARCH: venueResolution ? 'true' : 'false' });
if (venueResolution) {
  const updates: string[] = [];
  const result = await dialogue.model.resolveRoute!('Hot Rods for Heroes car show, Ankeny', [
    { role: 'assistant', content: 'Hot Rods for Heroes 是明天在 Ankeny 举办的临时活动。' }
  ], AbortSignal.timeout(45_000), event => {
    if (event.type === 'search.status') updates.push(event.status);
  });
  console.log(JSON.stringify({ result, searchStatus: updates }, null, 2));
  process.exit(result.action === 'resolved' ? 0 : 1);
}
if (process.argv.includes('--intent-extraction')) {
  const cases = [
    '帮我比较从当前位置去附近两个 Target，默认开车，告诉我车程、拥堵和评分。',
    'On我比较从当前位置去附近两个 target默认开车，然后告诉我车程拥堵和评分，谢谢。',
    'find three nearby coffee shops and compare their walking time and ratings'
  ];
  const plans = [];
  for (const text of cases) plans.push({ text, plan: await dialogue.model.plan!([], text, false, AbortSignal.timeout(30_000)) });
  console.log(JSON.stringify({ plans }, null, 2));
  process.exit(0);
}
if (process.argv.includes('--ambiguous-reply')) {
  const history: Message[] = [
    { role: 'user', content: '附近有哪几家 Target' },
    { role: 'assistant', content: '1. Waukee Target\n2. West Des Moines Target' },
    { role: 'user', content: '带我去刚才那个' }
  ];
  let answer = '';
  await dialogue.model.reply(history, AbortSignal.timeout(30_000), text => { answer += text; }, undefined, 'none');
  console.log(JSON.stringify({ ambiguousReply: answer }, null, 2));
  process.exit(0);
}
const targetPurposes: RoutePlaceOption[] = [
  { name: 'Target', address: '111 Main St, Des Moines, IA', primaryType: 'department_store', types: ['department_store'] },
  { name: 'Target Mobile', address: '111 Main St, Des Moines, IA', primaryType: 'cell_phone_store', types: ['cell_phone_store'] },
  { name: 'Target Parking', address: '111 Main St, Des Moines, IA', primaryType: 'parking_lot', types: ['parking_lot'] }
];

const cases: { name: string; query: string; history: Message[]; options: RoutePlaceOption[] }[] = [
  { name: 'umbrella brand asks', query: 'Target', history: [{ role: 'user', content: '帮我看一下现在去 Target 要多久' }], options: targetPurposes },
  { name: 'explicit parking proceeds', query: 'Target parking lot', history: [{ role: 'user', content: '我就是要去 Target 旁边的停车场' }], options: targetPurposes },
  { name: 'same-purpose branches proceed', query: 'Target stores', history: [{ role: 'user', content: '比较附近的 Target 门店' }], options: [
    { name: 'Target', address: 'Des Moines, IA', primaryType: 'department_store' },
    { name: 'Target', address: 'West Des Moines, IA', primaryType: 'department_store' },
    { name: 'Target', address: 'Waukee, IA', primaryType: 'department_store' }
  ] },
  { name: 'hospital purposes ask', query: 'Mercy', history: [{ role: 'user', content: '去 Mercy 要多久' }], options: [
    { name: 'Mercy Hospital', primaryType: 'hospital' }, { name: 'Mercy Emergency Room', primaryType: 'emergency_room' },
    { name: 'Mercy Parking', primaryType: 'parking_lot' }
  ] },
  { name: 'geographic qualifier selects matching branch', query: 'Target in downtown Des Moines',
    history: [{ role: 'user', content: '我要去 Des Moines Downtown 的 Target' }], options: [
      { name: 'Target', address: 'Des Moines Downtown, IA', primaryType: 'department_store' },
      { name: 'Target', address: 'West Des Moines, IA', primaryType: 'department_store' },
      { name: 'Target', address: 'Ames, IA', primaryType: 'department_store' }
    ] },
  { name: 'explicit bus stop excludes restaurant', query: 'nearest bus stop', history: [{ role: 'user', content: '去最近的公交站' }], options: [
    { name: 'Platform 1', primaryType: 'bus_stop' }, { name: 'Platform 2', primaryType: 'bus_stop' },
    { name: 'The Bus Stop Grill', primaryType: 'restaurant' }
  ] }
];

const results = [];
if (!process.argv.includes('--references')) {
  for (const sample of cases) {
    const result = await dialogue.model.clarifyRoute!(sample.query, sample.options, sample.history, AbortSignal.timeout(30_000));
    results.push({ name: sample.name, result });
  }
}
const references = [];
for (const sample of [
  { name: 'ordinal resolves', history: [
    { role: 'user' as const, content: '比较附近 Target' },
    { role: 'assistant' as const, content: '1. Waukee Target\n2. West Des Moines Target' }
  ], text: '那就去第二家，看看要多久' },
  { name: 'unique recommendation resolves', history: [
    { role: 'user' as const, content: '哪家 Target 更好' },
    { role: 'assistant' as const, content: '建议 Waukee Target：更快且评分更高。' }
  ], text: '那去刚才推荐的那家要多久' },
  { name: 'ambiguous reference does not choose', history: [
    { role: 'user' as const, content: '附近有哪几家 Target' },
    { role: 'assistant' as const, content: '1. Waukee Target\n2. West Des Moines Target' }
  ], text: '带我去刚才那个' }
]) {
  const result = await dialogue.model.plan!(sample.history, sample.text, false, AbortSignal.timeout(30_000));
  references.push({ name: sample.name, result });
}
console.log(JSON.stringify({ clarifications: results, references }, null, 2));
