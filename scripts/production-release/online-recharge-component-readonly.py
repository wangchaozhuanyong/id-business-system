"""Bounded, source-pinned transport for ONLINE after one sealed ordinary release.

The historical ONLINE readers remain separate. An absent ordinary seal is rejected
before source staging, controller loading, Docker or an SSM request.
"""
import base64
import gzip
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time


def load(filename):
    import importlib.util
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location('online_component_client_' + filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


r = load('online-recharge-component-runtime.py')
LEGACY_PREDECESSORS = ('0a03fa28e6b844a18833d5c63f1de700f091fc64',
                       '31d2c6885a45817cd40d23fce8d6145bc9f18af2')
FORBIDDEN = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
             'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256',
             'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256',
             'DIAGNOSTIC_COMMAND_ID')
MODES = ('selection', 'label', 'preflight', 'prepare', 'build-proof', 'release', 'readback', 'diagnostic')


class NativeFailure(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__(result['receipt']['code'])


def component_selected(environment=None):
    env = os.environ if environment is None else environment
    return env.get('RELEASE_OPERATION') in ('verify_online_recharge', 'release_online_recharge') \
        and env.get('EXPECTED_CURRENT') not in LEGACY_PREDECESSORS


def selected(mode):
    a = r.authority()
    r.need(mode in MODES and component_selected(), 'SELECTION_INVALID')
    r.need(os.environ.get('EXPECTED_CURRENT') == a['producer']['commit']
           and os.environ.get('GITHUB_REF') == 'refs/heads/main'
           and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
           and os.environ.get('RELEASE_ADMIN_ONLY', 'false') == 'false'
           and os.environ.get('AWS_REGION') == 'ap-northeast-1'
           and os.environ.get('PRODUCTION_INSTANCE_ID') == a['instanceId']
           and not any(os.environ.get(name) for name in FORBIDDEN), 'SELECTION_INVALID')
    flag = os.environ.get('API_FAULT_RESTORE_APPROVED', 'false')
    r.need(flag in ('false', 'true'), 'SELECTION_INVALID')
    operation = os.environ['RELEASE_OPERATION']
    r.need(mode in ('selection', 'preflight', 'diagnostic') or operation == 'release_online_recharge',
           'SELECTION_INVALID')
    r.need(operation != 'release_online_recharge' or flag == 'true', 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    p = r.producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'],
                   os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    return r.c.load_core(a['coreSha256']), p


def command_raw(*args, optional=False):
    result = subprocess.run(args, capture_output=True, timeout=45)
    if result.returncode:
        if optional and b'InvocationDoesNotExist' in result.stderr:
            return None
        raise RuntimeError('ONLINE_RECHARGE_COMPONENT_TRANSPORT_UNAVAILABLE')
    r.need(type(result.stdout) is bytes and 0 < len(result.stdout) < 128 * 1024, 'TRANSPORT_OUTPUT_SIZE')
    return result.stdout


def output_directory():
    root = Path.cwd().resolve()
    output = root / '.deploy/production-release'
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    r.need(output.resolve() == output and not output.is_symlink()
           and all(not parent.is_symlink() for parent in output.parents), 'OUTPUT_DIRECTORY_CHANGED')
    output.chmod(0o700)
    return output


def write_once(core, path, value):
    if path.exists() or path.is_symlink():
        r.need(core.closed_json(core.private_bytes(path)) == value, 'SAVED_EVIDENCE_CHANGED')
    else:
        core.write_private(path, value)


def read_preflight(core, p):
    value = core.closed_json(core.private_bytes(Path(r.PREFLIGHT).absolute(), cap=256 * 1024))
    r.validate_preflight(core, value, p, os.environ['EXPECTED_CURRENT'])
    return value


def verify_main_head(p):
    raw = command_raw('git', 'ls-remote', 'origin', 'refs/heads/main')
    r.need(raw.decode('ascii').strip() == p['commit'] + '\trefs/heads/main',
           'STALE_MAIN_FORMAL_SEND_FORBIDDEN')


def verify_quality(p):
    run = os.environ.get('QUALITY_RUN_ID', '')
    r.need(re.fullmatch('[1-9][0-9]*', run) is not None, 'QUALITY_RUN_CHANGED')
    repository = 'wangchaozhuanyong/id-business-system'
    value = json.loads(command_raw('gh', 'api', 'repos/' + repository + '/actions/runs/' + run))
    r.need(type(value.get('id')) is int and str(value['id']) == run
           and value.get('path') == '.github/workflows/quality.yml'
           and value.get('event') == 'push' and value.get('status') == 'completed'
           and value.get('conclusion') == 'success' and value.get('head_sha') == p['commit']
           and value.get('repository', {}).get('full_name') == repository, 'QUALITY_RUN_CHANGED')
    commit = json.loads(command_raw('gh', 'api', 'repos/' + repository + '/commits/' + p['commit']))
    r.need(commit.get('sha') == p['commit']
           and commit.get('commit', {}).get('tree', {}).get('sha') == p['sourceTree'], 'QUALITY_SOURCE_TREE_CHANGED')


def predecessor_native(core):
    a = r.authority()
    raw = command_raw('aws', '--region', os.environ['AWS_REGION'], 'ssm', 'get-command-invocation',
        '--command-id', a['commandId'], '--instance-id', a['instanceId'], '--output', 'json')
    r.need(r.c.digest(raw) == a['invocationBytesSha256'], 'PREDECESSOR_NATIVE_CHANGED')
    _invocation, receipt = core.validate_invocation(raw, a['commandId'], a['instanceId'])
    r.need(r.c.fingerprint(receipt) == a['receiptSha256'], 'PREDECESSOR_NATIVE_CHANGED')
    return raw


def preflight_from_native(core, runtime, descriptor, raw):
    runtime.need(type(descriptor) is dict and set(descriptor) == {'version', 'kind', 'producer',
        'expectedCurrent', 'commandId', 'instanceId', 'invocationBytesSha256'}, 'PREFLIGHT_TRANSPORT_CHANGED')
    runtime.need(runtime.c.digest(raw) == descriptor['invocationBytesSha256'], 'PREFLIGHT_NATIVE_CHANGED')
    native, receipt = runtime.validate_component_invocation(
        core, raw, descriptor['commandId'], descriptor['instanceId'])
    runtime.need(len(native.get('StandardOutputContent', '').encode()) < 23000, 'WIRE_TOO_LARGE')
    value = {**descriptor, 'invocationRawBase64': base64.b64encode(raw).decode(), 'serverReceipt': receipt}
    runtime.validate_preflight(core, value, descriptor['producer'], descriptor['expectedCurrent'])
    return value


def parameters(mode, core, p, *, input_artifacts=None, origin_raw=None):
    a = r.authority()
    r.need(mode in ('preflight', 'release', 'readback'), 'SELECTION_INVALID')
    # Descriptor-safe source and raw-byte writers are reused without changing
    # their ordinary publication seals or borrowing an old ONLINE receipt.
    ordinary = load('api-admin-readonly.py')
    helpers = (*core.HELPERS, 'online-recharge-component-consumer.py',
               'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py')
    r.need(len(set(helpers)) == len(helpers), 'HELPER_SET_CHANGED')
    pins = {name: r.c.digest(Path(__file__).with_name(name).read_bytes()) for name in helpers}
    directory = '/opt/id-business-v2/.staging/online-component-' + '-'.join(
        p[name] for name in ('commit', 'workflowRunId', 'workflowRunAttempt'))
    args = [mode, '--commit', p['commit'], '--source-tree', p['sourceTree'], '--run-id', p['workflowRunId'],
            '--run-attempt', p['workflowRunAttempt']]
    if mode != 'readback':
        args += ['--expected-current', os.environ['EXPECTED_CURRENT']]
    native = predecessor_native(core) if origin_raw is None else origin_raw
    r.need(r.c.digest(native) == a['invocationBytesSha256'], 'PREDECESSOR_NATIVE_CHANGED')
    _value, receipt = core.validate_invocation(native, a['commandId'], a['instanceId'])
    r.need(r.c.fingerprint(receipt) == a['receiptSha256'], 'PREDECESSOR_NATIVE_CHANGED')
    native_path = '/opt/id-business-v2/.staging/online-component-origin-' + a['invocationBytesSha256'] + '/invocation.json'
    payload = ''
    preparation = ''
    if mode == 'release':
        r.need(type(input_artifacts) is tuple and len(input_artifacts) == 2, 'BUILD_INPUT_CHANGED')
        proof_raw, transport_raw = input_artifacts
        proof = core.closed_json(proof_raw, 256 * 1024)
        transport = core.closed_json(transport_raw, 256 * 1024)
        r.validate_preflight(core, transport, p, os.environ['EXPECTED_CURRENT'])
        r.validate_build(proof, p, proof['sourceProjection'], transport,
                         os.environ['QUALITY_RUN_ID'], os.environ['RELEASE_REPOSITORY'])
        args += ['--repository', os.environ['RELEASE_REPOSITORY'], '--ci-run-id', os.environ['QUALITY_RUN_ID'],
                 '--api-fault-restore-approved']
        descriptor = {name: value for name, value in transport.items()
                      if name not in ('invocationRawBase64', 'serverReceipt')}
        f_raw = base64.b64decode(transport['invocationRawBase64'], validate=True)
        packed_f = base64.b64encode(gzip.compress(f_raw, mtime=0)).decode()
        packed_proof = base64.b64encode(gzip.compress(proof_raw, mtime=0)).decode()
        # Carry the exact authenticated native bytes once. The remote bounded
        # adapter derives the complete F from those bytes and revalidates it;
        # no serverReceipt is substituted or silently truncated.
        preparation = (inspect.getsource(preflight_from_native)
            + '\nimport json\nfrom types import SimpleNamespace\n'
            + 'runtime=SimpleNamespace(**runpy.run_path(' + repr(directory + '/online-recharge-component-runtime.py') + '))\n'
            + 'runtime.authority()\ncore=runtime.c.load_core(runtime.authority()["coreSha256"])\n'
            + 'native=runtime.bounded_gzip(base64.b64decode(' + repr(packed_f) + ',validate=True),128*1024)\n'
            + 'transport=preflight_from_native(core,runtime,' + repr(descriptor) + ',native)\n'
            + 'preflight_arg="gzip-base64:"+base64.b64encode(gzip.compress('
                '(json.dumps(transport,sort_keys=True,separators=(",",":"),allow_nan=False)+"\\n").encode(),mtime=0)).decode()\n')
        payload = ' + ["--build-proof",' + repr('gzip-base64:' + packed_proof) + ',"--preflight",preflight_arg]'
    program = (inspect.getsource(ordinary._store_files) + '\n_store_files(' + repr(directory) + ','
        + repr(p['commit']) + ',' + repr(pins) + ',False)\n'
        + 'import os,stat,base64,gzip\nfrom pathlib import Path\n'
        + inspect.getsource(ordinary.write_workspace_private_bytes)
        + '\nwrite_workspace_private_bytes(' + repr(native_path) + ',' + repr(native) + ')\n'
        + 'import sys,runpy\n' + preparation + 'sys.argv=[' + repr(directory + '/online-recharge-component-runtime.py') + ']+ '
        + repr(args) + payload + '\nrunpy.run_path(sys.argv[0],run_name="__main__")\n')
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
               + repr(packed) + ',validate=True)),"<online-component-transport>","exec"))')
    result = {'commands': ['python3 -B -c ' + shlex.quote(carrier)],
              'executionTimeout': ['1800' if mode == 'release' else '600']}
    r.need(len(json.dumps(result).encode()) < 20 * 1024, 'TRANSPORT_PARAMETERS_TOO_LARGE')
    return result


def safe_failure(error):
    code = str(error)
    if not re.fullmatch(r'ONLINE_RECHARGE_COMPONENT_[A-Z0-9_]{1,96}', code):
        code = 'ONLINE_RECHARGE_COMPONENT_REMOTE_EVIDENCE_UNAVAILABLE'
    return {'status': 'ONLINE_RECHARGE_COMPONENT_FAILED', 'code': code}


def validate_native(core, raw, mode, p, command_id, instance_id):
    _native, receipt = r.validate_component_invocation(core, raw, command_id, instance_id)
    r.need(len(_native.get('StandardOutputContent', '').encode()) < 23000, 'WIRE_TOO_LARGE')
    if mode == 'preflight':
        transport = {'version': 1, 'kind': r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': p,
            'expectedCurrent': os.environ['EXPECTED_CURRENT'], 'commandId': command_id,
            'instanceId': instance_id, 'invocationBytesSha256': r.c.digest(raw),
            'invocationRawBase64': base64.b64encode(raw).decode(), 'serverReceipt': receipt}
        r.validate_preflight(core, transport, p, os.environ['EXPECTED_CURRENT'])
        return transport
    r.validate_return_receipt(receipt, p)
    return {'commandId': command_id, 'instanceId': instance_id, 'status': 'Success',
            'invocationBytesSha256': r.c.digest(raw), 'receipt': receipt}


def validate_failure_native(core, raw, p, command_id, instance_id):
    native, receipt = r.validate_component_invocation(core, raw, command_id, instance_id, status='Failed')
    r.need(len(native.get('StandardOutputContent', '').encode()) < 23000, 'WIRE_TOO_LARGE')
    if receipt.get('status') == 'ONLINE_RECHARGE_COMPONENT_REJECTED':
        r.need(set(receipt) == {'version', 'scope', 'kind', 'status', 'code'}
               and type(receipt['version']) is int and receipt['version'] == 1
               and re.fullmatch('(?:ONLINE_RECHARGE_COMPONENT|ONLINE_RECHARGE|API_ADMIN|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+',
                                receipt.get('code', '')) is not None, 'FAILURE_RECEIPT_CHANGED')
    else:
        r.validate_failure_receipt(receipt, p)
    return {'commandId': command_id, 'instanceId': instance_id, 'status': 'Failed',
            'invocationBytesSha256': r.c.digest(raw), 'invocationRawBase64': base64.b64encode(raw).decode(),
            'receipt': receipt, 'automaticRetryAllowed': False,
            'restoreReadbackRequiresSeparateActualNative': True}


def failure_summary(receipt):
    return {name: receipt[name] for name in ('status', 'code', 'phase', 'recovery',
        'publication', 'onlinePublished', 'businessActions') if name in receipt}


def diagnostic(core, p, output):
    for mode in ('release', 'readback', 'preflight'):
        path = output / (r.PREFIX + '-' + mode + '-failure.json')
        if not path.exists():
            continue
        saved = core.closed_json(core.private_bytes(path, cap=256 * 1024))
        raw = base64.b64decode(saved['invocationRawBase64'], validate=True)
        r.need(saved['instanceId'] == os.environ['PRODUCTION_INSTANCE_ID'], 'FAILURE_INSTANCE_CHANGED')
        verified = validate_failure_native(core, raw, p, saved['commandId'], saved['instanceId'])
        r.need(saved == verified, 'FAILURE_EVIDENCE_CHANGED')
        return failure_summary(verified['receipt'])
    path = output / (r.PREFIX + '-failure.json')
    if not path.exists():
        return safe_failure(None)
    value = core.closed_json(core.private_bytes(path))
    r.need(value == safe_failure(RuntimeError(value.get('code', ''))), 'FAILURE_EVIDENCE_CHANGED')
    return value


def transport(mode, core, p, output):
    verify_main_head(p)
    inputs = None
    if mode == 'release':
        verify_quality(p)
        proof = core.private_bytes(Path(r.PROOF).absolute(), cap=256 * 1024)
        preflight = core.private_bytes(Path(r.PREFLIGHT).absolute(), cap=256 * 1024)
        inputs = (proof, preflight)
    params = parameters(mode, core, p, input_artifacts=inputs)
    path = output / (r.PREFIX + '-' + mode + '-parameters.json')
    write_once(core, path, params)
    intent = output / (r.PREFIX + '-' + mode + '-send-intent.json')
    r.need(not intent.exists() and not intent.is_symlink(), 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    core.write_private(intent, {'producer': p, 'mode': mode, 'expectedCurrent': os.environ['EXPECTED_CURRENT'],
        'parametersSha256': r.c.fingerprint(params), 'status': 'SUBMITTING_ONCE'})
    region, instance = os.environ['AWS_REGION'], os.environ['PRODUCTION_INSTANCE_ID']
    sent = command_raw('aws', '--region', region, 'ssm', 'send-command', '--instance-ids', instance,
        '--document-name', 'AWS-RunShellScript', '--parameters', 'file://' + str(path),
        '--timeout-seconds', params['executionTimeout'][0], '--comment', 'Online component ' + mode,
        '--query', 'Command.CommandId', '--output', 'text').decode('ascii').strip()
    r.need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', sent) is not None, 'COMMAND_ID_INVALID')
    write_once(core, output / (r.PREFIX + '-' + mode + '-invocation-metadata.json'),
        {'producer': p, 'mode': mode, 'commandId': sent, 'instanceId': instance, 'status': 'ACCEPTED'})
    deadline = time.monotonic() + (1845 if mode == 'release' else 645)
    while time.monotonic() < deadline:
        raw = command_raw('aws', '--region', region, 'ssm', 'get-command-invocation',
            '--command-id', sent, '--instance-id', instance, '--output', 'json', optional=True)
        if raw is None:
            time.sleep(5)
            continue
        native = core.closed_json(raw, 128 * 1024)
        if native.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        if native.get('Status') == 'Failed':
            failure = validate_failure_native(core, raw, p, sent, instance)
            write_once(core, output / (r.PREFIX + '-' + mode + '-failure.json'), failure)
            raise NativeFailure(failure)
        r.need(native.get('Status') == 'Success', 'REMOTE_OPERATION_FAILED')
        result = validate_native(core, raw, mode, p, sent, instance)
        destination = Path(r.PREFLIGHT).absolute() if mode == 'preflight' else output / (r.PREFIX + '-' + mode + '.json')
        write_once(core, destination, result)
        return result
    raise RuntimeError('ONLINE_RECHARGE_COMPONENT_NATIVE_TIMEOUT_NO_REPLAY')


def main(mode=None):
    mode = sys.argv[1] if mode is None and len(sys.argv) == 2 else mode
    core, p = selected(mode)
    if mode == 'selection':
        return 0
    output = output_directory()
    if mode == 'diagnostic':
        print(json.dumps(diagnostic(core, p, output), sort_keys=True))
        return 1
    if mode in ('prepare', 'build-proof', 'label'):
        preflight = read_preflight(core, p)
        if mode == 'label':
            record = core.closed_json(core.private_bytes(Path(r.PROJECTION).absolute(), cap=128 * 1024))
            r.need(record.get('candidateProducer') == p and record.get('contextPath') == r.CONTEXT,
                   'BUILD_SELECTION_CHANGED')
            print(r.c.fingerprint(record))
            return 0
        d = r.modules(None)[0]
        value = r.prepare(d, p, preflight) if mode == 'prepare' else r.build_proof(
            d, p, preflight, os.environ['QUALITY_RUN_ID'], os.environ['RELEASE_REPOSITORY'])
        print(json.dumps({'kind': r.KIND, 'mode': mode, 'producer': p}, sort_keys=True))
        return 0
    try:
        value = transport(mode, core, p, output)
        receipt = value['serverReceipt'] if mode == 'preflight' else value['receipt']
        print(json.dumps({name: receipt[name] for name in ('version', 'scope', 'kind', 'status', 'producer',
            'onlinePublished', 'migrationPerformed', 'businessActions')}, sort_keys=True))
        return 0
    except Exception as error:
        if isinstance(error, NativeFailure):
            print(json.dumps(failure_summary(error.result['receipt']), sort_keys=True))
            return 1
        failure = safe_failure(error)
        write_once(core, output / (r.PREFIX + '-failure.json'), failure)
        print(json.dumps(failure, sort_keys=True))
        return 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps(safe_failure(error), sort_keys=True))
        sys.exit(1)
