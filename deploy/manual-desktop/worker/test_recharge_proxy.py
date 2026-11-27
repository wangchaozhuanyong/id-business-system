import asyncio
import base64
from contextlib import suppress
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import recharge_proxy as proxy


OK = b'HTTP/1.1 200 Connection Established\r\n\r\n'


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = Path(__file__).resolve().parents[3] / '.runtime' / 'worker-proxy-tests'
        root.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(temp.cleanup)
        self.addCleanup(os.chdir, Path.cwd())
        # A short relative path also works on macOS's Unix socket boundary.
        os.chdir(temp.name)
        self.relay_path = 'fixture-egress.sock'
        self.connections = []
        self.tasks = set()

    async def server(self, start, handler, *args, **kwargs):
        def accept(reader, writer):
            task = asyncio.create_task(handler(reader, writer))
            self.tasks.add((task, writer))

        listener = await start(accept, *args, **kwargs)
        self.addAsyncCleanup(self.close_server, listener)
        return listener

    async def close_server(self, server):
        server.close()
        for task, writer in self.tasks:
            writer.close()
            if not task.done():
                task.cancel()
        await asyncio.wait_for(
            asyncio.gather(*(task for task, _ in self.tasks), return_exceptions=True), 2
        )
        await server.wait_closed()
        for task, _ in self.tasks:
            if not task.cancelled() and task.exception():
                raise task.exception()

    async def start(self, fixture, credentials=None, *, renewal=False):
        async def upstream(reader, writer):
            try:
                head = await reader.readuntil(b'\r\n\r\n')
                self.connections.append(head)
                await fixture(reader, writer)
            finally:
                await proxy._close(writer)

        await self.server(asyncio.start_unix_server, upstream, self.relay_path)
        service = await proxy.open_proxy(credentials, relay_path=self.relay_path, renewal=renewal)
        self.addAsyncCleanup(service.close)
        self.assertEqual(service._listener.sockets[0].getsockname()[0], '127.0.0.1')
        return service

    async def connect(self, service, message):
        reader, writer = await asyncio.open_connection('127.0.0.1', service.port)
        self.addAsyncCleanup(proxy._close, writer)
        writer.write(message)
        await writer.drain()
        return reader, writer

    async def test_renewal_uses_shared_official_destinations_without_probe_or_credentials(self):
        for host in ('auth0.openai.com', 'ws.chatgpt.com', 'accounts.google.com', 'idmsa.apple.com',
                     'login.microsoftonline.com', 'checkout.stripe.com', 'js.stripe.com', 'challenges.cloudflare.com'):
            self.assertTrue(proxy.renewal_host_allowed(host), host)
        for host in (proxy.PROBE_HOST, 'notopenai.com', 'chatgpt.com.evil.test', '.openai.com', 'evil..openai.com',
                     '-bad.openai.com', 'auth.google.com', 'anything.checkout.stripe.com', '192.168.1.1'):
            self.assertFalse(proxy.renewal_host_allowed(host), host)
        self.assertFalse(proxy._allowed_host('accounts.google.com'))
        self.assertTrue(proxy._allowed_host(proxy.PROBE_HOST))
        with self.assertRaises(proxy.ProxyError):
            await proxy.open_proxy(('fixture', 'fixture'), relay_path=self.relay_path, renewal=True)

        async def upstream(_reader, writer):
            writer.write(OK)

        service = await self.start(upstream, renewal=True)
        reader, _ = await self.connect(service, b'CONNECT accounts.google.com:443 HTTP/1.1\r\n\r\n')
        self.assertEqual(await reader.readuntil(b'\r\n\r\n'), OK)
        self.assertEqual(self.connections, [
            b'CONNECT accounts.google.com:443 HTTP/1.1\r\nHost: accounts.google.com:443\r\n\r\n'])
        denied, _ = await self.connect(service, b'CONNECT api.country.is:443 HTTP/1.1\r\n\r\n')
        self.assertIn(b'403', await denied.readuntil(b'\r\n\r\n'))
        self.assertEqual(len(self.connections), 1)

    async def test_connect_has_fixed_authorization_and_forwards_opaque_bytes(self):
        async def fixture(reader, writer):
            writer.write(b'HTTP/1.0 200 accepted\r\nX-Fixture: invisible\r\n\r\n')
            await writer.drain()
            writer.write((await reader.read())[::-1])
            await writer.drain()

        credentials = ('fixture', 'test:proxy-auth')
        service = await self.start(fixture, credentials)
        reader, writer = await self.connect(
            service,
            b'CONNECT ChatGPT.com:443 HTTP/1.1\r\nHost: ChatGPT.com:443\r\nX-Browser: ignored\r\n\r\n',
        )
        self.assertEqual(await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2), OK)
        writer.write(b'opaque payload')
        writer.write_eof()
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b'daolyap euqapo')
        authorization = base64.b64encode(':'.join(credentials).encode())
        self.assertEqual(self.connections, [
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n'
            b'Proxy-Authorization: Basic ' + authorization + b'\r\n\r\n',
        ])

    async def test_non_connect_private_targets_and_ambiguous_requests_do_not_reach_upstream(self):
        async def fixture(_reader, _writer):
            self.fail('An unapproved request reached the relay')

        service = await self.start(fixture)
        cases = (
            (b'GET https://chatgpt.com/ HTTP/1.1', b'400'),
            (b'CONNECT chatgpt.com:80 HTTP/1.1', b'400'),
            (b'CONNECT chatgpt.com:443/ HTTP/1.1', b'400'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nContent-Length: 2', b'400'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nTransfer-Encoding: chunked', b'400'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: example.com:443', b'400'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nProxy-Authorization: Basic fixture', b'400'),
            (b'CONNECT [::1]:443 HTTP/1.1', b'400'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nX-Too-Large: ' + b'a' * proxy.HEADER_LIMIT, b'400'),
            (b'CONNECT 169.254.169.254:443 HTTP/1.1', b'403'),
            (b'CONNECT chatgpt.com.example.net:443 HTTP/1.1', b'403'),
            (b'CONNECT notchatgpt.com:443 HTTP/1.1', b'403'),
            (b'CONNECT subdomain.stripe.com:443 HTTP/1.1', b'403'),
        )
        for request, status in cases:
            with self.subTest(status=status, request=request[:100]):
                reader, writer = await self.connect(service, request + b'\r\n\r\n')
                self.assertTrue((await asyncio.wait_for(reader.read(), 2)).startswith(b'HTTP/1.1 ' + status))
                await proxy._close(writer)
        self.assertEqual(self.connections, [])

    async def test_upstream_rejection_is_sanitized(self):
        async def fixture(_reader, writer):
            writer.write(b'HTTP/1.1 407 Private Reason\r\nX-Private: undisclosed\r\n\r\n')
            await writer.drain()

        service = await self.start(fixture)
        reader, _ = await self.connect(service, b'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\n\r\n')
        response = await asyncio.wait_for(reader.read(), 2)
        self.assertEqual(response, b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        self.assertEqual(self.connections, [b'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\nHost: ws.chatgpt.com:443\r\n\r\n'])

    async def test_probe_checks_https_exit_over_same_proxy_and_validates_certificate_and_country(self):
        key, cert = Path('fixture.key').resolve(), Path('fixture.crt').resolve()
        config = Path('fixture.cnf')
        config.write_text(
            '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n'
            f'[dn]\nCN={proxy.PROBE_HOST}\n[extensions]\nsubjectAltName=DNS:{proxy.PROBE_HOST}\n',
            encoding='ascii',
        )
        await asyncio.to_thread(
            subprocess.run, ['openssl', 'req', '-new', '-x509', '-nodes', '-newkey', 'rsa:2048',
                             '-keyout', str(key), '-out', str(cert), '-config', str(config), '-days', '1'],
            check=True, capture_output=True, timeout=8,
        )
        expected_get = b'GET / HTTP/1.1\r\nHost: api.country.is\r\n'
        sni = []
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(cert, key)
        tls_context.set_servername_callback(lambda _socket, hostname, _context: sni.append(hostname))
        payload = json.dumps({'ip': '1.1.1.1', 'country': 'MY'}).encode('ascii')

        async def https(reader, writer):
            try:
                self.assertTrue((await reader.readuntil(b'\r\n\r\n')).startswith(expected_get))
                writer.write(
                    b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n'
                    b'Connection: close\r\n\r\n' + format(len(payload), 'x').encode('ascii') + b'\r\n'
                    + payload + b'\r\n0\r\n\r\n'
                )
                await writer.drain()
            finally:
                await proxy._close(writer)

        https_server = await self.server(asyncio.start_server, https, '127.0.0.1', 0, ssl=tls_context)
        port = https_server.sockets[0].getsockname()[1]

        async def fixture(reader, writer):
            remote_reader, remote_writer = await asyncio.open_connection('127.0.0.1', port)
            try:
                writer.write(OK)
                await writer.drain()
                with suppress(OSError):
                    await proxy._tunnel(reader, writer, remote_reader, remote_writer)
            finally:
                await proxy._close(remote_writer)

        service = await self.start(fixture)
        loop = asyncio.get_running_loop()
        old_handler = loop.get_exception_handler()
        self.addCleanup(loop.set_exception_handler, old_handler)

        def fixture_tls_error(active_loop, context):
            error = context.get('exception')
            if not isinstance(error, ssl.SSLError) or error.reason != 'TLSV1_ALERT_UNKNOWN_CA':
                if old_handler is None:
                    active_loop.default_exception_handler(context)
                else:
                    old_handler(active_loop, context)

        # The scenario deliberately fails the fixture's TLS negotiation.
        loop.set_exception_handler(fixture_tls_error)
        with self.assertRaisesRegex(proxy.ProxyError, 'check failed'):
            await proxy.verify_exit(service, 'MY')
        context = ssl.create_default_context(cafile=cert)
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        with patch.object(proxy.ssl, 'create_default_context', return_value=context):
            self.assertEqual(await proxy.verify_exit(service, 'MY'), {'ip': '1.1.1.1', 'country': 'MY'})
            with self.assertRaisesRegex(proxy.ProxyError, 'country does not match'):
                await proxy.verify_exit(service, 'PH')
        self.assertEqual(sni, [proxy.PROBE_HOST] * 3)
        self.assertEqual(self.connections, [
            b'CONNECT api.country.is:443 HTTP/1.1\r\nHost: api.country.is:443\r\n\r\n',
        ] * 3)

    async def test_probe_deadline_closes_stalled_tls_connection(self):
        observed_eof = asyncio.Event()

        async def fixture(reader, writer):
            writer.write(OK)
            await writer.drain()
            await reader.read()
            observed_eof.set()

        service = await self.start(fixture)
        with patch.object(proxy, 'PROBE_TIMEOUT', 0.2):
            with self.assertRaisesRegex(proxy.ProxyError, 'check failed'):
                await proxy.verify_exit(service)
        await asyncio.wait_for(observed_eof.wait(), 2)

    def test_invalid_exit_address_and_credentials_have_generic_errors(self):
        for ip in ('127.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::ffff:1.1.1.1', '2002:808:808::1', '::1', 'invalid'):
            with self.assertRaises(proxy.ProxyError):
                proxy._validated_exit({'ip': ip, 'country': 'MY'}, 'MY')
        with self.assertRaises(proxy.ProxyError):
            proxy._validated_exit({'ip': '1.1.1.1', 'country': 'Malaysia'}, '')
        with self.assertRaisesRegex(proxy.ProxyError, '^Proxy credentials are invalid$'):
            proxy._basic_auth(('fixture', 'opaque\r\nfixture'))


if __name__ == '__main__':
    unittest.main()
