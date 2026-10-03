"""Visible official registration/settings pages. Unknown UI waits for its owner."""
import asyncio
import re
import time
from urllib.parse import urlsplit, parse_qs

from browser_password_login import (EMAIL_INPUT, PASSWORD_INPUT, CODE_INPUT,
                                    official_identity, official_login_page,
                                    login_payment_write, unique_visible, clear_visible_secrets)
from checkout_core import Stop
from browser_checkout import observe_page_network, retryable_page_load_error
from browser_session import SessionBudget
from registration_security import verification_link, totp, totp_key, offer_from_text, registration_age, birth_age

NAME_INPUT = 'input[name="name"], input[name="fullName"], input[autocomplete="name"]'
BIRTH_INPUT = 'input[type="date"], input[name="birthday"], input[name="birthdate"]'
AGE_INPUT = 'input[name="age"], input[autocomplete="age"]'
PROFILE_SUBMIT = r'^(continue|submit|finish|next|创建账户|创建账号|继续|完成|下一步)$'
REGISTRATION_OBSERVE_SECONDS = 15


class RegistrationBrowser:
    def __init__(self, job, context):
        self.job, self.context = job, context
        self.data = job.payload
        self.page = None
        self.registration_state = getattr(job, 'registration_state', {})
        self.registration_refreshed = False
        self.recovery_readonly = None
        self.registration_loading = False

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

    async def challenge(self):
        self.official(self.page)
        title = await self.page.title()
        text = (await self.page.locator('body').inner_text())[:12000]
        busy = self.page.locator('[aria-busy="true"], [role="progressbar"]')
        self.registration_loading = (bool(re.fullmatch(r'(?:loading|正在加载|请稍候)[\s.!…]*', text.strip(), re.I))
                                     or any([await item.is_visible() for item in await busy.all()]))
        if re.search(r'just a moment|verify.{0,40}human|human verification|人机验证|本人验证|安全验证', title + '\n' + text, re.I):
            return True
        challenges = self.page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile')
        if any([await item.is_visible() for item in await challenges.all()]):
            return True
        phone = await self.field(self.page, 'input[type="tel"], input[name="phone_number"], input[name="phone"]')
        if phone and re.search(r'verif.{0,30}(?:phone|mobile)|(?:phone|mobile).{0,30}verif|phone number|enter.{0,30}(?:phone|mobile)|手机号|手机验证|电话验证', text, re.I):
            return True
        code = await self.field(self.page, CODE_INPUT)
        return bool(code and re.search(r'authenticator|authentication app|验证器|身份验证应用|phone verification|text message|短信|手机验证码', text, re.I))

    async def profile_fields(self):
        self.official(self.page)
        name = await unique_visible(self.page, NAME_INPUT)
        if not name:
            birth = await unique_visible(self.page, BIRTH_INPUT)
            age = await unique_visible(self.page, AGE_INPUT)
            if not age:
                labelled = self.page.get_by_label(re.compile(r'^(age|年龄)$', re.I)).and_(self.page.locator('input'))
                visible = [labelled.nth(i) for i in range(await labelled.count()) if await labelled.nth(i).is_visible()]
                if len(visible) > 1:
                    raise Stop('form_unrecognized')
                age = visible[0] if visible else None
            if birth or age:
                return None, birth, age, None  # Split/delayed onboarding cannot be called complete.
            return None
        roots = name.locator('xpath=ancestor::*[self::form or @role="dialog"][1]')
        if await roots.count() != 1:
            raise Stop('form_unrecognized')
        root = roots.first
        birth = await unique_visible(root, BIRTH_INPUT)
        ages = root.locator(AGE_INPUT).or_(root.get_by_label(re.compile(r'^(age|年龄)$', re.I)).and_(root.locator('input')))
        visible_ages = [ages.nth(i) for i in range(await ages.count()) if await ages.nth(i).is_visible()]
        if len(visible_ages) > 1 or (birth and visible_ages):
            raise Stop('form_unrecognized')
        age = visible_ages[0] if visible_ages else None
        if not birth and not age:
            return name, None, None, None  # Onboarding is still pending, even with a session.
        candidates = root.get_by_role('button', name=re.compile(PROFILE_SUBMIT, re.I))
        visible_buttons = [candidates.nth(i) for i in range(await candidates.count()) if await candidates.nth(i).is_visible()]
        buttons = [button for button in visible_buttons if await button.is_enabled()]
        if len(buttons) > 1 or (not buttons and len(visible_buttons) > 1):
            raise Stop('form_unrecognized')
        button = buttons[0] if buttons else visible_buttons[0] if visible_buttons else None
        ready = button and await name.is_enabled() and await (birth or age).is_enabled()
        return name, birth, age, button if ready else None

    async def registration_view(self):
        if await self.challenge():
            return 'verification', None
        code = await self.field(self.page, CODE_INPUT)
        if code:
            return 'code', code
        profile = await self.profile_fields()
        if profile:
            return 'profile', profile
        if self.registration_loading:
            return 'unknown', None
        if await self.identity():
            return 'registered', None
        if await self.field(self.page, PASSWORD_INPUT):
            return 'existing', None
        email = await self.field(self.page, EMAIL_INPUT)
        if email:
            return 'email', email
        signup = await self.button(self.page, r'^(sign up|create account|注册|创建账户|创建账号)$')
        return ('signup', signup) if signup else ('unknown', None)

    async def guard_registered_onboarding(self):
        # Older checkpoints may have saved a session before onboarding was complete.
        async def pending():
            try:
                return bool(await self.profile_fields()) or self.registration_loading
            except Stop as exc:
                if exc.report.get('reason') not in {'form_unrecognized', 'login_form_ambiguous'}:
                    raise
                return True
        if await self.challenge():
            await self.manual_registration('verification_required')
        if await pending():
            await self.manual_registration('form_unrecognized')
        if await self.challenge() or await pending():
            raise Stop('form_unrecognized')

    async def end_recovery(self):
        if self.recovery_readonly is not None:
            await self.context.unroute('**/*', self.recovery_readonly)
            self.recovery_readonly = None

    async def manual_registration(self, reason):
        # An explicit administrator handoff may perform writes in the same window.
        await self.end_recovery()
        await self.job.manual(reason)

    async def refresh_registration(self):
        self.official(self.page)
        url = self.page.url
        parsed = urlsplit(url)
        keys = {key.casefold() for key in parse_qs(parsed.query, keep_blank_values=True)}
        unsafe = (parsed.username or parsed.password or parsed.port not in {None, 443}
                  or verification_link(url) or re.search(r'callback|confirmation|reset|verify|payment|billing|checkout|subscription|subscribe|purchase', parsed.path, re.I)
                  or any(re.search(r'(?:^|_)(?:code|token|ticket)(?:$|_)', key) for key in keys)
                  or parsed.fragment)
        if self.registration_refreshed or unsafe:
            return False
        self.registration_refreshed = True
        self.job.event('progress', reason='registration_page_refreshing')
        async def readonly(route):
            if route.request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                await route.abort('blockedbyclient')
            else:
                await route.fallback()
        await self.context.route('**/*', readonly)
        self.recovery_readonly = readonly
        verification = False
        try:
            budget = SessionBudget(20, cancelled=self.job.cancelled.is_set)
            # Explicit GET in this Page: reload could resubmit a previous document POST.
            response = await budget.run(lambda: self.page.goto(url, wait_until='domcontentloaded', timeout=0), 'page_refresh')
            self.official(self.page)
            verification = bool(response and response.status == 403)
            if response and response.status >= 400 and not verification:
                raise Stop('http_error', http_status=response.status)
        except Exception as exc:
            if not retryable_page_load_error(exc):
                await self.end_recovery()
                raise
            return False
        if verification:
            await self.manual_registration('verification_required')
        return True

    async def register(self):
        # Resume the exact profile rather than regenerating name, birthday or credentials.
        if not official_login_page(self.page.url):
            await self.page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded')
        email_submitted = code_submitted = signup_clicked = False
        observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
        for _ in range(160):
            self.job.check()
            try:
                budget = SessionBudget(10, cancelled=self.job.cancelled.is_set)
                view, field = await budget.run(self.registration_view, 'registration_observe')
            except Exception as exc:
                if isinstance(exc, Stop) and exc.report.get('reason') in {'form_unrecognized', 'login_form_ambiguous'}:
                    await self.manual_registration('form_unrecognized')
                    continue
                if not retryable_page_load_error(exc):
                    raise
                view, field = 'unknown', None
            if view == 'verification':
                await self.manual_registration('verification_required')
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if view == 'code':
                if code_submitted:
                    await self.manual_registration('form_unrecognized')
                    code_submitted = False
                else:
                    if not self.job.awaiting_code:
                        self.job.prepare_mail('email_code')
                    code_submitted = True
                    await self.end_recovery()
                    await self.mail(self.page)
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if view == 'registered':
                country = await self.registration_country()
                self.job.event('registered', email=self.data['email'], step='registered',
                               registrationCountryCode=country)
                self.data['registered'] = True
                await self.end_recovery()
                return
            if view == 'profile' and field[3] and not self.registration_state.get('profile_submitted'):
                name, birth, age, button = field
                await self.end_recovery()
                self.job.event('progress', step='profile')
                await name.fill(self.data['displayName'])
                if birth:
                    await birth.fill(self.data['birthDate'])
                else:
                    value = (registration_age(self.data['registrationAge'], self.data['birthDate'])
                             if 'registrationAge' in self.data else birth_age(self.data['birthDate']))
                    expected = str(value)
                    current = await age.input_value()
                    if current != expected:
                        if current:
                            await age.fill('')
                            if await age.input_value():
                                raise Stop('form_unrecognized')
                        await age.fill(expected)
                    if await age.input_value() != expected:
                        raise Stop('form_unrecognized')
                # Input validation may enable the initially disabled submit button.
                if await button.is_enabled():
                    self.registration_state['profile_submitted'] = True
                    await button.click()
                    await self.settle(4)
                    observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                    continue
            if view == 'existing':
                raise Stop('existing_account_requires_review')
            if view == 'email' and not email_submitted:
                await self.end_recovery()
                self.job.event('progress', step='email')
                await field.fill(self.data['email'])
                # Timestamp the expected mail BEFORE submission triggers sending.
                self.job.prepare_mail('email_code')
                email_submitted = True
                await field.press('Enter')
                await self.settle(3)
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if view == 'signup' and not signup_clicked:
                await self.end_recovery()
                signup_clicked = True
                await field.click()
                await self.settle(3)
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if time.monotonic() < observation_deadline:
                await self.settle(.5)
                continue
            if await self.refresh_registration():
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            await self.manual_registration('form_unrecognized')
            observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
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
            else:
                await self.guard_registered_onboarding()
                if not await self.identity():
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
            await self.end_recovery()
            await clear_visible_secrets(self.page)
            await self.context.unroute('**/*', self.guard)
