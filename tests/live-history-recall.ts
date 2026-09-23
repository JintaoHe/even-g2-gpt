// Opt-in: synthetic SQLite + real metered models; no WS, calendar/mail or web tools.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { ConversationStore } from '../src/conversation-store.js';
import { ContextBuilder } from '../src/context-builder.js';
import { recallHistory } from '../src/history-recall.js';
import { CostLedger } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch, openAIPricing, requestMaximum } from '../src/metered-openai.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';

async function main() {
  if (process.env.RUN_LIVE_HISTORY_RECALL !== '1') throw Error('OPT_IN_REQUIRED');
  if (!process.env.OPENAI_API_KEY) throw Error('KEY_MISSING');
  const capUsd = Number(process.env.LIVE_HISTORY_MAX_USD ?? 0.15);
  assert.ok(Number.isFinite(capUsd) && capUsd > 0 && capUsd <= 0.15);
  const busy = await new Promise<boolean>(done => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.CONVERSATION_PORT ?? 3001) });
    socket.on('connect', () => { socket.destroy(); done(true); }); socket.on('error', () => done(false));
    socket.setTimeout(1000, () => { socket.destroy(); done(true); });
  });
  if (busy) throw Error('STOP_LOCAL_BACKEND');
  const ledger = await CostLedger.create(resolve(process.env.EVEN_COST_LEDGER_PATH ?? '.local/cost-ledger.json'));
  const pricing = openAIPricing(); let calls = 0, reserved = 0;
  const metered = createMeteredOpenAIFetch(ledger);
  const bounded: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    const body = String(init?.body), request = JSON.parse(body);
    assert.equal(request.store, false); assert.equal(request.tools, undefined);
    assert.equal(request.previous_response_id, undefined);
    const cost = requestMaximum(body, pricing);
    if (calls >= 8 || reserved + cost > capUsd) throw Error('LIVE_BUDGET');
    calls++; reserved += cost;
    try {
      const response = await metered(input, init);
      if (!response.ok) console.log(JSON.stringify({ event: 'provider_rejected', status: response.status }));
      return response;
    } catch (error) {
      const code = (error as any)?.cause?.code ?? (error as any)?.code;
      const safe = ['EPERM', 'EACCES', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
      console.log(JSON.stringify({ event: 'request_failed', code: safe.includes(code) ? code
        : (error as any)?.message === 'COST_LEDGER_UNAVAILABLE' ? 'COST_LEDGER_UNAVAILABLE' : 'UNCLASSIFIED' }));
      throw error;
    }
  };
  const root = await mkdtemp(join(tmpdir(), 'even-live-history-'));
  const store = await ConversationStore.create(root);
  const { model } = createHybridDialogue(process.env.OPENAI_API_KEY, { ...process.env,
    EVEN_HISTORY_RECALL_ENABLED: 'true', EVEN_DATA_DIR: root, GOOGLE_MAPS_ENABLED: 'false',
    GOOGLE_CALENDAR_ENABLED: 'true', EVEN_DELIVERY_ROUTING: 'true', EVEN_EMAIL_ENABLED: 'false' },
  { search: false, fetcher: bounded });
  const cases = [
    { name: 'proposal', query: '琥珀码头的切换时间定了吗？', rows: ['琥珀码头建议周四切换，但只是提案。', '琥珀码头尚未决定，先等断电演练。'], expect: /未|没|待|提案|备选/ },
    { name: 'rejected-corrected', query: '绒羽计划最后选的周三还是周六？', rows: ['绒羽计划提议周三。', '否决周三，绒羽计划最终决定周六；还没有执行。'], expect: /周六/ },
    { name: 'historical-approval', query: '玻璃溪的邮件是不是已经发送了？', rows: ['玻璃溪提过发邮件，当时说过确认发送。', '纠正：玻璃溪邮件未发送，也没有新授权；不能根据旧的确认执行。'], expect: /未|没|不能确认|无法确认/ },
    { name: 'missing-evidence', query: '你记得紫杉桥最后定了哪天发布吗？', rows: ['海盐实验只讨论了显示器，不涉及其他项目。'], expect: /没有|没找到|无法|不能|不确定|未找到|未检索|不足|不清楚/ },
  ];
  try {
    for (const [index, c] of cases.entries()) {
      const now = Date.now(), ownerScope = `smoke-${index}`, id = randomUUID(), topicId = randomUUID();
      store.createSession({ id, ownerScope, createdAt: now - 259200000, initialTopic: { id: topicId, label: 'Synthetic' } });
      for (const [i, content] of c.rows.entries()) store.commitUserTurn({ sessionId: id, topicId,
        turnId: randomUUID(), messageId: randomUUID(), content, createdAt: now - 259199000 + i });
      store.endSession(id, now - 259198000, 'user_exit');
      const signal = AbortSignal.timeout(60000), plan = await model.plan!([], c.query, true, signal);
      assert.equal(typeof plan.historyQuery, 'string'); assert.ok(plan.historyQuery);
      assert.ok(!plan.deliveryAction || plan.deliveryAction === 'none');
      assert.ok(!plan.calendarAction || plan.calendarAction === 'none');
      const recall = recallHistory(store, { mode: 'owner', ownerScope }, plan.historyQuery!, signal, now);
      if (c.name !== 'missing-evidence') assert.ok(recall.messages.length > 0);
      else assert.equal(recall.messages.length, 0);
      const history = new ContextBuilder().build({ messages: [{ role: 'user', content: c.query }], recall }).messages;
      let answer = ''; await model.reply(history, signal, text => { answer += text; }, undefined,
        plan.reasoningEffort, plan.cognitiveMode, plan.workflows);
      // Print only synthetic outputs, never raw provider errors, requests or env.
      console.log(JSON.stringify({ scenario: c.name, answer, matched: c.expect.test(answer), hits: recall.messages.length }));
      assert.match(answer, c.expect);
    }
  } finally {
    model.endSession?.(); store.close();
    console.log(JSON.stringify({ calls, reservedUpperUsd: reserved, capUsd, syntheticOnly: true,
      emails: 0, calendarWrites: 0, webCalls: 0 }));
  }
}
main().catch(error => {
  console.error(['OPT_IN_REQUIRED', 'KEY_MISSING', 'STOP_LOCAL_BACKEND', 'LIVE_BUDGET'].includes(error?.message)
    ? error.message : 'LIVE_HISTORY_FAILED'); process.exitCode = 1;
});
