#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_FILE="${1:-}"
TEMP_DB="${RESTORE_DRILL_DB:-restore_drill_$(date +%Y%m%d_%H%M%S)_${RANDOM}}"

if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
  echo "Backup file is required." >&2
  echo "Usage: $0 backups/postgres/file.dump" >&2
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

if ! [[ "${TEMP_DB}" =~ ^restore_drill_[A-Za-z0-9_]{1,48}$ ]] ||
  [[ "${TEMP_DB}" == "${POSTGRES_DB}" ]]; then
  echo "RESTORE_DRILL_DB must be an isolated restore_drill_* database, never POSTGRES_DB." >&2
  exit 1
fi

if ! docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --services |
  grep -Fxq postgres; then
  echo "Configured compose file does not define a postgres service." >&2
  echo "Run the managed-database restore drill through an isolated provider project instead." >&2
  exit 1
fi

cleanup() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
    dropdb -U "${POSTGRES_USER}" --if-exists "${TEMP_DB}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Creating temporary restore database ${TEMP_DB}"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  createdb -U "${POSTGRES_USER}" "${TEMP_DB}"

echo "Restoring ${BACKUP_FILE} into ${TEMP_DB}"
cat "${BACKUP_FILE}" | docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_restore -U "${POSTGRES_USER}" -d "${TEMP_DB}" --no-owner --no-acl

echo "Checking restored schema and key table counts"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${TEMP_DB}" -v ON_ERROR_STOP=1 -Atc "
    select 'users=' || count(*) from public.users;
    select 'roles=' || count(*) from public.roles;
    select 'permissions=' || count(*) from public.permissions;
    select 'audit_logs=' || count(*) from public.audit_logs;
    select 'v2_auth_identities=' || count(*) from public.v2_auth_identities;
    select 'id_business_v2_options=' || count(*) from public.id_business_v2_options;
    select 'id_business_v2_customers=' || count(*) from public.id_business_v2_customers;
    select 'id_business_v2_accounts=' || count(*) from public.id_business_v2_accounts;
    select 'id_business_v2_gift_cards=' || count(*) from public.id_business_v2_gift_cards;
    select 'id_business_v2_orders=' || count(*) from public.id_business_v2_orders;
    select 'id_business_v2_activations=' || count(*) from public.id_business_v2_activations;
  "

echo "Restore drill completed successfully for ${BACKUP_FILE}"
