// Read-only diagnostic. Model input is synthetic; Google transport rejects writes.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createCalendarPlanner } from '../src/calendar-planner.js';
import { validateCalendar } from '../src/calendar.js';
import { GoogleCalendarService, loadCalendarTransport } from '../src/google-calendar.js';
import { resolve, join } from 'node:path';
const clock = () => new Date('2026-09-17T01:33:47.123Z');
const planner = createCalendarPlanner(process.env, fetch, clock);
const request = await planner([{ role: 'user', content: '可以帮我看一下我下一次 high reps training 是什么时候' }], { candidates: [] }, new AbortController().signal);
assert.equal(request.action, 'query');
console.log(JSON.stringify({ action: request.action, rangeStart: request.rangeStart, rangeEnd: request.rangeEnd, timezone: request.timezone }));
try {
  validateCalendar({ title: 'query', start: request.rangeStart, end: request.rangeEnd, timezone: request.timezone, allDay: false, location: '', notes: '' });
  console.log('Original minute-only validation: accepted');
} catch { console.log('Original minute-only validation: CALENDAR_INVALID reproduced'); }
const root = resolve(process.env.EVEN_DATA_DIR || '.local');
const loaded = await loadCalendarTransport(root);
let reads = 0;
const service = await GoogleCalendarService.create(join(root, 'calendar-next-smoke'), loaded.calendarId, async (method, path) => {
  assert.equal(method, 'GET', 'diagnostic must not mutate Google events'); reads++;
  return loaded.transport(method, path);
});
try {
  const result = await service.next(request.titleQuery, request.timezone || 'America/Chicago');
  assert.ok(reads > 0);
  console.log(JSON.stringify({ readOnly: true, reads, matches: result.items.length, nextStart: result.items[0]?.start, suggestionCount: result.suggestions.length, horizonDays: result.horizonDays }));
} finally { await service.close(); }
