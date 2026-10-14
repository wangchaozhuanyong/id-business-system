import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_artifact_native_test', HERE / 'release-artifact-retention.py')
native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
CURRENT = 'b' * 40


class Fixture(unittest.TestCase):
    def setUp(self):
        runtime = HERE.parent.parent / '.runtime'; runtime.mkdir(mode=0o700, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='artifact-test-', dir=runtime)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.files = native.Files(self.root, os.geteuid())
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.payload = b'HEAD' * 16384 + b'MIDDLE' * 10000 + b'TAIL' * 16384
        self.parent = self.root / 'artifacts' / native.FOLDER; self.parent.mkdir(parents=True, mode=0o700)
        self.package = self.parent / native.PACKAGE
        self.manifest = native.canonical({'commit': native.COMMIT, 'releaseTag': native.TAG,
            'artifact': {'file': native.PACKAGE, 'sha256': native.sha(self.payload)}})
        self.sums = (native.sha(self.payload) + '  ' + native.PACKAGE + '\n' +
                     native.sha(self.manifest) + '  release-manifest.json\n').encode()
        self.raws = {native.PACKAGE: self.payload, 'ci-release-manifest.json': self.manifest, 'SHA256SUMS': self.sums}
        for name, raw in self.raws.items():
            path = self.parent / name; path.write_bytes(raw); path.chmod(0o600)
        self.pins = {name: {'bytes': len(raw), 'sha256': native.sha(raw)} for name, raw in self.raws.items()}
        self.stack.enter_context(patch.object(native, 'PINS', self.pins))
        self.current = self.root / 'releases' / ('20261014T000000Z-' + CURRENT[:12])
        self.current.mkdir(parents=True, mode=0o700)
        for name, raw in {'release-manifest.json': native.canonical({'commit': CURRENT}),
             '.env.aws.production': b'MYSQL_BACKUP_S3_BUCKET=fixture-private-bucket\nMYSQL_BACKUP_S3_PREFIX=mysql/daily\nMYSQL_BACKUP_S3_REGION=ap-northeast-1\nSECRET=FICTITIOUS_PRIVATE_VALUE\n'}.items():
            path = self.current / name; path.write_bytes(raw); path.chmod(0o600)
        (self.root / 'current').symlink_to(self.current)
        lock = self.root / '.deploy.lock'; lock.write_bytes(b'lock'); lock.chmod(0o600)
        source = HERE.parent.parent / 'deploy/aws/release-artifact-storage-proof-20261014.json'
        self.proof = json.loads(source.read_bytes()); self.proof['bucket'] = 'fixture-private-bucket'
        self.proof_path = self.root / 'cloud-proof.json'; self.proof_path.write_bytes(native.canonical(self.proof)); self.proof_path.chmod(0o600)
        self.proof_sha = native.sha(self.proof_path.read_bytes())
        self.projection = {'id': 'a' * 64, 'imageId': 'sha256:' + 'e' * 64, 'reference': 'fixture:current',
            'running': True, 'state': 'running', 'startedAt': '2026-10-14T00:00:00Z', 'restartCount': 0,
            'health': None, 'mounts': []}
        self.proc = self.root / 'proc'; self.proc.mkdir(mode=0o700)
        original_unused = native.unused
        self.stack.enter_context(patch.object(native, 'unused', side_effect=lambda path, probe:
            original_unused(path, probe, proc=self.proc)))
        self.cloud = FakeCloud()
        self.commands = []
        original = native.command
        def command(arguments, code, **kwargs):
            if arguments[:2] == ['docker', 'ps']:
                self.commands.append(arguments); return (self.projection['id'] + '\n').encode()
            if arguments[:2] == ['docker', 'inspect']:
                self.commands.append(arguments); return native.canonical(self.projection) + b'\n'
            return original(arguments, code, **kwargs)
        self.stack.enter_context(patch.object(native, 'command', side_effect=command))
        self.stack.enter_context(patch.object(native.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))

    def execute(self, operation='plan', approved=None):
        return native.execute(operation, CURRENT, self.proof_path, self.proof_sha, approved,
                              files=self.files, cloud_factory=lambda target: self.cloud.configure(target))

    def apply(self):
        plan = self.execute(); return self.execute('apply', plan['planSha256'])


class FakeCloud(native.Cloud):
    def __init__(self):
        self.objects, self.calls, self.changes = {}, [], {}
        self.timeout_upload, self.corrupt_middle, self.on_download, self.on_head = False, False, None, None

    def configure(self, target):
        self.target = target; return self

    def call(self, operation, *arguments, **kwargs):
        self.calls.append((operation, arguments))
        def arg(name): return arguments[arguments.index(name) + 1]
        key = arg('--key')
        if operation == 'put-object':
            if key not in self.objects:
                raw = Path(arg('--body')).read_bytes()
                self.objects[key] = {'raw': raw, 'versionId': 'version-' + str(len(self.objects) + 1),
                    'etag': '"' + 'a' * 32 + '"'}
            else:
                raise native.Rejected('ARTIFACT_CLOUD_PUT_OBJECT_FAILED')
            if self.timeout_upload: raise native.Rejected('ARTIFACT_CLOUD_PUT_OBJECT_FAILED')
            return {}
        if key not in self.objects: raise native.Rejected('ARTIFACT_CLOUD_OBJECT_UNKNOWN')
        row = self.objects[key]
        if operation == 'head-object':
            if self.on_head: self.on_head(key)
            expiration = (datetime.now(timezone.utc) + timedelta(days=90)).strftime('%a, %d %b %Y 00:00:00 GMT')
            return {'ContentLength': len(row['raw']), 'ChecksumSHA256': base64.b64encode(bytes.fromhex(native.sha(row['raw']))).decode(),
                'ChecksumType': 'FULL_OBJECT', 'ServerSideEncryption': 'AES256', 'VersionId': row['versionId'],
                'ETag': row['etag'], 'Expiration': 'expiry-date="' + expiration + '", rule-id="RetainDailyBackups"',
                **self.changes}
        if operation == 'get-object-tagging': return {'TagSet': []}
        assert operation == 'get-object'
        if '--version-id' in arguments:
            raise native.Rejected('ARTIFACT_CLOUD_GET_OBJECT_FAILED')
        if arg('--if-match') != row['etag']:
            raise native.Rejected('ARTIFACT_CLOUD_GET_OBJECT_FAILED')
        target = Path(arguments[-1]); data = row['raw']
        if self.corrupt_middle and key.endswith(native.PACKAGE):
            middle = len(data) // 2; data = data[:middle] + b'X' + data[middle+1:]
        target.write_bytes(data); target.chmod(0o600)
        if self.on_download: self.on_download(key)
        return {'ETag': row['etag'], 'VersionId': row['versionId'], 'ContentLength': len(data)}


class ArchiveTests(Fixture):
    def test_plan_is_readonly_and_exact_leaf_bound_without_target_disclosure(self):
        result = self.execute()
        self.assertEqual(result['status'], 'PLAN_ONLY'); self.assertTrue(self.package.exists())
        self.assertEqual(self.cloud.calls, [])
        plan_path = Path(result['planFile']); plan = json.loads(plan_path.read_bytes())
        self.assertEqual(native.digest(plan), result['planSha256'])
        self.assertEqual(set(plan['files']), set(self.pins))
        self.assertEqual(plan_path.stat().st_mode & 0o777, 0o600)
        for private in ('fixture-private-bucket', 'FICTITIOUS_PRIVATE_VALUE', 'MYSQL_BACKUP'):
            self.assertNotIn(private, json.dumps(result)); self.assertNotIn(private, json.dumps(plan))

    def test_apply_verifies_every_full_object_before_releasing_only_package(self):
        result = self.apply()
        self.assertEqual(result['status'], 'APPLIED'); self.assertFalse(self.package.exists())
        self.assertTrue(result['fullRecoveryVerified'])
        self.assertEqual([op for op, args in self.cloud.calls].count('get-object'), 4)
        for name in ('ci-release-manifest.json', 'SHA256SUMS'):
            self.assertEqual((self.parent / name).read_bytes(), self.raws[name])
        index = json.loads(Path(result['recoveryFile']).read_bytes())
        self.assertEqual(index['target']['bucket'], 'fixture-private-bucket')
        self.assertEqual(set(index['objects']), set(self.pins))
        self.assertTrue(all(record['versionId'] for record in index['objects'].values()))
        self.assertEqual(json.loads(Path(result['receiptFile']).read_bytes())['status'], 'APPLIED')
        self.assertEqual(len(list(self.files.receipts.glob('*.attempt.json'))), 1)

    def test_middle_corruption_retains_original_and_metadata(self):
        self.cloud.corrupt_middle = True
        with self.assertRaisesRegex(native.Rejected, 'FILE_PIN_CHANGED'): self.apply()
        self.assertEqual(self.package.read_bytes(), self.payload)
        result = json.loads(next(self.files.receipts.glob('*.result.json')).read_bytes())
        self.assertEqual(result['status'], 'FAILED_CLOSED')
        self.assertEqual(result['removalState'], 'UNKNOWN_REQUIRES_READBACK')
        self.assertEqual(result['code'], 'ARTIFACT_FILE_PIN_CHANGED')

    def test_approved_plan_drift_prevents_all_uploads(self):
        plan = self.execute(); self.package.write_bytes(b'X' + self.payload[1:])
        with self.assertRaises(native.Rejected): self.execute('apply', plan['planSha256'])
        self.assertEqual(self.cloud.calls, []); self.assertTrue(self.package.exists())

    def test_target_or_cloud_proof_change_cannot_reuse_approved_plan(self):
        result = self.execute()
        env = self.current / '.env.aws.production'
        env.write_bytes(env.read_bytes().replace(b'fixture-private-bucket', b'different-private-bucket'))
        with self.assertRaisesRegex(native.Rejected, 'CLOUD_PROOF_INVALID'): self.execute('apply', result['planSha256'])
        self.assertEqual(self.cloud.calls, [])

    def test_foreign_s3_hash_size_encryption_version_or_expiry_is_rejected(self):
        for change in ({'ContentLength': 1}, {'ChecksumSHA256': 'wrong'}, {'ServerSideEncryption': 'aws:kms'},
                       {'ChecksumType': 'COMPOSITE'}, {'VersionId': None}, {'ETag': 'unknown'},
                       {'Expiration': None}, {'Expiration': 'expiry-date="Wed, 14 Oct 2026 00:00:00 GMT", rule-id="x"'}):
            with self.subTest(change=change):
                self.cloud.objects.clear(); self.cloud.changes = change
                with self.assertRaises(native.Rejected): self.apply()
                self.assertTrue(self.package.exists())

    def test_upload_timeout_reconciles_exact_accepted_version_without_second_put(self):
        self.cloud.timeout_upload = True
        result = self.apply()
        self.assertEqual(result['status'], 'APPLIED')
        self.assertEqual([op for op, args in self.cloud.calls].count('put-object'), 4)
        self.assertEqual(len(self.cloud.objects), 4)

    def test_unknown_expiration_rule_is_rejected_even_with_ninety_days_remaining(self):
        expiration = (datetime.now(timezone.utc) + timedelta(days=90)).strftime('%a, %d %b %Y 00:00:00 GMT')
        self.cloud.changes = {'Expiration': 'expiry-date="' + expiration + '", rule-id="UnknownRule"'}
        with self.assertRaisesRegex(native.Rejected, 'RETENTION_EXPIRATION_UNKNOWN'): self.apply()
        self.assertTrue(self.package.exists())
        self.assertFalse(any(operation == 'get-object' for operation, arguments in self.cloud.calls))

    def test_unknown_existing_s3_object_is_not_overwritten(self):
        key = 'mysql/daily/release-artifact-cache/' + native.FOLDER + '/' + native.PACKAGE
        self.cloud.objects[key] = {'raw': b'unknown', 'versionId': 'existing', 'etag': '"' + 'a'*32 + '"'}
        with self.assertRaisesRegex(native.Rejected, 'CLOUD_OBJECT_UNKNOWN'): self.apply()
        self.assertEqual(self.cloud.objects[key]['raw'], b'unknown'); self.assertTrue(self.package.exists())

    def test_space_deficit_stops_before_upload(self):
        with patch.object(native.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)),\
             self.assertRaisesRegex(native.Rejected, 'HEADROOM_INSUFFICIENT'): self.apply()
        self.assertEqual(self.cloud.calls, []); self.assertTrue(self.package.exists())

    def test_container_drift_after_full_download_preserves_package(self):
        self.cloud.on_download = lambda key: self.projection.update(restartCount=1)
        with self.assertRaisesRegex(native.Rejected, 'PROTECTION_CHANGED'): self.apply()
        self.assertTrue(self.package.exists())

    def test_parent_and_child_mount_intersections_block_plan(self):
        for source in (str(self.parent), str(self.package), str(self.package / 'child')):
            self.projection['mounts'] = [{'Type': 'bind', 'Source': source, 'Destination': '/data'}]
            with self.subTest(source=source), self.assertRaisesRegex(native.Rejected, 'PACKAGE_MOUNTED'): self.execute()
        self.assertEqual(self.cloud.calls, [])

    def test_open_descriptor_and_lock_busy_refuse_without_changes(self):
        process = self.proc / '123456'; (process / 'fd').mkdir(parents=True)
        (process / 'fd/7').symlink_to(self.package)
        with self.assertRaisesRegex(native.Rejected, 'PACKAGE_OPEN'): self.execute()
        (process / 'fd/7').unlink()
        import fcntl
        with (self.root / '.deploy.lock').open('rb') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(native.Rejected, 'BUSY'): self.execute()
        self.assertEqual(self.cloud.calls, [])

    def test_symlink_hardlink_or_untrusted_mode_rejects(self):
        self.package.chmod(0o644)
        with self.assertRaisesRegex(native.Rejected, 'FILE_UNTRUSTED'): self.execute()
        self.package.chmod(0o600)
        extra = self.parent / 'alias'; os.link(self.package, extra)
        with self.assertRaisesRegex(native.Rejected, 'FILE_UNTRUSTED'): self.execute()
        extra.unlink(); self.package.unlink(); self.package.symlink_to(self.parent / 'SHA256SUMS')
        with self.assertRaises(Exception): self.execute()
        self.assertEqual(self.cloud.calls, [])

    def test_restore_recovers_original_bytes_mode_without_business_action(self):
        archived = self.apply(); restored = self.execute('restore', archived['planSha256'])
        self.assertEqual(restored['status'], 'RESTORED'); self.assertEqual(self.package.read_bytes(), self.payload)
        self.assertEqual(self.package.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.package.stat().st_uid, os.geteuid())
        self.assertFalse(any(arguments[:2] != ['docker', 'ps'] and arguments[:2] != ['docker', 'inspect']
                             for arguments in self.commands))
        self.assertNotIn('fixture-private-bucket', json.dumps(restored))

    def test_restore_cannot_overwrite_unknown_target(self):
        archived = self.apply(); self.package.write_bytes(b'unknown'); self.package.chmod(0o600)
        with self.assertRaisesRegex(native.Rejected, 'TARGET_EXISTS'): self.execute('restore', archived['planSha256'])
        self.assertEqual(self.package.read_bytes(), b'unknown')

    def test_restore_corruption_never_creates_original_leaf(self):
        archived = self.apply(); self.cloud.corrupt_middle = True
        with self.assertRaisesRegex(native.Rejected, 'FILE_PIN_CHANGED'): self.execute('restore', archived['planSha256'])
        self.assertFalse(self.package.exists())

    def test_restore_pins_all_recorded_objects_and_same_target(self):
        archived = self.apply()
        index_path = Path(archived['recoveryFile']); index = json.loads(index_path.read_bytes())
        index['objects'][native.PACKAGE]['key'] = 'unknown/recovery-package'
        index_path.write_bytes(native.canonical(index)); index_path.chmod(0o600)
        with self.assertRaisesRegex(native.Rejected, 'RECOVERY_INDEX_INVALID'):
            self.execute('restore', archived['planSha256'])
        self.assertFalse(self.package.exists())

    def test_cloud_version_drift_after_download_prevents_release(self):
        def changed(key):
            if key.endswith('.recovery.json'):
                package_key = next(item for item in self.cloud.objects if item.endswith(native.PACKAGE))
                self.cloud.objects[package_key]['versionId'] = 'unexpected-new-version'
        self.cloud.on_download = changed
        with self.assertRaisesRegex(native.Rejected, 'CLOUD_OBJECT_CHANGED'): self.apply()
        self.assertTrue(self.package.exists())

    def test_same_etag_same_bytes_new_version_during_get_retains_original(self):
        original_bytes = self.payload
        def changed(key):
            if key.endswith(native.PACKAGE):
                self.cloud.objects[key]['versionId'] = 'different-version-same-content'
        self.cloud.on_download = changed
        with self.assertRaisesRegex(native.Rejected, 'CLOUD_DOWNLOAD_CHANGED'): self.apply()
        self.assertEqual(self.package.read_bytes(), original_bytes)
        row = next(record for key, record in self.cloud.objects.items() if key.endswith(native.PACKAGE))
        self.assertEqual(row['raw'], original_bytes); self.assertEqual(row['etag'], '"' + 'a'*32 + '"')

    def test_if_match_precondition_failure_preserves_package_without_release(self):
        original = self.cloud.call
        def conditional_failure(operation, *arguments, **kwargs):
            if operation == 'get-object':
                key = arguments[arguments.index('--key') + 1]
                self.cloud.objects[key]['etag'] = '"' + 'b'*32 + '"'
            return original(operation, *arguments, **kwargs)
        self.cloud.call = conditional_failure
        with self.assertRaisesRegex(native.Rejected, 'CLOUD_GET_OBJECT_FAILED'): self.apply()
        self.assertEqual(self.package.read_bytes(), self.payload)
        failed = json.loads(next(self.files.receipts.glob('*.result.json')).read_bytes())
        self.assertEqual(failed['status'], 'FAILED_CLOSED')

    def test_failed_native_attempt_has_safe_private_receipt_pointer(self):
        self.cloud.corrupt_middle = True
        with self.assertRaises(native.Rejected) as error: self.apply()
        receipt = Path(error.exception.receipt_file)
        self.assertEqual(receipt.parent, self.files.receipts)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('fixture-private-bucket', receipt.read_text())
        self.assertNotIn('FICTITIOUS_PRIVATE', receipt.read_text())

    def test_replaced_lock_is_rejected_immediately_after_flock_before_plan_write(self):
        import fcntl
        flock = fcntl.flock
        def replaced(descriptor, flags):
            flock(descriptor, flags)
            path = self.root / '.deploy.lock'
            path.unlink(); path.write_bytes(b'new lock'); path.chmod(0o600)
        with patch.object(native.fcntl, 'flock', side_effect=replaced),\
             self.assertRaisesRegex(native.Rejected, 'LOCK_CHANGED'): self.execute()
        self.assertTrue(self.package.exists()); self.assertEqual(self.cloud.calls, [])
        self.assertFalse(self.files.receipts.exists())

    def test_last_head_lock_replacement_is_rejected_before_unlink(self):
        downloaded = [False]
        self.cloud.on_download = lambda key: downloaded.__setitem__(0, key.endswith('.recovery.json'))
        def changed(key):
            if downloaded[0]:
                path = self.root / '.deploy.lock'
                path.unlink(); path.write_bytes(b'changed'); path.chmod(0o600)
        self.cloud.on_head = changed
        with self.assertRaisesRegex(native.Rejected, 'LOCK_CHANGED'): self.apply()
        self.assertTrue(self.package.exists())

    def test_last_head_container_or_open_fd_drift_blocks_final_unlink(self):
        for kind in ('container', 'fd'):
            downloaded = [False]
            self.cloud.objects.clear()
            self.cloud.on_download = lambda key: downloaded.__setitem__(0, key.endswith('.recovery.json'))
            def changed(key):
                if downloaded[0]:
                    if kind == 'container': self.projection['restartCount'] = 3
                    else:
                        directory = self.proc / '654321/fd'; directory.mkdir(parents=True, exist_ok=True)
                        path = directory / '8'
                        if not path.exists(): path.symlink_to(self.package)
            self.cloud.on_head = changed
            with self.subTest(kind=kind), self.assertRaisesRegex(native.Rejected, 'PROTECTION_CHANGED|PACKAGE_OPEN'):
                self.apply()
            self.assertTrue(self.package.exists())
            self.projection['restartCount'] = 0

    def test_restore_rejects_new_parent_mount_before_cloud_reads(self):
        archived = self.apply(); before = len(self.cloud.calls)
        self.projection['mounts'] = [{'Type': 'bind', 'Source': str(self.parent), 'Destination': '/data'}]
        with self.assertRaisesRegex(native.Rejected, 'PACKAGE_MOUNTED'):
            self.execute('restore', archived['planSha256'])
        self.assertEqual(len(self.cloud.calls), before); self.assertFalse(self.package.exists())

    def test_restore_reserves_both_full_download_and_exclusive_copy_before_io(self):
        archived = self.apply(); before = len(self.cloud.calls)
        with patch.object(native.shutil, 'disk_usage', return_value=SimpleNamespace(
             free=native.RESERVE_BYTES + len(self.payload))),\
             self.assertRaisesRegex(native.Rejected, 'HEADROOM_INSUFFICIENT'):
            self.execute('restore', archived['planSha256'])
        self.assertEqual(len(self.cloud.calls), before); self.assertFalse(self.package.exists())

    def test_cloud_proof_unknown_rules_or_public_access_are_closed(self):
        for field, value in (('lifecycle', {'Rules': []}), ('versioning', {'Status': 'Suspended'}),
                             ('publicAccessBlock', {key: False for key in self.proof['publicAccessBlock']})):
            altered = {**self.proof, field: value}
            self.proof_path.write_bytes(native.canonical(altered)); self.proof_sha = native.sha(self.proof_path.read_bytes())
            with self.subTest(field=field), self.assertRaisesRegex(native.Rejected, 'CLOUD_PROOF_INVALID'): self.execute()

    def test_immutable_receipt_does_not_overwrite_unknown_content(self):
        result = self.execute(); Path(result['planFile']).write_bytes(b'unknown')
        with self.assertRaisesRegex(native.Rejected, 'RECEIPT_EXISTS_CHANGED'): self.execute()


class SafeFailureTests(unittest.TestCase):
    def test_actual_get_cli_uses_existing_getobject_permission_and_checks_response_version(self):
        record = {'key': 'fixture/package.tar.gz', 'etag': '"' + 'a'*32 + '"',
                  'versionId': 'confirmed-version', 'bytes': 1234}
        cloud = native.Cloud({'bucket': 'fixture-private-bucket', 'region': 'ap-northeast-1'})
        requests = []
        def permission(arguments, **kwargs):
            requests.append(arguments)
            if '--version-id' in arguments:
                return SimpleNamespace(returncode=1, stdout=b'',
                    stderr=b'AccessDenied: s3:GetObjectVersion FICTITIOUS_PRIVATE_VALUE')
            self.assertIn('--if-match', arguments)
            self.assertEqual(arguments[arguments.index('--if-match') + 1], record['etag'])
            return SimpleNamespace(returncode=0, stderr=b'', stdout=native.canonical(
                {'VersionId': record['versionId'], 'ETag': record['etag'], 'ContentLength': record['bytes']}))
        with patch.object(native.subprocess, 'run', side_effect=permission):
            with self.assertRaisesRegex(native.Rejected, 'CLOUD_GET_OBJECT_FAILED'):
                cloud.call('get-object', '--key', record['key'], '--version-id', record['versionId'],
                           '/fixture/output', timeout=600)
            cloud.download(record, Path('/fixture/output'))
        self.assertEqual(len(requests), 2)
        self.assertIn('--version-id', requests[0]); self.assertNotIn('--version-id', requests[1])
        self.assertEqual(requests[1][:4], ['aws', 's3api', '--region', 'ap-northeast-1'])

    def test_raw_cloud_error_is_never_emitted(self):
        with patch.object(native.subprocess, 'run', return_value=SimpleNamespace(returncode=1,
             stdout=b'SECRET_SQL_FIXTURE', stderr=b'SECRET_TOKEN_FIXTURE')),\
             self.assertRaises(native.Rejected) as error:
            native.command(['aws'], 'CLOUD_FAILED')
        self.assertEqual(str(error.exception), 'ARTIFACT_CLOUD_FAILED')

    def test_main_outputs_only_safe_code_for_unknown_exception(self):
        args = ['plan', '--expected-current', CURRENT, '--cloud-proof-json', '/opt/id-business-v2/private.json',
                '--expected-cloud-proof-sha256', 'a'*64, '--expected-source-sha256', 'b'*64]
        with patch.object(native.Files, 'read', return_value=({'sha256': 'b'*64}, b'')),\
             patch.object(native, 'execute', side_effect=RuntimeError('SECRET_ENV_FIXTURE')),\
             redirect_stdout(io.StringIO()) as output:
            status = native.main(args)
        self.assertEqual(status, 1); self.assertNotIn('SECRET', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['code'], 'ARTIFACT_IO_FAILED_CLOSED')


if __name__ == '__main__':
    unittest.main()
