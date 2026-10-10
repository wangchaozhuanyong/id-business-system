"""Install one reviewed backup entry without switching the running application."""
import base64
import errno
import gzip
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import types

BASE = Path('/opt/id-business-v2')
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
OPERATION = 'install_backup_retention_protection'
SERVICE = 'id-business-v2-mysql-backup.service'
TIMER = 'id-business-v2-mysql-backup.timer'
DROPIN = Path('/etc/systemd/system') / (SERVICE + '.d') / '20-release-retention.conf'
PREFIX = 'BACKUP_RETENTION_INSTALL '
ARTIFACT = Path('.deploy/production-release/backup-retention-install-result.json')
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
FIELDS = frozenset(('kind', 'producer', 'source21Sha256', 'maintenanceSourceSha256',
                   'status', 'code', 'mutationAttempted', 'entryVerified', 'timerRestored',
                   'currentUnchanged', 'servicesUnchanged', 'servicesBeforeSha256',
                   'servicesAfterSha256', 'originalSourcePreserved', 'rawOutputSuppressed'))
CODES = frozenset(('OK', 'INPUT_INVALID', 'SOURCE_INVALID', 'SERVICES_CHANGED',
                   'ENTRY_CHANGED', 'TIMER_CHANGED', 'SERVICE_BUSY', 'SYSTEMD_FAILED',
                   'IO_FAILURE'))
DIAGNOSTIC_STAGES = ('SOURCE_INITIAL', 'AUTHORITY_OPEN', 'CLIENT_SETUP', 'AUTHORITY_INITIAL',
    'SNAPSHOT_INITIAL', 'CURRENT_SCRIPTS', 'BACKUP_SCRIPT', 'NORMALIZER', 'ENV_LIMITS', 'COMPOSE',
    'SERVICE_ENTRY', 'DROPINS', 'TIMER_STATE', 'SERVICE_IDLE', 'AUTHORITY_RECHECK',
    'SOURCE_RECHECK', 'SNAPSHOT_RECHECK', 'MAINTENANCE', 'ENTRY_VERIFY', 'POSTCHECK')
TRANSPORT_STAGE_REASONS = {
    'AUTHORITY_OPEN': ('CURRENT_INVALID',) + tuple('ANCESTOR_' + role + '_' + reason
        for role in ('ROOT', 'BASE_PARENT', 'BASE', 'RELEASES', 'CURRENT_RELEASE', 'BACKUPS', 'MYSQL')
        for reason in ('TYPE', 'OWNER', 'WRITABLE', 'IDENTITY')),
    'CURRENT_SCRIPTS': tuple('ANCESTOR_CURRENT_RELEASE_' + reason
        for reason in ('TYPE', 'OWNER', 'WRITABLE', 'IDENTITY')),
    'AUTHORITY_INITIAL': ('AUTHORITY_CHANGED', 'CURRENT_INVALID'),
    'AUTHORITY_RECHECK': ('AUTHORITY_CHANGED', 'CURRENT_INVALID'),
    **{stage: ('SOURCE_INVALID', 'AUTHORITY_CHANGED')
       for stage in ('BACKUP_SCRIPT', 'NORMALIZER', 'ENV_LIMITS', 'COMPOSE')}}
FILE_REASONS = ('SOURCE_TYPE', 'SOURCE_OWNER', 'SOURCE_LINKS', 'SOURCE_WRITABLE', 'SOURCE_SIZE')
NATIVE_STAGE_REASONS = {
    **{stage: ('MISSING', 'NOT_DIRECTORY', 'LINK_REJECTED', 'ACCESS_DENIED', 'IO_FAILURE')
       for stage in ('CURRENT_SCRIPTS', 'BACKUP_SCRIPT', 'NORMALIZER', 'COMPOSE')},
    'ENV_LIMITS': ('MISSING', 'NOT_DIRECTORY', 'LINK_REJECTED', 'ACCESS_DENIED', 'IO_FAILURE', 'UTF8_INVALID'),
    **{stage: ('TIMEOUT', 'UTF8_INVALID', 'IO_FAILURE')
       for stage in ('SERVICE_ENTRY', 'DROPINS', 'TIMER_STATE', 'SERVICE_IDLE')}}
SNAPSHOT_POINTS = ('CURRENT_IDS', 'CURRENT_ANCHORS', 'PROJECT_IDS', 'PROJECT_ROLES', 'ORIGINAL_SNAPSHOT', 'UNKNOWN')
SNAPSHOT_REASONS = ('NATIVE_EXECUTION', 'NATIVE_OUTPUT', 'IDS_INVALID', 'LABELS_INVALID',
    'LABELS_JSON_INVALID', 'LABELS_SHAPE_INVALID', 'LABELS_ID_INVALID', 'LABELS_TYPES_INVALID',
    'LABELS_PROJECT_INVALID', 'LABELS_ROLE_INVALID', 'LABELS_PARENT_INVALID', 'LABELS_BASENAME_INVALID',
    'LABELS_LITERAL_INVALID', 'LABELS_FILES_INVALID', 'ANCHOR_MISSING', 'ANCHOR_AMBIGUOUS',
    'ROLE_DUPLICATE', 'ROLES_INCOMPLETE', 'ROLES_EXTRA', 'SEED_CHANGED', 'SET_CHANGED',
    'ORIGINAL_SNAPSHOT', 'SNAPSHOT_FIELDS', 'UNKNOWN')
CODES |= frozenset(stage + '_' + reason for stage, reasons in TRANSPORT_STAGE_REASONS.items() for reason in reasons)
CODES |= frozenset(stage + '_' + reason for stage in ('BACKUP_SCRIPT', 'NORMALIZER', 'ENV_LIMITS', 'COMPOSE')
                  for reason in FILE_REASONS)
CODES |= frozenset(stage + '_' + reason for stage, reasons in NATIVE_STAGE_REASONS.items() for reason in reasons)
CODES |= frozenset(stage + '_' + reason for stage in ('SNAPSHOT_INITIAL', 'SNAPSHOT_RECHECK', 'POSTCHECK')
                  for reason in SNAPSHOT_REASONS)
CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
    'online-recharge-recovery.json', 'api-admin-pending-projection.py', 'api-admin-readonly.py',
    'api-admin-pending-receipt-wire.py', 'online-recharge-declaration-measurement.py',
    'online-recharge-daemon-identity.py', 'online-recharge-daemon-listener.py',
    'online-recharge-daemon-socket.py')
PACKAGE_FILES = ('driver.py', 'manifest.json', 'package_io.py', 'pure.py', 'collector.py',
    'constructor.py', 'reader.py', 'qualified.py', 'contract.json', 'reviewed-source-table.json')
EXTRA_FILES = ('online-recharge-backup-source-recovery-transport.py',
    'online-recharge-source-permission-repair-transport.py', 'backup-retention-install.py')
SCRIPT_FILES = ('backup-aws-mysql.sh', 'backup-retention-protection.py')
PLAN_FIELDS = frozenset(('kind', 'status', 'code', 'protectedCount', 'countBefore',
    'candidateCount', 'removedCount', 'countAfter', 'retainedBytes', 'rawOutputSuppressed'))


class Rejected(RuntimeError):
    pass


def need(ok, code='INPUT_INVALID'):
    if not ok:
        raise Rejected(code)


def failure_code(error, stage, *, transport=None, diagnostic=None, snapshot_validate=None):
    """Only fixed literals from exact loaded exception classes/issued capabilities."""
    if type(stage) is not str or stage not in DIAGNOSTIC_STAGES:
        return 'IO_FAILURE'
    args = BaseException.args.__get__(error)
    if type(error) is Rejected and len(args) == 1 and type(args[0]) is str and args[0] in CODES - {'OK'}:
        return args[0]
    if (transport is not None and type(error) is transport.Rejected and len(args) == 1
            and type(args[0]) is str and args[0] in TRANSPORT_STAGE_REASONS.get(stage, ())):
        return stage + '_' + args[0]
    if stage in ('SNAPSHOT_INITIAL', 'SNAPSHOT_RECHECK', 'POSTCHECK') and diagnostic is not None:
        try:
            if type(error) is RuntimeError and args == () and diagnostic.owns(error):
                row = diagnostic.get()
                snapshot_validate(row)
                if (type(row) is dict and row.get('status') == 'FAILED'
                        and all(type(row.get(n)) is str for n in ('status', 'stage', 'code'))
                        and row['stage'] in SNAPSHOT_POINTS and row['code'] in SNAPSHOT_REASONS):
                    return stage + '_' + row['code']
        except Exception:
            pass
    reason = None
    if type(error) is subprocess.TimeoutExpired:
        reason = 'TIMEOUT'
    elif type(error) is UnicodeDecodeError:
        reason = 'UTF8_INVALID'
    elif type(error) in (OSError, FileNotFoundError, PermissionError, NotADirectoryError,
                       IsADirectoryError, BlockingIOError, InterruptedError):
        reason = {errno.ENOENT: 'MISSING', errno.ENOTDIR: 'NOT_DIRECTORY', errno.ELOOP: 'LINK_REJECTED',
                  errno.EACCES: 'ACCESS_DENIED', errno.EPERM: 'ACCESS_DENIED'}.get(error.errno, 'IO_FAILURE')
        if stage in ('SERVICE_ENTRY', 'DROPINS', 'TIMER_STATE', 'SERVICE_IDLE'):
            reason = 'IO_FAILURE'
    if reason in NATIVE_STAGE_REASONS.get(stage, ()):
        return stage + '_' + reason
    return 'IO_FAILURE'


def read_original(authority, parent, name, *, stage, transport, limit=256*1024):
    """Unchanged original read; diagnose a refusal only through its already-held FD."""
    count = len(authority.fds)
    try:
        return authority.read(parent, name, limit=limit)
    except Exception as error:
        args = BaseException.args.__get__(error)
        if (transport is not None and type(error) is transport.Rejected
                and len(args) == 1 and type(args[0]) is str and args[0] == 'SOURCE_INVALID'
                and len(authority.fds) == count + 1):
            try:
                row = os.fstat(authority.fds[-1])
                reason = ('SOURCE_TYPE' if not stat.S_ISREG(row.st_mode) else
                          'SOURCE_OWNER' if row.st_uid != 0 else
                          'SOURCE_LINKS' if row.st_nlink != 1 else
                          'SOURCE_WRITABLE' if stat.S_IMODE(row.st_mode) & 0o022 else
                          'SOURCE_SIZE' if not 0 < row.st_size <= limit else None)
                if reason is not None:
                    raise Rejected(stage + '_' + reason) from None
            except Rejected:
                raise
            except Exception:
                pass
        raise


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def file_identity(item):
    return (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
            item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)


def load(raw, name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def producer_validate(value):
    need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    need(all(type(value[n]) is str and re.fullmatch('[a-f0-9]{40}', value[n])
             for n in ('commit', 'sourceTree')))
    need(all(type(value[n]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[n])
             for n in ('workflowRunId', 'workflowRunAttempt')))
    return value


def binding_validate(value):
    need(type(value) is dict and set(value) == {'producer', 'controllerPins', 'packagePins',
         'scriptPins', 'extraPins', 'source21Sha256', 'maintenanceSourceSha256'})
    producer_validate(value['producer'])
    for field, names in (('controllerPins', CONTROLLERS), ('packagePins', PACKAGE_FILES),
                         ('scriptPins', SCRIPT_FILES), ('extraPins', EXTRA_FILES)):
        need(type(value[field]) is dict and set(value[field]) == set(names)
             and all(type(pin) is str and HEX.fullmatch(pin) for pin in value[field].values()))
    need(type(value['source21Sha256']) is str
         and value['source21Sha256'] == sha(canonical({'controllers': value['controllerPins'],
                                                     'package': value['packagePins']})))
    need(type(value['maintenanceSourceSha256']) is str
         and value['maintenanceSourceSha256'] == sha(canonical({
             'installer': value['extraPins']['backup-retention-install.py'], 'scripts': value['scriptPins']})))
    return value


def selection(environ):
    need(environ.get('RELEASE_OPERATION') == OPERATION
         and environ.get('EXPECTED_CURRENT') == BASELINE
         and environ.get('GITHUB_REF') == 'refs/heads/main'
         and environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and environ.get('RELEASE_ADMIN_ONLY', 'false') == 'false')
    forbidden = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID',
                 'REUSE_IMAGE_RUN_ATTEMPT', 'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256',
                 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', 'RELEASE_BROWSER_CACHE_IMAGE',
                 'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')
    need(not any(environ.get(n) for n in forbidden))
    return producer_validate({key: environ.get(name) for key, name in
        (('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
         ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})


def checked_parent(path, create_leaf=False):
    """Root-owned no-follow directory walk; create only the last exact directory."""
    need(path.is_absolute() and '..' not in path.parts)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for index, part in enumerate(path.parts[1:]):
            try:
                item = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                need(create_leaf and index == len(path.parts) - 2, 'SOURCE_INVALID')
                os.mkdir(part, 0o700, dir_fd=fd)
                item = os.stat(part, dir_fd=fd, follow_symlinks=False)
            need(stat.S_ISDIR(item.st_mode) and item.st_uid == 0
                 and not stat.S_IMODE(item.st_mode) & 0o022, 'SOURCE_INVALID')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                seen = os.fstat(child)
                need((item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid)
                     == (seen.st_dev, seen.st_ino, seen.st_mode, seen.st_uid, seen.st_gid), 'SOURCE_INVALID')
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def store_exact(path, raw, mode, *, create=True):
    """Refuse replacement, links and files with different reviewed bytes."""
    need(type(raw) is bytes and 0 < len(raw) <= 1024**2 and mode in (0o600, 0o700) and type(create) is bool)
    parent = checked_parent(path.parent, create_leaf=create)
    fd = None
    temporary = None
    created_identity = None
    try:
        if create:
            try:
                temporary = '.backup-retention-' + secrets.token_hex(16)
                fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             mode, dir_fd=parent)
                first = os.fstat(fd)
                created_identity = first.st_dev, first.st_ino
                need(stat.S_ISREG(first.st_mode) and first.st_uid == 0 and first.st_nlink == 1
                     and stat.S_IMODE(first.st_mode) == mode and first.st_size == 0, 'ENTRY_CHANGED')
                offset = 0
                while offset < len(raw):
                    count = os.write(fd, raw[offset:])
                    need(count > 0, 'IO_FAILURE')
                    offset += count
                os.fsync(fd)
                ready = os.fstat(fd)
                need(ready.st_size == len(raw) and ready.st_nlink == 1
                     and file_identity(ready) == file_identity(os.stat(temporary, dir_fd=parent, follow_symlinks=False)), 'ENTRY_CHANGED')
                os.lseek(fd, 0, os.SEEK_SET)
                need(os.read(fd, len(raw) + 1) == raw, 'ENTRY_CHANGED')
                os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.unlink(temporary, dir_fd=parent)
                temporary = None
            except FileExistsError:
                if fd is not None:
                    os.close(fd)
                    fd = None
        if fd is None:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) == mode and before.st_size == len(raw), 'ENTRY_CHANGED')
        os.lseek(fd, 0, os.SEEK_SET)
        content = os.read(fd, len(raw) + 1)
        after = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(content == raw and file_identity(before) == file_identity(os.fstat(fd))
             == file_identity(after), 'ENTRY_CHANGED')
        visible_parent = checked_parent(path.parent)
        try:
            identity = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid)
            need(identity(os.fstat(parent)) == identity(os.fstat(visible_parent)), 'SOURCE_INVALID')
        finally:
            os.close(visible_parent)
        os.fsync(parent)
    finally:
        if temporary is not None and created_identity is not None:
            try:
                current = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == created_identity:
                    os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        if fd is not None:
            os.close(fd)
        os.close(parent)


def native(arguments, timeout=30):
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
    need(result.returncode == 0 and len(result.stdout) <= 65536, 'SYSTEMD_FAILED')
    return result.stdout.decode().strip()


def systemctl(*arguments, timeout=30):
    return native(['/usr/bin/systemctl', *arguments], timeout=timeout)


def entry_matches(value, path):
    # systemctl show emits a public structural ExecStart record, never environment values.
    return (type(value) is str and value.count('path=') == 1 and value.count('argv[]=') == 1
            and 'path=' + str(path) + ' ;' in value
            and 'argv[]=' + str(path) + ' ;' in value)


def retention_limits(raw):
    need(type(raw) is bytes, 'SOURCE_INVALID')
    values = {}
    for line in raw.decode().splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('MYSQL_BACKUP_LOCAL_RETENTION_COUNT', 'MYSQL_BACKUP_LOCAL_MAX_BYTES'):
            need(key not in values, 'SOURCE_INVALID')
            values[key] = value
    count = values.get('MYSQL_BACKUP_LOCAL_RETENTION_COUNT') or '48'
    maximum = values.get('MYSQL_BACKUP_LOCAL_MAX_BYTES') or '1073741824'
    need(re.fullmatch('[1-9][0-9]{0,19}', count) and 2 <= int(count) <= 336
         and re.fullmatch('[1-9][0-9]{0,19}', maximum) and int(maximum) >= 67108864, 'SOURCE_INVALID')
    return count, maximum


def references_plan(helper, limits, *, timeout=30):
    output = native(['/usr/bin/python3', '-B', str(helper), '--retention-count', limits[0],
                     '--max-bytes', limits[1]], timeout=timeout)
    def unique(items):
        value = {}
        for key, item in items:
            need(key not in value, 'SOURCE_INVALID')
            value[key] = item
        return value
    def invalid(unused):
        raise Rejected('SOURCE_INVALID')
    try:
        value = json.loads(output, object_pairs_hook=unique, parse_constant=invalid)
    except (ValueError, UnicodeError):
        raise Rejected('SOURCE_INVALID') from None
    need(type(value) is dict and set(value) == PLAN_FIELDS
         and type(value['kind']) is str and value['kind'] == 'MYSQL_BACKUP_RETENTION_V1'
         and type(value['status']) is str and value['status'] == 'PLAN_ONLY'
         and type(value['code']) is str and value['code'] == 'OK'
         and value['rawOutputSuppressed'] is True, 'SOURCE_INVALID')
    counts = ('protectedCount', 'countBefore', 'candidateCount', 'removedCount', 'countAfter', 'retainedBytes')
    need(all(type(value[name]) is int and value[name] >= 0 for name in counts)
         and value['removedCount'] == 0 and value['countAfter'] == value['countBefore']
         and value['candidateCount'] <= value['countBefore'] <= 4096, 'SOURCE_INVALID')


def empty_result(binding):
    binding_validate(binding)
    return {'kind': 'MYSQL_BACKUP_RETENTION_INSTALL_V1', 'producer': binding['producer'],
            'source21Sha256': binding['source21Sha256'],
            'maintenanceSourceSha256': binding['maintenanceSourceSha256'],
            'status': 'FAILED', 'code': 'IO_FAILURE', 'mutationAttempted': False,
            'entryVerified': False, 'timerRestored': False, 'currentUnchanged': False,
            'servicesUnchanged': False, 'servicesBeforeSha256': 'NOT_MEASURED',
            'servicesAfterSha256': 'NOT_MEASURED', 'originalSourcePreserved': False,
            'rawOutputSuppressed': True}


def install(binding, scripts, authority, snapshot_read, *, source_check, clock=time.monotonic, pause=time.sleep, deadline=None,
            transport=None, diagnostic=None, snapshot_validate=None):
    """Install exact maintenance files; the original timer always remains running."""
    result = empty_result(binding)
    timer_state = None
    stage = 'SOURCE_INITIAL'
    deadline = clock() + 760 if deadline is None else deadline
    def remaining():
        seconds = deadline - clock()
        need(seconds > 0, 'SERVICE_BUSY')
        return min(30, seconds)
    def control(*arguments):
        return systemctl(*arguments, timeout=remaining())
    def wait_idle():
        while True:
            state = control('show', SERVICE, '--property=ActiveState', '--value')
            if state in ('inactive', 'failed'):
                return
            need(state in ('activating', 'deactivating', 'active'), 'SERVICE_BUSY')
            pause(min(2, remaining()))
    try:
        need(os.getuid() == 0 and os.geteuid() == 0)
        need(set(scripts) == {'backup-aws-mysql.sh', 'backup-retention-protection.py'})
        need(all(type(raw) is bytes and sha(raw) == binding['scriptPins'][name]
                 for name, raw in scripts.items()), 'SOURCE_INVALID')
        source_check()
        stage = 'AUTHORITY_INITIAL'
        authority.check()
        stage = 'SNAPSHOT_INITIAL'
        before = snapshot_read(authority.current)
        need(type(before) is str and HEX.fullmatch(before), 'SERVICES_CHANGED')
        result['servicesBeforeSha256'] = before
        stage = 'CURRENT_SCRIPTS'
        original_scripts = authority.child(authority.current_fd, 'scripts', role='CURRENT_RELEASE')
        stage = 'BACKUP_SCRIPT'
        read_original(authority, original_scripts, 'backup-aws-mysql.sh', stage=stage, transport=transport)
        stage = 'NORMALIZER'
        read_original(authority, original_scripts, 'mysql-dump-restore-normalizer.sed', stage=stage, transport=transport)
        stage = 'ENV_LIMITS'
        limits = retention_limits(read_original(authority, authority.current_fd, '.env.aws.production', stage=stage, transport=transport))
        stage = 'COMPOSE'
        read_original(authority, authority.current_fd, 'docker-compose.aws-mysql.yml', stage=stage, transport=transport, limit=1024**2)
        destination = BASE / 'maintenance' / ('mysql-backup-' + binding['maintenanceSourceSha256'][:16])
        entry = destination / 'backup-aws-mysql.sh'
        stage = 'SERVICE_ENTRY'
        prior_entry = control('show', SERVICE, '--property=ExecStart', '--value')
        need(entry_matches(prior_entry, BASE / 'current/scripts/backup-aws-mysql.sh')
             or entry_matches(prior_entry, entry), 'ENTRY_CHANGED')
        stage = 'DROPINS'
        need(control('show', SERVICE, '--property=DropInPaths', '--value') in ('', str(DROPIN)), 'ENTRY_CHANGED')
        stage = 'TIMER_STATE'
        timer_state = control('show', TIMER, '--property=ActiveState', '--value')
        need(timer_state in ('active', 'inactive'), 'TIMER_CHANGED')
        stage = 'SERVICE_IDLE'
        wait_idle()
        stage = 'AUTHORITY_RECHECK'
        authority.check()
        stage = 'SOURCE_RECHECK'
        source_check()
        stage = 'SNAPSHOT_RECHECK'
        need(snapshot_read(authority.current) == before, 'SERVICES_CHANGED')
        remaining()
        result['mutationAttempted'] = True
        stage = 'MAINTENANCE'
        parent = checked_parent(destination.parent, create_leaf=True)
        os.close(parent)
        for name, raw in scripts.items():
            store_exact(destination / name, raw, 0o700 if name.endswith('.sh') else 0o600)
        native(['/usr/bin/bash', '-n', str(entry)], timeout=remaining())
        references_plan(destination / 'backup-retention-protection.py', limits, timeout=remaining())
        for name, raw in scripts.items():
            store_exact(destination / name, raw, 0o700 if name.endswith('.sh') else 0o600, create=False)
        stage = 'AUTHORITY_RECHECK'
        authority.check()
        stage = 'SOURCE_RECHECK'
        source_check()
        stage = 'SNAPSHOT_RECHECK'
        need(snapshot_read(authority.current) == before, 'SERVICES_CHANGED')
        # This drop-in applies to both the timer and fresh_backup's explicit start.
        configuration = ('[Service]\nExecStart=\nExecStart=' + str(entry) + '\n').encode()
        stage = 'MAINTENANCE'
        store_exact(DROPIN, configuration, 0o600)
        control('daemon-reload')
        # A timer firing before reload may still have started the original oneshot.
        stage = 'SERVICE_IDLE'
        wait_idle()
        stage = 'ENTRY_VERIFY'
        need(entry_matches(control('show', SERVICE, '--property=ExecStart', '--value'), entry), 'ENTRY_CHANGED')
        need(control('show', SERVICE, '--property=DropInPaths', '--value') == str(DROPIN), 'ENTRY_CHANGED')
        result['entryVerified'] = True
        for name, raw in scripts.items():
            store_exact(destination / name, raw, 0o700 if name.endswith('.sh') else 0o600, create=False)
        store_exact(DROPIN, configuration, 0o600, create=False)
        stage = 'AUTHORITY_RECHECK'
        authority.check()
        stage = 'SOURCE_RECHECK'
        source_check()
        stage = 'POSTCHECK'
        after = snapshot_read(authority.current)
        need(type(after) is str and HEX.fullmatch(after), 'SERVICES_CHANGED')
        result['servicesAfterSha256'] = after
        need(after == before, 'SERVICES_CHANGED')
        result['timerRestored'] = control('show', TIMER, '--property=ActiveState', '--value') == timer_state
        need(result['timerRestored'], 'TIMER_CHANGED')
        result.update(currentUnchanged=True, servicesUnchanged=True, originalSourcePreserved=True,
                      status='COMPLETED', code='OK')
    except Exception as error:
        result['code'] = failure_code(error, stage, transport=transport, diagnostic=diagnostic,
                                      snapshot_validate=snapshot_validate)
        if result['mutationAttempted']:
            result['status'] = 'FAILED_MUTATED_UNVERIFIED'
    finally:
        if timer_state in ('active', 'inactive') and result['status'] != 'COMPLETED':
            try:
                result['timerRestored'] = control('show', TIMER, '--property=ActiveState', '--value') == timer_state
            except Exception:
                result['timerRestored'] = False
    return result


def remote_execute(binding, scripts, directory, snapshot, transport):
    binding_validate(binding)
    need(directory == BASE / '.staging' / ('api-workspace-verify-' + binding['producer']['commit']))
    deadline = time.monotonic() + 760
    def source_check():
        try:
            raw = {name: snapshot.read_fixed(directory / name, pin)
                   for name, pin in binding['controllerPins'].items()}
            for name, pin in binding['packagePins'].items():
                snapshot.read_fixed(directory / 'formal-runtime-package' / name, pin)
            for name, pin in binding['extraPins'].items():
                snapshot.read_fixed(directory / name, pin)
            return raw
        except Exception:
            raise Rejected('SOURCE_INVALID') from None
    authority = None
    stage = 'SOURCE_INITIAL'
    try:
        raw = source_check()
        modules = {name: snapshot.literal_module(raw[name],
                   'retention_' + name.replace('-', '_').replace('.', '_'), directory / name)
                   for name in ('online-recharge-scope.py', 'api-admin-scope.py', 'remote-deploy.py')}
        diagnostic = snapshot.snapshot_state()
        stage = 'AUTHORITY_OPEN'
        authority = transport.Authority()
        stage = 'CLIENT_SETUP'
        with tempfile.TemporaryDirectory(prefix='backup-retention-client-', dir=directory) as temporary:
            client = Path(temporary)
            client.chmod(0o700)
            store_exact(client / 'config.json', b'{}\n', 0o600)
            driver = snapshot.NativeSnapshotDriver(authority.current, client, modules['online-recharge-scope.py'],
                modules['api-admin-scope.py'], modules['remote-deploy.py'], diagnostic)
            original_native = driver.native
            def bounded_native(*arguments, timeout=30):
                seconds = int(deadline - time.monotonic())
                need(seconds > 0, 'SERVICE_BUSY')
                return original_native(*arguments, timeout=min(timeout, 30, seconds))
            driver.native = bounded_native
            return install(binding, scripts, authority, driver.snapshot, source_check=source_check, deadline=deadline,
                           transport=transport, diagnostic=diagnostic, snapshot_validate=getattr(snapshot, 'snapshot_validate', None))
    except Exception as error:
        result = empty_result(binding)
        result['code'] = failure_code(error, stage, transport=transport)
        return result
    finally:
        if authority is not None:
            authority.close()


def parameters(producer, source=None):
    producer_validate(producer)
    source = Path(__file__).parent if source is None else Path(source)
    helper = load((source / 'api-admin-readonly.py').read_bytes(), 'retention_carrier', source / 'api-admin-readonly.py')
    transport_name = 'online-recharge-backup-source-recovery-transport.py'
    snapshot_name = 'online-recharge-source-permission-repair-transport.py'
    install_name = 'backup-retention-install.py'
    scripts = {name: (source.parent / name).read_bytes()
               for name in ('backup-aws-mysql.sh', 'backup-retention-protection.py')}
    script_pins = {name: sha(raw) for name, raw in scripts.items()}
    extra = {name: sha((source / name).read_bytes()) for name in (transport_name, snapshot_name, install_name)}
    controllers = {name: sha((source / name).read_bytes()) for name in helper.FORMAL_RUNTIME_CONTROLLERS}
    packages = {name: sha((source / 'formal-runtime-package' / name).read_bytes()) for name in helper.FORMAL_RUNTIME_FILES}
    need(set(controllers) == set(CONTROLLERS) and set(packages) == set(PACKAGE_FILES))
    binding = {'producer': producer, 'controllerPins': controllers, 'packagePins': packages, 'scriptPins': script_pins,
               'extraPins': extra, 'source21Sha256': sha(canonical({'controllers': controllers, 'package': packages})),
               'maintenanceSourceSha256': sha(canonical({'installer': extra[install_name], 'scripts': script_pins}))}
    binding_validate(binding)
    directory = BASE / '.staging' / ('api-workspace-verify-' + producer['commit'])
    commands = ['set -eu', 'umask 077']
    commands += helper.formal_runtime_commands(str(directory), producer['commit'], source / 'formal-runtime-package', source)
    store = inspect.getsource(helper._store_files) + '\n_store_files(' + repr(str(directory)) + ',' + repr(producer['commit']) + ',' + repr(extra) + ',False)\n'
    transport = load((source / transport_name).read_bytes(), 'retention_transport', source / transport_name)
    commands.append(transport.packed_command(store.encode(), 16384))
    # All byte literals are public source; no environment, cookies or credentials are carried.
    body = 'import hashlib,os,stat,types\nfrom pathlib import Path\n'
    body += 'def identity(s):\n return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)\n'
    body += 'def module(path,expected):\n fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);s=os.fstat(fd)\n try:\n  assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=2*1024**2\n  raw=os.read(fd,2*1024**2+1);assert len(raw)==s.st_size and hashlib.sha256(raw).hexdigest()==expected and identity(s)==identity(os.fstat(fd)) and identity(s)==identity(os.lstat(path))\n finally: os.close(fd)\n value=types.ModuleType(path.name);value.__file__=str(path);exec(compile(raw,str(path),"exec"),value.__dict__);return value\n'
    body += 'directory=Path(' + repr(str(directory)) + ')\n'
    for variable, name in (('snapshot', snapshot_name), ('transport', transport_name), ('installer', install_name)):
        body += variable + '=module(directory/' + repr(name) + ',' + repr(extra[name]) + ')\n'
    body += 'binding=' + repr(binding) + '\nscripts=' + repr(scripts) + '\n'
    body += 'value=installer.remote_execute(binding,scripts,directory,snapshot,transport)\nprint(' + repr(PREFIX) + '+installer.canonical(value).decode())\nraise SystemExit(0 if value["status"]=="COMPLETED" else 1)\n'
    commands.append(transport.packed_command(body.encode(), 128*1024))
    payload = {'commands': commands, 'executionTimeout': ['900']}
    need(len(canonical(payload)) < 20480)
    return payload, binding


def validate_result(value, binding):
    binding_validate(binding)
    need(type(value) is dict and set(value) == FIELDS
         and type(value['kind']) is str and value['kind'] == 'MYSQL_BACKUP_RETENTION_INSTALL_V1'
         and type(value['source21Sha256']) is str and value['source21Sha256'] == binding['source21Sha256']
         and type(value['maintenanceSourceSha256']) is str and value['maintenanceSourceSha256'] == binding['maintenanceSourceSha256']
         and type(value['status']) is str and value['status'] in ('COMPLETED', 'FAILED', 'FAILED_MUTATED_UNVERIFIED')
         and type(value['code']) is str and value['code'] in CODES)
    need(producer_validate(value['producer']) == binding['producer'])
    flags = ('mutationAttempted', 'entryVerified', 'timerRestored', 'currentUnchanged',
             'servicesUnchanged', 'originalSourcePreserved', 'rawOutputSuppressed')
    need(all(type(value[n]) is bool for n in flags) and value['rawOutputSuppressed'])
    need(all(type(value[n]) is str and (value[n] == 'NOT_MEASURED' or HEX.fullmatch(value[n]))
             for n in ('servicesBeforeSha256', 'servicesAfterSha256')))
    if value['status'] == 'COMPLETED':
        need(value['code'] == 'OK' and all(value[n] for n in flags)
             and value['servicesBeforeSha256'] == value['servicesAfterSha256']
             and HEX.fullmatch(value['servicesBeforeSha256']))
    else:
        need(value['code'] != 'OK'
             and value['mutationAttempted'] == (value['status'] == 'FAILED_MUTATED_UNVERIFIED'))
    return value


def main():
    need(len(sys.argv) == 1)
    producer = selection(os.environ)
    payload, binding = parameters(producer)
    source = Path(__file__).parent
    transport = load((source / 'online-recharge-backup-source-recovery-transport.py').read_bytes(),
                     'retention_aws', source / 'online-recharge-backup-source-recovery-transport.py')
    command_id = None
    value = None
    try:
        prefix = ('aws', '--region', os.environ['AWS_REGION'], 'ssm')
        instance = os.environ['PRODUCTION_INSTANCE_ID']
        command_id = transport.aws(*prefix, 'send-command', '--instance-ids', instance,
            '--document-name', 'AWS-RunShellScript', '--parameters', canonical(payload).decode(),
            '--timeout-seconds', '900', '--comment', 'ID reviewed backup retention entry',
            '--query', 'Command.CommandId', '--output', 'text').decode().strip()
        need(UUID.fullmatch(command_id))
        for unused in range(96):
            time.sleep(10)
            invocation = transport.closed(transport.aws(*prefix, 'get-command-invocation',
                '--command-id', command_id, '--instance-id', instance, '--output', 'json'), 128*1024)
            need(invocation.get('CommandId') == command_id and invocation.get('InstanceId') == instance)
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                continue
            output = invocation.get('StandardOutputContent')
            need(type(output) is str and output.startswith(PREFIX) and output.endswith('\n')
                 and len(output.encode()) <= 6000 and output.count('\n') == 1)
            value = validate_result(transport.closed(output[len(PREFIX):].encode(), 6000), binding)
            need((invocation.get('Status') == 'Success' and invocation.get('ResponseCode') == 0)
                 == (value['status'] == 'COMPLETED'))
            if value['status'] == 'COMPLETED':
                need(invocation.get('StandardErrorContent') == '')
            break
    except Exception:
        value = None
    record = {'kind': 'MYSQL_BACKUP_RETENTION_INSTALL_ARTIFACT_V1', 'operation': OPERATION,
              'producer': producer, 'commandId': command_id if command_id and UUID.fullmatch(command_id) else None,
              'status': 'COMPLETED' if value and value['status'] == 'COMPLETED' else 'FAILED', 'result': value}
    helper = load((source / 'api-admin-readonly.py').read_bytes(), 'retention_write', source / 'api-admin-readonly.py')
    helper.write_workspace_private_bytes(ARTIFACT, canonical(record) + b'\n')
    print(canonical(record).decode())
    return 0 if record['status'] == 'COMPLETED' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('{"status":"FAILED","code":"INPUT_OR_ARTIFACT_INVALID"}')
        raise SystemExit(1) from None
