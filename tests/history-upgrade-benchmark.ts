/** Opt-in, synthetic-only. No dotenv, providers, network or business data.
 * node --import tsx tests/history-upgrade-benchmark.ts --baseline=<exported-main-root>
 * Baseline must be the actual pre-v13 source tree, not a version-number edit. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sqlite from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
const { DatabaseSync } = sqlite;
const baseline = process.argv.find(x => x.startsWith('--baseline='))?.slice(11);
if (!baseline) throw Error('Explicit pre-v13 source export required');
const OldStore = (await import(pathToFileURL(join(resolve(baseline), 'src/conversation-store.ts')).href)).ConversationStore;
const root = await mkdtemp(join(tmpdir(), 'even-history-50k-'));
const legacyRoot = join(root, 'legacy'), migratedRoot = join(root, 'migrated'), restoredRoot = join(root, 'restored');
await mkdir(migratedRoot); await mkdir(restoredRoot);
const name = 'assistant-memory.sqlite', now = 2_000_000_000_000;
const backup = (sqlite as any).backup as (db: InstanceType<typeof DatabaseSync>, path: string) => Promise<void>;
assert.equal(typeof backup, 'function');
const fingerprint = (db: InstanceType<typeof DatabaseSync>) => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'history_%' AND name NOT IN ('schema_migrations','service_owner') ORDER BY name").all() as { name: string }[]);
  const hash = createHash('sha256'), counts: Record<string, number> = {};
  for (const { name } of tables) {
    assert.match(name, /^[a-z_]+$/); let count = 0;
    hash.update(name);
    for (const row of (db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`) as any).iterate()) { hash.update(JSON.stringify(row)); count++; }
    counts[name] = count;
  }
  return { digest: hash.digest('hex'), counts };
};
const old = await OldStore.create(legacyRoot);
assert.equal(old.health().schemaVersion, 12);
await old.close();
const seed = new DatabaseSync(join(legacyRoot, name));
seed.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
const sessions: string[] = Array.from({ length: 100 }, () => randomUUID());
const sessionInsert = seed.prepare(`INSERT INTO sessions(id,owner_scope,status,created_at,updated_at,last_activity_at,ended_at,end_reason,latest_sequence,summary_through_sequence)
  VALUES(?,?,'ended',?,?,?,?, 'user_exit',500,0)`);
for (let i = 0; i < sessions.length; i++) sessionInsert.run(sessions[i], i < 70 ? 'single-user' : i < 90 ? 'second-owner' : `guest:${randomUUID()}`, now - 60000, now, now, now);
const insert = seed.prepare('INSERT INTO messages(id,session_id,sequence,role,status,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
const startSeed = performance.now();
for (let i = 0; i < 50000; i++) {
  const session = Math.floor(i / 500), sequence = i % 500 + 1;
  const text = `Synthetic ${i}: library cooling proposal, not approved. 生日与采购 100% a_b "quoted" 🚲. `
    + '讨论比较而非执行，等待下一轮明确决定。Energy audit planning; no email sent. '.repeat(i % 9 + 1);
  insert.run(randomUUID(), sessions[session], sequence, i % 17 === 0 ? 'system' : i % 2 ? 'assistant' : 'user', 'committed', text, now - 50000 + i, now - 50000 + i);
}
seed.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
const seedMs = performance.now() - startSeed, original = fingerprint(seed);
assert.equal(original.counts.messages, 50000);
const backupFile = join(root, 'pre-v13.sqlite'); await backup(seed, backupFile); seed.close();
const saved = new DatabaseSync(backupFile, { readOnly: true } as any);
await backup(saved, join(migratedRoot, name)); await backup(saved, join(restoredRoot, name)); saved.close();
const beforeBytes = (await stat(join(migratedRoot, name))).size;
const start = performance.now(), store = await ConversationStore.create(migratedRoot), migrationMs = performance.now() - start;
const db = new DatabaseSync(join(migratedRoot, name));
assert.equal(store.health().schemaVersion, 13); assert.deepEqual(fingerprint(db), original);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const afterBytes = (await stat(join(migratedRoot, name))).size;
const cases = ['missing-needle-27', '生日', '%', 'library', '100%', '"quoted"', '🚲', '采购'];
const queryMetrics = [];
for (let kind = 0; kind < cases.length; kind++) {
  const samples: number[] = []; let incomplete = false;
  for (let trial = 0; trial < 25; trial++) {
    const t = performance.now(); const result = store.searchMessages({ mode: 'owner', ownerScope: 'single-user' }, { query: cases[kind] }, now);
    samples.push(performance.now() - t); incomplete = result.incomplete;
    assert.ok(result.scanned <= 2000 && result.scannedBytes <= 4 * 1024 * 1024 && result.messages.length <= 10);
    for (const hit of result.messages) assert.ok(sessions.slice(0, 70).includes(hit.sessionId));
  }
  samples.sort((a, b) => a - b);
  queryMetrics.push({ case: kind, p50Ms: samples[12], p95Ms: samples[23], maxMs: samples[24], incomplete });
}
const deletedStart = performance.now();
db.exec('PRAGMA foreign_keys=ON'); db.prepare('DELETE FROM sessions WHERE id=?').run(sessions[0]);
const deleteMs = performance.now() - deletedStart;
db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as any).n, 49500);
db.close(); await store.close();
const check = new DatabaseSync(join(migratedRoot, name), { readOnly: true } as any), beforeReject = fingerprint(check); check.close();
await assert.rejects(OldStore.create(migratedRoot), /newer than/);
const unchanged = new DatabaseSync(join(migratedRoot, name), { readOnly: true } as any);
assert.deepEqual(fingerprint(unchanged), beforeReject); unchanged.close();
const restored = await OldStore.create(restoredRoot); assert.equal(restored.health().schemaVersion, 12);
const restoreCheck = new DatabaseSync(join(restoredRoot, name)); assert.deepEqual(fingerprint(restoreCheck), original); restoreCheck.close();
// Actual old application write against restored pre-upgrade backup.
const sid = randomUUID(); restored.createSession({ id: sid, ownerScope: 'single-user', createdAt: now + 1 });
assert.equal(restored.getSession(sid).id, sid); await restored.close();
console.log(JSON.stringify({ type: 'history_synthetic_upgrade', node: process.version, rows: 50000, seedMs, migrationMs,
  beforeBytes, afterBytes, growthBytes: afterBytes - beforeBytes, delete500Ms: deleteMs, queryMetrics,
  sourcePreserved: true, oldVersionRejected: true, backupRestoredWithOldCode: true, apiCalls: 0, temporaryRoot: root }));
