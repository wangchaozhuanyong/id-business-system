#!/bin/sh
set -eu

SETUP_PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SETUP_ENTRY="$SETUP_PROJECT_DIR/apps/api/src/id-business-v2/online-recharge/connector/setup_background.py"
SETUP_PYTHON=""
for candidate in "$SETUP_PROJECT_DIR/.runtime/bitbrowser-recharge-assistant/venv/bin/python" "$HOME/Library/Application Support/IDBusinessV2AutoRechargeConnector/venv/bin/python" python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3,11))'; then
    SETUP_PYTHON="$candidate"
    break
  fi
done
if [ -z "$SETUP_PYTHON" ]; then
  /usr/bin/osascript -e 'display dialog "首次设置需要 Python 3.11 或以上版本。原助手不会被停止。" buttons {"知道了"} default button 1'
  exit 2
fi
if "$SETUP_PYTHON" "$SETUP_ENTRY" --interactive --apply; then
  /usr/bin/osascript -e 'display dialog "后台启动已配置。以后登录电脑后自动运行，日常只需操作网站；请回网站刷新电脑状态。" buttons {"完成"} default button 1'
else
  /usr/bin/osascript -e 'display dialog "设置未完成，请检查窗口中的提示。原任务与凭据不会被删除。" buttons {"知道了"} default button 1'
  exit 2
fi
