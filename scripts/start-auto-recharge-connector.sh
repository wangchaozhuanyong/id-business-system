#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "用法: npm run auto-recharge:connector -- --allowed-origin=https://管理端域名"
  exit 2
fi

CONNECTOR_PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CONNECTOR_RUNTIME_DIR="$CONNECTOR_PROJECT_DIR/.runtime/auto-recharge-connector"
CONNECTOR_VENV="$CONNECTOR_RUNTIME_DIR/venv"
CONNECTOR_REQUIREMENTS="$CONNECTOR_PROJECT_DIR/apps/api/src/id-business-v2/auto-recharge/worker/requirements.lock.txt"
CONNECTOR_ENTRY="$CONNECTOR_PROJECT_DIR/apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py"
CONNECTOR_PYTHON=""

for candidate in python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
    CONNECTOR_PYTHON="$candidate"
    break
  fi
done
if [ -z "$CONNECTOR_PYTHON" ]; then
  echo "本机连接器需要 Python 3.11 或更高版本"
  exit 2
fi

mkdir -p "$CONNECTOR_RUNTIME_DIR"
chmod 700 "$CONNECTOR_RUNTIME_DIR"
if [ ! -x "$CONNECTOR_VENV/bin/python" ]; then
  "$CONNECTOR_PYTHON" -m venv "$CONNECTOR_VENV"
elif ! "$CONNECTOR_VENV/bin/python" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
  echo "现有连接器虚拟环境低于 Python 3.11，请删除 $CONNECTOR_VENV 后重试"
  exit 2
fi
CONNECTOR_SETUPTOOLS_VERSION="84.0.0"
CONNECTOR_REQUIREMENTS_HASH="$("$CONNECTOR_VENV/bin/python" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read() + sys.argv[2].encode()).hexdigest())' "$CONNECTOR_REQUIREMENTS" "$CONNECTOR_SETUPTOOLS_VERSION")"
CONNECTOR_INSTALLED_HASH="$(cat "$CONNECTOR_RUNTIME_DIR/requirements.sha256" 2>/dev/null || true)"
if [ "$CONNECTOR_REQUIREMENTS_HASH" != "$CONNECTOR_INSTALLED_HASH" ]; then
  "$CONNECTOR_VENV/bin/python" -m pip install --disable-pip-version-check -r "$CONNECTOR_REQUIREMENTS" "setuptools==$CONNECTOR_SETUPTOOLS_VERSION"
  "$CONNECTOR_VENV/bin/python" -m pip check
  printf '%s\n' "$CONNECTOR_REQUIREMENTS_HASH" > "$CONNECTOR_RUNTIME_DIR/requirements.sha256"
fi
exec "$CONNECTOR_VENV/bin/python" "$CONNECTOR_ENTRY" "$@"
