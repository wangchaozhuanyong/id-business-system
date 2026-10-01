import base64
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_cleanup', Path(__file__).with_name('cleanup-verified-backups.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
SHA = 'a' * 40


class VerifiedBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.backup-cleanup-test-', dir=Path.cwd())
        self.base = Path(self.temporary.name).resolve()
        self.backups = self.base / 'backups/mysql'
        self.backups.mkdir(parents=True)
        self.current = self.base / 'releases/active'
        self.current.mkdir(parents=True)
        self.previous = self.base / 'releases/previous'
        self.previous.mkdir()
        (self.base / 'current').symlink_to(self.current, target_is_directory=True)
        self.files = []
        for i in range(30):
            path = self.backups / f'id-business-v2-20260901T{i:06d}Z.sql.gz'
            path.write_bytes(f'fixture-{i}'.encode())
            self.files.append(path)
        self.record = {'commit': SHA, 'previousRelease': str(self.previous),
                       'backupBeforeRelease': self.files[0].name}
        self.write_manifest()
        (self.previous / 'release-manifest.json').write_text(json.dumps({'backupBeforeRelease': self.files[1].name}))
        (self.current / '.env.aws.production').write_text('MYSQL_BACKUP_S3_BUCKET=id-business-fixture-backups\n')
        self.wrong_name = None
        self.missing_name = None
        self.encryption = 'AES256'
        self.mutate_after_verify = False
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self):
        (self.current / 'release-manifest.json').write_text(json.dumps(self.record))

    def remote(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[:3], ['aws', 's3api', 'head-object'])
        name = args[args.index('--key') + 1].split('/')[-1]
        if name == self.missing_name:
            return SimpleNamespace(returncode=1, stdout='')
        data = (self.backups / name).read_bytes()
        record = {'ContentLength': len(data), 'ServerSideEncryption': self.encryption,
                  'ChecksumSHA256': base64.b64encode(hashlib.sha256(data).digest()).decode()}
        if name == self.wrong_name:
            record['ChecksumSHA256'] = 'wrong'
        if self.mutate_after_verify and name == self.files[5].name:
            self.files[2].write_bytes(b'changed')
        return SimpleNamespace(returncode=0, stdout=json.dumps(record))

    def invoke(self, apply=False):
        with patch.object(cleanup, 'BASE', self.base), \
                patch.object(cleanup.subprocess, 'run', side_effect=self.remote):
            return cleanup.clean(SHA, apply)

    def assert_all_present(self):
        self.assertTrue(all(path.exists() for path in self.files))

    def test_read_only_plan_never_deletes(self):
        result = self.invoke()
        self.assertEqual(result['mode'], 'PLAN_ONLY')
        self.assertEqual(result['candidateCount'], 4)
        self.assertEqual(result['removedFiles'], [])
        self.assert_all_present()

    def test_apply_preserves_latest_24_and_current_previous_release_backups(self):
        result = self.invoke(True)
        self.assertEqual(result['removedFiles'], [path.name for path in self.files[2:6]])
        self.assertEqual(result['countAfter'], 26)
        self.assertTrue(all(path.exists() for path in self.files[:2] + self.files[6:]))
        self.assertFalse(result['s3BackupsDeleted'])

    def test_all_candidates_and_retained_recovery_are_verified_before_deletion(self):
        self.wrong_name = self.files[5].name
        with self.assertRaisesRegex(RuntimeError, 'S3 backup identity differs'):
            self.invoke(True)
        self.assert_all_present()

    def test_missing_remote_copy_blocks_all_deletion(self):
        self.missing_name = self.files[4].name
        with self.assertRaisesRegex(RuntimeError, 'S3 recovery unavailable'):
            self.invoke(True)
        self.assert_all_present()

    def test_latest_recovery_must_be_verified(self):
        self.wrong_name = self.files[-1].name
        with self.assertRaisesRegex(RuntimeError, 'S3 backup identity differs'):
            self.invoke(True)
        self.assert_all_present()

    def test_encryption_mismatch_blocks_deletion(self):
        self.encryption = 'NONE'
        with self.assertRaisesRegex(RuntimeError, 'S3 backup identity differs'):
            self.invoke(True)
        self.assert_all_present()

    def test_changed_production_blocks_before_remote_or_deletion(self):
        self.record['commit'] = 'b' * 40
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'Production baseline changed'):
            self.invoke(True)
        self.assertEqual(self.calls, [])
        self.assert_all_present()

    def test_changed_file_identity_blocks_before_first_deletion(self):
        self.mutate_after_verify = True
        with self.assertRaisesRegex(RuntimeError, 'Backup identity changed'):
            self.invoke(True)
        self.assert_all_present()

    def test_non_backups_and_symlink_targets_are_not_removed(self):
        unrelated = self.backups / 'notes.txt'
        unrelated.write_text('fixture')
        symlink = self.backups / 'id-business-v2-20250801T000000Z.sql.gz'
        symlink.symlink_to(unrelated)
        self.invoke(True)
        self.assertTrue(unrelated.exists())
        self.assertTrue(symlink.is_symlink())

    def test_count_below_limit_keeps_every_backup(self):
        for path in self.files[:10]:
            path.unlink()
        result = self.invoke(True)
        self.assertEqual(result['removedFiles'], [])
        self.assertEqual(result['countAfter'], 20)

    def test_empty_backup_directory_is_rejected(self):
        for path in self.files:
            path.unlink()
        with self.assertRaisesRegex(RuntimeError, 'No retained MySQL recovery point'):
            self.invoke(True)

    def test_active_backup_or_release_lock_blocks_cleanup(self):
        with patch.object(cleanup.fcntl, 'flock', side_effect=BlockingIOError):
            with self.assertRaises(BlockingIOError):
                self.invoke(True)
        self.assertEqual(self.calls, [])
        self.assert_all_present()

    def test_invalid_baseline_blocks_cleanup(self):
        with patch.object(cleanup, 'BASE', self.base):
            with self.assertRaisesRegex(RuntimeError, 'Invalid production baseline'):
                cleanup.clean('main', True)
        self.assert_all_present()


if __name__ == '__main__':
    unittest.main()
