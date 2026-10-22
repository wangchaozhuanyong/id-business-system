"""No Docker, database, network, credentials or production writes."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_fetch_test_release', HERE / 'online-native-fetch-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class NativeFetchPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                     'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()), 'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())},
                     'qualitySourceEvidence': {'commit': 'a' * 40, 'tree': 'b' * 40, 'pullRequest': 679,
                         'head': 'c' * 40, 'sourceReceiptSha256': 'd' * 64, 'runId': '122',
                         'sourceVerification': {'pullRequest': 679, 'commit': '6815b33712de6e6c06392e6694df86aaa105582b',
                             'sourceReceiptSha256': '765794a16baf2728a7eedba1157ed9924d57b8b51e4b5f18742743723dc75b39'}},
                     'nativeParentCapture': {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED',
                         'baseline': {'commit': P.CURRENT}}}
        self.proof = {**self.plan, 'scope': P.SCOPE, 'runtimeSources': self.c['runtimeSources'],
                      'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
                      'files': {'engine/' + n: self.c['afterEngineFiles'][n] for n in P.FILES},
                      'businessActions': 0, 'migrationPerformed': False}

    def test_exact_four_files_and_all_other_engine_sources_preserved(self):
        P.validate_contract(self.c)
        self.assertEqual(len(P.FILES), 4)
        for n in self.c['beforeEngineFiles'].keys() - P.FILES:
            self.assertEqual(self.c['beforeEngineFiles'][n], self.c['afterEngineFiles'][n])
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
        self.assertEqual(core.PREFIX, 'online-native-fetch')
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
        pub = P.load('online-native-fetch-publication.py')
        plan = pub.native_plan(self.c, {})
        self.assertEqual(plan['controlSources'][P.CONTRACT_FILE], P.sha((HERE / P.CONTRACT_FILE).read_bytes()))
        self.assertNotIn(P.CONTRACT_FILE, self.c['controlPins'])
        with self.assertRaises(RuntimeError):
            P.release({**plan, 'mode': 'parent', 'controlSources': self.c['controlPins']}, self.c)

    def test_control_successor_reuses_source_evidence_and_checks_merged_ancestry(self):
        pub = P.load('online-native-fetch-publication.py')
        merged = '6815b33712de6e6c06392e6694df86aaa105582b'
        source_head, control_head = 'c' * 40, 'd' * 40
        source_tree, tree, commit = 'e' * 40, 'b' * 40, 'a' * 40
        repo = {'full_name': pub.REPO}
        source = {'number': 679, 'merged_at': 'synthetic', 'base': {'ref': 'main'},
                  'merge_commit_sha': merged, 'head': {'sha': source_head, 'repo': repo}}
        control = {'number': 680, 'merged_at': 'synthetic', 'base': {'ref': 'main'},
                   'merge_commit_sha': commit, 'head': {'sha': control_head, 'repo': repo}}
        def run(head, event='pull_request'):
            return {'id': 123 if head == source_head else 124, 'run_attempt': 1,
                    'head_sha': head, 'event': event, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/quality.yml', 'repository': repo}
        def github(path):
            if path == 'pulls/679': return source
            if path.startswith('commits/'): return [control]
            if path.startswith('actions/workflows/'):
                head = path.split('head_sha=')[1]
                return {'workflow_runs': [run(head, 'push' if head == commit else 'pull_request')]}
            if path.endswith('/jobs?per_page=100'):
                return {'jobs': [{'name': n, 'conclusion': 'success'} for n in
                    ('quality', 'change-scope', 'recharge (guards)', 'recharge (online-engine)')]}
            raise AssertionError(path)
        ancestors = []
        def git(*args):
            if args[0] == 'merge-base':
                ancestors.append(args[2:]); return b''
            if args[0] == 'diff': return b''
            if args[0] == 'rev-parse':
                return (source_tree if args[1].startswith((source_head, merged)) else tree).encode()
            raise AssertionError(args)
        def artifact(r, _name, _member):
            is_source = r['head_sha'] == source_head
            value = {'repository': pub.REPO, 'headSha': r['head_sha'],
                     'pullRequest': 679 if is_source else 680, 'testedTree': source_tree if is_source else tree,
                     'runId': r['id'], 'runAttempt': 1}
            return value, '765794a16baf2728a7eedba1157ed9924d57b8b51e4b5f18742743723dc75b39'
        with patch.object(pub, 'github', github), patch.object(pub, 'git', git), patch.object(pub.F, 'artifact_json', artifact):
            result = pub.quality(commit, tree)
        self.assertEqual(result['pullRequest'], 680)
        self.assertEqual(result['sourceVerification']['pullRequest'], 679)
        self.assertEqual(ancestors, [(P.SOURCE, source_head), (merged, control_head)])

    def test_current_control_and_source_checks(self):
        pub = P.load('online-native-fetch-publication.py')
        pub.check(self.c)


if __name__ == '__main__':
    unittest.main()
