"""Finite, independently witnessed completion of one failed ONLINE restore.

The old native seals and manifests remain cold. Inspection never clears a marker.
Recovery can only clear the original, byte-bound marker after proving an already
restored API/Admin under fresh guards; it never switches or removes a service.
"""

import argparse
import ast
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
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
WITNESS_FIELDS = frozenset(('version', 'kind', 'origin', 'originalProducer', 'executorProducer',
    'executorRun', 'executorArchiveBytesSha256', 'executorHelperSha256', 'contextRawBase64',
    'commands', 'recoveryRecordBytesSha256', 'servicesSha256'))
COMMAND_WITNESS_FIELDS = frozenset(('commandId', 'instanceId', 'parameters', 'parametersSha256',
    'nativeRawBase64', 'nativeBytesSha256', 'receiptSha256'))
EXECUTOR_RUN_FIELDS = frozenset(('runId', 'runAttempt', 'headBranch', 'headCommit', 'sourceTree',
    'workflowPath', 'event', 'status', 'conclusion', 'runResponseBytesSha256', 'treeResponseBytesSha256'))
WITNESS_KIND = r.KIND + '_PROTECTED_RECOVERY_AUTHORITY'


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


def failed_source(d, core, evidence, proof):
    """Recompute the old candidate using only its authenticated pure interpreter.

    A changed recovery helper cannot impersonate the failed producer's source.
    This loader never calls that interpreter's baseline, release or old fences.
    """
    from types import ModuleType
    target = target_path(d)
    archive_raw = d.registration_download(FAILED_PRODUCER['commit'])
    need(r.c.digest(archive_raw) == proof['sourceProjection']['candidateArchiveSha256'],
         'FAILED_ARCHIVE_CHANGED')
    files = d.registration_archive(archive_raw, FAILED_PRODUCER['commit'])
    need(core.projection_module().source_tree(files) == FAILED_PRODUCER['sourceTree'], 'FAILED_TREE_CHANGED')
    path = target / 'scripts/production-release/online-recharge-component-runtime.py'
    relative = path.relative_to(target).as_posix()
    need(relative in files, 'FAILED_HELPER_MISSING')
    # Authenticate the complete known helper set before any archived Python is
    # evaluated. Each additional target source byte is checked by _verify.
    names = (*core.HELPERS, 'online-recharge-component-consumer.py', 'online-recharge-component-runtime.py',
        'online-recharge-component-readonly.py', 'online-recharge-scope.py')
    saved = {}
    for name in names:
        helper = path.with_name(name); expected = files.get('scripts/production-release/' + name)
        need(helper.is_file() and not helper.is_symlink() and helper.resolve() == helper
             and expected is not None, 'FAILED_HELPER_CHANGED')
        identity = file_identity(helper); source = helper.read_bytes()
        mode = '100755' if helper.stat().st_mode & 0o111 else '100644'
        need(expected == (source, mode) and identity == file_identity(helper), 'FAILED_HELPER_CHANGED')
        saved[helper] = (source, identity)
    module = ModuleType('authenticated_failed_online_source'); module.__file__ = str(path)
    exec(compile(saved[path][0], str(path), 'exec', dont_inherit=True), module.__dict__)
    need(tuple(module.HELPERS) == names[len(core.HELPERS):]
         and module.authority() == r.authority() and module.current_authority() == r.current_authority(),
         'FAILED_INTERPRETER_CHANGED')
    result = module.source(d, FAILED_PRODUCER, evidence)
    need(result[0] == files and result[2]['candidateArchiveSha256'] == r.c.digest(archive_raw),
         'FAILED_SOURCE_CHANGED')
    unchanged(saved)
    return result


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
    files, output, projection = failed_source(d, core, evidence, proof)
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


def source_authority(value):
    """Only the literal committed runtime seal is eligible, never caller JSON."""
    path = Path(r.__file__)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'AUTHORITY_SOURCE_CHANGED')
    metadata = path.lstat()
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == os.geteuid()
         and stat.S_IMODE(metadata.st_mode) in (0o600, 0o644, 0o755)
         and 0 < metadata.st_size < 2 * 1024 * 1024, 'AUTHORITY_SOURCE_CHANGED')
    before = file_identity(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        identity = lambda row: tuple(getattr(row, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_nlink',
            'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
        need(identity(opened) == before, 'AUTHORITY_SOURCE_CHANGED')
        raw = stream.read(2 * 1024 * 1024 + 1)
        need(identity(os.fstat(stream.fileno())) == before, 'AUTHORITY_SOURCE_CHANGED')
    need(before == file_identity(path) and len(raw) == metadata.st_size,
         'AUTHORITY_SOURCE_CHANGED')
    declarations = [node for node in ast.parse(raw).body if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == 'RECOVERY_AUTHORITY' for target in node.targets)]
    need(len(declarations) == 1, 'AUTHORITY_SOURCE_CHANGED')
    declared = ast.literal_eval(declarations[0].value)
    need(declared is not None and type(declared) is dict and value == declared, 'AUTHORITY_NOT_SEALED')
    return copy.deepcopy(declared)


def validate_witness_shape(value):
    """Validate source-bound data; this function alone grants no admission."""
    need(type(value) is dict and set(value) == WITNESS_FIELDS and type(value['version']) is int
         and value['version'] == 1 and value['kind'] == WITNESS_KIND
         and value['origin'] == ORIGIN and value['originalProducer'] == FAILED_PRODUCER,
         'WITNESS_CHANGED')
    executor = value['executorProducer']
    need(type(executor) is dict and executor == r.producer(executor.get('commit'), executor.get('sourceTree'),
        executor.get('workflowRunId'), executor.get('workflowRunAttempt')) and executor != FAILED_PRODUCER,
        'WITNESS_EXECUTOR_CHANGED')
    run = value['executorRun']
    need(type(run) is dict and set(run) == EXECUTOR_RUN_FIELDS
         and run['runId'] == executor['workflowRunId'] and run['runAttempt'] == executor['workflowRunAttempt']
         and run['headCommit'] == executor['commit'] and run['sourceTree'] == executor['sourceTree']
         and run['headBranch'] == 'main' and run['workflowPath'] == '.github/workflows/online-recharge-recovery.yml'
         and run['event'] == 'workflow_dispatch' and run['status'] == 'completed' and run['conclusion'] == 'success'
         and all(type(run[n]) is str and re.fullmatch('[a-f0-9]{64}', run[n])
             for n in ('runResponseBytesSha256', 'treeResponseBytesSha256')), 'WITNESS_RUN_CHANGED')
    need(all(type(value[n]) is str and re.fullmatch('[a-f0-9]{64}', value[n]) for n in
        ('executorArchiveBytesSha256', 'executorHelperSha256', 'recoveryRecordBytesSha256', 'servicesSha256')),
        'WITNESS_HASH_CHANGED')
    raw_context = value['contextRawBase64']
    need(type(raw_context) is dict and set(raw_context) == {'failureRaw', 'preflightRaw', 'proofRaw'},
         'WITNESS_INPUTS_CHANGED')
    for text in raw_context.values():
        need(type(text) is str and 0 < len(text) < 360 * 1024, 'WITNESS_INPUTS_CHANGED')
    decoded = {name: base64.b64decode(text, validate=True) for name, text in raw_context.items()}
    context = validate_inputs(decoded['failureRaw'], decoded['preflightRaw'], decoded['proofRaw'])
    commands = value['commands']
    need(type(commands) is dict and set(commands) == {'recover', 'readback'}, 'WITNESS_COMMANDS_CHANGED')
    ids = [ORIGIN['failureCommandId']]
    for command in commands.values():
        need(type(command) is dict and set(command) == COMMAND_WITNESS_FIELDS
             and type(command['commandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command['commandId'])
             and command['instanceId'] == ORIGIN['instanceId']
             and type(command['nativeRawBase64']) is str and 0 < len(command['nativeRawBase64']) < 180 * 1024
             and all(type(command[n]) is str and re.fullmatch('[a-f0-9]{64}', command[n])
                 for n in ('parametersSha256', 'nativeBytesSha256', 'receiptSha256')),
             'WITNESS_COMMANDS_CHANGED')
        ids.append(command['commandId'])
    need(len(set(ids)) == 3, 'WITNESS_INDEPENDENT_COMMAND_REQUIRED')
    return context


def archived_parameter_generator(d, core, value):
    """Use actual archived sender source, never a later helper's parameter format.

    All fixed source/helper validation precedes execution. Only the already
    authenticated archive transport replaces the original Git read; no network,
    Git executable, IAM or sender operation is added to the parameter generator.
    """
    import importlib.util
    from types import FunctionType, ModuleType
    executor = value['executorProducer']
    archive_raw = d.registration_download(executor['commit'])
    need(r.c.digest(archive_raw) == value['executorArchiveBytesSha256'], 'WITNESS_ARCHIVE_CHANGED')
    files = d.registration_archive(archive_raw, executor['commit'])
    need(core.projection_module().source_tree(files) == executor['sourceTree'], 'WITNESS_TREE_CHANGED')
    directory = d.BASE / '.staging' / ('online-protected-recovery-' + '-'.join(
        executor[name] for name in ('commit', 'workflowRunId', 'workflowRunAttempt')))
    need(directory.resolve() == directory and directory.is_dir() and not directory.is_symlink(), 'WITNESS_SOURCE_MISSING')
    names = (*core.HELPERS, 'online-recharge-component-consumer.py', 'online-recharge-component-runtime.py',
        'online-recharge-component-readonly.py', 'online-recharge-component-recovery.py',
        'online-recharge-component-recovery-readonly.py')
    saved, pins = {}, {}
    for name in names:
        path = directory / name
        need(path.is_file() and not path.is_symlink() and path.resolve() == path
             and path.stat().st_nlink == 1 and path.stat().st_uid == os.geteuid()
             and stat.S_IMODE(path.stat().st_mode) in (0o600, 0o644, 0o755), 'WITNESS_HELPER_CHANGED')
        identity = file_identity(path)
        source = path.read_bytes()
        mode = '100755' if path.stat().st_mode & 0o111 else '100644'
        need(0 < len(source) < 2 * 1024 * 1024 and files.get('scripts/production-release/' + name) == (source, mode)
             and file_identity(path) == identity, 'WITNESS_HELPER_CHANGED')
        saved[path] = (source, identity); pins[name] = r.c.digest(source)
    need(pins['online-recharge-component-recovery.py'] == value['executorHelperSha256']
         == r.c.digest(Path(__file__).read_bytes()), 'WITNESS_RECOVERY_HELPER_CHANGED')
    filename = 'online-recharge-component-recovery-readonly.py'
    path = directory / filename
    # Match the existing importlib/ModuleType loader and execute exactly the
    # bytes just authenticated against the archived Git tree.
    spec = importlib.util.spec_from_file_location('sealed_online_recovery_sender', path)
    archived = importlib.util.module_from_spec(spec)
    exec(compile(saved[path][0], str(path), 'exec', dont_inherit=True), archived.__dict__)
    need(tuple(archived.helpers(core)) == names, 'WITNESS_HELPER_SET_CHANGED')
    def authenticated_pins(requested_core, requested_executor, requested_names):
        need(requested_executor == executor and tuple(requested_names) == names
             and requested_core.__file__ == core.__file__, 'WITNESS_PIN_REQUEST_CHANGED')
        unchanged(saved)
        return copy.deepcopy(pins)
    # Keep the original source-pinned parameter implementation. Replacing this
    # archive lookup with its already authenticated result avoids both a second
    # source transfer and a Git CLI dependency on the production instance.
    original_client = archived.client
    client_view = SimpleNamespace(**original_client.__dict__)
    client_view.helper_pins = authenticated_pins
    original = archived.parameter_spec
    generator = FunctionType(original.__code__, {**original.__globals__, 'client': client_view},
        original.__name__, original.__defaults__, original.__closure__)
    generator.__kwdefaults__ = copy.copy(original.__kwdefaults__)
    unchanged(saved)
    return generator, saved


def sender_program(parameters):
    """Decode only the fixed carrier; arbitrary submitted Python never executes."""
    need(type(parameters) is dict and set(parameters) == {'commands', 'executionTimeout'}
         and parameters['executionTimeout'] == ['600'] and type(parameters['commands']) is list
         and len(parameters['commands']) == 1 and type(parameters['commands'][0]) is str
         and len(json.dumps(parameters).encode()) < 20 * 1024, 'WITNESS_PARAMETERS_CHANGED')
    command = shlex.split(parameters['commands'][0])
    need(len(command) == 4 and command[:3] == ['python3', '-B', '-c']
         and parameters['commands'][0] == 'python3 -B -c ' + shlex.quote(command[3]), 'WITNESS_CARRIER_CHANGED')
    match = re.fullmatch(r'import base64,gzip;exec\(compile\(gzip\.decompress\(base64\.b64decode\((.+),validate=True\)\),'
        r'"<online-protected-recovery-transport>","exec"\)\)', command[3])
    need(match is not None, 'WITNESS_CARRIER_CHANGED')
    packed = ast.literal_eval(match[1])
    need(type(packed) is str and 0 < len(packed) < 64 * 1024, 'WITNESS_CARRIER_CHANGED')
    need(command[3] == 'import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
         + repr(packed) + ',validate=True)),"<online-protected-recovery-transport>","exec"))',
         'WITNESS_CARRIER_CHANGED')
    return r.bounded_gzip(base64.b64decode(packed, validate=True), 256 * 1024)


def authenticate_sender_parameters(generator, mode, core, executor, context, parameters):
    """Compare the entire program, allowing only gzip representation differences.

    Python/zlib versions differ in gzip OS headers and compressed blocks. The
    actual parameter hash remains sealed. Each inner archive must decode to the
    exact original bytes before it can be reused by the original source generator.
    """
    from types import FunctionType
    program = sender_program(parameters)
    calls = [node for node in ast.walk(ast.parse(program)) if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Subscript) and isinstance(node.func.value, ast.Name)
        and node.func.value.id == 'client' and isinstance(node.func.slice, ast.Constant)
        and node.func.slice.value == 'server_arguments']
    need(len(calls) == 1 and len(calls[0].args) == 6 and not calls[0].keywords, 'WITNESS_ARGUMENTS_CHANGED')
    args = [ast.literal_eval(node) for node in calls[0].args]
    transport = core.closed_json(context['preflightRaw'])
    descriptor = {name: value for name, value in transport.items()
        if name not in ('invocationRawBase64', 'serverReceipt')}
    need(args[0] == mode and args[1] == executor and args[3] == descriptor, 'WITNESS_ARGUMENTS_CHANGED')
    original_raws = (context['failureRaw'], base64.b64decode(transport['invocationRawBase64'], validate=True), context['proofRaw'])
    representations = {}
    for text, original in zip((args[2], args[4], args[5]), original_raws):
        need(type(text) is str and text.startswith('gzip-base64:'), 'WITNESS_INPUT_ENCODING_CHANGED')
        decoded = r.bounded_gzip(base64.b64decode(text[len('gzip-base64:'):], validate=True), 256 * 1024)
        need(decoded == original and (original not in representations or representations[original] == text),
             'WITNESS_INPUT_BYTES_CHANGED')
        representations[original] = text
    def bound_pack(original):
        need(type(original) is bytes and original in representations, 'WITNESS_PACK_REQUEST_CHANGED')
        return representations[original]
    # The three immutable original inputs are the only variable gzip literals.
    # Source/helper pins, mode, approval, arguments and every other program byte
    # are still generated by the authenticated archived implementation.
    bounded_generator = FunctionType(generator.__code__, {**generator.__globals__, 'pack': bound_pack},
        generator.__name__, generator.__defaults__, generator.__closure__)
    bounded_generator.__kwdefaults__ = copy.copy(generator.__kwdefaults__)
    expected = bounded_generator(mode, core, executor, context)
    need(sender_program(expected) == program and expected['executionTimeout'] == parameters['executionTimeout'],
         'WITNESS_PARAMETERS_CHANGED')
    return parameters


def admit_baseline(d, witness):
    """Authenticate sealed actual GET bytes, then independently remeasure state.

    The central GHA role retrieves the actual sender and independent readback
    once and commits the finite witness. EC2 never issues another GET/send and
    never needs Actions or SSM read permissions for this admission.
    """
    value = source_authority(witness)
    context = validate_witness_shape(value)
    core, _transport, _evidence, _proof = inputs(context)
    generator, saved = archived_parameter_generator(d, core, value)
    executor, receipts = r.producer(value['executorProducer']['commit'], value['executorProducer']['sourceTree'],
        value['executorProducer']['workflowRunId'], value['executorProducer']['workflowRunAttempt']), {}
    for mode in ('recover', 'readback'):
        command = value['commands'][mode]
        need(command['parametersSha256'] == r.c.fingerprint(command['parameters']), 'WITNESS_PARAMETERS_CHANGED')
        authenticate_sender_parameters(generator, mode, core, executor, context, command['parameters'])
        native_raw = base64.b64decode(command['nativeRawBase64'], validate=True)
        need(r.c.digest(native_raw) == command['nativeBytesSha256'], 'WITNESS_NATIVE_CHANGED')
        _native, receipt = r.validate_component_invocation(core, native_raw, command['commandId'], command['instanceId'])
        validate_receipt(receipt, context, mode)
        need(r.c.fingerprint(receipt) == command['receiptSha256'] and receipt['recoveryExecutor'] == executor
             and receipt['recoveryHelperSha256'] == value['executorHelperSha256']
             and receipt['recoveryRecordBytesSha256'] == value['recoveryRecordBytesSha256']
             and r.c.fingerprint(receipt['state']['servicesAfter']) == value['servicesSha256'], 'WITNESS_RECEIPT_CHANGED')
        receipts[mode] = receipt
    need(receipts['recover'] == receipts['readback'], 'WITNESS_READBACK_CHANGED')
    # This preserves every image/content/configuration/database/audit/SQLite/
    # backup/idle guard and authenticates the newly created restoration record.
    actual = readback(d, context)
    validate_receipt(actual, context, 'readback')
    need(actual == receipts['readback'], 'WITNESS_LIVE_READBACK_CHANGED')
    unchanged(saved)
    return {'version': 1, 'kind': r.KIND + '_PROTECTED_RECOVERY_ADMISSION',
        'sourceAuthoritySha256': r.c.fingerprint(value), 'originSha256': r.c.fingerprint(ORIGIN),
        'executorProducer': copy.deepcopy(executor), 'executorHelperSha256': value['executorHelperSha256'],
        'recoverCommandId': value['commands']['recover']['commandId'],
        'readbackCommandId': value['commands']['readback']['commandId'], 'instanceId': ORIGIN['instanceId'],
        'recoverNativeBytesSha256': value['commands']['recover']['nativeBytesSha256'],
        'readbackNativeBytesSha256': value['commands']['readback']['nativeBytesSha256'],
        'recoverParametersSha256': value['commands']['recover']['parametersSha256'],
        'readbackParametersSha256': value['commands']['readback']['parametersSha256'],
        'recoveryRecordBytesSha256': value['recoveryRecordBytesSha256'], 'servicesSha256': value['servicesSha256'],
        'state': actual['state']}


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
