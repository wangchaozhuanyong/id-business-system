#!/usr/bin/env bash
set -euo pipefail

if [[ "${RESTORE_TARGET:-}" != "isolated" ]]; then
  echo "拒绝直接恢复：RESTORE_TARGET 必须明确为 isolated；生产库不允许使用此入口。" >&2
  exit 1
fi
if [[ -z "${BACKUP_PRIVATE_KEY_FILE:-}" ]]; then
  echo "缺少 BACKUP_PRIVATE_KEY_FILE。" >&2
  exit 1
fi
if [[ "$#" -ne 1 || "$1" != *.backup.enc ]]; then
  echo "Usage: RESTORE_TARGET=isolated BACKUP_PRIVATE_KEY_FILE=... $0 file.backup.enc" >&2
  exit 1
fi

exec node scripts/restore-production-backup-drill.mjs \
  "--archive=$1" \
  "--private-key=${BACKUP_PRIVATE_KEY_FILE}"
