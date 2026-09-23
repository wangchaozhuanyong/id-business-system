"""Log in through the visible official page; never persist password or one-time code."""
from __future__ import annotations

import asyncio
import json
import re
import time
from urllib.parse import urlsplit

from browser_checkout import ORIGIN, browser_read, check_session
from checkout_core import BrowserCredential, Stop, parse_credential


LOGIN_URL = ORIGIN + "/auth/login"
LOGIN_HOSTS = {"chatgpt.com", "auth.openai.com", "auth0.openai.com"}
EMAIL_INPUT = 'input[type="email"], input[name="username"], input[autocomplete="username"]'
PASSWORD_INPUT = 'input[type="password"], input[autocomplete="current-password"]'
CODE_INPUT = 'input[autocomplete="one-time-code"], input[name="code"], input[name*="otp"]'


def official_login_page(url):
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in LOGIN_HOSTS


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


async def official_identity(page, expected_email):
    if urlsplit(page.url).hostname != "chatgpt.com":
        return None
    try:
        data = await browser_read(page, "/api/auth/session")
        user = data.get("user") if isinstance(data, dict) else None
        email = user.get("email") if isinstance(user, dict) else None
        uid = user.get("id") if isinstance(user, dict) else None
        if not isinstance(email, str) or not isinstance(uid, str) or not uid:
            return None
        if email.casefold() != expected_email.casefold():
            raise Stop("official_login_email_mismatch", account_matched=False)
        credential = parse_credential(json.dumps(data).encode())
        target = BrowserCredential("", credential.account_id, uid)
        _, identity = await check_session(page, target)
        return target, identity
    except Stop as exc:
        if exc.report.get("reason") in {"official_login_email_mismatch",
                                         "official_user_mismatch", "official_account_mismatch"}:
            raise
        return None


async def login_with_password(page, email, password, wait_for_code, wait_for_user, progress):
    """Submit one password and at most one code; uncertain challenges stay in this window."""
    async def manual_completion():
        progress("login_manual_required")
        await wait_for_user("verification_required", 1800)
        current = await official_identity(page, email)
        if not current:
            raise Stop("official_login_not_verified", account_matched=False)
        return current

    await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=45000)
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
        await email_field.press("Enter")
        progress("login_password")
        try:
            password_field = await wait_for_input(page, PASSWORD_INPUT, 25)
        except Stop as exc:
            if exc.report["reason"] not in {"unsupported_login_provider", "login_form_ambiguous"}:
                raise
            return await manual_completion()
        if not password_field:
            return await manual_completion()
        else:
            await password_field.fill(password)
            await password_field.press("Enter")

    deadline = time.monotonic() + 45
    code_submitted = False
    while time.monotonic() < deadline:
        if not official_login_page(page.url):
            return await manual_completion()
        current = await official_identity(page, email)
        if current:
            return current
        try:
            code_field = await unique_visible(page, CODE_INPUT)
        except Stop as exc:
            if exc.report["reason"] != "login_form_ambiguous":
                raise
            return await manual_completion()
        if code_field and not code_submitted:
            code = await wait_for_code(1800)
            await code_field.fill(code)
            code = ""
            await code_field.press("Enter")
            code_submitted = True
            progress("login_code_submitted")
        await asyncio.sleep(.5)

    return await manual_completion()
