import asyncio
from copy import deepcopy
from datetime import date
import io
import json
import unittest
from unittest.mock import patch, AsyncMock, MagicMock
from types import SimpleNamespace
import threading
from urllib.error import HTTPError, URLError

from checkout_core import Stop
from registration_job import RegistrationJob
from registration_security import offer_from_text, totp, verification_link, validate_birthdate, birth_age, registration_age
from registration_browser import RegistrationBrowser
import bitbrowser_options


def payload():
    task_id = '11111111-1111-4111-8111-111111111111'
    return dict(id=task_id, mode='registration', attempt=1, agentToken='a' * 64,
                callbackUrl=f'https://manager.example.test/api/id-business-v2/auto-registration/local/{task_id}',
                windowName='注册测试', email='owner@example.test', password='synthetic-only-password',
                displayName='李华', birthDate='1996-01-01', totpSecret=None, browserProfileId=None,
                registered=False, passwordVerified=False, mfaVerified=False, step='queued',
                bitBrowser=dict(localApiUrl='http://127.0.0.1:54345', localApiToken='synthetic-only-token',
                                groupName='注册', tagName='测试', proxyType='http',
                                dynamicProxyUrl='https://proxy.example.test/extract',
                                browserOptions=deepcopy(bitbrowser_options.DEFAULTS)))


class RegistrationTests(unittest.TestCase):
    def test_uses_full_browser_settings_and_same_task_identity(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        self.assertEqual(job.settings['localApiUrl'], 'http://127.0.0.1:54345')
        self.assertFalse(job.settings['browserOptions']['syncCookies'])
        self.assertEqual(job.payload['birthDate'], '1996-01-01')

    def test_callback_cannot_send_credentials_to_another_origin_or_path(self):
        for destination in ['https://evil.test/api/id-business-v2/auto-registration/local/x',
                            'https://manager.example.test/api/id-business-v2/auto-recharge/local/x',
                            'https://manager.example.test/api/id-business-v2/auto-registration/local/' + payload()['id'] + '?redirect=evil']:
            data = payload(); data['callbackUrl'] = destination
            with self.assertRaises(Stop):
                RegistrationJob(data, 'https://manager.example.test', object)

    def test_rejects_stale_code_step_attempt_and_duplicate_delivery(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        job.awaiting_code = True; job.step = 'email_code'
        for attempt, step in [(0, 'email_code'), (1, 'password')]:
            with self.assertRaises(Stop): job.signal_code('123456', attempt, step)
        job.signal_code('123456', 1, 'email_code', 'mail-current')
        with self.assertRaises(Stop): job.signal_code('123456', 1, 'email_code', 'mail-current')
        with patch.object(job, 'event') as event:
            self.assertEqual(asyncio.run(job.wait_code()), '123456')
            event.assert_called_once_with('mail_accepted', mailId='mail-current')
        self.assertIsNone(job.pending_code)

    def test_cancelled_job_cannot_continue(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        job.signal_cancel()
        with self.assertRaises(Stop): job.check()

    def test_manual_wait_timeout_preserves_actual_checkpoint_reason(self):
        for reason in ['verification_required', 'form_unrecognized', 'official_login_not_verified']:
            with self.subTest(reason=reason):
                job = RegistrationJob(payload(), 'https://manager.example.test', object)
                def expire(event_type, **_data):
                    if event_type == 'waiting_user':
                        job.deadline = 0
                with patch.object(job, 'event', side_effect=expire) as event:
                    with self.assertRaises(Stop) as stopped:
                        asyncio.run(job.manual(reason))
                self.assertEqual(stopped.exception.report['reason'], reason)
                self.assertFalse(job.waiting_for_user)
                event.assert_called_once_with('waiting_user', reason=reason)

    def test_mail_wait_timeout_still_reports_mailbox_timeout(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        job.deadline = 0
        with self.assertRaises(Stop) as stopped:
            asyncio.run(job.wait_code())
        self.assertEqual(stopped.exception.report['reason'], 'mailbox_timeout')

    def test_cancellation_takes_priority_over_manual_wait_timeout(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        def cancel(event_type, **_data):
            if event_type == 'waiting_user':
                job.deadline = 0
                job.signal_cancel()
        with patch.object(job, 'event', side_effect=cancel):
            with self.assertRaises(Stop) as stopped:
                asyncio.run(job.manual('verification_required'))
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertFalse(job.waiting_for_user)

    def test_successful_manual_resume_does_not_mask_later_mail_timeout(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        def resume(event_type, **_data):
            if event_type == 'waiting_user':
                job.signal_resume()
        with patch.object(job, 'event', side_effect=resume) as event:
            asyncio.run(job.manual('verification_required'))
        self.assertEqual([call.args[0] for call in event.call_args_list], ['waiting_user', 'progress'])
        job.deadline = 0
        with self.assertRaises(Stop) as stopped:
            asyncio.run(job.wait_code())
        self.assertEqual(stopped.exception.report['reason'], 'mailbox_timeout')

    def test_failed_manual_callback_does_not_leave_an_active_handoff(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        with patch.object(job, 'event', side_effect=Stop('durable_state_unavailable')):
            with self.assertRaises(Stop) as stopped:
                asyncio.run(job.manual('verification_required'))
        self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
        self.assertFalse(job.waiting_for_user)
        self.assertIsNone(job.manual_reason)

    def test_manual_wait_without_observation_keeps_explicit_resume_path(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        deadline = job.deadline
        async def resume_after_poll(_delay):
            self.assertTrue(job.waiting_for_user)
            self.assertFalse(job.resume_event.is_set())
            job.signal_resume()
        with patch.object(job, 'event') as event, patch('registration_job.asyncio.sleep', new=AsyncMock(side_effect=resume_after_poll)) as sleep:
            asyncio.run(job.manual('form_unrecognized'))
        sleep.assert_awaited_once_with(.5)
        self.assertEqual([call.args[0] for call in event.call_args_list], ['waiting_user', 'progress'])
        self.assertTrue(job.resume_event.is_set())
        self.assertFalse(job.waiting_for_user)
        self.assertIsNone(job.manual_reason)
        self.assertEqual(job.deadline, deadline)

    def test_passive_manual_observation_continues_without_a_resume_signal(self):
        for observations in [[True], [False, True]]:
            with self.subTest(observations=observations):
                job = RegistrationJob(payload(), 'https://manager.example.test', object)
                deadline = job.deadline
                can_resume = AsyncMock(side_effect=observations)
                with patch.object(job, 'event') as event, patch('registration_job.asyncio.sleep', new=AsyncMock()) as sleep:
                    asyncio.run(job.manual('verification_required', can_resume=can_resume))
                self.assertEqual(can_resume.await_count, len(observations))
                self.assertEqual(sleep.await_count, len(observations) - 1)
                self.assertEqual([call.args[0] for call in event.call_args_list], ['waiting_user', 'progress'])
                self.assertFalse(job.resume_event.is_set())
                self.assertFalse(job.waiting_for_user)
                self.assertIsNone(job.manual_reason)
                self.assertEqual(job.deadline, deadline)
                self.assertEqual(job.attempt, 1)

    def test_passive_false_observation_preserves_manual_handoff(self):
        for observation in [False, 1, 'synthetic-ready']:
            with self.subTest(observation=observation):
                job = RegistrationJob(payload(), 'https://manager.example.test', object)
                async def verify():
                    observed = asyncio.Event()
                    release = asyncio.Event()
                    async def can_resume():
                        observed.set()
                        await release.wait()
                        return observation
                    task = asyncio.create_task(job.manual('verification_required', can_resume=can_resume))
                    await observed.wait()
                    self.assertFalse(task.done())
                    self.assertTrue(job.waiting_for_user)
                    self.assertEqual(job.manual_reason, 'verification_required')
                    self.assertFalse(job.resume_event.is_set())
                    job.signal_resume()
                    release.set()
                    await task
                with patch.object(job, 'event') as event, patch('registration_job.asyncio.sleep', new=AsyncMock()):
                    asyncio.run(asyncio.wait_for(verify(), timeout=1))
                self.assertEqual([call.args[0] for call in event.call_args_list], ['waiting_user', 'progress'])
                self.assertTrue(job.resume_event.is_set())
                self.assertFalse(job.waiting_for_user)
                self.assertIsNone(job.manual_reason)

    def test_passive_observation_cannot_override_cancellation_or_deadline(self):
        for cancelled, expired, expected in [(True, False, 'operation_cancelled'),
                                              (False, True, 'verification_required'),
                                              (True, True, 'operation_cancelled')]:
            with self.subTest(cancelled=cancelled, expired=expired):
                job = RegistrationJob(payload(), 'https://manager.example.test', object)
                async def can_resume():
                    if cancelled:
                        job.signal_cancel()
                    if expired:
                        job.deadline = 0
                    return True
                with patch.object(job, 'event') as event:
                    with self.assertRaises(Stop) as stopped:
                        asyncio.run(job.manual('verification_required', can_resume=can_resume))
                self.assertEqual(stopped.exception.report['reason'], expected)
                event.assert_called_once_with('waiting_user', reason='verification_required')
                self.assertFalse(job.resume_event.is_set())
                self.assertFalse(job.waiting_for_user)
                self.assertIsNone(job.manual_reason)

    def test_passive_observation_is_not_called_after_an_expired_waiting_callback(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        def expire(event_type, **_data):
            if event_type == 'waiting_user':
                job.deadline = 0
        can_resume = AsyncMock(return_value=True)
        with patch.object(job, 'event', side_effect=expire):
            with self.assertRaises(Stop) as stopped:
                asyncio.run(job.manual('verification_required', can_resume=can_resume))
        self.assertEqual(stopped.exception.report['reason'], 'verification_required')
        can_resume.assert_not_awaited()
        self.assertFalse(job.waiting_for_user)
        self.assertIsNone(job.manual_reason)

    def test_passive_observation_exception_clears_handoff_without_progress(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        can_resume = AsyncMock(side_effect=RuntimeError('synthetic_observation_failure'))
        with patch.object(job, 'event') as event:
            with self.assertRaisesRegex(RuntimeError, 'synthetic_observation_failure'):
                asyncio.run(job.manual('verification_required', can_resume=can_resume))
        event.assert_called_once_with('waiting_user', reason='verification_required')
        self.assertFalse(job.resume_event.is_set())
        self.assertFalse(job.waiting_for_user)
        self.assertIsNone(job.manual_reason)

    def test_manual_resume_uses_current_account_password_and_same_attempt(self):
        job = RegistrationJob(payload(), 'https://manager.example.test', object)
        job.waiting_for_user = True; job.payload['passwordVerified'] = True
        credentials = dict(attempt=1, password='current-synthetic-password', totpSecret=None)
        with self.assertRaises(Stop): job.signal_resume({**credentials, 'attempt': 2})
        self.assertFalse(job.resume_event.is_set())
        job.signal_resume(credentials)
        self.assertEqual(job.payload['password'], credentials['password'])
        self.assertTrue(job.resume_event.is_set())

    def test_offer_inspection_blocks_payment_writes_but_allows_login_and_reads(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        flow = RegistrationBrowser(SimpleNamespace(payload={}), None)
        async def verify():
            for method, url, blocked in [
                ('POST', 'https://chatgpt.com/backend-api/payments/create', True),
                ('POST', 'https://chatgpt.com/backend-api/subscription/create', True),
                ('POST', 'https://pay.openai.com/purchase', True),
                ('POST', 'https://auth.openai.com/login', False),
                ('GET', 'https://chatgpt.com/backend-api/subscriptions', False),
            ]:
                route = SimpleNamespace(request=SimpleNamespace(method=method, url=url),
                                        abort=AsyncMock(), continue_=AsyncMock())
                await flow.guard(route)
                self.assertEqual(route.abort.call_count, int(blocked))
                self.assertEqual(route.continue_.call_count, int(not blocked))
        asyncio.run(verify())

    def test_standard_totp_vector(self):
        # RFC 6238 SHA1 test key, reduced to the supported six digits.
        self.assertEqual(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59), '287082')

    def test_safe_email_links(self):
        self.assertTrue(verification_link('https://auth.openai.com/email-verification?code=synthetic'))
        for url in ['https://auth.openai.com.evil.test/verify', 'https://a@auth.openai.com/verify',
                    'http://auth.openai.com/verify', 'https://auth.openai.com:444/verify']:
            self.assertFalse(verification_link(url))

    def test_no_cta_no_proof_of_full_price(self):
        for text in ['Upgrade to Plus', '升级套餐', '20 USD/month', '', '1 month free and 50% off']:
            self.assertEqual(offer_from_text(text), 'unknown')
        self.assertEqual(offer_from_text('Try 1 month free'), 'free_trial')
        self.assertEqual(offer_from_text('获得半价优惠'), 'half_price')

    def test_invalid_identity_does_not_generate_an_age(self):
        for birthday in ['2016-01-01', '1980-01-01', '1996-02-30', '20']:
                with self.assertRaises(Stop): validate_birthdate(birthday)

    def test_fixed_registration_age_is_optional_and_strict(self):
        for age in [20, 21, 45]:
            data = payload(); data['registrationAge'] = age
            self.assertEqual(RegistrationJob(data, 'https://manager.example.test', object).payload['registrationAge'], age)
            self.assertEqual(registration_age(age, '1996-01-01'), age)
        for age in [None, True, '20', 19, 46, 20.0]:
            data = payload(); data['registrationAge'] = age
            with self.assertRaises(Stop): RegistrationJob(data, 'https://manager.example.test', object)
        self.assertEqual(RegistrationJob(payload(), 'https://manager.example.test', object).payload['birthDate'], '1996-01-01')

    def test_resume_keeps_fixed_task_age_and_original_birthdate(self):
        for age in [20, 21, 45]:
            with self.subTest(age=age):
                data = payload(); data['registrationAge'] = age
                job = RegistrationJob(data, 'https://manager.example.test', object)
                job.waiting_for_user = True
                credentials = dict(attempt=1, password='current-synthetic-password', totpSecret=None)
                with self.assertRaises(Stop):
                    job.signal_resume({**credentials, 'registrationAge': 22})
                self.assertFalse(job.resume_event.is_set())
                job.signal_resume(credentials)
                self.assertEqual(job.payload['registrationAge'], age)
                self.assertEqual(job.payload['birthDate'], data['birthDate'])
                self.assertTrue(job.resume_event.is_set())

    def test_legacy_birth_age_observes_actual_birthday_boundaries(self):
        self.assertEqual(birth_age('2006-10-03', date(2026, 10, 3)), 20)
        with self.assertRaises(Stop): birth_age('2006-10-03', date(2026, 10, 2))
        self.assertEqual(birth_age('1981-10-03', date(2026, 10, 3)), 45)
        with self.assertRaises(Stop): birth_age('1980-10-03', date(2026, 10, 3))


class RegistrationObservationTests(unittest.IsolatedAsyncioTestCase):
    def flow(self):
        job = SimpleNamespace(payload={'email': 'owner@example.test', 'registered': False},
                              check=lambda: None, cancelled=threading.Event())
        context = SimpleNamespace(route=AsyncMock(), unroute=AsyncMock())
        flow = RegistrationBrowser(job, context)
        flow.page = SimpleNamespace(url='https://chatgpt.com/auth/login')
        context.pages = [flow.page]
        return flow

    async def test_identity_has_shared_budget_and_propagates_transport_failures(self):
        from browser_session import SessionBudget
        flow = self.flow()
        flow.observation_budget = SessionBudget(10)
        with patch('registration_browser.official_identity', AsyncMock(side_effect=Stop('session_network_error'))) as identity:
            with self.assertRaises(Stop) as stopped:
                await flow.identity()
        self.assertEqual(stopped.exception.report['reason'], 'session_network_error')
        self.assertIs(identity.await_args.kwargs['budget'], flow.observation_budget)
        self.assertTrue(identity.await_args.kwargs['observe_errors'])
        self.assertEqual(flow.job.registration_operation, 'identity_read')

    async def test_navigation_context_change_reobserves_same_page_without_submission(self):
        flow = self.flow()
        Error = type('Error', (Exception,), {})
        flow.registration_view = AsyncMock(side_effect=[Error('Execution context was destroyed'), ('registered', None)])
        flow.page.goto = AsyncMock(return_value=SimpleNamespace(status=200))
        flow.registration_country = AsyncMock(return_value='US')
        flow.settle = AsyncMock()
        flow.job.event = lambda *_args, **_kwargs: None
        flow.job.manual = AsyncMock()
        with patch('registration_browser.REGISTRATION_OBSERVE_SECONDS', 0):
            await flow.register()
        flow.page.goto.assert_awaited_once_with('https://chatgpt.com/auth/login', wait_until='domcontentloaded', timeout=0)
        flow.job.manual.assert_not_awaited()
        self.assertTrue(flow.data['registered'])

    async def test_unknown_script_error_is_not_treated_as_navigation_or_network(self):
        flow = self.flow()
        Error = type('Error', (Exception,), {})
        error = Error('TypeError: synthetic application defect')
        flow.registration_view = AsyncMock(side_effect=error)
        flow.page.goto = AsyncMock()
        with self.assertRaises(Error) as stopped:
            await flow.register()
        self.assertIs(stopped.exception, error)
        flow.page.goto.assert_not_awaited()

    async def test_cleanup_cannot_replace_first_failure_and_still_unroutes(self):
        flow = self.flow()
        primary = Stop('official_login_email_mismatch')
        flow.register = AsyncMock(side_effect=primary)
        flow.end_recovery = AsyncMock(side_effect=RuntimeError('synthetic cleanup failure'))
        with patch('registration_browser.clear_visible_secrets', AsyncMock()) as clear:
            with self.assertRaises(Stop) as stopped:
                await flow.run()
        self.assertIs(stopped.exception, primary)
        clear.assert_awaited_once_with(flow.page)
        flow.context.unroute.assert_awaited_once()
        self.assertEqual(flow.job.registration_cleanup_error, 'UnexpectedError')

    async def test_cleanup_only_failure_is_not_reported_as_success(self):
        flow = self.flow()
        flow.data.update(registered=True, passwordVerified=True, mfaVerified=True)
        flow.guard_registered_onboarding = AsyncMock()
        flow.identity = AsyncMock(return_value=('fixture', 'identity'))
        flow.offer = AsyncMock()
        flow.job.event = lambda *_args, **_kwargs: None
        flow.end_recovery = AsyncMock()
        flow.context.unroute.side_effect = RuntimeError('synthetic cleanup failure')
        with patch('registration_browser.clear_visible_secrets', AsyncMock()):
            with self.assertRaises(RuntimeError):
                await flow.run()
        self.assertEqual(flow.job.registration_operation, 'browser_cleanup')
        self.assertEqual(flow.job.registration_cleanup_error, 'UnexpectedError')


class RegistrationCallbackDiagnosticsTests(unittest.TestCase):
    secret = 'https://private.example.test/?token=fixture-token password=fixture-password otp=654321'

    class Response:
        def __init__(self, raw=b'{"success":true,"data":{"step":"queued"}}', read_error=None, close_error=None):
            self.raw, self.read_error, self.close_error = raw, read_error, close_error

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            if self.close_error:
                raise self.close_error

        def read(self, _limit):
            if self.read_error:
                raise self.read_error
            return self.raw

    def job(self):
        return RegistrationJob(payload(), 'https://manager.example.test', object)

    def assert_private(self, job, logger):
        output = json.dumps(job.registration_callback_error)
        for call in logger.warning.call_args_list:
            self.assertFalse(call.kwargs)
            output += call.args[0] % call.args[1:]
        for forbidden in ['private.example.test', 'fixture-token', 'fixture-password', '654321',
                          payload()['agentToken'], payload()['password'], payload()['email'],
                          payload()['callbackUrl']]:
            self.assertNotIn(forbidden, output)

    def failure(self, kind, error_type, *, error=None, response=None, status=None):
        job = self.job()
        logger = MagicMock()
        opener = MagicMock()
        if error is not None:
            opener.open.side_effect = error
        else:
            opener.open.return_value = response
        with patch('registration_job.build_opener', return_value=opener), \
                patch('registration_job.logging.getLogger', return_value=logger):
            with self.assertRaises(Stop) as stopped:
                job.event('progress', reason='proxy_verifying')
        self.assertEqual(stopped.exception.report, {'status': 'blocked', 'reason': 'durable_state_unavailable'})
        self.assertIsNone(stopped.exception.__cause__)
        self.assertEqual(job.registration_callback_error['failure_kind'], kind)
        self.assertEqual(job.registration_callback_error['error_type'], error_type)
        self.assertEqual(job.registration_callback_error['http_status'], status)
        self.assertEqual(job.registration_callback_error['job_id'], job.id)
        self.assertEqual(job.registration_callback_error['attempt'], 1)
        self.assertEqual(job.registration_callback_error['event_type'], 'progress')
        self.assertEqual(job.registration_callback_error['step'], 'queued')
        self.assertEqual(type(job.registration_callback_error['elapsed_ms']), int)
        self.assertGreaterEqual(job.registration_callback_error['elapsed_ms'], 0)
        opener.open.assert_called_once()
        self.assertEqual(opener.open.call_args.kwargs, {'timeout': 10})
        self.assert_private(job, logger)
        return job, logger

    def test_http_status_is_closed_and_does_not_read_error_body(self):
        for status in [401, 403, 409, 500]:
            with self.subTest(status=status):
                body = MagicMock()
                error = HTTPError(self.secret, status, self.secret, {'Private': self.secret}, body)
                job, logger = self.failure('HTTP_STATUS', 'HTTPError', error=error, status=status)
                body.read.assert_not_called()
                logger.warning.assert_called_once()
                self.assertIsNone(job.registration_callback_cleanup_error)

    def test_invalid_or_boolean_http_status_is_not_logged(self):
        for status in [True, None, '500', 99, 600]:
            with self.subTest(status=status):
                self.failure('HTTP_STATUS', 'HTTPError', error=HTTPError(self.secret, status, self.secret, {}, io.BytesIO()))

    def test_direct_and_nested_timeout_only_inspect_exception_types(self):
        self.failure('TIMEOUT', 'TimeoutError', error=TimeoutError(self.secret))
        self.failure('TIMEOUT', 'URLError', error=URLError(TimeoutError(self.secret)))

    def test_transport_failure_does_not_log_exception_text_or_attributes(self):
        self.failure('TRANSPORT', 'URLError', error=URLError(self.secret))
        self.failure('TRANSPORT', 'OSError', error=OSError(self.secret))

        class UnsafeError(Exception):
            def __str__(self):
                raise AssertionError('Exception text must never be inspected')

        error = UnsafeError(self.secret)
        error.request = error.response = error.headers = error.url = self.secret
        self.failure('TRANSPORT', 'UnexpectedError', error=error)

    def test_json_failure_is_distinct_from_receipt_failure(self):
        for raw, error_type in [(b'{', 'JSONDecodeError'), (b'\xff', 'UnicodeDecodeError'),
                                (b'{"success":true,"success":true}', 'ValueError')]:
            with self.subTest(raw_kind=error_type):
                self.failure('INVALID_JSON', error_type, response=self.Response(raw))
        for raw, error_type in [(b'{"success":false}', 'ValueError'),
                                (b'{"success":true,"data":null}', 'ValueError'),
                                (b'{"success":true,"data":[]}', 'ValueError'),
                                (b'{"success":true,"data":{}}', 'KeyError'),
                                (b'[]', 'AttributeError')]:
            with self.subTest(receipt_kind=error_type):
                self.failure('INVALID_RECEIPT', error_type, response=self.Response(raw))

    def test_valid_json_containing_sensitive_data_is_not_in_failure_record(self):
        raw = json.dumps({'success': False, 'data': {'password': self.secret}, 'message': self.secret}).encode()
        self.failure('INVALID_RECEIPT', 'ValueError', response=self.Response(raw))

    def test_partial_failure_preserves_first_diagnostic(self):
        job = self.job()
        logger = MagicMock(); opener = MagicMock()
        opener.open.side_effect = [TimeoutError(self.secret), HTTPError(self.secret, 500, self.secret, {}, None)]
        with patch('registration_job.build_opener', return_value=opener), \
                patch('registration_job.logging.getLogger', return_value=logger):
            with self.assertRaises(Stop):
                job.event('progress', reason='proxy_resolving')
            original = job.registration_callback_error
            with self.assertRaises(Stop):
                job.event('partial', reason='durable_state_unavailable')
        self.assertIs(job.registration_callback_error, original)
        self.assertEqual(original['failure_kind'], 'TIMEOUT')
        self.assertEqual(original['event_type'], 'progress')
        self.assertEqual(opener.open.call_count, 2)
        logger.warning.assert_called_once()
        self.assert_private(job, logger)

    def test_response_cleanup_failure_cannot_replace_first_read_or_json_failure(self):
        for response, expected in [
                (self.Response(read_error=TimeoutError(self.secret), close_error=RuntimeError(self.secret)), 'TIMEOUT'),
                (self.Response(raw=b'{', close_error=RuntimeError(self.secret)), 'INVALID_JSON')]:
            with self.subTest(expected=expected):
                job, logger = self.failure(expected, 'TimeoutError' if expected == 'TIMEOUT' else 'JSONDecodeError', response=response)
                self.assertEqual(job.registration_callback_cleanup_error, 'UnexpectedError')
                self.assertEqual(logger.warning.call_count, 2)

    def test_cleanup_only_failure_still_stops_but_has_separate_identity(self):
        job, logger = self.failure('TRANSPORT', 'OSError', response=self.Response(close_error=OSError(self.secret)))
        self.assertEqual(job.registration_callback_cleanup_error, 'OSError')
        self.assertEqual(logger.warning.call_count, 2)
        self.assertEqual(job.step, 'queued')

    def test_success_keeps_single_callback_and_original_step_behavior(self):
        job = self.job(); logger = MagicMock(); opener = MagicMock()
        job.step = 'email'
        opener.open.return_value = self.Response(b'{"success":true,"data":{"step":"email_code"}}')
        with patch('registration_job.build_opener', return_value=opener), \
                patch('registration_job.logging.getLogger', return_value=logger):
            job.event('progress', step='queued', reason='proxy_ready')
        opener.open.assert_called_once()
        body = json.loads(opener.open.call_args.args[0].data)
        self.assertEqual(body, {'type': 'progress', 'attempt': 1, 'step': 'email', 'reason': 'proxy_ready'})
        self.assertEqual(job.step, 'email_code')
        self.assertIsNone(job.registration_callback_error)
        self.assertIsNone(job.registration_callback_cleanup_error)
        logger.warning.assert_not_called()

    def test_late_ack_timeout_does_not_claim_server_state_was_unchanged(self):
        job = self.job(); committed = {}; logger = MagicMock()
        def commit_then_timeout(request, **_kwargs):
            committed.update(json.loads(request.data))
            raise TimeoutError(self.secret)
        with patch('registration_job.build_opener', return_value=SimpleNamespace(open=commit_then_timeout)), \
                patch('registration_job.logging.getLogger', return_value=logger):
            with self.assertRaises(Stop):
                job.event('progress', step='email', reason='proxy_ready')
        self.assertEqual(committed['step'], 'email')
        self.assertEqual(job.step, 'queued')
        self.assertEqual(job.registration_callback_error['step'], 'email')
        self.assertEqual(job.registration_callback_error['failure_kind'], 'TIMEOUT')
        self.assert_private(job, logger)

    def test_callback_error_does_not_overwrite_browser_cleanup_diagnostic(self):
        job = self.job(); job.registration_cleanup_error = 'TargetClosedError'
        with patch('registration_job.build_opener', side_effect=TimeoutError(self.secret)), \
                patch('registration_job.logging.getLogger', return_value=MagicMock()):
            with self.assertRaises(Stop):
                job.event('progress')
        self.assertEqual(job.registration_cleanup_error, 'TargetClosedError')
        self.assertIsNone(job.registration_callback_cleanup_error)

    def test_elapsed_and_logged_identity_are_bounded_to_safe_values(self):
        job = self.job(); job.id = self.secret; job.attempt = self.secret
        logger = MagicMock()
        with patch.object(job, 'check'), patch('registration_job.time.monotonic', side_effect=[100, 100.5]), \
                patch('registration_job.build_opener', side_effect=TimeoutError(self.secret)), \
                patch('registration_job.logging.getLogger', return_value=logger):
            with self.assertRaises(Stop):
                job.event(self.secret)
        self.assertEqual(job.registration_callback_error['job_id'], 'unknown')
        self.assertEqual(job.registration_callback_error['event_type'], 'unknown')
        self.assertEqual(job.registration_callback_error['attempt'], 0)
        self.assertEqual(job.registration_callback_error['elapsed_ms'], 500)
        self.assert_private(job, logger)

    def test_failed_proxy_progress_callback_stops_before_another_extraction(self):
        import server_proxy
        job = self.job(); logger = MagicMock(); opener = MagicMock()
        opener.open.side_effect = [self.Response(), HTTPError(self.secret, 500, self.secret, {}, None)]
        resolve = AsyncMock(side_effect=Stop('server_proxy_unavailable'))
        launch = AsyncMock()
        def progress(stage, **_details):
            job.event('progress', reason=stage)
        with patch('registration_job.build_opener', return_value=opener), \
                patch('registration_job.logging.getLogger', return_value=logger), \
                patch.object(server_proxy, 'resolve', resolve):
            with self.assertRaises(Stop) as stopped:
                asyncio.run(server_proxy.prepare_browser({'mode': 'dynamic'}, launch,
                    expected_country='US', target_url='https://chatgpt.com/auth/login', progress=progress))
        self.assertEqual(stopped.exception.report['reason'], 'durable_state_unavailable')
        resolve.assert_awaited_once()
        launch.assert_not_awaited()
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(job.registration_callback_error['failure_kind'], 'HTTP_STATUS')
        self.assertEqual(job.registration_callback_error['http_status'], 500)
        logger.warning.assert_called_once()
        self.assert_private(job, logger)


if __name__ == '__main__':
    unittest.main()
