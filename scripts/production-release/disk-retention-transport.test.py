import ast
import base64
import copy
import fcntl
import importlib.util
import json
import lzma
import os
from pathlib import Path
import shlex
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('maintenance_transport_test', HERE / 'disk-retention-transport.py')
transport = importlib.util.module_from_spec(spec); spec.loader.exec_module(transport)
COMMON = transport.storage_module()
COMMIT, TREE, CURRENT = 'a'*40, 'b'*40, 'c'*40
COMMAND = '00000000-0000-0000-0000-000000000001'


class ProjectTemporaryDirectory(tempfile.TemporaryDirectory):
    def __init__(self):
        directory = transport.PROJECT / '.runtime'
        directory.mkdir(mode=0o700, exist_ok=True)
        super().__init__(prefix='disk-maintenance-test-', dir=directory)


def environment(operation='verify_install', plan=''):
    return {'DISK_MAINTENANCE_OPERATION': operation, 'DISK_MAINTENANCE_PLAN_SHA256': plan,
            'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'GITHUB_RUN_ID': '900', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '800', 'EXPECTED_CURRENT': CURRENT, 'GITHUB_REF': 'refs/heads/main',
            'GITHUB_REPOSITORY': transport.GITHUB_REPOSITORY, 'AWS_REGION': transport.REGION,
            'PRODUCTION_INSTANCE_ID': transport.INSTANCE, 'RELEASE_REPOSITORY': transport.REPOSITORY}


def selected(operation='verify_install', plan=''):
    return transport.selection(environment(operation, plan))


def source_commands():
    value=Mock()
    value.git.side_effect=lambda mode,ref,**kwargs:(0,(transport.PROJECT/ref.split(':',1)[1]).read_bytes())
    return value


def binding(operation='verify_install'):
    value = {'kind': 'ID_DISK_MAINTENANCE_BINDING_V1', 'version': 1,
             **selected(operation, 'd'*64 if operation in ('install', 'cleanup') else ''),
             'policySha256': 'e'*64,
             'sourcePins': {path: {'sha256': transport.sha(path.encode()), 'bytes': len(path.encode())}
                            for path in transport.PATHS}}
    transport.validate_binding(value)
    return value


def result(value):
    plan = {'fixture': 'reviewed-complete-plan'}
    status = {'verify_install': 'PLAN_ONLY', 'install': 'INSTALLED', 'verify_cleanup': 'PLAN_ONLY', 'cleanup': 'APPLIED'}
    output = {'status': status[value['operation']], 'plan': plan, 'planSha256': transport.digest(plan),
              'currentUnchanged': True, 'containersUnchanged': True, 'websiteServicesChanged': False}
    if value['operation'] in ('install', 'verify_cleanup', 'cleanup'):
        arguments = transport.service_arguments(value)
        output['installationReadback'] = {'status': 'INSTALLATION_READBACK_VERIFIED', 'targets': [{}]*6,
            'sourceSha256': value['sourcePins'][transport.RUNNER_PATHS[0]]['sha256'],
            'nextTriggerUtc': '2030-01-01T03:15:00+00:00',
            'service': {'Id':transport.SERVICE,'Type':'oneshot','User':'root','Group':'root',
                'FragmentPath':'/etc/systemd/system/'+transport.SERVICE,'DropInPaths':'','Result':'success',
                'execStartMatched':True,'execStartExpectedSha256':transport.digest({'path':arguments[0],'argv':arguments}),
                'executionObserved':False,'executionSucceeded':False}}
    return output


def acceptance():
    return {'Command': {'CommandId': COMMAND, 'InstanceIds': [transport.INSTANCE], 'DocumentName': 'AWS-RunShellScript'}}


def invocation(value, body=None):
    return {'CommandId': COMMAND, 'InstanceId': transport.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'StandardErrorContent': '', 'StandardOutputContent': json.dumps(transport.wire(value, body or result(value)))}


class BindingTests(unittest.TestCase):
    def test_four_operations_have_distinct_plan_and_apply_permissions(self):
        for operation in transport.OPERATIONS:
            plan = 'd'*64 if operation in ('install', 'cleanup') else ''
            value = transport.selection(environment(operation, plan))
            self.assertEqual(value['operation'], operation)
            self.assertEqual(value['planSha256'], plan or None)
        for operation, plan in (('verify_install', 'd'*64), ('verify_cleanup', 'd'*64),
                                 ('install', ''), ('cleanup', ''), ('cleanup', 'not-sha')):
            with self.subTest(operation=operation), self.assertRaises(transport.Rejected):
                transport.selection(environment(operation, plan))

    def test_application_release_foreign_target_and_source_injection_are_rejected(self):
        for key, altered in (('DISK_MAINTENANCE_OPERATION', 'release'), ('GITHUB_REF', 'refs/heads/other'),
                             ('GITHUB_REPOSITORY', 'other/project'), ('AWS_REGION', 'other'),
                             ('RELEASE_COMMIT', COMMIT+';secret'), ('GITHUB_RUN_ATTEMPT', True),
                             ('PRODUCTION_INSTANCE_ID', 'i-other'), ('QUALITY_RUN_ID', '0')):
            value = environment(); value[key] = altered
            with self.subTest(key=key), self.assertRaises(transport.Rejected): transport.selection(value)

    def test_fresh_runner_attempt_two_requires_reconciliation_before_any_send(self):
        value=environment();value['GITHUB_RUN_ATTEMPT']='2'
        with self.assertRaisesRegex(transport.Rejected,'RERUN_RECONCILIATION_REQUIRED'):
            transport.selection(value)

    def test_actual_sources_bind_git_quality_policy_and_fixed_legacy_pin(self):
        commands = source_commands()
        with patch.object(COMMON, 'verify_source') as source, patch.object(transport, 'storage_module', return_value=COMMON):
            value, sources = transport.source_binding(selected(), commands)
        source.assert_called_once_with(selected(), commands)
        self.assertEqual(commands.git.call_count,6)
        self.assertEqual(set(sources), set(transport.PATHS))
        policy = json.loads(sources[transport.POLICY_PATH])
        self.assertFalse(policy['approved'])
        self.assertEqual(value['sourcePins'][transport.RUNNER_PATHS[0]]['sha256'], policy['sourceSha256'])
        self.assertEqual(value['sourcePins'][transport.CURRENT_PATHS[0]]['sha256'], policy['maintainerSha256'])
        self.assertEqual(value['policySha256'], transport.digest({key: item for key, item in policy.items() if key != 'approved'}))
        for path, pin in value['sourcePins'].items():
            self.assertEqual(pin['bytes'], len(sources[path]))
            self.assertEqual(pin['sha256'], transport.sha(sources[path]))

    def test_changed_helper_template_or_legacy_bytes_cannot_be_installed(self):
        original = COMMON.read_file
        for altered_path in (transport.CURRENT_PATHS[0], transport.CURRENT_PATHS[1], transport.RUNNER_PATHS[0]):
            def changed(path, *args, **kwargs):
                raw = original(path, *args, **kwargs)
                return raw+b'\n' if Path(path).relative_to(transport.PROJECT).as_posix() == altered_path else raw
            with self.subTest(path=altered_path), patch.object(COMMON, 'verify_source'), \
                 patch.object(COMMON, 'read_file', side_effect=changed), \
                 patch.object(transport, 'storage_module', return_value=COMMON), self.assertRaises(transport.Rejected):
                transport.source_binding(selected(), source_commands())

    def test_dirty_runtime_source_bytes_cannot_claim_the_verified_git_producer(self):
        commands=source_commands()
        commands.git.side_effect=lambda mode,ref,**kwargs:(0,b'uncommitted runtime replacement')
        with patch.object(COMMON,'verify_source'),patch.object(transport,'storage_module',return_value=COMMON),\
             self.assertRaisesRegex(transport.Rejected,'GIT_SOURCE_CHANGED'):
            transport.source_binding(selected(),commands)


class StageFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = ProjectTemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        (self.base/'.staging').mkdir(mode=0o700)
        (self.base/'.deploy.lock').write_bytes(b'lock'); (self.base/'.deploy.lock').chmod(0o600)
        self.current = self.base/'releases'/('20261014T000000Z-'+CURRENT[:12])
        self.current.mkdir(parents=True)
        self.value = binding(); self.owner = os.geteuid()
        self.probe = {'currentRelease': str(self.current), 'currentManifestSha256': 'f'*64, 'containers': []}

    def stage(self, path=transport.RUNNER_PATHS[0], payload=None):
        if payload is None and path in transport.RUNNER_PATHS:
            payload = base64.b64encode(lzma.compress(path.encode())).decode()
        with patch.object(transport, 'snapshot', return_value=self.probe):
            return transport.stage_file(self.value, path, payload, base=self.base, owner=self.owner)

    def target(self, path):
        return self.base/'.staging'/('disk-retention-'+COMMIT)/path

    def test_stage_preserves_exact_raw_bytes_private_modes_and_idempotent_reuse(self):
        path = transport.RUNNER_PATHS[0]
        first = self.stage(path)
        self.assertFalse(first['reused'])
        target = self.target(path)
        self.assertEqual(target.read_bytes(), path.encode())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
        self.assertTrue(self.stage(path)['reused'])
        transport.validate_ack(first, self.value, path)

    def test_current_helper_is_copied_only_after_exact_policy_source_verification(self):
        path = transport.CURRENT_PATHS[0]
        source = self.current/path; source.parent.mkdir(parents=True); source.write_bytes(path.encode())
        self.assertEqual(self.stage(path)['sha256'], self.value['sourcePins'][path]['sha256'])
        source.write_bytes(b'unknown current helper')
        with self.assertRaisesRegex(transport.Rejected, 'SOURCE_CHANGED'): self.stage(path)
        self.assertEqual(self.target(path).read_bytes(), path.encode())

    def test_unknown_target_wrong_mode_symlink_or_bad_payload_never_overwrites(self):
        path = transport.RUNNER_PATHS[0]
        self.stage(path); target = self.target(path)
        target.write_bytes(b'unknown'); target.chmod(0o600)
        with self.assertRaisesRegex(transport.Rejected, 'UNKNOWN_STAGE_TARGET'): self.stage(path)
        self.assertEqual(target.read_bytes(), b'unknown')
        target.write_bytes(path.encode()); target.chmod(0o644)
        with self.assertRaisesRegex(transport.Rejected, 'FILE_MODE'): self.stage(path)
        target.unlink(); target.symlink_to(self.base/'.deploy.lock')
        with self.assertRaisesRegex(transport.Rejected, 'PATH_INVALID'): self.stage(path)
        target.unlink()
        with self.assertRaisesRegex(transport.Rejected, 'SOURCE_CHANGED'):
            self.stage(path, base64.b64encode(lzma.compress(b'bad')).decode())
        self.assertFalse(target.exists())

    def test_stage_lock_conflict_does_not_modify_any_target(self):
        descriptor = os.open(self.base/'.deploy.lock', os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.stage()
        finally:
            os.close(descriptor)
        self.assertFalse(self.target(transport.RUNNER_PATHS[0]).exists())

    def test_stage_path_injection_or_foreign_operation_never_creates_files(self):
        for path in ('../../outside', '/etc/passwd', 'scripts/production-release/unknown.py'):
            with self.subTest(path=path), self.assertRaises(transport.Rejected): self.stage(path, 'invalid')
        self.value['operation'] = 'verify_cleanup'
        with self.assertRaises(transport.Rejected): self.stage()


class ContainerSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary=ProjectTemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.base=Path(self.temporary.name);self.owner=os.geteuid()
        self.release=self.base/'releases'/('20261014T000000Z-'+CURRENT[:12])
        self.release.mkdir(parents=True)
        manifest=self.release/'release-manifest.json'
        manifest.write_bytes(transport.canonical({'commit':CURRENT}));manifest.chmod(0o600)
        (self.base/'current').symlink_to(self.release)
        self.identifier='f'*64
        self.row={'id':self.identifier,'image':'sha256:'+'e'*64,'reference':'fixture:reviewed',
                  'running':False,'status':'exited','started':'2026-10-14T00:00:00Z',
                  'restartCount':0,'health':None}

    def capture_template(self):
        def read(arguments,**kwargs):
            if arguments[1]=='ps':return (self.identifier+'\n').encode()
            self.template=arguments[3]
            return transport.canonical(self.row)+b'\n'
        with patch.object(transport,'command',side_effect=read):
            return transport.snapshot(CURRENT,self.base,self.owner)

    def test_real_go_missingkey_old_template_fails_and_new_projection_is_safe(self):
        self.capture_template()
        old=self.template.replace('{{with index .State "Health"}}{{json .Status}}',
                                  '{{if .State.Health}}{{json .State.Health.Status}}')
        raw={'Id':self.identifier,'Image':self.row['image'],'RestartCount':0,
             'Config':{'Image':self.row['reference'],'Env':['FICTITIOUS_PRIVATE_ENV_MARKER']},
             'State':{'Running':False,'Status':'exited','StartedAt':self.row['started']}}
        healthy=copy.deepcopy(raw);healthy['State']['Health']={'Status':'healthy','Log':['FICTITIOUS_PRIVATE_HEALTH_MARKER']}
        null=copy.deepcopy(raw);null['State']['Health']=None
        cases=[{'template':old,'value':raw},{'template':self.template,'value':raw},
               {'template':self.template,'value':null},{'template':self.template,'value':healthy}]
        # Docker CLI's raw-inspect fallback uses missingkey=error and this JSON function.
        # https://github.com/docker/cli/blob/v25.0.5/cli/command/inspect/inspector.go
        program=r'''package main
import ("bytes"; "encoding/json"; "os"; "strings"; "text/template")
type Case struct { Template string `json:"template"`; Value any `json:"value"` }
func jsonValue(value any) string {
    var output bytes.Buffer
    encoder := json.NewEncoder(&output); encoder.SetEscapeHTML(false)
    if err := encoder.Encode(value); err != nil { panic(err) }
    return strings.TrimSpace(output.String())
}
func main() {
    var cases []Case
    decoder := json.NewDecoder(os.Stdin); decoder.UseNumber()
    if err := decoder.Decode(&cases); err != nil { panic(err) }
    rows := []map[string]any{}
    for _, item := range cases {
        formatter, err := template.New("").Funcs(template.FuncMap{"json":jsonValue}).Option("missingkey=error").Parse(item.Template)
        if err != nil { panic(err) }
        var output bytes.Buffer
        err = formatter.Execute(&output, item.Value)
        safe := ""; if err == nil { safe = output.String() }
        rows = append(rows, map[string]any{"ok":err == nil, "output":safe,
            "missingHealth":err != nil && strings.Contains(err.Error(), `map has no entry for key "Health"`)})
    }
    if err := json.NewEncoder(os.Stdout).Encode(rows); err != nil { panic(err) }
}
'''
        source=self.base/'inspect-template.go';source.write_text(program)
        cache=self.base/'go-cache';cache.mkdir(mode=0o700)
        temporary=self.base/'go-tmp';temporary.mkdir(mode=0o700)
        environment={**os.environ,'GOTOOLCHAIN':'local','GOPROXY':'off','GOWORK':'off','GO111MODULE':'off',
                     'GOCACHE':str(cache),'TMPDIR':str(temporary)}
        go=shutil.which('go') or str(Path.home()/'.local/bin/go')
        self.assertTrue(Path(go).is_file(),'Existing Go runtime required for actual template regression')
        process=transport.subprocess.run([go,'run',str(source)],input=transport.canonical(cases),
            stdout=transport.subprocess.PIPE,stderr=transport.subprocess.PIPE,env=environment,timeout=90)
        self.assertEqual(process.returncode,0,'Actual std text/template regression failed')
        rows=json.loads(process.stdout)
        self.assertFalse(rows[0]['ok']);self.assertTrue(rows[0]['missingHealth'])
        for row,health in zip(rows[1:],(None,None,'healthy')):
            self.assertTrue(row['ok']);self.assertFalse(row['missingHealth'])
            self.assertEqual(json.loads(row['output']),{**self.row,'health':health})
            self.assertNotIn('FICTITIOUS_PRIVATE',row['output'])
            self.assertNotIn('Env',row['output']);self.assertNotIn('Log',row['output'])

    def test_snapshot_equality_keeps_all_projected_container_fields(self):
        first=self.capture_template();second=self.capture_template()
        self.assertEqual(first,second)
        self.assertEqual(first['containers'],[self.row])
        self.row={**self.row,'health':'healthy'}
        self.assertNotEqual(first,self.capture_template())

    def test_ps_inspect_failures_identify_before_stage_and_create_no_source(self):
        (self.base/'.staging').mkdir(mode=0o700)
        lock=self.base/'.deploy.lock';lock.write_bytes(b'lock');lock.chmod(0o600)
        value=binding();path=transport.RUNNER_PATHS[0]
        payload=base64.b64encode(lzma.compress(path.encode())).decode()
        for failed in ('ps','inspect'):
            def run(arguments,**kwargs):
                if arguments[1]==failed:
                    return SimpleNamespace(returncode=1,stdout=b'',stderr=b'FICTITIOUS_PRIVATE_STDERR_MARKER')
                return SimpleNamespace(returncode=0,stdout=(self.identifier+'\n').encode(),stderr=b'')
            expected='MAINTENANCE_STAGE_BEFORE_SNAPSHOT_'+failed.upper()+'_FAILED'
            with self.subTest(failed=failed),patch.object(transport.subprocess,'run',side_effect=run),\
                 self.assertRaises(transport.Rejected) as error:
                transport.stage_file(value,path,payload,base=self.base,owner=self.owner)
            self.assertEqual(str(error.exception),expected)
            self.assertEqual(list((self.base/'.staging').iterdir()),[])


class RemoteWireTests(unittest.TestCase):
    def actual_binding(self):
        with patch.object(COMMON, 'verify_source'), patch.object(transport, 'storage_module', return_value=COMMON):
            return transport.source_binding(selected(), source_commands())

    def test_actual_source_commands_fit_single_short_ssm_payload_and_round_trip(self):
        value, sources = self.actual_binding()
        for path in (*transport.PATHS, None):
            payload = base64.b64encode(lzma.compress(sources[path])).decode() if path in transport.RUNNER_PATHS else None
            parameters = transport.remote_program(value, path=path, payload=payload)
            text = parameters['commands'][0]
            self.assertLessEqual(len(text.encode()), transport.MAX_COMMAND)
            loader = ast.parse(shlex.split(text)[3])
            encoded = next(node.args[0].value for node in ast.walk(loader)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode')
            program = lzma.decompress(base64.b64decode(encoded))
            ast.parse(program)
            self.assertIn(b'--approved-plan-sha256' if path is None else b'LOCK_NB', program)
            self.assertNotIn(b'Config.Env', program)
            if path in transport.CURRENT_PATHS:
                self.assertNotIn(base64.b64encode(lzma.compress(sources[path])), program)

    def test_complete_plan_gzip_is_bound_and_decompressed_before_acceptance(self):
        value = binding(); body = result(value)
        body['plan']['items'] = [{'tag': COMMIT+'-'+str(index)+'-1-online-recharge', 'imageId': 'sha256:'+'f'*64} for index in range(100)]
        wire = transport.wire(value, body)
        self.assertLess(len(transport.canonical(wire)), transport.MAX_STDOUT)
        self.assertEqual(transport.decode_wire(wire, value), body)
        for field, altered in (('bodyBytes', wire['bodyBytes']+1), ('bodySha256', '0'*64),
                               ('bindingSha256', '0'*64), ('producer', {'commit':'other'})):
            with self.subTest(field=field), self.assertRaises(transport.Rejected):
                transport.decode_wire({**wire, field: altered}, value)
        for suffix in (b'junk', b''):
            raw = base64.b64decode(wire['payload'])
            altered = raw[:-1] if suffix == b'' else raw+suffix
            with self.subTest(suffix=suffix), self.assertRaises(transport.Rejected):
                transport.decode_wire({**wire, 'payload':base64.b64encode(altered).decode()}, value)

    def test_cleanup_plan_reads_only_private_receipt_matching_native_digest(self):
        value = binding('verify_cleanup')
        plan = {'kind':'ID_DISK_RETENTION_PLAN_V1','currentCommit':CURRENT,'policySha256':value['policySha256']}
        digest = transport.digest(plan)
        result = {'planFile':str(transport.INSTALL/'receipts/20261014T000000Z-123.plan.json'),'planSha256':digest}
        stored = {'plan':plan,'planSha256':digest}
        with patch.object(transport,'regular',return_value=(transport.canonical(stored),None)):
            self.assertEqual(transport.cleanup_plan(result,value),plan)
        for path in ('/etc/passwd',str(transport.INSTALL/'receipts/../config.json'),str(transport.INSTALL/'receipts/unknown.json')):
            with self.subTest(path=path),patch.object(transport,'regular') as reader,self.assertRaises(transport.Rejected):
                transport.cleanup_plan({**result,'planFile':path},value)
            reader.assert_not_called()
        with patch.object(transport,'regular',return_value=(transport.canonical(stored),None)),self.assertRaises(transport.Rejected):
            transport.cleanup_plan({**result,'planSha256':'0'*64},value)


class SsmTests(unittest.TestCase):
    def client(self, directory, responses):
        commands = Mock();commands.aws.side_effect=responses
        return transport.SsmClient(commands,directory,sleep=lambda _:None,monotonic=lambda:0),commands

    def test_successful_accepted_command_saves_private_receipts_and_reuses_result(self):
        value=binding();parameters=transport.remote_program(value)
        with ProjectTemporaryDirectory() as folder:
            directory=Path(folder);client,commands=self.client(directory,[[],acceptance(),invocation(value)])
            self.assertEqual(client.execute('operation',parameters,value),result(value))
            self.assertEqual(client.execute('operation',parameters,value),result(value))
            self.assertEqual(commands.aws.call_count,3)
            self.assertTrue(all((path.stat().st_mode & 0o777)==0o600 for path in directory.iterdir()))

    def test_lost_send_response_requires_reconciliation_without_resending(self):
        value=binding();parameters=transport.remote_program(value)
        with ProjectTemporaryDirectory() as folder:
            directory=Path(folder);client,commands=self.client(directory,[[],RuntimeError('secret fixture')])
            with self.assertRaises(RuntimeError):client.execute('operation',parameters,value)
            with self.assertRaisesRegex(transport.Rejected,'SEND_RESULT_UNKNOWN'):
                client.execute('operation',parameters,value)
            self.assertEqual(commands.aws.call_count,2)

    def test_accepted_poll_failure_resumes_same_command_without_second_send(self):
        value=binding();parameters=transport.remote_program(value)
        with ProjectTemporaryDirectory() as folder:
            directory=Path(folder);client,commands=self.client(directory,[[],acceptance(),RuntimeError('secret fixture')])
            with self.assertRaises(RuntimeError):client.execute('operation',parameters,value)
            commands.aws.side_effect=[invocation(value)]
            self.assertEqual(client.execute('operation',parameters,value),result(value))
            self.assertEqual(commands.aws.call_count,4)
            self.assertEqual(commands.aws.call_args.args[:2],('ssm','get-command-invocation'))

    def test_terminal_failure_is_persisted_and_cannot_be_resent(self):
        value=binding();parameters=transport.remote_program(value)
        failed=invocation(value);failed.update(Status='Failed',ResponseCode=1,StandardOutputContent=json.dumps({
            'kind':'ID_DISK_MAINTENANCE_FAILURE_V1','bindingSha256':transport.digest(value),'producer':value['producer'],
            'operation':value['operation'],'status':'FAILED_CLOSED','code':'MAINTENANCE_UNKNOWN_STAGE_TARGET'}))
        with ProjectTemporaryDirectory() as folder:
            directory=Path(folder);client,commands=self.client(directory,[[],acceptance(),failed])
            with self.assertRaisesRegex(transport.Rejected,'REMOTE_TERMINAL_FAILED'):client.execute('operation',parameters,value)
            with self.assertRaisesRegex(transport.Rejected,'PRIOR_TERMINAL_FAILED'):client.execute('operation',parameters,value)
            self.assertEqual(commands.aws.call_count,3)
            saved=json.loads((directory/'operation.result.json').read_text())
            self.assertEqual(saved['failure']['code'],'MAINTENANCE_UNKNOWN_STAGE_TARGET')

    def test_wrong_instance_document_command_stderr_and_wire_fail_closed(self):
        value=binding();parameters=transport.remote_program(value)
        for field,altered in (('CommandId','00000000-0000-0000-0000-000000000002'),('InstanceId','other'),
                             ('DocumentName','other'),('PluginName','other'),('StandardErrorContent','secret fixture'),
                             ('StandardOutputContent','uncontrolled secret fixture')):
            response=invocation(value);response[field]=altered
            with self.subTest(field=field),ProjectTemporaryDirectory() as folder:
                client,commands=self.client(Path(folder),[[],acceptance(),response])
                with self.assertRaises(transport.Rejected):client.execute('operation',parameters,value)
                self.assertEqual(commands.aws.call_count,3)

    def test_new_run_refuses_prior_instance_command_still_in_progress(self):
        value=binding();parameters=transport.remote_program(value)
        prior={'CommandId':COMMAND,'Status':'InProgress','InstanceIds':[transport.INSTANCE]}
        with ProjectTemporaryDirectory() as folder:
            directory=Path(folder);client,commands=self.client(directory,[[prior]])
            with self.assertRaisesRegex(transport.Rejected,'PRIOR_COMMAND_UNSETTLED'):
                client.execute('operation',parameters,value)
            self.assertEqual(commands.aws.call_count,1)
            self.assertEqual(commands.aws.call_args.args[:2],('ssm','list-commands'))
            self.assertFalse((directory/'operation.intent.json').exists())
            self.assertNotIn('Parameters',commands.aws.call_args.args[-1])

    def test_get_confirmed_success_stage_can_ignore_delayed_list_status_for_own_id(self):
        value=binding();parameters=transport.remote_program(value)
        new_id='00000000-0000-0000-0000-000000000002'
        second_acceptance=acceptance();second_acceptance['Command']['CommandId']=new_id
        second_invocation=invocation(value);second_invocation['CommandId']=new_id
        delayed={'CommandId':COMMAND,'Status':'Pending','InstanceIds':[transport.INSTANCE]}
        with ProjectTemporaryDirectory() as folder:
            client,commands=self.client(Path(folder),[[],acceptance(),invocation(value),
                [delayed],second_acceptance,second_invocation])
            self.assertEqual(client.execute('stage-0',parameters,value),result(value))
            self.assertEqual(client.execute('stage-1',parameters,value),result(value))
            self.assertEqual(commands.aws.call_count,6)
            self.assertEqual(client.confirmed,{COMMAND,new_id})
            self.assertFalse(client.unsettled)

    def test_unknown_status_or_incomplete_instance_command_listing_fails_closed(self):
        for listing in ([{'CommandId':COMMAND,'Status':'Unknown','InstanceIds':[transport.INSTANCE]}],
                        [{'CommandId':COMMAND,'Status':'Success'}],
                        [{'CommandId':COMMAND,'Status':'Success','InstanceIds':[transport.INSTANCE],'Parameters':{}}],
                        {'Commands':[]}):
            with self.subTest(listing=listing),ProjectTemporaryDirectory() as folder:
                client,commands=self.client(Path(folder),[listing])
                with self.assertRaisesRegex(transport.Rejected,'COMMAND_LIST_INVALID'):
                    client.execute('operation',transport.remote_program(binding()),binding())
                self.assertEqual(commands.aws.call_count,1)

    def test_filtered_terminal_target_command_allows_empty_instance_ids(self):
        with ProjectTemporaryDirectory() as folder:
            client,commands=self.client(Path(folder),[[{'CommandId':COMMAND,'Status':'Success','InstanceIds':[]}]])
            client.check_prior_commands()
            self.assertEqual(commands.aws.call_count,1)
        with ProjectTemporaryDirectory() as folder:
            client,commands=self.client(Path(folder),[[{'CommandId':COMMAND,'Status':'Success',
                'InstanceIds':[transport.INSTANCE,'mi-'+'f'*17,'i-'+'a'*8]}]])
            client.check_prior_commands()

    def test_filtered_pending_target_command_still_blocks_with_empty_instance_ids(self):
        value=binding()
        with ProjectTemporaryDirectory() as folder:
            client,commands=self.client(Path(folder),[[{'CommandId':COMMAND,'Status':'Pending','InstanceIds':[]}]])
            with self.assertRaisesRegex(transport.Rejected,'PRIOR_COMMAND_UNSETTLED'):
                client.execute('operation',transport.remote_program(value),value)
            self.assertEqual(commands.aws.call_count,1)
            self.assertFalse((Path(folder)/'operation.intent.json').exists())


class NativeOperationTests(unittest.TestCase):
    def service_values(self, value):
        arguments=transport.service_arguments(value)
        return {'Id':transport.SERVICE,'Names':transport.SERVICE,'LoadState':'loaded',
            'FragmentPath':'/etc/systemd/system/'+transport.SERVICE,'DropInPaths':'','Type':'oneshot',
            'User':'root','Group':'root','Result':'success','ActiveState':'inactive','SubState':'dead',
            'MainPID':'0','ControlPID':'0','ExecMainCode':'0','ExecMainStatus':'0',
            'ExecMainStartTimestamp':'','ExecMainExitTimestamp':'',
            'ExecStart':'{ path='+arguments[0]+' ; argv[]='+' '.join(arguments)+
                ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'}

    def read_service(self, value, properties):
        with patch.object(transport,'command',return_value='\n'.join(key+'='+item for key,item in properties.items()).encode()) as call:
            result=transport.service_readback(value)
        arguments=call.call_args.args[0]
        self.assertEqual(arguments[:6],['env','TZ=UTC','systemctl','show',transport.SERVICE,'--no-pager'])
        self.assertNotIn('Environment',arguments[-1])
        return result

    def test_effective_service_configuration_does_not_claim_unobserved_execution(self):
        value=binding('install');properties=self.service_values(value)
        measured=self.read_service(value,properties)
        self.assertEqual(measured['Result'],'success')
        self.assertTrue(measured['execStartMatched'])
        self.assertFalse(measured['executionObserved']);self.assertFalse(measured['executionSucceeded'])
        self.assertNotIn('ExecStart',measured)
        arguments=transport.service_arguments(value)
        self.assertEqual(measured['execStartExpectedSha256'],transport.digest({'path':arguments[0],'argv':arguments}))

    def test_effective_service_actual_completed_success_and_failure_are_distinct(self):
        value=binding('cleanup');properties=self.service_values(value)
        properties.update(ExecMainCode='1',ExecMainStartTimestamp='Wed 2026-01-14 03:15:00 UTC',
                          ExecMainExitTimestamp='Wed 2026-01-14 03:15:01 UTC')
        properties['ExecStart']=properties['ExecStart'].replace('code=(null) ; status=0/0','code=exited ; status=0')
        measured=self.read_service(value,properties)
        self.assertTrue(measured['executionObserved']);self.assertTrue(measured['executionSucceeded'])
        properties.update(Result='exit-code',ActiveState='failed',SubState='failed',ExecMainStatus='1')
        measured=self.read_service(value,properties)
        self.assertTrue(measured['executionObserved']);self.assertFalse(measured['executionSucceeded'])
        self.assertEqual(measured['Result'],'exit-code')

    def test_foreign_effective_service_command_fields_and_result_fail_closed(self):
        value=binding('install');properties=self.service_values(value)
        changes=(('Type','simple'),('User','ubuntu'),('Group','ubuntu'),('Names',transport.SERVICE+' other.service'),
            ('DropInPaths','/etc/systemd/system/override.conf'),('MainPID','10'),
            ('ExecStart',properties['ExecStart'].replace('argv[]=/usr/bin/python3','argv[]=/bin/sh')),
            ('ExecStart',properties['ExecStart'].replace(' ; ignore_errors=no',' --unknown ; ignore_errors=no')),
            ('ExecStart',properties['ExecStart']+' '+properties['ExecStart']),
            ('ExecStart',properties['ExecStart'].replace(' ; pid=0',' ; other=x ; pid=0')),
            ('Result','unknown'),('ExecMainStartTimestamp','secret raw text'))
        for key,altered in changes:
            with self.subTest(key=key,altered=altered),self.assertRaises(transport.Rejected):
                self.read_service(value,{**properties,key:altered})

    def test_cleanup_results_require_full_service_readback(self):
        for operation in ('install','verify_cleanup','cleanup'):
            value=binding(operation);output=result(value)
            if operation in ('install','cleanup'):value['planSha256']=output['planSha256']
            transport.validate_result(output,value)
            for altered in ({}, {**output['installationReadback'],'targets':[]},
                            {**output['installationReadback'],'service':{}},
                            {**output['installationReadback'],'service':{**output['installationReadback']['service'],
                                'execStartExpectedSha256':'0'*64}}):
                with self.subTest(operation=operation),self.assertRaises(transport.Rejected):
                    transport.validate_result({**output,'installationReadback':altered},value)

    def make_binding(self, operation):
        value=binding(operation)
        raws={path:path.encode() for path in transport.PATHS}
        policy={'approved':False,'sourceSha256':transport.sha(raws[transport.RUNNER_PATHS[0]])}
        value['policySha256']=transport.digest({key:item for key,item in policy.items() if key!='approved'})
        return value,raws,policy

    def test_native_operation_arguments_never_use_business_release_or_scheduled_authority(self):
        for operation in transport.OPERATIONS:
            value,raws,policy=self.make_binding(operation)
            plan={'fixture':'complete native plan'}
            if operation=='install':
                plan['targets']={str(path):{'sha256':sha,'mode':mode,'bytes':1024}
                    for path,(sha,mode) in transport.installed_targets(value,policy).items()}
            if operation in ('install','cleanup'):value['planSha256']=transport.digest(plan)
            body={'status':{'verify_install':'PLAN_ONLY','install':'INSTALLED','verify_cleanup':'PLAN_ONLY','cleanup':'APPLIED'}[operation],
                  'planSha256':transport.digest(plan),'plan':plan}
            def read(path,*args,**kwargs):
                if str(path).endswith('/'+transport.POLICY_PATH):return transport.canonical(policy),None
                if str(path).endswith('/config.json'):return transport.canonical({**policy,'approved':True}),None
                return Path(path).name.encode(),None
            for path in value['sourcePins']:
                raw=Path(path).name.encode() if path!=transport.POLICY_PATH else transport.canonical(policy)
                value['sourcePins'][path]={'sha256':transport.sha(raw),'bytes':len(raw)}
            probe={'currentRelease':'fixture','currentManifestSha256':'f'*64,'containers':[]}
            def child(arguments,**kwargs):
                return SimpleNamespace(returncode=0,stderr=b'',stdout=transport.canonical({
                    **body,'status':body['status'] if '--apply' in arguments else 'PLAN_ONLY'}))
            with self.subTest(operation=operation),patch.object(transport.os,'geteuid',return_value=0),\
                 patch.object(transport,'regular',side_effect=read),patch.object(transport,'snapshot',return_value=probe),\
                 patch.object(transport.subprocess,'run',side_effect=child) as runner,\
                 patch.object(transport,'cleanup_plan',return_value=plan),\
                 patch.object(transport,'installation_readback',return_value={'status':'INSTALLATION_READBACK_VERIFIED'}) as readback:
                returned=transport.execute_native(value)
                arguments=runner.call_args.args[0]
                self.assertEqual(runner.call_count,2 if operation in ('install','cleanup') else 1)
                self.assertNotIn('--scheduled',arguments);self.assertNotIn('--phase',arguments)
                self.assertEqual('--apply' in arguments,operation in ('install','cleanup'))
                self.assertEqual(returned['sourceProbe'],probe)
                self.assertEqual(readback.call_count,0 if operation=='verify_install' else 1)
                self.assertEqual('installationReadback' in returned,operation!='verify_install')
                if operation in ('verify_install','install'):
                    self.assertIn('--policy-json',arguments)
                    self.assertTrue(arguments[2].endswith('/scripts/production-release/disk-retention-install.py'))
                else:self.assertEqual(arguments[2],str(transport.INSTALL/'disk-retention.py'))

    def test_receipt_budget_failure_stops_before_mutating_native_cli(self):
        value,raws,policy=self.make_binding('cleanup')
        plan={'corePlan':{'items':[]}}
        value['planSha256']=transport.digest(plan)
        value['policySha256']=transport.digest({key:item for key,item in policy.items() if key!='approved'})
        for path in value['sourcePins']:
            raw=Path(path).name.encode()
            value['sourcePins'][path]={'sha256':transport.sha(raw),'bytes':len(raw)}
        def read(path,*args,**kwargs):
            if str(path).endswith('/config.json'):return transport.canonical({**policy,'approved':True}),None
            return Path(path).name.encode(),None
        body={'status':'PLAN_ONLY','planSha256':value['planSha256']}
        child=SimpleNamespace(returncode=0,stderr=b'',stdout=transport.canonical(body))
        with patch.object(transport.os,'geteuid',return_value=0),patch.object(transport,'regular',side_effect=read),\
             patch.object(transport,'snapshot',return_value={'containers':[]}),\
             patch.object(transport,'cleanup_plan',return_value=plan),\
             patch.object(transport,'wire',return_value={'payload':'x'*20001}),\
             patch.object(transport.subprocess,'run',return_value=child) as runner,\
             self.assertRaisesRegex(transport.Rejected,'APPLY_RECEIPT_BUDGET'):
            transport.execute_native(value)
        self.assertEqual(runner.call_count,1)
        self.assertNotIn('--apply',runner.call_args.args[0])

    def test_reviewed_actual_eight_image_plan_fits_final_receipt_reservation(self):
        # Exact image identities from the 2026-10-14 readonly reviewed plan.
        rows=(
            ('28a3ba4ffd17d36001b1104c97394f5ae871d73d-37933246605-1-online-recharge','49a16ff495d45c62a5f178e544e65bc52b975c8a753bf15938a6f54f479d32bf'),
            ('296c096af7c4c79a8ffc2f57d9a15ea75684f431-37944613453-1-online-recharge','e0824caf6a6ca75cc65cadf6f40c6c60e8d0118227193f293c681f241d24ec23'),
            ('31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-admin','f3a6b231e914f087722b87f704b7583f93ba0a462444afe6a0b68e8580917eab'),
            ('31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1-api','74c28d510a434d599b86188ec7a38d5830b1a4e39b615d92b960963c14aac379'),
            ('34a2ad26def934dcaed6bdd1e3188ca977fcdc30-38149250659-1-online-recharge','6c1dd50fa8e535f4b314664680392cb6d6e3b772a6f9818380da59e96e673c81'),
            ('34a2ad26def934dcaed6bdd1e3188ca977fcdc30-38152058777-1-online-recharge','796969247425d784d9a4cffe90bb2b1d12964117144b3466d2ae017d0d613442'),
            ('a6f923205d6d9c9b2d7aee7b94a125369147c4db-38137369470-1-online-recharge','25100999f3634bbb3d7d4696c1a5d07d13caed5fb0cb43b7bec9c4613b4c753d'),
            ('fd16cc2cbbec84c212f315d4b735ea0ce8a6cd6a-37808808447-1-migrate','a09fa38509eb2ad5d2e2a83a52e2b5a8fd977a6581e057667621fa8676effaa0'))
        value=binding('cleanup')
        plan={'corePlan':{'items':[{'tag':tag,'imageId':'sha256:'+image} for tag,image in rows]}}
        planned={'status':'PLAN_ONLY','plan':plan,'planSha256':transport.digest(plan)}
        transport.apply_receipt_budget(value,planned,{'currentRelease':'/opt/id-business-v2/releases/20261014T002401Z-f193f34ea09a',
            'currentManifestSha256':'f'*64,'containers':[]}, {'approved':True})

    def test_installed_readback_requires_exact_six_sources_and_real_future_timer(self):
        value,raws,policy=self.make_binding('install')
        expected=transport.installed_targets(value,policy)
        future='Thu 2030-10-17 03:15:00 UTC'
        values={'Id':transport.TIMER,'LoadState':'loaded','FragmentPath':'/etc/systemd/system/'+transport.TIMER,
                'DropInPaths':'','ActiveState':'active','SubState':'waiting','UnitFileState':'enabled',
                'Triggers':transport.SERVICE,'NextElapseUSecRealtime':future}
        meta=SimpleNamespace(st_uid=0,st_gid=0)
        def read(path,*args,**kwargs):return str(path).encode(),meta
        hashes={str(path):sha for path,(sha,mode) in expected.items()}
        with patch.object(transport,'installed_targets',return_value=expected),\
             patch.object(transport,'regular',side_effect=read),patch.object(transport,'sha',side_effect=lambda raw:hashes[raw.decode()]),\
             patch.object(transport,'command',return_value='\n'.join(key+'='+item for key,item in values.items()).encode()),\
             patch.object(transport,'service_readback',return_value={'execStartMatched':True}) as service:
            measured=transport.installation_readback(value,policy)
            self.assertEqual(len(measured['targets']),6)
            self.assertEqual(measured['timer']['UnitFileState'],'enabled')
            service.assert_called_once_with(value)
            self.assertTrue(measured['service']['execStartMatched'])
        for key,altered in (('SubState','dead'),('UnitFileState','disabled'),('NextElapseUSecRealtime','n/a')):
            changed={**values,key:altered}
            with self.subTest(key=key),patch.object(transport,'installed_targets',return_value=expected),\
                 patch.object(transport,'regular',side_effect=read),\
                 patch.object(transport,'sha',side_effect=lambda raw:hashes[raw.decode()]),\
                 patch.object(transport,'command',return_value='\n'.join(name+'='+item for name,item in changed.items()).encode()),\
                 self.assertRaises(transport.Rejected):transport.installation_readback(value,policy)

    def test_installed_unit_hashes_match_actual_installer_payloads(self):
        path=HERE/'disk-retention-install.py'
        spec=importlib.util.spec_from_file_location('disk_maintenance_installer_contract',path)
        installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
        value,raws,policy=self.make_binding('install')
        service,timer=installer.units(value['sourcePins'][transport.RUNNER_PATHS[0]]['sha256'])
        expected=transport.installed_targets(value,policy)
        self.assertEqual(expected[Path('/etc/systemd/system')/transport.SERVICE],(transport.sha(service),0o644))
        self.assertEqual(expected[Path('/etc/systemd/system')/transport.TIMER],(transport.sha(timer),0o644))

    def test_stage_ack_or_unapproved_apply_plan_drift_cannot_be_accepted(self):
        value=binding();path=transport.RUNNER_PATHS[0]
        ack={'kind':'ID_DISK_MAINTENANCE_STAGE_ACK_V1','status':'STAGED','producer':value['producer'],
             'expectedCurrent':CURRENT,'path':path,**value['sourcePins'][path],'reused':False,
             'currentUnchanged':True,'containersUnchanged':True}
        transport.validate_ack(ack,value,path)
        with self.assertRaises(transport.Rejected):transport.validate_ack({**ack,'sha256':'0'*64},value,path)
        value=binding('cleanup')
        with self.assertRaisesRegex(transport.Rejected,'APPROVED_PLAN_CHANGED'):transport.validate_result(result(value),value)


class WorkflowContractTests(unittest.TestCase):
    def test_maintenance_workflow_has_production_lock_exact_source_and_no_business_commands(self):
        workflow=(transport.PROJECT/'.github/workflows/disk-retention-maintenance.yml').read_text()
        self.assertIn('group: id-business-v2-production-release',workflow)
        self.assertIn('cancel-in-progress: false',workflow)
        self.assertIn('ref: ${{ inputs.commit }}',workflow)
        self.assertIn('check-source.sh',workflow)
        self.assertIn('id-token: write',workflow)
        self.assertIn('disk-retention-maintenance/**/*.json',workflow)
        for banned in ('build-images.sh','push-images.sh','dispatch.sh','prisma migrate','docker compose'):
            self.assertNotIn(banned,workflow)
        for operation in transport.OPERATIONS:self.assertIn('- '+operation,workflow)


if __name__ == '__main__':
    unittest.main()
