import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { requireGuestAccess, type AccessPrincipal } from './guest-access.js';
import { MEMORY_LIMITS, parseMemoryProposal, validateMemorySource, snapshotMemoryFields } from './memory-policy.js';
import { suppressMemoryLineage } from './memory-forgetting.js';

/** Installed inside ConversationStore's migration transaction. No product
 * runtime uses this repository until explicit authorization AND suppression
 * across prior/summary/history are implemented. These are storage primitives. */
export function installMemoryStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE personal_memories (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    owner_scope TEXT NOT NULL, lineage_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fact','preference','date','contact_hint')),
    content TEXT NOT NULL, memory_key TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','superseded','forgotten')),
    source_session_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at>=0), retired_at INTEGER,
    superseded_by TEXT REFERENCES personal_memories(id) ON DELETE SET NULL,
    CHECK((state='active' AND retired_at IS NULL) OR (state!='active' AND retired_at IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX personal_memory_active_key ON personal_memories(owner_scope,memory_key)
    WHERE state='active' AND memory_key IS NOT NULL;
  CREATE INDEX personal_memory_list ON personal_memories(owner_scope,state,ordinal);
  CREATE INDEX personal_memory_cleanup ON personal_memories(owner_scope,retired_at);
  CREATE TABLE personal_memory_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_scope TEXT NOT NULL,
    source_session_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('save','update','forget')),
    lineage_id TEXT NOT NULL, subject_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(owner_scope,source_message_id)
  ) STRICT;`);
}

type SourceInput = { sessionId: string; messageId: string };
type Row = { ordinal: number; id: string; owner_scope: string; lineage_id: string;
  kind: string; content: string; memory_key: string | null; state: string;
  source_session_id: string; source_message_id: string; created_at: number;
  retired_at: number | null; superseded_by: string | null };
function invalid(): never { throw new Error('MEMORY_REQUEST_INVALID'); }
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function atomic<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function authority(principal: AccessPrincipal) {
  requireGuestAccess(principal, 'long_term_memory');
  return Object.freeze({ mode: 'owner' as const, ownerScope: principal.ownerScope });
}
function source(db: DatabaseSync, principal: AccessPrincipal, input: SourceInput, at: number) {
  id(input?.sessionId); id(input?.messageId);
  const row = db.prepare(`SELECT s.owner_scope AS ownerScope,s.id AS sessionId,m.id AS messageId,
    s.status AS sessionState,m.role,m.status,m.created_at AS createdAt
    FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.id=?`).get(input.messageId, input.sessionId) as any;
  if (!row || row.createdAt > at) throw new Error('MEMORY_SOURCE_UNAVAILABLE');
  validateMemorySource(principal, { ownerScope: row.ownerScope, sessionId: row.sessionId, messageId: row.messageId,
    role: row.role, status: row.status, sessionState: row.sessionState });
  // Only the latest committed user request can be the mutation's provenance.
  const latest = db.prepare(`SELECT id FROM messages WHERE session_id=? AND role='user' AND status='committed'
    ORDER BY sequence DESC LIMIT 1`).get(row.sessionId) as any;
  if (latest?.id !== row.messageId) throw new Error('MEMORY_SOURCE_STALE');
  if (db.prepare('SELECT 1 FROM personal_memory_changes WHERE owner_scope=? AND source_message_id=?')
    .get(principal.ownerScope, row.messageId)) throw new Error('MEMORY_SOURCE_USED');
  return { sessionId: row.sessionId as string, messageId: row.messageId as string };
}
function active(db: DatabaseSync, principal: AccessPrincipal, targetId: string) {
  id(targetId);
  const row = db.prepare("SELECT * FROM personal_memories WHERE id=? AND owner_scope=? AND state='active'")
    .get(targetId, principal.ownerScope) as Row | undefined;
  if (!row) throw new Error('MEMORY_TARGET_UNAVAILABLE');
  return row;
}
function view(principal: AccessPrincipal, row: Row) {
  const proposal = parseMemoryProposal(principal, { action: 'save', kind: row.kind, content: row.content,
    ...(row.memory_key === null ? {} : { key: row.memory_key }) });
  if (proposal.action !== 'save') invalid();
  return Object.freeze({ id: row.id, ordinal: row.ordinal, kind: proposal.kind, content: proposal.content,
    ...(proposal.key === undefined ? {} : { key: proposal.key }), sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id, createdAt: row.created_at });
}

/** source is supplied by the authenticated runtime, not by the model. A caller
 * must independently establish explicit user intent; storage does not parse NL.
 * At most one mutation per user message; retries fail SOURCE_USED, never duplicate.
 * Update/forget target is a resolved UUID, never a fuzzy match or a bulk selector. */
export function mutateMemory(db: DatabaseSync, principal: AccessPrincipal, input: {
  source: SourceInput; proposal: unknown; targetId?: string;
}, at: number) {
  const owner = authority(principal); integer(at);
  const request = snapshotMemoryFields(input);
  if (Object.keys(request).some(k => !['source', 'proposal', 'targetId'].includes(k))) invalid();
  const proposal = parseMemoryProposal(owner, request.proposal);
  if (!['save', 'update', 'forget'].includes(proposal.action)) invalid();
  if (proposal.action === 'save' ? request.targetId !== undefined : request.targetId === undefined) invalid();
  if (request.targetId !== undefined) id(request.targetId);
  // Snapshot runtime arguments before taking the transaction. Proposal text is
  // already copied/frozen by the pure validator.
  const originFields = snapshotMemoryFields(request.source);
  if (Object.keys(originFields).length !== 2 || !Object.hasOwn(originFields, 'sessionId') || !Object.hasOwn(originFields, 'messageId')) invalid();
  id(originFields.sessionId); id(originFields.messageId);
  const origin = { sessionId: originFields.sessionId, messageId: originFields.messageId }, targetId = request.targetId;
  return atomic(db, () => {
    const provenance = source(db, owner, origin, at);
    const old = targetId === undefined ? undefined : active(db, owner, targetId);
    // Clock correction must not block privacy operations. Preserve monotonic
    // lineage timestamps without relaxing the original source-time check.
    const effectiveAt = old ? Math.max(at, old.created_at) : at;
    const newId = proposal.action === 'forget' ? old!.id : randomUUID();
    const lineage = old?.lineage_id ?? newId;
    if (proposal.action === 'save' || proposal.action === 'update') {
      if (proposal.key !== undefined && db.prepare(`SELECT 1 FROM personal_memories
        WHERE owner_scope=? AND state='active' AND memory_key=? AND id!=?`)
        .get(owner.ownerScope, proposal.key, old?.id ?? '')) throw new Error('MEMORY_KEY_CONFLICT');
      if (old) db.prepare("UPDATE personal_memories SET state='superseded',retired_at=? WHERE id=?").run(effectiveAt, old.id);
      db.prepare(`INSERT INTO personal_memories(id,owner_scope,lineage_id,kind,content,memory_key,state,
        source_session_id,source_message_id,created_at) VALUES(?,?,?,?,?,?,'active',?,?,?)`)
        .run(newId, owner.ownerScope, lineage, proposal.kind, proposal.content, proposal.key ?? null,
          provenance.sessionId, provenance.messageId, effectiveAt);
      if (old) db.prepare('UPDATE personal_memories SET superseded_by=? WHERE id=?').run(newId, old.id);
    } else {
      db.prepare("UPDATE personal_memories SET state='forgotten',retired_at=? WHERE id=?").run(effectiveAt, old!.id);
      suppressMemoryLineage(db, owner.ownerScope, lineage, provenance.sessionId, effectiveAt);
    }
    db.prepare(`INSERT INTO personal_memory_changes(owner_scope,source_session_id,source_message_id,
      action,lineage_id,subject_id,created_at) VALUES(?,?,?,?,?,?,?)`).run(owner.ownerScope,
      provenance.sessionId, provenance.messageId, proposal.action, lineage, newId, effectiveAt);
    return Object.freeze({ id: newId, action: proposal.action });
  });
}

export function listMemories(db: DatabaseSync, principal: AccessPrincipal,
  input: { after?: number; through?: number; limit?: number } = {}) {
  const owner = authority(principal);
  const options = snapshotMemoryFields(input);
  if (Object.keys(options).some(k => !['after', 'through', 'limit'].includes(k))) invalid();
  const after = options.after === undefined ? 0 : options.after, limit = options.limit === undefined ? 30 : options.limit;
  integer(after); integer(limit, 1, 100);
  const through = options.through === undefined ? (db.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM personal_memories WHERE owner_scope=?')
    .get(owner.ownerScope) as any).n : options.through;
  integer(through); if (after > through) invalid();
  // Stable keyset/high-water pagination; concurrent removals may disappear,
  // but new insertions do not enter an in-progress listing or cause duplicates.
  const rows = db.prepare(`SELECT * FROM personal_memories WHERE owner_scope=? AND state='active'
    AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?`).all(owner.ownerScope, after, through, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  return { records: page.map(row => view(owner, row)),
    next: rows.length > limit ? { after: page.at(-1)!.ordinal, through } : undefined };
}

export function purgeRetiredMemories(db: DatabaseSync, principal: AccessPrincipal, at: number, limit = 100) {
  const owner = authority(principal); integer(at); integer(limit, 1, 1000);
  return atomic(db, () => {
    const cutoff = at - MEMORY_LIMITS.softDeleteDays * 86400000;
    return Number(db.prepare(`DELETE FROM personal_memories WHERE ordinal IN (
      SELECT ordinal FROM personal_memories WHERE owner_scope=? AND state!='active' AND retired_at<=?
      ORDER BY retired_at,ordinal LIMIT ?)`).run(owner.ownerScope, cutoff, limit).changes);
  });
}
