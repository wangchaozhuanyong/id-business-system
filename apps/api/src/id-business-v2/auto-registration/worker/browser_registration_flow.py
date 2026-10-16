"""Visible official registration only; challenges stay with the person in this window."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone
import ipaddress
import math
import re
import time
from urllib.parse import urljoin, urlsplit


REASONS = frozenset({
    'invalid_payload', 'callback_rejected', 'callback_unavailable', 'callback_invalid',
    'configuration_invalid', 'bitbrowser_unavailable', 'profile_unverified',
    'debug_endpoint_invalid', 'browser_unavailable', 'official_source_invalid',
    'form_ambiguous', 'form_action_invalid', 'registration_timeout',
    'identity_mismatch', 'identity_unverified', 'creation_unverified',
    'existing_account_requires_review', 'code_invalid', 'duplicate_submission',
    'password_ack_required', 'browser_closed', 'operation_failed', 'job_conflict',
    'origin_rejected', 'host_rejected', 'body_invalid', 'connector_busy',
    'official_rejected',
})
TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'
SIGNUP_ENTRY_TEXT = re.compile(r'^(?:Sign up|Sign up for free|Create account|Create an account|注册|免费注册|创建账号)$', re.I)


def parse_exit_trace(body):
    if (not isinstance(body, str) or len(body.encode('utf-8')) > 16_384
            or '<' in body or '>' in body):
        return {}
    selected = {}
    for line in body.splitlines():
        key, separator, value = line.partition('=')
        if key in {'ip', 'loc'}:
            if not separator or key in selected:
                return {}
            selected[key] = value
    if (set(selected) != {'ip', 'loc'} or '%' in selected['ip']
            or not re.fullmatch(r'[A-Z]{2}', selected['loc'])):
        return {}
    try:
        address = str(ipaddress.ip_address(selected['ip']))
    except ValueError:
        return {}
    return {'attemptIp': address, 'attemptCountry': selected['loc'],
            'observationSource': 'cloudflare_trace'}


async def observe_browser_exit(page):
    """A browser navigation uses this profile's proxy; never an APIRequestContext/direct socket."""
    async def trace_only(route):
        request = route.request
        if (request.method == 'GET' and request.url == TRACE_URL
                and request.redirected_from is None):
            await route.continue_()
        else:
            await route.abort()

    try:
        await page.route('**/*', trace_only)
        response = await page.goto(TRACE_URL, wait_until='domcontentloaded', timeout=15_000)
        if (response is None or response.status != 200 or response.url != TRACE_URL
                or page.url != TRACE_URL or response.request.redirected_from is not None):
            return {}
        headers = await response.all_headers()
        if headers.get('content-type', '').split(';')[0].strip().lower() != 'text/plain':
            return {}
        body = await page.locator('body').inner_text(timeout=5000)
        return parse_exit_trace(body)
    except Exception:
        return {}
    finally:
        try:
            await page.unroute('**/*', trace_only)
        except Exception:
            pass


async def official_session_cookie(context):
    """Return only the existing contract's exact official session cookie, never a cookie jar."""
    try:
        cookies = await context.cookies(['https://chatgpt.com'])
    except Exception:
        raise Stop('identity_unverified') from None
    if not isinstance(cookies, list):
        raise Stop('identity_unverified')
    selected = [cookie for cookie in cookies if isinstance(cookie, dict)
                and cookie.get('name') == '__Secure-next-auth.session-token'
                and cookie.get('domain') in {'chatgpt.com', '.chatgpt.com'}]
    if not selected:
        return None
    if len(selected) != 1:
        raise Stop('identity_unverified')
    cookie = selected[0]
    value, expiry = cookie.get('value'), cookie.get('expires')
    if (cookie.get('secure') is not True or not isinstance(value, str)
            or not 1 <= len(value) <= 32_768
            or any(ord(char) < 33 or ord(char) > 126 or char in '\",;\\' for char in value)
            or type(expiry) not in {int, float} or not math.isfinite(expiry)
            or (expiry != -1 and expiry <= time.time())):
        raise Stop('identity_unverified')
    return value


class Stop(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else 'operation_failed'
        super().__init__(self.reason)


def official(url):
    try:
        p = urlsplit(url)
        return (p.scheme == 'https' and p.hostname in {'chatgpt.com', 'auth.openai.com'}
                and p.port in {None, 443} and not p.username and not p.password)
    except (TypeError, ValueError):
        return False


async def unique_visible(scope, selector):
    matches = scope.locator(selector)
    if await matches.count() > 40:
        raise Stop('form_ambiguous')
    visible = []
    for index in range(await matches.count()):
        item = matches.nth(index)
        if await item.is_visible():
            visible.append(item)
    if len(visible) > 1:
        raise Stop('form_ambiguous')
    return visible[0] if visible else None


async def submit_for(page, field):
    if not official(page.url):
        raise Stop('official_source_invalid')
    form = field.locator('xpath=ancestor::form[1]')
    if await form.count() != 1:
        raise Stop('form_ambiguous')
    action = await form.get_attribute('action')
    if action and not official(urljoin(page.url, action)):
        raise Stop('form_action_invalid')
    button = await unique_visible(form, 'button[type="submit"], input[type="submit"]')
    if button is None or not await button.is_enabled():
        raise Stop('form_ambiguous')
    return button


def profile_details(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {'name', 'birthDate'}:
        raise Stop('configuration_invalid')
    name, birthday = value.get('name'), value.get('birthDate')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        return None
    if not isinstance(birthday, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', birthday):
        return None
    try:
        if not date(1900, 1, 1) <= date.fromisoformat(birthday) < date.today():
            return None
    except ValueError:
        return None
    return {'name': name, 'birthDate': birthday}


class RegistrationFlow:
    def __init__(self, claim, callback, *, timeout=900, clock=time.monotonic):
        self.claim, self.callback = claim, callback
        self.timeout, self.clock = timeout, clock
        self.sequence = 0
        self.password_ack = False
        self.side_effect_possible = False
        self.creation_status = None
        self.creation_requests = 0
        self.critical_requests = {}
        self.observation_failed = False
        self.profile_id = None
        self.official_failure = None
        self.signup_request_armed = False
        self.last_event = None
        self.request_rejected_reason = None
        self.identity_user_present = False
        self.identity_anonymous_verified = False
        self._observations = set()

    async def event(self, event, **facts):
        if self.official_failure:
            raise Stop('official_rejected')
        self.sequence += 1
        body = {'event': event, 'sequence': self.sequence, 'profileId': self.profile_id, **facts}
        data = await asyncio.to_thread(self.callback.send, 'event', body)
        if data.get('accepted') is not True:
            raise Stop('callback_rejected')
        self.last_event = body

    async def current_ack(self):
        """Replaying the exact accepted event is idempotent and rechecks cancellation/ownership."""
        if self.last_event is None:
            raise Stop('callback_rejected')
        reply = await asyncio.to_thread(self.callback.send, 'event', dict(self.last_event))
        if reply.get('accepted') is not True:
            raise Stop('callback_rejected')

    async def guard_request(self, route):
        request = route.request
        p = urlsplit(request.url)
        method = request.method.upper()
        # An official page cannot navigate this top-level registration window to a lookalike.
        # Challenge subframes and normal official scripts remain under the site's own control.
        if request.is_navigation_request() and request.frame.parent_frame is None and not official(request.url):
            await route.abort()
            self.observation_failed = True
            return
        # Registration never performs a subscription or payment operation.
        if method not in {'GET', 'HEAD', 'OPTIONS'} and (
                p.hostname == 'stripe.com' or (p.hostname or '').endswith('.stripe.com')
                or p.path.startswith('/backend-api/payments/')):
            await route.abort()
            self.observation_failed = True
            return
        critical = {'/api/accounts/user/register': 'password',
                    '/api/accounts/create_account': 'creation',
                    '/api/accounts/email-otp/validate': 'email_code'}
        if method == 'POST' and p.path in critical and not (
                official(request.url) and p.hostname == 'auth.openai.com'):
            self.observation_failed = True
            await route.abort()
            return
        kind = critical.get(p.path) if p.hostname == 'auth.openai.com' else None
        if kind and method == 'POST':
            if not official(request.url) or (kind == 'password' and not self.password_ack):
                self.observation_failed = True
                await route.abort()
                return
            try:
                await self.current_ack()
            except Stop as exc:
                self.request_rejected_reason = exc.reason
                self.observation_failed = True
                await route.abort()
                return
            self.critical_requests[kind] = self.critical_requests.get(kind, 0) + 1
            if self.critical_requests[kind] > 1:
                self.observation_failed = True
                await route.abort()
                return
            self.side_effect_possible = True
            if kind == 'creation':
                self.creation_requests += 1
        await route.continue_()

    async def observe_creation(self, response, page):
        try:
            p = urlsplit(response.url)
            if (not official(response.url) or p.hostname != 'auth.openai.com'
                    or response.request.method != 'POST'
                    or response.frame != page.main_frame):
                return
            stages = {'/api/accounts/user/register': 'password',
                      '/api/accounts/email-otp/validate': 'verification_validate',
                      '/api/accounts/create_account': 'create_account'}
            if self.signup_request_armed:
                stages['/api/accounts/authorize/continue'] = 'signup'
            stage = stages.get(p.path)
            if stage and type(response.status) is int and 400 <= response.status <= 599:
                if self.official_failure is None:
                    self.official_failure = {'stage': stage, 'httpStatus': response.status}
                return
            if p.path != '/api/accounts/create_account':
                return
            if response.status not in {200, 201}:
                return
            body = await asyncio.wait_for(response.body(), timeout=10)
            if len(body) > 128_000:
                return
            import json
            data = json.loads(body)
            if not isinstance(data, dict) or data.get('error') or data.get('errors'):
                return
            self.creation_status = response.status
        except Exception:
            # A response that cannot be safely verified never becomes creation evidence.
            return

    async def identity(self, page):
        self.identity_anonymous_verified = False
        if not official(page.url) or urlsplit(page.url).hostname != 'chatgpt.com':
            return None
        try:
            data = await page.evaluate('''async () => {
                const r = await fetch('/api/auth/session', {credentials:'include',redirect:'error'});
                if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) return null;
                const value = await r.json();
                if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
                if (value.error || value.errors) return null;
                return {user: value.user, account: value.account, accessToken: value.accessToken};
            }''')
        except Exception:
            return None
        if not isinstance(data, dict) or data.get('error') or data.get('errors'):
            return None
        if data.get('user') is None:
            self.identity_anonymous_verified = True
            return None
        if not isinstance(data.get('user'), dict):
            return None
        user = data['user']
        self.identity_user_present = True
        if not isinstance(user.get('email'), str) or not user.get('id'):
            return None
        if user['email'].casefold() != self.claim['email'].casefold():
            raise Stop('identity_mismatch')
        if not isinstance(user['id'], str) or not re.fullmatch(r'[A-Za-z0-9_|:-]{1,191}', user['id']):
            raise Stop('identity_unverified')
        token = data.get('accessToken')
        if (not isinstance(token, str) or not 16 <= len(token) <= 32_000
                or any(ord(char) < 33 or ord(char) == 127 for char in token)):
            return None
        result = {'email': self.claim['email'], 'officialUserId': user['id'],
                  'creationObserved': True, 'creationStatus': self.creation_status,
                  'creationEvidence': {'pathKind': 'create_account',
                      'httpStatus': self.creation_status, 'noError': True, 'officialOrigin': True},
                  'session': {'accessToken': token}, 'profileId': self.profile_id}
        account = data.get('account')
        if (isinstance(account, dict) and isinstance(account.get('id'), str)
                and re.fullmatch(r'[A-Za-z0-9_|:-]{1,191}', account['id'])):
            result['officialAccountId'] = account['id']
        return result

    async def run(self, context, page, profile_id, *, attempt_observation=None):
        self.profile_id = profile_id
        await context.route('**/*', self.guard_request)

        def observed(response):
            task = asyncio.create_task(self.observe_creation(response, page))
            self._observations.add(task)
            task.add_done_callback(self._observations.discard)

        page.on('response', observed)
        deadline = self.clock() + self.timeout
        sent_email = sent_password = sent_code = sent_profile = False
        signup_entry = False
        after = datetime.now(timezone.utc).isoformat()
        last_identity = last_code = 0.0
        last_wait_event = 0.0
        await self.event('browser_opened', directConnection=self.claim.get('proxy') is None,
                         **(attempt_observation or {}))
        try:
            await page.goto('https://chatgpt.com/', wait_until='domcontentloaded', timeout=60_000)
            # A failed/HTML/challenged read does not prove this window is anonymous.
            while self.clock() < deadline:
                if page.is_closed():
                    raise Stop('browser_closed')
                if not official(page.url):
                    raise Stop('official_source_invalid')
                await self.identity(page)
                if self.identity_user_present:
                    raise Stop('existing_account_requires_review')
                if self.identity_anonymous_verified:
                    break
                if self.clock() - last_wait_event > 20:
                    await self.event('human_verification_required')
                    last_wait_event = self.clock()
                await asyncio.sleep(2)
            else:
                raise Stop('registration_timeout')
            await page.goto('https://chatgpt.com/auth/login', wait_until='domcontentloaded', timeout=60_000)
            while self.clock() < deadline:
                if page.is_closed():
                    raise Stop('browser_closed')
                if not official(page.url):
                    raise Stop('official_source_invalid')
                if self.official_failure:
                    raise Stop('official_rejected')
                if self.observation_failed:
                    raise Stop(self.request_rejected_reason or 'duplicate_submission')
                current = self.clock()
                if current - last_identity > 3:
                    last_identity = current
                    identity = await self.identity(page)
                    if identity:
                        if self._observations:
                            await asyncio.gather(*tuple(self._observations))
                        if self.creation_status not in {200, 201} or self.creation_requests != 1:
                            raise Stop('creation_unverified')
                        identity['creationStatus'] = self.creation_status
                        identity['creationEvidence']['httpStatus'] = self.creation_status
                        session_token = await official_session_cookie(context)
                        if session_token is not None:
                            identity['session']['sessionToken'] = session_token
                        await self.event('official_identity_observed')
                        result = await asyncio.to_thread(self.callback.send, 'result', identity)
                        if result.get('accepted') is not True:
                            raise Stop('callback_rejected')
                        return
                path = urlsplit(page.url).path
                signup_entry = signup_entry or path.startswith('/create-account')
                if not signup_entry:
                    links = page.get_by_role('link', name=SIGNUP_ENTRY_TEXT)
                    buttons = page.get_by_role('button', name=SIGNUP_ENTRY_TEXT)
                    candidates = []
                    for group in (links, buttons):
                        for index in range(await group.count()):
                            item = group.nth(index)
                            if await item.is_visible():
                                candidates.append(item)
                    if len(candidates) > 1:
                        raise Stop('form_ambiguous')
                    if candidates:
                        href = await candidates[0].get_attribute('href')
                        if href and not official(urljoin(page.url, href)):
                            raise Stop('form_action_invalid')
                        form = candidates[0].locator('xpath=ancestor::form[1]')
                        if await form.count() == 1:
                            action = await form.get_attribute('action')
                            if action and not official(urljoin(page.url, action)):
                                raise Stop('form_action_invalid')
                        await candidates[0].click(timeout=5000)
                        signup_entry = True
                        await asyncio.sleep(.5)
                        continue
                email = await unique_visible(page, 'input[type="email"], input[name="email"], input[name="username"]')
                if email and not sent_email and signup_entry:
                    button = await submit_for(page, email)
                    await self.event('email_submitting')
                    await email.fill(self.claim['email'])
                    self.signup_request_armed = True
                    after = datetime.now(timezone.utc).isoformat()
                    await button.click(timeout=5000)
                    sent_email = True
                    await asyncio.sleep(.5)
                    continue
                password = await unique_visible(page, 'input[type="password"]')
                if password and not sent_password and sent_email:
                    if not path.startswith('/create-account'):
                        raise Stop('existing_account_requires_review')
                    button = await submit_for(page, password)
                    await self.event('password_submitting')
                    self.password_ack = True
                    await password.fill(self.claim['password'])
                    # The persisted server ACK precedes this potentially creating action.
                    self.side_effect_possible = True
                    after = datetime.now(timezone.utc).isoformat()
                    await button.click(timeout=5000)
                    sent_password = True
                    await asyncio.sleep(.5)
                    continue
                code = await unique_visible(page, 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]')
                if code and not sent_code and sent_email and re.search(r'email|verify-email', path):
                    if current - last_code > 3:
                        last_code = current
                        if not self.last_event or self.last_event['event'] != 'email_code_required':
                            await self.event('email_code_required')
                        reply = await asyncio.to_thread(self.callback.send, 'code', {'after': after})
                        if 'code' not in reply:
                            raise Stop('callback_invalid')
                        value = reply.get('code')
                        if value is not None:
                            if not isinstance(value, str) or not re.fullmatch(r'\d{6}', value):
                                raise Stop('code_invalid')
                            expiry = reply.get('expiresAt')
                            if expiry:
                                try:
                                    stamp = datetime.fromisoformat(expiry.replace('Z', '+00:00'))
                                    if stamp.tzinfo is None or stamp.timestamp() <= time.time():
                                        raise ValueError()
                                except (TypeError, ValueError, OverflowError):
                                    raise Stop('code_invalid') from None
                            button = await submit_for(page, code)
                            await code.fill(value)
                            await button.click(timeout=5000)
                            sent_code = True
                            value = None
                    # Pending mail keeps its own phase. A generic manual-wait event here
                    # would make the server reject the next code poll as the wrong phase.
                    await asyncio.sleep(.5)
                    continue
                name = await unique_visible(page, 'input[name="name"], input[autocomplete="name"]')
                birthday = await unique_visible(page, 'input[type="date"], input[name="birthday"], input[name="birthdate"]')
                if name and not sent_profile:
                    details = profile_details(self.claim.get('profile'))
                    if details and birthday:
                        button = await submit_for(page, name)
                        await name.fill(details['name'])
                        await birthday.fill(details['birthDate'])
                        await button.click(timeout=5000)
                        sent_profile = True
                    elif current - last_wait_event > 20:
                        await self.event('profile_required')
                        last_wait_event = current
                elif current - last_wait_event > 20:
                    # Do not inspect/click challenge internals. The original window stays available.
                    await self.event('human_verification_required')
                    last_wait_event = current
                await asyncio.sleep(.5)
            raise Stop('registration_timeout')
        finally:
            page.remove_listener('response', observed)
            if self._observations:
                await asyncio.gather(*tuple(self._observations), return_exceptions=True)
            try:
                await context.unroute('**/*', self.guard_request)
            except Exception:
                pass
            # Never close the person's window or export its Cookie jar.
            if official(page.url) and not page.is_closed():
                for selector in ('input[type="password"]', 'input[autocomplete="one-time-code"]'):
                    try:
                        field = await unique_visible(page, selector)
                        if field:
                            await field.fill('')
                    except Exception:
                        pass
