import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchQuota } from '../src/search-quota.js';
import { OpenAIDialogue } from '../src/dialogue-model.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

const ledger = async () => join(await mkdtemp(join(tmpdir(), 'even-quota-')), 'usage.json');
test('quota persists, serializes reservations and releases unused calls exactly once', async () => {
  const path = await ledger(), now = () => new Date('2026-09-15T12:00:00Z');
  const q = new SearchQuota(path, 'America/Chicago', 3, 6, now);
  const tickets = await Promise.all([q.reserve(2), q.reserve(2), q.reserve(2)]);
  assert.deepEqual(tickets.map(t => t?.limit ?? 0), [2, 1, 0]);
  await tickets[0]!.settle(0); await tickets[0]!.settle(0);
  const restarted = new SearchQuota(path, 'America/Chicago', 3, 6, now);
  assert.equal((await restarted.reserve(3))?.limit, 2);
  assert.equal(await restarted.reserve(1), null);
});
test('Chicago day rollover and calendar-month cap remain independent', async () => {
  let now = new Date('2026-09-30T23:00:00Z');
  const q = new SearchQuota(await ledger(), 'America/Chicago', 2, 2, () => now);
  await q.reserve(2);
  now = new Date('2026-10-01T04:59:00Z'); assert.equal(await q.reserve(1), null);
  now = new Date('2026-10-01T05:00:00Z'); assert.equal((await q.reserve(2))?.limit, 2);
  now = new Date('2026-10-02T12:00:00Z'); assert.equal(await q.reserve(1), null);
});
test('settlement across midnight refunds the original day; corrupt ledger fails closed', async () => {
  const path = await ledger(); let now = new Date('2026-09-15T12:00:00Z');
  const q = new SearchQuota(path, 'America/Chicago', 2, 3, () => now);
  const t = await q.reserve(2); now = new Date('2026-09-16T12:00:00Z');
  await t!.settle(1); assert.equal((await q.reserve(2))?.limit, 2);
  await writeFile(path, '{broken'); await assert.rejects(q.reserve(1));
});
test('reply releases zero-call reservation, counts tools and omits tools when exhausted', async () => {
  const q = new SearchQuota(await ledger(), 'America/Chicago', 1, 1);
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    if (calls < 3) assert.equal(body.max_tool_calls, 1);
    else assert.equal(body.tools, undefined);
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: calls === 2 ? [{ type: 'web_search_call' }] : [] } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`, true, 2, 'America/Chicago', q);
    for (let i = 0; i < 3; i++) await model.reply([], new AbortController().signal, () => {});
    assert.equal(await q.reserve(1), null);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('per-session search cap is conservative, refunds completed unused calls and resets explicitly', async () => {
  const limits: (number | undefined)[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); limits.push(body.max_tool_calls);
    const output = body.tools ? [{ type: 'web_search_call' }] : [];
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      true, 2, 'America/Chicago', undefined, { sessionSearchCalls: 3 });
    model.startSession();
    for (let i = 0; i < 3; i++) await model.reply([], new AbortController().signal, () => {});
    model.startSession(); await model.reply([], new AbortController().signal, () => {});
    assert.deepEqual(limits, [2, 2, 1, 2]);
    assert.throws(() => new OpenAIDialogue('fake', 'test', undefined, true, 11));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
