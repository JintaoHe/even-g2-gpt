import type { DatabaseSync } from 'node:sqlite';
import { requireGuestAccess, type AccessPrincipal } from './guest-access.js';
import { prepareHistoryQuery, prepareHistoryContext, HISTORY_QUERY_LIMITS, type HistorySearchInput } from './history-query.js';

export const HISTORY_SCAN_LIMITS = Object.freeze({ candidates: 2000, contentBytes: 4 * 1024 * 1024, excerptCodePoints: 1200 });
export type HistoryMessage = { messageId: string; sessionId: string; sequence: number;
  role: 'user' | 'assistant'; createdAt: number; content: string; truncated: boolean };
const fields = `m.id AS messageId,m.session_id AS sessionId,m.sequence,m.role,m.created_at AS createdAt,
  substr(m.content,1,1200) AS content,length(m.content)>1200 AS truncated`;
const map = (row: any): HistoryMessage => ({ ...row, truncated: !!row.truncated });

/** Bounded candidate search, not an exhaustive history oracle. Incomplete must
 * propagate to the caller: absence in a capped scan is not evidence of absence.
 * Caps bound application row/content work, not SQLite VM time; benchmark before
 * enabling on the model path. No query text or message content is logged. */
export function searchStoredMessages(db: DatabaseSync, principal: AccessPrincipal, input: HistorySearchInput, now: number) {
  const q = prepareHistoryQuery(principal, input, now);
  const candidates = db.prepare(`SELECT m.rowid AS rowid,length(CAST(m.content AS BLOB)) AS bytes,m.session_id AS sessionId
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.owner_scope=? AND m.status='committed' AND m.role IN ('user','assistant')
      AND m.created_at>=? AND m.created_at<=? ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
    .all(q.ownerScope, q.sinceMs, q.untilMs, HISTORY_SCAN_LIMITS.candidates + 1) as any[];
  const match = q.kind === 'fts'
    ? db.prepare('SELECT rowid FROM history_search_fts WHERE rowid=CAST(? AS INTEGER) AND history_search_fts MATCH ?')
    : db.prepare("SELECT rowid FROM messages WHERE rowid=? AND content LIKE ? ESCAPE '\\'");
  const read = db.prepare(`SELECT ${fields} FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE m.rowid=? AND s.owner_scope=? AND m.status='committed' AND m.role IN ('user','assistant')`);
  const messages: HistoryMessage[] = [], groups = new Set<string>();
  let scanned = 0, bytes = 0, incomplete = false;
  for (const candidate of candidates) {
    if (scanned >= HISTORY_SCAN_LIMITS.candidates || bytes + candidate.bytes > HISTORY_SCAN_LIMITS.contentBytes
      || messages.length >= q.limit) { incomplete = true; break; }
    scanned++; bytes += candidate.bytes;
    const matched = match.get(candidate.rowid, q.parameter) as { rowid: number } | undefined;
    if (!matched || matched.rowid !== candidate.rowid) continue;
    if (!groups.has(candidate.sessionId) && groups.size >= HISTORY_QUERY_LIMITS.sessionGroups) { incomplete = true; continue; }
    const row = read.get(candidate.rowid, q.ownerScope);
    if (row) { messages.push(map(row)); groups.add(candidate.sessionId); }
  }
  return { messages, incomplete, scanned, scannedBytes: bytes };
}

export function storedMessageContext(db: DatabaseSync, principal: AccessPrincipal,
  input: { messageId: string; before?: number; after?: number }, now: number): HistoryMessage[] {
  const q = prepareHistoryContext(principal, input);
  const window = prepareHistoryQuery(principal, { query: 'context' }, now);
  const anchor = db.prepare(`SELECT m.session_id AS sessionId,m.sequence,s.owner_scope AS ownerScope
    FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.owner_scope=?
      AND m.status='committed' AND m.role IN ('user','assistant') AND m.created_at>=? AND m.created_at<=?`)
    .get(q.messageId, q.ownerScope, window.sinceMs, window.untilMs) as any;
  if (!anchor) throw Error('HISTORY_MESSAGE_UNAVAILABLE');
  requireGuestAccess(principal, 'history_search', { ownerScope: anchor.ownerScope, sessionId: anchor.sessionId });
  const base = `SELECT ${fields} FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE m.session_id=? AND s.owner_scope=? AND m.status='committed' AND m.role IN ('user','assistant')
      AND m.created_at>=? AND m.created_at<=? AND m.sequence`;
  const params = [anchor.sessionId, q.ownerScope, window.sinceMs, window.untilMs];
  const before = db.prepare(base + '<? ORDER BY m.sequence DESC LIMIT ?').all(...params, anchor.sequence, q.before).reverse();
  const after = db.prepare(base + '>=? ORDER BY m.sequence ASC LIMIT ?').all(...params, anchor.sequence, q.after + 1);
  return [...before, ...after].map(map);
}
