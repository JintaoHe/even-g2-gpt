#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly BACKUP_ROOT='/var/backups/even-agent'
readonly CHECK_ROOT='/var/backups/even-agent/.restore-check'
readonly VERIFY_SCRIPT='/usr/local/lib/even-agent/verify-backup.mjs'
readonly STORE_VERIFY_SCRIPT='/opt/even-agent/current/src/conversation-restore-verify-cli.js'
readonly APPLICATION_ENV='/etc/even-agent.env'
readonly KEEP_BACKUPS=7

log() {
  printf '%s even-agent-restore-check: %s\n' "$(date --iso-8601=seconds)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

safe_remove_check_root() {
  [[ "${CHECK_ROOT}" == '/var/backups/even-agent/.restore-check' ]] || fail 'unexpected restore-check path'
  rm -rf -- "${CHECK_ROOT}"
}

archive="${1:-}"
if [[ -z "${archive}" ]]; then
  archive="$(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'even-agent-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi
[[ -n "${archive}" && -f "${archive}" ]] || fail 'no backup archive is available'
resolved="$(readlink -f "${archive}")"
[[ "${resolved}" == "${BACKUP_ROOT}/"even-agent-*.tar.gz ]] || fail 'archive is outside the fixed backup directory'
checksum="${resolved}.sha256"
[[ -f "${checksum}" ]] || fail 'backup checksum is missing'
(
  cd "${BACKUP_ROOT}"
  sha256sum --check --status "$(basename "${checksum}")"
) || fail 'backup checksum does not match'

while IFS= read -r entry; do
  [[ "${entry}" == '.' || "${entry}" == './' || "${entry}" == ./* ]] || fail 'archive contains a non-relative path'
  [[ "${entry}" != *'/../'* && "${entry}" != '../'* && "${entry}" != *'/..' ]] || fail 'archive contains path traversal'
done < <(tar -tzf "${resolved}")
if tar -tvzf "${resolved}" | grep -Eq '^[lh]'; then
  fail 'archive contains a link'
fi

safe_remove_check_root
install -d -o root -g root -m 0700 "${CHECK_ROOT}"
trap safe_remove_check_root EXIT
tar --extract --gzip --file "${resolved}" --directory "${CHECK_ROOT}" --no-same-owner --no-same-permissions
calendar_enabled=false
if [[ -f "${APPLICATION_ENV}" ]] && grep -Eq '^GOOGLE_CALENDAR_ENABLED=true[[:space:]]*$' "${APPLICATION_ENV}"; then
  calendar_enabled=true
fi
GOOGLE_CALENDAR_ENABLED="${calendar_enabled}" /usr/local/bin/node "${VERIFY_SCRIPT}" "${CHECK_ROOT}"
/usr/local/bin/node "${STORE_VERIFY_SCRIPT}" "${CHECK_ROOT}"
safe_remove_check_root
trap - EXIT

mapfile -t backups < <(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'even-agent-*.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
for ((index=KEEP_BACKUPS; index<${#backups[@]}; index++)); do
  old="${backups[index]}"
  [[ "${old}" == "${BACKUP_ROOT}/"even-agent-*.tar.gz ]] || fail 'refusing to prune an unexpected path'
  rm -f -- "${old}" "${old}.sha256"
done

log "verified $(basename "${resolved}"); retained at most ${KEEP_BACKUPS} backups"
