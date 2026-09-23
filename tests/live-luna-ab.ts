// Opt-in paired evaluation. Synthetic conversations, public places, private Calendar
// connectivity only (never send its contents to a model). No production DB or writes.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CostLedger } from '../src/cost-ledger.js';
import { openAIPricing, requestMaximum } from '../src/metered-openai.js';
import { createHybridDialogue } from '../src/hybrid-dialogue.js';
import { GoogleRoutesProvider } from '../src/routes.js';
import { loadCalendarTransport, CalendarError } from '../src/google-calendar.js';
import { createDraftGenerator } from '../src/delivery-draft.js';
import { OpenAISessionSummaryGenerator, validateContextSummary } from '../src/session-summary.js';
import type { Message, ReasoningEffort, AssistantMode } from '../src/conversation.js';

const models = ['gpt-5.6-luna', 'gpt-6-luna'] as const;
const endpoint = 'https://api.openai.com/v1/responses';
const textOf = (data: any): string => (data.output ?? []).flatMap((o: any) => o.content ?? [])
  .filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
const fixedTime = 'Current UTC time: 2026-09-23T12:00:00.000Z. User local time: 9/23/2026, 7:00:00 AM (America/Chicago).';
const errCode = (error: any) => error?.message === 'COST_BUDGET_EXHAUSTED' ? 'BUDGET_STOP'
  : error instanceof CalendarError && /^CALENDAR_[A-Za-z0-9_]+$/.test(error.code) ? error.code
  : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT'
  : error instanceof assert.AssertionError ? 'ASSERTION_FAILED'
  : /^Provider HTTP \d{3}$/.test(error?.message ?? '') ? error.message : 'EVALUATION_FAILED';
const signal = () => AbortSignal.timeout(180000);

async function main() {
  assert.equal(process.env.RUN_LIVE_LUNA_AB, '1', 'OPT_IN_REQUIRED');
  const key = process.env.OPENAI_API_KEY; assert.ok(key, 'KEY_MISSING');
  const busy = await new Promise<boolean>(done => {
    const s = createConnection({ host: '127.0.0.1', port: Number(process.env.CONVERSATION_PORT ?? 3001) });
    s.once('connect', () => { s.destroy(); done(true); }); s.once('error', () => done(false));
    s.setTimeout(1000, () => { s.destroy(); done(true); });
  });
  assert.equal(busy, false, 'STOP_LOCAL_BACKEND_BEFORE_SHARED_LEDGER');
  const dir = resolve('.local/evals'); await mkdir(dir, { recursive: true });
  const lockPath = join(dir, 'luna-ab.lock'); const lock = await open(lockPath, 'wx', 0o600);
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const output = join(dir, `luna-ab-${id}.jsonl`);
  const emit = async (value: any) => { await appendFile(output, JSON.stringify(value) + '\n', { mode: 0o600 }); };
  // Fixed accounting period makes the $3 authorization cumulative across restarts
  // and month changes. Never settle/refund this conservative authorization ledger.
  const budget = await CostLedger.create(join(dir, 'luna-ab-authorization.json'), {
    COST_OPENAI_MONTHLY_USD: '2.8', COST_GOOGLE_MONTHLY_USD: '0.19', COST_SONIOX_MONTHLY_USD: '0.01', COST_TOTAL_MONTHLY_USD: '3',
  }, undefined, { now: () => new Date('2026-09-22T12:00:00Z') });
  const monthly = await CostLedger.create(resolve(process.env.EVEN_COST_LEDGER_PATH ?? '.local/cost-ledger.json'));
  const root = await mkdtemp(join(tmpdir(), 'even-luna-ab-'));
  let phase = 'preflight', scenario = '', repetition = 0, requests = 0, fatal = false;
  const rows: any[] = []; const pending: Promise<void>[] = [];
  const record = async (row: any) => { rows.push(row); await emit(row); };
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), endpoint);
    const body = JSON.parse(String(init?.body)); assert.ok(models.includes(body.model));
    assert.equal(body.store, false); assert.equal(body.previous_response_id, undefined);
    assert.ok(Number.isInteger(body.max_output_tokens) && body.max_output_tokens <= 16384);
    assert.ok((body.tools ?? []).every((t: any) => t.type === 'function' || t.type === 'web_search'));
    // Freeze the generated wall-clock sentence, not global Date or ledger clocks.
    if (typeof body.instructions === 'string') body.instructions = body.instructions.replace(/Current UTC time: [^\n]+/g, fixedTime);
    if (process.env.LUNA_AB_PROFILE === 'latency-longtext' && typeof body.instructions === 'string') {
      body.instructions = body.instructions.replace(/current UTC \d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'current UTC 2026-09-23T12:00:00.000Z');
    }
    body.service_tier = 'default';
    const raw = JSON.stringify(body), pricing = openAIPricing({}, body.model);
    assert.ok(Buffer.byteLength(raw) <= 180000);
    const web = (body.tools ?? []).some((t: any) => t.type === 'web_search');
    let upper = requestMaximum(raw, { ...pricing, inputPerMillion: Math.max(pricing.inputPerMillion, pricing.cacheWritePerMillion) });
    // Search can add provider-managed input not visible in our request. Reserve
    // an entire long context at the highest input/cache-write rate, not just bytes.
    if (web) upper += 1_050_000 * Math.max(pricing.inputPerMillion, pricing.cacheWritePerMillion) * 2 / 1e6;
    assert.ok(++requests <= 400);
    await budget.reserve('openai', upper);
    const ticket = await monthly.reserve('openai', upper);
    const started = performance.now();
    const instructions = String(body.instructions ?? '');
    const draftStage = body.text?.format?.name === 'delivery_draft_plan' ? 'plan'
      : instructions.includes('Append ONLY new substantive') ? 'extend'
      : instructions.includes('Rewrite ONLY the supplied') ? 'rewrite'
      : instructions.includes('Continue ONLY the current') ? 'continuation'
      : instructions.includes('Write only the complete Markdown BODY') ? 'section' : undefined;
    const context = { phase, scenario, repetition, model: body.model, effort: body.reasoning?.effort, draftStage,
      maxOutput: body.max_output_tokens, inputBytes: Buffer.byteLength(raw), reservedUsd: upper };
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: 'error', body: raw }); }
    catch (error) { await record({ type: 'request', ...context, ok: false, error: errCode(error), ms: performance.now() - started }); throw error; }
    const headersMs = performance.now() - started;
    const observe = (async () => {
      let data: any;
      if (body.stream) {
        const rawResponse = await response.clone().text();
        for (const line of rawResponse.split(/\r?\n/)) if (line.startsWith('data:')) {
          try { const e = JSON.parse(line.slice(5)); if (e.type === 'response.completed') data = e.response; } catch { /* incomplete SSE is reported */ }
        }
      } else data = await response.clone().json().catch(() => undefined);
      const usage = data?.usage;
      let usd: number | undefined;
      if (usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)) {
        const cached = Math.min(usage.input_tokens, usage.input_tokens_details?.cached_tokens ?? 0);
        const written = Math.min(usage.input_tokens - cached, usage.input_tokens_details?.cache_write_tokens ?? 0);
        const multiplier = usage.input_tokens > 272000 ? 2 : 1;
        const searchCalls = (data.output ?? []).filter((o: any) => o.type === 'web_search_call').length;
        usd = ((usage.input_tokens - cached - written) * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion
          + written * pricing.cacheWritePerMillion) * multiplier / 1e6
          + usage.output_tokens * pricing.outputPerMillion * (multiplier === 2 ? 1.5 : 1) / 1e6 + searchCalls * 0.01;
        assert.ok(Number.isFinite(usd) && usd >= 0 && usd <= upper, 'RESERVATION_UNDERESTIMATED');
        await ticket.settle(usd);
      } else if (response.status >= 400 && response.status < 500) await ticket.settle(0);
      await record({ type: 'request', ...context, ok: response.ok, status: response.status,
        completion: data?.status, ms: performance.now() - started, headersMs, inputTokens: usage?.input_tokens,
        cachedTokens: usage?.input_tokens_details?.cached_tokens, outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens, estimatedUsageUsd: usd,
        resolvedModel: data?.model,
        errorCode: typeof data?.error?.code === 'string' ? data.error.code.replace(/[^a-zA-Z0-9_]/g, '').slice(0,60) : undefined });
      if ([401, 403, 404].includes(response.status)) fatal = true;
    })();
    pending.push(observe.catch(() => { fatal = true; }));
    if (!body.stream) await pending.at(-1);
    return response;
  };
  const rawCall = async (body: any) => {
    const response = await request(endpoint, { method: 'POST', signal: signal(), headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ store: false, ...body }) });
    if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
    return response.json() as Promise<any>;
  };
  const run = async (model: string, name: string, fn: () => Promise<any>) => {
    if (fatal) throw Error('PREFLIGHT_OR_ACCOUNTING_STOP');
    scenario = name; const started = performance.now();
    try { const result = await fn(); await record({ type: 'case', phase, scenario, repetition, model, ms: performance.now() - started, ...result }); }
    catch (error) {
      await record({ type: 'case', phase, scenario, repetition, model, ms: performance.now() - started, pass: false, error: errCode(error) });
      if (errCode(error) === 'BUDGET_STOP') throw error;
    }
    console.log(JSON.stringify({ phase, scenario, repetition, model, completed: true }));
  };
  const order = () => repetition % 2 ? [...models].reverse() : [...models];
  const envFor = (model: string): NodeJS.ProcessEnv => ({ OPENAI_API_KEY: key, OPENAI_DIALOGUE_MODEL: model,
    EVEN_DATA_DIR: root, EVEN_HISTORY_RECALL_ENABLED: 'true', EVEN_DELIVERY_ROUTING: 'true',
    GOOGLE_CALENDAR_ENABLED: 'true', GOOGLE_MAPS_ENABLED: 'true', EVEN_EMAIL_ENABLED: 'true', DIALOGUE_PROVIDER: 'api' });
  try {
    // Verify model access before any third-party spend.
    for (const model of models) await run(model, 'responses-access', async () => {
      const r = await rawCall({ model, reasoning: { effort: 'low' }, max_output_tokens: 128,
        input: 'Reply with only READY.' }); return { pass: textOf(r).trim() === 'READY' };
    });
    if (fatal) throw Error('MODEL_ACCESS_UNAVAILABLE');

    if (process.env.LUNA_AB_PROFILE === 'latency-longtext') {
      const { runFocusedLuna } = await import('./luna-focus-cases.js');
      await runFocusedLuna({ models, run, request, envFor, key, dir, id,
        setPhase: (name, repeat) => { phase = name; repetition = repeat; } });
      return;
    }

    phase = 'external-api';
    let places: any = { unavailable: true };
    if (process.env.GOOGLE_MAPS_API_KEY) {
      await run('google', 'public-places-and-routes', async () => {
        const routesFetch: typeof fetch = async (url, init) => {
          const host = new URL(String(url)).hostname; const body = JSON.parse(String(init?.body));
          assert.ok(['places.googleapis.com', 'routes.googleapis.com'].includes(host)); assert.equal(init?.method, 'POST');
          const ceiling = host === 'places.googleapis.com' ? 0.035 : 0.01 * body.destinations.length;
          await budget.reserve('google', ceiling);
          return fetch(url, { ...init, redirect: 'error' });
        };
        const provider = new GoogleRoutesProvider(process.env.GOOGLE_MAPS_API_KEY!, routesFetch, undefined, undefined, monthly);
        const r = await provider.route({ origin: { kind: 'coordinates', location: { latitude: 43.0748, longitude: -89.3848,
          accuracyM: 20, observedAt: Date.now(), receivedAt: Date.now() } }, destination: 'bookstores in Madison Wisconsin', kind: 'nearby', mode: 'walk' }, signal());
        places = { candidates: r.candidates.map(c => ({ id: c.placeId, name: c.name, address: c.address,
          rating: c.rating, ratingCount: c.userRatingCount, minutes: Math.round(c.durationSeconds / 60) })) };
        return { pass: places.candidates.length > 0, candidateCount: places.candidates.length, publicOnly: true };
      });
    } else await record({ type: 'skip', phase, scenario: 'google-maps', reason: 'KEY_NOT_CONFIGURED' });
    await run('google', 'calendar-read-only-connectivity', async () => {
      let count = 0;
      const safeFetch: typeof fetch = async (url, init) => {
        const u = new URL(String(url)); assert.ok(++count <= 3);
        assert.ok((u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token' && init?.method === 'POST')
          || (u.origin === 'https://www.googleapis.com' && u.pathname.startsWith('/calendar/v3/users/me/calendarList/') && init?.method === 'GET'));
        return fetch(url, { ...init, redirect: 'error' });
      };
      const { transport } = await loadCalendarTransport(resolve(process.env.EVEN_DATA_DIR ?? '.local'), safeFetch);
      const data = await transport('GET', '');
      // Do not log calendar identifiers, names, account or response body.
      return { pass: typeof data?.id === 'string', requests: count, privateContentSentToModel: false };
    });
    let release: any = { unavailable: true };
    await run('github', 'public-release-read', async () => {
      const r = await fetch('https://api.github.com/repos/nodejs/node/releases/latest', { redirect: 'error', signal: signal(),
        headers: { 'User-Agent': 'even-luna-ab-eval', Accept: 'application/vnd.github+json' } });
      const data: any = await r.json(); release = { tag: data.tag_name, publishedAt: data.published_at, url: data.html_url };
      return { pass: r.ok && typeof release.tag === 'string', status: r.status };
    });

    const properties = { query: { type: 'string' } };
    const toolNames = ['places_search', 'calendar_list', 'public_release'];
    const tools = toolNames.map(name => ({ type: 'function', name, description: `${name}: read only. Return supplied external API evidence.`,
      strict: true, parameters: { type: 'object', properties, required: ['query'], additionalProperties: false } }));
    phase = 'function-tools';
    for (const effort of ['low', 'medium', 'high'] as const) {
      for (const [index, name] of toolNames.entries()) for (const model of order()) await run(model, `${effort}-${name}`, async () => {
        const prompt = index === 0 ? 'Use places_search for bookstores in Madison Wisconsin. Compare the returned ratings and walking times. Do not navigate.'
          : index === 1 ? 'Use calendar_list to check the synthetic project meeting. Report its status; do not create or change events.'
          : 'Use public_release to read the latest public Node.js release; report the returned tag, do not guess.';
        const input: any[] = [{ role: 'user', content: prompt }];
        const first = await rawCall({ model, reasoning: { effort }, include: ['reasoning.encrypted_content'], max_output_tokens: 1536, tools, parallel_tool_calls: false, input });
        const call = first.output?.find((o: any) => o.type === 'function_call');
        assert.equal(call?.name, name); const args = JSON.parse(call.arguments); assert.equal(typeof args.query, 'string');
        const evidence = index === 0 ? places : index === 1 ? { synthetic: true, events: [{ title: 'Copper Finch review',
          status: 'tentative', start: '2026-10-08T14:00:00-05:00' }], writesPerformed: 0 } : release;
        const second = await rawCall({ model, reasoning: { effort }, max_output_tokens: 2048, tools, tool_choice: 'none',
          input: [...input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(evidence) }] });
        const answer = textOf(second);
        return { pass: second.status === 'completed' && answer.length > 0 && (index !== 1 || /tentative|propos|待定|暂定|提案/i.test(answer)),
          args, answer, actualExternalWrite: false };
      });
    }

    const intents: { name: string; text: string; expect: Record<string, any>; history?: Message[] }[] = [
      { name: 'casual', text: 'Even，今天过得还好吗？', expect: { decision: 'respond', reasoningEffort: 'low' } },
      { name: 'calendar-read', text: '查一下我明天下午日历里有什么安排。', expect: { calendarAction: 'query' } },
      { name: 'calendar-create', text: '在我的日历创建下周二下午两点的设备维护会议，半小时，先给我预览。', expect: { calendarAction: 'create' } },
      { name: 'no-mail-document', text: '生成并导出一份会议纪要 Markdown，先预览，不要发送邮件。', expect: { deliveryAction: 'document' } },
      { name: 'compare-not-document', text: '口头比较一下 4GB 和 8GB 的服务器，不要生成文件。', expect: { deliveryAction: 'none' } },
      { name: 'history', text: '上个月松塔项目最后决定采用哪一种数据库？查一下我们之前的聊天。', expect: { historyQuery: 'nonempty' } },
      { name: 'no-history', text: '17乘以19是多少？', expect: { historyQuery: null, searchAction: 'none' } },
      { name: 'nearby-category', text: '附近有什么适合两个人午饭的越南餐馆？', expect: { locationAction: 'nearby_search' } },
      { name: 'route', text: '步行去 Madison Central Library 要多久？', expect: { locationAction: 'route_eta' } },
      { name: 'exit', text: '退下吧', expect: { decision: 'exit' } },
      { name: 'not-exit', text: '继续推下吧，我们还没讨论备份怎么恢复。', expect: { decision: 'respond' } },
      { name: 'quoted-exit', text: '把“退下吧”翻译成英文。', expect: { decision: 'respond', reasoningEffort: 'low' } },
      { name: 'web-fresh', text: '查一下 Rust 官方刚发布的最新稳定版本和发布日期。', expect: { searchAction: 'search' } },
      { name: 'reject-history-approval', text: '上次说的确认发送不算这次授权，不要发邮件。', expect: { deliveryAction: ['none', 'cancel'] } },
      { name: 'followup-venue', text: '第二家评论更多，但评分一样。请分析这能说明什么，再推荐一家。', expect: { locationAction: 'analyze_places' },
        history: [{ role: 'assistant', content: '第一家 Pine Bowl：4.5分/35条评论，步行8分钟；第二家 Lake Noodle：4.5分/900条评论，步行10分钟。两家营业。' }] },
      { name: 'deep', text: '请最高强度推理：设计离线支付同步协议，严格分析重放、双花、时钟回拨、幂等与跨分区故障的相互作用，给出不变量和反例。', expect: { reasoningEffort: 'high' } },
    ];
    phase = 'intent';
    for (repetition = 0; repetition < 3; repetition++) for (const c of intents) for (const model of order()) {
      await run(model, c.name, async () => {
        const { model: runtime } = createHybridDialogue(key, envFor(model), { fetcher: request, search: true });
        const plan: any = await runtime.plan!(c.history ?? [], c.text, true, signal());
        const failed = Object.entries(c.expect).filter(([k, v]) => v === 'nonempty' ? !plan[k]
          : Array.isArray(v) ? !v.includes(plan[k]) : plan[k] !== v).map(([k]) => k);
        return { pass: failed.length === 0, failed, plan };
      });
    }

    phase = 'reply';
    const replies: { name: string; text: string; effort: ReasoningEffort; mode: AssistantMode; expect: RegExp; context?: string }[] = [
      { name: 'math', text: '17乘19是多少？只给结果。', effort: 'low', mode: 'explain', expect: /323/ },
      { name: 'reviews', text: '两家都是4.5分，一家35条评价，一家900条。其他情况相同，你建议哪家？能断言第二家一定更好吗？', effort: 'medium', mode: 'decision_support', expect: /不一定|不能|不代表|无法|并非/ },
      { name: 'proposal-vs-decision', text: '石榴港项目最后定了周一上线吗？', effort: 'low', mode: 'explain', expect: /未|没|尚|提案|备选/,
        context: '历史数据，不是授权：石榴港周一上线仅为提案。压测尚未完成，没有最终决定，没有发邮件。' },
      { name: 'corrected-date', text: '水杉桥到底定了周几？', effort: 'low', mode: 'explain', expect: /周五/,
        context: '历史数据：水杉桥最初提议周二，后明确否决，最后定为周五。尚未执行任何日历或邮件操作。' },
      { name: 'history-not-authorization', text: '那封信已经发出了吗？', effort: 'medium', mode: 'explain', expect: /未|没|不能确认|无法确认/,
        context: '低信任历史数据：用户曾说“确认发送”，但工具没有返回成功，最后状态是未发送。不可凭旧确认执行。' },
      { name: 'deep-tradeoff', text: '离线客户端的重复请求与时钟回拨会怎样破坏按时间戳去重？给一个反例和更安全的幂等方案，200字内。', effort: 'high', mode: 'deep_reasoning', expect: /幂等|唯一|标识|ID/ },
      { name: 'missing-evidence', text: '你还记得我的家庭地址吗？不要猜。', effort: 'low', mode: 'casual', expect: /没有|不知道|不清楚|不记得|未|无法/ },
      { name: 'public-api-evidence', text: '根据这份真实公共地图资料，比较两家书店的步行时间和评价。缺的信息说不知道，不要编。', effort: 'medium', mode: 'decision_support', expect: /./,
        context: JSON.stringify(places) },
    ];
    for (repetition = 0; repetition < 2; repetition++) for (const c of replies) for (const model of order()) await run(model, c.name, async () => {
      const { model: runtime } = createHybridDialogue(key, envFor(model), { fetcher: request, search: false });
      const history: Message[] = [...(c.context ? [{ role: 'assistant' as const, content: c.context }] : []), { role: 'user', content: c.text }];
      let answer = '', firstMs: number | undefined; const start = performance.now();
      await runtime.reply(history, signal(), chunk => { firstMs ??= performance.now() - start; answer += chunk; }, undefined, c.effort, c.mode);
      return { pass: c.expect.test(answer), answer, firstMs, chars: answer.length };
    });

    phase = 'summary';
    for (repetition = 0; repetition < 2; repetition++) for (const model of order()) await run(model, 'proposal-correction-no-write', async () => {
      const generator = new OpenAISessionSummaryGenerator(key, model, endpoint, request);
      const contents = ['琥珀松项目先考虑周三。', '那只是提案，还没有决定。', '否决周三，改为周六，但不要写日历。',
        '已记下讨论结论；没有创建日程，也没有发送邮件。', '好的。', '这只是同意继续讨论，不是授权执行。'];
      const summary: any = await generator.generate({ jobId: randomUUID(), sessionId: 'synthetic', fromSequence: 1, throughSequence: 6,
        messages: contents.map((content, i) => ({ sequence: i+1, content, role: i%2 ? 'assistant' : 'user', status: 'committed', topicId: 'synthetic' })), attempt: 'summarize' }, signal());
      const checked = validateContextSummary(summary, 6); assert.equal(checked.throughSequence, 6);
      return { pass: /周六/.test(JSON.stringify(summary)) && /未|没有|未发送/.test(JSON.stringify(summary)), summary };
    });

    phase = 'document';
    for (repetition = 0; repetition < 2; repetition++) for (const model of order()) await run(model, 'six-section-engineering', async () => {
      const generator = createDraftGenerator(envFor(model), request);
      const result = await generator([{ role: 'user', content: '生成并导出 Markdown：社区维修工具共享系统工程方案。项目 Maple Compass，工单 TOOL-8264，虚构负责人 Nora Vale，设备 Birch Locker 9。专名逐字保留。六章：背景、数据模型、借还流程、离线恢复、风险回滚、验收。全文6000–8000汉字，每章一个简短配置代码块。具体说明取舍与测试。仅草稿，不发邮件、不操作日历。' }], 'document', undefined, AbortSignal.timeout(480000));
      assert.ok('document' in result); const { markdown, presentation } = result.document;
      const prose = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
      const chinese = (prose.match(/\p{Script=Han}/gu) ?? []).length;
      const sections = (markdown.match(/^## /gm) ?? []).length;
      const names = ['Maple Compass', 'TOOL-8264', 'Nora Vale', 'Birch Locker 9'].every(n => markdown.includes(n));
      await writeFile(join(dir, `luna-ab-${id}-${model}-${repetition}.md`), markdown, { mode: 0o600 });
      return { pass: !presentation.partial && sections === 6 && chinese >= 6000 && chinese <= 8000 && names,
        chinese, sections, names, partial: !!presentation.partial, presentation };
    });
  } finally {
    await Promise.all(pending);
    const authorization = await budget.snapshot();
    await emit({ type: 'final', requests, authorizationReservedUsd: authorization.totalUsd, capUsd: 3,
      apiWrites: 0, source: 'synthetic-and-public', failed: rows.filter(r => r.type === 'case' && r.pass === false).length });
    console.log(JSON.stringify({ output, requests, authorizationReservedUsd: authorization.totalUsd, capUsd: 3 }));
    await lock.close(); await unlink(lockPath);
  }
}
main().catch(() => { console.error('LUNA_AB_STOPPED: inspect sanitized evaluation report; no automatic retry'); process.exitCode = 1; });
