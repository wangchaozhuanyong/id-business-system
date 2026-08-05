#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 backups/postgres/file.dump" >&2
  exit 1
fi

exec node scripts/verify-production-backup.mjs "--backup=$1"
