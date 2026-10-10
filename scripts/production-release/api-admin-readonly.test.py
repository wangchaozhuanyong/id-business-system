"""Exercise the real pinned Workspace staging and dispatch contracts offline."""
import hashlib
import ast
import builtins
import gzip
import zlib
import base64
import contextlib
import io
import copy
import importlib.util
import json
import os
from pathlib import Path
import runpy
import shlex
import sys
import stat
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime/apple-hidden-mailbox-20261009/main373-merge/readonly-transport-tests'
COMMIT, TREE, PREVIOUS = 'a' * 40, 'b' * 40, 'c' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
COMMON_CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py')
ONLINE_CONTROLLERS = (*COMMON_CONTROLLERS, 'online-recharge-scope.py', 'online-recharge-recovery.json')
WORKSPACE_CONTROLLERS = (*ONLINE_CONTROLLERS,
                         'api-admin-pending-projection.py')
WORKSPACE_READONLY_CONTROLLERS = (*WORKSPACE_CONTROLLERS,
    'api-admin-readonly.py', 'api-admin-pending-receipt-wire.py')

spec = importlib.util.spec_from_file_location('api_admin_transport',
    Path(__file__).with_name('api-admin-readonly.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class WorkspaceStagingTests(unittest.TestCase):
    def assert_combined_pinned(self, commands):
        import ast
        import gzip
        carriers = [line for line in commands if line.startswith('python3 -B -c ')]
        self.assertEqual(len(carriers), 1)
        self.assertLess(commands.index(carriers[0]), len(commands) - 1)
        bootstrap = ast.parse(shlex.split(carriers[0])[3])
        payload = next(node.args[0].value for node in ast.walk(bootstrap)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'b85decode')
        program_raw = gzip.decompress(base64.b85decode(payload))
        assertions = [node for node in ast.walk(bootstrap) if isinstance(node, ast.Compare)]
        self.assertTrue(any(isinstance(node.comparators[0], ast.Constant)
            and node.comparators[0].value == hashlib.sha256(program_raw).hexdigest() for node in assertions))
        program = ast.parse(program_raw.decode())
        stores = [node for node in ast.walk(program) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == '_store_files']
        self.assertEqual(len(stores), 2)
        controllers, package = [ast.literal_eval(node.args[2]) for node in stores]
        self.assertEqual(set(controllers), set(transport.FORMAL_RUNTIME_CONTROLLERS))
        self.assertEqual(set(package), set(transport.FORMAL_RUNTIME_FILES))
        for name, digest in controllers.items():
            self.assertEqual(digest, hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest())
        for name, digest in package.items():
            self.assertEqual(digest, hashlib.sha256((Path(__file__).with_name('formal-runtime-package') / name).read_bytes()).hexdigest())
        self.assertFalse(any(line.startswith('curl ') or 'sha256sum -c -' in line for line in commands))

    def assert_pinned(self, commands, filenames):
        """Every executable comes from the candidate and is verified before execution."""
        assignments = [line for line in commands if line.startswith('readonly release_controller_directory=')]
        if assignments:
            self.assertEqual(len(assignments), 1)
            tokens = shlex.split(assignments[0])
            self.assertEqual(tokens, ['readonly',
                f'release_controller_directory=/opt/id-business-v2/.staging/oidc-{COMMIT}',
                f'release_controller_url=https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{COMMIT}/scripts/production-release'])
            values = dict(token.split('=', 1) for token in tokens[1:])
            expanded = []
            for line in commands:
                for key, value in values.items():
                    line = line.replace('$' + key, value)
                expanded.append(' '.join(shlex.split(line)) if line.startswith('curl ') else line)
            commands = expanded
        for filename in filenames:
            digest = hashlib.sha256(Path(__file__).with_name(filename).read_bytes()).hexdigest()
            downloads = [index for index, command in enumerate(commands)
                if command.startswith('curl ') and
                f'/{COMMIT}/scripts/production-release/{filename} -o ' in command]
            checks = [index for index, command in enumerate(commands)
                if command.startswith(f'echo "{digest}  ') and
                command.endswith('sha256sum -c - >/dev/null')]
            self.assertEqual(len(downloads), 1, filename)
            self.assertEqual(len(checks), 1, filename)
            self.assertEqual(checks[0], downloads[0] + 1, filename)
            self.assertLess(checks[0], len(commands) - 1, filename)
        self.assertEqual(sum('sha256sum -c -' in command for command in commands), len(filenames))

    def test_workspace_preflight_and_readback_pin_online_reader_before_execution(self):
        for mode in ('preflight', 'readback'):
            with self.subTest(mode=mode):
                parameters = transport.parameters(COMMIT, PREVIOUS, mode, 'API_ADMIN_WORKSPACE')
                self.assert_pinned(parameters['commands'], WORKSPACE_READONLY_CONTROLLERS)
                self.assertEqual(parameters['executionTimeout'], ['300'])
                self.assertTrue(parameters['commands'][-1].endswith(
                    f'--api-workspace-{mode} --expected-current {PREVIOUS}'))
                self.assertNotIn('--online-recharge-only', '\n'.join(parameters['commands']))
                self.assertNotIn('--online-recharge-preflight', '\n'.join(parameters['commands']))
                self.assertLess(len(json.dumps(parameters).encode()), 48 * 1024)

    def test_other_api_readers_retain_two_controller_contract(self):
        for scope in ('API_ADMIN', 'API_ADMIN_MIGRATION', 'API_REGISTRATION'):
            with self.subTest(scope=scope):
                parameters = transport.parameters(COMMIT, PREVIOUS, 'preflight', scope)
                self.assert_pinned(parameters['commands'], COMMON_CONTROLLERS)
                self.assertNotIn('online-recharge-scope.py', '\n'.join(parameters['commands']))

    def test_declaration_producer_is_closed_candidate_metadata(self):
        producer = {'commit': COMMIT, 'sourceTree': TREE,
                    'workflowRunId': '123', 'workflowRunAttempt': '1'}
        parameters = transport.parameters(COMMIT, PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE',
                                          declaration_producer=producer)
        self.assert_combined_pinned(parameters['commands'])
        encoded = parameters['commands'][-1].split(' --declaration-producer ', 1)[1]
        self.assertEqual(json.loads(base64.b64decode(encoded, validate=True)), producer)
        self.assertLess(len(json.dumps(parameters).encode()), 48 * 1024)
        for value in [{**producer, 'commit': 'f' * 40}, {**producer, 'sourceTree': TREE + ';x'},
                {**producer, 'workflowRunId': True}, {**producer, 'workflowRunAttempt': '0'},
                {**producer, 'extra': 'not-authoritative'}, {'commit': COMMIT}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                transport.parameters(COMMIT, PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE',
                                     declaration_producer=value)
        with self.assertRaises(ValueError):
            transport.parameters(COMMIT, PREVIOUS, 'preflight', 'API_ADMIN',
                                 declaration_producer=producer)

    def test_workspace_decoder_roundtrip_does_not_grant_receipt_authority(self):
        wire = runpy.run_path(str(Path(__file__).with_name('api-admin-pending-receipt-wire.py')))
        receipt = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'commit': PREVIOUS,
            'pendingOnlineMigrationOrigin': {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION',
                'restoredConfigurationProof': {'version': 3, 'kind': 'API_FIXED_DECLARATION_EQUIVALENCE'}}}
        output = wire['receipt_output'](receipt, scope='API_ADMIN_WORKSPACE') + '\n'
        decoded = transport.decode_transport_receipt(output, 'API_ADMIN_WORKSPACE')
        self.assertEqual(decoded, receipt)
        with self.assertRaises(RuntimeError):
            transport.validate_receipt(decoded, PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE')
        for damaged in (output[:-8], '[]', output + output, 'x' * 24000):
            with self.subTest(damagedLength=len(damaged)), self.assertRaises(RuntimeError):
                transport.decode_transport_receipt(damaged, 'API_ADMIN_WORKSPACE')

    def test_ordinary_receipt_decoder_preserves_existing_scopes(self):
        receipt = {'status': 'ordinary', 'count': 7}
        for scope in ('API_ADMIN_WORKSPACE', 'API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION'):
            self.assertEqual(transport.decode_transport_receipt(json.dumps(receipt), scope), receipt)

    def test_raw_command_keeps_original_stdout_bytes(self):
        original = b'{"StandardOutputContent":"same wire\\n"}\n\n'
        with patch.object(transport.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=original)) as called:
            self.assertIs(transport.command_raw('aws', 'fixture'), original)
            self.assertEqual(called.call_args.kwargs, {'capture_output': True, 'timeout': 60})
        with patch.object(transport.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout=b'private failure')), self.assertRaisesRegex(RuntimeError,
                    '^API_ADMIN_TRANSPORT_FAILED$'):
            transport.command_raw('aws', 'fixture')

    def test_successful_workspace_invocation_metadata_is_independent_and_closed(self):
        command_id = '12345678-1234-1234-1234-123456789abc'
        invocation = {'CommandId': command_id, 'InstanceId': 'i-fixture',
            'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'ExecutionEndDateTime': '2026-10-10T00:00:00Z', 'StandardErrorContent': '',
            'StandardOutputContent': '{"status":"verified"}\n'}
        original = (json.dumps(invocation, indent=2) + '\n\n').encode()
        with patch.dict(os.environ, {'PRODUCTION_INSTANCE_ID': 'i-fixture'}, clear=True):
            self.assertEqual(transport.validated_workspace_invocation(original, command_id), invocation)
            for key, value in [('CommandId', '87654321-1234-1234-1234-123456789abc'),
                    ('InstanceId', 'i-other'), ('DocumentName', 'other'), ('PluginName', 'other'), ('Status', 'Failed'),
                    ('ResponseCode', False), ('ResponseCode', 0.0), ('ResponseCode', 1),
                    ('ExecutionEndDateTime', ''), ('StandardErrorContent', 'private error'),
                    ('StandardOutputContent', 'x' * 24000)]:
                raw = json.dumps({**invocation, key: value}).encode()
                with self.subTest(key=key, valueType=type(value).__name__), self.assertRaisesRegex(
                        RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                    transport.validated_workspace_invocation(raw, command_id)

            for raw in (original.decode(), b'[]', b'{"a":1,"a":2}',
                        b'{"a":NaN}', b'\xff', b'x' * (128 * 1024)):
                with self.subTest(rawType=type(raw).__name__), self.assertRaisesRegex(RuntimeError,
                        '^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                    transport.validated_workspace_invocation(raw, command_id)

    def test_private_client_bytes_are_write_once_and_same_bytes_idempotent(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            target = Path(temporary) / 'nested/private.json'
            original = b'{"exact":"bytes"}\n\n'
            transport.write_workspace_private_bytes(target, original)
            first = target.stat()
            transport.write_workspace_private_bytes(target, original)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(stat.S_IMODE(first.st_mode), 0o600)
            self.assertEqual((first.st_ino, first.st_mtime_ns),
                             (target.stat().st_ino, target.stat().st_mtime_ns))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                transport.write_workspace_private_bytes(target, b'x' + original[1:])
            self.assertEqual(target.read_bytes(), original)
            target.chmod(0o644)
            with self.assertRaises(RuntimeError):
                transport.write_workspace_private_bytes(target, original)
            target.chmod(0o600)
            link = Path(temporary) / 'hardlink.json'
            os.link(target, link)
            with self.assertRaises(RuntimeError):
                transport.write_workspace_private_bytes(target, original)

    def test_private_client_writer_rejects_symlinks_and_invalid_paths_without_writes(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            root = Path(temporary)
            original = root / 'original.json'
            transport.write_workspace_private_bytes(original, b'original')
            alias = root / 'alias.json'
            alias.symlink_to(original)
            with self.assertRaises(RuntimeError):
                transport.write_workspace_private_bytes(alias, b'original')
            self.assertEqual(original.read_bytes(), b'original')
            directory = root / 'actual'
            directory.mkdir()
            (root / 'directory-alias').symlink_to(directory, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                transport.write_workspace_private_bytes(root / 'directory-alias/new.json', b'new')
            self.assertFalse((directory / 'new.json').exists())
            for target, raw in ((root / '../escape.json', b'x'), (root / 'empty.json', b''),
                               (root / 'text.json', 'text'), (root / 'large.json', b'x' * (128 * 1024))):
                with self.subTest(name=target.name), self.assertRaises(RuntimeError):
                    transport.write_workspace_private_bytes(target, raw)
            self.assertFalse((root / 'empty.json').exists())

    def test_private_client_writer_rejects_fifo_without_blocking(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            target = Path(temporary) / 'private.json'
            os.mkfifo(target, 0o600)
            program = '''import runpy, sys
namespace = runpy.run_path(sys.argv[1])
try:
    namespace['write_workspace_private_bytes'](sys.argv[2], b'original')
except RuntimeError as error:
    print(str(error))
    raise SystemExit(0)
raise SystemExit(1)
'''
            result = subprocess.run([sys.executable, '-c', program,
                str(Path(__file__).with_name('api-admin-readonly.py')), str(target)],
                capture_output=True, text=True, timeout=2, check=False)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED\n')
            self.assertEqual(result.stderr, '')
            self.assertTrue(stat.S_ISFIFO(target.stat().st_mode))

    def test_artifact_save_uses_actual_builder_and_requires_successful_ack_metadata(self):
        source = runpy.run_path(str(Path(__file__).with_name('api-workspace-declaration-artifacts.py')))
        producer = {'commit': COMMIT, 'sourceTree': TREE,
                    'workflowRunId': '123', 'workflowRunAttempt': '1'}
        command_id = '12345678-1234-1234-1234-123456789abc'
        payload = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
            'commandId': command_id, 'commit': PREVIOUS, 'releaseCandidateCommit': COMMIT,
            'workflowRunId': '123', 'workflowRunAttempt': '1',
            'pendingOnlineMigrationOrigin': {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION',
                'restoredConfigurationProof': {'version': 3, 'kind': 'API_FIXED_DECLARATION_EQUIVALENCE'}}}
        raw = (json.dumps(payload, indent=2) + '\n\n').encode()
        ack = {'status': source['STATUS'], 'kind': 'preflight', 'producer': producer,
               'bytesSha256': hashlib.sha256(raw).hexdigest(), 'length': len(raw)}
        invocation = {'CommandId': command_id, 'InstanceId': 'i-fixture', 'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
            'Status': 'Success', 'ResponseCode': 0, 'ExecutionEndDateTime': '2026-10-10T00:00:00Z',
            'StandardErrorContent': '', 'StandardOutputContent': json.dumps(ack)}
        environment = {'AWS_REGION': 'fixture', 'PRODUCTION_INSTANCE_ID': 'i-fixture'}
        with patch.dict(os.environ, environment, clear=True), patch.object(transport.time, 'sleep'), \
                patch.object(transport, 'command', return_value=command_id) as send, \
                patch.object(transport, 'command_raw', return_value=(json.dumps(invocation) + '\n').encode()):
            result = transport.save_workspace_artifact(producer, 'preflight', raw)
            self.assertEqual(result, {'commandId': command_id, 'kind': 'preflight', 'ack': ack})
            arguments = send.call_args.args
            data = json.loads(arguments[arguments.index('--parameters') + 1])
            self.assertEqual(data, source['artifact_parameters'](producer, 'preflight', raw))
            self.assertLess(len(json.dumps(data).encode()), 20 * 1024)
        cases = []
        for key, value in [('Status', 'Failed'), ('ResponseCode', False), ('InstanceId', 'i-other'),
                           ('StandardErrorContent', 'private error')]:
            cases.append({**invocation, key: value})
        cases.append({**invocation, 'StandardOutputContent': json.dumps({**ack, 'bytesSha256': 'f' * 64})})
        cases.append({**invocation, 'StandardOutputContent': json.dumps({**ack, 'length': True})})
        cases.append({**invocation, 'StandardOutputContent': json.dumps({**ack, 'extra': 'unknown'})})
        for value in cases:
            with self.subTest(status=value['Status']), patch.dict(os.environ, environment, clear=True), \
                    patch.object(transport.time, 'sleep'), patch.object(transport, 'command', return_value=command_id), \
                    patch.object(transport, 'command_raw', return_value=json.dumps(value).encode()), \
                    self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ARTIFACT_SAVE_FAILED$'):
                transport.save_workspace_artifact(producer, 'preflight', raw)
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(transport.time, 'monotonic', side_effect=[0, 301]), \
                patch.object(transport, 'command', return_value=command_id), \
                patch.object(transport, 'command_raw') as get, \
                self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ARTIFACT_SAVE_FAILED$'):
            transport.save_workspace_artifact(producer, 'preflight', raw)
        get.assert_not_called()

    def test_workspace_main_validates_before_private_save_and_preserves_q_raw_bytes(self):
        wire = runpy.run_path(str(Path(__file__).with_name('api-admin-pending-receipt-wire.py')))
        command_id = '12345678-1234-1234-1234-123456789abc'
        environment = {'RELEASE_OPERATION': 'release_api_workspace', 'RELEASE_COMMIT': COMMIT,
            'EXPECTED_CURRENT': PREVIOUS, 'SOURCE_TREE': TREE, 'GITHUB_RUN_ID': '123',
            'GITHUB_RUN_ATTEMPT': '1', 'AWS_REGION': 'fixture', 'PRODUCTION_INSTANCE_ID': 'i-fixture'}
        for mode in ('preflight', 'readback'):
            receipt = {'status': 'API_ADMIN_WORKSPACE_' + ('BASELINE_VERIFIED' if mode == 'preflight' else 'VERIFIED'),
                'commit': PREVIOUS if mode == 'preflight' else COMMIT,
                'pendingOnlineMigrationOrigin': {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION',
                    'restoredConfigurationProof': {'version': 3, 'kind': 'API_FIXED_DECLARATION_EQUIVALENCE'}}}
            invocation = {'CommandId': command_id, 'InstanceId': 'i-fixture', 'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                'Status': 'Success', 'ResponseCode': 0, 'ExecutionEndDateTime': '2026-10-10T00:00:00Z',
                'StandardErrorContent': '', 'StandardOutputContent': wire['receipt_output'](
                    receipt, scope='API_ADMIN_WORKSPACE') + '\n'}
            original = (json.dumps(invocation, indent=2) + '\n\n').encode()
            # Transport-order fixture only. The separate real validator test
            # rejects this deliberately incomplete proof; this grants no authority.
            RUNTIME.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                previous_cwd = Path.cwd()
                trace = []
                def full(*unused, **options):
                    trace.append('full')
                def ended(*unused):
                    trace.append('ended')
                    return []
                def save(producer, kind, raw):
                    trace.append('save')
                    self.assertEqual(trace[:2], ['full', 'ended'])
                    self.assertEqual(producer, {k: environment[n] for k, n in (
                        ('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
                        ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})
                    target = Path('.deploy/production-release/api-workspace-' + mode + '-result.json')
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                    self.assertEqual(kind, 'preflight' if mode == 'preflight' else 'readback-invocation')
                    self.assertEqual(raw, target.read_bytes() if mode == 'preflight' else original)
                    return {'commandId': command_id, 'kind': kind, 'ack': {'fixtureOnly': True}}
                try:
                    os.chdir(temporary)
                    with self.subTest(mode=mode), patch.dict(os.environ, environment, clear=True), \
                            patch.object(sys, 'argv', ['readonly', mode]), patch.object(transport.time, 'sleep'), \
                            patch.object(transport, 'command', return_value=command_id), \
                            patch.object(transport, 'command_raw', return_value=original), \
                            patch.object(transport, 'validate_receipt', side_effect=full), \
                            patch.object(transport, 'validate_pending_ended_failures', side_effect=ended), \
                            patch.object(transport, 'save_workspace_artifact', side_effect=save), \
                            contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(transport.main(), 0)
                    self.assertEqual(trace, ['full', 'ended', 'save'])
                    if mode == 'readback':
                        self.assertEqual(Path('.deploy/production-release/api-workspace-readback-invocation.json').read_bytes(), original)
                finally:
                    os.chdir(previous_cwd)

    def test_workspace_main_rejections_stop_before_save_and_ack_failure_keeps_original_bytes(self):
        wire = runpy.run_path(str(Path(__file__).with_name('api-admin-pending-receipt-wire.py')))
        command_id = '12345678-1234-1234-1234-123456789abc'
        environment = {'RELEASE_OPERATION': 'release_api_workspace', 'RELEASE_COMMIT': COMMIT,
            'EXPECTED_CURRENT': PREVIOUS, 'SOURCE_TREE': TREE, 'GITHUB_RUN_ID': '123',
            'GITHUB_RUN_ATTEMPT': '1', 'AWS_REGION': 'fixture', 'PRODUCTION_INSTANCE_ID': 'i-fixture'}
        for mode in ('preflight', 'readback'):
            for boundary in ('metadata', 'full', 'ended', 'ack'):
                receipt = {'status': 'API_ADMIN_WORKSPACE_' + ('BASELINE_VERIFIED' if mode == 'preflight' else 'VERIFIED'),
                    'commit': PREVIOUS if mode == 'preflight' else COMMIT,
                    'pendingOnlineMigrationOrigin': {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION',
                        'restoredConfigurationProof': {'version': 3, 'kind': 'API_FIXED_DECLARATION_EQUIVALENCE'}}}
                invocation = {'CommandId': command_id, 'InstanceId': 'i-fixture', 'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                    'Status': 'Success', 'ResponseCode': False if boundary == 'metadata' else 0,
                    'ExecutionEndDateTime': '2026-10-10T00:00:00Z', 'StandardErrorContent': '',
                    'StandardOutputContent': wire['receipt_output'](receipt, scope='API_ADMIN_WORKSPACE') + '\n'}
                original = (json.dumps(invocation, indent=2) + '\n\n').encode()
                full_error = RuntimeError('API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED') if boundary == 'full' else None
                ended_error = RuntimeError('API_ADMIN_PENDING_ONLINE_ENDED_FAILURE_CHANGED') if boundary == 'ended' else None
                RUNTIME.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                    previous_cwd = Path.cwd()
                    try:
                        os.chdir(temporary)
                        with self.subTest(mode=mode, boundary=boundary), patch.dict(os.environ, environment, clear=True), \
                                patch.object(sys, 'argv', ['readonly', mode]), patch.object(transport.time, 'sleep'), \
                                patch.object(transport, 'command', return_value=command_id), \
                                patch.object(transport, 'command_raw', return_value=original), \
                                patch.object(transport, 'validate_receipt', side_effect=full_error) as full, \
                                patch.object(transport, 'validate_pending_ended_failures',
                                             side_effect=ended_error, return_value=[]) as ended, \
                                patch.object(transport, 'save_workspace_artifact',
                                    side_effect=RuntimeError('API_ADMIN_PENDING_ONLINE_ARTIFACT_SAVE_FAILED')) as save, \
                                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                            transport.main()
                        target = Path('.deploy/production-release/api-workspace-' + mode + '-result.json')
                        if boundary == 'ack':
                            self.assertTrue(target.is_file())
                            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                            save.assert_called_once()
                            if mode == 'readback':
                                self.assertEqual(Path('.deploy/production-release/api-workspace-readback-invocation.json').read_bytes(), original)
                        else:
                            self.assertFalse(target.exists())
                            save.assert_not_called()
                        if boundary == 'metadata':
                            full.assert_not_called()
                            ended.assert_not_called()
                        elif boundary == 'full':
                            ended.assert_not_called()
                    finally:
                        os.chdir(previous_cwd)

    def test_current_producer_uses_actual_environment_and_rejects_missing_metadata(self):
        environment = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE,
                       'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        with patch.dict(os.environ, environment, clear=True):
            self.assertEqual(transport.declaration_producer_metadata(), {'commit': COMMIT,
                'sourceTree': TREE, 'workflowRunId': '123', 'workflowRunAttempt': '1'})
        for key in environment:
            with self.subTest(key=key), patch.dict(os.environ,
                    {name: value for name, value in environment.items() if name != key}, clear=True), \
                    self.assertRaisesRegex(RuntimeError, '^API_ADMIN_INPUT_INVALID$'):
                transport.declaration_producer_metadata()

    def test_command_injection_and_publication_mode_cannot_enter_readonly_transport(self):
        cases = [(COMMIT + '; touch sentinel', PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS + '$(touch sentinel)', 'readback', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS, 'release', 'API_ADMIN_WORKSPACE'),
            (COMMIT, PREVIOUS, 'preflight', 'ONLINE_RECHARGE')]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(ValueError):
                transport.parameters(*values)

    def dispatch_parameters(self, operation):
        source = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = source.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        proof_name = {'release_api_workspace': 'api-workspace',
            'release_api_admin': 'api-admin', 'release_online_recharge': 'online-recharge'}[operation]
        proof_bytes = json.dumps({'offlineTransportFixture': proof_name}).encode()
        original_read = Path.read_bytes
        def read(path):
            if path.as_posix() == f'.deploy/production-release/{proof_name}-build-proof.json':
                return proof_bytes
            return original_read(path)
        environment = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'EXPECTED_CURRENT': PREVIOUS,
            'RELEASE_REPOSITORY': REPOSITORY, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '456', 'RELEASE_OPERATION': operation, 'HISTORICAL_EXCEPTION': 'none'}
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            output = Path(temporary) / 'parameters.json'
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(sys, 'argv', ['offline-dispatch', str(output)]), \
                    patch.object(Path, 'read_bytes', read):
                previous_cwd = Path.cwd()
                try:
                    os.chdir(ROOT)
                    exec(compile(program, 'offline-dispatch', 'exec'), {'__name__': '__test__'})
                finally:
                    os.chdir(previous_cwd)
            return json.loads(output.read_text())

    def test_workspace_dispatch_pins_reader_but_cannot_select_online_initial_publication(self):
        parameters = self.dispatch_parameters('release_api_workspace')
        self.assert_combined_pinned(parameters['commands'])
        command = parameters['commands'][-1]
        self.assertIn('--api-workspace-only --api-admin-build-proof ', command)
        self.assertNotIn('--online-recharge-only', command)
        self.assertNotIn('--image-commit', command)
        self.assertNotIn('--historical-', command)
        self.assertEqual(parameters['executionTimeout'], ['3600'])
        self.assertLess(len(json.dumps(parameters).encode()), 48 * 1024)

    def test_original_api_and_online_dispatch_remain_explicit(self):
        api = self.dispatch_parameters('release_api_admin')
        self.assert_pinned(api['commands'], COMMON_CONTROLLERS)
        self.assertIn('--api-admin-only --api-admin-build-proof ', api['commands'][-1])
        self.assertNotIn('online-recharge-scope.py', '\n'.join(api['commands']))
        online = self.dispatch_parameters('release_online_recharge')
        self.assert_pinned(online['commands'], ONLINE_CONTROLLERS)
        self.assertIn('--online-recharge-only --online-recharge-build-proof ', online['commands'][-1])
        self.assertNotIn('--api-workspace-only', online['commands'][-1])


class PendingDeclarationTransportTests(unittest.TestCase):
    """Transport order only; complete declaration semantics have separate tests."""
    def fixture(self, prior_count):
        origin={'version':2,'services':{name:{'containerId':str(i)*64} for i,name in enumerate(
            ('api','admin','mysql','caddy','media-resolver','auto-recharge','auto-registration'),1)},
            'priorPublications':[{'commit':PREVIOUS}] if prior_count else []}
        seal_key='successorConfigurationSeal' if prior_count else 'configurationEquivalenceSeal'
        key='declarationEquivalenceSuccessorPublication' if prior_count else 'declarationEquivalencePublication'
        marker={'originSha256':'d'*64}; summary={seal_key:{'checkedTransportFixture':'e'*64}}
        fingerprint=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        trace=[]
        def validate_summary(_d,value,context,**inputs):
            trace.append((value,context,inputs));return value
        namespace={'validate_pending_online_origin':lambda value:value,
            'pending_online_marker':lambda value:marker,'pending_online_declaration_summary':validate_summary,
            'pending_online_ended_failures':lambda value:[], 'fingerprint':fingerprint}
        before={'status':'API_ADMIN_WORKSPACE_BASELINE_VERIFIED','mode':'preflight',
            'releaseCandidateCommit':COMMIT,'commit':PREVIOUS,'workflowRunId':'123','workflowRunAttempt':'1',
            'pendingOnlineMigrationOrigin':origin,'pendingOnlineEndedFailures':[]}
        raw=(json.dumps(before,indent=2)+'\n\n').encode()
        receipt={'pendingOnlineMigrationOrigin':origin,'preservedPendingOnlineMigration':{**marker,seal_key:summary[seal_key]},
            'onlinePublished':False,'migrationPerformed':False,'services':copy.deepcopy(origin['services']),
            'observedServiceCount':7,'servicesUpdated':['api','admin'],key:summary}
        proof={'pendingOnlineProjection':{},'pendingOnlineOriginSha256':fingerprint(origin)}
        env={'RELEASE_COMMIT':COMMIT,'SOURCE_TREE':TREE,'EXPECTED_CURRENT':PREVIOUS,
            'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1'}
        return SimpleNamespace(namespace=namespace,raw=raw,receipt=receipt,proof=proof,env=env,trace=trace,key=key,seal_key=seal_key)
    def validate(self, fixture):
        RUNTIME.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            previous=Path.cwd()
            try:
                os.chdir(temporary);target=Path('.deploy/production-release/api-workspace-preflight-result.json')
                target.parent.mkdir(parents=True);target.write_bytes(fixture.raw)
                with patch.dict(os.environ,fixture.env,clear=True):
                    return transport.validate_pending_workspace_receipt(fixture.namespace,fixture.receipt,COMMIT,'readback',proof=fixture.proof)
            finally:os.chdir(previous)
    def test_initial_and_b_call_closed_summary_with_original_f_and_actual_producer(self):
        for prior in (0,1):
            with self.subTest(prior=prior):
                f=self.fixture(prior);self.assertTrue(self.validate(f));self.assertEqual(len(f.trace),1)
                value,origin,inputs=f.trace[0]
                self.assertIs(value,f.receipt[f.key]);self.assertEqual(origin,f.receipt['pendingOnlineMigrationOrigin'])
                self.assertEqual(inputs,{'producer':{'commit':COMMIT,'sourceTree':TREE,'workflowRunId':'123','workflowRunAttempt':'1'},
                    'preflight_raw':f.raw,'build_proof_sha256':f.namespace['fingerprint'](f.proof)})
    def test_missing_or_wrong_generation_summary_never_reaches_closed_validator(self):
        for prior in (0,1):
            for change in ('missing','both','wrong'):
                f=self.fixture(prior);other='declarationEquivalencePublication' if prior else 'declarationEquivalenceSuccessorPublication'
                if change!='both':f.receipt.pop(f.key)
                if change!='missing':f.receipt[other]={}
                with self.subTest(prior=prior,change=change),self.assertRaisesRegex(RuntimeError,'^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                    self.validate(f)
                self.assertEqual(f.trace,[])
    def test_marker_and_late_run_drift_reject_after_summary_without_saving(self):
        for prior in (0,1):
            for change in ('marker','run'):
                f=self.fixture(prior)
                if change=='marker':f.receipt['preservedPendingOnlineMigration'][f.seal_key]={}
                else:f.env['GITHUB_RUN_ID']='124'
                with self.subTest(prior=prior,change=change),self.assertRaisesRegex(RuntimeError,'^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):
                    self.validate(f)
    def test_closed_summary_rejection_suppresses_raw_error(self):
        f=self.fixture(1)
        def fail(*args,**kwargs):raise RuntimeError('PRIVATE_TRANSPORT_TEST_VALUE')
        f.namespace['pending_online_declaration_summary']=fail
        with self.assertRaisesRegex(RuntimeError,'^API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED$'):self.validate(f)


class WorkspaceSuccessorReceiptTests(unittest.TestCase):
    """Exercise the actual pure origin validator with a complete synthetic receipt."""
    def setUp(self):
        self.namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')),
            init_globals={'SCOPE': 'API_ADMIN_WORKSPACE'})
        files = {name: '3' * 64 for name in self.namespace['ONLINE_ORIGIN_FILES']}
        files['release-manifest.json'] = '1' * 64
        self.origin = {'version': 1, 'commit': PREVIOUS,
            'release': f'/opt/id-business-v2/releases/20261009T000000Z-{PREVIOUS[:12]}',
            'manifestSha256': '1' * 64, 'buildProofSha256': '2' * 64, 'files': files,
            'migrationState': {'name': '20261009093000_online_recharge',
                'sha256': '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95',
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': '3' * 64}}
        self.volume = {'name': 'fixture_auto_registration_data', 'status': 'PRESENT',
            'identitySha256': '5' * 64}
        names = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
            'auto-registration', 'online-recharge')
        self.services = {name: {'image': 'sha256:' + str(index) * 64,
            'reference': 'fixture:' + name, 'status': 'running', 'health': 'healthy',
            'containerId': str(index) * 64, 'startedAtSha256': 'a' * 64,
            'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
            for index, name in enumerate(names, 1)}
        self.services['online-recharge']['reference'] = f'{REPOSITORY}:{PREVIOUS}-123-1-online-recharge'
        self.origin['binding'] = {key: self.services['online-recharge'][key] for key in
            ('image', 'reference', 'environmentSha256', 'configurationSha256', 'containerId', 'startedAtSha256')}
        self.origin['binding'].update(volumeIdentitySha256='6' * 64,
            apiContainerId=self.services['api']['containerId'])
        self.marker = self.namespace['online_marker'](self.origin)
        self.before = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
            'commit': PREVIOUS, 'releaseCandidateCommit': COMMIT, 'workflowRunId': '123',
            'workflowRunAttempt': '1', 'onlineRechargeOrigin': copy.deepcopy(self.origin),
            'services': copy.deepcopy(self.services)}
        self.migration_origin = {'version': 1, 'commit': self.namespace['MIGRATION_SUCCESSOR_COMMIT'],
            'release': '/opt/id-business-v2/releases/20261008T000000Z-' + self.namespace['MIGRATION_SUCCESSOR_COMMIT'][:12],
            'manifestSha256': self.namespace['MIGRATION_SUCCESSOR_MANIFEST_SHA'],
            'buildProofSha256': self.namespace['MIGRATION_SUCCESSOR_PROOF_SHA'],
            'migration': copy.deepcopy(self.namespace['MIGRATION_IDENTITY']),
            'migrationState': {'name': self.namespace['MIGRATION_NAME'],
                'sha256': self.namespace['MIGRATION_IDENTITY']['sha256'], 'status': 'APPLIED',
                'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64},
            'task': copy.deepcopy(self.namespace['MIGRATION_TASK']),
            'guards': {'rechargeIdle': True, 'registrationBusy': False,
                'registrationLeaseActive': False, 'registrationWindowRetained': True}}
        self.before.update(migrationOrigin=copy.deepcopy(self.migration_origin),
            guards=copy.deepcopy(self.migration_origin['guards']), freeBytes=7 * 1024**3)
        after = copy.deepcopy(self.services)
        after['api'].update(containerId='9' * 64, startedAtSha256='d' * 64)
        after['online-recharge']['containerId'] = 'e' * 64
        after['online-recharge']['startedAtSha256'] = 'f' * 64
        binding = {**self.origin['binding'], 'apiContainerId': after['api']['containerId'],
            'containerId': after['online-recharge']['containerId'],
            'startedAtSha256': after['online-recharge']['startedAtSha256']}
        self.receipt = {'servicesRebound': ['online-recharge'], 'migrationPerformed': False,
            'preservedOnlineRechargeOrigin': copy.deepcopy(self.marker), 'services': after,
            'onlineNetworkRebind': {'version': 1, 'before': copy.deepcopy(self.origin['binding']),
                'after': binding, 'businessActions': 0,
                'sqlFence': {'version': 1, 'busyCount': 0, 'sameConnection': True,
                    'mysqlIdentitySha256': '7' * 64, 'connectionIdSha256': '8' * 64, 'businessActions': 0}}}
        self.receipt.update(preservedMigrationOrigin=self.namespace['migration_successor_marker'](self.migration_origin),
            migrationPreserved=True, taskHmacMatched=True, windowPreserved=True, registrationWindowRetained=True)
        self.environment = {'RELEASE_COMMIT': COMMIT, 'EXPECTED_CURRENT': PREVIOUS,
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}

    def validate_readback(self, receipt=None, before=None, environment=None):
        return transport.validate_online_workspace_receipt(self.namespace,
            self.receipt if receipt is None else receipt, COMMIT, 'readback',
            before=self.before if before is None else before,
            environment=self.environment if environment is None else environment)

    def test_original_workspace_contract_does_not_select_online_successor(self):
        self.assertFalse(transport.validate_online_workspace_receipt(self.namespace,
            {'services': {'api': {}}}, PREVIOUS, 'preflight'))

    def test_eighth_service_requires_verified_origin_and_full_service_set(self):
        self.assertTrue(transport.validate_online_workspace_receipt(self.namespace,
            self.before, PREVIOUS, 'preflight'))
        cases = []
        for key, value in [('onlineRechargeOrigin', None), ('migrationOrigin', None),
                ('guards', {}), ('freeBytes', 6 * 1024**3)]:
            cases.append({**copy.deepcopy(self.before), key: value})
        missing = copy.deepcopy(self.before)
        missing['services'].pop('auto-recharge')
        cases.append(missing)
        extra = copy.deepcopy(self.before)
        extra['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(extra)
        unhealthy = copy.deepcopy(self.before)
        unhealthy['services']['online-recharge']['health'] = 'unhealthy'
        cases.append(unhealthy)
        for key, value in [('configurationSha256', '9' * 64), ('containerId', None), ('extra', 'unsealed')]:
            malformed = copy.deepcopy(self.before)
            malformed['services']['online-recharge'][key] = value
            cases.append(malformed)
        for value in cases:
            with self.subTest(receipt=value), self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
                transport.validate_online_workspace_receipt(self.namespace, value, PREVIOUS, 'preflight')

    def test_successor_readback_binds_same_run_origin_and_actual_rebound(self):
        self.assertTrue(self.validate_readback())
        for key, value in [('mode', 'readback'), ('commit', '9' * 40),
                ('releaseCandidateCommit', '9' * 40), ('workflowRunId', '124'),
                ('workflowRunAttempt', '2'), ('onlineRechargeOrigin', None)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback(before={**self.before, key: value})
        for key, value in [('preservedOnlineRechargeOrigin', {}), ('servicesRebound', []),
                ('migrationPerformed', True), ('onlineNetworkRebind', {})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate_readback({**self.receipt, key: value})
        with self.assertRaises(RuntimeError):
            self.validate_readback(before={})
        with self.assertRaises(RuntimeError):
            self.validate_readback(environment={**self.environment, 'EXPECTED_CURRENT': '9' * 40})
        for key, value in [('GITHUB_RUN_ID', '124'), ('GITHUB_RUN_ATTEMPT', '2')]:
            with self.subTest(environment=key), self.assertRaises(RuntimeError):
                self.validate_readback(environment={**self.environment, key: value})

    def test_engine_and_preserved_services_cannot_silently_change(self):
        for name, key, value in [('online-recharge', 'image', 'sha256:' + '9' * 64),
                ('online-recharge', 'reference', 'fixture:replacement'),
                ('online-recharge', 'environmentSha256', '9' * 64),
                ('online-recharge', 'configurationSha256', '9' * 64),
                ('online-recharge', 'containerId', self.services['online-recharge']['containerId']),
                ('mysql', 'configurationSha256', '9' * 64),
                ('caddy', 'image', 'sha256:' + '9' * 64)]:
            receipt = copy.deepcopy(self.receipt)
            receipt['services'][name][key] = value
            with self.subTest(name=name, key=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)
        for side, key, value in [('before', 'apiContainerId', '9' * 64),
                ('after', 'volumeIdentitySha256', '9' * 64), ('after', 'extra', 'unsealed')]:
            receipt = copy.deepcopy(self.receipt)
            receipt['onlineNetworkRebind'][side][key] = value
            with self.subTest(side=side, key=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)
        for key, value in [('sameConnection', False), ('busyCount', 1), ('businessActions', True)]:
            receipt = copy.deepcopy(self.receipt)
            receipt['onlineNetworkRebind']['sqlFence'][key] = value
            with self.subTest(fence=key), self.assertRaises(RuntimeError):
                self.validate_readback(receipt)

    def test_omitted_successor_fields_cannot_fall_back_after_online_preflight(self):
        with self.assertRaises(RuntimeError):
            self.validate_readback({'services': {'api': {}, 'admin': {}, 'caddy': {}}})

    def test_other_valid_first_publication_origin_cannot_enter_this_baseline(self):
        foreign = {**copy.deepcopy(self.origin), 'commit': '9' * 40,
            'release': '/opt/id-business-v2/releases/20261009T000000Z-' + '9' * 12}
        transport.validate_online_origin(self.namespace, foreign)
        # A later Workspace predecessor legitimately retains the initial online commit.
        continued = {**self.before, 'commit': '9' * 40}
        self.assertTrue(transport.validate_online_workspace_receipt(self.namespace,
            continued, '9' * 40, 'preflight'))
        self.assertTrue(self.validate_readback(before=continued,
            environment={**self.environment, 'EXPECTED_CURRENT': '9' * 40}))
        before = {**self.before, 'onlineRechargeOrigin': foreign}
        receipt = {**self.receipt, 'preservedOnlineRechargeOrigin': self.namespace['online_marker'](foreign)}
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            self.validate_readback(before=before)
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_ORIGIN_RECEIPT_CHANGED'):
            self.validate_readback(receipt)

    def full_readback_contract(self):
        acceptance = {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
            'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
            'businessActions': 0, 'temporaryVolumeRemoved': True}
        proof = {'version': 1, 'scope': 'API_ADMIN_WORKSPACE', 'commit': COMMIT, 'sourceTree': TREE,
            'images': {name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}',
                'imageId': 'sha256:' + str(index) * 64, 'fileCount': 1, 'sha256': str(index) * 64}
                for index, name in enumerate(('api', 'admin'), 1)},
            'configuration': {'composeSha256': 'c' * 64,
                'caddySha256': self.namespace['WORKSPACE_CADDY_AFTER'],
                'volume': self.namespace['WORKSPACE_VOLUME'],
                'containerDirectory': self.namespace['WORKSPACE_DIRECTORY']},
            'acceptance': acceptance}
        receipt = {**copy.deepcopy(self.receipt), 'status': 'API_ADMIN_WORKSPACE_VERIFIED',
            'commit': COMMIT, 'sourceTree': TREE, 'buildProofSha256': self.namespace['fingerprint'](proof),
            'servicesUpdated': list(self.namespace['UPDATED']), 'preservedServiceCount': 4,
            'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'workspaceVolume': copy.deepcopy(self.volume),
            'volumePreserved': True, 'volumeDeletionPerformed': False, 'registrationHealthChecked': True,
            'offlineAcceptance': acceptance}
        for name, row in proof['images'].items():
            receipt['services'][name].update(image=row['imageId'], reference=row['reference'])
        return proof, receipt

    def test_real_proof_and_both_origins_integrate_with_full_independent_preflight_and_readback(self):
        self.assertEqual(transport.validate_receipt(self.before, PREVIOUS, 'preflight',
            'API_ADMIN_WORKSPACE'), self.before)
        proof, receipt = self.full_readback_contract()
        def read(path):
            return json.dumps(proof if path.name == self.namespace['PROOF_FILE'] else self.before)
        with patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', read), \
                patch.object(Path, 'read_bytes', lambda path:read(path).encode()), \
                patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(transport.validate_receipt(receipt, COMMIT, 'readback',
                'API_ADMIN_WORKSPACE'), receipt)
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt({**receipt, 'servicesUpdated': [*self.namespace['UPDATED'], 'online-recharge']},
                    COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            changed = copy.deepcopy(receipt)
            changed['services']['api']['image'] = 'sha256:' + '9' * 64
            with self.assertRaisesRegex(RuntimeError, 'READBACK_BUILD_CHANGED'):
                transport.validate_receipt(changed, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            protection = {'backupVerified': True, 'restoreVerified': True,
                'sqliteProtectionSha256': '1' * 64, 'backupSha256': '2' * 64, 'backupSize': 4096}
            self.assertEqual(transport.validate_receipt({**receipt, 'sqliteProtection': protection},
                COMMIT, 'readback', 'API_ADMIN_WORKSPACE')['sqliteProtection'], protection)
            for key, value in [('backupVerified', False), ('restoreVerified', False),
                    ('backupSize', 0), ('backupSha256', 'invalid')]:
                with self.subTest(sqlite=key), self.assertRaisesRegex(RuntimeError, 'SQLITE_RECEIPT_CHANGED'):
                    transport.validate_receipt({**receipt, 'sqliteProtection': {**protection, key: value}},
                        COMMIT, 'readback', 'API_ADMIN_WORKSPACE')

    def test_coexisting_origins_preflight_refuses_omission_unknown_services_and_wrong_migration(self):
        cases = []
        for key in ('onlineRechargeOrigin', 'migrationOrigin'):
            omitted = copy.deepcopy(self.before); omitted.pop(key); cases.append((key, omitted))
        unknown = copy.deepcopy(self.before)
        unknown['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(('unknown-service', unknown))
        foreign = copy.deepcopy(self.before); foreign['migrationOrigin']['commit'] = '9' * 40
        cases.append(('wrong-migration-origin', foreign))
        wrong_guards = copy.deepcopy(self.before); wrong_guards['guards']['registrationBusy'] = True
        cases.append(('wrong-guards', wrong_guards))
        cases.append(('insufficient-disk', {**copy.deepcopy(self.before), 'freeBytes': 6 * 1024**3}))
        stopped = copy.deepcopy(self.before); stopped['services']['mysql']['status'] = 'exited'
        cases.append(('stopped-service', stopped))
        for label, value in cases:
            with self.subTest(label=label), self.assertRaises(RuntimeError):
                transport.validate_receipt(value, PREVIOUS, 'preflight', 'API_ADMIN_WORKSPACE')

    def test_coexisting_origins_readback_refuses_omission_unknown_services_and_wrong_migration(self):
        proof, valid = self.full_readback_contract()
        cases = []
        for key in ('onlineRechargeOrigin', 'migrationOrigin'):
            before = copy.deepcopy(self.before); before.pop(key)
            cases.append((key, before, copy.deepcopy(valid)))
        for key in ('preservedOnlineRechargeOrigin', 'preservedMigrationOrigin'):
            receipt = copy.deepcopy(valid); receipt.pop(key)
            cases.append((key, copy.deepcopy(self.before), receipt))
        # Removing both migration fields must not fall back to an origin-free path.
        before = copy.deepcopy(self.before); before.pop('migrationOrigin')
        receipt = copy.deepcopy(valid); receipt.pop('preservedMigrationOrigin')
        cases.append(('both-migration-fields', before, receipt))
        foreign = copy.deepcopy(self.before); foreign['migrationOrigin']['migration']['sha256'] = '9' * 64
        cases.append(('wrong-migration-origin', foreign, copy.deepcopy(valid)))
        unknown = copy.deepcopy(valid)
        unknown['services']['unapproved-service'] = copy.deepcopy(self.services['mysql'])
        cases.append(('unknown-service', copy.deepcopy(self.before), unknown))
        for label, before, receipt in cases:
            def read(path):
                return json.dumps(proof if path.name == self.namespace['PROOF_FILE'] else before)
            with self.subTest(label=label), patch.object(Path, 'is_file', return_value=True), \
                    patch.object(Path, 'read_text', read), \
                    patch.object(Path, 'read_bytes', lambda path:read(path).encode()), \
                    patch.dict(os.environ, self.environment, clear=True), \
                    self.assertRaises(RuntimeError):
                transport.validate_receipt(receipt, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')

    def test_original_api_admin_migration_origin_remains_exactly_seven_services(self):
        receipt = copy.deepcopy(self.before); receipt['status'] = 'API_ADMIN_BASELINE_VERIFIED'
        for key in ('onlineRechargeOrigin',):
            receipt.pop(key)
        receipt['services'].pop('online-recharge')
        self.assertEqual(transport.validate_receipt(receipt, PREVIOUS, 'preflight', 'API_ADMIN'), receipt)
        receipt['services']['online-recharge'] = copy.deepcopy(self.services['online-recharge'])
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ORIGIN_RECEIPT_CHANGED'):
            transport.validate_receipt(receipt, PREVIOUS, 'preflight', 'API_ADMIN')


class FormalRuntimeFileTransportTests(unittest.TestCase):
    """Execute the real 21-file program with only private targets and UID/URL fixtures."""
    @classmethod
    def setUpClass(cls):
        cls.namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-readonly.py')))
        source = Path(__file__).parent
        cls.bodies = {
            **{('controller', name): (source / name).read_bytes()
               for name in cls.namespace['FORMAL_RUNTIME_CONTROLLERS']},
            **{('package', name): (source / 'formal-runtime-package' / name).read_bytes()
               for name in cls.namespace['FORMAL_RUNTIME_FILES']},
        }
        command = cls.namespace['formal_runtime_commands'](
            '/opt/id-business-v2/.staging/oidc-' + COMMIT, COMMIT,
            source / 'formal-runtime-package', source)[0]
        tokens = shlex.split(command)
        if tokens[:3] != ['python3', '-B', '-c'] or len(tokens) != 4:
            raise AssertionError('carrier framing')
        cls.bootstrap = ast.parse(tokens[3])
        payload = next(node.args[0].value for node in ast.walk(cls.bootstrap)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'b85decode')
        cls.compressed = base64.b85decode(payload)
        decoder = zlib.decompressobj(31)
        cls.raw = decoder.decompress(cls.compressed, 16385)
        if (not 0 < len(cls.raw) <= 16384 or not decoder.eof
                or decoder.unused_data or decoder.unconsumed_tail):
            raise AssertionError('carrier size')
        digest = next(node.comparators[0].value for node in ast.walk(cls.bootstrap)
            if isinstance(node, ast.Compare) and isinstance(node.left, ast.Call)
            and isinstance(node.left.func, ast.Attribute) and node.left.func.attr == 'hexdigest')
        if hashlib.sha256(cls.raw).hexdigest() != digest:
            raise AssertionError('carrier code sha')
        cls.program = ast.parse(cls.raw)
        stores = [node for node in cls.program.body[-1].body
                  if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                  and isinstance(node.value.func, ast.Name) and node.value.func.id == '_store_files']
        if len(stores) != 2 or [node.value.args[-1].value for node in stores] != [False, True]:
            raise AssertionError('store boundaries')
        for branch, node in zip(('controller', 'package'), stores):
            pins = ast.literal_eval(node.value.args[2])
            expected = {name: hashlib.sha256(body).hexdigest()
                        for (kind, name), body in cls.bodies.items() if kind == branch}
            if pins != expected:
                raise AssertionError('source pins')

    @contextlib.contextmanager
    def sandbox(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='formal-carrier-', dir=RUNTIME) as temporary:
            base = Path(temporary)
            directory = base / 'controllers'
            directory.mkdir(mode=0o700)
            yield base, directory

    def execute_program(self, directory, *, override=None, bad=None, drift=None, uid=0):
        # Public targets remain fixed. This test maps exactly their two literals
        # into its owned sandbox, leaving the complete file algorithm unchanged.
        program = copy.deepcopy(self.program)
        stores = program.body[-1].body
        stores[0].value.args[0] = ast.Constant(str(directory))
        stores[1].value.args[0] = ast.Constant(str(directory / 'formal-runtime-package'))
        if override is not None:
            branch, name, body = override
            node = stores[0 if branch == 'controller' else 1].value
            pins = ast.literal_eval(node.args[2])
            self.assertIn(name, pins)
            pins[name] = hashlib.sha256(body).hexdigest()
            node.args[2] = ast.parse(repr(pins), mode='eval').body
        ast.fix_missing_locations(program)
        self.downloads = []
        url_prefix = ('https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'
                      + COMMIT + '/scripts/production-release/')
        def response(url, timeout):
            self.assertTrue(url.startswith(url_prefix))
            self.assertEqual(timeout, 30)
            relative = url[len(url_prefix):]
            branch = 'package' if relative.startswith('formal-runtime-package/') else 'controller'
            name = relative.rsplit('/', 1)[-1]
            key = (branch, name)
            self.assertIn(key, self.bodies)
            self.downloads.append(key)
            if drift is not None:
                drift(branch, name)
            body = self.bodies[key]
            if bad is not None and key == bad[:2]:
                body = bad[2]
            if override is not None and key == override[:2]:
                body = override[2]
            return io.BytesIO(body)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns')
        real_stat, real_fstat = os.stat, os.fstat
        def root_uid(item):
            # Mock ownership only; every other identity and file operation is real.
            return SimpleNamespace(**{key: 0 if key == 'st_uid' else getattr(item, key)
                                      for key in fields})
        with patch.object(os, 'geteuid', return_value=uid), \
                patch.object(os, 'stat', side_effect=lambda *args, **kwargs:
                             root_uid(real_stat(*args, **kwargs))), \
                patch.object(os, 'fstat', side_effect=lambda *args, **kwargs:
                             root_uid(real_fstat(*args, **kwargs))), \
                patch('urllib.request.urlopen', side_effect=response):
            exec(compile(program, '<real-carrier-private-targets>', 'exec'), {'__name__': '__main__'})

    def assert_rejected(self, directory, **options):
        with self.assertRaisesRegex(SystemExit, '^FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED$'):
            self.execute_program(directory, **options)

    def test_real_program_fresh21_exact_bytes_sha_and_private_modes(self):
        with self.sandbox() as (_, directory):
            self.execute_program(directory)
            self.assertEqual(len(self.downloads), 21)
            for (branch, name), body in self.bodies.items():
                leaf = (directory if branch == 'controller' else
                        directory / 'formal-runtime-package') / name
                self.assertEqual(leaf.read_bytes(), body)
                self.assertEqual(hashlib.sha256(leaf.read_bytes()).hexdigest(),
                                 hashlib.sha256(body).hexdigest())
                self.assertEqual(stat.S_IMODE(leaf.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((directory / 'formal-runtime-package').stat().st_mode), 0o700)
            self.assertEqual(len(list(directory.iterdir())), 12)

    def test_real_program_same_bytes_reuse_inode_and_mtime(self):
        with self.sandbox() as (_, directory):
            self.execute_program(directory)
            before = {}
            for leaf in directory.rglob('*'):
                if leaf.is_file():
                    leaf.chmod(0o644)
                    before[leaf] = (leaf.stat().st_ino, leaf.stat().st_mtime_ns)
            self.execute_program(directory)
            self.assertEqual(len(before), 21)
            self.assertEqual(before, {leaf: (leaf.stat().st_ino, leaf.stat().st_mtime_ns)
                                      for leaf in before})

    def test_real_program_zero_maximum_and_plus_one_limits(self):
        for branch, name, limit in (('controller', 'remote-deploy.py', 2 * 1024**2),
                                     ('package', 'driver.py', 1024**2)):
            for size in (0, limit, limit + 1):
                with self.subTest(branch=branch, size=size), self.sandbox() as (_, directory):
                    options = {'override': (branch, name, b'x' * size)}
                    if size == limit:
                        self.execute_program(directory, **options)
                    else:
                        self.assert_rejected(directory, **options)
                        leaf = (directory if branch == 'controller' else
                                directory / 'formal-runtime-package') / name
                        self.assertFalse(leaf.exists())

    def test_real_program_rejects_symlink_hardlink_and_preserves_other_bytes(self):
        for branch, name in (('controller', 'remote-deploy.py'), ('package', 'driver.py')):
            for kind in ('symlink', 'hardlink', 'different'):
                with self.subTest(branch=branch, kind=kind), self.sandbox() as (base, directory):
                    parent = directory if branch == 'controller' else directory / 'formal-runtime-package'
                    if branch == 'package':
                        parent.mkdir(mode=0o700)
                    leaf = parent / name
                    original = base / 'other'
                    original.write_bytes(self.bodies[(branch, name)])
                    original.chmod(0o600)
                    if kind == 'symlink':
                        leaf.symlink_to(original)
                    elif kind == 'hardlink':
                        os.link(original, leaf)
                    else:
                        leaf.write_bytes(b'own unrelated bytes')
                        leaf.chmod(0o600)
                    self.assert_rejected(directory)
                    self.assertEqual(original.read_bytes(), self.bodies[(branch, name)])
                    if kind == 'different':
                        self.assertEqual(leaf.read_bytes(), b'own unrelated bytes')

    def test_real_program_rejects_fifo_in_bounded_owned_child(self):
        child = '''import runpy, sys
namespace = runpy.run_path(sys.argv[1])
case_class = namespace['FormalRuntimeFileTransportTests']
case_class.setUpClass()
case = case_class('test_real_program_rejects_fifo_in_bounded_owned_child')
try:
    case.execute_program(namespace['Path'](sys.argv[2]))
except SystemExit as error:
    assert str(error) == 'FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED'
    print(str(error))
    raise SystemExit(0)
raise SystemExit(1)
'''
        for branch, name in (('controller', 'remote-deploy.py'), ('package', 'driver.py')):
            with self.subTest(branch=branch), self.sandbox() as (_, directory):
                parent = directory if branch == 'controller' else directory / 'formal-runtime-package'
                if branch == 'package':
                    parent.mkdir(mode=0o700)
                leaf = parent / name
                os.mkfifo(leaf, 0o600)
                result = subprocess.run([sys.executable, '-B', '-c', child, str(Path(__file__)),
                                         str(directory)], capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, 'FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED\n')
                self.assertEqual(result.stderr, '')
                self.assertTrue(stat.S_ISFIFO(leaf.stat().st_mode))

    def test_real_program_rejects_parent_replacement_after_download(self):
        for branch in ('controller', 'package'):
            with self.subTest(branch=branch), self.sandbox() as (base, directory):
                changed = False
                def drift(current, unused):
                    nonlocal changed
                    if current == branch and not changed:
                        parent = directory if branch == 'controller' else directory / 'formal-runtime-package'
                        parent.rename(base / 'moved')
                        parent.mkdir(mode=0o700)
                        changed = True
                self.assert_rejected(directory, drift=drift)
                self.assertTrue(changed)

    def test_real_program_directory_modes_nonroot_and_bad_sha(self):
        with self.sandbox() as (_, directory):
            directory.chmod(0o755)
            self.execute_program(directory)
        with self.sandbox() as (_, directory):
            (directory / 'formal-runtime-package').mkdir(mode=0o755)
            self.assert_rejected(directory)
            self.assertEqual(len(self.downloads), 11)
        with self.sandbox() as (_, directory):
            self.assert_rejected(directory, uid=501)
            self.assertEqual(self.downloads, [])
        for branch, name in (('controller', 'remote-deploy.py'), ('package', 'driver.py')):
            with self.subTest(branch=branch), self.sandbox() as (_, directory):
                self.assert_rejected(directory, bad=(branch, name, b'wrong source bytes'))
                leaf = (directory if branch == 'controller' else directory / 'formal-runtime-package') / name
                self.assertFalse(leaf.exists())

    def test_bounded_carrier_corruption_rejects_before_code_execution(self):
        variants = (('invalid-b85', ' '),
                    ('truncated', base64.b85encode(self.compressed[:-8]).decode()),
                    ('trailing', base64.b85encode(self.compressed + b'x').decode()),
                    ('concat', base64.b85encode(self.compressed + gzip.compress(self.raw)).decode()),
                    ('oversize', base64.b85encode(gzip.compress(b'x' * 16385)).decode()),
                    ('code-sha', base64.b85encode(gzip.compress(self.raw + b'\n# drift')).decode()))
        for name, payload in variants:
            with self.subTest(name=name):
                bootstrap = copy.deepcopy(self.bootstrap)
                decode = next(node for node in ast.walk(bootstrap)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == 'b85decode')
                decode.args[0] = ast.Constant(payload)
                ast.fix_missing_locations(bootstrap)
                code_executed = []
                def forbidden_code(*unused):
                    code_executed.append(True)
                    raise AssertionError('unexpected carrier execution')
                # This non-authoritative sentinel prevents any production target
                # from being reached even if a future decoder regression accepts it.
                namespace = {'__builtins__': {**vars(builtins), 'exec': forbidden_code}}
                with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')) as network:
                    with self.assertRaises((AssertionError, ValueError, zlib.error)):
                        exec(compile(bootstrap, '<real-carrier-corruption>', 'exec'), namespace)
                    network.assert_not_called()
                self.assertEqual(code_executed, [])

    def test_carrier_public_target_validation_remains_fixed(self):
        source = Path(__file__).parent
        for directory, commit in (('/opt/other', COMMIT),
                ('/opt/id-business-v2/.staging/oidc-' + COMMIT + '/extra', COMMIT),
                ('/opt/id-business-v2/.staging/oidc-' + COMMIT, COMMIT + ';x')):
            with self.subTest(directory=directory), self.assertRaisesRegex(
                    RuntimeError, '^FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED$'):
                self.namespace['formal_runtime_commands'](directory, commit,
                    source / 'formal-runtime-package', source)


if __name__ == '__main__':
    unittest.main()
