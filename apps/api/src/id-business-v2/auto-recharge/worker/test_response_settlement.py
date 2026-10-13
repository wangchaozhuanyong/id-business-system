"""原单回包先到、取消收尾和慢网络的纯本地合成回归。"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import bitbrowser_connector as connector
from checkout_core import MAX_BYTES, Stop, parse_browser_credential
from payment_network import PaymentGuard
from subscription_upgrade import UpgradeGuard, UpgradeLedger, preview_quote, minor_money
from test_payment_3ds import Frame, Ledger, Request, Response, intent, quote
from test_subscribe import fixture
from test_subscription_upgrade import action_intent, preview
from upgrade_authentication import (AuthenticationReceipts, UpgradeResponseObservers,
                                    drain_upgrade_responses, response_body)


class EarlyReceiptTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = parse_browser_credential(fixture())

    def checkout(self):
        guard = PaymentGuard(self.target, Ledger())
        guard.checkout_id, guard.account_verified = 'cs_synthetic', True
        guard.approve(quote())
        request = Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm', data='{}')
        guard.observe_request(request)
        return guard, request

    async def early_checkout(self, *, delay=0, data=None, source='src_synthetic', headers=None, cancel=False):
        guard, request = self.checkout()
        response = Response(request, {'payment_intent': intent()})
        release = asyncio.Event()
        original_body = response.body
        async def held():
            await release.wait()
            return await original_body()
        response.body = held
        confirm_task = asyncio.create_task(guard.response(response))
        auth_request = Request('https://api.stripe.com/v1/3ds2/authenticate',
            data='source=' + source, headers=headers)
        await guard.response(Response(auth_request, data or {'source': source,
            'payment_intent': intent(status='succeeded', amount_received=9250, next_action=None),
            'client_secret': 'must-not-be-cached'}))
        self.assertNotEqual(guard.payment_state, 'paid')
        self.assertNotIn('must-not-be-cached', json.dumps(guard.authentication_receipts.pending[0][2]))
        if cancel:
            guard.operation_cancelled = lambda: True
            guard.read_only = True
            guard.finish_three_ds()
        await asyncio.sleep(delay)
        release.set()
        await confirm_task
        self.assertEqual(guard.confirmation_sent, 1)
        return guard

    async def test_checkout_authentication_before_confirm_body_over_five_seconds(self):
        guard = await self.early_checkout(delay=5.2)
        self.assertEqual(guard.payment_state, 'paid')
        self.assertEqual(guard.evidence['identifier'], 'pi_synthetic')

    async def test_cancel_receives_original_paid_without_reopening_challenge(self):
        guard = await self.early_checkout(cancel=True)
        self.assertEqual(guard.payment_state, 'paid')
        self.assertTrue(guard.three_ds_closed)
        self.assertFalse(guard.three_ds.active)
        self.assertFalse(guard.three_ds.entries)

    async def test_wrong_original_bindings_and_privileged_headers_never_prove_paid(self):
        for kwargs in ({'source': 'src_other'},
                       {'data': {'source': 'src_synthetic', 'payment_intent': intent(id='pi_other', status='succeeded', amount_received=9250)}},
                       {'data': {'source': 'src_synthetic', 'payment_intent': intent(status='succeeded', amount_received=1)}},
                       {'data': {'source': 'src_synthetic', 'payment_intent': intent(status='succeeded', amount_received=9250, currency='usd')}},
                       {'headers': {'chatgpt-account-id': self.target.account_id}}):
            with self.subTest(kwargs=kwargs):
                self.assertNotEqual((await self.early_checkout(**kwargs)).payment_state, 'paid')

    async def test_authentication_before_confirm_is_not_captured(self):
        guard, _ = self.checkout()
        guard.confirmation_sent = 0
        await guard.response(Response(Request('https://api.stripe.com/v1/3ds2/authenticate',
            data='source=src_synthetic'), {'payment_intent': intent(status='succeeded', amount_received=9250)}))
        self.assertFalse(guard.authentication_receipts.pending)

    async def test_upgrade_early_authentication_survives_slow_update_body(self):
        with tempfile.TemporaryDirectory() as folder:
            with UpgradeLedger(Path(folder) / 'state', self.target.account_id, 'pro-20x') as ledger:
                ledger.begin(preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000)), '4242')
                frame = Frame('https://chatgpt.com/')
                guard = UpgradeGuard(self.target, ledger, frame)
                guard.approved, guard.method_id = True, 'pm_Synthetic'
                request = Request('https://chatgpt.com/backend-api/subscriptions/update', frame=frame,
                    data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}),
                    headers={'authorization': 'Bearer ' + self.target.old_token})
                guard.observe_request(request)
                response = Response(request, {'status': 'requires_action', 'payment_intent': action_intent()})
                release = asyncio.Event()
                original_body = response.body
                async def held():
                    await release.wait()
                    return await original_body()
                response.body = held
                update = asyncio.create_task(guard.response(response))
                auth = Request('https://api.stripe.com/v1/3ds2/authenticate', frame=frame, data='source=src_upgrade')
                await guard.response(Response(auth, {'source': 'src_upgrade',
                    'payment_intent': action_intent(status='succeeded', amount_received=40000, next_action=None)}))
                self.assertFalse(guard.done.is_set())
                await asyncio.sleep(5.2)
                release.set()
                await update
                self.assertEqual(ledger.record['payment_status'], 'paid')
                self.assertEqual(ledger.record['payment_evidence']['identifier'], 'pi_Synthetic')
                self.assertEqual(guard.sent, 1)

    def test_cache_is_bounded_and_excludes_secrets(self):
        cache = AuthenticationReceipts()
        for i in range(9):
            accepted = cache.capture(Request('https://api.stripe.com/v1/3ds2/authenticate'), 200,
                {'source': 'src_synthetic', 'client_secret': 'no-cache', 'card': {'number': 'no-cache'},
                 'error': {'code': 'card_declined', 'message': 'no-cache'}}, 100)
            self.assertEqual(accepted, i < 8)
        self.assertEqual(len(cache.pending), 8)
        self.assertNotIn('no-cache', json.dumps([entry[2] for entry in cache.pending]))
        cache.clear()
        request = Request('https://api.stripe.com/v1/3ds2/authenticate')
        self.assertTrue(cache.capture(request, 200, {}, MAX_BYTES - 1))
        self.assertFalse(cache.capture(Request(request.url), 200, {}, 2))
        self.assertLessEqual(cache.bytes, MAX_BYTES)


class SettlementTests(unittest.IsolatedAsyncioTestCase):
    async def test_scaled_observation_and_two_callback_budgets_are_additive(self):
        async def hanging():
            await asyncio.Event().wait()
        pending = {asyncio.create_task(hanging())}
        started = time.monotonic()
        await drain_upgrade_responses(pending, seconds=.025)
        opener = SimpleNamespace(open=Mock(side_effect=lambda *_args, **_kwargs: time.sleep(.2)))
        client = connector.CallbackClient('https://example.test/api/id-business-v2/auto-recharge/local/'
            '12345678-1234-1234-1234-123456789abc', 'synthetic-token-123456789',
            '12345678-1234-1234-1234-123456789abc')
        self.assertEqual(connector.CallbackClient.SEND_SECONDS, 10)
        with patch.object(connector, 'build_opener', return_value=opener), patch.object(connector.CallbackClient, 'SEND_SECONDS', .04):
            for type_ in ('ledger', 'finished'):
                with self.assertRaises(Stop):
                    await asyncio.to_thread(client.send, {'type': type_})
        self.assertLess(time.monotonic() - started, .25)
        self.assertEqual(opener.open.call_count, 2)

    async def test_hung_body_respects_remaining_budget(self):
        release, cancelled = asyncio.Event(), asyncio.Event()
        async def ignores_cancellation():
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
            return b'{}'
        guard = SimpleNamespace(observation_deadline=time.monotonic() + .025, observations_closed=False)
        started = time.monotonic()
        with self.assertRaises(asyncio.TimeoutError):
            await response_body(SimpleNamespace(body=ignores_cancellation), guard)
        self.assertLess(time.monotonic() - started, .15)
        await cancelled.wait()
        release.set()
        await asyncio.sleep(0)

    async def test_drain_cancellation_does_not_wait_for_resistant_observer(self):
        release, started = asyncio.Event(), asyncio.Event()
        async def resistant():
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
        task = asyncio.create_task(resistant())
        await started.wait()
        tasks = {task}
        before = time.monotonic()
        await drain_upgrade_responses(tasks, seconds=.025)
        self.assertLess(time.monotonic() - before, .15)
        self.assertFalse(tasks)
        release.set()
        await task

    async def test_settling_merges_paid_once_and_never_downgrades(self):
        target = parse_browser_credential(fixture())
        ledger = Ledger()
        guard = PaymentGuard(target, ledger)
        guard.checkout_id, guard.account_verified = 'cs_synthetic', True
        guard.approve(quote())
        request = Request('https://api.stripe.com/v1/payment_pages/cs_synthetic/confirm', data='{}')
        guard.observe_request(request)
        observers = UpgradeResponseObservers(Mock(), guard)
        observers.observe(Response(request, {'payment_intent': intent(status='succeeded', amount_received=9250, next_action=None)}))
        observers.observe(Response(request, {'error': {'code': 'card_declined'}}))
        await observers.finish()
        self.assertEqual(guard.payment_state, 'paid')
        self.assertEqual(ledger.observations, [])
        await asyncio.to_thread(guard.flush_observation)
        self.assertEqual(len(ledger.observations), 1)
        self.assertEqual(ledger.observations[0]['payment_status'], 'paid')
        await observers.finish()
        self.assertFalse(observers.tasks)


class CallbackDeadlineTests(unittest.TestCase):
    def client(self):
        return connector.CallbackClient('https://example.test/api/id-business-v2/auto-recharge/local/'
            '12345678-1234-1234-1234-123456789abc', 'synthetic-token-123456789',
            '12345678-1234-1234-1234-123456789abc')

    def test_slow_open_has_absolute_deadline_and_no_second_post(self):
        released = threading.Event()
        def open_slow(*_args, **_kwargs):
            released.wait(1)
            raise TimeoutError()
        opener = SimpleNamespace(open=Mock(side_effect=open_slow))
        before = time.monotonic()
        with patch.object(connector, 'build_opener', return_value=opener), patch.object(connector.CallbackClient, 'SEND_SECONDS', .04):
            with self.assertRaises(Stop):
                self.client().send({'type': 'finished', 'result': {'status': 'payment_result_unknown'}})
        self.assertLess(time.monotonic() - before, .2)
        self.assertEqual(opener.open.call_count, 1)
        released.set()

    def test_slow_drip_cannot_renew_socket_timeout(self):
        class Drip:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def read(self, _size):
                time.sleep(.015)
                return b' '
        opener = SimpleNamespace(open=Mock(return_value=Drip()))
        before = time.monotonic()
        with patch.object(connector, 'build_opener', return_value=opener), patch.object(connector.CallbackClient, 'SEND_SECONDS', .04):
            with self.assertRaises(Stop):
                self.client().send({'type': 'ledger'})
        self.assertLess(time.monotonic() - before, .2)
        self.assertEqual(opener.open.call_count, 1)


if __name__ == '__main__':
    unittest.main()
