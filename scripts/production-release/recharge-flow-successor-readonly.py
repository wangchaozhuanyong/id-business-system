"""Independent recharge transport; reuse sealed B/H/native custody unchanged."""
import ast
import base64
import gzip
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sys

HERE = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


core = load('recharge_flow_transport_core', 'recharge-flow-successor.py')
reused = load('recharge_flow_transport_protection', 'unpublished-component-successor-readonly.py')


def selected(mode):
    core.need(mode in ('preflight', 'release', 'readback'), 'SELECTION_INVALID')
    core.need(os.environ.get('AWS_REGION') == reused.REGION
              and os.environ.get('PRODUCTION_INSTANCE_ID') == reused.INSTANCE
              and os.environ.get('RELEASE_OPERATION') in ('verify_recharge_flow', 'release_recharge_flow')
              and os.environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
              and not any(os.environ.get(name) for name in (
                  'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
                  'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID', 'POST_CLEANUP_SEAL_SHA256',
                  'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256',
                  'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID')), 'SELECTION_INVALID')
    core.need(os.environ.get('EXPECTED_CURRENT') == core.projection.ADMIN_COMMIT, 'SELECTION_INVALID')
    flag = os.environ.get('API_FAULT_RESTORE_APPROVED', 'false')
    core.need(flag in ('true', 'false') and (mode != 'release' or flag == 'true'),
              'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    core.need(mode == 'preflight' or os.environ['RELEASE_OPERATION'] == 'release_recharge_flow',
              'SELECTION_INVALID')
    producer = core.producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'],
                             os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    return core, producer


# The old transport remains callable with its original selection and constants.
# This module owns a separate loaded instance and only redirects future-producer
# selection plus the final script. Historical receipt decoding stays original.
reused.selected = selected
original_load = reused.load
reused.load = lambda filename: core if filename == 'unpublished-component-successor.py' else original_load(filename)
original_parameters = reused.parameters
historical_core = original_load('unpublished-component-successor.py')
original_restart_validation = reused.validate_restart_material


def validate_restart_material(_future_core, raw_invocation, raw_commands):
    # The native restart Q seals the historical ten helpers. New future-producer
    # helper pins are checked by the transport installer and SOURCE separately.
    return original_restart_validation(historical_core, raw_invocation, raw_commands)


reused.validate_restart_material = validate_restart_material
original_command_raw = reused.command_raw


def command_raw(*args, optional=False):
    command_id = reused.NATIVE_RESTART_AUTHORITY['commandId']
    prefix = ('aws', '--region', reused.REGION, 'ssm')
    sealed_reads = (
        (*prefix, 'get-command-invocation', '--command-id', command_id,
         '--instance-id', reused.INSTANCE, '--output', 'json'),
        (*prefix, 'list-commands', '--command-id', command_id, '--output', 'json'),
    )
    # The sealed List was rendered in +08:00. Fix only these two subprocess
    # serializers; the original validator still requires every original byte.
    if args in sealed_reads:
        args = ('env', 'TZ=Asia/Kuala_Lumpur', *args)
    return original_command_raw(*args, optional=optional)


reused.command_raw = command_raw


def parameters(mode, input_artifacts=None):
    value = original_parameters(mode, input_artifacts=input_artifacts)
    command = value['commands'][0]
    argv = shlex.split(command)
    core.need(len(argv) == 4 and argv[:3] == ['python3', '-B', '-c'], 'TRANSPORT_PARAMETERS_CHANGED')
    tree = ast.parse(argv[3])
    encodings = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode']
    core.need(len(encodings) == 1 and isinstance(encodings[0].args[0], ast.Constant)
              and type(encodings[0].args[0].value) is str, 'TRANSPORT_PARAMETERS_CHANGED')
    raw = gzip.decompress(base64.b64decode(encodings[0].args[0].value, validate=True))
    core.need(0 < len(raw) < 256 * 1024, 'TRANSPORT_PARAMETERS_CHANGED')
    program = raw.decode()
    old = '/unpublished-component-successor.py'
    core.need(program.count(old) == 1, 'TRANSPORT_PARAMETERS_CHANGED')
    program = program.replace(old, '/recharge-flow-successor.py', 1)
    packed = base64.b64encode(gzip.compress(program.encode(), mtime=0)).decode()
    carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
               + repr(packed) + ',validate=True)),"<finite-recharge-transport>","exec"))')
    result = {**value, 'commands': ['python3 -B -c ' + shlex.quote(carrier)]}
    core.need(len(json.dumps(result).encode()) < 20 * 1024, 'TRANSPORT_PARAMETERS_TOO_LARGE')
    return result


reused.parameters = parameters


def transport(mode):
    return reused.transport(mode)


if __name__ == '__main__':
    try:
        core.need(len(sys.argv) == 2, 'SELECTION_INVALID')
        transport(sys.argv[1])
    except Exception as error:
        code = str(error) if re.fullmatch('(?:RECHARGE_FLOW|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', str(error)) else 'RECHARGE_FLOW_TRANSPORT_UNAVAILABLE'
        print(json.dumps({'scope': core.SCOPE, 'status': 'RECHARGE_FLOW_TRANSPORT_FAILED',
                          'code': code, 'businessActions': 0}, sort_keys=True))
        raise SystemExit(1) from None
