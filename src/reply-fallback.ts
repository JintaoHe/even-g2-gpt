import type { DialogueModel, Message, AssistantMode, ReasoningEffort, WorkflowSelection } from './conversation.js';
import { isReplyRetry, retryContext } from './reply-retry.js';

export type ReplyFailure = 'network' | 'timeout' | 'http' | 'stream' | 'empty' | 'unknown_provider';
/** All errors originating at the provider boundary are eligible. Local errors,
 * auth/policy refusals, budget/storage failures and user cancellation fail closed. */
export class RetryableReplyError extends Error {
  constructor(readonly reason: ReplyFailure) { super(`REPLY_${reason.toUpperCase()}`); }
}
export class PartialReplyError extends Error {
  constructor() { super('PARTIAL_REPLY_RETRY_REQUIRED'); }
}
export type ReplyDiagnostic = { event: 'reply_attempt' | 'reply_fallback' | 'reply_failed';
  model: string; reason?: ReplyFailure | 'partial' | 'blocked'; elapsedMs?: number;
  attempt?: 'primary' | 'fallback' | 'retry'; targetModel?: 'gpt-5.6-luna' };

const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
/** Call only at the raw provider boundary. Never inspect or report error text. */
export function providerFailureReason(error: unknown): 'network' | 'unknown_provider' {
  let current = error;
  try {
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
      const record = current as { code?: unknown; cause?: unknown };
      if (typeof record.code === 'string' && networkCodes.has(record.code)) return 'network';
      current = record.cause;
    }
  } catch { /* Malformed errors remain unknown; telemetry never changes behavior. */ }
  return 'unknown_provider';
}

/** Observe and rethrow the identical failure. No retry, cancellation or empty
 * output policy is introduced here. */
export function observeReplyFailure(reply: DialogueModel['reply'], model: string,
  attempt: 'primary' | 'fallback' | 'retry', diagnostic: (event: ReplyDiagnostic) => void): DialogueModel['reply'] {
  return async (...args) => {
    const start = performance.now();
    try { return await reply(...args); }
    catch (error) {
      if (!args[1].aborted) {
        const reason = error instanceof RetryableReplyError ? error.reason
          : error instanceof PartialReplyError ? 'partial' : 'blocked';
        try { diagnostic({ event: 'reply_failed', model, attempt, reason, elapsedMs: performance.now() - start }); }
        catch { /* Logging cannot replace the original error. */ }
      }
      throw error;
    }
  };
}

/** Deliberately closed, whole-utterance retry commands, not arbitrary complaints
 * or follow-up questions. Quoted/history text never controls routing. */
export function requestsBaselineReply(history: Message[]) {
  const last = history.at(-1);
  return last?.role === 'user' && !last.contextKind && isReplyRetry(last.content);
}

export function ordinaryReply(effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]) {
  // Missing/unknown classification must not silently expand the migration.
  return (effort === 'none' || effort === 'low') && (mode === 'casual' || mode === 'explain')
    && Array.isArray(workflows) && workflows.length === 0;
}

export function createReplyFallback(primary: DialogueModel, baseline: DialogueModel,
  diagnostic: (event: ReplyDiagnostic) => void = () => {}, firstOutputMs = 5000): DialogueModel['reply'] {
  if (!Number.isSafeInteger(firstOutputMs) || firstOutputMs < 1000 || firstOutputMs > 20000)
    throw new Error('Invalid first output deadline');
  const report = (event: ReplyDiagnostic) => { try { diagnostic(event); } catch { /* telemetry cannot change delivery */ } };
  return async (history, signal, delta, update, effort, mode, workflows) => {
    signal.throwIfAborted();
    if (requestsBaselineReply(history)) {
      const context = retryContext(history);
      if (!context.length) { delta('没有可以重新回答的上一轮问题。'); return; }
      return observeReplyFailure(baseline.reply.bind(baseline), 'gpt-5.6-luna', 'retry', report)(context, signal, delta, update, 'low', 'explain', []);
    }
    if (!ordinaryReply(effort, mode, workflows)) {
      return observeReplyFailure(baseline.reply.bind(baseline), 'gpt-5.6-luna', 'primary', report)(history, signal, delta, update, effort, mode, workflows);
    }
    let visible = false;
    let delivered = false;
    const start = performance.now();
    report({ event: 'reply_attempt', model: 'gpt-6-luna' });
    signal.throwIfAborted();
    const attempt = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attempt.signal]);
    let accepting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCancel!: () => void;
    const clearDeadline = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const deadline = new Promise<never>((_resolve, reject) => {
      onCancel = () => { accepting = false; clearDeadline(); reject(signal.reason); };
      signal.addEventListener('abort', onCancel, { once: true });
      timer = setTimeout(() => {
        accepting = false; // Revoke delivery before abort listeners can emit anything.
        const error = new RetryableReplyError('timeout');
        reject(error);
        attempt.abort(error);
      }, firstOutputMs);
    });
    const guardedDelta = (text: string) => { if (!accepting) return;
      signal.throwIfAborted(); if (text.length) { delivered = true; clearDeadline(); }
      if (text.trim()) visible = true; delta(text); };
    try {
      await Promise.race([deadline, Promise.resolve().then(() => {
        attemptSignal.throwIfAborted();
        return primary.reply(history, attemptSignal, guardedDelta, event => {
          if (!accepting) return;
          signal.throwIfAborted();
          // Any observable tool/status or final text event makes replay unsafe.
          delivered = true; clearDeadline();
          if (event.type === 'answer.citations' && event.text.trim()) visible = true;
          update?.(event);
        }, effort, mode, workflows);
      })]);
      signal.throwIfAborted();
      if (!visible) throw new RetryableReplyError('empty');
    } catch (error) {
      accepting = false; clearDeadline();
      signal.removeEventListener('abort', onCancel);
      signal.throwIfAborted();
      if (!(error instanceof RetryableReplyError)) {
        report({ event: 'reply_failed', model: 'gpt-6-luna', reason: 'blocked', elapsedMs: performance.now() - start });
        throw error;
      }
      if (delivered) {
        report({ event: 'reply_failed', model: 'gpt-6-luna', reason: 'partial', elapsedMs: performance.now() - start });
        throw new PartialReplyError();
      }
      report({ event: 'reply_fallback', model: 'gpt-6-luna', targetModel: 'gpt-5.6-luna', reason: error.reason, elapsedMs: performance.now() - start });
      // No loop, no new planning/tool execution; both callers use metered fetch.
      await observeReplyFailure(baseline.reply.bind(baseline), 'gpt-5.6-luna', 'fallback', report)(history, signal, delta, update, effort, mode, workflows);
    } finally {
      accepting = false; clearDeadline();
      signal.removeEventListener('abort', onCancel);
    }
  };
}
