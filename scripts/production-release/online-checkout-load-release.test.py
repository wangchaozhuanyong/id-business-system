"""Offline contract, artifact and actual single-role switch boundaries."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('checkout_load_tests', HERE / 'online-checkout-load-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def contract_fixture():
    c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
    # Synthetic values exercise the offline gates; they are never saved as a
    # production baseline or used by the publisher.
    c['baseline'] = {
        'current': '/opt/id-business-v2/releases/synthetic-navigation-baseline',
        'commit': p.SOURCE_BASE, 'manifestSha256': 'a' * 64,
        'services': {role: {'synthetic': True} for role in p.SERVICES},
        'runtimeConfigurationSha256': {role: 'b' * 64 for role in p.SERVICES},
        'configurationSha256': {name: 'c' * 64 for name in (
            '.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
        'engineFiles': copy.deepcopy(c['beforeEngineFiles']), 'engineHealth': p.HEALTH,
        'backupNormalizerPath': '/opt/id-business-v2/releases/synthetic/scripts/normalizer.sed',
        'backupNormalizerSha256':
            'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'}
    return c


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.c = contract_fixture()

    def test_exact_engine_delta_and_no_api_or_admin_overlay(self):
        p.validate_contract(self.c)
        before, after = self.c['beforeEngineFiles'], self.c['afterEngineFiles']
        self.assertEqual(len(after) - len(before), 1)
        self.assertEqual({name for name in after if before.get(name) != after[name]}, p.FILES)
        self.assertEqual(len(p.FILES), 15)
        self.assertEqual(p.ADDED, {'test/checkout-navigation.test.cjs'})
        self.assertEqual(set(p.PRESERVED), {'api', 'admin', 'mysql', 'caddy', 'media-resolver',
                                          'auto-recharge', 'auto-registration'})

    def test_previous_rpc_payment_and_loading_sources_are_preserved_without_repackaging(self):
        for name in ('rpc.cjs', 'test/rpc-response.test.cjs', 'upstream/stripe-payment.js',
                     'test/checkout-page-loading.test.cjs'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(self.c['beforeEngineFiles'][name], self.c['afterEngineFiles'][name])
        self.assertEqual(len(self.c['beforeEngineFiles']), 101)
        self.assertEqual(len(self.c['afterEngineFiles']), 102)

    def test_the_previous_published_source_is_fixed_and_cannot_be_replaced_by_the_old_baseline(self):
        self.assertEqual(self.c['sourceBaseCommit'], 'a0e633a610ff67400cc2fa8bd2926148a2479ecd')
        for commit in ('6da10d2e4bd9de6df145899648e234000f84b72b', 'd' * 40, '', None):
            with self.subTest(commit=commit), self.assertRaisesRegex(RuntimeError, 'SOURCE_BASE_INVALID'):
                p.validate_contract({**self.c, 'sourceBaseCommit': commit})

    def test_unbound_baseline_never_authorizes_preflight_or_publication(self):
        self.c['baseline'] = None
        p.validate_contract(self.c, require_baseline=False)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_contract(self.c)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_plan({}, self.c)

    def test_added_missing_or_cross_module_sources_are_rejected(self):
        for name in ('apps/api/src/id-business-v2/online-recharge/worker.service.ts',
                     'apps/admin/src/v2/features/online-recharge/OnlineTask.vue',
                     p.ENGINE + '/../credentials.cjs'):
            changed = copy.deepcopy(self.c)
            changed['runtimeSources'][name] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                p.validate_contract(changed)
        self.c['runtimeSources'].pop(p.ENGINE + '/checkout-form.cjs')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
            p.validate_contract(self.c)

    def test_extra_engine_deletion_or_undeclared_change_is_rejected(self):
        for change in ('delete', 'add', 'modify'):
            changed = copy.deepcopy(self.c)
            if change == 'delete': changed['afterEngineFiles'].pop('worker.cjs')
            if change == 'add': changed['afterEngineFiles']['new.cjs'] = 'a' * 64
            if change == 'modify': changed['afterEngineFiles']['worker.cjs'] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'ENGINE_SCOPE_CHANGED'):
                p.validate_contract(changed)

    def test_baseline_role_engine_inventory_and_configuration_cannot_be_relaxed(self):
        for change in ('roles', 'engine', 'health', 'path', 'configuration'):
            changed = copy.deepcopy(self.c)
            b = changed['baseline']
            if change == 'roles': b['services'].pop('admin')
            if change == 'engine': b['engineFiles']['worker.cjs'] = 'a' * 64
            if change == 'health': b['engineHealth']['activeTasks'] = 1
            if change == 'path': b['current'] = '/tmp/other-project'
            if change == 'configuration': b['runtimeConfigurationSha256'].pop('api')
            with self.assertRaisesRegex(RuntimeError, 'BASELINE_INVALID'):
                p.validate_contract(changed)

    def test_stale_or_unreviewed_controller_bytes_are_rejected(self):
        self.c['controlPins']['online-checkout-load-release.py'] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_CHANGED'):
            p.validate_contract(self.c)

    def test_exact_plan_is_bound_to_contract_and_native_artifact_identity(self):
        raw_contract = json.dumps(self.c, sort_keys=True).encode()
        plan = {'mode': 'preflight', 'commit': 'a' * 40, 'tree': 'b' * 40,
                'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': p.sha(raw_contract),
                'controlSources': self.c['controlPins'], 'artifactSha256': 'c' * 64,
                'buildProofSha256': 'd' * 64, 'artifactUrl': p.artifact_url('a' * 40),
                'qualitySourceEvidence': {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
                                          'kind': 'EXACT_MAIN_SUCCESS', 'commit': 'a' * 40}}
        read_bytes = Path.read_bytes
        # Bind this synthetic plan to synthetic bytes without changing the
        # repository's deliberately unbound production contract.
        with patch.object(Path, 'read_bytes', lambda path: raw_contract
                          if path == HERE / p.CONTRACT_FILE else read_bytes(path)):
            p.validate_plan(plan, self.c)
            for key, value in (('mode', 'retry-payment'), ('commit', '../outside'), ('tree', 'invalid'),
                               ('workflowRunId', '0'), ('contractSha256', 'e' * 64),
                               ('controlSources', {}), ('artifactSha256', 'invalid'),
                               ('artifactUrl', 'https://example.invalid/other.tar.gz')):
                with self.assertRaises(RuntimeError):
                    p.validate_plan({**plan, key: value}, self.c)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.c = contract_fixture()
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                     'workflowRunAttempt': '1', 'contractSha256': 'c' * 64,
                     'controlSources': self.c['controlPins'],
                     'qualitySourceEvidence': {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
                                              'kind': 'EXACT_MAIN_SUCCESS', 'commit': 'a' * 40}}
        self.files = {'engine/' + name: self.c['afterEngineFiles'][name] for name in p.FILES}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE,
            'runtimeSources': self.c['runtimeSources'], 'validationSources': self.c['validationSources'],
            'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
            'baselineSha256': p.fingerprint(self.c['baseline']), 'workflow': p.WORKFLOW,
            'workflowSha256': self.c['workflowSha256'],
            'updatedServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED),
            'migrationPerformed': False, 'businessActions': 0, 'files': self.files}

    def test_exact_native_proof_and_runtime_payload(self):
        p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_every_current_delta_is_required_and_digest_bound_in_the_native_payload(self):
        for name in self.files:
            for change in ('missing', 'changed'):
                files = {**self.files}
                if change == 'missing':
                    files.pop(name)
                else:
                    files[name] = 'a' * 64
                with self.subTest(name=name, change=change), self.assertRaisesRegex(RuntimeError, 'NATIVE_PROOF_CHANGED'):
                    p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)

    def test_previous_artifact_scope_and_old_original_source_cannot_be_reused(self):
        files = {**self.files}
        files.pop('engine/test/checkout-navigation.test.cjs')
        files['engine/rpc.cjs'] = self.c['beforeEngineFiles']['rpc.cjs']
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PROOF_CHANGED'):
            p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)
        old = {**self.proof, 'beforeEngineFiles': {
            name: value for name, value in self.c['beforeEngineFiles'].items()
            if name not in ('test/checkout-load-recovery.test.cjs',
                            'test/checkout-page-loading.test.cjs',
                            'test/recharge-flow-acceptance.test.cjs')}}
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PROOF_CHANGED'):
            p.verify_proof(old, self.plan, self.c, self.files)

    def test_payload_cannot_include_validation_sources_or_other_runtime_modules(self):
        for extra in ('source/docs/ONLINE_RECHARGE.md', 'api/modules/worker.repository.js',
                      'engine/worker.cjs', 'engine/../credentials.cjs'):
            files = {**self.files, extra: 'a' * 64}
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_PROOF_CHANGED'):
                p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)

    def test_conflicting_sources_baseline_or_payment_claims_are_rejected(self):
        for key, value in (('commit', 'd' * 40), ('baselineSha256', 'd' * 64),
                           ('updatedServices', ['api', 'online-recharge']),
                           ('preservedServices', []), ('migrationPerformed', True),
                           ('businessActions', 1), ('businessActions', False),
                           ('runtimeSources', {}), ('workflowSha256', 'd' * 64)):
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_PROOF_CHANGED|QUALITY_SOURCE_INVALID'):
                p.verify_proof({**self.proof, key: value}, self.plan, self.c, self.files)

    def test_quality_evidence_cannot_be_removed_or_swapped_after_packaging(self):
        for evidence in (None, {**self.plan['qualitySourceEvidence'], 'runId': '9999'},
                         {**self.plan['qualitySourceEvidence'], 'testedTree': 'f' * 40}):
            with self.assertRaises(RuntimeError):
                p.verify_proof({**self.proof, 'qualitySourceEvidence': evidence}, self.plan, self.c, self.files)


class QualityEvidenceTests(unittest.TestCase):
    def test_exact_main_source_identity(self):
        good = {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
                'kind': 'EXACT_MAIN_SUCCESS', 'commit': 'a' * 40}
        p.validate_quality(good, 'a' * 40, 'b' * 40)
        for key, value in (('runAttempt', 0), ('runId', ''), ('testedTree', 'c' * 40),
                           ('commit', 'd' * 40), ('kind', 'unverified')):
            with self.assertRaises(RuntimeError):
                p.validate_quality({**good, key: value}, 'a' * 40, 'b' * 40)

    def test_identical_pr_source_tree_requires_the_complete_immutable_proof_binding(self):
        proof = {'repository': 'wangchaozhuanyong/id-business-system', 'runId': 1234, 'runAttempt': 1,
                 'pullRequest': 999, 'headSha': 'e' * 40, 'baseSha': 'f' * 40, 'testedTree': 'b' * 40}
        evidence = {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
                    'kind': 'IDENTICAL_PR_TESTED_TREE', 'pullRequest': 999,
                    'artifactDigest': 'sha256:' + 'c' * 64, 'proof': proof}
        p.validate_quality(evidence, 'a' * 40, 'b' * 40)
        for key, value in (('repository', 'other/repo'), ('runId', 1235), ('runAttempt', 2),
                           ('pullRequest', 998), ('headSha', 'invalid'), ('testedTree', 'a' * 40)):
            with self.assertRaises(RuntimeError):
                p.validate_quality({**evidence, 'proof': {**proof, key: value}}, 'a' * 40, 'b' * 40)


class SourceBindingTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        spec = importlib.util.spec_from_file_location('checkout_load_builder', HERE / 'online-checkout-load-build.py')
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)

    def test_current_sources_manifest_and_workflow_match_the_frozen_contract(self):
        self.builder.check(self.c, require_baseline=self.c['baseline'] is not None)
        self.assertEqual(self.builder.tracked_inventory(self.c['sourceBaseCommit'], p.ENGINE),
                         self.c['beforeEngineFiles'])
        if self.c['baseline'] is not None:
            self.assertEqual(self.c['baseline']['engineFiles'], self.c['beforeEngineFiles'])

    def test_freezing_requires_an_explicit_contract_instead_of_a_stale_default(self):
        missing = SimpleNamespace(is_file=lambda: False, is_symlink=lambda: False)
        with patch.object(self.builder, 'CONTRACT', missing), self.assertRaisesRegex(
                RuntimeError, 'CONTRACT_REQUIRED'):
            self.builder.freeze_sources()

    def test_native_build_check_rejects_an_unbound_production_baseline(self):
        c = copy.deepcopy(self.c)
        c['baseline'] = None
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            self.builder.check(c, require_baseline=True)

    def test_freezing_rejects_wrong_source_commit_or_mismatching_published_inventory(self):
        for change, code in (('source', 'SOURCE_BASE_INVALID'),
                             ('inventory', 'PUBLISHED_SOURCE_BASE_CHANGED')):
            c = contract_fixture()
            if change == 'source':
                c['sourceBaseCommit'] = '6da10d2e4bd9de6df145899648e234000f84b72b'
            else:
                c['baseline']['engineFiles']['worker.cjs'] = 'd' * 64
            contract = SimpleNamespace(is_file=lambda: True, is_symlink=lambda: False,
                                       read_bytes=lambda: json.dumps(c).encode())
            with self.subTest(change=change), patch.object(self.builder, 'CONTRACT', contract), \
                    self.assertRaisesRegex(RuntimeError, code):
                self.builder.freeze_sources()

    def test_runtime_or_validation_source_hash_change_is_not_silently_refrozen(self):
        for group, name in (('runtimeSources', p.ENGINE + '/checkout-form.cjs'),
                            ('validationSources', 'docs/ONLINE_RECHARGE.md')):
            changed = copy.deepcopy(self.c)
            changed[group][name] = 'a' * 64
            if group == 'runtimeSources':
                changed['afterEngineFiles'][name.removeprefix(p.ENGINE + '/')] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED'):
                self.builder.check(changed)

    def test_workflow_bytes_cannot_change_after_checks_are_bound(self):
        self.c['workflowSha256'] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'WORKFLOW_CHANGED'):
            self.builder.check(self.c)


class SwitchTests(unittest.TestCase):
    def fixture(self, fail_at=None):
        events = []
        def record(name, *args):
            events.append((name, *args))
            if name == fail_at:
                raise RuntimeError('synthetic idle fence rejected')
        driver = SimpleNamespace(compose=lambda path, *args, **kwargs: record('compose', path, *args),
                                 wait_healthy=lambda path, role: record('healthy', path, role))
        fence = SimpleNamespace(acquire=lambda: record('acquire'), check_idle=lambda: record('idle'),
                                close=lambda: record('close'))
        return events, driver, fence

    def test_actual_switch_only_stops_and_starts_the_engine_without_dependencies(self):
        events, driver, fence = self.fixture()
        p.switch_engine(driver, 'old', 'candidate', fence)
        self.assertEqual(events, [('acquire',), ('compose', 'old', 'stop', 'online-recharge'),
            ('idle',), ('close',), ('compose', 'candidate', 'up', '-d', '--no-deps', 'online-recharge'),
            ('healthy', 'candidate', 'online-recharge'), ('close',)])

    def test_busy_or_lost_fence_never_starts_a_candidate_and_always_closes(self):
        for step in ('acquire', 'idle'):
            events, driver, fence = self.fixture(fail_at=step)
            with self.assertRaises(RuntimeError):
                p.switch_engine(driver, 'old', 'candidate', fence)
            self.assertFalse(any(row[0] == 'compose' and row[1] == 'candidate' for row in events))
            self.assertEqual(events[-1], ('close',))


if __name__ == '__main__':
    unittest.main()
