import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/conversation-store.js';
import { importLegacySessions } from '../src/legacy-session-import.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'even-legacy-import-'));
  const legacyDirectory = join(root, 'conversations');
  await mkdir(legacyDirectory);
  return { root, legacyDirectory };
}

function legacy(sessionId: string) {
  return {
    session_id: sessionId,
    updated_at: '2026-09-19T12:00:00.000Z',
    history: [
      { role: 'user', content: '我们刚才讨论的第二点是什么？', topicLabel: '产品计划' },
      { role: 'assistant', content: '第二点是断线恢复。', topicLabel: '产品计划' },
      { role: 'user', content: 'Keep this bilingual decision.', topicLabel: '产品计划' },
    ],
  };
}

test('legacy importer dry-run validates without creating a database or moving source files', async () => {
  const { root, legacyDirectory } = await fixture();
  const sessionId = randomUUID(), file = join(legacyDirectory, `${sessionId}.json`);
  await writeFile(file, JSON.stringify(legacy(sessionId)));

  const report = await importLegacySessions({ dataDirectory: root, apply: false });
  assert.deepEqual({ scanned: report.scanned, valid: report.valid, imported: report.imported,
    duplicates: report.duplicates, quarantined: report.quarantined, errors: report.errors },
  { scanned: 1, valid: 1, imported: 0, duplicates: 0, quarantined: 0, errors: [] });
  await assert.rejects(lstat(join(root, 'assistant-memory.sqlite')), /ENOENT/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).session_id, sessionId);
});

test('legacy importer is transactional, preserves the source, and is idempotent by source hash', async () => {
  const { root, legacyDirectory } = await fixture();
  const sessionId = randomUUID(), file = join(legacyDirectory, `${sessionId}.json`);
  await writeFile(file, JSON.stringify(legacy(sessionId)));
  const store = await ConversationStore.create(root);
  try {
    const first = await importLegacySessions({ dataDirectory: root, apply: true, store, now: () => 1_800_000_000_000 });
    assert.equal(first.imported, 1);
    assert.equal(store.getSession(sessionId)?.status, 'ended');
    assert.equal(store.getSession(sessionId)?.latestSequence, 3);
    assert.deepEqual(store.listMessages(sessionId, 0, 10).map(message => [message.sequence, message.role, message.content]), [
      [1, 'user', '我们刚才讨论的第二点是什么？'],
      [2, 'assistant', '第二点是断线恢复。'],
      [3, 'user', 'Keep this bilingual decision.'],
    ]);
    assert.equal(store.listLegacyImports().length, 1);
    assert.equal((await lstat(file)).isFile(), true, 'successful imports retain the original JSON');

    const second = await importLegacySessions({ dataDirectory: root, apply: true, store, now: () => 1_800_000_000_001 });
    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(store.listMessages(sessionId, 0, 10).length, 3);
  } finally { await store.close(); }
});

test('invalid, truncated and oversized JSON files are isolated without blocking valid imports', async () => {
  const { root, legacyDirectory } = await fixture();
  const validId = randomUUID(), truncatedId = randomUUID(), oversizedId = randomUUID(), invalidMessageId = randomUUID();
  await writeFile(join(legacyDirectory, `${validId}.json`), JSON.stringify(legacy(validId)));
  await writeFile(join(legacyDirectory, `${truncatedId}.json`), '{"session_id":');
  await writeFile(join(legacyDirectory, `${oversizedId}.json`), 'x'.repeat(2049));
  await writeFile(join(legacyDirectory, `${invalidMessageId}.json`), JSON.stringify({
    ...legacy(invalidMessageId), history: [{ role: 'user', content: '' }],
  }));
  await writeFile(join(legacyDirectory, '..evil.json'), JSON.stringify(legacy(randomUUID())));
  const store = await ConversationStore.create(root);
  try {
    const report = await importLegacySessions({ dataDirectory: root, apply: true, store, maxFileBytes: 2048 });
    assert.equal(report.imported, 1);
    assert.equal(report.quarantined, 4);
    assert.deepEqual(report.errors.map(error => error.code).sort(),
      ['INVALID_FILENAME', 'INVALID_JSON', 'INVALID_SCHEMA', 'OVERSIZED'].sort());
    assert.equal(store.getSession(validId)?.latestSequence, 3);
    assert.equal(store.getSession(truncatedId), undefined);
    assert.equal(store.getSession(invalidMessageId), undefined, 'invalid input must leave no partial session rows');
    const quarantined = await readdir(join(legacyDirectory, '.quarantine'));
    assert.equal(quarantined.length, 4);
  } finally { await store.close(); }
});

test('legacy importer never follows a symbolic link', async t => {
  const { root, legacyDirectory } = await fixture();
  const targetId = randomUUID(), linkId = randomUUID();
  const target = join(root, `${targetId}.json`), link = join(legacyDirectory, `${linkId}.json`);
  await writeFile(target, JSON.stringify(legacy(targetId)));
  try { await symlink(target, link, 'file'); }
  catch (error: any) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip('file symlink creation is unavailable'); return; }
    throw error;
  }
  const store = await ConversationStore.create(root);
  try {
    const report = await importLegacySessions({ dataDirectory: root, apply: true, store });
    assert.equal(report.imported, 0);
    assert.equal(report.quarantined, 0);
    assert.deepEqual(report.errors.map(error => error.code), ['SYMLINK']);
    assert.equal(store.getSession(targetId), undefined);
    assert.equal(store.getSession(linkId), undefined);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally { await store.close(); }
});

test('legacy graph validation rejects mismatched turn references before any transaction writes', async () => {
  const { root } = await fixture(), store = await ConversationStore.create(root);
  const sessionId = randomUUID(), topicId = randomUUID(), turnId = randomUUID(), messageId = randomUUID();
  try {
    assert.throws(() => store.importLegacySession({
      sourceHash: 'a'.repeat(64), sourceName: `${sessionId}.json`, importedAt: 100,
      session: { id: sessionId, ownerScope: 'legacy-import', createdAt: 1, updatedAt: 2, endedAt: 2 },
      topics: [{ id: topicId, label: 'General', createdAt: 1, updatedAt: 2 }],
      turns: [{ id: turnId, topicId, inputMessageId: messageId, outputMessageId: messageId,
        status: 'committed', createdAt: 1, updatedAt: 2 }],
      messages: [{ id: messageId, turnId, topicId, sequence: 1, role: 'user', content: 'hello', createdAt: 1, updatedAt: 1 }],
    }), /invalid legacy/i);
    assert.equal(store.getSession(sessionId), undefined);
    assert.equal(store.listLegacyImports().length, 0);
  } finally { await store.close(); }
});
