#!/usr/bin/env bash
set -euo pipefail

umask 077

deployment_directory="/opt/id-business-v2/current"
backup_directory="/opt/id-business-v2/backups/mysql"
environment_file="${deployment_directory}/.env.aws.production"
compose_file="${deployment_directory}/docker-compose.aws-mysql.yml"

if [[ ! -f "${environment_file}" || ! -f "${compose_file}" ]]; then
  echo "AWS MySQL 生产部署文件不存在" >&2
  exit 1
fi

mkdir -p "${backup_directory}"
chmod 700 "${backup_directory}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial_file="${backup_directory}/.id-business-v2-${stamp}.sql.gz.partial"
backup_file="${backup_directory}/id-business-v2-${stamp}.sql.gz"

cd "${deployment_directory}"
docker compose --env-file "${environment_file}" -f "${compose_file}" exec -T mysql \
  sh -c 'exec mysqldump --host=127.0.0.1 --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" --single-transaction --quick --hex-blob --no-tablespaces --triggers "$MYSQL_DATABASE"' \
  | gzip -9 >"${partial_file}"

gzip -t "${partial_file}"
if [[ ! -s "${partial_file}" ]]; then
  echo "MySQL 备份文件为空" >&2
  exit 1
fi

mv "${partial_file}" "${backup_file}"
chmod 600 "${backup_file}"
echo "MySQL backup completed: ${backup_file}"
