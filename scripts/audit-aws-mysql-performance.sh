#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

deployment_directory='/opt/id-business-v2/current'
environment_file="${deployment_directory}/.env.aws.production"
state_directory="${MYSQL_PERFORMANCE_STATE_DIRECTORY:-/var/lib/id-business-v2-mysql-performance}"
lock_file='/run/lock/id-business-v2-mysql-performance.lock'

if [[ "$(id -u)" != 0 ]]; then
  echo '生产 MySQL 性能巡检必须以 root 执行' >&2
  exit 1
fi
if [[ ! -L "$deployment_directory" || ! -f "$environment_file" ]]; then
  echo '生产 MySQL 性能巡检找不到当前发布或环境文件' >&2
  exit 1
fi

for command in awk chmod date docker flock id mkdir mktemp mv rm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "生产 MySQL 性能巡检依赖命令不存在：${command}" >&2
    exit 1
  fi
done

read_environment_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$environment_file"
}

compose_project="$(read_environment_value COMPOSE_PROJECT_NAME)"
database_name="$(read_environment_value MYSQL_DATABASE)"
max_connection_usage_pct="$(read_environment_value MYSQL_PERFORMANCE_MAX_CONNECTION_USAGE_PCT)"
max_query_ms="$(read_environment_value MYSQL_PERFORMANCE_MAX_QUERY_MS)"
max_aborted_clients_delta="$(read_environment_value MYSQL_PERFORMANCE_MAX_ABORTED_CLIENTS_DELTA)"
baseline_only="${MYSQL_PERFORMANCE_BASELINE_ONLY:-false}"
max_connection_usage_pct="${max_connection_usage_pct:-70}"
max_query_ms="${max_query_ms:-500}"
max_aborted_clients_delta="${max_aborted_clients_delta:-25}"

if [[ ! "$compose_project" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
  echo '生产 Compose 项目名无效' >&2
  exit 1
fi
if [[ ! "$database_name" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
  echo '生产数据库名无效' >&2
  exit 1
fi
if [[ ! "$max_connection_usage_pct" =~ ^[0-9]+$ ]] ||
   ((max_connection_usage_pct < 10 || max_connection_usage_pct > 95)); then
  echo 'MYSQL_PERFORMANCE_MAX_CONNECTION_USAGE_PCT 必须是 10 到 95 之间的整数' >&2
  exit 1
fi
if [[ ! "$max_query_ms" =~ ^[0-9]+$ ]] || ((max_query_ms < 100 || max_query_ms > 60000)); then
  echo 'MYSQL_PERFORMANCE_MAX_QUERY_MS 必须是 100 到 60000 之间的整数' >&2
  exit 1
fi
if [[ ! "$max_aborted_clients_delta" =~ ^[0-9]+$ ]] ||
   ((max_aborted_clients_delta < 1 || max_aborted_clients_delta > 10000)); then
  echo 'MYSQL_PERFORMANCE_MAX_ABORTED_CLIENTS_DELTA 必须是 1 到 10000 之间的整数' >&2
  exit 1
fi
if [[ "$baseline_only" != true && "$baseline_only" != false ]]; then
  echo 'MYSQL_PERFORMANCE_BASELINE_ONLY 只能是 true 或 false' >&2
  exit 1
fi

mkdir -p "$state_directory"
chmod 700 "$state_directory"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo '{"ok":true,"skipped":"performance_audit_in_progress"}'
  exit 0
fi

mapfile -t mysql_container_ids < <(
  docker ps \
    --filter "label=com.docker.compose.project=${compose_project}" \
    --filter 'label=com.docker.compose.service=mysql' \
    --filter 'status=running' \
    --format '{{.ID}}'
)
if ((${#mysql_container_ids[@]} != 1)); then
  echo '生产 MySQL 性能巡检必须且只能匹配一个运行中 MySQL 容器' >&2
  exit 1
fi
mysql_container_id="${mysql_container_ids[0]}"

run_mysql() {
  local query="$1"
  docker exec "$mysql_container_id" sh -c \
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --host=127.0.0.1 --user=root --batch --skip-column-names --execute "$1"' \
    sh "$query"
}

status_query="
SELECT
  @@max_connections,
  MAX(CASE WHEN VARIABLE_NAME = 'Max_used_connections' THEN VARIABLE_VALUE END),
  MAX(CASE WHEN VARIABLE_NAME = 'Threads_connected' THEN VARIABLE_VALUE END),
  MAX(CASE WHEN VARIABLE_NAME = 'Threads_running' THEN VARIABLE_VALUE END),
  MAX(CASE WHEN VARIABLE_NAME = 'Aborted_clients' THEN VARIABLE_VALUE END),
  MAX(CASE WHEN VARIABLE_NAME = 'Aborted_connects' THEN VARIABLE_VALUE END),
  MAX(CASE WHEN VARIABLE_NAME = 'Uptime' THEN VARIABLE_VALUE END)
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
  'Max_used_connections',
  'Threads_connected',
  'Threads_running',
  'Aborted_clients',
  'Aborted_connects',
  'Uptime'
);"
IFS=$'\t' read -r \
  max_connections \
  max_used_connections \
  threads_connected \
  threads_running \
  aborted_clients \
  aborted_connects \
  mysql_uptime <<<"$(run_mysql "$status_query")"

for value in \
  "$max_connections" \
  "$max_used_connections" \
  "$threads_connected" \
  "$threads_running" \
  "$aborted_clients" \
  "$aborted_connects" \
  "$mysql_uptime"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo '生产 MySQL 性能状态返回了非整数值' >&2
    exit 1
  fi
done

slow_query="
SELECT
  COALESCE(DIGEST, 'none'),
  COUNT_STAR,
  ROUND(AVG_TIMER_WAIT / 1000000000),
  ROUND(MAX_TIMER_WAIT / 1000000000),
  ROUND(SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1)),
  SUM_NO_INDEX_USED
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = '${database_name}'
  AND LAST_SEEN >= UTC_TIMESTAMP() - INTERVAL 10 MINUTE
  AND DIGEST_TEXT REGEXP '^(SELECT|INSERT|UPDATE|DELETE)'
  AND DIGEST_TEXT NOT LIKE 'SELECT SQL_NO_CACHE%'
  AND DIGEST_TEXT NOT IN ('SELECT ?')
  AND DIGEST_TEXT NOT LIKE 'SELECT @@%'
  AND DIGEST_TEXT NOT LIKE '%information_schema%'
  AND DIGEST_TEXT NOT LIKE '%_prisma_migrations%'
ORDER BY MAX_TIMER_WAIT DESC
LIMIT 1;"
slow_record="$(run_mysql "$slow_query")"
if [[ -n "$slow_record" ]]; then
  IFS=$'\t' read -r \
    slow_digest \
    slow_count \
    slow_avg_ms \
    slow_max_ms \
    slow_rows_examined \
    slow_no_index_count <<<"$slow_record"
else
  slow_digest='none'
  slow_count=0
  slow_avg_ms=0
  slow_max_ms=0
  slow_rows_examined=0
  slow_no_index_count=0
fi
if [[ "$slow_digest" != none && ! "$slow_digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo '生产 MySQL 性能摘要返回了无效 digest' >&2
  exit 1
fi
for value in \
  "$slow_count" \
  "$slow_avg_ms" \
  "$slow_max_ms" \
  "$slow_rows_examined" \
  "$slow_no_index_count"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo '生产 MySQL 慢查询摘要返回了非整数值' >&2
    exit 1
  fi
done

previous_aborted_clients=0
previous_uptime=0
has_previous_state=false
state_file="${state_directory}/last-status"
if [[ -f "$state_file" ]]; then
  previous_aborted_clients="$(awk -F= '$1 == "aborted_clients" { print $2; exit }' "$state_file")"
  previous_uptime="$(awk -F= '$1 == "uptime" { print $2; exit }' "$state_file")"
  has_previous_state=true
fi
if [[ ! "$previous_aborted_clients" =~ ^[0-9]+$ || ! "$previous_uptime" =~ ^[0-9]+$ ]]; then
  previous_aborted_clients=0
  previous_uptime=0
  has_previous_state=false
fi
aborted_clients_delta=0
if [[ "$has_previous_state" == true ]] &&
   ((mysql_uptime >= previous_uptime && aborted_clients >= previous_aborted_clients)); then
  aborted_clients_delta=$((aborted_clients - previous_aborted_clients))
fi

state_temp="$(mktemp "${state_directory}/.last-status.XXXXXX")"
cleanup() {
  rm -f -- "$state_temp"
}
trap cleanup EXIT INT TERM
{
  printf 'aborted_clients=%s\n' "$aborted_clients"
  printf 'uptime=%s\n' "$mysql_uptime"
} >"$state_temp"
chmod 600 "$state_temp"
mv "$state_temp" "$state_file"

connection_usage_pct=$((threads_connected * 100 / max_connections))
connection_alert=false
slow_query_alert=false
aborted_clients_alert=false
if ((connection_usage_pct >= max_connection_usage_pct)); then connection_alert=true; fi
if ((slow_max_ms >= max_query_ms)); then slow_query_alert=true; fi
if [[ "$baseline_only" != true ]] &&
   ((aborted_clients_delta >= max_aborted_clients_delta)); then
  aborted_clients_alert=true
fi

ok=true
exit_status=0
if [[ "$connection_alert" == true || "$slow_query_alert" == true ||
      "$aborted_clients_alert" == true ]]; then
  ok=false
  exit_status=1
fi

printf '{"ok":%s,"observedAt":"%s","baselineOnly":%s,"connections":{"current":%s,"historicalMax":%s,"limit":%s,"usagePct":%s,"running":%s,"alert":%s},"aborted":{"clients":%s,"clientsDelta":%s,"connects":%s,"alert":%s},"slowestRecentDigest":{"digest":"%s","count":%s,"avgMs":%s,"maxMs":%s,"rowsExaminedPerCall":%s,"noIndexCount":%s,"alert":%s}}\n' \
  "$ok" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$baseline_only" \
  "$threads_connected" \
  "$max_used_connections" \
  "$max_connections" \
  "$connection_usage_pct" \
  "$threads_running" \
  "$connection_alert" \
  "$aborted_clients" \
  "$aborted_clients_delta" \
  "$aborted_connects" \
  "$aborted_clients_alert" \
  "$slow_digest" \
  "$slow_count" \
  "$slow_avg_ms" \
  "$slow_max_ms" \
  "$slow_rows_examined" \
  "$slow_no_index_count" \
  "$slow_query_alert"
exit "$exit_status"
