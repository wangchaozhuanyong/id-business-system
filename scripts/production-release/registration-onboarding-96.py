"""Finite registration96 definitions and an explicitly gated I/O adapter.

Default CLI execution performs zero I/O. Only frozen reviewed pins can enable
the adapter; its low-level capabilities come from the verified controller.
Synthetic frozen contexts test definitions without becoming actual evidence.
Deployment commit/tree/run/archive hashes are runtime inputs, never values to
write into their own source commit or profile.
"""
import hashlib
import json
import re
import sys
import base64
import os
import stat
import time
import fcntl
import subprocess
import gzip
import zlib
from pathlib import Path
from datetime import datetime, timezone


PROFILE_ID = 'registration-worker-96-20261008'
ENABLED = True
BASELINE_SCHEMA_SHA256 = 'b6767c8e65df5f7fbab1873770c2185692f1dca24f03f8d1accca22f4e2cecb5'
FORMAL_BASELINE_SHA256 = '41007c7c7cf525c65f50297a87c9e9a986503cbb2c023ac8b57fb1de675d6434'
FINAL_SOURCE_PAIR_SHA256 = '438a131c2005465cb55cf07fd72e0b0f882b61bff6c1740200f459195aed1ea9'
HANDOFF_SHA256 = '32b03f92066f1fcc5316c1aafbb626fd8d7365f044891f7e21235840f02a4275'
CARRIER_MAX_BYTES = 1024 * 1024
MODULE_MAX_BYTES = PROFILE_MAX_BYTES = 128 * 1024
BASELINE_MAX_BYTES = 4 * 1024 * 1024
BASELINE_CARRIER_FILE = 'deploy/aws/registration-baseline-96-20261008.json'
WORKER_PREFIX = 'apps/api/src/id-business-v2/auto-recharge/worker/'
SOURCE_PAIR = frozenset(WORKER_PREFIX + name for name in (
    'registration_browser.py', 'test_registration_browser.py'))
TASK_ID = '252ab243-d96b-4928-8116-b83dedc1d240'
TASK_ATTEMPT = 9
OLD_HANDOFF_SHA256 = '9cafed1290e22214cf09459ba019b0a544190af32497ff225a7313e72b4a0bf3'
BASELINE_KEYS = frozenset('''version status readOnly databaseWrites windowRestarted runtimeStable
current commit sourceTree deploymentRun formalProducerEvidenceSha256 controllerSha256
profileRawSha256 profileCanonicalSha256 manifest manifestRawSha256 manifestCanonicalSha256
fileSha256 publicSourceMap liveServices actualRegistrationWorkerSourceSha256
actualRechargeWorkerSourceSha256 actualApiCompiledSourceSha256 apiAdminContentProof
audits workerHealth taskReadOnly officialOtpAccepted businessAcceptanceConfirmed
historicalChainReexecuted'''.split())
SOURCE_BINDING_KEYS = frozenset(('runtimeCommit', 'candidateCommit', 'registrationImageRevision',
    'baselineReceiptSha256', 'registrationProjectionSha256', 'rechargeProjectionSha256'))
HANDOFF_KEYS = frozenset(('receiptSha256', 'taskId', 'attempt', 'registered',
    'passwordLoginVerified', 'mfaLoginVerified', 'windowExists', 'leaseActive', 'busy'))


class Registration96Error(RuntimeError):
    """Only fixed reason codes can leave these pure checks."""


def require(condition, reason):
    if not condition:
        raise Registration96Error(reason)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def digest(value, length=64):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{' + str(length) + '}', value) is not None


def checked_bytes(value, limit):
    require(type(limit) is int and limit > 0 and type(value) is bytes
        and 0 < len(value) <= limit, 'BYTES_INVALID')
    return value


def carrier_bytes(value):
    return checked_bytes(value, CARRIER_MAX_BYTES)


def module_bytes(value):
    return checked_bytes(value, MODULE_MAX_BYTES)


def profile_bytes(value):
    return checked_bytes(value, PROFILE_MAX_BYTES)


def closed_json(raw, *, limit=BASELINE_MAX_BYTES):
    checked_bytes(raw, limit)
    def unique(items):
        result = {}
        for name, value in items:
            require(name not in result, 'JSON_INVALID')
            result[name] = value
        return result
    def constant(_value):
        raise Registration96Error('JSON_INVALID')
    try:
        result = json.loads(raw, object_pairs_hook=unique, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise Registration96Error('JSON_INVALID') from None
    require(type(result) is dict, 'JSON_INVALID')
    return result


def validate_baseline(raw, frozen=None):
    require(raw is not None, 'BASELINE_MISSING')
    value = closed_json(raw)
    require(set(value) == BASELINE_KEYS, 'BASELINE_FIELDS_INVALID')
    require(type(value['version']) is int and value['version'] == 1
        and value['status'] == 'FINITE_POSTPRO_OBSERVED'
        and value['readOnly'] is True and value['windowRestarted'] is False
        and value['runtimeStable'] is True and value['historicalChainReexecuted'] is False
        and type(value['databaseWrites']) is int and value['databaseWrites'] == 0,
        'BASELINE_SAFETY_INVALID')
    require(frozen is not None, 'BASELINE_SCHEMA_UNFROZEN')
    context = validate_frozen(frozen)
    require(sha256(raw) == context['baselineRawSha256']
        and canonical_sha256(value) == context['baselineCanonicalSha256'], 'BASELINE_RECEIPT_CHANGED')
    return validate_finite_record(value, context)


def check_source_roles(value, frozen):
    require(type(value) is dict and type(frozen) is dict
        and set(value) == set(frozen) == SOURCE_BINDING_KEYS, 'SOURCE_BINDINGS_INVALID')
    for name in SOURCE_BINDING_KEYS:
        length = 40 if name.endswith('Commit') or name == 'registrationImageRevision' else 64
        require(digest(value[name], length) and digest(frozen[name], length),
            'SOURCE_BINDINGS_INVALID')
    require(value == frozen, 'SOURCE_BINDINGS_CHANGED')
    require(value['runtimeCommit'] != value['candidateCommit']
        and value['registrationProjectionSha256'] != value['rechargeProjectionSha256'],
        'SOURCE_ROLES_CONFUSED')
    return dict(value)


def check_handoff(value):
    require(type(value) is dict and set(value) == HANDOFF_KEYS, 'HANDOFF_FIELDS_INVALID')
    require(digest(value['receiptSha256']) and value['receiptSha256'] != OLD_HANDOFF_SHA256
        and value['taskId'] == TASK_ID and type(value['attempt']) is int
        and value['attempt'] == TASK_ATTEMPT and value['registered'] is True,
        'HANDOFF_NOT_CURRENT')
    require(all(type(value[name]) is bool for name in (
        'passwordLoginVerified', 'mfaLoginVerified', 'windowExists', 'leaseActive', 'busy'))
        and value['windowExists'] is False and value['leaseActive'] is False and value['busy'] is False,
        'HANDOFF_NOT_IDLE')
    return dict(value)


def worker_delta(actual95, sealed95, candidate_pair):
    """Compare measured flat60 with sealed rows before changing the exact pair.

    The actual95 input is the finite collector's observed registration hash map,
    never the Pro hash map or a projected current-main directory. The caller
    must supply a separately frozen actual receipt before any future enabling.
    """
    require(type(actual95) is dict and type(sealed95) is dict and len(sealed95) == 60
        and type(candidate_pair) is dict and set(candidate_pair) == SOURCE_PAIR,
        'WORKER_INPUT_INVALID')
    expected = {}
    for name, row in sealed95.items():
        require(type(name) is str and name.startswith(WORKER_PREFIX)
            and re.fullmatch(r'[A-Za-z0-9_.-]+', name.removeprefix(WORKER_PREFIX)) is not None
            and '..' not in name.removeprefix(WORKER_PREFIX)
            and type(row) is dict and set(row) == {'mode', 'sha256'}
            and type(row['mode']) is str and row['mode'] in {'100644', '100755'}
            and digest(row['sha256']), 'WORKER_SEAL_INVALID')
        expected[name.removeprefix(WORKER_PREFIX)] = row['sha256']
    require(SOURCE_PAIR <= set(sealed95) and set(actual95) == set(expected)
        and all(digest(value) for value in actual95.values()) and actual95 == expected,
        'WORKER_ACTUAL95_MISMATCH')
    result = {name: dict(row) for name, row in sealed95.items()}
    for name, pair in candidate_pair.items():
        require(type(pair) is tuple and len(pair) == 2 and type(pair[0]) is bytes
            and 0 < len(pair[0]) <= 8 * 1024 * 1024 and pair[1] == sealed95[name]['mode'] == '100644',
            'WORKER_PAIR_INVALID')
        result[name] = {'mode': pair[1], 'sha256': sha256(pair[0])}
    require({name for name in sealed95 if result[name] != sealed95[name]} == SOURCE_PAIR,
        'WORKER_DELTA_INVALID')
    return result


SERVICES = frozenset(('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'mysql', 'caddy'))
STATE_KEYS = frozenset(('containerId', 'image', 'reference', 'status', 'health',
    'startedAtSha256', 'environmentSha256', 'configurationSha256'))
AUDIT_OVERRIDE = 'registration-recovery-audit.compose.json'
NODE_PRIVATE_FILES = frozenset(('before-audit.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'))
PRIVATE_FILES = frozenset(('.env.aws.production', 'compose.release.json', 'release-manifest.json',
    'before-audit.json', 'after-audit.json', 'backup-verification.json', 'order-archive-seal.reader.json',
    'order-archive-cleanup.reader.json', 'registration-recovery-audit.compose.json',
    'api-admin-build-proof.json', 'api-admin-preservation.json'))
PUBLIC_BASE = frozenset(('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
    'apps/api/prisma-mysql/schema.prisma', 'deploy/aws/registration-worker-95-20261008.json',
    'scripts/production-release/registration-interstitial-95.py', 'scripts/production-release/api-admin-scope.py',
    'scripts/v2-registration-finance-audit.mjs'))
REGISTRATION_SOURCE_COMMIT = '3d71a44b30a798110d43c8b943d3f2cbac99efa9'
REGISTRATION_SOURCE_SHA256 = {
    WORKER_PREFIX + 'registration_browser.py': '6beec99bb17be46890e2e105c935b59ec1dff066a21f164b266fcf4c5b914c40',
    WORKER_PREFIX + 'test_registration_browser.py': '6ceff54be34e6271acc2c4d3428d5c5871ae0ac6f4efcb9e4492c0858ad9e5a0'}
WORKER_BASIS_COMMIT = '2f24cf81007429ea474da404a30bc74da9d43ce1'
CARRIED_SOURCE_COMMITS = {WORKER_PREFIX + n: commit for commit, names in (
    ('b8d643450ffa9012ccc09ead15e4681e3dee98d0', ('plan_selection.py', 'server.py', 'test_pro.py', 'test_server.py', 'test_worker_isolation.py')),
    ('8dd12f19b1dc5187facdb070c7b644ca1221ee59', ('test_registration.py', 'test_registration_builtin.py')))
    for n in names}
CURRENT_COMMIT = '04570d75c779fd91a0933ef9416f6d62698b6b91'
CURRENT_TREE = 'ef923b2152b85ee8395f3bb4b93eac711bdbe3d7'
PREVIOUS_COMMIT = '6f5e5cc252886d5f86592e307147b40c13577585'
PREVIOUS_DIRECTORY = '/opt/id-business-v2/releases/20261007T185401Z-6f5e5cc25288'
PROFILE_FILE = 'deploy/aws/' + PROFILE_ID + '.json'
CONTROL_FILES = frozenset(('scripts/production-release/registration-onboarding-96.py',
    'scripts/production-release/registration-onboarding-96.test.py', 'scripts/production-release/remote-deploy.py',
    '.github/workflows/production-release.yml', 'scripts/production-release/build-images.sh',
    'scripts/production-release/push-images.sh', 'scripts/production-release/dispatch.sh',
    'scripts/production-release/validate-release-selection.sh', 'scripts/production-release/registration-only-transport.test.py',
    'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-release.test.mjs'))
PARAMETER_KEYS = frozenset(('current', 'commit', 'tree', 'run', 'controllerSha256'))
TASK_BINDING_KEYS = frozenset(('taskId', 'attempt', 'sinceUtc', 'acceptedAt', 'profileBoundAt',
    'profileSha256', 'accountSha256'))
CANDIDATE_KEYS = frozenset(('commit', 'tree', 'run', 'ciRunId', 'archiveSha256'))
FROZEN_KEYS = frozenset(('version', 'schemaSha256', 'baselineCarrierSha256', 'baselineRawSha256', 'baselineCanonicalSha256',
    'formalProducerEvidenceSha256', 'parameters', 'baseline95', 'baseline95CanonicalSha256',
    'proProfile', 'proProfileRawSha256', 'proProfileCanonicalSha256', 'sealed95WorkerProjection',
    'taskBinding', 'handoff', 'registrationSourceCommit', 'registrationSourceSha256',
    'buildInputSha256', 'candidate', 'controlSourceSha256', 'sourceModes', 'financeFrozen'))
MANIFEST_KEYS = frozenset(('backupBeforeRelease', 'ciWorkflow', 'ciWorkflowRunId', 'commit',
    'dataAuditAfter', 'dataAuditBefore', 'databaseGrants', 'deployedAt', 'deploymentRun',
    'fixedRechargePreservedStates', 'fixedRechargeRelease', 'fixedRegistrationPreservedStates',
    'fixedRegistrationRelease', 'imageBuildRun', 'images', 'migrationApplied', 'newMigrations',
    'previousCommit', 'previousManifestSha256', 'previousRelease', 'releaseTag', 'rollback',
    'servicesUpdated', 'sourceArchiveSha256', 'sourceBranch', 'sourceTree'))
AUDIT_KEYS = frozenset(('rawSha256', 'checkCount', 'violationCount', 'checksSha256', 'identitySha256', 'gateSha256'))
HEALTH_KEYS = frozenset(('ready', 'registrationBusy', 'registrationWindowRetained', 'workerRole', 'engine', 'mailDeliveryVersion'))
API_COMPILED_FILES = frozenset('apps/api/dist/id-business-v2/auto-registration/' + n for n in (
    'registration-events.service.js', 'registration-jobs.service.js', 'registration-validation.js', 'registration-worker.js'))
TASK_KEYS = frozenset(('id', 'attempt', 'state', 'step', 'reason', 'registered', 'passwordVerified',
    'mfaVerified', 'updatedAt', 'leaseUntil', 'windowBound', 'accountBound'))
TASK_STATES = frozenset(('queued', 'running', 'awaiting_email', 'awaiting_user', 'partial', 'completed', 'cancelled'))
TASK_STEPS = frozenset(('queued', 'email', 'email_code', 'profile', 'registered', 'password',
    'password_verified', 'mfa', 'mfa_verified', 'offer', 'completed'))
TASK_REASONS = frozenset(('mailbox_timeout', 'durable_state_unavailable', 'form_unrecognized', 'verification_required',
    'session_load_timeout', 'session_network_error', 'registration_page_changing', 'official_login_not_verified',
    'official_identity_mismatch', 'builtin_execution_failed', 'browser_window_lost', 'operation_cancelled',
    'proxy_retry_exhausted', 'proxy_resolving', 'proxy_verifying', 'proxy_retrying', 'proxy_ready',
    'registered_profile_recovery_pending', 'registration_result_unknown', 'password_not_verified', 'mfa_not_verified'))
READBACK_KEYS = frozenset(('version', 'status', 'readOnly', 'runtimeStable', 'current', 'previous',
    'commit', 'sourceTree', 'deploymentRun', 'profileRawSha256', 'moduleSha256', 'manifest',
    'manifestRawSha256', 'manifestCanonicalSha256', 'publicSourceMap', 'fileSha256', 'liveServices',
    'actualRegistrationWorkerSourceSha256', 'actualRechargeWorkerSourceSha256',
    'actualApiCompiledSourceSha256', 'apiAdminContentProof', 'auditReports', 'workerHealth',
    'imageMetadata', 'configurationProof', 'backup', 'officialOtpAccepted', 'businessAcceptanceConfirmed'))


def canonical_sha256(value, *, ascii=True):
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=ascii, allow_nan=False).encode())


def clone(value):
    return json.loads(json.dumps(value, allow_nan=False))


def private_json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def private_json_sha256(value):
    return sha256(private_json_bytes(value))


def keys(value, expected, reason):
    require(type(value) is dict and set(value) == set(expected), reason)
    return value


def iso(value):
    return type(value) is str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', value) is not None


def safe_name(name):
    return type(name) is str and 0 < len(name) <= 512 and not name.startswith('/') and '\\' not in name \
        and all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) and part not in ('', '.', '..') for part in name.split('/'))


def release_directory(value, commit):
    return type(value) is str and digest(commit, 40) and re.fullmatch(
        r'/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-' + commit[:12], value) is not None


def hash_map(value, *, names=None, cap=5000):
    require(type(value) is dict and 0 < len(value) <= cap and (names is None or set(value) == set(names))
        and all(safe_name(n) and digest(h) for n, h in value.items()), 'SOURCE_MAP_INVALID')
    return value


def validate_states(value):
    keys(value, SERVICES, 'SERVICE_FIELDS_INVALID')
    for service, row in value.items():
        keys(row, STATE_KEYS, 'SERVICE_FIELDS_INVALID')
        require(all(digest(row[n]) for n in ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
            and type(row['image']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', row['image'])
            and type(row['reference']) is str and re.fullmatch(r'[A-Za-z0-9./:@_-]{1,512}', row['reference'])
            and row['status'] == 'running' and (row['health'] is None if service == 'caddy' else row['health'] == 'healthy'),
            'SERVICE_STATE_INVALID')
    return value


def validate_health(value, *, idle=False):
    keys(value, HEALTH_KEYS, 'HEALTH_FIELDS_INVALID')
    require(value['ready'] is True and type(value['registrationBusy']) is bool
        and type(value['registrationWindowRetained']) is bool and value['workerRole'] == 'registration'
        and value['engine'] == 'camoufox' and type(value['mailDeliveryVersion']) is int
        and value['mailDeliveryVersion'] == 1, 'HEALTH_INVALID')
    require(not idle or (value['registrationBusy'] is False and value['registrationWindowRetained'] is False),
        'REGISTRATION_NOT_IDLE')
    return value


def configuration_sha256(inspect):
    require(type(inspect) is dict and type(inspect.get('Config')) is dict
        and type(inspect.get('HostConfig')) is dict and type(inspect.get('Mounts')) is list,
        'CONFIGURATION_INVALID')
    mounts = inspect['Mounts']
    require(all(type(m) is dict and type(m.get('Destination')) is str
        and m['Destination'].startswith('/') for m in mounts)
        and len({m['Destination'] for m in mounts}) == len(mounts), 'CONFIGURATION_INVALID')
    return canonical_sha256({'Config': inspect['Config'], 'HostConfig': inspect['HostConfig'],
        'Mounts': sorted(mounts, key=lambda m: m['Destination'])})


def validate_frozen(value):
    require(value is not None, 'FROZEN_BINDINGS_MISSING')
    keys(value, FROZEN_KEYS, 'FROZEN_FIELDS_INVALID')
    require(type(value['version']) is int and value['version'] == 1
        and all(digest(value[n]) for n in ('schemaSha256', 'baselineCarrierSha256', 'baselineRawSha256', 'baselineCanonicalSha256',
            'formalProducerEvidenceSha256', 'baseline95CanonicalSha256', 'proProfileRawSha256', 'proProfileCanonicalSha256')),
        'FROZEN_BINDINGS_INVALID')
    p = keys(value['parameters'], PARAMETER_KEYS, 'FROZEN_PARAMETERS_INVALID')
    require(p['commit'] == CURRENT_COMMIT and p['tree'] == CURRENT_TREE and release_directory(p['current'], CURRENT_COMMIT)
        and type(p['run']) is str and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', p['run'])
        and digest(p['controllerSha256']), 'FROZEN_PARAMETERS_INVALID')
    old, pro = value['baseline95'], value['proProfile']
    require(type(old) is dict and canonical_sha256(old, ascii=False) == value['baseline95CanonicalSha256']
        and old.get('status') == 'VERIFIED_95_RUNTIME_BASELINE' and old.get('readOnly') is True
        and old.get('runtimeStable') is True and old.get('windowRestarted') is False
        and type(old.get('databaseWrites')) is int and old['databaseWrites'] == 0
        and old.get('current') == PREVIOUS_DIRECTORY and old['manifest']['commit'] == PREVIOUS_COMMIT,
        'ACTUAL95_BINDING_INVALID')
    validate_states(old['liveServices'])
    hash_map(old['actualApiCompiledSourceSha256'], names=API_COMPILED_FILES)
    proof = old['apiRuntimeProof']
    require(type(proof) is dict and proof.get('revision') == '815fae391b172d6c368ea2ad25225f52a1272808'
        and proof.get('sourceTree') == '3a814394a45ff3422907501ff22d5d994eed3545'
        and type(proof.get('buildProof')) is dict
        and proof['buildProof'].get('commit') == proof['revision'] and proof['buildProof'].get('sourceTree') == proof['sourceTree']
        and canonical_sha256(proof['buildProof']) == proof.get('buildProofCanonicalSha256'), 'API815_BINDING_INVALID')
    hash_map(old['actualRegistrationWorkerSourceSha256'], cap=60)
    require(len(old['actualRegistrationWorkerSourceSha256']) == 60, 'ACTUAL95_BINDING_INVALID')
    require(type(pro) is dict and canonical_sha256(pro) == value['proProfileCanonicalSha256']
        and pro.get('id') == 'recharge-pro-6f5-20261008' and pro.get('enabled') is True
        and pro.get('approvalStatus') == 'APPROVED' and pro['scope']['servicesUpdated'] == ['auto-recharge']
        and pro['scope']['registrationRestartAllowed'] is False, 'PRO_BINDING_INVALID')
    require(pro['baselineRelease']['manifestSha256'] == old['fileSha256']['release-manifest.json']
        and pro['nativeBaseline']['registrationProfileRawSha256'] == old['profileSha256']
        and pro['nativeBaseline']['apiBuildProofCanonicalSha256'] == proof['buildProofCanonicalSha256'], 'PRO_BINDING_INVALID')
    task = keys(value['taskBinding'], TASK_BINDING_KEYS, 'TASK_BINDING_INVALID')
    require(task['taskId'] == TASK_ID and type(task['attempt']) is int and task['attempt'] == TASK_ATTEMPT
        and all(iso(task[n]) for n in ('sinceUtc', 'acceptedAt', 'profileBoundAt'))
        and task['sinceUtc'] <= task['acceptedAt'] <= task['profileBoundAt']
        and digest(task['profileSha256']) and digest(task['accountSha256']), 'TASK_BINDING_INVALID')
    check_handoff(value['handoff'])
    require(value['registrationSourceCommit'] == REGISTRATION_SOURCE_COMMIT
        and value['registrationSourceSha256'] == REGISTRATION_SOURCE_SHA256, 'CANDIDATE_SOURCE_CHANGED')
    hash_map(value['controlSourceSha256'], names=CONTROL_FILES)
    keys(value['sourceModes'], CONTROL_FILES, 'CONTROL_MODES_INVALID')
    require(all(type(m) is str and m in ('100644', '100755') for m in value['sourceModes'].values()), 'CONTROL_MODES_INVALID')
    hash_map(value['buildInputSha256'], names=('.dockerignore', 'scripts/audit-python-dependencies.py'))
    candidate = keys(value['candidate'], CANDIDATE_KEYS, 'CANDIDATE_BINDING_INVALID')
    require(digest(candidate['commit'], 40) and candidate['commit'] != CURRENT_COMMIT and digest(candidate['tree'], 40)
        and type(candidate['run']) is str and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', candidate['run'])
        and type(candidate['ciRunId']) is int and candidate['ciRunId'] > 0 and digest(candidate['archiveSha256']),
        'CANDIDATE_BINDING_INVALID')
    sealed = value['sealed95WorkerProjection']
    # Validate rows and measured full60 without needing any historical source bytes.
    placeholder = {n: (b'96 validation placeholder', '100644') for n in SOURCE_PAIR}
    worker_delta(old['actualRegistrationWorkerSourceSha256'], sealed, placeholder)
    finance_keys = {'releaseSealSha256', 'candidateCommit', 'candidateTree', 'sourceTree', 'images',
        'migration', 'preparedImagesSha256', 'preparationRunId', 'preparationRunAttempt'}
    keys(value['financeFrozen'], finance_keys, 'FINANCE_FROZEN_INVALID')
    return value


def validate_task_snapshot(value, binding):
    keys(value, ('task', 'account', 'binding', 'codeRead', 'snapshotStable', 'officialOtpAccepted'), 'TASK_FIELDS_INVALID')
    task = keys(value['task'], TASK_KEYS, 'TASK_FIELDS_INVALID')
    require(task['id'] == TASK_ID and type(task['attempt']) is int and task['attempt'] == TASK_ATTEMPT
        and task['registered'] is True and task['state'] in TASK_STATES and task['step'] in TASK_STEPS
        and (task['reason'] is None or task['reason'] in TASK_REASONS)
        and all(type(task[n]) is bool for n in ('passwordVerified', 'mfaVerified', 'windowBound', 'accountBound'))
        and task['windowBound'] is True and task['accountBound'] is True and iso(task['updatedAt'])
        and (task['leaseUntil'] is None or iso(task['leaseUntil'])), 'TASK_INVALID')
    account = keys(value['account'], ('rowCount', 'registered', 'encryptedPasswordPresent', 'encryptedMfaPresent'), 'ACCOUNT_FIELDS_INVALID')
    require(type(account['rowCount']) is int and account['rowCount'] == 1 and account['registered'] is True
        and all(type(account[n]) is bool for n in ('encryptedPasswordPresent', 'encryptedMfaPresent')), 'ACCOUNT_INVALID')
    keys(value['binding'], ('profileSha256', 'accountSha256', 'acceptedAt', 'profileBoundAt'), 'TASK_BINDING_INVALID')
    require(all(value['binding'][n] == binding[n] for n in value['binding']), 'TASK_BINDING_INVALID')
    code = keys(value['codeRead'], ('action', 'count', 'firstAt', 'latestAt', 'provesOfficialAcceptance', 'sinceUtc', 'steps', 'truncated'), 'CODE_READ_FIELDS_INVALID')
    require(code['action'] == 'code_read' and code['sinceUtc'] == binding['sinceUtc']
        and type(code['count']) is int and 0 <= code['count'] <= 1000
        and type(code['steps']) is list and all(type(n) is str and n in TASK_STEPS for n in code['steps'])
        and code['steps'] == sorted(set(code['steps'])) and code['truncated'] is False
        and code['provesOfficialAcceptance'] is False and value['snapshotStable'] is True
        and value['officialOtpAccepted'] == 'NOT_MEASURED', 'CODE_READ_INVALID')
    require((code['count'] == 0 and code['firstAt'] is None and code['latestAt'] is None and not code['steps'])
        or (code['count'] > 0 and iso(code['firstAt']) and iso(code['latestAt']) and bool(code['steps'])
            and binding['sinceUtc'] <= code['firstAt'] <= code['latestAt']), 'CODE_READ_INVALID')
    return value


def expected_pro_context(context, gates):
    p, profile = context['parameters'], context['proProfile']
    native = profile['nativeBaseline']
    api = {'sourceCommit': '815fae391b172d6c368ea2ad25225f52a1272808', 'sourceTree': '3a814394a45ff3422907501ff22d5d994eed3545',
        'publication': {'version': 1, 'scope': 'API_ADMIN', 'buildProofSha256': native['apiBuildProofCanonicalSha256'],
            'workersPublished': False, 'cacheStatus': 'SKIPPED', 'configurationChanged': False},
        'originalManifestSha256': 'd14e3891cadbca305b2961ccca2e37d0529544813a88705c0f3fdb5e962355bf',
        'buildProofRawSha256': native['apiBuildProofRawSha256'], 'buildProofCanonicalSha256': native['apiBuildProofCanonicalSha256'],
        'preservationRawSha256': native['apiStateRawSha256'], 'originalReadbackSha256': native['apiReadbackSha256']}
    registration = {'sourceCommit': PREVIOUS_COMMIT, 'sourceTree': '0271b84227c35e7b79faa19d1eeb8bb4c48f061f',
        'originalManifestSha256': profile['baselineRelease']['manifestSha256'], 'profileRawSha256': native['registrationProfileRawSha256'],
        'profileCanonicalSha256': native['registrationProfileCanonicalSha256'], 'readbackSha256': native['registrationReadbackSha256'],
        'moduleSha256': 'ffd44a83658908edb42c8508a2f329a6bd40bacba5430d5f974e5cbacd32f95d',
        'original4cBaselineSha256': '5cd42dd7d592b58dd74fcfdcfaa6e6c34918532492120e359740e06bc71ae1d5'}
    return {'version': 1, 'id': profile['id'], 'profileSha256': canonical_sha256(profile), 'expectedCurrent': profile['expectedCurrent'],
        'sourceCommit': p['commit'], 'sourceTree': p['tree'], 'servicesUpdated': ['auto-recharge'],
        'financeValidator': profile['financeClearance']['mode'], 'clearanceSealSha256': canonical_sha256(profile['financeClearance']),
        'nativeChainSha256': native['nativeChainSha256'], 'workerProjectionSha256': canonical_sha256(profile['workerProjection']),
        'beforeGateSha256': canonical_sha256(gates['before']['registrationFinanceGate']),
        'afterGateSha256': canonical_sha256(gates['after']['registrationFinanceGate']),
        'unchangedServiceContainersPreserved': True, 'environmentUnchanged': True, 'migrationStatus': 'SKIPPED',
        'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED', 'historicalApiAdmin': api, 'historicalRegistration95': registration}


def content_row(row):
    keys(row, ('fileCount', 'sha256'), 'CONTENT_FIELDS_INVALID')
    require(type(row['fileCount']) is int and 0 < row['fileCount'] <= 30000 and digest(row['sha256']), 'CONTENT_INVALID')
    return row


def base_file_names(context):
    p, old, pro = context['parameters'], context['baseline95'], context['proProfile']
    profile = 'deploy/aws/' + pro['id'] + '.json'
    names = PRIVATE_FILES | PUBLIC_BASE | set(pro['candidateSourceSha256']) | set(pro['controlSourceSha256']) | {profile}
    return {d + '/' + n for d in (p['current'], old['current']) for n in names
        if not (d == old['current'] and n == profile or d == p['current'] and n == AUDIT_OVERRIDE)}


def validate_finite_record(value, context):
    keys(value, BASELINE_KEYS, 'BASELINE_FIELDS_INVALID')
    p, old, pro = context['parameters'], context['baseline95'], context['proProfile']
    require(type(value['version']) is int and value['version'] == 1 and value['status'] == 'FINITE_POSTPRO_OBSERVED'
        and value['readOnly'] is True and value['runtimeStable'] is True and value['windowRestarted'] is False
        and value['businessAcceptanceConfirmed'] is False and value['historicalChainReexecuted'] is False
        and type(value['databaseWrites']) is int and value['databaseWrites'] == 0
        and value['officialOtpAccepted'] == 'NOT_MEASURED', 'BASELINE_SAFETY_INVALID')
    for field, source in (('current', 'current'), ('commit', 'commit'), ('sourceTree', 'tree'), ('deploymentRun', 'run'), ('controllerSha256', 'controllerSha256')):
        require(value[field] == p[source], 'BASELINE_BINDING_CHANGED')
    require(value['formalProducerEvidenceSha256'] == context['formalProducerEvidenceSha256']
        and value['profileRawSha256'] == context['proProfileRawSha256']
        and value['profileCanonicalSha256'] == context['proProfileCanonicalSha256'], 'BASELINE_BINDING_CHANGED')
    m = keys(value['manifest'], MANIFEST_KEYS, 'MANIFEST_FIELDS_INVALID')
    require(digest(value['manifestRawSha256']) and value['manifestCanonicalSha256'] == canonical_sha256(m)
        and m['commit'] == p['commit'] and m['sourceTree'] == p['tree'] and m['sourceBranch'] == 'main'
        and m['deploymentRun'] == m['imageBuildRun'] == p['run'] and m['previousCommit'] == PREVIOUS_COMMIT
        and m['previousRelease'] == old['current'] and m['previousManifestSha256'] == old['manifest']['previousManifestSha256']
        and m['servicesUpdated'] == ['auto-recharge'] and m['migrationApplied'] is False and m['newMigrations'] == []
        and m['databaseGrants'] == {'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'}
        and type(m['ciWorkflowRunId']) is int and m['ciWorkflowRunId'] > 0 and m['ciWorkflow'] == 'Quality Gate'
        and digest(m['sourceArchiveSha256']), 'MANIFEST_INVALID')
    require(m['fixedRegistrationRelease'] == old['manifest']['fixedRegistrationRelease']
        and m['fixedRegistrationPreservedStates'] == old['manifest']['fixedRegistrationPreservedStates'], 'REGISTRATION_PROVENANCE_CHANGED')
    states = validate_states(value['liveServices'])
    for service in SERVICES - {'auto-recharge'}:
        require(states[service] == old['liveServices'][service], 'PRESERVED_SERVICE_CHANGED')
    keys(m['images'], old['manifest']['images'], 'IMAGE_FIELDS_INVALID')
    require(all(m['images'][s] == old['manifest']['images'][s] for s in m['images'] if s != 'auto-recharge'), 'PRESERVED_IMAGE_CHANGED')
    image = keys(m['images']['auto-recharge'], ('reference', 'digest', 'sourceCommit'), 'IMAGE_FIELDS_INVALID')
    expected_reference = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + p['commit'] + '-' + p['run'].removeprefix('github-actions-') + '-auto-recharge'
    require(image['sourceCommit'] == p['commit'] and image['reference'] == expected_reference
        and image['digest'] == states['auto-recharge']['image'] and image['reference'] == states['auto-recharge']['reference']
        and states['auto-recharge']['environmentSha256'] == old['liveServices']['auto-recharge']['environmentSha256'], 'PRO_IMAGE_CHANGED')
    retained = {s: {k: v for k, v in row.items() if k != 'configurationSha256'} for s, row in states.items() if s != 'auto-recharge'}
    require(m['fixedRechargePreservedStates'] == {'before': retained, 'after': retained}
        and canonical_sha256(retained) == pro['nativeBaseline']['preservedStatesSha256'], 'PRESERVED_SERVICE_CHANGED')
    reg = hash_map(value['actualRegistrationWorkerSourceSha256'], names=old['actualRegistrationWorkerSourceSha256'], cap=60)
    pro_map = {n.removeprefix(WORKER_PREFIX): r['sha256'] for n, r in pro['workerProjection'].items()}
    hash_map(pro_map, cap=60)
    require(reg == old['actualRegistrationWorkerSourceSha256'] and len(reg) == len(pro_map) == 60
        and value['actualRechargeWorkerSourceSha256'] == pro_map, 'WORKER_ROLES_CHANGED')
    keys(value['actualApiCompiledSourceSha256'], old['actualApiCompiledSourceSha256'], 'API_COMPILED_CHANGED')
    require(len(value['actualApiCompiledSourceSha256']) == 4 and value['actualApiCompiledSourceSha256'] == old['actualApiCompiledSourceSha256'], 'API_COMPILED_CHANGED')
    keys(value['apiAdminContentProof'], ('api', 'admin'), 'CONTENT_FIELDS_INVALID')
    for service, row in value['apiAdminContentProof'].items():
        content_row(row)
        require(row == {k: old['apiRuntimeProof']['buildProof']['images'][service][k] for k in ('fileCount', 'sha256')}, 'API_CONTENT_CHANGED')
    maps = keys(value['publicSourceMap'], ('current', 'previous'), 'PUBLIC_MAP_FIELDS_INVALID')
    for row in maps.values(): content_row(row)
    require(maps['previous'] == old['publicSourceMap'], 'PUBLIC_MAP_CHANGED')
    # The full old95 seal remains pinned above. New wire observations only carry
    # selected necessary host paths; running full60 proofs are independent.
    selected = PUBLIC_BASE | set(pro['candidateSourceSha256']) | set(pro['controlSourceSha256']) | {'deploy/aws/' + pro['id'] + '.json'}
    expected_names = base_file_names(context)
    files = keys(value['fileSha256'], expected_names, 'FILE_MAP_FIELDS_INVALID')
    require(len(files) <= 400 and all(digest(h) for h in files.values()), 'FILE_MAP_INVALID')
    for n in PRIVATE_FILES | selected:
        if n in old['fileSha256']: require(files[old['current'] + '/' + n] == old['fileSha256'][n], 'PREVIOUS_FILE_CHANGED')
    require(files[p['current'] + '/release-manifest.json'] == value['manifestRawSha256']
        and files[p['current'] + '/scripts/production-release/remote-deploy.py'] == p['controllerSha256']
        and files[p['current'] + '/deploy/aws/' + pro['id'] + '.json'] == context['proProfileRawSha256'], 'CURRENT_FILE_CHANGED')
    for n, h in {**pro['candidateSourceSha256'], **pro['controlSourceSha256']}.items(): require(files[p['current'] + '/' + n] == h, 'CURRENT_FILE_CHANGED')
    for n in ('.env.aws.production', 'api-admin-build-proof.json', 'api-admin-preservation.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json'):
        require(files[p['current'] + '/' + n] == old['fileSha256'][n], 'PRESERVED_PRIVATE_CHANGED')
    audits = keys(value['audits'], ('before', 'after'), 'AUDIT_FIELDS_INVALID')
    gates = {}
    for stage, row in audits.items():
        keys(row, AUDIT_KEYS, 'AUDIT_FIELDS_INVALID')
        require(type(row['checkCount']) is int and row['checkCount'] == 49 and type(row['violationCount']) is int and row['violationCount'] == 0
            and all(digest(row[k]) for k in AUDIT_KEYS - {'checkCount', 'violationCount'})
            and row['rawSha256'] == files[p['current'] + '/' + stage + '-audit.json']
            and row['checksSha256'] == pro['financeClearance']['checksSha256']
            and row['identitySha256'] == old['audits']['before']['identitySha256'], 'AUDIT_CHANGED')
        summary = keys(m['dataAudit' + stage.title()], ('checkCount', 'violationCount', 'registrationFinanceGate'), 'AUDIT_FIELDS_INVALID')
        require(type(summary['checkCount']) is int and summary['checkCount'] == 49
            and type(summary['violationCount']) is int and summary['violationCount'] == 0
            and row['gateSha256'] == canonical_sha256(summary['registrationFinanceGate'])
            and summary['registrationFinanceGate'].get('stage') == stage
            and summary['registrationFinanceGate'].get('status') == pro['financeClearance']['mode'], 'AUDIT_CHANGED')
        gates[stage] = summary
    require(m['fixedRechargeRelease'] == expected_pro_context(context, gates), 'PRO_PROVENANCE_CHANGED')
    validate_health(value['workerHealth'])
    validate_task_snapshot(value['taskReadOnly'], context['taskBinding'])
    return value


def current_observation(raw, frozen, baseline):
    """An immutable baseline seal does not freeze job/health observations in time."""
    context = validate_frozen(frozen)
    value = validate_finite_record(closed_json(raw), context)
    stable = BASELINE_KEYS - {'workerHealth', 'taskReadOnly'}
    require(all(value[k] == baseline[k] for k in stable), 'LIVE_BASELINE_CHANGED')
    validate_health(value['workerHealth'], idle=True)
    handoff = context['handoff']
    task, account = value['taskReadOnly']['task'], value['taskReadOnly']['account']
    require(task['passwordVerified'] == handoff['passwordLoginVerified'] and task['mfaVerified'] == handoff['mfaLoginVerified']
        and account == baseline['taskReadOnly']['account'], 'HANDOFF_FACTS_CHANGED')
    return value


def source_files(files, *, public=False):
    require(type(files) is dict and 0 < len(files) <= 5000, 'SOURCE_FILES_INVALID')
    total = 0
    for n, row in files.items():
        require(safe_name(n) and type(row) is tuple and len(row) == 2 and type(row[0]) is bytes
            and 0 <= len(row[0]) <= 8 * 1024 * 1024 and type(row[1]) is str
            and (row[1] in ('100644', '100755') or public and n == 'docker-compose.aws-mysql.yml' and row[1] == '100664'), 'SOURCE_FILES_INVALID')
        total += len(row[0])
    require(total <= 64 * 1024 * 1024, 'SOURCE_FILES_INVALID')
    return files


def source_map(files):
    source_files(files, public=True)
    return {n: [sha256(raw), int(mode[-3:], 8)] for n, (raw, mode) in files.items()}


def carried_source_inputs(carried, context):
    require(carried is not None, 'BUILD_CARRIED_INPUT_MISSING')
    keys(carried, ('files', 'sourceCommits'), 'BUILD_CARRIED_INPUT_INVALID')
    require(carried['sourceCommits'] == CARRIED_SOURCE_COMMITS, 'BUILD_CARRIED_SOURCE_CHANGED')
    files = source_files(carried['files'])
    keys(files, CARRIED_SOURCE_COMMITS, 'BUILD_CARRIED_INPUT_INVALID')
    for n, (raw, mode) in files.items():
        require(mode == '100644' and {'sha256': sha256(raw), 'mode': mode} == context['sealed95WorkerProjection'][n], 'BUILD_CARRIED_SOURCE_CHANGED')
    return files


def build_projection(basis, candidate, frozen, baseline, *, carried=None):
    """2f plus seven closed inputs reconstruct58; only the R3d pair changes.

    The additional code bytes come from the two already identified sealed
    source commits, not from main/Pro and not from a historical verification
    chain. Source receipt hashes remain the independently measured actual95.
    """
    context = validate_frozen(frozen)
    source_files(basis); source_files(candidate)
    pair = {n: candidate[n] for n in SOURCE_PAIR if n in candidate}
    require(set(pair) == SOURCE_PAIR and all(sha256(pair[n][0]) == context['registrationSourceSha256'][n] for n in pair), 'CANDIDATE_SOURCE_CHANGED')
    projection = worker_delta(baseline['actualRegistrationWorkerSourceSha256'], context['sealed95WorkerProjection'], pair)
    worker = {n: row for n, row in basis.items() if n.startswith(WORKER_PREFIX)}
    require(set(worker) == set(projection), 'BUILD_BASIS_CHANGED')
    worker.update(carried_source_inputs(carried, context))
    for n in set(projection) - SOURCE_PAIR:
        require({'sha256': sha256(worker[n][0]), 'mode': worker[n][1]} == projection[n], 'BUILD_BASIS_CHANGED')
    worker.update(pair)
    require({n: {'sha256': sha256(row[0]), 'mode': row[1]} for n, row in worker.items()} == projection, 'BUILD_PROJECTION_CHANGED')
    for n, h in context['buildInputSha256'].items():
        require(n in basis and sha256(basis[n][0]) == h and basis[n][1] == '100644', 'BUILD_INPUT_CHANGED')
        worker[n] = basis[n]
    return worker, projection


def build_from_archives(candidate_raw, basis_raw, frozen, baseline, registration_archive, *, carried=None):
    context = validate_frozen(frozen)
    carried_source_inputs(carried, context)
    require(callable(registration_archive) and sha256(checked_bytes(candidate_raw, 64 * 1024 * 1024)) == context['candidate']['archiveSha256'], 'ARCHIVE_CHANGED')
    checked_bytes(basis_raw, 64 * 1024 * 1024)
    candidate = registration_archive(candidate_raw, context['candidate']['commit'])
    basis = registration_archive(basis_raw, WORKER_BASIS_COMMIT)
    return build_projection(basis, candidate, context, baseline, carried=carried)


def build_receipt(frozen, projection):
    context = validate_frozen(frozen)
    validate_projection(projection, context)
    return {'version': 1, 'id': PROFILE_ID, 'sourceCommit': context['candidate']['commit'],
        'sourceTree': context['candidate']['tree'], 'registrationSourceCommit': REGISTRATION_SOURCE_COMMIT,
        'workerBasisCommit': WORKER_BASIS_COMMIT, 'workerProjectionSha256': canonical_sha256(projection),
        'registrationSourceSha256': clone(context['registrationSourceSha256']),
        'carriedSourceCommits': clone(CARRIED_SOURCE_COMMITS),
        'carriedSourceSha256': {n: context['sealed95WorkerProjection'][n]['sha256'] for n in CARRIED_SOURCE_COMMITS},
        'baselineReceiptSha256': context['baselineRawSha256'], 'contextPath': '.deploy/production-release/registration-build-context'}


def validate_projection(projection, context):
    expected = clone(context['sealed95WorkerProjection'])
    for name, h in context['registrationSourceSha256'].items(): expected[name] = {'mode': '100644', 'sha256': h}
    require(type(projection) is dict and projection == expected and len(projection) == 60, 'BUILD_PROJECTION_CHANGED')
    return projection


def profile_contract(frozen, baseline, projection, *, enabled=False):
    context = validate_frozen(frozen)
    require(type(enabled) is bool, 'PROFILE_INVALID')
    validate_projection(projection, context)
    pro = context['proProfile']
    return {'version': 1, 'kind': 'FINITE_REGISTRATION_RUNTIME_SCOPE', 'id': PROFILE_ID, 'enabled': enabled,
        'expectedCurrent': CURRENT_COMMIT, 'expectedDirectory': baseline['current'],
        'baselineReceiptSha256': context['baselineRawSha256'], 'baselineCanonicalSha256': context['baselineCanonicalSha256'],
        'baselineCarrierSha256': context['baselineCarrierSha256'],
        'baselineSchemaSha256': context['schemaSha256'], 'formalProducerEvidenceSha256': context['formalProducerEvidenceSha256'],
        'registrationSourceCommit': REGISTRATION_SOURCE_COMMIT, 'workerBasisCommit': WORKER_BASIS_COMMIT,
        'registrationSourceSha256': clone(context['registrationSourceSha256']), 'workerProjection': clone(projection),
        'workerProjectionSha256': canonical_sha256(projection), 'buildInputSha256': clone(context['buildInputSha256']),
        'carriedSourceCommits': clone(CARRIED_SOURCE_COMMITS),
        'carriedSourceSha256': {n: context['sealed95WorkerProjection'][n]['sha256'] for n in CARRIED_SOURCE_COMMITS},
        'controlSourceSha256': clone(context['controlSourceSha256']), 'sourceModes': clone(context['sourceModes']),
        'financeValidator': clone(pro['financeValidator']), 'financeClearance': clone(pro['financeClearance']),
        'scope': {'servicesUpdated': ['auto-registration'], 'imageServices': ['auto-recharge'], 'migrationDeploymentAllowed': False,
            'databaseGrantSyncAllowed': False, 'financialWritesAllowed': False, 'imageReuseAllowed': False, 'cacheCleanupAllowed': False},
        'registrationHandoff': clone(context['handoff']),
        'runtimeBaseline': {'manifestRawSha256': baseline['manifestRawSha256'], 'publicSourceMap': clone(baseline['publicSourceMap']['current']),
            'serviceStatesSha256': canonical_sha256(baseline['liveServices']),
            'apiRuntimeRevision': context['baseline95']['apiRuntimeProof']['revision'],
            'apiBuildProofSha256': context['baseline95']['apiRuntimeProof']['buildProofCanonicalSha256'],
            'apiCompiledSourceSha256': clone(baseline['actualApiCompiledSourceSha256']),
            'proWorkerSourceSha256': canonical_sha256(baseline['actualRechargeWorkerSourceSha256'])}}


def validate_profile(raw, frozen, baseline, projection, *, require_enabled=False):
    value = closed_json(profile_bytes(raw), limit=PROFILE_MAX_BYTES)
    require(type(value.get('enabled')) is bool and (not require_enabled or value['enabled'] is True), 'PROFILE_DISABLED')
    require(value == profile_contract(frozen, baseline, projection, enabled=value['enabled']), 'PROFILE_CHANGED')
    return value


def runtime_projection(public, candidate, profile_raw, frozen, baseline, projection):
    context = validate_frozen(frozen)
    source_files(public, public=True); source_files(candidate)
    measured = source_map(public)
    require({'fileCount': len(measured), 'sha256': canonical_sha256(measured, ascii=False)} == baseline['publicSourceMap']['current'], 'RUNTIME_BASIS_CHANGED')
    require(not (set(public) & PRIVATE_FILES), 'RUNTIME_PRIVATE_INPUT')
    result = dict(public)
    for n, h in {**context['registrationSourceSha256'], **context['controlSourceSha256']}.items():
        require(n in candidate and sha256(candidate[n][0]) == h
            and candidate[n][1] == ('100644' if n in SOURCE_PAIR else context['sourceModes'][n]), 'RUNTIME_CANDIDATE_CHANGED')
        result[n] = candidate[n]
    carrier_bytes(result['scripts/production-release/remote-deploy.py'][0])
    module_bytes(result['scripts/production-release/registration-onboarding-96.py'][0])
    validate_profile(profile_raw, context, baseline, projection)
    result[PROFILE_FILE] = (profile_raw, '100644')
    require(BASELINE_CARRIER_FILE in candidate and candidate[BASELINE_CARRIER_FILE][1] == '100644'
        and sha256(candidate[BASELINE_CARRIER_FILE][0]) == context['baselineCarrierSha256'], 'CARRIER_CHANGED')
    result[BASELINE_CARRIER_FILE] = candidate[BASELINE_CARRIER_FILE]
    allowed = SOURCE_PAIR | CONTROL_FILES | {PROFILE_FILE, BASELINE_CARRIER_FILE}
    require(all(result[n] == row for n, row in public.items() if n not in allowed), 'RUNTIME_PRESERVATION_CHANGED')
    return result


def validate_audit(report, stage, frozen, baseline, *, before=None, require_zero_report=None):
    require(stage in ('before', 'after'), 'AUDIT_STAGE_INVALID')
    keys(report, ('ok', 'checkCount', 'violationCount', 'failedChecks', 'identity', 'checks', 'gate', 'generatedAt'), 'AUDIT_FIELDS_INVALID')
    identity = keys(report['identity'], ('currentUser', 'databaseName', 'transactionIsolation', 'foreignKeyChecks', 'readOnly', 'superReadOnly', 'sessionReadOnly'), 'AUDIT_IDENTITY_INVALID')
    require(type(identity['currentUser']) is str and re.fullmatch(r'id_business_audit@[^\r\n]{1,255}', identity['currentUser'])
        and identity['transactionIsolation'] == 'REPEATABLE-READ' and str(identity['foreignKeyChecks']) == str(identity['sessionReadOnly']) == '1'
        and str(identity['readOnly']) == str(identity['superReadOnly']) == '0', 'AUDIT_IDENTITY_INVALID')
    expected_gate = clone(baseline['manifest']['dataAuditBefore']['registrationFinanceGate']); expected_gate['stage'] = stage
    require(report['ok'] is True and type(report['checkCount']) is int and report['checkCount'] == 49
        and type(report['violationCount']) is int and report['violationCount'] == 0 and report['failedChecks'] == []
        and iso(report['generatedAt']) and report['gate'] == expected_gate
        and canonical_sha256(report['checks']) == frozen['proProfile']['financeClearance']['checksSha256']
        and canonical_sha256(identity) == baseline['audits']['before']['identitySha256'], 'AUDIT_CHANGED')
    if stage == 'after':
        require(before is not None, 'AUDIT_BEFORE_MISSING')
        validate_audit(before, 'before', frozen, baseline)
        require(before['checks'] == report['checks'] and before['identity'] == report['identity'], 'AUDIT_FACTS_CHANGED')
    else: require(before is None, 'AUDIT_STAGE_INVALID')
    summary = {'checkCount': 49, 'violationCount': 0, 'registrationFinanceGate': expected_gate}
    if require_zero_report is not None:
        require(callable(require_zero_report) and require_zero_report(report, stage, frozen['financeFrozen']) == summary, 'AUDIT_HELPER_CHANGED')
    return summary


def validate_backup(value):
    keys(value, ('name', 'sha256', 'size', 's3Verified'), 'BACKUP_FIELDS_INVALID')
    require(type(value['name']) is str and re.fullmatch(r'id-business-v2-[A-Za-z0-9T_-]{1,80}\.sql\.gz', value['name'])
        and digest(value['sha256']) and type(value['size']) is int and value['size'] > 0 and value['s3Verified'] is True, 'BACKUP_INVALID')
    return value


def image_reference(frozen):
    c = frozen['candidate']
    return '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + c['commit'] + '-' + c['run'].removeprefix('github-actions-') + '-auto-recharge'


def validate_image(value, frozen, projection):
    keys(value, ('image', 'reference', 'architecture', 'revision', 'workerProjectionSha256'), 'IMAGE_FIELDS_INVALID')
    require(type(value['image']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', value['image'])
        and value['reference'] == image_reference(frozen) and value['architecture'] == 'amd64'
        and value['revision'] == frozen['candidate']['commit'] and value['workerProjectionSha256'] == canonical_sha256(projection), 'IMAGE_CHANGED')
    return value


def preserved_states(states):
    validate_states(states)
    return {n: clone(row) for n, row in states.items() if n != 'auto-registration'}


def validate_running(value, frozen, baseline, projection, image):
    keys(value, ('liveServices', 'actualRegistrationWorkerSourceSha256', 'actualRechargeWorkerSourceSha256',
        'actualApiCompiledSourceSha256', 'apiAdminContentProof', 'workerHealth'), 'RUNNING_FIELDS_INVALID')
    states = validate_states(value['liveServices'])
    require(preserved_states(states) == preserved_states(baseline['liveServices']), 'PRESERVED_SERVICE_CHANGED')
    reg = states['auto-registration']
    require(reg['image'] == image['image'] and reg['reference'] == image['reference']
        and reg['environmentSha256'] == baseline['liveServices']['auto-registration']['environmentSha256']
        and reg['containerId'] != baseline['liveServices']['auto-registration']['containerId']
        and reg['startedAtSha256'] != baseline['liveServices']['auto-registration']['startedAtSha256'], 'REGISTRATION_IMAGE_CHANGED')
    expected = {n.removeprefix(WORKER_PREFIX): row['sha256'] for n, row in projection.items()}
    require(value['actualRegistrationWorkerSourceSha256'] == expected and len(expected) == 60
        and value['actualRechargeWorkerSourceSha256'] == baseline['actualRechargeWorkerSourceSha256'], 'WORKER_ROLES_CHANGED')
    require(value['actualApiCompiledSourceSha256'] == baseline['actualApiCompiledSourceSha256']
        and value['apiAdminContentProof'] == baseline['apiAdminContentProof'], 'API_CONTENT_CHANGED')
    validate_health(value['workerHealth'], idle=True)
    return value


def registration_provenance(frozen, baseline, profile_raw, projection):
    return {'id': PROFILE_ID, 'profileRawSha256': sha256(profile_raw), 'registrationSourceCommit': REGISTRATION_SOURCE_COMMIT,
        'workerBasisCommit': WORKER_BASIS_COMMIT, 'workerProjectionSha256': canonical_sha256(projection),
        'runtimeBaselineReceiptSha256': frozen['baselineRawSha256'], 'formalProducerEvidenceSha256': frozen['formalProducerEvidenceSha256'],
        'registrationHandoff': clone(frozen['handoff']), 'apiRuntimeRevision': frozen['baseline95']['apiRuntimeProof']['revision'],
        'apiBuildProofSha256': frozen['baseline95']['apiRuntimeProof']['buildProofCanonicalSha256'],
        'proWorkerSourceSha256': canonical_sha256(baseline['actualRechargeWorkerSourceSha256']),
        'clearanceSealSha256': canonical_sha256(frozen['proProfile']['financeClearance']), 'environmentUnchanged': True,
        'migrationStatus': 'SKIPPED', 'databaseGrantSyncStatus': 'SKIPPED', 'cacheStatus': 'SKIPPED'}


def readback_public_files(frozen):
    pro = frozen['proProfile']
    return PUBLIC_BASE | SOURCE_PAIR | CONTROL_FILES | {PROFILE_FILE, BASELINE_CARRIER_FILE, 'deploy/aws/' + pro['id'] + '.json'} \
        | set(pro['candidateSourceSha256']) | set(pro['controlSourceSha256'])


def manifest_contract(frozen, baseline, profile_raw, projection, image, running, before, after, backup, release, deployed_at):
    c = frozen['candidate']
    require(release_directory(release, c['commit']) and iso(deployed_at), 'RELEASE_LOCATION_INVALID')
    validate_image(image, frozen, projection); validate_running(running, frozen, baseline, projection, image); validate_backup(backup)
    before_summary = validate_audit(before, 'before', frozen, baseline)
    after_summary = validate_audit(after, 'after', frozen, baseline, before=before)
    result = clone(baseline['manifest'])
    result.update(commit=c['commit'], sourceBranch='main', sourceTree=c['tree'], previousCommit=CURRENT_COMMIT,
        previousRelease=baseline['current'], previousManifestSha256=baseline['manifestRawSha256'], deploymentRun=c['run'],
        imageBuildRun=c['run'], ciWorkflow='Quality Gate', ciWorkflowRunId=c['ciRunId'],
        sourceArchiveSha256=c['archiveSha256'], servicesUpdated=['auto-registration'], migrationApplied=False,
        newMigrations=[], databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'},
        dataAuditBefore=before_summary, dataAuditAfter=after_summary, backupBeforeRelease=backup['name'], deployedAt=deployed_at,
        releaseTag='v2-production-' + release.rsplit('/', 1)[1].split('-', 1)[0])
    result['images']['auto-registration'] = {'reference': image['reference'], 'digest': image['image'], 'sourceCommit': c['commit']}
    result['fixedRegistrationRelease'] = registration_provenance(frozen, baseline, profile_raw, projection)
    result['fixedRegistrationPreservedStates'] = {'before': preserved_states(baseline['liveServices']), 'after': preserved_states(running['liveServices'])}
    result['rollback'] = {'release': baseline['current'], 'images': {'auto-registration': baseline['liveServices']['auto-registration']['image']}, 'servicesAdded': []}
    return result


def validate_readback(value, frozen, baseline, profile_raw, projection, runtime, *, runtime_map=None):
    keys(value, READBACK_KEYS, 'READBACK_FIELDS_INVALID')
    context = validate_frozen(frozen)
    c = context['candidate']
    require(type(value['version']) is int and value['version'] == 1 and value['status'] == 'VERIFIED_REGISTRATION96_RUNTIME'
        and value['readOnly'] is True and value['runtimeStable'] is True and value['businessAcceptanceConfirmed'] is False
        and value['officialOtpAccepted'] == 'NOT_MEASURED' and value['commit'] == c['commit']
        and value['sourceTree'] == c['tree'] and value['deploymentRun'] == c['run']
        and value['previous'] == baseline['current'] and release_directory(value['current'], c['commit'])
        and value['profileRawSha256'] == sha256(profile_raw)
        and value['moduleSha256'] == context['controlSourceSha256']['scripts/production-release/registration-onboarding-96.py'], 'READBACK_BINDING_CHANGED')
    image = validate_image(value['imageMetadata'], context, projection)
    running = {k: value[k] for k in ('liveServices', 'actualRegistrationWorkerSourceSha256', 'actualRechargeWorkerSourceSha256',
        'actualApiCompiledSourceSha256', 'apiAdminContentProof', 'workerHealth')}
    validate_running(running, context, baseline, projection, image)
    reports = keys(value['auditReports'], ('before', 'after'), 'AUDIT_FIELDS_INVALID')
    m = keys(value['manifest'], MANIFEST_KEYS, 'MANIFEST_FIELDS_INVALID')
    require(m == manifest_contract(context, baseline, profile_raw, projection, image, running, reports['before'], reports['after'],
        value['backup'], value['current'], m['deployedAt']) and digest(value['manifestRawSha256'])
        and value['manifestCanonicalSha256'] == canonical_sha256(m)
        and value['manifestRawSha256'] == private_json_sha256(m), 'READBACK_MANIFEST_CHANGED')
    measured_map = source_map(runtime) if runtime_map is None else public_hash_map(runtime_map)
    require(value['publicSourceMap'] == {'fileCount': len(measured_map), 'sha256': canonical_sha256(measured_map, ascii=False)}, 'READBACK_PUBLIC_MAP_CHANGED')
    config = keys(value['configurationProof'], ('environmentFileSha256', 'composeFileSha256', 'overrideCanonicalSha256'), 'CONFIGURATION_INVALID')
    current = baseline['current']
    require(config['environmentFileSha256'] == baseline['fileSha256'][current + '/.env.aws.production']
        and config['composeFileSha256'] == baseline['fileSha256'][current + '/docker-compose.aws-mysql.yml'], 'CONFIGURATION_CHANGED')
    override = {'services': {n: {'image': m['images'][n]['reference'], 'pull_policy': 'never'} for n in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'migrate')}}
    require(config['overrideCanonicalSha256'] == canonical_sha256(override), 'CONFIGURATION_CHANGED')
    selected = readback_public_files(context)
    require(selected <= set(measured_map), 'READBACK_FILE_FIELDS_INVALID')
    expected_files = {value['current'] + '/' + n: measured_map[n][0] for n in selected}
    for n in PRIVATE_FILES:
        require(value['current'] + '/' + n in value['fileSha256'], 'READBACK_FILE_CHANGED')
        expected_files[value['current'] + '/' + n] = value['fileSha256'][value['current'] + '/' + n]
    files = keys(value['fileSha256'], expected_files, 'READBACK_FILE_FIELDS_INVALID')
    require(all(digest(h) for h in files.values()) and files == expected_files
        and files[value['current'] + '/release-manifest.json'] == value['manifestRawSha256']
        and files[value['current'] + '/' + PROFILE_FILE] == sha256(profile_raw), 'READBACK_FILE_CHANGED')
    for n in ('.env.aws.production', 'api-admin-build-proof.json', 'api-admin-preservation.json', 'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json', 'registration-recovery-audit.compose.json'):
        origin = frozen['baseline95']['current'] if n == AUDIT_OVERRIDE else current
        require(files[value['current'] + '/' + n] == baseline['fileSha256'][origin + '/' + n], 'READBACK_PRIVATE_CHANGED')
    require(files[value['current'] + '/backup-verification.json'] == private_json_sha256(value['backup'])
        and files[value['current'] + '/compose.release.json'] == private_json_sha256(override)
        and all(files[value['current'] + '/' + s + '-audit.json'] == private_json_sha256(reports[s]) for s in reports), 'READBACK_PRIVATE_CHANGED')
    return value


RELEASE_HELPERS = frozenset(('assert_deployment_lock', 'observe_baseline', 'assert_release_jobs_idle', 'assert_no_active_registration', 'stage_runtime',
    'audit49', 'require_registration_zero_report', 'pull_registration_image', 'fresh_backup', 'observe_current',
    'switch_registration', 'wait_healthy', 'registration_worker_hashes', 'observe_running', 'write_manifest',
    'point_current', 'observe_readback', 'registration_rollback'))


def release_helpers(frozen, baseline_raw, profile_raw, projection, runtime, release, deployed_at, helpers, *, public=None, candidate=None):
    """Internal finite orchestration; only the controller supplies I/O helpers.

    No loader/CLI calls this function. Synthetic handlers can verify ordering,
    but are not actual evidence. The deployment lock belongs to the controller.
    API enqueue is not covered by that lock; two adjacent idle guards reduce
    the existing race without claiming an atomic admission barrier.
    """
    context = validate_frozen(frozen)
    baseline = validate_baseline(baseline_raw, context)
    validate_profile(profile_raw, context, baseline, projection, require_enabled=True)
    require(type(helpers) is dict and set(helpers) == RELEASE_HELPERS and all(callable(f) for f in helpers.values()), 'RELEASE_HELPERS_MISSING')
    require(release_directory(release, context['candidate']['commit']) and iso(deployed_at), 'RELEASE_LOCATION_INVALID')
    require(type(public) is dict and type(candidate) is dict
        and runtime == runtime_projection(public, candidate, profile_raw, context, baseline, projection), 'RUNTIME_CANDIDATE_CHANGED')
    phase, changed, published = 'baseline', False, False
    try:
        helpers['assert_deployment_lock']()
        current_observation(helpers['observe_baseline'](), context, baseline)
        helpers['assert_release_jobs_idle'](baseline['current'], ('auto-registration',))
        helpers['assert_no_active_registration'](baseline['current'])
        phase = 'stage'; helpers['stage_runtime'](release, runtime)
        phase = 'audit_before'; before = helpers['audit49'](baseline['current'], release, 'before', None)
        validate_audit(before, 'before', context, baseline, require_zero_report=helpers['require_registration_zero_report'])
        phase = 'image'; image = validate_image(helpers['pull_registration_image'](image_reference(context)), context, projection)
        phase = 'backup'; backup = validate_backup(helpers['fresh_backup'](baseline['current']))
        phase = 'switch_guard'
        helpers['assert_deployment_lock']()
        require(helpers['observe_current']() == baseline['current'], 'CURRENT_POINTER_CHANGED')
        current_observation(helpers['observe_baseline'](), context, baseline)
        helpers['assert_release_jobs_idle'](baseline['current'], ('auto-registration',))
        helpers['assert_no_active_registration'](baseline['current'])
        require(helpers['observe_current']() == baseline['current'], 'CURRENT_POINTER_CHANGED')
        phase = 'switch'; changed = True  # A failing compose may already have recreated the container.
        helpers['switch_registration'](release, image['reference'], ('auto-registration',))
        helpers['wait_healthy'](release, 'auto-registration')
        helpers['registration_worker_hashes'](release, {'workerProjection': projection})
        phase = 'running'; running = validate_running(helpers['observe_running'](release), context, baseline, projection, image)
        phase = 'audit_after'; after = helpers['audit49'](release, release, 'after', before)
        validate_audit(after, 'after', context, baseline, before=before, require_zero_report=helpers['require_registration_zero_report'])
        running = validate_running(helpers['observe_running'](release), context, baseline, projection, image)
        phase = 'manifest'; manifest = manifest_contract(context, baseline, profile_raw, projection, image, running, before, after, backup, release, deployed_at)
        helpers['write_manifest'](release, manifest)
        require(helpers['observe_current']() == baseline['current'], 'CURRENT_POINTER_CHANGED')
        phase = 'publish'; helpers['point_current'](release); published = True
        phase = 'readback'; receipt = validate_readback(helpers['observe_readback'](release), context, baseline, profile_raw, projection, runtime)
        require(helpers['observe_current']() == release, 'CURRENT_POINTER_CHANGED')
        return {'status': 'REGISTRATION96_RUNTIME_VERIFIED', 'servicesUpdated': ['auto-registration'],
            'readbackCanonicalSha256': canonical_sha256(receipt), 'businessAcceptanceConfirmed': False,
            'officialOtpAccepted': 'NOT_MEASURED'}
    except Exception:
        rollback_ok, pointer_restored = not changed, False
        if changed:
            try:
                helpers['assert_deployment_lock']()
                pointer = helpers['observe_current']()
                require(pointer in (baseline['current'], release), 'CURRENT_POINTER_CHANGED')
                helpers['registration_rollback'](baseline['current'], release, baseline['liveServices'])
                rollback_ok = True
                pointer = helpers['observe_current']()
                if pointer == release:
                    helpers['point_current'](baseline['current']); pointer_restored = True
                elif pointer != baseline['current']:
                    rollback_ok = False  # Foreign current must never be overwritten.
            except Exception:
                rollback_ok = False
        return {'status': 'REGISTRATION96_RELEASE_HELPER_FAILED', 'phase': phase, 'workerSwitchStarted': changed,
            'publishCompleted': published, 'rollbackOk': rollback_ok, 'rollbackBlocked': changed and not rollback_ok,
            'pointerRestored': pointer_restored, 'freshRollbackReadbackRequired': changed,
            'rawErrorSuppressed': True, 'businessAcceptanceConfirmed': False}


def assert_enabled(frozen=None):
    # Even monkeypatching ENABLED cannot enable this incomplete foundation.
    require(ENABLED is True and digest(BASELINE_SCHEMA_SHA256)
        and digest(FORMAL_BASELINE_SHA256) and digest(FINAL_SOURCE_PAIR_SHA256)
        and digest(HANDOFF_SHA256), 'REGISTRATION96_DISABLED')
    require(frozen is not None, 'REGISTRATION96_DISABLED')
    value = validate_frozen(frozen)
    require(BASELINE_SCHEMA_SHA256 == value['schemaSha256']
        and FORMAL_BASELINE_SHA256 == value['baselineRawSha256']
        and FINAL_SOURCE_PAIR_SHA256 == canonical_sha256(value['registrationSourceSha256'])
        and HANDOFF_SHA256 == value['handoff']['receiptSha256'], 'REGISTRATION96_DISABLED')
    return value


def ssm_parameters(*_args, **_kwargs):
    assert_enabled()
    raise Registration96Error('REGISTRATION96_CLI_DISABLED')


CARRIER_KEYS = frozenset(('version', 'status', 'schemaSha256', 'formalProducerEvidenceSha256',
    'baselineRawBase64', 'baselineRawSha256', 'baselineCanonicalSha256',
    'baseline95RawBase64', 'baseline95RawSha256', 'baseline95CanonicalSha256',
    'proProfileRawBase64', 'proProfileRawSha256', 'proProfileCanonicalSha256',
    'sealed95WorkerProjection', 'taskBinding', 'handoff', 'financeBaseline', 'buildInputSha256', 'currentPublicSourceMap'))
FINANCE_KEYS = frozenset(('releaseSealSha256', 'candidateCommit', 'candidateTree', 'sourceTree',
    'images', 'migration', 'preparedImagesSha256', 'preparationRunId', 'preparationRunAttempt'))
PARENT_CAPABILITIES = frozenset(('run', 'compose', 'registration_archive', 'registration_download',
    'write_registration_files', 'assert_release_jobs_idle', 'assert_no_active_registration',
    'wait_healthy', 'registration_worker_hashes', 'fresh_backup', 'point_current',
    'registration_rollback', 'require_registration_zero_report', 'environment_values',
    'maintenance_container_audit_url', 'registration_recovery_audit_reader',
    'prepare_registration_recovery_before_receipt'))


def enabled_pins():
    require(ENABLED is True and all(digest(v) for v in (BASELINE_SCHEMA_SHA256,
        FORMAL_BASELINE_SHA256, FINAL_SOURCE_PAIR_SHA256, HANDOFF_SHA256)), 'REGISTRATION96_DISABLED')


def decode_raw(value, label, raw_hash, canonical_hash, *, ascii=True):
    require(type(value) is str and 0 < len(value) <= BASELINE_MAX_BYTES, 'CARRIER_INVALID')
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise Registration96Error('CARRIER_INVALID') from None
    require(base64.b64encode(raw).decode() == value and digest(raw_hash) and digest(canonical_hash)
        and sha256(raw) == raw_hash, 'CARRIER_RAW_CHANGED')
    document = closed_json(raw)
    require(canonical_sha256(document, ascii=ascii) == canonical_hash, 'CARRIER_CANONICAL_CHANGED')
    return raw, document


def carrier_context(carrier_raw, profile_raw, candidate, files):
    """Compose runtime inputs; future commit/tree/run/archive never live in carrier."""
    value = keys(closed_json(carrier_raw), CARRIER_KEYS, 'CARRIER_FIELDS_INVALID')
    require(type(value['version']) is int and value['version'] == 1
        and value['status'] == 'FROZEN_REGISTRATION96_FINITE_CARRIER', 'CARRIER_INVALID')
    baseline_raw, baseline = decode_raw(value['baselineRawBase64'], 'baseline',
        value['baselineRawSha256'], value['baselineCanonicalSha256'])
    _old_raw, old = decode_raw(value['baseline95RawBase64'], '95',
        value['baseline95RawSha256'], value['baseline95CanonicalSha256'], ascii=False)
    _pro_raw, pro = decode_raw(value['proProfileRawBase64'], 'pro',
        value['proProfileRawSha256'], value['proProfileCanonicalSha256'])
    profile = closed_json(profile_bytes(profile_raw), limit=PROFILE_MAX_BYTES)
    require(profile.get('id') == PROFILE_ID and profile.get('baselineCarrierSha256') == sha256(carrier_raw), 'CARRIER_CHANGED')
    control = hash_map(profile.get('controlSourceSha256'), names=CONTROL_FILES)
    modes = keys(profile.get('sourceModes'), CONTROL_FILES, 'CONTROL_MODES_INVALID')
    source_files(files)
    for name, expected in {**REGISTRATION_SOURCE_SHA256, **control}.items():
        require(name in files and sha256(files[name][0]) == expected
            and files[name][1] == ('100644' if name in SOURCE_PAIR else modes[name]), 'CANDIDATE_SOURCE_CHANGED')
    require(files.get(PROFILE_FILE) == (profile_raw, '100644')
        and files.get(BASELINE_CARRIER_FILE) == (carrier_raw, '100644'), 'CARRIER_CHANGED')
    parameters = {target: baseline[source] for target, source in (('current', 'current'), ('commit', 'commit'),
        ('tree', 'sourceTree'), ('run', 'deploymentRun'), ('controllerSha256', 'controllerSha256'))}
    frozen = {'version': 1, 'schemaSha256': value['schemaSha256'], 'baselineCarrierSha256': sha256(carrier_raw),
        'baselineRawSha256': value['baselineRawSha256'], 'baselineCanonicalSha256': value['baselineCanonicalSha256'],
        'formalProducerEvidenceSha256': value['formalProducerEvidenceSha256'], 'parameters': parameters,
        'baseline95': old, 'baseline95CanonicalSha256': value['baseline95CanonicalSha256'], 'proProfile': pro,
        'proProfileRawSha256': value['proProfileRawSha256'], 'proProfileCanonicalSha256': value['proProfileCanonicalSha256'],
        'sealed95WorkerProjection': value['sealed95WorkerProjection'], 'taskBinding': value['taskBinding'], 'handoff': value['handoff'],
        'registrationSourceCommit': REGISTRATION_SOURCE_COMMIT, 'registrationSourceSha256': clone(REGISTRATION_SOURCE_SHA256),
        'buildInputSha256': value['buildInputSha256'], 'candidate': candidate, 'controlSourceSha256': control,
        'sourceModes': modes, 'financeFrozen': value['financeBaseline']}
    validate_frozen(frozen); validate_baseline(baseline_raw, frozen)
    finance = keys(value['financeBaseline'], FINANCE_KEYS, 'FINANCE_FROZEN_INVALID')
    actual_gate = baseline['manifest']['dataAuditBefore']['registrationFinanceGate']
    require(FINANCE_KEYS <= set(actual_gate) and finance == {n: actual_gate[n] for n in FINANCE_KEYS}, 'FINANCE_BASELINE_CHANGED')
    measured_public = public_hash_map(value['currentPublicSourceMap'])
    require({'fileCount': len(measured_public), 'sha256': canonical_sha256(measured_public, ascii=False)}
        == baseline['publicSourceMap']['current'], 'CARRIER_PUBLIC_MAP_CHANGED')
    projection = clone(frozen['sealed95WorkerProjection'])
    projection.update({n: {'mode': '100644', 'sha256': h} for n, h in REGISTRATION_SOURCE_SHA256.items()})
    validate_profile(profile_raw, frozen, baseline, projection, require_enabled=True)
    return frozen, baseline_raw, baseline, projection


def file_identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_nlink,
        metadata.st_uid, metadata.st_gid, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)


def read_actual_file(path, *, modes=(0o400, 0o600), limit=BASELINE_MAX_BYTES, owner=None):
    """No links, stable fstat before/after and ownership; never return raw errors."""
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and path.parent.resolve() == path.parent, 'FILE_LOCATION_INVALID')
    descriptor = None
    try:
        initial = path.lstat()
        require(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1 and stat.S_IMODE(initial.st_mode) in modes
            and initial.st_uid == (os.geteuid() if owner is None else owner)
            and 0 <= initial.st_size <= limit, 'FILE_IDENTITY_INVALID')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        require(file_identity(initial) == file_identity(before), 'FILE_IDENTITY_CHANGED')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == before.st_size and file_identity(before) == file_identity(os.fstat(descriptor))
            == file_identity(path.lstat()), 'FILE_IDENTITY_CHANGED')
        return raw
    except OSError:
        raise Registration96Error('FILE_UNAVAILABLE') from None
    finally:
        if descriptor is not None: os.close(descriptor)


def write_private_file(path, raw, *, exclusive=True, mode=0o600):
    path = Path(path); checked_bytes(raw, 8 * 1024 * 1024)
    require(exclusive is True and path.is_absolute() and path.parent.resolve() == path.parent and mode in (0o400, 0o600), 'FILE_LOCATION_INVALID')
    descriptor = None
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
            | (os.O_EXCL if exclusive else os.O_TRUNC), mode)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.geteuid(), 'FILE_IDENTITY_INVALID')
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(raw); stream.flush(); os.fsync(descriptor)
    except OSError:
        raise Registration96Error('PRIVATE_WRITE_FAILED') from None
    finally:
        if descriptor is not None: os.close(descriptor)
    require(read_actual_file(path, modes=(mode,), limit=8 * 1024 * 1024) == raw, 'PRIVATE_WRITE_CHANGED')


def parse96_arguments(argv):
    require(type(argv) in (list, tuple) and all(type(x) is str for x in argv), 'CLI_ARGUMENTS_INVALID')
    selectors = {'--check-fixed-registration-scope': 'scope', '--prepare-fixed-registration-build': 'build',
        '--registration-build-proof': 'build', '--check-fixed-registration-deployment': 'readback',
        '--registration-readback': 'readback', '--registration-worker-96': 'release'}
    allowed = frozenset(('registration-profile', 'registration96-baseline-sha256', 'registration96-baseline-path',
        'registration96-candidate-archive', 'commit', 'source-tree', 'repository', 'expected-current', 'run-id',
        'run-attempt', 'ci-run-id', 'image-commit', 'image-run-id', 'image-run-attempt',
        'registration-profile-sha256', 'registration96-budget-seconds'))
    result, action, index = {}, None, 0
    while index < len(argv):
        token = argv[index]
        if token in selectors:
            require(action is None, 'CLI_SCOPE_MIXED'); action = selectors[token]; index += 1; continue
        require(token.startswith('--') and token[2:] in allowed and token[2:] not in result
            and index + 1 < len(argv) and not argv[index + 1].startswith('--'), 'CLI_ARGUMENTS_INVALID')
        result[token[2:]] = argv[index + 1]; index += 2
    require(action is not None and result.get('registration-profile', PROFILE_ID) == PROFILE_ID
        and digest(result.get('registration96-baseline-sha256')), 'CLI_BINDING_INVALID')
    if action != 'release': require(result.get('registration-profile') == PROFILE_ID, 'CLI_BINDING_INVALID')
    if action == 'release':
        require(all(result.get(n) for n in ('commit', 'source-tree', 'repository', 'expected-current', 'run-id', 'run-attempt', 'ci-run-id')),
            'CLI_BINDING_INVALID')
    for n in ('commit', 'source-tree', 'expected-current', 'image-commit'):
        if n in result: require(digest(result[n], 40), 'CLI_BINDING_INVALID')
    for n in ('run-id', 'run-attempt', 'ci-run-id', 'image-run-id', 'image-run-attempt'):
        if n in result: require(re.fullmatch(r'[1-9][0-9]{0,19}', result[n]), 'CLI_BINDING_INVALID')
    for n in ('registration-profile-sha256',):
        if n in result: require(digest(result[n]), 'CLI_BINDING_INVALID')
    if 'repository' in result:
        require(result['repository'] == '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release', 'CLI_BINDING_INVALID')
    for image, original in (('image-commit', 'commit'), ('image-run-id', 'run-id'), ('image-run-attempt', 'run-attempt')):
        require(image not in result or result[image] == result.get(original), 'CLI_IMAGE_REUSE_FORBIDDEN')
    if action in ('scope', 'build', 'release') and 'expected-current' in result:
        require(result['expected-current'] == CURRENT_COMMIT, 'CLI_BINDING_INVALID')
    if action == 'readback': require(all(n in result for n in ('expected-current', 'source-tree', 'registration-profile-sha256')), 'CLI_BINDING_INVALID')
    return action, result


def local_git(root, *arguments, binary=False):
    try:
        result = subprocess.run(['git', '-C', str(root), *arguments], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise Registration96Error('LOCAL_SOURCE_UNAVAILABLE') from None
    require(result.returncode == 0 and len(result.stdout) <= 64 * 1024 * 1024, 'LOCAL_SOURCE_UNAVAILABLE')
    return result.stdout if binary else result.stdout.decode().strip()


def runtime_cli_metadata(options, *, root=None, manifest=None):
    """All values have actual CLI/environment/Git or actual-manifest provenance."""
    if manifest is not None:
        for key, actual in (('expected-current', manifest['commit']), ('source-tree', manifest['sourceTree'])):
            require(options.get(key) == actual, 'READBACK_BINDING_CHANGED')
        return {'commit': manifest['commit'], 'tree': manifest['sourceTree'], 'run': manifest['deploymentRun'],
            'ciRunId': manifest['ciWorkflowRunId'], 'archiveSha256': manifest['sourceArchiveSha256']}
    require(root is not None, 'CLI_METADATA_MISSING')
    commit = options.get('commit') or os.environ.get('RELEASE_COMMIT') or local_git(root, 'rev-parse', 'HEAD')
    tree = options.get('source-tree') or os.environ.get('SOURCE_TREE') or local_git(root, 'rev-parse', commit + '^{tree}')
    require(commit == local_git(root, 'rev-parse', 'HEAD') and tree == local_git(root, 'rev-parse', commit + '^{tree}'), 'LOCAL_SOURCE_CHANGED')
    run = options.get('run-id') or os.environ.get('GITHUB_RUN_ID')
    attempt = options.get('run-attempt') or os.environ.get('GITHUB_RUN_ATTEMPT')
    ci = options.get('ci-run-id') or os.environ.get('CI_RUN_ID') or os.environ.get('QUALITY_GATE_RUN_ID')
    require(digest(commit, 40) and digest(tree, 40) and all(type(v) is str and re.fullmatch(r'[1-9][0-9]{0,19}', v) for v in (run, attempt, ci)), 'CLI_METADATA_MISSING')
    return {'commit': commit, 'tree': tree, 'run': 'github-actions-' + run + '-' + attempt, 'ciRunId': int(ci)}


def inspect_rows(text):
    require(type(text) is str and 0 < len(text.encode()) <= 1024 * 1024, 'INSPECT_OUTPUT_INVALID')
    rows = closed_json(b'{"rows":' + text.encode() + b'}', limit=1024 * 1024 + 16)['rows']
    require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'INSPECT_OUTPUT_INVALID')
    return rows


class Registration96IO:
    """Concrete finite I/O, with verified old low-level helpers only.

    It never imports a historical controller, calls a history validator, or
    fabricates observations from profile values. Secrets remain in child RAM.
    """
    def __init__(self, parent, *, production, budget=3000):
        require(type(parent) is dict and type(production) is bool and type(budget) is int
            and 60 <= budget <= 3300, 'ADAPTER_ARGUMENTS_INVALID')
        self.production, self.parent = production, parent
        self.start, self.end, self.rollback = time.monotonic(), time.monotonic() + budget, False
        self.reserve = 600 if production and budget >= 1200 else 0
        self.cap = {n: parent[n] for n in PARENT_CAPABILITIES if callable(parent.get(n))}
        require(set(self.cap) == PARENT_CAPABILITIES, 'ADAPTER_HELPERS_MISSING')
        controller = Path(parent.get('__file__', '')).absolute()
        require(controller.name == 'remote-deploy.py' and controller.resolve() == controller, 'ADAPTER_LOCATION_INVALID')
        self.base = Path(parent.get('BASE', '/opt/id-business-v2'))
        require(str(self.base) == '/opt/id-business-v2', 'ADAPTER_LOCATION_INVALID')
        self.staged = controller.parent.parent == self.base / '.staging'
        require(not self.staged or re.fullmatch(r'oidc-[a-f0-9]{40}', controller.parent.name), 'ADAPTER_LOCATION_INVALID')
        require(self.staged or controller.parent.name == 'production-release' and controller.parent.parent.name == 'scripts', 'ADAPTER_LOCATION_INVALID')
        self.root = None if self.staged else controller.parents[2]
        self.transport = controller.parent
        self.owner = 0 if production else os.geteuid()
        require(not production or os.geteuid() == 0, 'ADAPTER_OWNER_INVALID')
        self.lock = None; self.cleanup_failures = []; self.observed_files = {}; self.absence_identity = None; self.frozen = self.baseline = self.projection = None

    def deadline(self, minimum=0):
        # Reserve600s for a bounded rollback; read-only collectors have no reserve.
        remaining = self.end - time.monotonic()
        require(remaining > minimum + (self.reserve if not self.rollback else 0), 'ADAPTER_BUDGET_EXHAUSTED')
        return remaining

    def call(self, name, *args, **kwargs):
        remaining = self.deadline()
        if 'timeout' in kwargs: kwargs['timeout'] = max(1, min(kwargs['timeout'], int(remaining)))
        return self.cap[name](*args, **kwargs)

    def read(self, path, *, private=False, modes=None, limit=8 * 1024 * 1024):
        self.deadline()
        owner = self.owner
        node = self.production and self.baseline is not None and self.frozen is not None and str(path) in {
            str(Path(d) / n) for d in (self.frozen['parameters']['current'], PREVIOUS_DIRECTORY) for n in NODE_PRIVATE_FILES}
        allowed = modes or ((0o400, 0o600, 0o644) if private else (0o644, 0o664, 0o755, 0o775))
        if node: owner, allowed = 1000, (0o400,)
        identity = file_identity(Path(path).lstat())
        raw = read_actual_file(Path(path), modes=allowed, limit=limit, owner=owner)
        require(file_identity(Path(path).lstat()) == identity, 'OBSERVED_FILE_CHANGED')
        measured = (raw, allowed, limit, identity, owner)
        require(str(path) not in self.observed_files or self.observed_files[str(path)] == measured, 'OBSERVED_FILE_CHANGED')
        self.observed_files[str(path)] = measured
        return raw

    def unchanged(self):
        for name, (raw, modes, limit, identity, owner) in self.observed_files.items():
            require(file_identity(Path(name).lstat()) == identity
                and read_actual_file(Path(name), modes=modes, limit=limit, owner=owner) == raw, 'OBSERVED_FILE_CHANGED')

    def bound_path(self, name):
        return self.transport / Path(name).name if self.staged else self.root / name

    def read_bindings(self, options):
        carrier_path = self.bound_path(BASELINE_CARRIER_FILE)
        if 'registration96-baseline-path' in options:
            require(Path(options['registration96-baseline-path']).absolute() == carrier_path, 'CARRIER_LOCATION_CHANGED')
        carrier = self.read(carrier_path, limit=BASELINE_MAX_BYTES)
        require(sha256(carrier) == options['registration96-baseline-sha256'], 'CARRIER_CHANGED')
        return carrier, self.read(self.bound_path(PROFILE_FILE), limit=PROFILE_MAX_BYTES)

    def archive(self, commit, *, local=False):
        require(commit in {WORKER_BASIS_COMMIT, REGISTRATION_SOURCE_COMMIT, *CARRIED_SOURCE_COMMITS.values()}
            or self.frozen is not None and commit == self.frozen['candidate']['commit'], 'ARCHIVE_SCOPE_INVALID')
        if local:
            return local_git(self.root, 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit, binary=True)
        self.deadline(65)
        return checked_bytes(self.cap['registration_download'](commit), 64 * 1024 * 1024)

    def parse_archive(self, raw, commit):
        return source_files(self.cap['registration_archive'](raw, commit))

    def prepare(self, action, options):
        carrier, profile = self.read_bindings(options)
        if action == 'readback':
            current = self.current()
            manifest = closed_json(self.read(current / 'release-manifest.json', private=True))
            metadata = runtime_cli_metadata(options, manifest=manifest)
            require(sha256(profile) == options['registration-profile-sha256'], 'READBACK_BINDING_CHANGED')
        elif action == 'release':
            metadata = {'commit': options['commit'], 'tree': options['source-tree'],
                'run': 'github-actions-' + options['run-id'] + '-' + options['run-attempt'], 'ciRunId': int(options['ci-run-id'])}
        else: metadata = runtime_cli_metadata(options, root=self.root)
        if 'registration96-candidate-archive' in options:
            target = Path(options['registration96-candidate-archive']).absolute()
            allowed_root = self.transport if self.staged else self.root / '.deploy/production-release'
            require(target.parent == allowed_root and target.name == 'registration96-candidate.tar.gz', 'ARCHIVE_LOCATION_INVALID')
            archive = self.read(target, modes=(0o400, 0o600, 0o644), limit=64 * 1024 * 1024)
        elif action in ('scope', 'build'):
            archive = local_git(self.root, 'archive', '--format=tar', '--prefix=id-business-system-' + metadata['commit'] + '/', metadata['commit'], binary=True)
        else:
            self.deadline(65)
            archive = self.cap['registration_download'](metadata['commit'])
        checked_bytes(archive, 64 * 1024 * 1024)
        require('archiveSha256' not in metadata or metadata['archiveSha256'] == sha256(archive), 'ARCHIVE_CHANGED')
        metadata['archiveSha256'] = sha256(archive)
        candidate = self.parse_archive(archive, metadata['commit'])
        frozen, baseline_raw, baseline, projection = carrier_context(carrier, profile, metadata, candidate)
        assert_enabled(frozen)
        # Verify transported control/module bytes as well as their archive source.
        for name in CONTROL_FILES:
            if self.staged and name not in ('scripts/production-release/remote-deploy.py', 'scripts/production-release/registration-onboarding-96.py'): continue
            raw = self.read(self.bound_path(name))
            require(sha256(raw) == frozen['controlSourceSha256'][name], 'CONTROL_TRANSPORT_CHANGED')
        module_bytes(candidate['scripts/production-release/registration-onboarding-96.py'][0])
        carrier_bytes(candidate['scripts/production-release/remote-deploy.py'][0])
        self.frozen, self.baseline, self.projection = frozen, baseline, projection
        self.carrier_raw, self.profile_raw, self.baseline_raw, self.candidate, self.candidate_archive = carrier, profile, baseline_raw, candidate, archive
        self.unchanged()
        return frozen

    def build(self):
        basis_raw = self.archive(WORKER_BASIS_COMMIT, local=not self.production)
        carried = {}
        for commit in sorted(set(CARRIED_SOURCE_COMMITS.values())):
            files = self.parse_archive(self.archive(commit, local=not self.production), commit)
            carried.update({n: files[n] for n, c in CARRIED_SOURCE_COMMITS.items() if c == commit and n in files})
        worker, projection = build_from_archives(self.candidate_archive, basis_raw, self.frozen, self.baseline,
            self.cap['registration_archive'], carried={'files': carried, 'sourceCommits': CARRIED_SOURCE_COMMITS})
        return worker, projection

    def current(self):
        current = (self.base / 'current').resolve()
        require(current.parent == self.base / 'releases' and current.resolve() == current and not current.is_symlink(), 'CURRENT_LOCATION_INVALID')
        return current

    def public(self, directory):
        directory = Path(directory); require(directory.resolve() == directory, 'FILE_LOCATION_INVALID')
        result, total = {}, 0
        paths = list(directory.rglob('*')); require(len(paths) <= 7000, 'PUBLIC_MAP_INVALID')
        for path in paths:
            require(not path.is_symlink(), 'PUBLIC_MAP_INVALID')
            if path.is_dir(): continue
            name = path.relative_to(directory).as_posix()
            if name in PRIVATE_FILES: continue
            require(safe_name(name) and len(result) < 5000, 'PUBLIC_MAP_INVALID')
            raw = self.read(path); total += len(raw)
            require(total <= 64 * 1024 * 1024, 'PUBLIC_MAP_INVALID')
            mode = stat.S_IMODE(path.lstat().st_mode)
            require(mode in (0o644, 0o755) or name == 'docker-compose.aws-mysql.yml' and mode == 0o664, 'PUBLIC_MAP_INVALID')
            result[name] = (raw, '100' + format(mode, 'o'))
        return source_files(result, public=True)

    def states(self, directory):
        states = {}
        for service in sorted(SERVICES):
            cid = self.call('compose', Path(directory), 'ps', '-q', service, timeout=20)
            require(digest(cid), 'SERVICE_STATE_INVALID')
            rows = inspect_rows(self.call('run', 'docker', 'inspect', cid, timeout=20))
            require(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == cid, 'SERVICE_STATE_INVALID')
            row = rows[0]; config, state = row['Config'], row['State']
            env, started = config.get('Env'), state.get('StartedAt')
            require(type(env) is list and bool(env) and all(type(v) is str for v in env)
                and type(started) is str and 0 < len(started) <= 128, 'SERVICE_STATE_INVALID')
            states[service] = {'containerId': cid, 'image': row['Image'], 'reference': config['Image'],
                'status': state['Status'], 'health': state.get('Health', {}).get('Status'),
                'startedAtSha256': sha256(started.encode()), 'environmentSha256': canonical_sha256(sorted(env)),
                'configurationSha256': configuration_sha256(row)}
            require(self.call('compose', Path(directory), 'ps', '-q', service, timeout=20) == cid, 'SERVICE_STATE_CHANGED')
        return validate_states(states)

    def docker_json(self, cid, language, code, *, timeout=30, cap=BASELINE_MAX_BYTES):
        require(digest(cid) and language in ('python', 'node') and type(code) is str, 'PROBE_INVALID')
        argv = ('docker', 'exec', '-i', cid, 'python', '-B', '-') if language == 'python' else ('docker', 'exec', '-i', cid, 'node')
        text = self.call('run', *argv, input_data=code, timeout=timeout)
        require(type(text) is str and len(text.encode()) <= cap, 'PROBE_OUTPUT_INVALID')
        return closed_json(text.encode(), limit=cap)

    def worker_source(self, states, service, names):
        require(service in ('auto-registration', 'auto-recharge') and len(names) == 60 and all(safe_name(n) for n in names), 'PROBE_INVALID')
        code = 'import hashlib,json\nfrom pathlib import Path\nnames=' + repr(sorted(names)) + '\nprint(json.dumps({n:hashlib.sha256((Path("/app")/n).read_bytes()).hexdigest() for n in names}))'
        return hash_map(self.docker_json(states[service]['containerId'], 'python', code, cap=16384), names=names, cap=60)

    def api4(self, states):
        names = sorted(API_COMPILED_FILES)
        code = 'const fs=require("node:fs"),c=require("node:crypto");const names=' + json.dumps(names) + ';console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash("sha256").update(fs.readFileSync("/app/"+n)).digest("hex")]))));'
        return hash_map(self.docker_json(states['api']['containerId'], 'node', code, cap=4096), names=names)

    def content(self, states, service):
        roots = '/app/apps/api/dist /app/packages/shared/dist' if service == 'api' else '/usr/share/nginx/html'
        code = 'set -eu; export LC_ALL=C; for p in ' + roots + '; do test -d "$p"; done; files="$(find ' + roots + ' -type f -exec sha256sum {} +)"; printf \'%s\\n\' "$files" | sort'
        raw = self.call('run', 'docker', 'exec', states[service]['containerId'], '/bin/sh', '-c', code, timeout=30)
        require(type(raw) is str and len(raw.encode()) <= 8 * 1024 * 1024, 'CONTENT_INVALID')
        lines = raw.splitlines(); prefixes = tuple(n + '/' for n in roots.split())
        require(0 < len(lines) < 30000 and all(re.fullmatch(r'[a-f0-9]{64}  /[^\r\n]+', n)
            and n[66:].startswith(prefixes) for n in lines), 'CONTENT_INVALID')
        return {'fileCount': len(lines), 'sha256': sha256(('\n'.join(lines) + '\n').encode())}

    def health(self, states):
        # Token is resolved only inside the current container and never returned.
        code = '''import json,os
from urllib.request import Request,build_opener,HTTPRedirectHandler
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
request=Request('http://127.0.0.1:8051/registration/health',headers={'X-Recharge-Worker':os.environ['AUTO_RECHARGE_WORKER_TOKEN']})
with build_opener(NoRedirect).open(request,timeout=10) as response: raw=response.read(16385)
if len(raw)>16384: raise ValueError()
value=json.loads(raw)
names=['ready','registrationBusy','registrationWindowRetained','workerRole','engine','mailDeliveryVersion']
print(json.dumps({n:value[n] for n in names}))'''
        return validate_health(self.docker_json(states['auto-registration']['containerId'], 'python', code, cap=16384))

    def running(self, directory):
        states = self.states(directory)
        reg_names = self.baseline['actualRegistrationWorkerSourceSha256']
        pro_names = self.baseline['actualRechargeWorkerSourceSha256']
        result = {'liveServices': states, 'actualRegistrationWorkerSourceSha256': self.worker_source(states, 'auto-registration', reg_names),
            'actualRechargeWorkerSourceSha256': self.worker_source(states, 'auto-recharge', pro_names),
            'actualApiCompiledSourceSha256': self.api4(states), 'apiAdminContentProof': {n: self.content(states, n) for n in ('api', 'admin')},
            'workerHealth': self.health(states)}
        require(self.states(directory) == states, 'SERVICE_STATE_CHANGED')
        return result

    def stored_audits(self, directory):
        reports, summaries = {}, {}
        for stage in ('before', 'after'):
            raw = self.read(Path(directory) / (stage + '-audit.json'), private=True)
            report = closed_json(raw)
            validate_audit(report, stage, self.frozen, self.baseline,
                before=reports.get('before') if stage == 'after' else None,
                require_zero_report=self.cap['require_registration_zero_report'])
            reports[stage] = report
            summaries[stage] = {'rawSha256': sha256(raw), 'checkCount': report['checkCount'], 'violationCount': report['violationCount'],
                'checksSha256': canonical_sha256(report['checks']), 'identitySha256': canonical_sha256(report['identity']),
                'gateSha256': canonical_sha256(report['gate'])}
        return reports, summaries

    def task_snapshot(self, states):
        binding = self.frozen['taskBinding']
        code = TASK_READ_PROBE.replace('__PARAMETERS__', json.dumps(binding, sort_keys=True, separators=(',', ':')))
        return validate_task_snapshot(self.docker_json(states['api']['containerId'], 'node', code, cap=16384), binding)

    def audit49(self, directory, release, stage, before):
        """Fresh SELECT-only49 with the retained, independently measured finance inputs.

        The historical review seal governs its own9 fields. New96 commit/tree,
        image and build run belong to candidate/imageMetadata, never this gate.
        No historical archive or controller is reconstructed here.
        """
        require(stage in ('before', 'after') and (before is None) == (stage == 'before'), 'AUDIT_STAGE_INVALID')
        self.deadline(270)
        directory, release = Path(directory), Path(release)
        current = Path(self.baseline['current']); fv = self.frozen['proProfile']['financeValidator']
        policy_path = current / ('deploy/aws/' + fv['policyId'] + '.json')
        policy_raw = self.read(policy_path)
        policy = closed_json(policy_raw)
        require(sha256(policy_raw) == fv['policyRawSha256'] and canonical_sha256(policy) == fv['policyCanonicalSha256'], 'FINANCE_POLICY_CHANGED')
        seal_path, cleanup_path = current / 'order-archive-seal.reader.json', current / 'order-archive-cleanup.reader.json'
        seal_raw, cleanup_raw = self.read(seal_path, private=True), self.read(cleanup_path, private=True)
        require(sha256(seal_raw) == fv['releaseSealSha256'] and sha256(cleanup_raw) == fv['cleanupReceiptSha256'], 'FINANCE_REVIEW_CHANGED')
        seal = closed_json(seal_raw)
        finance = self.frozen['financeFrozen']
        measured = {n: seal[n] for n in FINANCE_KEYS if n != 'releaseSealSha256'}
        measured['releaseSealSha256'] = sha256(seal_raw)
        require(measured == finance, 'FINANCE_BASELINE_CHANGED')
        require(seal.get('policySha256') == canonical_sha256(policy)
            and seal.get('cleanupReceiptSha256') == sha256(cleanup_raw)
            and seal.get('candidateBindingsSha256') == canonical_sha256(policy['candidateBindings'])
            and policy['candidateBindings']['sourceTree'] == finance['sourceTree'], 'FINANCE_REVIEW_CHANGED')
        # Reuse the exact historical JS validators, from retained host bytes.
        library_names = ('v2-data-integrity-audit.mjs', 'v2-release-history-policy.mjs',
            'v2-historical-cash-adjustment-audit.mjs', 'v2-order-archive-release-policy.mjs')
        mounts = []
        for name in library_names:
            relative = 'scripts/lib/' + name
            expected = policy['candidateBindings']['sourceSha256'].get(relative)
            raw = self.read(current / relative)
            require(digest(expected) and sha256(raw) == expected, 'FINANCE_LIBRARY_CHANGED')
            mounts.extend(('-v', str(current / relative) + ':/app/scripts/lib/' + name + ':ro'))
        auditor = release / 'scripts/v2-registration-finance-audit.mjs'
        auditor_raw = self.read(auditor)
        require(sha256(auditor_raw) == self.frozen['proProfile']['controlSourceSha256'].get('scripts/v2-registration-finance-audit.mjs',
            self.baseline['fileSha256'][str(current / 'scripts/v2-registration-finance-audit.mjs')]), 'FINANCE_AUDITOR_CHANGED')
        override = release / 'registration-recovery-audit.compose.json'
        override_value = closed_json(self.read(override, private=True))
        audit_image = override_value['services']['api']['image']
        require(audit_image == finance['images']['api'], 'FINANCE_API_IMAGE_CHANGED')
        image = inspect_rows(self.call('run', 'docker', 'image', 'inspect', audit_image, timeout=20))
        require(type(image) is list and len(image) == 1 and image[0]['Id'] == audit_image
            and image[0]['Architecture'] == 'amd64', 'FINANCE_API_IMAGE_CHANGED')
        # Audit image may be the retained historical API image; current8154files
        # and full815content are observed separately by running()/readback().
        identity = self.call('registration_recovery_audit_reader', directory, override)
        folder = self.transport / ('registration96-audit-' + self.frozen['candidate']['run'].removeprefix('github-actions-')) if self.staged else self.root / '.deploy/production-release/registration96-audit'
        if not folder.exists(): folder.mkdir(mode=0o700)
        require(folder.resolve() == folder and not folder.is_symlink() and stat.S_IMODE(folder.stat().st_mode) == 0o700, 'AUDIT_LOCATION_INVALID')
        audit_profile = {'financeValidator': clone(fv), 'financeClearance': clone(self.frozen['proProfile']['financeClearance']),
            'baselineRelease': {'commit': finance['candidateCommit'], 'sourceTree': finance['candidateTree']}}
        def reader_copy(name, raw):
            target = folder / name
            if not target.exists():
                write_private_file(target, raw)
                os.chown(target, identity['uid'], identity['gid']); os.chmod(target, 0o400)
            require(read_actual_file(target, modes=(0o400,), owner=identity['uid']) == raw, 'AUDIT_READER_CHANGED')
            return target
        profile_path = reader_copy('finance-profile.json', private_json_bytes(audit_profile))
        policy_reader = reader_copy('policy.json', policy_raw)
        seal_reader = reader_copy('seal.json', seal_raw)
        cleanup_reader = reader_copy('cleanup.json', cleanup_raw)
        mounts.extend(('-v', str(auditor) + ':/registration-control/audit.mjs:ro', '-v', str(profile_path) + ':/registration-control/profile.json:ro',
            '-v', str(policy_reader) + ':/release-policy/policy.json:ro', '-v', str(seal_reader) + ':/release-order-archive-seal.json:ro',
            '-v', str(cleanup_reader) + ':/release-cleanup-receipt.json:ro'))
        arguments = ['node', '/registration-control/audit.mjs', '--profile=/registration-control/profile.json',
            '--policy=/release-policy/policy.json', '--stage=' + stage, '--seal=/release-order-archive-seal.json', '--cleanup-receipt=/release-cleanup-receipt.json']
        if stage == 'after':
            validate_audit(before, 'before', self.frozen, self.baseline, require_zero_report=self.cap['require_registration_zero_report'])
            before_reader = reader_copy('before.json', private_json_bytes(before))
            mounts.extend(('-v', str(before_reader) + ':/release-before-audit.json:ro'))
            arguments.append('--before-receipt=/release-before-audit.json')
        env = os.environ.copy()
        env['V2_DATA_INTEGRITY_DATABASE_URL'] = self.cap['maintenance_container_audit_url'](self.cap['environment_values'](directory / '.env.aws.production'))
        try:
            text = self.call('compose', directory, '-f', str(override), 'run', '--rm', '--no-deps', '--pull', 'never',
                *mounts, '-e', 'V2_DATA_INTEGRITY_DATABASE_URL', 'api', *arguments, env=env, timeout=240)
        finally: env.pop('V2_DATA_INTEGRITY_DATABASE_URL', None)
        report = closed_json(text.encode())
        validate_audit(report, stage, self.frozen, self.baseline, before=before,
            require_zero_report=self.cap['require_registration_zero_report'])
        write_private_file(release / (stage + '-audit.json'), private_json_bytes(report))
        self.unchanged()
        return report

    def file_rows(self, directories, names, *, skip=()):
        return {str(Path(d) / n): sha256(self.read(Path(d) / n, private=n in PRIVATE_FILES))
            for d in directories for n in sorted(names) if (str(d), n) not in skip}

    def baseline_observation(self):
        previous, current = Path(self.frozen['baseline95']['current']), Path(self.baseline['current'])
        require(self.current() == current, 'CURRENT_POINTER_CHANGED')
        pro = self.frozen['proProfile']; profile_file = 'deploy/aws/' + pro['id'] + '.json'
        self.baseline_absence()
        files = {n: sha256(self.read(Path(n), private=Path(n).name in PRIVATE_FILES)) for n in sorted(base_file_names(self.frozen))}
        raw = self.read(current / 'release-manifest.json', private=True); manifest = closed_json(raw)
        pro_raw = self.read(current / profile_file, limit=PROFILE_MAX_BYTES)
        _reports, audits = self.stored_audits(current)
        public = {str(d): source_map(self.public(d)) for d in (current, previous)}
        run = self.running(current); task = self.task_snapshot(run['liveServices'])
        record = {'version': 1, 'status': 'FINITE_POSTPRO_OBSERVED', 'readOnly': True, 'databaseWrites': 0,
            'windowRestarted': False, 'runtimeStable': True, 'current': str(current), 'commit': manifest['commit'],
            'sourceTree': manifest['sourceTree'], 'deploymentRun': manifest['deploymentRun'],
            # Receipt linkage is a supplied fixed pin, never a claim of provider observation.
            'formalProducerEvidenceSha256': self.frozen['formalProducerEvidenceSha256'],
            'controllerSha256': files[str(current / 'scripts/production-release/remote-deploy.py')],
            'profileRawSha256': sha256(pro_raw), 'profileCanonicalSha256': canonical_sha256(closed_json(pro_raw)),
            'manifest': manifest, 'manifestRawSha256': sha256(raw), 'manifestCanonicalSha256': canonical_sha256(manifest),
            'fileSha256': files, 'publicSourceMap': {'current': {'fileCount': len(public[str(current)]), 'sha256': canonical_sha256(public[str(current)], ascii=False)},
                'previous': {'fileCount': len(public[str(previous)]), 'sha256': canonical_sha256(public[str(previous)], ascii=False)}},
            **run, 'audits': audits, 'taskReadOnly': task, 'officialOtpAccepted': 'NOT_MEASURED',
            'businessAcceptanceConfirmed': False, 'historicalChainReexecuted': False}
        require(self.current() == current and self.running(current) == run
            and self.task_snapshot(run['liveServices']) == task, 'BASELINE_OBSERVATION_CHANGED')
        self.unchanged()
        self.baseline_absence()
        return private_json_bytes(record)

    def baseline_absence(self):
        self.deadline()
        directory = Path(self.baseline['current']); before = directory.lstat()
        require(directory.resolve() == directory and stat.S_ISDIR(before.st_mode), 'BASELINE_DIRECTORY_CHANGED')
        try: (directory / AUDIT_OVERRIDE).lstat()
        except FileNotFoundError: pass
        else: raise Registration96Error('BASELINE_PRIVATE_ARTIFACT_PRESENT')
        identity = file_identity(before)
        require(identity == file_identity(directory.lstat())
            and (self.absence_identity is None or self.absence_identity == identity), 'BASELINE_DIRECTORY_CHANGED')
        self.absence_identity = identity

    def lock_acquire(self):
        path = self.base / '.deploy.lock'
        try:
            self.lock = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            metadata = os.fstat(self.lock)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == 0, 'DEPLOYMENT_LOCK_INVALID')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Registration96Error('DEPLOYMENT_LOCK_UNAVAILABLE') from None

    def lock_assert(self):
        require(self.end - time.monotonic() > 0, 'ADAPTER_BUDGET_EXHAUSTED')
        require(self.lock is not None and file_identity(os.fstat(self.lock)) == file_identity((self.base / '.deploy.lock').lstat()), 'DEPLOYMENT_LOCK_CHANGED')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def lock_close(self):
        if self.lock is not None:
            descriptor, self.lock = self.lock, None
            try: fcntl.flock(descriptor, fcntl.LOCK_UN)
            except Exception: self.cleanup_failures.append('LOCK_UNLOCK_FAILED')
            try: os.close(descriptor)
            except Exception: self.cleanup_failures.append('LOCK_CLOSE_FAILED')

    def stage(self, release, runtime):
        self.deadline(900); require(self.current() == Path(self.baseline['current']), 'CURRENT_POINTER_CHANGED')
        self.cap['write_registration_files'](Path(release), runtime)
        name = 'docker-compose.aws-mysql.yml'
        if name in runtime and runtime[name][1] == '100664': (Path(release) / name).chmod(0o664)
        require(source_map(self.public(Path(release))) == source_map(runtime), 'RUNTIME_WRITE_CHANGED')
        for name in ('.env.aws.production', 'api-admin-build-proof.json', 'api-admin-preservation.json',
            'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json', 'registration-recovery-audit.compose.json'):
            origin = self.frozen['baseline95']['current'] if name == AUDIT_OVERRIDE else self.baseline['current']
            old = Path(origin) / name
            raw = self.read(old, private=True)
            require(sha256(raw) == self.baseline['fileSha256'][str(old)], 'PRESERVED_PRIVATE_CHANGED')
            mode = 0o400 if name.endswith('.reader.json') else 0o600
            write_private_file(Path(release) / name, raw, mode=mode)
        override = closed_json(self.read(Path(self.baseline['current']) / 'compose.release.json', private=True))
        override['services']['auto-registration']['image'] = image_reference(self.frozen)
        write_private_file(Path(release) / 'compose.release.json', private_json_bytes(override))

    def image(self, reference):
        require(reference == image_reference(self.frozen), 'IMAGE_SCOPE_INVALID')
        self.deadline(1000)
        registry = reference.split('/')[0]
        password = self.call('run', 'aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1', timeout=30)
        failed = False
        try:
            self.call('run', 'docker', 'login', '--username', 'AWS', '--password-stdin', registry, input_data=password, timeout=30)
            self.call('run', 'docker', 'pull', reference, timeout=900)
        except Exception:
            failed = True; raise
        finally:
            password = None
            try: self.call('run', 'docker', 'logout', registry, timeout=30)
            except Exception:
                self.cleanup_failures.append('IMAGE_LOGOUT_FAILED')
                if not failed: raise Registration96Error('IMAGE_LOGOUT_FAILED') from None
        return self.image_metadata(reference)

    def image_metadata(self, reference):
        rows = inspect_rows(self.call('run', 'docker', 'image', 'inspect', reference, timeout=20))
        require(type(rows) is list and len(rows) == 1, 'IMAGE_FIELDS_INVALID')
        value = rows[0]; labels = value['Config'].get('Labels') or {}
        return {'image': value['Id'], 'reference': reference, 'architecture': value['Architecture'],
            'revision': labels.get('org.opencontainers.image.revision'), 'workerProjectionSha256': labels.get('id-business-v2.worker-projection-sha256')}

    def backup(self, previous):
        self.deadline(650)
        result = validate_backup(self.cap['fresh_backup'](Path(previous)))
        write_private_file(self.release / 'backup-verification.json', private_json_bytes(result))
        return result

    def switch(self, release, reference, services):
        require(services == ('auto-registration',) and reference == image_reference(self.frozen), 'SERVICE_SCOPE_INVALID')
        self.deadline(500)
        self.call('compose', Path(release), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'auto-registration', timeout=300)

    def rollback_service(self, previous, release, states):
        self.rollback = True; self.deadline()
        self.cap['registration_rollback'](Path(previous), Path(release), states)

    def point(self, directory):
        self.lock_assert(); self.cap['point_current'](Path(directory), 'registration96-' + str(os.getpid()))

    def manifest_write(self, release, manifest):
        write_private_file(Path(release) / 'release-manifest.json', private_json_bytes(manifest))

    def readback(self, release):
        release = Path(release)
        # May run before/after publication; it never repoints or restarts anything.
        pointer = self.current(); require(pointer in (Path(self.baseline['current']), release), 'CURRENT_POINTER_CHANGED')
        raw = self.read(release / 'release-manifest.json', private=True)
        manifest = closed_json(raw); running = self.running(release)
        reports, _audits = self.stored_audits(release)
        public = source_map(self.public(release))
        files = self.file_rows((release,), readback_public_files(self.frozen) | PRIVATE_FILES)
        profile = self.read(release / PROFILE_FILE, limit=PROFILE_MAX_BYTES)
        module = self.read(release / 'scripts/production-release/registration-onboarding-96.py', limit=MODULE_MAX_BYTES)
        override = closed_json(self.read(release / 'compose.release.json', private=True))
        backup = validate_backup(closed_json(self.read(release / 'backup-verification.json', private=True)))
        receipt = {'version': 1, 'status': 'VERIFIED_REGISTRATION96_RUNTIME', 'readOnly': True, 'runtimeStable': True,
            'current': str(release), 'previous': manifest['previousRelease'], 'commit': manifest['commit'], 'sourceTree': manifest['sourceTree'],
            'deploymentRun': manifest['deploymentRun'], 'profileRawSha256': sha256(profile), 'moduleSha256': sha256(module),
            'manifest': manifest, 'manifestRawSha256': sha256(raw), 'manifestCanonicalSha256': canonical_sha256(manifest),
            'publicSourceMap': {'fileCount': len(public), 'sha256': canonical_sha256(public, ascii=False)}, 'fileSha256': files,
            **running, 'auditReports': reports, 'imageMetadata': self.image_metadata(manifest['images']['auto-registration']['reference']),
            'configurationProof': {'environmentFileSha256': files[str(release / '.env.aws.production')],
                'composeFileSha256': files[str(release / 'docker-compose.aws-mysql.yml')], 'overrideCanonicalSha256': canonical_sha256(override)},
            'backup': backup, 'officialOtpAccepted': 'NOT_MEASURED', 'businessAcceptanceConfirmed': False}
        require(self.current() == pointer and self.running(release) == running, 'READBACK_RUNTIME_CHANGED')
        self.unchanged(); return receipt

    def helpers(self):
        return {'assert_deployment_lock': self.lock_assert, 'observe_baseline': self.baseline_observation,
            'assert_release_jobs_idle': lambda d, s: self.call('assert_release_jobs_idle', Path(d), s),
            'assert_no_active_registration': lambda d: self.call('assert_no_active_registration', Path(d)),
            'stage_runtime': self.stage, 'audit49': self.audit49, 'require_registration_zero_report': self.cap['require_registration_zero_report'],
            'pull_registration_image': self.image, 'fresh_backup': self.backup, 'observe_current': lambda: str(self.current()),
            'switch_registration': self.switch, 'wait_healthy': lambda d, s: self.call('wait_healthy', Path(d), s),
            'registration_worker_hashes': lambda d, p: self.call('registration_worker_hashes', Path(d), p),
            'observe_running': self.running, 'write_manifest': self.manifest_write, 'point_current': self.point,
            'observe_readback': self.readback, 'registration_rollback': self.rollback_service}


def archive_tree(files):
    """Actual Git tree from parsed archive bytes, independent of CLI tree text."""
    source_files(files); tree = {}
    for name, (raw, mode) in files.items():
        parent, parts = tree, name.split('/')
        for part in parts[:-1]:
            existing = parent.setdefault(part, {})
            require(type(existing) is dict, 'ARCHIVE_TREE_INVALID'); parent = existing
        require(parts[-1] not in parent, 'ARCHIVE_TREE_INVALID')
        parent[parts[-1]] = (mode, hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).digest())
    def digest_tree(entries):
        rows = []
        for name, row in sorted(entries.items(), key=lambda item: (item[0] + ('/' if type(item[1]) is dict else '')).encode()):
            mode, oid = ('40000', digest_tree(row)) if type(row) is dict else row
            rows.append(mode.encode() + b' ' + name.encode() + b'\0' + oid)
        raw = b''.join(rows)
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).digest()
    return digest_tree(tree).hex()


def public_hash_map(value):
    require(type(value) is dict and 0 < len(value) <= 5000 and not (set(value) & PRIVATE_FILES), 'PUBLIC_MAP_INVALID')
    require(all(safe_name(n) and type(row) is list and len(row) == 2 and digest(row[0])
        and type(row[1]) is int and (row[1] in (0o644, 0o755) or n == 'docker-compose.aws-mysql.yml' and row[1] == 0o664) for n, row in value.items()), 'PUBLIC_MAP_INVALID')
    return value


def expected_runtime_map(carrier_raw, profile_raw, candidate, frozen, baseline):
    carrier = closed_json(carrier_raw)
    result = clone(public_hash_map(carrier['currentPublicSourceMap']))
    require({'fileCount': len(result), 'sha256': canonical_sha256(result, ascii=False)} == baseline['publicSourceMap']['current'], 'CARRIER_PUBLIC_MAP_CHANGED')
    updates = SOURCE_PAIR | CONTROL_FILES | {PROFILE_FILE, BASELINE_CARRIER_FILE}
    require(all(n in candidate for n in updates) and candidate[PROFILE_FILE] == (profile_raw, '100644')
        and sha256(candidate[BASELINE_CARRIER_FILE][0]) == frozen['baselineCarrierSha256'], 'CANDIDATE_SOURCE_CHANGED')
    for name in updates:
        raw, mode = candidate[name]
        result[name] = [sha256(raw), 0o755 if mode == '100755' else 0o644]
    return public_hash_map(result)


def validate96_readback_archive(value, carrier_raw, profile_raw, candidate_raw, registration_archive, metadata):
    """Offline full verification; no runtime reads, provider or historical chain."""
    keys(metadata, CANDIDATE_KEYS, 'CANDIDATE_BINDING_INVALID')
    require(callable(registration_archive) and sha256(checked_bytes(candidate_raw, 64 * 1024 * 1024)) == metadata['archiveSha256'], 'ARCHIVE_CHANGED')
    candidate = source_files(registration_archive(candidate_raw, metadata['commit']))
    require(archive_tree(candidate) == metadata['tree'], 'ARCHIVE_TREE_CHANGED')
    frozen, _raw, baseline, projection = carrier_context(carrier_raw, profile_raw, metadata, candidate)
    require(value.get('commit') == metadata['commit'] and value.get('sourceTree') == metadata['tree']
        and value.get('deploymentRun') == metadata['run'] and value.get('manifest', {}).get('ciWorkflowRunId') == metadata['ciRunId'], 'READBACK_BINDING_CHANGED')
    expected = expected_runtime_map(carrier_raw, profile_raw, candidate, frozen, baseline)
    return validate_readback(value, frozen, baseline, profile_raw, projection, None, runtime_map=expected)


def encode96_readback(value):
    raw = private_json_bytes(value); checked_bytes(raw, BASELINE_MAX_BYTES)
    envelope = {'encoding': 'gzip+base64', 'rawBytes': len(raw), 'sha256': sha256(raw),
        'data': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    require(len(json.dumps(envelope, separators=(',', ':')).encode()) <= 23000, 'READBACK_WIRE_TOO_LARGE')
    return envelope


def decode96_readback(envelope):
    keys(envelope, ('encoding', 'rawBytes', 'sha256', 'data'), 'READBACK_WIRE_INVALID')
    require(envelope['encoding'] == 'gzip+base64' and type(envelope['rawBytes']) is int
        and 0 < envelope['rawBytes'] <= BASELINE_MAX_BYTES and digest(envelope['sha256'])
        and type(envelope['data']) is str and len(envelope['data']) <= 23000, 'READBACK_WIRE_INVALID')
    try:
        compressed = base64.b64decode(envelope['data'], validate=True)
        require(base64.b64encode(compressed).decode() == envelope['data'], 'READBACK_WIRE_INVALID')
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(compressed, BASELINE_MAX_BYTES + 1)
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
            and len(raw) == envelope['rawBytes'] and sha256(raw) == envelope['sha256'], 'READBACK_WIRE_INVALID')
    except (ValueError, zlib.error):
        raise Registration96Error('READBACK_WIRE_INVALID') from None
    return closed_json(raw)


def write_build_context(io):
    worker, projection = io.build()
    root = io.root / '.deploy/production-release'
    root.mkdir(parents=True, exist_ok=True)
    require(root.resolve() == root and not root.is_symlink(), 'BUILD_OUTPUT_INVALID')
    target = root / 'registration-build-context'
    io.cap['write_registration_files'](target, worker)
    measured = source_map(io.public(target))
    require(measured == source_map(worker), 'BUILD_OUTPUT_CHANGED')
    receipt = build_receipt(io.frozen, projection)
    write_private_file(root / 'registration-build-projection.json', private_json_bytes(receipt))
    io.unchanged()
    return receipt


def registration96_cli(argv, parent_namespace):
    """The sole actual entry point; inactive pins exit before file/provider I/O."""
    io = None
    try:
        enabled_pins()
        action, options = parse96_arguments(argv)
        budget = options.get('registration96-budget-seconds', '3000' if action == 'release' else '210')
        require(re.fullmatch(r'[1-9][0-9]{1,3}', budget) and (1200 <= int(budget) <= 3300 if action == 'release' else 60 <= int(budget) <= 300), 'CLI_BUDGET_INVALID')
        io = Registration96IO(parent_namespace, production=action in ('release', 'readback'), budget=int(budget))
        io.prepare(action, options)
        require(archive_tree(io.candidate) == io.frozen['candidate']['tree'], 'ARCHIVE_TREE_CHANGED')
        if action == 'scope':
            print('REGISTRATION_PROFILE_VERIFIED'); return 0
        if action == 'build':
            receipt = write_build_context(io)
            print('REGISTRATION_PROJECTION_PREPARED ' + json.dumps(receipt, sort_keys=True, separators=(',', ':')))
            return 0
        # Actual current045 public bytes are the final runtime foundation.
        public = io.public(Path(io.baseline['current']))
        runtime = runtime_projection(public, io.candidate, io.profile_raw, io.frozen, io.baseline, io.projection)
        if action == 'readback':
            current = io.current()
            require(current.name.endswith('-' + io.frozen['candidate']['commit'][:12]), 'READBACK_BINDING_CHANGED')
            receipt = validate_readback(io.readback(current), io.frozen, io.baseline, io.profile_raw, io.projection, runtime)
            require(io.current() == current, 'CURRENT_POINTER_CHANGED')
            print('FIXED_REGISTRATION_RELEASE_VERIFIED ' + json.dumps(encode96_readback(receipt), sort_keys=True, separators=(',', ':')))
            return 0
        io.build()  # Independently close the fixed2f+7overlay+R3d pair before switch.
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        io.release = io.base / 'releases' / (stamp + '-' + io.frozen['candidate']['commit'][:12])
        require(not io.release.exists() and not io.release.is_symlink(), 'RELEASE_LOCATION_INVALID')
        io.lock_acquire()
        deployed_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        result = release_helpers(io.frozen, io.baseline_raw, io.profile_raw, io.projection, runtime,
            str(io.release), deployed_at, io.helpers(), public=public, candidate=io.candidate)
        io.lock_close()
        if io.cleanup_failures:
            result['cleanupFailures'] = io.cleanup_failures
            if result['status'] == 'REGISTRATION96_RUNTIME_VERIFIED': result['status'] = 'REGISTRATION96_CLEANUP_FAILED'
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        return 0 if result['status'] == 'REGISTRATION96_RUNTIME_VERIFIED' else 1
    except Registration96Error as error:
        if str(error) == 'REGISTRATION96_DISABLED':
            print(json.dumps({'status': 'REGISTRATION96_DISABLED', 'enabled': False,
                'productionOperations': 0, 'parametersGenerated': False}, sort_keys=True)); return 2
        # Only module-owned fixed reason codes are exposed, never provider text.
        reason = str(error) if re.fullmatch(r'[A-Z0-9_]{1,64}', str(error)) else 'REGISTRATION96_UNAVAILABLE'
        if io is not None: io.lock_close()
        print(json.dumps({'status': 'REGISTRATION96_UNAVAILABLE', 'reason': reason,
            'cleanupFailures': io.cleanup_failures if io is not None else [],
            'rawErrorSuppressed': True, 'businessAcceptanceConfirmed': False}, sort_keys=True)); return 1
    except Exception:
        if io is not None: io.lock_close()
        print(json.dumps({'status': 'REGISTRATION96_UNAVAILABLE', 'reason': 'ADAPTER_IO_FAILED',
            'cleanupFailures': io.cleanup_failures if io is not None else [],
            'rawErrorSuppressed': True, 'businessAcceptanceConfirmed': False}, sort_keys=True)); return 1
    finally:
        if io is not None: io.lock_close()


def main(argv=None):
    return registration96_cli(sys.argv[1:] if argv is None else argv, {})


# Fixed SELECT-only observer; no mail or secret columns are fetched.
TASK_READ_PROBE = gzip.decompress(base64.b64decode('H4sIAAAAAAAC/70YbW/bNvp7fwVTFJOE09SmwA445dye23pYdmkS2EkPh6LQaIm2ucikJlKJfZ7/+z0PSUmU4+xa4LAASUTyeX8ng0YxonTNcx2cPXv5klxKsqa8JL81rN7G5OrmOiYVVepB1kVM3kt5xxmRNbmBE7JgOl8l5GbFFcllwQjbsLzRTJHZ5GLy/kYRKcpt8iyXQmmyI9c1V2v6vuRMaLInI1Kz3xpeszD4R2WOXubmLIjOHE4FQII9DDDDHSnlMiWfv5B9B3gNgFl2PZ6OP05uJtNZlrUneb2ttPSZCRA1tds9J7WiAHNPy4aR0RuitxWTi3Y9GpEArSSWAfnuO7ublEws9Yq8dRySvGZUs5+oWoUBUHv9w1+DKGmqAjZDgxElBV8ypcNgxTZBRFIimrJsBaDa528/OBxQkaMkH4AM8j65bNZzVidcXdJLSzdZMn3D1yyMIpDGbml5PruaGZHDQ06CscLntSN8QcITKyPRq1o+kEldyzqMzsi+M5Cm6FnrjxkDLSBGGqBUN0IAG0IfKNfwkTETQd0SQqyGGKo1pyWEyboqmQa0HBUrS1YEiapKDvRIEPXu0Kw6xszSNn8zE3JVLRe8ZODdJQekGmDaeO0+sntW8wWHo/WC4m+/IRcLkK6T6qgs4FcFH740yH8uN5kGs8tGk6Kp6bxkmTFS1gh6DwC4QxayXsNGzXK5FPw/wNLyzqnmUmQuKAuimFK4UUpadGTbTcE06HGXMfSKU7W2BCq6ZFm+omKJPgB1eA52BjKwzoTUA1XtGS8gi7jeZmtMKkhhMm94Cb7KbP4i2QXIDzhziAVwX/bARSEfgCqYQ1bM8e5ciF7YbEEZXW+ByIo2Snu7Spb3KJ1dG4G2/dpg+UtabD13Zs7DGZoQcLdZxUSB8AM7AJem1GDpOyEfRO/6gQnQ9f7GUXf/KuczVrIc8xFSo0h13bDYhBwmt10CD1afuzMXDeOSU9XumUhoP1llv2wk2W+qNVtXuj1o1bXrVvxPTlDHZ0GHG7bkFGNHxRabblkCN3YLri7t2jnz2tqzFZTmuWyEdkvM92dUbUVOFo3I0bTE6Dpu9ErWGMCh3sTE6R+R3TNCrN1Mno9s3hO9SXCdLCBwfuQ1FL3dwwr0S3dgUIdsbNSoNKDA554FccFMEoL8WK72sTJuMChG1PvXKMW5C990156vIdymTDF97cxmwPf7GEWYypKpHraGZb/CEuKA8QdigNhiaJT5/XejVDLk+zZ5xC+CWNRNLciCloqddSaZcxupnlUUZFgNVKCMYHU0BroVHMpbZ6E7tk2D+9eZ2kJIrDPVQMJltFhzEfQ2MdXaiR71HA3wOZZ3x/ttYus8tA7X09xB4vU2Of8ViJredjKua7qF9mL+hwNgbC+DDeNj4Nb2l1YKNDLWS2O9zgnJmlbhBjvOJkGIBK0fgQVKiHx3QE5Mr/VU7nzixO80PGjK/r7hy9Ethm/VYE+25OLHxJ3vLCwXedkUTLXwALF/lBFK0EqtpIZU8DMAKofval68axQXUMM/vZ56tepnOT/mdojy60RTdXdedG7uapH1MXbuELmAvvAPOIC2LVK76QqLOXHf7VFfZuDUpDsabkVDg9cWgsii2uXMTDI9d6vdkZKAJNqq0IO3xA9rj+XhSrvl8bWyGDgzjCQrqgy4WUb2AOYGb59VZju02mP1BYIYrJjcrrF34HYdRV4+Oc7K9+sLMxxP6cMvdsyFHhETV7syGOPGM9JVstjrZP0knTFhhkZoSeczcnl1Qy5vLy4QsTtoS8s1NDaoOzHRUlcZVA+I1q9A/7igDpP8OL36CCJmcxeMGZQWGBj0stJZp96/fppMJ26uAnOsRi92aJGu6+1/6SPA4bgBGOx5iiZutz+/+mLjcuDHQ4jOQM4dnskXJV0+GoXbeAWvtevTwUJ08iF+6PPqPeB71mQdutWmNDAKd2tZNNAegqG1gtjCHO4ntNEy86eQJPiLBY1tRb2BkpUGgzkFrBK4U2i5NoljW0ZTL4W81r5bwiCBkydeAcLrBPjn7Fbn0aDwlxSK04oNApU2BdcX0jaZj1Rs21pj/oaBxQmiGOKM1e+26eddzzagKod+g2XJfn6JNb1j6emrV6ddFzoYQOgCzAxiUr8xGae04h0ETbuNbuqQvV519ByQ/6BjHUWJnmTmlcu/mSDVAwqdgl0hYpVd96Z3VeybTN8PtXOI0+JP8UErp/PB30dA5pWnh7kLGDU6yLY3j95sjvpn87Ve2Rz4YvO0B7AH+Mff0DoGVL+qnTmdD2uZbg+OxIDj/A79NogDw+BoEJiTgwjA4cdcdoLI81F3u5/RBTsXmi3B/AbdmM18vRm96r4fOREuft8UiJ4Yf0YZAOl6W1uDYWbiNsPLHYYaWH/jGf3ENexh1Pw/gvDKQCYwb6vB2UE09DOFH19mtoj8ARIHQUJwGDPDnKvt7T3PG83c5bCbXOwNsR1Y2ltiP5H87+shwh5uupY5uDUinLduQfqLI9geYbqNyL9FusN+J4rtw4DJhfTk5Nik114wfZguN/exsZlb4+3s4b35On2k81OTUfqo3z8FGcVHxqM/QO+BIienu/yku0H1SZ8ccuNB1UkfT7dx31DSJztPPKw46VPVyQmJGT2FhE537djS53jcDg9pP0fERph4gbd0JwakI5B+68tQ4sDtnUMsh9+fRgMYkyjp5yRJ2ocyA2mufYMO4pLnS6JkrcMoBgeLHKmk5gKNCt8zdeUerMbGRvjWZI+dnu0lbKbxoc09yziUK12NnWXTAAbk7ONkPLudTj4EgLo3V7rQ3OnCaPQG8/blSwJFkue0xFtBge/WBEY2oZwNialOhIt7eQdjN2QHnUMW9I9hhLev3oklZ17FCwn9VEjoDSXla0IJhAcQ+p6JhaxzIDSdjD+Qq8uLf2P5FszOou0DXdJVdTcMu7JeJS882awiUOutJt3bAwMWbGQx/AurLc9HDs4MtqnTP8+uLhN7ueaLbWhpYfs7ODCkIofpyqDZwx3sGkqWxjwXYL8yDaasYtT4a2rC0T10pq9/gC7Wj7P4OAChcyiGfYTAG3kURkmOORAaB/o4we55welSSKV5bp6xn6fPb8azf2bvrz5MMjR4dns5/jQ+vxi/u5g838MVH+Ith5k+YRuu30OyjE7P9vgwIWhZbr1A0fV217mg4Mr5LIzO9kaa3TFCqNZ/ASoP7HpoGQAA')).decode()


if __name__ == '__main__':
    raise SystemExit(main())
