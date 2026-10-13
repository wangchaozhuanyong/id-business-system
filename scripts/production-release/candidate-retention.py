"""Closed, immutable candidate lifecycle for the production disk maintainer.

This module does not call Git, GitHub, Docker or ECR. Its caller must verify the
producer/build proof, every ECR image identity and the ancestry predicate before
registering a complete record. Workflow failure alone grants no deletion right.
The deployment driver remains responsible for current/previous, container and
historical recovery protections even when a registered record becomes retired.
Private registry I/O requires root and an already held deployment lock.
"""

import copy
import hashlib
import json
import os
import re
import secrets
import stat
from pathlib import Path


REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
RECORD_KIND = 'DISK_CANDIDATE_RECORD_V1'
REGISTRY_KIND = 'DISK_CANDIDATE_REGISTRY_V1'
PUBLICATION_KIND = 'DISK_CANDIDATE_PUBLICATION_V1'
ABSENCE_KIND = 'DISK_CANDIDATE_LOCAL_ABSENCE_V1'
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}\Z')
POSITIVE = re.compile(r'[1-9][0-9]{0,19}\Z')
BATCH = re.compile(r'[a-f0-9]{40}-[1-9][0-9]{0,19}-[1-9][0-9]{0,19}\Z')
MAX_REGISTRY_BYTES = 8 * 1024**2
MAX_RECORDS = 1024
MAX_COMPACTED = 32768
MAX_IMAGE_BYTES = 1024**4
OPERATION_SCOPES = {
    'release_admin': ('admin', frozenset(('admin',))),
    'release_online_recharge': ('online-recharge', frozenset(('api', 'admin', 'migrate', 'online-recharge'))),
    'release_api_workspace': ('api-admin', frozenset(('api', 'admin'))),
    'release_api_admin': ('api-admin', frozenset(('api', 'admin'))),
    'release_api_admin_migration': ('api-admin-migration', frozenset(('api', 'admin', 'migrate'))),
    'release_unpublished_components': ('unpublished-components', frozenset(('api', 'admin', 'migrate'))),
    'release_recharge_flow': ('recharge-flow', frozenset(('api', 'admin', 'migrate'))),
}
MODULES = frozenset(scope[0] for scope in OPERATION_SCOPES.values()) | {'full-release'}
RECORD_FIELDS = frozenset(('kind', 'version', 'batch', 'module', 'operation', 'producer',
                          'qualityRunId', 'proofSha256', 'images'))
REGISTRY_FIELDS = frozenset(('kind', 'version', 'policySha256', 'pending', 'batches', 'frozen', 'compacted'))
PUBLICATION_FIELDS = frozenset(('kind', 'version', 'commit', 'workflowRunId', 'workflowRunAttempt',
                               'candidateProofSha256', 'currentManifestSha256', 'images'))


class CandidateRejected(RuntimeError):
    """Expose only a fixed rejection code, never untrusted record contents."""


def need(condition, code='CANDIDATE_INPUT_INVALID'):
    if not condition:
        raise CandidateRejected(code)


def exact(value, fields):
    need(type(value) is dict and set(value) == set(fields))


def matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def record_sha256(record):
    validate_record(record)
    return hashlib.sha256(canonical(record)).hexdigest()


def validate_record(record):
    exact(record, RECORD_FIELDS)
    need(record['kind'] == RECORD_KIND and type(record['version']) is int and record['version'] == 1)
    producer = record['producer']
    exact(producer, ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
    need(matches(HEX40, producer['commit']) and matches(HEX40, producer['sourceTree']))
    need(matches(POSITIVE, producer['workflowRunId']) and matches(POSITIVE, producer['workflowRunAttempt']))
    batch = '-'.join((producer['commit'], producer['workflowRunId'], producer['workflowRunAttempt']))
    need(record['batch'] == batch and matches(BATCH, batch), 'CANDIDATE_PRODUCER_DRIFT')
    need(matches(POSITIVE, record['qualityRunId']) and matches(HEX64, record['proofSha256']))
    images = record['images']
    need(type(images) is dict and type(record['operation']) is str)
    operation = record['operation']
    if operation == 'release':
        roles = frozenset(images)
        if roles == {'admin'}:
            module = 'admin'
        else:
            need(roles == {'api', 'admin', 'migrate', 'auto-recharge', 'media-resolver'},
                 'CANDIDATE_BATCH_INCOMPLETE')
            module = 'full-release'
    else:
        need(operation in OPERATION_SCOPES, 'CANDIDATE_OPERATION_UNSUPPORTED')
        module, roles = OPERATION_SCOPES[operation]
        need(set(images) == roles, 'CANDIDATE_BATCH_INCOMPLETE')
    need(record['module'] == module, 'CANDIDATE_MODULE_DRIFT')
    for role, image in images.items():
        exact(image, ('reference', 'imageId', 'sizeBytes', 'compressedBytes'))
        need(image['reference'] == REPOSITORY + ':' + batch + '-' + role, 'CANDIDATE_TAG_DRIFT')
        need(matches(IMAGE_ID, image['imageId']), 'CANDIDATE_IMAGE_ID_INVALID')
        for field in ('sizeBytes', 'compressedBytes'):
            need(type(image[field]) is int and 0 < image[field] <= MAX_IMAGE_BYTES,
                 'CANDIDATE_IMAGE_MEASUREMENT_MISSING')
    return copy.deepcopy(record)


def validate_publication(proof, record):
    exact(proof, PUBLICATION_FIELDS)
    need(proof['kind'] == PUBLICATION_KIND and type(proof['version']) is int and proof['version'] == 1)
    producer = record['producer']
    need(all(proof[key] == producer[key] for key in ('commit', 'workflowRunId', 'workflowRunAttempt')),
         'CANDIDATE_PUBLICATION_PRODUCER_DRIFT')
    need(proof['candidateProofSha256'] == record['proofSha256']
         and matches(HEX64, proof['currentManifestSha256']), 'CANDIDATE_PUBLICATION_PROOF_DRIFT')
    need(type(proof['images']) is dict and proof['images'] == {
        role: image['imageId'] for role, image in record['images'].items()
    }, 'CANDIDATE_PUBLICATION_IMAGE_DRIFT')
    return copy.deepcopy(proof)


def validate_registry(registry):
    exact(registry, REGISTRY_FIELDS)
    need(registry['kind'] == REGISTRY_KIND and type(registry['version']) is int and registry['version'] == 1)
    need(matches(HEX64, registry['policySha256']))
    for field in ('pending', 'batches', 'compacted'):
        need(type(registry[field]) is dict)
    pending, batches, compacted = registry['pending'], registry['batches'], registry['compacted']
    need(len(batches) <= MAX_RECORDS and len(compacted) <= MAX_COMPACTED, 'CANDIDATE_REGISTRY_BOUND')
    need(not set(batches) & set(compacted), 'CANDIDATE_DUPLICATE_BATCH')
    all_batches = set(batches) | set(compacted)
    frozen = registry['frozen']
    need(type(frozen) is list and len(frozen) <= MAX_RECORDS and all(matches(BATCH, batch) for batch in frozen)
         and len(set(frozen)) == len(frozen) and set(frozen) <= set(batches), 'CANDIDATE_FROZEN_INVALID')
    inferred_pending = {}
    for batch, entry in batches.items():
        need(matches(BATCH, batch))
        exact(entry, ('record', 'status', 'supersededBy', 'publicationProof'))
        record = validate_record(entry['record'])
        need(record['batch'] == batch, 'CANDIDATE_PRODUCER_DRIFT')
        need(entry['status'] in ('pending', 'retired', 'published'), 'CANDIDATE_STATUS_INVALID')
        if entry['status'] == 'pending':
            need(entry['supersededBy'] is None and entry['publicationProof'] is None)
            need(record['module'] not in inferred_pending, 'CANDIDATE_PENDING_LIMIT')
            inferred_pending[record['module']] = batch
        elif entry['status'] == 'retired':
            successor = entry['supersededBy']
            need(matches(BATCH, successor) and successor != batch and successor in all_batches,
                 'CANDIDATE_SUCCESSOR_INVALID')
            target = batches.get(successor)
            target_module = target['record']['module'] if target else compacted[successor]['module']
            need(record['module'] == target_module, 'CANDIDATE_CROSS_MODULE_SUPERSESSION')
        else:
            need(entry['supersededBy'] is None and entry['publicationProof'] is not None)
        if entry['publicationProof'] is not None:
            validate_publication(entry['publicationProof'], record)
    need(pending == inferred_pending, 'CANDIDATE_PENDING_INDEX_DRIFT')
    for batch, entry in compacted.items():
        need(matches(BATCH, batch))
        exact(entry, ('module', 'recordSha256', 'supersededBy'))
        need(type(entry['module']) is str and entry['module'] in MODULES and matches(HEX64, entry['recordSha256']))
        successor = entry['supersededBy']
        need(matches(BATCH, successor) and successor != batch and successor in all_batches,
             'CANDIDATE_SUCCESSOR_INVALID')
        target = batches.get(successor)
        need(entry['module'] == (target['record']['module'] if target else compacted[successor]['module']),
             'CANDIDATE_CROSS_MODULE_SUPERSESSION')
    # Retired links must ultimately lead to a live registered batch, never a cycle.
    verified_chains = set()
    for batch in all_batches:
        seen, cursor = set(), batch
        while cursor not in verified_chains:
            need(cursor not in seen, 'CANDIDATE_SUCCESSOR_CYCLE')
            seen.add(cursor)
            entry = batches.get(cursor)
            if entry and entry['status'] != 'retired':
                break
            cursor = entry['supersededBy'] if entry else compacted[cursor]['supersededBy']
        verified_chains.update(seen)
    need(len(canonical(registry)) <= MAX_REGISTRY_BYTES, 'CANDIDATE_REGISTRY_BOUND')
    return copy.deepcopy(registry)


def new_registry(policy_sha256):
    need(matches(HEX64, policy_sha256))
    return {'kind': REGISTRY_KIND, 'version': 1, 'policySha256': policy_sha256,
            'pending': {}, 'batches': {}, 'frozen': [], 'compacted': {}}


def _verify_ancestry(previous, record, ancestry):
    exact(ancestry, ('ancestorCommit', 'descendantCommit', 'approved', 'proofSha256'))
    need(ancestry['ancestorCommit'] == previous['producer']['commit']
         and ancestry['descendantCommit'] == record['producer']['commit']
         and ancestry['approved'] is True and matches(HEX64, ancestry['proofSha256']),
         'CANDIDATE_ANCESTRY_NOT_VERIFIED')


def _supersession(registry, record, instruction):
    need(type(instruction) is dict)
    basis = instruction.get('basis')
    if basis == 'pending':
        exact(instruction, ('batch', 'basis', 'ancestry'))
        batch = instruction['batch']
        need(batch in registry['batches'], 'CANDIDATE_UNKNOWN_SUPERSESSION')
        entry = registry['batches'][batch]
        need(entry['status'] == 'pending', 'CANDIDATE_SUPERSESSION_NOT_PENDING')
        previous = entry['record']
    elif basis == 'policy_seed':
        exact(instruction, ('batch', 'basis', 'record', 'policySha256', 'ancestry'))
        need(instruction['policySha256'] == registry['policySha256'], 'CANDIDATE_POLICY_DRIFT')
        previous = validate_record(instruction['record'])
        batch = instruction['batch']
        need(batch == previous['batch'] and batch not in registry['batches']
             and batch not in registry['compacted'], 'CANDIDATE_SEED_ALREADY_REGISTERED')
    else:
        raise CandidateRejected('CANDIDATE_SUPERSESSION_BASIS_INVALID')
    need(previous['module'] == record['module'], 'CANDIDATE_CROSS_MODULE_SUPERSESSION')
    need(batch not in registry['frozen'], 'CANDIDATE_FROZEN')
    need(batch != record['batch'], 'CANDIDATE_SELF_SUPERSESSION')
    _verify_ancestry(previous, record, instruction['ancestry'])
    return previous


def register(registry, record, supersedes):
    """Register only an entire successful, ECR verified producer batch.

    ``supersedes`` is an explicit list, not a guess from age or a failed run.
    Its ancestry approval and policy seeds must be independently checked by the
    trusted caller. A pre-existing pending candidate needs explicit replacement.
    """
    result, candidate = validate_registry(registry), validate_record(record)
    need(type(supersedes) is list and len(supersedes) <= MAX_RECORDS)
    batch, module = candidate['batch'], candidate['module']
    need(batch not in result['compacted'], 'CANDIDATE_PRODUCER_REUSED')
    if batch in result['batches']:
        entry = result['batches'][batch]
        need(entry['record'] == candidate, 'CANDIDATE_PRODUCER_REUSED')
        need(entry['status'] in ('pending', 'published'), 'CANDIDATE_RETIRED_REUSE')
        # Transport retries may repeat the same explicit replacement. They never
        # revive a retired batch or change an already published candidate.
        seen = set()
        for instruction in supersedes:
            need(type(instruction) is dict)
            basis = instruction.get('basis')
            if basis == 'pending':
                exact(instruction, ('batch', 'basis', 'ancestry'))
            else:
                need(basis == 'policy_seed', 'CANDIDATE_RETRY_DRIFT')
                exact(instruction, ('batch', 'basis', 'record', 'policySha256', 'ancestry'))
                need(instruction['policySha256'] == result['policySha256'], 'CANDIDATE_POLICY_DRIFT')
            old_batch = instruction['batch']
            need(matches(BATCH, old_batch) and old_batch not in seen and old_batch in result['batches'],
                 'CANDIDATE_RETRY_DRIFT')
            seen.add(old_batch)
            previous = result['batches'][old_batch]
            need(previous['status'] == 'retired' and previous['supersededBy'] == batch,
                 'CANDIDATE_RETRY_DRIFT')
            if basis == 'policy_seed':
                need(validate_record(instruction['record']) == previous['record'], 'CANDIDATE_RETRY_DRIFT')
            _verify_ancestry(previous['record'], candidate, instruction['ancestry'])
        return result
    old_records = [_supersession(result, candidate, instruction) for instruction in supersedes]
    old_batches = [old['batch'] for old in old_records]
    need(len(set(old_batches)) == len(old_batches), 'CANDIDATE_DUPLICATE_SUPERSESSION')
    existing = result['pending'].get(module)
    need(existing is None or existing in old_batches, 'CANDIDATE_PENDING_REPLACEMENT_REQUIRED')
    for previous in old_records:
        old_batch = previous['batch']
        result['batches'][old_batch] = {'record': previous, 'status': 'retired',
                                      'supersededBy': batch, 'publicationProof': None}
    result['batches'][batch] = {'record': candidate, 'status': 'pending',
                              'supersededBy': None, 'publicationProof': None}
    result['pending'][module] = batch
    return validate_registry(result)


def publish(registry, batch, publication_proof):
    """Mark publication only after the caller reads the actual current manifest."""
    result = validate_registry(registry)
    need(matches(BATCH, batch) and batch in result['batches'], 'CANDIDATE_UNKNOWN_PUBLICATION')
    entry = result['batches'][batch]
    proof = validate_publication(publication_proof, entry['record'])
    if entry['status'] == 'published':
        need(entry['publicationProof'] == proof, 'CANDIDATE_PUBLICATION_PROOF_DRIFT')
        return result
    need(entry['status'] == 'pending', 'CANDIDATE_PUBLICATION_NOT_PENDING')
    module = entry['record']['module']
    need(result['pending'].get(module) == batch, 'CANDIDATE_PENDING_INDEX_DRIFT')
    # The preceding published batch may become metadata-retired only after a
    # real successor publication. Native current/rollback protections still win.
    for previous_batch, previous in result['batches'].items():
        if (previous_batch != batch and previous['status'] == 'published'
                and previous['record']['module'] == module and previous_batch not in result['frozen']):
            previous.update(status='retired', supersededBy=batch)
    entry.update(status='published', publicationProof=proof)
    del result['pending'][module]
    return validate_registry(result)


def effective_candidates(registry):
    """Return whole pending batches and explicitly retired online batches only."""
    value = validate_registry(registry)
    return {'pending': [value['batches'][batch]['record'] for _, batch in sorted(value['pending'].items())],
            'frozen': [value['batches'][batch]['record'] for batch in sorted(value['frozen'])],
            'retiredOnline': [entry['record'] for batch, entry in sorted(value['batches'].items())
                              if entry['status'] == 'retired' and entry['record']['module'] == 'online-recharge'
                              and batch not in value['frozen']]}


def compact_retired(registry, absence_proofs):
    """Compact only terminal metadata with a verified absence of ALL local IDs.

    Caller must take a locked native image/container/reference snapshot. Merely
    missing the immutable tag is insufficient; every image ID must be absent.
    The tombstone preserves producer identity and replacement linkage, so an old
    producer cannot later be revived as a fresh candidate.
    """
    result = validate_registry(registry)
    need(type(absence_proofs) is list and len(absence_proofs) <= MAX_RECORDS)
    seen = set()
    for proof in absence_proofs:
        exact(proof, ('kind', 'version', 'batch', 'recordSha256', 'snapshotSha256', 'absentImageIds'))
        need(proof['kind'] == ABSENCE_KIND and type(proof['version']) is int and proof['version'] == 1)
        batch = proof['batch']
        need(matches(BATCH, batch) and batch in result['batches'] and batch not in seen,
             'CANDIDATE_ABSENCE_BATCH_INVALID')
        seen.add(batch)
        entry = result['batches'][batch]
        need(entry['status'] == 'retired' and batch not in result['frozen'], 'CANDIDATE_ABSENCE_NOT_RETIRED')
        need(proof['recordSha256'] == record_sha256(entry['record']) and matches(HEX64, proof['snapshotSha256']),
             'CANDIDATE_ABSENCE_PROOF_DRIFT')
        absent = proof['absentImageIds']
        expected = {image['imageId'] for image in entry['record']['images'].values()}
        need(type(absent) is list and all(matches(IMAGE_ID, image) for image in absent)
             and len(set(absent)) == len(absent) and set(absent) == expected,
             'CANDIDATE_ABSENCE_INCOMPLETE')
        result['compacted'][batch] = {'module': entry['record']['module'],
                                     'recordSha256': proof['recordSha256'], 'supersededBy': entry['supersededBy']}
        del result['batches'][batch]
    return validate_registry(result)


def _private_directory(path, deployment_lock_held):
    need(deployment_lock_held is True, 'CANDIDATE_DEPLOYMENT_LOCK_REQUIRED')
    need(os.geteuid() == 0, 'CANDIDATE_ROOT_REQUIRED')
    value = Path(path)
    need(value.is_absolute() and value.name not in ('', '.', '..') and '..' not in value.parts,
         'CANDIDATE_PRIVATE_PATH_INVALID')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in value.parent.parts[1:]:
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            metadata = os.fstat(following)
            if not (stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_mode & 0o022 == 0):
                os.close(following)
                raise CandidateRejected('CANDIDATE_PRIVATE_DIRECTORY_INVALID')
            os.close(directory)
            directory = following
        return directory, value.name
    except BaseException:
        os.close(directory)
        raise


def _file_metadata(directory, name):
    metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and stat.S_IMODE(metadata.st_mode) == 0o600
         and metadata.st_nlink == 1 and 0 < metadata.st_size <= MAX_REGISTRY_BYTES,
         'CANDIDATE_PRIVATE_FILE_INVALID')
    return metadata


def _unique_json(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'CANDIDATE_DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def read_registry(path, *, deployment_lock_held):
    directory, name = _private_directory(path, deployment_lock_held)
    descriptor = None
    try:
        before = _file_metadata(directory, name)
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        opened = os.fstat(descriptor)
        need((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'CANDIDATE_PRIVATE_FILE_CHANGED')
        chunks, total = [], 0
        while True:
            chunk = os.read(descriptor, min(65536, MAX_REGISTRY_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            need(total <= MAX_REGISTRY_BYTES, 'CANDIDATE_REGISTRY_BOUND')
            chunks.append(chunk)
        after = os.fstat(descriptor)
        need((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'CANDIDATE_PRIVATE_FILE_CHANGED')
        raw = b''.join(chunks)
        value = json.loads(raw, object_pairs_hook=_unique_json,
                           parse_constant=lambda unused: (_ for _ in ()).throw(CandidateRejected('CANDIDATE_INPUT_INVALID')))
        return validate_registry(value)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def write_registry(path, registry, *, deployment_lock_held):
    """Atomic root-owned 0600 write; caller holds the global deployment lock."""
    raw = canonical(validate_registry(registry)) + b'\n'
    need(len(raw) <= MAX_REGISTRY_BYTES, 'CANDIDATE_REGISTRY_BOUND')
    directory, name = _private_directory(path, deployment_lock_held)
    temporary, descriptor = '.candidate-registry-' + secrets.token_hex(16), None
    created = False
    try:
        try:
            before = _file_metadata(directory, name)
        except FileNotFoundError:
            before = None
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        created = True
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            need(count > 0, 'CANDIDATE_PRIVATE_WRITE_FAILED')
            written += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        try:
            after = _file_metadata(directory, name)
        except FileNotFoundError:
            after = None
        need((before is None and after is None) or (before is not None and after is not None
             and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)),
             'CANDIDATE_PRIVATE_FILE_CHANGED')
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        created = False
        os.fsync(directory)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)
    return hashlib.sha256(raw).hexdigest()
