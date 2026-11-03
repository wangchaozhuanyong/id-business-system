"""登录后后台运行原充值助手；诊断输出只写本项目私有运行目录。"""
import os
from pathlib import Path
import sys


def main():
    root = Path(__file__).resolve().parents[6]
    runtime = root / '.runtime/bitbrowser-recharge-assistant'
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    if runtime.is_symlink():
        raise SystemExit(2)
    log = runtime / 'background.log'
    if log.is_symlink():
        raise SystemExit(2)
    fd = os.open(log, os.O_CREAT | os.O_WRONLY | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'a', buffering=1, encoding='utf-8') as stream:
        sys.stdout = sys.stderr = stream
        sys.path.insert(0, str(root / 'apps/api/src/id-business-v2/auto-recharge/worker'))
        try:
            import bitbrowser_connector
            bitbrowser_connector.main()
        except KeyboardInterrupt:
            return
        except Exception as error:
            print('后台助手暂未就绪：' + type(error).__name__, flush=True)
            raise SystemExit(1) from None


if __name__ == '__main__':
    main()
