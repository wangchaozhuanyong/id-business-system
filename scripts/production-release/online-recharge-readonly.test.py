import ast
import shlex
import os
import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
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
        for name in ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
                     'online-recharge-recovery.json'):
            digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            self.assertEqual(sum(digest in item for item in commands), 1)
            self.assertTrue(any('/' + 'a' * 40 + '/scripts/production-release/' + name in item for item in commands))
        self.assertTrue(commands[-1].endswith('--online-recharge-preflight --expected-current ' + 'b' * 40))

    def test_recovery_policy_cannot_be_read_before_its_candidate_digest_check(self):
        commands = transport.parameters('a' * 40, 'b' * 40, 'preflight')['commands']
        policy = 'online-recharge-recovery.json'
        download = next(i for i, item in enumerate(commands) if item.startswith('curl ') and policy in item)
        verification = next(i for i, item in enumerate(commands) if policy in item and 'sha256sum -c' in item)
        self.assertLess(download, verification)
        self.assertLess(verification, len(commands) - 1)
        self.assertIn('/' + 'a' * 40 + '/scripts/production-release/' + policy, commands[download])
        self.assertNotIn('28a3ba4ffd17d36001b1104c97394f5ae871d73d', commands[download])

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

    def test_independent_readback_binds_recovery_origin_and_no_repeated_migration(self):
        preserved = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
        updated = ('admin', 'api', 'online-recharge')
        commit, tree = 'a' * 40, 'b' * 40
        services = {name: {'image': 'sha256:' + 'c' * 64, 'reference': 'fixture-' + name}
                    for name in (*preserved, *updated)}
        proof = {'sourceTree': tree, 'images': {name: {'imageId': services[name]['image'],
                 'reference': services[name]['reference']} for name in updated}}
        digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        marker = {'version': 1, 'failureReceiptSha256': 'd' * 64}
        summary = {'sourceTree': tree, 'buildProofSha256': digest,
                   'migrationRecovery': marker, 'migrationPerformed': False}
        before = {'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'releaseCandidateCommit': commit,
                  'workflowRunId': '42', 'workflowRunAttempt': '1', 'migrationRecovery': marker,
                  'migrationPerformed': False, 'services': {name: services[name] for name in preserved}}
        scope = SimpleNamespace(PRESERVED=preserved, UPDATED=updated,
            validate_receipt=lambda *args: summary, validate_proof=lambda *args: None,
            fingerprint=lambda value: hashlib.sha256(json.dumps(value, sort_keys=True,
                separators=(',', ':')).encode()).hexdigest())
        receipt = {'services': services}
        environment = {'SOURCE_TREE': tree, 'RELEASE_REPOSITORY': 'fixture-registry',
                       'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1'}
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder, patch.dict(transport.os.environ, environment), \
                patch.object(transport.runpy, 'run_path', return_value={'online_recharge_scope': lambda: (scope, None)}):
            output = Path(folder)
            (output / 'online-recharge-build-proof.json').write_text(json.dumps(proof))
            (output / 'online-recharge-preflight-result.json').write_text(json.dumps(before))
            self.assertEqual(transport.validate(receipt, 'readback', commit, commit, output)['migrationRecovery'], marker)
            for changes in ({'migrationRecovery': None}, {'migrationRecovery': {'version': 1}},
                            {'migrationPerformed': True}, {'migrationPerformed': 0}):
                with self.subTest(changes=changes), patch.object(scope, 'validate_receipt',
                        return_value={**summary, **changes}), self.assertRaisesRegex(ValueError, 'READBACK_BINDING_CHANGED'):
                    transport.validate(receipt, 'readback', commit, commit, output)
            for changes in ({'migrationRecovery': None}, {'migrationPerformed': True}, {'workflowRunId': '43'}):
                (output / 'online-recharge-preflight-result.json').write_text(json.dumps({**before, **changes}))
                with self.subTest(before=changes), self.assertRaisesRegex(ValueError, 'READBACK_BINDING_CHANGED'):
                    transport.validate(receipt, 'readback', commit, commit, output)
            initial = {key: value for key, value in before.items()
                       if key not in ('migrationRecovery', 'migrationPerformed')}
            (output / 'online-recharge-preflight-result.json').write_text(json.dumps(initial))
            fresh = {**summary, 'migrationRecovery': None, 'migrationPerformed': True}
            with patch.object(scope, 'validate_receipt', return_value=fresh):
                self.assertTrue(transport.validate(receipt, 'readback', commit, commit, output)['migrationPerformed'])
            with patch.object(scope, 'validate_receipt', return_value={**fresh, 'migrationPerformed': False}), \
                    self.assertRaisesRegex(ValueError, 'READBACK_BINDING_CHANGED'):
                transport.validate(receipt, 'readback', commit, commit, output)




class PendingWorkspaceTransportTests(unittest.TestCase):
    def producer(self):
        return {'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'124','workflowRunAttempt':'1'}

    def fixture(self):
        ordinary={'syntheticOnly':True}
        command='12345678-1234-1234-1234-123456789abc'
        f={'kind':'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT','version':2,'mode':'preflight',
            'status':'ONLINE_RECHARGE_PENDING_WORKSPACE_BASELINE_VERIFIED','commandId':command,
            'releaseCandidateCommit':'a'*40,'workflowRunId':'124','workflowRunAttempt':'1','sourceTree':'b'*40,
            'baseline':{},'services':{},'ordinaryPreflight':ordinary}
        q={'CommandId':command,'InstanceId':'i-12345678901234567','DocumentName':'AWS-RunShellScript',
            'PluginName':'aws:runShellScript','ResponseCode':0,'Status':'Success',
            'ExecutionEndDateTime':'2026-01-01T00:00:00Z','StandardErrorContent':'',
            'StandardOutputContent':json.dumps(ordinary)}
        return json.dumps(f).encode(),json.dumps(q).encode()

    def env(self):
        p=self.producer()
        return {'RELEASE_OPERATION':'release_online_recharge','RELEASE_COMMIT':p['commit'],
            'SOURCE_TREE':p['sourceTree'],'GITHUB_RUN_ID':p['workflowRunId'],'GITHUB_RUN_ATTEMPT':p['workflowRunAttempt'],
            'EXPECTED_CURRENT':p['commit'],'PRODUCTION_INSTANCE_ID':'i-12345678901234567','AWS_REGION':'ap-northeast-1'}

    def test_real_carrier_retains_all_original_pins_under_20480_bytes(self):
        with patch.dict(os.environ,self.env(),clear=True):
            value=transport.pending_workspace_parameters('a'*40,'a'*40,'preflight',self.producer())
        self.assertLess(len(json.dumps(value).encode()),20480)
        command='\n'.join(value['commands'])
        self.assertIn('--online-recharge-preflight --expected-current '+'a'*40,command)
        self.assertNotIn('--api-workspace-preflight',command)
        captured=ast.parse(shlex.split(value['commands'][2])[-1])
        payload=next(n.args[0].value for n in ast.walk(captured) if isinstance(n,ast.Call)
            and isinstance(n.func,ast.Attribute) and n.func.attr=='b85decode')
        source=gzip.decompress(base64.b85decode(payload)).decode()
        for name in ('formal-runtime-package/','reader.py','driver.py','api-admin-scope.py'):
            self.assertIn(name,source)
        pin_maps=[n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.Dict)
            and n.keys and all(isinstance(k,ast.Constant) and isinstance(k.value,str) for k in n.keys)
            and all(isinstance(v,ast.Constant) and isinstance(v.value,str) and len(v.value)==64 for v in n.values)]
        pins={k.value:v.value for node in pin_maps for k,v in zip(node.keys,node.values)}
        control=Path(__file__).parent
        api=transport.runpy.run_path(str(control/'api-admin-readonly.py'))
        expected={name:hashlib.sha256((control/'formal-runtime-package'/name).read_bytes()).hexdigest()
            for name in api['FORMAL_RUNTIME_FILES']}
        expected.update({name:hashlib.sha256((control/name).read_bytes()).hexdigest()
            for name in api['FORMAL_RUNTIME_CONTROLLERS']})
        self.assertEqual(len(expected),21)
        self.assertEqual(pins,expected)
        self.assertIn('sha256',source)
        self.assertIn('urllib.request.urlopen',source)

    def test_install_program_is_bounded_and_fixed_private_root(self):
        f,q=self.fixture()
        value=transport.online_pending_workspace_artifact_parameters(self.producer(),f,q)
        self.assertLess(len(json.dumps(value).encode()),20480)
        self.assertNotIn('/tmp/',json.dumps(value))
        self.assertIn('executionTimeout',value)

    def test_installer_fd_bytes_idempotent_and_changed_bytes_rejected(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            root=Path(folder);root.chmod(0o700)
            p=self.producer();uid=os.geteuid()
            transport._pending_workspace_artifact_store(str(root),uid,p,'preflight',b'synthetic original')
            transport._pending_workspace_artifact_store(str(root),uid,p,'preflight',b'synthetic original')
            target=root/transport._pending_workspace_artifact_directory(p)/transport._PENDING_WORKSPACE_ARTIFACT_FILES['preflight']
            before=(target.stat().st_ino,target.read_bytes())
            with self.assertRaises(RuntimeError):
                transport._pending_workspace_artifact_store(str(root),uid,p,'preflight',b'different bytes')
            self.assertEqual((target.stat().st_ino,target.read_bytes()),before)

    def test_installer_refuses_symlink_without_changing_existing_file(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            root=Path(folder);root.chmod(0o700);p=self.producer()
            original=root/'existing';original.write_bytes(b'original');original.chmod(0o600)
            sub=root/transport._pending_workspace_artifact_directory(p);sub.mkdir(mode=0o700)
            (sub/transport._PENDING_WORKSPACE_ARTIFACT_FILES['preflight']).symlink_to(original)
            with self.assertRaises((RuntimeError,OSError)):
                transport._pending_workspace_artifact_store(str(root),os.geteuid(),p,'preflight',b'other')
            self.assertEqual(original.read_bytes(),b'original')

    def test_payload_rejects_unknown_invocation_fields_and_fake_ordinary_output(self):
        f,q=self.fixture();value=json.loads(q)
        for update in ({'uncontrolledSecret':'fixture'}, {'StandardOutputContent':'{"syntheticOnly":false}'},
                {'Status':'InProgress'},{'CommandId':'87654321-1234-1234-1234-123456789abc'}):
            with self.subTest(update=tuple(update)),self.assertRaises(RuntimeError):
                transport._pending_workspace_artifact_payload(self.producer(),f,json.dumps({**value,**update}).encode())

    def test_wrong_actual_command_and_unended_invocation_rejected(self):
        f,q=self.fixture();value=json.loads(q)
        with patch.dict(os.environ,self.env(),clear=True):
            self.assertEqual(transport._pending_workspace_ended(q,value['CommandId']),value)
            for update in ({'Status':'InProgress'},{'InstanceId':'i-11111111111111111'},
                    {'ExecutionEndDateTime':'2999-01-01T00:00:00Z'}, {'StandardErrorContent':'fixture secret'}):
                with self.subTest(update=tuple(update)),self.assertRaises(RuntimeError):
                    transport._pending_workspace_ended(json.dumps({**value,**update}).encode(),value['CommandId'])
            with self.assertRaises(RuntimeError):
                transport._pending_workspace_ended(q,'87654321-1234-1234-1234-123456789abc')

    def test_decompression_is_limited_and_checksum_bound(self):
        raw=b'synthetic fixture';packed=base64.b64encode(gzip.compress(raw)).decode()
        sha=hashlib.sha256(raw).hexdigest()
        self.assertEqual(transport._pending_workspace_artifact_unpack(packed,sha,len(raw)),raw)
        for digest,size,payload in (('0'*64,len(raw),packed),(sha,len(raw)+1,packed),
                (sha,len(raw),base64.b64encode(gzip.compress(raw)+b'x').decode())):
            with self.assertRaises(RuntimeError):
                transport._pending_workspace_artifact_unpack(payload,digest,size)

    def test_joint_carrier_restores_real_lengths_high_entropy_receipts_below_cap(self):
        f, q = self.fixture()
        ordinary = {'syntheticOnly': True, 'hashes': [hashlib.sha256(('ordinary-' + str(i)).encode()).hexdigest()
            for i in range(160)]}
        preflight, invocation = json.loads(f), json.loads(q)
        preflight.update(ordinaryPreflight=ordinary, baseline={'hashes': [
            hashlib.sha256(('baseline-' + str(i)).encode()).hexdigest() for i in range(80)]})
        invocation['StandardOutputContent'] = json.dumps(ordinary)
        f, q = json.dumps(preflight).encode(), json.dumps(invocation).encode()
        self.assertLess(len(f), 34754)
        self.assertLess(len(q), 19988)
        f, q = f + b' ' * (34754 - len(f)), q + b' ' * (19988 - len(q))
        parameters = transport.online_pending_workspace_artifact_parameters(self.producer(), f, q)
        self.assertLess(len(json.dumps(parameters).encode()), 20480)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            root = Path(folder); root.chmod(0o700)
            program = transport._pending_workspace_artifact_program(self.producer(), f, q, str(root), os.geteuid())
            parsed = ast.parse(program)
            pair_calls = [node for node in ast.walk(parsed) if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name) and node.func.id == '_pending_workspace_artifact_unpack_pair']
            self.assertEqual(len(pair_calls), 1)
            with redirect_stdout(io.StringIO()) as output:
                exec(compile(program, '<synthetic-joint-private-artifact>', 'exec'), {})
            ack = json.loads(output.getvalue())
            transport.online_pending_workspace_validate_artifact_ack(ack, self.producer(), f, q)
            directory = root / transport._pending_workspace_artifact_directory(self.producer())
            self.assertEqual((directory / transport._PENDING_WORKSPACE_ARTIFACT_FILES['preflight']).read_bytes(), f)
            self.assertEqual((directory / transport._PENDING_WORKSPACE_ARTIFACT_FILES['preflight-invocation']).read_bytes(), q)

    def test_joint_unpack_rejects_wrong_boundary_hash_type_and_trailing_data(self):
        originals = (b'first synthetic bytes', b'second synthetic bytes')
        packed = base64.b64encode(gzip.compress(b''.join(originals), mtime=0)).decode()
        expected = tuple(hashlib.sha256(raw).hexdigest() for raw in originals)
        lengths = tuple(len(raw) for raw in originals)
        self.assertEqual(transport._pending_workspace_artifact_unpack_pair(packed, expected, lengths), originals)
        cases = [
            (packed, ('0' * 64, expected[1]), lengths),
            (packed, expected, (lengths[0] + 1, lengths[1] - 1)),
            (packed, expected, (lengths[0], lengths[1] + 1)),
            (packed, expected, (True, lengths[1])),
            (packed, expected, (lengths[0],)),
            (packed, list(expected), lengths),
            (packed + '=', expected, lengths),
            (base64.b64encode(gzip.compress(b''.join(originals)) + b'x').decode(), expected, lengths),
            (base64.b64encode(gzip.compress(b''.join(originals)) + gzip.compress(b'x')).decode(), expected, lengths),
            (base64.b64encode(gzip.compress(b''.join(originals))[:-1]).decode(), expected, lengths),
        ]
        for payload, digests, sizes in cases:
            with self.subTest(payloadBytes=len(payload), lengths=sizes), self.assertRaises((RuntimeError, ValueError)):
                transport._pending_workspace_artifact_unpack_pair(payload, digests, sizes)

    def test_joint_unpack_preserves_individual_limits_and_rejects_zipbomb(self):
        originals = (b'f' * 65535, b'q' * 65535)
        expected = tuple(hashlib.sha256(raw).hexdigest() for raw in originals)
        packed = base64.b64encode(gzip.compress(b''.join(originals), mtime=0)).decode()
        self.assertEqual(transport._pending_workspace_artifact_unpack_pair(packed, expected, (65535, 65535)), originals)
        for lengths in ((65536, 65534), (0, 65535), (65535, False)):
            with self.subTest(lengths=lengths), self.assertRaises(RuntimeError):
                transport._pending_workspace_artifact_unpack_pair(packed, expected, lengths)
        for raw in (b'f' * 131072, b'f' * (1024 * 1024)):
            with self.subTest(rawBytes=len(raw)), self.assertRaises(RuntimeError):
                transport._pending_workspace_artifact_unpack_pair(
                    base64.b64encode(gzip.compress(raw, mtime=0)).decode(), expected, (65535, 65535))

    def test_high_entropy_joint_carrier_cannot_bypass_ssm_parameter_limit(self):
        f, q = self.fixture()
        preflight, invocation = json.loads(f), json.loads(q)
        ordinary = {'syntheticOnly': True, 'hashes': [hashlib.sha256(('ordinary-' + str(i)).encode()).hexdigest()
            for i in range(256)]}
        preflight.update(ordinaryPreflight=ordinary, baseline={'hashes': [
            hashlib.sha256(('disjoint-baseline-' + str(i)).encode()).hexdigest() for i in range(400)]})
        invocation['StandardOutputContent'] = json.dumps(ordinary)
        f, q = json.dumps(preflight).encode(), json.dumps(invocation).encode()
        transport._pending_workspace_artifact_payload(self.producer(), f, q)
        self.assertLess(len(f), 65536)
        self.assertLess(len(q), 65536)
        with self.assertRaisesRegex(RuntimeError, 'ONLINE_RECHARGE_PENDING_WORKSPACE_ARTIFACT_INVALID'):
            transport.online_pending_workspace_artifact_parameters(self.producer(), f, q)


class PendingWorkspaceFailureTransportTests(unittest.TestCase):
    def fixture(self):
        existing = PendingWorkspaceTransportTests()
        environment = {**existing.env(), 'EXPECTED_CURRENT': 'c' * 40}
        unused, raw = existing.fixture()
        invocation = json.loads(raw)
        invocation.update(Status='Failed', ResponseCode=1,
            StandardOutputContent=json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED',
                'code': 'API_ADMIN_WORKSPACE_BACKUP_RECEIPT_REQUIRED', 'errorType': 'RuntimeError',
                'private': 'SYNTHETIC_RAW_STDOUT_SECRET'}),
            StandardErrorContent='SYNTHETIC_RAW_STDERR_SECRET')
        return existing.producer(), environment, invocation

    def test_actual_failed_preflight_preserves_bound_code_and_diagnostic_never_sends(self):
        producer, environment, invocation = self.fixture()
        raw = json.dumps(invocation).encode()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder, patch.dict(os.environ, environment, clear=True), \
                patch.object(transport, 'pending_workspace_parameters', return_value={'commands': []}), \
                patch.object(transport, '_pending_workspace_send', return_value=invocation['CommandId']) as send, \
                patch.object(transport, '_pending_workspace_command_raw', return_value=raw) as get, \
                patch.object(transport, '_pending_workspace_modules', return_value=(None, None, None)), \
                redirect_stdout(io.StringIO()) as stdout:
            output = Path(folder)
            self.assertEqual(transport.pending_workspace_main('preflight', output), 1)
            send.assert_called_once();get.assert_called_once()
            path = output / 'online-recharge-pending-workspace-preflight-failure.json'
            saved = json.loads(path.read_bytes())
            self.assertEqual(saved['producer'], producer)
            self.assertEqual(saved['expectedCurrent'], environment['EXPECTED_CURRENT'])
            self.assertEqual(saved['commandId'], invocation['CommandId'])
            self.assertEqual(saved['failure']['code'], 'API_ADMIN_WORKSPACE_BACKUP_RECEIPT_REQUIRED')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(p.name for p in output.iterdir()), {path.name})
            self.assertNotIn('SYNTHETIC_RAW', path.read_text() + stdout.getvalue())
            self.assertFalse(json.loads(stdout.getvalue())['qualificationGranted'])
            with patch.object(transport, '_pending_workspace_send') as diagnostic_send, \
                    patch.object(transport, '_pending_workspace_command_raw') as diagnostic_get, \
                    patch.object(transport, '_pending_workspace_modules') as modules, \
                    redirect_stdout(io.StringIO()) as diagnostic_stdout:
                before = (path.stat().st_ino, path.read_bytes())
                self.assertEqual(transport.pending_workspace_main('diagnostic', output), 0)
                result = json.loads(diagnostic_stdout.getvalue())
                self.assertEqual(result['code'], saved['failure']['code'])
                self.assertEqual(result['producer'], producer)
                self.assertFalse(result['qualificationGranted'])
                diagnostic_send.assert_not_called();diagnostic_get.assert_not_called();modules.assert_not_called()
                self.assertEqual((path.stat().st_ino, path.read_bytes()), before)

    def test_failed_binding_refuses_foreign_id_instance_document_plugin_end_and_exit_code(self):
        producer, environment, invocation = self.fixture()
        changes = ({'CommandId': '87654321-1234-1234-1234-123456789abc'},
            {'InstanceId': 'i-11111111111111111'}, {'DocumentName': 'OtherDocument'}, {'PluginName': 'other'},
            {'ExecutionEndDateTime': '2999-01-01T00:00:00Z'}, {'ResponseCode': True}, {'ResponseCode': 0})
        with patch.dict(os.environ, environment, clear=True):
            for change in changes:
                with self.subTest(change=tuple(change)), \
                        patch.object(transport, '_pending_workspace_command_raw',
                            return_value=json.dumps({**invocation, **change}).encode()), \
                        self.assertRaisesRegex(RuntimeError, 'TRANSPORT_INVALID'):
                    transport._pending_workspace_wait(invocation['CommandId'], allow_preflight_failure=True)

    def test_timeout_and_raw_errors_only_produce_finite_suppressed_failure(self):
        producer, environment, invocation = self.fixture()
        variants = ({'Status': 'TimedOut', 'ResponseCode': -1, 'StandardOutputContent': ''},
            {'StandardOutputContent': 'SYNTHETIC_ARBITRARY_ERROR_SECRET'},
            {'StandardOutputContent': json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED',
                'code': 'SYNTHETIC_ARBITRARY_ERROR_SECRET', 'errorType': 'SECRET with spaces'})},
            {'StandardOutputContent': json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED',
                'code': 123, 'errorType': ['SYNTHETIC_SECRET']})})
        with patch.dict(os.environ, environment, clear=True):
            for change in variants:
                with self.subTest(change=tuple(change)):
                    value = transport._pending_workspace_failed(json.dumps({**invocation, **change}).encode(),
                        invocation['CommandId'], producer, environment['EXPECTED_CURRENT'])
                    self.assertEqual(value['failure'], {'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED',
                        'code': 'ONLINE_RECHARGE_REMOTE_VERIFICATION_FAILED'})
                    self.assertNotIn('SECRET', json.dumps(value))
            value = transport._pending_workspace_failed(json.dumps({**invocation,
                'StandardOutputContent': json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED',
                    'code': 'API_ADMIN_WORKSPACE_BACKUP_RECEIPT_REQUIRED', 'errorType': ['SYNTHETIC_SECRET']})}).encode(),
                invocation['CommandId'], producer, environment['EXPECTED_CURRENT'])
            self.assertEqual(set(value['failure']), {'status', 'code'})

    def test_non_preflight_failure_cannot_enter_success_or_artifact_path(self):
        unused, environment, invocation = self.fixture()
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(transport, '_pending_workspace_command_raw', return_value=json.dumps(invocation).encode()), \
                self.assertRaisesRegex(RuntimeError, 'TRANSPORT_INVALID'):
            transport._pending_workspace_wait(invocation['CommandId'])

    def test_diagnostic_absence_is_not_measured_without_native_or_source_import(self):
        producer, environment, unused = self.fixture()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder, patch.dict(os.environ, environment, clear=True), \
                patch.object(transport, '_pending_workspace_send') as send, \
                patch.object(transport, '_pending_workspace_command_raw') as get, \
                patch.object(transport, '_pending_workspace_modules') as modules, redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(transport.pending_workspace_main('diagnostic', Path(folder)), 0)
            value = json.loads(stdout.getvalue())
            self.assertEqual(value['status'], 'ONLINE_RECHARGE_DIAGNOSTIC_NOT_MEASURED')
            self.assertEqual(value['producer'], producer)
            self.assertFalse(value['qualificationGranted'])
            send.assert_not_called();get.assert_not_called();modules.assert_not_called()
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_diagnostic_rejects_foreign_producer_expected_instance_unknown_keys_and_unsafe_code(self):
        producer, environment, invocation = self.fixture()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder, patch.dict(os.environ, environment, clear=True):
            output = Path(folder)
            value = transport._pending_workspace_failed(json.dumps(invocation).encode(),
                invocation['CommandId'], producer, environment['EXPECTED_CURRENT'])
            path = output / 'online-recharge-pending-workspace-preflight-failure.json'
            changes = ({'producer': {**producer, 'workflowRunId': '125'}},
                {'producer': {**producer, 'sourceTree': 'd' * 40}}, {'expectedCurrent': 'e' * 40},
                {'instanceId': 'i-11111111111111111'}, {'unknown': 'SYNTHETIC_SECRET'}, {'version': True},
                {'failure': {**value['failure'], 'code': 'SYNTHETIC_SECRET'}},
                {'failure': {**value['failure'], 'errorType': 'SECRET with spaces'}})
            for change in changes:
                path.write_bytes(json.dumps({**value, **change}).encode());path.chmod(0o600)
                with self.subTest(change=tuple(change)), self.assertRaisesRegex(RuntimeError, 'FAILURE_CHANGED'):
                    transport._pending_workspace_failure_diagnostic(output, producer, environment['EXPECTED_CURRENT'])
            path.write_bytes(json.dumps(value).encode());path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'FAILURE_CHANGED'):
                transport._pending_workspace_failure_diagnostic(output, producer, environment['EXPECTED_CURRENT'])
            path.unlink();path.symlink_to(output / 'missing')
            with self.assertRaisesRegex(RuntimeError, 'FAILURE_CHANGED'):
                transport._pending_workspace_failure_diagnostic(output, producer, environment['EXPECTED_CURRENT'])


if __name__ == '__main__':
    unittest.main()
