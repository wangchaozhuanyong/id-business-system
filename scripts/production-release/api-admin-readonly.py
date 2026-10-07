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


def parameters(commit, expected, mode):
    if not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (commit, expected)) or mode not in ('preflight', 'readback'):
        raise ValueError('API_ADMIN_INPUT_INVALID')
    directory = f'/opt/id-business-v2/.staging/api-admin-verify-{commit}'
    commands = ['set -eu', f'mkdir -p {directory}']
    for name in ('remote-deploy.py', 'api-admin-scope.py'):
        digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        commands.extend([f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{commit}/scripts/production-release/{name} -o {directory}/{name}',
                         f'echo "{digest}  {directory}/{name}" | sha256sum -c - >/dev/null'])
    commands.append(f'python3 -B {directory}/remote-deploy.py --api-admin-{mode} --expected-current {expected}')
    return {'commands': commands, 'executionTimeout': ['300']}


def safe_failure(receipt):
    if (isinstance(receipt, dict) and receipt.get('status') == 'API_ADMIN_VERIFICATION_FAILED'
            and isinstance(receipt.get('code'), str) and re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', receipt['code'])
            and isinstance(receipt.get('errorType'), str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', receipt['errorType'])):
        return {key: receipt[key] for key in ('status', 'code', 'errorType')}
    return {'status': 'API_ADMIN_VERIFICATION_FAILED', 'code': 'API_ADMIN_REMOTE_VERIFICATION_FAILED'}


def validate_receipt(receipt, expected, mode):
    wanted = 'API_ADMIN_BASELINE_VERIFIED' if mode == 'preflight' else 'API_ADMIN_VERIFIED'
    if not isinstance(receipt, dict) or receipt.get('status') != wanted or receipt.get('commit') != expected:
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    if mode == 'readback':
        import runpy
        scope = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')))
        proof = json.loads(Path('.deploy/production-release/api-admin-build-proof.json').read_text())
        if (receipt.get('buildProofSha256') != scope['fingerprint'](proof)
                or receipt.get('sourceTree') != proof['sourceTree'] or proof['commit'] != expected
                or receipt.get('servicesUpdated') != ['api', 'admin']
                or receipt.get('preservedServiceCount') != 5
                or receipt.get('runningImagesAndContentMatched') is not True
                or receipt.get('environmentUnchanged') is not True
                or any(receipt.get('services', {}).get(name, {}).get('image') != row['imageId']
                       or receipt.get('services', {}).get(name, {}).get('reference') != row['reference']
                       for name, row in proof['images'].items())):
            raise RuntimeError('API_ADMIN_READBACK_BUILD_CHANGED')
    return receipt


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    expected = os.environ['EXPECTED_CURRENT'] if mode == 'preflight' else os.environ['RELEASE_COMMIT']
    data = parameters(os.environ['RELEASE_COMMIT'], expected, mode)
    aws = ['aws', '--region', os.environ['AWS_REGION'], 'ssm']
    command_id = command(*aws, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
        '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(data), '--timeout-seconds', '300',
        '--comment', 'ID API Admin independent ' + mode, '--query', 'Command.CommandId', '--output', 'text')
    if not re.fullmatch(r'[a-f0-9-]{36}', command_id):
        raise RuntimeError('API_ADMIN_COMMAND_ID_INVALID')
    print('API_ADMIN_READONLY_COMMAND ' + command_id, flush=True)
    target = Path('.deploy/production-release') / f'api-admin-{mode}-result.json'
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
        wanted = 'API_ADMIN_BASELINE_VERIFIED' if mode == 'preflight' else 'API_ADMIN_VERIFIED'
        if result.get('Status') != 'Success' or result.get('ResponseCode') != 0 or receipt.get('status') != wanted:
            failure = safe_failure(receipt)
            target.write_text(json.dumps({'commandId': command_id, 'mode': mode, **failure}, indent=2) + '\n')
            print(json.dumps(failure))
            raise RuntimeError(failure['code'])
        validate_receipt(receipt, expected, mode)
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
