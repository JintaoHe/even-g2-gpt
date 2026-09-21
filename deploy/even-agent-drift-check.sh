#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly CURRENT_ROOT="${EVEN_AGENT_DRIFT_CURRENT_ROOT:-/opt/even-agent/current}"
readonly INSTALLED_ROOT="${EVEN_AGENT_DRIFT_INSTALLED_ROOT:-}"

# Keep this table explicit and machine-readable. tests/deploy-drift.test.ts
# verifies both directions: every source exists and every installable deploy
# artifact is governed here.
readonly -a OPERATIONAL_FILE_MAPPINGS=(
  '/usr/local/sbin/even-agent-update|deploy/even-agent-update.sh'
  '/usr/local/sbin/even-agent-healthcheck|deploy/even-agent-healthcheck.sh'
  '/usr/local/sbin/even-agent-backup|deploy/even-agent-backup.sh'
  '/usr/local/sbin/even-agent-restore-check|deploy/even-agent-restore-check.sh'
  '/usr/local/sbin/even-agent-drift-check|deploy/even-agent-drift-check.sh'
  '/etc/systemd/system/even-agent.service|deploy/even-agent.service'
  '/etc/systemd/system/even-agent-update.service|deploy/even-agent-update.service'
  '/etc/systemd/system/even-agent-backup.service|deploy/even-agent-backup.service'
  '/etc/systemd/system/even-agent-healthcheck.service|deploy/even-agent-healthcheck.service'
  '/etc/systemd/system/even-agent-soak@.service|deploy/even-agent-soak@.service'
  '/etc/systemd/system/even-agent-health-failure@.service|deploy/even-agent-health-failure@.service'
  '/etc/systemd/system/even-agent-update.timer|deploy/even-agent-update.timer'
  '/etc/systemd/system/even-agent-backup.timer|deploy/even-agent-backup.timer'
  '/etc/systemd/system/even-agent-healthcheck.timer|deploy/even-agent-healthcheck.timer'
  '/etc/caddy/Caddyfile|deploy/Caddyfile'
  '/etc/systemd/journald.conf.d/even-agent.conf|deploy/even-agent-journald.conf'
)

drift_found=false
source_missing=false

for mapping in "${OPERATIONAL_FILE_MAPPINGS[@]}"; do
  installed_path="${mapping%%|*}"
  source_relative="${mapping#*|}"
  resolved_installed_path="${INSTALLED_ROOT}${installed_path}"
  source_path="${CURRENT_ROOT}/${source_relative}"

  if [[ ! -f "${source_path}" ]]; then
    printf 'SOURCE_MISSING %s\n' "${source_path}" >&2
    source_missing=true
    continue
  fi

  if [[ ! -f "${resolved_installed_path}" ]] || ! cmp -s -- "${resolved_installed_path}" "${source_path}"; then
    printf 'DRIFT %s != %s\n' "${resolved_installed_path}" "${source_path}" >&2
    drift_found=true
  fi
done

if [[ "${source_missing}" == true ]]; then
  exit 2
fi
if [[ "${drift_found}" == true ]]; then
  exit 1
fi

printf 'OK %s operational files match the current release\n' "${#OPERATIONAL_FILE_MAPPINGS[@]}"
