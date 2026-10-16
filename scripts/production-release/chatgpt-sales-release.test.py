"""Adversarial checks for the finite sale migration and native publication boundary."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = module('chatgpt-sales-release.py')
b = module('chatgpt-sales-build.py')
c = json.loads((HERE / 'chatgpt-sales-contract.json').read_bytes())


class SalesReleaseTests(unittest.TestCase):
    def test_source_hashes_and_dependency_baselines_are_exact(self):
        # A clean checkout is required in the native build; hashes are checked here
        # independently while the new release files are still being prepared.
        for n, expected in c['sources'].items():
            self.assertEqual(r.digest((HERE.parents[1] / n).read_bytes()), expected)

    def test_api_delta_rejects_unrelated_output_or_deleted_module(self):
        names = ['id-business-v2/auto-recharge/test.js']
        before = {names[0]: 'a', names[0] + '.map': 'b', names[0][:-3] + '.d.ts': 'c', 'other.js': 'd'}
        after = {**before, names[0]: 'changed'}
        self.assertEqual(len(b.api_delta(before, after, names)), 3)
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
            b.api_delta(before, {**after, 'other.js': 'changed'}, names)
        del after[names[0]]
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
            b.api_delta(before, after, names)

    def test_prisma_inferred_declarations_and_build_cache_are_not_published(self):
        name = 'id-business-v2/auto-recharge/test.js'
        before = {name: 'a', name + '.map': 'b', name[:-3] + '.d.ts': 'c',
                  'other.d.ts': 'old type', 'tsconfig.build.tsbuildinfo': 'old cache'}
        after = {**before, name: 'new runtime', 'other.d.ts': 'new type',
                 'tsconfig.build.tsbuildinfo': 'new cache'}
        allowed = b.api_delta(before, after, [name])
        self.assertNotIn('other.d.ts', allowed)
        self.assertNotIn('tsconfig.build.tsbuildinfo', allowed)
        with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
            b.api_delta(before, {**after, 'other.js.map': 'unexpected runtime map'}, [name])

    def applied(self):
        return {'pending': 0, 'columns': [
            {'COLUMN_NAME': 'sale_status', 'IS_NULLABLE': 'NO', 'COLUMN_TYPE': "enum('unsold','sold')", 'COLUMN_DEFAULT': 'unsold'},
            {'COLUMN_NAME': 'sold_at', 'IS_NULLABLE': 'YES', 'COLUMN_TYPE': 'datetime(6)', 'COLUMN_DEFAULT': None}],
            'indexes': ['deleted_at', 'sale_status', 'sold_at', 'id'],
            'rows': [{'checksum': c['migration']['sha256'], 'finished': True, 'rolledBack': False}]}

    def test_migration_readback_requires_exact_columns_default_index_and_checksum(self):
        r.check_migration(self.applied(), c, True)
        for change in ('default', 'index', 'checksum', 'pending'):
            state = self.applied()
            if change == 'default':
                state['columns'][0]['COLUMN_DEFAULT'] = 'sold'
            elif change == 'index':
                state['indexes'] = list(reversed(state['indexes']))
            elif change == 'checksum':
                state['rows'][0]['checksum'] = '0' * 64
            else:
                state['pending'] = 1
            with self.assertRaises(RuntimeError):
                r.check_migration(state, c, True)

    def test_partial_migration_cannot_be_blindly_applied_again(self):
        r.check_migration({'pending': 0, 'columns': [], 'rows': [], 'indexes': []}, c)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_BASELINE_CHANGED'):
            r.check_migration(self.applied(), c)

    def test_migration_query_keeps_column_names_and_binds_only_exact_name(self):
        d = Mock()
        d.compose.return_value = '{"pending":0}'
        r.migration_state(d, Path('/fixture'), c)
        code = d.compose.call_args.args[-1]
        self.assertIn('SELECT COLUMN_NAME,IS_NULLABLE,COLUMN_TYPE,COLUMN_DEFAULT', code)
        self.assertIn(json.dumps(c['migration']['name']), code)
        self.assertNotIn('__SALE_MIGRATION_JSON__', code)
        self.assertNotIn('UPDATE ', code)
        self.assertNotIn('DELETE ', code)

    def test_image_configuration_allows_only_labels_and_parent_marker(self):
        r.verify_image_configuration({'Env': ['A=B'], 'Labels': {'a': 'b'}, 'Image': 'sha256:' + 'a' * 64},
                                     {'Env': ['A=B'], 'Labels': {'a': 'c'}, 'Image': ''})
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONFIGURATION_CHANGED'):
            r.verify_image_configuration({'Env': ['A=B']}, {'Env': ['A=C']})

    def test_failed_recovery_guard_cannot_stop_services(self):
        d = Mock(unsafe=True)
        d.assert_no_active_recharge.side_effect = RuntimeError('active')
        with self.assertRaisesRegex(RuntimeError, 'active'):
            r.restore_runtime(d, Path('/before'), Path('/after'), {}, c, Mock())
        d.compose.assert_not_called()

    def test_payload_proof_requires_database_no_skips_and_exact_sources(self):
        plan = {k: 'fixture' for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256')}
        plan['qualityVerification'] = {'fixture': True}
        allowed = {n.removesuffix('.js') + ext: 'a' for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
        admin = {'assets/' + str(i) + '.js': 'b' for i in range(250)}
        files = {**{'source/' + n: v for n, v in c['sources'].items()},
                 **{'host/' + n: v for n, v in c['hostSources'].items()},
                 **{'api/modules/' + n: v for n, v in allowed.items()},
                 **{'admin/html/' + n: v for n, v in admin.items()}}
        proof = {**plan, 'version': 1, 'scope': c['scope'],
                 'baselineSources': {'api': c['apiSourceBaseline'], 'admin': c['adminSourceBaseline']},
                 'adminPublishedSources': c['adminPublishedSources'], 'hostSources': c['hostSources'],
                 'databaseVerification': {'isolated': True, 'migration': c['migration']['name'], 'legacyDefaultsVerified': True, 'testsPassed': 5, 'testsSkipped': 0, 'businessActions': 0},
                 'browserVerification': {'status': 'PASS', 'realWrites': 0}, 'updatedServices': ['api', 'admin'],
                 'migration': c['migration'], 'businessActions': 0, 'apiModules': allowed,
                 'baselineApiFiles': allowed, 'adminFiles': admin, 'baselineAdminFiles': admin, 'files': files}
        h = Mock()
        h.file_inventory.side_effect = lambda _: copy.deepcopy({**files, 'build-proof.json': 'c'})
        r.validate_proof(proof, plan, c, Path('/fixture'), h)
        for key in ('databaseVerification', 'files', 'baselineSources'):
            changed = copy.deepcopy(proof)
            if key == 'databaseVerification':
                changed[key]['testsSkipped'] = 1
            elif key == 'files':
                changed[key]['api/modules/unrelated.js'] = 'bad'
            else:
                changed[key]['api'] = 'bad'
            with self.assertRaises(RuntimeError):
                r.validate_proof(changed, plan, c, Path('/fixture'), h)


if __name__ == '__main__':
    unittest.main()
