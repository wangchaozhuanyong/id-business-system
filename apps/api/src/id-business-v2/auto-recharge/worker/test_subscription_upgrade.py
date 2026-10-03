"""升级业务路径离线夹具：所有官网/Stripe请求本机截获，真实付款为零。"""
import asyncio
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode, urlsplit

from playwright.async_api import async_playwright

from attempt_ledger import AttemptLedger, assert_no_other_payment
from checkout_core import ACCOUNT_PATH, Stop, parse_browser_credential
from pay import run_flow
from plans import official_subscription, subscription_transition
from subscription_upgrade import (UpgradeLedger, UpgradeGuard, paid_evidence, preview_quote,
                                  recheck_upgrade_in_context, run_upgrade_in_context, safe_period,
                                  validate_upgrade_record, minor_money)
from test_payment import details
from test_subscribe import account, fixture
from test_payment_3ds import Frame, Request, Response, Route
from upgrade_authentication import (UpgradeResponseObservers, drain_upgrade_responses,
                                    upgrade_authentication_summary)

OUTPUT = Path(__file__).resolve().parents[6] / '.runtime/upgrade-any-card-20261003/root/fixtures'


def action_intent(**updates):
    return {'object': 'payment_intent', 'id': 'pi_Synthetic', 'status': 'requires_action',
            'amount': 40000, 'amount_received': 0, 'currency': 'myr', 'confirmation_method': 'automatic',
            'next_action': {'type': 'use_stripe_sdk', 'use_stripe_sdk': {
                'type': 'stripe_3ds2_fingerprint', 'three_d_secure_2_source': 'src_upgrade'}}, **updates}


def preview():
    return {'currency': 'MYR', 'amount_due': {'amount': 40000, 'amount_excluding_tax': 40000, 'tax_amount': 0},
            'positive_line_item_total': 42000, 'negative_line_item_total': -2000,
            'applied_balance': 0, 'discount_amount': 0,
            'default_payment_method': {'card_brand': 'mastercard', 'card_last4': '4242'},
            'renewal_date': '2026-11-03T00:00:00Z'}


class UpgradeStateTests(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=OUTPUT)
        self.root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())

    def tearDown(self):
        self.temp.cleanup()

    def test_only_free_or_plus_to_pro_transition_allowed(self):
        for plan in ('plus', 'go', 'pro-5x', 'pro-20x', 'pro-500'):
            self.assertEqual(subscription_transition('free', plan), 'new_subscription')
        for plan in ('pro-5x', 'pro-20x', 'pro-500'):
            self.assertEqual(subscription_transition('plus', plan), 'subscription_upgrade')
        for current, target in (('plus', 'plus'), ('plus', 'go'), ('go', 'pro-20x'),
                                ('pro', 'pro-20x'), ('unknown', 'pro-500')):
            with self.assertRaises(Stop):
                subscription_transition(current, target)

    def test_actual_official_plan_names_verify_tier_and_account(self):
        for current, tier in (('prolite', 5), ('pro', 20), ('promax', None)):
            data = account(current)
            observed = official_subscription(data, self.target.account_id)
            self.assertEqual(observed['current_tier'], tier)
            self.assertEqual(observed['current_plan'], 'promax' if current == 'promax' else 'pro')
            with self.assertRaises(Stop):
                official_subscription(data, 'other-account')

    def test_proration_is_official_minor_amount_and_not_full_new_subscription_price(self):
        quote = preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000))
        self.assertEqual(quote['today']['amount_minor'], 40000)
        self.assertEqual(quote['renewal']['amount_minor'], 42000)
        self.assertEqual(quote['today']['amount'], '400.00')
        for bad in ({'amount_due': {'amount': 40000, 'amount_excluding_tax': 40000, 'tax_amount': 1}},
                    {'negative_line_item_total': 2000}, {'positive_line_item_total': 42000.0},
                    {'applied_balance': -100}, {'discount_amount': 10}):
            with self.subTest(bad=bad), self.assertRaises(Stop):
                preview_quote({**preview(), **bad}, 'pro-20x', minor_money('MYR', 42000))

    def marker(self):
        with UpgradeLedger(self.root, self.target.account_id, 'pro-20x') as ledger:
            ledger.begin(preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000)), '4242')
            return dict(ledger.record), ledger.path

    def test_upgrade_marker_blocks_new_checkout_and_repeat_update(self):
        record, path = self.marker()
        self.assertEqual(path.parent.name, 'payments')
        self.assertNotIn('checkout_identifier', record)
        before = path.read_bytes()
        with self.assertRaises(Stop) as blocked:
            with AttemptLedger(self.root, self.target.account_id, target_plan='pro-500'):
                pass
        self.assertEqual(blocked.exception.report['reason'], 'previous_upgrade_attempt_exists')
        with self.assertRaises(Stop):
            with UpgradeLedger(self.root, self.target.account_id, 'pro-20x'):
                pass
        with UpgradeLedger(self.root, self.target.account_id, 'pro-20x', record['upgrade_identifier']) as ledger:
            self.assertEqual(ledger.record, record)
            with self.assertRaises(Stop):
                ledger.begin(record['quote'], '4242')
        self.assertEqual(path.read_bytes(), before)

    def test_unknown_original_payment_is_never_ignored_for_upgrade(self):
        folder = self.root / 'payments'
        folder.mkdir(parents=True)
        (folder / ('a' * 64 + '.json')).write_text(json.dumps({
            'account_key': hashlib.sha256(self.target.account_id.encode()).hexdigest(),
            'target_plan': 'plus', 'payment_attempted': True, 'payment_status': 'unknown'}))
        with self.assertRaises(Stop) as blocked:
            with UpgradeLedger(self.root, self.target.account_id, 'pro-20x'):
                pass
        self.assertEqual(blocked.exception.report['reason'], 'account_has_other_payment_attempt')

    def test_payment_evidence_requires_bound_true_invoice_or_intent(self):
        record, _ = self.marker()
        record.update(upgrade_invoice_identifier='in_Synthetic', upgrade_payment_intent_identifier='pi_Synthetic')
        invoice = {'object': 'invoice', 'id': 'in_Synthetic', 'status': 'paid', 'paid': True,
                   'amount_paid': 40000, 'currency': 'myr'}
        evidence = paid_evidence(invoice, record)
        self.assertEqual(evidence['kind'], 'invoice')
        for changed in ({'id': 'in_Other'}, {'amount_paid': 42000}, {'currency': 'usd'}, {'paid': False}):
            self.assertIsNone(paid_evidence({**invoice, **changed}, record))
        intent = {'object': 'payment_intent', 'id': 'pi_Synthetic', 'status': 'succeeded',
                  'amount_received': 40000, 'currency': 'myr'}
        self.assertEqual(paid_evidence(intent, record)['kind'], 'payment_intent')
        self.assertIsNone(paid_evidence({**intent, 'id': 'pi_Other'}, record))

    def test_first_paid_intent_is_preserved_after_matching_invoice_and_conflicts_stop(self):
        with UpgradeLedger(self.root, self.target.account_id, 'pro-20x') as ledger:
            ledger.begin(preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000)), '4242')
            ledger.update(confirmation_requests_sent=1, upgrade_payment_intent_identifier='pi_Synthetic',
                          upgrade_invoice_identifier='in_Synthetic')
            guard = UpgradeGuard(self.target, ledger)
            guard.observe({'object': 'payment_intent', 'id': 'pi_Synthetic', 'status': 'succeeded',
                           'amount_received': 40000, 'currency': 'myr'})
            first = dict(ledger.record['payment_evidence'])
            invoice = {'object': 'invoice', 'id': 'in_Synthetic', 'payment_intent': 'pi_Synthetic',
                       'status': 'paid', 'paid': True, 'amount_paid': 40000, 'currency': 'myr'}
            guard.observe(invoice)
            self.assertEqual(ledger.record['payment_evidence'], first)
            for changed in ({'amount_paid': 42000}, {'currency': 'usd'}, {'id': 'in_Other'}):
                with self.subTest(changed=changed), self.assertRaises(Stop):
                    guard.observe({**invoice, **changed})
                self.assertEqual(ledger.record['payment_evidence'], first)

    def test_job_confirmation_emits_complete_upgrade_contract_without_secrets(self):
        import server
        quote = {**preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000)),
                 'operation': 'subscription_upgrade', 'upgrade_identifier': 'upg_' + 'a' * 32}
        job = server.Job('11111111-1111-4111-8111-111111111111', {
            'action': 'server', 'plan': 'pro-20x', 'safety': {
                'authorizeSinglePayment': True, 'lockedCurrency': 'MYR', 'maxAmountMinor': 40000}})
        with patch.object(server, 'callback') as callback:
            self.assertTrue(job.confirm(quote, '4242'))
        report = callback.call_args[0][1]['result']
        self.assertEqual(report['operation'], 'subscription_upgrade')
        self.assertEqual(report['current_plan_before'], 'plus')
        self.assertEqual(report['target_plan'], 'pro-20x')
        self.assertEqual(report['upgrade_identifier'], quote['upgrade_identifier'])
        self.assertEqual(report['quote_authority'], 'official_upgrade_preview')
        self.assertEqual(server.public_result(report), report)
        self.assertNotIn('checkout_identifier', report)
        self.assertEqual(report['quote']['today']['amount_minor'], 40000)

    def test_period_requires_aware_ordered_official_dates(self):
        with UpgradeLedger(self.root, self.target.account_id, 'pro-20x') as ledger:
            observed = safe_period({'active_start': '2026-10-03T00:00:00Z', 'active_until': '2026-11-03T00:00:00Z'}, ledger)
            self.assertEqual(observed['end'], '2026-11-03T00:00:00.000Z')
            for bad in ({'active_start': '2026-10-03', 'active_until': '2026-11-03'},
                        {'active_start': '2026-11-03T00:00:00Z', 'active_until': '2026-10-03T00:00:00Z'},
                        {'active_start': '2026-10-03T00:00:00Z', 'active_until': '2027-11-03T00:00:00Z'}):
                self.assertIsNone(safe_period(bad, ledger))


class UpgradeThreeDSGuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=OUTPUT)
        self.target = parse_browser_credential(fixture())
        self.ledger = UpgradeLedger(Path(self.temp.name) / 'state', self.target.account_id, 'pro-20x')
        self.ledger.__enter__()
        self.frame = Frame('https://chatgpt.com/')
        self.guard = UpgradeGuard(self.target, self.ledger, self.frame)
        self.ledger.begin(preview_quote(preview(), 'pro-20x', minor_money('MYR', 42000)), '4242')
        self.guard.approved, self.guard.preflight = True, AsyncMock()
        self.guard.method_id = 'pm_Synthetic'

    async def asyncTearDown(self):
        self.ledger.__exit__()
        self.temp.cleanup()

    async def submit(self, intent=None):
        request = Request('https://chatgpt.com/backend-api/subscriptions/update',
            data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}),
            headers={'authorization': 'Bearer ' + self.target.old_token}, frame=self.frame)
        route = Route(request)
        await self.guard.route(route)
        self.assertTrue(route.passed)
        await self.guard.response(Response(request, {'status': 'requires_action',
            'pending_update_invoice_id': 'in_Synthetic', 'payment_intent': intent or action_intent()}))
        return request

    async def auth(self, *, frame=None, source='src_upgrade', extra=None, path='authenticate'):
        route = Route(Request('https://api.stripe.com/v1/3ds2/' + path,
            data=urlencode({'source': source, **(extra or {})}), frame=frame or self.frame))
        await self.guard.route(route)
        return route

    async def test_same_upgrade_intent_frictionless_proves_paid_once(self):
        await self.submit()
        route = await self.auth()
        self.assertTrue(route.passed)
        await self.guard.response(Response(route.request, {'source': 'src_upgrade',
            'payment_intent': action_intent(status='succeeded', amount_received=40000, next_action=None)}))
        self.assertEqual(self.ledger.record['payment_status'], 'paid')
        self.assertEqual(self.ledger.record['payment_evidence']['identifier'], 'pi_Synthetic')
        self.assertEqual(self.ledger.record['three_ds_status'], 'completed')
        self.assertEqual(self.guard.sent, 1)
        self.assertTrue((await self.auth()).blocked)
        for path in ('/v1/payment_intents/pi_Synthetic/confirm', '/v1/payment_methods', '/v1/tokens'):
            route = Route(Request('https://api.stripe.com' + path, data='{}', frame=self.frame))
            await self.guard.route(route)
            self.assertTrue(route.blocked)

    async def test_wrong_source_intent_fields_or_other_page_cannot_authenticate(self):
        await self.submit()
        for options in ({'source': 'src_other'}, {'extra': {'payment_intent': 'pi_Other'}},
                        {'extra': {'amount': '40000'}}, {'extra': {'payment_method': 'pm_Other'}},
                        {'frame': Frame('https://chatgpt.com/')}):
            self.assertTrue((await self.auth(**options)).blocked)
        self.frame.url = 'https://chatgpt.com/settings'
        self.assertTrue((await self.auth()).blocked)

    async def test_missing_or_manual_action_binding_never_opens_authentication(self):
        await self.submit(action_intent(confirmation_method='manual'))
        self.assertEqual(self.guard.three_ds.status, 'unsupported')
        self.assertTrue((await self.auth()).blocked)
        self.assertIsNone(self.ledger.record.get('payment_evidence'))

    async def test_wrong_amount_action_never_opens_authentication(self):
        await self.submit(action_intent(amount=42000))
        self.assertTrue((await self.auth()).blocked)
        self.assertEqual(self.ledger.record['payment_status'], 'requires_action')

    async def test_authentication_wrong_pi_or_invoice_cannot_be_payment_evidence(self):
        await self.submit()
        route = await self.auth()
        self.assertTrue(route.passed)
        await self.guard.response(Response(route.request, {'source': 'src_upgrade', 'object': 'invoice',
            'id': 'in_Synthetic', 'status': 'paid', 'paid': True, 'amount_paid': 40000, 'currency': 'myr'}))
        self.assertIsNone(self.ledger.record.get('payment_evidence'))
        await self.guard.response(Response(route.request, {'source': 'src_upgrade',
            'payment_intent': action_intent(id='pi_Other', status='succeeded', amount_received=40000)}))
        self.assertIsNone(self.ledger.record.get('payment_evidence'))
        self.assertEqual(self.guard.three_ds.status, 'failed')

    async def test_closed_gate_allows_late_paid_evidence_but_cannot_reopen(self):
        await self.submit()
        route = await self.auth()
        self.assertTrue(route.passed)
        self.guard.three_ds.finish()
        await self.guard.response(Response(route.request, {'source': 'src_upgrade', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-id', 'acsTransID': 'acs-id'},
            'payment_intent': action_intent(status='succeeded', amount_received=40000, next_action=None)}))
        self.assertEqual(self.ledger.record['payment_status'], 'paid')
        self.assertFalse(self.guard.three_ds.entries)
        self.assertFalse(self.guard.three_ds.active)
        await self.guard.response(Response(route.request, {'source': 'src_upgrade', 'payment_intent': action_intent()}))
        self.assertEqual(self.ledger.record['payment_status'], 'paid')
        self.assertTrue((await self.auth(path='challenge_complete')).blocked)

    async def test_late_fingerprint_cannot_rewind_challenge_or_completed_stage(self):
        await self.submit()
        route = await self.auth()
        await self.guard.response(Response(route.request, {'source': 'src_upgrade', 'ares': {
            'acsURL': 'https://bank.example.com/acs', 'threeDSServerTransID': 'server-id', 'acsTransID': 'acs-id'}}))
        self.assertEqual(self.ledger.record['three_ds_status'], 'awaiting_user')
        linked = Request('https://api.stripe.com/v1/payment_intents/pi_Synthetic', method='GET', frame=self.frame)
        await self.guard.response(Response(linked, action_intent()))
        self.assertEqual(self.guard.three_ds.status, 'awaiting_user')
        self.assertEqual(self.ledger.record['three_ds_status'], 'awaiting_user')
        self.assertEqual(upgrade_authentication_summary(self.guard, self.ledger.record)['reason'], 'bank_verification_required')
        challenge = await self.auth(path='challenge_complete')
        self.assertTrue(challenge.passed)
        await self.guard.response(Response(challenge.request, {'source': 'src_upgrade',
            'payment_intent': action_intent(status='succeeded', amount_received=40000, next_action=None)}))
        await self.guard.response(Response(linked, action_intent()))
        self.assertEqual(self.guard.three_ds.status, 'completed')
        self.assertFalse(self.guard.three_ds.active)
        self.assertEqual(self.ledger.record['payment_status'], 'paid')
        self.assertNotIn('reason', upgrade_authentication_summary(self.guard, self.ledger.record))

    async def test_closed_gate_cannot_bind_again_even_with_matching_fingerprint(self):
        await self.submit()
        self.guard.three_ds.finish()
        self.assertFalse(self.guard.three_ds.bind_action(action_intent(), self.ledger.record))
        self.assertFalse(self.guard.three_ds.active)
        self.assertFalse(self.guard.three_ds.entries)

    async def test_finish_during_header_inspection_cannot_send_upgrade_authentication(self):
        await self.submit()
        started, release = asyncio.Event(), asyncio.Event()
        request = Request('https://api.stripe.com/v1/3ds2/authenticate', data='source=src_upgrade', frame=self.frame)
        async def held_headers():
            started.set()
            await release.wait()
            return {}
        request.all_headers = held_headers
        route = Route(request)
        task = asyncio.create_task(self.guard.route(route))
        await started.wait()
        self.guard.three_ds.finish()
        release.set()
        await task
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertEqual(self.guard.three_ds.requests[request], '/v1/3ds2/authenticate')
        self.assertEqual(self.guard.sent, 1)

    async def test_changed_payment_state_during_headers_cannot_send_authentication(self):
        await self.submit()
        started, release = asyncio.Event(), asyncio.Event()
        request = Request('https://api.stripe.com/v1/3ds2/authenticate', data='source=src_upgrade', frame=self.frame)
        async def held_headers():
            started.set()
            await release.wait()
            return {}
        request.all_headers = held_headers
        route = Route(request)
        task = asyncio.create_task(self.guard.route(route))
        await started.wait()
        self.ledger.update(payment_status='unknown')
        release.set()
        await task
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)

    async def test_drain_settles_observers_added_during_wait_before_paid_receipt(self):
        await self.submit()
        tasks, release, started = set(), asyncio.Event(), asyncio.Event()
        auth = await self.auth()
        async def late_paid():
            started.set()
            await release.wait()
            await self.guard.response(Response(auth.request, {'source': 'src_upgrade',
                'payment_intent': action_intent(status='succeeded', amount_received=40000, next_action=None)}))
        async def first_observer():
            await asyncio.sleep(0)
            tasks.add(asyncio.create_task(late_paid()))
        tasks.add(asyncio.create_task(first_observer()))
        self.guard.three_ds.finish()
        drain = asyncio.create_task(drain_upgrade_responses(tasks))
        await started.wait()
        await asyncio.sleep(0)
        self.assertFalse(drain.done())
        release.set()
        await drain
        self.assertFalse(tasks)
        receipt = {**self.ledger.record, **upgrade_authentication_summary(self.guard, self.ledger.record)}
        self.assertEqual(receipt['payment_status'], 'paid')
        self.assertEqual(receipt['three_ds_status'], 'completed')
        self.assertNotIn('reason', receipt)

    async def test_observer_finish_detaches_before_drain_and_is_idempotent(self):
        await self.submit()
        context = unittest.mock.Mock()
        context.on.return_value = None
        observer = UpgradeResponseObservers(context, self.guard)
        observer.observe(Response(self.guard.update_request, {'payment_intent':
            action_intent(status='succeeded', amount_received=40000, next_action=None)}))
        await observer.finish()
        await observer.finish()
        context.remove_listener.assert_called_once_with('response', observer.observe)
        self.assertFalse(observer.tasks)
        self.assertEqual(self.ledger.record['payment_status'], 'paid')
        self.assertTrue(self.guard.three_ds.closed)

    async def test_incomplete_or_failed_authentication_has_precise_reason(self):
        await self.submit(action_intent(confirmation_method='manual'))
        self.assertEqual(upgrade_authentication_summary(self.guard, self.ledger.record)['reason'], 'three_ds_binding_unverified')
        self.guard.three_ds.close('failed')
        self.ledger.update(three_ds_status='failed')
        self.assertEqual(upgrade_authentication_summary(self.guard, self.ledger.record)['reason'], 'three_ds_authentication_failed')

    async def test_actual_cancelled_flow_receipt_uses_paid_evidence_settled_during_cleanup(self):
        self.ledger.__exit__()
        clean_root = Path(self.temp.name) / 'cancelled-flow'
        context = SimpleNamespace(route=AsyncMock(), unroute=AsyncMock(), remove_listener=unittest.mock.Mock())
        context.on = lambda _event, callback: setattr(context, 'observe', callback)
        page = SimpleNamespace(main_frame=self.frame, context=context)
        button = SimpleNamespace(click=AsyncMock())
        subscription = {'plan_type': 'plus', 'is_processor_stripe': True, 'will_renew': True}
        identity = {'current_plan': 'plus', 'current_tier': None, 'account_matched': True}
        method = {'default_payment_method_id': 'pm_Synthetic', 'payment_methods': [{
            'id': 'pm_Synthetic', 'type': 'card', 'card': {'last4': '4242', 'exp_month': 12, 'exp_year': 2039}}]}
        async def read(_page, path, _target):
            return preview() if '/preview' in path else method
        async def cancel_after_queued_paid(guard, *_args):
            guard.sent = 1
            guard.upgrade_ledger.update(confirmation_requests_sent=1, payment_status='requires_action',
                                       upgrade_payment_intent_identifier='pi_Synthetic')
            request = Request('https://api.stripe.com/v1/payment_intents/pi_Synthetic', method='GET', frame=self.frame)
            context.observe(Response(request, action_intent(status='succeeded', amount_received=40000, next_action=None)))
            raise Stop('operation_cancelled')
        with patch('subscription_upgrade.read_subscription', AsyncMock(return_value=(self.target, identity, subscription))), \
                patch('subscription_upgrade.select_plan', AsyncMock(return_value=button)), \
                patch('subscription_upgrade.verify_selected_plan', AsyncMock()), \
                patch('subscription_upgrade.visible_renewal', AsyncMock(return_value=minor_money('MYR', 42000))), \
                patch('subscription_upgrade.verify_preview_dom', AsyncMock(return_value=button)), \
                patch('subscription_upgrade.browser_read', side_effect=read), \
                patch('subscription_upgrade.prepare_upgrade_card', AsyncMock(return_value='pm_Synthetic')), \
                patch('subscription_upgrade.verify_selected_upgrade_card', AsyncMock(return_value='pm_Synthetic')), \
                patch('subscription_upgrade.wait_upgrade_authentication', side_effect=cancel_after_queued_paid):
            result = await run_upgrade_in_context(page, self.target, clean_root, 'pro-20x',
                details_reader=lambda _quote: details(), confirmer=lambda *_args: True)
        self.assertEqual(result['payment_status'], 'paid', result)
        self.assertEqual(result['status'], 'paid_pending_activation', result)
        self.assertEqual(result['payment_outcome'], 'paid_pending_activation')
        self.assertEqual(result['payment_evidence']['identifier'], 'pi_Synthetic')
        self.assertEqual(result['payment_requests_sent'], 1)
        context.remove_listener.assert_called_once()

    async def test_http_failures_are_unknown_only_explicit_method_failed_is_declined(self):
        request = await self.submit()
        for status in (400, 402, 403, 404, 409, 422, 500):
            await self.guard.response(Response(request, {'error': 'synthetic'}, status=status))
            self.assertEqual(self.ledger.record['payment_status'], 'unknown')
            self.assertIsNone(self.ledger.record.get('payment_evidence'))
        await self.guard.response(Response(request, {'status': 'payment_method_failed'}))
        self.assertEqual(self.ledger.record['payment_status'], 'declined')

    async def test_original_recheck_never_opens_authentication(self):
        await self.submit()
        read = UpgradeGuard(self.target, self.ledger, self.frame)
        request = Request('https://api.stripe.com/v1/payment_intents/pi_Synthetic', method='GET', frame=self.frame)
        await read.response(Response(request, action_intent()))
        route = Route(Request('https://api.stripe.com/v1/3ds2/authenticate',
            data='source=src_upgrade', frame=self.frame))
        await read.route(route)
        self.assertTrue(route.blocked)
        self.assertFalse(read.three_ds.active)
        self.assertEqual(read.sent, 0)

    async def test_navigation_before_original_update_cannot_send_payment(self):
        self.frame.url = 'https://chatgpt.com/settings'
        route = Route(Request('https://chatgpt.com/backend-api/subscriptions/update', frame=self.frame,
            data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}),
            headers={'authorization': 'Bearer ' + self.target.old_token}))
        await self.guard.route(route)
        self.assertTrue(route.blocked)
        self.assertEqual(self.guard.sent, 0)
        self.assertEqual(self.ledger.record['confirmation_requests_sent'], 0)

    async def test_finish_during_original_update_preflight_never_marks_or_sends_payment(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def held_preflight():
            started.set()
            await release.wait()
        self.guard.preflight = held_preflight
        request = Request('https://chatgpt.com/backend-api/subscriptions/update', frame=self.frame,
            data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}),
            headers={'authorization': 'Bearer ' + self.target.old_token})
        route = Route(request)
        task = asyncio.create_task(self.guard.route(route))
        await started.wait()
        self.guard.three_ds.finish()
        release.set()
        await task
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertEqual(self.guard.sent, 0)
        self.assertEqual(self.ledger.record['confirmation_requests_sent'], 0)
        self.assertEqual(self.guard.error.report['reason'], 'operation_cancelled')

    async def test_cancelled_preflight_cannot_mark_or_send_original_update(self):
        self.guard.preflight = AsyncMock(side_effect=Stop('operation_cancelled'))
        request = Request('https://chatgpt.com/backend-api/subscriptions/update', frame=self.frame,
            data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}),
            headers={'authorization': 'Bearer ' + self.target.old_token})
        route = Route(request)
        await self.guard.route(route)
        self.assertTrue(route.blocked)
        self.assertFalse(route.passed)
        self.assertEqual(self.guard.sent, 0)
        self.assertEqual(self.ledger.record['confirmation_requests_sent'], 0)

    async def test_missing_selected_method_cannot_fall_back_to_old_default_or_retry(self):
        request = Request('https://chatgpt.com/backend-api/subscriptions/update', frame=self.frame,
            data=json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro'}),
            headers={'authorization': 'Bearer ' + self.target.old_token})
        first = Route(request)
        await self.guard.route(first)
        self.assertTrue(first.blocked)
        self.assertFalse(first.passed)
        self.assertFalse(self.guard.approved)
        request.post_data = json.dumps({'account_id': self.target.account_id, 'updated_plan': 'chatgptpro',
                                        'payment_method_id': 'pm_Synthetic'})
        second = Route(request)
        await self.guard.route(second)
        self.assertTrue(second.blocked)
        self.assertFalse(second.passed)
        self.assertEqual(self.guard.sent, 0)
        self.assertEqual(self.ledger.record['confirmation_requests_sent'], 0)


@unittest.skipUnless(os.environ.get('V2_PAYMENT_3DS_BROWSER_TEST') == '1', '本地浏览器夹具需显式启用')
class UpgradeBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=OUTPUT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        if os.environ.get('V2_REGISTRATION_FINGERPRINT_BINARY'):
            from fingerprint_runtime import launch_fingerprint_browser
            self.browser = await launch_fingerprint_browser(self.pw, headless=True,
                executable_path=os.environ['V2_REGISTRATION_FINGERPRINT_BINARY'])
        else:
            self.browser = await self.pw.chromium.launch(headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context(service_workers='block')
        self.addAsyncCleanup(self.context.close)
        await self.context.route('**/*', self.server)
        self.updates, self.creates, self.other_writes = 0, 0, []
        self.plan, self.response_mode, self.final_plan = 'plus', 'paid', 'pro'
        self.changed_quote, self.missing_card_entry, self.wrong_request, self.annual = False, False, False, False
        self.preview_reads = 0
        self.non_default_card = False
        self.card_reprices = False
        self.update_method_id = None
        self.double_update = False
        self.subscription_reads = 0
        self.preflight_started, self.preflight_release = asyncio.Event(), asyncio.Event()
        self.records = []
        self.auth_paid = False
        self.auth_counts = {'authenticate': 0, 'complete': 0, 'issuer': 0}

    async def wait_stage(self, task, event, timeout=30):
        waiting = asyncio.create_task(event.wait())
        try:
            done, _ = await asyncio.wait({task, waiting}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if waiting not in done:
                self.fail('未到达夹具阶段：' + str(task.result() if task in done else '超时'))
        finally:
            waiting.cancel()
            await asyncio.gather(waiting, return_exceptions=True)

    def home(self):
        cadence = 'Billed monthly, starting today (billed annually)' if self.annual else 'Billed monthly, starting today'
        body = {'account_id': self.target.account_id, 'updated_plan': 'chatgptpro', 'payment_method_id': 'pm_Synthetic'}
        if self.wrong_request:
            body['updated_plan'] = 'chatgptpromax'
        send = "fetch('/backend-api/subscriptions/update',{method:'POST',headers:{'content-type':'application/json',authorization:" + json.dumps('Bearer ' + self.target.old_token) + "},body:JSON.stringify({..." + json.dumps(body) + ",payment_method_id:document.querySelector('input[name=plan-upgrade-payment-method]:checked')?.value})})"
        script = 'async function pay(){await ' + send + '}'
        if self.double_update:
            script = 'async function pay(){const send=()=>'+send+';await Promise.allSettled([send(),send()])}'
        if self.response_mode in {'auth_frictionless', 'auth_challenge'}:
            script = '''const post=async(path)=>(await fetch('https://api.stripe.com/v1/3ds2/'+path,
            {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'source=src_upgrade'})).json();
            async function pay(){try{const result=await (await ''' + send + ''').json();
            if(result.status==='requires_action'){const auth=await post('authenticate');
            if(auth.ares){await fetch('https://api.stripe.com/v1/payment_intents/pi_Synthetic');
            const f=document.createElement('iframe');f.id='challenge';document.body.append(f);f.src=auth.ares.acsURL;}
            else{await Promise.allSettled([post('authenticate'),fetch('https://api.stripe.com/v1/payment_intents/pi_Synthetic/confirm',
            {method:'POST',body:'original=synthetic'}),fetch('https://api.stripe.com/v1/payment_methods',{method:'POST',body:'type=card'})]);}}}catch(_error){}}
            window.addEventListener('message',async(event)=>{if(event.origin==='https://bank.example.com'&&event.data==='synthetic-user-finished')
            await post('challenge_complete')});'''
        radios = '<label>MASTERCARD *4242<input type="radio" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)" name="plan-upgrade-payment-method" value="pm_Synthetic" checked></label>'
        if self.non_default_card:
            radios = '<label>Old *9999<input type="radio" name="plan-upgrade-payment-method" value="pm_Default" checked></label>' + radios.replace(' checked', '')
        if self.card_reprices:
            radios = radios.replace('value="pm_Synthetic"', 'value="pm_Synthetic" onchange="document.querySelector(\'#due\').textContent=\'MYR 410.00\'"')
        html = '''<main><h1>Pro</h1><div role="radiogroup" aria-label="Choose Pro plan tier">
        <button role="radio" aria-checked="false" onclick="choose(this)">100</button>
        <button role="radio" aria-checked="false" onclick="choose(this)">200</button>
        <button role="radio" aria-checked="false" onclick="choose(this)">500</button></div>
        <button id="upgrade" onclick="openUpgrade()">Upgrade to Pro</button></main>
        <script>function choose(el){document.querySelectorAll('[role=radio]').forEach(n=>n.setAttribute('aria-checked',String(n===el)))}
        function openUpgrade(){document.querySelector('main').innerHTML = `<div role="dialog"><h2>Upgrade</h2><p>ChatGPT Pro 200</p>
        <p>MYR 420.00</p><p>''' + cadence + '''</p><p>Total due today</p><p id="due">MYR 400.00</p>
        <p>Tax</p><p>MYR 0.00</p><p>MASTERCARD *4242</p>
        ''' + radios + '''<button onclick="pay()">Pay now</button></div>`}
        ''' + script + '</script>'
        return html

    async def server(self, route):
        r, p = route.request, urlsplit(route.request.url)
        cors = {'Access-Control-Allow-Origin': 'https://chatgpt.com', 'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}
        if r.method == 'OPTIONS':
            await route.fulfill(status=204, headers=cors)
            return
        data = None
        if r.method == 'GET' and p.path in ('/', ''):
            await route.fulfill(status=200, content_type='text/html', body=self.home())
            return
        if p.hostname == 'chatgpt.com' and p.path == '/cdn-cgi/trace':
            await route.fulfill(status=200, content_type='text/plain', body='ip=203.0.113.8\nloc=MY\n')
            return
        if p.path == '/api/auth/session':
            data = json.loads(fixture())
        elif p.path == ACCOUNT_PATH:
            data = account(self.plan)
        elif p.path == '/backend-api/subscriptions':
            self.subscription_reads += 1
            if self.double_update and self.subscription_reads == 3:
                self.preflight_started.set()
                await self.preflight_release.wait()
            data = {'account_id': self.target.account_id, 'plan_type': self.plan, 'is_processor_stripe': True,
                    'is_delinquent': False, 'will_renew': True, 'billing_period': 'monthly',
                    'active_start': '2026-10-03T00:00:00Z', 'active_until': '2026-11-03T00:00:00Z'}
        elif p.path == '/backend-api/subscriptions/update/preview':
            self.preview_reads += 1
            data = preview()
            if (self.changed_quote or self.card_reprices) and self.preview_reads >= 2:
                data['amount_due'] = {'amount': 41000, 'amount_excluding_tax': 41000, 'tax_amount': 0}
                data['negative_line_item_total'] = -1000
        elif p.path == '/backend-api/payments/payment_methods':
            data = {'default_payment_method_id': 'pm_Synthetic', 'payment_methods': [{
                'id': 'pm_Synthetic', 'type': 'card', 'card': {'last4': '9999' if self.missing_card_entry else '4242', 'exp_month': 12, 'exp_year': 2039}}]}
            if self.non_default_card:
                data['default_payment_method_id'] = 'pm_Default'
                data['payment_methods'].append({'id': 'pm_Default', 'type': 'card', 'card': {'last4': '9999', 'exp_month': 12, 'exp_year': 2039}})
        elif p.path == '/backend-api/subscriptions/update' and r.method == 'POST':
            self.update_method_id = r.post_data_json.get('payment_method_id')
            self.updates += 1
            self.plan = self.final_plan if self.response_mode == 'paid' else 'plus'
            data = {'status': 'complete' if self.response_mode == 'paid' else 'requires_action',
                    'pending_update_invoice_id': 'in_Synthetic', 'payment_intent': {
                        'object': 'payment_intent', 'id': 'pi_Synthetic', 'status': 'succeeded' if self.response_mode == 'paid' else 'requires_action',
                        'currency': 'myr', 'amount_received': (41000 if self.card_reprices else 40000) if self.response_mode == 'paid' else 0}}
            if self.response_mode in {'auth_frictionless', 'auth_challenge'}:
                data['payment_intent'] = action_intent()
        elif p.hostname == 'api.stripe.com' and p.path in ('/v1/3ds2/authenticate', '/v1/3ds2/challenge_complete'):
            self.assertEqual(self.updates, 1)
            self.assertEqual(json.loads(next((self.root / 'payments').glob('*.json')).read_text())['confirmation_requests_sent'], 1)
            key = 'authenticate' if p.path.endswith('/authenticate') else 'complete'
            self.auth_counts[key] += 1
            data = {'source': 'src_upgrade'}
            if key == 'authenticate' and self.response_mode == 'auth_challenge':
                data['ares'] = {'acsURL': 'https://bank.example.com/acs',
                    'threeDSServerTransID': 'server-id', 'acsTransID': 'acs-id'}
            else:
                self.auth_paid, self.plan = True, self.final_plan
                data['payment_intent'] = action_intent(status='succeeded', amount_received=40000, next_action=None)
        elif p.hostname == 'api.stripe.com' and p.path == '/v1/payment_intents/pi_Synthetic' and r.method == 'GET':
            data = action_intent()  # A late original fingerprint after ARES must not rewind its challenge.
        elif p.hostname == 'bank.example.com' and p.path == '/acs':
            await route.fulfill(content_type='text/html; charset=utf-8', body='''<!doctype html><meta charset="utf-8">
            <form method="POST" action="/verified"><button>本人完成合成验证</button></form>''')
            return
        elif p.hostname == 'bank.example.com' and p.path == '/verified' and r.method == 'POST':
            self.auth_counts['issuer'] += 1
            record = json.loads(next((self.root / 'payments').glob('*.json')).read_text())
            self.assertIsNone(record.get('payment_evidence'))
            await route.fulfill(content_type='text/html; charset=utf-8', body='''<!doctype html><meta charset="utf-8">
            <script>parent.postMessage('synthetic-user-finished','https://chatgpt.com')</script>''')
            return
        elif p.path == '/backend-api/invoices':
            paid = self.response_mode == 'paid' or self.auth_paid
            data = {'data': [{'object': 'invoice', 'id': 'in_Synthetic', 'payment_intent': 'pi_Synthetic',
                             'status': 'paid' if paid else 'open', 'paid': paid,
                             'amount_paid': (41000 if self.card_reprices else 40000) if paid else 0, 'currency': 'myr'}]}
        elif p.path == '/backend-api/payments/checkout':
            self.creates += 1
            data = {}
        if data is not None:
            await route.fulfill(status=200, content_type='application/json', headers=cors, body=json.dumps(data))
        else:
            if r.method != 'GET':
                self.other_writes.append(p.path)
            await route.abort()

    async def flow(self, confirmer=lambda *_: True, wait_seconds=.4):
        with contextlib.redirect_stderr(io.StringIO()):
            return await run_flow(self.target, self.root, 'pro-20x', details_reader=lambda _: details(),
                                  confirmer=confirmer, browser_context=self.context,
                                  wait_seconds=wait_seconds, poll_count=1, poll_interval=.01)

    async def test_original_upgrade_frictionless_authentication_activates_without_second_payment(self):
        self.response_mode = 'auth_frictionless'
        result = await self.flow(wait_seconds=2)
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['three_ds_status'], 'completed')
        self.assertEqual(result['payment_evidence']['identifier'], 'pi_Synthetic')
        self.assertEqual(self.updates, 1)
        self.assertEqual(self.auth_counts, {'authenticate': 1, 'complete': 0, 'issuer': 0})
        self.assertFalse(self.other_writes)
        record = next((self.root / 'payments').glob('*.json')).read_text()
        for secret in ('next_action', 'src_upgrade', 'client_secret', 'bank.example.com'):
            self.assertNotIn(secret, record)

    async def test_original_upgrade_bank_user_form_completes_bound_intent(self):
        self.response_mode = 'auth_challenge'
        with patch.dict(os.environ, {'AUTO_RECHARGE_CALLBACK_URL': 'local-bitbrowser'}):
            page_ready = asyncio.Event()
            self.context.on('page', lambda _page: page_ready.set())
            task = asyncio.create_task(self.flow(wait_seconds=30))
            self.addAsyncCleanup(lambda: asyncio.gather(task, return_exceptions=True))
            await self.wait_stage(task, page_ready)
            page = self.context.pages[0]
            button = page.frame_locator('#challenge').get_by_role('button', name='本人完成合成验证')
            await button.wait_for(state='visible', timeout=30000)
            await button.click()
            result = await task
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['payment_evidence']['identifier'], 'pi_Synthetic')
        self.assertEqual(self.updates, 1)
        self.assertEqual(self.auth_counts, {'authenticate': 1, 'complete': 1, 'issuer': 1})
        self.assertFalse(self.other_writes)

    async def test_concurrent_update_reserves_before_async_preflight(self):
        self.double_update = True
        duplicate_blocked = asyncio.Event()
        original_route = UpgradeGuard.route
        async def tracked_route(guard, route):
            await original_route(guard, route)
            if guard.blocked_duplicates:
                duplicate_blocked.set()
        with patch.object(UpgradeGuard, 'route', tracked_route):
            task = asyncio.create_task(self.flow(wait_seconds=10))
            try:
                await self.wait_stage(task, self.preflight_started)
                await self.wait_stage(task, duplicate_blocked)
                self.assertEqual(self.updates, 0)
            finally:
                self.preflight_release.set()
                result = await task
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(self.updates, 1)
        record = json.loads(next((self.root / 'payments').glob('*.json')).read_text())
        self.assertEqual(record['confirmation_requests_sent'], 1)

    async def test_actual_run_flow_upgrades_once_with_official_proration_and_tier(self):
        result = await self.flow()
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(result['quote_authority'], 'official_upgrade_preview')
        self.assertEqual(result['quote']['today']['amount_minor'], 40000)
        self.assertEqual(result['current_tier'], 20)
        self.assertEqual(result['subscription_period']['end'], '2026-11-03T00:00:00.000Z')
        self.assertEqual(self.updates, 1)
        self.assertEqual(self.creates, 0)
        self.assertFalse(self.other_writes)
        record = json.loads(next((self.root / 'payments').glob('*.json')).read_text())
        self.assertEqual(record['confirmation_requests_sent'], 1)
        self.assertNotIn('checkout_identifier', record)
        self.assertNotIn('555555', json.dumps(record))
        self.assertNotIn('cvc', record)

    async def test_update_written_only_after_fsync_marker_and_never_after_cancel(self):
        import subscription_upgrade
        original = subscription_upgrade.atomic_json
        def persist(path, document):
            if document.get('confirmation_requests_sent') == 1 and not any(r['confirmation_requests_sent'] == 1 for r in self.records):
                self.assertEqual(self.updates, 0)
            original(path, document)
            self.records.append(document)
        with patch.object(subscription_upgrade, 'atomic_json', side_effect=persist):
            result = await self.flow()
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertTrue(any(r['confirmation_requests_sent'] == 0 for r in self.records))
        self.assertEqual(self.updates, 1)

    async def test_cancel_quote_change_missing_card_entry_wrong_plan_or_annual_cannot_update(self):
        for kind in ('cancel', 'changed_quote', 'missing_card_entry', 'wrong_request', 'annual'):
            self.changed_quote = self.missing_card_entry = self.wrong_request = self.annual = False
            self.preview_reads = 0
            if kind != 'cancel':
                setattr(self, kind, True)
            result = await self.flow(confirmer=lambda *_: kind != 'cancel')
            self.assertNotEqual(result['status'], 'subscription_activated', (kind, result))
            self.assertEqual(self.updates, 0, (kind, result))
            self.assertEqual(self.creates, 0)
            self.assertEqual(len(list((self.root / 'payments').glob('*.json'))), 1 if kind == 'wrong_request' else 0)
            for path in (self.root / 'payments').glob('*.json'):
                path.unlink()  # Only this test's temporary synthetic state.
            for page in self.context.pages:
                await page.close()

    async def test_existing_non_default_card_is_selected_without_changing_old_default(self):
        self.non_default_card = True
        result = await self.flow()
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(self.updates, 1)
        self.assertEqual(self.update_method_id, 'pm_Synthetic')
        self.assertEqual(self.creates, 0)
        self.assertFalse(self.other_writes)

    async def test_changed_card_uses_fresh_official_quote_before_unique_upgrade(self):
        self.non_default_card = self.card_reprices = True
        authorized = []
        result = await self.flow(confirmer=lambda quote, _last4: authorized.append(quote['today']['amount_minor']) or True)
        self.assertEqual(result['status'], 'subscription_activated', result)
        self.assertEqual(authorized, [41000])
        self.assertEqual(result['quote']['today']['amount_minor'], 41000)
        self.assertEqual(self.update_method_id, 'pm_Synthetic')
        self.assertEqual(self.updates, 1)
        self.assertFalse(self.other_writes)

    async def test_changed_card_quote_above_authorized_cap_never_updates(self):
        self.non_default_card = self.card_reprices = True
        observed = []
        def capped(quote, _last4):
            observed.append(quote['today']['amount_minor'])
            return quote['today']['amount_minor'] <= 40000
        result = await self.flow(confirmer=capped)
        self.assertEqual(result['status'], 'payment_cancelled', result)
        self.assertEqual(observed, [41000])
        self.assertEqual(self.updates, 0)
        self.assertFalse(list((self.root / 'payments').glob('*.json')))

    async def test_wrong_final_tier_is_paid_pending_not_success(self):
        self.final_plan = 'prolite'
        result = await self.flow()
        self.assertEqual(result['status'], 'paid_pending_activation', result)
        self.assertEqual(result['current_tier'], 5)
        self.assertNotIn('subscription_period', result)
        self.assertEqual(self.updates, 1)

    async def test_unknown_3ds_result_rechecks_original_only(self):
        self.response_mode = 'action'
        result = await self.flow()
        self.assertEqual(result['status'], 'verification_required', result)
        self.assertEqual(result['upgrade_payment_intent_identifier'], 'pi_Synthetic')
        self.assertEqual(self.updates, 1)
        self.response_mode, self.plan = 'paid', 'pro'
        recheck = await recheck_upgrade_in_context(self.context, self.target, self.root, 'pro-20x', result['upgrade_identifier'])
        self.assertEqual(recheck['status'], 'subscription_activated', recheck)
        self.assertEqual(recheck['payment_evidence']['kind'], 'invoice')
        self.assertEqual(recheck['payment_requests_sent'], 0)
        self.assertEqual(self.updates, 1)
        repeated = await self.flow()
        self.assertEqual(repeated['reason'], 'incompatible_existing_subscription')
        self.assertEqual(self.updates, 1)

    async def test_active_same_plan_or_unknown_account_never_upgrade(self):
        for plan in ('pro', 'go', 'team'):
            self.plan = plan
            result = await self.flow()
            self.assertEqual(result['reason'], 'incompatible_existing_subscription', result)
            self.assertEqual(self.updates, 0)
            self.assertEqual(self.creates, 0)


if __name__ == '__main__':
    unittest.main()
