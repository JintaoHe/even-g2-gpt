import type { DialogueModel, Message, TurnPlan, ReplyUpdate, ReasoningEffort, AssistantMode, WorkflowSelection } from './conversation.js';
import { GuestDraftRuntime } from './guest-draft-runtime.js';
import { documentWarning } from './document-presentation.js';

type Action = 'none' | 'document' | 'revise' | 'review' | 'cancel' | 'denied';
const denied = '现在是访客模式，可以聊天、搜索、查路线或整理本次会话的草稿；不能访问主人的日历、邮件和私人记录，也不能发送邮件。';
const allowedWorkflows = new Set(['search', 'navigation', 'document']);

/** No private tool references exist in this component. The outer runtime supplies
 * scoped history and guards all callbacks; LocationDialogue may add public evidence. */
export class GuestDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, { action: Action; plan: TurnPlan }>();
  constructor(private base: DialogueModel, private drafts: GuestDraftRuntime) {}
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    const raw = this.base.plan ? await this.base.plan(history, text, forced, signal)
      : { decision: await this.base.decide(history, text, forced, signal) };
    signal.throwIfAborted();
    let action: Action = raw.deliveryAction && ['document', 'revise', 'review', 'cancel'].includes(raw.deliveryAction)
      ? raw.deliveryAction as Action : raw.deliveryAction && raw.deliveryAction !== 'none' ? 'denied' : 'none';
    if ((raw.calendarAction && raw.calendarAction !== 'none') || (raw.taskAction && raw.taskAction !== 'none')
      || raw.workflows?.some(w => !allowedWorkflows.has(w.kind)
        && !(w.kind === 'email' && ['document', 'revise', 'review', 'cancel'].includes(action)))) action = 'denied';
    if (raw.historyQuery) action = 'denied';
    const plan: TurnPlan = { ...raw, historyQuery: null, deliveryAction: 'none', calendarAction: 'none', taskAction: 'none', taskKind: null,
      ...(action !== 'none' ? { locationAction: 'none', searchAction: 'none' } : {}),
      workflows: action === 'none' ? raw.workflows?.filter(w => allowedWorkflows.has(w.kind)) : [] };
    this.plans.set(signal, { action, plan });
    return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    return (await this.plan(history, text, forced, signal)).decision;
  }
  clarifyRoute: NonNullable<DialogueModel['clarifyRoute']> = (...args) => {
    if (!this.base.clarifyRoute) throw new Error('ROUTE_UNAVAILABLE');
    return this.base.clarifyRoute(...args);
  };
  verifyPlaceHours: NonNullable<DialogueModel['verifyPlaceHours']> = (...args) =>
    this.base.verifyPlaceHours?.(...args) ?? Promise.resolve(undefined);
  resolveRoute: NonNullable<DialogueModel['resolveRoute']> = (...args) => {
    if (!this.base.resolveRoute) throw new Error('ROUTE_UNAVAILABLE');
    return this.base.resolveRoute(...args);
  };
  async reply(history: Message[], signal: AbortSignal, delta: (text: string) => void,
    update?: (event: ReplyUpdate) => void, effort?: ReasoningEffort, mode?: AssistantMode, _workflows?: WorkflowSelection[]) {
    const entry = this.plans.get(signal); this.plans.delete(signal);
    if (!entry) throw new Error('GUEST_PLAN_REQUIRED');
    if (entry.action === 'denied') { delta(denied); return; }
    if (entry.action === 'cancel') { delta('好的，不会发送邮件。已保存的本次访客草稿仍保留。'); return; }
    if (entry.action === 'none') return this.base.reply(history, signal, delta, update, effort, mode,
      _workflows?.filter(w => allowedWorkflows.has(w.kind)) ?? entry.plan.workflows);
    try {
      if (entry.action !== 'review') update?.({ type: 'artifact.status', status: 'generating' });
      const result = entry.action === 'review' ? this.drafts.read() : await this.drafts.create(entry.action, signal);
      signal.throwIfAborted();
      if (!result) { delta('本次访客会话还没有草稿。你想整理什么内容？'); return; }
      if ('clarification' in result) { delta(result.clarification); return; }
      const metadata = result.document.presentation;
      delta(`已保存本次访客草稿：${metadata.title}\n${metadata.summary}\n${documentWarning(metadata)}\n可以继续修改；访客模式不发送邮件。`.replace(/\n\n/g, '\n'));
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof Error ? error.message : '';
      if (code === 'GUEST_DRAFT_LIMIT') delta('本次访客草稿已达到数量或大小上限，暂时无法新增或改稿；已有草稿仍可查看。');
      else if (code === 'GUEST_DRAFT_NOT_FOUND') delta('本次访客会话还没有可修改的草稿，请先告诉我要整理什么。');
      else throw error;
    }
  }
}
