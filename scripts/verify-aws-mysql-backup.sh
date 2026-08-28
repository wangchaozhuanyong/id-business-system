#!/usr/bin/env bash
set -euo pipefail

umask 077

deployment_directory="/opt/id-business-v2/current"
environment_file="${deployment_directory}/.env.aws.production"
normalizer_script="${deployment_directory}/scripts/mysql-dump-restore-normalizer.sed"
mysql_image="mysql:8.4"
restore_database="id_business_v2_restore"
archive_file=""
downloaded_object_key=""
temporary_directory=""
container_name="id-business-v2-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"

usage() {
  echo "Usage: $0 [--archive=/absolute/path/to/backup.sql.gz]" >&2
}

for argument in "$@"; do
  case "${argument}" in
    --archive=*) archive_file="${argument#--archive=}" ;;
    --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

read_environment_value() {
  local key="$1"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "${environment_file}"
}

for required_command in docker gzip openssl; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "恢复验证依赖命令不存在：${required_command}" >&2
    exit 1
  fi
done
if [[ ! -f "${normalizer_script}" ]]; then
  echo "MySQL 备份恢复规范化规则不存在" >&2
  exit 1
fi

cleanup() {
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf -- "${temporary_directory}"
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "${archive_file}" ]]; then
  if [[ "${archive_file}" != /* || ! -f "${archive_file}" ]]; then
    echo "--archive 必须指向存在的绝对路径备份文件" >&2
    exit 1
  fi
else
  if [[ ! -f "${environment_file}" ]]; then
    echo "AWS MySQL 生产环境文件不存在" >&2
    exit 1
  fi
  for required_command in aws mktemp; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
      echo "S3 恢复验证依赖命令不存在：${required_command}" >&2
      exit 1
    fi
  done

  s3_bucket="$(read_environment_value MYSQL_BACKUP_S3_BUCKET)"
  s3_prefix="$(read_environment_value MYSQL_BACKUP_S3_PREFIX)"
  s3_region="$(read_environment_value MYSQL_BACKUP_S3_REGION)"
  s3_prefix="${s3_prefix:-mysql/daily}"
  s3_region="${s3_region:-ap-northeast-1}"

  if [[ -z "${s3_bucket}" || ! "${s3_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
    echo "MYSQL_BACKUP_S3_BUCKET 未配置或格式无效" >&2
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

  temporary_directory="$(mktemp -d /tmp/id-business-v2-mysql-restore.XXXXXX)"
  downloaded_object_key="$(
    aws s3api list-objects-v2 \
      --region "${s3_region}" \
      --bucket "${s3_bucket}" \
      --prefix "${s3_prefix%/}/id-business-v2-" \
      --query 'sort_by(Contents[?Size > `0`], &LastModified)[-1].Key' \
      --output text
  )"
  if [[ -z "${downloaded_object_key}" || "${downloaded_object_key}" == "None" ]]; then
    echo "S3 中没有可用的 MySQL 备份" >&2
    exit 1
  fi
  object_filename="${downloaded_object_key##*/}"
  if [[ "${downloaded_object_key}" != "${s3_prefix%/}/id-business-v2-"* ]] ||
    [[ ! "${object_filename}" =~ ^id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]]; then
    echo "S3 最新对象键不符合备份命名规则" >&2
    exit 1
  fi

  archive_file="${temporary_directory}/backup.sql.gz"
  remote_checksum_base64="$(
    aws s3api head-object \
      --region "${s3_region}" \
      --bucket "${s3_bucket}" \
      --key "${downloaded_object_key}" \
      --checksum-mode ENABLED \
      --query ChecksumSHA256 \
      --output text
  )"
  if [[ -z "${remote_checksum_base64}" || "${remote_checksum_base64}" == "None" ]]; then
    echo "S3 备份缺少 SHA-256 校验和" >&2
    exit 1
  fi
  aws s3api get-object \
    --region "${s3_region}" \
    --bucket "${s3_bucket}" \
    --key "${downloaded_object_key}" \
    --checksum-mode ENABLED \
    "${archive_file}" >/dev/null
  local_checksum_base64="$(openssl dgst -sha256 -binary "${archive_file}" | openssl base64 -A)"
  if [[ "${local_checksum_base64}" != "${remote_checksum_base64}" ]]; then
    echo "下载后的备份 SHA-256 与 S3 不一致" >&2
    exit 1
  fi
fi

gzip -t "${archive_file}"
if [[ ! -s "${archive_file}" ]]; then
  echo "MySQL 备份文件为空" >&2
  exit 1
fi

restore_password="$(openssl rand -hex 24)"
docker run --detach --rm \
  --name "${container_name}" \
  --network none \
  --label id-business-v2.restore-drill=true \
  --env MYSQL_ROOT_PASSWORD="${restore_password}" \
  --env MYSQL_DATABASE="${restore_database}" \
  "${mysql_image}" \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_0900_ai_ci \
  --default-time-zone=+00:00 \
  --sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION >/dev/null

mysql_ready=false
for _ in $(seq 1 60); do
  if docker exec "${container_name}" sh -c \
    'mysqladmin ping --host=127.0.0.1 --user=root --password="$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1; then
    mysql_ready=true
    break
  fi
  sleep 2
done
if [[ "${mysql_ready}" != "true" ]]; then
  echo "隔离 MySQL 容器在 120 秒内未就绪" >&2
  exit 1
fi

normalize_mysql_dump_stream() {
  sed -E -f "${normalizer_script}"
}

gzip -dc "${archive_file}" | normalize_mysql_dump_stream | docker exec -i "${container_name}" sh -c \
  'exec mysql --host=127.0.0.1 --user=root --password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'

read -r table_count required_table_count migration_count <<<"$(
  docker exec -i "${container_name}" sh -c \
    'mysql --batch --skip-column-names --host=127.0.0.1 --user=root --password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'),
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('_prisma_migrations', 'users', 'audit_logs', 'id_business_v2_orders', 'id_business_v2_finance_journals', 'id_business_v2_balance_ledger')),
  (SELECT COUNT(*) FROM `_prisma_migrations` WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL);
SQL
)"

if [[ ! "${table_count}" =~ ^[0-9]+$ ]] || ((table_count < 6)); then
  echo "恢复后的业务表数量异常：${table_count:-unknown}" >&2
  exit 1
fi
if [[ "${required_table_count}" != "6" ]]; then
  echo "恢复后缺少 Prisma、订单、财务或审计核心表" >&2
  exit 1
fi
if [[ ! "${migration_count}" =~ ^[0-9]+$ ]] || ((migration_count < 1)); then
  echo "恢复后没有已完成的 Prisma migration" >&2
  exit 1
fi

check_sql="$(
  docker exec -i "${container_name}" sh -c \
    'mysql --batch --skip-column-names --host=127.0.0.1 --user=root --password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
SELECT CONCAT('CHECK TABLE `', REPLACE(TABLE_NAME, '`', '``'), '`;')
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
SQL
)"
check_results="$(
  printf '%s\n' "${check_sql}" | docker exec -i "${container_name}" sh -c \
    'mysql --batch --skip-column-names --host=127.0.0.1 --user=root --password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
)"
checked_table_count="$(printf '%s\n' "${check_results}" | awk -F '\t' '$2 == "check" && $3 == "status" && $4 == "OK" { count++ } END { print count + 0 }')"
if [[ "${checked_table_count}" != "${table_count}" ]]; then
  echo "恢复库 CHECK TABLE 未全部通过：${checked_table_count}/${table_count}" >&2
  printf '%s\n' "${check_results}" | awk -F '\t' '$3 != "status" || $4 != "OK"' >&2
  exit 1
fi

archive_checksum_hex="$(openssl dgst -sha256 "${archive_file}" | awk '{ print $NF }')"
echo "MySQL isolated restore verified: tables=${table_count}, checked=${checked_table_count}, migrations=${migration_count}"
echo "MySQL restore archive SHA-256: ${archive_checksum_hex}"
if [[ -n "${downloaded_object_key}" ]]; then
  echo "MySQL restore source: s3://${s3_bucket}/${downloaded_object_key}"
else
  echo "MySQL restore source: ${archive_file}"
fi
