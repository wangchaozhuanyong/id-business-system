"""Explicit fixed public repair, bound to the uniquely acquired actual diagnostic.

Pure parameters/validators support independent safe-artifact collection. The
normal GitHub OIDC/SSM workflow alone invokes main; no F/Q authority is granted.
"""
import ast
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import tempfile
import subprocess
import sys
import time
import types

OPERATION = 'repair_api_workspace_public_permissions'
BASE = Path('/opt/id-business-v2')
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
CORE_NAME = 'api-workspace-public-permission-repair.py'
SELF_NAME = 'api-workspace-public-permission-repair-transport.py'
SNAPSHOT_NAME = 'online-recharge-source-permission-repair-transport.py'
PREFIX = 'API_WORKSPACE_PUBLIC_PERMISSION_REPAIR '
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
ORIGIN = {'producer': {'commit': '9ba28849fa73d65eacdfb16cc5cefba876a057b5', 'sourceTree': '7cb42f48723927309d9bb689df734a7956701831', 'workflowRunAttempt': '1', 'workflowRunId': '38082132351'}, 'commandId': 'e040dec8-f453-4556-b96c-a740854b6441', 'stableServicesSha256': '4100d5c9098b9fee8b42bfde9e0aa3447068d3c76f715479c3eab49f2394d9b4', 'boundFilesSha256': '71a7b1b6e819ddd10cbeeb37d5d5fe936055e5c6ab4819b36f0df0ccfacf502f', 'receiptBytes': 11227, 'receiptSha256': 'df724e4abb21072afb6308359ea838a0de15adabd40f38e6e9c03f16bc2850c5'}
AUTHORIZED_TARGETS = ('DEPLOY', 'CADDY_PARENT', 'APPS', 'API_PARENT', 'PRISMA_PARENT', 'CADDY_CONFIG', 'MYSQL_SCHEMA')
DIAGNOSTIC_FACTS = {'kind': 'API_WORKSPACE_READER_FACTS_DIAGNOSTIC', 'version': 1, 'status': 'OBSERVED', 'authority': False, 'productionEligible': False, 'rawOutputSuppressed': True, 'rows': [{'role': 'SOURCE_CHAIN', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'BASE', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'RELEASES', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'SOURCE', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'DEPLOY', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'CADDY_PARENT', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'APPS', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'API_PARENT', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'PRISMA_PARENT', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'COMPOSE', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'CADDY_CONFIG', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'MYSQL_SCHEMA', 'phase': 'ATTRIBUTES', 'status': 'REJECTED', 'predicates': ['WRITABLE']}, {'role': 'COMPOSE_RELEASE', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'SOURCE_ENV', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'RELEASE_MANIFEST', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'WORKSPACE_BUILD_PROOF', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'WORKSPACE_PRESERVATION', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'BACKUP_VERIFICATION', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'BEFORE_AUDIT', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}, {'role': 'AFTER_AUDIT', 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}]}
ARTIFACT = '.deploy/production-release/api-workspace-public-permission-repair-result.json'
CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
    'online-recharge-recovery.json', 'api-admin-pending-projection.py', 'api-admin-readonly.py',
    'api-admin-pending-receipt-wire.py', 'online-recharge-declaration-measurement.py',
    'online-recharge-daemon-identity.py', 'online-recharge-daemon-listener.py', 'online-recharge-daemon-socket.py')
PACKAGE_FILES = ('driver.py', 'manifest.json', 'package_io.py', 'pure.py', 'collector.py', 'constructor.py',
                 'reader.py', 'qualified.py', 'contract.json', 'reviewed-source-table.json')
BINDING_FIELDS = {'producer', 'origin', 'authorizedTargets', 'readerFacts', 'controllerPins',
                  'packagePins', 'extraPins', 'source21Sha256'}
EXTRA_FILES = (CORE_NAME, SELF_NAME, SNAPSHOT_NAME)
SOURCE_NAMES = CONTROLLERS + tuple('formal-runtime-package/' + n for n in PACKAGE_FILES) + EXTRA_FILES
ARTIFACT_FIELDS = {'kind', 'operation', 'producer', 'origin', 'commandId', 'status', 'code', 'result'}
RESULT_FIELDS = {'kind', 'version', 'operation', 'producer', 'origin',
                 'authorizedTargets', 'source21Sha256', 'coreSha256', 'transportSha256',
                 'snapshotSha256', 'clientCleanupVerified', 'receipt', 'snapshotDiagnostic',
                 'authority', 'productionEligible', 'rawOutputSuppressed'}


class Rejected(RuntimeError): pass


def need(ok):
    if not ok: raise Rejected('PUBLIC_PERMISSION_TRANSPORT_INVALID')


def sha(raw): return hashlib.sha256(raw).hexdigest()


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def module(raw, name, path):
    value = types.ModuleType(name); value.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), value.__dict__)
    return value


def producer_validate(value):
    need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    need(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}', value[k]) for k in ('commit', 'sourceTree')))
    need(all(type(value[k]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[k]) for k in ('workflowRunId', 'workflowRunAttempt')))
    return value


def origin_validate(value):
    need(type(value) is dict and set(value) == set(ORIGIN) and value == ORIGIN)
    producer_validate(value['producer'])
    need(type(value['commandId']) is str and UUID.fullmatch(value['commandId'])
         and type(value['receiptBytes']) is int and value['receiptBytes'] == 11227
         and all(type(value[k]) is str and HEX.fullmatch(value[k]) for k in
                 ('receiptSha256', 'stableServicesSha256', 'boundFilesSha256')))
    return value


def binding_validate(binding, workspace, core):
    need(type(binding) is dict and set(binding) == BINDING_FIELDS)
    producer_validate(binding['producer'])
    origin_validate(binding['origin'])
    workspace.validate_workspace_reader_facts(binding['readerFacts'])
    need(type(binding['authorizedTargets']) is list and binding['authorizedTargets'] == list(AUTHORIZED_TARGETS)
         and binding['readerFacts'] == DIAGNOSTIC_FACTS)
    core.targets_validate(tuple(binding['authorizedTargets']), binding['readerFacts'])
    for field, length in (('controllerPins', 11), ('packagePins', 10), ('extraPins', 3)):
        values = binding[field]
        need(type(values) is dict and len(values) == length and all(type(k) is str and type(v) is str and HEX.fullmatch(v)
             for k, v in values.items()))
    need(set(binding['controllerPins']) == set(CONTROLLERS) and set(binding['packagePins']) == set(PACKAGE_FILES)
         and set(binding['extraPins']) == {CORE_NAME, SELF_NAME, SNAPSHOT_NAME}
         and type(binding['source21Sha256']) is str and HEX.fullmatch(binding['source21Sha256'])
         and binding['source21Sha256'] == sha(canonical({'controllers': binding['controllerPins'], 'package': binding['packagePins']})))
    return binding


def remote_execute(binding, directory, snapshot):
    """Fixed staged source and immutable actual diagnosis only."""
    need(os.getuid() == 0 and os.geteuid() == 0 and directory == BASE / '.staging' /
         ('api-workspace-verify-' + binding['producer']['commit']))
    deadline = time.monotonic() + 240
    paths = {**{directory / k: v for k, v in binding['controllerPins'].items()},
             **{directory / 'formal-runtime-package' / k: v for k, v in binding['packagePins'].items()},
             **{directory / k: v for k, v in binding['extraPins'].items()}}
    raw = {str(path): snapshot.read_fixed(path, digest) for path, digest in paths.items()}
    core = module(raw[str(directory / CORE_NAME)], 'public_repair_core', directory / CORE_NAME)
    online = module(raw[str(directory / 'online-recharge-scope.py')], 'public_repair_online', directory / 'online-recharge-scope.py')
    workspace = module(raw[str(directory / 'api-admin-scope.py')], 'public_repair_workspace', directory / 'api-admin-scope.py')
    remote = module(raw[str(directory / 'remote-deploy.py')], 'public_repair_remote', directory / 'remote-deploy.py')
    binding_validate(binding, workspace, core)
    receipt = None; cleaned = False; diagnostic = snapshot.snapshot_state(); temporary = None
    try:
        temporary = tempfile.TemporaryDirectory(prefix='public-permission-client-', dir=directory)
        client = Path(temporary.name); client.chmod(0o700)
        fd = os.open(client / 'config.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try: need(os.write(fd, b'{}\n') == 3)
        finally: os.close(fd)
        drivers = []
        def source_check():
            core.need(time.monotonic() < deadline, 'DEADLINE_EXCEEDED')
            for path, digest in paths.items():
                core.need(snapshot.read_fixed(path, digest) == raw[str(path)], 'SOURCE_CHANGED')
        def snapshot_read(current):
            if not drivers:
                driver = snapshot.NativeSnapshotDriver(current, client, online, workspace, remote, diagnostic)
                native = driver.native
                def bounded_native(*args, timeout=30):
                    remaining = int(deadline - time.monotonic())
                    core.need(remaining > 0, 'DEADLINE_EXCEEDED')
                    return native(*args, timeout=min(timeout, 30, remaining))
                driver.native = bounded_native; drivers.append(driver)
            value = drivers[0].snapshot(current)
            core.need(value == ORIGIN['stableServicesSha256'], 'SERVICES_CHANGED')
            return value
        receipt = core.repair(snapshot_read, source_check, authorized_targets=tuple(binding['authorizedTargets']),
                              observed_reader_facts=binding['readerFacts'], deadline=deadline)
    finally:
        try:
            if temporary is not None: temporary.cleanup()
            cleaned = True
        except Exception:
            if receipt is not None:
                receipt.update(status='FAILED_MUTATED_UNVERIFIED' if receipt['mutationAttempted'] else 'FAILED_BEFORE_MUTATION',
                               code='IO_FAILURE', repairVerified=False)
    need(receipt is not None)
    result = {'kind': 'API_WORKSPACE_PUBLIC_PERMISSION_EXECUTION_V1', 'version': 1,
        'operation': OPERATION, 'producer': binding['producer'], 'origin': binding['origin'],
        'authorizedTargets': binding['authorizedTargets'], 'source21Sha256': binding['source21Sha256'],
        'coreSha256': binding['extraPins'][CORE_NAME], 'transportSha256': binding['extraPins'][SELF_NAME],
        'snapshotSha256': binding['extraPins'][SNAPSHOT_NAME], 'clientCleanupVerified': cleaned,
        'receipt': receipt, 'snapshotDiagnostic': diagnostic.get(), 'authority': False,
        'productionEligible': False, 'rawOutputSuppressed': True}
    return validate_result(result, binding, workspace, core, snapshot)


def validate_result(value, binding, workspace, core, snapshot):
    binding_validate(binding, workspace, core)
    need(type(value) is dict and set(value) == RESULT_FIELDS and value['kind'] == 'API_WORKSPACE_PUBLIC_PERMISSION_EXECUTION_V1'
         and type(value['version']) is int and value['version'] == 1
         and value['operation'] == OPERATION and value['producer'] == binding['producer'] and value['origin'] == binding['origin']
         and value['authorizedTargets'] == binding['authorizedTargets'] and value['source21Sha256'] == binding['source21Sha256']
         and all(value[key] == binding['extraPins'][name] for key, name in
                 (('coreSha256', CORE_NAME), ('transportSha256', SELF_NAME), ('snapshotSha256', SNAPSHOT_NAME)))
         and type(value['clientCleanupVerified']) is bool and value['authority'] is False
         and value['productionEligible'] is False and value['rawOutputSuppressed'] is True)
    producer_validate(value['producer']); origin_validate(value['origin'])
    need(type(value['kind']) is str and type(value['operation']) is str
         and type(value['authorizedTargets']) is list and all(type(r) is str for r in value['authorizedTargets'])
         and all(type(value[k]) is str and HEX.fullmatch(value[k]) for k in
                 ('source21Sha256', 'coreSha256', 'transportSha256', 'snapshotSha256')))
    core.result_validate(value['receipt']); snapshot.snapshot_validate(value['snapshotDiagnostic'])
    need([r['role'] for r in value['receipt']['targets'] if r['status'] != 'NOT_SELECTED'] == binding['authorizedTargets'])
    if value['receipt']['status'] in ('CHANGED', 'NO_CHANGE'):
        need(value['clientCleanupVerified'] and value['snapshotDiagnostic']['status'] == 'PASSED')
    return value


def parameters(producer, *, source=None, core_path=None):
    """Pure local assembly of the fixed, already-approved actual target subset."""
    producer_validate(producer)
    source = Path(source) if source is not None else Path(__file__).parent
    core_path = Path(core_path) if core_path is not None else source / CORE_NAME
    core = module(core_path.read_bytes(), 'public_repair_parameter_core', core_path)
    origin, facts = ORIGIN, DIAGNOSTIC_FACTS
    authorized_targets = AUTHORIZED_TARGETS
    helper = module((source / 'api-admin-readonly.py').read_bytes(), 'public_repair_carrier', source / 'api-admin-readonly.py')
    extra = {CORE_NAME: sha(core_path.read_bytes()), SELF_NAME: sha((source / SELF_NAME).read_bytes()),
             SNAPSHOT_NAME: sha((source / SNAPSHOT_NAME).read_bytes())}
    controllers = {name: sha((source / name).read_bytes()) for name in helper.FORMAL_RUNTIME_CONTROLLERS}
    package = {name: sha((source / 'formal-runtime-package' / name).read_bytes()) for name in helper.FORMAL_RUNTIME_FILES}
    binding = {'producer': producer, 'origin': origin, 'authorizedTargets': list(authorized_targets), 'readerFacts': facts,
               'controllerPins': controllers, 'packagePins': package, 'extraPins': extra,
               'source21Sha256': sha(canonical({'controllers': controllers, 'package': package}))}
    workspace = module((source / 'api-admin-scope.py').read_bytes(), 'public_repair_parameters_workspace', source / 'api-admin-scope.py')
    binding_validate(binding, workspace, core)
    directory = BASE / '.staging' / ('api-workspace-verify-' + producer['commit'])
    commands = ['set -eu', 'umask 077']
    commands += helper.formal_runtime_commands(str(directory), producer['commit'], source / 'formal-runtime-package', source)
    recovery = module((source / 'online-recharge-backup-source-recovery-transport.py').read_bytes(), 'public_repair_packer',
                      source / 'online-recharge-backup-source-recovery-transport.py')
    store = inspect.getsource(helper._store_files) + '\n_store_files(' + repr(str(directory)) + ',' + repr(producer['commit']) + ',' + repr(extra) + ',False)\n'
    commands.append(recovery.packed_command(store.encode(), 16384))
    snapshot_raw = (source / SNAPSHOT_NAME).read_bytes(); lines = snapshot_raw.decode().splitlines(keepends=True)
    nodes = {n.name: n for n in ast.parse(snapshot_raw).body if isinstance(n, ast.FunctionDef)}
    body = 'import hashlib,os,re,stat,types\nfrom pathlib import Path\nHEX=re.compile(r"[a-f0-9]{64}\\Z")\n'
    for name in ('need', 'sha', 'literal_module', 'read_fixed'):
        node = nodes[name]; body += ''.join(lines[node.lineno-1:node.end_lineno]) + '\n'
    body += 'directory=Path(' + repr(str(directory)) + ')\n'
    body += 'snapshot=literal_module(read_fixed(directory/' + repr(SNAPSHOT_NAME) + ',' + repr(extra[SNAPSHOT_NAME]) + '),"public_repair_snapshot",directory/' + repr(SNAPSHOT_NAME) + ')\n'
    body += 'transport=literal_module(read_fixed(directory/' + repr(SELF_NAME) + ',' + repr(extra[SELF_NAME]) + '),"public_repair_transport",directory/' + repr(SELF_NAME) + ')\n'
    body += 'value=transport.remote_execute(' + repr(binding) + ',directory,snapshot)\nprint(' + repr(PREFIX) + '+transport.canonical(value).decode())\nraise SystemExit(0 if value["receipt"]["status"] in ("CHANGED","NO_CHANGE") else 1)\n'
    commands.append(recovery.packed_command(body.encode(), 32768))
    payload = {'commands': commands, 'executionTimeout': ['300']}
    need(len(canonical(payload)) < 20480)
    return payload, binding


def closed(raw, limit=24000):
    need(type(raw) in (bytes, str))
    if type(raw) is bytes: raw = raw.decode('utf-8', errors='strict')
    need(0 < len(raw.encode('utf-8')) < limit)
    def unique(rows):
        value = {}
        for key, item in rows:
            need(key not in value); value[key] = item
        return value
    def invalid(_value): need(False)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def validate_artifact(record, producer, binding, workspace, core, snapshot):
    producer_validate(producer)
    need(type(record) is dict and set(record) == ARTIFACT_FIELDS
         and type(record['kind']) is str and record['kind'] == 'API_WORKSPACE_PUBLIC_PERMISSION_ARTIFACT_V1'
         and type(record['operation']) is str and record['operation'] == OPERATION
         and record['producer'] == producer == binding['producer']
         and type(record['status']) is str and record['status'] in ('OPERATION_COMPLETED', 'OPERATION_FAILED')
         and type(record['code']) is str and record['code'] in core.CODES | {'TRANSPORT_UNAVAILABLE'})
    producer_validate(record['producer']); origin_validate(record['origin'])
    need(record['commandId'] is None or type(record['commandId']) is str and UUID.fullmatch(record['commandId']))
    if record['result'] is None:
        need(record['status'] == 'OPERATION_FAILED' and record['code'] == 'TRANSPORT_UNAVAILABLE')
    else:
        need(type(record['commandId']) is str and UUID.fullmatch(record['commandId']))
        value = validate_result(record['result'], binding, workspace, core, snapshot)
        success = value['receipt']['status'] in ('CHANGED', 'NO_CHANGE')
        need((record['status'] == 'OPERATION_COMPLETED') == success and record['code'] == value['receipt']['code'])
    return record


def selection(environ):
    need(environ.get('RELEASE_OPERATION') == OPERATION and environ.get('EXPECTED_CURRENT') == BASELINE
         and environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and environ.get('RELEASE_ADMIN_ONLY', 'false') == 'false'
         and environ.get('GITHUB_REF') == 'refs/heads/main')
    forbidden = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256',
        'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')
    need(not any(environ.get(name) for name in forbidden))
    return producer_validate({key: environ.get(name) for key, name in
        (('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
         ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})


def aws(*args, timeout=60):
    need(type(timeout) in (int, float) and 0 < timeout <= 60)
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    need(result.returncode == 0 and type(result.stdout) is bytes and len(result.stdout) < 128 * 1024)
    return result.stdout


def terminal(invocation, command_id, binding, instance, workspace, core, snapshot):
    need(type(invocation) is dict and invocation.get('CommandId') == command_id
         and invocation.get('InstanceId') == instance and invocation.get('DocumentName') == 'AWS-RunShellScript'
         and invocation.get('PluginName') == 'aws:runShellScript'
         and invocation.get('Status') in ('Success', 'Failed') and type(invocation.get('ResponseCode')) is int
         and type(invocation.get('ExecutionEndDateTime')) is str and 0 < len(invocation['ExecutionEndDateTime']) <= 80)
    output = invocation.get('StandardOutputContent')
    need(type(output) is str and output.startswith(PREFIX) and len(output.encode('utf-8')) < 24000)
    value = validate_result(closed(output[len(PREFIX):]), binding, workspace, core, snapshot)
    success = value['receipt']['status'] in ('CHANGED', 'NO_CHANGE')
    need((invocation['Status'] == 'Success') == success and invocation['ResponseCode'] == (0 if success else 1))
    if success: need(invocation.get('StandardErrorContent') == '')
    return value


def main():
    need(len(sys.argv) == 1)
    deadline = time.monotonic() + 390
    producer = selection(os.environ)
    payload, binding = parameters(producer)
    source = Path(__file__).parent
    core = module((source / CORE_NAME).read_bytes(), 'public_repair_result_core', source / CORE_NAME)
    workspace = module((source / 'api-admin-scope.py').read_bytes(), 'public_repair_result_workspace', source / 'api-admin-scope.py')
    snapshot = module((source / SNAPSHOT_NAME).read_bytes(), 'public_repair_result_snapshot', source / SNAPSHOT_NAME)
    command_id = None; value = None
    try:
        def bounded_aws(*args):
            remaining = deadline - time.monotonic(); need(remaining > 0)
            return aws(*args, timeout=min(60, remaining))
        prefix = ('aws', '--region', os.environ['AWS_REGION'], 'ssm')
        instance = os.environ['PRODUCTION_INSTANCE_ID']
        command_id = bounded_aws(*prefix, 'send-command', '--instance-ids', instance, '--document-name',
            'AWS-RunShellScript', '--parameters', canonical(payload).decode(), '--timeout-seconds', '300',
            '--comment', 'ID explicit diagnosed API Workspace public permission repair', '--query',
            'Command.CommandId', '--output', 'text').decode().strip()
        need(UUID.fullmatch(command_id))
        while time.monotonic() < deadline:
            time.sleep(min(10, deadline - time.monotonic()))
            invocation = closed(bounded_aws(*prefix, 'get-command-invocation', '--command-id', command_id,
                '--instance-id', instance, '--output', 'json'), 128 * 1024)
            need(type(invocation) is dict and invocation.get('CommandId') == command_id
                 and invocation.get('InstanceId') == instance)
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'): continue
            value = terminal(invocation, command_id, binding, instance, workspace, core, snapshot)
            break
        need(value is not None)
    except Exception:
        value = None
    record = {'kind': 'API_WORKSPACE_PUBLIC_PERMISSION_ARTIFACT_V1', 'operation': OPERATION,
        'producer': producer, 'origin': ORIGIN,
        'commandId': command_id if command_id and UUID.fullmatch(command_id) else None,
        'status': 'OPERATION_COMPLETED' if value and value['receipt']['status'] in ('CHANGED', 'NO_CHANGE') else 'OPERATION_FAILED',
        'code': value['receipt']['code'] if value else 'TRANSPORT_UNAVAILABLE', 'result': value}
    validate_artifact(record, producer, binding, workspace, core, snapshot)
    helper = module((source / 'api-admin-readonly.py').read_bytes(), 'public_repair_artifact_writer', source / 'api-admin-readonly.py')
    helper.write_workspace_private_bytes(ARTIFACT, canonical(record) + b'\n')
    print(json.dumps(record, sort_keys=True, separators=(',', ':')))
    return 0 if record['status'] == 'OPERATION_COMPLETED' else 1


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception:
        print('{"status":"OPERATION_FAILED","code":"INPUT_OR_ARTIFACT_INVALID"}')
        raise SystemExit(1) from None
