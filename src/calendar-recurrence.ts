import type { CalendarEvent } from './calendar.js';
import { zonedMinute } from './calendar-slots.js';

/** Deliberately bounded subset. Never accept arbitrary RRULE/EXDATE instructions. */
export function recurrenceRule(value: string) {
  if (!value.startsWith('RRULE:')) throw Error('CALENDAR_RECURRENCE_UNSUPPORTED');
  const pairs = value.slice(6).split(';').map(s => s.split('='));
  if (pairs.some(([k, v, extra]) => !['FREQ', 'INTERVAL', 'COUNT'].includes(k) || !v || extra !== undefined)
    || new Set(pairs.map(([k]) => k)).size !== pairs.length) throw Error('CALENDAR_RECURRENCE_UNSUPPORTED');
  const fields = Object.fromEntries(pairs), intervalText = fields.INTERVAL ?? '1';
  if (!['DAILY', 'WEEKLY'].includes(fields.FREQ) || !/^[1-9]\d?$/.test(intervalText) || !/^[1-9]\d{0,2}$/.test(fields.COUNT ?? '')) throw Error('CALENDAR_RECURRENCE_UNSUPPORTED');
  const interval = +intervalText, count = +fields.COUNT;
  if (interval > 12 || count < 2 || count > 366) throw Error('CALENDAR_RECURRENCE_UNSUPPORTED');
  const days = (fields.FREQ === 'WEEKLY' ? 7 : 1) * interval;
  if (days * (count - 1) > 366) throw Error('CALENDAR_RECURRENCE_LIMIT');
  return { frequency: fields.FREQ, interval, count, days };
}
/** Normalize new write requests only. Never reinterpret an existing Google series. */
export function boundRecurrenceRequest(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  if (typeof v.recurrence !== 'string' || !v.recurrence || v.recurrence.includes('COUNT=')) return value;
  const m = /^RRULE:FREQ=(DAILY|WEEKLY);INTERVAL=([1-9]\d?)(?:;UNTIL=(\d{8}))?$/.exec(v.recurrence);
  if (!m || typeof v.start !== 'string' || typeof v.notes !== 'string') throw Error('CALENDAR_RECURRENCE_UNSUPPORTED');
  const first = v.start.slice(0, 10), start = Date.parse(first + 'T00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== first) throw Error('CALENDAR_INVALID');
  let cutoff: number;
  if (m[3]) {
    const endDate = `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6)}`;
    cutoff = Date.parse(endDate + 'T00:00Z');
    if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().slice(0, 10) !== endDate) throw Error('CALENDAR_INVALID');
  } else {
    const d = new Date(start), year = d.getUTCFullYear(), month = d.getUTCMonth() + 3;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    // Half-open interval [first day, same date three calendar months later).
    cutoff = Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)) - 86400000;
  }
  const base = `RRULE:FREQ=${m[1]};INTERVAL=${m[2]}`;
  const { days } = recurrenceRule(base + ';COUNT=2');
  const count = Math.floor((cutoff - start) / (days * 86400000)) + 1;
  const recurrence = base + ';COUNT=' + count;
  recurrenceRule(recurrence);
  const date = new Date(cutoff).toISOString().slice(0, 10);
  const note = m[3] ? `【期限】截至${date}。` : `【期限】默认3个月，截至${date}；延长需确认。`;
  const notes = [v.notes.replace(/【期限】[^。]*。/g, '').trim(), note].filter(Boolean).join(' ');
  return { ...v, recurrence, notes };
}

export function revisedRecurrenceNotes(event: CalendarEvent, before?: CalendarEvent): CalendarEvent {
  if (!before?.recurrence || !/【期限】/.test(event.notes) || (before.start === event.start && before.recurrence === event.recurrence)) return event;
  const last = recurrenceOccurrences(event).at(-1)!;
  return { ...event, notes: event.notes.replace(/【期限】[^。]*。/g, `【期限】已调整，末次${last.start.slice(0, 10)}；延长需确认。`) };
}
export function recurrenceLabel(value?: string) {
  if (!value) return '单次';
  const r = recurrenceRule(value);
  return `每${r.interval === 1 ? '' : r.interval}${r.frequency === 'WEEKLY' ? '周' : '天'}，共${r.count}次`;
}
/** Resolve wall time without silently shifting nonexistent or ambiguous DST hours. */
function wallTime(wall: string, zone: string) {
  const utc = Date.parse(wall + 'Z'), offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = utc + delta;
    offsets.add(Date.parse(zonedMinute(sample, zone).slice(0, 16) + 'Z') - sample);
  }
  const matches = [...offsets].map(offset => zonedMinute(utc - offset, zone)).filter(s => s.slice(0, 16) === wall);
  if (matches.length !== 1) throw Error('CALENDAR_RECURRENCE_DST_AMBIGUOUS');
  return matches[0];
}
export function recurrenceOccurrences(event: CalendarEvent): CalendarEvent[] {
  if (!event.recurrence) return [event];
  if (event.allDay) throw Error('CALENDAR_RECURRENCE_TIMED_ONLY');
  const r = recurrenceRule(event.recurrence);
  if (Date.parse(event.end) - Date.parse(event.start) > 86400000) throw Error('CALENDAR_RECURRENCE_DURATION_LIMIT');
  const day = (s: string, n: number) => new Date(Date.parse(s.slice(0, 10) + 'T00:00Z') + n * r.days * 86400000).toISOString().slice(0, 10);
  return Array.from({ length: r.count }, (_, i) => {
    const start = wallTime(day(event.start, i) + event.start.slice(10, 16), event.timezone);
    // Match Google: preserve elapsed duration, keeping the series start at local wall time.
    const end = zonedMinute(Date.parse(start) + Date.parse(event.end) - Date.parse(event.start), event.timezone);
    return { ...event, recurrence: '', start, end };
  });
}
