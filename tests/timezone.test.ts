import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleTimezoneProvider, resolveLocationTimezone, TimezoneClarificationError, TimezoneError } from '../src/timezone.js';
import { createTimezoneFallback } from '../src/timezone-fallback.js';

const location = { latitude: 34.0522, longitude: -118.2437, accuracyM: 15, timezoneHint: 'America/Los_Angeles',
  observedAt: Date.parse('2026-09-19T18:00:00Z'), receivedAt: Date.parse('2026-09-19T18:00:01Z') };

test('Google Time Zone resolves coordinates to a validated IANA zone without exposing the key', async () => {
  let requested = '';
  const provider = new GoogleTimezoneProvider('private-key', async input => {
    requested = String(input);
    return new Response(JSON.stringify({ status: 'OK', timeZoneId: 'America/Los_Angeles', rawOffset: -28800, dstOffset: 3600 }));
  }, 'https://maps.googleapis.com/maps/api/timezone/json', () => Date.parse('2026-09-19T18:00:00Z'));
  assert.equal(await provider.resolve(location, new AbortController().signal), 'America/Los_Angeles');
  const url = new URL(requested);
  assert.equal(url.searchParams.get('location'), '34.0522,-118.2437');
  assert.equal(url.searchParams.get('timestamp'), String(Date.parse('2026-09-19T18:00:00Z') / 1000));
  assert.equal(url.searchParams.get('key'), 'private-key');
});

test('Google Time Zone rejects denied or malformed provider results', async () => {
  const denied = new GoogleTimezoneProvider('private-key', async () => new Response(JSON.stringify({ status: 'REQUEST_DENIED' })));
  await assert.rejects(denied.resolve(location, new AbortController().signal), /TIMEZONE_UNAVAILABLE/);
  const malformed = new GoogleTimezoneProvider('private-key', async () => new Response(JSON.stringify({ status: 'OK', timeZoneId: 'not/a zone' })));
  await assert.rejects(malformed.resolve(location, new AbortController().signal), /TIMEZONE_UNAVAILABLE/);
});

test('Google failure falls back to Luna with dialogue and device hint, but never coordinates', async () => {
  const history = [{ role: 'user' as const, content: '我现在在洛杉矶市中心，帮我创建今天下午四点的日程。' }];
  let received: unknown;
  let fallbackCount = 0;
  const result = await resolveLocationTimezone(location, history,
    { resolve: async () => { throw new TimezoneError('TIMEZONE_UNAVAILABLE'); } },
    { resolve: async (...args) => {
      received = { history: args[0], hint: args[1] };
      return { action: 'use', timezone: 'America/Los_Angeles' };
    } }, new AbortController().signal, () => { fallbackCount++; });
  assert.equal(result, 'America/Los_Angeles');
  assert.equal(fallbackCount, 1);
  assert.deepEqual(received, { history, hint: 'America/Los_Angeles' });
  assert.ok(!JSON.stringify(received).includes('34.0522'));
});

test('ambiguous Luna fallback asks one short location question instead of guessing', async () => {
  await assert.rejects(resolveLocationTimezone(location, [], undefined,
    { resolve: async () => ({ action: 'ask', clarification: '你现在在哪个城市或地区' }) },
    new AbortController().signal), error => {
      assert.ok(error instanceof TimezoneClarificationError);
      assert.equal(error.clarification, '你现在在哪个城市或地区？');
      return true;
    });
});

test('Luna timezone fallback uses strict non-persistent structured output without tools or coordinates', async () => {
  let requestBody: any;
  const fallback = createTimezoneFallback('private-openai-key', 'gpt-5.6-luna', 'http://127.0.0.1:9999/v1/responses',
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text',
        text: JSON.stringify({ action: 'use', timezone: 'America/Los_Angeles', clarification: '' }) }] }] }));
    });
  const result = await fallback.resolve([{ role: 'user', content: '我现在住在 Los Angeles。' }], 'America/Los_Angeles',
    new AbortController().signal);
  assert.deepEqual(result, { action: 'use', timezone: 'America/Los_Angeles' });
  assert.equal(requestBody.model, 'gpt-5.6-luna');
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.reasoning.effort, 'medium');
  assert.equal(requestBody.tools, undefined);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.match(requestBody.input[0].content, /America\/Los_Angeles/);
  assert.match(requestBody.input[0].content, /Los Angeles/);
  assert.ok(!requestBody.input[0].content.includes('34.0522'));
});
