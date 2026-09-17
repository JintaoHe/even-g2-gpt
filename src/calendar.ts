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
const zones: Record<string, { label: string; city: string; english: string }> = {
  'America/Chicago': { label: '美国芝加哥（中部时间）', city: '芝加哥', english: 'Chicago' },
  'America/Los_Angeles': { label: '美国洛杉矶（太平洋时间）', city: '洛杉矶', english: 'Los Angeles' },
  'America/New_York': { label: '美国纽约（东部时间）', city: '纽约', english: 'New York' }
};
function canonicalZone(zone: string): string { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
function localTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(Date.parse(value));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName.replace('GMT', 'UTC')}`;
}
export function calendarConfirmationPhrase(event: CalendarEvent, retry = false): string {
  const e = validateCalendar(event), verb = retry ? '重发' : '发送';
  if (e.allDay) return `确认全天日期并${verb}`;
  const zone = canonicalZone(e.timezone);
  return `确认按${zones[zone]?.city ?? zone}时间${verb}`;
}
export function calendarApprovalMatches(text: string, event: CalendarEvent, retry = false): boolean {
  const e = validateCalendar(event), verb = retry ? '重发' : '发送', englishVerb = retry ? 'resend' : 'send';
  const accepted = [calendarConfirmationPhrase(e, retry)];
  if (e.allDay) accepted.push(`confirm ${englishVerb} all-day dates`);
  else {
    const zone = canonicalZone(e.timezone), city = zones[zone];
    accepted.push(`确认按${zone}时间${verb}`, `confirm ${englishVerb} in ${zone} time`);
    if (city) accepted.push(`确认按美国${city.city}时间${verb}`, `确认按${city.english}时间${verb}`, `confirm ${englishVerb} in ${city.english} time`);
  }
  const normalize = (s: string) => s.trim().replace(/[。！.!]+$/, '').trim().toLowerCase();
  return accepted.some(phrase => normalize(phrase) === normalize(text));
}
export function calendarDetails(event: CalendarEvent, mode: 'export' | 'live' = 'export'): string {
  const e = validateCalendar(event);
  const zone = e.allDay ? '' : canonicalZone(e.timezone);
  const timing = e.allDay ? '全天日期，不绑定小时或时区；结束日期不包含在事件内。请确认这是全天事件，不是有具体时间的约会。'
    : `主时区：${zones[zone]?.label ?? zone} [${zone}]\n${[zone, ...Object.keys(zones).filter(z => z !== zone)].map(z =>
      `${zones[z]?.label ?? z} [${z}]：${localTime(e.start, z)} → ${localTime(e.end, z)}`).join('\n')}\n以上是同一事件的时区换算，不是多个事件。请核对每一端的完整日期、UTC 偏移和是否跨日；主时区未确认前不会${mode === 'live' ? '提交修改' : '发送'}。`;
  return `${e.title}\n${e.start} → ${e.end}\n${timing}${e.location ? `\n地点：${e.location}` : ''}${e.notes ? `\n备注：${e.notes}` : ''}${mode === 'export' ? '\n尚未添加到日历；请打开 ICS 附件确认导入。重复导入可能产生重复事件。' : ''}`;
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
export type CalendarInvitation = { uid: string; organizer: string; attendee: string; sequence: number; stamp: string };
export function calendarInvitation(value: CalendarEvent, invitation: CalendarInvitation) {
  const e = validateCalendar(value), i = invitation;
  const address = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;
  if (!address.test(i.organizer) || !address.test(i.attendee) || i.organizer.length > 254 || i.attendee.length > 254
    || !/^[a-zA-Z0-9@._-]{5,1024}$/.test(i.uid) || !Number.isSafeInteger(i.sequence) || i.sequence < 0
    || !Number.isFinite(Date.parse(i.stamp))) throw invalid();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Even Assistant//Calendar Invitation//EN', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', `UID:${i.uid}`, `DTSTAMP:${utc(Date.parse(i.stamp))}`, `SEQUENCE:${i.sequence}`, 'STATUS:CONFIRMED',
    `ORGANIZER;CN=Even Assistant:mailto:${i.organizer}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${i.attendee}`,
    e.allDay ? `DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}` : `DTSTART:${utc(Date.parse(e.start))}`,
    e.allDay ? `DTEND;VALUE=DATE:${e.end.replace(/-/g, '')}` : `DTEND:${utc(Date.parse(e.end))}`,
    `SUMMARY:${escapeText(e.title)}`, `DESCRIPTION:${escapeText(e.notes + '\n此邀请关联 Google Calendar 中的事件。请自行选择是否接受邀请。')}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
  return { method: 'REQUEST' as const, filename: presentation(e.title, '', 'excerpt').filename.replace(/\.md$/, '.ics'),
    content: Buffer.from(lines.map(fold).join('\r\n') + '\r\n') };
}
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
