"""Retain live/rollback images and remove recoverable project release caches only."""
import argparse
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

BASE = Path('/opt/id-business-v2')
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
POLICY = 'current-service-rollback-explicit-dependencies-ecr-cache-v2'
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
FIXED_REGISTRATION_IDS = frozenset({
    'registration-worker-956-20261006', 'registration-worker-b8-80-20261006',
    *('registration-worker-' + str(number) + '-20261006' for number in range(85, 90)),
    'registration-worker-90-20261007', 'registration-worker-91-20261007', 'registration-worker-92-20261007', 'registration-worker-93-20261007',
})
FIXED_RECHARGE_IDS = frozenset({'recharge-pro-main80-20261006', 'recharge-pro-974-20261007'})
ORDER_ARCHIVE_SEAL_RELATIVE = 'backups/mysql/partial-two-order-authorized-20261005-v1/reviewed-order-archive-release-seal.json'
TAG = re.compile(r'[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*-(?:admin|api|migrate|media-resolver|auto-recharge)')
LEGACY_POLICY = 'reviewed-obsolete-project-cache-20261003'
LEGACY_PLAN_SHA256 = '0596af43c4fbf904c3b784ebadb2f444aee3747dc6d8d38a6f9f09a845c6e1c9'
BUILDER_POLICY = 'unused-builder-cache-20261003'
HISTORY_CONTINUATION_POLICY_ID = 'historical-finance-20261005-registration-continuation'
HISTORY_CONTINUATION_BASELINE = 'd0f359dc78b2d2b166893bfec8545609f5baa16d'
CONTINUATION_PROOF_SHA256 = '5762fb16f9787ca1c3bcb255a31e50188dc868de66bbaee8768cab8945cb21ba'
CONTINUATION_SOURCES_SHA256 = 'db943f1852946a475b43940cd6db62abcc4e78b7a8345f141633106a1399d884'

HISTORY_DIAGNOSTICS_POLICY_ID = 'historical-finance-20261005-recharge-diagnostics'
HISTORY_DIAGNOSTICS_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
DIAGNOSTICS_PROOF_SHA256 = '5412e83e9702c09d2e070e98b7eb4256dfd8cfbbf4be6bf09e3f13202a2bb670'

HISTORY_MAINTENANCE_POLICY_ID = 'historical-finance-20261005-maintenance-continuation'
HISTORY_MAINTENANCE_BASELINE = '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
MAINTENANCE_EXPECTED_GATE = {
    'accepted': True,
    'status': 'APPROVED_MAINTENANCE_SUBSET',
    'policyId': HISTORY_MAINTENANCE_POLICY_ID,
    'expectedCurrent': HISTORY_MAINTENANCE_BASELINE,
    'fixedCurrent': HISTORY_MAINTENANCE_BASELINE,
    'checkCount': 48,
    'executedCheckCount': 48,
    'unavailableCheckCount': 0,
    'violationCount': 6,
    'databaseName': 'id_business_v2_partial_cleanup_20261005_v1',
    'policySha256': '2103ab9a701fca15af406284874ef70d91004d6b2ac5cdd92fa91a8403399135',
    'rulesSha256': '259332c0c8eb2d3d96d066cecd7cbe294ed5f2bd1e7af0d1c39f6c002859d7f4',
    'schemaSha256': '3aef82a77e90f3cb4a2a953d67808193168159aa8983276b67e12f916a0a3655',
    'entitySetSha256': 'f23d021df7a2693b4b5ad3de3818ab6ea475a2362e7c71dd39dc489f3eeb2c43',
    'closureItemsSha256': '0a917c246769c7bcc16d23859e687ed036c97c6289612ea4efc5f7dc16a0ab83',
    'receiptSetSha256': '52839f3b24b7f47897db165a04a22f51d2d5918ad5946cad2f669f53536e831d',
    'sourceSha256': '526e724a822540c5f33ddd9e38c71e3079efa1fce9672f8ceef5096e38cc7208'
}



MAILBOX_POLICY_ID = 'historical-finance-20261005-mailbox-batch'
MAILBOX_BASELINE = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'
MAILBOX_IMAGE_IDENTITY = ('f5826f9fb4ad0d846d9875c035c913a61eb68290', '37312405714', '1')
MAILBOX_POLICY_SHA256 = 'f3051a718cdbd55840d50affe6e5e1ddc62f187ff231f309679998608189481c'
MAILBOX_MANIFEST_SHA256 = 'a0c248295509397e1862b13bd3aa41f46f32955ad8862226de56e63f868be9d8'
MAILBOX_EXPECTED_GATE = {'accepted': True, 'status': 'APPROVED_MAILBOX_FROZEN_EXCEPTIONS', 'policyId': 'historical-finance-20261005-mailbox-batch', 'policySha256': 'f3051a718cdbd55840d50affe6e5e1ddc62f187ff231f309679998608189481c', 'expectedCurrent': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0', 'fixedCurrent': 'b8d643450ffa9012ccc09ead15e4681e3dee98d0', 'imageCommit': 'f5826f9fb4ad0d846d9875c035c913a61eb68290', 'imageRun': '37312405714', 'imageAttempt': '1', 'checkCount': 48, 'executedCheckCount': 48, 'unavailableCheckCount': 0, 'violationCount': 6, 'snapshotSha256': '03c3c6c494f7c5878441813814d3dc0fac9ad9d4b3480b0e81835129c97c76df', 'servicesUpdated': ['api']}

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


def protected_images(manifest, previous, containers, dependencies=None):
    return (set(containers)
            | {image['digest'] for release in (manifest, previous)
               for image in release.get('images', {}).values()}
            | set(manifest.get('rollback', {}).get('images', {}).values())
            | set((dependencies or {}).get('imageIds', [])))


def dependency_file(path, evidence, *, limit=2 * 1024 * 1024):
    """Read metadata only; never execute the old producer or inspect environment files."""
    require(path.is_absolute() and BASE in path.parents and path.resolve() == path
        and all(not parent.is_symlink() for parent in path.parents if parent == BASE or BASE in parent.parents),
        'Dependency evidence path is not a regular project file')
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
        info.st_gid, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit,
            'Dependency evidence size or type is unavailable')
        raw = source.read(limit + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(source.fileno()))
            == identity(path.lstat()), 'Dependency evidence changed during read')
    evidence[str(path.relative_to(BASE))] = hashlib.sha256(raw).hexdigest()
    return raw


def release_metadata(directory, evidence):
    require(directory.is_absolute() and directory.parent == BASE / 'releases'
        and directory.resolve() == directory, 'Rollback metadata path changed')
    value = json.loads(dependency_file(directory / 'release-manifest.json', evidence, limit=128 * 1024))
    require(isinstance(value, dict) and re.fullmatch(r'[0-9a-f]{40}', value.get('commit', ''))
        and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + value['commit'][:12], directory.name)
        and isinstance(value.get('images'), dict) and value['images'], 'Rollback metadata identity changed')
    require(all(isinstance(image, dict) and IMAGE_ID.fullmatch(image.get('digest', ''))
        for image in value['images'].values()), 'Rollback image identity changed')
    return value


def literal_dependency(tree, name):
    rows = [node.value for node in tree.body if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    require(len(rows) == 1, 'Fixed dependency declaration unavailable')
    try:
        value = ast.literal_eval(rows[0])
    except (ValueError, TypeError, SyntaxError):
        raise RuntimeError('Unknown fixed dependency declaration') from None
    require(isinstance(value, dict), 'Unknown fixed dependency declaration')
    return value


def fixed_dependencies(directory, manifest, evidence):
    """The finance executor and Pro inspect bridge need images; native_chain needs files only."""
    claims = [('fixedRegistrationRelease', FIXED_REGISTRATION_IDS, 'profileRawSha256'),
              ('fixedRechargeRelease', FIXED_RECHARGE_IDS, 'profileSha256')]
    profiles = []
    for field, allowed, digest_key in claims:
        claim = manifest.get(field)
        if claim is None:
            continue
        require(isinstance(claim, dict) and claim.get('id') in allowed,
            'Unknown fixed release dependency requires review')
        raw = dependency_file(directory / ('deploy/aws/' + claim['id'] + '.json'), evidence, limit=128 * 1024)
        profile = json.loads(raw)
        digest = hashlib.sha256(raw).hexdigest() if digest_key == 'profileRawSha256' else plan_digest(profile)
        require(profile.get('id') == claim['id'] and claim.get(digest_key) == digest,
            'Fixed dependency profile changed')
        finance = profile.get('financeValidator', {})
        require(isinstance(finance, dict) and finance.get('kind') in
            ('EXISTING_SEALED_ORDER_ARCHIVE_49', 'EXISTING_ORDER_ARCHIVE_49'),
            'Unknown fixed finance dependency requires review')
        profiles.append(profile)
    if not profiles:
        return set()
    tree = ast.parse(dependency_file(directory / 'scripts/production-release/remote-deploy.py', evidence))
    finance = literal_dependency(tree, 'REGISTRATION_FINANCE')
    require(finance.get('kind') == 'EXISTING_SEALED_ORDER_ARCHIVE_49',
        'Unknown fixed finance dependency requires review')
    raw = dependency_file(BASE / ORDER_ARCHIVE_SEAL_RELATIVE, evidence, limit=128 * 1024)
    require(hashlib.sha256(raw).hexdigest() == finance.get('releaseSealSha256')
        and all(profile['financeValidator'].get('releaseSealSha256') == finance.get('releaseSealSha256')
            for profile in profiles), 'Fixed finance dependency seal changed')
    images = json.loads(raw).get('images')
    require(isinstance(images, dict) and set(images) == {'admin', 'api', 'migrate'}
        and all(isinstance(image, str) and IMAGE_ID.fullmatch(image) for image in images.values()),
        'Unknown sealed image dependency requires review')
    for profile in profiles:
        declared = profile['financeValidator'].get('images')
        require(declared is None or declared == images, 'Fixed finance image dependencies changed')
    pro = literal_dependency(tree, 'REGISTRATION_EMAIL_OBSERVATION_PRO_BASELINE')
    require(pro.get('status') == 'VERIFIED_PRO_AFTER_88_RUNTIME_BASELINE'
        and isinstance(pro.get('current'), str) and isinstance(pro.get('manifest'), dict),
        'Unknown fixed Pro dependency requires review')
    observed = release_metadata(Path(pro['current']), evidence)
    image = pro['manifest'].get('images', {}).get('auto-recharge')
    require(isinstance(image, dict) and IMAGE_ID.fullmatch(image.get('digest', ''))
        and observed.get('commit') == pro['manifest'].get('commit')
        and observed.get('sourceTree') == pro['manifest'].get('sourceTree')
        and observed['images'].get('auto-recharge') == image,
        'Fixed Pro image dependency changed')
    return set(images.values()) | {image['digest']}


def collect_dependencies(manifest, previous):
    evidence, rollback, images = {}, {}, set()
    directory = (BASE / 'current').resolve()
    observed = release_metadata(directory, evidence)
    require(observed == manifest, 'Current dependency metadata changed')
    images |= fixed_dependencies(directory, observed, evidence)
    prior_directory = Path(manifest['previousRelease'])
    require(release_metadata(prior_directory, evidence) == previous, 'Previous dependency metadata changed')
    images |= fixed_dependencies(prior_directory, previous, evidence)
    # A global previous release may update only registration. Find one different
    # predecessor per service without protecting every image in the history.
    missing = set(manifest['images'])
    seen = {str(directory)}
    row = observed
    for _ in range(100):
        if not missing:
            break
        if not row.get('previousRelease'):
            require(not row.get('previousCommit'), 'Rollback metadata chain is incomplete')
            break
        directory = Path(row['previousRelease'])
        require(str(directory) not in seen, 'Rollback metadata chain contains a cycle')
        seen.add(str(directory))
        predecessor = release_metadata(directory, evidence)
        require(predecessor['commit'] == row.get('previousCommit'), 'Rollback metadata chain changed')
        for service in sorted(missing.copy()):
            image = predecessor['images'].get(service)
            # A service can have been introduced later; its absence ends its chain.
            if image is None:
                missing.remove(service)
                rollback[service] = {'status': 'NO_EARLIER_SERVICE_VERSION'}
            elif image['digest'] != manifest['images'][service]['digest']:
                images.add(image['digest']); missing.remove(service)
                rollback[service] = {'status': 'RETAINED', 'commit': predecessor['commit'], 'imageId': image['digest']}
        row = predecessor
    else:
        require(not missing, 'Rollback dependency chain exceeds reviewed bound')
    for service in missing:
        rollback[service] = {'status': 'NO_DISTINCT_PREDECESSOR'}
    for image in sorted(images):
        require(read('docker', 'image', 'inspect', '--format', '{{.Id}}', image) == image,
            'Required rollback or fixed dependency image is unavailable')
    return {'version': 1, 'imageIds': sorted(images), 'serviceRollback': rollback,
            'evidenceSha256': dict(sorted(evidence.items()))}


def make_plan(expected, previous, protected, inventory, dependencies=None):
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
    if dependencies is not None:
        plan['dependencies'] = dependencies
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
    before = manifest.get('dataAuditBefore', {}).get('historicalException', {})
    after = manifest.get('dataAuditAfter', {}).get('historicalException', {})
    historical_ok = (
        manifest.get('previousCommit') == 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
        and before.get('accepted') is True and after.get('accepted') is True
        and before.get('policyId') == after.get('policyId') == 'historical-finance-20261005'
        and before.get('expectedCurrent') == after.get('expectedCurrent') == manifest.get('previousCommit')
        and before.get('stage') == 'before' and after.get('stage') == 'after'
        and after.get('checkCount') == after.get('executedCheckCount') == 48
        and after.get('unavailableCheckCount') == 0
        and after.get('violationCount') == manifest.get('dataAuditAfter', {}).get('violationCount') == 10
        and before.get('sources') == after.get('sources') and bool(after.get('sources'))
        and before.get('metadataSha256') == after.get('metadataSha256')
        and re.fullmatch(r'[a-f0-9]{64}', after.get('metadataSha256', '')) is not None
    )
    continuation_ok = manifest.get('previousCommit') == HISTORY_CONTINUATION_BASELINE
    for stage, gate in (('before', before), ('after', after)):
        summary = manifest.get('dataAudit' + stage.title(), {})
        continuation_ok = continuation_ok and (
            gate.get('accepted') is True and gate.get('policyId') == HISTORY_CONTINUATION_POLICY_ID
            and gate.get('status') == 'APPROVED_HISTORICAL_EXCEPTIONS'
            and gate.get('expectedCurrent') == gate.get('fixedCurrent') == HISTORY_CONTINUATION_BASELINE
            and gate.get('continuationOf') == 'historical-finance-20261005'
            and gate.get('stage') == stage
            and summary.get('checkCount') == gate.get('checkCount') == gate.get('executedCheckCount') == 48
            and gate.get('unavailableCheckCount') == 0
            and summary.get('violationCount') == gate.get('violationCount') == 10
            and hashlib.sha256(json.dumps(gate.get('continuation'), sort_keys=True,
                separators=(',', ':')).encode()).hexdigest() == CONTINUATION_PROOF_SHA256
            and hashlib.sha256(json.dumps(gate.get('sources'), sort_keys=True,
                separators=(',', ':')).encode()).hexdigest() == CONTINUATION_SOURCES_SHA256
            and gate.get('metadataSha256') == gate.get('continuation', {}).get('metadataSha256')
        )
    diagnostics_claimed = any(gate.get('policyId') == HISTORY_DIAGNOSTICS_POLICY_ID
                              for gate in (before, after))
    diagnostics_ok = manifest.get('previousCommit') == HISTORY_DIAGNOSTICS_BASELINE
    for stage, gate in (('before', before), ('after', after)):
        summary = manifest.get('dataAudit' + stage.title(), {})
        diagnostics_ok = diagnostics_ok and (
            gate.get('accepted') is True and gate.get('policyId') == HISTORY_DIAGNOSTICS_POLICY_ID
            and gate.get('status') == 'APPROVED_HISTORICAL_EXCEPTIONS'
            and gate.get('expectedCurrent') == gate.get('fixedCurrent') == HISTORY_DIAGNOSTICS_BASELINE
            and gate.get('continuationOf') == 'historical-finance-20261005'
            and gate.get('stage') == stage
            and summary.get('checkCount') == gate.get('checkCount') == gate.get('executedCheckCount') == 48
            and gate.get('unavailableCheckCount') == 0
            and summary.get('violationCount') == gate.get('violationCount') == 10
            and hashlib.sha256(json.dumps(gate.get('continuation'), sort_keys=True,
                separators=(',', ':')).encode()).hexdigest() == DIAGNOSTICS_PROOF_SHA256
            and hashlib.sha256(json.dumps(gate.get('sources'), sort_keys=True,
                separators=(',', ':')).encode()).hexdigest() == CONTINUATION_SOURCES_SHA256
            and gate.get('metadataSha256') == gate.get('continuation', {}).get('metadataSha256')
        )
    # A claimed third entry must not fall through the ordinary zero-anomaly path.
    require(not diagnostics_claimed or diagnostics_ok,
            'Post-release diagnostics financial audit is missing or failed')
    maintenance_claimed = any(gate.get('policyId') == HISTORY_MAINTENANCE_POLICY_ID
                              for gate in (before, after))
    maintenance_ok = manifest.get('previousCommit') == HISTORY_MAINTENANCE_BASELINE
    for stage, gate in (('before', before), ('after', after)):
        summary = manifest.get('dataAudit' + stage.title(), {})
        # Canonical equality also rejects extra fields and bool/number substitutions.
        maintenance_ok = maintenance_ok and (
            type(summary.get('checkCount')) is int and summary['checkCount'] == 48
            and type(summary.get('violationCount')) is int and summary['violationCount'] == 6
            and json.dumps(gate, sort_keys=True, separators=(',', ':'))
                == json.dumps({**MAINTENANCE_EXPECTED_GATE, 'stage': stage},
                              sort_keys=True, separators=(',', ':'))
        )
    require(not maintenance_claimed or maintenance_ok,
            'Post-release maintenance financial audit is missing or failed')
    mailbox_claimed = any(gate.get('policyId') == MAILBOX_POLICY_ID for gate in (before, after))
    mailbox_ok = manifest.get('previousCommit') == MAILBOX_BASELINE
    for stage, gate in (('before', before), ('after', after)):
        summary = manifest.get('dataAudit' + stage.title(), {})
        mailbox_ok = mailbox_ok and (
            type(summary.get('checkCount')) is int and summary['checkCount'] == 48
            and type(summary.get('violationCount')) is int and summary['violationCount'] == 6
            and json.dumps(gate, sort_keys=True, separators=(',', ':'))
                == json.dumps({**MAILBOX_EXPECTED_GATE, 'stage': stage}, sort_keys=True, separators=(',', ':'))
        )
    require(not mailbox_claimed or mailbox_ok, 'Post-release mailbox financial audit is missing or failed')
    require(manifest.get('dataAuditAfter', {}).get('violationCount') == 0
            or historical_ok or continuation_ok or diagnostics_ok or maintenance_ok or mailbox_ok,
            'Post-release financial audit is missing or failed')


def apply_plan(plan):
    removed = []
    # Remote recovery for the entire plan is checked before the first deletion.
    verify_remote(plan)
    for item in plan['items']:
        live, previous = current(plan['expectedCurrent'])
        require(live['previousCommit'] == plan['expectedPrevious'], 'Rollback baseline changed')
        dependencies = collect_dependencies(live, previous)
        require(dependencies == plan.get('dependencies'), 'Reviewed image dependencies changed')
        protected = protected_images(live, previous, active_images(), dependencies)
        require(item['imageId'] not in protected, 'Cache became used or protected')
        reference = REPOSITORY + ':' + item['tag']
        require(read('docker', 'image', 'inspect', '--format', '{{.Id}}', reference) == item['imageId'],
                'Local image identity changed')
        verify_remote({**plan, 'items': [item]})
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
    dependencies = collect_dependencies(manifest, previous)
    protected = protected_images(manifest, previous, active_images(), dependencies)
    image_ids = sorted(set(read('docker', 'image', 'ls', '--no-trunc', '--quiet').splitlines()))
    require(len(image_ids) <= 500, 'Image inventory exceeds reviewed bound')
    image_format = '{"id":{{json .Id}},"repoTags":{{json .RepoTags}}}'
    inventory = [json.loads(read('docker', 'image', 'inspect', '--format', image_format, image_id))
                 for image_id in image_ids]
    plan = make_plan(args.expected_current, previous, protected, inventory, dependencies)
    digest = plan_digest(plan)
    removed = []
    before = shutil.disk_usage(BASE).free
    if args.apply:
        require(args.approved_policy == POLICY, 'Explicit cache policy approval required')
        if args.deployment_run:
            require(not any(manifest.get(field, {}).get('cacheStatus') == 'SKIPPED'
                for field in ('fixedRechargeRelease', 'fixedRegistrationRelease')),
                'Fixed release cache maintenance requires a separately approved exact plan')
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
