import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { Conversation, type Message } from '../src/conversation.js';
import { CostLedger } from '../src/cost-ledger.js';
import { createMeteredOpenAIFetch } from '../src/metered-openai.js';
import { observeReplyFailure, RetryableReplyError, type ReplyDiagnostic } from '../src/reply-fallback.js';
import { ReplyOutputGuard, REPLY_REJECTED_TEXT } from '../src/reply-output-guard.js';

const h: Message[] = [{ role: 'user', content: '解释影子为什么会移动。' }];
const success = () => new Response('data: {"type":"response.output_text.delta","delta":"太阳方位在变化。"}\n\n'
  + 'data: {"type":"response.completed","response":{"output":[]}}\n\n');

test('ordinary Analysis prose is preserved at every split; internal channel grammar remains rejected', async () => {
  const normal = ['Analysis: The sky is blue because light scatters.', 'Analysis of the data shows a pattern.',
    'This analysis shows a trend.', 'We need to consider two factors.', '分析：天空呈蓝色。', 'analysis'];
  const leaks = ['[assistant^{analysis 码:\nWe need answer one sentence English. concise.',
    '<|channel|>analysis<|message|>We need to answer in one sentence.', 'assistantfinal hidden',
    'analysis\nWe need to answer.', 'ANALYSIS\r\nWe need to answer.', 'prefix ^{analysis secret'];
  for (const text of [...normal, ...leaks]) {
    for (let split = 0; split <= text.length; split++) {
      const guard = new ReplyOutputGuard();
      const body = guard.push(text.slice(0, split)) + guard.push(text.slice(split)) + guard.flush();
      assert.equal(guard.rejected, leaks.includes(text), text + ':' + split);
      if (normal.includes(text)) assert.equal(body, text);
      else { assert.equal(guard.reason, 'reasoning_leak'); assert.doesNotMatch(body, /assistant|analysis|channel|We need|secret/i); }
    }
    const events: any[] = [], saved: Message[][] = [];
    const c = new Conversation({ decide: async () => 'respond', reply: async (_h, _s, delta, update) => {
      for (const ch of text) delta(ch);
      update?.({ type: 'answer.citations', text, citations: [] });
    } }, e => events.push(e), async messages => { saved.push(structuredClone(messages)); });
    await c.submit('合成问题', true);
    assert.equal(c.history.at(-1)?.content, normal.includes(text) ? text : REPLY_REJECTED_TEXT);
    if (leaks.includes(text)) assert.doesNotMatch(JSON.stringify([events, saved]), /assistantfinal|\^\{|channel|We need|secret/);
  }
});

test('metered fetch network codes change only the diagnostic reason, with one fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-network-label-'));
  const ledger = await CostLedger.create(join(root, 'ledger.json'), {});
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', undefined]) {
    let calls = 0; const logs: ReplyDiagnostic[] = [];
    const fetcher = createMeteredOpenAIFetch(ledger, {}, async () => {
      if (++calls === 1) throw Object.assign(new TypeError('fetch failed PRIVATE_PAYLOAD'), { cause: { code } });
      return success();
    });
    const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: 'hybrid-luna', OPENAI_WEB_SEARCH: 'false' },
      { fetcher, onReplyDiagnostic: e => logs.push(e) });
    await model.reply(h, new AbortController().signal, () => {}, undefined, 'low', 'explain', []);
    assert.equal(calls, 2);
    assert.equal(logs.find(e => e.event === 'reply_fallback')?.reason, code ? 'network' : 'unknown_provider');
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_PAYLOAD|fetch failed|影子/);
  }
});

test('fallback, explicit retry and single-profile failures have one terminal diagnostic without extra calls', async () => {
  for (const attempt of ['fallback', 'retry', 'primary'] as const) {
    for (const profile of attempt === 'primary' ? ['configured', 'all-5.6'] : ['hybrid-luna']) {
      const root = await mkdtemp(join(tmpdir(), 'reply-terminal-label-'));
      const ledger = await CostLedger.create(join(root, 'ledger.json'), {});
      const logs: ReplyDiagnostic[] = []; let calls = 0;
      const fetcher = createMeteredOpenAIFetch(ledger, {}, async () => {
        calls++; throw Object.assign(new TypeError('fetch failed PRIVATE_PAYLOAD'), { cause: { code: 'ECONNRESET' } });
      });
      const { model } = createHybridDialogue('fake', { EVEN_MODEL_PROFILE: profile, OPENAI_WEB_SEARCH: 'false' },
        { fetcher, onReplyDiagnostic: e => logs.push(e) });
      if (attempt === 'fallback') {
        const events: any[] = [];
        const c = new Conversation({ ...model, decide: async () => 'respond',
          plan: async () => ({ decision: 'respond', cognitiveMode: 'explain', reasoningEffort: 'low' }),
          reply: model.reply.bind(model) }, e => events.push(e));
        await c.submit(h[0].content, true);
        assert.ok(events.some(e => e.type === 'error' && e.code === 'MODEL_FAILED'));
        assert.deepEqual(logs.filter(e => e.event !== 'reply_attempt').map(e => [e.event, e.model, e.reason, e.attempt]), [
          ['reply_fallback', 'gpt-6-luna', 'network', undefined], ['reply_failed', 'gpt-5.6-luna', 'network', 'fallback']]);
      } else {
        const signal = new AbortController().signal;
        if (attempt === 'retry') await model.plan(h, '重新回答', true, signal);
        await assert.rejects(model.reply(h, signal, () => {}, undefined, 'low', 'explain', []));
      }
      const failed = logs.filter(e => e.event === 'reply_failed');
      assert.equal(failed.length, 1); assert.equal(failed[0].attempt, attempt);
      assert.equal(failed[0].model, 'gpt-5.6-luna'); assert.equal(failed[0].reason, 'network');
      assert.ok(Number.isFinite(failed[0].elapsedMs)); assert.equal(calls, attempt === 'fallback' ? 2 : 1);
      assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_PAYLOAD|fetch failed|影子/);
    }
  }
});

test('diagnostics never replace the exception or introduce a request', async () => {
  for (const reason of ['network', 'http', 'timeout', 'empty', 'unknown_provider'] as const) {
    const original = new RetryableReplyError(reason); let calls = 0;
    const reply = observeReplyFailure(async () => { calls++; throw original; }, 'gpt-5.6-luna', 'fallback', () => { throw Error('logger'); });
    await assert.rejects(reply(h, new AbortController().signal, () => {}), e => e === original);
    assert.equal(calls, 1);
  }
});

test('real isolated server startup banners identify all profiles without credentials', { timeout: 30000 }, async () => {
  for (const profile of ['configured', 'hybrid-luna', 'all-5.6']) {
    const root = await mkdtemp(join(tmpdir(), 'reply-banner-'));
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
      '--import', 'data:text/javascript,globalThis.fetch%3Dasync()%3D%3E%7Bthrow%20Error(%22OFFLINE_ONLY%22)%7D',
      resolve('src/conversation-server.ts')], { cwd: root, windowsHide: true, env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        DOTENV_CONFIG_PATH: join(root, 'absent.env'), EVEN_DATA_DIR: root, CONVERSATION_PORT: '0',
        OPENAI_API_KEY: 'synthetic-private-key', G2_CLIENT_TOKEN: 'synthetic-private-token-01234567890123456789',
        EVEN_MODEL_PROFILE: profile, EVEN_HYBRID_FIRST_OUTPUT_MS: '2000', OPENAI_WEB_SEARCH: 'false',
        EVEN_HISTORY_RECALL_ENABLED: 'false', GOOGLE_CALENDAR_ENABLED: 'false', GOOGLE_MAPS_ENABLED: 'false', EVEN_EMAIL_ENABLED: 'false',
      } });
    const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    try {
      const banner = await new Promise<string>((resolveBanner, reject) => {
        let out = '';
        const timeout = setTimeout(() => reject(Error('Startup timed out')), 8000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', () => { clearTimeout(timeout); reject(Error('Startup closed before banner')); });
        child.stdout.on('data', data => { out += String(data); const line = out.split('\n').find(line => line.startsWith('Conversation lab:'));
          if (line) { clearTimeout(timeout); resolveBanner(line); } });
        child.stderr.resume();
      });
      assert.match(banner, new RegExp(`profile=${profile}`));
      if (profile === 'hybrid-luna') {
        for (const label of ['gpt-6-luna', 'gpt-5.6-luna', 'first_output_ms=2000', 'casual_scope=']) assert.ok(banner.includes(label));
      }
      assert.doesNotMatch(banner, /synthetic-private|token|key/i);
    } finally { child.kill(); await closed; }
  }
});
