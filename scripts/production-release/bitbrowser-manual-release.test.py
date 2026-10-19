"""Reject widened scope and preserve the existing finite publication guards."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('manual_release_tests', HERE / 'bitbrowser-manual-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ManualReleaseTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / p.CONTRACT_FILE).read_bytes())

    def test_exact_frozen_contract(self):
        p.validate_contract(self.c)
        self.assertEqual(len(self.c['productionSources']), 32)
        self.assertEqual(len(self.c['sharedModules']), 4)

    def test_reject_different_source_parent_or_recipe(self):
        for key in ('sourceReviewCommit', 'expectedCurrent', 'predecessorProofSha256', 'recipe'):
            c = copy.deepcopy(self.c)
            c[key] = 'invalid'
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_schema_and_unrelated_runtime_cannot_be_added(self):
        for name in ('apps/api/prisma-mysql/schema.prisma', 'apps/admin/src/v2/features/other/index.ts',
            'apps/api/src/id-business-v2/online-recharge/engine.ts'):
            c = copy.deepcopy(self.c)
            c['sources'][name] = 'a' * 64
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_selected_shared_output_required(self):
        for key in ('apiModules', 'sharedModules'):
            c = copy.deepcopy(self.c)
            c[key] = c[key][1:]
            with self.assertRaises(RuntimeError):
                p.validate_contract(c)

    def test_manual_mysql_must_be_native_and_not_skipped(self):
        value = {'sourceCommit': p.SOURCE, 'runId': self.c['sourceQualityRunId'], 'manualTestsPassed': 4,
            'manualTestsSkipped': 0, 'financialStepPassed': True, 'rollbackStepPassed': True,
            'nativeLogSha256': 'a' * 64}
        p.verify_mysql(value, {}, self.c)
        for key, invalid in (('sourceCommit', 'a' * 40), ('manualTestsPassed', 0), ('manualTestsSkipped', 4),
            ('financialStepPassed', False), ('rollbackStepPassed', False), ('nativeLogSha256', '')):
            with self.assertRaises(RuntimeError):
                p.verify_mysql({**value, key: invalid}, {}, self.c)

    def test_adapter_preserves_activation_and_sql_fence(self):
        engine = p.engine(self.c)
        original = p.load('bitbrowser-history-release.py')
        import inspect
        self.assertEqual(inspect.getsource(engine.activate_services), inspect.getsource(original.activate_services))
        self.assertEqual(engine.UPDATED, ('api', 'admin'))
        self.assertEqual(engine.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertEqual(engine.REBOUND, ('online-recharge',))

    def test_publication_keeps_original_guarded_algorithm(self):
        # Compare AST, allowing only qualification of inherited globals, rename,
        # explicit engine parameter and native parent injection. No guard omitted.
        old_tree = ast.parse((HERE / 'bitbrowser-history-release.py').read_text())
        new_tree = ast.parse((HERE / 'bitbrowser-manual-release.py').read_text())
        old = next(n for n in old_tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        new = next(n for n in new_tree.body if isinstance(n, ast.FunctionDef) and n.name == '_publish')
        new = copy.deepcopy(new)
        new.name = 'release'
        new.args.args.pop(0)
        injections = [n for n in new.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name)
            and t.id == 'c' for t in n.targets)]
        self.assertEqual(len(injections), 1)
        self.assertEqual(ast.dump(injections[0].value), ast.dump(ast.parse("{**c, 'baseline': plan['nativeParentCapture']['baseline']}", mode='eval').body))
        new.body.remove(injections[0])

        class Unqualify(ast.NodeTransformer):
            def visit_Attribute(self, node):
                if isinstance(node.value, ast.Name) and node.value.id == 'engine':
                    return ast.copy_location(ast.Name(id=node.attr, ctx=node.ctx), node)
                return self.generic_visit(node)

        # Shared runtime sources are now part of the API's source lineage.
        lineage = [n for n in ast.walk(new) if isinstance(n, ast.DictComp)
            and n.generators and isinstance(n.generators[0].target, ast.Tuple)]
        extended = [n for n in lineage if n.generators[0].ifs and isinstance(n.generators[0].ifs[0], ast.BoolOp)]
        self.assertEqual(len(extended), 1)
        condition = extended[0].generators[0].ifs[0]
        self.assertEqual(ast.unparse(condition), "n.startswith('apps/' + role + '/') or (role == 'api' and n.startswith('packages/shared/'))")
        extended[0].generators[0].ifs = [condition.values[0]]
        new = Unqualify().visit(new)
        self.assertEqual(ast.dump(new, include_attributes=False), ast.dump(old, include_attributes=False))


if __name__ == '__main__':
    unittest.main()
