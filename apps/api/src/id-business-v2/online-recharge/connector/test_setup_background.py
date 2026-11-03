import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from xml.etree import ElementTree as ET
import setup_background as setup

RUNTIME = setup.PROJECT / '.runtime/online-bitbrowser-website-only-20261103'


class BackgroundSetupTests(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        runner = self.root / 'apps/api/src/id-business-v2/online-recharge/connector/background_runner.py'
        runner.parent.mkdir(parents=True)
        runner.write_text('# synthetic fixture')
        self.pairing = {'serverUrl': 'https://fixture.example.invalid', 'pairingToken': 'a' * 43}

    def old_mac(self):
        path = self.home / 'Library/LaunchAgents' / (setup.LABEL + '.plist')
        path.parent.mkdir(parents=True)
        original = {'Label': setup.LABEL, 'ProgramArguments': [sys.executable,
            str(self.root / '.codex-worktrees/original/bitbrowser_connector.py'), '--port=55322',
            '--allowed-origin=https://old.example.invalid', '--token-file=' + str(self.root / 'old/connector.token')]}
        path.write_bytes(plistlib.dumps(original))
        return path, original

    def plan(self, platform='darwin'):
        python = Path(sys.executable)
        if platform == 'win32':
            python = self.root / 'venv/Scripts/python.exe'
            python.parent.mkdir(parents=True)
            python.with_name('pythonw.exe').write_text('synthetic')
        return setup.build_plan(self.root, self.home, platform, self.pairing['serverUrl'], python)

    def test_mac_reuses_identity_origin_and_loopback_key_path_without_copying_key(self):
        _, old = self.old_mac()
        plan = self.plan()
        args = plan['plist']['ProgramArguments']
        self.assertEqual(plan['plist']['Label'], setup.LABEL)
        self.assertIn(old['ProgramArguments'][-1], args)
        self.assertIn('--allowed-origin=https://old.example.invalid', args)
        self.assertTrue(plan['plist']['RunAtLoad'])
        self.assertTrue(plan['plist']['KeepAlive'])
        self.assertNotIn(self.pairing['pairingToken'], plistlib.dumps(plan['plist']).decode())

    def test_website_origin_is_strict_and_secrets_are_not_command_arguments(self):
        for origin in ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid?token=secret']:
            with self.assertRaises(setup.SetupError):
                setup.build_plan(self.root, self.home, 'darwin', origin, sys.executable)

    def test_windows_task_runs_hidden_for_logged_in_user_and_ignores_duplicate_starts(self):
        plan = self.plan('win32')
        data = setup.windows_task_xml(plan['python'], plan['runner'], plan['args'], self.root, 'FIXTURE\\User')
        tree = ET.fromstring(data)
        ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
        self.assertEqual(tree.find('.//t:LogonType', ns).text, 'InteractiveToken')
        self.assertEqual(tree.find('.//t:RunLevel', ns).text, 'LeastPrivilege')
        self.assertEqual(tree.find('.//t:MultipleInstancesPolicy', ns).text, 'IgnoreNew')
        self.assertTrue(tree.find('.//t:Command', ns).text.endswith('pythonw.exe'))
        self.assertNotIn(self.pairing['pairingToken'], data.decode('utf-16'))

    def test_busy_task_is_never_stopped_or_replaced(self):
        path, old = self.old_mac()
        run = Mock()
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(self.plan(), self.pairing, run=run, idle=Mock(side_effect=setup.SetupError('busy')))
        self.assertEqual(plistlib.loads(path.read_bytes()), old)
        run.assert_not_called()

    def test_pairing_failure_keeps_original_background_process(self):
        path, old = self.old_mac()
        run = Mock()
        plan = self.plan()
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(plan, self.pairing, run=run, idle=Mock(return_value=False), pair_client=Mock(side_effect=OSError('offline')))
        self.assertEqual(plistlib.loads(path.read_bytes()), old)
        self.assertEqual(os.stat(plan['runtime'] / 'device.json').st_mode & 0o777, 0o600)
        self.assertTrue(all(call.args[0][1] == 'print' for call in run.call_args_list))

    def test_success_replaces_only_the_same_mac_agent_after_pairing_and_idle_recheck(self):
        path, _ = self.old_mac()
        run = Mock(return_value=subprocess.CompletedProcess([], 0, '', ''))
        idle, pair = Mock(return_value=False), Mock()
        result = setup.apply_plan(self.plan(), self.pairing, run=run, idle=idle, pair_client=pair)
        self.assertTrue(result['configured'])
        self.assertEqual(idle.call_count, 2)
        pair.assert_called_once()
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ['print', 'bootout', 'bootstrap'])
        self.assertEqual(plistlib.loads(path.read_bytes())['Label'], setup.LABEL)

    def test_bootstrap_failure_restores_original_mac_startup(self):
        path, old = self.old_mac()
        failed = False
        def run(args):
            nonlocal failed
            if args[1] == 'bootstrap' and not failed:
                failed = True
                return subprocess.CompletedProcess(args, 1, '', '')
            return subprocess.CompletedProcess(args, 0, '', '')
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(self.plan(), self.pairing, run=run, idle=Mock(return_value=False), pair_client=Mock())
        self.assertEqual(plistlib.loads(path.read_bytes()), old)

    def test_existing_paired_identity_is_not_overwritten(self):
        plan = self.plan()
        setup.private_folder(plan['runtime'])
        original = b'{"serverUrl":"https://fixture.example.invalid","deviceKey":"synthetic-existing-device"}'
        (plan['runtime'] / 'device.json').write_bytes(original)
        run = Mock()
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(plan, self.pairing, run=run, idle=Mock(return_value=False), pair_client=Mock())
        self.assertEqual((plan['runtime'] / 'device.json').read_bytes(), original)
        self.assertTrue(all(call.args[0][1] == 'print' for call in run.call_args_list))

    def test_pairing_then_registration_failure_can_retry_with_same_credentials_on_both_platforms(self):
        for platform in ['darwin', 'win32']:
            with self.subTest(platform=platform):
                plan = self.plan(platform)
                config = plan['runtime'] / 'device.json'
                config.unlink(missing_ok=True)
                saved = {'serverUrl': self.pairing['serverUrl'],
                    'deviceId': '11111111-1111-4111-8111-111111111111', 'deviceKey': 'synthetic-' + 'k' * 43}
                exchanges, operations = [], []
                client = Mock()
                client.rpc.return_value = {}
                def pairing(path):
                    current = json.loads(path.read_text())
                    if 'pairingToken' in current:
                        exchanges.append(True)
                        path.write_text(json.dumps(saved))
                    return client
                failed = False
                def run(args):
                    nonlocal failed
                    operations.append(args)
                    if args[:2] in (['/bin/launchctl', 'print'], ['schtasks', '/Query']):
                        return subprocess.CompletedProcess(args, 1, '', '')
                    if not failed and (args[:2] == ['/bin/launchctl', 'bootstrap'] or '/Create' in args):
                        failed = True
                        return subprocess.CompletedProcess(args, 1, '', '')
                    return subprocess.CompletedProcess(args, 0, 'FIXTURE\\User' if args == ['whoami'] else '', '')
                with self.assertRaises(setup.SetupError):
                    setup.apply_plan(plan, self.pairing, run=run, idle=lambda *_: False, pair_client=pairing)
                original = config.read_bytes()
                result = setup.apply_plan(plan, self.pairing, run=run, idle=lambda *_: False, pair_client=pairing)
                self.assertTrue(result['configured'])
                self.assertTrue(result['reusedBinding'])
                self.assertEqual(config.read_bytes(), original)
                self.assertEqual(len(exchanges), 1)
                client.rpc.assert_called_once_with('connection')

    def test_resume_requires_valid_server_credentials_before_stopping_old_helper(self):
        path, old = self.old_mac()
        plan = self.plan()
        setup.private_folder(plan['runtime'])
        config = plan['runtime'] / 'device.json'
        config.write_text(json.dumps({'serverUrl': self.pairing['serverUrl'],
            'deviceId': '11111111-1111-4111-8111-111111111111', 'deviceKey': 'synthetic-' + 'k' * 43}))
        client = Mock()
        client.rpc.side_effect = OSError('synthetic revoked credentials')
        run = Mock(return_value=subprocess.CompletedProcess([], 0, '', ''))
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(plan, self.pairing, run=run, idle=lambda *_: False, pair_client=lambda _: client)
        self.assertEqual(plistlib.loads(path.read_bytes()), old)
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ['print'])

    def test_resume_never_replaces_binding_from_another_origin(self):
        plan = self.plan()
        setup.private_folder(plan['runtime'])
        config = plan['runtime'] / 'device.json'
        original = json.dumps({'serverUrl': 'https://other.example.invalid',
            'deviceId': '11111111-1111-4111-8111-111111111111', 'deviceKey': 'synthetic-' + 'k' * 43}).encode()
        config.write_bytes(original)
        pair = Mock()
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(plan, self.pairing, run=Mock(), idle=lambda *_: False, pair_client=pair)
        pair.assert_not_called()
        self.assertEqual(config.read_bytes(), original)

    def test_foreign_project_agent_is_never_rebound(self):
        path, old = self.old_mac()
        old['ProgramArguments'][1] = '/unrelated/project/assistant.py'
        path.write_bytes(plistlib.dumps(old))
        with self.assertRaises(setup.SetupError):
            self.plan()

    def test_windows_first_setup_limits_credentials_and_registers_only_current_user_task(self):
        def run(args):
            return subprocess.CompletedProcess(args, 1 if '/Query' in args else 0,
                'FIXTURE\\User' if args == ['whoami'] else '', '')
        run = Mock(side_effect=run)
        result = setup.apply_plan(self.plan('win32'), self.pairing, run=run, idle=Mock(return_value=False), pair_client=Mock())
        self.assertTrue(result['configured'])
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(sum(command[0] == 'icacls' for command in commands), 2)
        self.assertTrue(any(command[:2] == ['schtasks', '/Create'] for command in commands))
        self.assertTrue(any(command[:2] == ['schtasks', '/Run'] for command in commands))
        self.assertFalse(any('/End' in command for command in commands))

    def test_windows_foreign_task_is_not_stopped_or_overwritten(self):
        plan = self.plan('win32')
        xml = setup.windows_task_xml(plan['python'], plan['runner'], plan['args'], Path('C:/unrelated'), 'FIXTURE\\User').decode('utf-16')
        run = Mock(return_value=subprocess.CompletedProcess([], 0, xml, ''))
        pair = Mock()
        with self.assertRaises(setup.SetupError):
            setup.apply_plan(plan, self.pairing, run=run, idle=Mock(return_value=False), pair_client=pair)
        pair.assert_not_called()
        self.assertEqual(len(run.call_args_list), 1)

    def test_installed_exact_dependencies_do_not_change_running_runtime(self):
        lock = self.root / 'apps/api/src/id-business-v2/auto-recharge/worker/requirements-bitbrowser.lock.txt'
        lock.parent.mkdir(parents=True)
        lock.write_text('fixture-package==1.0\n')
        run = Mock()
        with patch.object(setup.importlib.metadata, 'version', return_value='1.0'):
            self.assertEqual(setup.ensure_runtime(self.root, run), Path(sys.executable))
        run.assert_not_called()

    def test_windows_xml_output_with_utf16_bom_is_decoded_without_losing_names(self):
        result = subprocess.CompletedProcess([], 0, '<Task>合成电脑</Task>'.encode('utf-16'), b'')
        with patch.object(setup.subprocess, 'run', return_value=result):
            self.assertEqual(setup.native_run(['synthetic']).stdout, '<Task>合成电脑</Task>')


if __name__ == '__main__':
    unittest.main()
