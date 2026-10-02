"""Retain live/rollback images and remove recoverable project release caches only."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

BASE = Path('/opt/id-business-v2')
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
POLICY = 'current-previous-ecr-cache-v1'
TAG = re.compile(r'[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*-(?:admin|api|migrate|media-resolver|auto-recharge)')
LEGACY_POLICY = 'reviewed-obsolete-project-cache-20261003'
LEGACY_PLAN_SHA256 = '0596af43c4fbf904c3b784ebadb2f444aee3747dc6d8d38a6f9f09a845c6e1c9'
BUILDER_POLICY = 'unused-builder-cache-20261003'


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def read(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, 'Cache command failed; raw output suppressed')
    return result.stdout.strip()


def current(expected):
    path = (BASE / 'current').resolve()
    require(path.parent == BASE / 'releases', 'Unexpected current release path')
    manifest = json.loads((path / 'release-manifest.json').read_text())
    require(manifest['commit'] == expected, 'Production baseline changed')
    previous_path = Path(manifest['previousRelease']).resolve()
    require(previous_path.parent == BASE / 'releases', 'Unexpected previous release path')
    previous = json.loads((previous_path / 'release-manifest.json').read_text())
    require(previous['commit'] == manifest['previousCommit'], 'Previous rollback version changed')
    return manifest, previous


def active_images():
    return {read('docker', 'inspect', '--format', '{{.Image}}', container)
            for container in read('docker', 'ps', '-a', '-q').splitlines()}


def protected_images(manifest, previous, containers):
    return (set(containers)
            | {image['digest'] for release in (manifest, previous)
               for image in release.get('images', {}).values()}
            | set(manifest.get('rollback', {}).get('images', {}).values()))


def make_plan(expected, previous, protected, inventory):
    require(len(inventory) <= 500, 'Image inventory exceeds reviewed bound')
    items = []
    for image in inventory:
        if image['id'] in protected:
            continue
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']), 'Invalid local image identity')
        for reference in image.get('repoTags') or []:
            if not reference.startswith(REPOSITORY + ':'):
                continue
            tag = reference[len(REPOSITORY) + 1:]
            if TAG.fullmatch(tag):
                items.append({'tag': tag, 'imageId': image['id']})
    require(len(items) <= 500 and len({item['tag'] for item in items}) == len(items),
            'Duplicate or excessive release cache references')
    plan = {'policy': POLICY, 'expectedCurrent': expected,
            'expectedPrevious': previous['commit'], 'repository': REPOSITORY,
            'protectedImageIds': sorted(protected), 'items': sorted(items, key=lambda item: item['tag'])}
    require(len(json.dumps(plan).encode()) <= 18000, 'Cache plan exceeds diagnostic output bound')
    return plan


def plan_digest(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verify_remote(plan):
    for start in range(0, len(plan['items']), 100):
        items = plan['items'][start:start + 100]
        response = json.loads(read('aws', 'ecr', 'batch-get-image', '--region', 'ap-northeast-1',
            '--repository-name', 'id-business-v2-release', '--image-ids',
            *['imageTag=' + item['tag'] for item in items], '--output', 'json'))
        require(not response.get('failures'), 'Immutable remote cache recovery is unavailable')
        remote = {image['imageId']['imageTag']: json.loads(image['imageManifest']).get('config', {}).get('digest')
                  for image in response.get('images', [])}
        require(all(remote.get(item['tag']) == item['imageId'] for item in items),
                'Remote ECR identity differs from local cache')


def verify_deployment(manifest, deployment_run):
    require(re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', deployment_run or ''),
            'Invalid successful deployment identity')
    require(manifest.get('deploymentRun') == deployment_run,
            'Cache retention does not follow this successful release')
    require(manifest.get('dataAuditAfter', {}).get('violationCount') == 0,
            'Post-release financial audit is missing or failed')


def apply_plan(plan):
    removed = []
    # Remote recovery for the entire plan is checked before the first deletion.
    verify_remote(plan)
    for item in plan['items']:
        live, previous = current(plan['expectedCurrent'])
        require(live['previousCommit'] == plan['expectedPrevious'], 'Rollback baseline changed')
        protected = protected_images(live, previous, active_images())
        require(item['imageId'] not in protected, 'Cache became used or protected')
        reference = REPOSITORY + ':' + item['tag']
        require(read('docker', 'image', 'inspect', '--format', '{{.Id}}', reference) == item['imageId'],
                'Local image identity changed')
        read('docker', 'image', 'rm', '--no-prune', reference)
        removed.append(item['tag'])
        print('CACHE_IMAGE_REMOVED ' + item['tag'], flush=True)
    return removed


def legacy_plan(payload):
    plan = json.loads(payload)
    require(plan_digest(plan) == LEGACY_PLAN_SHA256, 'Obsolete cache plan differs from reviewed digest')
    require(plan['policy'] == LEGACY_POLICY and len(plan['items']) == 17,
            'Obsolete cache scope changed')
    require(len({item['id'] for item in plan['items']}) == 17, 'Duplicate obsolete cache image')
    return plan


def legacy_identity(item, remaining_tags=None):
    image_format = ('{"id":{{json .Id}},"repoTags":{{json .RepoTags}},'
                    '"repoDigests":{{json .RepoDigests}},'
                    '"sourceCommit":{{json (index .Config.Labels "org.opencontainers.image.revision")}},'
                    '"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}}}')
    actual = json.loads(read('docker', 'image', 'inspect', '--format', image_format, item['id']))
    require(actual['id'] == item['id']
            and sorted(actual['repoTags'] or []) == sorted(item['repoTags'] if remaining_tags is None else remaining_tags)
            and sorted(actual['repoDigests'] or []) == sorted(item['repoDigests'])
            and actual['sourceCommit'] == item['sourceCommit']
            and actual['composeProject'] == item['composeProject'],
            'Obsolete cache identity or ownership changed')


def verify_legacy_item(plan, item, remaining_tags=None):
    live, previous = current(plan['expectedCurrent'])
    require(previous['commit'] == plan['expectedPrevious'], 'Obsolete cache rollback baseline changed')
    require(item['id'] not in protected_images(live, previous, active_images()),
            'Obsolete cache is now used or protected')
    legacy_identity(item, remaining_tags)


def maintain_legacy(args):
    plan = legacy_plan(args.legacy_plan_json)
    require(args.expected_current == plan['expectedCurrent'], 'Obsolete cache production baseline differs')
    require(not args.deployment_run, 'Obsolete cache cleanup cannot run automatically after deployment')
    for item in plan['items']:
        verify_legacy_item(plan, item)
    before = shutil.disk_usage(BASE).free
    result = {'mode': 'APPLIED' if args.apply else 'PLAN_ONLY', 'policy': LEGACY_POLICY,
              'status': 'IN_PROGRESS' if args.apply else 'COMPLETE',
              'currentCommit': args.expected_current, 'planSha256': LEGACY_PLAN_SHA256,
              'candidateCount': len(plan['items']), 'removed': [], 'freeBytesBefore': before}
    if args.apply:
        require(args.approved_policy == LEGACY_POLICY and args.approved_plan_sha256 == LEGACY_PLAN_SHA256,
                'Exact obsolete cache approval required')
        directory = BASE / 'maintenance/docker-cache-retention'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = 'obsolete-' + str(time.time_ns())
        plan_path = directory / (name + '.plan.json')
        plan_path.write_text(json.dumps(plan, indent=2))
        plan_path.chmod(0o600)
        receipt = directory / (name + '.receipt.json')
        receipt.write_text(json.dumps(result, indent=2))
        receipt.chmod(0o600)
        for item in plan['items']:
            tags = list(item['repoTags'])
            for reference in list(tags) or [item['id']]:
                verify_legacy_item(plan, item, tags)
                read('docker', 'image', 'rm', '--no-prune', reference)
                if reference in tags:
                    tags.remove(reference)
                result['removed'].append(reference)
                receipt.write_text(json.dumps(result, indent=2))
                print('OBSOLETE_CACHE_REMOVED ' + reference, flush=True)
    live, previous = current(args.expected_current)
    require(previous['commit'] == plan['expectedPrevious'], 'Obsolete cache rollback baseline changed')
    result['freeBytesAfter'] = shutil.disk_usage(BASE).free
    result['status'] = 'COMPLETE'
    if args.apply:
        receipt.write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


def maintain(args):
    manifest, previous = current(args.expected_current)
    protected = protected_images(manifest, previous, active_images())
    image_ids = sorted(set(read('docker', 'image', 'ls', '--no-trunc', '--quiet').splitlines()))
    require(len(image_ids) <= 500, 'Image inventory exceeds reviewed bound')
    image_format = '{"id":{{json .Id}},"repoTags":{{json .RepoTags}}}'
    inventory = [json.loads(read('docker', 'image', 'inspect', '--format', image_format, image_id))
                 for image_id in image_ids]
    plan = make_plan(args.expected_current, previous, protected, inventory)
    digest = plan_digest(plan)
    removed = []
    before = shutil.disk_usage(BASE).free
    if args.apply:
        require(args.approved_policy == POLICY, 'Explicit cache policy approval required')
        if args.deployment_run:
            verify_deployment(manifest, args.deployment_run)
        else:
            require(args.approved_plan_sha256 == digest, 'Reviewed cache plan changed or not approved')
        directory = BASE / 'maintenance/docker-cache-retention'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + str(time.time_ns())
        plan_path = directory / (name + '.plan.json')
        with plan_path.open('x') as target:
            json.dump(plan, target, indent=2)
        plan_path.chmod(0o600)
        removed = apply_plan(plan)
    else:
        verify_remote(plan)
    result = {'mode': 'APPLIED' if args.apply else 'PLAN_ONLY', 'policy': POLICY,
              'currentCommit': args.expected_current, 'planSha256': digest,
              'candidateCount': len(plan['items']), 'removed': removed,
              'freeBytesBefore': before, 'freeBytesAfter': shutil.disk_usage(BASE).free,
              'plan': plan}
    if args.apply:
        path = directory / (name + '.receipt.json')
        with path.open('x') as target:
            json.dump(result, target, indent=2)
        path.chmod(0o600)
    print(json.dumps({key: value for key, value in result.items() if key != 'plan' or not args.apply}))


def builder_plan(expected):
    live, previous = current(expected)
    projects = read('docker', 'ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}').splitlines()
    require(projects and set(projects) == {'20260821t095106z'},
            'Builder cleanup requires the dedicated project host')
    usage = [json.loads(line) for line in read('docker', 'system', 'df', '--format', '{{json .}}').splitlines()]
    builders = [item for item in usage if item['Type'] == 'Build Cache']
    require(len(builders) == 1 and builders[0]['Active'] == '0', 'Active or unavailable build cache')
    require(builders[0]['TotalCount'] == '52', 'Reviewed legacy build cache count changed')
    return {'policy': BUILDER_POLICY, 'expectedCurrent': expected,
            'expectedPrevious': previous['commit'],
            'protectedContainerImageIds': sorted(active_images()), 'builderUsage': builders[0]}


def prune_builder():
    # This command affects build cache only. Docker protects referenced images and active builds.
    result = subprocess.run(['docker', 'builder', 'prune', '--all'], input='y\n',
                            capture_output=True, text=True, timeout=600)
    require(result.returncode == 0, 'Builder cleanup failed; raw output suppressed')
    total = re.search(r'Total(?: reclaimed space)?:\s*([0-9.]+\s*[kMGT]?B)', result.stdout)
    require(total is not None, 'Builder cleanup total is unavailable')
    return total[1]


def maintain_builder(args):
    require(not args.deployment_run and args.expected_current == 'c7c7cd5fab7138f445c715118b5dd75d0df4ac2f',
            'Builder cleanup is limited to the reviewed manual production baseline')
    plan = builder_plan(args.expected_current)
    require(plan['expectedPrevious'] == '220c6f45d9cbca8f4a95f275a24168c41d387a17',
            'Builder cleanup rollback baseline changed')
    digest = plan_digest(plan)
    result = {'mode': 'APPLIED' if args.apply else 'PLAN_ONLY', 'policy': BUILDER_POLICY,
              'planSha256': digest, 'plan': plan, 'freeBytesBefore': shutil.disk_usage(BASE).free}
    if args.apply:
        require(args.approved_policy == BUILDER_POLICY and args.approved_plan_sha256 == digest,
                'Exact builder cache approval required')
        directory = BASE / 'maintenance/docker-cache-retention'
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = directory / ('builder-' + str(time.time_ns()) + '.receipt.json')
        result['status'] = 'IN_PROGRESS'
        path.write_text(json.dumps(result, indent=2))
        path.chmod(0o600)
        require(builder_plan(args.expected_current) == plan, 'Builder cache plan changed before cleanup')
        result['dockerReportedRemovedCache'] = prune_builder()
        live, previous = current(args.expected_current)
        require(previous['commit'] == plan['expectedPrevious'], 'Builder cleanup rollback changed')
        require(active_images() == set(plan['protectedContainerImageIds']), 'Container images changed during cleanup')
        after = [json.loads(line) for line in read('docker', 'system', 'df', '--format', '{{json .}}').splitlines()]
        result['builderUsageAfter'] = next(item for item in after if item['Type'] == 'Build Cache')
        require(result['builderUsageAfter']['TotalCount'] == '0', 'Unused build cache remains')
        result['status'] = 'COMPLETE'
    result['freeBytesAfter'] = shutil.disk_usage(BASE).free
    if args.apply:
        path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--approved-policy')
    parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--deployment-run')
    parser.add_argument('--legacy-plan-json')
    parser.add_argument('--legacy-builder-cache', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_current), 'Invalid production baseline')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not (args.legacy_builder_cache and args.legacy_plan_json), 'Conflicting manual cache scopes')
        if args.legacy_builder_cache:
            maintain_builder(args)
        elif args.legacy_plan_json:
            maintain_legacy(args)
        else:
            maintain(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'CACHE_RETENTION_FAILED', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError)
                          else 'Failure details suppressed'}))
        raise SystemExit(1)
