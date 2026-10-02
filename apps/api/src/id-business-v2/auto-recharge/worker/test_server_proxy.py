import unittest
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

    def test_server_quote_must_fit_explicit_authorization(self):
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'plus', 'safety': {
                'authorizeSinglePayment': True, 'lockedCurrency': 'USD', 'maxAmountMinor': 2500
            }
        })
        money = {'currency': 'USD', 'amount': '20.00', 'amount_minor': 2000}
        quote = {'plan': 'plus', 'today': money, 'tax': {**money, 'amount_minor': 0},
                 'renewal': money, 'renewal_interval': 'monthly'}
        with patch.object(server, 'callback', return_value={'ok': True}) as callback:
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


class ServerProxyExitTests(unittest.IsolatedAsyncioTestCase):
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
        with patch.object(server_proxy, 'resolve_proxy', return_value={
            'server': 'http://proxy.example:8080', 'username': '', 'password': ''
        }), patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={
            'ip': '8.8.8.8', 'country': 'CA'
        })):
            with self.assertRaises(Stop):
                await job.execute(browser)
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
        with patch.object(server_proxy, 'resolve_proxy', return_value={
            'server': 'http://proxy.example:8080', 'username': '', 'password': ''
        }), patch.object(server_proxy, 'observe_exit', AsyncMock(return_value={
            'ip': '8.8.8.8', 'country': 'US'
        })):
            with self.assertRaises(Stop):
                await job.execute(browser)
        job.login_target.assert_not_awaited()
        context.close.assert_awaited_once()
