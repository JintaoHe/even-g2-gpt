import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingHistory } from '../src/reading-history.ts';
import { displayText } from '../src/display-text.ts';
test('URLs and link syntax are display-only; attribution and caveats survive', () => {
  const raw = '截至今天，数据可能延迟。来源：[Federal Reserve](https://www.federalreserve.gov/a?b=1)。\nhttps://openai.com/news\nwww.example.com\n**并非实时行情**';
  const visible = displayText(raw);
  assert.match(visible, /Federal Reserve/); assert.match(visible, /数据可能延迟/); assert.match(visible, /并非实时行情/);
  assert.doesNotMatch(visible, /https|www\.|\.com|\]\(|\*\*/);
  const h = new ReadingHistory(); h.event({ type: 'answer.start', id: 1 }); h.event({ type: 'answer.delta', id: 1, text: raw });
  h.event({ type: 'answer.done', id: 1 }); assert.equal(h.selected?.raw, raw);
});
test('split URLs do not flash; Chinese text streams without waiting for spaces', () => {
  const prefix = '根据来源：';
  for (const suffix of ['h', 'http', 'https:', 'https://op', 'https://openai.com/a']) assert.equal(displayText(prefix + suffix, true), prefix);
  assert.equal(displayText('你好，这是正在显示的中文', true), '你好，这是正在显示的中文');
  assert.equal(displayText('来源 [OpenAI](https://openai.com', true), '来源 OpenAI');
});
test('speech deltas/finals keep segment order; committed question retained before answer', () => {
  const h = new ReadingHistory(); h.reset('ready');
  h.event({ type: 'speech.started', segment_id: 1 }); assert.match(h.label, /正在说/);
  h.event({ type: 'transcript.delta', segment_id: 1, text: 'Hi Even' }); assert.equal(h.current, 'Hi Even');
  h.event({ type: 'speech.started', segment_id: 2 });
  h.event({ type: 'transcript.final', segment_id: 2, text: '不要删除备注' });
  h.event({ type: 'transcript.final', segment_id: 1, text: '改到 next Friday' });
  assert.equal(h.current, '改到 next Friday\n不要删除备注');
  h.event({ type: 'turn.committed', text: '改到 next Friday，不要删除备注' });
  h.event({ type: 'answer.start', id: 10 }); h.event({ type: 'answer.delta', id: 10, text: '收到。' });
  assert.equal(h.selected?.role, 'Even'); h.move(-1); assert.equal(h.selected?.role, '你');
  assert.match(h.current, /不要删除备注/);
});
test('reading position stays fixed across deltas and completion; histories survive interruption', () => {
  const h = new ReadingHistory(); h.event({ type: 'turn.committed', text: '请解释' });
  h.event({ type: 'answer.start', id: 1 }); h.event({ type: 'answer.delta', id: 1, text: '一'.repeat(130) });
  const page = h.current; h.event({ type: 'answer.delta', id: 1, text: '二'.repeat(150) });
  assert.equal(h.page, 0); assert.equal(h.current, page);
  h.move(-1); assert.equal(h.current, '请解释');
  h.event({ type: 'answer.cancelled', id: 1 });
  h.event({ type: 'speech.started', segment_id: 2 });
  h.event({ type: 'transcript.final', segment_id: 2, text: '不是，我说的是另一个' });
  assert.equal(h.entries[1].interrupted, true);
  h.event({ type: 'answer.delta', id: 1, text: 'late' }); assert.doesNotMatch(h.entries[1].raw, /late/);
  h.move(-1); assert.match(h.label, /已打断/);
});
test('manual question/history reading is not stolen when answer starts', () => {
  const h = new ReadingHistory(); h.reset('ready'); h.event({ type: 'turn.committed', text: '问题' });
  h.move(-1); h.event({ type: 'answer.start', id: 1 }); assert.equal(h.current, 'ready');
  h.latest(); assert.equal(h.selected?.role, 'Even');
});
