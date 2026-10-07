"""One authorized account per task in its original local browser profile."""
import asyncio
from http.client import HTTPResponse
import io
import json
import logging
import re
from socket import timeout as SocketTimeout
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

import bitbrowser_options
from checkout_core import Stop, unique_object
from registration_security import validate_birthdate, verification_link, totp_key, registration_age

JOB_ID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
STEPS = 'queued email email_code profile registered password password_verified mfa mfa_verified offer completed'.split()
CALLBACK_EVENTS = {'progress', 'mail_accepted', 'waiting_email', 'waiting_user', 'registered',
                   'password_verified', 'totp_pending', 'mfa_verified', 'offer', 'complete',
                   'partial', 'cancelled'}
CALLBACK_ERROR_TYPES = {'HTTPError', 'URLError', 'TimeoutError', 'OSError', 'ConnectionResetError',
                        'ConnectionRefusedError', 'BrokenPipeError', 'JSONDecodeError',
                        'UnicodeDecodeError', 'ValueError', 'TypeError', 'KeyError', 'AttributeError'}
CALLBACK_FAILURE_KINDS = {'HTTP_STATUS', 'TIMEOUT', 'TRANSPORT', 'INVALID_JSON', 'INVALID_RECEIPT'}
CALLBACK_CONFLICT_MESSAGES = {
    '浏览器指纹与已有任务重复，请重新生成': 'fingerprint_duplicate',
    '数据已被其他操作创建，请刷新后核对': 'unique_constraint',
    '数据已被其他操作修改，请刷新后重试': 'write_conflict',
    '回执步骤已过期': 'stale_step',
    '必须继续原浏览器窗口': 'window_mismatch',
    '尚未核实官网注册完成': 'registration_unverified',
    '密码配置尚未完成': 'password_unverified',
    '双重验证尚未完成': 'mfa_unverified',
    '尚未安全保存验证器配置': 'mfa_unverified',
}
CALLBACK_CONFLICT_KINDS = frozenset(CALLBACK_CONFLICT_MESSAGES.values()) | {'unknown'}
CALLBACK_PREPARE_REASONS = {'proxy_resolving', 'proxy_verifying', 'proxy_retrying', 'proxy_ready'}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class PreparationFingerprintDuplicate(Stop):
    """Only a confirmed, unbound preparation conflict can replace an environment."""
    def __init__(self, job_id, attempt, profile_id):
        super().__init__('durable_state_unavailable')
        self.job_id, self.attempt, self.profile_id = job_id, attempt, profile_id


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
        self.registration_callback_error = None
        self.registration_callback_body_error = None
        self.registration_callback_cleanup_error = None
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
        started = time.monotonic()
        callback_deadline = started + 10
        if event_type != 'partial':
            callback_deadline = min(callback_deadline, self.deadline)
            prepare_deadline = getattr(self, '_profile_prepare_deadline', None)
            if type(prepare_deadline) in {int, float}:
                callback_deadline = min(callback_deadline, prepare_deadline)
        for callback_attempt in range(2):
            failure_kind = 'TRANSPORT'
            read_error, response_closing = None, False
            try:
                opener = build_opener(NoRedirect)
                timeout = min(10, callback_deadline - time.monotonic())
                if timeout <= 0:
                    raise TimeoutError()
                with opener.open(request, timeout=timeout) as response:
                    try:
                        raw = self._callback_read(response, 180000, callback_deadline)
                        if time.monotonic() >= callback_deadline:
                            raise TimeoutError()
                        failure_kind = 'INVALID_JSON'
                        result = json.loads(raw, object_pairs_hook=unique_object)
                    except Exception as error:
                        read_error = error
                        self._callback_failure(event_type, requested, error, failure_kind, started)
                        raise
                    finally:
                        response_closing = True
                        if read_error is None:
                            failure_kind = 'TRANSPORT'
                response_closing = False
                failure_kind = 'INVALID_RECEIPT'
                if result.get('success') is not True or not isinstance(result.get('data'), dict):
                    raise ValueError()
                if time.monotonic() >= callback_deadline:
                    raise TimeoutError()
                self.step = result['data']['step']
                return
            except Exception as error:
                if response_closing and (read_error is None or error is not read_error):
                    self._callback_auxiliary_failure(error)
                conflict_kind, closed = ('unknown', False)
                if isinstance(error, HTTPError):
                    conflict_kind, closed = self._callback_conflict(error, callback_deadline)
                self._callback_failure(event_type, requested, error, failure_kind, started,
                                       conflict_kind=conflict_kind, log_current=callback_attempt == 1)
                if (event_type == 'progress' and isinstance(error, HTTPError) and type(error.code) is int and error.code == 409
                        and closed and conflict_kind == 'fingerprint_duplicate'
                        and body.get('reason') == 'proxy_ready'
                        and type(body.get('browserProfileId')) is str
                        and re.fullmatch(r'reg_[a-f0-9]{64}', body['browserProfileId'])
                        and self._callback_prepare_retry(body)):
                    raise PreparationFingerprintDuplicate(self.id, self.attempt, body['browserProfileId']) from None
                # The current response decides retry; the saved first cause is diagnostic only.
                if (callback_attempt == 0 and event_type == 'progress' and closed and conflict_kind == 'write_conflict'
                        and self._callback_prepare_retry(body)):
                    self.check()
                    if time.monotonic() < callback_deadline:
                        continue
                raise Stop('durable_state_unavailable') from None

    def _callback_read(self, response, limit, deadline):
        if not isinstance(response, HTTPResponse):
            return response.read(limit)
        parts, size = [], 0
        while size < limit:
            self._callback_socket_budget(response, deadline)
            if time.monotonic() >= deadline:
                raise TimeoutError()
            chunk = response.read1(limit - size)
            if time.monotonic() >= deadline:
                raise TimeoutError()
            if not chunk:
                break
            parts.append(chunk)
            size += len(chunk)
        return b''.join(parts)

    def _callback_socket_budget(self, response, deadline):
        if isinstance(response, HTTPResponse) and response.fp is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            socket = getattr(getattr(response.fp, 'raw', None), '_sock', None)
            if socket is None:
                raise ValueError()
            socket.settimeout(remaining)

    def _callback_conflict(self, error, deadline):
        conflict_kind, closed = 'unknown', True
        try:
            conflict_kind = self._callback_read_conflict(error, deadline)
        except Exception as error_body:
            self._callback_auxiliary_failure(error_body, body_read=True)
        finally:
            try:
                if error.fp is not None:
                    error.close()
            except Exception as cleanup:
                closed = False
                self._callback_auxiliary_failure(cleanup)
        return conflict_kind, closed

    def _callback_read_conflict(self, error, deadline):
        if type(error.code) is not int or error.code != 409:
            return 'unknown'
        if not isinstance(error.fp, (HTTPResponse, io.BytesIO)):
            return 'unknown'
        if time.monotonic() >= deadline:
            return 'unknown'
        raw = self._callback_read(error.fp, 2048, deadline)
        if type(raw) is not bytes or len(raw) >= 2048 or time.monotonic() >= deadline:
            return 'unknown'
        value = json.loads(raw, object_pairs_hook=unique_object,
                           parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
        if (type(value) is not dict or set(value) != {
                'success', 'errorCode', 'message', 'requestId', 'retryable', 'timestamp'}
                or value['success'] is not False or value['errorCode'] != 'CONFLICT'
                or value['retryable'] is not False or type(value['message']) is not str
                or type(value['requestId']) is not str
                or not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', value['requestId'])
                or type(value['timestamp']) is not str
                or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value['timestamp'])):
            return 'unknown'
        return CALLBACK_CONFLICT_MESSAGES.get(value['message'], 'unknown')

    def _callback_prepare_retry(self, body):
        profile = body.get('browserProfileId')
        reason = body.get('reason')
        return (body['type'] == 'progress' and body['step'] == self.step == self.payload['step'] == 'queued'
                and type(body.get('attempt')) is int and body['attempt'] == self.attempt
                and set(body) <= {'type', 'attempt', 'step', 'reason', 'browserProfileId'}
                and type(reason) is str and reason in CALLBACK_PREPARE_REASONS
                and (profile is None or type(profile) is str and re.fullmatch(r'reg_[a-f0-9]{64}', profile))
                and self.payload['browserProfileId'] is None
                and all(self.payload[key] is False for key in ('registered', 'passwordVerified', 'mfaVerified'))
                and not hasattr(self, 'registration_state') and not hasattr(self, 'registration_operation')
                and not self.awaiting_code and self.pending_code is None and not self.waiting_for_user
                and not getattr(self, 'last_delivered_mail_id', None))

    def _callback_auxiliary_failure(self, error, *, body_read=False):
        slot = 'registration_callback_body_error' if body_read else 'registration_callback_cleanup_error'
        if getattr(self, slot) is None:
            kind = 'TimeoutError' if isinstance(error, SocketTimeout) else type(error).__name__
            setattr(self, slot, kind if kind in CALLBACK_ERROR_TYPES else 'UnexpectedError')
            logging.getLogger('registration').warning(
                'Registration callback %s failed error_type=%s',
                'body_read' if body_read else 'cleanup', getattr(self, slot))

    def _callback_failure(self, event_type, requested, error, failure_kind, started, *,
                          conflict_kind='unknown', log_current=False):
        if self.registration_callback_error is not None and not log_current:
            return
        http_status = None
        if isinstance(error, HTTPError):
            failure_kind = 'HTTP_STATUS'
            http_status = error.code if type(error.code) is int and 100 <= error.code <= 599 else None
        elif isinstance(error, (TimeoutError, SocketTimeout)) or (isinstance(error, URLError)
                                                and isinstance(error.reason, (TimeoutError, SocketTimeout))):
            failure_kind = 'TIMEOUT'
        kind = 'TimeoutError' if isinstance(error, SocketTimeout) else type(error).__name__
        record = {
            'job_id': self.id if isinstance(self.id, str) and JOB_ID.fullmatch(self.id) else 'unknown',
            'attempt': self.attempt if type(self.attempt) is int and self.attempt > 0 else 0,
            'event_type': event_type if isinstance(event_type, str) and event_type in CALLBACK_EVENTS else 'unknown',
            'step': requested if requested in STEPS else 'unknown',
            'failure_kind': failure_kind if failure_kind in CALLBACK_FAILURE_KINDS else 'TRANSPORT',
            'http_status': http_status,
            'error_type': kind if kind in CALLBACK_ERROR_TYPES else 'UnexpectedError',
            'conflict_kind': conflict_kind if conflict_kind in CALLBACK_CONFLICT_KINDS else 'unknown',
            'elapsed_ms': max(0, int((time.monotonic() - started) * 1000))
        }
        if self.registration_callback_error is None:
            self.registration_callback_error = record
        logging.getLogger('registration').warning(
            'Registration callback failed job=%s attempt=%s event_type=%s step=%s failure_kind=%s http_status=%s error_type=%s conflict_kind=%s elapsed_ms=%s',
            record['job_id'], record['attempt'], record['event_type'], record['step'],
            record['failure_kind'], record['http_status'], record['error_type'], record['conflict_kind'], record['elapsed_ms'])

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
