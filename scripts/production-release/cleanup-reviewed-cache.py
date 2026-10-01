"""Prepare or apply one reviewed local ECR mirror cache cleanup; never prune."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

BASE = Path('/opt/id-business-v2')
REVIEWED_PLANS = {
    '2b8ecd88497ec3cbe0fca40ab34844265adb36bce593515175afd42f9bebea4f': (
        '6a674279575e9c1468ce570cc4d8fc6d7cc4c028-36845230653-1-',
        'cef5c05d5039f98c24b4b6b17d979535e5ae55d1-36814755308-1-',
    ),
    '52d0eaab7e2ae4526dbc5324a007df774e5d5a8decd0463b4d8c5a14aa1d1235': (
        'd3f58759056ad0234b6ad49fd785a1f634c5b576-36877729414-1-',
        '73c88ca2c4a4b3a0afee15ae9d8b7222bf205085-36888498228-1-',
    ),
}


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
    parser.add_argument('--approved-plan-sha256')
    args = parser.parse_args()
    plan = json.loads(args.plan_json)
    digest = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(digest in REVIEWED_PLANS, 'Plan differs from the reviewed ten-reference digest')
    if args.apply:
        require(args.approved_plan_sha256 == digest, 'Explicit plan approval required')
    prefixes = REVIEWED_PLANS[digest]
    require(plan['repository'] == '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            'Unexpected repository')
    require(len(plan['items']) == 10, 'Expected exactly ten reviewed cache references')
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
    services = {(prefix, service) for prefix in prefixes for service in
                ('admin', 'api', 'migrate', 'media-resolver', 'auto-recharge')}
    for item in plan['items']:
        tag = item['tag']
        prefix = next((prefix for prefix in prefixes if tag.startswith(prefix)), None)
        require(prefix is not None, 'Tag outside reviewed prefix')
        service = tag[len(prefix):]
        require((prefix, service) in services, 'Unexpected cache service')
        services.remove((prefix, service))
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
