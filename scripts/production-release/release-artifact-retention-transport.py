"""Exact-source release directory archival transport; no application publication."""
import argparse
import base64
import fcntl
import gzip
import hashlib
import importlib.util
import inspect
import json
import lzma
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import time
import zlib

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
BASE = Path('/opt/id-business-v2')
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
ACCOUNT = '079740175286'
GITHUB_REPOSITORY = 'wangchaozhuanyong/id-business-system'
REPOSITORY = ACCOUNT + '.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
NATIVE_PATH = 'scripts/production-release/release-artifact-retention.py'
PROOF_PATH = 'deploy/aws/release-artifact-storage-proof-20261014.json'
PATHS = (NATIVE_PATH, PROOF_PATH)
SOURCE_PATHS = (*PATHS, 'scripts/production-release/release-artifact-retention-transport.py',
                'scripts/production-release/disk-retention-transport.py',
                'scripts/production-release/release-storage.py', '.github/workflows/release-artifact-retention.yml')
OPERATIONS = ('verify', 'archive', 'restore')
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
POSITIVE = re.compile(r'[1-9][0-9]{0,19}\Z')
MAX_BODY = 2 * 1024**2
MAX_COMMAND = 19500
MAX_STDOUT = 24000
MAX_WIRE = 20000
WIRE_KIND = 'ID_RELEASE_ARTIFACT_RETENTION_WIRE_V1'
FAILURE_KIND = 'ID_RELEASE_ARTIFACT_RETENTION_FAILURE_V1'
RECEIPTS = BASE / 'maintenance/release-artifact-retention/receipts'
FOLDER = 'v2-production-20260907T114213Z-294c67d5bca430dfd5d37f08826b1df615d53ae7'
PACKAGE = 'id-business-v2-' + FOLDER + '.tar.gz'
RELATIVE = 'artifacts/' + FOLDER + '/' + PACKAGE
FILE_PINS = {
    PACKAGE: {'bytes': 1953942933, 'sha256': 'f8f10c17e38ced41e52a216674b2725b73775c761da30976e298de3ed9fa1253'},
    'ci-release-manifest.json': {'bytes': 2132, 'sha256': '5c108b1c49729889e9cfca442eebcd9dd6c0284d5d061bfb850e0c4cd3ca83b1'},
    'SHA256SUMS': {'bytes': 248, 'sha256': '8745c87c28516532c77f595839cb36785d71361a454a2650aa966a3fb36ac55d'},
}

class Rejected(RuntimeError):
    pass


def need(condition, code='ARTIFACT_INPUT_INVALID'):
    if not condition:
        raise Rejected(code)


def matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return sha(canonical(value))


def closed(raw, limit=MAX_BODY):
    need(type(raw) in (str, bytes) and 0 < len(raw.encode() if type(raw) is str else raw) <= limit,
         'ARTIFACT_JSON_BOUND')
    def unique(items):
        value = {}
        for key, item in items:
            need(key not in value, 'ARTIFACT_DUPLICATE_FIELD'); value[key] = item
        return value
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: need(False, 'ARTIFACT_NONFINITE_JSON'))
    except Rejected:
        raise
    except Exception:
        raise Rejected('ARTIFACT_JSON_INVALID') from None


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def regular(path, limit=MAX_BODY, *, owner=0, mode=None):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'ARTIFACT_PATH_INVALID')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == owner
             and before.st_gid == (0 if owner == 0 else os.getegid()) and 0 < before.st_size <= limit,
             'ARTIFACT_FILE_INVALID')
        if mode is not None:
            need(stat.S_IMODE(before.st_mode) == mode, 'ARTIFACT_FILE_MODE')
        raw = stream.read(limit + 1)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(stream.fileno()))
             == identity(path.lstat()), 'ARTIFACT_FILE_CHANGED')
        return raw, before


def command(arguments, *, limit=MAX_BODY, timeout=90, failure_code='ARTIFACT_COMMAND_FAILED'):
    child_environment = {**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'}
    process = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=timeout, env=child_environment)
    need(process.returncode == 0 and len(process.stdout) <= limit, failure_code)
    return process.stdout


def snapshot(expected, base=BASE, owner=0, *, context='OBSERVE'):
    need(matches(HEX40, expected), 'ARTIFACT_CURRENT_INVALID')
    need(context in ('OBSERVE', 'STAGE_BEFORE', 'STAGE_AFTER', 'OPERATION_BEFORE',
                     'OPERATION_PREAPPLY', 'OPERATION_AFTER'), 'ARTIFACT_SNAPSHOT_CONTEXT_INVALID')
    failure_prefix = 'ARTIFACT_' + context + '_SNAPSHOT_'
    link = base / 'current'
    first = link.lstat()
    need(stat.S_ISLNK(first.st_mode) and first.st_uid == owner, 'ARTIFACT_CURRENT_INVALID')
    release = link.resolve()
    need(release.parent == base / 'releases' and re.fullmatch(
        r'[0-9]{8}T[0-9]{6}Z-' + expected[:12], release.name), 'ARTIFACT_CURRENT_INVALID')
    manifest, unused = regular(release / 'release-manifest.json', 128 * 1024, owner=owner)
    need(closed(manifest)['commit'] == expected, 'ARTIFACT_CURRENT_CHANGED')
    identifiers = command(['docker', 'ps', '-a', '--no-trunc', '--quiet'], limit=65536,
                          failure_code=failure_prefix + 'PS_FAILED').decode().splitlines()
    need(len(identifiers) <= 500 and len(set(identifiers)) == len(identifiers)
         and all(matches(HEX64, item) for item in identifiers), 'ARTIFACT_CONTAINER_INVALID')
    states = []
    format_string = ('{"id":{{json .Id}},"imageId":{{json .Image}},"reference":{{json .Config.Image}},'
                     '"running":{{json .State.Running}},"state":{{json .State.Status}},'
                     '"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},'
                     '"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},'
                     '"mounts":{{json .Mounts}}}')
    if identifiers:
        raw = command(['docker', 'inspect', '--format', format_string, *sorted(identifiers)], limit=512 * 1024,
                      failure_code=failure_prefix + 'INSPECT_FAILED')
        for line in raw.decode().splitlines():
            row = closed(line)
            need(type(row) is dict and set(row) == {'id', 'imageId', 'reference', 'running', 'state', 'startedAt', 'restartCount', 'health', 'mounts'}
                 and row['id'] in identifiers and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'])
                 and row['state'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead')
                 and type(row['reference']) is str and 0 < len(row['reference']) <= 500
                 and type(row['running']) is bool and type(row['restartCount']) is int and 0 <= row['restartCount'] < 2**31
                 and row['health'] in (None, 'starting', 'healthy', 'unhealthy')
                 and type(row['startedAt']) is str and 0 < len(row['startedAt']) <= 80,
                 'ARTIFACT_CONTAINER_INVALID')
            need(type(row['mounts']) is list and len(row['mounts']) <= 64, 'ARTIFACT_MOUNTS_INVALID')
            mounts = []
            for mount in row['mounts']:
                need(type(mount) is dict and mount.get('Type') in ('bind', 'volume', 'tmpfs'),
                     'ARTIFACT_MOUNTS_INVALID')
                source, destination = mount.get('Source'), mount.get('Destination')
                need(type(destination) is str and destination.startswith('/') and len(destination) <= 1000,
                     'ARTIFACT_MOUNTS_INVALID')
                if mount['Type'] == 'tmpfs':
                    need(source in (None, ''), 'ARTIFACT_MOUNTS_INVALID'); source = ''
                else:
                    need(type(source) is str and source.startswith('/') and len(source) <= 1000,
                         'ARTIFACT_MOUNTS_INVALID')
                mounts.append({'type': mount['Type'], 'source': source, 'destination': destination})
            row['mounts'] = sorted(mounts, key=canonical)
            states.append(row)
        need(len(states) == len(identifiers) and {row['id'] for row in states} == set(identifiers),
             'ARTIFACT_CONTAINER_INVALID')
    need(identity(link.lstat()) == identity(first) and link.resolve() == release, 'ARTIFACT_CURRENT_CHANGED')
    pointer = dict(zip(('device', 'inode', 'mode', 'uid', 'gid', 'links', 'bytes', 'mtimeNs', 'ctimeNs'),
                       (first.st_dev, first.st_ino, stat.S_IMODE(first.st_mode), first.st_uid, first.st_gid,
                        first.st_nlink, first.st_size, first.st_mtime_ns, first.st_ctime_ns)))
    return {'currentCommit': expected, 'currentRelease': str(release), 'currentManifestSha256': sha(manifest),
            'currentPointerIdentity': pointer, 'containers': sorted(states, key=lambda row: row['id'])}


def validate_binding(binding):
    need(type(binding) is dict and set(binding) == {'kind', 'version', 'operation', 'producer',
         'qualityRunId', 'expectedCurrent', 'planSha256', 'target', 'sourcePins'}, 'ARTIFACT_BINDING_FIELDS')
    need(binding['kind'] == 'ID_RELEASE_ARTIFACT_RETENTION_BINDING_V1'
         and type(binding['version']) is int and binding['version'] == 1
         and binding['operation'] in OPERATIONS, 'ARTIFACT_OPERATION_INVALID')
    producer = binding['producer']
    need(type(producer) is dict and set(producer) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
         and all(matches(HEX40, producer[key]) for key in ('commit', 'sourceTree'))
         and matches(POSITIVE, producer['workflowRunId']) and producer['workflowRunAttempt'] == '1'
         and matches(POSITIVE, binding['qualityRunId']) and matches(HEX40, binding['expectedCurrent']),
         'ARTIFACT_PRODUCER_INVALID')
    need(matches(HEX64, binding['planSha256']) if binding['operation'] != 'verify'
         else binding['planSha256'] is None, 'ARTIFACT_PLAN_APPROVAL_REQUIRED')
    need(binding['target'] == {'accountId': ACCOUNT, 'instanceId': INSTANCE, 'region': REGION,
                              'repository': REPOSITORY}, 'ARTIFACT_TARGET_INVALID')
    need(type(binding['sourcePins']) is dict and set(binding['sourcePins']) == set(PATHS),
         'ARTIFACT_SOURCE_SET_INVALID')
    for pin in binding['sourcePins'].values():
        need(type(pin) is dict and set(pin) == {'sha256', 'bytes'} and matches(HEX64, pin['sha256'])
             and type(pin['bytes']) is int and 0 < pin['bytes'] <= MAX_BODY, 'ARTIFACT_SOURCE_PIN_INVALID')
    return binding


def stage_root(binding, base=BASE):
    return base / '.staging' / ('release-artifact-retention-' + binding['producer']['commit'])


def stage_file(binding, path, payload, *, base=BASE, owner=0):
    validate_binding(binding)
    need(path in PATHS and os.geteuid() == owner, 'ARTIFACT_STAGE_SCOPE')
    pin = binding['sourcePins'][path]
    need(type(payload) in (str, bytes) and 0 < len(payload) <= MAX_BODY, 'ARTIFACT_STAGE_PAYLOAD_BOUND')
    if type(payload) is str:
        decoder = lzma.LZMADecompressor(memlimit=64 * 1024**2)
        raw = decoder.decompress(base64.b64decode(payload, validate=True), max_length=pin['bytes'] + 1)
        need(decoder.eof and not decoder.unused_data, 'ARTIFACT_STAGE_SOURCE_CHANGED')
    else:
        raw = payload
    need(len(raw) == pin['bytes'] and sha(raw) == pin['sha256'], 'ARTIFACT_STAGE_SOURCE_CHANGED')
    lock_path = base / '.deploy.lock'
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as lock:
        lock_info = os.fstat(lock.fileno())
        need(stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1 and lock_info.st_uid == owner
             and lock_info.st_gid == (0 if owner == 0 else os.getegid())
             and not stat.S_IMODE(lock_info.st_mode) & 0o022
             and identity(lock_info) == identity(lock_path.lstat()), 'ARTIFACT_DEPLOY_LOCK_INVALID')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = snapshot(binding['expectedCurrent'], base, owner, context='STAGE_BEFORE')
        staging = base / '.staging'
        info = staging.lstat()
        need(staging.resolve() == staging and stat.S_ISDIR(info.st_mode) and info.st_uid == owner
             and info.st_gid == (0 if owner == 0 else os.getegid())
             and not stat.S_IMODE(info.st_mode) & 0o022, 'ARTIFACT_STAGE_PARENT_INVALID')
        root = stage_root(binding, base)
        target = root / path
        directories = [root]
        for component in Path(path).parent.parts:
            directories.append(directories[-1] / component)
        for directory in directories:
            if not directory.exists() and not directory.is_symlink():
                directory.mkdir(mode=0o700)
            info = directory.lstat()
            need(directory.resolve() == directory and stat.S_ISDIR(info.st_mode)
                 and info.st_uid == owner and info.st_gid == (0 if owner == 0 else os.getegid())
                 and stat.S_IMODE(info.st_mode) == 0o700, 'ARTIFACT_STAGE_DIRECTORY_INVALID')
        reused = target.exists() or target.is_symlink()
        if reused:
            actual, unused = regular(target, owner=owner, mode=0o600)
            need(actual == raw, 'ARTIFACT_UNKNOWN_STAGE_TARGET')
        else:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        actual, unused = regular(target, owner=owner, mode=0o600)
        need(actual == raw and snapshot(binding['expectedCurrent'], base, owner, context='STAGE_AFTER') == before
             and identity(lock_info) == identity(os.fstat(lock.fileno())) == identity(lock_path.lstat()),
             'ARTIFACT_STAGE_STATE_CHANGED')
    return {'kind': 'ID_RELEASE_ARTIFACT_RETENTION_STAGE_ACK_V1', 'status': 'STAGED',
            'producer': binding['producer'], 'expectedCurrent': binding['expectedCurrent'],
            'path': path, 'sha256': pin['sha256'], 'bytes': pin['bytes'], 'reused': reused,
            'currentUnchanged': True, 'containersUnchanged': True}


def wire(binding, result):
    validate_binding(binding)
    raw = canonical(result)
    need(0 < len(raw) <= MAX_BODY, 'ARTIFACT_RESULT_BODY_BOUND')
    value = {'kind': WIRE_KIND, 'version': 1, 'bindingSha256': digest(binding),
             'operation': binding['operation'], 'producer': binding['producer'], 'encoding': 'gzip-base64',
             'bodyBytes': len(raw), 'bodySha256': sha(raw),
             'payload': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    need(len(canonical(value)) <= MAX_WIRE, 'ARTIFACT_RESULT_WIRE_BOUND')
    return value


def decode_wire(value, binding):
    validate_binding(binding)
    need(type(value) is dict and set(value) == {'kind', 'version', 'bindingSha256', 'operation', 'producer',
         'encoding', 'bodyBytes', 'bodySha256', 'payload'} and value['kind'] == WIRE_KIND
         and type(value['version']) is int and value['version'] == 1
         and value['bindingSha256'] == digest(binding) and value['operation'] == binding['operation']
         and value['producer'] == binding['producer'] and value['encoding'] == 'gzip-base64'
         and type(value['bodyBytes']) is int and 0 < value['bodyBytes'] <= MAX_BODY
         and matches(HEX64, value['bodySha256']) and type(value['payload']) is str
         and len(canonical(value)) <= MAX_WIRE, 'ARTIFACT_WIRE_INVALID')
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(base64.b64decode(value['payload'], validate=True), value['bodyBytes'] + 1)
        need(len(raw) == value['bodyBytes'] and decoder.eof and not decoder.unused_data
             and not decoder.unconsumed_tail and sha(raw) == value['bodySha256'], 'ARTIFACT_WIRE_BINDING_CHANGED')
    except Rejected:
        raise
    except Exception:
        raise Rejected('ARTIFACT_WIRE_INVALID') from None
    return closed(raw)


def storage_module():
    spec = importlib.util.spec_from_file_location('artifact_retention_storage', HERE / 'release-storage.py')
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def disk_module():
    spec = importlib.util.spec_from_file_location('artifact_retention_disk', HERE / 'disk-retention-transport.py')
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def selection(environment):
    operation = environment.get('RELEASE_ARTIFACT_RETENTION_OPERATION')
    plan = environment.get('RELEASE_ARTIFACT_RETENTION_PLAN_SHA256', '')
    need(operation in OPERATIONS, 'ARTIFACT_OPERATION_INVALID')
    need(matches(HEX64, plan) if operation in ('archive', 'restore') else plan == '',
         'ARTIFACT_PLAN_APPROVAL_REQUIRED')
    producer = {'commit': environment.get('RELEASE_COMMIT'), 'sourceTree': environment.get('SOURCE_TREE'),
                'workflowRunId': environment.get('GITHUB_RUN_ID'),
                'workflowRunAttempt': environment.get('GITHUB_RUN_ATTEMPT')}
    need(all(matches(HEX40, producer[key]) for key in ('commit', 'sourceTree'))
         and matches(POSITIVE, producer['workflowRunId']) and matches(POSITIVE, environment.get('QUALITY_RUN_ID'))
         and matches(HEX40, environment.get('EXPECTED_CURRENT')), 'ARTIFACT_PRODUCER_INVALID')
    need(producer['workflowRunAttempt'] == '1', 'ARTIFACT_RERUN_RECONCILIATION_REQUIRED')
    need(environment.get('GITHUB_REF') == 'refs/heads/main'
         and environment.get('GITHUB_REPOSITORY') == GITHUB_REPOSITORY
         and environment.get('PRODUCTION_INSTANCE_ID') == INSTANCE and environment.get('AWS_REGION') == REGION
         and environment.get('RELEASE_REPOSITORY') == REPOSITORY
         and environment.get('RELEASE_ACCOUNT_ID') == ACCOUNT, 'ARTIFACT_TARGET_INVALID')
    return {'operation': operation, 'producer': producer, 'qualityRunId': environment['QUALITY_RUN_ID'],
            'expectedCurrent': environment['EXPECTED_CURRENT'], 'planSha256': plan or None,
            'target': {'accountId': ACCOUNT, 'instanceId': INSTANCE, 'region': REGION, 'repository': REPOSITORY}}


def source_binding(selected, commands):
    common = storage_module()
    common.verify_source(selected, commands)
    sources = {}
    for path in SOURCE_PATHS:
        raw = common.read_file(PROJECT / path, MAX_BODY)
        unused, committed = commands.git('show', selected['producer']['commit'] + ':' + path, limit=MAX_BODY)
        need(raw == committed, 'ARTIFACT_GIT_SOURCE_CHANGED')
        if path in PATHS:
            sources[path] = raw
    proof = closed(sources[PROOF_PATH])
    need(type(proof) is dict and proof.get('kind') == 'ID_RELEASE_ARTIFACT_STORAGE_PROOF_V1'
         and type(proof.get('version')) is int and proof['version'] == 1
         and proof.get('bucket') == 'id-business-v2-backups-' + ACCOUNT + '-' + REGION
         and proof.get('region') == REGION and proof.get('prefix') == 'mysql/daily'
         and proof.get('releaseArtifactSubprefix') == 'release-artifact-cache'
         and proof.get('minimumRecoveryDays') == 14 and proof.get('bucketConfigurationMutationAuthorized') is False,
         'ARTIFACT_CLOUD_PROOF_CHANGED')
    binding = {'kind': 'ID_RELEASE_ARTIFACT_RETENTION_BINDING_V1', 'version': 1, **selected,
               'sourcePins': {path: {'sha256': sha(raw), 'bytes': len(raw)} for path, raw in sources.items()}}
    validate_binding(binding)
    return binding, sources


def private_directory(selected):
    leaf = PROJECT / '.deploy/production-release/release-artifact-retention' / (
        selected['producer']['workflowRunId'] + '-' + selected['producer']['workflowRunAttempt'])
    current = PROJECT
    for component in leaf.relative_to(PROJECT).parts:
        current = current / component
        if not current.exists() and not current.is_symlink():
            current.mkdir(mode=0o700)
        info = current.lstat()
        need(current.resolve() == current and stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
             and not stat.S_IMODE(info.st_mode) & 0o022, 'ARTIFACT_LOCAL_DIRECTORY_INVALID')
    need(stat.S_IMODE(leaf.stat().st_mode) == 0o700, 'ARTIFACT_LOCAL_DIRECTORY_INVALID')
    return leaf


def validate_ack(result, binding, path):
    pin = binding['sourcePins'][path]
    need(type(result) is dict and set(result) == {'kind', 'status', 'producer', 'expectedCurrent', 'path',
         'sha256', 'bytes', 'reused', 'currentUnchanged', 'containersUnchanged'}
         and result['kind'] == 'ID_RELEASE_ARTIFACT_RETENTION_STAGE_ACK_V1' and result['status'] == 'STAGED'
         and result['producer'] == binding['producer'] and result['expectedCurrent'] == binding['expectedCurrent']
         and result['path'] == path and result['sha256'] == pin['sha256'] and result['bytes'] == pin['bytes']
         and type(result['reused']) is bool and result['currentUnchanged'] is True
         and result['containersUnchanged'] is True, 'ARTIFACT_STAGE_ACK_CHANGED')


def validate_plan(plan, binding, expected_sha):
    need(type(plan) is dict and set(plan) == {'kind', 'version', 'relativePath', 'currentCommit', 'sourceProbe',
         'files', 'targetSha256', 'cloudProofSha256', 'minimumRecoveryDays', 'requiredFreeBytes'}
         and plan['kind'] == 'ID_RELEASE_ARTIFACT_PLAN_V1' and type(plan['version']) is int
         and plan['version'] == 1 and plan['relativePath'] == RELATIVE
         and plan['currentCommit'] == binding['expectedCurrent'] and digest(plan) == expected_sha
         and matches(HEX64, plan['targetSha256'])
         and plan['cloudProofSha256'] == binding['sourcePins'][PROOF_PATH]['sha256']
         and type(plan['minimumRecoveryDays']) is int and plan['minimumRecoveryDays'] == 14
         and type(plan['requiredFreeBytes']) is int
         and plan['requiredFreeBytes'] == FILE_PINS[PACKAGE]['bytes'] + 2 * 1024**3,
         'ARTIFACT_PLAN_BINDING_CHANGED')
    probe = plan['sourceProbe']
    need(type(probe) is dict and set(probe) == {'currentCommit', 'currentRelease', 'currentManifestSha256',
         'currentPointerIdentity', 'containers'} and probe['currentCommit'] == binding['expectedCurrent']
         and probe['currentRelease'] == str(BASE / 'releases' / Path(probe['currentRelease']).name)
         and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + binding['expectedCurrent'][:12], Path(probe['currentRelease']).name)
         and matches(HEX64, probe['currentManifestSha256']) and type(probe['containers']) is list
         and len(probe['containers']) <= 128, 'ARTIFACT_PLAN_PROTECTION_INVALID')
    fields = {'device', 'inode', 'mode', 'uid', 'gid', 'links', 'bytes', 'mtimeNs', 'ctimeNs'}
    pointer = probe['currentPointerIdentity']
    need(type(pointer) is dict and set(pointer) == fields
         and all(type(value) is int and value >= 0 for value in pointer.values())
         and pointer['uid'] == pointer['gid'] == 0, 'ARTIFACT_PLAN_PROTECTION_INVALID')
    seen = set()
    for row in probe['containers']:
        need(type(row) is dict and set(row) == {'id', 'imageId', 'reference', 'running', 'state',
             'startedAt', 'restartCount', 'health', 'mounts'} and matches(HEX64, row['id'])
             and row['id'] not in seen and type(row['imageId']) is str
             and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId']) and type(row['reference']) is str
             and 0 < len(row['reference']) <= 500 and type(row['running']) is bool
             and row['state'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead')
             and type(row['startedAt']) is str and len(row['startedAt']) <= 80
             and type(row['restartCount']) is int and 0 <= row['restartCount'] < 2**31
             and row['health'] in (None, 'starting', 'healthy', 'unhealthy')
             and type(row['mounts']) is list and len(row['mounts']) <= 64,
             'ARTIFACT_PLAN_PROTECTION_INVALID')
        seen.add(row['id'])
        for mount in row['mounts']:
            need(type(mount) is dict and set(mount) == {'type', 'source', 'destination'}
                 and mount['type'] in ('bind', 'volume', 'tmpfs') and type(mount['source']) is str
                 and len(mount['source']) <= 1000 and (mount['source'] == '' if mount['type'] == 'tmpfs'
                     else mount['source'].startswith('/')) and type(mount['destination']) is str
                 and mount['destination'].startswith('/') and len(mount['destination']) <= 1000,
                 'ARTIFACT_PLAN_PROTECTION_INVALID')
    need(type(plan['files']) is dict and set(plan['files']) == set(FILE_PINS), 'ARTIFACT_PLAN_FILE_SET_CHANGED')
    for name, pin in FILE_PINS.items():
        record = plan['files'][name]
        need(type(record) is dict and set(record) == {'sha256', 'identity'} and record['sha256'] == pin['sha256'],
             'ARTIFACT_PLAN_FILE_PIN_CHANGED')
        info = record['identity']
        need(type(info) is dict and set(info) == fields and all(type(value) is int and value >= 0 for value in info.values())
             and info['bytes'] == pin['bytes'] and info['mode'] == 0o600 and info['uid'] == info['gid'] == 0
             and info['links'] == 1, 'ARTIFACT_PLAN_FILE_IDENTITY_CHANGED')
    return plan


def receipt_path(path, expected_name=None):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and path.parent == RECEIPTS
         and (path.name == expected_name if expected_name is not None else
              re.fullmatch(r'[a-f0-9]{64}-[1-9][0-9]{0,24}\.(?:result|restore)\.json', path.name)),
         'ARTIFACT_PRIVATE_RECEIPT_PATH_INVALID')
    info = RECEIPTS.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
         and stat.S_IMODE(info.st_mode) == 0o700, 'ARTIFACT_PRIVATE_RECEIPT_DIRECTORY_INVALID')
    return path


def read_plan(binding, expected_sha, path=None):
    need(matches(HEX64, expected_sha), 'ARTIFACT_PLAN_DIGEST_INVALID')
    path = receipt_path(path or str(RECEIPTS / (expected_sha + '.plan.json')), expected_sha + '.plan.json')
    raw, unused = regular(path, MAX_BODY, mode=0o600)
    return validate_plan(closed(raw), binding, expected_sha)


def validate_native(result, binding, operation, plan):
    common = {'kind', 'version', 'operation', 'status', 'planSha256', 'relativePath', 'packageBytes',
              'currentUnchanged', 'containersUnchanged', 'metadataUnchanged', 'removed'}
    planned = {'planFile', 'requiredFreeBytes', 'sourceProbeSha256', 'targetSha256', 'cloudProofSha256',
               'minimumRecoveryDays'}
    applied = {'fullRecoveryVerified', 'recoveryIndexSha256', 'recoveryObjectSha256',
               'freeBytesBefore', 'freeBytesAfter', 'recoveryFile', 'receiptFile'}
    restored = {'restoredSha256', 'fullRecoveryVerified', 'receiptFile'}
    fields = common | (restored if operation == 'restore' else planned | (applied if operation == 'apply' else set()))
    need(type(result) is dict and set(result) == fields and result['kind'] == 'ID_RELEASE_ARTIFACT_RESULT_V1'
         and type(result['version']) is int and result['version'] == 1 and result['operation'] == operation
         and result['status'] == {'plan': 'PLAN_ONLY', 'apply': 'APPLIED', 'restore': 'RESTORED'}[operation]
         and result['relativePath'] == RELATIVE and type(result['packageBytes']) is int
         and result['packageBytes'] == FILE_PINS[PACKAGE]['bytes'] and result['planSha256'] == digest(plan)
         and result['currentUnchanged'] is True and result['containersUnchanged'] is True
         and result['metadataUnchanged'] is True and result['removed'] is (operation == 'apply'),
         'ARTIFACT_NATIVE_RESULT_INVALID')
    if operation != 'plan':
        need(result['planSha256'] == binding['planSha256'] and result['fullRecoveryVerified'] is True,
             'ARTIFACT_APPROVED_PLAN_CHANGED')
    if operation != 'restore':
        need(result['requiredFreeBytes'] == plan['requiredFreeBytes']
             and result['sourceProbeSha256'] == digest(plan['sourceProbe'])
             and result['targetSha256'] == plan['targetSha256']
             and result['cloudProofSha256'] == plan['cloudProofSha256'] and result['minimumRecoveryDays'] == 14
             and result['planFile'] == str(RECEIPTS / (digest(plan) + '.plan.json')), 'ARTIFACT_NATIVE_PLAN_CHANGED')
    if operation == 'apply':
        need(all(matches(HEX64, result[key]) for key in ('recoveryIndexSha256', 'recoveryObjectSha256'))
             and all(type(result[key]) is int and 0 <= result[key] < 2**64
                     for key in ('freeBytesBefore', 'freeBytesAfter'))
             and result['freeBytesBefore'] >= plan['requiredFreeBytes']
             and result['recoveryFile'] == str(RECEIPTS / (digest(plan) + '.recovery.json')),
             'ARTIFACT_NATIVE_RECOVERY_INVALID')
    if operation == 'restore':
        need(result['restoredSha256'] == FILE_PINS[PACKAGE]['sha256'], 'ARTIFACT_NATIVE_RESTORE_CHANGED')
    return result


def complete_result(binding, native, plan, before):
    return {'kind': 'ID_RELEASE_ARTIFACT_RETENTION_TRANSPORT_RESULT_V1', 'version': 1,
            'operation': binding['operation'], 'producer': binding['producer'], 'expectedCurrent': binding['expectedCurrent'],
            'status': native['status'], 'planSha256': digest(plan), 'plan': plan, 'nativeResult': native,
            'sourceProbe': before, 'baselineSha256': digest(before), 'currentUnchanged': True,
            'containersUnchanged': True, 'websiteServicesChanged': False}


def apply_receipt_budget(binding, planned, plan, before):
    need(binding['operation'] in ('archive', 'restore'), 'ARTIFACT_APPLY_SCOPE_INVALID')
    if binding['operation'] == 'archive':
        model = {**planned, 'operation': 'apply', 'status': 'APPLIED', 'removed': True,
                 'fullRecoveryVerified': True, 'recoveryIndexSha256': 'f' * 64, 'recoveryObjectSha256': 'e' * 64,
                 'freeBytesBefore': 2**64 - 1, 'freeBytesAfter': 2**64 - 1,
                 'recoveryFile': str(RECEIPTS / (binding['planSha256'] + '.recovery.json')),
                 'receiptFile': str(RECEIPTS / (binding['planSha256'] + '-9999999999999999999999999.result.json'))}
    else:
        model = {'kind': 'ID_RELEASE_ARTIFACT_RESULT_V1', 'version': 1, 'operation': 'restore', 'status': 'RESTORED',
                 'planSha256': binding['planSha256'], 'relativePath': RELATIVE, 'packageBytes': FILE_PINS[PACKAGE]['bytes'],
                 'restoredSha256': FILE_PINS[PACKAGE]['sha256'], 'currentUnchanged': True, 'containersUnchanged': True,
                 'metadataUnchanged': True, 'removed': False, 'fullRecoveryVerified': True,
                 'receiptFile': str(RECEIPTS / (binding['planSha256'] + '-9999999999999999999999999.restore.json'))}
    need(len(canonical(wire(binding, complete_result(binding, model, plan, before)))) + 4096 <= MAX_WIRE,
         'ARTIFACT_APPLY_RECEIPT_BUDGET')


def execute_native(binding):
    validate_binding(binding)
    need(os.geteuid() == 0, 'ARTIFACT_ROOT_REQUIRED')
    root = stage_root(binding)
    for path, pin in binding['sourcePins'].items():
        for directory in (root, *(root / path).parents):
            if directory == root or root in directory.parents:
                info = directory.lstat()
                need(directory.resolve() == directory and stat.S_ISDIR(info.st_mode)
                     and info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                     'ARTIFACT_STAGED_DIRECTORY_CHANGED')
        raw, unused = regular(root / path, mode=0o600)
        need(len(raw) == pin['bytes'] and sha(raw) == pin['sha256'], 'ARTIFACT_STAGED_SOURCE_CHANGED')
    before = snapshot(binding['expectedCurrent'], context='OPERATION_BEFORE')
    arguments = ['python3', '-B', str(root / NATIVE_PATH)]
    flags = ['--expected-current', binding['expectedCurrent'], '--cloud-proof-json', str(root / PROOF_PATH),
             '--expected-cloud-proof-sha256', binding['sourcePins'][PROOF_PATH]['sha256'],
             '--expected-source-sha256', binding['sourcePins'][NATIVE_PATH]['sha256']]
    def invoke(operation):
        final = arguments + [operation] + flags
        if operation != 'plan':
            final += ['--approved-plan-sha256', binding['planSha256']]
        process = subprocess.run(final, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1500)
        need(process.stderr == b'' and len(process.stdout) <= MAX_BODY
             and len(process.stdout.strip().splitlines()) == 1, 'ARTIFACT_NATIVE_FAILED')
        result = closed(process.stdout)
        if process.returncode != 0:
            fields = {'kind', 'version', 'operation', 'status', 'code'}
            need(type(result) is dict and set(result) in (fields, fields | {'receiptFile'})
                 and result['kind'] == 'ID_RELEASE_ARTIFACT_FAILURE_V1' and type(result['version']) is int
                 and result['version'] == 1 and result['operation'] == operation and result['status'] == 'FAILED_CLOSED'
                 and matches(re.compile(r'ARTIFACT_[A-Z_]+\Z'), result['code']), 'ARTIFACT_NATIVE_FAILED')
            error = Rejected(result['code'])
            if 'receiptFile' in result:
                error.receiptFile = str(receipt_path(result['receiptFile']))
            raise error
        need(type(result) is dict and matches(HEX64, result.get('planSha256')), 'ARTIFACT_NATIVE_RESULT_INVALID')
        return result
    if binding['operation'] == 'restore':
        plan = read_plan(binding, binding['planSha256'])
        apply_receipt_budget(binding, None, plan, before)
        need(snapshot(binding['expectedCurrent'], context='OPERATION_PREAPPLY') == before,
             'ARTIFACT_PRODUCTION_CHANGED')
        native = invoke('restore')
        validate_native(native, binding, 'restore', plan)
    else:
        native = invoke('plan')
        plan = read_plan(binding, native['planSha256'], native.get('planFile'))
        validate_native(native, binding, 'plan', plan)
        need(plan['sourceProbe'] == before, 'ARTIFACT_PLAN_PROTECTION_CHANGED')
        if binding['operation'] == 'archive':
            need(digest(plan) == binding['planSha256'], 'ARTIFACT_APPROVED_PLAN_CHANGED')
            apply_receipt_budget(binding, native, plan, before)
            need(snapshot(binding['expectedCurrent'], context='OPERATION_PREAPPLY') == before,
                 'ARTIFACT_PRODUCTION_CHANGED')
            native = invoke('apply')
            validate_native(native, binding, 'apply', plan)
    if binding['operation'] != 'verify':
        path = receipt_path(native['receiptFile'])
        need(path.name.startswith(binding['planSha256'] + '-'), 'ARTIFACT_NATIVE_RECEIPT_CHANGED')
        saved = closed(regular(path, MAX_BODY, mode=0o600)[0])
        need(saved == {key: value for key, value in native.items() if key != 'receiptFile'},
             'ARTIFACT_NATIVE_RECEIPT_CHANGED')
        if binding['operation'] == 'archive':
            index = receipt_path(native['recoveryFile'], binding['planSha256'] + '.recovery.json')
            raw, unused = regular(index, MAX_BODY, mode=0o600)
            recovery = closed(raw)
            need(sha(raw) == native['recoveryIndexSha256'] and type(recovery) is dict
                 and recovery.get('kind') == 'ID_RELEASE_ARTIFACT_RECOVERY_V1'
                 and recovery.get('planSha256') == binding['planSha256'] and recovery.get('plan') == plan,
                 'ARTIFACT_RECOVERY_RECEIPT_CHANGED')
    need(snapshot(binding['expectedCurrent'], context='OPERATION_AFTER') == before, 'ARTIFACT_PRODUCTION_CHANGED')
    return complete_result(binding, native, plan, before)


def remote_program(binding, *, path=None, payload=None):
    validate_binding(binding)
    need((path is None and payload is None) or (path in PATHS and type(payload) is str),
         'ARTIFACT_REMOTE_SCOPE_INVALID')
    functions = (need, matches, canonical, sha, digest, closed, identity, regular, command, snapshot,
                 validate_binding, stage_root, wire)
    functions += ((stage_file,) if path is not None else
                  (validate_plan, receipt_path, read_plan, validate_native, complete_result,
                   apply_receipt_budget, execute_native))
    program = ('import base64,fcntl,gzip,hashlib,json,lzma,os,re,stat,subprocess,time,zlib\n'
               'from pathlib import Path\nclass Rejected(RuntimeError):pass\n')
    for name in ('BASE', 'INSTANCE', 'REGION', 'ACCOUNT', 'REPOSITORY', 'NATIVE_PATH', 'PROOF_PATH',
                 'PATHS', 'OPERATIONS', 'MAX_BODY', 'MAX_WIRE', 'WIRE_KIND', 'FAILURE_KIND',
                 'RECEIPTS', 'FOLDER', 'PACKAGE', 'RELATIVE', 'FILE_PINS'):
        value = globals()[name]
        program += name + '=' + ('Path(' + repr(str(value)) + ')' if isinstance(value, Path) else repr(value)) + '\n'
    for name in ('HEX40', 'HEX64', 'UUID', 'POSITIVE'):
        program += name + '=re.compile(' + repr(globals()[name].pattern) + ')\n'
    program += '\n'.join(inspect.getsource(function) for function in functions)
    if path is not None:
        decoder = lzma.LZMADecompressor(memlimit=64 * 1024**2)
        raw = decoder.decompress(base64.b64decode(payload, validate=True), max_length=binding['sourcePins'][path]['bytes'] + 1)
        need(decoder.eof and not decoder.unused_data and len(raw) == binding['sourcePins'][path]['bytes']
             and sha(raw) == binding['sourcePins'][path]['sha256'], 'ARTIFACT_STAGE_SOURCE_CHANGED')
        # One outer compression keeps the actual source and verifier within the SSM command limit.
        expression = 'stage_file(binding,' + repr(path) + ',' + repr(raw) + ')'
    else:
        expression = 'execute_native(binding)'
    program += '\nbinding=' + repr(binding) + '\ntry:\n result=' + expression + '\n'
    program += ' print(json.dumps(wire(binding,result),sort_keys=True))\n'
    program += ("except Exception as error:\n code=str(error) if type(error)is Rejected and re.fullmatch("
                "'ARTIFACT_[A-Z_]+',str(error))else'ARTIFACT_REMOTE_FAILED_CLOSED'\n"
                " failure={'kind':FAILURE_KIND,'version':1,'bindingSha256':digest(binding),"
                "'operation':binding['operation'],'producer':binding['producer'],'status':'FAILED_CLOSED','code':code}\n"
                " if type(error)is Rejected and hasattr(error,'receiptFile'):failure['nativeReceiptFile']=error.receiptFile\n"
                " print(json.dumps(failure))\n"
                ' raise SystemExit(1)\n')
    compile(program, '<release-artifact-retention-remote>', 'exec')
    raw = program.encode()
    packed = base64.b64encode(lzma.compress(raw)).decode()
    loader = ('import base64,hashlib,lzma;d=lzma.LZMADecompressor(memlimit=64*1024**2);'
              'r=d.decompress(base64.b64decode(' + repr(packed) + ',validate=True),max_length=' + str(len(raw) + 1) + ');'
              'assert len(r)==' + str(len(raw)) + ' and d.eof and not d.unused_data and '
              'hashlib.sha256(r).hexdigest()==' + repr(sha(raw)) + ';exec(compile(r,"<release-artifact-retention-remote>","exec"))')
    text = 'python3 -B -c ' + shlex.quote(loader)
    parameters = {'commands': [text], 'executionTimeout': ['1500' if path is None else '180']}
    need(len(text.encode()) <= MAX_COMMAND and len(canonical(parameters)) < 24 * 1024,
         'ARTIFACT_SSM_COMMAND_BOUND')
    return parameters


class SsmClient(disk_module().SsmClient):
    """Reuse the deployment-owner reconciliation guard with a separate closed wire."""
    def execute(self, name, parameters, binding):
        validate_binding(binding)
        need(re.fullmatch(r'[a-z0-9-]{1,80}', name), 'ARTIFACT_RECEIPT_NAME_INVALID')
        common = storage_module()
        intent = self.directory / (name + '.intent.json')
        acceptance = self.directory / (name + '.accepted.json')
        terminal = self.directory / (name + '.result.json')
        request = {'bindingSha256': digest(binding), 'parametersSha256': digest(parameters), 'instanceId': INSTANCE}
        if terminal.exists() or terminal.is_symlink():
            prior = closed(common.read_file(terminal, MAX_BODY, private=True))
            need(prior.get('request') == request, 'ARTIFACT_PRIOR_RESULT_CHANGED')
            need(prior.get('status') == 'Success' and matches(UUID, prior.get('commandId')),
                 'ARTIFACT_PRIOR_TERMINAL_FAILED')
            result = decode_wire(prior['wire'], binding)
            self.confirmed.add(prior['commandId']); return result
        if acceptance.exists() or acceptance.is_symlink():
            accepted = closed(common.read_file(acceptance, private=True))
            need(accepted.get('request') == request and matches(UUID, accepted.get('commandId')),
                 'ARTIFACT_ACCEPTANCE_CHANGED')
            command_id = accepted['commandId']; self.unsettled.add(command_id)
        else:
            need(not intent.exists() and not intent.is_symlink(), 'ARTIFACT_SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED')
            self.check_prior_commands()
            common.save(intent, {'request': request, 'status': 'SEND_INTENT_RECORDED'})
            value = self.commands.aws('ssm', 'send-command', '--cli-input-json', canonical({
                'InstanceIds': [INSTANCE], 'DocumentName': 'AWS-RunShellScript',
                'Comment': 'ID release artifact retention ' + binding['operation'] + ' ' + name,
                'Parameters': parameters}).decode())
            accepted = value.get('Command') if type(value) is dict else None
            need(type(accepted) is dict and matches(UUID, accepted.get('CommandId'))
                 and accepted.get('InstanceIds') == [INSTANCE] and accepted.get('DocumentName') == 'AWS-RunShellScript',
                 'ARTIFACT_SSM_ACCEPTANCE_INVALID')
            command_id = accepted['CommandId']; self.unsettled.add(command_id)
            common.save(acceptance, {'request': request, 'commandId': command_id, 'status': 'ACCEPTED_RESULT_UNKNOWN'})
        deadline = self.monotonic() + 1550
        while self.monotonic() < deadline:
            invocation = self.commands.aws('ssm', 'get-command-invocation', '--command-id', command_id,
                                          '--instance-id', INSTANCE, invocation=True)
            need(type(invocation) is dict, 'ARTIFACT_SSM_INVOCATION_INVALID')
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                self.sleep(10); continue
            need(invocation.get('CommandId') == command_id and invocation.get('InstanceId') == INSTANCE
                 and invocation.get('DocumentName') == 'AWS-RunShellScript'
                 and invocation.get('PluginName') == 'aws:runShellScript', 'ARTIFACT_SSM_INVOCATION_INVALID')
            output = invocation.get('StandardOutputContent')
            failed = (invocation.get('Status') != 'Success' or type(invocation.get('ResponseCode')) is not int
                      or invocation['ResponseCode'] != 0 or invocation.get('StandardErrorContent') != '')
            if failed:
                safe = {'kind': FAILURE_KIND, 'status': 'FAILED_CLOSED'}
                if type(output) is str and 0 < len(output.encode()) < MAX_STDOUT:
                    try:
                        value = closed(output, MAX_STDOUT)
                        fields = {'kind', 'version', 'bindingSha256', 'operation', 'producer', 'status', 'code'}
                        if (type(value) is dict and set(value) in (fields, fields | {'nativeReceiptFile'})
                            and value['kind'] == FAILURE_KIND
                            and type(value['version']) is int and value['version'] == 1
                            and value['bindingSha256'] == digest(binding) and value['operation'] == binding['operation']
                            and value['producer'] == binding['producer'] and value['status'] == 'FAILED_CLOSED'
                            and matches(re.compile(r'ARTIFACT_[A-Z_]+\Z'), value['code'])):
                            safe['code'] = value['code']
                            path = value.get('nativeReceiptFile')
                            if (type(path) is str and Path(path).parent == RECEIPTS
                                    and re.fullmatch(r'[a-f0-9]{64}-[1-9][0-9]{0,24}\.result\.json', Path(path).name)):
                                safe['nativeReceiptFile'] = path
                    except Exception:
                        pass
                common.save(terminal, {'request': request, 'commandId': command_id, 'status': 'Failed', 'failure': safe,
                    'invocationCanonicalSha256': digest(invocation),
                    'originalReceipt': {'CommandId': command_id, 'InstanceId': INSTANCE,
                        'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                        'Status': invocation['Status'] if invocation.get('Status') in (
                            'Success', 'Failed', 'Cancelled', 'TimedOut', 'Cancelling') else 'INVALID',
                        'ResponseCode': invocation['ResponseCode'] if type(invocation.get('ResponseCode')) is int
                            and -1 <= invocation['ResponseCode'] <= 255 else None},
                    'rawOutputSuppressed': True})
                raise Rejected('ARTIFACT_REMOTE_TERMINAL_FAILED')
            need(type(output) is str and 0 < len(output.encode()) < MAX_STDOUT
                 and len(output.strip().splitlines()) == 1, 'ARTIFACT_SSM_OUTPUT_INVALID')
            value = closed(output, MAX_STDOUT)
            result = decode_wire(value, binding)
            common.save(terminal, {'request': request, 'commandId': command_id, 'status': 'Success',
                                  'invocationCanonicalSha256': digest(invocation), 'wire': value})
            self.unsettled.discard(command_id); self.confirmed.add(command_id); return result
        raise Rejected('ARTIFACT_ACCEPTED_RESULT_PENDING')


def validate_result(result, binding):
    fields = {'kind', 'version', 'operation', 'producer', 'expectedCurrent', 'status', 'planSha256', 'plan',
              'nativeResult', 'sourceProbe', 'baselineSha256', 'currentUnchanged', 'containersUnchanged',
              'websiteServicesChanged'}
    need(type(result) is dict and set(result) == fields
         and result['kind'] == 'ID_RELEASE_ARTIFACT_RETENTION_TRANSPORT_RESULT_V1'
         and type(result['version']) is int and result['version'] == 1
         and result['operation'] == binding['operation'] and result['producer'] == binding['producer']
         and result['expectedCurrent'] == binding['expectedCurrent'] and matches(HEX64, result['planSha256'])
         and result['currentUnchanged'] is True and result['containersUnchanged'] is True
         and result['websiteServicesChanged'] is False and digest(result['sourceProbe']) == result['baselineSha256'],
         'ARTIFACT_RESULT_INVALID')
    plan = validate_plan(result['plan'], binding, result['planSha256'])
    operation = {'verify': 'plan', 'archive': 'apply', 'restore': 'restore'}[binding['operation']]
    validate_native(result['nativeResult'], binding, operation, plan)
    need(result['status'] == result['nativeResult']['status']
         and (binding['operation'] == 'restore' or result['sourceProbe'] == plan['sourceProbe']),
         'ARTIFACT_RESULT_PROTECTION_CHANGED')
    return result


def save_once(directory, name, value):
    common = storage_module()
    path = directory / name
    if path.exists() or path.is_symlink():
        need(closed(common.read_file(path, MAX_BODY, private=True)) == value, 'ARTIFACT_PRIOR_RESULT_CHANGED')
    else:
        common.save(path, value)


def execute(environment=None, commands=None, client=None):
    selected = selection(os.environ if environment is None else environment)
    common = storage_module(); commands = commands or common.Commands()
    binding, sources = source_binding(selected, commands)
    directory = private_directory(selected)
    save_once(directory, 'source-binding.json', binding)
    client = client or SsmClient(commands, directory)
    for index, path in enumerate(PATHS):
        payload = base64.b64encode(lzma.compress(sources[path])).decode()
        result = client.execute('stage-' + str(index), remote_program(binding, path=path, payload=payload), binding)
        validate_ack(result, binding, path)
    result = client.execute('operation', remote_program(binding), binding)
    validate_result(result, binding)
    save_once(directory, 'complete-plan.json', result['plan'])
    save_once(directory, 'final-result.json', {'bindingSha256': digest(binding), 'result': result})
    return result


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.validate_only:
            selected = selection(os.environ)
            print(json.dumps({'status': 'ARTIFACT_SELECTION_VERIFIED', 'operation': selected['operation']})); return 0
        result = execute()
        native = result['nativeResult']
        print(json.dumps({'status': result['status'], 'operation': result['operation'], 'planSha256': result['planSha256'],
                          'packageBytes': native['packageBytes'], 'removed': native['removed'],
                          'currentUnchanged': True, 'containersUnchanged': True,
                          'freeBytesBefore': native.get('freeBytesBefore'), 'freeBytesAfter': native.get('freeBytesAfter')}))
        return 0
    except Exception as error:
        code = str(error) if (isinstance(error, Rejected) or isinstance(error, disk_module().Rejected)) and re.fullmatch(
            r'(?:ARTIFACT|MAINTENANCE)_[A-Z_]+', str(error)) else 'ARTIFACT_FAILED_CLOSED'
        print(json.dumps({'status': 'FAILED_CLOSED', 'code': code, 'rawOutputSuppressed': True})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
