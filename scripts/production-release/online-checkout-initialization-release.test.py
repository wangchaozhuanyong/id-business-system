"""Offline controls. Synthetic contracts exist only in memory, never as release evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('initialization_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


p = load('online-checkout-initialization-release.py')
b = load('online-checkout-initialization-build.py')
BEFORE_ENGINE = b.engine_inventory(p.ENGINE_BASE, p)


def runtime_parent():
    path = ROOT / '.runtime' / 'online-login-release-20261019'
    if any(parent.is_symlink() for parent in (path, path.parent)):
        raise RuntimeError('SYNTHETIC_FIXTURE_OUTPUT_LINK')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def contract():
    # Explicitly synthetic, ephemeral fixture. A real freeze requires a fresh
    # production observation plus the reviewed annotated source tag.
    before = dict(BEFORE_ENGINE)
    after = {**before, **{n: p.sha(('SYNTHETIC_TEST_ONLY:' + n).encode()) for n in p.FILES}}
    source = 'a' * 40
    baseline = copy.deepcopy(json.loads((HERE / 'online-checkout-actionability-contract.json').read_bytes())['baseline'])
    baseline = {k: baseline[k] for k in ('current', 'services', 'runtimeConfigurationSha256', 'configurationSha256',
        'apiOnlineFiles', 'adminFiles', 'nginxSha256', 'backupNormalizerPath', 'backupNormalizerSha256')}
    baseline.update(commit=p.CURRENT, manifestSha256=p.MANIFEST_SHA, proofs=dict(p.PREDECESSOR_PROOFS),
        engineFiles=before, engineHealth=p.HEALTH, businessActions=0, databaseWrites=0, preservationReceiptSha256=p.PRESERVATION_SHA)
    baseline['services']['online-recharge']['image'] = p.ENGINE_IMAGE
    return {'version': 1, 'scope': p.SCOPE, 'frozen': True, 'admission': 'FROZEN_REVIEWED_SOURCE', 'pendingBindings': [],
        'expectedCurrent': p.CURRENT, 'engineSourceBase': p.ENGINE_BASE, 'reviewBase': p.REVIEW_BASE,
        'sourceReviewCommit': source, 'sourceReviewTag': p.PREFIX + '-source-review-' + source[:12],
        'engineRoot': p.ENGINE, 'upstreamSource': p.LEGACY.UPSTREAM_SOURCE,
        'runtimeSources': {p.ENGINE + '/' + n: after[n] for n in p.FILES},
        'validationSources': {n: p.sha(n.encode()) for n in p.VALIDATION},
        'reviewedControlSources': {n: p.sha(n.encode()) for n in p.REVIEW_CONTROLS},
        'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in p.CONTROLS},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()), 'beforeEngineFiles': before, 'afterEngineFiles': after,
        'baseline': baseline, 'engineHealth': p.HEALTH, 'sqlFenceHelperSha256': p.SQL_FENCE,
        'requiredQualityParts': list(p.QUALITY_PARTS), 'updatedServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0}


def identity():
    return {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}


def browser(c):
    runs = [{'suite': suite, 'mode': mode, 'passed': total, 'reportSha256': p.sha((suite + mode).encode())}
        for suite, mode, total in [('SESSION_ROUTING', 'native', 9), ('SESSION_ROUTING', 'standalone', 9),
            ('SESSION_ROUTING', 'pool', 9), ('CARD_PREPARATION', 'native', 13),
            ('LOGIN_EVIDENCE_BROWSER', 'native', 11), ('SESSION_PROBE', 'native', 8),
            ('UPSTREAM_SESSION_TRANSITION', 'native', 16), ('AUTH_NAVIGATION', 'native', 4)]]
    return {**identity(), 'platform': 'linux', 'nodeVersion': '22.23.3', 'sessionRoutingHeadful': True,
        'testFiles': {n: c['afterEngineFiles'][n] for n in p.INITIALIZATION_TESTS}, 'runs': runs,
        'passed': 79, 'failed': 0, 'skipped': 0, 'todo': 0, 'businessActions': 0, 'paymentActions': 0,
        'reportSha256': p.fingerprint(runs)}


class Controls(unittest.TestCase):
    def test_draft_is_unpublishable(self):
        c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        if not c.get('frozen'):
            self.assertIsNone(c['baseline']); self.assertIsNone(c['sourceReviewCommit'])
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.validate_contract(c)
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): b.check(c)
        c = contract(); c['frozen'] = False
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.release({}, c)

    def test_exact_twenty_file_delta_preserves_dependencies_and_payment_controls(self):
        c = contract(); p.validate_contract(c)
        self.assertEqual(len(p.FILES), 20)
        self.assertEqual(len(p.ADDED), 7)
        self.assertEqual(set(c['afterEngineFiles']) - set(c['beforeEngineFiles']), p.ADDED)
        self.assertTrue({'checkout-form.cjs', 'test/checkout-form.test.cjs',
            'upstream/auth-page-detect.js', 'upstream/human-verification.js',
            'test/recharge-flow-acceptance.test.cjs', 'test/regressions.test.cjs',
            'test/auth-navigation.test.cjs', 'test/login-evidence-browser.test.cjs',
            'test/session-probe.test.cjs', 'test/upstream-session-transition.test.cjs'} <= p.FILES)
        for name in ('payment-limit.cjs', 'confirmation.cjs', 'rpc.cjs', 'Dockerfile', 'upstream/package.json',
            'upstream/package-lock.json', 'upstream/browser-pool.js', 'upstream/browser-standalone.js'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(c['beforeEngineFiles'][name], c['afterEngineFiles'][name])

    def test_review_base_is_independent_and_cannot_be_replaced_by_another_production_baseline(self):
        self.assertEqual(p.REVIEW_BASE, '681e088e1ae6512515769d9e670d7fedd271850f')
        current = p.CURRENT
        old_current = '0348f0327849f1e1203e43db9b26dbbeca6dfa34'
        with patch.object(p, 'CURRENT', old_current):
            c = contract(); p.validate_contract(c)
            self.assertEqual(c['reviewBase'], p.REVIEW_BASE)
            for review_base in (current, '6cdef85aba8c9835801fc4b1ff0c512cd0e5fe41', old_current, p.ENGINE_BASE, '0' * 40, None):
                c = contract(); c['reviewBase'] = review_base
                with self.subTest(review_base=review_base), self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
                    p.validate_contract(c)

    def test_source_review_uses_only_the_exact_main_review_base_delta(self):
        c = contract(); review = c['sourceReviewCommit']; sources = b.reviewed_paths(p)
        content = b'SYNTHETIC_REVIEWED_SOURCE_ONLY'
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-review-fixture-') as scratch:
            root = Path(scratch)
            for name in sources - {'scripts/production-release/' + p.CONTRACT_FILE}:
                target = root / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
            for mutation in (None, 'missing-login-test', 'extra-payment-policy', 'wrong-ancestor', 'old-review-base'):
                value = copy.deepcopy(c)
                delta = set(sources)
                if mutation == 'missing-login-test': delta.remove(p.ENGINE + '/test/login-evidence-browser.test.cjs')
                if mutation == 'extra-payment-policy': delta.add(p.ENGINE + '/payment-limit.cjs')
                if mutation == 'old-review-base': value['reviewBase'] = '6cdef85aba8c9835801fc4b1ff0c512cd0e5fe41'
                def git(*args):
                    if args[:2] == ('cat-file', '-t'): return b'tag\n'
                    if args[0] == 'rev-parse': return (review + '\n').encode()
                    if args[0] == 'merge-base':
                        self.assertEqual(args, ('merge-base', p.REVIEW_BASE, review))
                        return ((p.ENGINE_BASE if mutation == 'wrong-ancestor' else p.REVIEW_BASE) + '\n').encode()
                    if args[:2] == ('diff', '--name-only'):
                        self.assertEqual(args, ('diff', '--name-only', p.REVIEW_BASE, review))
                        return ('\n'.join(sorted(delta)) + '\n').encode()
                    if args[0] == 'show': return content
                    self.fail('Unexpected synthetic git operation: ' + repr(args))
                with self.subTest(mutation=mutation), patch.object(b, 'ROOT', root), patch.object(b, 'git', side_effect=git):
                    if mutation is None: b.verify_review(value, p)
                    else:
                        with self.assertRaises(RuntimeError): b.verify_review(value, p)

    def test_native_main_uses_the_review_base_and_stale_remote_main_cannot_build(self):
        c = contract(); native = identity(); sources = b.reviewed_paths(p)
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-main-fixture-') as scratch:
            root = Path(scratch); frozen = root / 'contract.json'; frozen.write_text(json.dumps(c))
            def git(*args):
                if args == ('rev-parse', 'HEAD'): return (native['commit'] + '\n').encode()
                if args == ('rev-parse', 'HEAD^{tree}'): return (native['tree'] + '\n').encode()
                if args == ('status', '--porcelain', '--untracked-files=no'): return b''
                if args == ('merge-base', p.REVIEW_BASE, native['commit']): return (p.REVIEW_BASE + '\n').encode()
                if args == ('diff', '--name-only', p.REVIEW_BASE, native['commit']): return '\n'.join(sorted(sources)).encode()
                self.fail('Unexpected native-main git operation: ' + repr(args))
            def inventory(commit, publisher):
                self.assertIs(publisher, p)
                return c['afterEngineFiles'] if commit == native['commit'] else c['beforeEngineFiles']
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': native['commit'],
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': 'wangchaozhuanyong/id-business-system',
                'GITHUB_RUN_ID': native['workflowRunId'], 'GITHUB_RUN_ATTEMPT': native['workflowRunAttempt']}
            with patch.object(b, 'CONTRACT', frozen), patch.object(b, 'OUT', root / 'uncreated-output'), \
                patch.object(b, 'check', return_value=p), patch.object(b, 'git', side_effect=git), \
                patch.object(b, 'engine_inventory', side_effect=inventory), patch.dict(b.os.environ, env), \
                patch.object(b.subprocess, 'check_output', return_value=('d' * 40 + '\n').encode()), \
                patch.object(b, 'quality_evidence', side_effect=RuntimeError('SYNTHETIC_STOP_BEFORE_BUILD')) as quality:
                with self.assertRaisesRegex(RuntimeError, 'REMOTE_MAIN_MOVED'): b.main()
                quality.assert_not_called()
                with patch.object(b.subprocess, 'check_output', return_value=(native['commit'] + '\n').encode()):
                    with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_STOP_BEFORE_BUILD'): b.main()
                quality.assert_called_once_with(native['commit'], native['tree'])
                self.assertFalse((root / 'uncreated-output').exists())

    def test_old_or_changed_production_predecessor_is_rejected(self):
        for mutation in ('global', 'engine', 'image', 'manifest', 'proof', 'extra_role', 'missing_role', 'write'):
            c = contract()
            if mutation == 'global': c['expectedCurrent'] = p.ENGINE_BASE
            if mutation == 'engine': c['engineSourceBase'] = p.CURRENT
            if mutation == 'image': c['baseline']['services']['online-recharge']['image'] = 'sha256:' + '0' * 64
            if mutation == 'manifest': c['baseline']['manifestSha256'] = '0' * 64
            if mutation == 'proof': c['baseline']['proofs']['bitbrowser-history-build-proof.json'] = '0' * 64
            if mutation == 'extra_role': c['baseline']['services']['auto-registration'] = c['baseline']['services']['api']
            if mutation == 'missing_role': c['baseline']['services'].pop('api')
            if mutation == 'write': c['baseline']['databaseWrites'] = 1
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_baseline_rejects_credentials_and_raw_container_configuration(self):
        for location, key in (('baseline', 'Env'), ('state', 'Config'), ('state', 'Cookie')):
            c = contract()
            target = c['baseline'] if location == 'baseline' else c['baseline']['services']['api']
            target[key] = 'SYNTHETIC_SENSITIVE_VALUE_NOT_PERSISTED'
            with self.subTest(key=key), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_unreviewed_extra_changed_deleted_or_duplicate_sources_are_rejected(self):
        for mutation in ('extra', 'delete', 'unreviewed', 'unchanged'):
            c = contract()
            if mutation == 'extra': c['afterEngineFiles']['extra.cjs'] = 'a' * 64
            if mutation == 'delete': c['afterEngineFiles'].pop('rpc.cjs')
            if mutation == 'unreviewed': c['afterEngineFiles']['rpc.cjs'] = 'a' * 64
            if mutation == 'unchanged': c['afterEngineFiles']['upstream/stripe-payment.js'] = c['beforeEngineFiles']['upstream/stripe-payment.js']
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_every_added_login_test_must_be_in_the_runtime_delta(self):
        for name in ('test/auth-navigation.test.cjs', 'test/login-evidence-browser.test.cjs',
            'test/session-probe.test.cjs', 'test/upstream-session-transition.test.cjs'):
            c = contract(); c['afterEngineFiles'].pop(name)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                p.validate_contract(c)

    def test_readonly_preflight_never_builds_downloads_marks_or_switches(self):
        c = contract(); c['controlPins'] = {}
        d = Mock(); h = Mock(); a = Mock(); proxy = Mock(); retired = Mock()
        original = {'online-recharge': {'image': p.ENGINE_IMAGE}}
        lock = Mock(); lock.__enter__ = Mock(return_value=lock); lock.__exit__ = Mock(return_value=False)
        with patch.object(p, 'validate_plan'), patch.object(p.LEGACY, 'helpers', return_value=(h, Mock(), d, a, proxy, retired)), \
            patch.object(Path, 'open', return_value=lock), patch.object(p, 'baseline', return_value=(Path('/synthetic'), b'{}', original)), \
            patch.object(p.urllib.request, 'urlopen', side_effect=AssertionError('NO_NETWORK')), \
            patch.object(p.LEGACY, 'switch_engine', side_effect=AssertionError('NO_SWITCH')):
            result = p.release({**identity(), 'mode': 'preflight'}, c)
        self.assertEqual(result['status'], p.SCOPE + '_PREFLIGHT_VERIFIED')
        h.build_image.assert_not_called(); h.fresh_scoped_backup.assert_not_called()
        d.compose.assert_not_called(); d.point_current.assert_not_called(); proxy.claim_markers.assert_not_called()

    def test_baseline_collection_is_hash_only_and_never_claims_release_authority(self):
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-readonly-fixture-') as scratch:
            base = Path(scratch); current = base / 'releases' / 'synthetic'
            (current / 'scripts').mkdir(parents=True)
            (base / 'current').symlink_to(current)
            manifest = json.dumps({'commit': p.CURRENT}).encode(); (current / 'release-manifest.json').write_bytes(manifest)
            proof = json.dumps({'commit': p.ENGINE_BASE, 'afterEngineFiles': BEFORE_ENGINE}).encode()
            proofs = {'online-checkout-actionability-build-proof.json': p.sha(proof),
                'recharge-checkout-build-proof.json': p.sha(b'{}')}
            (current / 'online-checkout-actionability-build-proof.json').write_bytes(proof)
            (current / 'recharge-checkout-build-proof.json').write_bytes(b'{}')
            for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'):
                (current / n).write_bytes(b'SYNTHETIC_CONFIG_NOT_A_CREDENTIAL')
            old_normalizer = base / 'releases' / 'previous' / 'scripts' / 'mysql-dump-restore-normalizer.sed'
            old_normalizer.parent.mkdir(parents=True)
            old_normalizer.write_bytes((ROOT / 'scripts/mysql-dump-restore-normalizer.sed').read_bytes())
            original_files = {str(n): n.read_bytes() for n in current.rglob('*') if n.is_file()}
            h = Mock(); d = Mock(); proxy = Mock()
            states = contract()['baseline']['services']; h.snapshot.return_value = states
            preservation = json.dumps({'after': states}).encode()
            (current / p.PRESERVATION_FILE).write_bytes(preservation)
            original_files[str(current / p.PRESERVATION_FILE)] = preservation
            h.configuration.return_value = 'a' * 64; h.engine_idle.return_value = p.HEALTH
            d.run.side_effect = lambda *args, **kwargs: ('b' * 64 + '  /etc/nginx/conf.d/default.conf') if args[-1] == '/etc/nginx/conf.d/default.conf' else json.dumps({'module.js': 'c' * 64})
            admin = Mock(); admin.admin_inventory.return_value = {'index.html': 'd' * 64}
            engine = Mock()
            with patch.object(p, 'BASE', base), patch.object(p, 'MANIFEST_SHA', p.sha(manifest)), \
                patch.object(p, 'PRESERVATION_SHA', p.sha(preservation)), \
                patch.object(p, 'NORMALIZER_PATH', str(old_normalizer)), \
                patch.object(p, 'PREDECESSOR_PROOFS', proofs), \
                patch.object(p.LEGACY, 'helpers', return_value=(h, Mock(), d, Mock(), proxy, Mock())), \
                patch.object(p, 'load', side_effect=lambda n: admin if n == 'recharge-checkout-release.py' else engine):
                result = p.read_baseline()
            self.assertEqual(result['services'], states)
            self.assertEqual(result['engineFiles'], BEFORE_ENGINE)
            self.assertEqual(result['backupNormalizerPath'], str(old_normalizer))
            self.assertFalse((current / 'scripts/mysql-dump-restore-normalizer.sed').exists())
            self.assertEqual(result['databaseWrites'], 0)
            self.assertEqual(result['runtimeConfigurationSha256'], {n: 'a' * 64 for n in p.SERVICES})
            self.assertNotIn('SYNTHETIC_CONFIG_NOT_A_CREDENTIAL', json.dumps(result))
            self.assertEqual({str(n): n.read_bytes() for n in current.rglob('*') if n.is_file()}, original_files)
            h.build_image.assert_not_called(); h.fresh_scoped_backup.assert_not_called()
            d.point_current.assert_not_called(); proxy.claim_markers.assert_not_called()

    def test_baseline_collection_rejects_a_moved_manifest_before_any_runtime_reads(self):
        h = Mock()
        with patch.object(p.LEGACY, 'helpers', return_value=(h, Mock(), Mock(), Mock(), Mock(), Mock())), \
            patch.object(Path, 'resolve', return_value=Path('/opt/id-business-v2/releases/synthetic')), \
            patch.object(Path, 'read_bytes', return_value=b'{"commit":"unreviewed"}'):
            with self.assertRaisesRegex(RuntimeError, 'BASELINE_MOVED'): p.read_baseline()
        h.snapshot.assert_not_called()

    def test_normalizer_uses_only_the_frozen_canonical_previous_release_path(self):
        c = contract(); p.validate_contract(c)
        self.assertEqual(c['baseline']['backupNormalizerPath'], p.NORMALIZER_PATH)
        for path in (c['baseline']['current'] + '/scripts/mysql-dump-restore-normalizer.sed', '/tmp/mysql-dump-restore-normalizer.sed'):
            c = contract(); c['baseline']['backupNormalizerPath'] = path
            with self.subTest(path=path), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_every_nonengine_service_identity_must_stay_exactly_equal(self):
        c = contract(); original = c['baseline']['services']
        for role in p.PRESERVED:
            after = copy.deepcopy(original); after[role]['containerId'] = '0' * 64
            with self.subTest(role=role), patch.object(p.LEGACY, 'verify_runtime') as verifier:
                with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                    p.verify_runtime(Mock(), Mock(), after, c, original, c['afterEngineFiles'])
                verifier.assert_not_called()

    def test_linux_node22_three_launcher_initialization_evidence_is_required(self):
        c = contract(); value = browser(c); p.validate_browser(value, identity(), c)
        self.assertEqual(len(value['runs']), 8)
        self.assertEqual(value['passed'], 79)
        for mutation in ('mac', 'node24', 'headless', 'skipped', 'wrong_source', 'missing_pool',
            'old_routing_count', 'missing_login', 'missing_probe', 'missing_transition', 'missing_navigation',
            'wrong_login_source', 'changed_report_hash', 'old_parity'):
            value = browser(c)
            if mutation == 'mac': value['platform'] = 'darwin'
            if mutation == 'node24': value['nodeVersion'] = '24.0.0'
            if mutation == 'headless': value['sessionRoutingHeadful'] = False
            if mutation == 'skipped': value['skipped'] = 1
            if mutation == 'wrong_source': value['testFiles'][p.INITIALIZATION_TESTS[0]] = '0' * 64
            if mutation == 'missing_pool': value['runs'].pop(2)
            if mutation == 'old_routing_count': value['runs'][0]['passed'] = 4
            if mutation.startswith('missing_') and mutation != 'missing_pool':
                suite = {'missing_login': 'LOGIN_EVIDENCE_BROWSER', 'missing_probe': 'SESSION_PROBE',
                    'missing_transition': 'UPSTREAM_SESSION_TRANSITION', 'missing_navigation': 'AUTH_NAVIGATION'}[mutation]
                value['runs'] = [run for run in value['runs'] if run['suite'] != suite]
            if mutation == 'wrong_login_source': value['testFiles']['test/login-evidence-browser.test.cjs'] = '0' * 64
            if mutation == 'changed_report_hash': value['runs'][0]['reportSha256'] = '0' * 64
            if mutation == 'old_parity': value = {'summary': {'checksPassed': 22}}
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_browser(value, identity(), c)

    def test_builder_requires_all_eight_pinned_report_summaries_without_rerunning_tests(self):
        c = contract()
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-reports-fixture-') as scratch:
            reports = Path(scratch)
            for filename, _, _, total in p.INITIALIZATION_REPORTS:
                (reports / filename).write_text('TAP version 13\n' + '\n'.join('# ' + name + ' ' + str(value)
                    for name, value in [('tests', total), ('pass', total), ('fail', 0), ('cancelled', 0), ('skipped', 0), ('todo', 0)]) + '\n')
            with patch.object(b, 'REPORTS', reports), patch.object(b.os, 'uname', return_value=SimpleNamespace(sysname='Linux')), \
                patch.dict(b.os.environ, {'SESSION_ROUTING_HEADFUL': '1'}), \
                patch.object(b.subprocess, 'check_output', return_value=b'v22.23.3\n') as command:
                evidence = b.browser_evidence(identity(), c, p)
                self.assertEqual(evidence['passed'], 79)
                self.assertEqual(len(evidence['runs']), 8)
                self.assertTrue(all(call.args[0] == ['node', '--version'] for call in command.call_args_list))
                for filename, _, _, _ in p.INITIALIZATION_REPORTS:
                    report = reports / filename; raw = report.read_bytes(); report.unlink()
                    with self.subTest(filename=filename), self.assertRaisesRegex(RuntimeError, 'BROWSER_REPORT_INVALID'):
                        b.browser_evidence(identity(), c, p)
                    report.write_bytes(raw)
                report = reports / p.INITIALIZATION_REPORTS[0][0]
                report.write_text('# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n')
                with self.assertRaisesRegex(RuntimeError, 'BROWSER_TESTS_FAILED'):
                    b.browser_evidence(identity(), c, p)

    def test_release_requires_exclusive_acceptance_and_rechecks_the_baseline(self):
        source = (HERE / (p.PREFIX + '-release.py')).read_text()
        self.assertIn("stage.mkdir(mode=0o700)", source)
        self.assertIn("'RELEASE_ALREADY_ACCEPTED'", source)
        self.assertEqual(source.count("baseline(d, h, c)[1:] == (manifest_raw, before)"), 2)
        self.assertIn("with (BASE / '.deploy.lock').open('r')", source)
        self.assertNotIn('LEGACY.switch_engine(', source)
        self.assertIn('switch_selected_source(d, current, target, before', source)
        for unsafe in ('--force', 'migrate deploy', 'beforeExternalSubmit', 'confirm-payment', 'submit-payment'):
            self.assertNotIn(unsafe, source)

    def test_admitted_health_allows_real_activity_but_rejects_disconnect_or_invalid_counts(self):
        for count in (0, 1, 3):
            d = Mock(); d.run.side_effect = [json.dumps({**p.HEALTH, 'activeTasks': count}), '{"readOnlyRpcReady":true}']
            self.assertEqual(p.connected_engine(d, {'containerId': 'a' * 64}, {}), {**p.HEALTH, 'activeTasks': count})
            self.assertEqual(d.run.call_count, 2)
        for value in ({**p.HEALTH, 'activeTasks': -1}, {**p.HEALTH, 'activeTasks': True}, {**p.HEALTH, 'rpcConnected': False}):
            d = Mock(); d.run.return_value = json.dumps(value)
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'ENGINE_NOT_CONNECTED'):
                p.connected_engine(d, {'containerId': 'a' * 64}, {})
            self.assertEqual(d.run.call_count, 1)

    def test_adopted_readback_keeps_runtime_protection_without_idle_or_queue_queries(self):
        c = contract(); states = copy.deepcopy(c['baseline']['services'])
        states['online-recharge']['image'] = 'sha256:' + 'e' * 64
        states['online-recharge']['reference'] = 'id-business-v2-' + p.PREFIX + ':' + identity()['commit'] + '-' + identity()['workflowRunId']
        receipt = {'before': c['baseline']['services'], 'after': states, 'candidateImageId': states['online-recharge']['image']}
        d = Mock(); d.run.side_effect = [json.dumps({**p.HEALTH, 'activeTasks': 3}), '{"readOnlyRpcReady":true}']
        h = Mock(); h.snapshot.return_value = states
        original_health = h.engine_idle
        h.guards.side_effect = AssertionError('ADMITTED_TASKS_MAY_BE_QUEUED')
        def runtime(driver, helper, *args):
            return helper.engine_idle(driver, states['online-recharge'], c, wait_connected=True)
        with tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-adopted-fixture-') as scratch, \
            patch.object(p, 'BASE', Path(scratch)), patch.object(p, 'source_selected', return_value=True), \
            patch.object(Path, 'read_bytes', return_value=b'{"status":"DEPLOYED"}'), \
            patch.object(p.LEGACY, 'verify_runtime', side_effect=runtime) as verifier, \
            patch.object(p, 'verify_host') as host:
            result = p.verify_adopted(d, h, Path(scratch), c, identity(), receipt)
        self.assertEqual(result, states)
        verifier.assert_called_once(); host.assert_called_once(); h.guards.assert_not_called()
        self.assertIs(h.engine_idle, original_health)
        d.compose.assert_not_called()
        source = (HERE / (p.PREFIX + '-release.py')).read_text()
        tail = source.split('after = switch_selected_source(d, current, target, before', 1)[1]
        self.assertNotIn('h.guards(', tail)
        self.assertIn('verify_adopted(d, h, target, c, plan, receipt)', tail)
        self.assertIn("'COMMITTED_NEEDS_READBACK'", tail)

    def test_native_main_workflow_uses_the_shared_lock_and_new_tests(self):
        source = (ROOT / p.WORKFLOW).read_text()
        self.assertIn('group: id-business-v2-production-release', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertIn("github.ref == 'refs/heads/main' && inputs.commit == github.sha", source)
        self.assertIn('node-version: 22', source)
        self.assertIn('for mode in native standalone pool', source)
        for name in p.INITIALIZATION_TESTS: self.assertIn(name, source)
        self.assertIn('set -euo pipefail', source)
        self.assertNotIn('online-checkout-actionability-parity', source)


class SwitchTests(unittest.TestCase):
    def scenario(self, failure=None, stop_fails=False, kill_fails=False, image_changes=False, short_budget=False, rejected_state=None):
        scratch = tempfile.TemporaryDirectory(dir=runtime_parent(), prefix='initialization-switch-fixture-')
        self.addCleanup(scratch.cleanup)
        base = Path(scratch.name); previous = base / 'previous'; target = base / 'target'
        previous.mkdir(); target.mkdir(); (base / 'current').symlink_to(previous)
        (target / 'release-manifest.json').write_text(json.dumps({'commit': p.CURRENT}))
        plan = {**identity(), 'buildProofSha256': p.sha(b'SYNTHETIC_BUILD_PROOF')}
        image = 'sha256:' + 'e' * 64
        before = {'containerId': 'a' * 64, 'image': p.ENGINE_IMAGE, 'startedAtSha256': p.sha(b'old-start')}
        candidate = {'containerId': 'd' * 64, 'image': image, 'startedAtSha256': p.sha(b'new-start'), 'status': 'running', 'health': 'healthy'}
        trace = []; commands = []; running = False; paused = False
        released = threading.Event(); claimed = threading.Event(); claim_observations = []
        fence = SimpleNamespace()
        def acquire():
            fence.deadline = time.monotonic() + (44 if short_budget else 120); trace.append('fence')
        def stop_old(value, **kwargs):
            self.assertEqual(value, before); driver.run('docker', 'stop', before['containerId'], timeout=8); trace.append('stop-old')
        def check_idle():
            self.assertFalse(claimed.is_set()); trace.append('same-fence-check')
        def close():
            trace.append('unlock'); released.set()
        fence.acquire, fence.stop, fence.check_idle, fence.close = acquire, stop_old, check_idle, close
        def run(*args, **kwargs):
            nonlocal running, paused
            commands.append((args, kwargs))
            self.assertGreater(kwargs['timeout'], 0)
            self.assertLessEqual(kwargs['timeout'], 120)
            if args[0] == 'compose':
                running = True; return ''
            if args[-1] == before['containerId']: return ''
            self.assertEqual(args[-1], candidate['containerId'])
            if args[1] == 'inspect':
                return json.dumps([{'Id': candidate['containerId'], 'Image': 'sha256:' + '0' * 64 if image_changes else image,
                    'State': {'StartedAt': 'new-start', 'Running': running, 'Paused': paused}}])
            if args[1] == 'stop':
                if stop_fails: raise RuntimeError('SYNTHETIC_STOP_FAILURE')
                running = False
            if args[1] == 'kill':
                if kill_fails: raise RuntimeError('SYNTHETIC_KILL_FAILURE')
                running = False
            if args[1] == 'pause': paused = True
            return ''
        driver = SimpleNamespace(run=run)
        def compose(*args, **kwargs):
            self.assertTrue(p.source_selected(target, plan, image))
            self.assertFalse(released.is_set()); trace.append('start-candidate')
            driver.run('compose', 'up', timeout=kwargs['timeout'])
            # Model the API transaction independently from the worker process:
            # pause/stop cannot cancel this already accepted claim request.
            def api_claim():
                released.wait()
                claim_observations.append({'selected': (base / 'current').resolve() == target,
                    'executionAllowed': running and not paused})
                claimed.set()
            thread = threading.Thread(target=api_claim, daemon=True); thread.start()
            self.addCleanup(lambda: (released.set(), thread.join(timeout=1)))
        driver.compose = compose
        observation = dict(candidate)
        if rejected_state == 'old-id': observation['containerId'] = before['containerId']
        if rejected_state == 'wrong-image': observation['image'] = 'sha256:' + '0' * 64
        driver.service_state = lambda *args, **kwargs: observation
        manifest = {'commit': plan['commit'], 'sourceTree': plan['tree'], 'scope': p.SCOPE,
            'status': 'SWITCH_STARTED', 'images': {'online-recharge': {'digest': image,
                'sourceCommit': plan['commit'], 'reference': 'id-business-v2-' + p.PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId']}}}
        receipt = {'commit': plan['commit'], 'candidateImageId': image,
            'buildProofSha256': plan['buildProofSha256'], 'status': 'SWITCH_STARTED'}
        def select():
            self.assertFalse(claimed.is_set()); trace.append('select-source')
            (target / (p.PREFIX + '-build-proof.json')).write_bytes(b'SYNTHETIC_BUILD_PROOF')
            (target / (p.PREFIX + '-preservation.json')).write_text(json.dumps(receipt))
            (target / 'release-manifest.json').write_text(json.dumps(manifest))
            if failure == 'pointer-before': raise RuntimeError('SYNTHETIC_POINTER_FAILURE')
            (base / 'current').unlink(); (base / 'current').symlink_to(target)
            if failure == 'pointer-after': raise RuntimeError('SYNTHETIC_POINTER_FAILURE')
        def verify():
            self.assertFalse(claimed.is_set()); trace.append('verify-runtime')
            if failure == 'verify': raise RuntimeError('SYNTHETIC_VERIFY_FAILURE')
            return {'online-recharge': candidate}
        def finish(after):
            self.assertFalse(claimed.is_set()); trace.append('commit-deployed')
            if failure == 'manifest': raise RuntimeError('SYNTHETIC_MANIFEST_FAILURE')
            manifest['status'] = receipt['status'] = 'DEPLOYED'
            (target / (p.PREFIX + '-preservation.json')).write_text(json.dumps(receipt))
            (target / 'release-manifest.json').write_text(json.dumps(manifest))
        error = None
        with patch.object(p, 'BASE', base):
            try:
                p.switch_selected_source(driver, previous, target, before, image, fence, plan,
                    base / 'journal.json', select, verify, finish)
            except RuntimeError as observed:
                error = observed
        if 'start-candidate' in trace:
            self.assertTrue(claimed.wait(timeout=1))
        return SimpleNamespace(error=error, trace=trace, commands=commands, target=target,
            base=base, observations=claim_observations, paused=paused, running=running)

    def test_exact_source_is_selected_before_candidate_start_and_queued_api_claim_waits_until_commit(self):
        result = self.scenario()
        self.assertIsNone(result.error)
        self.assertEqual(result.trace, ['fence', 'stop-old', 'select-source', 'start-candidate',
            'verify-runtime', 'commit-deployed', 'same-fence-check', 'unlock'])
        self.assertEqual(result.observations, [{'selected': True, 'executionAllowed': True}])

    def test_pointer_error_before_or_after_actual_switch_never_starts_candidate(self):
        for phase, selected in [('pointer-before', False), ('pointer-after', True)]:
            with self.subTest(phase=phase):
                result = self.scenario(failure=phase)
                self.assertIsNotNone(result.error); self.assertNotIn('start-candidate', result.trace)
                journal = json.loads((result.base / 'journal.json').read_bytes())
                self.assertEqual(journal['sourceSelected'], selected)
                self.assertEqual(journal['candidateQuiet'], 'NOT_STARTED')
                self.assertEqual(json.loads((result.target / 'release-manifest.json').read_bytes())['status'], 'SWITCH_FAILED')

    def test_failed_verification_preserves_new_source_stops_candidate_and_never_claims_api_cancellation(self):
        for failure in ('verify', 'manifest'):
            with self.subTest(failure=failure):
                result = self.scenario(failure=failure)
                self.assertIsNotNone(result.error); self.assertFalse(result.running)
                self.assertEqual(result.observations, [{'selected': True, 'executionAllowed': False}])
                journal = json.loads((result.base / 'journal.json').read_bytes())
                self.assertEqual(journal['candidateQuiet'], 'STOPPED')
                self.assertFalse(journal['apiTransactionsCancelled'])

    def test_exact_kill_and_pause_are_failure_fallbacks_without_touching_other_containers(self):
        for kill_fails, quiet in [(False, 'STOPPED'), (True, 'PAUSED')]:
            with self.subTest(quiet=quiet):
                result = self.scenario(failure='verify', stop_fails=True, kill_fails=kill_fails)
                self.assertIsNotNone(result.error)
                self.assertEqual(json.loads((result.base / 'journal.json').read_bytes())['candidateQuiet'], quiet)
                for args, _ in result.commands:
                    if args[0] == 'docker' and args[1] in ('kill', 'pause'):
                        self.assertEqual(args[-1], 'd' * 64)
                self.assertEqual(result.observations, [{'selected': True, 'executionAllowed': False}])

    def test_changed_candidate_identity_is_never_stopped_or_falsely_reported_quiet(self):
        result = self.scenario(failure='verify', image_changes=True)
        self.assertIsNotNone(result.error)
        self.assertEqual(json.loads((result.base / 'journal.json').read_bytes())['candidateQuiet'], 'UNCONFIRMED')
        self.assertFalse(any(args[0] == 'docker' and args[1] in ('kill', 'pause') for args, _ in result.commands))

    def test_rejected_service_state_never_becomes_a_cleanup_target(self):
        for state in ('old-id', 'wrong-image'):
            with self.subTest(state=state):
                result = self.scenario(rejected_state=state)
                self.assertIsNotNone(result.error)
                self.assertEqual(json.loads((result.base / 'journal.json').read_bytes())['candidateQuiet'], 'NO_MATCHING_CANDIDATE_OBSERVED')
                self.assertEqual([args for args, _ in result.commands if args[0] == 'docker'],
                    [('docker', 'stop', 'a' * 64)])

    def test_shared_budget_reserves_cleanup_before_any_candidate_start(self):
        result = self.scenario(short_budget=True)
        self.assertIsNotNone(result.error); self.assertNotIn('start-candidate', result.trace)
        self.assertEqual(result.commands, [])


if __name__ == '__main__':
    unittest.main()
