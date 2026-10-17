"""Missing-window recovery uses synthetic profiles only; no browser or payments."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bitbrowser_connector as connector
import bitbrowser_retry as retry
import payment_state
from browser_session import SessionBudget
from checkout_core import Stop
from test_bitbrowser_connector import payload

ROOT = Path(__file__).resolve().parents[6] / '.runtime/bitbrowser-recharge-rebuild-20261009/profile-fixtures'


class MissingOwnedProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.target = SimpleNamespace(account_id='synthetic-account', user_id='synthetic-user',
                                      session_token='synthetic-session')
        self.source = {'sourceJobId': '22222222-2222-4222-8222-222222222222',
                       'profileId': 'd' * 32,
                       'accountKey': hashlib.sha256(self.target.account_id.encode()).hexdigest()}
        value = payload()
        value['ownedProfile'] = dict(self.source)
        self.job = connector.LocalJob(value)
        self.job.root = Path(self.temp.name)
        self.job.account_key = self.source['accountKey']
        self.events = []
        self.job.callback.send = MagicMock(side_effect=self.callback)
        self.client = MagicMock()
        self.client.list_profile_ids.return_value = set()
        self.client.create_profile.side_effect = self.create
        self.client.open_profile.side_effect = self.open
        self.context = MagicMock(pages=[], route=AsyncMock(), unroute=AsyncMock(),
                                 set_extra_http_headers=AsyncMock())
        self.playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(
            return_value=SimpleNamespace(contexts=[self.context], version='152.0.0'))))

    def callback(self, body):
        if body.get('result', {}).get('stage') == 'bitbrowser_profile_created':
            self.events.append('receipt')
        return {'records': [], 'staleProfiles': [],
                'ownedProfile': {**self.source, 'profileId': 'a' * 32}}

    def create(self, settings, name):
        self.events.append('create')
        self.assertEqual(settings, self.job.payload['bitBrowser'])
        self.assertEqual(name, self.job.payload['windowName'])
        return 'a' * 32

    def open(self, profile_id, **_):
        self.events.append('open')
        self.assertEqual(profile_id, 'a' * 32)
        self.assertIn('receipt', self.events)
        return 'http://127.0.0.1:12345'

    async def execute(self, *, password=False, flow=None):
        target = self.target
        if password:
            self.job.payload.pop('sessionJson', None)
            self.job.payload['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
            target = None
        async def default_flow(job, current, budget, original):
            self.events.append('flow')
            self.assertIsNone(job.owned_profile)
            self.assertEqual(job.replaced_owned_profile, self.source)
            return current, {'status': 'session_ready', 'payment_requests_sent': 0}
        with (patch('browser_checkout.prepare_proxy_in_context', AsyncMock()),
              patch.object(retry, '_execute_profile_flow', AsyncMock(side_effect=flow or default_flow)) as ran):
            result = await retry.execute_profiles(self.job, self.client, target, self.playwright)
        return result, ran

    async def test_all_login_and_recharge_modes_persist_replacement_before_open(self):
        for mode in ('payment', 'open_browser'):
            for password in (False, True):
                with self.subTest(mode=mode, password=password):
                    self.setUp()
                    self.job.payload['mode'] = mode
                    result, ran = await self.execute(password=password)
                    self.assertEqual(result['status'], 'session_ready')
                    self.assertEqual(self.events, ['create', 'receipt', 'open', 'flow'])
                    self.client.create_profile.assert_called_once()
                    self.client.list_profile_ids.assert_called_once()
                    self.assertEqual(result['browser_profile_id'], 'a' * 32)
                    self.assertEqual(result['replaced_browser_profile_id'], 'd' * 32)
                    self.assertIs(result['browser_profile_missing_confirmed'], True)
                    receipt = next(call.args[0]['result'] for call in self.job.callback.send.call_args_list
                                   if call.args[0].get('result', {}).get('stage') == 'bitbrowser_profile_created')
                    self.assertIs(receipt['payment_attempted'], False)
                    self.assertEqual(receipt['payment_requests_sent'], 0)
                    self.assertEqual(ran.await_count, 1)

    async def test_receipt_failure_stops_before_open_or_login_and_never_repeats_creation(self):
        self.job.callback.send.side_effect = Stop('durable_state_unavailable')
        result, ran = await self.execute(password=True)
        self.assertEqual(result['reason'], 'durable_state_unavailable')
        self.client.create_profile.assert_called_once()
        self.client.open_profile.assert_not_called()
        ran.assert_not_awaited()
        self.assertEqual(self.events, ['create'])

    async def test_inventory_error_or_ambiguity_never_creates_or_opens(self):
        for reply in (Stop('bitbrowser_local_api_unavailable'), Stop('bitbrowser_catalog_invalid'),
                      Stop('bitbrowser_catalog_limit'), None, []):
            with self.subTest(reply=type(reply).__name__):
                self.setUp()
                self.client.list_profile_ids.side_effect = reply if isinstance(reply, Stop) else None
                self.client.list_profile_ids.return_value = reply
                result, ran = await self.execute()
                self.assertEqual(result['status'], 'blocked')
                self.client.create_profile.assert_not_called()
                self.client.open_profile.assert_not_called()
                ran.assert_not_awaited()

    async def test_existing_profile_with_bad_detail_never_authorizes_replacement(self):
        self.client.list_profile_ids.return_value = {'d' * 32}
        self.client.post.return_value = {'id': 'f' * 32}
        result, ran = await self.execute()
        self.assertEqual(result['reason'], 'owned_recharge_window_unavailable')
        self.client.create_profile.assert_not_called()
        self.client.open_profile.assert_not_called()
        ran.assert_not_awaited()

    async def test_recheck_human_confirmation_and_any_payment_evidence_forbid_rebuild(self):
        changes = [('mode', 'recheck'), ('payment_request_sent', True), ('confirmation_consumed', True),
                   ('pending_confirmation', {}), ('waiting_for_user', True), ('waiting_for_code', True),
                   ('result', {'payment_status': 'unknown'}), ('result', {'payment_status': 'paid'}),
                   ('result', {'confirmation_requests_sent': 1}), ('result', {'payment_requests_sent': None}),
                   ('result', {'status': 'awaiting_human_verification'})]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                self.setUp()
                if key == 'mode':
                    self.job.payload[key] = value
                else:
                    setattr(self.job, key, value)
                result, ran = await self.execute()
                self.assertEqual(result['reason'], 'owned_recharge_window_unavailable')
                self.client.create_profile.assert_not_called()
                self.client.open_profile.assert_not_called()
                ran.assert_not_awaited()

    async def test_json_account_mismatch_stops_before_creation(self):
        self.target.account_id = 'different-account'
        result, _ = await self.execute()
        self.assertEqual(result['reason'], 'official_account_mismatch')
        self.client.create_profile.assert_not_called()

    async def test_restored_paid_or_unknown_record_blocks_even_login_only_creation(self):
        for record in ({'payment_status': 'unknown'}, {'payment_attempted': True},
                       {'confirmation_requests_sent': 1}, {'payment_status': 'paid'}):
            with self.subTest(record=record):
                self.setUp()
                self.job.payload['mode'] = 'open_browser'
                (self.job.root / ('c' * 64 + '.json')).write_text(json.dumps({
                    'account_key': self.source['accountKey'], **record}))
                result, _ = await self.execute()
                self.assertEqual(result['reason'], 'owned_recharge_window_unavailable')
                self.client.create_profile.assert_not_called()

    def completed_payment(self):
        quote = {'plan': 'plus', 'renewal_interval': 'monthly',
                 'today': {'amount': '20.00', 'amount_minor': 2000, 'currency': 'USD'},
                 'tax': {'amount': '0.00', 'amount_minor': 0, 'currency': 'USD'},
                 'renewal': {'amount': '20.00', 'amount_minor': 2000, 'currency': 'USD'}}
        return {'schema_version': 3, 'account_key': self.source['accountKey'], 'target_plan': 'plus',
                'payment_status': 'paid', 'status': 'subscription_activated',
                'subscription_status': 'plus', 'current_plan': 'plus',
                'payment_attempted': True, 'confirmation_requests_sent': 1,
                'checkout_identifier': 'oaics_completed_past', 'quote': quote,
                'quote_digest': payment_state.quote_digest(quote),
                'payment_evidence': {'kind': 'checkout_session', 'identifier': 'oaics_completed_past',
                                     'amount_minor': 2000, 'currency': 'USD'}}

    async def test_past_completed_payment_with_full_binding_allows_new_login_rebuild(self):
        self.job.payload['mode'] = 'open_browser'
        folder = self.job.root / 'payments'
        folder.mkdir()
        (folder / ('c' * 64 + '.json')).write_text(json.dumps(self.completed_payment()))
        result, _ = await self.execute()
        self.assertEqual(result['status'], 'session_ready')
        self.client.create_profile.assert_called_once()

    async def test_current_bound_paid_order_or_incomplete_past_success_never_rebuilds(self):
        for changed in ({'quote_digest': 'invalid'}, {'payment_evidence': None},
                        {'current_plan': 'free'}, {'status': 'paid_pending_activation'}, {}):
            with self.subTest(changed=changed):
                self.setUp()
                self.job.payload['mode'] = 'open_browser'
                record = {**self.completed_payment(), **changed}
                if not changed:
                    self.job.original_checkout_identifier = record['checkout_identifier']
                folder = self.job.root / 'payments'
                folder.mkdir()
                (folder / ('c' * 64 + '.json')).write_text(json.dumps(record))
                result, _ = await self.execute()
                self.assertEqual(result['reason'], 'owned_recharge_window_unavailable')
                self.client.create_profile.assert_not_called()

    async def test_missing_window_with_unpaid_checkout_restores_original_order(self):
        self.job.original_checkout_identifier = 'oaics_original_order'
        (self.job.root / (self.source['accountKey'] + '.json')).write_text(json.dumps({
            'account_key': self.source['accountKey'], 'payment_status': 'not_attempted',
            'payment_attempted': False, 'confirmation_requests_sent': 0,
            'checkout_identifier': 'oaics_original_order'}))
        with (patch('browser_checkout.prepare_proxy_in_context', AsyncMock()),
              patch.object(retry.pay, 'run_flow', AsyncMock()) as created,
              patch.object(retry.pay, 'run_checkout_flow', AsyncMock(return_value={
                  'status': 'blocked', 'checkout_identifier': 'oaics_original_order',
                  'checkout_requests_sent': 0})) as resumed):
            result = await retry.execute_profiles(self.job, self.client, self.target, self.playwright)
        created.assert_not_awaited()
        resumed.assert_awaited_once()
        self.assertEqual(resumed.call_args.kwargs['expected_checkout_identifier'], 'oaics_original_order')
        self.assertFalse(resumed.call_args.kwargs['allow_checkout_replacement'])
        self.assertEqual(result['checkout_identifier'], 'oaics_original_order')

    async def test_later_network_retry_reopens_replacement_without_creating_again(self):
        failure = {'status': 'blocked', 'reason': 'session_network_error',
                   'browser_error_code': 'net::ERR_CONNECTION_CLOSED',
                   'payment_requests_sent': 0, 'checkout_requests_sent': 0}
        with (patch('browser_checkout.prepare_proxy_in_context', AsyncMock()),
              patch.object(retry, 'close_profile_id', AsyncMock()),
              patch.object(retry.asyncio, 'sleep', AsyncMock()),
              patch.object(retry, '_execute_profile_flow', AsyncMock(side_effect=[
                  (self.target, failure), (self.target, {'status': 'session_ready'})]))):
            result = await retry.execute_profiles(self.job, self.client, self.target, self.playwright)
        self.assertEqual(result['status'], 'session_ready')
        self.client.create_profile.assert_called_once()
        self.client.list_profile_ids.assert_called_once()
        self.assertEqual(self.client.open_profile.call_count, 2)
        self.assertEqual({call.args[0] for call in self.client.open_profile.call_args_list}, {'a' * 32})

    async def test_password_login_proves_same_account_and_restore_keeps_new_profile(self):
        self.job.payload.pop('sessionJson', None)
        self.job.payload['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
        self.job.replaced_owned_profile = dict(self.source)
        self.job.owned_profile = None
        self.job.profile_id = 'a' * 32
        self.job.context = self.context
        self.context.pages = [MagicMock(url='about:blank')]
        with (patch.object(retry.browser_password_login, 'login_with_password', AsyncMock(return_value=(
                  self.target, {'current_plan': 'free'}))),
              patch.object(retry.browser_password_login, 'clear_visible_secrets', AsyncMock()),
              patch.object(retry, 'cancellable_flow', AsyncMock(return_value={'status': 'blocked'})) as flow):
            await retry._execute_profile_flow(self.job, None, SessionBudget(120))
        self.assertEqual(self.job.owned_profile, {**self.source, 'profileId': 'a' * 32})
        flow.assert_awaited_once()

    async def test_password_other_account_never_reaches_restore_or_checkout(self):
        self.job.payload.pop('sessionJson', None)
        self.job.payload['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
        self.job.replaced_owned_profile = dict(self.source)
        self.job.owned_profile = None
        self.job.profile_id = 'a' * 32
        self.job.context = self.context
        self.context.pages = [MagicMock(url='about:blank')]
        self.target.account_id = 'different-account'
        with (patch.object(retry.browser_password_login, 'login_with_password', AsyncMock(return_value=(
                  self.target, {'current_plan': 'free'}))),
              patch.object(retry.browser_password_login, 'clear_visible_secrets', AsyncMock()),
              patch.object(self.job, 'restore_account') as restore,
              patch.object(retry, 'cancellable_flow', AsyncMock()) as flow,
              self.assertRaises(Stop) as stopped):
            await retry._execute_profile_flow(self.job, None, SessionBudget(120))
        self.assertEqual(stopped.exception.report['reason'], 'official_account_mismatch')
        restore.assert_not_called()
        flow.assert_not_awaited()

    async def test_password_restore_cannot_revert_to_old_profile_binding(self):
        self.job.payload.pop('sessionJson', None)
        self.job.payload['login'] = {'email': 'test@example.invalid', 'password': 'synthetic-password'}
        self.job.replaced_owned_profile = dict(self.source)
        self.job.owned_profile = None
        self.job.profile_id = 'a' * 32
        self.job.context = self.context
        self.context.pages = [MagicMock(url='about:blank')]
        self.job.callback.send.side_effect = None
        self.job.callback.send.return_value = {'records': [], 'staleProfiles': [],
                                               'ownedProfile': dict(self.source)}
        with (patch.object(retry.browser_password_login, 'login_with_password', AsyncMock(return_value=(
                  self.target, {'current_plan': 'free'}))),
              patch.object(retry.browser_password_login, 'clear_visible_secrets', AsyncMock()),
              patch.object(retry, 'cancellable_flow', AsyncMock()) as flow,
              self.assertRaises(Stop) as stopped):
            await retry._execute_profile_flow(self.job, None, SessionBudget(120))
        self.assertEqual(stopped.exception.report['reason'], 'owned_recharge_profile_conflict')
        flow.assert_not_awaited()

    def test_replacement_public_fields_are_controlled(self):
        self.assertEqual(connector.public_result({'replaced_browser_profile_id': 'secret',
                                                  'browser_profile_missing_confirmed': 'true'}), {})
        self.assertEqual(connector.public_result({'replaced_browser_profile_id': 'd' * 32,
                                                  'browser_profile_missing_confirmed': True}), {
            'replaced_browser_profile_id': 'd' * 32, 'browser_profile_missing_confirmed': True})

    def test_account_hint_is_validated_and_bound_before_authoritative_restore(self):
        value = payload()
        value['accountKey'] = self.source['accountKey']
        job = connector.LocalJob(value)
        job.root = self.job.root
        job.callback.send = MagicMock()
        with self.assertRaises(Stop) as stopped:
            job.restore_account(SimpleNamespace(account_id='different-account'))
        self.assertEqual(stopped.exception.report['reason'], 'official_account_mismatch')
        job.callback.send.assert_not_called()
        for key in ('invalid', 'f' * 64):
            with self.subTest(key=key), self.assertRaises(Stop):
                connector.LocalJob({**payload(), 'accountKey': key, 'ownedProfile': self.source})


if __name__ == '__main__':
    unittest.main()
