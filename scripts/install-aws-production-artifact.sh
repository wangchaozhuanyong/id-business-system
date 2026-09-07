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
  RELEASE_MANIFEST_SCHEMA \
  RELEASE_ARTIFACT_ARCHIVE \
  RELEASE_IMAGE_ARCHIVE_SHA256 \
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
  RELEASE_MEDIA_RESOLVER_IMAGE \
  RELEASE_MEDIA_RESOLVER_DIGEST \
  RELEASE_RECHARGE_IMAGE \
  RELEASE_RECHARGE_DIGEST \
  RELEASE_GATE_IMAGE \
  RELEASE_GATE_DIGEST \
  RELEASE_API_ARCHIVE \
  RELEASE_API_ARCHIVE_SHA256 \
  RELEASE_API_SIZE_BYTES \
  RELEASE_ADMIN_ARCHIVE \
  RELEASE_ADMIN_ARCHIVE_SHA256 \
  RELEASE_ADMIN_SIZE_BYTES \
  RELEASE_MIGRATION_ARCHIVE \
  RELEASE_MIGRATION_ARCHIVE_SHA256 \
  RELEASE_MIGRATION_SIZE_BYTES \
  RELEASE_MEDIA_RESOLVER_ARCHIVE \
  RELEASE_MEDIA_RESOLVER_ARCHIVE_SHA256 \
  RELEASE_MEDIA_RESOLVER_SIZE_BYTES \
  RELEASE_RECHARGE_ARCHIVE \
  RELEASE_RECHARGE_ARCHIVE_SHA256 \
  RELEASE_RECHARGE_SIZE_BYTES \
  RELEASE_GATE_ARCHIVE \
  RELEASE_GATE_ARCHIVE_SHA256 \
  RELEASE_GATE_SIZE_BYTES \
  RELEASE_BACKUP_POLICY \
  RELEASE_MIGRATION_REQUIRED \
  RELEASE_ACCEPTANCE_SCOPES \
  RELEASE_CHANGED_IMAGES \
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
if [[ "$RELEASE_MANIFEST_SCHEMA" != 1 && "$RELEASE_MANIFEST_SCHEMA" != 2 ]]; then
  echo '发布清单版本无效' >&2
  exit 1
fi
if [[ "$RELEASE_BACKUP_POLICY" != fresh && "$RELEASE_BACKUP_POLICY" != recent ]]; then
  echo '发布备份策略无效' >&2
  exit 1
fi
if [[ "$RELEASE_MIGRATION_REQUIRED" != true && "$RELEASE_MIGRATION_REQUIRED" != false ]]; then
  echo '发布 migration 标记无效' >&2
  exit 1
fi
for image_name in ${RELEASE_CHANGED_IMAGES//,/ }; do
  case "$image_name" in none|api|admin|migration|mediaResolver|recharge|gate) ;; *)
    echo "发布受影响镜像无效：${image_name}" >&2
    exit 1
  esac
done
for scope in ${RELEASE_ACCEPTANCE_SCOPES//,/ }; do
  case "$scope" in
    base|admin|api|auth|auto-recharge|database|finance|gateway|media-resolver|workspace|runtime-config) ;;
    *) echo "发布验收范围无效：${scope}" >&2; exit 1 ;;
  esac
done
if [[ ",${RELEASE_ACCEPTANCE_SCOPES}," != *',base,'* ]]; then
  echo '发布验收范围必须包含全店基础检查' >&2
  exit 1
fi
for digest in \
  "$RELEASE_API_DIGEST" \
  "$RELEASE_ADMIN_DIGEST" \
  "$RELEASE_MIGRATION_DIGEST" \
  "$RELEASE_MEDIA_RESOLVER_DIGEST" \
  "$RELEASE_RECHARGE_DIGEST" \
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
expected_artifact_file="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}.tar.gz"
if [[ "$RELEASE_MANIFEST_SCHEMA" == 2 ]]; then
  expected_artifact_file="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}-source.tar.gz"
fi
if [[ "$RELEASE_ARTIFACT_ARCHIVE" != "${deployment_root}/artifacts/${RELEASE_TAG}-${RELEASE_COMMIT}/${expected_artifact_file}" ]]; then
  echo '正式制品不在当前标签对应的受控 artifacts 路径中' >&2
  exit 1
fi
if [[ ! -f "$RELEASE_ARTIFACT_ARCHIVE" || ! -f "$compose_file" ]]; then
  echo '发布制品或 Compose 文件不存在' >&2
  exit 1
fi
if [[ ! -f "$previous_environment_file" || ! -f "$previous_compose_file" ]]; then
  echo '上一已验证发布不完整' >&2
  exit 1
fi

for command in date docker flock openssl sha256sum systemctl; do
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

for service in \
  id-business-v2-mysql-backup.service \
  id-business-v2-mysql-backup-verify.service \
  id-business-v2-production-retention.service \
  id-business-v2-mysql-performance.service; do
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

# 已有付款任务运行时不切换版本，也不终止它。
if docker ps --format '{{.Names}}' | grep -q 'auto-recharge'; then
  previous_worker_id="$(docker compose --env-file "$previous_environment_file" -f "$previous_compose_file" ps -q auto-recharge)"
  docker exec "$previous_worker_id" python -c "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8051/health',timeout=3))['busy'] is False" || {
    echo '订阅执行器正在处理任务或无法核实，停止发布' >&2; exit 1;
  }
fi
install -m 600 -o root -g root "$previous_environment_file" "$environment_file"
if ! grep -q '^AUTO_RECHARGE_WORKER_TOKEN=.' "$environment_file"; then
  printf '\nAUTO_RECHARGE_WORKER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$environment_file"
fi

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

old_recharge_image="$(docker image inspect "${compose_project}-auto-recharge:latest" --format '{{.Id}}' 2>/dev/null || true)"
old_api_image="$(docker image inspect "${compose_project}-api:latest" --format '{{.Id}}')"
old_admin_image="$(docker image inspect "${compose_project}-admin:latest" --format '{{.Id}}')"
old_migration_image="$(docker image inspect "${compose_project}-migrate:latest" --format '{{.Id}}')"
old_media_resolver_image="$(
  docker image inspect "${compose_project}-media-resolver:latest" --format '{{.Id}}' 2>/dev/null || true
)"

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

load_incremental_image() {
  local name="$1"
  local reference="$2"
  local expected_digest="$3"
  local archive="$4"
  local archive_sha256="$5"
  local size_bytes="$6"
  local actual
  actual="$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null || true)"
  if [[ "$actual" == "$expected_digest" ]]; then
    echo "复用已验证生产镜像：${name} ${reference}"
    return 0
  fi
  if [[ "$archive" == '-' || ! -f "$archive" ]]; then
    echo "缺少待导入的 ${name} 增量镜像归档" >&2
    return 1
  fi
  echo "导入受影响生产镜像：${name}"
  bash "${RELEASE_DIRECTORY}/scripts/load-production-release-images.sh" \
    --image "$archive" "$archive_sha256" "$size_bytes" >/dev/null
  verify_image_digest "$reference" "$expected_digest"
}

echo '加载或复用 CI 不可变生产镜像制品'
if [[ "$RELEASE_MANIFEST_SCHEMA" == 1 ]]; then
  bash "${RELEASE_DIRECTORY}/scripts/load-production-release-images.sh" \
    "$RELEASE_ARTIFACT_ARCHIVE" "$RELEASE_ARTIFACT_SHA256" "$RELEASE_IMAGE_ARCHIVE_SHA256" >/dev/null
else
  load_incremental_image api "$RELEASE_API_IMAGE" "$RELEASE_API_DIGEST" \
    "$RELEASE_API_ARCHIVE" "$RELEASE_API_ARCHIVE_SHA256" "$RELEASE_API_SIZE_BYTES"
  load_incremental_image admin "$RELEASE_ADMIN_IMAGE" "$RELEASE_ADMIN_DIGEST" \
    "$RELEASE_ADMIN_ARCHIVE" "$RELEASE_ADMIN_ARCHIVE_SHA256" "$RELEASE_ADMIN_SIZE_BYTES"
  load_incremental_image migration "$RELEASE_MIGRATION_IMAGE" "$RELEASE_MIGRATION_DIGEST" \
    "$RELEASE_MIGRATION_ARCHIVE" "$RELEASE_MIGRATION_ARCHIVE_SHA256" \
    "$RELEASE_MIGRATION_SIZE_BYTES"
  load_incremental_image media-resolver \
    "$RELEASE_MEDIA_RESOLVER_IMAGE" "$RELEASE_MEDIA_RESOLVER_DIGEST" \
    "$RELEASE_MEDIA_RESOLVER_ARCHIVE" "$RELEASE_MEDIA_RESOLVER_ARCHIVE_SHA256" \
    "$RELEASE_MEDIA_RESOLVER_SIZE_BYTES"
  load_incremental_image recharge "$RELEASE_RECHARGE_IMAGE" "$RELEASE_RECHARGE_DIGEST" \
    "$RELEASE_RECHARGE_ARCHIVE" "$RELEASE_RECHARGE_ARCHIVE_SHA256" \
    "$RELEASE_RECHARGE_SIZE_BYTES"
  load_incremental_image gate "$RELEASE_GATE_IMAGE" "$RELEASE_GATE_DIGEST" \
    "$RELEASE_GATE_ARCHIVE" "$RELEASE_GATE_ARCHIVE_SHA256" "$RELEASE_GATE_SIZE_BYTES"
fi

verify_image_digest "$RELEASE_API_IMAGE" "$RELEASE_API_DIGEST"
verify_image_digest "$RELEASE_ADMIN_IMAGE" "$RELEASE_ADMIN_DIGEST"
verify_image_digest "$RELEASE_MIGRATION_IMAGE" "$RELEASE_MIGRATION_DIGEST"
verify_image_digest "$RELEASE_MEDIA_RESOLVER_IMAGE" "$RELEASE_MEDIA_RESOLVER_DIGEST"
verify_image_digest "$RELEASE_RECHARGE_IMAGE" "$RELEASE_RECHARGE_DIGEST"
verify_image_digest "$RELEASE_GATE_IMAGE" "$RELEASE_GATE_DIGEST"

timers_stopped=0
application_updated=0
current_switched=0
deployment_succeeded=0
retention_timer_changed=0
performance_timer_changed=0

restore_backup_timers() {
  systemctl start id-business-v2-mysql-backup.timer >/dev/null 2>&1 || true
  systemctl start id-business-v2-mysql-backup-verify.timer >/dev/null 2>&1 || true
}

restore_timers() {
  restore_backup_timers
  systemctl start id-business-v2-mysql-performance.timer >/dev/null 2>&1 || true
}

install_retention_timer() {
  local service_source="${RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.service"
  local timer_source="${RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.timer"
  if [[ ! -f "$service_source" || ! -f "$timer_source" ||
        ! -x "${RELEASE_DIRECTORY}/scripts/cleanup-aws-production-retention.sh" ]]; then
    echo '发布制品缺少生产保留策略或 systemd 单元' >&2
    return 1
  fi
  retention_timer_changed=1
  install -m 0644 -o root -g root \
    "$service_source" \
    /etc/systemd/system/id-business-v2-production-retention.service
  install -m 0644 -o root -g root \
    "$timer_source" \
    /etc/systemd/system/id-business-v2-production-retention.timer
  systemctl daemon-reload
  systemctl enable --now id-business-v2-production-retention.timer
}

install_performance_timer() {
  local service_source="${RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.service"
  local timer_source="${RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.timer"
  if [[ ! -f "$service_source" || ! -f "$timer_source" ||
        ! -x "${RELEASE_DIRECTORY}/scripts/audit-aws-mysql-performance.sh" ]]; then
    echo '发布制品缺少 MySQL 性能巡检脚本或 systemd 单元' >&2
    return 1
  fi
  performance_timer_changed=1
  install -m 0644 -o root -g root \
    "$service_source" \
    /etc/systemd/system/id-business-v2-mysql-performance.service
  install -m 0644 -o root -g root \
    "$timer_source" \
    /etc/systemd/system/id-business-v2-mysql-performance.timer
  systemctl daemon-reload
  MYSQL_PERFORMANCE_BASELINE_ONLY=true \
    "${RELEASE_DIRECTORY}/scripts/audit-aws-mysql-performance.sh"
  systemctl enable id-business-v2-mysql-performance.timer
  systemctl start id-business-v2-mysql-performance.service
  systemctl start id-business-v2-mysql-performance.timer
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
  if [[ -n "$old_media_resolver_image" ]]; then
    docker tag "$old_media_resolver_image" "${compose_project}-media-resolver:latest" || true
  else
    cd "$RELEASE_DIRECTORY" || return
    docker compose --env-file "$environment_file" -f "$compose_file" stop media-resolver || true
  fi
  if [[ -n "$old_recharge_image" ]]; then
    docker tag "$old_recharge_image" "${compose_project}-auto-recharge:latest" || true
  else
    docker compose --env-file "$environment_file" -f "$compose_file" stop auto-recharge || true
  fi
  atomic_current_switch "$PREVIOUS_RELEASE_DIRECTORY" || true
  cd "$PREVIOUS_RELEASE_DIRECTORY" || return
  previous_services=(migrate api admin caddy)
  if docker compose --env-file "$previous_environment_file" -f "$previous_compose_file" \
    config --services | grep -qx media-resolver; then
    previous_services=(migrate media-resolver api admin caddy)
  fi
  if docker compose --env-file "$previous_environment_file" -f "$previous_compose_file" config --services | grep -qx auto-recharge; then
    previous_services+=(auto-recharge)
  fi
  docker compose --env-file "$previous_environment_file" -f "$previous_compose_file" \
    up -d --no-build --force-recreate "${previous_services[@]}" || true
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
  if ((status != 0 && retention_timer_changed == 1)); then
    set +e
    if [[ -x "${PREVIOUS_RELEASE_DIRECTORY}/scripts/cleanup-aws-production-retention.sh" &&
          -f "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.service" &&
          -f "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.timer" ]]; then
      install -m 0644 -o root -g root \
        "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.service" \
        /etc/systemd/system/id-business-v2-production-retention.service
      install -m 0644 -o root -g root \
        "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-production-retention.timer" \
        /etc/systemd/system/id-business-v2-production-retention.timer
      systemctl daemon-reload >/dev/null 2>&1
      systemctl enable --now id-business-v2-production-retention.timer >/dev/null 2>&1
    else
      systemctl disable --now id-business-v2-production-retention.timer >/dev/null 2>&1
      rm -f -- \
        /etc/systemd/system/id-business-v2-production-retention.service \
        /etc/systemd/system/id-business-v2-production-retention.timer
      systemctl daemon-reload >/dev/null 2>&1
    fi
    set -e
  fi
  if ((status != 0 && performance_timer_changed == 1)); then
    set +e
    if [[ -f "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.service" &&
          -f "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.timer" &&
          -x "${PREVIOUS_RELEASE_DIRECTORY}/scripts/audit-aws-mysql-performance.sh" ]]; then
      install -m 0644 -o root -g root \
        "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.service" \
        /etc/systemd/system/id-business-v2-mysql-performance.service
      install -m 0644 -o root -g root \
        "${PREVIOUS_RELEASE_DIRECTORY}/deploy/systemd/id-business-v2-mysql-performance.timer" \
        /etc/systemd/system/id-business-v2-mysql-performance.timer
      systemctl daemon-reload >/dev/null 2>&1
      systemctl enable --now id-business-v2-mysql-performance.timer >/dev/null 2>&1
    else
      systemctl disable --now id-business-v2-mysql-performance.timer >/dev/null 2>&1
      rm -f -- \
        /etc/systemd/system/id-business-v2-mysql-performance.service \
        /etc/systemd/system/id-business-v2-mysql-performance.timer
      systemctl daemon-reload >/dev/null 2>&1
    fi
    set -e
  fi
  if ((deployment_succeeded == 1)); then
    echo "生产发布完成：${RELEASE_TAG} ${RELEASE_COMMIT}"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

timers_stopped=1
systemctl stop \
  id-business-v2-mysql-backup.timer \
  id-business-v2-mysql-backup-verify.timer \
  id-business-v2-mysql-performance.timer \
  id-business-v2-mysql-performance.service

backup_service='id-business-v2-mysql-backup.service'
backup_reused=0
if [[ "$RELEASE_BACKUP_POLICY" == recent ]]; then
  backup_result="$(systemctl show "$backup_service" --property=Result --value)"
  backup_timestamp="$(systemctl show "$backup_service" --property=ExecMainExitTimestamp --value)"
  backup_epoch="$(date -d "$backup_timestamp" +%s 2>/dev/null || true)"
  current_epoch="$(date +%s)"
  if [[ "$backup_result" == success && "$backup_epoch" =~ ^[0-9]+$ ]] &&
     ((current_epoch >= backup_epoch && current_epoch - backup_epoch <= 2700)); then
    backup_reused=1
    echo '复用 45 分钟内已验证的 S3 备份'
  fi
fi
if ((backup_reused == 0)); then
  echo '执行并校验更新前 S3 备份'
  systemctl start "$backup_service"
fi
if [[ "$(systemctl show "$backup_service" --property=Result --value)" != success ]]; then
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

if [[ "$RELEASE_MIGRATION_REQUIRED" == true ]]; then
  echo '执行生产数据库账号供应与向前 migration'
  run_gate_script scripts/provision-v2-production-database-access.mjs
  docker compose --env-file "$environment_file" -f "$compose_file" run --rm migrate
  run_gate_script scripts/provision-v2-production-database-access.mjs
  run_gate_script scripts/provision-v2-data-integrity-auditor.mjs
else
  echo '变更不含数据库 migration，复用现有数据库身份并执行完整性门禁'
fi

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
docker tag "$RELEASE_MEDIA_RESOLVER_IMAGE" "${compose_project}-media-resolver:latest"
docker tag "$RELEASE_RECHARGE_IMAGE" "${compose_project}-auto-recharge:latest"

echo '使用已校验制品更新受影响应用容器'
selected_images=",${RELEASE_CHANGED_IMAGES},"
selected_scopes=",${RELEASE_ACCEPTANCE_SCOPES},"
runtime_services=()
[[ "$selected_images" != *',mediaResolver,'* ]] || runtime_services+=(media-resolver)
[[ "$selected_images" != *',recharge,'* ]] || runtime_services+=(auto-recharge)
[[ "$selected_images" != *',api,'* ]] || runtime_services+=(api)
[[ "$selected_images" != *',admin,'* ]] || runtime_services+=(admin)
[[ "$selected_scopes" != *',gateway,'* ]] || runtime_services+=(caddy)
if [[ "$selected_scopes" == *',runtime-config,'* ]]; then
  runtime_services=(media-resolver auto-recharge api admin caddy)
fi
if ((${#runtime_services[@]} > 0)); then
  application_updated=1
  for service in "${runtime_services[@]}"; do
    docker compose --env-file "$environment_file" -f "$compose_file" \
      up -d --no-build --no-deps --force-recreate "$service"
  done
else
  echo '本版本无运行时镜像或网关配置变化，不重启应用容器'
fi

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

for service in mysql media-resolver auto-recharge api admin caddy; do
  wait_for_service "$service"
done

run_release_smoke() {
  docker run --rm --network host --env-file "$smoke_environment_file" \
    --env "RELEASE_ACCEPTANCE_SCOPES=$RELEASE_ACCEPTANCE_SCOPES" "$RELEASE_GATE_IMAGE" \
    node scripts/production-release-smoke.mjs
}

run_affected_service_acceptance() {
  local scope
  local container_id
  IFS=',' read -r -a release_scopes <<<"$RELEASE_ACCEPTANCE_SCOPES"
  for scope in "${release_scopes[@]}"; do
    case "$scope" in
      base|admin|api|auth|database|finance|gateway|runtime-config) ;;
      auto-recharge)
        container_id="$(docker compose --env-file "$environment_file" -f "$compose_file" ps -q auto-recharge)"
        docker exec "$container_id" python -c \
          "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8051/health',timeout=3)); assert data.get('busy') is False"
        ;;
      media-resolver|workspace)
        container_id="$(docker compose --env-file "$environment_file" -f "$compose_file" ps -q media-resolver)"
        docker exec "$container_id" python -c \
          "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8787/health',timeout=3).status == 200"
        ;;
      *)
        echo "发布清单包含未知验收范围：${scope}" >&2
        return 1
        ;;
    esac
  done
  printf '受影响服务验收通过：%s\n' "$RELEASE_ACCEPTANCE_SCOPES"
}

echo '执行切换前整站巡检'
run_release_smoke

atomic_current_switch "$RELEASE_DIRECTORY"
current_switched=1

echo '执行原子切换后整站巡检与财务门禁'
run_release_smoke
run_affected_service_acceptance
run_gate_script scripts/gate-v2-production-database-access.mjs
run_gate_script scripts/v2-data-integrity-audit.mjs

restore_backup_timers
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

for service in mysql media-resolver auto-recharge api admin caddy; do
  wait_for_service "$service"
done

echo '执行发布后制品与镜像保留策略'
DEPLOY_LOCK_HELD=1 \
  bash "${RELEASE_DIRECTORY}/scripts/cleanup-aws-production-retention.sh" --post-deploy

install_retention_timer
if ! systemctl is-enabled --quiet id-business-v2-production-retention.timer ||
   ! systemctl is-active --quiet id-business-v2-production-retention.timer; then
  echo '生产保留策略定时器状态异常' >&2
  exit 1
fi

install_performance_timer
if ! systemctl is-enabled --quiet id-business-v2-mysql-performance.timer ||
   ! systemctl is-active --quiet id-business-v2-mysql-performance.timer ||
   [[ "$(systemctl show id-business-v2-mysql-performance.service --property=Result --value)" != success ]]; then
  echo 'MySQL 性能巡检定时器或首次巡检状态异常' >&2
  exit 1
fi

chmod -R go-w "$RELEASE_DIRECTORY"
chmod 600 "$environment_file" "${RELEASE_DIRECTORY}/release-manifest.json"
deployment_succeeded=1
application_updated=0
current_switched=0
