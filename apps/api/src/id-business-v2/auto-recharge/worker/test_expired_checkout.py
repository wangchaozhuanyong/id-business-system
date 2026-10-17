"""过期原单的后台读取与一次替换，全部使用合成会话和内存浏览器。"""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from attempt_ledger import AttemptLedger, atomic_json, checkout_record_path
from checkout_core import CHECKOUT_PATH, Stop
from expired_checkout import expired_checkout_proof, unattempted_checkout
from native_checkout import read_recorded_native_checkout
from pay import run_checkout_flow
from test_native_checkout import SID, ENTITY, session
from test_native_pro_checkout import credential


def original():
    return {'plan': 'chatgptplusplan', 'target_plan': 'plus', 'account_matched': True,
            'checkout_identifier': SID, 'processor_entity': ENTITY, 'checkout_outcome': 'created',
            'payment_status': 'not_attempted', 'payment_attempted': False,
            'confirmation_requests_sent': 0, 'payment_requests_sent': 0}


class ExpiredCheckoutTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.target = credential()
        data = {**session(), 'status': 'expired'}
        self.page = SimpleNamespace(url='https://chatgpt.com/', evaluate=AsyncMock(return_value=data))
        self.context = SimpleNamespace(pages=[self.page])
        self.identity = {'account_matched': True, 'current_plan': 'free'}
        self.check = patch('expired_checkout.check_session',
                           new=AsyncMock(return_value=(self.target, self.identity)))
        self.check.start()

    def tearDown(self):
        self.check.stop()
        self.temp.cleanup()

    async def proof(self, record=None):
        return await expired_checkout_proof(self.context, self.target, self.root, 'plus', record or original())

    async def test_expired_unpaid_is_read_in_background_without_checkout_navigation(self):
        proof = await self.proof()
        self.assertEqual(proof['status'], 'expired')
        self.assertEqual(proof['payment_status'], 'unpaid')
        self.assertEqual(proof['account_key'], hashlib.sha256(self.target.account_id.encode()).hexdigest())
        expression, parameters = self.page.evaluate.await_args.args
        self.assertIn("method:'GET'", expression)
        self.assertNotIn('body:', expression)
        self.assertEqual(parameters['path'], CHECKOUT_PATH + '/' + ENTITY + '/' + SID)
        self.assertEqual(self.page.url, 'https://chatgpt.com/')

    async def test_open_paid_or_unbound_response_never_authorizes_replacement(self):
        for data in (session(), {**session(), 'status': 'expired', 'payment_status': 'paid'},
                     {**session(), 'status': 'expired', 'checkout_session_id': 'oaics_other'}, None):
            self.page.evaluate.return_value = data
            if data is None or data.get('checkout_session_id') != SID:
                with self.assertRaises(Stop): await self.proof()
            else:
                self.assertIsNone(await self.proof())

    async def test_unknown_confirmation_payment_and_tokenization_keep_original(self):
        for change in ({'payment_attempted': True}, {'payment_status': 'unknown'},
                       {'confirmation_requests_sent': 1}, {'payment_requests_sent': 1},
                       {'card_tokenization_requests_sent': 1}, {'confirmation_requests_sent': False},
                       {'payment_evidence': {'kind': 'payment_intent'}},
                       {'manual_confirmation_accepted': True}, {'checkout_outcome': 'unknown'}):
            record = {**original(), **change}
            self.assertFalse(unattempted_checkout(record))
            self.assertIsNone(await self.proof(record))
        self.page.evaluate.assert_not_awaited()

    async def test_current_subscriber_and_foreign_account_do_not_start_fresh_order(self):
        self.identity['current_plan'] = 'plus'
        self.assertIsNone(await self.proof())
        self.page.evaluate.assert_not_awaited()
        self.identity.update(current_plan='free', account_matched=False)
        with self.assertRaises(Stop): await self.proof()

    async def test_readonly_session_rejects_foreign_origin_before_read(self):
        self.page.url = 'https://foreign.invalid/'
        with self.assertRaises(Stop):
            await read_recorded_native_checkout(self.page, self.target, 'plus', SID, ENTITY)
        self.page.evaluate.assert_not_awaited()

    async def test_authorization_precedes_one_new_checkout_and_preserves_original_bytes(self):
        marker = checkout_record_path(self.root, self.target.account_id)
        atomic_json(marker, original())
        before = marker.read_bytes()
        authorizer = AsyncMock()

        async def create(_target, **kwargs):
            authorizer.assert_awaited_once()
            self.assertTrue(kwargs['create'])
            self.assertTrue(kwargs['replace_unpaid_checkout'])
            with AttemptLedger(self.root, self.target.account_id, replace_unpaid_checkout=True,
                    expired_checkout_replacement=kwargs['expired_checkout_replacement']) as ledger:
                ledger.begin()
            return {'status': 'checkout_ready_for_billing', 'payment_attempted': False}

        with patch('pay.run_browser', new=AsyncMock(side_effect=create)) as run:
            result = await run_checkout_flow(self.target, self.root, 'plus', details_reader=lambda: None,
                confirmer=lambda: False, browser_context=self.context, allow_checkout_replacement=False,
                expected_checkout_identifier=SID, expired_checkout_authorizer=authorizer)
        run.assert_awaited_once()
        self.assertTrue(result['checkout_replacement_performed'])
        self.assertEqual(next((self.root / 'history').iterdir()).read_bytes(), before)
        self.assertEqual(json.loads(marker.read_text())['expired_checkout_replacement'],
                         authorizer.await_args.args[0])
        with self.assertRaises(Stop):
            with AttemptLedger(self.root, self.target.account_id, replace_unpaid_checkout=True): pass

    async def test_failed_authorization_or_unknown_recovery_never_creates(self):
        atomic_json(checkout_record_path(self.root, self.target.account_id), original())
        with patch('pay.run_browser', new=AsyncMock()) as run:
            with self.assertRaises(Stop):
                await run_checkout_flow(self.target, self.root, 'plus', details_reader=lambda: None,
                    confirmer=lambda: False, browser_context=self.context, allow_checkout_replacement=False,
                    expired_checkout_authorizer=AsyncMock(side_effect=Stop('durable_state_unavailable')))
            run.assert_not_awaited()
        authorizer = AsyncMock()
        with patch('pay.run_browser', new=AsyncMock(return_value={'status': 'blocked'})):
            await run_checkout_flow(self.target, self.root, 'plus', details_reader=lambda: None,
                confirmer=lambda: False, browser_context=self.context, allow_checkout_replacement=False,
                allow_unknown_checkout_recovery=True, expired_checkout_authorizer=authorizer)
        authorizer.assert_not_awaited()

    async def test_connector_requires_server_ack_and_rejects_second_authorization(self):
        from bitbrowser_connector import LocalJob
        from test_bitbrowser_connector import payload
        job = LocalJob(payload())
        job.account_key = hashlib.sha256(self.target.account_id.encode()).hexdigest()
        job.progress = Mock()
        job.callback.send = Mock(return_value={'ok': True, 'replacementAuthorized': True,
                                                'checkoutIdentifier': SID})
        proof = await self.proof()
        await job.authorize_expired_checkout(proof)
        self.assertTrue(job.expired_checkout_replacement_authorized)
        job.callback.send.assert_called_once_with({'type': 'replace_expired_checkout',
            'accountKey': job.account_key, 'checkoutIdentifier': SID, 'proof': proof})
        with self.assertRaises(Stop): await job.authorize_expired_checkout(proof)
        job.callback.send.assert_called_once()

    async def test_connector_ack_loss_and_recheck_do_not_grant_replacement(self):
        from bitbrowser_connector import LocalJob
        from test_bitbrowser_connector import payload
        job = LocalJob(payload())
        job.progress = Mock()
        job.callback.send = Mock(return_value={'ok': True})
        proof = await self.proof()
        with self.assertRaises(Stop): await job.authorize_expired_checkout(proof)
        self.assertFalse(job.expired_checkout_replacement_authorized)
        job.payload['mode'] = 'recheck'
        job.callback.send.reset_mock()
        with self.assertRaises(Stop): await job.authorize_expired_checkout(proof)
        job.callback.send.assert_not_called()
