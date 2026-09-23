import type { DatabaseSync } from 'node:sqlite';

// SQL equivalent of guest-access isOwnerScope. No connection-local UDF:
// persisted triggers must also work for other SQLite connections.
const ownerPredicate = `typeof(s.owner_scope)='text'
  AND length(s.owner_scope) BETWEEN 1 AND 128
  AND length(CAST(s.owner_scope AS BLOB))=length(s.owner_scope)
  AND substr(s.owner_scope,1,1) GLOB '[A-Za-z0-9]'
  AND s.owner_scope NOT GLOB '*[^A-Za-z0-9:_-]*'
  AND lower(substr(s.owner_scope,1,6))<>'guest:'`;
const sourceView = `CREATE VIEW history_search_source AS
  SELECT m.rowid AS rowid,m.content AS content
  FROM messages m JOIN sessions s ON s.id=m.session_id
  WHERE m.status='committed' AND m.role IN ('user','assistant') AND ${ownerPredicate};`;

/** v14 repair for already-created v13 databases; caller owns transaction. */
export function repairHistoryScopeIndex(db: DatabaseSync): void {
  db.exec(`DROP VIEW history_search_source; ${sourceView}
    INSERT INTO history_search_fts(history_search_fts) VALUES('rebuild');
    INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1);`);
}

/** Index installation primitive for schema v13.
 * The store migration owns the transaction.
 * Source and rebuild share the same filtered view, so neither imports guests.
 * See https://www.sqlite.org/fts5.html#external_content_tables */
export function installHistoryIndex(db: DatabaseSync): void {
  db.exec(`
    ${sourceView}
    CREATE VIRTUAL TABLE history_search_fts USING fts5(
      content, content='history_search_source', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER history_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO history_search_fts(rowid,content)
        SELECT rowid,content FROM history_search_source WHERE rowid=NEW.rowid;
    END;
    CREATE TRIGGER history_message_delete BEFORE DELETE ON messages BEGIN
      INSERT INTO history_search_fts(history_search_fts,rowid,content)
        SELECT 'delete',rowid,content FROM history_search_source WHERE rowid=OLD.rowid;
    END;
    CREATE TRIGGER history_message_before_update BEFORE UPDATE ON messages BEGIN
      INSERT INTO history_search_fts(history_search_fts,rowid,content)
        SELECT 'delete',rowid,content FROM history_search_source WHERE rowid=OLD.rowid;
    END;
    CREATE TRIGGER history_message_after_update AFTER UPDATE ON messages BEGIN
      INSERT INTO history_search_fts(rowid,content)
        SELECT rowid,content FROM history_search_source WHERE rowid=NEW.rowid;
    END;
    -- Delete while the parent still exists. During the subsequent FK cascade,
    -- the filtered view sees no parent and child delete triggers do no work.
    CREATE TRIGGER history_session_delete BEFORE DELETE ON sessions BEGIN
      INSERT INTO history_search_fts(history_search_fts,rowid,content)
        SELECT 'delete',h.rowid,h.content FROM history_search_source h
        JOIN messages m ON m.rowid=h.rowid WHERE m.session_id=OLD.id;
    END;
    CREATE TRIGGER history_session_before_scope BEFORE UPDATE OF owner_scope ON sessions BEGIN
      INSERT INTO history_search_fts(history_search_fts,rowid,content)
        SELECT 'delete',h.rowid,h.content FROM history_search_source h
        JOIN messages m ON m.rowid=h.rowid WHERE m.session_id=OLD.id;
    END;
    CREATE TRIGGER history_session_after_scope AFTER UPDATE OF owner_scope ON sessions BEGIN
      INSERT INTO history_search_fts(rowid,content)
        SELECT h.rowid,h.content FROM history_search_source h
        JOIN messages m ON m.rowid=h.rowid WHERE m.session_id=NEW.id;
    END;
    INSERT INTO history_search_fts(rowid,content) SELECT rowid,content FROM history_search_source;
    INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1);
  `);
}
