"""重新授权 JSON 后只核验已有付款，不允许再次提交。"""
from __future__ import annotations

import asyncio
import os

from browser_checkout import ORIGIN, check_session, progress
from checkout_core import ROOT, Stop, session_cookies
from payment_network import PaymentGuard
from payment_state import outcome
from plans import subscription_match


async def recheck_in_context(context, target, ledger, *, timeout=25, poll_count=6, poll_interval=20):
    if not ledger.record:
        raise Stop("no_payment_attempt_to_recheck")
    from pay import verify_identity_again
    guard = PaymentGuard(target, ledger)
    guard.read_only = True
    guard.checkout_id = ledger.checkout_id
    guard.quote = ledger.record["quote"]
    guard.payment_state = ledger.record["payment_status"]
    guard.evidence = ledger.record.get("payment_evidence")
    tasks = set()
    def observe(response):
        task = asyncio.create_task(guard.response(response))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    await context.route("**/*", guard.route)
    await context.route_web_socket("**/*", lambda ws: ws.close())
    context.on("response", observe)
    identity = {"session_status": "not_verified", "account_matched": False, "current_plan": None}
    failure = {}
    try:
        await context.add_cookies(session_cookies(target))
        page = await context.new_page()
        await page.goto(ORIGIN, wait_until="domcontentloaded", timeout=45000)
        _, identity = await check_session(page, target, 0)
        guard.account_verified = True
        guard.approved = True  # 只启用原单证据解析，read_only 禁止所有付款。
        if not guard.evidence:
            progress("rechecking_original_payment", new_payments="blocked")
            await page.goto(ORIGIN + "/checkout/" + ledger.checkout["processor_entity"] + "/" + ledger.checkout_id,
                            wait_until="domcontentloaded", timeout=45000)
            try:
                await asyncio.wait_for(guard.payment_done.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                pass
        # 查单之后重新查询套餐，不能用查单前的 Free 或上一轮的 Plus 判定这次结果。
        for i in range(poll_count if guard.evidence else 1):
            identity = await verify_identity_again(page, target)
            if subscription_match(ledger.target_plan, identity["current_plan"], identity.get("current_tier")) == "matched" or not guard.evidence:
                break
            if i + 1 < poll_count:
                progress("paid_pending_activation", check=i + 1, next_check_seconds=poll_interval)
                await asyncio.sleep(poll_interval)
    except Stop as exc:
        failure = {key: value for key, value in exc.report.items() if key != "status"}
        identity = {"session_status": "not_verified", "account_matched": False, "current_plan": None}
    except Exception as exc:
        failure = {"reason": "original_payment_recheck_failed", "error_type": type(exc).__name__}
        identity = {"session_status": "not_verified", "account_matched": False, "current_plan": None}
    finally:
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)
        context.remove_listener("response", observe)
    guard.persist_observation(current_plan=identity["current_plan"], current_tier=identity.get("current_tier"))
    matched = subscription_match(ledger.target_plan, identity["current_plan"], identity.get("current_tier"))
    return {"status": outcome(guard.payment_state, identity["current_plan"], guard.evidence,
                               target_plan=ledger.target_plan, current_tier=identity.get("current_tier")),
            "stage": "original_payment_recheck", **identity, **guard.summary(), **failure,
            "subscription_status": ledger.target_plan if matched == "matched" else matched,
            "recheck_only": True}


async def recheck_payment(target, ledger, *, timeout=25):
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".browsers"))
    for key in ("DEBUG", "PWDEBUG", "PW_TRACE_DIR", "PLAYWRIGHT_TRACE_DIR"):
        os.environ.pop(key, None)
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        try:
            context = await browser.new_context(service_workers="block", accept_downloads=False)
            try:
                return await recheck_in_context(context, target, ledger, timeout=timeout)
            finally:
                await context.close()
        finally:
            await browser.close()
