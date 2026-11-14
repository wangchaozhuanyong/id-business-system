"""Read-only capture of portable state; no restore, service stop or payment call.

The caller holds the existing application release lock. SQLite snapshots and
decrypted systemd credentials remain in memory until encrypted with the existing
offline recovery recipient. This is an ordered recovery interval, not a global
transaction across SQLite, MySQL and independent files.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid

MAX_BYTES = 64 * 1024 * 1024
FILENAME = 'recovery-state.idbackup'
REQUIRED = ('formal/data/local-auth.json', 'formal/data/local-auth.json.security.json',
            'formal/data/local-business.sqlite.key', 'formal/data/recharge-events.checkpoint.json')
TREES = ('formal/operations', 'formal/ops', 'formal/private', 'formal/vendure-state',
         'formal/data/vendure-admission',
         'formal/recharge-data/product_files', 'formal/recharge-data/data')


class RecoveryError(RuntimeError):
    pass


def stamp(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_BYTES:
        raise RecoveryError('recovery_regular_file_required')
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_uid, info.st_gid, info.st_mode


def read_file(path):
    before = stamp(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_uid, info.st_gid, info.st_mode) != before:
            raise RecoveryError('recovery_source_changed')
        value = stream.read(MAX_BYTES + 1)
    if stamp(path) != before or len(value) > MAX_BYTES:
        raise RecoveryError('recovery_source_changed')
    return value, before


def sqlite_snapshot(path, image):
    # The read-only connection includes committed WAL frames. A database file
    # copy alone would omit them. Destination is RAM, never a plaintext file.
    before = stamp(path)
    if not isinstance(image, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise RecoveryError('recovery_snapshot_runtime_required')
    # The host Python may predate sqlite3.serialize(). Use the already running
    # application's pinned Node image and an isolated tmpfs destination instead.
    script = """
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
const db = new DatabaseSync('/source/' + process.argv[1], { readOnly: true, timeout: 3000 });
try { await backup(db, '/snapshot/database.sqlite'); } finally { db.close(); }
const check = new DatabaseSync('/snapshot/database.sqlite', { readOnly: true });
try {
  const rows = check.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw Error('integrity failed');
} finally { check.close(); }
process.stdout.write(await readFile('/snapshot/database.sqlite'));
"""
    name = 'id-recovery-snapshot-' + uuid.uuid4().hex[:16]
    owner = path.stat()
    command = ['docker', 'run', '--rm', '--pull=never', '--name', name,
        '--log-driver', 'none', '--network', 'none', '--read-only',
        '--user', f'{owner.st_uid}:{owner.st_gid}',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32',
        '--memory', '384m', '--memory-swap', '384m', '--cpus', '0.5', '--entrypoint', 'node',
        '--tmpfs', '/snapshot:rw,nosuid,nodev,size=128m,mode=1777',
        '--mount', f'type=bind,src={path.parent},dst=/source,readonly', image,
        '--input-type=module', '-e', script, '--', path.name]
    try:
        result = subprocess.run(command, capture_output=True, timeout=25)
        if result.returncode:
            raise RecoveryError('recovery_sqlite_snapshot_failed')
        data = result.stdout
    finally:
        subprocess.run(['docker', 'stop', '--time', '1', name], capture_output=True, timeout=10)
    if len(data) > MAX_BYTES or stamp(path)[:2] != before[:2]:
        raise RecoveryError('recovery_sqlite_replaced')
    return data


def sealed_credential(name, path):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', name):
        raise RecoveryError('recovery_credential_name_invalid')
    before = stamp(path)
    result = subprocess.run(['systemd-creds', 'decrypt', '--name=' + name, str(path), '-'],
                            capture_output=True, timeout=15)
    if result.returncode or not result.stdout or len(result.stdout) > MAX_BYTES or stamp(path) != before:
        raise RecoveryError('recovery_credential_unavailable')
    return result.stdout


def service_units():
    # Container names and systemd unit names are not interchangeable. Discover
    # the project's installed definitions instead of guessing sidecar names.
    result = subprocess.run(['systemctl', 'list-unit-files', '--no-legend', '--no-pager',
        'id-business-independent*.service', 'id-business-independent*.timer'],
        capture_output=True, text=True, timeout=10)
    names = sorted({line.split()[0] for line in result.stdout.splitlines() if line.split() and
                    re.fullmatch(r'id-business-independent[a-z0-9-]*\.(service|timer)', line.split()[0])})
    if result.returncode or not 1 <= len(names) <= 64 or 'id-business-independent-app.service' not in names:
        raise RecoveryError('recovery_service_inventory_unavailable')
    return names


def collect(root, app_revision, native_revision, *, image=None):
    root = Path(root)
    if root.resolve() != root or not all(re.fullmatch('[a-f0-9]{40}', sha)
                                       for sha in (app_revision, native_revision)):
        raise RecoveryError('recovery_identity_invalid')
    started = datetime.now(timezone.utc).isoformat()
    entries, stable, names, directories = [], {}, set(), {}
    total = 0

    def runtime_path(path):
        return any(part.endswith(('.sessions', '.sock', '.lock')) or part == 'accept-submissions'
                   for part in path.relative_to(root).parts)

    def add(name, content, kind='file', mode=0o600, uid=0, gid=0):
        nonlocal total
        if name in names:
            previous = next(entry for entry in entries if entry['path'] == name)
            if previous['sha256'] != hashlib.sha256(content).hexdigest():
                raise RecoveryError('recovery_duplicate_identity')
            return
        total += len(content)
        if total > MAX_BYTES or len(entries) >= 4096:
            raise RecoveryError('recovery_state_too_large')
        names.add(name)
        entries.append({'path': name, 'kind': kind, 'mode': mode, 'uid': uid, 'gid': gid,
                        'sha256': hashlib.sha256(content).hexdigest(),
                        'data': base64.b64encode(content).decode('ascii')})

    def remember_directories(path):
        while path != root:
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
                raise RecoveryError('recovery_directory_invalid')
            name = path.relative_to(root).as_posix()
            directories[name] = {'path': name, 'mode': stat.S_IMODE(info.st_mode),
                                 'uid': info.st_uid, 'gid': info.st_gid}
            path = path.parent

    def include(path):
        if runtime_path(path):
            return
        relative = path.relative_to(root).as_posix()
        if (path.is_symlink() or not path.resolve().is_relative_to(root) or
                any(parent.is_symlink() for parent in path.parents if parent.is_relative_to(root))):
            raise RecoveryError('recovery_symlink_forbidden')
        remember_directories(path.parent)
        owner = path.stat()
        if path.suffix == '.sqlite':
            add(relative, sqlite_snapshot(path, image), 'sqlite', stat.S_IMODE(owner.st_mode), owner.st_uid, owner.st_gid)
        elif path.suffix == '.cred':
            add('credentials/' + path.stem, sealed_credential(path.stem, path), 'credential')
            stable[path] = stamp(path)
        else:
            data, before = read_file(path)
            add(relative, data, mode=stat.S_IMODE(before[-1]), uid=before[4], gid=before[5])
            # The CDC checkpoint is intentionally captured BEFORE SQLite. Its
            # subsequent advance is safe: replay may duplicate, never skip, work.
            if relative != 'formal/data/recharge-events.checkpoint.json':
                stable[path] = before

    for name in REQUIRED:
        include(root / name)
    include(root / 'formal/data/local-business.sqlite')
    for name in TREES:
        directory = root / name
        if not directory.is_dir() or directory.is_symlink():
            raise RecoveryError('recovery_required_directory_missing')
        remember_directories(directory)
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise RecoveryError('recovery_symlink_forbidden')
            if runtime_path(path):
                continue
            if path.is_dir():
                remember_directories(path)
                continue
            if path.name.endswith(('.lock', '.sock', '-wal', '-shm', '-journal')):
                continue
            include(path)
    for name in ('google-drive-backup', 'google-sheets-sync'):
        for filename in ('settings.json', 'run-' + ('drive-backup' if name == 'google-drive-backup' else 'sheets-sync') + '.py'):
            include(root / 'formal' / name / filename)
    include(root / 'formal/google-drive-backup/recipient.pem')
    # OAuth refresh credentials are provided to the sidecars through private
    # tmpfs configs, rather than LoadCredentialEncrypted. Preserve them only
    # inside the encrypted capsule; no plaintext copy is created on disk.
    for suffix in ('drive-backup', 'sheets-sync'):
        path = Path('/run/id-business-independent-' + suffix + '/config.json')
        data, before = read_file(path)
        add('runtime-config/' + suffix + '.json', data)
        stable[path] = before
    outbox = root / 'formal/google-drive-backup/outbox'
    for path in sorted(outbox.iterdir()):
        if path.name == 'checkpoint.json' or path.name.endswith('.idbackup'):
            include(path)

    for unit in service_units():
        result = subprocess.run(['systemctl', 'cat', unit], capture_output=True, timeout=10)
        if result.returncode:
            raise RecoveryError('recovery_service_definition_unavailable')
        add('services/' + unit, result.stdout, 'service')
        for line in result.stdout.decode().splitlines():
            if not line.startswith('LoadCredentialEncrypted='):
                continue
            binding = line.split('=', 1)[1].strip()
            if not binding:
                continue
            name, separator, filename = binding.partition(':')
            path = Path(filename)
            if not separator or not path.is_absolute() or path.is_symlink() or not (
                path.resolve().is_relative_to(root) or
                path.resolve().is_relative_to('/etc/credstore.encrypted')
            ):
                raise RecoveryError('recovery_credential_binding_requires_review')
            add('credentials/' + name, sealed_credential(name, path), 'credential')
            stable[path] = stamp(path)
    for revision in {app_revision, native_revision}:
        operations = root / 'releases' / revision / 'operations'
        if not operations.is_dir() or operations.is_symlink():
            raise RecoveryError('recovery_active_operations_missing')
        for path in sorted(operations.rglob('*')):
            if not path.is_dir():
                include(path)
    for path, before in stable.items():
        if stamp(path) != before:
            raise RecoveryError('recovery_source_changed')
    for alias in ('credentials', 'services', 'runtime-config'):
        directories[alias] = {'path': alias, 'mode': 0o700, 'uid': 0, 'gid': 0}
    return {'format': 'id-business-recovery-state-v1', 'appRevision': app_revision,
            'nativeRevision': native_revision, 'sessionPolicy': 'revoke', 'startedAt': started,
            'finishedAt': datetime.now(timezone.utc).isoformat(), 'entries': entries,
            'directories': list(directories.values())}


def capture(root, source, app_revision, native_revision, destination, recipient_sha256, image):
    root, source, destination = Path(root), Path(source), Path(destination)
    recipient, _ = read_file(root / 'formal/google-drive-backup/recipient.pem')
    if hashlib.sha256(recipient).hexdigest() != recipient_sha256:
        raise RecoveryError('recovery_recipient_changed')
    state = collect(root, app_revision, native_revision, image=image)
    command = ['docker', 'run', '--rm', '--pull=never', '-i', '--log-driver', 'none',
               '--network', 'none', '--read-only',
               '--user', '0:0',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32',
               '--memory', '384m', '--memory-swap', '384m', '--cpus', '0.5', '--entrypoint', 'node',
               '--mount', f'type=bind,src={source},dst=/app,readonly', image,
               '/app/server/backup/recovery-archive-cli.mjs', 'seal']
    with destination.open('xb') as output:
        os.chmod(destination, 0o600)
        result = subprocess.run(command, input=json.dumps({'state': state,
            'recipient': recipient.decode('ascii')}).encode(), stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.flush()
        os.fsync(output.fileno())
    if result.returncode:
        code = result.stderr.decode('ascii', errors='ignore').strip()
        safe = {'RECOVERY_STATE_INVALID', 'RECOVERY_DIRECTORY_INVALID', 'RECOVERY_ENTRY_INVALID',
                'RECOVERY_DIRECTORY_MISSING', 'RECOVERY_REQUIRED_STATE_MISSING',
                'RECOVERY_RUNTIME_STATE_FORBIDDEN', 'RECOVERY_PUBLIC_KEY_REQUIRED', 'RECOVERY_STATE_TOO_LARGE'}
        raise RecoveryError(code.lower() if code in safe else 'recovery_capsule_encryption_failed')
    receipt = json.loads(result.stderr)
    if (receipt['cipherBytes'] != destination.stat().st_size or
            receipt['cipherSha256'] != hashlib.sha256(destination.read_bytes()).hexdigest()):
        raise RecoveryError('recovery_capsule_digest_mismatch')
    return receipt
