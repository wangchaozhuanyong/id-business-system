"""Visible official registration/settings pages. Unknown UI waits for its owner."""
import asyncio
import logging
import re
import time
from urllib.parse import urlsplit, parse_qs

from browser_password_login import (EMAIL_INPUT, PASSWORD_INPUT, CODE_INPUT,
                                    official_identity, official_login_page,
                                    login_payment_write, login_code_type, unique_visible, clear_visible_secrets)
from checkout_core import Stop
from browser_checkout import observe_page_network, retryable_page_load_error
from browser_session import SessionBudget, session_failure, RETRYABLE_NETWORK_CODES
from registration_job import JOB_ID, STEPS
from registration_security import verification_link, totp, totp_key, offer_from_text, registration_age, birth_age

NAME_INPUT = 'input[name="name"], input[name="fullName"], input[autocomplete="name"]'
BIRTH_INPUT = 'input[type="date"], input[name="birthday"], input[name="birthdate"]'
AGE_INPUT = 'input[name="age"], input[autocomplete="age"]'
PROFILE_SUBMIT = r'^(continue|submit|finish|next|创建账户|创建账号|继续|完成|下一步)$'
REGISTRATION_OBSERVE_SECONDS = 15
REGISTRATION_VIEWS = {'verification', 'code', 'profile', 'unknown', 'registered', 'existing', 'email', 'signup'}
REGISTRATION_WRITES = {'email_submit', 'code_submit', 'profile_submit', 'signup_click'}
IDENTITY_RECOVERY = 'identity_recovery_readonly'


class RegistrationBrowser:
    def __init__(self, job, context):
        self.job, self.context = job, context
        self.data = job.payload
        self.page = None
        self.registration_state = getattr(job, 'registration_state', {})
        self.registration_refreshed = False
        self.recovery_readonly = None
        self.registration_loading = False
        self.observation_budget = None
        retained = self.registration_state.get(IDENTITY_RECOVERY)
        if retained is not None:
            if (type(retained) is not dict or set(retained) != {'context', 'page', 'handler'}
                    or retained['context'] is not self.context or not callable(retained['handler'])
                    or self.data.get('registered') is not True):
                raise Stop('builtin_profile_missing')
            self.recovery_readonly = retained['handler']
            self.registration_refreshed = True

    def operation(self, name):
        self.job.registration_operation = name
        if type(name) is str and name in REGISTRATION_WRITES:
            self.job.registration_last_write = name

    def log_pause(self, reason):
        def closed(value, allowed, default='none'):
            return value if type(value) is str and value in allowed else default
        job_id = getattr(self.job, 'id', None)
        attempt = getattr(self.job, 'attempt', None)
        observation = getattr(self.job, 'registration_observation_error', None)
        observation = observation if isinstance(observation, dict) else {}
        logging.getLogger('registration').warning(
            'Registration paused job=%s attempt=%s step=%s reason=%s last_observed_view=%s last_write=%s '
            'email_submit_started=%s email_click_returned=%s email_submitted=%s code_submitted=%s profile_submitted=%s '
            'observation_reason=%s observation_error_type=%s observation_browser_code=%s',
            job_id if type(job_id) is str and JOB_ID.fullmatch(job_id) else 'unknown',
            attempt if type(attempt) is int and 0 < attempt <= 2147483647 else 0,
            closed(getattr(self.job, 'step', None), STEPS, 'unknown'),
            closed(reason, {'verification_required', 'form_unrecognized'}, 'unknown'),
            closed(getattr(self.job, 'registration_last_observed_view', None), REGISTRATION_VIEWS, 'unknown'),
            closed(getattr(self.job, 'registration_last_write', None), REGISTRATION_WRITES),
            *(self.registration_state.get(key) is True for key in (
                'email_submit_started', 'email_click_returned', 'email_submitted', 'code_submitted', 'profile_submitted')),
            closed(observation.get('reason'), {'session_network_error', 'session_load_timeout', 'registration_page_changing'}),
            closed(observation.get('error_type'), {'TimeoutError', 'AssertionError', 'Error', 'TargetClosedError', 'UnexpectedError'}),
            closed(observation.get('browser_error_code'), RETRYABLE_NETWORK_CODES))

    async def guard(self, route):
        # A new attempt's guard is registered last; delegate to the exact retained
        # read-only handler so it cannot hide the older route via continue_().
        if self.recovery_readonly is not None:
            await self.recovery_readonly(route)
            return
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
        self.operation('identity_read')
        budget = self.observation_budget or SessionBudget(10, cancelled=self.job.cancelled.is_set)
        return await official_identity(page or self.page, self.data['email'],
                                       budget=budget, observe_errors=True)

    @staticmethod
    def retryable_observation(error):
        if isinstance(error, Stop):
            return retryable_page_load_error(error)
        if type(error).__name__ == 'TimeoutError':
            return True
        if type(error).__name__ != 'Error':
            return False
        return (retryable_page_load_error(error) or bool(re.search(
            r'Execution context was destroyed|Cannot find context with specified id', str(error))))

    def recovery_budget(self):
        self.job.check()
        seconds = REGISTRATION_OBSERVE_SECONDS
        deadline = getattr(self.job, 'deadline', None)
        if type(deadline) in {int, float}:
            seconds = min(seconds, max(0, deadline - time.monotonic()))
        return SessionBudget(seconds, cancelled=self.job.cancelled.is_set)

    async def registered_identity(self):
        # This is an identity read in the retained Page, never registration replay.
        budget = self.recovery_budget()
        previous_budget = self.observation_budget
        try:
            self.observation_budget = SessionBudget(
                min(10, budget.remaining_ms() / 1000), cancelled=self.job.cancelled.is_set)
            try:
                identity = await self.identity()
                if identity:
                    await self.end_recovery()
                elif self.recovery_readonly is not None:
                    raise Stop('official_login_not_verified')
                return identity
            except Exception as exc:
                if not self.retryable_observation(exc):
                    raise
                first_error = exc
                previous_error = getattr(self.job, 'registration_observation_error', None)
                if previous_error is None or (type(previous_error) is dict and not previous_error):
                    details = exc.report if isinstance(exc, Stop) else session_failure(exc)
                    reason = ('registration_page_changing' if type(exc).__name__ == 'Error' and re.search(
                        r'Execution context was destroyed|Cannot find context with specified id', str(exc))
                        else details.get('reason'))
                    allowed = {
                        'reason': {'session_network_error', 'session_load_timeout', 'registration_page_changing'},
                        'error_type': {'TimeoutError', 'AssertionError', 'Error', 'TargetClosedError', 'UnexpectedError'},
                        'browser_error_code': RETRYABLE_NETWORK_CODES}
                    self.job.registration_observation_error = {
                        key: value for key, values in allowed.items()
                        if type(value := reason if key == 'reason' else details.get(key)) is str and value in values}
            # A short read-only observation precedes the sole safe GET; both use
            # the original overall deadline, including time spent reading identity.
            await budget.run(lambda: self.settle(.25), 'registered_reobserve')
            self.observation_budget = budget
            if not await self.refresh_registration():
                raise first_error
            await self.guard_registered_onboarding()
            identity = await self.identity()
            if not identity:
                raise Stop('official_login_not_verified')
            await self.end_recovery()
            return identity
        finally:
            self.observation_budget = previous_budget

    async def settle(self, seconds=2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.job.check()
            await asyncio.sleep(.25)

    async def mail(self, page, *, registration_code=False):
        code = await self.job.wait_code()
        try:
            if verification_link(code):
                if registration_code:
                    self.registration_state['code_submitted'] = True
                    self.operation('code_submit')
                await page.goto(code, wait_until='domcontentloaded', timeout=45000)
            else:
                field = await self.field(page, CODE_INPUT)
                if not field:
                    raise Stop('form_unrecognized')
                if registration_code:
                    # Input/change handlers may submit while fill is still awaiting.
                    self.registration_state['code_submitted'] = True
                    self.operation('code_submit')
                await field.fill(code)
                await field.press('Enter')
        finally:
            code = ''
        await self.settle(3)

    async def challenge(self):
        self.official(self.page)
        self.operation('challenge_read')
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
        self.operation('profile_read')
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
        root_count = await roots.count()
        if root_count == 0 and not await name.is_visible():
            self.registration_loading = True
            return None
        if root_count != 1:
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
        if not await name.is_visible():
            self.registration_loading = True
            return None
        return name, birth, age, button if ready else None

    async def registration_view(self):
        if await self.challenge():
            return 'verification', None
        code = await self.field(self.page, CODE_INPUT)
        if code:
            if await self.challenge():
                return 'verification', None
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
            handler = self.recovery_readonly
            await self.context.unroute('**/*', handler)
            retained = self.registration_state.get(IDENTITY_RECOVERY)
            if (type(retained) is dict and retained.get('context') is self.context
                    and retained.get('handler') is handler):
                self.registration_state.pop(IDENTITY_RECOVERY)
            self.recovery_readonly = None

    async def manual_registration(self, reason):
        # An explicit administrator handoff may perform writes in the same window.
        # Registered identity recovery stays read-only while its owner observes
        # a challenge or ambiguous onboarding; no unverified handoff unlocks writes.
        if IDENTITY_RECOVERY not in self.registration_state:
            await self.end_recovery()
        self.log_pause(reason)
        if reason == 'verification_required' and not self.data.get('registered'):
            await self.job.manual(reason, can_resume=self.verification_resolved)
        else:
            await self.job.manual(reason)

    async def verification_resolved(self):
        """Reobserve an interstitial that may clear itself; never act on a challenge."""
        if self.data.get('registered'):
            return False
        budget = SessionBudget(3, cancelled=self.job.cancelled.is_set)
        previous_budget = self.observation_budget
        self.observation_budget = budget
        async def observe():
            self.official(self.page)
            if await self.challenge() or self.registration_loading:
                return False
            code = await unique_visible(self.page, CODE_INPUT)
            if code:
                return (not self.registration_state.get('code_submitted')
                        and await code.is_enabled()
                        and await login_code_type(self.page, code) == 'email')
            profile = await self.profile_fields()
            if profile:
                return bool(not self.registration_state.get('profile_submitted')
                            and profile[0] and (profile[1] or profile[2])
                            and profile[3] and await profile[3].is_enabled())
            if self.registration_loading:
                return False
            # A fully verified identity can be observed, but the ordinary flow
            # must read it again and emit its own durable completion evidence.
            return bool(await self.identity())
        try:
            resolved = await budget.run(observe, 'verification_reobserve')
            self.job.check()
            return resolved
        except Stop as exc:
            if exc.report.get('reason') in {
                    'verification_required', 'form_unrecognized', 'login_form_ambiguous',
                    'session_load_timeout', 'session_network_error', 'http_error'}:
                return False
            raise
        except Exception as exc:
            page_changing = (type(exc).__name__ == 'Error' and bool(re.search(
                r'Execution context was destroyed|Cannot find context with specified id', str(exc))))
            if page_changing or retryable_page_load_error(exc):
                return False
            raise
        finally:
            self.observation_budget = previous_budget

    async def refresh_registration(self):
        self.operation('page_refresh')
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
        if self.data.get('registered') is True:
            self.registration_state[IDENTITY_RECOVERY] = {
                'context': self.context, 'page': self.page, 'handler': readonly}
        verification = False
        try:
            budget = self.observation_budget or SessionBudget(20, cancelled=self.job.cancelled.is_set)
            # Explicit GET in this Page: reload could resubmit a previous document POST.
            response = await budget.run(lambda: self.page.goto(url, wait_until='domcontentloaded', timeout=0), 'page_refresh')
            self.official(self.page)
            verification = bool(response and response.status == 403)
            if response and response.status >= 400 and not verification:
                raise Stop('http_error', http_status=response.status)
        except Exception as exc:
            if not retryable_page_load_error(exc):
                if IDENTITY_RECOVERY not in self.registration_state:
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
        signup_clicked = False
        observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
        for _ in range(160):
            self.job.check()
            try:
                budget = SessionBudget(10, cancelled=self.job.cancelled.is_set)
                self.observation_budget = budget
                view, field = await budget.run(self.registration_view, 'registration_observe')
                self.job.registration_last_observed_view = view if type(view) is str and view in REGISTRATION_VIEWS else 'unknown'
            except Exception as exc:
                if isinstance(exc, Stop) and exc.report.get('reason') == 'verification_required':
                    await self.manual_registration('verification_required')
                    continue
                if isinstance(exc, Stop) and exc.report.get('reason') in {'form_unrecognized', 'login_form_ambiguous'}:
                    await self.manual_registration('form_unrecognized')
                    continue
                page_changing = (type(exc).__name__ == 'Error' and bool(re.search(
                    r'Execution context was destroyed|Cannot find context with specified id', str(exc))))
                if not page_changing and not retryable_page_load_error(exc):
                    raise
                # Only controlled transport diagnostics survive; never exception text or session data.
                details = exc.report if isinstance(exc, Stop) else session_failure(exc)
                if not getattr(self.job, 'registration_observation_error', None):
                    self.job.registration_observation_error = {
                        key: details[key] for key in ('reason', 'error_type', 'browser_error_code') if key in details}
                    if page_changing:
                        self.job.registration_observation_error['reason'] = 'registration_page_changing'
                view, field = 'unknown', None
            finally:
                self.observation_budget = None
            if view == 'verification':
                await self.manual_registration('verification_required')
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if view == 'code':
                if self.registration_state.get('code_submitted'):
                    # The old input may remain while the accepted code navigates.
                    # Observe within the existing budget without submitting again.
                    if time.monotonic() < observation_deadline:
                        await self.settle(.5)
                        continue
                    await self.manual_registration('form_unrecognized')
                else:
                    if not self.job.awaiting_code:
                        self.job.prepare_mail('email_code')
                    else:
                        # Manual resume reports progress; rearm delivery without clearing a queued code.
                        self.job.event('waiting_email', step='email_code', newMailRequest=False)
                    await self.end_recovery()
                    await self.mail(self.page, registration_code=True)
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
                self.operation('profile_submit')
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
            if view == 'email' and not self.registration_state.get('email_submitted'):
                await self.end_recovery()
                self.job.event('progress', step='email')
                self.operation('email_submit')
                budget = SessionBudget(REGISTRATION_OBSERVE_SECONDS,
                                       cancelled=self.job.cancelled.is_set)
                async def prepare_email_submit():
                    await field.fill(self.data['email'])
                    submit = await self.button(self.page, r'^(continue|继续)$')
                    while submit and not await submit.is_enabled():
                        await self.settle(.5)
                        submit = await self.button(self.page, r'^(continue|继续)$')
                    current_email = await self.field(self.page, EMAIL_INPUT)
                    if (not submit or not await submit.is_enabled() or not current_email
                            or await current_email.input_value() != self.data['email']):
                        return None, 'form_unrecognized'
                    if await self.challenge():
                        return None, 'verification_required'
                    return submit, None
                try:
                    submit, reason = await budget.run(prepare_email_submit, 'email_submit_observe')
                    budget.remaining_ms()
                except Stop as exc:
                    if exc.report.get('reason') != 'session_load_timeout':
                        raise
                    if not getattr(self.job, 'registration_observation_error', None):
                        self.job.registration_observation_error = {
                            key: exc.report[key] for key in ('reason', 'error_type', 'browser_error_code')
                            if key in exc.report}
                    reason = 'form_unrecognized'
                if reason:
                    await self.manual_registration(reason)
                    observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                    continue
                # Timestamp the expected mail BEFORE submission triggers sending.
                self.operation('email_submit')
                self.job.prepare_mail('email_code', new_request=True)
                self.registration_state['email_submitted'] = True
                self.registration_state['email_submit_started'] = True
                await submit.click(timeout=budget.remaining_ms())
                self.registration_state['email_click_returned'] = True
                await self.settle(3)
                observation_deadline = time.monotonic() + REGISTRATION_OBSERVE_SECONDS
                continue
            if view == 'signup' and not signup_clicked:
                await self.end_recovery()
                signup_clicked = True
                self.operation('signup_click')
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

    async def verify_login(self, mfa=False, *, allow_email_identity=False):
        # A clean context proves the staged password works; an existing session cannot.
        verification = None
        page = None
        primary_error = None
        phase = 'context_create'

        def mark(name):
            nonlocal phase
            phase = name
            self.operation('verification_' + name)

        def failure(error, *, cleanup=False):
            name = type(error).__name__
            details = {'phase': phase, 'error_type': name if name in {
                'TimeoutError', 'AssertionError', 'Error', 'TargetClosedError', 'Stop'
            } else 'UnexpectedError'}
            attribute = ('registration_verification_cleanup_error' if cleanup
                         else 'registration_verification_error')
            if getattr(self.job, attribute, None) is None:
                setattr(self.job, attribute, details)
            if not cleanup:
                self.job.registration_verification_last_error = details
            job_id = getattr(self.job, 'id', None)
            attempt = getattr(self.job, 'attempt', None)
            report = error.report if isinstance(error, Stop) else {}
            if name in {'Error', 'TimeoutError', 'TargetClosedError'}:
                try:
                    report = session_failure(error)
                except Exception:
                    report = {}
            code = report.get('browser_error_code')
            logging.getLogger('registration').warning(
                'Registration verification failed job=%s attempt=%s phase=%s error_type=%s browser_code=%s cleanup=%s',
                job_id if type(job_id) is str and JOB_ID.fullmatch(job_id) else 'unknown',
                attempt if type(attempt) is int and 0 < attempt <= 2147483647 else 0,
                details['phase'], details['error_type'],
                code if type(code) is str and code in RETRYABLE_NETWORK_CODES else 'none', cleanup)
        submitted_email = False
        submitted_totp = False

        async def safe_page():
            mark('body_read')
            self.official(page)
            text = (await page.locator('body').inner_text())[:12000]
            if re.search(r'just a moment|verify.{0,40}human|human verification|人机验证',
                         await page.title() + '\n' + text, re.I):
                raise Stop('verification_required')
            challenges = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile')
            if any([await item.is_visible() for item in await challenges.all()]):
                raise Stop('verification_required')
            phones = page.locator('input[type="tel"], input[name="phone_number"], input[name="phone"]')
            if (any([await item.is_visible() for item in await phones.all()])
                    and re.search(r'verif.{0,30}(?:phone|mobile)|(?:phone|mobile).{0,30}verif|phone number|enter.{0,30}(?:phone|mobile)|手机号|手机验证|电话验证', text, re.I)):
                raise Stop('verification_required')

        async def email_code():
            nonlocal submitted_email
            if submitted_email:
                raise Stop('verification_required')
            submitted_email = True
            value = ''
            try:
                try:
                    mark('email_code_wait')
                    value = await asyncio.wait_for(self.job.wait_code(), timeout=120)
                except asyncio.TimeoutError:
                    raise Stop('verification_required') from None
                await safe_page()
                field = await self.field(page, CODE_INPUT)
                if (not field or await login_code_type(page, field) != 'email'
                        or not isinstance(value, str) or not re.fullmatch(r'[0-9]{6,8}', value)):
                    raise Stop('verification_required')
                self.official(page)
                mark('email_code_fill')
                await field.fill(value)
                await safe_page()
                field = await self.field(page, CODE_INPUT)
                if not field or await login_code_type(page, field) != 'email':
                    raise Stop('verification_required')
                self.official(page)
                mark('email_code_submit')
                await field.press('Enter')
            finally:
                value = ''
            await self.settle(3)

        async def reobserve_submitted_code_identity(*, before_password=False):
            # A code can disappear between locating it and reading its label.
            # Only a previously submitted recognized code permits this one read;
            # no navigation, new context, fill or Enter is repeated.
            if not submitted_email and not submitted_totp:
                return None
            await safe_page()
            mark('identity_read')
            identity = await self.identity(page)
            self.official(page)
            if not identity:
                return None
            mark('field_read')
            if await unique_visible(page, CODE_INPUT):
                raise Stop('verification_required')
            if before_password:
                if allow_email_identity and submitted_email and not mfa:
                    return False
                raise Stop('verification_required')
            if mfa and not submitted_totp:
                raise Stop('mfa_unverified')
            return True

        try:
            mark('context_create')
            verification = (await self.job.new_verification_context()
                            if hasattr(self.job, 'new_verification_context')
                            else await self.context.browser.new_context())
            mark('context_route')
            await verification.route('**/*', self.guard)
            mark('page_create')
            page = await verification.new_page()
            budget = self.recovery_budget()
            navigation_readonly = None
            # No email, password or OTP has been entered: only the fixed GET can
            # be repeated once, in this clean Page and the same total budget.
            for navigation in range(2):
                mark('navigation')
                try:
                    response = await budget.run(lambda: page.goto(
                        'https://chatgpt.com/auth/login', wait_until='domcontentloaded', timeout=0),
                        'verification_page_load')
                    self.official(page)
                    if response and response.status >= 400:
                        raise Stop('verification_required' if response.status == 403 else 'http_error',
                                   http_status=response.status)
                    break
                except Exception as exc:
                    if navigation or not self.retryable_observation(exc):
                        raise
                    failure(exc)
                    budget.remaining_ms()
                    async def readonly(route):
                        if route.request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                            await route.abort('blockedbyclient')
                        else:
                            await route.fallback()
                    mark('navigation_guard')
                    await verification.route('**/*', readonly)
                    navigation_readonly = readonly
            await self.settle(3)
            await safe_page()
            mark('field_read')
            email = await self.field(page, EMAIL_INPUT)
            if not email:
                raise Stop('verification_required')
            if navigation_readonly:
                mark('navigation_guard')
                await verification.unroute('**/*', navigation_readonly)
            mark('email_fill')
            await email.fill(self.data['email'])
            # Fence the current task's mail before either login submission can send it.
            mark('mail_prepare')
            self.job.prepare_mail('mfa' if mfa else 'password', new_request=True)
            await safe_page()
            self.official(page)
            mark('email_submit')
            await email.press('Enter')
            await self.settle(3)
            chose_password = False
            for _ in range(60):
                await safe_page()
                mark('identity_read')
                if await self.identity(page):
                    # Inspect identity before any settings password control can
                    # be mistaken for an unauthenticated login form.
                    if allow_email_identity and submitted_email and not mfa:
                        return False
                    raise Stop('verification_required')
                mark('field_read')
                password = await self.field(page, PASSWORD_INPUT)
                if password:
                    break
                if not chose_password:
                    choice = await self.button(page, r'^(use (?:a )?password|使用密码|使用密码登录)$')
                    if choice:
                        mark('password_choice')
                        await choice.click()
                        chose_password = True
                        await self.settle(.5)
                        continue
                code = await self.field(page, CODE_INPUT)
                if code:
                    await safe_page()
                    code_type = await login_code_type(page, code)
                    if code_type != 'email':
                        if code_type == 'unknown':
                            verified = await reobserve_submitted_code_identity(before_password=True)
                            if verified is not None:
                                return verified
                        raise Stop('verification_required')
                    if not submitted_email:
                        await email_code()
                    else:
                        await self.settle(.5)
                    continue
                await self.settle(.5)
            else:
                raise Stop('verification_required')
            await safe_page()
            self.official(page)
            mark('password_fill')
            await password.fill(self.data['password'])
            await safe_page()
            self.official(page)
            mark('password_submit')
            await password.press('Enter')
            for _ in range(60):
                await safe_page()
                mark('identity_read')
                if await self.identity(page):
                    if mfa and not submitted_totp:
                        # Password and identity are proved; settings must still show
                        # an unconfigured authenticator before enrollment can resume.
                        raise Stop('mfa_unverified')
                    return True
                code = await self.field(page, CODE_INPUT)
                if code:
                    await safe_page()
                    code_type = await login_code_type(page, code)
                    if code_type == 'email':
                        if not submitted_email:
                            await email_code()
                    elif code_type == 'totp' and mfa and not submitted_totp:
                        submitted_totp = True
                        value = totp(self.data['totpSecret'])
                        try:
                            self.official(page)
                            mark('totp_fill')
                            await code.fill(value)
                            await safe_page()
                            code = await self.field(page, CODE_INPUT)
                            if not code or await login_code_type(page, code) != 'totp':
                                raise Stop('verification_required')
                            self.official(page)
                            mark('totp_submit')
                            await code.press('Enter')
                        finally:
                            value = ''
                    elif code_type != 'totp' or not mfa:
                        if code_type == 'unknown':
                            verified = await reobserve_submitted_code_identity()
                            if verified is not None:
                                return verified
                        raise Stop('verification_required')
                else:
                    text = (await page.locator('body').inner_text())[:12000]
                    if re.search(r'(?:wrong|incorrect|invalid) password|password (?:is )?(?:incorrect|invalid)|密码错误|密码不正确', text, re.I):
                        raise Stop('password_unverified')
                await self.settle(.5)
            raise Stop('verification_required')
        except BaseException as exc:
            primary_error = exc
            mark(phase)
            failure(exc)
            raise
        finally:
            cleanup_error = None
            failed_phase = phase
            for name, cleanup in (
                    ('secret_cleanup', lambda: clear_visible_secrets(page) if page else asyncio.sleep(0)),
                    ('context_cleanup', lambda: verification.close() if verification else asyncio.sleep(0))):
                try:
                    phase = name
                    await cleanup()
                except Exception as exc:
                    if cleanup_error is None:
                        cleanup_error = exc
                    failure(exc, cleanup=True)
            if primary_error is not None:
                mark(failed_phase)
            elif cleanup_error is not None:
                mark('cleanup')
                raise cleanup_error

    async def password(self):
        self.job.event('progress', step='password')
        # A crash after setting the staged password is recovered by verifying it first.
        email_identity_only = False
        try:
            verified = await self.verify_login(allow_email_identity=True)
        except Stop as exc:
            if exc.report.get('reason') != 'password_unverified':
                raise
        else:
            if verified is True:
                self.job.event('password_verified', step='password_verified')
                self.data['passwordVerified'] = True
                return
            if verified is not False:
                raise Stop('verification_required')
            email_identity_only = True
        await self.settings()
        if email_identity_only:
            # A fresh email-only account may set a password only in its already
            # verified original window with an explicit unconfigured entry.
            if not await self.identity() or await self.challenge():
                raise Stop('verification_required')
            current = self.page.locator('input[autocomplete="current-password"]')
            configured_name = re.compile(r'^(change password|reset password|修改密码|更改密码|重置密码)$', re.I)
            configured = self.page.get_by_role('button', name=configured_name).or_(
                self.page.get_by_role('link', name=configured_name)).or_(
                self.page.get_by_role('menuitem', name=configured_name))
            if (any([await item.is_visible() for item in await current.all()])
                    or any([await item.is_visible() for item in await configured.all()])
                    or not await self.button(self.page, r'^(add password|set password|设置密码|添加密码)$')):
                raise Stop('verification_required')
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
                self.job.prepare_mail('password', new_request=True)
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
            except Stop as exc:
                if exc.report.get('reason') != 'password_unverified':
                    raise
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
            except Stop as exc:
                if exc.report.get('reason') != 'mfa_unverified':
                    raise
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
                    self.job.prepare_mail('mfa', new_request=True)
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
        self.operation('browser_attach')
        primary_error = None
        try:
            await self.context.route('**/*', self.guard)
            retained = self.registration_state.get(IDENTITY_RECOVERY)
            if retained is not None:
                self.page = retained['page']
                if self.page not in self.context.pages:
                    raise Stop('builtin_profile_missing')
                self.official(self.page)
            else:
                pages = [page for page in self.context.pages if official_login_page(page.url)]
                self.page = pages[-1] if pages else await self.context.new_page()
            if self.data['registered'] and not official_login_page(self.page.url):
                await self.page.goto('https://chatgpt.com', wait_until='domcontentloaded')
            if not self.data['registered']:
                await self.register()
            else:
                await self.guard_registered_onboarding()
                if not await self.registered_identity():
                    await self.job.manual('official_login_not_verified')
                    if not await self.registered_identity():
                        raise Stop('official_login_not_verified')
            if not self.data['passwordVerified']:
                await self.password()
            if not self.data['mfaVerified']:
                await self.mfa()
            await self.offer()
            self.job.event('complete', step='completed')
        except BaseException as exc:
            primary_error = exc
            raise
        finally:
            cleanup_error = None
            retained = self.registration_state.get(IDENTITY_RECOVERY)
            keep_readonly = (primary_error is not None and type(retained) is dict
                             and retained.get('context') is self.context
                             and retained.get('handler') is self.recovery_readonly)
            if keep_readonly and self.job.cancelled.is_set():
                # Builtin cancellation closes this exact browser immediately after
                # run returns. Drop RAM ownership, but keep writes blocked until close.
                self.registration_state.pop(IDENTITY_RECOVERY)
            cleanups = ([] if keep_readonly else [self.end_recovery]) + [
                lambda: clear_visible_secrets(self.page) if self.page else asyncio.sleep(0),
                lambda: self.context.unroute('**/*', self.guard)]
            for cleanup in cleanups:
                try:
                    await cleanup()
                except Exception as exc:
                    if cleanup_error is None:
                        cleanup_error = exc
                    self.job.registration_cleanup_error = session_failure(exc)['error_type']
            if primary_error is None and cleanup_error is not None:
                self.operation('browser_cleanup')
                raise cleanup_error
