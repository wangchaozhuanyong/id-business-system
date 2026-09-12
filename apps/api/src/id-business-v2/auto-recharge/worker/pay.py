"""单账户银行卡付款入口：默认准备，--pay 必须现场确认金额；不保存支付资料。"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import warnings

from browser_checkout import (ORIGIN, check_session, progress, quote_from_page, run_browser)
from attempt_ledger import checkout_record_path
from checkout_core import MAX_BYTES, ROOT, Stop, parse_browser_credential, write_json
from payment_form import (PaymentDetails, fill_official_form, subscribe_button, validate_details,
                          verify_billing_fields, verify_card_fields)
from payment_network import PaymentGuard
from payment_state import PaymentLedger, outcome, quote_digest, validate_evidence
from plans import PLANS, plan_spec, subscription_match


def focus_input_terminal():
    # Chromium 会抢到前台；请求本机隐藏输入时将启动它的 Terminal 带回来。
    if sys.platform == "darwin" and os.environ.get("TERM_PROGRAM") == "Apple_Terminal":
        try:
            subprocess.run(["osascript", "-e", 'tell application "Terminal" to activate'],
                           capture_output=True, timeout=3, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass


def read_details():
    if not sys.stdin.isatty():
        raise Stop("local_secure_terminal_required")
    focus_input_terminal()
    prompts = {"number": "银行卡号", "expiry": "有效期 MM/YY", "cvc": "本次安全码",
               "name": "持卡人真实姓名", "email": "账单邮箱", "country": "真实账单国家两位代码",
               "line1": "真实街道地址", "line2": "地址第二行（可留空）", "city": "城市",
               "state": "州/省（当地不需要可留空）", "postal_code": "邮编"}
    print("在本机终端输入授权资料；全部不回显、不写文件。不要把银行卡或安全码发到聊天。", flush=True)
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        values = {key: getpass.getpass(label + "：").strip() for key, label in prompts.items()}
    return validate_details(PaymentDetails(**values))


def choose_plan():
    if not sys.stdin.isatty():
        raise Stop("local_plan_selection_required")
    focus_input_terminal()
    print("请选择本次使用的原结算；一次只开通一个套餐。", flush=True)
    choices = {str(i): key for i, key in enumerate(PLANS, 1)}
    for number, key in choices.items():
        print(f"{number}. {PLANS[key]['label']}", flush=True)
    choice = input("输入 1、2 或 3，其他输入取消：").strip()
    if choice not in choices:
        raise Stop("plan_selection_cancelled")
    return choices[choice]


def confirm_quote(quote, last4):
    if not sys.stdin.isatty():
        raise Stop("local_payment_confirmation_required")
    focus_input_terminal()
    today, renewal = quote["today"], quote["renewal"]
    phrase = f"确认付款 {today['currency']} {today['amount']}"
    print(f"\n目标账户已与 JSON 核对；{plan_spec(quote['plan'])['label']}；银行卡尾号 {last4}。", flush=True)
    print(f"今日应付 {today['currency']} {today['amount']}；续费 {renewal['currency']} {renewal['amount']}/月，直至取消。", flush=True)
    print("仅对这张官方结算提交一次付款。需要本人银行验证时暂停；未知结果不再次扣款。", flush=True)
    entered = input(f"确认本次金额和续费后输入「{phrase}」，其他输入取消：").strip()
    return entered == phrase


async def verified_quote_once(page, guard):
    binding = guard.official_quote_binding
    if not binding:
        return None
    quote = await quote_from_page(page)
    if not quote.get("today"):
        # 这里的币种来自绑定当前订单的官网初始化响应，不是按国家猜测。
        quote = await quote_from_page(page, binding["currency"])
    today = quote.get("today")
    if (not today or quote.get("tax") is None or not quote.get("renewal")
            or quote.get("renewal_interval") != "monthly"
            or today.get("currency") != binding["currency"]
            or today.get("amount_minor") != binding["amount_minor"]):
        return None
    try:
        quote_digest(quote)
    except Stop:
        return None
    return quote


async def current_quote(page, guard, minimum_binding_version=0):
    previous = None
    for _ in range(30):
        quote = (await verified_quote_once(page, guard)
                 if guard.official_binding_version >= minimum_binding_version else None)
        digest = quote_digest(quote) if quote else None
        if digest and digest == previous:
            return quote
        previous = digest
        await asyncio.sleep(.3)
    raise Stop("payment_quote_not_ready")


async def verify_identity_again(page, target):
    check_page = await page.context.new_page()
    try:
        await check_page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=45000)
        _, identity = await check_session(check_page, target, 0)
        return identity
    finally:
        await check_page.close()
        await page.bring_to_front()


async def payment_handler(page, guard, identity, ledger, target, *, pay, details_reader, confirmer,
                          wait_seconds, poll_count, poll_interval):
    selected_plan = ledger.target_plan
    if os.environ.get("AUTO_RECHARGE_CALLBACK_URL") and not identity.get("network", {}).get("country"):
        raise Stop("network_unconfirmed")
    details = await asyncio.to_thread(details_reader)
    try:
        binding_before = guard.official_binding_version
        prepared = await fill_official_form(page, details)
        # 若地址改变了金额，页面新值与旧初始化回执不同会自动阻断；
        # 免税地址前后总额相同时，不强迫官网重复发送同一 init 请求。
        quote = await current_quote(page, guard, max(1, binding_before))
        if quote["plan"] != selected_plan:
            raise Stop("payment_quote_plan_mismatch")
        await verify_billing_fields(page, details, prepared["billing_fields_filled"])
        if not pay:
            progress("payment_prepared", quote=quote, payment="blocked")
            return {"status": "payment_prepared", "stage": "payment_ready", "quote": quote,
                    "quote_authority": "official_checkout_response", **prepared}
        fingerprint = quote_digest(quote)
        start = time.monotonic()
        if not await asyncio.to_thread(confirmer, quote, details.last4):
            return {"status": "payment_cancelled", "stage": "confirmation_cancelled", "quote": quote}
        if time.monotonic() - start > 300:
            raise Stop("payment_confirmation_expired")
        identity = await verify_identity_again(page, target)
        if identity["current_plan"] != "free":
            raise Stop("incompatible_existing_subscription")
        if ledger.checkout_id not in page.url:
            raise Stop("checkout_page_identifier_unverified")
        await verify_card_fields(page, details)
        await verify_billing_fields(page, details, prepared["billing_fields_filled"])
        try:
            current = await current_quote(page, guard, guard.official_binding_version)
        except Stop as exc:
            if exc.report.get("reason") == "payment_quote_not_ready":
                raise Stop("payment_quote_changed") from None
            raise
        if quote_digest(current) != fingerprint:
            raise Stop("payment_quote_changed", quote=current)
        button = await subscribe_button(page)

        async def preflight():
            current_quote_value = await verified_quote_once(page, guard)
            if (ledger.checkout_id not in page.url or not current_quote_value
                    or quote_digest(current_quote_value) != fingerprint):
                raise Stop("payment_quote_changed")

        guard.validate_before_confirm = preflight
        ledger.begin(quote, confirmed_digest=fingerprint, card_last4=details.last4)
        guard.approve(quote)
        # 请求与 UI 重复点击均由单次 guard 和落盘标记保护。
        await button.click()
        progress("payment_submitted_or_pending", repeated_payment="blocked")
        deadline = time.monotonic() + wait_seconds
        verification_announced = False
        while time.monotonic() < deadline:
            if guard.payment_state in {"paid", "declined"}:
                break
            if guard.payment_state == "requires_action" and not verification_announced:
                progress("bank_verification_required", instruction="请本人完成官网或银行验证，程序只等待原单结果。")
                verification_announced = True
            if guard.payment_error and guard.payment_state != "requires_action":
                break
            await asyncio.sleep(.5)
        latest_plan = identity["current_plan"]
        latest_tier = None
        for i in range(poll_count if guard.payment_state == "paid" else 1):
            try:
                latest = await verify_identity_again(page, target)
                latest_plan, latest_tier = latest["current_plan"], latest.get("current_tier")
            except Exception:
                latest_plan, latest_tier = None, None
            if subscription_match(selected_plan, latest_plan, latest_tier) == "matched" or guard.payment_state != "paid":
                break
            if i + 1 < poll_count:
                progress("paid_pending_activation", check=i + 1, next_check_seconds=poll_interval)
                await asyncio.sleep(poll_interval)
        guard.persist_observation(current_plan=latest_plan, current_tier=latest_tier)
        matched = subscription_match(selected_plan, latest_plan, latest_tier)
        return {"status": outcome(guard.payment_state, latest_plan, guard.evidence, target_plan=selected_plan, current_tier=latest_tier), "stage": "payment_result",
                "quote": quote, "quote_authority": "official_checkout_response",
                "current_plan": latest_plan, "current_tier": latest_tier,
                "subscription_status": selected_plan if matched == "matched" else matched,
                "inspection_only": False, **prepared}
    finally:
        details.clear()


async def run_payment(target, ledger, *, pay=False, details_reader=read_details, confirmer=confirm_quote,
                      wait_seconds=300, poll_count=6, poll_interval=20, browser=None,
                      browser_context=None):
    ledger.assert_unattempted()
    selected_plan = ledger.target_plan

    async def handler(page, guard, identity, original_quote):
        return await payment_handler(page, guard, identity, ledger, target, pay=pay,
                                     details_reader=details_reader, confirmer=confirmer,
                                     wait_seconds=wait_seconds, poll_count=poll_count,
                                     poll_interval=poll_interval)

    return await run_browser(target, inspect_existing=True, quote_handler=handler,
                             guard_factory=lambda target, _: PaymentGuard(target, ledger), target_plan=selected_plan,
                             state_dir=ledger.root, browser=browser, browser_context=browser_context)


async def run_flow(target, state_dir, target_plan, *, details_reader, confirmer,
                   wait_seconds=120, poll_count=6, poll_interval=20, browser=None,
                   browser_context=None):
    ledger_holder = {}

    async def handler(page, guard, identity, original_quote):
        checkout_lock = getattr(guard.ledger, "fd", None)
        # 新建结算时复用建单锁；读取现有结算时则正常申请账户锁。
        # 两条路径都在当前浏览器会话内等待账单资料和确认。
        with PaymentLedger(state_dir, target.account_id, target_plan=target_plan,
                           held_lock_fd=checkout_lock) as ledger:
            ledger.assert_unattempted()
            guard.attach_payment_ledger(ledger)
            ledger_holder["ledger"] = ledger
            return await payment_handler(page, guard, identity, ledger, target, pay=True,
                                         details_reader=lambda: details_reader(original_quote),
                                         confirmer=confirmer,
                                         wait_seconds=wait_seconds, poll_count=poll_count,
                                         poll_interval=poll_interval)

    browser_args = {
        "quote_handler": handler,
        "guard_factory": lambda target, checkout_ledger: PaymentGuard(
            target, checkout_ledger=checkout_ledger, target_plan=target_plan),
        "target_plan": target_plan,
        "state_dir": state_dir,
        "browser": browser,
        "browser_context": browser_context,
    }
    record_path = checkout_record_path(state_dir, target.account_id, target_plan)
    if record_path.exists():
        result = await run_browser(target, inspect_existing=True, **browser_args)
        if (result.get("reason") == "existing_checkout_unavailable"
                and not result.get("payment_attempted")
                and not result.get("confirmation_requests_sent")):
            result = await run_browser(target, create=True, replace_unpaid_checkout=True, **browser_args)
    else:
        result = await run_browser(target, create=True, **browser_args)
    return include_payment_record(result, ledger_holder.get("ledger"))


def include_payment_record(result, ledger):
    """磁盘旧状态只补充结果，不能覆盖本次确认的付款证据或冒充本次套餐查询。"""
    if not ledger or not ledger.record:
        return result
    result = dict(result)
    evidence = result.get("payment_evidence") or ledger.record.get("payment_evidence")
    if evidence:
        validate_evidence(evidence, ledger.checkout_id, ledger.record["quote"])
    result.update(payment_attempted=True, repeated_payment="blocked", payment_evidence=evidence)
    result["payment_status"] = "paid" if evidence else result.get("payment_status", ledger.record["payment_status"])
    if result["payment_status"] == "not_attempted":
        result["payment_status"] = ledger.record["payment_status"]
    current_plan = result.get("current_plan") if result.get("account_matched") else None
    result["target_plan"] = ledger.target_plan
    result["payment_outcome"] = outcome(result["payment_status"], current_plan, evidence,
                                        target_plan=ledger.target_plan, current_tier=result.get("current_tier"))
    if result.get("status") in {"blocked", "interrupted"} and evidence:
        result["status"] = outcome("paid", None, evidence, target_plan=ledger.target_plan)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="单笔银行卡订阅：默认只准备；付款必须在终端核对金额")
    parser.add_argument("--json-file", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--plan", choices=PLANS, default="plus", help="所选原结算套餐；默认 plus")
    selection.add_argument("--choose-plan", action="store_true", help="在本机终端选择本次使用的原结算套餐")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="默认：自动填写本次资料并重新核价，不付款")
    mode.add_argument("--pay", action="store_true", help="填写资料后展示金额，现场确认后仅提交一次付款")
    mode.add_argument("--recheck", action="store_true", help="重启或结果未知时只查原付款，禁止再次扣款")
    parser.add_argument("--wait-seconds", type=int, default=300)
    args = parser.parse_args(argv)
    if not 1 <= args.wait_seconds <= 600:
        parser.error("等待时间须在 1 到 600 秒")
    ledger = None
    try:
        with args.json_file.open("rb") as f:
            target = parse_browser_credential(f.read(MAX_BYTES + 1))
        selected_plan = choose_plan() if args.choose_plan else args.plan
        with PaymentLedger(ROOT / ".state", target.account_id, target_plan=selected_plan) as ledger:
            if args.recheck:
                from payment_recovery import recheck_payment
                result = asyncio.run(recheck_payment(target, ledger))
            else:
                result = asyncio.run(run_payment(target, ledger, pay=args.pay, wait_seconds=args.wait_seconds))
    except Stop as exc:
        result = exc.report
    except KeyboardInterrupt:
        result = {"status": "interrupted", "reason": "consult_original_payment_record"}
    except Exception as exc:
        result = {"status": "blocked", "reason": "payment_operation_failed", "error_type": type(exc).__name__}
    result = include_payment_record(result, ledger)
    result["timestamp_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        path = ROOT / "reports" / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-payment-" + uuid.uuid4().hex[:8] + ".json")
        if path.parent.is_symlink():
            raise OSError()
        path.parent.mkdir(mode=0o700, exist_ok=True)
        write_json(path, result, exclusive=True)
        result["report_file"] = str(path.relative_to(ROOT))
    except OSError:
        result["report_write_failed"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result.get("status") in {"payment_prepared", "subscription_activated"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
