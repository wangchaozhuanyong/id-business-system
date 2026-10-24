import ast
import base64
import copy
import fcntl
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import shlex
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('artifact_transport_test', HERE / 'release-artifact-retention-transport.py')
transport = importlib.util.module_from_spec(spec); spec.loader.exec_module(transport)
COMMON = transport.storage_module()
COMMIT, TREE, CURRENT = 'a' * 40, 'b' * 40, 'c' * 40
COMMAND = '00000000-0000-0000-0000-000000000001'


class ProjectTemporaryDirectory(tempfile.TemporaryDirectory):
    def __init__(self):
        directory = transport.PROJECT / '.runtime/disk-retention-20261014'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        super().__init__(prefix='release-artifact-transport-', dir=directory)


def environment(operation='verify', approval=''):
    return {'RELEASE_ARTIFACT_RETENTION_OPERATION': operation, 'RELEASE_ARTIFACT_RETENTION_PLAN_SHA256': approval,
            'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'GITHUB_RUN_ID': '900', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '800', 'EXPECTED_CURRENT': CURRENT, 'GITHUB_REF': 'refs/heads/main',
            'GITHUB_REPOSITORY': transport.GITHUB_REPOSITORY, 'AWS_REGION': transport.REGION,
            'PRODUCTION_INSTANCE_ID': transport.INSTANCE, 'RELEASE_REPOSITORY': transport.REPOSITORY,
            'RELEASE_ACCOUNT_ID': transport.ACCOUNT}


def binding(operation='verify', actual=False):
    values = {path: (transport.PROJECT / path).read_bytes() if actual else path.encode() for path in transport.PATHS}
    value = {'kind': 'ID_RELEASE_ARTIFACT_RETENTION_BINDING_V1', 'version': 1,
             **transport.selection(environment(operation, 'd' * 64 if operation != 'verify' else '')),
             'sourcePins': {path: {'sha256': transport.sha(raw), 'bytes': len(raw)} for path, raw in values.items()}}
    transport.validate_binding(value)
    return value


def file_identity(size, mode=0o600):
    return {'device': 1, 'inode': 2, 'mode': mode, 'uid': 0, 'gid': 0, 'links': 1,
            'bytes': size, 'mtimeNs': 100, 'ctimeNs': 101}


def probe():
    return {'currentCommit': CURRENT, 'currentRelease': str(transport.BASE / 'releases' / ('20261014T000000Z-' + CURRENT[:12])),
            'currentManifestSha256': 'f' * 64, 'currentPointerIdentity': file_identity(30, 0o777), 'containers': []}


def plan(value):
    return {'kind': 'ID_RELEASE_ARTIFACT_PLAN_V1', 'version': 1, 'relativePath': transport.RELATIVE,
            'currentCommit': CURRENT, 'sourceProbe': probe(),
            'files': {name: {'sha256': pin['sha256'], 'identity': file_identity(pin['bytes'])}
                      for name, pin in transport.FILE_PINS.items()},
            'targetSha256': 'e' * 64, 'cloudProofSha256': value['sourcePins'][transport.PROOF_PATH]['sha256'],
            'minimumRecoveryDays': 14, 'requiredFreeBytes': transport.FILE_PINS[transport.PACKAGE]['bytes'] + 2 * 1024**3}


def native(value, planned, operation='plan'):
    checksum = transport.digest(planned)
    result = {'kind': 'ID_RELEASE_ARTIFACT_RESULT_V1', 'version': 1, 'operation': operation,
              'status': {'plan': 'PLAN_ONLY', 'apply': 'APPLIED', 'restore': 'RESTORED'}[operation],
              'planSha256': checksum, 'relativePath': transport.RELATIVE,
              'packageBytes': transport.FILE_PINS[transport.PACKAGE]['bytes'],
              'currentUnchanged': True, 'containersUnchanged': True, 'metadataUnchanged': True,
              'removed': operation == 'apply'}
    if operation == 'restore':
        result.update(restoredSha256=transport.FILE_PINS[transport.PACKAGE]['sha256'], fullRecoveryVerified=True,
                      receiptFile=str(transport.RECEIPTS / (checksum + '-123.restore.json')))
        return result
    result.update(planFile=str(transport.RECEIPTS / (checksum + '.plan.json')),
                  requiredFreeBytes=planned['requiredFreeBytes'], sourceProbeSha256=transport.digest(planned['sourceProbe']),
                  targetSha256=planned['targetSha256'], cloudProofSha256=planned['cloudProofSha256'], minimumRecoveryDays=14)
    if operation == 'apply':
        result.update(fullRecoveryVerified=True, recoveryIndexSha256='a' * 64, recoveryObjectSha256='b' * 64,
                      freeBytesBefore=10 * 1024**3, freeBytesAfter=12 * 1024**3,
                      recoveryFile=str(transport.RECEIPTS / (checksum + '.recovery.json')),
                      receiptFile=str(transport.RECEIPTS / (checksum + '-123.result.json')))
    return result


def result(value):
    planned = plan(value)
    if value['operation'] != 'verify':
        value['planSha256'] = transport.digest(planned)
    operation = {'verify': 'plan', 'archive': 'apply', 'restore': 'restore'}[value['operation']]
    return transport.complete_result(value, native(value, planned, operation), planned, probe())


def acceptance():
    return {'Command': {'CommandId': COMMAND, 'InstanceIds': [transport.INSTANCE], 'DocumentName': 'AWS-RunShellScript'}}


def invocation(value, body=None):
    return {'CommandId': COMMAND, 'InstanceId': transport.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
            'StandardOutputContent': json.dumps(transport.wire(value, body or result(value)))}


class BindingTests(unittest.TestCase):
    def test_three_operations_and_exact_approval_are_closed(self):
        for operation in transport.OPERATIONS:
            self.assertEqual(transport.selection(environment(operation, 'd' * 64 if operation != 'verify' else ''))['operation'], operation)
        for operation, approved in (('verify', 'd' * 64), ('archive', ''), ('restore', 'wrong'), ('cleanup', 'd' * 64)):
            with self.subTest(operation=operation), self.assertRaises(transport.Rejected):
                transport.selection(environment(operation, approved))

    def test_foreign_account_instance_region_repo_branch_and_attempt_two_are_rejected(self):
        for field, altered in (('RELEASE_ACCOUNT_ID', '999999999999'), ('PRODUCTION_INSTANCE_ID', 'i-other'),
                               ('AWS_REGION', 'us-east-1'), ('RELEASE_REPOSITORY', 'other'),
                               ('GITHUB_REPOSITORY', 'other/project'), ('GITHUB_REF', 'refs/heads/other'),
                               ('GITHUB_RUN_ATTEMPT', '2'), ('SOURCE_TREE', TREE + ';bad'), ('QUALITY_RUN_ID', '0')):
            value = environment(); value[field] = altered
            with self.subTest(field=field), self.assertRaises(transport.Rejected): transport.selection(value)

    def test_binding_unknown_fields_operation_and_partial_source_pins_fail(self):
        mutations = (lambda v: v.update(extra=True), lambda v: v.update(kind='ID_DISK_MAINTENANCE_BINDING_V1'),
                     lambda v: v['producer'].update(workflowRunAttempt='2'), lambda v: v['sourcePins'].pop(transport.PROOF_PATH),
                     lambda v: v['target'].update(accountId='other'), lambda v: v.update(version=True))
        for mutate in mutations:
            value = binding(); mutate(value)
            with self.assertRaises(transport.Rejected): transport.validate_binding(value)

    def test_real_source_binding_checks_current_main_quality_and_every_git_blob(self):
        commands = Mock()
        def git(mode, revision, *extra, **kwargs):
            if mode == 'show': return 0, (transport.PROJECT / revision.split(':', 1)[1]).read_bytes()
            if mode == 'ls-remote': return 0, (COMMIT + '\trefs/heads/main\n').encode()
            return 0, ((TREE if revision == 'HEAD^{tree}' else COMMIT) + '\n').encode()
        commands.git.side_effect = git
        commands.quality.return_value = {'id': 800, 'head_sha': COMMIT, 'head_branch': 'main', 'event': 'push',
            'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/quality.yml'}
        with patch.object(transport, 'storage_module', return_value=COMMON):
            value, sources = transport.source_binding(transport.selection(environment()), commands)
        self.assertEqual(set(sources), set(transport.PATHS)); self.assertEqual(commands.git.call_count, 3 + len(transport.SOURCE_PATHS))
        for path in transport.PATHS: self.assertEqual(value['sourcePins'][path]['sha256'], transport.sha(sources[path]))
        commands.quality.return_value['conclusion'] = 'failure'
        with patch.object(transport, 'storage_module', return_value=COMMON), self.assertRaises(COMMON.StorageRejected):
            transport.source_binding(transport.selection(environment()), commands)

    def test_dirty_native_proof_transport_or_shared_runtime_source_never_gets_binding(self):
        for path in transport.SOURCE_PATHS:
            commands = Mock()
            commands.git.side_effect = lambda mode, ref, **kwargs: (0, b'drift' if ref.endswith(':' + path)
                else (transport.PROJECT / ref.split(':', 1)[1]).read_bytes())
            with self.subTest(path=path), patch.object(COMMON, 'verify_source'), \
                 patch.object(transport, 'storage_module', return_value=COMMON), self.assertRaisesRegex(transport.Rejected, 'GIT_SOURCE_CHANGED'):
                transport.source_binding(transport.selection(environment()), commands)


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = ProjectTemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name); (self.base / '.staging').mkdir(mode=0o700)
        (self.base / '.deploy.lock').write_bytes(b'lock'); (self.base / '.deploy.lock').chmod(0o600)
        self.value = binding(); self.owner = os.geteuid()

    def stage(self, path=transport.NATIVE_PATH, payload=None):
        payload = payload if payload is not None else base64.b64encode(lzma.compress(path.encode())).decode()
        with patch.object(transport, 'snapshot', return_value=probe()):
            return transport.stage_file(self.value, path, payload, base=self.base, owner=self.owner)

    def test_exact_bytes_private_directories_files_and_idempotent_reuse(self):
        for path in transport.PATHS:
            ack = self.stage(path); transport.validate_ack(ack, self.value, path)
            target = transport.stage_root(self.value, self.base) / path
            self.assertEqual(target.read_bytes(), path.encode()); self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            for directory in (target.parent, transport.stage_root(self.value, self.base)):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertTrue(self.stage(path)['reused'])

    def test_unknown_file_hardlink_symlink_and_wrong_mode_are_never_overwritten(self):
        self.stage(); target = transport.stage_root(self.value, self.base) / transport.NATIVE_PATH
        target.write_bytes(b'unknown')
        with self.assertRaisesRegex(transport.Rejected, 'UNKNOWN_STAGE_TARGET'): self.stage()
        self.assertEqual(target.read_bytes(), b'unknown')
        target.unlink(); external = self.base / 'external'; external.write_bytes(transport.NATIVE_PATH.encode()); external.chmod(0o600)
        os.link(external, target)
        with self.assertRaises(transport.Rejected): self.stage()
        target.unlink(); target.symlink_to(external)
        with self.assertRaises(transport.Rejected): self.stage()
        target.unlink(); self.stage(); target.chmod(0o644)
        with self.assertRaisesRegex(transport.Rejected, 'FILE_MODE'): self.stage()

    def test_busy_deploy_lock_and_drifted_full_container_snapshot_fail(self):
        with (self.base / '.deploy.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.stage()
        after = probe(); after['containers'] = [{'unknownStoppedContainer': True}]
        with patch.object(transport, 'snapshot', side_effect=[probe(), after]), self.assertRaisesRegex(transport.Rejected, 'STAGE_STATE_CHANGED'):
            transport.stage_file(self.value, transport.NATIVE_PATH, transport.NATIVE_PATH.encode(), base=self.base, owner=self.owner)

    def test_bad_hash_trailing_compression_unknown_scope_and_untrusted_parent_fail(self):
        with self.assertRaises(transport.Rejected): self.stage(payload=base64.b64encode(lzma.compress(b'wrong')).decode())
        with self.assertRaises(transport.Rejected): self.stage(payload=base64.b64encode(lzma.compress(transport.NATIVE_PATH.encode()) + b'append').decode())
        with self.assertRaises(transport.Rejected): self.stage(path='scripts/other.py')
        (self.base / '.staging').chmod(0o777)
        with self.assertRaisesRegex(transport.Rejected, 'STAGE_PARENT'): self.stage()


class ContainerSnapshotTests(unittest.TestCase):
    def test_current_and_all_running_stopped_containers_use_safe_real_template_and_mount_projection(self):
        with ProjectTemporaryDirectory() as directory:
            base = Path(directory); release = base / 'releases' / ('20261014T000000Z-' + CURRENT[:12])
            release.mkdir(parents=True); manifest = release / 'release-manifest.json'
            manifest.write_bytes(transport.canonical({'commit': CURRENT})); manifest.chmod(0o600)
            (base / 'current').symlink_to(release)
            rows = []
            for identifier, state in (('1' * 64, 'running'), ('2' * 64, 'exited')):
                rows.append({'id': identifier, 'imageId': 'sha256:' + 'd' * 64, 'reference': 'public/reference:immutable',
                    'running': state == 'running', 'state': state, 'startedAt': '2026-10-14T00:00:00Z',
                    'restartCount': 0, 'health': 'healthy' if state == 'running' else None,
                    'mounts': [{'Type': 'bind', 'Source': '/opt/private', 'Destination': '/app/data', 'RW': True},
                               {'Type': 'tmpfs', 'Source': '', 'Destination': '/tmp'}]})
            raw = b'\n'.join(transport.canonical(row) for row in rows)
            with patch.object(transport, 'command', side_effect=[b'\n'.join(row['id'].encode() for row in rows), raw]) as command:
                observed = transport.snapshot(CURRENT, base, os.geteuid())
            self.assertEqual(len(observed['containers']), 2); self.assertEqual(observed['containers'][1]['state'], 'exited')
            template = command.call_args_list[1].args[0][3]
            self.assertIn('"mounts":{{json .Mounts}}', template)
            self.assertIn('{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}', template)
            self.assertNotIn('.State.Health', template); self.assertNotIn('.Config.Env', template)
            self.assertEqual(command.call_args_list[0].args[0], ['docker', 'ps', '-a', '--no-trunc', '--quiet'])
            self.assertEqual(observed['containers'][0]['mounts'][0], {'type': 'bind', 'source': '/opt/private', 'destination': '/app/data'})

    def test_duplicate_or_unclassified_all_container_identity_fails_closed(self):
        with ProjectTemporaryDirectory() as directory:
            base = Path(directory); release = base / 'releases' / ('20261014T000000Z-' + CURRENT[:12])
            release.mkdir(parents=True); manifest = release / 'release-manifest.json'
            manifest.write_bytes(transport.canonical({'commit': CURRENT})); manifest.chmod(0o600)
            (base / 'current').symlink_to(release)
            with patch.object(transport, 'command', return_value=('1' * 64 + '\n' + '1' * 64).encode()), \
                 self.assertRaisesRegex(transport.Rejected, 'CONTAINER_INVALID'):
                transport.snapshot(CURRENT, base, os.geteuid())


class PlanWireTests(unittest.TestCase):
    def test_complete_plan_summary_roundtrip_and_no_plain_bucket_pointer(self):
        value = binding(); output = result(value); packed = transport.wire(value, output)
        self.assertEqual(transport.decode_wire(packed, value), output)
        self.assertIs(transport.validate_result(output, value), output)
        self.assertNotIn('bucket', transport.canonical(packed).decode()); self.assertLessEqual(len(transport.canonical(packed)), transport.MAX_WIRE)

    def test_wire_unknown_schema_wrong_kind_producer_and_trailing_gzip_fail(self):
        value = binding(); packed = transport.wire(value, result(value))
        mutations = (lambda v: v.update(extra=True), lambda v: v.update(kind='ID_DISK_MAINTENANCE_WIRE_V1'),
                     lambda v: v['producer'].update(workflowRunAttempt='2'), lambda v: v.update(bodyBytes=True),
                     lambda v: v.update(bodySha256='0' * 64), lambda v: v.update(payload=base64.b64encode(base64.b64decode(v['payload']) + b'extra').decode()))
        for mutate in mutations:
            modified = copy.deepcopy(packed); mutate(modified)
            with self.assertRaises(transport.Rejected): transport.decode_wire(modified, value)

    def test_plan_wrong_scope_pin_cloud_minimum_and_unknown_protection_fields_fail(self):
        value = binding()
        mutations = (lambda v: v.update(relativePath='artifacts/another/package'), lambda v: v.update(extra=True),
                     lambda v: v.update(minimumRecoveryDays=13), lambda v: v.update(cloudProofSha256='0' * 64),
                     lambda v: v['files'][transport.PACKAGE]['identity'].update(links=2),
                     lambda v: v['files'][transport.PACKAGE].update(sha256='0' * 64),
                     lambda v: v['sourceProbe'].update(unapproved=True))
        for mutate in mutations:
            planned = plan(value); mutate(planned)
            with self.assertRaises(transport.Rejected): transport.validate_plan(planned, value, transport.digest(planned))

    def test_claimed_published_mutated_summary_and_mismatched_apply_digest_fail(self):
        for field, altered in (('currentUnchanged', False), ('containersUnchanged', False), ('status', 'INSTALLED'), ('websiteServicesChanged', True)):
            value = binding(); output = result(value); output[field] = altered
            with self.assertRaises(transport.Rejected): transport.validate_result(output, value)
        value = binding('archive'); output = result(value); value['planSha256'] = '0' * 64
        with self.assertRaisesRegex(transport.Rejected, 'APPROVED_PLAN_CHANGED'): transport.validate_result(output, value)

    def test_only_restore_accepts_unchanged_historical_archive_plan_after_live_release_changes(self):
        value = binding('restore'); archived = plan(value); archived_bytes = transport.canonical(archived)
        approved = transport.digest(archived); value['planSha256'] = approved; value['expectedCurrent'] = '9' * 40
        live = probe(); live['currentCommit'] = value['expectedCurrent']
        live['currentRelease'] = str(transport.BASE / 'releases' / ('20261015T000000Z-' + value['expectedCurrent'][:12]))
        output = transport.complete_result(value, native(value, archived, 'restore'), archived, live)
        self.assertIs(transport.validate_result(output, value), output)
        self.assertEqual(output['planSha256'], approved)
        self.assertEqual(transport.canonical(archived), archived_bytes)
        self.assertEqual(output['plan']['currentCommit'], CURRENT)
        self.assertEqual(output['sourceProbe']['currentCommit'], value['expectedCurrent'])
        for operation in ('verify', 'archive'):
            current_binding = binding(operation); current_binding['expectedCurrent'] = value['expectedCurrent']
            with self.subTest(operation=operation), self.assertRaisesRegex(transport.Rejected, 'PLAN_BINDING_CHANGED'):
                transport.validate_plan(archived, current_binding, approved)

    def test_restore_rejects_malformed_or_inconsistent_history_and_original_plan_digest_drift(self):
        value = binding('restore'); value['expectedCurrent'] = '9' * 40
        mutations = (lambda p: p.update(currentCommit='invalid'), lambda p: p.update(currentCommit=123),
                     lambda p: p['sourceProbe'].update(currentCommit='8' * 40),
                     lambda p: p['sourceProbe'].update(currentRelease=str(transport.BASE / 'releases' / ('20261014T000000Z-' + '8' * 12))))
        for mutate in mutations:
            archived = plan(value); mutate(archived)
            with self.subTest(mutate=mutate), self.assertRaises(transport.Rejected):
                transport.validate_plan(archived, value, transport.digest(archived))
        archived = plan(value); approved = transport.digest(archived); archived['targetSha256'] = '0' * 64
        with self.assertRaisesRegex(transport.Rejected, 'PLAN_BINDING_CHANGED'):
            transport.validate_plan(archived, value, approved)

    def test_actual_sources_and_all_operations_fit_the_real_ssm_payload_budget(self):
        for operation in transport.OPERATIONS:
            value = binding(operation, actual=True)
            for path in transport.PATHS:
                raw = (transport.PROJECT / path).read_bytes()
                parameters = transport.remote_program(value, path=path, payload=base64.b64encode(lzma.compress(raw)).decode())
                self.assertLessEqual(len(parameters['commands'][0].encode()), 19500)
                command = shlex.split(parameters['commands'][0]); self.assertEqual(command[:3], ['python3', '-B', '-c'])
                syntax = ast.parse(command[3])
                packed = next(node.args[0].value for node in ast.walk(syntax) if isinstance(node, ast.Call)
                              and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode')
                program = lzma.decompress(base64.b64decode(packed)).decode()
                compile(program, '<actual-stage-program>', 'exec')
                self.assertIn(repr(raw), program); self.assertNotIn('__file__=', program)
            parameters = transport.remote_program(value)
            self.assertLessEqual(len(parameters['commands'][0].encode()), 19500)
            self.assertEqual(parameters['executionTimeout'], ['1500'])

    def test_actual_command_is_rejected_if_payload_budget_is_too_small(self):
        with patch.object(transport, 'MAX_COMMAND', 100), self.assertRaisesRegex(transport.Rejected, 'SSM_COMMAND_BOUND'):
            transport.remote_program(binding())

    def test_plan_private_real_path_requires_exact_digest_and_file_mode(self):
        value = binding(); planned = plan(value); checksum = transport.digest(planned)
        private = transport.RECEIPTS / (checksum + '.plan.json')
        with patch.object(transport, 'receipt_path', return_value=private), \
             patch.object(transport, 'regular', return_value=(transport.canonical(planned), None)) as reading:
            self.assertEqual(transport.read_plan(value, checksum, str(private)), planned)
            reading.assert_called_once_with(private, transport.MAX_BODY, mode=0o600)
        with self.assertRaises(transport.Rejected): transport.receipt_path('/tmp/untrusted.plan.json', checksum + '.plan.json')
        with patch.object(transport, 'receipt_path', return_value=private), \
             patch.object(transport, 'regular', return_value=(transport.canonical(planned), None)), self.assertRaisesRegex(transport.Rejected, 'PLAN_BINDING_CHANGED'):
            transport.read_plan(value, '0' * 64)


class SsmTests(unittest.TestCase):
    def setUp(self):
        self.temporary = ProjectTemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name); self.directory.chmod(0o700)
        self.value = binding(); self.parameters = transport.remote_program(self.value); self.commands = Mock()

    def client(self, **kwargs):
        return transport.SsmClient(self.commands, self.directory, sleep=lambda _: None, **kwargs)

    def test_success_records_intent_acceptance_private_wire_and_reuses_receipt_without_resend(self):
        self.commands.aws.side_effect = [[], acceptance(), invocation(self.value)]
        expected = self.client().execute('operation', self.parameters, self.value)
        self.assertEqual(expected['status'], 'PLAN_ONLY')
        for path in self.directory.iterdir(): self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.commands.aws.reset_mock()
        self.assertEqual(self.client().execute('operation', self.parameters, self.value), expected)
        self.commands.aws.assert_not_called()

    def test_busy_foreign_command_blocks_before_intent_or_send(self):
        self.commands.aws.return_value = [{'CommandId': COMMAND, 'Status': 'InProgress', 'InstanceIds': [transport.INSTANCE]}]
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_COMMAND_UNSETTLED'):
            self.client().execute('operation', self.parameters, self.value)
        self.assertEqual(self.commands.aws.call_count, 1); self.assertFalse((self.directory / 'operation.intent.json').exists())

    def test_unknown_send_result_records_intent_and_never_sends_again(self):
        self.commands.aws.side_effect = [[], RuntimeError('secret-aws-stderr')]
        with self.assertRaises(RuntimeError): self.client().execute('operation', self.parameters, self.value)
        self.commands.aws.reset_mock()
        with self.assertRaisesRegex(transport.Rejected, 'UNKNOWN_RECONCILIATION'):
            self.client().execute('operation', self.parameters, self.value)
        self.commands.aws.assert_not_called(); self.assertNotIn('secret', (self.directory / 'operation.intent.json').read_text())

    def test_accepted_pending_reconciles_the_same_command_and_never_resends(self):
        self.commands.aws.side_effect = [[], acceptance(), {'Status': 'Pending'}]
        with self.assertRaisesRegex(transport.Rejected, 'ACCEPTED_RESULT_PENDING'):
            self.client(monotonic=Mock(side_effect=[0, 1, 2000])).execute('operation', self.parameters, self.value)
        self.commands.aws.reset_mock(); self.commands.aws.side_effect = [invocation(self.value)]
        self.assertEqual(self.client().execute('operation', self.parameters, self.value)['status'], 'PLAN_ONLY')
        self.assertEqual(self.commands.aws.call_count, 1)
        self.assertEqual(self.commands.aws.call_args.args[:2], ('ssm', 'get-command-invocation'))

    def test_failure_receipt_is_saved_before_raising_and_stderr_env_are_suppressed(self):
        failed = invocation(self.value); failed.update(Status='Failed', ResponseCode=1,
            StandardOutputContent='untrusted secret output', StandardErrorContent='password token private environment')
        self.commands.aws.side_effect = [[], acceptance(), failed]
        with self.assertRaisesRegex(transport.Rejected, 'REMOTE_TERMINAL_FAILED'):
            self.client().execute('operation', self.parameters, self.value)
        saved = json.loads((self.directory / 'operation.result.json').read_text())
        self.assertEqual(saved['commandId'], COMMAND); self.assertEqual(saved['originalReceipt']['Status'], 'Failed')
        self.assertEqual(saved['invocationCanonicalSha256'], transport.digest(failed))
        self.assertNotIn('password', json.dumps(saved)); self.assertNotIn('untrusted secret', json.dumps(saved))
        self.commands.aws.reset_mock()
        with self.assertRaisesRegex(transport.Rejected, 'PRIOR_TERMINAL_FAILED'):
            self.client().execute('operation', self.parameters, self.value)
        self.commands.aws.assert_not_called()

    def test_success_with_stderr_cannot_become_success_receipt(self):
        failed = invocation(self.value); failed['StandardErrorContent'] = 'secret'
        self.commands.aws.side_effect = [[], acceptance(), failed]
        with self.assertRaises(transport.Rejected): self.client().execute('operation', self.parameters, self.value)
        self.assertEqual(json.loads((self.directory / 'operation.result.json').read_text())['status'], 'Failed')

    def test_wrong_accepted_target_or_wire_binding_cannot_return_success(self):
        wrong = acceptance(); wrong['Command']['InstanceIds'] = ['i-other']
        self.commands.aws.side_effect = [[], wrong]
        with self.assertRaisesRegex(transport.Rejected, 'ACCEPTANCE_INVALID'):
            self.client().execute('operation', self.parameters, self.value)
        self.assertTrue((self.directory / 'operation.intent.json').exists())


class NativeOperationTests(unittest.TestCase):
    def setUp(self):
        self.value = binding(); self.planned = plan(self.value); self.before = probe()
        self.directory_info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)

    def native_run(self, operation='verify', mutate=None, snapshots=None, budget=None):
        self.value['operation'] = operation
        self.value['planSha256'] = transport.digest(self.planned) if operation != 'verify' else None
        planned_summary = native(self.value, self.planned)
        final = native(self.value, self.planned, 'restore' if operation == 'restore' else 'apply')
        if mutate: mutate(planned_summary, final)
        recovery = {'kind': 'ID_RELEASE_ARTIFACT_RECOVERY_V1', 'planSha256': transport.digest(self.planned), 'plan': self.planned}
        recovery_raw = transport.canonical(recovery)
        final['recoveryIndexSha256'] = transport.sha(recovery_raw) if operation == 'archive' else final.get('recoveryIndexSha256')
        if operation == 'restore': final.pop('recoveryIndexSha256', None)
        outputs = [final] if operation == 'restore' else [planned_summary] + ([final] if operation == 'archive' else [])
        processes = [SimpleNamespace(returncode=0, stderr=b'', stdout=transport.canonical(output)) for output in outputs]
        def regular(path, *args, **kwargs):
            path = Path(path)
            for source in transport.PATHS:
                if path == transport.stage_root(self.value) / source: return source.encode(), None
            if path == transport.RECEIPTS / (transport.digest(self.planned) + '.plan.json'):
                return transport.canonical(self.planned), None
            if path == transport.RECEIPTS / (transport.digest(self.planned) + '.recovery.json'): return recovery_raw, None
            return transport.canonical({key: value for key, value in final.items() if key != 'receiptFile'}), None
        with patch.object(transport.os, 'geteuid', return_value=0), \
             patch.object(Path, 'lstat', return_value=self.directory_info), patch.object(transport, 'regular', side_effect=regular), \
             patch.object(transport, 'snapshot', side_effect=snapshots or [self.before] * (3 if operation != 'verify' else 2)) as observing, \
             patch.object(transport, 'receipt_path', side_effect=lambda path, *args: Path(path)), \
             patch.object(transport.subprocess, 'run', side_effect=processes) as running, \
             patch.object(transport, 'apply_receipt_budget', side_effect=budget, wraps=transport.apply_receipt_budget) as checking:
            self.running = running
            self.observing = observing
            output = transport.execute_native(self.value)
        return output, running, checking

    def test_verify_runs_the_actual_private_native_path_and_uses_closed_plan(self):
        output, running, checking = self.native_run()
        transport.validate_result(output, self.value); checking.assert_not_called()
        arguments = running.call_args.args[0]
        self.assertEqual(arguments[:4], ['python3', '-B', str(transport.stage_root(self.value) / transport.NATIVE_PATH), 'plan'])
        self.assertIn('--expected-source-sha256', arguments); self.assertIn('--cloud-proof-json', arguments)
        self.assertNotIn('--approved-plan-sha256', arguments); self.assertNotIn('-c', arguments)

    def test_archive_requires_preflight_budget_full_snapshot_and_real_result_receipts(self):
        output, running, checking = self.native_run('archive')
        transport.validate_result(output, self.value); self.assertEqual(running.call_count, 2); checking.assert_called_once()
        self.assertEqual(running.call_args_list[1].args[0][3], 'apply')
        self.assertEqual(running.call_args_list[1].args[0][-2:], ['--approved-plan-sha256', self.value['planSha256']])

    def test_restore_reads_original_plan_and_only_calls_restore_without_public_recovery_index(self):
        output, running, checking = self.native_run('restore')
        transport.validate_result(output, self.value); self.assertEqual(running.call_count, 1); checking.assert_called_once()
        self.assertEqual(running.call_args.args[0][3], 'restore'); self.assertNotIn('target', output)

    def test_restore_preserves_archive_a_approval_while_cli_and_all_snapshots_protect_live_b(self):
        archived_bytes = transport.canonical(self.planned); approved = transport.digest(self.planned)
        self.value['expectedCurrent'] = '9' * 40
        self.before['currentCommit'] = self.value['expectedCurrent']
        self.before['currentRelease'] = str(transport.BASE / 'releases' / ('20261015T000000Z-' + self.value['expectedCurrent'][:12]))
        self.before['containers'] = [{'id': '7' * 64, 'imageId': 'sha256:' + '8' * 64,
            'reference': 'public/live-b:immutable', 'running': False, 'state': 'exited',
            'startedAt': '2026-10-15T00:00:00Z', 'restartCount': 0, 'health': None, 'mounts': []}]
        output, running, checking = self.native_run('restore')
        transport.validate_result(output, self.value)
        self.assertEqual(transport.canonical(self.planned), archived_bytes)
        self.assertEqual(output['planSha256'], approved); self.assertEqual(output['plan']['currentCommit'], CURRENT)
        self.assertEqual(output['sourceProbe'], self.before); self.assertEqual(running.call_count, 1)
        arguments = running.call_args.args[0]
        self.assertEqual(arguments[arguments.index('--expected-current') + 1], '9' * 40)
        self.assertEqual(arguments[-2:], ['--approved-plan-sha256', approved])
        self.assertEqual([call.args[0] for call in self.observing.call_args_list], ['9' * 40] * 3)
        self.assertEqual([call.kwargs['context'] for call in self.observing.call_args_list],
                         ['OPERATION_BEFORE', 'OPERATION_PREAPPLY', 'OPERATION_AFTER'])
        self.assertEqual(checking.call_args.args[3], self.before)

    def test_restore_stops_if_live_b_current_or_containers_change_before_or_after_native_restore(self):
        self.value['expectedCurrent'] = '9' * 40
        self.before['currentCommit'] = self.value['expectedCurrent']
        self.before['currentRelease'] = str(transport.BASE / 'releases' / ('20261015T000000Z-' + self.value['expectedCurrent'][:12]))
        for field in ('currentManifestSha256', 'containers'):
            changed = copy.deepcopy(self.before)
            changed[field] = '0' * 64 if field == 'currentManifestSha256' else [{'newStoppedContainer': True}]
            for phase, snapshots in (('before', [self.before, changed]), ('after', [self.before, self.before, changed])):
                with self.subTest(field=field, phase=phase), self.assertRaisesRegex(transport.Rejected, 'PRODUCTION_CHANGED'):
                    self.native_run('restore', snapshots=snapshots)
                self.assertEqual(self.running.call_count, 0 if phase == 'before' else 1)

    def test_failed_budget_or_changed_preapply_state_never_invokes_apply(self):
        with self.assertRaisesRegex(transport.Rejected, 'BUDGET'):
            self.native_run('archive', budget=transport.Rejected('ARTIFACT_APPLY_RECEIPT_BUDGET'))
        self.assertEqual(self.running.call_count, 1)
        changed = copy.deepcopy(self.before); changed['currentManifestSha256'] = '0' * 64
        with self.assertRaisesRegex(transport.Rejected, 'PRODUCTION_CHANGED'):
            self.native_run('archive', snapshots=[self.before, changed])
        self.assertEqual(self.running.call_count, 1)

    def test_claimed_native_mutation_and_incorrect_plan_digest_fail_before_apply(self):
        with self.assertRaisesRegex(transport.Rejected, 'NATIVE_RESULT_INVALID'):
            self.native_run('archive', mutate=lambda planned, final: planned.update(containersUnchanged=False))
        with self.assertRaisesRegex(transport.Rejected, 'PLAN_BINDING_CHANGED'):
            self.native_run('archive', mutate=lambda planned, final: planned.update(planSha256='0' * 64))

    def test_actual_receipt_budget_has_reserved_headroom(self):
        self.value['operation'] = 'archive'; self.value['planSha256'] = transport.digest(self.planned)
        transport.apply_receipt_budget(self.value, native(self.value, self.planned), self.planned, self.before)
        with patch.object(transport, 'MAX_WIRE', 100), self.assertRaises(transport.Rejected):
            transport.apply_receipt_budget(self.value, native(self.value, self.planned), self.planned, self.before)


class WorkflowTests(unittest.TestCase):
    def test_source_quality_selection_oidc_target_and_operation_order_are_exact(self):
        text = (transport.PROJECT / '.github/workflows/release-artifact-retention.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', text); self.assertIn('cancel-in-progress: false', text)
        self.assertIn("if: github.ref == 'refs/heads/main'", text); self.assertIn('role-duration-seconds: 3600', text)
        self.assertIn("RELEASE_ACCOUNT_ID: '098208446664'", text); self.assertIn('role/id-business-v2-github-release', text)
        source = text.index('run: bash scripts/production-release/check-source.sh')
        selection = text.index('release-artifact-retention-transport.py --validate-only')
        credentials = text.index('uses: aws-actions/configure-aws-credentials@')
        identity = text.index('aws sts get-caller-identity --query Account')
        execute = text.index('run: python3 -B scripts/production-release/release-artifact-retention-transport.py\n')
        self.assertLess(source, selection); self.assertLess(selection, credentials); self.assertLess(credentials, identity); self.assertLess(identity, execute)
        self.assertIn('describe-instance-information', text); self.assertIn('if: always()', text)
        self.assertIn('include-hidden-files: true', text); self.assertIn('retention-days: 30', text)
        for forbidden in ('docker pull', 'docker build', 'prisma', 'deploy.sh', 'production-release.yml', 'systemctl'):
            self.assertNotIn(forbidden, text)
        self.assertEqual([line.strip()[2:] for line in text.splitlines() if line.startswith('          - ')], list(transport.OPERATIONS))

    def test_stdout_suppresses_plan_bucket_recovery_paths_and_process_exception(self):
        value = binding('archive'); output = result(value)
        with patch.object(transport, 'execute', return_value=output), patch('sys.stdout', new_callable=io.StringIO) as stream:
            self.assertEqual(transport.main([]), 0)
        summary = json.loads(stream.getvalue()); self.assertEqual(summary['status'], 'APPLIED')
        for forbidden in ('sourceProbe', 'planFile', 'recoveryFile', 'nativeResult', 'bucket', 'targetSha256'):
            self.assertNotIn(forbidden, summary)
        with patch.object(transport, 'execute', side_effect=RuntimeError('password=secret')), \
             patch('sys.stdout', new_callable=io.StringIO) as stream:
            self.assertEqual(transport.main([]), 1)
            self.assertNotIn('secret', stream.getvalue()); self.assertEqual(json.loads(stream.getvalue())['code'], 'ARTIFACT_FAILED_CLOSED')


if __name__ == '__main__':
    unittest.main()
