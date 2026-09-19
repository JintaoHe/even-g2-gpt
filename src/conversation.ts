export type Citation = { start: number; end: number; url: string; title: string };
export type ReplyUpdate = { type: 'search.status'; status: string } | { type: 'calendar.status'; status: 'planning' | 'querying' | 'saving' }
  | { type: 'route.status'; status: 'locating' | 'resolving' | 'searching' | 'routing' | 'comparing' | 'clarifying' }
  | { type: 'route.status'; status: 'failed'; stage: 'places' | 'routes' | 'unknown'; provider_status?: number; provider_reason?: string }
  | { type: 'task.status'; status: 'planning' | 'calendar' | 'locating' | 'environment' | 'places' | 'deciding' | 'previewing' | 'saving' }
  | { type: 'artifact.status'; status: 'generating' | 'sending' }
  | { type: 'answer.citations'; text: string; citations: Citation[] };
export type TopicAction = 'continue' | 'switch' | 'resume';
export type Message = { role: 'user' | 'assistant'; content: string; citations?: Citation[];
  topicId?: string; topicLabel?: string; cognitiveMode?: CognitiveMode; assistantMode?: AssistantMode };

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
export type LocationAction = 'none' | 'route_eta' | 'nearby_search' | 'recompare' | 'cancel';
export type TaskKind = 'outdoor_activity';
export type TaskAction = 'none' | 'conditional_task' | 'confirm_conditional' | 'cancel_conditional';
export type WorkflowKind = 'search' | 'navigation' | 'environment' | 'calendar' | 'document' | 'email' | 'memory' | 'list' | 'conditional_task';
export type WorkflowSelection = { kind: WorkflowKind; action: string; taskKind?: TaskKind };
export type SearchAction = 'none' | 'search';
export type RouteTravelMode = 'drive' | 'walk' | 'bicycle';
export type RoutePlaceOption = { name: string; address?: string; primaryType?: string; types?: string[] };
export type RouteClarification = { action: 'proceed'; selectedIndices: number[] }
  | { action: 'ask'; selectedIndices: []; question: string };
export type RouteResolution = { action: 'resolved'; destination: string }
  | { action: 'ask'; question: string }
  | { action: 'not_found' };
export type TurnPlan = { decision: Decision; cognitiveMode?: CognitiveMode; assistantMode?: AssistantMode; reasoningEffort?: ReasoningEffort;
  topicAction?: TopicAction; topicTarget?: string | null; topicLabel?: string | null;
  deliveryAction?: import('./delivery-intent.js').DeliveryAction;
  calendarAction?: import('./calendar-planner.js').CalendarAction; locationAction?: LocationAction;
  searchAction?: SearchAction; taskAction?: TaskAction; taskKind?: TaskKind | null; workflows?: WorkflowSelection[];
  routeDestination?: string | null; routeOrigin?: string | null; routeMode?: RouteTravelMode; routeModeExplicit?: boolean };

/** Normalize one model classification into the backend-owned routing vocabulary. */
export function normalizeTurnPlan(plan: TurnPlan): TurnPlan {
  const cognitiveMode = plan.cognitiveMode ?? plan.assistantMode;
  const taskKind = plan.taskAction && plan.taskAction !== 'none' ? plan.taskKind ?? 'outdoor_activity' : null;
  const workflows: WorkflowSelection[] = [];
  const add = (workflow: WorkflowSelection) => {
    if (!workflows.some(current => current.kind === workflow.kind && current.action === workflow.action)) workflows.push(workflow);
  };
  if (plan.searchAction === 'search' || (plan.searchAction === undefined && cognitiveMode === 'research')) add({ kind: 'search', action: 'read' });
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
  clarifyRoute?(query: string, options: RoutePlaceOption[], history: Message[], signal: AbortSignal): Promise<RouteClarification>;
  resolveRoute?(query: string, history: Message[], signal: AbortSignal,
    update?: (event: ReplyUpdate) => void): Promise<RouteResolution>;
  reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]): Promise<void>;
}
export type Event = { type: string; [key: string]: unknown };

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
  private currentTopic?: { id: string; label: string };
  private responseTopic?: { id: string; label: string; mode?: CognitiveMode };
  private topicCounter = 0;
  constructor(private model: DialogueModel, private emit: (event: Event) => void,
    private save: (history: Message[]) => Promise<void> = async () => {}) {}

  get acceptsInput() { return !['paused', 'exit_pending', 'closed'].includes(this.state); }
  private status(state: Conversation['state']) { this.state = state; this.emit({ type: 'state', state }); }
  private cancel() {
    this.revision++; this.work?.abort(); this.work = undefined;
    if (this.responseId !== undefined) {
      this.emit({ type: 'answer.cancelled', id: this.responseId });
      if (this.partial) this.history.push({ role: 'assistant', content: this.partial + '\n[回答被用户打断，未完成]', citations: this.citations,
        topicId: this.responseTopic?.id, topicLabel: this.responseTopic?.label, cognitiveMode: this.responseTopic?.mode,
        assistantMode: this.responseTopic?.mode });
      this.responseId = undefined; this.partial = ''; this.citations = [];
      this.responseTopic = undefined;
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
      content: item.role === 'assistant' ? stripInternalMetadata(item.content) : item.content }))); }
    catch { this.emit({ type: 'error', code: 'SAVE_FAILED' }); }
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
      this.currentTopic = { id: `topic-${++this.topicCounter}`, label: requestedLabel || plan.cognitiveMode || plan.assistantMode || 'conversation' };
    }
    return this.currentTopic!;
  }
  async submit(text: string, forced = false) {
    if (!this.acceptsInput) return;
    const clean = text.trim();
    if (clean.length > 6000 || this.pending.length + clean.length > 12000) {
      this.emit({ type: 'error', code: 'INPUT_LIMIT' }); this.pause(); return;
    }
    if (clean) this.pending = [this.pending, clean].filter(Boolean).join('\n');
    if (!this.pending) return;
    this.cancel();
    if (this.history.length >= 100) { this.emit({ type: 'error', code: 'HISTORY_LIMIT' }); this.pause(); return; }
    const revision = this.revision, controller = this.work = new AbortController();
    const current = () => revision === this.revision && !controller.signal.aborted;
    this.status('thinking');
    try {
      const text = this.pending;
      const history = this.history.map(m => ({ ...m }));
      const rawPlan = this.model.plan ? await this.model.plan(history, text, forced, controller.signal)
        : { decision: await this.model.decide(history, text, forced, controller.signal) };
      const plan = normalizeTurnPlan(rawPlan);
      const { decision } = plan;
      if (!current()) return;
      if (decision === 'wait' && !forced) {
        this.status('listening'); this.emit({ type: 'turn.waiting', text }); return;
      }
      const topic = this.resolveTopic(plan);
      this.pending = '';
      this.history.push({ role: 'user', content: text, topicId: topic.id, topicLabel: topic.label,
        cognitiveMode: plan.cognitiveMode, assistantMode: plan.cognitiveMode });
      this.emit({ type: 'turn.committed', text, topicId: topic.id, topicLabel: topic.label });
      if (decision === 'exit') { await this.requestExit(); return; }
      this.responseId = revision; this.partial = ''; this.citations = [];
      this.responseTopic = { ...topic, mode: plan.cognitiveMode };
      this.status('answering'); this.emit({ type: 'answer.start', id: revision,
        reasoningEffort: decision === 'clarify_exit' ? undefined : plan.reasoningEffort,
        cognitiveMode: decision === 'clarify_exit' ? undefined : plan.cognitiveMode,
        assistantMode: decision === 'clarify_exit' ? undefined : plan.cognitiveMode,
        workflows: decision === 'clarify_exit' ? [] : plan.workflows,
        taskKind: decision === 'clarify_exit' ? undefined : plan.taskKind });
      const visible = new InternalMetadataFilter();
      const append = (value: string) => {
        if (!current()) return;
        this.partial += value; this.emit({ type: 'answer.delta', id: revision, text: value });
      };
      const delta = (value: string) => { const safe = visible.push(value); if (safe) append(safe); };
      if (decision === 'clarify_exit') delta('你是想结束这次对话，还是继续聊？');
      else await this.model.reply(this.history.map(message => ({ ...message })), controller.signal, delta, event => {
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
      if (!current()) return;
      const tail = visible.flush(); if (tail) append(tail);
      if (visible.rejectedReasoning) {
        console.warn(JSON.stringify({ event: 'internal_reasoning_output_rejected' }));
        if (!this.partial) append('我刚才没有把话组织好，抱歉。请再跟我说一次，我会认真接住。');
      }
      this.partial = stripInternalMetadata(this.partial);
      this.history.push({ role: 'assistant', content: this.partial, citations: this.citations,
        topicId: topic.id, topicLabel: topic.label, cognitiveMode: plan.cognitiveMode, assistantMode: plan.cognitiveMode });
      this.emit({ type: 'answer.done', id: revision });
      this.responseId = undefined; this.partial = '';
      this.responseTopic = undefined;
      this.status('listening'); await this.persist();
    } catch {
      if (!current()) return;
      this.cancel(); this.status('paused'); this.emit({ type: 'error', code: 'MODEL_FAILED' });
    }
  }
}
