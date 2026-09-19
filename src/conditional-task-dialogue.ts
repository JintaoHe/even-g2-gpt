import type { AssistantMode, DialogueModel, Message, ReplyUpdate, ReasoningEffort, TurnPlan, WorkflowSelection } from './conversation.js';
import type { ConditionalOutdoorSpec, ConditionalTaskPlanner } from './conditional-task-planner.js';
import type { EnvironmentProvider, EnvironmentRequest, WeatherEvidence, AirQualityEvidence, PollenEvidence } from './environment.js';
import { EnvironmentError } from './environment.js';
import type { GoogleCalendarService, CalendarItem } from './google-calendar.js';
import type { LocationRequestBroker } from './location.js';
import type { RouteProvider, RouteComparisonResult } from './routes.js';
import { RouteError } from './routes.js';
import { validateCalendar } from './calendar.js';
import { suggestCalendarSlot, zonedMinute } from './calendar-slots.js';
import { calendarConfirmed, calendarConfirmationAttempt } from './calendar-preview.js';
import { assessOutdoor, type OutdoorDecision } from './outdoor-decision.js';
import { ConditionalTaskOrchestrator, createTaskState, newTaskId,
  type JsonScalar, type JsonValue, type TaskPlan, type TaskState, type TaskToolRegistry } from './task-orchestrator.js';

type CalendarTaskService = Pick<GoogleCalendarService, 'query' | 'preview' | 'confirm' | 'dismiss'>;
type LocationSource = Pick<LocationRequestBroker, 'request' | 'cancel' | 'clear'>;
type Pending = { plan: TaskPlan; state: TaskState; orchestrator: ConditionalTaskOrchestrator;
  prompt: string; phrase: string; expires: number; previewId: string };
type PlanContext = { plan: TurnPlan; text: string; pending?: Pending };

const emptyInput = (input: Readonly<Record<string, JsonValue>>) => {
  if (Object.keys(input).length) throw new Error('TASK_INPUT_INVALID');
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown, limit = 300) => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit) : '';
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')); };
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});

async function environmentRead<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | { available: false; error: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await operation(); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof EnvironmentError) || !error.retryable || attempt === 2) {
        return { available: false, error: error instanceof EnvironmentError ? error.code : 'ENVIRONMENT_UNAVAILABLE' };
      }
      await sleep(250, signal);
    }
  }
  return { available: false, error: 'ENVIRONMENT_UNAVAILABLE' };
}

function buildRegistry(spec: ConditionalOutdoorSpec, services: {
  calendar: CalendarTaskService; location: LocationSource; routes: RouteProvider; environment: EnvironmentProvider;
}, now: () => number): TaskToolRegistry {
  const environmentRequest = (dependencies: Record<string, Readonly<Record<string, JsonValue>>>,
    start = spec.activityStart, end = spec.activityEnd): EnvironmentRequest => {
    const location = record(dependencies.location);
    if (location.available !== true || number(location.latitude) === undefined || number(location.longitude) === undefined) throw new Error('LOCATION_UNAVAILABLE');
    return { location: { latitude: location.latitude, longitude: location.longitude }, start,
      end, timezone: spec.timezone, language: 'zh-CN' };
  };
  const selectedPlace = (places: Record<string, any>) => {
    const candidates = Array.isArray(places.candidates) ? places.candidates : [];
    return record(candidates.find(candidate => record(candidate).placeId === places.recommendedPlaceId) ?? candidates[0]);
  };
  const evaluate = (weather: WeatherEvidence, air: AirQualityEvidence, pollen: PollenEvidence,
    places: Record<string, any>) => {
    const decision = assessOutdoor(weather, air, pollen, { pollenSensitivity: spec.pollenSensitivity, requireAirQuality: true });
    const recommend = places.available === true && decision.suitability !== 'poor' && decision.suitability !== 'unknown'
      && decision.confidence !== 'low';
    return { ...decision, recommend, schedule: recommend && spec.scheduleRequested };
  };
  const eventFor = (places: Record<string, any>, start: string, end: string) => {
    const chosen = selectedPlace(places), location = text(chosen.address, 200) || text(chosen.name, 160);
    if (!location) throw new Error('PLACE_SELECTION_INVALID');
    return validateCalendar({ title: spec.eventTitle, start, end, timezone: spec.timezone,
      allDay: false, location, notes: spec.eventNotes });
  };
  const overlaps = (item: CalendarItem, start: string, end: string) => item.start.includes('T')
    ? Date.parse(item.start) < Date.parse(end) && Date.parse(item.end) > Date.parse(start)
    : item.start <= end.slice(0, 10) && item.end > start.slice(0, 10);
  return {
    location_once: { risk: 'sensitive_read', timeoutMs: 30_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (_context, signal) => {
        try {
          const value = await services.location.request(signal); signal.throwIfAborted();
          return { available: true, latitude: value.latitude, longitude: value.longitude,
            ...(value.accuracyM === undefined ? {} : { accuracyM: Math.round(value.accuracyM) }) };
        } catch { signal.throwIfAborted(); return { available: false }; }
      } },
    weather_read: { risk: 'read', timeoutMs: 25_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => json(await environmentRead(
        () => services.environment.weather(environmentRequest(context.dependencyOutputs), signal), signal)) },
    air_quality_read: { risk: 'read', timeoutMs: 25_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => json(await environmentRead(
        () => services.environment.airQuality(environmentRequest(context.dependencyOutputs), signal), signal)) },
    pollen_read: { risk: 'read', timeoutMs: 25_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => json(await environmentRead(
        () => services.environment.pollen(environmentRequest(context.dependencyOutputs), signal), signal)) },
    places_route: { risk: 'read', timeoutMs: 45_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => {
        const location = environmentRequest(context.dependencyOutputs).location;
        try {
          const observedAt = now();
          const result = await services.routes.route({ origin: { kind: 'coordinates', location: {
            ...location, observedAt, receivedAt: observedAt
          } }, destination: spec.placeQuery, mode: spec.travelMode, kind: 'nearby' }, signal);
          return json({ available: true, ...result });
        } catch (error) {
          signal.throwIfAborted();
          return { available: false, error: error instanceof RouteError ? error.code : 'ROUTE_UNAVAILABLE' };
        }
      } },
    outdoor_decision: { risk: 'read', timeoutMs: 5_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async context => {
        const weather = record(context.dependencyOutputs.weather) as unknown as WeatherEvidence;
        const air = record(context.dependencyOutputs.air) as unknown as AirQualityEvidence;
        const pollen = record(context.dependencyOutputs.pollen) as unknown as PollenEvidence;
        const places = record(context.dependencyOutputs.places);
        return json(evaluate(weather, air, pollen, places));
      } },
    calendar_fit: { risk: 'sensitive_read', timeoutMs: 45_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => {
        const event = eventFor(record(context.dependencyOutputs.places), spec.activityStart, spec.activityEnd);
        signal.throwIfAborted();
        const exact = await services.calendar.query(event.start, event.end, event.timezone);
        signal.throwIfAborted();
        if (!exact.complete) throw new Error('CALENDAR_INCOMPLETE');
        const matching = exact.items.filter(item => overlaps(item, event.start, event.end));
        const conflicts = matching.slice(0, 2).map(item => text(item.title, 80)).filter(Boolean);
        if (!matching.length) return json<Record<string, JsonValue>>({ canProceed: true, adjusted: false, needsRecheck: false,
          start: event.start, end: event.end, conflicts: [] });
        if (spec.stopOnCalendarConflict) return json<Record<string, JsonValue>>({ canProceed: false, adjusted: false, needsRecheck: false,
          start: event.start, end: event.end, conflicts, reason: 'hard_stop' });
        const environmentalLimit = now() + 5 * 86400_000;
        const horizonEnd = Math.min(Date.parse(event.start) + 48 * 3600_000, environmentalLimit);
        if (horizonEnd <= Date.parse(event.end)) return json<Record<string, JsonValue>>({ canProceed: false, adjusted: false, needsRecheck: false,
          start: event.start, end: event.end, conflicts, reason: 'no_alternative' });
        const horizon = await services.calendar.query(event.start, zonedMinute(horizonEnd, event.timezone), event.timezone);
        signal.throwIfAborted();
        if (!horizon.complete) throw new Error('CALENDAR_INCOMPLETE');
        const alternative = suggestCalendarSlot(event, horizon.items, '__conditional_new__');
        if (!alternative || Date.parse(alternative.end) > environmentalLimit) return json<Record<string, JsonValue>>({ canProceed: false, adjusted: false,
          needsRecheck: false, start: event.start, end: event.end, conflicts, reason: 'no_alternative' });
        return json<Record<string, JsonValue>>({ canProceed: true, adjusted: true, needsRecheck: true,
          start: alternative.start, end: alternative.end, conflicts });
      } },
    finalize_outdoor: { risk: 'read', timeoutMs: 30_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => {
        const fit = record(context.dependencyOutputs.calendar_fit), start = text(fit.start, 40), end = text(fit.end, 40);
        if (!start || !end) throw new Error('CALENDAR_FIT_INVALID');
        const initial = record(context.dependencyOutputs.decision), places = record(context.dependencyOutputs.places);
        if (fit.needsRecheck !== true) return json({ ...initial, start, end, adjusted: false,
          conflicts: Array.isArray(fit.conflicts) ? fit.conflicts : [], weather: record(context.dependencyOutputs.weather),
          air: record(context.dependencyOutputs.air), pollen: record(context.dependencyOutputs.pollen) });
        const request = environmentRequest(context.dependencyOutputs, start, end);
        const [weather, air, pollen] = await Promise.all([
          environmentRead(() => services.environment.weather(request, signal), signal),
          environmentRead(() => services.environment.airQuality(request, signal), signal),
          environmentRead(() => services.environment.pollen(request, signal), signal)
        ]);
        signal.throwIfAborted();
        const final = evaluate(weather as WeatherEvidence, air as AirQualityEvidence, pollen as PollenEvidence, places);
        return json({ ...final, start, end, adjusted: true,
          conflicts: Array.isArray(fit.conflicts) ? fit.conflicts : [], weather, air, pollen });
      } },
    calendar_preview: { risk: 'preview', timeoutMs: 45_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => {
        const final = record(context.dependencyOutputs.finalize), start = text(final.start, 40), end = text(final.end, 40);
        if (!start || !end) throw new Error('CALENDAR_FIT_INVALID');
        const event = eventFor(record(context.dependencyOutputs.places), start, end);
        const preview = await services.calendar.preview('create', event, undefined, undefined, true); signal.throwIfAborted();
        return { operationId: preview.id, phrase: preview.phrase, expires: preview.expires, preview: preview.preview };
      } },
    calendar_commit: { risk: 'write', timeoutMs: 45_000, maxAttempts: 1, validateInput: emptyInput,
      execute: async (context, signal) => {
        const preview = record(context.dependencyOutputs.preview);
        const operationId = text(preview.operationId, 100), phrase = text(preview.phrase, 30);
        if (!operationId || !phrase) throw new Error('CALENDAR_PREVIEW_INVALID');
        signal.throwIfAborted();
        const result = await services.calendar.confirm(operationId, phrase);
        return { state: result.state, kind: result.kind, notifyGuests: !!result.notifyGuests,
          ...(result.error ? { error: text(result.error, 80) } : {}) };
      } }
  };
}

function compilePlan(spec: ConditionalOutdoorSpec): TaskPlan {
  const condition = (nodeId: string, field: string, equals: JsonScalar) => ({ nodeId, field, equals });
  const empty = {};
  const nodes: TaskPlan['nodes'] = [
    { id: 'location', tool: 'location_once', dependsOn: [], condition: null, input: empty },
    { id: 'weather', tool: 'weather_read', dependsOn: ['location'], condition: condition('location', 'available', true), input: empty },
    { id: 'air', tool: 'air_quality_read', dependsOn: ['location'], condition: condition('location', 'available', true), input: empty },
    { id: 'pollen', tool: 'pollen_read', dependsOn: ['location'], condition: condition('location', 'available', true), input: empty },
    { id: 'places', tool: 'places_route', dependsOn: ['location'], condition: condition('location', 'available', true), input: empty },
    { id: 'decision', tool: 'outdoor_decision', dependsOn: ['weather', 'air', 'pollen', 'places'], condition: null, input: empty }
  ];
  if (spec.calendarCheckRequested || spec.scheduleRequested) nodes.push(
    { id: 'calendar_fit', tool: 'calendar_fit', dependsOn: ['decision', 'places'],
      condition: condition('decision', 'recommend', true), input: empty },
    { id: 'finalize', tool: 'finalize_outdoor', dependsOn: ['calendar_fit', 'decision', 'weather', 'air', 'pollen', 'places', 'location'],
      condition: condition('calendar_fit', 'canProceed', true), input: empty }
  );
  if (spec.scheduleRequested) nodes.push(
    { id: 'preview', tool: 'calendar_preview', dependsOn: ['finalize', 'places'],
      condition: condition('finalize', 'schedule', true), input: empty },
    { id: 'commit', tool: 'calendar_commit', dependsOn: ['preview'], condition: null, input: empty }
  );
  return { id: newTaskId(), version: 1,
    goal: 'Plan an outdoor option, validate Calendar fit, recheck time-sensitive evidence after any time change, and preview scheduling when requested.',
    nodes };
}

const issueLabels: Record<string, string> = {
  weather_unavailable: '天气数据不可用', air_quality_unavailable: '空气质量不可用', pollen_unavailable_for_sensitive_user: '花粉数据不可用',
  thunderstorm_risk: '有雷暴风险', thunderstorm_possible: '可能有雷暴', heavy_precipitation_risk: '降雨概率较高',
  precipitation_possible: '可能下雨', cold_exposure: '体感温度过低', cool_conditions: '天气偏凉', heat_exposure: '体感温度过高',
  warm_conditions: '天气偏热', strong_wind: '风力较强', windy: '风较大', high_uv: '紫外线较强',
  air_quality_unhealthy: '空气质量不健康', air_quality_sensitive_groups: '敏感人群需留意空气质量', pollen_high: '花粉较高',
  tree_pollen_unknown: '树木花粉未知', grass_pollen_unknown: '草花粉未知', weed_pollen_unknown: '杂草花粉未知',
  tree_pollen_high_for_sensitive_user: '树木花粉对你偏高', grass_pollen_high_for_sensitive_user: '草花粉对你偏高',
  weed_pollen_high_for_sensitive_user: '杂草花粉对你偏高', tree_pollen_moderate_for_sensitive_user: '树木花粉中等',
  grass_pollen_moderate_for_sensitive_user: '草花粉中等', weed_pollen_moderate_for_sensitive_user: '杂草花粉中等'
};
const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))}分钟`;
const distance = (meters: number) => `${(meters / 1609.344).toFixed(meters < 16093 ? 1 : 0)}英里`;
const compactTime = (value: string, timezone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(item => [item.type, item.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const compactSlot = (start: string, end: string, timezone: string) => {
  const a = compactTime(start, timezone), b = compactTime(end, timezone);
  return a.day === b.day ? `${a.day} ${a.time}–${b.time}` : `${a.day} ${a.time}–${b.day} ${b.time}`;
};

function summarize(spec: ConditionalOutdoorSpec, state: TaskState) {
  const output = (id: string) => record(state.nodes[id]?.output);
  if (state.nodes.location?.status === 'succeeded' && output('location').available === false) {
    return '没有取得当前位置。请说出或在手机上输入出发地址，我可以继续评估。';
  }
  const initial = output('decision') as unknown as OutdoorDecision & { recommend?: boolean; schedule?: boolean };
  if (!initial.suitability) return '这次条件任务没有收集到足够信息，尚未创建日程。请稍后重试。';
  const places = output('places') as unknown as RouteComparisonResult & { available?: boolean };
  const candidates = Array.isArray(places.candidates) ? places.candidates : [];
  const selected = candidates.find(candidate => candidate.placeId === places.recommendedPlaceId) ?? candidates[0];
  const fit = output('calendar_fit');
  const conflicts = Array.isArray(fit.conflicts) ? fit.conflicts.map(value => text(value, 40)).filter(Boolean) : [];
  if (fit.canProceed === false) {
    const label = conflicts.length ? `与“${conflicts.join('、')}”冲突` : '与现有日程冲突';
    return fit.reason === 'hard_stop'
      ? `原计划时段${label}。按你的要求，没有改时间或创建日程。`
      : `原计划时段${label}，未来两天内没有找到可核验的合适空档。没有创建日程。`;
  }
  const final = output('finalize');
  const decision = (final.suitability ? final : initial) as unknown as OutdoorDecision & { recommend?: boolean; schedule?: boolean;
    start?: string; end?: string; adjusted?: boolean };
  const issues = Array.isArray(decision.issues) ? decision.issues.map(issue => issueLabels[issue.code] ?? issue.code).slice(0, 2) : [];
  if (!decision.recommend || !selected) {
    const changed = decision.adjusted && decision.start && decision.end
      ? `原时段${conflicts.length ? `与“${conflicts.join('、')}”冲突，` : '有冲突，'}备选 ${compactSlot(decision.start, decision.end, spec.timezone)} 重新核验后，` : '';
    return `${changed}暂不建议安排这次户外活动：${issues.join('；') || '环境或地点信息不足'}。没有创建日程。`;
  }
  const weather = final.weather ? record(final.weather) : output('weather');
  const air = final.air ? record(final.air) : output('air');
  const pollen = final.pollen ? record(final.pollen) : output('pollen');
  const evidence: string[] = [];
  const low = number(weather.temperatureMinC), high = number(weather.temperatureMaxC);
  if (low !== undefined && high !== undefined) evidence.push(`${Math.round(low)}–${Math.round(high)}°C`);
  const rain = number(weather.precipitationMaxPercent); if (rain !== undefined) evidence.push(`降雨${Math.round(rain)}%`);
  const aqi = number(air.aqiMax); if (aqi !== undefined) evidence.push(`AQI ${Math.round(aqi)}`);
  const pollenValue = number(pollen.overallValue); if (pollenValue !== undefined) evidence.push(`花粉${Math.round(pollenValue)}/5`);
  const lines: string[] = [];
  if (decision.adjusted && decision.start && decision.end) lines.push(
    `原时段${conflicts.length ? `与“${conflicts.join('、')}”冲突，` : '有冲突，'}已改为 ${compactSlot(decision.start, decision.end, spec.timezone)}，并重新核验环境。`);
  lines.push(`建议 ${text(selected.name, 55)}：${minutes(selected.durationSeconds)}，${distance(selected.distanceMeters)}。`,
    `${evidence.join(' · ') || '环境数据有限'}${issues.length ? `；${issues.join('、')}` : ''}。`);
  const preview = output('preview');
  if (text(preview.preview, 1200)) lines.push(text(preview.preview, 1200));
  else if (!decision.schedule) lines.push('没有创建日程。');
  return lines.join('\n');
}

export class ConditionalTaskDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, PlanContext>();
  private pending?: Pending;
  constructor(private base: DialogueModel, private planner: ConditionalTaskPlanner,
    private calendar: CalendarTaskService, private location: LocationSource, private routes: RouteProvider,
    private environment: EnvironmentProvider, private now = Date.now) {}

  startSession() { this.clearPending(); }
  endSession() { this.clearPending(); this.location.cancel(); this.location.clear(); }
  invalidate() { this.clearPending(); this.location.cancel(); }
  private clearPending() {
    if (this.pending) {
      this.pending.orchestrator.cancel(this.pending.state);
      this.calendar.dismiss(this.pending.previewId);
      this.pending = undefined;
    }
  }

  async plan(history: Message[], value: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    const pending = this.pending;
    if (pending && pending.expires > this.now() && history.at(-1)?.role === 'assistant' && history.at(-1)?.content === pending.prompt) {
      if (calendarConfirmed(value, pending.phrase) || calendarConfirmationAttempt(value)) {
        const plan: TurnPlan = { decision: 'respond', taskAction: 'confirm_conditional', taskKind: 'outdoor_activity',
          reasoningEffort: 'low', cognitiveMode: 'decision_support', assistantMode: 'decision_support' };
        this.plans.set(signal, { plan, text: value, pending }); return plan;
      }
      if (/^(?:不要了|不用了|取消|取消创建|别创建|算了|cancel)[。！.!]*$/i.test(value.trim())) {
        const plan: TurnPlan = { decision: 'respond', taskAction: 'cancel_conditional', taskKind: 'outdoor_activity',
          reasoningEffort: 'low', cognitiveMode: 'decision_support', assistantMode: 'decision_support' };
        this.plans.set(signal, { plan, text: value, pending }); return plan;
      }
      this.clearPending();
    } else if (pending) this.clearPending();
    const plan = this.base.plan ? await this.base.plan(history, value, forced, signal)
      : { decision: await this.base.decide(history, value, forced, signal) };
    this.plans.set(signal, { plan, text: value }); return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    return (await this.plan(history, text, forced, signal)).decision;
  }

  async reply(history: Message[], signal: AbortSignal, delta: (value: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.taskAction ?? 'none';
    if (action === 'none') { await this.base.reply(history, signal, delta, update, effort, mode, workflows); return; }
    if (action === 'cancel_conditional') { this.clearPending(); delta('已取消这次安排，没有创建日程。'); return; }
    if (action === 'confirm_conditional') {
      const pending = context?.pending;
      if (!pending || pending !== this.pending || pending.expires <= this.now()) {
        this.clearPending(); delta('这个日程预览已经失效，请重新提出安排。'); return;
      }
      if (!calendarConfirmed(context.text, pending.phrase)) {
        pending.prompt = `尚未提交。计划保留，请说“${pending.phrase}”或“确认”。`;
        delta(pending.prompt); return;
      }
      update?.({ type: 'task.status', status: 'saving' });
      const authorization = pending.orchestrator.authorize(pending.plan, pending.state, 'commit');
      const result = await pending.orchestrator.execute(pending.plan, pending.state, [authorization], signal); signal.throwIfAborted();
      const commit = record(result.nodes.commit.output);
      const uncertain = result.nodes.commit.error === 'WRITE_RESULT_UNKNOWN';
      this.pending = undefined;
      delta(commit.state === 'succeeded'
        ? `Google 已保存新日程。${commit.notifyGuests ? '已请求发送邀请，请确认是否收到。' : ''}`
        : uncertain || commit.state === 'unknown' ? 'Google 写入结果暂时无法确定。请先核对日历，系统不会自动重试。'
          : `Google 没有确认保存（${text(commit.error, 60) || 'CALENDAR_FAILED'}）。请重新查询后再试。`);
      return;
    }
    if (context?.plan.taskKind !== 'outdoor_activity') { delta('这个条件任务类型暂未实现。'); return; }
    update?.({ type: 'task.status', status: 'planning' });
    const planned = await this.planner(history.slice(0, -1), context?.text ?? history.at(-1)?.content ?? '', signal); signal.throwIfAborted();
    if (planned.action === 'clarify') { delta(planned.question); return; }
    const registry = buildRegistry(planned.spec, { calendar: this.calendar, location: this.location, routes: this.routes,
      environment: this.environment }, this.now);
    const task = compilePlan(planned.spec), state = createTaskState(task, this.now());
    const stages: Record<string, Extract<ReplyUpdate, { type: 'task.status' }>['status']> = {
      calendar_fit: 'calendar', location: 'locating', weather: 'environment', air: 'environment', pollen: 'environment',
      places: 'places', decision: 'deciding', finalize: 'environment', preview: 'previewing', commit: 'saving'
    };
    const orchestrator = new ConditionalTaskOrchestrator(registry, 4, this.now, event => {
      if (event.type === 'node.started' && event.nodeId && stages[event.nodeId]) update?.({ type: 'task.status', status: stages[event.nodeId] });
      if (event.type === 'node.failed') console.warn(JSON.stringify({ event: 'conditional_task_node_failed', node: event.nodeId, code: event.code }));
    });
    try {
      await orchestrator.execute(task, state, [], signal); signal.throwIfAborted();
      const prompt = summarize(planned.spec, state);
      const preview = record(state.nodes.preview?.output);
      if (state.status === 'waiting_confirmation' && text(preview.operationId, 100) && text(preview.phrase, 30)) {
        this.pending = { plan: task, state, orchestrator, prompt, phrase: text(preview.phrase, 30),
          expires: number(preview.expires) ?? this.now() + 5 * 60_000, previewId: text(preview.operationId, 100) };
      }
      delta(prompt);
    } catch (error) {
      const preview = record(state.nodes.preview?.output);
      if (text(preview.operationId, 100)) this.calendar.dismiss(text(preview.operationId, 100));
      orchestrator.cancel(state); signal.throwIfAborted();
      delta('这次条件任务没有完成，未创建日程。请稍后重试。');
    }
  }
}
