"""Offline tests for finite card visibility publication and lock-phase health reads."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location('card_visibility_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

p = load('online-card-visibility-release.py').CORE
b = load('online-card-visibility-build.py').CORE
fixtures = load('online-checkout-initialization-release.test.py')
fixtures.p = p
fixtures.BEFORE_ENGINE = b.engine_inventory(p.ENGINE_BASE, p)

def browser(c):
    value = fixtures.browser(c)
    value['runs'] = [{'suite': suite, 'mode': mode, 'passed': total,
        'reportSha256': p.sha((suite + mode).encode())} for _, suite, mode, total in p.INITIALIZATION_REPORTS]
    value['passed'] = sum(row[3] for row in p.INITIALIZATION_REPORTS)
    value['reportSha256'] = p.fingerprint(value['runs'])
    return value

class Controls(unittest.TestCase):
    def test_exact_six_file_overlay_and_current_predecessor(self):
        c = fixtures.contract(); p.validate_contract(c)
        self.assertEqual(len(p.FILES), 6); self.assertFalse(p.ADDED)
        self.assertEqual(p.CURRENT, 'fe52794341fe07d518b4fcc8b2141a67341487c7')
        self.assertEqual(p.ENGINE_BASE, p.CURRENT)
        self.assertEqual(p.REVIEW_BASE, 'fe52794341fe07d518b4fcc8b2141a67341487c7')
        self.assertEqual(p.ENGINE_PROOF_FILE, 'online-card-control-diagnostics-build-proof.json')
        self.assertEqual(len(p.PRESERVED), 6)
        for name in ('payment-limit.cjs', 'confirmation.cjs', 'checkout-recovery.cjs', 'rpc.cjs',
            'Dockerfile', 'upstream/session-auth.js', 'upstream/stripe-payment.js',
            'upstream/package.json', 'upstream/package-lock.json'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(c['beforeEngineFiles'][name], c['afterEngineFiles'][name])
        self.assertEqual(set(c['controlPins']), p.CONTROLS)
        self.assertIn('online-checkout-initialization-release.py', p.CONTROLS)
        self.assertIn('scripts/production-release/online-checkout-initialization-release.py', p.PUBLIC_CONTROLS)

    def test_changed_source_predecessor_or_scope_is_refused(self):
        for mutation in ('base', 'review', 'image', 'receipt', 'proof', 'extra', 'missing', 'write'):
            c = fixtures.contract()
            if mutation == 'base': c['engineSourceBase'] = '0' * 40
            if mutation == 'review': c['reviewBase'] = '0' * 40
            if mutation == 'image': c['baseline']['services']['online-recharge']['image'] = 'sha256:' + '0' * 64
            if mutation == 'receipt': c['baseline']['preservationReceiptSha256'] = '0' * 64
            if mutation == 'proof': c['baseline']['proofs'].pop(p.ENGINE_PROOF_FILE)
            if mutation == 'extra': c['afterEngineFiles']['confirmation.cjs'] = '0' * 64
            if mutation == 'missing': c['runtimeSources'].pop(p.ENGINE + '/checkout-form.cjs')
            if mutation == 'write': c['businessActions'] = 1
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_draft_contract_is_not_publishable(self):
        c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        if not c.get('frozen'):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.validate_contract(c)
        value = fixtures.contract(); value['frozen'] = False
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.release({}, value)

    def test_linux_launcher_evidence_and_exact_quality_are_still_required(self):
        c = fixtures.contract(); evidence = browser(c)
        p.validate_browser(evidence, fixtures.identity(), c)
        for field, value in [('platform', 'darwin'), ('skipped', 1), ('paymentActions', 1), ('sessionRoutingHeadful', False)]:
            changed = copy.deepcopy(evidence); changed[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.validate_browser(changed, fixtures.identity(), c)

    def test_new_visibility_linux_reports_cannot_reuse_the_old_79_pass_claim(self):
        c = fixtures.contract(); value = browser(c)
        self.assertEqual(value['passed'], 265)
        self.assertEqual([r[3] for r in p.INITIALIZATION_REPORTS[:3]], [10, 10, 10])
        self.assertIn('test/checkout-form.test.cjs', p.INITIALIZATION_TESTS)
        self.assertIn('test/checkout-interaction.test.cjs', p.INITIALIZATION_TESTS)
        p.validate_browser(value, fixtures.identity(), c)
        value['passed'] = 79
        with self.assertRaisesRegex(RuntimeError, 'LINUX_INITIALIZATION_TESTS_REQUIRED'):
            p.validate_browser(value, fixtures.identity(), c)

    def test_fenced_read_uses_health_only_and_rejects_active_tasks(self):
        d = Mock(); d.run.return_value = json.dumps(p.HEALTH)
        state = {'containerId': 'a' * 64}
        self.assertEqual(p.fenced_engine(d, state, {}), p.HEALTH)
        self.assertEqual(d.run.call_count, 1)
        code = d.run.call_args.args[-1]
        self.assertIn('healthcheck.cjs', code)
        self.assertNotIn('rpc.cjs', code); self.assertNotIn('getRuntimeConfig', code)
        d.run.return_value = json.dumps({**p.HEALTH, 'activeTasks': 1})
        with self.assertRaisesRegex(RuntimeError, 'FENCED_ENGINE_NOT_IDLE'): p.fenced_engine(d, state, {})

    def test_health_phases_restore_original_checks_and_cannot_overlap(self):
        c = fixtures.contract(); states = c['baseline']['services']; original = Mock()
        h = SimpleNamespace(engine_idle=original)
        for admitted, fenced, expected in [(False, False, original), (False, True, p.fenced_engine), (True, False, p.connected_engine)]:
            def verify(*_args): self.assertIs(h.engine_idle, expected)
            with self.subTest(admitted=admitted, fenced=fenced), patch.object(p.LEGACY, 'verify_runtime', side_effect=verify):
                p.verify_runtime(Mock(), h, states, c, states, c['afterEngineFiles'], admitted=admitted, fenced=fenced)
                self.assertIs(h.engine_idle, original)
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_PHASE_INVALID'):
            p.verify_runtime(Mock(), h, states, c, states, c['afterEngineFiles'], admitted=True, fenced=True)
        with patch.object(p.LEGACY, 'verify_runtime', side_effect=RuntimeError('fixture failure')):
            with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                p.verify_runtime(Mock(), h, states, c, states, c['afterEngineFiles'], fenced=True)
        self.assertIs(h.engine_idle, original)

    def test_fenced_switch_and_post_admission_use_distinct_checks(self):
        source = (HERE / 'online-checkout-initialization-release.py').read_text()
        self.assertIn("verify_runtime(d, h, after, c, before, c['afterEngineFiles'], fenced=True)", source)
        self.assertIn("verify_runtime(d, h, states, c, receipt['before'], c['afterEngineFiles'], admitted=True)", source)
        self.assertIn("rpc('getRuntimeConfig',{})", source)
        self.assertEqual(p.SQL_FENCE, '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925')

if __name__ == '__main__': unittest.main()
