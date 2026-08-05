#!/usr/bin/env bash
set -euo pipefail

echo "backup-postgres.sh 已停用旧 Compose 数据库路径；转交生产备份门禁。" >&2
exec node scripts/backup-production-database.mjs "$@"
