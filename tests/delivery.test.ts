import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversation, type DialogueModel } from '../src/conversation.js';
import { DeliveryDialogue } from '../src/delivery-dialogue.js';
import { createDraftGenerator, type Draft, type DraftGenerator } from '../src/delivery-draft.js';
import { presentation } from '../src/document-presentation.js';
import { JobStore } from '../src/job-store.js';
import type { DeliveryAction } from '../src/delivery-intent.js';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';

const draft: Draft = { document: { markdown: '# 部署步骤\n\n1. 检查配置\n2. 运行测试\n', presentation: presentation('部署步骤', '两步部署清单，不是聊天记录。', 'summary') } };
async function fixture(run: (f: { conversation: Conversation; store: JobStore; model: DeliveryDialogue; route: (a: DeliveryAction) => void; sent: Draft[]; advance: () => void }) => Promise<void>, generator: DraftGenerator = async () => structuredClone(draft)) {
  const root = await mkdtemp(join(tmpdir(), 'even-delivery-')), store = await JobStore.create(root);
  let action: DeliveryAction = 'document', now = Date.now(); const sent: Draft[] = [];
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', deliveryAction: action }), decide: async () => 'respond', reply: async (_h, _s, delta) => delta('普通回答') };
  const model = new DeliveryDialogue(base, store, generator, async (_id, bytes, metadata, calendar) => {
    sent.push({ document: { markdown: bytes.toString(), presentation: metadata! }, calendar }); return 'accepted';
  }, () => now);
  const conversation = new Conversation(model, () => {});
  try { await run({ conversation, store, model, route: value => { action = value; }, sent, advance: () => { now += 6 * 60000; } }); }
  finally { conversation.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
}
test('requested standalone document saves before preview and sends only on a later explicit confirmation', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    await conversation.submit('生成部署步骤并直接发给我', true);
    assert.equal(sent.length, 0); assert.equal(store.list()[0].state, 'completed');
    assert.match(conversation.history.at(-1)!.content, /文件已经生成/);
    assert.equal((await store.download(store.list()[0].id)).toString(), draft.document.markdown);
    route('confirm'); await conversation.submit('确认发送', true);
    assert.equal(sent.length, 1); assert.match(conversation.history.at(-1)!.content, /已成功提交发送/);
    assert.match(conversation.history.at(-1)!.content, /确认是否收到/);
    await conversation.submit('确认发送', true); assert.equal(sent.length, 1);
  });
});
test('missing email offers one confirmed resend of original file, then download fallback', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    await conversation.submit('生成文档', true); route('confirm'); await conversation.submit('确认发送', true);
    route('not_received'); await conversation.submit('我没收到，再发一次', true);
    assert.equal(sent.length, 1); assert.match(conversation.history.at(-1)!.content, /确认重发/);
    route('confirm'); await conversation.submit('确认重发', true);
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].mail_attempts, 2);
    await conversation.submit('确认重发', true); assert.equal(sent.length, 2);
    route('not_received'); await conversation.submit('还是没收到', true);
    assert.match(conversation.history.at(-1)!.content, /直接下载/); assert.equal(sent.length, 2);
  });
});
test('reported receipt is recorded and blocks resending; cancelled resend does not send', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    await conversation.submit('生成文档', true); route('confirm'); await conversation.submit('确认发送', true);
    route('not_received'); await conversation.submit('没收到', true);
    route('cancel'); await conversation.submit('先不要重发', true); assert.equal(sent.length, 1);
    route('received'); await conversation.submit('邮件收到了', true);
    assert.equal(store.list()[0].mail_received, true); assert.match(conversation.history.at(-1)!.content, /已记录/);
    route('not_received'); await conversation.submit('再发一次', true); route('confirm'); await conversation.submit('确认重发', true);
    assert.equal(sent.length, 1);
  });
});
test('negation, quoted approval, conditional approval and vague assent cannot send even if misclassified', async () => {
  await fixture(async ({ conversation, route, sent }) => {
    await conversation.submit('生成文档', true); route('confirm');
    for (const text of ['不要确认发送', '他说“确认发送”', '修改后确认发送', '好的', 'send it tomorrow', '确认发送，换成明天']) {
      await conversation.submit(text, true); assert.equal(sent.length, 0);
    }
    await conversation.submit('确认发送', true); assert.equal(sent.length, 1);
  });
});
test('revisions supersede old artifacts, require fresh confirmation, and deliver only the new version', async () => {
  let version = 0;
  await fixture(async ({ conversation, store, route, sent }) => {
    await conversation.submit('生成文档', true); const old = store.list()[0].id;
    route('revise'); await conversation.submit('把步骤二改掉，然后发吧', true);
    assert.equal(sent.length, 0); assert.ok(store.superseded(old));
    await assert.rejects(store.email(old, async () => { assert.fail('must not send old version'); }));
    route('confirm'); await conversation.submit('确认发送', true);
    assert.equal(sent.length, 1); assert.match(sent[0].document.markdown, /版本2/);
  }, async () => ({ document: { ...draft.document, markdown: `# 版本${++version}` } }));
});
test('expiry, unrelated turns, explicit cancellation and lifecycle invalidation require a new preview', async () => {
  await fixture(async ({ conversation, route, sent, advance, model }) => {
    await conversation.submit('生成文档', true); advance(); route('confirm');
    await conversation.submit('确认发送', true); assert.equal(sent.length, 0);
    route('none'); await conversation.submit('换个话题', true);
    route('confirm'); await conversation.submit('确认发送', true); assert.equal(sent.length, 0);
    route('cancel'); await conversation.submit('取消发送', true);
    route('confirm'); await conversation.submit('确认发送', true); assert.equal(sent.length, 0);
    model.invalidate(); await conversation.submit('确认发送', true); assert.equal(sent.length, 0);
    await conversation.submit('确认发送', true); assert.equal(sent.length, 1);
  });
});
test('calendar clarification creates no artifact; completed calendar is previewed before sending', async () => {
  let count = 0;
  const calendar = { title: '和 Luke 吃饭', start: '2026-09-25T18:00-05:00', end: '2026-09-25T19:00-05:00', timezone: 'America/Chicago', allDay: false, notes: '', location: '' };
  await fixture(async ({ conversation, route, store, sent }) => {
    route('calendar'); await conversation.submit('提醒我下周五和 Luke 吃饭', true);
    assert.equal(store.list().length, 0); assert.equal(sent.length, 0); assert.match(conversation.history.at(-1)!.content, /几点/);
    route('revise'); await conversation.submit('9月25日18到19点，Chicago', true);
    assert.match(conversation.history.at(-1)!.content, /2026-09-25T18:00-05:00/); assert.equal(sent.length, 0);
    route('confirm'); await conversation.submit('确认按纽约时间发送', true); assert.equal(sent.length, 0);
    await conversation.submit('好的，按这个时间发给我吧', true); assert.deepEqual(sent[0].calendar, calendar);
    route('not_received'); await conversation.submit('没收到', true); route('confirm');
    await conversation.submit('确认按纽约时间重发', true); assert.equal(sent.length, 1);
    await conversation.submit('嗯，再发给我一次', true); assert.equal(sent.length, 2);
  }, async () => ++count === 1 ? { clarification: '请确认具体日期和几点开始、结束？' } : { ...draft, calendar });
});
test('natural approval sends only current preview; negation, correction, questions and recipient changes never send', async () => {
  for (const phrase of ['可以，发给我吧', '好，就把这份发到我的邮箱', '行，麻烦发一下', 'yes please send that to me']) {
    await fixture(async ({ conversation, route, sent }) => {
      await conversation.submit('生成文档', true); route('confirm'); await conversation.submit(phrase, true);
      assert.equal(sent.length, 1); await conversation.submit(phrase, true); assert.equal(sent.length, 1);
    });
  }
  await fixture(async ({ conversation, route, sent }) => {
    await conversation.submit('生成文档', true); route('confirm');
    for (const phrase of ['可以，改一下再发给我', '不要发给我', '可以发给我吗', '发给Alice吧', '发到其他邮箱', 'send to Bob']) {
      await conversation.submit(phrase, true); assert.equal(sent.length, 0);
    }
  });
});
test('late cancelled generation cannot publish a sendable artifact or confirmation', async () => {
  let finish!: (value: Draft) => void;
  await fixture(async ({ conversation, store, sent }) => {
    const pending = conversation.submit('生成文档', true);
    await new Promise<void>(r => setImmediate(r)); conversation.interrupt(); finish(draft); await pending;
    assert.equal(store.list().length, 0); assert.equal(sent.length, 0);
    assert.ok(!conversation.history.some(m => m.content.includes('文件已经生成')));
  }, () => new Promise(resolve => { finish = resolve; }));
});
test('draft API has no tools or mail access, preserves standalone content and fails closed', async () => {
  let body: any, status = 'completed';
  let output: any = { clarification: '', title: '部署步骤', summary: '部署清单', markdown: '1. Test\n\n[来源](https://example.com)', calendar: null };
  const generate = createDraftGenerator({ OPENAI_API_KEY: 'fake', CONVERSATION_TIMEZONE: 'America/Chicago' }, async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ status, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
  });
  const result = await generate([{ role: 'user', content: '导出刚才的步骤' }], 'document', undefined, new AbortController().signal);
  assert.equal(body.tools, undefined); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.ok('document' in result); assert.match(result.document.markdown, /https:\/\/example.com/); assert.doesNotMatch(result.document.markdown, /完整对话/);
  status = 'incomplete'; await assert.rejects(generate([], 'document', undefined, new AbortController().signal));
  status = 'completed'; output = { ...output, calendar: { start: 'Friday' } };
  assert.ok('clarification' in await generate([], 'calendar', undefined, new AbortController().signal));
});

test('WebSocket conversation prepares a draft, requires a separate turn and sends through backend state', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-delivery-ws-')), jobs = await JobStore.create(root);
  let action: DeliveryAction = 'document', sends = 0;
  const token = 'synthetic-token-'.repeat(4);
  const app = createConversationServer({ token, jobs, draftGenerator: async () => draft,
    mail: async () => { sends++; return 'accepted'; },
    model: { plan: async () => ({ decision: 'respond', deliveryAction: action }), decide: async () => 'respond', reply: async () => {} },
    transcriber: () => { throw Error('Unused'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as { port: number }).port}/ws/conversation`);
  const wait = (type: string) => new Promise<any>(resolve => {
    const listener = (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()); if (event.type === type) { client.off('message', listener); resolve(event); } };
    client.on('message', listener);
  });
  try {
    await once(client, 'open'); let pending = wait('ready'); client.send(JSON.stringify({ type: 'hello', token })); await pending;
    pending = wait('answer.done'); client.send(JSON.stringify({ type: 'text.submit', text: '生成步骤并发给我' })); await pending;
    assert.equal(sends, 0); assert.equal(jobs.list()[0].state, 'completed');
    action = 'confirm'; pending = wait('answer.done'); client.send(JSON.stringify({ type: 'text.submit', text: '确认发送' })); await pending;
    assert.equal(sends, 1); assert.equal(jobs.list()[0].mail_state, 'accepted');
  } finally { client.terminate(); await app.close(); await jobs.close(); await rm(root, { recursive: true, force: true }); }
});
