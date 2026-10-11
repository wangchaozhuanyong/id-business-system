"""Fixed-scope production diagnostics and approved cleanup, without secret output."""
import argparse
import base64
import fcntl
import gzip
import hashlib
import importlib.util
import json
import os
import time
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from email.utils import parsedate_to_datetime

BASE = Path('/opt/id-business-v2')
EXPECTED = '63e7c3b9fdb462517373b48f338626dafaf856ca'
PREVIOUS = 'a9530728a1b15d3dbb49fe7c38aa3c87e385467f'
REVIEWED_BASELINES = {
    EXPECTED: PREVIOUS,
    'cecc14b530fd32d595fe5ae14612fbde68ae9175': EXPECTED,
}
READ_ONLY_BASELINES = {
    'e7c9862d58599995954883f1c1f6038283afffab': {
        'release': '20261008T020705Z-e7c9862d5859',
        'manifestSha256': '52f2582e5edeb9e1c9af63c70fff4ca5a5bdad11c0fd7fb8f090fd1670b4c2eb',
        'previousRelease': '20261007T221905Z-04570d75c779',
        'previousCommit': '04570d75c779fd91a0933ef9416f6d62698b6b91',
        'previousManifestSha256': '0aacc82fc257bc2c4837a4b513223a01ec4f608fbacc0b009c1551b5ceb18b97',
    },
}
ARCHIVE_CACHE_CURRENT = 'e7c9862d58599995954883f1c1f6038283afffab'
ARCHIVE_CACHE_FOLDER = 'v2-production-20260907T085408Z-f35785f0b90ff750c55fb33ed06ae8d0f7af5feb'
ARCHIVE_CACHE_FILE = 'id-business-v2-' + ARCHIVE_CACHE_FOLDER + '.tar.gz'
ARCHIVE_CACHE_RELATIVE = 'artifacts/' + ARCHIVE_CACHE_FOLDER + '/' + ARCHIVE_CACHE_FILE
ARCHIVE_CACHE_SIZE = 1953925922
ARCHIVE_CACHE_POLICY = 'fixed-release-archive-cache-f35785-20261008'
APPROVED_SCOPE = 'audit-routine-20261002T110000Z'
CUTOFF = '2026-10-02 11:00:00'
MAX_APPROVED_COUNT = 19848
LEGACY_PLAN_SHA256 = 'fd03e4c0590d803b8f2f2722bf88f89bb0b1a900c74d9107b651192589b6a3a8'
RETENTION_MIGRATION = '20261002123500_routine_audit_retention_exception'
RETENTION_MIGRATION_SHA256 = 'e00ead9e611e506a877848f96390c00078f600ed8df628dedb99573ceb5b31b3'
ROUTINE_ACTIONS = (
    'id_business_v2.website_visit.collect',
    'id_business_v2.exchange_rate.schedule.claim',
    'id_business_v2.exchange_rate.collect.started',
    'id_business_v2.exchange_rate.collect.success',
    'id_business_v2.exchange_rate.fx_snapshot.collect',
)


def read(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        kind = ('DIRECTORY_USAGE' if args and args[0] == 'du' else
                'DATABASE_QUERY' if args[:2] == ('docker', 'exec') else
                'DOCKER_METADATA' if args and args[0] == 'docker' else 'COMMAND')
        raise RuntimeError('Diagnostic command timed out: ' + kind) from None
    if result.returncode:
        mysql_error = re.search(r'ERROR (\d+) \(([A-Z0-9]+)\)', result.stderr)
        if mysql_error:
            raise RuntimeError('Diagnostic MySQL error ' + mysql_error[1] + ' (' + mysql_error[2] + ')')
        raise RuntimeError('Diagnostic command failed; details suppressed')
    return result.stdout.strip()


def archived_images(path, deadline=None):
    """Read Docker save metadata and hash small config members without extracting files."""
    configs = {}
    manifest = None
    with tarfile.open(path, 'r|*') as archive:
        for member in archive:
            require(deadline is None or time.monotonic() < deadline,
                    'Archive metadata time budget exceeded')
            if not member.isfile() or member.size > 4 * 1024 * 1024:
                continue
            name = member.name.removeprefix('./')
            config_match = re.fullmatch(r'(?:blobs/sha256/)?([a-f0-9]{64})(?:\.json)?', name)
            if name != 'manifest.json' and not config_match:
                continue
            source = archive.extractfile(member)
            if source is None:
                continue
            payload = source.read(4 * 1024 * 1024 + 1)
            if config_match:
                configs[config_match[1]] = hashlib.sha256(payload).hexdigest() == config_match[1]
            else:
                manifest = json.loads(payload)
    if not isinstance(manifest, list):
        return []
    result = []
    for item in manifest:
        match = re.fullmatch(r'(?:blobs/sha256/)?([a-f0-9]{64})(?:\.json)?', item.get('Config', ''))
        if match and configs.get(match[1]):
            result.append({'imageId': 'sha256:' + match[1], 'configVerified': True,
                           'repoTags': item.get('RepoTags') or []})
    return result


def archive_inventory():
    root = BASE / 'artifacts'
    if not root.is_dir() or root.is_symlink():
        return []
    result = []
    deadline = time.monotonic() + 120
    metadata_budget_exhausted = False
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            continue
        require(len(result) < 500, 'Artifact inventory exceeds reviewed bound')
        stat = path.stat()
        item = {'path': str(path.relative_to(BASE)), 'bytes': stat.st_size,
                'mtimeNs': stat.st_mtime_ns}
        if path.name.endswith(('.tar', '.tar.gz', '.tgz')):
            if metadata_budget_exhausted:
                item['archiveMetadataStatus'] = 'TIME_BUDGET_EXCEEDED'
            else:
                try:
                    item['dockerImages'] = archived_images(path, deadline)
                except RuntimeError as error:
                    if str(error) != 'Archive metadata time budget exceeded':
                        raise
                    metadata_budget_exhausted = True
                    item['archiveMetadataStatus'] = 'TIME_BUDGET_EXCEEDED'
                except (tarfile.TarError, ValueError, OSError):
                    item['archiveMetadataStatus'] = 'UNAVAILABLE'
        result.append(item)
    return result


def diagnose(expected=EXPECTED):
    initial_baseline = readonly_baseline(expected)
    project = None
    for line in (initial_baseline[0] / '.env.aws.production').read_text().splitlines():
        if line.startswith('COMPOSE_PROJECT_NAME='):
            project = line.split('=', 1)[1].strip()
            break
    if not project or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', project):
        raise RuntimeError('Unexpected Compose project')
    containers = read('docker', 'ps', '-q', '--filter',
                      'label=com.docker.compose.project=' + project).splitlines()
    mysql = read('docker', 'ps', '-q', '--filter',
                 'label=com.docker.compose.project=' + project, '--filter',
                 'label=com.docker.compose.service=mysql').splitlines()
    if len(mysql) != 1:
        raise RuntimeError('Expected exactly one production MySQL container')
    image_ids = sorted(set(read('docker', 'image', 'ls', '--no-trunc', '--quiet').splitlines()))
    image_format = ('{"id":{{json .Id}},"repoTags":{{json .RepoTags}},'
                    '"sizeBytes":{{json .Size}},"architecture":{{json .Architecture}},'
                    '"created":{{json .Created}}}')
    image_inventory = [json.loads(read('docker', 'image', 'inspect', '--format',
                                      image_format, image_id)) for image_id in image_ids]
    container_image_ids = sorted({read('docker', 'inspect', '--format', '{{.Image}}', item)
                                  for item in read('docker', 'ps', '-a', '-q').splitlines()})
    actions = ','.join("'" + action + "'" for action in ROUTINE_ACTIONS)
    queries = [
        "SELECT JSON_OBJECT('kind','tables','table',TABLE_NAME,'estimatedRows',TABLE_ROWS,"
        "'dataBytes',DATA_LENGTH,'indexBytes',INDEX_LENGTH,'freeBytes',DATA_FREE) "
        "FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() "
        "ORDER BY DATA_LENGTH+INDEX_LENGTH DESC LIMIT 20",
        "SELECT JSON_OBJECT('kind','auditTotal','count',COUNT(*),'oldest',MIN(created_at),"
        "'newest',MAX(created_at)) FROM audit_logs",
        "SELECT JSON_OBJECT('kind','auditActions','module',module,'action',action,"
        "'count',COUNT(*),'oldest',MIN(created_at),'newest',MAX(created_at)) "
        "FROM audit_logs GROUP BY module,action ORDER BY COUNT(*) DESC",
        "SELECT JSON_OBJECT('kind','auditForeignKeys','table',TABLE_NAME,'column',COLUMN_NAME) "
        "FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() "
        "AND REFERENCED_TABLE_NAME='audit_logs'",
        "SELECT JSON_OBJECT('kind','routineCandidates','action',a.action,'count',COUNT(*)) "
        "FROM audit_logs a WHERE a.module='id_business_v2' AND a.action IN (" + actions + ") "
        "AND a.user_id IS NULL AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.after_data,'$.triggerType')),'') <> 'manual' AND a.created_at < '2026-10-02 11:00:00' AND NOT EXISTS (SELECT 1 FROM "
        "id_business_v2_governance_job_items g WHERE g.result_audit_log_id=a.id) "
        "GROUP BY a.action",
    ]
    sql = 'SET TRANSACTION READ ONLY; START TRANSACTION; ' + '; '.join(queries) + '; ROLLBACK;'
    mysql_output = read('docker', 'exec', mysql[0], 'sh', '-c',
                        'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql '
                        '--host=127.0.0.1 --user=root --database="$MYSQL_DATABASE" '
                        '--batch --skip-column-names --execute "$1"', 'sh', sql)
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable', 'MemFree', 'Cached', 'Buffers',
                   'SwapTotal', 'SwapFree', 'SReclaimable'):
            memory[key + 'Bytes'] = int(value.split()[0]) * 1024
    disk = shutil.disk_usage(BASE)
    result = {
        'mode': 'READ_ONLY', 'currentCommit': expected, 'memory': memory,
        'disk': {'totalBytes': disk.total, 'usedBytes': disk.used, 'freeBytes': disk.free},
        'allLocalImages': image_inventory, 'allContainerImageIds': container_image_ids,
        'containers': [json.loads(row) for row in read('docker', 'stats', '--no-stream',
                       '--format', '{{json .}}', *containers).splitlines()],
        'directories': read('du', '-x', '-B1', '--max-depth=1', '/var/lib/docker',
                            '/var/log', '/opt/id-business-v2').splitlines(),
        'database': [json.loads(row) for row in mysql_output.splitlines()],
        'candidateCutoffUtc': '2026-10-02T11:00:00Z',
        'archiveInventory': archive_inventory(),
    }
    receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
    for name in ('audit-cleanup-receipt.json', 'audit-before.json', 'audit-after.json'):
        path = receipt_dir / name
        if path.is_file() and not path.is_symlink():
            result.setdefault('maintenanceReceipts', {})[name] = json.loads(path.read_text())
    backups = sorted((BASE / 'backups/mysql').glob('id-business-v2-*.sql.gz'))
    result['latestLocalBackupName'] = backups[-1].name if backups else None
    require(readonly_baseline(expected) == initial_baseline,
            'Production baseline changed during diagnostics')
    return result


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def baseline(expected):
    require(expected in REVIEWED_BASELINES, 'Scope production baseline differs')
    require((BASE / 'current').resolve().parent == BASE / 'releases', 'Unexpected release path')
    manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous = Path(manifest['previousRelease']).resolve()
    require(previous.parent == BASE / 'releases', 'Unexpected rollback path')
    require(json.loads((previous / 'release-manifest.json').read_text())['commit'] == REVIEWED_BASELINES[expected],
            'Rollback baseline changed')
    return (BASE / 'current').resolve()


def readonly_baseline(expected):
    """Pin the diagnostic release chain without widening cleanup authorization."""
    reviewed = READ_ONLY_BASELINES.get(expected)
    if reviewed is None:
        directory = baseline(expected)
    else:
        directory = (BASE / 'current').resolve()
        require(directory == BASE / 'releases' / reviewed['release'], 'Unexpected release path')
    manifest_bytes = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous = Path(manifest['previousRelease']).resolve()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if reviewed is not None:
        require(Path(manifest['previousRelease']) == BASE / 'releases' / reviewed['previousRelease']
                and previous == BASE / 'releases' / reviewed['previousRelease'],
                'Unexpected rollback path')
        require(manifest.get('previousCommit') == reviewed['previousCommit'], 'Rollback baseline changed')
        require(manifest_sha == reviewed['manifestSha256'], 'Production manifest bytes changed')
    else:
        require(previous.parent == BASE / 'releases', 'Unexpected rollback path')
    previous_bytes = (previous / 'release-manifest.json').read_bytes()
    previous_manifest = json.loads(previous_bytes)
    previous_sha = hashlib.sha256(previous_bytes).hexdigest()
    require(previous_manifest['commit'] == (reviewed['previousCommit'] if reviewed
                                           else REVIEWED_BASELINES[expected]),
            'Rollback baseline changed')
    if reviewed is not None:
        require(previous_sha == reviewed['previousManifestSha256'], 'Production manifest bytes changed')
    require((BASE / 'current').resolve() == directory, 'Production release pointer changed')
    return directory, manifest_sha, previous, previous_sha


def archive_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=True).encode()).hexdigest()


def archive_identity(info):
    return dict(zip(('dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'),
        (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
         info.st_size, info.st_mtime_ns, info.st_ctime_ns)))


def archive_file(path, deadline, *, limit, exact_size=None, keep_raw=False):
    require(path.resolve() == path and not path.is_symlink(), 'Archive cache path changed')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 0 < before.st_size <= limit
                and (exact_size is None or before.st_size == exact_size), 'Archive cache file identity changed')
        digest, chunks, length = hashlib.sha256(), [], 0
        for block in iter(lambda: source.read(1024 * 1024), b''):
            require(time.monotonic() < deadline and length + len(block) <= limit,
                    'Archive cache read budget exceeded')
            digest.update(block); length += len(block)
            if keep_raw:
                chunks.append(block)
        require(length == before.st_size and archive_identity(before)
                == archive_identity(os.fstat(source.fileno())) == archive_identity(path.lstat()),
                'Archive cache file changed during read')
    return {'identity': archive_identity(before), 'sha256': digest.hexdigest()}, b''.join(chunks)


def archive_command(arguments, deadline, *, phase, timeout=45):
    remaining = deadline - time.monotonic()
    require(remaining > 0, 'Archive cache operation budget exceeded')
    environment = os.environ.copy()
    environment.update(AWS_MAX_ATTEMPTS='1', AWS_RETRY_MODE='standard')
    try:
        result = subprocess.run(arguments, capture_output=True, text=True,
                                env=environment, timeout=min(timeout, remaining))
    except subprocess.TimeoutExpired:
        raise RuntimeError('Archive cache command timed out: ' + phase) from None
    require(result.returncode == 0 and len(result.stdout.encode()) <= 256 * 1024,
            'Archive cache command failed: ' + phase)
    return result.stdout.strip()


def archive_unused(path, deadline):
    ids = archive_command(['docker', 'ps', '-a', '-q'], deadline, phase='CONTAINERS').splitlines()
    require(len(ids) <= 128 and all(re.fullmatch(r'[a-f0-9]{12,64}', value) for value in ids),
            'Archive cache container inventory unavailable')
    if ids:
        mounts = archive_command(['docker', 'inspect', '--format', '{{json .Mounts}}', *ids],
                                 deadline, phase='MOUNTS').splitlines()
        require(len(mounts) == len(ids), 'Archive cache mount inventory unavailable')
        for line in mounts:
            for mount in json.loads(line):
                require(isinstance(mount, dict), 'Archive cache mount inventory unavailable')
                source = mount.get('Source')
                if mount.get('Type') == 'tmpfs':
                    destination = mount.get('Destination')
                    require(source in (None, '') and isinstance(destination, str)
                            and destination.startswith('/'), 'Archive cache mount inventory unavailable')
                    continue
                require(mount.get('Type') in ('bind', 'volume')
                        and isinstance(source, str) and source.startswith('/'),
                        'Archive cache mount inventory unavailable')
                require(not path.is_relative_to(Path(source).resolve()), 'Archive cache is mounted by a container')
    require(archive_command(['docker', 'ps', '-a', '-q'], deadline, phase='CONTAINERS').splitlines() == ids,
            'Archive cache container inventory changed')
    identity, examined = path.stat(), 0
    for process in Path('/proc').iterdir():
        if not process.name.isdigit() or process.name == str(os.getpid()):
            continue
        try:
            for descriptor in (process / 'fd').iterdir():
                examined += 1
                require(examined <= 65536 and time.monotonic() < deadline,
                        'Archive cache open-file inventory budget exceeded')
                try:
                    actual = descriptor.stat()
                except (FileNotFoundError, ProcessLookupError):
                    continue
                require((actual.st_dev, actual.st_ino) != (identity.st_dev, identity.st_ino),
                        'Archive cache is open by another process')
        except (FileNotFoundError, ProcessLookupError):
            continue


def archive_configuration():
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        return helper('cleanup-verified-backups').configuration()
    finally:
        sys.dont_write_bytecode = previous


def archive_sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def archive_plan(expected, deadline):
    require(expected == ARCHIVE_CACHE_CURRENT, 'Archive cache production baseline differs')
    _, current_sha, _, previous_sha = readonly_baseline(expected)
    path = BASE / ARCHIVE_CACHE_RELATIVE
    archive, _ = archive_file(path, deadline, limit=ARCHIVE_CACHE_SIZE, exact_size=ARCHIVE_CACHE_SIZE)
    neighbors, payloads = {}, {}
    for name in ('ci-release-manifest.json', 'SHA256SUMS'):
        info, payloads[name] = archive_file(path.parent / name, deadline, limit=128 * 1024, keep_raw=True)
        neighbors[name] = info['sha256']
    manifest = json.loads(payloads['ci-release-manifest.json'])
    sums = {}
    for line in payloads['SHA256SUMS'].decode().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        require(match is not None and match[2] not in sums, 'Archive cache checksum metadata changed')
        sums[match[2]] = match[1]
    require(manifest.get('commit') == 'f35785f0b90ff750c55fb33ed06ae8d0f7af5feb'
            and manifest.get('releaseTag') == 'v2-production-20260907T085408Z'
            and manifest.get('artifact', {}).get('file') == ARCHIVE_CACHE_FILE
            and manifest['artifact'].get('sha256') == archive['sha256']
            and sums == {ARCHIVE_CACHE_FILE: archive['sha256'],
                         'release-manifest.json': neighbors['ci-release-manifest.json']},
            'Archive cache checksum metadata changed')
    config = archive_configuration()
    bucket, prefix, region = config
    key = prefix + '/release-artifact-cache/' + ARCHIVE_CACHE_FOLDER + '/' + ARCHIVE_CACHE_FILE
    plan = {'version': 1, 'policy': ARCHIVE_CACHE_POLICY, 'currentCommit': expected,
        'currentManifestSha256': current_sha,
        'previousCommit': READ_ONLY_BASELINES[expected]['previousCommit'],
        'previousManifestSha256': previous_sha,
        'archive': {'relativePath': ARCHIVE_CACHE_RELATIVE, **archive}, 'neighborSha256': neighbors,
        's3TargetSha256': archive_digest({'bucket': bucket, 'key': key, 'region': region})}
    archive_unused(path, deadline)
    require(readonly_baseline(expected)[1::2] == (current_sha, previous_sha),
            'Archive cache baseline changed during plan')
    return plan, (bucket, key, region)


def release_archive_cache(expected, plan_sha256=None, *, apply=False):
    require((not apply and plan_sha256 is None) or (apply and isinstance(plan_sha256, str)
            and re.fullmatch(r'[a-f0-9]{64}', plan_sha256)), 'Exact archive cache plan approval required')
    deadline = time.monotonic() + 540
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan, target = archive_plan(expected, deadline)
        digest = archive_digest(plan)
        result = {'mode': 'APPLIED' if apply else 'PLAN_ONLY', 'status': 'COMPLETE',
            'currentCommit': expected, 'planSha256': digest, 'plan': plan,
            'freeBytesBefore': shutil.disk_usage(BASE).free, 'freeBytesAfter': shutil.disk_usage(BASE).free,
            'existingBackupStorage': True, 'retentionPolicyExisting': True, 'remoteExpiration': None}
        if not apply:
            return result
        require(digest == plan_sha256, 'Archive cache reviewed plan changed')
        bucket, key, region = target
        path = BASE / ARCHIVE_CACHE_RELATIVE
        checksum = base64.b64encode(bytes.fromhex(plan['archive']['sha256'])).decode()
        arguments = ['aws', 's3api', '--region', region]
        try:
            archive_command([*arguments, 'put-object', '--bucket', bucket, '--key', key,
                '--body', str(path), '--server-side-encryption', 'AES256', '--checksum-algorithm', 'SHA256',
                '--checksum-sha256', checksum, '--if-none-match', '*', '--output', 'json'],
                deadline, phase='UPLOAD', timeout=300)
        except RuntimeError:
            # A prior upload can have completed before its caller timed out.
            # Never overwrite it; prove recovery independently before removal.
            pass
        remote = json.loads(archive_command([*arguments, 'head-object', '--bucket', bucket, '--key', key,
            '--checksum-mode', 'ENABLED', '--output', 'json'], deadline, phase='HEAD'))
        require(type(remote.get('ContentLength')) is int and remote['ContentLength'] == ARCHIVE_CACHE_SIZE
                and remote.get('ChecksumSHA256') == checksum and remote.get('ServerSideEncryption') == 'AES256'
                and remote.get('ChecksumType', 'FULL_OBJECT') == 'FULL_OBJECT',
                'Archive cache cloud recovery identity differs')
        directory = BASE / 'maintenance/release-artifact-cache'
        require(directory.resolve() == directory, 'Archive cache receipt path changed')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            for index, start in enumerate((0, max(0, ARCHIVE_CACHE_SIZE - 65536))):
                end = min(start + 65536, ARCHIVE_CACHE_SIZE) - 1
                local = Path(temporary) / ('range-' + str(index))
                archive_command([*arguments, 'get-object', '--bucket', bucket, '--key', key,
                    '--range', 'bytes=' + str(start) + '-' + str(end), str(local), '--output', 'json'],
                    deadline, phase='RANGE')
                _, actual = archive_file(local, deadline, limit=65536, exact_size=end-start+1, keep_raw=True)
                with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
                    source.seek(start)
                    require(actual == source.read(end-start+1), 'Archive cache cloud range differs')
        fresh, fresh_target = archive_plan(expected, deadline)
        require(fresh == plan and fresh_target == target, 'Archive cache reviewed plan changed')
        expiration = remote.get('Expiration')
        if isinstance(expiration, str):
            match = re.match(r'^expiry-date="([^"\n]{1,64})",', expiration)
            if match:
                result['remoteExpiration'] = parsedate_to_datetime(match[1]).isoformat()
        result.update(cloudRecoveryVerified=True, removedRelativePath=ARCHIVE_CACHE_RELATIVE)
        receipt = directory / (str(time.time_ns()) + '.json')
        with receipt.open('x') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump({**result, 'status': 'VERIFIED_NOT_REMOVED'}, stream)
            stream.flush(); os.fsync(stream.fileno())
        archive_sync_directory(directory)
        require(archive_identity(path.lstat()) == plan['archive']['identity'], 'Archive cache file identity changed')
        path.unlink()
        archive_sync_directory(path.parent)
        result['freeBytesAfter'] = shutil.disk_usage(BASE).free
        with os.fdopen(os.open(receipt, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW), 'w') as stream:
            json.dump(result, stream)
            stream.flush(); os.fsync(stream.fileno())
        archive_sync_directory(directory)
        return result


def project_mysql():
    values = {}
    with (BASE / 'current/.env.aws.production').open() as source:
        for line in source:
            if line.startswith('COMPOSE_PROJECT_NAME='):
                values['project'] = line.rstrip('\n').split('=', 1)[1]
    project = values.get('project', '')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', project), 'Unexpected project')
    ids = read('docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
               '--filter', 'label=com.docker.compose.service=mysql').splitlines()
    require(len(ids) == 1, 'Expected one running project MySQL')
    return ids[0]


def mysql(container, query, read_only=True):
    if read_only:
        query = 'SET TRANSACTION READ ONLY; START TRANSACTION; ' + query + '; ROLLBACK;'
    return read('docker', 'exec', container, 'sh', '-c',
                'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --host=127.0.0.1 '
                '--user=root --database="$MYSQL_DATABASE" --default-character-set=utf8mb4 '
                '--batch --skip-column-names --execute "$1"', 'sh', query)


def references(container):
    query = "SELECT JSON_OBJECT('table',TABLE_NAME,'column',COLUMN_NAME,'sameSchema'," \
            "TABLE_SCHEMA=DATABASE()) FROM information_schema.KEY_COLUMN_USAGE " \
            "WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='audit_logs' ORDER BY TABLE_NAME,COLUMN_NAME"
    return [json.loads(line) for line in mysql(container, query).splitlines()]


def audit_predicate(refs):
    actions = ','.join("'" + action + "'" for action in ROUTINE_ACTIONS)
    predicate = "a.module='id_business_v2' AND a.action IN (" + actions + ") " \
                "AND a.user_id IS NULL AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.after_data,'$.triggerType')),'') <> 'manual' AND a.created_at < '" + CUTOFF + "'"
    for ref in refs:
        require(ref.get('sameSchema') == 1, 'Cross-schema audit reference must be reviewed')
        require(all(re.fullmatch(r'[A-Za-z0-9_]+', ref[key]) for key in ('table', 'column')),
                'Unexpected audit reference identifier')
        predicate += " AND NOT EXISTS (SELECT 1 FROM `" + ref['table'] + "` r WHERE r.`" \
                     + ref['column'] + "`=a.id)"
    return predicate


def preview_audit(container):
    refs = references(container)
    ids = mysql(container, 'SELECT a.id FROM audit_logs a WHERE ' + audit_predicate(refs)
                + ' ORDER BY a.id').splitlines()
    require(all(re.fullmatch(r'[a-f0-9-]{36}', value) for value in ids), 'Unexpected audit ID')
    require(len(ids) <= MAX_APPROVED_COUNT, 'Candidate count exceeds approved scope')
    total = int(mysql(container, 'SELECT COUNT(*) FROM audit_logs'))
    return {'count': len(ids), 'idsSha256': hashlib.sha256(','.join(ids).encode()).hexdigest(),
            'totalBefore': total, 'references': refs, 'cutoffUtc': '2026-10-02T11:00:00Z'}


def helper(name):
    path = BASE / 'current/scripts/production-release' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_backup(directory):
    backup_dir = BASE / 'backups/mysql'
    existing = {path.name for path in backup_dir.glob('id-business-v2-*.sql.gz')}
    started = time.time()
    read('bash', str(directory / 'scripts/backup-aws-mysql.sh'))
    copies = [path for path in backup_dir.glob('id-business-v2-*.sql.gz')
              if path.name not in existing and path.stat().st_mtime >= started - 2]
    require(len(copies) == 1, 'Expected exactly one fresh backup')
    module = helper('cleanup-verified-backups')
    identity = module.verified(copies[0], module.configuration())
    return {'name': copies[0].name, 'bytes': identity[1], 's3Verified': True}


def deletion_sql(preview, backup):
    count, digest = preview['count'], preview['idsSha256']
    require(isinstance(count, int) and 0 < count <= MAX_APPROVED_COUNT, 'Invalid approved count')
    require(re.fullmatch(r'[a-f0-9]{64}', digest), 'Invalid candidate digest')
    require(re.fullmatch(r'id-business-v2-\d{8}T\d{6}Z\.sql\.gz', backup['name'])
            and backup.get('s3Verified') is True, 'Verified backup required')
    where = audit_predicate(preview['references'])
    # Recompute and compare the entire set inside the same Serializable transaction.
    # A changed candidate set causes zero deletions and no false success audit.
    return (
        'SET SESSION group_concat_max_len=2000000; '
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; START TRANSACTION; '
        "SELECT COUNT(*),SHA2(GROUP_CONCAT(a.id ORDER BY a.id SEPARATOR ','),256) "
        'INTO @candidate_count,@candidate_hash FROM audit_logs a WHERE ' + where + '; '
        "SET @idv2_routine_audit_cleanup_scope='" + APPROVED_SCOPE + "'; "
        'DELETE a FROM audit_logs a WHERE ' + where
        + f" AND @candidate_count={count} AND @candidate_hash='{digest}'; "
        'SET @deleted=ROW_COUNT(); '
        'INSERT INTO audit_logs (id,module,action,object_type,before_data,after_data,remark,created_at) '
        "SELECT UUID(),'maintenance','maintenance.audit_log.cleanup','audit_logs',"
        f"JSON_OBJECT('count',{count},'idsSha256','{digest}'),"
        f"JSON_OBJECT('deleted',@deleted,'cutoffUtc','2026-10-02T11:00:00Z','backup','{backup['name']}'),"
        "'用户已批准清理自动采集审计，其他业务及恢复记录保留',UTC_TIMESTAMP(6) "
        f'WHERE @deleted={count}; SET @idv2_routine_audit_cleanup_scope=NULL; COMMIT; '
        "SELECT JSON_OBJECT('deleted',@deleted,'candidateCount',@candidate_count,"
        "'candidateHash',@candidate_hash,'totalAfter',(SELECT COUNT(*) FROM audit_logs));"
    )


def retention_migration(sql):
    require(isinstance(sql, str) and hashlib.sha256(sql.encode()).hexdigest() == RETENTION_MIGRATION_SHA256,
            'Retention migration differs from approved digest')
    return sql


def prepare_retention(directory, container, sql, deployment):
    sql = retention_migration(sql)
    root = BASE / 'maintenance/storage-cleanup-20261002/prisma-mysql'
    source = directory / 'apps/api/prisma-mysql'
    if not root.exists():
        shutil.copytree(source, root)
    require(root.is_dir() and not root.is_symlink(), 'Unexpected retention migration directory')
    original = {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in source.rglob('*') if path.is_file()}
    copied = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in root.rglob('*') if path.is_file()
              and str(path.relative_to(root)) != 'migrations/' + RETENTION_MIGRATION + '/migration.sql'}
    require(original == copied, 'Existing Prisma migration inputs changed')
    target = root / 'migrations' / RETENTION_MIGRATION / 'migration.sql'
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if target.exists():
        require(target.read_text() == sql, 'Retention migration candidate changed')
    else:
        target.write_text(sql)
        target.chmod(0o644)
    deployment.compose(directory, 'run', '--rm', '--no-deps', '-v',
                       str(root) + ':/app/apps/api/prisma-mysql:ro', 'migrate', timeout=240)
    rows = mysql(container, "SELECT JSON_OBJECT('name',migration_name,'checksum',checksum,"
                 "'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) "
                 "FROM _prisma_migrations WHERE migration_name='" + RETENTION_MIGRATION + "'").splitlines()
    require(len(rows) == 1, 'Expected one retention migration record')
    receipt = json.loads(rows[0])
    require(receipt['checksum'] == RETENTION_MIGRATION_SHA256 and receipt['finished'] == 1
            and receipt['rolledBack'] == 0, 'Retention migration completion not verified')
    return receipt


def cleanup_audit(expected, approved_scope, migration_sql=None):
    require(approved_scope == APPROVED_SCOPE, 'Explicit fixed-scope approval required')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('STORAGE_STAGE baseline', flush=True)
        directory = baseline(expected)
        container = project_mysql()
        print('STORAGE_STAGE audit_preview', flush=True)
        preview = preview_audit(container)
        if preview['count'] == 0:
            return {'mode': 'ALREADY_CLEAN', 'deleted': 0, 'preview': preview}
        receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
        receipt_dir.mkdir(parents=True, exist_ok=True)
        receipt_dir.chmod(0o700)
        deployment = helper('remote-deploy')
        print('STORAGE_STAGE financial_before', flush=True)
        before = deployment.audit(directory, receipt_dir / 'audit-before.json')
        print('STORAGE_STAGE verified_backup', flush=True)
        backup = fresh_backup(directory)
        print('STORAGE_STAGE approved_retention_migration', flush=True)
        migration = prepare_retention(directory, container, migration_sql, deployment)
        baseline(expected)
        refreshed = preview_audit(container)
        require(all(refreshed[key] == preview[key] for key in ('count', 'idsSha256', 'references')),
                'Audit candidate set changed before deletion')
        print('STORAGE_STAGE guarded_delete', flush=True)
        receipt = json.loads(mysql(container, deletion_sql(preview, backup), read_only=False))
        receipt.update({'mode': 'APPLIED', 'preview': preview, 'backup': backup,
                        'dataAuditBefore': before, 'retentionMigration': migration})
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        (receipt_dir / 'audit-cleanup-receipt.json').chmod(0o600)
        require(receipt['deleted'] == preview['count'], 'Candidate guard prevented deletion')
        print('STORAGE_STAGE financial_after', flush=True)
        receipt['dataAuditAfter'] = deployment.audit(directory, receipt_dir / 'audit-after.json')
        require(preview_audit(container)['count'] == 0, 'Approved audit candidates remain')
        baseline(expected)
        (receipt_dir / 'audit-cleanup-receipt.json').write_text(json.dumps(receipt, indent=2))
        return receipt


def legacy_cache_plan(plan_json):
    plan = json.loads(plan_json)
    digest = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(digest == LEGACY_PLAN_SHA256, 'Legacy cache plan differs from reviewed digest')
    require(len(plan['items']) == 42 and sum(len(item['references']) for item in plan['items']) == 50,
            'Legacy cache reviewed count changed')
    sources = {source['commit'] for source in plan['sources'] if source['retainedIn'] == 'origin/main'}
    for item in plan['items']:
        require(item['sourceCommit'] in sources and any(
            ref.endswith(':' + item['sourceCommit']) for ref in item['references']),
            'Retained source recovery proof missing')
        require(all(re.fullmatch(r'id-business-v2-(?:admin|api|migrate|auto-recharge|media-resolver):[a-f0-9]{40}', ref)
                    for ref in item['references']), 'Reference is outside legacy project cache')
    return plan


def container_images():
    return {read('docker', 'inspect', '--format', '{{.Image}}', item)
            for item in read('docker', 'ps', '-a', '-q').splitlines()}


def legacy_image_identity(item):
    metadata = json.loads(read('docker', 'image', 'inspect', '--format',
        '{"id":{{json .Id}},"repoTags":{{json .RepoTags}}}', item['imageId']))
    require(metadata['id'] == item['imageId'] and sorted(metadata['repoTags'] or []) == item['references'],
            'Legacy image identity or references changed')


def cleanup_legacy_cache(expected, plan_json, apply=False):
    plan = legacy_cache_plan(plan_json)
    require(expected == plan['expectedCurrent'], 'Legacy cache production baseline differs')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        baseline(expected)
        manifest = json.loads((BASE / 'current/release-manifest.json').read_text())
        previous = json.loads((Path(manifest['previousRelease']) / 'release-manifest.json').read_text())
        require(previous['commit'] == plan['expectedPrevious'], 'Legacy cache rollback changed')
        protected = container_images()
        for release in (manifest, previous):
            protected.update(image['digest'] for image in release.get('images', {}).values())
            protected.update(release.get('rollback', {}).get('images', {}).values())
        for item in plan['items']:
            require(item['imageId'] not in protected, 'Legacy image is used by a container or protected release')
            legacy_image_identity(item)
        before = shutil.disk_usage(BASE).free
        removed = []
        receipt = {'mode': 'APPLIED' if apply else 'PLAN_ONLY', 'removed': removed,
                   'approvedImageCount': 42, 'approvedReferenceCount': 50,
                   'recovery': plan['recovery'], 'planSha256': LEGACY_PLAN_SHA256,
                   'freeBytesBefore': before}
        receipt_dir = BASE / 'maintenance/storage-cleanup-20261002'
        if apply:
            receipt_dir.mkdir(parents=True, exist_ok=True)
            receipt_dir.chmod(0o700)
            for item in plan['items']:
                baseline(expected)
                require(item['imageId'] not in container_images(), 'Legacy image became used by a container')
                legacy_image_identity(item)
                for reference in item['references']:
                    require(item['imageId'] not in container_images(), 'Legacy image became used by a container')
                    read('docker', 'image', 'rm', '--no-prune', reference)
                    removed.append(reference)
                    path = receipt_dir / 'legacy-cache-cleanup-receipt.json'
                    path.write_text(json.dumps(receipt, indent=2))
                    path.chmod(0o600)
        baseline(expected)
        receipt['freeBytesAfter'] = shutil.disk_usage(BASE).free
        if apply:
            path.write_text(json.dumps(receipt, indent=2))
        return receipt



# Independent readonly evidence for the permanent workspace bootstrap. Cleanup
# baselines and the ordinary diagnose implementation above remain unchanged.
STORAGE_BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
STORAGE_CURRENT_SHA = '317fbcd0e307789539009a2798b7017ff5b977041cc1b8ab617f5f3f2dc5efa3'
STORAGE_SERVICES_SHA = '4100d5c9098b9fee8b42bfde9e0aa3447068d3c76f715479c3eab49f2394d9b4'
STORAGE_COMPOSE_SHA = '953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c'
STORAGE_PREFIX = 'STORAGE_READONLY_SAFE '
STORAGE_SOURCES = ('.github/workflows/production-release.yml',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/online-recharge-source-permission-repair-transport.py',
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/api-admin-scope.py', 'scripts/production-release/remote-deploy.py')
STORAGE_DIRECTORIES = (('PROJECT_ROOT', '/opt/id-business-v2'),
    ('ARTIFACTS', '/opt/id-business-v2/artifacts'), ('BACKUPS', '/opt/id-business-v2/backups'),
    ('RELEASES', '/opt/id-business-v2/releases'), ('STAGING', '/opt/id-business-v2/.staging'),
    ('LOGS', '/opt/id-business-v2/logs'), ('DOCKER', '/var/lib/docker'), ('VAR_LOG', '/var/log'))
STORAGE_CACHE_ROLES = ('IMAGES', 'CONTAINERS', 'VOLUMES', 'BUILD_CACHE')
STORAGE_CODES = frozenset(('OK', 'INPUT_INVALID', 'ROOT_REQUIRED', 'BASELINE_INVALID',
    'CURRENT_CHANGED', 'SOURCE_CHANGED', 'SERVICES_CHANGED', 'SNAPSHOT_INVALID',
    'DISK_INVALID', 'DEADLINE_EXCEEDED', 'IO_FAILURE'))
STORAGE_BINDING_FIELDS = {'producer', 'expectedCurrent', 'sourcePins',
    'capturedProgramBytes', 'capturedProgramSha256'}
STORAGE_RESULT_FIELDS = {'kind', 'version', 'operation', 'producer', 'sourceBinding',
    'status', 'code', 'baseline', 'disk', 'directories', 'cache', 'guards',
    'authority', 'productionEligible', 'rawOutputSuppressed'}
STORAGE_ARTIFACT_FIELDS = {'kind', 'operation', 'producer', 'expectedCurrent',
    'commandId', 'status', 'code', 'result'}


class StorageRejected(RuntimeError):
    pass


def storage_need(ok, code='INPUT_INVALID'):
    if not ok: raise StorageRejected(code)


def storage_sha(raw): return hashlib.sha256(raw).hexdigest()


def storage_canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def storage_closed(raw):
    storage_need(type(raw) in (bytes, str) and 0 < len(raw if type(raw) is bytes else raw.encode()) < 24000)
    def unique(rows):
        value = {}
        for key, item in rows:
            storage_need(key not in value); value[key] = item
        return value
    def invalid(unused): storage_need(False)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def storage_producer(value):
    storage_need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    storage_need(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}', value[k]) for k in ('commit', 'sourceTree')))
    storage_need(all(type(value[k]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    return value


def storage_binding(value):
    storage_need(type(value) is dict and set(value) == STORAGE_BINDING_FIELDS)
    storage_producer(value['producer'])
    storage_need(value['expectedCurrent'] == STORAGE_BASELINE and type(value['sourcePins']) is dict
        and set(value['sourcePins']) == set(STORAGE_SOURCES))
    for row in value['sourcePins'].values():
        storage_need(type(row) is dict and set(row) == {'bytes', 'sha256'}
            and type(row['bytes']) is int and 0 < row['bytes'] < 2*1024**2
            and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']))
    storage_need(type(value['capturedProgramBytes']) is int and 0 < value['capturedProgramBytes'] <= 131072
        and type(value['capturedProgramSha256']) is str and re.fullmatch('[a-f0-9]{64}', value['capturedProgramSha256']))
    return value


def storage_identity(row, leaf=False):
    result = (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid, row.st_nlink)
    return result + ((row.st_size, row.st_mtime_ns, row.st_ctime_ns) if leaf else ())


def storage_root(): return os.getuid() == 0 and os.geteuid() == 0


class StorageGuard:
    def __init__(self, deadline):
        self.deadline, self.fds, self.nodes = deadline, [], []
        self.link = None; self.current = None; self.manifests = None
    def remaining(self):
        storage_need(time.monotonic() < self.deadline, 'DEADLINE_EXCEEDED')
    def child(self, parent, name, directory=True):
        self.remaining()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
            | (os.O_DIRECTORY if directory else os.O_NONBLOCK), dir_fd=parent)
        self.fds.append(fd); info = os.fstat(fd)
        storage_need((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022
            and (directory or info.st_nlink == 1 and 0 < info.st_size <= 2*1024**2), 'BASELINE_INVALID')
        visible = os.stat(name, dir_fd=parent, follow_symlinks=False)
        identity = storage_identity(info, not directory)
        storage_need(identity == storage_identity(visible, not directory), 'CURRENT_CHANGED')
        self.nodes.append((parent, name, fd, identity, not directory))
        return fd
    def bytes(self, fd, expected=None):
        self.remaining(); os.lseek(fd, 0, os.SEEK_SET); raw = b''
        while len(raw) <= 2*1024**2:
            part = os.read(fd, min(65536, 2*1024**2 + 1 - len(raw)))
            if not part: break
            raw += part; self.remaining()
        storage_need(expected is None or storage_sha(raw) == expected, 'BASELINE_INVALID')
        return raw
    def current_link(self):
        info = os.stat('current', dir_fd=self.base, follow_symlinks=False)
        storage_need(stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and 0 < info.st_size <= 512, 'BASELINE_INVALID')
        value = os.readlink('current', dir_fd=self.base)
        names = [value[len(prefix):] for prefix in (str(BASE)+'/releases/', 'releases/') if value.startswith(prefix)]
        storage_need(len(names) == 1 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-'+STORAGE_BASELINE[:12], names[0]), 'BASELINE_INVALID')
        identity = storage_identity(info, True)
        storage_need(identity == storage_identity(os.stat('current', dir_fd=self.base, follow_symlinks=False), True), 'CURRENT_CHANGED')
        return names[0], (value, identity)
    def open(self):
        root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.fds.append(root); self.root = root; self.root_identity = storage_identity(os.fstat(root))
        parent = root
        for part in BASE.parts[1:]: parent = self.child(parent, part)
        self.base = parent; name, self.link = self.current_link(); self.current = BASE/'releases'/name
        releases = self.child(parent, 'releases'); current = self.child(releases, name)
        self.current_manifest = self.child(current, 'release-manifest.json', False)
        manifest = json.loads(self.bytes(self.current_manifest, STORAGE_CURRENT_SHA))
        previous_commit, previous_path = manifest.get('previousCommit'), manifest.get('previousRelease')
        storage_need(manifest.get('commit') == STORAGE_BASELINE
            and type(previous_commit) is str and re.fullmatch('[a-f0-9]{40}', previous_commit)
            and type(previous_path) is str, 'BASELINE_INVALID')
        previous_path = Path(previous_path)
        storage_need(previous_path.parent == BASE/'releases'
            and str(previous_path) == manifest['previousRelease']
            and re.fullmatch('[0-9]{8}T[0-9]{6}Z-'+previous_commit[:12], previous_path.name), 'BASELINE_INVALID')
        previous = self.child(releases, previous_path.name)
        self.previous_manifest = self.child(previous, 'release-manifest.json', False)
        previous_raw = self.bytes(self.previous_manifest)
        previous_manifest = json.loads(previous_raw)
        storage_need(previous_manifest.get('commit') == previous_commit, 'BASELINE_INVALID')
        self.previous_sha = storage_sha(previous_raw)
        self.compose = self.child(current, 'docker-compose.aws-mysql.yml', False)
        self.manifests = [manifest, previous_manifest]; self.verify()
    def verify(self):
        self.remaining()
        storage_need(storage_identity(os.fstat(self.root)) == self.root_identity
            and self.current_link() == (self.current.name, self.link), 'CURRENT_CHANGED')
        for parent, name, fd, identity, leaf in self.nodes:
            storage_need(storage_identity(os.fstat(fd), leaf) == identity
                == storage_identity(os.stat(name, dir_fd=parent, follow_symlinks=False), leaf), 'CURRENT_CHANGED')
        self.bytes(self.current_manifest, STORAGE_CURRENT_SHA)
        self.bytes(self.previous_manifest, self.previous_sha)
        self.bytes(self.compose, STORAGE_COMPOSE_SHA)
    def close(self):
        for fd in reversed(self.fds): os.close(fd)
        self.fds = []


def storage_directory_usage(role, path, deadline):
    row = {'role': role, 'status': 'UNAVAILABLE', 'allocatedBytes': None}
    fd = None
    try:
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode): return row
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        storage_need(storage_identity(os.fstat(fd)) == storage_identity(info), 'CURRENT_CHANGED')
        remaining = deadline-time.monotonic(); storage_need(remaining > 0, 'DEADLINE_EXCEEDED')
        public = '/proc/self/fd/'+str(fd)
        result = subprocess.run(['/usr/bin/du', '-x', '-s', '-B1', '-H', '--', public],
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, pass_fds=(fd,),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=min(30, remaining))
        if result.returncode or len(result.stdout) > 128: return row
        match = re.fullmatch(rb'([0-9]{1,20})\s+'+re.escape(public.encode())+rb'\n?', result.stdout)
        if not match: return row
        storage_need(storage_identity(os.fstat(fd)) == storage_identity(info)
            == storage_identity(os.stat(path, follow_symlinks=False)), 'CURRENT_CHANGED')
        number = int(match[1]); storage_need(number <= 2**63-1, 'INPUT_INVALID')
        row.update(status='MEASURED', allocatedBytes=number)
    except FileNotFoundError: row['status'] = 'MISSING'
    except (OSError, subprocess.TimeoutExpired): pass
    finally:
        if fd is not None: os.close(fd)
    return row


def storage_cache(driver):
    # Formatted aggregate sizes are estimates; no image/tag/environment values
    # or arbitrary labels are included in this diagnostic or authorize removal.
    from decimal import Decimal
    roles = {'Images': 'IMAGES', 'Containers': 'CONTAINERS', 'Local Volumes': 'VOLUMES', 'Build Cache': 'BUILD_CACHE'}
    result = {'status': 'UNAVAILABLE', 'rows': []}
    try:
        lines = driver.native('system', 'df', '--format', '{{json .}}').splitlines()
        storage_need(len(lines) == 4)
        rows = {}
        def size(value):
            storage_need(type(value) is str)
            match = re.fullmatch(r'([0-9]+(?:\.[0-9]{1,3})?)(B|kB|KB|MB|GB|TB)(?: \([0-9]{1,3}%\))?', value)
            storage_need(match is not None)
            number = int(Decimal(match[1]) * {'B':1,'kB':1000,'KB':1000,'MB':1000**2,'GB':1000**3,'TB':1000**4}[match[2]])
            storage_need(0 <= number <= 2**63-1); return number
        for line in lines:
            value = storage_closed(line)
            storage_need(type(value) is dict and set(value) == {'Type','TotalCount','Active','Size','Reclaimable'}
                and value['Type'] in roles and roles[value['Type']] not in rows)
            def count(value):
                storage_need(type(value) in (str,int) and not isinstance(value,bool)
                    and re.fullmatch('[0-9]{1,12}', str(value)) is not None); return int(value)
            role = roles[value['Type']]; total, active = count(value['TotalCount']), count(value['Active'])
            storage_need(active <= total)
            rows[role] = {'role':role,'count':total,'activeCount':active,
                'sizeBytesEstimate':size(value['Size']),'reclaimableBytesEstimate':size(value['Reclaimable'])}
        result = {'status':'MEASURED','rows':[rows[role] for role in STORAGE_CACHE_ROLES]}
    except Exception: pass
    return result


def storage_execute(binding, driver_factory):
    storage_binding(binding)
    value = {'kind':'STORAGE_READONLY_RESULT_V1','version':1,'operation':'diagnose_storage',
        'producer':binding['producer'],'sourceBinding':binding,'status':'FAILED','code':'IO_FAILURE',
        'baseline':{'currentCommit':STORAGE_BASELINE,'currentManifestSha256':STORAGE_CURRENT_SHA,
            'previousCommit':None,'previousManifestSha256':None},
        'disk':{'totalBytes':None,'usedBytes':None,'freeBytes':None},
        'directories':[{'role':role,'status':'NOT_MEASURED','allocatedBytes':None} for role, _ in STORAGE_DIRECTORIES],
        'cache':{'status':'NOT_MEASURED','rows':[]},
        'guards':{'currentUnchanged':False,'servicesUnchanged':False,'servicesBeforeSha256':None,
            'servicesAfterSha256':None,'clientCleanupVerified':False},
        'authority':False,'productionEligible':False,'rawOutputSuppressed':True}
    deadline = time.monotonic()+570; guard = StorageGuard(deadline); temporary = None
    try:
        storage_need(storage_root(), 'ROOT_REQUIRED'); guard.open()
        value['baseline'].update(previousCommit=guard.manifests[0]['previousCommit'], previousManifestSha256=guard.previous_sha)
        import tempfile
        temporary = tempfile.TemporaryDirectory(prefix='storage-readonly-client-', dir=BASE/'.staging')
        client = Path(temporary.name); client.chmod(0o700)
        fd = os.open(client/'config.json', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        try: storage_need(os.write(fd,b'{}\n') == 3)
        finally: os.close(fd)
        driver = driver_factory(guard.current,client)
        native = driver.native
        def bounded(*args,timeout=30):
            guard.remaining(); return native(*args,timeout=min(30,max(1,int(deadline-time.monotonic()))))
        driver.native = bounded
        before = driver.snapshot(guard.current); value['guards']['servicesBeforeSha256'] = before
        storage_need(before == STORAGE_SERVICES_SHA, 'SERVICES_CHANGED'); guard.verify()
        disk = shutil.disk_usage(BASE)
        storage_need(all(type(n) is int and n >= 0 for n in disk) and disk.total > 0
            and disk.used<=disk.total and disk.free<=disk.total
            and disk.used+disk.free <= disk.total, 'DISK_INVALID')
        value['disk'] = dict(zip(('totalBytes','usedBytes','freeBytes'),disk))
        value['directories'] = [storage_directory_usage(role,Path(path),deadline) for role,path in STORAGE_DIRECTORIES]
        value['cache'] = storage_cache(driver)
        guard.verify(); after = driver.snapshot(guard.current); value['guards']['servicesAfterSha256'] = after
        storage_need(before == after, 'SERVICES_CHANGED'); guard.verify()
        value['guards'].update(currentUnchanged=True,servicesUnchanged=True)
        value.update(status='DIAGNOSED',code='OK')
    except Exception as error:
        value['code'] = str(error) if type(error) is StorageRejected and str(error) in STORAGE_CODES else 'IO_FAILURE'
    finally:
        try:
            guard.close()
            if temporary is not None: temporary.cleanup()
            value['guards']['clientCleanupVerified'] = True
        except Exception: value.update(status='FAILED',code='IO_FAILURE')
    return validate_result(value,binding)


def validate_result(value,binding):
    storage_binding(binding)
    storage_need(type(value) is dict and set(value) == STORAGE_RESULT_FIELDS
        and value['kind'] == 'STORAGE_READONLY_RESULT_V1' and type(value['version']) is int and value['version'] == 1
        and value['operation'] == 'diagnose_storage' and value['producer'] == binding['producer']
        and value['sourceBinding'] == binding and value['status'] in ('DIAGNOSED','FAILED')
        and value['code'] in STORAGE_CODES and (value['status']=='DIAGNOSED') == (value['code']=='OK')
        and value['authority'] is False and value['productionEligible'] is False and value['rawOutputSuppressed'] is True)
    baseline=value['baseline']
    storage_need(type(baseline) is dict and set(baseline)=={'currentCommit','currentManifestSha256','previousCommit','previousManifestSha256'}
        and baseline['currentCommit']==STORAGE_BASELINE and baseline['currentManifestSha256']==STORAGE_CURRENT_SHA
        and (baseline['previousCommit'] is None and baseline['previousManifestSha256'] is None
            or type(baseline['previousCommit']) is str and re.fullmatch('[a-f0-9]{40}',baseline['previousCommit'])
            and type(baseline['previousManifestSha256']) is str and re.fullmatch('[a-f0-9]{64}',baseline['previousManifestSha256'])))
    disk = value['disk']; storage_need(type(disk) is dict and set(disk)=={'totalBytes','usedBytes','freeBytes'}
        and (all(n is None for n in disk.values()) or all(type(n) is int and 0<=n<=2**63-1 for n in disk.values())
            and disk['totalBytes']>0 and disk['usedBytes']<=disk['totalBytes'] and disk['freeBytes']<=disk['totalBytes']
            and disk['usedBytes']+disk['freeBytes']<=disk['totalBytes']))
    rows=value['directories']; storage_need(type(rows) is list and len(rows)==len(STORAGE_DIRECTORIES))
    for (role,_),row in zip(STORAGE_DIRECTORIES,rows):
        storage_need(type(row) is dict and set(row)=={'role','status','allocatedBytes'} and row['role']==role
            and row['status'] in ('NOT_MEASURED','MEASURED','MISSING','UNAVAILABLE')
            and ((type(row['allocatedBytes']) is int and 0<=row['allocatedBytes']<=2**63-1) if row['status']=='MEASURED' else row['allocatedBytes'] is None))
    cache=value['cache']; storage_need(type(cache) is dict and set(cache)=={'status','rows'}
        and cache['status'] in ('NOT_MEASURED','MEASURED','UNAVAILABLE') and type(cache['rows']) is list)
    storage_need(len(cache['rows'])==(4 if cache['status']=='MEASURED' else 0))
    for role,row in zip(STORAGE_CACHE_ROLES,cache['rows']):
        storage_need(type(row) is dict and set(row)=={'role','count','activeCount','sizeBytesEstimate','reclaimableBytesEstimate'}
            and row['role']==role and all(type(n) is int and 0<=n<=2**63-1 for k,n in row.items() if k!='role')
            and row['activeCount']<=row['count'])
    guards=value['guards']; storage_need(type(guards) is dict and set(guards)=={'currentUnchanged','servicesUnchanged',
        'servicesBeforeSha256','servicesAfterSha256','clientCleanupVerified'}
        and all(type(guards[k]) is bool for k in ('currentUnchanged','servicesUnchanged','clientCleanupVerified'))
        and all(guards[k] is None or type(guards[k]) is str and re.fullmatch('[a-f0-9]{64}',guards[k])
            for k in ('servicesBeforeSha256','servicesAfterSha256')))
    if value['status']=='DIAGNOSED':
        storage_need(guards['currentUnchanged'] and guards['servicesUnchanged'] and guards['clientCleanupVerified']
            and guards['servicesBeforeSha256']==guards['servicesAfterSha256']==STORAGE_SERVICES_SHA
            and disk['totalBytes'] is not None and baseline['previousCommit'] is not None)
    storage_need(len(storage_canonical(value))<24000)
    return value


def validate_artifact(record,producer,binding):
    storage_producer(producer); storage_binding(binding)
    storage_need(type(record) is dict and set(record)==STORAGE_ARTIFACT_FIELDS
        and record['kind']=='STORAGE_READONLY_ARTIFACT_V1' and record['operation']=='diagnose_storage'
        and record['producer']==producer==binding['producer'] and record['expectedCurrent']==STORAGE_BASELINE
        and record['status'] in ('OPERATION_COMPLETED','OPERATION_FAILED'))
    if record['result'] is None:
        storage_need(record['status']=='OPERATION_FAILED' and record['code']=='TRANSPORT_UNAVAILABLE'
            and (record['commandId'] is None or type(record['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',record['commandId'])))
    else:
        value=validate_result(record['result'],binding)
        storage_need(type(record['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',record['commandId'])
            and record['code']==value['code'] and (record['status']=='OPERATION_COMPLETED')==(value['status']=='DIAGNOSED'))
    storage_need(len(storage_canonical(record))<24000); return record


def storage_selected(raw,names):
    import ast
    parsed=ast.parse(raw); selected={n.name:n for n in parsed.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names}
    storage_need(set(selected)==set(names))
    return '\n'.join(ast.get_source_segment(raw.decode(),selected[name]) for name in names)+'\n'


def parameters(producer, *, source=None, expected_current=STORAGE_BASELINE):
    import ast
    import shlex
    storage_producer(producer); storage_need(expected_current==STORAGE_BASELINE)
    project=Path(source) if source is not None else Path(__file__).resolve().parents[2]
    sources={path:(project/path).read_bytes() for path in STORAGE_SOURCES}
    pins={path:{'bytes':len(raw),'sha256':storage_sha(raw)} for path,raw in sources.items()}
    binding={'producer':producer,'expectedCurrent':expected_current,'sourcePins':pins,
        'capturedProgramBytes':1,'capturedProgramSha256':'0'*64}
    snapshot_raw=sources[STORAGE_SOURCES[2]]
    snapshot_names=('need','sha','canonical','closed_json','snapshot_validate','snapshot_state','NativeSnapshotDriver')
    snapshot_header='import hashlib,json,os,re,subprocess,types\nfrom pathlib import Path\n'
    snapshot_tree=ast.parse(snapshot_raw)
    for name in ('BASELINE','DOCKER','SOCKET','ROLES','SERVICE_FIELDS','SNAPSHOT_FIELDS','SNAPSHOT_STAGES','SNAPSHOT_CODES','PUBLIC_LABEL_FORMAT'):
        node=next(n for n in snapshot_tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
        snapshot_header+=ast.get_source_segment(snapshot_raw.decode(),node)+'\n'
    snapshot_header+="BASE=Path('/opt/id-business-v2')\nHEX=re.compile(r'[a-f0-9]{64}\\Z')\n"
    modules={
        'snapshot':snapshot_header+storage_selected(snapshot_raw,snapshot_names),
        'online':'import hashlib,json,re\n'+storage_selected(sources[STORAGE_SOURCES[3]],('fingerprint','legacy','snapshot')),
        'workspace':"import hashlib,json\nWORKSPACE=True\nCONFIG_FILES=('docker-compose.aws-mysql.yml',)\nONLINE_SERVICE='online-recharge'\n"+storage_selected(sources[STORAGE_SOURCES[4]],('fingerprint','workspace_service_names','snapshot')),
        'remote':'import hashlib,json,re\n'+storage_selected(sources[STORAGE_SOURCES[5]],('require','historical_fingerprint','service_state'))}
    own=sources[STORAGE_SOURCES[1]];own_tree=ast.parse(own)
    header='import hashlib,json,os,re,shutil,stat,subprocess,time,types\nfrom pathlib import Path\nBASE=Path("/opt/id-business-v2")\n'
    for node in own_tree.body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id.startswith('STORAGE_') for t in node.targets):
            header+=ast.get_source_segment(own.decode(),node)+'\n'
    names=('StorageRejected','storage_need','storage_sha','storage_canonical','storage_closed','storage_producer',
        'storage_binding','storage_identity','storage_root','StorageGuard','storage_directory_usage',
        'storage_cache','storage_execute','validate_result')
    body=header+storage_selected(own,names)
    body+='modules='+repr(modules)+'\nloaded={}\nfor name,raw in modules.items():\n m=types.ModuleType(name);exec(compile(raw,"<readonly-snapshot>" ,"exec"),m.__dict__);loaded[name]=m\n'
    body+='def factory(directory,client):\n return loaded["snapshot"].NativeSnapshotDriver(directory,client,loaded["online"],loaded["workspace"],loaded["remote"])\n'
    body+='value=storage_execute(BINDING,factory)\nprint(STORAGE_PREFIX+storage_canonical(value).decode())\nraise SystemExit(0 if value["status"]=="DIAGNOSED" else 1)\n'
    captured=body.encode(); binding['capturedProgramBytes']=len(captured);binding['capturedProgramSha256']=storage_sha(captured);storage_binding(binding)
    encoded=base64.b64encode(gzip.compress(captured,mtime=0)).decode()
    # BINDING is outside the captured code hash to avoid self-referential digests.
    bootstrap='import base64,hashlib,zlib;d=zlib.decompressobj(31);r=d.decompress(base64.b64decode('+repr(encoded)+',validate=True),131073);assert 0<len(r)<=131072 and d.eof and not d.unused_data and not d.unconsumed_tail;assert hashlib.sha256(r).hexdigest()=='+repr(binding['capturedProgramSha256'])+';BINDING='+repr(binding)+';exec(compile(r,"<storage-readonly>","exec"))'
    payload={'commands':['set -eu','umask 077','python3 -c '+shlex.quote(bootstrap)],'executionTimeout':['600']}
    storage_need(len(storage_canonical(payload))<20480);return payload,binding


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--operation', choices=('diagnose', 'cleanup-audit', 'verify-legacy-cache',
        'cleanup-legacy-cache', 'verify-release-archive-cache', 'archive-release-cache'), required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--approved-scope')
    parser.add_argument('--legacy-plan-json')
    parser.add_argument('--retention-migration-sql')
    parser.add_argument('--plan-sha256')
    args = parser.parse_args()
    if args.operation in ('verify-release-archive-cache', 'archive-release-cache'):
        require(not any((args.approved_scope, args.legacy_plan_json, args.retention_migration_sql)),
                'Archive cache operation scope conflicts')
        result = release_archive_cache(args.expected_current, args.plan_sha256,
                                       apply=args.operation == 'archive-release-cache')
    elif args.operation == 'diagnose':
        require(args.plan_sha256 is None, 'Archive cache operation scope conflicts')
        result = diagnose(args.expected_current)
    else:
        require(args.plan_sha256 is None, 'Archive cache operation scope conflicts')
        baseline(args.expected_current)
        if args.operation == 'cleanup-audit':
            result = cleanup_audit(args.expected_current, args.approved_scope, args.retention_migration_sql)
        else:
            result = cleanup_legacy_cache(args.expected_current, args.legacy_plan_json,
                                          apply=args.operation == 'cleanup-legacy-cache')
    encoded = base64.b64encode(gzip.compress(json.dumps(result).encode())).decode()
    print('STORAGE_MAINTENANCE ' + json.dumps({'encoding': 'gzip+base64', 'payload': encoded}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'STORAGE_MAINTENANCE_FAILED', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError)
                          else 'Failure details suppressed'}))
        raise SystemExit(1)
