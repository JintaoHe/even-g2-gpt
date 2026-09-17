import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_CALLBACK, GOOGLE_SCOPES, parseGoogleClient, googleAuthorization, validOAuthState,
  selectAssistantCalendar, exchangeGoogleCode, discoverAssistantCalendar } from '../src/google-calendar-auth.js';

const client = { client_id: 'test.apps.googleusercontent.com', client_secret: 'synthetic-secret', redirect_uris: [GOOGLE_CALLBACK] };
test('OAuth requires web client; uses state, PKCE, offline consent and calendar-only scopes', () => {
  assert.deepEqual(parseGoogleClient({ web: client }), client);
  assert.throws(() => parseGoogleClient({ installed: client }));
  const auth = googleAuthorization(client, 'assistant@example.com'), url = new URL(auth.url);
  assert.equal(url.searchParams.get('redirect_uri'), GOOGLE_CALLBACK);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('scope'), GOOGLE_SCOPES.join(' '));
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(validOAuthState(auth.state, auth.state), true);
  assert.equal(validOAuthState(null, auth.state), false);
  assert.equal(validOAuthState('x'.repeat(auth.state.length), auth.state), false);
  assert.notEqual(googleAuthorization(client, 'assistant@example.com').state, auth.state);
});
test('calendar binding rejects wrong account, primary, shared or ambiguous calendars', () => {
  const primary = { id: 'assistant@example.com', primary: true, accessRole: 'owner' };
  const target = { id: 'dedicated', summary: 'Even Assistant', accessRole: 'owner' };
  assert.equal(selectAssistantCalendar([primary, target], 'assistant@example.com', 'Even Assistant').id, 'dedicated');
  for (const items of [[target], [primary], [primary, target, { ...target, id: 'duplicate' }],
    [primary, { ...target, accessRole: 'writer' }], [primary, { ...target, primary: true }]]) {
    assert.throws(() => selectAssistantCalendar(items, 'assistant@example.com', 'Even Assistant'));
  }
});
test('token exchange requires both granted scopes and refresh token; redacts provider failures', async () => {
  const run = (body: object, status = 200) => exchangeGoogleCode(client, 'code', 'verifier',
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
  const good = { access_token: 'fake', refresh_token: 'fake-refresh', scope: GOOGLE_SCOPES.join(' ') };
  assert.equal((await run(good)).refresh_token, 'fake-refresh');
  await assert.rejects(run({ ...good, refresh_token: undefined }), /GOOGLE_PERMISSION/);
  await assert.rejects(run({ ...good, scope: GOOGLE_SCOPES[0] }), /GOOGLE_PERMISSION/);
  await assert.rejects(run({ error: 'sensitive-provider-text' }, 400), /^Error: GOOGLE_HTTP_400$/);
});
test('discovery follows pagination before binding and only reads calendar list', async () => {
  let calls = 0;
  const request = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/calendar/v3/users/me/calendarList');
    assert.equal(init.method, undefined);
    calls++;
    return new Response(JSON.stringify(calls === 1 ? {
      items: [{ id: 'assistant@example.com', primary: true, accessRole: 'owner' }], nextPageToken: 'next'
    } : { items: [{ id: 'dedicated', summary: 'Even Assistant', accessRole: 'owner' }] }));
  }) as typeof fetch;
  assert.equal((await discoverAssistantCalendar('fake', 'assistant@example.com', 'Even Assistant', request)).id, 'dedicated');
  assert.equal(calls, 2);
});
