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
    for name in (('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
                  'online-recharge-recovery.json')
                 if scope == 'API_ADMIN_WORKSPACE' else ('remote-deploy.py', 'api-admin-scope.py')):
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


def validate_online_origin(namespace, context):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256', 'files', 'migrationState', 'binding'}
    binding_fields = {'image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256',
                      'apiContainerId', 'containerId', 'startedAtSha256'}
    if (not isinstance(context, dict) or set(context) != fields or type(context['version']) is not int
            or context['version'] != 1 or not isinstance(context['release'], str) or not Path(context['release']).is_absolute()
            or not re.fullmatch(r'[a-f0-9]{40}', context['commit'] or '')
            or any(not re.fullmatch(r'[a-f0-9]{64}', context[n] or '') for n in ('manifestSha256', 'buildProofSha256'))
            or not isinstance(context['files'], dict) or set(context['files']) != set(namespace['ONLINE_ORIGIN_FILES'])
            or any(not isinstance(n, str) or not re.fullmatch(r'[a-f0-9]{64}', n) for n in context['files'].values())
            or context['files']['release-manifest.json'] != context['manifestSha256']
            or not isinstance(context['binding'], dict) or set(context['binding']) != binding_fields):
        raise RuntimeError('API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED')
    binding = context['binding']; state = context['migrationState']
    if (not isinstance(state, dict) or set(state) != {'name', 'sha256', 'status', 'schemaVerified', 'appliedMigrationsSha256'}
            or state.get('name') != '20261009093000_online_recharge' or state.get('status') != 'APPLIED'
            or state.get('sha256') != '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95'
            or state.get('schemaVerified') is not True or not re.fullmatch(r'[a-f0-9]{64}', state.get('appliedMigrationsSha256', ''))
            or not isinstance(binding['image'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', binding['image'])
            or not isinstance(binding['reference'], str) or not re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                r'[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*-online-recharge', binding['reference'])
            or any(not isinstance(binding[n], str) or not re.fullmatch(r'[a-f0-9]{64}', binding[n]) for n in
                ('environmentSha256', 'configurationSha256', 'volumeIdentitySha256', 'apiContainerId', 'containerId', 'startedAtSha256'))):
        raise RuntimeError('API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED')
    return namespace['online_marker'](context)


def validate_receipt(receipt, expected, mode, scope='API_ADMIN'):
    wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                      else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
    if not isinstance(receipt, dict) or receipt.get('status') != wanted or receipt.get('commit') != expected:
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE') and mode == 'preflight':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        online = receipt.get('onlineRechargeOrigin') if scope == 'API_ADMIN_WORKSPACE' else None
        if online is not None:
            validate_online_origin(namespace, online)
        if expected == namespace['MIGRATION_SUCCESSOR_COMMIT'] or receipt.get('migrationOrigin') is not None:
            validate_migration_origin(namespace, receipt.get('migrationOrigin'))
            if (type(receipt.get('freeBytes')) is not int or receipt['freeBytes'] <= 6 * 1024**3
                    or receipt.get('guards') != receipt['migrationOrigin']['guards']
                    or set(receipt.get('services', {})) != {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'}
                        | ({'online-recharge'} if online is not None else set())
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
        if (receipt.get('buildProofSha256') != namespace['fingerprint'](proof)
                or receipt.get('sourceTree') != proof['sourceTree'] or proof['commit'] != expected
                or receipt.get('servicesUpdated') != list(namespace['UPDATED'])
                or receipt.get('preservedServiceCount') != (4 if scope == 'API_ADMIN_WORKSPACE' else 5)
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
            protection = receipt.get('sqliteProtection')
            if protection is not None and (not isinstance(protection, dict)
                    or set(protection) != {'backupVerified', 'restoreVerified', 'sqliteProtectionSha256', 'backupSha256', 'backupSize'}
                    or protection['backupVerified'] is not True or protection['restoreVerified'] is not True
                    or type(protection['backupSize']) is not int or not 0 < protection['backupSize'] <= 256 * 1024**2
                    or any(not isinstance(protection[key], str) or not re.fullmatch(r'[a-f0-9]{64}', protection[key])
                           for key in ('sqliteProtectionSha256', 'backupSha256'))):
                raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
            online_marker = receipt.get('preservedOnlineRechargeOrigin')
            before_path = Path('.deploy/production-release/api-workspace-preflight-result.json')
            before = json.loads(before_path.read_text()) if before_path.is_file() else {}
            context = before.get('onlineRechargeOrigin')
            if (('online-recharge' in receipt.get('services', {})) is not (online_marker is not None)
                    or (context is not None) is not (online_marker is not None)):
                raise RuntimeError('API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED')
            if online_marker is not None:
                marker = validate_online_origin(namespace, context)
                rebind = receipt.get('onlineNetworkRebind')
                if (online_marker != marker or receipt.get('servicesRebound') != ['online-recharge']
                        or set(receipt.get('services', {})) != {'api','admin','caddy','mysql','media-resolver','auto-recharge','auto-registration','online-recharge'}
                        or not isinstance(rebind, dict) or set(rebind) != {'version','before','after','sqlFence','businessActions'}
                        or type(rebind['version']) is not int or rebind['version'] != 1
                        or type(rebind['businessActions']) is not int or rebind['businessActions'] != 0
                        or not isinstance(rebind['before'], dict) or not isinstance(rebind['after'], dict)
                        or set(rebind['before']) != set(context['binding']) or set(rebind['after']) != set(context['binding'])
                        or any(rebind['before'][n] != rebind['after'][n] or rebind['after'][n] != context['binding'][n]
                            for n in ('image','reference','environmentSha256','configurationSha256','volumeIdentitySha256'))
                        or rebind['before']['containerId'] == rebind['after']['containerId']
                        or rebind['before']['startedAtSha256'] == rebind['after']['startedAtSha256']
                        or rebind['after']['apiContainerId'] != receipt['services']['api'].get('containerId')
                        or any(rebind['after'][n] != receipt['services']['online-recharge'].get(n)
                            for n in ('image','reference','environmentSha256','containerId','startedAtSha256'))):
                    raise RuntimeError('API_ADMIN_ONLINE_REBIND_RECEIPT_CHANGED')
                namespace['online_fence_receipt'](SimpleNamespace(require=need),rebind['sqlFence'])
        if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE'):
            before_file = Path('.deploy/production-release') / (namespace['PREFIX'] + '-preflight-result.json')
            before = json.loads(before_file.read_text()) if before_file.is_file() else {}
            context = before.get('migrationOrigin')
            if context is not None or receipt.get('preservedMigrationOrigin') is not None:
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
