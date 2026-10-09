"""Independent, non-authorizing inventory for the fixed restored API.

This is deliberately separate from the preflight F and success Q transports.
It never turns a failed baseline into a successful release qualification.
"""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import time

BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
STATUS = 'API_ADMIN_WORKSPACE_DECLARATION_INVENTORY'
HELPERS = ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
           'online-recharge-recovery.json', 'api-admin-pending-projection.py',
           'online-recharge-declaration-measurement.py')
FIELDS = frozenset(('status', 'commit', 'producer', 'inventory', 'authority',
                    'productionEligible', 'rawOutputSuppressed',
                    'stableServicesSha256', 'boundFilesSha256'))


def require(ok):
    if not ok:
        raise RuntimeError('API_ADMIN_DECLARATION_INVENTORY_INVALID')


def closed_json(raw):
    require(type(raw) is str and len(raw.encode('utf-8')) < 24000)

    def unique(rows):
        result = {}
        for key, value in rows:
            require(key not in result)
            result[key] = value
        return result

    def invalid(_value):
        require(False)

    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def validate_producer(value):
    require(type(value) is dict and set(value) == {
        'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    require(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}', value[k])
                for k in ('commit', 'sourceTree')))
    require(all(type(value[k]) is str and re.fullmatch('[1-9][0-9]*', value[k])
                for k in ('workflowRunId', 'workflowRunAttempt')))
    return value


def validate_receipt(value, producer, inventory_validator):
    validate_producer(producer)
    require(type(value) is dict and set(value) == FIELDS
            and value['status'] == STATUS and value['commit'] == BASELINE
            and value['producer'] == producer and value['authority'] is False
            and value['productionEligible'] is False and value['rawOutputSuppressed'] is True
            and all(type(value[k]) is str and re.fullmatch('[a-f0-9]{64}', value[k])
                    for k in ('stableServicesSha256', 'boundFilesSha256')))
    inventory_validator(value['inventory'])
    return value


def validate_ended_invocation(value, *, command_id, instance_id):
    """Bind ended AWS metadata to the actual transport inputs before reading stdout."""
    require(type(command_id) is str
            and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id)
            and type(instance_id) is str and re.fullmatch('i-(?:[a-f0-9]{8}|[a-f0-9]{17})', instance_id))
    require(type(value) is dict and value.get('CommandId') == command_id
            and value.get('InstanceId') == instance_id
            and value.get('DocumentName') == 'AWS-RunShellScript'
            and value.get('PluginName') == 'aws:runShellScript'
            and value.get('Status') == 'Success'
            and type(value.get('ResponseCode')) is int and value['ResponseCode'] == 0
            and value.get('StandardErrorContent') == ''
            and type(value.get('StandardOutputContent')) is str
            and type(value.get('ExecutionEndDateTime')) is str
            and re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                             '(?:\\.[0-9]{1,6})?(?:Z|\\+00:00)', value['ExecutionEndDateTime']))
    try:
        ended = datetime.datetime.fromisoformat(value['ExecutionEndDateTime'].replace('Z', '+00:00'))
    except (ValueError, OverflowError):
        require(False)
    require(ended.utcoffset() == datetime.timedelta(0)
            and ended <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5))
    return value


def parameters(commit, expected, producer, digests):
    validate_producer(producer)
    require(commit == producer['commit'] and expected == BASELINE
            and type(digests) is dict and set(digests) == set(HELPERS)
            and all(type(v) is str and re.fullmatch('[a-f0-9]{64}', v) for v in digests.values()))
    directory = '/opt/id-business-v2/.staging/api-workspace-declaration-' + commit
    # Fixed inputs only. The private directory and every installed file are
    # checked before curl can follow a destination link or overwrite a stranger.
    guard = (
        'import os,pathlib,stat; p=pathlib.Path(' + repr(directory) + ');'
        'r=p.parent; b=r.parent; assert all(x.is_dir() and not x.is_symlink() and x.resolve()==x '
        'and x.stat().st_uid==0 and stat.S_IMODE(x.stat().st_mode)&18==0 for x in (b,r));'
        'p.mkdir(mode=448,exist_ok=True);'
        'assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_uid==0 '
        'and stat.S_IMODE(p.stat().st_mode)==448;'
        'names=' + repr(HELPERS) + ';'
        'assert all(not (p/n).is_symlink() and (not (p/n).exists() or '
        '((p/n).is_file() and (p/n).stat().st_uid==0 and (p/n).stat().st_nlink==1 '
        'and (p/n).stat().st_size<=(2097152 if n=="remote-deploy.py" else 1048576))) for n in names)')
    import shlex
    commands = ['set -eu', 'umask 077', 'python3 -c ' + shlex.quote(guard)]
    for name in HELPERS:
        commands.extend([
            'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/'
            'wangchaozhuanyong/id-business-system/' + commit + '/scripts/production-release/'
            + name + ' -o ' + directory + '/' + name,
            'chmod 600 ' + directory + '/' + name,
            'printf "%s\\n" ' + shlex.quote(digests[name] + '  ' + directory + '/' + name)
            + ' | sha256sum -c - >/dev/null'])
    encoded = base64.b64encode(json.dumps(producer, sort_keys=True, separators=(',', ':')).encode()).decode()
    commands.append('python3 -B ' + directory + '/remote-deploy.py '
                    '--api-workspace-declaration-inventory --expected-current ' + expected
                    + ' --inventory-producer ' + encoded)
    result = {'commands': commands, 'executionTimeout': ['300']}
    require(len(json.dumps(result).encode()) < 20 * 1024)
    return result


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('API_ADMIN_DECLARATION_INVENTORY_TRANSPORT_FAILED')
    return result.stdout.strip()


def main():
    os.umask(0o077)
    require(os.environ.get('RELEASE_OPERATION') in ('verify_api_workspace', 'release_api_workspace'))
    producer = validate_producer({
        'commit': os.environ['RELEASE_COMMIT'], 'sourceTree': os.environ['SOURCE_TREE'],
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']})
    require(command('git', 'rev-parse', 'HEAD') == producer['commit']
            and command('git', 'rev-parse', 'HEAD^{tree}') == producer['sourceTree'])
    digests = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in HELPERS}
    data = parameters(producer['commit'], os.environ['EXPECTED_CURRENT'], producer, digests)
    aws = ['aws', 'ssm', '--region', os.environ.get('AWS_REGION', 'ap-northeast-1')]
    command_id = command(*aws, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
        '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(data),
        '--query', 'Command.CommandId', '--output', 'text')
    require(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id) is not None)
    target = Path('.deploy/production-release/api-workspace-declaration-inventory-result.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    namespace = runpy.run_path(str(Path(__file__).with_name('online-recharge-declaration-measurement.py')))
    for _ in range(36):
        time.sleep(10)
        try:
            invocation = json.loads(command(*aws, 'get-command-invocation', '--command-id', command_id,
                '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json'))
        except RuntimeError:
            continue
        require(type(invocation) is dict)
        if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            continue
        # Neither stdout nor stderr is emitted or saved before the closed safe
        # report passes. In particular this file cannot be used as F or Q.
        validate_ended_invocation(invocation, command_id=command_id,
                                  instance_id=os.environ['PRODUCTION_INSTANCE_ID'])
        receipt = validate_receipt(closed_json(invocation.get('StandardOutputContent')),
                                   producer, namespace['validate_inventory'])
        target.write_text(json.dumps({'commandId': command_id, 'mode': 'declaration-inventory',
                                     **receipt}, indent=2) + '\n')
        target.chmod(0o600)
        print(json.dumps(receipt))
        return 0
    raise RuntimeError('API_ADMIN_DECLARATION_INVENTORY_TIMEOUT')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'status': 'API_ADMIN_DECLARATION_INVENTORY_FAILED',
                          'authority': False, 'productionEligible': False,
                          'rawOutputSuppressed': True}))
        raise SystemExit(1) from None
