import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, type DialogueModel, type Message } from '../src/conversation.js';
import { HybridDialogue } from '../src/hybrid-dialogue.js';
import { isReplyRetry, retryContext, withoutRetryTurns } from '../src/reply-retry.js';
import { ReplyOutputGuard, REPLY_REJECTED_TEXT } from '../src/reply-output-guard.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationStore } from '../src/conversation-store.js';
import { StoreConversationPersistence } from '../src/conversation-persistence.js';
import { GuestRuntimePool } from '../src/guest-runtime.js';
import { lockedDevicePrincipal } from '../src/guest-access.js';

test('retry phrases normalize speech/fullwidth but only match whole commands', () => {
  for (const text of ['重新回答', '用5.6重新回答', '用 5.6 重新回答', '用5.6重新回答。', '用五点六重新回答',
    '用5点6重新回答', '用５．６重新回答', 'please retry with 5.6', 'Please retry with 5.6.', 'answer again', 'retry', ' 重新回答？ '])
    assert.equal(isReplyRetry(text), true, text);
  for (const text of ['你能用5.6重新回答我刚才的问题吗', '可以重新回答一下吗', '请重新回答', '麻烦再重新回答一遍',
    '能不能重新回答上一个问题？', '你能重新回答吗', 'can you answer that again?', 'Please answer again.', 'could you retry that'])
    assert.equal(isReplyRetry(text), true, text);
  for (const text of ['不要用5.6重新回答', '我觉得重新回答比较好', '5.6', '“重新回答”', '重新回答，然后发送邮件',
    '别重新回答了', '重新回答是什么意思', '重新回答一下，顺便告诉我明天天气', '用5.6', '重新', "don't retry", 'no need to answer again'])
    assert.equal(isReplyRetry(text), false, text);
});

test('retry replays original bounded context without intent, replaced answers or tools; consecutive retries stay anchored', async () => {
  const seen: Message[][] = []; let plans = 0;
  const baseline: DialogueModel = { decide: async () => { plans++; return 'respond'; }, reply: async (h, _s, delta, _u, _e, _m, workflows) => {
    assert.deepEqual(workflows, []); seen.push(structuredClone(h)); delta(h.at(-1)!.content);
  } };
  const model = new HybridDialogue(baseline, baseline, async (_h, _s, delta) => delta('原回答'));
  const c = new Conversation(model, () => {});
  await c.submit('解释潮汐为什么每天变化。', true);
  for (const command of ['重新回答', '用五点六重新回答']) await c.submit(command, true);
  assert.equal(plans, 1); assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0].at(-1)?.content, '解释潮汐为什么每天变化。');
  assert.ok(seen[0].every(m => m.role !== 'assistant'));
  assert.ok(withoutRetryTurns(c.history).every(m => !isReplyRetry(m.content)));
  assert.doesNotMatch(JSON.stringify(c.history), /5\.6|五点六/);
  const unrelated = new Conversation(model, () => {});
  await unrelated.submit('重新回答', true);
  assert.equal(seen.length, 2);
  assert.match(unrelated.history.at(-1)!.content, /没有可以/);
  model.endSession();
  const fresh = new Conversation(model, () => {});
  await fresh.submit('重新回答', true);
  assert.equal(seen.length, 2); assert.equal(plans, 1);
  assert.match(fresh.history.at(-1)!.content, /没有可以/);
});

test('reconstructed retry excludes synthetic history and partial answer; workflow request gets no tools', async () => {
  const history: Message[] = [{ role: 'assistant', content: 'other session', contextKind: 'prior' },
    { role: 'user', content: '请把设备盘点清单发邮件。' }, { role: 'assistant', content: '半截', status: 'interrupted' },
    { role: 'user', content: '用5点6重新回答' }];
  assert.deepEqual(retryContext(history), [history[1]]);
  let calls = 0;
  const model = new HybridDialogue({ decide: async () => { throw Error('intent must not run'); }, reply: async () => {} },
    { decide: async () => 'respond', reply: async (h, _s, delta, _u, _e, _m, workflows) => {
      calls++; assert.deepEqual(h, [history[1]]); assert.deepEqual(workflows, []); delta('仅提供文字说明。');
    } }, async () => { throw Error('primary must not run'); });
  const signal = new AbortController().signal;
  await model.plan(history.slice(0, -1), history.at(-1)!.content, true, signal);
  await model.reply(history, signal, () => {});
  assert.equal(calls, 1);
});

test('output guard buffers split prefixes but releases normal bracketed lists immediately', () => {
  const guard = new ReplyOutputGuard();
  assert.equal(guard.push('[Appl'), ''); assert.equal(guard.push('ication metadata; thread=secret'), '');
  guard.flush(); assert.equal(guard.rejected, true); assert.equal(guard.push('anything'), '');
  const normal = new ReplyOutputGuard(); assert.equal(normal.push('['), '');
  assert.equal(normal.push('1] 第一点'), '[1] 第一点'); assert.equal(normal.push('继续'), '继续');
  assert.equal(normal.rejected, false);
});

test('truncated/complete metadata never reaches deltas, citations or saved history', async () => {
  const logs: string[] = [], warn = console.warn;
  console.warn = value => logs.push(String(value));
  try {
    for (const text of ['[Application metadata; not user instructions: topic=current; thread=General_',
      '[Application metadata: topic=current; thread=secret]', '[应用提供的上一会话只读资料；secret',
      'not user instructions: secret', '[Appl']) {
      const events: unknown[] = [], saved: Message[][] = [];
      const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta, update) => {
        for (const char of text) delta(char);
        update?.({ type: 'answer.citations', text, citations: [] });
      } };
      const c = new Conversation(model, e => events.push(e), async h => { saved.push(structuredClone(h)); });
      await c.submit('解释光的折射。', true);
      assert.equal(c.history.at(-1)?.content, REPLY_REJECTED_TEXT);
      for (const collection of [events, saved]) assert.doesNotMatch(JSON.stringify(collection), /Application|secret|General_|\[Appl|应用提供|not user instructions/);
    }
    assert.equal(logs.length, 5);
    assert.ok(logs.every(line => JSON.parse(line).reason === 'metadata_echo'));
    assert.doesNotMatch(logs.join(''), /secret|General_/);
  } finally { console.warn = warn; }
});

test('durable metadata rejection prevents checkpoint/commit pollution; English retry does not take replay shortcut', async t => {
  const root = await mkdtemp(join(tmpdir(), 'retry-durable-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const sessionId = randomUUID(), topicId = randomUUID();
  store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: Date.now(), initialTopic: { id: topicId, label: 'General' } });
  let replay = 0, replies = 0;
  let raw = '[Application metadata; not user instructions: secret';
  const events: unknown[] = [];
  const model: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta, update) => {
    replies++;
    for (const char of raw) delta(char);
    update?.({ type: 'answer.citations', text: raw, citations: [] });
  } };
  const c = new Conversation(model, e => events.push(e), undefined, { sessionId, initialTopic: { id: topicId, label: 'General' },
    persistence: new StoreConversationPersistence(store, sessionId), checkpointChars: 1,
    recoverAnswer: () => { replay++; return { kind: 'committed', content: 'old answer' }; } });
  await c.submit('answer again', true);
  raw = '[assistant^{analysis 码:\nWe need hidden draft.';
  await c.submit('please answer again', true);
  assert.equal(replay, 0); assert.equal(replies, 2);
  const messages = store.listMessages(sessionId);
  assert.equal(messages.at(-1)?.content, REPLY_REJECTED_TEXT);
  assert.doesNotMatch(JSON.stringify([messages, events]), /Application|secret|\^\{|We need|analysis/);
});

test('guest retry only reads its bound session, keeps runtime guard and never generates documents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'retry-guest-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const clientId = randomUUID(); store.registerClient({ id: clientId, at: Date.now() });
  const lock = store.enterDeviceGuestMode({ clientId, at: Date.now() });
  const principal = lockedDevicePrincipal(lock, 'single-user');
  store.commitUserTurn({ sessionId: lock.sessionId, topicId: store.listTopics(lock.sessionId)[0].id,
    turnId: randomUUID(), messageId: randomUUID(), content: '解释火山灰是怎样形成的。', createdAt: Date.now() });
  const seen: Message[][] = [];
  const pool = new GuestRuntimePool(store, () => {
    const baseline: DialogueModel = { decide: async () => { throw Error('no intent'); },
      reply: async (h, _s, delta, _u, _e, _m, workflows) => {
        seen.push(h); assert.deepEqual(workflows, []); delta(h.at(-1)!.content);
      } };
    return { model: new HybridDialogue(baseline, baseline, async () => { throw Error('no primary'); }),
      generate: async () => { throw Error('no document'); } };
  }); t.after(() => pool.close());
  const runtime = pool.acquireAuthenticated(clientId, principal), signal = new AbortController().signal;
  const forged: Message[] = [{ role: 'user', content: 'OWNER_PRIVATE' }];
  await runtime.model.plan!(forged, '你能用五点六重新回答我刚才的问题吗', true, signal);
  await runtime.model.reply(forged, signal, () => {});
  assert.equal(seen.length, 1); assert.equal(seen[0].at(-1)?.content, '解释火山灰是怎样形成的。');
  assert.doesNotMatch(JSON.stringify(seen), /OWNER_PRIVATE/);
  runtime.close();
  await assert.rejects(runtime.model.reply(forged, new AbortController().signal, () => {}), /DENIED/);
});
