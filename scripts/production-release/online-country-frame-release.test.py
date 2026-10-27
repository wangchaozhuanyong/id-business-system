"""Offline publication controls; synthetic proofs, no cloud, DB or business tasks."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('country_frame_release', HERE / 'online-country-frame-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class CountryFramePublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        qa = {'source': {'head': P.SOURCE, 'tree': P.SOURCE_TREE, 'pullRequest': P.SOURCE_PR,
                         'runId': '122', 'sourceReceiptSha256': 'd' * 64},
              'control': {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 747,
                          'runId': '123', 'sourceReceiptSha256': 'e' * 64},
              'main': {'head': 'a' * 40}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '124', 'workflowRunAttempt': '1',
                     'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()),
                     'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())},
                     'qualitySourceEvidence': qa,
                     'nativeParentCapture': {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED',
                         'baseline': {'commit': P.CURRENT}, 'parentProofSha256': P.PARENT_PROOF, 'businessActions': 0}}
        self.proof = {**self.plan, 'scope': P.SCOPE, 'runtimeSources': self.c['runtimeSources'],
                      'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
                      'files': {'engine/' + n: self.c['afterEngineFiles'][n] for n in P.FILES},
                      'businessActions': 0, 'migrationPerformed': False}

    def test_only_three_executor_files_change_and_other_services_are_preserved(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.FILES), 3)
        self.assertEqual(len(self.c['afterEngineFiles']), 135)
        self.assertEqual(self.c['updatedServices'], ['online-recharge'])
        self.assertEqual(self.c['preservedServices'], list(P.PRESERVED))
        for n in self.c['beforeEngineFiles'].keys() - P.FILES:
            self.assertEqual(self.c['beforeEngineFiles'][n], self.c['afterEngineFiles'][n])

    def test_identity_or_target_substitution_is_rejected(self):
        for field, value in [('sourceReviewCommit', 'f' * 40), ('sourceReviewTree', 'f' * 40),
                             ('expectedCurrent', 'f' * 40), ('awsTargetAccount', '000000000000'),
                             ('awsTargetInstance', 'i-other'), ('sourcePullRequest', 745)]:
            c = {**self.c, field: value}
            with self.assertRaises(RuntimeError): P.validate_contract(c)

    def test_frozen_parent_sources_and_runtime_cannot_be_extended(self):
        for field in P.SEALED:
            c = copy.deepcopy(self.c); c[field] = {}
            with self.assertRaises(RuntimeError): P.validate_contract(c)
        for field, value in [('businessActions', 1), ('migrationPerformed', True),
                             ('updatedServices', ['api']), ('preservedServices', [])]:
            with self.assertRaises(RuntimeError): P.validate_contract({**self.c, field: value})

    def test_complete_native_proof_is_accepted(self):
        P.verify_proof(self.proof, self.plan, self.c, self.proof['files'])

    def test_secret_file_or_unrelated_payment_payload_is_rejected(self):
        for name in ('engine/profile/Cookies', 'engine/upstream/stripe-payment.js', 'api/main.js'):
            files = {**self.proof['files'], name: 'f' * 64}
            with self.assertRaises(RuntimeError): P.verify_proof(self.proof, self.plan, self.c, files)

    def test_missing_or_changed_quality_receipts_are_rejected(self):
        for section, field in [('source', 'head'), ('source', 'tree'), ('source', 'pullRequest'),
                               ('control', 'tree'), ('control', 'sourceReceiptSha256'), ('main', 'head')]:
            proof = copy.deepcopy(self.proof); proof['qualitySourceEvidence'][section][field] = 'changed'
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_wrong_parent_proof_and_business_actions_are_rejected(self):
        for field, value in [('parentProofSha256', 'f' * 64), ('status', 'UNVERIFIED'), ('businessActions', 1)]:
            proof = copy.deepcopy(self.proof); proof['nativeParentCapture'][field] = value
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_existing_engine_activation_retains_fence_quieting_and_readback(self):
        core = P.engine(self.c, self.plan)
        self.assertEqual(core.PREFIX, P.PREFIX)
        self.assertEqual(core.PRESERVED, P.PRESERVED)
        self.assertEqual(core.FILES, P.FILES)
        for name in ('switch_selected_source', 'quiet_candidate', 'verify_host', 'verify_adopted'):
            self.assertTrue(callable(getattr(core, name)))

    def test_plan_cannot_substitute_artifact_or_missing_contract(self):
        core = P.engine(self.c, self.plan)
        plan = {**self.plan, 'mode': 'preflight', 'artifactSha256': 'e' * 64,
                'buildProofSha256': 'f' * 64, 'artifactUrl': core.artifact_url(self.plan['commit'])}
        core.validate_plan(plan, self.c)
        self.assertEqual(self.c['baseline']['commit'], P.CURRENT)
        for field, value in [('artifactUrl', 'https://example.invalid/substitute'), ('controlSources', {})]:
            fresh = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
            with self.assertRaises(RuntimeError):
                P.engine(fresh, plan).validate_plan({**plan, field: value}, fresh)

    def test_contract_in_transport_has_no_hash_cycle(self):
        pub = P.load(P.PREFIX + '-publication.py')
        self.assertNotIn(P.CONTRACT_FILE, self.c['controlPins'])
        self.assertEqual(pub.native_plan(self.c, {})['controlSources'][P.CONTRACT_FILE],
                         P.sha((HERE / P.CONTRACT_FILE).read_bytes()))

    def test_publication_sources_and_transitive_helpers_are_pinned(self):
        pub = P.load(P.PREFIX + '-publication.py')
        pub.check(self.c)
        self.assertEqual(pub.INSTANCE, self.c['awsTargetInstance'])
        for name, digest in self.c['controlPins'].items():
            self.assertEqual(P.sha((HERE / name).read_bytes()), digest)

    def test_source_review_requires_the_linux_executor_step(self):
        pub = P.load(P.PREFIX + '-publication.py')
        run = {'id': 1, 'run_attempt': 1, 'head_sha': P.SOURCE, 'event': 'pull_request',
               'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/quality.yml',
               'repository': {'full_name': pub.REPO}}
        jobs = [{'name': n, 'conclusion': 'success', 'steps': []}
                for n in ('quality', 'change-scope', 'recharge (guards)', 'recharge (online-engine)')]
        receipt = {'repository': pub.REPO, 'headSha': P.SOURCE, 'pullRequest': P.SOURCE_PR,
                   'testedTree': P.SOURCE_TREE, 'runId': 1, 'runAttempt': 1}
        def github(path):
            return {'workflow_runs': [run]} if path.startswith('actions/workflows/') else {'jobs': jobs}
        with patch.object(pub, 'github', side_effect=github), patch.object(pub.F, 'artifact_json', return_value=(receipt, 'd' * 64)):
            with self.assertRaisesRegex(RuntimeError, 'LINUX_RUNTIME_QUALITY_REQUIRED'):
                pub.verified_run(P.SOURCE, 'pull_request', P.SOURCE_TREE, P.SOURCE_PR)
            jobs[-1]['steps'] = [{'name': 'Check affected recharge part', 'conclusion': 'success'}]
            self.assertEqual(pub.verified_run(P.SOURCE, 'pull_request', P.SOURCE_TREE, P.SOURCE_PR)['head'], P.SOURCE)

    def test_workflow_uses_existing_identity_and_single_release_lock(self):
        source = (ROOT / '.github/workflows/online-country-frame-publication.yml').read_text()
        self.assertIn('098208446664:role/id-business-v2-github-release', source)
        self.assertIn('id-business-v2-production-release', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertNotIn('migrate:deploy', source)
        self.assertNotIn('aws login', source)
        pub = (HERE / 'online-country-frame-publication.py').read_text()
        self.assertIn('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN', pub)
        self.assertIn('os.fsync', pub)
        self.assertIn("transport(plan, 'readback')", pub)


if __name__ == '__main__':
    unittest.main()
