"""下一账期授权、旧组合和崩溃恢复的本地合成夹具。"""
import asyncio
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from attempt_ledger import AttemptLedger, assert_no_other_payment, atomic_json
import bitbrowser_connector as connector
from bitbrowser_retry import cancellable_flow
from checkout_core import Stop, parse_browser_credential
from payment_state import PaymentLedger, quote_digest
from plans import official_subscription
import pay
from subscription_cycle import (inspection_only_allowed, grant_valid, read_inspection,
                                closed_payment_allowed)
from subscription_upgrade import UpgradeLedger
from test_subscribe import fixture, account
from test_payment import create_marker, quote
from test_bitbrowser_connector import payload


def iso(seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class CycleFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'state'
        self.target = parse_browser_credential(fixture())
        create_marker(self.root, self.target)
        self.key = hashlib.sha256(self.target.account_id.encode()).hexdigest()
        with PaymentLedger(self.root, self.target.account_id) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4='4242')
            ledger.mark_confirmation_sent()
            ledger.update(payment_status='paid', evidence={'kind': 'checkout_session', 'identifier': 'cs_synthetic',
                'amount_minor': 9250, 'currency': 'MYR'}, current_plan='plus')
            self.payment_path, self.paid = ledger.path, dict(ledger.record)
        value = payload()
        value['subscriptionCycleProtocol'] = 1
        self.job = connector.LocalJob(value)
        self.job.root, self.job.account_key = self.root, self.key
        self.context = {'protocol': 1, 'jobId': self.job.id, 'accountKey': self.key, 'targetPlan': 'plus',
            'sources': [{'fileKey': str(self.payment_path.relative_to(self.root)), 'revision': 1,
                'operationIdentifier': 'cs_synthetic', 'documentDigest': 'd' * 64, 'targetPlan': 'plus'}]}
        self.job.accept_cycle_context(self.context)
        self.job.callback.send = Mock(return_value={'ok': True})
        self.grant = {'protocol': 1, 'jobId': self.job.id, 'accountKey': self.key, 'targetPlan': 'plus',
            'reviewDigest': 'c' * 64, 'expiresAt': iso(300), 'status': 'granted',
            'checkoutFileKey': self.key + '.json', 'checkoutRevision': 2, 'previousDocumentDigest': 'd' * 64}
        self.resolution = {'protocol': 1, 'status': 'closed', 'source_job_id': self.job.id,
            'account_key': self.key, 'target_plan': 'plus', 'review_digest': 'c' * 64,
            'closed_at': iso(), 'original_document_digest': 'd' * 64, 'manual_previous_cycle_ended': True}

    async def asyncTearDown(self):
        self.temp.cleanup()

    def close_records(self):
        atomic_json(self.payment_path, {**self.paid, 'cycle_resolution': self.resolution})
        checkout_path = self.root / (self.key + '.json')
        checkout = json.loads(checkout_path.read_bytes())
        atomic_json(checkout_path, {**checkout, 'cycle_resolution': self.resolution})

    def review(self, status='ready'):
        return {'protocol': 1, 'status': status, 'reviewDigest': 'c' * 64, 'expiresAt': iso(300)}

    def inspection(self, **updates):
        return {'source': 'official_account_response', 'account_key': self.key, 'account_matched': True,
            'current_plan': 'free', 'has_active_subscription': False, 'checked_at': iso(), **updates}

    def test_only_full_paid_records_under_protocol_context_can_open_inspection(self):
        self.assertTrue(inspection_only_allowed(self.job, self.target))
        self.job.payload.pop('subscriptionCycleProtocol')
        self.assertFalse(inspection_only_allowed(self.job, self.target))
        self.job.payload['subscriptionCycleProtocol'] = 1
        unknown = {**self.paid, 'payment_status': 'unknown', 'payment_evidence': None}
        atomic_json(self.payment_path, unknown)
        self.assertFalse(inspection_only_allowed(self.job, self.target))

    def test_unknown_other_plan_still_blocks_cycle(self):
        self.close_records()
        unknown = {**self.paid, 'target_plan': 'go', 'checkout_identifier': 'cs_other',
            'payment_status': 'unknown', 'payment_evidence': None}
        atomic_json(self.root / 'payments' / ('f' * 64 + '.json'), unknown)
        with self.assertRaises(Stop):
            assert_no_other_payment(self.root, self.target.account_id, next_cycle_grant=self.grant)
        self.assertFalse(inspection_only_allowed(self.job, self.target))

    def test_safe_zero_cancel_does_not_hide_unresolved_zero_submit_marker(self):
        extra = self.root / 'payments' / ('f' * 64 + '.json')
        safe = {**self.paid, 'checkout_identifier': 'cs_safecancel', 'cancelled_before_confirmation': True,
            'payment_status': 'cancelled', 'payment_evidence': None, 'confirmation_requests_sent': 0}
        atomic_json(extra, safe)
        self.assertTrue(inspection_only_allowed(self.job, self.target))
        atomic_json(extra, {**safe, 'payment_status': 'unknown', 'cancelled_before_confirmation': False})
        self.assertFalse(inspection_only_allowed(self.job, self.target))

    def test_local_closed_record_without_grant_never_allows_new_checkout(self):
        self.close_records()
        with self.assertRaises(Stop):
            with AttemptLedger(self.root, self.target.account_id):
                pass
        self.assertFalse(closed_payment_allowed({**self.paid, 'cycle_resolution': self.resolution}, None))

    def test_grant_marker_ack_and_crash_resume_cannot_create_twice(self):
        self.close_records()
        before = self.payment_path.read_bytes()
        written = []
        def acknowledge(path, document):
            self.assertEqual(document['next_cycle_grant']['jobId'], self.job.id)
            written.append(document)
            atomic_json(path, document)
        with patch('attempt_ledger.atomic_json', side_effect=acknowledge):
            with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
                ledger.begin()
                self.assertEqual(self.grant['status'], 'consumed')
                # Crash here: marker is known, returned checkout identifier is not.
        self.assertEqual(len(written), 1)
        self.assertEqual(before, self.payment_path.read_bytes())
        with self.assertRaises(Stop):
            with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant):
                pass
        self.assertTrue(self.paid['payment_evidence'])

    def test_failed_marker_ack_does_not_grant_external_create(self):
        self.close_records()
        original = (self.root / (self.key + '.json')).read_bytes()
        with patch('attempt_ledger.atomic_json', side_effect=Stop('durable_state_unavailable')):
            with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
                with self.assertRaises(Stop):
                    ledger.begin()
                self.assertIsNone(ledger.record)
        self.assertEqual(self.grant['status'], 'granted')
        self.assertEqual(original, (self.root / (self.key + '.json')).read_bytes())

    def test_marker_replayed_ack_stops_before_another_create(self):
        self.close_records()
        self.job.next_cycle_grant = self.grant
        self.job.callback.send = Mock(return_value={'revision': 3, 'replayed': True})
        def durable(path, document):
            self.job.persist(path, document)
            atomic_json(path, document)
        with patch('attempt_ledger.atomic_json', side_effect=durable):
            with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
                with self.assertRaises(Stop) as stopped:
                    ledger.begin()
                self.assertIsNone(ledger.record)
        self.assertEqual(stopped.exception.report['reason'], 'checkout_result_unknown')
        self.assertEqual(self.grant['status'], 'consumed')
        self.assertEqual(self.job.callback.send.call_count, 1)

    async def test_restore_consumed_unknown_marker_never_enters_new_create(self):
        self.close_records()
        with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
            ledger.begin()
        self.job.accept_cycle_context({**self.context, 'grant': self.grant})
        self.assertFalse(inspection_only_allowed(self.job, self.target))
        with patch('pay.run_browser', AsyncMock(return_value={'status': 'payment_result_unknown'})) as run:
            await pay.run_checkout_flow(self.target, self.root, 'plus', details_reader=self.job.details,
                confirmer=self.job.confirm, next_cycle_grant=self.grant, allow_checkout_replacement=False)
        self.assertTrue(run.await_args.kwargs['inspect_existing'])
        self.assertNotIn('create', run.await_args.kwargs)

    def test_unknown_new_cycle_recheck_has_no_grant_and_cannot_send_payment(self):
        self.close_records()
        with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
            ledger.begin()
            ledger.finish({'checkout_identifier': 'cs_nextcycle', 'processor_entity': 'openai_ie', 'returned_currency': 'MYR'})
        with PaymentLedger(self.root, self.target.account_id, next_cycle_grant=self.grant) as ledger:
            ledger.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4='4242')
            ledger.mark_confirmation_sent()
        with PaymentLedger(self.root, self.target.account_id, read_only=True) as ledger:
            self.assertEqual(ledger.checkout_id, 'cs_nextcycle')
            self.assertEqual(ledger.record['payment_status'], 'unknown')
            with self.assertRaises(Stop):
                ledger.assert_unattempted()
            with self.assertRaises(Stop):
                ledger.mark_confirmation_sent()
        self.assertEqual(json.loads(self.payment_path.read_bytes())['payment_evidence'], self.paid['payment_evidence'])

    def test_expired_unused_grant_restore_can_reinspect_but_cannot_create(self):
        self.close_records()
        expired = {**self.grant, 'expiresAt': iso(-1)}
        self.job.accept_cycle_context({**self.context, 'grant': expired})
        self.assertTrue(inspection_only_allowed(self.job, self.target))
        with self.assertRaises(Stop):
            with AttemptLedger(self.root, self.target.account_id, next_cycle_grant=expired):
                pass

    def test_later_legal_upgrade_reads_api_attested_closed_history(self):
        self.close_records()
        context = {**self.context, 'targetPlan': 'pro-20x'}
        with UpgradeLedger(self.root, self.target.account_id, 'pro-20x', cycle_context=context) as ledger:
            self.assertIsNone(ledger.record)
        bad = {**self.paid, 'payment_status': 'unknown', 'payment_evidence': None, 'cycle_resolution': self.resolution}
        atomic_json(self.payment_path, bad)
        with self.assertRaises(Stop):
            with UpgradeLedger(self.root, self.target.account_id, 'pro-20x', cycle_context=context):
                pass

    def test_foreign_or_expired_grant_never_creates(self):
        self.close_records()
        for change in ({'accountKey': 'f' * 64}, {'targetPlan': 'go'}, {'expiresAt': iso(-1)}, {'status': 'consumed'}):
            with self.subTest(change=change), self.assertRaises(Stop):
                with AttemptLedger(self.root, self.target.account_id, next_cycle_grant={**self.grant, **change}):
                    pass

    async def test_api_commit_reconciles_records_before_new_checkout(self):
        self.job.revisions[self.key + '.json'] = 1
        closed = {**json.loads((self.root / (self.key + '.json')).read_bytes()), 'cycle_resolution': self.resolution}
        def callback(body, **_options):
            if body.get('phase') == 'inspect':
                return {'cycleReview': self.review()}
            if body.get('phase') == 'commit':
                return {'cycleReview': self.review(), 'nextCycleContext': {**self.context, 'grant': self.grant},
                    'records': [{'fileKey': self.key + '.json', 'revision': 2, 'document': closed},
                        {'fileKey': str(self.payment_path.relative_to(self.root)), 'revision': 2,
                         'document': {**self.paid, 'cycle_resolution': self.resolution}}]}
            return {'ok': True}
        self.job.callback.send = Mock(side_effect=callback)
        with patch('subscription_cycle.read_inspection', AsyncMock(side_effect=[self.inspection(), self.inspection()])) as read:
            received = await self.job.prepare_next_subscription_cycle(object(), self.target)
        self.assertEqual(received, self.grant)
        self.assertEqual(read.await_count, 2)
        self.assertEqual(self.job.revisions[self.key + '.json'], 2)
        self.assertEqual(json.loads(self.payment_path.read_bytes())['payment_evidence'], self.paid['payment_evidence'])
        self.assertIsNone(self.job.original_checkout_identifier)

    async def test_manual_ready_still_requires_fresh_official_inspection(self):
        def callback(body, **_options):
            if body.get('phase') == 'inspect':
                return {'cycleReview': self.review('awaiting_previous_cycle_confirmation')}
            if body.get('phase') == 'status':
                return {'cycleReview': self.review()}
            if body.get('phase') == 'commit':
                return {'cycleReview': self.review('revoked')}
            return {'ok': True}
        self.job.callback.send = Mock(side_effect=callback)
        with patch('subscription_cycle.read_inspection', AsyncMock(side_effect=[self.inspection(),
                self.inspection(current_plan='plus', has_active_subscription=True)])) as read:
            with self.assertRaises(Stop):
                await self.job.prepare_next_subscription_cycle(object(), self.target)
        self.assertEqual(read.await_count, 2)
        self.assertIsNone(self.job.next_cycle_grant)
        self.assertFalse(self.job.waiting_for_user)

    async def test_future_period_cannot_be_replaced_by_manual_or_older_source_period(self):
        future = {'source': 'official_subscription_response', 'account_key': self.key, 'target_plan': 'plus',
            'start': iso(-30 * 86400), 'end': iso(86400)}
        past = {**future, 'start': iso(-31 * 86400), 'end': iso(-86400)}
        for source_period, fresh_period in ((past, future), (future, past)):
            with self.subTest(source_period=source_period):
                self.context['sources'][0]['subscriptionPeriod'] = source_period
                self.job.callback.send = Mock(return_value={'cycleReview': self.review('awaiting_previous_cycle_confirmation')})
                with patch('subscription_cycle.read_inspection', AsyncMock(return_value=self.inspection(previous_period=fresh_period))):
                    with self.assertRaises(Stop):
                        await self.job.prepare_next_subscription_cycle(object(), self.target)
                self.job.callback.send.assert_not_called()

    async def test_expired_manual_review_has_no_commit_or_grant(self):
        self.job.callback.send = Mock(side_effect=lambda body: {'cycleReview': {**self.review('awaiting_previous_cycle_confirmation'),
            'expiresAt': iso(-1)}} if body.get('phase') else {'ok': True})
        with patch('subscription_cycle.read_inspection', AsyncMock(return_value=self.inspection())):
            with self.assertRaises(Stop):
                await self.job.prepare_next_subscription_cycle(object(), self.target)
        self.assertFalse(any(call.args[0].get('phase') == 'commit' for call in self.job.callback.send.call_args_list))

    async def test_cancel_during_manual_review_never_fills_or_creates(self):
        previous = self.payment_path.read_bytes()
        def callback(body, **_options):
            if body.get('phase') == 'inspect':
                return {'cycleReview': self.review('awaiting_previous_cycle_confirmation')}
            if body.get('result', {}).get('stage') == 'next_subscription_cycle_review':
                self.job.cancelled = True
            return {'ok': True}
        self.job.callback.send = Mock(side_effect=callback)
        async def browser(target, **options):
            return await options['session_handler'](SimpleNamespace(context=object()), object(),
                {'current_plan': 'free', 'account_matched': True, 'has_active_subscription': False})
        self.job.subscription_check_only = True
        with (patch('pay.run_browser', side_effect=browser), patch('pay.run_checkout_flow', AsyncMock()) as checkout,
                patch.object(self.job, 'details', Mock()) as details,
                patch('subscription_cycle.read_inspection', AsyncMock(return_value=self.inspection()))):
            with self.assertRaises(Stop):
                await cancellable_flow(self.job, self.target, details_reader=self.job.details, confirmer=self.job.confirm)
        checkout.assert_not_awaited()
        details.assert_not_called()
        self.assertEqual(previous, self.payment_path.read_bytes())
        self.assertIsNone(self.job.next_cycle_grant)
        self.assertFalse(self.job.payment_request_sent)
        self.assertFalse(any(call.args[0].get('phase') == 'commit' for call in self.job.callback.send.call_args_list))

    def test_unused_grant_cancel_finished_has_no_old_payment_claim(self):
        self.close_records()
        previous = self.payment_path.read_bytes()
        self.job.next_cycle_grant = self.grant
        self.job.cancelled = True
        self.job.execute = AsyncMock(return_value={'status': 'cancelled', 'reason': 'operation_cancelled',
            'cancellation_confirmed': True, 'checkout_requests_sent': 0})
        self.job.callback.send = Mock(return_value={'ok': True})
        self.job.run()
        finished = [call.args[0] for call in self.job.callback.send.call_args_list if call.args[0].get('type') == 'finished']
        self.assertEqual(len(finished), 1)
        self.assertTrue(self.job.callback.url.endswith('/' + self.job.id))
        self.assertFalse(finished[0]['result']['payment_attempted'])
        self.assertEqual(finished[0]['result']['payment_requests_sent'], 0)
        self.assertNotIn('payment_evidence', finished[0]['result'])
        self.assertNotEqual(finished[0]['result'].get('payment_status'), 'paid')
        self.assertEqual(previous, self.payment_path.read_bytes())

    async def test_inspection_mode_never_uses_old_checkout_shortcut(self):
        self.job.subscription_check_only = True
        self.job.payload['plan'] = 'plus'
        with (patch('pay.run_flow', AsyncMock(return_value={'status': 'already_subscribed'})) as flow,
                patch('pay.run_checkout_flow', AsyncMock()) as checkout):
            await cancellable_flow(self.job, self.target, expected_checkout_identifier='cs_synthetic')
        checkout.assert_not_awaited()
        self.assertTrue(flow.await_args.kwargs['subscription_check_only'])

    async def test_active_legal_upgrade_does_not_request_cycle_grant(self):
        async def run_browser(target, **options):
            return await options['session_handler'](SimpleNamespace(context=object()), object(),
                {'current_plan': 'go', 'account_matched': True, 'has_active_subscription': True})
        with (patch('pay.run_browser', side_effect=run_browser),
                patch('subscription_upgrade.run_upgrade_in_context', AsyncMock(return_value={'status': 'paid_pending_activation'})) as upgrade):
            result = await pay.run_flow(self.target, self.root, 'plus', details_reader=self.job.details,
                confirmer=self.job.confirm, subscription_check_only=True)
        self.assertEqual(result['status'], 'paid_pending_activation')
        upgrade.assert_awaited_once()
        self.assertFalse(any(call.args[0].get('type') == 'prepare_next_subscription_cycle' for call in self.job.callback.send.call_args_list))

    async def test_missing_active_flag_cannot_create_new_cycle(self):
        async def run_browser(target, **options):
            return await options['session_handler'](SimpleNamespace(context=object()), object(),
                {'current_plan': 'free', 'account_matched': True, 'has_active_subscription': None})
        with patch('pay.run_browser', side_effect=run_browser), patch('pay.run_checkout_flow', AsyncMock()) as checkout:
            with self.assertRaises(Stop):
                await pay.run_flow(self.target, self.root, 'plus', details_reader=self.job.details,
                    confirmer=self.job.confirm, subscription_check_only=True)
        checkout.assert_not_awaited()

    def test_restore_protocol_is_opt_in_and_reconcile_does_not_repeat_exclusive_restore(self):
        current = self.root / (self.key + '.json')
        records = [{'fileKey': current.name, 'revision': 3,
            'document': {**json.loads(current.read_bytes()), 'cycle_resolution': self.resolution}}]
        self.job.reconcile_cycle_records(records)
        self.job.reconcile_cycle_records(records)
        self.assertEqual(self.job.revisions[current.name], 3)
        self.assertEqual(json.loads(current.read_bytes())['cycle_resolution'], self.resolution)
        with self.assertRaises(Stop):
            self.job.reconcile_cycle_records([{**records[0], 'fileKey': '../outside.json'}])


class InspectionTests(unittest.IsolatedAsyncioTestCase):
    def test_entitlement_false_is_explicit_and_missing_remains_unknown(self):
        target = parse_browser_credential(fixture())
        raw = account('free')
        node = raw['accounts'][target.account_id]
        self.assertIsNone(official_subscription(raw, target.account_id)['has_active_subscription'])
        node['entitlement'] = {'has_active_subscription': False}
        self.assertIs(official_subscription(raw, target.account_id)['has_active_subscription'], False)
        node['entitlement']['has_active_subscription'] = 0
        self.assertIsNone(official_subscription(raw, target.account_id)['has_active_subscription'])

    async def test_period_is_bound_to_source_plan_and_account_before_and_after(self):
        target = parse_browser_credential(fixture())
        key = hashlib.sha256(target.account_id.encode()).hexdigest()
        context = {'accountKey': key, 'targetPlan': 'plus', 'sources': [{'targetPlan': 'go'}]}
        identity = {'current_plan': 'free', 'account_matched': True, 'has_active_subscription': False}
        data = {'account_id': target.account_id, 'plan_type': 'go', 'active_start': iso(-31 * 86400), 'active_until': iso(-86400)}
        with (patch('browser_checkout.check_session', AsyncMock(return_value=(target, identity))),
                patch('browser_checkout.browser_read', AsyncMock(return_value=data))):
            observed = await read_inspection(object(), target, context)
        self.assertEqual(observed['previous_period']['target_plan'], 'go')
        self.assertEqual(observed['previous_period']['account_key'], key)
        changed = {**identity, 'has_active_subscription': True}
        with (patch('browser_checkout.check_session', AsyncMock(side_effect=[(target, identity), (target, changed)])),
                patch('browser_checkout.browser_read', AsyncMock(return_value=data)), self.assertRaises(Stop)):
            await read_inspection(object(), target, context)

    async def test_fresh_future_end_never_falls_back_to_old_expired_period(self):
        target = parse_browser_credential(fixture())
        key = hashlib.sha256(target.account_id.encode()).hexdigest()
        context = {'accountKey': key, 'targetPlan': 'plus', 'sources': [{'targetPlan': 'plus', 'subscriptionPeriod': {
            'source': 'official_subscription_response', 'account_key': key, 'target_plan': 'plus',
            'start': iso(-31 * 86400), 'end': iso(-86400)}}]}
        identity = {'current_plan': 'free', 'account_matched': True, 'has_active_subscription': False}
        for returned_account in (target.account_id, None):
            data = {'account_id': returned_account, 'plan_type': 'plus', 'active_start': iso(-20 * 86400), 'active_until': iso(86400)}
            with (patch('browser_checkout.check_session', AsyncMock(return_value=(target, identity))),
                    patch('browser_checkout.browser_read', AsyncMock(return_value=data)), self.assertRaises(Stop)):
                await read_inspection(object(), target, context)

    def test_payload_rejects_protocol_on_old_modes_and_wrong_versions(self):
        base = payload()
        self.assertEqual(connector.validate_payload({**base, 'subscriptionCycleProtocol': 1})['subscriptionCycleProtocol'], 1)
        for protocol in (True, 2, '1'):
            with self.assertRaises(Stop):
                connector.validate_payload({**base, 'subscriptionCycleProtocol': protocol})


class CycleBrowserIntegration(unittest.IsolatedAsyncioTestCase):
    async def test_cycle_commit_marker_create_quote_and_payment_use_one_new_order(self):
        from test_payment import PaymentBrowserTests, details
        from urllib.parse import urlsplit
        harness = PaymentBrowserTests('test_one_payment_success_and_double_submit_blocked')
        await harness.asyncSetUp()
        try:
            target, root = harness.target, harness.root
            key = hashlib.sha256(target.account_id.encode()).hexdigest()
            with PaymentLedger(root, target.account_id) as old:
                old.begin(quote(), confirmed_digest=quote_digest(quote()), card_last4='4242')
                old.mark_confirmation_sent()
                old.update(payment_status='paid', evidence={'kind': 'checkout_session', 'identifier': 'cs_synthetic',
                    'amount_minor': 9250, 'currency': 'MYR'}, current_plan='plus')
                old_path, old_document = old.path, dict(old.record)
            job = connector.LocalJob({**payload(), 'subscriptionCycleProtocol': 1})
            job.root, job.account_key = root, key
            context = {'protocol': 1, 'jobId': job.id, 'accountKey': key, 'targetPlan': 'plus', 'sources': [{
                'fileKey': str(old_path.relative_to(root)), 'revision': 1, 'operationIdentifier': 'cs_synthetic',
                'documentDigest': 'd' * 64, 'targetPlan': 'plus'}]}
            job.accept_cycle_context(context)
            grant = {'protocol': 1, 'jobId': job.id, 'accountKey': key, 'targetPlan': 'plus', 'reviewDigest': 'c' * 64,
                'expiresAt': iso(300), 'status': 'granted', 'checkoutFileKey': key + '.json', 'checkoutRevision': 2}
            closure = {'protocol': 1, 'status': 'closed', 'source_job_id': job.id, 'account_key': key,
                'target_plan': 'plus', 'review_digest': 'c' * 64, 'closed_at': iso(), 'original_document_digest': 'd' * 64}
            review = {'protocol': 1, 'status': 'ready', 'reviewDigest': 'c' * 64, 'expiresAt': grant['expiresAt']}
            events, revisions = [], {}
            def callback(body, **_options):
                if body.get('phase') == 'inspect':
                    events.append('inspect')
                    return {'cycleReview': review}
                if body.get('phase') == 'commit':
                    events.append('commit')
                    self.assertIs(body['subscription_inspection']['has_active_subscription'], False)
                    checkout = json.loads((root / (key + '.json')).read_bytes())
                    archived = hashlib.sha256(json.dumps(checkout, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                    return {'cycleReview': review, 'nextCycleContext': {**context, 'grant': grant}, 'records': [
                        {'fileKey': key + '.json', 'revision': 2, 'document': {**checkout, 'cycle_resolution': closure}},
                        {'fileKey': str(old_path.relative_to(root)), 'revision': 2, 'document': {**old_document, 'cycle_resolution': closure}},
                        {'fileKey': 'history/' + archived + '.json', 'revision': 1, 'document': checkout}]}
                if body.get('type') == 'ledger':
                    if body['document'].get('next_cycle_grant'):
                        self.assertEqual(events, ['inspect', 'commit'])
                        self.assertEqual(body['revision'], 2)
                        events.append('marker_ack')
                    self.assertNotIn('cycle_resolution', body['document'])
                    self.assertNotIn('cycle_origin', body['document'])
                    revisions[body['fileKey']] = body['revision'] + 1
                    return {'revision': revisions[body['fileKey']]}
                return {'ok': True}
            job.callback.send = Mock(side_effect=callback)
            await harness.context.unroute('**/*', harness.server)
            async def server(route):
                path = urlsplit(route.request.url).path
                if path.startswith('/backend-api/accounts/'):
                    value = account('plus' if harness.confirmations else 'free')
                    value['accounts'][target.account_id]['entitlement'] = {'has_active_subscription': bool(harness.confirmations)}
                    return await route.fulfill(json=value)
                if path == '/backend-api/subscriptions':
                    return await route.fulfill(json={'account_id': target.account_id, 'plan_type': 'plus',
                        'active_start': iso(-31 * 86400), 'active_until': iso(-86400)})
                if path == '/backend-api/payments/checkout':
                    self.assertIn('marker_ack', events)
                    events.append('external_create')
                    harness.new_checkouts += 1
                    return await route.fulfill(json={'checkout_session_id': 'cs_nextcycle', 'processor_entity': 'openai_ie',
                        'billing_details': {'country': 'US', 'currency': 'MYR'}})
                if path == '/v1/payment_pages/cs_nextcycle/confirm':
                    harness.confirmations += 1
                    records = [json.loads(path.read_bytes()) for path in (root / 'payments').glob('*.json')]
                    current = next(record for record in records if record.get('checkout_identifier') == 'cs_nextcycle')
                    self.assertEqual(current['confirmation_requests_sent'], 1)
                    return await route.fulfill(json={'id': 'cs_nextcycle', 'object': 'checkout.session', 'status': 'complete',
                        'payment_status': 'paid', 'amount_total': 9250, 'currency': 'myr'},
                        headers={'Access-Control-Allow-Origin': '*'})
                async def fulfill(**values):
                    if 'json' in values:
                        values['json'] = json.loads(json.dumps(values['json']).replace('cs_synthetic', 'cs_nextcycle'))
                    if 'body' in values:
                        values['body'] = values['body'].replace('cs_synthetic', 'cs_nextcycle')
                    await route.fulfill(**values)
                await harness.server(SimpleNamespace(request=SimpleNamespace(url=route.request.url.replace('cs_nextcycle', 'cs_synthetic')),
                    fulfill=fulfill, abort=route.abort))
            await harness.context.route('**/*', server)
            class Controller:
                cancelled = False
                def details(self, _quote):
                    return details()
                def confirm(self, _quote, _last4):
                    return True
                async def prepare_next_subscription_cycle(self, page, target):
                    return await job.prepare_next_subscription_cycle(page, target)
            controller = Controller()
            async def select(page, _plan):
                async def click():
                    await page.evaluate('''async token => await (await fetch('/backend-api/payments/checkout', {
                        method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
                        body:JSON.stringify({plan_name:'chatgptplusplan'})})).json()''', target.old_token)
                    await asyncio.sleep(.01)
                    await page.goto('https://chatgpt.com/checkout/openai_ie/cs_nextcycle', wait_until='domcontentloaded')
                return SimpleNamespace(click=click)
            def durable(path, document):
                job.persist(path, document)
                atomic_json(path, document)
            with (patch('browser_checkout.select_plan', side_effect=select), patch('browser_checkout.verify_selected_plan', AsyncMock()),
                    patch('attempt_ledger.atomic_json', side_effect=durable), patch('payment_state.atomic_json', side_effect=durable)):
                result = await pay.run_flow(target, root, 'plus', details_reader=controller.details, confirmer=controller.confirm,
                    browser_context=harness.context, subscription_check_only=True, allow_checkout_replacement=False,
                    wait_seconds=.3, poll_count=2, poll_interval=.01)
            self.assertEqual(result['status'], 'subscription_activated', result)
            self.assertEqual(result['checkout_identifier'], 'cs_nextcycle')
            self.assertEqual(result['payment_evidence']['identifier'], 'cs_nextcycle')
            self.assertEqual(harness.new_checkouts, 1)
            self.assertEqual(harness.confirmations, 1)
            self.assertEqual(events, ['inspect', 'commit', 'marker_ack', 'external_create'])
            self.assertEqual(json.loads(old_path.read_bytes())['payment_evidence'], old_document['payment_evidence'])
            self.assertTrue(list((root / 'history').glob('*.json')))
        finally:
            await harness.asyncTearDown()


if __name__ == '__main__':
    unittest.main()
