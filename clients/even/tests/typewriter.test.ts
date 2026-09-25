import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingHistory } from '../src/reading-history.ts';

function start(text: string) {
  const h = new ReadingHistory(true, true);
  h.event({ type: 'answer.start', id: 1 }); h.event({ type: 'answer.delta', id: 1, text }); return h;
}
test('burst response reveals small character batches, not rows, including after done', () => {
  const h = start('甲乙丙丁戊己庚辛壬癸');
  h.event({ type: 'answer.done', id: 1 });
  h.advanceReading(0); assert.equal(h.current, '甲');
  h.advanceReading(300); assert.equal(h.current, '甲乙丙');
  h.advanceReading(600); assert.equal(h.current, '甲乙丙丁戊');
  h.advanceReading(100000); assert.equal(Array.from(h.current).length, 8, 'no catch-up burst');
  assert.equal(h.selected?.raw, '甲乙丙丁戊己庚辛壬癸');
});
test('punctuation pauses and emoji code points are not split', () => {
  const h = start('😀，乙。丙');
  h.advanceReading(0); assert.equal(h.current, '😀');
  h.advanceReading(125); assert.equal(h.current, '😀，');
  assert.equal(h.advanceReading(474), false);
  h.advanceReading(475); assert.equal(h.current, '😀，乙');
  h.advanceReading(600); assert.equal(h.current, '😀，乙。');
  assert.equal(h.advanceReading(1249), false);
  h.advanceReading(1250); assert.equal(h.current, '😀，乙。丙');
});
test('up pauses reveal while reception continues; bottom resumes; latest explicitly skips backlog', () => {
  const h = start('甲乙丙丁'); h.advanceReading(0); h.move(-1);
  h.event({ type: 'answer.delta', id: 1, text: '戊己' });
  h.advanceReading(10000); assert.equal(h.current, '甲');
  h.move(1); h.advanceReading(10100); assert.equal(h.current, '甲乙');
  h.latest(); assert.equal(h.current, '甲乙丙丁戊己');
});
test('cancel, new question, reset and replacement snapshot stop queued reveal', () => {
  const h = start('私人资料'); h.advanceReading(0);
  h.event({ type: 'answer.cancelled', id: 1 }); h.advanceReading(1000); assert.equal(h.current, '私');
  h.event({ type: 'turn.committed', text: '新问题' }); h.advanceReading(2000); assert.equal(h.current, '新问题');
  h.reset('已清除'); h.advanceReading(3000); assert.equal(h.current, '已清除');
  h.event({ type: 'answer.delta', id: 1, text: '迟到' }); assert.equal(h.current, '已清除');
  h.restoreSnapshot([{ id: 's', sequence: 1, role: 'assistant', status: 'committed', content: '恢复后正文' }], true);
  h.advanceReading(4000); assert.equal(h.current, '恢复后正文');
});
