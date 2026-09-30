import unittest
from unittest.mock import patch

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
