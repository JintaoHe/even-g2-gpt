#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly PUBLIC_HOST='calendar.eveng2assistant.com'
readonly LOCAL_URL='http://127.0.0.1:3001/healthz'
readonly CALENDAR_URL='http://127.0.0.1:3001/internal/health/calendar'

log() {
  printf '%s even-agent-health: %s\n' "$(date --iso-8601=seconds)" "$*"
}

curl --fail --silent --show-error --output /dev/null --max-time 5 "${LOCAL_URL}"
curl --fail --silent --show-error --output /dev/null --max-time 10 \
  --resolve "${PUBLIC_HOST}:443:127.0.0.1" "https://${PUBLIC_HOST}/healthz"
curl --fail --silent --show-error --output /dev/null --max-time 15 "${CALENDAR_URL}"

log 'local app, TLS ingress, and read-only Calendar probe passed'
