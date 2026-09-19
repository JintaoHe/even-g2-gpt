import 'dotenv/config';
import { createTimezoneFallback } from '../src/timezone-fallback.js';

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is required');

// Synthetic public context only. This deliberately calls Luna directly without
// coordinates, Google, Calendar, tools, search, or any user-specific data.
const fallback = createTimezoneFallback(key, process.env.OPENAI_REPLY_MODEL ?? 'gpt-5.6-luna');
const result = await fallback.resolve([
  { role: 'user', content: 'I am currently in downtown Los Angeles. Create an event two hours from now.' }
], 'America/Los_Angeles', AbortSignal.timeout(30_000));
if (result.action !== 'use' || result.timezone !== 'America/Los_Angeles') {
  throw new Error('TIMEZONE_FALLBACK_SMOKE_UNEXPECTED_RESULT');
}
console.log(JSON.stringify({ provider: 'luna-timezone-fallback', status: 'ok', timezone: result.timezone }));
