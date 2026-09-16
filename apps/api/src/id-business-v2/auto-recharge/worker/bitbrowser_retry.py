"""Retry read-only and pre-payment failures in windows explicitly owned by the job."""
import asyncio
import re
import time

import bitbrowser_options
import pay
import payment_recovery
import payment_state
from browser_session import SessionBudget, retryable_session_result
from checkout_core import Stop


async def cleanup_profile_id(job, client, profile_id, *, cancelling=False):
    if not re.fullmatch(r"[a-fA-F0-9]{32}", profile_id or ""):
        raise Stop("bitbrowser_cleanup_unverified")
    try:
        await asyncio.to_thread(client.post, "/browser/close", {"id": profile_id})
        deadline = time.monotonic() + 15
        while True:
            if not cancelling:
                job.check_cancelled()
            pids = await asyncio.to_thread(client.post, "/browser/pids/alive", {"ids": [profile_id]})
            if not isinstance(pids, dict) or any(key != profile_id for key in pids):
                raise Stop("bitbrowser_cleanup_unverified")
            if profile_id not in pids or pids[profile_id] in (0, None):
                break
            if time.monotonic() >= deadline:
                raise Stop("bitbrowser_cleanup_unverified")
            await asyncio.sleep(0.25)
        if not cancelling:
            job.check_cancelled()
        await asyncio.to_thread(client.post, "/browser/delete", {"id": profile_id})
    except Stop as exc:
        if exc.report.get("reason") == "operation_cancelled":
            raise
        raise Stop("bitbrowser_cleanup_unverified", browser_profile_id=profile_id) from None


async def cleanup_profile(job, client, owned, *, cancelling=False):
    profile_id = job.profile_id
    if profile_id not in owned:
        raise Stop("bitbrowser_cleanup_unverified")
    job.progress("bitbrowser_profile_cleanup", _during_cancel=cancelling)
    await cleanup_profile_id(job, client, profile_id, cancelling=cancelling)
    owned.remove(profile_id)
    job.profile_id = None
    job.context = None


async def cleanup_stale_profiles(job, client):
    """Delete only the exact pre-payment profile IDs authorized by the API."""
    if not job.stale_profiles:
        return
    available = await asyncio.to_thread(client.list_profile_ids)
    cleaned = []
    total = len(job.stale_profiles)
    for position, item in enumerate(job.stale_profiles, 1):
        job.check_cancelled()
        profile_id = item["profileId"]
        job.progress("stale_profile_cleanup", stale_profiles_cleaned=len(cleaned),
                     stale_profiles_total=total, stale_profile_position=position)
        if profile_id in available:
            await cleanup_profile_id(job, client, profile_id)
            available.remove(profile_id)
        cleaned.append(item)
        job.stale_profiles_cleaned = len(cleaned)
    job.callback.send({
        "type": "stale_profile_cleanup",
        "accountKey": job.account_key,
        "profiles": cleaned,
    })


async def execute_profiles(job, client, target, playwright):
    await cleanup_stale_profiles(job, client)
    owned = set()
    try:
        result = await _execute_profiles(job, client, target, playwright, owned)
    except Stop as exc:
        if not job.cancelled:
            raise
        result = exc.report
    if job.cancelled and job.payload["mode"] == "payment" and not job.payment_request_sent:
        cleanup = "not_needed"
        try:
            if job.profile_id:
                await cleanup_profile(job, client, owned, cancelling=True)
                cleanup = "completed"
        except Stop:
            cleanup = "failed"
        return {**result, "status": "cancelled", "cancellation_confirmed": True,
                "reason": "bitbrowser_cleanup_unverified" if cleanup == "failed" else "operation_cancelled",
                "browser_cleanup_status": cleanup, "payment_requests_sent": 0,
                "payment_attempted": False, "browser_profile_id": job.profile_id or ""}
    if terminal_cleanup_allowed(job, result):
        original_reason = result.get("reason")
        try:
            await cleanup_profile(job, client, owned)
            result.update(browser_cleanup_status="completed", browser_profile_id="")
        except Stop:
            result.update(reason="bitbrowser_cleanup_unverified",
                          last_reason=original_reason,
                          browser_cleanup_status="failed",
                          browser_profile_id=job.profile_id or "")
    if "browser_profile_id" not in result:
        result["browser_profile_id"] = job.profile_id or ""
    return result


def terminal_cleanup_allowed(job, result):
    """充值不成功不自动关闭比特浏览器窗口，保留现场供操作人排查原因。"""
    return False


async def cancellable_flow(job, target, **kwargs):
    kwargs["allow_checkout_replacement"] = not job.checkout_replacement_performed
    task = asyncio.create_task(pay.run_flow(target, job.root, job.payload["plan"], **kwargs))
    try:
        while not task.done():
            job.check_cancelled()
            await asyncio.wait({task}, timeout=.2)
        job.check_cancelled()
        result = await task
        if result.get("checkout_replacement_performed") is True:
            job.checkout_replacement_performed = True
        return result
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def _execute_profiles(job, client, target, playwright, owned):
    bit = job.payload["bitBrowser"]
    options = bitbrowser_options.validate_options(bit.get("browserOptions"))
    attempts = options["sessionRetryLimit"] + 1 if job.payload["mode"] == "payment" else 1
    for attempt in range(1, attempts + 1):
        job.check_cancelled()
        job.session_info = {"session_attempt": attempt, "session_attempt_limit": attempts,
                            "session_elapsed_seconds": 0,
                            "session_wait_seconds": options["sessionWaitMinutes"] * 60,
                            "session_step": "page_load", "session_refresh_count": 0}
        job.initial_session_verified = False
        job.progress("bitbrowser_group")
        profile_id = await asyncio.to_thread(client.create_profile, bit, job.payload["windowName"].strip())
        job.profile_id = profile_id
        owned.add(profile_id)
        job.progress("bitbrowser_profile_created")
        endpoint = await asyncio.to_thread(client.open_profile, profile_id)
        job.progress("bitbrowser_profile_opened")
        browser = await playwright.chromium.connect_over_cdp(endpoint)
        if not browser.contexts:
            raise Stop("bitbrowser_context_missing")
        job.context = browser.contexts[0]
        job.check_cancelled()
        if job.payload["mode"] == "recheck":
            with payment_state.PaymentLedger(job.root, target.account_id,
                                             target_plan=job.payload["plan"]) as ledger:
                result = await payment_recovery.recheck_in_context(
                    job.context, target, ledger, timeout=25, poll_count=6, poll_interval=20)
                return pay.include_payment_record(result, ledger)

        if job.payload["mode"] == "open_browser":
            budget = SessionBudget(options["sessionWaitMinutes"] * 60,
                                   cancelled=lambda: job.cancelled,
                                   report=lambda **details: job.progress("session_restore", **details))
            from browser_checkout import restore_session_with_refresh
            from checkout_core import session_cookies
            from urllib.parse import urlsplit
            await job.context.add_cookies(session_cookies(target))
            job.progress("session_restore")
            page = next((p for p in job.context.pages if p.url == "about:blank" or
                         (urlsplit(p.url).hostname == "chatgpt.com"
                          and (urlsplit(p.url).path in ("", "/")
                               or urlsplit(p.url).path.startswith("/checkout/")))), None)
            page = page or await job.context.new_page()
            page.set_default_timeout(20000)
            _, identity = await restore_session_with_refresh(
                page, target, wait_seconds=1800, budget=budget
            )
            job.progress("session_ready", account_matched=True, **identity)
            return {
                "status": "session_ready",
                "stage": "session_ready",
                "account_matched": True,
                "browser_profile_id": profile_id,
                "current_plan": identity.get("current_plan", "unknown"),
                "payment_attempted": False,
                "payment_requests_sent": 0,
            }

        budget = SessionBudget(options["sessionWaitMinutes"] * 60,
                               cancelled=lambda: job.cancelled,
                               report=lambda **details: job.progress("session_restore", **details))
        result = await cancellable_flow(
            job, target, details_reader=job.details,
            confirmer=job.confirm, wait_seconds=1800, poll_count=6, poll_interval=20,
            browser_context=job.context, session_budget=budget)
        result.update(job.session_info)
        if not retryable_session_result(result):
            return result
        job.check_cancelled()
        result.update(session_elapsed_seconds=min(int(budget.elapsed), budget.seconds),
                      session_step=budget.step)
        job.session_info.update({key: value for key, value in result.items() if key.startswith("session_")
                                 and key in job.session_info})
        if attempt == attempts:
            exhausted = ("session_retries_exhausted" if result.get("stage") == "session_restore"
                         else "prepayment_retries_exhausted")
            return {**result, "reason": exhausted,
                    "last_reason": result.get("reason"), "browser_profile_id": job.profile_id or ""}
        try:
            await cleanup_profile(job, client, owned)
        except Stop as exc:
            return {**result, **exc.report}
        job.progress("bitbrowser_profile_rebuilding")
    raise Stop("session_retries_exhausted")
