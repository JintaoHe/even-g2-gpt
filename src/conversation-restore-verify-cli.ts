import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConversationStore } from './conversation-store.js';

const PRODUCTION_CHECK_ROOT = resolve('/var/backups/even-agent/.restore-check');

export async function reopenRestoredConversationStore(rootInput: string, expectedRoot = PRODUCTION_CHECK_ROOT) {
  const root = resolve(rootInput || '');
  if (root !== resolve(expectedRoot)) throw new Error('Unexpected restore-check directory');
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Restore-check directory is unsafe');
  const store = await ConversationStore.create(root);
  try { return store.health(); }
  finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await reopenRestoredConversationStore(process.argv[2]);
  console.log(`Restored conversation store reopened with schema ${report.schemaVersion}.`);
}
