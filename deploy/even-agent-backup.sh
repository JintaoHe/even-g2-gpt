#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly DATA_ROOT='/var/lib/even-agent'
readonly BACKUP_ROOT='/var/backups/even-agent'
readonly LOCK_FILE='/run/lock/even-agent-backup.lock'
readonly SERVICE_NAME='even-agent.service'

log() {
  printf '%s even-agent-backup: %s\n' "$(date --iso-8601=seconds)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ -d "${DATA_ROOT}" ]] || fail 'data directory is missing'
install -d -o root -g root -m 0700 "${BACKUP_ROOT}" /run/lock
exec 9>"${LOCK_FILE}"
flock -n 9 || fail 'another backup is already running'

timestamp="$(date --utc +%Y%m%dT%H%M%SZ)"
archive="${BACKUP_ROOT}/even-agent-${timestamp}.tar.gz"
partial="${archive}.partial"
checksum="${archive}.sha256"
restart_required=false
completed=false

cleanup() {
  local status=$?
  rm -f -- "${partial}"
  if [[ "${completed}" != true ]]; then
    rm -f -- "${archive}" "${checksum}"
  fi
  if [[ "${restart_required}" == true ]]; then
    systemctl start "${SERVICE_NAME}" || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  restart_required=true
  systemctl stop "${SERVICE_NAME}"
fi

tar --create --gzip --one-file-system --numeric-owner --file "${partial}" --directory "${DATA_ROOT}" .
chmod 0600 "${partial}"
mv "${partial}" "${archive}"
(
  cd "${BACKUP_ROOT}"
  sha256sum "$(basename "${archive}")" >"$(basename "${checksum}")"
)
chmod 0600 "${archive}" "${checksum}"
completed=true

if [[ "${restart_required}" == true ]]; then
  systemctl start "${SERVICE_NAME}"
  restart_required=false
fi

trap - EXIT
log "created $(basename "${archive}"); application state restored"
