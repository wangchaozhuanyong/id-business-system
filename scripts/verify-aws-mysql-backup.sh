#!/usr/bin/env bash
set -euo pipefail

umask 077

deployment_directory="/opt/id-business-v2/current"
environment_file="${deployment_directory}/.env.aws.production"
work_directory="/opt/id-business-v2/backups/mysql/restore-drills"
mysql_image="mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb"
restore_database=""
archive_file=""
downloaded_object_key=""
temporary_directory=""
container_name="id-business-v2-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"
container_created=false

usage() {
  echo "Usage: $0 [--archive=/absolute/path/to/backup.sql.gz] [--deployment-directory=/absolute/project/path] [--work-directory=/absolute/project/backup/path]" >&2
}

for argument in "$@"; do
  case "${argument}" in
    --archive=*) archive_file="${argument#--archive=}" ;;
    --deployment-directory=*) deployment_directory="${argument#--deployment-directory=}" ;;
    --work-directory=*) work_directory="${argument#--work-directory=}" ;;
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

if [[ "${deployment_directory}" != /* || "${work_directory}" != /* ]]; then
  echo "部署目录和恢复工作目录必须是绝对路径" >&2
  exit 1
fi
environment_file="${deployment_directory}/.env.aws.production"
normalizer_script="${deployment_directory}/scripts/mysql-dump-restore-normalizer.sed"

read_environment_value() {
  local key="$1"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "${environment_file}"
}

for required_command in docker gzip openssl awk sed sort mktemp mkdir chmod wc cmp cat; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "恢复验证依赖命令不存在：${required_command}" >&2
    exit 1
  fi
done
if [[ ! -f "${normalizer_script}" ]]; then
  echo "MySQL 备份恢复规范化规则不存在" >&2
  exit 1
fi
if [[ ! -f "${environment_file}" ]]; then
  echo "AWS MySQL 生产环境文件不存在" >&2
  exit 1
fi
restore_database="$(read_environment_value MYSQL_DATABASE)"
compose_project="$(read_environment_value COMPOSE_PROJECT_NAME)"
if [[ ! "${restore_database}" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
  echo "恢复验证必须绑定明确的活动 MYSQL_DATABASE" >&2
  exit 1
fi
if [[ ! "${compose_project}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
  echo "恢复验证的源 Compose 项目名无效" >&2
  exit 1
fi
mkdir -p "${work_directory}"
chmod 700 "${work_directory}"
temporary_directory="$(mktemp -d "${work_directory}/restore.XXXXXX")"
restore_label="$(openssl rand -hex 16)"

cleanup() {
  if [[ "${container_created}" == true ]] &&
     [[ "$(docker inspect --format '{{index .Config.Labels "id-business-v2.restore-drill"}}' "${container_name}" 2>/dev/null)" == "${restore_label}" ]]; then
    docker rm -f -v "${container_name}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf -- "${temporary_directory}"
  fi
}
trap cleanup EXIT INT TERM

run_aws() {
  local operation="$1"
  shift
  if ! aws "$@" 2>"${temporary_directory}/aws-error"; then
    local code
    code="$(sed -nE 's/.*An error occurred \(([A-Za-z0-9]+)\).*/\1/p' "${temporary_directory}/aws-error")"
    [[ "${code}" =~ ^[A-Za-z0-9]{1,64}$ ]] || code=UNCLASSIFIED
    echo "S3 恢复验证失败：operation=${operation}, code=${code}" >&2
    return 1
  fi
}

# Only metadata hashes are captured from the current source. No table rows,
# function/trigger SQL bodies or credentials are written to the receipt/log.
definition_queries() {
  cat <<'SQL'
SET TRANSACTION READ ONLY;
START TRANSACTION;
SET SESSION group_concat_max_len=16777216;
-- S covers every BASE TABLE. Runtime AUTO_INCREMENT counters and row counts
-- are deliberately excluded: they can advance after the backup snapshot.
SELECT 'S',t.TABLE_NAME,SHA2(CAST(JSON_ARRAY(t.ENGINE,t.ROW_FORMAT,t.TABLE_COLLATION,
  t.CREATE_OPTIONS,t.TABLE_COMMENT,
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(c.COLUMN_NAME,c.ORDINAL_POSITION,c.COLUMN_TYPE,
    c.IS_NULLABLE,c.COLUMN_DEFAULT,c.EXTRA,c.CHARACTER_SET_NAME,c.COLLATION_NAME,
    c.GENERATION_EXPRESSION,c.COLUMN_COMMENT) AS CHAR) ORDER BY c.ORDINAL_POSITION SEPARATOR '|')
   FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME),
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(s.INDEX_NAME,s.NON_UNIQUE,s.SEQ_IN_INDEX,s.COLUMN_NAME,
    s.COLLATION,s.SUB_PART,s.NULLABLE,s.INDEX_TYPE,s.COMMENT,s.INDEX_COMMENT,s.IS_VISIBLE,
    s.EXPRESSION) AS CHAR) ORDER BY s.INDEX_NAME,s.SEQ_IN_INDEX SEPARATOR '|')
   FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA=t.TABLE_SCHEMA AND s.TABLE_NAME=t.TABLE_NAME),
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(k.CONSTRAINT_NAME,k.COLUMN_NAME,k.ORDINAL_POSITION,
    k.POSITION_IN_UNIQUE_CONSTRAINT,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,
    k.REFERENCED_COLUMN_NAME) AS CHAR) ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION SEPARATOR '|')
   FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=t.TABLE_SCHEMA AND k.TABLE_NAME=t.TABLE_NAME),
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(r.CONSTRAINT_NAME,r.UNIQUE_CONSTRAINT_SCHEMA,
    r.UNIQUE_CONSTRAINT_NAME,r.MATCH_OPTION,r.UPDATE_RULE,r.DELETE_RULE,r.REFERENCED_TABLE_NAME)
    AS CHAR) ORDER BY r.CONSTRAINT_NAME SEPARATOR '|')
   FROM information_schema.REFERENTIAL_CONSTRAINTS r WHERE r.CONSTRAINT_SCHEMA=t.TABLE_SCHEMA AND r.TABLE_NAME=t.TABLE_NAME),
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(tc.CONSTRAINT_NAME,tc.CONSTRAINT_TYPE,tc.ENFORCED,
    cc.CHECK_CLAUSE) AS CHAR) ORDER BY tc.CONSTRAINT_NAME SEPARATOR '|')
   FROM information_schema.TABLE_CONSTRAINTS tc LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
     ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
   WHERE tc.TABLE_SCHEMA=t.TABLE_SCHEMA AND tc.TABLE_NAME=t.TABLE_NAME),
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(p.PARTITION_NAME,p.SUBPARTITION_NAME,
    p.PARTITION_ORDINAL_POSITION,p.SUBPARTITION_ORDINAL_POSITION,p.PARTITION_METHOD,
    p.SUBPARTITION_METHOD,p.PARTITION_EXPRESSION,p.SUBPARTITION_EXPRESSION,
    p.PARTITION_DESCRIPTION,p.TABLESPACE_NAME) AS CHAR)
    ORDER BY p.PARTITION_ORDINAL_POSITION,p.SUBPARTITION_ORDINAL_POSITION SEPARATOR '|')
   FROM information_schema.PARTITIONS p WHERE p.TABLE_SCHEMA=t.TABLE_SCHEMA AND p.TABLE_NAME=t.TABLE_NAME)
  ) AS CHAR),256)
FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE='BASE TABLE'
ORDER BY t.TABLE_NAME;
SELECT 'T',TRIGGER_NAME,SHA2(CAST(JSON_ARRAY(EVENT_OBJECT_TABLE,ACTION_TIMING,
  EVENT_MANIPULATION,ACTION_ORDER,ACTION_STATEMENT,DEFINER,SQL_MODE,
  CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION) AS CHAR),256)
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME;
SELECT 'F',ROUTINE_NAME,SHA2(CAST(JSON_ARRAY(ROUTINE_TYPE,ROUTINE_DEFINITION,
  DATA_TYPE,DTD_IDENTIFIER,IS_DETERMINISTIC,SQL_DATA_ACCESS,SECURITY_TYPE,
  DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,
  (SELECT GROUP_CONCAT(CAST(JSON_ARRAY(ORDINAL_POSITION,PARAMETER_MODE,PARAMETER_NAME,
    DATA_TYPE,DTD_IDENTIFIER,CHARACTER_SET_NAME,COLLATION_NAME) AS CHAR)
    ORDER BY ORDINAL_POSITION SEPARATOR '|')
   FROM information_schema.PARAMETERS p WHERE p.SPECIFIC_SCHEMA=r.ROUTINE_SCHEMA
     AND p.SPECIFIC_NAME=r.ROUTINE_NAME)) AS CHAR),256)
FROM information_schema.ROUTINES r WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME;
ROLLBACK;
SQL
}

source_ids="$(docker ps -q \
  --filter "label=com.docker.compose.project=${compose_project}" \
  --filter label=com.docker.compose.service=mysql --filter status=running)"
source_container_ids=()
while IFS= read -r source_id; do
  [[ -n "${source_id}" ]] && source_container_ids+=("${source_id}")
done <<<"${source_ids}"
if ((${#source_container_ids[@]} != 1)); then
  echo "恢复验证必须且只能匹配一个运行中的源 MySQL 容器" >&2
  exit 1
fi
source_container_id="${source_container_ids[0]}"

capture_source_definitions() {
  if ! definition_queries | docker exec -i -e "MYSQL_DATABASE=${restore_database}" "${source_container_id}" sh -c \
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --default-character-set=utf8mb4 --batch --skip-column-names --host=127.0.0.1 --user=root "$MYSQL_DATABASE"' \
    2>"${temporary_directory}/source-metadata-error"; then
    echo "恢复验证的源数据库只读保护元数据读取失败" >&2
    return 1
  fi
}

capture_source_definitions >"${temporary_directory}/source-definitions"
if ! awk -F '\t' '
  NF != 3 || $2 !~ /^[A-Za-z0-9_]+$/ || $3 !~ /^[a-f0-9]{64}$/ { invalid=1 }
  $1 == "S" { tables++; if (seen_schema[$2]++) invalid=1; schema[$2]=1 }
  $1 == "T" { triggers++; if (seen[$2]++) invalid=1 }
  $1 == "F" { functions++; if ($2 != "idv2_integrity_trigger_exists") invalid=1 }
  $1 != "S" && $1 != "T" && $1 != "F" { invalid=1 }
  END { exit (invalid || tables < 6 || !schema["_prisma_migrations"] || !schema["users"] ||
    !schema["audit_logs"] || !schema["id_business_v2_orders"] ||
    !schema["id_business_v2_finance_journals"] || !schema["id_business_v2_balance_ledger"] ||
    triggers != 49 || functions != 1) ? 1 : 0 }
' "${temporary_directory}/source-definitions"; then
  echo "源数据库保护定义指纹缺失或范围异常" >&2
  exit 1
fi

if [[ -n "${archive_file}" ]]; then
  if [[ "${archive_file}" != /* || ! -f "${archive_file}" ]]; then
    echo "--archive 必须指向存在的绝对路径备份文件" >&2
    exit 1
  fi
else
  for required_command in aws; do
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

  # Filter exact flat archive names before selecting latest. Companion metadata
  # and nested recovery bundles must not hide a valid daily archive.
  downloaded_object_key="$(
    run_aws ListObjectsV2 s3api list-objects-v2 \
      --region "${s3_region}" \
      --bucket "${s3_bucket}" \
      --prefix "${s3_prefix%/}/id-business-v2-" \
      --query 'Contents[?Size > `0`].[Key,LastModified]' \
      --output text \
      | awk -F '\t' -v prefix="${s3_prefix%/}/" '
          index($1, prefix) == 1 {
            name = substr($1, length(prefix) + 1)
            if (name ~ /^id-business-v2-[0-9]{8}T[0-9]{6}Z[.]sql[.]gz$/ &&
                $2 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]+$/) {
              print $2 "\t" $1
            }
          }
        ' | LC_ALL=C sort -r | awk -F '\t' 'NR == 1 { selected = $2 } END { print selected }'
  )"
  if [[ -z "${downloaded_object_key}" || "${downloaded_object_key}" == "None" ]]; then
    echo "S3 中没有可用的 MySQL 备份" >&2
    exit 1
  fi
  object_filename="${downloaded_object_key##*/}"
  if [[ "${downloaded_object_key}" != "${s3_prefix%/}/${object_filename}" ]] ||
    [[ ! "${object_filename}" =~ ^id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]]; then
    echo "S3 最新对象键不符合备份命名规则" >&2
    exit 1
  fi

  archive_file="${temporary_directory}/backup.sql.gz"
  remote_identity="$(
    run_aws HeadObject s3api head-object \
      --region "${s3_region}" \
      --bucket "${s3_bucket}" \
      --key "${downloaded_object_key}" \
      --checksum-mode ENABLED \
      --query '[ChecksumSHA256,ContentLength,ServerSideEncryption]' \
      --output text
  )"
  IFS=$'\t' read -r remote_checksum_base64 remote_size remote_encryption <<<"${remote_identity}"
  if [[ ! "${remote_checksum_base64}" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
     [[ ! "${remote_size}" =~ ^[1-9][0-9]*$ ]] || [[ "${remote_encryption}" != AES256 ]]; then
    echo "S3 备份 SHA-256、大小或 AES256 证据无效" >&2
    exit 1
  fi
  run_aws GetObject s3api get-object \
    --region "${s3_region}" \
    --bucket "${s3_bucket}" \
    --key "${downloaded_object_key}" \
    --checksum-mode ENABLED \
    "${archive_file}" >/dev/null
  local_checksum_base64="$(openssl dgst -sha256 -binary "${archive_file}" | openssl base64 -A)"
  local_size="$(wc -c <"${archive_file}" | awk '{ print $1 }')"
  if [[ "${local_checksum_base64}" != "${remote_checksum_base64}" || "${local_size}" != "${remote_size}" ]]; then
    echo "下载后的备份 SHA-256 或大小与 S3 不一致" >&2
    exit 1
  fi
fi

# Only the mysqldump database header is read, never data rows. Both the data
# dump and appended routines metadata must name the active database.
if ! gzip -dc "${archive_file}" | awk -v expected="${restore_database}" '
  /^-- Host: .*Database: / {
    name = $0
    sub(/^-- Host: .*Database: /, "", name)
    sub(/[[:space:]]+$/, "", name)
    headers++
    if (name != expected) invalid = 1
  }
  /^-- Current Database: / {
    name = $0
    sub(/^-- Current Database: `/, "", name)
    sub(/`[[:space:]]*$/, "", name)
    headers++
    if (name != expected) invalid = 1
  }
  END { exit (headers < 1 || invalid) ? 1 : 0 }
'; then
  echo "备份源数据库头缺失或与活动 MYSQL_DATABASE 不一致" >&2
  exit 1
fi

gzip -t "${archive_file}"
if [[ ! -s "${archive_file}" ]]; then
  echo "MySQL 备份文件为空" >&2
  exit 1
fi
archive_checksum_before="$(openssl dgst -sha256 "${archive_file}" | awk '{ print $NF }')"

restore_password="$(openssl rand -hex 24)"
docker run --detach --rm \
  --name "${container_name}" \
  --network none \
  --label "id-business-v2.restore-drill=${restore_label}" \
  --env MYSQL_ROOT_PASSWORD="${restore_password}" \
  --env MYSQL_DATABASE="${restore_database}" \
  "${mysql_image}" \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_0900_ai_ci \
  --default-time-zone=+00:00 \
  --sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION >/dev/null
container_created=true

mysql_ready=false
for _ in $(seq 1 60); do
  if docker exec "${container_name}" sh -c \
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysqladmin ping --host=127.0.0.1 --user=root --silent' >/dev/null 2>&1; then
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

run_restore_sql() {
  if ! docker exec -i "${container_name}" sh -c \
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --default-character-set=utf8mb4 --batch --skip-column-names --host=127.0.0.1 --user=root "$MYSQL_DATABASE" "$@"' \
    restore-sql "$@" 2>"${temporary_directory}/mysql-error"; then
    local code
    code="$(sed -nE 's/^ERROR ([0-9]+) \(([A-Z0-9]+)\).*/\1 (\2)/p' "${temporary_directory}/mysql-error")"
    [[ "${code}" =~ ^[0-9]+\ \([A-Z0-9]+\)$ ]] || code=UNCLASSIFIED
    echo "隔离恢复 SQL 失败：${code}" >&2
    return 1
  fi
}

# This user exists only in our disposable network-none server. Its account is
# locked and all privileges are restricted to the one restored schema; preserve
# original DEFINER clauses rather than changing them to root/runtime identity.
run_restore_sql <<SQL
CREATE USER 'id_business_migrator'@'%' ACCOUNT LOCK;
GRANT ALL PRIVILEGES ON \`${restore_database}\`.* TO 'id_business_migrator'@'%';
SQL

gzip -dc "${archive_file}" | normalize_mysql_dump_stream | run_restore_sql

read -r table_count required_table_count migration_count <<<"$(
  run_restore_sql <<'SQL'
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

read -r trigger_count routine_count bad_definers wrong_schemas locked_definer wrong_grants valid_function required_guards <<<"$(
  run_restore_sql <<'SQL'
SELECT
  (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()),
  (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()),
  (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND DEFINER <> 'id_business_migrator@%') +
  (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND DEFINER <> 'id_business_migrator@%'),
  (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (DATABASE(),'information_schema','mysql','performance_schema','sys')),
  (SELECT COUNT(*) FROM mysql.user WHERE User='id_business_migrator' AND Host='%' AND account_locked='Y'),
  (SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE='''id_business_migrator''@''%''' AND TABLE_SCHEMA <> DATABASE()) +
  (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE='''id_business_migrator''@''%''' AND PRIVILEGE_TYPE <> 'USAGE') +
  (SELECT COUNT(*) FROM mysql.tables_priv WHERE User='id_business_migrator' AND Host='%') +
  (SELECT COUNT(*) FROM mysql.procs_priv WHERE User='id_business_migrator' AND Host='%') ,
  (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()
    AND ROUTINE_NAME='idv2_integrity_trigger_exists' AND ROUTINE_TYPE='FUNCTION'
    AND SECURITY_TYPE='DEFINER' AND IS_DETERMINISTIC='NO' AND SQL_DATA_ACCESS='READS SQL DATA'
    AND DATA_TYPE='tinyint'
    AND REPLACE(REGEXP_REPLACE(LOWER(TRIM(TRAILING ';' FROM ROUTINE_DEFINITION)),'[[:space:]]',''),'`','') =
      'returnexists(select1frominformation_schema.triggerstrigger_recordwheretrigger_record.trigger_schema=database()andtrigger_record.event_object_table=expected_tableandtrigger_record.trigger_name=expected_trigger)'),
  (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND ACTION_TIMING='BEFORE'
    AND (TRIGGER_NAME,EVENT_OBJECT_TABLE,EVENT_MANIPULATION) IN (
      ('idv2_audit_log_no_update','audit_logs','UPDATE'),
      ('idv2_audit_log_no_delete','audit_logs','DELETE'),
      ('idv2_balance_ledger_no_update','id_business_v2_balance_ledger','UPDATE'),
      ('idv2_balance_ledger_no_delete','id_business_v2_balance_ledger','DELETE'),
      ('idv2_finance_journal_no_delete','id_business_v2_finance_journals','DELETE'),
      ('idv2_finance_line_no_update','id_business_v2_finance_journal_lines','UPDATE'),
      ('idv2_finance_line_no_delete','id_business_v2_finance_journal_lines','DELETE')));
SQL
)"
if [[ "${trigger_count}" != 49 || "${routine_count}" != 1 || "${bad_definers}" != 0 ||
      "${wrong_schemas}" != 0 || "${locked_definer}" != 1 || "${wrong_grants}" != 0 ||
      "${valid_function}" != 1 || "${required_guards}" != 7 ]]; then
  echo "恢复后的函数、触发器定义或隔离 DEFINER 权限与当前保护规则不一致" >&2
  exit 1
fi

definition_queries | run_restore_sql >"${temporary_directory}/restored-definitions"
if ! cmp -s "${temporary_directory}/source-definitions" "${temporary_directory}/restored-definitions"; then
  echo "恢复后的全部触发器或函数定义指纹与活动源库不一致" >&2
  exit 1
fi

function_probe="$(run_restore_sql <<'SQL'
SELECT idv2_integrity_trigger_exists('idv2_audit_log_no_update','audit_logs'),
       idv2_integrity_trigger_exists('idv2_balance_ledger_no_delete','id_business_v2_balance_ledger'),
       idv2_integrity_trigger_exists('idv2_finance_line_no_delete','id_business_v2_finance_journal_lines'),
       idv2_integrity_trigger_exists('restore_probe_missing_trigger','audit_logs');
SQL
)"
if [[ "${function_probe}" != $'1\t1\t1\t0' ]]; then
  echo "恢复后的完整性函数运行验证失败" >&2
  exit 1
fi

probe_guard() {
  local table="$1" operation="$2" expected_message="$3"
  local count statement result errors expected_error
  count="$(printf 'SELECT COUNT(*) FROM `%s`;\n' "${table}" | run_restore_sql)"
  if [[ ! "${count}" =~ ^[1-9][0-9]*$ ]]; then
    echo "恢复库缺少可执行保护探针的记录：${table}" >&2
    return 1
  fi
  if [[ "${operation}" == UPDATE ]]; then
    statement="UPDATE \`${table}\` SET id=id LIMIT 1;"
  else
    statement="DELETE FROM \`${table}\` LIMIT 1;"
  fi
  # --force continues after the expected SIGNAL and executes ROLLBACK in this
  # same session. Even a missing guard cannot commit a restored business row.
  result="$(printf '%s\n' 'START TRANSACTION;' 'SET @idv2_routine_audit_cleanup_scope=NULL;' "${statement}" 'ROLLBACK;' "SELECT 'restore_probe_rolled_back';" | run_restore_sql --force)"
  errors="$(awk '/^ERROR / { count++ } END { print count+0 }' "${temporary_directory}/mysql-error")"
  expected_error="$(awk -v message="${expected_message}" '/^ERROR 1644 \(45000\)/ { if (index($0, ": " message) && substr($0, length($0)-length(message)+1) == message) count++ } END { print count+0 }' "${temporary_directory}/mysql-error")"
  if [[ "${result}" != restore_probe_rolled_back || "${errors}" != 1 || "${expected_error}" != 1 ]]; then
    echo "恢复库不可变保护探针未按预期拒绝：${table}/${operation}" >&2
    return 1
  fi
  if [[ "$(printf 'SELECT COUNT(*) FROM `%s`;\n' "${table}" | run_restore_sql)" != "${count}" ]]; then
    echo "恢复库保护探针回滚核对失败：${table}" >&2
    return 1
  fi
}

probe_guard audit_logs UPDATE 'Audit logs are immutable'
probe_guard audit_logs DELETE 'Audit logs are immutable'
probe_guard id_business_v2_balance_ledger UPDATE 'V2 balance ledger is immutable'
probe_guard id_business_v2_balance_ledger DELETE 'V2 balance ledger is immutable'
probe_guard id_business_v2_finance_journals DELETE 'Posted finance journals cannot be deleted'
probe_guard id_business_v2_finance_journal_lines UPDATE 'Posted finance journal lines are immutable'
probe_guard id_business_v2_finance_journal_lines DELETE 'Posted finance journal lines are immutable'
if [[ "${required_table_count}" != "6" ]]; then
  echo "恢复后缺少 Prisma、订单、财务或审计核心表" >&2
  exit 1
fi
if [[ ! "${migration_count}" =~ ^[0-9]+$ ]] || ((migration_count < 1)); then
  echo "恢复后没有已完成的 Prisma migration" >&2
  exit 1
fi

check_sql="$(
  run_restore_sql <<'SQL'
SELECT CONCAT('CHECK TABLE `', REPLACE(TABLE_NAME, '`', '``'), '`;')
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
SQL
)"
check_results="$(
  printf '%s\n' "${check_sql}" | run_restore_sql
)"
checked_table_count="$(printf '%s\n' "${check_results}" | awk -F '\t' '$2 == "check" && $3 == "status" && $4 == "OK" { count++ } END { print count + 0 }')"
if [[ "${checked_table_count}" != "${table_count}" ]]; then
  echo "恢复库 CHECK TABLE 未全部通过：${checked_table_count}/${table_count}" >&2
  exit 1
fi

archive_checksum_hex="$(openssl dgst -sha256 "${archive_file}" | awk '{ print $NF }')"
if [[ "${archive_checksum_hex}" != "${archive_checksum_before}" ]]; then
  echo "备份文件在恢复验证期间发生变化" >&2
  exit 1
fi
capture_source_definitions >"${temporary_directory}/source-definitions-after"
if ! cmp -s "${temporary_directory}/source-definitions" "${temporary_directory}/source-definitions-after"; then
  echo "源数据库保护定义在恢复验证期间变化，请重新验证最新备份" >&2
  exit 1
fi
echo "MySQL isolated restore verified: tables=${table_count}, checked=${checked_table_count}, migrations=${migration_count}"
echo "MySQL restore protection verified: triggers=${trigger_count}, functions=${routine_count}, rollbackProbes=7, originalDefinerLocked=true"
echo "MySQL restore archive SHA-256: ${archive_checksum_hex}"
if [[ -n "${downloaded_object_key}" ]]; then
  echo "MySQL restore source archive: ${object_filename}"
else
  echo "MySQL restore source: ${archive_file}"
fi
