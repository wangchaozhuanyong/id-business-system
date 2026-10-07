import contextlib
import copy
import hashlib
import importlib.util
import io
import json
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
PLAN = {'policy':POLICY,'expectedCurrent':COMMIT,'expectedPrevious':'c' * 40,
    'repository':'reviewed-repository','protectedImageIds':['protected'],
    'items':[{'tag':'exact-reviewed-tag','imageId':'sha256:'+'d'*64}],
    'dependencies':{'version':1,'imageIds':['protected'],'serviceRollback':{},'evidenceSha256':{}}}


def planned():
    return {'status':'PLAN_READY','phase':'PLAN','policy':POLICY,'currentCommit':COMMIT,
        'deploymentRun':RUN,'manifestSha256':SHA,'planSha256':retention.plan_digest(PLAN),
        'plan':copy.deepcopy(PLAN),'commandId':'1' * 36}


def applied():
    return {'status':'COMPLETE','phase':'APPLY','policy':POLICY,'currentCommit':COMMIT,
        'deploymentRun':RUN,'manifestSha256':SHA,'planSha256':retention.plan_digest(PLAN),
        'candidateCount':1,'removed':['exact-reviewed-tag'],'freeBytesBefore':1,'freeBytesAfter':2,
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
    def remote(self, directory, manifest, mode='PLAN', child=None, expected_sha=None):
        base = Path(directory).resolve(); release = base / 'releases' / ('20261007T000000Z-'+COMMIT[:12]); release.mkdir(parents=True)
        if manifest is not None:
            (release / 'release-manifest.json').write_text(json.dumps(manifest))
        (base / 'current').symlink_to(release)
        namespace = {'MODE':mode,'EXPECTED':COMMIT,'DEPLOYMENT':RUN,'POLICY':POLICY,
            'MAINTAIN_SOURCE':'pass','PLAN_SHA':retention.plan_digest(PLAN),'EXPECTED_MANIFEST_SHA':expected_sha}
        source = retention.REMOTE.replace("BASE = Path('/opt/id-business-v2')",'BASE = Path('+repr(str(base))+')')
        output = io.StringIO()
        with patch('subprocess.run',return_value=child) as run, contextlib.redirect_stdout(output):
            try: exec(compile(source,'<local-guard>','exec'),namespace)
            except SystemExit as error: self.assertEqual(error.code,1)
        result = json.loads(output.getvalue().removeprefix('SAFE_RETENTION_RESULT ').strip())
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
                'removed':[] if mode=='PLAN' else ['exact-reviewed-tag'],'freeBytesBefore':1,'freeBytesAfter':2}
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

    def test_maintainer_failure_suppresses_raw_details_and_rejects(self):
        child = SimpleNamespace(returncode=1,stdout='private output',stderr='private error')
        with tempfile.TemporaryDirectory() as directory:
            result, run = self.remote(directory,{'commit':COMMIT,'deploymentRun':RUN},child=child)
            self.assertEqual(result['status'],'FAILED_CLOSED'); self.assertNotIn('private',json.dumps(result))
            run.assert_called_once()


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
            command=retention.remote_command(mode,COMMIT,RUN,source,retention.plan_digest(PLAN),SHA)
            self.assertLessEqual(len(command.encode()),32*1024)


if __name__ == '__main__':
    unittest.main()
