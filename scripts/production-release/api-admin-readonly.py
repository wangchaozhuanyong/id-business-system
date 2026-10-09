"""Pinned, independent SSM readback for the explicit API/Admin scope."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('API_ADMIN_TRANSPORT_FAILED')
    return result.stdout.strip()


def selected_scope(operation):
    if operation in ('verify_api_workspace', 'release_api_workspace'):
        return 'API_ADMIN_WORKSPACE'
    if operation in ('verify_api_admin_migration', 'release_api_admin_migration'):
        return 'API_ADMIN_MIGRATION'
    if operation in ('verify_api_registration', 'handoff_api_registration', 'release_api_registration',
                     'verify_registration_business', 'verify_registration_handoff', 'recover_registration_handoff'):
        return 'API_REGISTRATION'
    return 'API_ADMIN'


def parameters(commit, expected, mode, scope='API_ADMIN', *, require_closed=True):
    if (not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (commit, expected))
            or scope not in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', 'API_ADMIN_WORKSPACE') or mode not in ('preflight', 'readback', 'handoff', 'business', 'handoff-observe', 'handoff-recover')
            or mode in ('handoff', 'business', 'handoff-observe', 'handoff-recover') and scope != 'API_REGISTRATION' or type(require_closed) is not bool):
        raise ValueError('API_ADMIN_INPUT_INVALID')
    prefix = 'api-workspace' if scope == 'API_ADMIN_WORKSPACE' else scope.lower().replace('_', '-')
    directory = f'/opt/id-business-v2/.staging/{prefix}-verify-{commit}'
    commands = ['set -eu', f'mkdir -p {directory}']
    controllers = ('remote-deploy.py', 'api-admin-scope.py')
    if scope == 'API_ADMIN_WORKSPACE':
        # A verified online publication retains its migration and engine proof.
        # Pin that reader before either workspace preflight or independent readback.
        controllers += ('online-recharge-scope.py', 'online-recharge-recovery.json', 'api-admin-pending-projection.py')
    for name in controllers:
        digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        commands.extend([f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{commit}/scripts/production-release/{name} -o {directory}/{name}',
                         f'echo "{digest}  {directory}/{name}" | sha256sum -c - >/dev/null'])
    action = 'verify' if scope == 'API_REGISTRATION' and mode == 'preflight' and not require_closed else mode
    commands.append(f'python3 -B {directory}/remote-deploy.py --{prefix}-{action} --expected-current {expected}')
    return {'commands': commands, 'executionTimeout': ['300']}


def safe_failure(receipt, scope='API_ADMIN'):
    if (isinstance(receipt, dict) and receipt.get('status') == scope + '_VERIFICATION_FAILED'
            and isinstance(receipt.get('code'), str) and re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', receipt['code'])
            and isinstance(receipt.get('errorType'), str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', receipt['errorType'])):
        result = {key: receipt[key] for key in ('status', 'code', 'errorType')}
        if scope == 'API_ADMIN_WORKSPACE':
            import runpy
            namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')),
                init_globals={'SCOPE': scope})
            workspace_diagnostic = receipt.get('workspaceDiagnostic')
            if namespace['valid_workspace_diagnostic'](workspace_diagnostic):
                result['workspaceDiagnostic'] = workspace_diagnostic
        diagnostic = receipt.get('privateDiagnostic')
        if (scope == 'API_REGISTRATION' and isinstance(diagnostic, dict)
                and set(diagnostic) == {'confirmed', 'privatePostAttempted', 'failurePhase', 'privatePostHttpStatus',
                                        'controlledReason', 'rawOutputSuppressed'}
                and diagnostic['confirmed'] is False and diagnostic['rawOutputSuppressed'] is True
                and type(diagnostic['privatePostAttempted']) is bool
                and diagnostic['failurePhase'] in ('status', 'health', 'close', 'after_status', 'after_health')
                and diagnostic['controlledReason'] in ('none', 'worker_busy', 'builtin_original_window_pending',
                    'builtin_profile_missing', 'invalid_registration_payload', 'fingerprint_cleanup_failed')
                and (diagnostic['privatePostHttpStatus'] is None or type(diagnostic['privatePostHttpStatus']) is int
                     and 100 <= diagnostic['privatePostHttpStatus'] <= 599)):
            result['privateDiagnostic'] = diagnostic
        recovery = receipt.get('recoveryDiagnostic')
        if (scope == 'API_REGISTRATION' and isinstance(recovery, dict)
                and set(recovery) == {'confirmed', 'signalsAttempted', 'nativeCount', 'nativeCountObserved', 'rawOutputSuppressed'}
                and recovery['confirmed'] is False and recovery['rawOutputSuppressed'] is True
                and type(recovery['nativeCountObserved']) is bool
                and type(recovery['nativeCount']) is int and 0 <= recovery['nativeCount'] <= 128
                and (recovery['signalsAttempted'] is None or type(recovery['signalsAttempted']) is int
                     and 0 <= recovery['signalsAttempted'] <= 128)):
            result['recoveryDiagnostic'] = recovery
        return result
    return {'status': scope + '_VERIFICATION_FAILED', 'code': 'API_ADMIN_REMOTE_VERIFICATION_FAILED'}


def validate_migration_origin(namespace, context):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256',
              'migration', 'migrationState', 'task', 'guards'}
    if (not isinstance(context, dict) or set(context) != fields or type(context.get('version')) is not int
            or context['version'] != 1 or context.get('commit') != namespace['MIGRATION_SUCCESSOR_COMMIT']
            or context.get('manifestSha256') != namespace['MIGRATION_SUCCESSOR_MANIFEST_SHA']
            or context.get('buildProofSha256') != namespace['MIGRATION_SUCCESSOR_PROOF_SHA']
            or context.get('migration') != namespace['MIGRATION_IDENTITY']
            or not isinstance(context.get('release'), str)
            or not re.fullmatch(r'/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-'
                                + namespace['MIGRATION_SUCCESSOR_COMMIT'][:12], context['release'])):
        raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    state, task, guards = (context.get(name) for name in ('migrationState', 'task', 'guards'))
    if (not all(isinstance(value, dict) for value in (state, task, guards))
            or set(state) != {'name', 'sha256', 'status', 'schemaVerified', 'appliedMigrationsSha256'}
            or state.get('name') != namespace['MIGRATION_NAME'] or state.get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
            or state.get('status') != 'APPLIED' or state.get('schemaVerified') is not True
            or not isinstance(state.get('appliedMigrationsSha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', state['appliedMigrationsSha256'])
            or task != namespace['MIGRATION_TASK'] or type(task.get('attempt')) is not int
            or type(task.get('auditCount')) is not int
            or any(task.get(name) is not True for name in ('registered', 'passwordCandidatePresent'))
            or any(task.get(name) is not False for name in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
            or set(guards) != {'rechargeIdle', 'registrationBusy', 'registrationLeaseActive', 'registrationWindowRetained'}
            or guards.get('rechargeIdle') is not True or guards.get('registrationWindowRetained') is not True
            or guards.get('registrationBusy') is not False or guards.get('registrationLeaseActive') is not False):
        raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    return namespace['migration_successor_marker'](context)


def validate_online_workspace_receipt(namespace, receipt, expected, mode):
    """Admit eight services only through this run's verified online origin."""
    before = {}
    if mode == 'readback':
        path = Path('.deploy/production-release') / (namespace['PREFIX'] + '-preflight-result.json')
        before = json.loads(path.read_text()) if path.is_file() else {}
    services = receipt.get('services', {})
    selected = (receipt.get('onlineOrigin') is not None
        or receipt.get('preservedOnlineOrigin') is not None
        or receipt.get('onlineSuccessorVerified') is True
        or isinstance(services, dict) and 'online-recharge' in services
        or isinstance(before, dict) and before.get('onlineOrigin') is not None)
    if not selected:
        return False
    context = receipt.get('onlineOrigin') if mode == 'preflight' else before.get('onlineOrigin')
    code = 'API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED'
    try:
        namespace['validate_online_successor_origin'](context)
        marker = namespace['online_successor_marker'](context)
    except (KeyError, TypeError, ValueError, RuntimeError):
        raise RuntimeError(code) from None
    if context['commit'] != (receipt.get('commit') if mode == 'preflight' else before.get('commit')):
        raise RuntimeError(code)
    names = {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
             'auto-registration', 'online-recharge'}
    keys = {'image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256',
            'environmentSha256', 'configurationSha256'}
    if (receipt.get('onlineSuccessorVerified') is not True
            or type(receipt.get('observedServiceCount')) is not int
            or receipt['observedServiceCount'] != len(names)
            or not isinstance(services, dict) or set(services) != names
            or any(not isinstance(row, dict) or set(row) != keys or row.get('status') != 'running'
                or (row.get('health') not in ('healthy', None) if name == 'caddy'
                    else row.get('health') != 'healthy')
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', row.get('image', ''))
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9:/@._-]{0,511}', row.get('reference', ''))
                or any(not re.fullmatch(r'[a-f0-9]{64}', row.get(key, '')) for key in
                    ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
                for name, row in services.items())
            or services['online-recharge']['configurationSha256'] != context['engineConfigurationSha256']):
        raise RuntimeError(code)
    if mode == 'readback':
        prior = before.get('services', {})
        if (before.get('status') != 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
                or before.get('mode') != 'preflight'
                or before.get('onlineSuccessorVerified') is not True
                or type(before.get('observedServiceCount')) is not int
                or before.get('observedServiceCount') != len(names)
                or before.get('releaseCandidateCommit') != expected
                or os.environ.get('RELEASE_COMMIT') != expected
                or before.get('commit') != os.environ.get('EXPECTED_CURRENT')
                or not re.fullmatch(r'[a-f0-9]{40}', os.environ.get('EXPECTED_CURRENT', ''))
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', ''))
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                or receipt.get('preservedOnlineOrigin') != marker
                or receipt.get('onlineEngineRebound') is not True
                or receipt.get('migrationPerformed') is not False
                or not isinstance(prior, dict) or set(prior) != names
                or any(services[name] != prior[name] for name in
                    ('mysql', 'media-resolver', 'auto-recharge', 'auto-registration'))
                or any(services[name][key] != prior.get(name, {}).get(key)
                    for name in ('online-recharge', 'caddy')
                    for key in ('image', 'reference', 'environmentSha256'))
                or services['online-recharge']['configurationSha256']
                    != prior['online-recharge'].get('configurationSha256')
                or services['online-recharge']['containerId'] == prior['online-recharge'].get('containerId')):
            raise RuntimeError(code)
    return True


def validate_pending_ended_failures(namespace, context):
    """Independently read only the two immutable, ended failed SSM commands."""
    code = 'API_ADMIN_PENDING_ONLINE_ENDED_FAILURE_CHANGED'
    try:
        expected = namespace['pending_online_ended_failures'](context)
        def unique(items):
            row = {}
            for key, value in items:
                if key in row:
                    raise ValueError('duplicate')
                row[key] = value
            return row
        for row in expected:
            raw = command('aws', '--region', os.environ['AWS_REGION'], 'ssm', 'get-command-invocation',
                '--command-id', row['commandId'], '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'],
                '--query', '{commandId:CommandId,instanceId:InstanceId,documentName:DocumentName,status:Status,'
                           'responseCode:ResponseCode,executionEnd:ExecutionEndDateTime,output:StandardOutputContent}',
                '--output', 'json')
            if not isinstance(raw, str) or len(raw.encode()) > 128 * 1024:
                raise ValueError('size')
            invocation = json.loads(raw, object_pairs_hook=unique)
            if (not isinstance(invocation, dict) or set(invocation) != {'commandId', 'instanceId', 'documentName',
                    'status', 'responseCode', 'executionEnd', 'output'}
                    or invocation['commandId'] != row['commandId']
                    or invocation['instanceId'] != os.environ['PRODUCTION_INSTANCE_ID']
                    or invocation['documentName'] != 'AWS-RunShellScript' or invocation['status'] != 'Failed'
                    or type(invocation['responseCode']) is not int or not 0 < invocation['responseCode'] <= 255
                    or not isinstance(invocation['executionEnd'], str) or not 0 < len(invocation['executionEnd']) <= 80
                    or not isinstance(invocation['output'], str) or len(invocation['output'].encode()) > 16384):
                raise ValueError('metadata')
            receipt = json.loads(invocation['output'], object_pairs_hook=unique)
            if not isinstance(receipt, dict) or namespace['fingerprint'](receipt) != row['receiptSha256']:
                raise ValueError('receipt')
        return expected
    except Exception:
        # No raw invocation, stdout, credentials or parsing error leaves this boundary.
        raise RuntimeError(code) from None


def validate_pending_workspace_receipt(namespace, receipt, expected, mode, *, proof=None):
    before_file = Path('.deploy/production-release/api-workspace-preflight-result.json')
    before = json.loads(before_file.read_text()) if mode == 'readback' and before_file.is_file() else {}
    context = receipt.get('pendingOnlineMigrationOrigin') if mode == 'preflight' else before.get('pendingOnlineMigrationOrigin')
    selected = (context is not None or receipt.get('preservedPendingOnlineMigration') is not None
                or receipt.get('pendingOnlineMigrationOrigin') is not None
                or isinstance(proof, dict) and proof.get('pendingOnlineProjection') is not None)
    if not selected:
        return False
    code = 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'
    try:
        namespace['validate_pending_online_origin'](context)
        marker = namespace['pending_online_marker'](context)
    except (ValueError, TypeError, KeyError, RuntimeError):
        raise RuntimeError(code) from None
    services = receipt.get('services', {})
    if (receipt.get('onlinePublished') is not False or receipt.get('migrationPerformed') is not False
            or receipt.get('onlineSuccessorVerified') is True or receipt.get('onlineOrigin') is not None
            or receipt.get('preservedOnlineOrigin') is not None or receipt.get('onlineEngineRebound') is True
            or not isinstance(services, dict) or set(services) != set(context['services'])):
        raise RuntimeError(code)
    if mode == 'preflight':
        predecessor = context['priorPublications'][-1]['commit'] if context['priorPublications'] else namespace['WORKSPACE_BOOTSTRAP_COMMIT']
        if predecessor != expected or services != context['services']:
            raise RuntimeError(code)
    else:
        if (before.get('status') != 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED' or before.get('mode') != 'preflight'
                or before.get('releaseCandidateCommit') != expected
                or before.get('commit') != os.environ.get('EXPECTED_CURRENT')
                or os.environ.get('RELEASE_COMMIT') != expected
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', ''))
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                or before.get('pendingOnlineEndedFailures') != namespace['pending_online_ended_failures'](context)
                or receipt.get('pendingOnlineMigrationOrigin') != context
                or receipt.get('preservedPendingOnlineMigration') != marker
                or receipt.get('observedServiceCount') != 7 or type(receipt.get('observedServiceCount')) is not int
                or receipt.get('servicesUpdated') != ['api', 'admin']
                or not isinstance(proof, dict) or proof.get('pendingOnlineProjection') is None
                or any(services[n] != context['services'][n] for n in services if n not in ('api', 'admin'))):
            raise RuntimeError(code)
    return True


def validate_receipt(receipt, expected, mode, scope='API_ADMIN'):
    wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                      else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
    if not isinstance(receipt, dict) or receipt.get('status') != wanted or receipt.get('commit') != expected:
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE') and mode == 'preflight':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        if scope == 'API_ADMIN_WORKSPACE':
            validate_pending_workspace_receipt(namespace, receipt, expected, mode)
        online_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_online_workspace_receipt(namespace, receipt, expected, mode))
        services = {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'}
        if online_workspace:
            services.add('online-recharge')
        # This finite online origin inherits the fixed bootstrap's migration.
        # Removing either origin must not select a less restrictive reader.
        if online_workspace or expected == namespace['MIGRATION_SUCCESSOR_COMMIT'] or receipt.get('migrationOrigin') is not None:
            validate_migration_origin(namespace, receipt.get('migrationOrigin'))
            if (type(receipt.get('freeBytes')) is not int or receipt['freeBytes'] <= 6 * 1024**3
                    or receipt.get('guards') != receipt['migrationOrigin']['guards']
                    or set(receipt.get('services', {})) != services
                    or any(not isinstance(row, dict) or row.get('status') != 'running'
                           for row in receipt['services'].values())):
                raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    if scope == 'API_ADMIN_MIGRATION' and mode == 'preflight':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        guards, task, state, audit = (receipt.get(n, {}) for n in ('guards', 'task', 'migrationState', 'audit'))
        if not all(isinstance(value, dict) for value in (guards, task, state, audit)):
            raise RuntimeError('API_ADMIN_MIGRATION_PREFLIGHT_CHANGED')
        if (receipt.get('migration') != namespace['MIGRATION_IDENTITY']
                or receipt.get('windowPreserved') is not True or receipt.get('requiresWindowHandoff') is not False
                or type(receipt.get('freeBytes')) is not int or receipt['freeBytes'] <= 6 * 1024**3
                or guards.get('rechargeIdle') is not True or guards.get('registrationBusy') is not False
                or guards.get('registrationLeaseActive') is not False or type(guards.get('registrationWindowRetained')) is not bool
                or guards.get('registrationWindowRetained') is not True
                or task.get('taskId') != namespace['TASK_ID'] or type(task.get('attempt')) is not int or task.get('attempt') != namespace['TASK_ATTEMPT']
                or task.get('binding') != namespace['TASK_BINDING']
                or task != namespace['MIGRATION_TASK'] or type(task.get('auditCount')) is not int
                or any(task.get(n) is not True for n in ('registered', 'passwordCandidatePresent'))
                or any(task.get(n) is not False for n in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
                or any(not re.fullmatch(r'[a-f0-9]{64}', task.get(n, '')) for n in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'))
                or state.get('status') not in ('PENDING', 'APPLIED') or state.get('schemaVerified') is not True
                or state.get('name') != namespace['MIGRATION_NAME'] or state.get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
                or not re.fullmatch(r'[a-f0-9]{64}', state.get('appliedMigrationsSha256', ''))
                or audit.get('mode') != 'STRICT_ZERO_49' or audit.get('checkCount') != 49 or audit.get('violationCount') != 0
                or not re.fullmatch(r'[a-f0-9]{64}', audit.get('checksSha256', ''))):
            raise RuntimeError('API_ADMIN_MIGRATION_PREFLIGHT_CHANGED')
    if mode == 'readback':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        proof = json.loads((Path('.deploy/production-release') / namespace['PROOF_FILE']).read_text())
        if scope == 'API_ADMIN_WORKSPACE':
            from types import SimpleNamespace
            def need(condition, code):
                if not condition:
                    raise RuntimeError(code)
            namespace['validate_proof'](SimpleNamespace(require=need), proof, expected, receipt.get('sourceTree'))
        online_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_online_workspace_receipt(namespace, receipt, expected, mode))
        pending_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_pending_workspace_receipt(namespace, receipt, expected, mode, proof=proof))
        updated = ['api', 'admin'] if pending_workspace else [*namespace['UPDATED'], *(['online-recharge'] if online_workspace else [])]
        if (receipt.get('buildProofSha256') != namespace['fingerprint'](proof)
                or receipt.get('sourceTree') != proof['sourceTree'] or proof['commit'] != expected
                or receipt.get('servicesUpdated') != updated
                or receipt.get('preservedServiceCount') != (5 if pending_workspace else 4 if scope == 'API_ADMIN_WORKSPACE' else 5)
                or receipt.get('runningImagesAndContentMatched') is not True
                or receipt.get('environmentUnchanged') is not True
                or any(receipt.get('services', {}).get(name, {}).get('image') != row['imageId']
                       or receipt.get('services', {}).get(name, {}).get('reference') != row['reference']
                       for name, row in proof['images'].items() if name in namespace['UPDATED'])):
            raise RuntimeError('API_ADMIN_READBACK_BUILD_CHANGED')
        if scope == 'API_ADMIN_MIGRATION' and (
                receipt.get('migration') != namespace['MIGRATION_IDENTITY']
                or receipt.get('migrationApplied') is not True or type(receipt.get('migrationPerformed')) is not bool
                or receipt.get('taskHmacMatched') is not True or receipt.get('windowPreserved') is not True
                or type(receipt.get('registrationWindowRetained')) is not bool
                or receipt.get('migrationState', {}).get('status') != 'APPLIED'
                or receipt.get('migrationState', {}).get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
                or receipt.get('migrationState', {}).get('name') != namespace['MIGRATION_NAME']
                or receipt.get('migrationState', {}).get('schemaVerified') is not True
                or not re.fullmatch(r'[a-f0-9]{64}', receipt.get('migrationState', {}).get('appliedMigrationsSha256', ''))):
            raise RuntimeError('API_ADMIN_MIGRATION_READBACK_CHANGED')
        if scope == 'API_ADMIN_WORKSPACE':
            if (receipt.get('workspaceVolume', {}).get('status') != 'PRESENT'
                    or not re.fullmatch(r'[a-f0-9]{64}', receipt.get('workspaceVolume', {}).get('identitySha256', ''))
                    or receipt.get('volumePreserved') is not True or receipt.get('volumeDeletionPerformed') is not False
                    or receipt.get('registrationHealthChecked') is not True or receipt.get('offlineAcceptance') != proof.get('acceptance')):
                raise RuntimeError('API_ADMIN_WORKSPACE_READBACK_CHANGED')
        if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE'):
            before_file = Path('.deploy/production-release') / (namespace['PREFIX'] + '-preflight-result.json')
            before = json.loads(before_file.read_text()) if before_file.is_file() else {}
            context = before.get('migrationOrigin')
            if online_workspace or context is not None or receipt.get('preservedMigrationOrigin') is not None:
                marker = validate_migration_origin(namespace, context)
                if (before.get('status') != scope + '_BASELINE_VERIFIED'
                        or before.get('mode') != 'preflight'
                        or before.get('releaseCandidateCommit') != expected
                        or os.environ.get('RELEASE_COMMIT') != expected
                        or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', ''))
                        or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                        or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                        or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                        or receipt.get('preservedMigrationOrigin') != marker
                        or receipt.get('migrationPreserved') is not True or receipt.get('migrationPerformed') is not False
                        or receipt.get('taskHmacMatched') is not True or receipt.get('windowPreserved') is not True
                        or receipt.get('registrationWindowRetained') is not True):
                    raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    return receipt


def main():
    os.umask(0o077)
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    operation = os.environ.get('RELEASE_OPERATION', '')
    scope = selected_scope(operation)
    if mode == 'handoff' and operation != 'handoff_api_registration':
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    if mode == 'business' and operation != 'verify_registration_business':
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    if mode in ('handoff-observe', 'handoff-recover') and operation != {'handoff-observe': 'verify_registration_handoff', 'handoff-recover': 'recover_registration_handoff'}[mode]:
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    expected = os.environ['RELEASE_COMMIT'] if mode == 'readback' else os.environ['EXPECTED_CURRENT']
    data = parameters(os.environ['RELEASE_COMMIT'], expected, mode, scope,
                      require_closed=operation != 'verify_api_registration')
    aws = ['aws', '--region', os.environ['AWS_REGION'], 'ssm']
    command_id = command(*aws, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
        '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(data), '--timeout-seconds', '300',
        '--comment', 'ID ' + scope + ' independent ' + mode, '--query', 'Command.CommandId', '--output', 'text')
    if not re.fullmatch(r'[a-f0-9-]{36}', command_id):
        raise RuntimeError('API_ADMIN_COMMAND_ID_INVALID')
    print(scope + '_COMMAND ' + command_id, flush=True)
    target = Path('.deploy/production-release') / (('api-workspace' if scope == 'API_ADMIN_WORKSPACE' else scope.lower().replace('_', '-')) + f'-{mode}-result.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(36):
        time.sleep(10)
        try:
            result = json.loads(command(*aws, 'get-command-invocation', '--command-id', command_id,
                '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json'))
        except RuntimeError:
            continue
        if result.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            continue
        output = result.get('StandardOutputContent', '')
        # Remote helper emits only hashes, identifiers, guarded booleans and status.
        try:
            receipt = json.loads(output) if len(output) < 24000 else {}
        except (ValueError, TypeError):
            receipt = {}
        wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                          else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
        if result.get('Status') != 'Success' or result.get('ResponseCode') != 0 or receipt.get('status') != wanted:
            failure = safe_failure(receipt, scope)
            target.write_text(json.dumps({'commandId': command_id, 'mode': mode, **failure}, indent=2) + '\n')
            print(json.dumps(failure))
            raise RuntimeError(failure['code'])
        validate_receipt(receipt, expected, mode, scope)
        if scope == 'API_ADMIN_WORKSPACE' and receipt.get('pendingOnlineMigrationOrigin') is not None:
            import runpy
            namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
            receipt['pendingOnlineEndedFailures'] = validate_pending_ended_failures(namespace, receipt['pendingOnlineMigrationOrigin'])
        target.write_text(json.dumps({'commandId': command_id, 'mode': mode,
            'releaseCandidateCommit': os.environ['RELEASE_COMMIT'],
            'workflowRunId': os.environ.get('GITHUB_RUN_ID', ''),
            'workflowRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT', ''), **receipt}, indent=2) + '\n')
        print(json.dumps(receipt))
        return 0
    raise RuntimeError('API_ADMIN_READONLY_TIMEOUT')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_TRANSPORT_UNAVAILABLE'
        print(json.dumps({'status': selected_scope(os.environ.get('RELEASE_OPERATION', '')) + '_VERIFICATION_FAILED', 'code': code}))
        raise SystemExit(1) from None
