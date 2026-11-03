import json
import os
from pathlib import Path
import tempfile
import threading
import time
import sys
import types
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'auto-recharge/worker'))
import online_bitbrowser_agent as agent

class Stop(Exception):
    def __init__(self, reason):
        self.report = {'reason': reason}

class BaseJob:
    signal_confirm = Mock()

class AgentTests(unittest.TestCase):
    def make_agent(self):
        result = agent.OnlineAgent.__new__(agent.OnlineAgent)
        result.core = types.SimpleNamespace(LocalJob=BaseJob, Stop=Stop)
        result.client = Mock()
        result.registered_quote = None
        result.next_quote_check = 0
        return result

    def pending_job(self):
        return types.SimpleNamespace(confirmation_lock=threading.Lock(), account_key='account',
            pending_confirmation={'nonce': 'local-only-nonce', 'quote_digest': 'digest', 'quote': {'fixture': True}})

    def setUp(self):
        (agent.PROJECT / '.runtime/online-bitbrowser-20261102').mkdir(parents=True, exist_ok=True)
        BaseJob.signal_confirm.reset_mock()

    def test_manual_quote_waits_for_server_and_does_not_send_local_nonce(self):
        worker = self.make_agent()
        job = self.pending_job()
        worker.client.rpc.return_value = {'approved': False}
        worker.approve_pending({'taskId': 'task'}, job)
        BaseJob.signal_confirm.assert_not_called()
        self.assertNotIn('nonce', worker.client.rpc.call_args.args[1])
        worker.next_quote_check = 0
        worker.client.rpc.return_value = {'approved': True}
        worker.approve_pending({'taskId': 'task'}, job)
        BaseJob.signal_confirm.assert_called_once_with(job, 'local-only-nonce', 'digest')

    def test_automatic_quote_still_requires_server_permission(self):
        worker = self.make_agent()
        worker.client.rpc.return_value = {'approved': True}
        job = self.pending_job()
        worker.approve_pending({'taskId': 'task'}, job)
        self.assertEqual(worker.client.rpc.call_args.args[0], 'quote')
        BaseJob.signal_confirm.assert_called_once()

    def test_loopback_cannot_bypass_online_payment_permission(self):
        job_type = agent.online_job_type(types.SimpleNamespace(LocalJob=BaseJob, Stop=Stop))
        with self.assertRaises(Stop):
            job_type().signal_confirm('nonce', 'digest')
        BaseJob.signal_confirm.assert_not_called()

    def test_expired_permission_cancels_without_payment(self):
        worker = self.make_agent()
        worker.client.rpc.return_value = {'approved': False, 'expired': True}
        worker.registered_quote = 'digest'
        worker.cancel_local = Mock()
        job = self.pending_job()
        worker.approve_pending({}, job)
        worker.cancel_local.assert_called_once_with(job)
        BaseJob.signal_confirm.assert_not_called()

    def test_static_and_dynamic_proxies_reuse_current_browser_contract(self):
        prepared = {'proxy': {'protocol': 'socks5', 'connectionMode': 'direct', 'proxy_url': 'socks5://fixture:synthetic@proxy.example.invalid:1080'},
            'connection': {'localApiUrl': 'http://127.0.0.1:54345', 'localApiToken': 'synthetic-local-api', 'groupName': 'group', 'tagName': 'tag'},
            'policy': {'proxyCountryCode': 'CL', 'currency': 'CLP'}, 'plan': 'pro-5x', 'sessionJson': '{}', 'details': {}, 'address': {}}
        task = {'id': 'task', 'leaseId': 'lease'}
        client = types.SimpleNamespace(origin='https://fixture.example.invalid')
        payload = agent.payload_for(prepared, task, client)
        self.assertEqual(payload['bitBrowser']['browserOptions']['proxyMode'], 'static')
        self.assertEqual(payload['bitBrowser']['staticProxyCredentials']['username'], 'fixture')
        self.assertTrue(payload['safety']['manualPaymentConfirmation'])
        prepared['proxy'] = {'protocol': 'http', 'connectionMode': 'extraction', 'proxy_url': 'https://proxy.example.invalid/extract'}
        payload = agent.payload_for(prepared, task, client)
        self.assertEqual(payload['bitBrowser']['browserOptions']['proxyMode'], 'dynamic')

    def test_pairing_file_bom_is_supported_and_one_time_token_is_replaced(self):
        runtime = agent.PROJECT / '.runtime' / 'online-bitbrowser-20261102'
        runtime.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as folder:
            path = Path(folder) / 'device.json'
            path.write_text(json.dumps({'serverUrl': 'https://fixture.example.invalid', 'pairingToken': 'synthetic-one-time'}), encoding='utf-8-sig')
            path.chmod(0o600)
            with patch.object(agent.RpcClient, '_post', return_value={'deviceId': 'device', 'deviceKey': 'synthetic-device-key-not-used-externally'}) as transfer:
                client = agent.RpcClient(path)
                self.assertEqual(transfer.call_count, 1)
                saved = json.loads(path.read_text())
                self.assertNotIn('pairingToken', saved)
                self.assertEqual(saved['deviceId'], client.device_id)
                agent.RpcClient(path)
                self.assertEqual(transfer.call_count, 1)

    @unittest.skipIf(os.name == 'nt', 'Windows 使用文件 ACL')
    def test_insecure_file_permissions_are_rejected_before_network(self):
        runtime = agent.PROJECT / '.runtime' / 'online-bitbrowser-20261102'
        with tempfile.TemporaryDirectory(dir=runtime) as folder:
            path = Path(folder) / 'device.json'
            path.write_text('{}')
            path.chmod(0o644)
            with patch.object(agent.RpcClient, '_post') as transfer:
                with self.assertRaises(agent.OnlineError):
                    agent.RpcClient(path)
                transfer.assert_not_called()

    def test_rpc_scope_cannot_override_device_identity_or_method(self):
        client = agent.RpcClient.__new__(agent.RpcClient)
        client.device_id = 'bound-device'
        client._post = Mock()
        client.rpc('lease', scope={'deviceId': 'foreign', 'method': 'claim', 'taskId': 'task'})
        body = client._post.call_args.args[1]
        self.assertEqual(body['deviceId'], 'bound-device')
        self.assertEqual(body['method'], 'lease')

    def test_recheck_has_no_card_or_payment_capability(self):
        prepared = {'checkOnly': True, 'accountKey': 'a' * 64, 'upgradeIdentifier': 'upg_' + 'a' * 32,
            'proxy': {'protocol': 'http', 'connectionMode': 'direct', 'proxy_url': 'http://proxy.example.invalid:8080'},
            'connection': {}, 'policy': {'proxyCountryCode': 'PH'}, 'plan': 'pro-20x', 'sessionJson': '{}'}
        payload = agent.payload_for(prepared, {'id': 'original-task', 'leaseId': 'lease'}, types.SimpleNamespace(origin='https://fixture.example.invalid'))
        self.assertEqual(payload['id'], 'original-task')
        self.assertEqual(payload['mode'], 'recheck')
        for key in ['details', 'address', 'safety', 'authorizeSinglePayment']:
            self.assertNotIn(key, payload)

    def test_adapter_matches_existing_core_payload_and_quote_contract(self):
        sys.path.insert(0, str(agent.PROJECT / 'apps/api/src/id-business-v2/auto-recharge/worker'))
        import bitbrowser_connector as core
        import payment_state
        from test_bitbrowser_connector import payload as original_payload
        original = original_payload()
        prepared = {'proxy': {'protocol': 'http', 'connectionMode': 'direct', 'proxy_url': 'http://proxy.example.invalid:8080'},
            'connection': {key: original['bitBrowser'][key] for key in ['localApiUrl', 'localApiToken', 'groupName', 'tagName']},
            'policy': {'proxyCountryCode': 'US', 'currency': 'USD'}, 'plan': 'plus', 'sessionJson': original['sessionJson'],
            'details': original['details'], 'address': original['address']}
        task = {'id': original['id'], 'leaseId': original['id']}
        client = types.SimpleNamespace(origin='https://fixture.example.invalid')
        core.validate_payload(agent.payload_for(prepared, task, client))
        prepared['proxy'] = {'protocol': 'http', 'connectionMode': 'extraction', 'proxy_url': 'https://proxy.example.invalid/extract'}
        core.validate_payload(agent.payload_for(prepared, task, client))
        prepared.update(checkOnly=True, accountKey='a'*64)
        core.validate_payload(agent.payload_for(prepared, task, client))
        quote = {'plan': 'plus', 'today': {'amount': '20.00', 'amount_minor': 2000, 'currency': 'USD'},
            'tax': {'amount': '0.00', 'amount_minor': 0, 'currency': 'USD'}, 'renewal': {'amount': '20.00', 'amount_minor': 2000, 'currency': 'USD'}, 'renewal_interval': 'monthly'}
        self.assertEqual(payment_state.quote_digest(quote), 'eaff785ed606d76d29bcb3d34a640ac015ff03cf0ed84095d711f9b90f89c56d')

    def test_lost_lease_cancels_local_job(self):
        worker = self.make_agent()
        job = self.pending_job()
        job.done = False
        worker.current = ({'taskId': 'original-task'}, job)
        worker.registry = types.SimpleNamespace(busy=lambda: True)
        worker.ready = True
        worker.client.rpc.side_effect = [ {'ok': True}, agent.OnlineError('lease lost') ]
        worker.cancel_local = Mock()
        with self.assertRaises(agent.OnlineError):
            worker.heartbeat()
        worker.cancel_local.assert_called_once_with(job)

    def test_original_order_recheck_runs_new_lease_without_bypassing_same_lease_cache(self):
        import bitbrowser_connector as core
        from test_bitbrowser_connector import payload as original_payload
        original = original_payload()
        task = {'id': original['id'], 'leaseId': '22222222-2222-4222-8222-222222222222', 'leaseVersion': 1}
        prepared = {'plan': 'plus', 'sessionJson': original['sessionJson'],
            'connection': {key: original['bitBrowser'][key] for key in ['localApiUrl', 'localApiToken', 'groupName', 'tagName']},
            'policy': {'proxyCountryCode': 'US', 'currency': 'USD'},
            'proxy': {'protocol': 'http', 'connectionMode': 'direct', 'proxy_url': 'http://proxy.example.invalid:8080'},
            'details': original['details'], 'address': original['address']}
        worker = self.make_agent()
        worker.core, worker.registry = core, core.Registry()
        worker.client.origin = 'https://fixture.example.invalid'
        worker.client.rpc.side_effect = lambda method, *args, **kwargs: (
            dict(task) if method == 'claim' else dict(prepared) if method == 'prepare' else {'ok': True})
        created, retired = [], []
        class FixtureJob(core.LocalJob):
            def __init__(self, body, **kwargs):
                super().__init__(body, **kwargs)
                self.retired = threading.Event()
                created.append((self.id, self.payload['mode'], dict(self.callback.scope), set(self.payload)))
                retired.append(self.retired)
            def run(self):
                self.result = {'status': 'payment_result_unknown'}
                self.finished_callback_acknowledged = self.callback.send(
                    {'type': 'finished', 'result': self.result}).get('ok') is True
                self.done = True
            def release_resources(self):
                super().release_resources()
                self.retired.set()
        # A completed business ID from the previous adapter must not block an upgraded helper.
        old = types.SimpleNamespace(id=task['id'], result={'status': 'payment_result_unknown'},
            finished_callback_acknowledged=True, resolution_committed=False)
        worker.registry.jobs[task['id']] = core.CompletedJob(old, time.monotonic())
        with patch.object(agent, 'online_job_type', return_value=FixtureJob):
            worker.claim()
            self.assertEqual(len(created), 1)
            self.assertTrue(retired[0].wait(2))
            first = worker.registry.get(created[0][0])
            worker.claim()
            self.assertIs(worker.current[1], first)
            self.assertEqual(len(created), 1)
            task.update(leaseId='33333333-3333-4333-8333-333333333333', leaseVersion=2)
            prepared.update(checkOnly=True, accountKey='a' * 64)
            worker.claim()
            self.assertEqual(len(created), 2)
            self.assertTrue(retired[1].wait(2))
            self.assertIsInstance(worker.registry.get(created[1][0]), core.CompletedJob)
        self.assertNotEqual(created[0][0], created[1][0])
        self.assertEqual(created[1][1], 'recheck')
        self.assertEqual(created[1][2]['taskId'], original['id'])
        self.assertEqual(created[1][2]['leaseVersion'], 2)
        self.assertTrue({'details', 'address', 'safety', 'authorizeSinglePayment'}.isdisjoint(created[1][3]))

if __name__ == '__main__':
    unittest.main()
