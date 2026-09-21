import type { AssistantMode, DialogueModel, Message, TurnPlan, ReplyUpdate, ReasoningEffort, WorkflowSelection } from './conversation.js';
import { validateCalendar, type CalendarEvent } from './calendar.js';
import { GoogleCalendarService, calendarError, type CalendarItem, type CalendarScope } from './google-calendar.js';
import type { CalendarPlanner, CalendarContext } from './calendar-planner.js';
import { calendarConfirmed, calendarConfirmationAttempt } from './calendar-preview.js';
import { calendarDisplayItems, calendarDisplayRange, calendarZoneLabel, calendarOverlapSummary } from './calendar-display.js';
import { needsCalendarRead, calendarQueryMatches, isNextCalendarQuery, calendarChoice } from './calendar-query.js';
import { wantsCalendarDetails, detailsFallback, type CalendarAnswerer } from './calendar-answer.js';
import { boundRecurrenceRequest, revisedRecurrenceNotes } from './calendar-recurrence.js';
import { wantsSeparateItineraryCalendars, type CalendarItineraryPlanner } from './calendar-itinerary-planner.js';
import { TimezoneClarificationError } from './timezone.js';
import { parseCalendarRecoveryState, type CalendarRecoveryState, type CalendarRecoveryTarget,
  type RecoveryPersistence } from './recovery-drafts.js';

type Preview = Awaited<ReturnType<GoogleCalendarService['preview']>>;
type Approval = Preview & { prompt: string };
type ReadChoice = { items: CalendarItem[]; timezone: string; prompt: string; expires: number };
type Draft = { kind: 'create' | 'update' | 'cancel'; event: CalendarEvent; before?: CalendarEvent;
  eventId?: string; scope?: CalendarScope; context: CalendarContext; blocked?: boolean; operationId?: string };
type Batch = { events: CalendarEvent[]; index: number };
type CancelBatch = { items: CalendarRecoveryTarget[]; retainedTitles: string[]; index: number };
type CalendarTimezoneResolver = (history: Message[], signal: AbortSignal) => Promise<string>;

function namedTimezone(text: string) {
  if (/(?:洛杉矶|los\s*angeles|pacific\s+time|太平洋时间)/i.test(text)) return 'America/Los_Angeles';
  if (/(?:芝加哥|chicago|central\s+time|中部时间)/i.test(text)) return 'America/Chicago';
  if (/(?:纽约|new\s*york|eastern\s+time|东部时间)/i.test(text)) return 'America/New_York';
  const iana = /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+\b/.exec(text)?.[0];
  if (!iana) return undefined;
  try { return new Intl.DateTimeFormat('en', { timeZone: iana }).resolvedOptions().timeZone; } catch { return undefined; }
}

function immediateStart(history: Message[]) {
  const anchors = history.filter(message => message.role === 'user').slice(-8).map(message => message.content)
    .filter(text => /现在|马上|即刻|此刻|今天|明天|后天|周[一二三四五六日天]|星期|\d{1,2}\s*(?:月|\/|-)\s*\d{1,2}|\b(?:now|right now|today|tomorrow|next\s+\w+)\b/i.test(text));
  const latest = anchors.at(-1) ?? '';
  // “现在帮我建一个 9 月 26 日上午 10 点的日程” uses 现在 as a
  // discourse marker, not as the event start. Only override the planner when
  // the user explicitly describes an immediate start and supplies no other
  // absolute date/clock that must win.
  const explicitlyImmediate = /(?:从现在(?:开始|起)|现在(?:开始|起)|马上开始|即刻开始|此刻开始|\b(?:start(?:ing)?\s+now|begin(?:ning)?\s+now|right\s+now)\b)/i.test(latest);
  const otherAbsoluteTime = /(?:今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*(?:月|\/|-)\s*\d{1,2}|(?:上午|中午|下午|晚上|凌晨)\s*\d{1,2}\s*(?:点|时)|\b\d{1,2}:\d{2}\b|\b(?:today|tomorrow|next\s+\w+)\b)/i.test(latest);
  return explicitlyImmediate && !otherAbsoluteTime
    && !/(?:不要|别|不是|改到|改成).{0,16}(?:现在|马上|now)/i.test(latest);
}

function zonedMinute(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(time);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const offset = value.timeZoneName === 'GMT' ? 'Z' : value.timeZoneName.replace('GMT', '');
  if (!/^(?:Z|[+-]\d{2}:\d{2})$/.test(offset)) throw new Error('CALENDAR_TIMEZONE_INVALID');
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}${offset}`;
}

function pinImmediateStart(request: Awaited<ReturnType<CalendarPlanner>>, timezone: string, now: number) {
  if (request.action !== 'create' || request.changes.allDay === true
    || typeof request.changes.start !== 'string' || typeof request.changes.end !== 'string') return request;
  const duration = Date.parse(request.changes.end) - Date.parse(request.changes.start);
  if (!Number.isFinite(duration) || duration < 60_000 || duration > 7 * 86400_000) return request;
  const start = Math.floor(now / 60_000) * 60_000;
  request.changes.start = zonedMinute(start, timezone);
  request.changes.end = zonedMinute(start + duration, timezone);
  request.changes.timezone = timezone;
  return request;
}

function calendarTitleKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[\s，。！？,.!?；;：“”"‘’'《》（）()\[\]【】·—_/-]+/g, '')
    .replace(/(?:帮我|麻烦|谢谢|那个|那一个|这一个|日程|事件|calendar|event)/g, '')
    .replace(/^(?:前往|去|到|购买|买|参加)/, '')
    .replace(/(?:喝一杯|电影票)$/, '');
}

function uniquelyMentionedCandidate(value: string, candidates: CalendarItem[]) {
  const key = calendarTitleKey(value);
  if (key.length < 2) return undefined;
  const matches = candidates.filter(candidate => {
    const title = calendarTitleKey(candidate.title);
    return title.length >= 2 && (title.includes(key) || key.includes(title));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function ordinalCandidates(value: string, candidates: CalendarItem[]) {
  const normalized = value.replace(/[\s，。！？,.!?；;：“”"‘’']/g, '');
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const indexes = new Set<number>();
  for (let index = 0; index < Math.min(candidates.length, 10); index++) {
    if (new RegExp(`第(?:${index + 1}|${chinese[index]})(?:个|项)?`).test(normalized)) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b).map(index => candidates[index]);
}

function ordinalCandidate(value: string, candidates: CalendarItem[]) {
  const matches = ordinalCandidates(value, candidates);
  return matches.length === 1 ? matches[0] : undefined;
}

function multipleCancelSelection(text: string, candidates: CalendarItem[]) {
  if (candidates.length < 2 || candidates.length > 10 || !/(?:取消|删除|删掉|删了|cancel|delete|remove)/i.test(text)) return [];
  const clauses = text.replace(/[\r\n\t，。！？,.!?；;：“”"‘’']/g, ' ').replace(/\s+/g, ' ').trim();
  const keepAfterOrdinal = /(?:留下|保留|不删|不要删|别删)\s*(第(?:\d{1,2}|[一二三四五六七八九十])(?:个|项)?)/i.exec(clauses)?.[1];
  const keepBeforeOrdinal = /(第(?:\d{1,2}|[一二三四五六七八九十])(?:个|项)?)\s*(?:留下|保留|不删|不要删|别删)/i.exec(clauses)?.[1];
  const keepClause = /(?:除了|除去)\s*(.+?)\s*(?:那(?:一)?个)?\s*(?:留下|保留|不删|不要删|别删)/i.exec(clauses)?.[1]
    ?? /(?:只|仅)\s*(?:留下|保留)\s*(.+?)(?=\s*(?:其他|其余|剩下).*(?:删|取消)|$)/i.exec(clauses)?.[1]
    ?? keepAfterOrdinal
    ?? keepBeforeOrdinal
    ?? /(?:留下|保留|不删|不要删|别删)\s*(.+?)(?=\s*(?:其他|其余|剩下).*(?:删|取消)|$)/i.exec(clauses)?.[1];
  if (keepClause) {
    const kept = ordinalCandidate(keepClause, candidates) ?? uniquelyMentionedCandidate(keepClause, candidates);
    // An ambiguous keep instruction must never degrade into deleting all.
    if (!kept) return [];
    // If the user names explicit cancel targets before saying what to keep,
    // honour only those targets. Never let the kept ordinal leak into the
    // cancellation set merely because it appears in the same sentence.
    const explicit = ordinalCandidates(text, candidates).filter(candidate => candidate.id !== kept.id);
    if (explicit.length) return explicit;
    const selected = candidates.filter(candidate => candidate.id !== kept.id);
    return selected;
  }
  const normalized = text.replace(/[\s，。！？,.!?]/g, '');
  if (/(?:全部|全都|都可以|都删|都取消|both|all(?:ofthem)?)/i.test(normalized)
    || candidates.length === 2 && /(?:这|那)?(?:两|2)个/.test(normalized)) return candidates;
  const selected = new Set<number>();
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (let index = 0; index < Math.min(candidates.length, 10); index++) {
    const ordinal = `(?:${index + 1}|${chinese[index]})`;
    if (new RegExp(`第${ordinal}(?:个|项)?`).test(normalized)) selected.add(index);
  }
  for (const match of normalized.matchAll(/(?:^|[^\d])(\d{1,2})(?=(?:和|与|及|、|,|还有|以及)\d)/g)) {
    const index = Number(match[1]) - 1; if (index >= 0 && index < candidates.length) selected.add(index);
  }
  return selected.size > 1 ? [...selected].sort((a, b) => a - b).map(index => candidates[index]) : [];
}

function contextualCancelIntent(text: string, candidates: CalendarItem[]) {
  if (candidates.length < 2) return false;
  const cancel = '(?:取消|删除|删掉|删了|cancel|delete|remove)';
  return new RegExp(`(?:帮我|请|把|将|这|那|都|全部|全都|其他|其余|剩下).{0,160}${cancel}|${cancel}.{0,160}(?:这|那|都|全部|全都|其他|其余|剩下|第\\d)`, 'i').test(text);
}

function eventTitle(item: { title: string }, maximum = 32) {
  const title = item.title.replace(/[\r\n\t]+/g, ' ').trim();
  return title.length > maximum ? `${title.slice(0, maximum - 1)}…` : title;
}

// Deterministic recovery for an occasional model routing miss. This can only
// enter the Calendar planner/preview path; it never authorizes a write.
function explicitCalendarIntent(value: string): 'create' | 'update' | 'cancel' | undefined {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  if (!text || text.length > 1000 || /(?:不要|别|无需|不需要|为什么|原理|代码|prompt|quoted|他说|她说).{0,24}(?:日历|calendar)/i.test(text)
    || /(?:\.ics\b|\bICS\b|日历文件|calendar\s+file|作为附件|附件形式|attachment|导出|export)/i.test(text)
    || /^(?:如何|怎么).{0,80}(?:创建|修改|取消|日历|calendar)/i.test(text) && !/帮我|please/i.test(text)) return undefined;
  const calendar = '(?:日历|calendar|会议|meeting|event|appointment|提醒)';
  if (new RegExp(`(?:取消|删除|删掉|cancel|delete|remove).{0,100}${calendar}|${calendar}.{0,100}(?:取消|删除|删掉|cancel|delete|remove)`, 'i').test(text)) return 'cancel';
  if (new RegExp(`(?:修改|改到|改成|调整|移动|推迟|提前|update|move|reschedule|change).{0,100}${calendar}|${calendar}.{0,100}(?:修改|改到|改成|调整|移动|推迟|提前|update|move|reschedule|change)`, 'i').test(text)) return 'update';
  if (new RegExp(`(?:创建|新建|添加|加到|放到|排进|安排到|create|add|put|schedule).{0,100}${calendar}|${calendar}.{0,100}(?:创建|新建|添加|加到|放到|排进|安排|create|add|put|schedule)`, 'i').test(text)) return 'create';
  if (/(?:帮我|请|麻烦|给我).{0,100}(?:安排|设|做|弄|发).{0,80}(?:日历提醒|calendar\s*reminder|calendar\s*invite|日历邀请)|(?:日历提醒|calendar\s*reminder|calendar\s*invite|日历邀请).{0,80}(?:帮我|给我|安排|设|做|弄|发)/i.test(text)) return 'create';
  return undefined;
}

function revisesPendingDraft(value: string) {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  if (!text || /^(?:不用|不要|别|取消|算了|确认|确定)/.test(text)) return false;
  return /(?:备注|notes?|description|说明).{0,120}(?:加|添加|写|记|放|改|补充|append|add|change|update)|(?:加|添加|写|记|放|改|补充).{0,120}(?:备注|notes?|description|说明)/i.test(text)
    || /(?:地点|地址|location|address|标题|名称|title|时间|日期|几点|start|end).{0,100}(?:改|换|设|调整|update|change|move)/i.test(text)
    || /(?:改|换|设|调整|update|change|move).{0,100}(?:地点|地址|location|address|标题|名称|title|时间|日期|几点|start|end)/i.test(text);
}

function asksWhetherDraftWasSaved(value: string) {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  return /(?:刚才|刚刚|这个|它).{0,40}(?:已经|不是已经|有没有|是否).{0,20}(?:创建|保存|写入|加到).{0,20}(?:吗|了|没有|日历)|(?:已经|不是已经).{0,20}(?:创建|保存|写入|加到).{0,30}(?:吗|了|没有)/i.test(text);
}

function isConversationalClosure(value: string) {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  const done = /(?:目前|暂时|现在)?(?:没有|没)(?:什么)?(?:事情|事|需要|要改|要做)了|不用了|先这样|就这样|nothing else|that(?:'s| is) all/i.test(text);
  const social = /谢谢|感谢|thank|appreciate/i.test(text);
  const newRequest = /(?:再|另外|顺便|接着|还要|下一步|现在).{0,30}(?:帮我|给我|请|创建|新建|添加|修改|改到|取消|删除)|(?:请|麻烦|能不能|可以再).{0,24}(?:创建|新建|添加|修改|改到|取消|删除)/i.test(text);
  return done && social && !newRequest;
}

function completedCalendarAcknowledgement(value: string, history: Message[]) {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  const social = /(?:真|很|太)(?:棒|赞|贴心|好)|好棒|很好|做得好|贴心|谢谢|感谢|满意|做得不错|做得很好|thank|appreciate|great|awesome|nice/i.test(text);
  const newRequest = /(?:再|另外|顺便|接着|还要|下一步|现在).{0,30}(?:帮我|给我|请|创建|新建|添加|修改|改到|取消|删除)|(?:请|麻烦|能不能|可以再).{0,24}(?:创建|新建|添加|修改|改到|取消|删除)/i.test(text);
  const interrogative = /[?？]|(?:吗|么|没有|是不是|是否|有没有|成功没有|好了没有|好了吗|完成了吗)[。！.!]*$/i.test(text);
  // A retrospective question is a request to re-read authoritative Calendar
  // state, not a social acknowledgement of the previous success message.
  if (!social || newRequest || interrogative) return undefined;
  // This bridge is intentionally one-shot. Once the result has been
  // acknowledged, later thanks or closure return to normal conversation.
  const success = history.at(-1);
  if (success?.role !== 'assistant' || !/Google 已保存(?:全部\d+项日程|新日程)/.test(success.content)) return undefined;
  const count = /Google 已保存全部(\d+)项日程/.exec(success.content)?.[1];
  const subject = count === '1' || !count ? '这个日程' : count === '2' ? '这两个日程' : `这${count}个日程`;
  const done = /(?:目前|暂时|现在)?(?:没有|没)(?:什么)?(?:事情|事|需要|要改|要做)了|不用了|先这样|就这样|nothing else|that(?:'s| is) all/i.test(text);
  const calendarSatisfied = /(?:calendar|日历).{0,24}(?:没(?:有)?什么问题|没问题|很好|不错|满意|顺手|清楚)/i.test(text);
  if (calendarSatisfied) return '谢谢你这么说！能把日历整理到让你觉得清楚、顺手，我也很开心。之后有变化，随时告诉我就好。';
  if (done) return `不客气，${subject}已经稳稳地安排好了。接下来按自己的节奏来就好；之后有变化，随时告诉我。`;
  return `谢谢你这么说！${subject}已经创建好了。能帮你把安排真正落下来，我也很开心；之后想调整，随时告诉我。`;
}

export class CalendarDialogue implements DialogueModel {
  private context: CalendarContext = { candidates: [] };
  private contextAt = 0;
  private approval?: Approval;
  private draft?: Draft;
  private readChoice?: ReadChoice;
  private batch?: Batch;
  private cancelBatch?: CancelBatch;
  private batchQuestion?: string;
  private plans = new WeakMap<AbortSignal, { plan: TurnPlan; approval?: Approval; readChoice?: ReadChoice;
    selected?: number | 'reject'; itinerary?: boolean; draftStatus?: boolean; acknowledgement?: string }>();
  constructor(private base: DialogueModel, private service: GoogleCalendarService, private planner: CalendarPlanner,
    private notify?: (text: string) => void, private now = Date.now, private answerDetails?: CalendarAnswerer,
    private itineraryPlanner?: CalendarItineraryPlanner, private resolveTimezone?: CalendarTimezoneResolver,
    private recovery?: RecoveryPersistence<CalendarRecoveryState>) {}
  private persistDraft() {
    if (!this.draft) { this.recovery?.clear(); return; }
    this.recovery?.save({ version: 1, draft: { kind: this.draft.kind, event: this.draft.event,
      ...(this.draft.before ? { before: this.draft.before } : {}), ...(this.draft.eventId ? { eventId: this.draft.eventId } : {}),
      ...(this.draft.scope ? { scope: this.draft.scope } : {}), ...(this.draft.blocked ? { blocked: true } : {}),
      ...(this.draft.operationId ? { operationId: this.draft.operationId } : {}) },
      ...(this.batch ? { batch: this.batch } : {}), ...(this.cancelBatch ? { cancelBatch: this.cancelBatch } : {}) });
  }
  private clearDraft() {
    this.draft = undefined; this.batch = undefined; this.cancelBatch = undefined; this.batchQuestion = undefined;
    this.recovery?.clear();
  }
  async restoreRecovery(value: unknown) {
    this.approval = undefined; this.readChoice = undefined; this.context = { candidates: [] };
    const recovered = parseCalendarRecoveryState(value);
    if (!recovered) { this.clearDraft(); return; }
    this.batch = recovered.batch;
    this.cancelBatch = recovered.cancelBatch;
    this.draft = { ...recovered.draft, context: { candidates: [], draft: recovered.draft.event } };
    this.context = this.draft.context; this.contextAt = this.now();
    if (!recovered.draft.operationId) { this.persistDraft(); return; }
    let result: Awaited<ReturnType<GoogleCalendarService['reconcile']>>;
    try { result = await this.service.reconcile(recovered.draft.operationId); }
    catch {
      // A missing/corrupt provider ledger must never turn into a repeated write.
      this.draft = { ...this.draft, blocked: true, operationId: recovered.draft.operationId };
      this.persistDraft(); return;
    }
    if (result.state === 'succeeded') {
      if (this.batch && this.batch.index + 1 < this.batch.events.length) {
        this.batch.index++;
        const event = this.batch.events[this.batch.index];
        this.draft = { kind: 'create', event, context: { candidates: [], draft: event } };
      } else if (this.cancelBatch && this.cancelBatch.index + 1 < this.cancelBatch.items.length) {
        this.cancelBatch.index++;
        const target = this.cancelBatch.items[this.cancelBatch.index];
        try {
          const resolved = await this.service.scopedTarget(target.id);
          this.draft = { kind: 'cancel', event: resolved.event, before: resolved.event,
            eventId: resolved.id, context: { candidates: [], draft: resolved.event } };
        } catch {
          // The completed item is safe, but the next selection can no longer be
          // rebound reliably. Require a fresh Calendar query instead of guessing.
          this.clearDraft(); return;
        }
      } else { this.clearDraft(); return; }
    } else if (['unknown', 'sending'].includes(result.state)) {
      this.draft = { ...this.draft, blocked: true, operationId: recovered.draft.operationId };
    } else {
      const { operationId: _operationId, blocked: _blocked, ...draft } = this.draft;
      this.draft = draft;
    }
    this.context = this.draft.context; this.contextAt = this.now(); this.persistDraft();
  }
  recoveryManifest() {
    if (!this.draft) return undefined;
    return { draft: true, action: this.draft.kind, uncertain: !!this.draft.blocked,
      requiresPreview: !this.draft.blocked, batchRemaining: this.batch ? this.batch.events.length - this.batch.index
        : this.cancelBatch ? this.cancelBatch.items.length - this.cancelBatch.index : 1 };
  }
  invalidate() {
    if (this.approval) this.service.dismiss(this.approval.id);
    this.approval = undefined; this.readChoice = undefined; this.persistDraft();
  }
  endSession() { this.invalidate(); this.clearDraft(); this.context = { candidates: [] }; }
  private async previewBatch(signal: AbortSignal, lead = '') {
    const batch = this.batch;
    if (!batch || batch.index >= batch.events.length) throw new Error('CALENDAR_ITINERARY_INVALID');
    const event = batch.events[batch.index];
    const context: CalendarContext = { candidates: [], draft: event };
    this.context = context; this.contextAt = this.now();
    this.draft = { kind: 'create', event, context };
    this.persistDraft();
    const pending = await this.service.preview('create', event, undefined, undefined, true); signal.throwIfAborted();
    this.draft.operationId = pending.id; this.persistDraft();
    const prompt = `${lead}第${batch.index + 1}/${batch.events.length}项\n${pending.preview}`;
    this.approval = { ...pending, prompt };
    return prompt;
  }
  private async previewCancelBatch(signal: AbortSignal, lead = '') {
    const batch = this.cancelBatch;
    if (!batch || batch.index >= batch.items.length) throw new Error('CALENDAR_CANCEL_BATCH_INVALID');
    const item = batch.items[batch.index];
    const resolved = await this.service.scopedTarget(item.id); signal.throwIfAborted();
    const context: CalendarContext = { candidates: [], draft: resolved.event };
    this.context = context; this.contextAt = this.now();
    this.draft = { kind: 'cancel', event: resolved.event, before: resolved.event, eventId: resolved.id, context };
    this.persistDraft();
    const pending = await this.service.preview('cancel', resolved.event, resolved.id, resolved.event, true); signal.throwIfAborted();
    this.draft.operationId = pending.id; this.persistDraft();
    const prompt = `${lead}第${batch.index + 1}/${batch.items.length}项\n${pending.preview}`;
    this.approval = { ...pending, prompt };
    return prompt;
  }
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
      this.draft = { ...draft, event, before, blocked: false, operationId: pending.id };
      this.context = { ...draft.context, draft: event }; this.contextAt = this.now();
      const prompt = this.cancelBatch
        ? `第${this.cancelBatch.index + 1}/${this.cancelBatch.items.length}项\n${pending.preview}`
        : this.batch ? `第${this.batch.index + 1}/${this.batch.events.length}项\n${pending.preview}` : pending.preview;
      this.approval = { ...pending, prompt }; this.persistDraft(); delta(prompt);
    } catch (error) {
      if (pending) this.service.dismiss(pending.id);
      signal.throwIfAborted();
      console.warn(JSON.stringify({ event: 'calendar_draft_refresh_failed', code: calendarError(error) }));
      delta('草稿仍保留，但暂时没能重新核对。尚未提交，请稍后再试。');
    }
  }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    const approval = this.approval; this.approval = undefined;
    const choice = this.readChoice; this.readChoice = undefined;
    const acknowledgement = completedCalendarAcknowledgement(text, history);
    if (acknowledgement) {
      if (approval) this.service.dismiss(approval.id);
      const plan: TurnPlan = { decision: 'respond', calendarAction: 'none', deliveryAction: 'none',
        reasoningEffort: 'low', cognitiveMode: 'casual', assistantMode: 'casual' };
      this.plans.set(signal, { plan, acknowledgement }); return plan;
    }
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
    const prior = history.at(-1);
    if (this.draft && asksWhetherDraftWasSaved(text)) {
      if (approval) this.service.dismiss(approval.id);
      const plan: TurnPlan = { decision: 'respond', calendarAction: 'followup', deliveryAction: 'none' };
      this.plans.set(signal, { plan, draftStatus: true }); return plan;
    }
    const itinerary = !!this.itineraryPlanner && (wantsSeparateItineraryCalendars(text, history)
      || !!this.batchQuestion && prior?.role === 'assistant' && prior.content === this.batchQuestion);
    if (this.batchQuestion && !itinerary) this.batchQuestion = undefined;
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
      if (this.draft && revisesPendingDraft(text)) {
        plan = { ...plan, decision: 'respond', calendarAction: 'followup', deliveryAction: 'none', reasoningEffort: 'low' };
      }
      if (contextualCancelIntent(text, this.context.candidates)
        && (!plan.calendarAction || plan.calendarAction === 'none')
        && (!plan.deliveryAction || plan.deliveryAction === 'none')) {
        plan = { ...plan, decision: 'respond', calendarAction: 'cancel', deliveryAction: 'none', reasoningEffort: 'low' };
      }
      const explicit = explicitCalendarIntent(text);
      if (explicit && (!plan.calendarAction || plan.calendarAction === 'none')
        && (!plan.deliveryAction || plan.deliveryAction === 'none' || plan.deliveryAction === 'calendar')) {
        plan = { ...plan, decision: 'respond', calendarAction: explicit, deliveryAction: 'none', reasoningEffort: 'low' };
      }
      if (!this.draft && isConversationalClosure(text)) {
        plan = { ...plan, decision: 'respond', calendarAction: 'none', deliveryAction: 'none',
          cognitiveMode: 'casual', assistantMode: 'casual', reasoningEffort: 'low' };
      }
      if (itinerary) plan = { ...plan, decision: 'respond', calendarAction: 'create', deliveryAction: 'none', reasoningEffort: 'medium' };
    } catch (error) { if (approval) this.service.dismiss(approval.id); throw error; }
    if (approval && plan.calendarAction !== 'confirm') this.service.dismiss(approval.id);
    this.plans.set(signal, { plan, approval, itinerary }); return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) { return (await this.plan(history, text, forced, signal)).decision; }
  async reply(history: Message[], signal: AbortSignal, delta: (s: string) => void, update?: (e: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.calendarAction ?? 'none';
    if (context?.acknowledgement) { delta(context.acknowledgement); return; }
    if (action === 'none') { await this.base.reply(history, signal, delta, update, effort, mode, workflows); return; }
    (this.base as DialogueModel & { invalidate?: () => void }).invalidate?.();
    signal.throwIfAborted();
    if (context?.draftStatus) {
      delta(`还没有写入 Google。刚才显示的是待确认预览，草稿仍然保留。你可以继续补充；完成后说“恢复日历草稿”查看确认页。`);
      return;
    }
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
      } catch (error) {
        signal.throwIfAborted(); console.warn(JSON.stringify({ event: 'calendar_query_failed', code: calendarError(error) }));
        delta('暂时没能重新核实日历，因此不能确认下一次时间。请稍后重试。');
      }
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
        const prompt = this.cancelBatch
          ? `为避免误删，每次只确认一项。当前第${this.cancelBatch.index + 1}/${this.cancelBatch.items.length}项尚未提交，请说“${approval.phrase}”或“确认”。`
          : `尚未提交。草稿保留，请说“${approval.phrase}”或“确认”。`;
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
        if (result.state === 'succeeded' && result.kind === 'create' && this.batch) {
          const completed = this.batch.index + 1, total = this.batch.events.length;
          if (completed < total) {
            this.batch.index++;
            try { message = await this.previewBatch(signal, `已保存第${completed}/${total}项。\n`); }
            catch (error) {
              signal.throwIfAborted();
              console.warn(JSON.stringify({ event: 'calendar_next_preview_failed', code: calendarError(error) }));
              message = `已保存第${completed}/${total}项；下一项暂时没能生成确认预览。草稿仍保留，请稍后说“恢复日历草稿”。`;
            }
          } else {
            this.batch = undefined;
            message = `Google 已保存全部${total}项日程。${result.notifyGuests ? '已请求发送邀请，请确认是否收到。' : ''}`;
          }
        } else if (result.state === 'succeeded' && result.kind === 'cancel' && this.cancelBatch) {
          const completedItem = this.cancelBatch.items[this.cancelBatch.index];
          const completed = this.cancelBatch.index + 1, total = this.cancelBatch.items.length;
          if (completed < total) {
            this.cancelBatch.index++;
            try { message = await this.previewCancelBatch(signal,
              `已删除“${eventTitle(completedItem)}”（${completed}/${total}）。${result.notifyGuests ? '已请求通知受邀人。' : ''}\n接下来是第${completed + 1}/${total}项：\n`); }
            catch (error) {
              signal.throwIfAborted();
              console.warn(JSON.stringify({ event: 'calendar_next_cancel_preview_failed', code: calendarError(error) }));
              message = `已删除“${eventTitle(completedItem)}”（${completed}/${total}）；下一项暂时没能生成确认预览。其余日程没有删除，请稍后说“继续取消其余日程”。`;
            }
          } else {
            const retained = this.cancelBatch.retainedTitles.map(title => `“${eventTitle({ title })}”`).join('、');
            this.cancelBatch = undefined;
            message = `已删除“${eventTitle(completedItem)}”（${completed}/${total}）。\n${total}项都已删除${retained ? `；已保留${retained}，没有改动` : ''}。${result.notifyGuests ? '已请求通知受邀人。' : ''}`;
          }
        } else message = result.state === 'succeeded'
          ? `Google 已保存${result.kind === 'cancel' ? '取消操作' : result.kind === 'create' ? '新日程' : '修改，原事件已更新'}。${result.notifyGuests ? result.kind === 'create' ? '已请求Google发送邀请，请确认是否收到。' : '已请求通知受邀人。' : ''}`
          : result.state === 'conflict' ? '日程已被改动，本次未覆盖。请重新查询、确认。'
          : result.state === 'unknown' ? 'Google 写入结果暂时无法确定，可能已保存。请先核对日历，不要重复创建；系统不会自动重试。'
          : 'Google 还没有确认保存。草稿仍保留，请稍后重试或检查日历授权。';
      } catch (error) {
        if (this.draft) this.draft.blocked = true;
        console.warn(JSON.stringify({ event: 'calendar_write_failed', code: calendarError(error) }));
        message = 'Google 没有确认本次操作是否完成。请先核对日历，不要重复提交。';
      }
      this.context = { candidates: [] }; this.persistDraft();
      if (signal.aborted) { this.notify?.(message); return; }
      delta(message); return;
    }
    update?.({ type: 'calendar.status', status: 'planning' });
    let pending: Preview | undefined;
    try {
      if (this.draft?.blocked && ['create', 'update', 'cancel', 'followup'].includes(action)) { delta('上次日历写入结果不确定。请先核对日历，不能重复提交。'); return; }
      const plannerContext = action === 'followup' && this.draft ? { ...this.draft.context, draft: this.draft.event } : this.context;
      const explicitTimezone = namedTimezone(history.filter(message => message.role === 'user').slice(-6).map(message => message.content).join(' '));
      let defaultTimezone = explicitTimezone || plannerContext.draft?.timezone
        || (plannerContext.candidates.length === 1 ? plannerContext.candidates[0].event?.timezone : undefined);
      if (!defaultTimezone && this.resolveTimezone) {
        try { defaultTimezone = await this.resolveTimezone(history, signal); signal.throwIfAborted(); }
        catch (error) {
          signal.throwIfAborted();
          const question = error instanceof TimezoneClarificationError ? error.clarification
            : '需要先确认你当前位置的时区。请允许一次定位，或告诉我所在城市／时区。';
          delta(`${question.replace(/[。；;]+$/, '')}；尚未修改日历。`); return;
        }
      }
      if (context?.itinerary && this.itineraryPlanner) {
        const itinerary = await this.itineraryPlanner(history, signal, defaultTimezone); signal.throwIfAborted();
        if (itinerary.action === 'clarify') {
          this.batchQuestion = itinerary.clarification;
          delta(itinerary.clarification); return;
        }
        this.batchQuestion = undefined;
        this.batch = { events: itinerary.events, index: 0 };
        delta(await this.previewBatch(signal)); return;
      }
      if (this.batch && action === 'create') this.batch = undefined;
      const latestText = history.at(-1)?.content ?? '';
      if (action === 'cancel') {
        if (this.cancelBatch && /(?:继续|恢复).{0,12}(?:取消|删除)|(?:取消|删除).{0,12}(?:其余|剩下)/.test(latestText)) {
          delta(await this.previewCancelBatch(signal)); return;
        }
        const selectedForCancel = multipleCancelSelection(latestText, this.context.candidates);
        if (selectedForCancel.length > 0) {
          if (selectedForCancel.some(item => !item.editable)) {
            delta('所选事件中有只读或非助手创建的日程，不能安全批量取消；尚未删除任何事件。'); return;
          }
          if (selectedForCancel.some(item => item.recurringEventId || item.event?.recurrence)) {
            delta('所选事件包含重复会议。请先说明要取消单次还是整个系列；尚未删除任何事件。'); return;
          }
          const selectedIds = new Set(selectedForCancel.map(item => item.id));
          this.cancelBatch = { items: selectedForCancel.map(item => ({ id: item.id, title: item.title })),
            retainedTitles: this.context.candidates.filter(item => !selectedIds.has(item.id)).map(item => item.title), index: 0 };
          delta(await this.previewCancelBatch(signal)); return;
        }
      }
      let request = await this.planner(history, plannerContext, signal, defaultTimezone); signal.throwIfAborted();
      if (defaultTimezone && immediateStart(history)) request = pinImmediateStart(request, defaultTimezone, this.now());
      if (request.scope === 'following') { delta('暂不支持“此次及以后”的系列拆分。请选择仅这一次或整个系列；没有提交。'); return; }
      update?.({ type: 'calendar.status', status: 'querying' });
      if (request.action === 'clarify' || request.clarification) { this.context.request = request; this.contextAt = this.now(); delta(request.clarification || '请说明要查询的日期范围或要修改的具体事件。'); return; }
      const changes = Object.fromEntries(Object.entries(request.changes).filter(([, value]) => value !== null));
      if (request.action === 'query' && isNextCalendarQuery(history.at(-1)?.content ?? '')) {
        if (!request.titleQuery.trim()) { delta('想查哪个课程或会议的下一次安排？请告诉我名称。'); return; }
        const result = await this.service.next(request.titleQuery, request.timezone || defaultTimezone || process.env.CONVERSATION_TIMEZONE || 'UTC', this.now()); signal.throwIfAborted();
        if (!result.items.length && result.suggestions.length) {
          const items = result.suggestions, timezone = request.timezone || defaultTimezone || process.env.CONVERSATION_TIMEZONE || 'UTC';
          const label = (item: CalendarItem) => (item.title + (items.length > 1 && items[0].title === items[1].title ? `（${item.location || item.start.slice(0, 10)}）` : '')).replace(/[\r\n]/g, ' ').slice(0, 65);
          const prompt = items.length === 1 ? `日历里有“${label(items[0])}”。你说的是这个课程或会议吗？`
            : `你指的是哪一个？\n1. ${label(items[0])}\n2. ${label(items[1])}\n说名称或第几个即可。`;
          this.readChoice = { items, timezone, prompt, expires: this.now() + 5 * 60000 };
          delta(prompt); return;
        }
        this.context = { candidates: result.items.slice(0, 20), request }; this.contextAt = this.now();
        delta(result.items.length ? `下一次·${calendarZoneLabel(request.timezone || defaultTimezone || process.env.CONVERSATION_TIMEZONE || 'UTC')}时间\n${calendarDisplayItems(this.context.candidates, request.timezone || defaultTimezone || process.env.CONVERSATION_TIMEZONE || 'UTC')}`
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
        if (this.batch) this.batch.events[this.batch.index] = event;
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
      this.persistDraft();
      pending = await this.service.preview(request.action, event, targetId, before, true, scope); signal.throwIfAborted();
      this.draft.operationId = pending.id; this.persistDraft();
      const prompt = this.batch && request.action === 'create'
        ? `第${this.batch.index + 1}/${this.batch.events.length}项\n${pending.preview}` : pending.preview;
      this.approval = { ...pending, prompt }; delta(prompt);
    } catch (error) {
      if (pending) this.service.dismiss(pending.id);
      if (this.draft) { this.draft.operationId = undefined; this.persistDraft(); }
      signal.throwIfAborted();
      const code = calendarError(error);
      console.warn(JSON.stringify({ event: 'calendar_planning_failed', code }));
      delta(code === 'CALENDAR_SCOPE_REQUIRED' ? '请确认仅这一次或整个系列；尚未提交。' : code.startsWith('CALENDAR_RECURRENCE') ? '重复规则暂不支持或遇到夏令时歧义。请使用有具体次数的按天／按周定时会议，或调整时间；尚未提交。' : code === 'CALENDAR_PREVIEW_TOO_LONG' ? '预览仍然过长，尚未提交。这次先处理时间、地点还是备注？' : code.includes('CHANGED') ? '日程刚刚发生变化，没有提交修改。请重新查询后确认。' : code.startsWith('CALENDAR_NETWORK') || code.startsWith('GOOGLE_') ? 'Google Calendar 查询未完成，因此我不能把它当作“没有安排”。没有修改任何日程，请稍后重试。'
        : '我暂时没能把这次日历要求整理成安全的预览。上下文仍保留；请再说一次最关键的日期或时间，我继续处理。');
    }
  }
}
