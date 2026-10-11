import contextlib
import copy
import ast
import base64
import hashlib
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('service_retention', DIRECTORY / 'service-image-retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)
COMMIT = 'a' * 40
RUN = 'github-actions-123-1'
SHA = 'b' * 64
POLICY = retention.POLICY
TAG = COMMIT + '-123-1-api'
PLAN = {'policy':POLICY,'expectedCurrent':COMMIT,'expectedPrevious':'c' * 40,
    'repository':'079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
    'protectedImageIds':['sha256:'+'e'*64],
    'items':[{'tag':TAG,'imageId':'sha256:'+'d'*64}],
    'dependencies':{'version':1,'imageIds':['sha256:'+'e'*64],'serviceRollback':{},'evidenceSha256':{}}}


def planned():
    return {'status':'PLAN_READY','phase':'PLAN','policy':POLICY,'currentCommit':COMMIT,
        'deploymentRun':RUN,'manifestSha256':SHA,'planSha256':retention.plan_digest(PLAN),
        'plan':copy.deepcopy(PLAN),'commandId':'1' * 36}


def applied():
    return {'status':'COMPLETE','phase':'APPLY','policy':POLICY,'currentCommit':COMMIT,
        'deploymentRun':RUN,'manifestSha256':SHA,'planSha256':retention.plan_digest(PLAN),
        'candidateCount':1,'removed':[TAG],'freeBytesBefore':1,'freeBytesAfter':2,
        'commandId':'2' * 36}


class FlowTests(unittest.TestCase):
    def test_correct_flow_requires_plan_then_exact_apply(self):
        client = Mock(); client.execute.side_effect = [planned(),applied()]
        result = retention.maintain('release',COMMIT,RUN,client,source='pass')
        self.assertEqual(result['status'],'COMPLETE')
        self.assertEqual(result['planCommandId'],'1' * 36)
        self.assertEqual(client.execute.call_count,2)

    def test_nonrelease_operations_never_dispatch(self):
        for operation in ('verify_access','verify_unused_cache','cleanup_unused_cache','verify_recharge_release'):
            client = Mock()
            self.assertEqual(retention.maintain(operation,None,None,client)['status'],'SKIPPED_NO_RELEASE')
            client.execute.assert_not_called()

    def test_invalid_inputs_never_dispatch(self):
        for commit, run in [('wrong',RUN),(COMMIT,'github-actions-0-1'),(COMMIT,None)]:
            client = Mock()
            with self.assertRaises(retention.RetentionFailure):
                retention.maintain('release',commit,run,client,source='pass')
            client.execute.assert_not_called()

    def test_wrong_commit_run_or_plan_hash_never_apply(self):
        for key, value in [('currentCommit','e'*40),('deploymentRun','github-actions-999-1'),
                ('planSha256','f'*64),('status','FAILED_CLOSED'),('policy','old-policy')]:
            result = planned(); result[key] = value; client = Mock(); client.execute.return_value = result
            with self.assertRaises(retention.RetentionFailure):
                retention.maintain('release',COMMIT,RUN,client,source='pass')
            self.assertEqual(client.execute.call_count,1)

    def test_failed_or_changed_apply_is_not_success(self):
        for key, value in [('status','FAILED_CLOSED'),('manifestSha256','0'*64),
                ('planSha256','0'*64),('removed',[]),('deploymentRun','github-actions-999-1')]:
            result = applied(); result[key] = value; client = Mock(); client.execute.side_effect = [planned(),result]
            with self.assertRaises(retention.RetentionFailure):
                retention.maintain('release',COMMIT,RUN,client,source='pass')

    def test_write_only_safe_result_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'result.json'; retention.save(path,applied())
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError): retention.save(path,applied())

    def test_actual_maintainer_policy_is_reused(self):
        self.assertIn("POLICY = '" + POLICY + "'",retention.maintainer_source())


class RemoteGuardTests(unittest.TestCase):
    def remote(self, directory, manifest, mode='PLAN', child=None, expected_sha=None, source_sha=None):
        base = Path(directory).resolve(); release = base / 'releases' / ('20261007T000000Z-'+COMMIT[:12]); release.mkdir(parents=True)
        if manifest is not None:
            (release / 'release-manifest.json').write_text(json.dumps(manifest))
        (base / 'current').symlink_to(release)
        maintainer = retention.maintainer_source()
        namespace = {'MODE':mode,'EXPECTED':COMMIT,'DEPLOYMENT':RUN,'POLICY':POLICY,
            'MAINTAIN_SOURCE':maintainer,'MAINTAIN_SOURCE_SHA256':source_sha or hashlib.sha256(maintainer.encode()).hexdigest(),
            'PLAN_SHA':retention.plan_digest(PLAN),'EXPECTED_MANIFEST_SHA':expected_sha}
        source = retention.WIRE + retention.REMOTE.replace("BASE = Path('/opt/id-business-v2')",'BASE = Path('+repr(str(base))+')')
        output = io.StringIO()
        with patch('subprocess.run',return_value=child) as run, contextlib.redirect_stdout(output):
            try: exec(compile(source,'<local-guard>','exec'),namespace)
            except SystemExit as error: self.assertEqual(error.code,1)
        result = retention.retention_readback(output.getvalue())
        return result, run

    def test_wrong_commit_and_run_reject_before_maintainer(self):
        for manifest in ({'commit':'e'*40,'deploymentRun':RUN},{'commit':COMMIT,'deploymentRun':'github-actions-2-1'}):
            with tempfile.TemporaryDirectory() as directory:
                result, run = self.remote(directory,manifest)
                self.assertEqual(result['status'],'FAILED_CLOSED'); run.assert_not_called()

    def test_no_actual_deployment_rejects_before_maintainer(self):
        with tempfile.TemporaryDirectory() as directory:
            result, run = self.remote(directory,None)
            self.assertEqual(result['status'],'FAILED_CLOSED'); run.assert_not_called()

    def test_apply_rejects_changed_manifest_before_maintainer(self):
        with tempfile.TemporaryDirectory() as directory:
            result, run = self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},'APPLY',expected_sha='0'*64)
            self.assertEqual(result['status'],'FAILED_CLOSED'); run.assert_not_called()

    def test_real_wrapper_plan_and_apply_cli_and_output(self):
        manifest = {'commit':COMMIT,'deploymentRun':RUN,'fixedRechargeRelease':{'cacheStatus':'SKIPPED'}}
        manifest_sha = hashlib.sha256(json.dumps(manifest).encode()).hexdigest()
        for mode in ('PLAN','APPLY'):
            value = {'mode':'PLAN_ONLY' if mode=='PLAN' else 'APPLIED','policy':POLICY,'currentCommit':COMMIT,
                'planSha256':retention.plan_digest(PLAN),'candidateCount':1,
                'removed':[] if mode=='PLAN' else [TAG],'freeBytesBefore':1,'freeBytesAfter':2}
            if mode=='PLAN': value['plan']=PLAN
            child = SimpleNamespace(returncode=0,stdout=json.dumps(value),stderr='')
            with tempfile.TemporaryDirectory() as directory:
                result, run = self.remote(directory,manifest,mode,child,manifest_sha)
                arguments = run.call_args.args[0]
                self.assertNotIn('--deployment-run',arguments)
                self.assertEqual(result['status'],'PLAN_READY' if mode=='PLAN' else 'COMPLETE')
                if mode=='APPLY':
                    self.assertIn('--approved-plan-sha256',arguments)
                    self.assertIn(retention.plan_digest(PLAN),arguments)
                else: self.assertNotIn('--apply',arguments)
                self.assertEqual(arguments[:3],['python3','-B','-c'])
                self.assertEqual(arguments[3],retention.maintainer_source())
                self.assertEqual(run.call_args.kwargs['timeout'],1200)
                run.assert_called_once()

    def test_maintainer_failure_suppresses_raw_details_and_rejects(self):
        child = SimpleNamespace(returncode=1,stdout='private output',stderr='private error')
        with tempfile.TemporaryDirectory() as directory:
            result, run = self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},child=child)
            self.assertEqual(result['status'],'FAILED_CLOSED'); self.assertNotIn('private',json.dumps(result))
            run.assert_called_once()

    def test_source_hash_drift_rejects_before_child(self):
        with tempfile.TemporaryDirectory() as directory:
            result, run = self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},source_sha='0'*64)
            self.assertEqual(result['status'],'FAILED_CLOSED'); run.assert_not_called()

    def test_actual_child_large_envelope_preserves_complete_plan_without_running_maintainer_main(self):
        spec = importlib.util.spec_from_file_location('actual_cache_wire',DIRECTORY/'maintain-image-cache.py')
        cache = importlib.util.module_from_spec(spec); spec.loader.exec_module(cache)
        plan = copy.deepcopy(PLAN)
        plan['dependencies']['evidenceSha256'] = {f'releases/observed-{i}/release-manifest.json':hashlib.sha256(str(i).encode()).hexdigest()
            for i in range(280)}
        value = {'mode':'PLAN_ONLY','policy':POLICY,'currentCommit':COMMIT,'planSha256':cache.plan_digest(plan),
            'candidateCount':len(plan['items']),'removed':[],'freeBytesBefore':1,'freeBytesAfter':2,'plan':plan}
        self.assertGreater(len(json.dumps(value).encode()),18000)
        child = SimpleNamespace(returncode=0,stdout=cache.generic_cache_result_output(value),stderr='')
        self.assertEqual(json.loads(child.stdout)['kind'],'UNUSED_IMAGE_CACHE_COMPLETE_RESULT_V1')
        with tempfile.TemporaryDirectory() as directory, \
                patch('builtins.open',side_effect=AssertionError('Protocol load must not open files')), \
                patch.object(cache,'main',side_effect=AssertionError('Protocol load must not run main')):
            result, run = self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},child=child)
        self.assertEqual(result['status'],'PLAN_READY')
        self.assertEqual(result['plan'],plan)
        self.assertEqual(result['planSha256'],cache.plan_digest(plan))
        run.assert_called_once()
        line = retention.retention_output(result)
        self.assertLessEqual(len(line.encode()),23500)
        self.assertEqual(json.loads(line.removeprefix('SAFE_RETENTION_RESULT '))['kind'],
            'SERVICE_IMAGE_RETENTION_COMPLETE_RESULT_V1')
        self.assertEqual(retention.retention_readback(line),result)

    def test_actual_heredoc_loader_executes_all_chunks_and_frozen_child_decoder_once(self):
        plan=copy.deepcopy(PLAN)
        plan['dependencies']['evidenceSha256']={f'releases/observed-{i}/release-manifest.json':hashlib.sha256(str(i).encode()).hexdigest()
            for i in range(280)}
        protocol={'__name__':'test_cache_wire'}
        exec(compile(retention.maintainer_source(),'<actual-cache-wire>','exec'),protocol)
        for mode in ('PLAN','APPLY'):
            with tempfile.TemporaryDirectory() as directory:
                base=Path(directory).resolve();release=base/'releases'/('20261007T000000Z-'+COMMIT[:12]);release.mkdir(parents=True)
                raw=json.dumps({'commit':COMMIT,'deploymentRun':RUN}).encode()
                (release/'release-manifest.json').write_bytes(raw);(base/'current').symlink_to(release)
                value={'mode':'PLAN_ONLY' if mode=='PLAN' else 'APPLIED','policy':POLICY,'currentCommit':COMMIT,
                    'planSha256':retention.plan_digest(plan),'candidateCount':1,'removed':[] if mode=='PLAN' else [TAG],
                    'freeBytesBefore':1,'freeBytesAfter':2,'plan':plan}
                child=SimpleNamespace(returncode=0,stdout=protocol['generic_cache_result_output'](value),stderr='')
                remote=retention.REMOTE.replace("BASE = Path('/opt/id-business-v2')",'BASE = Path('+repr(str(base))+')')
                with patch.object(retention,'REMOTE',remote):
                    commands=retention.remote_command(mode,COMMIT,RUN,retention.maintainer_source(),
                        retention.plan_digest(plan),hashlib.sha256(raw).hexdigest())
                output=io.StringIO()
                with patch.object(retention.subprocess,'run',return_value=child) as run,contextlib.redirect_stdout(output):
                    exec(compile('\n'.join(commands[1:-1]),'<actual-joined-SSM-heredoc>','exec'),{})
                result=retention.retention_readback(output.getvalue())
                self.assertEqual(result['status'],'PLAN_READY' if mode=='PLAN' else 'COMPLETE')
                self.assertEqual(result['planSha256'],retention.plan_digest(plan))
                if mode=='PLAN':self.assertEqual(result['plan'],plan)
                else:self.assertEqual(result['removed'],[TAG])
                run.assert_called_once()
                self.assertEqual(run.call_args.kwargs['timeout'],1200)
                self.assertEqual(run.call_args.args[0][3],retention.maintainer_source())

    def test_incompressible_full_plan_fails_closed_and_never_applies(self):
        import random
        rng=random.Random(20261012)
        plan=copy.deepcopy(PLAN)
        plan['dependencies']['evidenceSha256']={f'releases/observed-{i}/release-manifest.json':''.join(rng.choice('0123456789abcdef') for unused in range(64))
            for i in range(1800)}
        value=planned();value['plan']=plan;value['planSha256']=retention.plan_digest(plan)
        with self.assertRaises(retention.RetentionFailure):retention.retention_output(value)
        protocol={'__name__':'test_cache_wire'};exec(compile(retention.maintainer_source(),'<actual-cache-wire>','exec'),protocol)
        child_value={'mode':'PLAN_ONLY','policy':POLICY,'currentCommit':COMMIT,'planSha256':retention.plan_digest(plan),
            'candidateCount':1,'removed':[],'freeBytesBefore':1,'freeBytesAfter':2,'plan':plan}
        with self.assertRaisesRegex(RuntimeError,'safe transport bound'):
            protocol['generic_cache_result_output'](child_value)
        child=SimpleNamespace(returncode=1,stdout=json.dumps({'status':'CACHE_RETENTION_FAILED','errorType':'RuntimeError',
            'reason':'Complete cache result exceeds safe transport bound'}),stderr='')
        with tempfile.TemporaryDirectory() as directory:
            result,run=self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},child=child)
        self.assertEqual(result['status'],'FAILED_CLOSED');run.assert_called_once()
        client=Mock();client.execute.return_value=result
        with self.assertRaises(retention.RetentionFailure):retention.maintain('release',COMMIT,RUN,client)
        client.execute.assert_called_once()


class SsmTests(unittest.TestCase):
    def client(self):
        return retention.SsmClient('ap-northeast-1','i-'+'1'*17,sleep=Mock())

    def dispatch(self, command_id='1'*36):
        return {'Command':{'CommandId':command_id,'InstanceIds':['i-'+'1'*17],
            'DocumentName':'AWS-RunShellScript'}}

    def success(self, command_id='1'*36):
        return {'Status':'Success','ResponseCode':0,'CommandId':command_id,'InstanceId':'i-'+'1'*17,
            'DocumentName':'AWS-RunShellScript','PluginName':'aws:runShellScript',
            'StandardOutputContent':'SAFE_RETENTION_RESULT '+json.dumps(planned())}

    def test_pending_then_safe_success(self):
        client=self.client(); command_id='1'*36
        client.call=Mock(side_effect=[self.dispatch(command_id), {'Status':'InProgress'},self.success(command_id)])
        result=client.execute('reviewed-command')
        self.assertEqual(result['status'],'PLAN_READY'); client.sleep.assert_called_once_with(10)
        self.assertEqual(client.command_ids,[command_id])

    def test_ssm_failure_and_missing_result_are_rejected(self):
        for response in ({'Status':'Failed','StandardErrorContent':'secret'},
                {'Status':'Success','StandardOutputContent':'not a safe receipt'}):
            client=self.client(); client.call=Mock(side_effect=[self.dispatch(),response])
            with self.assertRaises(retention.RetentionFailure): client.execute('reviewed-command')

    def test_ssm_timeout_is_failure(self):
        client=self.client(); client.monotonic=Mock(side_effect=[0,1501])
        client.call=Mock(return_value=self.dispatch())
        with self.assertRaises(retention.RetentionFailure): client.execute('reviewed-command')

    def test_aws_uses_ci_identity_and_suppresses_failed_output(self):
        client=self.client()
        with patch.object(retention.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='private',stderr='private')) as run:
            with self.assertRaises(retention.RetentionFailure): client.call(['ssm','send-command'])
            self.assertNotIn('--profile',run.call_args.args[0])

    def test_success_requires_strict_integer_zero_response(self):
        for code in (False,True,'0',None,-1,1):
            client=self.client(); response=self.success(); response['ResponseCode']=code
            client.call=Mock(side_effect=[self.dispatch(),response])
            with self.assertRaises(retention.RetentionFailure): client.execute('reviewed-command')

    def test_success_requires_exact_invocation_identity(self):
        for key, value in [('CommandId','2'*36),('InstanceId','i-'+'2'*17),
                ('DocumentName','OtherDocument'),('PluginName','otherPlugin')]:
            client=self.client(); response=self.success(); response[key]=value
            client.call=Mock(side_effect=[self.dispatch(),response])
            with self.assertRaises(retention.RetentionFailure): client.execute('reviewed-command')

    def test_dispatch_requires_expected_instance_and_document(self):
        for key, value in [('InstanceIds',['i-'+'2'*17]),('InstanceIds',[]),('DocumentName','OtherDocument')]:
            client=self.client(); response=self.dispatch(); response['Command'][key]=value
            client.call=Mock(return_value=response)
            with self.assertRaises(retention.RetentionFailure): client.execute('reviewed-command')
            client.call.assert_called_once()

    def test_oversized_command_rejects_before_ssm_dispatch(self):
        client=self.client(); client.call=Mock()
        with self.assertRaises(retention.RetentionFailure): client.execute('x'*(32*1024+1))
        client.call.assert_not_called()

    def test_real_plan_and_apply_command_sizes_fit_ssm_bound(self):
        source=retention.maintainer_source()
        for mode in ('PLAN','APPLY'):
            commands=retention.remote_command(mode,COMMIT,RUN,source,retention.plan_digest(PLAN),SHA)
            self.assertIsInstance(commands,list)
            self.assertTrue(all(len(command.encode())<=32*1024 for command in commands))
            self.assertLessEqual(len(json.dumps({'commands':commands,'executionTimeout':['1500']}).encode()),60*1024)
            namespace = {}
            program = '\n'.join(commands[1:-1]).rsplit('exec(compile(source',1)[0]
            exec(compile(program,'<actual-transport-decode>','exec'),namespace)
            decoded = ast.parse(namespace['source'])
            values = {node.targets[0].id:ast.literal_eval(node.value) for node in decoded.body[:8]}
            self.assertEqual(values['MAINTAIN_SOURCE'],source)
            self.assertEqual(values['MAINTAIN_SOURCE_SHA256'],hashlib.sha256(source.encode()).hexdigest())
            self.assertEqual(values['MODE'],mode)
            self.assertEqual(values['PLAN_SHA'],retention.plan_digest(PLAN))
            self.assertEqual(values['EXPECTED_MANIFEST_SHA'],SHA)
            client=self.client(); client.call=Mock(side_effect=[self.dispatch(),self.success()])
            self.assertEqual(client.execute(commands)['status'],'PLAN_READY')
            request=json.loads(client.call.call_args_list[0].args[0][3])
            self.assertEqual(request['Parameters']['commands'],commands)
            self.assertEqual(client.call.call_args_list[0].args[0][:2],['ssm','send-command'])
            self.assertEqual(len(client.command_ids),1)
            self.assertEqual(client.call.call_count,2)

    def test_command_list_and_total_parameters_bounds_reject_before_dispatch(self):
        for commands in ([],['x'*(32*1024+1)],['x'*31000]*3,['pass']*17,[False]):
            client=self.client();client.call=Mock()
            with self.assertRaises(retention.RetentionFailure):client.execute(commands)
            client.call.assert_not_called()

    def test_transport_hash_length_truncation_and_tail_reject_before_producer(self):
        commands=retention.remote_command('PLAN',COMMIT,RUN,retention.maintainer_source())
        program='\n'.join(commands[1:-1]).rsplit('exec(compile(source',1)[0]
        for change in ('hash','length','truncate','tail'):
            namespace={};exec(compile(program,'<bound-decoder>','exec'),namespace)
            payload=namespace['payload']
            if change=='hash': altered=program.replace(hashlib.sha256(namespace['source']).hexdigest(),'0'*64)
            elif change=='length':altered=program.replace('len(source)!='+str(len(namespace['source'])),'len(source)!='+str(len(namespace['source'])+1))
            else:
                raw=base64.b64decode(payload,validate=True)
                altered_payload=base64.b64encode(raw[:-1] if change=='truncate' else raw+b'tail').decode()
                # Replace the payload assignment as a whole; decoder body stays exact.
                altered='import base64,hashlib,lzma\npayload='+repr(altered_payload)+'\ndecoder='+program.split(')\ndecoder=',1)[1]
            with self.subTest(change=change),self.assertRaises((SystemExit,lzma.LZMAError,ValueError)):
                exec(compile(altered,'<changed-decoder>','exec'),{})


class ReceiptTransportTests(unittest.TestCase):
    def large(self):
        value=planned();value.pop('commandId')
        value['plan']['dependencies']['evidenceSha256']={f'releases/observed-{i}/release-manifest.json':hashlib.sha256(str(i).encode()).hexdigest()
            for i in range(280)}
        value['planSha256']=retention.plan_digest(value['plan'])
        return value

    def test_full_large_plan_and_original_plain_formats_roundtrip(self):
        for value in (planned(),self.large(),applied()):
            line=retention.retention_output(value)
            self.assertLessEqual(len(line.encode()),23500)
            self.assertEqual(retention.retention_readback(line),value)

    def test_wrong_hash_length_bool_truncated_tail_unknown_and_duplicate_reject(self):
        line=retention.retention_output(self.large())
        envelope=json.loads(line.removeprefix('SAFE_RETENTION_RESULT '))
        for change in ('hash','length','bool','truncated','tail','unknown','duplicate','extra-line'):
            value=copy.deepcopy(envelope)
            if change=='hash':value['uncompressedSha256']='0'*64
            elif change=='length':value['uncompressedBytes']+=1
            elif change=='bool':value['uncompressedBytes']=True
            elif change in ('truncated','tail'):
                raw=base64.b64decode(value['payload'],validate=True)
                value['payload']=base64.b64encode(raw[:-1] if change=='truncated' else raw+b'tail').decode()
            elif change=='unknown':value['extra']=True
            raw=json.dumps(value)
            if change=='duplicate':raw=raw[:-1]+',"version":1}'
            altered='SAFE_RETENTION_RESULT '+raw+('\nextra' if change=='extra-line' else '')
            with self.subTest(change=change),self.assertRaises((retention.RetentionFailure,lzma.LZMAError,ValueError)):
                retention.retention_readback(altered)

    def test_size_limits_refuse_unbounded_complete_plan_or_stdout(self):
        with self.assertRaises(retention.RetentionFailure):retention.retention_output({'large':'x'*(512*1024)})
        with self.assertRaises(retention.RetentionFailure):retention.retention_readback('x'*24001)

    def test_unknown_plain_kind_and_nonfinite_or_duplicate_plain_are_rejected(self):
        for raw in ('{"kind":"OTHER_COMPLETE_RESULT","status":"PLAN_READY"}',
                '{"status":"PLAN_READY","value":NaN}',
                '{"status":"PLAN_READY","status":"COMPLETE"}'):
            with self.subTest(raw=raw),self.assertRaises(retention.RetentionFailure):
                retention.retention_readback('SAFE_RETENTION_RESULT '+raw)


if __name__ == '__main__':
    unittest.main()
