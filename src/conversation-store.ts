import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATABASE_NAME = 'assistant-memory.sqlite';
const SCHEMA_VERSION = 1;
const MAX_RESUME_CREDENTIAL_MS = 16 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConversationStoreHealth = {
  journalMode: string;
  synchronous: number;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  schemaVersion: number;
};

export type SessionRecord = {
  id: string;
  ownerScope: string;
  status: 'active' | 'idle' | 'ended' | 'expired';
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  endReason?: string;
  latestSequence: number;
  summaryThroughSequence: number;
};

export type TopicRecord = {
  id: string;
  sessionId: string;
  label: string;
  status: 'active' | 'paused' | 'completed';
  createdAt: number;
  updatedAt: number;
};

export type ResumeCredential = {
  id: string;
  clientId: string;
  sessionId: string;
  secret: string;
  createdAt: number;
  expiresAt: number;
};

export type CreateSession = {
  id: string;
  ownerScope: string;
  createdAt: number;
  initialTopic?: { id: string; label: string };
};

export type CommitUserTurn = {
  sessionId: string;
  topicId: string;
  messageId: string;
  turnId: string;
  content: string;
  createdAt: number;
  cognitiveMode?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  retryOfTurnId?: string;
};

export type CommitAcknowledgement = {
  result: 'committed' | 'duplicate';
  sessionId: string;
  messageId: string;
  turnId: string;
  sequence: number;
};

export type StartAssistantAnswer = {
  sessionId: string;
  topicId: string;
  turnId: string;
  messageId: string;
  createdAt: number;
};

export type AnswerAcknowledgement = {
  result: 'started' | 'committed' | 'interrupted' | 'duplicate';
  sessionId: string;
  messageId: string;
  turnId: string;
  sequence: number;
};

export type StoredMessage = {
  id: string;
  sessionId: string;
  turnId?: string;
  topicId?: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  status: 'committed' | 'streaming' | 'interrupted' | 'failed';
  content: string;
  citations?: unknown[];
  createdAt: number;
  updatedAt: number;
};

export type StoredTurn = {
  id: string;
  sessionId: string;
  topicId?: string;
  inputMessageId?: string;
  outputMessageId?: string;
  retryOfTurnId?: string;
  status: 'accepted' | 'planning' | 'answering' | 'committed' | 'interrupted' | 'failed';
  cognitiveMode?: string;
  reasoningEffort?: string;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
};

export type RecoverableTurn = {
  turn: StoredTurn;
  input: StoredMessage;
  output?: StoredMessage;
};

export class ConversationStoreConflictError extends Error {
  readonly code = 'MESSAGE_ID_CONFLICT';
  constructor() { super('Conversation message id conflicts with an existing message'); this.name = 'ConversationStoreConflictError'; }
}

export class ResumeCredentialError extends Error {
  readonly code = 'RESUME_CREDENTIAL_INVALID';
  constructor() { super('Resume credential is invalid or expired'); this.name = 'ResumeCredentialError'; }
}

function processIsAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means a process exists but the current account cannot signal it.
    return true;
  }
}

function validUuid(value: string) { return UUID.test(value); }

function credentialHash(secret: string) { return createHash('sha256').update(secret).digest('hex'); }

function safeHashEqual(left: string, right: string) {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function newCredentialSecret() {
  const id = randomUUID();
  return { id, secret: `${id}.${randomBytes(32).toString('base64url')}` };
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function sessionRecord(row: any): SessionRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.end_reason === null ? {} : { endReason: row.end_reason }),
    latestSequence: row.latest_sequence,
    summaryThroughSequence: row.summary_through_sequence,
  };
}

function messageRecord(row: any): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
    sequence: row.sequence,
    role: row.role,
    status: row.status,
    content: row.content,
    ...(row.citations_json === null ? {} : { citations: JSON.parse(row.citations_json) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function topicRecord(row: any): TopicRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnRecord(row: any): StoredTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
    ...(row.input_message_id === null ? {} : { inputMessageId: row.input_message_id }),
    ...(row.output_message_id === null ? {} : { outputMessageId: row.output_message_id }),
    ...(row.retry_of_turn_id === null ? {} : { retryOfTurnId: row.retry_of_turn_id }),
    status: row.status,
    ...(row.cognitive_mode === null ? {} : { cognitiveMode: row.cognitive_mode }),
    ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

/** Single-host, single-process durable conversation storage. It stores no API
 * credentials, raw audio, precise location, or Calendar/Email approval token. */
export class ConversationStore {
  private closed = false;

  private constructor(private db: DatabaseSync, private ownerToken: string) {}

  static async create(directory: string) {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Conversation data root cannot be a symlink');
    await chmod(root, 0o700);

    const path = join(root, DATABASE_NAME);
    const existing = await lstat(path).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('Conversation database cannot be a symlink');

    const db = new DatabaseSync(path);
    const ownerToken = randomUUID();
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      ConversationStore.migrate(db);
      ConversationStore.claim(db, ownerToken);
      ConversationStore.recoverInterrupted(db, Date.now());
      await chmod(path, 0o600);
      return new ConversationStore(db, ownerToken);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private static migrate(db: DatabaseSync) {
    transaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;`);
      const latest = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0;
      if (latest > SCHEMA_VERSION) throw new Error('Conversation database schema is newer than this service');
      if (latest < 1) {
        db.exec(`
          CREATE TABLE service_owner (
            id INTEGER PRIMARY KEY CHECK(id=1),
            token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            host TEXT NOT NULL
          ) STRICT;
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            owner_scope TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','idle','ended','expired')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            ended_at INTEGER,
            end_reason TEXT,
            latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK(latest_sequence>=0),
            summary_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK(summary_through_sequence>=0)
          ) STRICT;
          CREATE TABLE clients (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            label TEXT
          ) STRICT;
          CREATE TABLE resume_credentials (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            secret_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER
          ) STRICT;
          CREATE TABLE topics (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','paused','completed')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
            input_message_id TEXT,
            output_message_id TEXT,
            retry_of_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
            status TEXT NOT NULL CHECK(status IN ('accepted','planning','answering','committed','interrupted','failed')),
            cognitive_mode TEXT,
            reasoning_effort TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            error_code TEXT
          ) STRICT;
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
            topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
            sequence INTEGER NOT NULL CHECK(sequence>=1),
            role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
            status TEXT NOT NULL CHECK(status IN ('committed','streaming','interrupted','failed')),
            content TEXT NOT NULL,
            citations_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(session_id,sequence)
          ) STRICT;
          CREATE TABLE session_summaries (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            through_sequence INTEGER NOT NULL CHECK(through_sequence>=1),
            summary_json TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id,through_sequence)
          ) STRICT;
          CREATE INDEX topics_session_idx ON topics(session_id,updated_at);
          CREATE INDEX turns_session_idx ON turns(session_id,created_at);
          CREATE INDEX messages_session_sequence_idx ON messages(session_id,sequence);
          CREATE INDEX resume_credentials_session_idx ON resume_credentials(session_id,expires_at);
          CREATE INDEX summaries_session_sequence_idx ON session_summaries(session_id,through_sequence);
        `);
        db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (1,?,?)')
          .run('conversation-foundation', Date.now());
      }
    });
  }

  private static claim(db: DatabaseSync, ownerToken: string) {
    transaction(db, () => {
      const previous = db.prepare('SELECT token,pid,host FROM service_owner WHERE id=1').get() as
        { token: string; pid: number; host: string } | undefined;
      if (previous) {
        if (previous.host !== hostname()) throw new Error('Conversation database belongs to another host');
        if (processIsAlive(previous.pid)) throw new Error('Conversation database is already owned by a live service');
      }
      db.prepare('INSERT OR REPLACE INTO service_owner(id,token,pid,host) VALUES (1,?,?,?)')
        .run(ownerToken, process.pid, hostname());
    });
  }

  private static recoverInterrupted(db: DatabaseSync, now: number) {
    transaction(db, () => {
      db.prepare(`UPDATE messages SET status='interrupted',updated_at=MAX(updated_at,?)
        WHERE status='streaming'`).run(now);
      db.prepare(`UPDATE turns SET status='interrupted',error_code=COALESCE(error_code,'SERVICE_RESTARTED'),
        updated_at=MAX(updated_at,?) WHERE status IN ('accepted','planning','answering')`).run(now);
      db.prepare(`UPDATE sessions SET status='idle',updated_at=MAX(updated_at,?) WHERE status='active'`).run(now);
    });
  }

  private ensureOpen() {
    if (this.closed) throw new Error('Conversation store is closed');
  }

  health(): ConversationStoreHealth {
    this.ensureOpen();
    const journalMode = (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    const synchronous = (this.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
    const foreignKeys = (this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    const busyTimeoutMs = (this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    const schemaVersion = (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
    return { journalMode, synchronous, foreignKeys, busyTimeoutMs, schemaVersion };
  }

  createSession(input: CreateSession): SessionRecord {
    this.ensureOpen();
    if (!validUuid(input.id) || !input.ownerScope || input.ownerScope.length > 128 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
      throw new Error('Invalid conversation session');
    }
    const topic = input.initialTopic && {
      id: input.initialTopic.id,
      label: input.initialTopic.label.trim(),
    };
    if (topic && (!validUuid(topic.id) || !topic.label || topic.label.length > 80)) throw new Error('Invalid conversation topic');

    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO sessions(id,owner_scope,status,created_at,updated_at,last_activity_at)
        VALUES (?,?,'active',?,?,?)`).run(input.id, input.ownerScope, input.createdAt, input.createdAt, input.createdAt);
      if (topic) this.db.prepare(`INSERT INTO topics(id,session_id,label,status,created_at,updated_at)
        VALUES (?,?,?,'active',?,?)`).run(topic.id, input.id, topic.label, input.createdAt, input.createdAt);
    });
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | undefined {
    this.ensureOpen();
    if (!validUuid(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row ? sessionRecord(row) : undefined;
  }

  ensureTopic(input: { sessionId: string; id: string; label: string; at: number }): TopicRecord {
    this.ensureOpen();
    const label = input.label.trim();
    if (!validUuid(input.sessionId) || !validUuid(input.id) || !label || label.length > 80
      || !Number.isSafeInteger(input.at) || input.at < 0) throw new Error('Invalid conversation topic');
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM topics WHERE id=?').get(input.id) as any;
      if (existing) {
        if (existing.session_id !== input.sessionId || existing.label !== label) throw new ConversationStoreConflictError();
        this.db.prepare('UPDATE topics SET updated_at=MAX(updated_at,?) WHERE id=?').run(input.at, input.id);
      } else {
        const session = this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND status IN ('active','idle')")
          .get(input.sessionId);
        if (!session) throw new Error('Conversation session is unavailable');
        this.db.prepare(`INSERT INTO topics(id,session_id,label,status,created_at,updated_at)
          VALUES (?,?,?,'active',?,?)`).run(input.id, input.sessionId, label, input.at, input.at);
      }
      return topicRecord(this.db.prepare('SELECT * FROM topics WHERE id=?').get(input.id));
    });
  }

  listTopics(sessionId: string): TopicRecord[] {
    this.ensureOpen();
    if (!validUuid(sessionId)) throw new Error('Invalid conversation session');
    return (this.db.prepare('SELECT * FROM topics WHERE session_id=? ORDER BY created_at,id')
      .all(sessionId) as any[]).map(topicRecord);
  }

  registerClient(input: { id: string; at: number; label?: string }): void {
    this.ensureOpen();
    const label = input.label?.trim();
    if (!validUuid(input.id) || !Number.isSafeInteger(input.at) || input.at < 0
      || (input.label !== undefined && (!label || label.length > 80))) throw new Error('Invalid conversation client');
    this.db.prepare(`INSERT INTO clients(id,created_at,last_seen_at,label) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at=MAX(last_seen_at,excluded.last_seen_at),
      label=COALESCE(clients.label,excluded.label)`).run(input.id, input.at, input.at, label ?? null);
  }

  issueResumeCredential(input: {
    clientId: string; sessionId: string; createdAt: number; expiresAt: number;
  }): ResumeCredential {
    this.ensureOpen();
    this.validateCredentialTimes(input.createdAt, input.expiresAt);
    if (!validUuid(input.clientId) || !validUuid(input.sessionId)) throw new ResumeCredentialError();
    const generated = newCredentialSecret();
    return transaction(this.db, () => {
      const client = this.db.prepare('SELECT 1 FROM clients WHERE id=?').get(input.clientId);
      const session = this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND status IN ('active','idle')")
        .get(input.sessionId);
      if (!client || !session) throw new ResumeCredentialError();
      this.db.prepare('DELETE FROM resume_credentials WHERE expires_at<=?').run(input.createdAt);
      this.db.prepare(`INSERT INTO resume_credentials(id,client_id,session_id,secret_hash,created_at,expires_at)
        VALUES (?,?,?,?,?,?)`).run(generated.id, input.clientId, input.sessionId, credentialHash(generated.secret),
        input.createdAt, input.expiresAt);
      this.db.prepare('UPDATE clients SET last_seen_at=MAX(last_seen_at,?) WHERE id=?').run(input.createdAt, input.clientId);
      return { ...generated, clientId: input.clientId, sessionId: input.sessionId,
        createdAt: input.createdAt, expiresAt: input.expiresAt };
    });
  }

  rotateResumeCredential(input: {
    secret: string; clientId: string; sessionId: string; at: number; expiresAt: number;
  }): ResumeCredential {
    this.ensureOpen();
    this.validateCredentialTimes(input.at, input.expiresAt);
    if (!validUuid(input.clientId) || !validUuid(input.sessionId)) throw new ResumeCredentialError();
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(input.secret);
    if (!match || !validUuid(match[1])) throw new ResumeCredentialError();
    const generated = newCredentialSecret();
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT r.*,s.status AS session_status FROM resume_credentials r
        JOIN sessions s ON s.id=r.session_id WHERE r.id=?`).get(match[1]) as any;
      if (!row || row.client_id !== input.clientId || row.session_id !== input.sessionId
        || row.revoked_at !== null || row.expires_at <= input.at
        || !['active', 'idle'].includes(row.session_status)
        || !safeHashEqual(row.secret_hash, credentialHash(input.secret))) throw new ResumeCredentialError();
      // Successful use consumes every credential issued for this client and
      // session. Periodic refresh may briefly leave an older credential valid
      // to avoid a disconnect-during-delivery lockout, but the first resume
      // atomically invalidates all siblings before issuing the replacement.
      const revoked = this.db.prepare(`UPDATE resume_credentials SET revoked_at=?
        WHERE client_id=? AND session_id=? AND revoked_at IS NULL`).run(input.at, input.clientId, input.sessionId);
      if (revoked.changes < 1) throw new ResumeCredentialError();
      this.db.prepare('DELETE FROM resume_credentials WHERE expires_at<=?').run(input.at);
      this.db.prepare(`INSERT INTO resume_credentials(id,client_id,session_id,secret_hash,created_at,expires_at)
        VALUES (?,?,?,?,?,?)`).run(generated.id, input.clientId, input.sessionId, credentialHash(generated.secret),
        input.at, input.expiresAt);
      this.db.prepare('UPDATE clients SET last_seen_at=MAX(last_seen_at,?) WHERE id=?').run(input.at, input.clientId);
      return { ...generated, clientId: input.clientId, sessionId: input.sessionId,
        createdAt: input.at, expiresAt: input.expiresAt };
    });
  }

  revokeSessionCredentials(sessionId: string, at: number): number {
    this.ensureOpen();
    if (!validUuid(sessionId) || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid credential revocation');
    return Number(this.db.prepare(`UPDATE resume_credentials SET revoked_at=?
      WHERE session_id=? AND revoked_at IS NULL`).run(at, sessionId).changes);
  }

  markSessionAttached(sessionId: string, at: number): SessionRecord {
    return this.transitionLiveSession(sessionId, 'active', at);
  }

  markSessionDetached(sessionId: string, at: number): SessionRecord {
    return this.transitionLiveSession(sessionId, 'idle', at);
  }

  endSession(sessionId: string, at: number, reason: string): SessionRecord {
    return this.finishSession(sessionId, 'ended', at, reason);
  }

  expireSession(sessionId: string, at: number, reason = 'resume_window_expired'): SessionRecord {
    return this.finishSession(sessionId, 'expired', at, reason);
  }

  private transitionLiveSession(sessionId: string, status: 'active' | 'idle', at: number): SessionRecord {
    this.ensureOpen();
    if (!validUuid(sessionId) || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid conversation session transition');
    const result = this.db.prepare(`UPDATE sessions SET status=?,updated_at=MAX(updated_at,?)
      WHERE id=? AND status IN ('active','idle')`).run(status, at, sessionId);
    if (result.changes !== 1) throw new Error('Conversation session is unavailable');
    return this.getSession(sessionId)!;
  }

  private finishSession(sessionId: string, status: 'ended' | 'expired', at: number, reason: string): SessionRecord {
    this.ensureOpen();
    if (!validUuid(sessionId) || !Number.isSafeInteger(at) || at < 0
      || !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new Error('Invalid conversation session transition');
    return transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE sessions SET status=?,updated_at=MAX(updated_at,?),ended_at=?,end_reason=?
        WHERE id=? AND status IN ('active','idle')`).run(status, at, at, reason, sessionId);
      if (result.changes !== 1) throw new Error('Conversation session is unavailable');
      this.db.prepare(`UPDATE resume_credentials SET revoked_at=?
        WHERE session_id=? AND revoked_at IS NULL`).run(at, sessionId);
      return sessionRecord(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId));
    });
  }

  private validateCredentialTimes(createdAt: number, expiresAt: number) {
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(expiresAt)
      || expiresAt <= createdAt || expiresAt - createdAt > MAX_RESUME_CREDENTIAL_MS) throw new ResumeCredentialError();
  }

  commitUserTurn(input: CommitUserTurn): CommitAcknowledgement {
    this.ensureOpen();
    const content = input.content.trim();
    if (![input.sessionId, input.topicId, input.messageId, input.turnId].every(validUuid)
      || (input.retryOfTurnId !== undefined && !validUuid(input.retryOfTurnId))
      || !content || content.length > 6000
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
      || (input.cognitiveMode !== undefined && (!input.cognitiveMode || input.cognitiveMode.length > 64))
      || (input.reasoningEffort !== undefined && !['none', 'low', 'medium', 'high'].includes(input.reasoningEffort))) {
      throw new Error('Invalid conversation turn');
    }

    return transaction(this.db, () => {
      const existing = this.db.prepare(`SELECT id,session_id,turn_id,topic_id,sequence,role,status,content
        FROM messages WHERE id=?`).get(input.messageId) as any;
      if (existing) {
        if (existing.session_id !== input.sessionId || existing.topic_id !== input.topicId
          || existing.role !== 'user' || existing.status !== 'committed' || existing.content !== content
          || typeof existing.turn_id !== 'string') throw new ConversationStoreConflictError();
        return {
          result: 'duplicate', sessionId: existing.session_id, messageId: existing.id,
          turnId: existing.turn_id, sequence: existing.sequence,
        };
      }

      const topic = this.db.prepare('SELECT 1 FROM topics WHERE id=? AND session_id=?').get(input.topicId, input.sessionId);
      if (!topic) throw new Error('Conversation topic is unavailable');

      const session = this.db.prepare(`UPDATE sessions SET latest_sequence=latest_sequence+1,
        status='active',updated_at=MAX(updated_at,?),last_activity_at=MAX(last_activity_at,?)
        WHERE id=? AND status IN ('active','idle') RETURNING latest_sequence`)
        .get(input.createdAt, input.createdAt, input.sessionId) as { latest_sequence: number } | undefined;
      if (!session) throw new Error('Conversation session is unavailable');

      this.db.prepare(`INSERT INTO turns(id,session_id,topic_id,input_message_id,retry_of_turn_id,status,
        cognitive_mode,reasoning_effort,created_at,updated_at)
        VALUES (?,?,?,?,?,'accepted',?,?,?,?)`).run(
        input.turnId, input.sessionId, input.topicId, input.messageId, input.retryOfTurnId ?? null,
        input.cognitiveMode ?? null, input.reasoningEffort ?? null, input.createdAt, input.createdAt,
      );
      this.db.prepare(`INSERT INTO messages(id,session_id,turn_id,topic_id,sequence,role,status,content,created_at,updated_at)
        VALUES (?,?,?,?,?,'user','committed',?,?,?)`).run(
        input.messageId, input.sessionId, input.turnId, input.topicId, session.latest_sequence,
        content, input.createdAt, input.createdAt,
      );
      return {
        result: 'committed', sessionId: input.sessionId, messageId: input.messageId,
        turnId: input.turnId, sequence: session.latest_sequence,
      };
    });
  }

  getMessage(id: string): StoredMessage | undefined {
    this.ensureOpen();
    if (!validUuid(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row ? messageRecord(row) : undefined;
  }

  getTurn(id: string): StoredTurn | undefined {
    this.ensureOpen();
    if (!validUuid(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id);
    return row ? turnRecord(row) : undefined;
  }

  latestRecoverableTurn(sessionId: string): RecoverableTurn | undefined {
    this.ensureOpen();
    if (!validUuid(sessionId)) throw new Error('Invalid conversation session');
    const row = this.db.prepare(`SELECT * FROM turns WHERE session_id=? AND input_message_id IS NOT NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(sessionId) as any;
    if (!row) return undefined;
    const input = this.db.prepare('SELECT * FROM messages WHERE id=?').get(row.input_message_id) as any;
    const output = row.output_message_id
      ? this.db.prepare('SELECT * FROM messages WHERE id=?').get(row.output_message_id) as any : undefined;
    if (!input || input.role !== 'user' || input.status !== 'committed') return undefined;
    return { turn: turnRecord(row), input: messageRecord(input), ...(output ? { output: messageRecord(output) } : {}) };
  }

  listMessages(sessionId: string, afterSequence = 0, limit = 100): StoredMessage[] {
    this.ensureOpen();
    if (!validUuid(sessionId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid message query');
    return (this.db.prepare(`SELECT * FROM messages WHERE session_id=? AND sequence>?
      ORDER BY sequence LIMIT ?`).all(sessionId, afterSequence, limit) as any[]).map(messageRecord);
  }

  startAssistantAnswer(input: StartAssistantAnswer): AnswerAcknowledgement {
    this.ensureOpen();
    if (![input.sessionId, input.topicId, input.turnId, input.messageId].every(validUuid)
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new Error('Invalid assistant answer');

    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE id=?').get(input.messageId) as any;
      if (existing) {
        if (existing.session_id !== input.sessionId || existing.topic_id !== input.topicId
          || existing.turn_id !== input.turnId || existing.role !== 'assistant' || existing.status !== 'streaming') {
          throw new ConversationStoreConflictError();
        }
        return {
          result: 'duplicate', sessionId: existing.session_id, messageId: existing.id,
          turnId: existing.turn_id, sequence: existing.sequence,
        };
      }
      const turn = this.db.prepare(`SELECT 1 FROM turns WHERE id=? AND session_id=? AND topic_id=?
        AND status IN ('accepted','planning')`).get(input.turnId, input.sessionId, input.topicId);
      if (!turn) throw new Error('Conversation turn is unavailable');
      const session = this.db.prepare(`UPDATE sessions SET latest_sequence=latest_sequence+1,status='active',
        updated_at=MAX(updated_at,?),last_activity_at=MAX(last_activity_at,?)
        WHERE id=? AND status IN ('active','idle') RETURNING latest_sequence`)
        .get(input.createdAt, input.createdAt, input.sessionId) as { latest_sequence: number } | undefined;
      if (!session) throw new Error('Conversation session is unavailable');
      this.db.prepare(`INSERT INTO messages(id,session_id,turn_id,topic_id,sequence,role,status,content,created_at,updated_at)
        VALUES (?,?,?,?,?,'assistant','streaming','',?,?)`).run(
        input.messageId, input.sessionId, input.turnId, input.topicId, session.latest_sequence, input.createdAt, input.createdAt,
      );
      const updated = this.db.prepare(`UPDATE turns SET status='answering',output_message_id=?,updated_at=?
        WHERE id=? AND status IN ('accepted','planning')`).run(input.messageId, input.createdAt, input.turnId);
      if (updated.changes !== 1) throw new Error('Conversation turn changed while starting answer');
      return {
        result: 'started', sessionId: input.sessionId, messageId: input.messageId,
        turnId: input.turnId, sequence: session.latest_sequence,
      };
    });
  }

  checkpointAssistantAnswer(input: { messageId: string; content: string; updatedAt: number }) {
    this.ensureOpen();
    if (!validUuid(input.messageId) || input.content.length > 120_000
      || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw new Error('Invalid assistant checkpoint');
    const updated = this.db.prepare(`UPDATE messages SET content=?,updated_at=MAX(updated_at,?)
      WHERE id=? AND role='assistant' AND status='streaming'`).run(input.content, input.updatedAt, input.messageId);
    if (updated.changes !== 1) throw new Error('Assistant answer is not streaming');
  }

  commitAssistantAnswer(input: { messageId: string; content: string; citations?: unknown[]; updatedAt: number }): AnswerAcknowledgement {
    this.ensureOpen();
    const content = input.content.trim();
    if (!validUuid(input.messageId) || !content || content.length > 120_000
      || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0
      || (input.citations !== undefined && !Array.isArray(input.citations))) throw new Error('Invalid assistant answer');
    const citations = input.citations === undefined ? null : JSON.stringify(input.citations);
    if (citations !== null && Buffer.byteLength(citations) > 65_536) throw new Error('Assistant citations are too large');

    return transaction(this.db, () => {
      const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(input.messageId) as any;
      if (!message || message.role !== 'assistant' || typeof message.turn_id !== 'string') throw new Error('Assistant answer is unavailable');
      if (message.status === 'committed') {
        if (message.content !== content || message.citations_json !== citations) throw new ConversationStoreConflictError();
        return {
          result: 'duplicate', sessionId: message.session_id, messageId: message.id,
          turnId: message.turn_id, sequence: message.sequence,
        };
      }
      if (message.status !== 'streaming') throw new Error('Assistant answer is no longer writable');
      const saved = this.db.prepare(`UPDATE messages SET status='committed',content=?,citations_json=?,updated_at=MAX(updated_at,?)
        WHERE id=? AND status='streaming'`).run(content, citations, input.updatedAt, input.messageId);
      const turn = this.db.prepare(`UPDATE turns SET status='committed',updated_at=MAX(updated_at,?),error_code=NULL
        WHERE id=? AND output_message_id=? AND status='answering'`).run(input.updatedAt, message.turn_id, input.messageId);
      if (saved.changes !== 1 || turn.changes !== 1) throw new Error('Assistant answer commit lost its turn');
      this.db.prepare(`UPDATE sessions SET updated_at=MAX(updated_at,?),last_activity_at=MAX(last_activity_at,?)
        WHERE id=?`).run(input.updatedAt, input.updatedAt, message.session_id);
      return {
        result: 'committed', sessionId: message.session_id, messageId: message.id,
        turnId: message.turn_id, sequence: message.sequence,
      };
    });
  }

  interruptAssistantAnswer(input: { turnId: string; updatedAt: number; reason: string }): AnswerAcknowledgement {
    this.ensureOpen();
    if (!validUuid(input.turnId) || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0
      || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reason)) throw new Error('Invalid interruption');
    return transaction(this.db, () => {
      const turn = this.db.prepare('SELECT * FROM turns WHERE id=?').get(input.turnId) as any;
      if (!turn || typeof turn.output_message_id !== 'string') throw new Error('Assistant answer is unavailable');
      const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(turn.output_message_id) as any;
      if (!message) throw new Error('Assistant answer is unavailable');
      if (turn.status === 'interrupted' && message.status === 'interrupted') return {
        result: 'duplicate', sessionId: turn.session_id, messageId: message.id,
        turnId: turn.id, sequence: message.sequence,
      };
      if (turn.status !== 'answering' || message.status !== 'streaming') throw new Error('Assistant answer cannot be interrupted');
      const saved = this.db.prepare(`UPDATE messages SET status='interrupted',updated_at=MAX(updated_at,?)
        WHERE id=? AND status='streaming'`).run(input.updatedAt, message.id);
      const stopped = this.db.prepare(`UPDATE turns SET status='interrupted',error_code=?,updated_at=MAX(updated_at,?)
        WHERE id=? AND status='answering'`).run(input.reason, input.updatedAt, turn.id);
      if (saved.changes !== 1 || stopped.changes !== 1) throw new Error('Assistant interruption lost its turn');
      return {
        result: 'interrupted', sessionId: turn.session_id, messageId: message.id,
        turnId: turn.id, sequence: message.sequence,
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.db.prepare('DELETE FROM service_owner WHERE id=1 AND token=?').run(this.ownerToken); }
    finally { this.db.close(); }
  }
}
