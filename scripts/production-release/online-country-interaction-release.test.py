"""No Docker, database, network, credentials or production writes."""
import copy
import importlib.util
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('subscription_challenge_test_release', HERE / 'online-country-interaction-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class CheckoutInitPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                     'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()), 'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())},
                     'qualitySourceEvidence': {'commit': 'a' * 40, 'tree': 'b' * 40, 'pullRequest': 695,
                         'head': 'c' * 40, 'sourceReceiptSha256': 'd' * 64, 'runId': '122',
                         'sourceReviewCommit': P.SOURCE},
                     'nativeParentCapture': {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED',
                         'baseline': {'commit': P.CURRENT}}}
        self.proof = {**self.plan, 'scope': P.SCOPE, 'runtimeSources': self.c['runtimeSources'],
                      'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
                      'files': {'engine/' + n: self.c['afterEngineFiles'][n] for n in P.FILES},
                      'businessActions': 0, 'migrationPerformed': False}

    def test_exact_reviewed_files_and_all_other_engine_sources_preserved(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.FILES), 3)
        for n in self.c['beforeEngineFiles'].keys() - P.FILES:
            self.assertEqual(self.c['beforeEngineFiles'][n], self.c['afterEngineFiles'][n])
        self.assertEqual(set(self.c['afterEngineFiles']) - set(self.c['beforeEngineFiles']), P.ADDED)
        self.assertEqual(self.c['updatedServices'], ['online-recharge'])
        self.assertEqual(set(self.c['preservedServices']), set(P.PRESERVED))

    def test_extra_business_source_rejected(self):
        self.c['afterEngineFiles']['payment-safety.cjs'] = 'e' * 64
        with self.assertRaises(RuntimeError):
            P.validate_contract(self.c)

    def test_source_or_predecessor_identity_change_rejected(self):
        for field in ('sourceReviewCommit', 'expectedCurrent'):
            c = copy.deepcopy(self.c)
            c[field] = 'f' * 40
            with self.assertRaises(RuntimeError):
                P.validate_contract(c)

    def test_valid_finite_proof(self):
        P.verify_proof(self.proof, self.plan, self.c, self.proof['files'])

    def test_changed_or_additional_payload_rejected(self):
        for name in ('engine/upstream/session-auth.js', 'engine/payment-safety.cjs'):
            files = {**self.proof['files'], name: 'f' * 64}
            with self.assertRaises(RuntimeError):
                P.verify_proof(self.proof, self.plan, self.c, files)

    def test_wrong_quality_tree_rejected(self):
        proof = copy.deepcopy(self.proof)
        proof['qualitySourceEvidence']['tree'] = 'f' * 40
        with self.assertRaises(RuntimeError):
            P.verify_proof(proof, proof, self.c, proof['files'])

    def test_migration_or_business_action_rejected(self):
        for field, value in (('migrationPerformed', True), ('businessActions', 1)):
            proof = {**self.proof, field: value}
            with self.assertRaises(RuntimeError):
                P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_reuses_existing_engine_only_activation_and_failure_quieting(self):
        core = P.engine(self.c, self.plan)
        self.assertEqual(core.PREFIX, 'online-country-interaction')
        self.assertEqual(core.FILES, P.FILES)
        self.assertEqual(core.PRESERVED, P.PRESERVED)
        self.assertTrue(callable(core.switch_selected_source))
        self.assertTrue(callable(core.quiet_candidate))
        self.assertTrue(callable(core.verify_host))

    def test_plan_retains_contract_and_transfers_authenticated_baseline(self):
        core = P.engine(self.c, self.plan)
        plan = {**self.plan, 'mode': 'preflight', 'artifactSha256': 'e' * 64,
                'buildProofSha256': 'f' * 64, 'artifactUrl': core.artifact_url(self.plan['commit'])}
        core.validate_plan(plan, self.c)
        self.assertEqual(self.c['baseline'], self.plan['nativeParentCapture']['baseline'])
        bad = copy.deepcopy(plan)
        bad['artifactUrl'] = 'https://example.invalid/substitute'
        with self.assertRaises(RuntimeError):
            P.engine(json.loads((HERE / P.CONTRACT_FILE).read_bytes()), bad).validate_plan(
                bad, json.loads((HERE / P.CONTRACT_FILE).read_bytes()))

    def test_transport_includes_its_own_contract_without_a_self_hash_cycle(self):
        pub = P.load('online-country-interaction-publication.py')
        plan = pub.native_plan(self.c, {})
        self.assertEqual(plan['controlSources'][P.CONTRACT_FILE], P.sha((HERE / P.CONTRACT_FILE).read_bytes()))
        self.assertNotIn(P.CONTRACT_FILE, self.c['controlPins'])
        with self.assertRaises(RuntimeError):
            P.release({**plan, 'mode': 'parent', 'controlSources': self.c['controlPins']}, self.c)

    def test_quality_binds_merged_reviewed_tree_and_each_native_receipt(self):
        pub = P.load('online-country-interaction-publication.py')
        head, commit, tree = 'c' * 40, 'a' * 40, 'b' * 40
        repo = {'full_name': pub.REPO}
        pr = {'number': 695, 'merged_at': 'synthetic', 'base': {'ref': 'main'},
              'merge_commit_sha': commit, 'head': {'sha': head, 'repo': repo}}
        def github(path):
            if path.startswith('commits/'): return [pr]
            if path.startswith('actions/workflows/'):
                selected = path.split('head_sha=')[1]
                return {'workflow_runs': [{'id': 123, 'run_attempt': 1, 'head_sha': selected,
                    'event': 'push' if selected == commit else 'pull_request',
                    'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/quality.yml', 'repository': repo}]}
            if path.endswith('/jobs?per_page=100'):
                return {'jobs': [{'name': name, 'conclusion': 'success'} for name in
                    ('quality', 'change-scope', 'recharge (guards)', 'recharge (online-engine)')]}
            raise AssertionError(path)
        def git(*args):
            if args[0] in ('merge-base', 'diff'): return b''
            if args[0] == 'rev-parse': return tree.encode()
            raise AssertionError(args)
        receipt = {'repository': pub.REPO, 'headSha': head, 'pullRequest': 695,
            'testedTree': tree, 'runId': 123, 'runAttempt': 1}
        with patch.object(pub, 'github', github), patch.object(pub, 'git', git), \
             patch.object(pub.F, 'artifact_json', return_value=(receipt, 'd' * 64)):
            result = pub.quality(commit, tree)
        self.assertEqual(result['pullRequest'], 695)
        self.assertEqual(result['sourceReviewCommit'], P.SOURCE)
        with patch.object(pub, 'github', github), patch.object(pub, 'git', git), \
             patch.object(pub.F, 'artifact_json', return_value=({**receipt, 'testedTree': 'f' * 40}, 'd' * 64)):
            with self.assertRaises(RuntimeError): pub.quality(commit, tree)

    def test_media_mirror_formats_keep_distribution_components_and_signature(self):
        media = P.load('../ci-online-session-media.py')
        for uri in ('http://azure.archive.ubuntu.com/ubuntu',
                    'mirror+file:/etc/apt/mirrors/ubuntu.list',
                    'https://archive.ubuntu.com/ubuntu'):
            raw = ('Types: deb\nURIs: ' + uri + '\nSuites: noble noble-updates noble-security\n'
                   'Components: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n')
            changed = media.official_sources(raw)
            self.assertIn('URIs: https://archive.ubuntu.com/ubuntu\n', changed)
            self.assertEqual([line for line in raw.splitlines() if not line.startswith('URIs:')],
                             [line for line in changed.splitlines() if not line.startswith('URIs:')])
        with self.assertRaises(RuntimeError):
            media.official_sources('Types: deb\nSuites: noble\n')

    def test_current_control_and_source_checks(self):
        pub = P.load('online-country-interaction-publication.py')
        pub.check(self.c)

    def test_parent_native_hash_and_identity_are_independent(self):
        manifest = json.dumps({'commit': P.CURRENT}).encode()
        proof = json.dumps({**self.c['parentProofIdentity'], 'businessActions': 0, 'migrationPerformed': False}).encode()
        c = {**self.c, 'parentManifestSha256': P.sha(manifest), 'parentProofSha256': P.sha(proof)}
        P.verify_parent_bytes(manifest, proof, c)
        with self.assertRaisesRegex(RuntimeError, 'PARENT_PROOF_CHANGED'):
            P.verify_parent_bytes(manifest + b' ', proof, c)
        wrong = json.dumps({'commit': 'f' * 40}).encode()
        with self.assertRaisesRegex(RuntimeError, 'PARENT_IDENTITY_CHANGED'):
            P.verify_parent_bytes(wrong, proof, {**c, 'parentManifestSha256': P.sha(wrong)})


if __name__ == '__main__':
    unittest.main()
