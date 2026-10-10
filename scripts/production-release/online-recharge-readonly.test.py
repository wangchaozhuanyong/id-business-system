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


if __name__ == '__main__':
    unittest.main()
