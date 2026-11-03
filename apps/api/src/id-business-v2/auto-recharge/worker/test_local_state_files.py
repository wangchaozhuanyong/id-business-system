import errno
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import local_state_files as files


class StateFilesTests(unittest.TestCase):
    def test_native_exclusive_lock_blocks_another_descriptor_and_releases_on_close(self):
        root = Path(__file__).resolve().parents[6] / '.runtime/online-bitbrowser-website-only-20261103'
        with tempfile.TemporaryDirectory(dir=root) as folder:
            path = Path(folder) / 'account.lock'
            first = files.open_private(path, os.O_CREAT | os.O_RDWR)
            second = files.open_private(path, os.O_CREAT | os.O_RDWR)
            try:
                files.flock(first, files.LOCK_EX | files.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    files.flock(second, files.LOCK_EX | files.LOCK_NB)
                os.close(first)
                first = None
                files.flock(second, files.LOCK_EX | files.LOCK_NB)
            finally:
                if first is not None:
                    os.close(first)
                os.close(second)

    @unittest.skipIf(os.name == 'nt', '原生 Windows 未默认授予创建软链接权限')
    def test_private_open_rejects_symlinks_without_truncating_target(self):
        root = Path(__file__).resolve().parents[6] / '.runtime/online-bitbrowser-website-only-20261103'
        with tempfile.TemporaryDirectory(dir=root) as folder:
            target = Path(folder) / 'original'
            target.write_text('preserved')
            link = Path(folder) / 'link'
            link.symlink_to(target)
            with self.assertRaises(OSError):
                files.open_private(link, os.O_WRONLY | os.O_TRUNC)
            self.assertEqual(target.read_text(), 'preserved')

    def test_windows_lock_uses_nonblocking_first_byte_and_restores_position(self):
        locking = Mock()
        seek = Mock(side_effect=[9, 0, 9])
        with patch.dict(sys.modules, msvcrt=types.SimpleNamespace(locking=locking, LK_NBLCK=2)), \
                patch.object(files.os, 'name', 'nt'), patch.object(files.os, 'lseek', seek):
            files.flock(7, files.LOCK_EX | files.LOCK_NB)
        locking.assert_called_once_with(7, 2, 1)
        self.assertEqual(seek.call_args.args, (7, 9, os.SEEK_SET))

    def test_windows_contention_is_not_mistaken_for_an_unlocked_account(self):
        locking = Mock(side_effect=OSError(errno.EACCES, 'locked'))
        with patch.dict(sys.modules, msvcrt=types.SimpleNamespace(locking=locking, LK_NBLCK=2)), \
                patch.object(files.os, 'name', 'nt'), patch.object(files.os, 'lseek', return_value=0):
            with self.assertRaises(BlockingIOError):
                files.flock(7, files.LOCK_EX | files.LOCK_NB)


if __name__ == '__main__':
    unittest.main()
