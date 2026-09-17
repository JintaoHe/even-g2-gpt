import type { Message } from './conversation.js';
import type { CalendarItem } from './google-calendar.js';
export function isNextCalendarQuery(text: string) {
  if (/创建|新建|修改|改到|取消|删除|生成|假如|假设|\b(create|update|delete|cancel|move)\b/i.test(text)) return false;
  // Explicit anchors still go through the normal dated-query path.
  if (/明天|后天|下周|下个?月|明年|\d{1,4}[年月号日]|\d{4}-\d{2}-\d{2}|tomorrow|next week|next month/i.test(text)) return false;
  return /下一次|下次|\bnext\b/i.test(text) && /查|看|什么时候|何时|几点|when|what time|check/i.test(text);
}
// A read-only routing safety net. Never grants write authorization.
export function needsCalendarRead(text: string, history: Message[]) {
  if (isNextCalendarQuery(text) && /课程|私教|训练|training|class|appointment|会议|meeting|日程|calendar/i.test(text.replace(/\s/g, ''))) return true;
  if (/创建|新建|修改|改到|取消|删除|生成|发邮件|导出|假如|假设|怎么实现|create|update|delete|export/i.test(text)) return false;
  if (/(会议|日程|安排|日历|\bcalendar\b|\bmeetings?\b|\bevents?\b)/i.test(text)
    && /(查|有没有|有无|多少|几个|何时|什么时候|在哪里|确定|冲突|补充|备注|到场|参会|参加|建议|what|when|where|check|any|how many|attend|details)/i.test(text)) return true;
  const recent = history.slice(-3).map(m => m.content).join('\n');
  if (/(日历|日程|会议|芝加哥时间)/.test(recent) && /^(?:你确定吗|确定吗|再查一下|重新查一下|are you sure)[？?。.!！]*$/i.test(text.trim())) return true;
  return /(日历|日程|会议|芝加哥时间)/.test(recent) && !/天气|股票|新闻|weather|stock/i.test(text)
    && /(?:\d{1,4}|[一二三四五六七八九十]+)[年月号日]/.test(text) && /我说|是|不是|号|年/.test(text);
}
const normalize = (s: string) => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = previous;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}
/** Suggestions only, never identity or write authorization. All candidates came from Google. */
export function suggestCalendarMatches(items: CalendarItem[], filter: string) {
  const key = normalize(filter).slice(0, 100);
  if (key.length < 3) return [];
  const groups = new Map<string, CalendarItem>();
  for (const item of [...items].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const group = item.recurringEventId || normalize(item.title) + '|' + normalize(item.location);
    if (!groups.has(group)) groups.set(group, item);
  }
  const phonetic = (s: string) => s.replace(/igh/g, 'i').replace(/y/g, 'i').replace(/(.)\1+/g, '$1');
  return [...groups.values()].map(item => {
    const title = normalize(item.title).slice(0, 100);
    const score = Math.max(similarity(key, title), similarity(phonetic(key), phonetic(title)));
    return { item, score };
  }).filter(x => x.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 2).map(x => x.item);
}

/** Small, read-only acknowledgement vocabulary; mixed approval+mutation is never consumed. */
export function calendarChoice(text: string, items: CalendarItem[]): number | 'reject' | undefined {
  const clean = normalize(text);
  if (/^(不是|不对|都不是|都不对|不是这些|不是这个|不是那个|no|neither|noneofthem)$/.test(clean)) return 'reject';
  if (items.length === 1 && /^(对|对的|是|是的|没错|对就是那个|对就是这个|就是那个|就是这个|是就是这个|是的就是那个|嗯对|yes|yeah|yep|correct|thatsright|thatone)$/.test(clean)) return 0;
  const number = /^(?:选|是|就是|我要查|我说的是)?第?([一二12])(?:个|项)?$/.exec(clean)?.[1];
  if (number) { const index = ['一', '1'].includes(number) ? 0 : 1; return index < items.length ? index : undefined; }
  const matches = items.map((item, i) => ({ i, key: normalize(item.title) })).filter(x => clean === x.key || clean === '我说的是' + x.key || clean === '就是' + x.key);
  return matches.length === 1 ? matches[0].i : undefined;
}
export function calendarQueryMatches(items: CalendarItem[], filter: string) {
  const key = normalize(filter);
  if (!key || /^(会议|日程|安排|日历|meeting[s]?|event[s]?|calendar)$/.test(key)) return items;
  return items.filter(e => normalize(e.title).includes(key));
}
