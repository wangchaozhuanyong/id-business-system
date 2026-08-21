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

read_environment_value() {
  local key="$1"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "${environment_file}"
}

s3_bucket="$(read_environment_value MYSQL_BACKUP_S3_BUCKET)"
s3_prefix="$(read_environment_value MYSQL_BACKUP_S3_PREFIX)"
s3_region="$(read_environment_value MYSQL_BACKUP_S3_REGION)"
s3_prefix="${s3_prefix:-mysql/daily}"
s3_region="${s3_region:-ap-northeast-1}"

if [[ -n "${s3_bucket}" && ! "${s3_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "MYSQL_BACKUP_S3_BUCKET 格式无效" >&2
  exit 1
fi
if [[ ! "${s3_prefix}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
  echo "MYSQL_BACKUP_S3_PREFIX 格式无效" >&2
  exit 1
fi
if [[ ! "${s3_region}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]; then
  echo "MYSQL_BACKUP_S3_REGION 格式无效" >&2
  exit 1
fi

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

if [[ -n "${s3_bucket}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "已配置 S3 备份，但服务器缺少 AWS CLI" >&2
    exit 1
  fi

  object_key="${s3_prefix%/}/$(basename "${backup_file}")"
  local_size="$(stat -c %s "${backup_file}")"
  aws s3api put-object \
    --region "${s3_region}" \
    --bucket "${s3_bucket}" \
    --key "${object_key}" \
    --body "${backup_file}" \
    --server-side-encryption AES256 \
    --checksum-algorithm SHA256 >/dev/null
  remote_size="$(
    aws s3api head-object \
      --region "${s3_region}" \
      --bucket "${s3_bucket}" \
      --key "${object_key}" \
      --query ContentLength \
      --output text
  )"
  if [[ "${remote_size}" != "${local_size}" ]]; then
    echo "S3 备份大小校验失败：本地 ${local_size}，远端 ${remote_size}" >&2
    exit 1
  fi
  echo "MySQL S3 backup verified: s3://${s3_bucket}/${object_key}"
fi

echo "MySQL backup completed: ${backup_file}"
