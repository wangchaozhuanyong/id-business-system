"""Offline bounds for the engine-only display authorization publication."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('display_release', HERE / 'online-browser-display-auth-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((HERE / 'online-checkout-contract.json').read_bytes())
        self.plan = {'mode': 'preflight', 'commit': 'a' * 40, 'tree': 'b' * 40,
            'contractSha256': 'c' * 64, 'basePlan': {'commit': 'c8ce1a01a1a1e61bcc8de778dad331191319d645', 'contractSha256': 'c' * 64},
            'sources': {release.ENGINE + '/' + name: 'd' * 64 for name in release.FILES}}

    def test_exact_sidecar_three_file_scope_preserves_all_other_roles(self):
        before, after = release.validate_plan(self.plan, self.contract)
        self.assertEqual(len(after), 88)
        self.assertEqual({n for n in after if before[n] != after[n]}, set(release.FILES))
        self.assertEqual(set(release.PRESERVED), {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'})

    def test_unknown_sources_predecessor_and_invalid_identity_fail_closed(self):
        for changed in ('source', 'missing', 'predecessor', 'commit', 'mode'):
            plan = copy.deepcopy(self.plan)
            if changed == 'source': plan['sources'][release.ENGINE + '/../other.cjs'] = 'e' * 64
            if changed == 'missing': plan['sources'].pop(release.ENGINE + '/worker.cjs')
            if changed == 'predecessor': plan['basePlan']['commit'] = 'f' * 40
            if changed == 'commit': plan['commit'] = '../wrong'
            if changed == 'mode': plan['mode'] = 'retry-payment'
            with self.assertRaises(RuntimeError): release.validate_plan(plan, self.contract)

    def test_noop_runtime_cannot_be_republished_as_a_repair(self):
        plan = copy.deepcopy(self.plan)
        plan['sources'][release.ENGINE + '/worker.cjs'] = self.contract['afterEngineFiles']['worker.cjs']
        with self.assertRaises(RuntimeError): release.validate_plan(plan, self.contract)

if __name__ == '__main__':
    unittest.main()
