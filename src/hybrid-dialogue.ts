import type { DialogueModel, Message, ReplyUpdate, ReasoningEffort, TurnPlan } from './conversation.js';
import { OpenAIDialogue } from './dialogue-model.js';
import { SearchQuota, type SearchBudget } from './search-quota.js';
import { join } from 'node:path';

export class HybridDialogue implements DialogueModel {
  constructor(private intent: DialogueModel, private answer: DialogueModel) {}
  async plan(history: Message[], text: string, forced: boolean, signal: AbortSignal): Promise<TurnPlan> {
    return this.intent.plan ? this.intent.plan(history, text, forced, signal)
      : { decision: await this.intent.decide(history, text, forced, signal) };
  }
  decide(history: Message[], text: string, forced: boolean, signal: AbortSignal) {
    return this.intent.decide(history, text, forced, signal);
  }
  reply(history: Message[], signal: AbortSignal, delta: (text: string) => void, update?: (event: ReplyUpdate) => void, effort?: ReasoningEffort) {
    return this.answer.reply(history, signal, delta, update, effort);
  }
}

export function createHybridDialogue(key: string, env: NodeJS.ProcessEnv = process.env,
  overrides: { endpoint?: string; quota?: SearchBudget; search?: boolean } = {}) {
  const intentModel = env.OPENAI_INTENT_MODEL ?? env.OPENAI_DIALOGUE_MODEL ?? 'gpt-5.6-luna';
  // Retain explicit/legacy overrides; Luna is the evaluated default for both roles.
  const replyModel = env.OPENAI_REPLY_MODEL ?? env.OPENAI_DIALOGUE_MODEL ?? 'gpt-5.6-luna';
  const timezone = env.CONVERSATION_TIMEZONE ?? 'America/Chicago';
  const nano = (name: string) => name === 'gpt-5-nano' || name.startsWith('gpt-5-nano-');
  const luna = (name: string) => name === 'gpt-5.6-luna';
  const cap = Number(env.OPENAI_MAX_SEARCH_CALLS ?? 2);
  const intent = new OpenAIDialogue(key, intentModel, overrides.endpoint, false, cap, timezone, undefined,
    nano(intentModel) ? { reasoningEffort: 'low', intentTokens: 2048 }
      : luna(intentModel) ? { reasoningEffort: 'none', intentTokens: 256, adaptiveReasoning: luna(replyModel) } : {});
  const reply = new OpenAIDialogue(key, replyModel, overrides.endpoint,
    overrides.search ?? env.OPENAI_WEB_SEARCH !== 'false', cap, timezone,
    overrides.quota ?? new SearchQuota(join(env.EVEN_DATA_DIR ?? '.local', 'search-usage.json'), timezone), {
      ...(nano(replyModel) ? { reasoningEffort: 'low' as const, replyTokens: 3072 } : {}),
      ...(luna(replyModel) ? { reasoningEffort: 'none' as const, replyTokens: 1400, adaptiveReasoning: luna(intentModel) } : {}),
      extraInstructions: "Your name is Even, not the user's name. Preserve Even, G2, R1 and project names as proper nouns; never translate the assistant name Even as 甚至. Follow explicit requested output language."
    });
  return { model: new HybridDialogue(intent, reply), models: { intent: intentModel, reply: replyModel } };
}
