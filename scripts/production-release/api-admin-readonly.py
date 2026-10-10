"""Pinned, independent SSM readback for the explicit API/Admin scope."""
import hashlib
import gzip
import inspect
import shlex
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import time


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('API_ADMIN_TRANSPORT_FAILED')
    return result.stdout.strip()


def command_raw(*args):
    """Keep AWS CLI stdout bytes unchanged for a successful invocation seal."""
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('API_ADMIN_TRANSPORT_FAILED')
    return result.stdout


def validated_workspace_invocation(raw, command_id):
    """Check transport metadata before retaining the original invocation bytes."""
    code = 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'
    try:
        if type(raw) is not bytes or not 0 < len(raw) < 128 * 1024:
            raise ValueError('size')
        def unique(items):
            row = {}
            for key, value in items:
                if key in row:
                    raise ValueError('duplicate')
                row[key] = value
            return row
        def constant(unused):
            raise ValueError('constant')
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=constant)
        if (type(value) is not dict or value.get('CommandId') != command_id
                or type(command_id) is not str
                or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id)
                or value.get('InstanceId') != os.environ['PRODUCTION_INSTANCE_ID']
                or value.get('DocumentName') != 'AWS-RunShellScript'
                or value.get('PluginName') != 'aws:runShellScript'
                or value.get('Status') != 'Success'
                or type(value.get('ResponseCode')) is not int or value['ResponseCode'] != 0
                or type(value.get('ExecutionEndDateTime')) is not str
                or not 0 < len(value['ExecutionEndDateTime']) <= 80
                or value.get('StandardErrorContent') != ''
                or type(value.get('StandardOutputContent')) is not str
                or not 0 < len(value['StandardOutputContent']) < 24000):
            raise ValueError('metadata')
        return value
    except Exception:
        raise RuntimeError(code) from None


def write_workspace_private_bytes(path, raw):
    """Write once through directory descriptors; never follow a path symlink."""
    code = 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'
    descriptor = directory = None
    try:
        if type(raw) is not bytes or not 0 < len(raw) < 128 * 1024:
            raise ValueError('size')
        path = Path(path)
        parts = path.parts[1:] if path.is_absolute() else path.parts
        if not parts or any(part in ('', '.', '..') for part in parts):
            raise ValueError('path')
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open('/' if path.is_absolute() else '.', directory_flags)
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, directory_flags, dir_fd=directory)
            try:
                row = os.fstat(child)
                if (not stat.S_ISDIR(row.st_mode) or row.st_uid not in (0, os.getuid())
                        or row.st_mode & 0o022):
                    raise ValueError('directory')
            except Exception:
                os.close(child)
                raise
            os.close(directory)
            directory = child
        flags = os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | flags,
                                 0o600, dir_fd=directory)
        except FileExistsError:
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | flags, dir_fd=directory)
            row = os.fstat(descriptor)
            if (not stat.S_ISREG(row.st_mode) or row.st_uid != os.getuid() or row.st_nlink != 1
                    or stat.S_IMODE(row.st_mode) != 0o600 or row.st_size != len(raw)):
                raise ValueError('file')
            with os.fdopen(descriptor, 'rb') as stream:
                descriptor = None
                if stream.read(128 * 1024) != raw:
                    raise ValueError('bytes')
            return
        row = os.fstat(descriptor)
        if (not stat.S_ISREG(row.st_mode) or row.st_uid != os.getuid()
                or row.st_nlink != 1 or stat.S_IMODE(row.st_mode) != 0o600):
            raise ValueError('file')
        with os.fdopen(descriptor, 'wb') as stream:
            descriptor = None
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        raise RuntimeError(code) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)


def save_workspace_artifact(producer, kind, raw):
    """Save the validated exact F/Q bytes through a separate bounded SSM command."""
    code = 'API_ADMIN_PENDING_ONLINE_ARTIFACT_SAVE_FAILED'
    try:
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-workspace-declaration-artifacts.py')))
        data = namespace['artifact_parameters'](producer, kind, raw)
        if len(json.dumps(data).encode()) >= 20 * 1024:
            raise ValueError('size')
        aws = ['aws', '--region', os.environ['AWS_REGION'], 'ssm']
        command_id = command(*aws, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
            '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(data), '--timeout-seconds', '300',
            '--comment', 'ID API_ADMIN_WORKSPACE immutable artifact', '--query', 'Command.CommandId', '--output', 'text')
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id):
            raise ValueError('command')
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            time.sleep(10)
            try:
                invocation_raw = command_raw(*aws, 'get-command-invocation', '--command-id', command_id,
                    '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json')
            except RuntimeError:
                continue
            if type(invocation_raw) is not bytes or not 0 < len(invocation_raw) < 128 * 1024:
                raise ValueError('size')
            # This provisional parse selects pending/ended only. The successful
            # invocation and ACK are validated independently before continuing.
            provisional = json.loads(invocation_raw)
            if type(provisional) is not dict:
                raise ValueError('invocation')
            if provisional.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                continue
            invocation = validated_workspace_invocation(invocation_raw, command_id)
            output = invocation['StandardOutputContent']
            if len(output.encode()) >= 4096:
                raise ValueError('ack-size')
            def unique(items):
                value = {}
                for key, item in items:
                    if key in value:
                        raise ValueError('duplicate')
                    value[key] = item
                return value
            ack = json.loads(output, object_pairs_hook=unique,
                             parse_constant=lambda unused: (_ for _ in ()).throw(ValueError('constant')))
            namespace['validate_artifact_ack'](ack, producer, kind, raw)
            return {'commandId': command_id, 'kind': kind, 'ack': ack}
        raise ValueError('timeout')
    except Exception:
        raise RuntimeError(code) from None


def selected_scope(operation):
    if operation in ('verify_api_workspace', 'release_api_workspace'):
        return 'API_ADMIN_WORKSPACE'
    if operation in ('verify_api_admin_migration', 'release_api_admin_migration'):
        return 'API_ADMIN_MIGRATION'
    if operation in ('verify_api_registration', 'handoff_api_registration', 'release_api_registration',
                     'verify_registration_business', 'verify_registration_handoff', 'recover_registration_handoff'):
        return 'API_REGISTRATION'
    return 'API_ADMIN'


FORMAL_RUNTIME_FILES = ('driver.py', 'manifest.json', 'package_io.py', 'pure.py', 'collector.py',
         'constructor.py', 'reader.py', 'qualified.py', 'contract.json',
         'reviewed-source-table.json')


FORMAL_RUNTIME_CONTROLLERS = ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
 'online-recharge-recovery.json', 'api-admin-pending-projection.py', 'api-admin-readonly.py',
 'api-admin-pending-receipt-wire.py', 'online-recharge-declaration-measurement.py',
 'online-recharge-daemon-identity.py', 'online-recharge-daemon-listener.py',
 'online-recharge-daemon-socket.py')


def _store_files(directory, commit, pins, package):
    import hashlib
    import os
    import stat
    import urllib.request
    from pathlib import Path

    def need(ok):
        if not ok:
            raise RuntimeError('FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED')

    def identity(item):
        return (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
                item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)

    def open_parent():
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        chain = []
        try:
            for index, part in enumerate(Path(directory).parts[1:]):
                try:
                    before = os.stat(part, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    need(index == len(Path(directory).parts[1:]) - 1)
                    os.mkdir(part, 0o700, dir_fd=fd)
                    before = os.stat(part, dir_fd=fd, follow_symlinks=False)
                need(stat.S_ISDIR(before.st_mode) and before.st_uid == 0
                     and not stat.S_IMODE(before.st_mode) & 0o022)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    after = os.fstat(child)
                    need(identity(before) == identity(after))
                    chain.append((after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid))
                except BaseException:
                    os.close(child)
                    raise
                os.close(fd)
                fd = child
            need(stat.S_IMODE(os.fstat(fd).st_mode) in ((0o700,) if package else (0o700, 0o755)))
            return fd, chain
        except BaseException:
            os.close(fd)
            raise

    need(os.geteuid() == 0)
    parent, chain = open_parent()
    limit = 1024 * 1024 if package else 2 * 1024 * 1024
    try:
        for name, expected in pins.items():
            url = ('https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'
                   + commit + '/scripts/production-release/'
                   + ('formal-runtime-package/' if package else '') + name)
            with urllib.request.urlopen(url, timeout=30) as response:
                raw = response.read(limit + 1)
            need(0 < len(raw) <= limit and hashlib.sha256(raw).hexdigest() == expected)
            fd = None
            try:
                try:
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                 0o600, dir_fd=parent)
                    first = os.fstat(fd)
                    need(stat.S_ISREG(first.st_mode) and first.st_uid == 0 and first.st_nlink == 1
                         and stat.S_IMODE(first.st_mode) == 0o600 and first.st_size == 0)
                    offset = 0
                    while offset < len(raw):
                        count = os.write(fd, raw[offset:])
                        need(count > 0)
                        offset += count
                    os.fsync(fd)
                except FileExistsError:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
                    first = os.fstat(fd)
                    need(stat.S_ISREG(first.st_mode) and first.st_uid == 0 and first.st_nlink == 1
                         and stat.S_IMODE(first.st_mode) in (0o600, 0o644) and first.st_size == len(raw))
                    current = b''
                    while len(current) <= limit:
                        block = os.read(fd, min(65536, limit + 1 - len(current)))
                        if not block:
                            break
                        current += block
                    need(current == raw and identity(first) == identity(os.fstat(fd)))
                final = os.fstat(fd)
                need(final.st_size == len(raw)
                     and identity(final) == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
            finally:
                if fd is not None:
                    os.close(fd)
            visible, again = open_parent()
            try:
                need(chain == again)
            finally:
                os.close(visible)
        os.fsync(parent)
    finally:
        os.close(parent)


def formal_runtime_commands(controller_directory, commit, package_directory, controller_source):
    """Fixed checked source files, bounded carrier and finite production paths."""
    if (type(commit) is not str or not re.fullmatch('[a-f0-9]{40}', commit)
            or controller_directory not in tuple('/opt/id-business-v2/.staging/' + prefix + commit
                                                 for prefix in ('api-workspace-verify-', 'oidc-'))):
        raise RuntimeError('FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED')
    package_pins = {name: hashlib.sha256((Path(package_directory) / name).read_bytes()).hexdigest() for name in FORMAL_RUNTIME_FILES}
    controller_pins = {name: hashlib.sha256((Path(controller_source) / name).read_bytes()).hexdigest() for name in FORMAL_RUNTIME_CONTROLLERS}
    program = (inspect.getsource(_store_files)
               + '\ntry:\n    _store_files(' + repr(controller_directory) + ', '
               + repr(commit) + ', ' + repr(controller_pins) + ', False)\n'
               + '    _store_files(' + repr(controller_directory + '/formal-runtime-package')
               + ', ' + repr(commit) + ', ' + repr(package_pins) + ', True)\n'
               + "except BaseException:\n    raise SystemExit('FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED') from None\n")
    raw = program.encode()
    if not 0 < len(raw) <= 16 * 1024:
        raise RuntimeError('FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED')
    payload = base64.b85encode(gzip.compress(raw, mtime=0)).decode('ascii')
    # Bound decompression, bind exact code, then execute the captured fixed code.
    bootstrap = ("import base64,hashlib,zlib;v=zlib.decompressobj(31);r=v.decompress(base64.b85decode("
                 + repr(payload) + "),16385);assert 0<len(r)<=16384 and v.eof and not v.unused_data and not v.unconsumed_tail;"
                 + "assert hashlib.sha256(r).hexdigest()==" + repr(hashlib.sha256(raw).hexdigest())
                 + ";exec(compile(r,'<fixed-release-carrier>','exec'))")
    result = ['python3 -B -c ' + shlex.quote(bootstrap)]
    if len(json.dumps(result, separators=(',', ':')).encode()) >= 12 * 1024:
        raise RuntimeError('FORMAL_RUNTIME_PACKAGE_TRANSPORT_FAILED')
    return result


def parameters(commit, expected, mode, scope='API_ADMIN', *, require_closed=True,
               declaration_producer=None):
    if (not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (commit, expected))
            or scope not in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION', 'API_ADMIN_WORKSPACE') or mode not in ('preflight', 'readback', 'handoff', 'business', 'handoff-observe', 'handoff-recover')
            or mode in ('handoff', 'business', 'handoff-observe', 'handoff-recover') and scope != 'API_REGISTRATION' or type(require_closed) is not bool):
        raise ValueError('API_ADMIN_INPUT_INVALID')
    prefix = 'api-workspace' if scope == 'API_ADMIN_WORKSPACE' else scope.lower().replace('_', '-')
    directory = f'/opt/id-business-v2/.staging/{prefix}-verify-{commit}'
    commands = ['set -eu', f'mkdir -p {directory}']
    controllers = ('remote-deploy.py', 'api-admin-scope.py')
    if scope == 'API_ADMIN_WORKSPACE':
        # A verified online publication retains its migration and engine proof.
        # Pin that reader before either workspace preflight or independent readback.
        controllers += ('online-recharge-scope.py', 'online-recharge-recovery.json',
                        'api-admin-pending-projection.py', 'api-admin-readonly.py',
                        'api-admin-pending-receipt-wire.py')
        if declaration_producer is not None:
            controllers += ('online-recharge-declaration-measurement.py',
                            'online-recharge-daemon-identity.py', 'online-recharge-daemon-listener.py',
                            'online-recharge-daemon-socket.py')
    if scope == 'API_ADMIN_WORKSPACE' and declaration_producer is not None:
        commands.extend(formal_runtime_commands(directory, commit,
            Path(__file__).with_name('formal-runtime-package'), Path(__file__).parent))
    else:
        for name in controllers:
            digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            commands.extend([f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{commit}/scripts/production-release/{name} -o {directory}/{name}',
                             f'echo "{digest}  {directory}/{name}" | sha256sum -c - >/dev/null'])
    action = 'verify' if scope == 'API_REGISTRATION' and mode == 'preflight' and not require_closed else mode
    producer_flag = ''
    if declaration_producer is not None:
        if (scope != 'API_ADMIN_WORKSPACE' or type(declaration_producer) is not dict
                or set(declaration_producer) != {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
                or declaration_producer.get('commit') != commit
                or not all(type(declaration_producer.get(k)) is str
                    and re.fullmatch(r'[a-f0-9]{40}', declaration_producer[k]) for k in ('commit', 'sourceTree'))
                or not all(type(declaration_producer.get(k)) is str
                    and re.fullmatch(r'[1-9][0-9]{0,19}', declaration_producer[k])
                    for k in ('workflowRunId', 'workflowRunAttempt'))):
            raise ValueError('API_ADMIN_INPUT_INVALID')
        payload = base64.b64encode(json.dumps(declaration_producer, separators=(',', ':')).encode()).decode('ascii')
        producer_flag = ' --declaration-producer ' + payload
    commands.append(f'python3 -B {directory}/remote-deploy.py --{prefix}-{action} --expected-current {expected}' + producer_flag)
    if len(json.dumps({'commands': commands, 'executionTimeout': ['300']}).encode()) >= 48 * 1024:
        raise ValueError('API_ADMIN_INPUT_INVALID')
    return {'commands': commands, 'executionTimeout': ['300']}


def decode_transport_receipt(output, scope):
    """Decode bounded workspace framing from the candidate's pinned helper."""
    if not isinstance(output, str) or not 0 < len(output) < 24000:
        raise RuntimeError('API_ADMIN_RECEIPT_WIRE_INVALID')
    if scope == 'API_ADMIN_WORKSPACE':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-pending-receipt-wire.py')))
        return namespace['decode_receipt_output'](output, scope=scope)
    value = json.loads(output)
    if not isinstance(value, dict):
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    return value


def declaration_producer_metadata():
    """Use the verified checkout and this workflow's actual execution identity."""
    value = {key: os.environ.get(name, '') for key, name in (
        ('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
        ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))}
    if (not all(re.fullmatch(r'[a-f0-9]{40}', value[k]) for k in ('commit', 'sourceTree'))
            or not all(re.fullmatch(r'[1-9][0-9]{0,19}', value[k])
                       for k in ('workflowRunId', 'workflowRunAttempt'))):
        raise RuntimeError('API_ADMIN_INPUT_INVALID')
    return value


def safe_failure(receipt, scope='API_ADMIN'):
    if (isinstance(receipt, dict) and receipt.get('status') == scope + '_VERIFICATION_FAILED'
            and isinstance(receipt.get('code'), str) and re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', receipt['code'])
            and isinstance(receipt.get('errorType'), str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', receipt['errorType'])):
        result = {key: receipt[key] for key in ('status', 'code', 'errorType')}
        if scope == 'API_ADMIN_WORKSPACE':
            import runpy
            namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')),
                init_globals={'SCOPE': scope})
            workspace_diagnostic = receipt.get('workspaceDiagnostic')
            if namespace['valid_workspace_diagnostic'](workspace_diagnostic):
                result['workspaceDiagnostic'] = workspace_diagnostic
        diagnostic = receipt.get('privateDiagnostic')
        if (scope == 'API_REGISTRATION' and isinstance(diagnostic, dict)
                and set(diagnostic) == {'confirmed', 'privatePostAttempted', 'failurePhase', 'privatePostHttpStatus',
                                        'controlledReason', 'rawOutputSuppressed'}
                and diagnostic['confirmed'] is False and diagnostic['rawOutputSuppressed'] is True
                and type(diagnostic['privatePostAttempted']) is bool
                and diagnostic['failurePhase'] in ('status', 'health', 'close', 'after_status', 'after_health')
                and diagnostic['controlledReason'] in ('none', 'worker_busy', 'builtin_original_window_pending',
                    'builtin_profile_missing', 'invalid_registration_payload', 'fingerprint_cleanup_failed')
                and (diagnostic['privatePostHttpStatus'] is None or type(diagnostic['privatePostHttpStatus']) is int
                     and 100 <= diagnostic['privatePostHttpStatus'] <= 599)):
            result['privateDiagnostic'] = diagnostic
        recovery = receipt.get('recoveryDiagnostic')
        if (scope == 'API_REGISTRATION' and isinstance(recovery, dict)
                and set(recovery) == {'confirmed', 'signalsAttempted', 'nativeCount', 'nativeCountObserved', 'rawOutputSuppressed'}
                and recovery['confirmed'] is False and recovery['rawOutputSuppressed'] is True
                and type(recovery['nativeCountObserved']) is bool
                and type(recovery['nativeCount']) is int and 0 <= recovery['nativeCount'] <= 128
                and (recovery['signalsAttempted'] is None or type(recovery['signalsAttempted']) is int
                     and 0 <= recovery['signalsAttempted'] <= 128)):
            result['recoveryDiagnostic'] = recovery
        return result
    return {'status': scope + '_VERIFICATION_FAILED', 'code': 'API_ADMIN_REMOTE_VERIFICATION_FAILED'}


def validate_migration_origin(namespace, context):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256',
              'migration', 'migrationState', 'task', 'guards'}
    if (not isinstance(context, dict) or set(context) != fields or type(context.get('version')) is not int
            or context['version'] != 1 or context.get('commit') != namespace['MIGRATION_SUCCESSOR_COMMIT']
            or context.get('manifestSha256') != namespace['MIGRATION_SUCCESSOR_MANIFEST_SHA']
            or context.get('buildProofSha256') != namespace['MIGRATION_SUCCESSOR_PROOF_SHA']
            or context.get('migration') != namespace['MIGRATION_IDENTITY']
            or not isinstance(context.get('release'), str)
            or not re.fullmatch(r'/opt/id-business-v2/releases/[0-9]{8}T[0-9]{6}Z-'
                                + namespace['MIGRATION_SUCCESSOR_COMMIT'][:12], context['release'])):
        raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    state, task, guards = (context.get(name) for name in ('migrationState', 'task', 'guards'))
    if (not all(isinstance(value, dict) for value in (state, task, guards))
            or set(state) != {'name', 'sha256', 'status', 'schemaVerified', 'appliedMigrationsSha256'}
            or state.get('name') != namespace['MIGRATION_NAME'] or state.get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
            or state.get('status') != 'APPLIED' or state.get('schemaVerified') is not True
            or not isinstance(state.get('appliedMigrationsSha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', state['appliedMigrationsSha256'])
            or task != namespace['MIGRATION_TASK'] or type(task.get('attempt')) is not int
            or type(task.get('auditCount')) is not int
            or any(task.get(name) is not True for name in ('registered', 'passwordCandidatePresent'))
            or any(task.get(name) is not False for name in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
            or set(guards) != {'rechargeIdle', 'registrationBusy', 'registrationLeaseActive', 'registrationWindowRetained'}
            or guards.get('rechargeIdle') is not True or guards.get('registrationWindowRetained') is not True
            or guards.get('registrationBusy') is not False or guards.get('registrationLeaseActive') is not False):
        raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    return namespace['migration_successor_marker'](context)


def validate_online_origin(namespace, context):
    fields = {'version', 'release', 'commit', 'manifestSha256', 'buildProofSha256', 'files', 'migrationState', 'binding'}
    binding_fields = {'image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256',
                      'apiContainerId', 'containerId', 'startedAtSha256'}
    if (not isinstance(context, dict) or set(context) != fields or type(context['version']) is not int
            or context['version'] != 1 or not isinstance(context['release'], str) or not Path(context['release']).is_absolute()
            or not re.fullmatch(r'[a-f0-9]{40}', context['commit'] or '')
            or any(not re.fullmatch(r'[a-f0-9]{64}', context[n] or '') for n in ('manifestSha256', 'buildProofSha256'))
            or not isinstance(context['files'], dict) or set(context['files']) != set(namespace['ONLINE_ORIGIN_FILES'])
            or any(not isinstance(n, str) or not re.fullmatch(r'[a-f0-9]{64}', n) for n in context['files'].values())
            or context['files']['release-manifest.json'] != context['manifestSha256']
            or not isinstance(context['binding'], dict) or set(context['binding']) != binding_fields):
        raise RuntimeError('API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED')
    binding = context['binding']; state = context['migrationState']
    if (not isinstance(state, dict) or set(state) != {'name', 'sha256', 'status', 'schemaVerified', 'appliedMigrationsSha256'}
            or state.get('name') != '20261009093000_online_recharge' or state.get('status') != 'APPLIED'
            or state.get('sha256') != '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95'
            or state.get('schemaVerified') is not True or not re.fullmatch(r'[a-f0-9]{64}', state.get('appliedMigrationsSha256', ''))
            or not isinstance(binding['image'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', binding['image'])
            or not isinstance(binding['reference'], str) or not re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                r'[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*-online-recharge', binding['reference'])
            or any(not isinstance(binding[n], str) or not re.fullmatch(r'[a-f0-9]{64}', binding[n]) for n in
                ('environmentSha256', 'configurationSha256', 'volumeIdentitySha256', 'apiContainerId', 'containerId', 'startedAtSha256'))):
        raise RuntimeError('API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED')
    return namespace['online_marker'](context)


def validate_online_workspace_receipt(namespace, receipt, expected, mode, *, before=None, environment=None):
    """Validate the one Workspace successor protocol without reading files or services."""
    before = before if isinstance(before, dict) else {}
    environment = environment if environment is not None else {}
    services = receipt.get('services', {})
    selected = (receipt.get('onlineRechargeOrigin') is not None
        or receipt.get('preservedOnlineRechargeOrigin') is not None
        or receipt.get('onlineNetworkRebind') is not None
        or receipt.get('servicesRebound') == ['online-recharge']
        or isinstance(services, dict) and 'online-recharge' in services
        or before.get('onlineRechargeOrigin') is not None
        or isinstance(before.get('services'), dict) and 'online-recharge' in before['services'])
    if not selected:
        return False
    code = 'API_ADMIN_ONLINE_ORIGIN_RECEIPT_CHANGED'
    source = receipt if mode == 'preflight' else before
    context = source.get('onlineRechargeOrigin')
    try:
        marker = validate_online_origin(namespace, context)
        validate_migration_origin(namespace, source.get('migrationOrigin'))
    except (KeyError, TypeError, ValueError, RuntimeError):
        raise RuntimeError(code) from None
    names = {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
             'auto-registration', 'online-recharge'}
    keys = {'image', 'reference', 'status', 'health', 'containerId', 'startedAtSha256',
            'environmentSha256', 'configurationSha256'}
    def matches(pattern, value):
        return isinstance(value, str) and re.fullmatch(pattern, value) is not None
    def complete(rows):
        return (isinstance(rows, dict) and set(rows) == names
            and all(isinstance(row, dict) and set(row) == keys and row['status'] == 'running'
                and (row['health'] in ('healthy', None) if name == 'caddy' else row['health'] == 'healthy')
                and matches(r'sha256:[a-f0-9]{64}', row['image'])
                and matches(r'[A-Za-z0-9][A-Za-z0-9:/@._-]{0,511}', row['reference'])
                and all(matches(r'[a-f0-9]{64}', row[key]) for key in
                    ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256'))
                for name, row in rows.items()))
    if (not complete(services)
            or source.get('guards') != source['migrationOrigin']['guards']
            or type(source.get('freeBytes')) is not int or source['freeBytes'] <= 6 * 1024**3
            or any(services['online-recharge'][key] != context['binding'][key] for key in
                ('image', 'reference', 'environmentSha256', 'configurationSha256'))):
        raise RuntimeError(code)
    if mode == 'preflight':
        if receipt.get('commit') != expected:
            raise RuntimeError(code)
        return True
    prior = before.get('services', {})
    if (mode != 'readback' or not complete(prior)
            or before.get('status') != 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
            or before.get('mode') != 'preflight'
            or before.get('releaseCandidateCommit') != expected
            or environment.get('RELEASE_COMMIT') != expected
            or before.get('commit') != environment.get('EXPECTED_CURRENT')
            or not matches(r'[a-f0-9]{40}', environment.get('EXPECTED_CURRENT'))
            or not matches(r'[1-9][0-9]*', environment.get('GITHUB_RUN_ID'))
            or not matches(r'[1-9][0-9]*', environment.get('GITHUB_RUN_ATTEMPT'))
            or before.get('workflowRunId') != environment['GITHUB_RUN_ID']
            or before.get('workflowRunAttempt') != environment['GITHUB_RUN_ATTEMPT']
            or receipt.get('preservedOnlineRechargeOrigin') != marker
            or receipt.get('servicesRebound') != ['online-recharge']
            or receipt.get('migrationPerformed') is not False
            or any(services[name] != prior[name] for name in
                ('mysql', 'media-resolver', 'auto-recharge', 'auto-registration'))
            or any(services[name][key] != prior[name][key]
                for name in ('online-recharge', 'caddy')
                for key in ('image', 'reference', 'environmentSha256'))
            or services['online-recharge']['configurationSha256'] != prior['online-recharge']['configurationSha256']):
        raise RuntimeError(code)
    rebind = receipt.get('onlineNetworkRebind')
    binding_keys = set(context['binding'])
    if (not isinstance(rebind, dict) or set(rebind) != {'version', 'before', 'after', 'sqlFence', 'businessActions'}
            or type(rebind['version']) is not int or rebind['version'] != 1
            or type(rebind['businessActions']) is not int or rebind['businessActions'] != 0
            or any(not isinstance(rebind[key], dict) or set(rebind[key]) != binding_keys
                for key in ('before', 'after'))
            or any(not matches(r'[a-f0-9]{64}', rebind[side][key])
                for side in ('before', 'after') for key in ('apiContainerId', 'containerId', 'startedAtSha256'))
            or any(rebind['before'][key] != rebind['after'][key]
                or rebind['after'][key] != context['binding'][key] for key in
                ('image', 'reference', 'environmentSha256', 'configurationSha256', 'volumeIdentitySha256'))
            or rebind['before']['containerId'] == rebind['after']['containerId']
            or rebind['before']['startedAtSha256'] == rebind['after']['startedAtSha256']
            or rebind['before']['apiContainerId'] != prior['api']['containerId']
            or rebind['after']['apiContainerId'] != services['api']['containerId']
            or any(rebind[side][key] != rows['online-recharge'][key]
                for side, rows in (('before', prior), ('after', services))
                for key in ('image', 'reference', 'environmentSha256', 'configurationSha256', 'containerId', 'startedAtSha256'))):
        raise RuntimeError('API_ADMIN_ONLINE_REBIND_RECEIPT_CHANGED')
    from types import SimpleNamespace
    def need(condition, failure):
        if not condition:
            raise RuntimeError(failure)
    namespace['online_fence_receipt'](SimpleNamespace(require=need), rebind['sqlFence'])
    return True


def validate_pending_ended_failures(namespace, context):
    """Independently read only the two immutable, ended failed SSM commands."""
    code = 'API_ADMIN_PENDING_ONLINE_ENDED_FAILURE_CHANGED'
    try:
        expected = namespace['pending_online_ended_failures'](context)
        def unique(items):
            row = {}
            for key, value in items:
                if key in row:
                    raise ValueError('duplicate')
                row[key] = value
            return row
        for row in expected:
            raw = command('aws', '--region', os.environ['AWS_REGION'], 'ssm', 'get-command-invocation',
                '--command-id', row['commandId'], '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'],
                '--query', '{commandId:CommandId,instanceId:InstanceId,documentName:DocumentName,status:Status,'
                           'responseCode:ResponseCode,executionEnd:ExecutionEndDateTime,output:StandardOutputContent}',
                '--output', 'json')
            if not isinstance(raw, str) or len(raw.encode()) > 128 * 1024:
                raise ValueError('size')
            invocation = json.loads(raw, object_pairs_hook=unique)
            if (not isinstance(invocation, dict) or set(invocation) != {'commandId', 'instanceId', 'documentName',
                    'status', 'responseCode', 'executionEnd', 'output'}
                    or invocation['commandId'] != row['commandId']
                    or invocation['instanceId'] != os.environ['PRODUCTION_INSTANCE_ID']
                    or invocation['documentName'] != 'AWS-RunShellScript' or invocation['status'] != 'Failed'
                    or type(invocation['responseCode']) is not int or not 0 < invocation['responseCode'] <= 255
                    or not isinstance(invocation['executionEnd'], str) or not 0 < len(invocation['executionEnd']) <= 80
                    or not isinstance(invocation['output'], str) or len(invocation['output'].encode()) > 16384):
                raise ValueError('metadata')
            receipt = json.loads(invocation['output'], object_pairs_hook=unique)
            if not isinstance(receipt, dict) or namespace['fingerprint'](receipt) != row['receiptSha256']:
                raise ValueError('receipt')
        return expected
    except Exception:
        # No raw invocation, stdout, credentials or parsing error leaves this boundary.
        raise RuntimeError(code) from None


def validate_pending_workspace_receipt(namespace, receipt, expected, mode, *, proof=None):
    before_file = Path('.deploy/production-release/api-workspace-preflight-result.json')
    before_raw = before_file.read_bytes() if mode == 'readback' and before_file.is_file() else None
    before = json.loads(before_raw) if before_raw is not None else {}
    context = receipt.get('pendingOnlineMigrationOrigin') if mode == 'preflight' else before.get('pendingOnlineMigrationOrigin')
    selected = (context is not None or receipt.get('preservedPendingOnlineMigration') is not None
                or receipt.get('pendingOnlineMigrationOrigin') is not None
                or 'declarationEquivalencePublication' in receipt
                or 'declarationEquivalenceSuccessorPublication' in receipt
                or isinstance(proof, dict) and (proof.get('pendingOnlineProjection') is not None
                    or 'pendingOnlineOriginSha256' in proof))
    if not selected:
        return False
    code = 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'
    try:
        namespace['validate_pending_online_origin'](context)
        marker = namespace['pending_online_marker'](context)
    except (ValueError, TypeError, KeyError, RuntimeError):
        raise RuntimeError(code) from None
    services = receipt.get('services', {})
    if (receipt.get('onlinePublished') is not False or receipt.get('migrationPerformed') is not False
            or receipt.get('onlineSuccessorVerified') is True or receipt.get('onlineOrigin') is not None
            or receipt.get('preservedOnlineOrigin') is not None or receipt.get('onlineEngineRebound') is True
            or not isinstance(services, dict) or set(services) != set(context['services'])):
        raise RuntimeError(code)
    if mode == 'preflight':
        predecessor = context['priorPublications'][-1]['commit'] if context['priorPublications'] else namespace['WORKSPACE_BOOTSTRAP_COMMIT']
        if predecessor != expected or services != context['services']:
            raise RuntimeError(code)
    else:
        publication_keys = ('declarationEquivalencePublication', 'declarationEquivalenceSuccessorPublication')
        try:
            if context['version'] == 2:
                prior_count = len(context['priorPublications'])
                if prior_count not in (0, 1):
                    raise RuntimeError(code)
                key = publication_keys[prior_count]
                if publication_keys[1 - prior_count] in receipt or key not in receipt:
                    raise RuntimeError(code)
                from types import SimpleNamespace
                def need(condition, reason):
                    if not condition:
                        raise RuntimeError(reason)
                validated = namespace['pending_online_declaration_summary'](
                    SimpleNamespace(require=need), receipt[key], context,
                    producer=declaration_producer_metadata(), preflight_raw=before_raw,
                    build_proof_sha256=namespace['fingerprint'](proof))
                seal_key = 'configurationEquivalenceSeal' if prior_count == 0 else 'successorConfigurationSeal'
                marker = {**marker, seal_key: validated[seal_key]}
            elif any(key in receipt for key in publication_keys):
                raise RuntimeError(code)
        except Exception:
            raise RuntimeError(code) from None
        if (before.get('status') != 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED' or before.get('mode') != 'preflight'
                or before.get('releaseCandidateCommit') != expected
                or before.get('commit') != os.environ.get('EXPECTED_CURRENT')
                or os.environ.get('RELEASE_COMMIT') != expected
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', ''))
                or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                or before.get('pendingOnlineEndedFailures') != namespace['pending_online_ended_failures'](context)
                or receipt.get('pendingOnlineMigrationOrigin') != context
                or receipt.get('preservedPendingOnlineMigration') != marker
                or receipt.get('observedServiceCount') != 7 or type(receipt.get('observedServiceCount')) is not int
                or receipt.get('servicesUpdated') != ['api', 'admin']
                or not isinstance(proof, dict) or proof.get('pendingOnlineProjection') is None
                or proof.get('pendingOnlineOriginSha256') != namespace['fingerprint'](context)
                or any(services[n] != context['services'][n] for n in services if n not in ('api', 'admin'))):
            raise RuntimeError(code)
    return True


def validate_receipt(receipt, expected, mode, scope='API_ADMIN'):
    wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                      else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
    if not isinstance(receipt, dict) or receipt.get('status') != wanted or receipt.get('commit') != expected:
        raise RuntimeError('API_ADMIN_RECEIPT_CHANGED')
    if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE') and mode == 'preflight':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        if scope == 'API_ADMIN_WORKSPACE':
            validate_pending_workspace_receipt(namespace, receipt, expected, mode)
        online_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_online_workspace_receipt(namespace, receipt, expected, mode))
        if online_workspace or expected == namespace['MIGRATION_SUCCESSOR_COMMIT'] or receipt.get('migrationOrigin') is not None:
            validate_migration_origin(namespace, receipt.get('migrationOrigin'))
            if (type(receipt.get('freeBytes')) is not int or receipt['freeBytes'] <= 6 * 1024**3
                    or receipt.get('guards') != receipt['migrationOrigin']['guards']
                    or set(receipt.get('services', {})) != {'api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'}
                        | ({'online-recharge'} if online_workspace else set())
                    or any(not isinstance(row, dict) or row.get('status') != 'running'
                           for row in receipt['services'].values())):
                raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    if scope == 'API_ADMIN_MIGRATION' and mode == 'preflight':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        guards, task, state, audit = (receipt.get(n, {}) for n in ('guards', 'task', 'migrationState', 'audit'))
        if not all(isinstance(value, dict) for value in (guards, task, state, audit)):
            raise RuntimeError('API_ADMIN_MIGRATION_PREFLIGHT_CHANGED')
        if (receipt.get('migration') != namespace['MIGRATION_IDENTITY']
                or receipt.get('windowPreserved') is not True or receipt.get('requiresWindowHandoff') is not False
                or type(receipt.get('freeBytes')) is not int or receipt['freeBytes'] <= 6 * 1024**3
                or guards.get('rechargeIdle') is not True or guards.get('registrationBusy') is not False
                or guards.get('registrationLeaseActive') is not False or type(guards.get('registrationWindowRetained')) is not bool
                or guards.get('registrationWindowRetained') is not True
                or task.get('taskId') != namespace['TASK_ID'] or type(task.get('attempt')) is not int or task.get('attempt') != namespace['TASK_ATTEMPT']
                or task.get('binding') != namespace['TASK_BINDING']
                or task != namespace['MIGRATION_TASK'] or type(task.get('auditCount')) is not int
                or any(task.get(n) is not True for n in ('registered', 'passwordCandidatePresent'))
                or any(task.get(n) is not False for n in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
                or any(not re.fullmatch(r'[a-f0-9]{64}', task.get(n, '')) for n in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'))
                or state.get('status') not in ('PENDING', 'APPLIED') or state.get('schemaVerified') is not True
                or state.get('name') != namespace['MIGRATION_NAME'] or state.get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
                or not re.fullmatch(r'[a-f0-9]{64}', state.get('appliedMigrationsSha256', ''))
                or audit.get('mode') != 'STRICT_ZERO_49' or audit.get('checkCount') != 49 or audit.get('violationCount') != 0
                or not re.fullmatch(r'[a-f0-9]{64}', audit.get('checksSha256', ''))):
            raise RuntimeError('API_ADMIN_MIGRATION_PREFLIGHT_CHANGED')
    if mode == 'readback':
        import runpy
        namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
        proof = json.loads((Path('.deploy/production-release') / namespace['PROOF_FILE']).read_text())
        if scope == 'API_ADMIN_WORKSPACE':
            from types import SimpleNamespace
            def need(condition, code):
                if not condition:
                    raise RuntimeError(code)
            namespace['validate_proof'](SimpleNamespace(require=need), proof, expected, receipt.get('sourceTree'))
        before = {}
        if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE'):
            before_file = Path('.deploy/production-release') / (namespace['PREFIX'] + '-preflight-result.json')
            before = json.loads(before_file.read_text()) if before_file.is_file() else {}
        online_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_online_workspace_receipt(namespace, receipt, expected, mode,
                before=before, environment=os.environ))
        pending_workspace = (scope == 'API_ADMIN_WORKSPACE'
            and validate_pending_workspace_receipt(namespace, receipt, expected, mode, proof=proof))
        updated = ['api', 'admin'] if pending_workspace else list(namespace['UPDATED'])
        if (receipt.get('buildProofSha256') != namespace['fingerprint'](proof)
                or receipt.get('sourceTree') != proof['sourceTree'] or proof['commit'] != expected
                or receipt.get('servicesUpdated') != updated
                or receipt.get('preservedServiceCount') != (5 if pending_workspace else 4 if scope == 'API_ADMIN_WORKSPACE' else 5)
                or receipt.get('runningImagesAndContentMatched') is not True
                or receipt.get('environmentUnchanged') is not True
                or any(receipt.get('services', {}).get(name, {}).get('image') != row['imageId']
                       or receipt.get('services', {}).get(name, {}).get('reference') != row['reference']
                       for name, row in proof['images'].items() if name in namespace['UPDATED'])):
            raise RuntimeError('API_ADMIN_READBACK_BUILD_CHANGED')
        if scope == 'API_ADMIN_MIGRATION' and (
                receipt.get('migration') != namespace['MIGRATION_IDENTITY']
                or receipt.get('migrationApplied') is not True or type(receipt.get('migrationPerformed')) is not bool
                or receipt.get('taskHmacMatched') is not True or receipt.get('windowPreserved') is not True
                or type(receipt.get('registrationWindowRetained')) is not bool
                or receipt.get('migrationState', {}).get('status') != 'APPLIED'
                or receipt.get('migrationState', {}).get('sha256') != namespace['MIGRATION_IDENTITY']['sha256']
                or receipt.get('migrationState', {}).get('name') != namespace['MIGRATION_NAME']
                or receipt.get('migrationState', {}).get('schemaVerified') is not True
                or not re.fullmatch(r'[a-f0-9]{64}', receipt.get('migrationState', {}).get('appliedMigrationsSha256', ''))):
            raise RuntimeError('API_ADMIN_MIGRATION_READBACK_CHANGED')
        if scope == 'API_ADMIN_WORKSPACE':
            if (receipt.get('workspaceVolume', {}).get('status') != 'PRESENT'
                    or not re.fullmatch(r'[a-f0-9]{64}', receipt.get('workspaceVolume', {}).get('identitySha256', ''))
                    or receipt.get('volumePreserved') is not True or receipt.get('volumeDeletionPerformed') is not False
                    or receipt.get('registrationHealthChecked') is not True or receipt.get('offlineAcceptance') != proof.get('acceptance')):
                raise RuntimeError('API_ADMIN_WORKSPACE_READBACK_CHANGED')
            protection = receipt.get('sqliteProtection')
            if protection is not None and (not isinstance(protection, dict)
                    or set(protection) != {'backupVerified', 'restoreVerified', 'sqliteProtectionSha256', 'backupSha256', 'backupSize'}
                    or protection['backupVerified'] is not True or protection['restoreVerified'] is not True
                    or type(protection['backupSize']) is not int or not 0 < protection['backupSize'] <= 256 * 1024**2
                    or any(not isinstance(protection[key], str) or not re.fullmatch(r'[a-f0-9]{64}', protection[key])
                           for key in ('sqliteProtectionSha256', 'backupSha256'))):
                raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_RECEIPT_CHANGED')
        if scope in ('API_ADMIN', 'API_ADMIN_WORKSPACE'):
            context = before.get('migrationOrigin')
            if online_workspace or context is not None or receipt.get('preservedMigrationOrigin') is not None:
                marker = validate_migration_origin(namespace, context)
                if (before.get('status') != scope + '_BASELINE_VERIFIED'
                        or before.get('mode') != 'preflight'
                        or before.get('releaseCandidateCommit') != expected
                        or os.environ.get('RELEASE_COMMIT') != expected
                        or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ID', ''))
                        or not re.fullmatch(r'[1-9][0-9]*', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                        or before.get('workflowRunId') != os.environ['GITHUB_RUN_ID']
                        or before.get('workflowRunAttempt') != os.environ['GITHUB_RUN_ATTEMPT']
                        or receipt.get('preservedMigrationOrigin') != marker
                        or receipt.get('migrationPreserved') is not True or receipt.get('migrationPerformed') is not False
                        or receipt.get('taskHmacMatched') is not True or receipt.get('windowPreserved') is not True
                        or receipt.get('registrationWindowRetained') is not True):
                    raise RuntimeError('API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED')
    return receipt


def main():
    os.umask(0o077)
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    operation = os.environ.get('RELEASE_OPERATION', '')
    scope = selected_scope(operation)
    if mode == 'handoff' and operation != 'handoff_api_registration':
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    if mode == 'business' and operation != 'verify_registration_business':
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    if mode in ('handoff-observe', 'handoff-recover') and operation != {'handoff-observe': 'verify_registration_handoff', 'handoff-recover': 'recover_registration_handoff'}[mode]:
        raise ValueError('API_ADMIN_SCOPE_CONFLICT')
    expected = os.environ['RELEASE_COMMIT'] if mode == 'readback' else os.environ['EXPECTED_CURRENT']
    producer = declaration_producer_metadata() if scope == 'API_ADMIN_WORKSPACE' else None
    data = parameters(os.environ['RELEASE_COMMIT'], expected, mode, scope,
                      require_closed=operation != 'verify_api_registration', declaration_producer=producer)
    aws = ['aws', '--region', os.environ['AWS_REGION'], 'ssm']
    command_id = command(*aws, 'send-command', '--instance-ids', os.environ['PRODUCTION_INSTANCE_ID'],
        '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps(data), '--timeout-seconds', '300',
        '--comment', 'ID ' + scope + ' independent ' + mode, '--query', 'Command.CommandId', '--output', 'text')
    if not re.fullmatch(r'[a-f0-9-]{36}', command_id):
        raise RuntimeError('API_ADMIN_COMMAND_ID_INVALID')
    print(scope + '_COMMAND ' + command_id, flush=True)
    target = Path('.deploy/production-release') / (('api-workspace' if scope == 'API_ADMIN_WORKSPACE' else scope.lower().replace('_', '-')) + f'-{mode}-result.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(36):
        time.sleep(10)
        try:
            arguments = (*aws, 'get-command-invocation', '--command-id', command_id,
                         '--instance-id', os.environ['PRODUCTION_INSTANCE_ID'], '--output', 'json')
            invocation_raw = command_raw(*arguments) if scope == 'API_ADMIN_WORKSPACE' else command(*arguments)
            if scope == 'API_ADMIN_WORKSPACE' and (type(invocation_raw) is not bytes
                    or not 0 < len(invocation_raw) < 128 * 1024):
                raise ValueError('size')
            result = json.loads(invocation_raw)
        except RuntimeError:
            continue
        if result.get('Status') in ('Pending', 'InProgress', 'Delayed'):
            continue
        output = result.get('StandardOutputContent', '')
        # Remote helper emits only hashes, identifiers, guarded booleans and status.
        try:
            receipt = decode_transport_receipt(output, scope)
        except (ValueError, TypeError, RuntimeError):
            receipt = {}
        wanted = scope + ('_BASELINE_VERIFIED' if mode == 'preflight' else '_HANDOFF_OBSERVED' if mode == 'handoff-observe' else '_HANDOFF_VERIFIED' if mode in ('handoff', 'handoff-recover')
                          else '_BUSINESS_OBSERVED' if mode == 'business' else '_VERIFIED')
        if result.get('Status') != 'Success' or result.get('ResponseCode') != 0 or receipt.get('status') != wanted:
            failure = safe_failure(receipt, scope)
            raw_failure = (json.dumps({'commandId': command_id, 'mode': mode, **failure}, indent=2) + '\n').encode()
            if scope == 'API_ADMIN_WORKSPACE':
                failure_target = target.with_name(target.stem + '-failure.json') if target.exists() else target
                write_workspace_private_bytes(failure_target, raw_failure)
            else:
                target.write_bytes(raw_failure)
            print(json.dumps(failure))
            raise RuntimeError(failure['code'])
        if scope == 'API_ADMIN_WORKSPACE':
            # Keep malformed terminal metadata outside the retry catch above.
            validated_workspace_invocation(invocation_raw, command_id)
        validate_receipt(receipt, expected, mode, scope)
        if scope == 'API_ADMIN_WORKSPACE' and receipt.get('pendingOnlineMigrationOrigin') is not None:
            import runpy
            namespace = runpy.run_path(str(Path(__file__).with_name('api-admin-scope.py')), init_globals={'SCOPE': scope})
            receipt['pendingOnlineEndedFailures'] = validate_pending_ended_failures(namespace, receipt['pendingOnlineMigrationOrigin'])
        raw_result = (json.dumps({'commandId': command_id, 'mode': mode,
            'releaseCandidateCommit': os.environ['RELEASE_COMMIT'],
            'workflowRunId': os.environ.get('GITHUB_RUN_ID', ''),
            'workflowRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT', ''), **receipt}, indent=2) + '\n').encode()
        if scope == 'API_ADMIN_WORKSPACE':
            write_workspace_private_bytes(target, raw_result)
            context = receipt.get('pendingOnlineMigrationOrigin')
            if type(context) is dict and context.get('version') == 2:
                kind = 'preflight' if mode == 'preflight' else 'readback-invocation'
                artifact_raw = raw_result if mode == 'preflight' else invocation_raw
                if mode == 'readback':
                    write_workspace_private_bytes(target.with_name('api-workspace-readback-invocation.json'), artifact_raw)
                ack = save_workspace_artifact(producer, kind, artifact_raw)
                ack_target = target.with_name(target.stem + '-artifact-save.json')
                write_workspace_private_bytes(ack_target, (json.dumps(ack, indent=2) + '\n').encode())
        else:
            target.write_bytes(raw_result)
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
        print(json.dumps({'status': selected_scope(os.environ.get('RELEASE_OPERATION', '')) + '_VERIFICATION_FAILED', 'code': code}))
        raise SystemExit(1) from None
