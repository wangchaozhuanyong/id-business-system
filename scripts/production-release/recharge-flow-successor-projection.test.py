"""Offline finite-source regression; no production reader or business action."""
import copy
import ast
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
ROOT = HERE.parent.parent


def load(filename):
    spec = importlib.util.spec_from_file_location('test_recharge_projection', HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FiniteProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = load('recharge-flow-successor.py')
        cls.p = cls.core.projection
        cls.d = cls.core.reused.modules()[0]
        cache = {}
        def archive(commit):
            if commit not in cache:
                cache[commit] = subprocess.check_output(['git', 'archive', '--format=tar',
                    '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
            return cache[commit]
        cls.d.registration_download = archive
        cls.spec = cls.p.contract()
        cls.candidate = cls.d.registration_archive(archive(cls.p.BUSINESS_COMMIT), cls.p.BUSINESS_COMMIT)
        for path, row in cls.spec['approvedTestChanges'].items():
            cls.candidate[path] = ((ROOT / path).read_bytes(), row['after']['mode'])
        cls.tree = cls.p.source_tree(cls.candidate)
        cls.output, cls.record = cls.p.project_sources(cls.d, cls.candidate, cls.p.BUSINESS_COMMIT, cls.tree)

    def project(self, candidate):
        return self.p.project_sources(self.d, candidate, self.p.BUSINESS_COMMIT, self.p.source_tree(candidate))

    def test_actual_dual_baselines_and_finite_changes(self):
        self.p.verify_output(self.output, self.record)
        self.assertEqual(set(self.record['contexts']), {'api', 'admin'})
        for role in ('api', 'admin'):
            allowed = {path for path in self.spec['businessFiles']
                       if path.startswith('apps/' + role + '/') or path == 'packages/shared/src/v2/auto-recharge.ts'}
            allowed.update(self.spec['prerequisites'][role])
            if role == 'api':
                allowed.update((self.core.MIGRATION_SCHEMA, self.core.MIGRATION_ROOT + '/' + self.core.MIGRATION_FILE))
            self.assertLessEqual(set(self.record['contexts'][role]['changedFiles']), allowed)
            self.assertEqual(self.record['contexts'][role]['baseCommit'], self.spec['baseline'][role]['commit'])
        self.assertEqual(self.p.digest(self.output['api/' + self.core.MIGRATION_SCHEMA][0]),
                         self.core.MIGRATION_IDENTITY['schemaAfterSha256'])
        self.assertNotEqual(self.record['contexts']['api']['outputTree'], self.record['contexts']['admin']['outputTree'])

    def test_unrelated_main_application_change_is_rejected(self):
        changed = dict(self.candidate)
        path = 'apps/api/src/main.ts'
        changed[path] = (changed[path][0] + b'\n// unexpected main change\n', changed[path][1])
        with self.assertRaisesRegex(RuntimeError, 'UNRELATED_APPLICATION_SOURCE_CHANGED'):
            self.project(changed)

    def test_frozen_recharge_bytes_cannot_drift(self):
        changed = dict(self.candidate)
        path = 'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts'
        changed[path] = (changed[path][0] + b'\n', changed[path][1])
        with self.assertRaisesRegex(RuntimeError, 'BUSINESS_SOURCE_CHANGED'):
            self.project(changed)

    def test_connection_prerequisite_bytes_cannot_drift(self):
        changed = dict(self.candidate)
        path = next(iter(self.spec['prerequisites']['api']))
        changed[path] = (changed[path][0] + b'\n', changed[path][1])
        with self.assertRaisesRegex(RuntimeError, 'UNRELATED_APPLICATION_SOURCE_CHANGED|PREREQUISITE_SOURCE_CHANGED'):
            self.project(changed)

    def test_fake_projection_seal_and_changed_output_are_rejected(self):
        record = copy.deepcopy(self.record)
        record['contexts']['api']['baseCommit'] = self.p.ADMIN_COMMIT
        with self.assertRaisesRegex(RuntimeError, 'PROJECTION_CHANGED'):
            self.p.validate_record(record)
        output = dict(self.output)
        output['api/package.json'] = (b'{}', '100644')
        with self.assertRaisesRegex(RuntimeError, 'OUTPUT_CHANGED'):
            self.p.verify_output(output, self.record)

    def test_original_source_and_history_seals_remain_separate(self):
        original = load('unpublished-component-successor.py')
        historical = ast.parse(subprocess.check_output(['git', 'show',
            'dbec7e0b08c989b9b4e7ba02ef5eae2bfc728746:scripts/production-release/unpublished-component-successor.py'], cwd=ROOT))
        def frozen(name):
            return next(ast.literal_eval(node.value) for node in historical.body
                if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                    and target.id == name for target in node.targets))
        self.assertEqual(frozen('APPLICATION_SOURCE'), 'a019e794fd6b3313fa312ad5a08fa4559f876d18')
        self.assertEqual(frozen('APPROVED_APPLICATION_INPUT_SHA256'),
                         '4b255d3214fed5825fe98e8fb337feba51c7247f63e38a573003d28c3e84b126')
        self.assertNotEqual(original.APPLICATION_SOURCE, frozen('APPLICATION_SOURCE'))
        self.assertNotEqual(original.SCOPE, self.core.SCOPE)
        self.assertEqual(original.BASELINE_CONTRACT, self.core.BASELINE_CONTRACT)
        self.assertEqual(original.MIGRATION_IDENTITY, self.core.MIGRATION_IDENTITY)

    def test_runtime_schema_is_only_original_449_model_extension(self):
        runtime = self.p.runtime_config_files(self.d, self.candidate, self.record)
        self.assertEqual(set(runtime), set(self.p.RUNTIME_FILES))
        self.assertEqual(self.p.digest(runtime[self.core.MIGRATION_SCHEMA][0]),
                         self.core.MIGRATION_IDENTITY['schemaAfterSha256'])
        self.assertNotIn('apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts', runtime)


if __name__ == '__main__':
    unittest.main()
