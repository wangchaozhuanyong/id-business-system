import asyncio
import json
import os
import socket
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

from broker import Claims, RechargeInputs, broker_listener, connect_display, create_app, materialize_proxy_session


class BrokerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = Path(__file__).resolve().parents[2] / '.runtime' / 'broker-tests'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.temp.cleanup)
        cwd = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, cwd)
        self.keys = ['manual-v1-' + c * 64 for c in 'ab']
        assets = Path('assets')
        (assets / 'core').mkdir(parents=True)
        (assets / 'core' / 'rfb.js').write_text('export default 1;')
        (assets / 'vendor' / 'nested_lib').mkdir(parents=True)
        (assets / 'vendor' / 'nested_lib' / 'renderer.js').write_text('export default 2;')
        Path('internal.js').write_text('fixture outside the asset root')
        (assets / 'core' / 'unlisted.js').symlink_to('../../internal.js')
        # macOS has short socket paths and no Linux O_PATH. Test the real broker
        # transport on Linux; on macOS use a socket owned by this test process.
        self.connect = connect_display if hasattr(os, 'O_PATH') else asyncio.open_unix_connection
        self.owners = ['owner-v1-' + c * 64 for c in 'bc']
        self.states = {}
        self.servers = {}
        self.claims = Path('claims')
        self.claims.mkdir(mode=0o700)
        self.client = await self.make_client()

    async def make_client(self, activate=None, admit=None, stop=None, inspect_unit=None, inventory=None, **opts):
        async def inspect(key):
            return self.states.get(key, 'idle')
        async def units():
            return {key for key, state in self.states.items() if state == 'busy'}
        app = create_app('.', 'assets', activate, admit, stop=stop, connect=self.connect,
                         claims=self.claims, inspect_unit=inspect_unit or inspect, inventory=inventory or units,
                         startup_seconds=1, **opts)
        client = TestClient(TestServer(app), headers={'X-Manual-Owner': self.owners[0]})
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    def bind(self, owner, key, phase='tracking'):
        Claims(self.claims).set(owner, key, phase)

    async def release_display(self, key):
        server = self.servers.pop(key)
        server.close()
        await server.wait_closed()
        Path(key, 'rfb.sock').unlink(missing_ok=True)
        self.states[key] = 'idle'

    async def add_display(self, key, marker):
        Path(key).mkdir(mode=0o700, exist_ok=True)
        self.states[key] = 'busy'

        async def display(reader, writer):
            writer.write(b'RFB 003.008\n')
            await writer.drain()
            try:
                while True:
                    chunk = await reader.read(1024)
                    if not chunk:
                        break
                    writer.write(marker + chunk)
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_unix_server(display, path=key + '/rfb.sock')
        self.servers[key] = server
        async def close():
            server.close()
            await server.wait_closed()
        self.addAsyncCleanup(close)
        return '/v1/workspaces/' + key

    async def test_reconnect_and_separate_workers(self):
        a = await self.add_display(self.keys[0], b'a:')
        b = await self.add_display(self.keys[1], b'b:')
        for owner, key in zip(self.owners, self.keys):
            self.bind(owner, key)
        for route, marker, owner in [(a, b'a:', self.owners[0]), (b, b'b:', self.owners[1]), (a, b'a:', self.owners[0])]:
            headers = {'X-Manual-Owner': owner}
            self.assertEqual((await self.client.post(route + '/open', headers=headers)).status, 204)
            async with self.client.ws_connect(route + '/stream', protocols=('binary',), headers=headers) as ws:
                self.assertEqual(ws.protocol, 'binary')
                self.assertEqual(await ws.receive_bytes(), b'RFB 003.008\n')
                await ws.send_bytes(b'hello')
                self.assertEqual(await ws.receive_bytes(), marker + b'hello')

    async def test_disallowed_and_unavailable(self):
        route = '/v1/workspaces/' + self.keys[0]
        self.assertEqual((await self.client.get(route + '/open')).status, 405)
        self.assertEqual((await self.client.post(route + '/open')).status, 503)
        self.assertEqual((await self.client.post('/v1/workspaces/invalid/open')).status, 404)
        self.assertEqual((await self.client.post(route + '/open?target=x')).status, 404)
        with self.assertRaises(WSServerHandshakeError):
            await self.client.ws_connect(route + '/stream')
        asset = await self.client.get('/v1/client/core/rfb.js')
        self.assertEqual(asset.status, 200)
        self.assertEqual(await asset.text(), 'export default 1;')
        self.assertEqual((await self.client.get('/v1/client/core/rfb.js?u=a')).status, 404)
        self.assertEqual((await self.client.get('/v1/client/unused.js')).status, 404)

    async def test_client_serves_only_registered_assets(self):
        asset = await self.client.get('/v1/client/vendor/nested_lib/renderer.js')
        self.assertEqual(asset.status, 200)
        self.assertEqual(await asset.text(), 'export default 2;')
        self.assertEqual(asset.headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual((await self.client.get('/v1/client/core/unlisted.js')).status, 404)
        long_unregistered_name = '/v1/client/core/' + 'a' * 1024 + '.js'
        self.assertEqual((await self.client.get(long_unregistered_name)).status, 404)

    async def test_claim_lock_uses_the_existing_owner_filename_and_rejects_links(self):
        owner = self.owners[0]
        lock = self.claims / (owner + '.lock')
        claims = Claims(self.claims)
        async with claims.lock(owner, 1):
            self.assertTrue(lock.is_file())
        lock.unlink()
        marker = Path('outside-lock').resolve()
        marker.write_text('preserve')
        lock.symlink_to(marker)
        route = '/v1/workspaces/' + self.keys[0] + '/open'
        self.assertEqual((await self.client.post(route)).status, 503)
        self.assertEqual(marker.read_text(), 'preserve')

    async def test_worker_directory_must_be_registered_without_a_link(self):
        first, second = self.keys
        await self.add_display(first, b'private:')
        Path(second).symlink_to(first, target_is_directory=True)
        self.bind(self.owners[0], second)
        route = '/v1/workspaces/' + second
        self.assertEqual((await self.client.post(route + '/open')).status, 503)
        with self.assertRaises(WSServerHandshakeError) as denied:
            await self.client.ws_connect(route + '/stream', protocols=('binary',))
        self.assertEqual(denied.exception.status, 503)

    async def make_recharge_lab(self, response):
        class Relay:
            closed = False

            async def close(self):
                self.closed = True

        class Inputs(RechargeInputs):
            async def relay(self, directory, url):
                self.upstreams.append((directory, url, Relay()))
                return self.upstreams[-1][2]

        directory = Path('in')
        directory.mkdir(mode=0o700)
        inputs = Inputs(directory, blocked_networks=("192.0.2.1/32",), uid=os.geteuid(), gid=os.getegid())
        inputs.upstreams = []
        inputs.messages = []

        async def worker(key):
            reader, writer = await asyncio.open_unix_connection(directory / key / 'bootstrap.sock')
            try:
                inputs.messages.append(json.loads(await reader.readline()))
                await self.add_display(key, b'recharge:')
                writer.write(json.dumps(response).encode() + b'\n')
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        async def activate(key):
            self.states[key] = 'busy'
            task = asyncio.create_task(worker(key))

            async def finish():
                await task

            self.addAsyncCleanup(finish)
            return True

        async def admit():
            return True

        async def stop(key):
            await self.release_display(key)
            return True

        async def open_client():
            return await self.make_client(activate, admit, stop, recharge=inputs, recharge_available=admit)

        inputs.open_client = open_client
        return await open_client(), inputs

    async def test_renewal_bootstrap_reconnects_after_broker_restart_and_releases(self):
        key, other = self.keys
        client, inputs = await self.make_recharge_lab({'mode': 'renewal', 'ready': True})
        route = '/v1/workspaces/' + key
        self.assertEqual((await self.client.get('/v1/renewal/status')).status, 503)
        self.assertEqual(await (await client.get('/v1/renewal/status')).json(), {'renewalWorkspace': 1})
        self.assertEqual((await client.get('/v1/renewal/status?x=1')).status, 503)
        with patch.object(inputs, 'blocked_networks', ()):
            self.assertEqual((await client.get('/v1/renewal/status')).status, 503)
        opened = await asyncio.gather(client.post(route + '/open'), client.post(route + '/open'))
        self.assertEqual([response.status for response in opened], [204, 204])
        for response in opened:
            self.assertEqual(await response.read(), b'')
        self.assertEqual(inputs.messages, [{'mode': 'renewal'}])
        self.assertFalse(inputs.upstreams)
        self.assertFalse((inputs.root / key / 'bootstrap.sock').exists())
        relay = inputs.root / key / 'egress.sock'
        self.assertTrue(relay.is_socket())
        self.assertEqual((await client.get(route + '/recharge-status')).status, 409)
        self.assertEqual((await client.post('/v1/workspaces/' + other + '/open')).status, 423)
        self.assertEqual((await client.post(route + '/open', headers={'X-Manual-Owner': self.owners[1]})).status, 403)
        async with client.ws_connect(route + '/stream', protocols=('binary',)) as first:
            self.assertEqual(await first.receive_bytes(), b'RFB 003.008\n')
        await client.close()
        self.assertFalse(relay.exists())
        # A replacement broker recreates this same desktop's private relay.
        second = await inputs.open_client()
        self.assertEqual((await second.post(route + '/open')).status, 204)
        self.assertTrue(relay.is_socket())
        self.assertEqual(inputs.messages, [{'mode': 'renewal'}])
        self.assertEqual((await second.get(route + '/recharge-status')).status, 409)
        async with second.ws_connect(route + '/stream', protocols=('binary',)) as desktop:
            self.assertEqual(await desktop.receive_bytes(), b'RFB 003.008\n')
        self.assertEqual((await second.post(route + '/stop')).status, 204)
        self.assertFalse(relay.exists())
        self.assertFalse(Claims(self.claims).read())
        self.assertEqual((await second.post('/v1/workspaces/' + other + '/open')).status, 204)

    async def test_renewal_rejects_recharge_receipt_and_releases_its_claim(self):
        client, inputs = await self.make_recharge_lab(
            {'exitIp': '1.1.1.1', 'country': 'PH', 'accountStatus': 'check-in-browser'})
        route = '/v1/workspaces/' + self.keys[0]
        self.assertEqual((await client.post(route + '/open')).status, 503)
        self.assertEqual(inputs.messages, [{'mode': 'renewal'}])
        self.assertFalse(inputs.upstreams)
        self.assertFalse(Claims(self.claims).read())
        self.assertFalse((inputs.root / self.keys[0] / 'egress.sock').exists())
        self.assertEqual((await client.get(route + '/recharge-status')).status, 409)

    async def test_renewal_never_acquires_an_existing_recharge_desktop(self):
        config = {'email': 'operator@example.test', 'proxyUrl': 'http://relay.example.test:8080',
                  'expectedCountry': ''}
        receipt = {'exitIp': '1.1.1.1', 'country': 'PH', 'accountStatus': 'check-in-browser'}
        key = self.keys[0]
        client, inputs = await self.make_recharge_lab(receipt)
        route = '/v1/workspaces/' + key
        self.assertEqual((await client.post(route + '/prepare', json=config)).status, 200)
        self.assertEqual((await client.post(route + '/open')).status, 409)
        with self.assertRaises(WSServerHandshakeError) as denied:
            await client.ws_connect(route + '/stream', protocols=('binary',))
        self.assertEqual(denied.exception.status, 409)
        await client.close()
        second = await inputs.open_client()
        self.assertEqual((await second.post(route + '/open')).status, 409)
        self.assertFalse((inputs.root / key / 'egress.sock').exists())
        self.assertEqual(inputs.messages, [config])

    async def test_recharge_prepares_exact_owner_exit_and_reconnects_without_another_launch(self):
        config = {'email': 'operator@example.test', 'proxyUrl': 'http://relay.example.test:8080',
                  'expectedCountry': 'PH'}
        result = {'exitIp': '1.1.1.1', 'country': 'PH', 'accountStatus': 'check-in-browser'}
        client, inputs = await self.make_recharge_lab(result)
        self.assertEqual((await self.client.get('/v1/recharge/status')).status, 503)
        self.assertEqual(await (await client.get('/v1/recharge/status')).json(), {'rechargeBootstrap': 1})
        key = self.keys[0]
        route = '/v1/workspaces/' + key
        self.assertEqual((await client.get(route + '/recharge-status')).status, 409)
        self.assertEqual((await client.post(route + '/prepare', json={**config, 'unexpected': True})).status, 400)
        oversized = dict(config, email='a' * 8192 + '@example.test')
        self.assertEqual((await client.post(route + '/prepare', json=oversized)).status, 413)
        self.assertEqual(inputs.upstreams, [])
        for _ in range(2):
            prepared = await client.post(route + '/prepare', json=config)
            self.assertEqual(prepared.status, 200)
            self.assertEqual(await prepared.json(), result)
        self.assertEqual(inputs.messages, [config])
        automatic = await client.post(route + '/prepare', json=dict(config, expectedCountry=''))
        self.assertEqual(automatic.status, 200)
        self.assertEqual(await automatic.json(), result)
        self.assertEqual(len(inputs.upstreams), 1)
        self.assertEqual(inputs.upstreams[0][1], config['proxyUrl'])
        self.assertFalse((inputs.root / key / 'bootstrap.sock').exists())
        self.assertEqual(await (await client.get(route + '/recharge-status')).json(), result)
        self.assertEqual(Claims(self.claims).read(), {self.owners[0]: {'key': key, 'phase': 'tracking'}})
        self.assertEqual((await client.get(route + '/recharge-status',
                                           headers={'X-Manual-Owner': self.owners[1]})).status, 403)
        async with client.ws_connect(route + '/recharge-stream', protocols=('binary',)) as stream:
            self.assertEqual(await stream.receive_bytes(), b'RFB 003.008\n')
            await stream.send_bytes(b'test')
            self.assertEqual(await stream.receive_bytes(), b'recharge:test')
        altered = dict(config, proxyUrl='http://replacement.example.test:8080')
        self.assertEqual((await client.post(route + '/prepare', json=altered)).status, 409)
        replacement = await asyncio.start_unix_server(lambda _reader, writer: writer.close(),
                                                      path=Path(key) / 'replacement.sock')
        try:
            (Path(key) / 'replacement.sock').replace(Path(key) / 'rfb.sock')
            self.assertEqual((await client.get(route + '/recharge-status')).status, 409)
            with self.assertRaises(WSServerHandshakeError) as denied:
                await client.ws_connect(route + '/recharge-stream', protocols=('binary',))
            self.assertEqual(denied.exception.status, 409)
        finally:
            replacement.close()
            await replacement.wait_closed()
        self.assertEqual((await client.post(route + '/stop')).status, 204)
        self.assertTrue(inputs.upstreams[0][2].closed)
        self.assertEqual((await client.get(route + '/recharge-status')).status, 409)

    async def test_recharge_materializes_one_sticky_proxy_session_for_probe_and_viewer(self):
        receipt = {'exitIp': '1.1.1.1', 'country': 'PH', 'accountStatus': 'check-in-browser'}
        client, inputs = await self.make_recharge_lab(receipt)
        selected_url = 'http://fixture-%7Bsession%7D-%7Bsession%7D:test%40value@relay.example.test:8080'
        route = '/v1/workspaces/' + self.keys[0]
        config = {'email': 'operator@example.test', 'proxyUrl': selected_url, 'expectedCountry': ''}
        for _ in range(2):
            response = await client.post(route + '/prepare', json=config)
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), receipt)
        self.assertEqual(len(inputs.upstreams), 1)
        self.assertEqual(len(inputs.messages), 1)
        effective_url = inputs.upstreams[0][1]
        self.assertEqual(inputs.messages[0]['proxyUrl'], effective_url)
        self.assertRegex(effective_url, r'^http://fixture-([1-9][0-9]{7})-\1:test%40value@relay\.example\.test:8080$')
        legacy = materialize_proxy_session('http://fixture-session-original-sessiontime-3:test@relay.example.test:8080')
        self.assertRegex(legacy, r'^http://fixture-session-[1-9][0-9]{7}-sessiontime-3:test@relay\.example\.test:8080$')
        fixed = 'http://fixture:test%40value@relay.example.test:8080'
        self.assertEqual(materialize_proxy_session(fixed), fixed)

    async def test_recharge_mismatched_exit_stops_worker_and_keeps_viewer_closed(self):
        response = {'exitIp': '1.1.1.1', 'country': 'EG', 'accountStatus': 'check-in-browser'}
        client, inputs = await self.make_recharge_lab(response)
        route = '/v1/workspaces/' + self.keys[0]
        config = {'email': 'operator@example.test', 'proxyUrl': 'http://relay.example.test:8080',
                  'expectedCountry': 'PH'}
        self.assertEqual((await client.post(route + '/prepare', json=config)).status, 422)
        self.assertTrue(inputs.upstreams[0][2].closed)
        self.assertEqual(self.states[self.keys[0]], 'idle')
        self.assertEqual(Claims(self.claims).read(), {})
        self.assertEqual((await client.get(route + '/recharge-status')).status, 409)
        with self.assertRaises(WSServerHandshakeError) as denied:
            await client.ws_connect(route + '/recharge-stream', protocols=('binary',))
        self.assertEqual(denied.exception.status, 409)

    async def test_capacity_only_controls_cold_starts(self):
        count = 0
        key = self.keys[0]
        async def activate(requested_key):
            nonlocal count
            await self.add_display(requested_key, b'qa:')
            count += 1
            return True
        async def admit():
            return count == 0
        client = await self.make_client(activate, admit)
        for wanted, owner, status in [(key, self.owners[0], 204), (self.keys[1], self.owners[1], 429), (key, self.owners[0], 204)]:
            response = await client.post('/v1/workspaces/' + wanted + '/open', headers={'X-Manual-Owner': owner})
            self.assertEqual(response.status, status)
        self.assertEqual(count, 1)

    async def test_confirmed_stop_coalesces_requests_and_blocks_open_during_shutdown(self):
        key = self.keys[0]
        started, finish = asyncio.Event(), asyncio.Event()
        calls = []
        async def stop(wanted):
            calls.append(wanted)
            started.set()
            await finish.wait()
            self.states[key] = 'idle'
            return True
        self.bind(self.owners[0], key)
        self.states[key] = 'busy'
        client = await self.make_client(stop=stop)
        route = '/v1/workspaces/' + key
        first = asyncio.ensure_future(client.post(route + '/stop'))
        await asyncio.wait_for(started.wait(), 2)
        second = asyncio.ensure_future(client.post(route + '/stop'))
        self.assertEqual((await client.post(route + '/open')).status, 409)
        finish.set()
        self.assertEqual([r.status for r in await asyncio.gather(first, second)], [204, 204])
        self.assertEqual(calls, [key])
        await self.add_display(key, b'still running:')
        self.bind(self.owners[0], key)
        self.assertEqual((await client.post(route + '/stop')).status, 503)

    async def test_owner_header_required_and_assets_public_to_gateway(self):
        route = '/v1/workspaces/' + self.keys[0]
        anon = TestClient(TestServer(create_app('.', 'assets', claims=self.claims, connect=self.connect)))
        await anon.start_server()
        self.addAsyncCleanup(anon.close)
        for method, action in [('post', '/open'), ('post', '/stop'), ('get', '/stream')]:
            for headers in ({}, {'X-Manual-Owner': 'invalid'},
                            [('X-Manual-Owner', self.owners[0]), ('X-Manual-Owner', self.owners[1])]):
                self.assertEqual((await getattr(anon, method)(route + action, headers=headers)).status, 403)
        self.assertEqual((await anon.get('/v1/client/core/rfb.js')).status, 200)

    async def test_two_brokers_share_one_reservation_including_concurrent_start_and_browser_exit(self):
        first, second = self.keys
        owner, other = self.owners
        opened, proceed = asyncio.Event(), asyncio.Event()
        starts = []
        async def activate(key):
            starts.append(key)
            self.states[key] = 'busy'
            if key == first:
                opened.set()
                await proceed.wait()
            await self.add_display(key, b'page:')
            return True
        async def admit():
            return True
        one = await self.make_client(activate, admit)
        two = await self.make_client(activate, admit)
        a = '/v1/workspaces/' + first
        b = '/v1/workspaces/' + second
        opening = asyncio.ensure_future(one.post(a + '/open'))
        await asyncio.wait_for(opened.wait(), 2)
        self.assertEqual((await two.post(b + '/open')).status, 423)
        self.assertEqual((await two.post(b + '/stop')).status, 423)
        self.assertEqual((await two.get(b + '/stream')).status, 423)
        same = asyncio.ensure_future(two.post(a + '/open'))
        proceed.set()
        self.assertEqual([r.status for r in await asyncio.gather(opening, same)], [204, 204])
        self.assertEqual(starts, [first])
        async with two.ws_connect(a + '/stream', protocols=('binary',)) as ws:
            self.assertEqual(await ws.receive_bytes(), b'RFB 003.008\n')
        self.assertEqual((await one.post(b + '/open')).status, 423)
        await one.close()
        fresh = await self.make_client(activate, admit)
        self.assertEqual((await fresh.post(a + '/open')).status, 204)
        for method, action in [('post', '/open'), ('post', '/stop'), ('get', '/stream')]:
            self.assertEqual((await getattr(fresh, method)(a + action, headers={'X-Manual-Owner': other})).status, 403)
        self.assertEqual((await fresh.post(b + '/open', headers={'X-Manual-Owner': other})).status, 204)
        self.assertEqual(starts, [first, second])
        await self.release_display(first)
        third = 'manual-v1-' + 'c' * 64
        self.assertEqual((await fresh.post('/v1/workspaces/' + third + '/open')).status, 204)
        self.assertEqual(Claims(self.claims).read()[owner]['key'], third)

    async def test_failed_start_unknown_and_interrupted_reservation(self):
        first, second = self.keys
        a, b = ('/v1/workspaces/' + key for key in self.keys)
        async def admit():
            return True
        async def activate(_key):
            return False
        async def stop(key):
            self.states[key] = 'idle'
            return True
        client = await self.make_client(activate, admit, stop)
        self.assertEqual((await client.post(a + '/open')).status, 503)
        self.assertEqual(Claims(self.claims).read(), {})
        self.bind(self.owners[0], first, 'starting')
        self.assertEqual((await client.post(b + '/open')).status, 423)
        self.states[first] = 'unknown'
        self.assertEqual((await client.post(a + '/open')).status, 503)
        self.assertEqual((await client.post(b + '/open')).status, 423)
        self.assertEqual((await client.post(a + '/stop')).status, 204)
        self.assertEqual(Claims(self.claims).read(), {})
        self.states[second] = 'busy'
        self.assertEqual((await client.post(a + '/open')).status, 503)
        await self.add_display(second, b'prestarted:')
        self.assertEqual((await client.post(b + '/open')).status, 503)
        self.assertEqual(Claims(self.claims).read(), {})

    async def test_missing_or_damaged_binding_fails_closed_even_for_ready_display(self):
        key = self.keys[0]
        route = await self.add_display(key, b'protected:')
        self.bind(self.owners[0], key)
        index = self.claims / 'bindings.json'
        for entry in (b'not json', None):
            if entry is None:
                index.unlink()
            else:
                index.write_bytes(entry)
            self.assertEqual((await self.client.post(route + '/open')).status, 503)
            self.assertEqual((await self.client.get(route + '/stream')).status, 503)

    async def test_ambiguous_launch_reserves_capacity_until_original_record_is_retried(self):
        a, b = ('/v1/workspaces/' + key for key in self.keys)
        calls = []
        async def admit():
            return True
        async def activate(key):
            calls.append(key)
            if len(calls) == 1:
                return None
            await self.add_display(key, b'recovered:')
            return True
        client = await self.make_client(activate, admit)
        self.assertEqual((await client.post(a + '/open')).status, 503)
        self.assertEqual((await client.post(b + '/open')).status, 423)
        self.assertEqual((await client.post(b + '/open', headers={'X-Manual-Owner': self.owners[1]})).status, 503)
        self.assertEqual(calls, [self.keys[0]])
        self.assertEqual((await client.post(a + '/open')).status, 204)
        self.assertEqual(calls, [self.keys[0], self.keys[0]])

    async def test_broker_endpoint_recovers_after_sigkill_and_never_replaces_live_socket(self):
        path = Path('site.sock')
        script = ('import sys, signal; from pathlib import Path; sys.path.insert(0, sys.argv[1]); '
                  'from broker import broker_listener\n'
                  'with broker_listener(Path("site.sock")) as listener:\n'
                  ' listener.listen(); print("ready", flush=True); signal.pause()')
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-B', '-c', script, str(Path(__file__).resolve().parent),
            stdout=asyncio.subprocess.PIPE)
        try:
            self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 5), b'ready\n')
            inode = path.stat().st_ino
            with self.assertRaises(BlockingIOError), broker_listener(path):
                pass
            self.assertEqual(path.stat().st_ino, inode)
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
        self.assertTrue(path.is_socket())
        with broker_listener(path) as recovered:
            recovered.listen()
            with socket.socket(socket.AF_UNIX) as client:
                client.connect(str(path))
        self.assertFalse(path.exists())
        with socket.socket(socket.AF_UNIX) as external:
            external.bind(str(path))
            external.listen()
            inode = path.stat().st_ino
            with self.assertRaisesRegex(RuntimeError, 'listener'), broker_listener(path):
                pass
            self.assertEqual(path.stat().st_ino, inode)
        with self.assertRaisesRegex(RuntimeError, 'not created'), broker_listener(path):
            pass
        self.assertTrue(path.is_socket())
        path.unlink()
        path.write_text('preserve')
        with self.assertRaisesRegex(RuntimeError, 'another object'), broker_listener(path):
            pass
        self.assertEqual(path.read_text(), 'preserve')

    @unittest.skipUnless(Path('/usr/bin/timeout').is_file(), 'Linux coreutils monitor')
    async def test_crash_while_submitting_start_holds_owner_and_host_locks(self):
        fake = Path('systemctl-fixture').resolve()
        fake.write_text(f'#!{sys.executable}\nimport os, time\nfrom pathlib import Path\n'
                        'os.closerange(3, 1024)\nPath("submitting").touch()\n'
                        'while not Path("ack").exists(): time.sleep(.025)\nPath("submitted").touch()\n')
        fake.chmod(0o700)
        script = ('import asyncio, sys; sys.path.insert(0, sys.argv[1]); import broker; '
                  'broker.SYSTEMCTL = sys.argv[2]\n'
                  'async def run():\n c = broker.Claims("claims")\n'
                  ' async with c.lock(sys.argv[3], 2), c.lock("admission", 2):\n'
                  '  await broker.start_unit(sys.argv[4])\nasyncio.run(run())')
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-B', '-c', script, str(Path(__file__).resolve().parent),
            str(fake), self.owners[0], self.keys[0])
        try:
            for _ in range(150):
                if Path('submitting').exists(): break
                await asyncio.sleep(.02)
            self.assertTrue(Path('submitting').exists())
            process.kill()
            await process.wait()
            claims = Claims(self.claims)
            for lock in (self.owners[0], 'admission'):
                with self.assertRaises(web.HTTPServiceUnavailable):
                    async with claims.lock(lock, .05):
                        self.fail('A replacement broker overtook a pending command')
            Path('ack').touch()
            async with claims.lock('admission', 2):
                self.assertTrue(Path('submitted').exists())
        finally:
            Path('ack').touch()
            if process.returncode is None:
                process.kill()
            await process.wait()

    @unittest.skipUnless(hasattr(os, 'O_PATH'), 'Linux-specific O_PATH isolation')
    async def test_worker_cannot_alias_another_display(self):
        a, b = self.keys
        await self.add_display(a, b'a:')
        Path(b).mkdir()
        (Path(b) / 'rfb.sock').symlink_to(Path('..') / a / 'rfb.sock')
        self.bind(self.owners[0], b)
        self.assertEqual((await self.client.post('/v1/workspaces/' + b + '/open')).status, 503)
        with self.assertRaises(WSServerHandshakeError) as rejected:
            await self.client.ws_connect('/v1/workspaces/' + b + '/stream', protocols=('binary',))
        self.assertEqual(rejected.exception.status, 503)


if __name__ == '__main__':
    unittest.main()
