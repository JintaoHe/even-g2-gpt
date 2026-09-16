import { createHybridDialogue } from './hybrid-dialogue.js';
import { CodexDialogue, createCodexRunner } from './codex-dialogue.js';

export function createDialogueProvider(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.DIALOGUE_PROVIDER ?? 'api';
  if (provider === 'api') {
    if (!env.OPENAI_API_KEY) throw new Error('API dialogue requires OPENAI_API_KEY');
    return { ...createHybridDialogue(env.OPENAI_API_KEY, { ...env, EVEN_DELIVERY_ROUTING: 'true' }), provider,
      delivery: 'token-stream', webSearch: env.OPENAI_WEB_SEARCH !== 'false', close: async () => {} };
  }
  if (provider !== 'codex-cli') throw new Error('DIALOGUE_PROVIDER must be api or codex-cli');
  const model = env.CODEX_MODEL ?? 'gpt-5.6-luna';
  if (env.CODEX_WEB_SEARCH !== undefined && !['true', 'false'].includes(env.CODEX_WEB_SEARCH)) throw new Error('CODEX_WEB_SEARCH must be true or false');
  const search = env.CODEX_WEB_SEARCH !== 'false';
  const runner = createCodexRunner({ executable: env.CODEX_CLI_PATH, model,
    timeoutMs: env.CODEX_TIMEOUT_MS === undefined ? undefined : Number(env.CODEX_TIMEOUT_MS), env });
  return { model: new CodexDialogue(runner, search), close: () => runner.close(),
    models: { intent: model, reply: model }, provider, delivery: 'complete-message', webSearch: search };
}
