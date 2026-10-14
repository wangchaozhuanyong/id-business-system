"""Source-pinned transport for the one finite protected ONLINE recovery.

Original failed publication and recovery executor identities remain separate.
Each server command is submitted once; independent readback uses a new UUID.
This path cannot build, publish, switch services or authorize a later release.
"""
import argparse
import base64
import gzip
import inspect
import io
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
import zipfile


def load(filename):
    import importlib.util
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location('online_recovery_client_' + filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


client = load('online-recharge-component-readonly.py')
recovery = load('online-recharge-component-recovery.py')
r = client.r
PREFIX = r.PREFIX + '-protected-recovery-transport'
MODES = ('verify', 'recover', 'readback')
OPERATIONS = {'verify': 'diagnose', 'recover': 'recover', 'readback': 'readback'}
PHASES = ('selection', 'source', 'original-evidence', 'prior-result', 'parameters',
          'submit', 'poll', 'authenticate-native', 'save-result')
UUID = re.compile('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
RESULT_FIELDS = frozenset(('version', 'kind', 'mode', 'executorProducer', 'originalProducer',
    'origin', 'parametersSha256', 'commandId', 'instanceId', 'status',
    'invocationBytesSha256', 'receipt', 'releaseAuthority'))
BINDING_FIELDS = frozenset(('producer', 'mode', 'expectedCurrent', 'commandId', 'instanceId',
    'evidenceJobId', 'artifactId', 'artifactBytesSha256'))
INPUT_HASHES = {'failureRaw': 'failureNativeBytesSha256', 'preflightRaw': 'preflightBytesSha256',
                'proofRaw': 'buildProofBytesSha256'}


def need(value, code):
    recovery.need(value, 'TRANSPORT_' + code)


def selected(mode):
    need(mode in MODES and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('AWS_REGION') == 'ap-northeast-1'
         and os.environ.get('PRODUCTION_INSTANCE_ID') == recovery.ORIGIN['instanceId']
         and os.environ.get('EXPECTED_CURRENT') == r.current_predecessor()
         and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and os.environ.get('RELEASE_ADMIN_ONLY', 'false') == 'false'
         and not any(os.environ.get(name) for name in client.FORBIDDEN), 'SELECTION_INVALID')
    flag = os.environ.get('API_FAULT_RESTORE_APPROVED', 'false')
    need(flag in ('false', 'true') and (mode != 'recover' or flag == 'true'), 'APPROVAL_REQUIRED')
    p = r.producer(os.environ.get('RELEASE_COMMIT'), os.environ.get('SOURCE_TREE'),
        os.environ.get('GITHUB_RUN_ID'), os.environ.get('GITHUB_RUN_ATTEMPT'))
    need(p != recovery.FAILED_PRODUCER, 'EXECUTOR_CHANGED')
    return r.c.load_core(r.authority()['coreSha256']), p


def validate_binding(binding):
    need(type(binding) is dict and set(binding) == BINDING_FIELDS
         and binding['producer'] == recovery.FAILED_PRODUCER and binding['mode'] == 'release'
         and binding['expectedCurrent'] == r.current_predecessor()
         and binding['commandId'] == recovery.ORIGIN['failureCommandId']
         and binding['instanceId'] == recovery.ORIGIN['instanceId']
         and all(type(binding[n]) is str and re.fullmatch('[1-9][0-9]*', binding[n])
             for n in ('evidenceJobId', 'artifactId'))
         and type(binding['artifactBytesSha256']) is str
         and re.fullmatch('[a-f0-9]{64}', binding['artifactBytesSha256']), 'ORIGINAL_BINDING_CHANGED')
    return binding


def original_inputs(core):
    """Authenticate the exact old artifact and GET only its accepted command."""
    diagnostic = load('online-recharge-component-diagnostic.py')
    original = recovery.FAILED_PRODUCER
    # Retain the bytes the unchanged diagnostic has already authenticated. A
    # second download could change or expire and adds no independent authority.
    captured = {}
    download = diagnostic.artifact_bytes
    def capture(identity):
        need(type(identity) is int and identity > 0 and not captured, 'ORIGINAL_ARTIFACT_CHANGED')
        raw = download(identity)
        captured[identity] = raw
        return raw
    diagnostic.artifact_bytes = capture
    try:
        binding = validate_binding(diagnostic.original_evidence(
            original['workflowRunId'], original['workflowRunAttempt']))
    finally:
        diagnostic.artifact_bytes = download
    need(set(captured) == {int(binding['artifactId'])}, 'ORIGINAL_ARTIFACT_CHANGED')
    raw = captured[int(binding['artifactId'])]
    need(type(raw) is bytes and 0 < len(raw) < diagnostic.CAP
         and r.c.digest(raw) == binding['artifactBytesSha256'], 'ORIGINAL_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows = archive.infolist()
        need(len(rows) <= 30 and len({row.filename for row in rows}) == len(rows)
             and sum(row.file_size for row in rows) < diagnostic.CAP
             and all('/' not in row.filename and '\\' not in row.filename and not row.is_dir()
                 and row.file_size < 256 * 1024 for row in rows), 'ORIGINAL_MEMBERS_CHANGED')
        preflight = archive.read(r.PREFIX + '-preflight.json')
        proof = archive.read(r.PREFIX + '-build-proof.json')
    failure = diagnostic.read_command(['aws', '--region', 'ap-northeast-1', 'ssm',
        'get-command-invocation', '--command-id', binding['commandId'], '--instance-id',
        binding['instanceId'], '--output', 'json'])
    context = recovery.validate_inputs(failure, preflight, proof)
    return context, binding


def input_cache(core, p, output, mode):
    """Reuse inputs only after a real successful verify under this same source."""
    destination = output / (PREFIX + '-original-inputs.json')
    binding_path = output / (PREFIX + '-original-binding.json')
    if mode == 'verify':
        need(not destination.exists() and not destination.is_symlink(), 'INPUTS_ALREADY_CAPTURED')
        context, binding = original_inputs(core)
        value = {'version': 1, 'kind': r.KIND + '_PROTECTED_RECOVERY_INPUTS',
            'executorProducer': p, 'origin': recovery.ORIGIN, 'originalBinding': binding,
            'rawBase64': {name: base64.b64encode(context[name]).decode('ascii') for name in INPUT_HASHES},
            'releaseAuthority': False}
        core.write_private(destination, value)
        client.write_once(core, binding_path, binding)
        return context, binding
    value = core.closed_json(core.private_bytes(destination))
    need(type(value) is dict and set(value) == {'version', 'kind', 'executorProducer', 'origin',
        'originalBinding', 'rawBase64', 'releaseAuthority'}
         and type(value['version']) is int and value['version'] == 1
         and value['kind'] == r.KIND + '_PROTECTED_RECOVERY_INPUTS'
         and value['executorProducer'] == p and value['origin'] == recovery.ORIGIN
         and value['releaseAuthority'] is False and type(value['rawBase64']) is dict
         and set(value['rawBase64']) == set(INPUT_HASHES), 'CACHED_INPUTS_CHANGED')
    binding = validate_binding(value['originalBinding'])
    need(core.closed_json(core.private_bytes(binding_path)) == binding, 'CACHED_BINDING_CHANGED')
    raw = {name: base64.b64decode(value['rawBase64'][name], validate=True) for name in INPUT_HASHES}
    need(all(r.c.digest(raw[name]) == recovery.ORIGIN[key] for name, key in INPUT_HASHES.items()),
         'CACHED_INPUTS_CHANGED')
    context = recovery.validate_inputs(raw['failureRaw'], raw['preflightRaw'], raw['proofRaw'])
    # Re-authenticate the stored actual verify invocation, not a cached flag.
    prior_result(core, output, 'recover', p, context)
    return context, binding


def helpers(core):
    names = (*core.HELPERS, 'online-recharge-component-consumer.py',
        'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py',
        'online-recharge-component-recovery.py', 'online-recharge-component-recovery-readonly.py')
    need(len(set(names)) == len(names), 'HELPERS_CHANGED')
    return names


def pack(raw):
    need(type(raw) is bytes and 0 < len(raw) < 256 * 1024, 'INPUT_INVALID')
    return 'gzip-base64:' + base64.b64encode(gzip.compress(raw, mtime=0)).decode('ascii')


def server_arguments(mode, p, failure, descriptor, preflight_native, proof):
    """Only the staged current-source client translates fixed packed inputs."""
    need(mode in MODES and type(p) is dict
         and p == r.producer(p.get('commit'), p.get('sourceTree'),
             p.get('workflowRunId'), p.get('workflowRunAttempt'))
         and p != recovery.FAILED_PRODUCER, 'EXECUTOR_CHANGED')
    def decode(text):
        need(type(text) is str and text.startswith('gzip-base64:'), 'INPUT_ENCODING_CHANGED')
        return r.bounded_gzip(base64.b64decode(text[len('gzip-base64:'):], validate=True), 256 * 1024)
    core = r.c.load_core(r.authority()['coreSha256'])
    # Reconstruct the complete original F, including its closed serverReceipt,
    # from the actual original native bytes. validate_inputs binds the resulting
    # bytes to the original F hash before the recovery CLI sees them.
    value = client.preflight_from_native(core, r, descriptor, decode(preflight_native))
    preflight = recovery.encoded(value)
    recovery.validate_inputs(decode(failure), preflight, decode(proof))
    args = [OPERATIONS[mode], '--failure', failure, '--preflight', pack(preflight), '--build-proof', proof]
    if mode == 'recover':
        args += ['--executor-commit', p['commit'], '--executor-tree', p['sourceTree'],
                 '--executor-run-id', p['workflowRunId'], '--executor-run-attempt', p['workflowRunAttempt']]
    return args


def parameter_spec(mode, core, p, context):
    """Generate expected JSON from authenticated source without sending/writing.

    Historical recover parameters can be inspected with approval disabled. This
    function does not grant permission to submit the command it reconstructs.
    """
    need(mode in MODES and type(p) is dict
         and p == r.producer(p.get('commit'), p.get('sourceTree'),
             p.get('workflowRunId'), p.get('workflowRunAttempt'))
         and p != recovery.FAILED_PRODUCER, 'SELECTION_INVALID')
    recovery.inputs(context)
    pins = client.helper_pins(core, p, helpers(core))
    ordinary = client.load('api-admin-readonly.py')
    directory = '/opt/id-business-v2/.staging/online-protected-recovery-' + '-'.join(
        p[name] for name in ('commit', 'workflowRunId', 'workflowRunAttempt'))
    filename = 'online-recharge-component-recovery-readonly.py'
    transport = core.closed_json(context['preflightRaw'])
    descriptor = {name: value for name, value in transport.items()
                  if name not in ('invocationRawBase64', 'serverReceipt')}
    f_native = base64.b64decode(transport['invocationRawBase64'], validate=True)
    need(recovery.encoded(client.preflight_from_native(core, r, descriptor, f_native)) == context['preflightRaw'],
         'PREFLIGHT_BYTES_CHANGED')
    args = (mode, p, pack(context['failureRaw']), descriptor, pack(f_native), pack(context['proofRaw']))
    program = (inspect.getsource(ordinary._store_files) + '\n_store_files(' + repr(directory) + ','
        + repr(p['commit']) + ',' + repr(pins) + ',False)\n'
        + inspect.getsource(client.load_staged_client)
        + '\nimport sys,runpy\nclient=load_staged_client(' + repr(directory + '/' + filename)
        + ',' + repr(pins[filename]) + ')\n'
        + 'sys.argv=[' + repr(directory + '/online-recharge-component-recovery.py')
        + ']+client["server_arguments"](' + ','.join(repr(value) for value in args) + ')\n'
        + 'import os\nos.environ["API_FAULT_RESTORE_APPROVED"]='
        + repr('true' if mode == 'recover' else 'false') + '\n'
        + 'runpy.run_path(sys.argv[0],run_name="__main__")\n')
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode('ascii')
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
        + repr(packed) + ',validate=True)),"<online-protected-recovery-transport>","exec"))')
    result = {'commands': ['python3 -B -c ' + shlex.quote(carrier)], 'executionTimeout': ['600']}
    need(len(json.dumps(result).encode()) < 20 * 1024, 'PARAMETERS_TOO_LARGE')
    return result


def parameters(mode, core, p, context):
    need(mode != 'recover' or os.environ.get('API_FAULT_RESTORE_APPROVED') == 'true', 'APPROVAL_REQUIRED')
    return parameter_spec(mode, core, p, context)


def validate_native(core, raw, mode, p, command_id, context, params_sha):
    need(mode in MODES, 'SELECTION_INVALID')
    _native, receipt = r.validate_component_invocation(core, raw, command_id, recovery.ORIGIN['instanceId'])
    recovery.validate_receipt(receipt, context, OPERATIONS[mode])
    if mode != 'verify':
        need(receipt['recoveryExecutor'] == p
             and receipt['recoveryHelperSha256'] == r.c.digest(Path(recovery.__file__).read_bytes()),
             'EXECUTOR_RECEIPT_CHANGED')
    return {'version': 1, 'kind': r.KIND + '_PROTECTED_RECOVERY_TRANSPORT', 'mode': mode,
        'executorProducer': p, 'originalProducer': recovery.FAILED_PRODUCER,
        'origin': recovery.ORIGIN, 'parametersSha256': params_sha, 'commandId': command_id,
        'instanceId': recovery.ORIGIN['instanceId'], 'status': 'Success',
        'invocationBytesSha256': r.c.digest(raw), 'receipt': receipt, 'releaseAuthority': False}


def path(output, mode, suffix):
    need(mode in MODES, 'SELECTION_INVALID')
    return output / (PREFIX + '-' + mode + '-' + suffix + '.json')


def prior_result(core, output, mode, p, context):
    before = {'recover': 'verify', 'readback': 'recover'}.get(mode)
    if before is None:
        return None
    value = core.closed_json(core.private_bytes(path(output, before, 'result'), cap=256 * 1024))
    need(type(value) is dict and set(value) == RESULT_FIELDS and value['mode'] == before
         and value['executorProducer'] == p and value['originalProducer'] == recovery.FAILED_PRODUCER
         and value['origin'] == recovery.ORIGIN and value['status'] == 'Success'
         and type(value['releaseAuthority']) is bool and value['releaseAuthority'] is False
         and type(value['commandId']) is str and UUID.fullmatch(value['commandId']), 'PRIOR_RESULT_CHANGED')
    params = core.closed_json(core.private_bytes(path(output, before, 'parameters')))
    # A native receipt does not carry the transport parameter hash. Rebuild the
    # exact expected source-pinned command instead of trusting several saved
    # files which could have been changed together while remaining self-consistent.
    need(params == parameter_spec(before, core, p, context), 'PRIOR_PARAMETERS_CHANGED')
    sha = r.c.fingerprint(params)
    metadata = core.closed_json(core.private_bytes(path(output, before, 'invocation-metadata')))
    intent = core.closed_json(core.private_bytes(path(output, before, 'send-intent')))
    need(metadata == {'executorProducer': p, 'mode': before, 'commandId': value['commandId'],
        'instanceId': recovery.ORIGIN['instanceId'], 'parametersSha256': sha, 'status': 'ACCEPTED'}
         and intent == {'executorProducer': p, 'originalProducer': recovery.FAILED_PRODUCER,
            'mode': before, 'origin': recovery.ORIGIN, 'parametersSha256': sha, 'status': 'SUBMITTING_ONCE'},
         'PRIOR_METADATA_CHANGED')
    raw = core.private_bytes(path(output, before, 'native'), cap=128 * 1024)
    need(value == validate_native(core, raw, before, p, value['commandId'], context, sha),
         'PRIOR_NATIVE_CHANGED')
    return value


def transport(mode, core, p, output, context, binding, trace):
    need(mode in MODES and (mode != 'recover' or os.environ.get('API_FAULT_RESTORE_APPROVED') == 'true'),
         'APPROVAL_REQUIRED')
    trace['phase'] = 'source'
    client.verify_main_head(p)
    client.verify_quality(p)
    trace['phase'] = 'prior-result'
    previous = prior_result(core, output, mode, p, context)
    trace['phase'] = 'parameters'
    params = parameters(mode, core, p, context)
    params_sha = r.c.fingerprint(params)
    params_path = path(output, mode, 'parameters')
    client.write_once(core, params_path, params)
    client.write_once(core, output / (PREFIX + '-original-binding.json'), binding)
    intent = path(output, mode, 'send-intent')
    need(not intent.exists() and not intent.is_symlink(), 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    core.write_private(intent, {'executorProducer': p, 'originalProducer': recovery.FAILED_PRODUCER,
        'mode': mode, 'origin': recovery.ORIGIN, 'parametersSha256': params_sha, 'status': 'SUBMITTING_ONCE'})
    trace['phase'] = 'submit'
    sent = client.command_raw('aws', '--region', 'ap-northeast-1', 'ssm', 'send-command',
        '--instance-ids', recovery.ORIGIN['instanceId'], '--document-name', 'AWS-RunShellScript',
        '--parameters', 'file://' + str(params_path), '--timeout-seconds', '600',
        '--comment', 'Online protected recovery ' + mode, '--query', 'Command.CommandId',
        '--output', 'text').decode('ascii').strip()
    need(UUID.fullmatch(sent) is not None, 'COMMAND_ID_INVALID')
    trace.update(phase='poll', accepted=True, commandId=sent, instanceId=recovery.ORIGIN['instanceId'])
    client.write_once(core, path(output, mode, 'invocation-metadata'), {'executorProducer': p,
        'mode': mode, 'commandId': sent, 'instanceId': recovery.ORIGIN['instanceId'],
        'parametersSha256': params_sha, 'status': 'ACCEPTED'})
    need(sent != recovery.ORIGIN['failureCommandId'] and (previous is None
         or sent != previous['commandId']), 'INDEPENDENT_COMMAND_REQUIRED')
    deadline = time.monotonic() + 645
    while time.monotonic() < deadline:
        raw = client.command_raw('aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation',
            '--command-id', sent, '--instance-id', recovery.ORIGIN['instanceId'], '--output', 'json', optional=True)
        if raw is None:
            time.sleep(5)
            continue
        trace.update(client.native_details(raw))
        native = core.closed_json(raw, 128 * 1024)
        need(type(native) is dict and native.get('CommandId') == sent
             and native.get('InstanceId') == recovery.ORIGIN['instanceId'], 'NATIVE_IDENTITY_CHANGED')
        if native.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        trace['phase'] = 'authenticate-native'
        if native.get('Status') == 'Failed':
            failure = client.validate_failure_native(core, raw, p, sent, recovery.ORIGIN['instanceId'])
            need(failure['receipt']['status'] == 'ONLINE_RECHARGE_COMPONENT_REJECTED', 'FAILURE_SHAPE_CHANGED')
            client.write_once(core, path(output, mode, 'failure'), failure)
            raise client.NativeFailure(failure)
        need(native.get('Status') == 'Success', 'RESULT_NOT_AUTHENTICATED')
        result = validate_native(core, raw, mode, p, sent, context, params_sha)
        if mode == 'readback':
            need(result['receipt'] == previous['receipt'], 'READBACK_RECEIPT_CHANGED')
        trace['phase'] = 'save-result'
        client.load('api-admin-readonly.py').write_workspace_private_bytes(str(path(output, mode, 'native')), raw)
        client.write_once(core, path(output, mode, 'result'), result)
        return result
    raise RuntimeError('ONLINE_RECHARGE_COMPONENT_PROTECTED_RECOVERY_TRANSPORT_NATIVE_TIMEOUT_NO_REPLAY')


def failure_summary(error, mode, p, trace):
    failed = isinstance(error, client.NativeFailure)
    result = {'version': 1, 'kind': r.KIND + '_PROTECTED_RECOVERY_DIAGNOSTIC',
        'mode': mode if mode in MODES else 'verify', 'phase': trace.get('phase', 'selection'),
        'code': r.rejection_code(error), 'outcome': 'COMMAND_FAILED' if failed else
            'AUTHENTICATION_REJECTED' if trace.get('phase') == 'authenticate-native' else
            'RESULT_UNKNOWN' if trace.get('accepted') is True or trace.get('phase') == 'submit' else 'LOCAL_FAILED',
        'nativeAuthenticated': failed, 'automaticRetryAllowed': False, 'releaseAuthority': False}
    if failed:
        result['code'] = error.result['receipt']['code']
    if p is not None:
        result['executorProducer'] = p
    for name in ('commandId', 'instanceId', 'nativeStatus', 'nativeBytesSha256', 'stdoutSha256',
                 'stderrSha256', 'responseCode'):
        if name in trace:
            result[name] = trace[name]
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=MODES, nargs='?', default='verify')
    args = parser.parse_args(argv)
    core = p = output = None
    trace = {'phase': 'selection'}
    try:
        core, p = selected(args.mode)
        output = client.output_directory()
        trace['phase'] = 'original-evidence'
        context, binding = input_cache(core, p, output, args.mode)
        value = transport(args.mode, core, p, output, context, binding, trace)
        print(json.dumps({name: value[name] for name in ('mode', 'executorProducer', 'originalProducer',
            'commandId', 'instanceId', 'invocationBytesSha256', 'releaseAuthority')}
            | {'status': value['receipt']['status']}, sort_keys=True))
        return 0
    except Exception as error:
        result = failure_summary(error, args.mode, p, trace)
        if core is not None and output is not None:
            try:
                client.write_once(core, path(output, args.mode, 'diagnostic'), result)
            except Exception as artifact_error:
                result['diagnosticWriteCode'] = r.rejection_code(artifact_error)
        print(json.dumps(result, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
