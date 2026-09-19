import type { CalendarEvent } from './calendar.js';
import { recurrenceLabel } from './calendar-recurrence.js';

export type CalendarKind = 'create' | 'update' | 'cancel';
export function shortConfirmation(kind: CalendarKind) { return kind === 'create' ? '确认创建' : kind === 'cancel' ? '确认取消' : '确认修改'; }
export function calendarConfirmed(text: string, expected: string) {
  const clean = text.trim().replace(/[。！.!]+$/, '').trim().replace(/^(?:可以|好的|好|嗯)[，,、\s]+/, '');
  // Entire utterance only. Negations, questions, quotes and correction+approval never match.
  // A plain affirmative is accepted only by callers that also hold the exact
  // immediately preceding immutable preview and its unexpired approval ID.
  return [expected, '确认', '确定', '可以', '没问题'].includes(clean);
}
// This detects a likely confirmation attempt, NEVER authorization. Misheard verbs ask again.
export function calendarConfirmationAttempt(text: string) {
  return /^(?:(?:可以|好的|好|嗯)[，,、\s]*)?(?:确认|确定)(?:上线|创建|修改|取消|发送)?[。！.!]*$/.test(text.trim());
}
function clip(text: string, cells: number) {
  let result = '', used = 0;
  for (const c of text) { const width = /[\x20-\x7e]/.test(c) ? 1 : 2; if (used + width > cells) return result + '…'; result += c; used += width; }
  return result;
}
function previewValue(text: string, cells: number) {
  const value = clip(text, cells);
  return value === text ? value : `${value}〔完整内容保留〕`;
}
function appendedNote(before: string, after: string) {
  const prior = before.trim();
  if (!prior || !after.startsWith(prior)) return undefined;
  const addition = after.slice(prior.length).replace(/^[\s,，;；。.、:：]+/, '').trim().replace(/^新增[\s:：]*/, '');
  return addition || undefined;
}
export function previewLineCount(text: string, columns = 40) {
  let lines = 1, width = 0;
  for (const c of text) {
    if (c === '\n') { lines++; width = 0; continue; }
    const size = /[\x20-\x7e]/.test(c) ? 1 : 2;
    if (width + size > columns) { lines++; width = 0; } width += size;
  }
  return lines;
}
function when(e: CalendarEvent, zone: string) {
  if (e.allDay) return `${e.start}～${e.end}(结束日不含)`;
  const local = (s: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(s)).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  const start = local(e.start), end = local(e.end);
  // Repeated wall-clock hours during the autumn DST transition need an offset.
  const ambiguous = (s: string) => [-3600000, 3600000].some(delta => local(new Date(Date.parse(s) + delta).toISOString()) === local(s));
  if (ambiguous(e.start) || ambiguous(e.end)) {
    const offset = (s: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date(s)).find(p => p.type === 'timeZoneName')!.value;
    return `${start} ${offset(e.start)}–${end} ${offset(e.end)}`;
  }
  return start + '–' + (start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end);
}
/** Full changed values, no repeated notes/timezone conversions. Oversize edits fail closed. */
export function compactCalendarPreview(kind: CalendarKind, event: CalendarEvent, before?: CalendarEvent, overlaps: string[] = [], notifyGuests = false, alternative?: string, scope?: 'single' | 'series') {
  const zones: Record<string, string> = { 'America/Chicago': '芝加哥', 'America/Los_Angeles': '洛杉矶', 'America/New_York': '纽约' };
  const zone = event.timezone || 'America/Chicago';
  const label = zones[zone] ?? zone;
  const lines = [`${kind === 'update' ? '修改' : kind === 'create' ? '创建' : '取消'}·${label}时间：${clip(before?.title ?? event.title, 18)}`];
  if (scope) lines.push(scope === 'series' ? '范围：整个系列（含过去）' : '范围：仅这一次');
  if (event.recurrence || before?.recurrence) lines.push(before && before.recurrence !== event.recurrence
    ? `${recurrenceLabel(before.recurrence)} → ${recurrenceLabel(event.recurrence)}` : recurrenceLabel(event.recurrence));
  if (before && kind === 'update') {
    const oldTime = when(before, zone), newTime = when(event, zone);
    if (oldTime !== newTime || before.allDay !== event.allDay) lines.push(`原 ${oldTime}`, `新 ${newTime}`);
    if (before.timezone !== event.timezone) lines.push(`时区：${zones[before.timezone] ?? (before.timezone || '全天')}→${label}`);
    for (const [key, name] of [['location', '地点'], ['title', '标题'], ['notes', '备注']] as const) {
      if (key === 'notes' && before.notes !== event.notes && /【期限】/.test(event.notes)) {
        const strip = (s: string) => s.replace(/【期限】[^。]*。/g, '').trim();
        if (strip(before.notes) !== strip(event.notes)) lines.push(`备注：${previewValue(strip(before.notes) || '无', 28)} → ${previewValue(strip(event.notes) || '无', 48)}`);
        lines.push(event.notes.match(/【期限】[^。]*。/)![0]);
        continue;
      }
      if (before[key] !== event[key]) {
        const addition = key === 'notes' ? appendedNote(before.notes, event.notes) : undefined;
        lines.push(addition ? `备注：新增 ${previewValue(addition, 64)}`
          : `${name}：${previewValue(before[key] || '无', key === 'notes' ? 28 : 52)} → ${previewValue(event[key] || '无', key === 'notes' ? 48 : 72)}`);
      }
    }
  } else {
    lines.push(when(event, zone));
    if (event.location) lines.push(`地点：${previewValue(event.location, 80)}`);
    if (kind === 'create' && event.notes) lines.push(`备注：${previewValue(event.notes, 72)}`);
  }
  if (overlaps.length) lines.push(`⚠ 与${clip(overlaps[0], 12)}${overlaps.length > 1 ? `等${overlaps.length}项` : ''}重叠`);
  if (alternative) lines.push(alternative);
  if (notifyGuests) lines.push(kind === 'create' ? '将邀请你的固定邮箱' : '将通知原受邀人');
  if (event.allDay) lines.push('未检查全天日程重叠');
  lines.push(`${alternative ? '保留原时间，' : ''}说“${shortConfirmation(kind)}”`);
  const preview = lines.join('\n');
  // Long model-generated notes are abbreviated for the five-line display;
  // the validated full value remains in the immutable preview payload.
  if (previewLineCount(preview) > 15) throw new Error('CALENDAR_PREVIEW_TOO_LONG');
  return preview;
}
