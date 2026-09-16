import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { OpenAIDialogue, citedAnswer } from '../src/dialogue-model.js';
import { Conversation, type Event, type ReplyUpdate } from '../src/conversation.js';

test('citation parser retains inline offsets and rejects unsafe URLs/ranges', () => {
  const a = (url: string, start = 2, end = 4) => ({ type: 'url_citation', url, title: '<b>Title</b>', start_index: start, end_index: end });
  const result = citedAnswer([{ type: 'message', content: [{ type: 'output_text', text: '中文[1]', annotations: [
    a('https://example.com'), a('javascript:alert(1)'), a('https://user:pass@example.com'), a('https://bad.example', -1), a('https://bad.example', 0, 100)
  ] }, { type: 'output_text', text: 'more', annotations: [a('https://second.example', 0, 4)] }] }]);
  assert.equal(result.citations.length, 2); assert.equal(result.citations[1].start, 6);
});

test('web search is only offered to replies, capped; disabled mode has no tools', async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); calls++;
    if (calls === 1) {
      assert.equal(data.tools, undefined);
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"decision":"respond"}' }] }] })); return;
    }
    if (calls === 2) { assert.deepEqual(data.tools, [{ type: 'web_search', search_context_size: 'low' }]); assert.equal(data.max_tool_calls, 2); assert.equal(data.tool_choice, 'auto'); }
    else assert.equal(data.tools, undefined);
    assert.ok(data.instructions.includes('Current UTC time:')); assert.equal(data.service_tier, 'default');
    const events = [
      { type: 'response.web_search_call.searching' },
      { type: 'response.output_text.delta', delta: '结果[1]' },
      { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '结果[1]',
        annotations: [{ type: 'url_citation', url: 'https://example.com', title: '来源', start_index: 2, end_index: 5 }] }] }] } }
    ];
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const model = new OpenAIDialogue('fake', 'test', url), signal = new AbortController().signal;
    await model.decide([], 'query', false, signal);
    const updates: ReplyUpdate[] = []; await model.reply([], signal, () => {}, e => updates.push(e));
    assert.equal(updates[0].type, 'search.status');
    assert.equal(updates[1].type, 'answer.citations');
    await new OpenAIDialogue('fake', 'test', url, false).reply([], signal, () => {});
    assert.throws(() => new OpenAIDialogue('fake', 'test', url, true, 0));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('cancelled search cannot inject late citations or status into another turn', async () => {
  let late!: (e: ReplyUpdate) => void, finish!: () => void;
  const gate = new Promise<void>(r => { finish = r; }); const events: Event[] = [];
  const c = new Conversation({ decide: async () => 'respond', reply: async (_h, _s, delta, update) => {
    late = update!; delta('old'); await gate;
  } }, e => events.push(e));
  const task = c.submit('search'); await new Promise<void>(r => setImmediate(r)); c.interrupt();
  late({ type: 'search.status', status: 'searching' }); late({ type: 'answer.citations', text: 'late', citations: [] });
  finish(); await task;
  assert.ok(!events.some(e => e.type === 'answer.citations' || e.type === 'search.status'));
});

test('citation UI uses safe text nodes and clickable inline links', async () => {
  class Element {
    children: any[] = []; tag = ''; textContent = ''; href = ''; rel = '';
    append(...nodes: any[]) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
  }
  const context: any = { URL, document: {
    createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (text: string) => ({ text })
  } };
  const code = (await readFile(new URL('../web/citations.js', import.meta.url), 'utf8')).replace('export function', 'function');
  runInNewContext(code + '\nthis.render = renderCitations;', context);
  const body = new Element(); context.render(body, '<script>[1]end', [{ start: 8, end: 11, url: 'https://example.com', title: '<img>' }]);
  assert.equal(body.children[0].text, '<script>'); assert.equal(body.children[1].tag, 'a');
  assert.equal(body.children[1].href, 'https://example.com'); assert.equal(body.children[2].text, 'end');
});
