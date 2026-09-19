import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactCalendarPreview, calendarConfirmed } from '../src/calendar-preview.js';
import { paginate } from '../clients/even/src/pager.js';
const before = { title: '午餐', start: '2026-09-16T18:00-05:00', end: '2026-09-16T19:00-05:00', timezone: 'America/Chicago', allDay: false, location: '家', notes: '这段没有变化的备注不需要在预览中重复。' };
test('normal time and location edit fits one actual SDK page, no repeated zones/notes', () => {
  const preview = compactCalendarPreview('update', { ...before, start: '2026-09-17T09:00-05:00', end: '2026-09-17T09:30-05:00', location: '园区咖啡馆' }, before);
  assert.equal(paginate(preview).length, 1);
  assert.match(preview, /原 2026-09-16 18:00–19:00/); assert.match(preview, /新 2026-09-17 09:00–09:30/);
  assert.match(preview, /地点：家 → 园区咖啡馆/); assert.doesNotMatch(preview, /其余不变|时间不变/);
  assert.doesNotMatch(preview, /洛杉矶|纽约|这段没有变化/);
});
test('an appended note shows only the addition and keeps unchanged fields off the glasses', () => {
  const preview = compactCalendarPreview('update', { ...before, notes: before.notes + ' 新增 lemon juice' }, before, [], true);
  assert.match(preview, /备注：新增 lemon juice/);
  assert.doesNotMatch(preview, /时间不变|这段没有变化的备注不需要在预览中重复.*→/);
  assert.equal(paginate(preview).length, 1);
});
test('conflict and guest notification fit two pages; long notes are visibly abbreviated without blocking the write preview', () => {
  const preview = compactCalendarPreview('update', { ...before, location: '园区咖啡馆' }, before, ['重叠事件', '另一事件'], true);
  assert.ok(paginate(preview).length <= 2); assert.match(preview, /重叠/); assert.match(preview, /通知原受邀人/);
  const long = compactCalendarPreview('update', { ...before, notes: '修改后的重要信息'.repeat(100) }, before);
  assert.match(long, /完整内容保留/); assert.match(long, /确认修改/); assert.ok(paginate(long).length <= 2);
});
test('short confirmations accept only whole affirmative utterances, not negation/quoted/question/correction', () => {
  for (const phrase of ['确认修改', '确认', '确定', '确认。', '确定！', '可以，确认修改', '好的，确认', '可以', '好，可以', '没问题']) assert.equal(calendarConfirmed(phrase, '确认修改'), true);
  for (const phrase of ['不要确认', '他说确认', '“确认”', '确认？', '确认，但改成十点', '确认取消', '不确定', '确认了吗', '确认发送']) assert.equal(calendarConfirmed(phrase, '确认修改'), false);
});
test('repeated DST hour is not presented as unchanged time', () => {
  const old = { ...before, start: '2026-11-01T01:00-05:00', end: '2026-11-01T01:30-05:00' };
  const preview = compactCalendarPreview('update', { ...old, start: '2026-11-01T01:00-06:00', end: '2026-11-01T01:30-06:00' }, old);
  assert.match(preview, /GMT-5/); assert.match(preview, /GMT-6/);
  assert.doesNotMatch(preview, /时间不变/); assert.ok(paginate(preview).length <= 2);
});
