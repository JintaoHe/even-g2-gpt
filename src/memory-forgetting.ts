import type { DatabaseSync } from 'node:sqlite';
import { repairHistoryScopeIndex } from './history-index.js';

/** Session-granular suppression deliberately sacrifices unrelated recall from
 * linked sources rather than pretending to recognize all semantic paraphrases.
 * No memory content, key, query, hash of content or confirmation text is stored. */
export function installMemoryForgetting(db: DatabaseSync) {
  db.exec(`CREATE TABLE memory_forget_sources (
    owner_scope TEXT NOT NULL, session_id TEXT NOT NULL, lineage_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    through_sequence INTEGER NOT NULL CHECK(through_sequence>=0),
    PRIMARY KEY(owner_scope,session_id,lineage_id)
  ) STRICT;
  CREATE INDEX memory_forget_session ON memory_forget_sources(session_id,through_sequence);
  CREATE TRIGGER memory_forget_before_insert BEFORE INSERT ON memory_forget_sources BEGIN
    SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM memory_forget_sources
      WHERE owner_scope=NEW.owner_scope AND session_id=NEW.session_id AND lineage_id=NEW.lineage_id);
    INSERT INTO history_search_fts(history_search_fts,rowid,content)
      SELECT 'delete',h.rowid,h.content FROM history_search_source h
      JOIN messages m ON m.rowid=h.rowid JOIN sessions s ON s.id=m.session_id
      WHERE s.id=NEW.session_id;
  END;
  CREATE TRIGGER memory_forget_after_insert AFTER INSERT ON memory_forget_sources BEGIN
    DELETE FROM session_summaries WHERE session_id IN (
      SELECT id FROM sessions WHERE id=NEW.session_id);
    UPDATE summary_jobs SET status='failed',error_code='SUMMARY_FORGOTTEN',updated_at=MAX(updated_at,NEW.created_at)
      WHERE status!='completed' AND session_id IN (
        SELECT id FROM sessions WHERE id=NEW.session_id);
    UPDATE personal_memories SET state='forgotten',retired_at=MAX(created_at,NEW.created_at)
      WHERE owner_scope=NEW.owner_scope AND lineage_id=NEW.lineage_id AND state='active';
  END;
  CREATE TRIGGER memory_forget_no_update BEFORE UPDATE ON memory_forget_sources BEGIN
    SELECT RAISE(ABORT,'FORGET_MARKER_IMMUTABLE'); END;
  CREATE TRIGGER memory_forget_no_delete BEFORE DELETE ON memory_forget_sources BEGIN
    SELECT RAISE(ABORT,'FORGET_MARKER_IMMUTABLE'); END;`);
  repairHistoryScopeIndex(db, true);
  // v15 may already contain retired lineages. Derive markers from durable
  // identifier-only provenance, including versions already physically purged.
  db.exec(`INSERT OR IGNORE INTO memory_forget_sources(owner_scope,session_id,lineage_id,created_at,through_sequence)
    SELECT c.owner_scope,c.source_session_id,c.lineage_id,MAX(f.created_at),
      COALESCE((SELECT latest_sequence FROM sessions WHERE id=c.source_session_id),0)
    FROM personal_memory_changes c JOIN personal_memory_changes f
      ON f.owner_scope=c.owner_scope AND f.lineage_id=c.lineage_id AND f.action='forget'
    GROUP BY c.owner_scope,c.source_session_id,c.lineage_id;`);
}

export function sessionIsForgotten(db: DatabaseSync, sessionId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM memory_forget_sources WHERE session_id=? LIMIT 1`).get(sessionId);
}

/** Shared SQL for every range gate. NULL means no safe post-forget user turn yet.
 * Identifiers passed here are internal SQL expressions, never user input. */
export function summaryFloorSql(session: string): string {
  return `(CASE WHEN EXISTS (SELECT 1 FROM memory_forget_sources f WHERE f.session_id=${session})
    THEN (SELECT MIN(m.sequence) FROM messages m WHERE m.session_id=${session}
      AND m.status='committed' AND m.role='user' AND m.sequence>
        (SELECT MAX(f.through_sequence) FROM memory_forget_sources f WHERE f.session_id=${session}))
    ELSE 1 END)`;
}

/** Caller owns the mutation transaction. Includes save/update/forget provenance,
 * even when old versions or original messages have already been retained away. */
export function suppressMemoryLineage(db: DatabaseSync, ownerScope: string, lineage: string,
  currentSessionId: string, at: number) {
  const sessions = db.prepare(`SELECT source_session_id AS id FROM personal_memory_changes
    WHERE owner_scope=? AND lineage_id=? UNION SELECT ? AS id`).all(ownerScope, lineage, currentSessionId) as { id: string }[];
  // BEFORE INSERT ignores duplicate keys even under REPLACE. This protects SQL
  // mistakes, not a writer able to DROP the table or its protection triggers.
  const insert = db.prepare(`INSERT OR IGNORE INTO memory_forget_sources(owner_scope,session_id,lineage_id,created_at,through_sequence)
    VALUES(?,?,?,?,COALESCE((SELECT latest_sequence FROM sessions WHERE id=?),0))`);
  for (const { id } of sessions) insert.run(ownerScope, id, lineage, at, id);
}
