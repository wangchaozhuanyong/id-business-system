"""Offline rejection cases for the finite first-open diagnostic publication."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('first_open_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


p = load('online-checkout-first-open-release.py').CORE
b = load('online-checkout-first-open-build.py').CORE
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
    def test_ten_files_two_additions_and_six_preserved_services(self):
        c = fixtures.contract(); p.validate_contract(c)
        self.assertEqual(len(p.FILES), 10)
        self.assertEqual(p.ADDED, {'checkout-initialization.cjs', 'test/checkout-initialization.test.cjs'})
        self.assertEqual(set(c['afterEngineFiles']) - set(c['beforeEngineFiles']), p.ADDED)
        self.assertEqual(len(p.PRESERVED), 6)
        self.assertNotEqual(p.CURRENT, p.ENGINE_BASE)
        self.assertEqual(p.ENGINE_BASE, 'cb38a1ef351b42f98ce86740b2191fd54207fa32')
        self.assertEqual(p.ENGINE_PROOF_FILE, 'online-card-visibility-build-proof.json')
        for name in ('payment-limit.cjs', 'confirmation.cjs', 'checkout-recovery.cjs', 'rpc.cjs',
                'credentials.cjs', 'proxy-resolver.cjs', 'Dockerfile', 'upstream/session-auth.js',
                'upstream/stripe-payment.js', 'upstream/human-verification.js',
                'upstream/package.json', 'upstream/package-lock.json'):
            self.assertNotIn(name, p.FILES)
            self.assertEqual(c['beforeEngineFiles'][name], c['afterEngineFiles'][name])

    def test_review_requires_only_the_exact_twenty_one_file_delta(self):
        paths = b.reviewed_paths(p)
        self.assertEqual(len(paths), 21)
        self.assertIn(p.WORKFLOW, paths)
        self.assertIn(p.ENGINE + '/checkout-initialization.cjs', paths)
        self.assertNotIn('scripts/production-release/online-checkout-initialization-release.py', paths)
        c = {'sourceReviewCommit': 'a' * 40,
            'sourceReviewTag': p.PREFIX + '-source-review-' + 'a' * 12, 'reviewBase': p.REVIEW_BASE}
        def git(*args):
            if args[0] == 'cat-file': return b'tag\n'
            if args[0] == 'rev-parse': return ('a' * 40 + '\n').encode()
            if args[0] == 'merge-base': return (p.REVIEW_BASE + '\n').encode()
            if args[0] == 'diff': return ('\n'.join(sorted(paths)) + '\n').encode()
            if args[0] == 'show': return (b.ROOT / args[1].split(':', 1)[1]).read_bytes()
            raise AssertionError(args)
        with patch.object(b, 'git', side_effect=git): b.verify_review(c, p)
        for extra in (p.ENGINE + '/rpc.cjs', 'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts'):
            with patch.object(b, 'git', side_effect=lambda *args: ('\n'.join(sorted(paths | {extra})) + '\n').encode()
                    if args[0] == 'diff' else git(*args)):
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_REVIEW_SCOPE_CHANGED'): b.verify_review(c, p)

    def test_mutated_predecessor_runtime_or_business_action_is_refused(self):
        for mutation in ('current', 'base', 'manifest', 'receipt', 'image', 'extra', 'missing', 'write'):
            c = fixtures.contract()
            if mutation == 'current': c['expectedCurrent'] = '0' * 40
            if mutation == 'base': c['engineSourceBase'] = '0' * 40
            if mutation == 'manifest': c['baseline']['manifestSha256'] = 'f' * 64
            if mutation == 'receipt': c['baseline']['preservationReceiptSha256'] = 'f' * 64
            if mutation == 'image': c['baseline']['services']['online-recharge']['image'] = 'sha256:' + '0' * 64
            if mutation == 'extra': c['afterEngineFiles']['confirmation.cjs'] = '0' * 64
            if mutation == 'missing': c['runtimeSources'].pop(p.ENGINE + '/checkout-initialization.cjs')
            if mutation == 'write': c['businessActions'] = 1
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): p.validate_contract(c)

    def test_linux_node22_and_all_launchers_are_required(self):
        c = fixtures.contract(); value = browser(c)
        self.assertEqual(value['passed'], 325)
        self.assertEqual([row[3] for row in p.INITIALIZATION_REPORTS[:3]], [10, 10, 10])
        p.validate_browser(value, fixtures.identity(), c)
        for field, changed in [('platform', 'darwin'), ('nodeVersion', '24.19.0'),
                ('skipped', 1), ('paymentActions', 1), ('sessionRoutingHeadful', False)]:
            invalid = copy.deepcopy(value); invalid[field] = changed
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.validate_browser(invalid, fixtures.identity(), c)
        invalid = copy.deepcopy(value); invalid['runs'].pop()
        with self.assertRaises(RuntimeError): p.validate_browser(invalid, fixtures.identity(), c)

    def test_unfrozen_candidate_is_not_publishable(self):
        c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())
        if not c.get('frozen'):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.validate_contract(c)
        c = fixtures.contract(); c['frozen'] = False
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_NOT_FROZEN'): p.release({}, c)

    def test_existing_fence_and_source_controls_remain_pinned(self):
        c = fixtures.contract()
        self.assertEqual(c['controlPins']['api-admin-scope.py'], p.SQL_FENCE)
        self.assertIn('online-checkout-initialization-release.py', c['controlPins'])
        self.assertEqual(c['updatedServices'], ['online-recharge'])
        self.assertFalse(c['migrationPerformed'])
        self.assertEqual(c['businessActions'], 0)


if __name__ == '__main__': unittest.main()
