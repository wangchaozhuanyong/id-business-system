"""Pure recovery transport checks with real private files and native validators.

Only external source/SSM operations and the already separately tested original
input authentication boundary are simulated. No Docker, service or DB runs.
"""
import ast
import base64
from contextlib import ExitStack, redirect_stdout
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile


PATH = Path(__file__).with_name('online-recharge-component-recovery-readonly.py')
spec = importlib.util.spec_from_file_location('online_protected_recovery_transport_test', PATH)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
CORE = c.r.c.load_core(c.r.authority()['coreSha256'])
P = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '901', 'workflowRunAttempt': '1'}
IDS = {'verify': '11111111-1111-4111-8111-111111111111',
       'recover': '22222222-2222-4222-8222-222222222222',
       'readback': '33333333-3333-4333-8333-333333333333'}
F_NATIVE = b'{"synthetic":"F native"}\n'
F_VALUE = {'version': 1, 'kind': c.r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': c.recovery.FAILED_PRODUCER,
    'expectedCurrent': c.r.current_predecessor(), 'commandId': IDS['verify'],
    'instanceId': c.recovery.ORIGIN['instanceId'], 'invocationBytesSha256': c.r.c.digest(F_NATIVE),
    'invocationRawBase64': base64.b64encode(F_NATIVE).decode(), 'serverReceipt': {'synthetic-server-receipt': True}}
CONTEXT = {'failureRaw': b'{"failed":"native"}\n', 'preflightRaw': c.recovery.encoded(F_VALUE),
           'proofRaw': b'{"proof":"build"}\n'}
BINDING = {'producer': c.recovery.FAILED_PRODUCER, 'mode': 'release',
    'expectedCurrent': c.r.current_predecessor(), 'commandId': c.recovery.ORIGIN['failureCommandId'],
    'instanceId': c.recovery.ORIGIN['instanceId'], 'evidenceJobId': '44', 'artifactId': '55',
    'artifactBytesSha256': 'c' * 64}
ENV = {'GITHUB_REF': 'refs/heads/main', 'AWS_REGION': 'ap-northeast-1',
    'PRODUCTION_INSTANCE_ID': c.recovery.ORIGIN['instanceId'], 'EXPECTED_CURRENT': c.r.current_predecessor(),
    'RELEASE_COMMIT': P['commit'], 'SOURCE_TREE': P['sourceTree'], 'GITHUB_RUN_ID': P['workflowRunId'],
    'GITHUB_RUN_ATTEMPT': '1', 'API_FAULT_RESTORE_APPROVED': 'true', 'QUALITY_RUN_ID': '902'}


def evidence():
    rows = {name: {'containerId': '1' * 64, 'startedAtSha256': '2' * 64,
        'configurationSha256': '3' * 64, 'image': 'sha256:' + '4' * 64,
        'reference': 'example/' + name + ':sealed', 'environmentSha256': '5' * 64,
        'status': 'running', 'health': 'healthy'} for name in c.r.c.SERVICES}
    return {'currentRelease': '/opt/id-business-v2/releases/20261013T000000Z-568e939095ad',
        'environmentFileSha256': '6' * 64, 'workspaceVolume': {'name': 'sealed-volume'},
        'appliedDatabase': {'migrations': ['sealed']}, 'services': rows}


def receipt(mode):
    e = evidence()
    state = {name: '7' * 64 for name in c.recovery.STATE_FIELDS}
    state.update(currentRelease=e['currentRelease'], manifestBytesSha256=c.recovery.ORIGIN['manifestBytesSha256'],
        environmentFileSha256=e['environmentFileSha256'], workspaceVolume=e['workspaceVolume'],
        appliedDatabase=e['appliedDatabase'], servicesAfter=copy.deepcopy(e['services']),
        onlineGrants={'status': 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED', 'sha256': 'a' * 64,
            'mutationPerformed': False}, markerAbsent=mode != 'verify', executorAbsent=True,
        preservedServiceCount=len(c.r.PRESERVED), auditRecordBytesSha256=c.recovery.ORIGIN['auditRecordBytesSha256'],
        sqliteReceiptBytesSha256=c.recovery.ORIGIN['sqliteReceiptBytesSha256'],
        sqliteProtectionSha256=c.recovery.ORIGIN['sqliteProtectionSha256'],
        freshStrictAudit={'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': '8' * 64})
    for name in ('api', 'admin'):
        state['servicesAfter'][name]['containerId'] = '9' * 64
    value = {'version': 1, 'scope': c.r.SCOPE, 'kind': c.r.KIND, 'producer': c.recovery.FAILED_PRODUCER,
        'origin': c.recovery.ORIGIN, 'state': state}
    if mode == 'verify':
        return {**value, 'status': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_DIAGNOSED',
            'automaticRecoveryAllowed': False}
    return {**value, 'status': c.recovery.STATUS,
        'failedRelease': str(c.recovery.BASE / 'releases' / c.recovery.TARGET_NAME),
        'recoveryExecutor': P, 'recoveryHelperSha256': c.r.c.digest(Path(c.recovery.__file__).read_bytes()),
        'recoveryRecordBytesSha256': 'a' * 64, 'originalMarkerCleared': True, 'onlinePublished': False,
        'migrationPerformed': False, 'databaseGrantsChanged': False, 'executionMigrationPlan': [],
        'volumeDeletionPerformed': False, 'businessActions': 0, 'failedOperationBusinessActions': None}


def native(mode, *, command_id=None, value=None, status='Success'):
    output = c.r.wire(receipt(mode) if value is None else value)
    return (json.dumps({'CommandId': command_id or IDS[mode], 'InstanceId': c.recovery.ORIGIN['instanceId'],
        'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': status,
        'ResponseCode': 0 if status == 'Success' else 1, 'StandardErrorContent': '' if status == 'Success'
            else 'failed to run commands: exit status 1',
        'StandardOutputContent': json.dumps(output), 'StandardOutputUrl': '', 'StandardErrorUrl': '',
        'ExecutionStartDateTime': '2026-01-01T00:00:00Z',
        'ExecutionEndDateTime': '2026-01-01T00:00:01Z'}, sort_keys=True) + '\n').encode()


def carrier(params):
    argv = shlex.split(params['commands'][0])
    assert argv[:3] == ['python3', '-B', '-c']
    bootstrap = ast.parse(argv[3])
    packed = next(node.args[0].value for node in ast.walk(bootstrap)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and node.func.attr == 'b64decode')
    return gzip.decompress(base64.b64decode(packed, validate=True)).decode()


class TransportTests(unittest.TestCase):
    def setUp(self):
        directory = PATH.parents[2] / '.runtime' / 'online-protected-recovery-client-tests'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.temp = tempfile.TemporaryDirectory(prefix='test-', dir=directory)
        self.output = Path(self.temp.name).resolve()
        self.output.chmod(0o700)
        self.stack = ExitStack()
        self.stack.enter_context(patch.dict(os.environ, ENV, clear=True))
        self.stack.enter_context(patch.object(c.recovery, 'inputs', return_value=(CORE, {}, evidence(), {})))
        self.stack.enter_context(patch.object(c.recovery, 'validate_inputs',
            side_effect=lambda a, b, d: {'failureRaw': a, 'preflightRaw': b, 'proofRaw': d}))
        self.stack.enter_context(patch.object(c.client, 'preflight_from_native', return_value=copy.deepcopy(F_VALUE)))
        self.stack.enter_context(patch.object(c.client, 'verify_main_head'))
        self.stack.enter_context(patch.object(c.client, 'verify_quality'))
        self.stack.enter_context(patch.object(c.client, 'helper_pins',
            side_effect=lambda core, p, names: {name: c.r.c.digest(PATH.with_name(name).read_bytes()) for name in names}))

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def complete(self, mode, **overrides):
        def command(*args, **kwargs):
            if args[4] == 'send-command':
                return IDS[mode].encode()
            self.assertEqual(args[4], 'get-command-invocation')
            self.assertEqual(args[6], IDS[mode])
            return native(mode, **overrides)
        with patch.object(c.client, 'command_raw', side_effect=command) as calls:
            result = c.transport(mode, CORE, P, self.output, CONTEXT, BINDING, {})
        return result, calls

    def test_selection_defaults_read_only_and_requires_explicit_recovery_approval(self):
        os.environ['API_FAULT_RESTORE_APPROVED'] = 'false'
        self.assertEqual(c.selected('verify')[1], P)
        with self.assertRaisesRegex(RuntimeError, 'APPROVAL_REQUIRED'):
            c.selected('recover')
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaisesRegex(RuntimeError, 'APPROVAL_REQUIRED'):
                c.transport('recover', CORE, P, self.output, CONTEXT, BINDING, {})
            with self.assertRaisesRegex(RuntimeError, 'APPROVAL_REQUIRED'):
                c.parameters('recover', CORE, P, CONTEXT)
            calls.assert_not_called()
        os.environ['API_FAULT_RESTORE_APPROVED'] = 'true'
        self.assertEqual(c.selected('recover')[1], P)
        for name, bad in (('GITHUB_REF', 'refs/heads/feature'), ('EXPECTED_CURRENT', '0' * 40),
                          ('REUSE_IMAGE_RUN', '99'), ('API_FAULT_RESTORE_APPROVED', 'TRUE')):
            with self.subTest(name=name), patch.dict(os.environ, {name: bad}):
                with self.assertRaises(RuntimeError):
                    c.selected('verify')

    def test_carrier_contains_only_current_pinned_helpers_and_fixed_original_bytes(self):
        for mode in c.MODES:
            params = c.parameters(mode, CORE, P, CONTEXT)
            text = carrier(params)
            tree = ast.parse(text)
            store = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name) and node.func.id == '_store_files')
            values = [ast.literal_eval(row) for row in store.args]
            self.assertEqual(values[0], '/opt/id-business-v2/.staging/online-protected-recovery-' + P['commit'] + '-901-1')
            self.assertEqual(values[1], P['commit'])
            self.assertEqual(set(values[2]), set(c.helpers(CORE)))
            self.assertIs(values[3], False)
            call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Subscript) and isinstance(node.func.value, ast.Name)
                and node.func.value.id == 'client')
            args = [ast.literal_eval(row) for row in call.args]
            self.assertEqual(args[:2], [mode, P])
            self.assertEqual(args[3], {name: value for name, value in F_VALUE.items()
                if name not in ('invocationRawBase64', 'serverReceipt')})
            self.assertNotIn('synthetic-server-receipt', text)
            for value, raw in zip((args[2], args[4], args[5]),
                    (CONTEXT['failureRaw'], F_NATIVE, CONTEXT['proofRaw'])):
                self.assertEqual(gzip.decompress(base64.b64decode(value[len('gzip-base64:'):])), raw)
            assignment = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                and isinstance(node.targets[0], ast.Subscript)
                and getattr(node.targets[0].value, 'attr', None) == 'environ')
            self.assertEqual(ast.literal_eval(assignment.value), 'true' if mode == 'recover' else 'false')
            self.assertEqual(params['executionTimeout'], ['600'])
            self.assertLess(len(json.dumps(params).encode()), 20 * 1024)

    def test_server_cli_keeps_original_business_and_new_executor_identity_separate(self):
        packed = [c.pack(CONTEXT['failureRaw']), {name: value for name, value in F_VALUE.items()
            if name not in ('invocationRawBase64', 'serverReceipt')}, c.pack(F_NATIVE), c.pack(CONTEXT['proofRaw'])]
        verify = c.server_arguments('verify', P, *packed)
        self.assertEqual(verify[0], 'diagnose')
        self.assertNotIn('--executor-commit', verify)
        self.assertEqual(gzip.decompress(base64.b64decode(verify[verify.index('--preflight') + 1]
            [len('gzip-base64:'):])), CONTEXT['preflightRaw'])
        recover = c.server_arguments('recover', P, *packed)
        self.assertEqual(recover[recover.index('--executor-commit') + 1], P['commit'])
        self.assertEqual(c.server_arguments('readback', P, *packed)[0], 'readback')
        with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_CHANGED'):
            c.server_arguments('recover', c.recovery.FAILED_PRODUCER, *packed)
        with self.assertRaisesRegex(RuntimeError, 'INPUT_ENCODING_CHANGED'):
            c.server_arguments('verify', P, packed[0][len('gzip-base64:'):], *packed[1:])

    def test_semantically_equal_noncanonical_F_bytes_cannot_change_the_original_record(self):
        changed = dict(CONTEXT, preflightRaw=json.dumps(F_VALUE).encode())
        with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_BYTES_CHANGED'):
            c.parameters('verify', CORE, P, changed)

    def test_three_stage_chain_preserves_real_bytes_and_distinct_native_ids(self):
        values = []
        for mode in c.MODES:
            value, calls = self.complete(mode)
            values.append(value)
            self.assertEqual(sum(row.args[4] == 'send-command' for row in calls.call_args_list), 1)
            self.assertEqual(CORE.private_bytes(c.path(self.output, mode, 'native')), native(mode))
            self.assertEqual(value['executorProducer'], P)
            self.assertEqual(value['originalProducer'], c.recovery.FAILED_PRODUCER)
            self.assertIs(value['releaseAuthority'], False)
            with self.assertRaises(RuntimeError):
                c.r.validate_return_receipt(value['receipt'], P)
        self.assertEqual(len({row['commandId'] for row in values}), 3)
        self.assertEqual(values[1]['receipt'], values[2]['receipt'])

    def test_recover_and_readback_require_previous_actual_authenticated_native(self):
        for mode in ('recover', 'readback'):
            with self.subTest(mode=mode), patch.object(c.client, 'command_raw') as calls:
                with self.assertRaises(FileNotFoundError):
                    c.transport(mode, CORE, P, self.output, CONTEXT, BINDING, {})
                calls.assert_not_called()
        self.complete('verify')
        rawpath = c.path(self.output, 'verify', 'native')
        rawpath.write_bytes(native('verify', command_id=IDS['readback']))
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaises(RuntimeError):
                c.transport('recover', CORE, P, self.output, CONTEXT, BINDING, {})
            calls.assert_not_called()

    def test_prior_symlink_and_modified_parameter_evidence_are_rejected(self):
        self.complete('verify')
        params = c.path(self.output, 'verify', 'parameters')
        original = CORE.private_bytes(params)
        params.write_text('{"commands":[],"executionTimeout":["600"]}\n')
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_PARAMETERS_CHANGED'):
            c.prior_result(CORE, self.output, 'recover', P, CONTEXT)
        params.write_bytes(original)
        result = c.path(self.output, 'verify', 'result')
        real = self.output / 'private-result.json'
        result.rename(real)
        result.symlink_to(real)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'):
            c.prior_result(CORE, self.output, 'recover', P, CONTEXT)

    def test_coordinated_saved_parameter_hash_tampering_cannot_borrow_unchanged_native(self):
        self.complete('verify')
        native_path = c.path(self.output, 'verify', 'native')
        original_native = CORE.private_bytes(native_path)
        changed = {'commands': ['python3 -B -c "print(0)"'], 'executionTimeout': ['600']}
        params_sha = c.r.c.fingerprint(changed)
        c.path(self.output, 'verify', 'parameters').write_bytes(c.recovery.encoded(changed))
        for suffix in ('invocation-metadata', 'send-intent', 'result'):
            stored = c.path(self.output, 'verify', suffix)
            value = CORE.closed_json(CORE.private_bytes(stored))
            value['parametersSha256'] = params_sha
            stored.write_bytes(c.recovery.encoded(value))
        value = CORE.closed_json(CORE.private_bytes(c.path(self.output, 'verify', 'result')))
        # The unchanged actual native still validates against the forged hash:
        # source-expected command comparison must independently reject it.
        self.assertEqual(value, c.validate_native(CORE, original_native, 'verify', P,
            IDS['verify'], CONTEXT, params_sha))
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaisesRegex(RuntimeError, 'PRIOR_PARAMETERS_CHANGED'):
                c.prior_result(CORE, self.output, 'recover', P, CONTEXT)
            calls.assert_not_called()
        self.assertEqual(CORE.private_bytes(native_path), original_native)

    def test_readback_rechecks_historical_recover_parameters_with_approval_false(self):
        self.complete('verify'); recovered, _calls = self.complete('recover')
        stored = CORE.closed_json(CORE.private_bytes(c.path(self.output, 'recover', 'parameters')))
        os.environ['API_FAULT_RESTORE_APPROVED'] = 'false'
        with patch.object(c.client, 'command_raw') as calls:
            self.assertEqual(c.parameter_spec('recover', CORE, P, CONTEXT), stored)
            self.assertEqual(c.prior_result(CORE, self.output, 'readback', P, CONTEXT), recovered)
            calls.assert_not_called()
        self.assertEqual(os.environ['API_FAULT_RESTORE_APPROVED'], 'false')
        with self.assertRaisesRegex(RuntimeError, 'APPROVAL_REQUIRED'):
            c.parameters('recover', CORE, P, CONTEXT)
        result, calls = self.complete('readback')
        self.assertEqual(result['commandId'], IDS['readback'])
        self.assertEqual(sum(row.args[4] == 'send-command' for row in calls.call_args_list), 1)
        self.assertEqual(os.environ['API_FAULT_RESTORE_APPROVED'], 'false')

    def test_readback_requires_a_new_uuid_and_equal_final_receipt(self):
        self.complete('verify'); self.complete('recover')
        with patch.object(c.client, 'command_raw', return_value=IDS['recover'].encode()) as calls:
            with self.assertRaisesRegex(RuntimeError, 'INDEPENDENT_COMMAND_REQUIRED'):
                c.transport('readback', CORE, P, self.output, CONTEXT, BINDING, {})
            self.assertEqual(calls.call_count, 1)

    def test_changed_readback_state_is_rejected_after_native_authentication(self):
        self.complete('verify'); self.complete('recover')
        value = receipt('readback')
        value['recoveryRecordBytesSha256'] = 'b' * 64
        with self.assertRaisesRegex(RuntimeError, 'READBACK_RECEIPT_CHANGED'):
            self.complete('readback', value=value)
        self.assertFalse(c.path(self.output, 'readback', 'result').exists())

    def test_timeout_after_acceptance_never_resubmits_even_when_result_is_late(self):
        trace = {}
        with patch.object(c.client, 'command_raw', return_value=IDS['verify'].encode()) as calls, \
                patch.object(c.time, 'monotonic', side_effect=[0, 646]):
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_TIMEOUT_NO_REPLAY'):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, trace)
            self.assertEqual(calls.call_count, 1)
        self.assertTrue(trace['accepted'])
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaisesRegex(RuntimeError, 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, {})
            calls.assert_not_called()

    def test_submit_uncertainty_preserves_intent_and_does_not_retry(self):
        with patch.object(c.client, 'command_raw', side_effect=subprocess.TimeoutExpired('secret-command', 45)) as calls:
            with self.assertRaises(subprocess.TimeoutExpired):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, {})
            self.assertEqual(calls.call_count, 1)
        self.assertTrue(c.path(self.output, 'verify', 'send-intent').exists())
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaisesRegex(RuntimeError, 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, {})
            calls.assert_not_called()

    def test_wrong_identity_truncated_wire_and_executor_receipt_are_rejected(self):
        good = native('recover')
        for raw in (good[:-2], native('recover', command_id=IDS['verify'])):
            with self.subTest(raw=raw[:30]), self.assertRaises(Exception):
                c.validate_native(CORE, raw, 'recover', P, IDS['recover'], CONTEXT, 'c' * 64)
        bad = receipt('recover')
        bad['recoveryExecutor'] = dict(P, workflowRunId='903')
        with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_RECEIPT_CHANGED'):
            c.validate_native(CORE, native('recover', value=bad), 'recover', P, IDS['recover'], CONTEXT, 'c' * 64)
        wrong = json.loads(good)
        frame = json.loads(wrong['StandardOutputContent'])
        frame['payloadSha256'] = '0' * 64
        wrong['StandardOutputContent'] = json.dumps(frame)
        with self.assertRaisesRegex(RuntimeError, 'WIRE_CHANGED'):
            c.validate_native(CORE, json.dumps(wrong).encode(), 'recover', P, IDS['recover'], CONTEXT, 'c' * 64)

    def test_pending_wrong_uuid_is_rejected_without_retry(self):
        raw = json.dumps({'CommandId': IDS['readback'], 'InstanceId': c.recovery.ORIGIN['instanceId'],
            'Status': 'Pending'}).encode()
        with patch.object(c.client, 'command_raw', side_effect=[IDS['verify'].encode(), raw]) as calls:
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_IDENTITY_CHANGED'):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, {})
            self.assertEqual(calls.call_count, 2)

    def test_server_rejection_is_known_failure_and_remains_unreplayed(self):
        rejection = {'version': 1, 'scope': c.r.SCOPE, 'kind': c.r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED',
            'code': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_MARKER_CHANGED'}
        trace = {}
        with patch.object(c.client, 'command_raw', side_effect=[IDS['verify'].encode(),
                native('verify', value=rejection, status='Failed')]):
            with self.assertRaises(c.client.NativeFailure) as caught:
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, trace)
        summary = c.failure_summary(caught.exception, 'verify', P, trace)
        self.assertEqual(summary['outcome'], 'COMMAND_FAILED')
        self.assertTrue(summary['nativeAuthenticated'])
        self.assertFalse(summary['automaticRetryAllowed'])
        with patch.object(c.client, 'command_raw') as calls:
            with self.assertRaisesRegex(RuntimeError, 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                c.transport('verify', CORE, P, self.output, CONTEXT, BINDING, {})
            calls.assert_not_called()

    def test_safe_diagnostic_does_not_format_unknown_exception_values(self):
        class UnsafeError(Exception):
            def __str__(self):
                raise AssertionError('must not format a secret')
        for error in (UnsafeError('secret'), RuntimeError('secret'), subprocess.TimeoutExpired('secret', 45)):
            summary = c.failure_summary(error, 'verify', P, {'phase': 'poll', 'accepted': True})
            self.assertEqual(summary['outcome'], 'RESULT_UNKNOWN')
            self.assertNotIn('secret', json.dumps(summary))

    def test_original_artifact_is_reauthenticated_and_original_command_only_gets(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr(c.r.PREFIX + '-preflight.json', CONTEXT['preflightRaw'])
            archive.writestr(c.r.PREFIX + '-build-proof.json', CONTEXT['proofRaw'])
        raw = stream.getvalue()
        binding = dict(BINDING, artifactBytesSha256=c.r.c.digest(raw))
        diagnostic = SimpleNamespace(CAP=4 * 1024 * 1024,
            artifact_bytes=Mock(return_value=raw), read_command=Mock(return_value=CONTEXT['failureRaw']))
        def original(run, attempt):
            diagnostic.artifact_bytes(55)
            return binding
        diagnostic.original_evidence = Mock(side_effect=original)
        with patch.object(c, 'load', return_value=diagnostic):
            context, actual = c.original_inputs(CORE)
            self.assertEqual(context, CONTEXT)
            self.assertEqual(actual, binding)
            self.assertIn('get-command-invocation', diagnostic.read_command.call_args.args[0])
            self.assertNotIn('send-command', diagnostic.read_command.call_args.args[0])
            diagnostic.original_evidence.assert_called_once_with(
                c.recovery.FAILED_PRODUCER['workflowRunId'], c.recovery.FAILED_PRODUCER['workflowRunAttempt'])
            diagnostic.artifact_bytes.return_value = raw + b'changed'
            with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_ARTIFACT_CHANGED'):
                c.original_inputs(CORE)
            diagnostic.artifact_bytes.return_value = raw
            diagnostic.original_evidence.side_effect = lambda run, attempt: dict(binding, commandId=IDS['verify'])
            with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_BINDING_CHANGED'):
                c.original_inputs(CORE)

    def test_inputs_reuse_requires_fixed_bytes_same_source_and_successful_actual_verify(self):
        origin = {**c.recovery.ORIGIN, **{key: c.r.c.digest(CONTEXT[name]) for name, key in c.INPUT_HASHES.items()}}
        with patch.object(c.recovery, 'ORIGIN', origin), patch.object(c, 'original_inputs',
                return_value=(CONTEXT, BINDING)) as original:
            self.assertEqual(c.input_cache(CORE, P, self.output, 'verify'), (CONTEXT, BINDING))
            with self.assertRaises(FileNotFoundError):
                c.input_cache(CORE, P, self.output, 'recover')
            self.complete('verify')
            self.assertEqual(c.input_cache(CORE, P, self.output, 'recover'), (CONTEXT, BINDING))
            self.complete('recover')
            self.assertEqual(c.input_cache(CORE, P, self.output, 'readback'), (CONTEXT, BINDING))
            original.assert_called_once()
            with self.assertRaisesRegex(RuntimeError, 'INPUTS_ALREADY_CAPTURED'):
                c.input_cache(CORE, P, self.output, 'verify')
            with self.assertRaisesRegex(RuntimeError, 'CACHED_INPUTS_CHANGED'):
                c.input_cache(CORE, dict(P, sourceTree='c' * 40), self.output, 'recover')
            destination = self.output / (c.PREFIX + '-original-inputs.json')
            value = CORE.closed_json(CORE.private_bytes(destination))
            value['rawBase64']['proofRaw'] = base64.b64encode(b'changed').decode()
            destination.write_bytes(c.recovery.encoded(value))
            with self.assertRaisesRegex(RuntimeError, 'CACHED_INPUTS_CHANGED'):
                c.input_cache(CORE, P, self.output, 'recover')

    def test_default_main_calls_only_verify_and_reports_no_release_authority(self):
        value = c.validate_native(CORE, native('verify'), 'verify', P, IDS['verify'], CONTEXT, 'c' * 64)
        with patch.object(c.client, 'output_directory', return_value=self.output), \
                patch.object(c, 'original_inputs', return_value=(CONTEXT, BINDING)), \
                patch.object(c, 'transport', return_value=value) as run, redirect_stdout(io.StringIO()) as out:
            self.assertEqual(c.main([]), 0)
            self.assertEqual(run.call_args.args[0], 'verify')
            self.assertFalse(json.loads(out.getvalue())['releaseAuthority'])

    def test_workflow_retains_main_source_quality_concurrency_and_explicit_approval(self):
        workflow = (PATH.parents[2] / '.github/workflows/online-recharge-recovery.yml').read_text()
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('bash scripts/production-release/check-source.sh', workflow)
        self.assertIn('TZ: Asia/Kuala_Lumpur', workflow)
        self.assertEqual(workflow.count('if: inputs.api_fault_restore_approved == true'), 2)
        self.assertIn('default: false', workflow)
        self.assertLess(workflow.index('check-source.sh'), workflow.index('configure-aws-credentials@'))
        self.assertLess(workflow.index('readonly.py verify'), workflow.index('readonly.py recover'))
        self.assertLess(workflow.index('readonly.py recover'), workflow.index('readonly.py readback'))
        for forbidden in ('docker ', 'build-images.sh', 'preflight', 'dispatch.sh', 'release-storage.py',
                          'ecr ', 'actions: write', 'contents: write'):
            self.assertNotIn(forbidden, workflow)


if __name__ == '__main__':
    unittest.main()
