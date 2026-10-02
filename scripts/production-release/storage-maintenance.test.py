import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('storage-maintenance.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
REF = {'table': 'id_business_v2_governance_job_items', 'column': 'result_audit_log_id', 'sameSchema': 1}
BACKUP = {'name': 'id-business-v2-20261002T120000Z.sql.gz', 's3Verified': True}


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
