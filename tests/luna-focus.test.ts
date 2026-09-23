import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLongDocument } from './luna-focus-cases.js';

test('long-document checks ignore headings and editorial terms inside code fences', () => {
  const checked = inspectLongDocument('# 标题\n## 背景\n甲乙😀\n```markdown\n## example\nWe need append only\n```\n## 验收\n测试完成', ['甲乙']);
  assert.equal(checked.sections, 2); assert.equal(checked.metaSuspected, false);
  assert.equal(checked.closedFences, true); assert.equal(checked.names, true);
});
test('long-document checks catch repeated headings, editorial leakage and open fences', () => {
  const checked = inspectLongDocument('## 数据模型\n## 数据模型\nWe need append only new paragraphs\n```yaml\na: b', ['missing']);
  assert.equal(checked.duplicateHeadings, true); assert.equal(checked.metaSuspected, true);
  assert.equal(checked.closedFences, false); assert.equal(checked.names, false);
});
