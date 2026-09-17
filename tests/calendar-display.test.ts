import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDisplayTime, calendarDisplayRange, calendarDisplayItems } from '../src/calendar-display.js';
import { paginate } from '../clients/even/src/pager.js';
const zone = 'America/Chicago';
test('calendar list includes notes without empty labels or link markup', () => {
  const item = { id: 'costco', title: '去 West Des Moines Costco', start: '2026-09-17T12:00:00-05:00', end: '2026-09-17T13:00:00-05:00', timezone: zone, location: '', editable: true, notes: '需要购买牛奶、苹果、电池除草机。' };
  const text = calendarDisplayItems([item], zone);
  assert.match(text, /备注：需要购买牛奶、苹果、电池除草机。/);
  assert.ok(paginate(text).length <= 2);
  for (const notes of [undefined, '', '   \n ']) {
    assert.doesNotMatch(calendarDisplayItems([{ ...item, notes }], zone), /备注：/);
  }
  const readonly = { ...item, editable: false, notes: '<b>购买牛奶</b>，参考 [清单](https://example.com/list)' };
  const before = structuredClone(readonly);
  const rendered = calendarDisplayItems([readonly], zone);
  assert.match(rendered, /备注：购买牛奶，参考 清单/);
  assert.match(rendered, /只读/);
  assert.doesNotMatch(rendered, /<b>|https:|\]\(/);
  assert.deepEqual(readonly, before);
  assert.match(calendarDisplayItems([{ ...item, notesTruncated: true }], zone), /备注过长，显示内容已截断/);
});
test('event card shows readable minute precision and fits one SDK page', () => {
  const text = calendarDisplayItems([{ id: 'test', title: 'Even 对话测试 B—非真实安排', start: '2026-09-16T18:30:00-05:00', end: '2026-09-16T19:30:00-05:00', timezone: zone, location: '测试地点', editable: true }], zone);
  assert.match(text, /时间：2026-09-16 下午6:30–7:30/);
  assert.doesNotMatch(text, /T18|:00|America\/|\[|05:00/);
  assert.equal(paginate(text).length, 1);
});
test('noon, midnight, cross-day, explicit zone and all-day exclusive ends stay accurate', () => {
  assert.equal(calendarDisplayTime('2026-09-16T11:30:00-05:00', '2026-09-16T12:30:00-05:00', zone), '2026-09-16 上午11:30–下午12:30');
  assert.equal(calendarDisplayTime('2026-09-16T23:30:00-05:00', '2026-09-17T00:30:00-05:00', zone), '2026-09-16 下午11:30–2026-09-17 上午12:30');
  assert.equal(calendarDisplayTime('2026-09-16T18:30:42-05:00', '2026-09-16T19:30:59-05:00', 'America/Los_Angeles'), '2026-09-16 下午4:30–5:30');
  assert.equal(calendarDisplayTime('2026-09-16', '2026-09-17', zone), '2026-09-16 全天');
  assert.equal(calendarDisplayTime('2026-09-16', '2026-09-19', zone), '2026-09-16～2026-09-18 全天');
  assert.equal(calendarDisplayRange('2026-09-16T00:00-05:00', '2026-09-17T00:00-05:00', zone), '2026-09-16');
});
