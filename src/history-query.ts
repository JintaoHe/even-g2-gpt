import { requireGuestAccess, type AccessPrincipal } from './guest-access.js';

/** Pure preparation only: callers must still bind SQL parameters, constrain
 * owner_scope and committed status, and bound query execution in the store. */
export const HISTORY_QUERY_LIMITS = Object.freeze({
  windowMs: 90 * 24 * 60 * 60_000, queryCodePoints: 256,
  hits: 10, neighbours: 3, sessionGroups: 3, contextCharacters: 2000,
});
export type HistorySearchInput = {
  query: string; sinceMs?: number; limit?: number;
};
export type PreparedHistoryQuery = Readonly<{
  ownerScope: string; query: string; sinceMs: number; untilMs: number; limit: number;
  kind: 'like' | 'fts'; parameter: string;
}>;

function invalid(): never { throw new Error('HISTORY_QUERY_INVALID'); }
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function wellFormed(text: string): boolean {
  // for-of walks code points; any remaining surrogate is unpaired.
  for (const point of text) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

export function prepareHistoryQuery(principal: AccessPrincipal, input: HistorySearchInput, now: number): PreparedHistoryQuery {
  requireGuestAccess(principal, 'history_search');
  if (!time(now) || !input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.query !== 'string' || input.query.length > HISTORY_QUERY_LIMITS.queryCodePoints * 2) invalid();
  const query = input.query.trim();
  if (!query || !wellFormed(query) || /[\u0000-\u001f\u007f]/u.test(query)
    || Array.from(query).length > HISTORY_QUERY_LIMITS.queryCodePoints) invalid();
  const earliest = Math.max(0, now - HISTORY_QUERY_LIMITS.windowMs);
  const sinceMs = input.sinceMs === undefined ? earliest : input.sinceMs;
  const limit = input.limit === undefined ? HISTORY_QUERY_LIMITS.hits : input.limit;
  if (!time(sinceMs) || sinceMs < earliest || sinceMs > now
    || !Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_QUERY_LIMITS.hits) invalid();
  const kind = Array.from(query).length < 3 ? 'like' : 'fts';
  // LIKE consumers use ESCAPE '\'. FTS operators stay inside one quoted
  // phrase. Neither representation may be interpolated into SQL text.
  const parameter = kind === 'like' ? `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`
    : `"${query.replace(/"/g, '""')}"`;
  return Object.freeze({ ownerScope: principal.ownerScope, query, sinceMs, untilMs: now, limit, kind, parameter });
}

export function prepareHistoryContext(principal: AccessPrincipal,
  input: { messageId: string; before?: number; after?: number }): Readonly<{ ownerScope: string; messageId: string; before: number; after: number }> {
  requireGuestAccess(principal, 'history_search');
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.messageId !== 'string'
    || input.messageId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.messageId)) invalid();
  const before = input.before === undefined ? HISTORY_QUERY_LIMITS.neighbours : input.before;
  const after = input.after === undefined ? HISTORY_QUERY_LIMITS.neighbours : input.after;
  if (![before, after].every(value => Number.isSafeInteger(value) && value >= 0 && value <= HISTORY_QUERY_LIMITS.neighbours)) invalid();
  // This validates a request, not message ownership. The store must look up
  // messageId under this ownerScope before returning any neighbours.
  return Object.freeze({ ownerScope: principal.ownerScope, messageId: input.messageId, before, after });
}
