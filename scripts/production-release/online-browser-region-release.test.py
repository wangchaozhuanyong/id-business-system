"""Finite publication contract tests. No Docker, DB, network or business operations."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('persistent_release', HERE / 'online-browser-region-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

class BrowserRegionPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        source = {'head': P.SOURCE, 'tree': P.SOURCE_TREE, 'pullRequest': 759, 'runId': '123', 'sourceReceiptSha256': 'd' * 64}
        control = {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 760, 'runId': '124', 'sourceReceiptSha256': 'e' * 64}
        qa = {'source': source, 'control': control, 'main': {'head': 'a' * 40, 'runId': '125'}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '126', 'workflowRunAttempt': '1',
            'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()),
            'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())},
            'qualitySourceEvidence': qa,
            'nativeParentCapture': {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': copy.deepcopy(self.c['baseline'])}}
        self.proof = {**self.plan, 'scope': P.SCOPE, 'runtimeSources': self.c['runtimeSources'],
            'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
            'files': {'engine/' + n: self.c['afterEngineFiles'][n] for n in P.FILES}, 'businessActions': 0, 'migrationPerformed': False}

    def test_finite_overlay_preserves_api_admin_schema_and_payment_modules(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.FILES), 11)
        self.assertEqual(self.c['updatedServices'], ['online-recharge'])
        self.assertEqual(set(self.c['afterEngineFiles']) - set(self.c['beforeEngineFiles']), {'test/browser-region.test.cjs', 'test/session-request-observation.test.cjs'})
        for name in self.c['beforeEngineFiles'].keys() - P.FILES:
            self.assertEqual(self.c['beforeEngineFiles'][name], self.c['afterEngineFiles'][name])
        self.assertNotIn('upstream/payment-retry.js', P.FILES)
        self.assertEqual(self.c['baseline']['commit'], P.CURRENT)

    def test_parent_or_source_replacement_is_rejected(self):
        for key in ('sourceReviewCommit', 'expectedCurrent'):
            value = copy.deepcopy(self.c); value[key] = 'f' * 40
            with self.assertRaises(RuntimeError): P.validate_contract(value)

    def test_transport_helper_scope_is_exact(self):
        value = copy.deepcopy(self.c)
        value['controlPins']['unreviewed.py'] = 'a' * 64
        with self.assertRaises(RuntimeError): P.validate_contract(value)

    def test_profile_locks_require_recovery_without_deletion(self):
        for result in ({'profiles': 1, 'locks': 1}, {'profiles': 0, 'locks': 0}):
            runner = unittest.mock.Mock()
            runner.run.return_value = json.dumps(result)
            with self.assertRaisesRegex(RuntimeError, 'PROFILE_RECOVERY_REQUIRED'):
                P.profile_unlocked(runner, {'containerId': 'synthetic'})
            self.assertEqual(runner.run.call_count, 1)
        runner = unittest.mock.Mock()
        runner.run.return_value = json.dumps({'profiles': 1, 'locks': 0})
        P.profile_unlocked(runner, {'containerId': 'synthetic'})
        code = runner.run.call_args.args[-1]
        self.assertNotIn('unlink', code)
        self.assertNotIn('rmSync', code)

    def test_unreviewed_payload_or_removed_source_is_rejected(self):
        for mode in ('extra', 'removed'):
            value = copy.deepcopy(self.c)
            if mode == 'extra': value['afterEngineFiles']['unreviewed.cjs'] = 'a' * 64
            else: value['afterEngineFiles'].pop('upstream/payment-retry.js')
            with self.assertRaises(RuntimeError): P.validate_contract(value)

    def test_valid_proof_and_unchanged_common_switch(self):
        P.verify_proof(self.proof, self.plan, self.c, self.proof['files'])
        core = P.engine(self.c, self.plan)
        self.assertEqual(core.PRESERVED, P.PRESERVED)
        self.assertEqual(core.FILES, P.FILES)
        self.assertTrue(callable(core.switch_selected_source))
        self.assertTrue(callable(core.quiet_candidate))

    def test_quality_cannot_substitute_source_or_reviewed_tree(self):
        for node, field in [('source', 'head'), ('source', 'tree'), ('control', 'tree'), ('main', 'head')]:
            proof = copy.deepcopy(self.proof); proof['qualitySourceEvidence'][node][field] = 'f' * 40
            with self.assertRaises(RuntimeError): P.verify_proof(proof, proof, self.c, proof['files'])

    def test_business_or_migration_actions_are_rejected(self):
        for field, value in [('businessActions', 1), ('migrationPerformed', True)]:
            proof = {**self.proof, field: value}
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_extra_files_and_profile_secrets_cannot_enter_artifact(self):
        for name in ('engine/runtime/browser-profiles/cookie', 'api/modules/main.js'):
            with self.assertRaises(RuntimeError):
                P.verify_proof(self.proof, self.plan, self.c, {**self.proof['files'], name: 'f' * 64})

    def test_transport_does_not_require_a_self_hash_cycle(self):
        pub = P.load('online-browser-region-publication.py')
        plan = pub.native_plan(self.c, {})
        self.assertNotIn(P.CONTRACT_FILE, self.c['controlPins'])
        self.assertEqual(plan['controlSources'][P.CONTRACT_FILE], P.sha((HERE / P.CONTRACT_FILE).read_bytes()))
        with self.assertRaises(RuntimeError):
            P.release({**plan, 'mode': 'parent', 'controlSources': self.c['controlPins']}, self.c)

    def test_preflight_and_readback_keep_artifact_binding(self):
        core = P.engine(self.c, self.plan)
        plan = {**self.plan, 'mode': 'preflight', 'artifactSha256': 'e' * 64,
            'buildProofSha256': 'f' * 64, 'artifactUrl': core.artifact_url(self.plan['commit'])}
        core.validate_plan(plan, self.c)
        self.assertEqual(self.c['baseline'], self.plan['nativeParentCapture']['baseline'])
        with self.assertRaises(RuntimeError):
            core.validate_plan({**plan, 'artifactUrl': 'https://example.invalid/replaced'}, self.c)

    def test_both_workflow_jobs_receive_expected_production_version(self):
        workflow = (HERE.parents[1] / '.github/workflows/online-browser-region-publication.yml').read_text()
        for job in ('validate', 'publish'):
            body = workflow.split('  ' + job + ':\n', 1)[1].split('\n  publish:', 1)[0]
            self.assertIn('      EXPECTED_CURRENT: ${{ inputs.expected_current }}', body)

    def test_baseline_or_configuration_changes_are_rejected_before_transport(self):
        for field in ('services', 'configurationSha256', 'runtimeConfigurationSha256', 'database'):
            value = copy.deepcopy(self.c)
            value['baseline'][field] = {}
            with self.assertRaises(RuntimeError):
                P.validate_contract(value)

    def test_added_files_are_only_the_two_reviewed_synthetic_tests(self):
        for name in ('upstream/stripe-payment.js', 'runtime/cookies.json'):
            value = copy.deepcopy(self.c)
            value['afterEngineFiles'][name] = 'f' * 64
            with self.assertRaises(RuntimeError):
                P.validate_contract(value)

    def test_publisher_requires_exact_source_engine_ci_and_frozen_parent(self):
        pub = P.load('online-browser-region-publication.py')
        source = (HERE / 'online-browser-region-publication.py').read_text()
        self.assertIn("'recharge (online-engine)'", source)
        self.assertIn("if pr_number == 759:", source)
        self.assertNotIn('apps/api/prisma', pub.CONTROLS)
        with patch.object(pub, 'check', side_effect=RuntimeError('SOURCE_CHANGED')):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED'):
                pub.build(self.c)

if __name__ == '__main__': unittest.main()
