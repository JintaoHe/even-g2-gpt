/** Test-only downgrade of disposable fixtures, never a deployment rollback. */
export const DROP_HISTORY_INDEX_SQL = `
DROP TRIGGER IF EXISTS history_message_insert;
DROP TRIGGER IF EXISTS history_message_delete;
DROP TRIGGER IF EXISTS history_message_before_update;
DROP TRIGGER IF EXISTS history_message_after_update;
DROP TRIGGER IF EXISTS history_session_delete;
DROP TRIGGER IF EXISTS history_session_before_scope;
DROP TRIGGER IF EXISTS history_session_after_scope;
DROP TABLE IF EXISTS history_search_fts;
DROP VIEW IF EXISTS history_search_source;
DROP INDEX IF EXISTS messages_history_time_idx;
DROP INDEX IF EXISTS sessions_history_owner_idx;
DELETE FROM schema_migrations WHERE version=13;
`;
