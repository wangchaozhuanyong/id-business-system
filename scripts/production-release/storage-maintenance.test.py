import importlib.util
import base64
from contextlib import contextmanager, ExitStack, redirect_stdout
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import sys
import unittest
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
