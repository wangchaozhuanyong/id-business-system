#!/usr/bin/env python3
"""Corrective v2: fixed VFS node equals runtime daemon's kernel Unix listener.

Exact NETLINK_SOCK_DIAG query, no Unix connect, Docker invocation, peer fallback,
caller path/hash/boolean, generator registration or publication authority.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import sys
import types

LISTENER_SHA = '0164c6f5c20a3aab24062e37c9931b216a4c29adfd1440002da5b8952147306a'
IDENTITY_SHA = '32d4b45c936685ffc46a876007796027bb8f9ef7f5ac43ca8b243c05c9b23b4f'
SOCK_DIAG = 20
AF_UNIX = 1
NETLINK_SOCK_DIAG = 4
NLM_F_REQUEST = 1
TCP_LISTEN = 10
SHOW_VFS_UID = 0x42
MAX_PACKET = 4096
NOCOOKIE = (0xffffffff, 0xffffffff)
HEADER = struct.Struct('=IHHII')
REQUEST = struct.Struct('=BBHIIIII')
RESPONSE = struct.Struct('=BBBBIII')
ATTR = struct.Struct('=HH')
HEX = re.compile('[a-f0-9]{64}\\Z')
CODES = frozenset(('VFS_SOURCE_UNMEASURED', 'VFS_DIAG_UNAVAILABLE', 'VFS_WIRE_INVALID',
    'VFS_QUERY_INVALID', 'VFS_NODE_MISMATCH', 'VFS_DRIFT', 'VFS_REPORT_INVALID',
    'VFS_BINDING_UNAVAILABLE'))


class Rejected(RuntimeError):
    pass


def need(ok, code):
    if not ok:
        raise Rejected(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())

# Runtime diagnostic-only candidate: fixed trusted dependencies, never str(error).
CODES = CODES | frozenset(('SOCKET_BINDING_UNAVAILABLE', 'SOCKET_PATH_INVALID', 'SOCKET_PERMISSIONS_INVALID', 'PROC_ALIAS_INVALID', 'NAMESPACE_MISMATCH', 'LISTENER_INVALID', 'DAEMON_FD_MISSING', 'FD_INVALID', 'SOCKET_BINDING_DRIFT', 'BASE_SOURCE_UNMEASURED', 'BINDING_REPORT_INVALID', 'RUNTIME_UNAVAILABLE', 'SERVICE_INVALID', 'PATH_INVALID', 'PERMISSIONS_INVALID', 'PROCESS_INVALID', 'EXECUTABLE_INVALID', 'RUNTIME_DRIFT', 'CMDLINE_INVALID', 'CONFIG_INVALID', 'PACKAGE_INVALID', 'PACKAGE_DIGEST_UNSUPPORTED', 'PACKAGE_BINARY_MISMATCH', 'REPORT_INVALID'))
DIAGNOSTIC_PHASES = frozenset(('START', 'SOURCE_LISTENER', 'SOURCE_IDENTITY', 'READER', 'IDENTITY_FIRST', 'OBSERVATION_FIRST', 'QUERY_FIRST', 'NODE_FIRST', 'IDENTITY_SECOND', 'OBSERVATION_SECOND', 'QUERY_SECOND', 'NODE_SECOND', 'STABILITY', 'LISTENER_REPORT', 'REPORT'))

def _fixed_error_code(error, module, base):
    owned = (Rejected,)
    if module is not None:
        owned += (module.Rejected,)
    if base is not None:
        owned += (base.Rejected,)
    if type(error) not in owned:
        return 'VFS_BINDING_UNAVAILABLE'
    values = BaseException.args.__get__(error, type(error))
    return values[0] if (type(values) is tuple and len(values) == 1 and type(values[0]) is str and values[0] in CODES) else 'VFS_BINDING_UNAVAILABLE'


def _listener():
    path = Path(__file__).with_name('online-recharge-daemon-listener.py')
    need(path.is_file() and not path.is_symlink(), 'VFS_SOURCE_UNMEASURED')
    raw = path.read_bytes()
    need(sha(raw) == LISTENER_SHA, 'VFS_SOURCE_UNMEASURED')
    # Execute the measured bytes, rather than reopening a path after its seal.
    module = types.ModuleType('_vfs_fixed_listener')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    need(module.BASE_SHA == IDENTITY_SHA, 'VFS_SOURCE_UNMEASURED')
    return module


def kernel_device(device):
    # unix_diag.c exports s_dev directly, not new_encode_dev/stat.st_dev.
    major, minor = os.major(device), os.minor(device)
    need(0 <= major < 4096 and 0 <= minor < 2**20, 'VFS_QUERY_INVALID')
    return (major << 20) | minor


def query_bytes(inode, sequence, port, cookie=NOCOOKIE):
    need(type(inode) is int and 0 < inode < 2**32 and type(sequence) is int and
         0 < sequence < 2**32 and type(port) is int and 0 < port < 2**32 and
         type(cookie) is tuple and len(cookie) == 2 and all(type(v) is int and 0 <= v < 2**32 for v in cookie),
         'VFS_QUERY_INVALID')
    body = REQUEST.pack(AF_UNIX, 0, 0, 1 << TCP_LISTEN, inode, SHOW_VFS_UID, *cookie)
    return HEADER.pack(HEADER.size + len(body), SOCK_DIAG, NLM_F_REQUEST, sequence, port) + body


def decode_packet(raw, *, sequence, port, inode, expected_cookie=None):
    need(type(raw) is bytes and HEADER.size <= len(raw) <= MAX_PACKET, 'VFS_WIRE_INVALID')
    length, kind, flags, observed_sequence, observed_port = HEADER.unpack_from(raw)
    # recvmsg sender PID must be kernel 0 (below); exact-query nlmsg_pid is the
    # destination port copied by sk_diag_fill, NOT assumed to be 0.
    need(length == len(raw) and observed_sequence == sequence and observed_port == port and flags == 0,
         'VFS_WIRE_INVALID')
    if kind == 2:
        need(length >= 20, 'VFS_WIRE_INVALID')
        raise Rejected('VFS_DIAG_UNAVAILABLE')
    need(kind == SOCK_DIAG and len(raw) >= HEADER.size + RESPONSE.size, 'VFS_WIRE_INVALID')
    family, sock_type, state, pad, observed_inode, c0, c1 = RESPONSE.unpack_from(raw, HEADER.size)
    cookie = (c0, c1)
    need(family == AF_UNIX and sock_type == 1 and state == TCP_LISTEN and pad == 0 and
         observed_inode == inode and cookie != NOCOOKIE, 'VFS_WIRE_INVALID')
    need(expected_cookie is None or cookie == expected_cookie, 'VFS_DRIFT')
    rows = {}
    offset = HEADER.size + RESPONSE.size
    while offset < len(raw):
        need(offset + ATTR.size <= len(raw), 'VFS_WIRE_INVALID')
        size, attr_type = ATTR.unpack_from(raw, offset)
        end = offset + size
        aligned = offset + ((size + 3) & ~3)
        need(size >= ATTR.size and end <= len(raw) and aligned <= len(raw) and
             attr_type in (1, 6, 7) and attr_type not in rows and
             raw[end:aligned] == b'\0' * (aligned - end), 'VFS_WIRE_INVALID')
        rows[attr_type] = raw[offset + ATTR.size:end]
        offset = aligned
    need(set(rows) == {1, 6, 7} and len(rows[1]) == 8 and rows[6] == b'\0' and
         len(rows[7]) == 4 and struct.unpack('=I', rows[7])[0] == 0, 'VFS_WIRE_INVALID')
    vfs_inode, vfs_device = struct.unpack('=II', rows[1])
    need(vfs_inode != 0, 'VFS_WIRE_INVALID')
    return {'family': family, 'type': sock_type, 'state': state, 'kernelInode': inode,
            'cookie': cookie, 'vfsInode': vfs_inode, 'vfsDevice': vfs_device, 'uid': 0, 'shutdown': 0}


def _netlink_socket():
    need(sys.platform == 'linux' and os.geteuid() == 0 and hasattr(socket, 'AF_NETLINK'),
         'VFS_DIAG_UNAVAILABLE')
    return socket.socket(socket.AF_NETLINK, socket.SOCK_RAW | socket.SOCK_CLOEXEC, NETLINK_SOCK_DIAG)


def _sequence():
    return secrets.randbelow(2**32 - 1) + 1


def kernel_query(inode, cookie=None):
    sock = None
    try:
        sock = _netlink_socket()
        sock.settimeout(3)
        sock.bind((0, 0))
        local = sock.getsockname()
        need(type(local) is tuple and len(local) == 2 and type(local[0]) is int and
             0 < local[0] < 2**32 and type(local[1]) is int and local[1] == 0, 'VFS_QUERY_INVALID')
        sequence = _sequence()
        request = query_bytes(inode, sequence, local[0], NOCOOKIE if cookie is None else cookie)
        need(sock.sendto(request, (0, 0)) == len(request), 'VFS_DIAG_UNAVAILABLE')
        packet, ancillary, flags, sender = sock.recvmsg(MAX_PACKET, 0)
        need(type(ancillary) is list and ancillary == [] and type(flags) is int and flags == 0 and
             type(sender) is tuple and len(sender) == 2 and all(type(v) is int for v in sender) and
             sender == (0, 0), 'VFS_WIRE_INVALID')
        return decode_packet(packet, sequence=sequence, port=local[0], inode=inode, expected_cookie=cookie)
    except Rejected as error:
        raise Rejected(str(error) if str(error) in CODES else 'VFS_DIAG_UNAVAILABLE') from None
    except Exception:
        raise Rejected('VFS_DIAG_UNAVAILABLE') from None
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def check_node(observation, wire):
    file = observation['path']['node']['file']
    need(len(file) == 9 and type(file[0]) is int and type(file[1]) is int and 0 < file[1] < 2**32,
         'VFS_QUERY_INVALID')
    need(int(observation['listener']['kernelInode']) == wire['kernelInode'] and
         wire['vfsInode'] == file[1] and wire['vfsDevice'] == kernel_device(file[0]), 'VFS_NODE_MISMATCH')


def listener_report(module, identity, observed):
    # Same derived schema as frozen37, sourced from this exact observation.
    return module.validate_binding({'version': 1, 'kind': 'DOCKERD_FIXED_UNIX_SOCKET_BINDING',
        'status': 'LISTENER_HELD_BY_RUNTIME_DAEMON', 'authority': False, 'productionEligible': False,
        'proofConstructed': False, 'rawOutputSuppressed': True, 'unixHost': module.UNIX_HOST,
        'runtimeIdentity': identity, 'socketNodeSha256': module.fingerprint(observed['path']),
        'networkNamespaceSha256': module.fingerprint(observed['namespace']),
        'listenerSha256': module.fingerprint(observed['listener']), 'daemonFdSha256': module.fingerprint(observed['fds']),
        'observationSha256': module.fingerprint(observed), 'daemonListenerFdCount': len(observed['fds']['selected']),
        'listenerRowCount': 1, 'socketActivationCreatorStatus': 'NOT_MEASURED',
        'exclusiveAcceptingProcessStatus': 'NOT_MEASURED'})


def runtime_daemon_socket_binding(d):
    module = base = None
    phase = 'START'
    try:
        phase = 'SOURCE_LISTENER'
        module = _listener()
        phase = 'SOURCE_IDENTITY'
        base = module._base()
        phase = 'READER'
        reader = module._reader(base)
        phase = 'IDENTITY_FIRST'
        identity = base.runtime_daemon_identity(d)
        phase = 'OBSERVATION_FIRST'
        first = module.observation(d, base, reader, identity)
        inode = int(first['listener']['kernelInode'])
        phase = 'QUERY_FIRST'
        one = kernel_query(inode)
        phase = 'NODE_FIRST'
        check_node(first, one)
        phase = 'IDENTITY_SECOND'
        final_identity = base.runtime_daemon_identity(d)
        phase = 'OBSERVATION_SECOND'
        second = module.observation(d, base, reader, final_identity)
        phase = 'QUERY_SECOND'
        two = kernel_query(inode, one['cookie'])
        phase = 'NODE_SECOND'
        check_node(second, two)
        phase = 'STABILITY'
        need(identity == final_identity and first == second and one == two and
             module.node(base, reader) == second['path'], 'VFS_DRIFT')
        phase = 'LISTENER_REPORT'
        legacy = listener_report(module, identity, first)
        phase = 'REPORT'
        return validate_binding({'version': 2, 'kind': 'DOCKERD_FIXED_UNIX_VFS_BINDING',
            'status': 'VFS_BOUND_TO_RUNTIME_DAEMON', 'authority': False, 'productionEligible': False,
            'proofConstructed': False, 'rawOutputSuppressed': True, 'unixHost': module.UNIX_HOST,
            'listenerBinding': legacy, 'vfsBinding': {
                'protocol': 'AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS', 'status': 'EXACT_VFS_MATCH',
                'kernelSocketInodeSha256': digest(inode), 'vfsInodeSha256': digest(one['vfsInode']),
                'vfsDeviceSha256': digest(one['vfsDevice']), 'kernelCookieSha256': digest(one['cookie']),
                'vfsIdentitySha256': digest({'inode': one['vfsInode'], 'device': one['vfsDevice']}),
                'nodeIdentitySha256': digest(first['path']['node']), 'responseIdentitySha256': digest(one)}})
    except Exception as error:
        code = _fixed_error_code(error, module, base)
        result = Rejected(code)
        result.diagnostic_phase = phase if phase in DIAGNOSTIC_PHASES else 'START'
        raise result from None


def validate_binding(value):
    fields = {'version', 'kind', 'status', 'authority', 'productionEligible', 'proofConstructed',
              'rawOutputSuppressed', 'unixHost', 'listenerBinding', 'vfsBinding'}
    need(type(value) is dict and set(value) == fields and type(value['version']) is int and value['version'] == 2,
         'VFS_REPORT_INVALID')
    need(value['kind'] == 'DOCKERD_FIXED_UNIX_VFS_BINDING' and value['status'] == 'VFS_BOUND_TO_RUNTIME_DAEMON'
         and value['unixHost'] == 'unix:///var/run/docker.sock' and all(value[k] is False for k in
             ('authority', 'productionEligible', 'proofConstructed')) and value['rawOutputSuppressed'] is True,
         'VFS_REPORT_INVALID')
    row = value['vfsBinding']
    hashes = {'kernelSocketInodeSha256', 'vfsInodeSha256', 'vfsDeviceSha256', 'kernelCookieSha256',
              'vfsIdentitySha256', 'nodeIdentitySha256', 'responseIdentitySha256'}
    need(type(row) is dict and set(row) == hashes | {'protocol', 'status'} and
         row['protocol'] == 'AF_NETLINK_NETLINK_SOCK_DIAG_UNIX_DIAG_VFS' and row['status'] == 'EXACT_VFS_MATCH'
         and all(type(row[k]) is str and HEX.fullmatch(row[k]) for k in hashes), 'VFS_REPORT_INVALID')
    try:
        _listener().validate_binding(value['listenerBinding'])
    except Exception:
        raise Rejected('VFS_REPORT_INVALID') from None
    return value


def assert_same_binding(before, after):
    validate_binding(before)
    validate_binding(after)
    need(before == after, 'VFS_DRIFT')
    return before
