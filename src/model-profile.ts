/** Deployment opt-in; existing explicit model configuration stays unchanged. */
export function modelProfile(env: NodeJS.ProcessEnv) {
  const value = env.EVEN_MODEL_PROFILE ?? 'configured';
  if (value !== 'configured' && value !== 'hybrid-luna' && value !== 'all-5.6') throw new Error('INVALID_MODEL_PROFILE');
  return value;
}

/** Both managed profiles pin every non-ordinary text workload to the baseline.
 * Speech recognition is a separate provider and is deliberately unaffected. */
export function baselineModel(env: NodeJS.ProcessEnv, configured: string) {
  return modelProfile(env) === 'configured' ? configured : 'gpt-5.6-luna';
}

export function hybridFirstOutputMs(env: NodeJS.ProcessEnv): number | undefined {
  if (modelProfile(env) !== 'hybrid-luna') return undefined;
  const value = Number(env.EVEN_HYBRID_FIRST_OUTPUT_MS ?? 5000);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 20000)
    throw new Error('EVEN_HYBRID_FIRST_OUTPUT_MS must be an integer between 1000 and 20000');
  return value;
}

/** Only explicit public model configuration; never serialize the environment. */
export function modelProfileBanner(env: NodeJS.ProcessEnv, models: { intent: string; reply: string }) {
  const profile = modelProfile(env);
  return `profile=${profile} | intent=${models.intent} | reply=${models.reply}`
    + (profile === 'hybrid-luna'
      ? ` | casual=gpt-6-luna | casual_scope=casual/explain,low/none,no-workflows | first_output_ms=${hybridFirstOutputMs(env)}` : '');
}
