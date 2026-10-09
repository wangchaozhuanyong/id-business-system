"""Explicit two-service publication with a separately approved, finite migration mode."""

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import select
import shutil
import secrets
import sqlite3
import stat
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit
from contextlib import closing

SCOPE = globals().get('SCOPE', 'API_ADMIN')
if SCOPE not in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', 'API_ADMIN_WORKSPACE'):
    raise ValueError('API_ADMIN_SCOPE_CONFLICT')
REGISTRATION = SCOPE == 'API_REGISTRATION'
MIGRATION_MODE = SCOPE == 'API_ADMIN_MIGRATION'
WORKSPACE = SCOPE == 'API_ADMIN_WORKSPACE'
UPDATED = ('api', 'auto-registration') if REGISTRATION else ('api', 'admin', 'caddy') if WORKSPACE else ('api', 'admin')
IMAGE_SERVICES = (*UPDATED, 'migrate') if MIGRATION_MODE else ('api', 'admin') if WORKSPACE else UPDATED
SWITCH_ORDER = ('api', 'auto-registration') if REGISTRATION else ('admin', 'api', 'caddy') if WORKSPACE else ('admin', 'api')
PREFIX = 'api-workspace' if WORKSPACE else SCOPE.lower().replace('_', '-')
CONFIG_FILES = ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                'apps/api/prisma-mysql/schema.prisma')
WORKSPACE_VOLUME = 'auto_registration_data'
WORKSPACE_DIRECTORY = '/app/.runtime/auto-registration'
WORKSPACE_MAINTENANCE = '.id-release-maintenance.json'
WORKSPACE_SAFETY = 'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py'
WORKSPACE_SQLITE_RECEIPT = PREFIX + '-sqlite-protection.json'
ONLINE_SERVICE = 'online-recharge'
ONLINE_SOURCE_SEALS = {
    'apps/api/src/id-business-v2/online-recharge': '338adfad51001a88fe0b77f1415c0a232548d38d49993766955a970aea6e3e0c',
    'apps/admin/src/v2/features/online-recharge': '0e1abd3800877af9a2152f946952447f785b0a45d581730e2dbb7fa40b419d24'}
ONLINE_ADMISSION_FILES = ('apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts',
    'apps/api/src/audit-logs/audit-logs.service.ts',
    'apps/api/src/id-business-v2/runtime/id-business-v2-command-transaction.service.ts')
ONLINE_COMPOSE_SEAL = '8250b0b74da9271e4254448dd97c53b30129f6e37e9fc5203ccd1a01200c2792'
ONLINE_ORIGIN_FILES = ('release-manifest.json', 'online-recharge-build-proof.json',
    'online-recharge-preservation.json', 'online-recharge-workspace-backup.json',
    'backup-verification.json', 'before-audit.json', 'after-audit.json')
WORKSPACE_CADDY_BEFORE = 'f8b230bba46136c27651a0df8b7d6fd7fc4f13a47f7db48d0ff0a436fcfe37e0'
WORKSPACE_CADDY_AFTER = 'f3d253904be6acbe24184b6a317eb3c9ded71636d9622dc9636c196dd7a56674'
WORKSPACE_API_ROOTS = ('/app/apps/api/dist', '/app/packages/shared/dist',
    '/app/apps/api/src/id-business-v2/auto-registration', '/opt/id-registration/venv',
    '/opt/id-registration/dependency-audit.json',
    '/app/apps/admin/src/v2/styles/base.css')
PROOF_FILE = PREFIX + '-build-proof.json'
STATE_FILE = PREFIX + '-preservation.json'
FAILURE_FILE = PREFIX + '-failure.json'
WORKER_PREFIX = 'apps/api/src/id-business-v2/auto-recharge/worker/'
WORKER_PAIR = frozenset(WORKER_PREFIX + n for n in ('registration_browser.py', 'test_registration_browser.py'))
# These reviewed main-only Python changes are absent from the API runtime.
# Registration still uses its sealed 60-file projection; Pro is preserved.
UNPUBLISHED_PRICING = {WORKER_PREFIX + 'plan_selection.py':
    '123f6f30d4b01db6efef213100f4b5b90f211064d2eacfc7ffb3bcf28ecf8604',
    WORKER_PREFIX + 'test_pro.py':
    '3898ba5a47a9911eca8c05bdec4c48768d4ad2499f1bba6b39c4d6039c53a5f6'}
API_CHANGES = frozenset('apps/api/src/id-business-v2/auto-registration/' + n for n in (
    'registration-events.service.ts', 'registration-events.service.spec.ts',
    'registration-mail-delivery.service.ts', 'registration-mail-delivery.service.spec.ts'))
API_INPUTS = ('apps/api', 'packages/shared', 'apps/admin/package.json', 'package.json', 'package-lock.json',
              'npm-shrinkwrap.json', '.npmrc', 'tsconfig.base.json', '.dockerignore')
# The measured current release is the starting point, not an exception to its gates.
REGISTRATION_CURRENT = 'e7c9862d58599995954883f1c1f6038283afffab'
REGISTRATION_DIRECTORY = '/opt/id-business-v2/releases/20261008T020705Z-e7c9862d5859'
REGISTRATION_MANIFEST_SHA = '52f2582e5edeb9e1c9af63c70fff4ca5a5bdad11c0fd7fb8f090fd1670b4c2eb'
REGISTRATION_PROFILE = 'deploy/aws/registration-worker-96-20261008.json'
REGISTRATION_PROFILE_SHA = '642440292a6a1f25a73cb155398c03eb396453e59f9bd229d617b5f60b079299'
REGISTRATION_PUBLIC = {'fileCount': 2202, 'sha256': 'f5ab426496c2fd55733d7c5f660139e3d496c04c1e72279870cf08e5de2a1bce'}
REGISTRATION_STATES_SHA = 'ff4e380eff0b5ae323bb6faf62649d0b1be47ba39b7dcd75dd66701fd86f5e21'
REGISTRATION_API_CONTENT = {'fileCount': 1574, 'sha256': '5834bc435b9e9296d5cc482368d631cb18a06504bb5535d983f46c9fe0cfd2b5'}
REGISTRATION_PRIVATE = frozenset(('.env.aws.production', 'compose.release.json', 'release-manifest.json',
    'before-audit.json', 'after-audit.json', 'backup-verification.json', 'order-archive-seal.reader.json',
    'order-archive-cleanup.reader.json', 'registration-recovery-audit.compose.json',
    'api-admin-build-proof.json', 'api-admin-preservation.json'))
TASK_ID = '252ab243-d96b-4928-8116-b83dedc1d240'
TASK_ATTEMPT = 12 if MIGRATION_MODE else 10
TASK_BINDING = {'accountSha256': '4764c0440ec5bde3d20c74064096b3720a3d7d6ac637361452b9f544b9287ba5',
    'profileSha256': '052ad861dc0da2f8611d422bd384e328e1d856a126bc86434846861f90728f00',
    'ownerSha256': 'ed198d0daf9ef5910f54dc16b3a7a6f4db0cf55c1935309f838071365ab7196d'}
# Captured by the read-only 18e task inspection; these are keyed digests, not credentials.
MIGRATION_TASK = {'taskId': TASK_ID, 'attempt': 12, 'state': 'partial', 'step': 'password',
    'reason': 'session_load_timeout', 'updatedAt': '2026-10-08T14:18:32.726Z',
    'registered': True, 'passwordVerified': False, 'mfaVerified': False, 'leaseActive': False,
    'noncePresent': False, 'passwordCandidatePresent': True, 'binding': TASK_BINDING,
    'emailHashHmac': '99e7d0edf61acf0d0228c67fa52bdf3065e86dda2356d06b8dc6f44125a3429b',
    'jobHmac': '78bc1a85e9857512b534e8b23d6beae677f15cd45bbc76253812bc65396003f9',
    'accountHmac': '763310b009d8c2c099ac94d2265570d9ca9d2886dcd6eb31d3133556571f3e9a',
    'auditHmac': '500789997c0d6f006b7c70a07f21be06b1785b355eba2c36e10f3eb37d75edac',
    'auditCount': 5}
HANDOFF_FAILURE = {'confirmed': False, 'privatePostAttempted': True, 'failurePhase': 'close',
    'privatePostHttpStatus': 409, 'controlledReason': 'fingerprint_cleanup_failed', 'rawOutputSuppressed': True}
MIGRATION_NAME = '20261008180000_quick_action_user_order'
MIGRATION_FILE = MIGRATION_NAME + '/migration.sql'
MIGRATION_ROOT = 'apps/api/prisma-mysql/migrations'
MIGRATION_SCHEMA = 'apps/api/prisma-mysql/schema.prisma'
MIGRATION_SEED = 'apps/api/prisma-mysql/seed.ts'
MIGRATION_SEED_SHA = 'ac9940a7977def1ed6eaad38ed154d81963ce6e877f02ffc07234fa61591096b'
MIGRATION_IDENTITY = {
    'name': MIGRATION_NAME,
    'sha256': '2617684e1c9c4f7ecf5cc40009239c2972d9569c3c1cea1324ecfe5d58871678',
    'schemaBeforeSha256': 'c70cbcb110bb48c395b7e7284dedc0486a9afc125d940c455c0bafc1cffc701d',
    'schemaAfterSha256': '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197',
    'baselineFilesSha256': 'c2179090dd600b3b33a56fe8384e8a7020a4e0cb6eb9a97f509352ee22f4df0a'}
# The independently verified 23c migration publication is the finite origin of
# an API/Admin-only successor. Its three-image proof and task/window remain authoritative;
# this is not a new migration mode or an admission of arbitrary old manifests.
MIGRATION_SUCCESSOR_COMMIT = '23c5841b9b7e60be715250cbb985fc0966c0bce3'
MIGRATION_SUCCESSOR_MANIFEST_SHA = '117ca444e81623f372a2d9c34ecc16effd52141dcfb5e511f74624280092f639'
MIGRATION_SUCCESSOR_PROOF_SHA = '6208643f01babb412956fe43f537990adf951c14447645e7f56303d03a6b1d6c'
WORKSPACE_DIAGNOSTIC_STEPS = frozenset(('NOT_STARTED', 'CURRENT_PROOF', 'CURRENT_RECORD',
    'RUNTIME_IMAGE', 'RUNTIME_CONTENT', 'ORIGIN_PROOF', 'ORIGIN_RECORD', 'ORIGIN_CONFIG',
    'ORIGIN_AUDIT', 'ORIGIN_BACKUP', 'ORIGIN_SOURCE', 'MIGRATION_SCHEMA', 'MIGRATION_IMAGE',
    'MIGRATION_CONTENT', 'TASK_IDENTITY', 'JOBS_IDLE', 'WINDOW_STATE'))
WORKSPACE_DIAGNOSTIC_PHASES = frozenset(('MANIFEST', 'SNAPSHOT', 'IMAGES', 'PROJECTION', 'JOBS'))
WORKSPACE_DIAGNOSTIC_ERRORS = frozenset(('RuntimeError', 'ValueError', 'TypeError', 'KeyError',
    'FileNotFoundError', 'PermissionError', 'OSError', 'JSONDecodeError', 'OTHER'))


class WorkspaceBaselineError(RuntimeError):
    def __init__(self, code, diagnostic):
        super().__init__(code)
        self.workspaceDiagnostic = diagnostic


def workspace_probe_step(d, step, service='none'):
    diagnostic = getattr(d, '_workspaceBaselineDiagnostic', None)
    if (isinstance(diagnostic, dict) and step in WORKSPACE_DIAGNOSTIC_STEPS
            and service in ('none', 'api', 'admin', 'migrate')):
        diagnostic.update(step=step, service=service, scope=SCOPE)


def valid_workspace_diagnostic(value):
    return (isinstance(value, dict) and set(value) == {'phase', 'step', 'service', 'scope',
                'errorType', 'rawOutputSuppressed'}
            and all(type(value[name]) is str for name in ('phase', 'step', 'service', 'scope', 'errorType'))
            and value['phase'] in WORKSPACE_DIAGNOSTIC_PHASES
            and value['step'] in WORKSPACE_DIAGNOSTIC_STEPS
            and value['service'] in ('none', 'api', 'admin', 'migrate')
            and value['scope'] in ('API_ADMIN', 'API_ADMIN_MIGRATION', 'API_ADMIN_WORKSPACE')
            and value['errorType'] in WORKSPACE_DIAGNOSTIC_ERRORS
            and value['rawOutputSuppressed'] is True)


def image_service(service):
    return 'auto-recharge' if service == 'auto-registration' else service


def registration_profile(d, root):
    raw = (root / REGISTRATION_PROFILE).read_bytes()
    d.require(hashlib.sha256(raw).hexdigest() == REGISTRATION_PROFILE_SHA, 'API_ADMIN_REGISTRATION_PROFILE_CHANGED')
    value = json.loads(raw)
    rows = value['workerProjection']
    d.require(value['enabled'] is True and len(rows) == 60
              and value['workerProjectionSha256'] == fingerprint(rows)
              and all(n.startswith(WORKER_PREFIX) and re.fullmatch(r'[A-Za-z0-9_.-]+', n[len(WORKER_PREFIX):])
                      and set(r) == {'mode', 'sha256'} and r['mode'] in ('100644', '100755')
                      and re.fullmatch(r'[a-f0-9]{64}', r['sha256']) for n, r in rows.items()),
              'API_ADMIN_REGISTRATION_PROFILE_CHANGED')
    return value


def registration_candidate_scope(d, commit):
    known = frozenset(WORKER_PREFIX + n for n in ('plan_selection.py', 'registration_browser.py',
                                                'test_pro.py', 'test_registration_browser.py'))
    old = d.run('git', 'diff', '--name-only', '815fae391b172d6c368ea2ad25225f52a1272808',
                REGISTRATION_CURRENT, '--', *API_INPUTS).splitlines()
    changed = d.run('git', 'diff', '--name-only', REGISTRATION_CURRENT, commit, '--', *API_INPUTS).splitlines()
    carried = set(changed) & set(UNPUBLISHED_PRICING)
    d.require(set(old) == known and carried in (set(), set(UNPUBLISHED_PRICING))
              and set(changed) == API_CHANGES | WORKER_PAIR | carried,
              'API_ADMIN_REGISTRATION_API_SCOPE_CHANGED')
    d.require(all(hashlib.sha256(subprocess.check_output(['git', 'show', commit + ':' + name])).hexdigest()
                  == UNPUBLISHED_PRICING[name] for name in carried), 'API_ADMIN_REGISTRATION_API_SCOPE_CHANGED')


def prepare_registration_build(d):
    root = Path.cwd()
    commit = os.environ['RELEASE_COMMIT']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit
              and d.run('git', 'rev-parse', 'HEAD^{tree}') == os.environ['SOURCE_TREE'],
              'API_ADMIN_BUILD_SOURCE_CHANGED')
    registration_candidate_scope(d, commit)
    profile = registration_profile(d, root)
    target = root / '.deploy/production-release/api-registration-build-context'
    d.require(not target.exists() and not target.is_symlink(), 'API_ADMIN_REGISTRATION_CONTEXT_EXISTS')
    files = {}
    for name, row in profile['workerProjection'].items():
        revision = profile['carriedSourceCommits'].get(name, profile['workerBasisCommit'])
        if name in profile['registrationSourceSha256']:
            revision = profile['registrationSourceCommit']
        raw = subprocess.check_output(['git', 'show', revision + ':' + name])
        d.require(hashlib.sha256(raw).hexdigest() == row['sha256'], 'API_ADMIN_REGISTRATION_BASIS_CHANGED')
        if name in WORKER_PAIR:
            raw = (root / name).read_bytes()
            d.require(raw == subprocess.check_output(['git', 'show', commit + ':' + name])
                      and hashlib.sha256(raw).hexdigest() != row['sha256'], 'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        files[name] = raw
    projection = {n: {'mode': profile['workerProjection'][n]['mode'],
                      'sha256': hashlib.sha256(raw).hexdigest()} for n, raw in files.items()}
    d.require({n for n in projection if projection[n] != profile['workerProjection'][n]} == WORKER_PAIR,
              'API_ADMIN_REGISTRATION_PAIR_CHANGED')
    for name, digest in profile['buildInputSha256'].items():
        # Only these sealed inputs enter the historical Worker build context.
        # The API context below uses the complete candidate Git archive instead;
        # a new API/native .dockerignore must not silently alter this Worker.
        raw = subprocess.check_output(['git', 'show', profile['workerBasisCommit'] + ':' + name])
        d.require(hashlib.sha256(raw).hexdigest() == digest, 'API_ADMIN_REGISTRATION_BUILD_INPUT_CHANGED')
        files[name] = raw
    target.mkdir(parents=True, mode=0o700)
    for name, raw in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        path.chmod(0o755 if projection.get(name, {}).get('mode') == '100755' else 0o644)
    record = {'workerProjection': projection, 'workerProjectionSha256': fingerprint(projection),
              'buildInputSourceCommit': profile['workerBasisCommit'],
              'buildInputSha256': dict(profile['buildInputSha256'])}
    path = target.parent / 'api-registration-build-projection.json'
    with path.open('x') as stream:
        json.dump(record, stream, sort_keys=True)
    path.chmod(0o600)
    # Build the API from the exact Git archive, never ignored/uncommitted files
    # in the runner checkout. The existing API Dockerfile and dependencies apply.
    api_target = target.parent / 'api-registration-api-build-context'
    archive = subprocess.check_output(['git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit])
    source = d.registration_archive(archive, commit)
    d.write_registration_files(api_target, source)
    d.require(source_tree(d, api_target) == os.environ['SOURCE_TREE'], 'API_ADMIN_BUILD_SOURCE_CHANGED')
    return record


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def workspace_configuration(d, previous, candidate):
    """Only the reviewed mount and edge route may differ; no YAML reserialization."""
    d.require(WORKSPACE, 'API_ADMIN_SCOPE_CONFLICT')
    old = (previous / CONFIG_FILES[0]).read_bytes()
    new = (candidate / CONFIG_FILES[0]).read_bytes()
    online = b'  online-recharge:\n' in old
    if online:
        d.require(new == old and b'      - auto_registration_data:/app/.runtime/auto-registration\n' in new
                  and b'      - online_recharge_data:/app/.runtime/online-recharge\n' in new
                  and b'  online_recharge_data:\n' in new, 'API_ADMIN_WORKSPACE_CONFIG_CHANGED')
    mount = b'    volumes:\n      - auto_registration_data:/app/.runtime/auto-registration\n'
    volume = b'  auto_registration_data:\n'
    api = new.split(b'  api:\n', 1)
    d.require(online or (len(api) == 2 and mount in api[1].split(b'  admin:\n', 1)[0]
              and new.count(mount) == 1 and new.count(volume) == 1
              and b'volumes:\n  mysql_data:\n  auto_registration_data:\n  caddy_data:\n' in new),
              'API_ADMIN_WORKSPACE_CONFIG_CHANGED')
    normalized = new.replace(mount, b'', 1).replace(volume, b'', 1)
    d.require(old in (new, normalized), 'API_ADMIN_WORKSPACE_CONFIG_CHANGED')
    before = hashlib.sha256((previous / CONFIG_FILES[1]).read_bytes()).hexdigest()
    after = hashlib.sha256((candidate / CONFIG_FILES[1]).read_bytes()).hexdigest()
    d.require(before in (WORKSPACE_CADDY_BEFORE, WORKSPACE_CADDY_AFTER)
              and after == WORKSPACE_CADDY_AFTER, 'API_ADMIN_WORKSPACE_EDGE_CHANGED')
    return {'composeSha256': hashlib.sha256(new).hexdigest(), 'caddySha256': after,
            'volume': WORKSPACE_VOLUME, 'containerDirectory': WORKSPACE_DIRECTORY}


def online_reader(d):
    d.require(WORKSPACE, 'API_ADMIN_SCOPE_CONFLICT')
    return d.online_recharge_scope()[0]


def workspace_service_names(d, directory):
    names = tuple(d.ALL_SERVICES)
    if WORKSPACE and directory is not None and (directory / CONFIG_FILES[0]).is_file():
        if b'  online-recharge:\n' in (directory / CONFIG_FILES[0]).read_bytes():
            names += (ONLINE_SERVICE,)
    return names


def online_binding(d, directory, states=None):
    states = states or snapshot(d, directory)
    d.require(ONLINE_SERVICE in states, 'API_ADMIN_ONLINE_SERVICE_MISSING')
    worker, api = states[ONLINE_SERVICE], states['api']
    metadata = json.loads(d.run('docker', 'inspect', worker['containerId']))[0]
    api_metadata = json.loads(d.run('docker', 'inspect', api['containerId']))[0]
    mounts = metadata.get('Mounts', [])
    engine = [m for m in mounts if m.get('Destination') == '/workspace/engine/runtime']
    shared = [m for m in api_metadata.get('Mounts', []) if m.get('Destination') == '/app/.runtime/online-recharge']
    d.require(metadata.get('Id') == worker['containerId'] and metadata.get('Image') == worker['image']
              and metadata.get('HostConfig', {}).get('NetworkMode') == 'container:' + api['containerId']
              and not metadata.get('HostConfig', {}).get('PortBindings')
              and len(engine) == len(shared) == 1
              and engine[0].get('Type') == shared[0].get('Type') == 'volume'
              and engine[0].get('Name') == shared[0].get('Name')
              and isinstance(engine[0].get('Name'), str) and engine[0]['Name'].endswith('_online_recharge_data')
              and engine[0].get('RW') is True and shared[0].get('RW') is True,
              'API_ADMIN_ONLINE_BINDING_CHANGED')
    configuration = {key: metadata.get(key) for key in ('Config', 'HostConfig')}
    configuration['Config'] = dict(configuration['Config'])
    labels = dict(configuration['Config'].get('Labels', {}))
    api_config = api_metadata.get('Config', {})
    d.require(configuration['Config'].get('Hostname') == api_config.get('Hostname') == api['containerId'][:12]
        and labels.get('com.docker.compose.service') == ONLINE_SERVICE
        and labels.get('com.docker.compose.container-number') == '1'
        and labels.get('com.docker.compose.project') == api_config.get('Labels', {}).get('com.docker.compose.project')
        and labels.get('com.docker.compose.image') == worker['image']
        and re.fullmatch(r'[a-f0-9]{64}', labels.get('com.docker.compose.config-hash', ''))
        and labels.get('com.docker.compose.depends_on', '') in ('', 'api:service_healthy:true', 'api:service_healthy:false')
        and (labels.get('com.docker.compose.replace') in (None, 'online-recharge-1')
            or re.fullmatch(r'[a-f0-9]{64}', labels.get('com.docker.compose.replace', ''))),
        'API_ADMIN_ONLINE_GENERATED_IDENTITY_CHANGED')
    configuration['Config']['Hostname'] = '${API_HOSTNAME}'
    working = Path(labels.get('com.docker.compose.project.working_dir', ''))
    d.require(working.parent == d.BASE / 'releases' and working.is_dir() and not working.is_symlink()
        and labels.get('com.docker.compose.project.config_files') == ','.join(str(working / n)
            for n in (CONFIG_FILES[0], 'compose.release.json'))
        and (working / CONFIG_FILES[0]).read_bytes() == (directory / CONFIG_FILES[0]).read_bytes()
        and (working / '.env.aws.production').read_bytes() == (directory / '.env.aws.production').read_bytes()
        and labels.get('com.docker.compose.project.environment_file', str(working / '.env.aws.production'))
            == str(working / '.env.aws.production'),
        'API_ADMIN_ONLINE_COMPOSE_ORIGIN_CHANGED')
    labels['com.docker.compose.project.working_dir'] = '${RELEASE}'
    labels['com.docker.compose.project.config_files'] = '${RELEASE}/' + CONFIG_FILES[0] + ',${RELEASE}/compose.release.json'
    labels['com.docker.compose.project.environment_file'] = '${RELEASE}/.env.aws.production'
    labels['com.docker.compose.config-hash'] = '${COMPOSE_SERVICE_HASH}'
    labels['com.docker.compose.depends_on'] = 'api:service_healthy'
    labels.pop('com.docker.compose.replace', None)
    configuration['Config']['Labels'] = labels
    configuration['HostConfig'] = dict(configuration['HostConfig'])
    configuration['HostConfig'].pop('NetworkMode')
    configuration['Mounts'] = sorted(mounts, key=lambda m: m['Destination'])
    volume = json.loads(d.run('docker', 'volume', 'inspect', engine[0]['Name']))[0]
    d.require(volume.get('Name') == engine[0]['Name'], 'API_ADMIN_ONLINE_VOLUME_CHANGED')
    return {'image': worker['image'], 'reference': worker['reference'],
        'environmentSha256': worker['environmentSha256'], 'configurationSha256': fingerprint(configuration),
        'volumeIdentitySha256': fingerprint(volume), 'apiContainerId': api['containerId'],
        'containerId': worker['containerId'], 'startedAtSha256': worker['startedAtSha256']}


def online_marker(context):
    return {'version': 1, 'commit': context['commit'], 'manifestSha256': context['manifestSha256'],
            'buildProofSha256': context['buildProofSha256'], 'preservationSha256': fingerprint(context)}


def online_fence_receipt(d, value):
    d.require(isinstance(value, dict) and set(value) == {'version', 'busyCount', 'sameConnection',
        'mysqlIdentitySha256', 'connectionIdSha256', 'businessActions'}
        and type(value['version']) is int and value['version'] == 1 and value['sameConnection'] is True
        and all(type(value[n]) is int and value[n] == 0 for n in ('busyCount', 'businessActions'))
        and all(isinstance(value[n], str) and re.fullmatch(r'[a-f0-9]{64}', value[n])
            for n in ('mysqlIdentitySha256', 'connectionIdSha256')), 'API_ADMIN_ONLINE_FENCE_RECEIPT_CHANGED')


def online_source_guard(d, directory):
    online = online_reader(d)
    online.recovery_policy(d)
    policy = directory / 'scripts/production-release' / online.RECOVERY_FILE
    d.require(policy.is_file() and not policy.is_symlink() and policy.stat().st_size <= 256 * 1024
              and policy.read_bytes() == Path(online.__file__).with_name(online.RECOVERY_FILE).read_bytes(),
              'API_ADMIN_ONLINE_RECOVERY_POLICY_CHANGED')
    online.migration_source_check(d, directory)
    d.require(hashlib.sha256((directory / CONFIG_FILES[0]).read_bytes()).hexdigest() == ONLINE_COMPOSE_SEAL
              and all(online.fingerprint(online.file_inventory(d, directory / name)) == digest
                      for name, digest in ONLINE_SOURCE_SEALS.items()), 'API_ADMIN_ONLINE_SOURCE_CHANGED')
    return online


def online_origin_guard(d, directory, context, *, runtime=True):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256', 'files',
              'migrationState', 'binding'}
    d.require(WORKSPACE and isinstance(context, dict) and set(context) == fields
              and type(context['version']) is int and context['version'] == 1
              and re.fullmatch(r'[a-f0-9]{40}', context['commit'] or ''), 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    origin = Path(context['release']); o = online_reader(d)
    d.require(origin.parent == d.BASE / 'releases' and origin.is_dir() and not origin.is_symlink()
              and set(context['files']) == set(ONLINE_ORIGIN_FILES)
              and all((origin / n).is_file() and not (origin / n).is_symlink()
                  and hashlib.sha256((origin / n).read_bytes()).hexdigest() == digest
                  for n, digest in context['files'].items()), 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    manifest = json.loads((origin / 'release-manifest.json').read_text())
    proof = o.validate_proof(d, json.loads((origin / o.PROOF_FILE).read_text()), context['commit'], manifest['sourceTree'])
    record = json.loads((origin / o.STATE_FILE).read_text()); previous = Path(manifest['previousRelease'])
    d.require(manifest.get('commit') == context['commit'] and manifest.get('previousCommit') == o.BASELINE_COMMIT
              and context['manifestSha256'] == context['files']['release-manifest.json']
              and fingerprint(proof) == context['buildProofSha256'] == record['buildProofSha256']
              and manifest.get('servicesUpdated') == list(o.UPDATED)
              and manifest.get('newMigrations') == [o.MIGRATION_FILE]
              and manifest.get('migrationApplied') is True
              and manifest.get('onlineRechargePublication') == {'version': 1, 'scope': o.SCOPE,
                  'buildProofSha256': fingerprint(proof), 'migration': dict(o.MIGRATION_IDENTITY),
                  'legacyWorkersPublished': False, 'configurationScope': 'ONLINE_RECHARGE_VOLUME_LOOPBACK_ONLY'}
              and previous.parent == d.BASE / 'releases' and previous.is_dir() and not previous.is_symlink()
              and hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest()
                  == manifest.get('previousManifestSha256') == record['baselineEvidence']['manifestSha256']
              and o.configuration_hashes(origin) == record['configurationAfter']
              and o.configuration_hashes(previous) == record['configurationBefore'], 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    online_source_guard(d, origin)
    online_source_guard(d, directory)
    o.protected_source(d, previous, origin)
    preservation = {'environment': o.verify_environment(d, previous, origin,
                        (previous / '.env.aws.production').read_bytes()),
                    'compose': o.verify_compose(d, previous, origin),
                    'caddy': o.verify_caddy_projection(d, previous, origin)}
    d.require(preservation == record.get('preservation'), 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    online_recovery_guard(d, o, previous, origin, manifest, record)
    d.require((origin / '.env.aws.production').read_bytes() == (directory / '.env.aws.production').read_bytes()
              and o.engine_content(d, directory) == o.engine_content(d, origin)
              and hashlib.sha256((origin / CONFIG_FILES[0]).read_bytes()).hexdigest() == proof['composeSourceSha256'],
              'API_ADMIN_ONLINE_SOURCE_CHANGED')
    o.migration_source_check(d, origin); o.migration_source_check(d, directory)
    state = o.migration_database_state(d, directory)
    d.require(state['status'] == 'APPLIED' and state == context['migrationState']
              and all(record['migration'][k] == v for k, v in state.items()), 'API_ADMIN_ONLINE_MIGRATION_CHANGED')
    o.verify_permission_seed(d, directory)
    for n in ('before', 'after'):
        d.require(audit_receipt(d, origin / (n + '-audit.json')) == manifest['dataAudit' + n.title()],
                  'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    d.require(manifest['dataAuditBefore']['checksSha256'] == manifest['dataAuditAfter']['checksSha256'],
              'API_ADMIN_ONLINE_ORIGIN_CHANGED')
    o.backup_receipt(d, origin, manifest)
    o.workspace_backup_receipt(d, origin, previous, record['baselineEvidence'], manifest, record)
    o.workspace_origin(d, previous, origin, record['baselineEvidence'], record['before'])
    o.historical_guard(d, previous, record['baselineEvidence'], origin)
    for service in o.IMAGE_SERVICES:
        o.verify_image_content(d, origin, proof, service)
    if runtime:
        binding = online_binding(d, directory)
        d.require(all(binding[n] == context['binding'][n] for n in
            ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')),
            'API_ADMIN_ONLINE_RUNTIME_CHANGED')
    return context


def online_recovery_guard(d, online, previous, origin, manifest, record):
    """Revalidate the sealed recovery after replacement, without a second publication path."""
    performed = record.get('migration', {}).get('performed')
    d.require(type(performed) is bool and manifest.get('migrationPerformed') is performed,
              'API_ADMIN_ONLINE_MIGRATION_CHANGED')
    evidence = record['baselineEvidence']
    if evidence.get('migrationRecovery') is not None:
        reader = getattr(online, 'release_recovery', online.recovery_origin)
        recovery = reader(d, previous)
        d.require(recovery is not None and manifest.get('migrationRecovery') == recovery['marker']
                  == evidence['migrationRecovery'] and performed is False,
                  'API_ADMIN_ONLINE_ORIGIN_CHANGED')
        online.candidate_recovery_source(d, origin, recovery)
    else:
        d.require(manifest.get('migrationRecovery') is None and performed is True,
                  'API_ADMIN_ONLINE_ORIGIN_CHANGED')


def online_origin(d, directory, manifest, states):
    o = online_reader(d); receipt = o.readback(d, manifest['commit'])
    # Its independent reader verified the raw inspect record. Only the verified
    # generated-identity normalization differs in this successor's snapshot.
    if receipt.get('status') == 'ONLINE_RECHARGE_VERIFIED' and ONLINE_SERVICE in receipt.get('services', {}):
        receipt['services'][ONLINE_SERVICE]['configurationSha256'] = online_binding(d, directory, states)['configurationSha256']
    d.require(receipt.get('status') == 'ONLINE_RECHARGE_VERIFIED' and receipt.get('services') == states
              and receipt.get('migrationApplied') is True and receipt.get('workspaceBackupVerified') is True
              and receipt.get('backupVerified') is True, 'API_ADMIN_ONLINE_NOT_PUBLISHED')
    context = {'version': 1, 'release': str(directory), 'commit': manifest['commit'],
        'manifestSha256': hashlib.sha256((directory / 'release-manifest.json').read_bytes()).hexdigest(),
        'buildProofSha256': receipt['buildProofSha256'], 'migrationState': receipt['migration'],
        'files': {n: hashlib.sha256((directory / n).read_bytes()).hexdigest() for n in ONLINE_ORIGIN_FILES},
        'binding': online_binding(d, directory, states)}
    online_origin_guard(d, directory, context)
    return context


def preserved_migration_guard(d, directory, context, online=None):
    if online is None:
        return migration_successor_guard(d, directory, context)
    o = online_reader(d); origin = Path(online['release'])
    manifest = json.loads((origin / 'release-manifest.json').read_text())
    o.historical_guard(d, Path(manifest['previousRelease']), {'migrationOrigin': context}, origin)


def online_engine_idle(d, metadata):
    script = ("require('/workspace/engine/healthcheck.cjs').check().then(v=>{"
        "const out={ready:v.ready,mode:v.mode,activeTasks:v.activeTasks,stopping:v.stopping,rpcConnected:v.rpcConnected};"
        "process.stdout.write(JSON.stringify(out))}).catch(()=>process.exit(1))")
    value = json.loads(d.run('docker', 'exec', metadata['Id'], 'node', '-e', script, timeout=8))
    d.require(value == {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
              and type(value.get('activeTasks')) is int, 'API_ADMIN_ONLINE_ENGINE_NOT_IDLE')


def online_idle(d, directory):
    o = online_reader(d)
    o.jobs_idle(d, directory, migrated=True)
    value = o.database_read(d, directory, "SELECT JSON_OBJECT('busy', (SELECT COUNT(*) FROM online_recharge_cards "
        "WHERE lease_expires_at > UTC_TIMESTAMP(6)))")
    d.require(value == {'busy': 0}, 'API_ADMIN_ONLINE_TASK_ACTIVE')
    state = d.service_state(directory, ONLINE_SERVICE, include_container_id=True)
    online_engine_idle(d, {'Id': state['containerId']})


class OnlineSqlFence:
    """Same-connection task/card write locks; never writes a business row or executes DDL."""
    QUERY = ("SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',"
        "(SELECT COUNT(*) FROM online_recharge_tasks WHERE status IN ('queued','running') "
        "OR lease_expires_at>UTC_TIMESTAMP(6))+(SELECT COUNT(*) FROM online_recharge_cards "
        "WHERE lease_expires_at>UTC_TIMESTAMP(6)));\n")

    def __init__(self, d, directory):
        self.d, self.directory, self.process = d, directory, None
        self.connection_id, self.buffer = None, b''
        self.mysql = d.service_state(directory, 'mysql', include_container_id=True, include_environment_hash=True)

    def acquire(self):
        self.deadline = time.monotonic() + 120
        database = self.d.current_job_database(self.directory)
        self.d.require(isinstance(database, str) and re.fullmatch(r'[A-Za-z0-9_]+', database),
                       'API_ADMIN_ONLINE_DATABASE_INVALID')
        command = ['docker', 'compose', '--env-file', str(self.directory / '.env.aws.production'),
            '-f', str(self.directory / CONFIG_FILES[0]), '-f', str(self.directory / 'compose.release.json'),
            'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
            'exec mysql --batch --skip-column-names --unbuffered -u root --password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"']
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.send('SET SESSION lock_wait_timeout=5; SET SESSION innodb_lock_wait_timeout=5; '
                      'LOCK TABLES online_recharge_tasks WRITE, online_recharge_cards WRITE;\n')
            self.check_idle()
        except Exception:
            self.close()
            raise RuntimeError('API_ADMIN_ONLINE_FENCE_UNAVAILABLE') from None

    def send(self, source):
        self.d.require(self.process is not None and self.process.poll() is None
                       and time.monotonic() < self.deadline, 'API_ADMIN_ONLINE_FENCE_LOST')
        self.process.stdin.write(source.encode()); self.process.stdin.flush()

    def check_idle(self):
        self.send(self.QUERY)
        deadline = min(self.deadline, time.monotonic() + 10)
        while b'\n' not in self.buffer:
            remaining = deadline - time.monotonic()
            self.d.require(remaining > 0 and self.process.poll() is None, 'API_ADMIN_ONLINE_FENCE_LOST')
            readable, _, _ = select.select([self.process.stdout], [], [], remaining)
            self.d.require(bool(readable), 'API_ADMIN_ONLINE_FENCE_LOST')
            chunk = os.read(self.process.stdout.fileno(), 4096)
            self.d.require(bool(chunk) and len(self.buffer) + len(chunk) <= 4096, 'API_ADMIN_ONLINE_FENCE_LOST')
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b'\n', 1)
        try:
            value = json.loads(line)
        except Exception:
            raise RuntimeError('API_ADMIN_ONLINE_FENCE_LOST') from None
        self.d.require(isinstance(value, dict) and set(value) == {'version', 'connectionId', 'busy'}
                       and type(value['version']) is int and value['version'] == 1
                       and type(value['connectionId']) is int and value['connectionId'] > 0
                       and (self.connection_id is None or self.connection_id == value['connectionId'])
                       and type(value['busy']) is int and value['busy'] == 0, 'API_ADMIN_ONLINE_TASK_ACTIVE')
        self.connection_id = value['connectionId']
        self.d.require(self.d.service_state(self.directory, 'mysql', include_container_id=True,
            include_environment_hash=True) == self.mysql, 'API_ADMIN_ONLINE_FENCE_LOST')
        return {'busy': 0, 'sameConnection': True}

    def stop(self, identity, *, grace):
        self.check_idle()
        remaining = self.deadline - time.monotonic()
        self.d.require(remaining > grace + 5, 'API_ADMIN_ONLINE_FENCE_TIMEOUT')
        metadata = json.loads(self.d.run('docker', 'inspect', identity['containerId'], timeout=10))[0]
        self.d.require(metadata.get('Id') == identity['containerId'] and metadata.get('Image') == identity['image']
            and hashlib.sha256(metadata['State']['StartedAt'].encode()).hexdigest() == identity['startedAtSha256'],
            'API_ADMIN_ONLINE_CONTAINER_CHANGED')
        if metadata['State'].get('Running') is True:
            self.d.run('docker', 'stop', '--time', str(grace), identity['containerId'],
                       timeout=min(grace + 5, self.deadline - time.monotonic()))
        metadata = json.loads(self.d.run('docker', 'inspect', identity['containerId'], timeout=10))[0]
        self.d.require(metadata.get('Id') == identity['containerId'] and metadata['State'].get('Running') is False,
                       'API_ADMIN_ONLINE_CONTAINER_NOT_STOPPED')
        self.check_idle()

    def close(self):
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    self.process.stdin.write(b'UNLOCK TABLES;\n'); self.process.stdin.flush()
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except Exception:
                self.process.kill(); self.process.wait(timeout=3)
            finally:
                self.process.stdout.close(); self.process = None


class WorkspaceAuditBarrier(OnlineSqlFence):
    """Legacy proxy mutations await audit INSERT before forwarding to the worker."""

    def __init__(self, d, directory):
        super().__init__(d, directory)
        self.api_identity = workspace_api_identity(d, directory)
        # Truncate to the same millisecond Date boundary used by the legacy Prisma read.
        since = self.api_identity['startedAt'].replace('T', ' ').rstrip('Z')
        if '.' in since:
            first, fraction = since.split('.', 1)
            since = first + '.' + fraction[:3].ljust(3, '0')
        stamp = 'CONVERT(0x' + since.encode().hex() + ' USING utf8mb4)'
        def literal(value):
            return 'CONVERT(0x' + value.encode().hex() + ' USING utf8mb4)'
        self.QUERY = ("SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',"
            "IF(UTC_TIMESTAMP(6)<CAST(" + stamp + " AS DATETIME(6)),1,(SELECT COUNT(*) FROM audit_logs "
            "WHERE created_at>=CAST(" + stamp + " AS DATETIME(6)) AND module=" + literal('自动注册')
            + " AND action=" + literal('操作请求') + " AND object_type=" + literal('开源注册模块')
            + " AND (remark LIKE '% /api/registration%' OR remark LIKE '% /api/ws/%'))));\n")

    def acquire(self):
        self.deadline = time.monotonic() + 180
        workspace_audit_protection(self.d, self.directory)
        database = self.d.current_job_database(self.directory)
        self.d.require(isinstance(database, str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}', database),
                       'API_ADMIN_WORKSPACE_DATABASE_IDENTITY_CHANGED')
        command = ['docker', 'exec', '-i', '-e', 'MYSQL_DATABASE=' + database,
            self.mysql['containerId'], 'sh', '-c',
            'exec mysql --batch --raw --skip-column-names --unbuffered --skip-reconnect -u root '
            '--password="$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"']
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        try:
            self.send('SET SESSION autocommit=0; SET SESSION lock_wait_timeout=5; '
                      'SET SESSION wait_timeout=210; LOCK TABLES audit_logs READ;\n')
            self.check_idle()
            self.d.require(workspace_api_identity(self.d, self.directory, expected=self.api_identity)
                           == self.api_identity, 'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
        except Exception:
            self.close()
            raise RuntimeError('API_ADMIN_WORKSPACE_AUDIT_GUARD_FAILED') from None

    def before_stop(self):
        self.check_idle()
        self.d.require(time.monotonic() + 45 < self.deadline, 'API_ADMIN_WORKSPACE_GUARD_TIMEOUT')


def online_rebind(d, directory, context):
    d.compose(directory, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', ONLINE_SERVICE, timeout=300)
    d.wait_healthy(directory, ONLINE_SERVICE)
    binding = online_binding(d, directory)
    d.require(all(binding[n] == context['binding'][n] for n in
        ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')),
        'API_ADMIN_ONLINE_RUNTIME_CHANGED')
    return binding


def online_container(d, directory, name, images):
    identifier = d.compose(directory, 'ps', '-q', '--all', name)
    if not identifier:
        return None
    metadata = json.loads(d.run('docker', 'inspect', identifier))[0]
    d.require(re.fullmatch(r'[a-f0-9]{64}', identifier) and metadata.get('Id') == identifier
              and metadata.get('Image') in images and isinstance(metadata.get('State', {}).get('StartedAt'), str),
              'API_ADMIN_ONLINE_CONTAINER_CHANGED')
    return {'containerId': identifier, 'image': metadata['Image'],
            'startedAtSha256': hashlib.sha256(metadata['State']['StartedAt'].encode()).hexdigest()}


def workspace_database_controller(d, directory, identity):
    class Controller:
        def __getattr__(self, name):
            return getattr(d, name)
        def current_job_database(self, selected):
            return workspace_database_identity(d, directory, identity)['database']
    return Controller()


def online_rollback_api(d, previous, target, before, proof, context, *, database_identity=None):
    controller = workspace_database_controller(d, previous, database_identity) if database_identity is not None else d
    fence = OnlineSqlFence(controller, previous)
    try:
        fence.acquire()
        api = online_container(d, target, 'api', {before['api']['image'], proof['images']['api']['imageId']})
        engine = online_container(d, target, ONLINE_SERVICE, {before[ONLINE_SERVICE]['image']})
        if api is not None:
            fence.stop(api, grace=30)
        fence.check_idle()
        if engine is not None:
            fence.stop(engine, grace=45)
    finally:
        fence.close()
    d.rollback_service(previous, target, 'api', before)
    return online_rebind(d, previous, context)


def workspace_database_identity(d, directory, identity=None):
    """Reuse only an identity measured live before stop, with unchanged MySQL/env."""
    environment = hashlib.sha256((directory / '.env.aws.production').read_bytes()).hexdigest()
    mysql = d.service_state(directory, 'mysql', include_container_id=True, include_environment_hash=True)
    if identity is None:
        return {'database': d.current_job_database(directory), 'environmentSha256': environment, 'mysql': mysql}
    d.require(WORKSPACE and isinstance(identity, dict)
              and set(identity) == {'database', 'environmentSha256', 'mysql'}
              and re.fullmatch(r'[A-Za-z0-9_]{1,64}', identity['database'] or '')
              and identity['environmentSha256'] == environment and identity['mysql'] == mysql
              and mysql.get('status') == 'running' and mysql.get('health') == 'healthy',
              'API_ADMIN_WORKSPACE_DATABASE_IDENTITY_CHANGED')
    return identity

def workspace_api_metadata(d, directory):
    """Compose's normal ps omits stopped containers; read the selected project's sole API."""
    identifier = d.compose(directory, 'ps', '--all', '-q', 'api', timeout=10)
    d.require(isinstance(identifier, str) and re.fullmatch(r'[a-f0-9]{64}', identifier),
              'API_ADMIN_WORKSPACE_API_CONTAINER_UNAVAILABLE')
    rows = json.loads(d.run('docker', 'inspect', identifier, timeout=5))
    d.require(isinstance(rows, list) and len(rows) == 1 and rows[0].get('Id') == identifier
              and rows[0].get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == 'api'
              and type(rows[0].get('State', {}).get('Running')) is bool,
              'API_ADMIN_WORKSPACE_API_CONTAINER_UNAVAILABLE')
    return rows[0]

def workspace_public_origin(d, directory):
    value = urlsplit(d.environment_values(directory / '.env.aws.production')['APP_PUBLIC_URL'])
    d.require(value.scheme == 'https' and value.hostname and not value.username and not value.password
              and not value.query and not value.fragment and value.path in ('', '/')
              and re.fullmatch(r'[A-Za-z0-9.-]{1,253}', value.hostname)
              and (value.port is None or 1 <= value.port <= 65535), 'API_ADMIN_WORKSPACE_PUBLIC_ORIGIN_INVALID')
    return 'https://' + value.hostname + (':' + str(value.port) if value.port is not None else '')

def workspace_audit_protection(d, directory, database_identity=None):
    """Inspect only immutable trigger definitions, never audit contents."""
    files = (('DELETE', '20261002123500_routine_audit_retention_exception'),
             ('UPDATE', '20260830182500_mysql_trigger_service_definers'))
    expected = {}
    for event, migration in files:
        raw = (directory / MIGRATION_ROOT / migration / 'migration.sql').read_text()
        name = 'idv2_audit_log_no_' + ('delete' if event == 'DELETE' else 'update')
        body = raw.split('CREATE TRIGGER `' + name + '`', 1)[1].split('FOR EACH ROW', 1)[1]
        body = body.split('END;', 1)[0] + 'END' if event == 'DELETE' else body.split(';', 1)[0]
        expected[event] = ' '.join(body.split()).rstrip(';')
    database = (workspace_database_identity(d, directory, database_identity)['database']
                if database_identity is not None else d.current_job_database(directory))
    query = ("SELECT JSON_ARRAYAGG(JSON_OBJECT('event',EVENT_MANIPULATION,'timing',ACTION_TIMING,"
        "'statement',ACTION_STATEMENT)) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() "
        "AND EVENT_OBJECT_TABLE='audit_logs'")
    raw = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --raw --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "' + query + '"', timeout=15)
    rows = json.loads(raw)
    d.require(isinstance(rows, list) and len(rows) == 2
              and all(isinstance(row, dict) and set(row) == {'event', 'timing', 'statement'}
                      and row['timing'] == 'BEFORE' and isinstance(row['statement'], str) for row in rows)
              and {row['event']: ' '.join(row['statement'].split()).rstrip(';') for row in rows} == expected,
              'API_ADMIN_WORKSPACE_AUDIT_HISTORY_UNPROVEN')
    return fingerprint(expected)


def workspace_present(directory, metadata=None):
    path = directory / CONFIG_FILES[0]
    configured = path.is_file() and (b'auto_registration_data:/app/.runtime/auto-registration' in path.read_bytes()
                                    or re.search(rb'(?m)^  auto_registration_data:\s*$', path.read_bytes()) is not None)
    mounted = any(m.get('Destination') == WORKSPACE_DIRECTORY for m in (metadata or {}).get('Mounts', []))
    return bool(configured or mounted)


def workspace_existing(d, directory):
    """Include an orphaned volume retained by rollback, even with old configuration."""
    state = d.service_state(directory, 'api', include_container_id=True)
    api = json.loads(d.run('docker', 'inspect', state['containerId']))[0]
    if workspace_present(directory, api):
        return True
    project = api.get('Config', {}).get('Labels', {}).get('com.docker.compose.project')
    d.require(isinstance(project, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', project),
              'API_ADMIN_WORKSPACE_PROJECT_INVALID')
    name = project + '_' + WORKSPACE_VOLUME
    found = d.run('docker', 'volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}')
    d.require(found in ('', name), 'API_ADMIN_WORKSPACE_VOLUME_CHANGED')
    return bool(found)


def workspace_volume(d, directory, *, empty=False, attached=False, api_metadata=None):
    """Read volume identity only; SQLite values and logs never enter the receipt."""
    if api_metadata is None:
        state = d.service_state(directory, 'api', include_container_id=True)
        api = json.loads(d.run('docker', 'inspect', state['containerId']))[0]
    else:
        api = api_metadata
    project = api.get('Config', {}).get('Labels', {}).get('com.docker.compose.project')
    d.require(isinstance(project, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', project),
              'API_ADMIN_WORKSPACE_PROJECT_INVALID')
    name = project + '_' + WORKSPACE_VOLUME
    found = d.run('docker', 'volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}')
    if not found:
        d.require(not attached, 'API_ADMIN_WORKSPACE_VOLUME_MISSING')
        return {'name': name, 'status': 'ABSENT', 'identitySha256': None}
    d.require(found == name, 'API_ADMIN_WORKSPACE_VOLUME_CHANGED')
    rows = json.loads(d.run('docker', 'volume', 'inspect', name))
    d.require(isinstance(rows, list) and len(rows) == 1, 'API_ADMIN_WORKSPACE_VOLUME_CHANGED')
    value = rows[0]
    labels = value.get('Labels') or {}
    d.require(value.get('Name') == name and value.get('Driver') == 'local' and value.get('Scope') == 'local'
              and value.get('Options') in (None, {})
              and labels.get('com.docker.compose.project') == project
              and labels.get('com.docker.compose.volume') == WORKSPACE_VOLUME,
              'API_ADMIN_WORKSPACE_VOLUME_CHANGED')
    root = Path(value.get('Mountpoint', ''))
    d.require(root.is_absolute() and root.resolve() == root and root.is_dir() and not root.is_symlink(),
              'API_ADMIN_WORKSPACE_VOLUME_PATH_INVALID')
    if empty:
        d.require(not any(root.iterdir()), 'API_ADMIN_WORKSPACE_SQLITE_BACKUP_REQUIRED')
    if attached:
        mounts = [m for m in api.get('Mounts', []) if m.get('Destination') == WORKSPACE_DIRECTORY]
        d.require(len(mounts) == 1 and mounts[0].get('Type') == 'volume'
                  and mounts[0].get('Name') == name and mounts[0].get('RW') is True,
                  'API_ADMIN_WORKSPACE_MOUNT_CHANGED')
    identity = {n: value.get(n) for n in ('Name', 'Driver', 'Scope', 'Mountpoint', 'Labels', 'CreatedAt', 'Options')}
    return {'name': name, 'status': 'PRESENT', 'identitySha256': fingerprint(identity)}


def workspace_idle(d, directory, *, legacy=False, api_metadata=None):
    """Fail closed before stopping a worker; read only the controlled task statuses."""
    identity = workspace_volume(d, directory, **({'api_metadata': api_metadata} if api_metadata is not None else {}))
    if identity['status'] == 'ABSENT':
        return identity
    value = json.loads(d.run('docker', 'volume', 'inspect', identity['name']))[0]
    root = Path(value['Mountpoint'])
    database = root / 'database.db'
    if not database.exists():
        d.require(not any(root.iterdir()), 'API_ADMIN_WORKSPACE_TASK_STATE_UNAVAILABLE')
        return identity
    d.require(database.is_file() and not database.is_symlink()
              and all(not (root / ('database.db' + suffix)).is_symlink() for suffix in ('-wal', '-shm', '-journal')),
              'API_ADMIN_WORKSPACE_TASK_STATE_UNAVAILABLE')
    try:
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2) as connection:
            connection.execute('PRAGMA query_only = ON')
            rows = connection.execute('SELECT status, COUNT(*) FROM registration_tasks GROUP BY status').fetchall()
        d.require(all(status in ('pending', 'running', 'completed', 'failed', 'cancelled')
                      and type(count) is int and count >= 0 for status, count in rows)
                  and sum(count for status, count in rows if status in ('pending', 'running') or legacy and status == 'cancelled') == 0,
                  'API_ADMIN_WORKSPACE_TASK_ACTIVE')
    except sqlite3.Error:
        raise RuntimeError('API_ADMIN_WORKSPACE_TASK_STATE_UNAVAILABLE') from None
    return identity


def workspace_api_identity(d, directory, *, expected=None, timeout=30):
    state = d.service_state(directory, 'api', include_container_id=True) if expected is None else expected
    value = json.loads(d.run('docker', 'inspect', state['containerId'], timeout=timeout))[0]
    started = value.get('State', {}).get('StartedAt', '')
    d.require(value.get('Id') == state['containerId'] and value.get('Image') == state['image']
              and value.get('State', {}).get('Running') is True
              and re.fullmatch(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z', started)
              and hashlib.sha256(started.encode()).hexdigest() == state['startedAtSha256'],
              'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
    # Date.parse and MySQL UTC_TIMESTAMP must agree; an unverifiable/future start is rejected.
    from datetime import datetime, timezone
    observed = datetime.fromisoformat(started[:19] + '+00:00')
    d.require(0 < observed.timestamp() <= datetime.now(timezone.utc).timestamp() + 5,
              'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
    return {'containerId': state['containerId'], 'image': state['image'],
            'startedAtSha256': state['startedAtSha256'], 'startedAt': started}


def workspace_legacy_audit(d, directory, identity=None, *, deadline=None):
    """Old workers lack a live-thread protocol. Any registration mutation since boot blocks them."""
    identity = identity or workspace_api_identity(d, directory)
    timeout = 30 if deadline is None else min(30, deadline - time.monotonic())
    d.require(timeout > 0, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
    source = r'''const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
const since=new Date(process.argv[1]);
(async()=>{if(!Number.isFinite(+since))throw Error();
const clock=await p.$queryRaw`SELECT UTC_TIMESTAMP(6) AS observed`;
if(clock.length!==1||!(clock[0].observed instanceof Date)||+clock[0].observed<+since)throw Error();
const mutationCount=await p.auditLog.count({where:{module:'自动注册',action:'操作请求',objectType:'开源注册模块',
createdAt:{gte:since},OR:[{remark:{contains:' /api/registration'}},{remark:{contains:' /api/ws/'}}]}});
if(!Number.isSafeInteger(mutationCount)||mutationCount<0)throw Error();
console.log(JSON.stringify({version:1,mutationCount}));})().catch(()=>process.exitCode=2).finally(()=>p.$disconnect());'''
    try:
        result = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source,
                                     identity['startedAt'], timeout=timeout))
    except Exception:
        raise RuntimeError('API_ADMIN_WORKSPACE_LEGACY_AUDIT_UNAVAILABLE') from None
    d.require(isinstance(result, dict) and set(result) == {'version', 'mutationCount'}
              and type(result['version']) is int and result['version'] == 1
              and type(result['mutationCount']) is int and result['mutationCount'] == 0,
              'API_ADMIN_WORKSPACE_LEGACY_MUTATION_UNVERIFIED')
    timeout = 30 if deadline is None else min(30, deadline - time.monotonic())
    d.require(timeout > 0, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
    d.require(workspace_api_identity(d, directory, expected=identity, timeout=timeout) == identity,
              'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
    return {'legacyMutationCount': 0, 'containerId': identity['containerId'],
            'startedAtSha256': identity['startedAtSha256']}


def workspace_safety_result(d, value):
    fields = {'version', 'status', 'schemaSha256', 'logicalSha256', 'tableCounts', 'taskCounts',
              'activeAppleLeaseCount', 'corruptEncryptedValueCount', 'businessActions'}
    d.require(isinstance(value, dict) and set(value) == fields and type(value['version']) is int
              and value['version'] == 1 and value['status'] == 'PASS'
              and all(isinstance(value[n], str) and re.fullmatch(r'[a-f0-9]{64}', value[n])
                      for n in ('schemaSha256', 'logicalSha256'))
              and isinstance(value['tableCounts'], dict)
              and set(value['tableCounts']) == {'accounts', 'email_services', 'registration_tasks', 'settings',
                     'proxies', 'cpa_services', 'sub2api_services', 'tm_services'}
              and all(type(n) is int and 0 <= n <= 2_000_000 for n in value['tableCounts'].values())
              and isinstance(value['taskCounts'], dict)
              and set(value['taskCounts']) == {'pending', 'running', 'completed', 'failed', 'cancelled'}
              and all(type(n) is int and 0 <= n <= 2_000_000 for n in value['taskCounts'].values())
              and value['taskCounts']['pending'] == value['taskCounts']['running'] == 0
              and sum(value['taskCounts'].values()) == value['tableCounts']['registration_tasks']
              and all(type(value[n]) is int and value[n] == 0 for n in
                      ('activeAppleLeaseCount', 'corruptEncryptedValueCount', 'businessActions')),
              'API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED')
    return value


def workspace_private_inspect(d, directory, reference, volume, *, mode='inspect', expected=None, timeout=60):
    values = d.environment_values(directory / '.env.aws.production')
    key = values.get('FIELD_ENCRYPTION_KEY')
    d.require(isinstance(key, str) and len(key) >= 32, 'API_ADMIN_WORKSPACE_SQLITE_KEY_UNAVAILABLE')
    request = {'mode': mode, 'databasePath': WORKSPACE_DIRECTORY + '/database.db', 'encryptionKey': key}
    if expected is not None:
        request['expectedLogicalSha256'] = expected
    try:
        output = d.run('docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
            '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
            '--mount', 'type=volume,source=' + volume + ',target=' + WORKSPACE_DIRECTORY + ',readonly',
            '--entrypoint', '/opt/id-registration/venv/bin/python', reference, '-B',
            '/app/' + WORKSPACE_SAFETY, timeout=timeout, input_data=json.dumps(request))
        result = workspace_safety_result(d, json.loads(output))
    except Exception:
        raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED') from None
    return result


class WorkspaceSqliteProtection:
    """A bounded writer fence, immutable encrypted backup and isolated restore proof."""

    def __init__(self, d, previous, target, proof, args, *, legacy):
        self.d, self.previous, self.target, self.proof, self.args = d, previous, target, proof, args
        self.legacy, self.connection, self.marker_bytes = legacy, None, None
        self.volume = workspace_volume(d, previous, attached=True)
        meta = json.loads(d.run('docker', 'volume', 'inspect', self.volume['name']))[0]
        self.root = Path(meta['Mountpoint'])
        self.database = self.root / 'database.db'
        self.marker = self.root / WORKSPACE_MAINTENANCE
        self.summary = None
        self.record = None
        self.api_identity = workspace_api_identity(d, previous)

    def summary_reader(self):
        path = self.target / WORKSPACE_SAFETY
        self.d.require(path.is_file() and not path.is_symlink(), 'API_ADMIN_WORKSPACE_SQLITE_HELPER_MISSING')
        spec = importlib.util.spec_from_file_location('id_release_sqlite_safety', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.logical_summary

    def lock(self):
        self.deadline = time.monotonic() + 150
        self.d.require(not self.marker.exists() and not self.marker.is_symlink(),
                       'API_ADMIN_WORKSPACE_MAINTENANCE_EXISTS')
        self.d.require(self.database.is_file() and not self.database.is_symlink()
                       and stat.S_IMODE(self.database.stat().st_mode) == 0o600
                       and all(not (self.root / ('database.db' + suffix)).is_symlink()
                               for suffix in ('-wal', '-shm', '-journal')),
                       'API_ADMIN_WORKSPACE_SQLITE_SOURCE_INVALID')
        self.database_identity = (self.database.stat().st_dev, self.database.stat().st_ino)
        try:
            self.connection = sqlite3.connect(self.database.as_uri() + '?mode=rw', uri=True, timeout=2)
            self.connection.execute('BEGIN IMMEDIATE')
            self.connection.set_progress_handler(lambda: int(time.monotonic() >= self.deadline), 10000)
            self.d.require(self.connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)],
                           'API_ADMIN_WORKSPACE_SQLITE_INTEGRITY_FAILED')
            self.summary = self.summary_reader()(self.connection)
            tasks = self.summary['taskCounts']
            self.d.require(tasks['pending'] == tasks['running'] == 0
                           and (not self.legacy or tasks['cancelled'] == 0),
                           'API_ADMIN_WORKSPACE_TASK_ACTIVE')
            if self.legacy:
                self.legacy_proof = workspace_legacy_audit(self.d, self.previous, self.api_identity, deadline=self.deadline)
            else:
                self.legacy_proof = None
            marker = {'version': 1, 'runId': self.args.run_id, 'runAttempt': self.args.run_attempt,
                      'candidateCommit': self.args.commit, 'nonce': secrets.token_hex(32)}
            self.marker_bytes = (json.dumps(marker, sort_keys=True, separators=(',', ':')) + '\n').encode()
            descriptor = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(self.marker_bytes); stream.flush(); os.fsync(stream.fileno())
            os.chown(self.marker, self.database.stat().st_uid, self.database.stat().st_gid)
            self.marker_identity = (self.marker.stat().st_dev, self.marker.stat().st_ino)
            self.check_locked()
        except Exception:
            self.close()
            raise

    def check_marker(self):
        self.d.require(self.marker_bytes is not None and self.marker.is_file() and not self.marker.is_symlink()
                       and stat.S_IMODE(self.marker.stat().st_mode) == 0o600
                       and (self.marker.stat().st_dev, self.marker.stat().st_ino) == self.marker_identity
                       and self.marker.read_bytes() == self.marker_bytes,
                       'API_ADMIN_WORKSPACE_MAINTENANCE_CHANGED')

    def check_locked(self):
        self.check_marker()
        self.d.require(time.monotonic() < self.deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
        self.d.require(self.connection is not None and self.connection.in_transaction
                       and (self.database.stat().st_dev, self.database.stat().st_ino) == self.database_identity
                       and not self.database.is_symlink()
                       and self.summary_reader()(self.connection) == self.summary,
                       'API_ADMIN_WORKSPACE_SQLITE_SOURCE_CHANGED')
        self.d.require(workspace_api_identity(self.d, self.previous, expected=self.api_identity,
                       timeout=min(30, self.deadline - time.monotonic())) == self.api_identity,
                       'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
        if self.legacy:
            self.d.require(workspace_legacy_audit(self.d, self.previous, self.api_identity,
                           deadline=self.deadline) == self.legacy_proof,
                           'API_ADMIN_WORKSPACE_LEGACY_MUTATION_UNVERIFIED')

    def backup_restore(self):
        self.check_locked()
        self.d.require(self.database.stat().st_size <= 256 * 1024**2
                       and shutil.disk_usage(self.target).free > max(2 * 1024**3, self.database.stat().st_size * 4),
                       'API_ADMIN_WORKSPACE_SQLITE_CAPACITY_FAILED')
        backup_root = self.target / 'backups'
        backup_root.mkdir(mode=0o700, exist_ok=True)
        self.d.require(backup_root.is_dir() and not backup_root.is_symlink()
                       and stat.S_IMODE(backup_root.stat().st_mode) == 0o700,
                       'API_ADMIN_WORKSPACE_SQLITE_BACKUP_PATH_INVALID')
        directory = backup_root / 'auto-registration'
        directory.mkdir(mode=0o700)
        backup = directory / 'database.db'
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        deadline = min(self.deadline, time.monotonic() + 30)
        def progress(*_):
            self.d.require(time.monotonic() < deadline, 'API_ADMIN_WORKSPACE_SQLITE_BACKUP_TIMEOUT')
        with closing(sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True, timeout=2)) as source:
            with closing(sqlite3.connect(backup)) as destination:
                source.backup(destination, pages=256, progress=progress, sleep=0.01)
                # A WAL source can transfer its journal flag. Seal the independent
                # snapshot as a standalone database before mounting its restore read-only.
                self.d.require(destination.execute('PRAGMA journal_mode=DELETE').fetchone() == ('delete',),
                               'API_ADMIN_WORKSPACE_SQLITE_BACKUP_CHANGED')
                self.d.require(destination.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
                               and self.summary_reader()(destination) == self.summary,
                               'API_ADMIN_WORKSPACE_SQLITE_BACKUP_CHANGED')
        with backup.open('rb') as stream:
            os.fsync(stream.fileno())
        name = 'id-sqlite-restore-' + self.args.run_id + '-' + self.args.run_attempt
        self.d.require(re.fullmatch(r'id-sqlite-restore-[1-9][0-9]*-[1-9][0-9]*', name)
                       and not self.d.run('docker', 'volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'),
                       'API_ADMIN_WORKSPACE_RESTORE_VOLUME_EXISTS')
        self.d.run('docker', 'volume', 'create', '--label', 'id-business-v2.sqlite-restore=' + self.args.run_id + '-' + self.args.run_attempt, name)
        try:
            meta = json.loads(self.d.run('docker', 'volume', 'inspect', name))[0]
            clone = Path(meta['Mountpoint'])
            self.d.require(clone.is_absolute() and clone.resolve() == clone and clone.is_dir()
                           and not clone.is_symlink() and not any(clone.iterdir()),
                           'API_ADMIN_WORKSPACE_RESTORE_VOLUME_CHANGED')
            clone.chmod(0o700)
            original_stat = self.database.stat()
            os.chown(clone, original_stat.st_uid, original_stat.st_gid)
            cloned_db = clone / 'database.db'
            descriptor = os.open(cloned_db, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(descriptor)
            shutil.copyfile(backup, cloned_db)
            cloned_db.chmod(0o600)
            os.chown(cloned_db, original_stat.st_uid, original_stat.st_gid)
            restored = workspace_private_inspect(self.d, self.previous, self.proof['images']['api']['reference'],
                                                name, mode='restore', expected=self.summary['logicalSha256'],
                                                timeout=max(0.1, min(60, self.deadline - time.monotonic())))
            self.d.require(all(restored[key] == self.summary[key] for key in self.summary),
                           'API_ADMIN_WORKSPACE_SQLITE_RESTORE_CHANGED')
        finally:
            meta = json.loads(self.d.run('docker', 'volume', 'inspect', name))[0]
            self.d.require(meta.get('Name') == name and meta.get('Labels', {}).get('id-business-v2.sqlite-restore')
                           == self.args.run_id + '-' + self.args.run_attempt,
                           'API_ADMIN_WORKSPACE_RESTORE_VOLUME_CHANGED')
            self.d.run('docker', 'volume', 'rm', name)
        self.check_locked()
        self.record = {'version': 1, 'volume': self.volume, 'backupName': 'backups/auto-registration/database.db',
            'backupSha256': hashlib.sha256(backup.read_bytes()).hexdigest(), 'backupSize': backup.stat().st_size,
            'sourceDatabaseIdentitySha256': fingerprint(self.database_identity),
            'sourceApiIdentity': {k: v for k, v in self.api_identity.items() if k != 'startedAt'},
            'candidateImageId': self.proof['images']['api']['imageId'], 'inspection': restored,
            'legacyAudit': self.legacy_proof, 'sourceSummary': self.summary,
            'maintenanceSha256': hashlib.sha256(self.marker_bytes).hexdigest(),
            'restoreVerified': True, 'temporaryRestoreVolumeRemoved': True, 'volumeDeletionPerformed': False}
        receipt = self.target / WORKSPACE_SQLITE_RECEIPT
        with receipt.open('x') as stream:
            json.dump(self.record, stream, sort_keys=True); stream.write('\n')
        receipt.chmod(0o600)
        return self.record

    def stop_previous(self):
        self.check_locked()
        remaining = self.deadline - time.monotonic()
        self.d.require(remaining > 35, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
        self.d.run('docker', 'stop', '--time', '30', self.api_identity['containerId'], timeout=min(45, remaining - 2))
        remaining = self.deadline - time.monotonic()
        self.d.require(remaining > 0, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
        value = json.loads(self.d.run('docker', 'inspect', self.api_identity['containerId'], timeout=min(15, remaining)))[0]
        self.d.require(value.get('Id') == self.api_identity['containerId']
                       and value.get('State', {}).get('Running') is False,
                       'API_ADMIN_WORKSPACE_OLD_API_NOT_STOPPED')
        self.close()

    def finish(self):
        self.check_marker()
        current = workspace_private_inspect(self.d, self.target, self.proof['images']['api']['reference'],
                                            self.volume['name'], expected=self.summary['logicalSha256'])
        self.d.require(all(current[key] == self.summary[key] for key in self.summary),
                       'API_ADMIN_WORKSPACE_SQLITE_SOURCE_CHANGED')
        self.check_marker()
        self.marker.unlink()

    def abort(self):
        """Clear only our fence after the original image and unchanged, idle data are proven."""
        self.close()
        if self.marker_bytes is None:
            return
        self.check_marker()
        self.d.require(not self.database.is_symlink()
                       and (self.database.stat().st_dev, self.database.stat().st_ino) == self.database_identity,
                       'API_ADMIN_WORKSPACE_SQLITE_SOURCE_CHANGED')
        identity = workspace_api_identity(self.d, self.previous)
        self.d.require(identity['image'] == self.api_identity['image'],
                       'API_ADMIN_WORKSPACE_OLD_API_NOT_RESTORED')
        deadline = time.monotonic() + 60
        try:
            self.connection = sqlite3.connect(self.database.as_uri() + '?mode=rw', uri=True, timeout=2)
            self.connection.execute('BEGIN IMMEDIATE')
            self.connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
            self.d.require(self.summary_reader()(self.connection) == self.summary,
                           'API_ADMIN_WORKSPACE_SQLITE_SOURCE_CHANGED')
            if self.legacy:
                workspace_legacy_audit(self.d, self.previous, identity, deadline=deadline)
            else:
                workspace_private_inspect(self.d, self.previous, identity['image'], self.volume['name'],
                                          expected=self.summary['logicalSha256'],
                                          timeout=max(0.1, min(30, deadline - time.monotonic())))
            self.d.require(time.monotonic() < deadline, 'API_ADMIN_WORKSPACE_SQLITE_FENCE_TIMEOUT')
            self.d.require(workspace_api_identity(self.d, self.previous, expected=identity,
                           timeout=min(15, deadline - time.monotonic())) == identity,
                           'API_ADMIN_WORKSPACE_API_IDENTITY_CHANGED')
            self.check_marker()
            self.marker.unlink()
        finally:
            self.close()

    def close(self):
        if self.connection is not None:
            self.connection.rollback(); self.connection.close(); self.connection = None


def workspace_prepare(d, previous, target, proof, args, evidence, *, legacy):
    if evidence['workspaceVolume']['status'] == 'ABSENT':
        workspace_volume(d, previous, empty=True)
        return None
    volume = workspace_volume(d, previous, attached=True)
    meta = json.loads(d.run('docker', 'volume', 'inspect', volume['name']))[0]
    root = Path(meta['Mountpoint'])
    if not (root / 'database.db').exists():
        workspace_volume(d, previous, empty=True)
        return None
    gate = WorkspaceSqliteProtection(d, previous, target, proof, args, legacy=legacy)
    try:
        gate.lock()
        gate.backup_restore()
    except Exception as error:
        gate.close()
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_WORKSPACE_SQLITE_PREPARATION_FAILED'
        failure = RuntimeError(code)
        failure.sqlite_gate = gate
        raise failure from None
    return gate


def workspace_sqlite_receipt(d, directory, proof, record, manifest):
    digest = manifest['apiWorkspacePublication'].get('sqliteProtectionSha256')
    if digest is None:
        d.require('sqliteProtectionSha256' not in record, 'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
        return None
    path = directory / WORKSPACE_SQLITE_RECEIPT
    d.require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest)
              and record.get('sqliteProtectionSha256') == digest and path.is_file() and not path.is_symlink()
              and stat.S_IMODE(path.stat().st_mode) == 0o600 and path.stat().st_size < 16384,
              'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
    value = json.loads(path.read_bytes())
    fields = {'version', 'volume', 'backupName', 'backupSha256', 'backupSize', 'sourceDatabaseIdentitySha256',
              'sourceApiIdentity', 'candidateImageId', 'inspection', 'legacyAudit', 'sourceSummary',
              'maintenanceSha256', 'restoreVerified', 'temporaryRestoreVolumeRemoved', 'volumeDeletionPerformed'}
    d.require(isinstance(value, dict) and set(value) == fields and fingerprint(value) == digest
              and value['version'] == 1 and type(value['version']) is int
              and value['volume'] == record['workspaceVolumeBefore'] == record['workspaceVolumeAfter']
              and value['candidateImageId'] == proof['images']['api']['imageId']
              and value['backupName'] == 'backups/auto-registration/database.db'
              and type(value['backupSize']) is int and 0 < value['backupSize'] <= 256 * 1024**2
              and value['restoreVerified'] is True and value['temporaryRestoreVolumeRemoved'] is True
              and value['volumeDeletionPerformed'] is False
              and all(isinstance(value[name], str) and re.fullmatch(r'[a-f0-9]{64}', value[name])
                      for name in ('backupSha256', 'sourceDatabaseIdentitySha256', 'maintenanceSha256')),
              'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
    inspection = workspace_safety_result(d, value['inspection'])
    d.require(value['sourceSummary'] == {k: inspection[k] for k in
              ('schemaSha256', 'logicalSha256', 'tableCounts', 'taskCounts')},
              'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
    identity = value['sourceApiIdentity']
    d.require(isinstance(identity, dict) and set(identity) == {'containerId', 'image', 'startedAtSha256'}
              and isinstance(identity['containerId'], str) and re.fullmatch(r'[a-f0-9]{64}', identity['containerId'])
              and identity['image'] == record['before']['api']['image']
              and identity['containerId'] == record['before']['api']['containerId']
              and identity['startedAtSha256'] == record['before']['api']['startedAtSha256'],
              'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
    if value['legacyAudit'] is not None:
        d.require(value['legacyAudit'] == {'legacyMutationCount': 0, 'containerId': identity['containerId'],
                  'startedAtSha256': identity['startedAtSha256']} and inspection['taskCounts']['cancelled'] == 0,
                  'API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
    backup = directory / value['backupName']
    d.require(backup.parent.parent.is_dir() and not backup.parent.parent.is_symlink()
              and stat.S_IMODE(backup.parent.parent.stat().st_mode) == 0o700
              and backup.parent.is_dir() and not backup.parent.is_symlink()
              and stat.S_IMODE(backup.parent.stat().st_mode) == 0o700
              and backup.is_file() and not backup.is_symlink()
              and stat.S_IMODE(backup.stat().st_mode) == 0o600
              and backup.stat().st_size == value['backupSize']
              and hashlib.sha256(backup.read_bytes()).hexdigest() == value['backupSha256'],
              'API_ADMIN_WORKSPACE_SQLITE_BACKUP_CHANGED')
    return {'backupVerified': True, 'restoreVerified': True, 'sqliteProtectionSha256': digest,
            'backupSha256': value['backupSha256'], 'backupSize': value['backupSize']}


def workspace_acceptance(d, reference, run_id, attempt):
    checks = ['private-health', 'packaged-resources', 'private-sqlite', 'encrypted-storage',
              'restart-persistence', 'wrong-key-rejected']
    name = 'id-workspace-acceptance-' + run_id + '-' + attempt
    d.require(re.fullmatch(r'id-workspace-acceptance-[1-9][0-9]*-[1-9][0-9]*', name)
              and not d.run('docker', 'volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'),
              'API_ADMIN_WORKSPACE_ACCEPTANCE_VOLUME_EXISTS')
    d.run('docker', 'volume', 'create', '--label', 'id-business-v2.acceptance=' + run_id + '-' + attempt, name)
    try:
        output = d.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
            '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--mount',
            'type=volume,source=' + name + ',target=' + WORKSPACE_DIRECTORY,
            '--entrypoint', '/opt/id-registration/venv/bin/python', reference, '-B',
            '/app/apps/api/src/id-business-v2/auto-registration/worker/acceptance_runtime.py', timeout=180)
        result = json.loads(output)
        d.require(result == {'status': 'PASS', 'checks': checks, 'businessActions': 0},
                  'API_ADMIN_WORKSPACE_ACCEPTANCE_FAILED')
    finally:
        value = json.loads(d.run('docker', 'volume', 'inspect', name))[0]
        d.require(value.get('Name') == name and value.get('Labels', {}).get('id-business-v2.acceptance') == run_id + '-' + attempt,
                  'API_ADMIN_WORKSPACE_ACCEPTANCE_VOLUME_CHANGED')
        d.run('docker', 'volume', 'rm', name)
    return {**result, 'temporaryVolumeRemoved': True}


def workspace_health(d, directory):
    # The production readiness handler calls this API process's real singleton
    # worker health, including encrypted SQLite and packaged-resource checks.
    output = d.compose(directory, 'exec', '-T', 'api', 'node', '-e',
        "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(10000)})"
        ".then(r=>{if(!r.ok)throw Error();console.log(JSON.stringify({ready:true}))})"
        ".catch(()=>process.exit(1))", timeout=30)
    d.require(output == '{"ready":true}', 'API_ADMIN_WORKSPACE_HEALTH_FAILED')


def migration_files(d, directory):
    root = directory / MIGRATION_ROOT
    paths = list(root.rglob('*'))
    d.require(root.is_dir() and not root.is_symlink() and len(paths) < 200,
              'API_ADMIN_MIGRATION_SOURCE_INVALID')
    rows = {}
    for path in paths:
        d.require(not path.is_symlink(), 'API_ADMIN_MIGRATION_SOURCE_INVALID')
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        d.require(path.is_file() and path.stat().st_size < 8 * 1024**2
                  and (name == 'migration_lock.toml' or re.fullmatch(r'[0-9]{14}_[a-z0-9_]+/migration.sql', name)),
                  'API_ADMIN_MIGRATION_SOURCE_INVALID')
        rows[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return rows


def migration_source_check(d, directory=None, *, candidate=True):
    d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
    directory = Path.cwd() if directory is None else directory
    rows = migration_files(d, directory)
    schema = directory / MIGRATION_SCHEMA
    d.require(schema.is_file() and not schema.is_symlink(), 'API_ADMIN_MIGRATION_SOURCE_INVALID')
    digest = hashlib.sha256(schema.read_bytes()).hexdigest()
    added = rows.pop(MIGRATION_FILE, None)
    d.require(len(rows) == 46 and fingerprint(rows) == MIGRATION_IDENTITY['baselineFilesSha256']
              and ((added == MIGRATION_IDENTITY['sha256'] and digest == MIGRATION_IDENTITY['schemaAfterSha256'])
                   or (not candidate and added is None and digest == MIGRATION_IDENTITY['schemaBeforeSha256'])),
              'API_ADMIN_MIGRATION_SCOPE_CHANGED')
    return dict(MIGRATION_IDENTITY)


def migration_database_state(d, directory):
    workspace_probe_step(d, 'MIGRATION_SCHEMA')
    migration_source_check(d, directory, candidate=False)
    expected = {n.split('/')[0]: digest for n, digest in migration_files(d, directory).items() if n.endswith('/migration.sql')}
    expected[MIGRATION_NAME] = MIGRATION_IDENTITY['sha256']
    query = """SELECT JSON_OBJECT('rows', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'name', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL,
        'rolledBack', rolled_back_at IS NOT NULL)) FROM _prisma_migrations),
        'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('type', DATA_TYPE, 'columnType', COLUMN_TYPE,
        'nullable', IS_NULLABLE, 'default', COLUMN_DEFAULT, 'extra', EXTRA))
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_quick_actions' AND COLUMN_NAME='sort_order'),
        'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('column', COLUMN_NAME, 'sequence', SEQ_IN_INDEX,
        'nonUnique', NON_UNIQUE, 'type', INDEX_TYPE, 'prefix', SUB_PART))
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_quick_actions'
        AND INDEX_NAME='id_business_v2_quick_actions_user_id_deleted_at_sort_order_idx'))"""
    database = d.current_job_database(directory)
    raw = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "' + ' '.join(query.split()) + '"', timeout=60)
    d.require(len(raw) < 65536, 'API_ADMIN_MIGRATION_DATABASE_INVALID')
    value = json.loads(raw)
    d.require(isinstance(value, dict) and set(value) == {'rows', 'columns', 'indexes'}
              and isinstance(value['rows'], list) and len(value['rows']) < 200,
              'API_ADMIN_MIGRATION_DATABASE_INVALID')
    completed = {}
    for row in value['rows']:
        d.require(isinstance(row, dict) and set(row) == {'name', 'checksum', 'finished', 'rolledBack'}
                  and row['name'] in expected and row['checksum'] == expected[row['name']]
                  and all(type(row[n]) in (bool, int) and row[n] in (0, 1) for n in ('finished', 'rolledBack'))
                  and row['finished'] + row['rolledBack'] == 1,
                  'API_ADMIN_MIGRATION_HISTORY_CHANGED')
        if row['finished']:
            d.require(row['name'] not in completed, 'API_ADMIN_MIGRATION_HISTORY_CHANGED')
            completed[row['name']] = row['checksum']
    applied = MIGRATION_NAME in completed
    d.require(set(completed) == set(expected) if applied else set(completed) == set(expected) - {MIGRATION_NAME},
              'API_ADMIN_MIGRATION_HISTORY_CHANGED')
    columns, indexes = value['columns'] or [], value['indexes'] or []
    if applied:
        d.require(columns == [{'type': 'int', 'columnType': 'int', 'nullable': 'YES', 'default': None, 'extra': ''}]
                  and isinstance(indexes, list) and len(indexes) == 3
                  and sorted(indexes, key=lambda row: row.get('sequence', 0)) == [
                      {'column': name, 'sequence': index, 'nonUnique': 1, 'type': 'BTREE', 'prefix': None}
                      for index, name in enumerate(('user_id', 'deleted_at', 'sort_order'), 1)],
                  'API_ADMIN_MIGRATION_SCHEMA_CHANGED')
    else:
        d.require(columns == [] and indexes == [], 'API_ADMIN_MIGRATION_SCHEMA_CHANGED')
    return {'name': MIGRATION_NAME, 'sha256': MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED' if applied else 'PENDING', 'schemaVerified': True,
            'appliedMigrationsSha256': fingerprint(completed)}


def migration_task_guard(d, directory, task, guards):
    d.require(guards.get('registrationWindowRetained') is True
              and jobs_idle(d, directory) == guards and registration_task(d, directory) == task,
              'API_ADMIN_REGISTRATION_TASK_CHANGED')
    workspace_probe_step(d, 'WINDOW_STATE')
    registration_private(d, directory, retained=guards['registrationWindowRetained'])


def migration_successor_marker(context):
    return {'version': 1, 'commit': context['commit'], 'manifestSha256': context['manifestSha256'],
            'buildProofSha256': context['buildProofSha256'], 'preservationSha256': fingerprint(context)}


def migration_successor_origin(d, directory):
    d.require(SCOPE in ('API_ADMIN', 'API_ADMIN_WORKSPACE') and directory.parent == d.BASE / 'releases'
              and not directory.is_symlink(), 'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    raw = (directory / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    d.require(manifest.get('commit') == MIGRATION_SUCCESSOR_COMMIT
              and hashlib.sha256(raw).hexdigest() == MIGRATION_SUCCESSOR_MANIFEST_SHA,
              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    original, _ = d.api_admin_scope('API_ADMIN_MIGRATION')
    receipt = original.readback(d, MIGRATION_SUCCESSOR_COMMIT)
    record = json.loads((directory / original.STATE_FILE).read_text())
    d.require(receipt.get('buildProofSha256') == MIGRATION_SUCCESSOR_PROOF_SHA
              and receipt.get('migration') == MIGRATION_IDENTITY
              and receipt.get('migrationState', {}).get('status') == 'APPLIED'
              and receipt.get('migrationApplied') is True and receipt.get('taskHmacMatched') is True
              and receipt.get('windowPreserved') is True and receipt.get('registrationWindowRetained') is True,
              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    context = {'version': 1, 'release': str(directory), 'commit': MIGRATION_SUCCESSOR_COMMIT,
               'manifestSha256': MIGRATION_SUCCESSOR_MANIFEST_SHA,
               'buildProofSha256': MIGRATION_SUCCESSOR_PROOF_SHA, 'migration': dict(MIGRATION_IDENTITY),
               'migrationState': receipt['migrationState'], 'task': record['registrationTask'],
               'guards': record['registrationGuards']}
    migration_successor_guard(d, directory, context)
    return context


def migration_successor_guard(d, directory, context):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256',
              'migration', 'migrationState', 'task', 'guards'}
    d.require(SCOPE in ('API_ADMIN', 'API_ADMIN_WORKSPACE') and isinstance(context, dict) and set(context) == fields
              and type(context['version']) is int and context['version'] == 1 and context['commit'] == MIGRATION_SUCCESSOR_COMMIT
              and context['manifestSha256'] == MIGRATION_SUCCESSOR_MANIFEST_SHA
              and context['buildProofSha256'] == MIGRATION_SUCCESSOR_PROOF_SHA
              and context['migration'] == MIGRATION_IDENTITY,
              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    source = Path(context['release'])
    d.require(source.parent == d.BASE / 'releases' and source.is_dir() and not source.is_symlink()
              and hashlib.sha256((source / 'release-manifest.json').read_bytes()).hexdigest()
              == MIGRATION_SUCCESSOR_MANIFEST_SHA, 'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    original, _ = d.api_admin_scope('API_ADMIN_MIGRATION')
    source_manifest = json.loads((source / 'release-manifest.json').read_text())
    workspace_probe_step(d, 'ORIGIN_PROOF')
    proof = original.validate_proof(d, json.loads((source / original.PROOF_FILE).read_text()),
                                   MIGRATION_SUCCESSOR_COMMIT, source_manifest['sourceTree'])
    workspace_probe_step(d, 'ORIGIN_RECORD')
    original_record = json.loads((source / original.STATE_FILE).read_text())
    d.require(fingerprint(proof) == MIGRATION_SUCCESSOR_PROOF_SHA
              and context['task'] == original_record['registrationTask'] == original.MIGRATION_TASK
              and context['guards'] == original_record['registrationGuards'],
              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    predecessor = Path(source_manifest['previousRelease'])
    workspace_probe_step(d, 'ORIGIN_CONFIG')
    d.require(predecessor.parent == d.BASE / 'releases' and predecessor.is_dir() and not predecessor.is_symlink()
              and original.configuration_hashes(source) == original_record['configurationAfter']
              and original.configuration_hashes(predecessor) == original_record['configurationBefore']
              and hashlib.sha256((source / '.env.aws.production').read_bytes()).hexdigest()
              == original_record['environmentSha256'], 'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    workspace_probe_step(d, 'ORIGIN_AUDIT')
    d.require(original.audit_receipt(d, source / 'before-audit.json') == source_manifest['dataAuditBefore']
              and original.audit_receipt(d, source / 'after-audit.json') == source_manifest['dataAuditAfter']
              and source_manifest['dataAuditBefore']['checksSha256'] == source_manifest['dataAuditAfter']['checksSha256'],
              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
    workspace_probe_step(d, 'ORIGIN_BACKUP')
    backup = json.loads((source / 'backup-verification.json').read_text())
    d.require(backup.get('name') == source_manifest['backupBeforeRelease'] and backup.get('s3Verified') is True
              and type(backup.get('size')) is int and backup['size'] > 0
              and re.fullmatch(r'[a-f0-9]{64}', backup.get('sha256', '')), 'API_ADMIN_MIGRATION_BACKUP_CHANGED')
    workspace_probe_step(d, 'ORIGIN_SOURCE')
    original.migration_source_check(d, source)
    original.migration_source_check(d, directory)
    workspace_probe_step(d, 'MIGRATION_SCHEMA')
    state = original.migration_database_state(d, directory)
    d.require(state['status'] == 'APPLIED' and state == context['migrationState']
              and all(original_record['migration'][name] == state[name] for name in state),
              'API_ADMIN_MIGRATION_PRESERVATION_CHANGED')
    workspace_probe_step(d, 'MIGRATION_IMAGE', 'migrate')
    original.verify_migration_image(d, directory, proof)
    original.migration_task_guard(d, directory, context['task'], context['guards'])


def migration_preflight(d, expected):
    d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
    directory, manifest, states, evidence = baseline(d, expected)
    task = registration_task(d, directory)
    migration_task_guard(d, directory, task, evidence['guards'])
    audit = strict_audit(d, directory, Path(__file__).parent / (PREFIX + '-preflight-audit.json'))
    d.require(snapshot(d, directory) == states, 'API_ADMIN_REGISTRATION_PREFLIGHT_CHANGED')
    migration_task_guard(d, directory, task, evidence['guards'])
    return {'status': SCOPE + '_BASELINE_VERIFIED', 'commit': expected, 'services': states,
            **evidence, 'task': task, 'audit': audit, 'migration': dict(MIGRATION_IDENTITY),
            'windowPreserved': True, 'requiresWindowHandoff': False}


def apply_migration(d, directory):
    before = migration_database_state(d, directory)
    if before['status'] == 'APPLIED':
        return {**before, 'performed': False}
    try:
        d.compose(directory, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate', timeout=600)
    except Exception:
        raise RuntimeError('API_ADMIN_MIGRATION_EXECUTION_FAILED') from None
    after = migration_database_state(d, directory)
    d.require(after['status'] == 'APPLIED', 'API_ADMIN_MIGRATION_NOT_APPLIED')
    return {**after, 'performed': True}


def migration_content(d, directory):
    rows = {('/app/' + MIGRATION_ROOT + '/' + name): digest for name, digest in migration_files(d, directory).items()}
    rows['/app/' + MIGRATION_SCHEMA] = hashlib.sha256((directory / MIGRATION_SCHEMA).read_bytes()).hexdigest()
    # Docker copies the complete Prisma directory; attest the existing seed without executing it.
    seed = directory / MIGRATION_SEED
    d.require(seed.is_file() and not seed.is_symlink() and seed.stat().st_size < 8 * 1024**2,
              'API_ADMIN_MIGRATION_SOURCE_INVALID')
    digest = hashlib.sha256(seed.read_bytes()).hexdigest()
    d.require(digest == MIGRATION_SEED_SHA, 'API_ADMIN_MIGRATION_SCOPE_CHANGED')
    rows['/app/' + MIGRATION_SEED] = digest
    return content_summary(d, 'migrate', '\n'.join(sorted(digest + '  ' + name for name, digest in rows.items())))


def verify_migration_image(d, directory, proof, *, inspect_content=False):
    workspace_probe_step(d, 'MIGRATION_IMAGE', 'migrate')
    row = proof['images']['migrate']
    override = json.loads((directory / 'compose.release.json').read_text())
    d.require(override['services']['migrate'] == {'image': row['reference'], 'pull_policy': 'never'},
              'API_ADMIN_MIGRATION_IMAGE_CHANGED')
    image = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
    labels = image['Config'].get('Labels', {})
    d.require(image['Id'] == row['imageId'] and image['Architecture'] == 'amd64'
              and labels.get('org.opencontainers.image.revision') == proof['commit']
              and labels.get('id-business-v2.source-tree') == proof['sourceTree'],
              'API_ADMIN_MIGRATION_IMAGE_CHANGED')
    workspace_probe_step(d, 'MIGRATION_CONTENT', 'migrate')
    expected = migration_content(d, directory)
    d.require({k: row[k] for k in ('fileCount', 'sha256')} == expected,
              'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')
    if inspect_content:
        measured = content_summary(d, 'migrate', d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', content_command('migrate')))
        d.require(measured == expected, 'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')


def content_command(service):
    roots = '/app/apps/api/dist /app/packages/shared/dist' if service == 'api' else '/app/apps/api/prisma-mysql' if service == 'migrate' else '/app' if service == 'auto-registration' else '/usr/share/nginx/html'
    if WORKSPACE and service == 'api':
        roots = ' '.join(WORKSPACE_API_ROOTS)
    test = '-e' if WORKSPACE and service == 'api' else '-d'
    return ('set -eu; export LC_ALL=C; for p in ' + roots + '; do test ' + test + ' "$p"; done; '
            'files="$(find ' + roots + ' -type f -exec sha256sum {} +)"; '
            "printf '%s\\n' \"$files\" | sort")


def content_summary(d, service, output):
    lines = output.splitlines()
    prefixes = ('/app/apps/api/dist/', '/app/packages/shared/dist/') if service == 'api' else ('/app/apps/api/prisma-mysql/',) if service == 'migrate' else ('/app/',) if service == 'auto-registration' else ('/usr/share/nginx/html/',)
    if WORKSPACE and service == 'api':
        prefixes = tuple(n if n.endswith(('.css', '.json')) else n + '/' for n in WORKSPACE_API_ROOTS)
    d.require(0 < len(lines) < 30000 and len(output) < 8 * 1024 * 1024
              and all(re.fullmatch(r'[a-f0-9]{64}  /[^\r\n]+', line)
                      and line[66:].startswith(prefixes) for line in lines), 'API_ADMIN_CONTENT_INVALID')
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(lines) + '\n').encode()).hexdigest()}


def build_proof(d):
    commit, tree = os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit
              and d.run('git', 'rev-parse', 'HEAD^{tree}') == tree, 'API_ADMIN_BUILD_SOURCE_CHANGED')
    result = {'version': 1, 'commit': commit, 'sourceTree': tree, 'images': {}}
    if MIGRATION_MODE:
        result.update(scope=SCOPE, migration=migration_source_check(d))
    if WORKSPACE:
        # This exact fixed configuration is bound to the runner's Git tree.
        result.update(scope=SCOPE, configuration=workspace_configuration(d, Path.cwd(), Path.cwd()))
    if REGISTRATION:
        projection = json.loads(Path('.deploy/production-release/api-registration-build-projection.json').read_text())
        validate_worker_projection(d, projection['workerProjection'])
        d.require(projection['workerProjectionSha256'] == fingerprint(projection['workerProjection']),
                  'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
        d.require(all(hashlib.sha256(subprocess.check_output(['git', 'show', commit + ':' + n])).hexdigest()
                      == projection['workerProjection'][n]['sha256'] for n in WORKER_PAIR),
                  'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        sealed = registration_profile(d, Path.cwd())
        context = Path('.deploy/production-release/api-registration-build-context')
        d.require(projection.get('buildInputSourceCommit') == sealed['workerBasisCommit']
                  and projection.get('buildInputSha256') == sealed['buildInputSha256']
                  and all(hashlib.sha256((context / name).read_bytes()).hexdigest() == digest
                          for name, digest in sealed['buildInputSha256'].items()),
                  'API_ADMIN_REGISTRATION_BUILD_INPUT_CHANGED')
        result.update(scope=SCOPE, workerProjection=projection['workerProjection'],
                      workerProjectionSha256=projection['workerProjectionSha256'])
    for service in IMAGE_SERVICES:
        reference = (os.environ['RELEASE_REPOSITORY'] + ':' + commit + '-'
                     + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + image_service(service))
        metadata = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        labels = metadata['Config'].get('Labels', {})
        d.require(metadata['Architecture'] == 'amd64'
                  and labels.get('org.opencontainers.image.revision') == commit
                  and labels.get('id-business-v2.source-tree') == tree, 'API_ADMIN_BUILD_LABEL_CHANGED')
        content = content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', reference, '-c', content_command(service)))
        if service == 'migrate':
            d.require(content == migration_content(d, Path.cwd()), 'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')
        if service == 'auto-registration':
            d.require(labels.get('id-business-v2.worker-projection-sha256') == result['workerProjectionSha256'],
                      'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
            expected = worker_content(result['workerProjection'])
            d.require(content == expected, 'API_ADMIN_REGISTRATION_CONTENT_CHANGED')
        result['images'][service] = {'reference': reference, 'imageId': metadata['Id'], **content}
    if WORKSPACE:
        result['acceptance'] = workspace_acceptance(d, result['images']['api']['reference'],
                                                    os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    target = Path('.deploy/production-release') / PROOF_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': SCOPE + '_BUILD_PROVEN', 'proofSha256': fingerprint(result)}))


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    fields = {'version', 'commit', 'sourceTree', 'images'} | ({'scope', 'workerProjection', 'workerProjectionSha256'} if REGISTRATION else {'scope', 'migration'} if MIGRATION_MODE else {'scope', 'configuration', 'acceptance'} if WORKSPACE else set())
    d.require(isinstance(value, dict) and set(value) == fields
              and value['version'] == 1 and value['commit'] == commit and value['sourceTree'] == tree
              and set(value['images']) == set(IMAGE_SERVICES), 'API_ADMIN_BUILD_PROOF_INVALID')
    if MIGRATION_MODE:
        d.require(value['scope'] == SCOPE and value['migration'] == MIGRATION_IDENTITY,
                  'API_ADMIN_MIGRATION_BUILD_PROOF_CHANGED')
    if WORKSPACE:
        config = value['configuration']
        d.require(value['scope'] == SCOPE and isinstance(config, dict)
                  and set(config) == {'composeSha256', 'caddySha256', 'volume', 'containerDirectory'}
                  and re.fullmatch(r'[a-f0-9]{64}', config['composeSha256'])
                  and config['caddySha256'] == WORKSPACE_CADDY_AFTER
                  and config['volume'] == WORKSPACE_VOLUME and config['containerDirectory'] == WORKSPACE_DIRECTORY
                  and value['acceptance'] == {'status': 'PASS', 'checks': ['private-health', 'packaged-resources',
                      'private-sqlite', 'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
                      'businessActions': 0, 'temporaryVolumeRemoved': True},
                  'API_ADMIN_WORKSPACE_BUILD_PROOF_CHANGED')
    for service, row in value['images'].items():
        d.require(set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
                  and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'])
                  and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
                  and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000
                  and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                                   + commit + r'-[1-9][0-9]*-[1-9][0-9]*-' + image_service(service), row['reference']),
                  'API_ADMIN_BUILD_IMAGE_INVALID')
        if repository is not None:
            d.require(row['reference'] == f'{repository}:{commit}-{run_id}-{attempt}-{image_service(service)}',
                      'API_ADMIN_BUILD_RUN_CHANGED')
    if REGISTRATION:
        validate_worker_projection(d, value['workerProjection'])
        d.require(value['scope'] == SCOPE and value['workerProjectionSha256'] == fingerprint(value['workerProjection'])
                  and {k: value['images']['auto-registration'][k] for k in ('fileCount', 'sha256')}
                  == worker_content(value['workerProjection']), 'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
    return value


def validate_worker_projection(d, rows):
    root = Path(__file__).resolve().parents[2]
    if not (root / REGISTRATION_PROFILE).exists():
        root = Path(REGISTRATION_DIRECTORY)
    profile = registration_profile(d, root)
    old = profile['workerProjection']
    d.require(isinstance(rows, dict) and set(rows) == set(old) and len(rows) == 60
              and all(isinstance(r, dict) and set(r) == {'mode', 'sha256'} and r['mode'] == old[n]['mode']
                      and re.fullmatch(r'[a-f0-9]{64}', r['sha256']) for n, r in rows.items())
              and {n for n in rows if rows[n] != old[n]} == WORKER_PAIR, 'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')


def worker_content(rows):
    lines = sorted(row['sha256'] + '  /app/' + name[len(WORKER_PREFIX):] for name, row in rows.items())
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(lines) + '\n').encode()).hexdigest()}


def snapshot(d, directory):
    d.require(set(d.production_services(directory)) == set(d.ALL_SERVICES), 'API_ADMIN_SPLIT_WORKERS_REQUIRED')
    states = {}
    for service in workspace_service_names(d, directory):
        row = d.service_state(directory, service, include_container_id=True, include_environment_hash=True)
        metadata = json.loads(d.run('docker', 'inspect', row['containerId']))[0]
        d.require(metadata['Id'] == row['containerId'] and metadata['Image'] == row['image'],
                  'API_ADMIN_CONTAINER_CHANGED')
        mounts = metadata.get('Mounts')
        d.require(isinstance(mounts, list) and all(isinstance(mount, dict)
                  and isinstance(mount.get('Destination'), str) and mount['Destination'].startswith('/')
                  for mount in mounts) and len({mount['Destination'] for mount in mounts}) == len(mounts),
                  'API_ADMIN_CONTAINER_MOUNTS_INVALID')
        # Docker can emit this destination-keyed collection in map iteration order.
        # Preserve every mount field; only collection order is non-semantic.
        configuration = {key: metadata.get(key) for key in ('Config', 'HostConfig')}
        configuration['Mounts'] = sorted(mounts, key=lambda mount: mount['Destination'])
        row['configurationSha256'] = fingerprint(configuration)
        states[service] = row
    d.require(all(row['status'] == 'running' for row in states.values())
              and all(row['health'] == 'healthy' for name, row in states.items() if name != 'caddy'),
              'API_ADMIN_SERVICE_UNHEALTHY')
    if ONLINE_SERVICE in states:
        binding = online_binding(d, directory, states)
        states[ONLINE_SERVICE]['configurationSha256'] = binding['configurationSha256']
    return states


def jobs_idle(d, directory, *, allow_retained=False, database_identity=None):
    workspace_probe_step(d, 'JOBS_IDLE')
    if database_identity is None:
        d.assert_no_active_recharge(directory)
        database = d.current_job_database(directory)
    else:
        database = workspace_database_identity(d, directory, database_identity)['database']
        # Same lease predicate as the running-API path, without launching a stopped API.
        count = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
            'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
            '"$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM id_business_v2_recharge_jobs '
            'WHERE state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)"')
        d.require(count == '0', 'API_ADMIN_RECHARGE_LEASE_ACTIVE')
    runtime = d.registration_runtime_state(directory)
    d.require(runtime.get('supported') is True and runtime.get('registrationBusy') is False
              and type(runtime.get('registrationWindowRetained')) is bool, 'API_ADMIN_REGISTRATION_BUSY')
    count = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM id_business_v2_registration_jobs '
        'WHERE state IN (0x72756e6e696e67, 0x6177616974696e675f656d61696c, '
        '0x6177616974696e675f75736572) AND lease_until > UTC_TIMESTAMP(6)"')
    d.require(count == '0', 'API_ADMIN_REGISTRATION_LEASE_ACTIVE')
    result = {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
              'registrationWindowRetained': runtime['registrationWindowRetained']}
    if REGISTRATION and not allow_retained and runtime['registrationWindowRetained']:
        path = handoff_directory(d) / 'confirmed.json'
        d.require(path.exists(), 'API_ADMIN_REGISTRATION_WINDOW_RETAINED')
        record = handoff_json(d, handoff_directory(d), 'confirmed.json')
        d.require(record.get('version') == 2, 'API_ADMIN_REGISTRATION_WINDOW_RETAINED')
        require_native_handoff(d, directory, record)
        result['registrationResourceClosed'] = True
    return result


TASK_SOURCE = r'''const {PrismaClient}=require('@prisma/client'),c=require('node:crypto');
const p=new PrismaClient({log:[]}),id=__TASK__,attempt=__ATTEMPT__,binding=__BINDING__;
const migration=__MIGRATION__,observed=__OBSERVED__;
const need=x=>{if(!x)throw Error();},bit=x=>x===true||x===1||x===1n;
const sha=x=>c.createHash('sha256').update(x||'').digest('hex');
const canon=x=>typeof x==='bigint'?x.toString():x instanceof Date?x.toISOString():Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const key=process.env.AUTO_RECHARGE_WORKER_TOKEN;
const mac=x=>c.createHmac('sha256',key).update('api-registration-handoff:').update(JSON.stringify(canon(x))).digest('hex');
async function read(tx){
 const rows=await tx.$queryRaw`SELECT * FROM id_business_v2_registration_jobs WHERE id=${id}`;
 need(rows.length===1);const j=rows[0];
 need(j.id===id&&j.attempt===attempt&&j.state==='partial'&&j.step==='password'&&j.reason===(migration?observed.reason:'session_network_error')
  &&bit(j.registered)&&!bit(j.password_verified)&&!bit(j.mfa_verified)&&j.nonce_hash===null&&j.lease_until===null
  &&j.updated_at.toISOString()===(migration?observed.updatedAt:'2026-10-08T02:15:59.029Z')&&typeof j.password_encrypted==='string'&&j.password_encrypted.length>0
  &&sha(j.account_id)===binding.accountSha256&&sha(j.browser_profile_id)===binding.profileSha256&&sha(j.owner_id)===binding.ownerSha256);
 const accounts=await tx.$queryRaw`SELECT * FROM id_business_v2_chatgpt_accounts WHERE email_hash=${j.email_hash} ORDER BY id`;
 need(accounts.length===1&&accounts[0].id===j.account_id&&bit(accounts[0].registered)&&accounts[0].deleted_at===null
  &&accounts[0].password_encrypted===null&&accounts[0].totp_secret_encrypted===null);
 const audits=await tx.auditLog.findMany({where:{module:'id_business_v2',objectType:'registration_job',objectId:id,
  action:{in:['id_business_v2.auto_registration.launch','id_business_v2.auto_registration.profile_rebound','id_business_v2.auto_registration.cancel']},
  createdAt:{gte:new Date('2026-10-08T02:14:14.768Z')}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001});
 need(audits.length<1001);
 if(migration)need(audits.length===observed.auditCount);
 else{
 const launch=audits.filter(x=>x.action.endsWith('.launch')),rebound=audits.filter(x=>x.action.endsWith('.profile_rebound'));
 need(launch.length===1&&launch[0].afterData?.attempt===attempt&&launch[0].createdAt.toISOString()==='2026-10-08T02:14:16.979Z'
  &&rebound.length===1&&rebound[0].afterData?.attempt===attempt&&sha(rebound[0].afterData.browserProfileId)===binding.profileSha256
  &&sha(rebound[0].afterData.accountId)===binding.accountSha256&&rebound[0].createdAt.toISOString()==='2026-10-08T02:14:39.680Z');
 }
 const value={taskId:id,attempt,registered:true,passwordVerified:false,mfaVerified:false,leaseActive:false,noncePresent:false,
  passwordCandidatePresent:true,binding,emailHashHmac:mac('email:'+j.email_hash),jobHmac:mac(rows),accountHmac:mac(accounts),auditHmac:mac(audits)};
 return migration?{...value,state:j.state,step:j.step,reason:j.reason,updatedAt:j.updated_at.toISOString(),auditCount:audits.length}:value;
}
(async()=>{need(typeof key==='string'&&key.length>=32);const value=await p.$transaction(async tx=>{
 const a=await read(tx),b=await read(tx);need(JSON.stringify(a)===JSON.stringify(b));return b;
},{isolationLevel:'RepeatableRead',timeout:25000});console.log(JSON.stringify(value));})()
.catch(()=>{console.log('{"diagnosticError":"API_ADMIN_REGISTRATION_TASK_UNAVAILABLE"}');})
.finally(async()=>{try{await p.$disconnect();}catch{process.exitCode=1;}});'''


PRIVATE_SOURCE = r'''import json,os
from urllib.error import HTTPError
from urllib.request import Request,build_opener,HTTPRedirectHandler
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def pairs(rows):
 value={}
 for k,v in rows:
  if k in value:raise ValueError()
  value[k]=v
 return value
phase='status';attempted=False;http_status=None;reason='none'
def read(path,body=None,status=200):
 global attempted,http_status,reason
 if body is not None:attempted=True
 request=Request('http://127.0.0.1:8051'+path,headers={'X-Recharge-Worker':token,'Content-Type':'application/json'},
  data=body,method='GET' if body is None else 'POST')
 try:
  with opener.open(request,timeout=10) as response:
   if body is not None:http_status=response.status
   if response.status!=status:raise ValueError()
   raw=response.read(4097)
 except HTTPError as error:
  if body is not None:
   http_status=error.code
   try:
    raw=error.read(4097);assert len(raw)<=4096
    value=json.loads(raw,object_pairs_hook=pairs)
    if error.code==409 and type(value)is dict and set(value)=={'ok','reason'} and value['ok']is False and value['reason']in{
     'worker_busy','builtin_original_window_pending','builtin_profile_missing','invalid_registration_payload','fingerprint_cleanup_failed'}:reason=value['reason']
   except BaseException:pass
  raise ValueError()from None
 if not 0<len(raw)<=4096:raise ValueError()
 return json.loads(raw,object_pairs_hook=pairs)
def status_ok(value,cancelled):
 return type(value)is dict and set(value)=={'accepted','attempt','cancelled','done'} and value['accepted']is True and type(value['attempt'])is int and value['attempt']==__ATTEMPT__ and value['done']is True and value['cancelled']is cancelled
def health_ok(value,retained):
 return type(value)is dict and set(value)=={'ready','workerRole','engine','mailDeliveryVersion','registrationBusy','registrationWindowRetained'} and value['ready']is True and value['workerRole']=='registration' and value['engine']=='camoufox' and type(value['mailDeliveryVersion'])is int and value['mailDeliveryVersion']==1 and value['registrationBusy']is False and value['registrationWindowRetained']is retained
try:
 token=os.environ['AUTO_RECHARGE_WORKER_TOKEN'];assert len(token)>=32;opener=build_opener(NoRedirect)
 path='/registration/jobs/__TASK__'
 first=read(path+'/status');assert status_ok(first,__CANCELLED__)
 phase='health';h=read('/registration/health');assert health_ok(h,__RETAINED__)
 if __CLOSE__:
  phase='close';ack=read(path+'/cancel',b'{"attempt":__ATTEMPT__}',202);assert type(ack)is dict and set(ack)=={'ok'} and ack['ok']is True
  phase='after_status';assert status_ok(read(path+'/status'),True)
  phase='after_health';assert health_ok(read('/registration/health'),False)
 print(json.dumps({'confirmed':True,'privatePostAttempted':attempted,'cancelled':True if __CLOSE__ else __CANCELLED__,
  'retained':False if __CLOSE__ else __RETAINED__,'busy':False,'attempt':__ATTEMPT__}))
except BaseException:
 print(json.dumps({'confirmed':False,'privatePostAttempted':attempted,'failurePhase':phase,
  'privatePostHttpStatus':http_status,'controlledReason':reason,'rawOutputSuppressed':True}))
'''


def registration_task(d, directory):
    workspace_probe_step(d, 'TASK_IDENTITY')
    code = TASK_SOURCE.replace('__TASK__', json.dumps(TASK_ID)).replace('__ATTEMPT__', str(TASK_ATTEMPT)).replace('__BINDING__', json.dumps(TASK_BINDING))
    code = code.replace('__MIGRATION__', json.dumps(MIGRATION_MODE)).replace('__OBSERVED__', json.dumps(MIGRATION_TASK if MIGRATION_MODE else None))
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    fields = {'taskId', 'attempt', 'registered', 'passwordVerified', 'mfaVerified', 'leaseActive',
              'noncePresent', 'passwordCandidatePresent', 'binding', 'emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'}
    if MIGRATION_MODE:
        fields = set(MIGRATION_TASK)
    d.require(isinstance(value, dict) and set(value) == fields and value['taskId'] == TASK_ID
              and type(value['attempt']) is int and value['attempt'] == TASK_ATTEMPT and value['binding'] == TASK_BINDING
              and all(value[n] is True for n in ('registered', 'passwordCandidatePresent'))
              and all(value[n] is False for n in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
              and all(re.fullmatch(r'[a-f0-9]{64}', value[n]) for n in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac')),
              'API_ADMIN_REGISTRATION_TASK_UNAVAILABLE')
    if MIGRATION_MODE:
        d.require(value == MIGRATION_TASK and type(value['auditCount']) is int,
                  'API_ADMIN_REGISTRATION_TASK_CHANGED')
    return value


def registration_private(d, directory, *, close=False, retained=True):
    workspace_probe_step(d, 'WINDOW_STATE')
    d.require(not MIGRATION_MODE or (close is False and retained is True), 'API_ADMIN_SCOPE_CONFLICT')
    code = PRIVATE_SOURCE.replace('__TASK__', TASK_ID).replace('__ATTEMPT__', str(TASK_ATTEMPT))
    code = code.replace('__CANCELLED__', repr(not retained)).replace('__RETAINED__', repr(retained)).replace('__CLOSE__', repr(close))
    value = json.loads(d.compose(directory, 'exec', '-T', 'auto-registration', 'python', '-B', '-c', code, timeout=45))
    if value.get('confirmed') is not True:
        # Fixed, bounded diagnostics retain the first failure; no second POST.
        allowed = {'confirmed', 'privatePostAttempted', 'failurePhase', 'privatePostHttpStatus', 'controlledReason', 'rawOutputSuppressed'}
        d.require(set(value) == allowed and value['confirmed'] is False and value['rawOutputSuppressed'] is True
                  and type(value['privatePostAttempted']) is bool
                  and value['failurePhase'] in ('status', 'health', 'close', 'after_status', 'after_health')
                  and value['controlledReason'] in ('none', 'worker_busy', 'builtin_original_window_pending',
                      'builtin_profile_missing', 'invalid_registration_payload', 'fingerprint_cleanup_failed')
                  and (value['privatePostHttpStatus'] is None or type(value['privatePostHttpStatus']) is int
                       and 100 <= value['privatePostHttpStatus'] <= 599), 'API_ADMIN_REGISTRATION_PRIVATE_UNAVAILABLE')
        raise RegistrationHandoffError(value)
    d.require(set(value) == {'confirmed', 'privatePostAttempted', 'cancelled', 'retained', 'busy', 'attempt'}
              and value['privatePostAttempted'] is close and value['busy'] is False
              and type(value['attempt']) is int and value['attempt'] == TASK_ATTEMPT
              and value['retained'] is (False if close else retained)
              and value['cancelled'] is (True if close else not retained), 'API_ADMIN_REGISTRATION_PRIVATE_UNAVAILABLE')
    return value


class RegistrationHandoffError(RuntimeError):
    def __init__(self, diagnostic):
        super().__init__('API_ADMIN_REGISTRATION_PRIVATE_UNCONFIRMED')
        self.diagnostic = diagnostic


NATIVE_HANDOFF_SOURCE = r'''import ast,hashlib,json,os,select,signal,stat,sys,time
from pathlib import Path
recover=__RECOVER__;expected_module=__MODULE_SHA__
proc=Path('/proc');engine=Path('/opt/camoufox');module=Path('/app/fingerprint_runtime.py')
result={'status':'FAILED','nativeCount':0,'nativeCountObserved':False,'signalsAttempted':0,
 'zeroObservations':0,'resourceClosed':False,'readOnly':not recover,'code':'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE'}
def need(value,code):
 if not value:raise RuntimeError('API_ADMIN_REGISTRATION_NATIVE_'+code)
def process(pid):
 raw=(proc/str(pid)/'stat').read_text();parts=raw.rsplit(')',1)[1].split()
 need(len(parts)>19 and parts[19].isdigit(),'PROC_READ');return (int(parts[19]),parts[0])
def inactive(pid,observed):
 path=proc/str(pid)
 need(observed[1] in ('Z','X') and os.readlink(path/'ns/pid')==namespace,'PROC_READ')
 need(hasattr(os,'pidfd_open') and hasattr(select,'poll'),'SIGNAL_UNAVAILABLE')
 fd=os.pidfd_open(pid,0)
 try:
  need(process(pid)==observed,'PID_REUSED')
  poll=select.poll();poll.register(fd,select.POLLIN)
  events=[flags for n,flags in poll.poll(0) if n==fd]
  need(len(events)==1 and events[0]&select.POLLIN and not events[0]&(select.POLLERR|select.POLLNVAL),'PROC_READ')
  need(process(pid)==observed,'PID_REUSED')
  need(os.readlink(path/'ns/pid')==namespace,'PID_NAMESPACE');return True
 finally:os.close(fd)
def row(pid):
 path=proc/str(pid)
 try:
  observed=process(pid)
  if observed[1] in ('Z','X'):
   inactive(pid,observed);return None
  first=observed[0];exe=os.readlink(path/'exe')
 except (FileNotFoundError,ProcessLookupError):
  need(not path.exists(),'PROC_READ');return None
 need(not exe.endswith(' (deleted)'),'DELETED_EXECUTABLE')
 need(exe!='/run/rosetta/rosetta','EXECUTION_EMULATED')
 if not exe.startswith(str(engine)+'/'):return None
 actual=Path(exe).resolve(strict=True)
 need(actual==kernel and actual.is_file() and (actual.stat().st_dev,actual.stat().st_ino)==kernel_identity,'EXECUTABLE_CHANGED')
 need(os.readlink(path/'ns/pid')==namespace,'PID_NAMESPACE')
 need(process(pid)[0]==first,'PID_REUSED')
 return (pid,first,exe)
def inventory():
 names=[p for p in proc.iterdir() if p.name.isdigit()]
 need(len(names)<=2048,'PROC_BOUND');rows=[]
 for path in names:
  try:value=row(int(path.name))
  except (FileNotFoundError,ProcessLookupError):
   need(not path.exists(),'PROC_READ');continue
  if value is not None:rows.append(value)
 need(len(rows)<=128,'PROC_BOUND');return sorted(rows)
fds=[]
try:
 need(os.geteuid()==10001 and os.getegid()==10001,'OWNER_CHANGED')
 need(Path(os.readlink(proc/'self/exe')).resolve(strict=True)==Path(sys.executable).resolve(strict=True),'EXECUTION_EMULATED')
 raw=module.read_bytes();need(hashlib.sha256(raw).hexdigest()==expected_module,'MODULE_CHANGED')
 tree=ast.parse(raw);paths=[n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ENGINE_PATH' for t in n.targets)]
 need(len(paths)==1 and isinstance(paths[0],ast.Call) and isinstance(paths[0].func,ast.Name) and paths[0].func.id=='Path'
  and len(paths[0].args)==1 and isinstance(paths[0].args[0],ast.Constant) and paths[0].args[0].value=='/opt/camoufox/camoufox','MODULE_CHANGED')
 need(engine.resolve(strict=True)==engine and engine.is_dir() and engine.stat().st_uid==0,'ENGINE_CHANGED')
 kernel=(engine/'camoufox').resolve(strict=True);need(kernel.parent==engine and kernel.is_file() and kernel.stat().st_uid==0,'ENGINE_CHANGED')
 kernel_identity=(kernel.stat().st_dev,kernel.stat().st_ino);namespace=os.readlink(proc/'self/ns/pid');need(namespace.startswith('pid:['),'PID_NAMESPACE')
 deadline=time.monotonic()+10;rows=inventory();result.update(nativeCount=len(rows),nativeCountObserved=True)
 if recover:
  need(all(pid>1 and pid!=os.getpid() for pid,_,_ in rows),'PID_OWNER')
  need(not rows or hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'SIGNAL_UNAVAILABLE')
  for owned in rows:
   pid=owned[0]
   try:fd=os.pidfd_open(pid,0)
   except ProcessLookupError:
    need(not (proc/str(pid)).exists(),'PID_REUSED');continue
   fds.append((fd,owned));current=row(pid);need(current is None or current==owned,'PID_REUSED')
  for fd,owned in fds:
   need(time.monotonic()<deadline,'BUDGET_EXHAUSTED');current=row(owned[0])
   need(current is None or current==owned,'PID_REUSED')
   if current is None:continue
   result['signalsAttempted']+=1
   try:signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)
   except ProcessLookupError:pass
  zero=0
  while time.monotonic()<deadline:
   remaining=inventory();alive=False
   for pid,original,_ in rows:
    try:
     observed=process(pid);need(observed[0]==original,'PID_REUSED')
     if observed[1] in ('Z','X'):inactive(pid,observed)
     else:alive=True
    except (FileNotFoundError,ProcessLookupError):need(not (proc/str(pid)).exists(),'PROC_READ')
   result['nativeCount']=len(remaining)
   zero=zero+1 if not remaining and not alive else 0;result['zeroObservations']=zero
   if zero==2:break
   time.sleep(.1)
  need(result['zeroObservations']==2,'REMAINS')
  result.update(status='RECOVERED',resourceClosed=True,code='none')
 else:
  time.sleep(.1);need(inventory()==rows,'OBSERVATION_CHANGED')
  result.update(status='OBSERVED',zeroObservations=2 if not rows else 0,resourceClosed=not rows,code='none')
except Exception as error:
 code=str(error);allowed={'OWNER_CHANGED','PROC_READ','DELETED_EXECUTABLE','EXECUTABLE_CHANGED','PID_NAMESPACE',
  'PID_REUSED','PROC_BOUND','MODULE_CHANGED','ENGINE_CHANGED','PID_OWNER','SIGNAL_UNAVAILABLE','BUDGET_EXHAUSTED','REMAINS','OBSERVATION_CHANGED','EXECUTION_EMULATED'}
 if code in {'API_ADMIN_REGISTRATION_NATIVE_'+n for n in allowed}:result['code']=code
finally:
 for fd,_ in fds:
  try:os.close(fd)
  except OSError:pass
print(json.dumps(result,separators=(',',':')))
'''


class RegistrationRecoveryError(RuntimeError):
    def __init__(self, code, diagnostic):
        super().__init__(code)
        self.diagnostic = diagnostic


def handoff_json(d, folder, name):
    d.require(folder.resolve() == folder and stat.S_ISDIR(folder.lstat().st_mode)
              and stat.S_IMODE(folder.lstat().st_mode) == 0o700 and folder.lstat().st_uid == 0,
              'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    path = folder / name
    d.require(path.lstat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    raw = d.fixed_recharge_bytes(path, modes=(0o400,), limit=16384)
    d.require(path.lstat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    return d.fixed_recharge_json(raw)


def handoff_failed_attempt(d, *, require_unconfirmed=True):
    folder = handoff_directory(d)
    attempt = handoff_json(d, folder, 'attempt.json')
    failure = handoff_json(d, folder, 'failure.json')
    d.require(fingerprint(attempt) == fingerprint({'taskId': TASK_ID, 'attempt': TASK_ATTEMPT, 'privatePostBudget': 1})
              and fingerprint(failure) == fingerprint(HANDOFF_FAILURE), 'API_ADMIN_REGISTRATION_RECOVERY_FAILURE_CHANGED')
    if require_unconfirmed:
        d.require(not (folder / 'confirmed.json').exists() and not (folder / 'confirmed.json').is_symlink(),
                  'API_ADMIN_REGISTRATION_RECOVERY_ALREADY_CONFIRMED')
    return folder


def native_handoff(d, directory, container_id, *, recover=False):
    d.require(re.fullmatch(r'[a-f0-9]{64}', container_id), 'API_ADMIN_REGISTRATION_NATIVE_CONTAINER_CHANGED')
    module_sha = registration_profile(d, Path(REGISTRATION_DIRECTORY))['workerProjection'][WORKER_PREFIX + 'fingerprint_runtime.py']['sha256']
    source = NATIVE_HANDOFF_SOURCE.replace('__RECOVER__', repr(recover)).replace('__MODULE_SHA__', repr(module_sha))
    try:
        value = json.loads(d.run('docker', 'exec', '--user', '10001:10001', '-i', container_id, 'python', '-B', '-c', source, timeout=20))
    except Exception:
        raise RegistrationRecoveryError('API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE', {
            'confirmed': False, 'signalsAttempted': None if recover else 0, 'nativeCount': 0,
            'nativeCountObserved': False, 'rawOutputSuppressed': True}) from None
    fields = {'status', 'nativeCount', 'nativeCountObserved', 'signalsAttempted', 'zeroObservations',
              'resourceClosed', 'readOnly', 'code'}
    d.require(isinstance(value, dict) and set(value) == fields
              and all(type(value[n]) is int and 0 <= value[n] <= 128 for n in ('nativeCount', 'signalsAttempted'))
              and type(value['zeroObservations']) is int and 0 <= value['zeroObservations'] <= 2
              and all(type(value[n]) is bool for n in ('nativeCountObserved', 'resourceClosed', 'readOnly'))
              and value['readOnly'] is (not recover) and value['status'] in ('OBSERVED', 'RECOVERED', 'FAILED')
              and isinstance(value['code'], str), 'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
    if value['status'] == 'FAILED':
        allowed = {'OWNER_CHANGED', 'PROC_READ', 'DELETED_EXECUTABLE', 'EXECUTABLE_CHANGED', 'PID_NAMESPACE',
                   'PID_REUSED', 'PROC_BOUND', 'MODULE_CHANGED', 'ENGINE_CHANGED', 'PID_OWNER', 'SIGNAL_UNAVAILABLE',
                   'BUDGET_EXHAUSTED', 'REMAINS', 'OBSERVATION_CHANGED', 'EXECUTION_EMULATED', 'UNAVAILABLE'}
        d.require(value['code'] in {'API_ADMIN_REGISTRATION_NATIVE_' + name for name in allowed},
                  'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
        raise RegistrationRecoveryError(value['code'], {'confirmed': False, 'signalsAttempted': value['signalsAttempted'],
            'nativeCount': value['nativeCount'], 'nativeCountObserved': value['nativeCountObserved'], 'rawOutputSuppressed': True})
    d.require(value['status'] == ('RECOVERED' if recover else 'OBSERVED') and value['code'] == 'none'
              and value['nativeCountObserved'] is True and value['resourceClosed'] is (value['nativeCount'] == 0)
              and (recover and value['resourceClosed'] is True and value['zeroObservations'] == 2
                   or not recover and value['signalsAttempted'] == 0
                   and value['zeroObservations'] == (2 if value['resourceClosed'] else 0)),
              'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
    return value


BUSINESS_SOURCE = r'''const {PrismaClient}=require('@prisma/client'),c=require('node:crypto');
const p=new PrismaClient({log:[]}),id=__TASK__,binding=__BINDING__,emailMac=__EMAIL_MAC__;
const need=x=>{if(!x)throw Error();},bit=x=>x===true||x===1||x===1n,sha=x=>c.createHash('sha256').update(x||'').digest('hex');
const key=process.env.AUTO_RECHARGE_WORKER_TOKEN;
const mac=x=>c.createHmac('sha256',key).update('api-registration-handoff:').update(JSON.stringify(x)).digest('hex');
const states=['queued','running','awaiting_email','awaiting_user','partial','completed','cancelled'];
const steps=['queued','email','email_code','profile','registered','password','password_verified','mfa','mfa_verified','offer','completed'];
const reasons=new Set(['session_load_timeout','session_network_error','browser_operation_failed','operation_cancelled','verification_required',
 'http_error','form_unrecognized','official_login_email_mismatch','official_login_not_verified','registration_authorization_expired',
 'mailbox_timeout','password_unverified','mfa_unverified','unsupported_login_provider','login_form_ambiguous','window_missing','mail_value_invalid']);
async function read(tx){
 const jobs=await tx.$queryRaw`SELECT id,owner_id,email_hash,account_id,browser_profile_id,state,step,reason,attempt,registered,password_verified,mfa_verified,lease_until,updated_at FROM id_business_v2_registration_jobs WHERE id=${id}`;
 need(jobs.length===1);const j=jobs[0];need(j.id===id&&Number.isInteger(j.attempt)&&j.attempt>=10&&j.attempt<=2147483647
  &&states.includes(j.state)&&steps.includes(j.step)&&sha(j.account_id)===binding.accountSha256&&sha(j.owner_id)===binding.ownerSha256
  &&mac('email:'+j.email_hash)===emailMac);
 const accounts=await tx.$queryRaw`SELECT id,email_hash,registered,password_encrypted IS NOT NULL AS password_present,totp_secret_encrypted IS NOT NULL AS mfa_present,deleted_at FROM id_business_v2_chatgpt_accounts WHERE email_hash=${j.email_hash} ORDER BY id`;
 need(accounts.length===1&&accounts[0].id===j.account_id&&accounts[0].email_hash===j.email_hash&&accounts[0].deleted_at===null);
 const where=action=>({module:'id_business_v2',action:'id_business_v2.auto_registration.'+action,objectType:'registration_job',objectId:id});
 const launches=await tx.auditLog.findMany({where:where('launch'),orderBy:[{createdAt:'desc'},{id:'desc'}],take:1001,select:{userId:true,createdAt:true,afterData:true}});
 need(launches.length<1001);const launch=launches.find(x=>x.afterData?.attempt===j.attempt);
 need(launch&&launch.userId===j.owner_id&&launch===launches[0]);
 const since=launch.createdAt;
 const events=await tx.auditLog.findMany({where:{...where('progress'),createdAt:{gte:since}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001,select:{userId:true,createdAt:true,afterData:true}});
 const rebound=await tx.auditLog.findMany({where:{...where('profile_rebound'),createdAt:{gte:since}},take:1001,select:{userId:true,createdAt:true,afterData:true}});
 need(rebound.length<1001&&events.every(x=>x.userId===j.owner_id));
 const matches=rebound.filter(x=>x.userId===j.owner_id&&x.afterData?.attempt===j.attempt&&sha(x.afterData.accountId)===binding.accountSha256&&x.afterData.browserProfileId===j.browser_profile_id);
 need(matches.length<=1);const bound=matches.length===1;
 const codes=await tx.auditLog.findMany({where:{...where('code_read'),createdAt:{gte:since}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001,select:{afterData:true}});
 const valid=events.length<=1000&&bound;
 const first=predicate=>valid?events.find(x=>predicate(x.afterData))?.createdAt?.toISOString()||null:null;
 const passwordAt=first(x=>x?.passwordVerified===true&&x.step==='password_verified');
 const mfaAt=first(x=>x?.mfaVerified===true&&x.step==='mfa_verified');
 // Both independent login verifiers check the same official email identity.
 // An inherited registered flag or email-only checkpoint cannot supply this.
 const officialAt=passwordAt||mfaAt;
 return {taskId:id,attempt:j.attempt,state:j.state,step:j.step,reason:j.reason===null?'none':reasons.has(j.reason)?j.reason:'other',
  registered:bit(j.registered),passwordVerified:bit(j.password_verified),mfaVerified:bit(j.mfa_verified),
  accountRegistered:bit(accounts[0].registered),encryptedPasswordPresent:bit(accounts[0].password_present),encryptedMfaPresent:bit(accounts[0].mfa_present),
  leaseActive:j.lease_until!==null&&j.lease_until>new Date(),profileBindingConfirmed:bound,launchAt:since.toISOString(),updatedAt:j.updated_at.toISOString(),
  progressCount:Math.min(events.length,1000),progressTruncated:events.length>1000,codeReadCount:Math.min(codes.length,1000),codeReadTruncated:codes.length>1000,
  officialThisAttempt:officialAt!==null,passwordThisAttempt:passwordAt!==null,mfaThisAttempt:mfaAt!==null,officialAt,passwordAt,mfaAt};
}
(async()=>{need(typeof key==='string'&&key.length>=32);const value=await p.$transaction(async tx=>{
 const a=await read(tx),b=await read(tx);need(JSON.stringify(a)===JSON.stringify(b));return b;
},{isolationLevel:'RepeatableRead',timeout:25000});console.log(JSON.stringify(value));})()
.catch(()=>{console.log('{"diagnosticError":"API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE"}');})
.finally(async()=>{try{await p.$disconnect();}catch{process.exitCode=1;}});'''


def business_logs(d, directory, task):
    state = d.service_state(directory, 'auto-registration', include_container_id=True)
    d.require(re.fullmatch(r'[a-f0-9]{64}', state['containerId']), 'API_ADMIN_REGISTRATION_LOGS_UNAVAILABLE')
    result = subprocess.run(['docker', 'logs', '--since', task['launchAt'], '--tail', '1000', state['containerId']],
                            capture_output=True, text=True, timeout=20)
    raw = result.stdout + result.stderr
    d.require(result.returncode == 0 and len(raw.encode()) <= 256 * 1024, 'API_ADMIN_REGISTRATION_LOGS_UNAVAILABLE')
    base = re.escape(TASK_ID) + r' attempt=' + str(task['attempt'])
    checkpoint = re.compile(r'Registration verification checkpoint job=' + base
        + r' checkpoint=(email_code_returned|same_email_identity_confirmed) owned_context=(True|False) after_email_code_returned=(True|False)(?:\s|$)')
    failure = re.compile(r'Registration verification failed job=' + base
        + r' phase=([a-z_]+) error_type=(TimeoutError|AssertionError|Error|TargetClosedError|Stop|UnexpectedError)'
          r' browser_code=((?:net::)?[A-Z_]+|none) cleanup=(True|False) reason=([a-z_]+) subphase=([a-z_]+)(?:\s|$)')
    phases = {'context_create', 'context_route', 'page_create', 'navigation', 'navigation_guard', 'body_read',
        'field_read', 'email_code_wait', 'email_code_fill', 'email_code_submit', 'identity_read', 'email_fill',
        'mail_prepare', 'email_submit', 'password_choice', 'password_fill', 'password_submit', 'totp_fill',
        'totp_submit', 'secret_cleanup', 'context_cleanup', 'cleanup'}
    subphases = {'none', 'get_first', 'get_retry', 'url_guard', 'http_403', 'http_other', 'retry_budget',
        'retry_guard_install', 'retry_guard_remove', 'official_guard', 'text_read', 'title_read', 'challenge_scan',
        'phone_scan', 'challenge_text', 'challenge_visible', 'phone_verification', 'email_field_read',
        'email_field_missing', 'email_code_already_submitted', 'email_code_wait', 'email_code_wait_timeout',
        'email_code_field_read', 'email_code_field_missing', 'email_code_type_read', 'email_code_type_unconfirmed',
        'mail_value_invalid', 'login_code_type_read', 'unknown_code_type', 'unsupported_code_type',
        'password_form_wait_exhausted', 'password_identity_unconfirmed', 'post_code_identity_unconfirmed',
        'password_rejected', 'secret_cleanup', 'context_cleanup', 'identity_first', 'identity_retry',
        'identity_guard_install', 'identity_code_guard', 'identity_get', 'identity_after_get', 'identity_guard_remove',
        'owned_onboarding', 'email_form_readiness', 'email_form_changed', 'challenge_loading',
        'challenge_loading_exhausted', 'email_code_catchup'}
    reasons = {'none', 'session_load_timeout', 'session_network_error', 'browser_operation_failed',
        'operation_cancelled', 'verification_required', 'http_error', 'form_unrecognized', 'official_login_email_mismatch',
        'official_login_not_verified', 'registration_authorization_expired', 'mailbox_timeout', 'password_unverified',
        'mfa_unverified', 'unsupported_login_provider', 'login_form_ambiguous'}
    codes = {'none', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
        'net::ERR_CONNECTION_CLOSED', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED',
        'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NETWORK_CHANGED', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_CONNECTION_REFUSED',
        'net::ERR_INTERNET_DISCONNECTED', 'NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_NET_INTERRUPT',
        'NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_PROXY_CONNECTION_REFUSED', 'NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_UNKNOWN_PROXY_HOST'}
    checkpoints = {'email_code_returned': 0, 'same_email_identity_confirmed': 0}
    failures, cleanup = 0, 0
    first_failure = None
    last_failure = None
    for line in raw.splitlines():
        value = checkpoint.search(line)
        if value:
            checkpoints[value[1]] += 1
        value = failure.search(line)
        if value:
            failures += 1
            cleanup += int(value[4] == 'True')
            if value[4] == 'False':
                last_failure = {'phase': value[1] if value[1] in phases else 'none', 'errorType': value[2],
                    'browserCode': value[3] if value[3] in codes else 'none',
                    'reason': value[5] if value[5] in reasons else 'none',
                    'subphase': value[6] if value[6] in subphases else 'none'}
                if first_failure is None:
                    first_failure = last_failure
    return {'checkpoints': checkpoints, 'failureCount': failures, 'cleanupFailureCount': cleanup,
            'firstFailure': first_failure, 'lastFailure': last_failure,
            'provesOfficialOtpAcceptance': False, 'rawOutputSuppressed': True}


def registration_business(d, expected):
    # A business read may follow a registered cold resume with a new profile.
    # Full runtime/unchanged-service proof remains required; only a10's job
    # snapshot comparison is left to the publication and handoff entry points.
    runtime = readback(d, expected, check_task=False)
    directory = (d.BASE / 'current').resolve()
    record = json.loads((directory / STATE_FILE).read_text())
    email_mac = record['registrationTask']['emailHashHmac']
    d.require(re.fullmatch(r'[a-f0-9]{64}', email_mac), 'API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE')
    code = BUSINESS_SOURCE.replace('__TASK__', json.dumps(TASK_ID)).replace('__BINDING__', json.dumps(TASK_BINDING)).replace('__EMAIL_MAC__', json.dumps(email_mac))
    task = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    fields = {'taskId', 'attempt', 'state', 'step', 'reason', 'registered', 'passwordVerified', 'mfaVerified',
        'accountRegistered', 'encryptedPasswordPresent', 'encryptedMfaPresent', 'leaseActive', 'profileBindingConfirmed',
        'launchAt', 'updatedAt', 'progressCount', 'progressTruncated', 'codeReadCount', 'codeReadTruncated',
        'officialThisAttempt', 'passwordThisAttempt', 'mfaThisAttempt', 'officialAt', 'passwordAt', 'mfaAt'}
    booleans = {'registered', 'passwordVerified', 'mfaVerified', 'accountRegistered', 'encryptedPasswordPresent',
        'encryptedMfaPresent', 'leaseActive', 'profileBindingConfirmed', 'progressTruncated', 'codeReadTruncated',
        'officialThisAttempt', 'passwordThisAttempt', 'mfaThisAttempt'}
    d.require(isinstance(task, dict) and set(task) == fields and task['taskId'] == TASK_ID
              and type(task['attempt']) is int and 10 <= task['attempt'] <= 2147483647
              and task['state'] in ('queued', 'running', 'awaiting_email', 'awaiting_user', 'partial', 'completed', 'cancelled')
              and task['step'] in ('queued', 'email', 'email_code', 'profile', 'registered', 'password', 'password_verified', 'mfa', 'mfa_verified', 'offer', 'completed')
              and task['reason'] in ('none', 'other', 'session_load_timeout', 'session_network_error', 'browser_operation_failed',
                  'operation_cancelled', 'verification_required', 'http_error', 'form_unrecognized', 'official_login_email_mismatch',
                  'official_login_not_verified', 'registration_authorization_expired', 'mailbox_timeout', 'password_unverified',
                  'mfa_unverified', 'unsupported_login_provider', 'login_form_ambiguous', 'window_missing', 'mail_value_invalid')
              and all(type(task[n]) is bool for n in booleans)
              and all(type(task[n]) is int and 0 <= task[n] <= 1000 for n in ('progressCount', 'codeReadCount'))
              and all(isinstance(task[n], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', task[n])
                  for n in ('launchAt', 'updatedAt'))
              and all(task[n] is None or isinstance(task[n], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', task[n])
                  for n in ('officialAt', 'passwordAt', 'mfaAt'))
              and all(task[flag] is (task[at] is not None) for flag, at in (
                  ('officialThisAttempt', 'officialAt'), ('passwordThisAttempt', 'passwordAt'), ('mfaThisAttempt', 'mfaAt'))),
              'API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE')
    logs = business_logs(d, directory, task)
    after_task = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    d.require(after_task == task and (d.BASE / 'current').resolve() == directory and snapshot(d, directory) == runtime['services'],
              'API_ADMIN_REGISTRATION_BUSINESS_MOVED')
    confirmed = all(task[n] is True for n in ('registered', 'passwordVerified', 'mfaVerified', 'accountRegistered',
        'encryptedPasswordPresent', 'encryptedMfaPresent', 'profileBindingConfirmed', 'officialThisAttempt',
        'passwordThisAttempt', 'mfaThisAttempt')) and task['progressTruncated'] is False
    confirmed = confirmed and task['state'] == 'completed' and task['step'] == 'completed' and task['leaseActive'] is False
    return {'status': 'API_REGISTRATION_BUSINESS_OBSERVED', 'commit': expected, 'task': task,
            'diagnostic': logs, 'businessAcceptanceConfirmed': confirmed, 'readOnly': True}


def handoff_directory(d):
    return d.BASE / '.staging' / ('api-registration-handoff-' + REGISTRATION_CURRENT)


def ordinary_handoff_record(task):
    return {'version': 1, 'scope': SCOPE, 'commit': REGISTRATION_CURRENT,
            'task': task, 'privateCancelConfirmed': True, 'databaseWrites': 0,
            'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
            'windowRetained': False}


def recovery_marker(task, states):
    return {'version': 1, 'scope': SCOPE, 'taskId': TASK_ID, 'attempt': TASK_ATTEMPT,
            'privatePostBudget': 0, 'signalPassBudget': 1, 'signal': 'SIGTERM',
            'containerId': states['auto-registration']['containerId'], 'taskSha256': fingerprint(task),
            'servicesSha256': fingerprint(states), 'firstFailureSha256': fingerprint(HANDOFF_FAILURE),
            'nativeProbeSourceSha256': hashlib.sha256(NATIVE_HANDOFF_SOURCE.encode()).hexdigest()}


def require_native_handoff(d, directory, record):
    folder = handoff_failed_attempt(d, require_unconfirmed=False)
    d.require(not (folder / 'recovery-failure.json').exists() and not (folder / 'recovery-failure.json').is_symlink(),
              'API_ADMIN_REGISTRATION_RECOVERY_FAILED')
    marker = handoff_json(d, folder, 'recovery-attempt.json')
    task = registration_task(d, directory)
    fields = {'version', 'scope', 'commit', 'task', 'privateCancelConfirmed', 'windowClosure',
              'privateMemoryRetained', 'resourceClosed', 'databaseWrites', 'accountPreserved', 'taskPreserved',
              'passwordCandidatePreserved', 'servicesSha256', 'audit', 'auditFile', 'auditRawSha256', 'recoveryAttemptSha256'}
    d.require(isinstance(record, dict) and set(record) == fields and type(record['version']) is int and record['version'] == 2
              and record['scope'] == SCOPE and record['commit'] == REGISTRATION_CURRENT and fingerprint(record['task']) == fingerprint(task)
              and record['privateCancelConfirmed'] is False and record['windowClosure'] == 'owned_native_process_exit'
              and all(record[n] is True for n in ('privateMemoryRetained', 'resourceClosed', 'accountPreserved',
                  'taskPreserved', 'passwordCandidatePreserved')) and type(record['databaseWrites']) is int
              and record['databaseWrites'] == 0 and record['servicesSha256'] == REGISTRATION_STATES_SHA
              and re.fullmatch(r'handoff-recover-[0-9]+-[0-9]+-after-audit\.json', record['auditFile'])
              and re.fullmatch(r'[a-f0-9]{64}', record['auditRawSha256']),
              'API_ADMIN_REGISTRATION_NATIVE_RECORD_CHANGED')
    wanted = {'version': 1, 'scope': SCOPE, 'taskId': TASK_ID, 'attempt': TASK_ATTEMPT,
              'privatePostBudget': 0, 'signalPassBudget': 1, 'signal': 'SIGTERM', 'containerId': marker.get('containerId'),
              'taskSha256': fingerprint(task), 'servicesSha256': REGISTRATION_STATES_SHA,
              'firstFailureSha256': fingerprint(HANDOFF_FAILURE),
              'nativeProbeSourceSha256': hashlib.sha256(NATIVE_HANDOFF_SOURCE.encode()).hexdigest()}
    d.require(fingerprint(marker) == fingerprint(wanted) and fingerprint(marker) == record['recoveryAttemptSha256'],
              'API_ADMIN_REGISTRATION_RECOVERY_MARKER_CHANGED')
    audit_path = folder / record['auditFile']
    d.require(audit_path.lstat().st_uid == 0 and hashlib.sha256(d.fixed_recharge_bytes(
        audit_path, modes=(0o400,), limit=128 * 1024)).hexdigest() == record['auditRawSha256']
        and audit_receipt(d, audit_path) == record['audit'], 'API_ADMIN_REGISTRATION_RECOVERY_AUDIT_CHANGED')
    state = d.service_state(directory, 'auto-registration', include_container_id=True, include_environment_hash=True)
    d.require(state['containerId'] == marker['containerId'], 'API_ADMIN_REGISTRATION_NATIVE_CONTAINER_CHANGED')
    registration_private(d, directory, retained=True)
    observed = native_handoff(d, directory, marker['containerId'])
    d.require(observed['resourceClosed'] is True and observed['zeroObservations'] == 2,
              'API_ADMIN_REGISTRATION_NATIVE_REMAINS')
    d.require(registration_task(d, directory) == task and d.service_state(directory, 'auto-registration',
        include_container_id=True, include_environment_hash=True) == state,
        'API_ADMIN_REGISTRATION_RECOVERY_MOVED')
    registration_private(d, directory, retained=True)
    return record


def registration_handoff_recovery(d, expected, *, recover=False):
    d.require(REGISTRATION and expected == REGISTRATION_CURRENT, 'API_ADMIN_SCOPE_CONFLICT')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
        folder = handoff_failed_attempt(d)
        marker_path = folder / 'recovery-attempt.json'
        if recover:
            d.require(not marker_path.exists() and not marker_path.is_symlink(),
                      'API_ADMIN_REGISTRATION_RECOVERY_ALREADY_ATTEMPTED')
        directory, manifest, states, evidence = baseline(d, expected, check_jobs=False)
        configuration = configuration_hashes(directory)
        task = registration_task(d, directory)
        guards = jobs_idle(d, directory, allow_retained=True)
        private = registration_private(d, directory, retained=guards['registrationWindowRetained'])
        stem = f'handoff-{"recover" if recover else "observe"}-{time.time_ns()}-{os.getpid()}'
        before_audit = strict_audit(d, directory, folder / (stem + '-before-audit.json'))
        first = native_handoff(d, directory, states['auto-registration']['containerId'])
        if recover and not guards['registrationWindowRetained']:
            d.require(first['resourceClosed'] is True, 'API_ADMIN_REGISTRATION_NATIVE_REMAINS')
        marker = recovery_marker(task, states)
        if recover:
            with marker_path.open('x') as stream:
                json.dump(marker, stream, sort_keys=True)
            marker_path.chmod(0o400)
        native, signal_started = None, False
        try:
            if recover and guards['registrationWindowRetained']:
                signal_started = True
                native = native_handoff(d, directory, marker['containerId'], recover=True)
            else:
                native = first
            after_directory, after_manifest, after_states, after_evidence = baseline(d, expected, check_jobs=False)
            after_task = registration_task(d, directory)
            after_guards = jobs_idle(d, directory, allow_retained=True)
            after_private = registration_private(d, directory, retained=after_guards['registrationWindowRetained'])
            after_audit_path = folder / (stem + '-after-audit.json')
            after_audit = strict_audit(d, directory, after_audit_path)
            last = native_handoff(d, directory, marker['containerId'])
            d.require(after_directory == directory and after_manifest == manifest and after_states == states
                      and configuration_hashes(directory) == configuration and after_task == task
                      and after_guards == guards and after_private == private and after_audit == before_audit
                      and all(after_evidence[k] == evidence[k] for k in ('manifestSha256', 'environmentSha256', 'apiSource'))
                      and (last['resourceClosed'] is True if recover else last == first),
                      'API_ADMIN_REGISTRATION_RECOVERY_MOVED')
            handoff_failed_attempt(d)
            if not recover:
                return {'status': 'API_REGISTRATION_HANDOFF_OBSERVED', 'commit': expected, 'readOnly': True,
                        'services': states, 'task': task, 'guards': guards, 'audit': after_audit,
                        'private': private, 'native': last, 'firstFailure': HANDOFF_FAILURE,
                        'recoveryAlreadyAttempted': marker_path.exists()}
            d.require(fingerprint(handoff_json(d, folder, 'recovery-attempt.json')) == fingerprint(marker),
                      'API_ADMIN_REGISTRATION_RECOVERY_MARKER_CHANGED')
            if not guards['registrationWindowRetained']:
                record = ordinary_handoff_record(task)
            else:
                after_audit_path.chmod(0o400)
                record = {'version': 2, 'scope': SCOPE, 'commit': expected, 'task': task,
                    'privateCancelConfirmed': False, 'windowClosure': 'owned_native_process_exit',
                    'privateMemoryRetained': True, 'resourceClosed': True, 'databaseWrites': 0,
                    'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
                    'servicesSha256': fingerprint(states), 'audit': after_audit, 'auditFile': after_audit_path.name,
                    'auditRawSha256': hashlib.sha256(after_audit_path.read_bytes()).hexdigest(),
                    'recoveryAttemptSha256': fingerprint(marker)}
            with (folder / 'confirmed.json').open('x') as stream:
                json.dump(record, stream, sort_keys=True)
            (folder / 'confirmed.json').chmod(0o400)
            require_registration_handoff(d, directory, manifest)
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected,
                    'privateCancelPerformed': False, 'signalsAttempted': native['signalsAttempted'],
                    'resourceClosed': True, 'privateMemoryRetained': guards['registrationWindowRetained'],
                    'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
                    'databaseWrites': 0, 'businessAcceptanceConfirmed': False}
        except Exception as error:
            if recover:
                diagnostic = dict(error.diagnostic) if isinstance(error, RegistrationRecoveryError) else {
                    'confirmed': False, 'signalsAttempted': native['signalsAttempted'] if native is not None else
                        None if signal_started else 0, 'nativeCount': 0, 'nativeCountObserved': False,
                    'rawOutputSuppressed': True}
                if native is not None:
                    diagnostic['signalsAttempted'] = native['signalsAttempted']
                path = folder / 'recovery-failure.json'
                with path.open('x') as stream:
                    json.dump(diagnostic, stream, sort_keys=True)
                path.chmod(0o400)
                code = str(error)
                if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
                    code = 'API_ADMIN_REGISTRATION_RECOVERY_UNAVAILABLE'
                raise RegistrationRecoveryError(code, diagnostic) from None
            raise


def require_registration_handoff(d, directory, manifest):
    if manifest.get('apiRegistrationPublication'):
        return
    record = handoff_json(d, handoff_directory(d), 'confirmed.json')
    if record.get('version') == 2:
        return require_native_handoff(d, directory, record)
    current = registration_task(d, directory)
    d.require(fingerprint(record) == fingerprint(ordinary_handoff_record(current)), 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
    registration_private(d, directory, retained=False)
    return record


def registration_preflight(d, expected, *, require_closed=False):
    directory, manifest, states, evidence = baseline(d, expected, check_jobs=False)
    guards = jobs_idle(d, directory, allow_retained=True)
    task = registration_task(d, directory)
    registration_private(d, directory, retained=guards['registrationWindowRetained'])
    closed = require_closed or (handoff_directory(d) / 'confirmed.json').exists()
    if closed:
        require_registration_handoff(d, directory, manifest)
    folder = Path(__file__).parent
    audit_path = folder / 'api-registration-preflight-audit.json'
    audit = strict_audit(d, directory, audit_path)
    d.require(snapshot(d, directory) == states and registration_task(d, directory) == task,
              'API_ADMIN_REGISTRATION_PREFLIGHT_CHANGED')
    return {'status': 'API_REGISTRATION_BASELINE_VERIFIED', 'commit': expected, 'services': states,
            **evidence, 'guards': guards, 'task': task, 'audit': audit,
            'requiresWindowHandoff': guards['registrationWindowRetained'] and not closed}


def registration_handoff(d, expected):
    d.require(REGISTRATION and expected == REGISTRATION_CURRENT, 'API_ADMIN_SCOPE_CONFLICT')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
        proof = registration_preflight(d, expected)
        directory = Path(REGISTRATION_DIRECTORY)
        folder = handoff_directory(d)
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        d.require(folder.resolve() == folder and stat.S_IMODE(folder.stat().st_mode) == 0o700
                  and folder.stat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
        if not proof['requiresWindowHandoff']:
            require_registration_handoff(d, directory, {'commit': expected})
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected, 'privateCancelPerformed': False}
        marker = folder / 'attempt.json'
        d.require(not marker.exists(), 'API_ADMIN_REGISTRATION_HANDOFF_ALREADY_ATTEMPTED')
        with marker.open('x') as stream:
            json.dump({'taskId': TASK_ID, 'attempt': TASK_ATTEMPT, 'privatePostBudget': 1}, stream)
        marker.chmod(0o400)
        try:
            registration_private(d, directory, close=True)
            d.require(snapshot(d, directory) == proof['services'] and registration_task(d, directory) == proof['task'],
                      'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
            jobs_idle(d, directory)
            record = {'version': 1, 'scope': SCOPE, 'commit': expected, 'task': proof['task'],
                      'privateCancelConfirmed': True, 'databaseWrites': 0, 'accountPreserved': True,
                      'taskPreserved': True, 'passwordCandidatePreserved': True, 'windowRetained': False}
            path = folder / 'confirmed.json'
            with path.open('x') as stream:
                json.dump(record, stream, sort_keys=True)
            path.chmod(0o400)
            require_registration_handoff(d, directory, {'commit': expected})
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected,
                    'privateCancelPerformed': True, 'accountPreserved': True, 'taskPreserved': True,
                    'databaseWrites': 0, 'windowRetained': False, 'businessAcceptanceConfirmed': False}
        except RegistrationHandoffError as error:
            path = folder / 'failure.json'
            with path.open('x') as stream:
                json.dump(error.diagnostic, stream, sort_keys=True)
            path.chmod(0o400)
            raise


def registration_public_map(d, directory):
    d.require(directory.resolve() == directory, 'API_ADMIN_REGISTRATION_SOURCE_LOCATION_CHANGED')
    paths = list(directory.rglob('*'))
    d.require(len(paths) <= 7000, 'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
    result, total = {}, 0
    for path in paths:
        d.require(not path.is_symlink(), 'API_ADMIN_REGISTRATION_SOURCE_CHANGED')
        if path.is_dir():
            continue
        name = path.relative_to(directory).as_posix()
        if name in REGISTRATION_PRIVATE:
            continue
        d.require(len(result) < 5000, 'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
        limit = 1024 * 1024 if name == 'scripts/production-release/remote-deploy.py' else 8 * 1024 * 1024
        raw = d.fixed_recharge_bytes(path, modes=(0o644, 0o755, 0o664), limit=limit)
        total += len(raw)
        mode = stat.S_IMODE(path.lstat().st_mode)
        d.require(total <= 64 * 1024 * 1024
                  and (mode in (0o644, 0o755) or name == 'docker-compose.aws-mysql.yml' and mode == 0o664),
                  'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
        result[name] = (hashlib.sha256(raw).hexdigest(), mode)
    return {'fileCount': len(result), 'sha256': hashlib.sha256(json.dumps(result,
        ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def worker_source(d, directory, service, rows):
    expected = {n[len(WORKER_PREFIX):]: r['sha256'] for n, r in rows.items()}
    code = ('import hashlib,json\nfrom pathlib import Path\nnames=' + repr(sorted(expected))
            + '\nprint(json.dumps({n:hashlib.sha256((Path("/app")/n).read_bytes()).hexdigest() for n in names}))')
    value = json.loads(d.compose(directory, 'exec', '-T', service, 'python', '-B', '-c', code, timeout=20))
    d.require(value == expected and len(value) == 60, 'API_ADMIN_REGISTRATION_RUNTIME_SOURCE_CHANGED')
    return fingerprint(value)


def registration_native_baseline(d, previous, manifest, states, raw):
    d.require(str(previous) == REGISTRATION_DIRECTORY and manifest['commit'] == REGISTRATION_CURRENT
              and hashlib.sha256(raw).hexdigest() == REGISTRATION_MANIFEST_SHA
              and fingerprint(states) == REGISTRATION_STATES_SHA
              and registration_public_map(d, previous) == REGISTRATION_PUBLIC,
              'API_ADMIN_REGISTRATION_CURRENT_CHANGED')
    profile = registration_profile(d, previous)
    provenance = manifest['fixedRegistrationRelease']
    d.require(provenance['id'] == profile['id'] and provenance['profileRawSha256'] == REGISTRATION_PROFILE_SHA
              and provenance['workerProjectionSha256'] == profile['workerProjectionSha256']
              and manifest['servicesUpdated'] == ['auto-registration'] and manifest['migrationApplied'] is False
              and manifest['newMigrations'] == [], 'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
    metadata = json.loads(d.run('docker', 'image', 'inspect', states['auto-registration']['image']))[0]
    labels = metadata['Config'].get('Labels', {})
    d.require(metadata['Id'] == states['auto-registration']['image'] and metadata['Architecture'] == 'amd64'
              and labels.get('org.opencontainers.image.revision') == REGISTRATION_CURRENT
              and labels.get('id-business-v2.worker-projection-sha256') == profile['workerProjectionSha256'],
              'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
    worker_source(d, previous, 'auto-registration', profile['workerProjection'])
    pro = json.loads((previous / 'deploy/aws/recharge-pro-6f5-20261008.json').read_text())
    pro_sha = worker_source(d, previous, 'auto-recharge', pro['workerProjection'])
    d.require(pro_sha == profile['runtimeBaseline']['proWorkerSourceSha256'],
              'API_ADMIN_REGISTRATION_PRESERVED_PRO_CHANGED')
    content = content_summary(d, 'api', d.compose(previous, 'exec', '-T', 'api', '/bin/sh', '-c', content_command('api')))
    d.require(content == REGISTRATION_API_CONTENT, 'API_ADMIN_REGISTRATION_RETAINED_API_CHANGED')
    compiled = profile['runtimeBaseline']['apiCompiledSourceSha256']
    code = ('const fs=require("node:fs"),c=require("node:crypto");const names=' + json.dumps(sorted(compiled))
            + ';console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash("sha256").update(fs.readFileSync("/app/"+n)).digest("hex")]))));')
    measured = json.loads(d.compose(previous, 'exec', '-T', 'api', 'node', '-e', code, timeout=20))
    proof = json.loads((previous / 'api-admin-build-proof.json').read_text())
    d.require(measured == compiled and fingerprint(proof) == profile['runtimeBaseline']['apiBuildProofSha256']
              and proof['commit'] == profile['runtimeBaseline']['apiRuntimeRevision']
              and proof['images']['api']['imageId'] == states['api']['image']
              and {k: proof['images']['api'][k] for k in ('fileCount', 'sha256')} == content,
              'API_ADMIN_REGISTRATION_RETAINED_API_CHANGED')
    return {'kind': 'VERIFIED_EXISTING_API_REGISTRATION_SOURCE', 'profileRawSha256': REGISTRATION_PROFILE_SHA,
            'workerProjectionSha256': profile['workerProjectionSha256'], 'apiContent': content,
            'apiCompiledSourceSha256': fingerprint(measured), 'proWorkerSourceSha256': pro_sha}


def baseline(d, expected, *, check_jobs=True):
    stage = 'MANIFEST'
    diagnostic = {'step': 'NOT_STARTED', 'service': 'none', 'scope': SCOPE} if WORKSPACE else None
    prior_diagnostic = getattr(d, '_workspaceBaselineDiagnostic', None)
    if WORKSPACE:
        d._workspaceBaselineDiagnostic = diagnostic
    try:
        previous = (d.BASE / 'current').resolve()
        d.require(previous.parent == d.BASE / 'releases', 'API_ADMIN_BASELINE_PATH_INVALID')
        raw = (previous / 'release-manifest.json').read_bytes()
        manifest = json.loads(raw)
        d.require(manifest.get('commit') == expected, 'API_ADMIN_BASELINE_CHANGED')
        stage = 'SNAPSHOT'
        states = snapshot(d, previous)
        if not WORKSPACE:
            d.require(not workspace_existing(d, previous), 'API_ADMIN_WORKSPACE_SCOPE_REQUIRED')
        stage = 'IMAGES'
        for service in (*d.SERVICES, *((ONLINE_SERVICE,) if ONLINE_SERVICE in states else ())):
            row = manifest.get('images', {}).get(service, {})
            d.require(row.get('reference') == states[service]['reference']
                      and row.get('digest') == states[service]['image'], 'API_ADMIN_BASELINE_IMAGE_CHANGED')
        metadata = json.loads(d.run('docker', 'image', 'inspect', states['api']['image']))[0]
        labels = metadata.get('Config', {}).get('Labels', {})
        d.require(metadata['Id'] == states['api']['image'] and labels.get('org.opencontainers.image.revision')
                  == manifest['images']['api']['sourceCommit'], 'API_ADMIN_BASELINE_API_REVISION_CHANGED')
        source = {'imageId': metadata['Id'], 'revision': labels['org.opencontainers.image.revision']}
        stage = 'PROJECTION'
        migration_origin = None
        online_context = None
        if manifest.get('onlineRechargePublication'):
            d.require(WORKSPACE, 'API_ADMIN_SCOPE_CONFLICT')
            online_context = online_origin(d, previous, manifest, states)
            online_record = json.loads((previous / online_reader(d).STATE_FILE).read_text())
            migration_origin = online_record['baselineEvidence'].get('migrationOrigin')
            source['kind'] = 'VERIFIED_ONLINE_RECHARGE_ORIGIN'
        elif manifest.get('apiAdminMigrationPublication'):
            if SCOPE in ('API_ADMIN', 'API_ADMIN_WORKSPACE'):
                migration_origin = migration_successor_origin(d, previous)
                source['kind'] = 'VERIFIED_MIGRATION_API_ADMIN_ORIGIN'
            else:
                d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
                proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
                d.require(manifest['apiAdminMigrationPublication'] == {'version': 1, 'scope': SCOPE,
                    'buildProofSha256': fingerprint(proof), 'workersPublished': False,
                    'cacheStatus': 'SKIPPED', 'configurationChanged': False, 'schemaChanged': True,
                    'migration': MIGRATION_IDENTITY} and manifest.get('migrationApplied') is True
                    and manifest.get('newMigrations') == [MIGRATION_FILE],
                    'API_ADMIN_MIGRATION_PROVENANCE_CHANGED')
                migration_source_check(d, previous)
                verify_running(d, previous, proof)
                verify_migration_image(d, previous, proof)
                source['kind'] = 'API_ADMIN_MIGRATION_BUILD_PROVEN'
        elif manifest.get('apiRegistrationPublication'):
            d.require(REGISTRATION or MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
            origin, _ = d.api_admin_scope('API_REGISTRATION')
            proof = origin.validate_proof(d, json.loads((previous / origin.PROOF_FILE).read_text()),
                                          expected, manifest['sourceTree'])
            d.require(manifest['apiRegistrationPublication'] == {'version': 1, 'scope': 'API_REGISTRATION',
                'buildProofSha256': fingerprint(proof), 'workersPublished': True,
                'cacheStatus': 'SKIPPED', 'configurationChanged': False}, 'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
            if MIGRATION_MODE:
                d.require(manifest.get('servicesUpdated') == ['api', 'auto-registration']
                          and manifest.get('migrationApplied') is False and manifest.get('newMigrations') == [],
                          'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
            origin.verify_running(d, previous, proof)
            source['kind'] = 'API_REGISTRATION_BUILD_PROVEN'
        elif REGISTRATION or MIGRATION_MODE:
            source.update(registration_native_baseline(d, previous, manifest, states, raw))
        elif manifest.get('apiAdminPublication') or manifest.get('apiWorkspacePublication'):
            workspace_probe_step(d, 'CURRENT_PROOF')
            if manifest.get('apiWorkspacePublication'):
                d.require(WORKSPACE and not manifest.get('apiAdminPublication'), 'API_ADMIN_SCOPE_CONFLICT')
                proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
                verify_running(d, previous, proof)
                workspace_probe_step(d, 'CURRENT_RECORD')
                record = json.loads((previous / STATE_FILE).read_text())
                d.require(manifest['apiWorkspacePublication'] == {'version': 1, 'scope': SCOPE,
                    'buildProofSha256': fingerprint(proof), 'workersPublished': False, 'cacheStatus': 'SKIPPED',
                    'configurationChanged': True, 'volume': record.get('workspaceVolumeAfter'),
                    'volumeDeletionPerformed': False,
                    **({'sqliteProtectionSha256': record['sqliteProtectionSha256']} if 'sqliteProtectionSha256' in record else {})},
                    'API_ADMIN_WORKSPACE_PROVENANCE_CHANGED')
                workspace_sqlite_receipt(d, previous, proof, record, manifest)
            elif WORKSPACE:
                original, _ = d.api_admin_scope()
                proof = original.validate_proof(d, json.loads((previous / original.PROOF_FILE).read_text()), expected, manifest['sourceTree'])
                original.verify_running(d, previous, proof)
                workspace_probe_step(d, 'CURRENT_RECORD')
                record = json.loads((previous / original.STATE_FILE).read_text())
            else:
                proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
                verify_running(d, previous, proof)
                workspace_probe_step(d, 'CURRENT_RECORD')
                record = json.loads((previous / STATE_FILE).read_text())
            source['kind'] = 'API_WORKSPACE_BUILD_PROVEN' if manifest.get('apiWorkspacePublication') else 'API_ADMIN_BUILD_PROVEN'
            if WORKSPACE and (manifest.get('preservedOnlineRechargeOrigin') is not None
                              or record.get('onlineRechargeOrigin') is not None):
                online_context = record.get('onlineRechargeOrigin')
                online_origin_guard(d, previous, online_context)
                d.require(manifest.get('preservedOnlineRechargeOrigin') == online_marker(online_context),
                          'API_ADMIN_ONLINE_ORIGIN_CHANGED')
                predecessor = Path(manifest.get('previousRelease', ''))
                d.require(predecessor.parent == d.BASE / 'releases' and not predecessor.is_symlink()
                    and predecessor.is_dir(), 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
                predecessor_manifest = json.loads((predecessor / 'release-manifest.json').read_text())
                d.require(predecessor_manifest.get('commit') == manifest.get('previousCommit')
                    and hashlib.sha256((predecessor / 'release-manifest.json').read_bytes()).hexdigest()
                        == manifest.get('previousManifestSha256') == record['baselineEvidence']['manifestSha256']
                    and record['baselineEvidence'].get('onlineRechargeOrigin') == online_context,
                    'API_ADMIN_ONLINE_ORIGIN_CHANGED')
                if predecessor_manifest.get('onlineRechargePublication'):
                    d.require(predecessor == Path(online_context['release']), 'API_ADMIN_ONLINE_ORIGIN_CHANGED')
                else:
                    d.require(predecessor_manifest.get('apiWorkspacePublication') is not None
                        and predecessor_manifest.get('preservedOnlineRechargeOrigin') == online_marker(online_context)
                        and json.loads((predecessor / STATE_FILE).read_text()).get('onlineRechargeOrigin') == online_context,
                        'API_ADMIN_ONLINE_ORIGIN_CHANGED')
            predecessor = Path(manifest.get('previousRelease', ''))
            predecessor_origin = None
            if predecessor.parent == d.BASE / 'releases' and (predecessor / 'release-manifest.json').is_file():
                predecessor_manifest = json.loads((predecessor / 'release-manifest.json').read_text())
                predecessor_origin = predecessor_manifest.get('preservedMigrationOrigin')
                if predecessor_origin is not None:
                    d.require(not predecessor.is_symlink() and predecessor_manifest.get('commit') == manifest.get('previousCommit'),
                              'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
            if (manifest.get('preservedMigrationOrigin') or record.get('migrationOrigin')
                    or predecessor_origin is not None or manifest.get('previousCommit') == MIGRATION_SUCCESSOR_COMMIT):
                migration_origin = record.get('migrationOrigin')
                preserved_migration_guard(d, previous, migration_origin, online_context)
                d.require(manifest.get('preservedMigrationOrigin') == migration_successor_marker(migration_origin),
                          'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
                d.require(predecessor_origin is None or predecessor_origin == manifest['preservedMigrationOrigin'],
                          'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
        elif manifest.get('fixedRegistrationRelease', {}).get('id') == d.REGISTRATION_FOLLOWUP_ID:
            # 94 keeps the 815 API/Admin image; its own manifest revision describes only the Worker.
            d.require('apiAdminPublication' not in manifest, 'API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS')
            profile_raw = (previous / d.REGISTRATION_FOLLOWUP_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            receipt = d.check_registration_followup_deployment(expected, manifest['sourceTree'], profile_sha256)
            provenance = manifest['fixedRegistrationRelease']
            d.require(receipt['apiRuntimeRevision'] == source['revision'] == provenance['apiRuntimeRevision']
                      and receipt['apiBuildProofSha256'] == provenance['apiBuildProofSha256']
                      and receipt['apiContentSha256'] == provenance['apiContentSha256']
                      and receipt['adminContentSha256'] == provenance['adminContentSha256'],
                      'API_ADMIN_RETAINED_PUBLICATION_CHANGED')
            source.update(kind='VERIFIED_RETAINED_API_ADMIN_PUBLICATION',
                          profileId=d.REGISTRATION_FOLLOWUP_ID, profileRawSha256=profile_sha256,
                          buildProofSha256=receipt['apiBuildProofSha256'],
                          apiContentSha256=receipt['apiContentSha256'], adminContentSha256=receipt['adminContentSha256'])
        elif manifest.get('fixedRegistrationRelease', {}).get('id') == 'registration-worker-95-20261008':
            d.load_registration_interstitial95()
            # 95 keeps the 815 API/Admin image; its own manifest revision describes only the Worker.
            d.require('apiAdminPublication' not in manifest, 'API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS')
            profile_raw = (previous / d.REGISTRATION_INTERSTITIAL_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            receipt = d.check_registration_interstitial_deployment(expected, manifest['sourceTree'], profile_sha256)
            provenance = manifest['fixedRegistrationRelease']
            d.require(receipt['apiRuntimeRevision'] == source['revision'] == provenance['apiRuntimeRevision']
                      and receipt['apiBuildProofSha256'] == provenance['apiBuildProofSha256']
                      and receipt['apiContentSha256'] == provenance['apiContentSha256']
                      and receipt['adminContentSha256'] == provenance['adminContentSha256'],
                      'API_ADMIN_RETAINED_PUBLICATION_CHANGED')
            source.update(kind='VERIFIED_RETAINED_API_ADMIN_PUBLICATION',
                          profileId=d.REGISTRATION_INTERSTITIAL_ID, profileRawSha256=profile_sha256,
                          buildProofSha256=receipt['apiBuildProofSha256'],
                          apiContentSha256=receipt['apiContentSha256'], adminContentSha256=receipt['adminContentSha256'])
        elif labels.get('id-business-v2.api-projection-sha256'):
            # A later worker-only publication changes the manifest commit/classification,
            # while this immutable API image still comes from the fixed92 build.
            profile_raw = (previous / d.REGISTRATION_RECOVERY_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            d.require(source['revision'] == d.RECHARGE_2F_CURRENT
                      and profile_sha256 == d.RECHARGE_2F_PROFILE_RAW,
                      'API_ADMIN_UNKNOWN_API_PROJECTION')
            profile = d.registration_profile(json.loads(profile_raw), profile_id=d.REGISTRATION_RECOVERY_ID)
            d.registration_recovery_api_hashes(previous, profile)
            d.registration_recovery_image_labels('api', metadata, profile)
            source.update(kind='VERIFIED_EXISTING_API_PROJECTION',
                          profileId=d.REGISTRATION_RECOVERY_ID, profileRawSha256=profile_sha256,
                          projectionSha256=profile['apiProjectionSha256'],
                          compiledSourceSha256=profile['apiCompiledSourceProjectionSha256'])
        else:
            source['kind'] = 'IMMUTABLE_RELEASE_IMAGE'
        free_bytes = shutil.disk_usage(d.BASE).free
        if check_jobs:
            d.require(free_bytes > 6 * 1024**3, 'API_ADMIN_DISK_LOW_BEFORE_PULL')
        stage = 'JOBS'
        d.require((ONLINE_SERVICE in states) is (online_context is not None), 'API_ADMIN_ONLINE_ORIGIN_REQUIRED')
        guards = jobs_idle(d, previous) if check_jobs else None
        if check_jobs and online_context is not None:
            online_idle(d, previous)
        workspace_state = workspace_volume(d, previous,
                                            attached=bool(manifest.get('apiWorkspacePublication') or online_context)) if WORKSPACE else None
        if WORKSPACE and check_jobs:
            legacy = 'sqliteProtectionSha256' not in manifest.get('apiWorkspacePublication', {})
            workspace_idle(d, previous, legacy=legacy)
            if workspace_state['status'] == 'PRESENT':
                root = Path(json.loads(d.run('docker', 'volume', 'inspect', workspace_state['name']))[0]['Mountpoint'])
                if (root / 'database.db').exists():
                    d.require(not (root / WORKSPACE_MAINTENANCE).exists()
                              and not (root / WORKSPACE_MAINTENANCE).is_symlink(),
                              'API_ADMIN_WORKSPACE_MAINTENANCE_EXISTS')
                    if legacy:
                        workspace_legacy_audit(d, previous)
                    else:
                        workspace_private_inspect(d, previous, states['api']['reference'], workspace_state['name'])
        if REGISTRATION and check_jobs:
            require_registration_handoff(d, previous, manifest)
        migration_state = migration_database_state(d, previous) if MIGRATION_MODE else None
        stage = 'SNAPSHOT'
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_POINTER_MOVED')
        d.require((previous / 'release-manifest.json').read_bytes() == raw, 'API_ADMIN_BASELINE_MANIFEST_CHANGED')
        d.require(snapshot(d, previous) == states, 'API_ADMIN_BASELINE_SERVICES_CHANGED')
        evidence = {'manifestSha256': hashlib.sha256(raw).hexdigest(),
            'environmentSha256': hashlib.sha256((previous / '.env.aws.production').read_bytes()).hexdigest(),
            'apiSource': source, 'guards': guards, 'freeBytes': free_bytes}
        if MIGRATION_MODE:
            evidence['migrationState'] = migration_state
        if migration_origin is not None:
            evidence['migrationOrigin'] = migration_origin
        if WORKSPACE:
            evidence['workspaceVolume'] = workspace_state
            if online_context is not None:
                evidence['onlineRechargeOrigin'] = online_context
        return previous, manifest, states, evidence
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = f'API_ADMIN_BASELINE_{stage}_FAILED'
        if WORKSPACE:
            error_type = type(error).__name__
            diagnostic.update(phase=stage,
                errorType=error_type if error_type in WORKSPACE_DIAGNOSTIC_ERRORS else 'OTHER',
                rawOutputSuppressed=True)
            raise WorkspaceBaselineError(code, diagnostic) from None
        raise RuntimeError(code) from None
    finally:
        if WORKSPACE:
            if prior_diagnostic is None:
                del d._workspaceBaselineDiagnostic
            else:
                d._workspaceBaselineDiagnostic = prior_diagnostic


def verify_running(d, directory, proof):
    for service in IMAGE_SERVICES if WORKSPACE else UPDATED:
        workspace_probe_step(d, 'RUNTIME_IMAGE', service)
        expected = proof['images'][service]
        state = d.service_state(directory, service)
        image = json.loads(d.run('docker', 'image', 'inspect', state['image']))[0]
        labels = image.get('Config', {}).get('Labels', {})
        d.require(state['image'] == image['Id'] == expected['imageId']
                  and state['reference'] == expected['reference'] and image['Architecture'] == 'amd64'
                  and labels.get('org.opencontainers.image.revision') == proof['commit']
                  and labels.get('id-business-v2.source-tree') == proof['sourceTree'],
                  'API_ADMIN_RUNNING_IMAGE_CHANGED')
        workspace_probe_step(d, 'RUNTIME_CONTENT', service)
        measured = content_summary(d, service, d.compose(directory, 'exec', '-T', service,
            '/bin/sh', '-c', content_command(service)))
        d.require(measured == {key: expected[key] for key in ('fileCount', 'sha256')},
                  'API_ADMIN_RUNNING_CONTENT_CHANGED')
        if service == 'auto-registration':
            d.require(labels.get('id-business-v2.worker-projection-sha256') == proof['workerProjectionSha256'],
                      'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
            worker_source(d, directory, service, proof['workerProjection'])


def configuration_hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in (*CONFIG_FILES, 'compose.release.json')}


def require_preserved(d, previous, release, before, environment, *, all_services=False, online_context=None):
    d.require((previous / '.env.aws.production').read_bytes() == environment
              and (release / '.env.aws.production').read_bytes() == environment,
              'API_ADMIN_ENVIRONMENT_CHANGED')
    for name in CONFIG_FILES:
        if WORKSPACE and name in CONFIG_FILES[:2]:
            continue
        if MIGRATION_MODE and name == MIGRATION_SCHEMA:
            continue
        d.require((previous / name).read_bytes() == (release / name).read_bytes(), 'API_ADMIN_CONFIG_OR_SCHEMA_CHANGED')
    if WORKSPACE:
        workspace_configuration(d, previous, release)
    if WORKSPACE and online_context is not None:
        online_source_guard(d, previous)
        online_source_guard(d, release)
        d.require(all((previous / name).is_file() and not (previous / name).is_symlink()
                  and (release / name).is_file() and not (release / name).is_symlink()
                  and (previous / name).read_bytes() == (release / name).read_bytes()
                  for name in ONLINE_ADMISSION_FILES), 'API_ADMIN_ONLINE_ADMISSION_SOURCE_CHANGED')
    if MIGRATION_MODE:
        migration_source_check(d, previous, candidate=False)
        migration_source_check(d, release)
        d.require(d.migration_plan(previous, release) in ([], [MIGRATION_FILE]), 'API_ADMIN_MIGRATION_SCOPE_CHANGED')
    else:
        d.require(d.migration_plan(previous, release) == [], 'API_ADMIN_MIGRATIONS_FORBIDDEN')
    states = snapshot(d, previous)
    d.require(all(states[name] == before[name] for name in before
                  if all_services or name not in (*UPDATED, *((ONLINE_SERVICE,) if online_context is not None else ()))),
              'API_ADMIN_PRESERVED_CONTAINER_CHANGED')
    if ONLINE_SERVICE in before:
        d.require(online_context is not None, 'API_ADMIN_ONLINE_ORIGIN_REQUIRED')
        binding = online_binding(d, release, states)
        d.require(all(binding[n] == online_context['binding'][n] for n in
            ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')),
            'API_ADMIN_ONLINE_RUNTIME_CHANGED')
    if WORKSPACE:
        d.require(all(states['caddy'][name] == before['caddy'][name]
                      for name in ('image', 'reference', 'environmentSha256')),
                  'API_ADMIN_WORKSPACE_CADDY_IMAGE_CHANGED')
    old = json.loads((previous / 'compose.release.json').read_text())
    new = json.loads((release / 'compose.release.json').read_text())
    d.require(set(old) == set(new) == {'services'} and set(old['services']) == set(new['services'])
              and all(old['services'][name] == new['services'][name] for name in old['services'] if name not in IMAGE_SERVICES),
              'API_ADMIN_PRESERVED_IMAGE_REFERENCE_CHANGED')
    return states


def audit_receipt(d, receipt):
    report = json.loads(receipt.read_text())
    checks = report.get('checks', [])
    d.require(report.get('ok') is True and report.get('checkCount') == 49 and report.get('violationCount') == 0
              and isinstance(checks, list) and len(checks) == 49 and len({r.get('code') for r in checks}) == 49
              and all(r.get('count') == 0 for r in checks) and 'gate' not in report, 'API_ADMIN_STRICT_49_FAILED')
    return {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': fingerprint(checks)}


def strict_audit(d, directory, receipt):
    d.audit(directory, receipt, api_admin_only=True)
    return audit_receipt(d, receipt)


def source_tree(d, directory):
    tree = {}
    for path in directory.rglob('*'):
        if path.is_dir():
            continue
        d.require(path.is_file() and not path.is_symlink(), 'API_ADMIN_SOURCE_ENTRY_INVALID')
        raw = path.read_bytes()
        parent = tree
        parts = path.relative_to(directory).parts
        for part in parts[:-1]:
            parent = parent.setdefault(part, {})
        parent[parts[-1]] = ('100755' if path.stat().st_mode & 0o111 else '100644',
                            hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).digest())
    def encode(entries):
        raw = b''
        for name, value in sorted(entries.items(), key=lambda item: (item[0] + '/' if isinstance(item[1], dict) else item[0]).encode()):
            mode, oid = ('40000', encode(value)) if isinstance(value, dict) else value
            raw += mode.encode() + b' ' + name.encode() + b'\0' + oid
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).digest()
    return encode(tree).hex()


def readback(d, expected, *, check_task=True):
    d.require(not MIGRATION_MODE or check_task, 'API_ADMIN_SCOPE_CONFLICT')
    previous, manifest, states, evidence = baseline(d, expected, check_jobs=False)
    record = json.loads((previous / STATE_FILE).read_text())
    proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
    retained_online = evidence.get('onlineRechargeOrigin')
    d.require(manifest.get('servicesUpdated') == list(UPDATED)
              and manifest.get('migrationApplied') is (True if MIGRATION_MODE else False)
              and manifest.get('newMigrations') == ([MIGRATION_FILE] if MIGRATION_MODE else [])
              and record['buildProofSha256'] == fingerprint(proof)
              and evidence['environmentSha256'] == record['environmentSha256']
              and all(states[name] == record['before'][name] for name in states
                  if name not in (*UPDATED, *((ONLINE_SERVICE,) if retained_online is not None else ()))),
              'API_ADMIN_READBACK_PRESERVATION_FAILED')
    origin = Path(manifest['previousRelease'])
    d.require(origin.parent == d.BASE / 'releases'
              and configuration_hashes(previous) == record['configurationAfter']
              and configuration_hashes(origin) == record['configurationBefore'], 'API_ADMIN_READBACK_CONFIG_CHANGED')
    require_preserved(d, origin, previous, record['before'], (previous / '.env.aws.production').read_bytes(),
                      online_context=retained_online)
    workspace = {}
    if WORKSPACE:
        volume = workspace_volume(d, previous, attached=True)
        d.require(volume == record.get('workspaceVolumeAfter')
                  and proof['configuration'] == workspace_configuration(d, origin, previous),
                  'API_ADMIN_WORKSPACE_READBACK_CHANGED')
        workspace_health(d, previous)
        workspace = {'workspaceVolume': volume, 'volumePreserved': True, 'volumeDeletionPerformed': False,
                     'offlineAcceptance': proof['acceptance'], 'registrationHealthChecked': True}
        sqlite_protection = workspace_sqlite_receipt(d, previous, proof, record, manifest)
        if sqlite_protection is not None:
            workspace['sqliteProtection'] = sqlite_protection
        if retained_online is not None:
            binding = online_binding(d, previous, states)
            rebind = record.get('onlineNetworkRebind')
            d.require(isinstance(rebind, dict) and set(rebind) == {'version', 'before', 'after', 'sqlFence', 'businessActions'}
                and type(rebind['version']) is int and rebind['version'] == 1
                and type(rebind['businessActions']) is int and rebind['businessActions'] == 0
                and rebind['after'] == binding and rebind['before']['containerId'] == record['before'][ONLINE_SERVICE]['containerId']
                and rebind['before']['apiContainerId'] == record['before']['api']['containerId']
                and rebind['before']['containerId'] != binding['containerId']
                and rebind['before']['startedAtSha256'] != binding['startedAtSha256']
                and all(rebind['before'][n] == binding[n] for n in
                    ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256')),
                'API_ADMIN_ONLINE_REBIND_RECEIPT_CHANGED')
            online_fence_receipt(d, rebind['sqlFence'])
            workspace.update(preservedOnlineRechargeOrigin=online_marker(retained_online),
                             servicesRebound=[ONLINE_SERVICE], onlineNetworkRebind=rebind)
    d.require(audit_receipt(d, previous / 'before-audit.json') == manifest['dataAuditBefore']
              and audit_receipt(d, previous / 'after-audit.json') == manifest['dataAuditAfter']
              and manifest['dataAuditBefore']['checksSha256'] == manifest['dataAuditAfter']['checksSha256'],
              'API_ADMIN_READBACK_AUDIT_CHANGED')
    verify_running(d, previous, proof)
    d.require(snapshot(d, previous) == states and (d.BASE / 'current').resolve() == previous,
              'API_ADMIN_READBACK_MOVED')
    if REGISTRATION and check_task:
        jobs_idle(d, previous)
        d.require(registration_task(d, previous) == record['registrationTask'], 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
    migration = {}
    retained_origin = evidence.get('migrationOrigin')
    if retained_origin is not None:
        d.require(check_task and record.get('migrationOrigin') == retained_origin
                  and manifest.get('preservedMigrationOrigin') == migration_successor_marker(retained_origin),
                  'API_ADMIN_MIGRATION_ORIGIN_CHANGED')
        preserved_migration_guard(d, previous, retained_origin, retained_online)
        backup = json.loads((previous / 'backup-verification.json').read_text())
        d.require(backup.get('name') == manifest.get('backupBeforeRelease') and backup.get('s3Verified') is True
                  and type(backup.get('size')) is int and backup['size'] > 0
                  and re.fullmatch(r'[a-f0-9]{64}', backup.get('sha256', '')),
                  'API_ADMIN_MIGRATION_BACKUP_CHANGED')
        migration.update(preservedMigrationOrigin=migration_successor_marker(retained_origin),
                         migrationPreserved=True, migrationPerformed=False,
                         taskHmacMatched=True, windowPreserved=True,
                         registrationWindowRetained=True)
    if MIGRATION_MODE:
        state = migration_database_state(d, previous)
        d.require(state['status'] == 'APPLIED' and all(record['migration'][n] == state[n] for n in state)
                  and type(manifest.get('migrationPerformed')) is bool
                  and record['migration']['performed'] is manifest['migrationPerformed'],
                  'API_ADMIN_MIGRATION_READBACK_CHANGED')
        backup = json.loads((previous / 'backup-verification.json').read_text())
        d.require(backup.get('name') == manifest.get('backupBeforeRelease') and backup.get('s3Verified') is True
                  and type(backup.get('size')) is int and backup['size'] > 0
                  and re.fullmatch(r'[a-f0-9]{64}', backup.get('sha256', '')),
                  'API_ADMIN_MIGRATION_BACKUP_CHANGED')
        migration_task_guard(d, previous, record['registrationTask'], record['registrationGuards'])
        verify_migration_image(d, previous, proof)
        migration = {'migration': dict(MIGRATION_IDENTITY), 'migrationState': state,
                     'migrationApplied': True, 'migrationPerformed': manifest['migrationPerformed'],
                     'taskHmacMatched': True, 'windowPreserved': True,
                     'registrationWindowRetained': record['registrationGuards']['registrationWindowRetained']}
    return {'status': SCOPE + '_VERIFIED', 'commit': expected, 'sourceTree': proof['sourceTree'],
            'servicesUpdated': list(UPDATED), 'preservedServiceCount': 4 if WORKSPACE else 5,
            'runningImagesAndContentMatched': True, 'buildProofSha256': fingerprint(proof),
            'environmentUnchanged': True, 'services': states, **migration, **workspace}


def release(d, args):
    os.umask(0o077)
    try:
        with (d.BASE / '.deploy.lock').open('a') as lock:
            d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
            return _release_locked(d, args)
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_CONTROLLER_FAILED'
        print(json.dumps({'status': SCOPE + '_FAILED_STATE_UNVERIFIED', 'step': 'controller',
                          'code': code, 'errorType': type(error).__name__}))
        return 1


def _release_locked(d, args):
    d.require(not args.admin_only and not any(value for key, value in vars(args).items()
        if key.startswith(('historical_', 'registration_worker_', 'recharge_pro_')))
        and not any((args.image_commit, args.image_run_id, args.image_run_attempt,
                     args.post_cleanup_seal_sha256, args.order_archive_seal_sha256,
                     args.order_archive_prepared_images_sha256))
        and not (REGISTRATION and getattr(args, 'api_admin_only', False))
        and not (not REGISTRATION and getattr(args, 'api_registration_only', False))
        and not (MIGRATION_MODE and getattr(args, 'api_admin_only', False))
        and not (WORKSPACE and any((getattr(args, 'api_admin_only', False),
                                   getattr(args, 'api_registration_only', False))))
        and (getattr(args, 'api_workspace_only', False) is WORKSPACE)
        and (getattr(args, 'api_admin_migration_only', False) is MIGRATION_MODE), 'API_ADMIN_SCOPE_CONFLICT')
    d.require(all(re.fullmatch(r'[a-f0-9]{40}', value or '') for value in
                  (args.commit, args.source_tree, args.expected_current))
              and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository)
              and all(re.fullmatch(r'[1-9][0-9]*', value or '') for value in
                      (args.run_id, args.run_attempt, args.ci_run_id)), 'API_ADMIN_INPUT_INVALID')
    proof_raw = base64.b64decode(args.api_admin_build_proof, validate=True)
    d.require(len(proof_raw) < 16384, 'API_ADMIN_BUILD_PROOF_TOO_LARGE')
    proof = validate_proof(d, json.loads(proof_raw), args.commit, args.source_tree,
                          args.repository, args.run_id, args.run_attempt)
    os.umask(0o077)
    previous, old, before, evidence = baseline(d, args.expected_current)
    retained_origin = evidence.get('migrationOrigin')
    retained_online = evidence.get('onlineRechargeOrigin')
    if retained_origin is not None:
        preserved_migration_guard(d, previous, retained_origin, retained_online)
    original_task = registration_task(d, previous) if REGISTRATION or MIGRATION_MODE else None
    if MIGRATION_MODE:
        migration_task_guard(d, previous, original_task, evidence['guards'])
    migration_result = {**evidence['migrationState'], 'performed': False} if MIGRATION_MODE else None
    migration_attempted = False
    environment = (previous / '.env.aws.production').read_bytes()
    original_configuration = configuration_hashes(previous)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    target = d.BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    d.require(not target.exists(), 'API_ADMIN_RELEASE_EXISTS')
    target.mkdir(mode=0o700)
    changed, step = [], 'source'
    sqlite_gate = None
    workspace_admission = None
    workspace_database = None
    online_fence, online_changed, online_before, online_fence_proof = None, False, None, None
    try:
        with urllib.request.urlopen(f'https://github.com/wangchaozhuanyong/id-business-system/archive/{args.commit}.tar.gz', timeout=60) as response:
            data = response.read(128 * 1024 * 1024 + 1)
        d.require(len(data) <= 128 * 1024 * 1024, 'API_ADMIN_SOURCE_TOO_LARGE')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            prefix = f'id-business-system-{args.commit}/'
            d.require(all((m.name == prefix[:-1] or m.name.startswith(prefix))
                          and '..' not in Path(m.name).parts and (m.isfile() or m.isdir()) for m in archive.getmembers()),
                      'API_ADMIN_SOURCE_ARCHIVE_INVALID')
            archive.extractall(target)
        extracted = target / prefix[:-1]
        for item in extracted.iterdir():
            item.rename(target / item.name)
        extracted.rmdir()
        d.require(source_tree(d, target) == args.source_tree, 'API_ADMIN_SOURCE_TREE_CHANGED')
        if not WORKSPACE:
            d.require(not workspace_present(target), 'API_ADMIN_WORKSPACE_SCOPE_REQUIRED')
        if MIGRATION_MODE:
            migration_source_check(d, target)
        if REGISTRATION:
            d.require(all(hashlib.sha256((target / n).read_bytes()).hexdigest() == proof['workerProjection'][n]['sha256']
                          and stat.S_IMODE((target / n).stat().st_mode) in (0o644, 0o664) for n in WORKER_PAIR),
                      'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        d.require((target / 'scripts/production-release/api-admin-scope.py').read_bytes() == Path(__file__).read_bytes()
                  and (target / 'scripts/production-release/remote-deploy.py').read_bytes() == Path(d.__file__).read_bytes(),
                  'API_ADMIN_EXECUTOR_SOURCE_CHANGED')
        shutil.copy2(previous / '.env.aws.production', target / '.env.aws.production')
        override = json.loads((previous / 'compose.release.json').read_text())
        for name in IMAGE_SERVICES:
            override['services'][name] = {'image': proof['images'][name]['reference'], 'pull_policy': 'never'}
        (target / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require_preserved(d, previous, target, before, environment, all_services=True, online_context=retained_online)
        if WORKSPACE:
            d.require(proof['configuration'] == workspace_configuration(d, previous, target),
                      'API_ADMIN_WORKSPACE_CONFIG_PROOF_CHANGED')
            # Validate without mounting Caddy's live certificate/config volumes.
            # Local PKI provisioning needs disposable storage even during validate.
            try:
                d.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
                    '--tmpfs', '/data:rw,noexec,nosuid,nodev,size=16m',
                    '--tmpfs', '/config:rw,noexec,nosuid,nodev,size=16m',
                    '--mount', 'type=bind,source=' + str(target / CONFIG_FILES[1]) + ',target=/etc/caddy/Caddyfile,readonly',
                    '--env', 'APP_DOMAIN=workspace-acceptance.local', '--entrypoint', 'caddy',
                    before['caddy']['image'], 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
            except RuntimeError:
                raise RuntimeError('API_ADMIN_WORKSPACE_CADDY_VALIDATION_FAILED') from None
        if retained_origin is not None:
            preserved_migration_guard(d, target, retained_origin, retained_online)
        step = 'images'
        d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'API_ADMIN_DISK_LOW_BEFORE_PULL')
        password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
        registry = args.repository.split('/')[0]
        login = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input=password, capture_output=True, text=True)
        d.require(login.returncode == 0, 'API_ADMIN_ECR_LOGIN_FAILED')
        try:
            for name in IMAGE_SERVICES:
                row = proof['images'][name]
                d.run('docker', 'pull', row['reference'], timeout=900)
                image = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
                labels = image['Config'].get('Labels', {})
                d.require(image['Id'] == row['imageId'] and image['Architecture'] == 'amd64'
                          and labels.get('org.opencontainers.image.revision') == args.commit
                          and labels.get('id-business-v2.source-tree') == args.source_tree, 'API_ADMIN_IMAGE_PROVENANCE_FAILED')
        finally:
            subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
        d.require(shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'API_ADMIN_DISK_LOW')
        if MIGRATION_MODE:
            verify_migration_image(d, target, proof, inspect_content=True)
        step = 'audit-before'
        first = strict_audit(d, target, target / 'before-audit.json')
        step = 'backup'
        backup = d.fresh_backup(previous)
        (target / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous and
                  hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest() == evidence['manifestSha256'],
                  'API_ADMIN_BASELINE_MOVED')
        require_preserved(d, previous, target, before, environment, all_services=True, online_context=retained_online)
        jobs_idle(d, previous)
        if WORKSPACE:
            workspace_idle(d, previous, legacy='sqliteProtectionSha256' not in old.get('apiWorkspacePublication', {}))
        if retained_origin is not None:
            preserved_migration_guard(d, target, retained_origin, retained_online)
        if MIGRATION_MODE:
            step = 'migration'
            migration_task_guard(d, previous, original_task, evidence['guards'])
            migration_attempted = migration_result['status'] == 'PENDING'
            migration_result = apply_migration(d, target)
            require_preserved(d, previous, target, before, environment, all_services=True, online_context=retained_online)
            migration_task_guard(d, previous, original_task, evidence['guards'])
        step = 'switch'
        for name in SWITCH_ORDER:
            require_preserved(d, previous, target, before, environment, online_context=retained_online)
            if retained_origin is not None:
                preserved_migration_guard(d, target, retained_origin, retained_online)
            if MIGRATION_MODE:
                migration_task_guard(d, previous, original_task, evidence['guards'])
            if name == 'api' or REGISTRATION:
                jobs_idle(d, previous)
                if WORKSPACE:
                    step = 'sqlite-protection'
                    workspace_database = workspace_database_identity(d, previous)
                    if 'sqliteProtectionSha256' not in old.get('apiWorkspacePublication', {}):
                        workspace_admission = WorkspaceAuditBarrier(d, previous)
                        workspace_admission.acquire()
                    sqlite_gate = workspace_prepare(d, previous, target, proof, args, evidence,
                        legacy='sqliteProtectionSha256' not in old.get('apiWorkspacePublication', {}))
                    step = 'switch'
                if REGISTRATION:
                    require_registration_handoff(d, previous, old)
                    d.require(registration_task(d, previous) == original_task, 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
            if WORKSPACE and name == 'caddy':
                workspace_idle(d, target)
            if WORKSPACE and name == 'api' and retained_online is not None:
                online_idle(d, previous)
                online_before = online_binding(d, previous, before)
                online_fence = OnlineSqlFence(d, previous)
                online_fence.acquire()
                if workspace_admission is not None:
                    workspace_admission.before_stop()
                changed.append(name)
                online_changed = True
                if sqlite_gate is not None:
                    sqlite_gate.stop_previous()
                    online_fence.check_idle()
                else:
                    online_fence.stop(before['api'], grace=30)
                if workspace_admission is not None:
                    workspace_admission.check_idle()
                    workspace_admission.close()
                online_fence.stop(before[ONLINE_SERVICE], grace=45)
                online_fence_proof = {'version': 1, 'busyCount': 0, 'sameConnection': True,
                    'mysqlIdentitySha256': fingerprint(online_fence.mysql),
                    'connectionIdSha256': fingerprint(online_fence.connection_id), 'businessActions': 0}
                online_fence.close()
            elif WORKSPACE and name == 'api' and sqlite_gate is not None:
                # The old singleton must actually stop before releasing its writer fence.
                if workspace_admission is not None:
                    workspace_admission.before_stop()
                changed.append(name)
                sqlite_gate.stop_previous()
                if workspace_admission is not None:
                    workspace_admission.check_idle()
                    workspace_admission.close()
            elif WORKSPACE and name == 'api' and workspace_admission is not None:
                workspace_admission.before_stop()
                changed.append(name)
                workspace_admission.stop(before['api'], grace=30)
                workspace_admission.close()
            else:
                changed.append(name)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', name, timeout=300)
            d.wait_healthy(target, name)
            if WORKSPACE and name == 'api' and retained_online is not None:
                online_rebind(d, target, retained_online)
        step = 'audit-after'
        second = strict_audit(d, target, target / 'after-audit.json')
        d.require(first['checksSha256'] == second['checksSha256'], 'API_ADMIN_AUDIT_RULES_CHANGED')
        verify_running(d, target, proof)
        after = require_preserved(d, previous, target, before, environment, online_context=retained_online)
        public = d.environment_values(target / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        for suffix in ('/api/health/ready', '/'):
            with urllib.request.urlopen(public + suffix, timeout=20) as response:
                d.require(response.status == 200, 'API_ADMIN_PUBLIC_HEALTH_FAILED')
                if WORKSPACE and suffix == '/':
                    policy = re.search(r'Content-Security-Policy "([^"]+)"', (target / CONFIG_FILES[1]).read_text())
                    d.require(policy is not None and response.headers.get('Content-Security-Policy') == policy.group(1),
                              'API_ADMIN_WORKSPACE_PUBLIC_EDGE_CHANGED')
        after = require_preserved(d, previous, target, before, environment, online_context=retained_online)
        record = {'before': before, 'after': after, 'environmentSha256': evidence['environmentSha256'],
                  'baselineEvidence': evidence, 'buildProofSha256': fingerprint(proof),
                  'configurationBefore': configuration_hashes(previous), 'configurationAfter': configuration_hashes(target)}
        if REGISTRATION or MIGRATION_MODE:
            d.require(registration_task(d, target) == original_task, 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
            record['registrationTask'] = original_task
        if MIGRATION_MODE:
            migration_task_guard(d, target, original_task, evidence['guards'])
            record.update(registrationGuards=evidence['guards'], migration=migration_result)
        if retained_origin is not None:
            preserved_migration_guard(d, target, retained_origin, retained_online)
            record['migrationOrigin'] = retained_origin
        if retained_online is not None:
            online_origin_guard(d, target, retained_online)
            record.update(onlineRechargeOrigin=retained_online,
                onlineNetworkRebind={'version': 1, 'before': online_before,
                    'after': online_binding(d, target, after), 'sqlFence': online_fence_proof, 'businessActions': 0})
        if WORKSPACE:
            record.update(workspaceVolumeBefore=evidence['workspaceVolume'],
                          workspaceVolumeAfter=workspace_volume(d, target, attached=True))
            if sqlite_gate is not None:
                record['sqliteProtectionSha256'] = fingerprint(sqlite_gate.record)
        (target / STATE_FILE).write_text(json.dumps(record, indent=2) + '\n')
        (target / PROOF_FILE).write_text(json.dumps(proof, indent=2) + '\n')
        manifest = {'images': old['images'],
                    'previousManifestSha256': evidence['manifestSha256']}
        manifest.update(commit=args.commit, sourceBranch='main', sourceTree=args.source_tree,
            previousCommit=args.expected_current, previousRelease=str(previous),
            releaseTag=f'v2-production-{stamp}', deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id),
            deploymentRun=f'github-actions-{args.run_id}-{args.run_attempt}',
            imageBuildRun=f'github-actions-{args.run_id}-{args.run_attempt}',
            servicesUpdated=list(UPDATED), sourceArchiveSha256=hashlib.sha256(data).hexdigest(),
            images={**old['images'], **{name: {'reference': proof['images'][name]['reference'],
                'digest': proof['images'][name]['imageId'], 'sourceCommit': args.commit} for name in IMAGE_SERVICES}},
            backupBeforeRelease=backup['name'], migrationApplied=MIGRATION_MODE,
            newMigrations=[MIGRATION_FILE] if MIGRATION_MODE else [],
            dataAuditBefore=first, dataAuditAfter=second,
            databaseGrants={'status': 'SKIPPED', 'reason': 'API_ADMIN_EXISTING_TABLE_COLUMN_INDEX' if MIGRATION_MODE else 'API_ADMIN_UNCHANGED_SCHEMA'},
            rollback={'release': str(previous), 'images': {name: before[name]['image'] for name in UPDATED}, 'servicesAdded': []},
            **{'apiAdminMigrationPublication' if MIGRATION_MODE else 'apiRegistrationPublication' if REGISTRATION else 'apiWorkspacePublication' if WORKSPACE else 'apiAdminPublication':
                {'version': 1, 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                 'workersPublished': REGISTRATION, 'cacheStatus': 'SKIPPED', 'configurationChanged': WORKSPACE,
                 **({'volume': record['workspaceVolumeAfter'], 'volumeDeletionPerformed': False,
                     **({'sqliteProtectionSha256': record['sqliteProtectionSha256']} if sqlite_gate is not None else {})} if WORKSPACE else {}),
                 **({'schemaChanged': True, 'migration': dict(MIGRATION_IDENTITY)} if MIGRATION_MODE else {})}})
        if retained_online is not None:
            manifest['preservedOnlineRechargeOrigin'] = online_marker(retained_online)
        if MIGRATION_MODE:
            manifest['migrationPerformed'] = migration_result['performed']
        if retained_origin is not None:
            manifest['preservedMigrationOrigin'] = migration_successor_marker(retained_origin)
        (target / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_MOVED')
        d.point_current(target, f'{stamp}-publish')
        result = readback(d, args.commit)
        if sqlite_gate is not None:
            sqlite_gate.finish()
        result.update(backupVerified=True, checkCount=49, violationCount=0)
        print(json.dumps(result))
        return 0
    except Exception as error:
        if workspace_admission is not None:
            workspace_admission.close()
        if online_fence is not None:
            online_fence.close()
        if sqlite_gate is None:
            sqlite_gate = getattr(error, 'sqlite_gate', None)
        if sqlite_gate is not None:
            sqlite_gate.close()
        if MIGRATION_MODE and migration_attempted:
            try:
                observed = migration_database_state(d, target)
                migration_result = {**observed, 'performed': observed['status'] == 'APPLIED'}
            except Exception:
                migration_result = {'status': 'UNVERIFIED', 'performed': None}
        # A new task may start after the last idle read. Do not interrupt it to
        # force rollback. Keep an explicit partial-state receipt for recovery.
        rollback_ok = True
        rollback = {}
        rollback_controller = (workspace_database_controller(d, target, workspace_database)
            if WORKSPACE and workspace_database is not None else d)
        for name in reversed(changed):
            try:
                if retained_origin is not None:
                    preserved_migration_guard(rollback_controller, target, retained_origin, retained_online)
                if name == 'api' or REGISTRATION or MIGRATION_MODE:
                    jobs_idle(d, target, **({'database_identity': workspace_database}
                        if WORKSPACE and workspace_database is not None else {}))
                    if WORKSPACE:
                        workspace_idle(d, target, **({'api_metadata': workspace_api_metadata(d, target)}
                            if workspace_database is not None else {}))
                        if sqlite_gate is not None:
                            sqlite_gate.check_marker()
                            workspace_private_inspect(d, target, proof['images']['api']['reference'],
                                sqlite_gate.volume['name'], expected=sqlite_gate.summary['logicalSha256'])
                if MIGRATION_MODE:
                    d.require(jobs_idle(d, target) == evidence['guards'], 'API_ADMIN_REGISTRATION_TASK_CHANGED')
                    registration_private(d, target, retained=evidence['guards']['registrationWindowRetained'])
                if name == 'api' and retained_online is not None and online_changed:
                    online_rollback_api(d, previous, target, before, proof, retained_online,
                        **({'database_identity': workspace_database} if workspace_database is not None else {}))
                    rollback[ONLINE_SERVICE] = 'REBOUND_ORIGINAL_IMAGE'
                else:
                    d.rollback_service(previous, target, name, before)
                rollback[name] = 'RESTORED'
            except Exception:
                rollback[name] = 'BLOCKED_OR_FAILED'
                rollback_ok = False
        if rollback_ok:
            try:
                restored = snapshot(d, previous)
                d.require((previous / '.env.aws.production').read_bytes() == environment
                          and configuration_hashes(previous) == original_configuration
                          and all(restored[name] == before[name] for name in before
                              if name not in (*UPDATED, *((ONLINE_SERVICE,) if retained_online is not None else ())))
                          and all(restored[name]['image'] == before[name]['image']
                                  and restored[name]['reference'] == before[name]['reference'] for name in UPDATED),
                          'API_ADMIN_ROLLBACK_NOT_RESTORED')
                if retained_online is not None:
                    online_binding(d, previous, restored)
                if MIGRATION_MODE:
                    migration_task_guard(d, previous, original_task, evidence['guards'])
                if retained_origin is not None:
                    preserved_migration_guard(d, previous, retained_origin, retained_online)
            except Exception:
                rollback_ok = False
        if sqlite_gate is not None and rollback_ok:
            try:
                sqlite_gate.abort()
            except Exception:
                rollback_ok = False
        if rollback_ok and (d.BASE / 'current').resolve() == target:
            try:
                d.point_current(previous, f'{stamp}-recover')
            except Exception:
                rollback_ok = False
        if MIGRATION_MODE and migration_result['status'] == 'UNVERIFIED':
            rollback_ok = False
        actual = {}
        for name in workspace_service_names(d, previous):
            try:
                actual[name] = d.service_state(previous, name, include_container_id=True,
                                               include_environment_hash=True)
            except Exception:
                actual[name] = {'status': 'UNAVAILABLE'}
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_STEP_FAILED'
        result = {'status': SCOPE + '_FAILED_RESTORED' if changed and rollback_ok
                  else SCOPE + '_FAILED_BEFORE_SWITCH' if not changed and rollback_ok else SCOPE + '_PARTIAL_RECOVERY_REQUIRED',
                  'step': step, 'code': code, 'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                  'servicesAttempted': changed, 'rollback': rollback, 'actualServices': actual,
                  'candidateCommit': args.commit, 'previousCommit': args.expected_current,
                  'currentPointsToCandidate': (d.BASE / 'current').resolve() == target}
        if retained_online is not None:
            result.update(servicesReboundAttempted=[ONLINE_SERVICE] if online_changed else [],
                          preservedOnlineRechargeOrigin=online_marker(retained_online))
        if WORKSPACE:
            result.update(volumeDeletionPerformed=False, sqliteBackupStatus=(
                'VERIFIED_RESTORE' if sqlite_gate is not None and sqlite_gate.record is not None
                else 'INCOMPLETE_PROOF' if sqlite_gate is not None else 'NOT_SWITCHED_OR_EMPTY_VOLUME'))
        result['receiptPersisted'] = True
        if MIGRATION_MODE:
            result.update(migration=migration_result,
                migrationApplied=None if migration_result['status'] == 'UNVERIFIED' else migration_result['status'] == 'APPLIED',
                migrationPerformed=migration_result['performed'], migrationAttempted=migration_attempted,
                inverseMigrationPerformed=False)
        try:
            (target / FAILURE_FILE).write_text(json.dumps(result, indent=2) + '\n')
        except Exception:
            result['receiptPersisted'] = False
        print(json.dumps(result))
        return 1


def registration_cli(d, tokens):
    try:
        operation = tokens[0]
        if tokens == ['--write-api-registration-build-proof']:
            build_proof(d)
            return 0
        if tokens == ['--prepare-api-registration-build']:
            result = prepare_registration_build(d)
            print(json.dumps({'status': 'API_REGISTRATION_CONTEXT_PROVEN',
                              'workerProjectionSha256': result['workerProjectionSha256']}))
            return 0
        d.require(len(tokens) == 3 and tokens[1] == '--expected-current'
                  and re.fullmatch(r'[a-f0-9]{40}', tokens[2]), 'API_ADMIN_INPUT_INVALID')
        if operation == '--api-registration-readback':
            result = readback(d, tokens[2])
        elif operation == '--api-registration-business':
            result = registration_business(d, tokens[2])
        elif operation == '--api-registration-handoff':
            result = registration_handoff(d, tokens[2])
        elif operation in ('--api-registration-handoff-observe', '--api-registration-handoff-recover'):
            result = registration_handoff_recovery(d, tokens[2], recover=operation.endswith('-recover'))
        else:
            d.require(operation in ('--api-registration-preflight', '--api-registration-verify'), 'API_ADMIN_INPUT_INVALID')
            result = registration_preflight(d, tokens[2], require_closed=operation.endswith('-preflight'))
        print(json.dumps(result))
        return 0
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_REGISTRATION_READ_UNAVAILABLE'
        result = {'status': 'API_REGISTRATION_VERIFICATION_FAILED', 'code': code, 'errorType': type(error).__name__}
        if isinstance(error, RegistrationHandoffError):
            result['privateDiagnostic'] = error.diagnostic
        if isinstance(error, RegistrationRecoveryError):
            result['recoveryDiagnostic'] = error.diagnostic
        print(json.dumps(result))
        return 1
