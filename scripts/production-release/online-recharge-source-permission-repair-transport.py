"""Explicit single-leaf repair transport; never a release or qualification path."""
import ast
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import types
import zlib

OPERATION = 'repair_online_source_permissions'
PREFIX = 'ONLINE_SOURCE_PERMISSION_REPAIR '
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
BASE = Path('/opt/id-business-v2')
DOCKER = '/usr/bin/docker'
SOCKET = 'unix:///run/docker.sock'
ROLES = ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'mysql', 'caddy')
SERVICE_FIELDS = frozenset(('status', 'health', 'image', 'reference', 'containerId',
                           'startedAtSha256', 'environmentSha256', 'configurationSha256'))
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
ORIGIN = {'workflowRunId': '38034912077', 'workflowRunAttempt': '1',
          'candidateCommit': 'dcc2382b7bd988730ee89932022d411e04cf4eda',
          'sourceTree': '0a85dbe72bd46e6b18558d7a3b2a682d5f4a9442',
          'commandId': '92b63d9e-56b8-4d1a-8fbf-3b1e854fb682',
          'receiptBytes': 469,
          'receiptSha256': '5da2613ae12ca2e2fc98db32d1a29e82bf7f04165735161da3abf4ae64ed7745',
          'code': 'API_ADMIN_PENDING_ONLINE_DRIVER_SOURCE_COMPOSE_PUBLIC_WRITABLE',
          'stage': 'DECLARATION_ACQUIRE'}
CORE_NAME = 'online-recharge-source-permission-repair.py'
ARTIFACT = Path('.deploy/production-release/online-source-permission-repair-result.json')
CORE_FIELDS = frozenset(('kind', 'status', 'code', 'composeSha256', 'servicesBeforeSha256',
                        'servicesAfterSha256', 'currentUnchanged', 'servicesUnchanged',
                        'sourceVerified', 'repairVerified', 'mutationAttempted',
                        'rollbackVerified', 'rawOutputSuppressed'))
CORE_CODES = frozenset(('OK', 'SCOPE_INVALID', 'ROOT_REQUIRED', 'ANCESTOR_INVALID',
                       'ANCESTOR_CHANGED', 'CURRENT_INVALID', 'CURRENT_CHANGED',
                       'SOURCE_INVALID', 'SOURCE_CHANGED', 'SOURCE_HASH_CHANGED',
                       'SNAPSHOT_INVALID', 'SERVICES_CHANGED', 'IO_FAILURE'))
CORE_STATUSES = frozenset(('CHANGED', 'NO_CHANGE', 'FAILED_BEFORE_MUTATION',
                          'FAILED_UNCHANGED', 'FAILED_ROLLED_BACK', 'FAILED_MUTATED_UNVERIFIED'))
COMPOSE_SHA = '953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c'
REMOTE_FIELDS = frozenset(('kind', 'operation', 'producer', 'origin', 'coreSha256',
                          'helperPinsSha256', 'clientCleanupVerified', 'receipt'))


def need(ok):
    if not ok:
        raise RuntimeError('ONLINE_SOURCE_PERMISSION_REPAIR_TRANSPORT_INVALID')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def closed_json(raw, limit=24000):
    need(type(raw) in (bytes, str) and 0 < len(raw if type(raw) is bytes else raw.encode()) < limit)
    def unique(items):
        value = {}
        for key, item in items:
            need(key not in value)
            value[key] = item
        return value
    def invalid(unused):
        raise ValueError('INVALID_JSON')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def producer_validate(value):
    need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    need(all(type(value[n]) is str and re.fullmatch('[a-f0-9]{40}', value[n]) for n in ('commit', 'sourceTree')))
    need(all(type(value[n]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[n])
             for n in ('workflowRunId', 'workflowRunAttempt')))
    return value


def core_validate(value):
    need(type(value) is dict and set(value) == CORE_FIELDS
         and value['kind'] == 'ONLINE_SOURCE_PERMISSION_REPAIR_V1'
         and value['status'] in CORE_STATUSES and value['code'] in CORE_CODES
         and value['composeSha256'] == COMPOSE_SHA)
    need(all(type(value[n]) is bool for n in CORE_FIELDS - {'kind', 'status', 'code', 'composeSha256',
                                                           'servicesBeforeSha256', 'servicesAfterSha256'}))
    need(value['rawOutputSuppressed'] is True)
    need(all(type(value[n]) is str and (value[n] == 'NOT_MEASURED' or HEX.fullmatch(value[n]))
             for n in ('servicesBeforeSha256', 'servicesAfterSha256')))
    successful = value['status'] in ('CHANGED', 'NO_CHANGE')
    need((value['code'] == 'OK') == successful and value['repairVerified'] == successful)
    if successful:
        need(value['sourceVerified'] and value['currentUnchanged'] and value['servicesUnchanged']
             and HEX.fullmatch(value['servicesBeforeSha256'])
             and value['servicesBeforeSha256'] == value['servicesAfterSha256']
             and value['mutationAttempted'] == (value['status'] == 'CHANGED')
             and value['rollbackVerified'] is False)
    return value


def literal_module(raw, name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def read_fixed(path, expected):
    need(HEX.fullmatch(expected) and path.is_absolute())
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent); parent = nxt
            info = os.fstat(parent)
            need(info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) in (0o600, 0o644) and 0 < before.st_size <= 2 * 1024**2)
        raw = b''
        while len(raw) <= 2 * 1024**2:
            block = os.read(fd, min(65536, 2 * 1024**2 + 1 - len(raw)))
            if not block:
                break
            raw += block
        after = os.fstat(fd); visible = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        identity = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
                                 item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        need(identity(before) == identity(after) == identity(visible)
             and len(raw) == before.st_size and sha(raw) == expected)
        return raw
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


class NativeSnapshotDriver:
    """Private assembly of unchanged snapshot helpers with read-only native CID discovery."""
    BASE = BASE
    ALL_SERVICES = ROLES

    def __init__(self, directory, client, online, workspace, remote):
        need(directory.parent == BASE / 'releases'
             and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + BASELINE[:12], directory.name))
        self.directory = directory
        self.client = client
        self.online, self.workspace, self.remote = online, workspace, remote
        self.project = None
        self.ids = {}
        # These functions close over only this private module namespace.
        remote.run = self.run
        remote.compose = self.compose

    @staticmethod
    def require(ok, unused):
        need(ok)

    def api_admin_scope(self, scope):
        need(scope == 'API_ADMIN_WORKSPACE')
        return self.workspace, self.remote

    def native(self, *args, timeout=30):
        need(type(timeout) is int and 0 < timeout <= 60)
        result = subprocess.run([DOCKER, '--host', SOCKET, '--config', str(self.client), *args],
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                                capture_output=True, timeout=timeout)
        need(result.returncode == 0 and type(result.stdout) is bytes and len(result.stdout) < 2 * 1024**2)
        return result.stdout.decode().strip()

    def inspect_one(self, cid):
        need(type(cid) is str and HEX.fullmatch(cid))
        rows = closed_json(self.native('inspect', cid), 2 * 1024**2)
        need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict and rows[0].get('Id') == cid)
        return rows[0]

    def discover(self):
        text = self.native('container', 'ls', '--no-trunc', '--format', '{{.ID}}',
                           '--filter', 'label=com.docker.compose.project',
                           '--filter', 'label=com.docker.compose.project.working_dir=' + str(self.directory))
        ids = text.splitlines() if text else []
        need(len(ids) <= 128 and len(set(ids)) == len(ids) and all(HEX.fullmatch(cid) for cid in ids))
        groups = {}
        for cid in ids:
            row = self.inspect_one(cid)
            labels = row.get('Config', {}).get('Labels')
            need(type(labels) is dict)
            project = labels.get('com.docker.compose.project')
            role = labels.get('com.docker.compose.service')
            if (labels.get('com.docker.compose.project.working_dir') == str(self.directory)
                    and labels.get('com.docker.compose.project.config_files') == ','.join(
                        str(self.directory / name) for name in ('docker-compose.aws-mysql.yml', 'compose.release.json'))):
                need(type(project) is str and re.fullmatch('[a-z0-9][a-z0-9_-]{0,127}', project)
                     and type(role) is str and role in ROLES)
                group = groups.setdefault(project, {})
                need(role not in group)
                group[role] = cid
        need(len(groups) == 1)
        project, found = next(iter(groups.items()))
        need(set(found) == set(ROLES))
        # Include mismatched-source and extra service containers in this project's rejection.
        same = self.native('container', 'ls', '--no-trunc', '--format', '{{.ID}}',
                           '--filter', 'label=com.docker.compose.project=' + project)
        need(set(same.splitlines()) == set(found.values()) and len(same.splitlines()) == 7)
        if self.project is not None:
            need(project == self.project and found == self.ids)
        self.project, self.ids = project, found

    def production_services(self, directory):
        need(Path(directory) == self.directory)
        return ROLES

    def compose(self, directory, *args, **kwargs):
        need(Path(directory) == self.directory and len(args) == 3 and args[:2] == ('ps', '-q')
             and args[2] in ROLES and not kwargs)
        return self.ids[args[2]]

    def run(self, *args, env=None, timeout=300, input_data=None):
        need(env is None and input_data is None)
        allowed = (len(args) == 3 and args[:2] == ('docker', 'inspect')
                   or len(args) == 4 and args[:3] == ('docker', 'image', 'inspect'))
        need(allowed and type(args[-1]) is str and HEX.fullmatch(args[-1]))
        return self.native(*args[1:], timeout=min(timeout, 30))

    def service_state(self, directory, role, *, include_container_id=False, include_environment_hash=False):
        need(Path(directory) == self.directory and role in ROLES
             and include_container_id is True and include_environment_hash is True)
        return self.remote.service_state(directory, role, include_container_id=True, include_environment_hash=True)

    def snapshot(self, directory):
        need(Path(directory) == self.directory)
        self.discover()
        value = self.online.snapshot(self, directory)
        need(type(value) is dict and set(value) == set(ROLES)
             and all(type(row) is dict and set(row) == SERVICE_FIELDS for row in value.values()))
        # Original helpers validate all 8 fields and digest Config.Env/Config/HostConfig/Mounts.
        return sha(canonical(value))


def remote_execute(producer, pins, core_raw, core_sha, directory):
    producer_validate(producer)
    need(os.getuid() == 0 and os.geteuid() == 0 and sha(core_raw) == core_sha)
    need(directory == BASE / '.staging' / ('api-workspace-verify-' + producer['commit']))
    raw = {name: read_fixed(directory / name, pins[name]) for name in
           ('online-recharge-scope.py', 'api-admin-scope.py', 'remote-deploy.py')}
    online = literal_module(raw['online-recharge-scope.py'], 'repair_online_snapshot', directory / 'online-recharge-scope.py')
    workspace = literal_module(raw['api-admin-scope.py'], 'repair_workspace_snapshot', directory / 'api-admin-scope.py')
    remote = literal_module(raw['remote-deploy.py'], 'repair_remote_snapshot', directory / 'remote-deploy.py')
    core = literal_module(core_raw, 'fixed_permission_repair', directory / CORE_NAME)
    with tempfile.TemporaryDirectory(prefix='permission-repair-client-', dir=directory) as temporary:
        client = Path(temporary); client.chmod(0o700)
        config = client / 'config.json'
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            need(os.write(fd, b'{}\n') == 3)
        finally:
            os.close(fd)
        drivers = []
        def snapshot_read(current):
            if not drivers:
                drivers.append(NativeSnapshotDriver(current, client, online, workspace, remote))
            return drivers[0].snapshot(current)
        receipt = core_validate(core.repair(snapshot_read))
    return {'kind': 'ONLINE_SOURCE_PERMISSION_REPAIR_EXECUTION_V1', 'operation': OPERATION,
            'producer': producer, 'origin': ORIGIN, 'coreSha256': core_sha,
            'helperPinsSha256': sha(canonical(pins)), 'clientCleanupVerified': True, 'receipt': receipt}


def readonly_helper():
    path = Path(__file__).with_name('api-admin-readonly.py')
    return literal_module(path.read_bytes(), 'permission_repair_readonly_transport', path)


def parameters(producer):
    producer_validate(producer)
    helper = readonly_helper()
    directory = BASE / '.staging' / ('api-workspace-verify-' + producer['commit'])
    source = Path(__file__).parent
    pins = {name: sha((source / name).read_bytes()) for name in helper.FORMAL_RUNTIME_CONTROLLERS}
    core_raw = (source / CORE_NAME).read_bytes(); core_sha = sha(core_raw)
    need(0 < len(core_raw) <= 1024**2)
    names = ('OPERATION', 'PREFIX', 'BASELINE', 'DOCKER', 'SOCKET', 'ROLES', 'SERVICE_FIELDS',
             'ORIGIN', 'CORE_NAME', 'CORE_FIELDS', 'CORE_CODES', 'CORE_STATUSES', 'COMPOSE_SHA', 'REMOTE_FIELDS')
    body = 'import base64,hashlib,json,os,re,stat,subprocess,tempfile,types\nfrom pathlib import Path\n'
    body += "BASE=Path('/opt/id-business-v2')\nHEX=re.compile(r'[a-f0-9]{64}\\Z')\n"
    for name in names:
        value = globals()[name]
        body += name + '=' + ("frozenset(" + repr(tuple(sorted(value))) + ")" if type(value) is frozenset else repr(value)) + '\n'
    support = ('need', 'sha', 'canonical', 'closed_json', 'producer_validate', 'core_validate',
               'literal_module', 'read_fixed', 'NativeSnapshotDriver', 'remote_execute')
    source_text = Path(__file__).read_text()
    lines = source_text.splitlines(keepends=True)
    nodes = {node.name: node for node in ast.parse(source_text).body
             if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in support}
    need(set(nodes) == set(support))
    for name in support:
        node = nodes[name]
        need(not node.decorator_list)
        body += ''.join(lines[node.lineno - 1:node.end_lineno]) + '\n'
    body += 'core_raw=base64.b85decode(' + repr(base64.b85encode(core_raw).decode()) + ')\n'
    body += 'value=remote_execute(' + repr(producer) + ',' + repr(pins) + ',core_raw,' + repr(core_sha) + ',Path(' + repr(str(directory)) + '))\n'
    body += "print(PREFIX+json.dumps(value,sort_keys=True,separators=(',',':')))\nraise SystemExit(0 if value['receipt']['status'] in ('CHANGED','NO_CHANGE') else 1)\n"
    captured = body.encode(); need(0 < len(captured) <= 65536)
    encoded = base64.b85encode(gzip.compress(captured, mtime=0)).decode()
    bootstrap = ("import base64,hashlib,zlib;d=zlib.decompressobj(31);r=d.decompress(base64.b85decode("
                 + repr(encoded) + "),65537);assert 0<len(r)<=65536 and d.eof and not d.unused_data and not d.unconsumed_tail;"
                 + "assert hashlib.sha256(r).hexdigest()==" + repr(sha(captured)) + ";exec(compile(r,'<fixed-permission-repair>','exec'))")
    commands = ['set -eu', 'umask 077; mkdir -p ' + shlex.quote(str(directory))]
    commands += helper.formal_runtime_commands(str(directory), producer['commit'], source / 'formal-runtime-package', source)
    commands.append('python3 -B -c ' + shlex.quote(bootstrap))
    value = {'commands': commands, 'executionTimeout': ['300']}
    need(len(canonical(value)) < 20480)
    return value, {'producer': producer, 'coreSha256': core_sha, 'helperPinsSha256': sha(canonical(pins))}


def validate_remote(value, binding):
    need(type(value) is dict and set(value) == REMOTE_FIELDS
         and value['kind'] == 'ONLINE_SOURCE_PERMISSION_REPAIR_EXECUTION_V1'
         and value['operation'] == OPERATION and value['origin'] == ORIGIN
         and value['producer'] == binding['producer'] and value['coreSha256'] == binding['coreSha256']
         and value['helperPinsSha256'] == binding['helperPinsSha256']
         and value['clientCleanupVerified'] is True)
    core_validate(value['receipt'])
    return value


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


def aws(*args):
    result = subprocess.run(args, capture_output=True, timeout=60)
    need(result.returncode == 0 and type(result.stdout) is bytes and len(result.stdout) < 128 * 1024)
    return result.stdout


def terminal(invocation, command_id, binding, instance):
    need(type(invocation) is dict and invocation.get('CommandId') == command_id
         and invocation.get('InstanceId') == instance and invocation.get('DocumentName') == 'AWS-RunShellScript'
         and invocation.get('PluginName') == 'aws:runShellScript'
         and invocation.get('Status') in ('Success', 'Failed') and type(invocation.get('ResponseCode')) is int
         and type(invocation.get('ExecutionEndDateTime')) is str
         and 0 < len(invocation['ExecutionEndDateTime']) <= 80)
    output = invocation.get('StandardOutputContent')
    need(type(output) is str and output.startswith(PREFIX) and len(output.encode()) < 24000)
    value = validate_remote(closed_json(output[len(PREFIX):]), binding)
    successful = value['receipt']['status'] in ('CHANGED', 'NO_CHANGE')
    need((invocation['Status'] == 'Success') == successful
         and invocation['ResponseCode'] == (0 if successful else 1))
    if successful:
        need(invocation.get('StandardErrorContent') == '')
    return value


def main():
    need(len(sys.argv) == 1)
    producer = selection(os.environ)
    data, binding = parameters(producer)
    command_id = None
    value = None
    try:
        prefix = ('aws', '--region', os.environ['AWS_REGION'], 'ssm')
        command_id = aws(*prefix, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
                         '--document-name', 'AWS-RunShellScript', '--parameters', canonical(data).decode(),
                         '--timeout-seconds', '300', '--comment', 'ID explicit online source permission repair',
                         '--query', 'Command.CommandId', '--output', 'text').decode().strip()
        need(UUID.fullmatch(command_id))
        for unused in range(36):
            time.sleep(10)
            invocation = closed_json(aws(*prefix, 'get-command-invocation', '--command-id', command_id,
                                        '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json'), 128 * 1024)
            need(type(invocation) is dict and invocation.get('CommandId') == command_id
                 and invocation.get('InstanceId') == os.environ['PRODUCTION_INSTANCE_ID'])
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                continue
            value = terminal(invocation, command_id, binding, os.environ['PRODUCTION_INSTANCE_ID'])
            break
        need(value is not None)
    except Exception:
        # Neither terminal stderr/stdout nor raw invocation is persisted or printed.
        value = None
    record = {'kind': 'ONLINE_SOURCE_PERMISSION_REPAIR_ARTIFACT_V1', 'operation': OPERATION,
              'producer': producer, 'origin': ORIGIN, 'commandId': command_id if command_id and UUID.fullmatch(command_id) else None,
              'status': 'REPAIR_OPERATION_COMPLETED' if value and value['receipt']['status'] in ('CHANGED', 'NO_CHANGE') else 'REPAIR_OPERATION_FAILED',
              'code': value['receipt']['code'] if value else 'TRANSPORT_UNAVAILABLE', 'result': value}
    readonly_helper().write_workspace_private_bytes(ARTIFACT, canonical(record) + b'\n')
    print(json.dumps(record, sort_keys=True, separators=(',', ':')))
    return 0 if record['status'] == 'REPAIR_OPERATION_COMPLETED' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('{"status":"REPAIR_OPERATION_FAILED","code":"INPUT_OR_ARTIFACT_INVALID"}')
        raise SystemExit(1) from None
