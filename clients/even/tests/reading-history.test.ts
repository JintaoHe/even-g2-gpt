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

test('removed links leave no empty wrappers, but meaningful parentheses survive', () => {
  const raw = '会。([example.com](https://example.com))\n- 活动（https://example.com/news）\n- 出游。()\n备注（适合家庭），日期 (9月18日)。';
  const visible = displayText(raw);
  assert.equal(visible, '会。\n- 活动\n- 出游。\n备注（适合家庭），日期 (9月18日)。');
  assert.equal(displayText('活动 (https://example.com/news) 下一项'), '活动  下一项');
  assert.equal(displayText('会。(( ))【 】[ ]'), '会。');
  const history = new ReadingHistory();
  history.event({ type: 'answer.start', id: 1 });
  history.event({ type: 'answer.delta', id: 1, text: raw });
  history.event({ type: 'answer.done', id: 1 });
  assert.equal(history.selected?.raw, raw);
  assert.doesNotMatch(history.pages.join(''), /\(\)|（）|https/);
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

test('long content uses non-overlapping pages while short content keeps one page', () => {
  const h = new ReadingHistory();
  h.event({ type: 'answer.start', id: 1 });
  h.event({ type: 'answer.delta', id: 1, text: Array.from({ length: 14 }, (_, i) => `第${i + 1}行`).join('\n') });
  h.event({ type: 'answer.done', id: 1 });
  assert.equal(h.scrolling, false);
  assert.match(h.label, /1\/3页/);
  assert.match(h.current, /第1行[\s\S]*第5行/);
  h.move(1);
  assert.match(h.label, /2\/3页/);
  assert.match(h.current, /第6行[\s\S]*第10行/);
  assert.doesNotMatch(h.current, /第[1-5]行/);
  h.move(-1);
  assert.match(h.label, /1\/3页/);

  const short = new ReadingHistory();
  short.event({ type: 'answer.start', id: 2 });
  short.event({ type: 'answer.delta', id: 2, text: '短回答' });
  short.event({ type: 'answer.done', id: 2 });
  assert.equal(short.scrolling, false);
  assert.match(short.label, /1\/1页/);
});

test('itinerary bullets become semantic pages without repeating the previous point', () => {
  const h = new ReadingHistory();
  h.event({ type: 'answer.start', id: 3 });
  h.event({ type: 'answer.delta', id: 3, text: '可以，行程这样安排：\n\n- 9月19日 7:00：从当前位置出发去环球影城。\n- 8:00：停车、安检和入园。\n- 18:00：离园开车去尔湾朋友家。\n- 9月20日 9:00：从朋友家返程。' });
  h.event({ type: 'answer.done', id: 3 });
  assert.ok(h.pages.length >= 2 && h.pages.length <= 3);
  const all = h.pages.join('\n');
  for (const marker of ['9月19日 7:00', '- 8:00', '- 18:00', '9月20日 9:00']) {
    assert.equal(all.split(marker).length - 1, 1, `${marker} must appear on exactly one page`);
  }
  assert.ok(h.pages.some(page => (page.match(/^-/gm) ?? []).length >= 2), 'short points should stack on one page');
  for (const page of h.pages) assert.ok(page.split('\n').length <= 5);
});

test('snapshot restore replaces an empty UI and deduplicates later replayed events by stable message id', () => {
  const h = new ReadingHistory(); h.reset('old placeholder');
  h.restoreSnapshot([
    { id: 'u1', sequence: 1, role: 'user', status: 'committed', content: '前一个问题' },
    { id: 'a1', sequence: 2, role: 'assistant', status: 'interrupted', content: '中断的回答' },
  ], true);
  assert.equal(h.entries.length, 2); assert.match(h.label, /已打断/);
  h.event({ type: 'turn.committed', message_id: 'u1', text: '前一个问题' });
  assert.equal(h.entries.length, 2);
  h.restoreSnapshot([{ id: 'a2', sequence: 3, role: 'assistant', status: 'committed', content: '补发回答' }]);
  assert.equal(h.entries.length, 3); assert.equal(h.current, '补发回答');
});
