import unittest
from unittest.mock import AsyncMock, patch

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
