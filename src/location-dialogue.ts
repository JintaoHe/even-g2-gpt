import type { AssistantMode, DialogueModel, Message, ReplyUpdate, ReasoningEffort, RouteTravelMode, TurnPlan, WorkflowSelection } from './conversation.js';
import { randomUUID } from 'node:crypto';
import { applyNearbyIntent, type NearbyPreferences } from './nearby-intent.js';
import type { NearbyMetricObserver } from './runtime-metrics.js';
import { LocationRequestBroker, LocationUnavailableError } from './location.js';
import { RouteError, recommendCandidates, type PlaceCandidate, type RouteComparisonResult, type RouteOrigin, type RouteProvider, type RouteRequestKind } from './routes.js';

type PendingRoute = { destination: string; mode: RouteTravelMode; modeExplicit: boolean; kind: RouteRequestKind; candidates?: PlaceCandidate[]; expires: number; prompt: string };
type RecentComparison = { query: string; kind: RouteRequestKind; candidates: PlaceCandidate[]; recommendedPlaceId?: string;
  evidenceAt: number; excluded?: RouteComparisonResult['excluded'];
  displayedPlaceIds: string[]; routeFacts: { placeId: string; durationSeconds: number; distanceMeters: number }[]; mode: RouteTravelMode };
type PendingPlaceClarification = { destination: string; mode: RouteTravelMode; modeExplicit: boolean; kind: RouteRequestKind; expires: number; prompt: string; candidates: PlaceCandidate[] };
type NearbyTask = { id: string; prefs: NearbyPreferences; mode: 'specific' | 'recommend'; delegated: boolean; rounds: number; expires: number;
  excluded?: RouteComparisonResult['excluded'] };

const modes: Record<RouteTravelMode, string> = { drive: '驾车', walk: '步行', bicycle: '骑车' };
const routeContextMs = 30 * 60_000;
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
const durationMinutesText = (value: number, compact = false) => {
  const total = Math.max(1, Math.round(value));
  if (total < 60) return `${total}${compact ? '分' : '分钟'}`;
  const hours = Math.floor(total / 60), remainder = total % 60;
  return `${hours}小时${remainder ? `${remainder}分钟` : ''}`;
};
const durationText = (seconds: number, compact = false) => durationMinutesText(minutes(seconds), compact);
const ratingText = (candidate: RouteComparisonResult['candidates'][number]) => candidate.rating === undefined
  ? '' : `${candidate.rating.toFixed(1)}★${candidate.userRatingCount === undefined ? '' : `（${candidate.userRatingCount}）`}`;
const distanceText = (meters: number, timezone: string) => {
  const miles = meters / 1609.344, kilometres = meters / 1000;
  const mileText = miles.toFixed(1), kilometreText = kilometres.toFixed(kilometres >= 100 ? 0 : 1);
  return timezone.startsWith('America/')
    ? `${mileText}英里（${kilometreText}公里）`
    : `${kilometreText}公里（${mileText}英里）`;
};

function needsPlaceClarification(candidates: PlaceCandidate[]) {
  if (candidates.length < 2) return false;
  const primaryTypes = new Set(candidates.map(candidate => candidate.primaryType ?? candidate.types?.[0]).filter(Boolean));
  return primaryTypes.size > 1;
}

function fallbackPlaceQuestion(destination: string, candidates: PlaceCandidate[]) {
  const names = [...new Set(candidates.map(candidate => candidate.name))].slice(0, 3);
  return `找到${names.join('、')}。你指的是哪一个地点？`.slice(0, 160);
}

function selectRouteCandidates(result: RouteComparisonResult, selectedIndices: number[]) {
  const candidates = selectedIndices.map(index => result.candidates[index]).filter(Boolean);
  if (!candidates.length) throw new Error('Empty route selection');
  const { recommended, basis } = recommendCandidates(candidates);
  return { ...result, candidates, recommendedPlaceId: recommended.placeId, recommendationBasis: basis };
}

function selectPlaces(candidates: PlaceCandidate[], selectedIndices: number[]) {
  if (!selectedIndices.length || selectedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= candidates.length)) {
    throw new Error('Invalid place selection');
  }
  const selected = [...new Set(selectedIndices)].map(index => candidates[index]);
  if (!selected.length) throw new Error('Empty place selection');
  return selected;
}

function compactCandidates(result: RouteComparisonResult) {
  const fastest = [...result.candidates].sort((a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters)[0];
  const recommended = result.candidates.find(candidate => candidate.placeId === result.recommendedPlaceId) ?? fastest;
  const list = [...result.candidates].sort((a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters).slice(0, 2);
  if (!list.some(candidate => candidate.placeId === recommended.placeId)) list[list.length - 1] = recommended;
  return { fastest, recommended, list };
}

function addressLocality(address?: string) {
  const parts = address?.split(',').map(part => part.trim()).filter(Boolean) ?? [];
  if (parts.length < 2) return undefined;
  const last = parts.at(-1)!;
  if (/^(USA|US|United States)$/i.test(last) && parts.length >= 4) return parts.at(-3);
  if (/^[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i.test(last) && parts.length >= 3) return parts.at(-2);
  return parts.length >= 3 ? parts.at(-2) : parts[1];
}

function streetAndLocality(address?: string) {
  const parts = address?.split(',').map(part => part.trim()).filter(Boolean) ?? [];
  const street = parts[0], locality = addressLocality(address);
  if (street && locality && street.toLocaleLowerCase() !== locality.toLocaleLowerCase()) return `${street}, ${locality}`;
  return street || locality;
}

function candidateLabels(candidates: RouteComparisonResult['candidates']) {
  const groups = new Map<string, RouteComparisonResult['candidates']>();
  for (const candidate of candidates) {
    const key = candidate.name.toLocaleLowerCase(), group = groups.get(key) ?? [];
    group.push(candidate); groups.set(key, group);
  }
  return new Map(candidates.map(candidate => {
    const group = groups.get(candidate.name.toLocaleLowerCase()) ?? [];
    if (group.length < 2) return [candidate.placeId, candidate.name];
    const localities = group.map(item => addressLocality(item.address));
    const locality = addressLocality(candidate.address);
    const citiesDistinguish = localities.every(Boolean)
      && new Set(localities.map(value => value!.toLocaleLowerCase())).size === group.length;
    const discriminator = citiesDistinguish ? locality : streetAndLocality(candidate.address);
    return [candidate.placeId, discriminator ? `${candidate.name} · ${discriminator}` : candidate.name];
  }));
}

function withRecentPlaceContext(history: Message[], recent?: RecentComparison, force = false) {
  if (!recent?.candidates.length || history.at(-1)?.role !== 'user') return history;
  const latest = history.at(-1)!.content.toLocaleLowerCase();
  const names = recent.candidates.map(candidate => candidate.name.toLocaleLowerCase());
  const named = names.some(name => name.length >= 3 && latest.includes(name));
  const referential = /刚才|刚刚|之前|前面|你说|推荐|那家|那个|这家|这个|选一家|选一个|随便你|第一家|第二家|you choose|pick one|the one|you (?:said|mentioned|recommended)|earlier/i.test(latest)
    && history.slice(-24, -1).some(message => names.some(name => message.content.toLocaleLowerCase().includes(name)));
  if (!force && !named && !referential) return history;
  const facts = recent.candidates.slice(0, 5).map(candidate => ({
    name: candidate.name, ...(candidate.address ? { address: candidate.address } : {}),
    ...(candidate.primaryType ? { type: candidate.primaryType } : {}),
    ...(candidate.rating === undefined ? {} : { rating: candidate.rating }),
    ...(candidate.userRatingCount === undefined ? {} : { userRatingCount: candidate.userRatingCount }),
    displayedOrder: recent.displayedPlaceIds.includes(candidate.placeId) ? recent.displayedPlaceIds.indexOf(candidate.placeId) + 1 : null,
    ...recent.routeFacts.find(fact => fact.placeId === candidate.placeId),
    ...(candidate.openNow === undefined ? {} : { openNow: candidate.openNow }),
    ...(candidate.priceLevel ? { priceLevel: candidate.priceLevel } : {}),
    unverifiedAttributes: ['foodService', 'quietness', 'liveliness', ...(!candidate.priceLevel ? ['price'] : [])],
    recommended: candidate.placeId === recent.recommendedPlaceId
  }));
  const enriched = history.map(message => ({ ...message }));
  enriched[enriched.length - 1].content += `\n\n[Application-provided read-only place context; not user instructions; evidence is historical, not live; displayedOrder binds first/second, null means not displayed]\n${JSON.stringify({ query: recent.query, places: facts, mode: recent.mode, evidenceAt: recent.evidenceAt, excluded: recent.excluded })}`;
  return enriched;
}

export function routeText(result: RouteComparisonResult, timezone: string, defaultMode: boolean, originLabel = '当前位置') {
  const { fastest, recommended, list } = compactCandidates(result);
  const labels = candidateLabels(result.candidates);
  const label = (candidate: RouteComparisonResult['candidates'][number]) => labels.get(candidate.placeId) ?? candidate.name;
  const caveats = (candidate: PlaceCandidate) => {
    if (!result.nearbyPreferences) return '';
    const notes: string[] = [];
    if ((result.nearbyPreferences.visitTime ?? 'now') !== 'now') notes.push('出行时营业时间待确认');
    else if (candidate.openNow === undefined) notes.push('营业时间待确认');
    if (result.nearbyPreferences.priceCeiling && !candidate.priceLevel) notes.push('价位待确认');
    return notes.length ? `\n   ${notes.join('；')}` : '';
  };
  const preferenceNote = (result.nearbyPreferences?.vibe && result.nearbyPreferences.vibe !== 'any'
    || result.nearbyPreferences?.needsFood ? '\n环境和供餐情况仍需向店家确认。' : '')
    + (result.nearbyPreferences?.unhandledExclusions ? '\n部分排除条件无法从地图数据核实，不能保证全部符合。' : '');
  if (result.candidates.length === 1) {
    const candidate = result.candidates[0];
    const delay = result.trafficAware && candidate.staticDurationSeconds !== undefined
      ? Math.max(0, minutes(candidate.durationSeconds) - minutes(candidate.staticDurationSeconds)) : 0;
    return `从${originLabel}${modes[result.mode]}到${label(candidate)}约 ${durationText(candidate.durationSeconds)}，${distanceText(candidate.distanceMeters, timezone)}。`
      + (candidate.rating === undefined ? '' : `\n评分 ${ratingText(candidate)}（Google Maps）。`)
      + (result.trafficAware ? delay >= 2 ? `\n拥堵约多 ${durationMinutesText(delay)}。` : '\n路况正常。' : '')
      + caveats(candidate) + preferenceNote;
  }
  const lines = [`从${originLabel}，${defaultMode && result.mode === 'drive' ? '默认按驾车' : `按${modes[result.mode]}`}时间比较：`];
  list.forEach((candidate, index) => {
    lines.push(`${index + 1}. ${label(candidate)} · ${durationText(candidate.durationSeconds, true)} · ${distanceText(candidate.distanceMeters, timezone)}`);
    const details: string[] = [];
    const rating = ratingText(candidate); if (rating) details.push(rating);
    if (result.trafficAware) {
      const routeDelay = candidate.staticDurationSeconds === undefined ? 0
        : Math.max(0, minutes(candidate.durationSeconds) - minutes(candidate.staticDurationSeconds));
      details.push(routeDelay >= 2 ? `拥堵+${durationMinutesText(routeDelay, true)}` : '路况正常');
    }
    if (details.length) lines.push(`   ${details.join(' · ')}`);
    const uncertain = caveats(candidate); if (uncertain) lines.push(uncertain.trim());
  });
  const extra = Math.max(0, minutes(recommended.durationSeconds) - minutes(fastest.durationSeconds));
  if (result.recommendationBasis === 'quality_risk') {
    lines.push(`建议 ${label(recommended)}：虽多 ${durationMinutesText(extra)}，但 ${label(fastest)} 评分过低。`);
  } else if (result.recommendationBasis === 'balanced') {
    lines.push(`建议 ${label(recommended)}：多 ${durationMinutesText(extra)}，但评分更稳。`);
  } else {
    const other = list.find(candidate => candidate.placeId !== recommended.placeId);
    const advantage = other ? Math.max(0, minutes(other.durationSeconds) - minutes(recommended.durationSeconds)) : 0;
    const ratingAdvantage = other && recommended.rating !== undefined && other.rating !== undefined && recommended.rating > other.rating;
    lines.push(`建议 ${label(recommended)}${advantage ? `：快 ${durationMinutesText(advantage)}` : ''}${ratingAdvantage ? '，评分也更高' : ''}。`);
  }
  if (list.some(candidate => candidate.rating !== undefined)) lines.push('评分来源：Google Maps');
  return lines.join('\n') + preferenceNote;
}

export class LocationDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, TurnPlan>();
  private pending?: PendingRoute;
  private pendingPlace?: PendingPlaceClarification;
  private recent?: RecentComparison;
  private nearbyTask?: NearbyTask;
  private preferredMode: RouteTravelMode = 'drive';
  private preferredModeExplicit = false;
  constructor(private base: DialogueModel, private location: LocationRequestBroker, private routes: RouteProvider,
    private timezone = 'America/Chicago', private now = Date.now, private clarifier?: DialogueModel,
    private observeNearby?: NearbyMetricObserver) {}
  startSession() { this.pending = undefined; this.pendingPlace = undefined; this.recent = undefined; this.nearbyTask = undefined; this.preferredMode = 'drive'; this.preferredModeExplicit = false; }
  endSession() {
    this.pending = undefined; this.pendingPlace = undefined; this.recent = undefined; this.nearbyTask = undefined; this.preferredMode = 'drive'; this.preferredModeExplicit = false;
    this.location.cancel(); this.location.clear();
  }
  invalidate() { this.location.cancel(); }
  setPreferredMode(mode: RouteTravelMode) {
    if (!['drive', 'walk', 'bicycle'].includes(mode)) throw new Error('Invalid route mode');
    this.preferredMode = mode; this.preferredModeExplicit = true;
  }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    if (this.pending && this.pending.expires <= this.now()) this.pending = undefined;
    if (this.pendingPlace && this.pendingPlace.expires <= this.now()) this.pendingPlace = undefined;
    if (this.nearbyTask && this.nearbyTask.expires <= this.now()) this.nearbyTask = undefined;
    let plan = this.base.plan ? await this.base.plan(history, text, forced, signal)
      : { decision: await this.base.decide(history, text, forced, signal) };
    signal.throwIfAborted();
    const last = history.at(-1);
    if (this.pendingPlace && last?.role === 'assistant' && last.content === this.pendingPlace.prompt) {
      if ((plan.locationAction === 'route_eta' || plan.locationAction === 'nearby_search') && plan.nearby?.taskAction !== 'replace') {
        // Preserve the original search and use the answer only to select candidates.
        const destination = this.pendingPlace.destination;
        plan = { ...plan, locationAction: this.pendingPlace.kind === 'nearby' ? 'nearby_search' : 'route_eta',
          routeDestination: destination, routeMode: this.pendingPlace.mode, routeModeExplicit: this.pendingPlace.modeExplicit };
      } else if (plan.locationAction !== 'cancel') {
        // The user moved on to another topic. Do not let an old ambiguity answer
        // silently affect a future route request.
        this.pendingPlace = undefined; this.nearbyTask = undefined;
      }
    }
    if (this.pending && plan.decision === 'respond' && (!plan.locationAction || plan.locationAction === 'none')
      && last?.role === 'assistant' && last.content === this.pending.prompt
      && (!plan.calendarAction || plan.calendarAction === 'none') && (!plan.deliveryAction || plan.deliveryAction === 'none')) {
      plan = { ...plan, locationAction: this.pending.kind === 'nearby' ? 'nearby_search' : 'route_eta', routeDestination: this.pending.destination,
        routeOrigin: text.trim(), routeMode: this.pending.mode, routeModeExplicit: this.pending.modeExplicit, reasoningEffort: 'low' };
    }
    if ((plan.locationAction === 'route_eta' || plan.locationAction === 'nearby_search') && !plan.routeDestination?.trim() && this.pending) {
      plan = { ...plan, routeDestination: this.pending.destination, routeMode: plan.routeMode ?? this.pending.mode };
    }
    if (['route_eta', 'nearby_search', 'recompare'].includes(plan.locationAction ?? 'none')) {
      const spokenMode = plan.routeModeExplicit && plan.routeMode ? plan.routeMode : undefined;
      plan = { ...plan, routeMode: spokenMode ?? this.preferredMode,
        routeModeExplicit: !!spokenMode || this.preferredModeExplicit };
    }
    this.plans.set(signal, plan); return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) { return (await this.plan(history, text, forced, signal)).decision; }
  async reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, assistantMode?: AssistantMode, workflows?: WorkflowSelection[]) {
    const plan = this.plans.get(signal); this.plans.delete(signal);
    const action = plan?.locationAction ?? 'none';
    if (action === 'analyze_places') {
      if (!this.recent) { delta('我现在没有这两家店的可核对资料。能告诉我店名吗？'); return; }
      const analysisWorkflows = (workflows ?? []).filter(workflow => workflow.kind !== 'navigation');
      analysisWorkflows.push({ kind: 'navigation', action: 'analyze_places' });
      if (plan?.searchAction === 'search' && !analysisWorkflows.some(workflow => workflow.kind === 'search')) {
        analysisWorkflows.push({ kind: 'search', action: 'read' });
      }
      await this.base.reply(withRecentPlaceContext(history, this.recent, true), signal, delta, update, effort,
        assistantMode, analysisWorkflows); return;
    }
    if (action === 'none') {
      await this.base.reply(withRecentPlaceContext(history, this.recent), signal, delta, update, effort, assistantMode, workflows); return;
    }
    if (action === 'cancel') {
      this.pending = undefined; this.pendingPlace = undefined; this.recent = undefined; this.nearbyTask = undefined; this.location.cancel(); this.location.clear();
      await this.base.reply(history, signal, delta, update, effort, assistantMode,
        workflows?.filter(workflow => workflow.kind !== 'navigation')); return;
    }
    const recent = this.recent;
    if (action === 'recompare' && !recent) { delta('没有可重新比较的最近地点。请重新说要查找的地点或类别。'); return; }
    let destination = (action === 'recompare' ? recent?.query : plan?.routeDestination)?.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 300);
    const kind: RouteRequestKind = action === 'nearby_search' ? 'nearby' : action === 'recompare' ? recent!.kind : 'destination';
    if (plan?.nearby?.taskAction === 'clear') {
      this.pending = undefined; this.pendingPlace = undefined; this.recent = undefined; this.nearbyTask = undefined;
        await this.base.reply(history, signal, delta, update, effort, assistantMode,
          workflows?.filter(workflow => workflow.kind !== 'navigation')); return;
    }
    if (!this.nearbyTask || plan?.nearby?.taskAction === 'replace'
      || (!plan?.nearby && !this.pendingPlace && !this.pending && action !== 'recompare')) {
      this.nearbyTask = { id: randomUUID(), prefs: {}, mode: 'specific', delegated: false, rounds: 0, expires: this.now() + routeContextMs };
    }
    if (plan?.nearby) {
      if (plan.nearby.invalidPatchCount) this.observeNearby?.('invalid_patch', plan.nearby.invalidPatchCount);
      this.nearbyTask.prefs = applyNearbyIntent(this.nearbyTask.prefs, plan.nearby);
      this.nearbyTask.mode = plan.nearby.mode; this.nearbyTask.delegated = plan.nearby.delegated;
    }
    this.nearbyTask.expires = this.now() + routeContextMs;
    const nearbyPreferences = kind === 'nearby' ? this.nearbyTask.prefs : undefined;
    const pending = this.pending;
    let candidates: PlaceCandidate[] | undefined;
    let excluded: RouteComparisonResult['excluded'];
    if (action === 'recompare') candidates = recent!.candidates;
    else if (pending && pending.destination === destination && pending.kind === kind) candidates = pending.candidates;
    if (this.pendingPlace && this.pendingPlace.destination === destination && this.pendingPlace.kind === kind) candidates = this.pendingPlace.candidates;
    // A relaxed filter needs a fresh candidate pool, not the previously filtered subset.
    if (plan?.nearby && (plan.nearby.taskAction === 'replace'
      || Object.keys(plan.nearby.patch).length && !this.pendingPlace)) candidates = undefined;
    const mode = plan?.routeMode ?? this.preferredMode;
    if (!destination) { delta(action === 'nearby_search' ? '想找哪一类附近地点？' : '想去哪里？请说目的地名称或地址。'); return; }
    let origin: RouteOrigin;
    if (plan?.routeOrigin?.trim()) origin = { kind: 'address', address: plan.routeOrigin.trim() };
    else {
      update?.({ type: 'route.status', status: 'locating' });
      try {
        const fix = await this.location.request(signal); signal.throwIfAborted();
        origin = { kind: 'coordinates', location: fix };
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof LocationUnavailableError && error.reason === 'low_accuracy' ? '定位精度不足' : '暂时没能获取当前位置';
        const prompt = `${reason}。请说出或在手机上输入出发地址，我仍可帮你查询${kind === 'nearby' ? `附近的${destination}` : `去${destination}的路线`}。`;
        this.pending = { destination, mode, modeExplicit: plan?.routeModeExplicit ?? false, kind,
          ...(candidates?.length ? { candidates } : {}), expires: this.now() + routeContextMs, prompt };
        delta(prompt); return;
      }
    }
    update?.({ type: 'route.status', status: candidates?.length ? 'comparing' : kind === 'nearby' ? 'searching' : origin.kind === 'address' ? 'resolving' : 'routing' });
    try {
      let clarificationChecked = false;
      let assumption = '';
      const clarify = async (options: PlaceCandidate[]) => {
        const result = await this.clarifyPlaces(destination!, options, history, signal);
        if (result.action === 'assume') {
          assumption = `我先按${selectPlaces(options, result.selectedIndices).slice(0, 3).map(c => c.name).join('、')}这些候选比较；如果不对，请纠正我。\n`;
        }
        return result;
      };
      if (candidates?.length && this.pendingPlace && needsPlaceClarification(candidates)) {
        const clarification = await clarify(candidates); clarificationChecked = true;
        if (clarification.action === 'ask') {
          this.pendingPlace = { ...this.pendingPlace, prompt: clarification.question };
          delta(clarification.question); return;
        }
        candidates = selectPlaces(candidates, clarification.selectedIndices);
      }
      if (!candidates?.length && this.routes.discover) {
        let discovery;
        try {
          discovery = await this.routes.discover({ origin, destination, mode, kind, nearbyPreferences }, signal);
        } catch (error) {
          if (!(error instanceof RouteError) || error.code !== 'ROUTE_DESTINATION_NOT_FOUND'
            || kind !== 'destination' || !this.clarifier?.resolveRoute) throw error;
          const resolution = await this.clarifier.resolveRoute(destination, history, signal, update);
          signal.throwIfAborted();
          if (resolution.action === 'ask') { delta(resolution.question); return; }
          if (resolution.action !== 'resolved') throw error;
          destination = resolution.destination;
          update?.({ type: 'route.status', status: 'resolving' });
          discovery = await this.routes.discover({ origin, destination, mode, kind, nearbyPreferences }, signal);
        }
        signal.throwIfAborted(); candidates = discovery.candidates; excluded = discovery.excluded;
        this.nearbyTask.excluded = excluded; clarificationChecked = true;
        if (needsPlaceClarification(candidates)) {
          update?.({ type: 'route.status', status: 'clarifying' });
          const clarification = await clarify(candidates);
          if (clarification.action === 'ask') {
            const prompt = clarification.question;
            this.pending = undefined; this.recent = undefined;
            this.pendingPlace = { destination, mode, modeExplicit: plan?.routeModeExplicit ?? false, kind,
              expires: this.now() + routeContextMs, prompt, candidates };
            delta(prompt); return;
          }
          candidates = selectPlaces(candidates, clarification.selectedIndices);
        }
        update?.({ type: 'route.status', status: 'routing' });
      }
      const result = await this.routes.route({ origin, destination, mode, kind, nearbyPreferences, ...(candidates?.length ? { candidates } : {}) }, signal);
      signal.throwIfAborted();
      let resolved = result;
      if (!clarificationChecked && needsPlaceClarification(result.candidates)) {
        update?.({ type: 'route.status', status: 'clarifying' });
        const clarification = await clarify(result.candidates);
        if (clarification.action === 'ask') {
          const prompt = clarification.question;
          this.pending = undefined; this.recent = undefined;
          this.pendingPlace = { destination, mode, modeExplicit: plan?.routeModeExplicit ?? false, kind,
            expires: this.now() + routeContextMs, prompt, candidates: result.candidates };
          delta(prompt); return;
        }
        resolved = selectRouteCandidates(result, clarification.selectedIndices);
      }
      this.pending = undefined;
      this.pendingPlace = undefined;
      this.recent = { query: resolved.query, kind, recommendedPlaceId: resolved.recommendedPlaceId,
        displayedPlaceIds: compactCandidates(resolved).list.map(candidate => candidate.placeId), mode: resolved.mode,
        routeFacts: resolved.candidates.slice(0, 5).map(({ placeId, durationSeconds, distanceMeters }) => ({ placeId, durationSeconds, distanceMeters })),
        evidenceAt: this.now(), excluded: [...(excluded ?? this.nearbyTask.excluded ?? []), ...(resolved.excluded ?? [])],
        candidates: resolved.candidates.slice(0, 5).map(candidate => ({ placeId: candidate.placeId, name: candidate.name,
          ...(candidate.location ? { location: candidate.location } : {}), ...(candidate.openNow === undefined ? {} : { openNow: candidate.openNow }),
          ...(candidate.priceLevel ? { priceLevel: candidate.priceLevel } : {}), ...(candidate.businessStatus ? { businessStatus: candidate.businessStatus } : {}),
          ...(candidate.address ? { address: candidate.address } : {}), ...(candidate.rating === undefined ? {} : { rating: candidate.rating }),
          ...(candidate.userRatingCount === undefined ? {} : { userRatingCount: candidate.userRatingCount }),
          ...(candidate.primaryType ? { primaryType: candidate.primaryType } : {}), ...(candidate.types?.length ? { types: candidate.types } : {}) })) };
      const originLabel = origin.kind === 'coordinates' ? '当前位置' : origin.address.replace(/[\r\n\t]+/g, ' ').slice(0, 60);
      delta(assumption + routeText(resolved, this.timezone, !plan?.routeModeExplicit, originLabel));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RouteError && error.code === 'ROUTE_NO_MATCHING_PLACES') {
        this.pending = undefined; this.pendingPlace = undefined; this.recent = undefined;
        delta(error.excluded?.length && error.excluded.every(item => item.reason === 'closed')
          ? '这次找到的几家都显示已关门；没有确认到下一次营业时间。'
          : '这批结果没有符合条件的选择，可能受营业状态、价位或类型限制。可以放宽一个条件再找。');
      } else if (error instanceof RouteError && error.code === 'ROUTE_DESTINATION_NOT_FOUND') {
        const prompt = kind === 'nearby' ? `附近没有找到可比较的“${destination}”。请换一个类别或补充范围。`
          : `没有找到“${destination}”的可用路线。请补充城市、门店或完整地址。`;
        this.pending = { destination, mode, modeExplicit: plan?.routeModeExplicit ?? false, kind,
          expires: this.now() + routeContextMs, prompt }; delta(prompt);
      } else {
        const routeError = error instanceof RouteError ? error : undefined;
        update?.({ type: 'route.status', status: 'failed', stage: routeError?.stage ?? 'unknown',
          ...(routeError?.providerStatus === undefined ? {} : { provider_status: routeError.providerStatus }),
          ...(routeError?.providerReason ? { provider_reason: routeError.providerReason } : {}) });
        console.warn(JSON.stringify({ event: 'route_provider_failed', stage: routeError?.stage ?? 'unknown',
          provider_status: routeError?.providerStatus, provider_reason: routeError?.providerReason }));
        // Maps/Routes is a read-only accelerator, not a single point of failure.
        // Fall back to Luna's quota-bounded web research while explicitly
        // withholding exact GPS and prohibiting claims of live route metrics.
        const fallbackWorkflows = (workflows ?? []).filter(workflow => workflow.kind !== 'navigation');
        fallbackWorkflows.push({ kind: 'navigation', action: 'fallback_search' });
        if (!fallbackWorkflows.some(workflow => workflow.kind === 'search')) fallbackWorkflows.push({ kind: 'search', action: 'read' });
        await this.base.reply(history, signal, delta, update, effort === 'high' ? 'high' : 'medium', assistantMode, fallbackWorkflows);
      }
    }
  }

  private async clarifyPlaces(destination: string, candidates: PlaceCandidate[], history: Message[], signal: AbortSignal) {
    const task = this.nearbyTask!;
    const allowAsk = !task.delegated && task.rounds < (task.mode === 'recommend' ? 1 : 2);
    const fallback = () => allowAsk && task.mode === 'specific'
      ? { action: 'ask' as const, selectedIndices: [] as [], question: fallbackPlaceQuestion(destination, candidates) }
      : { action: 'assume' as const, selectedIndices: candidates.map((_, index) => index), assumptionNote: '比较当前候选' };
    let result: import('./conversation.js').RouteClarification;
    try {
      const clarification = this.clarifier?.clarifyRoute
        ? await this.clarifier.clarifyRoute(destination, candidates.map(candidate => ({ name: candidate.name,
          ...(candidate.address ? { address: candidate.address } : {}), ...(candidate.primaryType ? { primaryType: candidate.primaryType } : {}),
          ...(candidate.types?.length ? { types: candidate.types } : {}) })), history, signal, { allowAsk, mode: task.mode })
        : fallback();
      signal.throwIfAborted();
      if (clarification.action !== 'ask') selectPlaces(candidates, clarification.selectedIndices);
      result = clarification.action === 'ask' && !allowAsk ? fallback() : clarification;
    } catch {
      signal.throwIfAborted();
      result = fallback();
    }
    if (result.action === 'ask') { task.rounds++; this.observeNearby?.('clarified'); }
    if (result.action === 'assume') this.observeNearby?.('assumed');
    return result;
  }
}
