"""Pure closed-scope tests: no AWS, Docker, services, browser or database."""
import base64
import ast
from contextlib import contextmanager
import copy
import gzip
import importlib.util
import io
import json
import os
import runpy
from pathlib import Path
import shlex
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

PATH = Path(__file__).with_name('online-recharge-component-readonly.py')
spec = importlib.util.spec_from_file_location('online_component_transport_test', PATH)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
P = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}
OLD = 'c' * 40
CURRENT = 'f' * 40
CURRENT_COMMAND = '22222222-2222-4222-8222-222222222222'
COMMAND = '11111111-1111-4111-8111-111111111111'
INSTANCE = 'i-0123456789abcdef0'
ORIGIN_RECEIPT = {'scope': 'UNPUBLISHED_API_ADMIN_COMPONENT_SUCCESSOR', 'status': 'UNPUBLISHED_COMPONENT_VERIFIED'}
ORIGIN = json.dumps({'synthetic': 'ended native fixture'}).encode()
CURRENT_RECEIPT = {'status': 'ADMIN_ONLY_READBACK_VERIFIED', 'commit': CURRENT,
                   'apiComponentBaseline': OLD, 'preservedServiceCount': 6, 'onlinePublished': False}
CURRENT_RAW = json.dumps({'synthetic': 'ended Admin successor native fixture'}).encode()
AUTHORITY = {'producer': {'commit': OLD}, 'instanceId': INSTANCE, 'commandId': COMMAND,
             'invocationBytesSha256': client.r.c.digest(ORIGIN),
             'receiptSha256': client.r.c.fingerprint(ORIGIN_RECEIPT), 'coreSha256': 'd' * 64}
CURRENT_AUTHORITY = {'producer': dict(P, commit=CURRENT), 'commandId': CURRENT_COMMAND, 'instanceId': INSTANCE,
    'invocationBytesSha256': client.r.c.digest(CURRENT_RAW), 'receiptSha256': client.r.c.fingerprint(CURRENT_RECEIPT),
    'manifestBytesSha256': '1' * 64, 'buildProofBytesSha256': '2' * 64, 'publicationSha256': '3' * 64,
    'projectionSha256': '4' * 64, 'controllerSha256': '5' * 64}
ENV = {'RELEASE_OPERATION': 'release_online_recharge', 'EXPECTED_CURRENT': CURRENT,
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

# Public 43+735 authenticated source records, complete new F sizing shape.
# Missing future runtime measurements are explicit sentinels, never authority.
PUBLIC568_SIZING_FRAME = (
    'H4sIAAAAAAAC/+2bW2/bx5nG7/djCFjkJpLmfPBVFVtpvXVswXayuy0WwhxlNhSpkpRTNch3729IiZJsyZKbehdYxIATi4eZ+c88'
    '73OYGf28U84XizZbHdTTyexlWk3et28uVm355l1S1u082SlOF1m7b6rYKERruhutXW6yu5YL7+SWjU4+S+lzV8nl7r2rMZlYsgs7'
    'X+/MF3UyS4uLu5rP1WWVjFbRWNVyVKEr71svJvXWa5UxeGdE9zIpr3R2TkpTrJVKpxKFpvlFK21ytvp2vngz+ftkdvJqNr3YefLz'
    'Tjo7m04Kfc5nz2dn56ttnz7GKoxXQYUQYq2hypSqaSm5qKXhkUzzvbaoci4MzsZI51mJokVtotBnTss2nczaup+yOk/To0WrDGS5'
    'nC/Gi2V+ejpZ0Zl1oUUdRdLCJO1azSm4oHS11WYtm7XCeaczjS7n54vS3i4aze646GRzUkUhRWheC5mjU7Gr6pQLtoRQYmnF8b2f'
    '5osf+3T+0+vz2cFq1U7PRr/y9hvPK6/pYIJl9YIMO798vZPGmh+cr97NF5PVxXZ6ohVZsiTMv9RSyNZqyCHbkLTOrTtfElOvVOMd'
    'ZqzrFoLIQXujWhC671y2fLSY/6WVMf3bpq13tsioWWJfk8ngSFpvlWZBsylMOv8oLK3xgjUKLnlpgi8lJ21yFTeanvd/dponp+lk'
    'vXB9Mm1P5+czvq+Uu3xjPVHL9YCf5GqSD7FlJt6m6J1wrklXqALTDBNhk3dKCetKo6tQMxBlAKGUWiiANTh7o77KWFLhozdC8rzB'
    '7dUfF3utLPbS2e5svli9a2m52pV76TT9fT5LPy33eLT9Sd3N50twtlzuvle7izblY+3JYx9298aC78rd9dQNnG1rO0Vrm/Xd6tyl'
    'MEb55hpfUr03yt0L6ZoBbjXH2o1ShVeCMZGyEM6mAaKz7Spvam7ydH56Np9BKd9sa2TH6KJl8KJEE32FRkyUpWYZi+1OFu9c11mb'
    'MWElzeqkphUr8/lLu/3y5xdReZdmJ61+CyaW40n2Tiard+d5/6qGlvs8aT1fP+nVQuxdnE7HZ0/ndfQmhXDrZ9hOsG6ljg6jY6zW'
    'mSZ4SBAVtFGV4mLaXYxKwkJawaRFVFuiM1I4Zb2s6yo9O1vur5duf7ko++/Vfm9pdb5ovHq+mjMWhr44afvny/b68t8v5iVNn85n'
    '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'
    'reurg41/+weGbSsafzoAAA=='
)


@contextmanager
def selected_fixture(env=None):
    core = SimpleNamespace(HELPERS=client.r.c.load_core().HELPERS,
        closed_json=lambda raw, *unused: json.loads(raw),
        validate_invocation=Mock(side_effect=lambda raw, *unused, **kw: ({}, copy.deepcopy(
            CURRENT_RECEIPT if raw == CURRENT_RAW else ORIGIN_RECEIPT))))
    with patch.dict(os.environ, ENV if env is None else env, clear=True), \
            patch.object(client.r, 'authority', return_value=copy.deepcopy(AUTHORITY)), \
            patch.object(client.r, 'current_authority', return_value=copy.deepcopy(CURRENT_AUTHORITY)), \
            patch.object(client.r, 'current_predecessor', return_value=CURRENT), \
            patch.object(client.r, 'producer', return_value=copy.deepcopy(P)), \
            patch.object(client, 'helper_pins', side_effect=lambda core, p, helpers: {
                name: client.r.c.digest(PATH.with_name(name).read_bytes()) for name in helpers}), \
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

    def test_missing_admin_successor_seal_or_unknown_current_stops_before_transport(self):
        with patch.object(client.r, 'authority', return_value=AUTHORITY), \
                patch.object(client.r.c, 'SEALED_ORDINARY_COMPONENT', client.r.c.AUTHENTICATED_PREDECESSOR), \
                patch.object(client.r.c, 'ADMIN_SUCCESSOR', None), \
                patch.object(client, 'command_raw') as command, patch.object(client, 'output_directory') as output:
            for mode in client.MODES:
                with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'ADMIN_SUCCESSOR_NOT_SEALED'):
                    client.main(mode)
            command.assert_not_called()
            output.assert_not_called()
        with selected_fixture(dict(ENV, EXPECTED_CURRENT='unknown')), \
                patch.object(client, 'command_raw') as command, patch.object(client, 'output_directory') as output:
            with self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
                client.main('preflight')
            command.assert_not_called()
            output.assert_not_called()

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

    def test_expected_current_uses_sealed_admin_successor_without_relabeling_ordinary_origin(self):
        with selected_fixture() as core:
            self.assertEqual(client.selected('selection'), (core, P))
            self.assertEqual(client.r.authority()['producer']['commit'], OLD)
            self.assertEqual(client.r.current_predecessor(), CURRENT)
        with selected_fixture(dict(ENV, EXPECTED_CURRENT=OLD)), self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
            client.selected('selection')
        with selected_fixture(), patch.object(client.r, 'current_authority', return_value=dict(
                CURRENT_AUTHORITY, instanceId='i-00000000000000000')), self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
            client.selected('selection')

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

    def test_ordinary_and_admin_successor_use_two_independent_original_native_bytes(self):
        with selected_fixture() as core, patch.object(client, 'command_raw', side_effect=[ORIGIN, CURRENT_RAW]) as command:
            self.assertEqual(client.predecessor_native(core), ORIGIN)
            self.assertEqual(client.current_native(core), CURRENT_RAW)
            self.assertEqual(command.call_args_list[0].args[6], COMMAND)
            self.assertEqual(command.call_args_list[1].args[6], CURRENT_COMMAND)
            self.assertEqual(core.validate_invocation.call_args_list[0].args, (ORIGIN, COMMAND, INSTANCE))
            self.assertEqual(core.validate_invocation.call_args_list[1].args, (CURRENT_RAW, CURRENT_COMMAND, INSTANCE))
        with selected_fixture() as core, patch.object(client, 'command_raw', return_value=ORIGIN):
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NATIVE_CHANGED'):
                client.current_native(core)
            core.validate_invocation.assert_not_called()

    def test_parameters_pin_full_helpers_and_install_original_raw_without_old_cli(self):
        with selected_fixture() as core:
            result = client.parameters('preflight', core, P, origin_raw=ORIGIN, current_raw=CURRENT_RAW)
            carrier = shlex.split(result['commands'][0])[-1]
            argument = carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0]
            packed = __import__('ast').literal_eval(argument)
            program = gzip.decompress(base64.b64decode(packed)).decode()
            for name in (*core.HELPERS, 'online-recharge-component-consumer.py',
                         'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py'):
                self.assertIn(repr(name), program)
            call = next(node for node in ast.walk(ast.parse(program)) if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Subscript) and isinstance(node.func.value, ast.Name)
                and node.func.value.id == 'client')
            packet = [ast.literal_eval(value) for value in call.args]
            self.assertEqual(gzip.decompress(base64.b64decode(packet[1])), ORIGIN)
            self.assertEqual(gzip.decompress(base64.b64decode(packet[2])), CURRENT_RAW)
            self.assertLess(program.index('_store_files('), program.index('client=load_staged_client('))
            self.assertIn('online-recharge-component-runtime.py', program)
            self.assertNotIn('--online-recharge-only', program)
            self.assertNotIn('after-bit-build-input', program)
            self.assertLess(len(json.dumps(result).encode()), 20 * 1024)
        with selected_fixture() as core, patch.object(client.r, 'current_native_path', return_value=Path(
                '/opt/id-business-v2/.staging/online-component-origin-' + AUTHORITY['invocationBytesSha256'] + '/invocation.json')):
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_PATH_CHANGED'):
                client.parameters('preflight', core, P, origin_raw=ORIGIN, current_raw=CURRENT_RAW)

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
            validate.assert_called_once_with(core, result, P, CURRENT)

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
            'expectedCurrent': CURRENT, 'commandId': COMMAND, 'instanceId': INSTANCE,
            'invocationBytesSha256': client.r.c.digest(b'synthetic preflight native'),
            'invocationRawBase64': base64.b64encode(b'synthetic preflight native').decode(),
            'serverReceipt': {'producer': P}}
        with selected_fixture() as core, patch.object(client.r, 'validate_preflight'), \
                patch.object(client.r, 'validate_build'):
            result = client.parameters('release', core, P, input_artifacts=(json.dumps(proof).encode(),
                                       json.dumps(transport).encode()), origin_raw=ORIGIN, current_raw=CURRENT_RAW)
            carrier = shlex.split(result['commands'][0])[-1]
            packed = __import__('ast').literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
            program = gzip.decompress(base64.b64decode(packed)).decode()
            self.assertIn('gzip-base64:', program)
            self.assertIn('--api-fault-restore-approved', program)
            self.assertIn('client["server_arguments"](', program)
            self.assertNotIn(repr(json.dumps(transport).encode()), program)
            tree = ast.parse(program)
            # Execute the actual carrier with only its source installer and the
            # staged byte writer mocked. Native/F validators stay pure mocks.
            tree.body = [node for node in tree.body if not isinstance(node, ast.FunctionDef)
                         or node.name not in ('_store_files', 'load_staged_client')]
            calls = []
            def runner(path, **kwargs):
                if kwargs.get('run_name') == '__main__':
                    calls.append(list(client.sys.argv))
                    return {}
                self.assertTrue(path.endswith('/online-recharge-component-readonly.py'))
                return vars(client)
            writer = Mock()
            with patch.object(runpy, 'run_path', side_effect=runner), \
                    patch.object(client, 'load', return_value=SimpleNamespace(write_workspace_private_bytes=writer)), \
                    patch.object(client.sys, 'argv', ['isolated carrier']), \
                    patch.object(client.r, 'validate_component_invocation', return_value=(
                        {'StandardOutputContent': 'bounded wire'}, transport['serverReceipt'])):
                exec(compile(tree, '<pure-carrier-fixture>', 'exec'), {
                    '_store_files': Mock(), 'load_staged_client': Mock(return_value=vars(client))})
            self.assertEqual(len(calls), 1)
            args = calls[0]
            decode_arg = lambda value: json.loads(gzip.decompress(base64.b64decode(value.removeprefix('gzip-base64:'))))
            self.assertEqual(decode_arg(args[args.index('--build-proof') + 1]), proof)
            self.assertEqual(decode_arg(args[args.index('--preflight') + 1]), transport)
            self.assertEqual(writer.call_args_list[0].args, (
                '/opt/id-business-v2/.staging/online-component-origin-' + AUTHORITY['invocationBytesSha256'] + '/invocation.json', ORIGIN))
            self.assertEqual(writer.call_args_list[1].args, (
                '/opt/id-business-v2/.staging/online-admin-successor-' + CURRENT_AUTHORITY['invocationBytesSha256'] + '/invocation.json', CURRENT_RAW))

    def test_remote_f_reconstruction_keeps_exact_authenticated_native_and_full_receipt(self):
        raw = b'synthetic exact native bytes'
        descriptor = {'version': 1, 'kind': client.r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': P,
            'expectedCurrent': CURRENT, 'commandId': COMMAND, 'instanceId': INSTANCE,
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
            validate.assert_called_once_with(core, value, P, CURRENT)
            decode.assert_called_once_with(core, raw, COMMAND, INSTANCE)
        with selected_fixture() as core, patch.object(client.r, 'validate_component_invocation') as decode:
            with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_NATIVE_CHANGED'):
                client.preflight_from_native(core, client.r, descriptor, raw + b'changed')
            decode.assert_not_called()

    def test_candidate_archive_git_mode_and_local_cas_are_checked_before_helper_execution(self):
        core = client.r.c.load_core()
        decoder = client.load('remote-deploy.py')
        name = 'online-recharge-component-readonly.py'
        relative = 'scripts/production-release/' + name
        raw = b'# public source fixture\n'
        files = {relative: (raw, '100644')}
        p = dict(P, sourceTree=core.projection_module().source_tree(files))
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            row = tarfile.TarInfo('id-business-system-' + p['commit'] + '/' + relative)
            row.mode, row.size = 0o644, len(raw)
            archive.addfile(row, io.BytesIO(raw))
        archive_raw = stream.getvalue()
        header = '100644 blob ' + __import__('hashlib').sha1(
            b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() + '\t' + relative + '\n'
        snapshot = {name: (raw, '100644', (1, 2, 3, 4))}
        d = SimpleNamespace(registration_download=Mock(return_value=archive_raw),
            registration_archive=Mock(wraps=decoder.registration_archive))
        with patch.object(client, 'helper_snapshot', return_value=snapshot), \
                patch.object(client.r, 'modules', return_value=(d,)), \
                patch.object(client, 'command_raw', return_value=header.encode()):
            self.assertEqual(client.helper_pins(core, p, (name,)), {name: client.r.c.digest(raw)})
            d.registration_download.assert_called_once_with(p['commit'])
            d.registration_archive.assert_called_once_with(archive_raw, p['commit'])
        for changed in (b'# changed helper fixture\n', raw):
            bad = {relative: (changed, '100755' if changed == raw else '100644')}
            d.registration_archive = Mock(return_value=bad)
            with self.subTest(modeOrBytes=changed), patch.object(client, 'helper_snapshot', return_value=snapshot), \
                    patch.object(client.r, 'modules', return_value=(d,)), \
                    patch.object(client, 'command_raw') as git:
                with self.assertRaises(RuntimeError):
                    client.helper_pins(core, p, (name,))
                git.assert_not_called()
        d.registration_archive = Mock(wraps=decoder.registration_archive)
        with patch.object(client, 'helper_snapshot', return_value=snapshot), \
                patch.object(client.r, 'modules', return_value=(d,)), \
                patch.object(client, 'command_raw', return_value=header.replace('100644', '100755').encode()), \
                self.assertRaisesRegex(RuntimeError, 'HELPER_GIT_SOURCE_CHANGED'):
            client.helper_pins(core, p, (name,))
        with patch.object(client, 'helper_snapshot', side_effect=[snapshot, {name: (raw, '100644', (1, 2, 3, 5))}]), \
                patch.object(client.r, 'modules', return_value=(d,)), \
                patch.object(client, 'command_raw', return_value=header.encode()), \
                self.assertRaisesRegex(RuntimeError, 'HELPER_SOURCE_CHANGED'):
            client.helper_pins(core, p, (name,))

    def test_staged_server_refuses_missing_raw_or_writer_failure_before_dispatch(self):
        pack = lambda value: base64.b64encode(gzip.compress(value, mtime=0)).decode()
        writer = Mock()
        with selected_fixture(), patch.object(client, 'load', return_value=SimpleNamespace(
                write_workspace_private_bytes=writer)), patch.object(runpy, 'run_path') as dispatch:
            for raw in ('', pack(b'changed successor native')):
                with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                    client.server_arguments(['readback'], pack(ORIGIN), raw)
            writer.assert_not_called()
            dispatch.assert_not_called()
            writer.side_effect = RuntimeError('API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED')
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'):
                client.server_arguments(['readback'], pack(ORIGIN), pack(CURRENT_RAW))
            self.assertEqual(writer.call_count, 1)
            dispatch.assert_not_called()

    def test_staged_client_hash_mode_and_cas_are_validated_before_execution(self):
        runtime = PATH.parents[2] / '.runtime/online-recharge/component-source-pin-tests'
        runtime.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as directory:
            path = Path(directory) / 'pinned-client.py'
            raw = b'value = 42\n'
            path.write_bytes(raw)
            path.chmod(0o600)
            expected = client.r.c.digest(raw)
            self.assertEqual(client.load_staged_client(str(path), expected)['value'], 42)
            path.write_bytes(b'raise AssertionError("must never execute")\n')
            with self.assertRaisesRegex(RuntimeError, 'HELPER_SOURCE_CHANGED'):
                client.load_staged_client(str(path), expected)
            path.write_bytes(raw)
            path.chmod(0o666)
            with self.assertRaisesRegex(RuntimeError, 'HELPER_SOURCE_CHANGED'):
                client.load_staged_client(str(path), expected)

    def test_readback_cli_does_not_carry_predecessor_or_publish_inputs(self):
        with selected_fixture() as core:
            result = client.parameters('readback', core, P, origin_raw=ORIGIN, current_raw=CURRENT_RAW)
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

    def test_historical_real43_public_f_shape_fits_actual_native_stdout_boundary(self):
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

    def test_complete_568_f_keeps_full_admin_proof_and_fits_original_native_limit(self):
        fixture = json.loads(gzip.decompress(base64.b64decode(PUBLIC568_SIZING_FRAME, validate=True)))
        self.assertIs(fixture['releaseAuthority'], False)
        receipt = fixture['receiptForSizingOnly']
        baseline = receipt['baseline']
        self.assertEqual(baseline['ordinaryProducer']['commit'], '43c31870c9497d900491cdb19c5f61c766f3b344')
        self.assertEqual(baseline['actualPredecessor']['commit'], '568e9390a304a36edba86823d5d5b31e5506763b')
        self.assertEqual(fixture['currentAdminNativeBytesSha256'],
                         'c63c1df7e2c5900ee3f4336be1f6ebcdf7beb43a7b117bf2a6bf776d9a49cb68')
        self.assertEqual(set(baseline), {'version', 'kind', 'ordinaryProducer', 'ordinaryAuthoritySha256',
            'actualPredecessor', 'adminAuthoritySha256', 'adminProjectionSha256', 'adminProof', 'ordinaryRelease',
            'currentArchiveSha256', 'currentRelease', 'manifestBytesSha256', 'ordinaryArchiveSha256',
            'ordinarySourceFilesSha256', 'ordinaryProjectionSha256', 'ordinaryOutputFilesSha256',
            'environmentFileSha256', 'services', 'workspaceVolume', 'guards', 'configurationModels',
            'databaseGrants', 'migrationState', 'appliedDatabase', 'backupInstallation', 'originMarkersSha256'})
        self.assertEqual(client.r.c.fingerprint(baseline['adminProof']),
                         '61762ca2d160e8cb6715c56deb86dc821b9abea3a29a9aa728f77e362bf24bfa')
        self.assertEqual(baseline['adminProof']['projection']['profile'], 'ADMIN_CONFIRM_EXPIRY_20261014')
        self.assertEqual(len(baseline['adminProof']['projection']['overlayFiles']), 2)
        self.assertEqual(receipt['applicationInputSha256'],
                         '799d0472828889dd8d1aad4eaa69314df74e7fde92bbc2a4599a27b20c30de0c')
        wire = client.r.wire(receipt)
        stdout = json.dumps(wire, sort_keys=True, separators=(',', ':')) + '\n'
        self.assertLess(len(stdout.encode()), 9000)
        self.assertLess(len(stdout.encode()), 23000)
        raw = gzip.decompress(base64.b64decode(wire['payload'], validate=True))
        self.assertEqual(json.loads(raw), receipt)
        self.assertEqual(client.r.c.digest(raw), wire['payloadSha256'])

    def test_failures_keep_only_a_controlled_code(self):
        value = client.safe_failure(ValueError('private account fixture'))
        self.assertEqual(value, {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
                                'code': 'ONLINE_RECHARGE_COMPONENT_VALUE_ERROR'})
        self.assertNotIn('private', json.dumps(value))

    def test_safe_failure_keeps_old_controlled_cap_and_unknown_contract_without_formatting(self):
        unknown = 'ONLINE_RECHARGE_COMPONENT_REMOTE_EVIDENCE_UNAVAILABLE'
        for error in (None, Exception('private secret'), RuntimeError('private secret'),
            RuntimeError('API_ADMIN_PRIVATE'), RuntimeError('ONLINE_RECHARGE_COMPONENT_' + 'A' * 97),
            RuntimeError('ONLINE_RECHARGE_COMPONENT_OK', 'private secret')):
            self.assertEqual(client.safe_failure(error), {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED', 'code': unknown})
        for code in ('ONLINE_RECHARGE_COMPONENT_OK', 'ONLINE_RECHARGE_COMPONENT_' + 'A' * 96,
                     'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'):
            self.assertEqual(client.safe_failure(RuntimeError(code))['code'], code)
        class Dangerous(RuntimeError):
            def __str__(self): raise AssertionError('custom formatting forbidden')
            def __getattribute__(self, name):
                if name == 'args': raise AssertionError('custom args forbidden')
                return super().__getattribute__(name)
        class DangerousArgument:
            def __str__(self): raise AssertionError('argument formatting forbidden')
            def __eq__(self, other): raise AssertionError('argument comparison forbidden')
        for error in (Dangerous('ONLINE_RECHARGE_COMPONENT_PRIVATE'), RuntimeError(DangerousArgument())):
            self.assertEqual(client.safe_failure(error)['code'], unknown)

    def test_safe_failure_classifies_builtin_errors_without_private_details(self):
        secret = 'synthetic-password-token-cookie-command-url'
        cases = ((FileExistsError(secret), 'FILE_EXISTS'), (PermissionError(secret), 'PERMISSION_DENIED'), (TypeError(secret), 'TYPE_ERROR'),
            (KeyError(secret), 'KEY_ERROR'), (TimeoutError(secret), 'TIMEOUT'),
            (json.JSONDecodeError(secret, secret, 0), 'JSON_INVALID'),
            (client.r.urllib.error.HTTPError(secret, 403, secret, {}, None), 'HTTP_ERROR'),
            (client.r.urllib.error.URLError(secret), 'URL_ERROR'),
            (client.r.subprocess.TimeoutExpired([secret], 1, output=secret, stderr=secret), 'COMMAND_TIMEOUT'),
            (client.r.subprocess.CalledProcessError(1, [secret], output=secret, stderr=secret), 'COMMAND_FAILED'))
        for error, category in cases:
            with self.subTest(category=category):
                value = client.safe_failure(error)
                self.assertEqual(value, {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
                    'code': 'ONLINE_RECHARGE_COMPONENT_' + category})
                self.assertNotIn(secret, json.dumps(value))


if __name__ == '__main__':
    unittest.main()
