import { readConversationMaintenanceConfig } from './conversation-maintenance.js';

function booleanSetting(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function readConversationStartupConfig(env: NodeJS.ProcessEnv) {
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
    resumeWindowMs: resumeMinutes * 60_000,
    maintenance: readConversationMaintenanceConfig(env),
    localTestControls: { read: readTestControls, write: writeTestControls },
  };
}
