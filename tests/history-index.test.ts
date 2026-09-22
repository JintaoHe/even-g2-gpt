import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationStore } from '../src/conversation-store.js';
import { installHistoryIndex } from '../src/history-index.js';
import { prepareHistoryQuery } from '../src/history-query.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT,role TEXT,status TEXT);
    INSERT INTO sessions VALUES ('owner','single-user'),('guest','guest:synthetic-fixture');`);
  const put = (id: string, content: string, session = 'owner', status = 'committed', role = 'user') =>
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(id, session, content, role, status);
  const hits = (query: string) => db.prepare('SELECT rowid FROM history_search_fts WHERE history_search_fts MATCH ?')
    .all(prepareHistoryQuery({ mode: 'owner', ownerScope: 'single-user' }, { query }, Date.now()).parameter).length;
  const check = () => db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
  const install = () => {
    db.exec('BEGIN IMMEDIATE');
    try { installHistoryIndex(db); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, put, hits, check, install };
}

test('initial index and safe rebuild exclude guest, system and uncommitted rows', () => {
  const f = fixture();
  try {
    f.put('a', '松林采购会议'); f.put('b', 'guest secret', 'guest');
    f.put('c', 'system secret', 'owner', 'committed', 'system');
    f.put('d', 'pending secret', 'owner', 'streaming', 'assistant');
    f.install(); assert.equal(f.hits('采购会议'), 1); assert.equal(f.hits('secret'), 0);
    f.db.exec("INSERT INTO history_search_fts(history_search_fts) VALUES('rebuild')");
    assert.equal(f.hits('secret'), 0); f.check();
  } finally { f.db.close(); }
});

test('insert, text update, commit, withdrawal, role change and deletion keep index exact', () => {
  const f = fixture();
  try {
    f.install(); f.put('a', 'battery contract', 'owner', 'streaming', 'assistant');
    assert.equal(f.hits('battery'), 0);
    f.db.exec("UPDATE messages SET status='committed' WHERE id='a'"); assert.equal(f.hits('battery'), 1); f.check();
    f.db.exec("UPDATE messages SET content='solar contract' WHERE id='a'");
    assert.equal(f.hits('battery'), 0); assert.equal(f.hits('solar'), 1); f.check();
    f.db.exec("UPDATE messages SET role='system' WHERE id='a'"); assert.equal(f.hits('solar'), 0); f.check();
    f.db.exec("UPDATE messages SET role='assistant' WHERE id='a'"); assert.equal(f.hits('solar'), 1);
    f.db.exec("UPDATE messages SET status='interrupted' WHERE id='a'"); assert.equal(f.hits('solar'), 0); f.check();
    f.db.exec("UPDATE messages SET status='committed' WHERE id='a'; DELETE FROM messages WHERE id='a'");
    assert.equal(f.hits('solar'), 0); f.check();
  } finally { f.db.close(); }
});

test('session cascade deletion removes tokens exactly once and leaves other sessions intact', () => {
  const f = fixture();
  try {
    f.install(); f.put('a', 'cedar itinerary'); f.put('b', 'hidden itinerary', 'guest');
    f.db.exec("INSERT INTO sessions VALUES('other','second-owner')"); f.put('c', 'maple itinerary', 'other');
    f.db.exec("DELETE FROM sessions WHERE id='owner'");
    assert.equal(f.hits('cedar'), 0); assert.equal(f.hits('maple'), 1); f.check();
    f.db.exec("DELETE FROM sessions WHERE id='guest'"); f.check();
    f.db.exec('DELETE FROM sessions'); assert.equal(f.hits('itinerary'), 0); f.check();
  } finally { f.db.close(); }
});

test('scope changes and moving a message cannot leave guest tokens indexed', () => {
  const f = fixture();
  try {
    f.install(); f.put('a', 'private telescope');
    f.db.exec("UPDATE sessions SET owner_scope='GUEST:synthetic' WHERE id='owner'");
    assert.equal(f.hits('telescope'), 0); f.check();
    f.db.exec("UPDATE sessions SET owner_scope='single-user' WHERE id='owner'");
    assert.equal(f.hits('telescope'), 1); f.check();
    f.db.exec("UPDATE messages SET session_id='guest' WHERE id='a'");
    assert.equal(f.hits('telescope'), 0); f.check();
  } finally { f.db.close(); }
});

test('FTS metacharacters are literal phrases, not query operators', () => {
  const f = fixture();
  try {
    f.install();
    for (const [i, value] of ['100% complete', 'a_b index', 'red OR blue', 'she said "yes"', 'unrelated blue'].entries()) f.put(String(i), value);
    assert.equal(f.hits('100%'), 1); assert.equal(f.hits('a_b'), 1);
    assert.equal(f.hits('red OR blue'), 1); assert.equal(f.hits('"yes"'), 1);
    assert.equal(f.hits('" OR *'), 0); f.check();
  } finally { f.db.close(); }
});

test('installation failure rolls back all index objects without changing source rows', () => {
  const f = fixture();
  try {
    f.put('a', 'rollback source');
    f.db.exec('CREATE TABLE history_search_fts(sentinel TEXT)');
    assert.throws(f.install);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='history_search_source'").get(), undefined);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 1);
    f.db.exec('DROP TABLE history_search_fts'); f.install(); f.check();
  } finally { f.db.close(); }
});

test('real store writes and restart preserve filtered external-content integrity in a temporary database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-history-index-'));
  let store = await ConversationStore.create(root);
  const db = new DatabaseSync(join(root, 'assistant-memory.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE'); installHistoryIndex(db); db.exec('COMMIT');
    const sessionId = randomUUID(), topicId = randomUUID(), turnId = randomUUID(), answerId = randomUUID();
    store.createSession({ id: sessionId, ownerScope: 'single-user', createdAt: 100, initialTopic: { id: topicId, label: 'Repairs' } });
    store.commitUserTurn({ sessionId, topicId, turnId, messageId: randomUUID(), content: '换滤芯的讨论', createdAt: 101 });
    store.startAssistantAnswer({ sessionId, topicId, turnId, messageId: answerId, createdAt: 102 });
    store.commitAssistantAnswer({ messageId: answerId, content: '先比较滤芯规格，尚未订购。', updatedAt: 103 });
    const count = () => (db.prepare("SELECT count(*) AS n FROM history_search_fts WHERE history_search_fts MATCH '\"滤芯规\"'").get() as any).n;
    assert.equal(count(), 1);
    await store.close(); store = await ConversationStore.create(root);
    assert.equal(count(), 1);
    db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
    store.endSession(sessionId, 200, 'user_exit');
    db.exec('PRAGMA foreign_keys=ON'); db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    assert.equal(count(), 0);
    db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
  } finally { db.close(); await store.close(); }
});
