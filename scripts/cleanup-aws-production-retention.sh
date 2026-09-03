#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

mode="${1:---scheduled}"
case "$mode" in
  --preflight|--post-deploy|--scheduled) ;;
  *)
    echo 'Usage: scripts/cleanup-aws-production-retention.sh [--preflight|--post-deploy|--scheduled]' >&2
    exit 1
    ;;
esac

deployment_root='/opt/id-business-v2'
release_keep_count=5
artifact_keep_count=3
minimum_free_bytes=8589934592

if [[ "$(id -u)" != 0 ]]; then
  echo '生产保留策略必须以 root 执行' >&2
  exit 1
fi

if [[ ! "$release_keep_count" =~ ^[0-9]+$ ]] ||
   ((release_keep_count < 2 || release_keep_count > 20)); then
  echo '发布目录保留数量必须介于 2 与 20 之间' >&2
  exit 1
fi
if [[ ! "$artifact_keep_count" =~ ^[0-9]+$ ]] ||
   ((artifact_keep_count < 2 || artifact_keep_count > 10)); then
  echo '不可变制品保留数量必须介于 2 与 10 之间' >&2
  exit 1
fi
if [[ ! "$minimum_free_bytes" =~ ^[0-9]+$ ]] || ((minimum_free_bytes < 1)); then
  echo '最小可用空间必须是正整数' >&2
  exit 1
fi

for command in awk basename df docker flock head id readlink rm sed sort systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "生产保留策略依赖命令不存在：${command}" >&2
    exit 1
  fi
done

releases_root="${deployment_root}/releases"
artifacts_root="${deployment_root}/artifacts"
current_link="${deployment_root}/current"
if [[ ! -d "$releases_root" || ! -d "$artifacts_root" || ! -L "$current_link" ]]; then
  echo '生产保留策略目录结构不完整' >&2
  exit 1
fi

if [[ "${DEPLOY_LOCK_HELD:-0}" == 1 ]]; then
  if ! flock -n 9; then
    echo '父发布进程未传递有效部署锁' >&2
    exit 1
  fi
else
  exec 9>"${deployment_root}/.deploy.lock"
  if ! flock -n 9; then
    if [[ "$mode" == --scheduled ]]; then
      echo '{"ok":true,"skipped":"deployment_in_progress"}'
      exit 0
    fi
    echo '另一个生产发布正在进行' >&2
    exit 1
  fi
fi

for maintenance_service in \
  id-business-v2-mysql-backup.service \
  id-business-v2-mysql-backup-verify.service; do
  if systemctl is-active --quiet "$maintenance_service"; then
    if [[ "$mode" == --scheduled ]]; then
      printf '{"ok":true,"skipped":"maintenance_in_progress","service":"%s"}\n' \
        "$maintenance_service"
      exit 0
    fi
    echo "生产维护任务正在执行：${maintenance_service}" >&2
    exit 1
  fi
done

current_release_directory="$(readlink -f "$current_link")"
case "$current_release_directory" in
  "${releases_root}/"*) ;;
  *) echo '生产 current 未指向受控发布目录' >&2; exit 1 ;;
esac
current_manifest="${current_release_directory}/release-manifest.json"
if [[ ! -f "$current_manifest" ]]; then
  echo '当前发布缺少发布清单' >&2
  exit 1
fi

read_manifest_commit() {
  local key="$1"
  local manifest="$2"
  sed -nE \
    "s/^[[:space:]]*\"${key}\":[[:space:]]*\"([a-f0-9]{40})\"[,]{0,1}[[:space:]]*$/\\1/p" \
    "$manifest" | head -n 1
}

current_commit="$(read_manifest_commit commit "$current_manifest")"
previous_commit="$(read_manifest_commit previousCommit "$current_manifest")"
if [[ ! "$current_commit" =~ ^[a-f0-9]{40}$ || ! "$previous_commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo '当前发布清单缺少有效的当前或上一生产 commit' >&2
  exit 1
fi

current_release_name="${current_release_directory##*/}"
previous_release_name=''
previous_short_commit="${previous_commit:0:12}"
while IFS= read -r release_name; do
  if [[ "$release_name" == *"-${previous_short_commit}" ]]; then
    previous_release_name="$release_name"
    break
  fi
done < <(
  for release_path in "$releases_root"/*; do
    [[ -d "$release_path" && ! -L "$release_path" ]] || continue
    basename "$release_path"
  done | LC_ALL=C sort -r
)
if [[ -z "$previous_release_name" ]]; then
  echo '找不到上一已验证生产发布目录' >&2
  exit 1
fi

is_protected_release() {
  [[ "$1" == "$current_release_name" || "$1" == *"-${previous_short_commit}" ]]
}

is_protected_artifact() {
  [[ "$1" == *"-${current_commit}" || "$1" == *"-${previous_commit}" ]]
}

available_bytes() {
  df -Pk "$deployment_root" | awk 'NR == 2 { printf "%.0f\n", $4 * 1024 }'
}

remove_release_directory() {
  local release_name="$1"
  local release_path="${releases_root}/${release_name}"
  local resolved_path
  if [[ ! "$release_name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]] ||
     [[ ! -d "$release_path" || -L "$release_path" ]]; then
    echo "拒绝删除不符合发布目录规则的路径：${release_name}" >&2
    exit 1
  fi
  resolved_path="$(readlink -f "$release_path")"
  if [[ "$resolved_path" != "$release_path" || "$resolved_path" == "$current_release_directory" ]]; then
    echo "拒绝删除受保护发布目录：${release_name}" >&2
    exit 1
  fi
  rm -rf -- "$resolved_path"
}

remove_artifact_directory() {
  local artifact_name="$1"
  local artifact_path="${artifacts_root}/${artifact_name}"
  local resolved_path
  if [[ ! "$artifact_name" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}$ ]] ||
     [[ ! -d "$artifact_path" || -L "$artifact_path" ]]; then
    echo "拒绝删除不符合制品目录规则的路径：${artifact_name}" >&2
    exit 1
  fi
  resolved_path="$(readlink -f "$artifact_path")"
  if [[ "$resolved_path" != "$artifact_path" ]]; then
    echo "拒绝删除非受控制品目录：${artifact_name}" >&2
    exit 1
  fi
  rm -rf -- "$resolved_path"
}

before_bytes="$(available_bytes)"
removed_release_count=0
removed_artifact_count=0
removed_image_reference_count=0
release_index=0
artifact_index=0

while IFS= read -r release_name; do
  [[ "$release_name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]] || continue
  release_index=$((release_index + 1))
  if ((release_index <= release_keep_count)) || is_protected_release "$release_name"; then
    continue
  fi
  remove_release_directory "$release_name"
  removed_release_count=$((removed_release_count + 1))
done < <(
  for release_path in "$releases_root"/*; do
    [[ -d "$release_path" && ! -L "$release_path" ]] || continue
    basename "$release_path"
  done | LC_ALL=C sort -r
)

while IFS= read -r artifact_name; do
  [[ "$artifact_name" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}$ ]] || continue
  artifact_index=$((artifact_index + 1))
  if ((artifact_index <= artifact_keep_count)) || is_protected_artifact "$artifact_name"; then
    continue
  fi
  remove_artifact_directory "$artifact_name"
  removed_artifact_count=$((removed_artifact_count + 1))
done < <(
  for artifact_path in "$artifacts_root"/*; do
    [[ -d "$artifact_path" && ! -L "$artifact_path" ]] || continue
    basename "$artifact_path"
  done | LC_ALL=C sort -r
)

while IFS= read -r image_reference; do
  [[ -n "$image_reference" && "$image_reference" != *':<none>' ]] || continue
  case "$image_reference" in
    id-business-v2-release-api:*|id-business-v2-release-admin:*|\
    id-business-v2-release-migration:*|id-business-v2-release-media-resolver:*|\
    id-business-v2-release-gate:*)
      image_tag="${image_reference##*:}"
      if [[ "$image_tag" == "$current_commit" || "$image_tag" == "$previous_commit" ]]; then
        continue
      fi
      ;;
    id-business-v2-rollback-*:*|id-business-v2-release-smoke:*|\
    id-business-v2-release-migrate:*|id-business-v2-migration-base:*) ;;
    *) continue ;;
  esac
  docker image rm "$image_reference" >/dev/null
  removed_image_reference_count=$((removed_image_reference_count + 1))
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | LC_ALL=C sort -u)

# 只回收删除项目标签后形成、且没有容器引用的悬空层；禁止清理 volume 或执行 system prune。
docker image prune --force >/dev/null

after_bytes="$(available_bytes)"
if [[ ! "$after_bytes" =~ ^[0-9]+$ ]] || ((after_bytes < minimum_free_bytes)); then
  echo "生产磁盘可用空间不足：${after_bytes} bytes，至少需要 ${minimum_free_bytes} bytes" >&2
  exit 1
fi

reclaimed_bytes=$((after_bytes - before_bytes))
if ((reclaimed_bytes < 0)); then
  reclaimed_bytes=0
fi
printf '{"ok":true,"mode":"%s","releaseKeep":%d,"artifactKeep":%d,"removedReleases":%d,"removedArtifacts":%d,"removedImageReferences":%d,"reclaimedBytes":%d,"availableBytes":%d,"minimumFreeBytes":%d}\n' \
  "${mode#--}" \
  "$release_keep_count" \
  "$artifact_keep_count" \
  "$removed_release_count" \
  "$removed_artifact_count" \
  "$removed_image_reference_count" \
  "$reclaimed_bytes" \
  "$after_bytes" \
  "$minimum_free_bytes"
