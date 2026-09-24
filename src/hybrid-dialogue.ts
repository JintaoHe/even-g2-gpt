import type { AssistantMode, DialogueModel, Message, ReplyUpdate, ReasoningEffort, RoutePlaceOption, RouteClarificationPolicy, TurnPlan, WorkflowSelection } from './conversation.js';
import { OpenAIDialogue } from './dialogue-model.js';
import { historyRecallEnabled } from './history-query.js';
import { SearchQuota, type SearchBudget } from './search-quota.js';
import { join } from 'node:path';
import { baselineModel, modelProfile, hybridFirstOutputMs } from './model-profile.js';
import { createReplyFallback, requestsBaselineReply, observeReplyFailure, type ReplyDiagnostic } from './reply-fallback.js';
import { retryContext, withoutRetryTurns } from './reply-retry.js';

export class HybridDialogue implements DialogueModel {
  private original?: Message[];
  private retries = new WeakMap<AbortSignal, Message[]>();
  constructor(private intent: DialogueModel, private answer: DialogueModel, private replyOverride?: DialogueModel['reply'],
    private diagnostic: (event: ReplyDiagnostic) => void = () => {}, private answerModel = 'gpt-5.6-luna',
    private nestedReplies: DialogueModel[] = []) {}
  revokeMemoryContext() {
    this.original = undefined; this.retries = new WeakMap();
    this.intent.revokeMemoryContext?.(); this.answer.revokeMemoryContext?.();
    for (const model of this.nestedReplies) model.revokeMemoryContext?.();
  }
  startSession() { this.original = undefined; this.retries = new WeakMap(); this.intent.startSession?.(); this.answer.startSession?.(); }
  endSession() { this.original = undefined; this.retries = new WeakMap(); this.intent.endSession?.(); this.answer.endSession?.(); }
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    signal.throwIfAborted();
    if (this.replyOverride && requestsBaselineReply([{ role: 'user', content: text }])) {
      const context = retryContext(history), target = context.at(-1), cached = this.original?.at(-1);
      // Owner providers can be shared by several session runtimes. Never select
      // a cached question by text alone, or use it when this session has no target.
      const same = target && cached && (target.messageId && cached.messageId
        ? target.messageId === cached.messageId : !!target.topicId && target.topicId === cached.topicId
          && target.content === cached.content && target.sequence === cached.sequence);
      this.retries.set(signal, structuredClone(same ? this.original! : context));
      return { decision: 'respond', replyRetry: true, cognitiveMode: 'explain', reasoningEffort: 'low', searchAction: 'none',
        deliveryAction: 'none', calendarAction: 'none', locationAction: 'none', taskAction: 'none', historyQuery: null };
    }
    history = withoutRetryTurns(history);
    return this.intent.plan ? this.intent.plan(history, text, forced, signal)
      : { decision: await this.intent.decide(history, text, forced, signal) };
  }
  decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    return this.intent.decide(history, text, forced, signal);
  }
  clarifyRoute(query: string, options: RoutePlaceOption[], history: Message[], signal: AbortSignal, policy?: RouteClarificationPolicy) {
    if (!this.intent.clarifyRoute) throw new Error('Route clarification unavailable');
    return this.intent.clarifyRoute(query, options, history, signal, policy);
  }
  resolveRoute(query: string, history: Message[], signal: AbortSignal, update?: (event: ReplyUpdate) => void) {
    if (!this.answer.resolveRoute) return Promise.resolve({ action: 'not_found' as const });
    return this.answer.resolveRoute(query, history, signal, update);
  }
  reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void,
    effort?: ReasoningEffort, mode?: AssistantMode, workflows?: WorkflowSelection[]) {
    const retry = this.retries.get(signal) ?? (this.replyOverride && requestsBaselineReply(history) ? retryContext(history) : undefined);
    if (retry) {
      this.retries.delete(signal);
      signal.throwIfAborted();
      if (!retry.length) { delta('没有可以重新回答的上一轮问题。'); return Promise.resolve(); }
      return observeReplyFailure(this.answer.reply.bind(this.answer), this.answerModel, 'retry', this.diagnostic)(retry, signal, delta, update, 'low', 'explain', []);
    }
    history = withoutRetryTurns(history);
    this.original = structuredClone(history);
    return this.replyOverride ? this.replyOverride(history, signal, delta, update, effort, mode, workflows)
      : observeReplyFailure(this.answer.reply.bind(this.answer), this.answerModel, 'primary', this.diagnostic)(history, signal, delta, update, effort, mode, workflows);
  }
}

export function createHybridDialogue(key: string, env: NodeJS.ProcessEnv = process.env,
  overrides: { endpoint?: string; quota?: SearchBudget; search?: boolean; fetcher?: typeof fetch; extraInstructions?: string;
    onReplyDiagnostic?: (event: ReplyDiagnostic) => void; hybridPrimaryReply?: boolean } = {}): { model: HybridDialogue; models: { intent: string; reply: string } } {
  const firstOutputMs = hybridFirstOutputMs(env);
  const intentModel = baselineModel(env, env.OPENAI_INTENT_MODEL ?? env.OPENAI_DIALOGUE_MODEL ?? 'gpt-5.6-luna');
  // Retain explicit/legacy overrides; Luna is the evaluated default for both roles.
  const replyModel = baselineModel(env, env.OPENAI_REPLY_MODEL ?? env.OPENAI_DIALOGUE_MODEL ?? 'gpt-5.6-luna');
  const timezone = env.CONVERSATION_TIMEZONE ?? 'America/Chicago';
  const nano = (name: string) => name === 'gpt-5-nano' || name.startsWith('gpt-5-nano-');
  const luna = (name: string) => name === 'gpt-5.6-luna' || name === 'gpt-6-luna';
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const cap = positive('OPENAI_MAX_SEARCH_CALLS', 10);
  const sessionCap = positive('OPENAI_SEARCH_SESSION_LIMIT', 50);
  const dailyCap = positive('OPENAI_SEARCH_DAILY_LIMIT', 100);
  const monthlyCap = positive('OPENAI_SEARCH_MONTHLY_LIMIT', 1200);
  if (sessionCap < cap || dailyCap < cap || monthlyCap < dailyCap || monthlyCap < sessionCap) throw new Error('Search quota hierarchy is invalid');
  const intent = new OpenAIDialogue(key, intentModel, overrides.endpoint, false, cap, timezone, undefined,
    { ...(nano(intentModel) ? { reasoningEffort: 'low' as const, intentTokens: 2048 }
      : luna(intentModel) ? { reasoningEffort: 'medium' as const, intentTokens: 1024, adaptiveReasoning: luna(replyModel) } : {}),
      historyRouting: historyRecallEnabled(env),
      deliveryRouting: env.EVEN_DELIVERY_ROUTING === 'true', calendarRouting: env.GOOGLE_CALENDAR_ENABLED === 'true',
      fetcher: overrides.fetcher,
      locationRouting: env.GOOGLE_MAPS_ENABLED === 'true',
      webRouting: overrides.search ?? env.OPENAI_WEB_SEARCH !== 'false' });
  const reply = new OpenAIDialogue(key, replyModel, overrides.endpoint,
    overrides.search ?? env.OPENAI_WEB_SEARCH !== 'false', cap, timezone,
    overrides.quota ?? new SearchQuota(join(env.EVEN_DATA_DIR ?? '.local', 'search-usage.json'), timezone, dailyCap, monthlyCap), {
      ...(nano(replyModel) ? { reasoningEffort: 'low' as const, replyTokens: 3072 } : {}),
      ...(luna(replyModel) ? { reasoningEffort: 'low' as const, replyTokens: 4096, adaptiveReasoning: luna(intentModel) } : {}),
      sessionSearchCalls: sessionCap,
      hybridPrimaryReply: overrides.hybridPrimaryReply,
      fetcher: overrides.fetcher,
      applicationCapabilities: {
        calendar: env.GOOGLE_CALENDAR_ENABLED === 'true',
        documents: env.EVEN_DELIVERY_ROUTING === 'true',
        email: env.EVEN_EMAIL_ENABLED === 'true',
        location: env.GOOGLE_MAPS_ENABLED === 'true',
        environment: env.GOOGLE_ENVIRONMENT_ENABLED === 'true'
      },
      extraInstructions: "Your name is Even, not the user's name. Preserve Even, G2, R1 and project names as proper nouns; never translate the assistant name Even as 甚至. Follow explicit requested output language."
        + (overrides.extraInstructions ? '\n' + overrides.extraInstructions : '')
    });
  // The ordinary model shares capability/guest instructions but has no tools.
  const ordinary = modelProfile(env) === 'hybrid-luna'
    ? createHybridDialogue(key, { ...env, EVEN_MODEL_PROFILE: 'configured', OPENAI_INTENT_MODEL: 'gpt-5.6-luna', OPENAI_REPLY_MODEL: 'gpt-6-luna' },
      { ...overrides, search: false, hybridPrimaryReply: true }).model : undefined;
  const onDiagnostic = overrides.onReplyDiagnostic ?? ((event: ReplyDiagnostic) => console.info(JSON.stringify(event)));
  return { model: new HybridDialogue(intent, reply, ordinary ? createReplyFallback(ordinary, reply, onDiagnostic, firstOutputMs) : undefined,
    overrides.hybridPrimaryReply ? () => {} : onDiagnostic, replyModel, ordinary ? [ordinary] : []),
    models: { intent: intentModel, reply: replyModel } };
}
