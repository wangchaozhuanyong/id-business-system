import fcntl
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import release
import remote

BASE, NEXT = 'a' * 40, 'b' * 40


class ManagedBackupInstall(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parents[2] / 'backups'
        directory.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory, prefix='.backup-install-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.formal = self.root / 'formal'
        self.target = self.formal / 'ops/recharge-core/scheduled-backup.py'
        self.target.parent.mkdir(parents=True)
        self.target.write_text('version = 1\n')
        self.target.chmod(0o644)
        self.source = self.root / 'releases' / NEXT / 'source'
        self.ops = self.root / 'releases' / NEXT / 'operations'
        self.ops.mkdir(parents=True)
        for sha, text in ((BASE, 'version = 1\n'), (NEXT, 'version = 2\n')):
            path = self.root / 'releases' / sha / 'source/deploy/recharge-core/scheduled-backup.py'
            path.parent.mkdir(parents=True)
            path.write_text(text)
        self.lock = self.root / 'backups/scheduled-recharge/.lock'
        self.lock.parent.mkdir(parents=True)
        self.lock.touch()
        original_lstat = Path.lstat
        def metadata(path, **kwargs):
            info = original_lstat(path, **kwargs)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0) if path == self.target else info
        for context in (patch.object(remote, 'ROOT', self.root), patch.object(remote, 'FORMAL', self.formal),
                        patch.object(Path, 'lstat', metadata)):
            context.start()
            self.addCleanup(context.stop)

    def install(self):
        with remote.prepare_backup_recovery(self.source, self.ops, BASE, NEXT) as install:
            return install()

    def test_atomic_install_preserves_previous_program_and_is_idempotent(self):
        receipt = self.install()
        self.assertEqual(self.target.read_text(), 'version = 2\n')
        self.assertEqual((self.ops / 'scheduled-backup.py.before').read_text(), 'version = 1\n')
        self.assertEqual(receipt, self.install())

    def test_failed_cutover_leaves_existing_program_and_releases_lock(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic cutover failure'):
            with remote.prepare_backup_recovery(self.source, self.ops, BASE, NEXT):
                self.assertEqual(self.target.read_text(), 'version = 1\n')
                with self.lock.open('w') as other_process:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(other_process, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise RuntimeError('synthetic cutover failure')
        self.assertEqual(self.target.read_text(), 'version = 1\n')
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])
        with self.lock.open('w') as available:
            fcntl.flock(available, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_unreviewed_live_program_is_never_overwritten(self):
        self.target.write_text('independent_change = True\n')
        with self.assertRaisesRegex(remote.ReleaseError, 'baseline_changed'):
            self.install()
        self.assertEqual(self.target.read_text(), 'independent_change = True\n')
        self.assertFalse((self.ops / 'scheduled-backup.py.before').exists())

    def test_active_pending_upload_blocks_program_replacement(self):
        with self.lock.open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(remote.ReleaseError, 'upload_in_progress'):
                self.install()
        self.assertEqual(self.target.read_text(), 'version = 1\n')

    @patch('release.require_ancestor')
    @patch('release.git')
    def test_only_host_backup_program_is_excluded_from_native_image_scope(self, git, _ancestor):
        git.return_value = release.BACKUP_OPERATION
        self.assertIsNone(release.require_website_scope(BASE, NEXT))
        for forbidden in ('deploy/recharge-core/snapshot.py', 'deploy/recharge-core/Dockerfile',
                          'modules/recharge/codexdaichong/upstream/server.js'):
            git.return_value = release.BACKUP_OPERATION + '\n' + forbidden
            with self.assertRaisesRegex(RuntimeError, 'core_or_runtime_changed'):
                release.require_website_scope(BASE, NEXT)


if __name__ == '__main__':
    unittest.main()
