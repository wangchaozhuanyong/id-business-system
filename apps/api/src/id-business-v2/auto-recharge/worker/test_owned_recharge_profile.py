"""Exact-profile reuse proof using synthetic callbacks; no BitBrowser/network."""
import asyncio
import hashlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bitbrowser_connector as connector
import bitbrowser_retry as retry
from checkout_core import Stop, parse_browser_credential
from test_bitbrowser_connector import payload
from test_subscribe import fixture

ROOT = Path(__file__).resolve().parents[6] / '.runtime/bitbrowser-recharge-rebuild-20261009/profile-fixtures'


class OwnedRechargeProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.target = parse_browser_credential(fixture())
        self.profile = {'sourceJobId': '22222222-2222-4222-8222-222222222222',
                        'profileId': 'a' * 32,
                        'accountKey': hashlib.sha256(self.target.account_id.encode()).hexdigest()}
        value = payload()
        value['ownedProfile'] = dict(self.profile)
        self.job = connector.LocalJob(value)
        self.job.root = Path(self.temp.name)
        self.job.callback.send = MagicMock(return_value={
            'records': [], 'staleProfiles': [], 'ownedProfile': dict(self.profile)})
        self.job.restore_account(self.target)
        self.job.progress = MagicMock()
        self.page = SimpleNamespace(url='https://chatgpt.com/', set_default_timeout=MagicMock(), goto=AsyncMock())
        self.context = SimpleNamespace(pages=[self.page], route=AsyncMock(), unroute=AsyncMock(), add_cookies=AsyncMock())
        self.job.context = self.context
        self.client = MagicMock()
        self.client.post.return_value = {'id': self.profile['profileId']}
        self.playwright = MagicMock()
        self.identity = {'account_matched': True, 'current_plan': 'go'}
        self.refreshed = SimpleNamespace(token='synthetic-refreshed')
        self.options = {}

    async def test_exact_api_owned_window_is_verified_before_cookie_or_payment_writes(self):
        with (patch.object(retry, 'attach_profile', AsyncMock()) as attach,
              patch('browser_checkout.check_session', AsyncMock(return_value=(self.refreshed, self.identity))) as check):
            target = await retry.reuse_owned_profile(self.job, self.client, self.playwright, self.target, self.options)
        self.client.post.assert_called_once_with('/browser/detail', {'id': self.profile['profileId']})
        attach.assert_awaited_once_with(self.job, self.client, self.playwright, self.profile['profileId'], self.options)
        check.assert_awaited_once_with(self.page, self.target)
        self.context.add_cookies.assert_not_awaited()
        self.assertEqual(target.session_token, '')
        self.assertEqual(target.account_id, self.target.account_id)
        self.assertEqual(target.old_token, 'synthetic-refreshed')
        self.client.create_profile.assert_not_called()
        self.assertFalse(self.job.payment_request_sent)

    async def test_other_account_or_expired_window_never_overwrites_or_pays(self):
        for reason, expected in [('official_account_mismatch', 'official_account_mismatch'),
                                 ('session_token_expired', 'owned_recharge_window_login_required')]:
            with (patch.object(retry, 'attach_profile', AsyncMock()),
                  patch('browser_checkout.check_session', AsyncMock(side_effect=Stop(reason))),
                  self.subTest(reason=reason), self.assertRaises(Stop) as stopped):
                await retry.reuse_owned_profile(self.job, self.client, self.playwright, self.target, self.options)
            self.assertEqual(stopped.exception.report['reason'], expected)
        self.context.add_cookies.assert_not_awaited()
        self.client.create_profile.assert_not_called()
        self.assertFalse(self.job.payment_request_sent)

    async def test_password_uses_live_identity_then_exact_authoritative_restore(self):
        with (patch.object(retry, 'attach_profile', AsyncMock()),
              patch.object(retry.browser_password_login, 'official_identity',
                  AsyncMock(return_value=(self.target, self.identity))) as identity,
              patch('browser_checkout.check_session', AsyncMock(return_value=(self.refreshed, self.identity)))):
            target = await retry.reuse_owned_profile(self.job, self.client, self.playwright, None, self.options,
                                                    'test@example.invalid')
        identity.assert_awaited_once_with(self.page, 'test@example.invalid', strict=True)
        self.assertEqual(target.account_id, self.target.account_id)
        self.context.add_cookies.assert_not_awaited()
        self.assertEqual(self.job.owned_profile, self.profile)

    async def test_forged_profile_hint_is_rejected_by_authoritative_restore(self):
        self.job.callback.send.return_value = {'records': [], 'staleProfiles': []}
        with (patch.object(retry, 'attach_profile', AsyncMock()),
              patch.object(retry.browser_password_login, 'official_identity',
                  AsyncMock(return_value=(self.target, self.identity))),
              self.assertRaises(Stop) as stopped):
            await retry.reuse_owned_profile(self.job, self.client, self.playwright, None, self.options,
                                            'test@example.invalid')
        self.assertEqual(stopped.exception.report['reason'], 'owned_recharge_window_unverified')
        self.context.add_cookies.assert_not_awaited()
        self.assertFalse(self.job.payment_request_sent)

    async def test_cancelled_reused_profile_is_retained_and_never_deleted(self):
        self.job.cancelled = True
        self.job.profile_id = self.profile['profileId']
        self.job.progress = MagicMock()
        with patch.object(retry, '_execute_profiles', AsyncMock(side_effect=Stop('operation_cancelled'))):
            result = await retry.execute_profiles(self.job, self.client, self.target, self.playwright)
        self.assertEqual(result['browser_cleanup_status'], 'not_needed')
        self.client.post.assert_not_called()
        self.assertEqual(self.job.profile_id, self.profile['profileId'])

    def test_restore_rejects_other_account_or_registration_stale_profile_overlap(self):
        for changed in ({**self.profile, 'accountKey': 'f' * 64},
                        {**self.profile, 'sourceJobId': self.job.id}):
            self.job.callback.send.return_value = {'records': [], 'staleProfiles': [], 'ownedProfile': changed}
            with self.subTest(changed=changed), self.assertRaises(Stop):
                self.job.restore_account(self.target)
        self.job.callback.send.return_value = {'records': [], 'staleProfiles': [
            {'sourceJobId': self.profile['sourceJobId'], 'profileId': self.profile['profileId']}],
            'ownedProfile': self.profile}
        with self.assertRaises(Stop):
            self.job.restore_account(self.target)


if __name__ == '__main__':
    unittest.main()
