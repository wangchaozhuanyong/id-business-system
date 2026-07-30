#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-30}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.production.example and fill production values first." >&2
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

if ! docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --services |
  grep -Fxq postgres; then
  echo "Configured compose file does not define a postgres service." >&2
  echo "This command cannot back up a managed Supabase/PostgreSQL database." >&2
  echo "Use the provider-approved backup workflow and record restore-drill evidence instead." >&2
  exit 1
fi

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/${POSTGRES_DB}-$(date +%Y%m%d-%H%M%S).dump"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -Fc "${POSTGRES_DB}" >"${BACKUP_FILE}"

if [[ ! -s "${BACKUP_FILE}" ]]; then
  echo "Backup file is empty; refusing to continue." >&2
  exit 1
fi

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  pg_restore --list <"${BACKUP_FILE}" >/dev/null

chmod 600 "${BACKUP_FILE}"
echo "Backup written to ${BACKUP_FILE}"

prune_old_backups_by_days() {
  local days="${1}"
  if ! [[ "${days}" =~ ^[0-9]+$ ]] || [[ "${days}" == "0" ]]; then
    return
  fi

  find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.dump" -mtime +"${days}" -print -delete
}

prune_old_backups_by_count() {
  local keep_count="${1}"
  if ! [[ "${keep_count}" =~ ^[0-9]+$ ]] || [[ "${keep_count}" == "0" ]]; then
    return
  fi

  local delete_from
  delete_from=$((keep_count + 1))
  while IFS= read -r backup; do
    [[ -z "${backup}" ]] && continue
    rm -f "${backup}"
    echo "Deleted old backup ${backup}"
  done < <(ls -1t "${BACKUP_DIR}/${POSTGRES_DB}-"*.dump 2>/dev/null | tail -n +"${delete_from}")
}

if [[ "${BACKUP_PRUNE_CONFIRMED:-}" == "YES" ]]; then
  prune_old_backups_by_days "${BACKUP_RETENTION_DAYS}"
  prune_old_backups_by_count "${BACKUP_RETENTION_COUNT}"
else
  echo "Backup pruning skipped; set BACKUP_PRUNE_CONFIRMED=YES only after restore verification."
fi
