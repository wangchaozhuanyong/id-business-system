"""Offline guards for the exact unpaid-login diagnostic publication."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('session_diagnostic', HERE / 'online-session-diagnostic-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / module.CONTRACT_FILE).read_bytes())

    def test_exact_contract_and_controls(self):
        module.validate_contract(self.c)
        for name, digest in self.c['controlPins'].items():
            self.assertEqual(module.sha((HERE / name).read_bytes()), digest, name)

    def test_rejects_scope_or_payment_extension(self):
        for key, value in [('sourcePullRequest', 733), ('expectedCurrent', 'a' * 40),
                           ('awsTargetAccount', '079740175286'), ('migrationPerformed', True),
                           ('businessActions', 1), ('updatedServices', ['api'])]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.c)
                changed[key] = value
                with self.assertRaises(RuntimeError):
                    module.validate_contract(changed)

    def test_unreviewed_source_and_engine_change_rejected(self):
        for field in ('sources', 'beforeEngineFiles', 'afterEngineFiles'):
            changed = copy.deepcopy(self.c)
            name = next(iter(changed[field]))
            changed[field][name] = '0' * 64
            with self.assertRaises(RuntimeError):
                module.validate_contract(changed)

    def test_two_api_modules_only(self):
        changed = copy.deepcopy(self.c)
        changed['apiModules'].append('auth/session.js')
        with self.assertRaises(RuntimeError):
            module.validate_contract(changed)

    def test_parent_receipt_cannot_be_substituted(self):
        changed = copy.deepcopy(self.c)
        changed['baseline']['manifestSha256'] = '0' * 64
        with self.assertRaises(RuntimeError):
            module.validate_contract(changed)
        changed = copy.deepcopy(self.c)
        changed['services']['api']['image'] = 'sha256:' + '0' * 64
        with self.assertRaises(RuntimeError):
            module.validate_contract(changed)

    def test_three_services_and_no_migration(self):
        self.assertEqual(set(module.UPDATED), {'api', 'admin', 'online-recharge'})
        self.assertEqual(set(module.PRESERVED), {'mysql', 'caddy', 'media-resolver', 'auto-recharge'})
        self.assertEqual(self.c['businessActions'], 0)
        self.assertFalse(self.c['migrationPerformed'])

    def test_build_reproduces_parent_before_overlay(self):
        code = (HERE / 'online-session-diagnostic-build.py').read_text()
        self.assertLess(code.index('recipe.build('), code.index('target.write_bytes'))
        self.assertIn('API_BASE_NOT_REPRODUCED', code)
        self.assertIn('ADMIN_BASE_NOT_REPRODUCED', code)
        self.assertIn('API_COMPILED_SCOPE_CHANGED', code)
        self.assertNotIn('docker', code)

    def test_publication_authenticates_source_pr(self):
        code = (HERE / 'online-session-diagnostic-publication.py').read_text()
        self.assertIn("github('pulls/734')", code)
        self.assertIn("source_tree, 734)", code)
        self.assertIn('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN', code)
        self.assertIn('sourceReceiptSha256', code)

    def test_parallel_source_must_equal_the_published_baseline(self):
        pub = module.load('online-session-diagnostic-publication.py')
        name = 'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue'

        def git(*args):
            return name.encode() if args[0] == 'diff' else b'already-published-source'

        with patch.object(pub, 'git', git):
            pub.reviewed_extensions(self.c)

        def changed(*args):
            if args[0] == 'diff':
                return name.encode()
            return b'unreviewed' if args[1].startswith('HEAD:') else b'already-published-source'

        with patch.object(pub, 'git', changed), self.assertRaises(RuntimeError):
            pub.reviewed_extensions(self.c)


if __name__ == '__main__':
    unittest.main()
