"""Reviewed disk policy; reuse exact ECR recovery and existing release protections."""
import argparse
import base64
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
from types import SimpleNamespace

BASE = Path('/opt/id-business-v2')
INSTALL = BASE / 'maintenance/disk-retention'
KIND = 'ID_DISK_RETENTION_POLICY_V1'
BATCH = re.compile(r'[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*')
RELEASE_TAG = re.compile(r'([a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*)-(admin|api|migrate|media-resolver|auto-recharge|online-recharge)')
POLICY_FIELDS = {'kind', 'version', 'approved', 'sourceSha256', 'maintainerSha256', 'candidateRegistrySha256',
                 'protectedCandidateBatches', 'supersededOnlineBatches', 'budgets'}
BUDGET_FIELDS = {'targetFreeBytes', 'cleanupThresholdBytes', 'criticalFreeBytes',
                 'projectArtifactsBytes', 'localBackupsBytes', 'systemLogsBytes'}


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def closed_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'DUPLICATE_JSON_KEY')
            value[key] = item
        return value
    def constant(unused):
        raise RuntimeError('INVALID_JSON_CONSTANT')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    allow_nan=False).encode()).hexdigest()


def validate_policy(value):
    require(type(value) is dict and set(value) == POLICY_FIELDS, 'POLICY_FIELDS')
    require(value['kind'] == KIND and type(value['version']) is int and value['version'] == 1
            and type(value['approved']) is bool, 'POLICY_IDENTITY')
    for key in ('sourceSha256', 'maintainerSha256', 'candidateRegistrySha256'):
        require(type(value[key]) is str and re.fullmatch('[a-f0-9]{64}', value[key]), 'POLICY_SOURCE')
    for key, maximum in (('protectedCandidateBatches', 1), ('supersededOnlineBatches', 100)):
        items = value[key]
        require(type(items) is list and len(items) <= maximum
                and all(type(x) is str and BATCH.fullmatch(x) for x in items)
                and len(set(items)) == len(items), 'POLICY_BATCHES')
    require(not set(value['protectedCandidateBatches']) & set(value['supersededOnlineBatches']),
            'POLICY_BATCH_OVERLAP')
    budgets = value['budgets']
    require(type(budgets) is dict and set(budgets) == BUDGET_FIELDS
            and all(type(x) is int and 0 < x <= 64 * 1024**3 for x in budgets.values()), 'POLICY_BUDGETS')
    require(budgets['criticalFreeBytes'] < budgets['cleanupThresholdBytes'] < budgets['targetFreeBytes'],
            'POLICY_FREE_SPACE_ORDER')
    return value


def policy_digest(policy):
    # Approval activates already reviewed rules; it does not change their identity.
    return digest({k: v for k, v in validate_policy(policy).items() if k != 'approved'})


def read_private(path, maximum=2 * 1024 * 1024, *, exact_mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                and not before.st_mode & 0o022 and 0 < before.st_size <= maximum, 'PRIVATE_FILE_IDENTITY')
        require(exact_mode is None or stat.S_IMODE(before.st_mode) == exact_mode, 'PRIVATE_FILE_MODE')
        raw = stream.read(maximum + 1)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(stream.fileno()))
                == identity(Path(path).lstat()), 'PRIVATE_FILE_CHANGED')
    return raw


def load_helper(policy):
    path = Path(__file__).resolve().parent / 'maintain-image-cache.py'
    raw = read_private(path)
    require(hashlib.sha256(raw).hexdigest() == policy['maintainerSha256'], 'MAINTAINER_SOURCE_CHANGED')
    scope = {'__name__': 'reviewed_disk_maintainer', '__file__': str(path)}
    exec(compile(raw, str(path), 'exec'), scope)
    return SimpleNamespace(**scope)


def load_registry_module(policy):
    path = INSTALL / 'candidate-retention.py'
    raw = read_private(path, exact_mode=0o600)
    require(hashlib.sha256(raw).hexdigest() == policy['candidateRegistrySha256'], 'REGISTRY_SOURCE_CHANGED')
    scope = {'__name__': 'reviewed_candidate_registry', '__file__': str(path)}
    exec(compile(raw, str(path), 'exec'), scope)
    return SimpleNamespace(**scope)


def candidate_state(policy, module):
    path = INSTALL / 'candidates.json'
    state = module.read_registry(path, deployment_lock_held=True) if path.exists() else module.new_registry(policy_digest(policy))
    require(state['policySha256'] == policy_digest(policy), 'REGISTRY_POLICY_CHANGED')
    return state


def effective_state(state):
    if state is None:
        return [], set(), None
    pending = [value['record'] for value in state['batches'].values()
               if value['status'] == 'pending' or value['record']['batch'] in state['frozen']]
    retired = {value['record']['batch'] for value in state['batches'].values()
               if value['status'] == 'retired' and value['record']['batch'] not in state['frozen']}
    return pending, retired, digest(state)


def inventory(helper):
    ids = sorted(set(helper.read('docker', 'image', 'ls', '--no-trunc', '--quiet').splitlines()))
    require(len(ids) <= 500, 'INVENTORY_BOUND')
    fmt = '{"id":{{json .Id}},"repoTags":{{json .RepoTags}},"sizeBytes":{{json .Size}}}'
    return [closed_json(helper.read('docker', 'image', 'inspect', '--format', fmt, image_id)) for image_id in ids]


def plan(policy, helper, expected, rows=None, state=None):
    validate_policy(policy)
    manifest, previous = helper.current(expected)
    dependencies = helper.collect_dependencies(manifest, previous)
    if (previous.get('onlineRechargePublication') is not None
            or previous.get('preservedOnlineRechargeOrigin') is not None
            or previous.get('commit') == '31d2c6885a45817cd40d23fce8d6145bc9f18af2'):
        evidence = dict(dependencies['evidenceSha256'])
        extra = helper.historical_online_cold_dependencies(Path(manifest['previousRelease']), previous, evidence)
        dependencies = {**dependencies, 'imageIds': sorted(set(dependencies['imageIds']) | extra),
                        'evidenceSha256': dict(sorted(evidence.items()))}
    protected = helper.protected_images(manifest, previous, helper.active_images(), dependencies)
    rows = inventory(helper) if rows is None else rows
    require(len(rows) <= 500, 'INVENTORY_BOUND')
    current_run = re.fullmatch(r'github-actions-([1-9][0-9]*)-([1-9][0-9]*)', manifest.get('deploymentRun', ''))
    require(current_run is not None, 'CURRENT_PRODUCER_MISSING')
    current_order = tuple(map(int, current_run.groups()))
    keep = set(policy['protectedCandidateBatches'])
    pending, registered_retired, registry_sha = effective_state(state)
    retired = set(policy['supersededOnlineBatches']) | registered_retired
    pending_ids = {image['imageId'] for record in pending for image in record['images'].values()}
    protected |= pending_ids
    known = set()
    batch_services = {}
    reasons = {}
    for row in rows:
        image_id = row['id']
        require(type(image_id) is str and re.fullmatch('sha256:[a-f0-9]{64}', image_id), 'IMAGE_IDENTITY')
        tags = row.get('repoTags') or []
        matches = [RELEASE_TAG.fullmatch(tag[len(helper.REPOSITORY) + 1:])
                   if type(tag) is str and tag.startswith(helper.REPOSITORY + ':') else None for tag in tags]
        if not tags or any(match is None for match in matches):
            protected.add(image_id); reasons[image_id] = 'UNKNOWN_OR_MIXED_ALIAS'
            continue
        for match in matches:
            batch, service = match.groups(); known.add(batch)
            batch_services.setdefault(batch, set()).add(service)
            order = tuple(map(int, batch.rsplit('-', 2)[1:]))
            if batch in keep:
                protected.add(image_id); reasons[image_id] = 'REVIEWED_PENDING_BATCH'
            elif image_id in pending_ids:
                protected.add(image_id); reasons[image_id] = 'REGISTERED_PENDING_OR_FROZEN'
            elif order > current_order and batch not in registered_retired:
                protected.add(image_id); reasons[image_id] = 'NEWER_UNCONFIRMED_BUILD'
            elif service == 'online-recharge' and batch not in retired:
                protected.add(image_id); reasons[image_id] = 'ONLINE_BATCH_NOT_REVIEWED_SUPERSEDED'
    require(keep <= known, 'PENDING_BATCH_NOT_AVAILABLE')
    require(all({'admin', 'api', 'migrate', 'online-recharge'} <= batch_services[batch] for batch in keep),
            'PENDING_BATCH_NOT_COMPLETE')
    core = helper.make_plan(expected, previous, protected, rows, dependencies)
    # The legacy maintainer's fixed historical transports retain their original grammar.
    # This reviewed policy adds online-recharge only for explicitly superseded batches.
    for row in rows:
        if row['id'] in protected:
            continue
        for reference in row.get('repoTags') or []:
            tag = reference[len(helper.REPOSITORY) + 1:]
            match = RELEASE_TAG.fullmatch(tag)
            if match and match[2] == 'online-recharge' and match[1] in retired:
                item = {'tag': tag, 'imageId': row['id']}
                if item not in core['items']:
                    core['items'].append(item)
    core['items'].sort(key=lambda x: x['tag'])
    require(len(core['items']) <= 500 and len({x['tag'] for x in core['items']}) == len(core['items']), 'PLAN_BOUND')
    return {'kind': 'ID_DISK_RETENTION_PLAN_V1', 'policySha256': policy_digest(policy),
            'registrySha256': registry_sha,
            'currentCommit': expected, 'currentManifestSha256': manifest_digest(expected),
            'corePlan': core, 'candidateCount': len(core['items']),
            'additionalProtection': dict(sorted(reasons.items()))}


def manifest_digest(expected):
    raw = read_private(BASE / 'current/release-manifest.json', 128 * 1024)
    require(closed_json(raw).get('commit') == expected, 'CURRENT_CHANGED')
    return hashlib.sha256(raw).hexdigest()


def apply(policy, helper, reviewed, approved_digest, *, removed=None, checkpoint=None, guard=None, state_reader=None):
    require(policy['approved'] and digest(reviewed) == approved_digest, 'PLAN_NOT_APPROVED')
    expected = reviewed['currentCommit']
    read_state = state_reader or (lambda: None)
    require(plan(policy, helper, expected, state=read_state()) == reviewed, 'PLAN_CHANGED')
    helper.verify_remote(reviewed['corePlan'])
    removed = [] if removed is None else removed
    for item in reviewed['corePlan']['items']:
        if guard:
            guard()
        fresh = plan(policy, helper, expected, state=read_state())
        require(fresh['policySha256'] == reviewed['policySha256']
                and fresh['currentManifestSha256'] == reviewed['currentManifestSha256']
                and fresh['registrySha256'] == reviewed['registrySha256']
                and fresh['corePlan']['dependencies'] == reviewed['corePlan']['dependencies']
                and fresh['corePlan']['protectedImageIds'] == reviewed['corePlan']['protectedImageIds']
                and fresh['additionalProtection'] == reviewed['additionalProtection']
                and fresh['corePlan']['items'] == [x for x in reviewed['corePlan']['items'] if x['tag'] not in removed],
                'STATE_CHANGED_DURING_APPLY')
        require(item['imageId'] not in fresh['corePlan']['protectedImageIds'], 'IMAGE_BECAME_PROTECTED')
        helper.verify_remote({**fresh['corePlan'], 'items': [item]})
        reference = helper.REPOSITORY + ':' + item['tag']
        require(helper.read('docker', 'image', 'inspect', '--format', '{{.Id}}', reference) == item['imageId'],
                'IMAGE_CHANGED')
        if checkpoint:
            checkpoint(item, 'ATTEMPTED_RESULT_UNCONFIRMED')
        helper.read('docker', 'image', 'rm', '--no-prune', reference)
        removed.append(item['tag'])
        if checkpoint:
            checkpoint(item, 'REMOVED')
    require(manifest_digest(expected) == reviewed['currentManifestSha256'], 'CURRENT_CHANGED_AFTER_APPLY')
    return removed


def write_receipt(path, value):
    flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'w') as stream:
        info = os.fstat(stream.fileno())
        observed = (info.st_dev, info.st_ino)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
                and not info.st_mode & 0o077, 'RECEIPT_CHANGED')
        json.dump(value, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return observed


def usage(path):
    if not path.exists():
        return None
    p = subprocess.run(['du', '-x', '-s', '-B1', '--', str(path)], capture_output=True, text=True, timeout=60)
    require(p.returncode == 0 and re.fullmatch(r'[0-9]+\s+[^\n]+\n?', p.stdout), 'USAGE_UNAVAILABLE')
    return int(p.stdout.split()[0])


def container_snapshot(helper):
    ids = helper.read('docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}').splitlines()
    require(len(ids) <= 500 and len(set(ids)) == len(ids)
            and all(re.fullmatch('[a-f0-9]{64}', x) for x in ids), 'CONTAINER_SNAPSHOT_INVALID')
    return digest(sorted(ids))


def free_space_status(free, budgets):
    if free < budgets['criticalFreeBytes']:
        return 'CRITICAL'
    if free < budgets['cleanupThresholdBytes']:
        return 'LOW'
    return 'OK' if free >= budgets['targetFreeBytes'] else 'BELOW_TARGET'


def verify_record_remote(helper, record):
    helper.verify_remote({'items': [{'tag': image['reference'].split(':', 1)[1], 'imageId': image['imageId']}
                                   for image in record['images'].values()]})


def capacity_requirement(record, rows, source_bytes):
    require(type(source_bytes) is int and 0 < source_bytes <= 256 * 1024**2, 'SOURCE_SIZE_INVALID')
    available = {row['id'] for row in rows}
    missing = {}
    for image in record['images'].values():
        if image['imageId'] not in available:
            prior = missing.get(image['imageId'])
            require(prior is None or (prior['sizeBytes'], prior['compressedBytes'])
                    == (image['sizeBytes'], image['compressedBytes']), 'IMAGE_MEASUREMENT_CHANGED')
            missing[image['imageId']] = image
    # Do not assume layer sharing. Retain room for unpacked layers, compressed
    # pull files, source/staging transport and the existing 2 GiB final gate.
    return sum(image['sizeBytes'] + image['compressedBytes'] for image in missing.values()) + source_bytes * 3 + 2 * 1024**3


def register_event(policy, helper, module, state, event):
    require(type(event) is dict and set(event) == {'record', 'supersedes', 'sourceArchiveBytes'}, 'EVENT_FIELDS')
    record = module.validate_record(event['record'])
    capacity_requirement(record, [], event['sourceArchiveBytes'])
    # A policy seed remains protected; the caller cannot manufacture a seed
    # replacement by supplying an unaudited producer/Quality identity.
    require(type(event['supersedes']) is list
            and all(type(x) is dict and x.get('basis') == 'pending' for x in event['supersedes']), 'SEED_REPLACEMENT_FORBIDDEN')
    verify_record_remote(helper, record)
    updated = module.register(state, record, event['supersedes'])
    module.write_registry(INSTALL / 'candidates.json', updated, deployment_lock_held=True)
    return updated


def publication_event(helper, module, state, event):
    require(type(event) is dict and set(event) == {'record'}, 'EVENT_FIELDS')
    record = module.validate_record(event['record'])
    producer = record['producer']
    manifest, unused = helper.current(producer['commit'])
    require(manifest.get('sourceTree') == producer['sourceTree']
            and str(manifest.get('ciWorkflowRunId')) == record['qualityRunId']
            and manifest.get('deploymentRun') == 'github-actions-' + producer['workflowRunId'] + '-' + producer['workflowRunAttempt'],
            'PUBLICATION_PRODUCER_CHANGED')
    running = helper.read('docker', 'ps', '--no-trunc', '--quiet').splitlines()
    require(len(running) <= 500 and all(re.fullmatch('[a-f0-9]{64}', x) for x in running), 'RUNNING_CONTAINERS_INVALID')
    running_ids = {helper.read('docker', 'inspect', '--format', '{{.Image}}', value) for value in running}
    for role, image in record['images'].items():
        observed = manifest['images'].get(role, {})
        require(observed.get('digest') == image['imageId'] and observed.get('reference') == image['reference'],
                'PUBLICATION_IMAGE_CHANGED')
        require(role == 'migrate' or image['imageId'] in running_ids, 'PUBLISHED_SERVICE_NOT_RUNNING')
    verify_record_remote(helper, record)
    proof = {'kind': module.PUBLICATION_KIND, 'version': 1, 'commit': producer['commit'],
             'workflowRunId': producer['workflowRunId'], 'workflowRunAttempt': producer['workflowRunAttempt'],
             'candidateProofSha256': record['proofSha256'], 'currentManifestSha256': manifest_digest(producer['commit']),
             'images': {role: image['imageId'] for role, image in record['images'].items()}}
    updated = module.publish(state, record['batch'], proof)
    module.write_registry(INSTALL / 'candidates.json', updated, deployment_lock_held=True)
    return updated


def compact_registry(module, state, rows):
    ids = {row['id'] for row in rows}
    absence = []
    for batch, item in state['batches'].items():
        record = item['record']; images = {image['imageId'] for image in record['images'].values()}
        if item['status'] == 'retired' and batch not in state['frozen'] and images.isdisjoint(ids):
            absence.append({'kind': module.ABSENCE_KIND, 'version': 1, 'batch': batch,
                            'recordSha256': module.record_sha256(record), 'snapshotSha256': digest(rows),
                            'absentImageIds': sorted(images)})
    if absence:
        state = module.compact_retired(state, absence)
        module.write_registry(INSTALL / 'candidates.json', state, deployment_lock_held=True)
    return state


def validate_cli_selection(args, event):
    """Keep explicit plan approval separate from daily and release lifecycle runs."""
    require(type(args.scheduled) is bool and type(args.apply) is bool
            and args.phase in (None, 'before-build', 'before-pull', 'after-publish'), 'MODE_SELECTION_INVALID')
    require(not (args.scheduled and args.apply), 'MODE_SELECTION_INVALID')
    require(args.phase is None or (not args.scheduled and not args.apply), 'PHASE_SELECTION_INVALID')
    if args.apply:
        require(type(args.approved_plan_sha256) is str
                and re.fullmatch('[a-f0-9]{64}', args.approved_plan_sha256), 'PLAN_APPROVAL_REQUIRED')
    else:
        require(args.approved_plan_sha256 is None, 'UNEXPECTED_PLAN_APPROVAL')
    if args.event_base64 is not None:
        require(type(args.event_base64) is str and 0 < len(args.event_base64) <= 24000
                and args.phase is not None, 'EVENT_SIZE_INVALID')
    if args.phase in ('before-pull', 'after-publish'):
        require(args.event_base64 is not None and type(event) is dict and bool(event), 'EVENT_SELECTION_INVALID')
    else:
        # before-build accepts the transport's encoded JSON null, not an event.
        require(event is None, 'EVENT_SELECTION_INVALID')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--expected-current')
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--scheduled', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--phase', choices=('before-build', 'before-pull', 'after-publish'))
    parser.add_argument('--event-base64')
    args = parser.parse_args()
    event = None
    if args.event_base64 is not None:
        require(type(args.event_base64) is str and 0 < len(args.event_base64) <= 24000
                and args.phase is not None, 'EVENT_SIZE_INVALID')
        event = closed_json(base64.b64decode(args.event_base64, validate=True))
    validate_cli_selection(args, event)
    require(os.geteuid() == 0 and args.config == INSTALL / 'config.json'
            and Path(__file__).resolve() == INSTALL / 'disk-retention.py', 'INSTALLED_SCOPE_REQUIRED')
    source = read_private(Path(__file__).resolve())
    require(hashlib.sha256(source).hexdigest() == args.expected_source_sha256, 'NATIVE_SOURCE_CHANGED')
    config_raw = read_private(args.config, 24000, exact_mode=0o600)
    policy = validate_policy(closed_json(config_raw))
    require(policy['approved'] and policy['sourceSha256'] == args.expected_source_sha256, 'POLICY_NOT_INSTALLED_APPROVED')
    helper = load_helper(policy)
    registry_module = load_registry_module(policy)
    result = {'status': 'FAILED', 'removed': [], 'planSha256': None, 'errorCode': None}
    lock_path = BASE / '.deploy.lock'
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'r') as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and not info.st_mode & 0o022
                and (info.st_dev, info.st_ino) == (lock_path.lstat().st_dev, lock_path.lstat().st_ino), 'DEPLOY_LOCK_IDENTITY')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'SKIPPED_RELEASE_BUSY', 'removed': []})); return
        expected = closed_json(read_private(BASE / 'current/release-manifest.json', 128 * 1024))['commit']
        require(args.expected_current is None or args.expected_current == expected, 'CURRENT_CHANGED')
        receipt_dir = INSTALL / 'receipts'
        receipt_dir.mkdir(mode=0o700, exist_ok=True)
        require(receipt_dir.resolve() == receipt_dir and not receipt_dir.is_symlink(), 'RECEIPT_PATH_CHANGED')
        prefix = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + str(time.time_ns())
        receipt = receipt_dir / (prefix + '.plan.json')
        checkpoint_count = 0
        try:
            containers_before = container_snapshot(helper)
            state = candidate_state(policy, registry_module)
            if args.phase == 'before-pull':
                state = register_event(policy, helper, registry_module, state, event)
            elif args.phase == 'after-publish':
                state = publication_event(helper, registry_module, state, event)
            read_state = lambda: candidate_state(policy, registry_module)
            reviewed = plan(policy, helper, expected, state=state)
            helper.verify_remote(reviewed['corePlan'])
            result.update(plan=reviewed, planSha256=digest(reviewed), freeBytesBefore=shutil.disk_usage(BASE).free)
            # Persist the complete reviewed plan before any mutation.
            result['planFile'] = str(receipt)
            write_receipt(receipt, result)
            if args.scheduled or args.apply or args.phase:
                approval = result['planSha256'] if args.scheduled or args.phase else args.approved_plan_sha256
                def guard():
                    require(read_private(args.config, 24000, exact_mode=0o600) == config_raw, 'CONFIG_CHANGED')
                    require(hashlib.sha256(read_private(Path(__file__).resolve())).hexdigest()
                            == args.expected_source_sha256, 'NATIVE_SOURCE_CHANGED')
                    require(hashlib.sha256(read_private(INSTALL / 'maintain-image-cache.py')).hexdigest()
                            == policy['maintainerSha256'], 'MAINTAINER_SOURCE_CHANGED')
                    require(hashlib.sha256(read_private(INSTALL / 'candidate-retention.py', exact_mode=0o600)).hexdigest()
                            == policy['candidateRegistrySha256'], 'REGISTRY_SOURCE_CHANGED')
                def checkpoint(item, state):
                    nonlocal checkpoint_count
                    checkpoint_count += 1
                    result['applyState'] = {'item': item, 'state': state, 'removedCount': len(result['removed'])}
                    write_receipt(receipt_dir / (prefix + '.step-' + str(checkpoint_count) + '.json'),
                                  {k: v for k, v in result.items() if k != 'plan'})
                guard()
                apply(policy, helper, reviewed, approval, removed=result['removed'], checkpoint=checkpoint,
                      guard=guard, state_reader=read_state)
                guard()
                result['status'] = 'APPLIED'
            else:
                result['status'] = 'PLAN_ONLY'
            require(read_private(args.config, 24000, exact_mode=0o600) == config_raw, 'CONFIG_CHANGED')
            require(container_snapshot(helper) == containers_before, 'CONTAINERS_CHANGED')
            result['containersUnchanged'] = True
            result['freeBytesAfter'] = shutil.disk_usage(BASE).free
            if args.phase:
                result['phase'] = args.phase
                state = compact_registry(registry_module, read_state(), inventory(helper))
                result['policySha256'] = policy_digest(policy)
                result['registrySha256'] = digest(state)
                result['pendingRecords'] = registry_module.effective_candidates(state)['pending']
                result['seedRecords'] = []
                if args.phase == 'before-pull':
                    result['requiredFreeBytes'] = capacity_requirement(event['record'], inventory(helper), event['sourceArchiveBytes'])
                    result['capacityVerified'] = result['freeBytesAfter'] >= result['requiredFreeBytes']
                    require(result['capacityVerified'], 'INSUFFICIENT_PULL_HEADROOM')
                if args.phase == 'after-publish':
                    result['publicationVerified'] = True
            artifact_sizes = [usage(BASE / x) for x in ('releases', '.staging', 'artifacts')]
            result['budgetStatus'] = {
                'freeSpace': free_space_status(result['freeBytesAfter'], policy['budgets']),
                'projectArtifactsBytes': sum(artifact_sizes) if all(x is not None for x in artifact_sizes) else None,
                'localBackupsBytes': usage(BASE / 'backups'), 'systemLogsBytes': usage(Path('/var/log'))}
            result['budgetExceeded'] = [key for key in ('projectArtifactsBytes', 'localBackupsBytes', 'systemLogsBytes')
                                       if result['budgetStatus'][key] is not None
                                       and result['budgetStatus'][key] > policy['budgets'][key]]
            result['unconfirmedImagesHeld'] = sum(reason in ('NEWER_UNCONFIRMED_BUILD',
                'ONLINE_BATCH_NOT_REVIEWED_SUPERSEDED') for reason in reviewed['additionalProtection'].values())
        except Exception as error:
            result.update(status='FAILED', errorCode=str(error) if isinstance(error, RuntimeError)
                          and re.fullmatch('[A-Z_]+', str(error)) else 'RETENTION_FAILED_CLOSED')
        write_receipt(receipt_dir / (prefix + '.result.json'), {k: v for k, v in result.items() if k != 'plan'})
        output = {k: v for k, v in result.items() if k != 'plan'}
        if args.phase:
            output.pop('removed', None)
            output['removedCount'] = len(result['removed'])
            output['removedSha256'] = digest(result['removed'])
            if args.phase != 'before-build':
                output.pop('pendingRecords', None)
                output.pop('seedRecords', None)
        raw_output = json.dumps(output, sort_keys=True)
        require(len(raw_output.encode()) < 24000, 'RESULT_TRANSPORT_BOUND')
        print(raw_output)
        if result['status'] == 'FAILED':
            raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'code': str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z_]+', str(error))
                          else 'RETENTION_FAILED_CLOSED', 'rawErrorSuppressed': True})); raise SystemExit(1)
