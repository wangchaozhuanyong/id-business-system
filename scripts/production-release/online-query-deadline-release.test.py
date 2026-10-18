"""Offline finite-scope, source, artifact and actual engine-switch boundary tests."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location('deadline_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

p = load('online-query-deadline-release.py')


def contract():
    return json.loads((HERE / p.CONTRACT_FILE).read_bytes())


class ContractTests(unittest.TestCase):
    def test_exact_four_file_engine_delta_and_seven_roles(self):
        c = contract()
        p.validate_contract(c)
        self.assertEqual(p.FILES, {'SOURCE_MANIFEST.json', 'upstream/subscription-check.js',
            'test/query-network-browser.test.cjs', 'test/renewal-state.test.cjs'})
        self.assertEqual(len(c['afterEngineFiles']), 103)
        self.assertEqual({n for n in c['afterEngineFiles'] if c['afterEngineFiles'][n] != c['beforeEngineFiles'][n]}, p.FILES)
        self.assertEqual(set(p.PRESERVED), {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge'})
        self.assertNotIn('registration-closure-dispatch.py', p.CONTROLS)
        self.assertEqual(c['baseline']['commit'], p.SOURCE_BASE)
        self.assertEqual(c['requiredQualityParts'], ['guards', 'online-engine'])

    def test_payment_login_form_and_api_sources_are_preserved(self):
        c = contract()
        for name in ('rpc.cjs', 'task-runner.cjs', 'confirmation.cjs', 'payment-limit.cjs',
            'checkout-form.cjs', 'checkout-recovery.cjs', 'upstream/session-auth.js',
            'upstream/chatgpt.js', 'upstream/stripe-payment.js', 'upstream/payment-retry.js'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(c['beforeEngineFiles'][name], c['afterEngineFiles'][name])
        self.assertFalse(any(n.startswith('apps/admin/') or n.endswith('.ts') for n in c['runtimeSources']))

    def test_unbound_baseline_cannot_publish(self):
        c = contract();c['baseline'] = None
        p.validate_contract(c, require_baseline=False)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_contract(c)

    def test_identity_scope_and_undeclared_engine_changes_fail_closed(self):
        for change in ('old_base', 'other_service', 'extra_source', 'missing_source', 'extra_control',
            'delete_engine', 'add_engine', 'change_payment', 'baseline_roles', 'baseline_inventory', 'health', 'sql'):
            c = contract()
            if change == 'old_base': c['sourceBaseCommit'] = 'b' * 40
            if change == 'other_service': c['updatedServices'] = ['api', 'online-recharge']
            if change == 'extra_source': c['runtimeSources']['apps/api/other.ts'] = 'a' * 64
            if change == 'missing_source': c['runtimeSources'].pop(next(iter(c['runtimeSources'])))
            if change == 'extra_control': c['controlPins']['registration-closure-dispatch.py'] = 'a' * 64
            if change == 'delete_engine': c['afterEngineFiles'].pop('worker.cjs')
            if change == 'add_engine': c['afterEngineFiles']['other.cjs'] = 'a' * 64
            if change == 'change_payment': c['afterEngineFiles']['rpc.cjs'] = 'a' * 64
            if change == 'baseline_roles': c['baseline']['services'].pop('admin')
            if change == 'baseline_inventory': c['baseline']['engineFiles']['worker.cjs'] = 'a' * 64
            if change == 'health': c['baseline']['engineHealth']['activeTasks'] = 1
            if change == 'sql': c['sqlFenceHelperSha256'] = 'a' * 64
            with self.subTest(change=change), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_business_actions_cannot_be_claimed_or_encoded_as_a_boolean(self):
        for value in (1, True, False, '0', None):
            c = contract();c['businessActions'] = value
            with self.assertRaises(RuntimeError): p.validate_contract(c)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.c = contract()
        quality = {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
            'kind': 'EXACT_MAIN_SUCCESS', 'commit': 'a' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
            'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()), 'controlSources': self.c['controlPins'],
            'qualitySourceEvidence': quality, 'artifactSha256': 'c' * 64, 'buildProofSha256': 'd' * 64,
            'artifactUrl': p.artifact_url('a' * 40)}
        self.files = {'engine/' + name: self.c['afterEngineFiles'][name] for name in p.FILES}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE,
            'qualityPartEvidence': {'runId': '1234', 'runAttempt': 1, 'testedTree': 'b' * 40,
                'parts': list(p.QUALITY_PARTS), 'jobs': {'guards': 111, 'online-engine': 222}},
            'runtimeSources': self.c['runtimeSources'], 'validationSources': self.c['validationSources'],
            'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
            'baselineSha256': p.fingerprint(self.c['baseline']), 'workflow': p.WORKFLOW,
            'workflowSha256': self.c['workflowSha256'], 'updatedServices': ['online-recharge'],
            'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0, 'files': self.files}

    def test_exact_native_plan_and_proof(self):
        p.validate_plan({**self.plan, 'mode': 'preflight'}, self.c)
        p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_payload_cannot_omit_replace_or_expand_its_four_files(self):
        for name in self.files:
            files = {**self.files};files.pop(name)
            with self.assertRaises(RuntimeError): p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)
        for name in ('engine/rpc.cjs', 'api/modules/task.js', 'source/docs/ONLINE_RECHARGE.md', 'engine/../secret'):
            files = {**self.files, name: 'e' * 64}
            with self.assertRaises(RuntimeError): p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)

    def test_proof_identity_and_quality_jobs_are_bound(self):
        for key, value in (('commit', 'e' * 40), ('baselineSha256', 'e' * 64), ('businessActions', 1),
            ('migrationPerformed', True), ('updatedServices', ['api']), ('preservedServices', []),
            ('workflowSha256', 'e' * 64), ('qualityPartEvidence', {}), ('qualitySourceEvidence', None)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                p.verify_proof({**self.proof, key: value}, self.plan, self.c, self.files)
        for mode in ('payment', 'rollback', 'retry'):
            with self.assertRaises(RuntimeError): p.validate_plan({**self.plan, 'mode': mode}, self.c)


class SourceTests(unittest.TestCase):
    def test_sources_and_historical_inventory_are_exact(self):
        b = load('online-query-deadline-build.py');c = contract()
        b.check(c)
        self.assertEqual(b.tracked_inventory(p.SOURCE_BASE, p.ENGINE), c['beforeEngineFiles'])

    def test_changed_control_or_workflow_is_rejected(self):
        b = load('online-query-deadline-build.py')
        for key in ('workflowSha256', 'runtimeSources', 'controlPins'):
            c = contract()
            if key == 'workflowSha256': c[key] = 'a' * 64
            else: c[key][next(iter(c[key]))] = 'a' * 64
            with self.subTest(key=key), self.assertRaises(RuntimeError): b.check(c)

    def test_builder_cannot_run_native_packaging_locally(self):
        b = load('online-query-deadline-build.py')
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}), self.assertRaisesRegex(RuntimeError, 'NATIVE_BUILD_REQUIRED'):
            b.main()


class SwitchTests(unittest.TestCase):
    def fixture(self, fail_at=None):
        events = []
        def record(name, *args):
            events.append((name, *args))
            if name == fail_at: raise RuntimeError('synthetic fence rejection')
        driver = SimpleNamespace(compose=lambda path, *args, **kwargs: record('compose', path, *args),
            wait_healthy=lambda path, role: record('healthy', path, role))
        fence = SimpleNamespace(acquire=lambda: record('acquire'), check_idle=lambda: record('idle'), close=lambda: record('close'))
        return events, driver, fence

    def test_actual_commands_restart_only_the_engine_without_dependencies(self):
        events, driver, fence = self.fixture()
        p.switch_engine(driver, 'old', 'new', fence)
        self.assertEqual(events, [('acquire',), ('compose', 'old', 'stop', 'online-recharge'), ('idle',), ('close',),
            ('compose', 'new', 'up', '-d', '--no-deps', 'online-recharge'), ('healthy', 'new', 'online-recharge'), ('close',)])

    def test_busy_fence_cannot_start_candidate_and_is_released(self):
        for failure in ('acquire', 'idle'):
            events, driver, fence = self.fixture(failure)
            with self.assertRaises(RuntimeError): p.switch_engine(driver, 'old', 'new', fence)
            self.assertFalse(any(row[:2] == ('compose', 'new') for row in events))
            self.assertEqual(events[-1], ('close',))


if __name__ == '__main__':
    unittest.main()
