"""Visible official registration/settings pages. Unknown UI waits for its owner."""
import asyncio
import re
import time
from urllib.parse import urlsplit

from browser_password_login import (EMAIL_INPUT, PASSWORD_INPUT, CODE_INPUT,
                                    official_identity, official_login_page,
                                    login_payment_write, unique_visible, clear_visible_secrets)
from checkout_core import Stop
from browser_checkout import observe_page_network
from registration_security import verification_link, totp, totp_key, offer_from_text


class RegistrationBrowser:
    def __init__(self, job, context):
        self.job, self.context = job, context
        self.data = job.payload
        self.page = None

    async def guard(self, route):
        request = route.request
        url = urlsplit(request.url)
        payment_path = request.method not in {'GET', 'HEAD', 'OPTIONS'} and (
            url.hostname == 'pay.openai.com' or (url.hostname == 'chatgpt.com' and
            re.search(r'/(payments?|billing|checkout|subscriptions?|subscribe|purchase)(?:/|$)', url.path)))
        if login_payment_write(request.method, request.url) or payment_path:
            await route.abort('blockedbyclient')
        else:
            await route.continue_()

    def official(self, page):
        self.job.check()
        if not official_login_page(page.url):
            raise Stop('form_unrecognized')

    async def field(self, page, selector):
        self.official(page)
        try:
            return await unique_visible(page, selector)
        except Stop:
            return None

    async def button(self, page, pattern, role='button'):
        self.official(page)
        candidates = page.get_by_role(role, name=re.compile(pattern, re.I))
        visible = [candidates.nth(i) for i in range(await candidates.count()) if await candidates.nth(i).is_visible()]
        return visible[0] if len(visible) == 1 else None

    async def identity(self, page=None):
        self.official(page or self.page)
        return await official_identity(page or self.page, self.data['email'])

    async def settle(self, seconds=2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.job.check()
            await asyncio.sleep(.25)

    async def mail(self, page):
        code = await self.job.wait_code()
        try:
            if verification_link(code):
                await page.goto(code, wait_until='domcontentloaded', timeout=45000)
            else:
                field = await self.field(page, CODE_INPUT)
                if not field:
                    raise Stop('form_unrecognized')
                await field.fill(code)
                await field.press('Enter')
        finally:
            code = ''
        await self.settle(3)

    async def register(self):
        # Resume the exact profile rather than regenerating name, birthday or credentials.
        if not official_login_page(self.page.url):
            await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        for _ in range(12):
            if await self.identity():
                country = await self.registration_country()
                self.job.event('registered', email=self.data['email'], step='registered',
                               registrationCountryCode=country)
                self.data['registered'] = True
                return
            email = await self.field(self.page, EMAIL_INPUT)
            if email:
                self.job.event('progress', step='email')
                await email.fill(self.data['email'])
                # Timestamp the expected mail BEFORE submission triggers sending.
                self.job.prepare_mail('email_code')
                await email.press('Enter')
                await self.settle(3)
                code = await self.field(self.page, CODE_INPUT)
                if code:
                    await self.mail(self.page)
                elif await self.field(self.page, PASSWORD_INPUT):
                    # This is an existing/password account, not a proven new registration.
                    raise Stop('existing_account_requires_review')
            code = await self.field(self.page, CODE_INPUT)
            if code:
                if not self.job.awaiting_code:
                    self.job.prepare_mail('email_code')
                await self.mail(self.page)
            name = await self.field(self.page, 'input[name="name"], input[name="fullName"], input[autocomplete="name"]')
            birth = await self.field(self.page, 'input[type="date"], input[name="birthday"], input[name="birthdate"]')
            if name and birth:
                self.job.event('progress', step='profile')
                await name.fill(self.data['displayName'])
                await birth.fill(self.data['birthDate'])
                button = await self.button(self.page, r'^(continue|submit|finish|创建账户|创建账号|继续|完成)$')
                if button:
                    await button.click()
                    await self.settle(4)
                    continue
            if await self.identity():
                continue
            signup = await self.button(self.page, r'^(sign up|create account|注册|创建账户|创建账号)$')
            if signup:
                await signup.click()
                await self.settle(3)
                continue
            await self.job.manual('form_unrecognized')
        raise Stop('official_login_not_verified')

    async def registration_country(self):
        self.official(self.page)
        try:
            network = await observe_page_network(self.page)
        except Stop as exc:
            if exc.report['reason'] != 'proxy_network_unconfirmed':
                raise
            country = None
        else:
            country = network['country']
            if country in {'XA', 'XB', 'ZZ'}:
                country = None
        self.job.check()
        return country

    async def settings(self):
        if not await self.identity():
            raise Stop('official_login_not_verified')
        for _ in range(5):
            security = await self.button(self.page, r'^(account security (?:and|&) (?:sign.in|login)|security|账户安全与登录|安全)$')
            if security:
                await security.click()
                await self.settle()
                return
            setting = await self.button(self.page, r'^(settings|设置)$', 'menuitem') or await self.button(self.page, r'^(settings|设置)$')
            if setting:
                await setting.click()
                await self.settle()
                continue
            menu = await self.field(self.page, '[data-testid="accounts-profile-button"], [data-testid="profile-button"]')
            if menu:
                await menu.click()
                await self.settle()
                continue
            await self.job.manual('form_unrecognized')
        raise Stop('form_unrecognized')

    async def verify_login(self, mfa=False):
        # A clean context proves the staged password works; an existing session cannot.
        verification = (await self.job.new_verification_context()
                        if hasattr(self.job, 'new_verification_context')
                        else await self.context.browser.new_context())
        await verification.route('**/*', self.guard)
        page = await verification.new_page()
        try:
            await page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
            await self.settle(3)
            email = await self.field(page, EMAIL_INPUT)
            if not email:
                raise Stop('password_unverified')
            await email.fill(self.data['email'])
            await email.press('Enter')
            await self.settle(3)
            password = await self.field(page, PASSWORD_INPUT)
            if not password:
                choice = await self.button(page, r'^(use (?:a )?password|使用密码|使用密码登录)$')
                if choice:
                    await choice.click()
                    password = await self.field(page, PASSWORD_INPUT)
            if not password:
                raise Stop('password_unverified')
            await password.fill(self.data['password'])
            await password.press('Enter')
            code_submitted = False
            for _ in range(60):
                if await self.identity(page):
                    if mfa and not code_submitted:
                        raise Stop('mfa_unverified')
                    return
                code = await self.field(page, CODE_INPUT)
                if code and mfa and not code_submitted:
                    # Only a visible authenticator-specific challenge may receive TOTP.
                    body = (await page.locator('body').inner_text())[:10000]
                    if not re.search(r'authenticator|authentication app|验证器|身份验证应用', body, re.I):
                        raise Stop('mfa_unverified')
                    await code.fill(totp(self.data['totpSecret']))
                    await code.press('Enter')
                    code_submitted = True
                await self.settle(.5)
            raise Stop('mfa_unverified' if mfa else 'password_unverified')
        finally:
            await clear_visible_secrets(page)
            await verification.close()

    async def password(self):
        self.job.event('progress', step='password')
        # A crash after setting the staged password is recovered by verifying it first.
        try:
            await self.verify_login()
        except Stop as exc:
            if exc.report.get('reason') != 'password_unverified':
                raise
        else:
            self.job.event('password_verified', step='password_verified')
            self.data['passwordVerified'] = True
            return
        await self.settings()
        for _ in range(8):
            inputs = self.page.locator('input[type="password"]')
            visible = [inputs.nth(i) for i in range(await inputs.count()) if await inputs.nth(i).is_visible()]
            if visible:
                if len(visible) > 2 or any([await item.get_attribute('autocomplete') == 'current-password' for item in visible]):
                    raise Stop('existing_account_requires_review')
                for item in visible:
                    await item.fill(self.data['password'])
                submit = await self.button(self.page, r'^(save password|set password|add password|设置密码|保存密码|保存|continue|继续)$')
                if submit:
                    await submit.click()
                    await self.settle(3)
                    await self.verify_login()
                    self.job.event('password_verified', step='password_verified')
                    self.data['passwordVerified'] = True
                    return
            add = await self.button(self.page, r'^(add password|set password|设置密码|添加密码)$')
            if add:
                self.job.prepare_mail('password')
                await add.click()
                await self.settle(3)
                if await self.field(self.page, CODE_INPUT):
                    await self.mail(self.page)
                elif not any([await item.is_visible() for item in await self.page.locator('input[type="password"]').all()]):
                    await self.mail(self.page)
                continue
            await self.job.manual('password_unverified')
            # Manual setting must use the staged password visible only through permitted account editing.
            try:
                await self.verify_login()
            except Stop:
                continue
            self.job.event('password_verified', step='password_verified')
            self.data['passwordVerified'] = True
            return
        raise Stop('password_unverified')

    async def mfa(self):
        self.job.event('progress', step='mfa')
        if self.data['totpSecret']:
            try:
                await self.verify_login(mfa=True)
            except Stop:
                pass
            else:
                self.job.event('mfa_verified', step='mfa_verified')
                self.data['mfaVerified'] = True
                return
        await self.settings()
        for _ in range(8):
            switch = await self.button(self.page, r'authenticator app|身份验证器应用|身份验证应用', 'switch')
            if switch:
                checked = await switch.get_attribute('aria-checked')
                if checked == 'true' and not self.data['totpSecret']:
                    raise Stop('mfa_unverified')
                if checked == 'false':
                    self.job.prepare_mail('mfa')
                    await switch.click()
                    await self.settle(3)
            code = await self.field(self.page, CODE_INPUT)
            text = (await self.page.locator('body').inner_text())[:12000]
            if code and re.search(r'email|邮箱|邮件', text, re.I) and not re.search(r'scan|二维码|setup key|设置密钥', text, re.I):
                await self.mail(self.page)
                continue
            manual = await self.button(self.page, r"can.t scan|unable to scan|无法扫描|不能扫描|enter.*manually|手动输入")
            if manual:
                await manual.click()
                await self.settle()
            # Read only the setup dialog's explicit key, never arbitrary page/chat text.
            dialog = self.page.get_by_role('dialog')
            visible_dialogs = [dialog.nth(i) for i in range(await dialog.count()) if await dialog.nth(i).is_visible()]
            if len(visible_dialogs) == 1:
                keys = visible_dialogs[0].locator('code, [data-testid="totp-secret"], input[readonly]')
                candidates = set()
                for i in range(await keys.count()):
                    item = keys.nth(i)
                    if not await item.is_visible():
                        continue
                    raw = await item.input_value() if await item.evaluate('(el) => el.tagName === "INPUT"') else await item.inner_text()
                    try:
                        candidates.add(totp_key(raw))
                    except Stop:
                        pass
                if len(candidates) == 1:
                    key = candidates.pop()
                    if self.data['totpSecret'] and self.data['totpSecret'] != key:
                        raise Stop('mfa_unverified')
                    self.job.event('totp_pending', totpSecret=key)
                    self.data['totpSecret'] = key
                    code = await self.field(self.page, CODE_INPUT)
                    if code:
                        await code.fill(totp(key))
                        await code.press('Enter')
                        await self.settle(3)
                        await self.verify_login(mfa=True)
                        self.job.event('mfa_verified', step='mfa_verified')
                        self.data['mfaVerified'] = True
                        return
            await self.job.manual('mfa_unverified')
            if self.data['totpSecret']:
                await self.verify_login(mfa=True)
                self.job.event('mfa_verified', step='mfa_verified')
                self.data['mfaVerified'] = True
                return
        raise Stop('mfa_unverified')

    async def offer(self):
        # Only explicit offer cards for this authenticated account. No checkout or redemption.
        if not await self.identity():
            raise Stop('official_login_not_verified')
        close = await self.button(self.page, r'^(close|关闭)$')
        if close:
            await close.click()
        cards = self.page.locator('aside [data-testid*="promo"], aside [data-testid*="offer"], nav [data-testid*="promo"], [aria-label="优惠"], [aria-label="Special offer"]')
        statuses = set()
        for i in range(await cards.count()):
            card = cards.nth(i)
            if not await card.is_visible():
                continue
            text = await card.inner_text()
            if re.search(r'not eligible|expired|unavailable|不符合|已过期|不可用', text, re.I):
                continue
            statuses.add(offer_from_text(text))
        statuses.discard('unknown')
        status = statuses.pop() if len(statuses) == 1 else 'unknown'
        self.job.event('offer', step='offer', offerStatus=status,
                       offerSummary='明确展示的账号优惠' if status != 'unknown' else '页面未提供可确认的优惠信息')

    async def run(self):
        await self.context.route('**/*', self.guard)
        pages = [page for page in self.context.pages if official_login_page(page.url)]
        self.page = pages[-1] if pages else await self.context.new_page()
        try:
            if self.data['registered'] and not official_login_page(self.page.url):
                await self.page.goto('https://chatgpt.com', wait_until='domcontentloaded')
            if not self.data['registered']:
                await self.register()
            elif not await self.identity():
                await self.job.manual('official_login_not_verified')
                if not await self.identity():
                    raise Stop('official_login_not_verified')
            if not self.data['passwordVerified']:
                await self.password()
            if not self.data['mfaVerified']:
                await self.mfa()
            await self.offer()
            self.job.event('complete', step='completed')
        finally:
            await clear_visible_secrets(self.page)
            await self.context.unroute('**/*', self.guard)
