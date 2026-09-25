import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingHistory } from '../src/reading-history.ts';

const long = Array.from({ length: 40 }, (_, i) => `行${i + 1} 中英文 mixed text`).join('\n');
function answer() {
  const h = new ReadingHistory(true);
  h.event({ type: 'answer.start', id: 1 });
  h.event({ type: 'answer.delta', id: 1, text: long }); return h;
}
test('production window starts at beginning; manual latest and bottom resume paced reading', () => {
  const h = answer(); assert.equal(h.current.split('\n').length, 6); assert.match(h.current, /^行1 /);
  h.latest(); assert.match(h.current, /行40/);
  h.move(-1); const frozen = h.current;
  h.event({ type: 'answer.delta', id: 1, text: '\n行41 newest' });
  assert.equal(h.current, frozen);
  h.move(1); h.move(1); h.event({ type: 'answer.delta', id: 1, text: '\n行42 newest' });
  assert.doesNotMatch(h.current, /行42/); assert.match(h.label, /慢读/);
  h.advanceReading(0); h.advanceReading(4000); assert.match(h.current, /行42/);
});

test('burst answer stays on first screen then advances one row per reading interval even after done', () => {
  const h = answer(); h.event({ type: 'answer.done', id: 1 });
  assert.equal(h.page, 0);
  assert.equal(h.advanceReading(0), false);
  assert.equal(h.advanceReading(3999), false); assert.equal(h.page, 0);
  assert.equal(h.advanceReading(4000), true); assert.equal(h.page, 1);
  assert.equal(h.advanceReading(5799), false);
  assert.equal(h.advanceReading(5800), true); assert.equal(h.page, 2);
  assert.equal(h.advanceReading(999999), true); assert.equal(h.page, 3, 'no burst catch-up after background suspension');
  h.move(-1); const frozen = h.current;
  h.advanceReading(9999999); assert.equal(h.current, frozen);
});

test('new question resets reading delay and interrupted output never auto-advances', () => {
  const h = answer(); h.advanceReading(0); h.advanceReading(4000);
  h.event({ type: 'turn.committed', text: '新问题' });
  h.event({ type: 'answer.start', id: 2 }); h.event({ type: 'answer.delta', id: 2, text: long });
  h.advanceReading(6000); h.advanceReading(9999); assert.equal(h.page, 0);
  h.event({ type: 'answer.cancelled', id: 2 }); h.advanceReading(10000); assert.equal(h.page, 0);
});
test('done preserves manual position; full raw answer remains navigable', () => {
  const h = answer(); h.move(-1); const frozen = h.current;
  h.event({ type: 'answer.committed', id: 1, content: long + '\n最终来源' });
  h.event({ type: 'answer.done', id: 1 }); assert.equal(h.current, frozen);
  for (let i = 0; i < 100; i++) h.move(-1);
  assert.match(h.current, /^行1 /); h.latest(); assert.match(h.current, /最终来源/);
  assert.equal(h.selected?.raw, long + '\n最终来源');
});
test('new question resets follow; context reset removes frozen private text and late output', () => {
  const h = answer(); h.move(-1);
  h.event({ type: 'turn.committed', text: '新问题' });
  h.event({ type: 'answer.start', id: 2 });
  h.event({ type: 'answer.delta', id: 2, text: '秘密' }); assert.equal(h.current, '秘密');
  h.move(-1); h.reset('上下文已清除');
  h.event({ type: 'answer.delta', id: 2, text: '迟到秘密' });
  assert.equal(h.current, '上下文已清除'); assert.doesNotMatch(JSON.stringify(h.entries), /秘密/);
});
test('snapshot replacement clears manual cache and emoji rows never split a code point', () => {
  const h = answer(); h.move(-1);
  h.restoreSnapshot([{ id: 'new', sequence: 1, role: 'assistant', status: 'committed', content: '😀'.repeat(200) }], true);
  assert.doesNotMatch(h.current, /mixed/);
  assert.ok(Array.from(h.current.replace(/\n/g, '')).every(point => point === '😀'));
  assert.ok(h.current.length < 2000);
});
