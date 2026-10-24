"""Offline contract and artifact boundary tests; never contact production."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('checkout_resume', HERE / 'online-checkout-resume-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ResumeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                     'workflowRunAttempt': '1', 'contractSha256': 'c' * 64, 'controlSources': {},
                     'nativeParentCapture': {'baseline': {}}}
        self.c['baselineAdminFilesSha256'] = p.load('recharge-record-release.py').fingerprint({'index.html': 'd' * 64})
        modules = {n.removesuffix('.js') + e: 'e' * 64 for n in self.c['apiModules'] for e in ('.js', '.js.map', '.d.ts')}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE, 'sources': self.c['sources'],
                      'afterEngineFiles': self.c['afterEngineFiles'], 'baselineApiReproduced': True,
                      'baselineAdminPreserved': True, 'baselineAdminFiles': {'index.html': 'd' * 64},
                      'adminFiles': {'index.html': 'd' * 64}, 'apiModules': modules,
                      'migrationPerformed': False, 'businessActions': 0}
        self.files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
                      **{'api/modules/' + n: v for n, v in modules.items()},
                      **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof['files'] = self.files

    def test_valid_exact_pair(self):
        p.validate_contract(self.c)
        p.verify_proof(self.proof, self.plan, self.c, self.files)
        self.assertEqual(p.UPDATED, ('api', 'online-recharge'))
        self.assertIn('admin', p.PRESERVED)

    def test_admin_update_rejected(self):
        self.c['updatedServices'].append('admin')
        with self.assertRaisesRegex(RuntimeError, 'SIDE_EFFECT_SCOPE'):
            p.validate_contract(self.c)

    def test_old_account_rejected(self):
        self.c['awsTargetAccount'] = '079740175286'
        with self.assertRaisesRegex(RuntimeError, 'SIDE_EFFECT_SCOPE'):
            p.validate_contract(self.c)

    def test_unreviewed_engine_change_rejected(self):
        self.c['afterEngineFiles']['unreviewed.js'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_DELTA'):
            p.validate_contract(self.c)

    def test_extra_runtime_module_rejected(self):
        self.proof['apiModules']['id-business-v2/orders.js'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'API_MODULE_SCOPE_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_unpublished_admin_payload_rejected(self):
        self.files['admin/html/index.html'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_admin_inventory_drift_rejected(self):
        self.proof['adminFiles'] = {'index.html': 'f' * 64}
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_ADMIN_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_unreproduced_api_rejected(self):
        self.proof['baselineApiReproduced'] = False
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_maintenance_sql_fence_pin_retained(self):
        self.assertEqual(self.c['sqlFenceHelperSha256'], self.c['controlPins']['api-admin-scope.py'])

    def test_failure_does_not_expose_arbitrary_exception_text(self):
        report = p.failure_report(RuntimeError('Authorization: secret'), {'mode': 'parent', 'controlSources': {}})
        self.assertEqual(report['code'], 'ONLINE_CHECKOUT_REMOTE_FAILED')
        self.assertNotIn('secret', json.dumps(report))

    def test_native_parent_capture_is_required(self):
        self.proof['nativeParentCapture'] = {'different': True}
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_missing_new_module_rejected(self):
        self.proof['apiModules'].pop('id-business-v2/online-recharge/checkout-preparation.js')
        with self.assertRaisesRegex(RuntimeError, 'API_MODULE_SCOPE_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, self.files)


if __name__ == '__main__':
    unittest.main()
