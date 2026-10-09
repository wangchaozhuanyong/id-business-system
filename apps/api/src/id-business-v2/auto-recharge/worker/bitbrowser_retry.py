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
from browser_session import SessionBudget, RETRYABLE_NETWORK_CODES, session_failure
from checkout_core import Stop


async def close_profile_id(job, client, profile_id, *, cancelling=False):
    if not re.fullmatch(r"[a-fA-F0-9]{32}", profile_id or ""):
        raise Stop("bitbrowser_cleanup_unverified")
    previous_deadline = getattr(client, "deadline", None)
    deadline = time.monotonic() + 15
    if not cancelling and isinstance(previous_deadline, (int, float)):
        deadline = min(deadline, previous_deadline)
    client.deadline = deadline
    try:
        await asyncio.to_thread(client.post, "/browser/close", {"id": profile_id})
        while True:
            if not cancelling:
                job.check_cancelled()
            if time.monotonic() >= deadline:
                raise Stop("bitbrowser_cleanup_unverified")
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
    except Stop as exc:
        if exc.report.get("reason") == "operation_cancelled":
            raise
        raise Stop("bitbrowser_cleanup_unverified", browser_profile_id=profile_id) from None
    finally:
        client.deadline = previous_deadline


async def cleanup_profile_id(job, client, profile_id, *, cancelling=False):
    await close_profile_id(job, client, profile_id, cancelling=cancelling)
    try:
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
            if job.profile_id and (job.profile_id in owned or job.owned_profile is not None
                                   and job.owned_profile["profileId"] == job.profile_id):
                await close_profile_id(job, client, job.profile_id, cancelling=True)
                job.context = None
                # Existing callbacks use "completed" to mean profile deletion.
                # A confirmed close keeps the profile available for manual reuse.
                cleanup = "not_needed"
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
    kwargs.setdefault("allow_checkout_replacement", False)
    expected_checkout = kwargs.pop("expected_checkout_identifier", None)
    flow = pay.run_checkout_flow if expected_checkout else pay.run_flow
    if expected_checkout:
        kwargs["expected_checkout_identifier"] = expected_checkout
    task = asyncio.create_task(flow(target, job.root, job.payload["plan"], **kwargs))
    try:
        while not task.done():
            job.check_cancelled()
            budget = kwargs.get("session_budget")
            parent = budget.parent if budget else None
            # The preparation deadline ends at the explicit human confirmation.
            # A sent payment must never be interrupted by a proxy-recovery timer.
            if (parent and not job.waiting_for_user and job.pending_confirmation is None
                    and not job.confirmation_consumed and not job.payment_request_sent):
                parent.remaining_ms()
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


async def attach_profile(job, client, playwright, profile_id, options, *, extract_ip=False):
    job.profile_id = profile_id
    endpoint = await asyncio.to_thread(client.open_profile, profile_id, **(
        {"extract_ip": True} if extract_ip else {}))
    job.check_cancelled()
    browser = await playwright.chromium.connect_over_cdp(endpoint)
    job.check_cancelled()
    bitbrowser_options.verify_runtime_version(getattr(browser, "version", None), options["coreVersion"])
    if not browser.contexts:
        raise Stop("bitbrowser_context_missing")
    job.context = browser.contexts[0]
    return browser


def proxy_reopen_allowed(job, target, result, options, owned):
    """Rotate only a proven transport failure before any payment capability is used."""
    source = job.owned_profile
    profile_owned = job.profile_id in owned or (source is not None
                                               and source["profileId"] == job.profile_id)
    if (not profile_owned or options["proxyMode"] != "dynamic"
            or options["sessionRetryLimit"] == 0
            or job.payload["mode"] not in {"payment", "open_browser"}
            or job.payment_request_sent or job.confirmation_consumed
            or result.get("payment_attempted") is True
            or result.get("payment_requests_sent", 0) != 0
            or result.get("confirmation_requests_sent", 0) != 0
            or result.get("http_status") is not None or result.get("user_action_required")
            or result.get("reason") in {"official_user_mismatch", "official_account_mismatch",
                                       "access_token_expired", "json_session_not_restored",
                                       "login_page_not_ready", "verification_required"}):
        return False
    if result.get("reason") not in {
            "session_network_error", "session_load_timeout", "browser_operation_failed",
            "checkout_page_load_timeout", "checkout_page_network_error", "actual_quote_unknown",
            "payment_quote_not_ready", "official_plan_menu_timeout", "proxy_country_mismatch",
            "proxy_network_error", "proxy_network_unconfirmed", "proxy_prepare_timeout"}:
        return False
    if target is None and "login" not in job.payload:
        return False
    checkout_count = result.get("checkout_requests_sent", 0)
    checkout_id = result.get("checkout_identifier")
    if checkout_count not in (0, 1) or checkout_count == 1 and not checkout_id:
        return False
    explicit_network = result.get("browser_error_code") in RETRYABLE_NETWORK_CODES
    transport_timeout = (
        result.get("reason") in {"session_load_timeout", "checkout_page_load_timeout"}
        and result.get("session_step") in {"page_load", "page_refresh"}
        or result.get("reason") == "proxy_prepare_timeout"
        and result.get("session_step") in {"account_read", "proxy_prepare", "proxy_probe", "proxy_home"})
    return bool(explicit_network or transport_timeout
                or result.get("reason") in {"proxy_network_error", "proxy_country_mismatch"})


async def reuse_owned_profile(job, client, playwright, target, options, expected_email=None, *,
                              attached=False, budget=None):
    """An API-proven recharge profile is still untrusted until its live identity matches.

    Never inject JSON cookies before this check: the user may have switched the
    window to another account since the previous successful payment.
    """
    from checkout_core import BrowserCredential
    from browser_checkout import browser_read, check_session
    from checkout_core import parse_credential
    import json
    from urllib.parse import urlsplit
    owned_profile = dict(job.owned_profile)
    profile_id = owned_profile["profileId"]
    job.profile_id = profile_id
    detail = await asyncio.to_thread(client.post, "/browser/detail", {"id": profile_id})
    if not isinstance(detail, dict) or detail.get("id") != profile_id:
        raise Stop("owned_recharge_window_unavailable", user_action_required=True)
    if not attached:
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
            operation = lambda: page.goto("https://chatgpt.com/", wait_until="commit", timeout=20000)
            await budget.run(operation, "page_load") if budget else await operation()
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
        else:
            # Inspect identity before session errors: an errored token may still
            # belong to a different user and must never be overwritten with JSON.
            current = await browser_read(page, "/api/auth/session", budget=budget)
            if not isinstance(current, dict):
                raise Stop("owned_recharge_window_login_required", user_action_required=True)
            user = current.get("user")
            uid = user.get("id") if isinstance(user, dict) else None
            if uid and uid != target.user_id:
                raise Stop("official_user_mismatch", account_matched=False)
            account = current.get("account")
            if isinstance(account, dict) and account.get("id") and account["id"] != target.account_id:
                raise Stop("official_account_mismatch", account_matched=False)
            if current.get("accessToken") or current.get("access_token"):
                observed = parse_credential(json.dumps(current).encode(), allow_expired=True)
                if observed.account_id != target.account_id:
                    raise Stop("official_account_mismatch", account_matched=False)
            if hashlib.sha256(target.account_id.encode()).hexdigest() != owned_profile["accountKey"]:
                raise Stop("official_account_mismatch", account_matched=False)
            anonymous = (current.get("error") is None and user is None
                         and not current.get("accessToken") and not current.get("access_token")
                         and current.get("account") is None)
            if anonymous and getattr(target, "session_token", None):
                # Only an explicit anonymous response authorizes restoring this
                # account's freshly supplied JSON. Injection happens under the
                # ordinary workflow guard, never in the identity probe.
                return target
            if not uid:
                raise Stop("owned_recharge_window_login_required", user_action_required=True)
        refreshed, identity = (await check_session(page, target, budget=budget)
                               if budget else await check_session(page, target))
        if identity.get("account_matched") is not True or hashlib.sha256(target.account_id.encode()).hexdigest() != job.account_key:
            raise Stop("official_account_mismatch", account_matched=False)
    except Stop as exc:
        if exc.report.get("reason") in {"official_user_mismatch", "official_account_mismatch", "official_login_email_mismatch",
                                      "owned_recharge_window_unverified", "durable_state_unavailable",
                                      "invalid_owned_recharge_profile"}:
            raise
        if (exc.report.get("browser_error_code") in RETRYABLE_NETWORK_CODES
                or exc.report.get("reason") in {"session_network_error", "session_load_timeout",
                                                "verification_required", "http_error", "operation_cancelled"}):
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
    from pathlib import Path
    from attempt_ledger import assert_no_other_payment
    from browser_checkout import prepare_proxy_in_context
    bit = job.payload["bitBrowser"]
    options = bitbrowser_options.validate_options(bit.get("browserOptions"))
    attempts = (options["sessionRetryLimit"] + 1 if options["proxyMode"] == "dynamic"
                and job.payload["mode"] in {"payment", "open_browser"} else 1)
    preparation = SessionBudget(600, cancelled=lambda: job.cancelled)
    original_checkout = job.original_checkout_identifier
    previous = None
    if job.owned_profile is not None:
        job.profile_id = job.owned_profile["profileId"]
    for attempt in range(1, attempts + 1):
        job.check_cancelled()
        try:
            preparation.remaining_ms()
        except Stop:
            return {**(previous or {}), "status": "blocked", "reason": "proxy_recovery_timeout",
                    "browser_profile_id": job.profile_id or "", **job.session_info}
        client.deadline = time.monotonic() + preparation.remaining_ms() / 1000
        job.session_info = {"session_attempt": attempt, "session_attempt_limit": attempts,
                            "session_elapsed_seconds": 0,
                            "session_wait_seconds": options["sessionWaitMinutes"] * 60,
                            "session_step": "page_load", "session_refresh_count": 0}
        budget = SessionBudget(options["sessionWaitMinutes"] * 60,
                               cancelled=preparation.cancelled, parent=preparation,
                               report=lambda **details: job.progress("session_restore", **details))
        try:
            if job.payload["mode"] == "payment" and target is not None:
                # Recheck durable evidence before every reopen as well: a marker
                # can reach disk before an interrupted payment callback does.
                assert_no_other_payment(Path(job.root), target.account_id)
            if attempt > 1:
                job.progress("proxy_retrying", last_reason=previous.get("reason"))
                await preparation.run(lambda: close_profile_id(job, client, job.profile_id), "profile_close")
                job.context = None
                job.check_cancelled()
                await preparation.run(lambda: asyncio.sleep(min(10, 2 ** (attempt - 1))), "proxy_backoff")
                await preparation.run(lambda: attach_profile(
                    job, client, playwright, job.profile_id, options, extract_ip=True), "profile_open")
            elif job.owned_profile is not None:
                job.profile_id = job.owned_profile["profileId"]
                # Validate existence before open; a deleted bound profile is an
                # explicit error rather than permission to create a replacement.
                detail = await preparation.run(lambda: asyncio.to_thread(
                    client.post, "/browser/detail", {"id": job.profile_id}), "profile_detail")
                if not isinstance(detail, dict) or detail.get("id") != job.profile_id:
                    raise Stop("owned_recharge_window_unavailable", user_action_required=True)
                await preparation.run(lambda: attach_profile(
                    job, client, playwright, job.profile_id, options), "profile_open")
            else:
                job.progress("bitbrowser_group")
                profile_id = await preparation.run(lambda: asyncio.to_thread(
                    client.create_profile, bit, job.payload["windowName"].strip()), "profile_create")
                owned.add(profile_id)
                job.profile_id = profile_id
                job.progress("bitbrowser_profile_created")
                await preparation.run(lambda: attach_profile(
                    job, client, playwright, profile_id, options), "profile_open")
                job.progress("bitbrowser_profile_opened")
            if job.payload["mode"] != "recheck" and not job.payment_request_sent and not job.confirmation_consumed:
                probe = SessionBudget(20, cancelled=preparation.cancelled, parent=preparation,
                                      report=lambda **details: job.progress("proxy_preparing", **details))
                await prepare_proxy_in_context(job.context, bit.get("expectedCountryCode"), budget=probe)
            if job.owned_profile is not None:
                login = job.payload.get("login")
                target = await preparation.run(lambda: reuse_owned_profile(
                    job, client, playwright, target, options,
                    login["email"] if target is None and login else None,
                    attached=True, budget=budget), "owned_identity")
                if login:
                    job.payload.pop("login", None)
                    login.clear()
            target, result = await _execute_profile_flow(job, target, budget, original_checkout)
        except Stop as exc:
            if exc.report.get("reason") == "operation_cancelled":
                raise
            result = {"status": "blocked", "stage": "session_restore", "account_matched": False,
                      "checkout_requests_sent": 0, "payment_requests_sent": 0,
                      **(previous or {}), **exc.report}
        except Exception as exc:
            result = {"stage": "session_restore", "account_matched": False,
                      "checkout_requests_sent": 0, "payment_requests_sent": 0,
                      **(previous or {}), **session_failure(exc)}
        result = {**job.session_info, **result, "session_attempt": attempt,
                  "session_attempt_limit": attempts, "browser_profile_id": job.profile_id or ""}
        if (previous and previous.get("checkout_requests_sent") == 1
                and result.get("checkout_requests_sent") == 0):
            result["checkout_requests_sent"] = 1
        checkout_id = result.get("checkout_identifier")
        if checkout_id:
            if original_checkout is not None and checkout_id != original_checkout:
                return {**result, "status": "blocked", "reason": "checkout_identifier_changed"}
            original_checkout = checkout_id
        if not proxy_reopen_allowed(job, target, result, options, owned):
            return result
        if attempt == attempts:
            return {**result, "reason": "proxy_retry_exhausted", "last_reason": result.get("reason")}
        previous = result
        # No pending human capability can survive a change of proxy/context.
        with job.confirmation_lock:
            if job.confirmation_consumed or job.payment_request_sent:
                return result
            job.pending_confirmation = None
            job.confirmation_approved = None
            job.confirmation_event.clear()
            for key in ("quote", "quote_digest", "confirmation_expires_at", "nonce"):
                job.result.pop(key, None)
    raise Stop("proxy_retry_exhausted")


async def _execute_profile_flow(job, target, budget, original_checkout=None):
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
        if job.owned_profile is not None and job.owned_profile["profileId"] != job.profile_id:
            raise Stop("owned_recharge_profile_conflict", user_action_required=True)
        job.progress("login_verified", account_matched=True, current_plan=identity["current_plan"])
    if job.payload["mode"] == "recheck":
        if job.payload.get("upgradeIdentifier"):
            return target, await subscription_upgrade.recheck_upgrade_in_context(
                job.context, target, job.root, job.payload["plan"], job.payload["upgradeIdentifier"])
        with payment_state.PaymentLedger(job.root, target.account_id,
                                         target_plan=job.payload["plan"]) as ledger:
            result = await payment_recovery.recheck_in_context(
                job.context, target, ledger, timeout=25, poll_count=6, poll_interval=20)
            return target, pay.include_payment_record(result, ledger)
    if job.payload["mode"] == "open_browser":
        from browser_checkout import (NetworkGuard, install_session_cookies,
                                      restore_session_with_refresh, synchronize_login_page)
        from urllib.parse import urlsplit
        guard = NetworkGuard(target)
        await job.context.route("**/*", guard.route)
        await job.context.route_web_socket("**/*", lambda ws: ws.close())
        try:
            if target.session_token:
                await install_session_cookies(job.context, target, budget=budget)
            job.progress("session_restore")
            page = next((p for p in job.context.pages if p.url == "about:blank" or
                         (urlsplit(p.url).hostname == "chatgpt.com"
                          and (urlsplit(p.url).path in ("", "/")
                               or urlsplit(p.url).path.startswith("/checkout/")))), None)
            page = page or await job.context.new_page()
            page.set_default_timeout(20000)
            _, identity = await restore_session_with_refresh(page, target, wait_seconds=1800, budget=budget)
            _, identity = await synchronize_login_page(page, target, identity, budget=budget)
            job.progress("session_ready", **identity)
            return target, {"status": "session_ready", "stage": "session_ready", "account_matched": True,
                            "browser_profile_id": job.profile_id,
                            "current_plan": identity.get("current_plan", "unknown"),
                            "payment_attempted": False, "payment_requests_sent": 0,
                            "checkout_requests_sent": 0, **identity}
        finally:
            await job.context.unroute("**/*", guard.route)
    restored_checkout = job.original_checkout_identifier
    if original_checkout and restored_checkout and original_checkout != restored_checkout:
        raise Stop("checkout_identifier_changed")
    original_checkout = original_checkout or restored_checkout
    result = await cancellable_flow(
        job, target, details_reader=job.details, confirmer=job.confirm,
        wait_seconds=1800, poll_count=6, poll_interval=20,
        browser_context=job.context, session_budget=budget,
        expected_country=job.payload["bitBrowser"].get("expectedCountryCode"),
        allow_checkout_replacement=False,
        **({"expected_checkout_identifier": original_checkout} if original_checkout else {}))
    return target, result
