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


def parameters(commit, expected, mode, scope='API_ADMIN', *, require_closed=True):
    if (not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (commit, expected))
            or scope not in ('API_ADMIN', 'API_REGISTRATION') or mode not in ('preflight', 'readback', 'handoff', 'business', 'handoff-observe', 'handoff-recover')
            or mode in ('handoff', 'business', 'handoff-observe', 'handoff-recover') and scope != 'API_REGISTRATION' or type(require_closed) is not bool):
        raise ValueError('API_ADMIN_INPUT_INVALID')
    prefix = scope.lower().replace('_', '-')
    directory = f'/opt/id-business-v2/.staging/{prefix}-verify-{commit}'
    commands = ['set -eu', f'mkdir -p {directory}']
    for name in ('remote-deploy.py', 'api-admin-scope.py'):
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


def validate_receipt(receipt, expected, mode, scope='API_ADMIN'):
    wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                      else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
    if not isinstance(receipt, dict) or receipt.get('status') != wanted or receipt.get('commit') != expected:
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    if mode == 'readback':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        proof = json.loads((Path('.deploy/production-release') / namespace['PROOF_FILE']).read_text())
        if (receipt.get('buildProofSha256') != namespace['fingerprint'](proof)
                or receipt.get('sourceTree') != proof['sourceTree'] or proof['commit'] != expected
                or receipt.get('servicesUpdated') != list(namespace['UPDATED'])
                or receipt.get('preservedServiceCount') != 5
                or receipt.get('runningImagesAndContentMatched') is not True
                or receipt.get('environmentUnchanged') is not True
                or any(receipt.get('services', {}).get(name, {}).get('image') != row['imageId']
                       or receipt.get('services', {}).get(name, {}).get('reference') != row['reference']
                       for name, row in proof['images'].items())):
            raise RuntimeError('API_ADMIN_READBACK_BUILD_CHANGED')
    return receipt


def main():
    os.umask(0o077)
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    operation = os.environ.get('RELEASE_OPERATION', '')
    scope = 'API_REGISTRATION' if operation in ('verify_api_registration', 'handoff_api_registration', 'release_api_registration', 'verify_registration_business', 'verify_registration_handoff', 'recover_registration_handoff') else 'API_ADMIN'
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
    target = Path('.deploy/production-release') / (scope.lower().replace('_', '-') + f'-{mode}-result.json')
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
        target.write_text(json.dumps({'commandId': command_id, 'mode': mode, **receipt}, indent=2) + '\n')
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
        print(json.dumps({'status': 'API_ADMIN_VERIFICATION_FAILED', 'code': code}))
        raise SystemExit(1) from None
