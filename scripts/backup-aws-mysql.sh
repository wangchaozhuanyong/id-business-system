#!/usr/bin/env bash
set -euo pipefail

umask 077

deployment_directory="/opt/id-business-v2/current"
backup_directory="/opt/id-business-v2/backups/mysql"
environment_file="${deployment_directory}/.env.aws.production"
compose_file="${deployment_directory}/docker-compose.aws-mysql.yml"
normalizer_script="${deployment_directory}/scripts/mysql-dump-restore-normalizer.sed"

if [[ ! -f "${environment_file}" || ! -f "${compose_file}" ]]; then
  echo "AWS MySQL 生产部署文件不存在" >&2
  exit 1
fi
if [[ ! -f "${normalizer_script}" ]]; then
  echo "MySQL 备份规范化规则不存在" >&2
  exit 1
fi

mkdir -p "${backup_directory}"
chmod 700 "${backup_directory}"

lock_file="${backup_directory}/.backup.lock"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "另一个 MySQL 备份任务正在运行" >&2
  exit 1
fi

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
local_retention_count="$(read_environment_value MYSQL_BACKUP_LOCAL_RETENTION_COUNT)"
local_max_bytes="$(read_environment_value MYSQL_BACKUP_LOCAL_MAX_BYTES)"
minimum_free_bytes="$(read_environment_value MYSQL_BACKUP_MIN_FREE_BYTES)"
s3_prefix="${s3_prefix:-mysql/daily}"
s3_region="${s3_region:-ap-northeast-1}"
local_retention_count="${local_retention_count:-48}"
local_max_bytes="${local_max_bytes:-1073741824}"
minimum_free_bytes="${minimum_free_bytes:-2147483648}"

if [[ -z "${s3_bucket}" ]]; then
  echo "MYSQL_BACKUP_S3_BUCKET 未配置，禁止只在 EC2 本机生成备份" >&2
  exit 1
fi
if [[ ! "${s3_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
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
if [[ ! "${local_retention_count}" =~ ^[1-9][0-9]*$ ]] || ((local_retention_count < 2 || local_retention_count > 336)); then
  echo "MYSQL_BACKUP_LOCAL_RETENTION_COUNT 必须是 2 到 336 之间的整数" >&2
  exit 1
fi
if [[ ! "${local_max_bytes}" =~ ^[1-9][0-9]*$ ]] || ((local_max_bytes < 67108864)); then
  echo "MYSQL_BACKUP_LOCAL_MAX_BYTES 必须是不小于 67108864 的整数" >&2
  exit 1
fi
if [[ ! "${minimum_free_bytes}" =~ ^[1-9][0-9]*$ ]] || ((minimum_free_bytes < 67108864)); then
  echo "MYSQL_BACKUP_MIN_FREE_BYTES 必须是不小于 67108864 的整数" >&2
  exit 1
fi

for required_command in aws docker gzip openssl stat flock; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "备份依赖命令不存在：${required_command}" >&2
    exit 1
  fi
done

prune_local_backups() {
  local -a backup_files
  local total_bytes=0
  local file
  local file_size

  mapfile -t backup_files < <(
    find "${backup_directory}" -maxdepth 1 -type f -name 'id-business-v2-*.sql.gz' -print | sort
  )

  while ((${#backup_files[@]} > local_retention_count)); do
    rm -f -- "${backup_files[0]}"
    backup_files=("${backup_files[@]:1}")
  done

  for file in "${backup_files[@]}"; do
    file_size="$(stat -c %s "${file}")"
    total_bytes=$((total_bytes + file_size))
  done

  while ((total_bytes > local_max_bytes && ${#backup_files[@]} > 1)); do
    file_size="$(stat -c %s "${backup_files[0]}")"
    rm -f -- "${backup_files[0]}"
    total_bytes=$((total_bytes - file_size))
    backup_files=("${backup_files[@]:1}")
  done

  if ((total_bytes > local_max_bytes)); then
    echo "最新备份已超过本机备份容量上限，请调整 MYSQL_BACKUP_LOCAL_MAX_BYTES" >&2
    return 1
  fi
}

# 先清理既有超额备份，再检查空间，避免旧文件占满磁盘后任务无法自愈。
prune_local_backups
find "${backup_directory}" -maxdepth 1 -type f -name '.id-business-v2-*.sql.gz.partial' -mmin +180 -delete
available_bytes="$(df -PB1 "${backup_directory}" | awk 'NR == 2 { print $4 }')"
if [[ ! "${available_bytes}" =~ ^[0-9]+$ ]] || ((available_bytes < minimum_free_bytes)); then
  echo "备份目录可用空间不足：${available_bytes:-unknown} bytes" >&2
  exit 1
fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial_file="${backup_directory}/.id-business-v2-${stamp}.sql.gz.partial"
backup_file="${backup_directory}/id-business-v2-${stamp}.sql.gz"

cd "${deployment_directory}"
docker compose --env-file "${environment_file}" -f "${compose_file}" exec -T mysql \
  sh -c 'exec mysqldump --host=127.0.0.1 --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" --single-transaction --quick --hex-blob --no-tablespaces --triggers "$MYSQL_DATABASE"' \
  | sed -E -f "${normalizer_script}" \
  | gzip -9 >"${partial_file}"

gzip -t "${partial_file}"
if [[ ! -s "${partial_file}" ]]; then
  echo "MySQL 备份文件为空" >&2
  exit 1
fi

mv "${partial_file}" "${backup_file}"
chmod 600 "${backup_file}"

object_key="${s3_prefix%/}/$(basename "${backup_file}")"
local_size="$(stat -c %s "${backup_file}")"
local_checksum_base64="$(openssl dgst -sha256 -binary "${backup_file}" | openssl base64 -A)"
local_checksum_hex="$(openssl dgst -sha256 "${backup_file}" | awk '{ print $NF }')"

aws s3api put-object \
  --region "${s3_region}" \
  --bucket "${s3_bucket}" \
  --key "${object_key}" \
  --body "${backup_file}" \
  --server-side-encryption AES256 \
  --checksum-algorithm SHA256 >/dev/null

read -r remote_size remote_checksum_base64 <<<"$(
  aws s3api head-object \
    --region "${s3_region}" \
    --bucket "${s3_bucket}" \
    --key "${object_key}" \
    --checksum-mode ENABLED \
    --query '[ContentLength, ChecksumSHA256]' \
    --output text
)"
if [[ "${remote_size}" != "${local_size}" ]]; then
  echo "S3 备份大小校验失败：本地 ${local_size}，远端 ${remote_size}" >&2
  exit 1
fi
if [[ -z "${remote_checksum_base64}" || "${remote_checksum_base64}" == "None" || "${remote_checksum_base64}" != "${local_checksum_base64}" ]]; then
  echo "S3 备份 SHA-256 校验失败" >&2
  exit 1
fi

prune_local_backups

echo "MySQL S3 backup verified: s3://${s3_bucket}/${object_key}"
echo "MySQL backup SHA-256: ${local_checksum_hex}"
echo "MySQL backup completed: ${backup_file}"
