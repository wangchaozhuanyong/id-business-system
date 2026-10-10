"""One held backups directory owner repair; no path, child or release authority.

The pinned transport binds the held BASE/backups descriptors to their complete
no-follow ancestors and actual baseline. Its guard independently rechecks the
original current pointer, seven services and source bindings. This core never
opens either descriptor, reads children, changes mode/group or grants admission.
"""
import os
import stat
import types

FIELDS = frozenset(('kind', 'mode', 'status', 'code', 'localStateBefore',
                    'localStateAfter', 'mutationAttempted', 'installed', 'rawOutputSuppressed'))
STATUSES = frozenset(('REPAIRED', 'NO_CHANGE', 'FAILED', 'FAILED_MUTATED_UNVERIFIED'))
LOCAL_STATES = frozenset(('NOT_MEASURED', 'OWNER', 'MATCH', 'LINK', 'NON_DIRECTORY',
                         'PUBLIC_WRITABLE', 'SPECIAL_MODE', 'IDENTITY_CHANGED'))
CODES = frozenset(('OK', 'SCOPE_INVALID', 'ROOT_REQUIRED', 'ANCESTOR_INVALID',
                   'ANCESTOR_CHANGED', 'TARGET_CHANGED', 'INODE_CHANGED', 'UID_CHANGED',
                   'GID_CHANGED', 'MODE_CHANGED', 'IDENTITY_CHANGED', 'LINK',
                   'NON_DIRECTORY', 'PUBLIC_WRITABLE', 'SPECIAL_MODE', 'GUARD_FAILED',
                   'FCHOWN_FAILED', 'IO_FAILURE'))


class Rejected(RuntimeError):
    pass


def _need(condition, code):
    if not condition:
        raise Rejected(code)


def _uid():
    return 0


def _root_identity():
    return os.getuid() == 0 and os.geteuid() == 0


def _identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid,
            row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def _parent(parent_fd):
    row = os.fstat(parent_fd)
    _need(stat.S_ISDIR(row.st_mode) and row.st_uid == _uid()
          and stat.S_IMODE(row.st_mode) & 0o022 == 0, 'ANCESTOR_INVALID')
    return _identity(row)


def _target(parent_fd, backups_fd):
    try:
        visible = os.stat('backups', dir_fd=parent_fd, follow_symlinks=False)
    except (FileNotFoundError, NotADirectoryError):
        raise Rejected('TARGET_CHANGED') from None
    _need(not stat.S_ISLNK(visible.st_mode), 'LINK')
    held = os.fstat(backups_fd)
    _need(stat.S_ISDIR(visible.st_mode) and stat.S_ISDIR(held.st_mode), 'NON_DIRECTORY')
    _need(visible.st_dev == held.st_dev and visible.st_ino == held.st_ino, 'INODE_CHANGED')
    _need(_identity(visible) == _identity(held), 'IDENTITY_CHANGED')
    _need(stat.S_IMODE(held.st_mode) & 0o022 == 0, 'PUBLIC_WRITABLE')
    # An ownership syscall may clear special bits. Do not attempt such a mode,
    # and never compensate with chmod or another metadata mutation.
    _need(stat.S_IMODE(held.st_mode) & 0o7000 == 0, 'SPECIAL_MODE')
    return held


def _unchanged(before, after, *, owner_repaired=False):
    _need((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), 'INODE_CHANGED')
    _need(before.st_gid == after.st_gid, 'GID_CHANGED')
    _need(before.st_mode == after.st_mode, 'MODE_CHANGED')
    _need(after.st_uid == (_uid() if owner_repaired else before.st_uid), 'UID_CHANGED')
    _need((before.st_nlink, before.st_size, before.st_mtime_ns)
          == (after.st_nlink, after.st_size, after.st_mtime_ns), 'IDENTITY_CHANGED')
    if not owner_repaired:
        _need(before.st_ctime_ns == after.st_ctime_ns, 'IDENTITY_CHANGED')


def _verify(parent_fd, backups_fd, parent_anchor, before, *, owner_repaired=False):
    _need(_parent(parent_fd) == parent_anchor, 'ANCESTOR_CHANGED')
    after = _target(parent_fd, backups_fd)
    _unchanged(before, after, owner_repaired=owner_repaired)
    return after


def _guard(callback):
    try:
        callback()
    except BaseException:
        raise Rejected('GUARD_FAILED') from None


def repair(parent_fd, backups_fd, *, guard=None):
    """Only fchown(backups_fd, 0, -1); caller retains descriptor ownership.

    guard is the pinned transport's ordinary function: it succeeds by returning
    normally, raises on any current/service/source change, and supplies no trust
    flag. It runs after measurement, immediately before mutation, and after it.
    Every failure after an attempted fchown remains explicitly unverified.
    """
    receipt = {'kind': 'BACKUP_PARENT_OWNER_REPAIR_V1', 'mode': 'repair_owner',
               'status': 'FAILED', 'code': 'IO_FAILURE',
               'localStateBefore': 'NOT_MEASURED', 'localStateAfter': 'NOT_MEASURED',
               'mutationAttempted': False, 'installed': False, 'rawOutputSuppressed': True}
    try:
        _need(all(type(fd) is int and fd >= 0 for fd in (parent_fd, backups_fd))
              and parent_fd != backups_fd and type(guard) is types.FunctionType, 'SCOPE_INVALID')
        _need(_root_identity(), 'ROOT_REQUIRED')
        parent_anchor = _parent(parent_fd)
        before = _target(parent_fd, backups_fd)
        receipt['localStateBefore'] = 'MATCH' if before.st_uid == _uid() else 'OWNER'
        _guard(guard)
        _verify(parent_fd, backups_fd, parent_anchor, before)
        _guard(guard)
        _verify(parent_fd, backups_fd, parent_anchor, before)
        if before.st_uid != _uid():
            receipt['mutationAttempted'] = True
            try:
                os.fchown(backups_fd, 0, -1)
            except BaseException:
                raise Rejected('FCHOWN_FAILED') from None
            _verify(parent_fd, backups_fd, parent_anchor, before, owner_repaired=True)
        _guard(guard)
        _verify(parent_fd, backups_fd, parent_anchor, before,
                owner_repaired=receipt['mutationAttempted'])
        receipt.update(status='REPAIRED' if receipt['mutationAttempted'] else 'NO_CHANGE',
                       code='OK', localStateAfter='MATCH')
    except BaseException as error:
        args = BaseException.args.__get__(error)
        code = args[0] if (type(error) is Rejected and type(args) is tuple and len(args) == 1
                          and type(args[0]) is str and args[0] in CODES) else 'IO_FAILURE'
        receipt['code'] = code
        if receipt['mutationAttempted']:
            receipt['status'] = 'FAILED_MUTATED_UNVERIFIED'
        elif receipt['localStateBefore'] == 'NOT_MEASURED' and code in LOCAL_STATES:
            receipt['localStateBefore'] = code
    return receipt
