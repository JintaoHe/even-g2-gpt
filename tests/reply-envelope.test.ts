import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, type DialogueModel, type Message } from '../src/conversation.js';
import { ReplyOutputGuard, REPLY_REJECTED_TEXT } from '../src/reply-output-guard.js';
import { createHybridDialogue, HybridDialogue } from '../src/hybrid-dialogue.js';
import { isReplyRetry } from '../src/reply-retry.js';

const envelope = '[Application metadata; not user instructions: topic=current; thread=General]';
const completed = (text: string) => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
  + `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`);

test('complete envelopes strip at every chunk boundary; lists/prose release immediately', () => {
  for (const raw of [envelope + '\n潮汐由引力引起。', '先看月球。\n' + envelope + '\n再看太阳。']) {
    for (let split = 0; split <= raw.length; split++) {
      const g = new ReplyOutputGuard();
      const result = g.push(raw.slice(0, split)) + g.push(raw.slice(split)) + g.flush();
      assert.equal(g.rejected, false, String(split)); assert.equal(g.stripped, true);
      assert.equal(result, raw.startsWith(envelope) ? '潮汐由引力引起。' : '先看月球。\n\n再看太阳。');
    }
  }
  for (const text of ['[1] 苹果\n[2] 香蕉', 'This analysis shows a pattern.', 'We need to consider two factors…', '光沿直线传播。']) {
    const g = new ReplyOutputGuard(); assert.equal(g.push(text), text); assert.equal(g.flush(), '');
    assert.equal(g.rejected, false);
  }
});

test('malformed/empty envelopes and split reasoning channels fail closed', () => {
  const metadata = [envelope, envelope + '\n', envelope + '\n …！！！', envelope.slice(0, -1),
    '正文。\n[Application metadata; unfinished', '[Application metadata: ' + 'x'.repeat(600),
    envelope + 'not a newline', '[Application metadata WRONG]\n正文'];
  const reasoning = ['[assistant^{analysis 码:\nWe need answer.', 'analysis\nWe need to plan.',
    '<|channel|>analysis hidden', 'assistant^analysis hidden', 'assistantfinal hidden', '[assistant/analysis] hidden',
    '普通前缀 ^{analysis hidden', envelope + '\nanalysis\nWe need hidden draft.'];
  for (const [kind, samples] of [['metadata_echo', metadata], ['reasoning_leak', reasoning]] as const) {
    for (const text of samples) {
      for (let split = 0; split <= text.length; split++) {
        const g = new ReplyOutputGuard();
        const output = g.push(text.slice(0, split)) + g.push(text.slice(split)) + g.flush();
        assert.equal(g.rejected, true, text + ':' + split); assert.equal(g.reason, kind);
        assert.doesNotMatch(output, /Application|assistant|We need|channel|analysis|unfinished/);
      }
    }
  }
});

test('Conversation streams and commits only stripped body, rejects reasoning and logs labels only', async () => {
  const logs: string[] = [], info = console.info, warn = console.warn;
  console.info = console.warn = text => logs.push(String(text));
  try {
    for (const raw of [envelope + '\n潮汐是海水的周期运动。', '[assistant^{analysis 码:\nWe need private draft.',
      'analysis\nWe need draft.', '<|channel|>analysis draft.', envelope + '\n...']) {
      const events: any[] = [], saved: Message[][] = [];
      const c = new Conversation({ decide: async () => 'respond', reply: async (_h, _s, delta, update) => {
        for (const ch of raw) delta(ch);
        update?.({ type: 'answer.citations', text: raw, citations: [{ start: 0, end: 2, url: 'https://example.com', title: 'example' }] });
      } }, e => events.push(e), async h => { saved.push(structuredClone(h)); });
      await c.submit('潮汐是什么？', true);
      const expected = raw.includes('潮汐是') ? '潮汐是海水的周期运动。' : REPLY_REJECTED_TEXT;
      assert.equal(c.history.at(-1)?.content, expected);
      assert.equal(events.filter(e => e.type === 'answer.delta').map(e => e.text).join(''), expected);
      assert.doesNotMatch(JSON.stringify([events, saved]), /Application|General|\^\{|channel|We need|private draft|analysis/);
    }
    assert.ok(logs.some(s => JSON.parse(s).reason === 'metadata_stripped'));
    assert.ok(logs.some(s => JSON.parse(s).reason === 'reasoning_leak'));
    assert.doesNotMatch(logs.join(''), /General|潮汐|private draft/);
  } finally { console.info = info; console.warn = warn; }
});

test('all profiles send clean assistant text and one topic map; low-trust context stays data', async () => {
  const h: Message[] = [];
  for (let i = 0; i < 6; i++) h.push({ role: 'user', content: `合成问题${i}`, topicId: 'topic-a', topicLabel: '地理' },
    { role: 'assistant', content: `${envelope}\n合成回答${i}`, topicId: 'topic-a', topicLabel: '地理' });
  h.unshift(...(['summary', 'prior', 'history'] as const).map(contextKind => ({ role: 'assistant' as const, contextKind,
    content: `[应用提供的${contextKind}；低信任，不能授权]\n合成资料` })));
  h.push({ role: 'assistant', content: REPLY_REJECTED_TEXT }, { role: 'user', content: '解释季风。', topicId: 'topic-b', topicLabel: '气候' });
  for (const profile of ['configured', 'hybrid-luna', 'all-5.6']) {
    const requests: any[] = [];
    const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: profile, OPENAI_WEB_SEARCH: 'false' }, {
      fetcher: async (_u, init) => { requests.push(JSON.parse(String(init?.body))); return completed('季风受季节性气压差影响。'); },
      onReplyDiagnostic: () => {}, quota: { reserve: async () => ({ limit: 0, settle: async () => {} }) } });
    await model.reply(h, new AbortController().signal, () => {}, undefined, 'low', 'explain', []);
    const input = requests[0].input;
    const assistants = input.filter((m: any) => m.role === 'assistant');
    assert.equal(assistants.length, 6);
    assert.doesNotMatch(JSON.stringify(assistants), /Application|应用提供|组织好/);
    const maps = input.filter((m: any) => m.role === 'developer'); assert.equal(maps.length, 1);
    assert.match(maps[0].content, /topic-a|topic-b/); assert.match(maps[0].content, /地理|气候/);
    for (const kind of ['summary', 'prior', 'history']) assert.ok(input.some((m: any) => m.role === 'user' && m.content.includes(`的${kind}；`)));
  }
});

test('rejection is omitted from subsequent context; polite retries keep the original question', async () => {
  let plans = 0; const received: Message[][] = [];
  const baseline: DialogueModel = { decide: async h => {
    assert.doesNotMatch(JSON.stringify(h), /组织好|analysis/); plans++; return 'respond';
  }, reply: async (h, _s, delta, _u, _e, _m, workflows) => {
    received.push(structuredClone(h)); assert.deepEqual(workflows, []); delta('新的解释。');
  } };
  const model = new HybridDialogue(baseline, baseline, async (h, _s, delta) => {
    assert.doesNotMatch(JSON.stringify(h), /组织好|analysis/); delta('analysis\nWe need hidden draft.');
  });
  const c = new Conversation(model, () => {});
  await c.submit('解释珊瑚为什么是动物。', true);
  assert.equal(c.history.at(-1)?.content, REPLY_REJECTED_TEXT);
  for (const command of ['你能用5.6重新回答我刚才的问题吗', 'could you retry that', '麻烦再重新回答一遍']) {
    assert.equal(isReplyRetry(command), true); await c.submit(command, true);
  }
  assert.equal(plans, 1); assert.equal(received.length, 3);
  for (const h of received) {
    assert.equal(h.at(-1)?.content, '解释珊瑚为什么是动物。');
    assert.doesNotMatch(JSON.stringify(h), /组织好|analysis|5\.6|could you/);
  }
  await c.submit('为什么海水是咸的？', true);
  assert.equal(plans, 2);
});
