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



class StorageCurrentReadonlyTests(unittest.TestCase):
    PRODUCER = {'commit':'c'*40,'sourceTree':'d'*40,'workflowRunId':'9','workflowRunAttempt':'1'}
    UUID = '12345678-1234-1234-1234-123456789abc'

    @classmethod
    def setUpClass(cls):
        cls.project = Path(__file__).resolve().parents[2]
        cls.runtime = cls.project/'.runtime/storage-readonly-0a-20261011/tests'
        cls.runtime.mkdir(parents=True,exist_ok=True)
        cls.payload,cls.binding = storage.parameters(cls.PRODUCER,source=cls.project)

    def successful(self):
        class Guard:
            current=Path('/opt/id-business-v2/releases/20261009T000000Z-0a03fa28e6b8')
            manifests=[{'previousCommit':'a'*40}]
            previous_sha='b'*64
            def __init__(self,deadline): self.deadline=deadline
            def open(self): pass
            def verify(self): pass
            def remaining(self): pass
            def close(self): pass
        driver=SimpleNamespace(native=lambda *args,**kwargs:'',snapshot=lambda current:storage.STORAGE_SERVICES_SHA)
        with tempfile.TemporaryDirectory(dir=self.runtime) as directory:
            root=Path(directory);(root/'.staging').mkdir()
            with patch.object(storage,'BASE',root),patch.object(storage,'StorageGuard',Guard), \
                 patch.object(storage,'storage_root',return_value=True), \
                 patch.object(storage.shutil,'disk_usage',return_value=SimpleNamespace(total=100,used=60,free=35)), \
                 patch.object(storage,'storage_directory_usage',side_effect=lambda role,path,deadline:{'role':role,'status':'MISSING','allocatedBytes':None}), \
                 patch.object(storage,'storage_cache',return_value={'status':'UNAVAILABLE','rows':[]}):
                # shutil.disk_usage returns a tuple-compatible namedtuple.
                from collections import namedtuple
                with patch.object(storage.shutil,'disk_usage',return_value=namedtuple('Usage','total used free')(100,60,35)):
                    return storage.storage_execute(self.binding,lambda current,client:driver)

    @contextmanager
    def real_guard(self, previous='a'*40):
        with tempfile.TemporaryDirectory(dir=self.runtime) as directory,ExitStack() as stack:
            base=Path(directory);releases=base/'releases';releases.mkdir()
            current=releases/('20261009T000000Z-'+storage.STORAGE_BASELINE[:12]);current.mkdir()
            prior=releases/('20261008T000000Z-'+previous[:12]);prior.mkdir()
            (base/'current').symlink_to(current)
            (current/'release-manifest.json').write_text(json.dumps({'commit':storage.STORAGE_BASELINE,
                'previousCommit':previous,'previousRelease':str(prior)}))
            (prior/'release-manifest.json').write_text(json.dumps({'commit':previous}))
            (current/'docker-compose.aws-mysql.yml').write_text('services: {}\n')
            for path in (current/'release-manifest.json',prior/'release-manifest.json',current/'docker-compose.aws-mysql.yml'):path.chmod(0o600)
            original_stat,original_fstat=os.stat,os.fstat
            def root_metadata(row):
                return SimpleNamespace(**{name:(0 if name=='st_uid' else getattr(row,name)) for name in
                    ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
            stack.enter_context(patch.object(storage,'BASE',base))
            stack.enter_context(patch.object(storage,'STORAGE_CURRENT_SHA',storage.storage_sha((current/'release-manifest.json').read_bytes())))
            stack.enter_context(patch.object(storage,'STORAGE_COMPOSE_SHA',storage.storage_sha((current/'docker-compose.aws-mysql.yml').read_bytes())))
            stack.enter_context(patch.object(storage.os,'stat',side_effect=lambda *args,**kwargs:root_metadata(original_stat(*args,**kwargs))))
            stack.enter_context(patch.object(storage.os,'fstat',side_effect=lambda fd:root_metadata(original_fstat(fd))))
            guard=storage.StorageGuard(storage.time.monotonic()+60)
            try:yield guard,base,current,prior
            finally:guard.close()

    def artifact(self,result):
        return {'kind':'STORAGE_READONLY_ARTIFACT_V1','operation':'diagnose_storage','producer':self.PRODUCER,
            'expectedCurrent':storage.STORAGE_BASELINE,'commandId':self.UUID,
            'status':'OPERATION_COMPLETED' if result and result['status']=='DIAGNOSED' else 'OPERATION_FAILED',
            'code':result['code'] if result else 'TRANSPORT_UNAVAILABLE','result':result}

    def test_parameters_project_root_default_and_six_source_seals(self):
        payload,binding=storage.parameters(self.PRODUCER)
        self.assertEqual(payload,self.payload);self.assertEqual(binding,self.binding)
        self.assertEqual(set(binding['sourcePins']),set(storage.STORAGE_SOURCES))
        for path,row in binding['sourcePins'].items():
            raw=(self.project/path).read_bytes();self.assertEqual(row,{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        self.assertLess(len(storage.storage_canonical(payload)),20480)
        self.assertEqual(payload['executionTimeout'],['600'])

    def test_captured_only_original_snapshot_and_readonly_body(self):
        import ast,shlex,zlib
        command=shlex.split(self.payload['commands'][-1]);self.assertEqual(command[:2],['python3','-c'])
        tree=ast.parse(command[2]);encoded=next(n.args[0].value for n in ast.walk(tree) if isinstance(n,ast.Call)
            and isinstance(n.func,ast.Attribute) and n.func.attr=='b64decode')
        raw=zlib.decompress(base64.b64decode(encoded),31)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),self.binding['capturedProgramSha256'])
        self.assertEqual(len(raw),self.binding['capturedProgramBytes']);ast.parse(raw)
        for forbidden in ('formal_runtime_commands','stopped_orchestrator','cleanup_audit','cleanup_legacy_cache','database_read','MYSQL_PWD'):
            self.assertNotIn(forbidden,raw.decode())
        self.assertIn('servicesBeforeSha256',raw.decode())
        snapshot_text=(self.project/storage.STORAGE_SOURCES[2]).read_text()
        self.assertIn('class NativeSnapshotDriver',snapshot_text)

    def test_captured_native_dependency_closure_and_original_seven_service_snapshot(self):
        import ast,builtins,dis,shlex,types,zlib
        tree=ast.parse(shlex.split(self.payload['commands'][-1])[2])
        encoded=next(n.args[0].value for n in ast.walk(tree) if isinstance(n,ast.Call)
            and isinstance(n.func,ast.Attribute) and n.func.attr=='b64decode')
        raw=zlib.decompress(base64.b64decode(encoded),31);program=ast.parse(raw)
        self.assertEqual([type(n).__name__ for n in program.body[-3:]],['Assign','Expr','Raise'])
        program.body=program.body[:-3];namespace={}
        exec(compile(program,'<synthetic-captured-dependencies>','exec'),namespace)
        modules=namespace['loaded'];snapshot=modules['snapshot']
        # Check global dependencies throughout the unchanged captured native driver,
        # including the nested snapshot diagnostic closures.
        def check(code):
            for instruction in dis.get_instructions(code):
                if instruction.opname=='LOAD_GLOBAL':
                    self.assertTrue(instruction.argval in snapshot.__dict__ or hasattr(builtins,instruction.argval),instruction.argval)
            for value in code.co_consts:
                if isinstance(value,types.CodeType):check(value)
        for value in snapshot.__dict__.values():
            if isinstance(value,types.FunctionType):check(value.__code__)
        for value in snapshot.NativeSnapshotDriver.__dict__.values():
            function=value.__func__ if isinstance(value,staticmethod) else value
            if isinstance(function,types.FunctionType):check(function.__code__)
        directory=snapshot.BASE/'releases'/('20261009T000000Z-'+snapshot.BASELINE[:12])
        driver=namespace['factory'](directory,Path('/synthetic/private-client'));rows={};calls=[]
        for role in snapshot.ROLES:
            cid=hashlib.sha256(role.encode()).hexdigest()
            rows[cid]={'Id':cid,'Image':'sha256:'+hashlib.sha256((role+'-image').encode()).hexdigest(),
                'Config':{'Image':'fixture/'+role+':local','Env':['PRIVATE_FIXTURE=only_in_RAM'],
                    'Labels':{}},'HostConfig':{},'Mounts':[],
                'State':{'Status':'running','StartedAt':'2026-10-09T00:00:00Z',
                    **({'Health':{'Status':'healthy'}} if role!='caddy' else {})}}
        def native(*args,**kwargs):
            calls.append(args)
            if args[:2]==('container','ls'):return '\n'.join(rows)
            self.assertEqual(args[0],'inspect')
            if args[1:3]==('--format',snapshot.PUBLIC_LABEL_FORMAT):
                cid=args[-1];role=next(role for role in snapshot.ROLES if hashlib.sha256(role.encode()).hexdigest()==cid)
                return json.dumps({'id':cid,'project':'synthetic_project','role':role,'directory':str(directory),
                    'files':','.join(str(directory/name) for name in ('docker-compose.aws-mysql.yml','compose.release.json'))})
            return json.dumps([rows[args[-1]]])
        output=io.StringIO()
        with patch.object(driver,'native',side_effect=native),patch.object(Path,'is_file',return_value=False),redirect_stdout(output):
            label=driver.public_labels(next(iter(rows)))
            digest=driver.snapshot(directory)
            full=modules['online'].snapshot(driver,directory)
        self.assertEqual(label['project'],'synthetic_project');self.assertEqual(output.getvalue(),'')
        self.assertEqual(set(full),set(snapshot.ROLES));self.assertTrue(all(set(row)==snapshot.SERVICE_FIELDS for row in full.values()))
        self.assertEqual(digest,hashlib.sha256(snapshot.canonical(full)).hexdigest())
        self.assertNotIn('only_in_RAM',json.dumps(full));self.assertFalse(any('compose' in call or '--env-file' in call for call in calls))
        self.assertEqual(driver.diagnostic.get()['status'],'PASSED')

    def test_fixed_baseline_and_producer_validation(self):
        with self.assertRaises(storage.StorageRejected):storage.parameters(self.PRODUCER,expected_current='e'*40)
        for key,value in [('commit','bad'),('sourceTree','bad'),('workflowRunId',True),('workflowRunAttempt','0')]:
            with self.subTest(key=key),self.assertRaises(storage.StorageRejected):storage.parameters({**self.PRODUCER,key:value})

    def test_dynamic_previous_from_sealed_current_is_not_guessed_e7(self):
        with self.real_guard() as (guard,base,current,prior):
            guard.open();self.assertEqual(guard.manifests[0]['previousCommit'],'a'*40)
            self.assertEqual(guard.previous_sha,hashlib.sha256((prior/'release-manifest.json').read_bytes()).hexdigest())
            guard.verify()

    def test_previous_public_read_mode_matches_original_source_read_boundary(self):
        with self.real_guard() as (guard,base,current,prior):
            (prior/'release-manifest.json').chmod(0o644);guard.open();guard.verify()
        with self.real_guard() as (guard,base,current,prior):
            (prior/'release-manifest.json').chmod(0o664)
            with self.assertRaises(storage.StorageRejected):guard.open()

    def test_guard_rejects_current_and_previous_content_changes(self):
        for which in ('current','previous'):
            with self.subTest(which=which),self.real_guard() as (guard,base,current,prior):
                guard.open();((current if which=='current' else prior)/'release-manifest.json').write_text('{}')
                with self.assertRaises(storage.StorageRejected):guard.verify()

    def test_guard_rejects_previous_path_escape_and_symlink(self):
        with self.real_guard() as (guard,base,current,prior):
            manifest=json.loads((current/'release-manifest.json').read_bytes());manifest['previousRelease']=str(base/'outside')
            (current/'release-manifest.json').write_text(json.dumps(manifest))
            with patch.object(storage,'STORAGE_CURRENT_SHA',storage.storage_sha((current/'release-manifest.json').read_bytes())),self.assertRaises(storage.StorageRejected):guard.open()
        with self.real_guard() as (guard,base,current,prior):
            moved=prior.with_name('saved');prior.rename(moved);prior.symlink_to(moved)
            with self.assertRaises((storage.StorageRejected,OSError)):guard.open()

    def test_guard_rejects_wrong_previous_commit_and_public_write(self):
        with self.real_guard() as (guard,base,current,prior):
            (prior/'release-manifest.json').write_text(json.dumps({'commit':'b'*40}))
            with self.assertRaises(storage.StorageRejected):guard.open()
        with self.real_guard() as (guard,base,current,prior):
            (current/'release-manifest.json').chmod(0o666)
            with self.assertRaises(storage.StorageRejected):guard.open()

    def test_guard_rejects_current_symlink_retarget(self):
        with self.real_guard() as (guard,base,current,prior):
            guard.open();(base/'current').unlink();(base/'current').symlink_to(prior)
            with self.assertRaises(storage.StorageRejected):guard.verify()

    def test_root_required_before_guard_or_native_activity(self):
        with patch.object(storage,'storage_root',return_value=False),patch.object(storage.StorageGuard,'open') as opened:
            result=storage.storage_execute(self.binding,lambda *args:self.fail('native called'))
        self.assertEqual(result['code'],'ROOT_REQUIRED');opened.assert_not_called()

    def test_reserved_blocks_legitimate_and_overtotal_rejected(self):
        result=self.successful();self.assertEqual(result['status'],'DIAGNOSED')
        self.assertEqual(result['disk'],{'totalBytes':100,'usedBytes':60,'freeBytes':35})
        for changed in ({'totalBytes':100,'usedBytes':70,'freeBytes':35},
                        {'totalBytes':100,'usedBytes':101,'freeBytes':0},
                        {'totalBytes':100,'usedBytes':False,'freeBytes':35}):
            import copy
            bad=copy.deepcopy(result);bad['disk']=changed
            with self.subTest(disk=changed),self.assertRaises(storage.StorageRejected):storage.validate_result(bad,self.binding)

    def test_directory_roles_fixed_eight_include_artifacts(self):
        self.assertEqual([role for role,_ in storage.STORAGE_DIRECTORIES],
            ['PROJECT_ROOT','ARTIFACTS','BACKUPS','RELEASES','STAGING','LOGS','DOCKER','VAR_LOG'])
        result=self.successful();self.assertTrue(all(row['status']=='MISSING' for row in result['directories']))
        self.assertIs(storage.validate_result(result,self.binding),result)

    def test_directory_du_held_fd_no_contents_and_command_budget(self):
        with tempfile.TemporaryDirectory(dir=self.runtime) as directory:
            def command(argv,**kwargs):
                self.assertEqual(argv[:7],['/usr/bin/du','-x','-s','-B1','-H','--',argv[6]])
                self.assertEqual(argv[6],'/proc/self/fd/'+str(kwargs['pass_fds'][0]))
                self.assertLessEqual(kwargs['timeout'],30);self.assertIs(kwargs['stderr'],subprocess.DEVNULL)
                return SimpleNamespace(returncode=0,stdout=('123\t'+argv[6]+'\n').encode())
            with patch.object(storage.subprocess,'run',side_effect=command),patch.object(Path,'read_bytes',side_effect=AssertionError('file content read')):
                row=storage.storage_directory_usage('ARTIFACTS',Path(directory),storage.time.monotonic()+60)
            self.assertEqual(row,{'role':'ARTIFACTS','status':'MEASURED','allocatedBytes':123})
            with patch.object(storage.subprocess,'run',side_effect=subprocess.TimeoutExpired('du',30)):
                row=storage.storage_directory_usage('ARTIFACTS',Path(directory),storage.time.monotonic()+60)
            self.assertEqual(row['status'],'UNAVAILABLE');self.assertIsNone(row['allocatedBytes'])

    def test_directory_missing_and_symlink_do_not_follow(self):
        with tempfile.TemporaryDirectory(dir=self.runtime) as directory:
            root=Path(directory);(root/'alias').symlink_to(root)
            with patch.object(storage.subprocess,'run') as run:
                self.assertEqual(storage.storage_directory_usage('ARTIFACTS',root/'absent',storage.time.monotonic()+60)['status'],'MISSING')
                self.assertEqual(storage.storage_directory_usage('ARTIFACTS',root/'alias',storage.time.monotonic()+60)['status'],'UNAVAILABLE')
            run.assert_not_called()

    def test_cache_only_four_finite_public_aggregate_roles(self):
        rows=[{'Type':role,'TotalCount':'7','Active':'2','Size':'1.25GB','Reclaimable':'250MB (20%)'}
            for role in ('Images','Containers','Local Volumes','Build Cache')]
        driver=SimpleNamespace(native=lambda *args:'\n'.join(json.dumps(row) for row in rows))
        value=storage.storage_cache(driver);self.assertEqual(value['status'],'MEASURED')
        self.assertEqual(value['rows'][0]['sizeBytesEstimate'],1250000000)
        for change in ({'Type':'PRIVATE_SENTINEL'},{'Size':'SECRET_VALUE'},{'Active':'8'},{'TotalCount':True}):
            bad=[{**rows[0],**change},*rows[1:]]
            output=storage.storage_cache(SimpleNamespace(native=lambda *args:'\n'.join(json.dumps(row) for row in bad)))
            self.assertEqual(output,{'status':'UNAVAILABLE','rows':[]});self.assertNotIn('PRIVATE_SENTINEL',json.dumps(output))

    def test_result_closed_nested_fields_and_non_authorizing(self):
        import copy
        result=self.successful()
        for mutate in (lambda x:x.update(extra='PRIVATE_SENTINEL'),lambda x:x['guards'].update(extra=True),
                       lambda x:x.update(authority=True),lambda x:x.update(productionEligible=True),
                       lambda x:x['sourceBinding']['sourcePins'].update(extra={'bytes':1,'sha256':'a'*64}),
                       lambda x:x['directories'][0].update(role='OTHER')):
            bad=copy.deepcopy(result);mutate(bad)
            with self.assertRaises(storage.StorageRejected):storage.validate_result(bad,self.binding)
        self.assertLess(len(storage.storage_canonical(self.artifact(result))),24000)

    def test_artifact_success_failure_transport_and_actual_uuid(self):
        result=self.successful();self.assertIs(storage.validate_artifact(self.artifact(result),self.PRODUCER,self.binding)['result'],result)
        with patch.object(storage,'storage_root',return_value=False):failed=storage.storage_execute(self.binding,lambda *args:None)
        self.assertEqual(storage.validate_artifact(self.artifact(failed),self.PRODUCER,self.binding)['code'],'ROOT_REQUIRED')
        empty=self.artifact(None);self.assertIs(storage.validate_artifact(empty,self.PRODUCER,self.binding),empty)
        for change in ({'commandId':'bad'},{'status':'OPERATION_COMPLETED'},{'code':'OK'},{'result':{}}):
            with self.subTest(change=change),self.assertRaises(storage.StorageRejected):storage.validate_artifact({**empty,**change},self.PRODUCER,self.binding)

    def test_duplicate_nan_and_output_caps_rejected(self):
        for raw in ('{"a":1,"a":2}','{"a":NaN}','{"a":Infinity}',' ' * 24000):
            with self.subTest(raw=raw[:30]),self.assertRaises((storage.StorageRejected,ValueError)):storage.storage_closed(raw)

    def workflow(self, host=None, prefix='STORAGE_READONLY_SAFE ', transport=False):
        import textwrap
        workflow=(self.project/'.github/workflows/production-release.yml').read_text()
        start=workflow.index("<<'PY_CURRENT_STORAGE'")+len("<<'PY_CURRENT_STORAGE'")
        end=workflow.index('\n          PY_CURRENT_STORAGE',start)
        program=textwrap.dedent(workflow[start:end])
        invocation={'CommandId':self.UUID,'InstanceId':'i-1234567890abcdef0','DocumentName':'AWS-RunShellScript',
            'PluginName':'aws:runShellScript','Status':'Success' if host and host['status']=='DIAGNOSED' else 'Failed',
            'ResponseCode':0 if host and host['status']=='DIAGNOSED' else 1,'StandardErrorContent':'',
            'StandardOutputContent':prefix+json.dumps(host) if host else 'PRIVATE_SENTINEL'}
        calls=[]
        def command(argv,**kwargs):
            self.assertEqual(argv[:2],['aws','ssm']);self.assertLessEqual(kwargs['timeout'],30)
            calls.append(argv[2])
            if transport:return SimpleNamespace(returncode=1,stdout=b'',stderr=b'PRIVATE_SENTINEL')
            raw=(self.UUID+'\n') if argv[2]=='send-command' else json.dumps(invocation)
            return SimpleNamespace(returncode=0,stdout=raw.encode(),stderr=b'')
        with tempfile.TemporaryDirectory(dir=self.runtime) as directory,ExitStack() as stack:
            previous=Path.cwd();os.chdir(directory);stack.callback(os.chdir,previous)
            Path('.deploy/production-release').mkdir(parents=True)
            stack.enter_context(patch.dict(os.environ,{'RELEASE_COMMIT':self.PRODUCER['commit'],'SOURCE_TREE':self.PRODUCER['sourceTree'],
                'GITHUB_RUN_ID':'9','GITHUB_RUN_ATTEMPT':'1','EXPECTED_CURRENT':storage.STORAGE_BASELINE,'PRODUCTION_INSTANCE_ID':invocation['InstanceId']}))
            stack.enter_context(patch.object(importlib.util,'spec_from_file_location',return_value=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda unused:None))))
            stack.enter_context(patch.object(importlib.util,'module_from_spec',return_value=storage))
            stack.enter_context(patch.object(storage,'parameters',return_value=(self.payload,self.binding)))
            stack.enter_context(patch.object(subprocess,'run',side_effect=command))
            output=io.StringIO()
            with redirect_stdout(output),self.assertRaises(SystemExit) as ended:exec(compile(program,'<synthetic-workflow>','exec'),{})
            result=json.loads(Path('.deploy/production-release/storage-readonly-result.json').read_bytes())
            self.assertNotIn('PRIVATE_SENTINEL',output.getvalue());return result,ended.exception.code,calls

    def test_actual_workflow_python_success_finite_failure_and_transport(self):
        success,exit_code,calls=self.workflow(self.successful());self.assertEqual(exit_code,0)
        self.assertEqual(success['status'],'OPERATION_COMPLETED');self.assertEqual(calls,['send-command','get-command-invocation'])
        with patch.object(storage,'storage_root',return_value=False):failed=storage.storage_execute(self.binding,lambda *args:None)
        failure,exit_code,_=self.workflow(failed);self.assertEqual(exit_code,1);self.assertEqual(failure['code'],'ROOT_REQUIRED')
        for kwargs in ({'host':self.successful(),'prefix':'UNKNOWN '},{'transport':True}):
            receipt,exit_code,_=self.workflow(**kwargs);self.assertEqual(exit_code,1)
            self.assertEqual(receipt['code'],'TRANSPORT_UNAVAILABLE');self.assertIsNone(receipt['result'])

    def test_new_workflow_gate_does_not_enable_cleanup(self):
        workflow=(self.project/'.github/workflows/production-release.yml').read_text()
        start=workflow.index('      - name: Diagnose current storage without changing production')
        end=workflow.index('      - name: Diagnose storage or clean approved routine audit records',start)
        steps=workflow[start:end]
        self.assertIn("inputs.operation == 'diagnose_storage' && inputs.expected_current == '"+storage.STORAGE_BASELINE+"'",steps)
        self.assertNotIn('cleanup_',steps);self.assertNotIn('archive_release_cache',steps)
        self.assertNotIn('sys.stdout.write',steps);self.assertNotIn('print(raw',steps)


if __name__ == '__main__':
    unittest.main()
