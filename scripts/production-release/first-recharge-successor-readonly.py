"""Separate bounded transport for the frozen first-recharge repair.

Original ended API43 and Admin568 getters are authenticated, then installed
through the existing descriptor writer. Historical release paths are read only.
"""
import base64
import gzip
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import sys

HERE = Path(__file__).parent


def load(name, filename):
    import importlib.util
    path = HERE / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


core = load('first_recharge_transport_core', 'first-recharge-successor.py')
reused = load('first_recharge_transport_custody', 'unpublished-component-successor-readonly.py')


def selected(mode):
    core.need(mode in ('preflight', 'release', 'readback'), 'SELECTION_INVALID')
    core.need(os.environ.get('AWS_REGION') == reused.REGION
        and os.environ.get('PRODUCTION_INSTANCE_ID') == reused.INSTANCE
        and os.environ.get('RELEASE_OPERATION') in ('verify_first_recharge', 'release_first_recharge')
        and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
        and not any(os.environ.get(name) for name in (
            'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
            'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID', 'POST_CLEANUP_SEAL_SHA256',
            'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256',
            'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID')), 'SELECTION_INVALID')
    core.need(os.environ.get('EXPECTED_CURRENT') == core.projection.ADMIN_COMMIT, 'PREDECESSOR_CHANGED')
    flag = os.environ.get('API_FAULT_RESTORE_APPROVED', 'false')
    core.need(flag in ('true', 'false') and (mode != 'release' or flag == 'true'),
        'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    core.need(mode == 'preflight' or os.environ['RELEASE_OPERATION'] == 'release_first_recharge', 'SELECTION_INVALID')
    producer = core.producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'],
        os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    return core, producer


def validate_native_origin(raw, role):
    core.need(role in ('api', 'admin'), 'ORIGIN_ROLE_INVALID')
    authority = core.history.sealed_authority() if role == 'api' else core.history.admin_successor_authority()
    core.need(type(raw) is bytes and 0 < len(raw) < 128 * 1024
        and core.digest(raw) == authority['invocationBytesSha256'], 'NATIVE_ORIGIN_BYTES_CHANGED')
    _invocation, receipt = core.validate_invocation(raw, authority['commandId'], authority['instanceId'])
    core.need(core.fingerprint(receipt) == authority['receiptSha256']
        and receipt.get('commit') == authority['producer']['commit']
        and receipt.get('status') == ('UNPUBLISHED_COMPONENT_VERIFIED' if role == 'api' else 'ADMIN_ONLY_READBACK_VERIFIED')
        and receipt.get('onlinePublished') is False, 'NATIVE_ORIGIN_RECEIPT_CHANGED')
    return raw


def native_origins():
    result = {}
    for role, authority in (('api', core.history.sealed_authority()), ('admin', core.history.admin_successor_authority())):
        raw = reused.command_raw('aws', '--region', reused.REGION, 'ssm', 'get-command-invocation',
            '--command-id', authority['commandId'], '--instance-id', reused.INSTANCE, '--output', 'json')
        result[role] = validate_native_origin(raw, role)
    return result


def parameters(mode, environment=None, *, input_artifacts=None):
    _core, producer = selected(mode)
    directory = '/opt/id-business-v2/.staging/oidc-' + producer['commit']
    original = reused.load('api-admin-readonly.py')
    pins = {name: core.digest((HERE / name).read_bytes()) for name in core.HELPERS}
    args = [mode, '--commit', producer['commit']]
    payload_args, input_program = '', ''
    if mode in ('preflight', 'release'):
        args += ['--source-tree', producer['sourceTree'], '--expected-current', core.projection.ADMIN_COMMIT,
                 '--run-id', producer['workflowRunId'], '--run-attempt', producer['workflowRunAttempt']]
    if mode == 'release':
        core.need(input_artifacts is None or type(input_artifacts) is tuple and len(input_artifacts) == 2,
            'INPUT_ARTIFACTS_INVALID')
        proof_raw = core.private_bytes(Path(core.PROOF).resolve(), cap=128 * 1024) if input_artifacts is None else input_artifacts[0]
        transport_raw = core.private_bytes(Path(core.PREFLIGHT).resolve(), cap=24576) if input_artifacts is None else input_artifacts[1]
        proof, transport = core.closed_json(proof_raw, 128 * 1024), core.closed_json(transport_raw, 24576)
        core.local_preflight(transport, producer)
        # Reconstruct the finite source proof on the runner; never admit a
        # self-hashed projection or an image from a different source/run.
        record = core.projection.validate_record(proof.get('projection'))
        core.need(record['candidateCommit'] == producer['commit'] and record['candidateTree'] == producer['sourceTree'],
            'BUILD_PROOF_CHANGED')
        core.validate_build(proof, producer, record, transport, os.environ['QUALITY_RUN_ID'], os.environ['RELEASE_REPOSITORY'])
        args += ['--repository', os.environ['RELEASE_REPOSITORY'], '--ci-run-id', os.environ['QUALITY_RUN_ID'],
                 '--api-fault-restore-approved']
        plan, _chunks = reused.input_bundle(producer, proof_raw, transport_raw)
        input_program = inspect.getsource(reused.read_input_bundle) + '\n_proof_raw,_transport_raw=read_input_bundle(' + repr(plan) + ')\n'
        payload_args = (' + ["--build-proof",base64.b64encode(_proof_raw).decode(),'
                        '"--preflight",base64.b64encode(_transport_raw).decode()]')
    else:
        core.need(input_artifacts is None, 'INPUT_ARTIFACTS_INVALID')
    origins = native_origins()
    origin_program = ''
    for role, raw in origins.items():
        authority = core.history.sealed_authority() if role == 'api' else core.history.admin_successor_authority()
        path = '/opt/id-business-v2/.staging/first-recharge-' + role + '-origin-' + authority['invocationBytesSha256'] + '/invocation.json'
        origin_program += '\nwrite_workspace_private_bytes(' + repr(path) + ',' + repr(raw) + ')\n'
    program = (inspect.getsource(original._store_files) + '\n_store_files(' + repr(directory) + ','
        + repr(producer['commit']) + ',' + repr(pins) + ',False)\n'
        + 'import os,stat,base64\nfrom pathlib import Path\n'
        + inspect.getsource(original.write_workspace_private_bytes) + origin_program + input_program
        + 'import sys,runpy\nsys.argv=[' + repr(directory + '/first-recharge-successor.py') + ']+'
        + repr(args) + payload_args + '\nrunpy.run_path(sys.argv[0],run_name="__main__")\n')
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
        + repr(packed) + ',validate=True)),"<finite-first-recharge-transport>","exec"))')
    result = {'commands': ['python3 -B -c ' + shlex.quote(carrier)],
              'executionTimeout': ['3600' if mode == 'release' else '600']}
    core.need(len(json.dumps(result).encode()) < 20 * 1024, 'TRANSPORT_PARAMETERS_TOO_LARGE')
    return result


# Accepted command reconciliation, chunk custody and duplicate-send protection
# retain their reviewed implementation in a separate module namespace.
reused.selected, reused.parameters = selected, parameters


def transport(mode):
    return reused.transport(mode)


if __name__ == '__main__':
    try:
        core.need(len(sys.argv) == 2, 'SELECTION_INVALID')
        transport(sys.argv[1])
    except Exception as error:
        code = str(error) if re.fullmatch('(?:FIRST_RECHARGE|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', str(error)) else 'FIRST_RECHARGE_TRANSPORT_UNAVAILABLE'
        print(json.dumps({'scope': core.SCOPE, 'status': 'FIRST_RECHARGE_TRANSPORT_FAILED',
                          'code': code, 'businessActions': 0}, sort_keys=True))
        raise SystemExit(1) from None
