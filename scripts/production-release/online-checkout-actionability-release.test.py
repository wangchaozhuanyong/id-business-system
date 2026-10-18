"""Offline finite publication controls; synthetic fixtures are never saved or published."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
PROJECT = next(parent for parent in HERE.parents if (parent / '.git').exists())
PROJECT_CONTROLS = PROJECT / 'scripts/production-release'


def load(name):
    directory = HERE if (HERE / name).is_file() else PROJECT_CONTROLS
    spec = importlib.util.spec_from_file_location('actionability_test_' + name.replace('-', '_'), directory / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p = load('online-checkout-actionability-release.py')
# The staged draft has no copies of unchanged helpers. Resolve those existing,
# hash-pinned implementations from the real repository for offline pure tests.
p.load = load


def raw_contract():
    return json.loads((HERE / p.CONTRACT_FILE).read_bytes())


def contract():
    c = raw_contract()
    if c.get('frozen') is True:
        return c
    # These are explicitly synthetic unit-test digests, not future source pins.
    # No generated fixture is persisted; freeze() supplies all real bindings.
    c.update(frozen=True, admission='FROZEN_REVIEWED_SOURCE', pendingBindings=[],
        sourceReviewCommit=p.SOURCE_BASE,
        sourceReviewTag='online-checkout-actionability-source-review-' + p.SOURCE_BASE[:12])
    c['afterEngineFiles'] = {**c['beforeEngineFiles'], **{
        name: p.sha(('SYNTHETIC_UNIT_TEST_ONLY:' + name).encode()) for name in p.FILES}}
    c['runtimeSources'] = {p.ENGINE + '/' + name: c['afterEngineFiles'][name] for name in p.FILES}
    c['validationSources'] = {name: p.sha((PROJECT / name).read_bytes()) for name in p.VALIDATION}
    c['reviewedControlSources'] = {name: p.sha(((HERE.parents[1] / name)
        if (HERE.parents[1] / name).is_file() else PROJECT / name).read_bytes()) for name in p.REVIEW_CONTROLS}
    c['controlPins'] = {name: p.sha(((HERE / name) if (HERE / name).is_file()
        else PROJECT_CONTROLS / name).read_bytes()) for name in p.CONTROLS}
    c['workflowSha256'] = p.sha((HERE.parents[1] / p.WORKFLOW).read_bytes())
    predecessor = json.loads((PROJECT_CONTROLS / 'online-query-deadline-contract.json').read_bytes())
    c['baseline'] = copy.deepcopy(predecessor['baseline'])
    c['baseline'].update(commit=p.SOURCE_BASE, current='/opt/id-business-v2/releases/synthetic-unit-test-only',
        engineFiles=c['beforeEngineFiles'], businessActions=0, databaseWrites=0)
    return c


def parity_report():
    return {'schemaVersion': 1, 'status': 'PASS', 'environment': {
        'nodeVersion': '22.0.0', 'platform': 'linux', 'architecture': 'x64',
        'headful': True, 'channel': 'BUNDLED', 'playwrightVersion': '1.59.1',
        'playwrightExtraVersion': '4.3.6', 'stealthVersion': '2.11.2'},
        'summary': p.PARITY_SUMMARY, 'modes': [{
            'mode': mode, 'status': 'PASS', 'browserVersion': '147.0.7727.15', 'cleanupFailures': 0,
            'cases': [{'case': name, 'status': 'PASS'} for name in sorted(p.PARITY_CASES |
                ({'POOL_CONTEXT_ISOLATION'} if mode == 'FORMAL_POOL_CDP' else set()))]
        } for mode in p.PARITY_MODES]}


class ContractTests(unittest.TestCase):
    def test_exact_eight_file_delta_and_one_addition(self):
        c = contract()
        p.validate_contract(c)
        self.assertEqual(p.FILES, {'SOURCE_MANIFEST.json', 'checkout-form.cjs', 'upstream/chatgpt.js',
            'upstream/index.js', 'test/checkout-form.test.cjs', 'test/checkout-interaction.test.cjs',
            'test/recharge-flow-acceptance.test.cjs', 'test/checkout-recovery.test.cjs'})
        self.assertEqual(len(c['beforeEngineFiles']), 103)
        self.assertEqual(len(c['afterEngineFiles']), 104)
        self.assertEqual(set(c['afterEngineFiles']) - set(c['beforeEngineFiles']),
            {'test/checkout-interaction.test.cjs'})
        self.assertEqual({name for name in c['afterEngineFiles']
            if c['beforeEngineFiles'].get(name) != c['afterEngineFiles'][name]}, p.FILES)
        self.assertEqual(c['sourceBaseCommit'], '3d045eb34406a6f83ee41b15f4a43c612dbcce83')

    def test_unbound_draft_cannot_be_checked_or_published(self):
        c = raw_contract()
        if c.get('frozen') is not True:
            self.assertIsNone(c['sourceReviewCommit'])
            self.assertIsNone(c['sourceReviewTag'])
            self.assertIsNone(c['baseline'])
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'):
                p.validate_contract(c)
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'):
                load('online-checkout-actionability-build.py').check(c)
        candidate = contract()
        candidate['baseline'] = None
        p.validate_contract(candidate, require_baseline=False)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_contract(candidate)

    def test_other_engine_files_and_browser_mode_are_preserved(self):
        c = contract()
        for name in ('confirmation.cjs', 'payment-limit.cjs', 'outcomes.cjs', 'checkout-recovery.cjs',
            'rpc.cjs', 'task-runner.cjs', 'worker.cjs', 'security.cjs', 'upstream/session-auth.js',
            'upstream/stripe-payment.js', 'upstream/payment-retry.js', 'upstream/subscription-check.js',
            'upstream/browser-runtime.js', 'upstream/browser-standalone.js', 'upstream/browser-pool.js',
            'upstream/browser-pool-client.js', 'upstream/package.json', 'upstream/package-lock.json', 'Dockerfile'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(c['beforeEngineFiles'][name], c['afterEngineFiles'][name])

    def test_expanded_deleted_replaced_sources_fail_closed(self):
        for mutation in ('extra', 'delete', 'replace', 'unchanged_delta', 'old_base', 'old_origin', 'validation'):
            c = contract()
            if mutation == 'extra': c['afterEngineFiles']['test/unreviewed.test.cjs'] = p.sha(b'synthetic-extra')
            if mutation == 'delete': c['afterEngineFiles'].pop('worker.cjs')
            if mutation == 'replace': c['afterEngineFiles']['rpc.cjs'] = p.sha(b'synthetic-replacement')
            if mutation == 'unchanged_delta':
                c['afterEngineFiles']['checkout-form.cjs'] = c['beforeEngineFiles']['checkout-form.cjs']
            if mutation == 'old_base': c['sourceBaseCommit'] = '8fef357efc8f2d94bdc5175de427db0c621e32ac'
            if mutation == 'old_origin': c['upstreamSource']['commit'] = p.SOURCE_BASE
            if mutation == 'validation': c['validationSources'] = {}
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_legacy_guards_and_business_boundaries_are_frozen(self):
        for name in p.LEGACY_CONTROL_PINS:
            c = contract()
            c['controlPins'][name] = p.sha(b'synthetic-changed-helper')
            with self.subTest(helper=name), self.assertRaises(RuntimeError): p.validate_contract(c)
        for key, value in [('businessActions', 1), ('businessActions', True), ('migrationPerformed', True),
            ('updatedServices', ['api', 'online-recharge']), ('preservedServices', []), ('pendingBindings', ['UNBOUND'])]:
            c = contract(); c[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_predecessor_proof_matches_the_accepted_3d_deployment(self):
        self.assertEqual(p.PREDECESSOR_PROOF_FILE, 'online-query-deadline-build-proof.json')
        self.assertEqual(p.PREDECESSOR_PROOF_SHA256,
            'bbac77e102503fff78252d84f84da54d0ead372f40c02e73e7d42fa15099377e')
        self.assertEqual(p.PREDECESSOR_CONTRACT_SHA256,
            'eb0257515136f161f2f57a9a29c591bd1a902e24ebfadb971546213dfe8a2454')
        self.assertEqual(p.fingerprint(contract()['beforeEngineFiles']), p.BEFORE_ENGINE_SHA256)

    def test_each_preserved_service_rejects_any_identity_change(self):
        c = contract(); original = c['baseline']['services']
        self.assertEqual(set(p.PRESERVED), {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge'})
        for role in p.PRESERVED:
            candidate = copy.deepcopy(original); candidate[role]['containerId'] = 'synthetic-changed-container'
            with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                p.verify_runtime(None, None, candidate, c, original, c['afterEngineFiles'])


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.c = contract()
        tree = '1931cb4a14a608ed7553f55da605918ea8cde6dd'
        quality = {'runId': '1234', 'runAttempt': 1, 'testedTree': tree,
            'kind': 'EXACT_MAIN_SUCCESS', 'commit': p.SOURCE_BASE}
        self.plan = {'commit': p.SOURCE_BASE, 'tree': tree, 'workflowRunId': '123', 'workflowRunAttempt': '1',
            'contractSha256': p.sha(json.dumps(self.c, sort_keys=True).encode()),
            'controlSources': self.c['controlPins'], 'qualitySourceEvidence': quality}
        self.files = {'engine/' + name: self.c['afterEngineFiles'][name] for name in p.FILES}
        self.proof = {**self.plan, 'version': 1, 'scope': p.SCOPE,
            'qualityPartEvidence': {'runId': '1234', 'runAttempt': 1, 'testedTree': tree,
                'parts': ['guards', 'online-engine'], 'jobs': {'guards': 111, 'online-engine': 222}},
            'runtimeSources': self.c['runtimeSources'], 'validationSources': self.c['validationSources'],
            'beforeEngineFiles': self.c['beforeEngineFiles'], 'afterEngineFiles': self.c['afterEngineFiles'],
            'baselineSha256': p.fingerprint(self.c['baseline']), 'workflow': p.WORKFLOW,
            'workflowSha256': self.c['workflowSha256'], 'updatedServices': ['online-recharge'],
            'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0, 'files': self.files}
        self.proof['launcherParityEvidence'] = p.parity_evidence(
            json.dumps(parity_report(), sort_keys=True).encode(), '123', '1')

    def test_exact_eight_file_proof(self):
        p.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_payload_and_tree_cannot_expand_or_change(self):
        for missing in self.files:
            files = {**self.files};files.pop(missing)
            with self.subTest(missing=missing), self.assertRaises(RuntimeError):
                p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)
        files = {**self.files, 'engine/rpc.cjs': p.sha(b'synthetic-extra')}
        with self.assertRaises(RuntimeError):
            p.verify_proof({**self.proof, 'files': files}, self.plan, self.c, files)
        with self.assertRaises(RuntimeError):
            p.verify_proof({**self.proof, 'tree': p.SOURCE_BASE}, self.plan, self.c, self.files)

    def test_node24_headless_missing_cases_or_failed_parity_cannot_substitute(self):
        for mutation in ('node24', 'headless', 'platform', 'missing_case', 'failed_case'):
            report = parity_report()
            if mutation == 'node24': report['environment']['nodeVersion'] = '24.19.0'
            if mutation == 'headless': report['environment']['headful'] = False
            if mutation == 'platform': report['environment']['platform'] = 'darwin'
            if mutation == 'missing_case': report['modes'][0]['cases'].pop()
            if mutation == 'failed_case': report['modes'][0]['cases'][0]['status'] = 'FAIL'
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                p.parity_evidence(json.dumps(report).encode(), '123', '1')

    def test_parity_report_hash_and_native_run_are_required(self):
        for mutation in ('missing', 'run', 'hash'):
            proof = copy.deepcopy(self.proof)
            if mutation == 'missing': proof.pop('launcherParityEvidence')
            if mutation == 'run': proof['launcherParityEvidence']['workflowRunId'] = '456'
            if mutation == 'hash': proof['launcherParityEvidence']['reportSha256'] = None
            with self.subTest(mutation=mutation), self.assertRaises((RuntimeError, TypeError)):
                p.verify_proof(proof, self.plan, self.c, self.files)


class SwitchTests(unittest.TestCase):
    def fixture(self, fail_at=None):
        events = []
        def record(name, *args):
            events.append((name, *args))
            if name == fail_at: raise RuntimeError('synthetic fence rejection')
        driver = SimpleNamespace(compose=lambda folder, *args, **kwargs: record('compose', folder, *args),
            wait_healthy=lambda folder, role: record('healthy', folder, role))
        fence = SimpleNamespace(acquire=lambda: record('acquire'), check_idle=lambda: record('idle'), close=lambda: record('close'))
        return events, driver, fence

    def test_actual_switch_commands_restart_only_engine(self):
        events, driver, fence = self.fixture()
        p.switch_engine(driver, 'old', 'new', fence)
        self.assertEqual(events, [('acquire',), ('compose', 'old', 'stop', 'online-recharge'), ('idle',), ('close',),
            ('compose', 'new', 'up', '-d', '--no-deps', 'online-recharge'), ('healthy', 'new', 'online-recharge'), ('close',)])

    def test_busy_fence_cannot_start_candidate(self):
        for failure in ('acquire', 'idle'):
            events, driver, fence = self.fixture(failure)
            with self.assertRaises(RuntimeError): p.switch_engine(driver, 'old', 'new', fence)
            self.assertFalse(any(row[:2] == ('compose', 'new') for row in events))
            self.assertEqual(events[-1], ('close',))

    def test_native_builder_cannot_package_locally(self):
        b = load('online-checkout-actionability-build.py')
        with patch.object(b, 'check', return_value=p), patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}):
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_BUILD_REQUIRED'): b.main()


if __name__ == '__main__':
    unittest.main()
