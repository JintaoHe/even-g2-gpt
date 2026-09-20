#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly PUBLIC_HOST='calendar.eveng2assistant.com'
readonly LOCAL_URL='http://127.0.0.1:3001/healthz'
readonly CALENDAR_URL='http://127.0.0.1:3001/internal/health/calendar'
readonly STORAGE_URL='http://127.0.0.1:3001/internal/health/storage'

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
curl --fail --silent --show-error --output /dev/null --max-time 10 "${STORAGE_URL}"

log 'local app, TLS ingress, read-only Calendar, and storage probes passed'
