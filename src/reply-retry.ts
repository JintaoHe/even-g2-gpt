import type { Message } from './conversation.js';
import { isRejectedReply } from './reply-output-guard.js';

/** Closed command set: never interpret a quoted mention or a longer request. */
export function isReplyRetry(text: string): boolean {
  if (text.length > 256) return false;
  const value = text.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '').trim()
    .replace(/\s+/gu, ' ').replace(/五点六|5点6/gu, '5.6');
  const chinese = /^(?:(?:你|请|麻烦|能不能|可不可以|可以|能)\s*){0,4}(?:再\s*)?(?:用\s*5\.6\s*)?重新回答(?:一下|一遍)?(?:我?(?:刚才|上一个|前面)的?问题)?(?:吗|吧|呢)?$/u;
  return chinese.test(value)
    || /^(?:刚才(?:的回答)?不对[，,\s]*请?重新回答|(?:please )?retry(?: with 5\.6)?|(?:please )?answer again|can you answer that again|could you retry that|can you redo your last answer|that answer was wrong[,.\s]+please answer again)$/iu.test(value);
}

export function retryContext(history: Message[]): Message[] {
  let end = history.length - 1;
  while (end >= 0 && (history[end].role !== 'user' || history[end].contextKind || isReplyRetry(history[end].content))) end--;
  if (end < 0) return [];
  // Synthetic summaries may describe the answer being replaced. Without the
  // original in-memory snapshot, use only chronological conversation messages.
  return withoutRetryTurns(history.slice(0, end + 1).filter(m => !m.contextKind));
}

export function withoutRetryTurns(history: Message[]): Message[] {
  let retry = false;
  return history.filter(m => {
    if (m.role === 'assistant' && isRejectedReply(m.content)) return false;
    if (m.contextKind) return true;
    if (m.role === 'user') retry = isReplyRetry(m.content);
    return !retry;
  });
}
