"""Finite, independently witnessed completion of one failed ONLINE restore.

The old native seals and manifests remain cold. Inspection never clears a marker.
Recovery can only clear the original, byte-bound marker after proving an already
restored API/Admin under fresh guards; it never switches or removes a service.
"""

import argparse
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import stat
from types import SimpleNamespace


def load_runtime():
    import importlib.util
    path = Path(__file__).with_name('online-recharge-component-runtime.py')
    spec = importlib.util.spec_from_file_location('online_component_protected_recovery_runtime', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


r = load_runtime()
BASE = Path('/opt/id-business-v2')
TARGET_NAME = '20261014T095333Z-5f458e7ac7cd'
FAILED_PRODUCER = {'commit': '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53',
    'sourceTree': 'bcc614bd53dbf4ddf8e3d7d6ba85d5a4ed1f1a3a',
    'workflowRunId': '38544330141', 'workflowRunAttempt': '1'}
ORIGIN = {'failureCommandId': '81f7328e-d817-40ab-8fe9-19713b037667',
    'instanceId': 'i-05836da38606e633c',
    'failureNativeBytesSha256': 'ff3d67d6baffa4337c32de47cc3b9e2e372fc284102051ea0dbdd1550910b35e',
    'preflightBytesSha256': 'ca5361807d4cd42917b771e826ccf3f660e4d8ae4780490251dc3c033f6764a5',
    'preflightNativeBytesSha256': '883b7cfc8803048716465d7295a42c953549c2aca4371710efd1284b21f44cf0',
    'buildProofBytesSha256': '4111053a937b16d753e4ee58e7882bdcfd9b39a1cf292340bea0b61314a5949e',
    'manifestBytesSha256': 'd14d2c5570544a5ce6f44d5a5e9a1c93ecd16d2d86d8b7f44bd469ba2d8fe117',
    'markerBytesSha256': '2b5abc2e178ae86cf745e7542277cbf7a74cfdb19860284b8c9df4b32b9e7842',
    'auditRecordBytesSha256': '2874cc04626db9121788ddbee09e5852703512b3aa571f03cf5d898889bd6527',
    'sqliteReceiptBytesSha256': '67cae62ce6257080b5e7b2f3e4e02dfe7d942cd8531366b9cf7e5fb996e1d8a1',
    'sqliteProtectionSha256': 'd520caa7277432a03faa7b9133c5b2974fb4028e89787358c7c3b8878a6e54a3',
    'beforeAuditBytesSha256': '10d41231237fd7d948e72b35ba6ea06eec9befe645aea96ba6acf380a7369998',
    'afterAuditBytesSha256': '91ff62db7121d9786b4b183752b7adb8692c5b0c0be71d0e594ca1be1b28e5d8'}
RECORD = r.PREFIX + '-protected-recovery.json'
INTENT = r.PREFIX + '-protected-recovery-intent.json'
RECORD_KIND = r.KIND + '_PROTECTED_RECOVERY'
STATUS = 'ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_VERIFIED'
STATE_FIELDS = frozenset(('currentRelease', 'manifestBytesSha256', 'servicesAfter',
    'workspaceVolume', 'environmentFileSha256', 'appliedDatabase', 'onlineGrants',
    'sqliteProtectionSha256', 'sqliteReceiptBytesSha256', 'sqliteSourceSummarySha256',
    'auditRecordBytesSha256', 'historicalAuditSha256', 'freshStrictAudit',
    'backupInstallationSha256', 'markerAbsent', 'executorAbsent', 'preservedServiceCount'))
RETURN_FIELDS = frozenset(('version', 'scope', 'kind', 'status', 'producer', 'origin',
    'failedRelease', 'recoveryExecutor', 'recoveryHelperSha256', 'recoveryRecordBytesSha256',
    'state', 'originalMarkerCleared', 'onlinePublished', 'migrationPerformed',
    'databaseGrantsChanged', 'executionMigrationPlan', 'volumeDeletionPerformed',
    'businessActions', 'failedOperationBusinessActions'))


def need(value, code):
    r.need(value, 'PROTECTED_RECOVERY_' + code)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def require_root():
    need(os.getuid() == os.geteuid() == 0, 'ROOT_REQUIRED')


def validate_inputs(failure_raw, preflight_raw, proof_raw):
    """Authenticate the original bytes before loading any operational controller."""
    r.authority()
    need(all(type(raw) is bytes and 0 < len(raw) < 256 * 1024
             for raw in (failure_raw, preflight_raw, proof_raw)), 'INPUT_INVALID')
    for raw, key in ((failure_raw, 'failureNativeBytesSha256'),
                     (preflight_raw, 'preflightBytesSha256'), (proof_raw, 'buildProofBytesSha256')):
        need(r.c.digest(raw) == ORIGIN[key], 'INPUT_CHANGED')
    core = r.c.load_core(r.authority()['coreSha256'])
    _native, failure = r.validate_component_invocation(core, failure_raw,
        ORIGIN['failureCommandId'], ORIGIN['instanceId'], status='Failed')
    r.validate_failure_receipt(failure, FAILED_PRODUCER)
    need(failure['phase'] == 'protected-readback' and failure['servicesAttempted'] == ['admin', 'api', 'online-recharge']
         and failure['recovery'] == {'status': 'BLOCKED_OR_FAILED', 'sqliteMaintenanceRetained': True}
         and failure['publication'] == {'attempted': False, 'currentRole': 'PREDECESSOR', 'onlinePublished': False}
         and failure['businessActions'] is None, 'FAILURE_CHANGED')
    transport = core.closed_json(preflight_raw)
    pref = r.validate_preflight(core, transport, FAILED_PRODUCER, r.current_predecessor())
    need(transport['invocationBytesSha256'] == ORIGIN['preflightNativeBytesSha256']
         and pref['baseline']['manifestBytesSha256'] == ORIGIN['manifestBytesSha256'], 'PREFLIGHT_CHANGED')
    proof = core.closed_json(proof_raw)
    repository = proof['images']['api']['reference'].rsplit(':', 1)[0]
    r.validate_build(proof, FAILED_PRODUCER, proof['sourceProjection'], transport,
        proof['qualityRunId'], repository)
    return {'failureRaw': failure_raw, 'preflightRaw': preflight_raw, 'proofRaw': proof_raw}


def inputs(context):
    need(type(context) is dict and set(context) == {'failureRaw', 'preflightRaw', 'proofRaw'}, 'CONTEXT_CHANGED')
    validated = validate_inputs(context['failureRaw'], context['preflightRaw'], context['proofRaw'])
    core = r.c.load_core(r.authority()['coreSha256'])
    transport = core.closed_json(validated['preflightRaw'])
    return core, transport, transport['serverReceipt']['baseline'], core.closed_json(validated['proofRaw'])


def target_path(d):
    need(d.BASE == BASE and BASE.is_absolute() and BASE.resolve() == BASE, 'BASE_CHANGED')
    target = BASE / 'releases' / TARGET_NAME
    need(target.resolve() == target and target.is_dir() and not target.is_symlink(), 'TARGET_CHANGED')
    return target


def file_identity(path):
    row = path.lstat()
    return tuple(getattr(row, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_nlink',
        'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


class MemoryAuditReceipt:
    """Use the frozen audit implementation without creating an inspection file."""
    def __init__(self):
        self.raw = None

    def write_text(self, value):
        need(self.raw is None and type(value) is str and 0 < len(value) < 256 * 1024, 'AUDIT_OUTPUT_CHANGED')
        self.raw = value

    def chmod(self, mode):
        need(mode == 0o600 and self.raw is not None, 'AUDIT_OUTPUT_CHANGED')

    def read_text(self):
        need(self.raw is not None, 'AUDIT_OUTPUT_MISSING')
        return self.raw


def authenticate_executor(d, executor):
    need(type(executor) is dict and executor == r.producer(executor.get('commit'), executor.get('sourceTree'),
        executor.get('workflowRunId'), executor.get('workflowRunAttempt')), 'EXECUTOR_CHANGED')
    raw = d.registration_download(executor['commit'])
    files = d.registration_archive(raw, executor['commit'])
    core = r.c.load_core(r.authority()['coreSha256'])
    need(core.projection_module().source_tree(files) == executor['sourceTree'], 'EXECUTOR_TREE_CHANGED')
    path = Path(__file__).resolve()
    before = file_identity(path)
    source = path.read_bytes()
    mode = '100755' if path.stat().st_mode & 0o111 else '100644'
    need(files.get('scripts/production-release/' + path.name) == (source, mode)
         and before == file_identity(path), 'EXECUTOR_HELPER_CHANGED')
    return r.c.digest(source)


def audit_origin(d, core, workspace, target, evidence, sqlite_sha):
    path = target / (r.PREFIX + '-audit-protection.json')
    raw = core.private_bytes(path)
    need(r.c.digest(raw) == ORIGIN['auditRecordBytesSha256'], 'AUDIT_ORIGIN_CHANGED')
    value = core.closed_json(raw)
    fields = {'version', 'kind', 'basis', 'sourceApiIdentity', 'mysqlIdentitySha256',
        'initialQuerySha256', 'querySha256', 'historyQuerySha256', 'triggerDefinitionsSha256',
        'connectionIdSha256', 'before', 'after', 'oldApiStop', 'sqliteProtectionSha256'}
    need(type(value) is dict and set(value) == fields and type(value['version']) is int and value['version'] == 1
         and value['kind'] == r.KIND + '_AUDIT_PROTECTION'
         and value['basis'] == {'kind': r.KIND, 'ordinaryProducer': evidence['ordinaryProducer'],
             'ordinaryAuthoritySha256': evidence['ordinaryAuthoritySha256']}
         and value['before'] == value['after'] and value['before']['registrationMutationCount'] == 0
         and value['before']['onlineAuditCount'] == 0
         and value['before']['tables'] == {n: 0 for n in r.load('online-recharge-scope.py').TABLES}
         and value['mysqlIdentitySha256'] == r.c.fingerprint(evidence['services']['mysql'])
         and value['sqliteProtectionSha256'] == sqlite_sha
         and value['oldApiStop'] == {'identity': {n: evidence['services']['api'][n]
             for n in ('containerId', 'image', 'startedAtSha256')}, 'running': False, 'pid': 0}
         and all(value['sourceApiIdentity'][n] == evidence['services']['api'][n]
             for n in ('containerId', 'image', 'startedAtSha256')), 'AUDIT_ORIGIN_CHANGED')
    audits = []
    for name, origin_key in (('before-audit.json', 'beforeAuditBytesSha256'),
                             ('after-audit.json', 'afterAuditBytesSha256')):
        audit_raw = core.private_bytes(target / name)
        need(r.c.digest(audit_raw) == ORIGIN[origin_key], 'AUDIT_ORIGIN_CHANGED')
        result = workspace.audit_receipt(d, target / name)
        core.audit_guard(result)
        audits.append(result)
    need(audits[0]['checksSha256'] == audits[1]['checksSha256'], 'AUDIT_RULES_CHANGED')
    return value, {path: (raw, file_identity(path))}


def unchanged(saved):
    for path, (raw, identity) in saved.items():
        need(file_identity(path) == identity and path.read_bytes() == raw, 'RECORD_MOVED')


def _verify(d, context, *, marker_required):
    core, transport, evidence, proof = inputs(context)
    d, core, _admin, workspace, online = r.modules(d)
    target = target_path(d)
    previous = Path(evidence['currentRelease'])
    need(previous.parent == BASE / 'releases' and previous.resolve() == previous and previous != target
         and (BASE / 'current').resolve() == previous, 'CURRENT_CHANGED')
    manifest_raw = core.private_bytes(previous / 'release-manifest.json')
    need(r.c.digest(manifest_raw) == ORIGIN['manifestBytesSha256'], 'MANIFEST_CHANGED')
    records = r.predecessor_records(d, core, previous)
    ordinary = r.c.authenticate_component_records(*records)
    successor = r.c.authenticate_admin_records(core.private_bytes(r.current_native_path(d), cap=128 * 1024),
        manifest_raw, core.private_bytes(previous / 'admin-build-proof.json'), records)
    _old_reader, _old_files, old_archive_sha = r.original_controller(d, core, r.ordinary_directory(d, core, previous))
    _admin_reader, _admin_files, admin_archive_sha = r.admin_controller(d, core, previous)
    need(old_archive_sha == evidence['ordinaryArchiveSha256']
         and admin_archive_sha == evidence['currentArchiveSha256'], 'ARCHIVE_CHANGED')
    files, output, projection = r.source(d, FAILED_PRODUCER, evidence)
    r.validate_build(proof, FAILED_PRODUCER, projection, transport, proof['qualityRunId'],
        proof['images']['api']['reference'].rsplit(':', 1)[0])
    for name, (raw, mode) in output.items():
        path = target / name
        need(path.is_file() and not path.is_symlink() and path.read_bytes() == raw
             and ('100755' if path.stat().st_mode & 0o111 else '100644') == mode, 'FAILED_SOURCE_CHANGED')
    states = workspace.snapshot(d, previous)
    need(set(states) == set(r.c.SERVICES)
         and all(states[n] == evidence['services'][n] for n in r.PRESERVED)
         and all(states[n]['image'] == evidence['services'][n]['image']
             and states[n]['reference'] == evidence['services'][n]['reference']
             and states[n]['environmentSha256'] == evidence['services'][n]['environmentSha256']
             and core.configuration_model(d, states[n]) == evidence['configurationModels'][n]
             and states[n]['status'] == 'running' and states[n]['health'] == 'healthy' for n in ('api', 'admin')),
         'SERVICES_CHANGED')
    need(not d.compose(target, 'ps', '-q', '--all', 'online-recharge'), 'EXECUTOR_PRESENT')
    volume = workspace.workspace_volume(d, previous, attached=True)
    need(volume == evidence['workspaceVolume']
         and r.c.digest(core.private_bytes(previous / '.env.aws.production')) == evidence['environmentFileSha256'],
         'CONFIGURATION_CHANGED')
    for name in ('api', 'admin'):
        row = ordinary['proof']['images']['api'] if name == 'api' else successor['proof']['image']
        identity = r.authority()['producer'] if name == 'api' else r.current_authority()['producer']
        online.inspect_image(d, row, identity['commit'], identity['sourceTree'])
        metadata = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
        key = ('id-business-v2.unpublished-component-successor-projection-sha256' if name == 'api'
               else 'id-business-v2.admin-pending-projection-sha256')
        expected = r.authority()['projectionSha256'] if name == 'api' else r.current_authority()['projectionSha256']
        need(metadata.get('Config', {}).get('Labels', {}).get(key) == expected, 'IMAGE_PROJECTION_CHANGED')
        actual = online.content_summary(d, name, d.compose(previous, 'exec', '-T', name,
            '/bin/sh', '-c', online.content_command(name), timeout=30))
        need(actual == {k: row[k] for k in ('fileCount', 'sha256')}, 'RUNNING_CONTENT_CHANGED')
    workspace.jobs_idle(d, previous)
    workspace.workspace_idle(d, previous, legacy=False)
    workspace.workspace_audit_protection(d, previous)
    workspace.workspace_health(d, previous)
    online.require_fresh_resources(d, previous)
    applied = r.c.verify_applied_database(d, online, workspace, previous, predecessor_records=records,
        migration_plan=[], source_candidate=False)
    need(applied == evidence['appliedDatabase'], 'DATABASE_CHANGED')
    grants = r.verify_online_grants(d, online, previous)
    sqlite_path = target / workspace.WORKSPACE_SQLITE_RECEIPT
    sqlite_raw = core.private_bytes(sqlite_path)
    sqlite_record = core.closed_json(sqlite_raw)
    sqlite_sha = r.c.fingerprint(sqlite_record)
    need(r.c.digest(sqlite_raw) == ORIGIN['sqliteReceiptBytesSha256']
         and sqlite_sha == ORIGIN['sqliteProtectionSha256'], 'SQLITE_ORIGIN_CHANGED')
    workspace.workspace_sqlite_receipt(d, target, proof,
        {'before': evidence['services'], 'workspaceVolumeBefore': volume, 'workspaceVolumeAfter': volume,
         'sqliteProtectionSha256': sqlite_sha}, {'apiWorkspacePublication': {'sqliteProtectionSha256': sqlite_sha}})
    r.verify_live_sqlite(d, core, workspace, target, previous, states['api']['reference'], sqlite_sha)
    gate = workspace.WorkspaceSqliteProtection(d, previous, target, proof,
        SimpleNamespace(commit=FAILED_PRODUCER['commit'], run_id=FAILED_PRODUCER['workflowRunId'],
            run_attempt=FAILED_PRODUCER['workflowRunAttempt']), legacy=False)
    need(gate.volume == volume and gate.root.is_absolute() and gate.root.resolve() == gate.root
         and not gate.root.is_symlink() and gate.database.is_file() and not gate.database.is_symlink()
         and stat.S_IMODE(gate.database.stat().st_mode) == 0o600
         and r.c.fingerprint((gate.database.stat().st_dev, gate.database.stat().st_ino))
             == sqlite_record['sourceDatabaseIdentitySha256'], 'SQLITE_IDENTITY_CHANGED')
    gate.database_identity = (gate.database.stat().st_dev, gate.database.stat().st_ino)
    gate.summary, gate.record = sqlite_record['sourceSummary'], sqlite_record
    safety_path = target / workspace.WORKSPACE_SAFETY
    safety_raw, _safety_mode = output[workspace.WORKSPACE_SAFETY]
    safety_identity = file_identity(safety_path)
    need(safety_path.read_bytes() == safety_raw, 'SQLITE_HELPER_CHANGED')
    # abort() must execute the authenticated source bytes, rather than reread
    # a path that could move between the source check and the SQLite lock.
    from types import ModuleType
    safety = ModuleType('source_pinned_online_recovery_sqlite_safety')
    exec(compile(safety_raw, str(safety_path), 'exec', dont_inherit=True), safety.__dict__)
    need(callable(safety.logical_summary) and file_identity(safety_path) == safety_identity,
         'SQLITE_HELPER_CHANGED')
    gate.summary_reader = lambda: safety.logical_summary
    if marker_required:
        marker_stat = gate.marker.lstat()
        need(stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_nlink == 1
             and stat.S_IMODE(marker_stat.st_mode) == 0o600
             and (marker_stat.st_uid, marker_stat.st_gid) == (gate.database.stat().st_uid, gate.database.stat().st_gid)
             and 0 < marker_stat.st_size < 1024, 'MARKER_CHANGED')
        marker_identity = file_identity(gate.marker)
        marker_raw = gate.marker.read_bytes()
        marker = core.closed_json(marker_raw, 1024)
        need(file_identity(gate.marker) == marker_identity and r.c.digest(marker_raw) == ORIGIN['markerBytesSha256']
             == sqlite_record['maintenanceSha256'] and type(marker) is dict
             and set(marker) == {'version', 'runId', 'runAttempt', 'candidateCommit', 'nonce'}
             and type(marker['version']) is int and marker['version'] == 1
             and marker['runId'] == FAILED_PRODUCER['workflowRunId']
             and marker['runAttempt'] == FAILED_PRODUCER['workflowRunAttempt']
             and marker['candidateCommit'] == FAILED_PRODUCER['commit']
             and type(marker['nonce']) is str and re.fullmatch('[a-f0-9]{64}', marker['nonce']), 'MARKER_CHANGED')
        gate.marker_bytes = marker_raw
        gate.marker_identity = (marker_stat.st_dev, marker_stat.st_ino)
        gate.check_marker()
    else:
        need(not gate.marker.exists() and not gate.marker.is_symlink(), 'MARKER_PRESENT')
    audit, saved = audit_origin(d, core, workspace, target, evidence, sqlite_sha)
    saved[safety_path] = (safety_raw, safety_identity)
    saved[sqlite_path] = (sqlite_raw, file_identity(sqlite_path))
    saved[previous / 'release-manifest.json'] = (manifest_raw, file_identity(previous / 'release-manifest.json'))
    receipt = MemoryAuditReceipt()
    workspace.strict_audit(d, previous, receipt)
    fresh = workspace.audit_receipt(d, receipt)
    core.audit_guard(fresh)
    need(fresh['checksSha256'] == workspace.audit_receipt(d, target / 'before-audit.json')['checksSha256'],
         'AUDIT_RULES_CHANGED')
    ordinary_raw = d.registration_download(r.authority()['producer']['commit'])
    need(r.c.digest(ordinary_raw) == evidence['ordinaryArchiveSha256'], 'ARCHIVE_CHANGED')
    ordinary_files = d.registration_archive(ordinary_raw, r.authority()['producer']['commit'])
    backup = r.backup_cas(d, core, workspace, previous, successor['manifest'], states, ordinary_files)
    need({k: backup[k] for k in backup if k != 'servicesSha256'}
         == {k: evidence['backupInstallation'][k] for k in evidence['backupInstallation'] if k != 'servicesSha256'},
         'BACKUP_CHANGED')
    unchanged(saved)
    need((BASE / 'current').resolve() == previous and workspace.snapshot(d, previous) == states, 'STATE_MOVED')
    state = {'currentRelease': str(previous), 'manifestBytesSha256': ORIGIN['manifestBytesSha256'],
        'servicesAfter': states, 'workspaceVolume': volume, 'environmentFileSha256': evidence['environmentFileSha256'],
        'appliedDatabase': applied, 'onlineGrants': grants, 'sqliteProtectionSha256': sqlite_sha,
        'sqliteReceiptBytesSha256': r.c.digest(sqlite_raw),
        'sqliteSourceSummarySha256': r.c.fingerprint(sqlite_record['sourceSummary']),
        'auditRecordBytesSha256': r.c.digest(saved[target / (r.PREFIX + '-audit-protection.json')][0]),
        'historicalAuditSha256': r.c.fingerprint(audit['before']), 'freshStrictAudit': fresh,
        'backupInstallationSha256': r.c.fingerprint(backup), 'markerAbsent': not marker_required,
        'executorAbsent': True, 'preservedServiceCount': len(r.PRESERVED)}
    need(set(state) == STATE_FIELDS, 'STATE_SHAPE_CHANGED')
    return state, (d, core, workspace, online, previous, target, evidence, proof, gate, audit, saved)


def verify(d, context, *, marker_required=True):
    state, _details = _verify(d, context, marker_required=marker_required)
    return state


def fresh_audit_fence(d, workspace, online, previous, evidence, state, audit):
    """Bind the old immutable history cutoff and the actual new API separately."""
    identity = audit['sourceApiIdentity']
    plan = online._online_after_bit_audit_queries(d, workspace, previous, identity,
        history_cutoff=audit['before']['historyCutoff'])
    need(r.c.digest(plan['historyQuery'].encode()) == audit['historyQuerySha256']
         and plan['expectedTriggersSha256'] == audit['triggerDefinitionsSha256'], 'AUDIT_QUERY_CHANGED')
    def check_api(deadline):
        import time
        remaining = min(5, deadline - time.monotonic())
        need(remaining > 0, 'FENCE_EXPIRED')
        actual = workspace.workspace_api_identity(d, previous,
            expected={n: state['servicesAfter']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')},
            timeout=remaining)
        need(all(actual[n] == state['servicesAfter']['api'][n]
             for n in ('containerId', 'image', 'startedAtSha256')), 'API_MOVED')
    return online._online_after_bit_audit_transport(d, previous, {'services': state['servicesAfter']},
        workspace, identity, plan, audit['basis'], history_record=audit['before'], first_api_check=check_api,
        receipt_kind=r.KIND + '_AUDIT_PROTECTION')


def recover(d, context, *, approved=False, executor=None):
    inputs(context)
    need(approved is True and os.environ.get('API_FAULT_RESTORE_APPROVED') == 'true', 'APPROVAL_REQUIRED')
    require_root()
    helper_sha = authenticate_executor(d, executor)
    target = target_path(d)
    for name in (RECORD, INTENT):
        need(not (target / name).exists() and not (target / name).is_symlink(), 'RECORD_EXISTS')
    lock_path = BASE / '.deploy.lock'
    need(not lock_path.is_symlink(), 'LOCK_CHANGED')
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        metadata = os.fstat(lock.fileno())
        need(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == os.geteuid(),
             'LOCK_CHANGED')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state, details = _verify(d, context, marker_required=True)
        d, core, workspace, online, previous, target, evidence, _proof, gate, audit, saved = details
        with fresh_audit_fence(d, workspace, online, previous, evidence, state, audit) as fence:
            fence.check()
            bounded = r.DeadlineController(d, fence.pipe.deadline, reserve=0)
            # This is a fresh 210s SQL fence and abort creates a fresh SQLite
            # transaction. No old gate connection or expired deadline is reused.
            gate.d = bounded
            workspace.jobs_idle(bounded, previous)
            online.require_fresh_resources(bounded, previous)
            unchanged(saved)
            need(workspace.snapshot(bounded, previous) == state['servicesAfter'], 'STATE_MOVED')
            intent = {'version': 1, 'kind': RECORD_KIND + '_INTENT', 'producer': copy.deepcopy(FAILED_PRODUCER),
                'origin': copy.deepcopy(ORIGIN), 'failedRelease': str(target), 'stateBefore': state,
                'recoveryExecutor': copy.deepcopy(executor), 'recoveryHelperSha256': helper_sha}
            core.write_private(target / INTENT, intent)
            gate.abort()
            fence.check()
            need(not gate.marker.exists() and not gate.marker.is_symlink(), 'MARKER_PRESENT')
            unchanged(saved)
            need((BASE / 'current').resolve() == previous
                 and workspace.snapshot(bounded, previous) == state['servicesAfter'], 'STATE_MOVED')
            state = {**state, 'markerAbsent': True}
            value = {'version': 1, 'scope': r.SCOPE, 'kind': RECORD_KIND,
                'status': 'PROTECTED_RECOVERY_AWAITING_NATIVE_READBACK', 'producer': copy.deepcopy(FAILED_PRODUCER),
                'origin': copy.deepcopy(ORIGIN), 'failedRelease': str(target), 'state': state,
                'recoveryExecutor': copy.deepcopy(executor), 'recoveryHelperSha256': helper_sha,
                'originalMarkerCleared': True, 'onlinePublished': False, 'migrationPerformed': False,
                'databaseGrantsChanged': False, 'executionMigrationPlan': [], 'volumeDeletionPerformed': False,
                'businessActions': 0, 'failedOperationBusinessActions': None}
            core.write_private(target / RECORD, value)
            fence.check()
    return readback(d, context)


def readback(d, context):
    """Only a separate actual native invocation may seal this result for baseline."""
    core, _transport, _evidence, _proof = inputs(context)
    target = target_path(d)
    path = target / RECORD
    raw = core.private_bytes(path)
    identity = file_identity(path)
    value = core.closed_json(raw)
    need(type(value) is dict and set(value) == RETURN_FIELDS - {'recoveryRecordBytesSha256'}
         and type(value['version']) is int and value['version'] == 1
         and value['scope'] == r.SCOPE and value['kind'] == RECORD_KIND
         and value['status'] == 'PROTECTED_RECOVERY_AWAITING_NATIVE_READBACK'
         and value['producer'] == FAILED_PRODUCER and value['origin'] == ORIGIN
         and value['failedRelease'] == str(target) and value['originalMarkerCleared'] is True
         and value['onlinePublished'] is False and value['migrationPerformed'] is False
         and value['databaseGrantsChanged'] is False and value['executionMigrationPlan'] == []
         and value['volumeDeletionPerformed'] is False and type(value['businessActions']) is int
         and value['businessActions'] == 0 and value['failedOperationBusinessActions'] is None,
         'RECORD_CHANGED')
    need(authenticate_executor(d, value['recoveryExecutor']) == value['recoveryHelperSha256'], 'EXECUTOR_HELPER_CHANGED')
    state, details = _verify(d, context, marker_required=False)
    need(value['state'] == state, 'READBACK_STATE_CHANGED')
    d, _core, workspace, online, previous, _target, evidence, _proof, _gate, audit, _saved = details
    with fresh_audit_fence(d, workspace, online, previous, evidence, state, audit) as fence:
        fence.check()
        workspace.jobs_idle(d, previous); online.require_fresh_resources(d, previous)
        r.verify_live_sqlite(d, _core, workspace, target, previous,
            state['servicesAfter']['api']['reference'], state['sqliteProtectionSha256'])
        need(workspace.snapshot(d, previous) == state['servicesAfter'], 'STATE_MOVED')
        fence.check()
    need(file_identity(path) == identity and core.private_bytes(path) == raw, 'RECORD_MOVED')
    result = {**value, 'kind': r.KIND, 'status': STATUS, 'recoveryRecordBytesSha256': r.c.digest(raw)}
    need(set(result) == RETURN_FIELDS, 'RETURN_SHAPE_CHANGED')
    return result


def validate_receipt(receipt, context, operation):
    """Closed pure client validation; a forged JSON cannot supply native authority."""
    _core, _transport, evidence, _proof = inputs(context)
    need(operation in ('diagnose', 'recover', 'readback') and type(receipt) is dict, 'RETURN_CHANGED')
    diagnostic = operation == 'diagnose'
    fields = {'version', 'scope', 'kind', 'status', 'producer', 'origin', 'state', 'automaticRecoveryAllowed'}
    need(set(receipt) == (fields if diagnostic else RETURN_FIELDS)
         and type(receipt['version']) is int and receipt['version'] == 1
         and receipt['scope'] == r.SCOPE and receipt['kind'] == r.KIND
         and receipt['status'] == ('ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_DIAGNOSED' if diagnostic else STATUS)
         and receipt['producer'] == FAILED_PRODUCER and receipt['origin'] == ORIGIN, 'RETURN_CHANGED')
    state = receipt['state']
    need(type(state) is dict and set(state) == STATE_FIELDS
         and state['currentRelease'] == evidence['currentRelease']
         and state['manifestBytesSha256'] == ORIGIN['manifestBytesSha256']
         and state['environmentFileSha256'] == evidence['environmentFileSha256']
         and state['workspaceVolume'] == evidence['workspaceVolume']
         and state['appliedDatabase'] == evidence['appliedDatabase']
         and type(state['markerAbsent']) is bool and state['markerAbsent'] is (not diagnostic)
         and state['executorAbsent'] is True and type(state['preservedServiceCount']) is int
         and state['preservedServiceCount'] == len(r.PRESERVED)
         and all(type(state[n]) is str and re.fullmatch('[a-f0-9]{64}', state[n])
             for n in STATE_FIELDS if n.endswith('Sha256')), 'RETURN_STATE_CHANGED')
    services = state['servicesAfter']
    need(type(services) is dict and set(services) == set(r.c.SERVICES)
         and all(services[n] == evidence['services'][n] for n in r.PRESERVED), 'RETURN_SERVICES_CHANGED')
    for name in ('api', 'admin'):
        row, old = services[name], evidence['services'][name]
        need(type(row) is dict and set(row) == set(old)
             and all(row[n] == old[n] for n in ('image', 'reference', 'environmentSha256'))
             and row['status'] == 'running' and row['health'] == 'healthy'
             and all(type(row[n]) is str and re.fullmatch('[a-f0-9]{64}', row[n])
                 for n in ('containerId', 'startedAtSha256', 'configurationSha256')), 'RETURN_SERVICES_CHANGED')
    _core.audit_guard(state['freshStrictAudit'])
    need(state['auditRecordBytesSha256'] == ORIGIN['auditRecordBytesSha256']
         and state['sqliteReceiptBytesSha256'] == ORIGIN['sqliteReceiptBytesSha256']
         and state['sqliteProtectionSha256'] == ORIGIN['sqliteProtectionSha256']
         and type(state['onlineGrants']) is dict
         and set(state['onlineGrants']) == {'status', 'sha256', 'mutationPerformed'}
         and state['onlineGrants']['status'] == 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED'
         and state['onlineGrants']['mutationPerformed'] is False
         and type(state['onlineGrants']['sha256']) is str
         and re.fullmatch('[a-f0-9]{64}', state['onlineGrants']['sha256']), 'RETURN_STATE_CHANGED')
    if diagnostic:
        need(receipt['automaticRecoveryAllowed'] is False, 'RETURN_CHANGED')
    else:
        need(receipt['failedRelease'] == str(BASE / 'releases' / TARGET_NAME)
             and receipt['originalMarkerCleared'] is True and receipt['onlinePublished'] is False
             and receipt['migrationPerformed'] is False and receipt['databaseGrantsChanged'] is False
             and receipt['executionMigrationPlan'] == [] and receipt['volumeDeletionPerformed'] is False
             and type(receipt['businessActions']) is int and receipt['businessActions'] == 0
             and receipt['failedOperationBusinessActions'] is None
             and all(type(receipt[n]) is str and re.fullmatch('[a-f0-9]{64}', receipt[n])
                 for n in ('recoveryHelperSha256', 'recoveryRecordBytesSha256'))
             and type(receipt['recoveryExecutor']) is dict
             and receipt['recoveryExecutor'] == r.producer(receipt['recoveryExecutor'].get('commit'),
                 receipt['recoveryExecutor'].get('sourceTree'), receipt['recoveryExecutor'].get('workflowRunId'),
                 receipt['recoveryExecutor'].get('workflowRunAttempt')), 'RETURN_CHANGED')
    return receipt


def cli(d=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('diagnose', 'recover', 'readback'))
    for name in ('failure', 'preflight', 'build-proof'):
        parser.add_argument('--' + name, required=True)
    for name in ('executor-commit', 'executor-tree', 'executor-run-id', 'executor-run-attempt'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    core = r.c.load_core(r.authority()['coreSha256'])
    def decode(text):
        need(text.startswith('gzip-base64:'), 'INPUT_ENCODING_CHANGED')
        return r.bounded_gzip(base64.b64decode(text[len('gzip-base64:'):], validate=True), 256 * 1024)
    context = validate_inputs(decode(args.failure), decode(args.preflight), decode(args.build_proof))
    supplied = (args.executor_commit, args.executor_tree, args.executor_run_id, args.executor_run_attempt)
    need(all(v is not None for v in supplied) if args.operation == 'recover' else all(v is None for v in supplied),
         'SELECTION_CHANGED')
    d = r.modules(d)[0]
    if args.operation == 'recover':
        return recover(d, context, approved=os.environ.get('API_FAULT_RESTORE_APPROVED') == 'true',
            executor=r.producer(*supplied))
    if args.operation == 'readback':
        return readback(d, context)
    return {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND,
        'status': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_DIAGNOSED',
        'producer': copy.deepcopy(FAILED_PRODUCER), 'origin': copy.deepcopy(ORIGIN),
        'state': verify(d, context), 'automaticRecoveryAllowed': False}


if __name__ == '__main__':
    try:
        print(json.dumps(r.wire(cli()), sort_keys=True, separators=(',', ':')))
    except Exception as error:
        # Never expose arbitrary exception messages, environment or credentials.
        print(json.dumps(r.wire({'version': 1, 'scope': r.SCOPE, 'kind': r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED', 'code': r.rejection_code(error)}),
            sort_keys=True, separators=(',', ':')))
        raise SystemExit(1)
