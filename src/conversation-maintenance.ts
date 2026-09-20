import type { ConversationStore, ConversationRetentionReport, ConversationStorageHealth } from './conversation-store.js';

const MIB = 1024 * 1024;

export type ConversationMaintenanceConfig = {
  retentionDays: number;
  databaseWarningBytes: number;
  diskFreeWarningBytes: number;
};

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export function readConversationMaintenanceConfig(env: NodeJS.ProcessEnv): ConversationMaintenanceConfig {
  return {
    retentionDays: integerSetting(env, 'SESSION_RETENTION_DAYS', 1095, 0, 36_500),
    databaseWarningBytes: integerSetting(env, 'SESSION_DATABASE_WARNING_MB', 1024, 1, 1024 * 1024) * MIB,
    diskFreeWarningBytes: integerSetting(env, 'SESSION_DISK_FREE_WARNING_MB', 2048, 1, 1024 * 1024) * MIB,
  };
}

export async function runConversationMaintenance(store: ConversationStore, config: ConversationMaintenanceConfig,
  now = Date.now(), dryRun = false): Promise<{ retention: ConversationRetentionReport; storage: ConversationStorageHealth }> {
  const retention = store.cleanupExpiredSessions({ retentionDays: config.retentionDays, now, dryRun });
  const storage = await store.storageHealth({ databaseWarningBytes: config.databaseWarningBytes,
    diskFreeWarningBytes: config.diskFreeWarningBytes });
  return { retention, storage };
}
