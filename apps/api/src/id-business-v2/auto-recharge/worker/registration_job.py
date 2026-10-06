"""One authorized account per task in its original local browser profile."""
import asyncio
import json
import re
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

import bitbrowser_options
from checkout_core import Stop, unique_object
from registration_security import validate_birthdate, verification_link, totp_key, registration_age

JOB_ID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
STEPS = 'queued email email_code profile registered password password_verified mfa mfa_verified offer completed'.split()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class RegistrationJob:
    def __init__(self, payload, origin, client_type, *, builtin=False):
        allowed = {'id', 'mode', 'attempt', 'agentToken', 'callbackUrl', 'windowName', 'email',
                   'password', 'displayName', 'birthDate', 'totpSecret', 'browserProfileId',
                   'registered', 'passwordVerified', 'mfaVerified', 'step',
                   'proxy' if builtin else 'bitBrowser'}
        if (not isinstance(payload, dict) or set(payload) - {'registrationAge'} != allowed
                or payload.get('mode') != 'registration'):
            raise Stop('invalid_registration_payload')
        parsed = urlsplit(payload['callbackUrl'])
        callback_origin = f'{parsed.scheme}://{parsed.netloc}'
        if (callback_origin != origin or parsed.scheme not in {'https', 'http'}
                or (not builtin and parsed.scheme == 'http' and parsed.hostname not in {'localhost', '127.0.0.1'})
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path != f"/api/id-business-v2/auto-registration/local/{payload['id']}"):
            raise Stop('invalid_registration_callback')
        if (not JOB_ID.fullmatch(str(payload['id'])) or type(payload['attempt']) is not int
                or payload['attempt'] < 1 or not re.fullmatch('[a-f0-9]{64}', str(payload['agentToken']))
                or not isinstance(payload['email'], str) or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', payload['email'])
                or not isinstance(payload['password'], str) or not 8 <= len(payload['password']) <= 1024
                or not isinstance(payload['displayName'], str) or not 1 <= len(payload['displayName']) <= 120
                or payload['step'] not in STEPS
                or any(type(payload[key]) is not bool for key in ('registered', 'passwordVerified', 'mfaVerified'))
                or (payload['browserProfileId'] is not None and not re.fullmatch('[A-Za-z0-9_-]{8,100}', str(payload['browserProfileId'])))
                or not isinstance(payload['windowName'], str) or len(payload['windowName']) > 100):
            raise Stop('invalid_registration_payload')
        validate_birthdate(payload['birthDate'])
        if 'registrationAge' in payload:
            registration_age(payload['registrationAge'], payload['birthDate'])
        if payload['totpSecret']:
            totp_key(payload['totpSecret'])
        if builtin:
            if not isinstance(payload['proxy'], dict):
                raise Stop('server_proxy_invalid')
            self.settings = dict(payload['proxy'])
        else:
            options = bitbrowser_options.validate_browser_settings(payload['bitBrowser'])
            self.settings = {**payload['bitBrowser'], 'browserOptions': options}
        self.payload = dict(payload)
        self.id, self.attempt = payload['id'], payload['attempt']
        self.step = payload['step']
        self.client_type = client_type
        self.done = False
        self.waiting_for_user = False
        self.cancelled = threading.Event()
        self.resume_event = threading.Event()
        self.code_event = threading.Event()
        self.code_lock = threading.Lock()
        self.pending_code = None
        self.awaiting_code = False
        self.manual_reason = None
        self.deadline = time.monotonic() + 43 * 60

    def check(self):
        if self.cancelled.is_set():
            raise Stop('operation_cancelled')
        if time.monotonic() >= self.deadline:
            raise Stop(self.manual_reason if self.waiting_for_user and self.manual_reason
                       else 'mailbox_timeout')

    def event(self, event_type, **data):
        if event_type != 'partial':
            self.check()
        requested = data.pop('step', self.step)
        if STEPS.index(requested) < STEPS.index(self.step):
            requested = self.step
        body = {'type': event_type, 'attempt': self.attempt, 'step': requested, **data}
        request = Request(self.payload['callbackUrl'], data=json.dumps(body).encode(), method='POST',
                          headers={'Content-Type': 'application/json', 'X-Registration-Task': self.payload['agentToken']})
        try:
            with build_opener(NoRedirect).open(request, timeout=10) as response:
                result = json.loads(response.read(180000), object_pairs_hook=unique_object)
            if result.get('success') is not True or not isinstance(result.get('data'), dict):
                raise ValueError()
            self.step = result['data']['step']
        except Exception:
            raise Stop('durable_state_unavailable') from None

    def prepare_mail(self, step, *, new_request=False):
        if type(new_request) is not bool:
            raise Stop('invalid_registration_payload')
        with self.code_lock:
            self.pending_code = None
            self.code_event.clear()
            self.awaiting_code = True
            self.step = step
        self.event('waiting_email', step=step, newMailRequest=new_request)

    def signal_code(self, code, attempt=None, step=None, mail_id=None):
        self.check()
        with self.code_lock:
            if (getattr(self, 'event_mail_delivery', False)
                    and attempt == self.attempt and step == self.step and mail_id):
                if self.pending_code == (code, mail_id):
                    return
                if not self.awaiting_code and getattr(self, 'last_delivered_mail_id', None) == mail_id:
                    return
            if (not self.awaiting_code or self.pending_code is not None
                    or attempt != self.attempt or step != self.step
                    or not isinstance(code, str) or len(code) > 8192
                    or not (re.fullmatch(r'\d{6,8}', code) or verification_link(code))
                    or (mail_id is not None and (not isinstance(mail_id, str) or len(mail_id) > 191))):
                raise Stop('invalid_login_code')
            self.pending_code = (code, mail_id)
            self.code_event.set()

    async def wait_code(self):
        while True:
            self.check()
            with self.code_lock:
                if self.pending_code:
                    code, mail_id = self.pending_code
                    self.pending_code = None
                    self.awaiting_code = False
                    if mail_id:
                        self.event('mail_accepted', mailId=mail_id)
                    else:
                        self.event('progress')
                    return code
            await asyncio.sleep(.5)

    async def manual(self, reason='verification_required', *, can_resume=None):
        self.check()
        self.resume_event.clear()
        self.waiting_for_user = True
        self.manual_reason = reason
        try:
            self.event('waiting_user', reason=reason)
            while not self.resume_event.is_set():
                self.check()
                if can_resume is not None:
                    # Read-only observation may confirm the original page can continue.
                    ready = await can_resume()
                    self.check()
                    if ready is True:
                        break
                await asyncio.sleep(.5)
        finally:
            self.waiting_for_user = False
            self.manual_reason = None
        self.event('progress')

    def signal_resume(self, credentials=None):
        if not self.waiting_for_user or self.done:
            raise Stop('verification_not_waiting')
        if credentials is not None:
            if not isinstance(credentials, dict) or set(credentials) != {'attempt', 'password', 'totpSecret'} or credentials['attempt'] != self.attempt:
                raise Stop('invalid_registration_payload')
            if credentials['password']:
                password = credentials['password']
                if not isinstance(password, str) or not 8 <= len(password) <= 1024:
                    raise Stop('invalid_registration_payload')
                self.payload['password'] = password
            if not self.payload['mfaVerified'] and credentials['totpSecret']:
                self.payload['totpSecret'] = totp_key(credentials['totpSecret'])
        self.resume_event.set()

    def signal_cancel(self):
        self.cancelled.set()

    async def execute(self):
        from playwright.async_api import async_playwright
        from registration_browser import RegistrationBrowser
        client = self.client_type(self.settings['localApiUrl'], self.settings['localApiToken'])
        try:
            profile_id = self.payload['browserProfileId']
            if not profile_id:
                profile_id = client.create_profile(self.settings, self.payload['windowName'])
                self.event('progress', browserProfileId=profile_id)
                self.payload['browserProfileId'] = profile_id
            endpoint = client.open_profile(profile_id)
            # CDP must remain on the local computer.
            endpoint_url = urlsplit(endpoint)
            if endpoint_url.hostname not in {'localhost', '127.0.0.1'} or not endpoint_url.port:
                raise Stop('bitbrowser_debug_endpoint_missing')
            async with async_playwright() as driver:
                browser = await driver.chromium.connect_over_cdp(endpoint)
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                flow = RegistrationBrowser(self, context)
                await flow.run()
                # Never close/delete the profile, which is the task's recovery point.
        finally:
            client.token = ''

    def run(self):
        try:
            asyncio.run(self.execute())
        except Exception as exc:
            reason = exc.report.get('reason') if isinstance(exc, Stop) else 'local_execution_failed'
            try:
                # Cancellation is revoked by the authenticated web action, not a late callback.
                if not self.cancelled.is_set():
                    self.event('partial', reason=reason if re.fullmatch('[a-z_]+', str(reason)) else 'local_execution_failed')
            except Exception:
                pass
        finally:
            self.done = True
            self.awaiting_code = False
            self.pending_code = None
            self.payload.clear()
            self.settings.clear()
