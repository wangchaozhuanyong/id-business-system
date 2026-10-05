import asyncio
from copy import deepcopy
from datetime import date
import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
import threading

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


if __name__ == '__main__':
    unittest.main()
