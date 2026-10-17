"""Offline release boundaries. No database, cloud, payment or browser requests."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('unattended_release', HERE / 'online-unattended-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class UnattendedPublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((HERE / r.CONTRACT_FILE).read_bytes())

    def test_exact_published_predecessor_and_finite_module_set(self):
        r.validate_contract(self.contract)
        self.assertEqual(len(self.contract['apiModules']), 7)

    def test_unreviewed_source_or_runtime_module_cannot_enter(self):
        for path in ['apps/api/src/auth/auth.service.ts', 'apps/api/prisma-mysql/schema.prisma',
                     'apps/api/src/id-business-v2/online-recharge/unreviewed.ts', 'docs/unreviewed.md']:
            bad = copy.deepcopy(self.contract)
            bad['sources'][path] = 'a' * 64
            with self.assertRaises(RuntimeError):
                r.validate_contract(bad)
        bad = copy.deepcopy(self.contract)
        bad['apiModules'].append('auth/unreviewed.js')
        with self.assertRaises(RuntimeError):
            r.validate_contract(bad)

    def test_engine_deletion_or_unreviewed_addition_is_blocked(self):
        for kind in ['remove', 'add']:
            bad = copy.deepcopy(self.contract)
            if kind == 'remove':
                bad['afterEngineFiles'].pop('worker.cjs')
            else:
                bad['afterEngineFiles']['unreviewed.cjs'] = 'a' * 64
            with self.assertRaises(RuntimeError):
                r.validate_contract(bad)

    def test_wrong_baseline_missing_source_and_old_validation_reuse_are_blocked(self):
        for kind in ['baseline', 'source', 'reuse']:
            bad = copy.deepcopy(self.contract)
            if kind == 'baseline':
                bad['expectedCurrent'] = 'a' * 40
            if kind == 'source':
                bad['sources'].pop(next(iter(bad['sources'])))
            if kind == 'reuse':
                bad['validationReuse'] = {'runId': '123'}
            with self.assertRaises(RuntimeError):
                r.validate_contract(bad)

    def test_publisher_defaults_remain_unchanged(self):
        spec = importlib.util.spec_from_file_location('old', HERE / 'online-checkout-release.py')
        old = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(old)
        self.assertEqual(old.SCOPE, 'ONLINE_CHECKOUT_FORM_AND_VISIBILITY')
        self.assertEqual(old.CONTRACT_FILE, 'online-checkout-contract.json')


if __name__ == '__main__':
    unittest.main()
