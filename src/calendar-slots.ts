import type { CalendarEvent } from './calendar.js';
import type { CalendarItem } from './google-calendar.js';

export function zonedMinute(time: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(time).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}${p.timeZoneName.replace('GMT', '') || '+00:00'}`;
}
/** One verified alternative, same duration. Same-day later first, then next-day near requested hour.
 * Suggestions only: never substitutes the original operation or reserves this slot.
 */
export function suggestCalendarSlot(event: CalendarEvent, busy: CalendarItem[], excludeId: string) {
  if (event.allDay) return undefined;
  const start = Date.parse(event.start), duration = Date.parse(event.end) - start, zone = event.timezone;
  if (duration <= 0 || duration > 14 * 3600000) return undefined;
  const day = event.start.slice(0, 10), tomorrow = new Date(Date.parse(day + 'T00:00Z') + 86400000).toISOString().slice(0, 10);
  const requestedMinutes = Number(event.start.slice(11, 13)) * 60 + Number(event.start.slice(14, 16));
  const candidates: { start: string; end: string; rank: number }[] = [];
  for (let t = Math.ceil((start + 1) / 1800000) * 1800000; t + duration <= start + 48 * 3600000; t += 1800000) {
    const a = zonedMinute(t, zone), b = zonedMinute(t + duration, zone), date = a.slice(0, 10);
    if (![day, tomorrow].includes(date) || b.slice(0, 10) !== date || a.slice(11, 16) < '08:00' || b.slice(11, 16) > '22:00') continue;
    const occupied = busy.some(e => {
      if (e.id === excludeId) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.start) && /^\d{4}-\d{2}-\d{2}$/.test(e.end)) return date >= e.start && date < e.end;
      const s = Date.parse(e.start), end = Date.parse(e.end);
      return !Number.isFinite(s) || !Number.isFinite(end) || end <= s || (t < end && s < t + duration);
    });
    if (occupied) continue;
    const minutes = Number(a.slice(11, 13)) * 60 + Number(a.slice(14, 16));
    candidates.push({ start: a, end: b, rank: date === day ? minutes : 10000 + Math.abs(minutes - requestedMinutes) });
  }
  return candidates.sort((a, b) => a.rank - b.rank)[0];
}
