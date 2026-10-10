"""Protect the fixed recovery sources and live publication backup references.

Only local retention is performed. No environment, SQL, backup contents or S3
data are read. The backup service passes its already-held .backup.lock FD;
standalone callers acquire that same existing lock without creating a file.
"""
import argparse
import calendar
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

BASE = Path('/opt/id-business-v2')
ROOT_UID = 0
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
HISTORY = (
    ('28a3ba4ffd17d36001b1104c97394f5ae871d73d',
     '1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a',
     'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'migration'),
    ('296c096af7c4c79a8ffc2f57d9a15ea75684f431',
     'f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485',
     'ONLINE_RECHARGE_FAILED_RESTORED', 'audit-after'),
)
BACKUP_NAME = re.compile(r'id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz\Z')
RELEASE_NAME = re.compile(r'([0-9]{8}T[0-9]{6}Z)-[a-f0-9]{12}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
# The original dispatch bounds a publication process to 3600 seconds.
ACTIVE_SECONDS = 3600
JSON_LIMIT = 256 * 1024
ENTRY_LIMIT = 4096
END_MARKERS = frozenset(('online-recharge-failure.json',
    'api-workspace-failure.json', 'api-admin-failure.json',
    'api-admin-migration-failure.json', 'api-registration-failure.json'))
CODES = frozenset(('OK', 'REFERENCE_INVALID', 'AUTHORITY_CHANGED', 'LOCK_INVALID',
    'LOCK_BUSY', 'ACTIVE_AMBIGUOUS', 'LIMIT_UNSATISFIABLE', 'INPUT_INVALID', 'IO_FAILURE'))


class Rejected(RuntimeError):
    def __init__(self, code, removed_count=0):
        super().__init__(code)
        self.removed_count = removed_count


def need(condition, code='REFERENCE_INVALID'):
    if not condition:
        raise Rejected(code)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def directory_identity(value):
    return value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid


def trusted_directory(value):
    need(stat.S_ISDIR(value.st_mode) and value.st_uid == ROOT_UID
         and stat.S_IMODE(value.st_mode) & 0o022 == 0)


def trusted_file(value, code='REFERENCE_INVALID'):
    need(stat.S_ISREG(value.st_mode) and value.st_uid == ROOT_UID
         and value.st_nlink == 1 and stat.S_IMODE(value.st_mode) & 0o022 == 0, code)


def closed(raw):
    def unique(items):
        result = {}
        for key, value in items:
            need(key not in result)
            result[key] = value
        return result
    def invalid(unused):
        raise Rejected('REFERENCE_INVALID')
    try:
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
    except (ValueError, UnicodeError):
        raise Rejected('REFERENCE_INVALID') from None
    need(type(value) is dict)
    return value


def receipt(value):
    need(set(value) == {'name', 'size', 'sha256', 's3Verified'}
         and type(value['name']) is str and BACKUP_NAME.fullmatch(value['name'])
         and type(value['size']) is int and value['size'] > 0
         and type(value['sha256']) is str and HEX.fullmatch(value['sha256'])
         and value['s3Verified'] is True)
    return value['name']


def release_component(value):
    if type(value) is not str or not value or value in ('.', '..') or '/' in value:
        return False
    try:
        return len(value.encode('utf-8')) <= 255 and not any(
            ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)
    except UnicodeError:
        return False


def local_backup_name(value):
    # Preserve the original retention glob, including unreferenced old names.
    return value.startswith('id-business-v2-') and value.endswith('.sql.gz')


class Authority:
    def __init__(self):
        self.fds, self.directories, self.files, self.absent = [], [], [], []
        try:
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.fds.append(fd)
            trusted_directory(os.fstat(fd))
            for part in BASE.parts[1:]:
                fd = self.child(fd, part)
            self.base = fd
            self.releases = self.child(fd, 'releases')
            self.backups = self.child(self.child(fd, 'backups'), 'mysql')
            self.current, self.current_anchor = self.current_read()
        except BaseException:
            self.close()
            raise

    def child(self, parent, name):
        visible = os.stat(name, dir_fd=parent, follow_symlinks=False)
        trusted_directory(visible)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=parent)
        self.fds.append(fd)
        held = os.fstat(fd)
        trusted_directory(held)
        need(directory_identity(visible) == directory_identity(held), 'AUTHORITY_CHANGED')
        self.directories.append((parent, name, fd, directory_identity(held)))
        return fd

    def current_read(self):
        before = os.stat('current', dir_fd=self.base, follow_symlinks=False)
        need(stat.S_ISLNK(before.st_mode) and before.st_uid == ROOT_UID and before.st_nlink == 1
             and 0 < before.st_size <= 512)
        target = os.readlink('current', dir_fd=self.base)
        names = [target[len(prefix):] for prefix in (str(BASE / 'releases') + '/', 'releases/')
                 if target.startswith(prefix)]
        need(len(names) == 1 and RELEASE_NAME.fullmatch(names[0]))
        need(identity(before) == identity(os.stat('current', dir_fd=self.base,
             follow_symlinks=False)), 'AUTHORITY_CHANGED')
        return names[0], (target, identity(before))

    def optional_stat(self, parent, name):
        try:
            return os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def read(self, parent, name, optional=False):
        visible = self.optional_stat(parent, name)
        if visible is None and optional:
            self.absent.append((parent, name))
            return None
        need(visible is not None)
        trusted_file(visible)
        need(0 < visible.st_size <= JSON_LIMIT)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=parent)
        self.fds.append(fd)
        before = os.fstat(fd)
        trusted_file(before)
        need(identity(visible) == identity(before), 'AUTHORITY_CHANGED')
        raw = b''
        while len(raw) <= JSON_LIMIT:
            chunk = os.read(fd, min(65536, JSON_LIMIT + 1 - len(raw)))
            if not chunk:
                break
            raw += chunk
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
             == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'AUTHORITY_CHANGED')
        self.files.append((parent, name, fd, identity(before)))
        return closed(raw)

    def check(self):
        for parent, name, fd, expected in self.directories:
            need(directory_identity(os.fstat(fd)) == expected
                 == directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)),
                 'AUTHORITY_CHANGED')
        for parent, name, fd, expected in self.files:
            need(identity(os.fstat(fd)) == expected
                 == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'AUTHORITY_CHANGED')
        need(all(self.optional_stat(parent, name) is None for parent, name in self.absent),
             'AUTHORITY_CHANGED')
        need(self.current_read() == (self.current, self.current_anchor), 'AUTHORITY_CHANGED')

    def lock(self, name, inherited=None, observe=False):
        visible = self.optional_stat(self.base if observe else self.backups, name)
        if visible is None and observe:
            self.absent.append((self.base, name))
            return False
        need(visible is not None, 'LOCK_INVALID')
        trusted_file(visible, 'LOCK_INVALID')
        parent = self.base if observe else self.backups
        fd = os.dup(inherited) if inherited is not None else os.open(name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        self.fds.append(fd)
        held = os.fstat(fd)
        trusted_file(held, 'LOCK_INVALID')
        need(identity(visible) == identity(held), 'LOCK_INVALID')
        self.files.append((parent, name, fd, identity(held)))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            need(error.errno in (errno.EAGAIN, errno.EACCES), 'LOCK_INVALID')
            if observe:
                return True
            raise Rejected('LOCK_BUSY') from None
        if observe:
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
        return True

    def referenced(self, directory, *, manifest_required=False):
        fd = self.child(self.releases, directory)
        manifest = self.read(fd, 'release-manifest.json', optional=not manifest_required)
        backup = self.read(fd, 'backup-verification.json', optional=True)
        names = set()
        if backup is not None:
            names.add(receipt(backup))
        if manifest is not None and 'backupBeforeRelease' in manifest:
            name = manifest['backupBeforeRelease']
            need(type(name) is str and BACKUP_NAME.fullmatch(name))
            need(backup is None or name == backup['name'])
            names.add(name)
        return names, manifest

    def protected(self, now):
        entries = os.listdir(self.releases)
        need(len(entries) <= ENTRY_LIMIT)
        protected, current = self.referenced(self.current, manifest_required=True)
        if 'previousRelease' in current:
            previous = current['previousRelease']
            prefix = str(BASE / 'releases') + '/'
            need(type(previous) is str and previous.startswith(prefix)
                 and release_component(previous[len(prefix):]))
            names, _ = self.referenced(previous[len(prefix):], manifest_required=True)
            protected |= names
        history_names = set()
        for index, (commit, failure_sha, status, step) in enumerate(HISTORY):
            matches = [name for name in entries if name.endswith('-' + commit[:12])]
            need(len(matches) == 1 and RELEASE_NAME.fullmatch(matches[0]))
            history_names.add(matches[0])
            fd = self.child(self.releases, matches[0])
            failure = self.read(fd, 'online-recharge-failure.json')
            canonical = json.dumps(failure, sort_keys=True, separators=(',', ':')).encode()
            need(hashlib.sha256(canonical).hexdigest() == failure_sha
                 and failure.get('candidateCommit') == commit
                 and failure.get('previousCommit') == BASELINE
                 and failure.get('status') == status and failure.get('step') == step
                 and failure.get('rollbackOk') is True and failure.get('currentPointsToCandidate') is False
                 and failure.get('receiptPersisted') is True)
            backup = self.read(fd, 'backup-verification.json')
            protected.add(receipt(backup))
            if index == 1:
                manifest = self.read(fd, 'release-manifest.json')
                need(manifest.get('commit') == commit and manifest.get('previousCommit') == BASELINE
                     and manifest.get('backupBeforeRelease') == backup['name'])
        active = []
        if self.lock('.deploy.lock', observe=True):
            for name in entries:
                match = RELEASE_NAME.fullmatch(name)
                if not match or name == self.current or name in history_names:
                    continue
                try:
                    created = calendar.timegm(time.strptime(match[1], '%Y%m%dT%H%M%SZ'))
                except ValueError:
                    continue
                if not 0 <= now - created <= ACTIVE_SECONDS:
                    continue
                fd = self.child(self.releases, name)
                ended = [marker for marker in END_MARKERS if self.optional_stat(fd, marker) is not None]
                if ended:
                    continue
                backup_status = self.optional_stat(fd, 'backup-verification.json')
                if backup_status is None:
                    continue
                # Controllers write the manifest before point_current. A
                # manifest pointing at this exact current is a live transition,
                # not an ended publication. Other ended manifests do not pin.
                manifest = self.read(fd, 'release-manifest.json', optional=True)
                if manifest is not None:
                    if manifest.get('previousRelease') != str(BASE / 'releases' / self.current):
                        continue
                    commit = manifest.get('commit')
                    need(type(commit) is str and re.fullmatch('[a-f0-9]{40}', commit)
                         and name.endswith('-' + commit[:12]))
                need(stat.S_IMODE(os.fstat(fd).st_mode) == 0o700)
                need(0 <= now - backup_status.st_mtime <= ACTIVE_SECONDS
                     and backup_status.st_mtime >= created)
                for marker in END_MARKERS:
                    self.absent.append((fd, marker))
                backup_name = receipt(self.read(fd, 'backup-verification.json'))
                if manifest is not None:
                    need(type(manifest.get('backupBeforeRelease')) is str
                         and manifest['backupBeforeRelease'] == backup_name)
                active.append(backup_name)
            need(len(active) <= 1, 'ACTIVE_AMBIGUOUS')
            protected.update(active)
        self.check()
        return protected

    def close(self):
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds = []


def prune(retention_count, max_bytes, *, apply=False, backup_lock_fd=None):
    need(type(retention_count) is int and 2 <= retention_count <= 336
         and type(max_bytes) is int and max_bytes >= 67108864
         and type(apply) is bool, 'INPUT_INVALID')
    authority = Authority()
    removed = 0
    try:
        authority.lock('.backup.lock', inherited=backup_lock_fd)
        protected = authority.protected(time.time())
        entries = os.listdir(authority.backups)
        need(len(entries) <= ENTRY_LIMIT)
        files = []
        for name in sorted(entries):
            if not local_backup_name(name):
                continue
            value = authority.optional_stat(authority.backups, name)
            need(value is not None, 'AUTHORITY_CHANGED')
            trusted_file(value)
            files.append((name, identity(value)))
        total = sum(value[6] for _, value in files)
        retained = len(files)
        latest = files[-1][0] if files else None
        candidates = []
        for name, value in files:
            if retained <= retention_count and total <= max_bytes:
                break
            if name in protected or name == latest:
                continue
            candidates.append((name, value))
            retained -= 1
            total -= value[6]
        need(retained <= retention_count and total <= max_bytes, 'LIMIT_UNSATISFIABLE')
        remaining = {name: value for name, value in files}
        def check_backups():
            names = {name for name in os.listdir(authority.backups) if local_backup_name(name)}
            need(names == set(remaining), 'AUTHORITY_CHANGED')
            for name, value in remaining.items():
                need(identity(os.stat(name, dir_fd=authority.backups, follow_symlinks=False)) == value,
                     'AUTHORITY_CHANGED')
        authority.check()
        check_backups()
        if apply:
            for name, value in candidates:
                authority.check()
                check_backups()
                os.unlink(name, dir_fd=authority.backups)
                removed += 1
                del remaining[name]
            os.fsync(authority.backups)
        authority.check()
        check_backups()
        return {'kind': 'MYSQL_BACKUP_RETENTION_V1', 'status': 'APPLIED' if apply else 'PLAN_ONLY',
                'code': 'OK', 'protectedCount': len(protected), 'countBefore': len(files),
                'candidateCount': len(candidates), 'removedCount': removed,
                'countAfter': retained if apply else len(files), 'retainedBytes': total if apply
                else sum(value[6] for _, value in files), 'rawOutputSuppressed': True}
    except Exception as error:
        arguments = BaseException.args.__get__(error)
        code = arguments[0] if type(error) is Rejected and len(arguments) == 1 \
            and type(arguments[0]) is str and arguments[0] in CODES else 'IO_FAILURE'
        raise Rejected(code, removed) from None
    finally:
        authority.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup-lock-fd', type=int)
    parser.add_argument('--retention-count', type=int, required=True)
    parser.add_argument('--max-bytes', type=int, required=True)
    args = parser.parse_args()
    try:
        value = prune(args.retention_count, args.max_bytes, apply=args.apply,
                      backup_lock_fd=args.backup_lock_fd)
        print(json.dumps(value, sort_keys=True, separators=(',', ':')))
        return 0
    except Exception as error:
        arguments = BaseException.args.__get__(error)
        code = arguments[0] if type(error) is Rejected and len(arguments) == 1 \
            and type(arguments[0]) is str and arguments[0] in CODES else 'IO_FAILURE'
        removed = error.removed_count if type(error) is Rejected else 0
        print(json.dumps({'kind': 'MYSQL_BACKUP_RETENTION_V1', 'status':
                          'FAILED_MUTATED_UNVERIFIED' if removed else 'FAILED',
                          'code': code, 'removedCount': removed, 'rawOutputSuppressed': True}, sort_keys=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
