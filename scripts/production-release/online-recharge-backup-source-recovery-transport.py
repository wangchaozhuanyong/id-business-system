"""Runtime candidate: two fixed historical MySQL backup leaves, never qualification."""
import ast
import base64
import gzip
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import types

BASE = Path('/opt/id-business-v2')
ROOT_UID = 0
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
OPERATIONS = {'diagnose_online_backup_source': 'diagnose',
              'restore_online_backup_source': 'restore_missing'}
PREFIX = 'ONLINE_BACKUP_SOURCE '
CORE_NAME = 'online-recharge-backup-source-recovery.py'
SNAPSHOT_NAME = 'online-recharge-source-permission-repair-transport.py'
ORIGIN = {'workflowRunId': '38051602854', 'workflowRunAttempt': '1',
          'candidateCommit': 'c3cda13d39ef2235c2dcdfd6a2ec352197a5eeb0',
          'sourceTree': 'bdbc45cc186954992e6043407ca528b121284791',
          'commandId': '6977cc4b-934c-4aab-9e67-d750982e112e',
          'receiptBytes': 462,
          'receiptSha256': '126360cd6aec28337db2fc90570c349eda5e802bb09b199ae3acecab8758a6ff',
          'step': 'LOCAL'}
HISTORY = (('RECOVERY', '28a3ba4ffd17d36001b1104c97394f5ae871d73d',
            '1959377acd78e7160fec0f85666982d4ea4efbb40dab199b7dcc04ba288ddd5a',
            'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'migration'),
           ('RESTORED', '296c096af7c4c79a8ffc2f57d9a15ea75684f431',
            'f04e9356221bc10a33c774ce9e692b40db6afa23fd2a3bde23caf096a4f07485',
            'ONLINE_RECHARGE_FAILED_RESTORED', 'audit-after'))
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
ARTIFACT = Path('.deploy/production-release/online-backup-source-recovery-result.json')
DIRECTORY_ROLES = frozenset(('ROOT', 'BASE_PARENT', 'BASE', 'RELEASES', 'CURRENT_RELEASE',
                             'BACKUPS', 'MYSQL', 'HISTORY_RECOVERY', 'HISTORY_RESTORED'))
TRANSPORT_CODES = frozenset(('OK', 'INPUT_INVALID', 'ANCESTOR_INVALID', 'CURRENT_INVALID',
                            'SOURCE_INVALID', 'FAILURE_CHANGED', 'RECEIPT_CHANGED',
                            'ENVIRONMENT_INVALID', 'AUTHORITY_CHANGED', 'SERVICES_CHANGED',
                            'CORE_REJECTED', 'IO_FAILURE')) | frozenset(
                                'ANCESTOR_' + role + '_' + reason
                                for role in DIRECTORY_ROLES
                                for reason in ('TYPE', 'OWNER', 'WRITABLE', 'IDENTITY'))
REMOTE_FIELDS = frozenset(('kind', 'operation', 'producer', 'origin', 'source21Sha256',
                          'coreSha256', 'snapshotSourceSha256', 'status', 'code',
                          'currentUnchanged', 'servicesUnchanged', 'servicesBeforeSha256',
                          'servicesAfterSha256', 'snapshotDiagnostic', 'clientCleanupVerified',
                          'mutationAttempted', 'installed', 'backups', 'rawOutputSuppressed'))


class Rejected(RuntimeError):
    pass


def need(ok, code='INPUT_INVALID'):
    if not ok:
        raise Rejected(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def closed(raw, limit=256 * 1024):
    need(type(raw) is bytes and 0 < len(raw) <= limit)
    def unique(items):
        result = {}
        for name, value in items:
            need(name not in result)
            result[name] = value
        return result
    def invalid(unused):
        raise Rejected('INPUT_INVALID')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def producer_validate(value):
    need(type(value) is dict and set(value) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'})
    need(all(type(value[n]) is str and re.fullmatch('[a-f0-9]{40}', value[n])
             for n in ('commit', 'sourceTree')))
    need(all(type(value[n]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[n])
             for n in ('workflowRunId', 'workflowRunAttempt')))
    return value


def selection(environ):
    operation = environ.get('RELEASE_OPERATION')
    need(operation in OPERATIONS and environ.get('EXPECTED_CURRENT') == BASELINE
         and environ.get('HISTORICAL_EXCEPTION', 'none') == 'none'
         and environ.get('RELEASE_ADMIN_ONLY', 'false') == 'false'
         and environ.get('GITHUB_REF') == 'refs/heads/main')
    forbidden = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID',
                 'REUSE_IMAGE_RUN_ATTEMPT', 'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256',
                 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', 'RELEASE_BROWSER_CACHE_IMAGE',
                 'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID',
                 'BACKUP_SOURCE', 'BACKUP_MODE')
    need(not any(environ.get(n) for n in forbidden))
    producer = producer_validate({key: environ.get(name) for key, name in
        (('commit', 'RELEASE_COMMIT'), ('sourceTree', 'SOURCE_TREE'),
         ('workflowRunId', 'GITHUB_RUN_ID'), ('workflowRunAttempt', 'GITHUB_RUN_ATTEMPT'))})
    return operation, producer


def identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid, row.st_nlink,
            row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def directory_identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid)


def directory_safe(row, role):
    need(role in DIRECTORY_ROLES)
    need(stat.S_ISDIR(row.st_mode), 'ANCESTOR_' + role + '_TYPE')
    need(row.st_uid == ROOT_UID, 'ANCESTOR_' + role + '_OWNER')
    need(stat.S_IMODE(row.st_mode) & 0o022 == 0, 'ANCESTOR_' + role + '_WRITABLE')


class Authority:
    """Held fixed directory walk plus immutable historical receipt/environment descriptors."""
    def __init__(self):
        self.fds, self.directories, self.files = [], [], []
        try:
            root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.fds.append(root); directory_safe(os.fstat(root), 'ROOT')
            fd = root
            for index, part in enumerate(BASE.parts[1:]):
                role = 'BASE' if index == len(BASE.parts) - 2 else 'BASE_PARENT'
                fd = self.child(fd, part, role=role)
            self.base = fd
            self.releases = self.child(fd, 'releases', role='RELEASES')
            self.current, self.current_anchor = self.current_read()
            self.current_fd = self.child(self.releases, self.current.name, role='CURRENT_RELEASE')
            self.backups = self.child(fd, 'backups', role='BACKUPS')
            self.mysql = self.child(self.backups, 'mysql', role='MYSQL')
        except BaseException:
            self.close()
            raise

    def child(self, parent, name, private=False, *, role):
        visible = os.stat(name, dir_fd=parent, follow_symlinks=False)
        directory_safe(visible, role)
        if private:
            need(stat.S_IMODE(visible.st_mode) & 0o077 == 0, 'SOURCE_INVALID')
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        self.fds.append(fd)
        opened = os.fstat(fd); directory_safe(opened, role)
        need(directory_identity(visible) == directory_identity(opened), 'ANCESTOR_' + role + '_IDENTITY')
        self.directories.append((parent, name, fd, directory_identity(opened)))
        return fd

    def current_read(self):
        before = os.stat('current', dir_fd=self.base, follow_symlinks=False)
        need(stat.S_ISLNK(before.st_mode) and before.st_uid == ROOT_UID
             and before.st_nlink == 1 and 0 < before.st_size <= 512, 'CURRENT_INVALID')
        target = os.readlink('current', dir_fd=self.base)
        names = [target[len(prefix):] for prefix in (str(BASE) + '/releases/', 'releases/')
                 if target.startswith(prefix)]
        need(len(names) == 1 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + BASELINE[:12], names[0]),
             'CURRENT_INVALID')
        need(identity(before) == identity(os.stat('current', dir_fd=self.base, follow_symlinks=False)),
             'CURRENT_INVALID')
        return BASE / 'releases' / names[0], (target, identity(before))

    def read(self, parent, name, limit=256 * 1024):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        self.fds.append(fd); before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) & 0o022 == 0 and 0 < before.st_size <= limit,
             'SOURCE_INVALID')
        raw = b''
        while len(raw) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not chunk:
                break
            raw += chunk
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
             == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'AUTHORITY_CHANGED')
        self.files.append((parent, name, fd, identity(before)))
        return raw

    def check(self):
        for parent, name, fd, anchor in self.directories:
            need(directory_identity(os.fstat(fd)) == anchor
                 == directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)),
                 'AUTHORITY_CHANGED')
        for parent, name, fd, anchor in self.files:
            need(identity(os.fstat(fd)) == anchor
                 == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'AUTHORITY_CHANGED')
        need(self.current_read() == (self.current, self.current_anchor), 'AUTHORITY_CHANGED')

    def expected(self, core):
        raw = self.read(self.current_fd, '.env.aws.production')
        values = {}
        wanted = ('MYSQL_BACKUP_S3_BUCKET', 'MYSQL_BACKUP_S3_PREFIX', 'MYSQL_BACKUP_S3_REGION')
        for line in raw.decode().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                if key in wanted:
                    need(key not in values, 'ENVIRONMENT_INVALID')
                    values[key] = value.strip().strip('"').strip("'")
        bucket = values.get(wanted[0], '')
        prefix = values.get(wanted[1], 'mysql/daily').rstrip('/')
        region = values.get(wanted[2]) or 'ap-northeast-1'
        need(all(type(value) is str and '\0' not in value for value in (bucket, prefix, region))
             and bucket and region, 'ENVIRONMENT_INVALID')
        names = os.listdir(self.releases)
        result = []
        for role, commit, failure_sha, status, step in HISTORY:
            matches = [n for n in names if n.endswith('-' + commit[:12])]
            need(len(matches) == 1 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + commit[:12], matches[0]),
                 'SOURCE_INVALID')
            fd = self.child(self.releases, matches[0], private=True, role='HISTORY_' + role)
            failure = closed(self.read(fd, 'online-recharge-failure.json'))
            need(type(failure) is dict and sha(canonical(failure)) == failure_sha
                 and failure.get('candidateCommit') == commit and failure.get('previousCommit') == BASELINE
                 and failure.get('status') == status and failure.get('step') == step
                 and failure.get('rollbackOk') is True and failure.get('currentPointsToCandidate') is False
                 and failure.get('receiptPersisted') is True, 'FAILURE_CHANGED')
            receipt = closed(self.read(fd, 'backup-verification.json'))
            need(type(receipt) is dict and set(receipt) == {'name', 'size', 'sha256', 's3Verified'}
                 and type(receipt['name']) is str
                 and re.fullmatch(r'id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz', receipt['name'])
                 and type(receipt['size']) is int and receipt['size'] > 0
                 and type(receipt['sha256']) is str and HEX.fullmatch(receipt['sha256'])
                 and receipt['s3Verified'] is True, 'RECEIPT_CHANGED')
            if role == 'RESTORED':
                manifest = closed(self.read(fd, 'release-manifest.json'))
                need(type(manifest) is dict and manifest.get('commit') == commit
                     and manifest.get('previousCommit') == BASELINE
                     and manifest.get('backupBeforeRelease') == receipt['name'], 'RECEIPT_CHANGED')
            result.append((role, core.ExpectedBackup(**receipt, bucket=bucket, prefix=prefix, region=region)))
        self.check()
        return result

    def close(self):
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds = []


def head_read(expected):
    raw = bounded_process(
        ['aws', 's3api', 'head-object', '--bucket', expected.bucket, '--key', expected.key,
         '--checksum-mode', 'ENABLED', '--region', expected.region,
         '--query', '{ContentLength:ContentLength,ServerSideEncryption:ServerSideEncryption,ChecksumSHA256:ChecksumSHA256}',
         '--output', 'json'], 4096, 30)
    return closed(raw, 4096)


def download(expected, fd):
    """Copy only the private derived S3 key to an already held FD, with a total deadline."""
    bounded_process(
        ['aws', 's3', 'cp', 's3://' + expected.bucket + '/' + expected.key, '-',
         '--region', expected.region, '--only-show-errors'], expected.size, 90, fd=fd)


def bounded_process(command, limit, timeout, fd=None):
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C'}, start_new_session=True)
    selector = selectors.DefaultSelector()
    raw = b''
    try:
        need(process.stdout is not None)
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        count = 0
        while True:
            remaining = deadline - time.monotonic()
            need(remaining > 0 and selector.select(remaining))
            chunk = os.read(process.stdout.fileno(), min(65536, limit - count + 1))
            if not chunk:
                break
            count += len(chunk); need(count <= limit)
            if fd is None:
                raw += chunk
            else:
                offset = 0
                while offset < len(chunk):
                    written = os.write(fd, chunk[offset:])
                    need(written > 0); offset += written
        if fd is not None:
            need(count == limit)
        remaining = deadline - time.monotonic()
        need(remaining > 0 and process.wait(timeout=remaining) == 0)
        return raw
    finally:
        selector.close()
        if process.stdout is not None:
            process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


def core_validate(value, mode, core):
    need(type(value) is dict and set(value) == core.FIELDS
         and value['kind'] == 'MYSQL_BACKUP_LOCAL_RECOVERY_V1' and value['mode'] == mode
         and value['status'] in core.STATUSES and value['code'] in core.CODES
         and value['localStateBefore'] in core.LOCAL_STATES
         and value['localStateAfter'] in core.LOCAL_STATES
         and all(type(value[n]) is bool for n in ('mutationAttempted', 'installed', 'rawOutputSuppressed'))
         and value['rawOutputSuppressed'] is True)
    if mode == 'diagnose':
        need(not value['mutationAttempted'] and not value['installed'])
    if value['status'] in ('DIAGNOSED', 'NO_CHANGE', 'RESTORED'):
        need(value['code'] == 'OK')
    if value['status'] == 'RESTORED':
        need(value['installed'] and value['mutationAttempted'] and value['localStateBefore'] == 'MISSING'
             and value['localStateAfter'] == 'MATCH')
    return value


def execute_action(operation, core, snapshot_read):
    mode = OPERATIONS[operation]
    authority = None; backups = []
    result = {'status': 'FAILED', 'code': 'IO_FAILURE', 'currentUnchanged': False,
              'servicesUnchanged': False, 'servicesBeforeSha256': 'NOT_MEASURED',
              'servicesAfterSha256': 'NOT_MEASURED', 'mutationAttempted': False, 'installed': False,
              'backups': backups, 'rawOutputSuppressed': True}
    try:
        need(os.getuid() == ROOT_UID and os.geteuid() == ROOT_UID)
        authority = Authority()
        expected = authority.expected(core)
        before = snapshot_read(authority.current)
        need(type(before) is str and HEX.fullmatch(before))
        result['servicesBeforeSha256'] = before
        def guard():
            authority.check()
            after = snapshot_read(authority.current)
            result['servicesAfterSha256'] = after
            need(type(after) is str and HEX.fullmatch(after) and after == before, 'SERVICES_CHANGED')
        def safe_head(value):
            guard()
            return head_read(value)
        def safe_download(value, fd):
            guard()
            download(value, fd)
            guard()
        binding = core.DirectoryBinding(authority.backups, authority.mysql)
        for role, value in expected:
            guard()
            receipt = core_validate(core.recover(value, binding, mode=mode,
                head_read=safe_head if mode == 'restore_missing' else None,
                download=safe_download if mode == 'restore_missing' else None), mode, core)
            backups.append({'sourceRole': role, 'receipt': receipt})
            result['mutationAttempted'] |= receipt['mutationAttempted']
            result['installed'] |= receipt['installed']
            guard()
            need(receipt['status'] in (('DIAGNOSED',) if mode == 'diagnose' else ('NO_CHANGE', 'RESTORED')),
                 'CORE_REJECTED')
        result.update(status='COMPLETED', code='OK', currentUnchanged=True, servicesUnchanged=True)
    except Exception as error:
        args = BaseException.args.__get__(error)
        if type(error) is Rejected and type(args) is tuple and len(args) == 1 and type(args[0]) is str and args[0] in TRANSPORT_CODES:
            result['code'] = args[0]
        if result['installed']:
            result['status'] = 'FAILED_MUTATED_UNVERIFIED'
    finally:
        if authority is not None:
            authority.close()
    return result


def remote_execute(operation, producer, binding, directory, snapshot):
    producer_validate(producer); need(operation in OPERATIONS)
    need(directory == BASE / '.staging' / ('api-workspace-verify-' + producer['commit']))
    core = snapshot.literal_module(snapshot.read_fixed(directory / CORE_NAME, binding['coreSha256']),
                                   'backup_source_core', directory / CORE_NAME)
    modules = {name: snapshot.literal_module(snapshot.read_fixed(directory / name, binding['controllerPins'][name]),
               'backup_source_' + name.replace('-', '_').replace('.', '_'), directory / name)
               for name in ('online-recharge-scope.py', 'api-admin-scope.py', 'remote-deploy.py')}
    diagnostic = snapshot.snapshot_state()
    with tempfile.TemporaryDirectory(prefix='backup-source-client-', dir=directory) as temporary:
        client = Path(temporary); client.chmod(0o700)
        fd = os.open(client / 'config.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            need(os.write(fd, b'{}\n') == 3)
        finally:
            os.close(fd)
        drivers = []
        def snapshot_read(current):
            if not drivers:
                drivers.append(snapshot.NativeSnapshotDriver(current, client, modules['online-recharge-scope.py'],
                    modules['api-admin-scope.py'], modules['remote-deploy.py'], diagnostic))
            return drivers[0].snapshot(current)
        result = execute_action(operation, core, snapshot_read)
    return {'kind': 'ONLINE_BACKUP_SOURCE_EXECUTION_V1', 'operation': operation,
            'producer': producer, 'origin': ORIGIN, 'source21Sha256': binding['source21Sha256'],
            'coreSha256': binding['coreSha256'], 'snapshotSourceSha256': binding['snapshotSourceSha256'],
            'snapshotDiagnostic': diagnostic.get(), 'clientCleanupVerified': True, **result}


def module_from_bytes(raw, name, path):
    value = types.ModuleType(name); value.__file__ = str(path)
    sys.modules[name] = value
    exec(compile(raw, str(path), 'exec'), value.__dict__)
    return value


def packed_command(raw, limit):
    need(0 < len(raw) <= limit)
    encoded = base64.b85encode(gzip.compress(raw, mtime=0)).decode()
    boot = ("import base64,hashlib,zlib;d=zlib.decompressobj(31);r=d.decompress(base64.b85decode("
            + repr(encoded) + ")," + str(limit + 1) + ");assert 0<len(r)<=" + str(limit)
            + " and d.eof and not d.unused_data and not d.unconsumed_tail;"
            + "assert hashlib.sha256(r).hexdigest()==" + repr(sha(raw))
            + ";exec(compile(r,'<fixed-backup-source-operation>','exec'))")
    return 'python3 -B -c ' + shlex.quote(boot)


def parameters(operation, producer, source=None, core_path=None):
    """Local assembly only; optional directories are for isolated runtime tests."""
    need(operation in OPERATIONS); producer_validate(producer)
    source = Path(__file__).parent if source is None else Path(source)
    core_path = source / CORE_NAME if core_path is None else Path(core_path)
    helper = module_from_bytes((source / 'api-admin-readonly.py').read_bytes(), 'backup_carrier', source / 'api-admin-readonly.py')
    snapshot_raw = (source / SNAPSHOT_NAME).read_bytes()
    core_raw = core_path.read_bytes(); need(0 < len(core_raw) <= 1024**2)
    controllers = {n: sha((source / n).read_bytes()) for n in helper.FORMAL_RUNTIME_CONTROLLERS}
    packages = {n: sha((source / 'formal-runtime-package' / n).read_bytes()) for n in helper.FORMAL_RUNTIME_FILES}
    need(len(controllers) == 11 and len(packages) == 10)
    binding = {'producer': producer, 'origin': ORIGIN, 'coreSha256': sha(core_raw),
               'snapshotSourceSha256': sha(snapshot_raw), 'controllerPins': controllers, 'packagePins': packages,
               'source21Sha256': sha(canonical({'controllers': controllers, 'package': packages}))}
    directory = BASE / '.staging' / ('api-workspace-verify-' + producer['commit'])
    commands = ['set -eu', 'umask 077']
    commands += helper.formal_runtime_commands(str(directory), producer['commit'], source / 'formal-runtime-package', source)
    # Original installer copied byte-for-byte; its extra two pins are separate from formal 21.
    extra = inspect.getsource(helper._store_files) + '\n_store_files(' + repr(str(directory)) + ',' + repr(producer['commit']) + ',' + repr({CORE_NAME: binding['coreSha256'], SNAPSHOT_NAME: binding['snapshotSourceSha256']}) + ',False)\n'
    commands.append(packed_command(extra.encode(), 16384))
    snap_lines = snapshot_raw.decode().splitlines(keepends=True)
    snap_nodes = {n.name: n for n in ast.parse(snapshot_raw).body if isinstance(n, ast.FunctionDef)}
    body = 'import hashlib,json,os,re,stat,types\nfrom pathlib import Path\nHEX=re.compile(r"[a-f0-9]{64}\\Z")\n'
    for name in ('need', 'sha', 'literal_module', 'read_fixed'):
        node = snap_nodes[name]; body += ''.join(snap_lines[node.lineno - 1:node.end_lineno]) + '\n'
    body += 'snapshot=literal_module(read_fixed(Path(' + repr(str(directory / SNAPSHOT_NAME)) + '),' + repr(binding['snapshotSourceSha256']) + '),"backup_snapshot",Path(' + repr(str(directory / SNAPSHOT_NAME)) + '))\n'
    own = Path(__file__).read_text(); own_lines = own.splitlines(keepends=True)
    own_nodes = {n.name: n for n in ast.parse(own).body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    body += 'import selectors,subprocess,tempfile,time\n'
    for name in ('BASE', 'ROOT_UID', 'BASELINE', 'OPERATIONS', 'PREFIX', 'CORE_NAME', 'ORIGIN', 'HISTORY', 'DIRECTORY_ROLES', 'TRANSPORT_CODES'):
        value = globals()[name]
        body += name + '=' + ('Path(' + repr(str(value)) + ')' if name == 'BASE' else
            'frozenset(' + repr(tuple(sorted(value))) + ')' if type(value) is frozenset else repr(value)) + '\n'
    for name in ('Rejected', 'need', 'sha', 'canonical', 'closed', 'producer_validate', 'identity',
                 'directory_identity', 'directory_safe', 'Authority', 'head_read', 'download', 'bounded_process',
                 'core_validate', 'execute_action', 'remote_execute'):
        node = own_nodes[name]; body += ''.join(own_lines[node.lineno - 1:node.end_lineno]) + '\n'
    body += 'value=remote_execute(' + repr(operation) + ',' + repr(producer) + ',' + repr(binding) + ',Path(' + repr(str(directory)) + '),snapshot)\n'
    body += 'print(PREFIX+json.dumps(value,sort_keys=True,separators=(",",":")))\nraise SystemExit(0 if value["status"]=="COMPLETED" else 1)\n'
    commands.append(packed_command(body.encode(), 65536))
    payload = {'commands': commands, 'executionTimeout': ['300']}
    need(len(canonical(payload)) < 20480)
    binding['payloadBytes'] = len(canonical(payload))
    binding['capturedProgramBytes'] = len(body.encode())
    return payload, binding


def validate_remote(value, operation, binding, core, snapshot):
    need(type(value) is dict and set(value) == REMOTE_FIELDS
         and value['kind'] == 'ONLINE_BACKUP_SOURCE_EXECUTION_V1' and value['operation'] == operation
         and value['producer'] == binding['producer'] and value['origin'] == ORIGIN
         and all(value[n] == binding[n] for n in ('source21Sha256', 'coreSha256', 'snapshotSourceSha256'))
         and value['status'] in ('COMPLETED', 'FAILED', 'FAILED_MUTATED_UNVERIFIED')
         and value['code'] in TRANSPORT_CODES)
    need(all(type(value[n]) is bool for n in ('currentUnchanged', 'servicesUnchanged',
         'clientCleanupVerified', 'mutationAttempted', 'installed', 'rawOutputSuppressed'))
         and value['rawOutputSuppressed'] and value['clientCleanupVerified'])
    need(all(type(value[n]) is str and (value[n] == 'NOT_MEASURED' or HEX.fullmatch(value[n]))
             for n in ('servicesBeforeSha256', 'servicesAfterSha256')))
    need(type(value['backups']) is list and len(value['backups']) <= 2)
    for index, row in enumerate(value['backups']):
        need(type(row) is dict and set(row) == {'sourceRole', 'receipt'} and row['sourceRole'] == HISTORY[index][0])
        core_validate(row['receipt'], OPERATIONS[operation], core)
    need(value['mutationAttempted'] == any(n['receipt']['mutationAttempted'] for n in value['backups'])
         and value['installed'] == any(n['receipt']['installed'] for n in value['backups']))
    snapshot.snapshot_validate(value['snapshotDiagnostic'])
    if value['status'] == 'COMPLETED':
        need(value['code'] == 'OK' and len(value['backups']) == 2 and value['currentUnchanged']
             and value['servicesUnchanged'] and HEX.fullmatch(value['servicesBeforeSha256'])
             and value['servicesBeforeSha256'] == value['servicesAfterSha256']
             and value['snapshotDiagnostic']['status'] == 'PASSED')
        statuses = ('DIAGNOSED',) if OPERATIONS[operation] == 'diagnose' else ('NO_CHANGE', 'RESTORED')
        need(all(row['receipt']['status'] in statuses for row in value['backups']))
    return value


def terminal(invocation, command_id, operation, binding, instance, core, snapshot):
    need(type(invocation) is dict and invocation.get('CommandId') == command_id
         and invocation.get('InstanceId') == instance and invocation.get('DocumentName') == 'AWS-RunShellScript'
         and invocation.get('PluginName') == 'aws:runShellScript'
         and invocation.get('Status') in ('Success', 'Failed') and type(invocation.get('ResponseCode')) is int
         and type(invocation.get('ExecutionEndDateTime')) is str and 0 < len(invocation['ExecutionEndDateTime']) <= 80)
    output = invocation.get('StandardOutputContent')
    need(type(output) is str and output.startswith(PREFIX) and len(output.encode()) < 24000)
    value = validate_remote(closed(output[len(PREFIX):].encode(), 24000), operation, binding, core, snapshot)
    success = value['status'] == 'COMPLETED'
    need((invocation['Status'] == 'Success') == success and invocation['ResponseCode'] == (0 if success else 1))
    if success:
        need(invocation.get('StandardErrorContent') == '')
    return value


def aws(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    need(result.returncode == 0 and type(result.stdout) is bytes and len(result.stdout) < 128 * 1024)
    return result.stdout


def main():
    need(len(sys.argv) == 1)
    operation, producer = selection(os.environ)
    payload, binding = parameters(operation, producer)
    source = Path(__file__).parent
    core = module_from_bytes((source / CORE_NAME).read_bytes(), 'backup_result_core', source / CORE_NAME)
    snapshot = module_from_bytes((source / SNAPSHOT_NAME).read_bytes(), 'backup_result_snapshot', source / SNAPSHOT_NAME)
    command_id = None; value = None
    try:
        prefix = ('aws', '--region', os.environ['AWS_REGION'], 'ssm')
        instance = os.environ['PRODUCTION_INSTANCE_ID']
        command_id = aws(*prefix, 'send-command', '--instance-ids', instance, '--document-name',
            'AWS-RunShellScript', '--parameters', canonical(payload).decode(), '--timeout-seconds', '300',
            '--comment', 'ID explicit fixed MySQL backup source operation', '--query',
            'Command.CommandId', '--output', 'text').decode().strip()
        need(UUID.fullmatch(command_id))
        for unused in range(36):
            time.sleep(10)
            invocation = closed(aws(*prefix, 'get-command-invocation', '--command-id', command_id,
                '--instance-id', instance, '--output', 'json'), 128 * 1024)
            need(type(invocation) is dict and invocation.get('CommandId') == command_id
                 and invocation.get('InstanceId') == instance)
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                continue
            value = terminal(invocation, command_id, operation, binding, instance, core, snapshot)
            break
    except Exception:
        value = None
    record = {'kind': 'ONLINE_BACKUP_SOURCE_ARTIFACT_V1', 'operation': operation, 'producer': producer,
              'origin': ORIGIN, 'commandId': command_id if command_id and UUID.fullmatch(command_id) else None,
              'status': 'OPERATION_COMPLETED' if value and value['status'] == 'COMPLETED' else 'OPERATION_FAILED',
              'code': value['code'] if value else 'TRANSPORT_UNAVAILABLE', 'result': value}
    helper = module_from_bytes((source / 'api-admin-readonly.py').read_bytes(), 'backup_artifact', source / 'api-admin-readonly.py')
    helper.write_workspace_private_bytes(ARTIFACT, canonical(record) + b'\n')
    print(json.dumps(record, sort_keys=True, separators=(',', ':')))
    return 0 if record['status'] == 'OPERATION_COMPLETED' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('{"status":"OPERATION_FAILED","code":"INPUT_OR_ARTIFACT_INVALID"}')
        raise SystemExit(1) from None
