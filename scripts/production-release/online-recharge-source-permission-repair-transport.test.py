import ast
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib
from contextlib import redirect_stdout

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[1]
spec = importlib.util.spec_from_file_location('repair_transport_test', SOURCE / 'online-recharge-source-permission-repair-transport.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
PRODUCER = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '12345', 'workflowRunAttempt': '1'}
COMMAND = '11111111-2222-3333-4444-555555555555'


def environment():
    return {'PATH': '/usr/bin:/bin', 'RELEASE_OPERATION': t.OPERATION, 'EXPECTED_CURRENT': t.BASELINE,
            'HISTORICAL_EXCEPTION': 'none', 'RELEASE_COMMIT': PRODUCER['commit'],
            'SOURCE_TREE': PRODUCER['sourceTree'], 'GITHUB_RUN_ID': PRODUCER['workflowRunId'],
            'GITHUB_RUN_ATTEMPT': PRODUCER['workflowRunAttempt'], 'GITHUB_REF': 'refs/heads/main',
            'AWS_REGION': 'fixture-region', 'PRODUCTION_INSTANCE_ID': 'fixture-instance'}


def core_receipt(status='CHANGED'):
    return {'kind': 'ONLINE_SOURCE_PERMISSION_REPAIR_V1', 'status': status, 'code': 'OK',
            'composeSha256': t.COMPOSE_SHA, 'servicesBeforeSha256': 'c' * 64,
            'servicesAfterSha256': 'c' * 64, 'currentUnchanged': True, 'servicesUnchanged': True,
            'sourceVerified': True, 'repairVerified': True, 'mutationAttempted': status == 'CHANGED',
            'rollbackVerified': False, 'rawOutputSuppressed': True}


def remote_receipt(binding, status='CHANGED'):
    return {'kind': 'ONLINE_SOURCE_PERMISSION_REPAIR_EXECUTION_V1', 'operation': t.OPERATION,
            'producer': binding['producer'], 'origin': copy.deepcopy(t.ORIGIN),
            'coreSha256': binding['coreSha256'], 'helperPinsSha256': binding['helperPinsSha256'],
            'clientCleanupVerified': True, 'receipt': core_receipt(status),
            'snapshotDiagnostic': {'status':'PASSED','stage':'COMPLETE','code':'NONE',
                                   'currentAnchorCount':7,'retainedServiceCount':0,'rawOutputSuppressed':True}}


def invocation(value):
    return {'CommandId': COMMAND, 'InstanceId': 'fixture-instance', 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'ExecutionEndDateTime': '2026-10-10T00:00:00Z', 'StandardErrorContent': '',
            'StandardOutputContent': t.PREFIX + json.dumps(value)}


def workflow_condition(expression, inputs, failed):
    """Evaluate the repository's finite explicit workflow predicates, including negative gates."""
    if expression is None:
        return True
    parsed = ast.parse(expression.replace('&&', ' and ').replace('||', ' or '), mode='eval')
    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) in (str, bool):
            return node.value
        if isinstance(node, ast.Attribute):
            name = ast.unparse(node)
            if name.startswith('inputs.') and name.count('.') == 1:
                return inputs[name.split('.')[1]]
            if name == 'steps.api_admin_preflight.outcome':
                return 'failure' if failed else 'success'
        if isinstance(node, ast.BoolOp) and type(node.op) in (ast.And, ast.Or):
            values = [evaluate(value) for value in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq): return left == right
            if isinstance(node.ops[0], ast.NotEq): return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            if node.func.id == 'always' and not node.args: return True
            if node.func.id == 'failure' and not node.args: return failed
            if node.func.id == 'startsWith' and len(node.args) == 2:
                return evaluate(node.args[0]).startswith(evaluate(node.args[1]))
        raise AssertionError('Workflow predicate outside the finite actual expression grammar')
    return evaluate(parsed.body)


class NativeSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = t.BASE / 'releases' / ('20261009T123456Z-' + t.BASELINE[:12])
        self.rows = {}
        for role in t.ROLES:
            cid = hashlib.sha256(role.encode()).hexdigest()
            self.rows[cid] = {'Id': cid, 'Image': hashlib.sha256((role + '-image').encode()).hexdigest(),
                'Config': {'Image': 'fixture/' + role + ':local', 'Env': ['PRIVATE_FIXTURE=never_output'],
                           'Labels': {'com.docker.compose.project': 'custom_project-9',
                                      'com.docker.compose.service': role,
                                      'com.docker.compose.project.working_dir': str(self.directory),
                                      'com.docker.compose.project.config_files': ','.join(str(self.directory / name)
                                          for name in ('docker-compose.aws-mysql.yml', 'compose.release.json'))}},
                'State': {'Status': 'running', 'StartedAt': '2026-10-09T00:00:00Z',
                          **({'Health': {'Status': 'healthy'}} if role != 'caddy' else {})},
                'HostConfig': {'fixture': 'original'}, 'Mounts': [{'Destination': '/fixture', 'Type': 'volume'}]}
        self.online = t.literal_module((SOURCE / 'online-recharge-scope.py').read_bytes(), 'fixture_online', SOURCE / 'online-recharge-scope.py')
        self.workspace = t.literal_module((SOURCE / 'api-admin-scope.py').read_bytes(), 'fixture_workspace', SOURCE / 'api-admin-scope.py')
        self.remote = t.literal_module((SOURCE / 'remote-deploy.py').read_bytes(), 'fixture_remote', SOURCE / 'remote-deploy.py')
        self.original_service_state = self.remote.service_state
        self.driver = t.NativeSnapshotDriver(self.directory, Path('/fixture/private-client'), self.online, self.workspace, self.remote)
        self.calls = []

    def native(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('container', 'ls'):
            self.assertNotIn('--all', args)
            predicate = args[-1]
            selected = []
            for cid, row in self.rows.items():
                if row['State']['Status'] != 'running':
                    continue
                labels = row['Config']['Labels']
                if predicate.startswith('label=com.docker.compose.project.working_dir='):
                    valid = labels.get('com.docker.compose.project.working_dir') == str(self.directory)
                else:
                    valid = labels.get('com.docker.compose.project') == predicate.split('=', 2)[-1]
                if valid:
                    selected.append(cid)
            return '\n'.join(selected)
        self.assertEqual(args[0], 'inspect')
        if args[1:3] == ('--format',t.PUBLIC_LABEL_FORMAT):
            row=self.rows[args[-1]];labels=row['Config']['Labels']
            return json.dumps({'id':row['Id'],'project':labels.get('com.docker.compose.project'),
                               'role':labels.get('com.docker.compose.service'),
                               'directory':labels.get('com.docker.compose.project.working_dir'),
                               'files':labels.get('com.docker.compose.project.config_files')})
        return json.dumps([self.rows[args[1]]])

    def snapshot(self):
        with patch.object(self.driver, 'native', side_effect=self.native):
            return self.driver.snapshot(self.directory)

    def test_actual_pinned_helpers_preserve_complete_eight_field_meaning(self):
        output = io.StringIO()
        with redirect_stdout(output):
            digest = self.snapshot()
        self.assertEqual(output.getvalue(), '')
        self.assertIs(self.remote.service_state, self.original_service_state)
        with patch.object(self.driver, 'native', side_effect=self.native):
            full = self.online.snapshot(self.driver, self.directory)
        self.assertEqual(set(full), set(t.ROLES))
        self.assertTrue(all(set(row) == t.SERVICE_FIELDS for row in full.values()))
        self.assertEqual(digest, hashlib.sha256(t.canonical(full)).hexdigest())
        self.assertNotIn('never_output', json.dumps(full))
        self.assertEqual(self.driver.project, 'custom_project-9')
        self.assertFalse(any('compose' in call or '--env-file' in call for call in self.calls))

    def test_environment_and_full_configuration_changes_change_original_snapshot(self):
        before = self.snapshot()
        next(iter(self.rows.values()))['Config']['Env'].append('PRIVATE_CHANGED=memory_only')
        self.assertNotEqual(before, self.snapshot())
        before = self.snapshot()
        next(iter(self.rows.values()))['HostConfig']['fixture'] = 'changed'
        self.assertNotEqual(before, self.snapshot())

    def test_exited_oneoff_is_ignored_and_running_extra_is_rejected(self):
        extra = copy.deepcopy(next(iter(self.rows.values())))
        extra['Id'] = 'e' * 64
        extra['Config']['Labels']['com.docker.compose.service'] = 'migrate'
        extra['State']['Status'] = 'exited'
        self.rows[extra['Id']] = extra
        self.snapshot()
        extra['State']['Status'] = 'running'
        with self.assertRaises(RuntimeError):
            self.snapshot()

    def test_duplicate_running_role_missing_role_and_changed_container_fail(self):
        original = copy.deepcopy(self.rows)
        extra = copy.deepcopy(next(iter(self.rows.values())))
        extra['Id'] = 'e' * 64; self.rows[extra['Id']] = extra
        with self.assertRaises(RuntimeError): self.snapshot()
        self.rows = copy.deepcopy(original); self.rows.pop(next(iter(self.rows)))
        with self.assertRaises(RuntimeError): self.snapshot()
        self.rows = copy.deepcopy(original); self.snapshot()
        old = next(iter(self.rows)); changed = self.rows.pop(old); changed['Id'] = 'e' * 64
        self.rows[changed['Id']] = changed
        with self.assertRaises(RuntimeError): self.snapshot()

    def test_invalid_mixed_or_multiple_project_groups_and_wrong_source_labels_fail(self):
        original = copy.deepcopy(self.rows)
        mutations = (
            lambda row: row['Config']['Labels'].__setitem__('com.docker.compose.project', ''),
            lambda row: row['Config']['Labels'].__setitem__('com.docker.compose.project', 'wrong-UPPER'),
            lambda row: row['Config']['Labels'].__setitem__('com.docker.compose.project', 'another-project'),
            lambda row: row['Config']['Labels'].__setitem__('com.docker.compose.project.working_dir', '/wrong/source'),
            lambda row: row['Config']['Labels'].__setitem__('com.docker.compose.project.config_files', '/wrong/config'),
        )
        for mutation in mutations:
            self.rows = copy.deepcopy(original); mutation(next(iter(self.rows.values())))
            with self.assertRaises(RuntimeError): self.snapshot()
        self.rows = copy.deepcopy(original)
        for cid, row in original.items():
            other = copy.deepcopy(row); other['Id'] = hashlib.sha256((cid + 'other').encode()).hexdigest()
            other['Config']['Labels']['com.docker.compose.project'] = 'other-project'
            self.rows[other['Id']] = other
        with self.assertRaises(RuntimeError): self.snapshot()

    def test_same_project_additional_running_container_with_foreign_labels_fails(self):
        extra = copy.deepcopy(next(iter(self.rows.values())))
        extra['Id'] = 'e' * 64
        extra['Config']['Labels']['com.docker.compose.project.working_dir'] = '/wrong/source'
        self.rows[extra['Id']] = extra
        with self.assertRaises(RuntimeError): self.snapshot()
        self.assertFalse(any(call == ('inspect', extra['Id']) for call in self.calls))
        self.assertIn('label=com.docker.compose.project', self.calls[0])
        self.assertIn('label=com.docker.compose.project.working_dir=' + str(self.directory), self.calls[0])

    def test_native_invocation_cleans_ambient_host_proxy_and_docker_config(self):
        with patch.dict(os.environ, {'DOCKER_HOST': 'tcp://invalid', 'HTTP_PROXY': 'private_fixture',
                                    'DOCKER_CONFIG': '/wrong/client'}), patch.object(t.subprocess, 'run',
                return_value=SimpleNamespace(returncode=0, stdout=b'{}', stderr=b'')) as call:
            self.driver.native('inspect', 'a' * 64)
        args, kwargs = call.call_args
        self.assertEqual(args[0][:5], ['/usr/bin/docker', '--host', 'unix:///run/docker.sock', '--config', '/fixture/private-client'])
        self.assertEqual(kwargs['env'], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        self.assertLessEqual(kwargs['timeout'], 60)
        with self.assertRaises(RuntimeError): self.driver.run('docker', 'exec', 'a' * 64)
        with self.assertRaises(RuntimeError): self.driver.compose(self.directory, 'up', '-d', 'api')

    def retained(self, keep=('api','admin'), previous=None, single=False):
        previous=previous or t.BASE/'releases'/'20261008T020705Z-e7c9862d5859'
        for row in self.rows.values():
            labels=row['Config']['Labels']
            if labels['com.docker.compose.service'] not in keep:
                labels['com.docker.compose.project.working_dir']=str(previous)
                labels['com.docker.compose.project.config_files']=(str(previous/'docker-compose.aws-mysql.yml')
                    if single else ','.join(str(previous/n) for n in ('docker-compose.aws-mysql.yml','compose.release.json')))

    def test_retained_metadata_matches_original_snapshot_without_filesystem_authority(self):
        pristine=copy.deepcopy(self.rows)
        raw=subprocess.run(['git','show','83e95d3f536880475b1e10d26885ffe7ca2b1b98:scripts/production-release/online-recharge-source-permission-repair-transport.py'],
                           cwd=ROOT,capture_output=True,check=True,timeout=10).stdout
        old=t.literal_module(raw,'actual_83e95d_old_driver',SOURCE/'online-recharge-source-permission-repair-transport.py')
        for name,single in (('legacy release',True),('旧版-部署',False),('a'*255,True),('é'*127+'a',False)):
            with self.subTest(single=single,bytes=len(name.encode())):
                self.rows=copy.deepcopy(pristine);self.retained(('api','admin','auto-recharge'),t.BASE/'releases'/name,single)
                old_driver=old.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
                with patch.object(old_driver,'native',side_effect=self.native),self.assertRaises(RuntimeError):old_driver.snapshot(self.directory)
                self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
                labels=copy.deepcopy({cid:row['Config']['Labels'] for cid,row in self.rows.items()})
                output=io.StringIO()
                with patch.object(t.os,'open',side_effect=AssertionError('NO_LABEL_PATH_OPEN')) as opened, \
                     patch.object(t.os,'stat',side_effect=AssertionError('NO_LABEL_PATH_STAT')) as stated, \
                     patch.object(t.os,'readlink',side_effect=AssertionError('NO_LABEL_PATH_LINK')) as linked,redirect_stdout(output):
                    digest=self.snapshot()
                    with patch.object(self.driver,'native',side_effect=self.native):original=self.online.snapshot(self.driver,self.directory)
                opened.assert_not_called();stated.assert_not_called();linked.assert_not_called()
                self.assertEqual(output.getvalue(),'')
                self.assertEqual(digest,t.sha(t.canonical(original)))
                self.assertEqual({cid:row['Config']['Labels'] for cid,row in self.rows.items()},labels)
                self.assertEqual(set(original),set(t.ROLES))
                self.assertTrue(all(set(row)==t.SERVICE_FIELDS for row in original.values()))
                self.assertEqual(self.driver.diagnostic.get(),{'status':'PASSED','stage':'COMPLETE','code':'NONE',
                                 'currentAnchorCount':3,'retainedServiceCount':4,'rawOutputSuppressed':True})
                # An accepted old label remains part of the original complete configuration hash.
                self.retained(('api','admin','auto-recharge'),t.BASE/'releases'/'another-legacy',single)
                self.assertNotEqual(digest,self.snapshot())

    def test_retained_metadata_rejects_unsafe_names_literals_and_file_pairs(self):
        cid=next(iter(self.rows));labels=self.rows[cid]['Config']['Labels']
        valid={'id':cid,'project':labels['com.docker.compose.project'],'role':labels['com.docker.compose.service']}
        cases=[(str(t.BASE/'releases'/name),'LABELS_BASENAME_INVALID')
               for name in ('..','bad\x00name','bad\nname','bad\x7fname','bad\x85name','bad\ud800name','a'*256,'é'*128)]
        cases.extend(((str(t.BASE/'releases')+'//legacy','LABELS_LITERAL_INVALID'),
                      (str(t.BASE/'releases'/'legacy')+'/','LABELS_LITERAL_INVALID'),
                      (str(t.BASE/'releases'/'nested'/'legacy'),'LABELS_PARENT_INVALID'),
                      (str(t.BASE/'releases'/'.'),'LABELS_PARENT_INVALID')))
        for directory,code in cases:
            with self.subTest(code=code):
                self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
                value={**valid,'directory':directory,'files':str(Path(directory)/'docker-compose.aws-mysql.yml')}
                with patch.object(self.driver,'native',return_value=json.dumps(value)),self.assertRaises(RuntimeError):self.driver.public_labels(cid)
                self.assertEqual(self.driver.diagnostic.get()['code'],code)
        previous=t.BASE/'releases'/'legacy'
        for files in (str(previous/'compose.release.json'),str(self.directory/'docker-compose.aws-mysql.yml'),
                      ','.join(str(previous/n) for n in ('compose.release.json','docker-compose.aws-mysql.yml')),
                      str(previous/'docker-compose.aws-mysql.yml')+','):
            self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
            with patch.object(self.driver,'native',return_value=json.dumps({**valid,'directory':str(previous),'files':files})),self.assertRaises(RuntimeError):self.driver.public_labels(cid)
            self.assertEqual(self.driver.diagnostic.get()['code'],'LABELS_FILES_INVALID')

    def test_current_source_still_requires_exact_baseline_and_two_config_files(self):
        with self.assertRaises(RuntimeError):t.NativeSnapshotDriver(t.BASE/'releases'/'legacy',Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        cid=next(iter(self.rows));labels=self.rows[cid]['Config']['Labels']
        value={'id':cid,'project':labels['com.docker.compose.project'],'role':labels['com.docker.compose.service'],
               'directory':str(self.directory),'files':str(self.directory/'docker-compose.aws-mysql.yml')}
        with patch.object(self.driver,'native',return_value=json.dumps(value)),self.assertRaises(RuntimeError):self.driver.public_labels(cid)
        self.assertEqual(self.driver.diagnostic.get()['code'],'LABELS_FILES_INVALID')

    def test_actual_old_driver_rejects_mixed_retained_new_keeps_original_snapshot(self):
        self.retained()
        raw=subprocess.run(['git','show','c6510771b97189f62163f3cdcf606d63284f7136:scripts/production-release/online-recharge-source-permission-repair-transport.py'],
                           cwd=ROOT,capture_output=True,check=True,timeout=10).stdout
        old=t.literal_module(raw,'actual_c651_old_driver',SOURCE/'online-recharge-source-permission-repair-transport.py')
        old_driver=old.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        with patch.object(old_driver,'native',side_effect=self.native),self.assertRaises(RuntimeError):old_driver.snapshot(self.directory)
        self.calls=[]
        self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        value=self.snapshot()
        with patch.object(self.driver,'native',side_effect=self.native):original=self.online.snapshot(self.driver,self.directory)
        self.assertEqual(value,t.sha(t.canonical(original)))
        self.assertEqual(self.driver.diagnostic.get(),{'status':'PASSED','stage':'COMPLETE','code':'NONE',
                         'currentAnchorCount':2,'retainedServiceCount':5,'rawOutputSuppressed':True})
        self.assertIs(self.remote.service_state,self.original_service_state)
        first_full=next(i for i,args in enumerate(self.calls) if args[0]=='inspect' and len(args)==2)
        public_before={args[-1] for args in self.calls[:first_full] if args[:2]==('inspect','--format')}
        self.assertEqual(public_before,set(self.rows))
        self.assertEqual(set(original),set(t.ROLES))
        self.assertTrue(all(set(row)==t.SERVICE_FIELDS for row in original.values()))

    def test_no_current_seed_foreign_source_pair_and_project_or_seed_race_fail_before_full_inspect(self):
        pristine=copy.deepcopy(self.rows)
        for keep, expected in (((),'ANCHOR_MISSING'),(('api',),'PASSED')):
            self.rows=copy.deepcopy(pristine);self.retained(keep)
            self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
            if expected=='PASSED':self.snapshot();self.assertEqual(self.driver.diagnostic.get()['currentAnchorCount'],1)
            else:
                with self.assertRaises(RuntimeError):self.snapshot()
                self.assertEqual(self.driver.diagnostic.get()['code'],expected)
        for field,bad,expected in (('com.docker.compose.project.working_dir','/foreign/release','LABELS_PARENT_INVALID'),
                                   ('com.docker.compose.project.config_files','/foreign/config','LABELS_FILES_INVALID')):
            self.rows=copy.deepcopy(pristine);self.retained()
            row=next(row for row in self.rows.values() if row['Config']['Labels']['com.docker.compose.service']=='mysql')
            row['Config']['Labels'][field]=bad
            self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
            self.calls=[]
            with self.assertRaises(RuntimeError):self.snapshot()
            self.assertEqual(self.driver.diagnostic.get()['code'],expected)
            self.assertFalse(any(args[0]=='inspect' and len(args)==2 for args in self.calls))
        self.rows=copy.deepcopy(pristine);self.retained();self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        self.snapshot()
        for row in self.rows.values():row['Config']['Labels']['com.docker.compose.project']='changed-project'
        with self.assertRaises(RuntimeError):self.snapshot()
        self.assertEqual(self.driver.diagnostic.get()['code'],'SET_CHANGED')
        self.rows=copy.deepcopy(pristine);self.retained()
        self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        def changed_seed(*args,**kwargs):
            if args[:2]==('container','ls') and args[-1].startswith('label=com.docker.compose.project='):
                self.retained(keep=('admin',))
            return self.native(*args,**kwargs)
        with patch.object(self.driver,'native',side_effect=changed_seed),self.assertRaises(RuntimeError):self.driver.snapshot(self.directory)
        self.assertEqual(self.driver.diagnostic.get()['code'],'SEED_CHANGED')

    def test_snapshot_diagnostic_native_ids_original_and_first_failure_are_finite(self):
        cases=[('NATIVE_EXECUTION',SimpleNamespace(returncode=1,stdout=b'',stderr=b'RAW_PRIVATE')),
               ('NATIVE_OUTPUT',SimpleNamespace(returncode=0,stdout=b'\xff',stderr=b''))]
        for code,response in cases:
            driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
            with patch.object(t.subprocess,'run',return_value=response),self.assertRaises(RuntimeError):driver.snapshot(self.directory)
            value=driver.diagnostic.get();self.assertEqual(value['code'],code);self.assertNotIn('RAW_PRIVATE',json.dumps(value))
        driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        with patch.object(driver,'native',return_value='invalid-id'),self.assertRaises(RuntimeError):driver.snapshot(self.directory)
        self.assertEqual(driver.diagnostic.get()['code'],'IDS_INVALID')
        self.driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
        with patch.object(self.online,'snapshot',side_effect=RuntimeError('RAW_PRIVATE')),self.assertRaises(RuntimeError):self.snapshot()
        first=self.driver.diagnostic.get();self.assertEqual(first['stage'],'ORIGINAL_SNAPSHOT');self.assertEqual(first['code'],'ORIGINAL_SNAPSHOT')
        self.driver.diagnostic.mark('CURRENT_IDS')
        with self.assertRaises(RuntimeError):self.driver.diagnostic.fail('IDS_INVALID')
        self.assertEqual(self.driver.diagnostic.get(),first)

    def test_diagnostic_closed_types_unissued_alias_attrs_and_subclasses_cannot_fake_cause(self):
        state=t.snapshot_state();state.mark('CURRENT_IDS')
        with self.assertRaises(RuntimeError) as captured:state.fail('IDS_INVALID')
        issued=captured.exception
        self.assertTrue(state.owns(issued));issued.extra='RAW_PRIVATE';self.assertTrue(state.owns(issued))
        self.assertFalse(state.owns(RuntimeError()))
        self.assertFalse(state.owns(type('Pretend',(RuntimeError,),{})()))
        self.assertNotIn('RAW_PRIVATE',json.dumps(state.get()))
        original=state.get()
        for key,bad in (('stage','unissued'),('code','private'),('currentAnchorCount',True),
                        ('retainedServiceCount',8),('rawOutputSuppressed',False),('private','RAW_PRIVATE')):
            invalid={**original,key:bad}
            with self.assertRaises(RuntimeError):t.snapshot_validate(invalid)
        success=remote_receipt({'producer':PRODUCER,'coreSha256':'d'*64,'helperPinsSha256':'e'*64})
        for invalid in (original,{**success['snapshotDiagnostic'],'currentAnchorCount':0,'retainedServiceCount':7}):
            changed=copy.deepcopy(success);changed['snapshotDiagnostic']=invalid
            with self.assertRaises(RuntimeError):t.validate_remote(changed,{'producer':PRODUCER,'coreSha256':'d'*64,'helperPinsSha256':'e'*64})

    def test_public_label_first_false_table_is_finite_and_stops_later_predicates(self):
        cid=next(iter(self.rows))
        labels=self.rows[cid]['Config']['Labels']
        valid={'id':cid,'project':labels['com.docker.compose.project'],
               'role':labels['com.docker.compose.service'],'directory':str(self.directory),
               'files':labels['com.docker.compose.project.config_files']}
        checks=('LABELS_SHAPE_INVALID','LABELS_ID_INVALID','LABELS_TYPES_INVALID','LABELS_PROJECT_INVALID',
                'LABELS_ROLE_INVALID','LABELS_PARENT_INVALID','LABELS_BASENAME_INVALID',
                'LABELS_LITERAL_INVALID','LABELS_FILES_INVALID')
        cases=(('LABELS_JSON_INVALID','{',True),
               ('LABELS_SHAPE_INVALID',[],False),
               ('LABELS_SHAPE_INVALID',{'id':cid},False),
               ('LABELS_ID_INVALID',{**valid,'id':'wrong','directory':None},False),
               ('LABELS_TYPES_INVALID',{**valid,'directory':None,'role':None},False),
               ('LABELS_PROJECT_INVALID',{**valid,'project':'UPPER','role':'migrate'},False),
               ('LABELS_ROLE_INVALID',{**valid,'role':'migrate','directory':'/foreign/source'},False),
               ('LABELS_PARENT_INVALID',{**valid,'directory':'/foreign/source','files':'RAW_PRIVATE'},False),
               ('LABELS_BASENAME_INVALID',{**valid,'directory':str(t.BASE/'releases'/'invalid\n'),'files':'RAW_PRIVATE'},False),
               ('LABELS_LITERAL_INVALID',{**valid,'directory':str(self.directory)+'/'},False),
               ('LABELS_FILES_INVALID',{**valid,'files':'RAW_PRIVATE'},False))
        output=io.StringIO()
        for expected,value,raw in cases:
            with self.subTest(code=expected):
                state=t.snapshot_state();state.mark('PROJECT_ROLES');state.counts(3)
                driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote,state)
                observed=[];original_require=state.require
                def require(ok,code):
                    observed.append(code)
                    return original_require(ok,code)
                state.require=require
                with patch.object(driver,'native',return_value=value if raw else json.dumps(value)) as call,redirect_stdout(output):
                    with self.assertRaises(RuntimeError) as captured:driver.public_labels(cid)
                self.assertTrue(state.owns(captured.exception));self.assertEqual(captured.exception.args,())
                self.assertEqual(observed,[] if expected=='LABELS_JSON_INVALID' else list(checks[:checks.index(expected)+1]))
                diagnostic=state.get()
                self.assertEqual(diagnostic,{'status':'FAILED','stage':'PROJECT_ROLES','code':expected,
                                             'currentAnchorCount':3,'retainedServiceCount':'NOT_MEASURED','rawOutputSuppressed':True})
                self.assertNotIn('RAW_PRIVATE',json.dumps(diagnostic))
                call.assert_called_once_with('inspect','--format',t.PUBLIC_LABEL_FORMAT,cid)
        self.assertEqual(output.getvalue(),'')
        # A failure in shape/types cannot reach Path construction or the next predicate.
        for value in ([],{**valid,'directory':None}):
            driver=t.NativeSnapshotDriver(self.directory,Path('/fixture/private-client'),self.online,self.workspace,self.remote)
            with patch.object(driver,'native',return_value=json.dumps(value)),patch.object(t,'Path',side_effect=AssertionError('UNREACHABLE')):
                with self.assertRaises(RuntimeError):driver.public_labels(cid)

    def test_public_label_predicates_match_actual_base_and_keep_finite_fallback(self):
        raw=subprocess.run(['git','show','ac45e550375b13310d527c8fb3ec07dbc8186f5a:scripts/production-release/online-recharge-source-permission-repair-transport.py'],
                           cwd=ROOT,capture_output=True,check=True,timeout=10).stdout
        original=ast.parse(raw);current=ast.parse((SOURCE/'online-recharge-source-permission-repair-transport.py').read_bytes())
        def method(tree):
            cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='NativeSnapshotDriver')
            return next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='public_labels')
        def conditions(node):
            def flatten(value):
                if isinstance(value,ast.BoolOp) and isinstance(value.op,ast.And):
                    return [part for item in value.values for part in flatten(item)]
                return [ast.dump(value,include_attributes=False)]
            return [part for statement in node.body if isinstance(statement,ast.Expr)
                    and isinstance(statement.value,ast.Call) and isinstance(statement.value.func,ast.Attribute)
                    and statement.value.func.attr=='require' for part in flatten(statement.value.args[0])]
        old_conditions,new_conditions=conditions(method(original)),conditions(method(current))
        self.assertEqual(len(old_conditions),len(new_conditions))
        self.assertEqual([i for i,(before,after) in enumerate(zip(old_conditions,new_conditions)) if before!=after],[7,9])
        # Every other function, branch, limit, snapshot schema and source-binding AST is unchanged.
        for tree in (original,current):
            tree.body=[n for n in tree.body if not (isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and v.id=='SNAPSHOT_CODES' for v in n.targets))]
            cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='NativeSnapshotDriver')
            cls.body=[n for n in cls.body if not (isinstance(n,ast.FunctionDef) and n.name=='public_labels')]
        self.assertEqual(ast.dump(original,include_attributes=False),ast.dump(current,include_attributes=False))
        old_codes=next(ast.literal_eval(n.value) for n in ast.parse(raw).body if isinstance(n,ast.Assign)
                       and any(isinstance(v,ast.Name) and v.id=='SNAPSHOT_CODES' for v in n.targets))
        new_codes=('LABELS_JSON_INVALID','LABELS_SHAPE_INVALID','LABELS_ID_INVALID','LABELS_TYPES_INVALID',
                   'LABELS_PROJECT_INVALID','LABELS_ROLE_INVALID','LABELS_PARENT_INVALID','LABELS_BASENAME_INVALID',
                   'LABELS_LITERAL_INVALID','LABELS_FILES_INVALID')
        self.assertEqual(len(t.SNAPSHOT_CODES),len(set(t.SNAPSHOT_CODES)))
        self.assertEqual(set(t.SNAPSHOT_CODES)-set(old_codes),set(new_codes))
        self.assertTrue(set(old_codes)<=set(t.SNAPSHOT_CODES))
        for code in ('LABELS_INVALID',*new_codes):
            state=t.snapshot_state();state.mark('PROJECT_ROLES')
            with self.assertRaises(RuntimeError):state.fail(code)
            self.assertEqual(t.snapshot_validate(state.get())['code'],code)
        with self.assertRaises(RuntimeError):t.snapshot_validate({**state.get(),'code':'LABELS_UNISSUED'})


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.binding = {'producer': copy.deepcopy(PRODUCER), 'coreSha256': 'd' * 64, 'helperPinsSha256': 'e' * 64}

    def test_single_bound_core_command_preserves_original_twenty_one_carrier(self):
        producers=({'commit':'ac45e550375b13310d527c8fb3ec07dbc8186f5a','sourceTree':'a7c31dbf86a1b09702236af82acbe1561d0e3526',
                    'workflowRunId':'9999999999999999999','workflowRunAttempt':'9'},
                   {'commit':hashlib.sha1(b'SYNTHETIC_FUTURE_COMMIT_NO_AUTHORITY').hexdigest(),
                    'sourceTree':hashlib.sha1(b'SYNTHETIC_FUTURE_TREE_NO_AUTHORITY').hexdigest(),
                    'workflowRunId':'8473926501937462851','workflowRunAttempt':'4'})
        for producer in producers:self.bound_wire(producer)

    def bound_wire(self,producer):
        data, binding = t.parameters(copy.deepcopy(producer))
        self.assertEqual(len(data['commands']), 4)
        self.assertLess(len(t.canonical(data)), 20480)
        helper = t.readonly_helper()
        expected = helper.formal_runtime_commands(str(t.BASE / '.staging' / ('api-workspace-verify-' + producer['commit'])),
                   producer['commit'], SOURCE / 'formal-runtime-package', SOURCE)
        self.assertEqual(data['commands'][2:3], expected)
        self.assertEqual(binding['coreSha256'], t.sha((SOURCE / t.CORE_NAME).read_bytes()))
        bootstrap = ast.parse(shlex.split(data['commands'][-1])[3])
        encoded = next(ast.literal_eval(n.args[0]) for n in ast.walk(bootstrap)
                       if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'b85decode')
        decoder = zlib.decompressobj(31)
        captured = decoder.decompress(base64.b85decode(encoded), 65537)
        self.assertTrue(decoder.eof); self.assertFalse(decoder.unused_data or decoder.unconsumed_tail)
        self.assertLessEqual(len(captured), 65536)
        self.assertIn(t.ORIGIN['receiptSha256'].encode(), captured)
        self.assertIn(t.ORIGIN['commandId'].encode(), captured)
        captured_ast=ast.parse(captured)
        captured_core=next(ast.literal_eval(n.value) for n in captured_ast.body
                           if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='core_raw' for x in n.targets))
        self.assertEqual(captured_core,(SOURCE / t.CORE_NAME).read_bytes())
        compile(captured,'<actual-captured-wire>','exec')
        supplied_sha=next(ast.literal_eval(n.comparators[0]) for n in ast.walk(bootstrap)
                         if isinstance(n,ast.Compare) and isinstance(n.left,ast.Call)
                         and isinstance(n.left.func,ast.Attribute) and n.left.func.attr=='hexdigest')
        self.assertEqual(supplied_sha,t.sha(captured))
        print(json.dumps({'measurement':'SYNTHETIC_ONLY','producer':producer,'parametersBytes':len(t.canonical(data)),
                          'strictMargin':20479-len(t.canonical(data)),'capturedBytes':len(captured),
                          'capturedSha256':t.sha(captured),'coreSha256':binding['coreSha256'],
                          'firstThreeCommandSha256':t.sha('\n'.join(data['commands'][:3]).encode())}))
        self.assertEqual(data['executionTimeout'], ['300'])

    def test_duplicate_oversized_untrusted_keys_and_success_semantics_are_closed(self):
        for raw in ('', '{"x":1,"x":2}', 'x' * 24000, '{"x":NaN}'):
            with self.assertRaises((RuntimeError, ValueError)): t.closed_json(raw)
        original = remote_receipt(self.binding)
        for field, value in (('operation', 'release_online_recharge'), ('origin', {}), ('coreSha256', 'f' * 64),
                             ('helperPinsSha256', 'f' * 64), ('clientCleanupVerified', False), ('raw', 'private_fixture')):
            bad = copy.deepcopy(original); bad[field] = value
            with self.assertRaises(RuntimeError): t.validate_remote(bad, self.binding)
        for field, value in (('servicesAfterSha256', 'f' * 64), ('repairVerified', False),
                             ('currentUnchanged', False), ('mutationAttempted', False), ('raw', 'private_fixture')):
            bad = copy.deepcopy(original); bad['receipt'][field] = value
            with self.assertRaises(RuntimeError): t.validate_remote(bad, self.binding)
        t.validate_remote(remote_receipt(self.binding, 'NO_CHANGE'), self.binding)

    def test_actual_command_metadata_and_prefix_are_required(self):
        original = invocation(remote_receipt(self.binding))
        for field, value in (('CommandId', 'other'), ('InstanceId', 'other'), ('DocumentName', 'other'),
                             ('PluginName', 'other'), ('ExecutionEndDateTime', ''), ('ResponseCode', True),
                             ('StandardErrorContent', 'private_fixture'), ('StandardOutputContent', '{}')):
            bad = copy.deepcopy(original); bad[field] = value
            with self.assertRaises(RuntimeError): t.terminal(bad, COMMAND, self.binding, 'fixture-instance')
        self.assertEqual(t.terminal(original, COMMAND, self.binding, 'fixture-instance'), remote_receipt(self.binding))

    def test_main_persists_only_validated_safe_receipt_and_drops_raw_failure(self):
        for valid in (True, False):
            saved = []; stdout = io.StringIO()
            record = invocation(remote_receipt(self.binding))
            if not valid: record['StandardOutputContent'] = 'RAW_PRIVATE_FIXTURE'
            with patch.dict(os.environ, environment(), clear=True), patch.object(sys, 'argv', ['repair']), \
                    patch.object(t, 'parameters', return_value=({'commands': [], 'executionTimeout': ['300']}, self.binding)), \
                    patch.object(t, 'aws', side_effect=[COMMAND.encode(), json.dumps(record).encode()]), \
                    patch.object(t.time, 'sleep'), patch.object(t, 'readonly_helper', return_value=SimpleNamespace(
                        write_workspace_private_bytes=lambda path, raw: saved.append((path, raw)))), redirect_stdout(stdout):
                code = t.main()
            self.assertEqual(code, 0 if valid else 1)
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0][0], t.ARTIFACT)
            self.assertNotIn('RAW_PRIVATE_FIXTURE', saved[0][1].decode() + stdout.getvalue())
            artifact = json.loads(saved[0][1])
            self.assertEqual(artifact['commandId'], COMMAND)
            self.assertEqual(artifact['producer'], PRODUCER)
            self.assertEqual(artifact['origin'], t.ORIGIN)
            self.assertEqual(artifact['status'], 'REPAIR_OPERATION_COMPLETED' if valid else 'REPAIR_OPERATION_FAILED')

    def test_exact_operation_selection_and_unrelated_release_inputs_are_rejected(self):
        clean = environment(); self.assertEqual(t.selection(clean), PRODUCER)
        for field, bad in (('RELEASE_OPERATION', 'repair_online_source_permissions-extra'), ('EXPECTED_CURRENT', 'b' * 40),
                           ('HISTORICAL_EXCEPTION', 'historical-finance-20261005'), ('GITHUB_REF', 'refs/heads/other'),
                           ('REUSE_IMAGE_RUN', '1'), ('DIAGNOSTIC_COMMAND_ID', COMMAND), ('CACHE_PLAN_SHA256', 'a' * 64)):
            value = {**clean, field: bad}
            with self.assertRaises(RuntimeError): t.selection(value)
            result = subprocess.run(['/bin/bash', str(SOURCE / 'validate-release-selection.sh')], cwd=ROOT,
                                    env=value, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(['/bin/bash', str(SOURCE / 'validate-release-selection.sh')], cwd=ROOT,
                                env=clean, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)

    def test_workflow_has_only_explicit_repair_and_safe_artifact_paths(self):
        workflow = ROOT / '.github/workflows/production-release.yml'
        source = workflow.read_text()
        self.assertEqual(source.count(t.OPERATION), 3)
        self.assertIn('run: python3 -B scripts/production-release/online-recharge-source-permission-repair-transport.py', source)
        self.assertIn('path: .deploy/production-release/online-source-permission-repair-result.json', source)
        sequence = ('Verify exact source and passing Quality Gate',
                    'Obtain short-lived AWS credentials through OIDC',
                    'Check AWS identity and production target', 'Verify read-only SSM command access',
                    'Explicitly repair the single baseline Compose source permission',
                    'Save only the explicit source permission repair safe receipt')
        positions = [source.index('- name: ' + title) for title in sequence]
        self.assertEqual(positions, sorted(positions))
        for title in ('Deploy through the production instance', 'Build images on the GitHub runner',
                      'Push immutable images', 'Independently read back API Admin running images and preserved services',
                      'Independently read back online recharge runtime and preserved services',
                      'Verify online recharge predecessor and idle workers before building'):
            block = source.split('- name: ' + title, 1)[1].split('\n      - ', 1)[0]
            self.assertNotIn(t.OPERATION, block)
            self.assertIn('if:', block)
        script = ("const fs=require('fs'),yaml=require('js-yaml');"
                  "const w=yaml.load(fs.readFileSync(process.argv[1],'utf8'));"
                  "process.stdout.write(JSON.stringify({inputs:w.on.workflow_dispatch.inputs,"
                  "steps:Object.values(w.jobs).flatMap(j=>j.steps||[])}));")
        parsed = subprocess.run(['node', '-e', script, str(workflow)], cwd=ROOT,
                                capture_output=True, check=True, timeout=10)
        content = json.loads(parsed.stdout)
        inputs = {name: value.get('default', '') for name, value in content['inputs'].items()}
        inputs.update(operation=t.OPERATION, historical_exception='none', commit=PRODUCER['commit'],
                      expected_current=t.BASELINE, reuse_image_run='', diagnostic_command_id='', cache_plan_sha256='')
        expected = ['Reject removed automatic registration releases', 'Check out the requested main commit',
                    'Verify exact source and passing Quality Gate', 'Validate release policy and reviewed seal selection',
                    'Obtain short-lived AWS credentials through OIDC', 'Check AWS identity and production target',
                    'Verify read-only SSM command access',
                    'Explicitly repair the single baseline Compose source permission',
                    'Save only the explicit source permission repair safe receipt']
        for failed in (False, True):
            selected = [step for step in content['steps'] if workflow_condition(step.get('if'), inputs, failed)]
            self.assertEqual([step['name'] for step in selected], expected)
            artifacts = [step for step in selected if step.get('uses', '').startswith('actions/upload-artifact@')]
            self.assertEqual(len(artifacts), 1)
            self.assertEqual(artifacts[0]['with']['path'], str(t.ARTIFACT))
            self.assertNotIn('*', artifacts[0]['with']['path'])


if __name__ == '__main__':
    unittest.main()
