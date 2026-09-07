#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if (($# != 3)); then
  echo 'Usage: load-production-release-images.sh <artifact> <artifact-sha256> <images-sha256>' >&2
  exit 1
fi
artifact_path="$1"
artifact_sha256="$2"
image_archive_sha256="$3"
if [[ ! -f "$artifact_path" || -L "$artifact_path" ]] ||
   [[ ! "$artifact_sha256" =~ ^[a-f0-9]{64}$ || ! "$image_archive_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo '镜像导入参数无效' >&2
  exit 1
fi
if [[ "$(sha256sum "$artifact_path" | awk '{print $1}')" != "$artifact_sha256" ]]; then
  echo '远程发布制品 SHA-256 校验失败' >&2
  exit 1
fi
if [[ "$(tar -tzf "$artifact_path" | sort | tr '\n' ' ')" != 'images.tar source.tar.gz ' ]]; then
  echo '远程发布制品内容无效' >&2
  exit 1
fi
if [[ "$(tar -xOzf "$artifact_path" images.tar | sha256sum | awk '{print $1}')" != "$image_archive_sha256" ]]; then
  echo '远程镜像归档 SHA-256 校验失败' >&2
  exit 1
fi

# Docker 自身仍需解包归档和新增镜像层；预留两倍归档空间及 1 GiB 余量。
image_archive_bytes="$(tar -xOzf "$artifact_path" images.tar | wc -c | tr -d '[:space:]')"
available_kib="$(df -Pk "$artifact_path" | awk 'NR == 2 { print $4 }')"
if [[ ! "$image_archive_bytes" =~ ^[0-9]+$ || ! "$available_kib" =~ ^[0-9]+$ ]] ||
   ((image_archive_bytes < 1 || image_archive_bytes > 1099511627776)); then
  echo '无法确认镜像导入所需空间' >&2
  exit 1
fi
required_kib=$(((image_archive_bytes * 2 + 1073741824 + 1023) / 1024))
if ((available_kib < required_kib)); then
  echo "镜像导入峰值空间不足：${available_kib} KiB，需要 ${required_kib} KiB" >&2
  exit 1
fi

# 完成校验后才启动 Docker；pipefail 保证解压或 Docker 任一失败均阻断安装。
tar -xOzf "$artifact_path" images.tar | docker load
