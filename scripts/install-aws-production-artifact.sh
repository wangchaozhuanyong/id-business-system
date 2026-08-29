#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少生产安装参数：${name}" >&2
    exit 1
  fi
}

for variable in \
  RELEASE_DIRECTORY \
  PREVIOUS_RELEASE_DIRECTORY \
  RELEASE_IMAGE_ARCHIVE \
  RELEASE_ARTIFACT_SHA256 \
  RELEASE_COMMIT \
  RELEASE_TAG \
  RELEASE_DEPLOYMENT_RUN \
  RELEASE_API_IMAGE \
  RELEASE_API_DIGEST \
  RELEASE_ADMIN_IMAGE \
  RELEASE_ADMIN_DIGEST \
  RELEASE_MIGRATION_IMAGE \
  RELEASE_MIGRATION_DIGEST \
  RELEASE_GATE_IMAGE \
  RELEASE_GATE_DIGEST \
  PRODUCTION_BASE_URL \
  PRODUCTION_COMPOSE_PROJECT; do
  require_variable "$variable"
done

deployment_root='/opt/id-business-v2'
current_link="${deployment_root}/current"
environment_file="${RELEASE_DIRECTORY}/.env.aws.production"
compose_file="${RELEASE_DIRECTORY}/docker-compose.aws-mysql.yml"
previous_environment_file="${PREVIOUS_RELEASE_DIRECTORY}/.env.aws.production"
previous_compose_file="${PREVIOUS_RELEASE_DIRECTORY}/docker-compose.aws-mysql.yml"
smoke_environment_file="${RELEASE_DIRECTORY}/.release-smoke.env"

case "$RELEASE_DIRECTORY" in
  "${deployment_root}/releases/"*) ;;
  *) echo '新发布目录不在受控 releases 路径中' >&2; exit 1 ;;
esac
case "$PREVIOUS_RELEASE_DIRECTORY" in
  "${deployment_root}/releases/"*) ;;
  *) echo '上一发布目录不在受控 releases 路径中' >&2; exit 1 ;;
esac
if [[ ! "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo '发布 commit 必须是完整 40 位 SHA' >&2
  exit 1
fi
if [[ ! "$RELEASE_TAG" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo '正式发布标签格式无效' >&2
  exit 1
fi
if [[ ! "$RELEASE_ARTIFACT_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo '发布制品 SHA-256 无效' >&2
  exit 1
fi
for digest in \
  "$RELEASE_API_DIGEST" \
  "$RELEASE_ADMIN_DIGEST" \
  "$RELEASE_MIGRATION_DIGEST" \
  "$RELEASE_GATE_DIGEST"; do
  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo '发布镜像 digest 无效' >&2
    exit 1
  fi
done
if [[ ! -d "$RELEASE_DIRECTORY" || ! -d "$PREVIOUS_RELEASE_DIRECTORY" ]]; then
  echo '发布目录不存在' >&2
  exit 1
fi
if [[ ! -f "$RELEASE_IMAGE_ARCHIVE" || ! -f "$compose_file" ]]; then
  echo '发布制品或 Compose 文件不存在' >&2
  exit 1
fi
if [[ ! -f "$previous_environment_file" || ! -f "$previous_compose_file" ]]; then
  echo '上一已验证发布不完整' >&2
  exit 1
fi

for command in docker flock openssl sha256sum systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "生产安装依赖命令不存在：${command}" >&2
    exit 1
  fi
done

if [[ "${DEPLOY_LOCK_HELD:-0}" == 1 ]]; then
  if ! flock -n 9; then
    echo '父发布进程未传递有效部署锁' >&2
    exit 1
  fi
else
  exec 9>"${deployment_root}/.deploy.lock"
fi
if [[ "${DEPLOY_LOCK_HELD:-0}" != 1 ]] && ! flock -n 9; then
  echo '另一个生产发布正在进行' >&2
  exit 1
fi

for service in id-business-v2-mysql-backup.service id-business-v2-mysql-backup-verify.service; do
  if systemctl is-active --quiet "$service"; then
    echo "生产维护任务正在执行：${service}" >&2
    exit 1
  fi
done
if ps -eo pid=,comm=,args= | awk -v current_pid="$$" '
  $1 != current_pid &&
  $2 != "awk" &&
  $2 != "ps" &&
  ($0 ~ /docker compose .*id-business-v2/ ||
   $0 ~ /prisma .*migrate .*deploy/ ||
   $0 ~ /rsync .*id-business-v2/) { found = 1 }
  END { exit found ? 0 : 1 }
' >/dev/null; then
  echo '检测到未受部署锁管理的 Compose、migration 或同步进程' >&2
  exit 1
fi

install -m 600 -o root -g root "$previous_environment_file" "$environment_file"

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
runtime_database_url="$(read_environment_value V2_RUNTIME_DATABASE_URL)"
if [[ "$compose_project" != "$PRODUCTION_COMPOSE_PROJECT" ]]; then
  echo '生产 Compose 项目名与本机锁定值不一致' >&2
  exit 1
fi
if [[ "$runtime_database_url" != mysql://id_business_app:*@127.0.0.1:*/* &&
      "$runtime_database_url" != mysql://id_business_app:*@localhost:*/* ]]; then
  echo '生产巡检数据库地址必须使用 EC2 本机运行账号' >&2
  exit 1
fi

cd "$RELEASE_DIRECTORY"
docker compose --env-file "$environment_file" -f "$compose_file" config >/dev/null

expected_image_archive_sha256="${RELEASE_IMAGE_ARCHIVE_SHA256:-}"
if [[ ! "$expected_image_archive_sha256" =~ ^[a-f0-9]{64}$ ]] ||
   [[ "$(sha256sum "$RELEASE_IMAGE_ARCHIVE" | awk '{print $1}')" != "$expected_image_archive_sha256" ]]; then
  echo '镜像归档 SHA-256 校验失败' >&2
  exit 1
fi

old_api_image="$(docker image inspect "${compose_project}-api:latest" --format '{{.Id}}')"
old_admin_image="$(docker image inspect "${compose_project}-admin:latest" --format '{{.Id}}')"
old_migration_image="$(docker image inspect "${compose_project}-migrate:latest" --format '{{.Id}}')"

echo '加载 CI 不可变生产镜像制品'
docker load --input "$RELEASE_IMAGE_ARCHIVE" >/dev/null

verify_image_digest() {
  local reference="$1"
  local expected="$2"
  local actual
  actual="$(docker image inspect "$reference" --format '{{.Id}}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "镜像 digest 与发布清单不一致：${reference}" >&2
    exit 1
  fi
}

verify_image_digest "$RELEASE_API_IMAGE" "$RELEASE_API_DIGEST"
verify_image_digest "$RELEASE_ADMIN_IMAGE" "$RELEASE_ADMIN_DIGEST"
verify_image_digest "$RELEASE_MIGRATION_IMAGE" "$RELEASE_MIGRATION_DIGEST"
verify_image_digest "$RELEASE_GATE_IMAGE" "$RELEASE_GATE_DIGEST"

timers_stopped=0
application_updated=0
current_switched=0
deployment_succeeded=0

restore_timers() {
  systemctl start id-business-v2-mysql-backup.timer >/dev/null 2>&1 || true
  systemctl start id-business-v2-mysql-backup-verify.timer >/dev/null 2>&1 || true
}

atomic_current_switch() {
  local target="$1"
  local temporary_link="${deployment_root}/.current.${RELEASE_DEPLOYMENT_RUN}"
  ln -sfn "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$current_link"
}

rollback_application() {
  echo '发布验证失败，回切上一个已验证不可变版本' >&2
  docker tag "$old_api_image" "${compose_project}-api:latest" || true
  docker tag "$old_admin_image" "${compose_project}-admin:latest" || true
  docker tag "$old_migration_image" "${compose_project}-migrate:latest" || true
  atomic_current_switch "$PREVIOUS_RELEASE_DIRECTORY" || true
  cd "$PREVIOUS_RELEASE_DIRECTORY" || return
  docker compose \
    --env-file "$previous_environment_file" \
    -f "$previous_compose_file" \
    up -d --no-build --force-recreate migrate api admin caddy || true
}

cleanup() {
  local status=$?
  rm -f -- "$smoke_environment_file"
  if ((status != 0 && application_updated == 1)); then
    set +e
    rollback_application
    set -e
  elif ((status != 0 && current_switched == 1)); then
    set +e
    atomic_current_switch "$PREVIOUS_RELEASE_DIRECTORY"
    set -e
  fi
  if ((timers_stopped == 1)); then
    restore_timers
  fi
  if ((deployment_succeeded == 1)); then
    echo "生产发布完成：${RELEASE_TAG} ${RELEASE_COMMIT}"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

systemctl stop id-business-v2-mysql-backup.timer
systemctl stop id-business-v2-mysql-backup-verify.timer
timers_stopped=1

echo '执行并校验更新前 S3 备份'
systemctl start id-business-v2-mysql-backup.service
if [[ "$(systemctl show id-business-v2-mysql-backup.service --property=Result --value)" != success ]]; then
  echo '更新前 S3 备份未成功' >&2
  exit 1
fi

docker compose --env-file "$environment_file" -f "$compose_file" up -d mysql
docker tag "$RELEASE_MIGRATION_IMAGE" "${compose_project}-migrate:latest"

run_gate_script() {
  local script="$1"
  docker run --rm --network host --env-file "$environment_file" "$RELEASE_GATE_IMAGE" \
    node "$script"
}

echo '执行生产数据库账号供应与向前 migration'
run_gate_script scripts/provision-v2-production-database-access.mjs
docker compose --env-file "$environment_file" -f "$compose_file" run --rm migrate
run_gate_script scripts/provision-v2-production-database-access.mjs
run_gate_script scripts/provision-v2-data-integrity-auditor.mjs

echo '执行更新前数据库身份与 38 项财务完整性门禁'
run_gate_script scripts/gate-v2-production-database-access.mjs
run_gate_script scripts/v2-data-integrity-audit.mjs

smoke_username='production-release-smoke'
smoke_password="$(openssl rand -hex 32)"
{
  printf 'BASE_URL=%s\n' "$PRODUCTION_BASE_URL"
  printf 'DATABASE_URL=%s\n' "$runtime_database_url"
  printf 'SMOKE_TEST_USERNAME=%s\n' "$smoke_username"
  printf 'SMOKE_TEST_PASSWORD=%s\n' "$smoke_password"
} >"$smoke_environment_file"
chmod 600 "$smoke_environment_file"
docker run --rm --network host \
  --env-file "$environment_file" \
  --env-file "$smoke_environment_file" \
  "$RELEASE_GATE_IMAGE" \
  node scripts/provision-production-smoke-user.mjs

docker tag "$RELEASE_API_IMAGE" "${compose_project}-api:latest"
docker tag "$RELEASE_ADMIN_IMAGE" "${compose_project}-admin:latest"

echo '使用已校验制品更新应用容器'
application_updated=1
docker compose --env-file "$environment_file" -f "$compose_file" \
  up -d --no-build --force-recreate migrate api admin caddy

wait_for_service() {
  local service="$1"
  local container_id
  local state
  local health
  for _attempt in $(seq 1 72); do
    container_id="$(docker compose --env-file "$environment_file" -f "$compose_file" ps -q "$service")"
    if [[ -n "$container_id" ]]; then
      state="$(docker inspect "$container_id" --format '{{.State.Status}}')"
      health="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
      if [[ "$state" == running && ("$health" == healthy || "$health" == none) ]]; then
        return 0
      fi
    fi
    sleep 5
  done
  echo "容器未按时进入健康状态：${service}" >&2
  return 1
}

for service in mysql api admin caddy; do
  wait_for_service "$service"
done

run_release_smoke() {
  docker run --rm --network host --env-file "$smoke_environment_file" "$RELEASE_GATE_IMAGE" \
    node scripts/production-release-smoke.mjs
}

echo '执行切换前整站巡检'
run_release_smoke

atomic_current_switch "$RELEASE_DIRECTORY"
current_switched=1

echo '执行原子切换后整站巡检与财务门禁'
run_release_smoke
run_gate_script scripts/gate-v2-production-database-access.mjs
run_gate_script scripts/v2-data-integrity-audit.mjs

restore_timers
if ! systemctl is-enabled --quiet id-business-v2-mysql-backup.timer ||
   ! systemctl is-active --quiet id-business-v2-mysql-backup.timer ||
   ! systemctl is-enabled --quiet id-business-v2-mysql-backup-verify.timer ||
   ! systemctl is-active --quiet id-business-v2-mysql-backup-verify.timer; then
  echo '备份或恢复验证定时器状态异常' >&2
  exit 1
fi
if [[ "$(systemctl show id-business-v2-mysql-backup.service --property=Result --value)" != success ]]; then
  echo '备份服务最近结果异常' >&2
  exit 1
fi

for service in mysql api admin caddy; do
  wait_for_service "$service"
done

chmod -R go-w "$RELEASE_DIRECTORY"
chmod 600 "$environment_file" "${RELEASE_DIRECTORY}/release-manifest.json"
deployment_succeeded=1
application_updated=0
current_switched=0
