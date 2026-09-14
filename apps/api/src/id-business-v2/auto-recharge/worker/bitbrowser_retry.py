"""Retry only the initial, read-only session of windows owned by this job."""
import asyncio
import re
import time

import bitbrowser_options
import pay
import payment_recovery
import payment_state
from browser_session import SessionBudget, retryable_session_result
from checkout_core import Stop


async def cleanup_profile(job, client, owned, *, cancelling=False):
    profile_id = job.profile_id
    if profile_id not in owned or not re.fullmatch(r"[a-fA-F0-9]{32}", profile_id or ""):
        raise Stop("bitbrowser_cleanup_unverified")
    job.progress("bitbrowser_profile_cleanup", _during_cancel=cancelling)
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
        owned.remove(profile_id)
        job.profile_id = None
        job.context = None
    except Stop as exc:
        if exc.report.get("reason") == "operation_cancelled":
            raise
        raise Stop("bitbrowser_cleanup_unverified", browser_profile_id=profile_id) from None


async def execute_profiles(job, client, target, playwright):
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
    return result


def terminal_cleanup_allowed(job, result):
    """A finished pre-payment failure must not leave a duplicate owned window."""
    return bool(
        job.payload["mode"] == "payment"
        and job.profile_id
        and result.get("reason")
        and result.get("reason") != "bitbrowser_cleanup_unverified"
        and result.get("browser_cleanup_status") != "failed"
        and result.get("user_action_required") is not True
        and not job.payment_request_sent
        and result.get("payment_attempted") is not True
        and int(result.get("payment_requests_sent", 0) or 0) == 0
        and int(result.get("confirmation_requests_sent", 0) or 0) == 0
    )


async def cancellable_flow(job, target, **kwargs):
    task = asyncio.create_task(pay.run_flow(target, job.root, job.payload["plan"], **kwargs))
    try:
        while not task.done():
            job.check_cancelled()
            await asyncio.wait({task}, timeout=.2)
        job.check_cancelled()
        return await task
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

        budget = SessionBudget(options["sessionWaitMinutes"] * 60,
                               cancelled=lambda: job.cancelled,
                               report=lambda **details: job.progress("session_restore", **details))
        result = await cancellable_flow(
            job, target, details_reader=job.details,
            confirmer=job.confirm, wait_seconds=1800, poll_count=6, poll_interval=20,
            browser_context=job.context, session_budget=budget)
        result.update(job.session_info)
        if job.initial_session_verified or not retryable_session_result(result):
            return result
        job.check_cancelled()
        result.update(session_elapsed_seconds=min(int(budget.elapsed), budget.seconds),
                      session_step=budget.step)
        job.session_info.update({key: value for key, value in result.items() if key.startswith("session_")
                                 and key in job.session_info})
        try:
            await cleanup_profile(job, client, owned)
        except Stop as exc:
            return {**result, **exc.report}
        if attempt == attempts:
            return {**result, "reason": "session_retries_exhausted",
                    "last_reason": result.get("reason"), "browser_profile_id": ""}
        job.progress("bitbrowser_profile_rebuilding")
    raise Stop("session_retries_exhausted")
