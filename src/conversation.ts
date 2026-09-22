import { randomUUID } from 'node:crypto';
import { ContextBuilder, type ContextComposer } from './context-builder.js';

export type Citation = { start: number; end: number; url: string; title: string };
export type ReplyUpdate = { type: 'search.status'; status: string } | { type: 'calendar.status'; status: 'planning' | 'querying' | 'saving' }
  | { type: 'route.status'; status: 'locating' | 'resolving' | 'searching' | 'routing' | 'comparing' | 'clarifying' }
  | { type: 'route.status'; status: 'failed'; stage: 'places' | 'routes' | 'unknown'; provider_status?: number; provider_reason?: string }
  | { type: 'task.status'; status: 'planning' | 'calendar' | 'locating' | 'environment' | 'places' | 'deciding' | 'previewing' | 'saving' }
  | { type: 'artifact.status'; status: 'generating' | 'sending' }
  | { type: 'answer.citations'; text: string; citations: Citation[] };
export type TopicAction = 'continue' | 'switch' | 'resume';
export type Message = { role: 'user' | 'assistant'; content: string; citations?: Citation[];
  topicId?: string; topicLabel?: string; cognitiveMode?: CognitiveMode; assistantMode?: AssistantMode;
  /** Durable metadata is optional so legacy/in-memory callers remain compatible. */
  messageId?: string; sequence?: number; status?: 'committed' | 'streaming' | 'interrupted' | 'failed';
  contextKind?: 'summary' | 'prior' | 'history' };

/** Select one topic only for artifacts that must not blend separate projects. Normal
 * conversation receives the whole bounded session so the assistant has short-term memory. */
export function activeTopicHistory(history: Message[]) {
  const topicId = history.at(-1)?.topicId;
  return topicId ? history.filter(message => !message.topicId || message.topicId === topicId) : history;
}
export type Decision = 'respond' | 'wait' | 'exit' | 'clarify_exit';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type CognitiveMode = 'casual' | 'explain' | 'research' | 'brainstorm' | 'decision_support' | 'planning'
  | 'deep_reasoning' | 'compose' | 'coaching';
/** @deprecated Compatibility alias for older clients and saved sessions. */
export type AssistantMode = CognitiveMode;
export type LocationAction = 'none' | 'route_eta' | 'nearby_search' | 'recompare' | 'analyze_places' | 'cancel';
export type TaskKind = 'outdoor_activity';
export type TaskAction = 'none' | 'conditional_task' | 'confirm_conditional' | 'cancel_conditional';
export type WorkflowKind = 'search' | 'navigation' | 'environment' | 'calendar' | 'document' | 'email' | 'memory' | 'list' | 'conditional_task';
export type WorkflowSelection = { kind: WorkflowKind; action: string; taskKind?: TaskKind };
export type SearchAction = 'none' | 'search';
export type RouteTravelMode = 'drive' | 'walk' | 'bicycle';
export type RoutePlaceOption = { name: string; address?: string; primaryType?: string; types?: string[] };
export type RouteClarification = { action: 'proceed'; selectedIndices: number[] }
  | { action: 'assume'; selectedIndices: number[]; assumptionNote: string }
  | { action: 'ask'; selectedIndices: []; question: string };
export type RouteClarificationPolicy = { allowAsk: boolean; mode: 'specific' | 'recommend' };
export type RouteResolution = { action: 'resolved'; destination: string }
  | { action: 'ask'; question: string }
  | { action: 'not_found' };
export type TurnPlan = { decision: Decision; cognitiveMode?: CognitiveMode; assistantMode?: AssistantMode; reasoningEffort?: ReasoningEffort;
  historyQuery?: string | null;
  topicAction?: TopicAction; topicTarget?: string | null; topicLabel?: string | null;
  deliveryAction?: import('./delivery-intent.js').DeliveryAction;
  calendarAction?: import('./calendar-planner.js').CalendarAction; locationAction?: LocationAction;
  searchAction?: SearchAction; taskAction?: TaskAction; taskKind?: TaskKind | null; workflows?: WorkflowSelection[];
  routeDestination?: string | null; routeOrigin?: string | null; routeMode?: RouteTravelMode; routeModeExplicit?: boolean;
  nearby?: import('./nearby-intent.js').NearbyIntent };

/** Normalize one model classification into the backend-owned routing vocabulary. */
export function normalizeTurnPlan(plan: TurnPlan): TurnPlan {
  const cognitiveMode = plan.cognitiveMode ?? plan.assistantMode;
  const taskKind = plan.taskAction && plan.taskAction !== 'none' ? plan.taskKind ?? 'outdoor_activity' : null;
  const workflows: WorkflowSelection[] = [];
  const add = (workflow: WorkflowSelection) => {
    if (!workflows.some(current => current.kind === workflow.kind && current.action === workflow.action)) workflows.push(workflow);
  };
  if (plan.searchAction === 'search' || (plan.searchAction === undefined && cognitiveMode === 'research')) add({ kind: 'search', action: 'read' });
  if (typeof plan.historyQuery === 'string' && plan.historyQuery.trim()) add({ kind: 'memory', action: 'recall' });
  if (plan.locationAction && !['none', 'cancel'].includes(plan.locationAction)) add({ kind: 'navigation', action: plan.locationAction });
  if (plan.calendarAction && plan.calendarAction !== 'none') add({ kind: 'calendar', action: plan.calendarAction });
  if (plan.deliveryAction && plan.deliveryAction !== 'none') {
    add({ kind: 'document', action: plan.deliveryAction });
    add({ kind: 'email', action: plan.deliveryAction });
  }
  if (plan.taskAction && plan.taskAction !== 'none') add({ kind: 'conditional_task', action: plan.taskAction,
    taskKind: taskKind ?? 'outdoor_activity' });
  return { ...plan, cognitiveMode, assistantMode: cognitiveMode, taskKind, workflows };
}
export interface DialogueModel {
  startSession?(): void;
  endSession?(): void;
  plan?(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan>;
  decide(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<Decision>;
  clarifyRoute?(query: string, options: RoutePlaceOption[], history: Message[], signal: AbortSignal,
    policy?: RouteClarificationPolicy): Promise<RouteClarification>;
  resolveRoute?(query: string, history: Message[], signal: AbortSignal,
    update?: (event: ReplyUpdate) => void): Promise<RouteResolution>;
  reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]): Promise<void>;
}
export type Event = { type: string; [key: string]: unknown };

export type DurableTurnCommit = {
  sessionId: string;
  topicId: string;
  topicLabel: string;
  messageId: string;
  turnId: string;
  content: string;
  createdAt: number;
  cognitiveMode?: string;
  reasoningEffort?: ReasoningEffort;
  retryOfTurnId?: string;
};

export type DurableAnswerStart = {
  sessionId: string;
  topicId: string;
  turnId: string;
  messageId: string;
  createdAt: number;
};

export type DurableAnswerCommit = {
  messageId: string;
  content: string;
  citations?: Citation[];
  updatedAt: number;
};

type DurableAcknowledgement = {
  result: 'started' | 'committed' | 'interrupted' | 'duplicate';
  sessionId: string;
  messageId: string;
  turnId: string;
  sequence: number;
};

export interface ConversationPersistence {
  commitUserTurn(input: DurableTurnCommit): DurableAcknowledgement;
  startAssistantAnswer(input: DurableAnswerStart): DurableAcknowledgement;
  checkpointAssistantAnswer(messageId: string, content: string, updatedAt: number): void;
  commitAssistantAnswer(input: DurableAnswerCommit): DurableAcknowledgement;
  interruptAssistantAnswer(turnId: string, updatedAt: number, reason?: string): DurableAcknowledgement;
}

export type ConversationRuntimeOptions = {
  sessionId: string;
  persistence: ConversationPersistence;
  initialTopic?: { id: string; label: string };
  idFactory?: () => string;
  now?: () => number;
  checkpointChars?: number;
  checkpointMs?: number;
  /** Runs only after the complete assistant answer is durably committed. */
  onTurnCommitted?: () => void;
  recallHistory?: (query: string, signal: AbortSignal) => Promise<import('./history-recall.js').HistoryRecall>;
  recoverAnswer?: (request: string) => {
    kind: 'committed' | 'interrupted' | 'missing';
    turnId?: string;
    content?: string;
    citations?: Citation[];
  } | undefined;
};

class ConversationPersistenceError extends Error {}

const internalMetadataLeads = ['[application metadata', '[application topic metadata'];
const internalMetadataBlock = /^\[Application(?:\s+topic)?\s+metadata(?:\s*;\s*not user instructions)?\s*:[^\]\r\n]{0,512}\]$/i;
const internalMetadataPattern = /\[Application(?:\s+topic)?\s+metadata(?:\s*;\s*not user instructions)?\s*:[^\]\r\n]{0,512}\]/gi;
const internalReasoningLeads = ['[assistant/analysis]', '[assistant analysis]', '[analysis]'];

function isInternalReasoningOutput(value: string) {
  const candidate = value.trimStart().toLowerCase();
  return internalReasoningLeads.some(lead => candidate.startsWith(lead));
}

/** Defense in depth: backend routing metadata must never become user-visible. */
export function stripInternalMetadata(value: string) {
  return value.replace(internalMetadataPattern, '').replace(/^[ \t]*\r?\n/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

class InternalMetadataFilter {
  private pending = '';
  private reasoningDecision = false;
  rejectedReasoning = false;
  push(value: string) {
    if (this.rejectedReasoning) return '';
    this.pending += value;
    if (!this.reasoningDecision) {
      const candidate = this.pending.trimStart().toLowerCase();
      if (internalReasoningLeads.some(lead => lead.startsWith(candidate))) return '';
      if (internalReasoningLeads.some(lead => candidate.startsWith(lead))) {
        this.rejectedReasoning = true; this.pending = ''; return '';
      }
      this.reasoningDecision = true;
    }
    let visible = '';
    while (this.pending) {
      const start = this.pending.indexOf('[');
      if (start >= 0) {
        visible += this.pending.slice(0, start);
        const fragment = this.pending.slice(start), lower = fragment.toLowerCase();
        const end = fragment.indexOf(']');
        if (end < 0 && internalMetadataLeads.some(lead => lead.startsWith(lower) || lower.startsWith(lead))) {
          this.pending = fragment; break;
        }
        if (end >= 0) {
          const block = fragment.slice(0, end + 1);
          if (internalMetadataBlock.test(block)) { this.pending = fragment.slice(end + 1); continue; }
          visible += block; this.pending = fragment.slice(end + 1); continue;
        }
        visible += '['; this.pending = fragment.slice(1); continue;
      }
      visible += this.pending; this.pending = ''; break;
    }
    return visible;
  }
  flush() {
    if (this.rejectedReasoning) { this.pending = ''; return ''; }
    const lower = this.pending.toLowerCase();
    const value = internalMetadataLeads.some(lead => lead.startsWith(lower) || lower.startsWith(lead)) ? '' : this.pending;
    this.pending = ''; return stripInternalMetadata(value);
  }
}

/** Logical conversation, independent of microphone, transport and G2 UI. */
export class Conversation {
  history: Message[] = [];
  state: 'listening' | 'thinking' | 'answering' | 'paused' | 'exit_pending' | 'closed' = 'listening';
  pending = '';
  private revision = 0;
  private work?: AbortController;
  private responseId?: number;
  private partial = '';
  private citations: Citation[] = [];
  private committing = false;
  private currentTopic?: { id: string; label: string };
  private responseTopic?: { id: string; label: string; mode?: CognitiveMode };
  private topicCounter = 0;
  private durableAnswer?: { turnId: string; messageId: string };
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private lastCheckpointAt = 0;
  private lastCheckpointLength = 0;
  constructor(private model: DialogueModel, private eventSink: ((event: Event) => void) | undefined,
    private save: (history: Message[]) => Promise<void> = async () => {},
    private runtime?: ConversationRuntimeOptions,
    private contextBuilder: ContextComposer = new ContextBuilder()) {
    this.now = runtime?.now ?? Date.now;
    this.idFactory = runtime?.idFactory ?? randomUUID;
    if (runtime?.initialTopic) this.currentTopic = { ...runtime.initialTopic };
  }

  /** A logical conversation may outlive any individual WebSocket connection. */
  replaceEventSink(sink: ((event: Event) => void) | undefined) { this.eventSink = sink; }
  restoreHistory(history: Message[]) {
    if (this.work || this.responseId !== undefined || this.state === 'closed') throw new Error('Conversation cannot hydrate while active');
    if (history.length > 500 || history.some(message => !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || message.content.length > 120_000)) throw new Error('Invalid conversation history');
    this.history = history.map(message => ({ ...message, citations: message.citations?.map(citation => ({ ...citation })) }));
    const lastTopic = [...this.history].reverse().find(message => message.topicId && message.topicLabel);
    this.currentTopic = lastTopic?.topicId && lastTopic.topicLabel
      ? { id: lastTopic.topicId, label: lastTopic.topicLabel } : this.currentTopic;
    this.pending = '';
    this.state = 'listening';
  }
  private emit(event: Event) { this.eventSink?.(event); }

  get acceptsInput() { return !['paused', 'exit_pending', 'closed'].includes(this.state); }
  private status(state: Conversation['state']) { this.state = state; this.emit({ type: 'state', state }); }
  private cancel() {
    this.revision++; this.work?.abort(); this.work = undefined;
    if (this.responseId !== undefined) {
      const committing = this.committing; this.committing = false;
      if (this.durableAnswer && !committing) {
        try {
          if (this.partial) this.runtime?.persistence.checkpointAssistantAnswer(
            this.durableAnswer.messageId, stripInternalMetadata(this.partial), this.now());
          this.runtime?.persistence.interruptAssistantAnswer(this.durableAnswer.turnId, this.now());
        } catch { this.emit({ type: 'error', code: 'SAVE_FAILED' }); }
      }
      this.emit({ type: 'answer.cancelled', id: this.responseId });
      if (this.partial && !committing) this.history.push({ role: 'assistant', content: this.partial + '\n[回答被用户打断，未完成]', citations: this.citations,
        topicId: this.responseTopic?.id, topicLabel: this.responseTopic?.label, cognitiveMode: this.responseTopic?.mode,
        assistantMode: this.responseTopic?.mode, messageId: this.durableAnswer?.messageId, status: 'interrupted' });
      this.responseId = undefined; this.partial = ''; this.citations = [];
      this.responseTopic = undefined; this.durableAnswer = undefined;
    }
  }
  interrupt() {
    if (!this.acceptsInput) return;
    this.cancel(); this.status('listening');
  }
  pause() {
    if (!this.acceptsInput) return;
    this.cancel(); this.status('paused'); void this.persist();
  }
  resume() { if (this.state === 'paused') this.status('listening'); }
  async persist() {
    try { await this.save(this.history.map(item => ({ ...item,
      content: item.role === 'assistant' ? stripInternalMetadata(item.content) : item.content }))); return true; }
    catch { this.emit({ type: 'error', code: 'SAVE_FAILED' }); return false; }
  }
  async requestExit() {
    if (this.state === 'closed' || this.state === 'exit_pending') return;
    this.cancel(); this.status('exit_pending'); // Stop capture before storage/network work.
    this.emit({ type: 'exit.confirmation_required' });
    await this.persist();
  }
  confirmExit(confirm: boolean) {
    if (this.state !== 'exit_pending') return;
    this.status(confirm ? 'closed' : 'paused');
  }
  close() { this.cancel(); this.status('closed'); void this.persist(); }
  private resolveTopic(plan: TurnPlan) {
    const existing = new Map(this.history.filter(message => message.topicId && message.topicLabel)
      .map(message => [message.topicId!, { id: message.topicId!, label: message.topicLabel! }]));
    if (this.currentTopic) existing.set(this.currentTopic.id, this.currentTopic);
    const requestedLabel = plan.topicLabel?.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    if (plan.topicAction === 'resume' && plan.topicTarget && existing.has(plan.topicTarget)) {
      this.currentTopic = existing.get(plan.topicTarget);
    } else if (plan.topicAction === 'switch' || !this.currentTopic) {
      this.currentTopic = { id: this.runtime ? this.idFactory() : `topic-${++this.topicCounter}`,
        label: requestedLabel || plan.cognitiveMode || plan.assistantMode || 'conversation' };
    }
    return this.currentTopic!;
  }
  async submit(text: string, forced = false, identity?: { messageId?: string; retryOfTurnId?: string }) {
    if (!this.acceptsInput) return;
    const clean = text.trim();
    if (clean.length > 6000 || this.pending.length + clean.length > 12000) {
      this.emit({ type: 'error', code: 'INPUT_LIMIT' }); this.pause(); return;
    }
    if (clean) this.pending = [this.pending, clean].filter(Boolean).join('\n');
    if (!this.pending) return;
    this.cancel();
    const revision = this.revision, controller = this.work = new AbortController();
    const current = () => revision === this.revision && !controller.signal.aborted;
    this.status('thinking');
    try {
      const text = this.pending;
      const history = this.contextBuilder.build({ messages: this.history,
        currentTopicId: this.currentTopic?.id, pendingUserTurn: true }).messages;
      const recovery = this.runtime?.recoverAnswer?.(text);
      const rawPlan = recovery?.kind === 'committed' || recovery?.kind === 'missing'
        ? { decision: 'respond' as const, cognitiveMode: 'casual' as const, reasoningEffort: 'low' as const,
          workflows: [] as WorkflowSelection[] }
        : this.model.plan ? await this.model.plan(history, text, forced, controller.signal)
          : { decision: await this.model.decide(history, text, forced, controller.signal) };
      const plan = normalizeTurnPlan(rawPlan);
      const { decision } = plan;
      if (!current()) return;
      if (decision === 'wait' && !forced) {
        this.status('listening'); this.emit({ type: 'turn.waiting', text }); return;
      }
      const topic = this.resolveTopic(plan);
      this.pending = '';
      let turnId: string | undefined, userMessageId: string | undefined, userSequence: number | undefined;
      if (this.runtime) {
        try {
          userMessageId = identity?.messageId ?? this.idFactory();
          const acknowledgement = this.runtime.persistence.commitUserTurn({
            sessionId: this.runtime.sessionId,
            topicId: topic.id,
            topicLabel: topic.label,
            messageId: userMessageId,
            turnId: this.idFactory(),
            content: text,
            createdAt: this.now(),
            cognitiveMode: plan.cognitiveMode,
            reasoningEffort: plan.reasoningEffort,
            retryOfTurnId: identity?.retryOfTurnId ?? recovery?.turnId,
          });
          turnId = acknowledgement.turnId;
          userSequence = acknowledgement.sequence;
          this.emit({ type: 'message.ack', session_id: this.runtime.sessionId, message_id: userMessageId,
            turn_id: turnId, sequence: userSequence, result: acknowledgement.result });
          if (acknowledgement.result === 'duplicate') {
            this.status('listening');
            return;
          }
        } catch (error) { throw new ConversationPersistenceError(String(error)); }
      }
      this.history.push({ role: 'user', content: text, topicId: topic.id, topicLabel: topic.label,
        cognitiveMode: plan.cognitiveMode, assistantMode: plan.cognitiveMode,
        messageId: userMessageId, sequence: userSequence, status: 'committed' });
      this.emit({ type: 'turn.committed', text, topicId: topic.id, topicLabel: topic.label,
        ...(this.runtime ? { session_id: this.runtime.sessionId, message_id: userMessageId,
          turn_id: turnId, sequence: userSequence } : {}) });
      if (decision === 'exit') { await this.requestExit(); return; }
      this.responseId = revision; this.partial = ''; this.citations = [];
      this.responseTopic = { ...topic, mode: plan.cognitiveMode };
      let assistantMessageId: string | undefined, assistantSequence: number | undefined;
      if (this.runtime) {
        try {
          assistantMessageId = this.idFactory();
          const acknowledgement = this.runtime.persistence.startAssistantAnswer({
            sessionId: this.runtime.sessionId,
            topicId: topic.id,
            turnId: turnId!,
            messageId: assistantMessageId,
            createdAt: this.now(),
          });
          assistantSequence = acknowledgement.sequence;
          this.durableAnswer = { turnId: turnId!, messageId: assistantMessageId };
          this.lastCheckpointAt = this.now(); this.lastCheckpointLength = 0;
        } catch (error) { throw new ConversationPersistenceError(String(error)); }
      }
      this.status('answering'); this.emit({ type: 'answer.start', id: revision,
        ...(this.runtime ? { session_id: this.runtime.sessionId, message_id: assistantMessageId,
          turn_id: turnId, sequence: assistantSequence } : {}),
        reasoningEffort: decision === 'clarify_exit' ? undefined : plan.reasoningEffort,
        cognitiveMode: decision === 'clarify_exit' ? undefined : plan.cognitiveMode,
        assistantMode: decision === 'clarify_exit' ? undefined : plan.cognitiveMode,
        workflows: decision === 'clarify_exit' ? [] : plan.workflows,
        taskKind: decision === 'clarify_exit' ? undefined : plan.taskKind });
      const visible = new InternalMetadataFilter();
      const append = (value: string) => {
        if (!current()) return;
        this.partial += value; this.emit({ type: 'answer.delta', id: revision, text: value,
          ...(this.runtime && this.durableAnswer ? { session_id: this.runtime.sessionId,
            message_id: this.durableAnswer.messageId, turn_id: this.durableAnswer.turnId,
            sequence: assistantSequence } : {}) });
        if (this.durableAnswer) {
          const now = this.now();
          const enoughText = this.partial.length - this.lastCheckpointLength >= (this.runtime?.checkpointChars ?? 512);
          const enoughTime = now - this.lastCheckpointAt >= (this.runtime?.checkpointMs ?? 500);
          if (enoughText || enoughTime) {
            try {
              this.runtime!.persistence.checkpointAssistantAnswer(
                this.durableAnswer.messageId, stripInternalMetadata(this.partial), now);
              this.lastCheckpointAt = now; this.lastCheckpointLength = this.partial.length;
            } catch (error) { throw new ConversationPersistenceError(String(error)); }
          }
        }
      };
      const delta = (value: string) => { const safe = visible.push(value); if (safe) append(safe); };
      if (recovery?.kind === 'committed') {
        const content = stripInternalMetadata(recovery.content ?? '');
        if (!content) throw new ConversationPersistenceError('Stored answer is empty');
        this.partial = content;
        this.citations = recovery.citations?.map(citation => ({ ...citation })) ?? [];
        if (this.citations.length) this.emit({ type: 'answer.citations', id: revision, text: content,
          citations: this.citations, ...(this.runtime && this.durableAnswer ? { session_id: this.runtime.sessionId,
            message_id: this.durableAnswer.messageId, turn_id: this.durableAnswer.turnId,
            sequence: assistantSequence } : {}) });
        else this.emit({ type: 'answer.delta', id: revision, text: content,
          ...(this.runtime && this.durableAnswer ? { session_id: this.runtime.sessionId,
            message_id: this.durableAnswer.messageId, turn_id: this.durableAnswer.turnId,
            sequence: assistantSequence } : {}) });
      } else if (recovery?.kind === 'missing') delta('当前会话里没有可以恢复的上一轮回答。');
      else if (decision === 'clarify_exit') delta('你是想结束这次对话，还是继续聊？');
      else {
        let recall: import('./history-recall.js').HistoryRecall | undefined;
        if (typeof plan.historyQuery === 'string' && plan.historyQuery.trim()) {
          try { recall = await this.runtime?.recallHistory?.(plan.historyQuery, controller.signal)
            ?? { status: 'unavailable', incomplete: true, messages: [] }; }
          catch { controller.signal.throwIfAborted(); recall = { status: 'unavailable', incomplete: true, messages: [] }; }
          if (!current()) return;
        }
        const replyContext = this.contextBuilder.build({ messages: this.history, currentTopicId: topic.id, recall }).messages;
        if (recall && !replyContext.some(message => message.contextKind === 'history')) {
          delta('这轮上下文空间不够，暂时没能带回历史资料。你能把想回顾的那个问题单独问我一次吗？');
        } else await this.model.reply(replyContext, controller.signal, delta, event => {
          if (!current()) return;
          if (event.type === 'answer.citations') {
            const sanitized = stripInternalMetadata(event.text);
            const text = isInternalReasoningOutput(sanitized)
              ? '我刚才没有把话组织好，抱歉。请再跟我说一次，我会认真接住。' : sanitized;
            this.partial = text;
            // Internal metadata is not a source. If it was echoed, retain only
            // citations that still point inside the sanitized visible answer.
            this.citations = event.citations.filter(citation => citation.start >= 0 && citation.end <= text.length);
            this.emit({ ...event, text, citations: this.citations, id: revision }); return;
          }
          this.emit({ ...event, id: revision });
        }, plan.reasoningEffort, plan.cognitiveMode, plan.workflows);
      }
      if (!current()) return;
      const tail = visible.flush(); if (tail) append(tail);
      if (visible.rejectedReasoning) {
        console.warn(JSON.stringify({ event: 'internal_reasoning_output_rejected' }));
        if (!this.partial) append('我刚才没有把话组织好，抱歉。请再跟我说一次，我会认真接住。');
      }
      this.partial = stripInternalMetadata(this.partial);
      this.history.push({ role: 'assistant', content: this.partial, citations: this.citations,
        topicId: topic.id, topicLabel: topic.label, cognitiveMode: plan.cognitiveMode, assistantMode: plan.cognitiveMode,
        messageId: assistantMessageId, sequence: assistantSequence, status: 'committed' });
      this.committing = true;
      let durableCommit: DurableAcknowledgement | undefined;
      if (this.durableAnswer) {
        try {
          durableCommit = this.runtime!.persistence.commitAssistantAnswer({
            messageId: this.durableAnswer.messageId,
            content: this.partial,
            citations: this.citations,
            updatedAt: this.now(),
          });
        } catch (error) { this.committing = false; throw new ConversationPersistenceError(String(error)); }
      }
      const saved = await this.persist();
      this.committing = false;
      if (!current()) return;
      if (!saved) {
        this.responseId = undefined; this.partial = ''; this.citations = []; this.responseTopic = undefined;
        this.durableAnswer = undefined;
        this.status('paused'); return;
      }
      if (durableCommit) this.emit({ type: 'answer.committed', id: revision,
        session_id: durableCommit.sessionId, message_id: durableCommit.messageId,
          turn_id: durableCommit.turnId, sequence: durableCommit.sequence, content: this.partial });
      try { this.runtime?.onTurnCommitted?.(); } catch { /* Background maintenance cannot fail the user turn. */ }
      this.emit({ type: 'answer.done', id: revision,
        ...(durableCommit ? { session_id: durableCommit.sessionId, message_id: durableCommit.messageId,
          turn_id: durableCommit.turnId, sequence: durableCommit.sequence } : {}) });
      this.responseId = undefined; this.partial = '';
      this.responseTopic = undefined; this.durableAnswer = undefined;
      this.status('listening');
    } catch (error) {
      if (!current()) return;
      this.cancel(); this.status('paused');
      if (error instanceof Error && error.message === 'GUEST_RUNTIME_BUSY') {
        this.emit({ type: 'notice', code: 'GUEST_RUNTIME_BUSY',
          text: '上一条请求仍在处理，请稍候再试。这次没有重复执行。' });
        return;
      }
      this.emit({ type: 'error',
        code: error instanceof ConversationPersistenceError ? 'SAVE_FAILED' : 'MODEL_FAILED' });
    }
  }
}
