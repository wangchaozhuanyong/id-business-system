"""原窗口代理预检和登录页面同步；仅合成数据，不访问外网。"""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import browser_checkout
from browser_session import SessionBudget
from checkout_core import BrowserCredential, Credential, Stop


class ProxyPreparationTests(unittest.IsolatedAsyncioTestCase):
    def make_context(self, status=200):
        page = SimpleNamespace(url='about:blank', goto=AsyncMock(return_value=SimpleNamespace(status=status)),
                               title=AsyncMock(return_value='ChatGPT'))
        context = SimpleNamespace(pages=[page], route=AsyncMock(), unroute=AsyncMock())
        return context, page

    async def test_original_tab_reads_exit_then_home_and_removes_guard(self):
        context, page = self.make_context()
        network = {'ip': '8.8.8.8', 'country': 'PH', 'observedAt': '2026-10-09T00:00:00Z'}
        with patch.object(browser_checkout, 'observe_page_network', AsyncMock(return_value=network)) as probe:
            result = await browser_checkout.prepare_proxy_in_context(context, 'PH', budget=SessionBudget(600))
        self.assertEqual(result, network)
        self.assertEqual([call.args[0] for call in page.goto.await_args_list],
                         ['https://chatgpt.com/cdn-cgi/trace', 'https://chatgpt.com/'])
        self.assertIs(probe.await_args.args[0], page)
        self.assertEqual(probe.await_args.args[1].seconds, 20)
        context.route.assert_awaited_once()
        context.unroute.assert_awaited_once()
        guard = context.route.await_args.args[1].__self__
        self.assertEqual(guard.classify('POST', 'https://api.stripe.com/v1/payment_methods'), 'payment')
        self.assertEqual(guard.sent, 0)

    async def test_wrong_country_stops_before_home(self):
        context, page = self.make_context()
        with patch.object(browser_checkout, 'observe_page_network', AsyncMock(return_value={
                'ip': '8.8.8.8', 'country': 'US'})), self.assertRaises(Stop) as error:
            await browser_checkout.prepare_proxy_in_context(context, 'PH', budget=SessionBudget(600))
        self.assertEqual(error.exception.report['reason'], 'proxy_country_mismatch')
        self.assertEqual(page.goto.await_count, 1)

    async def test_challenge_and_http_failure_never_become_proxy_network_failure(self):
        for status, reason in ((403, 'verification_required'), (500, 'http_error')):
            context, page = self.make_context(status)
            with self.subTest(status=status), self.assertRaises(Stop) as error:
                await browser_checkout.prepare_proxy_in_context(context, budget=SessionBudget(600))
            self.assertEqual(error.exception.report['reason'], reason)
            self.assertEqual(page.goto.await_count, 1)
            context.unroute.assert_awaited_once()

    async def test_explicit_transport_failure_is_redacted_and_bounded(self):
        context, page = self.make_context()
        page.goto.side_effect = RuntimeError('net::ERR_PROXY_CONNECTION_FAILED secret-url')
        with self.assertRaises(Stop) as error:
            await browser_checkout.prepare_proxy_in_context(context, budget=SessionBudget(600))
        self.assertEqual(error.exception.report['reason'], 'proxy_network_error')
        self.assertNotIn('secret-url', str(error.exception.report))
        context.unroute.assert_awaited_once()


class LoginReadinessTests(unittest.IsolatedAsyncioTestCase):
    def make(self, sequence, seconds=30):
        self.now = 0
        target = BrowserCredential('synthetic-session', 'synthetic-account', 'synthetic-user', '')
        refreshed = Credential('synthetic-access', target.account_id, 2000000000)
        identity = {'account_matched': True, 'current_plan': 'free'}
        page = SimpleNamespace(evaluate=AsyncMock(), reload=AsyncMock(return_value=SimpleNamespace(status=200)))
        items = iter(sequence)

        async def evaluate(*_):
            self.now += 6
            return next(items)

        page.evaluate.side_effect = evaluate
        budget = SessionBudget(seconds, clock=lambda: self.now)
        return page, target, refreshed, identity, budget

    async def test_identity_alone_is_not_ready_and_refreshes_original_tab_once(self):
        page, target, refreshed, identity, budget = self.make([False, False, True])
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))) as check, \
                patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()):
            result_target, result_identity = await browser_checkout.synchronize_login_page(
                page, target, identity, budget=budget)
        page.reload.assert_awaited_once_with(wait_until='commit', timeout=0)
        self.assertEqual(check.await_count, 3)
        self.assertEqual(result_identity, identity)
        self.assertEqual(result_target.account_id, target.account_id)
        self.assertEqual(result_target.user_id, target.user_id)
        self.assertEqual(result_target.session_token, '')
        self.assertIn('accounts-profile-button', page.evaluate.await_args.args[0])

    async def test_already_ready_does_not_refresh_or_wait_for_all_resources(self):
        page, target, refreshed, identity, budget = self.make([True])
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))):
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        page.reload.assert_not_awaited()

    async def test_permanent_anonymous_ui_finishes_without_infinite_refresh(self):
        page, target, refreshed, identity, budget = self.make([False] * 10, seconds=25)
        with patch.object(browser_checkout, 'check_session', AsyncMock(return_value=(refreshed, identity))), \
                patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()), self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'official_login_page_not_ready')
        self.assertTrue(error.exception.report['account_matched'])
        page.reload.assert_awaited_once()

    async def test_identity_change_or_expiration_after_refresh_is_not_ui_failure(self):
        for reason in ('official_user_mismatch', 'access_token_expired', 'verification_required'):
            page, target, refreshed, identity, budget = self.make([False, False])
            check = AsyncMock(side_effect=[(refreshed, identity), (refreshed, identity), Stop(reason)])
            with self.subTest(reason=reason), patch.object(browser_checkout, 'check_session', check), \
                    patch.object(browser_checkout.asyncio, 'sleep', AsyncMock()), self.assertRaises(Stop) as error:
                await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
            self.assertEqual(error.exception.report['reason'], reason)
            page.reload.assert_awaited_once()

    async def test_cancel_stops_without_refresh(self):
        page, target, _, identity, _ = self.make([False])
        budget = SessionBudget(30, cancelled=lambda: True)
        with self.assertRaises(Stop) as error:
            await browser_checkout.synchronize_login_page(page, target, identity, budget=budget)
        self.assertEqual(error.exception.report['reason'], 'operation_cancelled')
        page.reload.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
