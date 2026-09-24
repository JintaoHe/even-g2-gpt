import { readConversationMaintenanceConfig } from './conversation-maintenance.js';
import { historyRecallEnabled } from './history-query.js';
import { hybridFirstOutputMs } from './model-profile.js';

function booleanSetting(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function readConversationStartupConfig(env: NodeJS.ProcessEnv) {
  const loopback = env.EVEN_ALLOW_LOOPBACK_ORIGIN;
  if (loopback !== undefined && loopback !== 'true' && loopback !== 'false') {
    throw new Error('EVEN_ALLOW_LOOPBACK_ORIGIN must be exactly true or false');
  }
  hybridFirstOutputMs(env); // Validate before opening/migrating stores or creating ledgers.
  const recallEnabled = historyRecallEnabled(env);
  // INVOCATION_ID is supplied by systemd, including existing installations whose
  // service unit predates NODE_ENV=production. Do not infer deployment from DNS.
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production'
    || env.INVOCATION_ID !== undefined;
  if (production && recallEnabled && env.EVEN_HISTORY_RECALL_LATENCY_ACCEPTED !== 'true') {
    throw new Error('HISTORY_RECALL_PRODUCTION_GATE: set EVEN_HISTORY_RECALL_ENABLED=false until Linux migration and voice-loop latency acceptance; then explicitly set EVEN_HISTORY_RECALL_LATENCY_ACCEPTED=true');
  }
  const resumeMinutes = Number(env.SESSION_RESUME_WINDOW_MINUTES ?? 15);
  if (!Number.isSafeInteger(resumeMinutes) || resumeMinutes < 1 || resumeMinutes > 15) {
    throw new Error('SESSION_RESUME_WINDOW_MINUTES must be an integer from 1 to 15');
  }
  const readTestControls = booleanSetting(env, 'EVEN_LOCAL_TEST_CONTROLS');
  const writeTestControls = booleanSetting(env, 'EVEN_LOCAL_TEST_WRITE_CONTROLS');
  if (writeTestControls && !readTestControls) {
    throw new Error('EVEN_LOCAL_TEST_WRITE_CONTROLS requires EVEN_LOCAL_TEST_CONTROLS=true');
  }
  return {
    allowLoopbackOrigin: loopback === 'true',
    historyRecallEnabled: recallEnabled,
    legacyHelloEnabled: booleanSetting(env, 'CONVERSATION_LEGACY_HELLO_ENABLED'),
    resumeWindowMs: resumeMinutes * 60_000,
    maintenance: readConversationMaintenanceConfig(env),
    localTestControls: { read: readTestControls, write: writeTestControls },
  };
}
