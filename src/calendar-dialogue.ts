import type { DialogueModel, Message, TurnPlan, ReplyUpdate, ReasoningEffort } from './conversation.js';
import { validateCalendar, type CalendarEvent } from './calendar.js';
import { GoogleCalendarService, calendarError, type CalendarItem, type CalendarScope } from './google-calendar.js';
import type { CalendarPlanner, CalendarContext } from './calendar-planner.js';
import { calendarConfirmed, calendarConfirmationAttempt } from './calendar-preview.js';
import { calendarDisplayItems, calendarDisplayRange, calendarZoneLabel, calendarOverlapSummary } from './calendar-display.js';
import { needsCalendarRead, calendarQueryMatches, isNextCalendarQuery, calendarChoice } from './calendar-query.js';
import { wantsCalendarDetails, detailsFallback, type CalendarAnswerer } from './calendar-answer.js';
import { boundRecurrenceRequest, revisedRecurrenceNotes } from './calendar-recurrence.js';

type Preview = Awaited<ReturnType<GoogleCalendarService['preview']>>;
type Approval = Preview & { prompt: string };
type ReadChoice = { items: CalendarItem[]; timezone: string; prompt: string; expires: number };
type Draft = { kind: 'create' | 'update' | 'cancel'; event: CalendarEvent; before?: CalendarEvent;
  eventId?: string; scope?: CalendarScope; context: CalendarContext; blocked?: boolean };
export class CalendarDialogue implements DialogueModel {
  private context: CalendarContext = { candidates: [] };
  private contextAt = 0;
  private approval?: Approval;
  private draft?: Draft;
  private readChoice?: ReadChoice;
  private plans = new WeakMap<AbortSignal, { plan: TurnPlan; approval?: Approval; readChoice?: ReadChoice; selected?: number | 'reject' }>();
  constructor(private base: DialogueModel, private service: GoogleCalendarService, private planner: CalendarPlanner,
    private notify?: (text: string) => void, private now = Date.now, private answerDetails?: CalendarAnswerer) {}
  invalidate() { if (this.approval) this.service.dismiss(this.approval.id); this.approval = undefined; this.readChoice = undefined; }
  endSession() { this.invalidate(); this.draft = undefined; this.context = { candidates: [] }; }
  private async refreshDraft(signal: AbortSignal, delta: (s: string) => void) {
    const draft = this.draft;
    if (!draft) { delta('没有待处理的日历草稿。'); return; }
    if (draft.blocked) { delta('草稿保留，但上次写入结果不确定。请先核对日历，不能重复提交。'); return; }
    let pending: Preview | undefined;
    try {
      let event = draft.event, before = draft.before;
      if (draft.kind !== 'create') {
        const latest = await this.service.read(draft.eventId!); signal.throwIfAborted();
        const patch = Object.fromEntries(Object.entries(draft.event).filter(([key, value]) => value !== draft.before?.[key as keyof CalendarEvent]));
        before = latest;
        event = draft.kind === 'cancel' ? latest : validateCalendar({ ...latest, ...patch });
      }
      pending = await this.service.preview(draft.kind, event, draft.eventId, before, true, draft.scope); signal.throwIfAborted();
      this.draft = { ...draft, event, before };
      this.context = { ...draft.context, draft: event }; this.contextAt = this.now();
      const prompt = pending.preview;
      this.approval = { ...pending, prompt }; delta(prompt);
    } catch (error) {
      if (pending) this.service.dismiss(pending.id);
      signal.throwIfAborted();
      delta(`草稿保留，重新检查未完成（${calendarError(error)}）。尚未提交。`);
    }
  }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    const approval = this.approval; this.approval = undefined;
    const choice = this.readChoice; this.readChoice = undefined;
    if (choice && choice.expires > this.now() && history.at(-1)?.role === 'assistant' && history.at(-1)?.content === choice.prompt) {
      const selected = calendarChoice(text, choice.items);
      if (selected !== undefined) {
        if (approval) this.service.dismiss(approval.id);
        const plan: TurnPlan = { decision: 'respond', calendarAction: 'query', deliveryAction: 'none' };
        this.plans.set(signal, { plan, readChoice: choice, selected }); return plan;
      }
      // An ambiguous yes with two choices must not choose the first or reach a write flow.
      if (/^(对|是的|是|就是那个|确认|确定|yes|yeah)[。！.!]*$/i.test(text.trim())) {
        const plan: TurnPlan = { decision: 'respond', calendarAction: 'query', deliveryAction: 'none' };
        this.plans.set(signal, { plan, readChoice: choice }); return plan;
      }
      // Longer conversational references use the existing semantic planner, bounded to
      // these real candidates. Its output may only resolve a read, never authorize writes.
      if (/那个|这个|这家|第|说的|指的|没错|确实|\bright\b|\bone\b|\bmean\b/i.test(text)
        && !/创建|新建|改|取消|删除|发|退出|再见|拜拜|退下|\b(create|update|delete|cancel|move|send|exit|bye)\b/i.test(text)) {
        const resolved = await this.planner([...history, { role: 'user', content: text }], { candidates: choice.items }, signal);
        signal.throwIfAborted();
        const index = resolved.targetIndex - 1;
        const selected = resolved.action === 'query' && !resolved.clarification && index >= 0 && index < choice.items.length
          && Object.values(resolved.changes).every(value => value == null) ? index : undefined;
        const plan: TurnPlan = { decision: 'respond', calendarAction: 'query', deliveryAction: 'none' };
        this.plans.set(signal, { plan, readChoice: choice, selected }); return plan;
      }
    }
    if (this.now() - this.contextAt > 10 * 60000) this.context = { candidates: [] };
    let plan: TurnPlan;
    try {
      const resume = this.draft && /^(?:(?:继续|恢复)(?:刚才的|那个)?(?:日历|事件)?草稿|确认(?:创建|修改|取消))[。！.!]*$/.test(text.trim());
      plan = resume || (approval && (calendarConfirmed(text, approval.phrase) || calendarConfirmationAttempt(text)))
        ? { decision: 'respond', calendarAction: 'confirm', deliveryAction: 'none' }
        : this.base.plan ? await this.base.plan(history, text, forced, signal) : { decision: await this.base.decide(history, text, forced, signal) };
      signal.throwIfAborted();
      if ((!plan.calendarAction || plan.calendarAction === 'none') && (!plan.deliveryAction || plan.deliveryAction === 'none') && needsCalendarRead(text, history)) {
        plan = { ...plan, decision: 'respond', calendarAction: 'query', deliveryAction: 'none' };
      }
    } catch (error) { if (approval) this.service.dismiss(approval.id); throw error; }
    if (approval && plan.calendarAction !== 'confirm') this.service.dismiss(approval.id);
    this.plans.set(signal, { plan, approval }); return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) { return (await this.plan(history, text, forced, signal)).decision; }
  async reply(history: Message[], signal: AbortSignal, delta: (s: string) => void, update?: (e: ReplyUpdate) => void, effort?: ReasoningEffort) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.calendarAction ?? 'none';
    if (action === 'none') { await this.base.reply(history, signal, delta, update, effort); return; }
    (this.base as DialogueModel & { invalidate?: () => void }).invalidate?.();
    signal.throwIfAborted();
    if (context?.readChoice) {
      const choice = context.readChoice;
      if (context.selected === 'reject') { delta('明白，不是这几个。课程还有其他名称，或大概在哪天吗？'); return; }
      if (context.selected === undefined) { this.readChoice = choice; delta(choice.prompt); return; }
      update?.({ type: 'calendar.status', status: 'querying' });
      try {
        const selected = choice.items[context.selected];
        const result = await this.service.next(selected.title, choice.timezone, this.now(), selected); signal.throwIfAborted();
        this.context = { candidates: result.items.slice(0, 20) }; this.contextAt = this.now();
        delta(result.items.length ? `下一次·${calendarZoneLabel(choice.timezone)}时间\n${calendarDisplayItems(this.context.candidates, choice.timezone)}`
          : '重新查询后，未来93天未找到这个日程的后续安排，可能已被改动。要换个名称查吗？');
      } catch (error) { signal.throwIfAborted(); delta(`暂时未能重新核实日历（${calendarError(error)}），不能确认下一次时间。请稍后重试。`); }
      return;
    }
    if (action === 'dismiss') { this.endSession(); delta('已丢弃日历草稿，没有修改任何事件。'); return; }
    if (action === 'confirm') {
      const approval = context?.approval, previous = history.at(-2), text = history.at(-1)?.content.trim().replace(/[。！.!]+$/, '');
      if (!approval || approval.expires <= this.now() || previous?.role !== 'assistant' || previous.content !== approval.prompt) {
        if (approval) this.service.dismiss(approval.id);
        if (this.draft) { update?.({ type: 'calendar.status', status: 'querying' }); await this.refreshDraft(signal, delta); return; }
        delta('没有有效的日历确认，或确认内容不完整。请重新提出修改要求，核对具体日期和时区后再确认。'); return;
      }
      if (!calendarConfirmed(text ?? '', approval.phrase)) {
        // Keep the same operation and original expiry; bind the next approval to this retry prompt.
        const prompt = `尚未提交。草稿保留，请说“${approval.phrase}”或“确认”。`;
        this.approval = { ...approval, prompt };
        delta(prompt); return;
      }
      update?.({ type: 'calendar.status', status: 'saving' });
      let message: string;
      try {
        signal.throwIfAborted();
        const result = await this.service.confirm(approval.id, approval.phrase);
        if (result.state === 'succeeded') this.draft = undefined;
        else if (result.state === 'unknown' && this.draft) this.draft.blocked = true;
        message = result.state === 'succeeded'
          ? `Google 已保存${result.kind === 'cancel' ? '取消操作' : result.kind === 'create' ? '新日程' : '修改，原事件已更新'}。${result.notifyGuests ? result.kind === 'create' ? '已请求Google发送邀请，请确认是否收到。' : '已请求通知受邀人。' : ''}`
          : result.state === 'conflict' ? '日程已被改动，本次未覆盖。请重新查询、确认。'
          : result.state === 'unknown' ? 'Google 写入结果暂时无法确定，可能已保存。请先核对日历，不要重复创建；系统不会自动重试。'
          : `Google 未确认保存，操作失败（${result.error ?? 'CALENDAR_FAILED'}）。请检查授权或重新查询。`;
      } catch (error) { if (this.draft) this.draft.blocked = true; message = `日历操作未完成（${calendarError(error)}），不能确认已保存。请重新查询核对。`; }
      this.context = { candidates: [] };
      if (signal.aborted) { this.notify?.(message); return; }
      delta(message); return;
    }
    update?.({ type: 'calendar.status', status: 'planning' });
    let pending: Preview | undefined;
    try {
      if (this.draft?.blocked && ['create', 'update', 'cancel', 'followup'].includes(action)) { delta('上次日历写入结果不确定。请先核对日历，不能重复提交。'); return; }
      const plannerContext = action === 'followup' && this.draft ? { ...this.draft.context, draft: this.draft.event } : this.context;
      const request = await this.planner(history, plannerContext, signal); signal.throwIfAborted();
      if (request.scope === 'following') { delta('暂不支持“此次及以后”的系列拆分。请选择仅这一次或整个系列；没有提交。'); return; }
      update?.({ type: 'calendar.status', status: 'querying' });
      if (request.action === 'clarify' || request.clarification) { this.context.request = request; this.contextAt = this.now(); delta(request.clarification || '请说明要查询的日期范围或要修改的具体事件。'); return; }
      const changes = Object.fromEntries(Object.entries(request.changes).filter(([, value]) => value !== null));
      if (request.action === 'query' && isNextCalendarQuery(history.at(-1)?.content ?? '')) {
        if (!request.titleQuery.trim()) { delta('想查哪个课程或会议的下一次安排？请告诉我名称。'); return; }
        const result = await this.service.next(request.titleQuery, request.timezone || process.env.CONVERSATION_TIMEZONE || 'America/Chicago', this.now()); signal.throwIfAborted();
        if (!result.items.length && result.suggestions.length) {
          const items = result.suggestions, timezone = request.timezone || process.env.CONVERSATION_TIMEZONE || 'America/Chicago';
          const label = (item: CalendarItem) => (item.title + (items.length > 1 && items[0].title === items[1].title ? `（${item.location || item.start.slice(0, 10)}）` : '')).replace(/[\r\n]/g, ' ').slice(0, 65);
          const prompt = items.length === 1 ? `日历里有“${label(items[0])}”。你说的是这个课程或会议吗？`
            : `你指的是哪一个？\n1. ${label(items[0])}\n2. ${label(items[1])}\n说名称或第几个即可。`;
          this.readChoice = { items, timezone, prompt, expires: this.now() + 5 * 60000 };
          delta(prompt); return;
        }
        this.context = { candidates: result.items.slice(0, 20), request }; this.contextAt = this.now();
        delta(result.items.length ? `下一次·${calendarZoneLabel(request.timezone || process.env.CONVERSATION_TIMEZONE || 'America/Chicago')}时间\n${calendarDisplayItems(this.context.candidates, request.timezone || process.env.CONVERSATION_TIMEZONE || 'America/Chicago')}`
          : `未来${result.horizonDays}天内未查到匹配的定时日程。这个课程或会议还有其他名称吗？`);
        return;
      }
      let selected: CalendarItem | undefined;
      if (request.action !== 'create') {
        if (request.targetIndex && request.action !== 'query') selected = plannerContext.candidates[request.targetIndex - 1];
        else {
          if (!request.rangeStart || !request.rangeEnd) { delta('请给出要查询的日期范围，或明确选择上次列表中的事件编号。'); return; }
          const result = await this.service.query(request.rangeStart, request.rangeEnd, request.timezone); signal.throwIfAborted();
          const matched = request.action === 'query' ? calendarQueryMatches(result.items, request.titleQuery)
            : request.titleQuery ? result.items.filter(e => e.title.toLowerCase().includes(request.titleQuery.toLowerCase())) : result.items;
          const candidates = request.action === 'query' && matched.length === 0 && result.items.length ? result.items : matched;
          const filterNotice = request.action === 'query' && matched.length !== result.items.length
            ? matched.length ? `标题筛选匹配${matched.length}项；范围内${result.complete ? '共' : '至少'}${result.items.length}项。\n`
              : `标题筛选未匹配；以下为该时段全部已查到的日程。\n` : '';
          this.service.recordQuerySelection(request.rangeStart, request.rangeEnd, request.timezone, request.titleQuery, result.items.length, matched.length, result.complete);
          this.context = { candidates: candidates.slice(0, 20), request }; this.contextAt = this.now();
          const listing = `${calendarZoneLabel(request.timezone)}时间·${calendarDisplayRange(request.rangeStart, request.rangeEnd, request.timezone)}\n${filterNotice}${calendarOverlapSummary(this.context.candidates)}${result.complete ? '共' : '至少'} ${candidates.length} 个事件。${candidates.length > 20 ? '仅列前20个，请缩小范围。' : ''}\n\n${calendarDisplayItems(this.context.candidates, request.timezone)}`.trimEnd();
          if (request.action === 'query') {
            if (wantsCalendarDetails(history.at(-1)?.content ?? '')) {
              const priorSelected = request.targetIndex ? plannerContext.candidates[request.targetIndex - 1] : undefined;
              const detailCandidates = priorSelected ? candidates.filter(e => e.id === priorSelected.id) : matched;
              if (detailCandidates.length !== 1) { delta(listing + '\n请明确是哪一个会议，再查备注和参会信息。'); return; }
              const facts = await this.service.details(detailCandidates[0].id); signal.throwIfAborted();
              const answer = this.answerDetails ? await this.answerDetails(history.at(-1)!.content, facts, signal) : detailsFallback(facts);
              signal.throwIfAborted(); delta(answer); return;
            }
            delta(listing); return;
          }
          if (!result.complete || candidates.length !== 1) { delta(listing + (candidates.length ? '\n\n请明确选择事件编号或名称；尚未修改任何事件。' : '\n没有找到目标，请核对日期和名称。')); return; }
          selected = candidates[0];
        }
        if (!selected || !selected.editable) { delta('没有可安全修改的唯一事件；非助手创建、不支持的重复规则或不在固定受邀人范围内的事件当前仅能查看。'); return; }
      }
      const scope = request.scope ?? (action === 'followup' ? this.draft?.scope : undefined);
      if (selected && (selected.recurringEventId || selected.event?.recurrence) && !scope) {
        this.context = { candidates: [selected], request }; this.contextAt = this.now();
        delta('这是重复会议。要处理仅这一次，还是整个系列（含过去）？尚未提交。'); return;
      }
      let targetId = selected?.id;
      let event: CalendarEvent, before: CalendarEvent | undefined;
      if (request.action === 'create') {
        event = validateCalendar(boundRecurrenceRequest({ ...(this.draft?.kind === 'create' ? this.draft.event : undefined), ...changes }));
        event = revisedRecurrenceNotes(event, this.draft?.kind === 'create' ? this.draft.event : undefined);
      } else {
        const resolved = await this.service.scopedTarget(selected!.id, scope); signal.throwIfAborted();
        before = resolved.event; targetId = resolved.id;
        const previousChanges = action === 'followup' && this.draft?.kind === 'update' && this.draft.eventId === targetId
          ? Object.fromEntries(Object.entries(this.draft.event).filter(([key, value]) => value !== this.draft!.before?.[key as keyof CalendarEvent])) : {};
        event = request.action === 'cancel' ? before : revisedRecurrenceNotes(validateCalendar(boundRecurrenceRequest({ ...before, ...previousChanges, ...changes })), before);
        if (request.action === 'update' && Object.keys(changes).length === 0) { delta('请说明要修改的时间、地点或其他内容。'); return; }
      }
      this.context = { candidates: selected ? [selected] : [], request, draft: event }; this.contextAt = this.now();
      this.draft = { kind: request.action, event, before, eventId: targetId, scope, context: this.context };
      pending = await this.service.preview(request.action, event, targetId, before, true, scope); signal.throwIfAborted();
      this.approval = { ...pending, prompt: pending.preview }; delta(pending.preview);
    } catch (error) {
      if (pending) this.service.dismiss(pending.id);
      signal.throwIfAborted();
      const code = calendarError(error);
      delta(code === 'CALENDAR_SCOPE_REQUIRED' ? '请确认仅这一次或整个系列；尚未提交。' : code.startsWith('CALENDAR_RECURRENCE') ? '重复规则暂不支持或遇到夏令时歧义。请使用有具体次数的按天／按周定时会议，或调整时间；尚未提交。' : code === 'CALENDAR_PREVIEW_TOO_LONG' ? '改动较多，超过两页。请分次修改或缩短内容；尚未提交。' : code.includes('CHANGED') ? '日程刚刚发生变化，没有提交修改。请重新查询后确认。'
        : `日历查询或预览未完成（${code}），没有提交修改。请核对日期、起止时间和时区，或稍后重试。`);
    }
  }
}
