"""Offline finite publication checks. No network, DB, Docker or business tasks."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('subscription_release', HERE / 'online-checkout-read-release.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class CheckoutReadPublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        self.qa = {'source': {'head': P.SOURCE, 'tree': P.SOURCE_TREE, 'pullRequest': 748,
                             'runId': '123', 'sourceReceiptSha256': 'a' * 64},
                   'control': {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 749,
                               'runId': '124', 'sourceReceiptSha256': 'b' * 64},
                   'main': {'head': 'd' * 40}, 'commit': 'd' * 40, 'tree': 'b' * 40}
        baseline = {key: {} for key in ('services', 'runtimeConfigurationSha256', 'configurationSha256')}
        baseline.update(current='/opt/id-business-v2/releases/synthetic-parent', expectedCurrent=P.CURRENT,
                        manifestSha256='a' * 64, beforeApiOnlineFiles=self.c['expectedApiOnlineFiles'],
                        backupNormalizerPath=self.c['backupNormalizerPath'], nginxSha256='b' * 64,
                        publishedOverlays=[{'proofFile': 'online-checkout-build-proof.json',
                                            'proofSha256': self.c['reproductionArtifact']['buildProofSha256']},
                                           {'proofFile': 'online-country-frame-build-proof.json',
                                            'proofSha256': self.c['parentArtifact']['buildProofSha256']}])
        self.parent = {'status': 'ONLINE_CHECKOUT_READ_PARENT_VERIFIED',
                       'baseline': baseline,
                       'parentProofSha256': self.c['parentArtifact']['buildProofSha256'], 'businessActions': 0}
        self.plan = {'commit': 'd' * 40, 'tree': 'b' * 40, 'workflowRunId': '125', 'workflowRunAttempt': '1',
                     'contractSha256': P.sha((HERE / P.CONTRACT_FILE).read_bytes()),
                     'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha((HERE / P.CONTRACT_FILE).read_bytes())},
                     'qualitySourceEvidence': self.qa, 'nativeParentCapture': self.parent}
        modules = {n.removesuffix('.js') + ext: 'e' * 64 for n in self.c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
                 **{'api/modules/' + n: v for n, v in modules.items()},
                 **{'admin/html/' + n: v for n, v in self.c['baselineAdminFiles'].items()},
                 **{'engine/' + n: v for n, v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'].get(n) != v}}
        self.proof = {**self.plan, 'version': 1, 'scope': P.SCOPE, 'sources': self.c['sources'],
                      'afterEngineFiles': self.c['afterEngineFiles'], 'baselineApiReproduced': True,
                      'baselineAdminSourceReproduced': True, 'baselineAdminFiles': self.c['baselineAdminFiles'],
                      'apiModules': modules, 'adminFiles': self.c['baselineAdminFiles'], 'files': files,
                      'migrationPerformed': False, 'businessActions': 0}

    def test_exact_source_and_three_services(self):
        P.validate_contract(self.c)
        self.assertEqual(self.c['updatedServices'], ['api', 'admin', 'online-recharge'])
        self.assertEqual(self.c['apiModules'], P.API_MODULES)
        self.assertEqual(set(self.c['afterEngineFiles']), set(self.c['beforeEngineFiles']))
        for name in ('credentials.cjs', 'upstream/payment-retry.js', 'upstream/stripe-payment.js'):
            self.assertEqual(self.c['afterEngineFiles'][name], self.c['beforeEngineFiles'][name])

    def test_source_or_predecessor_substitution_fails(self):
        for key in ('sourceReviewCommit', 'sourceReviewTree', 'expectedCurrent'):
            c = copy.deepcopy(self.c); c[key] = 'f' * 40
            with self.assertRaises(RuntimeError): P.validate_contract(c)

    def test_source_inventory_and_parent_artifact_are_sealed(self):
        for key in P.SEALED:
            c = copy.deepcopy(self.c)
            c[key] = {} if isinstance(c[key], dict) else 'changed'
            with self.assertRaises(RuntimeError): P.validate_contract(c)

    def test_unrelated_runtime_or_removed_engine_file_fails(self):
        for mode in ('extra', 'removed', 'payment'):
            c = copy.deepcopy(self.c)
            if mode == 'extra': c['afterEngineFiles']['unreviewed.cjs'] = 'a' * 64
            elif mode == 'removed': c['afterEngineFiles'].pop('credentials.cjs')
            else: c['afterEngineFiles']['upstream/payment-retry.js'] = 'a' * 64
            with self.assertRaises(RuntimeError): P.validate_contract(c)

    def test_aws_target_migration_and_business_changes_fail(self):
        for key, value in [('awsTargetAccount', '000000000000'), ('migrationPerformed', True),
                           ('businessActions', 1), ('updatedServices', ['mysql'])]:
            c = copy.deepcopy(self.c); c[key] = value
            with self.assertRaises(RuntimeError): P.validate_contract(c)

    def test_complete_proof_reuses_existing_closed_payload_contract(self):
        P.verify_proof(self.proof, self.plan, self.c, self.proof['files'])

    def test_quality_cannot_change_reviewed_source_or_tree(self):
        for name, field in [('source', 'head'), ('source', 'tree'), ('control', 'tree'), ('main', 'head')]:
            proof = copy.deepcopy(self.proof); proof['qualitySourceEvidence'][name][field] = 'f' * 40
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_parent_capture_is_bound_to_proof_and_predecessor(self):
        for key, value in [('parentProofSha256', 'a' * 64), ('businessActions', 1), ('status', 'UNVERIFIED')]:
            proof = copy.deepcopy(self.proof); proof['nativeParentCapture'][key] = value
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_parent_capture_cannot_override_runtime_or_source_contract(self):
        for key, value in [('expectedCurrent', 'f' * 40), ('afterEngineFiles', {}), ('publishedOverlays', [])]:
            parent = copy.deepcopy(self.parent); parent['baseline'][key] = value
            with self.assertRaises(RuntimeError): P.validate_capture(parent, self.c)

    def test_payload_cannot_add_credentials_or_unrelated_modules(self):
        for name in ('engine/runtime/profile/Cookies', 'api/modules/main.js', 'source/.env'):
            files = {**self.proof['files'], name: 'f' * 64}
            with self.assertRaises(RuntimeError): P.verify_proof(self.proof, self.plan, self.c, files)

    def test_partial_proof_cannot_skip_reproduction_or_allow_business_actions(self):
        for field, value in [('baselineApiReproduced', False), ('baselineAdminSourceReproduced', False),
                             ('businessActions', 1), ('migrationPerformed', True)]:
            proof = {**self.proof, field: value}
            with self.assertRaises(RuntimeError): P.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_no_contract_self_hash_cycle(self):
        pub = P.load(P.PREFIX + '-publication.py')
        self.assertNotIn(P.CONTRACT_FILE, self.c['controlPins'])
        plan = pub.native_plan(self.c, {})
        self.assertEqual(plan['controlSources'][P.CONTRACT_FILE], P.sha((HERE / P.CONTRACT_FILE).read_bytes()))

    def test_historical_build_observer_preserves_inherited_env_and_exact_context(self):
        builder = P.load(P.PREFIX + '-build.py')
        calls, contexts = [], {}
        result = object()
        def run(command, *args, **kwargs):
            calls.append((command, args, kwargs))
            return result
        observe = builder.observe_build(run, contexts, 'v2-published')
        command = ['npm', 'run', 'build', '--workspace', 'apps/admin']
        for environment in (None, {}, {'V2_BUILD_ID': 'v2-older'}):
            self.assertIs(observe(command, cwd='/synthetic/older', env=environment), result)
            self.assertEqual(contexts, {})
            self.assertIs(calls[-1][2]['env'], environment)
        observe(command, cwd='/synthetic/published', env={'V2_BUILD_ID': 'v2-published'})
        self.assertEqual(contexts, {'admin': Path('/synthetic/published')})
        observe(['git', 'merge-file'], cwd='/synthetic/other', env=None)
        self.assertEqual(contexts, {'admin': Path('/synthetic/published')})

    def test_builder_overlays_only_matching_published_runtime_sources(self):
        builder = P.load(P.PREFIX + '-build.py')
        directory = ROOT / '.runtime/checkout-read-evidence-20261027/control-fixtures'
        directory.mkdir(parents=True, exist_ok=True)
        names = [n for n in self.c['sources'] if n.startswith(('apps/admin/', 'apps/api/'))
                 and '.spec.' not in n and not n.startswith(P.ENGINE)]
        self.assertEqual(len(names), 3)
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            contexts = {role: Path(temporary) / role for role in ('api', 'admin')}
            for name in names:
                role = 'admin' if name.startswith('apps/admin/') else 'api'
                path = contexts[role] / name
                path.parent.mkdir(parents=True, exist_ok=True)
                prior = subprocess.run(['git', 'show', P.CURRENT + ':' + name], cwd=ROOT, capture_output=True)
                if prior.returncode == 0: path.write_bytes(prior.stdout)
                else: self.assertFalse(path.exists())
            builder.overlay_sources(self.c, contexts)
            for name in names:
                role = 'admin' if name.startswith('apps/admin/') else 'api'
                self.assertEqual((contexts[role] / name).read_bytes(), (ROOT / name).read_bytes())
            for role in contexts:
                self.assertFalse(list(contexts[role].rglob('*.spec.ts')))
            path = contexts['admin'] / next(n for n in names if n.startswith('apps/admin/'))
            path.write_text('unreviewed source')
            with self.assertRaisesRegex(RuntimeError, 'UNPUBLISHED_SOURCE_DIFFERENCE'):
                builder.overlay_sources(self.c, contexts)

    def test_existing_new_api_source_is_rejected_before_overlay(self):
        builder = P.load(P.PREFIX + '-build.py')
        directory = ROOT / '.runtime/checkout-read-evidence-20261027/control-fixtures'
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            contexts = {role: Path(temporary) / role for role in ('api', 'admin')}
            selected = {'sources': {n: v for n, v in self.c['sources'].items()
                        if n.endswith('persistence/diagnostic-contract.ts')}}
            self.assertEqual(len(selected['sources']), 1)
            for name in selected['sources']:
                path = contexts['api'] / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('unreviewed source')
            with self.assertRaisesRegex(RuntimeError, 'UNREVIEWED_SOURCE_EXISTS'):
                builder.overlay_sources(selected, contexts)

    def test_capture_requires_both_published_proofs(self):
        for index in (0, 1):
            parent = copy.deepcopy(self.parent)
            parent['baseline']['publishedOverlays'].pop(index)
            with self.assertRaises(RuntimeError): P.validate_capture(parent, self.c)

    def test_workflow_uses_existing_oidc_and_shared_serial_release_group(self):
        source = (ROOT / '.github/workflows/online-checkout-read-publication.yml').read_text()
        self.assertIn('id-business-v2-production-release', source)
        self.assertIn('098208446664:role/id-business-v2-github-release', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertNotIn('aws login', source)
        self.assertNotIn('migrate:deploy', source)

    def test_helpers_keep_profile_recovery_and_retired_service_guards(self):
        core = P.load('online-checkout-release.py')
        self.assertTrue(callable(core.stop_recharge_and_recover))
        h = P.helpers('recharge-record-release.py')
        self.assertTrue(callable(h.guards))
        self.assertEqual(h.SERVICES, P.SERVICES)


if __name__ == '__main__':
    unittest.main()
