import type { Message } from './conversation.js';
import type { CalendarItem } from './google-calendar.js';
// A read-only routing safety net. Never grants write authorization.
export function needsCalendarRead(text: string, history: Message[]) {
  if (/创建|新建|修改|改到|取消|删除|生成|发邮件|导出|假如|假设|怎么实现|create|update|delete|export/i.test(text)) return false;
  if (/(会议|日程|安排|日历|\bcalendar\b|\bmeetings?\b|\bevents?\b)/i.test(text)
    && /(查|有没有|有无|多少|几个|何时|什么时候|在哪里|确定|冲突|补充|备注|到场|参会|参加|建议|what|when|where|check|any|how many|attend|details)/i.test(text)) return true;
  const recent = history.slice(-3).map(m => m.content).join('\n');
  if (/(日历|日程|会议|芝加哥时间)/.test(recent) && /^(?:你确定吗|确定吗|再查一下|重新查一下|are you sure)[？?。.!！]*$/i.test(text.trim())) return true;
  return /(日历|日程|会议|芝加哥时间)/.test(recent) && !/天气|股票|新闻|weather|stock/i.test(text)
    && /(?:\d{1,4}|[一二三四五六七八九十]+)[年月号日]/.test(text) && /我说|是|不是|号|年/.test(text);
}
const normalize = (s: string) => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
export function calendarQueryMatches(items: CalendarItem[], filter: string) {
  const key = normalize(filter);
  if (!key || /^(会议|日程|安排|日历|meeting[s]?|event[s]?|calendar)$/.test(key)) return items;
  return items.filter(e => normalize(e.title).includes(key));
}
