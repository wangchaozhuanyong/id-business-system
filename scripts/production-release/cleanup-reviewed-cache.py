"""Prepare or apply one reviewed local ECR mirror cache cleanup; never prune."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

BASE = Path('/opt/id-business-v2')


def require(condition, label):
    if not condition:
        raise RuntimeError(label)


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, 'Command failed; output suppressed')
    return result.stdout.strip()


def current():
    return json.loads((BASE / 'current' / 'release-manifest.json').read_text())


def active_images():
    return {run('docker', 'inspect', '--format', '{{.Image}}', container)
            for container in run('docker', 'ps', '-a', '--format', '{{.ID}}').splitlines()}


def protected_images(manifest, include_rollback=True):
    digests = {image['digest'] for image in manifest.get('images', {}).values()}
    if include_rollback:
        digests.update(manifest.get('rollback', {}).get('images', {}).values())
    return digests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan-json', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    plan = json.loads(args.plan_json)
    require(hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == '7050e4e35b5fa813cb75ae5e5dad1291fcf6c0dbcf222d37f0beccf339006287', 'Plan differs from the authorized five-reference digest')
    require(plan['prefix'] == '39ef6de34debd35d18ccfc08bbb574d00f50a513-36807901316-1-',
            'Plan prefix is outside the reviewed scope')
    require(plan['repository'] == '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            'Unexpected repository')
    require(len(plan['items']) == 5, 'Expected exactly five reviewed cache references')
    lock = None
    if args.apply:
        lock = (BASE / '.deploy.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = current()
    require(manifest['commit'] == plan['expectedCurrent'], 'Production baseline changed')
    previous_path = Path(manifest['previousRelease']).resolve()
    require(previous_path.parent == BASE / 'releases', 'Unexpected previous release path')
    previous = json.loads((previous_path / 'release-manifest.json').read_text())
    require(previous['commit'] == plan['expectedPrevious'], 'Previous rollback version changed')
    protected = active_images() | protected_images(manifest) | protected_images(previous, include_rollback=False)
    approved = []
    services = {'admin', 'api', 'migrate', 'media-resolver', 'auto-recharge'}
    for item in plan['items']:
        tag = item['tag']
        require(tag.startswith(plan['prefix']), 'Tag outside reviewed prefix')
        service = tag[len(plan['prefix']):]
        require(service in services, 'Unexpected cache service')
        services.remove(service)
        reference = plan['repository'] + ':' + tag
        image_id = run('docker', 'image', 'inspect', '--format', '{{.Id}}', reference)
        require(image_id == item['imageId'], 'Image identity changed')
        require(image_id not in protected, 'Image is used by a container or protected release')
        approved.append((reference, image_id, tag))
    require(not services, 'Incomplete service set')
    response = json.loads(run('aws', 'ecr', 'batch-get-image', '--region', 'ap-northeast-1',
        '--repository-name', 'id-business-v2-release', '--image-ids',
        *['imageTag=' + tag for _, _, tag in approved], '--output', 'json'))
    require(not response.get('failures'), 'Immutable remote cache recovery is unavailable')
    remote = {image['imageId']['imageTag']: json.loads(image['imageManifest']).get('config', {}).get('digest')
              for image in response.get('images', [])}
    require(all(remote.get(tag) == image_id for _, image_id, tag in approved),
            'Remote ECR image identity differs from the reviewed local cache')
    before = shutil.disk_usage(BASE).free
    removed = []
    if args.apply:
        for reference, image_id, tag in approved:
            require(current()['commit'] == plan['expectedCurrent'], 'Production baseline changed')
            require(image_id not in active_images(), 'Cache became used by a container')
            run('docker', 'image', 'rm', '--no-prune', reference)
            removed.append(tag)
    print(json.dumps({'mode': 'APPLIED' if args.apply else 'PLAN_ONLY',
                      'removed': removed, 'approvedCount': len(approved),
                      'freeBytesBefore': before, 'freeBytesAfter': shutil.disk_usage(BASE).free}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'CACHE_CLEANUP_FAILED', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError) else 'Failure details suppressed'}))
        raise SystemExit(1)
