import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarQueryMatches, needsCalendarRead } from '../src/calendar-query.js';
const item = { id: 'a', title: 'Even 联动测试—非真实安排', start: '', end: '', timezone: '', location: '', editable: true };
test('generic category is not a title filter; mixed speech spacing and punctuation normalize', () => {
  assert.equal(calendarQueryMatches([item], '会议').length, 1);
  assert.equal(calendarQueryMatches([item], 'Even联动测试').length, 1);
  assert.equal(calendarQueryMatches([item], '不存在的名称').length, 0);
});
test('read routing catches date correction and recheck, without treating writes/other topics as reads', () => {
  assert.ok(needsCalendarRead('我说的是十月二号周五有没有什么会议？', []));
  assert.ok(needsCalendarRead('你确定没有任何的会议吗？', []));
  assert.ok(needsCalendarRead('十二号啦，是十月二号', [{ role: 'assistant', content: '请确认查询会议的日期' }]));
  for (const text of ['创建明天的会议', '取消会议', '生成会议MD发邮件', '十月二号天气怎么样']) assert.equal(needsCalendarRead(text, []), false);
});
