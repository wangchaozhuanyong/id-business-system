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
    mode = sys.argv[1] if len(sys.argv) in (2,3) else ''
    mode = {'after-bit-build-input':'pending-workspace-build-input',
            'after-bit-build-proof':'pending-workspace-build-proof'}.get(mode,mode)
    output = Path('.deploy/production-release')
    output.mkdir(parents=True, exist_ok=True)
    if _pending_workspace_selected():
        return pending_workspace_main(mode, output)
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


import base64
import gzip
import inspect
import shlex
import stat
import zlib

_PENDING_WORKSPACE_ARTIFACT_ERROR = 'ONLINE_RECHARGE_PENDING_WORKSPACE_ARTIFACT_INVALID'
_PENDING_WORKSPACE_ARTIFACT_LIMIT = 65536
_PENDING_WORKSPACE_ARTIFACT_FILES = {'preflight': 'online-recharge-pending-workspace-preflight-result.json',
    'preflight-invocation': 'online-recharge-pending-workspace-preflight-invocation.json'}


def _pending_workspace_artifact_need(ok):
    if not ok:
        raise RuntimeError(_PENDING_WORKSPACE_ARTIFACT_ERROR)


def _pending_workspace_artifact_json(raw):
    def unique(rows):
        result = {}
        for key, value in rows:
            _pending_workspace_artifact_need(key not in result)
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique,
        parse_constant=lambda unused: _pending_workspace_artifact_need(False))
    _pending_workspace_artifact_need(type(value) is dict)
    return value


def _pending_workspace_artifact_producer(producer):
    _pending_workspace_artifact_need(type(producer) is dict and set(producer) == {
        'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    _pending_workspace_artifact_need(all(type(producer[k]) is str and re.fullmatch('[a-f0-9]{40}', producer[k])
        for k in ('commit', 'sourceTree')) and all(type(producer[k]) is str
        and re.fullmatch('[1-9][0-9]{0,19}', producer[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    return dict(producer)


def _pending_workspace_artifact_directory(producer):
    return 'online-recharge-pending-workspace-preflight-' + '-'.join(producer[k] for k in
        ('commit', 'workflowRunId', 'workflowRunAttempt'))


def _pending_workspace_artifact_payload(producer, preflight_raw, invocation_raw):
    _pending_workspace_artifact_producer(producer)
    _pending_workspace_artifact_need(all(type(raw) is bytes and 0 < len(raw) < _PENDING_WORKSPACE_ARTIFACT_LIMIT
        for raw in (preflight_raw, invocation_raw)))
    f = _pending_workspace_artifact_json(preflight_raw)
    _pending_workspace_artifact_need(set(f) == {'kind', 'version', 'mode', 'status', 'commandId',
        'releaseCandidateCommit', 'workflowRunId', 'workflowRunAttempt', 'sourceTree',
        'baseline', 'services', 'ordinaryPreflight'} and f['kind'] == 'ONLINE_RECHARGE_PENDING_WORKSPACE_PREFLIGHT'
        and type(f['version']) is int and f['version'] == 2 and f['mode'] == 'preflight'
        and f['status'] == 'ONLINE_RECHARGE_PENDING_WORKSPACE_BASELINE_VERIFIED'
        and f['releaseCandidateCommit'] == producer['commit'] and f['sourceTree'] == producer['sourceTree']
        and f['workflowRunId'] == producer['workflowRunId'] and f['workflowRunAttempt'] == producer['workflowRunAttempt'])
    q = _pending_workspace_artifact_json(invocation_raw)
    required = {'CommandId', 'InstanceId', 'DocumentName', 'PluginName', 'ResponseCode', 'Status',
        'ExecutionEndDateTime', 'StandardOutputContent', 'StandardErrorContent'}
    allowed = required | {'Comment', 'DocumentVersion', 'ExecutionStartDateTime', 'ExecutionElapsedTime',
        'StatusDetails', 'StandardOutputUrl', 'StandardErrorUrl', 'CloudWatchOutputConfig'}
    _pending_workspace_artifact_need(required <= set(q) <= allowed and q['CommandId'] == f['commandId']
        and type(q['CommandId']) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', q['CommandId'])
        and q['Status'] == 'Success' and type(q['ResponseCode']) is int and q['ResponseCode'] == 0
        and q['DocumentName'] == 'AWS-RunShellScript' and q['PluginName'] == 'aws:runShellScript'
        and q['StandardErrorContent'] == '' and type(q['StandardOutputContent']) is str
        and 0 < len(q['StandardOutputContent'].encode()) < 24000)
    # ONLINE has its own ordinary finite receipt, never the API Q wire envelope.
    _pending_workspace_artifact_need(_pending_workspace_artifact_json(q['StandardOutputContent']) == f['ordinaryPreflight'])
    return f, q


def _pending_workspace_artifact_unpack(payload, expected, length):
    _pending_workspace_artifact_need(type(payload) is str and payload.isascii() and 0 < len(payload) < 90000
        and type(length) is int and 0 < length < _PENDING_WORKSPACE_ARTIFACT_LIMIT)
    packed = base64.b64decode(payload, validate=True)
    _pending_workspace_artifact_need(base64.b64encode(packed).decode('ascii') == payload)
    inflater = zlib.decompressobj(31)
    raw = inflater.decompress(packed, _PENDING_WORKSPACE_ARTIFACT_LIMIT)
    _pending_workspace_artifact_need(0 < len(raw) < _PENDING_WORKSPACE_ARTIFACT_LIMIT and len(raw) == length
        and inflater.eof and not inflater.unconsumed_tail and not inflater.unused_data
        and hashlib.sha256(raw).hexdigest() == expected)
    return raw



def _pending_workspace_artifact_store(root, uid, producer, kind, raw):
    """Descriptor-relative writer; production always supplies fixed ROOT/uid0."""
    _pending_workspace_artifact_need(type(root) is str and Path(root).is_absolute() and str(Path(root)) == root
          and Path(root).resolve() == Path(root))
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open('/', flags)
    directory = None
    try:
        for part in Path(root).parts[1:]:
            child = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = child
            ancestor = os.fstat(parent)
            _pending_workspace_artifact_need(ancestor.st_uid in (0, uid) and not stat.S_IMODE(ancestor.st_mode) & 0o022)
        info = os.fstat(parent)
        _pending_workspace_artifact_need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700)
        name = _pending_workspace_artifact_directory(producer)
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        directory = os.open(name, flags, dir_fd=parent)
        info = os.fstat(directory)
        _pending_workspace_artifact_need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700)
        filename = _PENDING_WORKSPACE_ARTIFACT_FILES[kind]
        created = False
        try:
            fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            created = True
        except FileExistsError:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            _pending_workspace_artifact_need(stat.S_ISREG(info.st_mode) and info.st_uid == uid
                  and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
            if created:
                offset = 0
                while offset < len(raw):
                    written = os.write(fd, raw[offset:])
                    _pending_workspace_artifact_need(written > 0)
                    offset += written
                os.fsync(fd)
            else:
                _pending_workspace_artifact_need(info.st_size == len(raw))
            os.lseek(fd, 0, os.SEEK_SET)
            with os.fdopen(os.dup(fd), 'rb') as stored:
                _pending_workspace_artifact_need(stored.read(_PENDING_WORKSPACE_ARTIFACT_LIMIT) == raw)
            current = os.stat(filename, dir_fd=directory, follow_symlinks=False)
            _pending_workspace_artifact_need(current.st_ino == info.st_ino and current.st_dev == info.st_dev
                  and current.st_uid == uid and stat.S_IMODE(current.st_mode) == 0o600
                  and current.st_nlink == 1 and current.st_size == len(raw))
        finally:
            os.close(fd)
        os.fsync(directory)
        # Ensure the acknowledged directory is still the named, private inode.
        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        held = os.fstat(directory)
        _pending_workspace_artifact_need(stat.S_ISDIR(named.st_mode) and named.st_ino == held.st_ino
              and named.st_dev == held.st_dev and named.st_uid == uid
              and stat.S_IMODE(named.st_mode) == 0o700)
        path_info = Path(root).stat()
        root_info = os.fstat(parent)
        _pending_workspace_artifact_need(Path(root).resolve() == Path(root)
              and path_info.st_ino == root_info.st_ino and path_info.st_dev == root_info.st_dev
              and path_info.st_uid == uid and stat.S_IMODE(path_info.st_mode) == 0o700)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(parent)
    return {'status': 'ONLINE_RECHARGE_PENDING_WORKSPACE_ARTIFACT_STORED', 'kind': kind, 'producer': producer,
            'bytesSha256': hashlib.sha256(raw).hexdigest(), 'length': len(raw)}


def _pending_workspace_artifact_program(producer, preflight_raw, invocation_raw, root, uid):
    f, unused = _pending_workspace_artifact_payload(producer, preflight_raw, invocation_raw)
    functions = (_pending_workspace_artifact_need, _pending_workspace_artifact_json, _pending_workspace_artifact_producer,
        _pending_workspace_artifact_directory, _pending_workspace_artifact_payload, _pending_workspace_artifact_unpack,
        _pending_workspace_artifact_store)
    program = 'import base64,hashlib,json,os,re,stat,zlib\nfrom pathlib import Path\n'
    for key in ('_PENDING_WORKSPACE_ARTIFACT_ERROR', '_PENDING_WORKSPACE_ARTIFACT_LIMIT', '_PENDING_WORKSPACE_ARTIFACT_FILES'):
        program += key + '=' + repr(globals()[key]) + '\n'
    program += '\n'.join(inspect.getsource(function) for function in functions)
    program += '\ntry:\n p=' + repr(producer) + '\n'
    for variable, raw in (('fraw', preflight_raw), ('qraw', invocation_raw)):
        payload = base64.b64encode(gzip.compress(raw, mtime=0)).decode('ascii')
        program += ' ' + variable + '=_pending_workspace_artifact_unpack(' + repr(payload) + ',' + repr(hashlib.sha256(raw).hexdigest()) + ',' + str(len(raw)) + ')\n'
    program += ' _pending_workspace_artifact_payload(p,fraw,qraw)\n'
    program += ' _pending_workspace_artifact_store(' + repr(root) + ',' + str(uid) + ',p,"preflight-invocation",qraw)\n'
    program += ' _pending_workspace_artifact_store(' + repr(root) + ',' + str(uid) + ',p,"preflight",fraw)\n'
    ack = {'status': 'ONLINE_RECHARGE_PENDING_WORKSPACE_ARTIFACT_STORED', 'producer': producer,
        'preflightBytesSha256': hashlib.sha256(preflight_raw).hexdigest(),
        'invocationBytesSha256': hashlib.sha256(invocation_raw).hexdigest(), 'commandId': f['commandId']}
    program += ' print(json.dumps(' + repr(ack) + '))\nexcept Exception:\n raise SystemExit(1) from None\n'
    _pending_workspace_artifact_need(len(program.encode()) < 131072)
    return program


def online_pending_workspace_artifact_parameters(producer, preflight_raw, invocation_raw):
    """Byte storage only. No P/Q issuer, source qualification or public root override."""
    try:
        program = _pending_workspace_artifact_program(producer, preflight_raw, invocation_raw,
            '/opt/id-business-v2/.staging', 0)
        body = program.encode()
        payload = base64.b64encode(gzip.compress(body, mtime=0)).decode('ascii')
        loader = 'import base64,hashlib,zlib;v=zlib.decompressobj(31);r=v.decompress(base64.b64decode(' + repr(payload) + ',validate=True),131072);'
        loader += 'assert 0<len(r)<131072 and len(r)==' + str(len(body)) + ' and v.eof and not v.unused_data and not v.unconsumed_tail;'
        loader += 'assert hashlib.sha256(r).hexdigest()==' + repr(hashlib.sha256(body).hexdigest()) + ';exec(compile(r,"<online-pending-workspace-private-artifact>","exec"))'
        result = {'commands': ['set -eu', 'umask 077', 'python3 -B -c ' + shlex.quote(loader)], 'executionTimeout': ['60']}
        _pending_workspace_artifact_need(len(json.dumps(result).encode()) < 20 * 1024)
        return result
    except Exception:
        raise RuntimeError(_PENDING_WORKSPACE_ARTIFACT_ERROR) from None


def online_pending_workspace_validate_artifact_ack(ack, producer, preflight_raw, invocation_raw):
    try:
        f, unused = _pending_workspace_artifact_payload(producer, preflight_raw, invocation_raw)
        expected = {'status': 'ONLINE_RECHARGE_PENDING_WORKSPACE_ARTIFACT_STORED', 'producer': producer,
            'preflightBytesSha256': hashlib.sha256(preflight_raw).hexdigest(),
            'invocationBytesSha256': hashlib.sha256(invocation_raw).hexdigest(), 'commandId': f['commandId']}
        _pending_workspace_artifact_need(type(ack) is dict and set(ack) == set(expected) and ack == expected)
        return ack
    except Exception:
        raise RuntimeError(_PENDING_WORKSPACE_ARTIFACT_ERROR) from None


# Finite actual ONLINE transport branch. Legacy/API entry bodies stay unchanged.
def _pending_workspace_metadata():
    return _pending_workspace_artifact_producer({key: os.environ.get(env, '') for key, env in (
        ('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
        ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})



def _pending_workspace_selected():
    return os.environ.get('RELEASE_OPERATION') in ('verify_online_recharge', 'release_online_recharge') \
        and os.environ.get('EXPECTED_CURRENT') != '0a03fa28e6b844a18833d5c63f1de700f091fc64'


def _pending_workspace_modules():
    controller = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name('remote-deploy.py'))))
    scope = controller.online_recharge_scope()[0]
    decoder = runpy.run_path(str(Path(__file__).with_name('api-admin-pending-receipt-wire.py')))['decode_receipt_output']
    return controller, scope, decoder


def pending_workspace_parameters(commit, expected, mode, producer):
    _pending_workspace_artifact_need(mode in ('preflight', 'readback') and producer == _pending_workspace_metadata()
        and commit == producer['commit'] and type(expected) is str and re.fullmatch('[a-f0-9]{40}', expected))
    # Reuse the existing checked oidc carrier path; this assigns no API entry.
    directory = '/opt/id-business-v2/.staging/oidc-' + commit
    carrier = runpy.run_path(str(Path(__file__).with_name('api-admin-readonly.py')))['formal_runtime_commands']
    commands = ['set -eu', 'umask 077', *carrier(directory, commit,
        Path(__file__).with_name('formal-runtime-package'), Path(__file__).parent)]
    encoded = base64.b64encode(json.dumps(producer, separators=(',', ':')).encode()).decode('ascii')
    commands.append('python3 -B ' + directory + '/remote-deploy.py --online-recharge-' + mode
        + ' --expected-current ' + expected + ' --declaration-producer ' + encoded)
    value = {'commands': commands, 'executionTimeout': ['300']}
    _pending_workspace_artifact_need(len(json.dumps(value).encode()) < 20 * 1024)
    return value


def _pending_workspace_command_raw(*args):
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        if 'get-command-invocation' in args and b'InvocationDoesNotExist' in result.stderr:
            raise RuntimeError('ONLINE_RECHARGE_INVOCATION_PENDING')
        raise RuntimeError('ONLINE_RECHARGE_TRANSPORT_FAILED')
    return result.stdout


def _pending_workspace_ended(raw, command_id):
    import datetime
    try:
        _pending_workspace_artifact_need(type(raw) is bytes and 0 < len(raw) < 65536)
        value = _pending_workspace_artifact_json(raw)
        end = datetime.datetime.fromisoformat(value.get('ExecutionEndDateTime', '').replace('Z', '+00:00'))
        _pending_workspace_artifact_need(type(command_id) is str
            and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id)
            and value.get('CommandId') == command_id and value.get('InstanceId') == os.environ['PRODUCTION_INSTANCE_ID']
            and value.get('DocumentName') == 'AWS-RunShellScript' and value.get('PluginName') == 'aws:runShellScript'
            and value.get('Status') == 'Success' and type(value.get('ResponseCode')) is int and value['ResponseCode'] == 0
            and value.get('StandardErrorContent') == '' and type(value.get('StandardOutputContent')) is str
            and 0 < len(value['StandardOutputContent'].encode()) < 24000
            and end.tzinfo is not None and end.utcoffset() == datetime.timedelta(0)
            and end <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5))
        return value
    except Exception:
        raise RuntimeError('ONLINE_RECHARGE_PENDING_WORKSPACE_TRANSPORT_INVALID') from None


def _pending_workspace_wait(command_id):
    deadline = time.monotonic() + 330
    while time.monotonic() < deadline:
        try:
            raw = _pending_workspace_command_raw('aws', 'ssm', 'get-command-invocation', '--region', os.environ['AWS_REGION'],
                '--command-id', command_id, '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json')
        except RuntimeError as error:
            if error.args == ('ONLINE_RECHARGE_INVOCATION_PENDING',):
                time.sleep(5)
                continue
            raise
        _pending_workspace_artifact_need(type(raw) is bytes and 0 < len(raw) < 65536)
        provisional = _pending_workspace_artifact_json(raw)
        if provisional.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        _pending_workspace_ended(raw, command_id)
        return raw
    raise RuntimeError('ONLINE_RECHARGE_READONLY_TIMEOUT')


def _pending_workspace_send(data, comment):
    _pending_workspace_artifact_need(len(json.dumps(data).encode()) < 20 * 1024)
    value = command('aws', 'ssm', 'send-command', '--region', os.environ['AWS_REGION'],
        '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'], '--document-name', 'AWS-RunShellScript',
        '--parameters', json.dumps(data), '--timeout-seconds', '300', '--comment', comment,
        '--query', 'Command.CommandId', '--output', 'text')
    _pending_workspace_artifact_need(type(value) is str and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value))
    return value


def _pending_workspace_local_bytes(path, raw):
    # Existing descriptor-relative write-once capability. No source/proof authority.
    writer = runpy.run_path(str(Path(__file__).with_name('api-admin-readonly.py')))['write_workspace_private_bytes']
    writer(path, raw)


def pending_workspace_client_binding(receipt, mode, producer, output):
    controller, scope, unused = _pending_workspace_modules()
    expected = os.environ['EXPECTED_CURRENT'] if mode == 'preflight' else producer['commit']
    summary = scope.validate_receipt(controller, receipt, mode, producer['commit'], expected)
    bridge = scope.online_pending_workspace_bridge_shape(controller, receipt.get('onlinePendingWorkspaceOrigin'))
    controller.require(bridge['baselineCommit'] == os.environ['EXPECTED_CURRENT'],
        'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    # Same complete candidate source is mandatory; actual immutable archive
    # binds all executing helpers. F/P documents cannot register this profile.
    scope._pending_workspace_profile(controller, bridge, producer)
    if mode == 'readback':
        raw = scope._declaration_source_bytes((output / 'online-recharge-pending-workspace-preflight-result.json').absolute(), limit=65535)
        f = scope.closed_recovery_json(controller, raw)
        scope._pending_workspace_complete_preflight(controller, raw, producer=producer, bridge=bridge)
        qraw = scope._declaration_source_bytes((output / 'online-recharge-pending-workspace-preflight-invocation.json').absolute(), limit=65535)
        _pending_workspace_ended(qraw, f['commandId'])
        _pending_workspace_artifact_payload(producer, raw, qraw)
        proof = scope.closed_recovery_json(controller, scope._declaration_source_bytes((output / 'online-recharge-build-proof.json').absolute(), limit=23999))
        scope.online_pending_workspace_build_shape(controller, proof, producer=producer, bridge=bridge, preflight_raw=raw)
        controller.require(summary['buildProofSha256'] == scope.fingerprint(proof)
            and summary['sourceTree'] == producer['sourceTree'] and summary.get('migrationPerformed') is False
            and summary.get('migrationRecovery') == f['ordinaryPreflight'].get('migrationRecovery')
            and all(receipt['services'][n] == f['services'][n] for n in scope.PRESERVED)
            and all(receipt['services'][n]['image'] == proof['images'][n]['imageId']
                and receipt['services'][n]['reference'] == proof['images'][n]['reference'] for n in scope.UPDATED),
            'ONLINE_RECHARGE_READBACK_BINDING_CHANGED')
    return {**summary, 'services': receipt['services'], 'releaseCandidateCommit': producer['commit'],
        'workflowRunId': producer['workflowRunId'], 'workflowRunAttempt': producer['workflowRunAttempt']}


def pending_workspace_build_input(output, *, proof_required):
    producer = _pending_workspace_metadata()
    controller, scope, unused = _pending_workspace_modules()
    raw = scope._declaration_source_bytes((output / 'online-recharge-pending-workspace-preflight-result.json').absolute(), limit=65535)
    f = scope.closed_recovery_json(controller, raw)
    bridge = scope.online_pending_workspace_bridge_shape(controller, f.get('baseline'))
    controller.require(bridge['baselineCommit'] == os.environ['EXPECTED_CURRENT'], 'ONLINE_RECHARGE_PENDING_WORKSPACE_ORIGIN_CHANGED')
    scope._pending_workspace_complete_preflight(controller, raw, producer=producer, bridge=bridge)
    qraw = scope._declaration_source_bytes((output / 'online-recharge-pending-workspace-preflight-invocation.json').absolute(), limit=65535)
    _pending_workspace_ended(qraw, f['commandId'])
    _pending_workspace_artifact_payload(producer, raw, qraw)
    scope._pending_workspace_profile(controller, bridge, producer)
    if proof_required:
        proof = scope.closed_recovery_json(controller, scope._declaration_source_bytes((output / 'online-recharge-build-proof.json').absolute(), limit=23999))
        scope.online_pending_workspace_build_shape(controller, proof, producer=producer, bridge=bridge, preflight_raw=raw)
        for service in scope.IMAGE_SERVICES:
            scope.verify_image_content(controller, Path.cwd(), proof, service)
    return {'status': 'ONLINE_RECHARGE_PENDING_WORKSPACE_BUILD_INPUT_VERIFIED', 'producer': producer,
        'preflightBytesSha256': hashlib.sha256(raw).hexdigest(), 'baselineOriginSha256': scope.fingerprint(bridge)}


def pending_workspace_main(mode, output):
    _pending_workspace_artifact_need(_pending_workspace_selected() and mode in ('preflight', 'readback', 'filter-deploy',
        'pending-workspace-build-input', 'pending-workspace-build-proof'))
    producer = _pending_workspace_metadata()
    if mode.startswith('pending-workspace-build-'):
        _pending_workspace_artifact_need(os.environ['RELEASE_OPERATION'] == 'release_online_recharge')
        print(json.dumps(pending_workspace_build_input(output, proof_required=mode == 'pending-workspace-build-proof')))
        return 0
    controller, scope, decoder = _pending_workspace_modules()
    if mode == 'filter-deploy':
        _pending_workspace_artifact_need(len(sys.argv) == 3)
        command_id = sys.argv[2]  # Actual send-command result passed by dispatch.
        raw = sys.stdin.buffer.read(65536)
    else:
        expected = producer['commit'] if mode == 'readback' else os.environ['EXPECTED_CURRENT']
        command_id = _pending_workspace_send(pending_workspace_parameters(producer['commit'], expected, mode, producer),
            'Online recharge independent ' + mode)
        raw = _pending_workspace_wait(command_id)
    invocation = _pending_workspace_ended(raw, command_id)
    receipt = decoder(invocation['StandardOutputContent'], scope='ONLINE_RECHARGE')
    summary = pending_workspace_client_binding(receipt, 'readback' if mode == 'filter-deploy' else mode, producer, output)
    if mode == 'preflight':
        binding = scope.online_pending_workspace_ended_preflight(controller, raw, command_id=command_id,
            instance_id=os.environ['PRODUCTION_INSTANCE_ID'], producer=producer, wire_decoder=decoder)
        data = online_pending_workspace_artifact_parameters(producer, binding['preflight_raw'], raw)
        installed_command = _pending_workspace_send(data, 'Online recharge immutable preflight bytes')
        installed_raw = _pending_workspace_wait(installed_command)
        ack = _pending_workspace_artifact_json(_pending_workspace_ended(installed_raw, installed_command)['StandardOutputContent'])
        online_pending_workspace_validate_artifact_ack(ack, producer, binding['preflight_raw'], raw)
        # No local F until both real observation and root-private ACK are valid.
        _pending_workspace_local_bytes(output / 'online-recharge-pending-workspace-preflight-invocation.json', raw)
        _pending_workspace_local_bytes(output / 'online-recharge-pending-workspace-preflight-result.json', binding['preflight_raw'])
    _pending_workspace_local_bytes(output / ('online-recharge-' + mode + '-invocation.json'), raw)
    _pending_workspace_local_bytes(output / ('online-recharge-' + mode + '-result.json'), (json.dumps(summary, sort_keys=True) + '\n').encode())
    print(json.dumps({k: v for k, v in summary.items() if k != 'services'}))
    return 0



def after_bit_build_input(output, *, proof_required):
    return pending_workspace_build_input(output, proof_required=proof_required)

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
