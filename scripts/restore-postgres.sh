#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_FILE="${1:-}"
RESTORE_TARGET_DB="${RESTORE_TARGET_DB:-}"

if [[ "${CONFIRM_ISOLATED_RESTORE:-}" != "YES" ]]; then
  echo "Refusing to restore without CONFIRM_ISOLATED_RESTORE=YES." >&2
  echo "Live production restore is intentionally unsupported." >&2
  echo "Usage: RESTORE_TARGET_DB=restore_drill_name CONFIRM_ISOLATED_RESTORE=YES $0 dump" >&2
  exit 1
fi

if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
  echo "Backup file is required." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}." >&2
  exit 1
fi

load_env_file() {
  local line key value

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "${key}=${value}"
  done <"${1}"
}

load_env_file "${ENV_FILE}"

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

if ! [[ "${RESTORE_TARGET_DB}" =~ ^restore_drill_[A-Za-z0-9_]{1,48}$ ]] ||
  [[ "${RESTORE_TARGET_DB}" == "${POSTGRES_DB}" ]]; then
  echo "RESTORE_TARGET_DB must be an isolated restore_drill_* database, never POSTGRES_DB." >&2
  exit 1
fi

if ! docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --services |
  grep -Fxq postgres; then
  echo "Configured compose file does not define a postgres service." >&2
  echo "Managed production databases must be restored into an isolated provider project." >&2
  exit 1
fi

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  createdb -U "${POSTGRES_USER}" "${RESTORE_TARGET_DB}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_restore -U "${POSTGRES_USER}" -d "${RESTORE_TARGET_DB}" --no-owner --no-acl <"${BACKUP_FILE}"

echo "Isolated restore completed from ${BACKUP_FILE} into ${RESTORE_TARGET_DB}"
