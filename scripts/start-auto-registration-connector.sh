#!/bin/sh
set -eu

REGISTRATION_PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REGISTRATION_ENTRY="$REGISTRATION_PROJECT_DIR/apps/api/src/id-business-v2/auto-registration/worker/browser_registration_connector.py"
# Reuse the already installed minimal Playwright environment; never install the recharge runner.
REGISTRATION_PYTHON="$REGISTRATION_PROJECT_DIR/.runtime/bitbrowser-recharge-assistant/venv/bin/python"
if [ ! -x "$REGISTRATION_PYTHON" ]; then
  REGISTRATION_COMMON_DIR="$(git -C "$REGISTRATION_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  case "$REGISTRATION_COMMON_DIR" in
    */.git)
      REGISTRATION_PRIMARY_DIR="${REGISTRATION_COMMON_DIR%/.git}"
      REGISTRATION_PYTHON="$REGISTRATION_PRIMARY_DIR/.runtime/bitbrowser-recharge-assistant/venv/bin/python"
      ;;
  esac
fi
if [ ! -x "$REGISTRATION_PYTHON" ]; then
  REGISTRATION_PYTHON="$HOME/Library/Application Support/IDBusinessV2AutoRechargeConnector/venv/bin/python"
fi
if [ "$#" -lt 1 ]; then
  echo "用法: sh scripts/start-auto-registration-connector.sh --allowed-origin=https://管理端域名"
  exit 2
fi
if [ ! -x "$REGISTRATION_PYTHON" ] || ! "$REGISTRATION_PYTHON" -c 'import sys; import playwright.async_api; raise SystemExit(sys.version_info < (3, 11))'; then
  echo "需要已安装的比特浏览器 Playwright 环境（Python 3.11 或更高版本），不会启动本机网站或数据库。"
  exit 2
fi
cd "$REGISTRATION_PROJECT_DIR"
exec "$REGISTRATION_PYTHON" -B "$REGISTRATION_ENTRY" "$@"
