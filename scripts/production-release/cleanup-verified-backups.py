"""Remove older local MySQL copies only after verifying identical S3 recovery."""
import argparse
import base64
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

BASE = Path('/opt/id-business-v2')
KEEP_COUNT = 24
NAME = re.compile(r'id-business-v2-\d{8}T\d{6}Z\.sql\.gz')


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def manifest():
    return json.loads((BASE / 'current/release-manifest.json').read_text())


def configuration():
    keys = ('MYSQL_BACKUP_S3_BUCKET', 'MYSQL_BACKUP_S3_PREFIX', 'MYSQL_BACKUP_S3_REGION')
    values = {}
    with (BASE / 'current/.env.aws.production').open() as source:
        for line in source:
            if line.startswith(tuple(key + '=' for key in keys)):
                key, value = line.rstrip('\n').split('=', 1)
                values[key] = value
    bucket = values.get(keys[0], '')
    prefix = values.get(keys[1], 'mysql/daily') or 'mysql/daily'
    region = values.get(keys[2], 'ap-northeast-1') or 'ap-northeast-1'
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket), 'Invalid backup bucket')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', prefix), 'Invalid backup prefix')
    require(re.fullmatch(r'[a-z]{2}(-gov)?-[a-z]+-[0-9]+', region), 'Invalid backup region')
    return bucket, prefix.rstrip('/'), region


def snapshot(path):
    require(not path.is_symlink() and path.is_file(), 'Backup identity changed')
    status = path.stat()
    return status.st_ino, status.st_size, status.st_mtime_ns


def verified(path, config):
    before = snapshot(path)
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    require(snapshot(path) == before, 'Backup changed during verification')
    bucket, prefix, region = config
    result = subprocess.run([
        'aws', 's3api', 'head-object', '--region', region, '--bucket', bucket,
        '--key', prefix + '/' + path.name, '--checksum-mode', 'ENABLED', '--output', 'json',
    ], capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, 'S3 recovery unavailable')
    remote = json.loads(result.stdout)
    require(remote.get('ContentLength') == before[1]
            and remote.get('ChecksumSHA256') == base64.b64encode(digest.digest()).decode()
            and remote.get('ServerSideEncryption') == 'AES256', 'S3 backup identity differs')
    return before


def clean(expected_current, apply=False):
    require(re.fullmatch(r'[0-9a-f]{40}', expected_current), 'Invalid production baseline')
    require((BASE / 'current').resolve().parent == BASE / 'releases', 'Unexpected current release path')
    require((BASE / 'backups/mysql').resolve() == BASE / 'backups/mysql', 'Unexpected backup directory')
    with (BASE / '.deploy.lock').open('a') as deployment_lock, \
            (BASE / 'backups/mysql/.backup.lock').open('a') as backup_lock:
        fcntl.flock(deployment_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(backup_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = manifest()
        require(current['commit'] == expected_current, 'Production baseline changed')
        previous_path = Path(current['previousRelease']).resolve()
        require(previous_path.parent == BASE / 'releases', 'Unexpected previous release path')
        previous = json.loads((previous_path / 'release-manifest.json').read_text())
        protected = {release.get('backupBeforeRelease') for release in (current, previous)}
        files = sorted(path for path in (BASE / 'backups/mysql').iterdir()
                       if NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink())
        require(bool(files), 'No retained MySQL recovery point')
        candidates = [path for path in files[:-KEEP_COUNT] if path.name not in protected]
        config = configuration()
        # Verify retained recovery points and every candidate before the first deletion.
        recovery = {files[-1]} | {path for path in files if path.name in protected}
        for path in sorted(recovery):
            verified(path, config)
        identities = {path: verified(path, config) for path in candidates}
        require(manifest()['commit'] == expected_current, 'Production baseline changed')
        require(all(snapshot(path) == identity for path, identity in identities.items()),
                'Backup identity changed before cleanup')
        before = shutil.disk_usage(BASE).free
        removed = []
        if apply:
            for path in candidates:
                require(manifest()['commit'] == expected_current, 'Production baseline changed')
                require(snapshot(path) == identities[path], 'Backup identity changed before cleanup')
                path.unlink()
                removed.append(path.name)
        return {'mode': 'APPLIED' if apply else 'PLAN_ONLY', 'keepLatestCount': KEEP_COUNT,
                'countBefore': len(files), 'candidateCount': len(candidates),
                'verifiedCandidateBytes': sum(identity[1] for identity in identities.values()),
                'removedFiles': removed, 'countAfter': len(files) - len(removed),
                'protectedReleaseBackups': sorted(name for name in protected if name),
                'latestRetainedBackup': files[-1].name, 's3BackupsDeleted': False,
                'freeBytesBefore': before, 'freeBytesAfter': shutil.disk_usage(BASE).free}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(clean(args.expected_current, args.apply)))
    except Exception as error:
        print(json.dumps({'status': 'BACKUP_CLEANUP_FAILED', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError)
                          else 'Failure details suppressed'}))
        raise SystemExit(1)
