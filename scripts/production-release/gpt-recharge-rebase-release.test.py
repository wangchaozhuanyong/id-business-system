import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gpt_rebase', HERE / 'gpt-recharge-rebase-release.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RebaseTests(unittest.TestCase):
    def setUp(self):
        self.native = json.loads((HERE / 'gpt-recharge-contract.json').read_bytes())
        self.rebase = json.loads((HERE / 'gpt-recharge-rebase-contract.json').read_bytes())

    def test_only_one_disjoint_mailbox_js_changes_the_595_module_baseline(self):
        old = copy.deepcopy(self.native)
        result = m.compose_contract(self.native, self.rebase)
        changed = [n for n in result['baselineApiJs'] if result['baselineApiJs'][n] != old['baselineApiJs'][n]]
        self.assertEqual(changed, ['common/prisma/bump-v2-scope-versions.js'])
        self.assertEqual(result['expectedCurrent'], '1c339754507f29459d17d75bb84afbee8fba5291')
        self.assertEqual(result['apiModules'], old['apiModules'])
        self.assertEqual(result['sources'], old['sources'])
        self.assertEqual(self.native, old)

    def test_changed_gpt_module_cannot_be_rebased(self):
        for name in self.native['apiModules']:
            candidate = copy.deepcopy(self.rebase)
            candidate['baseApiJsDelta'][name] = {'old': 'a' * 64, 'current': 'b' * 64}
            with self.assertRaisesRegex(RuntimeError, 'FINITE_BASE_DELTA'):
                m.compose_contract(self.native, candidate)

    def test_false_or_unproven_mailbox_module_is_rejected(self):
        for member in ['old', 'current']:
            candidate = copy.deepcopy(self.rebase)
            candidate['baseApiJsDelta']['common/prisma/bump-v2-scope-versions.js'][member] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'BASE_MODULE_PROOF'):
                m.compose_contract(self.native, candidate)

    def test_unknown_contract_override_or_migration_cannot_enter(self):
        for key, value in [('sources', {}), ('protectedMigrations', {})]:
            candidate = copy.deepcopy(self.rebase)
            candidate['baseOverrides'][key] = value
            with self.assertRaisesRegex(RuntimeError, 'FINITE_BASE_DELTA'):
                m.compose_contract(self.native, candidate)
        self.rebase['migrationPerformed'] = True
        with self.assertRaisesRegex(RuntimeError, 'SCOPE'):
            m.compose_contract(self.native, self.rebase)

    def test_changed_mailbox_signature_cannot_reuse_the_old_compiled_gpt_delta(self):
        self.rebase['mailboxBaselineModules']['common/prisma/bump-v2-scope-versions.d.ts'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'MAILBOX_SIGNATURE_CHANGED'):
            m.compose_contract(self.native, self.rebase)

    def test_native_cow_publisher_calls_and_switch_behavior_are_unchanged(self):
        source = (HERE / 'gpt-recharge-release.py').read_text()
        original = ast.parse(source)
        annotated = m.publisher_tree(source)
        calls = lambda tree: [ast.dump(n, include_attributes=False) for n in ast.walk(tree) if isinstance(n, ast.Call)]
        # Annotation adds no calls, build, backup, SQL or marker behavior.
        self.assertEqual(calls(original), calls(annotated))
        class RemoveProvenance(ast.NodeTransformer):
            def visit_Assign(self, node):
                if isinstance(node.value, ast.Name) and node.value.id == 'REBASE_PROVENANCE':
                    return None
                if isinstance(node.value, ast.Subscript) and isinstance(node.value.value, ast.Name) and node.value.value.id == 'REBASE_PROVENANCE':
                    return None
                if any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == 'manifest' and isinstance(t.slice, ast.Constant) and t.slice.value == 'controlCommit' for t in node.targets):
                    return None
                return node
        self.assertEqual(ast.dump(original, include_attributes=False), ast.dump(RemoveProvenance().visit(annotated), include_attributes=False))


if __name__ == '__main__':
    unittest.main()
