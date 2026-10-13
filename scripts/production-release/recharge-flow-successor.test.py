import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent


def load():
    spec = importlib.util.spec_from_file_location('test_recharge_successor', HERE / 'recharge-flow-successor.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SuccessorProtectionTests(unittest.TestCase):
    def setUp(self):
        self.core = load()

    def test_only_two_services_and_original_single_migration(self):
        self.assertEqual(self.core.UPDATED, ('api', 'admin'))
        self.assertEqual(self.core.IMAGE_SERVICES, ('api', 'admin', 'migrate'))
        self.assertEqual(self.core.MIGRATION_NAME, '20261012143000_recharge_connection_profiles')
        self.assertEqual(self.core.MIGRATION_TABLE, 'id_business_v2_recharge_connection_profiles')
        self.assertNotIn('auto-recharge', self.core.UPDATED)

    def test_missing_fault_approval_stops_before_source_database_or_container_work(self):
        class Never:
            def __getattr__(self, _):
                raise AssertionError('No release operation may run')
        with self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
            self.core.release(Never(), SimpleNamespace(api_fault_restore_approved=False), {}, {})

    def test_original_only_table_grants_contract_is_retained(self):
        text = (HERE / 'unpublished-component-successor.py').read_text()
        self.assertIn('preservedGrantsSha256', text)
        self.assertIn('schemaGrantsSha256', text)
        self.assertIn('newTablePrivileges', text)
        self.assertEqual(self.core.MIGRATION_IDENTITY['sha256'],
                         'b382d3207ebbffc19b07d28243505ea2d1846529d49bfe906cb07fceb8c7d53e')

    def test_prepare_cli_forwards_real_argv_not_a_fake_driver(self):
        with patch.object(self.core.reused, 'cli', return_value={'status': 'synthetic'}) as cli:
            self.assertEqual(self.core.cli(['prepare']), {'status': 'synthetic'})
            cli.assert_called_once_with()

    def test_image_label_binds_complete_projection_record(self):
        record = {'version': 1, 'scope': self.core.projection.SCOPE, 'contexts': {'api': {}, 'admin': {}}}
        record['projectionSha256'] = self.core.fingerprint(record)
        self.assertNotEqual(record['projectionSha256'], self.core.fingerprint(record))
        shell = (HERE / 'validate-release-selection.sh').read_text()
        body = shell.split('read_recharge_flow_projection() {', 1)[1].split('PY_RECHARGE_FLOW\n}', 1)[0]
        self.assertIn('print(core.fingerprint(record))', body)
        self.assertNotIn("print(record['projectionSha256'])", body)


if __name__ == '__main__':
    unittest.main()
