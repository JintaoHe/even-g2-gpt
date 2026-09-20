import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConversationMaintenanceConfig, runConversationMaintenance } from './conversation-maintenance.js';
import { ConversationStore } from './conversation-store.js';

export async function runConversationMaintenanceCli(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  const dataArgument = argv.find(argument => argument.startsWith('--data-dir='));
  const dataDirectory = resolve(dataArgument?.slice('--data-dir='.length) || env.EVEN_DATA_DIR || '.local');
  const store = await ConversationStore.create(dataDirectory);
  try {
    const result = await runConversationMaintenance(store, readConversationMaintenanceConfig(env), Date.now(), !apply);
    const report = { mode: apply ? 'apply' : 'dry-run', retention_days: result.retention.retentionDays,
      retention_enabled: result.retention.enabled, eligible_sessions: result.retention.eligibleSessions,
      eligible_messages: result.retention.eligibleMessages, deleted_sessions: result.retention.deletedSessions,
      deleted_messages: result.retention.deletedMessages, sessions: result.storage.sessions,
      messages: result.storage.messages, database_bytes: result.storage.databaseBytes,
      available_disk_bytes: result.storage.availableDiskBytes, warnings: result.storage.warnings };
    console.log(`Conversation maintenance: ${JSON.stringify(report)}`);
    return result;
  } finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runConversationMaintenanceCli();
