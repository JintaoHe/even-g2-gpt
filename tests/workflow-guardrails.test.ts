import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIDialogue } from '../src/dialogue-model.js';

test('current-turn workflow guard rejects embedded artifact and calendar words while preserving direct requests', async () => {
  const outputs = [
    { decision: 'respond', delivery_action: 'document', calendar_action: 'none' },
    { decision: 'respond', delivery_action: 'none', calendar_action: 'create' },
    { decision: 'respond', delivery_action: 'none', calendar_action: 'create' },
    { decision: 'respond', delivery_action: 'document', calendar_action: 'none' },
    { decision: 'respond', delivery_action: 'none', calendar_action: 'create' },
    { decision: 'respond', delivery_action: 'none', calendar_action: 'query' },
  ];
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw));
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(outputs.shift()) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      false, 1, 'America/Chicago', undefined, { deliveryRouting: true, calendarRouting: true });
    const signal = new AbortController().signal;
    const workload = await model.plan([], '帮我比较两台服务器。我们偶尔生成长文档，但主要跑实时对话。', false, signal);
    const milestone = await model.plan([{ role: 'assistant', content: 'Cedar 计划在 10 月和 12 月交付。' }],
      '回到 Cedar：两个里程碑分别解决什么风险？', false, signal);
    const cron = await model.plan([{ role: 'assistant', content: '上次讨论了 9 月发布窗口。' }],
      'crontab 的五个字段分别代表什么？', false, signal);
    const email = await model.plan([], '把刚才的服务器比较整理成 Markdown 发到我的邮箱。', false, signal);
    const create = await model.plan([], '请把 10 月 7 日上午 9 点的架构评审加到日历。', false, signal);
    const free = await model.plan([], '我明天下午有空吗？', false, signal);

    assert.equal(workload.deliveryAction, 'none');
    assert.equal(milestone.calendarAction, 'none');
    assert.equal(cron.calendarAction, 'none');
    assert.equal(email.deliveryAction, 'document');
    assert.equal(create.calendarAction, 'create');
    assert.equal(free.calendarAction, 'query');
    assert.match(bodies[0].instructions, /CURRENT utterance/);
    assert.match(bodies[0].instructions, /Cedar/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
