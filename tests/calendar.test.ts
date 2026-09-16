import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCalendar, calendarAttachment } from '../src/calendar.js';
import { mailPayload } from '../src/mail.js';
import { JobStore } from '../src/job-store.js';
import { once } from 'node:events';
import { createConversationServer } from '../src/conversation-server.js';

const event = { title: '骑车，路线;确认', start: '2026-09-20T14:00-05:00', end: '2026-09-20T15:00-05:00', timezone: 'America/Chicago', allDay: false, location: '公园', notes: '待确认' };
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', created = '2026-09-16T12:00:00Z';
test('calendar requires absolute real dates, increasing times and matching explicit zone offsets', () => {
  assert.deepEqual(validateCalendar(event), event);
  for (const change of [{ start: 'next Friday' }, { start: '2026-02-30T14:00-06:00' }, { start: '2026-09-20T25:00-05:00' },
    { start: '2026-09-20T14:00' }, { end: event.start }, { timezone: 'invalid' }, { start: '2026-09-20T14:00-06:00' },
    { title: 'x\r\nATTENDEE:evil' }, { attendees: ['test@example.com'] }, { title: '' }]) assert.throws(() => validateCalendar({ ...event, ...change }));
  assert.throws(() => validateCalendar({ ...event, start: '2026-03-08T02:30-06:00', end: '2026-03-08T04:30-05:00' }));
  // Repeated fall-back hour is unambiguous because the offset is explicit.
  validateCalendar({ ...event, start: '2026-11-01T01:30-05:00', end: '2026-11-01T01:30-06:00' });
});
test('ICS escapes text, folds UTF-8 bytes and uses stable identity; no invitations or alarms', () => {
  const file = calendarAttachment(id, { ...event, notes: '你好'.repeat(150) }, created);
  const raw = file.content.toString(), unfolded = raw.replace(/\r\n /g, '');
  assert.match(unfolded, /DTSTART:20260920T190000Z/);
  assert.match(unfolded, /DTEND:20260920T200000Z/);
  assert.match(unfolded, /SUMMARY:骑车，路线\\;确认/);
  assert.match(unfolded, /你好/); assert.ok(file.filename.endsWith('.ics'));
  for (const line of raw.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.doesNotMatch(raw, /METHOD:|ORGANIZER:|ATTENDEE:|BEGIN:VALARM|ATTACH:|RRULE:/);
  assert.equal(calendarAttachment(id, event, created).content.toString(), calendarAttachment(id, event, created).content.toString());
});
test('all-day end is exclusive; mail includes safe visible details and both attachments', () => {
  const allDay = { ...event, allDay: true, start: '2026-09-20', end: '2026-09-21', timezone: '', title: '<script>test</script>' };
  const payload = mailPayload(id, Buffer.from('# MD'), undefined, allDay, created);
  assert.equal(payload.attachments.length, 2);
  assert.match(payload.attachments[1].content.toString(), /DTEND;VALUE=DATE:20260921/);
  assert.match(payload.text, /尚未添加到日历/); assert.doesNotMatch(payload.html, /<script>/);
  assert.throws(() => validateCalendar({ ...allDay, end: allDay.start }));
  assert.equal(mailPayload(id, Buffer.from('# MD')).attachments.length, 1);
});
test('calendar persists across restart, is passed to sender once, and invalid input leaves no job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-calendar-'));
  let store = await JobStore.create(root);
  try {
    const history = [{ role: 'user' as const, content: 'Synthetic calendar test' }];
    assert.throws(() => store.enqueue(history, { ...event, end: event.start })); assert.equal(store.list().length, 0);
    const job = store.enqueue(history, event);
    for (let n = 0; n < 200 && store.get(job.id)?.state !== 'completed'; n++) await new Promise(r => setTimeout(r, 5));
    assert.equal(store.get(job.id)?.state, 'completed');
    await store.close(); store = await JobStore.create(root);
    assert.deepEqual(store.list()[0].calendar, event);
    let sends = 0;
    const sender = async (key: string, bytes: Buffer, metadata: any, calendar: any, timestamp?: string) => {
      sends++; const payload = mailPayload(key, bytes, metadata, calendar, timestamp);
      assert.equal(payload.attachments.length, 2); assert.equal(timestamp, job.created); return 'accepted' as const;
    };
    await store.email(job.id, sender); await store.email(job.id, sender); assert.equal(sends, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('ICS download fallback requires authentication and matches email attachment bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-calendar-http-')), jobs = await JobStore.create(root);
  const job = jobs.enqueue([{ role: 'user', content: 'Synthetic event' }], event);
  for (let n = 0; n < 200 && jobs.get(job.id)?.state !== 'completed'; n++) await new Promise(r => setTimeout(r, 5));
  const token = 'calendar-download-token-'.repeat(3);
  const app = createConversationServer({ token, jobs, model: { decide: async () => 'respond', reply: async () => {} }, transcriber: () => { throw Error('Unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `http://127.0.0.1:${(app.http.address() as { port: number }).port}/artifacts/${job.id}/calendar`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/calendar/);
    assert.match(response.headers.get('content-disposition')!, /attachment;/); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), calendarAttachment(job.id, event, job.created).content.toString());
  } finally { await app.close(); await jobs.close(); await rm(root, { recursive: true, force: true }); }
});
