import type { DatabaseSync } from 'node:sqlite';

/** Index installation primitive for the future versioned store migration.
 * Not called on service startup yet. The migration MUST own the transaction.
 * Source and rebuild share the same filtered view, so neither imports guests.
 * See https://www.sqlite.org/fts5.html#external_content_tables */
export function installHistoryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE VIEW history_search_source AS
      SELECT m.rowid AS rowid,m.content AS content
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.status='committed' AND m.role IN ('user','assistant')
        AND lower(trim(s.owner_scope)) NOT GLOB 'guest*:*';
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
