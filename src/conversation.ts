export type Citation = { start: number; end: number; url: string; title: string };
export type ReplyUpdate = { type: 'search.status'; status: string } | { type: 'calendar.status'; status: 'planning' | 'querying' | 'saving' } | { type: 'artifact.status'; status: 'generating' | 'sending' } | { type: 'answer.citations'; text: string; citations: Citation[] };
export type Message = { role: 'user' | 'assistant'; content: string; citations?: Citation[] };
export type Decision = 'respond' | 'wait' | 'exit' | 'clarify_exit';
export type ReasoningEffort = 'none' | 'low' | 'medium';
export type TurnPlan = { decision: Decision; reasoningEffort?: ReasoningEffort; deliveryAction?: import('./delivery-intent.js').DeliveryAction; calendarAction?: import('./calendar-planner.js').CalendarAction };
export interface DialogueModel {
  plan?(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan>;
  decide(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<Decision>;
  reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void, effort?: ReasoningEffort): Promise<void>;
}
export type Event = { type: string; [key: string]: unknown };

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
  constructor(private model: DialogueModel, private emit: (event: Event) => void,
    private save: (history: Message[]) => Promise<void> = async () => {}) {}

  get acceptsInput() { return !['paused', 'exit_pending', 'closed'].includes(this.state); }
  private status(state: Conversation['state']) { this.state = state; this.emit({ type: 'state', state }); }
  private cancel() {
    this.revision++; this.work?.abort(); this.work = undefined;
    if (this.responseId !== undefined) {
      this.emit({ type: 'answer.cancelled', id: this.responseId });
      if (this.partial) this.history.push({ role: 'assistant', content: this.partial + '\n[回答被用户打断，未完成]', citations: this.citations });
      this.responseId = undefined; this.partial = ''; this.citations = [];
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
    try { await this.save(this.history.map(item => ({ ...item }))); }
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
      const plan = this.model.plan ? await this.model.plan(history, text, forced, controller.signal)
        : { decision: await this.model.decide(history, text, forced, controller.signal) };
      const { decision } = plan;
      if (!current()) return;
      if (decision === 'wait' && !forced) {
        this.status('listening'); this.emit({ type: 'turn.waiting', text }); return;
      }
      this.pending = '';
      this.history.push({ role: 'user', content: text });
      this.emit({ type: 'turn.committed', text });
      if (decision === 'exit') { await this.requestExit(); return; }
      this.responseId = revision; this.partial = ''; this.citations = [];
      this.status('answering'); this.emit({ type: 'answer.start', id: revision,
        reasoningEffort: decision === 'clarify_exit' ? undefined : plan.reasoningEffort });
      const delta = (value: string) => {
        if (!current()) return;
        this.partial += value; this.emit({ type: 'answer.delta', id: revision, text: value });
      };
      if (decision === 'clarify_exit') delta('你是想结束这次对话，还是继续聊？');
      else await this.model.reply(this.history.map(m => ({ ...m })), controller.signal, delta, event => {
        if (!current()) return;
        if (event.type === 'answer.citations') { this.partial = event.text; this.citations = event.citations; }
        this.emit({ ...event, id: revision });
      }, plan.reasoningEffort);
      if (!current()) return;
      this.history.push({ role: 'assistant', content: this.partial, citations: this.citations });
      this.emit({ type: 'answer.done', id: revision });
      this.responseId = undefined; this.partial = '';
      this.status('listening'); await this.persist();
    } catch {
      if (!current()) return;
      this.cancel(); this.status('paused'); this.emit({ type: 'error', code: 'MODEL_FAILED' });
    }
  }
}
