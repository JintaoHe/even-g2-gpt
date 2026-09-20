import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCTION_CHECK_ROOT = '/var/backups/even-agent/.restore-check';
const REQUIRED_CONVERSATION_TABLES = ['schema_migrations', 'service_owner', 'sessions', 'topics', 'turns', 'messages',
  'session_summaries', 'summary_jobs', 'legacy_session_imports'];

function scalar(database, query, field) {
  const row = database.prepare(query).get();
  return Number(row?.[field] ?? 0);
}

function verifySqlite(database, label) {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (!integrity.length || integrity.some(row => String(row.integrity_check) !== 'ok')) {
    throw new Error(`${label} SQLite integrity check failed`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error(`${label} SQLite foreign key check failed`);
}

function verifyReleasedOwner(database, label) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  if (tables.has('service_owner') && scalar(database, 'SELECT COUNT(*) AS count FROM service_owner', 'count') !== 0) {
    throw new Error(`${label} was backed up before the service released ownership`);
  }
}

function verifyConversation(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  for (const table of REQUIRED_CONVERSATION_TABLES) {
    if (!tables.has(table)) throw new Error(`Conversation database is missing required table ${table}`);
  }
  verifyReleasedOwner(database, 'Conversation database');
  const crossSession = database.prepare(`SELECT 1 FROM messages m JOIN turns t ON t.id=m.turn_id
    WHERE m.session_id<>t.session_id LIMIT 1`).get()
    || database.prepare(`SELECT 1 FROM turns t JOIN messages m ON m.id=t.input_message_id
      WHERE t.session_id<>m.session_id LIMIT 1`).get()
    || database.prepare(`SELECT 1 FROM turns t JOIN messages m ON m.id=t.output_message_id
      WHERE t.session_id<>m.session_id LIMIT 1`).get();
  if (crossSession) throw new Error('Conversation message and turn references cross session boundaries');
  const sequenceMismatch = database.prepare(`SELECT 1 FROM sessions s LEFT JOIN
    (SELECT session_id,MAX(sequence) AS latest FROM messages GROUP BY session_id) m ON m.session_id=s.id
    WHERE s.latest_sequence<>COALESCE(m.latest,0) LIMIT 1`).get();
  if (sequenceMismatch) throw new Error('Conversation latest sequence metadata is inconsistent');
  const summaryMismatch = database.prepare(`SELECT 1 FROM sessions s
    WHERE s.summary_through_sequence>s.latest_sequence OR s.summary_through_sequence<0 LIMIT 1`).get();
  if (summaryMismatch) throw new Error('Conversation summary sequence metadata is inconsistent');

  const latest = database.prepare(`SELECT id,latest_sequence,summary_through_sequence FROM sessions
    ORDER BY updated_at DESC,id DESC LIMIT 1`).get();
  if (latest) {
    const latestCommitted = database.prepare(`SELECT id,sequence,role,status,content FROM messages
      WHERE session_id=? AND status='committed' ORDER BY sequence DESC LIMIT 1`).get(latest.id);
    if (latestCommitted && (typeof latestCommitted.content !== 'string' || !latestCommitted.content.trim())) {
      throw new Error('Latest committed conversation message is unreadable');
    }
    const summary = database.prepare(`SELECT through_sequence,summary_json FROM session_summaries
      WHERE session_id=? ORDER BY through_sequence DESC LIMIT 1`).get(latest.id);
    if (summary) {
      let parsed;
      try { parsed = JSON.parse(summary.summary_json); }
      catch { throw new Error('Latest conversation summary is unreadable'); }
      if (!parsed || parsed.throughSequence !== summary.through_sequence
        || summary.through_sequence > latest.latest_sequence) {
        throw new Error('Latest conversation summary sequence is inconsistent');
      }
    }
  }
  return {
    sessions: scalar(database, 'SELECT COUNT(*) AS count FROM sessions', 'count'),
    messages: scalar(database, 'SELECT COUNT(*) AS count FROM messages', 'count'),
    latestSequence: Number(latest?.latest_sequence ?? 0),
    summaryThroughSequence: Number(latest?.summary_through_sequence ?? 0),
  };
}

export async function verifyBackupRoot(rootInput, options = {}) {
  const root = resolve(rootInput ?? '');
  const expectedRoot = resolve(options.expectedRoot ?? PRODUCTION_CHECK_ROOT);
  if (root !== expectedRoot) throw new Error('Unexpected restore-check directory');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Backup root is unsafe');

  let databases = 0, jsonFiles = 0, foundJobs = false, foundConversation = false, foundCalendar = false;
  let foundOAuthClient = false, foundCalendarAuth = false;
  let conversation = { sessions: 0, messages: 0, latestSequence: 0, summaryThroughSequence: 0 };
  const files = new Set();
  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error('Backup contains a symbolic link');
      if (metadata.isDirectory()) { await inspect(path); continue; }
      if (!metadata.isFile()) throw new Error('Backup contains an unsupported filesystem entry');
      files.add(path);
      if (path.endsWith('.json')) {
        if (metadata.size > 16 * 1024 * 1024) throw new Error('JSON file is unexpectedly large');
        JSON.parse(await readFile(path, 'utf8'));
        jsonFiles++;
        if (path === join(root, 'google-oauth-client.json')) foundOAuthClient = true;
        if (path === join(root, 'google-calendar-auth.json')) foundCalendarAuth = true;
      }
      if (path.endsWith('.sqlite')) {
        const database = new DatabaseSync(path, { readOnly: true });
        try {
          verifySqlite(database, basename(path));
          if (path === join(root, 'assistant-memory.sqlite')) {
            conversation = verifyConversation(database);
            foundConversation = true;
          }
          if (path === join(root, 'jobs.sqlite')) verifyReleasedOwner(database, 'Jobs database');
          if (path === join(root, 'google-calendar.sqlite')) foundCalendar = true;
        } finally { database.close(); }
        databases++;
        if (path === join(root, 'jobs.sqlite')) foundJobs = true;
      }
    }
  }
  await inspect(root);
  for (const path of files) {
    if (path.endsWith('.sqlite-wal') && !files.has(path.slice(0, -4))) {
      throw new Error('Backup contains an orphaned SQLite WAL file');
    }
  }
  if (!foundJobs) throw new Error('Required jobs.sqlite is missing');
  if (!foundConversation) throw new Error('Required assistant-memory.sqlite is missing');
  if (options.calendarEnabled && (!foundCalendar || !foundOAuthClient || !foundCalendarAuth)) {
    throw new Error('Calendar-enabled backup is missing its ledger or OAuth files');
  }
  return { databases, jsonFiles, foundJobs, foundConversation, foundCalendar, foundOAuthClient, foundCalendarAuth, conversation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await verifyBackupRoot(process.argv[2], { calendarEnabled: process.env.GOOGLE_CALENDAR_ENABLED === 'true' });
  console.log(`Backup restore drill passed: ${report.databases} SQLite database(s), ${report.jsonFiles} JSON file(s), ${report.conversation.sessions} conversation session(s), ${report.conversation.messages} message(s).`);
}
