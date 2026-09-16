import type { DialogueModel, Message, TurnPlan, ReplyUpdate, ReasoningEffort } from './conversation.js';
import type { Draft, DraftGenerator } from './delivery-draft.js';
import type { MailSender } from './mail.js';
import { JobStore } from './job-store.js';
import { calendarDetails } from './calendar.js';

type Approval = { id: string; prompt: string; expires: number };
type Plan = { plan: TurnPlan; approval?: Approval };
export const explicitSend = (text: string) => /^(?:确认发送|确认发出|可以发送|发送吧|发吧|confirm send|confirm sending|send it|yes,? send it)[。！.!\s]*$/i.test(text.trim());
export function deliveryResult(result: string): string {
  return result === 'accepted' ? '邮件已提交到发送服务器，请检查固定收件箱。日历附件仍需你确认导入。'
    : result === 'sending' ? '邮件正在发送，请勿重复确认。'
    : result === 'failed' ? '邮件发送失败，文件仍已保存。不会自动重发。'
    : '发送结果暂时无法确定。请先检查邮箱；为避免重复邮件，不会自动重发。';
}
/** Per-conversation state. Only a completed immutable artifact can receive one-use approval. */
export class DeliveryDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, Plan>();
  private approval?: Approval;
  private draft?: Draft;
  private jobId?: string;
  constructor(private base: DialogueModel, private jobs: JobStore, private generate: DraftGenerator,
    private sender?: MailSender, private now: () => number = Date.now) {}
  invalidate() { this.approval = undefined; }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    const approval = this.approval; this.invalidate();
    const plan = this.base.plan ? await this.base.plan(history, text, forced, signal)
      : { decision: await this.base.decide(history, text, forced, signal) };
    signal.throwIfAborted();
    this.plans.set(signal, { plan, approval });
    return plan;
  }
  async decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) { return (await this.plan(history, text, forced, signal)).decision; }
  private preview(delta: (text: string) => void, prefix = '') {
    if (!this.draft || !this.jobId || this.jobs.get(this.jobId)?.state !== 'completed' || this.jobs.superseded(this.jobId)) {
      delta('目前没有可发送的完整草稿，请先让我生成文件。'); return;
    }
    const prior = this.jobs.mailState(this.jobId);
    if (prior) { delta(deliveryResult(prior)); return; }
    const metadata = this.draft.document.presentation;
    const prompt = prefix + `文件已经生成：${metadata.filename}\n${metadata.summary}` +
      (this.draft.calendar ? `\n\n日历文件：\n${calendarDetails(this.draft.calendar)}\n不包含自动通知或闹钟。` : '') +
      (this.sender ? '\n\n确认发送到固定邮箱吗？请说“确认发送”；也可以要求修改、查看全文或说“取消发送”。' : '\n\n邮件发送未启用。文件已保存，可在网页下载；没有发送邮件。');
    delta(prompt);
    if (this.sender) this.approval = { id: this.jobId, prompt, expires: this.now() + 5 * 60000 };
  }
  async reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void, effort?: ReasoningEffort) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.deliveryAction ?? 'none';
    signal.throwIfAborted();
    if (action === 'none') { await this.base.reply(history, signal, delta, update, effort); return; }
    if (action === 'cancel') {
      this.invalidate();
      const prior = this.jobId && this.jobs.mailState(this.jobId);
      delta(prior ? '此前已有发送尝试，不能保证撤回。' + deliveryResult(prior) : '已取消发送。已生成的文件仍保留，没有因这次操作发送邮件。'); return;
    }
    if (action === 'confirm') {
      const approval = context?.approval;
      const lastAssistant = history.slice(0, -1).at(-1);
      if (!explicitSend(history.at(-1)?.content ?? '') || !approval || approval.expires <= this.now() || approval.id !== this.jobId
        || lastAssistant?.role !== 'assistant' || lastAssistant.content !== approval.prompt) {
        this.preview(delta); return; // Requires a fresh separate confirmation turn.
      }
      if (!this.sender) { delta('邮件发送未启用，没有发送。'); return; }
      this.invalidate(); signal.throwIfAborted();
      update?.({ type: 'artifact.status', status: 'sending' });
      try { const result = await this.jobs.email(approval.id, this.sender, signal); signal.throwIfAborted(); delta(deliveryResult(result)); }
      catch { signal.throwIfAborted(); delta('暂时无法发送。请检查任务状态或每日发送上限；不会自动重试。'); }
      return;
    }
    if (action === 'review') {
      this.preview(delta, this.draft ? this.draft.document.markdown + '\n\n' : ''); return;
    }
    if (this.jobId) this.jobs.supersede(this.jobId);
    this.invalidate();
    update?.({ type: 'artifact.status', status: 'generating' });
    let newJob: string | undefined;
    try {
      const generated = await this.generate(history, action, action === 'revise' ? this.draft : undefined, signal);
      signal.throwIfAborted();
      if ('clarification' in generated) { delta(generated.clarification + '\n尚未发送邮件。'); return; }
      const job = this.jobs.enqueueDocument(generated.document, generated.calendar); newJob = job.id;
      const deadline = this.now() + 30000;
      while (['queued', 'running'].includes(this.jobs.get(job.id)?.state ?? '')) {
        signal.throwIfAborted();
        if (this.now() > deadline) throw Error('DRAFT_SAVE_TIMEOUT');
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      signal.throwIfAborted();
      if (this.jobs.get(job.id)?.state !== 'completed') throw Error('DRAFT_SAVE_FAILED');
      this.draft = generated; this.jobId = job.id;
      this.preview(delta);
    } catch {
      if (newJob) { this.jobs.cancel(newJob); this.jobs.supersede(newJob); }
      signal.throwIfAborted();
      delta('文件未能完整生成或保存，没有发送邮件。请重新提出生成请求；不会用聊天记录代替你要求的文档。');
    }
  }
}
