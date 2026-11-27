import asyncio
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import egress


def record(address, port=8080):
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    sockaddr = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', sockaddr)


class ResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_is_absolute_pins_one_numeric_address_and_omits_credentials(self):
        records = [record('2606:4700:4700::1111'), record('9.9.9.9'), record('1.1.1.1')]
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=records)) as lookup:
            pinned = await egress.resolve_proxy('http://fixture:p%40ss@proxy.example:8080/')
        self.assertEqual((pinned.address, pinned.port, pinned.family), ('1.1.1.1', 8080, socket.AF_INET))
        lookup.assert_awaited_once_with(
            'proxy.example.', 8080, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        )
        self.assertNotIn('fixture', repr(pinned))
        self.assertNotIn('proxy.example', repr(pinned))

    async def test_numeric_address_never_resolves_dns(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock()) as lookup:
            pinned = await egress.resolve_proxy('http://[2606:4700:4700:0::1111]:443')
        self.assertEqual((pinned.address, pinned.family), ('2606:4700:4700::1111', socket.AF_INET6))
        lookup.assert_not_called()

    async def test_mixed_dns_answers_and_policy_exclusions_fail_closed(self):
        loop = asyncio.get_running_loop()
        cases = [
            ([record('1.1.1.1'), record('10.1.0.5')], ()),
            ([record('1.1.1.1'), record('::ffff:8.8.8.8')], ()),
            ([record('1.1.1.1'), record('169.254.169.254')], ()),
            ([record('1.1.1.1'), record('8.8.8.8')], ('8.8.8.8/32',)),
            ([], ()),
        ]
        for records, blocked in cases:
            with self.subTest(records=records):
                with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=records)):
                    with self.assertRaises(egress.EgressError):
                        await egress.resolve_proxy('http://proxy.example:8080', blocked_networks=blocked)

    async def test_rejects_invalid_local_and_special_addresses_without_dns(self):
        loop = asyncio.get_running_loop()
        urls = (
            'https://proxy.example:8080', 'http://proxy.example', 'http://proxy.example:0',
            'http://proxy.example:65536', 'http://proxy.example:080',
            'http://proxy.example:8080/?', 'http://proxy.example:8080/#',
            'http://proxy.example:8080/route', 'http://localhost:8080',
            'http://infra.localhost:8080', 'http://127.0.0.1:8080',
            'http://10.0.0.1:8080', 'http://169.254.169.254:8080',
            'http://100.100.100.200:8080', 'http://224.0.0.1:8080',
            'http://192.0.0.9:8080', 'http://192.88.99.1:8080',
            'http://[::ffff:1.1.1.1]:8080', 'http://[fe80::1%25eth0]:8080',
            'http://[64:ff9b::a00:1]:8080', 'http://[fc00::1]:8080',
            'http://[2002:a00:1::1]:8080', 'http://[ff02::1]:8080',
            'http://proxy.example:8080@127.0.0.1:443',
            'http://user:private%0Avalue@proxy.example:443',
            'http://user:private%value@proxy.example:443',
        )
        with patch.object(loop, 'getaddrinfo', AsyncMock()) as lookup:
            for url in urls:
                with self.subTest(url=url):
                    with self.assertRaises(egress.EgressError) as error:
                        await egress.resolve_proxy(url)
                    self.assertNotIn('private', str(error.exception))
        lookup.assert_not_called()

    async def test_numeric_transport_does_not_pass_a_hostname_or_resolve_again(self):
        loop = asyncio.get_running_loop()
        pinned = egress.PinnedProxy('2606:4700:4700::1111', 443)
        with patch.object(loop, 'sock_connect', AsyncMock()) as connect:
            with patch.object(loop, 'getaddrinfo', AsyncMock()) as lookup:
                with patch.object(asyncio, 'open_connection', AsyncMock(return_value=('reader', 'writer'))) as open_stream:
                    self.assertEqual(await egress._open_pinned(pinned), ('reader', 'writer'))
        stream = open_stream.call_args.kwargs['sock']
        try:
            self.assertEqual(stream.family, socket.AF_INET6)
            connect.assert_awaited_once_with(stream, ('2606:4700:4700::1111', 443, 0, 0))
            lookup.assert_not_called()
        finally:
            stream.close()


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = Path(__file__).resolve().parents[2] / '.runtime' / 'egress-tests'
        root.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=root)
        cwd = Path.cwd()
        self.addCleanup(directory.cleanup)
        self.addCleanup(os.chdir, cwd)
        # macOS Unix sockets have a short path limit; only this fixture uses cwd.
        os.chdir(directory.name)
        Path('relay').mkdir(mode=0o700)
        self.path = Path('relay') / egress.SOCKET_NAME
        self.proxy = egress.PinnedProxy('1.1.1.1', 443)
        self.tasks = set()

    async def connect_fixture(self, handler):
        def accept(reader, writer):
            task = asyncio.create_task(handler(reader, writer))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

        server = await asyncio.start_unix_server(accept, path='synthetic-proxy.sock')
        self.addAsyncCleanup(self.close_fixture, server)
        async def open_fixture(_proxy):
            return await asyncio.open_unix_connection('synthetic-proxy.sock')

        upstream = AsyncMock(side_effect=open_fixture)
        patcher = patch.object(egress, '_open_pinned', new=upstream)
        patcher.start()
        self.addCleanup(patcher.stop)
        return upstream

    async def close_fixture(self, server):
        server.close()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await server.wait_closed()

    async def test_relay_forwards_both_ways_and_preserves_half_close(self):
        async def fixture(reader, writer):
            try:
                incoming = await reader.read()
                writer.write(incoming[::-1])
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        upstream = await self.connect_fixture(fixture)
        async with await egress.open_relay('relay', self.proxy):
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
            reader, writer = await asyncio.open_unix_connection(self.path)
            try:
                writer.write(b'synthetic-proxy-payload')
                writer.write_eof()
                actual = await asyncio.wait_for(reader.read(), 2)
                self.assertEqual(actual, b'daolyap-yxorp-citehtnys')
                upstream.assert_awaited_once_with(self.proxy)
            finally:
                writer.close()
                await writer.wait_closed()
        self.assertFalse(self.path.exists())

    async def test_relay_caps_sessions_and_idle_stream_expires(self):
        connected = asyncio.Event()

        async def fixture(reader, writer):
            connected.set()
            try:
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()

        upstream = await self.connect_fixture(fixture)
        limits = egress.RelayLimits(connections=1, idle_timeout=0.2)
        async with await egress.open_relay('relay', self.proxy, limits=limits):
            first, first_writer = await asyncio.open_unix_connection(self.path)
            await asyncio.wait_for(connected.wait(), 2)
            second, second_writer = await asyncio.open_unix_connection(self.path)
            try:
                self.assertEqual(await asyncio.wait_for(second.read(1), 2), b'')
                self.assertEqual(await asyncio.wait_for(first.read(1), 2), b'')
                upstream.assert_awaited_once_with(self.proxy)
            finally:
                for writer in (first_writer, second_writer):
                    writer.close()
                    await writer.wait_closed()

    async def test_rejects_untrusted_directory_symlink_and_never_replaces_socket_path(self):
        self.path.write_text('keep original')
        with self.assertRaises(egress.EgressError):
            await egress.open_relay('relay', self.proxy)
        self.assertEqual(self.path.read_text(), 'keep original')
        Path('workspace-link').symlink_to('relay')
        with self.assertRaises(egress.EgressError):
            await egress.open_relay('workspace-link', self.proxy)
        Path('relay').chmod(0o770)
        with self.assertRaisesRegex(egress.EgressError, 'not private'):
            await egress.open_relay('relay', self.proxy)


if __name__ == '__main__':
    unittest.main()
