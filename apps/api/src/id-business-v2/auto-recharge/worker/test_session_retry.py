"""Virtual-clock and isolated client fixtures; no real profiles or payment requests."""
import asyncio
import json
import shutil
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import browser_checkout
import bitbrowser_retry
import bitbrowser_connector as connector
from browser_session import SessionBudget, retryable_session_result, session_failure, retryable_page_load_error
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
    @unittest.skipUnless(shutil.which('node'), 'Repository Node.js runtime is required')
    async def test_browser_read_supports_noniterable_headers_and_preserves_error_evidence(self):
        runner = '''
            let raw='';process.stdin.on('data',chunk=>raw+=chunk);process.stdin.on('end',async()=>{
                const input=JSON.parse(raw);
                global.fetch=async()=>({status:input.status,text:async()=>input.body,
                    headers:{get:name=>input.headers[name]??null,
                             entries:()=>{throw new TypeError('Headers iterator is not iterable');}}});
                const result=await eval('('+input.source+')')(input.args);
                process.stdout.write(JSON.stringify(result));
            });
        '''
        for status in (200, 400, 403):
            async def evaluate(source, args):
                completed = subprocess.run(
                    [shutil.which('node'), '-e', runner],
                    input=json.dumps({'source': source, 'args': args, 'status': status,
                                      'body': '{"ok":true}' if status == 200 else '{"error":{"code":"fixture_error"}}',
                                      'headers': {'cf-mitigated': 'challenge' if status == 403 else None,
                                                  'x-request-id': 'fixture-request-id', 'cf-ray': 'fixture-ray-id'}}),
                    text=True, capture_output=True, timeout=5, check=True)
                return json.loads(completed.stdout)
            page = SimpleNamespace(url='https://chatgpt.com/', evaluate=evaluate)
            with self.subTest(status=status):
                if status == 200:
                    self.assertEqual(await browser_checkout.browser_read(
                        page, '/api/auth/session', budget=SessionBudget(60)), {'ok': True})
                else:
                    with self.assertRaises(Stop) as stopped:
                        await browser_checkout.browser_read(page, '/api/auth/session', budget=SessionBudget(60))
                    report = stopped.exception.report
                    self.assertEqual(report['reason'], 'verification_required' if status == 403 else 'http_error')
                    self.assertEqual(report['http_status'], status)
                    self.assertEqual(report['x_request_id'], 'fixture-request-id')
                    self.assertEqual(report['cf_ray'], 'fixture-ray-id')
                    self.assertEqual(report['challenge_observed'], status == 403)

    async def test_exit_observation_does_not_swallow_cancellation(self):
        page = MagicMock(evaluate=AsyncMock())
        budget = SessionBudget(60, cancelled=lambda: True)
        with self.assertRaises(Stop) as cancelled:
            await browser_checkout.observe_page_network(page, budget)
        self.assertEqual(cancelled.exception.report['reason'], 'operation_cancelled')
        page.evaluate.assert_not_awaited()

    async def test_page_and_both_reads_share_120_seconds_not_45_or_25(self):
        clock, report = Clock(), MagicMock()
        budget = SessionBudget(120, clock=clock, report=report)
        page = MagicMock()
        page.goto = AsyncMock(side_effect=lambda *a, **kw: None)

        async def goto(*args, **kwargs):
            self.assertEqual(kwargs['timeout'], 0)
            self.assertEqual(kwargs['wait_until'], 'commit')
            await clock.advance(50)

        page.goto.side_effect = goto
        context = MagicMock()
        context.route = AsyncMock()
        context.unroute = AsyncMock()
        context.route_web_socket = AsyncMock()
        context.new_page = AsyncMock(return_value=page)
        context.add_cookies = AsyncMock()
        context.clear_cookies = AsyncMock()

        async def check(_page, _target, _wait, current, *, initial_restore=False):
            self.assertTrue(initial_restore)
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
            clear_cookies=AsyncMock(),
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
        page.reload.assert_awaited_once_with(wait_until='commit', timeout=0)
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

    async def test_phase_restart_cannot_extend_shared_preparation_deadline(self):
        clock = Clock()
        parent = SessionBudget(600, clock=clock)
        budget = SessionBudget(120, clock=clock, parent=parent)
        await clock.advance(550)
        restarted = budget.restart()
        self.assertIs(restarted.parent, parent)
        self.assertEqual(restarted.remaining_ms(), 50000)
        await clock.advance(50)
        with self.assertRaises(Stop):
            restarted.remaining_ms()

    async def test_human_wait_is_excluded_from_child_and_shared_preparation(self):
        clock = Clock()
        parent = SessionBudget(600, clock=clock)
        budget = SessionBudget(120, clock=clock, parent=parent)
        await budget.human_wait(lambda: clock.advance(900))
        self.assertEqual(parent.remaining_ms(), 600000)
        self.assertEqual(budget.remaining_ms(), 120000)

    async def test_owned_identity_wait_pauses_outer_deadline_while_human_wait_is_pending(self):
        clock, entered, resume = Clock(), asyncio.Event(), asyncio.Event()
        parent = SessionBudget(600, clock=clock)
        child = SessionBudget(120, clock=clock, parent=parent)
        async def human():
            clock.now = 900
            entered.set()
            await resume.wait()
            return 'verified'
        task = asyncio.create_task(parent.run(lambda: child.human_wait(human), 'owned_identity'))
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            self.assertEqual(parent.remaining_ms(), 600000)
            self.assertEqual(child.remaining_ms(), 120000)
            resume.set()
            self.assertEqual(await asyncio.wait_for(task, timeout=2), 'verified')
            self.assertEqual(parent.paused, 900)
            self.assertEqual(parent.human_pause_depth, 0)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_nested_human_waits_pause_ancestor_once(self):
        clock = Clock()
        parent = SessionBudget(600, clock=clock)
        child = SessionBudget(120, clock=clock, parent=parent)
        await child.human_wait(lambda: parent.human_wait(lambda: clock.advance(900)))
        self.assertEqual(parent.paused, 900)
        self.assertEqual(child.paused, 900)
        self.assertEqual(parent.remaining_ms(), 600000)

    async def test_cancellation_interrupts_pending_human_wait_and_restores_pause_state(self):
        clock, entered = Clock(), asyncio.Event()
        flag = {'cancelled': False}
        parent = SessionBudget(600, clock=clock, cancelled=lambda: flag['cancelled'])
        child = SessionBudget(120, clock=clock, parent=parent)
        async def human():
            clock.now = 900
            entered.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(parent.run(lambda: child.human_wait(human), 'owned_identity'))
        await asyncio.wait_for(entered.wait(), timeout=2)
        flag['cancelled'] = True
        with self.assertRaises(Stop) as stopped:
            await asyncio.wait_for(task, timeout=2)
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertEqual(parent.human_pause_depth, 0)
        self.assertIsNone(parent.human_pause_started)

    async def test_network_observation_deadline_blocks_before_checkout(self):
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
                            new_page=AsyncMock(return_value=page), add_cookies=AsyncMock(), clear_cookies=AsyncMock())
        identity = {'account_matched': True, 'current_plan': 'free', 'session_status': 'restored'}
        with patch.object(browser_checkout, 'session_cookies', return_value=[]), \
                patch.object(browser_checkout, 'check_session', new=AsyncMock(return_value=(None, identity))), \
                patch.object(browser_checkout, 'progress'), \
                patch.dict('os.environ', {'AUTO_RECHARGE_CALLBACK_URL': 'fixture'}):
            result = await browser_checkout.workflow(context, SimpleNamespace(), session_budget=budget)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['reason'], 'session_load_timeout')
        self.assertTrue(result['account_matched'])
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
                patch.object(browser_checkout, 'official_subscription', return_value={'current_plan': 'free'}):
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


class SessionRefreshWaitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import checkout_core
        from test_subscribe import account, fixture
        self.clock = Clock()
        self.cancelled = False
        self.cancel_during_sleep = False
        self.expired = json.loads(fixture(expired=True))
        self.current = json.loads(fixture())
        self.target = checkout_core.parse_browser_credential(fixture(expired=True))
        self.account = account()
        self.reads = []

    async def run_check(self, responses, *, seconds=120, initial_restore=True, with_budget=True):
        values = iter(responses)
        last = None
        self.budget = SessionBudget(seconds, clock=self.clock, cancelled=lambda: self.cancelled)
        budget = self.budget if with_budget else None
        async def read(page, path, credential=None, budget=None, *, timeout_ms=None):
            nonlocal last
            self.assertIs(budget, self.budget if with_budget else None)
            if timeout_ms is not None:
                self.assertGreater(timeout_ms, 0)
                self.assertLessEqual(timeout_ms, (15 - self.clock.now) * 1000)
            self.reads.append(path)
            if path in ('/api/auth/session', browser_checkout.SESSION_REFRESH_PATH):
                last = next(values, last)
                if isinstance(last, Stop):
                    raise last
                return last
            return self.account
        async def sleep(seconds):
            await self.clock.advance(seconds)
            if self.cancel_during_sleep:
                self.cancelled = True
        self.reader = AsyncMock(side_effect=read)
        self.wait = AsyncMock()
        with patch.object(browser_checkout, 'browser_read', new=self.reader), \
                patch.object(browser_checkout.asyncio, 'sleep', side_effect=sleep), \
                patch.object(browser_checkout, 'wait_for_user', new=self.wait):
            return await browser_checkout.check_session(
                SimpleNamespace(title=AsyncMock(return_value='ChatGPT')), self.target,
                budget=budget, initial_restore=initial_restore)

    async def test_initial_expired_session_waits_for_valid_token_then_checks_official_account(self):
        refreshed, identity = await self.run_check([self.expired, self.expired, self.current])
        self.assertEqual(self.clock.now, 2)
        self.assertEqual(refreshed.account_id, self.target.account_id)
        self.assertTrue(identity['account_matched'])
        self.assertTrue(identity['credential_refreshed'])
        self.assertEqual(identity['current_plan'], 'free')
        self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH,
                                      '/api/auth/session', browser_checkout.ACCOUNT_PATH])

    async def test_refresh_request_uses_exact_official_same_origin_get_without_extra_headers(self):
        expected_path = ('/api/auth/session?refresh=true&reason=token_expired&method=GET'
                         '&path=%2Fapi%2Fauth%2Fsession')
        self.assertEqual(browser_checkout.SESSION_REFRESH_PATH, expected_path)
        page = SimpleNamespace(url='https://chatgpt.com/', evaluate=AsyncMock(return_value={
            'status': 200, 'headers': {}, 'raw': json.dumps(self.current)}))
        budget = SessionBudget(15, clock=self.clock)
        response = await browser_checkout.browser_read(page, expected_path, budget=budget, timeout_ms=8000)
        self.assertEqual(response, self.current)
        arguments = page.evaluate.call_args.args[1]
        self.assertEqual(arguments['path'], expected_path)
        self.assertEqual(arguments['headers'], {'Accept': 'application/json'})
        self.assertEqual(arguments['timeoutMs'], 8000)

    async def test_explicit_refresh_failure_stops_even_if_response_includes_a_valid_token(self):
        failed = {**self.current, 'error': 'RefreshAccessTokenError'}
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired, failed, self.current])
        self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
        self.assertEqual(self.clock.now, 1)
        self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH])
        self.wait.assert_not_awaited()

    def test_valid_official_token_with_session_error_is_never_verified_or_logged(self):
        import checkout_core
        for error, reason in (
            ('RefreshAccessTokenError', 'access_token_expired'),
            ('PRIVATE_SERVER_ERROR_NOT_TO_PRINT', 'json_session_not_restored'),
            ({'private': 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT'}, 'json_session_not_restored'),
        ):
            with self.subTest(reason=reason):
                with self.assertRaises(Stop) as stopped:
                    checkout_core.verify_official_session({**self.current, 'error': error}, self.target)
                self.assertEqual(stopped.exception.report['reason'], reason)
                serialized = json.dumps(stopped.exception.report)
                for private in ('RefreshAccessTokenError', 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT',
                                self.current['accessToken'], self.target.session_token):
                    self.assertNotIn(private, serialized)

    async def test_initial_explicit_refresh_error_stops_without_wait_or_refresh_get(self):
        for initial in (self.expired, self.current):
            with self.subTest(expired=initial is self.expired):
                self.setUp()
                failed = {**initial, 'error': 'RefreshAccessTokenError'}
                with self.assertRaises(Stop) as stopped:
                    await self.run_check([failed, self.current])
                self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
                self.assertEqual(self.clock.now, 0)
                self.assertEqual(self.reads, ['/api/auth/session'])
                self.wait.assert_not_awaited()

    async def test_other_session_error_stops_at_initial_or_refresh_get(self):
        for responses, elapsed in (
            ([{**self.current, 'error': 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT'}], 0),
            ([self.expired, {**self.current, 'error': 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT'}], 1),
        ):
            with self.subTest(elapsed=elapsed):
                self.setUp()
                with self.assertRaises(Stop) as stopped:
                    await self.run_check(responses + [self.current])
                self.assertEqual(stopped.exception.report['reason'], 'json_session_not_restored')
                self.assertEqual(self.clock.now, elapsed)
                self.assertEqual(self.reads, ['/api/auth/session'] +
                                 ([browser_checkout.SESSION_REFRESH_PATH] if elapsed else []))
                self.assertNotIn('PRIVATE_SERVER_ERROR_NOT_TO_PRINT', json.dumps(stopped.exception.report))
                self.wait.assert_not_awaited()

    async def test_continuously_expired_session_stops_at_15_seconds_without_account_read(self):
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired])
        self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
        self.assertEqual(self.clock.now, 15)
        self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH]
                                    + ['/api/auth/session'] * 13)
        for secret in (self.target.old_token, self.target.session_token):
            self.assertNotIn(secret, json.dumps(stopped.exception.report))

    async def test_refresh_wait_never_extends_original_budget_or_turns_expiry_into_network_retry(self):
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired], seconds=3)
        self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
        self.assertEqual(self.clock.now, 3)
        self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH,
                                      '/api/auth/session'])

    async def test_cancel_during_refresh_wait_stops_before_next_get(self):
        self.cancel_during_sleep = True
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired, self.current])
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        self.assertEqual(self.reads, ['/api/auth/session'])

    async def test_refresh_poll_403_and_identity_mismatch_are_never_swallowed(self):
        from test_subscribe import fixture
        for response, reason in (
            (Stop('verification_required', http_status=403), 'verification_required'),
            (json.loads(fixture(user_id='other-user')), 'official_user_mismatch'),
            ({}, 'json_session_not_restored'),
        ):
            with self.subTest(reason=reason):
                self.setUp()
                with self.assertRaises(Stop) as stopped:
                    await self.run_check([self.expired, response])
                self.assertEqual(stopped.exception.report['reason'], reason)
                self.assertEqual(self.clock.now, 1)
                self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH])
                self.wait.assert_not_awaited()

    async def test_identity_rechecks_and_unbudgeted_calls_reject_expiry_immediately(self):
        for settings in ({'initial_restore': False}, {'with_budget': False}):
            with self.subTest(settings=settings):
                self.setUp()
                with self.assertRaises(Stop) as stopped:
                    await self.run_check([self.expired, self.current], **settings)
                self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
                self.assertEqual(self.clock.now, 0)
                self.assertEqual(self.reads, ['/api/auth/session'])

    async def test_refreshed_token_still_requires_original_account(self):
        from dataclasses import replace
        self.target = replace(self.target, account_id='different-account')
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired, self.current])
        self.assertEqual(stopped.exception.report['reason'], 'official_account_mismatch')
        self.assertEqual(self.reads, ['/api/auth/session', browser_checkout.SESSION_REFRESH_PATH])

    async def test_non_json_sessions_do_not_enter_expiry_wait(self):
        from dataclasses import replace
        self.target = replace(self.target, session_token='')
        with self.assertRaises(Stop) as stopped:
            await self.run_check([self.expired, self.current])
        self.assertEqual(stopped.exception.report['reason'], 'access_token_expired')
        self.assertEqual(self.clock.now, 0)
        self.assertEqual(self.reads, ['/api/auth/session'])

    async def test_expiry_wait_keeps_workflow_unverified_and_sends_no_checkout_or_payment(self):
        for session, reason, elapsed in (
            (self.expired, 'access_token_expired', 15),
            ({**self.current, 'error': 'RefreshAccessTokenError'}, 'access_token_expired', 0),
            ({**self.current, 'error': 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT'}, 'json_session_not_restored', 0),
        ):
            with self.subTest(reason=reason, elapsed=elapsed):
                self.setUp()
                page = MagicMock(url='about:blank', title=AsyncMock(return_value='ChatGPT'),
                                 goto=AsyncMock(return_value=SimpleNamespace(status=200)))
                context = MagicMock(pages=[], route=AsyncMock(), unroute=AsyncMock(),
                                    route_web_socket=AsyncMock(), add_cookies=AsyncMock(), clear_cookies=AsyncMock(),
                                    new_page=AsyncMock(return_value=page))
                guard = browser_checkout.NetworkGuard(self.target)
                budget = SessionBudget(120, clock=self.clock)
                async def read(*args, **kwargs):
                    self.assertFalse(guard.account_verified)
                    self.assertIn(args[1], ('/api/auth/session', browser_checkout.SESSION_REFRESH_PATH))
                    return session
                with patch.object(browser_checkout, 'browser_read', new=AsyncMock(side_effect=read)), \
                        patch.object(browser_checkout.asyncio, 'sleep', side_effect=self.clock.advance), \
                        patch.object(browser_checkout, 'progress'), patch.dict('os.environ', {}, clear=True):
                    result = await browser_checkout.workflow(
                        context, self.target, session_budget=budget, guard_factory=lambda *_: guard)
                self.assertEqual(result['reason'], reason)
                self.assertEqual(result['stage'], 'session_restore')
                self.assertFalse(result['account_matched'])
                self.assertFalse(guard.account_verified)
                self.assertEqual(result['checkout_requests_sent'], 0)
                self.assertEqual(result['payment_requests_sent'], 0)
                self.assertEqual(self.clock.now, elapsed)
                for secret in (self.target.old_token, self.target.session_token,
                               'RefreshAccessTokenError', 'PRIVATE_SERVER_ERROR_NOT_TO_PRINT'):
                    self.assertNotIn(secret, json.dumps(result))


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

    async def test_body_title_and_quote_reads_cannot_accept_results_after_phase_deadline(self):
        for delayed in ('body', 'title', 'quote'):
            with self.subTest(delayed=delayed):
                clock, page, guard, _, valid = self.setup_quote()
                async def slow_body():
                    await clock.advance(121)
                    return ''
                async def reader(*_):
                    if delayed == 'quote':
                        await clock.advance(121)
                    return valid
                if delayed == 'body':
                    page.locator.return_value.inner_text.side_effect = slow_body
                elif delayed == 'title':
                    page.title.side_effect = slow_body
                with self.assertRaises(Stop) as stopped:
                    await self.run_quote(clock, page, guard, reader)
                report = stopped.exception.report
                self.assertEqual(report['reason'], 'checkout_page_load_timeout')
                self.assertEqual(report['quote_elapsed_seconds'], 120)
                self.assertNotIn('quote', report)
                page.reload.assert_not_awaited()

    async def test_quote_read_uses_remaining_budget_after_slow_body_read(self):
        clock, page, guard, _, valid = self.setup_quote()
        async def body():
            await clock.advance(119)
            return ''
        async def quote(*_):
            await clock.advance(5)
            return valid
        page.locator.return_value.inner_text.side_effect = body
        with self.assertRaises(Stop) as stopped:
            await self.run_quote(clock, page, guard, quote)
        self.assertEqual(stopped.exception.report['reason'], 'checkout_page_load_timeout')
        self.assertEqual(stopped.exception.report['quote_elapsed_seconds'], 120)

    async def test_quote_extraction_keeps_parent_deadline_and_cancellation(self):
        for cancellation in (False, True):
            with self.subTest(cancellation=cancellation):
                clock, page, guard, _, valid = self.setup_quote()
                flag = {'cancelled': False}
                parent = SessionBudget(10, clock=clock, cancelled=lambda: flag['cancelled'])
                child = SessionBudget(120, clock=clock, cancelled=parent.cancelled, parent=parent)
                async def reader(*_):
                    await clock.advance(11)
                    flag['cancelled'] = cancellation
                    return valid
                with patch.object(browser_checkout, 'quote_from_page', new=AsyncMock(side_effect=reader)), \
                        patch.object(browser_checkout, 'progress'):
                    with self.assertRaises(Stop) as stopped:
                        await browser_checkout.quote_with_page_recovery(
                            page, guard, 'plus', 'plus', None, None, child, 9)
                self.assertEqual(stopped.exception.report['reason'],
                                 'operation_cancelled' if cancellation else 'checkout_page_load_timeout')
                page.reload.assert_not_awaited()


def failure(**patches):
    return {'status': 'blocked', 'reason': 'session_load_timeout', 'stage': 'session_restore',
            'account_matched': False, 'checkout_requests_sent': 0, 'payment_attempted': False,
            'payment_requests_sent': 0, **patches}


class CriticalReadEvidenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.listeners = {}
        self.frame = object()
        self.page = SimpleNamespace(url='https://chatgpt.com/', main_frame=self.frame,
                                    on=lambda name, handler: self.listeners.update({name: handler}),
                                    remove_listener=lambda name, handler: self.listeners.pop(name, None))

    def request(self, **changes):
        return SimpleNamespace(**{'method': 'GET', 'url': 'https://chatgpt.com/api/auth/session',
                                  'frame': self.frame, 'failure': 'net::ERR_PROXY_CONNECTION_FAILED', **changes})

    async def failed_read(self, request, *, path='/api/auth/session', started=True, error='network'):
        async def evaluate(*_):
            if started and self.listeners.get('request'):
                self.listeners['request'](request)
            if self.listeners.get('requestfailed'):
                self.listeners['requestfailed'](request)
            return {'read_error': error}
        self.page.evaluate = evaluate
        budget = SessionBudget(120)
        budget.step = 'session_read'
        with self.assertRaises(Stop) as stopped:
            await browser_checkout.browser_read(self.page, path, budget=budget)
        self.assertEqual(self.listeners, {})
        return stopped.exception.report

    def recovery_allowed(self, report):
        from bitbrowser_options import DEFAULTS
        job = connector.LocalJob(payload())
        job.profile_id = 'a' * 32
        return bitbrowser_retry.proxy_reopen_allowed(job, SimpleNamespace(session_token='fixture'),
            {**report, 'session_step': 'session_read'}, DEFAULTS, {job.profile_id})

    async def test_current_main_frame_auth_and_account_fixed_network_failure_allows_same_profile_recovery(self):
        for path in ('/api/auth/session', browser_checkout.ACCOUNT_PATH):
            with self.subTest(path=path):
                report = await self.failed_read(self.request(url='https://chatgpt.com' + path), path=path)
                self.assertEqual(report['browser_error_code'], 'net::ERR_PROXY_CONNECTION_FAILED')
                self.assertTrue(self.recovery_allowed(report))

    async def test_background_frame_wrong_method_origin_path_query_and_stale_requests_are_not_evidence(self):
        for changed, started in (({'frame': object()}, True), ({'method': 'POST'}, True),
                                 ({'url': 'https://other.example/api/auth/session'}, True),
                                 ({'url': 'https://chatgpt.com/backend-api/conversation'}, True),
                                 ({'url': 'https://chatgpt.com/api/auth/session?private=fixture'}, True),
                                 ({}, False)):
            with self.subTest(changed=list(changed), started=started):
                report = await self.failed_read(self.request(**changed), started=started)
                self.assertNotIn('browser_error_code', report)
                self.assertFalse(self.recovery_allowed(report))
                self.assertNotIn('private=fixture', json.dumps(report))

    async def test_cors_abort_unknown_failure_and_read_timeout_without_fixed_code_do_not_rotate(self):
        for code, error in (('net::ERR_FAILED', 'network'), ('net::ERR_ABORTED', 'network'),
                            (None, 'network'), ('net::ERR_ABORTED', 'timeout')):
            with self.subTest(code=code, error=error):
                report = await self.failed_read(self.request(failure=code), error=error)
                self.assertNotIn('browser_error_code', report)
                self.assertFalse(self.recovery_allowed(report))

    async def test_http_verification_has_priority_over_transport_event(self):
        request = self.request()
        async def evaluate(*_):
            self.listeners['request'](request)
            self.listeners['requestfailed'](request)
            return {'status': 403, 'headers': {'cf-mitigated': 'challenge'}, 'raw': '{}'}
        self.page.evaluate = evaluate
        with self.assertRaises(Stop) as stopped:
            await browser_checkout.browser_read(self.page, '/api/auth/session', budget=SessionBudget(120))
        report = stopped.exception.report
        self.assertEqual(report['reason'], 'verification_required')
        self.assertFalse(self.recovery_allowed(report))
        self.assertEqual(self.listeners, {})

    async def test_listener_cleanup_happens_when_evaluate_raises_or_task_is_cancelled(self):
        for failure in (RuntimeError('synthetic-private-error'), asyncio.CancelledError()):
            with self.subTest(error=type(failure).__name__):
                self.page.evaluate = AsyncMock(side_effect=failure)
                with self.assertRaises(type(failure)):
                    await browser_checkout.browser_read(self.page, '/api/auth/session', budget=SessionBudget(120))
                self.assertEqual(self.listeners, {})


class CookieInstallationTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_single_and_chunks_are_removed_before_new_cookie_and_other_state_is_preserved(self):
        cookies = [
            ('chatgpt.com', '__Secure-next-auth.session-token'),
            ('.chatgpt.com', '__Secure-next-auth.session-token.0'),
            ('.chatgpt.com', '__Secure-next-auth.session-token.19'),
            ('chatgpt.com', '__Secure-next-auth.session-token-shadow'),
            ('chatgpt.com', '__Host-next-auth.csrf-token'),
            ('auth.openai.com', '__Secure-next-auth.session-token'),
            ('otherchatgpt.com', '__Secure-next-auth.session-token.0'),
        ]
        events = []
        async def clear(**rules):
            events.append('clear')
            cookies[:] = [(domain, name) for domain, name in cookies
                          if not (rules['domain'].fullmatch(domain) and rules['name'].fullmatch(name))]
        async def add(values):
            events.append('add')
            self.assertEqual(len(values), 1)
            self.assertEqual(values[0]['name'], '__Secure-next-auth.session-token')
        context = SimpleNamespace(clear_cookies=AsyncMock(side_effect=clear), add_cookies=AsyncMock(side_effect=add))
        await browser_checkout.install_session_cookies(context, SimpleNamespace(session_token='synthetic-short'))
        self.assertEqual(events, ['clear', 'add'])
        self.assertEqual(cookies, [('chatgpt.com', '__Secure-next-auth.session-token-shadow'),
                                   ('chatgpt.com', '__Host-next-auth.csrf-token'),
                                   ('auth.openai.com', '__Secure-next-auth.session-token'),
                                   ('otherchatgpt.com', '__Secure-next-auth.session-token.0')])

    async def test_cancelled_installation_never_reads_or_injects_credentials(self):
        context = SimpleNamespace(clear_cookies=AsyncMock(), add_cookies=AsyncMock())
        with self.assertRaises(Stop):
            await browser_checkout.install_session_cookies(context, SimpleNamespace(),
                                                            budget=SessionBudget(120, cancelled=lambda: True))
        context.clear_cookies.assert_not_awaited()
        context.add_cookies.assert_not_awaited()

    async def test_cancellation_during_clear_prevents_cookie_add(self):
        flag = {'cancelled': False}
        async def clear(**_):
            flag['cancelled'] = True
        context = SimpleNamespace(clear_cookies=AsyncMock(side_effect=clear), add_cookies=AsyncMock())
        with self.assertRaises(Stop):
            await browser_checkout.install_session_cookies(context, SimpleNamespace(),
                                                            budget=SessionBudget(120, cancelled=lambda: flag['cancelled']))
        context.clear_cookies.assert_awaited_once()
        context.add_cookies.assert_not_awaited()


class WindowRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from bitbrowser_options import DEFAULTS
        self.job = connector.LocalJob(payload())
        self.job.payload['bitBrowser']['browserOptions'] = {**DEFAULTS, 'sessionRetryLimit': 2}
        self.job.root = 'fixture-state'
        self.job.callback = MagicMock()
        self.client = MagicMock()
        self.client.create_profile.return_value = 'a' * 32
        self.client.open_profile.return_value = 'http://127.0.0.1:12345'
        self.client.post.return_value = {}
        self.context = MagicMock(pages=[], route=AsyncMock(), unroute=AsyncMock(),
                                 route_web_socket=AsyncMock(), add_cookies=AsyncMock(), clear_cookies=AsyncMock())
        self.playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(
            return_value=SimpleNamespace(contexts=[self.context], version='152.0.0'))))
        self.target = SimpleNamespace(account_id='fixture', user_id='fixture-user',
                                      session_token='synthetic-secret')
        self.probe = AsyncMock(return_value={'observed_country': 'US'})

    async def execute(self, results, *, continuation=None):
        with (patch('browser_checkout.prepare_proxy_in_context', self.probe, create=True),
              patch.object(bitbrowser_retry.pay, 'run_flow', AsyncMock(side_effect=results)) as flow,
              patch.object(bitbrowser_retry.pay, 'run_checkout_flow', AsyncMock(side_effect=continuation)) as resumed,
              patch.object(bitbrowser_retry.asyncio, 'sleep', AsyncMock())):
            result = await bitbrowser_retry.execute_profiles(self.job, self.client, self.target, self.playwright)
        return result, flow, resumed

    def network(self, **changed):
        return failure(reason='session_network_error', session_step='page_load',
                       browser_error_code='net::ERR_CONNECTION_CLOSED', **changed)

    def paths(self):
        return [call.args[0] for call in self.client.post.call_args_list]

    def assert_same_profile(self, opens):
        self.assertEqual(self.client.create_profile.call_count, 1)
        self.assertEqual(self.job.profile_id, 'a' * 32)
        self.assertEqual(self.client.open_profile.call_count, opens)
        self.assertEqual(set(call.args[0] for call in self.client.open_profile.call_args_list), {'a' * 32})
        self.assertNotIn('/browser/delete', self.paths())

    async def test_transport_failure_reopens_same_profile_only_after_pid_exit(self):
        profile = 'a' * 32
        self.client.post.side_effect = [{}, {profile: 42}, {}]
        result, flow, _ = await self.execute([
            self.network(), {'status': 'session_verified', 'payment_requests_sent': 0}])
        self.assert_same_profile(2)
        self.assertEqual(self.paths(), ['/browser/close', '/browser/pids/alive', '/browser/pids/alive'])
        self.assertEqual(self.client.open_profile.call_args_list[1].kwargs, {'extract_ip': True})
        self.assertEqual(result['session_attempt'], 2)
        self.assertEqual(result['session_attempt_limit'], 3)
        budgets = [call.kwargs['session_budget'] for call in flow.call_args_list]
        self.assertIs(budgets[0].parent, budgets[1].parent)
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.assertEqual(self.probe.await_count, 2)

    async def test_ten_total_attempts_share_one_profile_and_one_parent_budget(self):
        self.job.payload['bitBrowser']['browserOptions']['sessionRetryLimit'] = 9
        result, flow, _ = await self.execute([self.network()] * 10)
        self.assert_same_profile(10)
        self.assertEqual(flow.await_count, 10)
        self.assertEqual(result['reason'], 'proxy_retry_exhausted')
        self.assertEqual(result['last_reason'], 'session_network_error')
        self.assertEqual(result['session_attempt'], 10)
        self.assertEqual(result['session_attempt_limit'], 10)
        self.assertEqual(len({id(call.kwargs['session_budget'].parent) for call in flow.call_args_list}), 1)
        self.assertTrue(all(call.kwargs['session_budget'].parent.seconds == 600 for call in flow.call_args_list))

    async def test_verified_account_can_recover_a_later_bad_ip_without_new_profile(self):
        calls = 0
        async def flow(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.job.progress('session_verified', account_matched=True)
                return self.network(stage='plan_selection', account_matched=True)
            return self.network() if calls == 2 else {'status': 'session_verified'}
        result, ran, _ = await self.execute(flow)
        self.assertEqual(result['status'], 'session_verified')
        self.assertEqual(ran.await_count, 3)
        self.assert_same_profile(3)

    async def test_limit_is_shared_between_session_and_original_checkout_recovery(self):
        checkout = self.network(stage='quote_read', account_matched=True,
                                checkout_identifier='oaics_fixture', checkout_requests_sent=1)
        result, flow, resumed = await self.execute([self.network(), checkout], continuation=[checkout])
        self.assert_same_profile(3)
        self.assertEqual(flow.await_count, 2)
        resumed.assert_awaited_once()
        self.assertEqual(resumed.call_args.kwargs['expected_checkout_identifier'], 'oaics_fixture')
        self.assertFalse(resumed.call_args.kwargs['allow_checkout_replacement'])
        self.assertEqual(result['reason'], 'proxy_retry_exhausted')
        self.assertEqual(result['checkout_requests_sent'], 1)

    async def test_original_checkout_continuation_does_not_reset_cumulative_create_count(self):
        checkout = self.network(stage='quote_read', account_matched=True,
                                checkout_identifier='oaics_fixture', checkout_requests_sent=1)
        result, flow, resumed = await self.execute([checkout], continuation=[{
            'status': 'payment_cancelled', 'checkout_identifier': 'oaics_fixture',
            'checkout_requests_sent': 0, 'payment_requests_sent': 0}])
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(resumed.await_count, 1)
        self.assertEqual(result['checkout_requests_sent'], 1)

    async def test_manual_new_job_uses_trusted_original_checkout_on_first_flow(self):
        self.job.original_checkout_identifier = 'oaics_previous_job'
        self.job.owned_profile = {'profileId': 'a' * 32, 'accountKey': 'c' * 64,
                                  'sourceJobId': '22222222-2222-4222-8222-222222222222'}
        self.client.post.return_value = {'id': 'a' * 32}
        with patch.object(bitbrowser_retry, 'reuse_owned_profile', AsyncMock(return_value=self.target)):
            result, flow, resumed = await self.execute([], continuation=[{
                'status': 'session_verified', 'checkout_identifier': 'oaics_previous_job',
                'checkout_requests_sent': 0}])
        self.assertEqual(result['status'], 'session_verified')
        flow.assert_not_awaited()
        resumed.assert_awaited_once()
        self.assertEqual(resumed.call_args.kwargs['expected_checkout_identifier'], 'oaics_previous_job')
        self.assertFalse(resumed.call_args.kwargs['allow_checkout_replacement'])
        self.client.create_profile.assert_not_called()
        self.client.open_profile.assert_called_once()

    async def test_password_restore_bound_original_checkout_is_used_before_flow(self):
        self.job.payload.pop('sessionJson', None)
        self.job.payload['login'] = {'email': 'fixture@example.invalid', 'password': 'synthetic'}
        page = MagicMock(url='about:blank')
        self.context.pages = [page]
        self.job.context = self.context
        def restore(_):
            self.job.original_checkout_identifier = 'oaics_password_previous'
        self.job.restore_account = restore
        with (patch.object(bitbrowser_retry.browser_password_login, 'login_with_password',
                           AsyncMock(return_value=(self.target, {'current_plan': 'free'}))),
              patch.object(bitbrowser_retry.browser_password_login, 'clear_visible_secrets', AsyncMock()),
              patch.object(bitbrowser_retry, 'cancellable_flow', AsyncMock(return_value={'status': 'blocked'})) as flow):
            await bitbrowser_retry._execute_profile_flow(self.job, None, SessionBudget(120))
        self.assertEqual(flow.call_args.kwargs['expected_checkout_identifier'], 'oaics_password_previous')
        self.assertFalse(flow.call_args.kwargs['allow_checkout_replacement'])

    async def test_human_wait_then_network_recovery_refreshes_api_deadline_without_resetting_budget(self):
        clock = Clock()
        preparation = SessionBudget(600, clock=clock)
        original = bitbrowser_retry.SessionBudget
        def budget(seconds, **kwargs):
            return preparation if seconds == 600 else original(seconds, clock=clock, **kwargs)
        calls = 0
        async def flow(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                await clock.advance(10)
                await kwargs['session_budget'].human_wait(lambda: clock.advance(900))
                return self.network()
            return {'status': 'session_verified'}
        async def close(*_):
            self.assertEqual(clock.now, 910)
            self.assertAlmostEqual(self.client.deadline - clock.now, 590, delta=.002)
            self.assertEqual(preparation.elapsed, 10)
        with (patch.object(bitbrowser_retry, 'SessionBudget', side_effect=budget),
              patch.object(bitbrowser_retry, 'time', SimpleNamespace(monotonic=clock)),
              patch.object(bitbrowser_retry, 'close_profile_id', AsyncMock(side_effect=close))):
            result, ran, _ = await self.execute(flow)
        self.assertEqual(result['status'], 'session_verified')
        self.assert_same_profile(2)
        self.assertEqual(result['session_attempt'], 2)
        self.assertEqual(result['session_attempt_limit'], 3)
        self.assertEqual(preparation.elapsed, 10)
        self.assertIs(ran.call_args_list[0].kwargs['session_budget'].parent,
                      ran.call_args_list[1].kwargs['session_budget'].parent)
        self.assert_same_profile(2)

    async def test_changed_original_checkout_identifier_stops(self):
        checkout = self.network(stage='quote_read', account_matched=True,
                                checkout_identifier='oaics_fixture', checkout_requests_sent=1)
        result, _, _ = await self.execute([checkout], continuation=[{
            'status': 'blocked', 'checkout_identifier': 'oaics_changed',
            'checkout_requests_sent': 0, 'payment_requests_sent': 0}])
        self.assertEqual(result['reason'], 'checkout_identifier_changed')
        self.assert_same_profile(2)

    async def test_missing_quote_or_menu_without_transport_evidence_does_not_rotate(self):
        for report in (failure(reason='actual_quote_unknown', stage='quote_read', account_matched=True,
                               checkout_identifier='oaics_fixture', checkout_requests_sent=1, page_state='blank'),
                       failure(reason='official_plan_menu_timeout', stage='plan_selection', account_matched=True),
                       failure(reason='login_page_not_ready', account_matched=True)):
            with self.subTest(reason=report['reason']):
                self.setUp()
                result, flow, _ = await self.execute([report])
                self.assertEqual(result['reason'], report['reason'])
                self.assertEqual(flow.await_count, 1)
                self.assert_same_profile(1)
                self.assertEqual(self.paths(), [])

    async def test_auth_verification_unknown_writes_and_confirmation_never_rotate(self):
        for changed in ({'reason': 'access_token_expired'}, {'reason': 'json_session_not_restored'},
                        {'reason': 'official_account_mismatch'}, {'reason': 'official_user_mismatch'},
                        {'reason': 'verification_required', 'user_action_required': True},
                        {'http_status': 403}, {'checkout_requests_sent': None},
                        {'checkout_requests_sent': 1}, {'payment_requests_sent': 1},
                        {'payment_requests_sent': None}, {'confirmation_requests_sent': 1},
                        {'payment_attempted': True}):
            with self.subTest(changed=changed):
                self.setUp()
                report = self.network(); report.update(changed)
                result, flow, _ = await self.execute([report])
                self.assertEqual(result['reason'], report['reason'])
                self.assert_same_profile(1)
                self.assertEqual(flow.await_count, 1)
                self.assertEqual(self.paths(), [])

    async def test_zero_retries_retains_first_network_failure(self):
        self.job.payload['bitBrowser']['browserOptions']['sessionRetryLimit'] = 0
        result, _, _ = await self.execute([self.network()])
        self.assertEqual(result['reason'], 'session_network_error')
        self.assert_same_profile(1)

    async def test_static_proxy_never_extracts_new_ip(self):
        self.job.payload['bitBrowser']['browserOptions'].update(proxyMode='static', staticHost='127.0.0.1')
        result, _, _ = await self.execute([self.network()])
        self.assertEqual(result['session_attempt_limit'], 1)
        self.assert_same_profile(1)
        self.assertEqual(self.paths(), [])

    async def test_failed_preflight_reextracts_before_session_or_checkout(self):
        self.probe.side_effect = [Stop('proxy_network_error'), {'observed_country': 'US'}]
        result, flow, _ = await self.execute([{'status': 'session_verified'}])
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(result['session_attempt'], 2)
        self.assert_same_profile(2)
        self.assertEqual(self.probe.await_count, 2)
        self.assertEqual(self.probe.call_args.kwargs['budget'].seconds, 20)

    async def test_twenty_second_probe_or_home_timeout_reopens_same_profile(self):
        for step in ('proxy_probe', 'proxy_home'):
            with self.subTest(step=step):
                self.setUp()
                self.probe.side_effect = [Stop('proxy_prepare_timeout', session_step=step), {}]
                result, flow, _ = await self.execute([{'status': 'session_verified'}])
                self.assertEqual(result['session_attempt'], 2)
                self.assertEqual(flow.await_count, 1)
                self.assert_same_profile(2)

    async def test_unconfirmed_exit_rotates_only_with_explicit_network_code(self):
        for network_code in (None, 'net::ERR_PROXY_CONNECTION_FAILED'):
            with self.subTest(network_code=network_code):
                self.setUp()
                self.probe.side_effect = [Stop('proxy_network_unconfirmed', browser_error_code=network_code), {}]
                result, flow, _ = await self.execute([{'status': 'session_verified'}] if network_code else [])
                self.assert_same_profile(2 if network_code else 1)
                self.assertEqual(flow.await_count, 1 if network_code else 0)
                self.assertEqual(result['status'], 'session_verified' if network_code else 'blocked')

    async def test_expected_country_comes_from_proxy_not_billing(self):
        self.job.payload['bitBrowser']['expectedCountryCode'] = 'PH'
        _, flow, _ = await self.execute([{'status': 'session_verified'}])
        self.assertEqual(self.probe.call_args.args[1], 'PH')
        self.assertEqual(flow.call_args.kwargs['expected_country'], 'PH')
        self.assertEqual(self.job.payload['address']['country'], 'US')

    async def test_unconfirmed_close_does_not_reopen_or_delete(self):
        for replies in (Stop('bitbrowser_local_api_unavailable'), [{}, {'another-profile': 42}]):
            with self.subTest(replies=type(replies).__name__):
                self.setUp()
                self.client.post.side_effect = replies
                result, flow, _ = await self.execute([self.network()])
                self.assertEqual(result['reason'], 'bitbrowser_cleanup_unverified')
                self.assertEqual(flow.await_count, 1)
                self.assert_same_profile(1)

    async def test_cancel_during_flow_closes_but_retains_owned_profile(self):
        stopped = asyncio.Event()
        async def pending(*args, **kwargs):
            self.job.signal_cancel()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        result, flow, _ = await self.execute(pending)
        self.assertTrue(stopped.is_set())
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(result['browser_cleanup_status'], 'not_needed')
        self.assertTrue(result['cancellation_confirmed'])
        self.assert_same_profile(1)
        self.assertEqual(result['browser_profile_id'], 'a' * 32)

    async def test_cancel_after_close_prevents_next_open(self):
        async def closed(*args, **kwargs):
            self.job.signal_cancel()
        with patch.object(bitbrowser_retry, 'close_profile_id', AsyncMock(side_effect=closed)):
            result, _, _ = await self.execute([self.network()])
        self.assertEqual(result['reason'], 'operation_cancelled')
        self.assert_same_profile(1)

    async def test_failed_cancel_close_retains_profile_and_reports_uncertainty(self):
        async def cancelled(*args, **kwargs):
            self.job.signal_cancel()
            return failure(reason='operation_cancelled')
        self.client.post.side_effect = Stop('bitbrowser_local_api_unavailable')
        result, _, _ = await self.execute(cancelled)
        self.assertEqual(result['browser_cleanup_status'], 'failed')
        self.assertEqual(result['reason'], 'bitbrowser_cleanup_unverified')
        self.assert_same_profile(1)

    async def test_cancel_close_has_its_own_fifteen_second_budget_after_human_wait(self):
        import time
        self.client.deadline = time.monotonic() - 900
        original = self.client.deadline
        def post(*_):
            self.assertGreater(self.client.deadline, time.monotonic())
            self.assertLessEqual(self.client.deadline - time.monotonic(), 15)
            return {}
        self.client.post.side_effect = post
        await bitbrowser_retry.close_profile_id(self.job, self.client, 'a' * 32, cancelling=True)
        self.assertEqual(self.client.deadline, original)

    async def test_stale_profiles_are_never_automatically_deleted(self):
        self.job.stale_profiles = [{'sourceJobId': '22222222-2222-4222-8222-222222222222',
                                   'profileId': 'd' * 32}]
        await self.execute([{'status': 'session_verified'}])
        self.client.list_profile_ids.assert_not_called()
        self.assertEqual(self.paths(), [])
        self.assertEqual(self.job.stale_profiles_cleaned, 0)
        self.assert_same_profile(1)

    async def test_preparation_deadline_stops_before_next_open(self):
        clock = Clock()
        preparation = SessionBudget(600, clock=clock)
        original = bitbrowser_retry.SessionBudget
        def budget(seconds, **kwargs):
            return preparation if seconds == 600 else original(seconds, clock=clock, **kwargs)
        async def expired(*args, **kwargs):
            clock.now = 600
            return self.network()
        with patch.object(bitbrowser_retry, 'SessionBudget', side_effect=budget):
            result, _, _ = await self.execute(expired)
        self.assertEqual(result['reason'], 'proxy_recovery_timeout')
        self.assert_same_profile(1)

    async def test_open_browser_mode_waits_for_visible_login_before_ready(self):
        self.job.payload['mode'] = 'open_browser'
        page = MagicMock(url='about:blank')
        self.context.pages = [page]
        identity = {'session_status': 'restored', 'account_matched': True, 'current_plan': 'plus'}
        with (patch('browser_checkout.restore_session_with_refresh', AsyncMock(return_value=(None, identity))) as restore,
              patch('browser_checkout.synchronize_login_page', AsyncMock(return_value=(None, identity)), create=True) as sync):
            result, flow, _ = await self.execute([])
        self.assertEqual(result['status'], 'session_ready')
        restore.assert_awaited_once()
        sync.assert_awaited_once_with(page, self.target, identity, budget=restore.call_args.kwargs['budget'])
        self.assertEqual(self.context.add_cookies.await_count, 1)
        flow.assert_not_awaited()
        self.assert_same_profile(1)

    async def test_open_browser_ui_failure_is_distinct_and_never_rotates_ip(self):
        self.job.payload['mode'] = 'open_browser'
        self.context.pages = [MagicMock(url='about:blank')]
        identity = {'account_matched': True, 'current_plan': 'free'}
        with (patch('browser_checkout.restore_session_with_refresh', AsyncMock(return_value=(None, identity))),
              patch('browser_checkout.synchronize_login_page', AsyncMock(side_effect=Stop(
                  'login_page_not_ready', account_matched=True, user_action_required=True)), create=True)):
            result, flow, _ = await self.execute([])
        self.assertEqual(result['reason'], 'login_page_not_ready')
        self.assertTrue(result['account_matched'])
        self.assert_same_profile(1)
        flow.assert_not_awaited()

    async def test_pending_confirmation_is_invalidated_before_proxy_changes(self):
        self.job.pending_confirmation = {'nonce': 'synthetic-nonce'}
        self.job.confirmation_approved = {'quote_digest': 'synthetic-digest'}
        self.job.result = {'quote_digest': 'synthetic-digest', 'quote': {'private': 'fixture'}}
        async def probe(*args, **kwargs):
            if self.probe.await_count == 2:
                self.assertIsNone(self.job.pending_confirmation)
                self.assertIsNone(self.job.confirmation_approved)
                self.assertNotIn('quote_digest', self.job.result)
            return {}
        self.probe.side_effect = probe
        await self.execute([self.network(), {'status': 'session_verified'}])
        self.assert_same_profile(2)

    async def test_confirmed_or_sent_payment_never_rotates(self):
        for flag in ('payment_request_sent', 'confirmation_consumed'):
            with self.subTest(flag=flag):
                self.setUp(); setattr(self.job, flag, True)
                await self.execute([self.network()])
                self.assert_same_profile(1)

    async def test_unavailable_bound_profile_never_creates_another(self):
        self.job.owned_profile = {'profileId': 'd' * 32, 'accountKey': 'c' * 64}
        self.client.post.return_value = {}
        result, flow, _ = await self.execute([])
        self.assertEqual(result['reason'], 'owned_recharge_window_unavailable')
        self.assertEqual(result['browser_profile_id'], 'd' * 32)
        self.client.create_profile.assert_not_called()
        self.client.open_profile.assert_not_called()
        flow.assert_not_awaited()

    async def test_unknown_durable_payment_stops_before_homepage_probe_or_open(self):
        with patch('attempt_ledger.assert_no_other_payment', side_effect=Stop(
                'account_has_other_payment_attempt', action='recheck_original_order_only')):
            result, flow, _ = await self.execute([])
        self.assertEqual(result['reason'], 'account_has_other_payment_attempt')
        self.probe.assert_not_awaited()
        self.client.create_profile.assert_not_called()
        self.client.open_profile.assert_not_called()
        flow.assert_not_awaited()

    async def test_durable_payment_marker_is_checked_again_before_reopen(self):
        with patch('attempt_ledger.assert_no_other_payment', side_effect=[None, Stop(
                'account_has_other_payment_attempt', action='recheck_original_order_only')]):
            result, flow, _ = await self.execute([self.network()])
        self.assertEqual(result['reason'], 'account_has_other_payment_attempt')
        self.assert_same_profile(1)
        self.assertEqual(self.paths(), [])
        self.assertEqual(flow.await_count, 1)
        self.assertEqual(self.probe.await_count, 1)

    async def test_local_open_unknown_keeps_profile_id_and_never_retries(self):
        self.client.open_profile.side_effect = Stop('bitbrowser_local_api_unavailable')
        result, flow, _ = await self.execute([])
        self.assertEqual(result['reason'], 'bitbrowser_local_api_unavailable')
        self.assertEqual(result['browser_profile_id'], 'a' * 32)
        self.assert_same_profile(1)
        self.probe.assert_not_awaited()
        flow.assert_not_awaited()

    async def test_password_restore_cannot_switch_to_another_owned_profile(self):
        self.job.payload.pop('sessionJson', None)
        self.job.payload['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
        self.job.profile_id = 'a' * 32
        page = MagicMock(url='about:blank')
        self.context.pages = [page]
        self.job.context = self.context
        def restored(_):
            self.job.owned_profile = {'profileId': 'd' * 32, 'accountKey': 'c' * 64}
        with (patch.object(self.job, 'restore_account', side_effect=restored),
              patch.object(bitbrowser_retry.browser_password_login, 'login_with_password',
                           AsyncMock(return_value=(self.target, {'current_plan': 'free'}))),
              patch.object(bitbrowser_retry.browser_password_login, 'clear_visible_secrets', AsyncMock()),
              self.assertRaises(Stop) as stopped):
            await bitbrowser_retry._execute_profile_flow(self.job, None, SessionBudget(120))
        self.assertEqual(stopped.exception.report['reason'], 'owned_recharge_profile_conflict')
        self.assertEqual(self.job.profile_id, 'a' * 32)
        self.client.post.assert_not_called()

    async def test_manual_owned_window_network_recovery_keeps_bound_id(self):
        profile = 'd' * 32
        self.job.owned_profile = {'profileId': profile, 'accountKey': 'c' * 64}
        def post(path, body):
            return {'id': profile} if path == '/browser/detail' else {}
        self.client.post.side_effect = post
        with patch.object(bitbrowser_retry, 'reuse_owned_profile', AsyncMock(return_value=self.target)):
            result, flow, _ = await self.execute([self.network(), {'status': 'session_verified'}])
        self.client.create_profile.assert_not_called()
        self.assertEqual({c.args[0] for c in self.client.open_profile.call_args_list}, {profile})
        self.assertEqual(self.client.open_profile.call_count, 2)
        self.assertEqual(result['browser_profile_id'], profile)
        self.assertEqual(flow.await_count, 2)
        self.assertNotIn('/browser/delete', self.paths())

    async def test_explicit_no_replacement_flag_is_preserved(self):
        with patch.object(bitbrowser_retry.pay, 'run_flow', AsyncMock(return_value={})) as flow:
            await bitbrowser_retry.cancellable_flow(self.job, self.target, allow_checkout_replacement=False)
        self.assertFalse(flow.call_args.kwargs['allow_checkout_replacement'])


class SessionFailureReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def test_pro_dispatch_preserves_context_and_distinguishes_recheck_budgets(self):
        import pay
        context, page, guard = MagicMock(), MagicMock(), MagicMock(unroute=AsyncMock())
        page.context = context
        context.unroute = AsyncMock()
        budget = SessionBudget(60)
        target = SimpleNamespace()
        async def browser(*args, **kwargs):
            self.assertEqual(kwargs['session_budget'].phase, 'subscription_check')
            return await kwargs['session_handler'](page, guard, {'current_plan': 'free'})
        with patch.object(pay, 'run_browser', side_effect=browser), \
                patch.object(pay, 'synchronize_login_page', new=AsyncMock(return_value=(
                    target, {'current_plan': 'free'}))) as synchronize, \
                patch.object(pay, 'run_checkout_flow', new=AsyncMock(return_value={'status': 'fixture'})) as checkout:
            await pay.run_flow(target, None, 'pro-500', details_reader=None,
                               confirmer=None, browser_context=context, session_budget=budget)
        synchronize.assert_awaited_once_with(page, target, {'current_plan': 'free'}, budget=budget)
        self.assertIs(checkout.call_args.kwargs['browser_context'], context)
        self.assertEqual(checkout.call_args.kwargs['session_budget'].phase, 'checkout_check')
        self.assertIsNot(checkout.call_args.kwargs['session_budget'], budget)
        self.assertEqual(checkout.call_args.kwargs['session_budget'].seconds, 60)

    async def execute_failure(self, error=None, *, repeat=False, status=200, seconds=7,
                              check_error=None, cancelled=False):
        clock, reports = Clock(), MagicMock()
        budget = SessionBudget(60, clock=clock, report=reports,
                               cancelled=lambda: cancelled, phase='subscription_check')
        navigation = []
        async def navigate(*args, **kwargs):
            navigation.append(kwargs)
            await clock.advance(seconds)
            if error and (repeat or len(navigation) == 1):
                raise error
            return SimpleNamespace(status=status)
        page = MagicMock(url='about:blank', goto=AsyncMock(side_effect=navigate),
                         reload=AsyncMock(side_effect=navigate))
        context = MagicMock(pages=[], route=AsyncMock(), unroute=AsyncMock(),
                            route_web_socket=AsyncMock(), new_page=AsyncMock(return_value=page))
        async def check(_page, _target, _wait, current, *, initial_restore=False):
            self.assertTrue(initial_restore)
            async def read():
                await clock.advance(3)
                if check_error:
                    raise check_error
            await current.run(read, 'page_title')
            return None, {'account_matched': True, 'current_plan': 'free', 'session_status': 'restored'}
        with patch.object(browser_checkout, 'check_session', side_effect=check), \
                patch.object(browser_checkout, 'progress') as progress, \
                patch.dict('os.environ', {}, clear=True):
            result = await browser_checkout.workflow(
                context, SimpleNamespace(session_token=None), session_budget=budget)
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)
        self.assertNotIn('synthetic-secret', json.dumps(result))
        return result, navigation, budget, progress

    async def test_firefox_and_chromium_restore_once_in_same_budget(self):
        codes = ['NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_NET_INTERRUPT',
                 'NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_PROXY_CONNECTION_REFUSED',
                 'NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_UNKNOWN_PROXY_HOST',
                 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_CONNECTION_RESET']
        for code in codes:
            with self.subTest(code=code):
                result, navigation, budget, progress = await self.execute_failure(
                    RuntimeError(code + ' synthetic-secret'))
                self.assertEqual(result['status'], 'session_verified')
                self.assertEqual(len(navigation), 2)
                self.assertEqual(budget.elapsed, 17)
                self.assertEqual(budget.refresh_count, 1)
                self.assertTrue(any(c.args == ('session_restore',) and
                                    c.kwargs.get('account_matched') is False
                                    for c in progress.call_args_list))

    async def test_continuous_failure_returns_final_refresh_snapshot(self):
        result, navigation, _, _ = await self.execute_failure(
            RuntimeError('NS_ERROR_PROXY_CONNECTION_REFUSED synthetic-secret'), repeat=True)
        self.assertEqual(len(navigation), 2)
        self.assertEqual(result['reason'], 'session_network_error')
        self.assertEqual(result['browser_error_code'], 'NS_ERROR_PROXY_CONNECTION_REFUSED')
        self.assertEqual(result['session_step'], 'page_refresh')
        self.assertEqual(result['session_elapsed_seconds'], 14)
        self.assertEqual(result['session_refresh_count'], 1)
        self.assertEqual(result['session_wait_seconds'], 60)
        self.assertEqual(result['session_phase'], 'subscription_check')
        self.assertFalse(result['account_matched'])

    async def test_title_failure_is_distinct_from_navigation(self):
        result, navigation, _, _ = await self.execute_failure(
            check_error=RuntimeError('synthetic-secret'))
        self.assertEqual(len(navigation), 1)
        self.assertEqual(result['reason'], 'browser_operation_failed')
        self.assertEqual(result['session_step'], 'page_title')
        self.assertEqual(result['session_elapsed_seconds'], 10)
        self.assertEqual(result['session_refresh_count'], 0)

    async def test_deadline_and_cancellation_do_not_start_recovery(self):
        result, navigation, _, _ = await self.execute_failure(seconds=60)
        self.assertEqual(result['reason'], 'session_load_timeout')
        self.assertEqual(result['session_elapsed_seconds'], 60)
        self.assertEqual(len(navigation), 1)
        result, navigation, _, _ = await self.execute_failure(cancelled=True)
        self.assertEqual(result['reason'], 'operation_cancelled')
        self.assertEqual(result['session_elapsed_seconds'], 0)
        self.assertEqual(navigation, [])

    async def test_http_identity_challenge_certificate_and_unknown_failures_stop(self):
        for status in [403, 500]:
            with self.subTest(status=status):
                result, navigation, _, _ = await self.execute_failure(status=status)
                self.assertEqual(result['http_status'], status)
                self.assertEqual(len(navigation), 1)
        for error in [Stop('official_account_mismatch', account_matched=False),
                      Stop('verification_required', user_action_required=True),
                      RuntimeError('SEC_ERROR_UNKNOWN_ISSUER synthetic-secret'),
                      RuntimeError('NS_ERROR_NET_RESET_EXTRA synthetic-secret'),
                      RuntimeError('synthetic-secret')]:
            with self.subTest(error=type(error).__name__):
                result, navigation, _, _ = await self.execute_failure(error)
                self.assertEqual(len(navigation), 1)
                self.assertNotIn('browser_error_code', result)

    def test_http_or_user_action_has_priority_over_network_reason(self):
        for details in [{'http_status': 403}, {'user_action_required': True}]:
            self.assertFalse(retryable_page_load_error(Stop('session_network_error', **details)))
        self.assertEqual(session_failure(RuntimeError('NS_ERROR_NET_RESET_EXTRA'))['reason'],
                         'browser_operation_failed')

    def test_phase_restart_and_public_projection(self):
        budget = SessionBudget(60, phase='subscription_check')
        budget.refresh_count = 1
        restarted = budget.restart(phase='checkout_check')
        self.assertEqual(restarted.phase, 'checkout_check')
        self.assertEqual(restarted.refresh_count, 0)
        report = {'session_step': 'page_title', 'session_phase': 'checkout_check',
                  'session_elapsed_seconds': 9, 'first_session_verified_at': 'forged',
                  'raw_error': 'synthetic-secret'}
        expected = {key: value for key, value in report.items()
                    if key not in {'raw_error', 'first_session_verified_at'}}
        self.assertEqual(connector.public_result(report), expected)
        from server import public_result
        self.assertEqual(public_result(report), expected)


if __name__ == '__main__':
    unittest.main()
