#!/usr/bin/env python3
"""Create an encrypted recovery point for the formal recharge MySQL database."""
import base64
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile

from snapshot import BACKUP_FILENAME, MYSQL_DATABASE, ROOT, file_digest, take_snapshot

PREFIX = 'mysql/daily/independent-recharge'
NATIVE = 'id-business-independent-recharge-native'
MANIFEST = 'manifest.json'
KEY_WRAP = 'RSA-OAEP-SHA256'


class BackupError(Exception):
    pass


def private_json(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid()
            or not 0 < info.st_size <= 16384):
        raise BackupError('Invalid private backup metadata')
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise BackupError('Invalid private backup metadata')
    return data


def load_target(path):
    target = private_json(path)
    patterns = {
        'bucket': r'id-business-v2-backups-[0-9]{12}-[a-z0-9-]+',
        'account': r'[0-9]{12}',
        'region': r'[a-z]{2}-[a-z]+-[1-9][0-9]*',
        'role': r'[A-Za-z0-9_+=,.@-]{1,64}',
        'recipientSha256': r'[a-f0-9]{64}',
    }
    if set(target) != set(patterns) or any(
        not isinstance(target[key], str) or not re.fullmatch(pattern, target[key])
        for key, pattern in patterns.items()
    ):
        raise BackupError('Invalid S3 backup target')
    if target['bucket'] != f"id-business-v2-backups-{target['account']}-{target['region']}":
        raise BackupError('S3 backup bucket does not match its AWS account and region')
    return target


def aws_json(target, service, action, *args):
    # Resolve credentials from the instance role, including when invoked manually by an operator.
    env = {key: value for key, value in os.environ.items() if not key.startswith('AWS_')}
    env.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null',
               AWS_MAX_ATTEMPTS='1', AWS_EC2_METADATA_V1_DISABLED='true')
    command = ['aws', '--region', target['region'], '--no-cli-pager',
               '--cli-connect-timeout', '8', '--cli-read-timeout', '30',
               service, action, *args, '--output', 'json']
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True,
                                check=True, timeout=60)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise BackupError(f'AWS {service} {action} failed') from None


def check_role(target):
    identity = aws_json(target, 'sts', 'get-caller-identity')
    role = f"arn:aws:sts::{target['account']}:assumed-role/{target['role']}/"
    arn = identity.get('Arn', '')
    if (identity.get('Account') != target['account'] or not arn.startswith(role)
            or not re.fullmatch(r'i-[a-f0-9]+', arn[len(role):])):
        raise BackupError('Backup must use the configured EC2 instance role')


def upload_verified(target, key, path, digest):
    sha256 = base64.b64encode(bytes.fromhex(digest)).decode('ascii')
    source = ('--bucket', target['bucket'], '--key', key, '--expected-bucket-owner', target['account'])
    try:
        aws_json(target, 's3api', 'put-object', *source, '--body', str(path),
                 '--server-side-encryption', 'AES256', '--checksum-algorithm', 'SHA256',
                 '--checksum-sha256', sha256, '--if-none-match', '*')
    except BackupError:
        # A successful PUT can lose its response. Read back the same immutable key first.
        pass
    remote = aws_json(target, 's3api', 'head-object', *source, '--checksum-mode', 'ENABLED')
    if (remote.get('ChecksumSHA256') != sha256 or remote.get('ContentLength') != path.stat().st_size
            or remote.get('ServerSideEncryption') != 'AES256'):
        raise BackupError('S3 backup identity, checksum or encryption differs')
    version = remote.get('VersionId')
    if not isinstance(version, str) or version in ('', 'null'):
        raise BackupError('S3 backup bucket must have versioning enabled')
    return version


def utc_now():
    return datetime.now(timezone.utc)


def sync_file(path):
    with path.open('rb') as file:
        os.fsync(file.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def wrap_backup_key(recipient, expected_digest):
    info = recipient.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not 0 < info.st_size <= 16384
            or file_digest(recipient) != expected_digest):
        raise BackupError('Offline recovery recipient does not match its pinned public key')
    key = secrets.token_hex(32)
    encrypted = subprocess.run(
        ['openssl', 'pkeyutl', '-encrypt', '-pubin', '-inkey', str(recipient),
         '-pkeyopt', 'rsa_padding_mode:oaep', '-pkeyopt', 'rsa_oaep_md:sha256',
         '-pkeyopt', 'rsa_mgf1_md:sha256'],
        input=key.encode('ascii'), capture_output=True, timeout=15, check=True).stdout
    if len(encrypted) < 384 or file_digest(recipient) != expected_digest:
        raise BackupError('Offline recovery recipient changed or uses insufficient RSA key size')
    return key, {'algorithm': KEY_WRAP, 'recipientSha256': expected_digest,
                 'ciphertext': base64.b64encode(encrypted).decode('ascii')}


def capture(target, pending):
    release_lock = ROOT / 'formal' / '.application-release.lock'
    with release_lock.open('r') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        status = subprocess.check_output(
            ['docker', 'inspect', '--format',
             '{{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}}', NATIVE],
            text=True, timeout=15).strip()
        match = re.fullmatch(r'true ([a-f0-9]{40})', status)
        if not match:
            raise BackupError('Could not identify the running formal recharge version')
        captured_at = utc_now().strftime('%Y%m%dT%H%M%SZ')
        with tempfile.TemporaryDirectory(prefix='.capture-', dir=pending.parent) as temporary:
            stage = Path(temporary) / 'backup'
            recipient = ROOT / 'formal' / 'google-drive-backup' / 'recipient.pem'
            key, wrapped = wrap_backup_key(recipient, target['recipientSha256'])
            manifest = take_snapshot(match[1], stage, backup_key=key)
            manifest.update(capturedAt=captured_at, wrappedKey=wrapped)
            (stage / MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n')
            sync_file(stage / BACKUP_FILENAME)
            sync_file(stage / MANIFEST)
            sync_directory(stage)
            stage.rename(pending)
            sync_directory(pending.parent)


def publish(target, pending):
    manifest_path = pending / MANIFEST
    manifest = private_json(manifest_path)
    blob = pending / BACKUP_FILENAME
    blob_info = blob.lstat()
    captured_at = manifest.get('capturedAt')
    revision = manifest.get('revision')
    wrapped = manifest.get('wrappedKey')
    if (not stat.S_ISREG(blob_info.st_mode) or blob_info.st_mode & 0o077
            or blob_info.st_uid != os.geteuid() or blob_info.st_size <= 36
            or manifest.get('encrypted') is not True or manifest.get('verified') is not True
            or manifest.get('database') != MYSQL_DATABASE
            or not isinstance(wrapped, dict) or wrapped.get('algorithm') != KEY_WRAP
            or wrapped.get('recipientSha256') != target['recipientSha256']
            or not isinstance(wrapped.get('ciphertext'), str)
            or not isinstance(captured_at, str) or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', captured_at)
            or not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision)
            or manifest.get('cipherSha256') != file_digest(blob)):
        raise BackupError('Pending encrypted backup failed local validation')
    if len(base64.b64decode(wrapped['ciphertext'], validate=True)) < 384:
        raise BackupError('Invalid wrapped recovery key')
    key = f'{PREFIX}/{captured_at}/{revision}'
    blob_version = upload_verified(target, f'{key}/{BACKUP_FILENAME}', blob, manifest['cipherSha256'])
    manifest_version = upload_verified(target, f'{key}/{MANIFEST}', manifest_path, file_digest(manifest_path))
    return {
        'capturedAt': captured_at,
        'verifiedAt': utc_now().isoformat(),
        'key': f'{key}/{MANIFEST}',
        'cipherSha256': manifest['cipherSha256'],
        'blobVersionId': blob_version,
        'manifestVersionId': manifest_version,
    }


def save_receipt(path, receipt):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.receipt-', delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(receipt, file)
            file.flush()
            os.fsync(file.fileno())
            temporary.replace(path)
            sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def remove_uploaded(directory):
    if directory.is_dir() and not directory.is_symlink():
        for name in (MANIFEST, BACKUP_FILENAME):
            (directory / name).unlink(missing_ok=True)
        directory.rmdir()


def main():
    os.umask(0o077)
    target = load_target(ROOT / 'formal' / 'private' / 'recharge-backup-s3.json')
    check_role(target)
    spool = ROOT / 'backups' / 'scheduled-recharge'
    spool.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = spool.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise BackupError('Invalid private backup spool')
    lock_fd = os.open(spool / '.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        uploaded = spool / '.uploaded'
        remove_uploaded(uploaded)
        pending = spool / 'pending'
        if not pending.exists():
            capture(target, pending)
        if not pending.is_dir() or pending.is_symlink():
            raise BackupError('Invalid pending backup directory')
        receipt = publish(target, pending)
        save_receipt(spool / 'last-upload.json', receipt)
        pending.rename(uploaded)
        sync_directory(spool)
        remove_uploaded(uploaded)
        print(json.dumps({'capturedAt': receipt['capturedAt'], 'offHostVerified': True}))


if __name__ == '__main__':
    try:
        main()
    except BlockingIOError:
        sys.exit('Backup or formal release is in progress. Backup deferred.')
    except BackupError as error:
        sys.exit(str(error))
    except (OSError, ValueError, subprocess.SubprocessError):
        sys.exit('Formal recharge backup failed. Check the private configuration and snapshot status.')
