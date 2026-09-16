import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, Pager } from '../src/pager.ts';
test('mixed Chinese/English paginates without losing content or splitting surrogate pairs', () => {
  const text = '你好 Even hello 🌍 '.repeat(80);
  assert.equal(paginate(text).join('').replaceAll('\n', ''), text);
  assert.ok(paginate(text).length > 1);
  for (const page of paginate(text)) assert.ok(page.split('\n').length <= 5);
});
test('streaming keeps completed pages and selected page stable; navigation is bounded', () => {
  const pager = new Pager(); pager.append('a'.repeat(900)); pager.move(1);
  const before = pager.current; pager.append('后续内容'.repeat(100));
  assert.equal(pager.index, 1); assert.equal(pager.current, before);
  pager.move(-99); assert.equal(pager.index, 0);
  pager.move(999); assert.equal(pager.index, pager.pages.length - 1);
  pager.reset(); assert.equal(pager.index, 0); assert.equal(pager.pages.length, 1);
});
