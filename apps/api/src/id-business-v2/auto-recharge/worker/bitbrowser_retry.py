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
    # Ending automation leaves the owned window and its manual controls available.
    if job.cancelled:
        result.update(status="cancelled", cancellation_confirmed=True, reason="operation_cancelled")
    result["browser_cleanup_status"] = "not_needed"
    if "browser_profile_id" not in result:
        result["browser_profile_id"] = job.profile_id or ""
    result.update(job.profile_rebuild_info)
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
    language = options.get("language", "zh-CN")
    await job.context.set_extra_http_headers({"Accept-Language": language + "," + language.split("-")[0] + ";q=0.9"})
    return browser


def proxy_reopen_allowed(job, target, result, options, owned):
    """Rotate only a proven transport failure before any payment capability is used."""
    source = job.owned_profile
    profile_owned = job.profile_id in owned or (source is not None
                                               and source["profileId"] == job.profile_id)
    if (not profile_owned or options["proxyMode"] != "dynamic"
            or options["sessionRetryLimit"] == 0
            or job.payload["mode"] not in {"payment", "open_browser"}
            or job.waiting_for_user or job.payment_request_sent or job.confirmation_consumed
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


def historical_payment_completed(record):
    """Past, fully bound success can precede a new login without reusing payment."""
    from plans import PLANS, subscription_match
    target_plan = record.get("target_plan", "plus")
    if (target_plan not in PLANS or record.get("payment_status") != "paid"
            or record.get("status") != "subscription_activated"
            or record.get("subscription_status") != target_plan
            or record.get("payment_attempted") is not True
            or type(record.get("confirmation_requests_sent")) is not int
            or record["confirmation_requests_sent"] != 1
            or subscription_match(target_plan, record.get("current_plan"), record.get("current_tier")) != "matched"
            or not record.get("payment_evidence")):
        return False
    try:
        if record.get("operation") == "subscription_upgrade":
            subscription_upgrade.validate_upgrade_record(record, record["account_key"], target_plan)
        else:
            checkout_id = record.get("checkout_identifier")
            if (not isinstance(checkout_id, str)
                    or not re.fullmatch(r"(?:cs|oaics)_[A-Za-z0-9_]{1,200}", checkout_id)
                    or record.get("quote", {}).get("plan") != target_plan
                    or payment_state.quote_digest(record["quote"]) != record.get("quote_digest")):
                return False
            payment_state.validate_evidence(record["payment_evidence"], checkout_id, record["quote"])
    except (Stop, KeyError, TypeError, AttributeError, ValueError):
        return False
    return True


def missing_profile_rebuild_allowed(job, target):
    """A missing browser does not invalidate payment or identity guards."""
    source = job.owned_profile
    if (not isinstance(source, dict) or set(source) != {"sourceJobId", "profileId", "accountKey"}
            or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
                                str(source.get("sourceJobId", "")))
            or source["sourceJobId"] == job.id
            or not re.fullmatch(r"[a-fA-F0-9]{32}", str(source.get("profileId", "")))
            or not re.fullmatch(r"[a-f0-9]{64}", str(source.get("accountKey", "")))
            or job.payload["mode"] not in {"payment", "open_browser"}
            or job.replaced_owned_profile is not None or job.payment_request_sent
            or job.confirmation_consumed or job.pending_confirmation is not None
            or job.waiting_for_user or job.waiting_for_code
            or job.result.get("status") in {"awaiting_human_verification", "awaiting_confirmation"}
            or job.result.get("payment_attempted") is True
            or job.result.get("payment_requests_sent", 0) != 0
            or job.result.get("confirmation_requests_sent", 0) != 0
            or job.result.get("payment_status") in {"paid", "unknown", "requires_action"}):
        return False
    if target is not None and hashlib.sha256(target.account_id.encode()).hexdigest() != source["accountKey"]:
        raise Stop("official_account_mismatch", account_matched=False)
    # JSON has already restored its authoritative records. Password credentials
    # restore only after login; its creation callback independently checks the
    # launch account/source against the API's durable state before browser open.
    from pathlib import Path
    from checkout_core import unique_object
    import json
    root = Path(job.root)
    for path in (*root.glob("*.json"), *(root / "payments").glob("*.json")):
        if path.is_symlink() or path.stat().st_size > 65536:
            raise Stop("invalid_payment_record")
        try:
            record = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
        except (ValueError, TypeError):
            raise Stop("invalid_payment_record") from None
        if not isinstance(record, dict):
            raise Stop("invalid_payment_record")
        bound_original = (
            job.original_checkout_identifier is not None
            and record.get("checkout_identifier") == job.original_checkout_identifier
            or job.payload.get("upgradeIdentifier") is not None
            and record.get("upgrade_identifier") == job.payload["upgradeIdentifier"])
        if (record.get("account_key") == source["accountKey"] and not bound_original
                and historical_payment_completed(record)):
            continue
        if record.get("account_key") == source["accountKey"] and (
                record.get("payment_attempted") is True
                or record.get("confirmation_requests_sent", 0) not in (None, 0)
                or record.get("payment_status") in {"paid", "unknown", "requires_action"}):
            return False
    return True


async def rebuild_missing_owned_profile(job, client, bit, preparation, owned, target):
    if not missing_profile_rebuild_allowed(job, target):
        raise Stop("owned_recharge_window_unavailable", user_action_required=True)
    source = dict(job.owned_profile)
    profile_id = await preparation.run(lambda: asyncio.to_thread(
        client.create_profile, bit, job.payload["windowName"].strip()), "profile_create")
    if (not isinstance(profile_id, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", profile_id)
            or profile_id == source["profileId"]):
        raise Stop("bitbrowser_profile_unverified")
    owned.add(profile_id)
    job.profile_id = profile_id
    job.replaced_owned_profile = source
    job.owned_profile = None
    job.profile_rebuild_info = {
        "replaced_browser_profile_id": source["profileId"],
        "browser_profile_missing_confirmed": True,
    }
    # A rejected/lost receipt stops the job before opening the profile, restoring
    # cookies or password login. The API records the new binding atomically.
    job.progress("bitbrowser_profile_created", payment_attempted=False, payment_requests_sent=0)
    return profile_id


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
                # Only the complete bounded inventory proves absence. API or
                # pagination errors never authorize a replacement window.
                available = await preparation.run(lambda: asyncio.to_thread(
                    client.list_profile_ids), "profile_inventory")
                if not isinstance(available, set):
                    raise Stop("owned_recharge_window_unavailable", user_action_required=True)
                if job.profile_id not in available:
                    await rebuild_missing_owned_profile(job, client, bit, preparation, owned, target)
                else:
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
        from urllib.parse import urlsplit
        page = next((p for p in job.context.pages if p.url == "about:blank" or
                     urlsplit(p.url).hostname == "chatgpt.com"), None)
        page = page or await job.context.new_page()
        page.set_default_timeout(20000)
        login = job.payload.pop("login")
        async def wait_for_login_code(seconds):
            return await budget.human_wait(lambda: job.wait_for_code(seconds))
        async def wait_for_login_user(reason, seconds):
            return await budget.human_wait(lambda: job.wait_for_user(reason, seconds))
        try:
            target, identity = await browser_password_login.login_with_password(
                page, login["email"], login["password"], wait_for_login_code,
                wait_for_login_user, job.progress)
        finally:
            await browser_password_login.clear_visible_secrets(page)
            login.clear()
        job.check_cancelled()
        replaced = job.replaced_owned_profile
        if replaced is not None and hashlib.sha256(target.account_id.encode()).hexdigest() != replaced["accountKey"]:
            raise Stop("official_account_mismatch", account_matched=False)
        job.restore_account(target)
        if replaced is not None and job.owned_profile != {
                **replaced, "profileId": job.profile_id}:
            raise Stop("owned_recharge_profile_conflict", user_action_required=True)
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
        from browser_checkout import (check_session, install_session_cookies,
                                      restore_session_with_refresh, synchronize_login_page)
        from urllib.parse import urlsplit
        if target.session_token:
            await install_session_cookies(job.context, target, budget=budget)
        job.progress("session_restore")
        page = next((p for p in job.context.pages if p.url == "about:blank" or
                     (urlsplit(p.url).hostname == "chatgpt.com"
                      and (urlsplit(p.url).path in ("", "/")
                           or urlsplit(p.url).path.startswith("/checkout/")))), None)
        page = page or await job.context.new_page()
        page.set_default_timeout(20000)
        if not target.session_token and urlsplit(page.url).hostname == "chatgpt.com":
            _, identity = await check_session(page, target, wait_seconds=1800, budget=budget)
        else:
            _, identity = await restore_session_with_refresh(page, target, wait_seconds=1800, budget=budget)
        _, identity = await synchronize_login_page(page, target, identity, budget=budget)
        job.progress("session_ready", **identity)
        return target, {"status": "session_ready", "stage": "session_ready", "account_matched": True,
                        "browser_profile_id": job.profile_id,
                        "current_plan": identity.get("current_plan", "unknown"),
                        "payment_attempted": False, "payment_requests_sent": 0,
                        "checkout_requests_sent": 0, **identity}
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
