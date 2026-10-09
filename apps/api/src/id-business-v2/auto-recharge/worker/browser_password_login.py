"""Log in through the visible official page; never persist password or one-time code."""
from __future__ import annotations

import asyncio
from datetime import datetime
import json
import math
import re
import time
from urllib.parse import urlsplit

from browser_checkout import ORIGIN, browser_read, check_session
from checkout_core import BrowserCredential, Stop, parse_credential
from browser_session import SessionBudget, load_session_page


LOGIN_URL = ORIGIN + "/auth/login"
LOGIN_HOSTS = {"chatgpt.com", "auth.openai.com", "auth0.openai.com"}
EMAIL_INPUT = 'input[type="email"], input[name="username"], input[autocomplete="username"]'
PASSWORD_INPUT = 'input[type="password"], input[autocomplete="current-password"]'
CODE_INPUT = 'input[autocomplete="one-time-code"], input[name="code"], input[name*="otp"]'


def login_code_expiry(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        raise Stop("invalid_login_code")
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if expiry.tzinfo is None or expiry.utcoffset() is None:
            raise ValueError()
        timestamp = expiry.timestamp()
        if not math.isfinite(timestamp):
            raise ValueError()
        return timestamp
    except (ValueError, OverflowError):
        raise Stop("invalid_login_code") from None


def login_code_value(value):
    expiry = None
    if isinstance(value, dict):
        if set(value) != {"code", "expiresAt"}:
            raise Stop("invalid_login_code")
        expiry = login_code_expiry(value["expiresAt"])
        if time.time() >= expiry:
            raise Stop("login_code_expired", user_action_required=True)
        value = value["code"]
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{6,8}", value):
        raise Stop("login_code_required", user_action_required=True)
    return value, expiry


def login_code_current(expiry):
    return expiry is None or time.time() < expiry


def official_login_page(url):
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname in LOGIN_HOSTS
            and parsed.port in {None, 443} and not parsed.username and not parsed.password)


async def login_code_type(page, field):
    """Only an explicit email challenge may query mail; unknown challenges need a person."""
    if not official_login_page(page.url):
        return "unknown"
    path = urlsplit(page.url).path.casefold()
    try:
        form = field.locator("xpath=ancestor::form[1]")
        text = await (form if await form.count() == 1 else page.locator("body")).inner_text(timeout=2000)
    except Exception:
        text = ""
    text = text.casefold()
    if re.search(r"sms|text message|phone number|短信|手机", text):
        return "unknown"
    if (re.search(r"email-verification|email-otp|email-code", path)
            or re.search(r"check your (?:email|inbox)|email verification code|"
                         r"(?:sent|emailed).{0,60}code.{0,60}(?:email|inbox)|"
                         r"code.{0,60}(?:sent|emailed).{0,60}(?:email|inbox)|"
                         r"(?:email|inbox).{0,60}(?:sent|emailed).{0,60}code|"
                         r"邮箱验证码|邮箱.{0,30}(?:已发送|发送了).{0,30}验证码|"
                         r"验证码.{0,30}(?:发送|发至).{0,30}邮箱", text)):
        return "email"
    if (re.search(r"mfa-otp-challenge|authenticator|totp", path)
            or re.search(r"authenticator|authentication app|verification app|验证器|身份验证应用", text)):
        return "totp"
    return "unknown"


def login_payment_write(method, url):
    if method in {"GET", "HEAD", "OPTIONS"}:
        return False
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    return (host in {"stripe.com", "api.stripe.com", "checkout.stripe.com"}
            or host.endswith(".stripe.com")
            or (host == "chatgpt.com" and parsed.path.startswith("/backend-api/payments/")))


async def unique_visible(page, selector):
    matches = page.locator(selector)
    visible = [matches.nth(index) for index in range(await matches.count())
               if await matches.nth(index).is_visible()]
    if len(visible) > 1:
        raise Stop("login_form_ambiguous")
    return visible[0] if visible else None


async def clear_visible_secrets(page):
    if not official_login_page(page.url):
        return
    for selector in (PASSWORD_INPUT, CODE_INPUT):
        try:
            field = await unique_visible(page, selector)
            if field:
                await field.fill("")
        except Exception:
            pass


async def wait_for_input(page, selector, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not official_login_page(page.url):
            raise Stop("unsupported_login_provider", user_action_required=True)
        field = await unique_visible(page, selector)
        if field:
            return field
        await asyncio.sleep(.5)
    return None


async def official_identity(page, expected_email, *, budget=None, strict=False, observe_errors=False):
    if urlsplit(page.url).hostname != "chatgpt.com":
        return None
    try:
        operation = lambda: browser_read(page, "/api/auth/session", budget=budget)
        data = await budget.run(operation, "session_read") if budget else await operation()
        user = data.get("user") if isinstance(data, dict) else None
        email = user.get("email") if isinstance(user, dict) else None
        uid = user.get("id") if isinstance(user, dict) else None
        if not isinstance(email, str) or not isinstance(uid, str) or not uid:
            return None
        if email.casefold() != expected_email.casefold():
            raise Stop("official_login_email_mismatch", account_matched=False)
        credential = parse_credential(json.dumps(data).encode())
        target = BrowserCredential("", credential.account_id, uid)
        _, identity = await check_session(page, target, budget=budget)
        return target, identity
    except Stop as exc:
        if observe_errors and exc.report.get("reason") in {
                "session_network_error", "session_load_timeout", "verification_required",
                "http_error", "operation_cancelled"}:
            raise
        if strict or exc.report.get("reason") in {"official_login_email_mismatch",
                                         "official_user_mismatch", "official_account_mismatch"}:
            raise
        return None


async def login_with_password(page, email, password, wait_for_code, wait_for_user, progress, *,
                              initial_loaded=False, prepare_email_code=None,
                              wait_for_email_code=None, email_code_accepted=None):
    """Submit one password and each explicit code type once; uncertain challenges stay here."""
    submitted_code_types = set()
    email_submitted = False

    async def manual_completion():
        current = await official_identity(page, email)
        if current:
            if email_submitted and email_code_accepted:
                await email_code_accepted()
            return current
        progress("login_email_code_submitted" if email_submitted else "login_manual_required")
        await wait_for_user("verification_required", 1800)
        current = await official_identity(page, email)
        if not current:
            raise Stop("official_login_not_verified", account_matched=False)
        if email_submitted and email_code_accepted:
            await email_code_accepted()
        return current

    budget = SessionBudget(60, report=lambda **details: progress("session_restore", **details))
    if not initial_loaded:
        await load_session_page(page, LOGIN_URL, budget)
    if not official_login_page(page.url):
        return await manual_completion()
    current = await official_identity(page, email)
    if current:
        return current
    progress("login_email")
    try:
        email_field = await wait_for_input(page, EMAIL_INPUT, 20)
    except Stop as exc:
        if exc.report["reason"] not in {"unsupported_login_provider", "login_form_ambiguous"}:
            raise
        return await manual_completion()
    if not email_field:
        return await manual_completion()
    else:
        await email_field.fill(email)
        if prepare_email_code:
            await prepare_email_code()
        if not official_login_page(page.url):
            return await manual_completion()
        await email_field.press("Enter")
        progress("login_password")
        try:
            password_field = await wait_for_input(page, PASSWORD_INPUT, 25)
        except Stop as exc:
            if exc.report["reason"] not in {"unsupported_login_provider", "login_form_ambiguous"}:
                raise
            return await manual_completion()
        if password_field:
            await password_field.fill(password)
            await password_field.press("Enter")

    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if not official_login_page(page.url):
            return await manual_completion()
        current = await official_identity(page, email)
        if current:
            if email_submitted and email_code_accepted:
                await email_code_accepted()
            return current
        try:
            code_field = await unique_visible(page, CODE_INPUT)
        except Stop as exc:
            if exc.report["reason"] != "login_form_ambiguous":
                raise
            return await manual_completion()
        if code_field:
            code_type = await login_code_type(page, code_field)
            if code_type in submitted_code_types:
                # A pending/failed challenge must not consume another code. Only a different,
                # explicitly recognized challenge may continue this same login attempt.
                await asyncio.sleep(.5)
                continue
            try:
                if code_type == "email":
                    if wait_for_email_code:
                        progress("login_email_code_required")
                        received_code = await wait_for_email_code(120)
                    else:
                        # The generic callback supplies TOTP in the BitBrowser flow.
                        # Complete this email challenge in the original official window.
                        return await manual_completion()
                elif code_type == "totp":
                    received_code = await wait_for_code(1800)
                else:
                    return await manual_completion()
                try:
                    code, code_expiry = login_code_value(received_code)
                finally:
                    if isinstance(received_code, dict):
                        received_code.clear()
                    received_code = None
            except Stop as exc:
                if exc.report["reason"] != "login_code_expired":
                    raise
                await clear_visible_secrets(page)
                return await manual_completion()
            code_field = await unique_visible(page, CODE_INPUT)
            if not code_field or await login_code_type(page, code_field) != code_type:
                code = ""
                raise Stop("recharge_email_code_type_changed", user_action_required=True)
            if not login_code_current(code_expiry):
                code = ""
                await clear_visible_secrets(page)
                return await manual_completion()
            try:
                await code_field.fill(code)
                try:
                    submitted_field = await unique_visible(page, CODE_INPUT)
                    ready = (submitted_field is not None
                             and await submitted_field.input_value() == code
                             and await login_code_type(page, submitted_field) == code_type
                             and login_code_current(code_expiry))
                except Stop as exc:
                    if exc.report["reason"] != "login_form_ambiguous":
                        raise
                    ready = False
                except Exception:
                    ready = False
                if not ready:
                    code = ""
                    await clear_visible_secrets(page)
                    return await manual_completion()
                await submitted_field.press("Enter")
            finally:
                code = ""
            submitted_code_types.add(code_type)
            email_submitted = email_submitted or code_type == "email"
            progress("login_email_code_submitted" if email_submitted else "login_code_submitted")
            deadline = time.monotonic() + 45
        await asyncio.sleep(.5)

    return await manual_completion()
