"""Fixed public permissions only; explicit actual-diagnostic transport authorization.

No environment, generated receipt, unknown path, chown or release qualification.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import time
import types

BASE = Path('/opt/id-business-v2')
BASELINE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
PARENTS = (('DEPLOY', 'deploy'), ('CADDY_PARENT', 'deploy/caddy'),
           ('APPS', 'apps'), ('API_PARENT', 'apps/api'), ('PRISMA_PARENT', 'apps/api/prisma-mysql'))
LEAVES = (('CADDY_CONFIG', 'deploy/caddy/Caddyfile.aws', 1299,
           'f3d253904be6acbe24184b6a317eb3c9ded71636d9622dc9636c196dd7a56674'),
          ('MYSQL_SCHEMA', 'apps/api/prisma-mysql/schema.prisma', 172914,
           '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197'))
COMPOSE = ('COMPOSE_GUARD', 'docker-compose.aws-mysql.yml', 8374,
           '953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c')
ROLES = tuple(r for r, _ in PARENTS) + tuple(r for r, *_ in LEAVES)
FIELDS = frozenset(('kind', 'version', 'status', 'code', 'mutationAttempted',
    'changedCount', 'currentUnchanged', 'servicesUnchanged', 'sourceVerified', 'repairVerified',
    'servicesBeforeSha256', 'servicesAfterSha256', 'targets', 'rawOutputSuppressed',
    'authority', 'productionEligible'))
CODES = frozenset(('OK', 'INPUT_INVALID', 'ROOT_REQUIRED', 'DIAGNOSTIC_INVALID',
    'UNAUTHORIZED_WRITABLE', 'TYPE', 'OWNER', 'LINKS', 'SIZE', 'WRITABLE', 'SOURCE_HASH_CHANGED',
    'IDENTITY_CHANGED', 'CURRENT_CHANGED', 'SOURCE_CHANGED', 'SERVICES_CHANGED',
    'SNAPSHOT_INVALID', 'DEADLINE_EXCEEDED', 'IO_FAILURE'))
STATES = frozenset(('NOT_SELECTED', 'NOT_MEASURED', 'PLANNED', 'ATTEMPTED_UNVERIFIED',
                    'VERIFIED_CHANGED', 'VERIFIED_NO_CHANGE'))
HEX = re.compile(r'[a-f0-9]{64}\Z')


class Rejected(RuntimeError):
    pass


def need(ok, code):
    if not ok: raise Rejected(code)


def _uid(): return 0


def _root_identity(): return os.getuid() == 0 and os.geteuid() == 0


def _open_root(): return os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def identity(row):
    return (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid, row.st_nlink,
            row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def targets_validate(targets, facts):
    need(type(targets) is tuple and bool(targets) and all(type(r) is str and r in ROLES for r in targets)
         and targets == tuple(r for r in ROLES if r in targets), 'INPUT_INVALID')
    # The separately byte-pinned actual consumer validates all twenty rows.
    # Here only the immutable selected subset can enter a writable branch.
    need(type(facts) is dict and facts.get('kind') == 'API_WORKSPACE_READER_FACTS_DIAGNOSTIC'
         and type(facts.get('version')) is int and facts['version'] == 1
         and facts.get('status') == 'OBSERVED' and facts.get('authority') is False
         and facts.get('productionEligible') is False and facts.get('rawOutputSuppressed') is True
         and type(facts.get('rows')) is list, 'DIAGNOSTIC_INVALID')
    rows = facts['rows']
    for role in targets:
        selected = [row for row in rows if type(row) is dict and row.get('role') == role]
        need(len(selected) == 1 and selected[0] == {'role': role, 'phase': 'ATTRIBUTES',
             'status': 'REJECTED', 'predicates': ['WRITABLE']}, 'DIAGNOSTIC_INVALID')
    return targets


def result_validate(value):
    need(type(value) is dict and set(value) == FIELDS
         and type(value['kind']) is str and value['kind'] == 'API_WORKSPACE_PUBLIC_PERMISSION_REPAIR_V1'
         and type(value['version']) is int and value['version'] == 1
         and type(value['status']) is str
         and value['status'] in ('CHANGED', 'NO_CHANGE', 'FAILED_BEFORE_MUTATION', 'FAILED_MUTATED_UNVERIFIED')
         and type(value['code']) is str and value['code'] in CODES
         and type(value['changedCount']) is int and 0 <= value['changedCount'] <= 7
         and value['authority'] is False and value['productionEligible'] is False
         and value['rawOutputSuppressed'] is True, 'INPUT_INVALID')
    need(all(type(value[k]) is bool for k in ('mutationAttempted', 'currentUnchanged',
         'servicesUnchanged', 'sourceVerified', 'repairVerified')), 'INPUT_INVALID')
    need(all(type(value[k]) is str and (value[k] == 'NOT_MEASURED' or HEX.fullmatch(value[k]))
         for k in ('servicesBeforeSha256', 'servicesAfterSha256')), 'INPUT_INVALID')
    need(type(value['targets']) is list and len(value['targets']) == 7, 'INPUT_INVALID')
    for role, row in zip(ROLES, value['targets']):
        need(type(row) is dict and set(row) == {'role', 'status'} and type(row['role']) is str
             and row['role'] == role and type(row['status']) is str and row['status'] in STATES, 'INPUT_INVALID')
    need(value['changedCount'] == sum(r['status'] == 'VERIFIED_CHANGED' for r in value['targets']), 'INPUT_INVALID')
    successful = value['status'] in ('CHANGED', 'NO_CHANGE')
    need((value['code'] == 'OK') == successful and value['repairVerified'] == successful, 'INPUT_INVALID')
    if successful:
        need(value['currentUnchanged'] and value['servicesUnchanged'] and value['sourceVerified']
             and HEX.fullmatch(value['servicesBeforeSha256'])
             and value['servicesBeforeSha256'] == value['servicesAfterSha256']
             and all(r['status'] in ('NOT_SELECTED', 'VERIFIED_CHANGED', 'VERIFIED_NO_CHANGE') for r in value['targets'])
             and value['mutationAttempted'] == (value['status'] == 'CHANGED')
             and bool(value['changedCount']) == value['mutationAttempted'], 'INPUT_INVALID')
    else:
        need(value['mutationAttempted'] == (value['status'] == 'FAILED_MUTATED_UNVERIFIED'), 'INPUT_INVALID')
    return value


class Authority:
    """Fixed current and fixed public names only; no environment/receipt read."""
    def __init__(self, targets, deadline):
        self.targets, self.deadline = targets, deadline
        self.fds, self.nodes, self.public = [], [], []
        self.link = self.current = self.base = None

    def remaining(self):
        need(time.monotonic() < self.deadline, 'DEADLINE_EXCEEDED')

    def strict(self, info, *, directory):
        need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'TYPE')
        need(info.st_uid == _uid(), 'OWNER')
        if not directory:
            need(info.st_nlink == 1, 'LINKS'); need(info.st_size <= 1024**2, 'SIZE')
        need(not stat.S_IMODE(info.st_mode) & 0o022, 'WRITABLE')

    def child(self, parent, name, role, *, directory):
        self.remaining()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
                     | (os.O_DIRECTORY if directory else os.O_NONBLOCK), dir_fd=parent)
        self.fds.append(fd)
        before = os.fstat(fd)
        need(identity(before) == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'IDENTITY_CHANGED')
        try: self.strict(before, directory=directory)
        except Rejected as error:
            args = BaseException.args.__get__(error)
            if not (type(error) is Rejected and args == ('WRITABLE',) and role in self.targets):
                if type(error) is Rejected and args == ('WRITABLE',): raise Rejected('UNAUTHORIZED_WRITABLE') from None
                raise
        row = {'role': role, 'parent': parent, 'name': name, 'fd': fd, 'identity': identity(before)}
        self.nodes.append(row)
        return row

    def current_read(self):
        before = os.stat('current', dir_fd=self.base, follow_symlinks=False)
        need(stat.S_ISLNK(before.st_mode) and before.st_uid == _uid() and before.st_nlink == 1
             and 0 < before.st_size <= 512, 'CURRENT_CHANGED')
        value = os.readlink('current', dir_fd=self.base)
        names = [value[len(p):] for p in (str(BASE) + '/releases/', 'releases/') if value.startswith(p)]
        need(len(names) == 1 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-' + BASELINE[:12], names[0])
             and identity(before) == identity(os.stat('current', dir_fd=self.base, follow_symlinks=False)), 'CURRENT_CHANGED')
        return names[0], (value, identity(before))

    def open(self):
        root = _open_root()
        self.fds.append(root); self.strict(os.fstat(root), directory=True)
        self.root_identity = identity(os.fstat(root))
        parent = root
        for part in BASE.parts[1:]: parent = self.child(parent, part, 'BASE_CHAIN', directory=True)['fd']
        self.base = parent
        name, self.link = self.current_read(); self.current = BASE / 'releases' / name
        releases = self.child(parent, 'releases', 'RELEASES', directory=True)['fd']
        source = self.child(releases, name, 'SOURCE', directory=True)['fd']
        directories = {'': source}
        for role, relative in PARENTS:
            path = Path(relative); parent_name = str(path.parent) if len(path.parts) > 1 else ''
            row = self.child(directories[parent_name], path.name, role, directory=True)
            directories[relative] = row['fd']
        for role, relative, size, hashed in (COMPOSE, *LEAVES):
            path = Path(relative); parent_name = str(path.parent) if len(path.parts) > 1 else ''
            row = self.child(directories[parent_name], path.name, role, directory=False)
            row.update(size=size, sha256=hashed); self.public.append(row)

    def verify(self):
        self.remaining()
        need(identity(os.fstat(self.fds[0])) == self.root_identity, 'IDENTITY_CHANGED')
        need(self.current_read() == (self.current.name, self.link), 'CURRENT_CHANGED')
        for row in self.nodes:
            need(identity(os.fstat(row['fd'])) == row['identity']
                 == identity(os.stat(row['name'], dir_fd=row['parent'], follow_symlinks=False)), 'IDENTITY_CHANGED')

    def bytes_verify(self):
        self.verify()
        for row in self.public:
            os.lseek(row['fd'], 0, os.SEEK_SET); size = 0; hashed = hashlib.sha256()
            while size <= 1024**2:
                self.remaining(); data = os.read(row['fd'], min(65536, 1024**2 + 1 - size))
                if not data: break
                size += len(data); hashed.update(data)
            need(size == row['size'] and hashed.hexdigest() == row['sha256'], 'SOURCE_HASH_CHANGED')
            self.verify()

    def close(self):
        failed = False
        for fd in reversed(self.fds):
            try: os.close(fd)
            except OSError: failed = True
        self.fds = []
        return not failed


def repair(snapshot_read=None, source_check=None, *, authorized_targets=None, observed_reader_facts=None, deadline=None):
    result = {'kind': 'API_WORKSPACE_PUBLIC_PERMISSION_REPAIR_V1', 'version': 1,
        'status': 'FAILED_BEFORE_MUTATION', 'code': 'IO_FAILURE',
        'mutationAttempted': False, 'changedCount': 0, 'currentUnchanged': False,
        'servicesUnchanged': False, 'sourceVerified': False, 'repairVerified': False,
        'servicesBeforeSha256': 'NOT_MEASURED', 'servicesAfterSha256': 'NOT_MEASURED',
        'targets': [{'role': r, 'status': 'NOT_SELECTED'} for r in ROLES],
        'rawOutputSuppressed': True, 'authority': False, 'productionEligible': False}
    authority = None
    try:
        targets = targets_validate(authorized_targets, observed_reader_facts)
        for row in result['targets']:
            if row['role'] in targets: row['status'] = 'NOT_MEASURED'
        need(type(snapshot_read) is types.FunctionType and type(source_check) is types.FunctionType
             and type(deadline) is float and 0 < deadline - time.monotonic() <= 240, 'INPUT_INVALID')
        need(_root_identity(), 'ROOT_REQUIRED')
        source_check(); authority = Authority(targets, deadline); authority.open(); authority.bytes_verify()
        stable = snapshot_read(authority.current)
        need(type(stable) is str and HEX.fullmatch(stable), 'SNAPSHOT_INVALID')
        result['servicesBeforeSha256'] = stable
        def guard():
            authority.bytes_verify(); source_check(); authority.remaining()
            need(snapshot_read(authority.current) == stable, 'SERVICES_CHANGED')
            authority.bytes_verify(); authority.remaining()
        guard(); result['sourceVerified'] = True
        records = {r['role']: r for r in result['targets']}
        for role in targets:
            records[role]['status'] = 'PLANNED'
        for role in targets:
            node = next(n for n in authority.nodes if n['role'] == role)
            guard(); info = os.fstat(node['fd'])
            need(identity(info) == node['identity'], 'IDENTITY_CHANGED')
            mode = stat.S_IMODE(info.st_mode)
            if not mode & 0o022:
                records[role]['status'] = 'VERIFIED_NO_CHANGE'; continue
            # The strict refusal is rechecked immediately before the sole write.
            try: authority.strict(info, directory=role in {r for r, _ in PARENTS})
            except Rejected as error:
                need(type(error) is Rejected and BaseException.args.__get__(error) == ('WRITABLE',), 'IDENTITY_CHANGED')
            else: raise Rejected('IDENTITY_CHANGED')
            authority.verify(); authority.remaining()
            before = node['identity']; result['mutationAttempted'] = True
            records[role]['status'] = 'ATTEMPTED_UNVERIFIED'
            os.fchmod(node['fd'], mode & ~0o022)
            after = identity(os.fstat(node['fd']))
            need(after[2] == (stat.S_IFMT(info.st_mode) | (mode & ~0o022))
                 and all(after[i] == before[i] for i in (0, 1, 3, 4, 5, 6, 7)), 'IDENTITY_CHANGED')
            node['identity'] = after
            authority.strict(os.fstat(node['fd']), directory=role in {r for r, _ in PARENTS})
            guard()
            records[role]['status'] = 'VERIFIED_CHANGED'; result['changedCount'] += 1
        guard(); result['servicesAfterSha256'] = stable
        result.update(status='CHANGED' if result['mutationAttempted'] else 'NO_CHANGE', code='OK',
                      currentUnchanged=True, servicesUnchanged=True, sourceVerified=True, repairVerified=True)
    except Exception as error:
        args = BaseException.args.__get__(error)
        result['code'] = args[0] if type(error) is Rejected and len(args) == 1 and type(args[0]) is str and args[0] in CODES - {'OK'} else 'IO_FAILURE'
        result['status'] = 'FAILED_MUTATED_UNVERIFIED' if result['mutationAttempted'] else 'FAILED_BEFORE_MUTATION'
        result['repairVerified'] = False; result['sourceVerified'] = False
    finally:
        if authority is not None and not authority.close():
            result.update(status='FAILED_MUTATED_UNVERIFIED' if result['mutationAttempted'] else 'FAILED_BEFORE_MUTATION',
                          code='IO_FAILURE', repairVerified=False)
    return result_validate(result)
