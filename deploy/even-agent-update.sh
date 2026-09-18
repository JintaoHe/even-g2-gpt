#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

readonly REPOSITORY_URL='https://github.com/JintaoHe/even-g2-gpt.git'
readonly UPDATE_BRANCH='main'
readonly UPDATE_USER='even-deploy'
readonly UPDATE_ROOT='/var/lib/even-agent-updater'
readonly REPOSITORY_DIR="${UPDATE_ROOT}/repository"
readonly BUILD_ROOT="${UPDATE_ROOT}/builds"
readonly STAGING_ROOT="${UPDATE_ROOT}/staging"
readonly RELEASE_ROOT='/opt/even-agent/releases'
readonly CURRENT_LINK='/opt/even-agent/current'
readonly LOCK_FILE='/run/lock/even-agent-update.lock'
readonly SERVICE_NAME='even-agent.service'

log() {
  printf '%s even-agent-update: %s\n' "$(date --iso-8601=seconds)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

run_as_deployer() {
  runuser -u "${UPDATE_USER}" -- env -i \
    HOME="${UPDATE_ROOT}/home" \
    PATH='/usr/local/bin:/usr/bin:/bin' \
    npm_config_cache="${UPDATE_ROOT}/npm-cache" \
    "$@"
}

safe_remove_build_path() {
  local target="$1"
  case "${target}" in
    "${BUILD_ROOT}"/*|"${STAGING_ROOT}"/*) rm -rf -- "${target}" ;;
    *) fail "refusing to remove path outside updater work roots" ;;
  esac
}

activate_release() {
  local target="$1"
  local temporary_link="/opt/even-agent/.current-$2"
  ln -s "${target}" "${temporary_link}"
  mv -Tf "${temporary_link}" "${CURRENT_LINK}"
}

install -d -o root -g root -m 0755 /run/lock /opt/even-agent "${RELEASE_ROOT}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log 'another update is already running; exiting'
  exit 0
fi

id "${UPDATE_USER}" >/dev/null 2>&1 || fail "missing system account ${UPDATE_USER}"
install -d -o "${UPDATE_USER}" -g "${UPDATE_USER}" -m 0700 \
  "${UPDATE_ROOT}" "${UPDATE_ROOT}/home" "${UPDATE_ROOT}/npm-cache" \
  "${BUILD_ROOT}" "${STAGING_ROOT}"

if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
  [[ ! -e "${REPOSITORY_DIR}" ]] || fail 'repository path exists but is not a Git checkout'
  run_as_deployer git clone --filter=blob:none --no-checkout --single-branch \
    --branch "${UPDATE_BRANCH}" "${REPOSITORY_URL}" "${REPOSITORY_DIR}"
fi

actual_origin="$(run_as_deployer git -C "${REPOSITORY_DIR}" remote get-url origin)"
[[ "${actual_origin}" == "${REPOSITORY_URL}" ]] || fail 'repository origin does not match the pinned public repository'

run_as_deployer git -C "${REPOSITORY_DIR}" fetch --force --prune --no-tags origin \
  "+refs/heads/${UPDATE_BRANCH}:refs/remotes/origin/${UPDATE_BRANCH}"
commit="$(run_as_deployer git -C "${REPOSITORY_DIR}" rev-parse --verify "refs/remotes/origin/${UPDATE_BRANCH}^{commit}")"
[[ "${commit}" =~ ^[0-9a-f]{40}$ ]] || fail 'remote main did not resolve to a full commit ID'

current_commit=''
if [[ -r "${CURRENT_LINK}/RELEASE-COMMIT" ]]; then
  current_commit="$(<"${CURRENT_LINK}/RELEASE-COMMIT")"
fi
if [[ "${current_commit}" == "${commit}" ]]; then
  log "main is already deployed at ${commit:0:12}"
  exit 0
fi

build_dir="${BUILD_ROOT}/${commit}"
stage_dir="${STAGING_ROOT}/${commit}"
if [[ -e "${build_dir}" ]]; then
  run_as_deployer git -C "${REPOSITORY_DIR}" worktree remove --force "${build_dir}" 2>/dev/null || true
fi
safe_remove_build_path "${build_dir}"
safe_remove_build_path "${stage_dir}"
install -d -o "${UPDATE_USER}" -g "${UPDATE_USER}" -m 0700 "${stage_dir}"

log "building protected main commit ${commit:0:12} as ${UPDATE_USER}"
run_as_deployer git -C "${REPOSITORY_DIR}" worktree add --detach "${build_dir}" "${commit}"
run_as_deployer npm --prefix "${build_dir}" ci --ignore-scripts --no-audit --no-fund
run_as_deployer npm --prefix "${build_dir}" run typecheck
run_as_deployer npm --prefix "${build_dir}" test
run_as_deployer npm --prefix "${build_dir}" run audit:public -- --worktree
run_as_deployer npm --prefix "${build_dir}" run build:server

mapfile -t server_builds < <(find "${build_dir}/dist" -mindepth 1 -maxdepth 1 -type d -name 'server-*' -print)
[[ "${#server_builds[@]}" -eq 1 ]] || fail 'server build did not produce exactly one release directory'
run_as_deployer cp -a "${server_builds[0]}/." "${stage_dir}/"
run_as_deployer npm --prefix "${stage_dir}" ci --omit=dev --ignore-scripts --no-audit --no-fund
printf '%s\n' "${commit}" >"${stage_dir}/RELEASE-COMMIT"

release_dir="${RELEASE_ROOT}/${commit}"
[[ ! -e "${release_dir}" ]] || fail 'target release directory already exists unexpectedly'
temporary_release="${RELEASE_ROOT}/.${commit}.installing"
[[ ! -e "${temporary_release}" ]] || fail 'stale release installation directory needs operator review'
cp -a "${stage_dir}" "${temporary_release}"
chown -R root:root "${temporary_release}"
find "${temporary_release}" -type d -exec chmod 0755 {} +
find "${temporary_release}" -type f -exec chmod 0644 {} +
mv "${temporary_release}" "${release_dir}"

previous_release="$(readlink -f "${CURRENT_LINK}" 2>/dev/null || true)"
activate_release "${release_dir}" "${commit}"
log "activated ${commit:0:12}; restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

healthy=false
for _ in 1 2 3 4 5; do
  if systemctl is-active --quiet "${SERVICE_NAME}" && \
    curl --silent --show-error --output /dev/null --max-time 3 http://127.0.0.1:3001/; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "${healthy}" == true ]]; then
  log "deployment ${commit:0:12} passed the local service check"
  run_as_deployer git -C "${REPOSITORY_DIR}" worktree remove --force "${build_dir}"
  safe_remove_build_path "${stage_dir}"
  exit 0
fi

log "new release failed its health check"
if [[ -n "${previous_release}" && -d "${previous_release}" && "${previous_release}" == "${RELEASE_ROOT}/"* ]]; then
  activate_release "${previous_release}" "rollback-${commit}"
  systemctl restart "${SERVICE_NAME}" || true
  fail "rolled back to $(basename "${previous_release}")"
fi
fail 'no valid previous release was available for automatic rollback'
