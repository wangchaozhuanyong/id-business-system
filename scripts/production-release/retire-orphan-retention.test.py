import ast
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('retirement', Path(__file__).with_name('retire-orphan-retention.py'))
retirement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retirement)


def service_state():
    values = {key: '' for key in retirement.SERVICE_PROPERTIES}
    values.update({
        'Id': retirement.SERVICE, 'LoadState': 'loaded',
        'FragmentPath': str(retirement.UNIT_DIRECTORY / retirement.SERVICE),
        'Type': 'oneshot', 'User': 'root', 'Group': 'root',
        'ExecStart': '{ path=' + str(retirement.EXECUTABLE) + ' ; argv[]=' +
                     str(retirement.EXECUTABLE) + ' ; ignore_errors=no ; pid=0 ; code=exited ; status=203 }',
        'ActiveState': 'failed', 'SubState': 'failed', 'Result': 'exit-code',
        'ExecMainCode': '1', 'ExecMainStatus': '203', 'MainPID': '0', 'ControlPID': '0',
        'ExecMainStartTimestamp': 'Mon 2026-10-05 03:25:27 UTC',
        'ExecMainExitTimestamp': 'Mon 2026-10-05 03:25:27 UTC',
    })
    return values


def timer_state(retired=False):
    return {'Id': retirement.TIMER, 'LoadState': 'loaded',
            'FragmentPath': str(retirement.UNIT_DIRECTORY / retirement.TIMER),
            'Triggers': retirement.SERVICE, 'ActiveState': 'inactive' if retired else 'active',
            'SubState': 'dead' if retired else 'waiting',
            'UnitFileState': 'disabled' if retired else 'enabled'}


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.root = patch.object(retirement.os, 'geteuid', return_value=0)
        self.missing = patch.object(Path, 'exists', return_value=False)
        self.no_link = patch.object(Path, 'is_symlink', return_value=False)
        self.identity = patch.object(retirement, 'unit_identity', return_value='a' * 64)
        for item in (self.root, self.missing, self.no_link, self.identity):
            item.start()
            self.addCleanup(item.stop)

    def snapshots(self, service=None, timer=None, after_service=None, after_timer=None):
        service = service or service_state()
        timer = timer or timer_state()
        return [copy.deepcopy(value) for value in (
            service, timer, service, timer,
            after_service or service, after_timer or timer_state(retired=True))]

    def test_default_preview_is_readonly_and_suppresses_raw_execstart(self):
        with patch.object(retirement, 'properties', side_effect=[service_state(), timer_state()]), \
                patch.object(retirement, 'command') as mutation:
            result = retirement.retire()
        mutation.assert_not_called()
        self.assertEqual(result['status'], 'LEGACY_RETENTION_CONFIRMED_READY_TO_RETIRE')
        self.assertEqual(result['timerMutations'], 0)
        self.assertNotIn('ExecStart', result['serviceFailureBefore'])

    def test_apply_disables_only_the_one_timer_and_preserves_failure_metadata(self):
        with patch.object(retirement, 'properties', side_effect=self.snapshots()), \
                patch.object(retirement, 'command') as mutation:
            result = retirement.retire(True)
        mutation.assert_called_once_with('systemctl', 'disable', '--now', retirement.TIMER)
        self.assertEqual(result['timerMutations'], 1)
        self.assertEqual(result['serviceFailureBefore'], result['serviceFailureAfter'])
        self.assertEqual(result['timerAfter']['UnitFileState'], 'disabled')
        for field in ('deletedFiles', 'databaseWrites', 'backupsDeleted', 'unitsDeleted'):
            self.assertEqual(result[field], 0)
        self.assertFalse(result['failureHistoryReset'])

    def test_already_retired_repeat_has_no_mutation(self):
        with patch.object(retirement, 'properties', side_effect=[service_state(), timer_state(True)]), \
                patch.object(retirement, 'command') as mutation:
            result = retirement.retire(True)
        mutation.assert_not_called()
        self.assertEqual(result['status'], 'LEGACY_RETENTION_ALREADY_RETIRED')

    def test_pristine_environment_with_no_legacy_units_is_safe(self):
        absent_service, absent_timer = service_state(), timer_state()
        absent_service['LoadState'] = absent_timer['LoadState'] = 'not-found'
        with patch.object(retirement, 'properties', side_effect=[absent_service, absent_timer]), \
                patch.object(retirement, 'command') as mutation:
            result = retirement.retire(True)
        mutation.assert_not_called()
        self.assertEqual(result['status'], 'LEGACY_RETENTION_UNITS_ABSENT')

    def test_running_service_and_changed_failure_or_ownership_are_rejected(self):
        for field, value in (
            ('ActiveState', 'active'), ('SubState', 'running'), ('MainPID', '123'),
            ('ControlPID', '123'), ('Result', 'success'), ('ExecMainStatus', '0'),
            ('ExecMainStatus', '254'), ('ExecMainCode', '2'), ('Type', 'simple'),
            ('User', 'other'), ('Group', 'other'), ('LoadState', 'not-found'),
        ):
            with self.subTest(field=field, value=value):
                state = service_state()
                state[field] = value
                with patch.object(retirement, 'properties', side_effect=[state, timer_state()]), \
                        patch.object(retirement, 'command') as mutation:
                    with self.assertRaises(RuntimeError):
                        retirement.retire(True)
                mutation.assert_not_called()

    def test_execstart_alternate_path_arguments_and_multiple_commands_are_rejected(self):
        for value in (
            service_state()['ExecStart'].replace(str(retirement.EXECUTABLE), '/bin/sh'),
            service_state()['ExecStart'].replace(' ; ignore_errors=', ' PRIVATE_TOKEN ; ignore_errors='),
            service_state()['ExecStart'] + service_state()['ExecStart'],
        ):
            state = service_state()
            state['ExecStart'] = value
            with patch.object(retirement, 'properties', side_effect=[state, timer_state()]), \
                    patch.object(retirement, 'command') as mutation:
                with self.assertRaises(RuntimeError) as error:
                    retirement.retire(True)
                self.assertNotIn('PRIVATE_TOKEN', str(error.exception))
            mutation.assert_not_called()

    def test_restored_executable_or_dangling_symlink_prevents_retirement(self):
        for kind in ('exists', 'is_symlink'):
            with self.subTest(kind=kind), patch.object(Path, kind, return_value=True), \
                    patch.object(retirement, 'properties', side_effect=[service_state(), timer_state()]), \
                    patch.object(retirement, 'command') as mutation:
                with self.assertRaisesRegex(RuntimeError, 'executable exists'):
                    retirement.retire(True)
                mutation.assert_not_called()

    def test_other_timer_target_running_lifecycle_and_masked_state_are_rejected(self):
        for field, value in (('Triggers', 'other.service'), ('Triggers', retirement.SERVICE + ' other.service'),
                             ('ActiveState', 'activating'), ('UnitFileState', 'masked')):
            state = timer_state()
            state[field] = value
            with patch.object(retirement, 'properties', side_effect=[service_state(), state]), \
                    patch.object(retirement, 'command') as mutation:
                with self.assertRaisesRegex(RuntimeError, 'timer scope'):
                    retirement.retire(True)
            mutation.assert_not_called()

    def test_state_change_before_mutation_fails_closed(self):
        states = self.snapshots()
        states[2]['ExecMainExitTimestamp'] = 'changed'
        with patch.object(retirement, 'properties', side_effect=states), \
                patch.object(retirement, 'command') as mutation:
            with self.assertRaisesRegex(RuntimeError, 'state changed before'):
                retirement.retire(True)
        mutation.assert_not_called()

    def test_unit_bytes_change_before_mutation_fails_closed(self):
        with patch.object(retirement, 'properties', side_effect=self.snapshots()), \
                patch.object(retirement, 'unit_identity', side_effect=['a' * 64, 'a' * 64, 'b' * 64, 'a' * 64]), \
                patch.object(retirement, 'command') as mutation:
            with self.assertRaisesRegex(RuntimeError, 'state changed before'):
                retirement.retire(True)
        mutation.assert_not_called()

    def test_postcondition_failure_is_reported_without_reset_or_reenable(self):
        state = timer_state()
        with patch.object(retirement, 'properties', side_effect=self.snapshots(after_timer=state)), \
                patch.object(retirement, 'command') as mutation:
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                retirement.retire(True)
        mutation.assert_called_once_with('systemctl', 'disable', '--now', retirement.TIMER)

    def test_non_root_is_rejected_before_reading_units(self):
        with patch.object(retirement.os, 'geteuid', return_value=1000), \
                patch.object(retirement, 'properties') as inspection:
            with self.assertRaisesRegex(RuntimeError, 'run as root'):
                retirement.retire(True)
        inspection.assert_not_called()

    def test_private_command_errors_are_suppressed(self):
        result = SimpleNamespace(returncode=1, stdout='PRIVATE_TOKEN', stderr='PRIVATE_TOKEN')
        with patch.object(retirement.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as error:
                retirement.command('systemctl', 'show')
        self.assertNotIn('PRIVATE_TOKEN', str(error.exception))

    def test_property_reader_rejects_duplicate_missing_or_unknown_properties(self):
        good = '\n'.join(key + '=' + value for key, value in timer_state().items())
        for output in (good + '\nId=' + retirement.TIMER, good.replace('Triggers=', 'PRIVATE_TOKEN='),
                       '\n'.join(good.splitlines()[:-1])):
            with patch.object(retirement, 'command', return_value=output):
                with self.assertRaises(RuntimeError) as error:
                    retirement.properties(retirement.TIMER, retirement.TIMER_PROPERTIES)
                self.assertNotIn('PRIVATE_TOKEN', str(error.exception))

    def test_cli_has_only_fixed_apply_option_and_one_mutation(self):
        source = Path(__file__).with_name('retire-orphan-retention.py').read_text()
        tree = ast.parse(source)
        flags = [node.args[0].value for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and node.func.attr == 'add_argument']
        self.assertEqual(flags, ['--apply'])
        mutations = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name) and node.func.id == 'command'
                     and node.args and isinstance(node.args[0], ast.Constant)
                     and node.args[0].value == 'systemctl' and len(node.args) > 1
                     and isinstance(node.args[1], ast.Constant) and node.args[1].value != 'show']
        self.assertEqual(len(mutations), 1)
        self.assertEqual([arg.value for arg in mutations[0].args[:3]], ['systemctl', 'disable', '--now'])
        for prohibited in ('reset-failed', 'unlink(', 'rmtree(', 'DELETE FROM', 'rm', 'GRANT '):
            # Look for literal command/operation tokens, not substrings in English.
            self.assertNotIn("'" + prohibited + "'", source)


class UnitIdentityTests(unittest.TestCase):
    def test_fragment_identity_reads_bounded_root_owned_regular_unit(self):
        status = SimpleNamespace(st_uid=0, st_mode=0o100644, st_size=12, st_ino=1, st_mtime_ns=1)
        path = MagicMock()
        path.is_file.return_value = True
        path.is_symlink.return_value = False
        path.stat.return_value = status
        path.read_bytes.return_value = b'[Unit]\n'
        path.__str__.return_value = '/etc/systemd/system/' + retirement.SERVICE
        directory = MagicMock()
        directory.__truediv__.return_value = path
        state = service_state()
        with patch.object(retirement, 'UNIT_DIRECTORY', directory):
            digest = retirement.unit_identity(retirement.SERVICE, state)
        self.assertEqual(len(digest), 64)

    def test_wrong_fragment_symlink_permissions_owner_and_size_fail_closed(self):
        for condition in ('path', 'symlink', 'group-write', 'owner', 'size'):
            with self.subTest(condition=condition):
                status = SimpleNamespace(st_uid=1000 if condition == 'owner' else 0,
                    st_mode=0o100664 if condition == 'group-write' else 0o100644,
                    st_size=16385 if condition == 'size' else 12, st_ino=1, st_mtime_ns=1)
                path = MagicMock()
                path.is_file.return_value = True
                path.is_symlink.return_value = condition == 'symlink'
                path.stat.return_value = status
                path.__str__.return_value = '/other' if condition == 'path' else '/etc/systemd/system/' + retirement.SERVICE
                directory = MagicMock()
                directory.__truediv__.return_value = path
                state = service_state()
                with patch.object(retirement, 'UNIT_DIRECTORY', directory):
                    with self.assertRaises(RuntimeError):
                        retirement.unit_identity(retirement.SERVICE, state)
                path.read_bytes.assert_not_called()


if __name__ == '__main__':
    unittest.main()
