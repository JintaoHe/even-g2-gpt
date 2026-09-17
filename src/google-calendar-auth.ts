import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const GOOGLE_CALLBACK = 'http://127.0.0.1:3002/oauth/google/callback';
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned'
];
export type GoogleClient = { client_id: string; client_secret: string; redirect_uris: string[] };
export function parseGoogleClient(value: unknown): GoogleClient {
  const web = (value as { web?: GoogleClient } | null)?.web;
  if (!web || typeof web.client_id !== 'string' || !web.client_id.endsWith('.apps.googleusercontent.com')
    || typeof web.client_secret !== 'string' || !web.client_secret || !Array.isArray(web.redirect_uris)
    || !web.redirect_uris.every(uri => typeof uri === 'string')) throw new Error('GOOGLE_WEB_CLIENT_INVALID');
  return web;
}
export function googleAuthorization(client: GoogleClient, expectedEmail: string) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: GOOGLE_CALLBACK,
    response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
    login_hint: expectedEmail, state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  return { state, verifier, url: url.toString() };
}
export function validOAuthState(actual: string | null, expected: string) {
  const a = Buffer.from(actual ?? ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
type CalendarListItem = { id?: string; summary?: string; accessRole?: string; primary?: boolean; deleted?: boolean; timeZone?: string };
export function selectAssistantCalendar(items: CalendarListItem[], email: string, name: string) {
  // login_hint is only a UI hint: verify the authorized account through its primary calendar.
  if (!items.some(item => item.primary && item.accessRole === 'owner' && item.id?.toLowerCase() === email.toLowerCase())) {
    throw new Error('GOOGLE_WRONG_ACCOUNT');
  }
  const matches = items.filter(item => !item.deleted && !item.primary && item.accessRole === 'owner' && item.summary === name && item.id);
  if (matches.length !== 1) throw new Error('GOOGLE_CALENDAR_MISSING_OR_AMBIGUOUS');
  return matches[0] as CalendarListItem & { id: string };
}
export async function googleJson(url: string, init: RequestInit, request: typeof fetch = fetch): Promise<any> {
  let response: Response;
  try { response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('GOOGLE_NETWORK_FAILED'); }
  // Never surface provider response bodies (may contain credential or account data).
  if (!response.ok) throw new Error(`GOOGLE_HTTP_${response.status}`);
  try { return await response.json(); } catch { throw new Error('GOOGLE_RESPONSE_INVALID'); }
}
export async function exchangeGoogleCode(client: GoogleClient, code: string, verifier: string, request: typeof fetch = fetch) {
  const token = await googleJson('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret,
      code, code_verifier: verifier, redirect_uri: GOOGLE_CALLBACK, grant_type: 'authorization_code' }) }, request);
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || !token.refresh_token
    || typeof token.scope !== 'string' || !GOOGLE_SCOPES.every(scope => token.scope.split(' ').includes(scope))) {
    throw new Error('GOOGLE_PERMISSION_OR_REFRESH_TOKEN_MISSING');
  }
  return token as { access_token: string; refresh_token: string; scope: string };
}
export async function discoverAssistantCalendar(accessToken: string, email: string, name: string, request: typeof fetch = fetch) {
  const items: CalendarListItem[] = [];
  let page = '';
  for (let count = 0; count < 20; count++) {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    url.searchParams.set('maxResults', '250');
    if (page) url.searchParams.set('pageToken', page);
    const result = await googleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }, request);
    if (!Array.isArray(result.items)) throw new Error('GOOGLE_RESPONSE_INVALID');
    items.push(...result.items);
    if (!result.nextPageToken) return selectAssistantCalendar(items, email, name);
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken === page) break;
    page = result.nextPageToken;
  }
  throw new Error('GOOGLE_CALENDAR_LIST_LIMIT');
}
