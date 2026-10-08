import importlib.util
import base64
from contextlib import contextmanager, ExitStack, redirect_stdout
import gzip
import hashlib
import io
import json
from pathlib import Path
import os
import tarfile
import tempfile
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('storage-maintenance.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
REF = {'table': 'id_business_v2_governance_job_items', 'column': 'result_audit_log_id', 'sameSchema': 1}
BACKUP = {'name': 'id-business-v2-20261002T120000Z.sql.gz', 's3Verified': True}


class StorageReadonlyBaselineTests(unittest.TestCase):
    CURRENT = 'e7c9862d58599995954883f1c1f6038283afffab'
    PREVIOUS = '04570d75c779fd91a0933ef9416f6d62698b6b91'
    RELEASE = '20261008T020705Z-e7c9862d5859'
    PREVIOUS_RELEASE = '20261007T221905Z-04570d75c779'

    @contextmanager
    def fixture(self, expected=None, during_diagnostics=None):
        expected = expected or self.CURRENT
        previous_commit = storage.REVIEWED_BASELINES.get(expected, self.PREVIOUS)
        with tempfile.TemporaryDirectory(dir='.deploy') as directory, ExitStack() as stack:
            root = Path(directory).resolve()
            current = root / 'releases' / self.RELEASE
            previous = root / 'releases' / self.PREVIOUS_RELEASE
            current.mkdir(parents=True)
            previous.mkdir()
            (root / 'current').symlink_to(current)
            current_manifest = current / 'release-manifest.json'
            previous_manifest = previous / 'release-manifest.json'
            current_manifest.write_text(json.dumps({'commit': expected,
                'previousCommit': previous_commit, 'previousRelease': str(previous)}))
            previous_manifest.write_text(json.dumps({'commit': previous_commit}))
            (current / '.env.aws.production').write_text('COMPOSE_PROJECT_NAME=fixture\n')
            readonly = {self.CURRENT: {'release': self.RELEASE,
                'manifestSha256': hashlib.sha256(current_manifest.read_bytes()).hexdigest(),
                'previousRelease': self.PREVIOUS_RELEASE, 'previousCommit': self.PREVIOUS,
                'previousManifestSha256': hashlib.sha256(previous_manifest.read_bytes()).hexdigest()}}
            stack.enter_context(patch.object(storage, 'BASE', root))
            stack.enter_context(patch.object(storage, 'READ_ONLY_BASELINES', readonly, create=True))
            original_read_text = Path.read_text

            def read_text(path, *args, **kwargs):
                if path == Path('/proc/meminfo'):
                    return 'MemTotal: 2048 kB\nMemAvailable: 1024 kB\n'
                return original_read_text(path, *args, **kwargs)

            def command(*args):
                if args[:2] == ('docker', 'ps'):
                    return 'fixture-mysql'
                if args[:3] == ('docker', 'image', 'ls'):
                    return ''
                if args[:2] == ('docker', 'inspect'):
                    return 'sha256:' + 'a' * 64
                if args[:2] == ('docker', 'exec'):
                    self.assertTrue(args[-1].startswith('SET TRANSACTION READ ONLY; START TRANSACTION; '))
                    self.assertTrue(args[-1].endswith('; ROLLBACK;'))
                    self.assertNotIn('DELETE', args[-1])
                    return '{"kind":"auditTotal","count":49}'
                if args[:2] == ('docker', 'stats'):
                    if during_diagnostics:
                        during_diagnostics(root, current, previous)
                    return '{"Name":"fixture-mysql"}'
                if args[0] == 'du':
                    return '1 /var/lib/docker'
                self.fail('Unexpected diagnostic command: ' + repr(args))

            stack.enter_context(patch.object(Path, 'read_text', read_text))
            commands = stack.enter_context(patch.object(storage, 'read', side_effect=command))
            yield root, current, previous, commands

    def invoke_diagnose(self, expected):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['storage-maintenance.py', '--operation', 'diagnose',
                                       '--expected-current', expected]), redirect_stdout(output):
            storage.main()
        envelope = json.loads(output.getvalue().removeprefix('STORAGE_MAINTENANCE '))
        return json.loads(gzip.decompress(base64.b64decode(envelope['payload'])))

    def test_current_registration_cli_diagnose_is_readonly(self):
        with self.fixture(), patch.object(storage, 'cleanup_audit') as audit, \
                patch.object(storage, 'cleanup_legacy_cache') as legacy:
            result = self.invoke_diagnose(self.CURRENT)
        self.assertEqual(result['mode'], 'READ_ONLY')
        self.assertEqual(result['currentCommit'], self.CURRENT)
        audit.assert_not_called()
        legacy.assert_not_called()

    def test_current_baseline_cannot_enter_any_other_cli_operation(self):
        for operation in ('cleanup-audit', 'verify-legacy-cache', 'cleanup-legacy-cache'):
            with self.subTest(operation=operation), self.fixture() as fixture, \
                    patch.object(storage, 'cleanup_audit') as audit, \
                    patch.object(storage, 'cleanup_legacy_cache') as legacy, \
                    patch.object(sys, 'argv', ['storage-maintenance.py', '--operation', operation,
                        '--expected-current', self.CURRENT, '--approved-scope', storage.APPROVED_SCOPE]):
                with self.assertRaisesRegex(RuntimeError, 'Scope production baseline differs'):
                    storage.main()
                fixture[3].assert_not_called()
                audit.assert_not_called()
                legacy.assert_not_called()

    def test_unreviewed_readonly_baseline_is_rejected_before_commands(self):
        with self.fixture() as fixture:
            with self.assertRaisesRegex(RuntimeError, 'Scope production baseline differs'):
                self.invoke_diagnose('f' * 40)
            fixture[3].assert_not_called()

    def test_reviewed_historical_baselines_keep_readonly_support(self):
        for expected in storage.REVIEWED_BASELINES:
            with self.subTest(expected=expected), self.fixture(expected):
                self.assertEqual(self.invoke_diagnose(expected)['currentCommit'], expected)

    def test_current_and_previous_version_path_or_bytes_drift_is_rejected(self):
        def mutate(root, current, previous, kind):
            if kind == 'current-path':
                other = root / 'releases' / 'different-current'
                other.mkdir()
                (other / 'release-manifest.json').write_bytes((current / 'release-manifest.json').read_bytes())
                (root / 'current').unlink()
                (root / 'current').symlink_to(other)
            elif kind == 'previous-symlink':
                other = root / 'releases' / 'different-previous'
                previous.rename(other)
                previous.symlink_to(other)
            else:
                path = (previous if kind in ('previous-version', 'previous-bytes') else current) / 'release-manifest.json'
                manifest = json.loads(path.read_text())
                if kind.endswith('-version'):
                    manifest['commit'] = 'f' * 40
                elif kind == 'previous-path':
                    manifest['previousRelease'] = str(root / 'releases' / 'different-previous')
                else:
                    manifest['extra'] = 'public-fixture-drift'
                path.write_text(json.dumps(manifest))

        kinds = ('current-path', 'current-version', 'current-bytes',
                 'previous-path', 'previous-version', 'previous-bytes', 'previous-symlink')
        for kind in kinds:
            for during in (False, True):
                with self.subTest(kind=kind, during=during), self.fixture(
                        during_diagnostics=(lambda r, c, p: mutate(r, c, p, kind)) if during else None) as fixture:
                    if not during:
                        mutate(*fixture[:3], kind)
                    with self.assertRaises(RuntimeError):
                        self.invoke_diagnose(self.CURRENT)
                    if not during:
                        fixture[3].assert_not_called()

    def test_production_readonly_pins_do_not_expand_cleanup_allowlist(self):
        self.assertNotIn(self.CURRENT, storage.REVIEWED_BASELINES)
        self.assertNotIn(self.PREVIOUS, storage.REVIEWED_BASELINES)
        self.assertEqual(storage.READ_ONLY_BASELINES[self.CURRENT], {
            'release': self.RELEASE, 'previousRelease': self.PREVIOUS_RELEASE,
            'previousCommit': self.PREVIOUS,
            'manifestSha256': '52f2582e5edeb9e1c9af63c70fff4ca5a5bdad11c0fd7fb8f090fd1670b4c2eb',
            'previousManifestSha256': '0aacc82fc257bc2c4837a4b513223a01ec4f608fbacc0b009c1551b5ceb18b97'})


class ReleaseArchiveCacheTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with StorageReadonlyBaselineTests().fixture() as baseline, ExitStack() as stack:
            self.root, self.current, self.previous = baseline[:3]
            self.path = self.root / storage.ARCHIVE_CACHE_RELATIVE
            self.path.parent.mkdir(parents=True)
            self.payload = b'H' * 65536 + b'C' * 65536 + b'T' * 65536
            self.path.write_bytes(self.payload)
            self.neighbor = self.path.parent / 'ci-release-manifest.json'
            self.neighbor.write_text(json.dumps({'commit': 'f35785f0b90ff750c55fb33ed06ae8d0f7af5feb',
                'releaseTag': 'v2-production-20260907T085408Z', 'artifact': {
                    'file': storage.ARCHIVE_CACHE_FILE, 'sha256': hashlib.sha256(self.payload).hexdigest()}}))
            self.sums = self.path.parent / 'SHA256SUMS'
            # The old producer writes release-manifest.json; deployment renames only its local copy.
            self.sums.write_text(hashlib.sha256(self.payload).hexdigest() + '  ' + storage.ARCHIVE_CACHE_FILE
                + '\n' + hashlib.sha256(self.neighbor.read_bytes()).hexdigest() + '  release-manifest.json\n')
            self.configuration = ('fixture-private-bucket', 'mysql/daily', 'ap-northeast-1')
            self.commands, self.cloud, self.mounts, self.processes = [], None, [], []
            self.upload_failure, self.head_change, self.range_change, self.after_ranges = False, {}, False, None
            original_iterdir = Path.iterdir

            def iterdir(path):
                return iter(self.processes) if path == Path('/proc') else original_iterdir(path)

            stack.enter_context(patch.object(storage, 'ARCHIVE_CACHE_SIZE', len(self.payload)))
            stack.enter_context(patch.object(Path, 'iterdir', iterdir))
            stack.enter_context(patch.object(storage, 'helper', side_effect=lambda name:
                SimpleNamespace(configuration=lambda: self.configuration) if name == 'cleanup-verified-backups'
                else self.fail('Unexpected helper')))
            self.command_mock = stack.enter_context(patch.object(storage.subprocess, 'run', side_effect=self.command))
            yield

    def command(self, arguments, **options):
        self.commands.append(arguments)
        self.assertLessEqual(options['timeout'], 300)
        self.assertEqual(options['env']['AWS_MAX_ATTEMPTS'], '1')
        if arguments[:2] == ['docker', 'ps']:
            return SimpleNamespace(returncode=0, stdout='a' * 64 + '\n', stderr='')
        if arguments[:2] == ['docker', 'inspect']:
            self.assertEqual(arguments[2:4], ['--format', '{{json .Mounts}}'])
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.mounts), stderr='')
        self.assertEqual(arguments[:2], ['aws', 's3api'])
        if 'put-object' in arguments:
            self.assertEqual(arguments[arguments.index('--if-none-match') + 1], '*')
            self.assertEqual(arguments[arguments.index('--body') + 1], str(self.path))
            self.assertEqual(arguments[arguments.index('--server-side-encryption') + 1], 'AES256')
            if self.upload_failure:
                return SimpleNamespace(returncode=1, stdout='', stderr='private-upload-fixture-output')
            self.cloud = self.path.read_bytes()
            return SimpleNamespace(returncode=0, stdout='{}', stderr='')
        if 'head-object' in arguments:
            if self.cloud is None:
                return SimpleNamespace(returncode=1, stdout='', stderr='private-head-fixture-output')
            value = {'ContentLength': len(self.cloud),
                'ChecksumSHA256': base64.b64encode(hashlib.sha256(self.cloud).digest()).decode(),
                'ServerSideEncryption': 'AES256', **self.head_change}
            return SimpleNamespace(returncode=0, stdout=json.dumps(value), stderr='')
        self.assertIn('get-object', arguments)
        start, end = map(int, arguments[arguments.index('--range') + 1].removeprefix('bytes=').split('-'))
        destination = Path(arguments[-3])
        self.assertTrue(destination.is_relative_to(self.root / 'maintenance/release-artifact-cache'))
        content = self.cloud[start:end+1]
        destination.write_bytes(b'X' * len(content) if self.range_change else content)
        if start and self.after_ranges:
            self.after_ranges()
        return SimpleNamespace(returncode=0, stdout='{}', stderr='')

    def plan(self):
        return storage.release_archive_cache(storage.ARCHIVE_CACHE_CURRENT)

    def apply(self, digest):
        return storage.release_archive_cache(storage.ARCHIVE_CACHE_CURRENT, digest, apply=True)

    def aws_operations(self):
        return [next(name for name in ('put-object', 'head-object', 'get-object') if name in arguments)
                for arguments in self.commands if arguments[0] == 'aws']

    def test_readonly_plan_binds_file_neighbors_baseline_and_private_target_without_cloud_write(self):
        with self.fixture():
            result = self.plan()
            plan = result['plan']
            self.assertEqual(result['mode'], 'PLAN_ONLY')
            self.assertEqual(result['planSha256'], storage.archive_digest(plan))
            self.assertEqual(plan['archive']['sha256'], hashlib.sha256(self.payload).hexdigest())
            self.assertEqual(plan['archive']['identity'], storage.archive_identity(self.path.stat()))
            self.assertEqual(set(plan['neighborSha256']), {'ci-release-manifest.json', 'SHA256SUMS'})
            self.assertEqual(plan['currentManifestSha256'], hashlib.sha256(
                (self.current / 'release-manifest.json').read_bytes()).hexdigest())
            self.assertEqual(plan['previousManifestSha256'], hashlib.sha256(
                (self.previous / 'release-manifest.json').read_bytes()).hexdigest())
            self.assertNotIn(self.configuration[0], json.dumps(result))
            self.assertEqual(self.aws_operations(), [])
            self.assertTrue(self.path.exists())

    def test_success_verifies_cloud_and_ranges_then_removes_only_fixed_archive_with_durable_receipt(self):
        with self.fixture():
            original = {p: p.read_bytes() for p in (self.neighbor, self.sums,
                self.current / 'release-manifest.json', self.previous / 'release-manifest.json')}
            self.head_change['Expiration'] = 'expiry-date="Sat, 09 Jan 2027 00:00:00 GMT", rule-id="fixture"'
            with patch.object(storage.os, 'fsync', wraps=os.fsync) as synced:
                result = self.apply(self.plan()['planSha256'])
            self.assertFalse(self.path.exists())
            self.assertTrue(result['cloudRecoveryVerified'])
            self.assertEqual(result['removedRelativePath'], storage.ARCHIVE_CACHE_RELATIVE)
            self.assertEqual(result['remoteExpiration'], '2027-01-09T00:00:00+00:00')
            self.assertTrue(result['retentionPolicyExisting'])
            self.assertEqual(self.aws_operations(), ['put-object', 'head-object', 'get-object', 'get-object'])
            self.assertGreaterEqual(synced.call_count, 5)
            for path, content in original.items():
                self.assertEqual(path.read_bytes(), content)
            receipt = next((self.root / 'maintenance/release-artifact-cache').glob('*.json'))
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(receipt.read_bytes()), result)

    def test_missing_or_wrong_exact_plan_cannot_upload_or_delete(self):
        with self.fixture():
            for digest in (None, 'invalid', 'a' * 64):
                with self.subTest(digest=digest), self.assertRaises(RuntimeError):
                    self.apply(digest)
            self.assertTrue(self.path.exists())
            self.assertEqual(self.aws_operations(), [])

    def test_changed_file_neighbors_or_s3_target_invalidates_plan_before_upload(self):
        for location in ('bytes', 'identity', 'manifest', 'checksums', 'target'):
            with self.subTest(location=location), self.fixture():
                digest = self.plan()['planSha256']
                if location == 'bytes':
                    self.path.write_bytes(b'X' + self.payload[1:])
                elif location == 'identity':
                    data = self.path.read_bytes(); self.path.unlink(); self.path.write_bytes(data)
                elif location == 'manifest':
                    self.neighbor.write_text(self.neighbor.read_text() + '\n')
                elif location == 'checksums':
                    self.sums.write_text(self.sums.read_text() + '\n')
                else:
                    self.configuration = ('different-fixture-bucket', *self.configuration[1:])
                with self.assertRaises(RuntimeError):
                    self.apply(digest)
                self.assertTrue(self.path.exists())
                self.assertEqual(self.aws_operations(), [])

    def test_cloud_wrong_hash_size_encryption_or_checksum_type_never_removes_archive(self):
        for change in ({'ChecksumSHA256': 'wrong'}, {'ContentLength': 1},
                       {'ServerSideEncryption': 'aws:kms'}, {'ChecksumType': 'COMPOSITE'}):
            with self.subTest(change=change), self.fixture():
                digest = self.plan()['planSha256']; self.head_change = change
                with self.assertRaisesRegex(RuntimeError, 'cloud recovery identity differs'):
                    self.apply(digest)
                self.assertTrue(self.path.exists())
                self.assertEqual(self.aws_operations(), ['put-object', 'head-object'])

    def test_upload_failure_without_verified_recovery_keeps_archive_and_suppresses_raw_output(self):
        with self.fixture():
            self.upload_failure = True
            with self.assertRaisesRegex(RuntimeError, 'command failed: HEAD') as error:
                self.apply(self.plan()['planSha256'])
            self.assertNotIn('private-', str(error.exception))
            self.assertTrue(self.path.exists())
            self.assertEqual(self.aws_operations(), ['put-object', 'head-object'])

    def test_existing_same_cloud_copy_can_resume_after_single_conditional_upload_failure(self):
        with self.fixture():
            self.cloud = self.payload; self.upload_failure = True
            result = self.apply(self.plan()['planSha256'])
            self.assertTrue(result['cloudRecoveryVerified'])
            self.assertFalse(self.path.exists())
            self.assertEqual(self.aws_operations(), ['put-object', 'head-object', 'get-object', 'get-object'])

    def test_cloud_range_mismatch_and_local_change_after_upload_prevent_removal(self):
        for kind in ('range', 'local'):
            with self.subTest(kind=kind), self.fixture():
                digest = self.plan()['planSha256']
                if kind == 'range':
                    self.range_change = True
                else:
                    self.after_ranges = lambda: self.path.write_bytes(b'X' + self.payload[1:])
                with self.assertRaises(RuntimeError):
                    self.apply(digest)
                self.assertTrue(self.path.exists())

    def test_container_mount_and_open_descriptor_block_plan_before_upload(self):
        for kind in ('mount', 'fd'):
            with self.subTest(kind=kind), self.fixture():
                if kind == 'mount':
                    self.mounts = [{'Source': str(self.path.parent), 'Type': 'bind'}]
                else:
                    process = self.root / 'proc-fixture/12345678'
                    (process / 'fd').mkdir(parents=True)
                    (process / 'fd/4').symlink_to(self.path)
                    self.processes = [process]
                with self.assertRaisesRegex(RuntimeError, 'mounted|open by another process'):
                    self.plan()
                self.assertTrue(self.path.exists())
                self.assertEqual(self.aws_operations(), [])

    def test_tmpfs_without_host_source_is_allowed_but_malformed_or_unknown_mounts_fail_closed(self):
        for source in ('', None):
            with self.subTest(validSource=source), self.fixture():
                self.mounts = [{'Type': 'tmpfs', 'Source': source, 'Destination': '/tmp',
                                'Mode': '', 'RW': True, 'Propagation': ''}]
                self.assertEqual(self.plan()['mode'], 'PLAN_ONLY')
                self.assertTrue(self.path.exists())
                self.assertEqual(self.aws_operations(), [])
        for mount in (
                {'Type': 'tmpfs', 'Source': '/host', 'Destination': '/tmp'},
                {'Type': 'tmpfs', 'Source': '', 'Destination': 'tmp'},
                {'Type': 'tmpfs', 'Source': '', 'Destination': None},
                {'Type': 'tmpfs', 'Source': 0, 'Destination': '/tmp'},
                {'Type': 'unknown', 'Source': '/host', 'Destination': '/tmp'},
                {'Type': 'bind', 'Source': '', 'Destination': '/tmp'},
                {'Type': 'volume', 'Source': None, 'Destination': '/tmp'}):
            with self.subTest(invalidMount=mount), self.fixture():
                self.mounts = [mount]
                with self.assertRaisesRegex(RuntimeError, 'mount inventory unavailable'):
                    self.plan()
                self.assertTrue(self.path.exists())
                self.assertEqual(self.aws_operations(), [])

    def test_archive_symlink_or_wrong_baseline_is_rejected_without_commands(self):
        with self.fixture():
            saved = self.path.with_suffix('.saved'); self.path.rename(saved); self.path.symlink_to(saved)
            with self.assertRaisesRegex(RuntimeError, 'path changed'):
                self.plan()
            self.command_mock.assert_not_called()
            for expected in (storage.EXPECTED, StorageReadonlyBaselineTests.PREVIOUS, 'f' * 40):
                with self.assertRaisesRegex(RuntimeError, 'production baseline differs'):
                    storage.release_archive_cache(expected)
            self.command_mock.assert_not_called()

    def test_cli_uses_existing_envelope_and_rejects_conflicting_write_inputs(self):
        with self.fixture(), redirect_stdout(io.StringIO()) as output:
            arguments = ['storage-maintenance.py', '--operation', 'verify-release-archive-cache',
                         '--expected-current', storage.ARCHIVE_CACHE_CURRENT]
            with patch.object(sys, 'argv', arguments):
                storage.main()
            envelope = json.loads(output.getvalue().removeprefix('STORAGE_MAINTENANCE '))
            result = json.loads(gzip.decompress(base64.b64decode(envelope['payload'])))
            self.assertEqual(result['mode'], 'PLAN_ONLY')
            for extra in (['--plan-sha256', 'a' * 64], ['--approved-scope', storage.APPROVED_SCOPE]):
                with patch.object(sys, 'argv', arguments + extra), self.assertRaises(RuntimeError):
                    storage.main()


class StorageSafetyTests(unittest.TestCase):
    def test_legacy_cache_recovery_sources_remain_in_main_with_build_recipes(self):
        plan = storage.legacy_cache_plan(Path('deploy/aws/cache-cleanup-legacy-20261002.json').read_text())
        for source in plan['sources']:
            subprocess.run(['git', 'merge-base', '--is-ancestor', source['commit'], 'HEAD'], check=True)
            for path in [source['lockFile'], *source['dockerfiles']]:
                subprocess.run(['git', 'cat-file', '-e', source['commit'] + ':' + path], check=True)

    def test_legacy_cache_modified_plan_is_rejected_before_docker_access(self):
        plan = json.loads(Path('deploy/aws/cache-cleanup-legacy-20261002.json').read_text())
        plan['items'][0]['references'] = ['mysql:8.4']
        with self.assertRaisesRegex(RuntimeError, 'reviewed digest'):
            storage.legacy_cache_plan(json.dumps(plan))

    def test_legacy_cache_protects_exited_containers_before_any_removal(self):
        text = Path('deploy/aws/cache-cleanup-legacy-20261002.json').read_text()
        plan = json.loads(text)
        with tempfile.TemporaryDirectory(dir='.deploy') as directory:
            root = Path(directory)
            (root / 'current').mkdir()
            (root / 'previous').mkdir()
            (root / 'current/release-manifest.json').write_text(json.dumps(
                {'previousRelease': str((root / 'previous').resolve()), 'images': {}}))
            (root / 'previous/release-manifest.json').write_text(json.dumps(
                {'commit': plan['expectedPrevious'], 'images': {}}))
            with patch.object(storage, 'BASE', root), patch.object(storage, 'baseline'), \
                    patch.object(storage, 'container_images', return_value={plan['items'][0]['imageId']}), \
                    patch.object(storage, 'read') as command:
                with self.assertRaisesRegex(RuntimeError, 'used by a container'):
                    storage.cleanup_legacy_cache(plan['expectedCurrent'], text, apply=True)
                command.assert_not_called()

    def test_archive_config_identity_is_verified_without_extracting_secrets(self):
        payload = b'{"Env":["PRIVATE=never-output"]}'
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory(dir='.deploy') as directory:
            path = Path(directory) / 'images.tar.gz'
            with tarfile.open(path, 'w:gz') as archive:
                for name, data in ((digest + '.json', payload), ('manifest.json', json.dumps([
                        {'Config': digest + '.json', 'RepoTags': ['id-business-v2-api:test'],
                         'Layers': []}]).encode())):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            result = storage.archived_images(path)
        self.assertEqual(result, [{'imageId': 'sha256:' + digest, 'configVerified': True,
                                   'repoTags': ['id-business-v2-api:test']}])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_archive_fake_config_identity_and_path_traversal_do_not_prove_recovery(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as directory:
            path = Path(directory) / 'images.tar'
            with tarfile.open(path, 'w') as archive:
                for name, data in (('a' * 64 + '.json', b'wrong config'), ('manifest.json',
                        json.dumps([{'Config': 'a' * 64 + '.json'},
                                    {'Config': '../../secret.json'}]).encode())):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            self.assertEqual(storage.archived_images(path), [])

    def test_archive_metadata_budget_preserves_inventory_without_claiming_recovery(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as directory:
            root = Path(directory).resolve()
            (root / 'artifacts').mkdir()
            for name in ('a.tar', 'b.tar', 'note.json'):
                (root / 'artifacts' / name).write_bytes(b'public-fixture')
            with patch.object(storage, 'BASE', root), patch.object(storage, 'archived_images',
                    side_effect=RuntimeError('Archive metadata time budget exceeded')) as metadata:
                result = storage.archive_inventory()
            metadata.assert_called_once()
        self.assertEqual([item['path'] for item in result],
                         ['artifacts/a.tar', 'artifacts/b.tar', 'artifacts/note.json'])
        self.assertTrue(all(item['bytes'] == len(b'public-fixture') for item in result))
        self.assertTrue(all(item['archiveMetadataStatus'] == 'TIME_BUDGET_EXCEEDED'
                            and 'dockerImages' not in item for item in result[:2]))
        self.assertNotIn('archiveMetadataStatus', result[2])

    def test_unknown_archive_runtime_failure_is_not_silently_accepted(self):
        with tempfile.TemporaryDirectory(dir='.deploy') as directory:
            root = Path(directory).resolve()
            (root / 'artifacts').mkdir()
            (root / 'artifacts/a.tar').write_bytes(b'public-fixture')
            with patch.object(storage, 'BASE', root), patch.object(storage, 'archived_images',
                    side_effect=RuntimeError('UNEXPECTED_METADATA_FAILURE')):
                with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_METADATA_FAILURE'):
                    storage.archive_inventory()

    def test_destructive_scope_requires_exact_approval(self):
        with self.assertRaisesRegex(RuntimeError, 'approval required'):
            storage.cleanup_audit(storage.EXPECTED, None)

    def test_other_production_baseline_rejected_before_access(self):
        with self.assertRaisesRegex(RuntimeError, 'baseline differs'):
            storage.baseline('f' * 40)

    def test_candidates_protect_every_foreign_key(self):
        other = {'table': 'another_reference', 'column': 'audit_id', 'sameSchema': 1}
        predicate = storage.audit_predicate([REF, other])
        self.assertIn('`id_business_v2_governance_job_items`', predicate)
        self.assertIn('`another_reference`', predicate)
        self.assertIn('a.user_id IS NULL', predicate)
        self.assertIn("<> 'manual'", predicate)
        self.assertNotIn('settings.update', predicate)
        self.assertNotIn('collect.failed', predicate)
        self.assertIn("a.created_at < '2026-10-02 11:00:00'", predicate)

    def test_unknown_schema_and_injected_identifier_fail_closed(self):
        for ref in ({**REF, 'sameSchema': 0}, {**REF, 'table': 'audit_logs; DELETE'}):
            with self.assertRaises(RuntimeError):
                storage.audit_predicate([ref])

    def test_preview_above_reviewed_limit_blocks(self):
        with patch.object(storage, 'references', return_value=[REF]), \
                patch.object(storage, 'mysql', return_value='\n'.join(
                    ['00000000-0000-0000-0000-000000000001'] * (storage.MAX_APPROVED_COUNT + 1))):
            with self.assertRaisesRegex(RuntimeError, 'exceeds approved scope'):
                storage.preview_audit('mysql')

    def test_preview_rejects_non_uuid_values(self):
        with patch.object(storage, 'references', return_value=[]), \
                patch.object(storage, 'mysql', return_value='unexpected-row-payload'):
            with self.assertRaisesRegex(RuntimeError, 'Unexpected audit ID'):
                storage.preview_audit('mysql')

    def test_delete_requires_verified_backup_and_valid_snapshot(self):
        preview = {'count': 12, 'idsSha256': 'a' * 64, 'references': [REF]}
        for data in ({**BACKUP, 's3Verified': False}, {**BACKUP, 'name': "bad'path"}):
            with self.assertRaises(RuntimeError):
                storage.deletion_sql(preview, data)
        for count in (0, storage.MAX_APPROVED_COUNT + 1):
            with self.assertRaises(RuntimeError):
                storage.deletion_sql({**preview, 'count': count}, BACKUP)

    def test_atomic_delete_checks_count_hash_and_logs_only_success(self):
        sql = storage.deletion_sql({'count': 12, 'idsSha256': 'a' * 64, 'references': [REF]}, BACKUP)
        self.assertIn('ISOLATION LEVEL SERIALIZABLE; START TRANSACTION', sql)
        self.assertIn('@candidate_count=12', sql)
        self.assertIn("@candidate_hash='" + 'a' * 64 + "'", sql)
        self.assertIn('WHERE @deleted=12; SET @idv2_routine_audit_cleanup_scope=NULL; COMMIT', sql)
        self.assertIn("SET @idv2_routine_audit_cleanup_scope='" + storage.APPROVED_SCOPE + "'", sql)
        self.assertIn('maintenance.audit_log.cleanup', sql)
        for prohibited in ('TRUNCATE', 'FOREIGN_KEY_CHECKS', 'OPTIMIZE', 'DROP TABLE'):
            self.assertNotIn(prohibited, sql)

    def test_failures_never_include_private_stdout_stderr(self):
        class Result:
            returncode = 1
            stdout = 'PRIVATE_ROW_DATA'
            stderr = 'PRIVATE_CREDENTIAL'
        with patch.object(storage.subprocess, 'run', return_value=Result()):
            with self.assertRaises(RuntimeError) as failure:
                storage.read('diagnostic')
        self.assertNotIn('PRIVATE', str(failure.exception))

    def test_timeout_reports_only_fixed_phase_without_private_command_or_output(self):
        for command, phase in ((('du', 'PRIVATE_PATH'), 'DIRECTORY_USAGE'),
                               (('docker', 'exec', 'PRIVATE_ARGUMENT'), 'DATABASE_QUERY'),
                               (('docker', 'inspect', 'PRIVATE_ARGUMENT'), 'DOCKER_METADATA'),
                               (('PRIVATE_COMMAND',), 'COMMAND')):
            with self.subTest(phase=phase), patch.object(storage.subprocess, 'run',
                    side_effect=subprocess.TimeoutExpired(command, 120,
                        output='PRIVATE_STDOUT', stderr='PRIVATE_STDERR')):
                with self.assertRaisesRegex(RuntimeError, '^Diagnostic command timed out: ' + phase + '$'):
                    storage.read(*command)

    def test_retention_migration_cannot_expand_the_approved_exception(self):
        sql = Path('apps/api/prisma-mysql/migrations/' + storage.RETENTION_MIGRATION + '/migration.sql').read_text()
        self.assertEqual(storage.retention_migration(sql), sql)
        with self.assertRaisesRegex(RuntimeError, 'approved digest'):
            storage.retention_migration(sql.replace("= 'root'", "<> 'root'"))

    def test_readonly_mysql_wraps_query_without_embedding_password(self):
        with patch.object(storage, 'read', return_value='1') as command:
            self.assertEqual(storage.mysql('mysql', 'SELECT COUNT(*) FROM audit_logs'), '1')
        args = command.call_args.args
        self.assertIn('SET TRANSACTION READ ONLY', args[-1])
        self.assertIn('ROLLBACK', args[-1])
        self.assertIn('MYSQL_PWD="$MYSQL_ROOT_PASSWORD"', args[-3])

    def test_workflow_has_fixed_scope_and_no_arbitrary_command_input(self):
        workflow = Path('.github/workflows/production-release.yml').read_text()
        self.assertIn('STORAGE_OPERATION:', workflow)
        self.assertIn('--approved-scope audit-routine-20261002T110000Z', workflow)
        self.assertNotIn('inputs.sql', workflow)
        self.assertNotIn('inputs.command', workflow)


if __name__ == '__main__':
    unittest.main()
