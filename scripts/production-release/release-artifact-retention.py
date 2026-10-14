"""Precisely archive/restore one reviewed release package; no business publication."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time

BASE = Path('/opt/id-business-v2')
OWNER = 0
ACCOUNT = '079740175286'
COMMIT = '294c67d5bca430dfd5d37f08826b1df615d53ae7'
TAG = 'v2-production-20260907T114213Z'
FOLDER = TAG + '-' + COMMIT
PACKAGE = 'id-business-v2-' + FOLDER + '.tar.gz'
RELATIVE = 'artifacts/' + FOLDER + '/' + PACKAGE
PINS = {
    PACKAGE: {'bytes': 1953942933, 'sha256': 'f8f10c17e38ced41e52a216674b2725b73775c761da30976e298de3ed9fa1253'},
    'ci-release-manifest.json': {'bytes': 2132, 'sha256': '5c108b1c49729889e9cfca442eebcd9dd6c0284d5d061bfb850e0c4cd3ca83b1'},
    'SHA256SUMS': {'bytes': 248, 'sha256': '8745c87c28516532c77f595839cb36785d71361a454a2650aa966a3fb36ac55d'},
}
MAX_METADATA = 128 * 1024
MIN_RESTORE_DAYS = 14
RESERVE_BYTES = 2 * 1024**3
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
ETAG = re.compile(r'"[a-f0-9]{32}(?:-[1-9][0-9]*)?"\Z')


class Rejected(RuntimeError):
    pass


def need(ok, code):
    if not ok:
        raise Rejected('ARTIFACT_' + code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return sha(canonical(value))


def closed(raw):
    need(type(raw) in (bytes, str) and 0 < len(raw) <= MAX_METADATA, 'METADATA_BOUND')
    def unique(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'DUPLICATE_FIELD'); result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: need(False, 'METADATA_INVALID'))
    except Rejected:
        raise
    except Exception:
        raise Rejected('ARTIFACT_METADATA_INVALID') from None


def identity(info):
    return dict(zip(('device', 'inode', 'mode', 'uid', 'gid', 'links', 'bytes', 'mtimeNs', 'ctimeNs'),
                    (info.st_dev, info.st_ino, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid,
                     info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)))


def utc(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        need(result.utcoffset() == timedelta(0), 'TIME_INVALID')
        return result
    except Rejected:
        raise
    except Exception:
        raise Rejected('ARTIFACT_TIME_INVALID') from None


class Files:
    """Root-owned descriptor traversal, bounded reads and immutable private receipts."""
    def __init__(self, base=BASE, owner=OWNER):
        self.base, self.owner = Path(base), owner
        self.receipts = self.base / 'maintenance/release-artifact-retention/receipts'

    def directory(self, path, *, create=False, private=False):
        path = Path(path)
        need(path.is_absolute() and '..' not in path.parts, 'PATH_INVALID')
        descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for index, part in enumerate(path.parts[1:]):
                current = Path(*path.parts[:index + 2])
                if create and (current == self.base or self.base in current.parents):
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor); descriptor = child
                info = os.fstat(descriptor)
                need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, self.owner)
                     and info.st_gid in ((0, *os.getgroups()) if self.owner else (0,))
                     and not stat.S_IMODE(info.st_mode) & 0o022, 'DIRECTORY_UNTRUSTED')
                if private and (current == self.receipts.parent or self.receipts.parent in current.parents):
                    need(stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == self.owner,
                         'DIRECTORY_UNTRUSTED')
            return descriptor
        except Exception:
            os.close(descriptor); raise

    def read(self, path, *, size=MAX_METADATA, keep=False, expected=None):
        path = Path(path); parent = self.directory(path.parent)
        try:
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(descriptor, 'rb') as stream:
                before = os.fstat(stream.fileno())
                need(stat.S_ISREG(before.st_mode) and before.st_uid == self.owner
                     and before.st_gid == (os.getegid() if self.owner else 0) and before.st_nlink == 1
                     and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= size, 'FILE_UNTRUSTED')
                checksum, length, blocks = hashlib.sha256(), 0, []
                for block in iter(lambda: stream.read(1024**2), b''):
                    checksum.update(block); length += len(block)
                    need(length <= size, 'FILE_BOUND')
                    if keep: blocks.append(block)
                record = {'sha256': checksum.hexdigest(), 'identity': identity(before)}
                need(length == before.st_size and identity(before) == identity(os.fstat(stream.fileno()))
                     == identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)), 'FILE_CHANGED')
                if expected:
                    need(record['sha256'] == expected['sha256'] and length == expected['bytes'], 'FILE_PIN_CHANGED')
                return record, b''.join(blocks)
        finally:
            os.close(parent)

    def immutable(self, name, value):
        need(re.fullmatch(r'[a-f0-9]{64}(?:-[1-9][0-9]{0,24})?\.(?:plan|attempt|recovery|verified|result|restore)\.json', name),
             'RECEIPT_NAME_INVALID')
        raw = canonical(value) + b'\n'
        need(len(raw) <= MAX_METADATA, 'RECEIPT_BOUND')
        parent = self.directory(self.receipts, create=True, private=True)
        path = self.receipts / name
        try:
            try:
                descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            except FileExistsError:
                need(self.read(path, keep=True)[1] == raw, 'RECEIPT_EXISTS_CHANGED'); return path
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            os.fsync(parent)
            return path
        finally:
            os.close(parent)

    @contextmanager
    def lock(self):
        parent = self.directory(self.base)
        descriptor = os.open('.deploy.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == self.owner and info.st_nlink == 1
                 and not stat.S_IMODE(info.st_mode) & 0o022, 'LOCK_UNTRUSTED')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Rejected('ARTIFACT_BUSY') from None
            def checkpoint():
                need(identity(info) == identity(os.fstat(descriptor))
                     == identity(os.stat('.deploy.lock', dir_fd=parent, follow_symlinks=False)), 'LOCK_CHANGED')
            checkpoint()
            yield checkpoint
            checkpoint()
        finally:
            os.close(descriptor); os.close(parent)


def command(arguments, code, *, timeout=90, limit=MAX_METADATA):
    try:
        result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                                env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC', 'AWS_MAX_ATTEMPTS': '1'})
    except Exception:
        raise Rejected('ARTIFACT_' + code) from None
    need(result.returncode == 0 and len(result.stdout) <= limit, code)
    return result.stdout


def snapshot(files, expected):
    need(type(expected) is str and HEX40.fullmatch(expected), 'CURRENT_INVALID')
    parent = files.directory(files.base)
    try:
        link = os.stat('current', dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISLNK(link.st_mode) and link.st_uid == files.owner, 'CURRENT_INVALID')
        text = os.readlink('current', dir_fd=parent)
        target = Path(text) if Path(text).is_absolute() else files.base / text
        need(target.parent == files.base / 'releases' and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + expected[:12],
             target.name), 'CURRENT_INVALID')
        record, raw = files.read(target / 'release-manifest.json', keep=True)
        need(closed(raw).get('commit') == expected, 'CURRENT_CHANGED')
        ids = command(['docker', 'ps', '-a', '--no-trunc', '--quiet'], 'CONTAINER_LIST_FAILED', limit=65536).decode().splitlines()
        need(len(ids) <= 128 and len(ids) == len(set(ids)) and all(HEX64.fullmatch(x) for x in ids), 'CONTAINERS_INVALID')
        projection = ('{"id":{{json .Id}},"imageId":{{json .Image}},"reference":{{json .Config.Image}},'
            '"running":{{json .State.Running}},"state":{{json .State.Status}},"startedAt":{{json .State.StartedAt}},'
            '"restartCount":{{json .RestartCount}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},'
            '"mounts":{{json .Mounts}}}')
        rows = []
        if ids:
            raw = command(['docker', 'inspect', '--format', projection, *sorted(ids)], 'CONTAINER_INSPECT_FAILED')
            for line in raw.splitlines():
                row = closed(line)
                need(type(row) is dict and set(row) == {'id', 'imageId', 'reference', 'running', 'state', 'startedAt',
                     'restartCount', 'health', 'mounts'} and row['id'] in ids
                     and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'])
                     and type(row['reference']) is str and 0 < len(row['reference']) <= 500
                     and type(row['running']) is bool and type(row['restartCount']) is int
                     and 0 <= row['restartCount'] < 2**31 and row['health'] in (None, 'starting', 'healthy', 'unhealthy')
                     and row['state'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead')
                     and type(row['startedAt']) is str and len(row['startedAt']) <= 80
                     and type(row['mounts']) is list and len(row['mounts']) <= 64, 'CONTAINERS_INVALID')
                mounts = []
                for mount in row['mounts']:
                    need(type(mount) is dict and mount.get('Type') in ('bind', 'volume', 'tmpfs'), 'MOUNTS_INVALID')
                    source, destination = mount.get('Source'), mount.get('Destination')
                    need(type(destination) is str and destination.startswith('/') and len(destination) <= 1000,
                         'MOUNTS_INVALID')
                    if mount['Type'] == 'tmpfs':
                        need(source in (None, ''), 'MOUNTS_INVALID'); source = ''
                    else:
                        need(type(source) is str and source.startswith('/') and len(source) <= 1000, 'MOUNTS_INVALID')
                    mounts.append({'type': mount['Type'], 'source': source, 'destination': destination})
                row['mounts'] = sorted(mounts, key=canonical); rows.append(row)
            need(len(rows) == len(ids) and {x['id'] for x in rows} == set(ids), 'CONTAINERS_INVALID')
        need(identity(link) == identity(os.stat('current', dir_fd=parent, follow_symlinks=False))
             and os.readlink('current', dir_fd=parent) == text, 'CURRENT_CHANGED')
        return {'currentCommit': expected, 'currentRelease': str(target), 'currentManifestSha256': record['sha256'],
                'currentPointerIdentity': identity(link), 'containers': sorted(rows, key=lambda x: x['id'])}
    finally:
        os.close(parent)


def mounts_unused(path, probe):
    for row in probe['containers']:
        for mount in row['mounts']:
            if mount['type'] != 'tmpfs':
                source = Path(mount['source']).resolve()
                need(not path.is_relative_to(source) and not source.is_relative_to(path), 'PACKAGE_MOUNTED')


def unused(path, probe, *, proc=Path('/proc')):
    mounts_unused(path, probe)
    info, count = path.lstat(), 0
    for process in proc.iterdir():
        if not process.name.isdigit() or process.name == str(os.getpid()): continue
        try:
            for descriptor in (process / 'fd').iterdir():
                count += 1; need(count <= 65536, 'FD_BUDGET')
                try:
                    actual = descriptor.stat()
                except (FileNotFoundError, ProcessLookupError):
                    continue
                need((actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino), 'PACKAGE_OPEN')
        except (FileNotFoundError, ProcessLookupError):
            continue


def configuration(files, probe):
    raw = files.read(Path(probe['currentRelease']) / '.env.aws.production', keep=True)[1]
    names = ('MYSQL_BACKUP_S3_BUCKET', 'MYSQL_BACKUP_S3_PREFIX', 'MYSQL_BACKUP_S3_REGION')
    values = {}
    for line in raw.decode().splitlines():
        key, separator, value = line.partition('=')
        if separator and key in names:
            need(key not in values, 'CONFIGURATION_INVALID'); values[key] = value
    bucket, prefix, region = (values.get(names[0], ''), values.get(names[1], 'mysql/daily') or 'mysql/daily',
                              values.get(names[2], 'ap-northeast-1') or 'ap-northeast-1')
    need(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket)
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,200}', prefix)
         and '..' not in prefix.split('/') and re.fullmatch(r'[a-z]{2}(-gov)?-[a-z]+-[0-9]+', region),
         'CONFIGURATION_INVALID')
    return {'bucket': bucket, 'prefix': prefix.rstrip('/') + '/release-artifact-cache/' + FOLDER,
            'region': region, 'accountId': ACCOUNT}


def cloud_proof(files, path, expected_sha, target, *, now=None):
    need(type(expected_sha) is str and HEX64.fullmatch(expected_sha), 'CLOUD_PROOF_REQUIRED')
    path = Path(path)
    need(files.base in path.parents, 'CLOUD_PROOF_PATH_INVALID')
    record, raw = files.read(path, keep=True)
    need(record['sha256'] == expected_sha, 'CLOUD_PROOF_CHANGED')
    value = closed(raw)
    need(type(value) is dict and set(value) == {'kind', 'version', 'bucket', 'prefix', 'region', 'versioning',
          'publicAccessBlock', 'encryption', 'lifecycle', 'minimumRecoveryDays', 'releaseArtifactSubprefix',
          'bucketConfigurationMutationAuthorized'} and value['kind'] == 'ID_RELEASE_ARTIFACT_STORAGE_PROOF_V1'
          and value['version'] == 1 and type(value['version']) is int
          and all(value[key] == target[key] for key in ('bucket', 'region'))
          and target['accountId'] == ACCOUNT and value['versioning'] == {'Status': 'Enabled'}
          and value['prefix'] == 'mysql/daily' and value['releaseArtifactSubprefix'] == 'release-artifact-cache'
          and target['prefix'] == value['prefix'] + '/' + value['releaseArtifactSubprefix'] + '/' + FOLDER
          and value['minimumRecoveryDays'] == MIN_RESTORE_DAYS and value['bucketConfigurationMutationAuthorized'] is False
          and type(value['publicAccessBlock']) is dict
          and value['publicAccessBlock'] == {key: True for key in
              ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')}
          and value['encryption'] == {'ServerSideEncryptionConfiguration': {'Rules': [{
              'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}, 'BucketKeyEnabled': True,
              'BlockedEncryptionTypes': {'EncryptionType': ['SSE-C']}}]}}
          and value['lifecycle'] == {'TransitionDefaultMinimumObjectSize': 'all_storage_classes_128K',
              'Rules': [{'Expiration': {'Days': 90}, 'ID': 'RetainDailyBackups',
                  'Filter': {'Prefix': 'mysql/daily/'}, 'Status': 'Enabled',
                  'NoncurrentVersionExpiration': {'NoncurrentDays': 30}}]},
          'CLOUD_PROOF_INVALID')
    return value


def lifecycle_window(proof, key, size, *, now=None):
    rules = proof['lifecycle']['Rules']
    need(len(rules) == 1 and rules[0] == {'Expiration': {'Days': 90}, 'ID': 'RetainDailyBackups',
         'Filter': {'Prefix': 'mysql/daily/'}, 'Status': 'Enabled',
         'NoncurrentVersionExpiration': {'NoncurrentDays': 30}}
         and key.startswith('mysql/daily/release-artifact-cache/' + FOLDER + '/') and type(size) is int and size > 0,
         'LIFECYCLE_UNKNOWN')
    return [digest(rules[0])]


class Cloud:
    def __init__(self, target):
        self.target = target

    def call(self, operation, *arguments, timeout=90):
        raw = command(['aws', 's3api', '--region', self.target['region'], operation,
                       '--bucket', self.target['bucket'], '--expected-bucket-owner', ACCOUNT,
                       *arguments, '--output', 'json'], 'CLOUD_' + operation.upper().replace('-', '_') + '_FAILED', timeout=timeout)
        return closed(raw)

    def head(self, key, pin, proof):
        value = self.call('head-object', '--key', key, '--checksum-mode', 'ENABLED')
        checksum = base64.b64encode(bytes.fromhex(pin['sha256'])).decode()
        need(type(value) is dict and value.get('ContentLength') == pin['bytes']
             and value.get('ChecksumSHA256') == checksum and value.get('ChecksumType') == 'FULL_OBJECT'
             and value.get('ServerSideEncryption') == 'AES256' and value.get('StorageClass', 'STANDARD') == 'STANDARD'
             and type(value.get('ETag')) is str and ETAG.fullmatch(value['ETag'])
             and value.get('DeleteMarker', False) is False, 'CLOUD_OBJECT_UNKNOWN')
        version = value.get('VersionId')
        need(type(version) is str and version != 'null' and 0 < len(version) <= 1024
             and all(32 < ord(c) < 127 for c in version), 'CLOUD_OBJECT_UNKNOWN')
        now = datetime.now(timezone.utc)
        matching = lifecycle_window(proof, key, pin['bytes'], now=now)
        expiration = value.get('Expiration')
        if expiration is not None:
            from email.utils import parsedate_to_datetime
            match = re.fullmatch(r'expiry-date="([^"]{1,64})", rule-id="([^"]{0,1000})"', expiration)
            need(match is not None and match[2] == 'RetainDailyBackups', 'RETENTION_EXPIRATION_UNKNOWN')
            expires = parsedate_to_datetime(match[1]).astimezone(timezone.utc)
            need(expires >= now + timedelta(days=MIN_RESTORE_DAYS), 'RETENTION_WINDOW_TOO_SHORT')
            expiration = expires.isoformat()
        else:
            raise Rejected('ARTIFACT_RETENTION_EXPIRATION_UNMEASURED')
        return {'key': key, 'sha256': pin['sha256'], 'bytes': pin['bytes'], 'versionId': version,
                'etag': value['ETag'], 'serverSideEncryption': 'AES256', 'checksumType': 'FULL_OBJECT',
                'expirationUtc': expiration, 'lifecycleMatches': matching}

    def upload(self, path, key, pin, proof):
        try:
            self.call('put-object', '--key', key, '--body', str(path), '--server-side-encryption', 'AES256',
                      '--storage-class', 'STANDARD', '--checksum-algorithm', 'SHA256', '--checksum-sha256',
                      base64.b64encode(bytes.fromhex(pin['sha256'])).decode(), '--if-none-match', '*', timeout=600)
        except Rejected:
            pass  # Accepted upload can outlive its reply. Read its exact object; never overwrite or retry PUT.
        return self.head(key, pin, proof)

    def download(self, record, path):
        value = self.call('get-object', '--key', record['key'], '--if-match', record['etag'], str(path), timeout=600)
        need(type(value) is dict and value.get('ETag') == record['etag']
             and value.get('VersionId') == record['versionId']
             and value.get('ContentLength') == record['bytes'], 'CLOUD_DOWNLOAD_CHANGED')


def local_files(files, *, package=True):
    parent = files.base / 'artifacts' / FOLDER
    records, raw = {}, {}
    for name, pin in PINS.items():
        if name == PACKAGE and not package: continue
        record, contents = files.read(parent / name, size=pin['bytes'], keep=name != PACKAGE, expected=pin)
        records[name] = record
        if name != PACKAGE: raw[name] = contents
    manifest = closed(raw['ci-release-manifest.json'])
    need(manifest.get('commit') == COMMIT and manifest.get('releaseTag') == TAG
         and manifest.get('artifact', {}).get('file') == PACKAGE
         and manifest['artifact'].get('sha256') == PINS[PACKAGE]['sha256'], 'NEIGHBOR_CONTRACT_CHANGED')
    sums = {}
    for line in raw['SHA256SUMS'].decode().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        need(match is not None and match[2] not in sums, 'NEIGHBOR_CONTRACT_CHANGED'); sums[match[2]] = match[1]
    need(sums == {PACKAGE: PINS[PACKAGE]['sha256'], 'release-manifest.json': PINS['ci-release-manifest.json']['sha256']},
         'NEIGHBOR_CONTRACT_CHANGED')
    return records


def make_plan(files, expected, proof_path, proof_sha, *, package=True):
    before = snapshot(files, expected)
    mounts_unused(files.base / RELATIVE, before)
    records = local_files(files, package=package)
    target = configuration(files, before)
    proof = cloud_proof(files, proof_path, proof_sha, target)
    for name, pin in PINS.items(): lifecycle_window(proof, target['prefix'] + '/' + name, pin['bytes'])
    if package: unused(files.base / RELATIVE, before)
    need(snapshot(files, expected) == before, 'PROTECTION_CHANGED')
    plan = {'kind': 'ID_RELEASE_ARTIFACT_PLAN_V1', 'version': 1, 'relativePath': RELATIVE,
            'currentCommit': expected, 'sourceProbe': before, 'files': records,
            'targetSha256': digest(target), 'cloudProofSha256': proof_sha,
            'minimumRecoveryDays': MIN_RESTORE_DAYS, 'requiredFreeBytes': PINS[PACKAGE]['bytes'] + RESERVE_BYTES}
    return plan, target, proof


def recovery_index(files, plan, target, objects):
    return {'kind': 'ID_RELEASE_ARTIFACT_RECOVERY_V1', 'version': 1, 'planSha256': digest(plan), 'plan': plan,
            'target': target, 'objects': objects, 'package': {'relativePath': RELATIVE,
                'sha256': PINS[PACKAGE]['sha256'], 'bytes': PINS[PACKAGE]['bytes'],
                'mode': plan['files'][PACKAGE]['identity']['mode'], 'uid': files.owner,
                'gid': plan['files'][PACKAGE]['identity']['gid']}}


def execute(operation, expected, proof_path, proof_sha, approved=None, *, files=None, cloud_factory=Cloud):
    files = files or Files()
    journal = {}
    try:
        return operation_execute(operation, expected, proof_path, proof_sha, approved,
                                 files=files, cloud_factory=cloud_factory, journal=journal)
    except Exception as error:
        code = str(error) if type(error) is Rejected and re.fullmatch(r'ARTIFACT_[A-Z_]+', str(error)) else 'ARTIFACT_IO_FAILED_CLOSED'
        safe = Rejected(code)
        if journal:
            receipt = files.immutable(journal['stem'] + '.result.json', {
                'kind': 'ID_RELEASE_ARTIFACT_FAILURE_V1', 'version': 1, 'operation': operation,
                'status': 'FAILED_CLOSED', 'code': code, 'planSha256': approved,
                'attemptFile': journal['attemptFile'], 'removalState': 'UNKNOWN_REQUIRES_READBACK'})
            safe.receipt_file = str(receipt)
        raise safe from None


def operation_execute(operation, expected, proof_path, proof_sha, approved=None, *, files=None, cloud_factory=Cloud, journal=None):
    files = files or Files()
    need(os.geteuid() == files.owner, 'ROOT_REQUIRED')
    need(operation in ('plan', 'apply', 'restore'), 'OPERATION_INVALID')
    need(approved is None if operation == 'plan' else type(approved) is str and HEX64.fullmatch(approved), 'PLAN_APPROVAL_REQUIRED')
    with files.lock() as checkpoint:
        if operation == 'restore':
            return restore(files, expected, proof_path, proof_sha, approved, cloud_factory, journal, checkpoint)
        plan, target, proof = make_plan(files, expected, proof_path, proof_sha)
        plan_sha = digest(plan)
        checkpoint(); plan_file = files.immutable(plan_sha + '.plan.json', plan)
        summary = {'kind': 'ID_RELEASE_ARTIFACT_RESULT_V1', 'version': 1, 'operation': operation,
            'status': 'PLAN_ONLY', 'planSha256': plan_sha, 'planFile': str(plan_file),
            'relativePath': RELATIVE, 'packageBytes': PINS[PACKAGE]['bytes'],
            'requiredFreeBytes': plan['requiredFreeBytes'], 'sourceProbeSha256': digest(plan['sourceProbe']),
            'targetSha256': digest(target), 'cloudProofSha256': proof_sha, 'minimumRecoveryDays': MIN_RESTORE_DAYS,
            'currentUnchanged': True, 'containersUnchanged': True, 'metadataUnchanged': True, 'removed': False}
        if operation == 'plan': return summary
        need(plan_sha == approved, 'APPROVED_PLAN_CHANGED')
        before_free = shutil.disk_usage(files.base).free
        need(before_free >= plan['requiredFreeBytes'], 'RESTORE_HEADROOM_INSUFFICIENT')
        stamp = str(time.time_ns())
        stem = approved + '-' + stamp
        checkpoint()
        attempt = files.immutable(stem + '.attempt.json', {'kind': 'ID_RELEASE_ARTIFACT_ATTEMPT_V1',
            'operation': operation, 'planSha256': approved, 'sourceProbeSha256': digest(plan['sourceProbe']),
            'state': 'ACCEPTED_LOCAL', 'freeBytesBefore': before_free})
        journal.update(stem=stem, attemptFile=str(attempt))
        cloud = cloud_factory(target)
        objects = {}
        for name, pin in PINS.items():
            checkpoint()
            objects[name] = cloud.upload(files.base / 'artifacts' / FOLDER / name,
                                         target['prefix'] + '/' + name, pin, proof)
        index = recovery_index(files, plan, target, objects)
        checkpoint(); index_file = files.immutable(approved + '.recovery.json', index)
        index_pin = {'bytes': index_file.stat().st_size, 'sha256': files.read(index_file)[0]['sha256']}
        index_object = cloud.upload(index_file, target['prefix'] + '/' + approved + '.recovery.json', index_pin, proof)
        with tempfile.TemporaryDirectory(prefix='full-get-', dir=files.receipts) as temporary:
            root = Path(temporary)
            for name, record in {**objects, 'recovery.json': index_object}.items():
                downloaded = root / name
                cloud.download(record, downloaded)
                downloaded.chmod(0o600)
                files.read(downloaded, size=record['bytes'], expected=record)
                downloaded.unlink()
        fresh, fresh_target, unused_proof = make_plan(files, expected, proof_path, proof_sha)
        need(fresh == plan and fresh_target == target, 'PROTECTION_CHANGED')
        for name, pin in PINS.items():
            need(cloud.head(objects[name]['key'], pin, proof) == objects[name], 'CLOUD_OBJECT_CHANGED')
        need(cloud.head(index_object['key'], index_pin, proof) == index_object, 'CLOUD_OBJECT_CHANGED')
        verified = {**summary, 'status': 'VERIFIED_NOT_REMOVED', 'fullRecoveryVerified': True,
                    'recoveryIndexSha256': index_pin['sha256'], 'recoveryObjectSha256': digest(index_object)}
        checkpoint(); files.immutable(approved + '-' + stamp + '.verified.json', verified)
        parent = files.directory(files.base / 'artifacts' / FOLDER)
        try:
            checkpoint()
            unused(files.base / RELATIVE, plan['sourceProbe'])
            need(snapshot(files, expected) == plan['sourceProbe'], 'PROTECTION_CHANGED')
            checkpoint()
            need(identity(os.stat(PACKAGE, dir_fd=parent, follow_symlinks=False)) == plan['files'][PACKAGE]['identity'],
                 'FILE_CHANGED')
            os.unlink(PACKAGE, dir_fd=parent); os.fsync(parent)
        finally:
            os.close(parent)
        need(local_files(files, package=False) == {k: v for k, v in plan['files'].items() if k != PACKAGE}
             and snapshot(files, expected) == plan['sourceProbe'], 'PROTECTION_CHANGED_AFTER_RELEASE')
        result = {**verified, 'status': 'APPLIED', 'removed': True, 'freeBytesBefore': before_free,
                  'freeBytesAfter': shutil.disk_usage(files.base).free, 'recoveryFile': str(index_file)}
        checkpoint(); receipt = files.immutable(approved + '-' + stamp + '.result.json', result)
        return {**result, 'receiptFile': str(receipt)}


def restore(files, expected, proof_path, proof_sha, approved, cloud_factory, journal, checkpoint):
    index = closed(files.read(files.receipts / (approved + '.recovery.json'), keep=True)[1])
    need(type(index) is dict and set(index) == {'kind', 'version', 'planSha256', 'plan', 'target', 'objects', 'package'}
         and index.get('kind') == 'ID_RELEASE_ARTIFACT_RECOVERY_V1' and index.get('version') == 1
         and index.get('planSha256') == approved == digest(index.get('plan'))
         and index.get('package', {}).get('relativePath') == RELATIVE
         and index['package'].get('sha256') == PINS[PACKAGE]['sha256']
         and index['package'].get('bytes') == PINS[PACKAGE]['bytes']
         and index['package'].get('mode') == 0o600 and index['package'].get('uid') == files.owner
         and index['package'].get('gid') == (os.getegid() if files.owner else 0)
         and type(index.get('objects')) is dict and set(index['objects']) == set(PINS), 'RECOVERY_INDEX_INVALID')
    before = snapshot(files, expected)
    mounts_unused(files.base / RELATIVE, before)
    records = local_files(files, package=False)
    need(records == {k: v for k, v in index['plan']['files'].items() if k != PACKAGE}, 'NEIGHBORS_CHANGED')
    target = configuration(files, before)
    need(target == index['target'], 'RECOVERY_TARGET_CHANGED')
    proof = cloud_proof(files, proof_path, proof_sha, target)
    need(shutil.disk_usage(files.base).free >= 2 * PINS[PACKAGE]['bytes'] + RESERVE_BYTES, 'RESTORE_HEADROOM_INSUFFICIENT')
    parent = files.directory(files.base / 'artifacts' / FOLDER)
    try:
        try:
            os.stat(PACKAGE, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise Rejected('ARTIFACT_RESTORE_TARGET_EXISTS')
        stem = approved + '-' + str(time.time_ns())
        checkpoint()
        attempt = files.immutable(stem + '.attempt.json', {'kind': 'ID_RELEASE_ARTIFACT_ATTEMPT_V1',
            'operation': 'restore', 'planSha256': approved, 'sourceProbeSha256': digest(before), 'state': 'ACCEPTED_LOCAL'})
        journal.update(stem=stem, attemptFile=str(attempt))
        cloud = cloud_factory(target)
        need(all(record.get('key') == target['prefix'] + '/' + name and record.get('sha256') == PINS[name]['sha256']
             and record.get('bytes') == PINS[name]['bytes'] for name, record in index['objects'].items()), 'RECOVERY_INDEX_INVALID')
        record = cloud.head(index['objects'][PACKAGE]['key'], PINS[PACKAGE], proof)
        need(record == index['objects'][PACKAGE], 'CLOUD_OBJECT_CHANGED')
        with tempfile.TemporaryDirectory(prefix='restore-', dir=files.receipts) as temporary:
            recovered = Path(temporary) / PACKAGE
            cloud.download(record, recovered); recovered.chmod(0o600)
            files.read(recovered, size=PINS[PACKAGE]['bytes'], expected=PINS[PACKAGE])
            need(snapshot(files, expected) == before and local_files(files, package=False) == records,
                 'PROTECTION_CHANGED')
            checkpoint()
            source = os.open(recovered, os.O_RDONLY | os.O_NOFOLLOW)
            descriptor = os.open(PACKAGE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(source, 'rb') as input_stream, os.fdopen(descriptor, 'wb') as output:
                os.fchmod(output.fileno(), index['package']['mode'])
                os.fchown(output.fileno(), index['package']['uid'], index['package']['gid'])
                shutil.copyfileobj(input_stream, output, 1024**2); output.flush(); os.fsync(output.fileno())
            os.fsync(parent)
        restored = files.read(files.base / RELATIVE, size=PINS[PACKAGE]['bytes'], expected=PINS[PACKAGE])[0]
        need(snapshot(files, expected) == before and local_files(files, package=False) == records, 'PROTECTION_CHANGED_AFTER_RESTORE')
        result = {'kind': 'ID_RELEASE_ARTIFACT_RESULT_V1', 'version': 1, 'operation': 'restore', 'status': 'RESTORED',
            'planSha256': approved, 'relativePath': RELATIVE, 'packageBytes': PINS[PACKAGE]['bytes'],
            'restoredSha256': restored['sha256'], 'currentUnchanged': True, 'containersUnchanged': True,
            'metadataUnchanged': True, 'removed': False, 'fullRecoveryVerified': True}
        checkpoint(); receipt = files.immutable(stem + '.restore.json', result)
        return {**result, 'receiptFile': str(receipt)}
    finally:
        os.close(parent)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('plan', 'apply', 'restore'))
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--cloud-proof-json', required=True)
    parser.add_argument('--expected-cloud-proof-sha256', required=True)
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--approved-plan-sha256')
    args = parser.parse_args(argv)
    try:
        need(HEX64.fullmatch(args.expected_source_sha256) and
             Files().read(Path(__file__).absolute())[0]['sha256'] == args.expected_source_sha256, 'SOURCE_CHANGED')
        result = execute(args.operation, args.expected_current, args.cloud_proof_json,
                         args.expected_cloud_proof_sha256, args.approved_plan_sha256)
        need(len(canonical(result)) < 20000, 'RESULT_BOUND')
        print(canonical(result).decode()); return 0
    except Exception as error:
        code = str(error) if type(error) is Rejected and re.fullmatch(r'ARTIFACT_[A-Z_]+', str(error)) else 'ARTIFACT_IO_FAILED_CLOSED'
        failure = {'kind': 'ID_RELEASE_ARTIFACT_FAILURE_V1', 'version': 1,
                   'operation': args.operation, 'status': 'FAILED_CLOSED', 'code': code}
        if type(error) is Rejected and hasattr(error, 'receipt_file'):
            failure['receiptFile'] = error.receipt_file
        print(canonical(failure).decode()); return 1


if __name__ == '__main__':
    raise SystemExit(main())
