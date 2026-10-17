"""Offline finite repair contract tests. Never contact a database or payment service."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retest_release',HERE/'online-checkout-retest-release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RetestPublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract=json.loads((HERE/r.CONTRACT_FILE).read_bytes())
    def test_exact_predecessor_and_single_api_module(self):
        r.validate_contract(self.contract)
        self.assertEqual(len(self.contract['sources']),24)
        self.assertEqual(len(self.contract['beforeEngineFiles']),88)
    def test_unreviewed_scope_cannot_enter_artifact(self):
        for name in ['apps/api/src/auth/auth.service.ts','apps/api/src/id-business-v2/online-recharge/unreviewed.ts','apps/api/prisma-mysql/schema.prisma','package-lock.json','docs/unreviewed.md']:
            c=copy.deepcopy(self.contract);c['sources'][name]='a'*64
            with self.assertRaises(RuntimeError):r.validate_contract(c)
    def test_wrong_baseline_missing_source_or_engine_deletion_stops(self):
        for kind in ['baseline','source','engine','module']:
            c=copy.deepcopy(self.contract)
            if kind=='baseline':c['expectedCurrent']='a'*40
            if kind=='source':c['sources'].pop(next(iter(c['sources'])))
            if kind=='engine':c['afterEngineFiles'].pop('worker.cjs')
            if kind=='module':c['apiModules'].append('auth/auth.service.js')
            with self.assertRaises(RuntimeError):r.validate_contract(c)
    def test_default_publisher_contract_stays_backward_compatible(self):
        spec=importlib.util.spec_from_file_location('original',HERE/'online-checkout-release.py');old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
        self.assertEqual(old.CONTRACT_FILE,'online-checkout-contract.json')
        self.assertEqual(old.SCOPE,'ONLINE_CHECKOUT_FORM_AND_VISIBILITY')
if __name__=='__main__':unittest.main()
