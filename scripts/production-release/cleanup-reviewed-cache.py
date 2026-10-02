"""Prepare or apply one reviewed local ECR mirror cache cleanup; never prune."""
import argparse
import fcntl
import hashlib
import json
import re
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
    '66f6dad653306691466fa4b5955cff6f331eebb7d3de899e0efef8755edecb7d': (
        '7008a91537caa36a90cd8f5f616c9c6f37ce5f5d-36885081577-1-',
        '848d2c6cdce43909cfe981eca23dcaf8782a96ad-36831835914-1-',
        'ddbcc8b5c117638e6f4fed668285ab4fadd1968a-36853839850-1-',
        'f3558f30d09f1eebf62c171b23e1b497e22993e2-36899703841-1-',
    ),
    'd48439d92ca91f2ddf5b30bef5da7b3f0d2fdf90644b64196c3a72f0b1c2c0cc': (
        '7c947bab59ead760ad0a480b37ae54cd5ab0501d-36963452599-1-',
        'd1ed460eff55df7167a806dd3e1f7abdef5ef24d-36907590117-1-',
    ),
    '21c05c434dc5e676f6060dcfa90db91ac2c18f196e9f3e033f518ce164182ad5': (
        '3b7e40d2dcf6fff43d3fd4f23dfbbd9f8f1cb31e-36912718145-1-',
        'f3558f30d09f1eebf62c171b23e1b497e22993e2-36899703841-1-',
    ),
}

REVIEWED_PLAN_COUNTS = {
    '66f6dad653306691466fa4b5955cff6f331eebb7d3de899e0efef8755edecb7d': 12,
    'd48439d92ca91f2ddf5b30bef5da7b3f0d2fdf90644b64196c3a72f0b1c2c0cc': 6,
    '21c05c434dc5e676f6060dcfa90db91ac2c18f196e9f3e033f518ce164182ad5': 5,
}
POST_RELEASE_PLANS = {
    '66f6dad653306691466fa4b5955cff6f331eebb7d3de899e0efef8755edecb7d',
    'd48439d92ca91f2ddf5b30bef5da7b3f0d2fdf90644b64196c3a72f0b1c2c0cc',
}
PRE_RELEASE_BASELINES = {
    '66f6dad653306691466fa4b5955cff6f331eebb7d3de899e0efef8755edecb7d': (
        '3b7e40d2dcf6fff43d3fd4f23dfbbd9f8f1cb31e',
        'd1ed460eff55df7167a806dd3e1f7abdef5ef24d',
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
    parser.add_argument('--expected-current')
    args = parser.parse_args()
    plan = json.loads(args.plan_json)
    digest = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(digest in REVIEWED_PLANS, 'Plan differs from the reviewed cache digest')
    if args.apply:
        require(args.approved_plan_sha256 == digest, 'Explicit plan approval required')
    prefixes = REVIEWED_PLANS[digest]
    expected_current = args.expected_current or plan['expectedCurrent']
    require(re.fullmatch(r'[0-9a-f]{40}', expected_current), 'Invalid production baseline')
    require(not args.expected_current or digest in POST_RELEASE_PLANS,
            'This reviewed plan does not allow a post-release baseline')
    require(plan['repository'] == '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            'Unexpected repository')
    require(len(plan['items']) == REVIEWED_PLAN_COUNTS.get(digest, 10),
            'Reviewed cache reference count changed')
    lock = None
    if args.apply:
        lock = (BASE / '.deploy.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = current()
    require(manifest['commit'] == expected_current, 'Production baseline changed')
    previous_path = Path(manifest['previousRelease']).resolve()
    require(previous_path.parent == BASE / 'releases', 'Unexpected previous release path')
    previous = json.loads((previous_path / 'release-manifest.json').read_text())
    expected_previous = plan['expectedPrevious']
    recovery_baseline = PRE_RELEASE_BASELINES.get(digest)
    if recovery_baseline and expected_current == recovery_baseline[0]:
        expected_previous = recovery_baseline[1]
    require(previous['commit'] == expected_previous, 'Previous rollback version changed')
    protected = active_images() | protected_images(manifest) | protected_images(previous, include_rollback=False)
    protected.update(plan.get('protectedCandidateImageIds', []))
    approved = []
    services = {(prefix, service) for prefix in prefixes for service in
                ('admin', 'api', 'migrate', 'media-resolver', 'auto-recharge')}
    if digest in REVIEWED_PLAN_COUNTS:
        # Mixed service sets are allowed only for these exact reviewed digests.
        services = {(prefix, item['tag'][len(prefix):]) for prefix in prefixes
                    for item in plan['items'] if item['tag'].startswith(prefix)}
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
            require(current()['commit'] == expected_current, 'Production baseline changed')
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
