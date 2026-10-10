#!/usr/bin/env python3
"""Read-only, fail-closed Linux dockerd runtime identity. No import-time I/O.

Public callers supply only the existing output-suppressing controller d.run.
Paths, PID authority and identity facts are collected here, not supplied claims.
This capability never invokes Docker, reads environ, installs RPMs or authorizes P.
"""
import hashlib
import ipaddress
import json
import os
import re
import stat

EXECUTABLE = '/usr/bin/dockerd'
CONFIG = '/etc/docker/daemon.json'
SERVICE = 'docker.service'
PACKAGE_NAMES = ('docker', 'moby-engine')
SYSTEMCTL = ('/usr/bin/systemctl', 'show', SERVICE, '--property=MainPID',
             '--property=ActiveState', '--property=SubState')
RPM_FORMAT = ('%{NAME}|%{EPOCHNUM}|%{VERSION}|%{RELEASE}|%{ARCH}|%{SOURCERPM}|'
              '%{FILEDIGESTALGO}\n[%{FILENAMES}|%{FILEDIGESTS}\n]')
RPM = ('/usr/bin/rpm', '-qf', EXECUTABLE, '--queryformat', RPM_FORMAT)
COLLECTION_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
HEX = re.compile(r'[a-f0-9]{64}\Z')
CODES = frozenset(('RUNTIME_UNAVAILABLE', 'SERVICE_INVALID', 'PATH_INVALID',
    'PERMISSIONS_INVALID', 'PROCESS_INVALID', 'EXECUTABLE_INVALID', 'RUNTIME_DRIFT',
    'CMDLINE_INVALID', 'CONFIG_INVALID', 'PACKAGE_INVALID', 'PACKAGE_DIGEST_UNSUPPORTED',
    'PACKAGE_BINARY_MISMATCH', 'REPORT_INVALID'))


class Rejected(RuntimeError):
    """Exceptions contain exactly a static code, never command/file contents."""


def check(condition, code):
    if not condition:
        raise Rejected(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)


def _proc_net_unix_path_identity(value):
    # Proc-net lookup can recreate inode timestamps. Keep all other fields;
    # descriptor stability and returned seals still use the full identity.
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_nlink)


def directory_identity(value):
    # /proc contains unrelated live PIDs: its time/size changes are not authority.
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)


def _root_owned(value):
    return value.st_uid == 0


def trusted(value, *, directory=False, executable=False):
    check(_root_owned(value) and not value.st_mode & 0o022, 'PERMISSIONS_INVALID')
    check(stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode),
          'PATH_INVALID')
    if not directory:
        check(value.st_nlink == 1, 'PATH_INVALID')
    if executable:
        check(value.st_mode & 0o111 and not value.st_mode & 0o6000, 'EXECUTABLE_INVALID')


class _Reader:
    """Rooted no-follow traversal. root exists solely for private sandbox tests.

    Production factory always uses '/'. Only the literal proc PID exe leaf is
    followed, after exact kernel-link spelling and target inode validation.
    """
    def __init__(self, root='/'):
        self.root = root

    def parent(self, path):
        check(isinstance(path, str) and path.startswith('/') and '..' not in path.split('/'),
              'PATH_INVALID')
        components = path.split('/')[1:]
        check(components and all(components), 'PATH_INVALID')
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        seals = []
        try:
            value = os.fstat(fd)
            trusted(value, directory=True)
            seals.append(directory_identity(value))
            for component in components[:-1]:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                                  os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = next_fd
                value = os.fstat(fd)
                trusted(value, directory=True)
                seals.append(directory_identity(value))
            return fd, components[-1], seals
        except BaseException:
            os.close(fd)
            raise

    def read(self, path, limit, *, executable=False):
        parent, leaf, parents = self.parent(path)
        try:
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                         dir_fd=parent)
            try:
                first = os.fstat(fd)
                trusted(first, executable=executable)
                check(first.st_size <= limit, 'EXECUTABLE_INVALID' if executable else 'PATH_INVALID')
                chunks, length = [], 0
                while True:
                    block = os.read(fd, min(1024**2, limit - length + 1))
                    if not block:
                        break
                    chunks.append(block)
                    length += len(block)
                    check(length <= limit, 'PATH_INVALID')
                raw = b''.join(chunks)
                last = os.fstat(fd)
                check(file_identity(first) == file_identity(last), 'RUNTIME_DRIFT')
                path_now = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                path_identity = file_identity
                if (type(self.root) is str and self.root == '/' and executable is False
                        and type(path) is str and re.fullmatch(r'/proc/[1-9][0-9]*/net/unix', path)):
                    path_identity = _proc_net_unix_path_identity
                check(path_identity(first) == path_identity(path_now), 'RUNTIME_DRIFT')
                if executable:
                    check(raw[:4] == b'\x7fELF' and length > 4, 'EXECUTABLE_INVALID')
                return raw, {'file': file_identity(first), 'parents': parents}
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def config(self):
        # Missing /etc/docker or daemon.json is observed and sealed, not evidence
        # that effective defaults are known. Symlink/non-root parents are rejected.
        etc, leaf, parents = self.parent('/etc/docker')
        try:
            try:
                child = os.stat(leaf, dir_fd=etc, follow_symlinks=False)
            except FileNotFoundError:
                return None, {'absent': 'DIRECTORY', 'parents': parents}
            trusted(child, directory=True)
        finally:
            os.close(etc)
        try:
            return self.read(CONFIG, 1024**2)
        except FileNotFoundError:
            parent, _, parents = self.parent(CONFIG)
            os.close(parent)
            return None, {'absent': 'FILE', 'parents': parents}

    def process_executable(self, pid, installed):
        path = '/proc/' + str(pid) + '/exe'
        parent, leaf, parents = self.parent(path)
        try:
            link = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            check(stat.S_ISLNK(link.st_mode) and _root_owned(link), 'EXECUTABLE_INVALID')
            # Explicit exception for this kernel symlink only. Never normalize,
            # strip '(deleted)', accept an arbitrary alias or follow caller paths.
            check(os.readlink(leaf, dir_fd=parent) == EXECUTABLE, 'EXECUTABLE_INVALID')
            fd = self._open_kernel_executable(parent, leaf)
            try:
                first = os.fstat(fd)
                trusted(first, executable=True)
                check(file_identity(first) == tuple(installed['file']), 'EXECUTABLE_INVALID')
                check(first.st_size <= 128 * 1024**2, 'EXECUTABLE_INVALID')
                value, length, prefix = hashlib.sha256(), 0, b''
                for block in iter(lambda: os.read(fd, 1024**2), b''):
                    prefix = (prefix + block)[:4]
                    length += len(block)
                    check(length <= 128 * 1024**2, 'EXECUTABLE_INVALID')
                    value.update(block)
                check(prefix == b'\x7fELF', 'EXECUTABLE_INVALID')
                check(file_identity(first) == file_identity(os.fstat(fd)), 'RUNTIME_DRIFT')
                check(os.readlink(leaf, dir_fd=parent) == EXECUTABLE and
                      file_identity(link) == file_identity(os.stat(leaf, dir_fd=parent,
                                                                   follow_symlinks=False)), 'RUNTIME_DRIFT')
                return value.hexdigest(), {'target': file_identity(first),
                    'link': file_identity(link), 'parents': parents}
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def _open_kernel_executable(self, parent, leaf):
        return os.open(leaf, os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)


def _reader_factory():
    return _Reader()


def service_pid(d):
    raw = d.run(*SYSTEMCTL, timeout=30, env=dict(COLLECTION_ENV))
    check(isinstance(raw, str) and 0 < len(raw) <= 256, 'SERVICE_INVALID')
    rows = {}
    for line in raw.strip().splitlines():
        key, separator, value = line.partition('=')
        check(separator and key in ('MainPID', 'ActiveState', 'SubState') and key not in rows,
              'SERVICE_INVALID')
        rows[key] = value
    check(set(rows) == {'MainPID', 'ActiveState', 'SubState'} and rows['ActiveState'] == 'active'
          and rows['SubState'] == 'running' and re.fullmatch(r'[1-9][0-9]{0,9}', rows['MainPID']),
          'SERVICE_INVALID')
    return int(rows['MainPID'])


def process(reader, pid):
    raw, status_seal = reader.read('/proc/' + str(pid) + '/status', 128 * 1024)
    try:
        lines = raw.decode('ascii').splitlines()
        uids = [line.split()[1:] for line in lines if line.startswith('Uid:')]
        names = [line.split()[1:] for line in lines if line.startswith('Name:')]
        check(uids == [['0', '0', '0', '0']] and names == [['dockerd']], 'PROCESS_INVALID')
        raw, stat_seal = reader.read('/proc/' + str(pid) + '/stat', 16 * 1024)
        text = raw.decode('ascii')
        right = text.rfind(')')
        check(text[:text.find('(')] == str(pid) + ' ' and text[text.find('('):right + 1] == '(dockerd)',
              'PROCESS_INVALID')
        fields = text[right + 1:].split()
        check(len(fields) >= 20 and fields[0] not in ('Z', 'X', 'x') and
              re.fullmatch(r'[1-9][0-9]{0,19}', fields[19]), 'PROCESS_INVALID')
        start = fields[19]
    except (UnicodeError, IndexError):
        raise Rejected('PROCESS_INVALID') from None
    # Proc stat/status bytes may change CPU counters; seal authority fields only.
    return {'pid': pid, 'starttime': start, 'root': True,
            'procParents': stat_seal['parents'], 'statusParents': status_seal['parents']}


def pool(base, size, code):
    check(isinstance(base, str) and type(size) is int, code)
    try:
        network = ipaddress.ip_network(base, strict=True)
    except (ValueError, TypeError):
        raise Rejected(code) from None
    check(str(network) == base and network.prefixlen <= size <= network.max_prefixlen, code)
    return {'base': base, 'size': size}


def arguments(raw):
    check(raw.endswith(b'\0') and 0 < len(raw) <= 128 * 1024, 'CMDLINE_INVALID')
    try:
        args = raw[:-1].decode('utf-8').split('\0')
    except UnicodeError:
        raise Rejected('CMDLINE_INVALID') from None
    check(len(args) <= 256 and args[0] == EXECUTABLE and all(args), 'CMDLINE_INVALID')
    configs, pools, index = [], [], 1
    while index < len(args):
        argument = args[index]
        for flag in ('--config-file', '--default-address-pool'):
            if argument == flag or argument.startswith(flag + '='):
                if argument == flag:
                    index += 1
                    check(index < len(args), 'CMDLINE_INVALID')
                    value = args[index]
                else:
                    value = argument[len(flag) + 1:]
                if flag == '--config-file':
                    check(value == CONFIG and not configs, 'CMDLINE_INVALID')
                    configs.append(value)
                else:
                    match = re.fullmatch(r'base=([^,]{1,64}),size=([0-9]{1,3})', value)
                    check(match is not None, 'CMDLINE_INVALID')
                    pools.append(pool(match[1], int(match[2]), 'CMDLINE_INVALID'))
                break
        else:
            # Unknown values are never projected, not even an error suffix.
            check(not argument.startswith(('--config-file', '--default-address-pool')),
                  'CMDLINE_INVALID')
        index += 1
    check(len(pools) <= 32 and len({fingerprint(row) for row in pools}) == len(pools), 'CMDLINE_INVALID')
    return {'sha256': digest(raw), 'argumentCount': len(args),
            'configFileEncoding': 'EXPLICIT_FIXED' if configs else 'DEFAULT_FIXED',
            'defaultAddressPoolCount': len(pools),
            'defaultAddressPoolSha256': fingerprint(pools)}


def configuration(raw, seal):
    if raw is None:
        return {'status': 'ABSENT', 'sourceSha256': fingerprint(seal),
                'defaultAddressPoolsEncoding': 'ABSENT', 'defaultAddressPoolCount': 0,
                'defaultAddressPoolSha256': fingerprint(None), 'effectiveRulesStatus': 'SOURCE_NOT_MEASURED'}
    def pairs(rows):
        values = {}
        for key, value in rows:
            check(key not in values, 'CONFIG_INVALID')
            values[key] = value
        return values
    try:
        data = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Rejected('CONFIG_INVALID')))
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected('CONFIG_INVALID') from None
    check(isinstance(data, dict) and len(data) <= 256, 'CONFIG_INVALID')
    present = 'default-address-pools' in data
    rows = data.get('default-address-pools')
    check(not present or isinstance(rows, list) and len(rows) <= 32, 'CONFIG_INVALID')
    pools = []
    for row in rows or []:
        check(isinstance(row, dict) and set(row) == {'base', 'size'}, 'CONFIG_INVALID')
        pools.append(pool(row['base'], row['size'], 'CONFIG_INVALID'))
    check(len({fingerprint(row) for row in pools}) == len(pools), 'CONFIG_INVALID')
    return {'status': 'OBSERVED', 'sourceSha256': fingerprint({'identity': seal, 'bytes': digest(raw)}),
            'defaultAddressPoolsEncoding': 'ARRAY' if present else 'ABSENT',
            'defaultAddressPoolCount': len(pools), 'defaultAddressPoolSha256': fingerprint(pools if present else None),
            'effectiveRulesStatus': 'SOURCE_NOT_MEASURED'}


def package(d, binary_sha):
    raw = d.run(*RPM, timeout=30, env=dict(COLLECTION_ENV))
    check(isinstance(raw, str) and 0 < len(raw.encode()) <= 1024**2, 'PACKAGE_INVALID')
    lines = raw.strip().splitlines()
    fields = lines[0].split('|')
    check(len(fields) == 7, 'PACKAGE_INVALID')
    name, epoch, version, release, architecture, source, algorithm = fields
    check(name in PACKAGE_NAMES and re.fullmatch(r'[0-9]{1,8}', epoch) and
          re.fullmatch(r'[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}', version) and
          re.fullmatch(r'[0-9][a-z0-9._]{0,95}', release) and
          architecture in ('x86_64', 'aarch64') and source == name + '-' + version + '-' + release + '.src.rpm',
          'PACKAGE_INVALID')
    check(algorithm == '8', 'PACKAGE_DIGEST_UNSUPPORTED')
    check(len(lines) <= 8192, 'PACKAGE_INVALID')
    selected = []
    for line in lines[1:]:
        parts = line.split('|')
        check(len(parts) == 2, 'PACKAGE_INVALID')
        if parts[0] == EXECUTABLE:
            selected.append(parts[1])
    check(len(selected) == 1 and HEX.fullmatch(selected[0]), 'PACKAGE_INVALID')
    check(selected[0] == binary_sha, 'PACKAGE_BINARY_MISMATCH')
    nevra = {'name': name, 'epoch': epoch, 'version': version, 'release': release, 'architecture': architecture}
    return {'name': name, 'nevraSha256': fingerprint(nevra), 'sourceRpmSha256': digest(source.encode()),
            'fileDigestAlgorithm': 'SHA256', 'fileDigest': selected[0],
            'querySha256': digest(raw.encode()), 'signatureStatus': 'NOT_MEASURED',
            'sourceRpmRetrieved': False, 'patchesStatus': 'NOT_MEASURED'}


def snapshot(d, reader):
    tools = {}
    for path in (SYSTEMCTL[0], RPM[0]):
        raw, identity = reader.read(path, 128 * 1024**2, executable=True)
        tools[path] = {'bytesSha256': digest(raw), 'identity': identity}
    pid = service_pid(d)
    proc = process(reader, pid)
    installed_bytes, installed = reader.read(EXECUTABLE, 128 * 1024**2, executable=True)
    binary_sha = digest(installed_bytes)
    running_sha, running = reader.process_executable(pid, installed)
    check(running_sha == binary_sha, 'EXECUTABLE_INVALID')
    cmdline, cmdline_seal = reader.read('/proc/' + str(pid) + '/cmdline', 128 * 1024)
    args = arguments(cmdline)
    config_bytes, config_seal = reader.config()
    config = configuration(config_bytes, config_seal)
    check(args['configFileEncoding'] != 'EXPLICIT_FIXED' or config['status'] == 'OBSERVED', 'CONFIG_INVALID')
    rpm = package(d, binary_sha)
    # Finish each observation by rechecking process lifetime and service authority.
    check(service_pid(d) == pid and process(reader, pid) == proc, 'RUNTIME_DRIFT')
    return {'process': proc, 'binarySha256': binary_sha, 'installed': installed,
            'running': running, 'args': args, 'cmdlineIdentity': cmdline_seal,
            'config': config, 'package': rpm, 'tools': tools}


def runtime_daemon_identity(d):
    """Actual runtime-bound safe report; no generator eligibility or proof.

    Requires root-protected known Linux files and the fixed docker systemd unit.
    Any unreadable/unsupported platform fails with a fixed code. Two full reads
    bind PID/starttime, executable inode+bytes, cmdline, config and installed RPM.
    """
    try:
        reader = _reader_factory()
        first = snapshot(d, reader)
        last = snapshot(d, reader)
        check(first == last, 'RUNTIME_DRIFT')
        value = {'version': 1, 'kind': 'DOCKERD_RUNTIME_IDENTITY', 'status': 'RUNTIME_BOUND',
            'authority': False, 'productionEligible': False, 'proofConstructed': False,
            'rawOutputSuppressed': True, 'runtime': {
                'pidSha256': digest(str(first['process']['pid']).encode()),
                'starttimeSha256': digest(first['process']['starttime'].encode()),
                'processSha256': fingerprint(first['process']),
                'binarySha256': first['binarySha256'], 'executableIdentitySha256': fingerprint(first['running']),
                'collectionToolsSha256': fingerprint(first['tools']),
                'installedIdentitySha256': fingerprint(first['installed']),
                'runtimeIdentitySha256': fingerprint(first), 'executablePathKind': 'FIXED_USR_BIN_DOCKERD',
                'rootIdentity': 'OBSERVED_ROOT', 'installedBinding': 'SAME_INODE_AND_SHA256'},
            'cmdline': first['args'], 'configuration': first['config'], 'package': first['package'],
            'effectivePoolRulesStatus': 'SOURCE_NOT_MEASURED'}
        return validate_runtime_identity(value)
    except Rejected as error:
        # A controller/test double may itself raise this type. Never trust its
        # dynamic message or attached exception context as a permitted code.
        code = str(error)
        raise Rejected(code if code in CODES else 'RUNTIME_UNAVAILABLE') from None
    except Exception:
        raise Rejected('RUNTIME_UNAVAILABLE') from None


def validate_runtime_identity(value):
    check(isinstance(value, dict) and set(value) == {'version', 'kind', 'status', 'authority',
        'productionEligible', 'proofConstructed', 'rawOutputSuppressed', 'runtime', 'cmdline',
        'configuration', 'package', 'effectivePoolRulesStatus'}, 'REPORT_INVALID')
    check(type(value['version']) is int and value['version'] == 1 and value['kind'] == 'DOCKERD_RUNTIME_IDENTITY'
          and value['status'] == 'RUNTIME_BOUND' and all(value[key] is False for key in
              ('authority', 'productionEligible', 'proofConstructed')) and value['rawOutputSuppressed'] is True
          and value['effectivePoolRulesStatus'] == 'SOURCE_NOT_MEASURED', 'REPORT_INVALID')
    schemas = {
        'runtime': {'pidSha256', 'starttimeSha256', 'processSha256', 'binarySha256',
            'executableIdentitySha256', 'installedIdentitySha256', 'runtimeIdentitySha256', 'collectionToolsSha256',
            'executablePathKind', 'rootIdentity', 'installedBinding'},
        'cmdline': {'sha256', 'argumentCount', 'configFileEncoding', 'defaultAddressPoolCount', 'defaultAddressPoolSha256'},
        'configuration': {'status', 'sourceSha256', 'defaultAddressPoolsEncoding', 'defaultAddressPoolCount',
            'defaultAddressPoolSha256', 'effectiveRulesStatus'},
        'package': {'name', 'nevraSha256', 'sourceRpmSha256', 'fileDigestAlgorithm', 'fileDigest', 'querySha256',
            'signatureStatus', 'sourceRpmRetrieved', 'patchesStatus'}}
    for name, keys in schemas.items():
        row = value[name]
        check(isinstance(row, dict) and set(row) == keys, 'REPORT_INVALID')
        for key, item in row.items():
            if key.endswith('Sha256') or key in ('sha256', 'fileDigest'):
                check(isinstance(item, str) and HEX.fullmatch(item), 'REPORT_INVALID')
    runtime, args, config, rpm = (value[key] for key in ('runtime', 'cmdline', 'configuration', 'package'))
    check(runtime['executablePathKind'] == 'FIXED_USR_BIN_DOCKERD' and runtime['rootIdentity'] == 'OBSERVED_ROOT'
          and runtime['installedBinding'] == 'SAME_INODE_AND_SHA256', 'REPORT_INVALID')
    check(type(args['argumentCount']) is int and 1 <= args['argumentCount'] <= 256 and
          args['configFileEncoding'] in ('DEFAULT_FIXED', 'EXPLICIT_FIXED'), 'REPORT_INVALID')
    for row in (args, config):
        check(type(row['defaultAddressPoolCount']) is int and 0 <= row['defaultAddressPoolCount'] <= 32,
              'REPORT_INVALID')
    check(config['status'] in ('ABSENT', 'OBSERVED') and config['defaultAddressPoolsEncoding'] in ('ABSENT', 'ARRAY')
          and config['effectiveRulesStatus'] == 'SOURCE_NOT_MEASURED' and
          (config['status'] != 'ABSENT' or config['defaultAddressPoolsEncoding'] == 'ABSENT') and
          (config['defaultAddressPoolsEncoding'] != 'ABSENT' or config['defaultAddressPoolCount'] == 0), 'REPORT_INVALID')
    check(rpm['name'] in PACKAGE_NAMES and rpm['fileDigestAlgorithm'] == 'SHA256' and
          rpm['fileDigest'] == runtime['binarySha256'] and rpm['signatureStatus'] == 'NOT_MEASURED' and
          rpm['sourceRpmRetrieved'] is False and rpm['patchesStatus'] == 'NOT_MEASURED', 'REPORT_INVALID')
    return value
