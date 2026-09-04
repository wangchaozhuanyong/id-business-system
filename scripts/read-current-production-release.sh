#!/usr/bin/env bash
set -Eeuo pipefail

deployment_root="${1:-}"
if [[ -z "$deployment_root" || ! -d "$deployment_root" ]]; then
  echo '生产目录不存在' >&2
  exit 1
fi
deployment_root="$(cd "$deployment_root" && pwd -P)"

current_link="${deployment_root}/current"
if [[ ! -L "$current_link" ]]; then
  echo '生产 current 不是符号链接' >&2
  exit 1
fi
current_release_directory="$(cd "$current_link" && pwd -P)"
case "$current_release_directory" in
  "${deployment_root}/releases/"*) ;;
  *) echo '生产 current 未指向受控的不可变发布目录' >&2; exit 1 ;;
esac

current_manifest="${current_release_directory}/release-manifest.json"
if [[ ! -f "$current_manifest" ]]; then
  echo '当前生产发布缺少发布清单' >&2
  exit 1
fi
current_commit="$(
  sed -nE 's/^[[:space:]]*"commit":[[:space:]]*"([a-f0-9]{40})"[,]?[[:space:]]*$/\1/p' \
    "$current_manifest" | head -n 1
)"
current_release_tag="$(
  sed -nE 's/^[[:space:]]*"releaseTag":[[:space:]]*"(v2-production-[0-9]{8}T[0-9]{6}Z)"[,]?[[:space:]]*$/\1/p' \
    "$current_manifest" | head -n 1
)"
if [[ ! "$current_commit" =~ ^[a-f0-9]{40}$ ||
      ! "$current_release_tag" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo '当前生产发布清单缺少有效 commit 或正式标签' >&2
  exit 1
fi

printf '%s\t%s\t%s\n' "$current_release_directory" "$current_commit" "$current_release_tag"
