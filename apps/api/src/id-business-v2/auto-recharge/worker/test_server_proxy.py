import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import server
import server_proxy
from checkout_core import Stop


class ServerProxyTests(unittest.TestCase):
    def test_dynamic_response_accepts_common_proxy_formats(self):
        with patch.object(server_proxy.socket, 'getaddrinfo', return_value=[
            (None, None, None, None, ('8.8.8.8', 0))
        ]):
            self.assertEqual(server_proxy.parse_extracted('proxy.example:8080:user:pass', 'http'), {
                'server': 'http://proxy.example:8080', 'username': 'user', 'password': 'pass'
            })
            self.assertEqual(server_proxy.parse_extracted(
                '{"data":{"ip":"proxy.example","port":8080,"user":"u","pass":"p"}}',
                'http')['server'], 'http://proxy.example:8080')

    def test_static_proxy_is_isolated_and_private_addresses_are_rejected(self):
        with patch.object(server_proxy.socket, 'getaddrinfo', return_value=[
            (None, None, None, None, ('8.8.8.8', 0))
        ]):
            self.assertEqual(server_proxy.resolve_proxy({
                'mode': 'static', 'type': 'http', 'host': 'proxy.example', 'port': 8080,
                'username': 'user', 'password': 'password'
            }), {'server': 'http://proxy.example:8080', 'username': 'user', 'password': 'password'})
        with patch.object(server_proxy.socket, 'getaddrinfo', return_value=[
            (None, None, None, None, ('127.0.0.1', 0))
        ]):
            with self.assertRaises(Stop):
                server_proxy.resolve_proxy({
                    'mode': 'static', 'type': 'http', 'host': 'localhost', 'port': 8080
                })

    def test_extracted_url_decodes_userinfo_once_and_preserves_literal_plus(self):
        with patch.object(server_proxy, 'public_host', side_effect=lambda host: host):
            for scheme in ('http', 'https', 'socks5'):
                with self.subTest(scheme=scheme):
                    result = server_proxy.parse_extracted(
                        f'{scheme}://synthetic%40zone:synthetic%3Apass+%2540@proxy.example:8080',
                        scheme)
                    self.assertEqual(result['username'], 'synthetic@zone')
                    self.assertEqual(result['password'], 'synthetic:pass+%40')
            result = server_proxy.parse_extracted(
                'synthetic%40zone:synthetic%3Apass@proxy.example:8080', 'http')
            self.assertEqual(result['username'], 'synthetic@zone')
            self.assertEqual(result['password'], 'synthetic:pass')

    def test_extracted_url_rejects_decoded_controls_and_invalid_utf8(self):
        with patch.object(server_proxy, 'public_host', side_effect=lambda host: host):
            for userinfo in ('synthetic%0A:pass', 'synthetic:pass%00', 'synthetic:%C3%28',
                             'synthetic:%G0', 'synthetic:pass%'):
                with self.subTest(userinfo=userinfo):
                    with self.assertRaises(Stop) as stopped:
                        server_proxy.parse_extracted(f'http://{userinfo}@proxy.example:8080', 'http')
                    self.assertEqual(stopped.exception.report['reason'], 'server_proxy_invalid')

    def test_non_url_proxy_credentials_are_not_percent_decoded(self):
        with patch.object(server_proxy, 'public_host', side_effect=lambda host: host):
            for raw in ('proxy.example:8080:synthetic%40zone:pass%3Avalue',
                        '{"host":"proxy.example","port":8080,"username":"synthetic%40zone",'
                        '"password":"pass%3Avalue"}'):
                with self.subTest(raw=raw):
                    result = server_proxy.parse_extracted(raw, 'http')
                    self.assertEqual(result['username'], 'synthetic%40zone')
                    self.assertEqual(result['password'], 'pass%3Avalue')

    def test_server_quote_must_fit_explicit_authorization(self):
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'safety': {
                'authorizeSinglePayment': True, 'lockedCurrency': 'USD', 'maxAmountMinor': 2500
            }
        })
        money = {'currency': 'USD', 'amount': '20.00', 'amount_minor': 2000}
        quote = {'plan': 'plus', 'today': money, 'tax': {**money, 'amount': '0.00', 'amount_minor': 0},
                 'renewal': money, 'renewal_interval': 'monthly'}
        with patch.object(server, 'callback', return_value={'ok': True}) as callback:
            with patch.object(job.confirm_event, 'wait', side_effect=lambda _: job.signal(job.nonce)):
                self.assertTrue(job.confirm(quote, '4242'))
            self.assertEqual(callback.call_count, 1)
            with self.assertRaises(Stop):
                job.confirm({**quote, 'today': {**money, 'amount_minor': 2600}}, '4242')
            self.assertEqual(callback.call_count, 1)

    def test_login_progress_rejects_proxy_switch_before_callback(self):
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus'
        })
        job.preflight_network = {'ip': '8.8.8.8', 'country': 'US'}
        with patch.object(server, 'callback') as callback:
            with self.assertRaises(Stop):
                job.progress('session_verified', network={'ip': '1.1.1.1', 'country': 'US'})
            callback.assert_not_called()
            job.progress('session_verified', network={'ip': '8.8.8.8', 'country': 'US'})
            callback.assert_called_once()


class ProxyPrepareTests(unittest.IsolatedAsyncioTestCase):
    config = {'mode': 'dynamic', 'type': 'http', 'extractionUrl': 'https://proxy.example.invalid/extract'}

    def window(self):
        page = MagicMock(url='https://chatgpt.com/auth/login', close=AsyncMock(),
                         goto=AsyncMock(return_value=MagicMock(status=200)))
        context = MagicMock(new_page=AsyncMock(return_value=page), route=AsyncMock(),
                            unroute=AsyncMock(), close=AsyncMock())
        browser = MagicMock(new_context=AsyncMock(return_value=context), close=AsyncMock())
        return browser, context, page

    async def prepare(self, launch, **options):
        return await server_proxy.prepare_browser(
            dict(self.config), launch, expected_country='US',
            target_url='https://chatgpt.com/auth/login', **options)

    async def test_failed_windows_close_before_reextract_and_successful_page_is_kept(self):
        windows = [self.window() for _ in range(3)]
        sequence, configs, reports = [], [], []
        proxies = [{'server': 'http://proxy.example.invalid:' + str(8080 + i)} for i in range(3)]
        async def extract(config, **_):
            index = len(configs); configs.append(config)
            sequence.append('extract' + str(index))
            return proxies[index]
        async def launch(proxy):
            index = len([item for item in sequence if item.startswith('launch')])
            sequence.append('launch' + str(index))
            return windows[index][0]
        for index, (browser, _, _) in enumerate(windows):
            async def close(i=index): sequence.append('close' + str(i))
            browser.close.side_effect = close
        observe = AsyncMock(side_effect=[Stop('proxy_network_unconfirmed'),
            Stop('proxy_network_unconfirmed'), {'ip': '8.8.8.8', 'country': 'US'}])
        with patch.object(server_proxy, 'resolve', side_effect=extract), patch.object(server_proxy, 'observe_exit', observe):
            prepared = await self.prepare(launch, progress=lambda stage, **data: reports.append((stage, data)))
        self.assertEqual(sequence, ['extract0', 'launch0', 'close0', 'extract1', 'launch1', 'close1', 'extract2', 'launch2'])
        self.assertIs(prepared['context'], windows[2][1])
        self.assertIs(prepared['page'], windows[2][2])
        self.assertEqual(proxies[:2], [{}, {}])
        windows[2][0].close.assert_not_awaited()
        self.assertEqual([data['proxy_attempt'] for stage, data in reports if stage == 'proxy_resolving'], [1, 2, 3])
        self.assertEqual(observe.await_args.kwargs['budget'].seconds, 20)
        self.assertEqual(observe.await_args.kwargs['attempts'], 1)

    async def test_tenth_failure_stops_without_eleventh_extraction_or_business_write(self):
        browser, context, _ = self.window()
        with (patch.object(server_proxy, 'resolve', AsyncMock(side_effect=lambda *a, **k: {'server': 'http://proxy.example.invalid:8080'})) as resolve,
              patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=Stop('proxy_network_unconfirmed'))),
              patch.object(server.pay, 'run_flow', AsyncMock()) as payment):
            launch = AsyncMock(return_value=browser)
            with self.assertRaises(Stop) as stopped: await self.prepare(launch)
        self.assertEqual(stopped.exception.report['reason'], 'proxy_retry_exhausted')
        self.assertEqual(stopped.exception.report['proxy_attempt'], 10)
        self.assertEqual(resolve.await_count, 10)
        self.assertEqual(launch.await_count, 10)
        self.assertEqual(browser.close.await_count, 10)
        context.new_page.assert_not_awaited()
        payment.assert_not_awaited()

    async def test_page_hang_uses_twenty_second_budget_then_a_fresh_window(self):
        windows = [self.window() for _ in range(2)]
        async def never(*_args, **_kwargs): await asyncio.Event().wait()
        windows[0][2].goto.side_effect = never
        with (patch.object(server_proxy, 'PREPARE_TIMEOUT_SECONDS', 0.02),
              patch.object(server_proxy, 'resolve', AsyncMock(side_effect=lambda *a, **k: {'server': 'http://proxy.example.invalid:8080'})),
              patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=[
                  {'ip': '8.8.8.8', 'country': 'US'}, {'ip': '1.1.1.1', 'country': 'US'}]))):
            prepared = await asyncio.wait_for(self.prepare(AsyncMock(side_effect=[w[0] for w in windows])), timeout=0.5)
        self.assertIs(prepared['browser'], windows[1][0])
        windows[0][0].close.assert_awaited_once()
        self.assertEqual(windows[0][2].goto.await_args.kwargs['wait_until'], 'domcontentloaded')

    async def test_same_returned_exit_is_rejected_before_second_page_load(self):
        windows = [self.window() for _ in range(3)]
        windows[0][2].goto.side_effect = TimeoutError('synthetic')
        with (patch.object(server_proxy, 'resolve', AsyncMock(side_effect=lambda *a, **k: {'server': 'http://proxy.example.invalid:8080'})),
              patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=[
                  {'ip': '8.8.8.8', 'country': 'US'}, {'ip': '8.8.8.8', 'country': 'US'},
                  {'ip': '1.1.1.1', 'country': 'US'}]))):
            prepared = await self.prepare(AsyncMock(side_effect=[w[0] for w in windows]))
        self.assertIs(prepared['browser'], windows[2][0])
        windows[1][2].goto.assert_not_awaited()
        windows[1][0].close.assert_awaited_once()

    async def test_cancel_during_probe_closes_original_and_never_reextracts(self):
        browser, _, _ = self.window(); cancelled = False
        async def probe(*_, **__):
            nonlocal cancelled
            cancelled = True
            raise Stop('operation_cancelled')
        with (patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve,
              patch.object(server_proxy, 'observe_exit', side_effect=probe)):
            with self.assertRaises(Stop) as stopped: await self.prepare(AsyncMock(return_value=browser), cancelled=lambda: cancelled)
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        resolve.assert_awaited_once()
        browser.close.assert_awaited_once()

    async def test_configuration_kernel_and_authorization_failures_are_not_retried(self):
        for reason in ('server_proxy_invalid', 'fingerprint_engine_unavailable', 'durable_state_unavailable'):
            with self.subTest(reason=reason):
                launch = AsyncMock(side_effect=Stop(reason))
                with patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve:
                    with self.assertRaises(Stop) as stopped: await self.prepare(launch)
                self.assertEqual(stopped.exception.report['reason'], reason)
                resolve.assert_awaited_once()
                launch.assert_awaited_once()

    async def test_static_proxy_and_original_order_recheck_never_rotate(self):
        for config, allow_retry in ((dict(self.config, mode='static'), True), (self.config, False)):
            with self.subTest(mode=config['mode'], allow_retry=allow_retry):
                browser, _, _ = self.window()
                with (patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve,
                      patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=Stop('proxy_network_unconfirmed')))):
                    with self.assertRaises(Stop) as stopped:
                        await server_proxy.prepare_browser(config, AsyncMock(return_value=browser),
                            expected_country='US', target_url='https://chatgpt.com/auth/login', allow_retry=allow_retry)
                self.assertEqual(stopped.exception.report['reason'], 'proxy_network_unconfirmed')
                resolve.assert_awaited_once()

    async def test_browser_cleanup_failure_stops_before_further_extraction(self):
        browser, _, _ = self.window(); browser.close.side_effect = RuntimeError('private details')
        with (patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve,
              patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=Stop('proxy_network_unconfirmed')))):
            with self.assertRaises(Stop) as stopped: await self.prepare(AsyncMock(return_value=browser))
        self.assertEqual(stopped.exception.report['reason'], 'proxy_cleanup_failed')
        resolve.assert_awaited_once()

    async def test_preflight_blocks_business_writes_allows_anonymous_bootstrap_and_does_not_rotate_challenges(self):
        browser, context, page = self.window(); page.goto.return_value.status = 403
        with (patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve,
              patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={'ip': '8.8.8.8', 'country': 'US'}))):
            await self.prepare(AsyncMock(return_value=browser))
        resolve.assert_awaited_once()
        blocker = context.route.await_args.args[1]
        for url in ('https://api.stripe.com/v1/payment_pages/cs_test/confirm',
                    'https://chatgpt.com/backend-api/payments/checkout', 'https://pay.openai.com/checkout',
                    'https://auth.openai.com/u/login/identifier', 'https://auth.openai.com/u/signup/password'):
            route = MagicMock(request=MagicMock(method='POST', url=url, is_navigation_request=lambda: False), abort=AsyncMock(), fallback=AsyncMock())
            await blocker(route); route.abort.assert_awaited_once(); route.fallback.assert_not_awaited()
        bootstrap = MagicMock(request=MagicMock(method='POST', url='https://chatgpt.com/fixture/bootstrap', is_navigation_request=lambda: False),
                              abort=AsyncMock(), fallback=AsyncMock())
        await blocker(bootstrap); bootstrap.fallback.assert_awaited_once(); bootstrap.abort.assert_not_awaited()
        navigation = MagicMock(request=MagicMock(method='POST', url='https://chatgpt.com/fixture/submit', is_navigation_request=lambda: True),
                               abort=AsyncMock(), fallback=AsyncMock())
        await blocker(navigation); navigation.abort.assert_awaited_once(); navigation.fallback.assert_not_awaited()
        context.unroute.assert_awaited_once_with('**/*', blocker)
        browser.close.assert_not_awaited()

    async def test_invalid_extraction_and_probe_verification_challenge_never_rotate(self):
        launch = AsyncMock()
        with patch.object(server_proxy, 'resolve', AsyncMock(side_effect=Stop('server_proxy_invalid'))) as resolve:
            with self.assertRaises(Stop) as stopped: await self.prepare(launch)
        self.assertEqual(stopped.exception.report['reason'], 'server_proxy_invalid')
        resolve.assert_awaited_once(); launch.assert_not_awaited()
        browser, _, _ = self.window()
        with (patch.object(server_proxy, 'resolve', AsyncMock(return_value={'server': 'http://proxy.example.invalid:8080'})) as resolve,
              patch.object(server_proxy, 'observe_exit', AsyncMock(side_effect=Stop('verification_required')))):
            with self.assertRaises(Stop) as stopped: await self.prepare(AsyncMock(return_value=browser))
        self.assertEqual(stopped.exception.report['reason'], 'verification_required')
        resolve.assert_awaited_once(); browser.close.assert_awaited_once()


class ServerProxyExitTests(unittest.IsolatedAsyncioTestCase):
    async def never(self, *args, **kwargs):
        await asyncio.Event().wait()

    def probe(self, text='ip=8.8.8.8\nloc=PH\n', **overrides):
        response = type('Response', (), {
            'status': 200, 'url': 'https://chatgpt.com/cdn-cgi/trace',
            'text': AsyncMock(return_value=text), **overrides
        })()
        page = type('Page', (), {
            'goto': AsyncMock(return_value=response), 'close': AsyncMock()
        })()
        context = type('Context', (), {'new_page': AsyncMock(return_value=page)})()
        return context, page

    async def test_transient_probe_failure_retries_same_browser_context(self):
        context, page = self.probe()
        response = page.goto.return_value
        page.goto.side_effect = [TimeoutError('synthetic timeout'), response]
        self.assertEqual(await server_proxy.observe_exit(context), {'ip': '8.8.8.8', 'country': 'PH'})
        self.assertEqual(page.goto.await_count, 2)
        context.new_page.assert_awaited_once()
        page.close.assert_awaited_once()

    async def test_creation_body_and_close_cannot_hold_the_probe_indefinitely(self):
        for waiting_at in ('new_page', 'response_body', 'page_close'):
            with self.subTest(waiting_at=waiting_at):
                context, page = self.probe()
                operation = (context.new_page if waiting_at == 'new_page' else
                             page.goto.return_value.text if waiting_at == 'response_body' else
                             page.close)
                operation.side_effect = self.never
                with (patch.object(server_proxy, 'EXIT_TIMEOUT_SECONDS', 0.03),
                      patch.object(server_proxy, 'CLEANUP_TIMEOUT_SECONDS', 0.02)):
                    with self.assertRaises(Stop) as stopped:
                        await asyncio.wait_for(server_proxy.observe_exit(context), timeout=0.3)
                self.assertEqual(stopped.exception.report['reason'], 'proxy_network_unconfirmed')
                context.new_page.assert_awaited_once()
                if waiting_at != 'new_page':
                    page.close.assert_awaited_once()

    async def test_cancelled_probe_does_not_retry_or_continue_to_login(self):
        context, page = self.probe()
        cancelled = False

        async def body():
            nonlocal cancelled
            cancelled = True
            await self.never()

        page.goto.return_value.text.side_effect = body
        with patch.object(server_proxy, 'EXIT_TIMEOUT_SECONDS', 0.03):
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(server_proxy.observe_exit(
                    context, cancelled=lambda: cancelled), timeout=0.3)
        self.assertEqual(stopped.exception.report['reason'], 'operation_cancelled')
        page.goto.assert_awaited_once()
        page.close.assert_awaited_once()

    async def test_cleanup_failure_does_not_replace_the_original_proxy_failure(self):
        context, page = self.probe(status=403)
        page.close.side_effect = self.never
        with patch.object(server_proxy, 'CLEANUP_TIMEOUT_SECONDS', 0.02):
            with self.assertRaises(Stop) as stopped:
                await server_proxy.observe_exit(context)
        self.assertEqual(stopped.exception.report['reason'], 'proxy_network_unconfirmed')
        self.assertEqual(page.goto.await_count, 2)
        page.close.assert_awaited_once()

    async def test_resolve_has_a_total_deadline_and_never_refetches(self):
        import time

        def delayed(_config):
            time.sleep(0.07)
            return {'server': 'http://proxy.example.invalid:8080'}

        with (patch.object(server_proxy, 'RESOLVE_TIMEOUT_SECONDS', 0.02),
              patch.object(server_proxy, 'resolve_proxy', side_effect=delayed) as extraction):
            with self.assertRaises(Stop) as stopped:
                await asyncio.wait_for(server_proxy.resolve({}), timeout=0.3)
        self.assertEqual(stopped.exception.report['reason'], 'server_proxy_unavailable')
        extraction.assert_called_once()

    async def test_persistent_probe_failure_is_bounded_and_redacted(self):
        context, page = self.probe()
        page.goto.side_effect = RuntimeError('synthetic credential must not be returned')
        with self.assertRaises(Stop) as stopped:
            await server_proxy.observe_exit(context)
        self.assertEqual(stopped.exception.report['reason'], 'proxy_network_unconfirmed')
        self.assertEqual(page.goto.await_count, 2)
        page.close.assert_awaited_once()

    async def test_invalid_probe_responses_never_allow_login(self):
        for options in [
            {'text': 'ip=127.0.0.1\nloc=PH\n'},
            {'text': 'ip=8.8.8.8\nloc=unknown\n'},
            {'text': 'x' * 4097},
            {'status': 403},
            {'url': 'https://example.invalid/cdn-cgi/trace'},
            {'url': 'http://chatgpt.com/cdn-cgi/trace'}
        ]:
            context, page = self.probe(**options)
            with self.assertRaises(Stop):
                await server_proxy.observe_exit(context)
            self.assertEqual(page.goto.await_count, 2)
            page.close.assert_awaited_once()

    async def test_philippines_exit_keeps_us_billing_address_independent(self):
        context = type('Context', (), {'close': AsyncMock()})()
        browser = type('Browser', (), {'new_context': AsyncMock(return_value=context)})()
        target = type('Target', (), {'account_id': 'synthetic-account'})()
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'expectedCountry': 'PH',
            'proxy': {'mode': 'static', 'type': 'http'},
            'login': {'email': 'test@example.invalid', 'password': 'synthetic'},
            'details': {
                'number': '5555555555554444', 'expiry': '12/39', 'cvc': '123',
                'name': 'Synthetic Test User', 'email': 'test@example.invalid',
                'country': 'US', 'line1': '1221 SW Fourth Avenue', 'line2': '',
                'city': 'Portland', 'state': 'OR', 'postal_code': '97204'
            }
        })
        job.login_target = AsyncMock(return_value=(target, {'current_plan': 'free'}))
        job.progress = MagicMock()

        async def synthetic_flow(_target, _root, _plan, **options):
            self.assertEqual(options['expected_country'], 'PH')
            details = options['details_reader'](None)
            try:
                self.assertEqual(details.country, 'US')
                self.assertEqual(details.line1, '1221 SW Fourth Avenue')
            finally:
                details.clear()
            return {'status': 'synthetic_verified', 'payment_requests_sent': 0}

        with (patch.object(server_proxy, 'resolve_proxy', return_value={
                'server': 'http://proxy.example.invalid:8080'
              }),
              patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={
                'ip': '8.8.8.8', 'country': 'PH'
              })),
              patch.object(job, 'restore_target'),
              patch.object(server.pay, 'run_flow', AsyncMock(side_effect=synthetic_flow)) as flow):
            result = await job.execute(browser)
        self.assertEqual(result['payment_requests_sent'], 0)
        job.login_target.assert_awaited_once()
        flow.assert_awaited_once()
        context.close.assert_awaited_once()

    async def test_observes_real_exit_and_rejects_unconfirmed_country(self):
        response = type('Response', (), {
            'status': 200, 'url': 'https://chatgpt.com/cdn-cgi/trace',
            'text': AsyncMock(return_value='ip=8.8.8.8\nloc=US\n')
        })()
        page = type('Page', (), {
            'goto': AsyncMock(return_value=response), 'close': AsyncMock()
        })()
        context = type('Context', (), {'new_page': AsyncMock(return_value=page)})()
        self.assertEqual(await server_proxy.observe_exit(context), {
            'ip': '8.8.8.8', 'country': 'US'
        })
        response.text = AsyncMock(return_value='ip=8.8.8.8\nloc=unknown\n')
        with self.assertRaises(Stop):
            await server_proxy.observe_exit(context)
        self.assertEqual(page.close.await_count, 2)

    async def test_wrong_exit_country_stops_before_official_login(self):
        context = type('Context', (), {'close': AsyncMock()})()
        browser = type('Browser', (), {'new_context': AsyncMock(return_value=context)})()
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'expectedCountry': 'US',
            'proxy': {'mode': 'dynamic', 'type': 'http', 'extractionUrl': 'https://example.com'},
            'login': {'email': 'example@example.com', 'password': 'synthetic'}
        })
        job.login_target = AsyncMock()
        job.progress = MagicMock()
        with patch.object(server_proxy, 'resolve_proxy', return_value={
            'server': 'http://proxy.example:8080', 'username': '', 'password': ''
        }), patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={
            'ip': '8.8.8.8', 'country': 'CA'
        })):
            with self.assertRaises(Stop) as stopped:
                await job.execute(browser)
        self.assertEqual(stopped.exception.report['reason'], 'proxy_country_mismatch')
        job.login_target.assert_not_awaited()
        context.close.assert_awaited_once()

    async def test_repeated_exit_ip_stops_before_official_login(self):
        context = type('Context', (), {'close': AsyncMock()})()
        browser = type('Browser', (), {'new_context': AsyncMock(return_value=context)})()
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'expectedCountry': 'US',
            'previousLoginIp': '8.8.8.8',
            'proxy': {'mode': 'dynamic', 'type': 'http', 'extractionUrl': 'https://example.com'},
            'login': {'email': 'example@example.com', 'password': 'synthetic'}
        })
        job.login_target = AsyncMock()
        job.progress = MagicMock()
        with patch.object(server_proxy, 'resolve_proxy', return_value={
            'server': 'http://proxy.example:8080', 'username': '', 'password': ''
        }), patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={
            'ip': '8.8.8.8', 'country': 'US'
        })):
            with self.assertRaises(Stop) as stopped:
                await job.execute(browser)
        self.assertEqual(stopped.exception.report['reason'], 'proxy_ip_not_rotated')
        job.login_target.assert_not_awaited()
        context.close.assert_awaited_once()
