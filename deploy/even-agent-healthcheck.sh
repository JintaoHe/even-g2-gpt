#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly PUBLIC_HOST='calendar.eveng2assistant.com'
readonly LOCAL_URL='http://127.0.0.1:3001/healthz'
readonly CALENDAR_URL='http://127.0.0.1:3001/internal/health/calendar'
readonly STORAGE_URL='http://127.0.0.1:3001/internal/health/storage'
readonly DRIFT_CHECK='/usr/local/sbin/even-agent-drift-check'

log() {
  printf '%s even-agent-health: %s\n' "$(date --iso-8601=seconds)" "$*"
}

curl --fail --silent --show-error --output /dev/null --max-time 5 \
  --retry 5 --retry-delay 1 --retry-all-errors "${LOCAL_URL}"
curl --fail --silent --show-error --output /dev/null --max-time 10 \
  --retry 5 --retry-delay 1 --retry-all-errors \
  --resolve "${PUBLIC_HOST}:443:127.0.0.1" "https://${PUBLIC_HOST}/healthz"
curl --fail --silent --show-error --output /dev/null --max-time 15 \
  --retry 2 --retry-delay 1 --retry-all-errors "${CALENDAR_URL}"
storage_report="$(curl --fail --silent --show-error --max-time 10 \
  --retry 5 --retry-delay 1 --retry-all-errors "${STORAGE_URL}")"
if ! storage_warnings="$(printf '%s' "${storage_report}" | /usr/local/bin/node -e '
  const report = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (!report || !["ok", "warning"].includes(report.status) || !Array.isArray(report.warnings)
    || report.warnings.some(value => typeof value !== "string")) process.exit(2);
  process.stdout.write(report.warnings.join(","));
')"; then
  log 'storage health response was invalid'
  exit 1
fi
if [[ -n "${storage_warnings}" ]]; then
  log "storage capacity warning: ${storage_warnings}"
  exit 1
fi

drift_status=0
drift_report=''
if drift_report="$("${DRIFT_CHECK}" 2>&1)"; then
  :
else
  drift_status=$?
  case "${drift_status}" in
    1) log 'operational file drift detected; compare installed files with the current release' ;;
    2) log 'operational drift map references a source missing from the current release' ;;
    *) log "operational drift check failed unexpectedly with exit ${drift_status}" ;;
  esac
  printf '%s\n' "${drift_report}" >&2
  /usr/bin/logger -p daemon.err -t even-agent-health \
    "Operational file drift check failed with exit ${drift_status}; inspect even-agent-healthcheck.service"
  exit "${drift_status}"
fi

log 'local app, TLS ingress, read-only Calendar, storage, and operational drift probes passed'
