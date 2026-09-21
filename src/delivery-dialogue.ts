import { activeTopicHistory, type AssistantMode, type DialogueModel, type Message, type TurnPlan, type ReplyUpdate, type ReasoningEffort, type WorkflowSelection } from './conversation.js';
import { draftFailureDetails, type Draft, type DraftGenerator } from './delivery-draft.js';
import type { MailSender } from './mail.js';
import { JobStore } from './job-store.js';
import { calendarDetails, calendarConfirmationPhrase, calendarApprovalMatches } from './calendar.js';
import { parseDeliveryRecoveryState, type DeliveryRecoveryState, type RecoveryPersistence } from './recovery-drafts.js';
import { acceptsLongFormDocumentOffer, hasLongFormDocumentOffer } from './long-form-offer.js';
import { documentWarning } from './document-presentation.js';

type Approval = { id: string; prompt: string; expires: number; retryAttempt?: number };
type DocumentOffer = { prompt: string; expires: number; retry: boolean };
type Plan = { plan: TurnPlan; approval?: Approval; documentRetry?: boolean };
export const explicitSend = (text: string) => /^(?:确认发送|确认发出|可以发送|发送吧|发吧|confirm send|confirm sending|send it|yes,? send it)[。！.!\s]*$/i.test(text.trim());
export const explicitResend = (text: string) => /^(?:确认重发|确认重新发送|重发吧|confirm resend|resend it|yes,? resend it)[。！.!\s]*$/i.test(text.trim());
// Additional semantic approval still requires the model's confirm classification AND the
// immediately preceding immutable preview. Reject common negation/correction/recipient changes.
export function naturalMailApproval(text: string) {
  const s = text.trim();
  return s.length <= 160 && /发|send|email|mail/i.test(s)
    && !/[?？“”"「」『』@]|不|没|别|取消|撤回|吗|么|等等|等会|稍后|明天|以后|如果|假如|他说|她说|改|换|加|删|先.*再|刚才|已经|是否|能否|can you|could you|should|cancel|withdraw|if\b|don't|not\b|\bno\b|never|later|tomorrow|said|change|instead|already|after/i.test(s)
    && !/发给\s*(?!我|自己|固定邮箱)[^\s，。！]|发(?:送)?到\s*(?!我的邮箱|我邮箱|固定邮箱)[^\s，。！]|\bto\s+(?!me\b|my\b|the fixed\b)/i.test(s);
}
function contextualMailApproval(text: string) {
  return /^(?:好(?:的)?[，,、\s]*)?(?:可以|没问题|ok(?:ay)?)[。！.!\s]*$/i.test(text.trim());
}
export const mailFallback = '请先稍等片刻，检查垃圾邮件、所有邮件，并搜索“Even 笔记”。也可到网页文件列表直接下载 MD／ICS；无需重新生成文件或开放收件箱权限。';
const explicitDocumentRequest = (value: string) => {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  if (!text || text.length > 2000 || /(?:不要|别|无需|不需要).{0,30}(?:生成|整理|导出|MD|Markdown|文档|文件)/i.test(text)
    || /^(?:如何|怎么|为什么).{0,100}(?:生成|整理|导出|MD|Markdown|文档|文件)/i.test(text) && !/帮我|please/i.test(text)) return false;
  const namedContent = /(?:刚才|这份|这个|上面|之前)?.{0,30}(?:计划|方案|回答|内容|总结|笔记|清单|步骤|行程|notes?|plan|summary|answer|itinerary)/i;
  const toFixedRecipient = /(?:发给我|发到(?:我|我的)?邮箱|发送到(?:我|我的)?邮箱|email\s+(?:it\s+)?to\s+me|email\s+me|send\s+(?:it\s+)?to\s+(?:me|my\s+email))/i;
  return /(?:生成|整理|写成|导出|做成|create|write|export|turn).{0,120}(?:MD|Markdown|文档|文件|notes?|plan)/i.test(text)
    || /(?:MD|Markdown|文档|文件).{0,120}(?:生成|整理|写|导出|发给我|email|send)/i.test(text)
    || namedContent.test(text) && toFixedRecipient.test(text);
};
function clipForGlasses(text: string, cells: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  let result = '', used = 0;
  for (const char of clean) {
    const width = /^[\x20-\x7e]$/.test(char) ? 1 : 2;
    if (used + width > cells) return result.trimEnd() + '…';
    result += char; used += width;
  }
  return result;
}
export function deliveryResult(result: string): string {
  return result === 'accepted' ? '邮件服务器已接受。请确认是否收到，可说“收到了”或“没收到”；我无法查看收件箱。'
    : result === 'sending' ? '邮件正在发送，请勿重复确认。'
    : result === 'failed' ? '邮件发送失败，文件仍已保存。可以要求重发并再次确认，或在网页直接下载。不会自动重发。'
    : '发送结果暂时无法确定，可能已经发出。请先检查邮箱；确认没收到后可以要求重发，或在网页直接下载。不会自动重发。';
}
/** Per-conversation state. Only a completed immutable artifact can receive one-use approval. */
export class DeliveryDialogue implements DialogueModel {
  private plans = new WeakMap<AbortSignal, Plan>();
  private approval?: Approval;
  private documentOffer?: DocumentOffer;
  private draft?: Draft;
  private jobId?: string;
  constructor(private base: DialogueModel, private jobs: JobStore, private generate: DraftGenerator,
    private sender?: MailSender, private now: () => number = Date.now,
    private notifyResult?: (id: string, result: string) => void,
    private artifactSource?: () => Message[],
    private recovery?: RecoveryPersistence<DeliveryRecoveryState>,
    private observeDocument?: (outcome: 'success' | 'failure', durationMs: number, retry: boolean) => void) {}
  invalidate() { this.approval = undefined; this.documentOffer = undefined; }
  private persistDraft() {
    if (!this.jobId) { this.recovery?.clear(); return; }
    this.recovery?.save({ version: 1, jobId: this.jobId });
  }
  async restoreRecovery(value: unknown) {
    this.invalidate(); this.draft = undefined; this.jobId = undefined;
    const recovered = parseDeliveryRecoveryState(value);
    if (!recovered) { this.recovery?.clear(); return; }
    const job = this.jobs.get(recovered.jobId);
    const metadata = this.jobs.metadata(recovered.jobId);
    if (!job || job.state !== 'completed' || !metadata || this.jobs.superseded(recovered.jobId) || this.jobs.mailReceived(recovered.jobId)) {
      this.recovery?.clear(); return;
    }
    try {
      const markdown = (await this.jobs.download(recovered.jobId)).toString('utf8');
      this.draft = { document: { presentation: metadata, markdown }, calendar: this.jobs.calendar(recovered.jobId) };
      this.jobId = recovered.jobId;
    } catch { this.recovery?.clear(); }
  }
  recoveryManifest() {
    if (!this.jobId || !this.draft) return undefined;
    return { draft: true, jobState: this.jobs.get(this.jobId)?.state ?? 'missing',
      mailState: this.jobs.mailState(this.jobId) ?? null,
      requiresPreview: !this.jobs.mailState(this.jobId) };
  }
  endSession() { this.invalidate(); this.draft = undefined; this.jobId = undefined; this.recovery?.clear(); }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    const approval = this.approval, documentOffer = this.documentOffer;
    this.approval = undefined; this.documentOffer = undefined;
    const prior = history.at(-1);
    let plan: TurnPlan, documentRetry = false;
    if (documentOffer && documentOffer.expires > this.now() && prior?.role === 'assistant'
      && prior.content === documentOffer.prompt && acceptsLongFormDocumentOffer(text)) {
      documentRetry = documentOffer.retry;
      plan = { decision: 'respond', deliveryAction: 'document', calendarAction: 'none',
        reasoningEffort: 'low', cognitiveMode: 'compose', assistantMode: 'compose' };
    } else {
      plan = this.base.plan ? await this.base.plan(history, text, forced, signal)
        : { decision: await this.base.decide(history, text, forced, signal) };
      signal.throwIfAborted();
    }
    if (approval && (explicitSend(text) || explicitResend(text) || naturalMailApproval(text) || contextualMailApproval(text))) {
      plan = { ...plan, decision: 'respond', deliveryAction: 'confirm', calendarAction: 'none', reasoningEffort: 'low' };
    } else if ((!plan.deliveryAction || plan.deliveryAction === 'none' || plan.deliveryAction === 'confirm') && explicitDocumentRequest(text)) {
      plan = { ...plan, decision: 'respond', deliveryAction: 'document', calendarAction: 'none' };
    }
    this.plans.set(signal, { plan, approval, documentRetry });
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
    const prompt = prefix + (documentWarning(metadata) ? documentWarning(metadata) + '\n' : '') + `文件已生成：${clipForGlasses(metadata.filename, 52)}\n摘要：${clipForGlasses(metadata.summary, 72)}` +
      (metadata.compressedSections?.length ? `\n第 ${metadata.compressedSections.join('、')} 章已按篇幅重写。` : '') +
      (this.draft.calendar ? `\n\n日历文件：\n${calendarDetails(this.draft.calendar)}\n不包含自动通知或闹钟。` : '') +
      (this.sender ? `\n\n${this.draft.calendar ? '请核对日期与主时区。' : ''}发送到固定邮箱？说“确认发送”或“取消发送”。` : '\n\n邮件发送未启用。文件已保存，可在网页下载；没有发送邮件。');
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
    const warnedPrompt = [documentWarning(this.jobs.metadata(this.jobId)), prompt].filter(Boolean).join('\n');
    delta(warnedPrompt); this.approval = { id: this.jobId, prompt: warnedPrompt, expires: this.now() + 5 * 60000, retryAttempt: this.jobs.mailAttempts(this.jobId) };
  }
  async reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]) {
    const context = this.plans.get(signal); this.plans.delete(signal);
    const action = context?.plan.deliveryAction ?? 'none';
    signal.throwIfAborted();
    if (action === 'none') {
      let answer = '';
      await this.base.reply(history, signal, text => { answer += text; delta(text); }, update, effort, mode, workflows);
      signal.throwIfAborted();
      if (hasLongFormDocumentOffer(answer)) this.documentOffer = { prompt: answer, expires: this.now() + 5 * 60000, retry: false };
      return;
    }
    if (action === 'not_received') { this.retryPreview(delta); return; }
    if (action === 'received') {
      if (!this.jobId || !this.jobs.mailState(this.jobId) || this.jobs.mailState(this.jobId) === 'sending') { delta('谢谢反馈。当前没有可关联的已结束发送记录；你也可以在网页文件列表标记对应邮件已收到。'); return; }
      this.jobs.acknowledgeReceipt(this.jobId); this.invalidate(); this.recovery?.clear();
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
        : (approval?.retryAttempt ? explicitResend(text) : explicitSend(text)) || naturalMailApproval(text) || contextualMailApproval(text);
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
    const previousDraft = this.draft;
    if (this.jobId) this.jobs.supersede(this.jobId);
    this.invalidate(); this.draft = undefined; this.jobId = undefined; this.recovery?.clear();
    update?.({ type: 'artifact.status', status: 'generating' });
    const generationStarted = this.now();
    let newJob: string | undefined;
    try {
      // Normal Luna replies receive the whole session as short-term memory. A
      // generated artifact remains scoped to the active topic so a trip plan and
      // a business idea are never silently blended into one document.
      const source = this.artifactSource?.() ?? history;
      const selection = activeTopicHistory(source).map(message => ({ ...message,
        citations: message.citations?.map(citation => ({ ...citation })) }));
      const generated = await this.generate(selection, action, action === 'revise' ? previousDraft : undefined, signal,
        { conciseRetry: context?.documentRetry === true });
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
      this.draft = generated; this.jobId = job.id; this.persistDraft();
      this.observeDocument?.('success', this.now() - generationStarted, context?.documentRetry === true);
      this.preview(delta);
    } catch (error) {
      if (newJob) { this.jobs.cancel(newJob); this.jobs.supersede(newJob); }
      this.draft = undefined; this.jobId = undefined; this.recovery?.clear();
      signal.throwIfAborted();
      const failure = draftFailureDetails(error);
      this.observeDocument?.('failure', this.now() - generationStarted, context?.documentRetry === true);
      console.warn(JSON.stringify({ event: 'delivery_draft_failed', ...failure }));
      if (!context?.documentRetry && !['DRAFT_UNAVAILABLE', 'DRAFT_INPUT_LIMIT'].includes(failure.code)) {
        const prompt = '文件没有完整生成，也没有保存或发送。需要我重试生成 Markdown 文件吗？';
        this.documentOffer = { prompt, expires: this.now() + 5 * 60000, retry: true }; delta(prompt);
      } else {
        delta('文件仍未能完整生成或保存，没有发送邮件。请稍后重新提出生成请求；不会用聊天记录代替你要求的文档。');
      }
    }
  }
}
