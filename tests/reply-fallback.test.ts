import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueModel, Message } from '../src/conversation.js';
import { createReplyFallback, ordinaryReply, PartialReplyError, requestsBaselineReply, RetryableReplyError } from '../src/reply-fallback.js';
import { baselineModel, modelProfile } from '../src/model-profile.js';

const model = (reply: DialogueModel['reply']): DialogueModel => ({ decide: async () => 'respond', reply });
const history: Message[] = [{ role: 'user', content: '为什么月亮看起来会变形？' }];
test('profile defaults preserve configuration; managed profiles pin baseline and reject typos', () => {
  assert.equal(modelProfile({}), 'configured');
  assert.equal(baselineModel({}, 'custom'), 'custom');
  for (const profile of ['hybrid-luna', 'all-5.6']) assert.equal(baselineModel({ EVEN_MODEL_PROFILE: profile }, 'gpt-6-luna'), 'gpt-5.6-luna');
  assert.throws(() => modelProfile({ EVEN_MODEL_PROFILE: 'HYBRID' }));
});
test('ordinary routing is narrow and explicit; retry commands are not followups/history', () => {
  assert.equal(ordinaryReply('low', 'casual', []), true);
  for (const mode of ['research', 'deep_reasoning', 'planning', 'compose', 'coaching', 'decision_support', 'brainstorm', undefined] as const)
    assert.equal(ordinaryReply('low', mode, []), false);
  assert.equal(ordinaryReply('medium', 'explain', []), false);
  assert.equal(ordinaryReply('low', 'explain'), false);
  assert.equal(ordinaryReply('low', 'explain', [{ kind: 'search', action: 'read' }]), false);
  for (const content of ['刚才的回答不对，请重新回答', '用5.6重新回答。', 'That answer was wrong, please answer again'])
    assert.equal(requestsBaselineReply([{ role: 'user', content }]), true);
  for (const content of ['再详细说一下', '刚才不对吗？', '他说“用5.6重新回答”', '请用5.6重新回答，然后发邮件'])
    assert.equal(requestsBaselineReply([{ role: 'user', content }]), false);
  assert.equal(requestsBaselineReply([{ role: 'assistant', content: '用5.6重新回答' }]), false);
});
test('empty/provider failure retries once, preserves input and reports metadata only', async () => {
  for (const failure of [undefined, new RetryableReplyError('http'), new RetryableReplyError('timeout')]) {
    let calls = 0, text = ''; const events: unknown[] = [];
    const reply = createReplyFallback(model(async () => { if (failure) throw failure; }), model(async (h, _s, delta) => {
      assert.equal(h, history); calls++; delta('地球上看到的是不同的受光面。');
    }), event => events.push(event));
    await reply(history, new AbortController().signal, chunk => text += chunk, undefined, 'low', 'explain', []);
    assert.equal(calls, 1); assert.ok(text); assert.equal(events.length, 2);
    assert.doesNotMatch(JSON.stringify(events), /月亮|地球|content|token/);
  }
});
test('partial text/status never mixes models; unknown/auth/budget/cancel failures never retry', async () => {
  for (const kind of ['partial', 'status', 'unknown', 'budget', 'cancel']) {
    let calls = 0; const controller = new AbortController();
    const reply = createReplyFallback(model(async (_h, _s, delta, update) => {
      if (kind === 'partial') delta('一半');
      if (kind === 'status') update?.({ type: 'search.status', status: 'searching' });
      if (kind === 'cancel') controller.abort();
      if (kind === 'unknown' || kind === 'budget') throw new Error(kind);
      throw new RetryableReplyError('stream');
    }), model(async () => { calls++; }));
    await assert.rejects(reply(history, controller.signal, () => {}, undefined, 'low', 'casual', []),
      kind === 'partial' || kind === 'status' ? PartialReplyError : Error);
    assert.equal(calls, 0);
  }
});
test('baseline failure does not loop; explicit retry bypasses primary; diagnostic errors are inert', async () => {
  let primary = 0, fallback = 0;
  const reply = createReplyFallback(model(async () => { primary++; throw new RetryableReplyError('network'); }),
    model(async () => { fallback++; throw new RetryableReplyError('network'); }), () => { throw Error('logger'); });
  await assert.rejects(reply(history, new AbortController().signal, () => {}, undefined, 'low', 'explain', []));
  assert.equal(primary, 1); assert.equal(fallback, 1);
  await assert.rejects(reply([...history, { role: 'user', content: '请用5.6重新回答' }], new AbortController().signal, () => {}, undefined, 'low', 'explain', []));
  assert.equal(primary, 1); assert.equal(fallback, 2);
});
