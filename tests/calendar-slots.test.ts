import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestCalendarSlot, zonedMinute } from '../src/calendar-slots.js';
import { compactCalendarPreview } from '../src/calendar-preview.js';
import { calendarDisplayTime } from '../src/calendar-display.js';
import { paginate } from '../clients/even/src/pager.js';
import type { CalendarItem } from '../src/google-calendar.js';
const event = { title: 'UI测试', start: '2026-09-16T20:00-05:00', end: '2026-09-16T21:00-05:00', timezone: 'America/Chicago', allDay: false, location: '园区机房', notes: '' };
const busy = (start: string, end: string): CalendarItem => ({ id: 'busy', title: '只读会议', start, end, timezone: event.timezone, location: '', editable: false });
test('suggests adjacent gap including read-only blockers, preserves duration, fits two pages', () => {
  const slot = suggestCalendarSlot(event, [busy(event.start, event.end)], 'new')!;
  assert.equal(slot.start, '2026-09-16T21:00-05:00'); assert.equal(slot.end, '2026-09-16T22:00-05:00');
  const preview = compactCalendarPreview('create', event, undefined, ['只读会议'], false, '本日历可选：' + calendarDisplayTime(slot.start, slot.end, event.timezone));
  assert.ok(paginate(preview).length <= 2); assert.match(preview, /保留原时间/);
});
test('no evening gap suggests next day same local time; full-day blocks and unknown times are conservative', () => {
  const occupied = [busy(event.start, '2026-09-16T22:00-05:00')];
  assert.equal(suggestCalendarSlot(event, occupied, 'new')!.start, '2026-09-17T20:00-05:00');
  assert.equal(suggestCalendarSlot(event, [...occupied, busy('2026-09-17', '2026-09-18')], 'new'), undefined);
  assert.equal(suggestCalendarSlot(event, [busy('invalid', 'invalid')], 'new'), undefined);
});
test('DST offsets are computed for the target instant, not copied from original day', () => {
  assert.equal(zonedMinute(Date.parse('2026-11-01T20:00-06:00'), event.timezone), '2026-11-01T20:00-06:00');
  const autumn = { ...event, start: '2026-10-31T20:00-05:00', end: '2026-10-31T21:00-05:00' };
  assert.equal(suggestCalendarSlot(autumn, [busy(autumn.start, '2026-10-31T22:00-05:00')], 'new')!.start, '2026-11-01T20:00-06:00');
});
