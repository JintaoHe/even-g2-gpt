import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const updateScript = await readFile(new URL('../deploy/even-agent-update.sh', import.meta.url), 'utf8');
const updateService = await readFile(new URL('../deploy/even-agent-update.service', import.meta.url), 'utf8');
const updateTimer = await readFile(new URL('../deploy/even-agent-update.timer', import.meta.url), 'utf8');
const runtimeService = await readFile(new URL('../deploy/even-agent.service', import.meta.url), 'utf8');
const healthScript = await readFile(new URL('../deploy/even-agent-healthcheck.sh', import.meta.url), 'utf8');
const healthService = await readFile(new URL('../deploy/even-agent-healthcheck.service', import.meta.url), 'utf8');
const healthTimer = await readFile(new URL('../deploy/even-agent-healthcheck.timer', import.meta.url), 'utf8');
const backupScript = await readFile(new URL('../deploy/even-agent-backup.sh', import.meta.url), 'utf8');
const restoreScript = await readFile(new URL('../deploy/even-agent-restore-check.sh', import.meta.url), 'utf8');
const buildScript = await readFile(new URL('../scripts/build-server.mjs', import.meta.url), 'utf8');
const conversationServer = await readFile(new URL('../src/conversation-server.ts', import.meta.url), 'utf8');
const backupService = await readFile(new URL('../deploy/even-agent-backup.service', import.meta.url), 'utf8');
const backupTimer = await readFile(new URL('../deploy/even-agent-backup.timer', import.meta.url), 'utf8');
const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');

test('automatic updater follows only protected main and builds without service secrets', () => {
  assert.match(updateScript, /readonly UPDATE_BRANCH='main'/);
  assert.match(updateScript, /\/usr\/bin\/setpriv --reuid="\$\{UPDATE_USER\}" --regid="\$\{UPDATE_USER\}" --init-groups --no-new-privs \/usr\/bin\/env -i/);
  assert.doesNotMatch(updateService, /^NoNewPrivileges=true$/m);
  assert.match(updateScript, /npm --prefix "\$\{build_dir\}" test/);
  assert.match(updateScript, /run audit:public -- --worktree/);
  assert.match(updateScript, /ci --ignore-scripts/);
  assert.doesNotMatch(updateScript, /\/etc\/even-agent\.env/);
});

test('automatic updater uses an atomic release link and rollback health gate', () => {
  assert.match(runtimeService, /WorkingDirectory=\/opt\/even-agent\/current/);
  assert.match(runtimeService, /ExecStart=\/usr\/local\/bin\/node --preserve-symlinks-main \/opt\/even-agent\/current\/src\/conversation-server\.js/);
  assert.match(updateScript, /mv -Tf "\$\{temporary_link\}" "\$\{CURRENT_LINK\}"/);
  assert.match(updateScript, /curl --fail .*127\.0\.0\.1:3001\/healthz/);
  assert.match(updateScript, /rolled back to/);
  assert.match(updateScript, /systemctl stop "\$\{SERVICE_NAME\}"[\s\S]*tar --create --gzip[\s\S]*activate_release "\$\{release_dir\}"/);
  assert.match(updateScript, /restore_pre_update_data "\$\{rollback_archive\}"[\s\S]*activate_release "\$\{previous_release\}"/);
  assert.match(updateService, /ReadWritePaths=.*\/var\/lib\/even-agent(?:\s|$)/);
});

test('migration-sensitive environment is validated before either SQLite store opens', () => {
  const config = conversationServer.indexOf('readConversationStartupConfig(process.env)');
  const jobs = conversationServer.indexOf('JobStore.create(dataDirectory');
  const conversations = conversationServer.indexOf('ConversationStore.create(dataDirectory)');
  assert.ok(config >= 0 && config < jobs && config < conversations);
});

test('automatic updater is periodic, persistent, serialized, and filesystem constrained', () => {
  assert.match(updateTimer, /OnUnitActiveSec=6h/);
  assert.match(updateTimer, /RandomizedDelaySec=30min/);
  assert.match(updateTimer, /Persistent=true/);
  assert.match(updateScript, /flock -n 9/);
  assert.match(updateService, /ProtectSystem=strict/);
  assert.match(updateService, /UMask=0077/);
  assert.match(updateService, /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETUID CAP_SETGID/);
  assert.match(updateService, /RestrictNamespaces=true/);
  assert.match(updateService, /ReadWritePaths=\/opt\/even-agent \/var\/lib\/even-agent-updater \/var\/lib\/even-agent \/run\/lock/);
});

test('production health monitoring exposes only a minimal public check and keeps Calendar probing local', () => {
  assert.match(caddy, /@backend path \/healthz \/ws\/conversation \/artifacts\/\*/);
  assert.match(healthScript, /http:\/\/127\.0\.0\.1:3001\/healthz/);
  assert.match(healthScript, /--retry 5 --retry-delay 1 --retry-all-errors/);
  assert.match(healthScript, /--resolve "\$\{PUBLIC_HOST\}:443:127\.0\.0\.1"/);
  assert.match(healthScript, /http:\/\/127\.0\.0\.1:3001\/internal\/health\/calendar/);
  assert.match(healthScript, /http:\/\/127\.0\.0\.1:3001\/internal\/health\/storage/);
  assert.match(healthScript, /storage_report=.*curl[\s\S]*--retry 5 --retry-delay 1 --retry-all-errors/);
  assert.match(healthScript, /report\.warnings\.join/);
  assert.match(healthScript, /storage capacity warning/);
  assert.match(healthService, /DynamicUser=true/);
  assert.match(healthService, /CapabilityBoundingSet=\s*$/m);
  assert.match(healthService, /ProtectSystem=strict/);
  assert.match(healthTimer, /OnUnitActiveSec=1h/);
  assert.match(healthTimer, /Persistent=true/);
  assert.doesNotMatch(healthScript, /G2_CLIENT_TOKEN|OPENAI_API_KEY|EMAIL_/);
});

test('daily backups are private, verified before pruning, and never overwrite production data', () => {
  assert.match(backupScript, /readonly DATA_ROOT='\/var\/lib\/even-agent'/);
  assert.match(backupScript, /readonly BACKUP_ROOT='\/var\/backups\/even-agent'/);
  assert.match(backupScript, /systemctl stop "\$\{SERVICE_NAME\}"/);
  assert.match(backupScript, /sha256sum/);
  assert.match(backupScript, /systemctl start "\$\{SERVICE_NAME\}"/);
  assert.match(restoreScript, /sha256sum --check --status/);
  assert.match(restoreScript, /tar -tvzf "\$\{resolved\}" \| grep -Eq '\^\[lh\]'/);
  assert.match(restoreScript, /\/usr\/local\/bin\/node "\$\{VERIFY_SCRIPT\}" "\$\{CHECK_ROOT\}"/);
  assert.match(backupScript, /systemctl stop "\$\{SERVICE_NAME\}"[\s\S]*tar --create/);
  assert.match(restoreScript, /verify-backup\.mjs/);
  assert.match(restoreScript, /conversation-restore-verify-cli\.js/);
  assert.match(restoreScript, /readonly KEEP_BACKUPS=7/);
  assert.doesNotMatch(restoreScript, /\/var\/lib\/even-agent[^'\n]*rm/);
  assert.match(backupService, /ReadWritePaths=\/var\/backups\/even-agent \/run\/lock/);
  assert.doesNotMatch(backupService, /EnvironmentFile=/);
  assert.match(restoreScript, /grep -Eq '\^GOOGLE_CALENDAR_ENABLED=true/);
  assert.match(restoreScript, /GOOGLE_CALENDAR_ENABLED="\$\{calendar_enabled\}" \/usr\/local\/bin\/node/);
  assert.match(backupService, /CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER/);
  assert.match(backupTimer, /OnCalendar=\*-\*-\* 09:00:00 UTC/);
  assert.match(backupTimer, /Persistent=true/);
});

test('server-only release includes the offline legacy migration command', () => {
  assert.match(buildScript, /legacy-session-import-cli/);
  assert.match(buildScript, /sessions:migrate/);
  assert.match(buildScript, /conversation-maintenance-cli/);
  assert.match(buildScript, /sessions:maintain/);
});
