import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CalendarError, GoogleCalendarService, retryableCalendarRead, type CalendarTransport } from '../src/google-calendar.js';
import { CalendarControl } from '../src/calendar-control.js';
const start = '2026-10-01T00:00-05:00', end = '2026-10-02T00:00-05:00', zone = 'America/Chicago';
async function fixture(t: any, transport: CalendarTransport) {
  const dir = await mkdtemp(join(tmpdir(), 'calendar-health-'));
  const service = await GoogleCalendarService.create(dir, 'dedicated', transport);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); }); return service;
}
test('valid empty lists including Google omitted items are healthy and not retried', async t => {
  let calls = 0;
  const service = await fixture(t, async () => { calls++; return calls === 1 ? { items: [] } : { kind: 'calendar#events' }; });
  assert.deepEqual(await service.query(start, end, zone), { items: [], complete: true });
  assert.equal(calls, 1); assert.equal(service.health().returnedCount, 0); assert.equal(service.health().state, 'healthy');
  await service.query(start, end, zone); assert.equal(calls, 2);
});
test('null response retries once, publishes progress and recovered diagnostics', async t => {
  let calls = 0; const states: string[] = [];
  const service = await fixture(t, async () => ++calls === 1 ? null : { items: [] });
  const off = service.subscribeHealth(h => states.push(h.state));
  await service.query(start, end, zone); off();
  assert.equal(calls, 2); assert.ok(states.includes('retrying'));
  assert.equal(service.health().recovered, true); assert.equal(service.health().errorCode, 'CALENDAR_RESPONSE_UNKNOWN');
});
test('transient failure retries once then exposes error, never reports an empty result', async t => {
  let calls = 0;
  const service = await fixture(t, async () => { calls++; throw new CalendarError('CALENDAR_HTTP_503', 503); });
  await assert.rejects(service.query(start, end, zone), /503/); assert.equal(calls, 2);
  assert.equal(service.health().state, 'error'); assert.equal(service.health().httpStatus, 503);
});
test('permanent errors and long Retry-After are not retried', async t => {
  let calls = 0;
  const service = await fixture(t, async () => { calls++; throw new CalendarError('CALENDAR_HTTP_403_insufficientPermissions', 403); });
  await assert.rejects(service.query(start, end, zone)); assert.equal(calls, 1);
  for (const code of [400, 404, 412]) assert.equal(retryableCalendarRead(new CalendarError('CALENDAR_HTTP_' + code, code)), false);
  assert.ok(retryableCalendarRead(new CalendarError('CALENDAR_HTTP_403_rateLimitExceeded', 403)));
  assert.equal(retryableCalendarRead(new CalendarError('CALENDAR_HTTP_429', 429, 60000)), false);
});
test('probe is read-only, health snapshots require no extra calls, writes never retry', async t => {
  let calls = 0;
  const service = await fixture(t, async method => { calls++; if (method === 'GET') return { id: 'dedicated', accessRole: 'owner' }; throw new CalendarError('CALENDAR_NETWORK_UNKNOWN'); });
  const events: any[] = []; const control = new CalendarControl(service, e => events.push(e));
  await control.handle({ type: 'calendar.health' }); assert.equal(calls, 0);
  await control.handle({ type: 'calendar.health', probe: true }); assert.equal(calls, 1); assert.equal(events.at(-1).health.state, 'healthy');
  const preview = await service.preview('create', { title: '测试', start: '2026-10-01T18:00-05:00', end: '2026-10-01T19:00-05:00', timezone: zone, allDay: false, location: '', notes: '' });
  const result = await service.confirm(preview.id, preview.phrase); assert.equal(result.state, 'unknown'); assert.equal(calls, 2);
});
