import { presentation } from './document-presentation.js';

export type CalendarEvent = { title: string; start: string; end: string; timezone: string; allDay: boolean; location: string; notes: string };
const invalid = () => new Error('CALENDAR_INVALID');
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9998-12-31') throw invalid();
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}
function instant(value: string, timezone: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw invalid();
  date(match[1]);
  if (+match[2] > 23 || +match[3] > 59 || (match[4] !== 'Z' && (+match[4].slice(1, 3) > 14 || +match[4].slice(4) > 59 || (+match[4].slice(1, 3) === 14 && +match[4].slice(4) !== 0)))) throw invalid();
  const time = Date.parse(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  // Explicit offset must agree with the IANA zone on this exact date (including DST).
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== value.slice(0, 16)) throw invalid();
  return time;
}
export function validateCalendar(value: unknown): CalendarEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  const fields = ['title', 'start', 'end', 'timezone', 'allDay', 'location', 'notes'];
  if (Object.keys(v).some(key => !fields.includes(key)) || typeof v.allDay !== 'boolean') throw invalid();
  for (const key of fields.filter(key => key !== 'allDay')) {
    if (typeof v[key] !== 'string' || (v[key] as string).length > (key === 'notes' ? 2000 : 200) || /[\p{Cc}\p{Cf}]/u.test(v[key] as string)) throw invalid();
  }
  const event = Object.fromEntries(fields.map(key => [key, typeof v[key] === 'string' ? (v[key] as string).trim() : v[key]])) as CalendarEvent;
  if (!event.title) throw invalid();
  if (event.allDay) {
    date(event.start); date(event.end);
    if (event.timezone !== '' || event.end <= event.start) throw invalid();
  } else {
    if (!event.timezone) throw invalid();
    try { if (instant(event.end, event.timezone) <= instant(event.start, event.timezone)) throw invalid(); } catch { throw invalid(); }
  }
  return event;
}
export function calendarDetails(event: CalendarEvent): string {
  const e = validateCalendar(event);
  return `${e.title}\n${e.start} → ${e.end}\n${e.allDay ? '全天；结束日期不包含在事件内' : `时区：${e.timezone}（时间包含 UTC 偏移）`}${e.location ? `\n地点：${e.location}` : ''}${e.notes ? `\n备注：${e.notes}` : ''}\n尚未添加到日历；请打开 ICS 附件确认导入。重复导入可能产生重复事件。`;
}
const escapeText = (text: string) => text.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
function fold(line: string): string {
  let output = '', length = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (length + bytes > 75) { output += '\r\n '; length = 1; }
    output += char; length += bytes;
  }
  return output;
}
const utc = (time: number) => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function calendarAttachment(id: string, value: CalendarEvent, created: string) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isFinite(Date.parse(created))) throw invalid();
  const e = validateCalendar(value);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Even Assistant//Calendar Export//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${id}@even-assistant.invalid`, `DTSTAMP:${utc(Date.parse(created))}`,
    e.allDay ? `DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}` : `DTSTART:${utc(Date.parse(e.start))}`,
    e.allDay ? `DTEND;VALUE=DATE:${e.end.replace(/-/g, '')}` : `DTEND:${utc(Date.parse(e.end))}`,
    `SUMMARY:${escapeText(e.title)}`, `DESCRIPTION:${escapeText(calendarDetails(e))}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
  return { filename: presentation(e.title, '', 'excerpt').filename.replace(/\.md$/, '.ics'),
    content: Buffer.from(lines.map(fold).join('\r\n') + '\r\n'), contentType: 'text/calendar; charset=utf-8' };
}
