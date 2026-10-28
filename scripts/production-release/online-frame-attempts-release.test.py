"""Offline finite publication checks; no network, Docker, database or business tasks."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('frame_release', HERE / 'online-frame-attempts-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class FrameAttemptsPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        self.qa = {'source': {'head': P.SOURCE, 'tree': P.SOURCE_TREE, 'pullRequest': P.SOURCE_PR,
                              'runId': '123', 'sourceReceiptSha256': 'a' * 64},
                   'control': {'tree': 'b' * 40, 'pullRequest': 758, 'runId': '124', 'sourceReceiptSha256': 'b' * 64},
                   'main': {'head': 'd' * 40}, 'commit': 'd' * 40, 'tree': 'b' * 40}
        baseline = {key: {} for key in ('runtimeConfigurationSha256', 'configurationSha256')}
        baseline.update(current='/opt/id-business-v2/releases/synthetic-parent', expectedCurrent=P.CURRENT,
                        manifestSha256='a' * 64, services={role: {} for role in P.SERVICES},
                        beforeApiOnlineFiles=self.c['expectedApiOnlineFiles'],
                        backupNormalizerPath=self.c['backupNormalizerPath'], nginxSha256='b' * 64,
                        publishedOverlays=self.c['publishedOverlays'])
        self.parent = {'status': 'ONLINE_FRAME_ATTEMPTS_PARENT_VERIFIED', 'baseline': baseline,
                       'parentProofSha256': self.c['parentArtifact']['buildProofSha256'], 'businessActions': 0}
        self.plan = {'commit': 'd' * 40, 'tree': 'b' * 40, 'contractSha256': 'e' * 64,
                     'workflowRunId': '125', 'workflowRunAttempt': '1', 'nativeParentCapture': self.parent}
        modules = {n.removesuffix('.js') + ext: 'e' * 64 for n in P.API_MODULES for ext in ('.js', '.js.map')}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
                 **{'api/modules/' + n: v for n, v in modules.items()},
                 **{'admin/html/' + n: v for n, v in self.c['baselineAdminFiles'].items()},
                 **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof = {**self.plan, 'version': 1, 'scope': P.SCOPE, 'sources': self.c['sources'],
                      'qualitySourceEvidence': self.qa, 'afterEngineFiles': self.c['afterEngineFiles'],
                      'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'baselineAdminFiles': self.c['baselineAdminFiles'],
                      'apiModules': modules, 'adminFiles': self.c['baselineAdminFiles'],
                      'preservedApiDeclarations': {n: v for n, v in self.c['beforeApiModules'].items() if n.endswith('.d.ts')},
                      'files': files, 'migrationPerformed': False, 'businessActions': 0}

    def test_exact_source_parent_and_three_roles(self):
        P.validate_contract(self.c)
        self.assertEqual(self.c['updatedServices'], ['api', 'admin', 'online-recharge'])
        self.assertNotIn('admin', self.c['preservedServices'])
        self.assertEqual(self.c['preservedServices'], ['mysql', 'caddy', 'media-resolver', 'auto-recharge'])
        self.assertEqual(self.c['expectedCurrent'], '1371f41f486aa9c6e73cdfbc578984ccb640a6c5')
        self.assertEqual(set(self.c['beforeEngineFiles']), set(self.c['afterEngineFiles']))

    def test_unreviewed_source_or_parent_is_rejected(self):
        for key in ('sourceReviewCommit', 'sourceReviewTree', 'expectedCurrent', 'sourceBase'):
            c = copy.deepcopy(self.c)
            c[key] = 'f' * 40
            with self.assertRaises(RuntimeError):
                P.validate_contract(c)

    def test_sealed_inputs_cannot_be_substituted(self):
        for key in P.SEALED:
            c = copy.deepcopy(self.c)
            c[key] = {} if isinstance(c[key], dict) else [] if isinstance(c[key], list) else 'changed'
            with self.assertRaises(RuntimeError):
                P.validate_contract(c)

    def test_worker_or_migration_scope_expansion_is_rejected(self):
        for key, value in [('updatedServices', ['api', 'admin', 'online-recharge', 'auto-recharge']),
                           ('migrationPerformed', True), ('businessActions', 1),
                           ('awsTargetAccount', '000000000000')]:
            c = copy.deepcopy(self.c)
            c[key] = value
            with self.assertRaises(RuntimeError):
                P.validate_contract(c)

    def test_proof_accepts_only_reviewed_api_admin_and_engine_delta(self):
        P.verify_proof(self.proof, self.plan, self.c, self.proof['files'])
        self.assertTrue(any(n.startswith('admin/html/') for n in self.proof['files']))
        for name in ('credentials.cjs', 'upstream/stripe-payment.js', 'upstream/payment-retry.js', 'browser-profile.cjs'):
            self.assertEqual(self.c['beforeEngineFiles'][name], self.c['afterEngineFiles'][name])

    def test_extra_payload_or_missing_engine_file_is_rejected(self):
        for extra in ('admin/html/unreviewed.js', 'api/schema.prisma', 'engine/upstream/stripe-payment.js'):
            proof = copy.deepcopy(self.proof)
            proof['files'][extra] = 'a' * 64
            with self.assertRaises(RuntimeError):
                P.verify_proof(proof, self.plan, self.c, proof['files'])
        proof = copy.deepcopy(self.proof)
        proof['afterEngineFiles'].pop('credentials.cjs')
        with self.assertRaises(RuntimeError):
            P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_declarations_admin_and_previous_proofs_are_preserved(self):
        for key in ('preservedApiDeclarations', 'adminFiles', 'baselineAdminFiles'):
            proof = copy.deepcopy(self.proof)
            proof[key] = {}
            with self.assertRaises(RuntimeError):
                P.verify_proof(proof, self.plan, self.c, proof['files'])
        parent = copy.deepcopy(self.parent)
        parent['baseline']['publishedOverlays'] = []
        with self.assertRaises(RuntimeError):
            P.validate_capture(parent, self.c)

    def test_both_source_and_control_quality_receipts_are_required(self):
        for role in ('source', 'control'):
            q = copy.deepcopy(self.qa)
            q[role].pop('sourceReceiptSha256')
            with self.assertRaises(RuntimeError):
                P.verify_quality(q, self.plan['commit'], self.plan['tree'])

    def test_runtime_starts_only_reviewed_three_roles_with_existing_lock_fence_recovery(self):
        source = (HERE / 'online-frame-attempts-core.py').read_text()
        tree = ast.parse(source)
        release = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        rendered = ast.unparse(release)
        self.assertIn('if role not in UPDATED:', rendered)
        self.assertIn("d.compose(target, 'up', '-d', '--no-deps', 'api', timeout=180)", rendered)
        self.assertIn("d.wait_healthy(target, 'admin')", rendered)
        self.assertIn('stop_recharge_and_recover', rendered)
        self.assertIn('fence.acquire()', rendered)
        self.assertNotIn('migrate', rendered)
        self.assertIn('fresh_scoped_backup', rendered)

    def test_maintenance_marker_uses_retired_registration_runtime(self):
        helper = P.helpers('proxy-result-identity-release.py')
        runtime = HERE.parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='frame-marker-test-', dir=runtime) as directory:
            root = Path(directory)
            remote = mock.Mock()
            remote.run.side_effect = AssertionError('retired registration mount must not be inspected')
            with mock.patch.dict(helper.claim_markers.__globals__, {'BASE': root}):
                receipt = helper.claim_markers(remote, {}, self.plan)
                self.assertEqual(receipt['paths'], [str(root / 'maintenance.json')])
                self.assertTrue(receipt['registrationRetired'])
                self.assertEqual(json.loads((root / 'maintenance.json').read_bytes())['scope'], P.SCOPE)
                helper.release_markers(receipt)
                self.assertFalse((root / 'maintenance.json').exists())
                remote.run.assert_not_called()

    def test_transport_retains_single_send_intent_and_independent_readback(self):
        source = (HERE / 'online-frame-attempts-publication.py').read_text()
        self.assertIn("intent.open('x')", source)
        self.assertIn("'AWS_MAX_ATTEMPTS': '1'", source)
        self.assertIn("transport(plan, 'readback')", source)
        self.assertIn("'recharge (api)', 'recharge (online-engine)'", source)
        self.assertIn('refs/pull/757/head', source)

    def test_workflow_uses_existing_oidc_target_and_serial_release(self):
        source = (HERE.parents[1] / '.github/workflows/online-frame-attempts-publication.yml').read_text()
        self.assertIn('arn:aws:iam::098208446664:role/id-business-v2-github-release', source)
        self.assertIn('group: id-business-v2-production-release', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertNotIn('migrate', source)


if __name__ == '__main__':
    unittest.main()
