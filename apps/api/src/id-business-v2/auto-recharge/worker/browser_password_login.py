"""Log in through the visible official page; never persist password or one-time code."""
from __future__ import annotations

import asyncio
import json
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
    if (re.search(r"mfa-otp-challenge|authenticator|totp", path)
            or re.search(r"authenticator|authentication app|verification app|验证器|身份验证应用", text)):
        return "totp"
    if (re.search(r"email-verification|email-otp|email-code", path)
            or re.search(r"check your (?:email|inbox)|email verification code|"
                         r"(?:sent|emailed).{0,60}code.{0,60}(?:email|inbox)|"
                         r"code.{0,60}(?:sent|emailed).{0,60}(?:email|inbox)|"
                         r"(?:email|inbox).{0,60}(?:sent|emailed).{0,60}code|"
                         r"邮箱验证码|邮箱.{0,30}(?:已发送|发送了).{0,30}验证码|"
                         r"验证码.{0,30}(?:发送|发至).{0,30}邮箱", text)):
        return "email"
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


async def official_identity(page, expected_email, *, budget=None, strict=False):
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
            if code_type == "email":
                if wait_for_email_code:
                    progress("login_email_code_required")
                    code = await wait_for_email_code(120)
                else:
                    code = await wait_for_code(1800)
            elif code_type == "totp":
                code = await wait_for_code(1800)
            else:
                return await manual_completion()
            code_field = await unique_visible(page, CODE_INPUT)
            if not code_field or await login_code_type(page, code_field) != code_type:
                code = ""
                raise Stop("recharge_email_code_type_changed", user_action_required=True)
            if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6,8}", code):
                code = ""
                raise Stop("login_code_required", user_action_required=True)
            try:
                await code_field.fill(code)
                await code_field.press("Enter")
            finally:
                code = ""
            submitted_code_types.add(code_type)
            email_submitted = email_submitted or code_type == "email"
            progress("login_email_code_submitted" if email_submitted else "login_code_submitted")
            deadline = time.monotonic() + 45
        await asyncio.sleep(.5)

    return await manual_completion()
