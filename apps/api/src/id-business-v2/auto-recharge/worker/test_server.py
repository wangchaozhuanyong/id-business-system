import json
import io
import asyncio
from contextlib import redirect_stderr
from pathlib import Path
import runpy
import signal
import socket
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import browser_checkout
import server
from checkout_core import Stop


class ServerTests(unittest.TestCase):
    def test_server_recharge_new_job_endpoint_is_retired_without_browser_side_effects(self):
        handler = object.__new__(server.Handler)
        handler.path = '/jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        handler.headers = {'X-Recharge-Worker': 'fixture-worker-auth'}
        body = {'action': 'server', 'plan': 'plus'}
        encoded = json.dumps(body).encode()
        handler.headers['Content-Length'] = str(len(encoded))
        handler.rfile = io.BytesIO(encoded)
        handler.reply = unittest.mock.Mock()
        with (patch.object(server, 'TOKEN', 'fixture-worker-auth'),
              patch.object(server, 'Job') as create_job,
              patch.object(server, 'WORKER_ROLE', 'recharge')):
            handler.do_POST()
        self.assertEqual(handler.reply.call_args.args, (410, {
            'ok': False, 'reason': 'server_recharge_retired'}))
        create_job.assert_not_called()

    def test_removed_registration_routes_never_read_payload_or_modify_recharge_job(self):
        job = MagicMock(done=False, cancelled=False, confirmed=False)
        for path in ('/registration/health', '/registration/jobs/fixture/status',
                     '/registration/jobs/fixture', '/registration/jobs/fixture/code',
                     '/registration/jobs/fixture/cancel'):
            for method in ('do_GET', 'do_POST'):
                with self.subTest(path=path, method=method):
                    handler = object.__new__(server.Handler)
                    handler.path = path
                    handler.headers = {'X-Recharge-Worker': 'fixture-worker-auth'}
                    handler.reply = MagicMock()
                    handler.rfile = MagicMock()
                    with (patch.object(server, 'TOKEN', 'fixture-worker-auth'),
                          patch.object(server, 'WORKER_ROLE', 'recharge'),
                          patch.object(server.Handler, 'job', job)):
                        getattr(handler, method)()
                        self.assertIs(handler.job, job)
                    handler.reply.assert_called_once_with(404, {'ok': False})
                    handler.rfile.read.assert_not_called()
                    self.assertEqual(job.mock_calls, [])

    def test_prepared_proxy_window_is_reused_once_and_login_failure_never_rotates_again(self):
        async def exercise():
            job = server.Job('test', {
                'action': 'server', 'plan': 'plus', 'expectedCountry': 'US',
                'proxy': {'mode': 'dynamic', 'type': 'http', 'extractionUrl': 'https://proxy.example.invalid/extract'},
                'login': {'email': 'test@example.invalid', 'password': 'synthetic'}
            })
            context = MagicMock(close=AsyncMock())
            page = MagicMock()
            browser = MagicMock(close=AsyncMock())
            prepared = {'browser': browser, 'context': context, 'page': page,
                        'proxy': {'server': 'http://proxy.example.invalid:8080'},
                        'network': {'ip': '8.8.8.8', 'country': 'US'}}
            runtime = server.PersistentBrowserRuntime()
            runtime._discard = AsyncMock()
            job.progress = MagicMock()
            job.login_target = AsyncMock(side_effect=Stop('session_network_error'))
            with (patch.object(server.server_proxy, 'prepare_browser', AsyncMock(return_value=prepared)) as prepare,
                  patch.object(server.server_proxy, 'observe_exit', AsyncMock()) as observe,
                  patch.object(server.pay, 'run_flow', AsyncMock()) as payment):
                with self.assertRaises(Stop) as stopped:
                    await runtime._execute_isolated(lambda current: job.execute(current),
                                                    browser_factory=job.prepare_server_browser)
            self.assertEqual(stopped.exception.report['reason'], 'session_network_error')
            prepare.assert_awaited_once()
            self.assertEqual(prepare.await_args.kwargs['target_url'], 'https://chatgpt.com/auth/login')
            job.login_target.assert_awaited_once()
            self.assertIs(job.login_target.await_args.kwargs['initial_page'], page)
            observe.assert_not_awaited()
            payment.assert_not_awaited()
            context.close.assert_awaited_once()
            browser.close.assert_awaited_once()
            self.assertIsNone(job.prepared_browser)
            self.assertIsNone(job.resolved_proxy)
        asyncio.run(exercise())

    def test_preloaded_password_and_json_pages_are_not_navigated_again_before_identity(self):
        async def exercise(mode):
            job = server.Job('test', {'plan': 'plus'})
            job.progress = MagicMock()
            target = type('Target', (), {'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'})()
            page = MagicMock(goto=AsyncMock(), close=AsyncMock())
            context = MagicMock(new_page=AsyncMock(), add_cookies=AsyncMock(), route=AsyncMock(), unroute=AsyncMock())
            with (patch.object(server.browser_password_login, 'login_with_password', AsyncMock(return_value=(target, {}))) as login,
                  patch.object(server.browser_password_login, 'official_identity', AsyncMock(return_value=(target, {}))),
                  patch.object(server.browser_password_login, 'clear_visible_secrets', AsyncMock())):
                if mode == 'password':
                    await job.login_target(context, {'email': 'test@example.invalid', 'password': 'synthetic'}, initial_page=page)
                    self.assertTrue(login.await_args.kwargs['initial_loaded'])
                else:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
                    context.add_cookies.assert_awaited_once()
            context.new_page.assert_not_awaited()
            page.goto.assert_not_awaited()
            page.close.assert_awaited_once()
        for mode in ('password', 'json'): asyncio.run(exercise(mode))

    def test_login_cleanup_is_bounded_and_preserves_the_original_failure(self):
        async def never(*args, **kwargs):
            await asyncio.Event().wait()

        async def exercise(mode, waiting_at, original_failure):
            job = server.Job('test', {'plan': 'plus'})
            job.progress = MagicMock()
            target = type('Target', (), {
                'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
            })()
            page = MagicMock(goto=AsyncMock(), close=AsyncMock())
            context = MagicMock(new_page=AsyncMock(return_value=page), add_cookies=AsyncMock(),
                                route=AsyncMock(), unroute=AsyncMock())
            clear = AsyncMock()
            waiting = {'secrets': clear, 'unroute': context.unroute, 'close': page.close}[waiting_at]
            waiting.side_effect = never
            login = {'email': 'test@example.invalid', 'password': 'synthetic'}
            observed = AsyncMock(return_value=(target, {'current_plan': 'free'}))
            if original_failure:
                observed.side_effect = Stop('verification_required')
            with (patch.object(server.server_proxy, 'CLEANUP_TIMEOUT_SECONDS', 0.01),
                  patch.object(server.browser_password_login, 'clear_visible_secrets', clear),
                  patch.object(server.browser_password_login, 'login_with_password', observed),
                  patch.object(server.browser_password_login, 'official_identity', observed)):
                with self.assertRaises(Stop) as stopped:
                    operation = (job.login_target(context, login) if mode == 'password' else
                                 job.verify_json_target(context, target, 'test@example.invalid'))
                    await asyncio.wait_for(operation, timeout=0.3)
            self.assertEqual(stopped.exception.report['reason'],
                             'verification_required' if original_failure else 'browser_operation_failed')
            context.unroute.assert_awaited_once()
            page.close.assert_awaited_once()
            if mode == 'password':
                self.assertEqual(login, {})
                clear.assert_awaited_once()

        for mode in ('password', 'json'):
            for waiting_at in (('secrets', 'unroute', 'close') if mode == 'password' else
                               ('unroute', 'close')):
                for original_failure in (False, True):
                    with self.subTest(mode=mode, waiting_at=waiting_at, original_failure=original_failure):
                        asyncio.run(exercise(mode, waiting_at, original_failure))

    def test_session_preparation_hang_stops_before_identity_read(self):
        async def never(*args, **kwargs):
            await asyncio.Event().wait()

        async def exercise(mode):
            job = server.Job('test', {'plan': 'plus'})
            job.progress = MagicMock()
            target = type('Target', (), {
                'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
            })()
            context = MagicMock(new_page=AsyncMock(side_effect=never), add_cookies=AsyncMock())
            identity = AsyncMock()
            original_budget = server.SessionBudget
            login = {'email': 'test@example.invalid', 'password': 'synthetic'}
            with (patch.object(server, 'SessionBudget', side_effect=lambda _, **kwargs:
                               original_budget(0.02, **kwargs)),
                  patch.object(server.browser_password_login, 'login_with_password', identity),
                  patch.object(server.browser_password_login, 'official_identity', identity)):
                with self.assertRaises(Stop) as stopped:
                    operation = (job.login_target(context, login) if mode == 'password' else
                                 job.verify_json_target(context, target, 'test@example.invalid'))
                    await asyncio.wait_for(operation, timeout=0.3)
            self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
            identity.assert_not_awaited()
            if mode == 'password':
                self.assertEqual(login, {})
        for mode in ('password', 'json'):
            with self.subTest(mode=mode):
                asyncio.run(exercise(mode))

    def test_proxy_failure_finishes_even_when_context_cleanup_hangs(self):
        async def never():
            await asyncio.Event().wait()

        context = MagicMock(close=AsyncMock(side_effect=never))
        browser = MagicMock(new_context=AsyncMock(return_value=context))

        class Runtime:
            started = True

            @staticmethod
            def run_isolated(operation, *, proxy_factory=None, browser_factory=None):
                async def run():
                    # Exercise the direct execution compatibility path and its bounded cleanup.
                    return await operation(browser)
                return asyncio.run(run())

        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'expectedCountry': 'PH',
            'proxy': {'mode': 'static'}, 'sessionJson': '{}'
        })
        calls = []
        with (patch.object(server, 'BROWSER_RUNTIME', Runtime()),
              patch.object(server.server_proxy, 'resolve', AsyncMock(return_value={
                  'server': 'http://proxy.example.invalid:8080'
              })) as resolve,
              patch.object(server.server_proxy, 'observe_exit', AsyncMock(
                  side_effect=Stop('proxy_network_unconfirmed'))),
              patch.object(server.server_proxy, 'CLEANUP_TIMEOUT_SECONDS', 0.02),
              patch.object(job, 'verify_json_target', AsyncMock()) as login,
              patch.object(server.pay, 'run_flow', AsyncMock()) as payment,
              patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body))):
            job.run()
        resolve.assert_awaited_once()
        login.assert_not_awaited()
        payment.assert_not_awaited()
        context.close.assert_awaited_once()
        self.assertTrue(job.done)
        finished = [body for body in calls if body['type'] == 'finished']
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0]['result']['reason'], 'proxy_network_unconfirmed')
        self.assertEqual(finished[0]['result']['stage'], 'proxy_verifying')
        self.assertEqual(finished[0]['result']['payment_requests_sent'], 0)
        self.assertFalse(finished[0]['result']['payment_attempted'])
        self.assertEqual(job.payload, {})
        self.assertIsNone(job.resolved_proxy)

    def test_json_target_requires_matching_official_email_and_account(self):
        async def exercise(observed):
            job = server.Job('11111111-1111-4111-8111-111111111111', {'plan': 'plus'})
            job.progress = MagicMock()
            target = type('Target', (), {
                'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
            })()
            context = MagicMock()
            context.add_cookies = AsyncMock()
            context.route = AsyncMock()
            context.unroute = AsyncMock()
            page = MagicMock()
            page.goto = AsyncMock()
            page.close = AsyncMock()
            context.new_page = AsyncMock(return_value=page)
            with patch.object(server.browser_password_login, 'official_identity',
                              new=AsyncMock(return_value=observed)):
                await job.verify_json_target(context, target, 'test@example.invalid')
            context.add_cookies.assert_awaited_once()
            page.close.assert_awaited_once()

        matching = type('Official', (), {'account_id': 'account-1', 'user_id': 'user-1'})()
        asyncio.run(exercise((matching, {'current_plan': 'free'})))
        with self.assertRaises(Stop):
            asyncio.run(exercise(None))
        mismatched = type('Official', (), {'account_id': 'account-2', 'user_id': 'user-1'})()
        with self.assertRaises(Stop):
            asyncio.run(exercise((mismatched, {'current_plan': 'free'})))

    def test_json_navigation_recovers_once_in_the_same_context_before_identity(self):
        async def exercise():
            job = server.Job('test', {'plan': 'pro-500'})
            job.progress = MagicMock()
            target = type('Target', (), {
                'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
            })()
            page = MagicMock(url='https://chatgpt.com/')
            page.goto = AsyncMock(side_effect=[TimeoutError('private URL'), type('Response', (), {'status': 200})()])
            page.close = AsyncMock()
            context = MagicMock(new_page=AsyncMock(return_value=page), add_cookies=AsyncMock(),
                                route=AsyncMock(), unroute=AsyncMock())
            with patch.object(server.browser_password_login, 'official_identity',
                              new=AsyncMock(return_value=(target, {'current_plan': 'free'}))) as identity:
                result = await job.verify_json_target(context, target, 'test@example.invalid')
            self.assertEqual(result, {'current_plan': 'free'})
            self.assertEqual(page.goto.await_count, 2)
            self.assertTrue(all(call.kwargs['wait_until'] == 'commit' for call in page.goto.await_args_list))
            self.assertTrue(all(call.kwargs['timeout'] == 0 for call in page.goto.await_args_list))
            identity.assert_awaited_once()
            self.assertTrue(identity.await_args.kwargs['strict'])
            self.assertEqual(identity.await_args.kwargs['budget'].seconds, 60)
            context.add_cookies.assert_awaited_once()
            blocker = context.route.await_args.args[1]
            route = MagicMock(request=MagicMock(method='POST', url='https://api.stripe.com/v1/payment_pages/cs_test/confirm'),
                              abort=AsyncMock(), fallback=AsyncMock())
            await blocker(route)
            route.abort.assert_awaited_once()
            route.fallback.assert_not_awaited()
            context.unroute.assert_awaited_once_with('**/*', blocker)
            page.close.assert_awaited_once()
        asyncio.run(exercise())

    def test_json_navigation_stops_on_403_or_after_two_timeouts(self):
        async def exercise(blocked):
            job = server.Job('test', {'plan': 'pro-500'})
            job.progress = MagicMock()
            target = type('Target', (), {
                'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
            })()
            page = MagicMock(goto=AsyncMock(), close=AsyncMock())
            if blocked:
                page.goto.return_value = type('Response', (), {'status': 403})()
            else:
                page.goto.side_effect = TimeoutError('sessionToken=private')
            context = MagicMock(new_page=AsyncMock(return_value=page), add_cookies=AsyncMock(),
                                route=AsyncMock(), unroute=AsyncMock())
            with patch.object(server.browser_password_login, 'official_identity', new=AsyncMock()) as identity:
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid')
            self.assertEqual(stopped.exception.report['reason'],
                             'verification_required' if blocked else 'session_load_timeout')
            self.assertEqual(page.goto.await_count, 1 if blocked else 2)
            identity.assert_not_awaited()
            self.assertNotIn('private', json.dumps(stopped.exception.report))
            context.unroute.assert_awaited_once()
            page.close.assert_awaited_once()
        for blocked in (True, False):
            with self.subTest(blocked=blocked):
                asyncio.run(exercise(blocked))

    def json_identity_fixture(self):
        job = server.Job('test', {'plan': 'pro-500'})
        job.progress = MagicMock()
        target = type('Target', (), {
            'session_token': 'synthetic', 'account_id': 'account-1', 'user_id': 'user-1'
        })()
        page = MagicMock(url='https://chatgpt.com/',
                         goto=AsyncMock(return_value=type('Response', (), {'status': 200})()),
                         reload=AsyncMock(), close=AsyncMock())
        context = MagicMock(new_page=AsyncMock(return_value=page), add_cookies=AsyncMock(),
                            route=AsyncMock(), unroute=AsyncMock(), close=AsyncMock())
        return job, target, page, context

    def assert_json_identity_cleanup(self, page, context):
        context.add_cookies.assert_awaited_once()
        context.route.assert_awaited_once()
        context.unroute.assert_awaited_once_with('**/*', context.route.await_args.args[1])
        page.close.assert_awaited_once()
        page.reload.assert_not_awaited()

    def test_preloaded_json_identity_recovers_once_by_fixed_home_get(self):
        async def exercise(error):
            job, target, page, context = self.json_identity_fixture()
            official = AsyncMock(side_effect=[error, (target, {'current_plan': 'free'})])
            with patch.object(server.browser_password_login, 'official_identity', official):
                result = await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            self.assertEqual(result, {'current_plan': 'free'})
            page.goto.assert_awaited_once_with('https://chatgpt.com/', wait_until='commit', timeout=0)
            context.new_page.assert_not_awaited()
            self.assertEqual(official.await_count, 2)
            first, second = official.await_args_list
            self.assertEqual(first.args, (page, 'test@example.invalid'))
            self.assertEqual(second.args, first.args)
            self.assertTrue(first.kwargs['strict'])
            self.assertTrue(second.kwargs['strict'])
            self.assertIs(first.kwargs['budget'], second.kwargs['budget'])
            self.assertEqual(first.kwargs['budget'].seconds, 60)
            self.assert_json_identity_cleanup(page, context)

        for error in (Stop('session_network_error'), Stop('session_load_timeout'),
                      TimeoutError('synthetic private URL'),
                      RuntimeError('net::ERR_CONNECTION_RESET synthetic private URL')):
            with self.subTest(error=type(error).__name__, reason=str(error).split()[0]):
                asyncio.run(exercise(error))

    def test_preloaded_json_identity_first_read_success_does_not_refresh(self):
        async def exercise():
            job, target, page, context = self.json_identity_fixture()
            with patch.object(server.browser_password_login, 'official_identity',
                              AsyncMock(return_value=(target, {'current_plan': 'free'}))) as official:
                await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            official.assert_awaited_once()
            self.assertTrue(official.await_args.kwargs['strict'])
            page.goto.assert_not_awaited()
            context.new_page.assert_not_awaited()
            self.assert_json_identity_cleanup(page, context)
        asyncio.run(exercise())

    def test_json_identity_second_failure_reports_actual_read_step_and_shared_elapsed(self):
        async def exercise(reason):
            job, target, page, context = self.json_identity_fixture()
            clock = [0]
            original_budget = server.SessionBudget

            async def identity(_, __, *, budget, strict):
                async def fail_read():
                    clock[0] += 3
                    raise Stop(reason)
                return await budget.run(fail_read, 'session_read')

            with (patch.object(server, 'SessionBudget', side_effect=lambda seconds, **kwargs:
                               original_budget(seconds, clock=lambda: clock[0], **kwargs)),
                  patch.object(server.browser_password_login, 'official_identity',
                               AsyncMock(side_effect=identity)) as official):
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            self.assertEqual(stopped.exception.report['reason'], reason)
            self.assertEqual(stopped.exception.report['session_step'], 'session_read')
            self.assertEqual(stopped.exception.report['session_elapsed_seconds'], 6)
            self.assertEqual(stopped.exception.report['session_wait_seconds'], 60)
            self.assertEqual(stopped.exception.report['session_refresh_count'], 1)
            self.assertEqual(official.await_count, 2)
            page.goto.assert_awaited_once()
            self.assert_json_identity_cleanup(page, context)
        for reason in ('session_network_error', 'session_load_timeout'):
            with self.subTest(reason=reason):
                asyncio.run(exercise(reason))

    def test_json_identity_exhausted_budget_never_refreshes_or_restarts(self):
        async def exercise():
            job, target, page, context = self.json_identity_fixture()
            clock = [0]
            original_budget = server.SessionBudget

            async def identity(_, __, *, budget, strict):
                async def fail_read():
                    clock[0] = 60
                    raise Stop('session_network_error')
                return await budget.run(fail_read, 'session_read')

            with (patch.object(server, 'SessionBudget', side_effect=lambda seconds, **kwargs:
                               original_budget(seconds, clock=lambda: clock[0], **kwargs)) as create_budget,
                  patch.object(server.browser_password_login, 'official_identity',
                               AsyncMock(side_effect=identity)) as official):
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            self.assertEqual(stopped.exception.report['reason'], 'session_load_timeout')
            self.assertEqual(stopped.exception.report['session_elapsed_seconds'], 60)
            self.assertEqual(stopped.exception.report['session_wait_seconds'], 60)
            self.assertEqual(stopped.exception.report['session_step'], 'session_read')
            self.assertEqual(stopped.exception.report['session_refresh_count'], 0)
            create_budget.assert_called_once()
            official.assert_awaited_once()
            page.goto.assert_not_awaited()
            self.assert_json_identity_cleanup(page, context)
        asyncio.run(exercise())

    def test_json_identity_cancellation_blocks_refresh_or_second_read(self):
        async def exercise(cancel_at):
            job, target, page, context = self.json_identity_fixture()

            async def identity(_, __, *, budget, strict):
                async def fail_read():
                    if cancel_at == 'first_read':
                        job.cancelled = True
                    raise Stop('session_network_error')
                return await budget.run(fail_read, 'session_read')

            async def refresh(*args, **kwargs):
                job.cancelled = True
                return type('Response', (), {'status': 200})()

            if cancel_at == 'before_setup':
                job.cancelled = True
            if cancel_at == 'refresh':
                page.goto.side_effect = refresh
            with patch.object(server.browser_password_login, 'official_identity',
                              AsyncMock(side_effect=identity)) as official:
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
            self.assertEqual(official.await_count, 0 if cancel_at == 'before_setup' else 1)
            self.assertEqual(page.goto.await_count, 1 if cancel_at == 'refresh' else 0)
            page.close.assert_awaited_once()
            page.reload.assert_not_awaited()
            if cancel_at == 'before_setup':
                context.add_cookies.assert_not_awaited()
                context.route.assert_not_awaited()
                context.unroute.assert_not_awaited()
            else:
                self.assert_json_identity_cleanup(page, context)
        for cancel_at in ('before_setup', 'first_read', 'refresh'):
            with self.subTest(cancel_at=cancel_at):
                asyncio.run(exercise(cancel_at))

    def test_json_identity_controlled_nontransport_failure_never_refreshes(self):
        async def exercise(error):
            job, target, page, context = self.json_identity_fixture()
            # A transport-looking message must not override the controlled failure reason.
            error.args = (error.report['reason'] + ' net::ERR_CONNECTION_RESET synthetic private URL',)
            with patch.object(server.browser_password_login, 'official_identity',
                              AsyncMock(side_effect=error)) as official:
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            self.assertEqual(stopped.exception.report['reason'], error.report['reason'])
            self.assertEqual(stopped.exception.report['session_refresh_count'], 0)
            official.assert_awaited_once()
            page.goto.assert_not_awaited()
            self.assertNotIn('private', json.dumps(stopped.exception.report))
            self.assert_json_identity_cleanup(page, context)
        for error in (Stop('official_login_email_mismatch', browser_error_code='net::ERR_CONNECTION_RESET'),
                      Stop('verification_required', browser_error_code='net::ERR_CONNECTION_RESET'),
                      Stop('http_error', http_status=429, browser_error_code='net::ERR_CONNECTION_RESET'),
                      Stop('session_network_error', user_action_required=True),
                      Stop('session_network_error', http_status=403)):
            with self.subTest(reason=error.report['reason'], details=error.report):
                asyncio.run(exercise(error))

    def test_json_identity_refresh_http_failure_stops_before_second_read(self):
        async def exercise(status):
            job, target, page, context = self.json_identity_fixture()
            page.goto.return_value = type('Response', (), {'status': status})()
            with patch.object(server.browser_password_login, 'official_identity',
                              AsyncMock(side_effect=Stop('session_network_error'))) as official:
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            report = stopped.exception.report
            self.assertEqual(report['reason'], 'verification_required' if status == 403 else 'http_error')
            self.assertEqual(report['http_status'], status)
            self.assertEqual(report['user_action_required'], status == 403)
            self.assertEqual(report['session_step'], 'page_refresh')
            self.assertEqual(report['session_refresh_count'], 1)
            official.assert_awaited_once()
            page.goto.assert_awaited_once_with('https://chatgpt.com/', wait_until='commit', timeout=0)
            self.assert_json_identity_cleanup(page, context)
        for status in (403, 401, 429, 500):
            with self.subTest(status=status):
                asyncio.run(exercise(status))

    def test_json_identity_does_not_refresh_again_after_initial_navigation_recovery(self):
        async def exercise():
            job, target, page, context = self.json_identity_fixture()
            page.goto.side_effect = [TimeoutError('synthetic private URL'),
                                     type('Response', (), {'status': 200})()]
            with patch.object(server.browser_password_login, 'official_identity',
                              AsyncMock(side_effect=Stop('session_network_error'))) as official:
                with self.assertRaises(Stop) as stopped:
                    await job.verify_json_target(context, target, 'test@example.invalid')
            self.assertEqual(stopped.exception.report['reason'], 'session_network_error')
            self.assertEqual(stopped.exception.report['session_refresh_count'], 1)
            official.assert_awaited_once()
            self.assertEqual(page.goto.await_count, 2)
            context.new_page.assert_awaited_once()
            self.assert_json_identity_cleanup(page, context)
        asyncio.run(exercise())

    def test_json_identity_recovery_keeps_payment_writes_blocked_until_cleanup(self):
        async def exercise():
            job, target, page, context = self.json_identity_fixture()
            payment = MagicMock(request=MagicMock(
                method='POST', url='https://api.stripe.com/v1/payment_pages/cs_test/confirm'),
                abort=AsyncMock(), fallback=AsyncMock())
            home = MagicMock(request=MagicMock(method='GET', url='https://chatgpt.com/'),
                             abort=AsyncMock(), fallback=AsyncMock())

            async def refresh(*args, **kwargs):
                context.unroute.assert_not_awaited()
                blocker = context.route.await_args.args[1]
                await blocker(payment)
                await blocker(home)
                return type('Response', (), {'status': 200})()

            page.goto.side_effect = refresh
            with patch.object(server.browser_password_login, 'official_identity', AsyncMock(
                    side_effect=[Stop('session_network_error'), (target, {'current_plan': 'free'})])):
                await job.verify_json_target(context, target, 'test@example.invalid', initial_page=page)
            payment.abort.assert_awaited_once_with('blockedbyclient')
            payment.fallback.assert_not_awaited()
            home.abort.assert_not_awaited()
            home.fallback.assert_awaited_once()
            self.assert_json_identity_cleanup(page, context)
        asyncio.run(exercise())

    def test_json_identity_recovered_wrong_account_stops_execution_before_payment(self):
        async def exercise(field):
            job, target, page, context = self.json_identity_fixture()
            job.payload.update(action='server', expectedCountry='US', expectedEmail='test@example.invalid',
                               sessionJson='synthetic authorized JSON')
            job.resolved_proxy = {'server': 'http://proxy.example.invalid:8080'}
            job.prepared_browser = {'context': context, 'page': page}
            job.preflight_network = {'ip': '8.8.8.8', 'country': 'US'}
            job.prepare_server_proxy = AsyncMock(return_value=job.resolved_proxy)
            job.restore_target = MagicMock()
            observed = type('Official', (), {'account_id': target.account_id, 'user_id': target.user_id})()
            setattr(observed, field, 'different-synthetic-account')
            with (patch.object(server, 'parse_browser_credential', return_value=target),
                  patch.object(server.browser_password_login, 'official_identity', AsyncMock(
                      side_effect=[Stop('session_network_error'), (observed, {'current_plan': 'free'})])) as official,
                  patch.object(server.server_proxy, 'observe_exit', AsyncMock()) as observe,
                  patch.object(server.pay, 'run_flow', AsyncMock()) as pay):
                with self.assertRaises(Stop) as stopped:
                    await job.execute()
            self.assertEqual(stopped.exception.report['reason'], 'official_account_mismatch')
            self.assertFalse(stopped.exception.report['account_matched'])
            self.assertEqual(official.await_count, 2)
            page.goto.assert_awaited_once()
            job.restore_target.assert_not_called()
            observe.assert_not_awaited()
            pay.assert_not_awaited()
            context.close.assert_awaited_once()
            self.assertIsNone(job.prepared_browser)
            self.assertIsNone(job.resolved_proxy)
            self.assert_json_identity_cleanup(page, context)
        for field in ('account_id', 'user_id'):
            with self.subTest(field=field):
                asyncio.run(exercise(field))

    def test_json_identity_recovery_cleanup_failure_preserves_the_original_stop(self):
        async def never(*args, **kwargs):
            await asyncio.Event().wait()

        async def exercise(final_failure):
            job, target, page, context = self.json_identity_fixture()
            context.unroute.side_effect = never
            second = Stop('session_network_error') if final_failure else (target, {'current_plan': 'free'})
            with (patch.object(server.server_proxy, 'CLEANUP_TIMEOUT_SECONDS', 0.01),
                  patch.object(server.browser_password_login, 'official_identity', AsyncMock(
                      side_effect=[Stop('session_network_error'), second])) as official):
                with self.assertRaises(Stop) as stopped:
                    await asyncio.wait_for(job.verify_json_target(
                        context, target, 'test@example.invalid', initial_page=page), timeout=0.3)
            self.assertEqual(stopped.exception.report['reason'],
                             'session_network_error' if final_failure else 'browser_operation_failed')
            if final_failure:
                self.assertEqual(stopped.exception.report['session_refresh_count'], 1)
            self.assertEqual(official.await_count, 2)
            page.goto.assert_awaited_once()
            self.assert_json_identity_cleanup(page, context)
        for final_failure in (True, False):
            with self.subTest(final_failure=final_failure):
                asyncio.run(exercise(final_failure))

    def test_job_failure_keeps_last_stage_and_controlled_error_without_retry(self):
        for stage in ('session_restore', 'payment_request_sending'):
            with self.subTest(stage=stage):
                job = server.Job('test', {})
                calls = []
                async def execute():
                    job.progress(stage)
                    raise TimeoutError('sessionToken=private https://private.invalid')
                with (patch.object(job, 'execute', new=AsyncMock(side_effect=execute)) as operation,
                      patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body))):
                    job.run()
                operation.assert_awaited_once()
                result = calls[-1]['result']
                self.assertEqual(result['stage'], stage)
                self.assertEqual(result['error_type'], 'TimeoutError')
                self.assertEqual(result['reason'], 'session_load_timeout'
                                 if stage == 'session_restore' else 'worker_operation_failed')
                self.assertNotIn('private', json.dumps(calls))
                self.assertNotIn('payment_attempted', result)

    def test_server_recheck_uses_read_only_original_payment_flow(self):
        async def exercise():
            account_id = 'account-1'
            target = type('Target', (), {'account_id': account_id})()
            job = server.Job('11111111-1111-4111-8111-111111111111', {
                'action': 'server', 'plan': 'plus', 'recheckOnly': True,
                'sessionJson': '{}', 'expectedEmail': 'test@example.invalid',
                'expectedCountry': 'US',
                'sourceAccountKey': server.hashlib.sha256(account_id.encode()).hexdigest(),
                'proxy': {'mode': 'static'}
            })
            context = MagicMock()
            context.close = AsyncMock()
            browser = MagicMock()
            browser.new_context = AsyncMock(return_value=context)
            ledger = MagicMock()
            ledger.record = {'payment_status': 'unknown'}
            ledger.__enter__.return_value = ledger
            job.progress = MagicMock()
            with (patch.object(server.server_proxy, 'resolve_proxy', return_value={'server': 'http://proxy'}),
                  patch.object(server.server_proxy, 'observe_exit',
                               new=AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'US'})),
                  patch.object(server, 'parse_browser_credential', return_value=target),
                  patch.object(job, 'verify_json_target',
                               new=AsyncMock(return_value={'current_plan': 'free'})),
                  patch.object(job, 'restore_target'),
                  patch.object(server.payment_state, 'PaymentLedger', return_value=ledger),
                  patch.object(server, 'recheck_in_context', new=AsyncMock(return_value={'recheck_only': True})),
                  patch.object(server.pay, 'include_payment_record', return_value={'recheck_only': True}),
                  patch.object(server.pay, 'run_flow', new=AsyncMock()) as payment):
                result = await job.execute(browser=browser)
            self.assertEqual(result, {'recheck_only': True})
            payment.assert_not_awaited()
            context.close.assert_awaited_once()
        asyncio.run(exercise())

    def test_totp_is_generated_only_when_requested(self):
        with patch.object(server.time, 'time', return_value=50):
            code = asyncio.run(server.current_totp({
                'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
                'algorithm': 'sha1', 'digits': 8, 'period': 30
            }))
        self.assertEqual(code, '94287082')
        with self.assertRaises(Stop):
            asyncio.run(server.current_totp(None))

    def test_totp_waits_for_the_next_period_before_filling_a_nearly_expired_code(self):
        configuration = {
            'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            'algorithm': 'sha1', 'digits': 8, 'period': 30
        }
        with (patch.object(server.time, 'time', side_effect=[59, 61]),
              patch.object(server.asyncio, 'sleep', new=AsyncMock()) as wait):
            code = asyncio.run(server.current_totp(configuration))
        wait.assert_awaited_once_with(2)
        with patch.object(server.time, 'time', return_value=61):
            fresh = asyncio.run(server.current_totp(configuration))
        self.assertEqual(code, fresh)
        self.assertNotEqual(code, '94287082')

    def test_server_login_drops_password_and_blocks_payment_writes(self):
        async def exercise():
            job = server.Job('11111111-1111-4111-8111-111111111111', {'plan': 'plus'})
            job.progress = MagicMock()
            page = MagicMock(url='https://chatgpt.com/auth/login')
            page.close = AsyncMock()
            context = MagicMock()
            context.new_page = AsyncMock(return_value=page)
            context.route = AsyncMock()
            context.unroute = AsyncMock()
            login = {'email': 'test@example.invalid', 'password': 'synthetic'}
            target = MagicMock()
            with (patch.object(server.browser_password_login, 'login_with_password',
                               new=AsyncMock(return_value=(target, {'current_plan': 'free'}))),
                  patch.object(server.browser_password_login, 'clear_visible_secrets',
                               new=AsyncMock())):
                result = await job.login_target(context, login)
            self.assertIs(result[0], target)
            self.assertEqual(result[1]['current_plan'], 'free')
            self.assertEqual(login, {})
            context.route.assert_awaited_once()
            context.unroute.assert_awaited_once()
            page.close.assert_awaited_once()
        asyncio.run(exercise())

    def test_saved_totp_is_generated_and_filled_at_the_login_challenge(self):
        async def exercise():
            job = server.Job('11111111-1111-4111-8111-111111111111', {'plan': 'plus'})
            job.progress = MagicMock()
            page = MagicMock(url='https://auth.openai.com/u/mfa-otp-challenge')
            page.goto = AsyncMock()
            page.close = AsyncMock()
            context = MagicMock()
            context.new_page = AsyncMock(return_value=page)
            context.route = AsyncMock()
            context.unroute = AsyncMock()
            fields = [MagicMock(fill=AsyncMock(), press=AsyncMock()) for _ in range(3)]
            fields[2].input_value = AsyncMock(return_value='94287082')
            target = MagicMock()
            login = {'email': 'test@example.invalid', 'password': 'synthetic', 'totp': {
                'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
                'algorithm': 'sha1', 'digits': 8, 'period': 30
            }}
            with (patch.object(server.time, 'time', return_value=50),
                  patch.object(server.browser_password_login, 'official_identity',
                               new=AsyncMock(side_effect=[None, None, (target, {'current_plan': 'free'})])),
                  patch.object(server.browser_password_login, 'wait_for_input',
                               new=AsyncMock(side_effect=fields[:2])),
                  patch.object(server.browser_password_login, 'unique_visible',
                               new=AsyncMock(return_value=fields[2])),
                  patch.object(server.browser_password_login, 'clear_visible_secrets', new=AsyncMock()),
                  patch.object(server.browser_password_login.asyncio, 'sleep', new=AsyncMock())):
                result = await job.login_target(context, login)
            self.assertIs(result[0], target)
            fields[2].fill.assert_awaited_once_with('94287082')
            fields[2].press.assert_awaited_once_with('Enter')
            self.assertEqual(login, {})
            page.close.assert_awaited_once()
        asyncio.run(exercise())

    def test_persistent_runtime_reuses_one_browser_process(self):
        browsers = []

        class FakeBrowser:
            def __init__(self):
                self.connected = True
                self.closed = 0

            def is_connected(self):
                return self.connected

            async def close(self):
                self.closed += 1
                self.connected = False

        async def factory():
            browser = FakeBrowser()
            browsers.append(browser)
            return browser

        async def identity(browser):
            return id(browser)

        runtime = server.PersistentBrowserRuntime(browser_factory=factory)
        runtime.start()
        try:
            first = runtime.run(identity)
            second = runtime.run(identity)
        finally:
            runtime.stop()
        self.assertEqual(first, second)
        self.assertEqual(len(browsers), 1)
        self.assertEqual(browsers[0].closed, 1)

    def test_isolated_runtime_uses_and_closes_a_new_process_per_job(self):
        browsers = []

        class FakeBrowser:
            def __init__(self):
                self.closed = 0

            def is_connected(self):
                return self.closed == 0

            async def close(self):
                self.closed += 1

        async def factory():
            browser = FakeBrowser()
            browsers.append(browser)
            return browser

        async def identity(browser):
            return browser

        async def failure(_browser):
            raise RuntimeError('synthetic failure')

        runtime = server.PersistentBrowserRuntime(browser_factory=factory)
        runtime.start()
        try:
            first = runtime.run_isolated(identity)
            second = runtime.run_isolated(identity)
            with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                runtime.run_isolated(failure)
            self.assertEqual(len(browsers), 3)  # 充值不预热；三笔独立任务。
            self.assertIsNot(first, second)
            self.assertTrue(all(browser.closed == 1 for browser in browsers))
            shared = runtime.run(identity)
            self.assertIsNot(shared, first)
            self.assertIsNot(shared, second)
            self.assertEqual(shared.closed, 0)
        finally:
            runtime.stop()
        self.assertEqual(shared.closed, 1)

    def test_shared_browser_still_creates_and_closes_an_isolated_context_per_run(self):
        async def exercise():
            target = type('Target', (), {'account_id': 'account'})()
            contexts = [MagicMock(), MagicMock()]
            for context in contexts:
                context.close = AsyncMock()
            browser = MagicMock()
            browser.new_context = AsyncMock(side_effect=contexts)
            with patch.object(browser_checkout, 'workflow', new_callable=AsyncMock,
                              return_value={'status': 'session_verified'}) as workflow:
                first = await browser_checkout.run_browser(target, browser=browser)
                second = await browser_checkout.run_browser(target, browser=browser)
            self.assertEqual(first, second)
            self.assertEqual(browser.new_context.await_count, 2)
            self.assertEqual(workflow.await_count, 2)
            for context in contexts:
                context.close.assert_awaited_once()
            browser.close.assert_not_called()
        asyncio.run(exercise())

    def test_reads_cgroup_v2_oom_kill_counter(self):
        with tempfile.TemporaryDirectory() as folder:
            events = Path(folder) / 'memory.events'
            events.write_text('low 0\nhigh 0\noom 3\noom_kill 2\n', encoding='utf-8')
            self.assertEqual(server.read_cgroup_oom_kill(events), 2)
            events.write_text('oom_kill invalid\n', encoding='utf-8')
            self.assertIsNone(server.read_cgroup_oom_kill(events))
            self.assertIsNone(server.read_cgroup_oom_kill(Path(folder) / 'missing'))

    def test_oom_increment_overrides_browser_failure_and_preserves_stage(self):
        original = {'status': 'blocked', 'reason': 'official_plan_browser_error',
                    'stage': 'plan_selection', 'error_type': 'TargetClosedError'}
        result = server.apply_browser_memory_result(original, 4, 5)
        self.assertEqual(result['reason'], 'browser_memory_exhausted')
        self.assertEqual(result['stage'], 'plan_selection')
        self.assertEqual(result['error_type'], 'TargetClosedError')
        self.assertEqual(result['checkout_requests_sent'], 0)
        self.assertEqual(result['payment_requests_sent'], 0)

    def test_normal_browser_error_and_page_crash_are_not_mislabeled_as_oom(self):
        for failure in (
            {'status': 'blocked', 'reason': 'browser_operation_failed', 'error_type': 'Error'},
            {'status': 'blocked', 'reason': 'official_plan_browser_error', 'error_type': 'TargetClosedError'},
        ):
            with self.subTest(failure=failure):
                self.assertIs(server.apply_browser_memory_result(failure, 7, 7), failure)
                self.assertIs(server.apply_browser_memory_result(failure, None, None), failure)

    def test_job_reports_oom_once_without_retrying_or_sending_payment(self):
        job = server.Job('test', {})
        calls = []
        execute = AsyncMock(return_value={
            'status': 'blocked', 'reason': 'official_plan_browser_error',
            'stage': 'plan_selection', 'checkout_requests_sent': 0,
            'payment_requests_sent': 0,
        })
        with patch.object(server, 'read_cgroup_oom_kill', side_effect=[10, 11]), \
             patch.object(server.Job, 'execute', execute), \
             patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            job.run()
        execute.assert_awaited_once()
        self.assertEqual(calls[-1]['type'], 'finished')
        self.assertEqual(calls[-1]['result']['reason'], 'browser_memory_exhausted')
        self.assertEqual(calls[-1]['result']['checkout_requests_sent'], 0)
        self.assertEqual(calls[-1]['result']['payment_requests_sent'], 0)

    def test_production_job_uses_the_preheated_browser_runtime(self):
        browser = MagicMock()

        class Runtime:
            started = True

            @staticmethod
            def run(operation):
                return asyncio.run(operation(browser))

            @staticmethod
            def discard():
                raise AssertionError('healthy browser must not be discarded')

        job = server.Job('test', {})
        execute = AsyncMock(return_value={'status': 'session_verified'})
        calls = []
        with patch.object(server, 'BROWSER_RUNTIME', Runtime()), \
             patch.object(server, 'read_cgroup_oom_kill', side_effect=[0, 0]), \
             patch.object(server.Job, 'execute', execute), \
             patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            job.run()
        execute.assert_awaited_once_with(browser=browser)
        self.assertEqual(calls[-1]['result']['status'], 'session_verified')

    def test_server_job_uses_an_isolated_browser_process(self):
        browser = MagicMock()

        class Runtime:
            started = True

            @staticmethod
            def run(_operation):
                raise AssertionError('server job must not use the shared browser')

            @staticmethod
            def run_isolated(operation, *, proxy_factory=None, browser_factory=None):
                self.assertIsNotNone(browser_factory)
                return asyncio.run(operation(browser))

        job = server.Job('test', {'action': 'server'})
        execute = AsyncMock(return_value={'status': 'session_verified'})
        calls = []
        prepare_watchdog, business_watchdog = MagicMock(), MagicMock()
        with patch.object(server, 'threading') as threads, \
             patch.object(server, 'BROWSER_RUNTIME', Runtime()), \
             patch.object(server, 'read_cgroup_oom_kill', side_effect=[0, 0]), \
             patch.object(server.Job, 'execute', execute), \
             patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            threads.Timer.side_effect = [prepare_watchdog, business_watchdog]
            job.run()
        self.assertEqual([call.args[0] for call in threads.Timer.call_args_list], [1200, 900])
        prepare_watchdog.start.assert_called_once()
        prepare_watchdog.cancel.assert_called_once()
        business_watchdog.start.assert_called_once()
        business_watchdog.cancel.assert_called_once()
        execute.assert_awaited_once_with(browser=browser)
        self.assertEqual(calls[-1]['result']['status'], 'session_verified')

    def test_exhausted_preflight_cancels_watchdog_without_starting_business_timer(self):
        job = server.Job('test', {'action': 'server'})
        job.stage = 'proxy_verifying'
        runtime = MagicMock(started=True)
        runtime.run_isolated.side_effect = Stop('proxy_retry_exhausted', proxy_attempt=10,
                                               proxy_attempt_limit=10, proxy_wait_seconds=20)
        calls, watchdog = [], MagicMock()
        with (patch.object(server, 'BROWSER_RUNTIME', runtime),
              patch.object(server.threading, 'Timer', return_value=watchdog) as timer,
              patch.object(server, 'read_cgroup_oom_kill', return_value=0),
              patch.object(server.pay, 'run_flow', AsyncMock()) as payment,
              patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body))):
            job.run()
        timer.assert_called_once()
        self.assertEqual(timer.call_args.args[0], 1200)
        watchdog.cancel.assert_called_once()
        payment.assert_not_awaited()
        self.assertTrue(job.done)
        self.assertEqual(job.payload, {})
        self.assertEqual(calls[-1]['result']['reason'], 'proxy_retry_exhausted')
        self.assertEqual(calls[-1]['result']['proxy_attempt'], 10)
        self.assertEqual(calls[-1]['result']['payment_requests_sent'], 0)

    def test_diagnostics_survive_callback_without_free_text_or_secrets(self):
        safe = {'step': 'pricing_page', 'error_type': 'TimeoutError', 'role': 'link',
                'matched_count': 0, 'enabled': False, 'available_plans': ['plus']}
        value = {**safe, 'message': 'sessionToken=private', 'html': '<input value="123">',
                 'available_plans': ['plus', 'private']}
        self.assertEqual(server.public_result({'diagnostics': value}), {'diagnostics': safe})
        self.assertEqual(server.public_result({'diagnostics': {'step': [], 'role': {}, 'error_type': 'private'}}), {'diagnostics': {}})

    def test_no_credential_fields_in_public_result(self):
        result = server.public_result({'status': 'blocked', 'accessToken': 'private',
            'sessionToken': 'private', 'details': {'cvc': 'private'}, 'cookie': 'private'})
        self.assertEqual(result, {'status': 'blocked'})

    def test_payment_failure_reason_survives_public_result(self):
        result = server.public_result({'status': 'payment_failed',
            'payment_failure_reason': 'insufficient_funds', 'message': 'private'})
        self.assertEqual(result, {'status': 'payment_failed',
            'payment_failure_reason': 'insufficient_funds'})

    def test_original_order_recovery_fields_survive_public_result(self):
        result = server.public_result({
            'status': 'blocked', 'reason': 'account_has_other_payment_attempt',
            'recheck_plan': 'pro-20x', 'checkout_identifier': 'cs_original_synthetic',
            'sessionToken': 'private'})
        self.assertEqual(result, {
            'status': 'blocked', 'reason': 'account_has_other_payment_attempt',
            'recheck_plan': 'pro-20x', 'checkout_identifier': 'cs_original_synthetic'})

    def test_confirm_requires_current_nonce_and_only_once(self):
        job = server.Job('test', {})
        job.nonce = 'a' * 64
        with self.assertRaises(Stop):
            job.signal('a' * 64)
        job.waiting_confirmation = True
        with self.assertRaises(Stop):
            job.signal('b' * 64)
        self.assertFalse(job.confirmed)
        job.signal('a' * 64)
        self.assertTrue(job.confirmed)
        with self.assertRaises(Stop):
            job.signal('a' * 64)

    def test_confirmation_waits_for_web_action(self):
        job = server.Job('test', {})
        seen = []
        with patch.object(server, 'callback', side_effect=lambda _, body: seen.append(body)):
            result = []
            thread = threading.Thread(target=lambda: result.append(job.confirm({'plan': 'plus'}, '0000')))
            thread.start()
            for _ in range(1000):
                if job.nonce:
                    break
                threading.Event().wait(.001)
            self.assertFalse(result)
            job.signal(job.nonce)
            thread.join(2)
            self.assertEqual(result, [True])
            self.assertEqual(seen[0]['type'], 'confirmation')
            self.assertEqual(seen[0]['result']['quote_authority'], 'official_checkout_response')

    def test_details_waits_for_one_explicit_submission_and_clears_worker_copy(self):
        job = server.Job('test', {})
        seen = []
        result = []
        payload = {'details': {
            'number': '5555555555554444', 'expiry': '12/39', 'cvc': '123',
            'name': 'Synthetic User', 'email': 'test@example.invalid',
            'country': 'US', 'line1': '1221 SW Fourth Avenue', 'line2': '',
            'city': 'Portland', 'state': 'OR', 'postal_code': '97204'}}
        with patch.object(server, 'callback', side_effect=lambda _, body: seen.append(body)):
            thread = threading.Thread(target=lambda: result.append(job.details({'plan': 'plus'})))
            thread.start()
            for _ in range(1000):
                if job.waiting_details:
                    break
                threading.Event().wait(.001)
            job.submit_details(payload)
            thread.join(2)
        self.assertEqual(result[0].last4, '4444')
        self.assertIsNone(job.pending_details)
        self.assertEqual(payload, {})
        self.assertEqual(seen[0]['type'], 'details_required')
        with self.assertRaises(Stop):
            job.submit_details({'details': {}})

    def test_cancel_does_not_authorize_payment(self):
        job = server.Job('test', {})
        job.nonce = 'a' * 64
        job.signal(cancel=True)
        self.assertFalse(job.confirmed)

    def test_durable_revision_ack_required(self):
        job = server.Job('test', {})
        job.account_key = 'b' * 64
        with tempfile.TemporaryDirectory() as folder:
            job.root = Path(folder)
            path = job.root / ('b' * 64 + '.json')
            with patch.object(server, 'callback', side_effect=Stop('durable_state_unavailable')):
                with self.assertRaises(Stop):
                    job.persist(path, {'status': 'checkout_attempted'})
            self.assertEqual(job.revisions, {})
            with patch.object(server, 'callback', return_value={'revision': 1}) as callback:
                job.persist(path, {'status': 'checkout_attempted'})
            self.assertEqual(callback.call_args.args[1]['revision'], 0)
            self.assertEqual(job.revisions[path.name], 1)

    def test_invalid_record_path_cannot_write(self):
        job = server.Job('test', {})
        job.root = Path('/tmp')
        with patch.object(server, 'callback') as callback:
            with self.assertRaises(Stop):
                job.persist(Path('/tmp/credentials.json'), {})
            callback.assert_not_called()

    def test_all_current_plan_records_persist_and_restore_including_max_usage(self):
        from attempt_ledger import checkout_record_path
        account = 'account-1'
        with tempfile.TemporaryDirectory() as folder:
            job = server.Job('test', {})
            job.root = Path(folder)
            job.account_key = server.hashlib.sha256(account.encode()).hexdigest()
            records = []
            for plan in server.PLANS:
                path = checkout_record_path(job.root, account, plan)
                for record_path in (path, job.root / 'payments' / path.name):
                    with patch.object(server, 'callback', return_value={'revision': 1}) as callback:
                        job.persist(record_path, {'target_plan': plan})
                    records.append({'fileKey': str(record_path.relative_to(job.root)),
                                    'document': {'target_plan': plan}, 'revision': 1})
                    self.assertEqual(callback.call_args.args[1]['fileKey'], records[-1]['fileKey'])
            with patch.object(server, 'callback', return_value={'records': records}):
                job.restore_target(type('Target', (), {'account_id': account})())
            self.assertEqual(len(job.revisions), len(server.PLANS) * 2)
            for record in records:
                self.assertEqual(json.loads((job.root / record['fileKey']).read_text()), record['document'])
            for invalid in ('../' + path.name, 'payments/../' + path.name,
                            'a' * 64 + '-pro-500x.json', 'a' * 64 + '-pro-1000.json'):
                with self.subTest(invalid=invalid), patch.object(server, 'callback') as callback:
                    with self.assertRaises(Stop):
                        job.persist(job.root / invalid, {})
                    callback.assert_not_called()

    def test_invalid_json_reports_failure_without_saving_input(self):
        job = server.Job('test', {'sessionJson': 'not-json', 'action': 'check', 'plan': 'plus'})
        calls = []
        with patch.object(server, 'callback', side_effect=lambda _, body: calls.append(body)):
            job.run()
        self.assertTrue(job.done)
        self.assertEqual(job.payload, {})
        self.assertNotIn('not-json', json.dumps(calls))
        self.assertEqual(calls[-1]['type'], 'finished')

    def test_quote_replaces_only_an_unavailable_existing_checkout_once(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / 'existing.json').write_text('{}')
                target = type('Target', (), {'account_id': 'account'})()
                with patch.object(server.attempt_ledger, 'checkout_record_path',
                                  return_value=root / 'existing.json'), \
                     patch.object(server.browser_checkout, 'run_browser', new_callable=AsyncMock,
                                  side_effect=[
                                      {'status': 'blocked', 'reason': 'existing_checkout_unavailable',
                                       'checkout_requests_sent': 0, 'payment_requests_sent': 0},
                                      {'status': 'checkout_quote_verified'}
                                  ]) as run:
                    browser = MagicMock()
                    result = await server.quote_checkout(target, 'plus', root, browser=browser)
                self.assertEqual(result['status'], 'checkout_quote_verified')
                self.assertEqual(run.await_count, 2)
                self.assertTrue(run.await_args_list[0].kwargs['inspect_existing'])
                self.assertTrue(run.await_args_list[1].kwargs['create'])
                self.assertTrue(run.await_args_list[1].kwargs['replace_unpaid_checkout'])
                self.assertIs(run.await_args_list[0].kwargs['browser'], browser)
                self.assertIs(run.await_args_list[1].kwargs['browser'], browser)
        asyncio.run(exercise())




class RechargeDriverLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_isolated_jobs_use_distinct_drivers_and_execute_once_each(self):
        runtime = server.PersistentBrowserRuntime()
        drivers = [MagicMock(stop=AsyncMock()), MagicMock(stop=AsyncMock())]
        browsers = [MagicMock(close=AsyncMock()), MagicMock(close=AsyncMock())]
        starter = MagicMock(start=AsyncMock(side_effect=drivers))
        operation = AsyncMock(side_effect=["first", "second"])
        with (patch("playwright.async_api.async_playwright", return_value=starter),
              patch.object(server.fingerprint_runtime, "launch_fingerprint_browser",
                           AsyncMock(side_effect=browsers)) as launch):
            self.assertEqual(await runtime._execute_isolated(operation), "first")
            self.assertIsNone(runtime.playwright)
            self.assertEqual(await runtime._execute_isolated(operation), "second")
        self.assertEqual(starter.start.await_count, 2)
        self.assertEqual([call.args[0] for call in launch.await_args_list], drivers)
        self.assertEqual(operation.await_count, 2)
        for browser, driver in zip(browsers, drivers):
            browser.close.assert_awaited_once()
            driver.stop.assert_awaited_once()

    async def test_entry_discards_old_browser_and_dead_driver_before_launch(self):
        runtime = server.PersistentBrowserRuntime()
        sequence = []
        async def old_browser_close(): sequence.append("old_browser_close")
        async def old_driver_stop(): sequence.append("old_driver_stop")
        async def new_driver_start():
            sequence.append("new_driver_start")
            return fresh
        async def new_launch(driver, **options):
            self.assertIs(driver, fresh)
            sequence.append("new_browser_launch")
            return browser
        async def operation(current):
            self.assertIs(current, browser)
            sequence.append("operation")
            return "ok"
        runtime.browser = MagicMock(close=AsyncMock(side_effect=old_browser_close))
        runtime.playwright = MagicMock(stop=AsyncMock(side_effect=old_driver_stop))
        fresh = MagicMock(stop=AsyncMock())
        browser = MagicMock(close=AsyncMock())
        starter = MagicMock(start=AsyncMock(side_effect=new_driver_start))
        with (patch("playwright.async_api.async_playwright", return_value=starter),
              patch.object(server.fingerprint_runtime, "launch_fingerprint_browser", new_launch)):
            self.assertEqual(await runtime._execute_isolated(operation), "ok")
        self.assertEqual(sequence, ["old_browser_close", "old_driver_stop", "new_driver_start",
                                    "new_browser_launch", "operation"])
        fresh.stop.assert_awaited_once()
        self.assertIsNone(runtime.playwright)

    async def test_failed_entry_browser_cleanup_never_launches_or_executes(self):
        runtime = server.PersistentBrowserRuntime()
        old_browser = MagicMock(close=AsyncMock(side_effect=RuntimeError("synthetic")))
        runtime.browser = old_browser
        runtime.playwright = MagicMock(stop=AsyncMock())
        operation, factory = AsyncMock(), AsyncMock()
        with self.assertRaises(Stop) as stopped:
            await runtime._execute_isolated(operation, browser_factory=factory)
        self.assertEqual(stopped.exception.report["reason"], "fingerprint_cleanup_failed")
        self.assertIs(runtime.browser, old_browser)
        runtime.playwright.stop.assert_not_awaited()
        factory.assert_not_awaited()
        operation.assert_not_awaited()

    async def test_failed_entry_driver_cleanup_never_launches_or_executes(self):
        runtime = server.PersistentBrowserRuntime()
        old = MagicMock(stop=AsyncMock(side_effect=RuntimeError("synthetic")))
        runtime.playwright = old
        operation, factory = AsyncMock(), AsyncMock()
        for _ in range(2):
            with self.assertRaises(Stop) as stopped:
                await runtime._execute_isolated(operation, browser_factory=factory)
            self.assertEqual(stopped.exception.report["reason"], "fingerprint_cleanup_failed")
        self.assertTrue(runtime.driver_cleanup_failed)
        self.assertIs(runtime.playwright, old)
        old.stop.assert_awaited_once()
        factory.assert_not_awaited()
        operation.assert_not_awaited()

    async def test_failed_launch_still_discards_created_driver_without_retry(self):
        runtime = server.PersistentBrowserRuntime()
        driver = MagicMock(stop=AsyncMock())
        starter = MagicMock(start=AsyncMock(return_value=driver))
        operation = AsyncMock()
        with (patch("playwright.async_api.async_playwright", return_value=starter),
              patch.object(server.fingerprint_runtime, "launch_fingerprint_browser",
                           AsyncMock(side_effect=Stop("fingerprint_start_timeout"))) as launch):
            with self.assertRaises(Stop) as stopped:
                await runtime._execute_isolated(operation)
        self.assertEqual(stopped.exception.report["reason"], "fingerprint_start_timeout")
        starter.start.assert_awaited_once()
        launch.assert_awaited_once()
        operation.assert_not_awaited()
        driver.stop.assert_awaited_once()
        self.assertIsNone(runtime.playwright)

    async def test_operation_failure_is_not_replayed_and_driver_is_closed(self):
        runtime = server.PersistentBrowserRuntime()
        driver = MagicMock(stop=AsyncMock())
        browser = MagicMock(close=AsyncMock())
        async def factory(_runtime):
            runtime.playwright = driver
            return browser
        operation = AsyncMock(side_effect=Stop("official_plan_browser_error"))
        with self.assertRaises(Stop) as stopped:
            await runtime._execute_isolated(operation, browser_factory=factory)
        self.assertEqual(stopped.exception.report["reason"], "official_plan_browser_error")
        operation.assert_awaited_once_with(browser)
        browser.close.assert_awaited_once()
        driver.stop.assert_awaited_once()
        self.assertIsNone(runtime.playwright)

    async def test_final_driver_cleanup_failure_preserves_result_and_fences_next_job(self):
        runtime = server.PersistentBrowserRuntime()
        driver = MagicMock(stop=AsyncMock(side_effect=RuntimeError("synthetic")))
        browser = MagicMock(close=AsyncMock())
        async def factory(_runtime):
            runtime.playwright = driver
            return browser
        result = {"status": "blocked", "payment_requests_sent": 1}
        operation = AsyncMock(return_value=result)
        self.assertIs(await runtime._execute_isolated(operation, browser_factory=factory), result)
        operation.assert_awaited_once()
        self.assertTrue(runtime.driver_cleanup_failed)
        next_operation, next_factory = AsyncMock(), AsyncMock()
        with self.assertRaises(Stop):
            await runtime._execute_isolated(next_operation, browser_factory=next_factory)
        next_operation.assert_not_awaited()
        next_factory.assert_not_awaited()
        driver.stop.assert_awaited_once()

    async def test_final_browser_cleanup_failure_preserves_result_and_fences_next_job(self):
        runtime = server.PersistentBrowserRuntime()
        browser = MagicMock(close=AsyncMock(side_effect=RuntimeError("synthetic")))
        driver = MagicMock(stop=AsyncMock())
        async def factory(_runtime):
            runtime.playwright = driver
            return browser
        result = {"status": "blocked", "payment_requests_sent": 1}
        operation = AsyncMock(return_value=result)
        self.assertIs(await runtime._execute_isolated(operation, browser_factory=factory), result)
        self.assertIs(runtime.browser, browser)
        next_operation, next_factory = AsyncMock(), AsyncMock()
        with self.assertRaises(Stop):
            await runtime._execute_isolated(next_operation, browser_factory=next_factory)
        next_operation.assert_not_awaited()
        next_factory.assert_not_awaited()
        operation.assert_awaited_once()
        driver.stop.assert_awaited_once()

    async def test_public_driver_stop_timeout_is_bounded_and_fences_repeated_calls(self):
        runtime = server.PersistentBrowserRuntime()
        driver = MagicMock(stop=AsyncMock())
        runtime.playwright = driver
        async def fail_wait(awaitable, *, timeout):
            await awaitable
            self.assertEqual(timeout, 5)
            raise asyncio.TimeoutError()
        with patch.object(server.asyncio, "wait_for", fail_wait):
            self.assertFalse(await runtime._discard_playwright())
        self.assertFalse(await runtime._discard_playwright())
        self.assertTrue(runtime.driver_cleanup_failed)
        driver.stop.assert_awaited_once()


class NativeStartupTests(unittest.TestCase):
    def invoke(self, argv=(), *, start_error=None, stop_error=None):
        events = []
        runtime = MagicMock()
        listener = MagicMock()
        def start():
            events.append('start')
            if start_error:
                raise start_error

        def stop():
            events.append('stop')
            if stop_error:
                raise stop_error

        runtime.start.side_effect = start
        runtime.stop.side_effect = stop
        listener.serve_forever.side_effect = lambda: events.append('serve')
        listener.server_close.side_effect = lambda: events.append('close')

        def bind(address, handler):
            events.append('bind')
            self.assertIs(handler, server.Handler)
            return listener

        with (patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'),
              patch.object(server, 'BROWSER_RUNTIME', runtime),
              patch.object(server.fingerprint_runtime, 'fingerprint_ready', return_value=True) as ready,
              patch.object(server, 'ThreadingHTTPServer', side_effect=bind) as factory):
            if start_error or stop_error:
                with self.assertRaisesRegex(RuntimeError, 'synthetic'):
                    server.main(list(argv))
            else:
                self.assertEqual(server.main(list(argv)), 0)
        return events, runtime, factory, ready

    def test_default_linux_startup_binds_before_runtime_and_retains_original_paths(self):
        events, runtime, factory, ready = self.invoke()
        self.assertEqual(events, ['bind', 'start', 'serve', 'stop', 'close'])
        factory.assert_called_once_with(('0.0.0.0', 8051), server.Handler)
        ready.assert_called_once_with(None)
        self.assertIsNone(runtime.executable_path)

    def test_loopback_native_port_and_mac_engine_are_passed_to_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'Camoufox.app' / 'Contents' / 'MacOS' / 'camoufox'
            events, runtime, factory, ready = self.invoke(
                ['--host', '127.0.0.1', '--port', '8052', '--engine-path', str(binary)])
        self.assertEqual(events, ['bind', 'start', 'serve', 'stop', 'close'])
        factory.assert_called_once_with(('127.0.0.1', 8052), server.Handler)
        ready.assert_called_once_with(binary.resolve())
        self.assertEqual(runtime.executable_path, binary.resolve())

    def test_invalid_listener_arguments_stop_before_any_runtime_or_socket(self):
        for argv in (['--port', '0'], ['--port', '65536'], ['--port', 'not-a-port'],
                     ['--host', 'https://127.0.0.1'], ['--host', 'localhost'],
                     ['--host', '::1'], ['--unknown-option']):
            with (self.subTest(argv=argv), redirect_stderr(io.StringIO()),
                  patch.object(server, 'ThreadingHTTPServer') as listener,
                  patch.object(server, 'BROWSER_RUNTIME') as runtime):
                with self.assertRaises(SystemExit) as stopped:
                    server.main(argv)
                self.assertEqual(stopped.exception.code, 2)
                listener.assert_not_called()
                runtime.start.assert_not_called()

    def test_missing_engine_is_rejected_before_binding_or_starting_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / 'missing-engine'
            with (patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'),
                  patch.object(server, 'ThreadingHTTPServer') as listener,
                  patch.object(server, 'BROWSER_RUNTIME') as runtime):
                with self.assertRaisesRegex(SystemExit, '内核不存在'):
                    server.main(['--engine-path', str(missing)])
                listener.assert_not_called()
                runtime.start.assert_not_called()

    def test_invalid_role_or_missing_authentication_never_binds(self):
        for role, token, reason in (('invalid', 'fixture-worker-authentication-123456', '类型无效'),
                                    ('registration', 'fixture-worker-authentication-123456', '类型无效'),
                                    ('recharge', '', '凭据未配置')):
            with (self.subTest(role=role), patch.object(server, 'WORKER_ROLE', role),
                  patch.object(server, 'TOKEN', token),
                  patch.object(server, 'ThreadingHTTPServer') as listener,
                  patch.object(server, 'BROWSER_RUNTIME') as runtime):
                with self.assertRaisesRegex(SystemExit, reason):
                    server.main([])
                listener.assert_not_called()
                runtime.start.assert_not_called()

    def test_real_port_conflict_cannot_start_a_second_browser_runtime(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            with (patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'),
                  patch.object(server.fingerprint_runtime, 'fingerprint_ready', return_value=True),
                  patch.object(server, 'BROWSER_RUNTIME') as runtime):
                with self.assertRaises(OSError):
                    server.main(['--host', '127.0.0.1', '--port', str(port)])
                runtime.start.assert_not_called()
                runtime.stop.assert_not_called()

    def test_browser_startup_failure_retires_listener_and_runtime(self):
        events, runtime, _, _ = self.invoke(start_error=RuntimeError('synthetic startup'))
        self.assertEqual(events, ['bind', 'start', 'stop', 'close'])
        runtime.stop.assert_called_once_with()

    def test_listener_is_closed_even_when_runtime_shutdown_fails(self):
        events, _, _, _ = self.invoke(stop_error=RuntimeError('synthetic shutdown'))
        self.assertEqual(events, ['bind', 'start', 'serve', 'stop', 'close'])

    def test_import_does_not_install_process_signal_handlers(self):
        with patch.object(signal, 'signal') as install:
            runpy.run_path(str(Path(server.__file__)), run_name='synthetic_worker_import')
        install.assert_not_called()

    def test_cli_termination_signals_close_runtime_and_listener_and_restore_handler(self):
        previous_term = signal.getsignal(signal.SIGTERM)
        previous_int = signal.signal(signal.SIGINT, signal.default_int_handler)
        try:
            for signum in (signal.SIGTERM, signal.SIGINT):
                with self.subTest(signum=signum):
                    events = []
                    runtime, listener = MagicMock(), MagicMock()
                    runtime.start.side_effect = lambda: events.append('start')
                    runtime.stop.side_effect = lambda: events.append('stop')
                    listener.server_close.side_effect = lambda: events.append('close')

                    def serve():
                        events.append('serve')
                        signal.raise_signal(signum)

                    listener.serve_forever.side_effect = serve
                    with (patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'),
                          patch.object(server, 'BROWSER_RUNTIME', runtime),
                          patch.object(server.fingerprint_runtime, 'fingerprint_ready', return_value=True),
                          patch.object(server, 'ThreadingHTTPServer', return_value=listener)):
                        self.assertEqual(server.cli(['--host', '127.0.0.1']), 0)
                    self.assertEqual(events, ['start', 'serve', 'stop', 'close'])
                    self.assertIs(signal.getsignal(signal.SIGTERM), previous_term)
                    runtime.stop.assert_called_once_with()
                    listener.server_close.assert_called_once_with()
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)

    def test_cli_preflight_failure_restores_existing_signal_handler(self):
        previous_int = signal.getsignal(signal.SIGINT)
        previous_term = signal.getsignal(signal.SIGTERM)
        with patch.object(server, 'TOKEN', ''):
            with self.assertRaisesRegex(SystemExit, '凭据未配置'):
                server.cli([])
        self.assertIs(signal.getsignal(signal.SIGINT), previous_int)
        self.assertIs(signal.getsignal(signal.SIGTERM), previous_term)

    def test_cli_repeated_signals_cannot_interrupt_runtime_cleanup(self):
        previous_int = signal.getsignal(signal.SIGINT)
        previous_term = signal.getsignal(signal.SIGTERM)
        for first in (signal.SIGINT, signal.SIGTERM):
            for repeated in (signal.SIGINT, signal.SIGTERM):
                with self.subTest(first=first, repeated=repeated):
                    events = []
                    runtime, listener = MagicMock(), MagicMock()

                    def serve():
                        events.append('serve')
                        signal.raise_signal(first)

                    def stop():
                        events.append('stop_started')
                        signal.raise_signal(repeated)
                        events.append('stop_completed')

                    listener.serve_forever.side_effect = serve
                    runtime.stop.side_effect = stop
                    listener.server_close.side_effect = lambda: events.append('close')
                    with (patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'),
                          patch.object(server, 'BROWSER_RUNTIME', runtime),
                          patch.object(server.fingerprint_runtime, 'fingerprint_ready', return_value=True),
                          patch.object(server, 'ThreadingHTTPServer', return_value=listener)):
                        self.assertEqual(server.cli(['--host', '127.0.0.1']), 0)
                    self.assertEqual(events, ['serve', 'stop_started', 'stop_completed', 'close'])
                    self.assertIs(signal.getsignal(signal.SIGINT), previous_int)
                    self.assertIs(signal.getsignal(signal.SIGTERM), previous_term)
                    runtime.stop.assert_called_once_with()
                    listener.server_close.assert_called_once_with()

    def test_recharge_routes_and_authentication_remain_available(self):
        handler = object.__new__(server.Handler)
        handler.path = '/jobs/fixture/status'
        self.assertTrue(handler.serves_path())
        handler.headers = {'X-Recharge-Worker': 'wrong-fixture-authentication'}
        handler.reply = MagicMock()
        with patch.object(server, 'TOKEN', 'fixture-worker-authentication-123456'):
            handler.do_GET()
        handler.reply.assert_called_once_with(403, {'ok': False})

    def test_mac_engine_reaches_existing_browser_launcher_without_browser_fallback(self):
        async def exercise():
            binary = Path('/synthetic/Camoufox.app/Contents/MacOS/camoufox')
            runtime = server.PersistentBrowserRuntime(executable_path=binary)
            runtime.playwright = MagicMock()
            browser = MagicMock()
            proxy = {'server': 'http://proxy.example.invalid:8080'}
            with patch.object(server.fingerprint_runtime, 'launch_fingerprint_browser',
                              new=AsyncMock(return_value=browser)) as launch:
                self.assertIs(await runtime._new_browser(proxy=proxy), browser)
            launch.assert_awaited_once_with(runtime.playwright, proxy=proxy, executable_path=binary)
            runtime.playwright.chromium.launch.assert_not_called()
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
