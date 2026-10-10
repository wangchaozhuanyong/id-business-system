"""Isolated synthetic fixtures only; no AWS/Docker/Git/production execution."""
from pathlib import Path
import ast
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
SOURCE = HERE if (HERE / 'api-admin-readonly.py').is_file() else Path(__file__).parents[5] / 'scripts/production-release'
FIXTURES = SOURCE.parents[1] / '.runtime/online-recharge-release-20261009/build/consolidated-online-after-bit-preparation-20261010/backup-source-transport-preparation/isolated-fixtures'
spec = importlib.util.spec_from_file_location('backup_transport_draft', HERE / 'online-recharge-backup-source-recovery-transport.py')
t = importlib.util.module_from_spec(spec); sys.modules[spec.name] = t; spec.loader.exec_module(t)
core = t.module_from_bytes((SOURCE / t.CORE_NAME).read_bytes(), 'fixture_backup_core', SOURCE / t.CORE_NAME)
snapshot = t.module_from_bytes((SOURCE / t.SNAPSHOT_NAME).read_bytes(), 'fixture_backup_snapshot', SOURCE / t.SNAPSHOT_NAME)
PRODUCER = {'commit': '1' * 40, 'sourceTree': '2' * 40,
            'workflowRunId': '11111111111111111111', 'workflowRunAttempt': '22222222222222222222'}


def unpack(command):
    boot = ast.parse(shlex.split(command)[-1])
    data = [n.args[0].value for n in ast.walk(boot) if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute) and n.func.attr == 'b85decode'][0]
    return gzip.decompress(base64.b85decode(data))


class FixtureTests(unittest.TestCase):
    def setUp(self):
        directory = FIXTURES; directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='transport-', dir=directory)
        self.base = Path(self.temporary.name)
        (self.base / 'releases').mkdir(mode=0o700)
        (self.base / 'backups').mkdir(mode=0o700)
        self.mysql = self.base / 'backups/mysql'; self.mysql.mkdir(mode=0o700)
        self.current = self.base / 'releases' / ('20261010T000000Z-' + t.BASELINE[:12])
        self.current.mkdir(mode=0o700)
        (self.base / 'current').symlink_to(self.current)
        # Original environment is only a synthetic local fixture.
        (self.current / '.env.aws.production').write_text(
            'MYSQL_BACKUP_S3_BUCKET=fixture-private-bucket\nMYSQL_BACKUP_S3_PREFIX=mysql/daily\n'
            'MYSQL_BACKUP_S3_REGION=ap-northeast-1\nUNRELATED_SECRET=never-print-fixture-secret\n')
        (self.current / '.env.aws.production').chmod(0o600)
        self.history, self.names, self.sources = [], [], []
        self.data = b'fixed synthetic original gzip bytes'
        for index, (role, commit, unused_sha, status, step) in enumerate(t.HISTORY):
            source = self.base / 'releases' / ('20261010T00000' + str(index + 1) + 'Z-' + commit[:12])
            source.mkdir(mode=0o700); self.sources.append(source)
            failure = {'candidateCommit': commit, 'previousCommit': t.BASELINE, 'status': status,
                       'step': step, 'rollbackOk': True, 'currentPointsToCandidate': False,
                       'receiptPersisted': True}
            (source / 'online-recharge-failure.json').write_bytes(t.canonical(failure))
            self.history.append((role, commit, t.sha(t.canonical(failure)), status, step))
            name = 'id-business-v2-20261010T00000' + str(index + 1) + 'Z.sql.gz'; self.names.append(name)
            receipt = {'name': name, 'size': len(self.data), 'sha256': t.sha(self.data), 's3Verified': True}
            (source / 'backup-verification.json').write_bytes(t.canonical(receipt))
            if role == 'RESTORED':
                (source / 'release-manifest.json').write_bytes(t.canonical({
                    'commit': commit, 'previousCommit': t.BASELINE, 'backupBeforeRelease': name}))
        def fixture_directory(row):
            t.need(stat.S_ISDIR(row.st_mode) and row.st_uid in (0, os.getuid())
                   and stat.S_IMODE(row.st_mode) & 0o022 == 0, 'ANCESTOR_INVALID')
        self.stack = [patch.object(t, 'BASE', self.base), patch.object(t, 'ROOT_UID', os.getuid()),
                      patch.object(t, 'HISTORY', tuple(self.history)),
                      patch.object(t, 'directory_safe', fixture_directory),
                      patch.object(core, '_uid', lambda: os.getuid())]
        for item in self.stack:
            item.start()
        self.read = lambda unused: 'a' * 64

    def tearDown(self):
        for item in reversed(self.stack):
            item.stop()
        self.temporary.cleanup()

    def tree(self):
        return sorted((str(p.relative_to(self.base)), p.read_bytes() if p.is_file() else None)
                      for p in self.base.rglob('*') if not p.is_symlink())

    def test_diagnose_two_missing_never_calls_network_and_changes_no_files(self):
        before = self.tree()
        with patch.object(t, 'head_read', side_effect=AssertionError('network')), patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('diagnose_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertEqual([n['receipt']['localStateBefore'] for n in value['backups']], ['MISSING', 'MISSING'])
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(self.tree(), before)
        self.assertNotIn('fixture-private-bucket', json.dumps(value))
        self.assertNotIn('never-print-fixture-secret', json.dumps(value))

    def test_original_slash_prefix_keeps_original_empty_rstrip_key(self):
        path = self.current / '.env.aws.production'
        path.write_text(path.read_text().replace('MYSQL_BACKUP_S3_PREFIX=mysql/daily', 'MYSQL_BACKUP_S3_PREFIX=/'))
        authority = t.Authority()
        try:
            values = authority.expected(core)
            self.assertEqual([value.prefix for unused, value in values], ['', ''])
            self.assertEqual([value.key for unused, value in values], ['/' + name for name in self.names])
        finally:
            authority.close()

    def test_restore_existing_match_is_no_change_and_never_downloads(self):
        for name in self.names:
            (self.mysql / name).write_bytes(self.data)
        before = self.tree()
        with patch.object(t, 'head_read', side_effect=AssertionError('network')), patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('restore_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertEqual([n['receipt']['status'] for n in value['backups']], ['NO_CHANGE', 'NO_CHANGE'])
        self.assertEqual(self.tree(), before)

    def test_restore_missing_streams_to_held_fd_and_preserves_original_sources(self):
        source_bytes = {p: p.read_bytes() for p in self.current.rglob('*') if p.is_file()}
        source_bytes.update({p: p.read_bytes() for source in self.sources for p in source.rglob('*') if p.is_file()})
        downloads = []
        def head(expected):
            return {'ContentLength': expected.size, 'ChecksumSHA256': base64.b64encode(bytes.fromhex(expected.sha256)).decode(),
                    'ServerSideEncryption': 'AES256'}
        def downloaded(expected, fd):
            downloads.append(expected.name); os.write(fd, self.data)
        def fixture_fd_link(fd, parent, name):
            # Fixture-only substitution for the Linux root AT_EMPTY_PATH primitive.
            held = os.fstat(fd)
            matches = [p for p in self.mysql.iterdir()
                       if (p.stat().st_dev, p.stat().st_ino) == (held.st_dev, held.st_ino)]
            self.assertEqual(len(matches), 1)
            os.link(matches[0].name, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        with patch.object(t, 'head_read', head), patch.object(t, 'download', downloaded), patch.object(core, '_install_from_fd', fixture_fd_link):
            value = t.execute_action('restore_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'COMPLETED')
        self.assertEqual(downloads, self.names)
        self.assertTrue(value['installed'])
        self.assertEqual([n['receipt']['status'] for n in value['backups']], ['RESTORED', 'RESTORED'])
        self.assertEqual(sorted(p.name for p in self.mysql.iterdir()), sorted(self.names))
        for name in self.names:
            self.assertEqual((self.mysql / name).read_bytes(), self.data)
            self.assertEqual(stat.S_IMODE((self.mysql / name).stat().st_mode), 0o600)
        for path, raw in source_bytes.items():
            self.assertEqual(path.read_bytes(), raw)

    def test_restore_does_not_overwrite_bad_existing_copy(self):
        path = self.mysql / self.names[0]; path.write_bytes(b'bad existing')
        before = path.stat()
        with patch.object(t, 'head_read', side_effect=AssertionError('network')), patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('restore_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(value['backups'][0]['receipt']['localStateBefore'], 'SIZE')
        self.assertEqual(path.read_bytes(), b'bad existing')
        self.assertEqual(path.stat().st_ino, before.st_ino)

    def test_restore_link_is_preserved(self):
        (self.mysql / self.names[0]).symlink_to(self.current / '.env.aws.production')
        with patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('restore_online_backup_source', core, self.read)
        self.assertEqual(value['backups'][0]['receipt']['localStateBefore'], 'LINK')
        self.assertTrue((self.mysql / self.names[0]).is_symlink())

    def test_wrong_failure_hash_rejected_without_network(self):
        (self.sources[0] / 'online-recharge-failure.json').write_bytes(b'{"extra":"bad"}')
        with patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('diagnose_online_backup_source', core, self.read)
        self.assertEqual(value['code'], 'FAILURE_CHANGED')
        self.assertEqual(value['backups'], [])

    def test_duplicate_historical_source_rejected(self):
        (self.sources[0].parent / ('20261010T010000Z-' + self.history[0][1][:12])).mkdir(mode=0o700)
        value = t.execute_action('diagnose_online_backup_source', core, self.read)
        self.assertEqual(value['code'], 'SOURCE_INVALID')

    def test_historical_source_symlink_rejected(self):
        source = self.sources[0]; target = source.with_name('other-fixture')
        source.rename(target); source.symlink_to(target)
        value = t.execute_action('diagnose_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(value['backups'], [])

    def test_receipt_traversal_rejected(self):
        path = self.sources[0] / 'backup-verification.json'
        value = json.loads(path.read_bytes()); value['name'] = '../escape.sql.gz'; path.write_bytes(t.canonical(value))
        value = t.execute_action('diagnose_online_backup_source', core, self.read)
        self.assertEqual(value['code'], 'RECEIPT_CHANGED')

    def test_restored_manifest_does_not_select_another_backup(self):
        path = self.sources[1] / 'release-manifest.json'
        value = json.loads(path.read_bytes()); value['backupBeforeRelease'] = self.names[0]
        path.write_bytes(t.canonical(value))
        self.assertEqual(t.execute_action('diagnose_online_backup_source', core, self.read)['code'], 'RECEIPT_CHANGED')

    def test_current_change_stops_before_core_mutation(self):
        def moved(unused):
            (self.base / 'current').unlink()
            (self.base / 'current').symlink_to(self.sources[0])
            return 'a' * 64
        with patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('restore_online_backup_source', core, moved)
        self.assertEqual(value['status'], 'FAILED')
        self.assertFalse(value['mutationAttempted'])
        self.assertEqual(list(self.mysql.iterdir()), [])

    def test_service_change_stops_before_core_mutation(self):
        calls = []
        def changed(unused):
            calls.append(1); return ('a' if len(calls) == 1 else 'b') * 64
        with patch.object(t, 'download', side_effect=AssertionError('network')):
            value = t.execute_action('restore_online_backup_source', core, changed)
        self.assertEqual(value['code'], 'SERVICES_CHANGED')
        self.assertFalse(value['mutationAttempted'])

    def test_receipt_change_during_download_stops_install(self):
        def head(expected):
            return {'ContentLength': expected.size, 'ChecksumSHA256': base64.b64encode(bytes.fromhex(expected.sha256)).decode(),
                    'ServerSideEncryption': 'AES256'}
        def downloaded(expected, fd):
            os.write(fd, self.data)
            (self.sources[0] / 'backup-verification.json').write_bytes(b'{"changed":true}')
        with patch.object(t, 'head_read', head), patch.object(t, 'download', downloaded):
            value = t.execute_action('restore_online_backup_source', core, self.read)
        self.assertEqual(value['status'], 'FAILED')
        self.assertFalse(value['mutationAttempted'])
        self.assertFalse((self.mysql / self.names[0]).exists())
        self.assertEqual(list(self.mysql.iterdir()), [])


class WireTests(unittest.TestCase):
    def test_selection_is_two_exact_operations_and_fixed_baseline(self):
        env = {'RELEASE_OPERATION': 'diagnose_online_backup_source', 'EXPECTED_CURRENT': t.BASELINE,
               'GITHUB_REF': 'refs/heads/main', 'RELEASE_COMMIT': PRODUCER['commit'],
               'SOURCE_TREE': PRODUCER['sourceTree'], 'GITHUB_RUN_ID': PRODUCER['workflowRunId'],
               'GITHUB_RUN_ATTEMPT': PRODUCER['workflowRunAttempt']}
        invalid = [('EXPECTED_CURRENT', 'a' * 40), ('GITHUB_REF', 'refs/heads/other'),
                   ('RELEASE_COMMIT', 'invalid'), ('HISTORICAL_EXCEPTION', 'legacy'),
                   ('RELEASE_ADMIN_ONLY', 'true')]
        forbidden = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID',
                     'REUSE_IMAGE_RUN_ATTEMPT', 'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256',
                     'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', 'RELEASE_BROWSER_CACHE_IMAGE',
                     'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')
        invalid.extend((name, 'injected') for name in forbidden)
        for operation in t.OPERATIONS:
            selected = {**env, 'RELEASE_OPERATION': operation}
            self.assertEqual(t.selection(selected)[0], operation)
            shell = subprocess.run(['bash', str(SOURCE / 'validate-release-selection.sh')],
                env={'PATH': os.defpath, **selected}, capture_output=True, timeout=3)
            self.assertEqual(shell.returncode, 0)
            for key, value in [*invalid, ('RELEASE_OPERATION', operation + '-extra')]:
                with self.subTest(operation=operation, key=key):
                    altered = {**selected, key: value}
                    with self.assertRaises(t.Rejected):t.selection(altered)
                    shell = subprocess.run(['bash', str(SOURCE / 'validate-release-selection.sh')],
                        env={'PATH': os.defpath, **altered}, capture_output=True, timeout=3)
                    self.assertNotEqual(shell.returncode, 0)
            for key, value in [('BACKUP_MODE', 'restore_missing'), ('BACKUP_SOURCE', 'arbitrary'),
                               ('SOURCE_TREE', 'invalid'), ('GITHUB_RUN_ID', '0')]:
                with self.subTest(operation=operation, key=key), self.assertRaises(t.Rejected):
                    t.selection({**selected, key: value})

    def test_capacity_and_exact_reused_sources(self):
        for operation in t.OPERATIONS:
            payload, binding = t.parameters(operation, PRODUCER, source=SOURCE)
            self.assertLess(len(t.canonical(payload)), 20480)
            self.assertEqual(binding['coreSha256'], t.sha((SOURCE / t.CORE_NAME).read_bytes()))
            self.assertEqual(binding['snapshotSourceSha256'], t.sha((SOURCE / t.SNAPSHOT_NAME).read_bytes()))
            self.assertEqual(len(binding['controllerPins']), 11)
            self.assertEqual(len(binding['packagePins']), 10)
            self.assertNotIn(t.CORE_NAME, binding['controllerPins'])
            body = unpack(payload['commands'][-1]).decode(); ast.parse(body)
            snapshot_source = (SOURCE / t.SNAPSHOT_NAME).read_text()
            for name in ('read_fixed', 'literal_module'):
                node = next(n for n in ast.parse(snapshot_source).body if isinstance(n, ast.FunctionDef) and n.name == name)
                exact = ''.join(snapshot_source.splitlines(keepends=True)[node.lineno-1:node.end_lineno])
                self.assertIn(exact, body)
            extra = unpack(payload['commands'][-2]).decode()
            original = (SOURCE / 'api-admin-readonly.py').read_text()
            node = next(n for n in ast.parse(original).body if isinstance(n, ast.FunctionDef) and n.name == '_store_files')
            exact = ''.join(original.splitlines(keepends=True)[node.lineno-1:node.end_lineno])
            self.assertIn(exact, extra)
            self.assertNotIn('qualified(', body)
            self.assertNotIn('baseline(', body)

    def test_stream_uses_fd_and_limits_overflow_underflow_and_total_deadline(self):
        fixture = FIXTURES; fixture.mkdir(mode=0o700, parents=True, exist_ok=True)
        original = subprocess.Popen
        def child(raw, sleep=0):
            def spawn(command, **kwargs):
                self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
                self.assertNotIn('outfile', command)
                return original([sys.executable, '-B', '-c',
                    'import os,time;os.write(1,' + repr(raw) + ');time.sleep(' + repr(sleep) + ')'], **kwargs)
            return spawn
        with tempfile.TemporaryFile(dir=fixture) as output:
            with patch.object(t.subprocess, 'Popen', child(b'abc')):
                t.bounded_process(['synthetic-only'], 3, 1, fd=output.fileno())
            output.seek(0); self.assertEqual(output.read(), b'abc')
        for data, limit in [(b'abcd', 3), (b'ab', 3)]:
            with tempfile.TemporaryFile(dir=fixture) as output, patch.object(t.subprocess, 'Popen', child(data)), self.assertRaises(t.Rejected):
                t.bounded_process(['synthetic-only'], limit, 1, fd=output.fileno())
        with patch.object(t.subprocess, 'Popen', child(b'', 2)), self.assertRaises(t.Rejected):
            t.bounded_process(['synthetic-only'], 4096, 0.05)
        with patch.object(t.subprocess, 'Popen', child(b'x' * 4097)), self.assertRaises(t.Rejected):
            t.bounded_process(['synthetic-only'], 4096, 1)

    def test_provider_commands_keep_original_fields_private_and_no_outfile(self):
        expected = core.ExpectedBackup('id-business-v2-20261010T000001Z.sql.gz', 3, t.sha(b'abc'), True,
                                       'fixture.bucket', 'original prefix', 'original region')
        calls = []
        def bounded(argv, limit, timeout, fd=None):
            calls.append((argv, limit, timeout, fd))
            return t.canonical({'ContentLength': 3, 'ChecksumSHA256': 'fixture', 'ServerSideEncryption': 'AES256'})
        with patch.object(t, 'bounded_process', bounded):
            t.head_read(expected); t.download(expected, 111)
        self.assertEqual(calls[1][0][4], '-')
        self.assertEqual(calls[1][3], 111)
        self.assertIn('s3://fixture.bucket/original prefix/' + expected.name, calls[1][0])
        self.assertIn('original region', calls[1][0])

    def test_terminal_requires_actual_command_and_rejects_extra_raw_fields(self):
        payload, binding = t.parameters('diagnose_online_backup_source', PRODUCER, source=SOURCE)
        receipt = {'kind': 'MYSQL_BACKUP_LOCAL_RECOVERY_V1', 'mode': 'diagnose', 'status': 'DIAGNOSED',
                   'code': 'OK', 'localStateBefore': 'MISSING', 'localStateAfter': 'MISSING',
                   'mutationAttempted': False, 'installed': False, 'rawOutputSuppressed': True}
        value = {'kind': 'ONLINE_BACKUP_SOURCE_EXECUTION_V1', 'operation': 'diagnose_online_backup_source',
                 'producer': PRODUCER, 'origin': t.ORIGIN, 'source21Sha256': binding['source21Sha256'],
                 'coreSha256': binding['coreSha256'], 'snapshotSourceSha256': binding['snapshotSourceSha256'],
                 'status': 'COMPLETED', 'code': 'OK', 'currentUnchanged': True, 'servicesUnchanged': True,
                 'servicesBeforeSha256': 'a' * 64, 'servicesAfterSha256': 'a' * 64,
                 'snapshotDiagnostic': {'status': 'PASSED', 'stage': 'COMPLETE', 'code': 'NONE',
                    'currentAnchorCount': 2, 'retainedServiceCount': 5, 'rawOutputSuppressed': True},
                 'clientCleanupVerified': True, 'mutationAttempted': False, 'installed': False,
                 'backups': [{'sourceRole': role, 'receipt': dict(receipt)} for role in ('RECOVERY','RESTORED')],
                 'rawOutputSuppressed': True}
        command = '11111111-1111-4111-8111-111111111111'
        invocation = {'CommandId': command, 'InstanceId': 'synthetic-instance', 'DocumentName': 'AWS-RunShellScript',
                      'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
                      'ExecutionEndDateTime': 'synthetic-ended', 'StandardOutputContent': t.PREFIX + t.canonical(value).decode(),
                      'StandardErrorContent': ''}
        self.assertEqual(t.terminal(invocation, command, value['operation'], binding, 'synthetic-instance', core, snapshot), value)
        with self.assertRaises(t.Rejected):
            t.terminal(invocation, '22222222-2222-4222-8222-222222222222', value['operation'], binding, 'synthetic-instance', core, snapshot)
        unsafe = copy.deepcopy(value); unsafe['backups'][0]['receipt']['raw'] = 'fixture-secret'
        with self.assertRaises(t.Rejected):
            t.validate_remote(unsafe, value['operation'], binding, core, snapshot)
        unsafe = copy.deepcopy(value); unsafe['producer'] = {**PRODUCER, 'sourceTree': 'f' * 40}
        with self.assertRaises(t.Rejected):
            t.validate_remote(unsafe, value['operation'], binding, core, snapshot)


if __name__ == '__main__':
    unittest.main(verbosity=2)
