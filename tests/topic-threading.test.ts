import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTopicHistory, Conversation, type Message, type TurnPlan } from '../src/conversation.js';

test('one session keeps full short-term memory while retaining topic boundaries', async () => {
  const plans: TurnPlan[] = [
    { decision: 'respond', cognitiveMode: 'planning', reasoningEffort: 'medium',
      topicAction: 'continue', topicTarget: null, topicLabel: 'Chicago trip' },
    { decision: 'respond', assistantMode: 'planning', reasoningEffort: 'medium',
      topicAction: 'switch', topicTarget: null, topicLabel: 'Retail business idea' },
    { decision: 'respond', assistantMode: 'planning', reasoningEffort: 'medium',
      topicAction: 'continue', topicTarget: null, topicLabel: 'Retail business idea' },
    { decision: 'respond', cognitiveMode: 'planning', reasoningEffort: 'medium',
      topicAction: 'resume', topicTarget: 'topic-1', topicLabel: 'Chicago trip' },
    { decision: 'respond', assistantMode: 'planning', reasoningEffort: 'medium',
      topicAction: 'continue', topicTarget: null, topicLabel: 'Chicago trip' }
  ];
  const replyHistories: Message[][] = [];
  const conversation = new Conversation({
    plan: async () => plans.shift()!,
    decide: async () => 'respond',
    reply: async (history, _signal, delta) => { replyHistories.push(history); delta('ok'); }
  }, () => {});

  await conversation.submit('先规划 Chicago 路线');
  await conversation.submit('等一下，先聊我的 retail business idea');
  await conversation.submit('把这个 business plan 做得更具体');
  await conversation.submit('回到之前的 Chicago 路线');
  await conversation.submit('把这个 trip plan 整理成文档');

  assert.deepEqual(conversation.history.filter(message => message.role === 'user').map(message => message.topicId),
    ['topic-1', 'topic-2', 'topic-2', 'topic-1', 'topic-1']);
  assert.ok(replyHistories[2].some(message => message.content.includes('Chicago 路线')));
  assert.ok(replyHistories[2].some(message => message.content.includes('retail business')));
  assert.ok(replyHistories[3].some(message => message.content.includes('Chicago 路线')));
  assert.ok(replyHistories[4].some(message => message.content.includes('Chicago 路线')));
  assert.ok(replyHistories[4].some(message => message.content.includes('retail business')));
  const artifactScope = activeTopicHistory(conversation.history);
  assert.ok(artifactScope.some(message => message.content.includes('Chicago 路线')));
  assert.ok(artifactScope.every(message => !message.content.includes('retail business')));
});
