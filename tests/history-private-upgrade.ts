/** Explicit opt-in private rehearsal. Source opens read-only; ONLY fresh copies
 * are upgraded or have stale process leases removed. Never print rows/hashes.
 * Requires --source=<assistant-memory.sqlite> --baseline=<matching old source export> --expected-version=5|12.
 * No dotenv, network, provider, email or calendar access. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sqlite from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
const { DatabaseSync } = sqlite;
const argument = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceArg = argument('source'), baseline = argument('baseline');
const expectedVersion = Number(argument('expected-version'));
if (!sourceArg || !baseline || ![5, 12].includes(expectedVersion)) throw Error('Explicit source, baseline and expected version (5 or 12) required');
const sourcePath = resolve(sourceArg), info = await lstat(sourcePath);
assert.equal(basename(sourcePath), 'assistant-memory.sqlite'); assert.ok(info.isFile() && !info.isSymbolicLink());
const OldStore = (await import(pathToFileURL(join(resolve(baseline), 'src/conversation-store.ts')).href)).ConversationStore;
const root = await mkdtemp(join(tmpdir(), 'even-history-private-')); await chmod(root, 0o700);
const snapshot = join(root, 'snapshot.sqlite'), working = join(root, 'working.sqlite'), restored = join(root, 'restored');
await mkdir(restored, { mode: 0o700 });
const backup = (sqlite as any).backup as (db: InstanceType<typeof DatabaseSync>, path: string) => Promise<void>;
const source = new DatabaseSync(sourcePath, { readOnly: true } as any);
try { await backup(source, snapshot); } finally { source.close(); }
await chmod(snapshot, 0o600);
const frozen = new DatabaseSync(snapshot, { readOnly: true } as any);
type Layout = { name: string; columns: string[] }[];
const fingerprint = (db: InstanceType<typeof DatabaseSync>, layout?: Layout) => {
  const tables = layout ?? (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'history_%' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => { assert.match(name, /^[a-z_]+$/); return { name, columns: (db.prepare(`PRAGMA table_info("${name}")`).all() as any[]).map(x => x.name) }; });
  const hash = createHash('sha256'), counts: Record<string, number> = {};
  for (const { name, columns } of tables) {
    assert.match(name, /^[a-z_]+$/); let n = 0; hash.update(name);
    for (const column of columns) assert.match(column, /^[a-z0-9_]+$/);
    for (const row of (db.prepare(`SELECT ${columns.map(x => `"${x}"`).join(',')} FROM "${name}" ORDER BY rowid`) as any).iterate()) { hash.update(JSON.stringify(row)); n++; }
    counts[name] = n;
  }
  return { digest: hash.digest('hex'), counts, layout: tables };
};
const originalVersion = (frozen.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v;
assert.equal(originalVersion, expectedVersion, 'Snapshot differs from explicitly selected migration path');
const original = fingerprint(frozen);
await backup(frozen, working); await backup(frozen, join(restored, 'assistant-memory.sqlite')); frozen.close();
await chmod(working, 0o600); await chmod(join(restored, 'assistant-memory.sqlite'), 0o600);
const beforeBytes = (await stat(working)).size, db = new DatabaseSync(working);
db.exec('PRAGMA foreign_keys=ON');
const begin = performance.now();
// Same transaction used at startup, without claiming a copied live lease or
// interrupting copied in-flight turns. Verify migration independently of recovery.
(ConversationStore as any).migrate(db);
const migrationMs = performance.now() - begin;
assert.deepEqual(fingerprint(db, original.layout), original);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.exec("INSERT INTO history_search_fts(history_search_fts,rank) VALUES('integrity-check',1)");
db.close();
const afterBytes = (await stat(working)).size;
// Old code points to a separate directory with the upgraded copy, never source.
const incompatible = join(root, 'incompatible'); await mkdir(incompatible, { mode: 0o700 });
const upgraded = new DatabaseSync(working, { readOnly: true } as any);
await backup(upgraded, join(incompatible, 'assistant-memory.sqlite')); upgraded.close();
await assert.rejects(OldStore.create(incompatible), /newer than/);
const restoreDb = new DatabaseSync(join(restored, 'assistant-memory.sqlite'));
assert.deepEqual(fingerprint(restoreDb), original);
// A backup may contain a live production PID: clear only this throwaway lease.
restoreDb.exec('DELETE FROM service_owner'); restoreDb.close();
const old = await OldStore.create(restored);
assert.equal(old.health().schemaVersion, expectedVersion);
const testId = randomUUID(); old.createSession({ id: testId, ownerScope: 'single-user', createdAt: Date.now() });
assert.equal(old.getSession(testId).id, testId); await old.close();
const sourceCheck = new DatabaseSync(sourcePath, { readOnly: true } as any);
try { assert.equal((sourceCheck.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, expectedVersion); }
finally { sourceCheck.close(); }
console.log(JSON.stringify({ type: 'history_private_upgrade', sourceOpenedReadOnly: true, sourceVersion: originalVersion,
  migratedVersion: 13, migrationMs, beforeBytes, afterBytes, growthBytes: afterBytes - beforeBytes,
  counts: original.counts, dataPreserved: true, foreignKeysValid: true, ftsIntegrity: true,
  oldCodeRejectsNewSchema: true, backupVerifiedBeforeRecovery: true, oldCodeWritesRestoredCopy: true,
  apiCalls: 0, privateCopiesRetainedAt: root }));
