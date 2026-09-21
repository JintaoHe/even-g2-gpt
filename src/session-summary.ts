import type { ContextSummary } from './context-builder.js';
import { ConversationStore, type StoredMessage, type SummaryJobRecord } from './conversation-store.js';
import { CostBudgetExceeded } from './cost-ledger.js';

// Application policy, not a provider context-window guarantee. Includes schema,
// prior summary and repair material as actually serialized on the wire.
export { MAX_SUMMARY_REQUEST_BYTES } from './summary-request.js';
import { MAX_SUMMARY_REQUEST_BYTES, summaryBody, SummaryInputLimit, type SummarySource, type SummaryLoss } from './summary-request.js';

export type SessionSummaryGenerationRequest = {
  jobId: string;
  sessionId: string;
  fromSequence: number;
  throughSequence: number;
  messages: SummarySource[];
  previousSummary?: ContextSummary;
  previousLosses?: SummaryLoss[];
  attempt: 'summarize' | 'repair';
  invalidOutput?: unknown;
};

export interface SessionSummaryGenerator {
  readonly model: string;
  generate(request: SessionSummaryGenerationRequest, signal: AbortSignal): Promise<unknown>;
}

export type SessionSummaryServiceOptions = {
  messageThreshold?: number;
  keepRecentMessages?: number;
  maxBatchMessages?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  onDiagnostic?: (event: Record<string, string | number>) => void;
  recoveryBudgetAvailable?: () => boolean;
};

export { validateContextSummary } from './summary-validation.js';
import { validateContextSummary } from './summary-validation.js';


function outputText(response: any) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new Error('SESSION_SUMMARY_RESPONSE_INVALID');
}

/**
 * This class only uses the injected fetch. Production must pass the existing
 * metered OpenAI fetch so every initial or repair call is reserved and settled
 * by the cross-provider ledger. No tools are exposed to this request.
 */
export class OpenAISessionSummaryGenerator implements SessionSummaryGenerator {
  constructor(private key: string, readonly model: string,
    private endpoint = 'https://api.openai.com/v1/responses', private fetcher: typeof fetch = fetch) {
    if (!key.trim() || key.length > 500 || !model.trim() || model.length > 128) throw new Error('Invalid summary model configuration');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url.href)) {
      throw new Error('Invalid summary endpoint');
    }
  }

  async generate(request: SessionSummaryGenerationRequest, signal: AbortSignal): Promise<unknown> {
    const { body, bytes } = summaryBody(this.model, request);
    if (bytes > MAX_SUMMARY_REQUEST_BYTES) throw new SummaryInputLimit(bytes);
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `session-summary-${request.jobId}-${request.attempt}` },
      body,
    });
    const raw = await response.text();
    if (!response.ok || Buffer.byteLength(raw) > 512 * 1024) throw new Error('SESSION_SUMMARY_MODEL_FAILED');
    let parsed: unknown;
    try { parsed = JSON.parse(outputText(JSON.parse(raw))); }
    catch { throw new Error('SESSION_SUMMARY_RESPONSE_INVALID'); }
    return parsed;
  }
}

/** Durable, single-process summary worker. Conversation replies never await it. */
export class SessionSummaryService {
  private readonly threshold: number;
  private readonly keepRecent: number;
  private readonly maxBatch: number;
  private readonly now: () => number;
  private scheduled?: NodeJS.Immediate;
  private busy?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private diagnostic: (event: Record<string, string | number>) => void;

  constructor(private store: ConversationStore, private generator: SessionSummaryGenerator,
    options: SessionSummaryServiceOptions = {}) {
    this.threshold = options.messageThreshold ?? 60;
    this.keepRecent = options.keepRecentMessages ?? 24;
    this.maxBatch = options.maxBatchMessages ?? 200;
    this.now = options.now ?? Date.now;
    this.store.configureSummaryModel(generator.model);
    this.store.configureSummaryRecoveryBudget(options.recoveryBudgetAvailable ?? (() => false));
    this.diagnostic = options.onDiagnostic ?? (event => console.info(JSON.stringify(event)));
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 4 || this.threshold > 500
      || !Number.isSafeInteger(this.keepRecent) || this.keepRecent < 1 || this.keepRecent >= this.threshold
      || !Number.isSafeInteger(this.maxBatch) || this.maxBatch < 1 || this.maxBatch > 500
      || !Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 10 || sweepIntervalMs > 60_000) {
      throw new Error('Invalid session summary options');
    }
    this.kick();
    this.timer = setInterval(() => this.kick(), sweepIntervalMs);
    this.timer.unref();
  }

  consider(sessionId: string): SummaryJobRecord | undefined {
    if (this.closed) return undefined;
    if (this.store.hasBlockingSummaryJob(sessionId)) {
      // finishSession may have atomically enqueued work while the worker slept.
      this.kick();
      return undefined;
    }
    const job = this.store.scheduleActiveSummary(sessionId, this.threshold, this.keepRecent, this.maxBatch, this.now());
    this.kick();
    return job;
  }

  private kick() {
    if (this.closed || this.busy || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.busy = this.drain().catch(() => {}).finally(() => { this.busy = undefined; });
    });
  }

  private async drain() {
    this.store.recoverClosedSummaries(this.now(), this.diagnostic);
    while (!this.closed) {
      const job = this.store.claimNextSummaryJob(this.now(), this.diagnostic);
      if (!job) return;
      const controller = this.controller = new AbortController();
      let firstCallCompleted = false;
      try {
        const boundary = this.store.listCommittedMessages(job.sessionId, job.throughSequence - 1, job.throughSequence, 1);
        if (!boundary.length) throw new Error('SUMMARY_RANGE_INVALID');
        const batch = this.store.summaryBatch(job.sessionId, job.throughSequence);
        const through = batch.messages.at(-1)?.sequence;
        if (!through) throw new Error('SUMMARY_RANGE_INVALID');
        if (through < job.throughSequence) {
          this.store.rebatchSummaryJob(job.id, through, this.now());
          this.report('summary_rebatched', job, batch.bytes, 'SUMMARY_REBATCHED');
          continue;
        }
        const base = { jobId: job.id, sessionId: job.sessionId, fromSequence: job.fromSequence,
          throughSequence: job.throughSequence, messages: batch.messages,
          previousSummary: batch.previousSummary, previousLosses: batch.previousLosses };
        if (batch.losses.length) this.report('summary_excerpt', job, batch.bytes);
        let raw = await this.generator.generate({ ...base, attempt: 'summarize' }, controller.signal);
        firstCallCompleted = true;
        controller.signal.throwIfAborted();
        let summary: ContextSummary;
        try { summary = validateContextSummary(raw, job.throughSequence); }
        catch {
          raw = await this.generator.generate({ ...base, attempt: 'repair', invalidOutput: raw }, controller.signal);
          controller.signal.throwIfAborted();
          summary = validateContextSummary(raw, job.throughSequence);
        }
        this.store.completeSummaryJob({ id: job.id, summary, model: this.generator.model, at: this.now(), losses: batch.losses });
        this.consider(job.sessionId);
      } catch (error) {
        try {
          if (this.closed || controller.signal.aborted) this.store.deferSummaryJob(job.id, this.now(), 'shutdown');
          else if (error instanceof CostBudgetExceeded) this.store.deferSummaryJob(job.id, this.now(), 'budget', firstCallCompleted);
          else this.store.failSummaryJob(job.id,
            error instanceof Error && error.message === 'SUMMARY_INPUT_LIMIT' ? 'SUMMARY_INPUT_LIMIT'
              : error instanceof Error && error.message === 'SUMMARY_RANGE_INVALID' ? 'SUMMARY_RANGE_INVALID'
              : error instanceof Error && error.message === 'SESSION_SUMMARY_SCHEMA_INVALID'
              ? 'SUMMARY_SCHEMA_INVALID' : 'SUMMARY_MODEL_FAILED', this.now());
          const settled = this.store.listSummaryJobs(job.sessionId).find(item => item.id === job.id);
          if (settled?.status === 'failed' && settled.errorCode
            && !['SUMMARY_MODEL_FAILED', 'SUMMARY_SCHEMA_INVALID', 'SUMMARY_BUDGET_DEFERRED'].includes(settled.errorCode)) {
            this.report('summary_failed', job, error instanceof SummaryInputLimit ? error.bytes : 0, settled.errorCode);
          }
        } catch { /* Store shutdown/recovery owns the final state. */ }
      } finally { if (this.controller === controller) this.controller = undefined; }
    }
  }

  private report(event: string, job: SummaryJobRecord, bytes: number, code = 'SUMMARY_EXCERPT') {
    try { this.diagnostic({ event, jobId: job.id, sessionId: job.sessionId, fromSequence: job.fromSequence,
      throughSequence: job.throughSequence, bytes, code }); } catch { /* Diagnostics cannot alter durable work. */ }
  }

  async waitForIdle() {
    while (this.scheduled || this.busy) {
      if (this.busy) await this.busy;
      else await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    this.controller?.abort();
    await this.busy;
  }
}
