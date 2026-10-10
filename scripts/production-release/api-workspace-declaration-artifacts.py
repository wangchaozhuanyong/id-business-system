"""Private, bounded F/Q byte transport; this module grants no receipt authority.

Before calling, the consumer MUST verify the complete receipt, its independent
SSM invocation and archived producer with the trusted full validators. Only
already verified public hash/boolean/identifier artifacts are permitted. Never
pass failure output, credentials, environment values or secret stdout/stderr.
Q retains the original wire stdout and the original invocation JSON bytes.
The fixed staging root must already be root-owned 0700; it is never chmodded.
No AWS calls, printing entry point or production action occurs on import.
"""
import base64
import gzip
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import stat
import zlib

ERROR = 'API_WORKSPACE_DECLARATION_ARTIFACT_INVALID'
STATUS = 'API_WORKSPACE_DECLARATION_ARTIFACT_STORED'
ROOT = '/opt/id-business-v2/.staging'
LIMIT = 65536
ENCODED_LIMIT = 90000
PARAMETER_LIMIT = 20 * 1024
PROGRAM_LIMIT = 131072
PRODUCER_FIELDS = {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
FILENAMES = {'preflight': 'api-workspace-preflight-result.json',
             'readback-invocation': 'api-workspace-readback-invocation.json'}
WIRE_FIELDS = {'kind', 'version', 'encoding', 'decodedLength', 'decodedSha256', 'payload'}
UUID = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'


def _need(ok):
    if not ok:
        raise RuntimeError(ERROR)


def _unique(rows):
    value = {}
    for key, item in rows:
        _need(key not in value)
        value[key] = item
    return value


def _json(raw):
    value = json.loads(raw, object_pairs_hook=_unique,
                       parse_constant=lambda unused: _need(False))
    _need(type(value) is dict)
    return value


def _producer(value):
    _need(type(value) is dict and set(value) == PRODUCER_FIELDS)
    _need(all(type(value[k]) is str and re.fullmatch('[a-f0-9]{40}', value[k])
              for k in ('commit', 'sourceTree')))
    _need(all(type(value[k]) is str and re.fullmatch('[1-9][0-9]{0,19}', value[k])
              for k in ('workflowRunId', 'workflowRunAttempt')))
    return dict(value)


def _unpack(value):
    _need(type(value) is dict and set(value) == WIRE_FIELDS
          and value['kind'] == 'API_WORKSPACE_PRIVATE_ARTIFACT'
          and type(value['version']) is int and value['version'] == 1
          and value['encoding'] == 'gzip-base64'
          and type(value['decodedLength']) is int and 0 < value['decodedLength'] < LIMIT
          and type(value['decodedSha256']) is str
          and re.fullmatch('[a-f0-9]{64}', value['decodedSha256'])
          and type(value['payload']) is str and value['payload'].isascii()
          and 0 < len(value['payload']) < ENCODED_LIMIT)
    packed = base64.b64decode(value['payload'], validate=True)
    _need(base64.b64encode(packed).decode('ascii') == value['payload'])
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(packed, LIMIT)
    _need(0 < len(raw) < LIMIT and decoder.eof and not decoder.unused_data
          and not decoder.unconsumed_tail and len(raw) == value['decodedLength']
          and hashlib.sha256(raw).hexdigest() == value['decodedSha256'])
    return raw


def _declared(receipt):
    _need(type(receipt) is dict)
    origin = receipt.get('pendingOnlineMigrationOrigin')
    _need(type(origin) is dict and type(origin.get('version')) is int
          and origin['version'] == 2 and origin.get('scope') == 'PENDING_ONLINE_MIGRATION')
    proof = origin.get('restoredConfigurationProof')
    _need(type(proof) is dict and type(proof.get('version')) is int
          and proof['version'] == 3 and proof.get('kind') == 'API_FIXED_DECLARATION_EQUIVALENCE')
    return proof


def _payload(producer, kind, raw):
    _need(type(kind) is str and kind in FILENAMES and type(raw) is bytes and 0 < len(raw) < LIMIT)
    value = _json(raw.decode('utf-8', errors='strict'))
    if kind == 'preflight':
        _need(value.get('status') == 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'
              and value.get('mode') == 'preflight' and type(value.get('commandId')) is str
              and re.fullmatch(UUID, value['commandId'])
              and type(value.get('commit')) is str and re.fullmatch('[a-f0-9]{40}', value['commit'])
              and value.get('releaseCandidateCommit') == producer['commit']
              and value.get('workflowRunId') == producer['workflowRunId']
              and value.get('workflowRunAttempt') == producer['workflowRunAttempt'])
        _declared(value)
    else:
        _need(value.get('Status') == 'Success' and type(value.get('ResponseCode')) is int
              and value['ResponseCode'] == 0 and type(value.get('CommandId')) is str
              and re.fullmatch(UUID, value['CommandId'])
              and value.get('StandardErrorContent') == ''
              and type(value.get('StandardOutputContent')) is str
              and 0 < len(value['StandardOutputContent']) < 24000)
        # Only framing/basic structure here. This cannot replace the caller's
        # trusted wire decoder, full receipt validator or actual SSM authority.
        wire = _json(value['StandardOutputContent'])
        _need(set(wire) == WIRE_FIELDS and wire['kind'] == 'WORKSPACE_PENDING_DECLARATION_RECEIPT')
        transport = {**wire, 'kind': 'API_WORKSPACE_PRIVATE_ARTIFACT'}
        receipt = _json(_unpack(transport).decode('utf-8', errors='strict'))
        _need(receipt.get('status') == 'API_ADMIN_WORKSPACE_VERIFIED'
              and receipt.get('commit') == producer['commit'])
        _declared(receipt)
    return value


def _directory(producer):
    return 'api-workspace-preflight-' + '-'.join(producer[k] for k in
                                               ('commit', 'workflowRunId', 'workflowRunAttempt'))


def _store(root, uid, producer, kind, raw):
    """Descriptor-relative writer; production always supplies fixed ROOT/uid0."""
    _need(type(root) is str and Path(root).is_absolute() and str(Path(root)) == root
          and Path(root).resolve() == Path(root))
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open('/', flags)
    directory = None
    try:
        for part in Path(root).parts[1:]:
            child = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = child
            ancestor = os.fstat(parent)
            _need(ancestor.st_uid in (0, uid) and not stat.S_IMODE(ancestor.st_mode) & 0o022)
        info = os.fstat(parent)
        _need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700)
        name = _directory(producer)
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        directory = os.open(name, flags, dir_fd=parent)
        info = os.fstat(directory)
        _need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700)
        filename = FILENAMES[kind]
        created = False
        try:
            fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            created = True
        except FileExistsError:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            _need(stat.S_ISREG(info.st_mode) and info.st_uid == uid
                  and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
            if created:
                offset = 0
                while offset < len(raw):
                    written = os.write(fd, raw[offset:])
                    _need(written > 0)
                    offset += written
                os.fsync(fd)
            else:
                _need(info.st_size == len(raw))
            os.lseek(fd, 0, os.SEEK_SET)
            with os.fdopen(os.dup(fd), 'rb') as stored:
                _need(stored.read(LIMIT) == raw)
            current = os.stat(filename, dir_fd=directory, follow_symlinks=False)
            _need(current.st_ino == info.st_ino and current.st_dev == info.st_dev
                  and current.st_uid == uid and stat.S_IMODE(current.st_mode) == 0o600
                  and current.st_nlink == 1 and current.st_size == len(raw))
        finally:
            os.close(fd)
        os.fsync(directory)
        # Ensure the acknowledged directory is still the named, private inode.
        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        held = os.fstat(directory)
        _need(stat.S_ISDIR(named.st_mode) and named.st_ino == held.st_ino
              and named.st_dev == held.st_dev and named.st_uid == uid
              and stat.S_IMODE(named.st_mode) == 0o700)
        path_info = Path(root).stat()
        root_info = os.fstat(parent)
        _need(Path(root).resolve() == Path(root)
              and path_info.st_ino == root_info.st_ino and path_info.st_dev == root_info.st_dev
              and path_info.st_uid == uid and stat.S_IMODE(path_info.st_mode) == 0o700)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(parent)
    return {'status': STATUS, 'kind': kind, 'producer': producer,
            'bytesSha256': hashlib.sha256(raw).hexdigest(), 'length': len(raw)}


def _program(producer, kind, raw, root, uid):
    producer = _producer(producer)
    _payload(producer, kind, raw)
    envelope = {'kind': 'API_WORKSPACE_PRIVATE_ARTIFACT', 'version': 1,
                'encoding': 'gzip-base64', 'decodedLength': len(raw),
                'decodedSha256': hashlib.sha256(raw).hexdigest(),
                'payload': base64.b64encode(gzip.compress(raw, compresslevel=9, mtime=0)).decode('ascii')}
    constants = {k: globals()[k] for k in ('ERROR', 'STATUS', 'LIMIT', 'ENCODED_LIMIT',
                                         'PRODUCER_FIELDS', 'FILENAMES', 'WIRE_FIELDS', 'UUID')}
    script = 'import base64,hashlib,json,os,re,stat,zlib\nfrom pathlib import Path\n'
    script += '\n'.join(k + '=' + repr(v) for k, v in constants.items()) + '\n'
    script += '\n'.join(inspect.getsource(f) for f in
                        (_need, _unique, _json, _producer, _unpack, _declared,
                         _payload, _directory, _store))
    script += '\ntry:\n p=_producer(' + repr(producer) + ')\n k=' + repr(kind) + '\n'
    script += ' raw=_unpack(' + repr(envelope) + ')\n _payload(p,k,raw)\n'
    script += ' ack=_store(' + repr(root) + ',' + str(uid) + ',p,k,raw)\n'
    script += ' print(json.dumps(ack))\nexcept Exception:\n raise SystemExit(1) from None\n'
    return script


def _program_carrier(program):
    """Compress our fixed generated program, never caller-selected source."""
    body = program.encode('utf-8')
    _need(0 < len(body) < PROGRAM_LIMIT)
    packed = base64.b64encode(gzip.compress(body, compresslevel=9, mtime=0)).decode('ascii')
    # The literals below originate only in _program. This is an integrity and
    # bounded decoding carrier, not a code/proof authority or remote interface.
    loader = 'import base64,hashlib,zlib\n'
    loader += 'payload=' + repr(packed) + '\nlength=' + str(len(body)) + '\n'
    loader += 'digest=' + repr(hashlib.sha256(body).hexdigest()) + '\n'
    loader += 'def check(ok):\n if not ok: raise RuntimeError("' + ERROR + '")\n'
    loader += ('try:\n'
        ' check(type(payload) is str and payload.isascii() and 0<len(payload)<175000)\n'
        ' check(type(length) is int and 0<length<131072)\n'
        ' compressed=base64.b64decode(payload,validate=True)\n'
        ' check(base64.b64encode(compressed).decode("ascii")==payload)\n'
        ' decoder=zlib.decompressobj(16+zlib.MAX_WBITS)\n'
        ' body=decoder.decompress(compressed,131072)\n'
        ' check(0<len(body)<131072 and len(body)==length)\n'
        ' check(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail)\n'
        ' check(hashlib.sha256(body).hexdigest()==digest)\n'
        ' program=body.decode("utf-8",errors="strict")\n'
        ' exec(compile(program,"<api-workspace-private-artifact-program>","exec"),'
        '{"__name__":"api_workspace_private_artifact_program"})\n'
        'except Exception:\n raise SystemExit(1) from None\n')
    return loader


def _parameters(producer, kind, raw, root, uid):
    script = _program_carrier(_program(producer, kind, raw, root, uid))
    result = {'commands': ['set -eu', 'umask 077', 'python3 -B -c ' + shlex.quote(script)],
              'executionTimeout': ['60']}
    _need(len(json.dumps(result).encode('utf-8')) < PARAMETER_LIMIT)
    return result


def artifact_parameters(producer, kind, raw):
    """AWS-RunShellScript parameters for verified raw F/Q, fixed root+uid0."""
    try:
        return _parameters(producer, kind, raw, ROOT, 0)
    except Exception:
        raise RuntimeError(ERROR) from None


def _test_artifact_parameters(producer, kind, raw, *, sandbox):
    """Private local-test capability, restricted to this project's runtime."""
    try:
        project = Path(__file__).resolve().parents[2]
        allowed = project / '.runtime/online-recharge-release-20261009/build/artifact-transport-tests'
        path = Path(sandbox)
        _need(path.is_absolute() and path.resolve() == path and path.parent == allowed
              and path.name.startswith('sandbox-') and path.is_dir()
              and path.stat().st_uid == os.getuid() and stat.S_IMODE(path.stat().st_mode) == 0o700)
        return _parameters(producer, kind, raw, str(path), os.getuid())
    except Exception:
        raise RuntimeError(ERROR) from None


def validate_artifact_ack(ack, producer, kind, raw):
    """Check byte-storage acknowledgement, never baseline/release authority."""
    try:
        producer = _producer(producer)
        _payload(producer, kind, raw)
        if type(ack) is str:
            _need(0 < len(ack) < 24000)
            ack = _json(ack)
        _need(type(ack) is dict and set(ack) == {'status', 'kind', 'producer', 'bytesSha256', 'length'}
              and ack['status'] == STATUS and ack['kind'] == kind
              and _producer(ack['producer']) == producer and type(ack['length']) is int
              and ack['length'] == len(raw) and type(ack['bytesSha256']) is str
              and ack['bytesSha256'] == hashlib.sha256(raw).hexdigest())
        return ack
    except Exception:
        raise RuntimeError(ERROR) from None
