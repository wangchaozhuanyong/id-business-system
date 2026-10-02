import asyncio
from copy import deepcopy
import unittest
from unittest.mock import patch

from checkout_core import Stop
from registration_job import RegistrationJob
from registration_security import offer_from_text, totp, verification_link, validate_birthdate
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


if __name__ == '__main__':
    unittest.main()
