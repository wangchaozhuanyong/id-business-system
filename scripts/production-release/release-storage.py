"""Bound normal component publication to the installed disk-retention lifecycle.

This transport sends only closed identifiers and measured public build metadata.
It never installs a program, pulls an image, starts a service or writes a database.
The native maintainer owns deployment locking, image removal and current readback.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import stat
import subprocess
import time


HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
OUTPUT = PROJECT / '.deploy/production-release/storage'
NATIVE = '/opt/id-business-v2/maintenance/disk-retention/disk-retention.py'
CONFIG = '/opt/id-business-v2/maintenance/disk-retention/config.json'
POLICY = PROJECT / 'deploy/aws/disk-retention-policy-20261014.json'
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
GITHUB_REPOSITORY = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}\Z')
POSITIVE = re.compile(r'[1-9][0-9]{0,19}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
MAX_PROOF = 128 * 1024
MAX_SOURCE_ARCHIVE = 256 * 1024**2
MAX_OUTPUT = 24000
PROOFS = {
    'release_admin': ('admin-pending-online-build-proof.json', 'ADMIN_PENDING_ONLINE_BUILD'),
    'release_online_recharge': ('online-recharge-build-proof.json', 'ONLINE_RECHARGE'),
    'release_api_admin': ('api-admin-build-proof.json', None),
    'release_api_workspace': ('api-workspace-build-proof.json', 'API_ADMIN_WORKSPACE'),
    'release_api_admin_migration': ('api-admin-migration-build-proof.json', 'API_ADMIN_MIGRATION'),
    'release_unpublished_components': ('unpublished-component-successor-build-proof.json', 'UNPUBLISHED_COMPONENT_BUILD'),
    'release_recharge_flow': ('recharge-flow-successor-build-proof.json', 'RECHARGE_FLOW_BUILD'),
}
READBACKS = {
    'release_admin': 'admin-independent-readback-result.json',
    'release_online_recharge': 'online-recharge-readback-result.json',
    'release_api_admin': 'api-admin-readback-result.json',
    'release_api_workspace': 'api-workspace-readback-result.json',
    'release_api_admin_migration': 'api-admin-migration-readback-result.json',
    'release_unpublished_components': 'unpublished-component-successor-readback.json',
    'release_recharge_flow': 'recharge-flow-successor-readback.json',
}
OPERATIONS = frozenset(PROOFS) | {'release'}


class StorageRejected(RuntimeError):
    """Only fixed codes leave the transport; raw process output never does."""


def need(condition, code='STORAGE_INPUT_INVALID'):
    if not condition:
        raise StorageRejected(code)


def matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def closed(raw, limit=MAX_PROOF):
    need(type(raw) in (bytes, str) and 0 < len(raw if type(raw) is bytes else raw.encode()) <= limit,
         'STORAGE_JSON_BOUND')
    def unique(items):
        result = {}
        for key, value in items:
            need(key not in result, 'STORAGE_DUPLICATE_FIELD')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: need(False, 'STORAGE_NONFINITE_JSON'))
    except StorageRejected:
        raise
    except Exception:
        raise StorageRejected('STORAGE_JSON_INVALID') from None


def candidate_module():
    spec = importlib.util.spec_from_file_location('release_storage_candidate', HERE / 'candidate-retention.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selection(environment):
    operation = environment.get('RELEASE_OPERATION')
    need(operation in OPERATIONS, 'STORAGE_CLOSED_BUILD_PROOF_REQUIRED')
    need(environment.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and not any(environment.get(key) for key in (
             'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
             'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256')),
         'STORAGE_HISTORICAL_OR_REUSED_BUILD_EXCLUDED')
    producer = {'commit': environment.get('RELEASE_COMMIT'), 'sourceTree': environment.get('SOURCE_TREE'),
                'workflowRunId': environment.get('GITHUB_RUN_ID'),
                'workflowRunAttempt': environment.get('GITHUB_RUN_ATTEMPT')}
    need(all(matches(HEX40, producer[key]) for key in ('commit', 'sourceTree'))
         and all(matches(POSITIVE, producer[key]) for key in ('workflowRunId', 'workflowRunAttempt'))
         and matches(POSITIVE, environment.get('QUALITY_RUN_ID'))
         and matches(HEX40, environment.get('EXPECTED_CURRENT')), 'STORAGE_PRODUCER_INVALID')
    need(environment.get('RELEASE_REPOSITORY') == REPOSITORY
         and environment.get('GITHUB_REPOSITORY') == GITHUB_REPOSITORY
         and environment.get('PRODUCTION_INSTANCE_ID') == INSTANCE
         and environment.get('AWS_REGION') == REGION
         and environment.get('GITHUB_REF') == 'refs/heads/main', 'STORAGE_TARGET_INVALID')
    return {'operation': operation, 'producer': producer, 'qualityRunId': environment['QUALITY_RUN_ID'],
            'expectedCurrent': environment['EXPECTED_CURRENT'],
            'adminOnly': environment.get('RELEASE_ADMIN_ONLY'),
            'batch': '-'.join(producer[key] for key in ('commit', 'workflowRunId', 'workflowRunAttempt'))}


class Commands:
    def run(self, arguments, *, limit=MAX_PROOF, timeout=60, allowed=(0,)):
        try:
            process = subprocess.run(arguments, cwd=PROJECT, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, timeout=timeout)
        except Exception:
            raise StorageRejected('STORAGE_PROCESS_FAILED') from None
        need(process.returncode in allowed and len(process.stdout) <= limit, 'STORAGE_PROCESS_FAILED')
        return process.returncode, process.stdout

    def git(self, *arguments, limit=MAX_PROOF, allowed=(0,)):
        return self.run(['git', *arguments], limit=limit, allowed=allowed)

    def aws(self, *arguments, invocation=False):
        try:
            process = subprocess.run(['aws', '--region', REGION, *arguments, '--output', 'json'],
                                     cwd=PROJECT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        except Exception:
            raise StorageRejected('STORAGE_AWS_FAILED') from None
        if invocation and process.returncode and b'InvocationDoesNotExist' in process.stderr:
            return {'Status': 'Pending'}
        need(process.returncode == 0, 'STORAGE_AWS_FAILED')
        return closed(process.stdout, 2 * 1024**2)

    def quality(self, run):
        _, raw = self.run(['gh', 'api', f'repos/{GITHUB_REPOSITORY}/actions/runs/{run}'], limit=128 * 1024)
        return closed(raw)

    def archive_size(self, revision):
        need(matches(HEX40, revision), 'STORAGE_SOURCE_ARCHIVE_INVALID')
        process = None
        total = 0
        try:
            process = subprocess.Popen(['git', 'archive', '--format=tar', revision], cwd=PROJECT,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 60
            with selectors.DefaultSelector() as watcher:
                watcher.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    need(remaining > 0, 'STORAGE_SOURCE_ARCHIVE_TIMEOUT')
                    ready = watcher.select(min(remaining, 1))
                    if not ready:
                        continue
                    block = os.read(process.stdout.fileno(), 65536)
                    if not block:
                        break
                    total += len(block)
                    need(total <= MAX_SOURCE_ARCHIVE, 'STORAGE_SOURCE_ARCHIVE_BOUND')
            need(process.wait(timeout=max(0.1, deadline - time.monotonic())) == 0,
                 'STORAGE_SOURCE_ARCHIVE_INVALID')
            need(0 < total <= MAX_SOURCE_ARCHIVE and total % 512 == 0, 'STORAGE_SOURCE_ARCHIVE_INVALID')
            return total
        except StorageRejected:
            raise
        except Exception:
            raise StorageRejected('STORAGE_SOURCE_ARCHIVE_INVALID') from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill(); process.wait()
                if process.stdout is not None:
                    process.stdout.close()


def verify_source(selected, commands, *, require_main=True):
    producer = selected['producer']
    for revision, expected in (('HEAD', producer['commit']), ('HEAD^{tree}', producer['sourceTree'])):
        _, raw = commands.git('rev-parse', revision, limit=200)
        need(raw.decode().strip() == expected, 'STORAGE_GIT_SOURCE_DRIFT')
    if require_main:
        _, remote = commands.git('ls-remote', 'origin', 'refs/heads/main', limit=200)
        need(remote.decode().strip().split() == [producer['commit'], 'refs/heads/main'],
             'STORAGE_MAIN_HEAD_DRIFT')
    run = commands.quality(selected['qualityRunId'])
    need(type(run) is dict and type(run.get('id')) is int and str(run['id']) == selected['qualityRunId']
         and run.get('head_sha') == producer['commit'] and run.get('head_branch') == 'main'
         and run.get('event') == 'push' and run.get('status') == 'completed'
         and run.get('conclusion') == 'success' and run.get('path') == '.github/workflows/quality.yml',
         'STORAGE_QUALITY_NOT_BOUND')


def read_file(path, limit=MAX_PROOF, private=False):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'STORAGE_PATH_INVALID')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            first = os.fstat(stream.fileno())
            identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
                                      value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            need(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and 0 < first.st_size <= limit,
                 'STORAGE_FILE_INVALID')
            if private:
                need(first.st_uid == os.geteuid() and stat.S_IMODE(first.st_mode) == 0o600,
                     'STORAGE_PRIVATE_FILE_INVALID')
            raw = stream.read(limit + 1)
            need(len(raw) == first.st_size and identity(first) == identity(os.fstat(stream.fileno()))
                 == identity(path.lstat()), 'STORAGE_FILE_CHANGED')
            return raw
    except StorageRejected:
        raise
    except Exception:
        raise StorageRejected('STORAGE_FILE_UNAVAILABLE') from None


def policy_binding():
    policy = closed(read_file(POLICY, 24000), 24000)
    need(type(policy) is dict and matches(HEX64, policy.get('sourceSha256')),
         'STORAGE_POLICY_INVALID')
    source = read_file(HERE / 'disk-retention.py', 2 * 1024**2)
    need(hashlib.sha256(source).hexdigest() == policy['sourceSha256'], 'STORAGE_NATIVE_SOURCE_DRIFT')
    return policy['sourceSha256'], digest({key: value for key, value in policy.items() if key != 'approved'})


def proof_images(selected, proof):
    versions = (1, 2, 3) if selected['operation'] == 'release_online_recharge' else (1,)
    need(type(proof) is dict and type(proof.get('version')) is int and proof['version'] in versions
         and proof.get('commit') == selected['producer']['commit']
         and proof.get('sourceTree') == selected['producer']['sourceTree'], 'STORAGE_BUILD_PROOF_DRIFT')
    operation = selected['operation']
    _, wanted_scope = PROOFS[operation]
    if wanted_scope is None:
        need('scope' not in proof, 'STORAGE_BUILD_SCOPE_DRIFT')
    else:
        need(proof.get('scope') == wanted_scope, 'STORAGE_BUILD_SCOPE_DRIFT')
    if operation in ('release_admin', 'release_unpublished_components', 'release_recharge_flow'):
        need(proof.get('runId') == selected['producer']['workflowRunId']
             and proof.get('runAttempt') == selected['producer']['workflowRunAttempt']
             and proof.get('qualityRunId') == selected['qualityRunId'], 'STORAGE_BUILD_PRODUCER_DRIFT')
    images = {'admin': proof.get('image')} if operation == 'release_admin' else proof.get('images')
    module, roles = candidate_module().OPERATION_SCOPES[operation]
    need(type(images) is dict and set(images) == roles, 'STORAGE_BUILD_BATCH_INCOMPLETE')
    for role, row in images.items():
        need(type(row) is dict and row.get('reference') == REPOSITORY + ':' + selected['batch'] + '-' + role
             and matches(IMAGE_ID, row.get('imageId')), 'STORAGE_BUILD_IMAGE_DRIFT')
    return module, images


def image_measurement(reference, expected_id, selected, commands):
    format_string = ('{"Id":{{json .Id}},"Size":{{json .Size}},"Architecture":{{json .Architecture}},'
                     '"Labels":{{json .Config.Labels}}}')
    _, raw = commands.run(['docker', 'image', 'inspect', '--format', format_string, reference], limit=65536)
    image = closed(raw, 65536)
    labels = image.get('Labels') if type(image) is dict else None
    need(type(image) is dict and image.get('Id') == expected_id and image.get('Architecture') == 'amd64'
         and type(image.get('Size')) is int and 0 < image['Size'] <= 1024**4 and type(labels) is dict
         and labels.get('org.opencontainers.image.revision') == selected['producer']['commit']
         and (labels.get('id-business-v2.source-tree') == selected['producer']['sourceTree']
              or selected['operation'] == 'release' and 'id-business-v2.source-tree' not in labels),
         'STORAGE_RUNNER_IMAGE_DRIFT')
    tag = reference[len(REPOSITORY) + 1:]
    remote = commands.aws('ecr', 'batch-get-image', '--repository-name', 'id-business-v2-release',
                          '--image-ids', 'imageTag=' + tag,
                          '--accepted-media-types', 'application/vnd.docker.distribution.manifest.v2+json',
                          'application/vnd.oci.image.manifest.v1+json')
    need(type(remote) is dict and remote.get('failures', []) == [] and type(remote.get('images')) is list
         and len(remote['images']) == 1, 'STORAGE_ECR_BATCH_INCOMPLETE')
    row = remote['images'][0]
    need(type(row) is dict and row.get('registryId') == REPOSITORY.split('.')[0]
         and row.get('repositoryName') == 'id-business-v2-release' and type(row.get('imageId')) is dict
         and row['imageId'].get('imageTag') == tag and matches(IMAGE_ID, row['imageId'].get('imageDigest')),
         'STORAGE_ECR_REFERENCE_DRIFT')
    raw_manifest = row.get('imageManifest')
    manifest = closed(raw_manifest, 2 * 1024**2)
    need('sha256:' + hashlib.sha256(raw_manifest.encode()).hexdigest() == row['imageId']['imageDigest']
         and type(manifest) is dict and type(manifest.get('schemaVersion')) is int
         and manifest['schemaVersion'] == 2 and type(manifest.get('config')) is dict
         and manifest['config'].get('digest') == expected_id and type(manifest.get('layers')) is list
         and 0 < len(manifest['layers']) <= 200, 'STORAGE_ECR_CONFIG_DRIFT')
    descriptors = [manifest['config'], *manifest['layers']]
    sizes = {}
    for descriptor in descriptors:
        need(type(descriptor) is dict and matches(IMAGE_ID, descriptor.get('digest'))
             and type(descriptor.get('size')) is int and 0 < descriptor['size'] <= 1024**4,
             'STORAGE_ECR_SIZE_INVALID')
        identity = descriptor['digest']
        need(identity not in sizes or sizes[identity] == descriptor['size'], 'STORAGE_ECR_LAYER_DRIFT')
        sizes[identity] = descriptor['size']
    compressed = sum(sizes.values())
    need(0 < compressed <= 1024**4, 'STORAGE_ECR_SIZE_INVALID')
    return {'reference': reference, 'imageId': expected_id, 'sizeBytes': image['Size'], 'compressedBytes': compressed}


def normal_release_record(selected, commands):
    need(selected['adminOnly'] in ('true', 'false'), 'STORAGE_NORMAL_BUILD_SELECTION_MISSING')
    # Reuse the same source-based selector used by build-images.sh. A mutable
    # environment flag alone cannot shrink a complete five-image candidate.
    program = ("import { execFileSync } from 'node:child_process'; "
               "import { isAdminOnly } from './scripts/ci-recharge-scope.mjs'; "
               "const paths=execFileSync('git',['diff','--name-only',process.env.EXPECTED_CURRENT,"
               "process.env.RELEASE_COMMIT],{encoding:'utf8'}).trim().split('\\n').filter(Boolean); "
               "console.log(isAdminOnly(paths));")
    _, raw = commands.run(['node', '--input-type=module', '-e', program], limit=100)
    need(raw.decode().strip() == selected['adminOnly'], 'STORAGE_NORMAL_BUILD_SELECTION_DRIFT')
    roles = ('admin',) if selected['adminOnly'] == 'true' else ('admin', 'api', 'migrate', 'auto-recharge', 'media-resolver')
    measured = {}
    for role in roles:
        reference = REPOSITORY + ':' + selected['batch'] + '-' + role
        _, raw = commands.run(['docker', 'image', 'inspect', '--format', '{{json .Id}}', reference], limit=200)
        identity = closed(raw, 200)
        need(matches(IMAGE_ID, identity), 'STORAGE_NORMAL_BUILD_IMAGE_MISSING')
        measured[role] = image_measurement(reference, identity, selected, commands)
    # A normal release has no existing component build-proof file. Record only
    # the exact Git/Quality producer and actual inspected, ECR-bound image set.
    proof = {'kind': 'NORMAL_RELEASE_STORAGE_BUILD', 'version': 1, 'scope': 'NORMAL_RELEASE_STORAGE_BUILD',
             'producer': selected['producer'], 'qualityRunId': selected['qualityRunId'],
             'adminOnly': selected['adminOnly'] == 'true',
             'images': {role: {'reference': row['reference'], 'imageId': row['imageId']}
                        for role, row in measured.items()}}
    return 'admin' if selected['adminOnly'] == 'true' else 'full-release', measured, proof


def build_record(selected, commands, proof=None):
    if selected['operation'] == 'release':
        need(proof is None, 'STORAGE_NORMAL_BUILD_PROOF_UNEXPECTED')
        module, measured, proof = normal_release_record(selected, commands)
    else:
        proof_name, _ = PROOFS[selected['operation']]
        proof = closed(read_file(PROJECT / '.deploy/production-release' / proof_name)) if proof is None else proof
        module, images = proof_images(selected, proof)
        measured = {role: image_measurement(row['reference'], row['imageId'], selected, commands)
                    for role, row in sorted(images.items())}
    record = {'kind': 'DISK_CANDIDATE_RECORD_V1', 'version': 1, 'batch': selected['batch'], 'module': module,
              'operation': selected['operation'], 'producer': selected['producer'],
              'qualityRunId': selected['qualityRunId'], 'proofSha256': digest(proof), 'images': measured}
    return candidate_module().validate_record(record)


def source_archive_bytes(selected, commands):
    measured = commands.archive_size(selected['producer']['commit'])
    need(type(measured) is int and 0 < measured <= MAX_SOURCE_ARCHIVE and measured % 512 == 0,
         'STORAGE_SOURCE_ARCHIVE_INVALID')
    return measured


def supersedes(record, before, commands):
    candidate = candidate_module()
    need(type(before) is dict and type(before.get('pendingRecords')) is list
         and before.get('seedRecords') == [], 'STORAGE_PENDING_RECORDS_INVALID')
    instructions = []
    seen = set()
    for old in before['pendingRecords']:
        old = candidate.validate_record(old)
        need(old['module'] not in seen, 'STORAGE_DUPLICATE_PENDING_MODULE')
        seen.add(old['module'])
        if old['module'] != record['module']:
            continue
        if old['batch'] == record['batch']:
            need(old == record, 'STORAGE_REGISTERED_RECORD_DRIFT')
            continue
        ancestor, descendant = old['producer']['commit'], record['producer']['commit']
        _, tree = commands.git('rev-parse', ancestor + '^{tree}', limit=200)
        need(tree.decode().strip() == old['producer']['sourceTree'], 'STORAGE_ANCESTOR_TREE_DRIFT')
        code, _ = commands.git('merge-base', '--is-ancestor', ancestor, descendant, limit=200, allowed=(0, 1))
        need(code == 0, 'STORAGE_SUPERSESSION_NOT_ANCESTOR')
        proof = {'kind': 'DISK_CANDIDATE_ANCESTRY_V1', 'policySha256': before['policySha256'],
                 'ancestorRecordSha256': candidate.record_sha256(old),
                 'descendantRecordSha256': candidate.record_sha256(record),
                 'ancestorCommit': ancestor, 'descendantCommit': descendant,
                 'ancestorTree': old['producer']['sourceTree'], 'descendantTree': record['producer']['sourceTree']}
        instructions.append({'batch': old['batch'], 'basis': 'pending',
                             'ancestry': {'ancestorCommit': ancestor, 'descendantCommit': descendant,
                                          'approved': True, 'proofSha256': digest(proof)}})
    return instructions


def remote_parameters(phase, expected, source_sha256, event):
    need(phase in ('before-build', 'before-pull', 'after-publish') and matches(HEX40, expected)
         and matches(HEX64, source_sha256), 'STORAGE_COMMAND_INPUT_INVALID')
    encoded = base64.b64encode(canonical(event)).decode()
    arguments = ['python3', '-B', NATIVE, '--config', CONFIG, '--expected-current', expected,
                 '--expected-source-sha256', source_sha256, '--phase', phase, '--event-base64', encoded]
    command = 'test -f ' + shlex.quote(NATIVE) + ' && test -f ' + shlex.quote(CONFIG) + ' && ' + shlex.join(arguments)
    parameters = {'commands': [command], 'executionTimeout': ['1500']}
    need(len(command.encode()) <= 32 * 1024 and len(canonical(parameters)) <= 60 * 1024,
         'STORAGE_COMMAND_BOUND')
    return parameters


def validate_native(value, phase, policy_sha256):
    need(type(value) is dict and value.get('status') == 'APPLIED' and value.get('phase') == phase
         and value.get('policySha256') == policy_sha256, 'STORAGE_NATIVE_RESULT_INVALID')
    if phase == 'before-build':
        need(type(value.get('pendingRecords')) is list and value.get('seedRecords') == [],
             'STORAGE_NATIVE_PENDING_INVALID')
        candidate = candidate_module()
        need(len(value['pendingRecords']) <= len(OPERATIONS), 'STORAGE_NATIVE_PENDING_BOUND')
        for record in value['pendingRecords']:
            candidate.validate_record(record)
    elif phase == 'before-pull':
        need(value.get('capacityVerified') is True, 'STORAGE_NATIVE_CAPACITY_UNVERIFIED')
    else:
        need(value.get('publicationVerified') is True, 'STORAGE_NATIVE_PUBLICATION_UNVERIFIED')
    return value


def output_directory(selected):
    directory = OUTPUT / selected['batch']
    # Never follow a pre-existing alias while creating our private receipts.
    relative = directory.relative_to(PROJECT)
    current = PROJECT
    for part in relative.parts:
        current = current / part
        if not current.exists():
            current.mkdir(mode=0o700)
        need(current.resolve() == current and not current.is_symlink() and current.is_dir()
             and current.stat().st_uid == os.geteuid() and not stat.S_IMODE(current.stat().st_mode) & 0o022,
             'STORAGE_OUTPUT_DIRECTORY_INVALID')
    need(stat.S_IMODE(directory.stat().st_mode) == 0o700, 'STORAGE_PRIVATE_DIRECTORY_INVALID')
    return directory


def save(path, value):
    path = Path(path)
    need(path.parent.resolve() == path.parent and not path.parent.is_symlink(), 'STORAGE_OUTPUT_PATH_INVALID')
    raw = canonical(value) + b'\n'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())


class LifecycleClient:
    def __init__(self, commands, sleep=time.sleep, monotonic=time.monotonic):
        self.commands, self.sleep, self.monotonic = commands, sleep, monotonic

    def execute(self, phase, parameters, directory, policy_sha256):
        intent = directory / (phase + '.intent.json')
        accepted_path = directory / (phase + '.accepted.json')
        result_path = directory / (phase + '.result.json')
        binding = {'phase': phase, 'instanceId': INSTANCE, 'parametersSha256': digest(parameters),
                   'policySha256': policy_sha256}
        if result_path.exists():
            stored = closed(read_file(result_path, MAX_OUTPUT, private=True), MAX_OUTPUT)
            need(stored.get('binding') == binding, 'STORAGE_PRIOR_RESULT_DRIFT')
            return validate_native(stored.get('result'), phase, policy_sha256)
        if accepted_path.exists():
            accepted = closed(read_file(accepted_path, private=True))
            need(accepted.get('binding') == binding and matches(UUID, accepted.get('commandId')),
                 'STORAGE_ACCEPTED_COMMAND_DRIFT')
            command_id = accepted['commandId']
        else:
            need(not intent.exists() and not intent.is_symlink(), 'STORAGE_SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED')
            save(intent, {'binding': binding, 'status': 'SEND_INTENT_RECORDED'})
            dispatched = self.commands.aws('ssm', 'send-command', '--cli-input-json',
                canonical({'InstanceIds': [INSTANCE], 'DocumentName': 'AWS-RunShellScript',
                           'Comment': 'ID disk lifecycle ' + phase, 'Parameters': parameters}).decode())
            command = dispatched.get('Command') if type(dispatched) is dict else None
            need(type(command) is dict and matches(UUID, command.get('CommandId'))
                 and command.get('InstanceIds') == [INSTANCE]
                 and command.get('DocumentName') == 'AWS-RunShellScript', 'STORAGE_ACCEPTED_COMMAND_INVALID')
            command_id = command['CommandId']
            save(accepted_path, {'binding': binding, 'commandId': command_id, 'status': 'ACCEPTED_RESULT_UNKNOWN'})
        deadline = self.monotonic() + 1500
        while self.monotonic() < deadline:
            invocation = self.commands.aws('ssm', 'get-command-invocation', '--command-id', command_id,
                                          '--instance-id', INSTANCE, invocation=True)
            need(type(invocation) is dict, 'STORAGE_INVOCATION_INVALID')
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                self.sleep(10); continue
            need(invocation.get('CommandId') == command_id and invocation.get('InstanceId') == INSTANCE
                 and invocation.get('DocumentName') == 'AWS-RunShellScript'
                 and invocation.get('PluginName') == 'aws:runShellScript'
                 and invocation.get('Status') == 'Success' and type(invocation.get('ResponseCode')) is int
                 and invocation['ResponseCode'] == 0 and invocation.get('StandardErrorContent') == '',
                 'STORAGE_REMOTE_TERMINAL_FAILED')
            output = invocation.get('StandardOutputContent')
            need(type(output) is str and len(output.strip().splitlines()) == 1, 'STORAGE_REMOTE_OUTPUT_INVALID')
            result = validate_native(closed(output, MAX_OUTPUT), phase, policy_sha256)
            save(result_path, {'binding': binding, 'commandId': command_id,
                               'invocationCanonicalSha256': digest(invocation), 'result': result})
            return result
        raise StorageRejected('STORAGE_ACCEPTED_RESULT_PENDING')


def validate_readback(selected, record):
    directory = PROJECT / '.deploy/production-release'
    raw = read_file(directory / READBACKS[selected['operation']])
    receipt = closed(raw)
    operation = selected['operation']
    producer = selected['producer']
    if operation == 'release_admin':
        metadata = closed(read_file(directory / 'admin-independent-readback-invocation.json'))
        need(receipt.get('status') == 'ADMIN_ONLY_READBACK_VERIFIED'
             and receipt.get('commit') == producer['commit'] and receipt.get('servicesUpdated') == ['admin']
             and metadata.get('commit') == producer['commit'] and metadata.get('sourceTree') == producer['sourceTree']
             and metadata.get('readbackVerified') is True and matches(UUID, metadata.get('commandId')),
             'STORAGE_INDEPENDENT_READBACK_INVALID')
    elif operation in ('release_unpublished_components', 'release_recharge_flow'):
        need(receipt.get('instanceId') == INSTANCE and receipt.get('status') == 'Success'
             and matches(UUID, receipt.get('commandId')) and matches(HEX64, receipt.get('invocationBytesSha256'))
             and type(receipt.get('receipt')) is dict, 'STORAGE_INDEPENDENT_READBACK_INVALID')
        receipt = receipt['receipt']
        need(receipt.get('status') == 'UNPUBLISHED_COMPONENT_VERIFIED'
             and receipt.get('runningImagesAndContentMatched') is True
             and receipt.get('commit') == producer['commit'] and receipt.get('sourceTree') == producer['sourceTree'],
             'STORAGE_INDEPENDENT_READBACK_INVALID')
        proof_name, _ = PROOFS[operation]
        need(receipt.get('buildProofBytesSha256') == hashlib.sha256(read_file(directory / proof_name)).hexdigest(),
             'STORAGE_READBACK_PROOF_DRIFT')
    else:
        status = {'release_api_admin': 'API_ADMIN_VERIFIED', 'release_api_workspace': 'API_ADMIN_WORKSPACE_VERIFIED',
                  'release_api_admin_migration': 'API_ADMIN_MIGRATION_VERIFIED',
                  'release_online_recharge': 'ONLINE_RECHARGE_VERIFIED'}[operation]
        need(receipt.get('status') == status and receipt.get('commit') == producer['commit']
             and receipt.get('sourceTree') == producer['sourceTree']
             and receipt.get('workflowRunId') == producer['workflowRunId']
             and receipt.get('workflowRunAttempt') == producer['workflowRunAttempt']
             and (operation == 'release_online_recharge' or receipt.get('runningImagesAndContentMatched') is True)
             and receipt.get('buildProofSha256') == record['proofSha256'], 'STORAGE_INDEPENDENT_READBACK_INVALID')
        if operation == 'release_online_recharge':
            invocation_path = directory / 'online-recharge-readback-invocation.json'
            if invocation_path.exists():
                invocation = closed(read_file(invocation_path, 128 * 1024), 128 * 1024)
                need(invocation.get('Status') == 'Success' and type(invocation.get('ResponseCode')) is int
                     and invocation['ResponseCode'] == 0 and invocation.get('InstanceId') == INSTANCE
                     and invocation.get('DocumentName') == 'AWS-RunShellScript'
                     and invocation.get('PluginName') == 'aws:runShellScript'
                     and invocation.get('StandardErrorContent') == ''
                     and matches(UUID, invocation.get('CommandId')), 'STORAGE_INDEPENDENT_READBACK_INVALID')
            else:
                command = closed(read_file(directory / 'online-recharge-readback-command.json'))
                need(matches(UUID, command.get('commandId')), 'STORAGE_INDEPENDENT_READBACK_INVALID')
        else:
            need(matches(UUID, receipt.get('commandId')), 'STORAGE_INDEPENDENT_READBACK_INVALID')
        updated = set(record['images']) - {'migrate'}
        states = receipt.get('services', {})
        need(type(states) is dict and all(type(states.get(role)) is dict
             and states[role].get('image') == record['images'][role]['imageId']
             and states[role].get('reference') == record['images'][role]['reference'] for role in updated),
             'STORAGE_READBACK_IMAGE_DRIFT')
    return hashlib.sha256(raw).hexdigest()


def lifecycle(phase, environment=None, commands=None, client=None):
    selected = selection(os.environ if environment is None else environment)
    commands = commands or Commands()
    verify_source(selected, commands, require_main=phase != 'after-publish')
    source_sha256, policy_sha256 = policy_binding()
    directory = output_directory(selected)
    client = client or LifecycleClient(commands)
    event = None
    expected = selected['expectedCurrent']
    if phase == 'before-pull':
        before = closed(read_file(directory / 'before-build.result.json', MAX_OUTPUT, private=True), MAX_OUTPUT)
        before = validate_native(before.get('result'), 'before-build', policy_sha256)
        record = build_record(selected, commands)
        record_path = directory / 'candidate.json'
        if record_path.exists():
            need(closed(read_file(record_path, private=True)) == record, 'STORAGE_LOCAL_RECORD_DRIFT')
        else:
            save(record_path, record)
        event = {'record': record, 'supersedes': supersedes(record, before, commands),
                 'sourceArchiveBytes': source_archive_bytes(selected, commands)}
    elif phase == 'after-publish':
        record = candidate_module().validate_record(closed(read_file(directory / 'candidate.json', private=True)))
        need(record['producer'] == selected['producer'] and record['operation'] == selected['operation']
             and record['qualityRunId'] == selected['qualityRunId'], 'STORAGE_LOCAL_RECORD_DRIFT')
        if selected['operation'] != 'release':
            proof_name, _ = PROOFS[selected['operation']]
            need(digest(closed(read_file(PROJECT / '.deploy/production-release' / proof_name))) == record['proofSha256'],
                 'STORAGE_LOCAL_BUILD_PROOF_DRIFT')
            validate_readback(selected, record)
        event = {'record': record}
        expected = selected['producer']['commit']
    else:
        need(phase == 'before-build', 'STORAGE_PHASE_INVALID')
    result = client.execute(phase, remote_parameters(phase, expected, source_sha256, event), directory, policy_sha256)
    return validate_native(result, phase, policy_sha256)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=('before-build', 'before-pull', 'after-publish'))
    args = parser.parse_args(argv)
    try:
        value = lifecycle(args.phase)
        # Results contain only the native maintainer's closed operational metadata.
        print(canonical(value).decode())
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, StorageRejected) and re.fullmatch('STORAGE_[A-Z_]+', str(error)) else 'STORAGE_FAILED_CLOSED'
        print(json.dumps({'status': 'FAILED_CLOSED', 'phase': args.phase, 'code': code, 'rawOutputSuppressed': True}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
