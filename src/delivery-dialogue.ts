import type { DialogueModel, Message, TurnPlan, ReplyUpdate, ReasoningEffort } from './conversation.js';
import type { Draft, DraftGenerator } from './delivery-draft.js';
import type { MailSender } from './mail.js';
import { JobStore } from './job-store.js';
import { calendarDetails, calendarConfirmationPhrase, calendarApprovalMatches } from './calendar.js';

type Approval = { id: string; prompt: string; expires: number; retryAttempt?: number };
type Plan = { plan: TurnPlan; approval?: Approval };
export const explicitSend = (text: string) => /^(?:确认发送|确认发出|可以发送|发送吧|发吧|confirm send|confirm sending|send it|yes,? send it)[。！.!\s]*$/i.test(text.trim());
export const explicitResend = (text: string) => /^(?:确认重发|确认重新发送|重发吧|confirm resend|resend it|yes,? resend it)[。！.!\s]*$/i.test(text.trim());
// Additional semantic approval still requires the model's confirm classification AND the
// immediately preceding immutable preview. Reject common negation/correction/recipient changes.
export function naturalMailApproval(text: string) {
  const s = text.trim();
  return s.length <= 160 && /发|send|email|mail/i.test(s)
    && !/[?？“”"「」『』@]|不|没|别|吗|么|等等|等会|稍后|明天|以后|如果|假如|他说|她说|改|换|加|删|先.*再|刚才|已经|是否|能否|can you|could you|should|if\b|don't|not\b|\bno\b|never|later|tomorrow|said|change|instead|already|after/i.test(s)
    && !/发给\s*(?!我|自己|固定邮箱)[^\s，。！]|发(?:送)?到\s*(?!我的邮箱|我邮箱|固定邮箱)[^\s，。！]|\bto\s+(?!me\b|my\b|the fixed\b)/i.test(s);
}
export const mailFallback = '请先稍等片刻，检查垃圾邮件、所有邮件，并搜索“Even 笔记”。也可到网页文件列表直接下载 MD／ICS；无需重新生成文件或开放收件箱权限。';
export function deliveryResult(result: string): string {
  return result === 'accepted' ? '邮件已成功提交发送（邮件服务器已接受），请确认是否收到？你可以说“收到了”或“没收到”。我无法直接核实收件箱送达情况。'
    : result === 'sending' ? '邮件正在发送，请勿重复确认。'
    : result === 'failed' ? '邮件发送失败，文件仍已保存。可以要求重发并再次确认，或在网页直接下载。不会自动重发。'
    : '发送结果暂时无法确定，可能已经发出。请先检查邮箱；确认没收到后可以要求重发，或在网页直接下载。不会自动重发。';
}
/** Per-conversation state. Only a completed immutable artifact can receive one-use approval. */
export class DeliveryDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, Plan>();
  private approval?: Approval;
  private draft?: Draft;
  private jobId?: string;
  constructor(private base: DialogueModel, private jobs: JobStore, private generate: DraftGenerator,
    private sender?: MailSender, private now: () => number = Date.now, private notifyResult?: (id: string, result: string) => void) {}
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
      (this.sender ? `\n\n${this.draft.calendar ? '请核对以上日期与主时区。' : ''}确认发送到固定邮箱吗？可以说“可以，发给我吧”，也可以要求修改、查看全文或说“取消发送”。` : '\n\n邮件发送未启用。文件已保存，可在网页下载；没有发送邮件。');
    delta(prompt);
    if (this.sender) this.approval = { id: this.jobId, prompt, expires: this.now() + 5 * 60000 };
  }
  private retryPreview(delta: (text: string) => void) {
    if (!this.jobId || !this.jobs.mailState(this.jobId)) { delta('当前对话没有可核实的发送记录。请在网页文件列表查看对应文件，预览后发送或直接下载。'); return; }
    if (!this.sender || !this.jobs.canRetryEmail(this.jobId)) {
      delta('目前不能再次发送：可能已确认收到、仍在发送、旧版已失效，或已用完这份文件的一次重发机会。' + mailFallback); return;
    }
    const calendar = this.jobs.calendar(this.jobId);
    const prompt = `${mailFallback}\n\n要将同一份文件“${this.jobs.metadata(this.jobId)?.filename ?? '谈话笔记.md'}”再发送一次到固定邮箱吗？内容不会改变；前一封可能延迟到达，因此可能收到两封。每份文件最多重发一次。${calendar ? '\n' + calendarDetails(calendar) + '\n' : ''}请说“${calendar ? calendarConfirmationPhrase(calendar, true) : '确认重发'}”，或说“取消发送”。`;
    delta(prompt); this.approval = { id: this.jobId, prompt, expires: this.now() + 5 * 60000, retryAttempt: this.jobs.mailAttempts(this.jobId) };
  }
  async reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void, effort?: ReasoningEffort) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.deliveryAction ?? 'none';
    signal.throwIfAborted();
    if (action === 'none') { await this.base.reply(history, signal, delta, update, effort); return; }
    if (action === 'not_received') { this.retryPreview(delta); return; }
    if (action === 'received') {
      if (!this.jobId || !this.jobs.mailState(this.jobId) || this.jobs.mailState(this.jobId) === 'sending') { delta('谢谢反馈。当前没有可关联的已结束发送记录；你也可以在网页文件列表标记对应邮件已收到。'); return; }
      this.jobs.acknowledgeReceipt(this.jobId); this.invalidate();
      delta('好的，已记录你确认收到，不会再重发这份文件。' + (this.draft?.calendar ? '日历仍需你打开 ICS 附件确认导入。' : '')); return;
    }
    if (action === 'cancel') {
      this.invalidate();
      const prior = this.jobId && this.jobs.mailState(this.jobId);
      delta(prior ? '此前已有发送尝试，不能保证撤回。' + deliveryResult(prior) : '已取消发送。已生成的文件仍保留，没有因这次操作发送邮件。'); return;
    }
    if (action === 'confirm') {
      const approval = context?.approval;
      const lastAssistant = history.slice(0, -1).at(-1);
      const text = history.at(-1)?.content ?? '';
      const calendar = this.jobId ? this.jobs.calendar(this.jobId) : undefined;
      const validPhrase = calendar ? calendarApprovalMatches(text, calendar, !!approval?.retryAttempt)
          || (naturalMailApproval(text) && !/芝加哥|纽约|洛杉矶|时区|Chicago|New York|Los Angeles|UTC|GMT|\d|明天|后天/.test(text))
        : (approval?.retryAttempt ? explicitResend(text) : explicitSend(text)) || naturalMailApproval(text);
      if (!validPhrase || !approval || approval.expires <= this.now() || approval.id !== this.jobId
        || lastAssistant?.role !== 'assistant' || lastAssistant.content !== approval.prompt) {
        if (approval?.retryAttempt || explicitResend(text) || (calendar && calendarApprovalMatches(text, calendar, true))) this.retryPreview(delta); else this.preview(delta);
        return; // Requires a fresh separate confirmation turn.
      }
      if (!this.sender) { delta('邮件发送未启用，没有发送。'); return; }
      this.invalidate(); signal.throwIfAborted();
      update?.({ type: 'artifact.status', status: 'sending' });
      try {
        const result = approval.retryAttempt ? await this.jobs.retryEmail(approval.id, this.sender, approval.retryAttempt, signal) : await this.jobs.email(approval.id, this.sender, signal);
        // Submission can finish after the user interrupts. Publish its actual result separately.
        try { this.notifyResult?.(approval.id, result); } catch { /* UI failure must not change the SMTP ledger. */ }
        signal.throwIfAborted(); delta(deliveryResult(result));
      }
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
