"""系统内置 Camoufox 注册；代理和任务授权只从私网 API 接收。"""
import asyncio
import json
import logging
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener

from checkout_core import Stop, unique_object
from registration_job import RegistrationJob, NoRedirect
import server_proxy
import fingerprint_runtime
from browser_session import session_failure, RETRYABLE_NETWORK_CODES


class BuiltinProfiles:
    """仅保留一个原窗口，凭据与 Cookie 不落盘。重启后不伪造原窗口。"""
    def __init__(self):
        self.profile = None
    async def open(self, runtime, job):
        original = job.payload['browserProfileId']
        if original:
            if (not self.profile or self.profile['id'] != original or
                    self.profile['job_id'] != job.id or not self.profile['browser'].is_connected()):
                raise Stop('builtin_profile_missing')
            return self.profile
        if self.profile:
            raise Stop('builtin_original_window_pending')
        await runtime._discard()
        prepared = await server_proxy.prepare_browser(
            job.settings, lambda proxy: fingerprint_runtime.launch_fingerprint_browser(runtime.playwright, proxy=proxy),
            expected_country=job.expected_country, target_url='https://chatgpt.com/auth/login',
            cancelled=job.cancelled.is_set,
            progress=lambda stage, **details: job.event('progress', reason=stage))
        browser, context, proxy = prepared['browser'], prepared['context'], prepared['proxy']
        options = dict(service_workers='block', accept_downloads=False)
        self.profile = {'id': None, 'job_id': job.id, 'context': context,
                        'options': options, 'proxy': proxy, 'browser': browser}
        try:
            profile_id = 'reg_' + await fingerprint_runtime.fingerprint_signature(context)
            self.profile['id'] = profile_id
            job.event('progress', browserProfileId=profile_id, reason='proxy_ready')
            job.payload['browserProfileId'] = profile_id
            return self.profile
        except Exception:
            await self.close(job.id)
            raise

    async def close(self, job_id):
        if self.profile and self.profile['job_id'] == job_id:
            profile = self.profile
            try:
                closed = await fingerprint_runtime.close_fingerprint_resource(profile['browser'])
            except Exception:
                raise Stop('fingerprint_cleanup_failed') from None
            if not closed:
                raise Stop('fingerprint_cleanup_failed')
            self.profile = None
            profile['proxy'].clear()
            profile.clear()


PROFILES = BuiltinProfiles()
DISPATCH_REASONS = frozenset({'worker_busy', 'builtin_original_window_pending',
                              'builtin_profile_missing', 'invalid_registration_payload',
                              'fingerprint_cleanup_failed'})


def dispatch_rejection(error):
    """只把注册受控原因传给 API，不传异常文本或执行资料。"""
    reason = error.report.get('reason') if isinstance(error, Stop) else None
    if reason not in DISPATCH_REASONS:
        return None
    return {'ok': False, 'reason': reason}


class RegistrationServerJob(RegistrationJob):
    event_mail_delivery = True
    def __init__(self, job_id, body, callback_base, runtime):
        expected = {'id', 'mode', 'attempt', 'agentToken', 'email', 'password', 'displayName',
                    'birthDate', 'totpSecret', 'browserProfileId', 'step', 'registered',
                    'passwordVerified', 'mfaVerified', 'proxy', 'expectedCountry'}
        if (not isinstance(body, dict) or set(body) - {'registrationAge'} != expected or body['id'] != job_id or
                not re.fullmatch('[A-Z]{2}', str(body['expectedCountry']))):
            raise Stop('invalid_registration_payload')
        self.expected_country = body['expectedCountry']
        parsed = urlsplit(callback_base)
        payload = {key: value for key, value in body.items() if key != 'expectedCountry'}
        payload.update(callbackUrl=f'{callback_base}/{job_id}', windowName=f'注册-{job_id[:8]}')
        super().__init__(payload, f'{parsed.scheme}://{parsed.netloc}', None, builtin=True)
        self.runtime = runtime
        self.profile = None
        self.pending_complete = None

    def event(self, event_type, **data):
        if event_type == 'complete':
            self.pending_complete = data
            return
        super().event(event_type, **data)

    async def new_verification_context(self):
        # 密码/MFA 核验使用相同代理与环境，且不继承已登录 Cookie。
        return await self.profile['browser'].new_context(
            proxy=self.profile['proxy'], **self.profile['options'])

    def read_mail(self):
        request = Request(self.payload['callbackUrl'] + '/code',
                          data=json.dumps({'attempt': self.attempt}).encode(), method='POST',
                          headers={'Content-Type': 'application/json',
                                   'X-Registration-Task': self.payload['agentToken']})
        try:
            with build_opener(NoRedirect).open(request, timeout=10) as response:
                result = json.loads(response.read(20000), object_pairs_hook=unique_object)
            value = result.get('data') if result.get('success') is True else None
            if not isinstance(value, dict):
                raise Stop('durable_state_unavailable')
            return value
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise Stop('registration_authorization_expired') from None
            return None
        except (ValueError, OSError):
            return None

    async def wait_code(self):
        while True:
            self.check()
            with self.code_lock:
                pending = self.pending_code
                if pending:
                    self.pending_code = None
                    self.awaiting_code = False
            if pending:
                code, mail_id = pending
                self.last_delivered_mail_id = mail_id
                self.event('mail_accepted', mailId=mail_id) if mail_id else self.event('progress')
                return code
            # Wait for a private API delivery; timeout only checks cancellation/lease.
            await asyncio.to_thread(self.code_event.wait, .5)

    def cancel(self):
        self.signal_cancel()
        if self.done and self.runtime.started:
            self.runtime.run_registration(lambda: PROFILES.close(self.id))

    async def execute_builtin(self):
        from registration_browser import RegistrationBrowser
        self.profile = await PROFILES.open(self.runtime, self)
        # Only a submission fact survives attempts in the exact retained window.
        self.registration_state = self.profile.setdefault('registration_state', {})
        flow = RegistrationBrowser(self, self.profile['context'])
        await flow.run()
        await PROFILES.close(self.id)
        if self.pending_complete is not None:
            super().event('complete', **self.pending_complete)
            self.pending_complete = None

    def run(self):
        try:
            self.runtime.run_registration(self.execute_builtin)
        except Exception as exc:
            details = session_failure(exc)
            observation = getattr(self, 'registration_observation_error', {})
            code = details.get('browser_error_code', 'none')
            if code not in RETRYABLE_NETWORK_CODES:
                code = 'none'
            observation_reason = observation.get('reason', 'none')
            if observation_reason not in {'session_network_error', 'session_load_timeout', 'registration_page_changing'}:
                observation_reason = 'none'
            logging.getLogger('registration').warning(
                'Registration stopped job=%s attempt=%s step=%s operation=%s error_type=%s browser_error_code=%s observation_reason=%s cleanup_error_type=%s',
                self.id, self.attempt, self.step, getattr(self, 'registration_operation', 'browser_prepare'),
                'Stop' if isinstance(exc, Stop) else details['error_type'], code, observation_reason,
                getattr(self, 'registration_cleanup_error', 'none'))
            reason = exc.report.get('reason') if isinstance(exc, Stop) else 'builtin_execution_failed'
            if not self.cancelled.is_set():
                try:
                    self.event('partial', reason=reason if re.fullmatch('[a-z_]+', str(reason)) else 'builtin_execution_failed')
                except Exception:
                    pass
        finally:
            if self.cancelled.is_set():
                try:
                    self.runtime.run_registration(lambda: PROFILES.close(self.id))
                except Exception:
                    pass
            self.done = True
            self.awaiting_code = False
            self.pending_code = None
            self.payload.clear()
            self.settings.clear()


def handle_request(handler, body, callback_base, runtime):
    parts = handler.path.strip('/').split('/')
    if len(parts) not in {3, 4} or parts[:2] != ['registration', 'jobs']:
        raise ValueError()
    job_id = parts[2]
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', job_id):
        raise ValueError()
    job = handler.job
    if len(parts) == 3:
        if isinstance(job, RegistrationServerJob) and job.id == job_id and job.attempt == body.get('attempt'):
            return job  # 已结束的尝试也只返回收据，不重复注册。
        if job and not job.done:
            raise Stop('worker_busy')
        if PROFILES.profile:
            if (PROFILES.profile['job_id'] != job_id or not PROFILES.profile['id'] or
                    body.get('browserProfileId') != PROFILES.profile['id']):
                raise Stop('builtin_original_window_pending')
        elif body.get('browserProfileId'):
            raise Stop('builtin_profile_missing')
        return RegistrationServerJob(job_id, body, callback_base, runtime)
    if not isinstance(job, RegistrationServerJob) or job.id != job_id or body.get('attempt') != job.attempt:
        raise ValueError()
    if parts[3] == 'cancel' and set(body) == {'attempt'}:
        job.cancel()
    elif parts[3] == 'resume':
        job.signal_resume(body)
    elif parts[3] == 'code' and set(body) in ({'attempt', 'step', 'code'}, {'attempt', 'step', 'code', 'mailId'}):
        job.signal_code(body['code'], body['attempt'], body['step'], body.get('mailId'))
    else:
        raise ValueError()
    return job
