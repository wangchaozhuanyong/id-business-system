import base64
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shlex
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent


def load():
    spec = importlib.util.spec_from_file_location('test_recharge_transport', HERE / 'recharge-flow-successor-readonly.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RechargeTransportTests(unittest.TestCase):
    def setUp(self):
        self.r = load()
        self.env = {'AWS_REGION': self.r.reused.REGION, 'PRODUCTION_INSTANCE_ID': self.r.reused.INSTANCE,
            'RELEASE_OPERATION': 'verify_recharge_flow', 'EXPECTED_CURRENT': self.r.core.projection.ADMIN_COMMIT,
            'RELEASE_COMMIT': 'a' * 40, 'SOURCE_TREE': 'b' * 40, 'GITHUB_RUN_ID': '123',
            'GITHUB_RUN_ATTEMPT': '1', 'HISTORICAL_EXCEPTION': 'none', 'API_FAULT_RESTORE_APPROVED': 'false'}

    def test_verify_needs_no_fault_approval_and_cannot_turn_into_release(self):
        with patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(self.r.selected('preflight')[1]['commit'], 'a' * 40)
            with self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
                self.r.selected('release')
            with self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
                self.r.selected('readback')

    def test_approved_release_requires_exact_finite_selection(self):
        env = {**self.env, 'RELEASE_OPERATION': 'release_recharge_flow', 'API_FAULT_RESTORE_APPROVED': 'true'}
        with patch.dict(os.environ, env, clear=True):
            self.r.selected('release')
        for change in ({'EXPECTED_CURRENT': 'c' * 40}, {'REUSE_IMAGE_RUN': '123'},
                       {'HISTORICAL_EXCEPTION': 'historical-finance-20261005'},
                       {'RELEASE_OPERATION': 'release_unpublished_components'}, {'CACHE_PLAN_SHA256': 'd' * 64}):
            with self.subTest(change=change), patch.dict(os.environ, {**env, **change}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
                    self.r.selected('release')

    def test_carrier_retargets_only_execution_entry_and_preserves_proof_arguments(self):
        program = 'sys.argv=["/opt/id-business-v2/.staging/oidc-a/unpublished-component-successor.py","release","--api-fault-restore-approved"]'
        packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
        carrier = 'import base64,gzip;exec(compile(gzip.decompress(base64.b64decode(' + repr(packed) + ',validate=True)),"<test>","exec"))'
        original = {'commands': ['python3 -B -c ' + shlex.quote(carrier)], 'executionTimeout': ['3600']}
        with patch.object(self.r, 'original_parameters', return_value=original) as params:
            result = self.r.parameters('release', (b'proof', b'preflight'))
            params.assert_called_once_with('release', input_artifacts=(b'proof', b'preflight'))
        self.assertEqual(result['executionTimeout'], ['3600'])
        args = shlex.split(result['commands'][0])
        captured = {}
        import ast
        tree = ast.parse(args[3])
        encoded = next(node.args[0].value for node in ast.walk(tree) if isinstance(node, ast.Call)
                       and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode')
        rewritten = gzip.decompress(base64.b64decode(encoded)).decode()
        self.assertIn('/recharge-flow-successor.py', rewritten)
        self.assertIn('--api-fault-restore-approved', rewritten)
        self.assertNotIn('/unpublished-component-successor.py', rewritten)

    def test_unexpected_carrier_cannot_be_executed(self):
        with patch.object(self.r, 'original_parameters', return_value={'commands': ['bash -c unsafe']}):
            with self.assertRaisesRegex(RuntimeError, 'TRANSPORT_PARAMETERS_CHANGED'):
                self.r.parameters('preflight')

    def test_restart_native_pin_validation_uses_historical_helpers_only(self):
        self.assertEqual(len(self.r.historical_core.HELPERS), 10)
        self.assertGreater(len(self.r.core.HELPERS), 10)
        with patch.object(self.r, 'original_restart_validation', return_value='native-verified') as check:
            self.assertEqual(self.r.validate_restart_material(self.r.core, b'q', b'commands'), 'native-verified')
            check.assert_called_once_with(self.r.historical_core, b'q', b'commands')

    def historical_fixtures(self):
        spec = importlib.util.spec_from_file_location('recharge_historical_fixtures', HERE / 'unpublished-component-successor-readonly.test.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_original_native_restart_receipt_validates_with_future_helper_set(self):
        fixtures = self.historical_fixtures()
        raw_get, raw_list = fixtures.actual_restart_bytes()
        receipt, pins = self.r.validate_restart_material(self.r.core, raw_get, raw_list)
        self.assertEqual(receipt['status'], 'SAME_CONTAINER_RESTART_VERIFIED')
        self.assertEqual(set(pins), set(self.r.historical_core.HELPERS))
        self.assertNotEqual(set(pins), set(self.r.core.HELPERS))
        with self.assertRaisesRegex(RuntimeError, 'RESTART_SOURCE_PINS_CHANGED'):
            self.r.original_restart_validation(self.r.core, raw_get, raw_list)

    def test_only_exact_sealed_restart_reads_fix_the_subprocess_timezone(self):
        before_env = dict(os.environ)
        command_id = self.r.reused.NATIVE_RESTART_AUTHORITY['commandId']
        prefix = ('aws', '--region', self.r.reused.REGION, 'ssm')
        reads = (
            (*prefix, 'get-command-invocation', '--command-id', command_id,
             '--instance-id', self.r.reused.INSTANCE, '--output', 'json'),
            (*prefix, 'list-commands', '--command-id', command_id, '--output', 'json'),
        )
        fixtures = self.historical_fixtures()
        with patch.object(self.r, 'original_command_raw', side_effect=fixtures.actual_restart_bytes()) as command:
            raw_get, raw_list = (self.r.command_raw(*args) for args in reads)
        self.assertEqual(command.call_args_list[0].args, ('env', 'TZ=Asia/Kuala_Lumpur', *reads[0]))
        self.assertEqual(command.call_args_list[1].args, ('env', 'TZ=Asia/Kuala_Lumpur', *reads[1]))
        self.r.validate_restart_material(self.r.core, raw_get, raw_list)
        self.assertEqual(dict(os.environ), before_env)
        others = (
            (*prefix, 'list-commands', '--command-id', '11111111-2222-4333-8444-555555555555', '--output', 'json'),
            (*prefix, 'get-command-invocation', '--command-id', command_id,
             '--instance-id', 'i-00000000000000000', '--output', 'json'),
            ('aws', '--region', self.r.reused.REGION, 'ssm', 'send-command'),
            ('git', 'ls-remote', 'origin', 'refs/heads/main'),
        )
        for args in others:
            with self.subTest(args=args), patch.object(self.r, 'original_command_raw', return_value=b'unchanged') as command:
                self.assertEqual(self.r.command_raw(*args, optional=True), b'unchanged')
                command.assert_called_once_with(*args, optional=True)
        with patch.object(self.r, 'original_command_raw', side_effect=RuntimeError('UNPUBLISHED_COMPONENT_TRANSPORT_UNAVAILABLE')):
            with self.assertRaisesRegex(RuntimeError, 'UNPUBLISHED_COMPONENT_TRANSPORT_UNAVAILABLE'):
                self.r.command_raw(*reads[1])

    def test_timezone_compatibility_never_admits_unsealed_bytes(self):
        fixtures = self.historical_fixtures()
        raw_get, raw_list = fixtures.actual_restart_bytes()
        utc = raw_list.replace(b'2026-10-13T14:30:50.542000+08:00', b'2026-10-13T06:30:50.542000+00:00')
        utc = utc.replace(b'2026-10-13T14:39:50.542000+08:00', b'2026-10-13T06:39:50.542000+00:00')
        self.assertNotEqual(utc, raw_list)
        with self.assertRaisesRegex(RuntimeError, 'RESTART_NATIVE_BYTES_CHANGED'):
            self.r.validate_restart_material(self.r.core, raw_get, utc)
        with self.assertRaisesRegex(RuntimeError, 'RESTART_NATIVE_BYTES_CHANGED'):
            self.r.validate_restart_material(self.r.core, raw_get, raw_list + b' ')

    def test_real_carrier_uses_supplied_bytes_without_reopening_local_artifacts(self):
        fixtures = self.historical_fixtures()
        origin = fixtures.Boundaries()
        origin.setUp()
        env = {**self.env, 'RELEASE_OPERATION': 'release_recharge_flow', 'API_FAULT_RESTORE_APPROVED': 'true',
               'QUALITY_RUN_ID': '456', 'RELEASE_REPOSITORY': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'}
        transport_raw = b'{"fixture":"one read immutable preflight"}\n'
        transport = json.loads(transport_raw)
        proof = {'scope': self.r.core.BUILD_SCOPE, 'commit': env['RELEASE_COMMIT'],
                 'sourceTree': env['SOURCE_TREE'], 'runId': env['GITHUB_RUN_ID'], 'runAttempt': '1',
                 'qualityRunId': '456', 'preflightSha256': self.r.core.fingerprint(transport)}
        proof_raw = json.dumps(proof, indent=2).encode() + b'\n'
        with patch.dict(os.environ, env, clear=True), patch.object(self.r.core, 'BASELINE_CONTRACT', origin.contract), \
                patch.object(self.r.core, 'local_preflight') as local_preflight, \
                patch.object(self.r.core, 'private_bytes', side_effect=AssertionError('Input artifacts must not be read again')), \
                patch.object(self.r.reused, 'command_raw', return_value=origin.raw), \
                patch.object(self.r.reused, 'restart_origin_bytes', return_value=fixtures.actual_restart_bytes()):
            parameters = self.r.parameters('release', (proof_raw, transport_raw))
        local_preflight.assert_called_once()
        self.assertEqual(local_preflight.call_args.args[0], transport)
        import ast
        carrier = ast.parse(shlex.split(parameters['commands'][0])[3])
        encoded = next(node.args[0].value for node in ast.walk(carrier) if isinstance(node, ast.Call)
                       and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode')
        program = gzip.decompress(base64.b64decode(encoded)).decode()
        call = next(node for node in ast.walk(ast.parse(program)) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == 'read_input_bundle')
        plan = ast.literal_eval(call.args[0])
        producer = self.r.core.producer(env['RELEASE_COMMIT'], env['SOURCE_TREE'], '123', '1')
        expected, _ = self.r.reused.input_bundle(producer, proof_raw, transport_raw)
        self.assertEqual(plan, expected)
        self.assertIn('/recharge-flow-successor.py', program)
        self.assertLess(len(json.dumps(parameters).encode()), 20 * 1024)


if __name__ == '__main__':
    unittest.main()
