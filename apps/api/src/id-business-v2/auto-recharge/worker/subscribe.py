"""独立入口：授权 JSON → 官网会话验证 → 可选的一次 Plus 建单；不付款。"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid

from checkout_core import (MAX_BYTES, ROOT, Stop, check_account, parse_browser_credential,
                           parse_credential, write_json)
from plans import PLANS


def main(argv=None):
    parser = argparse.ArgumentParser(description="JSON 恢复官方网页会话并测试指定套餐建单，始终停在付款前")
    parser.add_argument("--json-file", type=Path, help="授权 JSON 文件；只读入内存，省略时从 stdin 读取")
    parser.add_argument("--plan", choices=PLANS, default="plus", help="本次套餐：plus、pro-5x、pro-20x；默认 plus")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-session", action="store_true", help="默认：仅恢复并验证官网用户和账户，不建单")
    mode.add_argument("--create", action="store_true", help="核对官网会话后，通过官网所选套餐入口建单一次")
    mode.add_argument("--inspect-existing", action="store_true", help="只读打开当前账户已记录的原结算，不允许创建新结算")
    mode.add_argument("--diagnose-http", action="store_true", help="旧 HTTP 实现仅作只读账户诊断，不恢复会话、不建单")
    parser.add_argument("--retry-rejected", action="store_true", help="只允许一次重试明确拒绝的原建单；保留并关联旧记录")
    parser.add_argument("--wait-user-seconds", type=int, default=0, help="需要本人网页验证/真实账单资料时等待 Enter 的秒数，默认立即报告暂停")
    parser.add_argument("--review-seconds", type=int, default=0, help="报价通过后保留受付款拦截保护的窗口供查看，最多 600 秒")
    args = parser.parse_args(argv)
    if args.retry_rejected and not args.create:
        parser.error("--retry-rejected 必须与 --create 一起使用")
    if not 0 <= args.wait_user_seconds <= 600 or not 0 <= args.review_seconds <= 600:
        parser.error("等待时间必须在 0 到 600 秒内")
    try:
        if args.json_file:
            with args.json_file.open("rb") as f:
                raw = f.read(MAX_BYTES + 1)
        else:
            if sys.stdin.isatty():
                print("粘贴单个授权 JSON，然后按 Ctrl-D。网页交互建议使用 --json-file。", file=sys.stderr)
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if args.diagnose_http:
            credential = parse_credential(raw)
            del raw
            plan = check_account(credential)
            result = {"status": "account_checked", "account_matched": True, "current_plan": plan,
                      "session_status": "not_verified", "checkout_status": "not_attempted"}
        else:
            target = parse_browser_credential(raw)
            del raw
            from browser_checkout import run_browser
            result = asyncio.run(run_browser(target, create=args.create, inspect_existing=args.inspect_existing, retry_rejected=args.retry_rejected,
                                              wait_seconds=args.wait_user_seconds, review_seconds=args.review_seconds, target_plan=args.plan))
    except Stop as exc:
        result = exc.report
    except KeyboardInterrupt:
        result = {"status": "blocked", "reason": "interrupted", "checkout_status": "consult_attempt_record"}
    except (OSError, ValueError):
        result = {"status": "blocked", "reason": "local_io_or_record_error"}
    except Exception as exc:
        # Playwright 异常可能嵌入网络 URL/参数，不打印原始异常或完整堆栈。
        result = {"status": "blocked", "reason": "browser_startup_failed", "error_type": type(exc).__name__}
    result = {"timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "payment_status": "not_attempted", **result}
    try:
        reports = ROOT / "reports"
        if reports.is_symlink():
            raise OSError()
        reports.mkdir(mode=0o700, exist_ok=True)
        report_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
        write_json(reports / (report_id + ".json"), result, exclusive=True)
        result["report_file"] = f"reports/{report_id}.json"
    except OSError:
        result["report_write_failed"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result.get("status") in ("session_verified", "account_checked", "checkout_quote_verified") else 2


if __name__ == "__main__":
    raise SystemExit(main())
