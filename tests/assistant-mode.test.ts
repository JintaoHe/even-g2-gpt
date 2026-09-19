import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Conversation, normalizeTurnPlan } from '../src/conversation.js';
import { OpenAIDialogue, reasoningForMode, safeAssistantMode } from '../src/dialogue-model.js';

test('cognitive mode, workflow, task kind and reasoning remain orthogonal', () => {
  const route = normalizeTurnPlan({ decision: 'respond', cognitiveMode: 'decision_support', reasoningEffort: 'medium',
    locationAction: 'nearby_search', searchAction: 'none' });
  assert.equal(route.cognitiveMode, 'decision_support');
  assert.deepEqual(route.workflows, [{ kind: 'navigation', action: 'nearby_search' }]);

  const currentComparison = normalizeTurnPlan({ decision: 'respond', cognitiveMode: 'decision_support', searchAction: 'search' });
  assert.deepEqual(currentComparison.workflows, [{ kind: 'search', action: 'read' }]);

  const outdoor = normalizeTurnPlan({ decision: 'respond', cognitiveMode: 'planning', taskAction: 'conditional_task',
    taskKind: 'outdoor_activity' });
  assert.deepEqual(outdoor.workflows, [{ kind: 'conditional_task', action: 'conditional_task', taskKind: 'outdoor_activity' }]);
  assert.equal(reasoningForMode('decision_support', 'low'), 'medium');
  for (const mode of ['casual', 'explain', 'research', 'brainstorm', 'decision_support', 'planning', 'deep_reasoning', 'compose', 'coaching'] as const)
    assert.equal(safeAssistantMode(mode), mode);
  assert.equal(safeAssistantMode('navigation'), 'casual');
});

test('scene router changes reasoning and web-tool exposure independently of write tools', async () => {
  const bodies: any[] = [];
  const classifications = [
    { decision: 'respond', reasoning_effort: 'low', cognitive_mode: 'research', search_action: 'search',
      topic_action: 'continue', topic_target: null, topic_label: 'current events' },
    { decision: 'respond', reasoning_effort: 'high', cognitive_mode: 'casual', search_action: 'none',
      topic_action: 'switch', topic_target: null, topic_label: 'chat' }
  ];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (!body.stream) {
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(classifications.shift()) }
      ] }] }));
      return;
    }
    res.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'gpt-5.6-luna', `http://127.0.0.1:${(server.address() as any).port}`,
      true, 3, 'America/Chicago', undefined, { adaptiveReasoning: true, intentTokens: 1024, sessionSearchCalls: 10, webRouting: true });
    const events: any[] = [], conversation = new Conversation(model, event => events.push(event));
    await conversation.submit('查一下这周末的活动');
    await conversation.submit('先不查了，随便聊聊');

    assert.deepEqual(bodies[1].reasoning, { effort: 'low' });
    assert.deepEqual(bodies[1].tools, [{ type: 'web_search', search_context_size: 'low' }]);
    assert.match(bodies[1].instructions, /Research mode/);
    assert.deepEqual(bodies[3].reasoning, { effort: 'low' });
    assert.equal(bodies[3].tools, undefined);
    assert.match(bodies[3].instructions, /Casual mode/);
    assert.deepEqual(events.filter(event => event.type === 'answer.start').map(event => event.cognitiveMode),
      ['research', 'casual']);
    assert.deepEqual(events.filter(event => event.type === 'answer.start').map(event => event.workflows),
      [[{ kind: 'search', action: 'read' }], []]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('park-detail follow-ups cannot inherit the conditional workflow from an earlier recommendation', async () => {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), input = String(body.input?.at(-1)?.content ?? '');
    const cognitiveMode = input.includes('为什么') ? 'explain' : input.includes('换到晚上') ? 'planning' : 'research';
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify({ decision: 'respond', reasoning_effort: 'medium', cognitive_mode: cognitiveMode,
        topic_action: 'continue', topic_target: null, topic_label: 'park plan', task_action: 'conditional_task', task_kind: 'outdoor_activity' }) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'gpt-5.6-luna', `http://127.0.0.1:${(server.address() as any).port}`,
      false, 3, 'America/Chicago', undefined, { adaptiveReasoning: true, intentTokens: 1024, taskRouting: true });
    const history = [
      { role: 'user' as const, content: '明天下午带孩子去公园。' },
      { role: 'assistant' as const, content: '建议 Triangle Park，天气适合，没有创建日程。' }
    ];
    for (const [input, mode] of [['为什么推荐这个公园？', 'explain'], ['这个公园有什么好玩的？', 'research'],
      ['还有其他什么公园吗？', 'research']] as const) {
      const plan = await model.plan!(history, input, true, new AbortController().signal);
      assert.equal(plan.taskAction, 'none', input);
      assert.equal(plan.cognitiveMode, mode, input);
    }
    const replan = await model.plan!(history, '换到晚上八点，重新检查天气并帮我安排。', true, new AbortController().signal);
    assert.equal(replan.taskAction, 'conditional_task');
    assert.equal(replan.taskKind, 'outdoor_activity');
    assert.equal(replan.cognitiveMode, 'planning');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
