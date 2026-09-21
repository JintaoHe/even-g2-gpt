import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Conversation } from '../src/conversation.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';

test('homophone exit handling uses sentence meaning rather than a 推下 keyword', async () => {
  const outputs = [
    { decision: 'respond' }, // model misses the homophone ambiguity
    { decision: 'exit' },    // deliberately hostile false positive
    { decision: 'exit' },
    { decision: 'exit' },
    { decision: 'exit' },
    { decision: 'exit' },
    { decision: 'exit' },
    { decision: 'respond' }, // model misses a clear, direct exit
  ];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(outputs.shift()) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`, false);
    const signal = new AbortController().signal;
    assert.equal((await model.plan([], '推下吧。', false, signal)).decision, 'clarify_exit');
    assert.equal((await model.plan([], '继续把这个方案往下推吧，我们讨论第二阶段。', false, signal)).decision, 'respond');
    assert.equal((await model.plan([], '如果语音识别成“推下吧”，不代表我要退出。', false, signal)).decision, 'respond');
    assert.equal((await model.plan([], '把页面往下推一下，我要看下一点。', false, signal)).decision, 'respond');
    assert.equal((await model.plan([], '不要退下吧，我们还没聊完。', false, signal)).decision, 'respond');
    assert.equal((await model.plan([], '他说“退下吧”这三个字时，系统应该怎么判断？', false, signal)).decision, 'respond');
    assert.equal((await model.plan([{ role: 'assistant', content: '这个方案还有两个风险，要继续往下讨论吗？' }],
      '推下吧。', false, signal)).decision, 'respond');
    assert.equal((await model.plan([], '谢谢你，退下吧。', false, signal)).decision, 'exit');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a misheard lone exit asks before stopping capture, while a real exit still enters confirmation', async () => {
  const decisions = [{ decision: 'respond' }, { decision: 'exit' }];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(decisions.shift()) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`, false);
    const ambiguous = new Conversation(model, () => {});
    await ambiguous.submit('推下吧。', true);
    assert.equal(ambiguous.state, 'listening');
    assert.match(ambiguous.history.at(-1)!.content, /想结束.*还是继续/);

    const events: any[] = [], direct = new Conversation(model, event => events.push(event));
    await direct.submit('好了，谢谢。退下吧。', true);
    assert.equal(direct.state, 'exit_pending');
    assert.ok(events.some(event => event.type === 'exit.confirmation_required'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
