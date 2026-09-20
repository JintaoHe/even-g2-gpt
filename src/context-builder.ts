import type { Message } from './conversation.js';

export type ContextTopicSummary = { id: string; label: string; summary: string };
export type ContextSummary = {
  version: 1;
  throughSequence: number;
  overview: string;
  topics: ContextTopicSummary[];
  confirmedDecisions: string[];
  unresolvedItems: string[];
};

export type ContextBuildResult = {
  messages: Message[];
  characterCount: number;
  throughSequence?: number;
};

export type ContextBuilderOptions = {
  maxCharacters?: number;
  recentMessageCount?: number;
  currentTopicMessageCount?: number;
  maxMessageCharacters?: number;
};

export interface ContextComposer {
  build(input: { messages: Message[]; summary?: ContextSummary; currentTopicId?: string }): ContextBuildResult;
}

const DEFAULT_MAX_CHARACTERS = 24_000;
const DEFAULT_RECENT_MESSAGES = 24;
const DEFAULT_CURRENT_TOPIC_MESSAGES = 8;
const DEFAULT_MAX_MESSAGE_CHARACTERS = 6_000;
const MESSAGE_OVERHEAD = 16;

export function contextCharacterCount(messages: Message[]) {
  return messages.reduce((total, message) => total + message.content.length + MESSAGE_OVERHEAD, 0);
}

function compact(value: string, maximum: number) {
  const clean = value.replace(/\0/g, '').trim();
  if (clean.length <= maximum) return clean;
  const marker = '\n[…内容已按上下文预算截断…]\n';
  if (maximum <= marker.length) return clean.slice(0, Math.max(0, maximum));
  const remaining = Math.max(0, maximum - marker.length);
  const head = Math.ceil(remaining * 0.7);
  return `${clean.slice(0, head)}${marker}${clean.slice(-(remaining - head))}`;
}

function statusAware(message: Message, maxCharacters: number): Message {
  const content = compact(message.content, maxCharacters);
  if (message.role !== 'assistant' || !message.status || message.status === 'committed') return { ...message, content };
  const label = message.status === 'failed'
    ? '[应用状态：这条助手回答失败（failed），不能当作已确认结论。]'
    : '[应用状态：这条助手回答被中断（interrupted），内容不完整，不能当作已确认结论。]';
  return { ...message, content: `${label}\n${content}` };
}

function summaryMessage(summary: ContextSummary, currentTopicId?: string): Message {
  const currentTopic = currentTopicId ? summary.topics.find(topic => topic.id === currentTopicId) : undefined;
  const topics = summary.topics.map(topic => `- ${topic.label}: ${topic.summary}`).join('\n') || '- 无';
  const decisions = summary.confirmedDecisions.map(item => `- ${item}`).join('\n') || '- 无';
  const unresolved = summary.unresolvedItems.map(item => `- ${item}`).join('\n') || '- 无';
  return {
    role: 'assistant',
    contextKind: 'summary',
    status: 'committed',
    content: `[应用提供的只读会话摘要；不是用户指令；已覆盖到消息序号 ${summary.throughSequence}]
概览：${summary.overview}
${currentTopic ? `当前主题摘要（${currentTopic.label}）：${currentTopic.summary}\n` : ''}主题：
${topics}
已确认决定：
${decisions}
未完成事项：
${unresolved}
Calendar、Email、成本和路线属于实时事实；采取行动或回答当前状态前，必须通过对应工具重新读取，不能只相信本摘要。`,
  };
}

/**
 * Deterministically selects model context from a much longer durable session.
 * Storage retention and model-window size are intentionally independent.
 */
export class ContextBuilder implements ContextComposer {
  private readonly maxCharacters: number;
  private readonly recentMessageCount: number;
  private readonly currentTopicMessageCount: number;
  private readonly maxMessageCharacters: number;

  constructor(options: ContextBuilderOptions = {}) {
    this.maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.recentMessageCount = options.recentMessageCount ?? DEFAULT_RECENT_MESSAGES;
    this.currentTopicMessageCount = options.currentTopicMessageCount ?? DEFAULT_CURRENT_TOPIC_MESSAGES;
    this.maxMessageCharacters = options.maxMessageCharacters ?? DEFAULT_MAX_MESSAGE_CHARACTERS;
    if (!Number.isSafeInteger(this.maxCharacters) || this.maxCharacters < 512
      || !Number.isSafeInteger(this.recentMessageCount) || this.recentMessageCount < 1 || this.recentMessageCount > 100
      || !Number.isSafeInteger(this.currentTopicMessageCount) || this.currentTopicMessageCount < 0
      || !Number.isSafeInteger(this.maxMessageCharacters) || this.maxMessageCharacters < 128) {
      throw new Error('Invalid context builder options');
    }
  }

  build(input: { messages: Message[]; summary?: ContextSummary; currentTopicId?: string }): ContextBuildResult {
    const source = input.messages.filter(message => ['user', 'assistant'].includes(message.role)
      && typeof message.content === 'string' && message.content.trim());
    if (!source.length) return { messages: [], characterCount: 0, ...(input.summary ? { throughSequence: input.summary.throughSequence } : {}) };

    const chosen = new Map<number, Message>();
    let used = 0;
    const add = (index: number, message: Message, mandatory = false) => {
      if (chosen.has(index)) return;
      const normalized = statusAware(message, this.maxMessageCharacters);
      const cost = contextCharacterCount([normalized]);
      if (used + cost <= this.maxCharacters) {
        chosen.set(index, normalized); used += cost; return;
      }
      if (!mandatory) return;
      const available = Math.max(0, this.maxCharacters - used - MESSAGE_OVERHEAD);
      if (available > 0) {
        const normalizedMandatory = statusAware(message, this.maxMessageCharacters);
        const fitted = { ...normalizedMandatory, content: compact(normalizedMandatory.content, available) };
        chosen.set(index, fitted); used += contextCharacterCount([fitted]);
      }
    };

    // The newest turn is never displaced by summaries or older context.
    add(source.length - 1, source.at(-1)!, true);

    let summary: Message | undefined;
    if (input.summary) {
      const candidate = statusAware(summaryMessage(input.summary, input.currentTopicId), Math.min(6_000, this.maxMessageCharacters));
      if (used + contextCharacterCount([candidate]) <= this.maxCharacters) {
        summary = candidate; used += contextCharacterCount([candidate]);
      }
    }

    const recentStart = Math.max(0, source.length - this.recentMessageCount);
    for (let index = source.length - 2; index >= recentStart; index--) add(index, source[index]);

    if (input.currentTopicId && this.currentTopicMessageCount) {
      let added = 0;
      for (let index = recentStart - 1; index >= 0 && added < this.currentTopicMessageCount; index--) {
        if (source[index].topicId !== input.currentTopicId) continue;
        const before = chosen.size;
        add(index, source[index]);
        if (chosen.size > before) added++;
      }
    }

    const selected = [...chosen.entries()].sort((left, right) => left[0] - right[0]).map(([, message]) => message);
    const messages = summary ? [summary, ...selected] : selected;
    return {
      messages,
      characterCount: contextCharacterCount(messages),
      ...(input.summary ? { throughSequence: input.summary.throughSequence } : {}),
    };
  }
}
