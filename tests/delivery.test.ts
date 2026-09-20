import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversation, type DialogueModel } from '../src/conversation.js';
import { DeliveryDialogue } from '../src/delivery-dialogue.js';
import { createDraftGenerator, protectedDocumentEntities, type Draft, type DraftGenerator } from '../src/delivery-draft.js';
import { presentation } from '../src/document-presentation.js';
import { JobStore } from '../src/job-store.js';
import type { DeliveryAction } from '../src/delivery-intent.js';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';
import { paginate } from '../clients/even/src/pager.js';
import type { DeliveryRecoveryState } from '../src/recovery-drafts.js';
import { CHINESE_LONG_FORM_OFFER, acceptsLongFormDocumentOffer } from '../src/long-form-offer.js';

const draft: Draft = { document: { markdown: '# 部署步骤\n\n1. 检查配置\n2. 运行测试\n', presentation: presentation('部署步骤', '两步部署清单，不是聊天记录。', 'summary') } };
async function fixture(run: (f: { conversation: Conversation; store: JobStore; model: DeliveryDialogue; route: (a: DeliveryAction) => void; sent: Draft[]; advance: () => void }) => Promise<void>, generator: DraftGenerator = async () => structuredClone(draft), artifactSource?: () => import('../src/conversation.js').Message[], baseReply = '普通回答') {
  const root = await mkdtemp(join(tmpdir(), 'even-delivery-')), store = await JobStore.create(root);
  let action: DeliveryAction = 'document', now = Date.now(); const sent: Draft[] = [];
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', deliveryAction: action }), decide: async () => 'respond', reply: async (_h, _s, delta) => delta(baseReply) };
  const model = new DeliveryDialogue(base, store, generator, async (_id, bytes, metadata, calendar) => {
    sent.push({ document: { markdown: bytes.toString(), presentation: metadata! }, calendar }); return 'accepted';
  }, () => now, undefined, artifactSource);
  const conversation = new Conversation(model, () => {});
  try { await run({ conversation, store, model, route: value => { action = value; }, sent, advance: () => { now += 6 * 60000; } }); }
  finally { conversation.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
}
test('document generation freezes a selected topic from a session longer than 100 messages', async () => {
  const longHistory = [
    ...Array.from({ length: 130 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `business-${index}`, topicId: 'business', topicLabel: 'Business' })),
    ...Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `trip-${index}`, topicId: 'trip', topicLabel: 'Trip' })),
  ];
  let selected: import('../src/conversation.js').Message[] = [];
  await fixture(async ({ conversation, store }) => {
    await conversation.submit('把这份 trip plan 生成 MD', true);
    assert.equal(store.list()[0].state, 'completed');
    assert.equal(selected.length, 40);
    assert.ok(selected.every(message => message.topicId === 'trip'));
  }, async history => { selected = structuredClone(history); return structuredClone(draft); }, () => longHistory);
});
test('requested standalone document saves before preview and sends only on a later explicit confirmation', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    await conversation.submit('生成部署步骤并直接发给我', true);
    assert.equal(sent.length, 0); assert.equal(store.list()[0].state, 'completed');
    assert.match(conversation.history.at(-1)!.content, /文件已生成/);
    assert.equal((await store.download(store.list()[0].id)).toString(), draft.document.markdown);
    route('confirm'); await conversation.submit('确认发送', true);
    assert.equal(sent.length, 1); assert.match(conversation.history.at(-1)!.content, /邮件服务器已接受/);
    assert.match(conversation.history.at(-1)!.content, /确认是否收到/);
    await conversation.submit('确认发送', true); assert.equal(sent.length, 1);
  });
});
test('cold-started delivery draft rebuilds from JobStore and requires a fresh confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-delivery-recovery-')), store = await JobStore.create(root);
  let saved: DeliveryRecoveryState | undefined, sends = 0;
  const persistence = { save(value: DeliveryRecoveryState) { saved = structuredClone(value); }, clear() { saved = undefined; } };
  const base: DialogueModel = { plan: async () => ({ decision: 'respond', deliveryAction: 'confirm' }),
    decide: async () => 'respond', reply: async () => {} };
  const sender = async () => { sends++; return 'accepted' as const; };
  const first = new DeliveryDialogue(base, store, async () => structuredClone(draft), sender, Date.now, undefined, undefined, persistence);
  const firstConversation = new Conversation(first, () => {});
  try {
    // Force generation for the first turn, then simulate loss of all in-memory approval state.
    const generatingBase: DialogueModel = { plan: async () => ({ decision: 'respond', deliveryAction: 'document' }),
      decide: async () => 'respond', reply: async () => {} };
    const generating = new DeliveryDialogue(generatingBase, store, async () => structuredClone(draft), sender, Date.now,
      undefined, undefined, persistence);
    const generatingConversation = new Conversation(generating, () => {});
    await generatingConversation.submit('生成一份部署文档', true);
    generating.invalidate(); generatingConversation.close();
    assert.ok(saved); assert.equal(sends, 0);

    await first.restoreRecovery(saved);
    await firstConversation.submit('确认发送', true);
    assert.equal(sends, 0); assert.match(firstConversation.history.at(-1)!.content, /文件已生成/);
    await firstConversation.submit('确认发送', true);
    assert.equal(sends, 1); assert.match(firstConversation.history.at(-1)!.content, /邮件服务器已接受/);

    first.invalidate();
    const restarted = new DeliveryDialogue(base, store, async () => structuredClone(draft), sender, Date.now,
      undefined, undefined, persistence);
    await restarted.restoreRecovery(saved);
    const restartedConversation = new Conversation(restarted, () => {});
    await restartedConversation.submit('确认发送', true);
    assert.equal(sends, 1); assert.match(restartedConversation.history.at(-1)!.content, /邮件服务器已接受/);
    restartedConversation.close();
  } finally { firstConversation.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
test('explicit document and send wording recovers from model routing misses without bypassing preview', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    route('none');
    await conversation.submit('把刚才的计划整理成 Markdown 文件发给我', true);
    assert.equal(store.list().length, 1); assert.equal(sent.length, 0);
    assert.match(conversation.history.at(-1)!.content, /文件已生成/);
    await conversation.submit('好，就把这份发到我的邮箱', true);
    assert.equal(sent.length, 1); assert.match(conversation.history.at(-1)!.content, /邮件服务器已接受/);
  });
});
test('natural plan-to-email wording creates a real artifact before contextual approval', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    route('confirm'); // reproduce an intent-model false confirmation with no draft
    conversation.history.push({ role: 'assistant', content: '旅行计划：周六去公园，周日回家。' });
    await conversation.submit('把刚才这份旅行计划发到我的邮箱', true);
    assert.equal(store.list().length, 1); assert.equal(sent.length, 0);
    assert.match(conversation.history.at(-1)!.content, /文件已生成[\s\S]*发送到固定邮箱/);
    route('none');
    await conversation.submit('好，可以。', true);
    assert.equal(sent.length, 1); assert.match(conversation.history.at(-1)!.content, /邮件服务器已接受/);
  });
});
test('contextual email assent cannot send or create an artifact without a formal preview', async () => {
  await fixture(async ({ conversation, store, route, sent }) => {
    route('confirm');
    for (const phrase of ['好，可以。', '可以', '没问题']) {
      await conversation.submit(phrase, true);
    }
    assert.equal(store.list().length, 0);
    assert.equal(sent.length, 0);
  });
});

test('a bound long-form offer accepts natural assent, generates a document preview, and never sends email', async () => {
  const offer = `向量数据库按语义相似度检索，并不替代 SQL 的精确事务查询。\n${CHINESE_LONG_FORM_OFFER}`;
  for (const phrase of ['要', '好的', '嗯，想看', '要完整长文', '好，发给我']) {
    await fixture(async ({ conversation, store, route, sent }) => {
      route('none'); await conversation.submit('详细解释向量数据库', true);
      assert.equal(conversation.history.at(-1)?.content, offer);
      await conversation.submit(phrase, true);
      assert.equal(store.list().length, 1, phrase); assert.equal(sent.length, 0, phrase);
      assert.match(conversation.history.at(-1)!.content, /文件已生成[\s\S]*确认发送/);
    }, async () => structuredClone(draft), undefined, offer);
  }
});

test('long-form assent is one-turn, exact-message-bound and rejects negation or questions', async () => {
  const offer = `先给你结论。\n${CHINESE_LONG_FORM_OFFER}`;
  assert.equal(acceptsLongFormDocumentOffer('不要，先聊别的'), false);
  assert.equal(acceptsLongFormDocumentOffer('可以吗？'), false);
  await fixture(async ({ conversation, store, route }) => {
    route('none'); await conversation.submit('详细说明', true);
    conversation.history.push({ role: 'assistant', content: '这是一条不同的助手消息。' });
    await conversation.submit('要', true);
    assert.equal(store.list().length, 0);
  }, async () => structuredClone(draft), undefined, offer);
});
test('a verbose document preview is bounded for the glasses without changing the saved file', async () => {
  const verbose: Draft = { document: { markdown: '# 完整正文\n\n' + '保留内容'.repeat(100), presentation: presentation(
    '一份很长但标题仍然与谈话内容相关的市场分析报告', '这是一段只用于发送确认界面的详细摘要。'.repeat(20), 'summary') } };
  await fixture(async ({ conversation, store }) => {
    await conversation.submit('生成报告', true);
    const preview = conversation.history.at(-1)!.content;
    assert.ok(paginate(preview).length <= 2);
    assert.match(preview, /摘要：/); assert.match(preview, /…/);
    assert.equal((await store.download(store.list()[0].id)).toString(), verbose.document.markdown);
  }, async () => structuredClone(verbose));
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
    assert.ok(!conversation.history.some(m => m.content.includes('文件已生成')));
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
  assert.match(body.instructions, /project codenames, ticket IDs, person names and event titles verbatim/);
  status = 'incomplete'; await assert.rejects(generate([], 'document', undefined, new AbortController().signal));
  status = 'completed'; output = { ...output, calendar: { start: 'Friday' } };
  assert.ok('clarification' in await generate([], 'calendar', undefined, new AbortController().signal));
});

test('document entity hints preserve unusual event titles, project codenames, tickets and quoted names', () => {
  const entities = protectedDocumentEntities([
    { role: 'assistant', content: '1. repro check\n   时间：2026-10-02 19:00–19:30\n2. 普通事项' },
    { role: 'user', content: '项目代号 Project Zephyr，ticket 是 DATA-417，请保留“Avery Vale”这个名字。' },
  ]);
  for (const entity of ['repro check', 'DATA-417', 'Avery Vale', 'Project Zephyr']) assert.ok(entities.includes(entity), entity);
  assert.equal(entities.includes('Ripple Check'), false);
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
