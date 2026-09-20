import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestsAnswerRecovery } from '../src/conversation-server.js';

const accepted = [
  '刚才那条我没看完，继续说',
  '没看完，继续说',
  '说到一半',
  '你刚才说到一半就断了',
  '重复一下刚才的回答',
  'Say that again',
  '再说一遍',
  '刚刚那个没看清',
  '等一下，我没跟上',
  '屏幕闪了一下，刚才那段没了',
  'I missed the last part',
];

const rejected = [
  '继续说说这个方案的风险',
  '不用重复了',
  '他说再说一遍这句话是什么意思',
  '如果我没看完可以怎么办',
];

test('answer recovery recognizes the reported natural requests', () => {
  for (const phrase of accepted) assert.equal(requestsAnswerRecovery(phrase), true, phrase);
});

test('answer recovery does not hijack new questions, negation, quotations or hypotheticals', () => {
  for (const phrase of rejected) assert.equal(requestsAnswerRecovery(phrase), false, phrase);
});
