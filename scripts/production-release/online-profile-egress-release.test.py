"""Offline publication boundaries; no production access or business actions."""
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('profile_egress_release', HERE / 'online-profile-egress-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProfileEgressReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        self.c['baselineAdminFilesSha256'] = p.sha(p.canonical({'index.html': 'd' * 64}))
        qa = {'source': {'head': p.SOURCE, 'tree': p.SOURCE_TREE, 'pullRequest': 713,
                        'runId': '123', 'sourceReceiptSha256': 'd' * 64},
              'control': {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 714,
                          'runId': '124', 'sourceReceiptSha256': 'e' * 64},
              'main': {'head': 'a' * 40, 'runId': '125'}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '126', 'workflowRunAttempt': '1',
            'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()),
            'controlSources': {**self.c['controlPins'], p.CONTRACT_FILE: p.sha((HERE / p.CONTRACT_FILE).read_bytes())},
            'qualitySourceEvidence': qa, 'nativeParentCapture': {'baseline': {},
                'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'businessActions': 0}}
        names = {n.removesuffix('.js') + ext for n in self.c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE, 'sources': self.c['sources'],
            'afterEngineFiles': self.c['afterEngineFiles'], 'baselineApiReproduced': True,
            'baselineAdminSourceReproduced': True, 'baselineAdminFiles': {'index.html': 'd' * 64},
            'adminFiles': {'index.html': 'e' * 64},
            'apiModules': {n: self.c['expectedApiFiles'][n] for n in names},
            'migrationPerformed': False, 'businessActions': 0}
        self.files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
            **{'api/modules/' + n: v for n, v in self.proof['apiModules'].items()},
            **{'admin/html/' + n: v for n, v in self.proof['adminFiles'].items()},
            **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof['files'] = self.files

    def test_exact_reviewed_source_and_payload(self):
        p.validate_contract(self.c)
        p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_rejects_different_account_instance_predecessor_and_business_actions(self):
        for key, value in [('awsTargetAccount', '000000000000'), ('awsTargetInstance', 'i-other'),
                           ('expectedCurrent', 'f' * 40), ('migrationPerformed', True), ('businessActions', 1)]:
            changed = copy.deepcopy(self.c)
            changed[key] = value
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_source_and_engine_drift_are_rejected(self):
        for field in ('sources', 'expectedApiFiles', 'beforeEngineFiles', 'afterEngineFiles'):
            changed = copy.deepcopy(self.c)
            changed[field][next(iter(changed[field]))] = 'f' * 64
            with self.assertRaises(RuntimeError):
                p.validate_contract(changed)

    def test_rejects_missing_or_mismatched_quality_receipt(self):
        for field in ('head', 'tree', 'sourceReceiptSha256'):
            changed = copy.deepcopy(self.proof)
            changed['qualitySourceEvidence']['source'][field] = 'invalid'
            with self.assertRaises(RuntimeError):
                p.verify_proof(changed, self.plan, self.c, self.files)

    def test_api_bytes_must_remain_identical_to_production(self):
        changed = copy.deepcopy(self.proof)
        changed['apiModules'][next(iter(changed['apiModules']))] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_API_REQUIRED'):
            p.verify_proof(changed, self.plan, self.c, self.files)

    def test_unknown_payload_and_path_escape_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            p.verify_proof(self.proof, self.plan, self.c, {**self.files, 'engine/unknown.cjs': 'd' * 64})
        changed = copy.deepcopy(self.proof)
        changed['adminFiles']['../outside'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_INVENTORY_CHANGED'):
            p.verify_proof(changed, self.plan, self.c, self.files)

    def test_requires_api_and_admin_source_reproduction(self):
        for field in ('baselineApiReproduced', 'baselineAdminSourceReproduced'):
            changed = copy.deepcopy(self.proof)
            changed[field] = False
            with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
                p.verify_proof(changed, self.plan, self.c, self.files)

    def test_uses_full_three_role_publisher_including_admin_start(self):
        core = p.core()
        source = inspect.getsource(core.release)
        self.assertEqual(core.UPDATED, ('api', 'admin', 'online-recharge'))
        self.assertEqual(core.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertIn("'up', '-d', '--no-deps', 'api', 'admin'", source)
        self.assertIn("'--force-recreate', 'online-recharge'", source)
        self.assertIn("plan['mode'] == 'readback'", source)
        self.assertNotIn('publish_pair(', source)

    def test_native_transport_keeps_single_acceptance_and_identity_checks(self):
        source = (HERE / 'online-profile-egress-publication.py').read_text()
        for expected in ('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN', 'NATIVE_RECEIPT_IDENTITY',
                         'AWS_MAX_ATTEMPTS', '098208446664', 'i-0838cebf64f0e2a89', 'NATIVE_ARTIFACT_CHANGED'):
            self.assertIn(expected, source)
        self.assertNotIn('def recover(', source)

    def test_builder_reproduces_current_overlay_before_new_source(self):
        source = (HERE / 'online-profile-egress-build.py').read_text()
        self.assertIn('PUBLISHED_PROXY_API_CHANGED', source)
        self.assertIn('PUBLISHED_PROXY_ADMIN_CHANGED', source)
        self.assertIn('PUBLISHED_API_NOT_REPRODUCED', source)
        self.assertIn('PUBLISHED_ADMIN_NOT_REPRODUCED', source)


if __name__ == '__main__':
    unittest.main()
