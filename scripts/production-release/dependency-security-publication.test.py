"""Offline contract and side-effect boundaries for the finite dependency observation."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dependency_security_tested', HERE / 'dependency-security-publication.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class DependencyObservation(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def test_exact_contract_and_sources(self):
        P.check(self.contract)

    def test_only_original_predecessor(self):
        for field in ('expectedCurrent', 'sourceCommit'):
            changed = copy.deepcopy(self.contract)
            changed[field] = 'a' * 40
            with self.assertRaisesRegex(RuntimeError, 'CONTRACT_CHANGED'):
                P.validate(changed)

    def test_no_migration_business_or_rollback_permission(self):
        for field, value in [('businessActions', 1), ('migrationPerformed', True), ('automaticRollback', True)]:
            changed = copy.deepcopy(self.contract)
            changed[field] = value
            with self.assertRaisesRegex(RuntimeError, 'SIDE_EFFECT_SCOPE'):
                P.validate(changed)

    def test_no_publish_mode_is_accepted(self):
        for mode in ('preflight', 'release', 'publish', 'readback'):
            with self.assertRaisesRegex(RuntimeError, 'READ_ONLY_MODE_REQUIRED'):
                P.release({'mode': mode}, self.contract)

    def test_package_paths_cannot_escape_or_select_runtime_data(self):
        for path in ('../.env', '/app/.env', 'node_modules/../../uploads', 'node_modules/pkg/../../../.env'):
            changed = copy.deepcopy(self.contract)
            changed['packageDirectories'][0] = path
            with self.assertRaisesRegex(RuntimeError, 'PACKAGE_PATH_CHANGED'):
                P.validate(changed)

    def test_changed_source_is_rejected_before_network(self):
        changed = copy.deepcopy(self.contract)
        changed['sources']['package-lock.json'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED'):
            P.check(changed)

    def test_remote_body_has_no_deployment_or_database_writes(self):
        tree = ast.parse((HERE / 'dependency-security-publication.py').read_text())
        release = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        calls = [n.func.attr for n in ast.walk(release) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertTrue({'snapshot', 'runtime'} <= set(calls))
        self.assertFalse({'compose', 'write_bytes', 'write_text', 'unlink', 'point_current', 'rmtree'} & set(calls))

    def test_old_native_receipt_cannot_be_substituted(self):
        changed = copy.deepcopy(self.contract)
        changed['predecessorReadback']['commandId'] = '0' * 36
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_CHANGED'):
            P.validate(changed)


if __name__ == '__main__':
    unittest.main()
