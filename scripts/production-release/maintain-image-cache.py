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
    'registration-worker-90-20261007', 'registration-worker-91-20261007', 'registration-worker-92-20261007', 'registration-worker-93-20261007', 'registration-worker-94-20261007', 'registration-worker-95-20261008',
    'registration-worker-96-20261008',
})
FIXED_RECHARGE_IDS = frozenset({'recharge-pro-main80-20261006', 'recharge-pro-974-20261007',
    'recharge-pro-2f-20261007', 'recharge-pro-4c-20261008', 'recharge-pro-6f5-20261008', 'recharge-pro-pricing-045-20261008'})
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



# Independent fixed-bootstrap plan/apply transport. Ordinary retention and all
# historical approval paths above remain unchanged; no new automatic caller.
CACHE_BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
CACHE_CURRENT_SHA = '317fbcd0e307789539009a2798b7017ff5b977041cc1b8ab617f5f3f2dc5efa3'
CACHE_PREVIOUS = '554eaff77d67cce4b760d24a5c358ccabf2b3a4c'
CACHE_PREVIOUS_SHA = 'bbccd619757a2dcb240937771bb6cb2d575472e6532f8fb6d5d393fe3369950e'
CACHE_SERVICES_SHA = '4100d5c9098b9fee8b42bfde9e0aa3447068d3c76f715479c3eab49f2394d9b4'
CACHE_PREFIX = 'CACHE_RECOVERY_SAFE '
CACHE_PINS = ('.github/workflows/production-release.yml',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/online-recharge-source-permission-repair-transport.py',
    'scripts/production-release/online-recharge-scope.py',
    'scripts/production-release/api-admin-scope.py', 'scripts/production-release/remote-deploy.py')
CACHE_OPERATIONS = ('verify_unused_cache', 'cleanup_unused_cache')
CACHE_STATUSES = ('PLANNED', 'APPLIED', 'FAILED', 'FAILED_MUTATED_UNVERIFIED')
CACHE_CODES = ('OK', 'INPUT_INVALID', 'ROOT_REQUIRED', 'BASELINE_INVALID', 'STATE_CHANGED',
    'SERVICES_CHANGED', 'DEPENDENCY_INVALID', 'INVENTORY_INVALID', 'RECOVERY_INVALID',
    'INVENTORY_LIST_EXEC', 'INVENTORY_LIST_COUNT', 'INVENTORY_LIST_ID',
    'INVENTORY_INSPECT_EXEC', 'INVENTORY_JSON', 'INVENTORY_SHAPE', 'INVENTORY_TAGS',
    'PLAN_CHANGED', 'OUTPUT_BOUND', 'DEADLINE_EXCEEDED', 'IO_FAILURE')
CACHE_PHASES = ('INPUT','BASELINE','SERVICES_BEFORE','DEPENDENCIES','INVENTORY','RECOVERY','PLAN_BINDING','APPLY_GUARD','APPLY_RECOVERY','APPLY_IMAGE','SERVICES_AFTER','COMPLETE')
CACHE_BINDING_FIELDS = {'producer', 'expectedCurrent', 'operation', 'approvedPlanSha256',
    'sourcePins', 'provenOldSourceCommits', 'capturedProgramBytes', 'capturedProgramSha256'}
CACHE_RESULT_FIELDS = {'kind', 'version', 'operation', 'mode', 'producer', 'sourceBinding',
    'status', 'code', 'phase', 'baseline', 'plan', 'planSha256', 'candidateCount',
    'candidateSizeBytesEstimateSum', 'exclusiveBytesReclaimable', 'freeBytesBefore',
    'freeBytesAfter', 'guards', 'mutationAttempted', 'itemReceipts', 'receiptSha256',
    'removedCount', 'authority', 'productionEligible', 'cleanupEligible', 'rawOutputSuppressed'}
CACHE_ARTIFACT_FIELDS = {'kind', 'operation', 'producer', 'expectedCurrent', 'commandId', 'status', 'code', 'result'}
CACHE_EXCLUSIONS = ('PROTECTED', 'SOURCE_NOT_PROVEN_OLD', 'FOREIGN_OR_MIXED_ALIAS', 'SOURCE_TAG_MISMATCH')
CACHE_IMAGE_FORMAT = ('{"id":{{json .Id}},"repoTags":{{json .RepoTags}},'
    '"sourceCommit":{{if eq .Config nil}}null{{else}}{{if eq (index .Config "Labels") nil}}null{{else}}'
    '{{json (index (index .Config "Labels") "org.opencontainers.image.revision")}}{{end}}{{end}},'
    '"sizeBytesEstimate":{{json .Size}}}')


class CacheRejected(RuntimeError):
    pass


def cache_need(ok, code='INPUT_INVALID'):
    if not ok: raise CacheRejected(code)


def cache_sha(raw): return hashlib.sha256(raw).hexdigest()


def cache_canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def cache_closed(raw, limit=24000):
    cache_need(type(raw) in (str, bytes) and 0 < len(raw if type(raw) is bytes else raw.encode()) < limit)
    def unique(rows):
        value = {}
        for key, item in rows:
            cache_need(key not in value); value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda unused: cache_need(False))


def cache_producer(value):
    cache_need(type(value) is dict and set(value) == {'commit','sourceTree','workflowRunId','workflowRunAttempt'})
    cache_need(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}',value[k]) for k in ('commit','sourceTree'))
        and all(type(value[k]) is str and re.fullmatch('[1-9][0-9]{0,19}',value[k]) for k in ('workflowRunId','workflowRunAttempt')))
    return value


def cache_binding(value):
    cache_need(type(value) is dict and set(value) == CACHE_BINDING_FIELDS); cache_producer(value['producer'])
    cache_need(value['expectedCurrent'] == CACHE_BASELINE and value['operation'] in CACHE_OPERATIONS)
    approval = value['approvedPlanSha256']
    cache_need(approval is None if value['operation'] == CACHE_OPERATIONS[0] else
        type(approval) is str and re.fullmatch('[a-f0-9]{64}', approval))
    pins = value['sourcePins']; cache_need(type(pins) is dict and set(pins) == set(CACHE_PINS))
    for row in pins.values():
        cache_need(type(row) is dict and set(row) == {'bytes','sha256'} and type(row['bytes']) is int
            and 0 < row['bytes'] < 2*1024**2 and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']))
    commits = value['provenOldSourceCommits']
    cache_need(type(commits) is list and 0 < len(commits) <= 128 and commits == sorted(set(commits))
        and all(type(c) is str and re.fullmatch('[a-f0-9]{40}',c) for c in commits)
        and not set(commits) & {CACHE_BASELINE,CACHE_PREVIOUS,value['producer']['commit']})
    cache_need(type(value['capturedProgramBytes']) is int and 0 < value['capturedProgramBytes'] <= 131072
        and type(value['capturedProgramSha256']) is str and re.fullmatch('[a-f0-9]{64}',value['capturedProgramSha256']))
    return value


def cache_inventory():
    try: raw_ids = read('docker','image','ls','--no-trunc','--quiet')
    except Exception as error:
        if str(error)=='DEADLINE_EXCEEDED' and isinstance(error,(CacheRejected,globals().get('StorageRejected',CacheRejected))): raise
        raise CacheRejected('INVENTORY_LIST_EXEC') from None
    cache_need(type(raw_ids) is str,'INVENTORY_LIST_ID')
    ids = raw_ids.splitlines()
    cache_need(len(ids) <= 128,'INVENTORY_LIST_COUNT')
    cache_need(all(IMAGE_ID.fullmatch(i) for i in ids),'INVENTORY_LIST_ID')
    rows = []
    for image in sorted(set(ids)):
        try: raw = read('docker','image','inspect','--format',CACHE_IMAGE_FORMAT,image)
        except Exception as error:
            if str(error)=='DEADLINE_EXCEEDED' and isinstance(error,(CacheRejected,globals().get('StorageRejected',CacheRejected))): raise
            raise CacheRejected('INVENTORY_INSPECT_EXEC') from None
        try: row = cache_closed(raw, 2*1024**2)
        except Exception: raise CacheRejected('INVENTORY_JSON') from None
        cache_need(type(row) is dict and set(row) == {'id','repoTags','sourceCommit','sizeBytesEstimate'}
            and row['id'] == image and type(row['sizeBytesEstimate']) is int
            and 0 <= row['sizeBytesEstimate'] <= 2**63-1
            and (row['sourceCommit'] is None or type(row['sourceCommit']) is str)
            and (row['repoTags'] is None or type(row['repoTags']) is list),'INVENTORY_SHAPE')
        tags = row['repoTags'] or []
        try:
            cache_need(type(tags) is list and len(tags) <= 32
                and all(type(tag) is str and 0 < len(tag.encode()) <= 512 for tag in tags)
                and len(tags) == len(set(tags)),'INVENTORY_TAGS')
        except Exception: raise CacheRejected('INVENTORY_TAGS') from None
        rows.append({**row, 'repoTags':sorted(tags)})
    return rows


def cache_filter_inventory(binding, inventory, protected):
    allowed, exclusions = [], dict.fromkeys(CACHE_EXCLUSIONS,0)
    for row in inventory:
        tags, commit = row['repoTags'], row['sourceCommit']
        reason = None
        if row['id'] in protected: reason = 'PROTECTED'
        elif commit not in binding['provenOldSourceCommits']: reason = 'SOURCE_NOT_PROVEN_OLD'
        elif not tags or any(not tag.startswith(REPOSITORY+':') or not TAG.fullmatch(tag[len(REPOSITORY)+1:]) for tag in tags):
            reason = 'FOREIGN_OR_MIXED_ALIAS'
        elif any(tag[len(REPOSITORY)+1:][:40] != commit for tag in tags): reason = 'SOURCE_TAG_MISMATCH'
        if reason: exclusions[reason] += 1
        else: allowed.append(row)
    return allowed, exclusions


def cache_recovery(plan, holder):
    holder['recovery'] = {}
    verify_remote(plan)
    cache_need(set(holder['recovery']) == {item['tag'] for item in plan['items']},'RECOVERY_INVALID')
    return holder['recovery'].copy()


def cache_plan(binding, manifest, previous, dependencies, containers, inventory, holder):
    protected = protected_images(manifest, previous, containers, dependencies)
    allowed, excluded = cache_filter_inventory(binding,inventory,protected)
    plan = make_plan(CACHE_BASELINE,previous,protected,allowed,dependencies)
    recovery = cache_recovery(plan,holder)
    rows = {row['id']:row for row in allowed}
    plan['items'] = [{**item, 'sourceCommit':rows[item['imageId']]['sourceCommit'],
        'sizeBytesEstimate':rows[item['imageId']]['sizeBytesEstimate'], **recovery[item['tag']]} for item in plan['items']]
    plan.update(sourceCommit=binding['producer']['commit'],sourceTree=binding['producer']['sourceTree'],
        sourcePinsSha256=cache_sha(cache_canonical(binding['sourcePins'])),
        currentManifestSha256=CACHE_CURRENT_SHA,previousManifestSha256=CACHE_PREVIOUS_SHA,
        servicesSha256=CACHE_SERVICES_SHA,containerImageIds=sorted(containers),
        inventorySha256=cache_sha(cache_canonical(inventory)),
        provenOldSourceCommitsSha256=cache_sha(cache_canonical(binding['provenOldSourceCommits'])),
        pendingCandidateCommit=binding['producer']['commit'],excludedCounts=excluded)
    cache_need(len(cache_canonical(plan)) <= 12000,'OUTPUT_BOUND')
    return plan


def cache_save_receipt(fd, guard, value, holder):
    guard.verify()
    info=os.fstat(fd); identity=storage_identity(info)
    cache_need(identity==holder['receiptIdentity']==storage_identity(os.stat(holder['receiptName'],dir_fd=holder['receiptParent'],follow_symlinks=False)) and info.st_nlink==1 and stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600,'STATE_CHANGED')
    raw = cache_canonical({'kind':'CACHE_RECOVERY_ITEM_RECEIPTS_V1','producer':value['producer'],
        'planSha256':value['planSha256'],'plan':value['plan'],'mutationAttempted':value['mutationAttempted'],
        'itemReceipts':value['itemReceipts'],'removedCount':value['removedCount']})
    cache_need(len(raw) < 24000,'OUTPUT_BOUND')
    cache_need(info.st_size+len(raw)+1 < 4*1024**2,'OUTPUT_BOUND')
    remaining = memoryview(raw+b'\n')
    while remaining:
        written = os.write(fd,remaining); cache_need(written > 0,'IO_FAILURE'); remaining = remaining[written:]
    os.fsync(fd)
    cache_need(storage_identity(os.fstat(fd))==holder['receiptIdentity']==storage_identity(os.stat(holder['receiptName'],dir_fd=holder['receiptParent'],follow_symlinks=False)),'STATE_CHANGED')
    os.lseek(fd,0,os.SEEK_SET); digest=hashlib.sha256()
    while True:
        part=os.read(fd,65536)
        if not part: break
        digest.update(part)
    return digest.hexdigest()


def cache_execute(binding, driver_factory):
    cache_binding(binding)
    value = {'kind':'CACHE_RECOVERY_RESULT_V1','version':1,'operation':binding['operation'],
        'mode':'PLAN_ONLY' if binding['operation']==CACHE_OPERATIONS[0] else 'APPLY_EXACT_APPROVED',
        'producer':binding['producer'],'sourceBinding':binding,'status':'FAILED','code':'IO_FAILURE','phase':'INPUT',
        'baseline':{'currentCommit':CACHE_BASELINE,'currentManifestSha256':CACHE_CURRENT_SHA,
            'previousCommit':CACHE_PREVIOUS,'previousManifestSha256':CACHE_PREVIOUS_SHA},
        'plan':None,'planSha256':None,'candidateCount':0,'candidateSizeBytesEstimateSum':0,
        'exclusiveBytesReclaimable':None,'freeBytesBefore':None,'freeBytesAfter':None,
        'guards':{**dict.fromkeys(('currentUnchanged','servicesUnchanged','dependenciesUnchanged',
            'containerImagesUnchanged','inventoryVerified','clientCleanupVerified','remoteRecoveryVerified'),False),
            'servicesBeforeSha256':None,'servicesAfterSha256':None},
        'mutationAttempted':False,'itemReceipts':[],'receiptSha256':None,'removedCount':0,
        'authority':False,'productionEligible':False,'cleanupEligible':False,'rawOutputSuppressed':True}
    deadline = time.monotonic()+570; guard = StorageGuard(deadline); temporary = None
    receipt = lock = None; original_read = globals()['read']; holder = {'allowedRemoval':None,'recovery':{}}
    try:
        cache_need(os.getuid()==os.geteuid()==0,'ROOT_REQUIRED'); value['phase']='BASELINE'; guard.open()
        cache_need(guard.manifests[0]['previousCommit']==CACHE_PREVIOUS and guard.previous_sha==CACHE_PREVIOUS_SHA,'BASELINE_INVALID')
        lock = os.open('.deploy.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=guard.base)
        info = os.fstat(lock); cache_need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not stat.S_IMODE(info.st_mode)&0o022,'BASELINE_INVALID')
        lock_identity = storage_identity(info)
        cache_need(lock_identity==storage_identity(os.stat('.deploy.lock',dir_fd=guard.base,follow_symlinks=False)),'STATE_CHANGED')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        receipt_parent=guard.base
        for name in ('maintenance','docker-cache-retention'):receipt_parent=guard.child(receipt_parent,name)
        import tempfile
        temporary = tempfile.TemporaryDirectory(prefix='cache-recovery-client-',dir=BASE/'.staging')
        client = Path(temporary.name); client.chmod(0o700)
        fd = os.open(client/'config.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try: cache_need(os.write(fd,b'{}\n')==3,'IO_FAILURE')
        finally: os.close(fd)
        driver = driver_factory(guard.current,client); native = driver.native
        def bounded_native(*args,timeout=30):
            guard.remaining(); return native(*args,timeout=min(30,max(1,int(deadline-time.monotonic()))))
        driver.native = bounded_native
        def bounded_read(*args):
            guard.remaining()
            if args[0]=='docker':
                allowed = args==('docker','ps','-a','-q') or args==('docker','image','ls','--no-trunc','--quiet')
                allowed |= len(args)==6 and args[:4]==('docker','image','inspect','--format') and args[4] in ('{{.Id}}',CACHE_IMAGE_FORMAT) and IMAGE_ID.fullmatch(args[5]) is not None
                allowed |= len(args)==5 and args[:3]==('docker','inspect','--format') and args[3]=='{{.Image}}' and re.fullmatch('[a-f0-9]{12,64}',args[4]) is not None
                allowed |= args==('docker','image','rm','--no-prune',holder['allowedRemoval']) and holder['allowedRemoval'] is not None
                cache_need(allowed,'INPUT_INVALID'); return driver.native(*args[1:])
            cache_need(args[:8]==('aws','ecr','batch-get-image','--region','ap-northeast-1','--repository-name','id-business-v2-release','--image-ids')
                and args[-2:]==('--output','json') and 0 < len(args[8:-2]) <= 100
                and all(x.startswith('imageTag=') and TAG.fullmatch(x[9:]) for x in args[8:-2]),'INPUT_INVALID')
            response = subprocess.run(list(args),env={'PATH':'/usr/local/bin:/usr/bin:/bin','LC_ALL':'C','AWS_PAGER':'','AWS_MAX_ATTEMPTS':'1'},
                stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(30,max(1,int(deadline-time.monotonic()))))
            cache_need(response.returncode==0,'RECOVERY_INVALID')
            remote = cache_closed(response.stdout,2*1024**2)
            cache_need(type(remote) is dict and not remote.get('failures') and type(remote.get('images')) is list,'RECOVERY_INVALID')
            expected = {x[9:] for x in args[8:-2]}; observed = {}
            for row in remote['images']:
                cache_need(type(row) is dict and type(row.get('imageId')) is dict and type(row.get('imageManifest')) is str,'RECOVERY_INVALID')
                tag, digest = row['imageId'].get('imageTag'), row['imageId'].get('imageDigest')
                manifest_raw = row['imageManifest'].encode(); image_manifest = cache_closed(manifest_raw,2*1024**2)
                cache_need(tag in expected and tag not in observed and type(digest) is str and IMAGE_ID.fullmatch(digest)
                    and cache_sha(manifest_raw)==digest[7:] and type(image_manifest) is dict,'RECOVERY_INVALID')
                config = image_manifest.get('config',{}).get('digest')
                cache_need(type(config) is str and IMAGE_ID.fullmatch(config),'RECOVERY_INVALID')
                observed[tag] = {'remoteImageId':config,'remoteManifestDigest':digest,'remoteManifestSha256':cache_sha(manifest_raw),'recoveryVerified':True}
            cache_need(set(observed)==expected,'RECOVERY_INVALID'); holder['recovery'].update(observed)
            return response.stdout.decode('utf-8')
        globals()['read'] = bounded_read
        value['phase']='SERVICES_BEFORE'
        before = driver.snapshot(guard.current); value['guards']['servicesBeforeSha256'] = before
        cache_need(before==CACHE_SERVICES_SHA,'SERVICES_CHANGED'); guard.verify()
        manifest, previous = current(CACHE_BASELINE)
        value['phase']='DEPENDENCIES'
        dependencies = collect_dependencies(manifest,previous); containers = active_images()
        cache_need(all(type(i) is str and IMAGE_ID.fullmatch(i) for i in containers),'INVENTORY_INVALID')
        value['phase']='INVENTORY'; inventory = cache_inventory(); value['phase']='RECOVERY'; plan = cache_plan(binding,manifest,previous,dependencies,containers,inventory,holder)
        value.update(plan=plan,planSha256=plan_digest(plan),candidateCount=len(plan['items']),
            candidateSizeBytesEstimateSum=sum({i['imageId']:i['sizeBytesEstimate'] for i in plan['items']}.values()),
            freeBytesBefore=shutil.disk_usage(BASE).free)
        value['phase']='PLAN_BINDING'
        guard.verify(); cache_need(current(CACHE_BASELINE)==(manifest,previous)
            and collect_dependencies(manifest,previous)==dependencies and active_images()==containers
            and cache_inventory()==inventory,'STATE_CHANGED')
        value['guards'].update(dependenciesUnchanged=True,containerImagesUnchanged=True,inventoryVerified=True,remoteRecoveryVerified=True)
        if binding['operation']==CACHE_OPERATIONS[1]:
            cache_need(value['planSha256']==binding['approvedPlanSha256'],'PLAN_CHANGED')
            worst = {**value,'itemReceipts':[{**{k:i[k] for k in ('tag','imageId')},'state':'FAILED_MUTATED_UNVERIFIED'} for i in plan['items']]}
            cache_need(len(cache_canonical(worst))<23500,'OUTPUT_BOUND')
            parent = receipt_parent
            name = 'cache-recovery-'+binding['producer']['workflowRunId']+'-'+binding['producer']['workflowRunAttempt']+'-'+value['planSha256']+'.json'
            parent_before=storage_identity(os.fstat(parent))
            receipt = os.open(name,os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
            parent_after=storage_identity(os.fstat(parent))
            cache_need(parent_after[:-1]==parent_before[:-1] and parent_after[-1]-parent_before[-1] in (0,1),'STATE_CHANGED')
            for index,node in enumerate(guard.nodes):
                if node[2]==parent:
                    cache_need(node[3]==parent_before and parent_after==storage_identity(os.stat(node[1],dir_fd=node[0],follow_symlinks=False)),'STATE_CHANGED')
                    guard.nodes[index]=(node[0],node[1],node[2],parent_after,node[4])
            holder['receiptParent'],holder['receiptName'],holder['receiptIdentity']=parent,name,storage_identity(os.fstat(receipt))
            os.fsync(parent); value['receiptSha256'] = cache_save_receipt(receipt,guard,value,holder)
            expected_inventory = {row['id']:row for row in inventory}
            for item in plan['items']:
                value['phase']='APPLY_GUARD'
                cache_need(lock_identity==storage_identity(os.fstat(lock))==storage_identity(os.stat('.deploy.lock',dir_fd=guard.base,follow_symlinks=False)),'STATE_CHANGED')
                guard.verify(); cache_need(driver.snapshot(guard.current)==before,'SERVICES_CHANGED')
                cache_need(current(CACHE_BASELINE)==(manifest,previous) and collect_dependencies(manifest,previous)==dependencies
                    and active_images()==containers,'STATE_CHANGED')
                fresh = cache_inventory(); cache_need({r['id']:r for r in fresh}==expected_inventory,'STATE_CHANGED')
                protected = protected_images(manifest,previous,containers,dependencies)
                allowed,_ = cache_filter_inventory(binding,fresh,protected)
                cache_need(item['imageId'] in {row['id'] for row in allowed},'STATE_CHANGED')
                value['phase']='APPLY_RECOVERY'
                cache_need(cache_recovery({**plan,'items':[item]},holder)[item['tag']]
                    == {k:item[k] for k in ('remoteImageId','remoteManifestDigest','remoteManifestSha256','recoveryVerified')},'RECOVERY_INVALID')
                value['phase']='APPLY_IMAGE'
                row = {'tag':item['tag'],'imageId':item['imageId'],'state':'ATTEMPTED'}
                value['itemReceipts'].append(row); value['mutationAttempted'] = True
                value['receiptSha256'] = cache_save_receipt(receipt,guard,value,holder)
                holder['allowedRemoval'] = REPOSITORY+':'+item['tag']
                try: read('docker','image','rm','--no-prune',holder['allowedRemoval'])
                except Exception:
                    row['state']='FAILED_MUTATED_UNVERIFIED'; raise
                finally: holder['allowedRemoval']=None
                row['state']='REMOVED'; value['removedCount'] += 1
                expected_inventory[item['imageId']]['repoTags'].remove(REPOSITORY+':'+item['tag'])
                actual_inventory={r['id']:r for r in cache_inventory()}
                if not expected_inventory[item['imageId']]['repoTags'] and item['imageId'] not in actual_inventory: del expected_inventory[item['imageId']]
                cache_need(actual_inventory==expected_inventory,'STATE_CHANGED')
                value['receiptSha256'] = cache_save_receipt(receipt,guard,value,holder)
            cache_need({row['id']:row for row in cache_inventory()}==expected_inventory,'STATE_CHANGED')
        value['phase']='SERVICES_AFTER'
        guard.verify(); after = driver.snapshot(guard.current); value['guards']['servicesAfterSha256'] = after
        cache_need(after==before and current(CACHE_BASELINE)==(manifest,previous)
            and collect_dependencies(manifest,previous)==dependencies and active_images()==containers,'STATE_CHANGED')
        guard.verify(); cache_need(lock_identity==storage_identity(os.fstat(lock))==storage_identity(os.stat('.deploy.lock',dir_fd=guard.base,follow_symlinks=False)),'STATE_CHANGED'); value['guards'].update(currentUnchanged=True,servicesUnchanged=True)
        value.update(status='PLANNED' if binding['operation']==CACHE_OPERATIONS[0] else 'APPLIED',code='OK',phase='COMPLETE',freeBytesAfter=shutil.disk_usage(BASE).free)
    except Exception as error:
        code = str(error) if type(error) is CacheRejected and str(error) in CACHE_CODES else (
            str(error) if type(error) is StorageRejected and str(error) in CACHE_CODES else
            {'BASELINE':'BASELINE_INVALID','SERVICES_BEFORE':'SERVICES_CHANGED','DEPENDENCIES':'DEPENDENCY_INVALID','INVENTORY':'INVENTORY_INVALID','RECOVERY':'RECOVERY_INVALID','PLAN_BINDING':'STATE_CHANGED','APPLY_GUARD':'STATE_CHANGED','APPLY_RECOVERY':'RECOVERY_INVALID','SERVICES_AFTER':'STATE_CHANGED'}.get(value['phase'],'IO_FAILURE'))
        value.update(status='FAILED_MUTATED_UNVERIFIED' if value['mutationAttempted'] else 'FAILED',code=code)
        if receipt is not None:
            try: value['receiptSha256']=cache_save_receipt(receipt,guard,value,holder)
            except Exception: pass
    finally:
        globals()['read'] = original_read
        try:
            for fd in (receipt,lock):
                if fd is not None: os.close(fd)
            guard.close()
            if temporary is not None: temporary.cleanup()
            value['guards']['clientCleanupVerified']=True
        except Exception: value.update(status='FAILED_MUTATED_UNVERIFIED' if value['mutationAttempted'] else 'FAILED',code='IO_FAILURE')
    if len(cache_canonical(value))>=24000:
        cache_need(not value['mutationAttempted'],'OUTPUT_BOUND')
        value.update(status='FAILED',code='OUTPUT_BOUND',plan=None,planSha256=None,candidateCount=0,candidateSizeBytesEstimateSum=0)
    return value


def validate_result(value,binding):
    cache_binding(binding)
    cache_need(type(value) is dict and set(value)==CACHE_RESULT_FIELDS and value['kind']=='CACHE_RECOVERY_RESULT_V1'
        and type(value['version']) is int and value['version']==1 and value['operation']==binding['operation']
        and value['mode']==('PLAN_ONLY' if binding['operation']==CACHE_OPERATIONS[0] else 'APPLY_EXACT_APPROVED')
        and value['producer']==binding['producer'] and value['sourceBinding']==binding and value['status'] in CACHE_STATUSES
        and value['phase'] in CACHE_PHASES and value['code'] in CACHE_CODES and (value['code']=='OK')==(value['status'] in ('PLANNED','APPLIED'))
        and value['authority'] is False and value['productionEligible'] is False and value['cleanupEligible'] is False
        and value['rawOutputSuppressed'] is True and value['exclusiveBytesReclaimable'] is None)
    cache_need(value['baseline']=={'currentCommit':CACHE_BASELINE,'currentManifestSha256':CACHE_CURRENT_SHA,
        'previousCommit':CACHE_PREVIOUS,'previousManifestSha256':CACHE_PREVIOUS_SHA})
    cache_need(type(value['mutationAttempted']) is bool and type(value['itemReceipts']) is list
        and all(type(value[k]) is int and 0<=value[k]<=2**63-1 for k in ('candidateCount','candidateSizeBytesEstimateSum','removedCount'))
        and all(value[k] is None or type(value[k]) is int and 0<=value[k]<=2**63-1 for k in ('freeBytesBefore','freeBytesAfter'))
        and (value['receiptSha256'] is None or type(value['receiptSha256']) is str and re.fullmatch('[a-f0-9]{64}',value['receiptSha256'])))
    if value['plan'] is None:
        cache_need(value['planSha256'] is None and value['candidateCount']==value['candidateSizeBytesEstimateSum']==value['removedCount']==0
            and not value['itemReceipts'] and not value['mutationAttempted'] and value['status']=='FAILED')
    else:
        plan=value['plan']; fields={'policy','expectedCurrent','expectedPrevious','repository','protectedImageIds','items','dependencies',
            'sourceCommit','sourceTree','sourcePinsSha256','currentManifestSha256','previousManifestSha256','servicesSha256',
            'containerImageIds','inventorySha256','provenOldSourceCommitsSha256','pendingCandidateCommit','excludedCounts'}
        cache_need(type(plan) is dict and set(plan)==fields and plan['policy']==POLICY and plan['expectedCurrent']==CACHE_BASELINE
            and plan['expectedPrevious']==CACHE_PREVIOUS and plan['repository']==REPOSITORY
            and plan['sourceCommit']==plan['pendingCandidateCommit']==binding['producer']['commit'] and plan['sourceTree']==binding['producer']['sourceTree']
            and plan['sourcePinsSha256']==cache_sha(cache_canonical(binding['sourcePins']))
            and plan['currentManifestSha256']==CACHE_CURRENT_SHA and plan['previousManifestSha256']==CACHE_PREVIOUS_SHA
            and plan['servicesSha256']==CACHE_SERVICES_SHA and type(plan['inventorySha256']) is str and re.fullmatch('[a-f0-9]{64}',plan['inventorySha256'])
            and plan['provenOldSourceCommitsSha256']==cache_sha(cache_canonical(binding['provenOldSourceCommits']))
            and type(plan['excludedCounts']) is dict and set(plan['excludedCounts'])==set(CACHE_EXCLUSIONS)
            and all(type(n) is int and 0<=n<=128 for n in plan['excludedCounts'].values()))
        for key in ('protectedImageIds','containerImageIds'):
            cache_need(type(plan[key]) is list and plan[key]==sorted(set(plan[key])) and len(plan[key])<=500
                and all(type(i) is str and IMAGE_ID.fullmatch(i) for i in plan[key]))
        deps=plan['dependencies']; cache_need(type(deps) is dict and set(deps)=={'version','imageIds','serviceRollback','evidenceSha256'}
            and type(deps['version']) is int and deps['version']==1 and type(deps['imageIds']) is list
            and deps['imageIds']==sorted(set(deps['imageIds'])) and all(type(i) is str and IMAGE_ID.fullmatch(i) for i in deps['imageIds'])
            and type(deps['serviceRollback']) is dict and set(deps['serviceRollback'])<=set(('api','admin','mysql','caddy','auto-recharge','auto-registration','media-resolver','migrate'))
            and type(deps['evidenceSha256']) is dict and len(deps['evidenceSha256'])<=500)
        for path,digest in deps['evidenceSha256'].items():
            cache_need(type(path) is str and not Path(path).is_absolute() and not set(Path(path).parts)&{'.','..'}
                and (path.startswith('releases/') or path==ORDER_ARCHIVE_SEAL_RELATIVE) and type(digest) is str and re.fullmatch('[a-f0-9]{64}',digest))
        for row in deps['serviceRollback'].values():
            cache_need(type(row) is dict and (row=={'status':'NO_EARLIER_SERVICE_VERSION'} or row=={'status':'NO_DISTINCT_PREDECESSOR'}
                or set(row)=={'status','commit','imageId'} and row['status']=='RETAINED' and type(row['commit']) is str
                and re.fullmatch('[a-f0-9]{40}',row['commit']) and type(row['imageId']) is str and IMAGE_ID.fullmatch(row['imageId'])))
        cache_need(set(plan['containerImageIds'])|set(deps['imageIds']) <= set(plan['protectedImageIds'])
            and all(row.get('status')!='RETAINED' or row['imageId'] in deps['imageIds'] for row in deps['serviceRollback'].values()))
        items=plan['items']; cache_need(type(items) is list and len(items)<=128 and value['candidateCount']==len(items)
            and items==sorted(items,key=lambda row:row['tag']) and len({row['tag'] for row in items})==len(items))
        for row in items:
            cache_need(type(row) is dict and set(row)=={'tag','imageId','sourceCommit','sizeBytesEstimate','remoteImageId','remoteManifestDigest','remoteManifestSha256','recoveryVerified'}
                and type(row['tag']) is str and TAG.fullmatch(row['tag']) and row['tag'][:40]==row['sourceCommit'] in binding['provenOldSourceCommits']
                and type(row['imageId']) is str and IMAGE_ID.fullmatch(row['imageId']) and row['remoteImageId']==row['imageId']
                and row['imageId'] not in plan['protectedImageIds'] and type(row['sizeBytesEstimate']) is int and 0<=row['sizeBytesEstimate']<=2**63-1
                and type(row['remoteManifestDigest']) is str and IMAGE_ID.fullmatch(row['remoteManifestDigest'])
                and row['remoteManifestSha256']==row['remoteManifestDigest'][7:] and row['recoveryVerified'] is True)
        cache_need(value['planSha256']==plan_digest(plan) and len(cache_canonical(plan))<=12000
            and value['candidateSizeBytesEstimateSum']==sum({i['imageId']:i['sizeBytesEstimate'] for i in items}.values()))
        expected={(i['tag'],i['imageId']) for i in items}; seen=set()
        for index,row in enumerate(value['itemReceipts']):
            cache_need(index<len(items) and (row.get('tag'),row.get('imageId'))==(items[index]['tag'],items[index]['imageId']))
            cache_need(type(row) is dict and set(row)=={'tag','imageId','state'} and (row['tag'],row['imageId']) in expected
                and row['tag'] not in seen and row['state'] in ('ATTEMPTED','REMOVED','FAILED_MUTATED_UNVERIFIED')); seen.add(row['tag'])
        cache_need(value['removedCount']==sum(row['state']=='REMOVED' for row in value['itemReceipts'])
            and value['mutationAttempted']==bool(value['itemReceipts']))
    guards=value['guards']; cache_need(type(guards) is dict and set(guards)=={'currentUnchanged','servicesUnchanged','dependenciesUnchanged',
        'containerImagesUnchanged','inventoryVerified','clientCleanupVerified','remoteRecoveryVerified','servicesBeforeSha256','servicesAfterSha256'}
        and all(type(v) is bool for k,v in guards.items() if not k.endswith('Sha256'))
        and all(guards[k] is None or type(guards[k]) is str and re.fullmatch('[a-f0-9]{64}',guards[k]) for k in ('servicesBeforeSha256','servicesAfterSha256')))
    if binding['operation']==CACHE_OPERATIONS[0]: cache_need(not value['mutationAttempted'] and value['status'] in ('PLANNED','FAILED') and value['receiptSha256'] is None)
    if value['status'] in ('PLANNED','APPLIED'):
        cache_need(value['phase']=='COMPLETE' and value['status']==('PLANNED' if binding['operation']==CACHE_OPERATIONS[0] else 'APPLIED'))
        cache_need(all(v is True for k,v in guards.items() if not k.endswith('Sha256'))
            and guards['servicesBeforeSha256']==guards['servicesAfterSha256']==CACHE_SERVICES_SHA and value['freeBytesBefore'] is not None and value['freeBytesAfter'] is not None)
        if value['status']=='APPLIED': cache_need(binding['operation']==CACHE_OPERATIONS[1] and value['planSha256']==binding['approvedPlanSha256'] and value['removedCount']==value['candidateCount'] and value['receiptSha256'] is not None)
    if value['status']=='FAILED_MUTATED_UNVERIFIED': cache_need(value['mutationAttempted'] and binding['operation']==CACHE_OPERATIONS[1])
    if value['status']=='FAILED': cache_need(not value['mutationAttempted'])
    cache_need(len(cache_canonical(value))<24000,'OUTPUT_BOUND'); return value


def validate_artifact(record,producer,binding):
    cache_producer(producer); cache_binding(binding)
    cache_need(type(record) is dict and set(record)==CACHE_ARTIFACT_FIELDS and record['kind']=='CACHE_RECOVERY_ARTIFACT_V1'
        and record['operation']==binding['operation'] and record['producer']==producer==binding['producer']
        and record['expectedCurrent']==CACHE_BASELINE and record['status'] in ('OPERATION_COMPLETED','OPERATION_FAILED'))
    uuid=lambda x:type(x) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',x)
    if record['result'] is None:
        cache_need(record['status']=='OPERATION_FAILED' and record['code']=='TRANSPORT_UNAVAILABLE' and (record['commandId'] is None or uuid(record['commandId'])))
    else:
        value=validate_result(record['result'],binding)
        cache_need(uuid(record['commandId']) and record['code']==value['code']
            and (record['status']=='OPERATION_COMPLETED')==(value['status'] in ('PLANNED','APPLIED')))
    cache_need(len(cache_canonical(record))<24000,'OUTPUT_BOUND'); return record



CACHE_STAGE_PREFIX = 'CACHE_SOURCE_SAFE '
CACHE_STAGE_ACK_FIELDS = {'kind','producer','frameSha256','index','partCount','partSha256','partBytes'}


def validate_stage_ack(value, expected):
    cache_need(type(expected) is dict and set(expected)==CACHE_STAGE_ACK_FIELDS and expected['kind']=='CACHE_SOURCE_STAGE_V1')
    cache_producer(expected['producer'])
    cache_need(type(expected['index']) is int and type(expected['partCount']) is int and 2<=expected['partCount']<=3
        and 0<=expected['index']<expected['partCount'] and type(expected['partBytes']) is int and 0<expected['partBytes']<=12000
        and all(type(expected[k]) is str and re.fullmatch('[a-f0-9]{64}',expected[k]) for k in ('frameSha256','partSha256')))
    cache_need(type(value) is dict and set(value)==CACHE_STAGE_ACK_FIELDS and cache_canonical(value)==cache_canonical(expected))
    return value


def cache_source_stage(spec, execute=None):
    """Only the producer's public compressed source; no credentials or business files."""
    fds,anchors,leaves=[],[],[]; created=False; result=None; cleaned=False
    identity=lambda info,leaf=False:(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink)+((info.st_size,info.st_mtime_ns,info.st_ctime_ns) if leaf else ())
    def require(ok):
        if not ok: raise RuntimeError('SOURCE_STAGE_REJECTED')
    def directory(parent,name,private=False):
        fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent);fds.append(fd);info=os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not stat.S_IMODE(info.st_mode)&0o022
            and (not private or stat.S_IMODE(info.st_mode)==0o700))
        seal=identity(info);require(seal==identity(os.stat(name,dir_fd=parent,follow_symlinks=False)))
        anchors.append((parent,name,fd,seal));return fd
    def verify():
        for parent,name,fd,seal in anchors:require(seal==identity(os.fstat(fd))==identity(os.stat(name,dir_fd=parent,follow_symlinks=False)))
    def read_part(parent,index):
        name='part-'+str(index);fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=parent);fds.append(fd)
        info=os.fstat(fd);seal=identity(info,True);expected=spec['parts'][index]
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600
            and info.st_size==expected['bytes'] and seal==identity(os.stat(name,dir_fd=parent,follow_symlinks=False),True))
        raw=os.read(fd,12001);require(len(raw)==expected['bytes'] and hashlib.sha256(raw).hexdigest()==expected['sha256']
            and seal==identity(os.fstat(fd),True)==identity(os.stat(name,dir_fd=parent,follow_symlinks=False),True))
        leaves.append((parent,name,fd,seal,expected));return raw
    try:
        require(os.getuid()==os.geteuid()==0)
        parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);fds.append(parent)
        for name in ('opt','id-business-v2','.staging'):parent=directory(parent,name)
        staging=parent;name='cache-recovery-'+spec['producer']['workflowRunId']+'-'+spec['producer']['workflowRunAttempt']+'-'+spec['frameSha256']
        if spec['index']==0:
            before=identity(os.fstat(staging));os.mkdir(name,0o700,dir_fd=staging);after=identity(os.fstat(staging))
            require(after[:-1]==before[:-1] and after[-1]==before[-1]+1)
            holder=anchors[-1];require(holder[2]==staging and holder[3]==before
                and after==identity(os.stat(holder[1],dir_fd=holder[0],follow_symlinks=False)))
            anchors[-1]=(holder[0],holder[1],holder[2],after)
        scratch=directory(staging,name,True);scratch_seal=identity(os.fstat(scratch))
        expected_names={'part-'+str(i) for i in range(spec['index'] if execute is None else len(spec['parts']))}
        require(set(os.listdir(scratch))==expected_names);verify()
        parts=[read_part(scratch,i) for i in range(len(expected_names))]
        if execute is None:
            raw=spec['fragment'].encode('ascii');expected=spec['parts'][spec['index']]
            require(len(raw)==expected['bytes'] and hashlib.sha256(raw).hexdigest()==expected['sha256'])
            fd=os.open('part-'+str(spec['index']),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=scratch);fds.append(fd)
            pending=memoryview(raw)
            while pending:
                count=os.write(fd,pending);require(count>0);pending=pending[count:]
            os.fsync(fd);os.fsync(scratch);read_part(scratch,spec['index'])
            after=identity(os.fstat(scratch));holder=anchors[-1]
            require(after[:-1]==holder[3][:-1] and after[-1]-holder[3][-1] in (0,1)
                and after==identity(os.stat(holder[1],dir_fd=holder[0],follow_symlinks=False)))
            anchors[-1]=(holder[0],holder[1],holder[2],after);verify()
            return spec['ack']
        require(len(parts)==len(spec['parts']));result=execute(b''.join(parts))
        return result,True
    finally:
        if execute is not None and result is not None:
            # Never unlink a replacement or unknown write. Keep all pieces on any drift.
            try:
                verify();require(set(os.listdir(scratch))=={'part-'+str(i) for i in range(len(spec['parts']))})
                for parent,name,fd,seal,expected in leaves:
                    require(seal==identity(os.fstat(fd),True)==identity(os.stat(name,dir_fd=parent,follow_symlinks=False),True))
                    os.lseek(fd,0,os.SEEK_SET);raw=os.read(fd,12001)
                    require(len(raw)==expected['bytes'] and hashlib.sha256(raw).hexdigest()==expected['sha256']
                        and seal==identity(os.fstat(fd),True)==identity(os.stat(name,dir_fd=parent,follow_symlinks=False),True))
                for parent,name,fd,seal,expected in leaves:
                    require(seal==identity(os.fstat(fd),True)==identity(os.stat(name,dir_fd=parent,follow_symlinks=False),True))
                    os.unlink(name,dir_fd=parent)
                os.fsync(scratch)
                after=identity(os.fstat(scratch))
                require(after[:-1]==scratch_seal[:-1] and scratch_seal[-1]-after[-1] in (0,len(leaves))
                    and after==identity(os.stat(anchors[-1][1],dir_fd=staging,follow_symlinks=False)))
                os.rmdir(anchors[-1][1],dir_fd=staging);os.fsync(staging);cleaned=True
            except Exception:pass
            if not cleaned:
                result['guards']['clientCleanupVerified']=False
                result.update(status='FAILED_MUTATED_UNVERIFIED' if result['mutationAttempted'] else 'FAILED',code='IO_FAILURE')
        for fd in reversed(fds):
            try:os.close(fd)
            except OSError:pass


def parameters(producer, *, source=None, expected_current=CACHE_BASELINE,
               operation='verify_unused_cache', approved_plan_sha256=None):
    import base64,lzma,shlex,types
    cache_producer(producer); cache_need(expected_current==CACHE_BASELINE and operation in CACHE_OPERATIONS)
    project=Path(source) if source is not None else Path(__file__).resolve().parents[2]
    def git(*args):
        response=subprocess.run(['git',*args],cwd=project,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30)
        cache_need(response.returncode==0 and len(response.stdout)<65536); return response.stdout.decode().strip()
    cache_need(git('rev-parse',producer['commit']+'^{tree}')==producer['sourceTree'])
    ancestry=git('rev-list','--max-count=129',CACHE_BASELINE).splitlines()
    commits=sorted(set(ancestry)-{CACHE_BASELINE,CACHE_PREVIOUS,producer['commit']})
    raw={path:(project/path).read_bytes() for path in CACHE_PINS}
    binding={'producer':producer,'expectedCurrent':expected_current,'operation':operation,'approvedPlanSha256':approved_plan_sha256,
        'sourcePins':{path:{'bytes':len(data),'sha256':cache_sha(data)} for path,data in raw.items()},
        'provenOldSourceCommits':commits,'capturedProgramBytes':1,'capturedProgramSha256':'0'*64}; cache_binding(binding)
    for path,data in raw.items():
        response=subprocess.run(['git','show',producer['commit']+':'+path],cwd=project,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30)
        cache_need(response.returncode==0 and response.stdout==data,'STATE_CHANGED')
    module=types.ModuleType('cache_storage_support');module.__file__=str(project/CACHE_PINS[2])
    exec(compile(raw[CACHE_PINS[2]],module.__file__,'exec'),module.__dict__)
    snapshot=raw[CACHE_PINS[3]]; snapshot_text=snapshot.decode()
    snapshot_header='import hashlib,json,os,re,subprocess,types\nfrom pathlib import Path\n'
    for name in ('BASELINE','DOCKER','SOCKET','ROLES','SERVICE_FIELDS','SNAPSHOT_FIELDS','SNAPSHOT_STAGES','SNAPSHOT_CODES','PUBLIC_LABEL_FORMAT'):
        node=next(n for n in ast.parse(snapshot).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
        snapshot_header+=ast.get_source_segment(snapshot_text,node)+'\n'
    snapshot_header+="BASE=Path('/opt/id-business-v2')\nHEX=re.compile(r'[a-f0-9]{64}\\Z')\n"
    modules={
        'snapshot':snapshot_header+module.storage_selected(snapshot,('need','sha','canonical','closed_json','snapshot_validate','snapshot_state','NativeSnapshotDriver')),
        'online':'import hashlib,json,re\n'+module.storage_selected(raw[CACHE_PINS[4]],('fingerprint','legacy','snapshot')),
        'workspace':"import hashlib,json\nWORKSPACE=True\nCONFIG_FILES=('docker-compose.aws-mysql.yml',)\nONLINE_SERVICE='online-recharge'\n"+module.storage_selected(raw[CACHE_PINS[5]],('fingerprint','workspace_service_names','snapshot')),
        'remote':'import hashlib,json,re\n'+module.storage_selected(raw[CACHE_PINS[6]],('require','historical_fingerprint','service_state'))}
    header='import ast,fcntl,hashlib,json,os,re,shutil,stat,subprocess,time,types\nfrom pathlib import Path\n'
    own=raw[CACHE_PINS[1]].decode(); storage=raw[CACHE_PINS[2]].decode()
    constants=('BASE','REPOSITORY','POLICY','IMAGE_ID','TAG','FIXED_REGISTRATION_IDS','FIXED_RECHARGE_IDS','ORDER_ARCHIVE_SEAL_RELATIVE')
    for node in ast.parse(own).body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and (t.id in constants or t.id.startswith('CACHE_') and t.id not in ('CACHE_RESULT_FIELDS','CACHE_ARTIFACT_FIELDS')) for t in node.targets): header+=ast.get_source_segment(own,node)+'\n'
    for node in ast.parse(storage).body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('STORAGE_BASELINE','STORAGE_CURRENT_SHA','STORAGE_COMPOSE_SHA') for t in node.targets): header+=ast.get_source_segment(storage,node)+'\n'
    old_names=('require','current','active_images','protected_images','dependency_file','release_metadata','literal_dependency',
        'fixed_dependencies','collect_dependencies','make_plan','plan_digest','verify_remote')
    new_names=('CacheRejected','cache_need','cache_sha','cache_canonical','cache_closed','cache_producer','cache_binding','cache_inventory',
        'cache_filter_inventory','cache_recovery','cache_plan','cache_save_receipt','cache_execute')
    selected=module.storage_selected(raw[CACHE_PINS[1]],old_names+new_names)
    body=header+selected
    body+=module.storage_selected(raw[CACHE_PINS[2]],('StorageRejected','storage_need','storage_sha','storage_identity','StorageGuard'))
    body+='loaded={}\nfor name,raw in MODULES.items():\n m=types.ModuleType(name);exec(compile(raw,"<cache-snapshot>","exec"),m.__dict__);loaded[name]=m\n'
    body+='def read(*unused):\n raise CacheRejected("INPUT_INVALID")\ndef factory(directory,client):\n return loaded["snapshot"].NativeSnapshotDriver(directory,client,loaded["online"],loaded["workspace"],loaded["remote"])\n'
    body+='VALUE=cache_execute(BINDING,factory)\n'
    captured=cache_canonical({'program':body,'modules':modules}); binding.update(capturedProgramBytes=len(captured),capturedProgramSha256=cache_sha(captured)); cache_binding(binding)
    frame=cache_canonical({'binding':binding,'program':body,'modules':modules}); compressed=base64.b85encode(lzma.compress(frame,filters=[{'id':lzma.FILTER_LZMA2,'preset':9|lzma.PRESET_EXTREME,'dict_size':1048576}])).decode()
    # Each public-source request is bounded separately; only final execute may touch images.
    chunks=[compressed[start:start+11000] for start in range(0,len(compressed),11000)]
    cache_need(2<=len(chunks)<=3 and len(frame)<=262144,'OUTPUT_BOUND')
    parts=[{'bytes':len(chunk),'sha256':cache_sha(chunk.encode())} for chunk in chunks]
    stage_source=module.storage_selected(raw[CACHE_PINS[1]],('cache_source_stage',))
    stage_header='import hashlib,json,os,stat\n'
    bundle={'stages':[],'execute':None}
    for index,chunk in enumerate(chunks):
        ack={'kind':'CACHE_SOURCE_STAGE_V1','producer':producer,'frameSha256':cache_sha(frame),
            'index':index,'partCount':len(chunks),'partSha256':parts[index]['sha256'],'partBytes':parts[index]['bytes']}
        spec={'producer':producer,'frameSha256':cache_sha(frame),'index':index,'parts':parts,'fragment':chunk,'ack':ack}
        program=stage_header+stage_source+'\nSPEC='+repr(spec)+'\ntry:\n ack=cache_source_stage(SPEC);print("CACHE_SOURCE_SAFE "+json.dumps(ack,sort_keys=True,separators=(",",":")))\nexcept Exception:\n print("CACHE_SOURCE_SAFE "+json.dumps(dict(kind="CACHE_SOURCE_STAGE_FAILURE_V1",code="SOURCE_STAGE_REJECTED"),separators=(",",":")));raise SystemExit(1)\n'
        payload={'commands':['set -eu','umask 077','python3 -c '+shlex.quote(program)],'executionTimeout':['30']}
        cache_need(len(cache_canonical(payload))<20480,'OUTPUT_BOUND');bundle['stages'].append({'parameters':payload,'ack':ack})
    spec={'producer':producer,'frameSha256':cache_sha(frame),'index':None,'parts':parts}
    final=stage_header+'import base64,lzma\n'+stage_source+'\nSPEC='+repr(spec)+'\n'
    final+='def execute(encoded):\n d=lzma.LZMADecompressor(memlimit=32*1024**2);r=d.decompress(base64.b85decode(encoded),max_length=262145)\n assert 0<len(r)<=262144 and d.eof and not d.unused_data and hashlib.sha256(r).hexdigest()==SPEC["frameSha256"]\n f=json.loads(r);assert set(f)=={"binding","program","modules"}\n p=json.dumps({"program":f["program"],"modules":f["modules"]},sort_keys=True,separators=(",",":"),allow_nan=False).encode()\n assert len(p)==f["binding"]["capturedProgramBytes"] and hashlib.sha256(p).hexdigest()==f["binding"]["capturedProgramSha256"]\n namespace={"BINDING":f["binding"],"MODULES":f["modules"]};exec(compile(f["program"],"<cache-recovery>","exec"),namespace);return namespace["VALUE"]\n'
    final+='try:\n value,_=cache_source_stage(SPEC,execute);print("CACHE_RECOVERY_SAFE "+json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False));raise SystemExit(0 if value["status"] in ("PLANNED","APPLIED") else 1)\nexcept Exception:\n print("CACHE_SOURCE_SAFE "+json.dumps(dict(kind="CACHE_SOURCE_STAGE_FAILURE_V1",code="SOURCE_STAGE_REJECTED"),separators=(",",":")));raise SystemExit(1)\n'
    bundle['execute']={'commands':['set -eu','umask 077','python3 -c '+shlex.quote(final)],'executionTimeout':['600']}
    cache_need(len(cache_canonical(bundle['execute']))<20480,'OUTPUT_BOUND');return bundle,binding


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
