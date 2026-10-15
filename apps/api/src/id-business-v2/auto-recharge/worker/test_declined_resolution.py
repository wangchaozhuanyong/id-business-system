import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
import hashlib
from attempt_ledger import (declined_payment_resolved, declined_checkout_resolved,
    assert_no_other_payment, resolved_checkout_replacement_allowed)
from subscription_cycle import resolved_without_bank_request
from checkout_core import Stop


class DeclinedResolutionTests(unittest.TestCase):
    def setUp(self):
        self.marker = {'operator_resolution': 'confirmed_declined_no_charge', 'resolved_at': '2026-10-15T10:00:00Z',
            'resolution_job_id': '33333333-3333-4333-8333-333333333333',
            'source_job_id': '11111111-1111-4111-8111-111111111111',
            'verification_job_id': '22222222-2222-4222-8222-222222222222'}
        self.payment = {**self.marker, 'payment_status': 'declined', 'payment_attempted': True,
            'confirmation_requests_sent': 1, 'target_plan': 'plus', 'checkout_identifier': 'cs_original'}

    def test_full_server_marker_preserves_decline_and_allows_only_resolved_checkout_replacement(self):
        self.assertTrue(declined_payment_resolved(self.payment))
        self.assertTrue(resolved_without_bank_request(self.payment))
        checkout = {**self.marker, 'payment_status': 'not_attempted', 'confirmation_requests_sent': 0,
                    'checkout_identifier': 'cs_original'}
        self.assertTrue(declined_checkout_resolved(checkout))
        self.assertTrue(resolved_checkout_replacement_allowed(checkout))
        self.assertFalse(declined_checkout_resolved({**checkout, 'payment_attempted': True}))

    def test_unknown_action_required_or_paid_can_never_use_decline_resolution(self):
        for status in ('unknown', 'requires_action', 'paid'):
            self.assertFalse(declined_payment_resolved({**self.payment, 'payment_status': status}))
        for field in self.marker:
            value = copy.deepcopy(self.payment); value.pop(field)
            self.assertFalse(declined_payment_resolved(value))
        self.assertFalse(declined_payment_resolved({**self.payment, 'payment_evidence': {'identifier': 'paid'}}))

    def test_account_guard_skips_only_explicitly_resolved_decline_and_keeps_other_unknown_payment(self):
        account = 'synthetic-account'; key = hashlib.sha256(account.encode()).hexdigest()
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as folder:
            root = Path(folder); payments = root / 'payments'; payments.mkdir()
            first = payments / 'declined.json'; first.write_text(json.dumps({**self.payment, 'account_key': key}))
            assert_no_other_payment(root, account)
            (payments / 'unknown.json').write_text(json.dumps({**self.payment, 'account_key': key,
                'operator_resolution': None, 'payment_status': 'unknown', 'checkout_identifier': 'cs_other'}))
            with self.assertRaises(Stop): assert_no_other_payment(root, account)


if __name__ == '__main__':
    unittest.main()
