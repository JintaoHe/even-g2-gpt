import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextBuilder, contextCharacterCount, type ContextSummary } from '../src/context-builder.js';
import type { Message } from '../src/conversation.js';

function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index % 2 ? '回答' : '问题'} ${index} ${'内容'.repeat(18)}`,
    topicId: index < count - 40 ? 'older-topic' : 'current-topic',
    topicLabel: index < count - 40 ? '旧话题' : '当前话题',
    sequence: index + 1,
    status: 'committed',
  }));
}

const summary: ContextSummary = {
  version: 1,
  throughSequence: 470,
  overview: '用户先讨论了旅行，之后切换到产品设计。',
  topics: [
    { id: 'older-topic', label: '旅行', summary: '讨论过芝加哥行程，尚未预订。' },
    { id: 'current-topic', label: '产品设计', summary: '正在设计长对话恢复。' },
  ],
  confirmedDecisions: ['会话历史保留三年。'],
  unresolvedItems: ['真机到达后验证锁屏收音。'],
};

test('post-forgetting summary describes its restricted interval without implying earlier coverage', () => {
  const restarted = { ...summary, sourceLosses: [{ kind: 'forgotten', sequence: 82, omittedBytes: 0 }] };
  const result = new ContextBuilder({ maxCharacters: 4_000 }).build({ messages: history(40), summary: restarted });
  const block = result.messages.find(message => message.contextKind === 'summary')?.content ?? '';
  assert.match(block, /从消息序号 83 开始，到 470/);
  assert.match(block, /之前的部分不在摘要内/);
  assert.doesNotMatch(block, /已覆盖到消息序号/);
});

test('builds deterministic bounded context from 120 messages and keeps the latest turn', () => {
  const messages = history(120);
  const builder = new ContextBuilder({ maxCharacters: 5_000, recentMessageCount: 24 });
  const first = builder.build({ messages, summary, currentTopicId: 'current-topic' });
  const second = builder.build({ messages, summary, currentTopicId: 'current-topic' });

  assert.deepEqual(first, second);
  assert.ok(first.messages.some(message => message.content.includes(summary.overview)));
  assert.equal(first.messages.at(-1)?.content, messages.at(-1)?.content);
  assert.ok(first.messages.length < messages.length);
  assert.ok(contextCharacterCount(first.messages) <= 5_000);
});

test('handles 500 messages, Chinese and English, and resumes the active topic', () => {
  const messages = history(500);
  messages[475] = { ...messages[475], content: 'Let us return to the earlier API design / 回到接口设计。' };
  messages[499] = { ...messages[499], content: '继续这个 topic，并保留 this English detail。' };
  const result = new ContextBuilder({ maxCharacters: 6_000, recentMessageCount: 30 }).build({
    messages,
    summary,
    currentTopicId: 'current-topic',
  });

  assert.ok(result.messages.some(message => message.content.includes('产品设计')));
  assert.ok(result.messages.some(message => message.content.includes('English detail')));
  assert.equal(result.messages.at(-1)?.content, messages.at(-1)?.content);
  assert.ok(contextCharacterCount(result.messages) <= 6_000);
});

test('truncates oversized older messages without dropping the newest message', () => {
  const messages = history(120);
  messages[80] = { ...messages[80], content: `oversized:${'x'.repeat(50_000)}` };
  messages[119] = { ...messages[119], content: 'LATEST-MESSAGE-MUST-STAY' };
  const result = new ContextBuilder({ maxCharacters: 3_500, recentMessageCount: 25 }).build({ messages });

  assert.equal(result.messages.at(-1)?.content, 'LATEST-MESSAGE-MUST-STAY');
  assert.ok(contextCharacterCount(result.messages) <= 3_500);
});

test('an oversized interrupted newest answer is still present without exceeding the budget', () => {
  const result = new ContextBuilder({ maxCharacters: 512 }).build({ messages: [{
    role: 'assistant', content: 'x'.repeat(20_000), status: 'interrupted', sequence: 1,
  }] });
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content, /中断|interrupted/i);
  assert.ok(contextCharacterCount(result.messages) <= 512);
});

test('labels interrupted and failed assistant output as unconfirmed', () => {
  const messages: Message[] = [
    { role: 'user', content: '请设计行程', sequence: 1, status: 'committed' },
    { role: 'assistant', content: '我建议先买票', sequence: 2, status: 'interrupted' },
    { role: 'assistant', content: '日历已经保存', sequence: 3, status: 'failed' },
    { role: 'user', content: '继续', sequence: 4, status: 'committed' },
  ];
  const result = new ContextBuilder({ maxCharacters: 4_000 }).build({ messages });
  const interrupted = result.messages.find(message => message.sequence === 2);
  const failed = result.messages.find(message => message.sequence === 3);

  assert.match(interrupted?.content ?? '', /中断|interrupted/i);
  assert.match(interrupted?.content ?? '', /不能.*确认|not.*confirmed/i);
  assert.match(failed?.content ?? '', /失败|failed/i);
  assert.match(failed?.content ?? '', /不能.*确认|not.*confirmed/i);
});

test('summary warns that live Calendar, Email, cost and route facts must be reread', () => {
  const result = new ContextBuilder({ maxCharacters: 4_000 }).build({ messages: history(40), summary });
  const block = result.messages.find(message => message.contextKind === 'summary')?.content ?? '';
  assert.match(block, /Calendar/);
  assert.match(block, /Email/);
  assert.match(block, /成本/);
  assert.match(block, /路线/);
  assert.match(block, /工具.*重新读取/);
});
