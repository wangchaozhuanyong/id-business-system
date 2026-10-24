"""Read-only facts for the finite 60 Admin / API-hotfix predecessor.

This reader never qualifies API restoration or publication. Historical contracts
remain immutable; different live identities are reported, never adopted as seals.
The remote program runs in memory and prints only the closed safe receipt below.
"""
import ast
import base64
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time
import zlib

CURRENT = '60e164b75d1eedaab440c17139bf9ba55de08c61'
CURRENT_TREE = '4922bfdfa14186e12532c3fa9e0d3aa3fd697b98'
API_ORIGIN = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
SCOPE = 'ADMIN_SUCCESSOR_READONLY_FACTS'
PREFIX = 'admin-successor-diagnostic'
INSTANCE = 'i-0838cebf64f0e2a89'
REGION = 'ap-northeast-1'
CONTRACT_SHA256 = '7288f0f84adcf51fd603c83b2e2a1802d4fb439ef220513d91122b3e9b2cfdeb'
ADMIN_PROOF_SHA256 = 'b21763f665517d6bcaed4e737cb625c306e63090d818cdc47fdef61081f70b27'
ORIGIN_MARKERS_SHA256 = 'c938dd21ab57e432327de61a622b9fdbad817afb57f2184385ec3f8d6e84e590'
ENVIRONMENT_SHA256 = 'a812aef2a536de5b18a31824cdac09e195672f158429a423643232134b1108af'
HISTORICAL_SOURCE = {'commandId': '94c8dcd8-4528-428a-9482-5a6b45cbb13f',
    'invocationBytesSha256': '93f77ccb574a0e9d9f02179dc5da3bfed5504d5385bac4728029762e3993ec10'}
CONFIGURATION_HASHES = {
    'apps/api/prisma-mysql/schema.prisma': '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197',
    'apps/api/prisma-mysql/seed.ts': 'ac9940a7977def1ed6eaad38ed154d81963ce6e877f02ffc07234fa61591096b',
    'compose.release.json': '56c2587f51cba0b935b5f73053a26cbcf0b4782cd631b7811e3088ed4a63e424',
    'deploy/caddy/Caddyfile.aws': 'f3d253904be6acbe24184b6a317eb3c9ded71636d9622dc9636c196dd7a56674',
    'docker-compose.aws-mysql.yml': '953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c'}
RUNTIME_FILES = ('apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts',
                 'docker-compose.aws-mysql.yml')
ORIGIN_MARKERS = ('apiWorkspacePublication', 'pendingOnlineMigration', 'preservedMigrationOrigin')
SERVICES = ('admin', 'api', 'auto-recharge', 'auto-registration', 'caddy', 'media-resolver', 'mysql')
STATE_FIELDS = {'image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256',
                'environmentSha256', 'configurationSha256'}
LABELS = ('org.opencontainers.image.revision', 'id-business-v2.source-tree',
          'id-business-v2.admin-pending-projection-sha256')
BASE = Path('/opt/id-business-v2')
OUTPUT_LIMIT = 24000


class DiagnosticError(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise DiagnosticError('ADMIN_DIAGNOSTIC_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def matches(pattern, value):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def json_value(raw, cap):
    need(type(raw) is bytes and 0 < len(raw) < cap, 'JSON_SIZE_INVALID')
    def pairs(rows):
        out = {}
        for key, value in rows:
            need(key not in out, 'JSON_DUPLICATE_FIELD')
            out[key] = value
        return out
    def invalid(_):
        raise DiagnosticError('ADMIN_DIAGNOSTIC_JSON_CONSTANT_INVALID')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeError):
        raise DiagnosticError('ADMIN_DIAGNOSTIC_JSON_INVALID') from None


def read_bytes(path, cap=128 * 1024, *, private=False):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'FILE_PATH_CHANGED')
    identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_nlink,
                           row.st_uid, row.st_gid, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    try:
        initial = path.lstat()
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            before = os.fstat(stream.fileno())
            need(identity(before) == identity(initial) and stat.S_ISREG(before.st_mode)
                 and before.st_nlink == 1 and 0 < before.st_size < cap
                 and (not private or (stat.S_IMODE(before.st_mode) == 0o600
                                      and before.st_uid == os.geteuid())), 'FILE_IDENTITY_CHANGED')
            raw = stream.read(cap)
            need(identity(before) == identity(os.fstat(stream.fileno())) == identity(path.lstat())
                 and len(raw) == before.st_size, 'FILE_IDENTITY_CHANGED')
            return raw
    except OSError:
        raise DiagnosticError('ADMIN_DIAGNOSTIC_FILE_UNAVAILABLE') from None


def directory_hash(path, limit, *, private=False):
    path = Path(path)
    need(path.is_dir() and path.resolve() == path and not path.is_symlink(), 'DIRECTORY_CHANGED')
    rows = {}
    for root, dirs, files in os.walk(path, followlinks=False):
        need(all(not (Path(root) / name).is_symlink() for name in dirs + files), 'DIRECTORY_SYMLINK')
        for name in sorted(files):
            file = Path(root) / name
            relative = file.relative_to(path).as_posix()
            need(matches(r'[A-Za-z0-9_./-]{1,240}', relative) and len(rows) < limit, 'DIRECTORY_BOUND')
            raw = read_bytes(file, 1024 * 1024, private=private)
            rows[relative] = {'mode': stat.S_IMODE(file.stat().st_mode), 'sha256': digest(raw)}
    need(rows, 'DIRECTORY_EMPTY')
    return {'fileCount': len(rows), 'inventorySha256': fingerprint(rows)}


def command(args, cap=1024 * 1024):
    try:
        result = subprocess.run(args, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise DiagnosticError('ADMIN_DIAGNOSTIC_COMMAND_UNAVAILABLE') from None
    need(result.returncode == 0 and 0 < len(result.stdout) < cap, 'COMMAND_FAILED')
    return result.stdout


def inspect_one(kind, target):
    rows = json_value(command(['docker', *kind, 'inspect', target]), 1024 * 1024)
    need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'DOCKER_OUTPUT_INVALID')
    return rows[0]


def snapshot(current):
    result = {}
    compose = ['docker', 'compose', '--env-file', str(current / '.env.aws.production'),
               '-f', str(current / 'docker-compose.aws-mysql.yml'), '-f', str(current / 'compose.release.json')]
    names = command([*compose, 'config', '--services'], 4096).decode().split()
    need(set(names) == set(SERVICES) | {'migrate'}, 'SERVICE_SET_CHANGED')
    for service in SERVICES:
        container = command([*compose, 'ps', '-q', service], 256).decode().strip()
        need(matches(r'[a-f0-9]{64}', container), 'CONTAINER_ID_INVALID')
        row = inspect_one([], container)
        config, state, mounts = row.get('Config', {}), row.get('State', {}), row.get('Mounts')
        need(row.get('Id') == container and type(config) is dict and type(state) is dict
             and type(mounts) is list and all(type(m) is dict and type(m.get('Destination')) is str for m in mounts)
             and len({m['Destination'] for m in mounts}) == len(mounts), 'CONTAINER_METADATA_INVALID')
        environment, started = config.get('Env'), state.get('StartedAt')
        need(type(environment) is list and environment and all(type(n) is str for n in environment)
             and type(started) is str and 0 < len(started) < 128, 'CONTAINER_METADATA_INVALID')
        configuration = {'Config': config, 'HostConfig': row.get('HostConfig'),
                         'Mounts': sorted(mounts, key=lambda m: m['Destination'])}
        result[service] = {'image': row.get('Image'), 'reference': config.get('Image'),
            'status': state.get('Status'), 'health': state.get('Health', {}).get('Status'),
            'containerId': container, 'startedAtSha256': digest(started.encode()),
            'environmentSha256': fingerprint(sorted(environment)), 'configurationSha256': fingerprint(configuration)}
    validate_services(result)
    return result


def validate_services(states):
    need(type(states) is dict and set(states) == set(SERVICES), 'RECEIPT_SERVICE_INVALID')
    for row in states.values():
        need(type(row) is dict and set(row) == STATE_FIELDS
             and matches(r'sha256:[a-f0-9]{64}', row['image'])
             and matches(r'[A-Za-z0-9][A-Za-z0-9:/@._-]{0,511}', row['reference'])
             and row['status'] in ('running', 'created', 'exited', 'restarting', 'paused', 'dead', 'removing')
             and row['health'] in (None, 'healthy', 'unhealthy', 'starting')
             and all(matches(r'[a-f0-9]{64}', row[n]) for n in STATE_FIELDS - {'image', 'reference', 'status', 'health'}),
             'RECEIPT_SERVICE_INVALID')


def image_facts(states):
    output = {}
    for name, state in states.items():
        row = inspect_one(['image'], state['image'])
        labels = row.get('Config', {}).get('Labels') or {}
        need(row.get('Id') == state['image'] and row.get('Architecture') == 'amd64', 'IMAGE_IDENTITY_CHANGED')
        output[name] = {'imageId': row['Id'], 'reference': state['reference'], 'architecture': 'amd64',
                       'labels': {key: labels.get(key) for key in LABELS}}
    return output


def read_proofs(contract):
    current = (BASE / 'current').resolve()
    need(str(current) == contract['currentRelease'] and current.parent == BASE / 'releases', 'CURRENT_PATH_CHANGED')
    ancestor, origin = Path(contract['adminPredecessorRelease']), Path(contract['historicalB']['release'])
    raw = read_bytes(current / 'release-manifest.json', private=True)
    manifest = json_value(raw, 128 * 1024)
    old_raw = read_bytes(ancestor / 'release-manifest.json', private=True)
    old = json_value(old_raw, 128 * 1024)
    origin_raw = read_bytes(origin / 'release-manifest.json', private=True)
    original = json_value(origin_raw, 128 * 1024)
    proof_raw = read_bytes(ancestor / 'admin-build-proof.json', private=True)
    proof = json_value(proof_raw, 128 * 1024)
    need(digest(raw) == contract['manifestSha256'] and manifest.get('commit') == CURRENT
         and digest(old_raw) == contract['adminPredecessorManifestSha256']
         and digest(origin_raw) == contract['historicalB']['manifestSha256']
         and digest(proof_raw) == ADMIN_PROOF_SHA256, 'NATIVE_MANIFEST_CHANGED')
    ledger = manifest['adminPublication']
    hotfix = manifest['apiHotfixPublication']
    need(ledger == old['adminPublication'] and fingerprint(ledger) == contract['adminPublicationSha256']
         and fingerprint(hotfix) == contract['hotfixPublicationSha256']
         and str(ancestor) == manifest['previousRelease'] == hotfix['previousRelease']
         and digest(old_raw) == manifest['previousManifestSha256'] == hotfix['previousManifestSha256']
         and str(origin) == old['previousRelease'] and digest(origin_raw) == old['previousManifestSha256']
         == ledger['inheritedManifestSha256'], 'NATIVE_ANCESTOR_CHANGED')
    markers = {name: original[name] for name in ORIGIN_MARKERS}
    need(all(manifest[n] == old[n] == markers[n] for n in ORIGIN_MARKERS)
         and fingerprint(markers) == ORIGIN_MARKERS_SHA256
         and markers['apiWorkspacePublication']['onlinePublished'] is False
         and markers['apiWorkspacePublication']['migrationPerformed'] is False, 'ORIGIN_MARKER_CHANGED')
    need(original['commit'] == API_ORIGIN == contract['apiSourceCommit']
         and original['sourceTree'] == contract['apiSourceTree']
         and ledger['componentBaselines'] == {'api': API_ORIGIN}
         and hotfix['baselineApiCommit'] == API_ORIGIN, 'API_ORIGIN_CHANGED')
    projection = proof['projection']
    need(proof['commit'] == ledger['commit'] == projection['candidateCommit'] == CURRENT
         and proof['sourceTree'] == projection['candidateTree'] == manifest['sourceTree']
         and proof['projection'] == ledger['projection'] and fingerprint(proof) == ledger['buildProofSha256']
         and projection['projectionSha256'] == fingerprint({k: v for k, v in projection.items() if k != 'projectionSha256'}),
         'ADMIN_PROJECTION_CHANGED')
    historical = contract['historicalB']
    for name, key in (('api-workspace-preservation.json', 'recordSha256'),
                      ('api-workspace-build-proof.json', 'proofSha256')):
        need(digest(read_bytes(origin / name, private=True)) == historical[key], 'API_NATIVE_PROOF_CHANGED')
    invocation = read_bytes(BASE / historical['nativeInvocationRelativePath'], 65536, private=True)
    native = json_value(invocation, 65536)
    need(digest(invocation) == historical['nativeInvocationSha256'] and native.get('CommandId') == historical['nativeReadbackCommandId']
         and native.get('InstanceId') == INSTANCE and native.get('DocumentName') == 'AWS-RunShellScript'
         and native.get('PluginName') == 'aws:runShellScript' and native.get('Status') == 'Success'
         and type(native.get('ResponseCode')) is int and native['ResponseCode'] == 0
         and native.get('StandardErrorContent') == ''
         and digest(native['StandardOutputContent'].encode()) == historical['nativeStdoutSha256'], 'API_NATIVE_PROOF_CHANGED')
    return current, raw, {'currentRelease': str(current), 'currentCommit': CURRENT, 'sourceTree': manifest['sourceTree'],
        'manifestBytesSha256': digest(raw), 'adminPredecessorManifestBytesSha256': digest(old_raw),
        'adminBuildProofBytesSha256': digest(proof_raw), 'adminProjectionSha256': projection['projectionSha256'],
        'apiComponentBaseline': API_ORIGIN, 'apiOriginManifestBytesSha256': digest(origin_raw),
        'apiOriginNativeInvocationBytesSha256': digest(invocation), 'originMarkersSha256': fingerprint(markers),
        'hotfixPublicationSha256': fingerprint(hotfix)}


def collect(contract):
    current, raw, facts = read_proofs(contract)
    states = snapshot(current)
    images = image_facts(states)
    files = {name: digest(read_bytes(current / name, 1024 * 1024)) for name in CONFIGURATION_HASHES}
    env_hash = digest(read_bytes(current / '.env.aws.production', 1024 * 1024, private=True))
    pending = current / '.deploy/production-release/pending-original-source'
    pending_files = {name: digest(read_bytes(pending / name, 1024 * 1024, private=True)) for name in RUNTIME_FILES}
    facts.update(services=states, images=images, configurationFilesSha256=files, environmentFileSha256=env_hash,
        migrations=directory_hash(current / 'apps/api/prisma-mysql/migrations', 256),
        pendingOriginalSource={**directory_hash(pending, 3, private=True), 'files': pending_files})
    need((BASE / 'current').resolve() == current and read_bytes(current / 'release-manifest.json', private=True) == raw
         and snapshot(current) == states, 'LIVE_SNAPSHOT_CHANGED')
    need({name: digest(read_bytes(current / name, 1024 * 1024)) for name in CONFIGURATION_HASHES} == files
         and digest(read_bytes(current / '.env.aws.production', 1024 * 1024, private=True)) == env_hash
         and directory_hash(current / 'apps/api/prisma-mysql/migrations', 256) == facts['migrations']
         and directory_hash(pending, 3, private=True) == {k: v for k, v in facts['pendingOriginalSource'].items() if k != 'files'},
         'LIVE_FILES_CHANGED')
    differences = differences_for(facts, contract)
    return {'version': 1, 'scope': SCOPE, 'status': 'OBSERVED', 'nativeProofsVerified': True,
        'baselineVerified': not differences, 'differences': differences, 'facts': facts,
        'historicalSource': HISTORICAL_SOURCE, 'contractSha256': CONTRACT_SHA256}


def differences_for(facts, contract):
    states, images, files = facts['services'], facts['images'], facts['configurationFilesSha256']
    differences = []
    for name in SERVICES:
        differences.extend('services.' + name + '.' + key for key in sorted(STATE_FIELDS)
                           if states[name][key] != contract['services'][name][key])
        if states[name]['status'] != 'running' or (name != 'caddy' and states[name]['health'] != 'healthy'):
            differences.append('health.' + name)
    differences.extend('configurationFilesSha256.' + name for name in sorted(files) if files[name] != CONFIGURATION_HASHES[name])
    if facts['environmentFileSha256'] != ENVIRONMENT_SHA256:
        differences.append('environmentFileSha256')
    for name, revision, tree in (('api', API_ORIGIN, contract['apiSourceTree']), ('admin', CURRENT, facts['sourceTree'])):
        for key, expected in zip(LABELS[:2], (revision, tree)):
            if images[name]['labels'][key] != expected:
                differences.append('images.' + name + '.labels.' + key)
    if images['admin']['labels'][LABELS[2]] != facts['adminProjectionSha256']:
        differences.append('images.admin.labels.' + LABELS[2])
    return sorted(differences)


def failure(error):
    code = str(error) if isinstance(error, DiagnosticError) else 'ADMIN_DIAGNOSTIC_UNEXPECTED_STRUCTURE'
    need(matches(r'ADMIN_DIAGNOSTIC_[A-Z_]{1,64}', code), 'ERROR_CODE_INVALID')
    return {'version': 1, 'scope': SCOPE, 'status': 'FAILED', 'code': code}


def remote_main(contract):
    try:
        need(fingerprint(contract) == CONTRACT_SHA256, 'CONTRACT_CHANGED')
        result = collect(contract)
        validate_receipt(result, contract)
    except Exception as error:
        result = failure(error)
    print(json.dumps(result, sort_keys=True, separators=(',', ':')), flush=True)
    return 0 if result['status'] == 'OBSERVED' else 1


def validate_receipt(value, contract):
    need(type(value) is dict and value.get('version') == 1 and type(value['version']) is int
         and value.get('scope') == SCOPE, 'RECEIPT_INVALID')
    if value.get('status') == 'FAILED':
        need(set(value) == {'version', 'scope', 'status', 'code'}
             and matches(r'ADMIN_DIAGNOSTIC_[A-Z_]{1,64}', value['code']), 'RECEIPT_INVALID')
        return value
    need(set(value) == {'version', 'scope', 'status', 'nativeProofsVerified', 'baselineVerified', 'differences',
                       'facts', 'historicalSource', 'contractSha256'}
         and value['status'] == 'OBSERVED' and value['nativeProofsVerified'] is True
         and type(value['baselineVerified']) is bool and value['contractSha256'] == CONTRACT_SHA256
         and value['historicalSource'] == HISTORICAL_SOURCE, 'RECEIPT_INVALID')
    facts = value['facts']
    hashes = {'manifestBytesSha256', 'adminPredecessorManifestBytesSha256', 'adminBuildProofBytesSha256',
              'adminProjectionSha256', 'apiOriginManifestBytesSha256', 'apiOriginNativeInvocationBytesSha256',
              'originMarkersSha256', 'hotfixPublicationSha256', 'environmentFileSha256'}
    need(type(facts) is dict and set(facts) == hashes | {'currentRelease', 'currentCommit', 'sourceTree',
        'apiComponentBaseline', 'services', 'images', 'configurationFilesSha256', 'migrations', 'pendingOriginalSource'}
        and facts['currentRelease'] == contract['currentRelease'] and facts['currentCommit'] == CURRENT
        and facts['apiComponentBaseline'] == API_ORIGIN and facts['sourceTree'] == CURRENT_TREE
        and all(matches(r'[a-f0-9]{64}', facts[n]) for n in hashes), 'RECEIPT_FACT_INVALID')
    expected_hashes = {'manifestBytesSha256': contract['manifestSha256'],
        'adminPredecessorManifestBytesSha256': contract['adminPredecessorManifestSha256'],
        'adminBuildProofBytesSha256': ADMIN_PROOF_SHA256, 'apiOriginManifestBytesSha256': contract['historicalB']['manifestSha256'],
        'apiOriginNativeInvocationBytesSha256': contract['historicalB']['nativeInvocationSha256'],
        'originMarkersSha256': ORIGIN_MARKERS_SHA256, 'hotfixPublicationSha256': contract['hotfixPublicationSha256']}
    need(all(facts[n] == v for n, v in expected_hashes.items()), 'RECEIPT_NATIVE_HASH_CHANGED')
    validate_services(facts['services'])
    need(type(facts['images']) is dict and set(facts['images']) == set(SERVICES), 'RECEIPT_IMAGE_INVALID')
    for name, image in facts['images'].items():
        need(type(image) is dict and set(image) == {'imageId', 'reference', 'architecture', 'labels'}
             and image['imageId'] == facts['services'][name]['image'] and image['reference'] == facts['services'][name]['reference']
             and image['architecture'] == 'amd64' and type(image['labels']) is dict and set(image['labels']) == set(LABELS)
             and all(v is None or matches(r'[a-f0-9]{' + ('64' if k == LABELS[2] else '40') + '}', v)
                     for k, v in image['labels'].items()), 'RECEIPT_IMAGE_INVALID')
    files = facts['configurationFilesSha256']
    need(type(files) is dict and set(files) == set(CONFIGURATION_HASHES)
         and all(matches(r'[a-f0-9]{64}', v) for v in files.values()), 'RECEIPT_FACT_INVALID')
    for key, limit in (('migrations', 256), ('pendingOriginalSource', 3)):
        row = facts[key]
        need(type(row) is dict and set(row) == ({'fileCount', 'inventorySha256', 'files'} if key == 'pendingOriginalSource'
                                             else {'fileCount', 'inventorySha256'})
             and type(row['fileCount']) is int and 0 < row['fileCount'] <= limit
             and matches(r'[a-f0-9]{64}', row['inventorySha256']), 'RECEIPT_DIRECTORY_INVALID')
    pending = facts['pendingOriginalSource']
    need(pending['fileCount'] == 3 and type(pending['files']) is dict and set(pending['files']) == set(RUNTIME_FILES)
         and all(matches(r'[a-f0-9]{64}', v) for v in pending['files'].values()), 'RECEIPT_DIRECTORY_INVALID')
    allowed = {'services.' + n + '.' + k for n in SERVICES for k in STATE_FIELDS}
    allowed |= {'health.' + n for n in SERVICES} | {'configurationFilesSha256.' + n for n in CONFIGURATION_HASHES}
    allowed |= {'environmentFileSha256'} | {'images.' + n + '.labels.' + k for n in ('api', 'admin') for k in LABELS}
    differences = value['differences']
    need(type(differences) is list and differences == sorted(set(differences)) and set(differences) <= allowed
         and differences == differences_for(facts, contract)
         and value['baselineVerified'] is (not differences), 'RECEIPT_DIFFERENCES_INVALID')
    need(len(json.dumps(value).encode()) < OUTPUT_LIMIT, 'RECEIPT_SIZE_INVALID')
    return value


def contract_from_source():
    tree = ast.parse(Path(__file__).with_name('unpublished-component-successor.py').read_text())
    rows = [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'BASELINE_CONTRACT' for t in n.targets)]
    need(len(rows) == 1 and fingerprint(rows[0]) == CONTRACT_SHA256, 'CONTRACT_CHANGED')
    return rows[0]


def parameters(contract):
    source = Path(__file__).read_text()
    # Exclude the local CLI; the decoded trusted program calls only remote_main.
    source = source.split("\nif __name__ == '__main__':", 1)[0]
    source += '\nraise SystemExit(remote_main(' + repr(contract) + '))\n'
    payload = base64.b64encode(lzma.compress(source.encode())).decode()
    decoder = 'import base64,lzma;exec(compile(lzma.decompress(base64.b64decode(' + repr(payload) + ',validate=True)),"<admin-successor-readonly>","exec"))'
    result = {'commands': ['python3 -B -c ' + shlex.quote(decoder)], 'executionTimeout': ['180']}
    need(len(json.dumps(result).encode()) < 20 * 1024, 'PAYLOAD_SIZE_INVALID')
    return result


def aws(*args):
    return command(['aws', '--region', REGION, 'ssm', *args], 256 * 1024)


def native_hotfix(contract):
    raw = aws('get-command-invocation', '--command-id', contract['hotfixReadbackCommandId'], '--instance-id', INSTANCE,
              '--output', 'json')
    need(digest(raw) == contract['hotfixReadbackInvocationBytesSha256'], 'HOTFIX_NATIVE_CHANGED')
    value = json_value(raw, 128 * 1024)
    need(value.get('CommandId') == contract['hotfixReadbackCommandId'] and value.get('InstanceId') == INSTANCE
         and value.get('DocumentName') == 'AWS-RunShellScript' and value.get('PluginName') == 'aws:runShellScript'
         and value.get('Status') == 'Success' and type(value.get('ResponseCode')) is int and value['ResponseCode'] == 0
         and value.get('StandardErrorContent') == '', 'HOTFIX_NATIVE_CHANGED')
    stdout = value.get('StandardOutputContent')
    need(type(stdout) is str and digest(stdout.encode()) == contract['hotfixStdoutSha256'], 'HOTFIX_NATIVE_CHANGED')
    envelope = json_value(stdout.encode(), OUTPUT_LIMIT)
    need(type(envelope) is dict and set(envelope) == {'encoding', 'sha256', 'payload'}
         and envelope['encoding'] == 'zlib-base64' and envelope['sha256'] == contract['hotfixDecodedSha256'], 'HOTFIX_NATIVE_CHANGED')
    packed = base64.b64decode(envelope['payload'], validate=True)
    need(0 < len(packed) < 12000, 'HOTFIX_NATIVE_CHANGED')
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(packed, 16384)
    need(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
         and 0 < len(decoded) < 16384 and digest(decoded) == contract['hotfixDecodedSha256'], 'HOTFIX_NATIVE_CHANGED')
    return {'commandId': value['CommandId'], 'invocationBytesSha256': digest(raw),
            'stdoutSha256': digest(stdout.encode()), 'decodedSha256': digest(decoded), 'authenticated': True}


def save(path, value):
    need(not path.exists() and not path.is_symlink(), 'OUTPUT_EXISTS')
    with path.open('x') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')


def run():
    folder = Path('.deploy/production-release').resolve()
    folder.mkdir(parents=True, exist_ok=True)
    metadata = {'version': 1, 'scope': SCOPE, 'commandId': None, 'status': 'NOT_SENT', 'expectedCurrent': CURRENT}
    try:
        need(os.environ.get('RELEASE_OPERATION') == 'verify_access' and os.environ.get('EXPECTED_CURRENT') == CURRENT
             and os.environ.get('AWS_REGION') == REGION and os.environ.get('PRODUCTION_INSTANCE_ID') == INSTANCE,
             'SELECTION_INVALID')
        contract = contract_from_source()
        native = native_hotfix(contract)
        save(folder / (PREFIX + '-native-origin.json'), native)
        params = parameters(contract)
        save(folder / (PREFIX + '-intent.json'), {'expectedCurrent': CURRENT, 'parametersSha256': fingerprint(params)})
        response = json_value(aws('send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript',
                                  '--parameters', json.dumps(params), '--output', 'json'), 256 * 1024)
        command_id = response.get('Command', {}).get('CommandId')
        need(matches(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id), 'COMMAND_ID_INVALID')
        metadata.update(commandId=command_id, status='ACCEPTED')
        save(folder / (PREFIX + '-invocation.json'), metadata)
        print(json.dumps(metadata), flush=True)
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            try:
                raw = aws('get-command-invocation', '--command-id', command_id, '--instance-id', INSTANCE, '--output', 'json')
            except DiagnosticError:
                time.sleep(3)
                continue
            invocation = json_value(raw, 256 * 1024)
            need(invocation.get('CommandId') == command_id and invocation.get('InstanceId') == INSTANCE
                 and invocation.get('DocumentName') == 'AWS-RunShellScript'
                 and invocation.get('PluginName') == 'aws:runShellScript'
                 and invocation.get('Status') in ('Pending', 'InProgress', 'Delayed', 'Success', 'Cancelled',
                                                  'TimedOut', 'Failed', 'Cancelling'), 'INVOCATION_CHANGED')
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                time.sleep(3)
                continue
            output = invocation.get('StandardOutputContent')
            need(type(output) is str and 0 < len(output.encode()) < OUTPUT_LIMIT, 'RECEIPT_SIZE_INVALID')
            receipt = validate_receipt(json_value(output.encode(), OUTPUT_LIMIT), contract)
            need(type(invocation.get('ResponseCode')) is int and -1 <= invocation['ResponseCode'] <= 255,
                 'INVOCATION_CHANGED')
            if receipt['status'] == 'OBSERVED':
                need(invocation.get('Status') == 'Success' and invocation.get('ResponseCode') == 0
                     and invocation.get('StandardErrorContent') == '', 'INVOCATION_FAILED')
            result = {'commandId': command_id, 'invocationBytesSha256': digest(raw), 'status': invocation.get('Status'),
                      'responseCode': invocation.get('ResponseCode'), 'receipt': receipt, 'nativeHotfix': native}
            save(folder / (PREFIX + '-result.json'), result)
            print(json.dumps(result, sort_keys=True), flush=True)
            return 0 if receipt['status'] == 'OBSERVED' else 1
        raise DiagnosticError('ADMIN_DIAGNOSTIC_INVOCATION_TIMEOUT')
    except Exception as error:
        result = {**metadata, 'status': 'FAILED', 'failure': failure(error)}
        save(folder / (PREFIX + '-failure.json'), result)
        print(json.dumps(result, sort_keys=True), flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(run())
