import test from 'node:test';
import assert from 'node:assert/strict';
import { ConditionalTaskDialogue } from '../src/conditional-task-dialogue.js';
import type { DialogueModel, Message, TurnPlan } from '../src/conversation.js';
import type { ConditionalTaskPlanner } from '../src/conditional-task-planner.js';

const now = Date.parse('2026-09-18T14:00:00Z');
const spec = {
  calendarStart: '2026-09-18T12:00-05:00', calendarEnd: '2026-09-18T18:00-05:00',
  activityStart: '2026-09-18T16:30-05:00', activityEnd: '2026-09-18T17:30-05:00',
  timezone: 'America/Chicago', placeQuery: 'family-friendly park', eventTitle: '带孩子去公园', eventNotes: '下班后户外活动',
  scheduleRequested: true, calendarCheckRequested: true, stopOnCalendarConflict: false,
  travelMode: 'drive' as const, pollenSensitivity: []
};

class TaskBase implements DialogueModel {
  plan(): Promise<TurnPlan> { return Promise.resolve({ decision: 'respond', taskAction: 'conditional_task', taskKind: 'outdoor_activity',
    cognitiveMode: 'planning', assistantMode: 'planning', reasoningEffort: 'medium' }); }
  decide() { return Promise.resolve('respond' as const); }
  async reply(_history: Message[], _signal: AbortSignal, delta: (value: string) => void) { delta('ordinary'); }
}

function fixture(calendarItems: any[] = [], confirmError = false, taskSpec = spec, poorAt = '', onPreview?: () => void) {
  let calendarCalls = 0, locationCalls = 0, previewCalls = 0, confirmCalls = 0, providerCalls = 0, dismissCalls = 0;
  let environmentActive = 0, environmentPeak = 0, previewStart = '';
  const pause = async () => { providerCalls++; environmentActive++; environmentPeak = Math.max(environmentPeak, environmentActive);
    await new Promise(resolve => setTimeout(resolve, 15)); environmentActive--; };
  const calendar = {
    query: async () => { calendarCalls++; return { items: calendarItems, complete: true }; },
    preview: async (_kind: string, event: any) => { previewCalls++; previewStart = event.start; onPreview?.();
      return { id: 'preview-id', eventId: 'event-id', phrase: '确认创建', expires: now + 300000,
        preview: `创建·芝加哥时间：带孩子去公园\n${event.start}–${event.end}\n地点：River Park\n说“确认创建”` }; },
    confirm: async () => { confirmCalls++; if (confirmError) throw new Error('network outcome unknown');
      return { state: 'succeeded', kind: 'create', notifyGuests: true }; },
    dismiss: () => { dismissCalls++; }
  };
  const location = { request: async () => { locationCalls++; return { latitude: 41.58, longitude: -93.62, observedAt: now, receivedAt: now, accuracyM: 10 }; },
    cancel: () => {}, clear: () => {} };
  const environment = {
    weather: async (request: any) => { await pause(); return { available: true, hourCount: 1, conditions: ['Clear'], temperatureMinC: 20,
      temperatureMaxC: 22, precipitationMaxPercent: request.start === poorAt ? 90 : 5, thunderstormMaxPercent: 0, windMaxKph: 10, uvMax: 3 }; },
    airQuality: async () => { await pause(); return { available: true, hourCount: 1, indexCode: 'usa_epa', aqiMax: 35, category: 'Good' }; },
    pollen: async () => { await pause(); return { available: true, date: '2026-09-18', tree: { indexAvailable: true, value: 1 },
      grass: { indexAvailable: true, value: 1 }, weed: { indexAvailable: true, value: 1 }, overallValue: 1 }; }
  };
  const routes = { route: async () => { await pause(); return { query: 'family-friendly park', mode: 'drive' as const, trafficAware: true,
    recommendedPlaceId: 'park-1', recommendationBasis: 'fastest' as const, candidates: [{ placeId: 'park-1', name: 'River Park',
      address: '100 Park Ave', rating: 4.6, userRatingCount: 200, durationSeconds: 600, staticDurationSeconds: 580,
      distanceMeters: 5000, quality: { adjustedRating: 4.5, reliable: true, risk: false } }] }; } };
  const planner: ConditionalTaskPlanner = async () => ({ action: 'execute', spec: taskSpec });
  const dialogue = new ConditionalTaskDialogue(new TaskBase(), planner, calendar as any, location as any, routes, environment, () => now);
  return { dialogue, dismissCount: () => dismissCalls,
    stats: () => ({ calendarCalls, locationCalls, previewCalls, confirmCalls, providerCalls, environmentPeak, previewStart }) };
}

async function turn(dialogue: ConditionalTaskDialogue, history: Message[], input: string) {
  const signal = new AbortController().signal;
  const plan = await dialogue.plan(history, input, false, signal);
  let output = '';
  await dialogue.reply([...history, { role: 'user', content: input }], signal, value => { output += value; });
  return { plan, output };
}

test('full conditional task checks calendar, runs evidence concurrently and requires a second-turn write confirmation', async () => {
  const { dialogue, stats } = fixture();
  const first = await turn(dialogue, [], '如果下午没安排，天气不错就找个公园并帮我安排。');
  assert.equal(first.plan.taskAction, 'conditional_task');
  assert.match(first.output, /建议 River Park/);
  assert.equal(stats().previewCalls, 1);
  assert.match(first.output, /确认创建/);
  assert.deepEqual(stats(), { calendarCalls: 1, locationCalls: 1, previewCalls: 1, confirmCalls: 0,
    providerCalls: 4, environmentPeak: 4, previewStart: spec.activityStart });

  const second = await turn(dialogue, [{ role: 'user', content: 'request' }, { role: 'assistant', content: first.output }], '确认创建');
  assert.equal(second.plan.taskAction, 'confirm_conditional');
  assert.match(second.output, /Google 已保存新日程/);
  assert.equal(stats().confirmCalls, 1);
});

test('a busy calendar is checked after planning, moves to a verified slot and rechecks time-sensitive evidence', async () => {
  const { dialogue, stats } = fixture([{ id: 'x', title: '已有会议', start: spec.calendarStart, end: spec.calendarEnd }]);
  const result = await turn(dialogue, [], '如果下午没安排，再帮我找公园。');
  assert.match(result.output, /与“已有会议”冲突.*已改为 2026-09-18 18:00–19:00.*重新核验环境/);
  assert.match(result.output, /确认创建/);
  assert.deepEqual(stats(), { calendarCalls: 2, locationCalls: 1, previewCalls: 1, confirmCalls: 0,
    providerCalls: 7, environmentPeak: 4, previewStart: '2026-09-18T18:00-05:00' });
});

test('an explicit conflict hard stop still plans first but neither reschedules nor previews a write', async () => {
  const { dialogue, stats } = fixture([{ id: 'x', title: '已有会议', start: spec.calendarStart, end: spec.calendarEnd }], false,
    { ...spec, stopOnCalendarConflict: true });
  const result = await turn(dialogue, [], '如果冲突就不用安排。');
  assert.match(result.output, /与“已有会议”冲突.*按你的要求.*没有改时间或创建日程/);
  assert.deepEqual(stats(), { calendarCalls: 1, locationCalls: 1, previewCalls: 0, confirmCalls: 0,
    providerCalls: 4, environmentPeak: 4, previewStart: '' });
});

test('a moved slot is not previewed when its refreshed environment becomes unsuitable', async () => {
  const busy = [{ id: 'x', title: '已有会议', start: spec.calendarStart, end: spec.calendarEnd }];
  const { dialogue, stats } = fixture(busy, false, spec, '2026-09-18T18:00-05:00');
  const result = await turn(dialogue, [], '如果时间冲突就换个合适时间，并帮我安排。');
  assert.match(result.output, /备选 2026-09-18 18:00–19:00 重新核验后.*降雨概率较高.*没有创建日程/);
  assert.deepEqual(stats(), { calendarCalls: 2, locationCalls: 1, previewCalls: 0, confirmCalls: 0,
    providerCalls: 7, environmentPeak: 4, previewStart: '' });
});

test('time-bounded outdoor advice automatically checks the environment without reading Calendar', async () => {
  const { dialogue, stats } = fixture([], false, { ...spec, scheduleRequested: false,
    calendarCheckRequested: false, stopOnCalendarConflict: false });
  const result = await turn(dialogue, [], '明天下午想带孩子去公园散步，帮我看看去哪儿合适。');
  assert.match(result.output, /建议 River Park/);
  assert.match(result.output, /没有创建日程/);
  assert.deepEqual(stats(), { calendarCalls: 0, locationCalls: 1, previewCalls: 0, confirmCalls: 0,
    providerCalls: 4, environmentPeak: 4, previewStart: '' });
});

test('a misheard confirmation keeps the preview but never authorizes the write', async () => {
  const { dialogue, stats } = fixture();
  const first = await turn(dialogue, [], '如果下午没安排，天气不错就找个公园并帮我安排。');
  const history = [{ role: 'user', content: 'request' } as Message, { role: 'assistant', content: first.output } as Message];
  const retry = await turn(dialogue, history, '确认上线');
  assert.match(retry.output, /尚未提交/);
  assert.equal(stats().confirmCalls, 0);
  const confirmed = await turn(dialogue, [...history, { role: 'user', content: '确认上线' }, { role: 'assistant', content: retry.output }], '确认');
  assert.match(confirmed.output, /Google 已保存新日程/);
  assert.equal(stats().confirmCalls, 1);
});

test('an uncertain Calendar write is never replayed and tells the user to verify', async () => {
  const { dialogue, stats } = fixture([], true);
  const first = await turn(dialogue, [], '如果下午没安排，天气不错就找个公园并帮我安排。');
  const history = [{ role: 'user', content: 'request' } as Message, { role: 'assistant', content: first.output } as Message];
  const confirmed = await turn(dialogue, history, '确认创建');
  assert.match(confirmed.output, /结果暂时无法确定.*核对日历.*不会自动重试/);
  assert.equal(stats().confirmCalls, 1);
});

test('a disconnect while a task awaits its preview dismisses it and never revives a connection-bound confirmation', async () => {
  // Revoke the connection-bound approval mid-flight, exactly as the preview is produced,
  // mirroring a transport disconnect while the durable turn keeps running to completion.
  let dialogueRef!: ConditionalTaskDialogue;
  const { dialogue, stats, dismissCount } = fixture([], false, spec, '', () => dialogueRef.invalidate());
  dialogueRef = dialogue;
  const first = await turn(dialogue, [], '如果下午没安排，天气不错就找个公园并帮我安排。');
  assert.equal(stats().previewCalls, 1);            // a preview was produced by the late turn
  assert.equal(dismissCount(), 1);                  // ...but revocation dismissed it
  assert.equal(stats().confirmCalls, 0);
  assert.doesNotMatch(first.output, /确认创建/);     // no confirmation prompt reaches the user
  assert.equal((dialogue as unknown as { pending?: unknown }).pending, undefined); // no revived approval

  // The reviewer's repro: a later "confirm" must not reach calendar.confirm via a revived pending.
  const second = await turn(dialogue, [{ role: 'user', content: 'request' },
    { role: 'assistant', content: first.output }], '确认创建');
  assert.equal(stats().confirmCalls, 0);
  assert.doesNotMatch(second.output, /Google 已保存新日程/);
});
