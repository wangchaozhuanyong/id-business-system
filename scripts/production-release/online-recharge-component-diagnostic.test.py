"""Read-only diagnostic authentication; no real AWS/GitHub request."""
from contextlib import contextmanager, redirect_stdout
import base64
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile


HERE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('.', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


diag = load('online-recharge-component-diagnostic.py')
fixtures = load('online-recharge-component-readonly.test.py')
P = fixtures.P


class DiagnosticTests(unittest.TestCase):
    def evidence_fixture(self):
        client = fixtures.client
        params = client.parameters('preflight', client.r.c.load_core(), P,
                                   origin_raw=fixtures.ORIGIN, current_raw=fixtures.CURRENT_RAW)
        metadata = {'producer': P, 'mode': 'preflight', 'commandId': fixtures.COMMAND,
                    'instanceId': fixtures.INSTANCE, 'status': 'ACCEPTED'}
        intent = {'producer': P, 'mode': 'preflight', 'expectedCurrent': fixtures.CURRENT,
                  'parametersSha256': client.r.c.fingerprint(params), 'status': 'SUBMITTING_ONCE'}
        run = {'id': 123, 'run_attempt': 1, 'repository': {'full_name': diag.REPOSITORY},
            'path': '.github/workflows/production-release.yml', 'event': 'workflow_dispatch',
            'head_branch': 'main', 'status': 'completed', 'conclusion': 'failure', 'head_sha': P['commit']}
        job = {'id': 987, 'name': 'release', 'status': 'completed', 'conclusion': 'failure',
            'head_sha': P['commit'], 'steps': [{'name': 'Verify online recharge predecessor and idle workers before building',
                                             'conclusion': 'failure'}]}
        artifact = {'id': 654, 'expired': False, 'size_in_bytes': 100,
            'name': 'online-recharge-evidence-123-1', 'workflow_run': {'id': 123, 'head_sha': P['commit']}}
        return {'params': params, 'metadata': metadata, 'intent': intent, 'run': run, 'job': job, 'artifact': artifact}

    def archive(self, f):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, key in (('parameters', 'params'), ('send-intent', 'intent'), ('invocation-metadata', 'metadata')):
                z.writestr('online-recharge-component-' + f['metadata']['mode'] + '-' + name + '.json', json.dumps(f[key]))
            for name, raw in f.get('additional', {}).items():
                z.writestr(name, raw)
        return output.getvalue()

    def api(self, f, endpoint):
        if endpoint.endswith('/attempts/1'):
            return f['run']
        if '/commits/' in endpoint:
            return {'sha': P['commit'], 'commit': {'tree': {'sha': P['sourceTree']}}}
        if '/jobs?' in endpoint:
            return {'jobs': [f['job']]}
        if '/artifacts?' in endpoint:
            return {'artifacts': [f['artifact']]}
        if endpoint.endswith('/actions/runs/456'):
            return {'id': 456, 'path': '.github/workflows/quality.yml', 'event': 'push',
                'repository': {'full_name': diag.REPOSITORY}, 'status': 'completed', 'conclusion': 'success',
                'head_sha': P['commit']}
        self.fail('Unexpected transport')

    def git(self, args, cap=128 * 1024):
        if args[:2] == ['git', 'rev-parse']:
            return (P['sourceTree'] + '\n').encode()
        if args[:2] == ['git', 'show']:
            return (HERE / args[2].split(':scripts/production-release/', 1)[1]).read_bytes()
        self.fail('AWS must not run while authenticating evidence')

    def test_original_run_job_archive_metadata_and_parameters_bind_before_aws(self):
        with fixtures.selected_fixture(), patch.object(diag, 'client', fixtures.client):
            f = self.evidence_fixture()
            with patch.object(diag, 'api', side_effect=lambda endpoint: self.api(f, endpoint)), \
                    patch.object(diag, 'artifact_bytes', return_value=self.archive(f)), \
                    patch.object(diag, 'read_command', side_effect=self.git) as reads:
                result = diag.original_evidence('123', '1')
                self.assertEqual(result['producer'], P)
                self.assertEqual(result['commandId'], fixtures.COMMAND)
                self.assertEqual(result['evidenceJobId'], '987')
                self.assertEqual(result['expectedCurrent'], fixtures.CURRENT)
                self.assertTrue(all(call.args[0][0] == 'git' for call in reads.call_args_list))

    def test_changed_run_attempt_job_instance_or_parameters_refuses_before_ssm(self):
        mutations = (
            lambda f: f['run'].update(run_attempt=2),
            lambda f: f['run'].update(head_branch='other'),
            lambda f: f['run'].update(path='.github/workflows/quality.yml'),
            lambda f: f['job'].update(head_sha='0' * 40),
            lambda f: f['artifact'].update(expired=True),
            lambda f: f['metadata'].update(instanceId='i-00000000000000000'),
            lambda f: f['intent'].update(expectedCurrent='0' * 40),
            lambda f: f['intent'].update(parametersSha256='0' * 64),
            lambda f: f['params'].update(commands=['python3 -c "private malicious fixture"']),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), fixtures.selected_fixture(), patch.object(diag, 'client', fixtures.client):
                f = self.evidence_fixture(); mutate(f)
                with patch.object(diag, 'api', side_effect=lambda endpoint: self.api(f, endpoint)), \
                        patch.object(diag, 'artifact_bytes', return_value=self.archive(f)), \
                        patch.object(diag, 'read_command', side_effect=self.git) as reads, self.assertRaises(RuntimeError):
                    diag.original_evidence('123', '1')
                self.assertTrue(all(call.args[0][0] == 'git' for call in reads.call_args_list))

    def binding(self):
        return {'producer': P, 'mode': 'preflight', 'expectedCurrent': diag.client.r.current_predecessor(),
                'commandId': fixtures.COMMAND,
                'instanceId': diag.client.r.authority()['instanceId'], 'evidenceJobId': '987',
                'artifactId': '654', 'artifactBytesSha256': 'f' * 64}

    @contextmanager
    def finite_parameters(self, mode, producer=None):
        client = diag.client; r = client.r; core = r.c.load_core()
        producer = P if producer is None else producer
        a = copy.deepcopy(r.c.AUTHENTICATED_PREDECESSOR)
        current = copy.deepcopy(r.c.AUTHENTICATED_ADMIN_SUCCESSOR)
        now = datetime.now(timezone.utc).isoformat()
        def native(receipt, command, wire=True):
            return json.dumps({'CommandId': command, 'InstanceId': a['instanceId'],
                'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
                'StandardOutputContent': json.dumps(r.wire(receipt) if wire else receipt),
                'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now}).encode()
        origin = native({'syntheticPublicOrigin': True}, a['commandId'], False)
        successor = native({'syntheticPublicAdmin': True}, current['commandId'], False)
        for authority, raw in ((a, origin), (current, successor)):
            authority['invocationBytesSha256'] = r.c.digest(raw)
            authority['receiptSha256'] = r.c.fingerprint(json.loads(json.loads(raw)['StandardOutputContent']))
        projection = {'candidateProducer': producer, 'syntheticPublicProjection': True}
        receipt = {'version': 1, 'kind': r.KIND, 'scope': r.SCOPE, 'producer': producer,
            'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'migrationPerformed': False,
            'databaseGrantsChanged': False, 'executionMigrationPlan': [], 'onlinePublished': False,
            'businessActions': 0, 'sourceProjectionSha256': r.c.fingerprint(projection),
            'baseline': {'ordinaryAuthoritySha256': r.c.fingerprint(a),
                'actualPredecessor': current['producer'], 'adminAuthoritySha256': r.c.fingerprint(current)}}
        raw = native(receipt, fixtures.COMMAND)
        transport = {'version': 1, 'kind': r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': producer,
            'expectedCurrent': current['producer']['commit'], 'commandId': fixtures.COMMAND,
            'instanceId': a['instanceId'], 'invocationBytesSha256': r.c.digest(raw),
            'invocationRawBase64': base64.b64encode(raw).decode(), 'serverReceipt': receipt}
        repository = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
        proof = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND + '_BUILD_PROOF', 'producer': producer,
            'qualityRunId': '456', 'sourceProjection': projection, 'preflightSha256': r.c.fingerprint(transport),
            'migrations': dict(r.c.MIGRATIONS), 'images': {name: {
                'reference': repository + ':' + producer['commit'] + '-123-1-' + name,
                'imageId': 'sha256:' + r.c.digest(name.encode()), 'fileCount': 1, 'sha256': 'e' * 64}
                for name in r.IMAGES}}
        encoded = lambda value: (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        saved = {'proof': encoded(proof), 'preflight': encoded(transport)}
        env = dict(fixtures.ENV, EXPECTED_CURRENT=current['producer']['commit'],
            PRODUCTION_INSTANCE_ID=a['instanceId'])
        def pins(core, p, helpers):
            return {name: r.c.digest(subprocess.check_output(['git', 'show', p['commit']
                + ':scripts/production-release/' + name], cwd=HERE.parents[1])) if producer is not P
                else r.c.digest((HERE / name).read_bytes()) for name in helpers}
        with patch.object(r.c, 'SEALED_ORDINARY_COMPONENT', a), patch.object(r.c, 'ADMIN_SUCCESSOR', current), \
                patch.object(r, 'INSTANCE', a['instanceId']), \
                patch.dict(client.os.environ, env, clear=True), patch.object(client, 'helper_pins',
                    side_effect=pins):
            params = client.parameters(mode, core, producer, input_artifacts=(saved['proof'], saved['preflight'])
                if mode == 'release' else None, origin_raw=origin, current_raw=successor)
            yield params, saved, a['instanceId'], current['producer']['commit']

    def native(self, binding, status='Failed', stderr='failed to run commands: exit status 1'):
        receipt = {'version': 1, 'kind': diag.client.r.KIND, 'scope': diag.client.r.SCOPE,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED',
            'code': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_SOURCE_FILENOTFOUNDERROR_ERRNO_2'}
        now = datetime.now(timezone.utc).isoformat()
        value = {'CommandId': binding['commandId'], 'InstanceId': binding['instanceId'],
            'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': status,
            'ResponseCode': 1, 'StandardOutputContent': json.dumps(diag.client.r.wire(receipt)),
            'StandardErrorContent': stderr, 'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now}
        return json.dumps(value).encode()

    def test_observe_real_failed_trailer_uses_original_bytes_and_only_get(self):
        binding = self.binding(); raw = self.native(binding)
        with patch.object(diag, 'read_command', return_value=raw) as read:
            result = diag.observe(binding)
        self.assertEqual(read.call_count, 1)
        self.assertEqual(read.call_args.args[0][:5], ['aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation'])
        self.assertEqual(result['outcome'], 'COMMAND_FAILED')
        self.assertIs(result['nativeAuthenticated'], True)
        self.assertIs(result['serverRejected'], True)
        self.assertEqual(result['code'], 'ONLINE_RECHARGE_COMPONENT_PROTECTED_SOURCE_FILENOTFOUNDERROR_ERRNO_2')
        self.assertEqual(result['nativeBytesSha256'], diag.client.r.c.digest(raw))
        self.assertNotIn('StandardOutputContent', result)
        self.assertNotIn('StandardErrorContent', result)
        self.assertIs(result['automaticRetryAllowed'], False)

    def test_timeout_nonterminal_and_arbitrary_stderr_are_not_success(self):
        binding = self.binding()
        cases = ((TimeoutError('private password'), 'RESULT_UNKNOWN'),
            (self.native(binding, 'InProgress'), 'RESULT_UNKNOWN'),
            (self.native(binding, stderr='private password'), 'AUTHENTICATION_REJECTED'))
        for raw, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(diag, 'read_command',
                    side_effect=raw if isinstance(raw, Exception) else None,
                    return_value=None if isinstance(raw, Exception) else raw):
                result = diag.observe(binding)
                self.assertEqual(result['outcome'], outcome)
                self.assertNotIn('private', json.dumps(result))
                self.assertIs(result['automaticRetryAllowed'], False)

    def test_diagnostic_transport_refuses_send_post_or_other_mutations(self):
        with patch.object(diag.subprocess, 'run') as transport:
            for args in (['aws', '--region', 'ap-northeast-1', 'ssm', 'send-command'],
                         ['git', 'reset', '--hard'], ['docker', 'run', 'private'],
                         ['gh', 'api', '-X', 'POST', 'repos/' + diag.REPOSITORY + '/actions/runs'],
                         ['gh', 'api', 'repos/' + diag.REPOSITORY + '/issues/1', '-X', 'DELETE'],
                         ['gh', 'api', '--method=POST', 'repos/' + diag.REPOSITORY + '/issues'],
                         ['gh', 'api', 'repos/other/repository/actions/runs'],
                         ['gh', 'api', '--allow-escape-sequences', '--allow-escape-sequences',
                          'repos/' + diag.REPOSITORY + '/actions/runs']):
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_FORBIDDEN'):
                    diag.read_command(args)
            transport.assert_not_called()

    def test_real_release_and_readback_parameters_bind_with_proof_and_quality(self):
        for mode in ('release', 'readback'):
            with self.subTest(mode=mode), self.finite_parameters(mode) as (params, saved, instance, current):
                f = {'metadata': {'mode': mode}, 'params': params, 'additional': {}}
                with patch.object(diag, 'read_command', side_effect=self.git), \
                        patch.object(diag, 'api', side_effect=lambda endpoint: self.api(f, endpoint)):
                    self.assertEqual(diag.authenticate_parameters(params, P, instance, mode, saved),
                                     diag.client.r.c.fingerprint(params))
                    for changed, producer, evidence in ((dict(params, executionTimeout=['600' if mode == 'release' else '1800']), P, saved),
                        (params, dict(P, workflowRunAttempt='2'), saved),
                        (params, P, dict(saved, proof=b'changed proof')) if mode == 'release' else
                        (dict(params, commands=['python3 -B -c "private fixture"']), P, saved)):
                        with self.assertRaises(RuntimeError):
                            diag.authenticate_parameters(changed, producer, instance, mode, evidence)
                if mode == 'release':
                    with patch.object(diag, 'read_command', side_effect=self.git), patch.object(diag, 'api', return_value={}), \
                            self.assertRaisesRegex(RuntimeError, 'QUALITY_CHANGED'):
                        diag.authenticate_parameters(params, P, instance, mode, saved)

    def test_latest_accepted_mode_chooses_readback_then_release_without_sending(self):
        for mode in ('release', 'readback'):
            with self.subTest(mode=mode), self.finite_parameters(mode) as (params, saved, instance, current):
                f = {'params': params,
                    'metadata': {'producer': P, 'mode': mode, 'commandId': fixtures.COMMAND,
                        'instanceId': instance, 'status': 'ACCEPTED'},
                    'intent': {'producer': P, 'mode': mode, 'expectedCurrent': current,
                        'parametersSha256': diag.client.r.c.fingerprint(params), 'status': 'SUBMITTING_ONCE'},
                    'run': {'id': 123, 'run_attempt': 1, 'repository': {'full_name': diag.REPOSITORY},
                        'path': '.github/workflows/production-release.yml', 'event': 'workflow_dispatch',
                        'head_branch': 'main', 'status': 'completed', 'conclusion': 'failure', 'head_sha': P['commit']},
                    'job': {'id': 987, 'name': 'release', 'status': 'completed', 'conclusion': 'failure',
                        'head_sha': P['commit'], 'steps': [{'name': 'Verify online recharge predecessor and idle workers before building',
                            'conclusion': 'success'}]},
                    'artifact': {'id': 654, 'expired': False, 'size_in_bytes': 100,
                        'name': 'online-recharge-evidence-123-1'},
                    'additional': {'online-recharge-component-preflight-invocation-metadata.json': b'{}'}}
                if mode == 'release':
                    f['additional'].update({'online-recharge-component-build-proof.json': saved['proof'],
                        'online-recharge-component-preflight.json': saved['preflight']})
                with patch.object(diag, 'api', side_effect=lambda endpoint: self.api(f, endpoint)), \
                        patch.object(diag, 'artifact_bytes', return_value=self.archive(f)), \
                        patch.object(diag, 'read_command', side_effect=self.git):
                    self.assertEqual(diag.original_evidence('123', '1')['mode'], mode)

    def test_late_success_original_readback_has_success_status_and_real_receipt_validation(self):
        binding = dict(self.binding(), mode='readback')
        r = diag.client.r
        receipt = {name: 'c' * 64 for name in r.RETURN_FIELDS if name.endswith('Sha256')}
        receipt.update(version=1, scope=r.SCOPE, kind=r.KIND, status='ONLINE_RECHARGE_VERIFIED',
            producer=P, servicesUpdated=list(r.UPDATED), preservedServiceCount=len(r.PRESERVED),
            onlinePublished=True, migrationPerformed=False, databaseGrantsChanged=False,
            executionMigrationPlan=[], businessActions=0, volumeDeletionPerformed=False,
            runningImagesAndContentMatched=True, databaseOldGrantsPreserved=True, backupVerified=True,
            appliedDatabase={'online': {'status': 'APPLIED', 'schemaVerified': True},
                'connectionProfile': {'status': 'APPLIED', 'schemaVerified': True},
                'migrationPerformed': False, 'databaseGrantsChanged': False, 'migrationPlan': []},
            onlineGrants={'status': 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False})
        value = json.loads(self.native(binding, 'Success', ''))
        value.update(ResponseCode=0, StandardOutputContent=json.dumps(r.wire(receipt)))
        raw = json.dumps(value).encode()
        with patch.object(diag, 'read_command', return_value=raw) as read:
            result = diag.observe(binding)
        self.assertEqual(result['outcome'], 'VERIFIED_SUCCESS')
        self.assertEqual(result['status'], 'ONLINE_RECHARGE_COMPONENT_DIAGNOSTIC_VERIFIED')
        self.assertTrue(result['nativeAuthenticated'])
        self.assertFalse(result['serverRejected'])
        self.assertEqual(read.call_count, 1)
        self.assertEqual(result['nativeBytesSha256'], r.c.digest(raw))

    def test_real_preflight_success_without_release_environment_uses_authenticated_intent(self):
        with self.finite_parameters('preflight') as (_params, saved, instance, current):
            binding = dict(self.binding(), instanceId=instance, expectedCurrent=current)
            raw = base64.b64decode(json.loads(saved['preflight'])['invocationRawBase64'])
            with patch.dict(os.environ, {}, clear=True), patch.object(diag, 'read_command', return_value=raw) as read:
                self.assertNotIn('EXPECTED_CURRENT', os.environ)
                result = diag.observe(binding)
                self.assertNotIn('EXPECTED_CURRENT', os.environ)
            self.assertEqual(result['outcome'], 'VERIFIED_SUCCESS')
            self.assertTrue(result['nativeAuthenticated'])
            self.assertEqual(result['expectedCurrent'], current)
            self.assertEqual(result['nativeBytesSha256'], diag.client.r.c.digest(raw))
            self.assertFalse(result['automaticRetryAllowed'])
            read.assert_called_once_with(['aws', '--region', 'ap-northeast-1', 'ssm',
                'get-command-invocation', '--command-id', binding['commandId'],
                '--instance-id', instance, '--output', 'json'])

    def test_real_preflight_wrong_intent_predecessor_or_receipt_is_rejected_without_resend(self):
        with self.finite_parameters('preflight') as (_params, saved, instance, current):
            binding = dict(self.binding(), instanceId=instance, expectedCurrent=current)
            raw = base64.b64decode(json.loads(saved['preflight'])['invocationRawBase64'])
            receipt = json.loads(saved['preflight'])['serverReceipt']
            changed = copy.deepcopy(receipt)
            changed['baseline']['actualPredecessor']['commit'] = '0' * 40
            value = json.loads(raw)
            value['StandardOutputContent'] = json.dumps(diag.client.r.wire(changed))
            for selected, native in ((dict(binding, expectedCurrent='0' * 40), raw),
                                     (binding, json.dumps(value).encode())):
                with self.subTest(changed_intent=selected != binding), patch.dict(os.environ, {}, clear=True), \
                        patch.object(diag, 'read_command', return_value=native) as read:
                    result = diag.observe(selected)
                self.assertEqual(result['outcome'], 'AUTHENTICATION_REJECTED')
                self.assertFalse(result['nativeAuthenticated'])
                self.assertFalse(result['automaticRetryAllowed'])
                self.assertEqual(read.call_count, 1)
                self.assertEqual(read.call_args.args[0][4], 'get-command-invocation')

    def test_main_persists_only_closed_summary_and_never_raw_archive(self):
        binding = self.binding()
        with patch.object(diag, 'original_evidence', return_value=binding), \
                patch.object(diag, 'read_command', return_value=self.native(binding)), \
                patch.object(diag.client, 'output_directory', return_value=Path('/public-fixture')), \
                patch.object(diag.client, 'write_once') as write, redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(diag.main(['--evidence-run-id', '123', '--evidence-run-attempt', '1']), 0)
        self.assertTrue(write.call_args.args[1].name.startswith(diag.RESULT_PREFIX + '-123-1-'))
        result = write.call_args.args[2]
        self.assertEqual(result, json.loads(printed.getvalue()))
        for forbidden in ('invocationRawBase64', 'commands', 'parameters', 'serverReceipt', 'StandardOutputContent'):
            self.assertNotIn(forbidden, result)

    @contextmanager
    def main_private_io(self):
        root = HERE.parents[1]
        runtime = root / '.runtime'; runtime.mkdir(exist_ok=True)
        producer = dict(P, commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
            sourceTree=subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root).decode().strip())
        # Only fixture-generation seals are substituted. main's real artifact,
        # parameter, Git-object, native and private-file validators all execute.
        with self.finite_parameters('preflight', producer) as (params, saved, instance, current), \
                tempfile.TemporaryDirectory(prefix='online-diagnostic-observation-', dir=runtime) as temporary:
            binding = dict(self.binding(), producer=producer, expectedCurrent=current)
            f = {'params': params,
                'metadata': {'producer': producer, 'mode': 'preflight', 'commandId': binding['commandId'],
                    'instanceId': instance, 'status': 'ACCEPTED'},
                'intent': {'producer': producer, 'mode': 'preflight', 'expectedCurrent': current,
                    'parametersSha256': diag.client.r.c.fingerprint(params), 'status': 'SUBMITTING_ONCE'},
                'run': {'id': 123, 'run_attempt': 1, 'repository': {'full_name': diag.REPOSITORY},
                    'path': '.github/workflows/production-release.yml', 'event': 'workflow_dispatch',
                    'head_branch': 'main', 'status': 'completed', 'conclusion': 'failure', 'head_sha': producer['commit']},
                'job': {'id': 987, 'name': 'release', 'status': 'completed', 'conclusion': 'failure',
                    'head_sha': producer['commit'], 'steps': [{'name': 'Verify online recharge predecessor and idle workers before building',
                        'conclusion': 'failure'}]},
                'artifact': {'id': 654, 'expired': False, 'size_in_bytes': 100,
                    'name': 'online-recharge-evidence-123-1'}, 'additional': {}}
            def api_reply(endpoint):
                if '/commits/' in endpoint:
                    return {'sha': producer['commit'], 'commit': {'tree': {'sha': producer['sourceTree']}}}
                return self.api(f, endpoint)
            actual_read = diag.read_command
            responses = [self.native(binding, 'InProgress'),
                base64.b64decode(json.loads(saved['preflight'])['invocationRawBase64'])]
            aws = []
            def external_read(arguments, cap=128 * 1024):
                if arguments[0] == 'aws':
                    aws.append(arguments)
                    return responses[0]
                return actual_read(arguments, cap)  # Real bounded Git reads.
            previous = Path.cwd()
            os.chdir(temporary)
            try:
                with patch.object(diag, 'api', side_effect=api_reply), \
                        patch.object(diag, 'artifact_bytes', return_value=self.archive(f)), \
                        patch.object(diag, 'read_command', side_effect=external_read):
                    yield binding, Path(temporary) / '.deploy/production-release', responses, aws
            finally:
                os.chdir(previous)

    def test_main_real_private_io_retains_unknown_and_late_failed_observations(self):
        with self.main_private_io() as (binding, output, responses, aws), redirect_stdout(io.StringIO()):
            argv = ['--evidence-run-id', '123', '--evidence-run-attempt', '1']
            self.assertEqual(diag.main(argv), 1)
            first = next(output.glob(diag.RESULT_PREFIX + '-123-1-*.json'))
            raw = first.read_bytes(); identity = (first.stat().st_ino, first.stat().st_mtime_ns)
            self.assertEqual(json.loads(raw)['outcome'], 'RESULT_UNKNOWN')
            responses[0] = self.native(binding)
            self.assertEqual(diag.main(argv), 0)
            files = list(output.glob(diag.RESULT_PREFIX + '-123-1-*.json'))
            self.assertEqual(len(files), 2)
            self.assertEqual(first.read_bytes(), raw)
            self.assertEqual((first.stat().st_ino, first.stat().st_mtime_ns), identity)
            terminal = next(path for path in files if path != first)
            self.assertEqual(json.loads(terminal.read_bytes())['outcome'], 'COMMAND_FAILED')
            self.assertEqual(terminal.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(aws), 2)
            self.assertTrue(all(row[4] == 'get-command-invocation' and row[6] == binding['commandId'] for row in aws))

    def test_main_real_private_io_retains_unknown_and_late_preflight_success_without_release_environment(self):
        with self.main_private_io() as (binding, output, responses, aws), \
                patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()):
            argv = ['--evidence-run-id', '123', '--evidence-run-attempt', '1']
            self.assertNotIn('EXPECTED_CURRENT', os.environ)
            self.assertEqual(diag.main(argv), 1)
            first = next(output.glob(diag.RESULT_PREFIX + '-123-1-*.json'))
            raw = first.read_bytes(); identity = (first.stat().st_ino, first.stat().st_mtime_ns)
            self.assertEqual(json.loads(raw)['outcome'], 'RESULT_UNKNOWN')
            responses[0] = responses[1]
            self.assertEqual(diag.main(argv), 0)
            files = list(output.glob(diag.RESULT_PREFIX + '-123-1-*.json'))
            self.assertEqual(len(files), 2)
            self.assertEqual(first.read_bytes(), raw)
            self.assertEqual((first.stat().st_ino, first.stat().st_mtime_ns), identity)
            terminal = next(path for path in files if path != first)
            result = json.loads(terminal.read_bytes())
            self.assertEqual(result['outcome'], 'VERIFIED_SUCCESS')
            self.assertTrue(result['nativeAuthenticated'])
            self.assertEqual(result['expectedCurrent'], binding['expectedCurrent'])
            self.assertEqual(terminal.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(aws), 2)
            self.assertTrue(all(row[4] == 'get-command-invocation' and row[6] == binding['commandId'] for row in aws))
            self.assertNotIn('EXPECTED_CURRENT', os.environ)

    def test_main_real_private_io_identical_observation_reuses_original_inode(self):
        with self.main_private_io() as (binding, output, responses, aws), redirect_stdout(io.StringIO()):
            responses[0] = self.native(binding)
            argv = ['--evidence-run-id', '123', '--evidence-run-attempt', '1']
            self.assertEqual(diag.main(argv), 0)
            first = next(output.glob(diag.RESULT_PREFIX + '-123-1-*.json'))
            raw = first.read_bytes(); identity = (first.stat().st_ino, first.stat().st_mtime_ns)
            self.assertEqual(diag.main(argv), 0)
            self.assertEqual(list(output.glob(diag.RESULT_PREFIX + '-123-1-*.json')), [first])
            self.assertEqual(first.read_bytes(), raw)
            self.assertEqual((first.stat().st_ino, first.stat().st_mtime_ns), identity)
            self.assertEqual(len(aws), 2)
            self.assertIs(json.loads(raw)['automaticRetryAllowed'], False)


if __name__ == '__main__':
    unittest.main()
