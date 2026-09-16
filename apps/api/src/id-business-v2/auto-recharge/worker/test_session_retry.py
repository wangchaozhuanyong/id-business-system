"""Virtual-clock and isolated client fixtures; no real profiles or payment requests."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import browser_checkout
import bitbrowser_retry
import bitbrowser_connector as connector
from browser_session import SessionBudget, retryable_session_result
from checkout_core import Stop
from test_bitbrowser_connector import payload


class Clock:
    now = 0

    def __call__(self):
        return self.now

    async def advance(self, seconds, value=None):
        self.now += seconds
        return value


class SessionBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_page_and_both_reads_share_120_seconds_not_45_or_25(self):
        clock, report = Clock(), MagicMock()
        budget = SessionBudget(120, clock=clock, report=report)
        page = MagicMock()
        page.goto = AsyncMock(side_effect=lambda *a, **kw: None)

        async def goto(*args, **kwargs):
            self.assertEqual(kwargs['timeout'], 0)
            await clock.advance(50)

        page.goto.side_effect = goto
        context = MagicMock()
        context.route = AsyncMock()
        context.unroute = AsyncMock()
        context.route_web_socket = AsyncMock()
        context.new_page = AsyncMock(return_value=page)
        context.add_cookies = AsyncMock()

        async def check(_page, _target, _wait, current):
            self.assertIs(current, budget)
            await current.run(lambda: clock.advance(30), 'session_read')
            await current.run(lambda: clock.advance(39), 'account_read')
            return None, {'account_matched': True, 'current_plan': 'free', 'session_status': 'restored'}

        with patch.object(browser_checkout, 'session_cookies', return_value=[]), \
                patch.object(browser_checkout, 'check_session', side_effect=check), \
                patch.object(browser_checkout, 'progress'), \
                patch.dict('os.environ', {}, clear=True):
            result = await browser_checkout.workflow(context, SimpleNamespace(), session_budget=budget)
        self.assertEqual(result['status'], 'session_verified')
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(budget.elapsed, 119)
        self.assertEqual(report.call_args.kwargs['session_elapsed_seconds'], 119)

    async def test_network_failure_refreshes_same_page_before_window_rebuild(self):
        budget = SessionBudget(120)
        page = MagicMock(url='https://chatgpt.com/')
        page.goto = AsyncMock(side_effect=RuntimeError('net::ERR_TUNNEL_CONNECTION_FAILED'))
        page.reload = AsyncMock()
        context = MagicMock(
            route=AsyncMock(),
            unroute=AsyncMock(),
            route_web_socket=AsyncMock(),
            new_page=AsyncMock(return_value=page),
            add_cookies=AsyncMock(),
        )
        identity = {
            'account_matched': True,
            'current_plan': 'free',
            'session_status': 'restored',
        }
        with patch.object(browser_checkout, 'session_cookies', return_value=[]), \
                patch.object(browser_checkout, 'check_session', new=AsyncMock(return_value=(None, identity))), \
                patch.object(browser_checkout, 'progress') as progress, \
                patch.dict('os.environ', {}, clear=True):
            result = await browser_checkout.workflow(
                context, SimpleNamespace(), session_budget=budget
            )
        page.goto.assert_awaited_once()
        page.reload.assert_awaited_once_with(wait_until='domcontentloaded', timeout=0)
        self.assertEqual(result['status'], 'session_verified')
        self.assertTrue(any(
            call.args == ('session_page_refreshing',)
            and call.kwargs.get('session_refresh_count') == 1
            for call in progress.call_args_list
        ))

    async def test_deadline_is_shared_and_expires_at_120(self):
        clock = Clock()
        budget = SessionBudget(120, clock=clock)
        await budget.run(lambda: clock.advance(90), 'page_load')
        self.assertEqual(budget.remaining_ms(), 30000)
        with self.assertRaises(Stop) as caught:
            await budget.run(lambda: clock.advance(30), 'session_read')
        self.assertEqual(caught.exception.report['reason'], 'session_load_timeout')

    async def test_same_window_checkout_rebuild_gets_a_fresh_session_load_budget(self):
        clock, report = Clock(), MagicMock()
        budget = SessionBudget(120, clock=clock, report=report)
        await budget.run(lambda: clock.advance(80), 'page_load')
        restarted = budget.restart()
        self.assertEqual(restarted.elapsed, 0)
        self.assertEqual(restarted.remaining_ms(), 120000)
        self.assertIs(restarted.report, report)

    async def test_optional_network_observation_is_bounded_after_identity_success(self):
        clock = Clock()
        budget = SessionBudget(120, clock=clock)
        page = MagicMock()
        async def goto(*args, **kwargs):
            await clock.advance(100)
        async def trace(script, timeout):
            self.assertEqual(timeout, 10000)
            await clock.advance(20)
            return 'ip=203.0.113.1\nloc=US'
        page.goto = AsyncMock(side_effect=goto)
        page.evaluate = AsyncMock(side_effect=trace)
        context = MagicMock(route=AsyncMock(), unroute=AsyncMock(), route_web_socket=AsyncMock(),
                            new_page=AsyncMock(return_value=page), add_cookies=AsyncMock())
        identity = {'account_matched': True, 'current_plan': 'free', 'session_status': 'restored'}
        with patch.object(browser_checkout, 'session_cookies', return_value=[]), \
                patch.object(browser_checkout, 'check_session', new=AsyncMock(return_value=(None, identity))), \
                patch.object(browser_checkout, 'progress'), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': 'fixture'}):
            result = await browser_checkout.workflow(context, SimpleNamespace(), session_budget=budget)
        self.assertEqual(result['status'], 'session_verified')
        self.assertTrue(result['account_matched'])
        self.assertIsNone(result['network']['ip'])
        self.assertEqual(result['checkout_requests_sent'], 0)

    async def test_human_verification_time_is_excluded(self):
        clock = Clock()
        budget = SessionBudget(120, clock=clock)
        page = SimpleNamespace(title=AsyncMock(side_effect=['Verify human', 'ChatGPT']))
        async def human(*args):
            await clock.advance(900)
        with patch.object(browser_checkout, 'wait_for_user', side_effect=human) as wait, \
                patch.object(browser_checkout, 'browser_read', new=AsyncMock(return_value={})), \
                patch.object(browser_checkout, 'verify_official_session', return_value=SimpleNamespace(token='new')), \
                patch.object(browser_checkout, 'account_plan', return_value='free'):
            _, identity = await browser_checkout.check_session(
                page, SimpleNamespace(account_id='fixture', old_token='old'), 1800, budget)
        wait.assert_awaited_once_with('verification_required', 1800)
        self.assertTrue(identity['account_matched'])
        self.assertEqual(budget.remaining_ms(), 120000)

    async def test_cancel_interrupts_pending_navigation(self):
        flag = {'cancelled': False}
        stopped = asyncio.Event()
        async def pending():
            flag['cancelled'] = True
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        with self.assertRaises(Stop) as caught:
            await SessionBudget(120, cancelled=lambda: flag['cancelled']).run(pending, 'page_load')
        self.assertEqual(caught.exception.report['reason'], 'operation_cancelled')
        self.assertTrue(stopped.is_set())

    def test_public_errors_and_progress_exclude_raw_credentials(self):
        result = connector.public_result({'error_type': 'TimeoutError', 'session_attempt': 2,
                                         'browser_error_code': 'net::ERR_TIMED_OUT',
                                         'payment_failure_reason': 'incorrect_cvc',
                                         'sessionJson': 'private', 'message': 'private', 'cvc': '123'})
        self.assertEqual(result, {'error_type': 'TimeoutError', 'session_attempt': 2,
                                  'browser_error_code': 'net::ERR_TIMED_OUT',
                                  'payment_failure_reason': 'incorrect_cvc'})


class QuoteRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setup_quote(self):
        clock = Clock()
        page = MagicMock(url='https://chatgpt.com/checkout/openai_ie/oaics_fixture')
        page.locator.return_value.inner_text = AsyncMock(return_value='')
        page.title = AsyncMock(return_value='')
        page.reload = AsyncMock()
        guard = SimpleNamespace(
            result={'returned_currency': 'USD', 'processor_entity': 'openai_ie'},
            checkout_id='oaics_fixture',
        )
        empty = {'plan': None, 'today': None, 'tax': None, 'renewal': None,
                 'renewal_interval': None}
        money = {'amount': '20.00', 'amount_minor': 2000, 'currency': 'USD'}
        valid = {'plan': 'plus', 'today': money, 'tax': {**money, 'amount': '0.00',
                 'amount_minor': 0}, 'renewal': money, 'renewal_interval': 'monthly'}
        return clock, page, guard, empty, valid

    async def run_quote(self, clock, page, guard, reader):
        async def advance(seconds):
            await clock.advance(seconds)
        with patch.object(browser_checkout, 'quote_from_page', new=AsyncMock(side_effect=reader)), \
                patch.object(browser_checkout.asyncio, 'sleep', side_effect=advance), \
                patch.object(browser_checkout, 'progress'):
            return await browser_checkout.quote_with_page_recovery(
                page, guard, 'plus', 'plus', None, None,
                SessionBudget(120, clock=clock), 9,
            )

    async def test_quote_loaded_at_55_seconds_does_not_refresh(self):
        clock, page, guard, empty, valid = self.setup_quote()
        quote, _, meta = await self.run_quote(
            clock, page, guard, lambda *_: valid if clock.now >= 55 else empty,
        )
        self.assertEqual(quote['plan'], 'plus')
        self.assertGreaterEqual(meta['quote_elapsed_seconds'], 55)
        self.assertEqual(meta['quote_refresh_count'], 0)
        page.reload.assert_not_awaited()

    async def test_blank_page_refreshes_once_at_half_budget_then_succeeds(self):
        clock, page, guard, empty, valid = self.setup_quote()
        quote, _, meta = await self.run_quote(
            clock, page, guard, lambda *_: valid if page.reload.await_count else empty,
        )
        self.assertEqual(quote['plan'], 'plus')
        self.assertGreaterEqual(meta['quote_elapsed_seconds'], 60)
        self.assertEqual(meta['quote_refresh_count'], 1)
        page.reload.assert_awaited_once_with(wait_until='domcontentloaded', timeout=0)

    async def test_blank_page_waits_full_120_seconds_after_one_refresh(self):
        clock, page, guard, empty, _ = self.setup_quote()
        quote, _, meta = await self.run_quote(clock, page, guard, lambda *_: empty)
        self.assertIsNone(quote['today'])
        self.assertEqual(meta['quote_elapsed_seconds'], 120)
        self.assertEqual(meta['quote_refresh_count'], 1)
        self.assertEqual(meta['page_state'], 'blank')

    async def test_explicit_proxy_error_refreshes_immediately(self):
        clock, page, guard, empty, valid = self.setup_quote()
        page.locator.return_value.inner_text = AsyncMock(
            side_effect=[RuntimeError('net::ERR_TUNNEL_CONNECTION_FAILED'), '']
        )
        quote, _, meta = await self.run_quote(clock, page, guard, lambda *_: valid)
        self.assertEqual(quote['plan'], 'plus')
        self.assertEqual(meta['quote_refresh_count'], 1)
        self.assertEqual(meta['quote_elapsed_seconds'], 0)


def failure(**patches):
    return {'status': 'blocked', 'reason': 'session_load_timeout', 'stage': 'session_restore',
            'account_matched': False, 'checkout_requests_sent': 0, 'payment_attempted': False,
            'payment_requests_sent': 0, **patches}


class WindowRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.job = connector.LocalJob(payload())
        self.job.root = 'fixture-state'
        self.job.callback = MagicMock()
        self.client = MagicMock()
        self.client.create_profile.side_effect = ['a' * 32, 'b' * 32, 'c' * 32]
        self.client.open_profile.return_value = 'http://127.0.0.1:12345'
        self.client.post.return_value = {}
        self.playwright = SimpleNamespace(chromium=SimpleNamespace(
            connect_over_cdp=AsyncMock(return_value=SimpleNamespace(contexts=[MagicMock()]))))

    async def execute(self, results):
        with patch.object(bitbrowser_retry.pay, 'run_flow', new=AsyncMock(side_effect=results)) as flow:
            result = await bitbrowser_retry.execute_profiles(
                self.job, self.client, SimpleNamespace(account_id='fixture'), self.playwright)
        return result, flow

    def deletions(self):
        return [call.args[1]['id'] for call in self.client.post.call_args_list
                if call.args[0] == '/browser/delete']

    async def test_first_timeout_then_success_reuses_job_and_keeps_successful_window(self):
        result, flow = await self.execute([failure(), {'status': 'session_verified'}])
        self.assertEqual(result['session_attempt'], 2)
        self.assertEqual(flow.await_count, 2)
        self.assertEqual(self.deletions(), ['a' * 32])
        self.assertEqual(self.job.profile_id, 'b' * 32)
        self.assertEqual(self.job.id, payload()['id'])
        self.assertEqual(self.client.create_profile.call_count, 2)
        self.assertEqual([c.args[0] for c in self.client.post.call_args_list],
                         ['/browser/close', '/browser/pids/alive', '/browser/delete'])

    async def test_three_failures_clean_all_three_and_stop(self):
        result, flow = await self.execute([failure(), failure(), failure()])
        self.assertEqual(result['reason'], 'session_retries_exhausted')
        self.assertEqual(flow.await_count, 3)
        self.assertEqual(self.deletions(), ['a' * 32, 'b' * 32])
        self.assertEqual(result.get('payment_requests_sent', 0), 0)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(self.job.profile_id, 'c' * 32)
        self.assertEqual(result['browser_profile_id'], 'c' * 32)

    async def test_blank_quote_failure_rebuilds_window_but_never_replays_payment(self):
        quote_failure = failure(
            reason='actual_quote_unknown', stage='quote_read', account_matched=True,
            checkout_identifier='oaics_fixture', checkout_requests_sent=1,
            page_state='blank', quote_elapsed_seconds=120, quote_wait_seconds=120,
            quote_refresh_count=1,
        )
        result, flow = await self.execute([
            quote_failure, {'status': 'payment_cancelled', 'payment_requests_sent': 0}
        ])
        self.assertEqual(flow.await_count, 2)
        self.assertEqual(self.deletions(), ['a' * 32])
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertEqual(self.client.create_profile.call_count, 2)

    async def test_three_quote_failures_stop_with_specific_prepayment_reason(self):
        quote_failure = failure(
            reason='actual_quote_unknown', stage='quote_read', account_matched=True,
            checkout_identifier='oaics_fixture', checkout_requests_sent=1,
            page_state='blank', quote_elapsed_seconds=120, quote_wait_seconds=120,
            quote_refresh_count=1,
        )
        result, _ = await self.execute([quote_failure, quote_failure, quote_failure])
        self.assertEqual(result['reason'], 'prepayment_retries_exhausted')
        self.assertEqual(result['last_reason'], 'actual_quote_unknown')
        self.assertEqual(self.deletions(), ['a' * 32, 'b' * 32])
        self.assertEqual(self.job.profile_id, 'c' * 32)
        self.assertEqual(result['browser_profile_id'], 'c' * 32)
        self.assertEqual(result['payment_requests_sent'], 0)

    async def test_non_payment_terminal_failure_cleans_owned_window(self):
        result, _ = await self.execute([
            failure(reason='official_plan_menu_timeout', stage='plan_selection',
                    account_matched=True)
        ])
        self.assertEqual(result['reason'], 'official_plan_menu_timeout')
        self.assertEqual(result['browser_profile_id'], 'a' * 32)
        self.assertEqual(self.deletions(), [])

    async def test_user_action_failure_keeps_current_window(self):
        result, _ = await self.execute([
            failure(reason='verification_required', user_action_required=True)
        ])
        self.assertEqual(result['reason'], 'verification_required')
        self.assertEqual(self.deletions(), [])
        self.assertEqual(self.job.profile_id, 'a' * 32)

    async def test_payment_attempt_failure_keeps_current_window(self):
        self.job.payment_request_sent = True
        result, _ = await self.execute([
            failure(reason='payment_operation_failed', stage='payment_result',
                    payment_attempted=True, payment_requests_sent=1)
        ])
        self.assertEqual(result['reason'], 'payment_operation_failed')
        self.assertEqual(self.deletions(), [])
        self.assertEqual(self.job.profile_id, 'a' * 32)

    async def test_cleanup_failure_stops_without_new_profile(self):
        self.client.post.side_effect = Stop('bitbrowser_local_api_unavailable')
        result, _ = await self.execute([failure()])
        self.assertEqual(result['reason'], 'bitbrowser_cleanup_unverified')
        self.assertEqual(self.client.create_profile.call_count, 1)
        self.assertEqual(self.deletions(), [])

    async def test_no_deletion_if_pid_response_has_another_window(self):
        self.client.post.side_effect = [{}, {'other-profile': 42}]
        result, _ = await self.execute([failure()])
        self.assertEqual(result['reason'], 'bitbrowser_cleanup_unverified')
        self.assertEqual(self.deletions(), [])

    async def test_manual_stop_prevents_next_profile(self):
        async def cancelled(*args, **kwargs):
            self.job.signal_cancel()
            return failure(reason='operation_cancelled')
        result, _ = await self.execute(cancelled)
        self.assertEqual(result['reason'], 'operation_cancelled')
        self.assertEqual(self.client.create_profile.call_count, 1)
        self.assertEqual(self.deletions(), ['a' * 32])
        self.assertTrue(result['cancellation_confirmed'])

    async def test_stop_during_cleanup_finishes_owned_cleanup_without_next_window(self):
        def close_then_cancel(path, body):
            self.job.signal_cancel()
            return {}
        self.client.post.side_effect = close_then_cancel
        result, _ = await self.execute([failure()])
        self.assertEqual(result['reason'], 'operation_cancelled')
        self.assertEqual(self.client.create_profile.call_count, 1)
        self.assertEqual(self.deletions(), ['a' * 32])

    async def test_cancel_interrupts_quote_wait_and_cleans_only_owned_window(self):
        stopped = asyncio.Event()
        async def quote_wait(*args, **kwargs):
            self.job.signal_cancel()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        result, flow = await asyncio.wait_for(self.execute(quote_wait), timeout=3)
        self.assertTrue(stopped.is_set())
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(result['browser_cleanup_status'], 'completed')
        self.assertEqual(self.deletions(), ['a' * 32])
        self.assertEqual(result['payment_requests_sent'], 0)

    async def test_cancel_cleanup_failure_is_reported_without_rebuild(self):
        async def cancelled(*args, **kwargs):
            self.job.signal_cancel()
            return failure(reason='operation_cancelled')
        self.client.post.side_effect = Stop('bitbrowser_local_api_unavailable')
        result, _ = await self.execute(cancelled)
        self.assertTrue(result['cancellation_confirmed'])
        self.assertEqual(result['browser_cleanup_status'], 'failed')
        self.assertEqual(result['reason'], 'bitbrowser_cleanup_unverified')
        self.assertEqual(self.client.create_profile.call_count, 1)
        self.assertEqual(self.deletions(), [])

    def test_sent_payment_cannot_be_cancelled_or_cleaned(self):
        self.job.payment_request_sent = True
        with self.assertRaises(Stop):
            self.job.signal_cancel()
        self.assertFalse(self.job.cancelled)

    async def test_zero_retries_cleans_only_the_first_failed_window(self):
        from bitbrowser_options import DEFAULTS
        self.job.payload['bitBrowser']['browserOptions'] = {**DEFAULTS, 'sessionRetryLimit': 0}
        result, flow = await self.execute([failure()])
        self.assertEqual(result['reason'], 'session_retries_exhausted')
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(self.deletions(), [])
        self.assertEqual(self.job.profile_id, 'a' * 32)
        self.assertEqual(result['browser_profile_id'], 'a' * 32)

    async def test_stale_progress_flag_does_not_disable_a_valid_session_retry(self):
        async def after_checkout(*args, **kwargs):
            self.job.progress('session_verified')
            return failure()
        result, _ = await self.execute(after_checkout)
        self.assertEqual(result['reason'], 'session_retries_exhausted')
        self.assertEqual(self.client.create_profile.call_count, 3)
        self.assertEqual(self.deletions(), ['a' * 32, 'b' * 32])
        self.assertEqual(self.job.profile_id, 'c' * 32)
        self.assertEqual(result['browser_profile_id'], 'c' * 32)

    async def test_foreign_profile_is_never_closed_or_deleted(self):
        self.job.profile_id = 'd' * 32
        with self.assertRaises(Stop):
            await bitbrowser_retry.cleanup_profile(self.job, self.client, {'a' * 32})
        self.client.post.assert_not_called()

    async def test_authorized_stale_profile_is_cleaned_before_new_profile_only(self):
        stale = 'd' * 32
        foreign = 'e' * 32
        self.job.stale_profiles = [{
            'sourceJobId': '22222222-2222-4222-8222-222222222222',
            'profileId': stale,
        }]
        self.client.list_profile_ids.return_value = {stale, foreign}
        result, _ = await self.execute([{'status': 'payment_cancelled'}])
        self.assertEqual(result['status'], 'payment_cancelled')
        self.assertEqual(self.deletions(), [stale])
        self.assertNotIn(foreign, self.deletions())
        self.assertEqual(self.job.stale_profiles_cleaned, 1)
        self.job.callback.send.assert_any_call({
            'type': 'stale_profile_cleanup',
            'accountKey': self.job.account_key,
            'profiles': self.job.stale_profiles,
        })

    async def test_missing_stale_profile_is_idempotently_acknowledged(self):
        self.job.stale_profiles = [{
            'sourceJobId': '22222222-2222-4222-8222-222222222222',
            'profileId': 'd' * 32,
        }]
        self.client.list_profile_ids.return_value = set()
        await self.execute([{'status': 'payment_cancelled'}])
        self.assertEqual(self.deletions(), [])
        self.assertEqual(self.job.stale_profiles_cleaned, 1)

    async def test_stale_cleanup_failure_stops_before_new_profile(self):
        self.job.stale_profiles = [{
            'sourceJobId': '22222222-2222-4222-8222-222222222222',
            'profileId': 'd' * 32,
        }]
        self.client.list_profile_ids.return_value = {'d' * 32}
        self.client.post.side_effect = Stop('bitbrowser_local_api_unavailable')
        with self.assertRaises(Stop) as caught:
            await self.execute([{'status': 'payment_cancelled'}])
        self.assertEqual(caught.exception.report['reason'], 'bitbrowser_cleanup_unverified')
        self.client.create_profile.assert_not_called()

    def test_auth_verification_and_side_effects_never_trigger_rebuild(self):
        for patch_value in ({'reason': 'json_session_not_restored'}, {'reason': 'verification_required'},
                            {'user_action_required': True}, {'checkout_requests_sent': 1},
                            {'payment_requests_sent': 1}, {'payment_attempted': True},
                            {'confirmation_requests_sent': 1}, {'stage': 'quote_read'},
                            {'account_matched': True}, {'reason': 'browser_operation_failed',
                                                        'error_type': 'TargetClosedError'}):
            with self.subTest(patch=patch_value):
                self.assertFalse(retryable_session_result(failure(**patch_value)))
        self.assertTrue(retryable_session_result(failure(reason='browser_operation_failed',
                                                         browser_error_code='net::ERR_PROXY_CONNECTION_FAILED')))


if __name__ == '__main__':
    unittest.main()
