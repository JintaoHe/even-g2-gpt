import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingHistory } from '../src/reading-history.ts';

const text = Array.from({ length: 20 }, (_, i) => `餐厅${i + 1} 评分4.6 地址 Main St`).join('\n');
function start() {
  const h = new ReadingHistory('manual-pages');
  h.event({ type: 'answer.start', id: 1 }); h.event({ type: 'answer.delta', id: 1, text }); return h;
}
test('burst, streaming, final and elapsed time never move first page', () => {
  const h = start(); const first = h.current;
  assert.match(first, /^餐厅1 /); assert.equal(first.split('\n').length, 6);
  h.event({ type: 'answer.delta', id: 1, text: '\n餐厅21 地址 Broadway' });
  h.event({ type: 'answer.committed', id: 1, content: text + '\n餐厅21 地址 Broadway' });
  h.event({ type: 'answer.done', id: 1 });
  for (const now of [0, 4000, 999999]) assert.equal(h.advanceReading(now), false);
  assert.equal(h.current, first); assert.equal(h.page, 0);
});
test('gestures move whole nonoverlapping pages and preserve the full answer', () => {
  const h = start(); h.event({ type: 'answer.done', id: 1 }); const pages = [h.current];
  while (h.page < h.pages.length - 1) { h.move(1); pages.push(h.current); }
  assert.equal(pages.join('\n'), text);
  h.move(-1); const held = h.current;
  h.event({ type: 'answer.delta', id: 1, text: '\n最后一家' }); assert.equal(h.current, held);
  h.latest(); assert.equal(h.page, 0); assert.match(h.current, /^餐厅1 /);
});
test('wider lines keep a realistic short venue rating together', () => {
  const h = new ReadingHistory('manual-pages');
  h.event({ type: 'answer.start', id: 1 });
  const row = 'Shake Shack · 4.6 · 123 Main Street';
  h.event({ type: 'answer.delta', id: 1, text: row });
  h.event({ type: 'answer.done', id: 1 });
  assert.equal(h.current, row);
});
test('new question starts at page one; reset drops frozen view and late answer', () => {
  const h = start(); h.move(1);
  h.event({ type: 'turn.committed', text: '下一题' });
  h.event({ type: 'answer.start', id: 2 }); h.event({ type: 'answer.delta', id: 2, text });
  assert.equal(h.page, 0); h.move(1); h.reset('已清除');
  h.event({ type: 'answer.delta', id: 2, text: '迟到正文' });
  assert.equal(h.current, '已清除');
});
