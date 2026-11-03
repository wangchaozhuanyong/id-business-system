"""Pure control regressions. No AWS, database, browser or production command runs."""
import importlib.util
import inspect
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('window_controls', HERE / 'window-bitbrowser-release.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class Controls(unittest.TestCase):
    def test_existing_locked_recipe_gains_only_the_selected_engine_image(self):
        fn = R.configured_release({})
        text = repr(fn.__code__.co_consts)
        self.assertIn('COPY engine/ /workspace/engine/', text)
        self.assertIn('online-recharge', text)
        self.assertIn('latest_main', fn.__code__.co_names)
        self.assertIn('migrate', fn.__code__.co_names)
        self.assertIn('smoke', fn.__code__.co_names)

    def test_inherited_recipe_change_stops_before_native_execution(self):
        with patch.object(R.inspect, 'getsource', return_value='def release(plan):\n    pass\n'):
            with self.assertRaisesRegex(RuntimeError, 'INHERITED_RECIPE_CHANGED'):
                R.configured_release({})

    def test_only_the_exact_incremental_migration_state_is_accepted(self):
        c = {'migration': {'sha256': 'a' * 64}}
        R.verify_db({'pending': 0, 'applied': 0, 'checksum': None, 'tables': 0}, c)
        R.verify_db({'pending': 0, 'applied': 1, 'checksum': 'a' * 64, 'tables': 2}, c, True)
        for state in [{'pending': 1, 'applied': 0, 'checksum': None, 'tables': 0},
                {'pending': 0, 'applied': 1, 'checksum': 'b' * 64, 'tables': 2},
                {'pending': 0, 'applied': 0, 'checksum': None, 'tables': 1}]:
            with self.assertRaises(RuntimeError):
                R.verify_db(state, c)

    def test_migration_archive_belongs_to_this_exact_native_run(self):
        proof = {'commit': 'a' * 40, 'workflowRunId': '123', 'migrationTransport': {
            'file': 'window-bitbrowser-migration.tar.gz', 'sha256': 'b' * 64, 'bytes': 1,
            'imageId': 'sha256:' + 'c' * 64,
            'reference': '098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + 'a' * 40 + '-123-window-bitbrowser-migrate'}}
        self.assertEqual(R.verify_migration_transport(proof), proof['migrationTransport'])
        for key, value in [('file', 'recharge-plan-billing-migration.tar.gz'), ('reference', 'unrelated-image'), ('bytes', 0)]:
            with self.assertRaises(RuntimeError):
                R.verify_migration_transport({**proof, 'migrationTransport': {**proof['migrationTransport'], key: value}})

    def test_latest_retired_registration_guard_is_preserved(self):
        fn = R.configured_release({})
        helper = fn.__globals__['load']('recharge-record-release.py')
        self.assertIn('retired_guards', helper.guards.__code__.co_names)
        self.assertIs(fn.__globals__['verify_migration_transport'], R.verify_migration_transport)

    def test_grants_are_confined_to_two_new_tables_and_never_copy_passwords(self):
        d = Mock()
        d.compose.side_effect = lambda *args, **kwargs: json.dumps({'services': {'api': {'environment': {
            'DATABASE_URL': 'mysql://fixture_api:synthetic-private@mysql:3306/fixture_test'}}}}) if args[1:] == ('config', '--format', 'json') else ''
        driver = Mock()
        with patch.object(R, 'load', return_value=driver):
            R.migrate(d, Path('/synthetic'), {}, Path('/synthetic-journal'), 'fixture_test')
        sql = d.compose.call_args.kwargs['input_data']
        self.assertEqual(sql.count('GRANT SELECT, INSERT, UPDATE ON'), 2)
        self.assertIn('online_recharge_bitbrowser_devices', sql)
        self.assertIn('online_recharge_bitbrowser_states', sql)
        self.assertNotIn('DELETE', sql)
        self.assertNotIn('synthetic-private', repr(d.compose.call_args_list))
        driver.migrate.assert_called_once()

    def test_publication_uses_shared_single_release_lock_and_exact_main(self):
        source = (HERE / 'window-bitbrowser-publication.py').read_text()
        workflow = (HERE.parents[1] / '.github/workflows/window-bitbrowser-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('github.ref == \'refs/heads/main\'', workflow)
        self.assertGreaterEqual(source.count("refs/heads/main"), 2)
        self.assertIn('ISOLATED_DATABASE_VALIDATION_REQUIRED', source)
        self.assertIn("transport(plan, 'readback')", source)


if __name__ == '__main__':
    unittest.main()
