import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('online_recharge_transport', Path(__file__).with_name('online-recharge-readonly.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
RUNTIME = Path(__file__).resolve().parents[2] / '.runtime/online-recharge/release-tests'
RUNTIME.mkdir(parents=True, exist_ok=True)


class TransportTests(unittest.TestCase):
    def test_pins_all_controllers_before_executing_and_has_bounded_timeout(self):
        result = transport.parameters('a' * 40, 'b' * 40, 'preflight')
        self.assertEqual(result['executionTimeout'], ['300'])
        commands = result['commands']
        for name in ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py'):
            digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            self.assertEqual(sum(digest in item for item in commands), 1)
            self.assertTrue(any('/' + 'a' * 40 + '/scripts/production-release/' + name in item for item in commands))
        self.assertTrue(commands[-1].endswith('--online-recharge-preflight --expected-current ' + 'b' * 40))

    def test_command_injection_and_unscoped_action_are_rejected(self):
        for commit, expected, mode in [('$(touch x)', 'a' * 40, 'preflight'),
                ('a' * 40, 'b' * 40 + ';true', 'preflight'), ('a' * 40, 'b' * 40, 'release')]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                transport.parameters(commit, expected, mode)

    def test_duplicate_or_oversized_receipt_is_rejected(self):
        for value in ('{"status":1,"status":2}', '', 'x' * (256 * 1024 + 1)):
            with self.assertRaises(ValueError):
                transport.closed_json(value)

    def test_failure_projection_cannot_disclose_raw_credentials(self):
        value = {'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'code': 'API_ADMIN_BASELINE_PROJECTION_FAILED',
                 'errorType': 'RuntimeError', 'stderr': 'sensitive fixture', 'workerKey': 'sensitive fixture'}
        self.assertEqual(transport.safe_failure(value), {k: value[k] for k in ('status', 'code', 'errorType')})
        self.assertNotIn('sensitive fixture', json.dumps(transport.safe_failure({**value, 'code': 'sensitive fixture'})))

    def test_failed_or_invalid_deploy_never_records_success(self):
        cases = [
            {'Status': 'Failed', 'ResponseCode': 1, 'StandardOutputContent': json.dumps({
                'status': 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'code': 'ONLINE_RECHARGE_BACKUP_UNAVAILABLE'})},
            {'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': 'uncontrolled sensitive fixture'},
        ]
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            output = Path(folder)
            for value in cases:
                with redirect_stdout(io.StringIO()) as stream:
                    self.assertEqual(transport.filter_deploy(value, output), 1)
                self.assertNotIn('sensitive fixture', stream.getvalue())
                self.assertFalse((output / 'online-recharge-deploy-result.json').exists())

    def test_validated_deploy_receipt_is_saved_but_service_details_are_not_printed(self):
        value = {'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': '{"status":"ONLINE_RECHARGE_VERIFIED"}'}
        summary = {'status': 'ONLINE_RECHARGE_VERIFIED', 'services': {'api': {'containerId': 'a' * 64}}}
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder, patch.dict(transport.os.environ, RELEASE_COMMIT='b' * 40):
            with patch.object(transport, 'validate', return_value=summary) as validator, redirect_stdout(io.StringIO()) as stream:
                self.assertEqual(transport.filter_deploy(value, Path(folder)), 0)
            self.assertEqual(validator.call_args.args[1:4], ('readback', 'b' * 40, 'b' * 40))
            self.assertNotIn('containerId', stream.getvalue())
            self.assertEqual(json.loads((Path(folder) / 'online-recharge-deploy-result.json').read_text()), summary)


if __name__ == '__main__':
    unittest.main()
