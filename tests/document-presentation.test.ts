import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentRenderer, fallbackPresentation, mailPresentation, presentation, renderDocument } from '../src/document-presentation.js';
import { JobStore } from '../src/job-store.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const history = [{ role: 'user' as const, content: '周末可以去哪些社区活动？' },
  { role: 'assistant' as const, content: '可以考虑社区节庆。时间需要再核实。来源：[活动介绍](https://example.com/events)' }];
test('friendly subject, summary and title filename; HTML and header/path injection are inert', () => {
  const metadata = presentation('周末社区活动安排', '讨论了社区节庆和短途出游。活动日期仍需核实。', 'summary');
  const mail = mailPresentation(metadata);
  assert.equal(mail.subject, 'Even 笔记｜周末社区活动安排'); assert.equal(mail.filename, '周末社区活动安排.md');
  assert.match(mail.text, /活动日期仍需核实/); assert.doesNotMatch(mail.text, /[a-f0-9]{8}-/);
  assert.match(mail.html, /Even Assistant · 系统通知/); assert.doesNotMatch(mail.html, /<img|<script|<a\b/i);
  const unsafe = presentation('../CON\r\nBcc: other@example.com<script>x</script>', '<img src=x onerror=alert(1)> A & B', 'summary');
  assert.doesNotMatch(unsafe.filename, /[\\/:\r\n<>]/); assert.doesNotMatch(mailPresentation(unsafe).subject, /[\r\n]/);
  assert.match(mailPresentation(unsafe).html, /A &amp; B/);
  assert.equal(presentation('CON', 'text', 'excerpt').filename, '笔记-CON.md');
  assert.match(mailPresentation(fallbackPresentation(history)).text, /非 AI 总结/);
  assert.match(renderDocument(history).markdown, /https:\/\/example.com\/events/);
});
test('one bounded structured summary request, no tools, no storage; raw sources remain intact', async () => {
  let calls = 0;
  const request: typeof fetch = async (_url, options) => {
    calls++; const body = JSON.parse(options!.body as string);
    assert.equal(body.store, false); assert.equal(body.tools, undefined); assert.equal(body.text.format.strict, true);
    assert.equal(body.model, 'test-model'); assert.ok(body.max_output_tokens <= 1000);
    assert.match(body.input[0].content, /社区活动/);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ title: '周末活动选择', summary: '讨论了社区节庆。具体时间有待核实。' }) }] }] });
  };
  const renderer = createDocumentRenderer({ OPENAI_API_KEY: 'fake', EMAIL_SUMMARY_MODEL: 'test-model' }, request);
  const document = await renderer(history, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(document.presentation.kind, 'summary');
  assert.equal(document.presentation.filename, '周末活动选择.md'); assert.match(document.markdown, /https:\/\/example.com/);
});
test('disabled/CLI summaries use labelled excerpts; API refusal/errors fall back; cancellation propagates', async () => {
  for (const env of [{ EMAIL_AI_SUMMARY: 'false' }, { DIALOGUE_PROVIDER: 'codex-cli' }]) {
    const renderer = createDocumentRenderer({ OPENAI_API_KEY: 'fake', ...env }, async () => { assert.fail('No API expected'); });
    assert.equal((await renderer(history, new AbortController().signal)).presentation.kind, 'excerpt');
  }
  for (const response of [new Response('private provider error', { status: 500 }), Response.json({ status: 'incomplete' }),
    Response.json({ status: 'completed', output: [] })]) {
    const renderer = createDocumentRenderer({ OPENAI_API_KEY: 'fake' }, async () => response);
    assert.equal((await renderer(history, new AbortController().signal)).presentation.kind, 'excerpt');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createDocumentRenderer({})(history, controller.signal));
});
test('title metadata survives restart, is passed to mail, and does not replace private UUID storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-presentation-'));
  let store = await JobStore.create(root, async history => renderDocument(history, presentation('社区活动', '讨论了周末的选择。', 'summary')));
  try {
    const job = store.enqueue(history);
    for (let i = 0; i < 100 && store.get(job.id)?.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 10));
    await store.close(); store = await JobStore.create(root);
    assert.equal(store.metadata(job.id)?.filename, '社区活动.md');
    assert.equal(store.list()[0].title, '社区活动');
    assert.match((await store.download(job.id)).toString(), /https:\/\/example.com/);
    await store.email(job.id, async (_id, _bytes, metadata) => { assert.equal(metadata?.title, '社区活动'); return 'accepted'; });
  } finally { await store.close(); }
});
