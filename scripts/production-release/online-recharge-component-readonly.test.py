"""Pure closed-scope tests: no AWS, Docker, services, browser or database."""
import base64
import ast
from contextlib import contextmanager
import copy
import gzip
import importlib.util
import json
import os
import runpy
from pathlib import Path
import shlex
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

PATH = Path(__file__).with_name('online-recharge-component-readonly.py')
spec = importlib.util.spec_from_file_location('online_component_transport_test', PATH)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
P = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}
OLD = 'c' * 40
COMMAND = '11111111-1111-4111-8111-111111111111'
INSTANCE = 'i-0123456789abcdef0'
ORIGIN_RECEIPT = {'scope': 'UNPUBLISHED_API_ADMIN_COMPONENT_SUCCESSOR', 'status': 'UNPUBLISHED_COMPONENT_VERIFIED'}
ORIGIN = json.dumps({'synthetic': 'ended native fixture'}).encode()
AUTHORITY = {'producer': {'commit': OLD}, 'instanceId': INSTANCE, 'commandId': COMMAND,
             'invocationBytesSha256': client.r.c.digest(ORIGIN),
             'receiptSha256': client.r.c.fingerprint(ORIGIN_RECEIPT), 'coreSha256': 'd' * 64}
ENV = {'RELEASE_OPERATION': 'release_online_recharge', 'EXPECTED_CURRENT': OLD,
       'RELEASE_COMMIT': P['commit'], 'SOURCE_TREE': P['sourceTree'], 'GITHUB_RUN_ID': '123',
       'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_ACTIONS': 'true',
       'AWS_REGION': 'ap-northeast-1', 'PRODUCTION_INSTANCE_ID': INSTANCE,
       'API_FAULT_RESTORE_APPROVED': 'true', 'HISTORICAL_EXCEPTION': 'none',
       'RELEASE_ADMIN_ONLY': 'false', 'QUALITY_RUN_ID': '456',
       'RELEASE_REPOSITORY': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'}

# Authenticated 43 public baseline shape. Future preflight values are sizing
# sentinels; this compressed fixture contains no native invocation or authority.
REAL43_PUBLIC_SIZING_FRAME = (
    'H4sIAAAAAAAC/+2aWW9bR5qG/4uAQW4iu/bFV63YSrcxji3Y7jR6GgOhVpkTitQcks44gf/7PEVqobWk1dPwzFzEsGGL5/BU1Vfv'
    '9y51/OvBcpqdzRZpfjIt/6OV9Wy5ePchKesOnh1Er7WwSYpYhDBGRtOCM1KnUFruucqaSki+1uyNrLH3klzprUVhVZMlHHx7MLXS'
    'Zhfr75fTu9kvs8XZm8X808GzXw/SxcV8VtIY7uXiYrO+HrOYzjer9TYII1WM0UTdRIi2p25LlMpJWUsJTC7l3lvmR9tVSk0IZzJj'
    '5rRq89miXY/T6ou0TuPj8VFZLha7hbLkPpvv3/fD7GzaTmp1PSETdIpBhi6bFcJmWYpRSZrck+xBclNMmRW3VIXTSTqdhUlei956'
    'd3JMaJHOGeRACeYupJJGCyFOKc2HNJ2105sJnV7sZrTiS6vyoZ2nH9s060zs4Nl62jQ+vZpW1kFVrYRvmSoUGbPwVQVltB1zUVUG'
    '46yK1cTc2RFXuKGzb6H4anUbI6zTerPiWUcnJ69eHr84+PztQb0s1B+ntFivRmUW7ef3Kc/byTT7yNTOmNyzv/16cDZuGJ/z/ddv'
    'eNr2gzZ+/GZWT/NmxQ6sVqcU9ps/fPMv33DHxdUTuOfl63fHb9/z4dUz9r/zUf12cT5/+0+P/+741fHz/8Px/3zy4uj98f90/H8f'
    'D2urNn1sdbdT13BNStOa1mnrZFXR0SlAUpekbTZdK+BhQnS25dRcNz1EKVsQOjtRkhHlGnm3nmsUSBKqhxR0rNZZI7y01hnw71p3'
    'NtcgtVZVZJeNq6krb23JSQFAH+tdcD3/kBZnA9k9zVdA+/yq907a1JfT+b2X5mkB/Fj/cnGrxf8XWldEEbetuxv8epP+frcaE52T'
    'QRWZO40bRRayO2eTKaqEMa5VzvtiITFlmJOQ2ndZ+SNbjvbebv08qK78tLl4ueDifL5d/ajI7tMXbd7WrX736XlaXVeyTktuv0EL'
    'e2p89Qay7dI1p2HSWmVUqmiXerAwO5MLY2OlgzwyzG+YW/EuWcW82mI9QekHT5cX66ezeniF4sOP6ul5mtETi7Qo7en5p9V/zg93'
    'Uzs0NQrGAXO9U5H89PLz9PPqcHvjk9WH7bM/zqbl4pwxvgf5N9Nm81Jjqla72tjYkDTVNQVBErHJaJ1XXdpgVExGaWcAvpLaIBYi'
    'pM6jZ3s1+2FZL7ftsko/zRb8cPDm9auXr49P3x4//9PR2z8en755++Ll66O3fz19/uaHkzevj1+/P/3u6Pm//vnkFDp7f/Tq1fGL'
    '0+dH73j6fHY+G/T5NwqptVdCu2CNH6Lmv/0nPgP452kx6221/u7Tut1AXSGWQeWiKvKbSq7oAbsXjfES1h/KTFFMVzmoEHW2QxNq'
    'EMoGS6XMJdRXF6nclPn2LvloPB0UZNYmyhhytyJ1r6Pv0QlDk2Vbcwi6J8W81bYvJuT/hGrfAPPLXcZm5CiHwkvAxlSsAmQ1Mm3X'
    'qxAt0i8O1exF1ExXiuIazCOz703l6t3BVR8cTgB+MXb0EK5c72jzycVAZ/DG6xAi1MUaWlDatMbEY+Z5PQJm7yL9lnwslo+0pU01'
    'SI9SdKA26Gvw7ay0fX5RzQMuyphzVjajyALay8bU0F2pPvYYSw8me9tscS74YIWWEa5pdsBwPTtv0ztae7BMYsIfB5t8bNNq28uS'
    'YVGAPjvbTFdQbfNtLVM9n227PW3Wy3Mulj8tV+sdX91inxi1j94yS0i7iqQDvBcKoqD4HRqkPMyVN4iEbKkpaXWuySmNd8BzjcWn'
    'i9njBis6ddGjwMRVIAujKSoE4HooUnmXtW3et1gjf9UsghT4lJwlWmVKEFteK5tpYiffQmFb13Yvu0y7q6unl8ZKv1eKJvf/dmh0'
    'gQ+8KJjHg99Nze+m5iuamq+oUWebNNUtXq8q97LOrztuamez1XpHC99tVp+u1Wv/wqvRIUc7Xrnv+l9QuuXPb9sapb4WwM//mAIC'
    'O246+IrSdO3/Lpny97x2ldeWUyW8T5+OpvKBPb6J7jUpVhkCUlY8qVk7BAorIarS1VvvE91SBFDWxguKX6MRMbZqJBeG4bx+9Gb9'
    'YTnN1p/2oF2cHGoqkWhdLUUaI1SjrFGqGbDdncEoIKI6saYU4xYB1nUfXNt7+JvNmvQ/GudmBwOT6s5rKqNtkboIlZxMSubmjITV'
    'RXCUzkSvdMBVYzsAmBC0k3JJ7s+dhF83pU273H+OKRsI2VMHj8URmJlSEaDCtCXGlkXhcAbwVsvNVNr7aUuBrTa0i/qForAIQvTR'
    '2hkJtUKaYaKd9n6rOD8vp5/6nMbaLI7W63Z+McaVX154ORpMB+NhMgt77W/n1zmMuXr6u+2qviw6Jj9mR0Bx1vcsfRuCDc9Bnx4+'
    '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'
    'XsrA9Vnz1ZuI/wbaawSgoCYAAA=='
)


@contextmanager
def selected_fixture(env=None):
    core = SimpleNamespace(HELPERS=client.r.c.load_core().HELPERS,
        closed_json=lambda raw, *unused: json.loads(raw),
        validate_invocation=Mock(return_value=({}, copy.deepcopy(ORIGIN_RECEIPT))))
    with patch.dict(os.environ, ENV if env is None else env, clear=True), \
            patch.object(client.r, 'authority', return_value=copy.deepcopy(AUTHORITY)), \
            patch.object(client.r, 'producer', return_value=copy.deepcopy(P)), \
            patch.object(client.r.c, 'load_core', return_value=core):
        yield core


class ComponentClientTests(unittest.TestCase):
    def test_unsealed_every_entry_stops_before_command_controller_or_output(self):
        with patch.object(client.r.c, 'SEALED_ORDINARY_COMPONENT', None), \
                patch.object(client, 'command_raw') as command, \
                patch.object(client, 'output_directory') as output, \
                patch.object(client.r, 'modules') as modules:
            for mode in client.MODES:
                with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NOT_SEALED'):
                    client.main(mode)
            command.assert_not_called()
            output.assert_not_called()
            modules.assert_not_called()

    def test_historical_readers_and_unknown_operations_do_not_select_component(self):
        for expected in client.LEGACY_PREDECESSORS:
            self.assertFalse(client.component_selected({'RELEASE_OPERATION': 'release_online_recharge',
                                                         'EXPECTED_CURRENT': expected}))
        for operation in ('release', 'release_admin', 'verify_online_recharge_extra'):
            self.assertFalse(client.component_selected({'RELEASE_OPERATION': operation, 'EXPECTED_CURRENT': OLD}))
        self.assertTrue(client.component_selected({'RELEASE_OPERATION': 'release_online_recharge',
                                                    'EXPECTED_CURRENT': 'unknown'}))

    def test_selection_binds_exact_ordinary_origin_main_role_and_existing_approval(self):
        with selected_fixture() as core:
            self.assertEqual(client.selected('selection'), (core, P))
        for field, value in [('EXPECTED_CURRENT', 'e' * 40), ('GITHUB_REF', 'refs/heads/other'),
                             ('HISTORICAL_EXCEPTION', 'old-b'), ('RELEASE_ADMIN_ONLY', 'true'),
                             ('AWS_REGION', 'us-east-1'), ('PRODUCTION_INSTANCE_ID', 'i-00000000000000000'),
                             ('API_FAULT_RESTORE_APPROVED', 'false')]:
            environment = dict(ENV, **{field: value})
            with self.subTest(field=field), selected_fixture(environment), self.assertRaises(RuntimeError):
                client.selected('selection')
        for field in client.FORBIDDEN:
            with self.subTest(field=field), selected_fixture(dict(ENV, **{field: 'unexpected'})), \
                    self.assertRaises(RuntimeError):
                client.selected('selection')

    def test_verify_does_not_build_or_publish_and_needs_no_restore_approval(self):
        env = dict(ENV, RELEASE_OPERATION='verify_online_recharge', API_FAULT_RESTORE_APPROVED='false')
        with selected_fixture(env):
            client.selected('preflight')
            for mode in ('prepare', 'build-proof', 'release', 'readback', 'label'):
                with self.subTest(mode=mode), self.assertRaises(RuntimeError):
                    client.selected(mode)

    def test_transport_is_45_second_bounded_and_masks_command_errors(self):
        with patch.object(client.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout=b'', stderr=b'private fixture')) as run:
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_RECHARGE_COMPONENT_TRANSPORT_UNAVAILABLE$'):
                client.command_raw('synthetic', 'read')
            self.assertEqual(run.call_args.kwargs['timeout'], 45)
        with patch.object(client.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout=b'', stderr=b'InvocationDoesNotExist')):
            self.assertIsNone(client.command_raw('synthetic', optional=True))

    def test_original_native_must_match_actual_ended_invocation_and_receipt_hash(self):
        with selected_fixture() as core, patch.object(client, 'command_raw', return_value=ORIGIN):
            self.assertEqual(client.predecessor_native(core), ORIGIN)
            core.validate_invocation.assert_called_once_with(ORIGIN, COMMAND, INSTANCE)
        with selected_fixture() as core, patch.object(client, 'command_raw', return_value=b'tampered'):
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NATIVE_CHANGED'):
                client.predecessor_native(core)
            core.validate_invocation.assert_not_called()

    def test_parameters_pin_full_helpers_and_install_original_raw_without_old_cli(self):
        with selected_fixture() as core:
            result = client.parameters('preflight', core, P, origin_raw=ORIGIN)
            carrier = shlex.split(result['commands'][0])[-1]
            argument = carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0]
            packed = __import__('ast').literal_eval(argument)
            program = gzip.decompress(base64.b64decode(packed)).decode()
            for name in (*core.HELPERS, 'online-recharge-component-consumer.py',
                         'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py'):
                self.assertIn(repr(name), program)
            self.assertIn('online-component-origin-' + AUTHORITY['invocationBytesSha256'], program)
            self.assertIn(repr(ORIGIN), program)
            self.assertIn('online-recharge-component-runtime.py', program)
            self.assertNotIn('--online-recharge-only', program)
            self.assertNotIn('after-bit-build-input', program)
            self.assertLess(len(json.dumps(result).encode()), 20 * 1024)

    def test_preflight_wraps_actual_native_then_uses_one_runtime_validator(self):
        receipt = {'kind': client.r.KIND, 'scope': 'ONLINE_RECHARGE',
                   'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'producer': P}
        raw = b'synthetic exact ended native'
        with selected_fixture() as core, \
                patch.object(client.r, 'validate_component_invocation', return_value=({}, receipt)) as decode, \
                patch.object(client.r, 'validate_preflight') as validate:
            result = client.validate_native(core, raw, 'preflight', P, COMMAND, INSTANCE)
            self.assertEqual(set(result), {'version', 'kind', 'producer', 'expectedCurrent', 'commandId',
                'instanceId', 'invocationBytesSha256', 'invocationRawBase64', 'serverReceipt'})
            self.assertEqual(base64.b64decode(result['invocationRawBase64']), raw)
            self.assertEqual(result['serverReceipt'], receipt)
            decode.assert_called_once_with(core, raw, COMMAND, INSTANCE)
            validate.assert_called_once_with(core, result, P, OLD)

    def test_release_and_readback_require_new_typed_return_without_old_decoder(self):
        receipt = {'kind': client.r.KIND, 'producer': P}
        with selected_fixture() as core, \
                patch.object(client.r, 'validate_component_invocation', return_value=({}, receipt)), \
                patch.object(client.r, 'validate_return_receipt') as validate:
            for mode in ('release', 'readback'):
                value = client.validate_native(core, b'ended native', mode, P, COMMAND, INSTANCE)
                self.assertEqual(value['receipt'], receipt)
                self.assertEqual(value['status'], 'Success')
            self.assertEqual(validate.call_count, 2)

    def test_release_stages_explicit_compressed_f_and_proof_with_existing_approval(self):
        proof = {'sourceProjection': {'candidateProducer': P}}
        transport = {'version': 1, 'kind': client.r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': P,
            'expectedCurrent': OLD, 'commandId': COMMAND, 'instanceId': INSTANCE,
            'invocationBytesSha256': client.r.c.digest(b'synthetic preflight native'),
            'invocationRawBase64': base64.b64encode(b'synthetic preflight native').decode(),
            'serverReceipt': {'producer': P}}
        with selected_fixture() as core, patch.object(client.r, 'validate_preflight'), \
                patch.object(client.r, 'validate_build'):
            result = client.parameters('release', core, P, input_artifacts=(json.dumps(proof).encode(),
                                       json.dumps(transport).encode()), origin_raw=ORIGIN)
            carrier = shlex.split(result['commands'][0])[-1]
            packed = __import__('ast').literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
            program = gzip.decompress(base64.b64decode(packed)).decode()
            self.assertIn('gzip-base64:', program)
            self.assertIn('--api-fault-restore-approved', program)
            self.assertIn('--preflight', program)
            self.assertIn('--build-proof', program)
            self.assertIn('preflight_from_native(core,runtime,', program)
            self.assertNotIn(repr(json.dumps(transport).encode()), program)
            tree = ast.parse(program)
            # Execute the actual carrier after replacing only its two mutating
            # installers. Runtime/native validators are isolated pure mocks.
            tree.body = [node for node in tree.body if not isinstance(node, ast.FunctionDef)
                         or node.name not in ('_store_files', 'write_workspace_private_bytes')]
            calls = []
            def runner(path, **kwargs):
                if kwargs.get('run_name') == '__main__':
                    calls.append(list(client.sys.argv))
                    return {}
                return vars(client.r)
            with patch.object(runpy, 'run_path', side_effect=runner), \
                    patch.object(client.sys, 'argv', ['isolated carrier']), \
                    patch.object(client.r, 'validate_component_invocation', return_value=(
                        {'StandardOutputContent': 'bounded wire'}, transport['serverReceipt'])):
                exec(compile(tree, '<pure-carrier-fixture>', 'exec'), {
                    '_store_files': Mock(), 'write_workspace_private_bytes': Mock()})
            self.assertEqual(len(calls), 1)
            args = calls[0]
            decode_arg = lambda value: json.loads(gzip.decompress(base64.b64decode(value.removeprefix('gzip-base64:'))))
            self.assertEqual(decode_arg(args[args.index('--build-proof') + 1]), proof)
            self.assertEqual(decode_arg(args[args.index('--preflight') + 1]), transport)

    def test_remote_f_reconstruction_keeps_exact_authenticated_native_and_full_receipt(self):
        raw = b'synthetic exact native bytes'
        descriptor = {'version': 1, 'kind': client.r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': P,
            'expectedCurrent': OLD, 'commandId': COMMAND, 'instanceId': INSTANCE,
            'invocationBytesSha256': client.r.c.digest(raw)}
        receipt = {'producer': P, 'baseline': {'publicFixture': True}}
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation',
                return_value=({'StandardOutputContent': 'bounded wire'}, receipt)) as decode, \
                patch.object(client.r, 'validate_preflight') as validate:
            value = client.preflight_from_native(core, client.r, descriptor, raw)
            self.assertEqual(base64.b64decode(value['invocationRawBase64']), raw)
            self.assertEqual(value['serverReceipt'], receipt)
            self.assertEqual(client.r.c.fingerprint(value), client.r.c.fingerprint(
                dict(descriptor, invocationRawBase64=base64.b64encode(raw).decode(), serverReceipt=receipt)))
            validate.assert_called_once_with(core, value, P, OLD)
            decode.assert_called_once_with(core, raw, COMMAND, INSTANCE)
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation') as decode:
            with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_NATIVE_CHANGED'):
                client.preflight_from_native(core, client.r, descriptor, raw + b'changed')
            decode.assert_not_called()

    def test_readback_cli_does_not_carry_predecessor_or_publish_inputs(self):
        with selected_fixture() as core:
            result = client.parameters('readback', core, P, origin_raw=ORIGIN)
            carrier = shlex.split(result['commands'][0])[-1]
            packed = __import__('ast').literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
            program = gzip.decompress(base64.b64decode(packed)).decode()
            self.assertNotIn('--expected-current', program)
            self.assertNotIn('--build-proof', program)
            self.assertNotIn('--api-fault-restore-approved', program)

    def test_stale_main_refuses_before_ssm(self):
        with patch.object(client, 'command_raw', return_value=b'other\trefs/heads/main\n') as command:
            with self.assertRaisesRegex(RuntimeError, 'STALE_MAIN_FORMAL_SEND_FORBIDDEN'):
                client.verify_main_head(P)
            self.assertEqual(command.call_count, 1)

    def test_quality_is_the_new_candidate_successful_main_run_and_exact_tree(self):
        run = {'id': 456, 'path': '.github/workflows/quality.yml', 'event': 'push',
               'status': 'completed', 'conclusion': 'success', 'head_sha': P['commit'],
               'repository': {'full_name': 'wangchaozhuanyong/id-business-system'}}
        commit = {'sha': P['commit'], 'commit': {'tree': {'sha': P['sourceTree']}}}
        with selected_fixture(), patch.object(client, 'command_raw', side_effect=[
                json.dumps(run).encode(), json.dumps(commit).encode()]):
            client.verify_quality(P)
        for field, value in [('id', 123), ('path', '.github/workflows/other.yml'),
                             ('event', 'pull_request'), ('status', 'in_progress'),
                             ('conclusion', 'failure'), ('head_sha', OLD)]:
            with self.subTest(field=field), selected_fixture(), \
                    patch.object(client, 'command_raw', return_value=json.dumps(dict(run, **{field: value})).encode()), \
                    self.assertRaisesRegex(RuntimeError, 'QUALITY_RUN_CHANGED'):
                client.verify_quality(P)
        with selected_fixture(), patch.object(client, 'command_raw', side_effect=[json.dumps(run).encode(),
                json.dumps({'sha': P['commit'], 'commit': {'tree': {'sha': 'e' * 40}}}).encode()]), \
                self.assertRaisesRegex(RuntimeError, 'QUALITY_SOURCE_TREE_CHANGED'):
            client.verify_quality(P)

    def test_actual_native_wire_above_23kb_is_rejected_before_f_is_written(self):
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation',
                return_value=({'StandardOutputContent': 'x' * 23000}, {'kind': client.r.KIND})), \
                self.assertRaisesRegex(RuntimeError, 'WIRE_TOO_LARGE'):
            client.validate_native(core, b'synthetic native', 'preflight', P, COMMAND, INSTANCE)

    def test_failure_preserves_authenticated_phase_recovery_and_late_publication(self):
        receipt = {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED', 'producer': P,
            'code': 'ONLINE_RECHARGE_COMPONENT_SYNTHETIC_FAILURE', 'phase': 'publication',
            'recovery': {'status': 'BLOCKED_OR_FAILED'},
            'publication': {'currentRole': 'CANDIDATE', 'onlinePublished': True},
            'onlinePublished': True, 'businessActions': None}
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation',
                return_value=({'StandardOutputContent': 'bounded synthetic wire'}, receipt)) as decode, \
                patch.object(client.r, 'validate_failure_receipt') as validate:
            value = client.validate_failure_native(core, b'actual failed fixture', P, COMMAND, INSTANCE)
            self.assertEqual(value['receipt'], receipt)
            self.assertFalse(value['automaticRetryAllowed'])
            self.assertTrue(value['restoreReadbackRequiresSeparateActualNative'])
            self.assertIsNone(value['receipt']['businessActions'])
            decode.assert_called_once_with(core, b'actual failed fixture', COMMAND, INSTANCE, status='Failed')
            validate.assert_called_once_with(receipt, P)

    def test_rejected_native_does_not_persist_an_untrusted_message(self):
        receipt = {'version': 1, 'scope': client.r.SCOPE, 'kind': client.r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED', 'code': 'UNPUBLISHED_COMPONENT_SOURCE_CHANGED',
            'message': 'private synthetic fixture'}
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation',
                return_value=({'StandardOutputContent': 'bounded synthetic wire'}, receipt)), \
                self.assertRaisesRegex(RuntimeError, 'FAILURE_RECEIPT_CHANGED'):
            client.validate_failure_native(core, b'failed fixture', P, COMMAND, INSTANCE)

    def test_diagnostic_reauthenticates_failed_native_and_shows_only_typed_summary(self):
        receipt = {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
            'code': 'ONLINE_RECHARGE_COMPONENT_SYNTHETIC_FAILURE', 'phase': 'publication',
            'recovery': {'status': 'RESTORED_INDEPENDENT_READBACK_REQUIRED'},
            'publication': {'currentRole': 'PREDECESSOR', 'onlinePublished': False},
            'onlinePublished': False, 'businessActions': 0}
        saved = {'commandId': COMMAND, 'instanceId': INSTANCE, 'status': 'Failed',
            'invocationBytesSha256': client.r.c.digest(b'failed native'),
            'invocationRawBase64': base64.b64encode(b'failed native').decode(),
            'receipt': receipt, 'automaticRetryAllowed': False,
            'restoreReadbackRequiresSeparateActualNative': True}
        output = MagicMock()
        output.__truediv__.return_value.exists.return_value = True
        with selected_fixture() as core, patch.object(client, 'validate_failure_native', return_value=saved) as validate:
            core.private_bytes = Mock(return_value=json.dumps(saved).encode())
            result = client.diagnostic(core, P, output)
            validate.assert_called_once_with(core, b'failed native', P, COMMAND, INSTANCE)
            self.assertEqual(result, client.failure_summary(receipt))
            self.assertNotIn('invocationRawBase64', result)
            self.assertEqual(result['recovery']['status'], 'RESTORED_INDEPENDENT_READBACK_REQUIRED')
        with selected_fixture() as core, patch.object(client, 'validate_failure_native', return_value=saved):
            core.private_bytes = Mock(return_value=json.dumps(dict(saved, automaticRetryAllowed=True)).encode())
            with self.assertRaisesRegex(RuntimeError, 'FAILURE_EVIDENCE_CHANGED'):
                client.diagnostic(core, P, output)

    def test_complete_real43_public_f_shape_fits_actual_native_stdout_boundary(self):
        fixture = json.loads(gzip.decompress(base64.b64decode(REAL43_PUBLIC_SIZING_FRAME, validate=True)))
        self.assertIs(fixture['releaseAuthority'], False)
        receipt = fixture['receiptForSizingOnly']
        baseline = receipt['baseline']
        self.assertEqual(baseline['ordinaryProducer']['commit'], '43c31870c9497d900491cdb19c5f61c766f3b344')
        self.assertEqual(baseline['ordinaryProjectionSha256'],
                         '973305a109c0044194e86413a8cebfbd1dac8a7ddb741d9ffca6cfee9052e1c8')
        self.assertEqual(baseline['ordinaryProjectionSha256'], fixture['originalProjectionSha256'])
        self.assertNotIn('ordinaryProjection', baseline)
        self.assertEqual(set(baseline), {'version', 'kind', 'ordinaryProducer', 'ordinaryAuthoritySha256',
            'currentRelease', 'manifestBytesSha256', 'ordinaryArchiveSha256', 'ordinarySourceFilesSha256',
            'ordinaryProjectionSha256', 'ordinaryOutputFilesSha256', 'environmentFileSha256', 'services',
            'workspaceVolume', 'guards', 'configurationModels', 'databaseGrants', 'migrationState',
            'appliedDatabase', 'backupInstallation', 'originMarkersSha256'})
        self.assertEqual(set(baseline['appliedDatabase']), {'online', 'connectionProfile', 'migrationPerformed',
            'databaseGrantsChanged', 'migrationPlan', 'databaseGrants'})
        self.assertIs(baseline['backupInstallation']['installationModified'], False)
        self.assertIs(baseline['backupInstallation']['backupDeletedByCas'], False)
        wire = client.r.wire(receipt)
        stdout = json.dumps(wire, sort_keys=True, separators=(',', ':')) + '\n'
        self.assertLess(len(stdout.encode()), 6000)
        self.assertLess(len(stdout.encode()), 23000)
        core = client.r.c.load_core()
        native = {'CommandId': COMMAND, 'InstanceId': INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'StandardErrorContent': '', 'StandardOutputContent': stdout, 'StandardOutputUrl': '',
            'StandardErrorUrl': '', 'ExecutionStartDateTime': '2026-01-01T00:00:00Z',
            'ExecutionEndDateTime': '2026-01-01T00:00:01Z'}
        # A pure structural fixture exercises the unchanged core AWS limits.
        # It is never saved, submitted or accepted as a real server receipt.
        with patch.object(client.r, 'authority', return_value=AUTHORITY):
            _native, decoded = client.r.validate_component_invocation(core, json.dumps(native).encode(), COMMAND, INSTANCE)
        self.assertEqual(decoded, receipt)

    def test_failures_keep_only_a_controlled_code(self):
        value = client.safe_failure(ValueError('private account fixture'))
        self.assertEqual(value, {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
                                'code': 'ONLINE_RECHARGE_COMPONENT_REMOTE_EVIDENCE_UNAVAILABLE'})
        self.assertNotIn('private', json.dumps(value))


if __name__ == '__main__':
    unittest.main()
