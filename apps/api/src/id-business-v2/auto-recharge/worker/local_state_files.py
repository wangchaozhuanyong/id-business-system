"""本机付款记录的跨平台独占锁；Windows 不依赖 Unix fcntl。"""
import errno
import os
from pathlib import Path
import stat


def open_private(path, flags, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise OSError(errno.ELOOP, 'unsafe state file')
    fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        opened, named = os.fstat(fd), path.lstat()
        if (not stat.S_ISREG(opened.st_mode) or stat.S_ISLNK(named.st_mode)
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
            raise OSError(errno.ELOOP, 'unsafe state file')
        return fd
    except BaseException:
        os.close(fd)
        raise


LOCK_EX = 2
LOCK_NB = 4


def flock(fd, operation):
    if operation != LOCK_EX | LOCK_NB:
        raise ValueError('only nonblocking exclusive locks are supported')
    if os.name != 'nt':
        import fcntl
        return fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    import msvcrt
    position = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise BlockingIOError(errno.EAGAIN, 'account operation in progress') from None
            raise
    finally:
        os.lseek(fd, position, os.SEEK_SET)
