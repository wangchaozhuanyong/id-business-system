"""Retry read-only and pre-payment failures in windows explicitly owned by the job."""
import asyncio
import hashlib
import re
import time

import bitbrowser_options
import browser_password_login
import pay
import payment_recovery
import payment_state
import subscription_upgrade
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
    if target is not None:
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
            if job.profile_id and job.profile_id in owned:
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


async def attach_profile(job, client, playwright, profile_id, options):
    job.profile_id = profile_id
    endpoint = await asyncio.to_thread(client.open_profile, profile_id)
    browser = await playwright.chromium.connect_over_cdp(endpoint)
    bitbrowser_options.verify_runtime_version(getattr(browser, "version", None), options["coreVersion"])
    if not browser.contexts:
        raise Stop("bitbrowser_context_missing")
    job.context = browser.contexts[0]
    return browser


async def reuse_owned_profile(job, client, playwright, target, options, expected_email=None):
    """An API-proven recharge profile is still untrusted until its live identity matches.

    Never inject JSON cookies before this check: the user may have switched the
    window to another account since the previous successful payment.
    """
    from checkout_core import BrowserCredential
    from browser_checkout import check_session
    from urllib.parse import urlsplit
    owned_profile = dict(job.owned_profile)
    profile_id = owned_profile["profileId"]
    detail = await asyncio.to_thread(client.post, "/browser/detail", {"id": profile_id})
    if not isinstance(detail, dict) or detail.get("id") != profile_id:
        raise Stop("owned_recharge_window_unavailable", user_action_required=True)
    await attach_profile(job, client, playwright, profile_id, options)
    async def read_guard(route):
        request = route.request
        if browser_password_login.login_payment_write(request.method, request.url):
            await route.abort("blockedbyclient")
        else:
            await route.fallback()
    await job.context.route("**/*", read_guard)
    page = next((p for p in job.context.pages if urlsplit(p.url).hostname == "chatgpt.com"), None)
    page = page or await job.context.new_page()
    page.set_default_timeout(20000)
    try:
        if urlsplit(page.url).hostname != "chatgpt.com":
            await page.goto("https://chatgpt.com/", wait_until="domcontentloaded", timeout=20000)
        # check_session only reads the existing session/account; it does not add cookies.
        if target is None:
            observed = await browser_password_login.official_identity(page, expected_email, strict=True)
            if observed is None:
                raise Stop("owned_recharge_window_login_required", user_action_required=True)
            target, identity = observed
            if hashlib.sha256(target.account_id.encode()).hexdigest() != owned_profile["accountKey"]:
                raise Stop("official_account_mismatch", account_matched=False)
            # The launch profile is only a hint until the current API job's
            # authoritative restore confirms this exact owner/account/source.
            job.restore_account(target)
            if job.owned_profile != owned_profile:
                raise Stop("owned_recharge_window_unverified", account_matched=False)
        refreshed, identity = await check_session(page, target)
        if identity.get("account_matched") is not True or hashlib.sha256(target.account_id.encode()).hexdigest() != job.account_key:
            raise Stop("official_account_mismatch", account_matched=False)
    except Stop as exc:
        if exc.report.get("reason") in {"official_user_mismatch", "official_account_mismatch", "official_login_email_mismatch",
                                      "owned_recharge_window_unverified", "durable_state_unavailable",
                                      "invalid_owned_recharge_profile"}:
            raise
        raise Stop("owned_recharge_window_login_required", user_action_required=True,
                   browser_profile_id=profile_id) from None
    finally:
        await job.context.unroute("**/*", read_guard)
    job.progress("owned_recharge_window_verified", account_matched=True,
                 current_plan=identity["current_plan"], browser_profile_reused=True)
    # Preserve the verified live session; never replace it with the older JSON cookie.
    return BrowserCredential("", target.account_id, target.user_id, refreshed.token)


async def _execute_profiles(job, client, target, playwright, owned):
    bit = job.payload["bitBrowser"]
    options = bitbrowser_options.validate_options(bit.get("browserOptions"))
    attempts = (options["sessionRetryLimit"] + 1 if job.payload["mode"] == "payment"
                and target is not None and job.owned_profile is None else 1)
    for attempt in range(1, attempts + 1):
        job.check_cancelled()
        job.session_info = {"session_attempt": attempt, "session_attempt_limit": attempts,
                            "session_elapsed_seconds": 0,
                            "session_wait_seconds": options["sessionWaitMinutes"] * 60,
                            "session_step": "page_load", "session_refresh_count": 0}
        job.initial_session_verified = False
        if job.owned_profile is not None:
            if target is None:
                login = job.payload.pop("login")
                try:
                    target = await reuse_owned_profile(job, client, playwright, None, options, login["email"])
                finally:
                    login.clear()
                await cleanup_stale_profiles(job, client)
            else:
                target = await reuse_owned_profile(job, client, playwright, target, options)
            profile_id = job.profile_id
        else:
            job.progress("bitbrowser_group")
            profile_id = await asyncio.to_thread(client.create_profile, bit, job.payload["windowName"].strip())
            owned.add(profile_id)
            job.profile_id = profile_id
            job.progress("bitbrowser_profile_created")
            await attach_profile(job, client, playwright, profile_id, options)
            job.progress("bitbrowser_profile_opened")
        job.check_cancelled()
        if target is None:
            async def login_guard(route):
                request = route.request
                if browser_password_login.login_payment_write(request.method, request.url):
                    await route.abort("blockedbyclient")
                else:
                    await route.fallback()

            await job.context.route("**/*", login_guard)
            from urllib.parse import urlsplit
            page = next((p for p in job.context.pages if p.url == "about:blank" or
                         urlsplit(p.url).hostname == "chatgpt.com"), None)
            page = page or await job.context.new_page()
            page.set_default_timeout(20000)
            login = job.payload.pop("login")
            try:
                target, identity = await browser_password_login.login_with_password(
                    page, login["email"], login["password"], job.wait_for_code,
                    job.wait_for_user, job.progress)
            finally:
                await browser_password_login.clear_visible_secrets(page)
                login.clear()
                await job.context.unroute("**/*", login_guard)
            job.check_cancelled()
            job.restore_account(target)
            await cleanup_stale_profiles(job, client)
            if job.owned_profile is not None:
                await cleanup_profile(job, client, owned)
                target = await reuse_owned_profile(job, client, playwright, target, options)
                profile_id = job.profile_id
                attempts = attempt
            job.progress("login_verified", account_matched=True,
                         current_plan=identity["current_plan"])
        if job.payload["mode"] == "recheck":
            if job.payload.get("upgradeIdentifier"):
                return await subscription_upgrade.recheck_upgrade_in_context(
                    job.context, target, job.root, job.payload["plan"], job.payload["upgradeIdentifier"])
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
            if target.session_token:
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
        if job.owned_profile is not None or not retryable_session_result(result):
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
