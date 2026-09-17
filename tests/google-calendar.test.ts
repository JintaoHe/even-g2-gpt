import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleCalendarService, CalendarError, loadCalendarTransport, type CalendarTransport } from '../src/google-calendar.js';
import { GOOGLE_SCOPES } from '../src/google-calendar-auth.js';
import { CalendarControl } from '../src/calendar-control.js';
import { createConversationServer } from '../src/conversation-server.js';
import WebSocket from 'ws';
import { once } from 'node:events';

const event = { title: '虚拟测试', start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:15-05:00', timezone: 'America/Chicago', allDay: false, location: '', notes: '保留原始备注' };
function fake() {
  const events = new Map<string, any>(), calls: { method: string; path: string; body: any; etag?: string }[] = [];
  let version = 0;
  const transport: CalendarTransport = async (method, path, body: any, etag) => {
    calls.push({ method, path, body, etag });
    const id = path.split('/')[2]?.split('?')[0];
    if (method === 'POST') {
      if (events.has(body.id)) throw new CalendarError('CALENDAR_HTTP_409', 409);
      const value = { ...body, etag: `"v${++version}"` }; events.set(body.id, value); return value;
    }
    const current = events.get(id);
    if (!current) throw new CalendarError('CALENDAR_HTTP_404', 404);
    if (method === 'GET') return structuredClone(current);
    if (etag !== current.etag) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
    if (method === 'DELETE') { events.delete(id); return; }
    const value = { ...current, ...body, etag: `"v${++version}"` }; events.set(id, value); return value;
  };
  return { transport, events, calls };
}
async function fixture(t: any, now?: () => number, recipient?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'even-google-'));
  const mock = fake(); const service = await GoogleCalendarService.create(directory, 'dedicated', mock.transport, now, recipient);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, ...mock };
}
test('Google create needs zone confirmation; one stable ID, no mail/invite/default alarm; replay blocked', async t => {
  const f = await fixture(t); const preview = await f.service.preview('create', event);
  assert.equal(f.calls.length, 0);
  assert.match(preview.preview, /芝加哥时间/); assert.doesNotMatch(preview.preview, /洛杉矶|纽约/);
  assert.equal(preview.phrase, '确认创建');
  await assert.rejects(f.service.confirm(preview.id, '确认发送'));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.confirm(preview.id, preview.phrase)).state, 'succeeded');
  await assert.rejects(f.service.confirm(preview.id, preview.phrase));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.id, preview.eventId);
  assert.equal(f.calls[0].body.start.dateTime, '2026-10-01T18:00:00-05:00');
  assert.equal(f.calls[0].body.end.dateTime, '2026-10-01T18:15:00-05:00');
  assert.deepEqual(f.calls[0].body.reminders, { useDefault: false });
  assert.equal(f.calls[0].body.attendees, undefined);
  assert.equal(f.calls[0].path, '/events?sendUpdates=none');
});
test('configured recipient is invited on confirmed create; same event updates/cancels notify, no replay', async t => {
  const f = await fixture(t, undefined, 'receiver@example.com');
  const preview = await f.service.preview('create', event);
  assert.match(preview.preview, /将邀请你的固定邮箱/); assert.equal(f.calls.length, 0);
  const saved = await f.service.confirm(preview.id, '确认创建');
  assert.equal(saved.state, 'succeeded'); assert.equal(saved.notifyGuests, true);
  assert.equal(f.calls[0].path, '/events?sendUpdates=all');
  assert.deepEqual(f.calls[0].body.attendees, [{ email: 'receiver@example.com', responseStatus: 'needsAction' }]);
  assert.equal(f.calls[0].body.guestsCanInviteOthers, false); assert.equal(f.calls[0].body.guestsCanModify, false);
  await assert.rejects(f.service.confirm(preview.id, '确认')); assert.equal(f.calls.length, 1);
  const edit = await f.service.preview('update', { ...event, location: '会议室B' }, preview.eventId);
  assert.equal((await f.service.confirm(edit.id, '确认修改')).state, 'succeeded');
  assert.equal(f.calls.at(-1)!.path, `/events/${preview.eventId}?sendUpdates=all`);
  assert.equal(f.events.size, 1); assert.equal(f.events.get(preview.eventId).attendees[0].email, 'receiver@example.com');
  const cancel = await f.service.preview('cancel', undefined, preview.eventId);
  assert.equal((await f.service.confirm(cancel.id, '确认取消')).state, 'succeeded');
  assert.equal(f.calls.at(-1)!.path, `/events/${preview.eventId}?sendUpdates=all`);
});
test('update and cancel use latest event/etag and preserve the same ID', async t => {
  const f = await fixture(t); const create = await f.service.preview('create', event);
  await f.service.confirm(create.id, create.phrase);
  const changed = { ...event, start: '2026-10-01T19:00-05:00', end: '2026-10-01T19:15-05:00' };
  const update = await f.service.preview('update', changed, create.eventId);
  assert.match(update.preview, /原 /); assert.match(update.preview, /新 /);
  assert.equal((await f.service.confirm(update.id, update.phrase)).state, 'succeeded');
  assert.equal(f.events.size, 1);
  assert.equal(f.events.get(create.eventId).description, event.notes);
  assert.equal(f.calls.at(-1)?.method, 'PATCH');
  assert.ok(f.calls.at(-1)?.etag);
  const cancel = await f.service.preview('cancel', undefined, create.eventId);
  assert.match(cancel.preview, /19:00/);
  assert.equal((await f.service.confirm(cancel.id, cancel.phrase)).state, 'succeeded');
  assert.equal(f.events.size, 0);
  assert.equal(f.service.list().events[0].cancelled, true);
});
test('external edit after preview produces conflict, never overwrites; unmanaged/invited events rejected', async t => {
  const f = await fixture(t); const create = await f.service.preview('create', event);
  await f.service.confirm(create.id, create.phrase);
  const edit = await f.service.preview('update', { ...event, title: 'changed' }, create.eventId);
  f.events.get(create.eventId).etag = 'external';
  assert.equal((await f.service.confirm(edit.id, edit.phrase)).state, 'conflict');
  assert.equal(f.events.get(create.eventId).summary, event.title);
  await assert.rejects(f.service.preview('cancel', undefined, 'abcde'), /CALENDAR_HTTP_404/);
  f.events.get(create.eventId).attendees = [{ email: 'guest@example.com' }];
  await assert.rejects(f.service.preview('cancel', undefined, create.eventId), /CALENDAR_UNSUPPORTED/);
});
test('recurring parent and occurrence require explicit scope before any write', async t => {
  const f = await fixture(t);
  const created = await f.service.preview('create', event);
  await f.service.confirm(created.id, created.phrase);
  const remote = f.events.get(created.eventId);
  remote.recurrence = ['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4'];
  const instance = { ...remote, id: created.eventId + '_20261001T230000Z', recurrence: undefined, recurringEventId: created.eventId };
  f.events.set(instance.id, instance);
  for (const id of [remote.id, instance.id]) {
    const before = f.calls.filter(c => c.method !== 'GET').length;
    await assert.rejects(f.service.preview('update', { ...event, location: 'new' }, id), /CALENDAR_SCOPE_REQUIRED/);
    await assert.rejects(f.service.preview('cancel', undefined, id), /CALENDAR_SCOPE_REQUIRED/);
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, before);
  }
  const reader = await GoogleCalendarService.create(join(f.directory, 'reader'), 'dedicated', async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(new URL(path, 'https://example.com').searchParams.get('singleEvents'), 'true');
    return { items: [instance] };
  });
  try {
    const result = await reader.query('2026-10-01T00:00-05:00', '2026-10-02T00:00-05:00', 'America/Chicago');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].editable, true);
    assert.equal(result.items[0].recurringEventId, created.eventId);
    assert.equal(result.items[0].notes, event.notes);
  } finally { await reader.close(); }
});

test('expiry and dismiss cannot write; connection confirmation cannot use another connection preview', async t => {
  let clock = 1000; const f = await fixture(t, () => clock);
  const expired = await f.service.preview('create', event); clock += 6 * 60_000;
  await assert.rejects(f.service.confirm(expired.id, expired.phrase));
  const a: any[] = [], b: any[] = [];
  const first = new CalendarControl(f.service, e => a.push(e)), second = new CalendarControl(f.service, e => b.push(e));
  await first.handle({ type: 'calendar.preview', kind: 'create', event });
  await second.handle({ type: 'calendar.confirm', id: a[0].id, phrase: a[0].phrase });
  assert.equal(b[0].type, 'calendar.error');
  first.invalidate(); await first.handle({ type: 'calendar.confirm', id: a[0].id, phrase: a[0].phrase });
  assert.equal(f.calls.length, 0);
});
test('unknown network result persists; restart expires pending confirmations and does not replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-google-restart-')); let service: GoogleCalendarService | undefined;
  let writes = 0;
  const transport: CalendarTransport = async () => { writes++; throw new CalendarError('CALENDAR_NETWORK_UNKNOWN'); };
  try {
    service = await GoogleCalendarService.create(directory, 'dedicated', transport);
    const unknown = await service.preview('create', event), pending = await service.preview('create', event);
    assert.equal((await service.confirm(unknown.id, unknown.phrase)).state, 'unknown');
    await service.close(); service = undefined;
    service = await GoogleCalendarService.create(directory, 'dedicated', transport);
    assert.equal(writes, 1);
    await assert.rejects(service.confirm(unknown.id, unknown.phrase));
    await assert.rejects(service.confirm(pending.id, pending.phrase));
    assert.deepEqual(service.list().operations.map(op => op.state).sort(), ['expired', 'unknown']);
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('transport refreshes server-side, caches token, fixes calendar and redacts auth failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-google-token-'));
  try {
    await writeFile(join(directory, 'google-oauth-client.json'), JSON.stringify({ web: {
      client_id: 'test.apps.googleusercontent.com', client_secret: 'synthetic', redirect_uris: [] } }));
    await writeFile(join(directory, 'google-calendar-auth.json'), JSON.stringify({ account: 'assistant@example.com',
      calendarId: 'dedicated@example.com', refreshToken: 'synthetic-refresh', scope: GOOGLE_SCOPES.join(' ') }));
    const urls: string[] = [];
    const request = (async (url: string) => {
      urls.push(url); return new Response(JSON.stringify(url.includes('/token') ? { access_token: 'synthetic-access', expires_in: 3600 } : { id: 'abcde' }));
    }) as typeof fetch;
    const loaded = await loadCalendarTransport(directory, request);
    await loaded.transport('GET', '/events/abcde'); await loaded.transport('GET', '/events/abcde');
    assert.equal(urls.filter(url => url.includes('/token')).length, 1);
    assert.ok(urls[1].includes('dedicated%40example.com/events/abcde'));
    await assert.rejects(loaded.transport('GET', 'https://attacker.example/'));
    const failed = await loadCalendarTransport(directory, (async () => new Response('sensitive secret', { status: 400 })) as typeof fetch);
    await assert.rejects(failed.transport('GET', ''), /^Error: CALENDAR_REAUTHORIZE$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('authenticated browser protocol advertises calendar and requires a separate confirmed preview', async t => {
  const f = await fixture(t), token = 'synthetic-test-token-'.repeat(3);
  const app = createConversationServer({ token, calendar: f.service,
    model: { async decide() { return 'respond'; }, async reply(_history, _signal, delta) { delta('ok'); } },
    transcriber: () => { throw Error('not used'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const address = app.http.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/conversation`);
  const messages: any[] = []; socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  const wait = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const index = messages.findIndex(msg => msg.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Missing ${type}`);
  };
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', token }));
    assert.equal((await wait('ready')).capabilities.calendar, true);
    socket.send(JSON.stringify({ type: 'calendar.preview', kind: 'create', event }));
    const preview = await wait('calendar.preview'); assert.equal(f.calls.length, 0);
    socket.send(JSON.stringify({ type: 'calendar.confirm', id: preview.id, phrase: preview.phrase }));
    assert.equal((await wait('calendar.result')).state, 'succeeded');
    assert.equal(f.calls.length, 1);
    socket.send(JSON.stringify({ type: 'calendar.confirm', id: preview.id, phrase: preview.phrase }));
    await wait('calendar.error'); assert.equal(f.calls.length, 1);
    socket.send(JSON.stringify({ type: 'calendar.preview', kind: 'cancel', eventId: preview.eventId }));
    const cancellation = await wait('calendar.preview');
    socket.send(JSON.stringify({ type: 'pause' }));
    socket.send(JSON.stringify({ type: 'calendar.confirm', id: cancellation.id, phrase: cancellation.phrase }));
    await wait('calendar.error'); assert.equal(f.events.size, 1);
  } finally { socket.terminate(); await app.close(); }
});
