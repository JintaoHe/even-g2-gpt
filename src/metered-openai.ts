import type { CostLedger, CostReservation } from './cost-ledger.js';
import type { ProviderMetricObserver } from './runtime-metrics.js';

type Pricing = { inputPerMillion: number; cachedInputPerMillion: number; cacheWritePerMillion: number; outputPerMillion: number; webSearchPerCall: number };
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};

const positive = (value: string | undefined, fallback: number, name: string) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
};
export function openAIPricing(env: NodeJS.ProcessEnv = process.env): Pricing {
  return {
    inputPerMillion: positive(env.OPENAI_INPUT_USD_PER_M, 0.20, 'OPENAI_INPUT_USD_PER_M'),
    cachedInputPerMillion: positive(env.OPENAI_CACHED_INPUT_USD_PER_M, 0.02, 'OPENAI_CACHED_INPUT_USD_PER_M'),
    cacheWritePerMillion: positive(env.OPENAI_CACHE_WRITE_USD_PER_M, 0.25, 'OPENAI_CACHE_WRITE_USD_PER_M'),
    outputPerMillion: positive(env.OPENAI_OUTPUT_USD_PER_M, 1.20, 'OPENAI_OUTPUT_USD_PER_M'),
    webSearchPerCall: positive(env.OPENAI_WEB_SEARCH_USD_PER_CALL, 0.01, 'OPENAI_WEB_SEARCH_USD_PER_CALL')
  };
}

const boundedInteger = (value: unknown, fallback = 0) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
function actualCost(response: any, pricing: Pricing) {
  const usage = response?.usage as Usage | undefined;
  if (!usage) return undefined;
  const input = boundedInteger(usage.input_tokens), output = boundedInteger(usage.output_tokens);
  const cached = Math.min(input, boundedInteger(usage.input_tokens_details?.cached_tokens));
  const written = Math.min(input - cached, boundedInteger(usage.input_tokens_details?.cache_write_tokens));
  const ordinary = Math.max(0, input - cached - written);
  const items = Array.isArray(response?.output) ? response.output : [];
  const webCalls = items.filter((item: any) => item?.type === 'web_search_call').length;
  const longLuna = typeof response?.model === 'string' && response.model.startsWith('gpt-5.6-luna') && input > 272_000;
  return (ordinary * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion + written * pricing.cacheWritePerMillion)
      * (longLuna ? 2 : 1) / 1_000_000
    + output * pricing.outputPerMillion * (longLuna ? 1.5 : 1) / 1_000_000
    + webCalls * pricing.webSearchPerCall;
}

function requestMaximum(bodyText: string, pricing: Pricing) {
  let body: any = {};
  try { body = JSON.parse(bodyText); } catch { /* Reserve from the raw request even if OpenAI later rejects it. */ }
  // UTF-8 bytes are a conservative upper bound for tokenizer tokens for supported text inputs.
  const inputTokens = Math.max(1, Buffer.byteLength(bodyText));
  const outputTokens = Math.max(1, boundedInteger(body?.max_output_tokens, 8_192));
  const hasSearch = Array.isArray(body?.tools) && body.tools.some((tool: any) => tool?.type === 'web_search' || tool?.type === 'web_search_preview');
  const webCalls = hasSearch ? Math.max(1, boundedInteger(body?.max_tool_calls, 10)) : 0;
  const longLuna = typeof body?.model === 'string' && body.model.startsWith('gpt-5.6-luna') && inputTokens > 272_000;
  return inputTokens * pricing.inputPerMillion * (longLuna ? 2 : 1) / 1_000_000
    + outputTokens * pricing.outputPerMillion * (longLuna ? 1.5 : 1) / 1_000_000 + webCalls * pricing.webSearchPerCall;
}

async function responseObject(response: Response) {
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (type.includes('text/event-stream')) {
    const text = await response.text();
    let completed: any;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (!value || value === '[DONE]') continue;
      try { const event = JSON.parse(value); if (event?.type === 'response.completed') completed = event.response; } catch { /* Ignore partial/invalid SSE lines. */ }
    }
    return completed;
  }
  try { return await response.json(); } catch { return undefined; }
}

async function settleFromResponse(ticket: CostReservation, response: Response, pricing: Pricing) {
  if (response.status >= 400 && response.status < 500) { await ticket.settle(0); return; }
  if (!response.ok) return; // A timeout/5xx can still have reached the provider; retain the reservation conservatively.
  const object = await responseObject(response);
  const cost = actualCost(object, pricing);
  if (cost !== undefined) await ticket.settle(Math.min(cost, ticket.reservedUsd));
}

export function createMeteredOpenAIFetch(ledger: CostLedger, env: NodeJS.ProcessEnv = process.env,
  baseFetch: typeof fetch = fetch, observe?: ProviderMetricObserver): typeof fetch {
  const pricing = openAIPricing(env);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.openai.com/')) return baseFetch(input, init);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const ticket = await ledger.reserve('openai', requestMaximum(bodyText, pricing));
    const startedAt = Date.now();
    let response: Response;
    try { response = await baseFetch(input, init); }
    catch (error) {
      observe?.('openai', (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failure', Date.now() - startedAt);
      throw error; // Unknown provider outcome: keep the conservative reservation.
    }
    observe?.('openai', response.ok ? 'success' : 'failure', Date.now() - startedAt);
    void settleFromResponse(ticket, response.clone(), pricing).catch(() => {});
    return response;
  }) as typeof fetch;
}
