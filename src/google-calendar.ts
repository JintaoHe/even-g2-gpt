import { readFile, mkdir, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateCalendar, type CalendarEvent } from './calendar.js';
import { parseGoogleClient, GOOGLE_SCOPES, type GoogleClient } from './google-calendar-auth.js';
import { compactCalendarPreview, shortConfirmation, calendarConfirmed } from './calendar-preview.js';
import { suggestCalendarSlot, zonedMinute } from './calendar-slots.js';
import { calendarDisplayTime } from './calendar-display.js';
import { calendarQueryMatches, suggestCalendarMatches } from './calendar-query.js';
import { recurrenceOccurrences, boundRecurrenceRequest, revisedRecurrenceNotes } from './calendar-recurrence.js';

export type CalendarScope = 'single' | 'series';

type Auth = { account: string; calendarId: string; refreshToken: string; scope: string };
export type CalendarTransport = (method: string, path: string, body?: unknown, etag?: string) => Promise<any>;
export class CalendarError extends Error {
  constructor(public code: string, public status = 0, public retryAfterMs?: number) { super(code); }
}
export type CalendarHealth = { state: 'unknown' | 'reading' | 'retrying' | 'healthy' | 'error'; operation?: 'list' | 'event' | 'probe';
  checkedAt?: string; lastSuccessAt?: string; attempts?: number; durationMs?: number; recovered?: boolean;
  errorCode?: string; httpStatus?: number; returnedCount?: number };
export function retryableCalendarRead(error: unknown) {
  if (!(error instanceof CalendarError)) return false;
  if ((error.retryAfterMs ?? 0) > 3000) return false; // Surface long throttles instead of blocking a conversation.
  return ['CALENDAR_NETWORK_UNKNOWN', 'CALENDAR_RESPONSE_UNKNOWN', 'CALENDAR_AUTH_NETWORK', 'CALENDAR_AUTH_RESPONSE_UNKNOWN'].includes(error.code)
    || [408, 429, 500, 502, 503, 504].includes(error.status)
    || (error.status === 401 && error.code.startsWith('CALENDAR_HTTP_'))
    || (error.status === 403 && /_(?:rateLimitExceeded|userRateLimitExceeded)$/.test(error.code));
}
export function calendarError(error: unknown) {
  return error instanceof CalendarError ? error.code : error instanceof Error && /^CALENDAR_[A-Z_]+$/.test(error.message) ? error.message : 'CALENDAR_FAILED';
}
export async function loadCalendarTransport(directory: string, request: typeof fetch = fetch): Promise<{ transport: CalendarTransport; calendarId: string }> {
  const client: GoogleClient = parseGoogleClient(JSON.parse(await readFile(join(directory, 'google-oauth-client.json'), 'utf8')));
  const auth = JSON.parse(await readFile(join(directory, 'google-calendar-auth.json'), 'utf8')) as Auth;
  if (!auth.calendarId || !auth.account || !auth.refreshToken || !GOOGLE_SCOPES.every(s => auth.scope?.split(' ').includes(s))
    || auth.calendarId === auth.account || auth.calendarId === 'primary') throw new CalendarError('CALENDAR_AUTH_INVALID');
  let token = '', expires = 0;
  let refreshing: Promise<void> | undefined;
  async function refresh() {
    refreshing ??= (async () => {
      let response: Response;
      try {
        response = await request('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret,
            refresh_token: auth.refreshToken, grant_type: 'refresh_token' }) });
      } catch { throw new CalendarError('CALENDAR_AUTH_NETWORK'); }
      if (!response.ok) { await response.body?.cancel(); throw new CalendarError(response.status === 429 || response.status >= 500 ? `CALENDAR_AUTH_HTTP_${response.status}` : 'CALENDAR_REAUTHORIZE', response.status); }
      const data = await response.json().catch(() => { throw new CalendarError('CALENDAR_AUTH_RESPONSE_UNKNOWN'); }) as any;
      if (!data || typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in < 60) throw new CalendarError('CALENDAR_AUTH_INVALID');
      token = data.access_token; expires = Date.now() + (data.expires_in - 30) * 1000;
    })();
    try { await refreshing; } finally { refreshing = undefined; }
  }
  const transport: CalendarTransport = async (method, path, body, etag) => {
    // Callers cannot redirect credentials or select another calendar.
    const parsedPath = new URL(path || '/', 'https://calendar.invalid');
    const listing = method === 'GET' && parsedPath.pathname === '/events' && [...parsedPath.searchParams.keys()].every(k => ['timeMin', 'timeMax', 'timeZone', 'singleEvents', 'orderBy', 'showDeleted', 'maxResults', 'pageToken'].includes(k));
    if (!/^(?:|\/events(?:\/[a-v0-9]{5,1024}(?:_\d{8}(?:T\d{6}Z)?)?)?(?:\?sendUpdates=(?:none|all))?)$/.test(path)
      && !(listing && path.startsWith('/events?') && parsedPath.origin === 'https://calendar.invalid')) throw new CalendarError('CALENDAR_PATH_INVALID');
    if (Date.now() >= expires) await refresh();
    let response: Response;
    try {
      const endpoint = path === '' ? `users/me/calendarList/${encodeURIComponent(auth.calendarId)}` : `calendars/${encodeURIComponent(auth.calendarId)}${path}`;
      response = await request(`https://www.googleapis.com/calendar/v3/${endpoint}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new CalendarError('CALENDAR_NETWORK_UNKNOWN'); }
    if (!response.ok) {
      // Only expose known diagnostic categories, never Google's free-form message/metadata.
      const data = await response.json().catch(() => undefined) as any;
      const reasons = (Array.isArray(data?.error?.errors) ? data.error.errors : []).map((item: any) => item?.reason);
      const known = ['forbidden', 'insufficientPermissions', 'accessNotConfigured', 'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'invalid', 'required', 'notFound', 'duplicate', 'forbiddenForNonOrganizer'];
      const reason = known.find(item => reasons.includes(item));
      if (response.status === 401) { token = ''; expires = 0; }
      const retryHeader = response.headers.get('retry-after');
      const retryAfterMs = retryHeader === null ? undefined : /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - Date.now());
      throw new CalendarError(response.status === 412 ? 'CALENDAR_CHANGED_REVIEW_AGAIN' : `CALENDAR_HTTP_${response.status}${reason ? '_' + reason : ''}`, response.status, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
    }
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new CalendarError('CALENDAR_RESPONSE_UNKNOWN'); }
  };
  return { transport, calendarId: auth.calendarId };
}

type Operation = { id: string; eventId: string; kind: 'create' | 'update' | 'cancel'; event: CalendarEvent; etag?: string; parentId?: string; parentEtag?: string;
  before?: unknown; phrase: string; expires: number; state: string; error?: string; notifyGuests?: boolean; invitee?: string; overlapIds?: string[] };
export type CalendarItem = { id: string; title: string; start: string; end: string; timezone: string; location: string; notes?: string; notesTruncated?: boolean; recurringEventId?: string; editable: boolean; event?: CalendarEvent };
export function eventBody(event: CalendarEvent) {
  const e = validateCalendar(event);
  return { summary: e.title, description: e.notes, location: e.location, ...(e.recurrence !== undefined ? { recurrence: e.recurrence ? [e.recurrence] : [] } : {}),
    start: e.allDay ? { date: e.start } : { dateTime: e.start.replace(/(T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, '$1:00$2'), timeZone: e.timezone },
    end: e.allDay ? { date: e.end } : { dateTime: e.end.replace(/(T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, '$1:00$2'), timeZone: e.timezone } };
}
function identity(id: string) { if (!/^[a-v0-9]{5,1024}(?:_\d{8}(?:T\d{6}Z)?)?$/.test(id)) throw new CalendarError('CALENDAR_EVENT_INVALID'); }
function previewEvent(remote: any): CalendarEvent {
  // Google's returned RFC3339 can include seconds. Never infer missing timezones.
  const shorten = (s: string) => typeof s === 'string' ? s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00(Z|[+-]\d\d:\d\d)$/, '$1$2') : s;
  return validateCalendar({ title: remote.summary ?? '', notes: remote.description ?? '', location: remote.location ?? '',
    allDay: !!remote.start?.date, start: remote.start?.date ?? shorten(remote.start?.dateTime),
    end: remote.end?.date ?? shorten(remote.end?.dateTime), timezone: remote.start?.date ? '' : remote.start?.timeZone ?? '',
    ...(remote.recurrence?.length ? { recurrence: remote.recurrence.length === 1 ? remote.recurrence[0] : 'unsupported' } : {}) });
}
/** Dedicated-calendar, managed-event-only service. Requires a preview and exact one-use confirmation. */
export class GoogleCalendarService {
  private work?: Promise<Operation>;
  private healthState: CalendarHealth = { state: 'unknown' };
  private healthListeners = new Set<(health: CalendarHealth) => void>();
  health() { return { ...this.healthState }; }
  subscribeHealth(listener: (health: CalendarHealth) => void) { this.healthListeners.add(listener); return () => { this.healthListeners.delete(listener); }; }
  private publishHealth(health: CalendarHealth) {
    this.healthState = health;
    for (const listener of this.healthListeners) try { listener(this.health()); } catch { /* UI cannot alter API results. */ }
  }
  private async readResponse(path: string, operation: 'list' | 'event' | 'probe', valid: (data: any) => boolean) {
    const started = Date.now(), lastSuccessAt = this.healthState.lastSuccessAt;
    let lastError: CalendarError | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.publishHealth({ state: attempt === 1 ? 'reading' : 'retrying', operation, attempts: attempt, lastSuccessAt,
        errorCode: lastError?.code, httpStatus: lastError?.status || undefined });
      try {
        const result = await this.transport('GET', path);
        if (!valid(result)) throw new CalendarError('CALENDAR_RESPONSE_UNKNOWN');
        const checkedAt = new Date(this.now()).toISOString();
        this.publishHealth({ state: 'healthy', operation, checkedAt, lastSuccessAt: checkedAt, attempts: attempt,
          durationMs: Date.now() - started, recovered: attempt > 1, errorCode: lastError?.code, httpStatus: lastError?.status || undefined,
          ...(operation === 'list' ? { returnedCount: result.items?.length ?? 0 } : {}) });
        return result;
      } catch (error) {
        lastError = error instanceof CalendarError ? error : new CalendarError('CALENDAR_FAILED');
        if (attempt === 1 && retryableCalendarRead(lastError)) {
          this.publishHealth({ state: 'retrying', operation, attempts: 2, lastSuccessAt, errorCode: lastError.code, httpStatus: lastError.status || undefined });
          await new Promise(resolve => setTimeout(resolve, Math.max(1000 + Math.floor(Math.random() * 500), lastError!.retryAfterMs ?? 0)));
          continue;
        }
        this.publishHealth({ state: 'error', operation, checkedAt: new Date(this.now()).toISOString(), lastSuccessAt,
          attempts: attempt, durationMs: Date.now() - started, errorCode: lastError.code, httpStatus: lastError.status || undefined });
        throw lastError;
      }
    }
    throw lastError;
  }
  async checkHealth() {
    const binding = this.db.prepare('SELECT calendar FROM binding WHERE id=1').get() as { calendar: string };
    try { await this.readResponse('', 'probe', data => data?.id === binding.calendar && data?.accessRole === 'owner'); } catch { /* Health snapshot reports sanitized failure. */ }
    return this.health();
  }
  private constructor(private db: DatabaseSync, private transport: CalendarTransport, private now: () => number, private allowedGuest?: string) {}
  static async create(directory: string, calendarId: string, transport: CalendarTransport, now: () => number = Date.now, allowedGuest?: string) {
    if (allowedGuest !== undefined) {
      allowedGuest = allowedGuest.trim().toLowerCase();
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(allowedGuest) || allowedGuest.length > 254) throw new CalendarError('CALENDAR_RECIPIENT_INVALID');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'google-calendar.sqlite');
    for (const path of [directory, file]) {
      const stat = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (stat?.isSymbolicLink()) throw new CalendarError('CALENDAR_SYMLINK_REJECTED');
    }
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY, calendar TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS managed_events (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      db.exec('CREATE TABLE IF NOT EXISTS query_audit (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
      const previous = db.prepare('SELECT calendar FROM binding WHERE id=1').get() as { calendar: string } | undefined;
      if (previous && previous.calendar !== calendarId) throw new CalendarError('CALENDAR_BINDING_CHANGED');
      db.prepare('INSERT OR IGNORE INTO binding VALUES (1, ?)').run(calendarId);
      // Caller must enforce single backend ownership (JobStore does this at server startup).
      for (const row of db.prepare('SELECT data FROM operations').all() as { data: string }[]) {
        const op = JSON.parse(row.data) as Operation;
        if (op.state === 'sending' || op.state === 'pending') {
          op.state = op.state === 'sending' ? 'unknown' : 'expired';
          db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(op), op.id);
        }
      }
      await chmod(file, 0o600);
      return new GoogleCalendarService(db, transport, now, allowedGuest);
    } catch (error) { db.close(); throw error; }
  }
  private save(op: Operation) {
    this.db.prepare('INSERT OR REPLACE INTO operations VALUES (?, ?, ?)').run(op.id, op.eventId, JSON.stringify(op));
    return op;
  }
  recordQuerySelection(start: string, end: string, timezone: string, filter: string, returned: number, matched: number, complete: boolean) {
    // Private bounded ledger; no tokens, notes, attendee addresses or full event payloads.
    this.db.prepare('INSERT INTO query_audit(data) VALUES (?)').run(JSON.stringify({ at: new Date(this.now()).toISOString(), start, end, timezone, filter, returned, matched, complete, source: 'google_calendar' }));
    this.db.exec('DELETE FROM query_audit WHERE id NOT IN (SELECT id FROM query_audit ORDER BY id DESC LIMIT 200)');
  }
  private operation(id: string) {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new CalendarError('CALENDAR_OPERATION_NOT_FOUND');
    return JSON.parse(row.data) as Operation;
  }
  list() {
    return { events: (this.db.prepare('SELECT data FROM managed_events').all() as { data: string }[]).map(r => JSON.parse(r.data)),
      operations: (this.db.prepare('SELECT data FROM operations ORDER BY rowid DESC LIMIT 30').all() as { data: string }[])
        .map(r => { const op = JSON.parse(r.data) as Operation; return { id: op.id, eventId: op.eventId, kind: op.kind, state: op.state, error: op.error }; }) };
  }
  private supported(remote: any) {
    return remote.extendedProperties?.private?.evenAssistant === '1' && typeof remote.etag === 'string'
      && !(remote.attendees ?? []).some((a: any) => !this.allowedGuest || a.email?.toLowerCase() !== this.allowedGuest.toLowerCase())
      && remote.status !== 'cancelled';
  }
  async query(start: string, end: string, timezone: string): Promise<{ items: CalendarItem[]; complete: boolean }> {
    // Read bounds are instants, unlike write-time wall-clock confirmations.
    // RFC3339 seconds/fractions and UTC Z are valid Google query parameters.
    const valid = (s: string) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
      const local = s.slice(0, 10), day = Date.parse(local + 'T00:00Z');
      return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === local
        && +s.slice(11, 13) < 24 && +s.slice(14, 16) < 60 && (s[16] !== ':' || +s.slice(17, 19) < 60) && Number.isFinite(Date.parse(s));
    };
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new CalendarError('CALENDAR_QUERY_INVALID'); }
    if (!timezone || !valid(start) || !valid(end) || Date.parse(end) <= Date.parse(start)) throw new CalendarError('CALENDAR_QUERY_INVALID');
    if (Date.parse(end) - Date.parse(start) > 31 * 86400000) throw new CalendarError('CALENDAR_RANGE_LIMIT');
    const items: CalendarItem[] = []; let page = '';
    for (let n = 0; n < 5; n++) {
      const params = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone: timezone,
        singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '100', ...(page ? { pageToken: page } : {}) });
      const result = await this.readResponse('/events?' + params, 'list', data => !!data && typeof data === 'object'
        && ((Array.isArray(data.items) && data.items.every((e: any) => e && typeof e.id === 'string' && (e.status === 'cancelled' || ((e.start?.dateTime || e.start?.date) && (e.end?.dateTime || e.end?.date)))))
          || (data.kind === 'calendar#events' && data.items === undefined)));
      for (const raw of result.items ?? []) {
        if (raw.status === 'cancelled') continue;
        let event: CalendarEvent | undefined;
        try { event = previewEvent(raw); } catch { /* Unsupported external formats remain readable, never silently editable. */ }
        if (typeof raw.id !== 'string') throw new CalendarError('CALENDAR_RESPONSE_UNKNOWN');
        items.push({ id: raw.id, title: String(raw.summary ?? '(无标题)').slice(0, 200), start: raw.start?.dateTime ?? raw.start?.date ?? '',
          end: raw.end?.dateTime ?? raw.end?.date ?? '', timezone: raw.start?.timeZone ?? timezone, location: String(raw.location ?? '').slice(0, 200),
          notes: String(raw.description ?? '').slice(0, 6000), notesTruncated: String(raw.description ?? '').length > 6000,
          recurringEventId: raw.recurringEventId, editable: !!event && this.supported(raw), event });
      }
      if (!result.nextPageToken) return { items, complete: true };
      if (typeof result.nextPageToken !== 'string' || page === result.nextPageToken) break;
      page = result.nextPageToken;
    }
    return { items, complete: false };
  }
  async next(filter: string, timezone: string, now = this.now(), selection?: CalendarItem) {
    if (!filter.trim()) throw new CalendarError('CALENDAR_QUERY_TITLE_REQUIRED');
    const candidates: CalendarItem[] = [];
    // Three non-overlapping 31-day windows; never claim absence beyond this horizon.
    for (let i = 0; i < 3; i++) {
      const start = new Date(now + i * 31 * 86400000).toISOString(), end = new Date(now + (i + 1) * 31 * 86400000).toISOString();
      const result = await this.query(start, end, timezone);
      if (!result.complete) throw new CalendarError('CALENDAR_QUERY_INCOMPLETE');
      const upcoming = result.items.filter(e => e.start.includes('T') && Date.parse(e.start) >= now);
      candidates.push(...upcoming);
      const matches = (selection ? upcoming.filter(e => selection.recurringEventId ? e.recurringEventId === selection.recurringEventId : e.id === selection.id)
        : calendarQueryMatches(upcoming, filter))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      this.recordQuerySelection(start, end, timezone, filter, result.items.length, matches.length, true);
      if (matches.length) return { items: matches.filter(e => Date.parse(e.start) === Date.parse(matches[0].start)), suggestions: [] as CalendarItem[], horizonDays: 93 };
    }
    return { items: [], suggestions: selection ? [] : suggestCalendarMatches(candidates, filter), horizonDays: 93 };
  }
  async read(id: string) { return previewEvent(await this.remote(id)); }
  private async overlaps(event: CalendarEvent, excludeId: string) {
    const found = new Map<string, CalendarItem>();
    // Batch nearby occurrences into bounded list windows, then test actual time overlap.
    const occurrences = recurrenceOccurrences(event);
    for (let i = 0; i < occurrences.length;) {
      const start = occurrences[i].start; let j = i;
      while (j + 1 < occurrences.length && Date.parse(occurrences[j + 1].end) - Date.parse(start) <= 31 * 86400000) j++;
      const group = occurrences.slice(i, j + 1);
      const result = await this.query(start, occurrences[j].end, event.timezone);
      if (!result.complete) throw new CalendarError('CALENDAR_OVERLAP_INCOMPLETE');
      for (const item of result.items) {
        if (item.id === excludeId || item.recurringEventId === excludeId) continue;
        const overlaps = group.some(occurrence => item.start.includes('T')
          ? Date.parse(item.start) < Date.parse(occurrence.end) && Date.parse(item.end) > Date.parse(occurrence.start)
          : item.start <= occurrence.end.slice(0, 10) && item.end > occurrence.start.slice(0, 10));
        if (overlaps) found.set(item.id, item);
      }
      i = j + 1;
    }
    return { items: [...found.values()], complete: true };
  }
  async scopedTarget(id: string, scope?: CalendarScope) {
    const remote = await this.remote(id);
    if ((remote.recurringEventId || remote.recurrence?.length) && !scope) throw new CalendarError('CALENDAR_SCOPE_REQUIRED');
    if (scope === 'series' && remote.recurringEventId) return { id: remote.recurringEventId as string, event: await this.read(remote.recurringEventId) };
    if (scope === 'single' && remote.recurrence?.length) throw new CalendarError('CALENDAR_INSTANCE_REQUIRED');
    return { id, event: previewEvent(remote) };
  }
  async details(id: string) {
    identity(id);
    const remote = await this.readResponse(`/events/${id}`, 'event', data => data?.id === id && (data.status === 'cancelled' || !!(data.start && data.end)));
    if (remote.id !== id || remote.status === 'cancelled') throw new CalendarError('CALENDAR_EVENT_UNAVAILABLE');
    return { title: String(remote.summary ?? '').slice(0, 200), notes: String(remote.description ?? '').slice(0, 6000),
      attendees: (Array.isArray(remote.attendees) ? remote.attendees : []).slice(0, 30).map((a: any) => ({
        name: String(a.displayName ?? '').slice(0, 100), email: String(a.email ?? '').slice(0, 254),
        status: ['accepted', 'declined', 'tentative', 'needsAction'].includes(a.responseStatus) ? a.responseStatus : 'unknown' })),
      incomplete: !!remote.attendeesOmitted || (remote.attendees?.length ?? 0) > 30 || String(remote.description ?? '').length > 6000 };
  }
  private async remote(id: string) {
    identity(id);
    const remote = await this.readResponse(`/events/${id}`, 'event', data => data?.id === id && (data.status === 'cancelled' || !!(data.start && data.end)));
    if (remote.id !== id || !this.supported(remote)) {
      throw new CalendarError('CALENDAR_UNSUPPORTED_EVENT');
    }
    if (remote.recurringEventId) {
      identity(remote.recurringEventId);
      const parent = await this.readResponse(`/events/${remote.recurringEventId}`, 'event', data => data?.id === remote.recurringEventId && !!data.start && !!data.end);
      if (!this.supported(parent) || parent.recurringEventId || !previewEvent(parent).recurrence) throw new CalendarError('CALENDAR_UNSUPPORTED_EVENT');
      remote.evenParentEtag = parent.etag;
    }
    return remote;
  }
  async preview(kind: Operation['kind'], value?: unknown, eventId?: string, expectedEvent?: CalendarEvent, checkOverlaps = false, scope?: CalendarScope) {
    if (this.work) throw new CalendarError('CALENDAR_BUSY');
    if (!['create', 'update', 'cancel'].includes(kind)) throw new CalendarError('CALENDAR_ACTION_INVALID');
    if ((this.db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n >= 10000) throw new CalendarError('CALENDAR_STORAGE_LIMIT');
    if (scope !== undefined && !['single', 'series'].includes(scope)) throw new CalendarError('CALENDAR_SCOPE_REQUIRED');
    const id = randomUUID(), target = kind === 'create' ? randomUUID().replaceAll('-', '') : (await this.scopedTarget(eventId ?? '', scope)).id;
    const remote = kind === 'create' ? undefined : await this.remote(target);
    if (remote && expectedEvent && JSON.stringify(previewEvent(remote)) !== JSON.stringify(expectedEvent)) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
    // Block follow-up writes after an uncertain result until an operator reconciles it.
    const uncertain = (this.db.prepare('SELECT data FROM operations').all() as { data: string }[])
      .some(row => { const op = JSON.parse(row.data) as Operation;
        return ['sending', 'unknown'].includes(op.state) && (op.eventId === target || op.parentId === target || op.eventId === remote?.recurringEventId || (op.parentId && op.parentId === remote?.recurringEventId)); });
    if (uncertain) throw new CalendarError('CALENDAR_RECONCILIATION_REQUIRED');
    const event = kind === 'cancel' ? previewEvent(remote) : revisedRecurrenceNotes(validateCalendar(boundRecurrenceRequest(value)), remote ? previewEvent(remote) : undefined);
    if (kind === 'update' && remote?.recurrence?.length && event.recurrence === undefined) throw new CalendarError('CALENDAR_RECURRENCE_REQUIRED');
    if (remote?.recurringEventId && event.recurrence) throw new CalendarError('CALENDAR_INSTANCE_RECURRENCE_FORBIDDEN');
    const overlaps = (checkOverlaps || !!event.recurrence) && kind !== 'cancel' && !event.allDay ? await this.overlaps(event, target) : undefined;
    if (overlaps && !overlaps.complete) throw new CalendarError('CALENDAR_OVERLAP_INCOMPLETE');
    const matching = overlaps?.items.filter(e => e.id !== target) ?? [];
    let alternative: string | undefined;
    if (matching.length && !event.recurrence) {
      try {
        const horizon = await this.query(event.start, zonedMinute(Date.parse(event.start) + 48 * 3600000, event.timezone), event.timezone);
        const slot = horizon.complete ? suggestCalendarSlot(event, horizon.items, target) : undefined;
        alternative = slot ? `本日历可选：${calendarDisplayTime(slot.start, slot.end, event.timezone)}`
          : horizon.complete ? '暂未找到合适空档，请另选时间。' : '空档查询不完整，请另选时间。';
      } catch { alternative = '暂无法核实其他空档，请另选时间。'; }
    }
    const phrase = shortConfirmation(kind);
    const invitee = kind === 'create' ? this.allowedGuest : undefined;
    const notifyGuests = !!invitee || !!remote?.attendees?.length;
    const preview = compactCalendarPreview(kind, event, remote ? previewEvent(remote) : undefined, matching.map(e => e.title), notifyGuests, alternative,
      remote?.recurringEventId ? 'single' : remote?.recurrence?.length ? 'series' : undefined);
    const op = this.save({ id, eventId: target, kind, event, before: remote ? previewEvent(remote) : undefined,
      etag: remote?.etag, parentId: remote?.recurringEventId, parentEtag: remote?.evenParentEtag, phrase, expires: this.now() + 5 * 60_000, state: 'pending', notifyGuests, invitee,
      ...(overlaps ? { overlapIds: matching.map(e => e.id).sort() } : {}) });
    return { id: op.id, eventId: target, phrase, expires: op.expires, preview };
  }
  dismiss(id: string) {
    const op = this.operation(id);
    if (op.state === 'pending') { op.state = 'dismissed'; this.save(op); }
  }
  async confirm(id: string, phrase: string) {
    if (this.work) throw new CalendarError('CALENDAR_BUSY');
    const op = this.operation(id);
    if (op.state !== 'pending' || op.expires <= this.now() || !calendarConfirmed(phrase, op.phrase)) throw new CalendarError('CALENDAR_CONFIRMATION_REQUIRED');
    op.state = 'sending'; this.save(op); // Persist before network; restart never replays a write.
    this.work = (async () => {
      try {
        if (op.parentId) {
          const parent = await this.remote(op.parentId);
          if (parent.etag !== op.parentEtag) throw new CalendarError('CALENDAR_CHANGED_REVIEW_AGAIN', 412);
        }
        if (op.overlapIds) {
          const current = await this.overlaps(op.event, op.eventId);
          if (!current.complete || JSON.stringify(current.items.filter(e => e.id !== op.eventId).map(e => e.id).sort()) !== JSON.stringify(op.overlapIds)) {
            throw new CalendarError('CALENDAR_OVERLAPS_CHANGED_REVIEW_AGAIN', 412);
          }
        }
        let result: any;
        if (op.kind === 'create') {
          if (op.invitee && op.invitee !== this.allowedGuest) throw new CalendarError('CALENDAR_RECIPIENT_CHANGED', 400);
          result = await this.transport('POST', `/events?sendUpdates=${op.invitee ? 'all' : 'none'}`, { id: op.eventId, ...eventBody(op.event),
            ...(op.invitee ? { attendees: [{ email: op.invitee, responseStatus: 'needsAction' }], guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false } : {}),
            reminders: { useDefault: false }, extendedProperties: { private: { evenAssistant: '1' } } });
        } else if (op.kind === 'update') {
          const body = eventBody(op.event);
          if (op.parentId) delete body.recurrence;
          result = await this.transport('PATCH', `/events/${op.eventId}?sendUpdates=${op.notifyGuests ? 'all' : 'none'}`, body, op.etag);
        } else { await this.transport('DELETE', `/events/${op.eventId}?sendUpdates=${op.notifyGuests ? 'all' : 'none'}`, undefined, op.etag); }
        if (op.kind !== 'cancel' && result?.id !== op.eventId) throw new CalendarError('CALENDAR_RESPONSE_UNKNOWN');
        this.db.prepare('INSERT OR REPLACE INTO managed_events VALUES (?, ?)').run(op.eventId,
          JSON.stringify({ id: op.eventId, event: op.event, cancelled: op.kind === 'cancel', updated: new Date(this.now()).toISOString() }));
        op.state = 'succeeded';
      } catch (error) {
        // Even 409 can mean an earlier create succeeded. Never silently create a new ID.
        op.state = error instanceof CalendarError && error.status === 412 ? 'conflict'
          : error instanceof CalendarError && error.status >= 400 && error.status < 500 && error.status !== 409 ? 'failed' : 'unknown';
        op.error = calendarError(error);
      }
      return this.save(op);
    })();
    try { return await this.work; } finally { this.work = undefined; }
  }
  async close() { try { await this.work; } finally { this.db.close(); } }
}
