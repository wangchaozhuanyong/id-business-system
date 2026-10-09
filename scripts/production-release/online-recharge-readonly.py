"""Pinned independent production observation for the online recharge release."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time
from types import SimpleNamespace


def closed_json(raw):
    if not isinstance(raw, str) or not 0 < len(raw.encode()) <= 256 * 1024:
        raise ValueError('ONLINE_RECHARGE_RECEIPT_INVALID')
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('ONLINE_RECHARGE_RECEIPT_INVALID')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if result.returncode:
        if 'get-command-invocation' in args and 'InvocationDoesNotExist' in result.stderr:
            raise RuntimeError('ONLINE_RECHARGE_INVOCATION_PENDING')
        raise RuntimeError('ONLINE_RECHARGE_TRANSPORT_FAILED')
    return result.stdout.strip()


def parameters(commit, expected, mode):
    if mode not in ('preflight', 'readback', 'diagnostic') or not all(
            isinstance(v, str) and re.fullmatch(r'[a-f0-9]{40}', v) for v in (commit, expected)):
        raise ValueError('ONLINE_RECHARGE_INPUT_INVALID')
    directory = f'/opt/id-business-v2/.staging/online-recharge-verify-{commit}'
    commands = ['set -eu', f'mkdir -p {directory}']
    for name in ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
                 'online-recharge-recovery.json'):
        digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        commands.extend([
            f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{commit}/scripts/production-release/{name} -o {directory}/{name}',
            f'echo "{digest}  {directory}/{name}" | sha256sum -c - >/dev/null'])
    commands.append(f'python3 -B {directory}/remote-deploy.py --online-recharge-{mode} --expected-current {expected}')
    return {'commands': commands, 'executionTimeout': ['300']}


def safe_failure(receipt):
    allowed = ('ONLINE_RECHARGE_VERIFICATION_FAILED', 'ONLINE_RECHARGE_FAILED_STATE_UNVERIFIED',
               'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'ONLINE_RECHARGE_FAILED_RESTORED',
               'ONLINE_RECHARGE_PARTIAL_RECOVERY_REQUIRED')
    result = {'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED', 'code': 'ONLINE_RECHARGE_REMOTE_VERIFICATION_FAILED'}
    if (isinstance(receipt, dict) and receipt.get('status') in allowed
            and re.fullmatch(r'(?:ONLINE_RECHARGE|API_ADMIN)_[A-Z0-9_]+', receipt.get('code', ''))):
        result = {'status': receipt['status'], 'code': receipt['code']}
        if re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', receipt.get('errorType', '')):
            result['errorType'] = receipt['errorType']
    return result


def validate(receipt, mode, commit, expected, output):
    controller = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name('remote-deploy.py'))))
    scope = controller.online_recharge_scope()[0]
    summary = scope.validate_receipt(controller, receipt, mode, commit, expected)
    service_keys = ('status', 'health', 'image', 'reference', 'containerId', 'startedAtSha256',
                    'environmentSha256', 'configurationSha256')
    services = {name: {k: row[k] for k in service_keys if k in row}
                for name, row in receipt['services'].items()}
    if mode == 'readback':
        proof = closed_json((output / 'online-recharge-build-proof.json').read_text())
        scope.validate_proof(controller, proof, commit, os.environ['SOURCE_TREE'],
            os.environ['RELEASE_REPOSITORY'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
        before = closed_json((output / 'online-recharge-preflight-result.json').read_text())
        recovery = before.get('migrationRecovery')
        if (summary['sourceTree'] != proof['sourceTree'] or summary['buildProofSha256'] != scope.fingerprint(proof)
                or before.get('releaseCandidateCommit') != commit
                or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                or before.get('status') != 'ONLINE_RECHARGE_BASELINE_VERIFIED'
                or summary.get('migrationRecovery') != recovery
                or (recovery is not None and (before.get('migrationPerformed') is not False
                                             or summary.get('migrationPerformed') is not False))
                or (recovery is None and summary.get('migrationPerformed') is not True)
                or any(services.get(n) != before.get('services', {}).get(n) for n in scope.PRESERVED)
                or any(services[n]['image'] != proof['images'][n]['imageId']
                       or services[n]['reference'] != proof['images'][n]['reference'] for n in scope.UPDATED)):
            raise ValueError('ONLINE_RECHARGE_READBACK_BINDING_CHANGED')
    return {**summary, 'services': services, 'releaseCandidateCommit': commit,
            'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}


def filter_deploy(value, output):
    try:
        receipt = closed_json(value.get('StandardOutputContent', ''))
        if value.get('Status') != 'Success' or value.get('ResponseCode') != 0:
            print(json.dumps(safe_failure(receipt)))
            return 1
        summary = validate(receipt, 'readback', os.environ['RELEASE_COMMIT'], os.environ['RELEASE_COMMIT'], output)
        (output / 'online-recharge-deploy-result.json').write_text(json.dumps(summary, sort_keys=True) + '\n')
        print(json.dumps({k: v for k, v in summary.items() if k != 'services'}))
        return 0
    except Exception:
        print(json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED', 'code': 'ONLINE_RECHARGE_DEPLOY_RECEIPT_UNAVAILABLE'}))
        return 1


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    output = Path('.deploy/production-release')
    output.mkdir(parents=True, exist_ok=True)
    if mode == 'filter-deploy':
        return filter_deploy(closed_json(sys.stdin.read()), output)
    operation = os.environ.get('RELEASE_OPERATION')
    if mode not in ('preflight', 'readback', 'diagnostic') or operation not in ('verify_online_recharge', 'release_online_recharge'):
        raise ValueError('ONLINE_RECHARGE_INPUT_INVALID')
    commit = os.environ['RELEASE_COMMIT']
    expected = commit if mode == 'readback' else os.environ['EXPECTED_CURRENT']
    parameter_file = output / f'online-recharge-{mode}-parameters.json'
    parameter_file.write_text(json.dumps(parameters(commit, expected, mode)))
    command_id = command('aws', 'ssm', 'send-command', '--region', os.environ['AWS_REGION'],
        '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'], '--document-name', 'AWS-RunShellScript',
        '--parameters', 'file://' + str(parameter_file), '--timeout-seconds', '300',
        '--comment', 'Online recharge independent ' + mode, '--query', 'Command.CommandId', '--output', 'text')
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id):
        raise ValueError('ONLINE_RECHARGE_COMMAND_ID_INVALID')
    (output / f'online-recharge-{mode}-command.json').write_text(json.dumps({'commandId': command_id}))
    deadline = time.monotonic() + 330
    while time.monotonic() < deadline:
        try:
            value = closed_json(command('aws', 'ssm', 'get-command-invocation', '--region', os.environ['AWS_REGION'],
                '--command-id', command_id, '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json'))
        except RuntimeError as error:
            if str(error) != 'ONLINE_RECHARGE_INVOCATION_PENDING':
                raise
            time.sleep(5)
            continue
        if value.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        receipt = closed_json(value.get('StandardOutputContent', ''))
        if value.get('Status') != 'Success' or value.get('ResponseCode') != 0:
            failure = safe_failure(receipt)
            (output / f'online-recharge-{mode}-failure.json').write_text(json.dumps(failure))
            print(json.dumps(failure))
            return 1
        if mode == 'diagnostic':
            controller = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name('remote-deploy.py'))))
            summary = controller.online_recharge_scope()[0].validate_diagnostic(controller, receipt, expected)
        else:
            summary = validate(receipt, mode, commit, expected, output)
        (output / f'online-recharge-{mode}-result.json').write_text(json.dumps(summary, sort_keys=True) + '\n')
        print(json.dumps({k: v for k, v in summary.items() if k != 'services'}))
        return 0
    raise RuntimeError('ONLINE_RECHARGE_READONLY_TIMEOUT')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'ONLINE_RECHARGE_[A-Z0-9_]+', code):
            code = 'ONLINE_RECHARGE_TRANSPORT_UNAVAILABLE'
        print(json.dumps({'status': 'ONLINE_RECHARGE_VERIFICATION_FAILED', 'code': code}))
        raise SystemExit(1) from None
