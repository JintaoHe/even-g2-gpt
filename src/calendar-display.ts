import type { CalendarItem } from './google-calendar.js';
import { plainText } from './document-presentation.js';

export function calendarZoneLabel(zone: string) {
  return ({ 'America/Chicago': '芝加哥', 'America/Los_Angeles': '洛杉矶', 'America/New_York': '纽约' } as Record<string, string>)[zone] ?? zone;
}
function parts(value: string, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  const h = Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, period: h < 12 ? '上午' : '下午', clock: `${h % 12 || 12}:${p.minute}` };
}
export function calendarDisplayTime(start: string, end: string, zone = 'America/Chicago') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    // Google all-day end dates are exclusive; show the actual last day instead.
    const last = new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    return `${start}${last === start ? '' : '～' + last} 全天`;
  }
  const a = parts(start, zone), b = parts(end, zone);
  return `${a.date} ${a.period}${a.clock}–${a.date !== b.date ? b.date + ' ' : ''}${a.date !== b.date || a.period !== b.period ? b.period : ''}${b.clock}`;
}
export function calendarDisplayRange(start: string, end: string, zone: string) {
  const a = parts(start, zone), b = parts(end, zone);
  if (a.clock === '12:00' && a.period === '上午' && b.clock === '12:00' && b.period === '上午') {
    const last = parts(new Date(Date.parse(end) - 1).toISOString(), zone).date;
    return a.date === last ? a.date : `${a.date}～${last}`;
  }
  return calendarDisplayTime(start, end, zone);
}
export function calendarDisplayItems(items: CalendarItem[], zone: string) {
  return items.map((e, i) => {
    const notes = plainText(e.notes ?? e.event?.notes ?? '');
    return `${i + 1}. ${e.title}${e.recurringEventId ? '（重复会议·本次）' : ''}\n时间：${calendarDisplayTime(e.start, e.end, zone)}${e.location ? '\n地点：' + e.location : ''}${notes ? '\n备注：' + notes + (e.notesTruncated ? '（备注过长，显示内容已截断）' : '') : ''}${e.editable ? '' : '\n（只读）'}`;
  }).join('\n\n');
}
export function calendarOverlapSummary(items: CalendarItem[]) {
  const pairs: string[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    // All-day entries need date semantics, not implicit UTC parsing. Do not claim a full conflict audit.
    if (!a.start.includes('T') || !b.start.includes('T')) continue;
    if (Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)) pairs.push(`${i + 1}和${j + 1}`);
  }
  return pairs.length ? `时间重叠：第${pairs.slice(0, 3).join('、')}项${pairs.length > 3 ? '等' : ''}。\n` : '';
}
