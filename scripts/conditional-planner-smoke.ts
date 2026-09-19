import 'dotenv/config';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { createConditionalTaskPlanner } from '../src/conditional-task-planner.js';

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is required in private .env');
if (process.env.DIALOGUE_PROVIDER !== 'api') throw new Error('Conditional live smoke requires DIALOGUE_PROVIDER=api');
if (process.env.EVEN_CONDITIONAL_TASKS_ENABLED !== 'true') throw new Error('EVEN_CONDITIONAL_TASKS_ENABLED must be true');

const prompt = process.argv.slice(2).join(' ').trim()
  || '明天下午四点半到五点半，我想带孩子去附近的公园散步，帮我看看去哪儿合适。';
const controller = new AbortController();
const hybrid = createHybridDialogue(key, process.env, { search: false });
try {
  const intent = await hybrid.model.plan?.([], prompt, false, controller.signal);
  if (!intent || intent.taskAction !== 'conditional_task' || intent.taskKind !== 'outdoor_activity') throw new Error('LIVE_CONDITIONAL_INTENT_NOT_SELECTED');
  const planner = createConditionalTaskPlanner(key, process.env.OPENAI_INTENT_MODEL ?? 'gpt-5.6-luna',
    undefined, process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago');
  const result = await planner([], prompt, controller.signal);
  if (result.action !== 'execute') throw new Error('LIVE_CONDITIONAL_PLAN_NEEDS_CLARIFICATION');
  // Print only bounded public planning metadata. Never print keys, private
  // history, Calendar contents, location, notes, or provider payloads.
  console.log(JSON.stringify({
    intent: intent.taskAction,
    reasoning: intent.reasoningEffort,
    mode: intent.assistantMode,
    planner: result.action,
    timezone: result.spec.timezone,
    durationMinutes: Math.round((Date.parse(result.spec.activityEnd) - Date.parse(result.spec.activityStart)) / 60_000),
    calendarCheckRequested: result.spec.calendarCheckRequested,
    stopOnCalendarConflict: result.spec.stopOnCalendarConflict,
    scheduleRequested: result.spec.scheduleRequested,
    travelMode: result.spec.travelMode
  }, null, 2));
} finally {
  hybrid.model.endSession?.();
}
