#!/usr/bin/env python3
"""Fixed Unix endpoint to the runtime-bound systemd daemon, without connecting.

Socket activation may leave systemd holding the same listener. This capability
proves dockerd holds it, not exclusive ownership or SO_PEERCRED creation identity.
The caller's controlled client must hard-code UNIX_HOST and check before/after.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

UNIX_HOST = 'unix:///var/run/docker.sock'
SOCKET = '/run/docker.sock'
BASE_SHA = '32d4b45c936685ffc46a876007796027bb8f9ef7f5ac43ca8b243c05c9b23b4f'
HEX = re.compile(r'[a-f0-9]{64}\Z')
CODES = frozenset(('SOCKET_BINDING_UNAVAILABLE', 'SOCKET_PATH_INVALID', 'SOCKET_PERMISSIONS_INVALID',
    'PROC_ALIAS_INVALID', 'NAMESPACE_MISMATCH', 'LISTENER_INVALID', 'DAEMON_FD_MISSING',
    'FD_INVALID', 'SOCKET_BINDING_DRIFT', 'BASE_SOURCE_UNMEASURED', 'BINDING_REPORT_INVALID',
    'RUNTIME_UNAVAILABLE', 'SERVICE_INVALID', 'PATH_INVALID', 'PERMISSIONS_INVALID', 'PROCESS_INVALID',
    'EXECUTABLE_INVALID', 'RUNTIME_DRIFT', 'CMDLINE_INVALID', 'CONFIG_INVALID', 'PACKAGE_INVALID',
    'PACKAGE_DIGEST_UNSUPPORTED', 'PACKAGE_BINARY_MISMATCH', 'REPORT_INVALID'))


class Rejected(RuntimeError):
    pass


def check(condition, code):
    if not condition:
        raise Rejected(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def _base():
    # Fixed frozen capability; no caller path/module/identity claims.
    path = Path(__file__).with_name('online-recharge-daemon-identity.py')
    check(path.is_file() and not path.is_symlink(), 'BASE_SOURCE_UNMEASURED')
    source = path.read_bytes()
    check(sha(source) == BASE_SHA,
          'BASE_SOURCE_UNMEASURED')
    spec = importlib.util.spec_from_file_location('_socket_bound_identity', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


def kernel_link(base, reader, path, pattern):
    parent, leaf, parents = reader.parent(path)
    try:
        first = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        check(stat.S_ISLNK(first.st_mode) and base._root_owned(first), 'PROC_ALIAS_INVALID')
        text = os.readlink(leaf, dir_fd=parent)
        match = re.fullmatch(pattern, text)
        check(match is not None, 'PROC_ALIAS_INVALID')
        check(base.file_identity(first) == base.file_identity(os.stat(leaf, dir_fd=parent,
                                                                    follow_symlinks=False)) and
              text == os.readlink(leaf, dir_fd=parent), 'SOCKET_BINDING_DRIFT')
        return match, {'link': base.file_identity(first), 'parents': parents}
    finally:
        os.close(parent)


def node(base, reader):
    parent, leaf, parents = reader.parent(SOCKET)
    try:
        item = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        check(stat.S_ISSOCK(item.st_mode) and item.st_nlink == 1, 'SOCKET_PATH_INVALID')
        # docker group access 0660 is legitimate; any world access is rejected.
        check(base._root_owned(item) and stat.S_IMODE(item.st_mode) in (0o600, 0o660), 'SOCKET_PERMISSIONS_INVALID')
        socket_seal = {'file': base.file_identity(item), 'parents': parents}
        target_directory = os.fstat(parent)
    finally:
        os.close(parent)
    parent, leaf, parents = reader.parent('/var/run')
    try:
        alias = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        check(stat.S_ISLNK(alias.st_mode) and base._root_owned(alias), 'SOCKET_PATH_INVALID')
        check(os.readlink(leaf, dir_fd=parent) in ('/run', '../run'), 'SOCKET_PATH_INVALID')
        # Only the known parent alias is followed, never a leaf socket link.
        followed = reader._follow_run_alias(parent, leaf)
        check(base.directory_identity(followed) == base.directory_identity(target_directory), 'SOCKET_PATH_INVALID')
        check(base.file_identity(alias) == base.file_identity(os.stat(leaf, dir_fd=parent,
                                                                    follow_symlinks=False)), 'SOCKET_BINDING_DRIFT')
        return {'node': socket_seal, 'alias': {'link': base.file_identity(alias), 'parents': parents}}
    finally:
        os.close(parent)


def proc_namespace(base, reader, pid):
    # /proc/net -> self/net and /proc/self -> current PID are explicit kernel
    # aliases; safe directory traversal uses numeric PID instead of following them.
    match, net_alias = kernel_link(base, reader, '/proc/net', r'self/net')
    match, self_alias = kernel_link(base, reader, '/proc/self', r'([1-9][0-9]{0,9})')
    self_pid = int(match[1])
    check(self_pid == reader._collector_pid(), 'PROC_ALIAS_INVALID')
    current, current_seal = kernel_link(base, reader, '/proc/' + str(self_pid) + '/ns/net', r'net:\[([1-9][0-9]{0,19})\]')
    daemon, daemon_seal = kernel_link(base, reader, '/proc/' + str(pid) + '/ns/net', r'net:\[([1-9][0-9]{0,19})\]')
    check(current[1] == daemon[1], 'NAMESPACE_MISMATCH')
    # Kernel namespace magic links are allowed only for these exact two paths.
    for path in ('/proc/' + str(self_pid) + '/ns/net', '/proc/' + str(pid) + '/ns/net'):
        followed = reader._follow_namespace(path)
        check(followed.st_ino == int(current[1]) and base._root_owned(followed), 'NAMESPACE_MISMATCH')
    return self_pid, {'namespaceInode': current[1], 'collector': current_seal,
        'daemon': daemon_seal, 'netAlias': net_alias, 'selfAlias': self_alias}


def listener(raw):
    check(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024**2, 'LISTENER_INVALID')
    try:
        lines = raw.decode('utf-8').splitlines()
    except UnicodeError:
        raise Rejected('LISTENER_INVALID') from None
    check(lines and lines[0].split() == ['Num', 'RefCount', 'Protocol', 'Flags', 'Type', 'St', 'Inode', 'Path'],
          'LISTENER_INVALID')
    selected = []
    for line in lines[1:]:
        fields = line.split(maxsplit=7)
        check(len(fields) in (7, 8), 'LISTENER_INVALID')
        # Accepted stream sockets inherit the path; only SO_ACCEPTCON is a listener.
        if len(fields) == 8 and fields[7] in ('/run/docker.sock', '/var/run/docker.sock') and fields[3] == '00010000':
            selected.append(fields)
    check(len(selected) == 1, 'LISTENER_INVALID')
    fields = selected[0]
    check(re.fullmatch(r'[a-fA-F0-9]{8,16}:', fields[0]) and
          re.fullmatch(r'[a-fA-F0-9]{8}', fields[1]) and fields[2] == '00000000' and
          fields[3] == '00010000' and fields[4] == '0001' and fields[5] == '01' and
          re.fullmatch(r'[1-9][0-9]{0,19}', fields[6]), 'LISTENER_INVALID')
    # RefCount and Num may change independently. They are not object authority.
    return {'kernelInode': fields[6], 'pathKind': 'RUN' if fields[7] == SOCKET else 'VAR_RUN',
            'protocol': fields[2], 'flags': fields[3], 'type': fields[4], 'state': fields[5]}


def daemon_fds(base, reader, pid, inode):
    parent, leaf, parents = reader.parent('/proc/' + str(pid) + '/fd')
    directory = None
    try:
        directory = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        identity = os.fstat(directory)
        base.trusted(identity, directory=True)
        names = os.listdir(directory)
        check(len(names) <= 4096 and all(re.fullmatch(r'[0-9]{1,7}', name) for name in names), 'FD_INVALID')
        selected = []
        for name in sorted(names, key=int):
            first = os.stat(name, dir_fd=directory, follow_symlinks=False)
            check(stat.S_ISLNK(first.st_mode) and base._root_owned(first), 'FD_INVALID')
            text = os.readlink(name, dir_fd=directory)
            if text != 'socket:[' + inode + ']':
                continue
            followed = reader._follow_socket_fd(directory, name)
            check(stat.S_ISSOCK(followed.st_mode) and followed.st_ino == int(inode) and
                  base._root_owned(followed), 'FD_INVALID')
            check(text == os.readlink(name, dir_fd=directory) and
                  base.file_identity(first) == base.file_identity(os.stat(name, dir_fd=directory,
                                                                        follow_symlinks=False)), 'SOCKET_BINDING_DRIFT')
            selected.append({'fd': name, 'link': base.file_identity(first),
                             'socketIdentity': base.file_identity(followed)})
        check(1 <= len(selected) <= 8, 'DAEMON_FD_MISSING')
        return {'selected': selected, 'parents': parents, 'directory': base.directory_identity(identity)}
    finally:
        if directory is not None:
            os.close(directory)
        os.close(parent)


def _reader(base):
    class Reader(base._Reader):
        def _collector_pid(self):
            return os.getpid()

        def _follow_run_alias(self, parent, leaf):
            return os.stat(leaf, dir_fd=parent, follow_symlinks=True)

        def _follow_namespace(self, path):
            parent, leaf, _ = self.parent(path)
            try:
                return os.stat(leaf, dir_fd=parent, follow_symlinks=True)
            finally:
                os.close(parent)

        def _follow_socket_fd(self, parent, leaf):
            return os.stat(leaf, dir_fd=parent, follow_symlinks=True)
    return Reader()


def observation(d, base, reader, identity):
    pid = base.service_pid(d)
    check(sha(str(pid).encode()) == identity['runtime']['pidSha256'], 'SOCKET_BINDING_DRIFT')
    process = base.process(reader, pid)
    check(base.fingerprint(process) == identity['runtime']['processSha256'], 'SOCKET_BINDING_DRIFT')
    path = node(base, reader)
    self_pid, namespace = proc_namespace(base, reader, pid)
    raw, file_seal = reader.read('/proc/' + str(self_pid) + '/net/unix', 8 * 1024**2)
    row = listener(raw)
    fds = daemon_fds(base, reader, pid, row['kernelInode'])
    check(base.service_pid(d) == pid and base.process(reader, pid) == process, 'SOCKET_BINDING_DRIFT')
    return {'path': path, 'namespace': namespace, 'listener': row, 'fds': fds,
            'tableSourceParents': file_seal['parents']}


def runtime_daemon_socket_binding(d):
    """Two actual no-connect observations around the frozen identity capability.

    No caller-provided paths/hashes/booleans, actual Env or Docker/API connection.
    EngineID alone is never used. Unsupported links/schema/lifetimes fail closed.
    """
    try:
        base = _base()
        reader = _reader(base)
        first_identity = base.runtime_daemon_identity(d)
        first = observation(d, base, reader, first_identity)
        last_identity = base.runtime_daemon_identity(d)
        last = observation(d, base, reader, last_identity)
        check(first_identity == last_identity and first == last, 'SOCKET_BINDING_DRIFT')
        return validate_binding({'version': 1, 'kind': 'DOCKERD_FIXED_UNIX_SOCKET_BINDING',
            'status': 'LISTENER_HELD_BY_RUNTIME_DAEMON', 'authority': False, 'productionEligible': False,
            'proofConstructed': False, 'rawOutputSuppressed': True, 'unixHost': UNIX_HOST,
            'runtimeIdentity': first_identity, 'socketNodeSha256': fingerprint(first['path']),
            'networkNamespaceSha256': fingerprint(first['namespace']), 'listenerSha256': fingerprint(first['listener']),
            'daemonFdSha256': fingerprint(first['fds']), 'observationSha256': fingerprint(first),
            'daemonListenerFdCount': len(first['fds']['selected']), 'listenerRowCount': 1,
            'socketActivationCreatorStatus': 'NOT_MEASURED', 'exclusiveAcceptingProcessStatus': 'NOT_MEASURED'})
    except Exception as error:
        code = str(error) if isinstance(error, (Rejected,)) else 'SOCKET_BINDING_UNAVAILABLE'
        # The base has its own fixed exception type; use its finite code only.
        if 'base' in locals() and isinstance(error, base.Rejected):
            code = str(error)
        raise Rejected(code if code in CODES else 'SOCKET_BINDING_UNAVAILABLE') from None


def validate_binding(value):
    fields = {'version', 'kind', 'status', 'authority', 'productionEligible', 'proofConstructed',
        'rawOutputSuppressed', 'unixHost', 'runtimeIdentity', 'socketNodeSha256', 'networkNamespaceSha256',
        'listenerSha256', 'daemonFdSha256', 'observationSha256', 'daemonListenerFdCount', 'listenerRowCount',
        'socketActivationCreatorStatus', 'exclusiveAcceptingProcessStatus'}
    check(isinstance(value, dict) and set(value) == fields, 'BINDING_REPORT_INVALID')
    check(type(value['version']) is int and value['version'] == 1 and
          value['kind'] == 'DOCKERD_FIXED_UNIX_SOCKET_BINDING' and value['status'] == 'LISTENER_HELD_BY_RUNTIME_DAEMON'
          and value['unixHost'] == UNIX_HOST and all(value[key] is False for key in
              ('authority', 'productionEligible', 'proofConstructed')) and value['rawOutputSuppressed'] is True,
          'BINDING_REPORT_INVALID')
    check(type(value['daemonListenerFdCount']) is int and 1 <= value['daemonListenerFdCount'] <= 8 and
          type(value['listenerRowCount']) is int and value['listenerRowCount'] == 1 and
          value['socketActivationCreatorStatus'] == 'NOT_MEASURED' and
          value['exclusiveAcceptingProcessStatus'] == 'NOT_MEASURED', 'BINDING_REPORT_INVALID')
    for key in ('socketNodeSha256', 'networkNamespaceSha256', 'listenerSha256', 'daemonFdSha256', 'observationSha256'):
        check(isinstance(value[key], str) and HEX.fullmatch(value[key]), 'BINDING_REPORT_INVALID')
    try:
        _base().validate_runtime_identity(value['runtimeIdentity'])
    except Exception:
        raise Rejected('BINDING_REPORT_INVALID') from None
    return value


def assert_same_binding(before, after):
    """For controlled_client's fixed-host per-call bracketing, not a caller bool."""
    validate_binding(before)
    validate_binding(after)
    check(before == after, 'SOCKET_BINDING_DRIFT')
    return before
